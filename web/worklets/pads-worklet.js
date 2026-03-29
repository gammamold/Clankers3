/**
 * Pads AudioWorkletProcessor — Clankers 3  (stereo output)
 *
 * Real-time streaming HybridSynth pads. Filter, reverb, chorus update live.
 *
 * Messages IN:
 *   { type:'trigger', audioTime, midiNote, velocity, holdSamples, ccJson? }
 *   { type:'setParams', ccJson }   — live knob update
 *   { type:'stop' }
 *
 * Messages OUT:
 *   { type:'ready' }
 *   { type:'error', message }
 */

import { initSync, ClankersPads } from '../wasm/clankers_dsp.js';

class PadsWorkletProcessor extends AudioWorkletProcessor {
    constructor(options) {
        super();
        this._engine = null;
        this._queue  = [];

        try {
            const wasmModule = options?.processorOptions?.wasmModule;
            if (wasmModule) initSync({ module: wasmModule });
            this._engine = new ClankersPads();
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
        const outL = outputs[0]?.[0];
        const outR = outputs[0]?.[1];
        if (!this._engine || !outL) return true;

        const blockEnd = currentTime + outL.length / sampleRate;
        while (this._queue.length && this._queue[0].audioTime <= blockEnd) {
            const ev = this._queue.shift();
            if (ev.ccJson) this._engine.set_params(ev.ccJson);
            this._engine.trigger(ev.midiNote, ev.velocity, ev.holdSamples ?? 0);
        }

        const interleaved = this._engine.process_stereo(outL.length);
        const frames = outL.length;
        for (let i = 0; i < frames; i++) {
            outL[i] = interleaved[i * 2];
            if (outR) outR[i] = interleaved[i * 2 + 1];
        }
        return true;
    }
}

registerProcessor('pads-worklet', PadsWorkletProcessor);
