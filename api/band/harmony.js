// Harmony helper — picks a key, progression, and voicing style from a brief.
// Called before the LLM request to inject a short "HARMONIC CONTEXT" block.
// Goal: steer the LLM toward coherent tonal choices without bloating the system prompt.

const KEYS_MINOR = ['A minor', 'C minor', 'D minor', 'E minor', 'F minor', 'G minor', 'B minor'];
const KEYS_MAJOR = ['C major', 'D major', 'E major', 'F major', 'G major', 'A major', 'Bb major'];

// Progressions by feel — roman numerals, 4 bars each.
const PROGRESSIONS = {
  jazz:    ['ii7 - V7 - Imaj7 - VI7',      'Imaj7 - vi7 - ii7 - V7',   'iii7 - VI7 - ii7 - V7'],
  funk:    ['i7 - IV7',                     'i7 - bVII - IV - i',       'i - iv - bVII - bIII'],
  house:   ['i - bVII - bVI - bVII',        'i - v - bVI - bVII',       'Imaj7 - iii7 - vi7 - IV'],
  techno:  ['i - i - i - bVII',             'i - bVI - bIII - bVII',    'i - iv - i - v'],
  pop:     ['I - V - vi - IV',              'vi - IV - I - V',          'I - vi - IV - V'],
  minorPop:['i - VI - III - VII',           'i - VII - VI - VII',       'i - iv - VI - V'],
  ambient: ['Imaj7 - IVmaj7',               'i - bIII - bVII - IV',     'Imaj9 - vi9'],
  idm:     ['i - bII - i - bVII',           'i - bVI - bVII - iv',      'im7 - bIIIm7 - bVI - bVII'],
  lofi:    ['imaj7 - iv7 - bVII - bIIImaj7','ii7 - V7 - iii7 - vi7',   'imaj7 - VImaj7 - iimaj7 - Vmaj7'],
};

// Voicing hints by style.
const VOICINGS = {
  jazz:    'rootless shell voicings (3rd + 7th + extensions); avoid roots in pads — let bass imply them',
  funk:    'tight 7th/9th stabs; pads short; rhodes comps on off-beats',
  house:   'stacked thirds or sus2 pads; 4–5 note chords, wide spread',
  techno:  'minimal — 1–2 note pad drones, open fifths, avoid 3rds for ambiguity',
  pop:     'root-position triads with occasional 1st inversion; strong 3rds',
  minorPop:'root-position minor triads; add 7ths sparingly for color',
  ambient: 'wide 9th/11th voicings; slow pad changes; no stepwise motion',
  idm:     'close-voiced dissonance; chromatic passing tones; voice-lead by semitone',
  lofi:    'jazz-ish maj7/min9; top-note melody matters more than inner voices',
};

// Detect style from a free-text brief + section.
function detectStyle(brief = '', sectionStyle = '') {
  const t = ((brief || '') + ' ' + (sectionStyle || '')).toLowerCase();
  if (/jazz|bebop|bossa|swing/.test(t))              return 'jazz';
  if (/lo-?fi|lofi|chill ?hop|j ?dilla/.test(t))     return 'lofi';
  if (/funk|disco|groove|nu-?jazz/.test(t))          return 'funk';
  if (/house|deep house|garage/.test(t))             return 'house';
  if (/techno|detroit|minimal|acid/.test(t))         return 'techno';
  if (/idm|glitch|experimental|aphex|autechre/.test(t)) return 'idm';
  if (/ambient|drone|new ?age|cinematic/.test(t))    return 'ambient';
  if (/sad|dark|melancholy|nocturnal|gothic/.test(t))return 'minorPop';
  if (/pop|upbeat|happy|anthem/.test(t))             return 'pop';
  return 'minorPop'; // sensible default — most electronic music sits here
}

function pickFromSeed(arr, seed) {
  return arr[Math.abs(seed) % arr.length];
}

function hashString(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

// Map tension (0..1) to a harmonic-dissonance instruction.
function dissonanceFromTension(tension = 0.4) {
  if (tension < 0.35) return 'Stay diatonic. Triads and simple 7ths. Avoid chromaticism.';
  if (tension < 0.55) return 'Mostly diatonic with occasional secondary dominants or added 9ths. One borrowed chord is fine.';
  if (tension < 0.75) return 'Extended chords (9ths, 11ths). Secondary dominants welcome. One or two modal-interchange chords per phrase.';
  return 'Push harmonic tension: tritone subs, chromatic passing chords, unresolved extensions. Voice-lead by semitone. Resolve sparingly.';
}

/**
 * Build a short "HARMONIC CONTEXT" block for the LLM.
 * @param {object} opts
 * @param {string} [opts.brief]    Free-text user brief.
 * @param {string} [opts.section]  e.g. verse1, bridge, outro.
 * @param {number} [opts.tension]  0..1.
 * @param {number} [opts.energy]   0..1.
 * @param {string} [opts.existingKey]        If the sheet already has a key, keep it.
 * @param {string} [opts.existingProgression] Keep the progression for continuity mid-song.
 * @returns {string} multi-line context block, or empty string if nothing useful.
 */
function buildHarmonicContext(opts = {}) {
  const { brief = '', section = '', tension = 0.4, existingKey, existingProgression } = opts;

  const style = detectStyle(brief, section);
  const seed = hashString(brief + '|' + section);

  // If a key was already chosen upstream, keep it — continuity matters mid-song.
  const keyPool = style === 'pop' || /major|bright|happy|upbeat/i.test(brief) ? KEYS_MAJOR : KEYS_MINOR;
  const key = existingKey || pickFromSeed(keyPool, seed);

  const progression = existingProgression || pickFromSeed(PROGRESSIONS[style], seed >> 4);
  const voicing = VOICINGS[style];
  const dissonance = dissonanceFromTension(tension);

  return [
    'HARMONIC CONTEXT:',
    `  Key: ${key}`,
    `  Progression: ${progression} (style: ${style})`,
    `  Voicing: ${voicing}`,
    `  Dissonance: ${dissonance}`,
  ].join('\n');
}

module.exports = { buildHarmonicContext, detectStyle };
