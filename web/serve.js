// Minimal dev server: serves web/ with correct MIME types for WASM + ES modules
// Proxies /api/llm and /api/band/* to the Vercel serverless function handlers
// so local dev behaviour matches production exactly (no code duplication).
const http  = require('http');
const fs    = require('fs');
const path  = require('path');

const PORT    = process.env.PORT || 5174;
const ROOT    = __dirname;           // web/
const API_DIR = path.join(__dirname, '..', 'api');  // api/

const MIME = {
  '.html': 'text/html',
  '.js':   'application/javascript',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); }
      catch { reject(new Error('Bad JSON')); }
    });
    req.on('error', reject);
  });
}

// Minimal Express-compatible res shim for Vercel function handlers
function makeRes(nativeRes) {
  let code = 200;
  const r = {
    status: (c) => { code = c; return r; },
    json:   (data) => {
      nativeRes.writeHead(code, { 'Content-Type': 'application/json' });
      nativeRes.end(JSON.stringify(data));
    },
    send:   (data) => {
      nativeRes.writeHead(code, { 'Content-Type': 'application/json' });
      nativeRes.end(typeof data === 'string' ? data : JSON.stringify(data));
    },
  };
  return r;
}

async function routeApi(req, res, modulePath) {
  try {
    // Clear require cache so changes to handlers are picked up on each request
    delete require.cache[require.resolve(modulePath)];
    const handler = require(modulePath);
    const body    = await readBody(req);
    await handler({ method: req.method, body }, makeRes(res));
  } catch (err) {
    const code = err.code === 'MODULE_NOT_FOUND' ? 404 : 502;
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
}

http.createServer(async (req, res) => {
  // ── /api/llm ─────────────────────────────────────────────────────────────
  if (req.method === 'POST' && req.url === '/api/llm') {
    return routeApi(req, res, path.join(API_DIR, 'llm'));
  }

  // ── /api/band/<name> ──────────────────────────────────────────────────────
  const bandMatch = req.url.match(/^\/api\/band\/([a-z-]+)$/);
  if (req.method === 'POST' && bandMatch) {
    return routeApi(req, res, path.join(API_DIR, 'band', bandMatch[1]));
  }

  // ── Static file server ────────────────────────────────────────────────────
  const urlPath  = req.url.split('?')[0];
  const filePath = path.join(ROOT, urlPath === '/' ? '/index.html' : urlPath);
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const ext = path.extname(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-store',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    });
    res.end(data);
  });
}).listen(PORT, () => console.log(`Serving on http://localhost:${PORT}`));
