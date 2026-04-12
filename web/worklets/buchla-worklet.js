/**
 * Poly FM AudioWorkletProcessor — Clankers 3  [t:1]
 *
 * Uses ClankersBuchla (vactrol LPG + wavefolder, self-releasing).
 * CC19 = release time (0-127 → 5ms..3s) — the note decays naturally,
 * no holdSamples needed.
 *
 * Messages IN:
 *   { type:'trigger', audioTime, midiNote, velocity, ccJson? }
 *   { type:'setParams', ccJson }   — live param update
 *   { type:'stop' }
 *
 * Messages OUT:
 *   { type:'ready' }
 *   { type:'error', message }
 */

const { initSync, ClankersBuchla } = globalThis;

class PolyFMWorkletProcessor extends AudioWorkletProcessor {
    constructor(options) {
        super();
        this._engine   = null;
        this._queue    = [];
        this._errCount = 0;

        try {
            const { wasmModule } = options?.processorOptions ?? {};
            if (wasmModule) initSync({ module: wasmModule });
            this._engine = new ClankersBuchla();
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
                // Apply CC params first so release/cutoff etc. are live at trigger time
                if (ev.ccJson) {
                    try { this._engine.set_params(ev.ccJson); } catch (_) {}
                }
                // ClankersBuchla is self-releasing — no holdSamples
                this._engine.trigger(ev.midiNote, ev.velocity);
            }

            const buf = this._engine.process(out.length);
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

registerProcessor('buchla-worklet', PolyFMWorkletProcessor);
