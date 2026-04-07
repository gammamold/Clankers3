/**
 * WaveShaper — soft clip, hard clip, or foldback distortion.
 */
export class WaveShaper {
  constructor(engine) {
    this.engine = engine;
    this._params = { curve: 'soft', drive: 0.5 };
    this.input = null;
    this.output = null;
  }

  build() {
    const e = this.engine;
    this.input   = e.createGain();
    this.output  = e.createGain();
    this._drive  = e.createGain();
    this._shaper = e.createWaveShaper();
    this._shaper.oversample = '4x';
    this._shaper.curve = this._makeCurve();

    this.input.connect(this._drive);
    this._drive.connect(this._shaper);
    this._shaper.connect(this.output);

    this._drive.gain.value = 1 + this._params.drive * 10;
    return this;
  }

  _makeCurve() {
    const n = 512;
    const curve = new Float32Array(n);
    const { curve: type, drive } = this._params;
    for (let i = 0; i < n; i++) {
      const x = (i * 2) / n - 1;
      if (type === 'soft') {
        curve[i] = (Math.PI + 100 * drive) * x / (Math.PI + 100 * drive * Math.abs(x));
      } else if (type === 'hard') {
        curve[i] = Math.max(-1, Math.min(1, x * (1 + drive * 5)));
      } else if (type === 'foldback') {
        let v = x * (1 + drive * 3);
        while (Math.abs(v) > 1) v = Math.abs(Math.abs(v) - 2) - 1;
        curve[i] = v;
      }
    }
    return curve;
  }

  setParam(key, value) {
    this._params[key] = value;
    if (!this._shaper) return;
    if (key === 'drive') this._drive.gain.value = 1 + value * 10;
    this._shaper.curve = this._makeCurve();
  }

  connect(node) { this.output.connect(node); }
  get inputNode() { return this.input; }
}
