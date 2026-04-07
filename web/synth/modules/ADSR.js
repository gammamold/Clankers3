/**
 * ADSR — Envelope Generator.
 * Used in two modes:
 *  1. AMP mode  — gainNode wired into the audio chain (adsrAmp)
 *  2. PARAM mode — only _params are read; modulation is applied externally
 *                  via AudioParam scheduling (adsrFilter does this in SynthVoice.noteOn)
 */
export class ADSR {
  constructor(engine) {
    this.engine = engine;
    this.gainNode = null;
    this._params = {
      attack: 0.01,
      decay: 0.15,
      sustain: 0.7,
      release: 0.3,
    };
  }

  build() {
    this.gainNode = this.engine.createGain();
    this.gainNode.gain.value = 0;
    return this;
  }

  noteOn(time) {
    const g = this.gainNode.gain;
    const { attack, decay, sustain } = this._params;
    const t = time ?? this.engine.currentTime;
    // cancelAndHoldAtTime freezes the param at its exact computed value at t
    // — no jump, no reliance on g.value which is unreliable mid-ramp.
    // Falls back gracefully if not supported (old browsers).
    if (g.cancelAndHoldAtTime) {
      g.cancelAndHoldAtTime(t);
    } else {
      g.cancelScheduledValues(t);
      g.setValueAtTime(g.value, t);
    }
    g.linearRampToValueAtTime(1,       t + Math.max(attack, 0.002));
    g.linearRampToValueAtTime(sustain, t + attack + decay);
  }

  noteOff(time) {
    const g = this.gainNode.gain;
    const { release } = this._params;
    const t = time ?? this.engine.currentTime;
    if (g.cancelAndHoldAtTime) {
      g.cancelAndHoldAtTime(t);
    } else {
      g.cancelScheduledValues(t);
      g.setValueAtTime(g.value, t);
    }
    g.linearRampToValueAtTime(0, t + Math.max(release, 0.01));
  }

  setParam(key, value) {
    this._params[key] = value;
  }

  connect(node) { this.gainNode.connect(node); }
  get input()   { return this.gainNode; }
  get output()  { return this.gainNode; }
}
