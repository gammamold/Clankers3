// Vercel serverless function: proxy POST /api/llm → Anthropic API
// Avoids COEP cross-origin restriction in the browser.
const https = require('https');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const { apiKey, ...payload } = req.body || {};
  if (!apiKey) {
    res.status(401).json({ error: 'Missing apiKey' });
    return;
  }

  const postData = JSON.stringify(payload);

  await new Promise((resolve) => {
    const options = {
      hostname: 'api.anthropic.com',
      path:     '/v1/messages',
      method:   'POST',
      headers: {
        'x-api-key':         apiKey,
        'anthropic-version': '2023-06-01',
        'content-type':      'application/json',
        'content-length':    Buffer.byteLength(postData),
      },
    };

    const proxyReq = https.request(options, (proxyRes) => {
      let data = '';
      proxyRes.on('data', (chunk) => { data += chunk; });
      proxyRes.on('end', () => {
        res.status(proxyRes.statusCode).json(JSON.parse(data));
        resolve();
      });
    });

    proxyReq.on('error', (err) => {
      res.status(502).json({ error: err.message });
      resolve();
    });

    proxyReq.write(postData);
    proxyReq.end();
  });
};
