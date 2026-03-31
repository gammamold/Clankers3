/**
 * Poly FM Bass AudioWorkletProcessor — Clankers 3  [t:1]
 *
 * Polyphonic FM bass using the same ClankersBass engine as t:2.
 * Registered under 'buchla-worklet' to preserve node name references.
 *
 * Messages IN:
 *   { type:'trigger', audioTime, midiNote, velocity, holdSamples, ccJson? }
 *   { type:'setParams', ccJson }   — live YZ-pad update
 *   { type:'stop' }
 *
 * Messages OUT:
 *   { type:'ready' }
 *   { type:'error', message }
 */

import { initSync, ClankersBass } from '../wasm/clankers_dsp.js';

class PolyBassWorkletProcessor extends AudioWorkletProcessor {
    constructor(options) {
        super();
        this._engine = null;
        this._queue  = [];

        try {
            const wasmModule = options?.processorOptions?.wasmModule;
            if (wasmModule) initSync({ module: wasmModule });
            const seed = options?.processorOptions?.seed ?? 0xb455b456;
            this._engine = new ClankersBass(seed);
            this.port.postMessage({ type: 'ready' });
        } catch (e) {
            this.port.postMessage({ type: 'error', message: String(e) });
        }

        this.port.onmessage = ({ data }) => {
            if (!this._engine) return;
            if (data.type === 'trigger') {
                this._queue.push(data);
            } else if (data.type === 'setParams') {
                this._engine.set_params(data.ccJson);
            } else if (data.type === 'stop') {
                this._queue = [];
            }
        };
    }

    process(_inputs, outputs) {
        const out = outputs[0]?.[0];
        if (!this._engine || !out) return true;

        const blockEnd = currentTime + out.length / sampleRate;
        while (this._queue.length && this._queue[0].audioTime <= blockEnd) {
            const ev = this._queue.shift();
            this._engine.trigger(ev.midiNote, ev.velocity,
                                 ev.holdSamples ?? 22050, ev.ccJson ?? '{}');
        }

        const buf = this._engine.render(out.length);
        out.set(buf);
        return true;
    }
}

registerProcessor('buchla-worklet', PolyBassWorkletProcessor);
