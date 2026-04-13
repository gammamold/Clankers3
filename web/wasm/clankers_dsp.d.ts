declare namespace wasm_bindgen {
    /* tslint:disable */
    /* eslint-disable */

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
        free(): void;
        [Symbol.dispose](): void;
        constructor(seed: number);
        /**
         * Render n_samples of audio using stored params. Returns mono Float32Array.
         */
        render(n_samples: number): Float32Array;
        /**
         * Update stored params — affects currently playing voices on the next render() call.
         */
        set_params(cc_json: string): void;
        /**
         * Trigger a note. Also updates stored params from cc_json.
         * hold_samples: note-on duration in samples (0 = use amp envelope only)
         */
        trigger(midi_note: number, velocity: number, hold_samples: number, cc_json: string): void;
        /**
         * Trigger + render full tail — isolated single voice, no shared state.
         */
        trigger_render(midi_note: number, velocity: number, hold_samples: number, cc_json: string): Float32Array;
    }

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
        free(): void;
        [Symbol.dispose](): void;
        constructor();
        /**
         * Render n_samples of audio. Returns mono Float32Array.
         */
        process(n_samples: number): Float32Array;
        /**
         * Update stored params — affects playing voices on the next process() call.
         */
        set_params(cc_json: string): void;
        /**
         * Trigger a voice using stored params.
         */
        trigger(midi_note: number, velocity: number): void;
        /**
         * Trigger + render full tail — isolated single voice.
         */
        trigger_render(midi_note: number, velocity: number, cc_json: string): Float32Array;
    }

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
        free(): void;
        [Symbol.dispose](): void;
        constructor(seed: number);
        /**
         * Render n_samples. Returns mono Float32Array.
         */
        process(n_samples: number): Float32Array;
        /**
         * Global decay multiplier (0.1..8.0). Updates active voices immediately.
         */
        set_decay(mult: number): void;
        /**
         * Global output lowpass cutoff in Hz (80..20000). Live.
         */
        set_filter(hz: number): void;
        /**
         * Global pitch shift in semitones (−12..+12).
         */
        set_pitch(semitones: number): void;
        /**
         * Select drum machine profile.  id: 0=808  1=909  2=606
         */
        set_profile(id: number): void;
        /**
         * Trigger a voice.  voice_id: 0-6.
         */
        trigger(voice_id: number, velocity: number): void;
    }

    /**
     * HybridSynth pads — Moog ladder + ADSR + chorus + reverb (8 polyphonic voices).
     *
     * Streaming API:
     *   set_params(cc_json)              — update stored params live
     *   trigger(midi_note, vel, hold)    — trigger using stored params
     *   process_stereo(n_samples)        — render → interleaved stereo Float32Array
     */
    export class ClankersPads {
        free(): void;
        [Symbol.dispose](): void;
        constructor();
        /**
         * Render n_samples. Returns interleaved stereo Float32Array [L0,R0,L1,R1,...].
         */
        process_stereo(n_samples: number): Float32Array;
        /**
         * Update stored params — affects playing voices live on next process_stereo() call.
         */
        set_params(cc_json: string): void;
        /**
         * Trigger a note using stored params.
         */
        trigger(midi_note: number, velocity: number, hold_samples: number): void;
        trigger_render(midi_note: number, velocity: number, hold_samples: number, cc_json: string): Float32Array;
    }

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
        free(): void;
        [Symbol.dispose](): void;
        constructor();
        /**
         * Render n_samples. Returns interleaved stereo Float32Array [L0,R0,L1,R1,...].
         */
        process_stereo(n_samples: number): Float32Array;
        /**
         * Update stored params — affects playing voices live on the next process_stereo() call.
         */
        set_params(cc_json: string): void;
        /**
         * Trigger a note using stored params.
         * hold_samples: note-on duration in samples.
         */
        trigger(midi_note: number, velocity: number, hold_samples: number): void;
        /**
         * Trigger + render full tail — stereo interleaved Float32Array.
         */
        trigger_render(midi_note: number, velocity: number, hold_samples: number, cc_json: string): Float32Array;
    }

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
        free(): void;
        [Symbol.dispose](): void;
        constructor(seed: number);
        /**
         * Number of phonemes in the built-in table (25).
         */
        static phoneme_count(): number;
        /**
         * Render n_samples of audio.  Returns mono Float32Array.
         */
        process(n_samples: number): Float32Array;
        /**
         * Send note-off to the most recently triggered voice.
         */
        release(): void;
        /**
         * Update stored params from CC JSON object.
         */
        set_params(cc_json: string): void;
        /**
         * Set the active phoneme target (0-24).  All voices interpolate toward it.
         */
        set_phoneme(idx: number): void;
        /**
         * Set a phoneme sequence from a JSON integer array, e.g. "[0,8,2,11]".
         * The last triggered voice will step through the sequence over its hold duration.
         */
        set_phonemes(json: string, hold_samps: number): void;
        /**
         * Vowel-pad mode: x=F1 axis (0=high/closed..1=low/open),
         * y=F2 axis (0=back..1=front).  All voices update live.
         */
        set_xy(x: number, y: number): void;
        /**
         * Trigger a note.  Also updates params from cc_json.
         * hold_samples: note-on duration in samples (0 = sustain until release()).
         */
        trigger(midi_note: number, velocity: number, hold_samples: number, cc_json: string): void;
    }

}
declare type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

declare interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_clankersbass_free: (a: number, b: number) => void;
    readonly __wbg_clankersbuchla_free: (a: number, b: number) => void;
    readonly __wbg_clankersdrums_free: (a: number, b: number) => void;
    readonly __wbg_clankerspads_free: (a: number, b: number) => void;
    readonly __wbg_clankersrhodes_free: (a: number, b: number) => void;
    readonly __wbg_clankersvoder_free: (a: number, b: number) => void;
    readonly clankersbass_new: (a: number) => number;
    readonly clankersbass_render: (a: number, b: number) => any;
    readonly clankersbass_set_params: (a: number, b: number, c: number) => void;
    readonly clankersbass_trigger: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly clankersbass_trigger_render: (a: number, b: number, c: number, d: number, e: number, f: number) => any;
    readonly clankersbuchla_new: () => number;
    readonly clankersbuchla_process: (a: number, b: number) => any;
    readonly clankersbuchla_set_params: (a: number, b: number, c: number) => void;
    readonly clankersbuchla_trigger: (a: number, b: number, c: number) => void;
    readonly clankersbuchla_trigger_render: (a: number, b: number, c: number, d: number, e: number) => any;
    readonly clankersdrums_new: (a: number) => number;
    readonly clankersdrums_process: (a: number, b: number) => any;
    readonly clankersdrums_set_decay: (a: number, b: number) => void;
    readonly clankersdrums_set_filter: (a: number, b: number) => void;
    readonly clankersdrums_set_pitch: (a: number, b: number) => void;
    readonly clankersdrums_set_profile: (a: number, b: number) => void;
    readonly clankersdrums_trigger: (a: number, b: number, c: number) => void;
    readonly clankerspads_new: () => number;
    readonly clankerspads_process_stereo: (a: number, b: number) => any;
    readonly clankerspads_set_params: (a: number, b: number, c: number) => void;
    readonly clankerspads_trigger: (a: number, b: number, c: number, d: number) => void;
    readonly clankerspads_trigger_render: (a: number, b: number, c: number, d: number, e: number, f: number) => any;
    readonly clankersrhodes_new: () => number;
    readonly clankersrhodes_process_stereo: (a: number, b: number) => any;
    readonly clankersrhodes_set_params: (a: number, b: number, c: number) => void;
    readonly clankersrhodes_trigger: (a: number, b: number, c: number, d: number) => void;
    readonly clankersrhodes_trigger_render: (a: number, b: number, c: number, d: number, e: number, f: number) => any;
    readonly clankersvoder_new: (a: number) => number;
    readonly clankersvoder_phoneme_count: () => number;
    readonly clankersvoder_process: (a: number, b: number) => any;
    readonly clankersvoder_release: (a: number) => void;
    readonly clankersvoder_set_params: (a: number, b: number, c: number) => void;
    readonly clankersvoder_set_phoneme: (a: number, b: number) => void;
    readonly clankersvoder_set_phonemes: (a: number, b: number, c: number, d: number) => void;
    readonly clankersvoder_set_xy: (a: number, b: number, c: number) => void;
    readonly clankersvoder_trigger: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_start: () => void;
}

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
declare function wasm_bindgen (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
