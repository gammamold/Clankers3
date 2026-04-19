/// Buchla 259/292 voice — simple triangle-wave pluck with wavefolding + LPF
///
/// ClankerBoy CC map (t:1):
///   CC74  LPF cutoff norm   (0-127 → 0-1)     sweet spot: 56 (0.44)
///   CC20  Wavefold amount   (0-127 → 0-1)      sweet spot: 37 (0.29)
///   CC19  Release time      (0-127 → 5-800 ms)

use crate::lpg::Lpg;
use crate::oscillator::{Oscillator, Waveform};
use crate::vactrol::Vactrol;
use crate::wavefolder::Wavefolder;

pub const DEFAULT_SR: f32 = 44100.0;

// Positional descriptor for host UIs. Stable order:
//   0 cutoff_norm, 1 fold_amount, 2 release_s, 3 filter_mod, 4 volume.
const PARAM_INFO_JSON: &str = concat!(
    "[",
    r#"{"idx":0,"name":"Cutoff","unit":"norm","min":0.0,"max":1.0,"default":0.44,"cc":74},"#,
    r#"{"idx":1,"name":"Wavefold","unit":"","min":0.0,"max":1.0,"default":0.29,"cc":20},"#,
    r#"{"idx":2,"name":"Release","unit":"s","min":0.005,"max":3.0,"default":0.18,"skew":"log","cc":19},"#,
    r#"{"idx":3,"name":"Filter Mod","unit":"","min":0.0,"max":1.0,"default":0.0,"cc":21},"#,
    r#"{"idx":4,"name":"Volume","unit":"","min":0.0,"max":1.0,"default":1.0,"cc":16}"#,
    "]",
);
const PARAM_INFO_C_BYTES: &[u8] = concat!(
    "[",
    r#"{"idx":0,"name":"Cutoff","unit":"norm","min":0.0,"max":1.0,"default":0.44,"cc":74},"#,
    r#"{"idx":1,"name":"Wavefold","unit":"","min":0.0,"max":1.0,"default":0.29,"cc":20},"#,
    r#"{"idx":2,"name":"Release","unit":"s","min":0.005,"max":3.0,"default":0.18,"skew":"log","cc":19},"#,
    r#"{"idx":3,"name":"Filter Mod","unit":"","min":0.0,"max":1.0,"default":0.0,"cc":21},"#,
    r#"{"idx":4,"name":"Volume","unit":"","min":0.0,"max":1.0,"default":1.0,"cc":16}"#,
    "]\0",
).as_bytes();

#[derive(Clone, Copy)]
pub struct BuchlaParams {
    pub cutoff_norm: f32,   // CC74 / 127  — base LPF ceiling
    pub fold_amount: f32,   // CC20 / 127
    pub release_s:   f32,   // seconds
    pub filter_mod:  f32,   // CC21 / 127  — env sweeps cutoff toward 1.0
    pub volume:      f32,
}

impl Default for BuchlaParams {
    fn default() -> Self {
        BuchlaParams {
            cutoff_norm: 0.44,
            fold_amount: 0.29,
            release_s:   0.18,
            filter_mod:  0.0,
            volume:      1.0,
        }
    }
}

impl BuchlaParams {
    pub const PARAM_INFO:   &'static str   = PARAM_INFO_JSON;
    pub const PARAM_INFO_C: &'static [u8]  = PARAM_INFO_C_BYTES;

    /// Set one param by positional index (see `PARAM_INFO`). Out-of-range
    /// indices are ignored. Values are clamped to the declared range.
    pub fn set_param(&mut self, idx: u32, value: f32) {
        match idx {
            0 => self.cutoff_norm = value.clamp(0.0, 1.0),
            1 => self.fold_amount = value.clamp(0.0, 1.0),
            2 => self.release_s   = value.clamp(0.005, 3.0),
            3 => self.filter_mod  = value.clamp(0.0, 1.0),
            4 => self.volume      = value.clamp(0.0, 1.0),
            _ => {}
        }
    }
}

pub struct BuchlaVoice {
    osc:     Oscillator,
    lpg:     Lpg,
    vactrol: Vactrol,
    gate:    f32,
    freq:    f32,
    active:  bool,
}

impl BuchlaVoice {
    pub fn new(sr: f32) -> Self {
        BuchlaVoice {
            osc:     Oscillator::new(sr),
            lpg:     Lpg::new(sr),
            vactrol: Vactrol::new(sr),
            gate:    0.0,
            freq:    440.0,
            active:  false,
        }
    }

    pub fn set_sample_rate(&mut self, sr: f32) {
        self.osc     = Oscillator::new(sr);
        self.lpg     = Lpg::new(sr);
        self.vactrol = Vactrol::new(sr);
        self.gate    = 0.0;
        self.active  = false;
    }

    pub fn trigger(&mut self, midi_note: u8, velocity: f32, p: &BuchlaParams) {
        self.freq      = midi_to_hz(midi_note);
        self.osc.level = velocity * p.volume;

        self.vactrol.set_times(0.001, p.release_s);
        let fire_level = 0.4 + p.cutoff_norm * 0.6; // 0.4..1.0
        self.vactrol.fire_at(fire_level);
        self.gate   = 0.0;
        self.active = true;
    }

    pub fn process(&mut self, out: &mut [f32], p: &BuchlaParams) {
        for s in out.iter_mut() {
            if !self.active { break; }

            let cv  = self.vactrol.process(self.gate);
            self.gate = 0.0;

            // Triangle oscillator → wavefolder → LPG
            let osc_out = self.osc.next(self.freq, Waveform::Triangle);
            let folded  = Wavefolder::process(osc_out, p.fold_amount);

            // Env-driven filter mod: CV sweeps cutoff toward 1.0 by filter_mod amount
            let headroom  = 1.0 - p.cutoff_norm;
            let eff_cutoff = (p.cutoff_norm + p.filter_mod * cv * headroom).clamp(0.0, 0.999);
            let out_s   = self.lpg.process(folded, cv, eff_cutoff, 0.0);

            if self.vactrol.is_idle() {
                self.active = false;
            }

            *s += out_s;
        }
    }

    pub fn is_active(&self) -> bool { self.active }
}

pub struct BuchlaEngine {
    voices:     Vec<BuchlaVoice>,
    next_voice: usize,
}

impl BuchlaEngine {
    pub fn new() -> Self { Self::new_with_sr(DEFAULT_SR) }

    pub fn new_with_sr(sr: f32) -> Self {
        BuchlaEngine {
            voices:     (0..8).map(|_| BuchlaVoice::new(sr)).collect(),
            next_voice: 0,
        }
    }

    pub fn set_sample_rate(&mut self, sr: f32) {
        for v in self.voices.iter_mut() { v.set_sample_rate(sr); }
    }

    pub fn trigger(&mut self, midi_note: u8, velocity: f32, p: &BuchlaParams) {
        let idx = (0..self.voices.len())
            .find(|&i| !self.voices[i].is_active())
            .unwrap_or_else(|| {
                let v = self.next_voice;
                self.next_voice = (v + 1) % self.voices.len();
                v
            });
        self.voices[idx].trigger(midi_note, velocity, p);
    }

    pub fn process(&mut self, buf: &mut [f32], p: &BuchlaParams) {
        for v in self.voices.iter_mut() {
            if v.is_active() { v.process(buf, p); }
        }
    }
}

#[inline]
fn midi_to_hz(note: u8) -> f32 {
    440.0 * 2.0_f32.powf((note as f32 - 69.0) / 12.0)
}
