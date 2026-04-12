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

const { initSync, ClankersDrums } = globalThis;

class DrumsWorkletProcessor extends AudioWorkletProcessor {
    constructor(options) {
        super();
        this._engine    = null;
        this._queue     = [];
        this._errCount  = 0;

        try {
            const { wasmModule, seed = 0xd8d8d8 } = options?.processorOptions ?? {};
            if (wasmModule) initSync({ module: wasmModule });
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
                    try { this._engine.set_profile(data.profileId); } catch (_) {}
                    break;
                case 'setPitch':
                    try { this._engine.set_pitch(data.semitones); } catch (_) {}
                    break;
                case 'setDecay':
                    try { this._engine.set_decay(data.mult); } catch (_) {}
                    break;
                case 'setFilter':
                    try { this._engine.set_filter(data.hz); } catch (_) {}
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
                this._engine.trigger(ev.voiceId, ev.velocity);
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

registerProcessor('drums-worklet', DrumsWorkletProcessor);
