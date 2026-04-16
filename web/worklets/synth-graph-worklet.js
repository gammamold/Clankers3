/**
 * SynthGraph AudioWorkletProcessor — Clankers 3
 *
 * Graph-based modular synth. Topology defined by JSON at construction time.
 * Params update live on playing voices.
 *
 * Messages IN:
 *   { type:'trigger', audioTime, midiNote, velocity, holdSamples }
 *   { type:'setParam', paramIndex, value }  — live knob update
 *   { type:'stop' }
 *
 * Messages OUT:
 *   { type:'ready', paramMap }   — paramMap is JSON array of param descriptors
 *   { type:'error', message }
 */

const { initSync, ClankersSynthGraph } = globalThis;

class SynthGraphWorkletProcessor extends AudioWorkletProcessor {
    constructor(options) {
        super();
        this._engine   = null;
        this._queue    = [];
        this._errCount = 0;

        try {
            const {
                wasmModule,
                graphJson,
                numVoices = 4,
            } = options?.processorOptions ?? {};

            if (wasmModule) initSync({ module: wasmModule });

            this._engine = new ClankersSynthGraph(graphJson, numVoices);

            const paramMap = this._engine.param_info();
            this.port.postMessage({ type: 'ready', paramMap });
        } catch (e) {
            this.port.postMessage({ type: 'error', message: String(e) });
        }

        this.port.onmessage = ({ data }) => {
            if (!this._engine) return;
            switch (data.type) {
                case 'trigger':
                    this._queue.push(data);
                    break;
                case 'setParam':
                    try {
                        this._engine.set_param(data.paramIndex, data.value);
                    } catch (_) {}
                    break;
                case 'stop':
                    this._queue = [];
                    break;
            }
        };
    }

    process(_inputs, outputs) {
        const outL = outputs[0]?.[0];
        const outR = outputs[0]?.[1] || outL;
        if (!outL) return true;

        if (!this._engine) {
            outL.fill(0);
            if (outR !== outL) outR.fill(0);
            return true;
        }

        try {
            const blockEnd = currentTime + outL.length / sampleRate;

            // Drain trigger queue
            while (this._queue.length && this._queue[0].audioTime <= blockEnd) {
                const ev = this._queue.shift();
                const holdSamples = ev.holdSamples ?? Math.round((ev.holdMs || 0) / 1000 * sampleRate);
                this._engine.trigger(ev.midiNote, ev.velocity, holdSamples);
            }

            // Render stereo interleaved
            const buf = this._engine.process_stereo(outL.length);

            // Deinterleave [L0,R0,L1,R1,...] → outL, outR
            for (let i = 0; i < outL.length; i++) {
                outL[i] = buf[i * 2];
                outR[i] = buf[i * 2 + 1];
            }
        } catch (e) {
            outL.fill(0);
            if (outR !== outL) outR.fill(0);
            if (this._errCount++ < 3) {
                this.port.postMessage({ type: 'error', message: `process: ${e}` });
            }
        }

        return true;
    }
}

registerProcessor('synth-graph-worklet', SynthGraphWorkletProcessor);
