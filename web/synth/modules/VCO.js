/**
 * VCO — Voltage Controlled Oscillator
 * Wraps two Web Audio OscillatorNodes for dual-oscillator designs.
 */
export class VCO {
  constructor(engine) {
    this.engine = engine;
    this.osc1 = null;
    this.osc2 = null;
    this.mix1 = null;
    this.mix2 = null;
    this.output = null;
    this._params = {
      waveform: 'sawtooth',
      waveform2: 'square',
      octave: 0,
      octave2: 0,
      detune: 0,
      detune2: 7,
      mix2: 0.3,
      enabled2: false,
    };
  }

  build() {
    const e = this.engine;
    this.output = e.createGain();
    this.output.gain.value = 1;

    this.mix1 = e.createGain();
    this.mix2 = e.createGain();

    this.osc1 = e.createOscillator();
    this.osc1.type = this._params.waveform;
    this.osc1.detune.value = this._params.detune;

    this.osc2 = e.createOscillator();
    this.osc2.type = this._params.waveform2;
    this.osc2.detune.value = this._params.detune2;

    this.mix1.gain.value = 1;
    this.mix2.gain.value = this._params.enabled2 ? this._params.mix2 : 0;

    this.osc1.connect(this.mix1);
    this.osc2.connect(this.mix2);
    this.mix1.connect(this.output);
    this.mix2.connect(this.output);

    this.osc1.start();
    this.osc2.start();

    return this;
  }

  noteOn(freq) {
    const e = this.engine;
    const t = e.currentTime;
    const f1 = freq * Math.pow(2, this._params.octave);
    const f2 = freq * Math.pow(2, this._params.octave2);
    this.osc1.frequency.setTargetAtTime(f1, t, 0.001);
    this.osc2.frequency.setTargetAtTime(f2, t, 0.001);
  }

  setParam(key, value) {
    this._params[key] = value;
    if (!this.osc1) return;
    switch (key) {
      case 'waveform':   this.osc1.type = value; break;
      case 'waveform2':  this.osc2.type = value; break;
      case 'octave':     break; // applied on noteOn
      case 'octave2':    break;
      case 'detune':     this.osc1.detune.value = value; break;
      case 'detune2':    this.osc2.detune.value = value; break;
      case 'mix2':
        this._params.mix2 = value;
        if (this._params.enabled2) this.mix2.gain.value = value;
        break;
      case 'enabled2':
        this.mix2.gain.value = value ? this._params.mix2 : 0;
        break;
    }
  }

  connect(node) {
    this.output.connect(node);
  }

  stop() {
    try { this.osc1.stop(); } catch (_) {}
    try { this.osc2.stop(); } catch (_) {}
  }
}
