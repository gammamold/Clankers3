/**
 * Clankers 3 — Master FX
 *
 * Two FX units wired inline on the master bus (affects all instruments).
 *
 *   DelayFx      — modulated delay with shapeable feedback path
 *   WaveShapeFx  — waveshaper / distortion with multiple curve types
 *   MasterFx     — chains both units in series on the master output
 *
 * Audio graph:
 *
 *   MasterGain ──► DelayFx.input ──► DelayFx.output
 *                                         │
 *                                   WaveShapeFx.input ──► WaveShapeFx.output ──► destination
 *
 * Both units run in inline mode (dry=1, wet=adjustable).
 */

// ── BPM-division to seconds helper ───────────────────────────────────────────

export function divToSec(div, bpm) {
  const beat = 60 / bpm;
  const map = {
    '1/32': beat / 8, '1/16': beat / 4, '1/8': beat / 2,
    '1/8d': beat * 0.75, '1/4': beat, '1/4d': beat * 1.5, '1/2': beat * 2
  };
  return map[div] ?? beat / 2;
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
        curve[i] = x; // 'none' / clean passthrough
    }
  }
  return curve;
}

// ── DelayFx ───────────────────────────────────────────────────────────────────

export class DelayFx {
  constructor(ctx) {
    this.ctx = ctx;
    this.input = ctx.createGain();
    this.output = ctx.createGain();

    this._dry = ctx.createGain();
    this._dry.gain.value = 1;

    this._wet = ctx.createGain();
    this._wet.gain.value = 0;

    // Two delay lines for ping pong (L = primary, R = cross-channel)
    this._delayL = ctx.createDelay(4.0);
    this._delayL.delayTime.value = 0.375;
    this._delayR = ctx.createDelay(4.0);
    this._delayR.delayTime.value = 0.375;

    // Feedback chain: dc → hp → lp → shape → fbGain
    this._dcBlock = ctx.createBiquadFilter();
    this._dcBlock.type = 'highpass';
    this._dcBlock.frequency.value = 20;
    this._dcBlock.Q.value = 0.5;

    this._fbHp = ctx.createBiquadFilter();
    this._fbHp.type = 'highpass';
    this._fbHp.frequency.value = 80;
    this._fbHp.Q.value = 0.5;

    this._fbLp = ctx.createBiquadFilter();
    this._fbLp.type = 'lowpass';
    this._fbLp.frequency.value = 6000;
    this._fbLp.Q.value = 0.5;

    this._fbShape = ctx.createWaveShaper();
    this._fbShape.curve = makeCurve('none', 0);
    this._fbShape.oversample = '2x';

    this._fbGain = ctx.createGain();
    this._fbGain.gain.value = 0.45;

    // Ping pong routing — gain switches control normal vs cross feedback
    this._fbRouteSelf = ctx.createGain();   // normal mode: 1, ping pong: 0
    this._fbRouteSelf.gain.value = 1;
    this._fbRouteCross = ctx.createGain();  // normal mode: 0, ping pong: 1
    this._fbRouteCross.gain.value = 0;
    this._fbGainR = ctx.createGain();       // R→L return (ping pong only)
    this._fbGainR.gain.value = 0;

    // Stereo panners (center in normal mode, ±1 in ping pong)
    this._panL = ctx.createStereoPanner();
    this._panL.pan.value = 0;
    this._panR = ctx.createStereoPanner();
    this._panR.pan.value = 0;

    // Output filter — tripole LP/HP/BP on the wet signal (allpass = off)
    this._outFilter = ctx.createBiquadFilter();
    this._outFilter.type = 'allpass';
    this._outFilter.frequency.value = 2000;
    this._outFilter.Q.value = 0.7;

    // LFO
    this._lfo = ctx.createOscillator();
    this._lfoDepth = ctx.createGain();
    this._lfo.type = 'sine';
    this._lfo.frequency.value = 0.3;
    this._lfoDepth.gain.value = 0.002;
    this._lfo.connect(this._lfoDepth);
    this._lfoDepth.connect(this._delayL.delayTime);
    this._lfoDepth.connect(this._delayR.delayTime);
    this._lfo.start();

    // Chaos LFO state
    this._chaosMode = false;
    this._chaosTimer = 0;
    this._baseDelay = 0.375;
    this._chaosDepth = 0.05;

    // Serialisable param cache
    this._p = {
      on: false, time: '1/8', feedback: 0.45, wet: 0, lfo: 'sine',
      lfo_rate: 0.3, lfo_depth: 0.002, hp: 80, lp: 6000,
      ping_pong: false, filter_type: 'off', filter_freq: 2000, filter_q: 0.7
    };

    // ── Wiring ──────────────────────────────────────────────────────────────────
    this.input.connect(this._dry);
    this.input.connect(this._delayL);

    // Feedback chain from L
    this._delayL.connect(this._dcBlock);
    this._dcBlock.connect(this._fbHp);
    this._fbHp.connect(this._fbLp);
    this._fbLp.connect(this._fbShape);
    this._fbShape.connect(this._fbGain);

    // Routing: self-feedback (normal) or cross to R (ping pong)
    this._fbGain.connect(this._fbRouteSelf);
    this._fbGain.connect(this._fbRouteCross);
    this._fbRouteSelf.connect(this._delayL);
    this._fbRouteCross.connect(this._delayR);

    // R → L return feedback (ping pong)
    this._delayR.connect(this._fbGainR);
    this._fbGainR.connect(this._delayL);

    // Wet: both delays → panners → wet gain → outFilter → output
    this._delayL.connect(this._panL);
    this._delayR.connect(this._panR);
    this._panL.connect(this._wet);
    this._panR.connect(this._wet);
    this._wet.connect(this._outFilter);
    this._outFilter.connect(this.output);
    this._dry.connect(this.output);
  }

  setDelayTime(s, div) {
    const safe = Math.max(0.005, s);
    this._baseDelay = safe;
    if (div) this._p.time = div;
    if (!this._chaosMode) {
      this._delayL.delayTime.setTargetAtTime(safe, this.ctx.currentTime, 0.02);
      this._delayR.delayTime.setTargetAtTime(safe, this.ctx.currentTime, 0.02);
    }
  }

  setFeedback(v) {
    this._p.feedback = v;
    const clamped = Math.min(0.97, v);
    this._fbGain.gain.setTargetAtTime(clamped, this.ctx.currentTime, 0.01);
    if (this._p.ping_pong)
      this._fbGainR.gain.setTargetAtTime(clamped, this.ctx.currentTime, 0.01);
  }

  setWet(v) {
    this._p.wet = v;
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
      this._lfo.type = type;
      this._lfoDepth.gain.setTargetAtTime(this._chaosDepth, this.ctx.currentTime, 0.01);
    }
  }

  setFbHp(hz) { this._p.hp = hz; this._fbHp.frequency.setTargetAtTime(hz, this.ctx.currentTime, 0.01); }
  setFbLp(hz) { this._p.lp = hz; this._fbLp.frequency.setTargetAtTime(hz, this.ctx.currentTime, 0.01); }

  setPingPong(on) {
    this._p.ping_pong = on;
    const t = this.ctx.currentTime;
    this._fbRouteSelf.gain.setTargetAtTime(on ? 0 : 1, t, 0.02);
    this._fbRouteCross.gain.setTargetAtTime(on ? 1 : 0, t, 0.02);
    this._fbGainR.gain.setTargetAtTime(on ? Math.min(0.97, this._p.feedback) : 0, t, 0.02);
    this._panL.pan.setTargetAtTime(on ? -1 : 0, t, 0.05);
    this._panR.pan.setTargetAtTime(on ? 1 : 0, t, 0.05);
  }

  setFilterType(type) {
    this._p.filter_type = type;
    this._outFilter.type = (type === 'off') ? 'allpass' : type;
  }

  setFilterFreq(hz) {
    this._p.filter_freq = hz;
    this._outFilter.frequency.setTargetAtTime(hz, this.ctx.currentTime, 0.01);
  }

  setFilterQ(q) {
    this._p.filter_q = q;
    this._outFilter.Q.setTargetAtTime(q, this.ctx.currentTime, 0.01);
  }

  setOn(v) { this._p.on = !!v; }

  getParams() { return { ...this._p }; }

  _applyParams(p, bpm) {
    if (p.time) this.setDelayTime(divToSec(p.time, bpm ?? 120), p.time);
    if (p.feedback != null) this.setFeedback(p.feedback);
    if (p.wet != null) this.setWet(p.wet);
    if (p.lfo) this.setLfoType(p.lfo);
    if (p.lfo_rate != null) this.setLfoRate(p.lfo_rate);
    if (p.lfo_depth != null) this.setLfoDepth(p.lfo_depth);
    if (p.hp != null) this.setFbHp(p.hp);
    if (p.lp != null) this.setFbLp(p.lp);
    if (p.ping_pong != null) this.setPingPong(!!p.ping_pong);
    if (p.filter_type != null) this.setFilterType(p.filter_type);
    if (p.filter_freq != null) this.setFilterFreq(p.filter_freq);
    if (p.filter_q != null) this.setFilterQ(p.filter_q);
  }

  tick() {
    if (!this._chaosMode) return;
    this._chaosTimer -= 1 / 60;
    if (this._chaosTimer <= 0) {
      const t = Math.max(0.005, this._baseDelay + (Math.random() * 2 - 1) * this._chaosDepth);
      this._delayL.delayTime.setTargetAtTime(t, this.ctx.currentTime, 0.04);
      this._delayR.delayTime.setTargetAtTime(t, this.ctx.currentTime, 0.04);
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
    this.ctx = ctx;
    this.input = ctx.createGain();
    this.output = ctx.createGain();

    this._dry = ctx.createGain();
    this._dry.gain.value = 1;   // inline: pass dry through

    this._wet = ctx.createGain();
    this._wet.gain.value = 0;   // off by default

    this._driveGain = ctx.createGain();
    this._driveGain.gain.value = 3.0;
    this._baseDrive = 3.0;

    this._shaper = ctx.createWaveShaper();
    this._shaper.oversample = '4x';
    this._shaper.curve = makeCurve('soft', 0.5);

    this._tone = ctx.createBiquadFilter();
    this._tone.type = 'lowpass';
    this._tone.frequency.value = 6000;

    this._p = { on: false, type: 'soft', drive: 0.3, tone: 6000, wet: 0 };

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
    this._p.type = type;
    this._p.drive = amount;
    this._shaper.curve = makeCurve(type, amount);
  }

  setDrive(v) {
    this._p.drive = v;
    this._baseDrive = Math.max(1, v * 16);
    this._driveGain.gain.setTargetAtTime(this._baseDrive, this.ctx.currentTime, 0.01);
  }

  setTone(hz) { this._p.tone = hz; this._tone.frequency.setTargetAtTime(hz, this.ctx.currentTime, 0.01); }
  setWet(v) { this._p.wet = v; this._wet.gain.setTargetAtTime(v, this.ctx.currentTime, 0.01); }
  setDry(v) { this._dry.gain.setTargetAtTime(v, this.ctx.currentTime, 0.01); }

  setOn(v) { this._p.on = !!v; }

  getParams() { return { ...this._p }; }

  _applyParams(p) {
    if (p.type || p.drive != null) this.setCurve(p.type ?? this._p.type, p.drive ?? this._p.drive);
    if (p.tone != null) this.setTone(p.tone);
    if (p.wet != null) this.setWet(p.wet);
  }

  tick() { }

  disconnect() {
    this.input.disconnect();
    this.output.disconnect();
  }
}

// ── MasterFx ─────────────────────────────────────────────────────────────────
//
// Send architecture: Delay and WaveShaper are parallel aux sends.
// Each instrument has independent send amounts (0–1) to each FX unit.
// The dry signal passes through instrGains → masterGain → destination unchanged.
// FX units have no dry path (dry=0); their wet output returns to destination.
//
// Audio graph:
//
//   instrGain[x] ──► masterGain ──► destination
//        │
//        ├── delaySend[x] ──► DelayFx.input ──► DelayFx.output ──► destination
//        └── shaperSend[x] ─► WaveShapeFx.input ──► WaveShapeFx.output ──► destination

export class MasterFx {
  constructor(ctx) {
    this.ctx = ctx;
    this._delay = new DelayFx(ctx);
    this._shape = new WaveShapeFx(ctx);

    // Send mode: no dry pass-through inside each FX unit
    this._delay.setDry(0);
    this._shape.setDry(0);

    // Per-instrument send gain nodes (populated in attach())
    this._delaySends = {};
    this._shaperSends = {};

    // Graph FX slots (dynamic, added via Synth Lab)
    // Each entry: { adapter: GraphFxAdapter, name: string, sends: {} }
    this._graphFx = [];
    this._graphSends = []; // per-graphFx: { drum: GainNode, bass: GainNode, ... }

    // Send values persist across seq.start() reconnects
    // Slots: 0=delay, 1=shaper, 2+=graphFx[n-2]
    this._sendVals = [
      { drum: 0, bass: 0, buchla: 0, pads: 0, rhodes: 0, voder: 0 },
      { drum: 0, bass: 0, buchla: 0, pads: 0, rhodes: 0, voder: 0 },
    ];

    // Cache for re-attachment
    this._lastInstrGains = null;
    this._lastDestination = null;
  }

  delay() { return this._delay; }
  shaper() { return this._shape; }

  /** Get graph FX slots array. */
  get graphFxSlots() { return this._graphFx; }

  /**
   * Add a graph-based FX to the send bus.
   * @param {GraphFxAdapter} adapter — already init()'d
   * @param {string} name — display name
   * @returns {number} slot index (for setSend)
   */
  addGraphFx(adapter, name = 'Graph FX') {
    const slotIdx = 2 + this._graphFx.length;
    this._graphFx.push({ adapter, name });
    this._graphSends.push({});
    // Init send values for this slot
    this._sendVals[slotIdx] = { drum: 0, bass: 0, buchla: 0, pads: 0, rhodes: 0, voder: 0 };
    // If already attached, wire the new FX into the graph
    if (this._lastInstrGains && this._lastDestination) {
      this._wireGraphFx(this._graphFx.length - 1, this._lastInstrGains, this._lastDestination);
    }
    return slotIdx;
  }

  /**
   * Remove a graph FX by index (within graphFx array, not send slot).
   * @param {number} gfxIndex — index in _graphFx array
   */
  removeGraphFx(gfxIndex) {
    if (gfxIndex < 0 || gfxIndex >= this._graphFx.length) return;
    const { adapter } = this._graphFx[gfxIndex];
    // Disconnect sends
    const sends = this._graphSends[gfxIndex];
    for (const s of Object.values(sends)) {
      try { s.disconnect(); } catch (_) {}
    }
    adapter.disconnect();
    this._graphFx.splice(gfxIndex, 1);
    this._graphSends.splice(gfxIndex, 1);
    // Shift sendVals: remove slot (2 + gfxIndex), reindex the rest
    this._sendVals.splice(2 + gfxIndex, 1);
  }

  /** Get a graph FX adapter by slot index. */
  getGraphFx(gfxIndex) {
    return this._graphFx[gfxIndex]?.adapter ?? null;
  }

  /**
   * Wire per-instrument sends to FX units. Call after seq.start() each time,
   * passing the sequencer's _instrGains object and the audio destination.
   * @param {Object} instrGains — { drum: GainNode, bass: GainNode, ... }
   * @param {AudioNode} destination
   * @param {Object} [synthGains] — optional { synth0: GainNode, ... } from SynthLab
   */
  attach(instrGains, destination, synthGains) {
    const allGains = synthGains ? { ...instrGains, ...synthGains } : instrGains;
    const INSTRS = Object.keys(allGains);

    this._lastInstrGains = allGains;
    this._lastDestination = destination;

    // Tear down old send nodes
    for (const instr of Object.keys(this._delaySends)) {
      try { this._delaySends[instr].disconnect(); } catch (_) { }
    }
    for (const instr of Object.keys(this._shaperSends)) {
      try { this._shaperSends[instr].disconnect(); } catch (_) { }
    }
    this._delaySends = {};
    this._shaperSends = {};

    for (const instr of INSTRS) {
      const ds = this._delaySends[instr] = this.ctx.createGain();
      const ss = this._shaperSends[instr] = this.ctx.createGain();

      // Restore stored send amounts
      ds.gain.value = this._sendVals[0][instr] ?? 0;
      ss.gain.value = this._sendVals[1][instr] ?? 0;

      const ig = allGains[instr];
      if (ig) { ig.connect(ds); ig.connect(ss); }
      ds.connect(this._delay.input);
      ss.connect(this._shape.input);
    }

    // FX returns → destination (parallel, independent of master chain)
    try { this._delay.output.disconnect(); } catch (_) { }
    try { this._shape.output.disconnect(); } catch (_) { }
    this._delay.output.connect(destination);
    this._shape.output.connect(destination);

    // Wire graph FX sends
    for (let gi = 0; gi < this._graphFx.length; gi++) {
      this._wireGraphFx(gi, allGains, destination);
    }
  }

  /** Wire a single graph FX slot into the send bus. */
  _wireGraphFx(gfxIndex, instrGains, destination) {
    const INSTRS = Object.keys(instrGains);
    const { adapter } = this._graphFx[gfxIndex];
    const slotIdx = 2 + gfxIndex;

    // Tear down old sends for this slot
    const oldSends = this._graphSends[gfxIndex] || {};
    for (const s of Object.values(oldSends)) {
      try { s.disconnect(); } catch (_) {}
    }
    this._graphSends[gfxIndex] = {};

    // Create per-instrument send gain → adapter.input
    for (const instr of INSTRS) {
      const gs = this.ctx.createGain();
      gs.gain.value = this._sendVals[slotIdx]?.[instr] ?? 0;
      this._graphSends[gfxIndex][instr] = gs;

      const ig = instrGains[instr];
      if (ig) ig.connect(gs);
      gs.connect(adapter.input);
    }

    // FX return → destination
    try { adapter.output.disconnect(); } catch (_) {}
    adapter.output.connect(destination);
  }

  /** Set send amount for one instrument to one FX slot (0=delay, 1=shaper, 2+=graphFx). */
  setSend(slot, instr, val) {
    if (!this._sendVals[slot]) this._sendVals[slot] = {};
    this._sendVals[slot][instr] = val;

    let sendNode;
    if (slot === 0) sendNode = this._delaySends[instr];
    else if (slot === 1) sendNode = this._shaperSends[instr];
    else {
      const gi = slot - 2;
      sendNode = this._graphSends[gi]?.[instr];
    }

    if (sendNode) {
      sendNode.gain.setTargetAtTime(val, this.ctx.currentTime, 0.01);
    }
  }

  getParams() {
    const params = {
      delay: this._delay.getParams(),
      waveshaper: this._shape.getParams(),
    };
    if (this._graphFx.length > 0) {
      params.graphFx = this._graphFx.map(gf => ({
        name: gf.name,
        params: gf.adapter.getParams(),
      }));
    }
    return params;
  }

  setParams(json, bpm = 120) {
    if (json?.delay) this._delay._applyParams(json.delay, bpm);
    if (json?.waveshaper) this._shape._applyParams(json.waveshaper);
  }

  tick() { this._delay.tick(); }

  destroy() {
    this._delay.disconnect();
    this._shape.disconnect();
  }
}
