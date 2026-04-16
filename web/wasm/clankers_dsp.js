/* @ts-self-types="./clankers_dsp.d.ts" */

/**
 * FM bass — sine carrier + sine modulator + TPT ladder LPF + pluck envelopes (8 voices).
 *
 * YZ pad CC map (t:2):
 *   CC71 fm_index   CC74 cutoff   CC23 flt_decay   CC75 amp_decay
 *
 * Streaming API:
 *   set_params(cc_json)              — update stored params (affects playing voices live)
 *   trigger(midi_note, vel, hold, cc_json) — trigger note (also updates stored params)
 *   render(n_samples)               — process all active voices with stored params
 *
 * Offline API:
 *   trigger_render(...)             — trigger + render full tail in one call
 */
export class ClankersBass {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        ClankersBassFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_clankersbass_free(ptr, 0);
    }
    /**
     * @param {number} seed
     */
    constructor(seed) {
        const ret = wasm.clankersbass_new(seed);
        this.__wbg_ptr = ret >>> 0;
        ClankersBassFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Render n_samples of audio using stored params. Returns mono Float32Array.
     * @param {number} n_samples
     * @returns {Float32Array}
     */
    render(n_samples) {
        const ret = wasm.clankersbass_render(this.__wbg_ptr, n_samples);
        return ret;
    }
    /**
     * Update stored params — affects currently playing voices on the next render() call.
     * @param {string} cc_json
     */
    set_params(cc_json) {
        const ptr0 = passStringToWasm0(cc_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.clankersbass_set_params(this.__wbg_ptr, ptr0, len0);
    }
    /**
     * Trigger a note. Also updates stored params from cc_json.
     * hold_samples: note-on duration in samples (0 = use amp envelope only)
     * @param {number} midi_note
     * @param {number} velocity
     * @param {number} hold_samples
     * @param {string} cc_json
     */
    trigger(midi_note, velocity, hold_samples, cc_json) {
        const ptr0 = passStringToWasm0(cc_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.clankersbass_trigger(this.__wbg_ptr, midi_note, velocity, hold_samples, ptr0, len0);
    }
    /**
     * Trigger + render full tail — isolated single voice, no shared state.
     * @param {number} midi_note
     * @param {number} velocity
     * @param {number} hold_samples
     * @param {string} cc_json
     * @returns {Float32Array}
     */
    trigger_render(midi_note, velocity, hold_samples, cc_json) {
        const ptr0 = passStringToWasm0(cc_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.clankersbass_trigger_render(this.__wbg_ptr, midi_note, velocity, hold_samples, ptr0, len0);
        return ret;
    }
}
if (Symbol.dispose) ClankersBass.prototype[Symbol.dispose] = ClankersBass.prototype.free;

/**
 * Buchla 259/292 — percussive LPG arp with FM + wavefolding (8 voices).
 *
 * ClankerBoy CC map (t:1):
 *   CC74 cutoff  CC71 resonance  CC20 wavefold  CC17 fm_depth
 *   CC18 fm_index  CC19 env_decay  CC16 volume
 *
 * Streaming API:
 *   set_params(cc_json)    — update stored params (affects playing voices live)
 *   trigger(midi_note, vel) — trigger using stored params
 *   process(n_samples)     — render all active voices → mono Float32Array
 */
export class ClankersBuchla {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        ClankersBuchlaFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_clankersbuchla_free(ptr, 0);
    }
    constructor() {
        const ret = wasm.clankersbuchla_new();
        this.__wbg_ptr = ret >>> 0;
        ClankersBuchlaFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Render n_samples of audio. Returns mono Float32Array.
     * @param {number} n_samples
     * @returns {Float32Array}
     */
    process(n_samples) {
        const ret = wasm.clankersbuchla_process(this.__wbg_ptr, n_samples);
        return ret;
    }
    /**
     * Update stored params — affects playing voices on the next process() call.
     * @param {string} cc_json
     */
    set_params(cc_json) {
        const ptr0 = passStringToWasm0(cc_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.clankersbuchla_set_params(this.__wbg_ptr, ptr0, len0);
    }
    /**
     * Trigger a voice using stored params.
     * @param {number} midi_note
     * @param {number} velocity
     */
    trigger(midi_note, velocity) {
        wasm.clankersbuchla_trigger(this.__wbg_ptr, midi_note, velocity);
    }
    /**
     * Trigger + render full tail — isolated single voice.
     * @param {number} midi_note
     * @param {number} velocity
     * @param {string} cc_json
     * @returns {Float32Array}
     */
    trigger_render(midi_note, velocity, cc_json) {
        const ptr0 = passStringToWasm0(cc_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.clankersbuchla_trigger_render(this.__wbg_ptr, midi_note, velocity, ptr0, len0);
        return ret;
    }
}
if (Symbol.dispose) ClankersBuchla.prototype[Symbol.dispose] = ClankersBuchla.prototype.free;

/**
 * Three-profile synth drum machine (808 / 909 / 606).
 *
 * Voice IDs  0-6 — character depends on selected profile:
 *   808 →  KICK  SNARE  HH-CL  HH-OP  TOM-L  TOM-H  CLAP
 *   909 →  KICK  SNARE  HH-CL  HH-OP  TOM-L  TOM-M  TOM-H
 *   606 →  KICK  SNARE  HH-CL  HH-OP  TOM-L  TOM-H  CYMBAL
 *
 * Global controls (all live — take effect within one audio block):
 *   set_profile(id)        0=808  1=909  2=606
 *   set_pitch(semitones)   −12..+12
 *   set_decay(mult)        0.1..8.0  (scales all amp-decay times)
 *   set_filter(hz)         80..20000 (one-pole LP on output bus)
 */
export class ClankersDrums {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        ClankersDrumsFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_clankersdrums_free(ptr, 0);
    }
    /**
     * @param {number} seed
     */
    constructor(seed) {
        const ret = wasm.clankersdrums_new(seed);
        this.__wbg_ptr = ret >>> 0;
        ClankersDrumsFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Render n_samples. Returns mono Float32Array.
     * @param {number} n_samples
     * @returns {Float32Array}
     */
    process(n_samples) {
        const ret = wasm.clankersdrums_process(this.__wbg_ptr, n_samples);
        return ret;
    }
    /**
     * Global decay multiplier (0.1..8.0). Updates active voices immediately.
     * @param {number} mult
     */
    set_decay(mult) {
        wasm.clankersdrums_set_decay(this.__wbg_ptr, mult);
    }
    /**
     * Global output lowpass cutoff in Hz (80..20000). Live.
     * @param {number} hz
     */
    set_filter(hz) {
        wasm.clankersdrums_set_filter(this.__wbg_ptr, hz);
    }
    /**
     * Global pitch shift in semitones (−12..+12).
     * @param {number} semitones
     */
    set_pitch(semitones) {
        wasm.clankersdrums_set_pitch(this.__wbg_ptr, semitones);
    }
    /**
     * Select drum machine profile.  id: 0=808  1=909  2=606
     * @param {number} id
     */
    set_profile(id) {
        wasm.clankersdrums_set_profile(this.__wbg_ptr, id);
    }
    /**
     * Trigger a voice.  voice_id: 0-6.
     * @param {number} voice_id
     * @param {number} velocity
     */
    trigger(voice_id, velocity) {
        wasm.clankersdrums_trigger(this.__wbg_ptr, voice_id, velocity);
    }
}
if (Symbol.dispose) ClankersDrums.prototype[Symbol.dispose] = ClankersDrums.prototype.free;

/**
 * HybridSynth pads — Moog ladder + ADSR + chorus + reverb (8 polyphonic voices).
 *
 * Streaming API:
 *   set_params(cc_json)              — update stored params live
 *   trigger(midi_note, vel, hold)    — trigger using stored params
 *   process_stereo(n_samples)        — render → interleaved stereo Float32Array
 */
export class ClankersPads {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        ClankersPadsFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_clankerspads_free(ptr, 0);
    }
    constructor() {
        const ret = wasm.clankerspads_new();
        this.__wbg_ptr = ret >>> 0;
        ClankersPadsFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Render n_samples. Returns interleaved stereo Float32Array [L0,R0,L1,R1,...].
     * @param {number} n_samples
     * @returns {Float32Array}
     */
    process_stereo(n_samples) {
        const ret = wasm.clankerspads_process_stereo(this.__wbg_ptr, n_samples);
        return ret;
    }
    /**
     * Update stored params — affects playing voices live on next process_stereo() call.
     * @param {string} cc_json
     */
    set_params(cc_json) {
        const ptr0 = passStringToWasm0(cc_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.clankerspads_set_params(this.__wbg_ptr, ptr0, len0);
    }
    /**
     * Trigger a note using stored params.
     * @param {number} midi_note
     * @param {number} velocity
     * @param {number} hold_samples
     */
    trigger(midi_note, velocity, hold_samples) {
        wasm.clankerspads_trigger(this.__wbg_ptr, midi_note, velocity, hold_samples);
    }
    /**
     * @param {number} midi_note
     * @param {number} velocity
     * @param {number} hold_samples
     * @param {string} cc_json
     * @returns {Float32Array}
     */
    trigger_render(midi_note, velocity, hold_samples, cc_json) {
        const ptr0 = passStringToWasm0(cc_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.clankerspads_trigger_render(this.__wbg_ptr, midi_note, velocity, hold_samples, ptr0, len0);
        return ret;
    }
}
if (Symbol.dispose) ClankersPads.prototype[Symbol.dispose] = ClankersPads.prototype.free;

/**
 * Rhodes electric piano — FM tine model (Operator / Lounge Lizard style).
 *
 * ClankerBoy t:3 CC map:
 *   CC74  Brightness  CC72  Decay  CC20  Tine ratio  CC73  Bark time
 *   CC26  Tremolo rate  CC27  Tremolo depth
 *   CC29  Chorus rate   CC30  Chorus mix   CC10  Pan
 *
 * Streaming API:
 *   set_params(cc_json)               — update stored params live
 *   trigger(midi_note, vel, hold)     — trigger using stored params
 *   process_stereo(n_samples)         — render → interleaved stereo Float32Array
 */
export class ClankersRhodes {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        ClankersRhodesFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_clankersrhodes_free(ptr, 0);
    }
    constructor() {
        const ret = wasm.clankersrhodes_new();
        this.__wbg_ptr = ret >>> 0;
        ClankersRhodesFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Render n_samples. Returns interleaved stereo Float32Array [L0,R0,L1,R1,...].
     * @param {number} n_samples
     * @returns {Float32Array}
     */
    process_stereo(n_samples) {
        const ret = wasm.clankersrhodes_process_stereo(this.__wbg_ptr, n_samples);
        return ret;
    }
    /**
     * Update stored params — affects playing voices live on the next process_stereo() call.
     * @param {string} cc_json
     */
    set_params(cc_json) {
        const ptr0 = passStringToWasm0(cc_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.clankersrhodes_set_params(this.__wbg_ptr, ptr0, len0);
    }
    /**
     * Trigger a note using stored params.
     * hold_samples: note-on duration in samples.
     * @param {number} midi_note
     * @param {number} velocity
     * @param {number} hold_samples
     */
    trigger(midi_note, velocity, hold_samples) {
        wasm.clankersrhodes_trigger(this.__wbg_ptr, midi_note, velocity, hold_samples);
    }
    /**
     * Trigger + render full tail — stereo interleaved Float32Array.
     * @param {number} midi_note
     * @param {number} velocity
     * @param {number} hold_samples
     * @param {string} cc_json
     * @returns {Float32Array}
     */
    trigger_render(midi_note, velocity, hold_samples, cc_json) {
        const ptr0 = passStringToWasm0(cc_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.clankersrhodes_trigger_render(this.__wbg_ptr, midi_note, velocity, hold_samples, ptr0, len0);
        return ret;
    }
}
if (Symbol.dispose) ClankersRhodes.prototype[Symbol.dispose] = ClankersRhodes.prototype.free;

/**
 * Graph-based modular synth — LLM designs the signal chain, WASM executes it.
 *
 * The LLM outputs a JSON graph describing nodes (oscillators, filters, envelopes,
 * effects) and connections between them. This engine instantiates the graph as
 * a polyphonic instrument with per-sample processing.
 *
 * Streaming API:
 *   set_param(param_index, value)          — update a parameter live
 *   trigger(midi_note, vel, hold_samples)  — trigger a voice
 *   process_stereo(n_samples)              — render → interleaved stereo Float32Array
 *   param_info()                           — JSON array of param descriptors
 *   param_count()                          — number of tweakable params
 */
export class ClankersSynthGraph {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        ClankersSynthGraphFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_clankerssynthgraph_free(ptr, 0);
    }
    /**
     * Construct from graph JSON + number of polyphonic voices (1-16).
     * @param {string} graph_json
     * @param {number} num_voices
     */
    constructor(graph_json, num_voices) {
        const ptr0 = passStringToWasm0(graph_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.clankerssynthgraph_new(ptr0, len0, num_voices);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        this.__wbg_ptr = ret[0] >>> 0;
        ClankersSynthGraphFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Number of tweakable parameters.
     * @returns {number}
     */
    param_count() {
        const ret = wasm.clankerssynthgraph_param_count(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Returns JSON array of param descriptors:
     * [{"index":0,"node":"osc1","param":"waveform","min":0,"max":4,"default":0}, ...]
     * @returns {string}
     */
    param_info() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.clankerssynthgraph_param_info(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * Render n_samples. Returns interleaved stereo Float32Array [L0,R0,L1,R1,...].
     * @param {number} n_samples
     * @returns {Float32Array}
     */
    process_stereo(n_samples) {
        const ret = wasm.clankerssynthgraph_process_stereo(this.__wbg_ptr, n_samples);
        return ret;
    }
    /**
     * Update a parameter by flat index (see param_info for the mapping).
     * @param {number} param_index
     * @param {number} value
     */
    set_param(param_index, value) {
        wasm.clankerssynthgraph_set_param(this.__wbg_ptr, param_index, value);
    }
    /**
     * Trigger a note. hold_samples: note-on duration in samples (0 = use envelope only).
     * @param {number} midi_note
     * @param {number} velocity
     * @param {number} hold_samples
     */
    trigger(midi_note, velocity, hold_samples) {
        wasm.clankerssynthgraph_trigger(this.__wbg_ptr, midi_note, velocity, hold_samples);
    }
}
if (Symbol.dispose) ClankersSynthGraph.prototype[Symbol.dispose] = ClankersSynthGraph.prototype.free;

/**
 * Parallel-formant Voder — 4-voice polyphonic formant synthesizer.
 *
 * Inspired by the 1939 Bell Laboratories Voder.  Glottal pulse + aspiration
 * noise drive a bank of 5 parallel biquad resonators whose centre frequencies
 * interpolate smoothly between phoneme targets (coarticulation).
 *
 * Phoneme indices (0-24):
 *   0 AA   1 AE   2 AH   3 AO   4 EH   5 ER   6 EY   7 IH   8 IY
 *   9 OW  10 UH  11 UW  12 L   13 R   14 W   15 Y   16 M   17 N
 *  18 F   19 S   20 SH  21 TH  22 V   23 Z   24 ZH
 *
 * CC map:
 *   CC74  brightness     0-127 → 0.5-1.5× formant freq scale
 *   CC20  voicing        0-127 → 0-1 manual override (0 = phoneme's voicing)
 *   CC73  attack_ms      0-127 → 1-100 ms
 *   CC72  release_ms     0-127 → 10-500 ms
 *   CC75  vibrato_depth  0-127 → 0-80 cents
 *   CC76  vibrato_rate   0-127 → 3-8 Hz
 *   CC77  coartic_ms     0-127 → 5-80 ms
 *   CC16  volume         0-127 → 0-1
 *
 * Streaming API:
 *   set_params(cc_json)
 *   set_phoneme(idx)                   — change formant target live
 *   set_phonemes(json_array)           — "[0,8,11]" phoneme sequence
 *   set_xy(x, y)                       — vowel-pad mode (0..1 each axis)
 *   trigger(midi_note, vel, hold_samps, cc_json)
 *   release()                          — note-off for sustained voices
 *   process(n_samples)                 — render mono Float32Array
 *   phoneme_count()                    — returns 25
 */
export class ClankersVoder {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        ClankersVoderFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_clankersvoder_free(ptr, 0);
    }
    /**
     * @param {number} seed
     */
    constructor(seed) {
        const ret = wasm.clankersvoder_new(seed);
        this.__wbg_ptr = ret >>> 0;
        ClankersVoderFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Number of phonemes in the built-in table (25).
     * @returns {number}
     */
    static phoneme_count() {
        const ret = wasm.clankersvoder_phoneme_count();
        return ret >>> 0;
    }
    /**
     * Render n_samples of audio.  Returns mono Float32Array.
     * @param {number} n_samples
     * @returns {Float32Array}
     */
    process(n_samples) {
        const ret = wasm.clankersvoder_process(this.__wbg_ptr, n_samples);
        return ret;
    }
    /**
     * Send note-off to the most recently triggered voice.
     */
    release() {
        wasm.clankersvoder_release(this.__wbg_ptr);
    }
    /**
     * Update stored params from CC JSON object.
     * @param {string} cc_json
     */
    set_params(cc_json) {
        const ptr0 = passStringToWasm0(cc_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.clankersvoder_set_params(this.__wbg_ptr, ptr0, len0);
    }
    /**
     * Set the active phoneme target (0-24).  All voices interpolate toward it.
     * @param {number} idx
     */
    set_phoneme(idx) {
        wasm.clankersvoder_set_phoneme(this.__wbg_ptr, idx);
    }
    /**
     * Set a phoneme sequence from a JSON integer array, e.g. "[0,8,2,11]".
     * The last triggered voice will step through the sequence over its hold duration.
     * @param {string} json
     * @param {number} hold_samps
     */
    set_phonemes(json, hold_samps) {
        const ptr0 = passStringToWasm0(json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.clankersvoder_set_phonemes(this.__wbg_ptr, ptr0, len0, hold_samps);
    }
    /**
     * Vowel-pad mode: x=F1 axis (0=high/closed..1=low/open),
     * y=F2 axis (0=back..1=front).  All voices update live.
     * @param {number} x
     * @param {number} y
     */
    set_xy(x, y) {
        wasm.clankersvoder_set_xy(this.__wbg_ptr, x, y);
    }
    /**
     * Trigger a note.  Also updates params from cc_json.
     * hold_samples: note-on duration in samples (0 = sustain until release()).
     * @param {number} midi_note
     * @param {number} velocity
     * @param {number} hold_samples
     * @param {string} cc_json
     */
    trigger(midi_note, velocity, hold_samples, cc_json) {
        const ptr0 = passStringToWasm0(cc_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.clankersvoder_trigger(this.__wbg_ptr, midi_note, velocity, hold_samples, ptr0, len0);
    }
}
if (Symbol.dispose) ClankersVoder.prototype[Symbol.dispose] = ClankersVoder.prototype.free;
function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg_Error_960c155d3d49e4c2: function(arg0, arg1) {
            const ret = Error(getStringFromWasm0(arg0, arg1));
            return ret;
        },
        __wbg___wbindgen_throw_6b64449b9b9ed33c: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbg_new_from_slice_b6858b485924da4e: function(arg0, arg1) {
            const ret = new Float32Array(getArrayF32FromWasm0(arg0, arg1));
            return ret;
        },
        __wbindgen_init_externref_table: function() {
            const table = wasm.__wbindgen_externrefs;
            const offset = table.grow(4);
            table.set(0, undefined);
            table.set(offset + 0, undefined);
            table.set(offset + 1, null);
            table.set(offset + 2, true);
            table.set(offset + 3, false);
        },
    };
    return {
        __proto__: null,
        "./clankers_dsp_bg.js": import0,
    };
}

const ClankersBassFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_clankersbass_free(ptr >>> 0, 1));
const ClankersBuchlaFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_clankersbuchla_free(ptr >>> 0, 1));
const ClankersDrumsFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_clankersdrums_free(ptr >>> 0, 1));
const ClankersPadsFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_clankerspads_free(ptr >>> 0, 1));
const ClankersRhodesFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_clankersrhodes_free(ptr >>> 0, 1));
const ClankersSynthGraphFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_clankerssynthgraph_free(ptr >>> 0, 1));
const ClankersVoderFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_clankersvoder_free(ptr >>> 0, 1));

function getArrayF32FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getFloat32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}

let cachedFloat32ArrayMemory0 = null;
function getFloat32ArrayMemory0() {
    if (cachedFloat32ArrayMemory0 === null || cachedFloat32ArrayMemory0.byteLength === 0) {
        cachedFloat32ArrayMemory0 = new Float32Array(wasm.memory.buffer);
    }
    return cachedFloat32ArrayMemory0;
}

function getStringFromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return decodeText(ptr, len);
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function passStringToWasm0(arg, malloc, realloc) {
    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8ArrayMemory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }
    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
        const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
        const ret = cachedTextEncoder.encodeInto(arg, view);

        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
    return ptr;
}

function takeFromExternrefTable0(idx) {
    const value = wasm.__wbindgen_externrefs.get(idx);
    wasm.__externref_table_dealloc(idx);
    return value;
}

// ── AudioWorkletGlobalScope polyfills ─────────────────────────────────────────
if (typeof TextDecoder === 'undefined') {
    globalThis.TextDecoder = class TextDecoder {
        constructor(_e, _o) {}
        decode(buf) {
            if (!buf || buf.byteLength === 0) return '';
            const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf.buffer ?? buf);
            let s = '', i = 0;
            while (i < b.length) {
                const c = b[i++];
                if (c < 0x80) { s += String.fromCharCode(c); }
                else if ((c & 0xE0) === 0xC0) { s += String.fromCharCode(((c&0x1F)<<6)|(b[i++]&0x3F)); }
                else if ((c & 0xF0) === 0xE0) { s += String.fromCharCode(((c&0x0F)<<12)|((b[i++]&0x3F)<<6)|(b[i++]&0x3F)); }
                else { const p=((c&7)<<18)|((b[i++]&0x3F)<<12)|((b[i++]&0x3F)<<6)|(b[i++]&0x3F); const u=p-0x10000; s+=String.fromCharCode(0xD800+(u>>10),0xDC00+(u&0x3FF)); }
            }
            return s;
        }
    };
}
if (typeof TextEncoder === 'undefined') {
    globalThis.TextEncoder = class TextEncoder {
        encode(s) {
            const o=[];
            for (let i=0;i<s.length;i++) {
                let c=s.charCodeAt(i);
                if(c>=0xD800&&c<=0xDBFF) c=0x10000+((c-0xD800)<<10)+(s.charCodeAt(++i)-0xDC00);
                if(c<0x80) o.push(c);
                else if(c<0x800) o.push(0xC0|(c>>6),0x80|(c&0x3F));
                else if(c<0x10000) o.push(0xE0|(c>>12),0x80|((c>>6)&0x3F),0x80|(c&0x3F));
                else o.push(0xF0|(c>>18),0x80|((c>>12)&0x3F),0x80|((c>>6)&0x3F),0x80|(c&0x3F));
            }
            return new Uint8Array(o);
        }
        encodeInto(s,v){const b=this.encode(s);v.set(b);return{read:s.length,written:b.length};}
    };
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
        cachedTextDecoder.decode();
        numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

const cachedTextEncoder = new TextEncoder();

if (!('encodeInto' in cachedTextEncoder)) {
    cachedTextEncoder.encodeInto = function (arg, view) {
        const buf = cachedTextEncoder.encode(arg);
        view.set(buf);
        return {
            read: arg.length,
            written: buf.length
        };
    };
}

let WASM_VECTOR_LEN = 0;

let wasmModule, wasm;
function __wbg_finalize_init(instance, module) {
    wasm = instance.exports;
    wasmModule = module;
    cachedFloat32ArrayMemory0 = null;
    cachedUint8ArrayMemory0 = null;
    wasm.__wbindgen_start();
    return wasm;
}

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);
            } catch (e) {
                const validResponse = module.ok && expectedResponseType(module.type);

                if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else { throw e; }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);
    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };
        } else {
            return instance;
        }
    }

    function expectedResponseType(type) {
        switch (type) {
            case 'basic': case 'cors': case 'default': return true;
        }
        return false;
    }
}

function initSync(module) {
    if (wasm !== undefined) return wasm;


    if (module !== undefined) {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports();
    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }
    const instance = new WebAssembly.Instance(module, imports);
    return __wbg_finalize_init(instance, module);
}

async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;


    if (module_or_path !== undefined) {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (module_or_path === undefined) {
        module_or_path = new URL('clankers_dsp_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync, __wbg_init as default };
