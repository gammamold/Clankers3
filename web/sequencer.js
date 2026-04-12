/**
 * ClankerBoy JSON Step Sequencer — Web Audio lookahead scheduler
 *
 * Real-time streaming architecture: all DSP runs inside AudioWorklets.
 * The tick loop sends timestamped trigger messages to worklet ports —
 * no AudioBuffers, no pre-rendering, no rerender() calls.
 *
 * Param changes take effect within one lookahead window (~100ms) for drums
 * and within one audio block (~3ms) for all pitched instruments.
 *
 * Supported tracks:
 *   t:10  AntigravityDrums  (drums-worklet)
 *   t:2   Pro-One Bass      (bass-worklet)
 *   t:1   Poly FM Bass      (buchla-worklet)
 *   t:6   HybridSynth Pads  (pads-worklet)
 *   t:3   Rhodes FM piano   (rhodes-worklet)
 *   t:7   Synth Lab slot 0  (SynthVoice / Web Audio)
 *   t:8   Synth Lab slot 1
 *   t:9   Synth Lab slot 2
 *   t:11  Synth Lab slot 3
 *   t:12  Synth Lab slot 4  (FM DRUMS — percussive FM patch)
 *
 * Usage:
 *   const seq = new Sequencer(audioCtx, { drums, bass, buchla, pads, rhodes });
 *   // each value is an AudioWorkletNode
 *   seq.synthLab = synthLabInstance; // optional: enables Synth Lab playback
 *   seq.load(sheet);
 *   seq.start();
 *   seq.stop();
 *
 * Live param control (no debounce needed):
 *   // Drums — read from drumParamOverride callback at schedule time
 *   seq.drumParamOverride = (voiceId) => ({ p0, p1, p2 });
 *
 *   // All others — send directly to worklet port:
 *   bassNode.port.postMessage({ type:'setParams', ccJson });
 */

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

    // AudioWorkletNode references (for audio graph wiring)
    this._nodes = {
      drum: nodes.drums ?? null,
      bass: nodes.bass ?? null,
      buchla: nodes.buchla ?? null,
      pads: nodes.pads ?? null,
      rhodes: nodes.rhodes ?? null,
    };

    // Worklet message ports (for trigger / setParams messages)
    this._ports = {
      drum: nodes.drums?.port ?? null,
      bass: nodes.bass?.port ?? null,
      buchla: nodes.buchla?.port ?? null,
      pads: nodes.pads?.port ?? null,
      rhodes: nodes.rhodes?.port ?? null,
    };

    this.sheet = null;
    this._timer = null;

    this._bpm = 120;
    this._steps = [];   // compiled event list (no audioBuffer)
    this._loopBeats = 0;
    this._startTime = 0;
    this._nextBeat = 0;
    this._stepIdx = 0;

    // Per-instrument mute/solo/volume
    this._mute = { drum: false, bass: false, buchla: false, pads: false, rhodes: false, synth0: false, synth1: false, synth2: false, synth3: false, synth4: false };
    this._solo = { drum: false, bass: false, buchla: false, pads: false, rhodes: false, synth0: false, synth1: false, synth2: false, synth3: false, synth4: false };
    this._volumes = { drum: 1.0, bass: 1.0, buchla: 1.0, pads: 1.0, rhodes: 1.0, synth0: 1.0, synth1: 1.0, synth2: 1.0, synth3: 1.0, synth4: 1.0 };

    /**
     * SynthLab instance — set externally to enable Synth Lab playback.
     * @type {import('./synth-lab.js').SynthLab|null}
     */
    this.synthLab = null;

    /**
     * MidiOutput instance — set externally to enable MIDI output from triggers.
     * @type {import('./midi-output.js').MidiOutput|null}
     */
    this.midiOut = null;

    /**
     * ModularSync instance — set externally to enable CV/Gate output.
     * @type {import('./modular-sync.js').ModularSync|null}
     */
    this.modularSync = null;

    /**
     * When a SynthLab slot is active, mirror old-track-type notes to it.
     * e.g. { 2: 0 } means t:2 (Bass FM) notes ALSO trigger synth slot 0.
     * Set by SynthLab.loadPatch() / clearSlot() via seq.setSynthOverride().
     */
    this.synthOverrides = {}; // { trackType: slotIndex }

    this.loop = true;
    this.swing = 0;   // 0.0 to 1.0. Applied dynamically in _tick() to upbeat 16ths.
    this.onEnd = null;

    this._stepBeats = [];  // beat positions for the step visualizer

    // Live UI CC getters — merged as base before per-note JSON CCs are applied.
    // Set externally: seq.liveCC = { bass: () => ({71:32,...}), buchla: () => ({74:56,...}) }
    this.liveCC = {};

    // Semitone offset applied to all bass MIDI notes from the sheet.
    // Matches trigger_render's +48 offset used by the offline renderer.
    this.bassOctaveOffset = 48;

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

    // Fresh master gain — disconnect old one
    if (this._masterGain) this._masterGain.disconnect();
    this._masterGain = this.ctx.createGain();
    this._masterGain.gain.value = 0.22;
    this._masterGain.connect(this.ctx.destination);

    // Per-instrument gain nodes — reconnect worklet nodes each start()
    if (this._instrGains) {
      for (const g of Object.values(this._instrGains)) {
        try { g.disconnect(); } catch (_) { }
      }
    }
    this._instrGains = {};
    for (const type of ['drum', 'bass', 'buchla', 'pads', 'rhodes']) {
      const node = this._nodes[type];
      if (node) { try { node.disconnect(); } catch (_) { } }
      const g = this.ctx.createGain();
      g.connect(this._masterGain);
      this._instrGains[type] = g;
      if (node) node.connect(g);
    }
    this._updateGains();

    this._startTime = this.ctx.currentTime + 0.05;
    this._nextBeat = 0;
    this._stepIdx = 0;
    this._lastClockBeat = undefined;
    this._timer = setInterval(() => this._tick(), INTERVAL_MS);
    this._tick();
    // Start MIDI clock if enabled
    this.midiOut?.startClock(this._bpm);
  }

  stop() {
    // Stop MIDI clock
    this.midiOut?.stopClock();
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    // Clear queued triggers and silence active envelopes in all worklets
    for (const port of Object.values(this._ports)) {
      if (port) {
        port.postMessage({ type: 'stop' });
        port.postMessage({ type: 'trigger', audioTime: 0, midiNote: 0, velocity: 0, holdSamples: 0, voiceId: 0, ccJson: '{}' });
      }
    }

    // Silence any active SynthLab instances
    if (this.synthLab) {
      for (let i = 0; i < 5; i++) {
        this.synthLab.scheduleNote(i, 0, 0, this.ctx.currentTime, 0); // Fast note off
      }
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
   * Register a SynthLab slot as the replacement for a legacy track type.
   * e.g. setSynthOverride(2, 0)  → t:2 (Bass FM) notes also play on synth slot 0.
   * Pass slotIndex=null to remove override. Reloads the current sheet to recompile.
   */
  setSynthOverride(trackType, slotIndex) {
    if (slotIndex === null || slotIndex === undefined) {
      delete this.synthOverrides[trackType];
    } else {
      this.synthOverrides[trackType] = slotIndex;
    }
    // Recompile if a sheet is loaded so new events are immediately scheduled
    if (this._steps.length) {
      const sheet = this._lastSheet;
      if (sheet) this.load(sheet);
    }
  }

  // ── Internal ───────────────────────────────────────────────────────────────

  _isAudible(type) {
    const anySolo = Object.values(this._solo).some(v => v);
    if (anySolo) return this._solo[type];
    return !this._mute[type];
  }

  isAudible(type) { return this._isAudible(type); }

  _updateGains() {
    for (const type of ['drum', 'bass', 'buchla', 'pads', 'rhodes']) {
      if (this._instrGains?.[type]) {
        this._instrGains[type].gain.value = this._isAudible(type) ? this._volumes[type] : 0.0;
      }
    }
    // Propagate mute/volume to SynthLab slots
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

        // Synth Lab slots (t:7 = slot 0, t:8 = slot 1, t:9 = slot 2, t:11 = slot 3, t:12 = slot 4 FM DRUMS)
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

        // SynthLab override — if a slot replaces a legacy track type, mirror notes to it
        if (track.t in this.synthOverrides) {
          const slotIndex = this.synthOverrides[track.t];
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
    // Synth Lab events are handled separately below (no worklet port)
    const SYNTH_TYPE_SLOT = { synth0: 0, synth1: 1, synth2: 2, synth3: 3, synth4: 4 };
    const audible = this._isAudible(ev.type);

    if (ev.type in SYNTH_TYPE_SLOT) {
      const holdMs = ev.durBeats * (60 / this._bpm) * 1000;
      if (audible && this.synthLab) {
        this.synthLab.scheduleNote(SYNTH_TYPE_SLOT[ev.type], ev.midiNote, ev.velocity, audioTime, holdMs);
      }
      this.midiOut?.scheduleNote(ev.type, ev.midiNote, ev.velocity, audioTime, this.ctx, holdMs);
      return;
    }

    const port = this._ports[ev.type];
    if (!port) return;

    if (ev.type === 'drum') {
      if (audible) port.postMessage({
        type: 'trigger', audioTime,
        voiceId: ev.voiceId, velocity: ev.velocity
      });
      this.midiOut?.scheduleNote('drum', ev.voiceId, ev.velocity, audioTime, this.ctx, 100);

    } else if (ev.type === 'bass') {
      const holdSamples = Math.round(ev.durBeats * (60 / this._bpm) * this.ctx.sampleRate);
      const liveCC = this.liveCC?.bass?.() ?? {};
      const noteCC = JSON.parse(ev.ccJson || '{}');
      const merged = Object.assign({}, noteCC, liveCC);
      const midi = Math.max(0, Math.min(127, ev.midiNote + (this.bassOctaveOffset ?? 0)));
      if (audible) port.postMessage({
        type: 'trigger', audioTime,
        midiNote: midi, velocity: ev.velocity,
        holdSamples, ccJson: JSON.stringify(merged)
      });
      this.midiOut?.scheduleNote('bass', midi, ev.velocity, audioTime, this.ctx, holdSamples / this.ctx.sampleRate * 1000);

    } else if (ev.type === 'buchla') {
      const holdSamples = Math.round(ev.durBeats * (60 / this._bpm) * this.ctx.sampleRate);
      const liveCC = this.liveCC?.buchla?.() ?? {};
      const noteCC = JSON.parse(ev.ccJson || '{}');
      const merged = Object.assign({}, noteCC, liveCC);
      const buchlaNote = Math.max(0, Math.min(127, ev.midiNote + (this.buchlaOctaveOffset ?? 0)));
      if (audible) port.postMessage({
        type: 'trigger', audioTime,
        midiNote: buchlaNote, velocity: ev.velocity,
        holdSamples, ccJson: JSON.stringify(merged)
      });
      this.midiOut?.scheduleNote('buchla', buchlaNote, ev.velocity, audioTime, this.ctx, holdSamples / this.ctx.sampleRate * 1000);

    } else if (ev.type === 'pads') {
      const holdSamples = Math.round(ev.durBeats * (60 / this._bpm) * this.ctx.sampleRate);
      const liveCC = this.liveCC?.pads?.() ?? {};
      const noteCC = JSON.parse(ev.ccJson || '{}');
      const merged = Object.assign({}, noteCC, liveCC);
      if (audible) port.postMessage({
        type: 'trigger', audioTime,
        midiNote: ev.midiNote, velocity: ev.velocity,
        holdSamples, ccJson: JSON.stringify(merged)
      });
      this.midiOut?.scheduleNote('pads', ev.midiNote, ev.velocity, audioTime, this.ctx, holdSamples / this.ctx.sampleRate * 1000);

    } else if (ev.type === 'rhodes') {
      const holdSamples = Math.round(ev.durBeats * (60 / this._bpm) * this.ctx.sampleRate);
      const liveCC = this.liveCC?.rhodes?.() ?? {};
      const noteCC = JSON.parse(ev.ccJson || '{}');
      const merged = Object.assign({}, noteCC, liveCC);
      if (audible) port.postMessage({
        type: 'trigger', audioTime,
        midiNote: ev.midiNote, velocity: ev.velocity,
        holdSamples, ccJson: JSON.stringify(merged)
      });
      this.midiOut?.scheduleNote('rhodes', ev.midiNote, ev.velocity, audioTime, this.ctx, holdSamples / this.ctx.sampleRate * 1000);
    }

    // CV/Gate trigger output
    this.modularSync?.sendGate(ev.type, audioTime);
  }
}

// ── Drum note → voice ID ──────────────────────────────────────────────────────

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
