/**
 * Buchla AudioWorkletProcessor — Clankers 3
 *
 * Real-time streaming Buchla 259/292 LPG synth. Params (fold, release, cutoff)
 * update live on playing voices via setParams.
 *
 * Messages IN:
 *   { type:'trigger', audioTime, midiNote, velocity, ccJson? }
 *   { type:'setParams', ccJson }   — live XY-pad / knob update
 *   { type:'stop' }
 *
 * Messages OUT:
 *   { type:'ready' }
 *   { type:'error', message }
 */

import { initSync, ClankersBuchla } from '../wasm/clankers_dsp.js';

class BuchlaWorkletProcessor extends AudioWorkletProcessor {
    constructor(options) {
        super();
        this._engine = null;
        this._queue  = [];

        try {
            const wasmModule = options?.processorOptions?.wasmModule;
            if (wasmModule) initSync({ module: wasmModule });
            this._engine = new ClankersBuchla();
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
            if (ev.ccJson) this._engine.set_params(ev.ccJson);
            this._engine.trigger(ev.midiNote, ev.velocity);
        }

        const buf = this._engine.process(out.length);
        out.set(buf);
        return true;
    }
}

registerProcessor('buchla-worklet', BuchlaWorkletProcessor);
