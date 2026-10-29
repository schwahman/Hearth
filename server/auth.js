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
const secrets = require('./secrets');
const mailer = require('./mailer');

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
     FROM auth_sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND u.suspended_at IS NULL`, h);
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
// Only the automated test suite raises this; production always uses 1.
const SCALE = Math.max(1, Number(process.env.RATE_LIMIT_SCALE || 1));
function hit(key, limit, windowMs) {
  limit *= SCALE;
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


// ---------- email: verification, password reset, recovery ----------
// Email addresses are stored encrypted, plus a keyed hash so we can find an
// account by email without keeping the address readable in the database.
const EMAIL_RE = /^[^\s@<>()",;:\\[\]]{1,64}@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;
function normalizeEmail(email) {
  const e = String(email || '').trim().toLowerCase();
  if (e.length > 254 || !EMAIL_RE.test(e)) throw new HttpError(400, 'Enter a valid email address.');
  return e;
}
const emailHash = (normalized) => secrets.lookupHash('email', normalized);
const CODE_TTL = { verify: 30 * 60000, reset: 20 * 60000, change: 30 * 60000 };
const RESET_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O or 1/I mix-ups

function makeCode(purpose) {
  if (purpose === 'reset') {
    let c = '';
    for (const b of crypto.randomBytes(8)) c += RESET_ALPHABET[b % RESET_ALPHABET.length];
    return c;
  }
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}
const codeHash = (userId, code) => crypto.createHash('sha256').update(`${userId}:${String(code).toUpperCase().replace(/[\s-]/g, '')}`).digest('hex');

function userEmail(userId) {
  const r = one('SELECT email_enc, email_verified_at FROM users WHERE id = ?', userId);
  if (!r || !r.email_enc) return null;
  return { email: secrets.decryptText('email', r.email_enc), verified: !!r.email_verified_at };
}

const TEMPLATES = {
  verify: (code) => ({
    subject: `Your Hearth verification code: ${code}`,
    text: `Your Hearth verification code is:\n\n    ${code}\n\nIt expires in 30 minutes. If you didn't create a Hearth account, you can ignore this email.`,
  }),
  change: (code) => ({
    subject: `Confirm your new Hearth email: ${code}`,
    text: `Enter this code in Hearth to confirm this as your account's email address:\n\n    ${code}\n\nIt expires in 30 minutes. If you didn't request this, ignore this email.`,
  }),
  reset: (code) => ({
    subject: 'Reset your Hearth password',
    text: `Someone (hopefully you) asked to reset your Hearth password. Your reset code is:\n\n    ${code}\n\nIt expires in 20 minutes and works once. If you didn't ask for this, ignore this email; your password hasn't changed.`,
  }),
};

async function sendCode(userId, purpose, toAddress, target) {
  run('DELETE FROM email_codes WHERE user_id = ? AND purpose = ?', userId, purpose);
  const code = makeCode(purpose);
  const now = Date.now();
  run(`INSERT INTO email_codes (id, user_id, purpose, code_hash, target_enc, target_hash, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, newId(), userId, purpose, codeHash(userId, code),
    target ? secrets.encryptText('email', target) : null, target ? emailHash(target) : null, now + CODE_TTL[purpose], now);
  const t = TEMPLATES[purpose](code);
  return mailer.sendMail({ to: toAddress, subject: t.subject, text: t.text });
}

// Returns the code row if valid; counts failed attempts (5 max).
function checkCode(userId, purpose, code) {
  const row = one('SELECT * FROM email_codes WHERE user_id = ? AND purpose = ?', userId, purpose);
  if (!row || row.expires_at < Date.now() || row.attempts >= 5) return null;
  const a = Buffer.from(row.code_hash, 'hex');
  const b = Buffer.from(codeHash(userId, code), 'hex');
  if (!crypto.timingSafeEqual(a, b)) {
    run('UPDATE email_codes SET attempts = attempts + 1 WHERE id = ?', row.id);
    return null;
  }
  run('DELETE FROM email_codes WHERE id = ?', row.id);
  return row;
}

function notify(userId, subject, text) {
  const e = userEmail(userId);
  if (e && e.verified) mailer.sendMail({ to: e.email, subject, text }).catch(() => {});
}

async function resendVerification(userId) {
  hit(`verify-send:${userId}`, 5, 3600 * 1000);
  const e = userEmail(userId);
  if (!e) throw new HttpError(400, 'Add an email address first.');
  if (e.verified) return;
  if (!(await sendCode(userId, 'verify', e.email))) throw new HttpError(503, 'Email sending isn’t set up on this server yet.');
}

function verifyEmail(userId, code) {
  hit(`verify:${userId}`, 10, 15 * 60 * 1000);
  if (!checkCode(userId, 'verify', code)) throw new HttpError(400, 'That code is wrong or has expired.');
  run('UPDATE users SET email_verified_at = ? WHERE id = ?', Date.now(), userId);
}

// Add or change the account email. Sends a code to the new address;
// nothing changes until it's confirmed.
async function requestEmailChange(userId, password, newEmail) {
  hit(`email-change:${userId}`, 5, 3600 * 1000);
  const u = one('SELECT password_hash FROM users WHERE id = ?', userId);
  const { ok } = await verifyPassword(String(password || ''), u.password_hash);
  if (!ok) throw new HttpError(403, 'Your password is incorrect.');
  const e = normalizeEmail(newEmail);
  const taken = one('SELECT id FROM users WHERE email_hash = ?', emailHash(e));
  if (taken && taken.id !== userId) throw new HttpError(409, 'That email address is already used by another account.');
  if (!(await sendCode(userId, 'change', e, e))) throw new HttpError(503, 'Email sending isn’t set up on this server yet.');
}

function confirmEmailChange(userId, code) {
  hit(`email-confirm:${userId}`, 10, 15 * 60 * 1000);
  const row = checkCode(userId, 'change', code);
  if (!row) throw new HttpError(400, 'That code is wrong or has expired.');
  const old = userEmail(userId);
  const e = secrets.decryptText('email', row.target_enc);
  if (one('SELECT 1 FROM users WHERE email_hash = ? AND id != ?', row.target_hash, userId)) {
    throw new HttpError(409, 'That email address is already used by another account.');
  }
  run('UPDATE users SET email_enc = ?, email_hash = ?, email_verified_at = ? WHERE id = ?',
    secrets.encryptText('email', e), row.target_hash, Date.now(), userId);
  if (old && old.verified && old.email !== e) {
    mailer.sendMail({ to: old.email, subject: 'Your Hearth email was changed',
      text: 'The email address on your Hearth account was just changed. If you didn’t do this, reset your password right away and contact the server admin.' }).catch(() => {});
  }
}

// "Forgot password": always answers the same way, whether or not the
// account exists, so nobody can use it to discover accounts.
async function forgotPassword(identifier, meta) {
  hit(`forgot:${meta.ip}`, 10, 3600 * 1000);
  const id = String(identifier || '').trim();
  let user = null;
  if (id.includes('@')) {
    try { user = one('SELECT id FROM users WHERE email_hash = ?', emailHash(normalizeEmail(id))); } catch { /* invalid email */ }
  } else {
    user = one('SELECT id FROM users WHERE username = ?', id.slice(0, 64));
  }
  if (!user) return;
  try { hit(`forgot-user:${user.id}`, 3, 3600 * 1000); } catch { return; }
  const e = userEmail(user.id);
  if (e && e.verified) await sendCode(user.id, 'reset', e.email).catch((err) => console.warn('[mail] reset email failed:', err.message));
}

// Finish a reset with the emailed code or one of the backup recovery codes.
async function resetPassword({ identifier, code, recoveryCode, newPassword }, meta) {
  hit(`reset:${meta.ip}`, 20, 3600 * 1000);
  const id = String(identifier || '').trim();
  let user = null;
  if (id.includes('@')) {
    try { user = one('SELECT id, username FROM users WHERE email_hash = ?', emailHash(normalizeEmail(id))); } catch { /* invalid */ }
  } else {
    user = one('SELECT id, username FROM users WHERE username = ?', id.slice(0, 64));
  }
  const bad = new HttpError(400, 'That code is wrong or has expired.');
  if (!user) throw bad;
  hit(`reset-user:${user.id}`, 10, 3600 * 1000);
  checkPasswordRules(newPassword, user.username);
  let okCode = false;
  if (code) okCode = !!checkCode(user.id, 'reset', code);
  else if (recoveryCode) okCode = useRecoveryCode(user.id, recoveryCode);
  if (!okCode) throw bad;
  run('UPDATE users SET password_hash = ? WHERE id = ?', await hashPassword(newPassword), user.id);
  revokeAllSessions(user.id);
  run('DELETE FROM email_codes WHERE user_id = ?', user.id);
  failures.delete(user.username.toLowerCase());
  notify(user.id, 'Your Hearth password was reset',
    'Your Hearth password was just reset and all devices were signed out. If this wasn’t you, reset it again right away and contact the server admin.');
  return { id: user.id, token: createSession(user.id, meta) };
}

// ---------- backup recovery codes ----------
// Ten single-use codes the person saves somewhere safe. They can reset the
// password even if they lose access to their email.
async function generateRecoveryCodes(userId, password) {
  const u = one('SELECT password_hash FROM users WHERE id = ?', userId);
  const { ok } = await verifyPassword(String(password || ''), u.password_hash);
  if (!ok) throw new HttpError(403, 'Your password is incorrect.');
  const codes = [];
  run('DELETE FROM recovery_codes WHERE user_id = ?', userId);
  for (let i = 0; i < 10; i++) {
    let c = '';
    for (const b of crypto.randomBytes(10)) c += RESET_ALPHABET[b % RESET_ALPHABET.length];
    const pretty = `${c.slice(0, 5)}-${c.slice(5)}`;
    codes.push(pretty);
    run('INSERT INTO recovery_codes (user_id, code_hash) VALUES (?, ?)', userId, codeHash(userId, c));
  }
  notify(userId, 'New Hearth recovery codes', 'New backup recovery codes were created for your Hearth account. Any older codes no longer work.');
  return codes;
}

function useRecoveryCode(userId, code) {
  const h = codeHash(userId, code);
  const row = one('SELECT used_at FROM recovery_codes WHERE user_id = ? AND code_hash = ?', userId, h);
  if (!row || row.used_at) return false;
  run('UPDATE recovery_codes SET used_at = ? WHERE user_id = ? AND code_hash = ?', Date.now(), userId, h);
  return true;
}

function accountSecurity(userId) {
  const e = userEmail(userId);
  const rc = one('SELECT COUNT(*) AS n, SUM(used_at IS NULL) AS left FROM recovery_codes WHERE user_id = ?', userId);
  return {
    email: e ? e.email : null,
    emailVerified: e ? e.verified : false,
    recoveryCodesLeft: rc.n ? rc.left : null,
    emailEnabled: mailer.configured(),
  };
}

// ---------- date of birth ----------
// Needed to keep under-13s off Hearth and to gate 18+/21+ channels.
// Stored encrypted; people can set it once (only an admin can reset it).
function checkBirthdate(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
  const d = m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : null;
  if (!d || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3] || d > new Date() || +m[1] < 1900) {
    throw new HttpError(400, 'Enter your date of birth.');
  }
  const { ageFromDate } = require('./permissions');
  if (ageFromDate(m[0]) < 13) throw new HttpError(400, 'You must be at least 13 years old to use Hearth.');
  return m[0];
}

function setBirthdate(userId, value) {
  if (one('SELECT birthdate_enc FROM users WHERE id = ?', userId).birthdate_enc) {
    throw new HttpError(409, 'Your date of birth is already set. Contact a Hearth admin if it\u2019s wrong.');
  }
  run('UPDATE users SET birthdate_enc = ? WHERE id = ?', secrets.encryptText('birthdate', checkBirthdate(value)), userId);
}

// ---------- account actions ----------
async function register(username, password, displayName, meta, acceptedTerms, email, birthdate) {
  // Up to 30 tries an hour (people fumble the rules), but at most 5 new
  // accounts an hour from one address.
  hit(`reg:${meta.ip}`, 30, 3600 * 1000);
  const made = buckets.get(`regok:${meta.ip}`);
  if (made && Date.now() < made.reset && made.n >= 5 * SCALE) {
    throw new HttpError(429, 'Too many new accounts from this network. Try again later.');
  }
  if (!/^[a-zA-Z0-9_.]{2,32}$/.test(username || '')) {
    throw new HttpError(400, 'Username must be 2-32 letters, numbers, dots or underscores.');
  }
  checkPasswordRules(password, username);
  if (acceptedTerms !== true) {
    throw new HttpError(400, 'Please confirm you are at least 13 and agree to the Terms and Privacy Policy.');
  }
  const dob = checkBirthdate(birthdate);
  const normEmail = normalizeEmail(email);
  if (one('SELECT 1 FROM users WHERE email_hash = ?', emailHash(normEmail))) {
    throw new HttpError(409, 'That email address is already used by another account.');
  }
  if (one('SELECT 1 FROM users WHERE username = ?', username)) {
    throw new HttpError(409, 'That username is taken.');
  }
  const hash = await hashPassword(password);
  const id = newId();
  hit(`regok:${meta.ip}`, 5, 3600 * 1000);
  const now = Date.now();
  // The very first account on a new Hearth becomes its platform admin.
  const first = !one('SELECT 1 FROM users LIMIT 1');
  run(`INSERT INTO users (id, username, display_name, password_hash, created_at, terms_accepted_at, email_enc, email_hash, is_admin)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, username, String(displayName || username).trim().slice(0, 32) || username, hash, now, now,
    secrets.encryptText('email', normEmail), emailHash(normEmail), first ? 1 : 0);
  run('UPDATE users SET birthdate_enc = ? WHERE id = ?', secrets.encryptText('birthdate', dob), id);
  sendCode(id, 'verify', normEmail).catch((e) => console.warn('[mail] verification email failed:', e.message));
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
  const status = one('SELECT suspended_at, suspended_reason FROM users WHERE id = ?', user.id);
  if (status.suspended_at) {
    throw new HttpError(403, `This account has been suspended${status.suspended_reason ? `: ${status.suspended_reason}` : '.'}`);
  }
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
  notify(userId, 'Your Hearth password was changed',
    'Your Hearth password was just changed and your other devices were signed out. If this wasn’t you, reset your password right away.');
}

module.exports = {
  register, login, changePassword, resendVerification, verifyEmail, requestEmailChange, confirmEmailChange,
  forgotPassword, resetPassword, generateRecoveryCodes, accountSecurity, userEmail, hit, setBirthdate, createSession, userFromToken, revokeSession, revokeAllSessions,
  listSessions, revokeSessionById, hashPassword, verifyPassword, hashToken, HttpError, PASSWORD_MIN,
};
