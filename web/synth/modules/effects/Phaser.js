/**
 * Phaser — 4-stage all-pass phaser.
 */
export class Phaser {
  constructor(engine) {
    this.engine = engine;
    this._params = { rate: 0.5, depth: 0.8, wet: 0.5 };
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

    // 4 all-pass filters
    this._filters = Array.from({ length: 4 }, () => {
      const f = e.createBiquadFilter();
      f.type = 'allpass';
      f.frequency.value = 1000;
      f.Q.value = 10;
      return f;
    });

    // LFO
    const lfo = e.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = this._params.rate;
    lfo.start();

    const lfoGain = e.createGain();
    lfoGain.gain.value = this._params.depth * 800;

    lfo.connect(lfoGain);
    this._filters.forEach(f => lfoGain.connect(f.frequency));

    // Chain all-pass filters
    let chain = this.input;
    this._filters.forEach(f => { chain.connect(f); chain = f; });
    chain.connect(wet);

    this.input.connect(dry);
    dry.connect(this.output);
    wet.connect(this.output);

    this._wet = wet; this._dry = dry;
    this._lfo = lfo; this._lfoGain = lfoGain;
    return this;
  }

  setParam(key, value) {
    this._params[key] = value;
    if (!this._wet) return;
    if (key === 'wet') { this._wet.gain.value = value; this._dry.gain.value = 1 - value; }
    if (key === 'rate') this._lfo.frequency.value = value;
    if (key === 'depth') this._lfoGain.gain.value = value * 800;
  }

  connect(node) { this.output.connect(node); }
  get inputNode() { return this.input; }
}
