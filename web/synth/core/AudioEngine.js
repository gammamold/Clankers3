/**
 * AudioEngine — abstraction layer over Web Audio API.
 * Swap this class for a WASM bridge when integrating with The Clankers.
 */
export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.masterGain = null;
    this.analyser = null;
  }

  start() {
    if (this.ctx) return; // only one context ever
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = 0.7;

    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 2048;

    this.masterGain.connect(this.analyser);
    this.analyser.connect(this.ctx.destination);
  }

  resume() {
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
  }

  get destination() {
    return this.masterGain;
  }

  get currentTime() {
    return this.ctx ? this.ctx.currentTime : 0;
  }

  createOscillator() { return this.ctx.createOscillator(); }
  createGain() { return this.ctx.createGain(); }
  createBiquadFilter() { return this.ctx.createBiquadFilter(); }
  createWaveShaper() { return this.ctx.createWaveShaper(); }
  createConvolver() { return this.ctx.createConvolver(); }
  createDelay(max) { return this.ctx.createDelay(max); }
  createDynamicsCompressor() { return this.ctx.createDynamicsCompressor(); }
  createBuffer(...args) { return this.ctx.createBuffer(...args); }

  /** Frequency in Hz from MIDI note number */
  static midiToFreq(midi) {
    return 440 * Math.pow(2, (midi - 69) / 12);
  }

  /** Waveform data for oscilloscope */
  getWaveform() {
    if (!this.analyser) return new Float32Array(0);
    const buf = new Float32Array(this.analyser.fftSize);
    this.analyser.getFloatTimeDomainData(buf);
    return buf;
  }
}
