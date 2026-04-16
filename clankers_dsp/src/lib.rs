mod bass;
mod biquad;
mod buchla;
mod chorus;
mod delay;
mod drums;
mod envelope;
mod graph;
mod lpg;
mod moog_ladder;
mod ms20_filter;
mod oscillator;
mod pads;
mod reverb;
mod rhodes;
mod rng;
mod tpt_ladder;
mod vactrol;
mod voder;
mod wavefolder;

use bass::{BassEngine, BassParams};
use buchla::{BuchlaEngine, BuchlaParams};
use drums::DrumsEngine;
use graph::engine::{SynthGraph, GraphFx};
use pads::{PadsEngine, PadsParams};
use rhodes::{RhodesEngine, RhodesParams};
use js_sys::Float32Array;
use wasm_bindgen::prelude::*;

// ── Drums ─────────────────────────────────────────────────────────────────────

/// Three-profile synth drum machine (808 / 909 / 606).
///
/// Voice IDs  0-6 — character depends on selected profile:
///   808 →  KICK  SNARE  HH-CL  HH-OP  TOM-L  TOM-H  CLAP
///   909 →  KICK  SNARE  HH-CL  HH-OP  TOM-L  TOM-M  TOM-H
///   606 →  KICK  SNARE  HH-CL  HH-OP  TOM-L  TOM-H  CYMBAL
///
/// Global controls (all live — take effect within one audio block):
///   set_profile(id)        0=808  1=909  2=606
///   set_pitch(semitones)   −12..+12
///   set_decay(mult)        0.1..8.0  (scales all amp-decay times)
///   set_filter(hz)         80..20000 (one-pole LP on output bus)
#[wasm_bindgen]
pub struct ClankersDrums {
    engine: DrumsEngine,
}

#[wasm_bindgen]
impl ClankersDrums {
    #[wasm_bindgen(constructor)]
    pub fn new(seed: u32) -> ClankersDrums {
        ClankersDrums { engine: DrumsEngine::new(seed) }
    }

    /// Select drum machine profile.  id: 0=808  1=909  2=606
    pub fn set_profile(&mut self, id: u8) { self.engine.set_profile(id); }

    /// Global pitch shift in semitones (−12..+12).
    pub fn set_pitch(&mut self, semitones: f32) { self.engine.set_pitch(semitones); }

    /// Global decay multiplier (0.1..8.0). Updates active voices immediately.
    pub fn set_decay(&mut self, mult: f32) { self.engine.set_decay(mult); }

    /// Global output lowpass cutoff in Hz (80..20000). Live.
    pub fn set_filter(&mut self, hz: f32) { self.engine.set_filter(hz); }

    /// Trigger a voice.  voice_id: 0-6.
    pub fn trigger(&mut self, voice_id: u8, velocity: f32) {
        self.engine.trigger(voice_id, velocity);
    }

    /// Render n_samples. Returns mono Float32Array.
    pub fn process(&mut self, n_samples: u32) -> Float32Array {
        let n = n_samples as usize;
        let mut buf = vec![0.0f32; n];
        self.engine.process(&mut buf);
        Float32Array::from(buf.as_slice())
    }
}

// ── Bass ──────────────────────────────────────────────────────────────────────

/// FM bass — sine carrier + sine modulator + TPT ladder LPF + pluck envelopes (8 voices).
///
/// YZ pad CC map (t:2):
///   CC71 fm_index   CC74 cutoff   CC23 flt_decay   CC75 amp_decay
///
/// Streaming API:
///   set_params(cc_json)              — update stored params (affects playing voices live)
///   trigger(midi_note, vel, hold, cc_json) — trigger note (also updates stored params)
///   render(n_samples)               — process all active voices with stored params
///
/// Offline API:
///   trigger_render(...)             — trigger + render full tail in one call
#[wasm_bindgen]
pub struct ClankersBass {
    engine: BassEngine,
    params: BassParams,
}

#[wasm_bindgen]
impl ClankersBass {
    #[wasm_bindgen(constructor)]
    pub fn new(seed: u32) -> ClankersBass {
        ClankersBass { engine: BassEngine::new(seed), params: BassParams::default() }
    }

    /// Update stored params — affects currently playing voices on the next render() call.
    pub fn set_params(&mut self, cc_json: &str) {
        self.params = parse_bass_params(cc_json);
    }

    /// Trigger a note. Also updates stored params from cc_json.
    /// hold_samples: note-on duration in samples (0 = use amp envelope only)
    pub fn trigger(&mut self, midi_note: u8, velocity: f32, hold_samples: u32, cc_json: &str) {
        self.params = parse_bass_params(cc_json);
        self.engine.trigger(midi_note, velocity, hold_samples as usize, &self.params);
    }

    /// Render n_samples of audio using stored params. Returns mono Float32Array.
    pub fn render(&mut self, n_samples: u32) -> Float32Array {
        let n = n_samples as usize;
        let mut buf = vec![0.0f32; n];
        self.engine.process(&mut buf, &self.params);
        Float32Array::from(buf.as_slice())
    }

    /// Trigger + render full tail — isolated single voice, no shared state.
    pub fn trigger_render(&mut self, midi_note: u8, velocity: f32, hold_samples: u32, cc_json: &str) -> Float32Array {
        let p = parse_bass_params(cc_json);

        let mut voice = bass::BassVoice::new(0xba55);
        let transposed = midi_note.saturating_add(48);
        voice.trigger(transposed, velocity, hold_samples as usize, &p);

        let max = 44100 * 4;
        let mut buf = vec![0.0f32; max];
        voice.process(&mut buf, &p);

        let end = buf.iter()
            .rposition(|&s| s.abs() > 1e-5)
            .map(|i| (i + 441).min(max))
            .unwrap_or(1024);

        Float32Array::from(&buf[..end])
    }
}

// ── CC JSON → BassParams ──────────────────────────────────────────────────────

fn parse_bass_params(cc_json: &str) -> BassParams {
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

// ── Buchla ────────────────────────────────────────────────────────────────────

/// Buchla 259/292 — percussive LPG arp with FM + wavefolding (8 voices).
///
/// ClankerBoy CC map (t:1):
///   CC74 cutoff  CC71 resonance  CC20 wavefold  CC17 fm_depth
///   CC18 fm_index  CC19 env_decay  CC16 volume
///
/// Streaming API:
///   set_params(cc_json)    — update stored params (affects playing voices live)
///   trigger(midi_note, vel) — trigger using stored params
///   process(n_samples)     — render all active voices → mono Float32Array
#[wasm_bindgen]
pub struct ClankersBuchla {
    engine: BuchlaEngine,
    params: BuchlaParams,
}

#[wasm_bindgen]
impl ClankersBuchla {
    #[wasm_bindgen(constructor)]
    pub fn new() -> ClankersBuchla {
        ClankersBuchla { engine: BuchlaEngine::new(), params: BuchlaParams::default() }
    }

    /// Update stored params — affects playing voices on the next process() call.
    pub fn set_params(&mut self, cc_json: &str) {
        self.params = parse_buchla_params(cc_json);
    }

    /// Trigger a voice using stored params.
    pub fn trigger(&mut self, midi_note: u8, velocity: f32) {
        self.engine.trigger(midi_note, velocity, &self.params);
    }

    /// Render n_samples of audio. Returns mono Float32Array.
    pub fn process(&mut self, n_samples: u32) -> Float32Array {
        let n = n_samples as usize;
        let mut buf = vec![0.0f32; n];
        self.engine.process(&mut buf, &self.params);
        Float32Array::from(buf.as_slice())
    }

    /// Trigger + render full tail — isolated single voice.
    pub fn trigger_render(&mut self, midi_note: u8, velocity: f32, cc_json: &str) -> Float32Array {
        let p = parse_buchla_params(cc_json);

        let mut voice = buchla::BuchlaVoice::new();
        voice.trigger(midi_note, velocity, &p);

        let max = 44100 * 3;
        let mut buf = vec![0.0f32; max];
        voice.process(&mut buf, &p);

        let end = buf.iter()
            .rposition(|&s| s.abs() > 1e-5)
            .map(|i| (i + 441).min(max))
            .unwrap_or(1024);

        Float32Array::from(&buf[..end])
    }
}

// ── Rhodes ───────────────────────────────────────────────────────────────────

/// Rhodes electric piano — FM tine model (Operator / Lounge Lizard style).
///
/// ClankerBoy t:3 CC map:
///   CC74  Brightness  CC72  Decay  CC20  Tine ratio  CC73  Bark time
///   CC26  Tremolo rate  CC27  Tremolo depth
///   CC29  Chorus rate   CC30  Chorus mix   CC10  Pan
///
/// Streaming API:
///   set_params(cc_json)               — update stored params live
///   trigger(midi_note, vel, hold)     — trigger using stored params
///   process_stereo(n_samples)         — render → interleaved stereo Float32Array
#[wasm_bindgen]
pub struct ClankersRhodes {
    engine: RhodesEngine,
    params: RhodesParams,
}

#[wasm_bindgen]
impl ClankersRhodes {
    #[wasm_bindgen(constructor)]
    pub fn new() -> ClankersRhodes {
        ClankersRhodes { engine: RhodesEngine::new(), params: RhodesParams::default() }
    }

    /// Update stored params — affects playing voices live on the next process_stereo() call.
    pub fn set_params(&mut self, cc_json: &str) {
        self.params = parse_rhodes_params(cc_json);
    }

    /// Trigger a note using stored params.
    /// hold_samples: note-on duration in samples.
    pub fn trigger(&mut self, midi_note: u8, velocity: f32, hold_samples: u32) {
        self.engine.trigger(midi_note, velocity, hold_samples as usize, &self.params);
    }

    /// Render n_samples. Returns interleaved stereo Float32Array [L0,R0,L1,R1,...].
    pub fn process_stereo(&mut self, n_samples: u32) -> Float32Array {
        let n = n_samples as usize;
        let mut buf_l = vec![0.0f32; n];
        let mut buf_r = vec![0.0f32; n];
        self.engine.process(&mut buf_l, &mut buf_r, &self.params);
        let mut out = vec![0.0f32; n * 2];
        for i in 0..n { out[i * 2] = buf_l[i]; out[i * 2 + 1] = buf_r[i]; }
        Float32Array::from(out.as_slice())
    }

    /// Trigger + render full tail — stereo interleaved Float32Array.
    pub fn trigger_render(
        &mut self,
        midi_note:    u8,
        velocity:     f32,
        hold_samples: u32,
        cc_json:      &str,
    ) -> Float32Array {
        let p    = parse_rhodes_params(cc_json);
        let hold = hold_samples as usize;

        let amp_decay_s  = p.amp_decay * (1.0 - (midi_note as f32 - 60.0) * p.key_scale / 48.0).clamp(0.25, 2.5);
        let tail_samples = (amp_decay_s * 6.0 * 44100.0) as usize;
        let total        = hold + tail_samples;

        let mut buf_l = vec![0.0f32; total];
        let mut buf_r = vec![0.0f32; total];

        let mut voice = rhodes::RhodesVoice::new();
        voice.trigger(midi_note, velocity, hold, &p);
        voice.process(&mut buf_l, &mut buf_r, &p);

        let end = buf_l.iter().zip(buf_r.iter())
            .rposition(|(&l, &r)| l.abs() > 1e-5 || r.abs() > 1e-5)
            .map(|i| (i + 441).min(total))
            .unwrap_or(1024);

        let mut interleaved = vec![0.0f32; end * 2];
        for i in 0..end {
            interleaved[i * 2]     = buf_l[i];
            interleaved[i * 2 + 1] = buf_r[i];
        }

        Float32Array::from(interleaved.as_slice())
    }
}

fn parse_rhodes_params(cc_json: &str) -> RhodesParams {
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

// ── Pads ──────────────────────────────────────────────────────────────────────

/// HybridSynth pads — Moog ladder + ADSR + chorus + reverb (8 polyphonic voices).
///
/// Streaming API:
///   set_params(cc_json)              — update stored params live
///   trigger(midi_note, vel, hold)    — trigger using stored params
///   process_stereo(n_samples)        — render → interleaved stereo Float32Array
#[wasm_bindgen]
pub struct ClankersPads {
    engine: PadsEngine,
    params: PadsParams,
}

#[wasm_bindgen]
impl ClankersPads {
    #[wasm_bindgen(constructor)]
    pub fn new() -> ClankersPads {
        ClankersPads { engine: PadsEngine::new(), params: PadsParams::default() }
    }

    /// Update stored params — affects playing voices live on next process_stereo() call.
    pub fn set_params(&mut self, cc_json: &str) {
        self.params = parse_pads_params(cc_json);
    }

    /// Trigger a note using stored params.
    pub fn trigger(&mut self, midi_note: u8, velocity: f32, hold_samples: u32) {
        self.engine.trigger(midi_note, velocity, hold_samples as usize, &self.params);
    }

    /// Render n_samples. Returns interleaved stereo Float32Array [L0,R0,L1,R1,...].
    pub fn process_stereo(&mut self, n_samples: u32) -> Float32Array {
        let n = n_samples as usize;
        let mut buf_l = vec![0.0f32; n];
        let mut buf_r = vec![0.0f32; n];
        self.engine.process(&mut buf_l, &mut buf_r, &self.params);
        let mut out = vec![0.0f32; n * 2];
        for i in 0..n { out[i * 2] = buf_l[i]; out[i * 2 + 1] = buf_r[i]; }
        Float32Array::from(out.as_slice())
    }

    pub fn trigger_render(
        &mut self,
        midi_note:    u8,
        velocity:     f32,
        hold_samples: u32,
        cc_json:      &str,
    ) -> Float32Array {
        let p    = parse_pads_params(cc_json);
        let hold = hold_samples as usize;

        let release_tail = (p.amp_release * 44100.0) as usize + 4410;
        let total        = hold + release_tail;

        let mut buf_l = vec![0.0f32; total];
        let mut buf_r = vec![0.0f32; total];

        let mut voice = pads::PadsVoice::new();
        voice.trigger(midi_note, velocity, hold, &p);
        voice.process(&mut buf_l, &mut buf_r, &p);

        let end = buf_l.iter().zip(buf_r.iter())
            .rposition(|(&l, &r)| l.abs() > 1e-5 || r.abs() > 1e-5)
            .map(|i| (i + 441).min(total))
            .unwrap_or(1024);

        let mut interleaved = vec![0.0f32; end * 2];
        for i in 0..end {
            interleaved[i * 2]     = buf_l[i];
            interleaved[i * 2 + 1] = buf_r[i];
        }

        Float32Array::from(interleaved.as_slice())
    }
}

fn parse_pads_params(cc_json: &str) -> PadsParams {
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

fn parse_buchla_params(cc_json: &str) -> BuchlaParams {
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

/// Parse a flat JSON CC object: {"74": 80, "71": 60} → [(74, 80.0), (71, 60.0)]
fn parse_cc_map(s: &str) -> Vec<(u8, f32)> {
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

// ── Voder ─────────────────────────────────────────────────────────────────────

use voder::{VoderEngine, VoderParams};

/// Parallel-formant Voder — 4-voice polyphonic formant synthesizer.
///
/// Inspired by the 1939 Bell Laboratories Voder.  Glottal pulse + aspiration
/// noise drive a bank of 5 parallel biquad resonators whose centre frequencies
/// interpolate smoothly between phoneme targets (coarticulation).
///
/// Phoneme indices (0-24):
///   0 AA   1 AE   2 AH   3 AO   4 EH   5 ER   6 EY   7 IH   8 IY
///   9 OW  10 UH  11 UW  12 L   13 R   14 W   15 Y   16 M   17 N
///  18 F   19 S   20 SH  21 TH  22 V   23 Z   24 ZH
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
///
/// Streaming API:
///   set_params(cc_json)
///   set_phoneme(idx)                   — change formant target live
///   set_phonemes(json_array)           — "[0,8,11]" phoneme sequence
///   set_xy(x, y)                       — vowel-pad mode (0..1 each axis)
///   trigger(midi_note, vel, hold_samps, cc_json)
///   release()                          — note-off for sustained voices
///   process(n_samples)                 — render mono Float32Array
///   phoneme_count()                    — returns 25
#[wasm_bindgen]
pub struct ClankersVoder {
    engine: VoderEngine,
    params: VoderParams,
}

#[wasm_bindgen]
impl ClankersVoder {
    #[wasm_bindgen(constructor)]
    pub fn new(seed: u32) -> ClankersVoder {
        ClankersVoder { engine: VoderEngine::new(seed), params: VoderParams::default() }
    }

    /// Update stored params from CC JSON object.
    pub fn set_params(&mut self, cc_json: &str) {
        self.params = parse_voder_params(cc_json);
    }

    /// Set the active phoneme target (0-24).  All voices interpolate toward it.
    pub fn set_phoneme(&mut self, idx: u8) {
        self.engine.set_phoneme(idx as usize);
    }

    /// Set a phoneme sequence from a JSON integer array, e.g. "[0,8,2,11]".
    /// The last triggered voice will step through the sequence over its hold duration.
    pub fn set_phonemes(&mut self, json: &str, hold_samps: u32) {
        let phonemes = parse_phoneme_array(json);
        self.engine.set_queue_for_last(&phonemes, hold_samps as usize);
    }

    /// Vowel-pad mode: x=F1 axis (0=high/closed..1=low/open),
    /// y=F2 axis (0=back..1=front).  All voices update live.
    pub fn set_xy(&mut self, x: f32, y: f32) {
        self.engine.set_xy(x, y);
    }

    /// Trigger a note.  Also updates params from cc_json.
    /// hold_samples: note-on duration in samples (0 = sustain until release()).
    pub fn trigger(&mut self, midi_note: u8, velocity: f32, hold_samples: u32, cc_json: &str) {
        self.params = parse_voder_params(cc_json);
        self.engine.trigger(midi_note, velocity, hold_samples as usize, &self.params);
    }

    /// Send note-off to the most recently triggered voice.
    pub fn release(&mut self) {
        self.engine.release();
    }

    /// Render n_samples of audio.  Returns mono Float32Array.
    pub fn process(&mut self, n_samples: u32) -> Float32Array {
        let n = n_samples as usize;
        let mut buf = vec![0.0f32; n];
        self.engine.process(&mut buf, &self.params);
        Float32Array::from(buf.as_slice())
    }

    /// Number of phonemes in the built-in table (25).
    pub fn phoneme_count() -> u32 {
        voder::N_PHONEMES as u32
    }
}

fn parse_voder_params(cc_json: &str) -> VoderParams {
    let mut p = VoderParams::default();
    for (key, val) in parse_cc_map(cc_json) {
        let n = val / 127.0;
        match key {
            74 => p.brightness     = 0.5 + n,                      // 0.5..1.5
            20 => p.voicing_manual = n,                             // 0..1
            73 => p.attack_s       = 0.001 + n * 0.099,            // 1..100 ms
            72 => p.release_s      = 0.01  + n * 0.49,             // 10..500 ms
            75 => p.vibrato_depth  = n * 0.667,                     // 0..0.667 semitones (~80 cents)
            76 => p.vibrato_rate   = 3.0   + n * 5.0,              // 3..8 Hz
            77 => p.coartic_ms     = 5.0   + n * 75.0,             // 5..80 ms
            16 => p.volume         = n,
            _  => {}
        }
    }
    p
}

/// Parse a JSON integer array like "[0,8,2,11]" into a Vec<usize>.
fn parse_phoneme_array(s: &str) -> Vec<usize> {
    let mut out = Vec::new();
    let s = s.trim().trim_start_matches('[').trim_end_matches(']');
    for tok in s.split(',') {
        let tok = tok.trim();
        if let Ok(n) = tok.parse::<usize>() {
            out.push(n);
        }
    }
    out
}

// ── SynthGraph ───────────────────────────────────────────────────────────────

/// Graph-based modular synth — LLM designs the signal chain, WASM executes it.
///
/// The LLM outputs a JSON graph describing nodes (oscillators, filters, envelopes,
/// effects) and connections between them. This engine instantiates the graph as
/// a polyphonic instrument with per-sample processing.
///
/// Streaming API:
///   set_param(param_index, value)          — update a parameter live
///   trigger(midi_note, vel, hold_samples)  — trigger a voice
///   process_stereo(n_samples)              — render → interleaved stereo Float32Array
///   param_info()                           — JSON array of param descriptors
///   param_count()                          — number of tweakable params
#[wasm_bindgen]
pub struct ClankersSynthGraph {
    engine: SynthGraph,
}

#[wasm_bindgen]
impl ClankersSynthGraph {
    /// Construct from graph JSON + number of polyphonic voices (1-16).
    #[wasm_bindgen(constructor)]
    pub fn new(graph_json: &str, num_voices: u8) -> Result<ClankersSynthGraph, JsError> {
        SynthGraph::new(graph_json, num_voices)
            .map(|engine| ClankersSynthGraph { engine })
            .map_err(|e| JsError::new(&e))
    }

    /// Update a parameter by flat index (see param_info for the mapping).
    pub fn set_param(&mut self, param_index: u32, value: f32) {
        self.engine.set_param(param_index as usize, value);
    }

    /// Trigger a note. hold_samples: note-on duration in samples (0 = use envelope only).
    pub fn trigger(&mut self, midi_note: u8, velocity: f32, hold_samples: u32) {
        self.engine.trigger(midi_note, velocity, hold_samples);
    }

    /// Render n_samples. Returns interleaved stereo Float32Array [L0,R0,L1,R1,...].
    pub fn process_stereo(&mut self, n_samples: u32) -> Float32Array {
        let buf = self.engine.process_stereo(n_samples as usize);
        Float32Array::from(buf.as_slice())
    }

    /// Returns JSON array of param descriptors:
    /// [{"index":0,"node":"osc1","param":"waveform","min":0,"max":4,"default":0}, ...]
    pub fn param_info(&self) -> String {
        self.engine.param_info_json()
    }

    /// Number of tweakable parameters.
    pub fn param_count(&self) -> u32 {
        self.engine.param_count() as u32
    }
}

// ── GraphFx ──────────────────────────────────────────────────────────────────

/// Graph-based FX processor — continuous audio processing (no voices/MIDI).
///
/// The LLM designs an FX chain using the same node types as SynthGraph, but with
/// an "input" node that receives external audio and an "output" node that emits it.
/// Instruments route audio to this FX via send buses (parallel aux sends).
///
/// Streaming API:
///   set_param(param_index, value)                    — update a parameter live
///   process_stereo(input_buf, n_samples)             — process input → output
///   param_info()                                     — JSON array of param descriptors
///   param_count()                                    — number of tweakable params
#[wasm_bindgen]
pub struct ClankersGraphFx {
    engine: GraphFx,
}

#[wasm_bindgen]
impl ClankersGraphFx {
    /// Construct from FX graph JSON. Must contain "input" and "output" nodes.
    #[wasm_bindgen(constructor)]
    pub fn new(graph_json: &str) -> Result<ClankersGraphFx, JsError> {
        GraphFx::new(graph_json)
            .map(|engine| ClankersGraphFx { engine })
            .map_err(|e| JsError::new(&e))
    }

    pub fn set_param(&mut self, param_index: u32, value: f32) {
        self.engine.set_param(param_index as usize, value);
    }

    /// Process interleaved stereo input → interleaved stereo output.
    /// input_buf: [L0,R0,L1,R1,...] — n_samples * 2 floats.
    pub fn process_stereo(&mut self, input_buf: &[f32], n_samples: u32) -> Float32Array {
        let buf = self.engine.process_stereo(input_buf, n_samples as usize);
        Float32Array::from(buf.as_slice())
    }

    pub fn param_info(&self) -> String {
        self.engine.param_info_json()
    }

    pub fn param_count(&self) -> u32 {
        self.engine.param_count() as u32
    }
}
