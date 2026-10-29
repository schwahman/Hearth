// Encryption for sensitive data at rest (email addresses, the retention
// vault). One random 256-bit master key lives in DATA_DIR/keys/master.key,
// readable only by the Hearth service. Separate keys for each purpose are
// derived from it with HKDF, so one use can never decrypt another's data.
//
// Note: keys sit on the same server as the database. This protects against
// a leaked or copied database file, not against someone with full control
// of the server. Moving the master key to a separate secrets store is a
// future step for larger deployments.
'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');

const keyDir = path.join(config.dataDir, 'keys');
const keyFile = path.join(keyDir, 'master.key');

function loadMaster() {
  fs.mkdirSync(keyDir, { recursive: true, mode: 0o700 });
  if (!fs.existsSync(keyFile)) {
    fs.writeFileSync(keyFile, crypto.randomBytes(32), { mode: 0o600, flag: 'wx' });
  }
  const key = fs.readFileSync(keyFile);
  if (key.length !== 32) throw new Error('master.key is corrupt');
  return key;
}

const master = loadMaster();
const derived = new Map();
function subkey(purpose) {
  if (!derived.has(purpose)) {
    derived.set(purpose, Buffer.from(crypto.hkdfSync('sha256', master, Buffer.alloc(0), `hearth:${purpose}`, 32)));
  }
  return derived.get(purpose);
}

// AES-256-GCM. Output: version(1) | iv(12) | tag(16) | ciphertext
function encrypt(purpose, data) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', subkey(purpose), iv);
  const body = Buffer.concat([cipher.update(Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8')), cipher.final()]);
  return Buffer.concat([Buffer.from([1]), iv, cipher.getAuthTag(), body]);
}

function decrypt(purpose, blob) {
  const b = Buffer.from(blob);
  if (b[0] !== 1) throw new Error('unknown format');
  const decipher = crypto.createDecipheriv('aes-256-gcm', subkey(purpose), b.subarray(1, 13));
  decipher.setAuthTag(b.subarray(13, 29));
  return Buffer.concat([decipher.update(b.subarray(29)), decipher.final()]);
}

const encryptText = (purpose, text) => encrypt(purpose, text).toString('base64');
const decryptText = (purpose, b64) => decrypt(purpose, Buffer.from(b64, 'base64')).toString('utf8');

// Keyed hash for looking things up (e.g. "is this email registered?")
// without storing the value in readable form.
function lookupHash(purpose, value) {
  return crypto.createHmac('sha256', subkey(`${purpose}:lookup`)).update(value).digest('hex');
}

module.exports = { encrypt, decrypt, encryptText, decryptText, lookupHash };
