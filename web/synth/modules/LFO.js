/**
 * LFO — Low Frequency Oscillator
 * Connects to a target AudioParam (additive modulation).
 * Amount is in Hz — the oscillator output (±1) is multiplied by depth gain.
 * For filter cutoff: amount=400 means ±400Hz wobble around the set cutoff.
 */
export class LFO {
  constructor(engine) {
    this.engine = engine;
    this.osc = null;
    this.depth = null;
    this._target = null;
    this._params = {
      waveform: 'sine',
      rate: 1,
      amount: 400,
      enabled: false,
    };
  }

  build() {
    this.osc = this.engine.createOscillator();
    this.osc.type = this._params.waveform;
    this.osc.frequency.value = this._params.rate;

    this.depth = this.engine.createGain();
    this.depth.gain.value = this._params.enabled ? this._params.amount : 0;

    this.osc.connect(this.depth);
    this.osc.start();
    return this;
  }

  target(audioParam) {
    this._target = audioParam;
    this.depth.connect(audioParam);
  }

  setParam(key, value) {
    this._params[key] = value;
    if (!this.osc) return;
    const t = this.engine.currentTime;
    switch (key) {
      case 'waveform': this.osc.type = value; break;
      case 'rate':
        this.osc.frequency.setTargetAtTime(value, t, 0.01);
        break;
      case 'amount':
        if (this._params.enabled)
          this.depth.gain.setTargetAtTime(value, t, 0.01);
        break;
      case 'enabled':
        // Smooth on/off — ramp over 20ms to avoid click
        this.depth.gain.setTargetAtTime(
          value ? this._params.amount : 0,
          t, 0.02
        );
        break;
    }
  }

  stop() {
    try { this.osc.stop(); } catch (_) {}
  }
}
