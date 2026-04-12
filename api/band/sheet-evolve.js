// POST /api/band/sheet-evolve
// Evolves the current Music Sheet into a new section.
// Stateless — full sheet sent by client.
const { callLLM, extractAndRepairJSON, normalizeSheet } = require('./utils');

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
  - Update explanation.section to the new section name
  - Adjust bpm (±5 max), tension, energy to match the section guide above
  - Meaningfully change the pattern: vary note choices, rhythm density, velocities, CC sweeps
  - Add or remove layers (e.g. bring in buchla on verse2, strip bass on bridge)
  - Preserve the key and genre unless the section demands a shift
  - Keep MIDI ranges: Drums t:10 d:0.25 no-dur; Pads t:6 + Rhodes t:3 always use dur; Bass MIDI 0–23
  - Bass first note per phrase: CC {"71":42,"73":8,"75":50,"79":80,"72":22,"18":10}
  - Output 128 steps (8 bars) at d:0.25 unless the input sheet uses a different length

DRUM RICHNESS — mandatory in every section:
  Drum map: Kick:36 Snare:38 HH Cl:42 HH Op:46 Tom L:41 Tom M:45 Clap:48
  Ghost notes = snare 38 at v:28–50. HH Closed: vary velocity every step (v:45–80), drop hits.
  Displaced snare: shift ±1 step from 2&4 sometimes. Drop expected kicks for groove.
  Vary ALL velocities — kick v:100–115, snare v:70–95, hats v:45–80. Never flat.
  If a drum pattern looks metronomically perfect, it is wrong. Break it.

Return ONLY valid JSON — the complete evolved sheet, same format as input.`;

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const {
    sheet,
    section,
    synth_context = '',
    apiKey,
    model = 'claude-haiku-4-5-20251001',
    provider = 'anthropic',
  } = req.body || {};

  if (!apiKey) return res.status(401).json({ error: 'Missing apiKey' });
  if (!sheet) return res.status(400).json({ error: 'Missing sheet' });
  if (!section) return res.status(400).json({ error: 'Missing section' });

  const userContent = [
    `Current sheet:\n${JSON.stringify(sheet, null, 2)}`,
    synth_context || '',
    `Evolve this sheet for section: "${section}". Output the full evolved JSON sheet.`,
  ].filter(Boolean).join('\n\n');

  try {
    const response = await callLLM(
      provider, apiKey, model, EVOLVE_SYSTEM,
      [{ role: 'user', content: userContent }],
      8192,
    );

    let evolved;
    try {
      evolved = extractAndRepairJSON(response);
    } catch (e) {
      console.error('Failed to parse evolve JSON:', e.message);
      evolved = JSON.parse(JSON.stringify(sheet)); // fallback to unmutated sheet
    }

    normalizeSheet(evolved);

    const tension = evolved.tension ?? 0.5;
    const reply = `Moving into ${section}. Tension ${Math.round(tension * 100)}%. BPM locked at ${evolved.bpm ?? '?'}.`;

    return res.status(200).json({ sheet: evolved, reply });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
