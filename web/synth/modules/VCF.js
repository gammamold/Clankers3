/**
 * VCF — Voltage Controlled Filter
 */
export class VCF {
  constructor(engine) {
    this.engine = engine;
    this.filter = null;
    this._params = {
      type: 'lowpass',
      cutoff: 1200,
      resonance: 1,
    };
  }

  build() {
    this.filter = this.engine.createBiquadFilter();
    this.filter.type = this._params.type;
    this.filter.frequency.value = this._params.cutoff;
    this.filter.Q.value = this._params.resonance;
    return this;
  }

  setParam(key, value) {
    this._params[key] = value;
    if (!this.filter) return;
    switch (key) {
      case 'type':      this.filter.type = value; break;
      case 'cutoff':    this.filter.frequency.setTargetAtTime(value, this.engine.currentTime, 0.01); break;
      case 'resonance': this.filter.Q.value = value; break;
    }
  }

  /** Apply envelope modulation to cutoff */
  modulateCutoff(baseFreq, amount, time, duration) {
    const peak = Math.min(baseFreq + baseFreq * amount * 4, 18000);
    this.filter.frequency.cancelScheduledValues(time);
    this.filter.frequency.setValueAtTime(peak, time);
    this.filter.frequency.exponentialRampToValueAtTime(
      Math.max(baseFreq, 20), time + duration
    );
  }

  connect(node) { this.filter.connect(node); }
  get input()   { return this.filter; }
  get output()  { return this.filter; }
}
