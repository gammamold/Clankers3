/**
 * synth-lab.js — Synth Lab integration for Clankers 3
 *
 * Bridges the Synth Designer (subtractive/FM Web Audio synth) into Clankers as a
 * new room with up to 4 playable synth slots.
 *
 * Track type mapping (ClankerBoy JSON sheets):
 *   t:7  → slot 0   t:8  → slot 1   t:9  → slot 2   t:11 → slot 3   t:12 → slot 4 (FM DRUMS)
 *
 * Note scheduling:
 *   Worklets get sample-accurate triggers. SynthVoice uses main-thread Web Audio,
 *   so we schedule noteOn/Off via setTimeout against ctx.currentTime delta.
 *   Accuracy is typically ≤5 ms — imperceptible for musical purposes.
 */

import { buildClankersMeta }       from './synth/core/ClankersBridge.js';
import { WebAudioInstrumentAdapter } from './synth/core/InstrumentAdapter.js';
import { WasmGraphAdapter }          from './synth/core/WasmGraphAdapter.js';
import { GraphFxAdapter }            from './synth/core/GraphFxAdapter.js';
import { registry }                  from './synth/core/InstrumentRegistry.js';
import { ModulePanel }               from './synth/ui/ModulePanel.js';
import { PianoKeys }                 from './synth/ui/PianoKeys.js';
import { LLMWizard }                 from './synth/wizard/LLMWizard.js';
import { XYPad }                     from './synth/ui/XYPad.js';

/** Unique patch ID counter for registry registration */
let _patchSeq = Date.now();

/** Track types for slots 0–4 */
export const SYNTH_SLOT_T = [7, 8, 9, 11, 12];
export const T_TO_SLOT    = { 7: 0, 8: 1, 9: 2, 11: 3, 12: 4 };

/** Human-readable name for each legacy track type (including drums) */
const LEGACY_T_NAMES = { 1: 'POLY FM', 2: 'BASS FM', 3: 'RHODES EP', 6: 'HYBRID PADS', 10: 'DRUMS' };

/** Maps the LLM's `replaces` field to the legacy track type it targets */
const REPLACES_KEY_TO_T = { bass_fm: 2, poly_fm: 1, pad_synth: 6, rhodes: 3, drums: 10 };

// ── SynthLab ───────────────────────────────────────────────────────────────────

export class SynthLab {
  constructor() {
    this._ctx         = null;
    this._master      = null;
    this._editingSlot = null;
    this._uiBuilt     = false;
    this._seq         = null;  // set externally: synthLab._seq = seq
    this._fx          = null;  // set externally: synthLab._fx = rack (MasterFx)

    /** Slot index → legacy track type it currently replaces (null = no replacement) */
    this._slotLegacyT = { 0: 2, 1: 1, 2: 6, 3: 3, 4: null };

    this._slots = Array.from({ length: 5 }, (_, i) => ({
      index:   i,
      adapter: null,  // WebAudioInstrumentAdapter | null
      gain:    null,  // GainNode → master (created in init())
      muted:   false,
      volume:  1.0,
      panels:  [],
    }));

    /** Graph FX units added via the wizard. Each: { adapter, name, sendSlot, state } */
    this._graphFxSlots = [];

    this._restoreAssignments();
  }

  /** Inverse map: legacy track type → slot index */
  get _legacyTToSlot() {
    const out = {};
    for (const [slot, t] of Object.entries(this._slotLegacyT)) out[t] = Number(slot);
    return out;
  }

  // ── Adapter helpers ──────────────────────────────────────────────────────────

  /** Build a new adapter for a slot and wire it to slot.gain. */
  _loadAdapter(slot, patchState) {
    this._unloadAdapter(slot);
    if (!this._ctx) return;
    const id = `slot:${slot.index}`;

    if (patchState.type === 'wasm_graph') {
      // Graph-based WASM synth — async init
      const graphJson = typeof patchState.graphJson === 'string'
        ? patchState.graphJson : JSON.stringify(patchState);
      const adapter = new WasmGraphAdapter(this._ctx, graphJson, {
        numVoices: patchState.num_voices || 4,
        id,
      });
      slot.adapter = adapter;
      // Init async — wire up when ready
      if (window._wasmModule) {
        adapter.init(window._wasmModule).then(() => {
          adapter.connect(slot.gain);
          console.log(`[SynthLab] WASM graph adapter ready for slot ${slot.index}`);
        }).catch(e => {
          console.error(`[SynthLab] Graph init failed:`, e);
        });
      } else {
        console.warn('[SynthLab] WASM module not available for graph adapter');
      }
    } else {
      slot.adapter = new WebAudioInstrumentAdapter(this._ctx, patchState, id);
      slot.adapter.connect(slot.gain);
    }
  }

  /** Disconnect and discard the current adapter for a slot. */
  _unloadAdapter(slot) {
    if (!slot.adapter) return;
    slot.adapter.disconnect();
    slot.adapter = null;
  }

  /** Proxy that calls a setter method on every voice in the adapter pool. */
  _allVoices(slot) {
    return new Proxy({}, {
      get(_, method) {
        return (...args) => (slot.adapter?.voices ?? []).forEach(v => v[method]?.(...args));
      }
    });
  }

  /** Call once the AudioContext exists (first user gesture).
   *  Safe to call again with a different ctx (e.g. sequencer taking over from standalone). */
  init(ctx) {
    if (this._ctx === ctx) return; // same context, nothing to do
    this._ctx    = ctx;
    this._master = ctx.destination;
    for (const slot of this._slots) {
      // Recreate gain nodes on the new context
      if (slot.gain) { try { slot.gain.disconnect(); } catch (_) {} }
      slot.gain = ctx.createGain();
      slot.gain.gain.value = slot.muted ? 0 : slot.volume;
      slot.gain.connect(this._master);
      // Rebuild adapter on new context if a patch is loaded
      if (slot.adapter) {
        const state = slot.adapter.getState();
        this._loadAdapter(slot, state);
      }
    }
    this._restorePatches();
  }

  /**
   * Sequencer calls this after start() creates its masterGain so synth slots
   * route through the same gain/FX chain as the worklet instruments.
   */
  connectToMaster(masterGain) {
    this._master = masterGain;
    for (const slot of this._slots) {
      if (slot.gain) {
        try { slot.gain.disconnect(); } catch (_) {}
        slot.gain.connect(masterGain);
      }
    }
  }

  /** Return a map of { synth0: GainNode, synth1: GainNode, ... } for FX send wiring. */
  getSynthGains() {
    const out = {};
    for (let i = 0; i < this._slots.length; i++) {
      if (this._slots[i].gain) out[`synth${i}`] = this._slots[i].gain;
    }
    return out;
  }

  /**
   * Load (or reload) a patch JSON into a slot.
   * Registers the patch in the instrument library and routes the legacy
   * track type through the new adapter via the sequencer.
   */
  loadPatch(slotIndex, patchState) {
    const slot = this._slots[slotIndex];
    if (!slot || !this._ctx) return;

    this._loadAdapter(slot, patchState);

    if (this._editingSlot === slotIndex) this._renderEditor(slotIndex);
    this._refreshSlotCards();

    // Route legacy track type through this WebAudio adapter instead of WASM
    const legacyT = this._slotLegacyT[slotIndex];
    if (legacyT != null) {
      const typeKey = _legacyTToType(legacyT);
      this._seq?.setAdapter(typeKey, slot.adapter);
    }
    // Also register this slot's own synth track type
    this._seq?.setAdapter(`synth${slotIndex}`, slot.adapter);

    // Register in the instrument library (auto-assign a stable id based on name)
    this._registerPatch(slotIndex, patchState);

    this._saveSession();
    console.log(`[SynthLab] slot ${slotIndex} loaded: "${patchState.name}" — replaces t:${legacyT}`);
  }

  /** Destroy a slot's adapter and restore the default WASM adapter for its legacy track. */
  clearSlot(slotIndex) {
    const slot = this._slots[slotIndex];
    if (!slot) return;
    this._unloadAdapter(slot);

    // Restore WASM adapter for the legacy track type
    const legacyT = this._slotLegacyT[slotIndex];
    if (legacyT != null) {
      const typeKey = _legacyTToType(legacyT);
      this._seq?.setAdapter(typeKey, null); // null → restores default WASM adapter
    }
    // Clear synth slot adapter too
    this._seq?.setAdapter(`synth${slotIndex}`, null);

    if (this._editingSlot === slotIndex) { this._editingSlot = null; this._clearEditor(); }
    this._refreshSlotCards();
    this._saveSession();
  }

  // ── Graph FX management ─────────────────────────────────────────────────────

  /**
   * Add a graph-based FX unit from wizard output.
   * Creates a GraphFxAdapter, inits it, and registers with MasterFx.
   */
  async _addGraphFx(state) {
    if (!this._ctx || !this._fx) {
      console.warn('[SynthLab] Cannot add graph FX — no audio context or MasterFx');
      return;
    }
    const graphJson = typeof state.graphJson === 'string'
      ? state.graphJson : JSON.stringify(state);
    const adapter = new GraphFxAdapter(this._ctx, graphJson, {
      id: state.id || 'gfx_' + Date.now(),
    });

    try {
      await adapter.init(window._wasmModule);
    } catch (e) {
      console.error('[SynthLab] Graph FX init failed:', e);
      return;
    }

    const sendSlot = this._fx.addGraphFx(adapter, state.name || 'Graph FX');
    const entry = { adapter, name: state.name || 'Graph FX', sendSlot, state };
    this._graphFxSlots.push(entry);
    this._refreshFxPanel();
    console.log(`[SynthLab] Graph FX "${entry.name}" added as send slot ${sendSlot}`);
  }

  /**
   * Remove a graph FX by index in _graphFxSlots.
   */
  removeGraphFx(gfxIndex) {
    if (gfxIndex < 0 || gfxIndex >= this._graphFxSlots.length) return;
    const entry = this._graphFxSlots[gfxIndex];
    this._fx?.removeGraphFx(gfxIndex);
    this._graphFxSlots.splice(gfxIndex, 1);
    // Re-index sendSlot values
    for (let i = 0; i < this._graphFxSlots.length; i++) {
      this._graphFxSlots[i].sendSlot = 2 + i;
    }
    this._refreshFxPanel();
    console.log(`[SynthLab] Graph FX "${entry.name}" removed`);
  }

  /**
   * Schedule a noteOn + noteOff for the given slot.
   * Delegates to the slot's WebAudioInstrumentAdapter.
   */
  scheduleNote(slotIndex, midiNote, velocity, audioTime, holdMs) {
    const slot = this._slots[slotIndex];
    if (!slot?.adapter || slot.muted) return;
    slot.adapter.scheduleNote(midiNote, velocity, audioTime, holdMs);
  }

  // ── Modular plug / unplug / swap ─────────────────────────────────────────────

  /**
   * Load an instrument from the registry into a slot.
   * @param {number} slotIndex
   * @param {string} registryId - must be a 'webaudio' type entry in the registry
   */
  plug(slotIndex, registryId) {
    const desc = registry.get(registryId);
    if (!desc) { console.warn(`[SynthLab] plug: unknown id "${registryId}"`); return; }
    if ((desc.type !== 'webaudio' && desc.type !== 'wasm_graph') || !desc.state) {
      console.warn(`[SynthLab] plug: "${registryId}" has no patch state`); return;
    }
    this.loadPatch(slotIndex, desc.state);
  }

  /**
   * Remove the patch from a slot (restore default WASM for its legacy track).
   * @param {number} slotIndex
   */
  unplug(slotIndex) {
    this.clearSlot(slotIndex);
  }

  /**
   * Atomically replace a slot's current instrument with one from the registry.
   * @param {number} slotIndex
   * @param {string} registryId
   */
  swap(slotIndex, registryId) {
    this.clearSlot(slotIndex);
    this.plug(slotIndex, registryId);
  }

  // ── Registry helpers ─────────────────────────────────────────────────────────

  _registerPatch(slotIndex, patchState) {
    // Generate a stable id from the patch name + slot so re-loading the same
    // patch doesn't create duplicates.
    const safeName = (patchState.name || 'untitled').replace(/\s+/g, '_').toLowerCase();
    const id = `patch:${safeName}_s${slotIndex}`;
    const role = _patchStateToRole(patchState, this._slotLegacyT[slotIndex]);
    try {
      registry.register({
        id,
        name:    patchState.name || 'Untitled',
        role,
        type:    patchState.type === 'wasm_graph' ? 'wasm_graph' : 'webaudio',
        builtIn: false,
        state:   JSON.parse(JSON.stringify(patchState)),
      });
    } catch (_) {}
    return id;
  }

  setMute(slotIndex, muted) {
    const slot = this._slots[slotIndex];
    if (!slot) return;
    slot.muted = muted;
    if (slot.gain) slot.gain.gain.value = muted ? 0 : slot.volume;
  }

  setVolume(slotIndex, value) {
    const slot = this._slots[slotIndex];
    if (!slot) return;
    slot.volume = Math.max(0, Math.min(1, value));
    if (slot.gain && !slot.muted) slot.gain.gain.value = slot.volume;
  }

  getSlotState(slotIndex) {
    return this._slots[slotIndex]?.adapter?.getState() ?? null;
  }

  // ── UI ───────────────────────────────────────────────────────────────────────

  buildUI() {
    if (this._uiBuilt) return;
    this._uiBuilt = true;
    this._refreshSlotCards();
    this._refreshFxPanel();
    this._clearEditor();
  }

  _refreshSlotCards() {
    const row = document.getElementById('synth-slots-row');
    if (!row) return;
    row.innerHTML = '';

    this._slots.forEach((slot, i) => {
      const t           = this._slotLegacyT[i];
      const slotLabel   = LEGACY_T_NAMES[t] ?? `SYNTH ${i + 1}`;
      const state       = slot.adapter?.getState() ?? null;
      const accentStyle = t === 10 ? ' style="color:#f4a261"' : '';

      const card = document.createElement('div');
      card.className = 'synth-slot-card' + (this._editingSlot === i ? ' ssc-active' : '');

      const assignSel = `
        <select class="ssc-assign-sel" title="Assign slot to instrument track">
          <option value="0"  ${!t         ?'selected':''}>— own track —</option>
          <option value="10" ${t===10     ?'selected':''}>DRUMS</option>
          <option value="2"  ${t===2      ?'selected':''}>BASS FM</option>
          <option value="1"  ${t===1      ?'selected':''}>POLY FM</option>
          <option value="6"  ${t===6      ?'selected':''}>HYB PADS</option>
          <option value="3"  ${t===3      ?'selected':''}>RHODES EP</option>
        </select>`;

      if (state) {
        card.innerHTML = `
          <div class="ssc-slot-label"${accentStyle}>${slotLabel}</div>
          ${assignSel}
          <div class="ssc-name">${state.name || 'Untitled'}</div>
          <div class="ssc-tag">t:${SYNTH_SLOT_T[i]}</div>
          <div class="ssc-btns">
            <button class="ssc-edit-btn">EDIT</button>
            <button class="ssc-swap-btn" title="Swap from library">⇄ SWAP</button>
            <button class="ssc-load-btn" title="Load a .json patch file">↑ LOAD</button>
            <button class="ssc-clear-btn" title="Unplug — restore default WASM">⏏</button>
          </div>`;
        card.querySelector('.ssc-edit-btn').addEventListener('click',  () => this._openEditor(i));
        card.querySelector('.ssc-swap-btn').addEventListener('click',  () => this._openLibraryForSlot(i));
        card.querySelector('.ssc-load-btn').addEventListener('click',  () => this._pickAndLoadFile(i));
        card.querySelector('.ssc-clear-btn').addEventListener('click', () => {
          if (confirm(`Unplug slot ${i + 1}: "${state.name}"?`)) this.unplug(i);
        });
        card.addEventListener('click', e => { if (!e.target.closest('button,select')) this._openEditor(i); });
      } else {
        card.innerHTML = `
          <div class="ssc-empty"${accentStyle}>${slotLabel}</div>
          ${assignSel}
          <div class="ssc-tag">t:${SYNTH_SLOT_T[i]} · empty</div>
          <div class="ssc-btns" style="margin-top:.3rem;">
            <button class="ssc-new-btn" style="flex:1;">+ NEW</button>
            <button class="ssc-swap-btn" title="Load from library">⇄ LIBRARY</button>
            <button class="ssc-load-btn" title="Load a .json patch file">↑ LOAD</button>
          </div>`;
        card.querySelector('.ssc-new-btn').addEventListener('click',  () => this._openWizardForSlot(i));
        card.querySelector('.ssc-swap-btn').addEventListener('click', () => this._openLibraryForSlot(i));
        card.querySelector('.ssc-load-btn').addEventListener('click', () => this._pickAndLoadFile(i));
      }

      card.querySelector('.ssc-assign-sel').addEventListener('change', e => {
        const v = Number(e.target.value);
        this.reassignSlot(i, v === 0 ? null : v);
      });

      row.appendChild(card);
    });

    this._renderRoutingMatrix();
  }

  /** Render the Send FX sidebar panel showing active graph FX units. */
  _refreshFxPanel() {
    const row = document.getElementById('synth-fx-row');
    if (!row) return;
    row.innerHTML = '';

    for (let i = 0; i < this._graphFxSlots.length; i++) {
      const entry = this._graphFxSlots[i];
      const card = document.createElement('div');
      card.className = 'sfx-card';

      const nodeCount = entry.state?.nodes?.length || '?';
      card.innerHTML = `
        <div class="sfx-name">${entry.name}</div>
        <div class="sfx-info">send slot ${entry.sendSlot} · ${nodeCount} nodes</div>
        <div class="sfx-btns">
          <button class="sfx-edit" title="Edit FX parameters">EDIT</button>
          <button class="sfx-rm" title="Remove this FX unit">✕</button>
        </div>`;

      card.querySelector('.sfx-edit').addEventListener('click', () => {
        this._editGraphFx(i);
      });

      card.querySelector('.sfx-rm').addEventListener('click', () => {
        if (confirm(`Remove FX "${entry.name}"?`)) this.removeGraphFx(i);
      });

      row.appendChild(card);
    }

    // Add button — opens wizard in FX mode
    const addBtn = document.createElement('button');
    addBtn.className = 'sfx-add-btn';
    addBtn.textContent = '+ NEW SEND FX';
    addBtn.addEventListener('click', () => this._openWizardForFx());
    row.appendChild(addBtn);

    this._renderRoutingMatrix();
  }

  /** Render a routing matrix: one card per FX with sliders for each loaded synth slot. */
  _renderRoutingMatrix() {
    const mat = document.getElementById('synth-fx-matrix');
    if (!mat) return;
    mat.innerHTML = '';
    if (!this._fx) return;

    // Collect FX units: built-in delay (0), shaper (1), then graph FX (2+)
    const fxUnits = [
      { name: 'Delay', slot: 0 },
      { name: 'Shaper', slot: 1 },
    ];
    for (let i = 0; i < this._graphFxSlots.length; i++) {
      fxUnits.push({ name: this._graphFxSlots[i].name || `GFX${i}`, slot: 2 + i });
    }

    // Collect loaded synth slots
    const loadedSynths = [];
    for (let i = 0; i < this._slots.length; i++) {
      const slot = this._slots[i];
      if (slot.adapter) {
        const name = slot.adapter.getState()?.name || `SYNTH ${i}`;
        loadedSynths.push({ index: i, name });
      }
    }

    for (const fx of fxUnits) {
      const card = document.createElement('div');
      card.className = 'sfx-mat-card';

      const title = document.createElement('div');
      title.className = 'sfx-mat-title';
      title.textContent = `→ ${fx.name}`;
      title.title = fx.name;
      card.appendChild(title);

      if (loadedSynths.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'sfx-mat-empty';
        empty.textContent = 'load a synth to route';
        card.appendChild(empty);
      } else {
        for (const s of loadedSynths) {
          const instrKey = `synth${s.index}`;
          const current  = this._fx._sendVals[fx.slot]?.[instrKey] ?? 0;

          const row = document.createElement('div');
          row.className = 'sfx-mat-row';

          const label = document.createElement('div');
          label.className = 'sfx-mat-label';
          label.textContent = s.name;
          label.title = s.name;

          const slider = document.createElement('input');
          slider.type = 'range';
          slider.min = '0';
          slider.max = '1';
          slider.step = '0.01';
          slider.value = String(current);

          const valEl = document.createElement('div');
          valEl.className = 'sfx-mat-val';
          valEl.textContent = current.toFixed(2);

          slider.addEventListener('input', () => {
            const v = Number(slider.value);
            valEl.textContent = v.toFixed(2);
            this._fx.setSend(fx.slot, instrKey, v);
          });

          row.appendChild(label);
          row.appendChild(slider);
          row.appendChild(valEl);
          card.appendChild(row);
        }
      }

      mat.appendChild(card);
    }
  }

  /** Open the wizard overlay in FX creation mode. */
  _openWizardForFx() {
    if (!this._ctx) {
      alert('Start playback first to activate the audio context, then add FX.');
      return;
    }
    if (!this._fx) {
      alert('MasterFx not connected — start the sequencer first.');
      return;
    }
    const overlay = document.getElementById('synth-wizard-overlay');
    const body    = document.getElementById('synth-wizard-body');
    if (!overlay || !body) return;
    overlay.classList.add('open');
    body.innerHTML = '';

    const wizard = new LLMWizard(state => {
      overlay.classList.remove('open');
      if (state.type === 'graph_fx') {
        this._addGraphFx(state);
      } else {
        // If the LLM returned a synth instead of FX, load into first empty slot
        const emptySlot = this._slots.findIndex(s => !s.adapter);
        const target = emptySlot >= 0 ? emptySlot : 0;
        this.loadPatch(target, state);
        this._openEditor(target);
      }
    }, 'I want to design a send effect (like a delay, reverb, or creative FX chain). Build it as an FX graph with an input node.');
    wizard.render(body);
  }

  /** Open the editor for a graph FX unit (shows param knobs in main editor area). */
  _editGraphFx(gfxIndex) {
    const entry = this._graphFxSlots[gfxIndex];
    if (!entry) return;

    this._editingSlot = null; // deselect any synth slot
    this._refreshSlotCards();

    const ed = document.getElementById('synth-lab-editor');
    if (!ed) return;
    ed.innerHTML = '';

    // Header
    const hdr = document.createElement('div');
    hdr.className = 'sle-header';
    hdr.innerHTML = `
      <span class="sle-name">${entry.name}</span>
      <span class="sle-badge" style="background:#0a1a2a;color:#4ea8de;border-color:#1a3a5a;">SEND FX</span>
      <span class="sle-track" style="color:#4ea8de;" title="Send slot ${entry.sendSlot}">
        [send:${entry.sendSlot} ●]
      </span>`;
    ed.appendChild(hdr);

    // Rack with graph param panels
    const rackArea = document.createElement('div');
    rackArea.className = 'sle-rack-area';
    const rack = document.createElement('div');
    rack.className = 'sle-rack';
    rackArea.appendChild(rack);
    ed.appendChild(rackArea);

    this._renderGraphFxPanels(entry, rack);
  }

  /** Render knob panels for a graph FX unit's parameters. */
  _renderGraphFxPanels(entry, rack) {
    const adapter = entry.adapter;
    const paramMap = adapter.paramMap;
    if (!paramMap?.length) {
      rack.innerHTML = '<div style="color:#555;font-family:monospace;font-size:.7rem;padding:1rem;">No parameters available</div>';
      return;
    }

    // Group params by node ID
    const groups = {};
    for (const p of paramMap) {
      (groups[p.node] = groups[p.node] || []).push(p);
    }

    // Lightweight bridge shim: stores current values, routes set() to adapter
    const values = {};
    for (const p of paramMap) values[`${p.node}.${p.param}`] = p.default ?? 0;
    const graphBridge = {
      get(path) { return values[path] ?? 0; },
      set(path, v) {
        values[path] = v;
        const [nodeId, paramName] = path.split('.');
        adapter.setParam(nodeId, paramName, v);
      },
    };

    for (const [nodeId, params] of Object.entries(groups)) {
      const nodeType = params[0]?.nodeType || _guessNodeType(params);
      const color    = GRAPH_NODE_COLORS[nodeType] || '#555';

      const knobs = params.map(p => {
        const key  = `${p.node}.${p.param}`;
        return {
          label: p.param.toUpperCase(),
          path:  key,
          min: p.min, max: p.max,
          value: p.default ?? 0,
          step:     _graphParamStep(p),
          decimals: _graphParamDecimals(p),
          unit:     _graphParamUnit(p),
          onAudio:  v => adapter.setParam(p.node, p.param, v),
        };
      });

      const panel = new ModulePanel({ title: nodeId, color, bridge: graphBridge, knobs });
      rack.appendChild(panel.render());
    }
  }

  /** Render FX send knobs for a synth slot so the user can route it to effects. */
  _renderSendKnobs(slotIndex, container) {
    if (!this._fx) return;
    const instrKey = `synth${slotIndex}`;
    const fx = this._fx;

    // Collect available FX slots: delay (0), shaper (1), plus graph FX (2+)
    const sends = [
      { label: '→DLY', slot: 0 },
      { label: '→SHP', slot: 1 },
    ];
    for (let i = 0; i < this._graphFxSlots.length; i++) {
      const name = this._graphFxSlots[i].name || `GFX${i}`;
      // Truncate long names for knob labels
      const short = name.length > 6 ? name.slice(0, 5) + '…' : name;
      sends.push({ label: `→${short.toUpperCase()}`, slot: 2 + i });
    }
    if (sends.length === 0) return;

    const sendValues = {};
    const knobs = sends.map(s => {
      const path = `send.${s.slot}`;
      sendValues[path] = fx._sendVals[s.slot]?.[instrKey] ?? 0;
      return {
        label: s.label,
        path,
        min: 0, max: 1,
        value: sendValues[path],
        step: 0.01,
        decimals: 2,
      };
    });

    const bridge = {
      get(path) { return sendValues[path] ?? 0; },
      set(path, v) {
        sendValues[path] = v;
        const fxSlot = Number(path.split('.')[1]);
        fx.setSend(fxSlot, instrKey, v);
      },
    };

    const panel = new ModulePanel({
      title: 'FX SENDS',
      color: '#4ea8de',
      bridge,
      knobs,
    });
    container.appendChild(panel.render());
  }

  _openEditor(slotIndex) {
    this._editingSlot = slotIndex;
    this._refreshSlotCards();
    this._renderEditor(slotIndex);
  }

  _clearEditor() {
    const ed = document.getElementById('synth-lab-editor');
    if (ed) ed.innerHTML = '<div class="sle-placeholder">← Select a slot to edit, or create a new synth</div>';
  }

  _renderEditor(slotIndex) {
    const slot  = this._slots[slotIndex];
    const state = slot?.adapter?.getState();
    const ed    = document.getElementById('synth-lab-editor');
    if (!ed || !state) return;
    ed.innerHTML = '';

    // Header
    const hdr = document.createElement('div');
    hdr.className = 'sle-header';
    hdr.innerHTML = `
      <span class="sle-name">${state.name}</span>
      <span class="sle-badge">${(state.type || 'synth').toUpperCase()}</span>
      <span class="sle-track" title="This synth plays on track type ${SYNTH_SLOT_T[slotIndex]} in the sequencer — it's live!">[t:${SYNTH_SLOT_T[slotIndex]} ●]</span>
      <div class="sle-action-btns">
        <button id="sle-wizard-btn">WIZARD</button>
        <button id="sle-import-btn" title="Load a .json patch file into this slot">IMPORT</button>
        <button id="sle-forge-btn" class="sle-forge" title="Export this patch as .json — re-load it later via IMPORT">FORGE ↓</button>
      </div>`;
    ed.appendChild(hdr);

    // KNOBS / XY toggle tabs
    const ctrlTabs = document.createElement('div');
    ctrlTabs.className = 'sle-ctrl-tabs';
    ctrlTabs.innerHTML = `
      <button class="sle-ctrl-tab ct-active">KNOBS</button>
      <button class="sle-ctrl-tab">XY</button>`;
    ed.appendChild(ctrlTabs);

    // Module rack
    const rackArea = document.createElement('div');
    rackArea.className = 'sle-rack-area';
    const rack = document.createElement('div');
    rack.className = 'sle-rack module-rack';
    rackArea.appendChild(rack);
    ed.appendChild(rackArea);

    // Graph patches use dynamic panels from param map; legacy uses fixed panels
    if (state.type === 'wasm_graph' && slot.adapter?.paramMap) {
      slot.panels = this._renderGraphPanels(slot, rack);
    } else {
      slot.panels = this._renderPanels(slot, rack);
    }

    // FX Send knobs — route this synth slot into available FX
    this._renderSendKnobs(slotIndex, rackArea);

    // XY pad area
    const xyArea = document.createElement('div');
    xyArea.className = 'sle-xy-area';
    xyArea.style.cssText = 'display:none;padding:.6rem 1rem;';
    const xyProfiles = state.type === 'wasm_graph'
      ? this._buildGraphXYProfiles(slot)
      : [
          { name: 'FILTER SWEEP',
            x: { label:'CUTOFF', min:20, max:18000, scale:'log',
                 get: ()  => slot.adapter?.bridge.get('modules.vcf.cutoff'),
                 set: val => { slot.adapter?.bridge.set('modules.vcf.cutoff', val); slot.adapter?.voices.forEach(v => v.setVcfParam('cutoff', val)); } },
            y: { label:'RESO',   min:0.01, max:20, scale:'log',
                 get: ()  => slot.adapter?.bridge.get('modules.vcf.resonance'),
                 set: val => { slot.adapter?.bridge.set('modules.vcf.resonance', val); slot.adapter?.voices.forEach(v => v.setVcfParam('resonance', val)); } } },
          { name: 'TIMBRE',
            x: { label:'CUTOFF', min:20, max:18000, scale:'log',
                 get: ()  => slot.adapter?.bridge.get('modules.vcf.cutoff'),
                 set: val => { slot.adapter?.bridge.set('modules.vcf.cutoff', val); slot.adapter?.voices.forEach(v => v.setVcfParam('cutoff', val)); } },
            y: { label:'LFO AMT', min:1, max:2000, scale:'log',
                 get: ()  => slot.adapter?.bridge.get('modules.lfo.amount'),
                 set: val => { slot.adapter?.bridge.set('modules.lfo.amount', val); slot.adapter?.voices.forEach(v => v.setLfoParam('amount', val)); } } },
          { name: 'ENVELOPE',
            x: { label:'ATTACK',  min:0.001, max:4, scale:'log',
                 get: ()  => slot.adapter?.bridge.get('modules.adsr_amp.attack'),
                 set: val => { slot.adapter?.bridge.set('modules.adsr_amp.attack', val); slot.adapter?.voices.forEach(v => v.setAmpParam('attack', val)); } },
            y: { label:'RELEASE', min:0.01, max:8, scale:'log',
                 get: ()  => slot.adapter?.bridge.get('modules.adsr_amp.release'),
                 set: val => { slot.adapter?.bridge.set('modules.adsr_amp.release', val); slot.adapter?.voices.forEach(v => v.setAmpParam('release', val)); } } },
        ];
    const synthXY = new XYPad({
      accentColor: '#2a9d8f',
      profiles: xyProfiles,
    });
    xyArea.appendChild(synthXY.render());
    ed.appendChild(xyArea);

    // Piano
    const pianoArea = document.createElement('div');
    pianoArea.className = 'sle-piano-area piano-area';
    pianoArea.innerHTML = `
      <div class="keyboard-hint">A–L = white keys &nbsp;·&nbsp; W E T Y U O P = black &nbsp;·&nbsp; Z/X = octave</div>
      <div class="sle-piano-container piano-container"></div>`;
    ed.appendChild(pianoArea);

    const piano = new PianoKeys({
      onNoteOn:  (midi) => {
        if (this._ctx && slot.adapter) {
          this._ctx.resume?.();
          slot.adapter.noteOn(midi, 100);
        }
      },
      onNoteOff: (midi) => { slot.adapter?.noteOff(midi); },
      octave: 3,
    });
    pianoArea.querySelector('.sle-piano-container').appendChild(piano.render());

    // Wire KNOBS/XY toggle
    const [kBtn, xBtn] = ctrlTabs.querySelectorAll('.sle-ctrl-tab');
    kBtn.addEventListener('click', () => {
      kBtn.classList.add('ct-active'); xBtn.classList.remove('ct-active');
      rackArea.style.display = ''; xyArea.style.display = 'none';
    });
    xBtn.addEventListener('click', () => {
      xBtn.classList.add('ct-active'); kBtn.classList.remove('ct-active');
      rackArea.style.display = 'none'; xyArea.style.display = '';
      synthXY.syncDot();
    });

    // Wire action buttons
    hdr.querySelector('#sle-wizard-btn').addEventListener('click', () => this._openWizardForSlot(slotIndex));
    hdr.querySelector('#sle-forge-btn').addEventListener('click',  () => this._forgeSlot(slotIndex));
    hdr.querySelector('#sle-import-btn').addEventListener('click', () => {
      const inp = document.createElement('input');
      inp.type = 'file'; inp.accept = '.json';
      inp.onchange = e => { if (e.target.files[0]) this.loadPatchFile(slotIndex, e.target.files[0]); };
      inp.click();
    });
  }

  _renderPanels(slot, rackEl) {
    const panels = [];
    const state  = slot.adapter.getState();
    const bridge = slot.adapter.bridge;
    const m      = state.modules;
    // Proxy forwards live knob updates to every voice in the pool
    const v = this._allVoices(slot);

    // ── Oscillator ──
    const vcoPanel = new ModulePanel({
      title: 'OSCILLATOR', color: '#ff006e', bridge,
      knobs: [
        { label: 'DETUNE',    path: 'modules.vco.detune',        min: -100, max: 100,  step: 1, decimals: 0, unit: 'c',  onAudio: x => v?.setVcoParam('detune', x) },
        { label: 'OSC2 MIX', path: 'modules.vco.mix2',          min: 0,    max: 1,                                        onAudio: x => v?.setVcoParam('mix2', x) },
        { label: 'OSC2 DET', path: 'modules.vco.detune2',        min: -24,  max: 24,   step: 1, decimals: 0, unit: 'st', onAudio: x => v?.setVcoParam('detune2', x) },
        { label: 'UNISON',   path: 'modules.vco.unison',         min: 1,    max: 7,    step: 1, decimals: 0,              onAudio: x => v?.setVcoParam('unison', x) },
        { label: 'UNI DET',  path: 'modules.vco.unison_detune',  min: 0,    max: 50,   decimals: 1, unit: 'c',            onAudio: x => v?.setVcoParam('unison_detune', x) },
        { label: 'NOISE',    path: 'modules.vco.noise_mix',      min: 0,    max: 1,                                        onAudio: x => v?.setVcoParam('noise_mix', x) },
      ],
    });
    const vcoEl = vcoPanel.render();
    vcoEl.appendChild(_makeSelect('WAVE 1', ['sine','sawtooth','square','triangle'], m.vco.waveform,        x => { bridge.set('modules.vco.waveform',       x); v?.setVcoParam('waveform', x); }));
    vcoEl.appendChild(_makeSelect('WAVE 2', ['sine','sawtooth','square','triangle'], m.vco.waveform2,       x => { bridge.set('modules.vco.waveform2',      x); v?.setVcoParam('waveform2', x); }));
    vcoEl.appendChild(_makeToggle('OSC 2',  m.vco.enabled2,                                                x => { bridge.set('modules.vco.enabled2',       x); v?.setVcoParam('enabled2', x); }));
    vcoEl.appendChild(_makeToggle('NOISE',  m.vco.noise_enabled || false,                                  x => { bridge.set('modules.vco.noise_enabled',  x); v?.setVcoParam('noise_enabled', x); }));
    rackEl.appendChild(vcoEl); panels.push(vcoPanel);

    // ── FM Modulator (only shown when patch uses FM) ──
    if (m.vco_fm?.enabled) {
      const fmPanel = new ModulePanel({
        title: 'FM MOD', color: '#f4a261', bridge,
        knobs: [
          { label: 'RATIO',  path: 'modules.vco_fm.ratio',  min: 0.25, max: 16,   scale: 'log', decimals: 2, onAudio: x => v?.setFmParam('ratio', x) },
          { label: 'AMOUNT', path: 'modules.vco_fm.amount', min: 0,    max: 8000, scale: 'log', decimals: 0, unit: 'Hz', onAudio: x => v?.setFmParam('amount', x) },
        ],
      });
      const fmEl = fmPanel.render();
      fmEl.appendChild(_makeSelect('MOD WAVE', ['sine','sawtooth','square','triangle'], m.vco_fm.waveform,
        x => { bridge.set('modules.vco_fm.waveform', x); v?.setFmParam('waveform', x); }));
      fmEl.appendChild(_makeToggle('FM ON', m.vco_fm.enabled,
        x => { bridge.set('modules.vco_fm.enabled', x); v?.setFmParam('enabled', x); }));
      rackEl.appendChild(fmEl); panels.push(fmPanel);
    }

    // ── Filter ──
    const vcfPanel = new ModulePanel({
      title: 'FILTER', color: '#2a9d8f', bridge,
      knobs: [
        { label: 'CUTOFF', path: 'modules.vcf.cutoff',    min: 20, max: 18000, decimals: 0, unit: 'Hz', scale: 'log', onAudio: x => v?.setVcfParam('cutoff', x) },
        { label: 'RESO',   path: 'modules.vcf.resonance', min: 0.01, max: 20,  scale: 'log',                           onAudio: x => v?.setVcfParam('resonance', x) },
      ],
    });
    const vcfEl = vcfPanel.render();
    vcfEl.appendChild(_makeSelect('TYPE', ['lowpass','highpass','bandpass','notch'], m.vcf.type, x => { bridge.set('modules.vcf.type', x); v?.setVcfParam('type', x); }));
    rackEl.appendChild(vcfEl); panels.push(vcfPanel);

    // ── Amp Envelope ──
    const ampPanel = new ModulePanel({
      title: 'AMP ENV', color: '#e9c46a', bridge,
      knobs: [
        { label: 'ATTACK',  path: 'modules.adsr_amp.attack',  min: 0.001, max: 4,  scale: 'log', onAudio: x => v?.setAmpParam('attack', x) },
        { label: 'DECAY',   path: 'modules.adsr_amp.decay',   min: 0.001, max: 4,  scale: 'log', onAudio: x => v?.setAmpParam('decay', x) },
        { label: 'SUSTAIN', path: 'modules.adsr_amp.sustain', min: 0,     max: 1,                onAudio: x => v?.setAmpParam('sustain', x) },
        { label: 'RELEASE', path: 'modules.adsr_amp.release', min: 0.01,  max: 8,  scale: 'log', onAudio: x => v?.setAmpParam('release', x) },
      ],
    });
    rackEl.appendChild(ampPanel.render()); panels.push(ampPanel);

    // ── Filter Envelope ──
    const fltPanel = new ModulePanel({
      title: 'FILTER ENV', color: '#264653', bridge,
      knobs: [
        { label: 'ATTACK',  path: 'modules.adsr_filter.attack',  min: 0.001, max: 4, scale: 'log', onAudio: x => v?.setFilterEnvParam('attack', x) },
        { label: 'DECAY',   path: 'modules.adsr_filter.decay',   min: 0.001, max: 4, scale: 'log', onAudio: x => v?.setFilterEnvParam('decay', x) },
        { label: 'SUSTAIN', path: 'modules.adsr_filter.sustain', min: 0,     max: 1,               onAudio: x => v?.setFilterEnvParam('sustain', x) },
        { label: 'AMOUNT',  path: 'modules.adsr_filter.amount',  min: 0,     max: 1,               onAudio: x => v?.setFilterEnvParam('amount', x) },
      ],
    });
    rackEl.appendChild(fltPanel.render()); panels.push(fltPanel);

    // ── LFO ──
    const lfoPanel = new ModulePanel({
      title: 'LFO', color: '#8338ec', bridge,
      knobs: [
        { label: 'RATE',   path: 'modules.lfo.rate',   min: 0.01, max: 20,   scale: 'log', decimals: 2, unit: 'Hz', onAudio: x => v?.setLfoParam('rate', x) },
        { label: 'AMOUNT', path: 'modules.lfo.amount', min: 1,    max: 2000, scale: 'log', decimals: 0, unit: 'Hz', onAudio: x => v?.setLfoParam('amount', x) },
      ],
    });
    const lfoEl = lfoPanel.render();
    lfoEl.appendChild(_makeSelect('WAVE', ['sine','triangle','sawtooth','square'], m.lfo.waveform, x => { bridge.set('modules.lfo.waveform', x); v?.setLfoParam('waveform', x); }));
    lfoEl.appendChild(_makeToggle('LFO ON', m.lfo.enabled, x => { bridge.set('modules.lfo.enabled', x); v?.setLfoParam('enabled', x); }));
    rackEl.appendChild(lfoEl); panels.push(lfoPanel);

    // ── Effects ──
    _renderEffectPanels(state.modules.effects || [], rackEl, panels, bridge, v);

    return panels;
  }

  // ── Graph-patch dynamic panels ────────────────────────────────────────────

  /**
   * Build editor panels dynamically from a WasmGraphAdapter's paramMap.
   * Groups params by node ID, one ModulePanel per node.
   */
  _renderGraphPanels(slot, rackEl) {
    const panels  = [];
    const adapter = slot.adapter;
    const pMap    = adapter.paramMap; // array of { index, node, param, min, max, default }
    if (!pMap || pMap.length === 0) return panels;

    // Group params by node id, preserving param order
    const nodeGroups = new Map();
    for (const p of pMap) {
      if (!nodeGroups.has(p.node)) nodeGroups.set(p.node, []);
      nodeGroups.get(p.node).push(p);
    }

    // Lightweight bridge shim: stores current values, routes set() to adapter
    const values = {};
    for (const p of pMap) {
      values[`${p.node}.${p.param}`] = p.default;
    }
    const graphBridge = {
      get(path) { return values[path] ?? 0; },
      set(path, v) {
        values[path] = v;
        const [nodeId, paramName] = path.split('.');
        adapter.setGraphParam(nodeId, paramName, v);
      },
    };

    for (const [nodeId, params] of nodeGroups) {
      // Skip output node — it usually just has a gain knob, but include it
      const nodeType = _guessNodeType(params);
      const color    = GRAPH_NODE_COLORS[nodeType] || '#555';
      const title    = `${nodeType.toUpperCase()} — ${nodeId}`;

      const knobs = params.map(p => {
        const key = `${p.node}.${p.param}`;
        return {
          label:    p.param.toUpperCase().replace(/_/g, ' '),
          path:     key,
          min:      p.min,
          max:      p.max,
          value:    p.default,
          step:     _graphParamStep(p),
          decimals: _graphParamDecimals(p),
          unit:     _graphParamUnit(p),
          scale:    _graphParamScale(p),
          onAudio:  v => adapter.setGraphParam(p.node, p.param, v),
        };
      });

      // Skip nodes with no tweakable params (e.g. Noise)
      if (knobs.length === 0) continue;

      const panel = new ModulePanel({ title, color, bridge: graphBridge, knobs });
      const el = panel.render();

      // Add waveform selector for oscillator nodes
      if (nodeType === 'oscillator') {
        const wfParam = params.find(p => p.param === 'waveform');
        if (wfParam) {
          const wfIdx = Math.round(wfParam.default);
          const wfNames = ['Sine', 'Saw', 'Square', 'Triangle', 'Pulse'];
          el.appendChild(_makeSelect('WAVE', wfNames.map((_, i) => String(i)), String(wfIdx),
            x => {
              const v = Number(x);
              graphBridge.set(`${nodeId}.waveform`, v);
            }));
          // Override the select option labels
          const sel = el.querySelector('.module-select:last-of-type');
          if (sel) {
            Array.from(sel.options).forEach((opt, i) => { opt.textContent = wfNames[i] || opt.value; });
          }
        }
      }

      rackEl.appendChild(el);
      panels.push(panel);
    }

    return panels;
  }

  /**
   * Build XY pad profiles from a graph adapter's paramMap.
   * Auto-detects filter (cutoff/resonance), envelope (attack/release),
   * and creates up to 3 profiles.
   */
  _buildGraphXYProfiles(slot) {
    const adapter  = slot.adapter;
    const pLookup  = adapter.paramLookup; // "node.param" → { index, min, max, default }
    const profiles = [];

    // Helper: make a get/set pair for a graph param
    const _axis = (key, label, min, max, scale = 'linear') => {
      let current = pLookup[key]?.default ?? min;
      return {
        label, min, max, scale,
        get: () => current,
        set: v => { current = v; const [nid, pn] = key.split('.'); adapter.setGraphParam(nid, pn, v); },
      };
    };

    // Find filter nodes (cutoff + resonance)
    for (const [key, desc] of Object.entries(pLookup)) {
      if (desc.param === 'cutoff') {
        const nodeId  = desc.node;
        const resoKey = `${nodeId}.resonance`;
        if (pLookup[resoKey]) {
          profiles.push({
            name: `FILTER (${nodeId})`,
            x: _axis(key, 'CUTOFF', desc.min, desc.max, 'log'),
            y: _axis(resoKey, 'RESO', pLookup[resoKey].min, pLookup[resoKey].max, 'linear'),
          });
          break; // one filter profile is enough
        }
      }
    }

    // Find envelope nodes (attack + release)
    for (const [key, desc] of Object.entries(pLookup)) {
      if (desc.param === 'attack') {
        const nodeId = desc.node;
        const relKey = `${nodeId}.release`;
        if (pLookup[relKey]) {
          profiles.push({
            name: `ENVELOPE (${nodeId})`,
            x: _axis(key, 'ATTACK', desc.min, desc.max, 'log'),
            y: _axis(relKey, 'RELEASE', pLookup[relKey].min, pLookup[relKey].max, 'log'),
          });
          break;
        }
      }
    }

    // Find delay/reverb (time/size + mix)
    for (const [key, desc] of Object.entries(pLookup)) {
      if (desc.param === 'time' || desc.param === 'room_size') {
        const nodeId = desc.node;
        const mixKey = `${nodeId}.mix`;
        if (pLookup[mixKey]) {
          profiles.push({
            name: `FX (${nodeId})`,
            x: _axis(key, desc.param.toUpperCase().replace(/_/g, ' '), desc.min, desc.max, 'log'),
            y: _axis(mixKey, 'MIX', pLookup[mixKey].min, pLookup[mixKey].max, 'linear'),
          });
          break;
        }
      }
    }

    // Fallback: at least one generic profile using the first two params
    if (profiles.length === 0) {
      const allParams = Object.entries(pLookup);
      if (allParams.length >= 2) {
        const [k1, d1] = allParams[0];
        const [k2, d2] = allParams[1];
        profiles.push({
          name: 'PARAM',
          x: _axis(k1, d1.param.toUpperCase(), d1.min, d1.max),
          y: _axis(k2, d2.param.toUpperCase(), d2.min, d2.max),
        });
      }
    }

    return profiles;
  }

  _openWizardForSlot(slotIndex) {
    if (!this._ctx) {
      alert('Start playback first to activate the audio context, then open the Wizard.');
      return;
    }
    const overlay = document.getElementById('synth-wizard-overlay');
    const body    = document.getElementById('synth-wizard-body');
    if (!overlay || !body) return;
    overlay.classList.add('open');
    body.innerHTML = '';

    const wizard = new LLMWizard(state => {
      overlay.classList.remove('open');

      if (state.type === 'graph_fx') {
        // FX graph → add as a send FX via MasterFx
        this._addGraphFx(state);
        return;
      }

      // Synth patch → route to whichever slot owns the target legacy track type
      const targetT  = REPLACES_KEY_TO_T[state.replaces];
      const targetSlot = (targetT !== undefined ? this._legacyTToSlot[targetT] : undefined) ?? slotIndex;
      this.loadPatch(targetSlot, state);
      this._openEditor(targetSlot);
    });
    wizard.render(body);
  }

  _forgeSlot(slotIndex) {
    const slot = this._slots[slotIndex];
    if (!slot?.adapter) return;
    const json = slot.adapter.getState();
    json.clankers            = buildClankersMeta(json);
    json.clankers.trackType  = SYNTH_SLOT_T[slotIndex];
    const blob = new Blob([JSON.stringify(json, null, 2)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = Object.assign(document.createElement('a'), { href: url,
      download: (json.name || 'synth').replace(/\s+/g, '_').toLowerCase() + '.json' });
    a.click();
    URL.revokeObjectURL(url);
  }

  loadPatchFile(slotIndex, file) {
    const reader = new FileReader();
    reader.onload = e => {
      try {
        const state = JSON.parse(e.target.result);
        this.loadPatch(slotIndex, state);
        this._openEditor(slotIndex);
      } catch (err) {
        alert('Invalid patch file: ' + err.message);
      }
    };
    reader.readAsText(file);
  }

  /** Called when the sequencer connects — re-register adapters for any already-loaded slots. */
  _reapplyOverrides() {
    this._slots.forEach((slot, i) => {
      if (slot.adapter) {
        const legacyT = this._slotLegacyT[i];
        if (legacyT != null) {
          this._seq?.setAdapter(_legacyTToType(legacyT), slot.adapter);
        }
        this._seq?.setAdapter(`synth${i}`, slot.adapter);
      }
    });
  }

  /** Reassign a slot to a different legacy track type. Swaps with another slot if needed. */
  reassignSlot(slotIndex, newLegacyT) {
    const oldT = this._slotLegacyT[slotIndex];
    if (oldT === newLegacyT) return;

    // If another slot already owns newLegacyT, swap them
    const other = this._legacyTToSlot[newLegacyT];
    if (other !== undefined) {
      this._slotLegacyT[other] = oldT;
      if (this._slots[other].adapter && oldT != null) {
        this._seq?.setAdapter(_legacyTToType(oldT), this._slots[other].adapter);
      }
    }

    this._slotLegacyT[slotIndex] = newLegacyT;
    if (this._slots[slotIndex].adapter) {
      // Remove from old type (restores WASM default)
      if (oldT != null) this._seq?.setAdapter(_legacyTToType(oldT), null);
      // Register on new type (if not "own track" / null)
      if (newLegacyT != null) this._seq?.setAdapter(_legacyTToType(newLegacyT), this._slots[slotIndex].adapter);
    }

    this._saveSession();
    this._refreshSlotCards();
  }

  /** Public getter for the legacy track type a slot is currently assigned to. */
  getSlotAssignment(slotIndex) { return this._slotLegacyT[slotIndex]; }

  // ── Persistence ──────────────────────────────────────────────────────────────

  _saveSession() {
    const session = {
      assignments: { ...this._slotLegacyT },
      patches:     this._slots.map(s => s.adapter ? s.adapter.getState() : null),
    };
    try { localStorage.setItem('clankers_synth_lab', JSON.stringify(session)); } catch (_) {}
  }

  _restoreAssignments() {
    try {
      const raw = localStorage.getItem('clankers_synth_lab');
      if (!raw) return;
      const { assignments } = JSON.parse(raw);
      const valid = new Set([1, 2, 3, 6, 10]);
      if (assignments) {
        for (const [k, v] of Object.entries(assignments)) {
          if (valid.has(v)) this._slotLegacyT[Number(k)] = v;
        }
      }
    } catch (_) {}
  }

  _restorePatches() {
    try {
      const raw = localStorage.getItem('clankers_synth_lab');
      if (!raw) return;
      const { patches } = JSON.parse(raw);
      patches?.forEach((state, i) => { if (state) this.loadPatch(i, state); });
    } catch (_) {}
  }

  /** Open the library browser and wire it to load into the given slot. */
  _openLibraryForSlot(slotIndex) {
    this._buildUI();
    const panel = document.getElementById('synth-library-panel');
    if (!panel) return;
    this._libraryTargetSlot = slotIndex;
    panel.classList.add('slp-open');
    this._renderLibraryPanel();
  }

  /** Build and render the library browser panel contents. */
  _renderLibraryPanel() {
    const panel = document.getElementById('synth-library-panel');
    if (!panel) return;
    const allPatches = registry.list().filter(d => d.type === 'webaudio' && d.state);
    const roles = ['all', 'bass', 'lead', 'pad', 'keys', 'drums', 'poly_fm'];
    const activeRole = this._libraryRole ?? 'all';

    panel.innerHTML = `
      <div class="slp-header">
        <span class="slp-title">INSTRUMENT LIBRARY</span>
        <button class="slp-close">✕</button>
      </div>
      <div class="slp-role-tabs">
        ${roles.map(r => `<button class="slp-role-tab ${activeRole === r ? 'slpr-active' : ''}" data-role="${r}">${r.toUpperCase()}</button>`).join('')}
      </div>
      <div class="slp-list">
        ${allPatches.length === 0
          ? '<div class="slp-empty">No custom patches yet.<br>Create one via the Wizard!</div>'
          : allPatches
              .filter(d => activeRole === 'all' || d.role === activeRole)
              .map(d => `
                <div class="slp-item" data-id="${d.id}">
                  <span class="slp-item-name">${d.name}</span>
                  <span class="slp-item-role">${d.role ?? ''}</span>
                  <div class="slp-item-btns">
                    <button class="slp-load-btn" data-id="${d.id}">LOAD</button>
                    <button class="slp-del-btn"  data-id="${d.id}">✕</button>
                  </div>
                </div>`)
              .join('')
        }
      </div>`;

    panel.querySelector('.slp-close').addEventListener('click', () => {
      panel.classList.remove('slp-open');
    });
    panel.querySelectorAll('.slp-role-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        this._libraryRole = btn.dataset.role;
        this._renderLibraryPanel();
      });
    });
    panel.querySelectorAll('.slp-load-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        this.plug(this._libraryTargetSlot, btn.dataset.id);
        panel.classList.remove('slp-open');
      });
    });
    panel.querySelectorAll('.slp-del-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        if (confirm('Remove this patch from the library?')) {
          registry.unregister(btn.dataset.id);
          this._renderLibraryPanel();
        }
      });
    });
  }

  _buildUI() {
    // Ensure library panel exists in the DOM (injected once)
    if (!document.getElementById('synth-library-panel')) {
      const panel = document.createElement('div');
      panel.id = 'synth-library-panel';
      panel.className = 'synth-library-panel';
      document.getElementById('screen-synth-lab')?.appendChild(panel)
        ?? document.body.appendChild(panel);
    }
  }

  _pickAndLoadFile(slotIndex) {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = '.json';
    inp.onchange = e => {
      if (e.target.files[0]) this.loadPatchFile(slotIndex, e.target.files[0]);
    };
    inp.click();
  }
}

// ── Shared panel helpers ──────────────────────────────────────────────────────

function _renderEffectPanels(effects, rackEl, panels, bridge, voice) {
  const COLORS = {
    reverb: '#457b9d', delay: '#1d3557', distortion: '#e63946',
    chorus: '#2d6a4f', phaser: '#7b2d8b', waveshaper: '#b5451b', bitcrusher: '#5c3d2e',
  };
  effects.forEach((fx, idx) => {
    let knobs = [];
    if (fx.type === 'reverb') {
      knobs = [
        { label: 'SIZE', path: `modules.effects.${idx}.size`, min: 0, max: 1, onAudio: x => voice?._effects[idx]?.setParam('size', x) },
        { label: 'WET',  path: `modules.effects.${idx}.wet`,  min: 0, max: 1, onAudio: x => voice?._effects[idx]?.setParam('wet',  x) },
      ];
    } else if (fx.type === 'delay') {
      knobs = [
        { label: 'TIME',     path: `modules.effects.${idx}.time`,     min: 0.01, max: 2, scale: 'log', onAudio: x => voice?._effects[idx]?.setParam('time',     x) },
        { label: 'FEEDBACK', path: `modules.effects.${idx}.feedback`, min: 0, max: 0.95,               onAudio: x => voice?._effects[idx]?.setParam('feedback', x) },
        { label: 'WET',      path: `modules.effects.${idx}.wet`,      min: 0, max: 1,                  onAudio: x => voice?._effects[idx]?.setParam('wet',      x) },
      ];
    } else if (fx.type === 'distortion') {
      knobs = [
        { label: 'DRIVE', path: `modules.effects.${idx}.drive`, min: 0, max: 1,                                              onAudio: x => voice?._effects[idx]?.setParam('drive', x) },
        { label: 'TONE',  path: `modules.effects.${idx}.tone`,  min: 100, max: 8000, decimals: 0, unit: 'Hz', scale: 'log', onAudio: x => voice?._effects[idx]?.setParam('tone',  x) },
      ];
    } else if (fx.type === 'chorus' || fx.type === 'phaser') {
      knobs = [
        { label: 'RATE',  path: `modules.effects.${idx}.rate`,  min: 0.1, max: 8, scale: 'log', decimals: 2, unit: 'Hz', onAudio: x => voice?._effects[idx]?.setParam('rate',  x) },
        { label: 'DEPTH', path: `modules.effects.${idx}.depth`, min: 0, max: 1,                                           onAudio: x => voice?._effects[idx]?.setParam('depth', x) },
        { label: 'WET',   path: `modules.effects.${idx}.wet`,   min: 0, max: 1,                                           onAudio: x => voice?._effects[idx]?.setParam('wet',   x) },
      ];
    } else if (fx.type === 'waveshaper') {
      knobs = [
        { label: 'DRIVE', path: `modules.effects.${idx}.drive`, min: 0, max: 1, onAudio: x => voice?._effects[idx]?.setParam('drive', x) },
      ];
    } else if (fx.type === 'bitcrusher') {
      knobs = [
        { label: 'BITS', path: `modules.effects.${idx}.bits`, min: 1, max: 16, step: 1, decimals: 0, onAudio: x => voice?._effects[idx]?.setParam('bits', x) },
        { label: 'WET',  path: `modules.effects.${idx}.wet`,  min: 0, max: 1,                         onAudio: x => voice?._effects[idx]?.setParam('wet',  x) },
      ];
    }
    const panel = new ModulePanel({
      title: fx.type.toUpperCase(),
      color: COLORS[fx.type] || '#555',
      bridge, knobs,
    });
    rackEl.appendChild(panel.render());
    panels.push(panel);
  });
}

// ── Module-level helpers ──────────────────────────────────────────────────────

/**
 * Convert a legacy track-type number to the sequencer type key string.
 * e.g. 2 → 'bass', 1 → 'buchla', 6 → 'pads', 3 → 'rhodes'
 */
function _legacyTToType(t) {
  switch (t) {
    case 2:  return 'bass';
    case 1:  return 'buchla';
    case 6:  return 'pads';
    case 3:  return 'rhodes';
    case 10: return 'drum';
    default: return null;
  }
}

/**
 * Derive a role string for the registry from the patch state + legacy track type.
 */
function _patchStateToRole(patchState, legacyT) {
  if (patchState?.role) return patchState.role;
  switch (legacyT) {
    case 2:  return 'bass';
    case 1:  return 'poly_fm';
    case 6:  return 'pad';
    case 3:  return 'keys';
    default: return 'lead';
  }
}

// ── Graph-panel helpers ──────────────────────────────────────────────────────

/** Accent colors per graph node type (matches the Rust NodeType enum names). */
const GRAPH_NODE_COLORS = {
  oscillator:  '#ff006e',
  envelope:    '#e9c46a',
  tpt_ladder:  '#2a9d8f',
  moog_ladder: '#1b7a6e',
  biquad:      '#3d9d8f',
  filter:      '#2a9d8f',
  noise:       '#adb5bd',
  delay:       '#1d3557',
  reverb:      '#457b9d',
  chorus:      '#2d6a4f',
  wavefolder:  '#b5451b',
  multiply:    '#7b2d8b',
  gain:        '#f4a261',
  mixer:       '#6c757d',
  output:      '#264653',
};

/** Infer the node type from its param names for coloring & special controls. */
function _guessNodeType(params) {
  const names = new Set(params.map(p => p.param));
  if (names.has('waveform') || names.has('fm_depth'))   return 'oscillator';
  if (names.has('attack') && names.has('sustain'))      return 'envelope';
  if (names.has('cutoff') && names.has('drive'))        return 'tpt_ladder'; // both tpt & moog
  if (names.has('cutoff'))                              return 'tpt_ladder';
  if (names.has('freq') && names.has('bandwidth'))      return 'biquad';
  if (names.has('room_size'))                           return 'reverb';
  if (names.has('feedback') && names.has('time'))       return 'delay';
  if (names.has('rate') && names.has('depth'))          return 'chorus';
  if (names.has('amount') && params.length === 1)       return 'wavefolder';
  if (params.length === 0)                              return 'multiply';
  if (params.length === 1 && params[0].param === 'gain') return 'output';
  if (params.length === 1 && params[0].param === 'level') return 'gain';
  return 'mixer';
}

/** Smart step for a graph parameter. */
function _graphParamStep(p) {
  if (p.param === 'waveform' || p.param === 'octave' || p.param === 'mode') return 1;
  return undefined; // let Knob auto-determine
}

/** Smart decimal count for a graph parameter. */
function _graphParamDecimals(p) {
  if (p.param === 'waveform' || p.param === 'octave' || p.param === 'mode') return 0;
  if (p.param === 'cutoff' || p.param === 'freq' || p.param === 'bandwidth') return 0;
  if (p.param === 'detune') return 1;
  if (p.param === 'rate') return 2;
  return 2;
}

/** Unit suffix for a graph parameter. */
function _graphParamUnit(p) {
  if (p.param === 'cutoff' || p.param === 'freq' || p.param === 'bandwidth') return 'Hz';
  if (p.param === 'detune') return 'c';
  if (p.param === 'attack' || p.param === 'decay' || p.param === 'release' || p.param === 'time') return 's';
  if (p.param === 'fm_depth') return 'Hz';
  if (p.param === 'rate') return 'Hz';
  return '';
}

/** Scale hint for a graph parameter. */
function _graphParamScale(p) {
  if (p.param === 'cutoff' || p.param === 'freq' || p.param === 'fm_depth' || p.param === 'bandwidth') return 'log';
  if (p.param === 'attack' || p.param === 'decay' || p.param === 'release' || p.param === 'time') return 'log';
  if (p.param === 'rate') return 'log';
  return 'linear';
}

function _makeSelect(label, options, current, onChange) {
  const wrap = document.createElement('div');
  wrap.className = 'select-wrap';
  const lbl = document.createElement('label');
  lbl.className = 'select-label';
  lbl.textContent = label;
  const sel = document.createElement('select');
  sel.className = 'module-select';
  options.forEach(o => {
    const opt = document.createElement('option');
    opt.value = o; opt.textContent = o.charAt(0).toUpperCase() + o.slice(1);
    if (o === current) opt.selected = true;
    sel.appendChild(opt);
  });
  sel.addEventListener('change', () => onChange(sel.value));
  wrap.appendChild(lbl);
  wrap.appendChild(sel);
  return wrap;
}

function _makeToggle(label, current, onChange) {
  const wrap = document.createElement('div');
  wrap.className = 'toggle-wrap';
  const lbl = document.createElement('span');
  lbl.className = 'toggle-label';
  lbl.textContent = label;
  const btn = document.createElement('button');
  btn.className = 'toggle-btn' + (current ? ' active' : '');
  btn.textContent = current ? 'ON' : 'OFF';
  btn.addEventListener('click', () => {
    const v = btn.classList.toggle('active');
    btn.textContent = v ? 'ON' : 'OFF';
    onChange(v);
  });
  wrap.appendChild(lbl);
  wrap.appendChild(btn);
  return wrap;
}
