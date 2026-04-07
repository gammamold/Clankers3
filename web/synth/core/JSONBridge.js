/**
 * JSONBridge — live JSON state for the instrument.
 * All module knob changes flow through here.
 * Forge! reads from this to export the final instrument JSON.
 */
export class JSONBridge {
  constructor() {
    this._state = {};
    this._listeners = [];
  }

  init(template) {
    this._state = JSON.parse(JSON.stringify(template));
    this._notify();
  }

  get(path) {
    return path.split('.').reduce((o, k) => (o != null ? o[k] : undefined), this._state);
  }

  set(path, value) {
    const keys = path.split('.');
    let obj = this._state;
    for (let i = 0; i < keys.length - 1; i++) {
      if (obj[keys[i]] == null) obj[keys[i]] = {};
      obj = obj[keys[i]];
    }
    obj[keys[keys.length - 1]] = value;
    this._notify();
  }

  /** Push a value into an array at path */
  pushEffect(effect) {
    if (!Array.isArray(this._state.modules.effects)) {
      this._state.modules.effects = [];
    }
    this._state.modules.effects.push(effect);
    this._notify();
  }

  removeEffect(index) {
    this._state.modules.effects.splice(index, 1);
    this._notify();
  }

  onChange(fn) {
    this._listeners.push(fn);
  }

  snapshot() {
    return JSON.parse(JSON.stringify(this._state));
  }

  _notify() {
    const snap = this.snapshot();
    this._listeners.forEach(fn => fn(snap));
  }
}
