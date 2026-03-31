/// Simple FM bass voice — sine carrier + sine modulator + LPF + pluck envelopes
///
/// YZ pad CC map (t:2):
///   CC71  FM index     (0-127 → 0..8)          — Y axis (growl/timbre)
///   CC74  LPF cutoff   (0-127 → 0-1)            — Y axis (linked, brighter with FM)
///   CC23  Filter decay (0-127 → 0.01-1.0 s)     — Z axis (envelope speed)
///   CC75  Amp decay    (0-127 → 0.01-2.0 s)     — Z axis (linked, note length)

use crate::envelope::Envelope;
use crate::tpt_ladder::TptLadder;

const SR: f32 = 44100.0;

#[derive(Clone, Copy)]
pub struct BassParams {
    pub fm_index:    f32,  // 0..8    (CC71/127 * 8)
    pub cutoff_norm: f32,  // 0-1     (CC74/127)
    pub flt_decay:   f32,  // secs    (CC23)
    pub amp_decay:   f32,  // secs    (CC75)
}

impl Default for BassParams {
    fn default() -> Self {
        BassParams {
            fm_index:    2.0,
            cutoff_norm: 0.45,
            flt_decay:   0.18,
            amp_decay:   0.35,
        }
    }
}

pub struct BassVoice {
    carrier_phase:  f32,
    mod_phase:      f32,
    filter:         TptLadder,
    amp_env:        Envelope,
    flt_env:        Envelope,
    freq:           f32,
    hold_remaining: usize,
    active:         bool,
}

impl BassVoice {
    pub fn new(_seed: u32) -> Self {
        BassVoice {
            carrier_phase:  0.0,
            mod_phase:      0.0,
            filter:         TptLadder::new(SR),
            amp_env:        Envelope::new(SR),
            flt_env:        Envelope::new(SR),
            freq:           110.0,
            hold_remaining: 0,
            active:         false,
        }
    }

    pub fn trigger(&mut self, midi_note: u8, _velocity: f32, hold_samples: usize, p: &BassParams) {
        self.freq          = midi_to_hz(midi_note);
        self.carrier_phase = 0.0;
        self.mod_phase     = 0.0;
        self.filter.reset();

        // Amp: fast attack, controllable decay, 0 sustain, quick release tail
        self.amp_env.set_adsr(0.002, p.amp_decay, 0.0, p.amp_decay * 0.3);
        self.amp_env.note_on();

        // Filter: very fast attack, controllable decay, 0 sustain
        self.flt_env.set_adsr(0.001, p.flt_decay, 0.0, p.flt_decay * 0.5);
        self.flt_env.note_on();

        self.hold_remaining = hold_samples;
        self.active         = true;
    }

    pub fn release(&mut self) {
        self.amp_env.note_off();
        self.flt_env.note_off();
    }

    pub fn process(&mut self, out: &mut [f32], p: &BassParams) {
        const FM_RATIO: f32 = 2.0;  // modulator one octave above carrier
        const TAU:      f32 = core::f32::consts::TAU;

        let dt_carrier = self.freq / SR;
        let dt_mod     = self.freq * FM_RATIO / SR;

        for s in out.iter_mut() {
            if !self.active { break; }

            // Auto-release after hold duration
            if self.hold_remaining > 0 {
                self.hold_remaining -= 1;
                if self.hold_remaining == 0 {
                    self.amp_env.note_off();
                    self.flt_env.note_off();
                }
            }

            // FM synthesis: modulator phase-modulates carrier
            let mod_out     = (self.mod_phase * TAU).sin();
            let carrier_out = (self.carrier_phase * TAU + mod_out * p.fm_index).sin();

            self.carrier_phase = (self.carrier_phase + dt_carrier).fract();
            self.mod_phase     = (self.mod_phase     + dt_mod    ).fract();

            // Envelopes
            let flt_val = self.flt_env.process();
            let amp_val = self.amp_env.process();

            // LPF: filter env sweeps cutoff upward from base on attack (pluck brightness)
            let headroom  = 1.0 - p.cutoff_norm;
            let cutoff_n  = (p.cutoff_norm + flt_val * headroom * 0.8).clamp(0.0, 1.0);
            let cutoff_hz = norm_to_cutoff_hz(cutoff_n);

            let filtered = self.filter.process(carrier_out, cutoff_hz, 0.25, 1.0);

            if amp_val < 1e-6 && !self.amp_env.is_active() {
                self.filter.reset();
                self.active = false;
            }

            *s += filtered * amp_val * 0.7;
        }
    }

    pub fn is_active(&self) -> bool { self.active }
}

pub struct BassEngine {
    voices:     Vec<BassVoice>,
    next_voice: usize,
}

impl BassEngine {
    pub fn new(seed: u32) -> Self {
        let voices = (0..8).map(|i| BassVoice::new(seed.wrapping_add(i * 1234))).collect();
        BassEngine { voices, next_voice: 0 }
    }

    pub fn trigger(&mut self, midi_note: u8, velocity: f32, hold_samples: usize, p: &BassParams) {
        let idx = (0..self.voices.len())
            .find(|&i| !self.voices[i].is_active())
            .unwrap_or_else(|| {
                let v = self.next_voice;
                self.next_voice = (v + 1) % self.voices.len();
                v
            });
        self.voices[idx].trigger(midi_note, velocity, hold_samples, p);
    }

    pub fn process(&mut self, buf: &mut [f32], p: &BassParams) {
        for v in self.voices.iter_mut() {
            if v.is_active() { v.process(buf, p); }
        }
    }
}

#[inline]
fn midi_to_hz(note: u8) -> f32 {
    440.0 * 2.0_f32.powf((note as f32 - 69.0) / 12.0)
}

/// Exponential sweep 20 Hz → 20 000 Hz
#[inline]
pub fn norm_to_cutoff_hz(norm: f32) -> f32 {
    20.0 * 1000.0_f32.powf(norm.clamp(0.0, 1.0))
}
