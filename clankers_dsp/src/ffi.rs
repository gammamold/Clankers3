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
use crate::cc::parse_bass_params;
use crate::drums::DrumsEngine;
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
