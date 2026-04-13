/**
 * Voder AudioWorkletProcessor — Clankers 3
 *
 * Parallel-formant voice synthesizer.  4-voice polyphonic.
 * Phoneme targets interpolate at a tuneable coarticulation rate.
 *
 * Messages IN:
 *   { type:'trigger',  audioTime, midiNote, velocity, holdSamples, ccJson? }
 *   { type:'release',  audioTime }        — note-off for most-recent voice
 *   { type:'setParams', ccJson }          — live param update
 *   { type:'phoneme',  idx }              — change phoneme target (0-24)
 *   { type:'phonemes', array, holdSamples } — phoneme sequence (JSON array)
 *   { type:'xy',       x, y }             — vowel-pad mode (0..1 each axis)
 *   { type:'stop' }                       — clear queue, silence immediately
 *
 * Messages OUT:
 *   { type:'ready' }
 *   { type:'error', message }
 *
 * Phoneme indices (0-24):
 *   0 AA   1 AE   2 AH   3 AO   4 EH   5 ER   6 EY   7 IH   8 IY
 *   9 OW  10 UH  11 UW  12 L   13 R   14 W   15 Y   16 M   17 N
 *  18 F   19 S   20 SH  21 TH  22 V   23 Z   24 ZH
 */

const { initSync, ClankersVoder } = globalThis;

class VoderWorkletProcessor extends AudioWorkletProcessor {
    constructor(options) {
        super();
        this._engine   = null;
        this._queue    = [];   // timestamped trigger events
        this._relQueue = [];   // timestamped release events
        this._errCount = 0;

        try {
            const { wasmModule, seed = 0x70de7 } = options?.processorOptions ?? {};
            if (wasmModule) initSync({ module: wasmModule });
            this._engine = new ClankersVoder(seed);
            this.port.postMessage({ type: 'ready' });
        } catch (e) {
            this.port.postMessage({ type: 'error', message: String(e) });
        }

        this.port.onmessage = ({ data }) => {
            if (!this._engine) return;
            switch (data.type) {
                case 'trigger':
                    this._queue.push(data);
                    this._queue.sort((a, b) => a.audioTime - b.audioTime);
                    break;
                case 'release':
                    this._relQueue.push(data);
                    this._relQueue.sort((a, b) => a.audioTime - b.audioTime);
                    break;
                case 'setParams':
                    try { this._engine.set_params(data.ccJson ?? '{}'); } catch (_) {}
                    break;
                case 'phoneme':
                    try { this._engine.set_phoneme(data.idx ?? 0); } catch (_) {}
                    break;
                case 'phonemes':
                    try {
                        const arr = Array.isArray(data.array)
                            ? JSON.stringify(data.array)
                            : String(data.array);
                        this._engine.set_phonemes(arr, data.holdSamples ?? 0);
                    } catch (_) {}
                    break;
                case 'xy':
                    try { this._engine.set_xy(data.x ?? 0.5, data.y ?? 0.5); } catch (_) {}
                    break;
                case 'stop':
                    this._queue    = [];
                    this._relQueue = [];
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

            // Dispatch trigger events whose audioTime falls within this block
            while (this._queue.length && this._queue[0].audioTime <= blockEnd) {
                const ev = this._queue.shift();
                if (ev.ccJson) {
                    try { this._engine.set_params(ev.ccJson); } catch (_) {}
                }
                if (ev.phonemes) {
                    try {
                        const arr = Array.isArray(ev.phonemes)
                            ? JSON.stringify(ev.phonemes)
                            : String(ev.phonemes);
                        this._engine.set_phonemes(arr, ev.holdSamples ?? 0);
                    } catch (_) {}
                } else if (ev.phoneme != null) {
                    try { this._engine.set_phoneme(ev.phoneme); } catch (_) {}
                }
                this._engine.trigger(ev.midiNote, ev.velocity,
                                     ev.holdSamples ?? 0, ev.ccJson ?? '{}');
            }

            // Dispatch release events
            while (this._relQueue.length && this._relQueue[0].audioTime <= blockEnd) {
                this._relQueue.shift();
                try { this._engine.release(); } catch (_) {}
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

registerProcessor('voder-worklet', VoderWorkletProcessor);
