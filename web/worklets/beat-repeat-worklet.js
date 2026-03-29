/**
 * BeatRepeatProcessor — AudioWorkletProcessor (stereo)
 *
 * Ableton-style retrospective model:
 *   - Ring buffer ALWAYS records incoming audio (even in passthrough)
 *   - ARM grabs the last N samples that already played and loops them IMMEDIATELY
 *   - No waiting — loop starts on the same beat you ARM
 *   - GATE stops looping and returns to passthrough
 *
 * Messages IN:
 *   { cmd:'arm',  samples:N }   — grab last N samples from ring, start looping now
 *   { cmd:'stop' }              — back to passthrough
 *   { cmd:'set', rate, decay, wet, repeats }
 *
 * Messages OUT:
 *   { event:'loopDone' }        — decay reached silence (or repeats exhausted)
 */
class BeatRepeatProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._MAX  = sampleRate * 8;   // 8s ring buffer
    this._ringL = new Float32Array(this._MAX);
    this._ringR = new Float32Array(this._MAX);
    this._wpos  = 0;               // write head (wraps at MAX)

    // Playback state
    this._mode      = 'passthrough';
    this._loopStart = 0;           // absolute ring position where slice began
    this._loopLen   = 0;           // slice length in samples
    this._rpos      = 0;           // playback offset within slice (float for rate)
    this._decayGain = 1.0;
    this._loopCount = 0;

    // Params
    this._rate    = 1.0;
    this._decay   = 0.92;
    this._wet     = 0.85;
    this._repeats = 0;             // 0 = infinite until GATE

    this.port.onmessage = ({ data }) => {
      const { cmd, samples, rate, decay, wet, repeats } = data;

      if (cmd === 'arm' && samples > 0) {
        // Grab last N samples already in ring buffer
        this._loopLen   = Math.min(Math.max(1, samples), this._MAX);
        // loopStart points to the oldest sample of the slice
        this._loopStart = (this._wpos - this._loopLen + this._MAX) % this._MAX;
        this._rpos      = 0;
        this._decayGain = 1.0;
        this._loopCount = 0;
        this._mode      = 'repeat';
      } else if (cmd === 'stop') {
        this._mode = 'passthrough';
      }

      if (rate    !== undefined) this._rate    = Math.max(0.125, Math.min(4.0,   rate));
      if (decay   !== undefined) this._decay   = Math.max(0.0,   Math.min(0.999, decay));
      if (wet     !== undefined) this._wet     = Math.max(0.0,   Math.min(1.0,   wet));
      if (repeats !== undefined) this._repeats = Math.max(0, Math.floor(repeats));
    };
  }

  process(inputs, outputs) {
    const inL  = inputs[0]?.[0];
    const inR  = inputs[0]?.[1] ?? inL;
    const outL = outputs[0]?.[0];
    const outR = outputs[0]?.[1] ?? outL;
    if (!outL) return true;

    const len = outL.length;

    for (let i = 0; i < len; i++) {
      const dryL = inL ? inL[i] : 0.0;
      const dryR = inR ? inR[i] : 0.0;

      // Always write to ring buffer
      const wp = this._wpos % this._MAX;
      this._ringL[wp] = dryL;
      this._ringR[wp] = dryR;
      this._wpos++;

      if (this._mode === 'repeat') {
        // Interpolated read from ring slice
        const offset0 = Math.floor(this._rpos);
        const offset1 = offset0 + 1;
        const fr      = this._rpos - offset0;

        const rp0 = (this._loopStart + offset0 % this._loopLen) % this._MAX;
        const rp1 = (this._loopStart + offset1 % this._loopLen) % this._MAX;

        const wetL = (this._ringL[rp0] * (1 - fr) + this._ringL[rp1] * fr) * this._decayGain;
        const wetR = (this._ringR[rp0] * (1 - fr) + this._ringR[rp1] * fr) * this._decayGain;

        this._rpos += this._rate;

        if (this._rpos >= this._loopLen) {
          this._rpos -= this._loopLen;
          this._loopCount++;
          this._decayGain *= this._decay;

          const limitHit = this._repeats > 0 && this._loopCount >= this._repeats;
          if (this._decayGain < 0.001 || limitHit) {
            this._mode = 'passthrough';
            this.port.postMessage({ event: 'loopDone' });
          }
        }

        // Dry is gated during repeat (parallel FX — dry already plays through master)
        outL[i] = wetL * this._wet;
        if (outR !== outL) outR[i] = wetR * this._wet;

      } else {
        // Passthrough: output silence — dry already reaches master via instrGain→master
        outL[i] = 0;
        if (outR !== outL) outR[i] = 0;
      }
    }
    return true;
  }
}

registerProcessor('beat-repeat', BeatRepeatProcessor);
