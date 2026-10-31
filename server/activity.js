// What's happening on this Hearth, for its admins: new accounts, new
// servers, people joining servers, Discord imports. Shown in the admin
// panel's Activity tab and (optionally) emailed to admins.
//
// Only names and counts are recorded, never message content. Entries are
// kept 30 days, and an account's entries are removed when it's deleted.
'use strict';
const { one, all, run } = require('./db');
const { newId } = require('./ids');
const bus = require('./bus');

const KEEP_MS = 30 * 24 * 3600 * 1000;
const LABELS = {
  'user.register': 'New account',
  'server.create': 'New server',
  'server.import': 'Server moved from Discord',
  'server.delete': 'Server deleted',
  'member.join': 'Joined a server',
  'user.delete': 'Account deleted',
};
// What's worth an email right away (joins only go in the daily summary).
const ALERT_NOW = new Set(['user.register', 'server.create', 'server.import']);

function record(kind, { userId = null, serverId = null, detail = {} } = {}) {
  const row = { id: newId(), kind, user_id: userId, server_id: serverId, detail: JSON.stringify(detail), created_at: Date.now() };
  run('INSERT INTO activity (id, kind, user_id, server_id, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    row.id, row.kind, row.user_id, row.server_id, row.detail, row.created_at);
  bus.publish('admins', { t: 'ADMIN_ACTIVITY', d: view(row) });
  if (ALERT_NOW.has(kind)) scheduleInstant();
}

function view(r) {
  return { id: r.id, kind: r.kind, label: LABELS[r.kind] || r.kind, userId: r.user_id, serverId: r.server_id, detail: JSON.parse(r.detail || '{}'), createdAt: r.created_at };
}

function list({ before, limit = 50 } = {}) {
  const rows = before
    ? all('SELECT * FROM activity WHERE created_at < ? ORDER BY created_at DESC LIMIT ?', Number(before), limit)
    : all('SELECT * FROM activity ORDER BY created_at DESC LIMIT ?', limit);
  return rows.map(view);
}

function unseenCount(adminId) {
  const u = one('SELECT admin_seen_at FROM users WHERE id = ?', adminId);
  return one('SELECT COUNT(*) AS n FROM activity WHERE created_at > ?', u ? u.admin_seen_at : 0).n;
}

function markSeen(adminId) { run('UPDATE users SET admin_seen_at = ? WHERE id = ?', Date.now(), adminId); }

// Totals for the top of the Activity tab.
function summary() {
  const day = Date.now() - 24 * 3600 * 1000; const week = Date.now() - 7 * 24 * 3600 * 1000;
  const count = (kind, since) => one('SELECT COUNT(*) AS n FROM activity WHERE kind = ? AND created_at > ?', kind, since).n;
  return {
    accounts: one('SELECT COUNT(*) AS n FROM users WHERE is_system = 0').n,
    servers: one('SELECT COUNT(*) AS n FROM servers').n,
    newAccounts: { day: count('user.register', day), week: count('user.register', week) },
    newServers: { day: count('server.create', day) + count('server.import', day), week: count('server.create', week) + count('server.import', week) },
    joins: { day: count('member.join', day), week: count('member.join', week) },
  };
}

// Deleting an account removes what the feed said about it.
function forgetUser(userId) { run('DELETE FROM activity WHERE user_id = ?', userId); }

// ---------- email alerts ----------
// "instant": a short email a few minutes after something happens (batched,
// so a burst of sign-ups is one email). "daily": one summary a day.
// Several server nodes may run this; the conditional UPDATE makes sure only
// one of them sends each email.
let instantTimer = null;
const INSTANT_DELAY = Number(process.env.ALERT_DELAY_MS || 3 * 60 * 1000);
function scheduleInstant() {
  if (instantTimer) return;
  instantTimer = setTimeout(() => { instantTimer = null; sendAlerts('instant').catch((e) => console.error('[alerts]', e.message)); }, INSTANT_DELAY);
  instantTimer.unref();
}

async function sendAlerts(mode) {
  const mailer = require('./mailer');
  if (!mailer.canSend()) return;
  const secrets = require('./secrets');
  const admins = all(`SELECT id, username, email_enc, admin_alert_at FROM users
                      WHERE is_admin = 1 AND admin_alerts = ? AND email_enc IS NOT NULL AND email_verified_at IS NOT NULL`, mode);
  for (const a of admins) {
    const now = Date.now();
    if (mode === 'daily' && now - a.admin_alert_at < 23.5 * 3600 * 1000) continue;
    const since = mode === 'daily' ? Math.max(a.admin_alert_at, now - 24 * 3600 * 1000) : a.admin_alert_at;
    const rows = all('SELECT * FROM activity WHERE created_at > ? AND created_at <= ? ORDER BY created_at', since, now)
      .filter((r) => mode === 'daily' || ALERT_NOW.has(r.kind));
    if (!rows.length) {
      if (mode === 'daily') run('UPDATE users SET admin_alert_at = ? WHERE id = ? AND admin_alert_at = ?', now, a.id, a.admin_alert_at);
      continue;
    }
    // Claim this batch; if another node already did, skip.
    if (!run('UPDATE users SET admin_alert_at = ? WHERE id = ? AND admin_alert_at = ?', now, a.id, a.admin_alert_at).changes) continue;
    const lines = rows.map((r) => `- ${new Date(r.created_at).toUTCString()}: ${describe(view(r))}`);
    const counts = {};
    for (const r of rows) counts[LABELS[r.kind] || r.kind] = (counts[LABELS[r.kind] || r.kind] || 0) + 1;
    const head = Object.entries(counts).map(([k, n]) => `${n} × ${k}`).join(', ');
    try {
      await mailer.sendMail({
        to: secrets.decryptText('email', a.email_enc),
        subject: mode === 'daily' ? `Hearth daily summary: ${head}` : `Hearth: ${head}`,
        text: `Hi ${a.username},\n\nHere's what happened on Hearth${mode === 'daily' ? ' in the last day' : ''}:\n\n${lines.join('\n')}\n\n`
          + 'Open Hearth and tap the shield (Hearth admin) > Activity for details.\n\n'
          + 'You get these because you turned on admin email alerts. Change or turn them off in the Activity tab.\n',
      });
    } catch (e) { console.error('[alerts] could not send:', e.message); }
  }
}

function describe(a) {
  const d = a.detail;
  switch (a.kind) {
    case 'user.register': return `New account @${d.username}`;
    case 'server.create': return `@${d.owner} created the server "${d.name}"`;
    case 'server.import': return `@${d.owner} moved "${d.name}" from Discord (${d.messages || 0} messages)`;
    case 'server.delete': return `The server "${d.name}" was deleted`;
    case 'member.join': return `@${d.username} joined "${d.server}"`;
    case 'user.delete': return 'An account was deleted';
    default: return a.label;
  }
}

setInterval(() => {
  run('DELETE FROM activity WHERE created_at < ?', Date.now() - KEEP_MS);
  sendAlerts('daily').catch((e) => console.error('[alerts]', e.message));
}, 3600 * 1000).unref();

module.exports = { record, list, unseenCount, markSeen, summary, forgetUser, sendAlerts, describe, LABELS };
