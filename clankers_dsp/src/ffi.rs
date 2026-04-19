//! C ABI for native consumers (JUCE, VST, CLI tools).
//!
//! Excluded from WASM builds — `wasm-bindgen` provides the JS surface there.
//! Matches the hand-written header `clankers_dsp.h` shipped at the crate root.
//!
//! Conventions:
//!   - Constructors return an owning `*mut T`; caller must pair with `_free`.
//!   - All pointers are assumed non-null and well-aligned unless noted.
//!   - `process` functions write exactly `n_samples` floats (mono) or
//!     `n_samples * 2` interleaved floats (stereo).
//!   - No allocation in the audio path — buffers are caller-owned.
//!
//! Thread safety: each engine instance is single-threaded. Call audio-rate
//! methods (`trigger`, `process`) from the audio thread; control-rate methods
//! (`set_*`) can be called from another thread only if the consumer provides
//! its own synchronisation. No internal locking.

use crate::bass::{BassEngine, BassParams};
use crate::buchla::{BuchlaEngine, BuchlaParams};
use crate::cc::{
    parse_bass_params, parse_buchla_params, parse_pads_params, parse_rhodes_params,
    parse_usize_array, parse_float_array, parse_voder_params,
};
use crate::drums::DrumsEngine;
use crate::pads::{PadsEngine, PadsParams};
use crate::rhodes::{RhodesEngine, RhodesParams};
use crate::voder::{self, VoderEngine, VoderParams};
use core::ffi::c_char;
use core::ffi::CStr;

/// Safely convert a `const char*` from C into `Option<&str>`.
/// `None` if the pointer is null, the string isn't valid UTF-8, or after
/// trimming it's empty or the literal "{}" — callers treat `None` as
/// "keep existing stored params" so a plain note-on doesn't reset the patch.
unsafe fn c_str_or_none<'a>(ptr: *const c_char) -> Option<&'a str> {
    if ptr.is_null() {
        return None;
    }
    let s = CStr::from_ptr(ptr).to_str().ok()?;
    let t = s.trim();
    if t.is_empty() || t == "{}" {
        None
    } else {
        Some(s)
    }
}

// ── Drums ────────────────────────────────────────────────────────────────────

/// Opaque handle to a `DrumsEngine`. Construct with
/// [`clankers_drums_new`], destroy with [`clankers_drums_free`].
pub struct ClankersDrums {
    engine: DrumsEngine,
}

/// Allocate a new drum engine. Returns an owning pointer the caller must
/// later pass to [`clankers_drums_free`]. Never returns null.
#[no_mangle]
pub extern "C" fn clankers_drums_new(seed: u32) -> *mut ClankersDrums {
    Box::into_raw(Box::new(ClankersDrums {
        engine: DrumsEngine::new(seed),
    }))
}

/// Destroy a drum engine previously returned by [`clankers_drums_new`].
/// Passing null is a no-op. Passing any other pointer not produced by
/// `clankers_drums_new` is undefined behaviour.
#[no_mangle]
pub unsafe extern "C" fn clankers_drums_free(ptr: *mut ClankersDrums) {
    if !ptr.is_null() {
        drop(Box::from_raw(ptr));
    }
}

/// Select drum machine profile. `id`: 0=808, 1=909, 2=606.
#[no_mangle]
pub unsafe extern "C" fn clankers_drums_set_profile(ptr: *mut ClankersDrums, id: u8) {
    (*ptr).engine.set_profile(id);
}

/// Global pitch shift in semitones (−12..+12).
#[no_mangle]
pub unsafe extern "C" fn clankers_drums_set_pitch(ptr: *mut ClankersDrums, semitones: f32) {
    (*ptr).engine.set_pitch(semitones);
}

/// Global decay multiplier (0.1..8.0). Updates active voices immediately.
#[no_mangle]
pub unsafe extern "C" fn clankers_drums_set_decay(ptr: *mut ClankersDrums, mult: f32) {
    (*ptr).engine.set_decay(mult);
}

/// Global output lowpass cutoff in Hz (80..20000). Live.
#[no_mangle]
pub unsafe extern "C" fn clankers_drums_set_filter(ptr: *mut ClankersDrums, hz: f32) {
    (*ptr).engine.set_filter(hz);
}

/// Trigger a voice. `voice_id`: 0-6. `velocity`: 0.0..1.0.
#[no_mangle]
pub unsafe extern "C" fn clankers_drums_trigger(
    ptr: *mut ClankersDrums,
    voice_id: u8,
    velocity: f32,
) {
    (*ptr).engine.trigger(voice_id, velocity);
}

/// Render `n_samples` mono samples into the caller-supplied buffer.
/// The buffer is overwritten (not mixed). It must have capacity for
/// at least `n_samples` `f32` values.
#[no_mangle]
pub unsafe extern "C" fn clankers_drums_process(
    ptr: *mut ClankersDrums,
    output: *mut f32,
    n_samples: u32,
) {
    let slice = core::slice::from_raw_parts_mut(output, n_samples as usize);
    (*ptr).engine.process(slice);
}

// ── Bass ─────────────────────────────────────────────────────────────────────

/// Opaque handle to a `BassEngine` plus its currently-stored `BassParams`.
/// Construct with [`clankers_bass_new`], destroy with [`clankers_bass_free`].
pub struct ClankersBass {
    engine: BassEngine,
    params: BassParams,
}

/// Allocate a new bass engine. Never returns null.
#[no_mangle]
pub extern "C" fn clankers_bass_new(seed: u32) -> *mut ClankersBass {
    Box::into_raw(Box::new(ClankersBass {
        engine: BassEngine::new(seed),
        params: BassParams::default(),
    }))
}

/// Destroy a bass engine. Passing null is a no-op.
#[no_mangle]
pub unsafe extern "C" fn clankers_bass_free(ptr: *mut ClankersBass) {
    if !ptr.is_null() {
        drop(Box::from_raw(ptr));
    }
}

/// Update stored params from a CC-JSON object like `{"71":80,"74":60}`.
/// Affects currently playing voices on the next `_process` call.
///
/// A null, empty, or `"{}"` string is a no-op (stored params are preserved).
/// Any other string is parsed; missing CC keys reset to `BassParams::default()`.
#[no_mangle]
pub unsafe extern "C" fn clankers_bass_set_params(
    ptr: *mut ClankersBass,
    cc_json: *const c_char,
) {
    if let Some(s) = c_str_or_none(cc_json) {
        (*ptr).params = parse_bass_params(s);
    }
}

/// Trigger a note. If `cc_json` is non-null/non-empty/non-`"{}"`, stored
/// params are updated first (same semantics as `_set_params`); otherwise
/// the existing stored params are reused so a plain note-on doesn't wipe
/// the patch.
///
/// `hold_samples`: note-on duration in samples (0 = use amp envelope only).
#[no_mangle]
pub unsafe extern "C" fn clankers_bass_trigger(
    ptr: *mut ClankersBass,
    midi_note: u8,
    velocity: f32,
    hold_samples: u32,
    cc_json: *const c_char,
) {
    let this = &mut *ptr;
    if let Some(s) = c_str_or_none(cc_json) {
        this.params = parse_bass_params(s);
    }
    this.engine
        .trigger(midi_note, velocity, hold_samples as usize, &this.params);
}

/// Render `n_samples` mono samples using the currently stored params.
/// Buffer is overwritten, not mixed. Capacity must be >= `n_samples`.
#[no_mangle]
pub unsafe extern "C" fn clankers_bass_process(
    ptr: *mut ClankersBass,
    output: *mut f32,
    n_samples: u32,
) {
    let this = &mut *ptr;
    let slice = core::slice::from_raw_parts_mut(output, n_samples as usize);
    this.engine.process(slice, &this.params);
}

/// Return a pointer to a NUL-terminated JSON descriptor array for bass
/// params. The pointer references a static string baked into the library —
/// the caller must NOT free it, and it remains valid for the program's
/// lifetime. The handle argument is unused (params are engine-type-static)
/// but kept for API uniformity with engines whose params differ per-instance.
#[no_mangle]
pub extern "C" fn clankers_bass_param_info(_ptr: *const ClankersBass) -> *const c_char {
    BassParams::PARAM_INFO_C.as_ptr() as *const c_char
}

/// Set one param by positional index (see `clankers_bass_param_info`).
/// Out-of-range indices are ignored; values are clamped to each param's
/// declared range. Thread-safety is the caller's responsibility (same
/// rules as `set_params`).
#[no_mangle]
pub unsafe extern "C" fn clankers_bass_set_param(
    ptr: *mut ClankersBass,
    idx: u32,
    value: f32,
) {
    (*ptr).params.set_param(idx, value);
}

// ── Buchla ───────────────────────────────────────────────────────────────────

/// Opaque handle to a `BuchlaEngine` plus its currently-stored `BuchlaParams`.
/// Construct with [`clankers_buchla_new`], destroy with [`clankers_buchla_free`].
pub struct ClankersBuchla {
    engine: BuchlaEngine,
    params: BuchlaParams,
}

/// Allocate a new Buchla engine. Never returns null.
#[no_mangle]
pub extern "C" fn clankers_buchla_new() -> *mut ClankersBuchla {
    Box::into_raw(Box::new(ClankersBuchla {
        engine: BuchlaEngine::new(),
        params: BuchlaParams::default(),
    }))
}

/// Destroy a Buchla engine. Passing null is a no-op.
#[no_mangle]
pub unsafe extern "C" fn clankers_buchla_free(ptr: *mut ClankersBuchla) {
    if !ptr.is_null() {
        drop(Box::from_raw(ptr));
    }
}

/// Update stored params from a CC-JSON object. `_set_params` rules apply:
/// null/empty/`"{}"` is a no-op; any other string is parsed with missing
/// CCs reset to `BuchlaParams::default()`.
#[no_mangle]
pub unsafe extern "C" fn clankers_buchla_set_params(
    ptr: *mut ClankersBuchla,
    cc_json: *const c_char,
) {
    if let Some(s) = c_str_or_none(cc_json) {
        (*ptr).params = parse_buchla_params(s);
    }
}

/// Trigger a voice using the currently stored params.
#[no_mangle]
pub unsafe extern "C" fn clankers_buchla_trigger(
    ptr: *mut ClankersBuchla,
    midi_note: u8,
    velocity: f32,
) {
    let this = &mut *ptr;
    this.engine.trigger(midi_note, velocity, &this.params);
}

/// Render `n_samples` mono samples using the currently stored params.
/// Buffer is overwritten, not mixed. Capacity must be >= `n_samples`.
#[no_mangle]
pub unsafe extern "C" fn clankers_buchla_process(
    ptr: *mut ClankersBuchla,
    output: *mut f32,
    n_samples: u32,
) {
    let this = &mut *ptr;
    let slice = core::slice::from_raw_parts_mut(output, n_samples as usize);
    this.engine.process(slice, &this.params);
}

/// Static NUL-terminated JSON descriptor (see `clankers_bass_param_info`).
#[no_mangle]
pub extern "C" fn clankers_buchla_param_info(_ptr: *const ClankersBuchla) -> *const c_char {
    BuchlaParams::PARAM_INFO_C.as_ptr() as *const c_char
}

/// Set one param by positional index (see `clankers_buchla_param_info`).
#[no_mangle]
pub unsafe extern "C" fn clankers_buchla_set_param(
    ptr: *mut ClankersBuchla,
    idx: u32,
    value: f32,
) {
    (*ptr).params.set_param(idx, value);
}

// ── Rhodes ───────────────────────────────────────────────────────────────────

/// Opaque handle to a `RhodesEngine` + its stored `RhodesParams`.
/// Output is stereo. Construct with [`clankers_rhodes_new`], destroy with
/// [`clankers_rhodes_free`].
pub struct ClankersRhodes {
    engine: RhodesEngine,
    params: RhodesParams,
}

/// Allocate a new Rhodes engine. Never returns null.
#[no_mangle]
pub extern "C" fn clankers_rhodes_new() -> *mut ClankersRhodes {
    Box::into_raw(Box::new(ClankersRhodes {
        engine: RhodesEngine::new(),
        params: RhodesParams::default(),
    }))
}

/// Destroy a Rhodes engine. Passing null is a no-op.
#[no_mangle]
pub unsafe extern "C" fn clankers_rhodes_free(ptr: *mut ClankersRhodes) {
    if !ptr.is_null() {
        drop(Box::from_raw(ptr));
    }
}

/// Update stored params from CC-JSON. null/""/"{}" is a no-op.
#[no_mangle]
pub unsafe extern "C" fn clankers_rhodes_set_params(
    ptr: *mut ClankersRhodes,
    cc_json: *const c_char,
) {
    if let Some(s) = c_str_or_none(cc_json) {
        (*ptr).params = parse_rhodes_params(s);
    }
}

/// Trigger a note. `hold_samples`: note-on duration in samples.
#[no_mangle]
pub unsafe extern "C" fn clankers_rhodes_trigger(
    ptr: *mut ClankersRhodes,
    midi_note: u8,
    velocity: f32,
    hold_samples: u32,
) {
    let this = &mut *ptr;
    this.engine
        .trigger(midi_note, velocity, hold_samples as usize, &this.params);
}

/// Render `n_samples` stereo samples into caller-owned L/R buffers.
/// Each buffer must have capacity >= `n_samples`. Buffers are overwritten.
#[no_mangle]
pub unsafe extern "C" fn clankers_rhodes_process(
    ptr: *mut ClankersRhodes,
    out_l: *mut f32,
    out_r: *mut f32,
    n_samples: u32,
) {
    let this = &mut *ptr;
    let n = n_samples as usize;
    let l = core::slice::from_raw_parts_mut(out_l, n);
    let r = core::slice::from_raw_parts_mut(out_r, n);
    this.engine.process(l, r, &this.params);
}

/// Static NUL-terminated JSON descriptor (see `clankers_bass_param_info`).
#[no_mangle]
pub extern "C" fn clankers_rhodes_param_info(_ptr: *const ClankersRhodes) -> *const c_char {
    RhodesParams::PARAM_INFO_C.as_ptr() as *const c_char
}

/// Set one param by positional index (see `clankers_rhodes_param_info`).
#[no_mangle]
pub unsafe extern "C" fn clankers_rhodes_set_param(
    ptr: *mut ClankersRhodes,
    idx: u32,
    value: f32,
) {
    (*ptr).params.set_param(idx, value);
}

// ── Pads ─────────────────────────────────────────────────────────────────────

/// Opaque handle to a `PadsEngine` + its stored `PadsParams`.
/// Output is stereo. Construct with [`clankers_pads_new`], destroy with
/// [`clankers_pads_free`].
pub struct ClankersPads {
    engine: PadsEngine,
    params: PadsParams,
}

/// Allocate a new Pads engine. Never returns null.
#[no_mangle]
pub extern "C" fn clankers_pads_new() -> *mut ClankersPads {
    Box::into_raw(Box::new(ClankersPads {
        engine: PadsEngine::new(),
        params: PadsParams::default(),
    }))
}

/// Destroy a Pads engine. Passing null is a no-op.
#[no_mangle]
pub unsafe extern "C" fn clankers_pads_free(ptr: *mut ClankersPads) {
    if !ptr.is_null() {
        drop(Box::from_raw(ptr));
    }
}

/// Update stored params from CC-JSON. null/""/"{}" is a no-op.
#[no_mangle]
pub unsafe extern "C" fn clankers_pads_set_params(
    ptr: *mut ClankersPads,
    cc_json: *const c_char,
) {
    if let Some(s) = c_str_or_none(cc_json) {
        (*ptr).params = parse_pads_params(s);
    }
}

/// Trigger a note. `hold_samples`: note-on duration in samples.
#[no_mangle]
pub unsafe extern "C" fn clankers_pads_trigger(
    ptr: *mut ClankersPads,
    midi_note: u8,
    velocity: f32,
    hold_samples: u32,
) {
    let this = &mut *ptr;
    this.engine
        .trigger(midi_note, velocity, hold_samples as usize, &this.params);
}

/// Render `n_samples` stereo samples into caller-owned L/R buffers.
#[no_mangle]
pub unsafe extern "C" fn clankers_pads_process(
    ptr: *mut ClankersPads,
    out_l: *mut f32,
    out_r: *mut f32,
    n_samples: u32,
) {
    let this = &mut *ptr;
    let n = n_samples as usize;
    let l = core::slice::from_raw_parts_mut(out_l, n);
    let r = core::slice::from_raw_parts_mut(out_r, n);
    this.engine.process(l, r, &this.params);
}

/// Static NUL-terminated JSON descriptor (see `clankers_bass_param_info`).
#[no_mangle]
pub extern "C" fn clankers_pads_param_info(_ptr: *const ClankersPads) -> *const c_char {
    PadsParams::PARAM_INFO_C.as_ptr() as *const c_char
}

/// Set one param by positional index (see `clankers_pads_param_info`).
#[no_mangle]
pub unsafe extern "C" fn clankers_pads_set_param(
    ptr: *mut ClankersPads,
    idx: u32,
    value: f32,
) {
    (*ptr).params.set_param(idx, value);
}

// ── Voder ────────────────────────────────────────────────────────────────────

/// Parallel-formant vocal synth. 4 voices, mono output.
///
/// Phoneme indices (0-33):
///   0 AA   1 AE   2 AH   3 AO   4 EH   5 ER   6 EY   7 IH   8 IY
///   9 OW  10 UH  11 UW  12 L   13 R   14 W   15 Y   16 M   17 N
///  18 F   19 S   20 SH  21 TH  22 V   23 Z   24 ZH
///  25 SIL 26 HH  27 NG  28 B   29 D   30 G   31 P   32 T   33 K
pub struct ClankersVoder {
    engine: VoderEngine,
    params: VoderParams,
}

/// Allocate a new Voder engine. Never returns null.
#[no_mangle]
pub extern "C" fn clankers_voder_new(seed: u32) -> *mut ClankersVoder {
    Box::into_raw(Box::new(ClankersVoder {
        engine: VoderEngine::new(seed),
        params: VoderParams::default(),
    }))
}

/// Destroy a Voder engine. Passing null is a no-op.
#[no_mangle]
pub unsafe extern "C" fn clankers_voder_free(ptr: *mut ClankersVoder) {
    if !ptr.is_null() {
        drop(Box::from_raw(ptr));
    }
}

/// Update stored params from CC-JSON. null/""/"{}" is a no-op.
#[no_mangle]
pub unsafe extern "C" fn clankers_voder_set_params(
    ptr: *mut ClankersVoder,
    cc_json: *const c_char,
) {
    if let Some(s) = c_str_or_none(cc_json) {
        (*ptr).params = parse_voder_params(s);
    }
}

/// Set the active phoneme target (0-33). All voices interpolate toward it.
#[no_mangle]
pub unsafe extern "C" fn clankers_voder_set_phoneme(ptr: *mut ClankersVoder, idx: u8) {
    (*ptr).engine.set_phoneme(idx as usize);
}

/// Vowel-pad mode: x=F1 (0=closed..1=open), y=F2 (0=back..1=front).
/// All voices update live.
#[no_mangle]
pub unsafe extern "C" fn clankers_voder_set_xy(ptr: *mut ClankersVoder, x: f32, y: f32) {
    (*ptr).engine.set_xy(x, y);
}

/// Set a phoneme sequence as a JSON integer array, e.g. `"[0,8,2,11]"`.
/// The last triggered voice will step through the sequence over `hold_samples`.
/// A null or malformed string is a no-op.
#[no_mangle]
pub unsafe extern "C" fn clankers_voder_set_phonemes(
    ptr: *mut ClankersVoder,
    json: *const c_char,
    hold_samples: u32,
) {
    if json.is_null() {
        return;
    }
    if let Ok(s) = CStr::from_ptr(json).to_str() {
        let phonemes = parse_usize_array(s);
        (*ptr).engine.set_queue_for_last(&phonemes, hold_samples as usize);
    }
}

/// Set a timed phoneme sequence: parallel JSON arrays of phoneme indices,
/// per-phoneme durations in samples, pitch multipliers (1.0 = base note),
/// and amplitude multipliers. Any shorter array is padded with defaults
/// (150 ms / 1.0 / 1.0). Any null/malformed arg is treated as `"[]"`.
#[no_mangle]
pub unsafe extern "C" fn clankers_voder_set_phonemes_timed(
    ptr: *mut ClankersVoder,
    phonemes_json:  *const c_char,
    durations_json: *const c_char,
    pitches_json:   *const c_char,
    amps_json:      *const c_char,
) {
    unsafe fn as_str<'a>(p: *const c_char) -> &'a str {
        if p.is_null() { return ""; }
        CStr::from_ptr(p).to_str().unwrap_or("")
    }
    let phonemes  = parse_usize_array(as_str(phonemes_json));
    let durations = parse_usize_array(as_str(durations_json));
    let pitches   = parse_float_array(as_str(pitches_json));
    let amps      = parse_float_array(as_str(amps_json));
    (*ptr)
        .engine
        .set_queue_detailed_for_last(&phonemes, &durations, &pitches, &amps);
}

/// Trigger a note. If `cc_json` is non-null/non-empty/non-`"{}"`, updates
/// stored params first. `hold_samples`: 0 = sustain until release().
#[no_mangle]
pub unsafe extern "C" fn clankers_voder_trigger(
    ptr: *mut ClankersVoder,
    midi_note: u8,
    velocity: f32,
    hold_samples: u32,
    cc_json: *const c_char,
) {
    let this = &mut *ptr;
    if let Some(s) = c_str_or_none(cc_json) {
        this.params = parse_voder_params(s);
    }
    this.engine
        .trigger(midi_note, velocity, hold_samples as usize, &this.params);
}

/// Send note-off to the most recently triggered voice.
#[no_mangle]
pub unsafe extern "C" fn clankers_voder_release(ptr: *mut ClankersVoder) {
    (*ptr).engine.release();
}

/// Render `n_samples` mono samples. Buffer is overwritten.
#[no_mangle]
pub unsafe extern "C" fn clankers_voder_process(
    ptr: *mut ClankersVoder,
    output: *mut f32,
    n_samples: u32,
) {
    let this = &mut *ptr;
    let slice = core::slice::from_raw_parts_mut(output, n_samples as usize);
    this.engine.process(slice, &this.params);
}

/// Number of phonemes in the built-in table (34).
#[no_mangle]
pub extern "C" fn clankers_voder_phoneme_count() -> u32 {
    voder::N_PHONEMES as u32
}

/// Static NUL-terminated JSON descriptor (see `clankers_bass_param_info`).
#[no_mangle]
pub extern "C" fn clankers_voder_param_info(_ptr: *const ClankersVoder) -> *const c_char {
    VoderParams::PARAM_INFO_C.as_ptr() as *const c_char
}

/// Set one param by positional index (see `clankers_voder_param_info`).
#[no_mangle]
pub unsafe extern "C" fn clankers_voder_set_param(
    ptr: *mut ClankersVoder,
    idx: u32,
    value: f32,
) {
    (*ptr).params.set_param(idx, value);
}
