import { Knob } from './Knob.js';

/**
 * ModulePanel — renders a named rack panel with knobs bound to JSONBridge paths.
 */
export class ModulePanel {
  constructor({ title, color, knobs, bridge }) {
    this.title  = title;
    this.color  = color || '#2a9d8f';
    this.knobs  = knobs; // [{label, path, min, max, value, step, decimals, unit}]
    this.bridge = bridge;
    this.el     = null;
    this._knobInstances = [];
  }

  render() {
    this.el = document.createElement('div');
    this.el.className = 'module-panel';
    this.el.style.setProperty('--panel-color', this.color);

    const header = document.createElement('div');
    header.className = 'panel-header';
    header.textContent = this.title;
    this.el.appendChild(header);

    const body = document.createElement('div');
    body.className = 'panel-body';

    this.knobs.forEach(def => {
      const knob = new Knob({
        label:    def.label,
        min:      def.min,
        max:      def.max,
        value:    def.value ?? this.bridge.get(def.path),
        step:     def.step,
        decimals: def.decimals ?? 2,
        unit:     def.unit ?? '',
        scale:    def.scale ?? 'linear',
        onChange: (v) => {
          this.bridge.set(def.path, v);
          if (def.onAudio) def.onAudio(v);
        },
      });
      this._knobInstances.push({ knob, path: def.path });
      body.appendChild(knob.render());
    });

    this.el.appendChild(body);
    return this.el;
  }

  /** Sync knob displays to current bridge state (e.g. after wizard reloads) */
  syncFromBridge() {
    this._knobInstances.forEach(({ knob, path }) => {
      const v = this.bridge.get(path);
      if (v != null) knob.setValue(v);
    });
  }
}
