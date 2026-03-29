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
 *   t:1   Buchla 259/292    (buchla-worklet)
 *   t:6   HybridSynth Pads  (pads-worklet)
 *   t:3   Rhodes FM piano   (rhodes-worklet)
 *
 * Usage:
 *   const seq = new Sequencer(audioCtx, { drums, bass, buchla, pads, rhodes });
 *   // each value is an AudioWorkletNode
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
const INTERVAL_MS  = 25;

/**
 * Evaluate all automation curves for a given track at a beat position.
 */
function _evalAutomation(curveMap, beat) {
  if (!curveMap) return {};
  const out = {};
  for (const [cc, pts] of Object.entries(curveMap)) {
    if (!pts.length) continue;
    if (beat <= pts[0][0])               { out[cc] = pts[0][1]; continue; }
    if (beat >= pts[pts.length-1][0])    { out[cc] = pts[pts.length-1][1]; continue; }
    for (let i = 1; i < pts.length; i++) {
      if (beat <= pts[i][0]) {
        const [b0, v0] = pts[i-1];
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
    this.ctx    = ctx;

    // AudioWorkletNode references (for audio graph wiring)
    this._nodes = {
      drum:   nodes.drums   ?? null,
      bass:   nodes.bass    ?? null,
      buchla: nodes.buchla  ?? null,
      pads:   nodes.pads    ?? null,
      rhodes: nodes.rhodes  ?? null,
    };

    // Worklet message ports (for trigger / setParams messages)
    this._ports = {
      drum:   nodes.drums?.port   ?? null,
      bass:   nodes.bass?.port    ?? null,
      buchla: nodes.buchla?.port  ?? null,
      pads:   nodes.pads?.port    ?? null,
      rhodes: nodes.rhodes?.port  ?? null,
    };

    this.sheet  = null;
    this._timer = null;

    this._bpm       = 120;
    this._steps     = [];   // compiled event list (no audioBuffer)
    this._loopBeats = 0;
    this._startTime = 0;
    this._nextBeat  = 0;
    this._stepIdx   = 0;

    // Per-instrument mute/solo/volume
    this._mute    = { drum: false, bass: false, buchla: false, pads: false, rhodes: false };
    this._solo    = { drum: false, bass: false, buchla: false, pads: false, rhodes: false };
    this._volumes = { drum: 1.0,   bass: 1.0,   buchla: 1.0,   pads: 1.0,   rhodes: 1.0  };

    this.loop  = true;
    this.onEnd = null;

    this._stepBeats = [];  // beat positions for the step visualizer

  }

  // ── Public API ─────────────────────────────────────────────────────────────

  load(sheet) {
    this.sheet = sheet;
    this._bpm  = sheet.bpm ?? 120;
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
        try { g.disconnect(); } catch (_) {}
      }
    }
    this._instrGains = {};
    for (const type of ['drum', 'bass', 'buchla', 'pads', 'rhodes']) {
      const node = this._nodes[type];
      if (node) { try { node.disconnect(); } catch (_) {} }
      const g = this.ctx.createGain();
      g.connect(this._masterGain);
      this._instrGains[type] = g;
      if (node) node.connect(g);
    }
    this._updateGains();

    this._startTime = this.ctx.currentTime + 0.05;
    this._nextBeat  = 0;
    this._stepIdx   = 0;
    this._timer = setInterval(() => this._tick(), INTERVAL_MS);
    this._tick();
  }

  stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    // Clear queued triggers in all worklets
    for (const port of Object.values(this._ports)) {
      if (port) port.postMessage({ type: 'stop' });
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

  // ── Internal ───────────────────────────────────────────────────────────────

  _isAudible(type) {
    const anySolo = Object.values(this._solo).some(v => v);
    if (anySolo) return this._solo[type];
    return !this._mute[type];
  }

  _updateGains() {
    for (const type of ['drum', 'bass', 'buchla', 'pads', 'rhodes']) {
      if (this._instrGains?.[type]) {
        this._instrGains[type].gain.value = this._isAudible(type) ? this._volumes[type] : 0.0;
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
        const vel   = (track.v ?? 100) / 127;
        const cc    = Object.assign({}, track.cc ?? {}, _evalAutomation(autoMap[track.t], beat));

        if (track.t === 10) {
          for (const note of notes) {
            const voiceId = drumNoteToVoice(note);
            raw.push({ beatTime: beat, type: 'drum', voiceId, velocity: vel });
          }
        }

        if (track.t === 2) {
          const durBeats = track.dur ?? d;
          for (const note of notes) {
            raw.push({ beatTime: beat, type: 'bass', midiNote: note, velocity: vel,
                       ccJson: JSON.stringify(cc), durBeats });
          }
        }

        if (track.t === 1) {
          for (const note of notes) {
            raw.push({ beatTime: beat, type: 'buchla', midiNote: note, velocity: vel,
                       ccJson: JSON.stringify(cc) });
          }
        }

        if (track.t === 6) {
          const durBeats = track.dur ?? step.d ?? 0.5;
          for (const note of notes) {
            raw.push({ beatTime: beat, type: 'pads', midiNote: note, velocity: vel,
                       ccJson: JSON.stringify(cc), durBeats });
          }
        }

        if (track.t === 3) {
          const durBeats = track.dur ?? step.d ?? 0.5;
          for (const note of notes) {
            raw.push({ beatTime: beat, type: 'rhodes', midiNote: note, velocity: vel,
                       ccJson: JSON.stringify(cc), durBeats });
          }
        }
      }

      beat += d;
    }

    raw.sort((a, b) => a.beatTime - b.beatTime);
    this._steps     = raw;
    this._loopBeats = beat;
    console.log(`[seq] compiled ${raw.length} events (${beat} beats @ ${this._bpm} BPM) — streaming`);
  }

  _beatsToSeconds(beats) { return beats * (60 / this._bpm); }

  _tick() {
    if (!this._steps.length) return;
    const scheduleUntil = this.ctx.currentTime + LOOKAHEAD_MS / 1000;

    while (true) {
      if (this._stepIdx >= this._steps.length) {
        if (!this.loop) {
          setTimeout(() => { this.stop(); this.onEnd?.(); }, 0);
          return;
        }
        this._nextBeat += this._loopBeats;
        this._stepIdx   = 0;
      }

      const ev     = this._steps[this._stepIdx];
      const loopN  = Math.floor(this._nextBeat / this._loopBeats) || 0;
      const evBeat = loopN * this._loopBeats + ev.beatTime;
      const evTime = this._startTime + this._beatsToSeconds(evBeat);

      if (evTime > scheduleUntil) break;

      if (this._isAudible(ev.type)) {
        this._sendTrigger(ev, evTime);
      }

      this._stepIdx++;
    }
  }

  _sendTrigger(ev, audioTime) {
    const port = this._ports[ev.type];
    if (!port) return;

    if (ev.type === 'drum') {
      port.postMessage({ type: 'trigger', audioTime,
                         voiceId: ev.voiceId, velocity: ev.velocity });

    } else if (ev.type === 'bass') {
      const holdSamples = Math.round(ev.durBeats * (60 / this._bpm) * this.ctx.sampleRate);
      port.postMessage({ type: 'trigger', audioTime,
                         midiNote: ev.midiNote, velocity: ev.velocity,
                         holdSamples, ccJson: ev.ccJson });

    } else if (ev.type === 'buchla') {
      port.postMessage({ type: 'trigger', audioTime,
                         midiNote: ev.midiNote, velocity: ev.velocity,
                         ccJson: ev.ccJson });

    } else if (ev.type === 'pads') {
      const holdSamples = Math.round(ev.durBeats * (60 / this._bpm) * this.ctx.sampleRate);
      port.postMessage({ type: 'trigger', audioTime,
                         midiNote: ev.midiNote, velocity: ev.velocity,
                         holdSamples, ccJson: ev.ccJson });

    } else if (ev.type === 'rhodes') {
      const holdSamples = Math.round(ev.durBeats * (60 / this._bpm) * this.ctx.sampleRate);
      port.postMessage({ type: 'trigger', audioTime,
                         midiNote: ev.midiNote, velocity: ev.velocity,
                         holdSamples, ccJson: ev.ccJson });
    }
  }
}

// ── Drum note → voice ID ──────────────────────────────────────────────────────

function drumNoteToVoice(note) {
  if (note === 36)                           return 0; // KICK
  if (note === 38 || note === 40)            return 1; // SNARE
  if ([42,49,50,51,52,53].includes(note))   return 2; // HH CL
  if ([46,54,55,56,57].includes(note))      return 3; // HH OP
  if (note === 41 || note === 43)            return 4; // TOM L
  if (note === 45 || note === 47)            return 5; // TOM M/H
  if (note === 48 || note === 50)            return 6; // CLAP/TOM-H/CYMBAL
  return 0;
}
