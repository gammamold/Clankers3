/**
 * GraphFxAdapter — wraps a graph-based WASM FX processor.
 *
 * Exposes the same .input / .output GainNode interface as DelayFx and
 * WaveShapeFx, so it can sit in the same send-bus architecture.
 *
 * Usage:
 *   const fx = new GraphFxAdapter(ctx, graphJson);
 *   await fx.init(wasmModule);
 *   fx.input  → connect instrument sends here
 *   fx.output → connect to ctx.destination
 */

let _fxWorkletRegistered = false;

export class GraphFxAdapter {
  /**
   * @param {AudioContext} ctx
   * @param {string} graphJson  — FX graph JSON (must have "input" + "output" nodes)
   * @param {object} [opts]
   *   id {string} — unique identifier
   */
  constructor(ctx, graphJson, opts = {}) {
    this._ctx       = ctx;
    this._graphJson = graphJson;
    this._id        = opts.id || 'gfx_' + Date.now();
    this._node      = null;
    this._paramMap   = null;
    this._paramLookup = {};

    // Public interface matching DelayFx / WaveShapeFx
    this.input  = ctx.createGain();
    this.output = ctx.createGain();
    this.input.gain.value  = 1;
    this.output.gain.value = 1;
  }

  /**
   * Initialize the worklet and wire up audio routing.
   * @param {WebAssembly.Module} wasmModule
   */
  async init(wasmModule) {
    if (!_fxWorkletRegistered) {
      await this._ctx.audioWorklet.addModule('/worklets/graph-fx-worklet.js');
      _fxWorkletRegistered = true;
    }

    this._node = new AudioWorkletNode(this._ctx, 'graph-fx-worklet', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      processorOptions: {
        wasmModule,
        graphJson: this._graphJson,
      },
    });

    // Wait for ready
    await new Promise((resolve, reject) => {
      const handler = ({ data }) => {
        if (data.type === 'ready') {
          this._node.port.removeEventListener('message', handler);
          try {
            const params = typeof data.paramMap === 'string'
              ? JSON.parse(data.paramMap) : data.paramMap;
            this._paramMap = params;
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

    // Wire: input → worklet → output
    this.input.connect(this._node);
    this._node.connect(this.output);
  }

  /**
   * Set a parameter by node ID + param name.
   * @param {string} nodeId
   * @param {string} paramName
   * @param {number} value
   */
  setParam(nodeId, paramName, value) {
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

  /** Get the parameter map. */
  get paramMap() { return this._paramMap || []; }

  /** Get the param lookup map. */
  get paramLookup() { return this._paramLookup; }

  /** Disconnect and clean up. */
  disconnect() {
    try { this.input.disconnect(); } catch (_) {}
    try { this._node?.disconnect(); } catch (_) {}
    try { this.output.disconnect(); } catch (_) {}
  }

  /**
   * Get serializable state for save/restore.
   */
  getParams() {
    const vals = {};
    if (this._paramMap) {
      for (const p of this._paramMap) {
        vals[`${p.node}.${p.param}`] = p.default; // TODO: track live values
      }
    }
    return {
      type: 'graph_fx',
      graphJson: this._graphJson,
      currentParams: vals,
    };
  }
}
