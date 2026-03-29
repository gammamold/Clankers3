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

// ── DelayFx ───────────────────────────────────────────────────────────────────

export class DelayFx {
  constructor(ctx) {
    this.ctx    = ctx;
    this.input  = ctx.createGain();
    this.output = ctx.createGain();

    this._dry = ctx.createGain();
    this._dry.gain.value = 1;   // inline: pass dry through

    this._wet = ctx.createGain();
    this._wet.gain.value = 0;   // off by default

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

    // Chaos LFO state
    this._chaosMode   = false;
    this._chaosTimer  = 0;
    this._chaosPeriod = 0.2;
    this._baseDelay   = 0.375;
    this._chaosDepth  = 0.05;

    // Serialisable param cache
    this._p = { time: '1/8', feedback: 0.45, wet: 0, lfo: 'sine',
                lfo_rate: 0.3, lfo_depth: 0.002, fb_shape: 'none', hp: 80, lp: 6000 };

    // Wire
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

  tick() {
    if (!this._chaosMode) return;
    this._chaosTimer -= 1 / 60;
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

    this._p = { type: 'soft', drive: 0.3, tone: 6000, wet: 0 };

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
    this._shaper.curve = makeCurve(type, amount);
  }

  setDrive(v) {
    this._p.drive = v;
    this._baseDrive = Math.max(1, v * 16);
    this._driveGain.gain.setTargetAtTime(this._baseDrive, this.ctx.currentTime, 0.01);
  }

  setTone(hz) { this._p.tone = hz; this._tone.frequency.setTargetAtTime(hz, this.ctx.currentTime, 0.01); }
  setWet(v)   { this._p.wet  = v;  this._wet.gain.setTargetAtTime(v, this.ctx.currentTime, 0.01); }
  setDry(v)   { this._dry.gain.setTargetAtTime(v, this.ctx.currentTime, 0.01); }

  getParams() { return { ...this._p }; }

  _applyParams(p) {
    if (p.type || p.drive != null) this.setCurve(p.type ?? this._p.type, p.drive ?? this._p.drive);
    if (p.tone != null) this.setTone(p.tone);
    if (p.wet  != null) this.setWet(p.wet);
  }

  tick() {}

  disconnect() {
    this.input.disconnect();
    this.output.disconnect();
  }
}

// ── MasterFx ─────────────────────────────────────────────────────────────────

export class MasterFx {
  constructor(ctx) {
    this.ctx    = ctx;
    this._delay = new DelayFx(ctx);
    this._shape = new WaveShapeFx(ctx);

    // Chain delay → shaper in series
    this._delay.output.connect(this._shape.input);
  }

  get input()  { return this._delay.input; }
  get output() { return this._shape.output; }

  delay()  { return this._delay; }
  shaper() { return this._shape; }

  /** Splice inline between masterGain and destination (call after seq.start()) */
  attach(masterGain, destination) {
    try { masterGain.disconnect(destination); } catch (_) {}
    masterGain.connect(this._delay.input);
    try { this._shape.output.disconnect(destination); } catch (_) {}
    this._shape.output.connect(destination);
  }

  getParams() {
    return {
      delay:      this._delay.getParams(),
      waveshaper: this._shape.getParams(),
    };
  }

  setParams(json, bpm = 120) {
    if (json?.delay)      this._delay._applyParams(json.delay, bpm);
    if (json?.waveshaper) this._shape._applyParams(json.waveshaper);
  }

  tick() { this._delay.tick(); }

  destroy() {
    this._delay.disconnect();
    this._shape.disconnect();
  }
}
