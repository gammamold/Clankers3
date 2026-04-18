// Shared LLM helpers and sheet normalization for api/band handlers.
const https = require('https');

function callLLM(provider, apiKey, model, system, messages, maxTokens) {
  const m = model || '';
  let p = provider || 'anthropic';
  if (m.startsWith('gpt') || m.startsWith('o1') || m.startsWith('o3')) p = 'openai';
  else if (m.startsWith('gemini')) p = 'google';
  else if (m.toLowerCase().startsWith('minimax')) p = 'minimax';
  if (p === 'openai') return callOpenAI(apiKey, model, system, messages, maxTokens);
  if (p === 'google') return callGemini(apiKey, model, system, messages, maxTokens);
  if (p === 'minimax') return callMinimax(apiKey, model, system, messages, maxTokens);
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
  const m = model || '';
  // o1/o3 reasoning models: no system role, use max_completion_tokens
  const isReasoning = m.startsWith('o1') || m.startsWith('o3');

  let openaiMsgs;
  if (isReasoning) {
    // Fold system prompt into the first user message (reasoning models reject system role)
    const [first, ...rest] = messages;
    openaiMsgs = system && first
      ? [{ role: first.role || 'user', content: `${system}\n\n${first.content}` }, ...rest]
      : messages;
  } else {
    openaiMsgs = system ? [{ role: 'system', content: system }, ...messages] : messages;
  }

  const body = { model, messages: openaiMsgs };
  if (isReasoning) body.max_completion_tokens = maxTokens;
  else body.max_tokens = maxTokens;

  // Enable JSON mode when supported — guarantees valid JSON output
  // Supported on gpt-4o*, gpt-4-turbo*, gpt-3.5-turbo, o1 (2024-12+), o3-mini
  if (m.startsWith('gpt-4') || m.startsWith('gpt-3.5') || m === 'o1' || m.startsWith('o3')) {
    body.response_format = { type: 'json_object' };
  }

  const payload = JSON.stringify(body);
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
            const content = parsed.choices?.[0]?.message?.content;
            if (content == null) {
              const finish = parsed.choices?.[0]?.finish_reason;
              reject(new Error(`OpenAI returned no content${finish ? ` (finish_reason: ${finish})` : ''}`));
            } else {
              resolve(content);
            }
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

function callMinimax(apiKey, model, system, messages, maxTokens) {
  // MiniMax exposes an OpenAI-compatible chat completions endpoint.
  const mmMsgs = system ? [{ role: 'system', content: system }, ...messages] : messages;
  const payload = JSON.stringify({ model, messages: mmMsgs, max_tokens: maxTokens });
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.minimax.io',
      path: '/v1/text/chatcompletion_v2',
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
            reject(new Error(parsed.error?.message || parsed.base_resp?.status_msg || `MiniMax ${res.statusCode}`));
          } else {
            const content = parsed.choices?.[0]?.message?.content;
            if (content == null) reject(new Error('MiniMax returned no content'));
            else resolve(content);
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
  if (typeof response !== 'string' || !response) throw new Error('Empty LLM response');

  // Strip common markdown code fences (```json ... ``` or ``` ... ```)
  let text = response.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '');

  const start = text.indexOf('{');
  if (start === -1) throw new Error('No JSON object in response');

  // Find outermost closing brace by scanning (not greedy regex)
  let depth = 0, inStr = false, esc = false, end = -1;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (esc)        { esc = false; continue; }
    if (c === '\\') { esc = true;  continue; }
    if (c === '"')  { inStr = !inStr; continue; }
    if (!inStr) {
      if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
  }

  const s = end >= 0 ? text.slice(start, end + 1) : text.slice(start);

  // Attempt 1: parse as-is
  try { return JSON.parse(s); } catch (_) { /* fall through */ }

  // Attempt 2: strip trailing commas before ] or } (common LLM mistake)
  try { return JSON.parse(s.replace(/,(\s*[\]}])/g, '$1')); } catch (_) { /* fall through */ }

  // Attempt 3: rebuild closing sequence. Walk forward tracking depth + string state,
  // then truncate back to a safe boundary (after a closed brace/bracket) and append
  // the needed closers for still-open structures.
  const stack = [];          // all '{'/'[' seen in order (true=object, false=array)
  let cutIdx = -1;           // position immediately after last closed brace/bracket
  let stackLenAtCut = 0;     // stack length at that point
  inStr = false; esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (esc)        { esc = false; continue; }
    if (c === '\\') { esc = true;  continue; }
    if (c === '"')  { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '{') stack.push(true);
    else if (c === '[') stack.push(false);
    else if (c === '}' || c === ']') {
      stack.pop();
      // Safe: we just completed a value. Next valid token is ',' or another closer.
      cutIdx = i + 1;
      stackLenAtCut = stack.length;
    }
  }

  // If no closed structures yet but we have open ones, try treating the whole
  // slice as the candidate — the trailing-cruft stripper + closers may fix it.
  if (cutIdx < 0) {
    if (!stack.length) throw new Error('Malformed JSON: no complete values found');
    cutIdx = s.length;
    stackLenAtCut = stack.length;
  }

  let t = s.slice(0, cutIdx).trimEnd();
  // Strip trailing structural cruft: commas, colons, whitespace, and partial tokens
  // that aren't valid value endings (bare keys, half-numbers).
  while (t.length && /[,:\s]$/.test(t)) t = t.slice(0, -1).trimEnd();

  // If we trimmed back to a point inside a partial key/value, walk back further.
  // A safe end point: a digit, a closing } or ], a closing ", or true/false/null.
  const safeTail = /[}\]"0-9]$|true$|false$|null$/;
  while (t.length && !safeTail.test(t)) {
    // Drop one char and re-trim whitespace/commas
    t = t.slice(0, -1).trimEnd();
    while (t.length && /[,:\s]$/.test(t)) t = t.slice(0, -1).trimEnd();
  }

  // Close any remaining open structures
  const closers = stack.slice(0, stackLenAtCut)
    .map(isObj => isObj ? '}' : ']')
    .reverse()
    .join('');
  let repaired = t + closers;

  try { return JSON.parse(repaired); } catch (_) { /* one more pass */ }

  // Final fallback: strip any trailing incomplete property from each trailing
  // object/array (covers ,"key" or ,"key": or a dangling key with no value).
  for (let i = 0; i < 8; i++) {
    const before = repaired;
    // Remove a trailing partial property at the end of an object:
    //   ,"key"}   ,"key":}   ,"key":partial}
    repaired = repaired.replace(/,\s*"[^"\\]*"\s*:?\s*[^,}\]]*?\s*\}/, '}');
    // Same for array: ,partial]
    repaired = repaired.replace(/,\s*[^,}\]]*?\s*\]/, ']');
    if (repaired === before) break;
    try { return JSON.parse(repaired); } catch (_) { /* try again */ }
  }

  throw new Error('Malformed JSON: could not repair');
}

// Canonical sheet normalization:
//   - Forces d:0.25 on every step (uniform 16th-note grid).
//   - Truncates to the nearest whole-bar boundary at or below the LLM's output
//     so we never leave a partially-composed trailing bar.
//   - Loop-fills from existing bars up to 128 steps (8 bars). The LLM output is
//     often truncated by max_tokens; repeating earlier bars is musically
//     coherent — way better than silent padding.
//   - Minimum 32 steps (2 bars), maximum 128 steps (8 bars).
function normalizeSheet(sheet) {
  if (!sheet || !Array.isArray(sheet.steps) || !sheet.steps.length) return;
  for (const step of sheet.steps) step.d = 0.25;

  // Drop any incomplete trailing bar (keep only whole 16-step bars).
  const bars = Math.floor(sheet.steps.length / 16);
  if (bars >= 1) sheet.steps.length = bars * 16;

  // Ensure at least 2 bars; loop-fill up to 8 bars.
  const TARGET = 128;
  const MIN = 32;
  if (sheet.steps.length < MIN) {
    // Not enough content to loop — pad with silence to minimum.
    while (sheet.steps.length < MIN) sheet.steps.push({ d: 0.25, tracks: [] });
  }
  const sourceLen = sheet.steps.length;
  if (sourceLen && sourceLen < TARGET) {
    // Deep-clone existing bars and append until we hit 128 steps.
    let i = 0;
    while (sheet.steps.length < TARGET) {
      const src = sheet.steps[i % sourceLen];
      sheet.steps.push(JSON.parse(JSON.stringify(src)));
      i++;
    }
  }
  if (sheet.steps.length > TARGET) sheet.steps.length = TARGET;
}

module.exports = { callLLM, extractAndRepairJSON, normalizeSheet };
