/**
 * MidiOutput — Web MIDI API output wrapper for Clankers 3
 *
 * Sends timing-accurate NoteOn/NoteOff messages to a selected MIDI output
 * port, with per-instrument channel assignment.
 *
 * Usage:
 *   import { midiOut } from './midi-output.js';
 *   await midiOut.init();
 *   midiOut.setOutput(portId);
 *   midiOut.setChannel('bass', 2);   // route bass to MIDI ch 2
 *   // called automatically by sequencer:
 *   midiOut.scheduleNote('bass', 48, 0.85, audioTime, ctx, 500);
 *
 * Drum voice → GM MIDI note mapping:
 *   0 = KICK  → 36   3 = HH OP → 46
 *   1 = SNARE → 38   4 = TOM L → 41
 *   2 = HH CL → 42   5 = TOM M → 45   6 = CLAP → 48
 */

const DRUM_VOICE_NOTES = [36, 38, 42, 46, 41, 45, 48];

export class MidiOutput {
  constructor() {
    this._access   = null;   // MIDIAccess object
    this._port     = null;   // active MIDIOutput port
    this._channels = {       // per-instrument MIDI channel (1-16), null = off
      drum:   null, bass:   null, buchla: null,
      pads:   null, rhodes: null,
      synth0: null, synth1: null, synth2: null, synth3: null, synth4: null,
    };
    /** Fired when the list of available output ports changes. */
    this.onPortsChanged = null;
  }

  /**
   * Request Web MIDI access. Safe to call multiple times.
   * Returns true if MIDI is available, false otherwise.
   */
  async init() {
    if (this._access) return true;
    if (!navigator.requestMIDIAccess) {
      console.warn('[MIDI] Web MIDI API not supported in this browser');
      return false;
    }
    try {
      this._access = await navigator.requestMIDIAccess({ sysex: false });
      this._access.onstatechange = () => {
        this.onPortsChanged?.();
        window.dispatchEvent(new CustomEvent('midi-ports-changed'));
      };
      return true;
    } catch (e) {
      console.warn('[MIDI] Access denied:', e);
      return false;
    }
  }

  /** Returns Array<{ id: string, name: string }> of available output ports. */
  getOutputs() {
    if (!this._access) return [];
    return Array.from(this._access.outputs.values()).map(p => ({ id: p.id, name: p.name }));
  }

  /** Select the active output port by its id. Pass null or '' to disable. */
  setOutput(portId) {
    this._port = portId ? (this._access?.outputs.get(portId) ?? null) : null;
  }

  /** Set the MIDI channel (1–16) for an instrument. null = off. */
  setChannel(instrType, channel) {
    this._channels[instrType] = channel ? +channel : null;
  }

  /** Get current channel for an instrument. */
  getChannel(instrType) {
    return this._channels[instrType];
  }

  /**
   * Schedule a NoteOn + NoteOff pair with timing accuracy matching the
   * Web Audio lookahead scheduler.
   *
   * @param {string} instrType     - Instrument key: 'drum'|'bass'|'buchla'|'pads'|'rhodes'|'synth0'-'synth4'
   * @param {number} noteOrVoiceId - MIDI note number (0-127), or drum voiceId (0-6)
   * @param {number} velocity      - Velocity in Web Audio range 0.0–1.0
   * @param {number} audioTime     - Web Audio context timestamp for NoteOn
   * @param {AudioContext} ctx     - AudioContext (used for timing offset)
   * @param {number} durationMs    - Hold duration in ms before NoteOff
   */
  scheduleNote(instrType, noteOrVoiceId, velocity, audioTime, ctx, durationMs) {
    const ch = this._channels[instrType];
    if (!ch || !this._port) return;

    const note = instrType === 'drum'
      ? (DRUM_VOICE_NOTES[noteOrVoiceId] ?? 36)
      : Math.max(0, Math.min(127, noteOrVoiceId));

    const vel    = Math.max(1, Math.min(127, Math.round(velocity * 127)));
    const ch0    = (ch - 1) & 0x0F;
    const nowMs  = performance.now();
    const delayMs = Math.max(0, (audioTime - ctx.currentTime) * 1000);

    // NoteOn — use port timestamp for sub-millisecond accuracy where supported
    setTimeout(() => {
      this._port?.send([0x90 | ch0, note, vel], performance.now());
    }, delayMs);

    // NoteOff
    if (durationMs > 0) {
      setTimeout(() => {
        this._port?.send([0x80 | ch0, note, 0], performance.now());
      }, delayMs + durationMs);
    }
  }
}

/** Module-level singleton — import and use directly. */
export const midiOut = new MidiOutput();
