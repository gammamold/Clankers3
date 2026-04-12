/**
 * ModularSync — CV/Gate signal generation for modular synth integration
 *
 * Generates clock and trigger gate signals as audio output via Web Audio,
 * intended to be routed to a modular synth through a DC-coupled audio
 * interface (e.g. Expert Sleepers ES-8, MOTU, etc.).
 *
 * Architecture:
 *   ConstantSourceNode (DC=1) → per-instrument GainNodes (gates)
 *                             → clockGain (clock pulses)
 *   All gates default to 0; spikes are scheduled via gain.setValueAtTime()
 *
 * Usage:
 *   import { modularSync } from './modular-sync.js';
 *   modularSync.init(audioContext);
 *   modularSync.connect(audioContext.destination);
 *   modularSync.setEnabled('drum', true);
 *   modularSync.setClockEnabled(true);
 *   // called by sequencer on each note:
 *   modularSync.sendGate('drum', audioTime, 0.005);
 *   // called by sequencer on each beat subdivision:
 *   modularSync.sendClock(audioTime);
 */

const GATE_DURATION = 0.005; // 5ms default gate pulse

export class ModularSync {
  constructor() {
    this.ctx = null;
    this._dc = null;          // ConstantSourceNode
    this._clockGain = null;   // GainNode for clock output
    this._triggerGains = {};   // { instrType: GainNode }
    this._merger = null;       // ChannelMergerNode (clock L, trigger R)
    this._outputGain = null;   // master output gain

    this._clockEnabled = false;
    this._clockDivision = 1;   // 1 = quarter, 0.5 = eighth, 0.25 = sixteenth, 4 = whole
    this._enabledInstruments = new Set(); // which instruments send gates
  }

  /**
   * Initialize audio nodes. Call once after AudioContext is created.
   */
  init(ctx) {
    this.ctx = ctx;

    // DC source feeds all gates
    this._dc = ctx.createConstantSource();
    this._dc.offset.value = 1.0;
    this._dc.start();

    // Clock gate
    this._clockGain = ctx.createGain();
    this._clockGain.gain.value = 0;
    this._dc.connect(this._clockGain);

    // Per-instrument trigger gates
    for (const type of ['drum', 'bass', 'buchla', 'pads', 'rhodes']) {
      const g = ctx.createGain();
      g.gain.value = 0;
      this._dc.connect(g);
      this._triggerGains[type] = g;
    }

    // Merger: channel 0 = clock, channel 1 = combined triggers
    this._merger = ctx.createChannelMerger(2);
    this._clockGain.connect(this._merger, 0, 0);

    // Sum all trigger gates into a single gain → merger channel 1
    this._triggerSum = ctx.createGain();
    this._triggerSum.gain.value = 1;
    for (const g of Object.values(this._triggerGains)) {
      g.connect(this._triggerSum);
    }
    this._triggerSum.connect(this._merger, 0, 1);

    // Master output
    this._outputGain = ctx.createGain();
    this._outputGain.gain.value = 1.0;
    this._merger.connect(this._outputGain);
  }

  /**
   * Connect output to a destination (e.g. ctx.destination or a specific output).
   */
  connect(destination) {
    if (this._outputGain) this._outputGain.connect(destination);
  }

  disconnect() {
    if (this._outputGain) try { this._outputGain.disconnect(); } catch (_) {}
  }

  /** Enable/disable clock output. */
  setClockEnabled(enabled) {
    this._clockEnabled = !!enabled;
  }

  get clockEnabled() { return this._clockEnabled; }

  /** Set clock division: 1 = 1/4 note, 0.5 = 1/8, 0.25 = 1/16, 4 = whole note. */
  setClockDivision(div) {
    this._clockDivision = div;
  }

  get clockDivision() { return this._clockDivision; }

  /** Enable/disable gate output for a specific instrument. */
  setEnabled(instrType, enabled) {
    if (enabled) this._enabledInstruments.add(instrType);
    else this._enabledInstruments.delete(instrType);
  }

  isEnabled(instrType) {
    return this._enabledInstruments.has(instrType);
  }

  /**
   * Schedule a clock pulse at exact audio time.
   * Called by sequencer on beat subdivisions matching the clock division.
   * @param {number} audioTime — Web Audio timestamp
   */
  sendClock(audioTime) {
    if (!this._clockEnabled || !this._clockGain) return;
    const g = this._clockGain.gain;
    g.setValueAtTime(1, audioTime);
    g.setValueAtTime(0, audioTime + GATE_DURATION);
  }

  /**
   * Schedule a trigger gate for an instrument at exact audio time.
   * @param {string} instrType — 'drum', 'bass', 'buchla', 'pads', 'rhodes'
   * @param {number} audioTime — Web Audio timestamp
   * @param {number} [duration] — gate duration in seconds (default 5ms)
   */
  sendGate(instrType, audioTime, duration) {
    if (!this._enabledInstruments.has(instrType)) return;
    const gNode = this._triggerGains[instrType];
    if (!gNode) return;
    const dur = duration ?? GATE_DURATION;
    const g = gNode.gain;
    g.setValueAtTime(1, audioTime);
    g.setValueAtTime(0, audioTime + dur);
  }

  /**
   * Check if a beat position should fire a clock pulse given the division.
   * @param {number} beat — current beat position
   * @param {number} prevBeat — previous beat position
   * @returns {boolean}
   */
  shouldClock(beat, prevBeat) {
    if (!this._clockEnabled) return false;
    const div = this._clockDivision;
    const cur = Math.floor(beat / div);
    const prev = Math.floor(prevBeat / div);
    return cur !== prev;
  }
}

export const modularSync = new ModularSync();
