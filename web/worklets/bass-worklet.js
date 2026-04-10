/**
 * Bass AudioWorkletProcessor — Clankers 3
 *
 * Real-time streaming Pro-One bass. Params update live on playing voices.
 *
 * Messages IN:
 *   { type:'trigger', audioTime, midiNote, velocity, holdSamples, ccJson }
 *   { type:'setParams', ccJson }   — live knob update (affects playing voices)
 *   { type:'stop' }
 *
 * Messages OUT:
 *   { type:'ready' }
 *   { type:'error', message }
 */

import { initSync, ClankersBass } from '../wasm/clankers_dsp.js';

class BassWorkletProcessor extends AudioWorkletProcessor {
    constructor(options) {
        super();
        this._engine    = null;
        this._queue     = [];
        this._errCount  = 0;

        try {
            const { wasmModule, seed = 0xba55ba55 } = options?.processorOptions ?? {};
            if (wasmModule) initSync({ module: wasmModule });
            this._engine = new ClankersBass(seed);
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
                case 'setParams':
                    try { this._engine.set_params(data.ccJson); } catch (_) {}
                    break;
                case 'stop':
                    this._queue = [];
                    break;
            }
        };
    }

    process(_inputs, outputs) {
        const out = outputs[0]?.[0];
        if (!out) return true;

        if (!this._engine) {
            out.fill(0);
            return true;
        }

        try {
            const blockEnd = currentTime + out.length / sampleRate;
            while (this._queue.length && this._queue[0].audioTime <= blockEnd) {
                const ev = this._queue.shift();
                this._engine.trigger(ev.midiNote, ev.velocity,
                                     ev.holdSamples ?? 0, ev.ccJson ?? '{}');
            }

            const buf = this._engine.render(out.length);
            out.set(buf.length <= out.length ? buf : buf.subarray(0, out.length));
        } catch (e) {
            out.fill(0);
            if (this._errCount++ < 3) {
                this.port.postMessage({ type: 'error', message: `process: ${e}` });
            }
        }

        return true;
    }
}

registerProcessor('bass-worklet', BassWorkletProcessor);
