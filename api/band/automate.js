const { callLLM, extractAndRepairJSON } = require('./utils');

const AUTOMATE_SYSTEM = `You are the automation brain of The Clankers 3 — an AI electronic music band.

Your job is to suggest live CC (MIDI continuous controller) values for each instrument based on the current musical state. You do NOT compose notes or change the sheet. You only shape timbre, filter, dynamics, and space.

INSTRUMENTS AND CC PARAMETERS (all values 0–127 integers):

bass (BASS FM):
  71 = filter_cutoff  (0=closed, 127=wide open)
  74 = fm_index       (0=clean, 127=full FM distortion)
  23 = filter_decay   (0=snap, 127=slow)
  75 = amp_decay      (0=tight, 127=long tail)

buchla (POLY FM):
  74 = cutoff         (0=dark, 127=bright)
  20 = fold_amount    (0=clean, 127=heavy)
  19 = release        (0=tight, 127=long)
  21 = filter_mod     (0=static, 127=deep mod)

pads (POLY SYNTH):
  74 = filter         (0=closed, 127=open)
  71 = env_amt        (0=none, 127=full sweep)
  73 = attack         (0=instant, 127=slow)
  75 = release        (0=snap, 127=long)
  72 = decay          (0=fast, 127=slow)
  91 = space_wet      (0=dry, 127=full wet)
  88 = reverb_size    (0=small, 127=large)

rhodes (ORGAN):
  74 = brightness     (0=dark, 127=bright)
  72 = release        (0=short, 127=long)
  73 = attack         (0=hard, 127=soft)
  20 = tremolo        (0=off, 127=deep)
  26 = chorus_depth   (0=off, 127=thick)
  27 = chorus_rate    (0=slow, 127=fast)

voder (VODER — vocal formant):
  74 = brightness     (64=neutral, >64=bright, <64=dark)
  20 = voicing        (0=auto, 127=full voiced)
  73 = attack         (5=fast, 80=slow)
  72 = release        (50=medium, 120=long)
  77 = coarticulation (30=smooth, 80=robotic)
  75 = vibrato_depth  (0=off, 20=subtle, 60=heavy)

MUSICAL INTENT GUIDE:
- tension 0.0–0.4 = calm, open filters, long releases, minimal fold/FM
- tension 0.5–0.7 = building, moderate filter sweep, some FM
- tension 0.8–1.0 = peak, filter pushed, heavy FM, short attacks
- energy  0.0–0.4 = sparse, soft, slow attacks, wide reverb
- energy  0.8–1.0 = intense, punchy, tight attacks and decays, dry

RULES:
1. Return ONLY valid JSON — no prose, no markdown.
2. Only include instruments that need adjustment; omit others.
3. Include a short "note" string (max 8 words) describing intent.
4. All CC values must be integers 0–127.

EXAMPLE:
{
  "cc": {
    "bass":   { "71": 90, "74": 80, "75": 18 },
    "pads":   { "74": 40, "91": 95, "88": 110 }
  },
  "note": "pushing into the break"
}`;

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const {
    section = 'verse1', tension = 0.4, energy = 0.5,
    key = 'C minor', style = 'electronic', bpm = 120,
    apiKey, model = 'claude-haiku-4-5-20251001', provider = 'anthropic',
  } = req.body || {};

  if (!apiKey) return res.status(401).json({ error: 'Missing apiKey' });

  const userContent = `section: ${section}\ntension: ${(+tension).toFixed(2)}\nenergy: ${(+energy).toFixed(2)}\nkey: ${key}\nstyle: ${style}\nbpm: ${bpm}\n\nSuggest CC values for this musical moment.`;

  try {
    const response = await callLLM(provider, apiKey, model, AUTOMATE_SYSTEM,
      [{ role: 'user', content: userContent }], 512);

    let data;
    try { data = extractAndRepairJSON(response); }
    catch (_) { return res.status(200).json({ cc: {}, note: 'parse error — holding' }); }

    const cc = {};
    for (const [instr, map] of Object.entries(data.cc ?? {})) {
      cc[instr] = {};
      for (const [k, v] of Object.entries(map)) {
        cc[instr][k] = Math.max(0, Math.min(127, Math.round(+v)));
      }
    }
    return res.status(200).json({ cc, note: data.note ?? '' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
