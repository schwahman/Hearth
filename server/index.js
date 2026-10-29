// Entry point: HTTP(S) server for the API, uploads and web client, plus the
// WebSocket gateway on /gateway.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const config = require('./config');
const api = require('./api');
const gateway = require('./gateway');
const { attachWebSocketServer } = require('./websocket');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; " +
    "connect-src 'self' ws: wss:; style-src 'self' 'unsafe-inline'; script-src 'self'",
};

function serveStatic(req, res) {
  const url = new URL(req.url, 'http://x');
  let rel = decodeURIComponent(url.pathname);
  // Client-side routes (e.g. /invite/abc) all load the app shell.
  if (rel === '/' || rel.startsWith('/invite/') || !path.extname(rel)) rel = '/index.html';
  const file = path.normalize(path.join(config.publicDir, rel));
  if (!file.startsWith(config.publicDir + path.sep) || !fs.existsSync(file)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('Not found');
  }
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
    'Cache-Control': 'no-cache',
  });
  fs.createReadStream(file).pipe(res);
}

async function onRequest(req, res) {
  try {
    if (req.url.startsWith('/api/')) {
      if (await api.handle(req, res)) return;
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end('{"error":"Not found."}');
    }
    if (req.url.startsWith('/uploads/') && api.serveUpload(req, res)) return;
    serveStatic(req, res);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) { res.writeHead(500); res.end(); }
  }
}

let tls = null;
if (config.tlsPfx) tls = { pfx: fs.readFileSync(config.tlsPfx), passphrase: config.tlsPfxPass };
else if (config.tlsCert && config.tlsKey) tls = { cert: fs.readFileSync(config.tlsCert), key: fs.readFileSync(config.tlsKey) };
const useTls = !!tls;
const server = useTls ? https.createServer(tls, onRequest) : http.createServer(onRequest);

attachWebSocketServer(server, '/gateway', gateway.onConnection);

server.listen(config.port, config.host, () => {
  const proto = useTls ? 'https' : 'http';
  console.log(`Hearth running at ${proto}://localhost:${config.port}  (node ${config.nodeId})`);
  if (!useTls) console.log('Tip: voice/video from other machines needs HTTPS. See README.');
});

function shutdown() {
  console.log('Shutting down...');
  for (const s of gateway.sessions.values()) s.ws.close(1001, 'server restarting');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
