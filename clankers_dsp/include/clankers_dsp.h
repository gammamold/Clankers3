/*
 * clankers_dsp.h — C ABI for the Clankers DSP core.
 *
 * Link against the `clankers_dsp` Rust crate built with
 *   cargo build --release --no-default-features
 * which produces a staticlib (.a / .lib) and a cdylib (.so / .dylib / .dll).
 *
 * All functions declared here have #[no_mangle] in the Rust source
 * (see src/ffi.rs) and use the C calling convention.
 *
 * Conventions
 * -----------
 *   - Constructors return an owning pointer; caller must pair each `_new`
 *     with the matching `_free`.
 *   - `_free(NULL)` is a no-op. Calling `_free` twice on the same pointer,
 *     or passing any pointer not produced by the matching `_new`, is
 *     undefined behaviour.
 *   - Buffers passed to `_process` are caller-owned and overwritten in
 *     place (not mixed). No allocation occurs in the audio path.
 *   - Sample rate is 44_100 Hz. (For now. A future revision will add
 *     per-engine SR configuration.)
 *
 * Thread safety
 * -------------
 *   Each engine instance is single-threaded. Call audio-rate methods
 *   (`_trigger`, `_process`) from the audio thread; control-rate methods
 *   (`_set_*`) can be called from another thread only if you provide
 *   your own synchronisation. No internal locking.
 *
 * Status
 * ------
 *   Drums is the first engine exposed via C ABI as proof-of-concept.
 *   Bass, Buchla, Rhodes, Pads, Voder, SynthGraph, GraphFx will follow
 *   the same pattern (opaque handle + flat functions + CC-JSON strings
 *   for param bundles). See clankers_dsp/README_FFI.md.
 */

#ifndef CLANKERS_DSP_H
#define CLANKERS_DSP_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* ── Drums ─────────────────────────────────────────────────────────────────
 *
 * Three-profile synth drum machine (808 / 909 / 606). 7 voices.
 *
 *   Voice IDs  0-6 — character depends on selected profile:
 *     808 →  KICK  SNARE  HH-CL  HH-OP  TOM-L  TOM-H  CLAP
 *     909 →  KICK  SNARE  HH-CL  HH-OP  TOM-L  TOM-M  TOM-H
 *     606 →  KICK  SNARE  HH-CL  HH-OP  TOM-L  TOM-H  CYMBAL
 */

typedef struct ClankersDrums ClankersDrums;

/* Allocate a new drum engine. Never returns NULL. */
ClankersDrums* clankers_drums_new(uint32_t seed);

/* Destroy an engine previously returned by clankers_drums_new. */
void clankers_drums_free(ClankersDrums* drums);

/* Select drum machine profile. id: 0=808, 1=909, 2=606. */
void clankers_drums_set_profile(ClankersDrums* drums, uint8_t id);

/* Global pitch shift in semitones (−12..+12). */
void clankers_drums_set_pitch(ClankersDrums* drums, float semitones);

/* Global decay multiplier (0.1..8.0). Updates active voices immediately. */
void clankers_drums_set_decay(ClankersDrums* drums, float mult);

/* Global output lowpass cutoff in Hz (80..20000). Live. */
void clankers_drums_set_filter(ClankersDrums* drums, float hz);

/* Trigger a voice. voice_id: 0-6. velocity: 0.0..1.0. */
void clankers_drums_trigger(ClankersDrums* drums, uint8_t voice_id, float velocity);

/* Render n_samples mono samples into `output` (overwrites; capacity must
 * be at least n_samples floats). */
void clankers_drums_process(ClankersDrums* drums, float* output, uint32_t n_samples);

/* ── Bass ──────────────────────────────────────────────────────────────────
 *
 * FM bass (sine carrier + sine modulator) through a TPT ladder LPF, with
 * pluck-style filter + amp envelopes. 8 voices.
 *
 * CC-JSON param map:
 *   CC71 fm_index     CC74 cutoff     CC23 flt_decay     CC75 amp_decay
 *
 * Typical use:
 *   ClankersBass* b = clankers_bass_new(0xba55);
 *   clankers_bass_trigger(b, 36, 1.0f, 11025, "{\"71\":80,\"74\":90}");
 *   clankers_bass_process(b, buf, 512);
 *   ...
 *   clankers_bass_free(b);
 */

typedef struct ClankersBass ClankersBass;

ClankersBass* clankers_bass_new(uint32_t seed);
void          clankers_bass_free(ClankersBass* bass);

/* Update stored params from a CC-JSON object like {"71":80,"74":60}.
 * Affects currently playing voices on the next _process call.
 * NULL, "", or "{}" is a no-op — stored params are preserved. */
void clankers_bass_set_params(ClankersBass* bass, const char* cc_json);

/* Trigger a note. cc_json follows the same rules as _set_params above:
 * non-empty JSON updates stored params first; NULL/""/"{}" reuses them,
 * so a plain note-on doesn't wipe the patch.
 * hold_samples: note-on duration (0 = use amp envelope only). */
void clankers_bass_trigger(
    ClankersBass* bass,
    uint8_t       midi_note,
    float         velocity,
    uint32_t      hold_samples,
    const char*   cc_json);

/* Render n_samples mono samples (overwrites output; no alloc). */
void clankers_bass_process(ClankersBass* bass, float* output, uint32_t n_samples);

/* Return a pointer to a static NUL-terminated JSON array describing the
 * bass params for UI auto-generation. Caller must NOT free it.
 *   [{"idx":0,"name":"FM Index","unit":"","min":0,"max":8,"default":2,"cc":71}, ...]
 * Fields: idx (uint), name (str), unit (str), min/max/default (float),
 *   skew (optional, "log"|"linear"), cc (optional, 0-127 MIDI CC#).
 * Handle arg is unused for bass (params are type-static) but kept for
 * API uniformity with engines whose descriptor varies per instance. */
const char* clankers_bass_param_info(const ClankersBass* bass);

/* Set one param by positional index (see clankers_bass_param_info).
 * Out-of-range indices are ignored; values are clamped to each param's
 * declared range. Intended for live slider drags. */
void clankers_bass_set_param(ClankersBass* bass, uint32_t idx, float value);

#ifdef __cplusplus
} /* extern "C" */
#endif

#endif /* CLANKERS_DSP_H */
