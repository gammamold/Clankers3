/**
 * Knob — SVG rotary knob component.
 * Drag up/down to change value. Double-click to reset.
 * scale: 'linear' | 'log'  — log is essential for frequency & time params.
 */
export class Knob {
  constructor({ label, min, max, value, step = 0.001, decimals = 2, unit = '', scale = 'linear', onChange }) {
    this.label    = label;
    this.min      = min;
    this.max      = max;
    this._value   = value;
    this.step     = step;
    this.decimals = decimals;
    this.unit     = unit;
    this.scale    = scale;
    this.onChange = onChange;
    this._default = value;
    this.el       = null;
  }

  // Convert raw value → 0..1 norm (for drawing)
  _toNorm(value) {
    if (this.scale === 'log') {
      return Math.log(value / this.min) / Math.log(this.max / this.min);
    }
    return (value - this.min) / (this.max - this.min);
  }

  // Convert 0..1 norm → raw value
  _fromNorm(norm) {
    if (this.scale === 'log') {
      return this.min * Math.pow(this.max / this.min, norm);
    }
    return this.min + norm * (this.max - this.min);
  }

  render() {
    this.el = document.createElement('div');
    this.el.className = 'knob-wrap';
    this.el.innerHTML = `
      <svg class="knob-svg" viewBox="0 0 60 60" width="60" height="60">
        <circle cx="30" cy="30" r="24" class="knob-track"/>
        <path class="knob-arc" d=""/>
        <circle cx="30" cy="30" r="18" class="knob-body"/>
        <line class="knob-tick" x1="30" y1="30" x2="30" y2="14"/>
      </svg>
      <div class="knob-value"></div>
      <div class="knob-label">${this.label}</div>
    `;
    this._svg  = this.el.querySelector('.knob-svg');
    this._arc  = this.el.querySelector('.knob-arc');
    this._tick = this.el.querySelector('.knob-tick');
    this._disp = this.el.querySelector('.knob-value');
    this._draw();
    this._attach();
    return this.el;
  }

  _draw() {
    const norm = Math.max(0, Math.min(1, this._toNorm(this._value)));

    // startAngle 225 = 7 o'clock (min), sweep 270° CW to 4:30 (max)
    const startAngle = 225;
    const totalArc   = 270;
    const angle      = startAngle + norm * totalArc;
    const toRad      = (a) => (a * Math.PI) / 180;

    // Arc path — SVG trig: 0=right, y-down, so subtract 90 to convert up=0 system
    const r = 24, cx = 30, cy = 30;
    const sa = toRad(startAngle - 90);
    const ea = toRad(angle - 90);
    const x1 = cx + r * Math.cos(sa), y1 = cy + r * Math.sin(sa);
    const x2 = cx + r * Math.cos(ea), y2 = cy + r * Math.sin(ea);
    // large-arc-flag must be 1 only when the arc exceeds 180°.
    // Sweep is 270°, so threshold is 180/270 = 2/3, NOT 0.5.
    const large = (norm * 270) > 180 ? 1 : 0;
    this._arc.setAttribute('d', norm > 0.001
      ? `M ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2}` : '');

    // Tick rotation — SVG rotate() is clockwise, startAngle 225 CW from up = 7 o'clock ✓
    this._tick.setAttribute('transform', `rotate(${angle}, 30, 30)`);

    // Display value
    const display = parseFloat(this._value.toFixed(this.decimals));
    this._disp.textContent = display + this.unit;
  }

  _attach() {
    let startY, startNorm;
    const onMove = (e) => {
      const dy = startY - (e.clientY ?? e.touches?.[0]?.clientY);
      // Drag sensitivity: 150px = full range in norm space
      let norm = Math.max(0, Math.min(1, startNorm + dy / 150));
      let next = this._fromNorm(norm);
      if (this.step >= 1) next = Math.round(next / this.step) * this.step;
      next = Math.max(this.min, Math.min(this.max, next));
      this._value = next;
      this._draw();
      this.onChange(next);
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    this._svg.addEventListener('mousedown', (e) => {
      e.preventDefault();
      startY    = e.clientY;
      startNorm = this._toNorm(this._value);
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    });
    this._svg.addEventListener('dblclick', () => {
      this._value = this._default;
      this._draw();
      this.onChange(this._value);
    });
    this._svg.addEventListener('wheel', (e) => {
      e.preventDefault();
      let norm = this._toNorm(this._value);
      norm = Math.max(0, Math.min(1, norm - e.deltaY / 1000));
      let next = this._fromNorm(norm);
      if (this.step >= 1) next = Math.round(next / this.step) * this.step;
      next = Math.max(this.min, Math.min(this.max, next));
      this._value = next;
      this._draw();
      this.onChange(next);
    }, { passive: false });
  }

  setValue(v) {
    this._value = Math.max(this.min, Math.min(this.max, v));
    this._draw();
  }
}
