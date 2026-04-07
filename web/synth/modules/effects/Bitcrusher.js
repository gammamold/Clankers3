/**
 * Bitcrusher — bit-depth reduction via a WaveShaperNode quantization curve.
 * Params: bits (1–16), wet (0–1)
 */
export class Bitcrusher {
  constructor(engine) {
    this.engine    = engine;
    this._bits     = 8;
    this._wet      = 0.5;
    this.inputNode = null;
  }

  build() {
    const ctx      = this.engine.ctx;
    this.inputNode = ctx.createGain();
    this._out      = ctx.createGain();
    this._dryGain  = ctx.createGain();
    this._wetGain  = ctx.createGain();
    this._shaper   = ctx.createWaveShaper();
    this._shaper.oversample = '2x';

    this._dryGain.gain.value = 1 - this._wet;
    this._wetGain.gain.value = this._wet;

    this.inputNode.connect(this._dryGain);
    this.inputNode.connect(this._shaper);
    this._shaper.connect(this._wetGain);
    this._dryGain.connect(this._out);
    this._wetGain.connect(this._out);

    this._updateCurve();
    return this;
  }

  _updateCurve() {
    const steps = Math.pow(2, this._bits) - 1;
    const n     = 8192;
    const curve = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x  = (i / (n - 1)) * 2 - 1;
      curve[i] = Math.round(x * steps) / steps;
    }
    this._shaper.curve = curve;
  }

  setParam(key, value) {
    const t = this.engine.ctx.currentTime;
    switch (key) {
      case 'bits':
        this._bits = Math.max(1, Math.min(16, Math.round(value)));
        this._updateCurve();
        break;
      case 'wet':
        this._wet = value;
        this._dryGain.gain.setTargetAtTime(1 - value, t, 0.01);
        this._wetGain.gain.setTargetAtTime(value,     t, 0.01);
        break;
    }
  }

  connect(dest) {
    this._out.connect(dest.inputNode ?? dest);
  }
}
