// Accounts and sessions. Passwords are hashed with scrypt (built into Node)
// using a random salt per user; the plain password is never stored.
'use strict';
const crypto = require('node:crypto');
const { one, run } = require('./db');
const { newId } = require('./ids');

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT.keylen, SCRYPT);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [, saltHex, hashHex] = stored.split('$');
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length, SCRYPT);
  return crypto.timingSafeEqual(expected, actual);
}

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  run('INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)', token, userId, Date.now());
  return token;
}

function userFromToken(token) {
  if (!token) return null;
  return one(
    `SELECT u.id, u.username, u.display_name, u.avatar FROM sessions s
     JOIN users u ON u.id = s.user_id WHERE s.token = ?`, token) || null;
}

function register(username, password, displayName) {
  if (!/^[a-zA-Z0-9_.]{2,32}$/.test(username || '')) {
    throw new HttpError(400, 'Username must be 2-32 letters, numbers, dots or underscores.');
  }
  if (typeof password !== 'string' || password.length < 8) {
    throw new HttpError(400, 'Password must be at least 8 characters.');
  }
  if (one('SELECT 1 FROM users WHERE username = ?', username)) {
    throw new HttpError(409, 'That username is taken.');
  }
  const id = newId();
  run('INSERT INTO users (id, username, display_name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)',
    id, username, (displayName || username).slice(0, 32), hashPassword(password), Date.now());
  return { id, token: createSession(id) };
}

function login(username, password) {
  const user = one('SELECT id, password_hash FROM users WHERE username = ?', username || '');
  if (!user || !verifyPassword(password || '', user.password_hash)) {
    throw new HttpError(401, 'Wrong username or password.');
  }
  return { id: user.id, token: createSession(user.id) };
}

function logout(token) {
  run('DELETE FROM sessions WHERE token = ?', token);
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

module.exports = { register, login, logout, userFromToken, HttpError };
