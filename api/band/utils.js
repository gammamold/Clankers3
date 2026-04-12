// Shared LLM helpers and sheet normalization for api/band handlers.
const https = require('https');

function callLLM(provider, apiKey, model, system, messages, maxTokens) {
  const m = model || '';
  let p = provider || 'anthropic';
  if (m.startsWith('gpt') || m.startsWith('o1') || m.startsWith('o3')) p = 'openai';
  else if (m.startsWith('gemini')) p = 'google';
  if (p === 'openai') return callOpenAI(apiKey, model, system, messages, maxTokens);
  if (p === 'google') return callGemini(apiKey, model, system, messages, maxTokens);
  return callAnthropic(apiKey, model, system, messages, maxTokens);
}

function callAnthropic(apiKey, model, system, messages, maxTokens) {
  const payload = JSON.stringify({ model, max_tokens: maxTokens, system, messages });
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
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
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'content-type': 'application/json',
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

function callGemini(apiKey, model, system, messages, maxTokens) {
  // Convert Anthropic-style messages to Gemini contents (role: user/model)
  const contents = messages.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));
  const body = { contents, generationConfig: { maxOutputTokens: maxTokens } };
  if (system) body.system_instruction = { parts: [{ text: system }] };
  const payload = JSON.stringify(body);
  const path = `/v1beta/models/${model}:generateContent?key=${apiKey}`;
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'generativelanguage.googleapis.com',
      path,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
      },
    }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode !== 200) {
            reject(new Error(parsed.error?.message || `Gemini ${res.statusCode}`));
          } else {
            resolve(parsed.candidates[0].content.parts[0].text);
          }
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function extractAndRepairJSON(response) {
  const match = response.match(/\{[\s\S]*\}/s);
  if (!match) throw new Error('No JSON in response');
  let s = match[0].trim();
  if (s.endsWith(',')) s = s.slice(0, -1);
  try { return JSON.parse(s); } catch (e) { }

  let braces = 0, brackets = 0, inStr = false, esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (!inStr) {
      if (c === '{') braces++;
      if (c === '}') braces--;
      if (c === '[') brackets++;
      if (c === ']') brackets--;
    }
  }
  while (brackets > 0) { s += ']'; brackets--; }
  while (braces > 0) { s += '}'; braces--; }
  return JSON.parse(s);
}

// Canonical sheet normalization:
//   - Forces d:0.25 on every step (uniform 16th-note grid)
//   - Pads to the next whole-bar boundary (multiples of 16 steps)
//   - Minimum 32 steps (2 bars), maximum 128 steps (8 bars)
function normalizeSheet(sheet) {
  if (!sheet || !Array.isArray(sheet.steps) || !sheet.steps.length) return;
  for (const step of sheet.steps) step.d = 0.25;
  const len = sheet.steps.length;
  const targetBars = Math.min(8, Math.max(2, Math.ceil(len / 16)));
  const target = targetBars * 16;
  while (sheet.steps.length < target) sheet.steps.push({ d: 0.25, tracks: [] });
  if (sheet.steps.length > 128) sheet.steps.length = 128;
}

module.exports = { callLLM, extractAndRepairJSON, normalizeSheet };
