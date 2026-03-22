/**
 * BeatRepeatProcessor — AudioWorkletProcessor
 *
 * Modes:
 *   passthrough  — audio passes through unmodified
 *   record       — records incoming audio into ring buffer, then auto-switches to repeat
 *   repeat       — loops the captured slice, decaying each loop
 *
 * Messages IN  (this.port.onmessage):
 *   { cmd:'record', samples:N }          — start recording N samples
 *   { cmd:'play' }                        — replay last captured slice immediately
 *   { cmd:'stop' }                        — return to passthrough immediately
 *   { cmd:'set', rate, decay, wet }       — update runtime params (no mode change)
 *
 * Messages OUT (this.port.postMessage):
 *   { event:'recordDone' }               — fired when capture is complete
 *   { event:'loopDone'  }               — fired when decay reaches silence
 */
class BeatRepeatProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._MAX = 44100 * 8;          // 8 second capture buffer
    this._buf   = new Float32Array(this._MAX);
    this._mode  = 'passthrough';
    this._wpos  = 0;                // write position during record
    this._rpos  = 0.0;              // read position (float for rate)
    this._loopEnd = 0;              // captured length in samples
    this._rate  = 1.0;              // playback rate (0.25–4.0)
    this._decay = 0.85;             // per-loop gain multiplier
    this._decayGain = 1.0;          // current gain
    this._wet   = 0.85;             // wet level during repeat
    this._dryDuring = 0.0;          // dry level during repeat (0 = gating)

    this.port.onmessage = ({ data }) => {
      const { cmd, samples, rate, decay, wet, dryDuring } = data;
      if (cmd === 'record') {
        this._loopEnd = Math.max(1, Math.min(samples, this._MAX));
        this._wpos  = 0;
        this._mode  = 'record';
      } else if (cmd === 'play') {
        if (this._loopEnd > 0) {
          this._rpos = 0; this._decayGain = 1.0; this._mode = 'repeat';
        }
      } else if (cmd === 'stop') {
        this._mode = 'passthrough';
      }
      if (rate      !== undefined) this._rate      = Math.max(0.125, Math.min(4.0, rate));
      if (decay     !== undefined) this._decay     = Math.max(0.0,   Math.min(0.999, decay));
      if (wet       !== undefined) this._wet       = Math.max(0.0,   Math.min(1.0, wet));
      if (dryDuring !== undefined) this._dryDuring = Math.max(0.0,   Math.min(1.0, dryDuring));
    };
  }

  process(inputs, outputs) {
    const inp = inputs[0]?.[0];
    const out = outputs[0]?.[0];
    if (!out) return true;

    const len = out.length;

    for (let i = 0; i < len; i++) {
      const dry = inp ? inp[i] : 0.0;

      if (this._mode === 'record') {
        this._buf[this._wpos++] = dry;
        out[i] = dry; // pass through while recording
        if (this._wpos >= this._loopEnd) {
          this._mode = 'repeat';
          this._rpos = 0;
          this._decayGain = 1.0;
          this.port.postMessage({ event: 'recordDone' });
        }

      } else if (this._mode === 'repeat') {
        // Linear interpolation for non-integer playback rate
        const i0 = Math.floor(this._rpos) % this._loopEnd;
        const i1 = (i0 + 1) % this._loopEnd;
        const fr = this._rpos - Math.floor(this._rpos);
        const wet = (this._buf[i0] * (1 - fr) + this._buf[i1] * fr) * this._decayGain;

        this._rpos += this._rate;
        if (this._rpos >= this._loopEnd) {
          this._rpos -= this._loopEnd;
          this._decayGain *= this._decay;
          if (this._decayGain < 0.001) {
            this._mode = 'passthrough';
            this.port.postMessage({ event: 'loopDone' });
          }
        }

        out[i] = dry * this._dryDuring + wet * this._wet;

      } else {
        out[i] = dry;
      }
    }
    return true;
  }
}

registerProcessor('beat-repeat', BeatRepeatProcessor);
