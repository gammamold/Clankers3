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
 *   - Sample rate is configured per engine at construction via the
 *     `sample_rate` argument (Hz) on every `_new(...)` call, and can be
 *     changed mid-life with `_set_sample_rate(engine, sample_rate)`.
 *     `_set_sample_rate` wipes any in-flight voice state — call it from
 *     the `prepareToPlay` lifecycle, not the audio thread.
 *
 * Thread safety
 * -------------
 *   Each engine instance is single-threaded. Call audio-rate methods
 *   (`_trigger`, `_process`) from the audio thread; control-rate methods
 *   (`_set_*`) can be called from another thread only if you provide
 *   your own synchronisation. No internal locking.
 *
 * Errors
 * ------
 *   Fallible constructors (currently the graph engines) return NULL on
 *   failure. Retrieve the reason with `clankers_last_error()`, which is
 *   per-thread and only valid until the next FFI call on that thread.
 *   Infallible constructors never return NULL.
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

/* Allocate a new drum engine. Never returns NULL.
 * sample_rate: audio device SR in Hz (e.g. 44100, 48000). */
ClankersDrums* clankers_drums_new(uint32_t seed, float sample_rate);

/* Reconfigure SR — rebuilds SR-dependent state and wipes voices.
 * Call from prepareToPlay, not the audio thread. */
void clankers_drums_set_sample_rate(ClankersDrums* drums, float sample_rate);

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

/* Attack-click transient multiplier (0..2). Scales kick/tom click level.
 * 0 = no click, 1 = preset default. Affects new notes only. */
void clankers_drums_set_click(ClankersDrums* drums, float mult);

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

ClankersBass* clankers_bass_new(uint32_t seed, float sample_rate);
void          clankers_bass_set_sample_rate(ClankersBass* bass, float sample_rate);
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

ClankersBuchla* clankers_buchla_new(float sample_rate);
void            clankers_buchla_set_sample_rate(ClankersBuchla* buchla, float sample_rate);
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

ClankersRhodes* clankers_rhodes_new(float sample_rate);
void            clankers_rhodes_set_sample_rate(ClankersRhodes* rhodes, float sample_rate);
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

ClankersPads* clankers_pads_new(float sample_rate);
void          clankers_pads_set_sample_rate(ClankersPads* pads, float sample_rate);
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

ClankersVoder* clankers_voder_new(uint32_t seed, float sample_rate);
void           clankers_voder_set_sample_rate(ClankersVoder* voder, float sample_rate);
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

/* ── Error reporting (thread-local) ────────────────────────────────────────
 *
 * Fallible FFI calls (currently only the graph constructors) record their
 * error message here on failure. Successful calls clear it.
 *
 * The returned pointer is valid only until the next FFI call on this thread.
 * Copy the string if you need to retain it. Do NOT free it.
 * Returns NULL if the last fallible call on this thread succeeded.
 */
const char* clankers_last_error(void);

/* ── SynthGraph ────────────────────────────────────────────────────────────
 *
 * Graph-based polyphonic synth engine — nodes (oscillators, filters, envs,
 * LFOs, effects) + connections, designed at runtime (typically by an LLM)
 * and described in JSON. Topology is frozen at construction; only parameter
 * values change at runtime. The exposed parameter list depends on the
 * specific graph loaded, so the descriptor lives on the handle.
 *
 *   const char* g = "{\"nodes\":[...],\"connections\":[...]}";
 *   ClankersGraph* sg = clankers_graph_new(g, 8);
 *   if (!sg) { fprintf(stderr, "%s\n", clankers_last_error()); return; }
 *   clankers_graph_trigger(sg, 60, 1.0f, 22050);
 *   clankers_graph_process(sg, L, R, 512);
 *   ...
 *   clankers_graph_free(sg);
 */

typedef struct ClankersGraph ClankersGraph;

/* Parse JSON and build a synth graph. num_voices is clamped to 1..=16.
 * Returns NULL on parse or validation failure; see clankers_last_error. */
ClankersGraph* clankers_graph_new(const char* graph_json, uint8_t num_voices, float sample_rate);

/* Rebuild voices at a new SR; topology + params preserved, voice state wiped. */
void clankers_graph_set_sample_rate(ClankersGraph* graph, float sample_rate);

/* Destroy a graph. NULL is a no-op. */
void clankers_graph_free(ClankersGraph* graph);

/* Total number of parameters exposed by this graph (sum across all nodes). */
uint32_t clankers_graph_param_count(const ClankersGraph* graph);

/* Set one parameter by flat index (0..param_count). Out-of-range ignored. */
void clankers_graph_set_param(ClankersGraph* graph, uint32_t idx, float value);

/* JSON descriptor array for this specific graph's parameters. The pointer
 * is valid for the handle's lifetime; caller must NOT free it.
 *   [{"index":0,"node":"osc1","param":"freq","min":20,"max":20000,...}, ...]
 */
const char* clankers_graph_param_info(const ClankersGraph* graph);

/* Trigger a note with round-robin voice stealing. */
void clankers_graph_trigger(
    ClankersGraph* graph,
    uint8_t        midi_note,
    float          velocity,
    uint32_t       hold_samples);

/* Render n_samples stereo samples into caller-owned L/R buffers. */
void clankers_graph_process(
    ClankersGraph* graph,
    float*         out_l,
    float*         out_r,
    uint32_t       n_samples);

/* ── GraphFx ───────────────────────────────────────────────────────────────
 *
 * Graph-based stereo effects processor — same node library as SynthGraph
 * but processes an external stereo input. The graph must contain exactly
 * one `input` node and one `output` node.
 */

typedef struct ClankersGraphFx ClankersGraphFx;

/* Parse JSON and build an FX graph. Returns NULL on failure;
 * see clankers_last_error. */
ClankersGraphFx* clankers_graphfx_new(const char* graph_json, float sample_rate);

/* Rebuild nodes at a new SR; topology + params preserved. */
void clankers_graphfx_set_sample_rate(ClankersGraphFx* fx, float sample_rate);

/* Destroy. NULL is a no-op. */
void clankers_graphfx_free(ClankersGraphFx* fx);

uint32_t    clankers_graphfx_param_count(const ClankersGraphFx* fx);
void        clankers_graphfx_set_param  (ClankersGraphFx* fx, uint32_t idx, float value);
const char* clankers_graphfx_param_info (const ClankersGraphFx* fx);

/* Process n_samples frames. All four buffers must have capacity >= n_samples.
 * Outputs are overwritten (not mixed). */
void clankers_graphfx_process(
    ClankersGraphFx* fx,
    const float*     in_l,
    const float*     in_r,
    float*           out_l,
    float*           out_r,
    uint32_t         n_samples);

#ifdef __cplusplus
} /* extern "C" */
#endif

#endif /* CLANKERS_DSP_H */
