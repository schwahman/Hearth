// "Sign in with Google", written from scratch on OpenID Connect:
// authorization code flow with PKCE, a one-time state and nonce, and the
// ID token's RS256 signature checked against Google's published keys.
//
// Turned on by GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and PUBLIC_URL (an
// https:// address; Google doesn't allow sign-in back to a bare IP).
'use strict';
const crypto = require('node:crypto');
const config = require('./config');
const secrets = require('./secrets');

const AUTH_URL = process.env.GOOGLE_AUTH_URL || 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = process.env.GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token';
const CERTS_URL = process.env.GOOGLE_CERTS_URL || 'https://www.googleapis.com/oauth2/v3/certs';
const ISSUERS = new Set((process.env.GOOGLE_ISSUER || 'https://accounts.google.com,accounts.google.com').split(','));
const STATE_TTL = 10 * 60 * 1000;

const enabled = () => !!(config.googleClientId && config.googleClientSecret && config.publicUrl);
const redirectUri = () => `${config.publicUrl}/api/auth/google/callback`;
const b64url = (buf) => Buffer.from(buf).toString('base64url');

class OAuthError extends Error {}

// Step 1: send the browser to Google. The state, nonce and PKCE verifier go
// in an encrypted, short-lived cookie so nothing is kept on the server.
function start(mode, userId) {
  if (!enabled()) throw new OAuthError('Sign in with Google isn’t set up on this Hearth.');
  const state = b64url(crypto.randomBytes(24));
  const nonce = b64url(crypto.randomBytes(24));
  const verifier = b64url(crypto.randomBytes(48));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const cookie = secrets.encryptText('oauth-state', JSON.stringify({ state, nonce, verifier, mode, uid: userId || null, exp: Date.now() + STATE_TTL }));
  const url = new URL(AUTH_URL);
  url.search = new URLSearchParams({
    client_id: config.googleClientId, redirect_uri: redirectUri(), response_type: 'code', scope: 'openid email profile',
    state, nonce, code_challenge: challenge, code_challenge_method: 'S256', prompt: 'select_account',
  }).toString();
  return { url: url.toString(), cookie };
}

// Step 2: Google sends the browser back with a code. Check the state,
// trade the code for an ID token, and verify it.
async function finish(query, cookie) {
  let saved;
  try { saved = JSON.parse(secrets.decryptText('oauth-state', cookie || '')); } catch { throw new OAuthError('That sign-in took too long or was started in another browser. Please try again.'); }
  if (!saved || saved.exp < Date.now()) throw new OAuthError('That sign-in took too long. Please try again.');
  if (query.get('error')) throw new OAuthError(query.get('error') === 'access_denied' ? 'Google sign-in was cancelled.' : 'Google didn’t complete the sign-in.');
  const state = query.get('state') || '';
  if (state.length !== saved.state.length || !crypto.timingSafeEqual(Buffer.from(state), Buffer.from(saved.state))) {
    throw new OAuthError('That sign-in link doesn’t match. Please try again.');
  }
  const code = query.get('code');
  if (!code) throw new OAuthError('Google didn’t complete the sign-in.');
  const res = await fetch(TOKEN_URL, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code, client_id: config.googleClientId, client_secret: config.googleClientSecret,
      redirect_uri: redirectUri(), grant_type: 'authorization_code', code_verifier: saved.verifier,
    }),
  }).catch(() => null);
  if (!res || !res.ok) throw new OAuthError('Couldn’t finish signing in with Google. Please try again.');
  const body = await res.json();
  const claims = await verifyIdToken(body.id_token, saved.nonce);
  return { mode: saved.mode, uid: saved.uid, sub: claims.sub, email: claims.email || null, emailVerified: claims.email_verified === true || claims.email_verified === 'true', name: claims.name || null };
}

// ---------- ID token (JWT) verification ----------
let keyCache = { keys: new Map(), until: 0 };
async function googleKey(kid) {
  if (Date.now() > keyCache.until || !keyCache.keys.has(kid)) {
    const res = await fetch(CERTS_URL, { redirect: 'error', signal: AbortSignal.timeout(15000) }).catch(() => null);
    if (!res || !res.ok) throw new OAuthError('Couldn’t check the sign-in with Google. Please try again.');
    const jwks = await res.json();
    const maxAge = Number((/max-age=(\d+)/.exec(res.headers.get('cache-control') || '') || [])[1] || 3600);
    keyCache = { keys: new Map(jwks.keys.filter((k) => k.kty === 'RSA').map((k) => [k.kid, crypto.createPublicKey({ key: k, format: 'jwk' })])), until: Date.now() + Math.min(maxAge, 86400) * 1000 };
  }
  const key = keyCache.keys.get(kid);
  if (!key) throw new OAuthError('Couldn’t check the sign-in with Google. Please try again.');
  return key;
}

async function verifyIdToken(token, nonce) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw new OAuthError('Google sent an unexpected reply.');
  let header; let claims;
  try { header = JSON.parse(Buffer.from(parts[0], 'base64url')); claims = JSON.parse(Buffer.from(parts[1], 'base64url')); } catch { throw new OAuthError('Google sent an unexpected reply.'); }
  if (header.alg !== 'RS256') throw new OAuthError('Google sent an unexpected reply.');
  const ok = crypto.verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), await googleKey(header.kid), Buffer.from(parts[2], 'base64url'));
  const now = Math.floor(Date.now() / 1000);
  const audOk = Array.isArray(claims.aud) ? claims.aud.includes(config.googleClientId) : claims.aud === config.googleClientId;
  if (!ok || !ISSUERS.has(claims.iss) || !audOk || !(claims.exp > now - 60) || (claims.iat && claims.iat > now + 300) || claims.nonce !== nonce || !claims.sub) {
    throw new OAuthError('That Google sign-in couldn’t be verified. Please try again.');
  }
  return claims;
}

module.exports = { enabled, start, finish, OAuthError, redirectUri, _verifyIdToken: verifyIdToken };
