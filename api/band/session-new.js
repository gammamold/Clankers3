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
  t:10 Drums MS-20      Kick:36  Snare:38  HH Cl:42  HH Op:46  Tom L:41  Tom M:45  Clap:48

STEP COUNT — GOLDEN RULE:
  128 steps at d:0.25 = 8 bars. This is the canonical composition size.
  Always output exactly 128 steps unless the user specifies a different bar count.
  Use { "d": 0.25, "tracks": [] } for silent steps — silence IS the groove. Never shorten the array.

DRUM RULES:
  - Drums always d:0.25. NEVER use "dur" on drums.
  - Kick (36): anchor. Place on beats 1 and 3 for house/funk. Drop expected hits for feel.
  - Snare (38): primary on beats 2 and 4. Ghost notes = snare 38 at v:28–50. Displace ±1 step for Dilla feel.
  - HH Closed (42): groove engine. Vary velocity every step (v:45–80). Drop hits. Add extras. Never machine-gun uniform.
  - HH Open (46): accents and transitions — sparingly, not every bar.
  - Tom L (41): fills and accents. Not every bar.
  - Tom M (45): fills. Use at section transitions.
  - Clap (48): layers with or replaces snare — never both at full velocity same step.

DILLA / HUMAN FEEL — mandatory for all styles:
  1. Velocity spread — wide and intentional. Kick: v:100–115. Snare: v:70–95. Ghost: v:28–50. HH: v:45–80, vary every step.
  2. Ghost density — low-velocity snare (38) on unexpected 16ths away from the grid anchor.
  3. Displaced snare — shift a 16th early or late sometimes. Skip it entirely sometimes.
  4. Drop kicks — silence where the kick "should" be is feel. tracks:[] is music.
  5. HH variation — never flat uniform hats. Mix velocities, drop a hit, add an extra.
  6. Kick clusters — occasional double kick on two adjacent 16ths at different velocities (v:105 then v:78).
  If a drum pattern looks metronomically perfect, it is wrong. Break it.

STYLE RECIPES:
  FUNK/GROOVE: BPM 95–120. Dense closed hats, ghost snares on unexpected 16ths, syncopated kick, bass walks the root with passing tones. Pads/Rhodes hold whole-bar chords.
  HOUSE: BPM 120–128. 4-on-floor kick, clap(48) on 2&4, HH(42) on every 8th, HH open(46) on upbeats. Bass: root notes with occasional 16th approach.
  DETROIT TECHNO: BPM 125–135. 4-on-floor kick, sparse clap(48), rolling 16th HH with velocity drops. Bass: repetitive minimal riff, CC sweep implied.
  LO-FI: BPM 75–95. Kick + snare only, 30–40% empty steps, pads dur:16+, slow rhodes melody, Dilla feel essential.
  IDM: BPM 140–170. Displaced kicks, irregular HH, ghost notes everywhere, Buchla percussive plucks, pads change chord per 4 bars.
  AMBIENT: BPM 80–100. Minimal or no drums. Long pad sustains (dur:16+), sparse Rhodes, Buchla textures.

BASS RULES:
  - Bass (t:2) first note per phrase must include full CC patch: {"71":42,"73":8,"75":50,"79":80,"72":22,"18":10}
  - Subsequent bass notes: only per-note CCs if needed (e.g. {"74":50,"23":26})
  - MIDI 0–23 primarily. Max 24 for fills.
  - Use "dur" on bass notes to sustain across steps.

PADS & RHODES:
  - Pads (t:6) and Rhodes (t:3): ALWAYS include "dur". One trigger, long hold.
  - Pads: trigger once per chord, dur:4.0–16.0. Change chord every 2–4 bars.
  - Rhodes: melodic phrases, dur:0.5–4.0 per note.

BUCHLA (t:1):
  - Percussive plucks and arps. Short notes. MIDI 48–72.
  - Use for rhythmic top-line texture, not chord pads.

FX RACK (optional "fx" top-level key — include when style needs it):
{
  "fx": {
    "delay":      { "on": true, "time": "1/8", "feedback": 0.5, "wet": 0.6, "lfo": "sine", "lfo_rate": 0.3, "lfo_depth": 0.003, "fb_shape": "soft", "hp": 120, "lp": 5000, "sc": "drum", "sc_depth": 0.85, "ret": 0.7, "sends": { "drum": 0, "bass": 0, "buchla": 0.8, "pads": 0.4, "rhodes": 0 } },
    "waveshaper": { "on": true, "type": "fold", "drive": 0.5, "tone": 3200, "wet": 0.5, "sc": null, "sc_depth": 0.7, "ret": 0.6, "sends": { "drum": 0, "bass": 0.8, "buchla": 0, "pads": 0, "rhodes": 0 } },
    "beatrepeat": { "slice": "1/16", "rate": 1.0, "decay": 0.9, "wet": 0.85, "sc": null, "sc_depth": 0.6, "ret": 0.75, "sends": { "drum": 0.6, "bass": 0, "buchla": 0, "pads": 0, "rhodes": 0 } }
  }
}

CRITICAL RULES:
  1. Drums always d:0.25. Never use dur on drums.
  2. Pads always use dur. One trigger, long hold.
  3. tracks:[] silent steps are not waste — they are the groove.
  4. No machine-gun 16ths on bass or chords above 100 BPM.
  5. Vary velocities — never flat. 75–110 range, different every step.
  6. JSON only — no prose, no markdown fences, no comments.
  7. 128 steps at d:0.25 = 8 bars. Always hit this target unless user specifies otherwise.

Return ONLY valid JSON — no prose, no markdown fences:
{
  "explanation": {
    "intent": "string",
    "style": "string",
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
        { "t": 10, "n": [36], "v": 108 },
        { "t": 2, "n": [6], "v": 100, "dur": 1.0, "cc": {"71":42,"73":8,"75":50,"79":80,"72":22,"18":10} },
        { "t": 6, "n": [57, 64, 67], "v": 58, "dur": 8.0 },
        { "t": 3, "n": [57], "v": 65, "dur": 4.0 }
    ]},
    { "d": 0.25, "tracks": [ { "t": 10, "n": [42], "v": 62 } ] },
    { "d": 0.25, "tracks": [ { "t": 10, "n": [38], "v": 38 } ] },
    { "d": 0.25, "tracks": [ { "t": 10, "n": [42], "v": 74 } ] },
    ...125 more steps...
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
