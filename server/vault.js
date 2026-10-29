// Retention vault.
//
// When something is deleted it disappears from Hearth immediately, but an
// encrypted copy is kept here for a limited time so that illegal activity
// can still be investigated and handed to law enforcement when the law
// requires it. Then it is erased automatically.
//
//   - Deleted messages, channels, servers, accounts:  30 days (VAULT_DAYS)
//   - Evidence attached to a report:                   1 year
//     (US law requires preserving child-safety reports for 1 year:
//      18 U.S.C. 2258A as amended by the REPORT Act of 2024)
//   - Anything covered by an active legal hold: kept until the hold is
//     released (e.g. a law-enforcement preservation request under
//     18 U.S.C. 2703(f), 90 days, renewable)
//
// Everything is encrypted (AES-256-GCM, its own key). Only Hearth platform
// admins can open it, and every access is written to the admin log.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');
const { one, all, run, purgeLog } = require('./db');
const { newId } = require('./ids');
const secrets = require('./secrets');

const DAY = 86400000;
const DEFAULT_DAYS = Number(process.env.VAULT_DAYS || 30);
const REPORT_DAYS = 365;
const vaultDir = path.join(config.dataDir, 'vault');
const uploadsDir = path.join(config.dataDir, 'uploads');
fs.mkdirSync(vaultDir, { recursive: true, mode: 0o700 });

// Turn an /uploads/... URL into the file on disk (or null).
function uploadPath(url) {
  const m = /^\/uploads\/(\d+|avatars)\/([A-Za-z0-9_-]{16,})\/([^/]+)$/.exec(String(url || ''));
  if (!m) return null;
  const file = path.join(uploadsDir, m[1], m[2], decodeURIComponent(m[3]));
  return file.startsWith(uploadsDir) && fs.existsSync(file) ? file : null;
}

function attachmentsOf(messageRows) {
  const out = [];
  for (const m of messageRows) {
    if (!m.attachments) continue;
    try { for (const a of JSON.parse(m.attachments)) out.push(a); } catch { /* ignore */ }
  }
  return out;
}

// Save an encrypted copy. files: [{ url, name, type }] from attachments.
function store({ kind, userId = null, serverId = null, label = '', data, files = [], days = DEFAULT_DAYS }) {
  const id = newId();
  const now = Date.now();
  const saved = [];
  if (files.length) {
    const dir = path.join(vaultDir, id);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    files.forEach((f, n) => {
      const src = uploadPath(f.url);
      if (!src) return;
      fs.writeFileSync(path.join(dir, `${n}.bin`), secrets.encrypt('vault', fs.readFileSync(src)), { mode: 0o600 });
      saved.push({ n, name: f.name || path.basename(src), type: f.type || 'application/octet-stream', size: fs.statSync(src).size });
    });
  }
  run(`INSERT INTO vault (id, kind, user_id, server_id, label, payload, files, created_at, purge_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, id, kind, userId, serverId, String(label).slice(0, 200),
  secrets.encrypt('vault', JSON.stringify(data)), JSON.stringify(saved), now, now + days * DAY);
  return id;
}

function isHeld(row) {
  return !!one(
    `SELECT 1 FROM legal_holds WHERE released_at IS NULL AND
       ((target_type = 'user' AND target_id = ?) OR (target_type = 'server' AND target_id = ?))`,
    row.user_id || '', row.server_id || '');
}

function purge() {
  const due = all('SELECT id, user_id, server_id FROM vault WHERE purge_at < ?', Date.now());
  let n = 0;
  for (const row of due) {
    if (isHeld(row)) continue;
    run('DELETE FROM vault WHERE id = ?', row.id);
    fs.rmSync(path.join(vaultDir, row.id), { recursive: true, force: true });
    n++;
  }
  if (n) { purgeLog(); console.log(`[vault] erased ${n} expired item(s)`); }
}
setTimeout(purge, 30 * 1000).unref();
setInterval(purge, 3600 * 1000).unref();

// ---------- admin access (always logged) ----------
function logAccess(adminId, action, target, detail) {
  run('INSERT INTO admin_log (id, admin_id, action, target, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    newId(), adminId, action, target || null, detail ? String(detail).slice(0, 500) : null, Date.now());
}

function list({ userId, serverId, kind } = {}) {
  let sql = 'SELECT id, kind, user_id, server_id, label, files, created_at, purge_at FROM vault WHERE 1=1';
  const args = [];
  if (userId) { sql += ' AND user_id = ?'; args.push(userId); }
  if (serverId) { sql += ' AND server_id = ?'; args.push(serverId); }
  if (kind) { sql += ' AND kind = ?'; args.push(kind); }
  sql += ' ORDER BY created_at DESC LIMIT 200';
  return all(sql, ...args).map((r) => ({
    id: r.id, kind: r.kind, userId: r.user_id, serverId: r.server_id, label: r.label,
    files: JSON.parse(r.files || '[]'), createdAt: r.created_at, purgeAt: r.purge_at, held: isHeld(r),
  }));
}

function open(id, adminId, why) {
  const r = one('SELECT * FROM vault WHERE id = ?', id);
  if (!r) return null;
  logAccess(adminId, 'vault.open', id, why);
  return {
    id: r.id, kind: r.kind, label: r.label, createdAt: r.created_at, purgeAt: r.purge_at,
    files: JSON.parse(r.files || '[]'), data: JSON.parse(secrets.decrypt('vault', r.payload).toString('utf8')),
  };
}

function openFile(id, n, adminId) {
  const r = one('SELECT files FROM vault WHERE id = ?', id);
  if (!r) return null;
  const meta = JSON.parse(r.files || '[]').find((f) => f.n === Number(n));
  if (!meta) return null;
  logAccess(adminId, 'vault.file', `${id}/${n}`, meta.name);
  return { meta, body: secrets.decrypt('vault', fs.readFileSync(path.join(vaultDir, id, `${Number(n)}.bin`))) };
}

// Report evidence can be opened by the moderators who can see that report.
function openForReport(id) {
  const r = one('SELECT * FROM vault WHERE id = ?', id);
  if (!r) return null;
  return JSON.parse(secrets.decrypt('vault', r.payload).toString('utf8'));
}

// ---------- legal holds ----------
function placeHold(targetType, targetId, label, reason, adminId) {
  const id = newId();
  run(`INSERT INTO legal_holds (id, target_type, target_id, label, reason, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`, id, targetType, targetId, label || null, String(reason).slice(0, 1000), adminId, Date.now());
  logAccess(adminId, 'hold.place', `${targetType}:${targetId}`, reason);
  return id;
}

function releaseHold(id, adminId) {
  run('UPDATE legal_holds SET released_at = ? WHERE id = ? AND released_at IS NULL', Date.now(), id);
  logAccess(adminId, 'hold.release', id);
}

function holds() {
  return all('SELECT * FROM legal_holds ORDER BY created_at DESC LIMIT 200').map((h) => ({
    id: h.id, targetType: h.target_type, targetId: h.target_id, label: h.label, reason: h.reason,
    createdBy: h.created_by, createdAt: h.created_at, releasedAt: h.released_at,
  }));
}

module.exports = {
  store, list, open, openFile, openForReport, placeHold, releaseHold, holds, logAccess, attachmentsOf,
  DEFAULT_DAYS, REPORT_DAYS,
};
