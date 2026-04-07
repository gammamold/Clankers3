/**
 * Subtractive synth templates.
 * Cutoffs are deliberately low so the filter is clearly audible.
 * Filter ENV sweeps cutoff UP on attack — very obvious on first play.
 */

export const SUBTRACTIVE_TEMPLATE = {
  id: '',
  name: 'My Synth',
  type: 'subtractive',
  replaces: 'bass_fm',
  modules: {
    vco: {
      waveform: 'sawtooth',
      octave: 0,
      detune: 0,
      enabled2: false,
      waveform2: 'square',
      octave2: 0,
      detune2: 7,
      mix2: 0.3,
      unison: 1,
      unison_detune: 15,
      noise_enabled: false,
      noise_mix: 0.3,
    },
    vcf: { type: 'lowpass', cutoff: 300, resonance: 4 },
    adsr_amp:    { attack: 0.01, decay: 0.2, sustain: 0.7, release: 0.3 },
    adsr_filter: { attack: 0.05, decay: 0.4, sustain: 0.2, release: 0.4, amount: 0.8 },
    lfo: { waveform: 'sine', rate: 1, amount: 400, enabled: false },
    effects: [],
  },
  voice: { polyphony: 1, glide: 0 },
};

export const BASS_TEMPLATE = {
  id: '',
  name: 'My Bass',
  type: 'subtractive',
  replaces: 'bass_fm',
  modules: {
    vco: {
      waveform: 'sawtooth',
      octave: -1,
      detune: 0,
      enabled2: true,
      waveform2: 'square',
      octave2: -1,
      detune2: -5,
      mix2: 0.4,
      unison: 1,
      unison_detune: 15,
      noise_enabled: false,
      noise_mix: 0.3,
    },
    vcf: { type: 'lowpass', cutoff: 180, resonance: 8 },
    adsr_amp:    { attack: 0.005, decay: 0.12, sustain: 0.5, release: 0.15 },
    adsr_filter: { attack: 0.005, decay: 0.25, sustain: 0.1, release: 0.2, amount: 0.9 },
    lfo: { waveform: 'sine', rate: 0.5, amount: 400, enabled: false },
    effects: [
      { type: 'distortion', drive: 0.25, tone: 2500 },
    ],
  },
  voice: { polyphony: 1, glide: 0.02 },
};

export const LEAD_TEMPLATE = {
  id: '',
  name: 'My Lead',
  type: 'subtractive',
  replaces: 'poly_fm',
  modules: {
    vco: {
      waveform: 'sawtooth',
      octave: 0,
      detune: 0,
      enabled2: true,
      waveform2: 'sawtooth',
      octave2: 0,
      detune2: 12,
      mix2: 0.5,
      unison: 1,
      unison_detune: 15,
      noise_enabled: false,
      noise_mix: 0.3,
    },
    vcf: { type: 'lowpass', cutoff: 600, resonance: 8 },
    adsr_amp:    { attack: 0.01, decay: 0.2,  sustain: 0.5, release: 0.2 },
    adsr_filter: { attack: 0.01, decay: 0.25, sustain: 0.2, release: 0.3, amount: 0.8 },
    lfo: { waveform: 'sine', rate: 5, amount: 80, enabled: true },
    effects: [
      { type: 'delay', time: 0.25, feedback: 0.3, wet: 0.25 },
    ],
  },
  voice: { polyphony: 1, glide: 0.04 },
};

export const PAD_TEMPLATE = {
  id: '',
  name: 'My Pad',
  type: 'subtractive',
  replaces: 'pad_synth',
  modules: {
    vco: {
      waveform: 'sine',
      octave: 0,
      detune: 0,
      enabled2: true,
      waveform2: 'sine',
      octave2: 1,
      detune2: 5,
      mix2: 0.6,
      unison: 1,
      unison_detune: 15,
      noise_enabled: false,
      noise_mix: 0.3,
    },
    vcf: { type: 'lowpass', cutoff: 400, resonance: 2 },
    adsr_amp:    { attack: 0.8, decay: 0.5, sustain: 0.8, release: 1.5 },
    adsr_filter: { attack: 1.0, decay: 0.8, sustain: 0.4, release: 1.0, amount: 0.6 },
    lfo: { waveform: 'sine', rate: 0.4, amount: 200, enabled: true },
    effects: [
      { type: 'reverb', size: 0.7, wet: 0.5 },
      { type: 'delay',  time: 0.375, feedback: 0.4, wet: 0.3 },
    ],
  },
  voice: { polyphony: 8, glide: 0.05 },
};

export const FM_DRUM_TEMPLATE = {
  id: '',
  name: 'FM Drum',
  type: 'fm_drum',
  replaces: 'drums',
  modules: {
    vco: {
      waveform: 'sine',
      octave: 0,
      detune: 0,
      enabled2: false,
      waveform2: 'sine',
      octave2: 0,
      detune2: 0,
      mix2: 0,
      unison: 1,
      unison_detune: 0,
      noise_enabled: false,
      noise_mix: 0,
    },
    vco_fm: { enabled: true, ratio: 2.0, amount: 300, waveform: 'sine' },
    vcf: { type: 'highpass', cutoff: 60, resonance: 1 },
    adsr_amp:    { attack: 0.002, decay: 0.30, sustain: 0, release: 0.05 },
    adsr_filter: { attack: 0.001, decay: 0.15, sustain: 0, release: 0.05, amount: 0.3 },
    lfo: { waveform: 'sine', rate: 1, amount: 0, enabled: false },
    effects: [],
  },
  voice: { polyphony: 1, glide: 0 },
};

export const TEMPLATES = {
  subtractive: SUBTRACTIVE_TEMPLATE,
  bass: BASS_TEMPLATE,
  pad: PAD_TEMPLATE,
  lead: LEAD_TEMPLATE,
  fm_drum: FM_DRUM_TEMPLATE,
};
