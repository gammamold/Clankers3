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
        this._engine    = null;
        this._queue     = [];
        this._errCount  = 0;

        try {
            const { wasmModule } = options?.processorOptions ?? {};
            if (wasmModule) initSync({ module: wasmModule });
            this._engine = new ClankersPads();
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
        const outL = outputs[0]?.[0];
        const outR = outputs[0]?.[1];
        if (!outL) return true;

        if (!this._engine) {
            outL.fill(0);
            if (outR) outR.fill(0);
            return true;
        }

        try {
            const blockEnd = currentTime + outL.length / sampleRate;
            while (this._queue.length && this._queue[0].audioTime <= blockEnd) {
                const ev = this._queue.shift();
                if (ev.ccJson) this._engine.set_params(ev.ccJson);
                this._engine.trigger(ev.midiNote, ev.velocity, ev.holdSamples ?? 0);
            }

            const interleaved = this._engine.process_stereo(outL.length);
            const frames = outL.length;
            for (let i = 0; i < frames; i++) {
                outL[i] = interleaved[i * 2]     ?? 0;
                if (outR) outR[i] = interleaved[i * 2 + 1] ?? 0;
            }
        } catch (e) {
            outL.fill(0);
            if (outR) outR.fill(0);
            if (this._errCount++ < 3) {
                this.port.postMessage({ type: 'error', message: `process: ${e}` });
            }
        }

        return true;
    }
}

registerProcessor('pads-worklet', PadsWorkletProcessor);
