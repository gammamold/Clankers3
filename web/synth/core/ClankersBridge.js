/**
 * ClankersBridge — generates the `clankers` metadata block for the Forge! export.
 *
 * The exported block tells the Clankers environment:
 *   trackType  → which track slot to use (7 = custom Web Audio synth)
 *   ccMap      → CC number → { path, min, max, scale, label }
 *   defaultCC  → current param values expressed as CC 0–127
 *
 * This lets the Clankers sequencer control any parameter via standard CC messages,
 * and lets the Clankers LLM know what knobs exist and their ranges.
 */

// Base (non-effect) CC definitions — follows Clankers CC conventions where applicable
const BASE_DEFS = [
  { cc: 74, path: 'modules.vcf.cutoff',          min: 20,    max: 18000, scale: 'log',    label: 'VCF Cutoff' },
  { cc: 71, path: 'modules.vcf.resonance',        min: 0.01,  max: 20,    scale: 'linear', label: 'VCF Resonance' },
  { cc: 73, path: 'modules.adsr_amp.attack',      min: 0.001, max: 8,     scale: 'log',    label: 'Amp Attack' },
  { cc: 75, path: 'modules.adsr_amp.decay',       min: 0.001, max: 8,     scale: 'log',    label: 'Amp Decay' },
  { cc: 79, path: 'modules.adsr_amp.sustain',     min: 0,     max: 1,     scale: 'linear', label: 'Amp Sustain' },
  { cc: 72, path: 'modules.adsr_amp.release',     min: 0.01,  max: 15,    scale: 'log',    label: 'Amp Release' },
  { cc: 20, path: 'modules.adsr_filter.amount',   min: 0,     max: 1,     scale: 'linear', label: 'Filter Env Amt' },
  { cc: 21, path: 'modules.adsr_filter.attack',   min: 0.001, max: 8,     scale: 'log',    label: 'Filter Env Atk' },
  { cc: 22, path: 'modules.adsr_filter.decay',    min: 0.001, max: 8,     scale: 'log',    label: 'Filter Env Dec' },
  { cc: 17, path: 'modules.lfo.rate',             min: 0.01,  max: 20,    scale: 'log',    label: 'LFO Rate' },
  { cc: 18, path: 'modules.lfo.amount',           min: 0,     max: 2000,  scale: 'linear', label: 'LFO Amount' },
  { cc: 19, path: 'modules.lfo.enabled',          min: 0,     max: 1,     scale: 'bool',   label: 'LFO On' },
  { cc: 85, path: 'modules.vco_fm.ratio',         min: 0.5,   max: 16,    scale: 'linear', label: 'FM Ratio' },
  { cc: 86, path: 'modules.vco_fm.amount',        min: 0,     max: 1000,  scale: 'linear', label: 'FM Amount' },
  { cc: 87, path: 'modules.vco_fm.enabled',       min: 0,     max: 1,     scale: 'bool',   label: 'FM On' },
];

// Effect CC definitions — only included if that effect type is present in the synth
const EFFECT_DEFS = [
  { type: 'reverb',     cc: 88, param: 'size',     min: 0,    max: 1,    scale: 'linear', label: 'Reverb Size' },
  { type: 'reverb',     cc: 91, param: 'wet',      min: 0,    max: 1,    scale: 'linear', label: 'Reverb Wet' },
  { type: 'delay',      cc: 26, param: 'time',     min: 0.01, max: 2,    scale: 'log',    label: 'Delay Time' },
  { type: 'delay',      cc: 27, param: 'feedback', min: 0,    max: 0.95, scale: 'linear', label: 'Delay Fdbk' },
  { type: 'delay',      cc: 28, param: 'wet',      min: 0,    max: 1,    scale: 'linear', label: 'Delay Wet' },
  { type: 'chorus',     cc: 29, param: 'rate',     min: 0.1,  max: 8,    scale: 'log',    label: 'Chorus Rate' },
  { type: 'chorus',     cc: 30, param: 'depth',    min: 0,    max: 1,    scale: 'linear', label: 'Chorus Depth' },
  { type: 'chorus',     cc: 31, param: 'wet',      min: 0,    max: 1,    scale: 'linear', label: 'Chorus Wet' },
  { type: 'distortion', cc: 33, param: 'drive',    min: 0,    max: 1,    scale: 'linear', label: 'Dist Drive' },
  { type: 'phaser',     cc: 34, param: 'rate',     min: 0.1,  max: 8,    scale: 'log',    label: 'Phaser Rate' },
  { type: 'phaser',     cc: 35, param: 'depth',    min: 0,    max: 1,    scale: 'linear', label: 'Phaser Depth' },
  { type: 'phaser',     cc: 36, param: 'wet',      min: 0,    max: 1,    scale: 'linear', label: 'Phaser Wet' },
  { type: 'waveshaper', cc: 37, param: 'drive',    min: 0,    max: 1,    scale: 'linear', label: 'WaveShaper Drv' },
  { type: 'bitcrusher', cc: 38, param: 'bits',     min: 1,    max: 16,   scale: 'linear', label: 'Bitcrusher Bits' },
  { type: 'bitcrusher', cc: 39, param: 'wet',      min: 0,    max: 1,    scale: 'linear', label: 'Bitcrusher Wet' },
];

export function buildClankersMeta(state) {
  const effects = state.modules?.effects || [];

  // Resolve dot-notation path against state
  function getVal(path) {
    return path.split('.').reduce((o, k) => {
      if (o == null) return undefined;
      const n = Number(k);
      return isNaN(n) ? o[k] : o[n];
    }, state);
  }

  // Find the array index of an effect by type
  function effectIndex(type) {
    return effects.findIndex(e => e.type === type);
  }

  // Convert a value to CC 0–127
  function toCC(value, min, max, scale) {
    if (value == null || typeof value === 'boolean') {
      return value ? 127 : 0;
    }
    let norm;
    if (scale === 'log') {
      if (value <= 0 || min <= 0) return 0;
      norm = Math.log(value / min) / Math.log(max / min);
    } else if (scale === 'bool') {
      return value ? 127 : 0;
    } else {
      norm = (value - min) / (max - min);
    }
    return Math.max(0, Math.min(127, Math.round(norm * 127)));
  }

  const ccMap     = {};
  const defaultCC = {};

  // Base params
  for (const def of BASE_DEFS) {
    const value = getVal(def.path);
    if (value === undefined) continue;
    ccMap[String(def.cc)] = {
      path: def.path, min: def.min, max: def.max, scale: def.scale, label: def.label,
    };
    defaultCC[String(def.cc)] = toCC(value, def.min, def.max, def.scale);
  }

  // Effect params — only when that effect exists in the synth
  for (const def of EFFECT_DEFS) {
    const idx = effectIndex(def.type);
    if (idx === -1) continue;
    const path  = `modules.effects.${idx}.${def.param}`;
    const value = getVal(path);
    if (value === undefined) continue;
    ccMap[String(def.cc)] = {
      path, min: def.min, max: def.max, scale: def.scale, label: def.label,
    };
    defaultCC[String(def.cc)] = toCC(value, def.min, def.max, def.scale);
  }

  return { trackType: 7, ccMap, defaultCC };
}
