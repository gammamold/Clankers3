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

#ifdef __cplusplus
} /* extern "C" */
#endif

#endif /* CLANKERS_DSP_H */
