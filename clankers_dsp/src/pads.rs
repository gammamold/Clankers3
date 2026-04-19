/// HybridSynth pads voice — sustained chords with Moog ladder + chorus + reverb
/// Ported from HybridSynth/Source/SynthVoice.cpp
///
/// Signal chain:
///   Saw + Triangle mix → Moog ladder → Amp ADSR → Chorus → Reverb
///
/// ClankerBoy CC map (t:6):
///   CC74  Filter cutoff    (0-127 → 20-8000 Hz)
///   CC71  Filter resonance (0-127 → 0-0.9)
///   CC73  Amp attack       (0-127 → 0.05-4 s)
///   CC72  Amp release      (0-127 → 0.1-4 s)
///   CC75  Amp decay        (0-127 → 0.05-2 s)
///   CC79  Amp sustain      (0-127 → 0-1)
///   CC88  Reverb size      (0-127 → 0-1)
///   CC91  Reverb mix       (0-127 → 0-1)
///   CC29  Chorus rate      (0-127 → 0.1-5 Hz)
///   CC30  Chorus depth     (0-127 → 0-1)
///   CC31  Chorus mix       (0-127 → 0-1)

use crate::chorus::Chorus;
use crate::envelope::Envelope;
use crate::moog_ladder::MoogLadder;
use crate::oscillator::{Oscillator, Waveform};
use crate::reverb::Reverb;

pub const DEFAULT_SR: f32 = 44100.0;

#[derive(Clone, Copy)]
pub struct PadsParams {
    pub cutoff_hz:    f32,
    pub resonance:    f32,
    pub amp_attack:   f32,
    pub amp_decay:    f32,
    pub amp_sustain:  f32,
    pub amp_release:  f32,
    pub reverb_size:  f32,
    pub reverb_mix:   f32,
    pub chorus_rate:  f32,
    pub chorus_depth: f32,
    pub chorus_mix:   f32,
}

impl Default for PadsParams {
    fn default() -> Self {
        PadsParams {
            cutoff_hz:    800.0,
            resonance:    0.15,
            amp_attack:   0.4,
            amp_decay:    0.5,
            amp_sustain:  0.8,
            amp_release:  1.2,
            reverb_size:  0.65,
            reverb_mix:   0.45,
            chorus_rate:  0.5,
            chorus_depth: 0.4,
            chorus_mix:   0.35,
        }
    }
}

// Positional descriptor for host UIs. Stable order:
//   0 cutoff_hz, 1 resonance, 2 amp_attack, 3 amp_decay, 4 amp_sustain,
//   5 amp_release, 6 reverb_size, 7 reverb_mix, 8 chorus_rate,
//   9 chorus_depth, 10 chorus_mix.
const PARAM_INFO_JSON: &str = concat!(
    "[",
    r#"{"idx":0,"name":"Cutoff","unit":"Hz","min":20.0,"max":8000.0,"default":800.0,"skew":"log","cc":74},"#,
    r#"{"idx":1,"name":"Resonance","unit":"","min":0.0,"max":0.9,"default":0.15,"cc":71},"#,
    r#"{"idx":2,"name":"Attack","unit":"s","min":0.05,"max":4.0,"default":0.4,"skew":"log","cc":73},"#,
    r#"{"idx":3,"name":"Decay","unit":"s","min":0.05,"max":2.0,"default":0.5,"skew":"log","cc":75},"#,
    r#"{"idx":4,"name":"Sustain","unit":"","min":0.0,"max":1.0,"default":0.8,"cc":79},"#,
    r#"{"idx":5,"name":"Release","unit":"s","min":0.1,"max":4.0,"default":1.2,"skew":"log","cc":72},"#,
    r#"{"idx":6,"name":"Reverb Size","unit":"","min":0.0,"max":1.0,"default":0.65,"cc":88},"#,
    r#"{"idx":7,"name":"Reverb Mix","unit":"","min":0.0,"max":1.0,"default":0.45,"cc":91},"#,
    r#"{"idx":8,"name":"Chorus Rate","unit":"Hz","min":0.1,"max":5.0,"default":0.5,"cc":29},"#,
    r#"{"idx":9,"name":"Chorus Depth","unit":"","min":0.0,"max":1.0,"default":0.4,"cc":30},"#,
    r#"{"idx":10,"name":"Chorus Mix","unit":"","min":0.0,"max":1.0,"default":0.35,"cc":31}"#,
    "]",
);
const PARAM_INFO_C_BYTES: &[u8] = concat!(
    "[",
    r#"{"idx":0,"name":"Cutoff","unit":"Hz","min":20.0,"max":8000.0,"default":800.0,"skew":"log","cc":74},"#,
    r#"{"idx":1,"name":"Resonance","unit":"","min":0.0,"max":0.9,"default":0.15,"cc":71},"#,
    r#"{"idx":2,"name":"Attack","unit":"s","min":0.05,"max":4.0,"default":0.4,"skew":"log","cc":73},"#,
    r#"{"idx":3,"name":"Decay","unit":"s","min":0.05,"max":2.0,"default":0.5,"skew":"log","cc":75},"#,
    r#"{"idx":4,"name":"Sustain","unit":"","min":0.0,"max":1.0,"default":0.8,"cc":79},"#,
    r#"{"idx":5,"name":"Release","unit":"s","min":0.1,"max":4.0,"default":1.2,"skew":"log","cc":72},"#,
    r#"{"idx":6,"name":"Reverb Size","unit":"","min":0.0,"max":1.0,"default":0.65,"cc":88},"#,
    r#"{"idx":7,"name":"Reverb Mix","unit":"","min":0.0,"max":1.0,"default":0.45,"cc":91},"#,
    r#"{"idx":8,"name":"Chorus Rate","unit":"Hz","min":0.1,"max":5.0,"default":0.5,"cc":29},"#,
    r#"{"idx":9,"name":"Chorus Depth","unit":"","min":0.0,"max":1.0,"default":0.4,"cc":30},"#,
    r#"{"idx":10,"name":"Chorus Mix","unit":"","min":0.0,"max":1.0,"default":0.35,"cc":31}"#,
    "]\0",
).as_bytes();

impl PadsParams {
    pub const PARAM_INFO:   &'static str  = PARAM_INFO_JSON;
    pub const PARAM_INFO_C: &'static [u8] = PARAM_INFO_C_BYTES;

    pub fn set_param(&mut self, idx: u32, value: f32) {
        match idx {
             0 => self.cutoff_hz    = value.clamp(20.0, 8000.0),
             1 => self.resonance    = value.clamp(0.0, 0.9),
             2 => self.amp_attack   = value.clamp(0.05, 4.0),
             3 => self.amp_decay    = value.clamp(0.05, 2.0),
             4 => self.amp_sustain  = value.clamp(0.0, 1.0),
             5 => self.amp_release  = value.clamp(0.1, 4.0),
             6 => self.reverb_size  = value.clamp(0.0, 1.0),
             7 => self.reverb_mix   = value.clamp(0.0, 1.0),
             8 => self.chorus_rate  = value.clamp(0.1, 5.0),
             9 => self.chorus_depth = value.clamp(0.0, 1.0),
            10 => self.chorus_mix   = value.clamp(0.0, 1.0),
            _  => {}
        }
    }
}

pub struct PadsVoice {
    osc_saw:        Oscillator,
    osc_tri:        Oscillator,
    filter:         MoogLadder,
    amp_env:        Envelope,
    chorus:         Chorus,
    reverb:         Reverb,
    freq:           f32,
    hold_remaining: usize,
    released:       bool,
    active:         bool,
}

impl PadsVoice {
    pub fn new(sr: f32) -> Self {
        PadsVoice {
            osc_saw:        Oscillator::new(sr),
            osc_tri:        Oscillator::new(sr),
            filter:         MoogLadder::new(sr),
            amp_env:        Envelope::new(sr),
            chorus:         Chorus::new(sr),
            reverb:         Reverb::new(sr),
            freq:           440.0,
            hold_remaining: 0,
            released:       false,
            active:         false,
        }
    }

    pub fn set_sample_rate(&mut self, sr: f32) {
        self.osc_saw        = Oscillator::new(sr);
        self.osc_tri        = Oscillator::new(sr);
        self.filter         = MoogLadder::new(sr);
        self.amp_env        = Envelope::new(sr);
        self.chorus         = Chorus::new(sr);
        self.reverb         = Reverb::new(sr);
        self.hold_remaining = 0;
        self.released       = false;
        self.active         = false;
    }

    /// hold_samples: render note-on for this many samples then release.
    pub fn trigger(&mut self, midi_note: u8, velocity: f32, hold_samples: usize, p: &PadsParams) {
        self.freq = midi_to_hz(midi_note);
        self.osc_saw.level = velocity * 0.6;
        self.osc_tri.level = velocity * 0.4;

        self.amp_env.set_adsr(p.amp_attack, p.amp_decay, p.amp_sustain, p.amp_release);
        self.amp_env.note_on();

        self.hold_remaining = hold_samples;
        self.released = false;
        self.active   = true;
    }

    /// Write stereo output into buf_l / buf_r (additive).
    pub fn process(&mut self, buf_l: &mut [f32], buf_r: &mut [f32], p: &PadsParams) {
        for (sl, sr) in buf_l.iter_mut().zip(buf_r.iter_mut()) {
            if !self.active { break; }

            // Note-off after hold duration
            if self.hold_remaining > 0 {
                self.hold_remaining -= 1;
            } else if !self.released {
                self.amp_env.note_off();
                self.released = true;
            }

            let amp = self.amp_env.process();
            if amp < 1e-6 && !self.amp_env.is_active() {
                self.active = false;
                break;
            }

            let saw  = self.osc_saw.next(self.freq, Waveform::Saw);
            let tri  = self.osc_tri.next(self.freq, Waveform::Triangle);
            let mixed = saw + tri;

            let filtered = self.filter.process(mixed, p.cutoff_hz, p.resonance, 1.0);
            let dry = filtered * amp * 0.8;

            // Chorus → stereo spread
            let (cl, cr) = self.chorus.process(dry, dry, p.chorus_rate, p.chorus_depth, p.chorus_mix);

            // Reverb (mono in, added to both channels)
            let rev     = self.reverb.process_mono((cl + cr) * 0.5, p.reverb_size, 0.4);
            let rev_wet = rev * p.reverb_mix;
            let dry_mix = 1.0 - p.reverb_mix;

            *sl += cl * dry_mix + rev_wet;
            *sr += cr * dry_mix + rev_wet;
        }
    }

    pub fn is_active(&self) -> bool { self.active }
}

/// 8-voice polyphonic engine (stereo output)
pub struct PadsEngine {
    voices:     Vec<PadsVoice>,
    next_voice: usize,
}

impl PadsEngine {
    pub fn new() -> Self { Self::new_with_sr(DEFAULT_SR) }

    pub fn new_with_sr(sr: f32) -> Self {
        PadsEngine {
            voices:     (0..8).map(|_| PadsVoice::new(sr)).collect(),
            next_voice: 0,
        }
    }

    pub fn set_sample_rate(&mut self, sr: f32) {
        for v in self.voices.iter_mut() { v.set_sample_rate(sr); }
    }

    pub fn trigger(&mut self, midi_note: u8, velocity: f32, hold_samples: usize, p: &PadsParams) {
        let idx = (0..self.voices.len())
            .find(|&i| !self.voices[i].is_active())
            .unwrap_or_else(|| {
                let v = self.next_voice;
                self.next_voice = (v + 1) % self.voices.len();
                v
            });
        self.voices[idx].trigger(midi_note, velocity, hold_samples, p);
    }

    pub fn process(&mut self, buf_l: &mut [f32], buf_r: &mut [f32], p: &PadsParams) {
        for v in self.voices.iter_mut() {
            if v.is_active() { v.process(buf_l, buf_r, p); }
        }
    }
}

#[inline]
fn midi_to_hz(note: u8) -> f32 {
    440.0 * 2.0_f32.powf((note as f32 - 69.0) / 12.0)
}
