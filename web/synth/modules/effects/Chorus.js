/**
 * Chorus — BBD-style chorus using two modulated delays.
 */
export class Chorus {
  constructor(engine) {
    this.engine = engine;
    this._params = { rate: 0.5, depth: 0.3, wet: 0.5 };
    this.input = null;
    this.output = null;
  }

  build() {
    const e = this.engine;
    this.input  = e.createGain();
    this.output = e.createGain();

    const wet = e.createGain();
    const dry = e.createGain();
    wet.gain.value = this._params.wet;
    dry.gain.value = 1 - this._params.wet;

    // Two detuned delay lines
    const delay1 = e.createDelay(0.05);
    const delay2 = e.createDelay(0.05);
    delay1.delayTime.value = 0.02;
    delay2.delayTime.value = 0.025;

    // LFOs for modulation
    const lfo1 = e.createOscillator();
    const lfo2 = e.createOscillator();
    lfo1.type = 'sine'; lfo1.frequency.value = this._params.rate;
    lfo2.type = 'sine'; lfo2.frequency.value = this._params.rate * 1.1;

    const lfoGain1 = e.createGain();
    const lfoGain2 = e.createGain();
    lfoGain1.gain.value = this._params.depth * 0.01;
    lfoGain2.gain.value = this._params.depth * 0.01;

    lfo1.connect(lfoGain1); lfoGain1.connect(delay1.delayTime);
    lfo2.connect(lfoGain2); lfoGain2.connect(delay2.delayTime);
    lfo1.start(); lfo2.start();

    // Mix
    const chorusMix = e.createGain();
    chorusMix.gain.value = 0.5;

    this.input.connect(dry);
    this.input.connect(delay1);
    this.input.connect(delay2);
    delay1.connect(chorusMix);
    delay2.connect(chorusMix);
    chorusMix.connect(wet);
    dry.connect(this.output);
    wet.connect(this.output);

    this._wet = wet; this._dry = dry;
    this._lfoGain1 = lfoGain1; this._lfoGain2 = lfoGain2;
    this._lfo1 = lfo1; this._lfo2 = lfo2;
    return this;
  }

  setParam(key, value) {
    this._params[key] = value;
    if (!this._wet) return;
    if (key === 'wet') {
      this._wet.gain.value = value;
      this._dry.gain.value = 1 - value;
    }
    if (key === 'rate') {
      this._lfo1.frequency.value = value;
      this._lfo2.frequency.value = value * 1.1;
    }
    if (key === 'depth') {
      this._lfoGain1.gain.value = value * 0.01;
      this._lfoGain2.gain.value = value * 0.01;
    }
  }

  connect(node) { this.output.connect(node); }
  get inputNode() { return this.input; }
}
