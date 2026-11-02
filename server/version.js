// Identifies this exact version of Hearth's web app, so open apps can tell
// when the server has been updated and offer a refresh.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const config = require('./config');

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir).sort()) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}

let build = 'dev';
try {
  const h = crypto.createHash('sha256');
  for (const f of walk(config.publicDir)) { h.update(path.relative(config.publicDir, f)); h.update(fs.readFileSync(f)); }
  build = h.digest('hex').slice(0, 12);
} catch { /* leave as dev */ }

const pkg = (() => { try { return require('../package.json'); } catch { return {}; } })();
module.exports = { build, version: pkg.version || '0.0.0' };
