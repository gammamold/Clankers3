/**
 * MidiInput — Web MIDI API input wrapper for Clankers 3
 *
 * Listens for NoteOn/NoteOff/CC messages on a selected MIDI input port
 * and dispatches them via callbacks.
 *
 * Usage:
 *   import { midiIn } from './midi-input.js';
 *   await midiIn.init();
 *   midiIn.setInput(portId);
 *   midiIn.onNoteOn = (note, velocity, channel) => { ... };
 *   midiIn.onNoteOff = (note, channel) => { ... };
 *   midiIn.onCC = (cc, value, channel) => { ... };
 */

export class MidiInput {
  constructor() {
    this._access = null;
    this._port = null;
    this.onNoteOn = null;   // (note, velocity, channel) => {}
    this.onNoteOff = null;  // (note, channel) => {}
    this.onCC = null;       // (cc, value, channel) => {}
    this.onPortsChanged = null;
  }

  async init() {
    if (this._access) return true;
    if (!navigator.requestMIDIAccess) {
      console.warn('[MIDI-IN] Web MIDI API not supported in this browser');
      return false;
    }
    try {
      this._access = await navigator.requestMIDIAccess({ sysex: false });
      this._access.onstatechange = () => {
        this.onPortsChanged?.();
        window.dispatchEvent(new CustomEvent('midi-input-ports-changed'));
      };
      return true;
    } catch (e) {
      console.warn('[MIDI-IN] Access denied:', e);
      return false;
    }
  }

  getInputs() {
    if (!this._access) return [];
    return Array.from(this._access.inputs.values()).map(p => ({ id: p.id, name: p.name }));
  }

  setInput(portId) {
    // Detach old listener
    if (this._port) this._port.onmidimessage = null;
    this._port = portId ? (this._access?.inputs.get(portId) ?? null) : null;
    if (this._port) {
      this._port.onmidimessage = (e) => this._handleMessage(e);
    }
  }

  _handleMessage(e) {
    const [status, data1, data2] = e.data;
    const cmd = status & 0xF0;
    const ch = (status & 0x0F) + 1; // 1-indexed channel

    if (cmd === 0x90 && data2 > 0) {
      // NoteOn
      this.onNoteOn?.(data1, data2 / 127, ch);
    } else if (cmd === 0x80 || (cmd === 0x90 && data2 === 0)) {
      // NoteOff
      this.onNoteOff?.(data1, ch);
    } else if (cmd === 0xB0) {
      // CC
      this.onCC?.(data1, data2, ch);
    }
  }
}

export const midiIn = new MidiInput();
