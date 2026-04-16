/**
 * GraphFx AudioWorkletProcessor — Clankers 3
 *
 * Continuous FX processor using the same graph engine as synth patches,
 * but operating as an audio effect: reads input audio, processes through
 * the WASM graph, writes output audio.
 *
 * The graph JSON must include an "input" node (receives audio) and
 * an "output" node (sends processed audio).
 *
 * Messages IN:
 *   { type:'setParam', paramIndex, value }  — live knob update
 *
 * Messages OUT:
 *   { type:'ready', paramMap }   — paramMap is JSON array of param descriptors
 *   { type:'error', message }
 */

const { initSync, ClankersGraphFx } = globalThis;

class GraphFxWorkletProcessor extends AudioWorkletProcessor {
    constructor(options) {
        super();
        this._engine   = null;
        this._errCount = 0;

        try {
            const {
                wasmModule,
                graphJson,
            } = options?.processorOptions ?? {};

            if (wasmModule) initSync({ module: wasmModule });

            this._engine = new ClankersGraphFx(graphJson);

            const paramMap = this._engine.param_info();
            this.port.postMessage({ type: 'ready', paramMap });
        } catch (e) {
            this.port.postMessage({ type: 'error', message: String(e) });
        }

        this.port.onmessage = ({ data }) => {
            if (!this._engine) return;
            switch (data.type) {
                case 'setParam':
                    try {
                        this._engine.set_param(data.paramIndex, data.value);
                    } catch (_) {}
                    break;
            }
        };
    }

    process(inputs, outputs) {
        const inL  = inputs[0]?.[0];
        const inR  = inputs[0]?.[1] || inL;
        const outL = outputs[0]?.[0];
        const outR = outputs[0]?.[1] || outL;
        if (!outL) return true;

        if (!this._engine || !inL) {
            outL.fill(0);
            if (outR !== outL) outR.fill(0);
            return true;
        }

        try {
            const n = outL.length;

            // Interleave input: [L0, R0, L1, R1, ...]
            const inputBuf = new Float32Array(n * 2);
            for (let i = 0; i < n; i++) {
                inputBuf[i * 2]     = inL[i] || 0;
                inputBuf[i * 2 + 1] = (inR ? inR[i] : inL[i]) || 0;
            }

            // Process through WASM graph
            const buf = this._engine.process_stereo(inputBuf, n);

            // Deinterleave output
            for (let i = 0; i < n; i++) {
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

registerProcessor('graph-fx-worklet', GraphFxWorkletProcessor);
