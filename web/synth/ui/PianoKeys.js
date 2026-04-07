/**
 * PianoKeys — on-screen keyboard + computer keyboard mapping.
 * Fires onNoteOn(midi) / onNoteOff(midi).
 *
 * Key map (QWERTY):
 *   White: A S D F G H J K L
 *   Black: W E   T Y U   O P
 *   Z = octave down · X = octave up
 */
export class PianoKeys {
  constructor({ onNoteOn, onNoteOff, octave = 4, keys = 2 }) {
    this.onNoteOn  = onNoteOn;
    this.onNoteOff = onNoteOff;
    this.octave    = octave;
    this.keys      = keys;
    this.el        = null;
    this._active   = new Set();
    this._octaveEl = null;

    // Map key → semitone offset from C of current octave
    this._keyMap = {
      'a': 0, 'w': 1, 's': 2, 'e': 3,  'd': 4,
      'f': 5, 't': 6, 'g': 7, 'y': 8,  'h': 9,
      'u': 10,'j': 11,'k': 12,'o': 13, 'l': 14,
      'p': 15,';': 16,
    };
  }

  _midiFor(semitone) {
    return 12 * (this.octave + 1) + semitone;
  }

  render() {
    this.el = document.createElement('div');
    this.el.className = 'piano-wrap';

    // Octave indicator
    this._octaveEl = document.createElement('div');
    this._octaveEl.className = 'octave-indicator';
    this._updateOctaveDisplay();
    this.el.appendChild(this._octaveEl);

    // Keys
    const keysEl = document.createElement('div');
    keysEl.className = 'piano-keys';

    const totalSemitones = this.keys * 12;
    const noteNames = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];

    for (let s = 0; s < totalSemitones; s++) {
      const name = noteNames[s % 12];
      const isBlack = name.includes('#');
      const key = document.createElement('div');
      key.className = isBlack ? 'piano-key black' : 'piano-key white';
      key.dataset.semi = s;

      key.addEventListener('mousedown', (e) => {
        e.preventDefault();
        // Blur any focused input/select so keyboard shortcuts keep working
        if (document.activeElement && document.activeElement !== document.body) {
          document.activeElement.blur();
        }
        this._press(this._midiFor(s));
      });
      key.addEventListener('mouseenter', (e) => {
        if (e.buttons === 1) this._press(this._midiFor(s));
      });
      key.addEventListener('mouseup',    () => this._release(this._midiFor(s)));
      key.addEventListener('mouseleave', () => this._release(this._midiFor(s)));

      keysEl.appendChild(key);
    }

    this.el.appendChild(keysEl);
    this._keysEl = keysEl;
    this._attachKeyboard();
    return this.el;
  }

  _press(midi) {
    if (this._active.has(midi)) return;
    this._active.add(midi);
    this._highlightMidi(midi, true);
    this.onNoteOn(midi);
  }

  _release(midi) {
    if (!this._active.has(midi)) return;
    this._active.delete(midi);
    this._highlightMidi(midi, false);
    this.onNoteOff(midi);
  }

  _highlightMidi(midi, on) {
    // find the key by its current midi = octave + semitone
    const semi = midi - 12 * (this.octave + 1);
    const key = this._keysEl?.querySelector(`[data-semi="${semi}"]`);
    if (key) key.classList.toggle('active', on);
  }

  _releaseAll() {
    this._active.forEach(midi => {
      this.onNoteOff(midi);
    });
    this._active.clear();
    this._keysEl?.querySelectorAll('.piano-key.active')
      .forEach(k => k.classList.remove('active'));
  }

  _shiftOctave(delta) {
    this._releaseAll();                         // stop any held notes first
    this.octave = Math.max(1, Math.min(7, this.octave + delta));
    this._updateOctaveDisplay();
  }

  _updateOctaveDisplay() {
    if (this._octaveEl) {
      this._octaveEl.textContent = `OCT ${this.octave}  ·  Z ▼  X ▲`;
    }
  }

  _attachKeyboard() {
    window.addEventListener('keydown', (e) => {
      // Never fire when typing in an input/textarea/select
      const tag = e.target.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;

      // Octave shift — use e.code (physical key, layout-independent).
      // Must return early so these keys NEVER reach the note-press logic.
      if (e.code === 'KeyZ') {
        e.preventDefault();
        if (!e.repeat) this._shiftOctave(-1);
        return;
      }
      if (e.code === 'KeyX') {
        e.preventDefault();
        if (!e.repeat) this._shiftOctave(+1);
        return;
      }

      if (e.repeat) return;
      const semi = this._keyMap[e.key.toLowerCase()];
      if (semi !== undefined) {
        e.preventDefault();
        this._press(this._midiFor(semi));
      }
    });

    window.addEventListener('keyup', (e) => {
      const tag = e.target.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      const semi = this._keyMap[e.key.toLowerCase()];
      if (semi !== undefined) this._release(this._midiFor(semi));
    });
  }
}
