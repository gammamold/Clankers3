export class Distortion {
  constructor(engine) {
    this.engine = engine;
    this._params = { drive: 0.3, tone: 3000 };
    this.input = null;
    this.output = null;
  }

  build() {
    const e = this.engine;
    this.input   = e.createGain();
    this.output  = e.createGain();
    this._shaper = e.createWaveShaper();
    this._tone   = e.createBiquadFilter();

    this._shaper.curve = this._makeCurve(this._params.drive);
    this._shaper.oversample = '4x';

    this._tone.type = 'lowpass';
    this._tone.frequency.value = this._params.tone;

    this.input.connect(this._shaper);
    this._shaper.connect(this._tone);
    this._tone.connect(this.output);

    return this;
  }

  _makeCurve(drive) {
    const n = 256;
    const curve = new Float32Array(n);
    const k = drive * 200 + 1;
    for (let i = 0; i < n; i++) {
      const x = (i * 2) / n - 1;
      curve[i] = ((Math.PI + k) * x) / (Math.PI + k * Math.abs(x));
    }
    return curve;
  }

  setParam(key, value) {
    this._params[key] = value;
    if (!this._shaper) return;
    if (key === 'drive') this._shaper.curve = this._makeCurve(value);
    if (key === 'tone')  this._tone.frequency.value = value;
  }

  connect(node) { this.output.connect(node); }
  get inputNode() { return this.input; }
}
