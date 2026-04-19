//! Synth drums — three profiles: 808 / 909 / 606.
//!
//! Voice IDs (0-6):
//!   0=KICK  1=SNARE  2=HH-CL  3=HH-OP  4=TOM-L  5=TOM-M/H  6=CLAP/TOM-H/CYMBAL
//!   Profile determines exact character + labels for slots 5 and 6.
//!
//! Global controls:
//!   set_pitch(semitones)   −12..+12  — scales all oscillator / filter freqs
//!   set_decay(mult)        0.1..8.0  — scales all amp-decay times (live for active voices)
//!   set_filter(hz)         80..20000 — one-pole LP on the output bus (live)

use crate::rng::Rng;

pub const DEFAULT_SR: f32 = 44100.0;
const TAU: f32 = core::f32::consts::TAU;

// ─── Profile ─────────────────────────────────────────────────────────────────

#[derive(Clone, Copy, PartialEq)]
pub enum Profile { R808, R909, R606 }

impl Profile {
    pub fn from_u8(id: u8) -> Self {
        match id { 1 => Self::R909, 2 => Self::R606, _ => Self::R808 }
    }
    fn idx(self) -> usize {
        match self { Profile::R808 => 0, Profile::R909 => 1, Profile::R606 => 2 }
    }
}

// ─── Voice kind ──────────────────────────────────────────────────────────────

#[derive(Clone, Copy, PartialEq)]
enum Kind { Tone, Snare, Hat, Clap, Cymbal }

// ─── Preset table ────────────────────────────────────────────────────────────

#[derive(Clone, Copy)]
struct Preset {
    freq_start:  f32,  // Hz — oscillator start / pitch-env start
    freq_end:    f32,  // Hz — pitch-env target
    pitch_ms:    f32,  // ms — time for pitch envelope to reach freq_end (≈ −60 dB)
    amp_decay_s: f32,  // s  — amp −60 dB decay time (before decay_mult)
    noise_hp_hz: f32,  // Hz — noise highpass cutoff (scales with pitch_mult)
    noise_amt:   f32,  // 0-1 sustained noise (used by snare/hat/clap/cymbal; 0 for kicks/toms)
    tone_amt:    f32,  // 0-1 tone contribution to mix
    decay_scale: f32,  // per-voice relative decay weight (kick=1.0, snare≈0.655, hat≈0.709)
    click_amt:   f32,  // 0-1 Kind::Tone attack-click level (HP-filtered noise, short env)
    click_ms:    f32,  // ms — click envelope −60 dB decay time
    kind:        Kind,
}

// Kick/tom attack-click defaults — short HP-filtered noise burst replaces
// the wideband hiss that used to bleed through for the full amp decay.
// Click HP cutoff uses the preset's `noise_hp_hz` field (so raising it
// brightens the click).
const PRESETS: [[Preset; 7]; 3] = [
  // ── 808 ────────────────────────────────────────────────────────────────────
  [
    // 0 KICK  — deep sub, long womp
    Preset { freq_start:200., freq_end:42.,  pitch_ms:65.,  amp_decay_s:0.80, noise_hp_hz:2500.,  noise_amt:0.0,  tone_amt:1.0,  decay_scale:1.000, click_amt:0.45, click_ms:12., kind:Kind::Tone   },
    // 1 SNARE — two-tone + noise
    Preset { freq_start:175., freq_end:175., pitch_ms:1.,   amp_decay_s:0.35, noise_hp_hz:250.,   noise_amt:0.65, tone_amt:0.50, decay_scale:0.655, click_amt:0.0,  click_ms:1.,  kind:Kind::Snare  },
    // 2 HH CL — tight metallic
    Preset { freq_start:0.,   freq_end:0.,   pitch_ms:1.,   amp_decay_s:0.040,noise_hp_hz:6000.,  noise_amt:1.0,  tone_amt:0.0,  decay_scale:0.709, click_amt:0.0,  click_ms:1.,  kind:Kind::Hat    },
    // 3 HH OP — open hat, smooth
    Preset { freq_start:0.,   freq_end:0.,   pitch_ms:1.,   amp_decay_s:0.50, noise_hp_hz:5000.,  noise_amt:1.0,  tone_amt:0.0,  decay_scale:0.709, click_amt:0.0,  click_ms:1.,  kind:Kind::Hat    },
    // 4 TOM L — low tom
    Preset { freq_start:130., freq_end:58.,  pitch_ms:80.,  amp_decay_s:0.55, noise_hp_hz:1800.,  noise_amt:0.0,  tone_amt:1.0,  decay_scale:0.850, click_amt:0.18, click_ms:8.,  kind:Kind::Tone   },
    // 5 TOM H — high tom
    Preset { freq_start:220., freq_end:95.,  pitch_ms:55.,  amp_decay_s:0.38, noise_hp_hz:2200.,  noise_amt:0.0,  tone_amt:1.0,  decay_scale:0.800, click_amt:0.20, click_ms:7.,  kind:Kind::Tone   },
    // 6 CLAP  — four-burst handclap
    Preset { freq_start:0.,   freq_end:0.,   pitch_ms:1.,   amp_decay_s:0.022,noise_hp_hz:800.,   noise_amt:1.0,  tone_amt:0.0,  decay_scale:0.709, click_amt:0.0,  click_ms:1.,  kind:Kind::Clap   },
  ],
  // ── 909 ────────────────────────────────────────────────────────────────────
  [
    // 0 KICK  — punchy, tight sweep
    Preset { freq_start:240., freq_end:55.,  pitch_ms:18.,  amp_decay_s:0.42, noise_hp_hz:3500.,  noise_amt:0.0,  tone_amt:0.90, decay_scale:1.000, click_amt:0.55, click_ms:10., kind:Kind::Tone   },
    // 1 SNARE — crisp crack
    Preset { freq_start:215., freq_end:215., pitch_ms:1.,   amp_decay_s:0.20, noise_hp_hz:350.,   noise_amt:0.80, tone_amt:0.35, decay_scale:0.655, click_amt:0.0,  click_ms:1.,  kind:Kind::Snare  },
    // 2 HH CL — bright, aggressive
    Preset { freq_start:0.,   freq_end:0.,   pitch_ms:1.,   amp_decay_s:0.025,noise_hp_hz:7000.,  noise_amt:1.0,  tone_amt:0.0,  decay_scale:0.709, click_amt:0.0,  click_ms:1.,  kind:Kind::Hat    },
    // 3 HH OP
    Preset { freq_start:0.,   freq_end:0.,   pitch_ms:1.,   amp_decay_s:0.38, noise_hp_hz:6500.,  noise_amt:1.0,  tone_amt:0.0,  decay_scale:0.709, click_amt:0.0,  click_ms:1.,  kind:Kind::Hat    },
    // 4 TOM L
    Preset { freq_start:155., freq_end:68.,  pitch_ms:38.,  amp_decay_s:0.32, noise_hp_hz:2000.,  noise_amt:0.0,  tone_amt:1.0,  decay_scale:0.850, click_amt:0.25, click_ms:8.,  kind:Kind::Tone   },
    // 5 TOM M
    Preset { freq_start:215., freq_end:98.,  pitch_ms:28.,  amp_decay_s:0.25, noise_hp_hz:2500.,  noise_amt:0.0,  tone_amt:1.0,  decay_scale:0.800, click_amt:0.25, click_ms:7.,  kind:Kind::Tone   },
    // 6 TOM H
    Preset { freq_start:300., freq_end:142., pitch_ms:18.,  amp_decay_s:0.19, noise_hp_hz:3000.,  noise_amt:0.0,  tone_amt:1.0,  decay_scale:0.800, click_amt:0.25, click_ms:6.,  kind:Kind::Tone   },
  ],
  // ── 606 ────────────────────────────────────────────────────────────────────
  [
    // 0 KICK  — thin, lo-fi
    Preset { freq_start:170., freq_end:52.,  pitch_ms:14.,  amp_decay_s:0.22, noise_hp_hz:2800.,  noise_amt:0.0,  tone_amt:0.70, decay_scale:1.000, click_amt:0.35, click_ms:9.,  kind:Kind::Tone   },
    // 1 SNARE — mostly noise, brittle
    Preset { freq_start:240., freq_end:240., pitch_ms:1.,   amp_decay_s:0.15, noise_hp_hz:600.,   noise_amt:0.90, tone_amt:0.15, decay_scale:0.655, click_amt:0.0,  click_ms:1.,  kind:Kind::Snare  },
    // 2 HH CL — small, brittle
    Preset { freq_start:0.,   freq_end:0.,   pitch_ms:1.,   amp_decay_s:0.018,noise_hp_hz:8000.,  noise_amt:1.0,  tone_amt:0.0,  decay_scale:0.709, click_amt:0.0,  click_ms:1.,  kind:Kind::Hat    },
    // 3 HH OP
    Preset { freq_start:0.,   freq_end:0.,   pitch_ms:1.,   amp_decay_s:0.30, noise_hp_hz:7500.,  noise_amt:1.0,  tone_amt:0.0,  decay_scale:0.709, click_amt:0.0,  click_ms:1.,  kind:Kind::Hat    },
    // 4 TOM L
    Preset { freq_start:210., freq_end:92.,  pitch_ms:18.,  amp_decay_s:0.22, noise_hp_hz:2000.,  noise_amt:0.0,  tone_amt:0.85, decay_scale:0.850, click_amt:0.18, click_ms:7.,  kind:Kind::Tone   },
    // 5 TOM H
    Preset { freq_start:340., freq_end:155., pitch_ms:11.,  amp_decay_s:0.16, noise_hp_hz:2800.,  noise_amt:0.0,  tone_amt:0.85, decay_scale:0.800, click_amt:0.18, click_ms:6.,  kind:Kind::Tone   },
    // 6 CYMBAL — 3 detuned oscillators + metallic noise
    Preset { freq_start:480., freq_end:480., pitch_ms:1.,   amp_decay_s:0.95, noise_hp_hz:4000.,  noise_amt:0.45, tone_amt:0.65, decay_scale:0.709, click_amt:0.0,  click_ms:1.,  kind:Kind::Cymbal },
  ],
];

// ─── Voice ───────────────────────────────────────────────────────────────────

struct Voice {
    active:      bool,
    kind:        Kind,
    vel:         f32,

    // Primary oscillator
    phase:       f32,
    freq:        f32,      // current frequency (decays toward freq_end)
    freq_end:    f32,
    pitch_k:     f32,      // per-sample: freq = freq_end + (freq−freq_end) * pitch_k

    // Extra oscillators (Cymbal: two detuned companions)
    phase2: f32, freq2: f32,
    phase3: f32, freq3: f32,

    // Amp envelope
    amp:         f32,
    amp_k:       f32,      // per-sample multiplier
    amp_decay_s: f32,      // base decay (stored for live update_amp_k)
    decay_scale: f32,      // per-voice relative decay weight

    // Per-voice LCG noise (independent from shared Rng)
    noise_seed:  u32,
    // One-pole HP filter: y = x − lp_z
    hp_z:        f32,
    hp_k:        f32,      // LP coeff for HP filter
    noise_amt:   f32,
    tone_amt:    f32,

    // Attack-click transient (Kind::Tone only): HP-filtered noise
    // with a short independent envelope on top of amp_env.
    click_amp:   f32,
    click_k:     f32,
    click_amt:   f32,

    // Clap burst counter
    clap_t:      u32,
}

impl Voice {
    const fn silent() -> Self {
        Voice {
            active:false, kind:Kind::Hat, vel:0.0,
            phase:0.0, freq:0.0, freq_end:0.0, pitch_k:0.0,
            phase2:0.0, freq2:0.0, phase3:0.0, freq3:0.0,
            amp:0.0, amp_k:0.0, amp_decay_s:0.0, decay_scale:1.0,
            noise_seed:1, hp_z:0.0, hp_k:0.0,
            noise_amt:0.0, tone_amt:0.0,
            click_amp:0.0, click_k:0.0, click_amt:0.0,
            clap_t:0,
        }
    }

    fn arm(&mut self, p: &Preset, vel: f32, pitch_mult: f32, decay_mult: f32, click_mult: f32, seed: u32, sr: f32) {
        let fs = p.freq_start * pitch_mult;
        let fe = p.freq_end   * pitch_mult;

        self.active      = true;
        self.kind        = p.kind;
        self.vel         = vel;
        self.phase       = 0.0;
        self.freq        = fs;
        self.freq_end    = fe;
        // Pitch envelope: reaches freq_end (−60 dB) in pitch_ms milliseconds
        self.pitch_k     = amp_coeff(p.pitch_ms * 0.001, sr);
        self.amp         = 1.0;
        self.amp_decay_s = p.amp_decay_s;
        self.decay_scale = p.decay_scale;
        self.amp_k       = amp_coeff(p.amp_decay_s * decay_mult * p.decay_scale, sr);
        self.noise_seed  = seed | 1;  // ensure non-zero
        self.hp_z        = 0.0;
        self.hp_k        = lp_coeff((p.noise_hp_hz * pitch_mult).max(20.0), sr);
        self.noise_amt   = p.noise_amt;
        self.tone_amt    = p.tone_amt;
        self.click_amt   = p.click_amt * click_mult;
        self.click_amp   = if self.click_amt > 0.0 { 1.0 } else { 0.0 };
        self.click_k     = amp_coeff(p.click_ms * 0.001, sr);
        self.clap_t      = 0;
        // Cymbal companion oscillators: golden-ratio and major-third detune
        self.phase2 = 0.0;  self.freq2 = fs * 1.292;
        self.phase3 = 0.0;  self.freq3 = fs * 1.618;
    }

    fn update_amp_k(&mut self, decay_mult: f32, sr: f32) {
        if self.active {
            self.amp_k = amp_coeff(self.amp_decay_s * decay_mult * self.decay_scale, sr);
        }
    }

    #[inline]
    fn tick(&mut self, sr: f32, clap_bursts: [u32; 3]) -> f32 {
        if !self.active { return 0.0; }

        let raw = match self.kind {
            Kind::Tone => {
                self.freq = self.freq_end + (self.freq - self.freq_end) * self.pitch_k;
                self.phase += self.freq / sr;
                let tone = (self.phase * TAU).sin();
                let n    = Rng::lcg_f32(&mut self.noise_seed);
                // HP-filtered attack click — short independent envelope
                let click = hp(&mut self.hp_z, self.hp_k, n) * self.click_amp * self.click_amt;
                self.click_amp *= self.click_k;
                tone * self.tone_amt + click + n * self.noise_amt
            }
            Kind::Snare => {
                self.phase += self.freq / sr;
                let tone = (self.phase * TAU).sin();
                let n    = Rng::lcg_f32(&mut self.noise_seed);
                let hp   = hp(&mut self.hp_z, self.hp_k, n);
                tone * self.tone_amt + hp * self.noise_amt
            }
            Kind::Hat => {
                let n  = Rng::lcg_f32(&mut self.noise_seed);
                hp(&mut self.hp_z, self.hp_k, n)
            }
            Kind::Clap => {
                // Re-trigger amp at each burst onset: 8 ms, 16 ms, 24 ms
                if clap_bursts.contains(&self.clap_t) { self.amp = 1.0; }
                self.clap_t += 1;
                let n  = Rng::lcg_f32(&mut self.noise_seed);
                hp(&mut self.hp_z, self.hp_k, n)
            }
            Kind::Cymbal => {
                self.phase  += self.freq  / sr;
                self.phase2 += self.freq2 / sr;
                self.phase3 += self.freq3 / sr;
                let tone = ((self.phase  * TAU).sin()
                          + (self.phase2 * TAU).sin()
                          + (self.phase3 * TAU).sin()) * (1.0 / 3.0);
                let n    = Rng::lcg_f32(&mut self.noise_seed);
                let hp   = hp(&mut self.hp_z, self.hp_k, n);
                tone * self.tone_amt + hp * self.noise_amt
            }
        };

        let out = raw * self.amp * self.vel;
        self.amp *= self.amp_k;
        if self.amp < 1.0e-4 { self.active = false; }
        out
    }
}

// ─── DSP helpers ─────────────────────────────────────────────────────────────

/// One-pole LP coefficient  k = exp(−2π·fc/SR)
#[inline] fn lp_coeff(fc: f32, sr: f32) -> f32 { (-TAU * fc / sr).exp() }

/// Amp −60 dB decay coefficient over `s` seconds
#[inline] fn amp_coeff(s: f32, sr: f32) -> f32 { (-6.908 / (sr * s.max(1e-4))).exp() }

/// One-pole highpass:  z tracks lp(x),  output = x − z
#[inline] fn hp(z: &mut f32, k: f32, x: f32) -> f32 {
    *z += (1.0 - k) * (x - *z);
    x - *z
}

// ─── DrumsEngine ─────────────────────────────────────────────────────────────

pub struct DrumsEngine {
    sr:          f32,
    filter_hz:   f32,    // cached so set_sample_rate can recompute filter_k
    voices:      [Voice; 7],
    profile:     Profile,
    pitch_mult:  f32,
    decay_mult:  f32,
    click_mult:  f32,    // 0..2 — multiplier on each preset's click_amt
    filter_z:    f32,    // global output LP state
    filter_k:    f32,    // global output LP coeff
    clap_bursts: [u32; 3],  // sample offsets for clap re-triggers at current SR
    pub(crate) rng: Rng,
}

fn clap_bursts_for(sr: f32) -> [u32; 3] {
    // 8 ms, 16 ms, 24 ms after clap onset
    let k = sr / 1000.0;
    [(8.0 * k) as u32, (16.0 * k) as u32, (24.0 * k) as u32]
}

impl DrumsEngine {
    pub fn new(seed: u32) -> Self {
        Self::new_with_sr(seed, DEFAULT_SR)
    }

    pub fn new_with_sr(seed: u32, sr: f32) -> Self {
        let filter_hz = 18_000.0;
        Self {
            sr,
            filter_hz,
            voices:     [
                Voice::silent(), Voice::silent(), Voice::silent(), Voice::silent(),
                Voice::silent(), Voice::silent(), Voice::silent(),
            ],
            profile:    Profile::R808,
            pitch_mult: 1.0,
            decay_mult: 1.0,
            click_mult: 1.0,
            filter_z:   0.0,
            filter_k:   lp_coeff(filter_hz, sr),
            clap_bursts: clap_bursts_for(sr),
            rng:        Rng::new(seed),
        }
    }

    pub fn set_sample_rate(&mut self, sr: f32) {
        self.sr          = sr;
        self.filter_k    = lp_coeff(self.filter_hz, sr);
        self.clap_bursts = clap_bursts_for(sr);
        self.filter_z    = 0.0;
        for v in &mut self.voices { v.active = false; }
    }

    pub fn set_profile(&mut self, id: u8) { self.profile = Profile::from_u8(id); }

    pub fn set_pitch(&mut self, semitones: f32) {
        self.pitch_mult = 2.0_f32.powf(semitones.clamp(-12.0, 12.0) / 12.0);
    }

    pub fn set_decay(&mut self, mult: f32) {
        self.decay_mult = mult.clamp(0.1, 8.0);
        for v in &mut self.voices { v.update_amp_k(self.decay_mult, self.sr); }
    }

    pub fn set_filter(&mut self, hz: f32) {
        self.filter_hz = hz.clamp(80.0, 20_000.0);
        self.filter_k  = lp_coeff(self.filter_hz, self.sr);
    }

    /// Scale the attack-click transient on Kind::Tone voices (kick, toms).
    /// 0.0 = no click, 1.0 = preset default, up to 2.0. Affects new notes only.
    pub fn set_click(&mut self, mult: f32) {
        self.click_mult = mult.clamp(0.0, 2.0);
    }

    pub fn trigger(&mut self, voice_id: u8, velocity: f32) {
        let id = voice_id as usize;
        if id >= 7 { return; }
        let preset = &PRESETS[self.profile.idx()][id];
        let seed   = self.rng.next_u32();
        self.voices[id].arm(preset, velocity.clamp(0.0, 1.0),
                            self.pitch_mult, self.decay_mult, self.click_mult, seed, self.sr);
    }

    pub fn process(&mut self, output: &mut [f32]) {
        let lp_g = 1.0 - self.filter_k;
        let sr = self.sr;
        let bursts = self.clap_bursts;
        for s in output.iter_mut() {
            let mut mix = 0.0_f32;
            for v in &mut self.voices { mix += v.tick(sr, bursts); }
            // Soft-clip bus
            mix = (mix * 0.7).tanh() / 0.7;
            // Global LP filter
            self.filter_z += lp_g * (mix - self.filter_z);
            *s = self.filter_z;
        }
    }
}
