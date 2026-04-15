// Vercel serverless function: proxy POST /api/llm → Anthropic / OpenAI / Google / MiniMax
// Avoids COEP cross-origin restriction in the browser.
// Body: { apiKey, provider?, model, messages, system?, max_tokens, ... }
// provider defaults to 'anthropic'; pass 'openai', 'google', or 'minimax' to override.
const https = require('https');

function proxyAnthropic(apiKey, payload) {
  const { provider: _p, ...body } = payload; // strip provider field
  const postData = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.anthropic.com',
      path:     '/v1/messages',
      method:   'POST',
      headers: {
        'x-api-key':         apiKey,
        'anthropic-version': '2023-06-01',
        'content-type':      'application/json',
        'content-length':    Buffer.byteLength(postData),
      },
    }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

function proxyOpenAI(apiKey, payload) {
  const m = payload.model || '';
  const isReasoning = m.startsWith('o1') || m.startsWith('o3');

  // Convert Anthropic-style body to OpenAI chat completions format
  const inputMsgs = payload.messages || [];
  let messages;
  if (isReasoning) {
    // Reasoning models reject the system role — fold it into the first user message
    const [first, ...rest] = inputMsgs;
    messages = payload.system && first
      ? [{ role: first.role || 'user', content: `${payload.system}\n\n${first.content}` }, ...rest]
      : inputMsgs;
  } else {
    messages = payload.system
      ? [{ role: 'system', content: payload.system }, ...inputMsgs]
      : inputMsgs;
  }

  const body = { model: m, messages };
  // Reasoning models use max_completion_tokens; older models use max_tokens
  if (isReasoning) body.max_completion_tokens = payload.max_tokens;
  else body.max_tokens = payload.max_tokens;
  const postData = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.openai.com',
      path:     '/v1/chat/completions',
      method:   'POST',
      headers: {
        'Authorization':  `Bearer ${apiKey}`,
        'content-type':   'application/json',
        'content-length': Buffer.byteLength(postData),
      },
    }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        // Normalise OpenAI response to Anthropic shape so callers don't care
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode === 200 && parsed.choices) {
            const normalised = {
              content: [{ type: 'text', text: parsed.choices[0].message.content }],
              model:   parsed.model,
            };
            resolve({ status: 200, body: JSON.stringify(normalised) });
          } else {
            resolve({ status: res.statusCode, body: data });
          }
        } catch (e) {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

function proxyGoogle(apiKey, payload) {
  // Convert Anthropic-style body to Gemini generateContent format
  const contents = (payload.messages || []).map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));
  const body = {
    contents,
    generationConfig: { maxOutputTokens: payload.max_tokens || 8192 },
  };
  if (payload.system) body.system_instruction = { parts: [{ text: payload.system }] };
  const postData = JSON.stringify(body);
  const path = `/v1beta/models/${payload.model}:generateContent?key=${apiKey}`;
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'generativelanguage.googleapis.com',
      path,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(postData),
      },
    }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode === 200 && parsed.candidates) {
            // Normalise to Anthropic shape so callers don't care
            const text = parsed.candidates[0].content.parts[0].text;
            const normalised = { content: [{ type: 'text', text }], model: payload.model };
            resolve({ status: 200, body: JSON.stringify(normalised) });
          } else {
            resolve({ status: res.statusCode, body: data });
          }
        } catch (e) {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

function proxyMinimax(apiKey, payload) {
  // MiniMax exposes an OpenAI-compatible chat completions endpoint.
  const inputMsgs = payload.messages || [];
  const messages = payload.system
    ? [{ role: 'system', content: payload.system }, ...inputMsgs]
    : inputMsgs;
  const body = { model: payload.model, messages, max_tokens: payload.max_tokens };
  const postData = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.minimax.io',
      path:     '/v1/text/chatcompletion_v2',
      method:   'POST',
      headers: {
        'Authorization':  `Bearer ${apiKey}`,
        'content-type':   'application/json',
        'content-length': Buffer.byteLength(postData),
      },
    }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode === 200 && parsed.choices) {
            const normalised = {
              content: [{ type: 'text', text: parsed.choices[0].message.content }],
              model:   parsed.model,
            };
            resolve({ status: 200, body: JSON.stringify(normalised) });
          } else {
            resolve({ status: res.statusCode, body: data });
          }
        } catch (e) {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

function detectProvider(payload) {
  if (payload.provider) return payload.provider;
  const m = payload.model || '';
  if (m.startsWith('gpt') || m.startsWith('o1') || m.startsWith('o3')) return 'openai';
  if (m.startsWith('gemini')) return 'google';
  if (m.toLowerCase().startsWith('minimax')) return 'minimax';
  return 'anthropic';
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { apiKey, ...payload } = req.body || {};
  if (!apiKey) return res.status(401).json({ error: 'Missing apiKey' });

  const provider = detectProvider(payload);

  try {
    let result;
    if (provider === 'openai') {
      result = await proxyOpenAI(apiKey, payload);
    } else if (provider === 'google') {
      result = await proxyGoogle(apiKey, payload);
    } else if (provider === 'minimax') {
      result = await proxyMinimax(apiKey, payload);
    } else {
      result = await proxyAnthropic(apiKey, payload);
    }
    res.status(result.status).send(result.body);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
};
