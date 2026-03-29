/**
 * Drums AudioWorkletProcessor — Clankers 3
 *
 * Messages IN:
 *   { type:'trigger',   audioTime, voiceId, velocity }
 *   { type:'setProfile', profileId }          0=808  1=909  2=606
 *   { type:'setPitch',   semitones }           −12..+12
 *   { type:'setDecay',   mult }                0.1..8.0
 *   { type:'setFilter',  hz }                  80..20000
 *   { type:'stop' }
 *
 * Messages OUT:
 *   { type:'ready' }
 *   { type:'error', message }
 */

import { initSync, ClankersDrums } from '../wasm/clankers_dsp.js';

class DrumsWorkletProcessor extends AudioWorkletProcessor {
    constructor(options) {
        super();
        this._engine = null;
        this._queue  = [];

        try {
            const wasmModule = options?.processorOptions?.wasmModule;
            if (wasmModule) initSync({ module: wasmModule });
            const seed = options?.processorOptions?.seed ?? 0xd8d8d8;
            this._engine = new ClankersDrums(seed);
            this.port.postMessage({ type: 'ready' });
        } catch (e) {
            this.port.postMessage({ type: 'error', message: String(e) });
        }

        this.port.onmessage = ({ data }) => {
            if (!this._engine) return;
            switch (data.type) {
                case 'trigger':
                    this._queue.push(data);
                    break;
                case 'setProfile':
                    this._engine.set_profile(data.profileId);
                    break;
                case 'setPitch':
                    this._engine.set_pitch(data.semitones);
                    break;
                case 'setDecay':
                    this._engine.set_decay(data.mult);
                    break;
                case 'setFilter':
                    this._engine.set_filter(data.hz);
                    break;
                case 'stop':
                    this._queue = [];
                    break;
            }
        };
    }

    process(_inputs, outputs) {
        const out = outputs[0]?.[0];
        if (!this._engine || !out) return true;

        const blockEnd = currentTime + out.length / sampleRate;
        while (this._queue.length && this._queue[0].audioTime <= blockEnd) {
            const ev = this._queue.shift();
            this._engine.trigger(ev.voiceId, ev.velocity);
        }

        out.set(this._engine.process(out.length));
        return true;
    }
}

registerProcessor('drums-worklet', DrumsWorkletProcessor);
