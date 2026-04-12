/**
 * Clankers 3 — Offline audio renderer (Option B)
 *
 * Renders a song sheet to a WAV Blob using OfflineAudioContext.
 * All five AudioWorklet engines run on the offline context — faster than
 * real-time (CPU-bound, typically 10-50x RT).  Full FX chain included.
 *
 * Usage:
 *   import { offlineRender } from './render.js';
 *   const blob = await offlineRender(sheet, { wasmModule, seed, fxParams,
 *                                             bassOctaveOffset, drumParams });
 *   // blob is audio/wav — call URL.createObjectURL(blob) to download
 */

import { Sequencer } from './sequencer.js?v=18';
import { MasterFx }  from './fx.js';

// ── WAV encoder ────────────────────────────────────────────────────────────────

/**
 * Encode an AudioBuffer to a 16-bit stereo WAV Blob.
 * Interleaves channels in standard L/R order.
 */
function encodeWav(buffer) {
  const SR    = buffer.sampleRate;
  const nCh   = buffer.numberOfChannels;
  const nSamp = buffer.length;
  const block = nCh * 2;                    // bytes per sample frame (16-bit)
  const data  = nSamp * block;
  const ab    = new ArrayBuffer(44 + data);
  const v     = new DataView(ab);
  const str   = (off, s) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); };

  str(0, 'RIFF'); v.setUint32(4, 36 + data, true);
  str(8, 'WAVE'); str(12, 'fmt ');
  v.setUint32(16, 16, true);          // fmt chunk size
  v.setUint16(20,  1, true);          // PCM
  v.setUint16(22, nCh, true);
  v.setUint32(24, SR, true);
  v.setUint32(28, SR * block, true);  // byte rate
  v.setUint16(32, block, true);       // block align
  v.setUint16(34, 16, true);          // bits per sample
  str(36, 'data'); v.setUint32(40, data, true);

  let off = 44;
  for (let i = 0; i < nSamp; i++) {
    for (let c = 0; c < nCh; c++) {
      const s = Math.max(-1, Math.min(1, buffer.getChannelData(c)[i]));
      v.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      off += 2;
    }
  }
  return new Blob([ab], { type: 'audio/wav' });
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function waitForReady(node) {
  return new Promise((resolve, reject) => {
    node.port.addEventListener('message', function h(e) {
      if (e.data.type === 'ready') { node.port.removeEventListener('message', h); resolve(); }
      else if (e.data.type === 'error') { node.port.removeEventListener('message', h); reject(new Error(e.data.message)); }
    });
    node.port.start();
  });
}

// ── Main export ────────────────────────────────────────────────────────────────

/**
 * Render a ClankerBoy sheet to a WAV Blob.
 *
 * @param {object} sheet  ClankerBoy JSON sheet (must have .bpm and .steps)
 * @param {object} opts
 *   wasmModule       {WebAssembly.Module}  compiled WASM — required
 *   seed             {number}              RNG seed (matches live session)
 *   fxParams         {object}              result of rack.getParams() — optional
 *   bassOctaveOffset {number}              default 48 (matches live seq)
 *   drumParams       {object}              { semitones, hz, mult, profileId }
 *   tailSec          {number}              extra seconds for reverb/delay decay (default 4)
 * @returns {Promise<Blob>} audio/wav
 */
export async function offlineRender(sheet, opts = {}) {
  const {
    wasmModule,
    seed             = 0,
    fxParams         = null,
    bassOctaveOffset = 48,
    drumParams       = null,
    tailSec          = 4,
  } = opts;

  if (!wasmModule) throw new Error('offlineRender: wasmModule is required');

  const SR  = 44100;
  const bpm = sheet.bpm ?? 120;

  // Duration: one full loop + silence tail for FX decay
  const totalBeats = (sheet.steps ?? []).reduce((s, step) => s + (step.d ?? 0.5), 0);
  const loopSec    = totalBeats * (60 / bpm);
  const totalSec   = loopSec + tailSec;
  const nFrames    = Math.ceil(totalSec * SR);

  // ── 1. Create OfflineAudioContext ──────────────────────────────────────────
  const offCtx = new OfflineAudioContext(2, nFrames, SR);

  // ── 2. Register worklet modules ───────────────────────────────────────────
  // Each OfflineAudioContext needs its own addModule() calls.
  // Load WASM glue into worklet scope as classic script (static import unsupported)
  let glue = await fetch('/wasm/clankers_dsp.js').then(r => r.text());
  const polyfill = `
if (typeof TextDecoder === 'undefined') {
  globalThis.TextDecoder = class { decode(buf) { if (!buf || !buf.length) return ''; return String.fromCharCode.apply(null, new Uint8Array(buf.buffer || buf, buf.byteOffset, buf.byteLength)); } };
}
if (typeof TextEncoder === 'undefined') {
  globalThis.TextEncoder = class { encode(s) { const a = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i); return a; } encodeInto(s, dest) { const a = this.encode(s); dest.set(a); return { read: s.length, written: a.length }; } };
}
`;
  glue = polyfill + glue.replace(/^export\s+class\s/gm, 'class ')
             .replace(/^export\s*\{[^}]*\}\s*;?\s*$/gm, '')
             .replace(/import\.meta\.url/g, "'unused'");
  glue += `\nglobalThis.initSync = initSync;\n`
        + `globalThis.ClankersBass = ClankersBass;\n`
        + `globalThis.ClankersBuchla = ClankersBuchla;\n`
        + `globalThis.ClankersDrums = ClankersDrums;\n`
        + `globalThis.ClankersPads = ClankersPads;\n`
        + `globalThis.ClankersRhodes = ClankersRhodes;\n`;
  const glueBlob = new Blob([glue], { type: 'application/javascript' });
  await offCtx.audioWorklet.addModule(URL.createObjectURL(glueBlob));

  await offCtx.audioWorklet.addModule('/worklets/drums-worklet.js');
  await offCtx.audioWorklet.addModule('/worklets/bass-worklet.js');
  await offCtx.audioWorklet.addModule('/worklets/buchla-worklet.js');
  await offCtx.audioWorklet.addModule('/worklets/pads-worklet.js');
  await offCtx.audioWorklet.addModule('/worklets/rhodes-worklet.js');

  // ── 3. Create worklet nodes (share pre-compiled WASM module) ──────────────
  const drumsNode  = new AudioWorkletNode(offCtx, 'drums-worklet',  { processorOptions: { wasmModule, seed }, outputChannelCount: [1] });
  const bassNode   = new AudioWorkletNode(offCtx, 'bass-worklet',   { processorOptions: { wasmModule, seed: seed ^ 0xdeadbeef } });
  const buchlaNode = new AudioWorkletNode(offCtx, 'buchla-worklet', { processorOptions: { wasmModule } });
  const padsNode   = new AudioWorkletNode(offCtx, 'pads-worklet',   { processorOptions: { wasmModule }, outputChannelCount: [2] });
  const rhodesNode = new AudioWorkletNode(offCtx, 'rhodes-worklet', { processorOptions: { wasmModule }, outputChannelCount: [2] });

  await Promise.all([
    waitForReady(drumsNode), waitForReady(bassNode), waitForReady(buchlaNode),
    waitForReady(padsNode),  waitForReady(rhodesNode),
  ]);

  // ── 4. Wire audio graph (mirrors live session) ─────────────────────────────
  const masterGain = offCtx.createGain();
  masterGain.gain.value = 0.22;
  masterGain.connect(offCtx.destination);

  const instrGains = {};
  for (const [type, node] of [
    ['drum',   drumsNode],
    ['bass',   bassNode],
    ['buchla', buchlaNode],
    ['pads',   padsNode],
    ['rhodes', rhodesNode],
  ]) {
    const g = offCtx.createGain();
    g.connect(masterGain);
    instrGains[type] = g;
    node.connect(g);
  }

  const rack = new MasterFx(offCtx);
  rack.attach(instrGains, offCtx.destination);
  if (fxParams) rack.setParams(fxParams, bpm);

  // ── 5. Send drum param overrides (pitch / filter / decay / profile) ────────
  if (drumParams) {
    const { semitones = 0, hz = 5000, mult = 1.0, profileId = 0 } = drumParams;
    drumsNode.port.postMessage({ type: 'setPitch',   semitones });
    drumsNode.port.postMessage({ type: 'setFilter',  hz });
    drumsNode.port.postMessage({ type: 'setDecay',   mult });
    drumsNode.port.postMessage({ type: 'setProfile', profileId });
  }

  // ── 6. Compile sheet and pre-schedule all events ──────────────────────────
  // Events are queued in the worklet's internal _queue; the worklet drains
  // them at the correct sample time during process() — same as live mode.
  // Push FM drum voice params if provided (mirrors live session state)
  if (opts.fmDrumParams && Array.isArray(opts.fmDrumParams)) {
    opts.fmDrumParams.forEach((vp, vi) => {
      if (!vp) return;
      for (const [param, value] of Object.entries(vp)) {
        fmDrumsNode.port.postMessage({ type: 'setVoiceParam', voiceId: vi, param, value });
      }
    });
  }

  const seq = new Sequencer(offCtx, {
    drums: drumsNode, bass: bassNode, buchla: buchlaNode,
    pads: padsNode, rhodes: rhodesNode, fmDrums: fmDrumsNode,
  });
  seq.bassOctaveOffset = bassOctaveOffset;
  seq.load(sheet);

  // 0.1s start offset gives message queue time to propagate before first event
  const startTime = 0.1;
  for (const ev of seq._steps) {
    const evTime = startTime + ev.beatTime * (60 / bpm);
    seq._sendTrigger(ev, evTime);
  }

  // ── 7. Render (CPU-bound, non-blocking, resolves when done) ───────────────
  const audioBuffer = await offCtx.startRendering();

  return encodeWav(audioBuffer);
}
