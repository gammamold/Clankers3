//! Shared CC-JSON parsing used by both the WASM bindings (`wasm.rs`) and the
//! native C ABI (`ffi.rs`). Kept in its own module so the two surfaces can
//! share one implementation — `wasm` and non-`wasm32` builds never co-compile,
//! so a third, always-built module is the only place they can meet.
//!
//! Functions here are `pub(crate)` — not part of the public Rust API.

#![allow(dead_code)] // parsers become "used" as each engine gets its C ABI wrapper

use crate::bass::BassParams;
use crate::buchla::BuchlaParams;
use crate::pads::PadsParams;
use crate::rhodes::RhodesParams;
use crate::voder::VoderParams;

/// Parse a flat JSON CC object like `{"74": 80, "71": 60}`
/// into a list of `(cc_number, value)` pairs. Malformed pairs are skipped.
pub(crate) fn parse_cc_map(s: &str) -> Vec<(u8, f32)> {
    let mut out = Vec::new();
    let s = s.trim().trim_start_matches('{').trim_end_matches('}');
    for pair in s.split(',') {
        let mut parts = pair.splitn(2, ':');
        let k = parts.next().unwrap_or("").trim().trim_matches('"').trim();
        let v = parts.next().unwrap_or("").trim().trim_matches('"').trim();
        if let (Ok(kn), Ok(vf)) = (k.parse::<u8>(), v.parse::<f32>()) {
            out.push((kn, vf));
        }
    }
    out
}

/// Parse a JSON integer array like `"[0,8,2,11]"` into a `Vec<usize>`.
pub(crate) fn parse_usize_array(s: &str) -> Vec<usize> {
    let mut out = Vec::new();
    let s = s.trim().trim_start_matches('[').trim_end_matches(']');
    for tok in s.split(',') {
        if let Ok(n) = tok.trim().parse::<usize>() {
            out.push(n);
        }
    }
    out
}

/// Parse a JSON float array like `"[1.0, 1.06, 1.12]"` into a `Vec<f32>`.
pub(crate) fn parse_float_array(s: &str) -> Vec<f32> {
    let mut out = Vec::new();
    let s = s.trim().trim_start_matches('[').trim_end_matches(']');
    for tok in s.split(',') {
        if let Ok(f) = tok.trim().parse::<f32>() {
            out.push(f);
        }
    }
    out
}

pub(crate) fn parse_bass_params(cc_json: &str) -> BassParams {
    let mut p = BassParams::default();
    for (key, val) in parse_cc_map(cc_json) {
        let n = val / 127.0;
        match key {
            71 => p.fm_index    = n * 8.0,
            74 => p.cutoff_norm = n,
            23 => p.flt_decay   = 0.01 + n * 0.99,
            75 => p.amp_decay   = 0.01 + n * 1.99,
            _  => {}
        }
    }
    p
}

pub(crate) fn parse_buchla_params(cc_json: &str) -> BuchlaParams {
    let mut p = BuchlaParams::default();
    for (key, val) in parse_cc_map(cc_json) {
        let n = val / 127.0;
        match key {
            74 => p.cutoff_norm = n,
            20 => p.fold_amount = n,
            19 => p.release_s   = 0.005 + n * 2.995,
            21 => p.filter_mod  = n,
            16 => p.volume      = n,
            _  => {}
        }
    }
    p
}

pub(crate) fn parse_rhodes_params(cc_json: &str) -> RhodesParams {
    let mut p = RhodesParams::default();
    for (key, val) in parse_cc_map(cc_json) {
        let n = val / 127.0;
        match key {
            74 => p.brightness    = 0.5 + n.sqrt() * 4.35,
            72 => p.amp_decay     = 0.5 + n * 5.5,
            20 => p.harm_ratio    = if val < 43.0 { 1.0 } else if val < 85.0 { 1.5 } else { 2.0 },
            73 => p.mod_decay     = 0.02 + n * 0.58,
            55 => p.key_scale     = n,
            26 => p.tremolo_rate  = n * 9.0,
            27 => p.tremolo_depth = n * 0.8,
            29 => p.chorus_rate   = 0.1 + n * 4.9,
            30 => p.chorus_mix    = n * 0.85,
            10 => p.pan           = n,
            _  => {}
        }
    }
    p
}

pub(crate) fn parse_pads_params(cc_json: &str) -> PadsParams {
    let mut p = PadsParams::default();
    for (key, val) in parse_cc_map(cc_json) {
        let n = val / 127.0;
        match key {
            74 => p.cutoff_hz    = 20.0 + n * 7980.0,
            71 => p.resonance    = n * 0.9,
            73 => p.amp_attack   = 0.05 + n * 3.95,
            75 => p.amp_decay    = 0.05 + n * 1.95,
            79 => p.amp_sustain  = n,
            72 => p.amp_release  = 0.1  + n * 3.9,
            88 => p.reverb_size  = n,
            91 => p.reverb_mix   = n,
            29 => p.chorus_rate  = 0.1  + n * 4.9,
            30 => p.chorus_depth = n,
            31 => p.chorus_mix   = n,
            _  => {}
        }
    }
    p
}

pub(crate) fn parse_voder_params(cc_json: &str) -> VoderParams {
    let mut p = VoderParams::default();
    for (key, val) in parse_cc_map(cc_json) {
        let n = val / 127.0;
        match key {
            74 => p.brightness     = 0.5 + n,
            20 => p.voicing_manual = n,
            73 => p.attack_s       = 0.001 + n * 0.099,
            72 => p.release_s      = 0.01  + n * 0.49,
            75 => p.vibrato_depth  = n * 0.667,
            76 => p.vibrato_rate   = 3.0   + n * 5.0,
            77 => p.coartic_ms     = 5.0   + n * 75.0,
            16 => p.volume         = n,
            _  => {}
        }
    }
    p
}
