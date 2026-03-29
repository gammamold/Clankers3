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

const SR: f32 = 44100.0;

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

pub struct BuchlaVoice {
    osc:     Oscillator,
    lpg:     Lpg,
    vactrol: Vactrol,
    gate:    f32,
    freq:    f32,
    active:  bool,
}

impl BuchlaVoice {
    pub fn new() -> Self {
        BuchlaVoice {
            osc:     Oscillator::new(SR),
            lpg:     Lpg::new(SR),
            vactrol: Vactrol::new(SR),
            gate:    0.0,
            freq:    440.0,
            active:  false,
        }
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
    pub fn new() -> Self {
        BuchlaEngine {
            voices:     (0..8).map(|_| BuchlaVoice::new()).collect(),
            next_voice: 0,
        }
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
