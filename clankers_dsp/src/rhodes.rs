/// Rhodes electric piano — 2-operator FM tine model
///
/// Inspired by Ableton Operator / Lounge Lizard approach:
///   - Phase-modulation synthesis (carrier + modulator, 1:1 ratio)
///   - Mod-index envelope decays fast  → bark on attack, smooth on tail
///   - Amp envelope decays slowly      → long natural ring
///   - Velocity controls peak mod depth (soft=smooth, hard=barky)
///   - Key scaling: higher notes decay faster, shorter bark
///   - Tremolo LFO for the classic Rhodes shimmer
///   - Stereo spread via Chorus
///
/// ClankerBoy CC map (t:3):
///   CC74  Brightness  (0-127 → peak FM index 0.5–8.0)
///   CC72  Decay       (0-127 → amp decay 0.5–6 s at C4)
///   CC20  Tine ratio  snaps to musical ratios: 0-42=1:1(unison) 43-84=1.5(fifth) 85-127=2:1(octave)
///   CC73  Bark decay  (0-127 → mod-index decay speed, lower=longer bark)
///   CC26  Tremolo rate  (0-127 → 0–9 Hz)
///   CC27  Tremolo depth (0-127 → 0–0.8)
///   CC29  Chorus rate   (0-127 → 0.1–5 Hz)
///   CC30  Chorus mix    (0-127 → 0–0.85)
///   CC10  Pan           (0-127 → L–R, 64=centre)

use crate::chorus::Chorus;
use crate::rng::Rng;

const SR:     f32 = 44100.0;
const TAU:    f32 = std::f32::consts::TAU;
const THRESH: f32 = 1e-5;

// ── Params ──────────────────────────────────────────────────────────────────

#[derive(Clone, Copy)]
pub struct RhodesParams {
    pub brightness:     f32,  // peak FM index at velocity=1  (0.5–8.0)
    pub amp_decay:      f32,  // amplitude decay time at C4, seconds
    pub mod_decay:      f32,  // mod-index decay time in seconds (0.02–0.6), independent of amp
    pub harm_ratio:     f32,  // modulator frequency ratio (0.9–2.0)
    pub key_scale:      f32,  // how much higher notes decay faster (0–1)
    pub tremolo_rate:   f32,  // Hz
    pub tremolo_depth:  f32,  // 0–0.8
    pub chorus_rate:    f32,  // Hz
    pub chorus_mix:     f32,  // 0–0.85
    pub pan:            f32,  // 0=L, 0.5=centre, 1=R
}

impl Default for RhodesParams {
    fn default() -> Self {
        RhodesParams {
            brightness:    3.0,
            amp_decay:     2.5,
            mod_decay:     0.18,  // bark duration in seconds (~180ms), independent of amp
            harm_ratio:    1.0,
            key_scale:     0.55,
            tremolo_rate:  2.2,   // gentle default — CC26/CC27 to taste
            tremolo_depth: 0.08,  // subtle; crank CC27 for vintage wobble
            chorus_rate:   0.7,
            chorus_mix:    0.12,  // subtle by default — CC30 to taste
            pan:           0.5,
        }
    }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/// exp(-1 / (decay_s * SR))  — per-sample multiplier for exponential decay
#[inline]
fn decay_coef(decay_s: f32) -> f32 {
    (-1.0 / (decay_s.max(0.001) * SR)).exp()
}

#[inline]
fn midi_to_hz(note: u8) -> f32 {
    440.0 * 2.0_f32.powf((note as f32 - 69.0) / 12.0)
}

// ── Voice ────────────────────────────────────────────────────────────────────

pub struct RhodesVoice {
    freq:         f32,
    car_phase:    f32,  // carrier phase 0..1
    mod_phase:    f32,  // modulator phase 0..1
    amp_env:      f32,  // current amplitude
    mod_env:      f32,  // current mod-index amplitude
    amp_coef:     f32,  // per-sample amp decay multiplier
    mod_coef:     f32,  // per-sample mod-index decay multiplier
    // hammer transient (brief click on attack)
    trans_env:    f32,
    trans_coef:   f32,
    trans_phase:  f32,
    // tremolo
    trem_phase:   f32,
    // hold / release
    hold_remaining: usize,
    released:       bool,
    release_coef:   f32,  // faster decay after release
    // stereo
    chorus:       Chorus,
    rng:          Rng,
    pub active:   bool,
}

impl RhodesVoice {
    pub fn new() -> Self {
        RhodesVoice {
            freq:           440.0,
            car_phase:      0.0,
            mod_phase:      0.0,
            amp_env:        0.0,
            mod_env:        0.0,
            amp_coef:       0.999,
            mod_coef:       0.995,
            trans_env:      0.0,
            trans_coef:     0.998,
            trans_phase:    0.0,
            trem_phase:     0.0,
            hold_remaining: 0,
            released:       false,
            release_coef:   0.9995,
            chorus:         Chorus::new(SR),
            rng:            Rng::new(0x726f6465),
            active:         false,
        }
    }

    pub fn trigger(&mut self, midi_note: u8, velocity: f32, hold_samples: usize, p: &RhodesParams) {
        let freq = midi_to_hz(midi_note);
        self.freq = freq;

        // Key scaling: C4=60 is reference. Higher notes → shorter decay.
        // key_factor approaches 0.3 at C7, 2.5 at C2
        let semitones_from_c4 = midi_note as f32 - 60.0;
        let key_factor = (1.0 - semitones_from_c4 * p.key_scale / 48.0).clamp(0.25, 2.5);

        let amp_decay_s  = p.amp_decay  * key_factor;
        // Bark is independent of amp decay — only key_factor scales it
        let mod_decay_s  = p.mod_decay  * key_factor;

        self.amp_coef  = decay_coef(amp_decay_s);
        self.mod_coef  = decay_coef(mod_decay_s.max(0.02));

        // Hammer transient: ~8ms click, level scales with velocity
        self.trans_coef  = decay_coef(0.008);
        self.trans_env   = velocity * 0.08;
        self.trans_phase = 0.0;

        // Initial amp + mod levels
        // Velocity raises amp linearly; for mod index, velocity is exponential (soft=very smooth)
        self.amp_env = velocity * 0.85;
        self.mod_env = velocity.powf(0.7) * p.brightness;  // FM bark

        // Slightly faster decay when key is released during hold
        self.release_coef = decay_coef(amp_decay_s * 0.12);

        // Reset phases for clean attack
        self.car_phase = 0.0;
        self.mod_phase = 0.0;

        self.hold_remaining = hold_samples;
        self.released = hold_samples == 0;
        self.active   = true;
    }

    pub fn process(&mut self, buf_l: &mut [f32], buf_r: &mut [f32], p: &RhodesParams) {
        // Pre-compute trem inc, pan gains
        let trem_inc  = p.tremolo_rate / SR;
        let pan_l = (1.0 - p.pan).sqrt();
        let pan_r = p.pan.sqrt();

        for (sl, sr) in buf_l.iter_mut().zip(buf_r.iter_mut()) {
            if !self.active { break; }

            // ── Hold / release ──────────────────────────────────────────────
            if self.hold_remaining > 0 {
                self.hold_remaining -= 1;
            } else if !self.released {
                self.released = true;
                // on release: snap amp_coef to faster release decay
                self.amp_coef = self.amp_coef.min(self.release_coef);
            }

            // ── Oscillators ────────────────────────────────────────────────
            // Phase modulation: car = sin(car_phase + mod_index * sin(mod_phase))
            let mod_sig = (self.mod_phase * TAU).sin();
            let car_sig = ((self.car_phase * TAU) + self.mod_env * mod_sig).sin();

            // Advance phases
            self.car_phase += self.freq / SR;
            if self.car_phase >= 1.0 { self.car_phase -= 1.0; }
            self.mod_phase += self.freq * p.harm_ratio / SR;
            if self.mod_phase >= 1.0 { self.mod_phase -= 1.0; }

            // ── Hammer transient ────────────────────────────────────────────
            // Short-lived filtered noise click (mixes with a high tone for thump)
            let noise    = self.rng.next_f32();
            let click_f  = self.freq * 6.0;  // high harmonic click
            let click_osc = (self.trans_phase * TAU).sin();
            self.trans_phase += click_f / SR;
            if self.trans_phase >= 1.0 { self.trans_phase -= 1.0; }
            let transient = self.trans_env * (noise * 0.5 + click_osc * 0.5);
            self.trans_env *= self.trans_coef;

            // ── Amp + mod decay ─────────────────────────────────────────────
            let raw = (car_sig * self.amp_env + transient) * 0.75;
            self.amp_env *= self.amp_coef;
            self.mod_env *= self.mod_coef;

            // ── Tremolo ────────────────────────────────────────────────────
            let trem = 1.0 - p.tremolo_depth * (1.0 - (self.trem_phase * TAU).cos()) * 0.5;
            self.trem_phase += trem_inc;
            if self.trem_phase >= 1.0 { self.trem_phase -= 1.0; }

            let sample = raw * trem;

            // ── Stereo via chorus ──────────────────────────────────────────
            // depth 0.04 → ±0.6ms sweep → ~±5 cents, proper subtle chorus
            let (cl, cr) = self.chorus.process(sample, sample,
                                               p.chorus_rate, 0.04, p.chorus_mix);

            *sl += cl * pan_l;
            *sr += cr * pan_r;

            // ── Silence gate ───────────────────────────────────────────────
            if self.amp_env < THRESH && self.trans_env < THRESH {
                self.active = false;
            }
        }
    }
}

// ── Engine ───────────────────────────────────────────────────────────────────

pub struct RhodesEngine {
    voices:     Vec<RhodesVoice>,
    next_voice: usize,
}

impl RhodesEngine {
    pub fn new() -> Self {
        RhodesEngine {
            voices:     (0..8).map(|_| RhodesVoice::new()).collect(),
            next_voice: 0,
        }
    }

    pub fn trigger(&mut self, midi_note: u8, velocity: f32, hold_samples: usize, p: &RhodesParams) {
        let idx = (0..self.voices.len())
            .find(|&i| !self.voices[i].active)
            .unwrap_or_else(|| {
                let v = self.next_voice;
                self.next_voice = (v + 1) % self.voices.len();
                v
            });
        self.voices[idx].trigger(midi_note, velocity, hold_samples, p);
    }

    pub fn process(&mut self, buf_l: &mut [f32], buf_r: &mut [f32], p: &RhodesParams) {
        for v in self.voices.iter_mut() {
            if v.active { v.process(buf_l, buf_r, p); }
        }
    }
}
