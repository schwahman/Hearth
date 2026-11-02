// A stand-in for Google's sign-in endpoints (token + signing keys) that
// issues real RS256-signed ID tokens, so "Sign in with Google" can be
// tested end to end.
'use strict';
const http = require('node:http');
const crypto = require('node:crypto');

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }); // an attacker's key
const KID = 'mock-key-1';
const codes = new Map();
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

function sign(claims, key = privateKey, kid = KID) {
  const head = b64({ alg: 'RS256', kid, typ: 'JWT' });
  const body = b64(claims);
  return `${head}.${body}.${crypto.sign('RSA-SHA256', Buffer.from(`${head}.${body}`), key).toString('base64url')}`;
}

function start(port, clientId, clientSecret) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const json = (s, o) => { res.writeHead(s, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' }); res.end(JSON.stringify(o)); };
    if (url.pathname === '/certs') return json(200, { keys: [{ ...publicKey.export({ format: 'jwk' }), kid: KID, alg: 'RS256', use: 'sig' }] });
    if (url.pathname === '/token' && req.method === 'POST') {
      let raw = ''; for await (const c of req) raw += c;
      const p = new URLSearchParams(raw);
      const c = codes.get(p.get('code'));
      codes.delete(p.get('code'));
      if (!c || p.get('client_secret') !== clientSecret || p.get('client_id') !== clientId
          || crypto.createHash('sha256').update(p.get('code_verifier') || '').digest('base64url') !== c.challenge) return json(400, { error: 'invalid_grant' });
      const now = Math.floor(Date.now() / 1000);
      const claims = { iss: 'https://accounts.google.com', aud: clientId, iat: now, exp: now + 3600, nonce: c.nonce, ...c.claims };
      return json(200, { id_token: c.forge ? sign(claims, other.privateKey) : sign(claims), access_token: 'x', token_type: 'Bearer' });
    }
    json(404, {});
  });
  return new Promise((r) => server.listen(port, '127.0.0.1', () => r(server)));
}

// The test plays the part of the person approving on Google's page.
function approve(authUrl, claims, { forge = false } = {}) {
  const u = new URL(authUrl);
  const code = crypto.randomBytes(12).toString('hex');
  codes.set(code, { claims, nonce: claims.nonce !== undefined ? claims.nonce : u.searchParams.get('nonce'), challenge: u.searchParams.get('code_challenge'), forge });
  return { code, state: u.searchParams.get('state') };
}

module.exports = { start, approve };
