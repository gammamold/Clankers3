export class Delay {
  constructor(engine) {
    this.engine = engine;
    this._params = { time: 0.25, feedback: 0.35, wet: 0.3 };
    this.input = null;
    this.output = null;
  }

  build() {
    const e = this.engine;
    this.input = e.createGain();
    this.output = e.createGain();

    this._delay = e.createDelay(2.0);
    this._feedback = e.createGain();
    this._wet = e.createGain();
    this._dry = e.createGain();

    this._delay.delayTime.value = this._params.time;
    this._feedback.gain.value = this._params.feedback;
    this._wet.gain.value = this._params.wet;
    this._dry.gain.value = 1 - this._params.wet;

    // Safety clipper to prevent blowouts
    this._clipper = e.createWaveShaper();
    const curve = new Float32Array(4096);
    for (let i = 0; i < 4096; i++) {
      let x = (i * 2) / (4095) - 1;
      curve[i] = Math.tanh(x * 1.2) / Math.tanh(1.2);
    }
    this._clipper.curve = curve;

    this.input.connect(this._dry);
    this.input.connect(this._delay);
    this._delay.connect(this._feedback);
    this._feedback.connect(this._clipper);
    this._clipper.connect(this._delay);
    this._delay.connect(this._wet);
    this._dry.connect(this.output);
    this._wet.connect(this.output);

    return this;
  }

  setParam(key, value) {
    this._params[key] = value;
    if (!this._delay) return;
    if (key === 'time') this._delay.delayTime.value = value;
    if (key === 'feedback') this._feedback.gain.value = value;
    if (key === 'wet') {
      this._wet.gain.value = value;
      this._dry.gain.value = 1 - value;
    }
  }

  connect(node) { this.output.connect(node); }
  get inputNode() { return this.input; }
}
