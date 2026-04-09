// Vercel serverless function: proxy POST /api/llm → Anthropic or OpenAI API
// Avoids COEP cross-origin restriction in the browser.
// Body: { apiKey, provider?, model, messages, system?, max_tokens, ... }
// provider defaults to 'anthropic'; pass 'openai' for OpenAI models.
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
  // Convert Anthropic-style body to OpenAI chat completions format
  const messages = payload.system
    ? [{ role: 'system', content: payload.system }, ...(payload.messages || [])]
    : (payload.messages || []);
  const body = {
    model:      payload.model,
    max_tokens: payload.max_tokens,
    messages,
  };
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

function detectProvider(payload) {
  if (payload.provider) return payload.provider;
  const m = payload.model || '';
  if (m.startsWith('gpt') || m.startsWith('o1') || m.startsWith('o3')) return 'openai';
  if (m.startsWith('gemini')) return 'google';
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
    } else {
      result = await proxyAnthropic(apiKey, payload);
    }
    res.status(result.status).send(result.body);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
};
