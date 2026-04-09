// POST /api/band/sheet-evolve
// Evolves the current Music Sheet into a new section.
// Stateless — full sheet sent by client.
const https = require('https');

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

Return ONLY valid JSON — the complete evolved sheet, same format as input.`;

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
    section,
    synth_context = '',
    apiKey,
    model = 'claude-haiku-4-5-20251001',
    provider = 'anthropic',
  } = req.body || {};

  if (!apiKey)  return res.status(401).json({ error: 'Missing apiKey' });
  if (!sheet)   return res.status(400).json({ error: 'Missing sheet' });
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

    const match = response.match(/\{[\s\S]*\}/s);
    if (!match) throw new Error('No JSON in response');

    const evolved = JSON.parse(match[0]);

    const tension = evolved.tension ?? 0.5;
    const reply = `Moving into ${section}. Tension ${Math.round(tension * 100)}%. BPM locked at ${evolved.bpm ?? '?'}.`;

    return res.status(200).json({ sheet: evolved, reply });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
