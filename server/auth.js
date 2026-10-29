// Accounts, passwords and sessions.
//
// Passwords
//   - Never stored. We keep a one-way scrypt hash (memory-hard, so guessing
//     is slow even with GPUs) with a random 16-byte salt per user.
//   - Parameters follow the OWASP Password Storage Cheat Sheet. They're
//     stored with each hash, so we can raise them later: older hashes are
//     upgraded automatically the next time that person logs in.
//   - Hashing runs off the main thread so logins never freeze chat.
//   - Rules follow NIST SP 800-63B: long passwords and passphrases allowed,
//     no forced symbols/uppercase, common and breached-list passwords
//     rejected, no password containing the username.
//
// Sessions
//   - The browser gets a random 256-bit token in an HttpOnly cookie that
//     page scripts can't read. The database stores only a SHA-256 hash of
//     the token, so a stolen database copy can't be used to log in.
//   - Sessions expire after 30 days unused (and 365 days at most), and all
//     of them are revoked when the password changes.
'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');
const { one, all, run } = require('./db');
const { newId } = require('./ids');

const scrypt = promisify(crypto.scrypt);

// OWASP minimum for scrypt is N=2^17,r=8,p=1 or an equivalent trade-off.
// N=2^15,r=8,p=3 is one of OWASP's listed equivalents and uses 32 MB per
// hash instead of 128 MB, which keeps a small server responsive.
const CURRENT = { N: 2 ** 15, r: 8, p: 3, keylen: 64 };
const maxmem = (N, r) => 128 * N * r * 2;

const PASSWORD_MIN = 12;
const PASSWORD_MAX = 256; // long enough for any passphrase; caps hashing cost
const SESSION_IDLE_MS = 30 * 24 * 3600 * 1000;
const SESSION_MAX_MS = 365 * 24 * 3600 * 1000;

const common = new Set(
  fs.readFileSync(path.join(__dirname, 'data', 'common-passwords.txt'), 'utf8')
    .split('\n').filter((l) => l && !l.startsWith('#')));

class HttpError extends Error {
  constructor(status, message, headers) { super(message); this.status = status; this.headers = headers; }
}

// ---------- password hashing ----------
async function hashPassword(password, params = CURRENT) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password.normalize('NFKC'), salt, params.keylen,
    { N: params.N, r: params.r, p: params.p, maxmem: maxmem(params.N, params.r) });
  return `scrypt$${params.N}$${params.r}$${params.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

// Returns { ok, needsUpgrade }.
async function verifyPassword(password, stored) {
  const parts = stored.split('$');
  let N, r, p, salt, expected;
  if (parts.length === 6) {
    N = Number(parts[1]); r = Number(parts[2]); p = Number(parts[3]);
    salt = Buffer.from(parts[4], 'base64'); expected = Buffer.from(parts[5], 'base64');
  } else if (parts.length === 3) {
    // v0.1 format: scrypt$saltHex$hashHex with N=16384,r=8,p=1
    N = 16384; r = 8; p = 1;
    salt = Buffer.from(parts[1], 'hex'); expected = Buffer.from(parts[2], 'hex');
  } else {
    return { ok: false, needsUpgrade: false };
  }
  const input = parts.length === 3 ? password : password.normalize('NFKC');
  const actual = await scrypt(input, salt, expected.length, { N, r, p, maxmem: maxmem(N, r) });
  const ok = crypto.timingSafeEqual(expected, actual);
  const needsUpgrade = ok && (parts.length !== 6 || N < CURRENT.N || r < CURRENT.r || p < CURRENT.p);
  return { ok, needsUpgrade };
}

// A real hash of a random password, used so "no such user" takes as long as
// "wrong password" and can't be told apart by timing.
let dummyHash = null;
async function getDummyHash() {
  if (!dummyHash) dummyHash = await hashPassword(crypto.randomBytes(16).toString('hex'));
  return dummyHash;
}

function checkPasswordRules(password, username) {
  if (typeof password !== 'string') throw new HttpError(400, 'Password is required.');
  const chars = [...password];
  if (chars.length < PASSWORD_MIN) {
    throw new HttpError(400, `Password must be at least ${PASSWORD_MIN} characters. A short phrase works well, like "purple tractor fishing trip".`);
  }
  if (chars.length > PASSWORD_MAX) throw new HttpError(400, `Password must be at most ${PASSWORD_MAX} characters.`);
  const lower = password.toLowerCase();
  if (common.has(lower)) throw new HttpError(400, 'That password is too common. Please choose another.');
  if (username && lower.includes(username.toLowerCase())) {
    throw new HttpError(400, 'Password cannot contain your username.');
  }
  if (new Set(chars).size < 4) throw new HttpError(400, 'Password is too repetitive.');
}

// ---------- sessions ----------
const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

function createSession(userId, meta = {}) {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  run(`INSERT INTO auth_sessions (token_hash, user_id, created_at, last_seen, user_agent, ip)
       VALUES (?, ?, ?, ?, ?, ?)`,
    hashToken(token), userId, now, now, (meta.userAgent || '').slice(0, 200), meta.ip || null);
  return token;
}

function userFromToken(token) {
  if (!token || typeof token !== 'string' || token.length > 100) return null;
  const h = hashToken(token);
  const row = one(
    `SELECT s.created_at, s.last_seen, u.id, u.username, u.display_name, u.avatar
     FROM auth_sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`, h);
  if (!row) return null;
  const now = Date.now();
  if (now - row.last_seen > SESSION_IDLE_MS || now - row.created_at > SESSION_MAX_MS) {
    run('DELETE FROM auth_sessions WHERE token_hash = ?', h);
    return null;
  }
  // Refresh "last seen" at most once an hour to keep writes low.
  if (now - row.last_seen > 3600 * 1000) run('UPDATE auth_sessions SET last_seen = ? WHERE token_hash = ?', now, h);
  return { id: row.id, username: row.username, display_name: row.display_name, avatar: row.avatar };
}

function revokeSession(token) {
  if (token) run('DELETE FROM auth_sessions WHERE token_hash = ?', hashToken(token));
}

function revokeAllSessions(userId, exceptToken) {
  if (exceptToken) run('DELETE FROM auth_sessions WHERE user_id = ? AND token_hash != ?', userId, hashToken(exceptToken));
  else run('DELETE FROM auth_sessions WHERE user_id = ?', userId);
}

function listSessions(userId, currentToken) {
  const cur = currentToken ? hashToken(currentToken) : '';
  return all('SELECT token_hash, created_at, last_seen, user_agent, ip FROM auth_sessions WHERE user_id = ? ORDER BY last_seen DESC', userId)
    .map((s) => ({
      id: s.token_hash.slice(0, 16), createdAt: s.created_at, lastSeen: s.last_seen,
      userAgent: s.user_agent, ip: s.ip, current: s.token_hash === cur,
    }));
}

function revokeSessionById(userId, shortId) {
  run('DELETE FROM auth_sessions WHERE user_id = ? AND substr(token_hash, 1, 16) = ?', userId, String(shortId));
}

// Clear out expired sessions hourly.
setInterval(() => {
  const now = Date.now();
  run('DELETE FROM auth_sessions WHERE last_seen < ? OR created_at < ?', now - SESSION_IDLE_MS, now - SESSION_MAX_MS);
}, 3600 * 1000).unref();

// ---------- rate limiting ----------
// Slows password guessing: limits attempts per IP address and, separately,
// failed attempts per account (so one person can't be targeted from many
// addresses). Lockouts grow 1, 2, 4 ... up to 15 minutes.
const buckets = new Map();
function hit(key, limit, windowMs) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || now > b.reset) { b = { n: 0, reset: now + windowMs }; buckets.set(key, b); }
  b.n++;
  if (b.n > limit) {
    const secs = Math.ceil((b.reset - now) / 1000);
    throw new HttpError(429, `Too many attempts. Try again in ${secs < 60 ? secs + ' seconds' : Math.ceil(secs / 60) + ' minutes'}.`,
      { 'Retry-After': String(secs) });
  }
}

const failures = new Map(); // username -> { count, lockedUntil }
function checkLock(username) {
  const f = failures.get(username.toLowerCase());
  if (f && f.lockedUntil > Date.now()) {
    const secs = Math.ceil((f.lockedUntil - Date.now()) / 1000);
    throw new HttpError(429, `Too many failed logins for this account. Try again in ${secs < 60 ? secs + ' seconds' : Math.ceil(secs / 60) + ' minutes'}.`,
      { 'Retry-After': String(secs) });
  }
}
function recordFailure(username) {
  const key = username.toLowerCase();
  const f = failures.get(key) || { count: 0, lockedUntil: 0 };
  f.count++;
  if (f.count >= 5) f.lockedUntil = Date.now() + Math.min(15, 2 ** (f.count - 5)) * 60000;
  failures.set(key, f);
}
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) if (now > b.reset) buckets.delete(k);
  for (const [k, f] of failures) if (f.lockedUntil < now - 3600 * 1000) failures.delete(k);
}, 600000).unref();

// ---------- account actions ----------
async function register(username, password, displayName, meta, acceptedTerms) {
  // Up to 30 tries an hour (people fumble the rules), but at most 5 new
  // accounts an hour from one address.
  hit(`reg:${meta.ip}`, 30, 3600 * 1000);
  const made = buckets.get(`regok:${meta.ip}`);
  if (made && Date.now() < made.reset && made.n >= 5) {
    throw new HttpError(429, 'Too many new accounts from this network. Try again later.');
  }
  if (!/^[a-zA-Z0-9_.]{2,32}$/.test(username || '')) {
    throw new HttpError(400, 'Username must be 2-32 letters, numbers, dots or underscores.');
  }
  checkPasswordRules(password, username);
  if (acceptedTerms !== true) {
    throw new HttpError(400, 'Please confirm you are at least 13 and agree to the Terms and Privacy Policy.');
  }
  if (one('SELECT 1 FROM users WHERE username = ?', username)) {
    throw new HttpError(409, 'That username is taken.');
  }
  const hash = await hashPassword(password);
  const id = newId();
  hit(`regok:${meta.ip}`, 5, 3600 * 1000);
  const now = Date.now();
  run('INSERT INTO users (id, username, display_name, password_hash, created_at, terms_accepted_at) VALUES (?, ?, ?, ?, ?, ?)',
    id, username, String(displayName || username).trim().slice(0, 32) || username, hash, now, now);
  return { id, token: createSession(id, meta) };
}

async function login(username, password, meta) {
  hit(`login:${meta.ip}`, 20, 15 * 60 * 1000);
  username = String(username || '').slice(0, 64);
  password = typeof password === 'string' ? password.slice(0, PASSWORD_MAX + 1) : '';
  checkLock(username);
  const user = one('SELECT id, password_hash FROM users WHERE username = ?', username);
  const { ok, needsUpgrade } = await verifyPassword(password, user ? user.password_hash : await getDummyHash());
  if (!user || !ok) {
    recordFailure(username);
    console.log(`[auth] failed login for "${username}" from ${meta.ip}`);
    throw new HttpError(401, 'Wrong username or password.');
  }
  failures.delete(username.toLowerCase());
  if (needsUpgrade) run('UPDATE users SET password_hash = ? WHERE id = ?', await hashPassword(password), user.id);
  return { id: user.id, token: createSession(user.id, meta) };
}

async function changePassword(userId, currentPassword, newPassword, keepToken) {
  const user = one('SELECT username, password_hash FROM users WHERE id = ?', userId);
  hit(`pw:${userId}`, 10, 15 * 60 * 1000);
  const { ok } = await verifyPassword(String(currentPassword || ''), user.password_hash);
  if (!ok) throw new HttpError(403, 'Your current password is incorrect.');
  checkPasswordRules(newPassword, user.username);
  run('UPDATE users SET password_hash = ? WHERE id = ?', await hashPassword(newPassword), userId);
  revokeAllSessions(userId, keepToken);
}

module.exports = {
  register, login, changePassword, createSession, userFromToken, revokeSession, revokeAllSessions,
  listSessions, revokeSessionById, hashPassword, verifyPassword, hashToken, HttpError, PASSWORD_MIN,
};
