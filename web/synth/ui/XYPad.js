/**
 * XYPad — reusable 2D performance pad with named profiles.
 *
 * Each profile maps X and Y axes to arbitrary parameters via get/set callbacks,
 * supporting both linear and logarithmic scales.
 *
 * Usage:
 *   const pad = new XYPad({
 *     accentColor: '#00d4ff',
 *     size: 190,
 *     profiles: [
 *       { name: 'FILTER',
 *         x: { label: 'CUTOFF', min: 20, max: 18000, scale: 'log',
 *              get: () => currentCutoff, set: v => setCutoff(v) },
 *         y: { label: 'RESO',   min: 0.01, max: 20, scale: 'log',
 *              get: () => currentReso,   set: v => setReso(v) } },
 *     ],
 *   });
 *   container.appendChild(pad.render());
 *
 * Call pad.syncDot() after external state changes to refresh the dot position.
 */
export class XYPad {
  constructor({ profiles, accentColor = '#00d4ff', size = 190 }) {
    this._profiles    = profiles;
    this._accent      = accentColor;
    this._size        = size;
    this._profileIdx  = 0;
    this._cv          = null;
    this._ctx2d       = null;
    this._sel         = null;
    this._xLbl        = null;
    this._yLbl        = null;
    this._drag        = false;
  }

  // ── Scale helpers (same math as Knob.js) ──────────────────────────────────

  _toNorm(v, axis) {
    const { min, max, scale } = axis;
    if (scale === 'log') return Math.log(v / min) / Math.log(max / min);
    return (v - min) / (max - min);
  }

  _fromNorm(n, axis) {
    const { min, max, scale } = axis;
    if (scale === 'log') return min * Math.pow(max / min, n);
    return min + n * (max - min);
  }

  _clamp(n) { return Math.max(0, Math.min(1, n)); }

  // ── Current profile ────────────────────────────────────────────────────────

  get _profile() { return this._profiles[this._profileIdx]; }

  // ── Display helpers ────────────────────────────────────────────────────────

  _fmtVal(v, axis) {
    const range = axis.max - axis.min;
    if (range >= 100)  return Math.round(v).toString();
    if (range >= 1)    return v.toFixed(1);
    return v.toFixed(2);
  }

  // ── Canvas drawing ────────────────────────────────────────────────────────

  _draw() {
    const { x: ax, y: ay } = this._profile;
    const W = this._size, H = this._size;
    const c = this._ctx2d;

    const nx = this._clamp(this._toNorm(ax.get(), ax));
    const ny = this._clamp(this._toNorm(ay.get(), ay));
    const px = nx * W;
    const py = (1 - ny) * H;  // Y=0 is bottom

    c.clearRect(0, 0, W, H);

    // Background gradient (dark, slight accent tint)
    const grad = c.createLinearGradient(0, H, W, 0);
    grad.addColorStop(0,   '#0a0a0a');
    grad.addColorStop(0.5, '#0d0d0d');
    grad.addColorStop(1,   '#111');
    c.fillStyle = grad;
    c.fillRect(0, 0, W, H);

    // Grid — 4×4 divisions
    c.strokeStyle = 'rgba(255,255,255,0.05)';
    c.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      c.beginPath(); c.moveTo(W * i / 4, 0); c.lineTo(W * i / 4, H); c.stroke();
      c.beginPath(); c.moveTo(0, H * i / 4); c.lineTo(W, H * i / 4); c.stroke();
    }

    // Crosshair lines
    const accentFaint = this._accent + '44';
    c.strokeStyle = accentFaint;
    c.lineWidth = 1;
    c.beginPath(); c.moveTo(px, 0); c.lineTo(px, H); c.stroke();
    c.beginPath(); c.moveTo(0, py); c.lineTo(W, py); c.stroke();

    // Dot
    c.beginPath();
    c.arc(px, py, 6, 0, Math.PI * 2);
    c.fillStyle = this._accent;
    c.fill();

    // Value readout
    c.font = '9px monospace';
    c.fillStyle = 'rgba(255,255,255,0.35)';
    const xStr = `${ax.label} ${this._fmtVal(ax.get(), ax)}`;
    const yStr = `${ay.label} ${this._fmtVal(ay.get(), ay)}`;
    c.fillText(xStr, 5, H - 14);
    c.fillText(yStr, 5, H - 4);

    // Update axis labels
    if (this._xLbl) this._xLbl.textContent = `X: ${ax.label}`;
    if (this._yLbl) this._yLbl.textContent = `Y: ${ay.label}`;
  }

  // ── Input handling ────────────────────────────────────────────────────────

  _update(e) {
    const r  = this._cv.getBoundingClientRect();
    const cx = (e.touches ? e.touches[0].clientX : e.clientX) - r.left;
    const cy = (e.touches ? e.touches[0].clientY : e.clientY) - r.top;
    const nx = this._clamp(cx / r.width);
    const ny = this._clamp(1 - cy / r.height);  // invert Y (top = max)

    const { x: ax, y: ay } = this._profile;
    ax.set(this._fromNorm(nx, ax));
    ay.set(this._fromNorm(ny, ay));
    this._draw();
  }

  _attach() {
    const cv = this._cv;
    cv.addEventListener('mousedown',  e => { this._drag = true;  this._update(e); });
    cv.addEventListener('mousemove',  e => { if (this._drag) this._update(e); });
    cv.addEventListener('mouseup',    ()  => { this._drag = false; });
    cv.addEventListener('mouseleave', ()  => { this._drag = false; });
    cv.addEventListener('touchstart', e => { e.preventDefault(); this._update(e); }, { passive: false });
    cv.addEventListener('touchmove',  e => { e.preventDefault(); this._update(e); }, { passive: false });
    cv.addEventListener('touchend',   e => { e.preventDefault(); }, { passive: false });
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /** Refresh dot from current parameter values (call after external knob changes). */
  syncDot() { if (this._cv) this._draw(); }

  /** Render and return the wrapper element. Call once. */
  render() {
    const wrap = document.createElement('div');
    wrap.className = 'xy-pad-wrap';

    // Profile selector
    this._sel = document.createElement('select');
    this._sel.className = 'xy-profile-sel';
    this._profiles.forEach((p, i) => {
      const opt = document.createElement('option');
      opt.value = i; opt.textContent = p.name;
      this._sel.appendChild(opt);
    });
    this._sel.addEventListener('change', () => {
      this._profileIdx = +this._sel.value;
      this._draw();
    });
    wrap.appendChild(this._sel);

    // Canvas
    this._cv = document.createElement('canvas');
    this._cv.className  = 'xy-pad-cv';
    this._cv.width      = this._size;
    this._cv.height     = this._size;
    this._cv.style.width  = this._size + 'px';
    this._cv.style.height = this._size + 'px';
    this._ctx2d = this._cv.getContext('2d');
    wrap.appendChild(this._cv);

    // Axis labels
    const lblRow = document.createElement('div');
    lblRow.className = 'xy-axes-label';
    this._xLbl = document.createElement('span');
    this._yLbl = document.createElement('span');
    lblRow.appendChild(this._xLbl);
    lblRow.appendChild(this._yLbl);
    wrap.appendChild(lblRow);

    this._attach();
    this._draw();
    return wrap;
  }
}
