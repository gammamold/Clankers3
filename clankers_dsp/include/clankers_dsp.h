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

/* ── Buchla ────────────────────────────────────────────────────────────────
 *
 * Buchla 259/292-style percussive arp — triangle osc + wavefolder + LPG.
 * 8 voices, mono output.
 *
 * CC-JSON param map:
 *   CC74 cutoff   CC20 wavefold   CC19 release   CC21 filter_mod   CC16 volume
 *
 * Typical use:
 *   ClankersBuchla* b = clankers_buchla_new();
 *   clankers_buchla_set_params(b, "{\"74\":56,\"20\":37}");
 *   clankers_buchla_trigger(b, 60, 1.0f);
 *   clankers_buchla_process(b, buf, 512);
 *   ...
 *   clankers_buchla_free(b);
 */

typedef struct ClankersBuchla ClankersBuchla;

ClankersBuchla* clankers_buchla_new(void);
void            clankers_buchla_free(ClankersBuchla* buchla);

/* Update stored params from CC-JSON. NULL/""/"{}" is a no-op. */
void clankers_buchla_set_params(ClankersBuchla* buchla, const char* cc_json);

/* Trigger a voice using currently stored params. */
void clankers_buchla_trigger(ClankersBuchla* buchla, uint8_t midi_note, float velocity);

/* Render n_samples mono samples (overwrites output). */
void clankers_buchla_process(ClankersBuchla* buchla, float* output, uint32_t n_samples);

/* Static param descriptor JSON (NUL-terminated, do not free). */
const char* clankers_buchla_param_info(const ClankersBuchla* buchla);

/* Set one param by positional index (see clankers_buchla_param_info). */
void clankers_buchla_set_param(ClankersBuchla* buchla, uint32_t idx, float value);

/* ── Rhodes ────────────────────────────────────────────────────────────────
 *
 * FM tine electric piano (Operator / Lounge Lizard style). Stereo output.
 *
 * CC-JSON param map:
 *   CC74 brightness  CC72 amp_decay  CC73 mod_decay  CC20 harm_ratio
 *   CC55 key_scale   CC26 tremolo_rate  CC27 tremolo_depth
 *   CC29 chorus_rate CC30 chorus_mix    CC10 pan
 */

typedef struct ClankersRhodes ClankersRhodes;

ClankersRhodes* clankers_rhodes_new(void);
void            clankers_rhodes_free(ClankersRhodes* rhodes);

/* Update stored params from CC-JSON. NULL/""/"{}" is a no-op. */
void clankers_rhodes_set_params(ClankersRhodes* rhodes, const char* cc_json);

/* Trigger a note. hold_samples: note-on duration in samples. */
void clankers_rhodes_trigger(
    ClankersRhodes* rhodes,
    uint8_t         midi_note,
    float           velocity,
    uint32_t        hold_samples);

/* Render n_samples stereo samples into caller-owned L/R buffers. Each
 * buffer must have capacity >= n_samples. Buffers are overwritten. */
void clankers_rhodes_process(
    ClankersRhodes* rhodes,
    float*          out_l,
    float*          out_r,
    uint32_t        n_samples);

const char* clankers_rhodes_param_info(const ClankersRhodes* rhodes);
void        clankers_rhodes_set_param (ClankersRhodes* rhodes, uint32_t idx, float value);

/* ── Pads ──────────────────────────────────────────────────────────────────
 *
 * HybridSynth pads — Moog ladder + ADSR + chorus + reverb. 8 polyphonic
 * voices, stereo output.
 *
 * CC-JSON param map:
 *   CC74 cutoff_hz    CC71 resonance   CC73 amp_attack  CC75 amp_decay
 *   CC79 amp_sustain  CC72 amp_release CC88 reverb_size CC91 reverb_mix
 *   CC29 chorus_rate  CC30 chorus_depth CC31 chorus_mix
 */

typedef struct ClankersPads ClankersPads;

ClankersPads* clankers_pads_new(void);
void          clankers_pads_free(ClankersPads* pads);

/* Update stored params from CC-JSON. NULL/""/"{}" is a no-op. */
void clankers_pads_set_params(ClankersPads* pads, const char* cc_json);

/* Trigger a note. hold_samples: note-on duration in samples. */
void clankers_pads_trigger(
    ClankersPads* pads,
    uint8_t       midi_note,
    float         velocity,
    uint32_t      hold_samples);

/* Render n_samples stereo samples into caller-owned L/R buffers. */
void clankers_pads_process(
    ClankersPads* pads,
    float*        out_l,
    float*        out_r,
    uint32_t      n_samples);

const char* clankers_pads_param_info(const ClankersPads* pads);
void        clankers_pads_set_param (ClankersPads* pads, uint32_t idx, float value);

/* ── Voder ─────────────────────────────────────────────────────────────────
 *
 * Parallel-formant vocal synthesizer (the "sing" engine). 4 voices, mono.
 * Glottal pulse + aspiration noise → bank of 5 biquad resonators whose
 * centre frequencies interpolate between phoneme targets.
 *
 * Phoneme indices (0-33):
 *    0 AA   1 AE   2 AH   3 AO   4 EH   5 ER   6 EY   7 IH   8 IY
 *    9 OW  10 UH  11 UW  12 L   13 R   14 W   15 Y   16 M   17 N
 *   18 F   19 S   20 SH  21 TH  22 V   23 Z   24 ZH
 *   25 SIL 26 HH  27 NG  28 B   29 D   30 G   31 P   32 T   33 K
 *
 * CC-JSON param map:
 *   CC74 brightness     CC20 voicing       CC73 attack_s
 *   CC72 release_s      CC75 vibrato_depth CC76 vibrato_rate
 *   CC77 coartic_ms     CC16 volume
 */

typedef struct ClankersVoder ClankersVoder;

ClankersVoder* clankers_voder_new(uint32_t seed);
void           clankers_voder_free(ClankersVoder* voder);

/* Update stored params from CC-JSON. NULL/""/"{}" is a no-op. */
void clankers_voder_set_params(ClankersVoder* voder, const char* cc_json);

/* Set the active phoneme target (0-33). All voices interpolate toward it. */
void clankers_voder_set_phoneme(ClankersVoder* voder, uint8_t idx);

/* Vowel-pad mode: x=F1 (0=closed..1=open), y=F2 (0=back..1=front). */
void clankers_voder_set_xy(ClankersVoder* voder, float x, float y);

/* Phoneme sequence as a JSON integer array, e.g. "[0,8,2,11]". Applied
 * to the most recently triggered voice over `hold_samples`. NULL or
 * malformed JSON is a no-op. */
void clankers_voder_set_phonemes(
    ClankersVoder* voder,
    const char*    json,
    uint32_t       hold_samples);

/* Timed phoneme sequence: parallel JSON arrays for phoneme indices,
 * per-phoneme durations (samples), pitch multipliers (1.0 = base note),
 * and amplitude multipliers. Any shorter array is padded with defaults
 * (150 ms / 1.0 / 1.0). Any NULL/malformed arg is treated as "[]". */
void clankers_voder_set_phonemes_timed(
    ClankersVoder* voder,
    const char*    phonemes_json,
    const char*    durations_json,
    const char*    pitches_json,
    const char*    amps_json);

/* Trigger a note. cc_json NULL/""/"{}" reuses stored params (no-op on
 * patch). hold_samples: 0 = sustain until clankers_voder_release. */
void clankers_voder_trigger(
    ClankersVoder* voder,
    uint8_t        midi_note,
    float          velocity,
    uint32_t       hold_samples,
    const char*    cc_json);

/* Note-off for the most recently triggered voice. */
void clankers_voder_release(ClankersVoder* voder);

/* Render n_samples mono samples (overwrites output). */
void clankers_voder_process(ClankersVoder* voder, float* output, uint32_t n_samples);

/* Number of phonemes in the built-in table (34). */
uint32_t clankers_voder_phoneme_count(void);

const char* clankers_voder_param_info(const ClankersVoder* voder);
void        clankers_voder_set_param (ClankersVoder* voder, uint32_t idx, float value);

#ifdef __cplusplus
} /* extern "C" */
#endif

#endif /* CLANKERS_DSP_H */
