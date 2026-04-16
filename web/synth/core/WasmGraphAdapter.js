/**
 * WasmGraphAdapter — wraps a graph-based WASM synth in an InstrumentAdapter.
 *
 * Unlike WasmInstrumentAdapter (which wraps a pre-existing AudioWorkletNode),
 * this adapter creates and owns the worklet node, passing the graph JSON at
 * construction time.
 *
 * Usage:
 *   const adapter = new WasmGraphAdapter(ctx, graphJson, { numVoices: 4 });
 *   await adapter.init(wasmModule);
 *   adapter.connect(destinationNode);
 *   adapter.scheduleNote(60, 0.8, ctx.currentTime, 500);
 */

import { InstrumentAdapter } from './InstrumentAdapter.js';

let _workletRegistered = false;

export class WasmGraphAdapter extends InstrumentAdapter {
  /**
   * @param {AudioContext} ctx
   * @param {string} graphJson    — the full graph JSON string
   * @param {object} [opts]
   *   numVoices  {number}  — polyphony (1-16, default 4)
   *   id         {string}  — unique adapter id
   */
  constructor(ctx, graphJson, opts = {}) {
    super(opts.id || 'graph_' + Date.now());
    this._ctx       = ctx;
    this._graphJson = graphJson;
    this._numVoices = opts.numVoices || 4;
    this._node      = null;
    this._paramMap  = null;   // parsed param info from engine
    this._paramLookup = {};   // "node_id.param_name" → { index, min, max, default }
  }

  /**
   * Initialize the worklet and create the AudioWorkletNode.
   * Must be called before connect/scheduleNote.
   * @param {WebAssembly.Module} wasmModule
   */
  async init(wasmModule) {
    // Register the worklet processor (once per AudioContext)
    if (!_workletRegistered) {
      await this._ctx.audioWorklet.addModule('/worklets/synth-graph-worklet.js');
      _workletRegistered = true;
    }

    this._node = new AudioWorkletNode(this._ctx, 'synth-graph-worklet', {
      numberOfOutputs: 1,
      outputChannelCount: [2],
      processorOptions: {
        wasmModule,
        graphJson: this._graphJson,
        numVoices: this._numVoices,
      },
    });

    // Wait for the engine to be ready
    await new Promise((resolve, reject) => {
      const handler = ({ data }) => {
        if (data.type === 'ready') {
          this._node.port.removeEventListener('message', handler);
          // paramMap is a JSON string — parse it
          try {
            const params = typeof data.paramMap === 'string'
              ? JSON.parse(data.paramMap) : data.paramMap;
            this._paramMap = params;
            // Build lookup: "osc1.waveform" → { index, min, max, default }
            this._paramLookup = {};
            for (const p of params) {
              this._paramLookup[`${p.node}.${p.param}`] = p;
            }
          } catch (_) {
            this._paramMap = [];
          }
          resolve();
        } else if (data.type === 'error') {
          this._node.port.removeEventListener('message', handler);
          reject(new Error(data.message));
        }
      };
      this._node.port.addEventListener('message', handler);
      this._node.port.start();
    });
  }

  // ── InstrumentAdapter interface ──────────────────────────────────────────

  connect(destinationNode) {
    if (!this._node) return;
    try { this._node.disconnect(); } catch (_) {}
    this._node.connect(destinationNode);
  }

  disconnect() {
    try { this._node?.disconnect(); } catch (_) {}
  }

  scheduleNote(midiNote, velocity, audioTime, holdMs, _opts = {}) {
    if (!this._node?.port) return;
    const sr = this._node.context.sampleRate;
    const holdSamples = Math.round((holdMs / 1000) * sr);
    this._node.port.postMessage({
      type: 'trigger', audioTime,
      midiNote, velocity, holdSamples,
    });
  }

  setParams(_ccJson) {
    // Graph adapters use setGraphParam instead of CC-based params
  }

  stop() {
    if (!this._node?.port) return;
    this._node.port.postMessage({ type: 'stop' });
  }

  getState() {
    return {
      type: 'wasm_graph',
      graphJson: this._graphJson,
      numVoices: this._numVoices,
      currentParams: this._getCurrentParamValues(),
    };
  }

  // ── Graph-specific API ───────────────────────────────────────────────────

  /**
   * Set a graph parameter by node ID + param name.
   * @param {string} nodeId    — e.g. "osc1"
   * @param {string} paramName — e.g. "waveform"
   * @param {number} value
   */
  setGraphParam(nodeId, paramName, value) {
    const key = `${nodeId}.${paramName}`;
    const entry = this._paramLookup[key];
    if (entry && this._node?.port) {
      this._node.port.postMessage({
        type: 'setParam',
        paramIndex: entry.index,
        value,
      });
    }
  }

  /**
   * Set a parameter by flat index.
   * @param {number} paramIndex
   * @param {number} value
   */
  setParamByIndex(paramIndex, value) {
    if (this._node?.port) {
      this._node.port.postMessage({
        type: 'setParam', paramIndex, value,
      });
    }
  }

  /** Get the parameter map (array of { index, node, param, min, max, default }). */
  get paramMap() { return this._paramMap || []; }

  /** Get the param lookup map ("node.param" → descriptor). */
  get paramLookup() { return this._paramLookup; }

  /** The raw AudioWorkletNode. */
  get node() { return this._node; }

  // ── Manual note trigger (piano keyboard / manual pad) ────────────────────

  noteOn(midiNote, velocity = 100) {
    if (!this._node?.port) return;
    // For manual play: use a long hold (10s), noteOff will release
    this._node.port.postMessage({
      type: 'trigger',
      audioTime: this._ctx.currentTime,
      midiNote,
      velocity: velocity / 127,
      holdSamples: 0, // 0 = sustain until envelope finishes
    });
  }

  noteOff(_midiNote) {
    // Graph voices use hold_samples for duration; manual sustain
    // would need a release message. For now voices self-release via envelope.
  }

  // ── Internal ─────────────────────────────────────────────────────────────

  _getCurrentParamValues() {
    if (!this._paramMap) return {};
    const vals = {};
    for (const p of this._paramMap) {
      vals[`${p.node}.${p.param}`] = p.default; // TODO: track live values
    }
    return vals;
  }
}
