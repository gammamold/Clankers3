export class Reverb {
  constructor(engine) {
    this.engine = engine;
    this.convolver = null;
    this.wet = null;
    this.dry = null;
    this.output = null;
    this._params = { size: 0.4, wet: 0.25 };
  }

  build() {
    const e = this.engine;
    this.convolver = e.createConvolver();
    this.convolver.buffer = this._makeImpulse(this._params.size);

    this.wet = e.createGain();
    this.wet.gain.value = this._params.wet;

    this.dry = e.createGain();
    this.dry.gain.value = 1 - this._params.wet;

    this.input = e.createGain();
    this.output = e.createGain();

    this.input.connect(this.dry);
    this.input.connect(this.convolver);
    this.convolver.connect(this.wet);
    this.dry.connect(this.output);
    this.wet.connect(this.output);

    return this;
  }

  _makeImpulse(size) {
    const ctx = this.engine.ctx;
    const rate = ctx.sampleRate;
    const len = Math.floor(rate * (0.5 + size * 3));
    const buf = ctx.createBuffer(2, len, rate);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < len; i++) {
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2 + size * 4);
      }
    }
    return buf;
  }

  setParam(key, value) {
    this._params[key] = value;
    if (!this.wet) return;
    if (key === 'wet') {
      this.wet.gain.value = value;
      this.dry.gain.value = 1 - value;
    }
    if (key === 'size') {
      this.convolver.buffer = this._makeImpulse(value);
    }
  }

  connect(node) { this.output.connect(node); }
  get inputNode() { return this.input; }
}
