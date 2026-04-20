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
    this._loopBeatsOverride = 0;   // set by setLoopBeats; survives seq.load() hot-reloads
    this._startTime = 0;
    this._nextBeat = 0;
    this._stepIdx = 0;

    // Per-instrument mute/solo/volume
    this._mute    = { drum: false, bass: false, buchla: false, pads: false, rhodes: false, voder: false, synth0: false, synth1: false, synth2: false, synth3: false, synth4: false };
    this._solo    = { drum: false, bass: false, buchla: false, pads: false, rhodes: false, voder: false, synth0: false, synth1: false, synth2: false, synth3: false, synth4: false };
    this._volumes = { drum: 0.9,   bass: 1.0,   buchla: 0.8,   pads: 1.0,   rhodes: 1.0,   voder: 0.4,   synth0: 1.0,   synth1: 1.0,   synth2: 1.0,   synth3: 1.0,   synth4: 1.0 };

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

    // ── MIDI Recording ─────────────────────────────────────────────────────
    // When true + sequencer playing, MIDI-input notes dispatched through
    // `recordNote()` are quantized to 16ths and merged into this.sheet.
    this.recordEnabled = false;
    this.onRecord = null;

    // Build the persistent audio graph immediately so live (MIDI-input, etc.)
    // triggers produce audible output even when the scheduler isn't running.
    this._ensureGraph();
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  load(sheet) {
    this.sheet = sheet;
    this._lastSheet = sheet;
    this._bpm = sheet.bpm ?? 120;
    this.swing = sheet.swing ?? this.swing ?? 0;
    this._compile(sheet);
  }

  /**
   * Lazily build the persistent audio graph: master gain, per-instrument gains,
   * voder LPF. Adapters stay connected across start/stop so MIDI-input
   * triggers (and any other live preview path) remain audible when the
   * sequencer is idle.
   */
  _ensureGraph() {
    if (this._masterGain) return;

    this._masterGain = this.ctx.createGain();
    this._masterGain.gain.value = 0.22;
    this._masterGain.connect(this.ctx.destination);

    this._instrGains = {};
    for (const type of ['drum', 'bass', 'buchla', 'pads', 'rhodes', 'voder']) {
      const g = this.ctx.createGain();
      if (type === 'voder') {
        this._voderLpf = this.ctx.createBiquadFilter();
        this._voderLpf.type = 'lowpass';
        this._voderLpf.frequency.value = this._voderLpfHz ?? 6000;
        this._voderLpf.Q.value = 0.5;
        g.connect(this._voderLpf);
        this._voderLpf.connect(this._masterGain);
      } else {
        g.connect(this._masterGain);
      }
      this._instrGains[type] = g;
      this._adapters[type]?.connect(g);
    }

    this._updateGains();
  }

  start() {
    if (!this.sheet) throw new Error('No sheet loaded');
    if (this._timer) return;

    this._ensureGraph();
    // synthLab is assigned after construct — (re)connect each start so slots get routed.
    this.synthLab?.connectToMaster(this._masterGain);

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

    // Silence all adapters — clears queued notes but keeps the audio graph wired
    // so live MIDI-input triggers stay audible when the sequencer is idle.
    for (const adapter of Object.values(this._adapters)) {
      adapter?.stop();
    }
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

  setLoopBeats(n) {
    const newBeats = n > 0 ? n : this._totalBeats ?? this._loopBeats;
    this._loopBeatsOverride = n > 0 ? n : 0;
    this._loopBeats = newBeats;
    // Immediately reposition playback into the new loop boundary
    if (this._timer && this._startTime && this._steps.length) {
      const elapsed = this.ctx.currentTime - this._startTime;
      const currentBeat = Math.max(0, elapsed * (this._bpm / 60));
      const loopIter = Math.floor(currentBeat / newBeats);
      this._nextBeat = loopIter * newBeats;
      const beatInLoop = currentBeat - this._nextBeat;
      const idx = this._steps.findIndex(s => s.beatTime >= beatInLoop && s.beatTime < newBeats);
      this._stepIdx = idx === -1 ? this._steps.length : idx;
    }
  }

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

  /** Set voder channel LPF cutoff in Hz (applied post-instrGain, pre-master). */
  setVoderLpf(hz) {
    this._voderLpfHz = hz;
    if (this._voderLpf) {
      this._voderLpf.frequency.setTargetAtTime(hz, this.ctx.currentTime, 0.02);
    }
  }

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

  // ── MIDI Recording ─────────────────────────────────────────────────────────

  /**
   * Record a note-on event into the current sheet at the quantized current
   * playback position (16th-note grid, overdub semantics). Requires the
   * sequencer to be playing and `recordEnabled` to be true.
   *
   * Fires `onRecord(sheet)` after mutation so the host can persist the sheet
   * back into its pattern bank / textarea.
   *
   * @param {'drum'|'bass'|'buchla'|'pads'|'rhodes'|'voder'} type
   * @param {{midiNote?:number, voiceId?:number, velocity:number, ccJson?:string, durBeats?:number}} ev
   * @returns {boolean} true if the note was recorded
   */
  recordNote(type, ev) {
    if (!this.recordEnabled || !this._timer || !this.sheet) return false;
    const t = TYPE_TO_T[type];
    if (t == null) return false;

    const elapsed = this.ctx.currentTime - this._startTime;
    const absBeat = Math.max(0, elapsed * (this._bpm / 60));
    const loopN = Math.floor(absBeat / this._loopBeats);
    const beatInLoop = absBeat - loopN * this._loopBeats;
    let qBeat = Math.round(beatInLoop * 4) / 4;              // snap to 16ths
    if (qBeat >= this._loopBeats - 1e-6) qBeat = 0;          // wrap end → start

    const note = type === 'drum' ? DRUM_VOICE_TO_NOTE[ev.voiceId ?? 0] : ev.midiNote;
    if (note == null) return false;

    _insertNote(this.sheet, qBeat, this._loopBeats, {
      t, note,
      velocity: Math.round((ev.velocity ?? 0.8) * 127),
      ccJson: ev.ccJson,
      durBeats: ev.durBeats ?? 0.25,
    });

    // Recompile and re-anchor _stepIdx just past the current playhead so
    // already-passed events in this loop iteration don't re-fire.
    this._compile(this.sheet);
    const idx = this._steps.findIndex(s => s.beatTime > beatInLoop);
    this._stepIdx = idx === -1 ? this._steps.length : idx;

    this.onRecord?.(this.sheet);
    return true;
  }

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
        const vel = Math.min(1.0, ((track.v ?? 100) / 127) * (track.a ? 1.3 : 1.0));
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
    this._totalBeats = beat;
    this._loopBeats = this._loopBeatsOverride > 0 ? this._loopBeatsOverride : (sheet.loopBeats ?? beat);
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
      if (ev.beatTime >= this._loopBeats) {
        this._nextBeat += this._loopBeats;
        this._stepIdx = 0;
        continue;
      }
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
      if (ev.voiceId === 0) this.onTrigger?.(ev.type);  // glow only on kick
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
    this.onTrigger?.(ev.type);
  }
}

// ── MIDI-record sheet helpers ─────────────────────────────────────────────────

// Instrument-type → sheet track id (`t:` value).
const TYPE_TO_T = { buchla: 1, bass: 2, rhodes: 3, voder: 5, pads: 6, drum: 10 };

/**
 * Merge a recorded note into an existing step's tracks (overdub): appends to
 * an existing track of the same type if present, otherwise adds a new track.
 */
function _mergeTrackNote(step, { t, note, velocity, ccJson, durBeats }) {
  step.tracks ??= [];
  let tr = step.tracks.find(x => x.t === t);
  if (!tr) {
    tr = { t, n: [], v: velocity };
    if (durBeats != null && t !== 10) tr.dur = durBeats;
    if (ccJson) { try { const cc = JSON.parse(ccJson); if (cc && Object.keys(cc).length) tr.cc = cc; } catch (_) {} }
    step.tracks.push(tr);
  }
  if (!tr.n.includes(note)) tr.n.push(note);
}

/**
 * Insert a note at `targetBeat` within the sheet's step list. If the beat
 * already coincides with a step boundary, overdub into that step; otherwise
 * split the containing step in two. Never extends past `loopBeats`.
 */
function _insertNote(sheet, targetBeat, loopBeats, noteData) {
  const steps = sheet.steps ?? (sheet.steps = []);
  const EPS = 1e-4;
  let beat = 0;

  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    const d = s.d ?? 0.5;
    const endBeat = beat + d;

    if (Math.abs(targetBeat - beat) < EPS) {
      _mergeTrackNote(s, noteData);
      return;
    }
    if (targetBeat < endBeat - EPS) {
      const first  = Object.assign({}, s, { d: targetBeat - beat });
      const second = { d: endBeat - targetBeat, tracks: (s.tracks ?? []).map(t => Object.assign({}, t, { n: [...(t.n ?? [])] })) };
      // Keep the existing tracks on the *first* (pre-split) half only; second half is empty until we add the new note.
      second.tracks = [];
      _mergeTrackNote(second, noteData);
      steps.splice(i, 1, first, second);
      return;
    }
    beat = endBeat;
  }

  // Past the last step but still within loopBeats: pad a rest, then insert.
  if (targetBeat < loopBeats - EPS) {
    const gap = targetBeat - beat;
    if (gap > EPS) steps.push({ d: gap, tracks: [] });
    const rest = Math.max(0.25, loopBeats - targetBeat);
    const newStep = { d: rest, tracks: [] };
    _mergeTrackNote(newStep, noteData);
    steps.push(newStep);
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
