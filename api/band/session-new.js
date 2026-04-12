// POST /api/band/session-new
// Generates an opening Music Sheet JSON from a brief using Claude.
// Stateless — no session stored server-side; client owns the sheet.
const { callLLM, extractAndRepairJSON, normalizeSheet } = require('./utils');

const SHEET_SYSTEM = `You are The Clankers — an AI electronic music band. Given a brief, compose a complete opening section as a ClankerBoy JSON Music Sheet.

INSTRUMENTS (track IDs):
  t:1  Buchla 259/292   Percussive plucks/arps (MIDI 48–72)
  t:2  Pro-One Bass     Sub bass (MIDI 0–23 primarily)
  t:3  Rhodes EP        FM tine piano (MIDI 36–84), always use "dur" field
  t:6  HybridSynth Pads Chordal sustain — always include "dur" field
  t:10 Drums MS-20      Kick:36 Snare:38 HH_cl:42 HH_op:46

STEP RULES:
  - Drums (t:10): d always 0.25, never include "dur"
  - Pads (t:6) and Rhodes (t:3): always include "dur" (note duration in beats, e.g. 4.0 or 8.0)
  - Bass (t:2) first note per phrase must include full CC patch: {"71":42,"73":8,"75":50,"79":80,"72":22,"18":10}
  - Bass MIDI range primarily 0–23
  - ALWAYS generate 32–64 steps (2–4 bars at d:0.25) regardless of style or instrumentation
  - Even ambient/minimal styles MUST have 32+ steps — use sparse tracks, not fewer steps
  - NEVER output fewer than 32 steps

FX RACK (optional "fx" top-level key — include when the style needs it):
{
  "fx": {
    "delay":      { "on": true, "time": "1/8", "feedback": 0.5, "wet": 0.6, "lfo": "sine", "lfo_rate": 0.3, "lfo_depth": 0.003, "fb_shape": "soft", "hp": 120, "lp": 5000, "sc": "drum", "sc_depth": 0.85, "ret": 0.7, "sends": { "drum": 0, "bass": 0, "buchla": 0.8, "pads": 0.4, "rhodes": 0 } },
    "waveshaper": { "on": true, "type": "fold", "drive": 0.5, "tone": 3200, "wet": 0.5, "sc": null, "sc_depth": 0.7, "ret": 0.6, "sends": { "drum": 0, "bass": 0.8, "buchla": 0, "pads": 0, "rhodes": 0 } },
    "beatrepeat": { "slice": "1/16", "rate": 1.0, "decay": 0.9, "wet": 0.85, "sc": null, "sc_depth": 0.6, "ret": 0.75, "sends": { "drum": 0.6, "bass": 0, "buchla": 0, "pads": 0, "rhodes": 0 } }
  }
}

Return ONLY valid JSON — no prose, no markdown fences:
{
  "explanation": {
    "intent": "string",
    "style": "string",
    "timbre": "string",
    "section": "verse1",
    "energy": 0.42,
    "key": "string",
    "progression": "string",
    "rhythm": "string",
    "orchestration": "string"
  },
  "bpm": 120,
  "tension": 0.35,
  "steps": [
    { "d": 0.25, "tracks": [
        { "t": 10, "n": [36], "v": 100 },
        { "t": 2, "n": [6], "v": 110, "cc": {"71":42,"73":8,"75":50,"79":80,"72":22,"18":10} },
        { "t": 6, "n": [57, 64], "v": 52, "dur": 8.0 },
        { "t": 3, "n": [57], "v": 62, "dur": 4.0 }
    ]},
    ...more steps...
  ]
}`;

const SECTION_TENSION = { verse1: 0.35, verse2: 0.45, bridge: 0.60, outro: 0.50 };

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { brief, section = 'verse1', solo = true, apiKey, model = 'claude-haiku-4-5-20251001', provider = 'anthropic' } = req.body || {};
  if (!apiKey) return res.status(401).json({ error: 'Missing apiKey' });
  if (!brief) return res.status(400).json({ error: 'Missing brief' });

  try {
    if (!solo) {
      // Two-pass: Bassist proposes → Conductor refines
      const bassistReply = await callLLM(provider, apiKey, model,
        SHEET_SYSTEM,
        [{ role: 'user', content: `Brief: ${brief}\nSection: ${section}\n\nYou are The Bassist. Propose an opening Music Sheet that serves the groove. Output the full JSON.` }],
        8192,
      );
      const transcript = [{ role: 'The Bassist', content: bassistReply.slice(0, 300).replace(/\{[\s\S]*/s, '').trim() || 'Here\'s my take on the groove...' }];

      const conductorReply = await callLLM(provider, apiKey, model,
        SHEET_SYSTEM,
        [
          { role: 'user', content: `Brief: ${brief}\nSection: ${section}\n\nYou are The Bassist. Propose an opening Music Sheet that serves the groove. Output the full JSON.` },
          { role: 'assistant', content: bassistReply },
          { role: 'user', content: 'You are the Conductor. Refine this into the final definitive Music Sheet. Output ONLY the final JSON.' },
        ],
        8192,
      );

      let sheet;
      try {
        sheet = extractAndRepairJSON(conductorReply);
      } catch (err) {
        throw new Error('Failed to parse conductor JSON');
      }
      if (!sheet.tension) sheet.tension = SECTION_TENSION[section] ?? 0.35;
      normalizeSheet(sheet);

      return res.status(200).json({ sheet, messages: transcript });

    } else {
      // Solo mode: single pass
      const response = await callLLM(provider, apiKey, model,
        SHEET_SYSTEM,
        [{ role: 'user', content: `Brief: ${brief}\nSection: ${section}\n\nGenerate the opening ClankerBoy JSON Music Sheet.` }],
        8192,
      );

      let sheet;
      try {
        sheet = extractAndRepairJSON(response);
      } catch (err) {
        throw new Error('Failed to parse generation JSON');
      }
      if (!sheet.tension) sheet.tension = SECTION_TENSION[section] ?? 0.35;
      normalizeSheet(sheet);

      return res.status(200).json({ sheet, messages: [] });
    }
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
