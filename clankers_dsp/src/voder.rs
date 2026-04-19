/// Parallel-formant Voder — inspired by the 1939 Bell Laboratories Voder.
///
/// Signal chain (per voice):
///   Glottal pulse (PolyBLEP sawtooth → spectral-tilt LP)
///   + Aspiration noise (white → 1-pole HP for hiss character)
///   → voicing crossfade  (0 = pure hiss, 1 = pure glottal)
///   → 5 parallel biquad bandpass resonators (F1–F5)
///   → amplitude ADSR
///
/// The three primary formants (F1-F3) smoothly interpolate between phoneme
/// targets at a user-tuneable coarticulation rate.  F4/F5 are fixed speaker-
/// character formants.  All smoothing uses a per-block exponential approach
/// so biquad coefficients are recomputed once per `process()` call (~3ms).
///
/// Phoneme alphabet (34 phones, index 0-33):
///   0 AA   1 AE   2 AH   3 AO   4 EH   5 ER   6 EY   7 IH   8 IY
///   9 OW  10 UH  11 UW  12 L   13 R   14 W   15 Y   16 M   17 N
///  18 F   19 S   20 SH  21 TH  22 V   23 Z   24 ZH
///  25 SIL 26 HH  27 NG  28 B   29 D   30 G   31 P   32 T   33 K
///
/// CC map:
///   CC74  brightness     0-127 → 0.5-1.5× formant freq scale
///   CC20  voicing        0-127 → 0-1 manual override (0 = phoneme's voicing)
///   CC73  attack_ms      0-127 → 1-100 ms
///   CC72  release_ms     0-127 → 10-500 ms
///   CC75  vibrato_depth  0-127 → 0-80 cents
///   CC76  vibrato_rate   0-127 → 3-8 Hz
///   CC77  coartic_ms     0-127 → 5-80 ms
///   CC16  volume         0-127 → 0-1

use crate::biquad::Biquad;
use crate::envelope::Envelope;
use crate::oscillator::{Oscillator, Waveform};
use crate::rng::Rng;

const SR:       f32 = 44100.0;
const N_VOICES: usize = 4;

// Fixed upper formants — give "speaker character"
const F4_HZ:  f32 = 3500.0;
const F4_BW:  f32 = 280.0;
const F5_HZ:  f32 = 4500.0;
const F5_BW:  f32 = 350.0;

// Parallel formant gains (sum to ~2.5 before normalisation)
const GAINS: [f32; 5] = [1.0, 0.80, 0.55, 0.22, 0.12];

// ── Phoneme table ─────────────────────────────────────────────────────────────
//
// Each entry: (F1, F2, F3, BW1, BW2, BW3, voicing)
// Formant values from Peterson & Barney (1952) male averages, adjusted for
// a musical context.  Bandwidth values from Klatt (1980) recommendations.

struct PhonemeSpec {
    f1: f32, f2: f32, f3: f32,
    b1: f32, b2: f32, b3: f32,
    voicing: f32,   // 0.0=unvoiced  1.0=fully voiced
    amp:     f32,   // base amplitude (0=silent, 1=full) — stops use 0 for closure
}

const PHONEMES: &[PhonemeSpec] = &[
    // ── Vowels ────────────────────────────────────────────────────────────────
    //  0 AA  "father"
    PhonemeSpec { f1: 730., f2: 1090., f3: 2440., b1: 90., b2: 110., b3: 170., voicing: 1.0, amp: 1.00 },
    //  1 AE  "cat"
    PhonemeSpec { f1: 660., f2: 1720., f3: 2410., b1: 80., b2: 120., b3: 160., voicing: 1.0, amp: 1.00 },
    //  2 AH  "but"
    PhonemeSpec { f1: 520., f2: 1190., f3: 2390., b1: 70., b2: 100., b3: 150., voicing: 1.0, amp: 1.00 },
    //  3 AO  "caught"
    PhonemeSpec { f1: 570., f2:  840., f3: 2410., b1: 80., b2:  90., b3: 150., voicing: 1.0, amp: 1.00 },
    //  4 EH  "bed"
    PhonemeSpec { f1: 530., f2: 1840., f3: 2480., b1: 70., b2: 110., b3: 160., voicing: 1.0, amp: 1.00 },
    //  5 ER  "bird"  (retroflex — F3 collapses)
    PhonemeSpec { f1: 490., f2: 1350., f3: 1690., b1: 80., b2: 150., b3: 200., voicing: 1.0, amp: 1.00 },
    //  6 EY  "say" (steady-state endpoint)
    PhonemeSpec { f1: 390., f2: 2530., f3: 3000., b1: 70., b2: 110., b3: 150., voicing: 1.0, amp: 1.00 },
    //  7 IH  "bit"
    PhonemeSpec { f1: 390., f2: 1990., f3: 2550., b1: 70., b2: 110., b3: 150., voicing: 1.0, amp: 1.00 },
    //  8 IY  "beet"
    PhonemeSpec { f1: 270., f2: 2290., f3: 3010., b1: 60., b2:  90., b3: 120., voicing: 1.0, amp: 1.00 },
    //  9 OW  "go"
    PhonemeSpec { f1: 450., f2:  800., f3: 2380., b1: 80., b2:  90., b3: 150., voicing: 1.0, amp: 1.00 },
    // 10 UH  "book"
    PhonemeSpec { f1: 440., f2: 1020., f3: 2240., b1: 70., b2:  90., b3: 130., voicing: 1.0, amp: 1.00 },
    // 11 UW  "boot"
    PhonemeSpec { f1: 300., f2:  870., f3: 2240., b1: 70., b2:  80., b3: 110., voicing: 1.0, amp: 1.00 },
    // ── Approximants / nasals ─────────────────────────────────────────────────
    // 12 L
    PhonemeSpec { f1: 360., f2: 1000., f3: 2500., b1: 90., b2: 130., b3: 170., voicing: 1.0, amp: 0.85 },
    // 13 R
    PhonemeSpec { f1: 460., f2: 1330., f3: 1700., b1: 90., b2: 130., b3: 200., voicing: 1.0, amp: 0.85 },
    // 14 W
    PhonemeSpec { f1: 300., f2:  610., f3: 2200., b1: 90., b2: 120., b3: 160., voicing: 1.0, amp: 0.85 },
    // 15 Y
    PhonemeSpec { f1: 280., f2: 2230., f3: 3000., b1: 80., b2: 110., b3: 150., voicing: 1.0, amp: 0.85 },
    // 16 M  nasal murmur
    PhonemeSpec { f1: 280., f2:  900., f3: 2200., b1: 90., b2: 100., b3: 150., voicing: 1.0, amp: 0.70 },
    // 17 N
    PhonemeSpec { f1: 280., f2: 1500., f3: 2200., b1: 90., b2: 120., b3: 150., voicing: 1.0, amp: 0.70 },
    // ── Unvoiced fricatives ───────────────────────────────────────────────────
    // 18 F  labiodental
    PhonemeSpec { f1: 800., f2: 2000., f3: 5000., b1: 200., b2: 300., b3: 600., voicing: 0.0, amp: 0.55 },
    // 19 S  alveolar sibilant
    PhonemeSpec { f1: 900., f2: 2200., f3: 5500., b1: 250., b2: 350., b3: 700., voicing: 0.0, amp: 0.75 },
    // 20 SH postalveolar
    PhonemeSpec { f1: 800., f2: 1800., f3: 2800., b1: 200., b2: 300., b3: 400., voicing: 0.0, amp: 0.70 },
    // 21 TH dental
    PhonemeSpec { f1: 800., f2: 1500., f3: 4000., b1: 200., b2: 300., b3: 500., voicing: 0.0, amp: 0.45 },
    // ── Voiced fricatives ─────────────────────────────────────────────────────
    // 22 V
    PhonemeSpec { f1: 800., f2: 2000., f3: 5000., b1: 200., b2: 300., b3: 600., voicing: 0.8, amp: 0.65 },
    // 23 Z
    PhonemeSpec { f1: 900., f2: 2200., f3: 5500., b1: 250., b2: 350., b3: 700., voicing: 0.8, amp: 0.80 },
    // 24 ZH  "measure"
    PhonemeSpec { f1: 800., f2: 1800., f3: 2800., b1: 200., b2: 300., b3: 400., voicing: 0.8, amp: 0.75 },
    // ── Silence / stop closure ────────────────────────────────────────────────
    // 25 SIL — used for stop-consonant closures and inter-word gaps
    PhonemeSpec { f1: 500., f2: 1500., f3: 2500., b1: 80., b2: 100., b3: 150., voicing: 0.0, amp: 0.00 },
    // ── Aspiration /h/ ────────────────────────────────────────────────────────
    // 26 HH  — breathy noise through the following vowel's formants
    PhonemeSpec { f1: 500., f2: 1500., f3: 2500., b1: 150., b2: 200., b3: 300., voicing: 0.0, amp: 0.30 },
    // ── Velar nasal ───────────────────────────────────────────────────────────
    // 27 NG  "sing"
    PhonemeSpec { f1: 280., f2: 2100., f3: 2800., b1: 90., b2: 130., b3: 180., voicing: 1.0, amp: 0.65 },
    // ── Voiced stop bursts ────────────────────────────────────────────────────
    // 28 B  bilabial release
    PhonemeSpec { f1: 320., f2:  900., f3: 2100., b1: 90., b2: 150., b3: 200., voicing: 1.0, amp: 0.95 },
    // 29 D  alveolar release
    PhonemeSpec { f1: 320., f2: 1700., f3: 2600., b1: 90., b2: 150., b3: 200., voicing: 1.0, amp: 0.95 },
    // 30 G  velar release
    PhonemeSpec { f1: 320., f2: 2000., f3: 2400., b1: 90., b2: 150., b3: 200., voicing: 1.0, amp: 0.95 },
    // ── Unvoiced stop bursts (noise-driven) ───────────────────────────────────
    // 31 P  bilabial burst
    PhonemeSpec { f1: 700., f2: 1500., f3: 3500., b1: 250., b2: 350., b3: 500., voicing: 0.0, amp: 0.85 },
    // 32 T  alveolar burst
    PhonemeSpec { f1: 900., f2: 2500., f3: 5500., b1: 250., b2: 350., b3: 700., voicing: 0.0, amp: 0.95 },
    // 33 K  velar burst
    PhonemeSpec { f1: 800., f2: 2000., f3: 4000., b1: 250., b2: 350., b3: 550., voicing: 0.0, amp: 0.90 },
];

pub const N_PHONEMES: usize = 34;

// ── VoderParams ───────────────────────────────────────────────────────────────

#[derive(Clone, Copy)]
pub struct VoderParams {
    pub brightness:     f32,   // formant freq scale  0.5..1.5
    pub voicing_manual: f32,   // 0 = use phoneme, 0..1 = override
    pub attack_s:       f32,
    pub release_s:      f32,
    pub vibrato_depth:  f32,   // semitones (0..0.67)
    pub vibrato_rate:   f32,   // Hz
    pub coartic_ms:     f32,   // coarticulation time constant
    pub volume:         f32,
}

impl Default for VoderParams {
    fn default() -> Self {
        VoderParams {
            brightness:     1.0,
            voicing_manual: 0.0,
            attack_s:       0.015,
            release_s:      0.08,
            vibrato_depth:  0.0,
            vibrato_rate:   5.5,
            coartic_ms:     20.0,
            volume:         0.9,
        }
    }
}

// Positional descriptor for host UIs. Stable order:
//   0 brightness, 1 voicing_manual, 2 attack_s, 3 release_s,
//   4 vibrato_depth, 5 vibrato_rate, 6 coartic_ms, 7 volume.
const PARAM_INFO_JSON: &str = concat!(
    "[",
    r#"{"idx":0,"name":"Brightness","unit":"","min":0.5,"max":1.5,"default":1.0,"cc":74},"#,
    r#"{"idx":1,"name":"Voicing","unit":"","min":0.0,"max":1.0,"default":0.0,"cc":20},"#,
    r#"{"idx":2,"name":"Attack","unit":"s","min":0.001,"max":0.1,"default":0.015,"skew":"log","cc":73},"#,
    r#"{"idx":3,"name":"Release","unit":"s","min":0.01,"max":0.5,"default":0.08,"skew":"log","cc":72},"#,
    r#"{"idx":4,"name":"Vibrato Depth","unit":"semitones","min":0.0,"max":0.667,"default":0.0,"cc":75},"#,
    r#"{"idx":5,"name":"Vibrato Rate","unit":"Hz","min":3.0,"max":8.0,"default":5.5,"cc":76},"#,
    r#"{"idx":6,"name":"Coartic","unit":"ms","min":5.0,"max":80.0,"default":20.0,"cc":77},"#,
    r#"{"idx":7,"name":"Volume","unit":"","min":0.0,"max":1.0,"default":0.9,"cc":16}"#,
    "]",
);
const PARAM_INFO_C_BYTES: &[u8] = concat!(
    "[",
    r#"{"idx":0,"name":"Brightness","unit":"","min":0.5,"max":1.5,"default":1.0,"cc":74},"#,
    r#"{"idx":1,"name":"Voicing","unit":"","min":0.0,"max":1.0,"default":0.0,"cc":20},"#,
    r#"{"idx":2,"name":"Attack","unit":"s","min":0.001,"max":0.1,"default":0.015,"skew":"log","cc":73},"#,
    r#"{"idx":3,"name":"Release","unit":"s","min":0.01,"max":0.5,"default":0.08,"skew":"log","cc":72},"#,
    r#"{"idx":4,"name":"Vibrato Depth","unit":"semitones","min":0.0,"max":0.667,"default":0.0,"cc":75},"#,
    r#"{"idx":5,"name":"Vibrato Rate","unit":"Hz","min":3.0,"max":8.0,"default":5.5,"cc":76},"#,
    r#"{"idx":6,"name":"Coartic","unit":"ms","min":5.0,"max":80.0,"default":20.0,"cc":77},"#,
    r#"{"idx":7,"name":"Volume","unit":"","min":0.0,"max":1.0,"default":0.9,"cc":16}"#,
    "]\0",
).as_bytes();

impl VoderParams {
    pub const PARAM_INFO:   &'static str  = PARAM_INFO_JSON;
    pub const PARAM_INFO_C: &'static [u8] = PARAM_INFO_C_BYTES;

    /// Set one param by positional index (see `PARAM_INFO`). Out-of-range
    /// indices are ignored. Values are clamped to the declared range.
    pub fn set_param(&mut self, idx: u32, value: f32) {
        match idx {
            0 => self.brightness     = value.clamp(0.5, 1.5),
            1 => self.voicing_manual = value.clamp(0.0, 1.0),
            2 => self.attack_s       = value.clamp(0.001, 0.1),
            3 => self.release_s      = value.clamp(0.01, 0.5),
            4 => self.vibrato_depth  = value.clamp(0.0, 0.667),
            5 => self.vibrato_rate   = value.clamp(3.0, 8.0),
            6 => self.coartic_ms     = value.clamp(5.0, 80.0),
            7 => self.volume         = value.clamp(0.0, 1.0),
            _ => {}
        }
    }
}

// ── VoderVoice ────────────────────────────────────────────────────────────────

/// One entry in a timed phoneme sequence.
#[derive(Clone, Copy)]
struct QueueEntry {
    phoneme:    usize,
    duration:   usize,   // samples this phoneme runs
    pitch_mult: f32,     // multiplies freq_hz (1.0 = at midi_note pitch)
    amp_mult:   f32,     // multiplies phoneme's base amp (1.0 = base)
}

pub struct VoderVoice {
    osc:          Oscillator,      // glottal (sawtooth)
    glot_lp:      Biquad,          // spectral tilt: ~1 kHz LP for -6dB/oct shaping
    rng:          Rng,
    noise_hp:     f32,             // 1-pole HP state for aspiration colouring

    resonators:   [Biquad; 5],

    env:          Envelope,
    vib_phase:    f32,

    // Smoothed formant state (updated once per process block)
    f_cur:        [f32; 3],        // current F1, F2, F3 (Hz)
    bw_cur:       [f32; 3],        // current BW1, BW2, BW3 (Hz)
    v_cur:        f32,             // current voicing mix
    amp_cur:      f32,             // current per-phoneme amp
    pitch_cur:    f32,             // current per-phoneme pitch multiplier

    // Targets (set by set_phoneme / set_xy)
    f_tgt:        [f32; 3],
    bw_tgt:       [f32; 3],
    v_tgt:        f32,
    amp_tgt:      f32,
    pitch_tgt:    f32,

    // Phoneme queue
    queue:        Vec<QueueEntry>,
    queue_samps:  usize,           // samples consumed in current phoneme slot

    // Performance: coefficient update throttling
    coeff_block:  u8,              // wrapping counter; F1-F3 coefficients updated every 4 blocks
    last_br:      f32,             // last brightness used for glot_lp (skip recompute if unchanged)

    freq_hz:      f32,
    active:       bool,
    held:         bool,            // note-on is being held
    midi_note:    u8,
}

impl VoderVoice {
    pub fn new(seed: u32) -> Self {
        let mut v = VoderVoice {
            osc:          Oscillator::new(SR),
            glot_lp:      Biquad::new(),
            rng:          Rng::new(seed),
            noise_hp:     0.0,
            resonators:   core::array::from_fn(|_| Biquad::new()),
            env:          Envelope::new(SR),
            vib_phase:    0.0,
            f_cur:        [600., 1200., 2400.],
            bw_cur:       [80., 100., 150.],
            v_cur:        1.0,
            amp_cur:      1.0,
            pitch_cur:    1.0,
            f_tgt:        [600., 1200., 2400.],
            bw_tgt:       [80., 100., 150.],
            v_tgt:        1.0,
            amp_tgt:      1.0,
            pitch_tgt:    1.0,
            queue:        Vec::new(),
            queue_samps:  0,
            coeff_block:  0,
            last_br:      -1.0,   // sentinel: force first glot_lp computation
            freq_hz:      220.0,
            active:       false,
            held:         false,
            midi_note:    60,
        };
        v.glot_lp.set_lpf1(1400.0, SR);
        // F4/F5 are fixed speaker-character formants — pre-compute once, never recompute.
        v.resonators[3].set_bpf(F4_HZ, F4_BW, SR);
        v.resonators[4].set_bpf(F5_HZ, F5_BW, SR);
        v
    }

    pub fn trigger(&mut self, midi_note: u8, _velocity: f32, hold_samps: usize, p: &VoderParams) {
        self.midi_note = midi_note;
        self.freq_hz   = midi_to_hz(midi_note);
        self.held      = hold_samps > 0;
        self.active    = true;
        self.vib_phase = 0.0;

        self.env.set_adsr(p.attack_s, 0.01, 1.0, p.release_s);
        self.env.note_on();

        // Force-compute F1–F3 biquad coefficients immediately so the very first
        // process() block is never silent.  Reset coeff_block to 3 so the throttle
        // fires on the next block (wrapping_add(1) → 4, 4 % 4 == 0).
        let br = p.brightness.clamp(0.5, 1.5);
        for i in 0..3 {
            self.resonators[i].set_bpf(self.f_cur[i] * br, self.bw_cur[i], SR);
        }
        self.glot_lp.set_lpf1(800.0 + 800.0 * br, SR);
        self.last_br     = br;
        self.coeff_block = 3;   // next wrapping_add(1) → 4 → triggers first update

        // If no queue, start release after hold_samps (like other instruments)
        if hold_samps > 0 && self.queue.is_empty() {
            // We'll track manually in process()
            self.queue_samps = hold_samps;
        }
    }

    pub fn release(&mut self) {
        self.held = false;
        self.env.note_off();
    }

    /// Set formant targets from a phoneme index.
    pub fn set_phoneme(&mut self, idx: usize) {
        let idx = idx.min(N_PHONEMES - 1);
        let ph  = &PHONEMES[idx];
        self.f_tgt   = [ph.f1, ph.f2, ph.f3];
        self.bw_tgt  = [ph.b1, ph.b2, ph.b3];
        self.v_tgt   = ph.voicing;
        self.amp_tgt = ph.amp;
    }

    /// Set formant targets directly via a 0..1 vowel-space coordinate.
    /// x: F1 axis (0=closed/high, 1=open/low)  — maps 250..800 Hz
    /// y: F2 axis (0=back, 1=front)             — maps 600..2500 Hz
    pub fn set_xy(&mut self, x: f32, y: f32) {
        self.f_tgt[0]  = 250.0 + x.clamp(0., 1.) * 550.0;
        self.f_tgt[1]  = 600.0 + y.clamp(0., 1.) * 1900.0;
        // F3 roughly tracks F2 position
        self.f_tgt[2]  = 1600.0 + y.clamp(0., 1.) * 1400.0;
        self.bw_tgt    = [80., 100., 150.];
        self.v_tgt     = 1.0;
        self.amp_tgt   = 1.0;
    }

    /// Install a phoneme sequence.  On each trigger the voice will step through
    /// these, giving each equal time within `hold_samps`.  If `hold_samps` is 0
    /// each phoneme gets 150 ms.
    pub fn set_queue(&mut self, phonemes: &[usize], hold_samps: usize) {
        self.queue.clear();
        if phonemes.is_empty() { return; }
        let per = if hold_samps == 0 {
            (0.15 * SR) as usize
        } else {
            (hold_samps / phonemes.len()).max(1)
        };
        for &ph in phonemes {
            self.queue.push(QueueEntry {
                phoneme:    ph.min(N_PHONEMES - 1),
                duration:   per,
                pitch_mult: 1.0,
                amp_mult:   1.0,
            });
        }
        self.queue_samps = 0;
        self.prime_first();
    }

    /// Install a timed phoneme sequence.  Parallel arrays: each phoneme gets
    /// its own duration (samples), pitch multiplier, and amp multiplier.
    /// Shorter arrays are padded with defaults (duration=150ms, pitch=1.0, amp=1.0).
    pub fn set_queue_detailed(
        &mut self,
        phonemes:  &[usize],
        durations: &[usize],
        pitches:   &[f32],
        amps:      &[f32],
    ) {
        self.queue.clear();
        if phonemes.is_empty() { return; }
        let default_dur = (0.15 * SR) as usize;
        for (i, &ph) in phonemes.iter().enumerate() {
            self.queue.push(QueueEntry {
                phoneme:    ph.min(N_PHONEMES - 1),
                duration:   durations.get(i).copied().unwrap_or(default_dur).max(1),
                pitch_mult: pitches.get(i).copied().unwrap_or(1.0).clamp(0.25, 4.0),
                amp_mult:   amps.get(i).copied().unwrap_or(1.0).clamp(0.0, 2.0),
            });
        }
        self.queue_samps = 0;
        self.prime_first();
    }

    fn prime_first(&mut self) {
        if let Some(&first) = self.queue.first() {
            self.set_phoneme(first.phoneme);
            self.pitch_tgt = first.pitch_mult;
            self.amp_tgt   = PHONEMES[first.phoneme].amp * first.amp_mult;
            // Snap formants to target instantly at note start (no glide from previous state)
            self.f_cur     = self.f_tgt;
            self.bw_cur    = self.bw_tgt;
            self.v_cur     = self.v_tgt;
            self.amp_cur   = self.amp_tgt;
            self.pitch_cur = self.pitch_tgt;
        }
    }

    pub fn process(&mut self, out: &mut [f32], p: &VoderParams) {
        if !self.active { return; }

        let n = out.len();

        // ── Advance phoneme queue ─────────────────────────────────────────────
        if !self.queue.is_empty() {
            let dur = self.queue[0].duration;
            self.queue_samps += n;
            if self.queue_samps >= dur {
                self.queue.remove(0);
                self.queue_samps = 0;
                if let Some(&next) = self.queue.first() {
                    self.set_phoneme(next.phoneme);
                    self.pitch_tgt = next.pitch_mult;
                    self.amp_tgt   = PHONEMES[next.phoneme].amp * next.amp_mult;
                } else {
                    // All phonemes consumed — trigger release
                    self.release();
                }
            }
        } else if self.held {
            // hold_samps countdown for simple trigger mode
            if self.queue_samps > 0 {
                if n >= self.queue_samps {
                    self.queue_samps = 0;
                    self.release();
                } else {
                    self.queue_samps -= n;
                }
            }
        }

        // ── Block-rate formant smoothing ──────────────────────────────────────
        //
        // Equivalent to running a one-pole filter for n_samples:
        //   y[k] = α·y[k-1] + (1-α)·target  →  after n steps:
        //   y_new = target + (y_old - target) · α^n
        //
        let tau_samps = (p.coartic_ms * 0.001 * SR).max(1.0);
        let alpha_n   = (-(n as f32) / tau_samps).exp();   // α^n
        for i in 0..3 {
            self.f_cur[i]  = self.f_tgt[i]  + (self.f_cur[i]  - self.f_tgt[i])  * alpha_n;
            self.bw_cur[i] = self.bw_tgt[i] + (self.bw_cur[i] - self.bw_tgt[i]) * alpha_n;
        }
        self.v_cur = self.v_tgt + (self.v_cur - self.v_tgt) * alpha_n;

        // Amp tracks phoneme changes with a faster time constant (~8ms) so stops
        // get a crisp attack/closure rather than a slow fade.  Pitch follows the
        // user's coarticulation setting (prosody glide).
        let amp_tau_samps = (0.008 * SR).max(1.0);
        let amp_alpha_n   = (-(n as f32) / amp_tau_samps).exp();
        self.amp_cur   = self.amp_tgt   + (self.amp_cur   - self.amp_tgt)   * amp_alpha_n;
        self.pitch_cur = self.pitch_tgt + (self.pitch_cur - self.pitch_tgt) * alpha_n;

        // Apply brightness scale to F1-F3 (F4/F5 are pre-computed fixed formants)
        let br = p.brightness.clamp(0.5, 1.5);

        // ── Coefficient update throttling ─────────────────────────────────────
        // F4/F5 biquad coefficients are pre-computed in new() and never change.
        // glot_lp only recomputes when brightness changes (stable mid-note).
        // F1-F3 biquads are updated every 4 blocks (~12 ms) — well above the
        // perceptual threshold given coartic_ms >= 5 ms defaults.
        self.coeff_block = self.coeff_block.wrapping_add(1);
        if self.coeff_block % 4 == 0 {
            let f_eff  = [self.f_cur[0] * br, self.f_cur[1] * br, self.f_cur[2] * br];
            let bw_eff = [self.bw_cur[0],      self.bw_cur[1],      self.bw_cur[2]];
            for i in 0..3 {
                self.resonators[i].set_bpf(f_eff[i], bw_eff[i], SR);
            }
        }

        // glot_lp: only call set_lpf1 when brightness actually changed
        if (br - self.last_br).abs() > 0.001 {
            self.last_br = br;
            self.glot_lp.set_lpf1(800.0 + 800.0 * br, SR);
        }

        // Effective voicing: phoneme's or manual override
        let voicing = if p.voicing_manual > 0.001 { p.voicing_manual } else { self.v_cur };

        // ── Sample loop ───────────────────────────────────────────────────────
        let vib_dt    = p.vibrato_rate / SR;
        let vib_cents = p.vibrato_depth;

        for s in out.iter_mut() {
            // Vibrato — modulates oscillator pitch
            let vib_mod = if vib_cents > 0.001 {
                self.vib_phase += vib_dt;
                if self.vib_phase >= 1.0 { self.vib_phase -= 1.0; }
                (self.vib_phase * core::f32::consts::TAU).sin() * vib_cents * (2.0f32.ln() / 1200.0)
            } else { 0.0 };
            let f_vib = self.freq_hz * self.pitch_cur * (vib_mod).exp();

            // Glottal source: PolyBLEP saw → spectral-tilt LP
            let glot_raw  = self.osc.next(f_vib, Waveform::Saw);
            let glot      = self.glot_lp.process(glot_raw);

            // Aspiration noise: white → one-pole HP (removes DC / low rumble)
            let white     = self.rng.next_f32();
            let hp_out    = white - self.noise_hp;
            self.noise_hp = self.noise_hp + 0.995 * hp_out;   // τ ≈ 200 Hz
            let noise     = hp_out * 0.5;                      // scale to similar rms as glottal

            // Mix by voicing
            let source    = voicing * glot + (1.0 - voicing) * noise;

            // Parallel formant bank
            let mut formant_sum = 0.0f32;
            for i in 0..5 {
                formant_sum += self.resonators[i].process(source) * GAINS[i];
            }

            // Amp envelope * per-phoneme amp (for stop closures / intonation)
            let amp    = self.env.process() * p.volume * self.amp_cur;
            *s        += formant_sum * amp;
        }

        if !self.env.is_active() {
            self.active = false;
        }
    }

    pub fn is_active(&self) -> bool { self.active }
    pub fn midi_note(&self) -> u8  { self.midi_note }
}

// ── VoderEngine ───────────────────────────────────────────────────────────────

pub struct VoderEngine {
    voices:     Vec<VoderVoice>,
    next_voice: usize,
    last_voice: usize,   // most recently triggered voice (for release())
    rng:        Rng,
}

impl VoderEngine {
    pub fn new(seed: u32) -> Self {
        let mut rng = Rng::new(seed);
        VoderEngine {
            voices:     (0..N_VOICES).map(|_| VoderVoice::new(rng.next_u32())).collect(),
            next_voice: 0,
            last_voice: 0,
            rng,
        }
    }

    pub fn trigger(&mut self, midi_note: u8, velocity: f32, hold_samps: usize, p: &VoderParams) {
        // Steal voice with same note first, then oldest free, then round-robin
        let idx = self.voices.iter().position(|v| v.is_active() && v.midi_note() == midi_note)
            .or_else(|| self.voices.iter().position(|v| !v.is_active()))
            .unwrap_or_else(|| {
                let v = self.next_voice;
                self.next_voice = (v + 1) % N_VOICES;
                v
            });
        self.last_voice = idx;
        self.voices[idx].trigger(midi_note, velocity * 0.5, hold_samps, p);
    }

    pub fn release(&mut self) {
        self.voices[self.last_voice].release();
    }

    pub fn set_phoneme(&mut self, idx: usize) {
        for v in self.voices.iter_mut() {
            v.set_phoneme(idx);
        }
    }

    pub fn set_xy(&mut self, x: f32, y: f32) {
        for v in self.voices.iter_mut() {
            v.set_xy(x, y);
        }
    }

    pub fn set_queue_for_last(&mut self, phonemes: &[usize], hold_samps: usize) {
        self.voices[self.last_voice].set_queue(phonemes, hold_samps);
    }

    pub fn set_queue_detailed_for_last(
        &mut self,
        phonemes:  &[usize],
        durations: &[usize],
        pitches:   &[f32],
        amps:      &[f32],
    ) {
        self.voices[self.last_voice].set_queue_detailed(phonemes, durations, pitches, amps);
    }

    pub fn process(&mut self, buf: &mut [f32], p: &VoderParams) {
        for v in self.voices.iter_mut() {
            if v.is_active() {
                v.process(buf, p);
            }
        }
    }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

fn midi_to_hz(note: u8) -> f32 {
    440.0 * 2.0f32.powf((note as f32 - 69.0) / 12.0)
}
