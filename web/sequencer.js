/**
 * ClankerBoy JSON Step Sequencer — Web Audio lookahead scheduler
 *
 * Real-time streaming architecture: all DSP runs inside AudioWorklets or
 * WebAudio voice pools.  The tick loop sends timestamped trigger messages
 * through InstrumentAdapter instances — a single unified dispatch path that
 * works for both WASM worklets and Web Audio synthesizers.
 *
 * Param changes take effect within one lookahead window (~100ms) for drums
 * and within one audio block (~3ms) for all pitched instruments.
 *
 * Supported tracks:
 *   t:10  AntigravityDrums  (WasmInstrumentAdapter → drums-worklet)
 *   t:2   Pro-One Bass      (WasmInstrumentAdapter → bass-worklet)
 *   t:1   Poly FM Bass      (WasmInstrumentAdapter → buchla-worklet)
 *   t:6   HybridSynth Pads  (WasmInstrumentAdapter → pads-worklet)
 *   t:3   Rhodes FM piano   (WasmInstrumentAdapter → rhodes-worklet)
 *   t:5   Voder             (WasmInstrumentAdapter → voder-worklet)
 *   t:7   Synth Lab slot 0  (WebAudioInstrumentAdapter — set by SynthLab)
 *   t:8   Synth Lab slot 1
 *   t:9   Synth Lab slot 2
 *   t:11  Synth Lab slot 3
 *   t:12  Synth Lab slot 4  (WebAudioInstrumentAdapter — set by SynthLab)
 *
 * Usage:
 *   const seq = new Sequencer(audioCtx, { drums, bass, buchla, pads, rhodes });
 *   seq.synthLab = synthLabInstance;   // wires slot mute/volume + connectToMaster
 *   seq.load(sheet);
 *   seq.start();
 *   seq.stop();
 *
 * Swapping an instrument adapter at runtime:
 *   seq.setAdapter('bass', new WebAudioInstrumentAdapter(ctx, patch, 'bass'));
 *   seq.setAdapter('bass', seq.getDefaultAdapter('bass')); // restore WASM
 *
 * Live param control (WASM instruments):
 *   seq.getAdapter('bass').setParams(ccJson);
 */

import { WasmInstrumentAdapter } from './synth/core/InstrumentAdapter.js';

const LOOKAHEAD_MS = 100;
const INTERVAL_MS = 25;

/**
 * Evaluate all automation curves for a given track at a beat position.
 */
function _evalAutomation(curveMap, beat) {
  if (!curveMap) return {};
  const out = {};
  for (const [cc, pts] of Object.entries(curveMap)) {
    if (!pts.length) continue;
    if (beat <= pts[0][0]) { out[cc] = pts[0][1]; continue; }
    if (beat >= pts[pts.length - 1][0]) { out[cc] = pts[pts.length - 1][1]; continue; }
    for (let i = 1; i < pts.length; i++) {
      if (beat <= pts[i][0]) {
        const [b0, v0] = pts[i - 1];
        const [b1, v1] = pts[i];
        const t = (beat - b0) / (b1 - b0);
        out[cc] = Math.round(v0 + t * (v1 - v0));
        break;
      }
    }
  }
  return out;
}

export class Sequencer {
  constructor(ctx, nodes = {}) {
    this.ctx = ctx;

    // ── Instrument adapters (unified dispatch) ─────────────────────────────
    // Default WASM adapters built from the provided AudioWorkletNodes.
    // Synth Lab slots (synth0–4) start as null — set by SynthLab via setAdapter().
    this._defaultAdapters = {
      drum:   nodes.drums  ? new WasmInstrumentAdapter(nodes.drums,  'drum',   { isDrum: true }) : null,
      bass:   nodes.bass   ? new WasmInstrumentAdapter(nodes.bass,   'bass')                     : null,
      buchla: nodes.buchla ? new WasmInstrumentAdapter(nodes.buchla, 'buchla')                   : null,
      pads:   nodes.pads   ? new WasmInstrumentAdapter(nodes.pads,   'pads')                     : null,
      rhodes: nodes.rhodes ? new WasmInstrumentAdapter(nodes.rhodes, 'rhodes')                   : null,
      voder:  nodes.voder  ? new WasmInstrumentAdapter(nodes.voder,  'voder')                    : null,
    };
    this._adapters = {
      ...this._defaultAdapters,
      synth0: null, synth1: null, synth2: null, synth3: null, synth4: null,
    };

    // Keep raw node refs for backward compat (render.js, external code)
    this._nodes = {
      drum: nodes.drums ?? null,
      bass: nodes.bass ?? null,
      buchla: nodes.buchla ?? null,
      pads: nodes.pads ?? null,
      rhodes: nodes.rhodes ?? null,
      voder: nodes.voder ?? null,
    };

    this.sheet = null;
    this._timer = null;

    this._bpm = 120;
    this._steps = [];   // compiled event list
    this._loopBeats = 0;
    this._startTime = 0;
    this._nextBeat = 0;
    this._stepIdx = 0;

    // Per-instrument mute/solo/volume
    this._mute    = { drum: false, bass: false, buchla: false, pads: false, rhodes: false, voder: false, synth0: false, synth1: false, synth2: false, synth3: false, synth4: false };
    this._solo    = { drum: false, bass: false, buchla: false, pads: false, rhodes: false, voder: false, synth0: false, synth1: false, synth2: false, synth3: false, synth4: false };
    this._volumes = { drum: 1.0,   bass: 1.0,   buchla: 1.0,   pads: 1.0,   rhodes: 1.0,   voder: 1.0,   synth0: 1.0,   synth1: 1.0,   synth2: 1.0,   synth3: 1.0,   synth4: 1.0 };

    /**
     * SynthLab instance — set externally.
     * Used for: connectToMaster(), setMute/setVolume on synth slots.
     * Scheduling now goes through _adapters, not synthLab.scheduleNote().
     * @type {import('./synth-lab.js').SynthLab|null}
     */
    this.synthLab = null;

    /**
     * MidiOutput instance — set externally to enable MIDI output.
     * @type {import('./midi-output.js').MidiOutput|null}
     */
    this.midiOut = null;

    /**
     * ModularSync instance — set externally to enable CV/Gate output.
     * @type {import('./modular-sync.js').ModularSync|null}
     */
    this.modularSync = null;

    this.loop  = true;
    this.swing = 0;   // 0.0–1.0, applied dynamically to upbeat 16ths
    this.onEnd = null;

    this._stepBeats = [];  // beat positions for the step visualiser

    // Live UI CC getters — merged with per-note CCs before dispatch to WASM adapters.
    // seq.liveCC = { bass: () => ({71:32,...}), buchla: () => ({74:56,...}) }
    this.liveCC = {};

    // Semitone offsets applied to MIDI notes before dispatch (WASM only).
    // bass:   +48 matches the Pro-One worklet's internal note→freq mapping.
    // buchla: 0 by default; override as needed.
    this.bassOctaveOffset   = 48;
    this.buchlaOctaveOffset = 0;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  load(sheet) {
    this.sheet = sheet;
    this._lastSheet = sheet;
    this._bpm = sheet.bpm ?? 120;
    this.swing = sheet.swing ?? this.swing ?? 0;
    this._compile(sheet);
  }

  start() {
    if (!this.sheet) throw new Error('No sheet loaded');
    if (this._timer) return;

    // Fresh master gain
    if (this._masterGain) this._masterGain.disconnect();
    this._masterGain = this.ctx.createGain();
    this._masterGain.gain.value = 0.22;
    this._masterGain.connect(this.ctx.destination);

    // Per-instrument gain nodes — reconnect via adapters each start()
    if (this._instrGains) {
      for (const g of Object.values(this._instrGains)) {
        try { g.disconnect(); } catch (_) {}
      }
    }
    this._instrGains = {};
    for (const type of ['drum', 'bass', 'buchla', 'pads', 'rhodes', 'voder']) {
      const g = this.ctx.createGain();
      g.connect(this._masterGain);
      this._instrGains[type] = g;
      this._adapters[type]?.connect(g);
    }

    // Route synth Lab slots through its own gain management
    this.synthLab?.connectToMaster(this._masterGain);

    this._updateGains();

    this._startTime = this.ctx.currentTime + 0.05;
    this._nextBeat  = 0;
    this._stepIdx   = 0;
    this._lastClockBeat = undefined;
    this._timer = setInterval(() => this._tick(), INTERVAL_MS);
    this._tick();
    this.midiOut?.startClock(this._bpm);
  }

  stop() {
    this.midiOut?.stopClock();
    if (this._timer) { clearInterval(this._timer); this._timer = null; }

    // Silence all adapters
    for (const adapter of Object.values(this._adapters)) {
      adapter?.stop();
    }

    if (this._masterGain) this._masterGain.disconnect();
  }

  get isPlaying() { return this._timer !== null; }

  toggleMute(type) {
    this._mute[type] = !this._mute[type];
    if (this._mute[type]) this._solo[type] = false;
    this._updateGains();
    return this._mute[type];
  }

  toggleSolo(type) {
    this._solo[type] = !this._solo[type];
    if (this._solo[type]) this._mute[type] = false;
    this._updateGains();
    return this._solo[type];
  }

  getMuteState() { return { ...this._mute }; }
  getSoloState() { return { ...this._solo }; }

  getCurrentBeat() {
    if (!this._timer || !this._startTime) return -1;
    const elapsed = this.ctx.currentTime - this._startTime;
    const beat = elapsed * (this._bpm / 60);
    return ((beat % this._loopBeats) + this._loopBeats) % this._loopBeats;
  }

  getCurrentStepIndex() {
    const beat = this.getCurrentBeat();
    if (beat < 0) return -1;
    const beats = this._stepBeats;
    if (!beats.length) return -1;
    let idx = beats.length - 1;
    for (let i = 0; i < beats.length - 1; i++) {
      if (beat < beats[i + 1]) { idx = i; break; }
    }
    return idx;
  }

  get stepCount() { return this._stepBeats.length; }
  get loopBeats() { return this._loopBeats; }

  setVolume(type, value) {
    this._volumes[type] = Math.max(0, Math.min(1, value));
    this._updateGains();
  }
  getVolumes() { return { ...this._volumes }; }

  /**
   * Swap an instrument adapter for the given track type.
   *
   * Called by SynthLab when a custom patch is loaded/cleared:
   *   seq.setAdapter('bass',   webAudioAdapter);  // patch replaces WASM bass
   *   seq.setAdapter('bass',   null);              // restore default WASM
   *   seq.setAdapter('synth0', webAudioAdapter);  // slot 0 loaded
   *   seq.setAdapter('synth0', null);              // slot 0 cleared
   *
   * @param {string} type - one of the 10 instrument type keys
   * @param {InstrumentAdapter|null} adapter
   */
  setAdapter(type, adapter) {
    const old = this._adapters[type];
    if (old && old !== adapter) old.disconnect();

    this._adapters[type] = adapter ?? this._defaultAdapters[type] ?? null;

    // If currently playing, wire the new adapter to its existing gain node
    const gainNode = this._instrGains?.[type];
    if (gainNode && this._adapters[type]) {
      this._adapters[type].connect(gainNode);
    }
  }

  /**
   * Return the currently active adapter for a type, or null.
   * @param {string} type
   * @returns {InstrumentAdapter|null}
   */
  getAdapter(type) { return this._adapters[type] ?? null; }

  /**
   * Return the default (WASM) adapter for a type, or null.
   * @param {string} type
   * @returns {InstrumentAdapter|null}
   */
  getDefaultAdapter(type) { return this._defaultAdapters[type] ?? null; }

  // ── Internal ───────────────────────────────────────────────────────────────

  _isAudible(type) {
    const anySolo = Object.values(this._solo).some(v => v);
    if (anySolo) return this._solo[type];
    return !this._mute[type];
  }

  isAudible(type) { return this._isAudible(type); }

  _updateGains() {
    for (const type of ['drum', 'bass', 'buchla', 'pads', 'rhodes', 'voder']) {
      if (this._instrGains?.[type]) {
        this._instrGains[type].gain.value = this._isAudible(type) ? this._volumes[type] : 0.0;
      }
    }
    // Propagate mute/volume to SynthLab slots (which manage their own gain nodes)
    if (this.synthLab) {
      for (let i = 0; i < 5; i++) {
        const key = `synth${i}`;
        this.synthLab.setMute(i, !this._isAudible(key));
        this.synthLab.setVolume(i, this._volumes[key]);
      }
    }
  }

  _compile(sheet) {
    const raw = [];
    let beat = 0;

    this._stepBeats = [];
    for (const step of sheet.steps ?? []) {
      this._stepBeats.push(beat);
      beat += step.d ?? 0.5;
    }
    beat = 0;

    // Build automation lookup: { t -> { cc -> sortedControlPoints[] } }
    const autoMap = {};
    for (const a of sheet.automation ?? []) {
      if (!autoMap[a.t]) autoMap[a.t] = {};
      autoMap[a.t][a.cc] = (a.beats ?? []).slice().sort((x, y) => x[0] - y[0]);
    }

    for (const step of sheet.steps ?? []) {
      const d = step.d ?? 0.5;

      for (const track of step.tracks ?? []) {
        const notes = track.n ?? [];
        const vel = (track.v ?? 100) / 127;
        const cc = Object.assign({}, track.cc ?? {}, _evalAutomation(autoMap[track.t], beat));

        if (track.t === 10) {
          for (const note of notes) {
            const voiceId = drumNoteToVoice(note);
            raw.push({ beatTime: beat, type: 'drum', voiceId, velocity: vel });
          }
        }

        if (track.t === 2) {
          const durBeats = track.dur ?? d;
          for (const note of notes) {
            raw.push({
              beatTime: beat, type: 'bass', midiNote: note, velocity: vel,
              ccJson: JSON.stringify(cc), durBeats
            });
          }
        }

        if (track.t === 1) {
          const durBeats = track.dur ?? d;
          for (const note of notes) {
            raw.push({
              beatTime: beat, type: 'buchla', midiNote: note, velocity: vel,
              ccJson: JSON.stringify(cc), durBeats
            });
          }
        }

        if (track.t === 6) {
          const durBeats = track.dur ?? step.d ?? 0.5;
          for (const note of notes) {
            raw.push({
              beatTime: beat, type: 'pads', midiNote: note, velocity: vel,
              ccJson: JSON.stringify(cc), durBeats
            });
          }
        }

        if (track.t === 3) {
          const durBeats = track.dur ?? step.d ?? 0.5;
          for (const note of notes) {
            raw.push({
              beatTime: beat, type: 'rhodes', midiNote: note, velocity: vel,
              ccJson: JSON.stringify(cc), durBeats
            });
          }
        }

        if (track.t === 5) {
          const durBeats = track.dur ?? step.d ?? 0.5;
          // track.ph: optional phoneme index array, e.g. [8, 7, 2, 11]
          const phonemes = Array.isArray(track.ph) ? track.ph : null;
          for (const note of notes) {
            raw.push({
              beatTime: beat, type: 'voder', midiNote: note, velocity: vel,
              ccJson: JSON.stringify(cc), durBeats, phonemes
            });
          }
        }

        // Synth Lab slots (t:7 = slot 0, t:8 = slot 1, t:9 = slot 2, t:11 = slot 3, t:12 = slot 4)
        const SYNTH_T_SLOT = { 7: 0, 8: 1, 9: 2, 11: 3, 12: 4 };
        if (track.t in SYNTH_T_SLOT) {
          const slotIndex = SYNTH_T_SLOT[track.t];
          const durBeats = track.dur ?? step.d ?? 0.5;
          for (const note of notes) {
            raw.push({
              beatTime: beat, type: `synth${slotIndex}`, midiNote: note,
              velocity: vel, durBeats
            });
          }
        }
      }

      beat += d;
    }

    raw.sort((a, b) => a.beatTime - b.beatTime);
    this._steps = raw;
    this._loopBeats = sheet.loopBeats ?? beat;
    console.log(`[seq] compiled ${raw.length} events (${this._loopBeats} beats @ ${this._bpm} BPM) — streaming`);
  }

  _beatsToSeconds(beats) { return beats * (60 / this._bpm); }

  _tick() {
    if (!this._steps.length) return;
    const scheduleUntil = this.ctx.currentTime + LOOKAHEAD_MS / 1000;

    // Schedule CV clock pulses within the lookahead window
    if (this.modularSync?.clockEnabled) {
      const div = this.modularSync.clockDivision;
      const elapsed = scheduleUntil - this._startTime;
      const beatNow = elapsed * (this._bpm / 60);
      if (this._lastClockBeat === undefined) this._lastClockBeat = -div;
      const nextClockBeat = (Math.floor(this._lastClockBeat / div) + 1) * div;
      if (nextClockBeat <= beatNow) {
        const clockTime = this._startTime + this._beatsToSeconds(nextClockBeat);
        this.modularSync.sendClock(clockTime);
        this._lastClockBeat = nextClockBeat;
      }
    }

    while (true) {
      if (this._stepIdx >= this._steps.length) {
        if (!this.loop) {
          setTimeout(() => { this.stop(); this.onEnd?.(); }, 0);
          return;
        }
        this._nextBeat += this._loopBeats;
        this._stepIdx = 0;
      }

      const ev = this._steps[this._stepIdx];
      const loopN = Math.floor(this._nextBeat / this._loopBeats) || 0;
      const evBeat = loopN * this._loopBeats + ev.beatTime;

      // Calculate Swing directly in _tick so it can be changed live
      let swingOffsetBeats = 0;
      if (this.swing > 0) {
        // Is this an upbeat 16th note? (beat 0.25, 0.75, 1.25...)
        const beatInBar = ev.beatTime % 1.0;
        const isUpbeat = Math.abs((beatInBar % 0.5) - 0.25) < 0.01;
        if (isUpbeat) {
          // Push beat back by a percentage (e.g. max swing = 0.125 beats)
          swingOffsetBeats = this.swing * 0.125;
        }
      }

      const evTime = this._startTime + this._beatsToSeconds(evBeat + swingOffsetBeats);

      if (evTime > scheduleUntil) break;

      this._sendTrigger(ev, evTime);

      this._stepIdx++;
    }
  }

  _sendTrigger(ev, audioTime) {
    const adapter = this._adapters[ev.type];
    const audible = this._isAudible(ev.type);

    if (ev.type === 'drum') {
      // Map voiceId back to a representative MIDI note so WebAudio adapters
      // replacing drums receive a pitched note (kick=36, snare=38, etc.)
      const drumNote = DRUM_VOICE_TO_NOTE[ev.voiceId] ?? 36;
      if (audible && adapter) adapter.scheduleNote(drumNote, ev.velocity, audioTime, 100, { voiceId: ev.voiceId });
      this.midiOut?.scheduleNote('drum', ev.voiceId, ev.velocity, audioTime, this.ctx, 100);
      this.modularSync?.sendGate(ev.type, audioTime);
      return;
    }

    // All pitched instrument types (WASM and WebAudio) share this path
    if (!adapter && !this.midiOut && !this.modularSync) return;

    const holdMs = (ev.durBeats ?? 0) * (60 / this._bpm) * 1000;

    if (ev.type === 'bass' || ev.type === 'buchla') {
      // Merge live CC overrides (WASM instruments only — WebAudio ignores ccJson)
      const liveGetter = this.liveCC?.[ev.type];
      let ccJson = ev.ccJson ?? '{}';
      if (liveGetter) {
        const liveCC = liveGetter() ?? {};
        const noteCC = JSON.parse(ccJson);
        ccJson = JSON.stringify(Object.assign({}, noteCC, liveCC));
      }
      // Apply octave offset
      const offset = ev.type === 'bass' ? (this.bassOctaveOffset ?? 0) : (this.buchlaOctaveOffset ?? 0);
      const midi = Math.max(0, Math.min(127, ev.midiNote + offset));
      if (audible && adapter) adapter.scheduleNote(midi, ev.velocity, audioTime, holdMs, { ccJson });
      this.midiOut?.scheduleNote(ev.type, midi, ev.velocity, audioTime, this.ctx, holdMs);

    } else if (ev.type === 'pads' || ev.type === 'rhodes') {
      const liveGetter = this.liveCC?.[ev.type];
      let ccJson = ev.ccJson ?? '{}';
      if (liveGetter) {
        const liveCC = liveGetter() ?? {};
        const noteCC = JSON.parse(ccJson);
        ccJson = JSON.stringify(Object.assign({}, noteCC, liveCC));
      }
      if (audible && adapter) adapter.scheduleNote(ev.midiNote, ev.velocity, audioTime, holdMs, { ccJson });
      this.midiOut?.scheduleNote(ev.type, ev.midiNote, ev.velocity, audioTime, this.ctx, holdMs);

    } else if (ev.type === 'voder') {
      const liveGetter = this.liveCC?.voder;
      let ccJson = ev.ccJson ?? '{}';
      if (liveGetter) {
        const liveCC = liveGetter() ?? {};
        const noteCC = JSON.parse(ccJson);
        ccJson = JSON.stringify(Object.assign({}, noteCC, liveCC));
      }
      const sr          = this.ctx.sampleRate;
      const holdSamples = Math.round((holdMs / 1000) * sr);
      if (audible && adapter?.node?.port) {
        // Post trigger directly so we can include phonemes in the same message
        adapter.node.port.postMessage({
          type: 'trigger', audioTime,
          midiNote: ev.midiNote, velocity: ev.velocity,
          holdSamples, ccJson,
          ...(ev.phonemes ? { phonemes: ev.phonemes } : {}),
        });
      }
      this.midiOut?.scheduleNote('voder', ev.midiNote, ev.velocity, audioTime, this.ctx, holdMs);

    } else {
      // synth0–synth4: no CC merging, no octave offset
      if (audible && adapter) adapter.scheduleNote(ev.midiNote, ev.velocity, audioTime, holdMs);
      this.midiOut?.scheduleNote(ev.type, ev.midiNote, ev.velocity, audioTime, this.ctx, holdMs);
    }

    this.modularSync?.sendGate(ev.type, audioTime);
  }
}

// ── Drum note ↔ voice ID ─────────────────────────────────────────────────────

// Representative MIDI note per voice ID (used when a WebAudio adapter replaces drums)
const DRUM_VOICE_TO_NOTE = [36, 38, 42, 46, 41, 45, 49]; // kick, snare, hh-cl, hh-op, tom-l, tom-m, cymbal

function drumNoteToVoice(note) {
  if (note === 36) return 0; // KICK
  if (note === 38 || note === 40) return 1; // SNARE
  if ([42, 49, 50, 51, 52, 53].includes(note)) return 2; // HH CL
  if ([46, 54, 55, 56, 57].includes(note)) return 3; // HH OP
  if (note === 41 || note === 43) return 4; // TOM L
  if (note === 45 || note === 47) return 5; // TOM M/H
  if (note === 48 || note === 50) return 6; // CLAP/TOM-H/CYMBAL
  return 0;
}
