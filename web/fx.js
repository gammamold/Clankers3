/**
 * Clankers 3 — FX Rack
 *
 * Three FX units, all routable via aux send/return (parallel, not inline).
 * Each unit has a sidechain input from any instrument via EnvelopeFollower.
 *
 *   DelayFx    — modulated delay with shapeable feedback path
 *   WaveShapeFx — waveshaper / distortion with multiple curve types
 *   BeatRepeat — AudioWorklet looper with per-loop decay
 *   FxRack     — manages routing, sends, sidechains, tick loop
 *
 * Audio graph:
 *
 *   InstrGain[x] ──► MasterGain ──► destination   (dry, unchanged)
 *        │
 *        └──► SendGain[slot][x] ──► FxUnit.input ──► FxUnit.output
 *                                                          │
 *                                                    ReturnGain ──► MasterGain
 *
 *   InstrGain[sc] ──► AnalyserNode ──► EnvelopeFollower ──► unit.setSidechainLevel()
 */

// ── BPM-division to seconds helper ───────────────────────────────────────────

export function divToSec(div, bpm) {
  const beat = 60 / bpm;
  const map = { '1/32': beat/8, '1/16': beat/4, '1/8': beat/2,
                '1/8d': beat*0.75, '1/4': beat, '1/4d': beat*1.5, '1/2': beat*2 };
  return map[div] ?? beat/2;
}

// ── Waveshaper curve generator ────────────────────────────────────────────────

export function makeCurve(type, amount, n = 4096) {
  const curve = new Float32Array(n);
  const d = Math.max(0.01, amount);
  for (let i = 0; i < n; i++) {
    const x = (i * 2) / (n - 1) - 1;
    switch (type) {
      case 'soft':
        curve[i] = Math.tanh(x * d * 10) / Math.tanh(d * 10);
        break;
      case 'hard':
        curve[i] = Math.max(-1, Math.min(1, x * d * 8));
        break;
      case 'fold': {
        let y = x * d * 4;
        while (Math.abs(y) > 1) y = 2 * Math.sign(y) - y;
        curve[i] = y;
        break;
      }
      case 'bit': {
        const bits = Math.max(2, Math.round(16 - d * 14));
        const step = 2 / Math.pow(2, bits);
        curve[i] = Math.round(x / step) * step;
        break;
      }
      default:
        curve[i] = x;
    }
  }
  return curve;
}

// ── EnvelopeFollower ──────────────────────────────────────────────────────────

export class EnvelopeFollower {
  constructor(ctx, instrGain, { attackMs = 5, releaseMs = 120 } = {}) {
    this.level = 0;
    this._atk = attackMs / 1000;
    this._rel = releaseMs / 1000;
    this._bufSize = 256;
    this._buf = new Float32Array(this._bufSize);
    this._sr = ctx.sampleRate;

    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = this._bufSize;
    this.analyser.smoothingTimeConstant = 0;
    instrGain.connect(this.analyser);
    this._source = instrGain;
  }

  tick() {
    this.analyser.getFloatTimeDomainData(this._buf);
    let sum = 0;
    for (let i = 0; i < this._bufSize; i++) sum += this._buf[i] ** 2;
    const rms = Math.sqrt(sum / this._bufSize);
    const blocksPerSec = this._sr / this._bufSize;
    const coef = rms > this.level
      ? 1 - Math.exp(-1 / (this._atk * blocksPerSec))
      : 1 - Math.exp(-1 / (this._rel * blocksPerSec));
    this.level += (rms - this.level) * coef;
  }

  disconnect() {
    try { this._source.disconnect(this.analyser); } catch (_) {}
  }
}

// ── DelayFx ───────────────────────────────────────────────────────────────────

export class DelayFx {
  constructor(ctx) {
    this.ctx    = ctx;
    this.input  = ctx.createGain();
    this.output = ctx.createGain();

    // Dry path
    this._dry = ctx.createGain();
    this._dry.gain.value = 1.0;

    // Wet path
    this._wet = ctx.createGain();
    this._wet.gain.value = 0.5;

    // Delay
    this._delay = ctx.createDelay(4.0);
    this._delay.delayTime.value = 0.375;

    // Feedback chain: dc → hp → lp → shape → fbGain → back to delay
    this._dcBlock = ctx.createBiquadFilter();
    this._dcBlock.type = 'highpass';
    this._dcBlock.frequency.value = 20;

    this._fbHp = ctx.createBiquadFilter();
    this._fbHp.type = 'highpass';
    this._fbHp.frequency.value = 80;

    this._fbLp = ctx.createBiquadFilter();
    this._fbLp.type = 'lowpass';
    this._fbLp.frequency.value = 6000;

    this._fbShape = ctx.createWaveShaper();
    this._fbShape.curve = makeCurve('none', 0);
    this._fbShape.oversample = '2x';

    this._fbGain = ctx.createGain();
    this._fbGain.gain.value = 0.45;

    // LFO
    this._lfo      = ctx.createOscillator();
    this._lfoDepth = ctx.createGain();
    this._lfo.type = 'sine';
    this._lfo.frequency.value = 0.3;
    this._lfoDepth.gain.value = 0.002;
    this._lfo.connect(this._lfoDepth);
    this._lfoDepth.connect(this._delay.delayTime);
    this._lfo.start();

    // Chaos LFO state (when type = 'chaos')
    this._chaosMode   = false;
    this._chaosTimer  = 0;
    this._chaosPeriod = 0.2;
    this._baseDelay   = 0.375;
    this._chaosDepth  = 0.05;

    // Sidechain ducks wet
    this._scDepth = 0.8;
    this._wetBase = 0.5;

    // Serialisable param cache
    this._p = { time: '1/8', feedback: 0.45, wet: 0.5, lfo: 'sine',
                lfo_rate: 0.3, lfo_depth: 0.002, fb_shape: 'none', hp: 80, lp: 6000 };

    // Wire up
    this.input.connect(this._dry);
    this.input.connect(this._delay);

    this._delay.connect(this._dcBlock);
    this._dcBlock.connect(this._fbHp);
    this._fbHp.connect(this._fbLp);
    this._fbLp.connect(this._fbShape);
    this._fbShape.connect(this._fbGain);
    this._fbGain.connect(this._delay);   // ← feedback loop

    this._delay.connect(this._wet);
    this._dry.connect(this.output);
    this._wet.connect(this.output);
  }

  // ── Params ────────────────────────────────────────────────────────────────

  setDelayTime(s, div) {
    const safe = Math.max(0.005, s);
    this._baseDelay = safe;
    if (div) this._p.time = div;
    if (!this._chaosMode)
      this._delay.delayTime.setTargetAtTime(safe, this.ctx.currentTime, 0.02);
  }

  setFeedback(v) {
    this._p.feedback = v;
    this._fbGain.gain.setTargetAtTime(Math.min(0.97, v), this.ctx.currentTime, 0.01);
  }

  setWet(v) {
    this._p.wet = v;
    this._wetBase = v;
    this._wet.gain.setTargetAtTime(v, this.ctx.currentTime, 0.01);
  }

  setDry(v) {
    this._dry.gain.setTargetAtTime(v, this.ctx.currentTime, 0.01);
  }

  setLfoRate(hz) {
    this._p.lfo_rate = hz;
    if (!this._chaosMode)
      this._lfo.frequency.setTargetAtTime(hz, this.ctx.currentTime, 0.01);
    this._chaosRate = hz;
  }

  setLfoDepth(s) {
    this._p.lfo_depth = s;
    this._chaosDepth = s;
    if (!this._chaosMode)
      this._lfoDepth.gain.setTargetAtTime(s, this.ctx.currentTime, 0.01);
  }

  setLfoType(type) {
    this._p.lfo = type;
    if (type === 'chaos') {
      this._chaosMode = true;
      this._lfoDepth.gain.value = 0;
    } else {
      this._chaosMode = false;
      this._lfo.type  = type;
      this._lfoDepth.gain.setTargetAtTime(this._chaosDepth, this.ctx.currentTime, 0.01);
    }
  }

  setFbShape(type, amount) {
    this._p.fb_shape = type;
    this._fbShape.curve = type === 'none' ? null : makeCurve(type, amount);
  }

  setFbHp(hz) { this._p.hp = hz; this._fbHp.frequency.setTargetAtTime(hz, this.ctx.currentTime, 0.01); }
  setFbLp(hz) { this._p.lp = hz; this._fbLp.frequency.setTargetAtTime(hz, this.ctx.currentTime, 0.01); }

  getParams() { return { ...this._p }; }

  _applyParams(p, bpm) {
    if (p.time)              this.setDelayTime(divToSec(p.time, bpm ?? 120), p.time);
    if (p.feedback != null)  this.setFeedback(p.feedback);
    if (p.wet != null)       this.setWet(p.wet);
    if (p.lfo)               this.setLfoType(p.lfo);
    if (p.lfo_rate != null)  this.setLfoRate(p.lfo_rate);
    if (p.lfo_depth != null) this.setLfoDepth(p.lfo_depth);
    if (p.fb_shape)          this.setFbShape(p.fb_shape, 0.5);
    if (p.hp != null)        this.setFbHp(p.hp);
    if (p.lp != null)        this.setFbLp(p.lp);
  }

  setSidechainDepth(d) { this._scDepth = d; }

  setSidechainLevel(env) {
    const gain = Math.max(0, this._wetBase * (1 - env * this._scDepth));
    this._wet.gain.setTargetAtTime(gain, this.ctx.currentTime, 0.005);
  }

  // ── Tick (chaos LFO) ─────────────────────────────────────────────────────

  tick() {
    if (!this._chaosMode) return;
    this._chaosTimer -= 1 / 60;  // approx per-frame
    if (this._chaosTimer <= 0) {
      const t = this._baseDelay + (Math.random() * 2 - 1) * this._chaosDepth;
      this._delay.delayTime.setTargetAtTime(Math.max(0.005, t), this.ctx.currentTime, 0.04);
      this._chaosTimer = 0.05 + Math.random() * 0.3;
    }
  }

  disconnect() {
    this._lfo.stop();
    this.input.disconnect();
    this.output.disconnect();
  }
}

// ── WaveShapeFx ──────────────────────────────────────────────────────────────

export class WaveShapeFx {
  constructor(ctx) {
    this.ctx    = ctx;
    this.input  = ctx.createGain();
    this.output = ctx.createGain();

    this._dry = ctx.createGain();
    this._dry.gain.value = 1.0;

    this._wet = ctx.createGain();
    this._wet.gain.value = 0.5;

    this._driveGain = ctx.createGain();
    this._driveGain.gain.value = 3.0;
    this._baseDrive = 3.0;

    this._shaper = ctx.createWaveShaper();
    this._shaper.oversample = '4x';
    this._shaper.curve = makeCurve('soft', 0.5);

    this._tone = ctx.createBiquadFilter();
    this._tone.type = 'lowpass';
    this._tone.frequency.value = 6000;

    // Sidechain modulates drive
    this._scDepth = 0.7;

    // Serialisable param cache
    this._p = { type: 'soft', drive: 0.3, tone: 6000, wet: 0.5 };

    // Wire
    this.input.connect(this._dry);
    this.input.connect(this._driveGain);
    this._driveGain.connect(this._shaper);
    this._shaper.connect(this._tone);
    this._tone.connect(this._wet);
    this._dry.connect(this.output);
    this._wet.connect(this.output);
  }

  setCurve(type, amount) {
    this._p.type      = type;
    this._p.drive     = amount;
    this._curveType   = type;
    this._curveAmount = amount;
    this._shaper.curve = makeCurve(type, amount);
  }

  setDrive(v) {
    this._p.drive = v;
    this._baseDrive = Math.max(1, v * 16);
    this._driveGain.gain.setTargetAtTime(this._baseDrive, this.ctx.currentTime, 0.01);
  }

  setTone(hz)  { this._p.tone = hz; this._tone.frequency.setTargetAtTime(hz, this.ctx.currentTime, 0.01); }
  setWet(v)    { this._p.wet  = v;  this._wet.gain.setTargetAtTime(v, this.ctx.currentTime, 0.01); }
  setDry(v)    { this._dry.gain.setTargetAtTime(v, this.ctx.currentTime, 0.01); }

  getParams() { return { ...this._p }; }

  _applyParams(p) {
    if (p.type || p.drive != null) this.setCurve(p.type ?? this._p.type, p.drive ?? this._p.drive);
    if (p.tone != null) this.setTone(p.tone);
    if (p.wet  != null) this.setWet(p.wet);
  }

  setSidechainDepth(d) { this._scDepth = d; }

  setSidechainLevel(env) {
    const drive = this._baseDrive * (1 + env * this._scDepth * 8);
    this._driveGain.gain.setTargetAtTime(drive, this.ctx.currentTime, 0.005);
  }

  tick() {}

  disconnect() {
    this.input.disconnect();
    this.output.disconnect();
  }
}

// ── BeatRepeat ────────────────────────────────────────────────────────────────

export class BeatRepeat {
  constructor(ctx) {
    this.ctx    = ctx;
    this.input  = ctx.createGain();
    this.output = ctx.createGain();

    // State
    this._ready    = false;  // worklet loaded
    this._armed    = false;
    this._active   = false;
    this._bpm      = 120;
    this._sliceBts = 0.25;   // beats
    this._rate     = 1.0;
    this._decay    = 0.75;
    this._wet      = 0.85;

    // Sidechain threshold for auto-trigger
    this._scDepth    = 0.7;
    this._scThresh   = 0.4;
    this._scArmed    = false;
    this._scCooldown = 0;

    // onStatusChange(state) callback — set from outside
    this.onStatusChange = null;

    this._init();
  }

  async _init() {
    try {
      await this.ctx.audioWorklet.addModule('./worklets/beat-repeat-worklet.js');
      this._node = new AudioWorkletNode(this.ctx, 'beat-repeat', {
        numberOfInputs:  1,
        numberOfOutputs: 1,
        channelCount: 1,
      });
      this._node.port.onmessage = ({ data }) => {
        if (data.event === 'recordDone') {
          this._armed  = false;
          this._active = true;
          this.onStatusChange?.('repeat');
        } else if (data.event === 'loopDone') {
          this._active = false;
          this.onStatusChange?.('idle');
        }
      };
      this.input.connect(this._node);
      this._node.connect(this.output);
      this._ready = true;
    } catch (e) {
      console.warn('[BeatRepeat] worklet load failed:', e);
    }
  }

  // Arm: start recording a slice of N beats
  arm(bpm, sliceBeats) {
    if (!this._ready) return;
    this._bpm      = bpm;
    this._sliceBts = sliceBeats;
    const samples  = Math.round(sliceBeats * (60 / bpm) * this.ctx.sampleRate);
    this._node.port.postMessage({ cmd: 'record', samples });
    this._armed = true;
    this._active = false;
    this.onStatusChange?.('record');
  }

  gate() {
    if (!this._ready) return;
    this._node.port.postMessage({ cmd: 'stop' });
    this._active = false;
    this._armed  = false;
    this.onStatusChange?.('idle');
  }

  rearm() {
    if (this._ready) this.arm(this._bpm, this._sliceBts);
  }

  setRate(r)  {
    this._rate = r;
    this._node?.port.postMessage({ cmd: 'set', rate: r });
  }
  setDecay(d) {
    this._decay = d;
    this._node?.port.postMessage({ cmd: 'set', decay: d });
  }
  setWet(v)   {
    this._wet = v;
    this._node?.port.postMessage({ cmd: 'set', wet: v });
  }

  setSidechainDepth(d) { this._scDepth = d; }

  setSidechainLevel(env) {
    if (!this._scArmed || this._scCooldown > 0) { this._scCooldown = Math.max(0, this._scCooldown - 1/60); return; }
    if (env > this._scThresh && !this._armed && !this._active) {
      this.arm(this._bpm, this._sliceBts);
      this._scCooldown = 0.5;
    }
  }

  getParams() {
    const sliceMap = { 0.125: '1/32', 0.25: '1/16', 0.5: '1/8', 1: '1/4' };
    return { slice: sliceMap[this._sliceBts] ?? '1/16', rate: this._rate, decay: this._decay, wet: this._wet };
  }

  _applyParams(p) {
    const beatMap = { '1/32': 0.125, '1/16': 0.25, '1/8': 0.5, '1/4': 1 };
    if (p.slice != null)  this._sliceBts = beatMap[p.slice] ?? 0.25;
    if (p.rate  != null)  this.setRate(p.rate);
    if (p.decay != null)  this.setDecay(p.decay);
    if (p.wet   != null)  this.setWet(p.wet);
  }

  tick() {}

  disconnect() {
    try { this.input.disconnect(this._node); } catch (_) {}
    try { this._node?.disconnect(this.output); } catch (_) {}
    this.input.disconnect();
    this.output.disconnect();
  }
}

// ── FxRack ────────────────────────────────────────────────────────────────────

const INSTR_TYPES = ['drum', 'bass', 'buchla', 'pads', 'rhodes'];

export class FxRack {
  constructor(ctx) {
    this.ctx = ctx;

    // Three FX slots
    this._units = [
      new DelayFx(ctx),
      new WaveShapeFx(ctx),
      new BeatRepeat(ctx),
    ];

    // Per-slot return gain (wet return level to master)
    this._returns = this._units.map(() => {
      const g = ctx.createGain();
      g.gain.value = 0.7;
      return g;
    });

    // Per-slot, per-instrument send gains  (sendGains[slot][instrType])
    this._sends = this._units.map(() => {
      const m = {};
      for (const t of INSTR_TYPES) {
        const g = ctx.createGain();
        g.gain.value = 0;  // default: send off
        g.connect(this._units[this._units.indexOf(this._units[this._units.length - 1])].input); // temp
        m[t] = g;
      }
      return m;
    });

    // Reconnect sends to correct unit inputs
    for (let s = 0; s < this._units.length; s++) {
      for (const t of INSTR_TYPES) {
        this._sends[s][t].disconnect();
        this._sends[s][t].connect(this._units[s].input);
      }
      this._units[s].output.connect(this._returns[s]);
    }

    // Per-slot envelope followers (null = no sidechain)
    this._followers = [null, null, null];

    // Cached instrGains from sequencer (updated on each seq.start)
    this._instrGains = {};

    // Master destination (set via attachMaster)
    this._master = null;

    // Serialisation state
    this._on       = [false, false, false];
    this._retBase  = [0.7,   0.7,   0.7  ];  // last non-zero return level
    this._scSource = [null,  null,  null ];
    this._scDepths = [0.7,   0.7,   0.7  ];
  }

  // ── Routing ────────────────────────────────────────────────────────────────

  /** Call after seq.start() with seq._instrGains and seq._masterGain */
  attach(instrGains, masterGain) {
    // Re-wire sends to new instrGains
    for (const t of INSTR_TYPES) {
      const newGain = instrGains[t];
      if (!newGain) continue;
      for (let s = 0; s < this._units.length; s++) {
        try { this._instrGains[t]?.disconnect(this._sends[s][t]); } catch (_) {}
        newGain.connect(this._sends[s][t]);
      }
    }
    this._instrGains = instrGains;

    // Re-wire returns to new masterGain
    if (this._master) {
      for (const r of this._returns) {
        try { r.disconnect(this._master); } catch (_) {}
      }
    }
    for (const r of this._returns) r.connect(masterGain);
    this._master = masterGain;

    // Reattach sidechain analysers to new instrGains
    for (let s = 0; s < 3; s++) {
      const sc = this._scSource[s];
      if (sc && instrGains[sc]) {
        this._followers[s]?.disconnect();
        this._followers[s] = new EnvelopeFollower(this.ctx, instrGains[sc]);
        this._units[s].setSidechainDepth?.(this._scDepths[s]);
      }
    }
  }

  /** Toggle slot on/off (does not change stored return level) */
  setOn(slot, on) {
    this._on[slot] = !!on;
    if (this._returns[slot])
      this._returns[slot].gain.setTargetAtTime(on ? this._retBase[slot] : 0, this.ctx.currentTime, 0.02);
  }

  /** Set send level 0–1 for instrument → slot */
  setSend(slot, instrType, level) {
    if (this._sends[slot]?.[instrType])
      this._sends[slot][instrType].gain.setTargetAtTime(level, this.ctx.currentTime, 0.02);
  }

  /** Set return level 0–1 for slot → master */
  setReturn(slot, level) {
    if (this._returns[slot]) {
      if (level > 0) this._retBase[slot] = level;
      this._returns[slot].gain.setTargetAtTime(level, this.ctx.currentTime, 0.02);
    }
  }

  /** Set sidechain source for a slot ('drum'|'bass'|...|null) */
  setSidechain(slot, instrType) {
    this._scSource[slot] = instrType;

    this._followers[slot]?.disconnect();
    this._followers[slot] = null;

    if (instrType && this._instrGains[instrType]) {
      this._followers[slot] = new EnvelopeFollower(this.ctx, this._instrGains[instrType]);
    }
  }

  setSidechainDepth(slot, depth) {
    this._scDepths[slot] = depth;
    this._units[slot].setSidechainDepth?.(depth);
  }

  /** Access a unit directly for param setting */
  unit(slot) { return this._units[slot]; }

  /** Snapshot all params to a plain object (include in ClankerBoy JSON as "fx") */
  getParams() {
    const names = ['delay', 'waveshaper', 'beatrepeat'];
    const out = {};
    for (let s = 0; s < 3; s++) {
      const sends = {};
      for (const t of INSTR_TYPES) sends[t] = +(this._sends[s][t].gain.value.toFixed(3));
      out[names[s]] = {
        on:       this._on[s],
        ret:      +this._retBase[s].toFixed(3),
        sc:       this._scSource[s] ?? null,
        sc_depth: +this._scDepths[s].toFixed(3),
        sends,
        ...this._units[s].getParams(),
      };
    }
    return out;
  }

  /** Apply a params snapshot (from JSON "fx" key). bpm needed for delay time conversion. */
  setParams(json, bpm = 120) {
    const map = { delay: 0, waveshaper: 1, beatrepeat: 2 };
    for (const [name, slot] of Object.entries(map)) {
      const p = json?.[name];
      if (!p) continue;
      if (p.on       != null) this.setOn(slot, p.on);
      if (p.ret      != null) { this._retBase[slot] = p.ret; this.setReturn(slot, p.on !== false ? p.ret : 0); }
      if (p.sc       != null) this.setSidechain(slot, p.sc || null);
      if (p.sc_depth != null) this.setSidechainDepth(slot, p.sc_depth);
      if (p.sends)  for (const [instr, val] of Object.entries(p.sends)) this.setSend(slot, instr, val);
      this._units[slot]._applyParams?.(p, bpm);
    }
  }

  // ── Tick (called from rAF loop) ───────────────────────────────────────────

  tick() {
    for (let s = 0; s < 3; s++) {
      if (this._followers[s]) {
        this._followers[s].tick();
        this._units[s].setSidechainLevel?.(this._followers[s].level);
      }
      this._units[s].tick?.();
    }
  }

  destroy() {
    for (const f of this._followers) f?.disconnect();
    for (const u of this._units)    u.disconnect?.();
  }
}
