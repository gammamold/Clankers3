/**
 * SynthVoice — builds a complete audio graph from state.
 * Signal chain: OSCs (unison stack + osc2 + noise) → mixBus → VCF → FX → AMP_ENV → MASTER
 * LFO → VCF.frequency (additive)
 * Filter ENV → direct AudioParam scheduling on VCF.frequency in noteOn()
 * FM modulator → osc1.frequency
 */

import { Reverb }      from '../modules/effects/Reverb.js';
import { Delay }       from '../modules/effects/Delay.js';
import { Distortion }  from '../modules/effects/Distortion.js';
import { Chorus }      from '../modules/effects/Chorus.js';
import { Phaser }      from '../modules/effects/Phaser.js';
import { WaveShaper }  from '../modules/effects/WaveShaper.js';
import { Bitcrusher }  from '../modules/effects/Bitcrusher.js';

const MAX_UNISON = 7;

export class SynthVoice {
  constructor(engine) {
    this.engine             = engine;
    this._built             = false;
    this._state             = null;
    this._effects           = [];
    this._unisonOscs        = [];   // all MAX_UNISON slots; [0] = osc1
    this._unisonGains       = [];
    this._extraUnisonOscs   = [];   // slots 1-6 (started separately)

    // Public refs for live knob updates
    this.osc1       = null;
    this.osc2       = null;
    this.osc2Mix    = null;
    this.vcf        = null;
    this.lfoOsc     = null;
    this.lfoDepth   = null;
    this.ampEnv     = null;
    this.adsrFilter = { _params: {} };
  }

  buildFromState(state) {
    const ctx = this.engine.ctx;
    const out = this.engine.destination;
    const m   = state.modules;

    // ── MIX BUS ───────────────────────────────────────────────────
    const mixBus = ctx.createGain();
    mixBus.gain.value = 1;
    this._mixBus = mixBus;

    // ── OSC 1 + UNISON STACK ──────────────────────────────────────
    // Pre-allocate MAX_UNISON voices. Inactive ones have gain=0.
    // This allows live unison count changes without a rebuild.
    this.osc1 = ctx.createOscillator();
    this.osc1.type = m.vco.waveform;

    const unisonCount  = Math.max(1, Math.min(MAX_UNISON, m.vco.unison || 1));
    const unisonDetune = m.vco.unison_detune || 15;
    const baseDetune   = m.vco.detune || 0;
    const spreads      = this._computeUnisonSpreads(unisonCount, MAX_UNISON, unisonDetune);

    this._unisonOscs      = [];
    this._unisonGains     = [];
    this._extraUnisonOscs = [];

    for (let i = 0; i < MAX_UNISON; i++) {
      const isFirst = i === 0;
      const uOsc    = isFirst ? this.osc1 : ctx.createOscillator();
      const uGain   = ctx.createGain();
      uOsc.type         = m.vco.waveform;
      uOsc.detune.value = baseDetune + spreads[i];
      uGain.gain.value  = i < unisonCount ? 1 / unisonCount : 0;
      uOsc.connect(uGain);
      uGain.connect(mixBus);
      if (!isFirst) this._extraUnisonOscs.push(uOsc);
      this._unisonOscs.push(uOsc);
      this._unisonGains.push(uGain);
    }

    // ── OSC 2 ─────────────────────────────────────────────────────
    this.osc2 = ctx.createOscillator();
    this.osc2.type         = m.vco.waveform2;
    this.osc2.detune.value = m.vco.detune2;
    this.osc2Mix = ctx.createGain();
    this.osc2Mix.gain.value = m.vco.enabled2 ? m.vco.mix2 : 0;
    this.osc2.connect(this.osc2Mix);
    this.osc2Mix.connect(mixBus);

    // ── NOISE ─────────────────────────────────────────────────────
    // Always created; gain=0 when disabled (allows live toggle without rebuild)
    {
      const bufLen   = ctx.sampleRate * 2;
      const noiseBuf = ctx.createBuffer(1, bufLen, ctx.sampleRate);
      const nd       = noiseBuf.getChannelData(0);
      for (let i = 0; i < bufLen; i++) nd[i] = Math.random() * 2 - 1;
      this._noiseSource        = ctx.createBufferSource();
      this._noiseSource.buffer = noiseBuf;
      this._noiseSource.loop   = true;
      this._noiseMix           = ctx.createGain();
      this._noiseMix.gain.value = m.vco.noise_enabled ? (m.vco.noise_mix || 0.3) : 0;
      this._noiseSource.connect(this._noiseMix);
      this._noiseMix.connect(mixBus);
    }

    // ── FM MODULATOR ──────────────────────────────────────────────
    const fm = m.vco_fm || {};
    if (fm.enabled) {
      this._fmOsc             = ctx.createOscillator();
      this._fmOsc.type        = fm.waveform || 'sine';
      this._fmOsc.frequency.value = 440 * (fm.ratio || 2);
      this._fmDepth           = ctx.createGain();
      this._fmDepth.gain.value = fm.amount || 0;
      this._fmOsc.connect(this._fmDepth);
      this._fmDepth.connect(this.osc1.frequency);
      this._fm = fm;
    }

    // ── VCF ───────────────────────────────────────────────────────
    const filterType = m.vcf.type;
    this.vcf = ctx.createBiquadFilter();
    if (filterType === 'sem_lowpass' || filterType === 'ladder') {
      this.vcf.type    = 'lowpass';
      this.vcf.Q.value = filterType === 'ladder'
        ? m.vcf.resonance
        : Math.min(m.vcf.resonance, 6);
    } else if (filterType === 'sem_bandpass') {
      this.vcf.type    = 'bandpass';
      this.vcf.Q.value = Math.min(m.vcf.resonance, 6);
    } else {
      this.vcf.type    = filterType;
      this.vcf.Q.value = m.vcf.resonance;
    }
    this.vcf.frequency.value = m.vcf.cutoff;
    mixBus.connect(this.vcf);

    // ── LFO ───────────────────────────────────────────────────────
    this.lfoOsc = ctx.createOscillator();
    this.lfoOsc.type            = m.lfo.waveform;
    this.lfoOsc.frequency.value = m.lfo.rate;
    this.lfoDepth = ctx.createGain();
    this.lfoDepth.gain.value = m.lfo.enabled ? m.lfo.amount : 0;
    this.lfoOsc.connect(this.lfoDepth);
    this.lfoDepth.connect(this.vcf.frequency);

    // ── FILTER ENV params (no audio node — applied in noteOn) ─────
    this.adsrFilter._params = { ...m.adsr_filter };

    // ── AMP ENV ───────────────────────────────────────────────────
    this.ampEnv = ctx.createGain();
    this.ampEnv.gain.value = 0;
    this._ampParams = { ...m.adsr_amp };

    // ── FX CHAIN ──────────────────────────────────────────────────
    this._effects = (m.effects || []).map(fx => this._buildEffect(fx)).filter(Boolean);

    // ── WIRE: VCF → FX → AMP → OUT ───────────────────────────────
    let node = this.vcf;
    if (this._effects.length > 0) {
      node.connect(this._effects[0].inputNode);
      for (let i = 0; i < this._effects.length - 1; i++) {
        this._effects[i].connect(this._effects[i + 1].inputNode);
      }
      this._effects[this._effects.length - 1].connect(this.ampEnv);
    } else {
      node.connect(this.ampEnv);
    }
    this.ampEnv.connect(out);

    // ── START ALL ─────────────────────────────────────────────────
    this.osc1.start();
    this._extraUnisonOscs.forEach(u => u.start());
    this.osc2.start();
    this.lfoOsc.start();
    this._noiseSource.start();
    if (this._fmOsc) this._fmOsc.start();

    this._built = true;
    this._state = state;
    this._octaveOffset1 = m.vco.octave  || 0;
    this._octaveOffset2 = m.vco.octave2 || 0;

    console.log('[SynthVoice] built. unison:', unisonCount, '| effects:', this._effects.map(e => e.constructor.name));
    return this;
  }

  // Compute per-voice detune offsets: activeCount active voices spread across totalSlots slots.
  // Inactive slots (index >= activeCount) get 0 cents so they blend in silently.
  _computeUnisonSpreads(activeCount, totalSlots, totalDetune) {
    const out = new Array(totalSlots).fill(0);
    if (activeCount <= 1) return out;
    for (let i = 0; i < activeCount; i++) {
      out[i] = ((i / (activeCount - 1)) * 2 - 1) * totalDetune / 2;
    }
    return out;
  }

  _buildEffect(fx) {
    let effect;
    if      (fx.type === 'reverb')      effect = new Reverb(this.engine);
    else if (fx.type === 'delay')       effect = new Delay(this.engine);
    else if (fx.type === 'distortion')  effect = new Distortion(this.engine);
    else if (fx.type === 'chorus')      effect = new Chorus(this.engine);
    else if (fx.type === 'phaser')      effect = new Phaser(this.engine);
    else if (fx.type === 'waveshaper')  effect = new WaveShaper(this.engine);
    else if (fx.type === 'bitcrusher')  effect = new Bitcrusher(this.engine);
    else return null;
    effect.build();
    Object.entries(fx).forEach(([k, v]) => { if (k !== 'type') effect.setParam(k, v); });
    return effect;
  }

  noteOn(midiNote, velocity = 100) {
    if (!this._built) return;
    const ctx      = this.engine.ctx;
    const t        = ctx.currentTime;
    const freq     = 440 * Math.pow(2, (midiNote - 69) / 12);
    const velScale = Math.max(0.01, Math.min(1, velocity / 127));

    // Set frequency on all unison voices (octave offset applied to osc1 stack)
    const f1 = freq * Math.pow(2, this._octaveOffset1);
    const f2 = freq * Math.pow(2, this._octaveOffset2);
    this._unisonOscs.forEach(uOsc => uOsc.frequency.setTargetAtTime(f1, t, 0.003));
    this.osc2.frequency.setTargetAtTime(f2, t, 0.003);
    if (this._fmOsc) {
      this._fmOsc.frequency.setTargetAtTime(f1 * (this._fm.ratio || 2), t, 0.003);
    }

    // Amp ADSR — peak and sustain both scaled by velocity
    const { attack, decay, sustain } = this._ampParams;
    const g = this.ampEnv.gain;
    if (g.cancelAndHoldAtTime) {
      g.cancelAndHoldAtTime(t);
    } else {
      g.cancelScheduledValues(t);
      g.setValueAtTime(g.value, t);
    }
    g.linearRampToValueAtTime(velScale,           t + Math.max(attack, 0.003));
    g.linearRampToValueAtTime(sustain * velScale,  t + attack + decay);

    // Filter ENV — sweeps cutoff from base to peak on attack
    const p    = this.adsrFilter._params;
    const base = this._state.modules.vcf.cutoff;
    const peak = Math.min(base * (1 + p.amount * 8), 18000);
    const f    = this.vcf.frequency;
    if (f.cancelAndHoldAtTime) {
      f.cancelAndHoldAtTime(t);
    } else {
      f.cancelScheduledValues(t);
      f.setValueAtTime(base, t);
    }
    f.setValueAtTime(base, t);
    f.linearRampToValueAtTime(peak,                    t + Math.max(p.attack, 0.003));
    f.exponentialRampToValueAtTime(Math.max(base, 20), t + p.attack + p.decay);
  }

  noteOff() {
    if (!this._built) return;
    const t = this.engine.currentTime;
    const g = this.ampEnv.gain;
    const r = this._ampParams.release;
    if (g.cancelAndHoldAtTime) {
      g.cancelAndHoldAtTime(t);
    } else {
      g.cancelScheduledValues(t);
      g.setValueAtTime(g.value, t);
    }
    g.linearRampToValueAtTime(0, t + Math.max(r, 0.01));
  }

  // ── Live parameter setters ─────────────────────────────────────

  setVcoParam(key, value) {
    if (!this._built) return;
    const t = this.engine.currentTime;
    switch (key) {
      case 'waveform':
        this._unisonOscs.forEach(u => { u.type = value; });
        break;
      case 'waveform2': this.osc2.type = value; break;
      case 'detune': {
        const spreads = this._computeUnisonSpreads(
          this._state.modules.vco.unison || 1, MAX_UNISON,
          this._state.modules.vco.unison_detune || 15
        );
        this._unisonOscs.forEach((u, i) => { u.detune.value = value + spreads[i]; });
        break;
      }
      case 'detune2':   this.osc2.detune.value = value; break;
      case 'mix2':      if (this._state.modules.vco.enabled2) this.osc2Mix.gain.value = value; break;
      case 'enabled2':  this.osc2Mix.gain.value = value ? this._state.modules.vco.mix2 : 0; break;
      case 'octave':    this._octaveOffset1 = value; break;
      case 'octave2':   this._octaveOffset2 = value; break;
      case 'unison': {
        const count   = Math.max(1, Math.min(MAX_UNISON, Math.round(value)));
        const spreads = this._computeUnisonSpreads(
          count, MAX_UNISON, this._state.modules.vco.unison_detune || 15
        );
        const baseDetune = this._state.modules.vco.detune || 0;
        this._unisonOscs.forEach((u, i) => {
          u.detune.value = baseDetune + spreads[i];
          this._unisonGains[i].gain.setTargetAtTime(i < count ? 1 / count : 0, t, 0.01);
        });
        break;
      }
      case 'unison_detune': {
        const count   = this._state.modules.vco.unison || 1;
        const spreads = this._computeUnisonSpreads(count, MAX_UNISON, value);
        const baseDetune = this._state.modules.vco.detune || 0;
        this._unisonOscs.forEach((u, i) => { u.detune.value = baseDetune + spreads[i]; });
        break;
      }
      case 'noise_enabled':
        this._noiseMix.gain.setTargetAtTime(
          value ? (this._state.modules.vco.noise_mix || 0.3) : 0, t, 0.02
        );
        break;
      case 'noise_mix':
        if (this._state.modules.vco.noise_enabled)
          this._noiseMix.gain.setTargetAtTime(value, t, 0.02);
        break;
    }
  }

  setVcfParam(key, value) {
    if (!this._built) return;
    switch (key) {
      case 'type':      this.vcf.type = value; break;
      case 'cutoff':    this.vcf.frequency.setTargetAtTime(value, this.engine.currentTime, 0.01); break;
      case 'resonance': this.vcf.Q.value = value; break;
    }
  }

  setAmpParam(key, value) {
    if (!this._built) return;
    this._ampParams[key] = value;
  }

  setFilterEnvParam(key, value) {
    if (!this._built) return;
    this.adsrFilter._params[key] = value;
  }

  setLfoParam(key, value) {
    if (!this._built) return;
    const t = this.engine.currentTime;
    switch (key) {
      case 'waveform': this.lfoOsc.type = value; break;
      case 'rate':     this.lfoOsc.frequency.setTargetAtTime(value, t, 0.01); break;
      case 'amount':
        if (this._state.modules.lfo.enabled)
          this.lfoDepth.gain.setTargetAtTime(value, t, 0.02);
        break;
      case 'enabled':
        this.lfoDepth.gain.setTargetAtTime(
          value ? this._state.modules.lfo.amount : 0, t, 0.02
        );
        break;
    }
  }

  updateState(state) {
    this._state             = state;
    this._ampParams         = { ...state.modules.adsr_amp };
    this.adsrFilter._params = { ...state.modules.adsr_filter };
  }

  destroy() {
    try { this.osc1.stop(); }                          catch (_) {}
    this._extraUnisonOscs?.forEach(u => { try { u.stop(); } catch (_) {} });
    try { this.osc2.stop(); }                          catch (_) {}
    try { this.lfoOsc.stop(); }                        catch (_) {}
    try { this._fmOsc?.stop(); }                       catch (_) {}
    try { this._noiseSource?.stop(); }                 catch (_) {}
  }
}
