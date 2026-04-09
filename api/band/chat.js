// POST /api/band/chat
// Routes a user message to the band, updates the Music Sheet, returns companion reply.
// Stateless — full sheet and last N history messages are sent by the client.
const https = require('https');

const CONDUCTOR_SYSTEM = `You are the Conductor of The Clankers 3 -- an AI electronic music band.

The band has four companion personas:
  The Bassist  -- warm, dry, musical. Talks about feel and groove.
  The Drummer  -- terse, rhythmic. Talks about energy and patterns.
  Keys         -- harmonic, opinionated. Talks about textures and progressions.
  Conductor    -- orchestrates; listens to user intent. Formal but warm.

INSTRUMENTS (track IDs):
  t:1  Buchla 259/292   Percussive plucks/arps (MIDI 48-72)
  t:2  Pro-One Bass     Sub bass (MIDI 0-23 primarily)
  t:3  Rhodes EP        FM tine piano (MIDI 36-84), use dur
  t:6  HybridSynth Pads Chordal sustain — always include dur field
  t:10 Drums MS-20      Kick:36 Snare:38 HH_cl:42 HH_op:46

FX RACK (optional top-level "fx" key — include when the style needs it):
{
  "fx": {
    "delay":      { "on": true,  "time": "1/8", "feedback": 0.5, "wet": 0.6, "lfo": "sine", "lfo_rate": 0.3, "lfo_depth": 0.003, "fb_shape": "soft", "hp": 120, "lp": 5000, "sc": "drum", "sc_depth": 0.85, "ret": 0.7, "sends": { "drum": 0, "bass": 0, "buchla": 0.8, "pads": 0.4, "rhodes": 0 } },
    "waveshaper": { "on": true,  "type": "fold", "drive": 0.5, "tone": 3200, "wet": 0.5, "sc": null, "sc_depth": 0.7, "ret": 0.6, "sends": { "drum": 0, "bass": 0.8, "buchla": 0, "pads": 0, "rhodes": 0 } },
    "beatrepeat": { "slice": "1/16", "rate": 1.0, "decay": 0.9, "wet": 0.85, "sc": null, "sc_depth": 0.6, "ret": 0.75, "sends": { "drum": 0.6, "bass": 0, "buchla": 0, "pads": 0, "rhodes": 0 } }
  }
}
FX tips: IDM/Dubstep → buchla→delay 0.8, bass→waveshaper fold 0.8, drums→beatrepeat 0.6.
         Sidechain delay to drum (sc:"drum", sc_depth:0.85) for pumping tails.

You receive the current ClankerBoy JSON sheet and a user message.
1. Pick the companion best suited to respond.
2. Update the sheet's steps array to reflect the user's request.
   You may change BPM, add/remove/modify steps, adjust CC values, swap notes.
   Include or update the "fx" key when the user asks for FX changes.
3. Write a short in-character reply from that companion (1-3 sentences max).

RULES when editing steps:
  - Drums (t:10) always d:0.25, never use dur.
  - Pads (t:6) and Rhodes (t:3) always use dur.
  - Bass first note per phrase needs full CC patch: {"71":42,"73":8,"75":50,"79":80,"72":22,"18":10}
  - Bass MIDI 0-23 primarily.
  - The steps array MUST contain at least 32 steps (2 bars). Sparse music = fewer tracks per step, NOT fewer steps.

Return ONLY valid JSON -- no prose, no markdown fences:
{
  "companion": "The Bassist",
  "reply": "Short in-character reply.",
  "sheet": { ...complete updated ClankerBoy JSON sheet... }
}`;

function callLLM(provider, apiKey, model, system, messages, maxTokens) {
  const m = model || '';
  const p = (m.startsWith('gpt') || m.startsWith('o1') || m.startsWith('o3'))
    ? 'openai'
    : (provider || 'anthropic');
  if (p === 'openai') return callOpenAI(apiKey, model, system, messages, maxTokens);
  return callAnthropic(apiKey, model, system, messages, maxTokens);
}

function callAnthropic(apiKey, model, system, messages, maxTokens) {
  const payload = JSON.stringify({ model, max_tokens: maxTokens, system, messages });
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.anthropic.com',
      path:     '/v1/messages',
      method:   'POST',
      headers: {
        'x-api-key':         apiKey,
        'anthropic-version': '2023-06-01',
        'content-type':      'application/json',
        'content-length':    Buffer.byteLength(payload),
      },
    }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode !== 200) {
            reject(new Error(parsed.error?.message || `Anthropic ${res.statusCode}`));
          } else {
            resolve(parsed.content[0].text);
          }
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function callOpenAI(apiKey, model, system, messages, maxTokens) {
  const openaiMsgs = system ? [{ role: 'system', content: system }, ...messages] : messages;
  const payload = JSON.stringify({ model, max_tokens: maxTokens, messages: openaiMsgs });
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.openai.com',
      path:     '/v1/chat/completions',
      method:   'POST',
      headers: {
        'Authorization':  `Bearer ${apiKey}`,
        'content-type':   'application/json',
        'content-length': Buffer.byteLength(payload),
      },
    }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode !== 200) {
            reject(new Error(parsed.error?.message || `OpenAI ${res.statusCode}`));
          } else {
            resolve(parsed.choices[0].message.content);
          }
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const {
    sheet,
    history = [],
    message,
    synth_context = '',
    apiKey,
    model = 'claude-haiku-4-5-20251001',
    provider = 'anthropic',
  } = req.body || {};

  if (!apiKey)  return res.status(401).json({ error: 'Missing apiKey' });
  if (!sheet)   return res.status(400).json({ error: 'Missing sheet' });
  if (!message) return res.status(400).json({ error: 'Missing message' });

  // Build context from recent history
  const ctx = history.slice(-4).map(h => `[${h.role}]: ${h.content}`).join('\n');

  const userContent = [
    `Current sheet:\n${JSON.stringify(sheet, null, 2)}`,
    ctx ? `Recent chat:\n${ctx}` : '',
    synth_context || '',
    `User message: ${message}`,
    'Return the updated sheet + companion reply as JSON.',
  ].filter(Boolean).join('\n\n');

  try {
    const response = await callLLM(
      provider, apiKey, model, CONDUCTOR_SYSTEM,
      [{ role: 'user', content: userContent }],
      8192,
    );

    const match = response.match(/\{[\s\S]*\}/s);
    if (!match) {
      // Fallback: return original sheet with raw reply
      return res.status(200).json({
        sheet,
        diff: {},
        reply: response.slice(0, 500),
        companion: 'Conductor',
      });
    }

    const data = JSON.parse(match[0]);
    const updatedSheet = data.sheet || sheet;

    // Ensure minimum step count for playable loop
    if (updatedSheet.steps && updatedSheet.steps.length < 16) {
      while (updatedSheet.steps.length < 64) updatedSheet.steps.push({ d: 0.25, tracks: [] });
    }

    // Compute diff: top-level keys that changed
    const diff = {};
    for (const k of new Set([...Object.keys(sheet), ...Object.keys(updatedSheet)])) {
      if (JSON.stringify(sheet[k]) !== JSON.stringify(updatedSheet[k])) {
        diff[k] = updatedSheet[k];
      }
    }

    return res.status(200).json({
      sheet:     updatedSheet,
      diff,
      reply:     data.reply || '',
      companion: data.companion || 'Conductor',
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
