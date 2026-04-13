/**
 * InstrumentRegistry.js — Catalog of all available instruments.
 *
 * Instruments can be WASM (built-in) or Web Audio (user-created patches).
 * The registry is the single source of truth for "what can be plugged into
 * a slot." Built-in descriptors are registered at module load time and
 * cannot be unregistered.  Custom patches are persisted to localStorage.
 *
 * Descriptor schema:
 *   id:      string   — unique key, e.g. 'wasm:bass' or 'patch:abc123'
 *   name:    string   — human-readable label
 *   role:    string   — 'bass' | 'lead' | 'pad' | 'keys' | 'drums' | 'poly_fm'
 *   type:    string   — 'wasm' | 'webaudio'
 *   builtIn: boolean  — if true, cannot be unregistered
 *   state:   object|null — patch JSON (webaudio only; null for wasm)
 */

const STORAGE_KEY = 'clankers_instrument_library';

class InstrumentRegistry {
  constructor() {
    this._catalog = new Map();
    this._restore();
  }

  /**
   * Register an instrument descriptor.
   * Overwrites any existing non-builtIn entry with the same id.
   * @param {object} descriptor
   */
  register(descriptor) {
    if (!descriptor.id) throw new Error('InstrumentRegistry: descriptor.id is required');
    const existing = this._catalog.get(descriptor.id);
    if (existing?.builtIn && !descriptor.builtIn) {
      throw new Error(`InstrumentRegistry: cannot overwrite built-in instrument "${descriptor.id}"`);
    }
    this._catalog.set(descriptor.id, { ...descriptor });
    if (!descriptor.builtIn) this._save();
    return descriptor.id;
  }

  /**
   * Remove a custom (non-builtIn) instrument from the catalog.
   * @param {string} id
   */
  unregister(id) {
    const desc = this._catalog.get(id);
    if (!desc) return;
    if (desc.builtIn) throw new Error(`InstrumentRegistry: cannot unregister built-in "${id}"`);
    this._catalog.delete(id);
    this._save();
  }

  /**
   * Look up a descriptor by id.
   * @param {string} id
   * @returns {object|null}
   */
  get(id) { return this._catalog.get(id) ?? null; }

  /**
   * List all descriptors, optionally filtered by role.
   * @param {string|null} [role]
   * @returns {object[]}
   */
  list(role = null) {
    const all = [...this._catalog.values()];
    return role ? all.filter(d => d.role === role) : all;
  }

  /** Whether any custom (non-builtIn) patches have been registered */
  get hasCustom() {
    return [...this._catalog.values()].some(d => !d.builtIn);
  }

  // ── Persistence ──────────────────────────────────────────────────────────────

  _save() {
    const custom = [...this._catalog.values()].filter(d => !d.builtIn);
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(custom)); } catch (_) {}
  }

  _restore() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const custom = JSON.parse(raw);
      if (Array.isArray(custom)) {
        for (const d of custom) {
          if (d?.id) this._catalog.set(d.id, { ...d, builtIn: false });
        }
      }
    } catch (_) {}
  }
}

// ── Singleton ─────────────────────────────────────────────────────────────────
export const registry = new InstrumentRegistry();

// ── Built-in WASM instruments ─────────────────────────────────────────────────
registry.register({ id: 'wasm:drum',   name: 'AntigravityDrums', role: 'drums',   type: 'wasm', builtIn: true, state: null });
registry.register({ id: 'wasm:bass',   name: 'Pro-One Bass FM',  role: 'bass',    type: 'wasm', builtIn: true, state: null });
registry.register({ id: 'wasm:buchla', name: 'Buchla 259/292',   role: 'poly_fm', type: 'wasm', builtIn: true, state: null });
registry.register({ id: 'wasm:pads',   name: 'HybridSynth Pads', role: 'pad',     type: 'wasm', builtIn: true, state: null });
registry.register({ id: 'wasm:rhodes', name: 'Rhodes EP',        role: 'keys',    type: 'wasm', builtIn: true, state: null });
registry.register({ id: 'wasm:voder',  name: 'Voder',            role: 'voice',   type: 'wasm', builtIn: true, state: null });
