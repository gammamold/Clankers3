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

    this._restoreAssignments();
  }

  /** Inverse map: legacy track type → slot index */
  get _legacyTToSlot() {
    const out = {};
    for (const [slot, t] of Object.entries(this._slotLegacyT)) out[t] = Number(slot);
    return out;
  }

  // ── Adapter helpers ──────────────────────────────────────────────────────────

  /** Build a new WebAudioInstrumentAdapter for a slot and wire it to slot.gain. */
  _loadAdapter(slot, patchState) {
    this._unloadAdapter(slot);
    if (!this._ctx) return;
    const id = `slot:${slot.index}`;
    slot.adapter = new WebAudioInstrumentAdapter(this._ctx, patchState, id);
    slot.adapter.connect(slot.gain);
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
    if (desc.type !== 'webaudio' || !desc.state) {
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
        type:    'webaudio',
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
    slot.panels = this._renderPanels(slot, rack);

    // XY pad area
    const xyArea = document.createElement('div');
    xyArea.className = 'sle-xy-area';
    xyArea.style.cssText = 'display:none;padding:.6rem 1rem;';
    const synthXY = new XYPad({
      accentColor: '#2a9d8f',
      profiles: [
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
      ],
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
      // Route to whichever slot owns the target legacy track type (or default to this slot)
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
