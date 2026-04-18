// POST /api/band/sheet-evolve
// Evolves the current Music Sheet into a new section.
// Stateless — full sheet sent by client.
const { callLLM, extractAndRepairJSON, normalizeSheet } = require('./utils');
const { buildHarmonicContext } = require('./harmony');

const EVOLVE_SYSTEM = `You are the Conductor of The Clankers 3 — an AI electronic music band.
You will receive a Music Sheet and a target section name. Evolve the sheet for that new section.

SECTION TENSION & ENERGY GUIDE:
  verse1:       tension 0.30–0.40  energy 0.35–0.50  (intro, sparse, building)
  instrumental: tension 0.40–0.50  energy 0.50–0.65  (full groove, no breakdown)
  verse2:       tension 0.45–0.55  energy 0.55–0.70  (full groove, more elements)
  bridge:       tension 0.55–0.70  energy 0.60–0.75  (breakdown or tension peak, strip back or add intensity)
  verse3:       tension 0.45–0.55  energy 0.65–0.80  (return with extra energy)
  outro:        tension 0.35–0.50  energy 0.35–0.55  (resolution, elements drop out)

EVOLUTION RULES:
  - Update explanation.section to the new section name (REQUIRED — must match the requested section exactly)
  - Keep bpm IDENTICAL to the input sheet — do NOT change it
  - Adjust tension, energy to match the section guide above
  - Meaningfully change the pattern: vary note choices, rhythm density, velocities, CC sweeps
  - Add or remove layers (e.g. bring in POLY FM on verse2, strip BASS FM on bridge)
  - Preserve the key and genre unless the section demands a shift
  - Keep MIDI ranges: DRUMS t:10 d:0.25 no-dur; POLY SYNTH t:6 + ORGAN t:3 + VODER t:5 always use dur; BASS FM MIDI 0–23; VODER MIDI 36–84
  - ACCENT: add "a":1 on any track for emphasis (velocity × 1.3). Use sparingly — downbeat kick, stabbed chord, peak snare. Omit or 0 for normal steps.
  - VODER t:5 always includes dur and one of: "lyric" (plain English, preferred) or "ph" (phoneme index array). Default CC: {"74":64,"73":5,"72":50,"77":30,"75":20,"76":64,"20":0}
  - BASS FM first note per phrase: CC {"71":42,"73":8,"75":50,"79":80,"72":22,"18":10}
  - Output 128 steps (8 bars) at d:0.25 unless the input sheet uses a different length

DRUM RICHNESS — mandatory in every section:
  Drum map: Kick:36 Snare:38 HH Cl:42 HH Op:46 Tom L:41 Tom M:45 Clap:48
  Ghost notes = snare 38 at v:28–50. HH Closed: vary velocity every step (v:45–80), drop hits.
  Displaced snare: shift ±1 step from 2&4 sometimes. Drop expected kicks for groove.
  Vary ALL velocities — kick v:100–115, snare v:70–95, hats v:45–80. Never flat.
  If a drum pattern looks metronomically perfect, it is wrong. Break it.

VODER (t:5) — SINGING:
  Preferred: "lyric" field with plain English — engine converts to phonemes, e.g. { "t":5, "n":[60], "dur":2, "lyric":"sing it" }.
  Precise: "ph" field — array of phoneme indices spread evenly over "dur".
  Always include "dur". If both provided, "ph" wins.
  Phonemes: 0:AA 1:AE 2:AH 3:AO 4:EH 5:ER 6:EY 7:IH 8:IY 9:OW 10:UH 11:UW
            12:L 13:R 14:W 15:Y 16:M 17:N  18:F 19:S 20:SH 21:TH  22:V 23:Z 24:ZH
  CC: 74=brightness(64=neutral) 73=attack 72=release 77=coartic(30=smooth,80=robotic) 75=vibrato_depth 76=vibrato_rate 20=voicing(0=auto)
  Example: { "t":5, "n":[60], "v":80, "dur":4, "ph":[2,16], "cc":{"74":64,"73":5,"72":50,"77":30,"75":20,"76":64,"20":0} }

Return ONLY valid JSON — the complete evolved sheet, same format as input.`;

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const {
    sheet,
    section,
    hint = '',
    synth_context = '',
    apiKey,
    model = 'claude-haiku-4-5-20251001',
    provider = 'anthropic',
  } = req.body || {};

  if (!apiKey) return res.status(401).json({ error: 'Missing apiKey' });
  if (!sheet) return res.status(400).json({ error: 'Missing sheet' });
  if (!section) return res.status(400).json({ error: 'Missing section' });

  const prevSection = sheet.explanation?.section ?? 'previous section';
  const SECTION_TENSION = { verse1: 0.35, verse2: 0.45, bridge: 0.60, outro: 0.50, instrumental: 0.45, verse3: 0.50 };
  const harmony = buildHarmonicContext({
    brief: hint || sheet.explanation?.intent || sheet.explanation?.style || '',
    section,
    tension: SECTION_TENSION[section] ?? sheet.tension ?? 0.45,
    existingKey: sheet.explanation?.key,
    existingProgression: sheet.explanation?.progression,
  });
  const userContent = [
    `TARGET SECTION: ${section}`,
    hint ? `SPECIAL REQUEST FROM USER: ${hint}` : '',
    harmony,
    `Current sheet (previous section: ${prevSection}):\n${JSON.stringify(sheet, null, 2)}`,
    synth_context || '',
    `Generate a FULL EVOLVED SHEET for "${section}". This must sound distinctly different from the ${prevSection} above — different rhythmic density, pattern structure, and arrangement. Set explanation.section to "${section}". Output valid JSON only.`,
  ].filter(Boolean).join('\n\n');

  try {
    const response = await callLLM(
      provider, apiKey, model, EVOLVE_SYSTEM,
      [{ role: 'user', content: userContent }],
      32768,
    );

    let evolved;
    try {
      evolved = extractAndRepairJSON(response);
    } catch (e) {
      console.error('Failed to parse evolve JSON:', e.message);
      evolved = JSON.parse(JSON.stringify(sheet)); // fallback to unmutated sheet
    }

    normalizeSheet(evolved);

    // Always restore original BPM — evolve must never drift tempo
    evolved.bpm = sheet.bpm;

    // Force correct section metadata regardless of LLM compliance
    if (evolved.explanation) {
      evolved.explanation.section = section;
    } else {
      evolved.explanation = { section };
    }

    const tension = evolved.tension ?? 0.5;
    const reply = `Moving into ${section}. Tension ${Math.round(tension * 100)}%. BPM ${evolved.bpm ?? '?'}.`;

    return res.status(200).json({ sheet: evolved, reply });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
