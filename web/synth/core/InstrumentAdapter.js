/**
 * InstrumentAdapter.js — Unified instrument interface for Clankers 3.
 *
 * All instruments (WASM worklets + Web Audio voice pools) implement this
 * interface so the sequencer can schedule notes through a single code path.
 *
 * Hierarchy:
 *   InstrumentAdapter          — abstract base
 *   WasmInstrumentAdapter      — wraps AudioWorkletNode
 *   WebAudioInstrumentAdapter  — wraps SynthVoice pool + JSONBridge
 */

import { JSONBridge } from './JSONBridge.js';
import { SynthVoice  } from './SynthVoice.js';

const MAX_POLY = 5;

// ── ClankerEngine shim ────────────────────────────────────────────────────────
// Adapts a raw AudioContext + destination node to the SynthVoice engine API.
// Kept here so WebAudioInstrumentAdapter doesn't depend on synth-lab.js.
class ClankerEngine {
  constructor(ctx, destinationNode) {
    this.ctx          = ctx;
    this._destination = destinationNode;
  }
  get destination()          { return this._destination; }
  get currentTime()          { return this.ctx.currentTime; }
  createOscillator()         { return this.ctx.createOscillator(); }
  createGain()               { return this.ctx.createGain(); }
  createBiquadFilter()       { return this.ctx.createBiquadFilter(); }
  createWaveShaper()         { return this.ctx.createWaveShaper(); }
  createConvolver()          { return this.ctx.createConvolver(); }
  createDelay(max)           { return this.ctx.createDelay(max); }
  createDynamicsCompressor() { return this.ctx.createDynamicsCompressor(); }
  createBuffer(...a)         { return this.ctx.createBuffer(...a); }
}

// ── Base class ─────────────────────────────────────────────────────────────────

export class InstrumentAdapter {
  /** @param {string} id - unique identifier for this adapter instance */
  constructor(id) { this._id = id; }

  /** Unique identifier */
  get id() { return this._id; }

  /**
   * Connect instrument output to an AudioNode destination.
   * For WASM adapters this wires the worklet node.
   * For WebAudio adapters this builds the voice pool and wires its gain node.
   * Safe to call multiple times — re-wires without rebuilding if same context.
   * @param {AudioNode} destinationNode
   */
  connect(destinationNode) {}

  /** Disconnect from current destination node */
  disconnect() {}

  /**
   * Schedule a note on + note off.
   * @param {number} midiNote   - MIDI note number (0–127)
   * @param {number} velocity   - normalised velocity (0.0–1.0)
   * @param {number} audioTime  - Web Audio context timestamp for note-on
   * @param {number} holdMs     - duration in milliseconds before note-off
   * @param {object} [opts]     - extra options: { ccJson, voiceId }
   */
  scheduleNote(midiNote, velocity, audioTime, holdMs, opts = {}) {}

  /**
   * Push a CC parameter update (WASM instruments only).
   * WebAudio instruments use JSONBridge for live parameter changes.
   * @param {string} ccJson - JSON string of { ccNumber: value } map
   */
  setParams(ccJson) {}

  /** Silence all active voices immediately */
  stop() {}

  /**
   * Return a serialisable snapshot of the current state.
   * @returns {object|null}
   */
  getState() { return null; }
}

// ── WasmInstrumentAdapter ──────────────────────────────────────────────────────

/**
 * Wraps an AudioWorkletNode (WASM-backed DSP instrument).
 *
 * Schedules notes by posting typed messages to the worklet port.
 * Drum mode uses voiceId instead of midiNote.
 */
export class WasmInstrumentAdapter extends InstrumentAdapter {
  /**
   * @param {AudioWorkletNode|null} node
   * @param {string} id
   * @param {object} [opts]
   *   isDrum        {boolean} - drum mode: scheduleNote sends voiceId, not midiNote
   *   octaveOffset  {number}  - semitone offset added to every midiNote
   */
  constructor(node, id, opts = {}) {
    super(id);
    this._node         = node;
    this._isDrum       = opts.isDrum       ?? false;
    this._octaveOffset = opts.octaveOffset ?? 0;
    // Activate the port so 'message' events are delivered
    if (node?.port) node.port.start?.();
  }

  connect(destinationNode) {
    if (!this._node) return;
    try { this._node.disconnect(); } catch (_) {}
    this._node.connect(destinationNode);
  }

  disconnect() {
    try { this._node?.disconnect(); } catch (_) {}
  }

  scheduleNote(midiNote, velocity, audioTime, holdMs, opts = {}) {
    if (!this._node?.port) return;
    if (this._isDrum) {
      this._node.port.postMessage({
        type: 'trigger', audioTime,
        voiceId: opts.voiceId ?? 0, velocity,
      });
    } else {
      const sr          = this._node.context.sampleRate;
      const holdSamples = Math.round((holdMs / 1000) * sr);
      const midi        = Math.max(0, Math.min(127, midiNote + this._octaveOffset));
      this._node.port.postMessage({
        type: 'trigger', audioTime,
        midiNote: midi, velocity, holdSamples,
        ccJson: opts.ccJson ?? '{}',
      });
    }
  }

  setParams(ccJson) {
    this._node?.port?.postMessage({ type: 'setParams', ccJson });
  }

  stop() {
    if (!this._node?.port) return;
    this._node.port.postMessage({ type: 'stop' });
    // Flush any held notes
    this._node.port.postMessage({
      type: 'trigger', audioTime: 0,
      midiNote: 0, velocity: 0, holdSamples: 0, voiceId: 0, ccJson: '{}',
    });
  }

  /** Raw AudioWorkletNode — for audio graph inspection */
  get node() { return this._node; }
}

// ── WebAudioInstrumentAdapter ──────────────────────────────────────────────────

/**
 * Wraps a polyphonic SynthVoice pool + JSONBridge (Web Audio instrument).
 *
 * Voice pool lifecycle:
 *   connect(dest) → creates internal GainNode → builds MAX_POLY SynthVoice instances
 *   disconnect()  → destroys pool and disconnects gain node
 *
 * If the AudioContext changes (e.g. offline rendering), the pool is rebuilt.
 */
export class WebAudioInstrumentAdapter extends InstrumentAdapter {
  /**
   * @param {AudioContext} ctx
   * @param {object} patchState  - initial patch JSON (deep-copied)
   * @param {string} id
   */
  constructor(ctx, patchState, id) {
    super(id);
    this._ctx      = ctx;
    this._state    = JSON.parse(JSON.stringify(patchState));
    this._bridge   = new JSONBridge();
    this._bridge.init(this._state);
    this._voices   = [];
    this._voiceMap = new Map();  // midiNote → { voice, startTime }
    this._gainNode = null;
  }

  connect(destinationNode) {
    const ctxChanged = this._gainNode && this._gainNode.context !== this._ctx;
    if (ctxChanged) {
      // Context changed — full rebuild
      this._destroyVoicePool();
      try { this._gainNode.disconnect(); } catch (_) {}
      this._gainNode = null;
    }

    if (!this._gainNode) {
      // First connection on this context — create gain and build pool
      this._gainNode = this._ctx.createGain();
      this._gainNode.gain.value = 1;
      this._buildVoicePool();
    } else {
      // Same context — just rewire the gain output (fast, no pool rebuild)
      try { this._gainNode.disconnect(); } catch (_) {}
    }
    this._gainNode.connect(destinationNode);
  }

  disconnect() {
    this._destroyVoicePool();
    try { this._gainNode?.disconnect(); } catch (_) {}
    this._gainNode = null;
  }

  scheduleNote(midiNote, velocity, audioTime, holdMs, _opts = {}) {
    if (!this._voices.length) return;
    const delayMs = Math.max(0, (audioTime - this._ctx.currentTime) * 1000);
    setTimeout(() => {
      const voice = this._allocateVoice(midiNote);
      this._voiceMap.set(midiNote, { voice, startTime: this._ctx.currentTime });
      voice.noteOn(midiNote, velocity * 127);
    }, delayMs);
    setTimeout(() => this._releaseVoice(midiNote), delayMs + holdMs);
  }

  stop() {
    for (const { voice } of this._voiceMap.values()) {
      try { voice.noteOff(); } catch (_) {}
    }
    this._voiceMap.clear();
  }

  getState() { return this._bridge.snapshot(); }

  // ── Manual note trigger (piano keyboard / manual pad) ──────────────────────

  noteOn(midiNote, velocity = 100) {
    if (!this._voices.length || !this._gainNode) return;
    const voice = this._allocateVoice(midiNote);
    this._voiceMap.set(midiNote, { voice, startTime: this._ctx.currentTime });
    voice.noteOn(midiNote, velocity);
  }

  noteOff(midiNote) {
    this._releaseVoice(midiNote);
  }

  // ── Accessors for SynthLab UI ───────────────────────────────────────────────

  /** JSONBridge — for live knob bindings in the editor UI */
  get bridge()   { return this._bridge; }
  /** SynthVoice array — for live method calls from ModulePanel knobs */
  get voices()   { return this._voices; }
  /** Active note → voice map */
  get voiceMap() { return this._voiceMap; }

  // ── Voice pool internals ────────────────────────────────────────────────────

  _buildVoicePool() {
    if (!this._ctx || !this._state || !this._gainNode) return;
    const engine = new ClankerEngine(this._ctx, this._gainNode);
    this._voices = Array.from({ length: MAX_POLY }, () =>
      new SynthVoice(engine).buildFromState(this._state)
    );
    this._voiceMap = new Map();
    this._bridge.onChange(s => this._voices.forEach(v => v.updateState(s)));
  }

  _destroyVoicePool() {
    this._voices.forEach(v => { try { v.destroy(); } catch (_) {} });
    this._voices   = [];
    this._voiceMap = new Map();
  }

  _allocateVoice(midiNote) {
    if (this._voiceMap.has(midiNote)) return this._voiceMap.get(midiNote).voice;
    const free = this._voices.find(v => v.activeNote === null);
    if (free) return free;
    // Voice steal — evict oldest sounding note
    let oldestNote = null, oldestTime = Infinity;
    for (const [note, entry] of this._voiceMap) {
      if (entry.startTime < oldestTime) { oldestTime = entry.startTime; oldestNote = note; }
    }
    if (oldestNote !== null) {
      const stolen = this._voiceMap.get(oldestNote).voice;
      stolen.noteOff();
      this._voiceMap.delete(oldestNote);
      return stolen;
    }
    return this._voices[0]; // last resort
  }

  _releaseVoice(midiNote) {
    const entry = this._voiceMap.get(midiNote);
    if (!entry) return;
    entry.voice.noteOff();
    this._voiceMap.delete(midiNote);
  }
}
