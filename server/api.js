// REST API. Clients use these endpoints to change things; the resulting
// events are published on the bus so everyone else sees them live.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const config = require('./config');
const { one, all, run, tx, purgeLog } = require('./db');
const { newId, randomCode } = require('./ids');
const { P, ALL, DEFAULT_EVERYONE, memberPermissions, channelPermissions, topPosition, outranks, has, ageBlock } = require('./permissions');
const auth = require('./auth');
const { HttpError } = auth;
const ser = require('./serialize');
const bus = require('./bus');
const state = require('./state');
const vault = require('./vault');
const secrets = require('./secrets');

const uploadsDir = path.join(config.dataDir, 'uploads');
fs.mkdirSync(uploadsDir, { recursive: true });

// ---------- tiny router ----------
const routes = [];
function route(method, pattern, handler, { public: isPublic = false, raw = false } = {}) {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, handler, isPublic, raw });
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  for (const r of routes) {
    if (r.method !== req.method) continue;
    const m = url.pathname.match(r.re);
    if (!m) continue;
    const params = {};
    r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
    try {
      const { token, viaCookie } = tokenFrom(req);
      // Changes made with the login cookie must come from our own pages,
      // which blocks cross-site request forgery. Requests from other sites
      // are always refused; bearer-token API clients can't be forged by a
      // website, so they're exempt.
      if (req.method !== 'GET' && !(token && !viaCookie)) checkOrigin(req, !(viaCookie && !r.isPublic));
      const user = auth.userFromToken(token);
      if (!r.isPublic && !user) throw new HttpError(401, 'Not logged in.');
      const body = r.raw || req.method === 'GET' ? null : await readJson(req);
      const result = await r.handler({ req, res, params, query: url.searchParams, body, user, token });
      if (!res.headersSent) sendJson(res, result === undefined ? 204 : 200, result);
    } catch (err) {
      if (!(err instanceof HttpError)) console.error(err);
      if (err.headers && !res.headersSent) for (const [k, v] of Object.entries(err.headers)) res.setHeader(k, v);
      if (!res.headersSent) sendJson(res, err.status || 500, { error: err.status ? err.message : 'Server error.', ...(err.extra || {}) });
    }
    return true;
  }
  return false;
}

function tokenFrom(req) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) return { token: h.slice(7), viaCookie: false };
  const c = cookie(req, 'hearth_token');
  return { token: c, viaCookie: !!c };
}

// The Origin header names the site that made the request. Browsers always
// send it on cross-site requests and on same-site POST/PUT/PATCH/DELETE.
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return null;
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}
function checkOrigin(req, allowMissing) {
  const same = sameOrigin(req);
  if (same === false || (same === null && !allowMissing)) {
    throw new HttpError(403, 'Request blocked: it did not come from this site.');
  }
}

function clientIp(req) {
  if (config.trustProxy) {
    const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (fwd) return fwd;
  }
  return req.socket.remoteAddress || 'unknown';
}

function cookie(req, name) {
  const c = req.headers.cookie || '';
  for (const part of c.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

function readJson(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, 'Request too large.')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new HttpError(400, 'Invalid JSON.')); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  if (status === 204) { res.writeHead(204); return res.end(); }
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function setSessionCookie(req, res, token) {
  const secure = req.socket.encrypted ? '; Secure' : '';
  const value = token ? encodeURIComponent(token) : '';
  const maxAge = token ? 60 * 60 * 24 * 365 : 0; // the server enforces the real expiry
  res.setHeader('Set-Cookie', `hearth_token=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`);
}

// ---------- access helpers ----------
function str(v, field, min, max) {
  if (typeof v !== 'string') throw new HttpError(400, `${field} is required.`);
  const s = v.trim();
  if (s.length < min || s.length > max) throw new HttpError(400, `${field} must be ${min}-${max} characters.`);
  return s;
}

function requireServerPerm(serverId, userId, flag) {
  const perms = memberPermissions(serverId, userId);
  if (!perms) throw new HttpError(404, 'Server not found.');
  if (flag && !has(perms, flag)) throw new HttpError(403, 'You do not have permission to do that.');
  return perms;
}

// Returns { channel, perms } if the user can see the channel.
function channelAccess(channelId, userId, flag) {
  const channel = one('SELECT * FROM channels WHERE id = ?', channelId);
  if (!channel) throw new HttpError(404, 'Channel not found.');
  let perms;
  if (channel.type === 'dm') {
    if (!one('SELECT 1 FROM dm_recipients WHERE channel_id = ? AND user_id = ?', channelId, userId)) {
      throw new HttpError(404, 'Channel not found.');
    }
    perms = P.VIEW_CHANNELS | P.SEND_MESSAGES | P.ATTACH_FILES | P.ADD_REACTIONS |
            P.CONNECT | P.SPEAK | P.VIDEO;
  } else {
    const blocked = ageBlock(channel, userId);
    if (blocked && memberPermissions(channel.server_id, userId)) {
      const e = new HttpError(403, `This channel is for people ${blocked.required} and older.`);
      e.extra = { code: 'age_restricted', required: blocked.required, needsBirthdate: !blocked.known };
      throw e;
    }
    perms = channelPermissions(channel, userId);
    if (!has(perms, P.VIEW_CHANNELS)) throw new HttpError(404, 'Channel not found.');
  }
  if (flag && !has(perms, flag)) throw new HttpError(403, 'You do not have permission to do that.');
  return { channel, perms };
}

function topicFor(channel) {
  return channel.type === 'dm' ? `channel:${channel.id}` : `server:${channel.server_id}`;
}

// ---------- config & auth ----------
route('GET', '/api/config', () => ({ iceServers: config.iceServers, openRegistration: config.openRegistration }),
  { public: true });

function meta(req) {
  return { ip: clientIp(req), userAgent: String(req.headers['user-agent'] || '') };
}

// The login token goes only into an HttpOnly cookie that page scripts can't
// read. API clients that need it (bots, tests) can ask with returnToken.
function loginResponse(req, res, body, id, token) {
  setSessionCookie(req, res, token);
  const out = { user: ser.user(one('SELECT * FROM users WHERE id = ?', id)) };
  if (body.returnToken === true) out.token = token;
  return out;
}

route('POST', '/api/auth/register', async ({ req, res, body }) => {
  if (!config.openRegistration && one('SELECT 1 FROM users LIMIT 1')) {
    throw new HttpError(403, 'Registration is closed on this server.');
  }
  const { id, token } = await auth.register(body.username, body.password, body.displayName, meta(req), body.acceptTerms, body.email, body.birthdate);
  return loginResponse(req, res, body, id, token);
}, { public: true });

route('POST', '/api/auth/login', async ({ req, res, body }) => {
  const { id, token } = await auth.login(body.username, body.password, meta(req));
  return loginResponse(req, res, body, id, token);
}, { public: true });

route('POST', '/api/auth/logout', ({ req, res, token }) => {
  auth.revokeSession(token);
  setSessionCookie(req, res, null);
});

// Signs out every device, including this one.
route('POST', '/api/auth/logout-all', ({ req, res, user }) => {
  auth.revokeAllSessions(user.id);
  setSessionCookie(req, res, null);
  bus.publish(`user:${user.id}`, { t: 'SESSIONS_REVOKED', d: {} });
});

route('POST', '/api/users/@me/password', async ({ user, body, token }) => {
  await auth.changePassword(user.id, body.currentPassword, body.newPassword, token);
  bus.publish(`user:${user.id}`, { t: 'SESSIONS_REVOKED', d: {} });
  return { ok: true };
});

// Permanently deletes the account and everything it created: messages,
// uploads, reactions, invites, memberships, sessions. There is no undo.
route('DELETE', '/api/users/@me', async ({ req, res, user, body }) => {
  if (body.confirm !== 'DELETE') throw new HttpError(400, 'To confirm, type DELETE in capital letters.');
  const row = one('SELECT password_hash, avatar FROM users WHERE id = ?', user.id);
  const { ok } = await auth.verifyPassword(String(body.password || ''), row.password_hash);
  if (!ok) throw new HttpError(403, 'Your password is incorrect.');
  const owned = all('SELECT name FROM servers WHERE owner_id = ?', user.id);
  if (owned.length) {
    throw new HttpError(409, `You still own: ${owned.map((o) => o.name).join(', ')}. Delete those servers or give them to another member first.`);
  }
  const serverIds = all('SELECT server_id FROM members WHERE user_id = ?', user.id).map((r) => r.server_id);
  const dmIds = all('SELECT channel_id FROM dm_recipients WHERE user_id = ?', user.id).map((r) => r.channel_id);
  const files = all('SELECT attachments FROM messages WHERE author_id = ? AND attachments IS NOT NULL', user.id);
  {
    const u = one('SELECT * FROM users WHERE id = ?', user.id);
    const msgs = all('SELECT * FROM messages WHERE author_id = ?', user.id);
    vault.store({
      kind: 'account', userId: user.id, label: `Account @${u.username}`,
      data: {
        account: {
          id: u.id, username: u.username, displayName: u.display_name, createdAt: u.created_at,
          email: u.email_enc ? secrets.decryptText('email', u.email_enc) : null, emailVerified: !!u.email_verified_at,
        },
        deletedAt: Date.now(),
        lastKnownDevices: auth.listSessions(user.id).map((x) => ({ device: x.userAgent, ip: x.ip, lastSeen: x.lastSeen })),
        servers: all('SELECT server_id FROM members WHERE user_id = ?', user.id).map((r) => r.server_id),
        messages: messageSnapshot(msgs),
      },
      files: vault.attachmentsOf(msgs),
    });
  }

  tx(() => {
    run('DELETE FROM reactions WHERE user_id = ?', user.id);
    run('DELETE FROM messages WHERE author_id = ?', user.id);
    run('DELETE FROM invites WHERE creator_id = ?', user.id);
    run('DELETE FROM member_roles WHERE user_id = ?', user.id);
    run('DELETE FROM users WHERE id = ?', user.id); // cascades: sessions, memberships, DMs, bans
    // DM conversations with nobody left in them go too.
    run(`DELETE FROM channels WHERE type = 'dm' AND id NOT IN (SELECT channel_id FROM dm_recipients)`);
  });
  for (const f of files) deleteMessageFiles(f);
  if (row.avatar) deleteUploadUrl(row.avatar);
  purgeLog();

  const gone = { userId: user.id };
  for (const id of serverIds) {
    bus.publish(`server:${id}`, { t: 'MEMBER_REMOVE', d: { serverId: id, userId: user.id } });
    bus.publish(`server:${id}`, { t: 'USER_DELETE', d: gone });
  }
  for (const id of dmIds) bus.publish(`channel:${id}`, { t: 'USER_DELETE', d: gone });
  bus.publish(`user:${user.id}`, { t: 'SESSIONS_REVOKED', d: {} });
  setSessionCookie(req, res, null);
  console.log(`[delete] account ${user.id} permanently deleted at the user's request`);
});

// Everything Hearth stores about you, as one JSON file.
route('GET', '/api/users/@me/export', ({ res, user, token }) => {
  const u = one('SELECT id, username, display_name, avatar, created_at, terms_accepted_at FROM users WHERE id = ?', user.id);
  const where = (channelId) => {
    const c = one('SELECT * FROM channels WHERE id = ?', channelId);
    if (!c) return 'deleted channel';
    if (c.type === 'dm') {
      const others = all('SELECT u.username FROM dm_recipients d JOIN users u ON u.id = d.user_id WHERE d.channel_id = ? AND d.user_id != ?', c.id, user.id);
      return `Direct message with ${others.map((o) => o.username).join(', ') || 'a deleted user'}`;
    }
    const srv = one('SELECT name FROM servers WHERE id = ?', c.server_id);
    return `${srv ? srv.name : 'server'} / #${c.name}`;
  };
  const data = {
    exportedAt: new Date().toISOString(),
    account: {
      id: u.id, username: u.username, displayName: u.display_name, avatar: u.avatar,
      createdAt: new Date(u.created_at).toISOString(),
      termsAcceptedAt: u.terms_accepted_at ? new Date(u.terms_accepted_at).toISOString() : null,
      note: 'Your password is not included because Hearth never stores it, only a one-way hash.',
    },
    servers: all(`SELECT s.id, s.name, s.owner_id, m.nickname, m.joined_at FROM members m JOIN servers s ON s.id = m.server_id WHERE m.user_id = ?`, user.id)
      .map((r) => ({
        id: r.id, name: r.name, youOwnIt: r.owner_id === user.id, nickname: r.nickname,
        joinedAt: new Date(r.joined_at).toISOString(),
        roles: all('SELECT r.name FROM member_roles mr JOIN roles r ON r.id = mr.role_id WHERE mr.server_id = ? AND mr.user_id = ?', r.id, user.id).map((x) => x.name),
      })),
    messages: all('SELECT * FROM messages WHERE author_id = ? ORDER BY CAST(id AS INTEGER)', user.id).map((m) => ({
      id: m.id, where: where(m.channel_id), content: m.content,
      attachments: m.attachments ? JSON.parse(m.attachments) : [],
      sentAt: new Date(m.created_at).toISOString(), editedAt: m.edited_at ? new Date(m.edited_at).toISOString() : null,
    })),
    reactions: all('SELECT message_id, emoji FROM reactions WHERE user_id = ?', user.id),
    signedInDevices: auth.listSessions(user.id, token).map((x) => ({
      device: x.userAgent, ipAddress: x.ip, lastActive: new Date(x.lastSeen).toISOString(), signedIn: new Date(x.createdAt).toISOString(),
    })),
  };
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Disposition': `attachment; filename="hearth-data-${u.username}.json"`,
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(data, null, 2));
});

route('GET', '/api/users/@me/sessions', ({ user, token }) => auth.listSessions(user.id, token));

route('DELETE', '/api/users/@me/sessions/:id', ({ user, params }) => {
  auth.revokeSessionById(user.id, params.id);
  bus.publish(`user:${user.id}`, { t: 'SESSIONS_REVOKED', d: {} });
});

route('GET', '/api/users/@me', ({ user }) => ser.me(user.id));

// ---------- email and account recovery ----------
route('POST', '/api/auth/forgot', async ({ req, body }) => {
  await auth.forgotPassword(body.identifier, meta(req));
  return { ok: true, message: 'If that account has a verified email, a reset code is on its way.' };
}, { public: true });

route('POST', '/api/auth/reset', async ({ req, res, body }) => {
  const { id, token } = await auth.resetPassword(body, meta(req));
  bus.publish(`user:${id}`, { t: 'SESSIONS_REVOKED', d: {} });
  return loginResponse(req, res, body, id, token);
}, { public: true });

route('GET', '/api/users/@me/security', ({ user }) => auth.accountSecurity(user.id));
route('POST', '/api/users/@me/birthdate', ({ user, body }) => {
  auth.setBirthdate(user.id, body.date);
  for (const r of all('SELECT server_id FROM members WHERE user_id = ?', user.id)) bus.publish(`user:${user.id}`, { t: 'SERVER_REFRESH', d: { id: r.server_id } });
  return ser.me(user.id);
});
route('POST', '/api/users/@me/email/resend', async ({ user }) => { await auth.resendVerification(user.id); return { ok: true }; });
route('POST', '/api/users/@me/email/verify', ({ user, body }) => { auth.verifyEmail(user.id, body.code); return auth.accountSecurity(user.id); });
route('POST', '/api/users/@me/email', async ({ user, body }) => {
  const r = await auth.requestEmailChange(user.id, body.password, body.email);
  return { ...r, security: auth.accountSecurity(user.id), me: ser.me(user.id) };
});
route('POST', '/api/users/@me/email/confirm', ({ user, body }) => { auth.confirmEmailChange(user.id, body.code); return auth.accountSecurity(user.id); });
route('POST', '/api/users/@me/recovery-codes', async ({ user, body }) => ({ codes: await auth.generateRecoveryCodes(user.id, body.password) }));

route('PATCH', '/api/users/@me', ({ user, body }) => {
  if (body.displayName !== undefined) {
    run('UPDATE users SET display_name = ? WHERE id = ?', str(body.displayName, 'Display name', 1, 32), user.id);
  }
  if (body.avatar !== undefined) {
    const old = one('SELECT avatar FROM users WHERE id = ?', user.id).avatar;
    run('UPDATE users SET avatar = ? WHERE id = ?', checkUploadUrl(body.avatar), user.id);
    if (old && old !== body.avatar) deleteUploadUrl(old);
  }
  const updated = ser.user(one('SELECT * FROM users WHERE id = ?', user.id));
  for (const s of all('SELECT server_id FROM members WHERE user_id = ?', user.id)) {
    bus.publish(`server:${s.server_id}`, { t: 'USER_UPDATE', d: updated });
  }
  bus.publish(`user:${user.id}`, { t: 'USER_UPDATE', d: updated });
  return updated;
});

// ---------- servers ----------
route('POST', '/api/servers', ({ user, body }) => {
  const name = str(body.name, 'Server name', 1, 64);
  const serverId = newId();
  tx(() => {
    const now = Date.now();
    run('INSERT INTO servers (id, name, owner_id, created_at) VALUES (?, ?, ?, ?)', serverId, name, user.id, now);
    run('INSERT INTO members (server_id, user_id, joined_at) VALUES (?, ?, ?)', serverId, user.id, now);
    run(`INSERT INTO roles (id, server_id, name, permissions, position, is_default)
         VALUES (?, ?, '@everyone', ?, 0, 1)`, newId(), serverId, DEFAULT_EVERYONE);
    run(`INSERT INTO channels (id, server_id, name, type, position, created_at) VALUES (?, ?, 'general', 'text', 0, ?)`,
      newId(), serverId, now);
    run(`INSERT INTO channels (id, server_id, name, type, position, created_at) VALUES (?, ?, 'General', 'voice', 1, ?)`,
      newId(), serverId, now);
  });
  const payload = ser.server(serverId, user.id);
  bus.publish(`user:${user.id}`, { t: 'SERVER_CREATE', d: payload });
  return payload;
});

route('GET', '/api/servers/:id', ({ user, params }) => {
  requireServerPerm(params.id, user.id);
  return ser.server(params.id, user.id);
});

route('PATCH', '/api/servers/:id', ({ user, params, body }) => {
  requireServerPerm(params.id, user.id, P.MANAGE_SERVER);
  if (body.name !== undefined) run('UPDATE servers SET name = ? WHERE id = ?', str(body.name, 'Server name', 1, 64), params.id);
  if (body.ageRating !== undefined) {
    run('UPDATE servers SET age_rating = ? WHERE id = ?', [0, 18, 21].includes(Number(body.ageRating)) ? Number(body.ageRating) : 0, params.id);
    permsChanged(params.id);
  }
  if (body.icon !== undefined) {
    const old = one('SELECT icon FROM servers WHERE id = ?', params.id).icon;
    run('UPDATE servers SET icon = ? WHERE id = ?', checkUploadUrl(body.icon), params.id);
    if (old && old !== body.icon) deleteUploadUrl(old);
  }
  const s = one('SELECT id, name, icon FROM servers WHERE id = ?', params.id);
  bus.publish(`server:${params.id}`, { t: 'SERVER_UPDATE', d: { id: s.id, name: s.name, icon: s.icon } });
  audit(params.id, user.id, 'server.update', { type: 'server', id: s.id, name: s.name });
  return s;
});

// Permanently deletes a server: every channel, message, role, invite and
// uploaded file. There is no undo and no backup copy is kept.
route('DELETE', '/api/servers/:id', ({ user, params, body }) => {
  const s = one('SELECT owner_id, name, icon FROM servers WHERE id = ?', params.id);
  if (!s || s.owner_id !== user.id) throw new HttpError(403, 'Only the owner can delete a server.');
  if (body.confirmName !== s.name) {
    throw new HttpError(400, 'To confirm, type the server name exactly as it appears.');
  }
  deleteServerData(params.id, s, user.id);
  purgeLog();
  console.log(`[delete] server ${params.id} permanently deleted by its owner`);
});

// ---------- retention snapshots (see vault.js) ----------
function messageSnapshot(rows) {
  return rows.map((m) => ({
    id: m.id, channelId: m.channel_id, authorId: m.author_id, author: userName(m.author_id),
    content: m.content, attachments: m.attachments ? JSON.parse(m.attachments) : [],
    createdAt: m.created_at, editedAt: m.edited_at,
  }));
}

function vaultServer(serverId, deletedBy) {
  const s = one('SELECT * FROM servers WHERE id = ?', serverId);
  const channels = all('SELECT * FROM channels WHERE server_id = ?', serverId);
  const msgs = all('SELECT m.* FROM messages m JOIN channels c ON c.id = m.channel_id WHERE c.server_id = ?', serverId);
  vault.store({
    kind: 'server', serverId, userId: s.owner_id, label: `Server "${s.name}"`,
    data: {
      server: { id: s.id, name: s.name, ownerId: s.owner_id, owner: userName(s.owner_id), createdAt: s.created_at },
      deletedBy, deletedAt: Date.now(),
      channels: channels.map((c) => ({ id: c.id, name: c.name, type: c.type })),
      roles: all('SELECT id, name, permissions FROM roles WHERE server_id = ?', serverId),
      members: all('SELECT m.user_id, u.username FROM members m LEFT JOIN users u ON u.id = m.user_id WHERE m.server_id = ?', serverId),
      messages: messageSnapshot(msgs),
    },
    files: vault.attachmentsOf(msgs),
  });
}

function deleteServerData(serverId, s, deletedBy) {
  vaultServer(serverId, deletedBy);
  bus.publish(`server:${serverId}`, { t: 'SERVER_DELETE', d: { id: serverId } });
  const channelIds = all('SELECT id FROM channels WHERE server_id = ?', serverId).map((c) => c.id);
  run('DELETE FROM servers WHERE id = ?', serverId); // cascades to channels, messages, roles, members, invites, bans
  for (const id of channelIds) deleteChannelFiles(id);
  if (s.icon) deleteUploadUrl(s.icon);
}

// Give the server to another member (needed before deleting your account).
route('POST', '/api/servers/:id/transfer', async ({ user, params, body }) => {
  const s = one('SELECT owner_id FROM servers WHERE id = ?', params.id);
  if (!s || s.owner_id !== user.id) throw new HttpError(403, 'Only the owner can transfer a server.');
  const { ok } = await auth.verifyPassword(String(body.password || ''), one('SELECT password_hash FROM users WHERE id = ?', user.id).password_hash);
  if (!ok) throw new HttpError(403, 'Your password is incorrect.');
  if (body.userId === user.id || !one('SELECT 1 FROM members WHERE server_id = ? AND user_id = ?', params.id, String(body.userId))) {
    throw new HttpError(400, 'Pick another member of this server.');
  }
  run('UPDATE servers SET owner_id = ? WHERE id = ?', String(body.userId), params.id);
  bus.publish(`server:${params.id}`, { t: 'SERVER_UPDATE', d: { id: params.id, ownerId: String(body.userId) } });
  return { ok: true };
});

function removeMember(serverId, userId) {
  run('DELETE FROM member_roles WHERE server_id = ? AND user_id = ?', serverId, userId);
  run('DELETE FROM members WHERE server_id = ? AND user_id = ?', serverId, userId);
  bus.publish(`server:${serverId}`, { t: 'MEMBER_REMOVE', d: { serverId, userId } });
  bus.publish(`user:${userId}`, { t: 'SERVER_DELETE', d: { id: serverId } });
}

route('DELETE', '/api/servers/:id/members/@me', ({ user, params }) => {
  requireServerPerm(params.id, user.id);
  if (one('SELECT 1 FROM servers WHERE id = ? AND owner_id = ?', params.id, user.id)) {
    throw new HttpError(400, 'The owner cannot leave. Delete the server instead.');
  }
  removeMember(params.id, user.id);
});

function guardTarget(serverId, actorId, targetId) {
  const s = one('SELECT owner_id FROM servers WHERE id = ?', serverId);
  if (targetId === s.owner_id) throw new HttpError(403, 'You cannot do that to the server owner.');
  if (targetId === actorId) throw new HttpError(400, 'You cannot do that to yourself.');
  if (one('SELECT 1 FROM members WHERE server_id = ? AND user_id = ?', serverId, targetId) && !outranks(serverId, actorId, targetId)) {
    throw new HttpError(403, 'Their highest role is the same as or above yours.');
  }
}

// ---------- moderation audit log ----------
function audit(serverId, actorId, action, target = {}, reason = '') {
  run(`INSERT INTO audit_log (id, server_id, actor_id, action, target_type, target_id, target_name, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, newId(), serverId, actorId, action,
    target.type || null, target.id || null, target.name ? String(target.name).slice(0, 100) : null,
    reason ? String(reason).slice(0, 500) : null, Date.now());
}
const userName = (id) => (one('SELECT username FROM users WHERE id = ?', id) || {}).username || 'deleted user';
// Audit entries are kept 90 days.
setInterval(() => run('DELETE FROM audit_log WHERE created_at < ?', Date.now() - 90 * 86400000), 3600 * 1000).unref();

route('GET', '/api/servers/:id/audit-log', ({ user, params }) => {
  requireServerPerm(params.id, user.id, P.VIEW_AUDIT_LOG);
  return all('SELECT * FROM audit_log WHERE server_id = ? ORDER BY created_at DESC LIMIT 200', params.id).map((a) => ({
    id: a.id, action: a.action, actor: a.actor_id ? userName(a.actor_id) : 'system',
    targetType: a.target_type, targetId: a.target_id, targetName: a.target_name, reason: a.reason, createdAt: a.created_at,
  }));
});

route('DELETE', '/api/servers/:id/members/:userId', ({ user, params, body }) => {
  requireServerPerm(params.id, user.id, P.KICK_MEMBERS);
  guardTarget(params.id, user.id, params.userId);
  if (!one('SELECT 1 FROM members WHERE server_id = ? AND user_id = ?', params.id, params.userId)) {
    throw new HttpError(404, 'Member not found.');
  }
  removeMember(params.id, params.userId);
  audit(params.id, user.id, 'member.kick', { type: 'user', id: params.userId, name: userName(params.userId) }, body.reason);
});

route('GET', '/api/servers/:id/bans', ({ user, params }) => {
  requireServerPerm(params.id, user.id, P.BAN_MEMBERS);
  return all(`SELECT b.user_id, b.reason, u.username, u.display_name FROM bans b LEFT JOIN users u ON u.id = b.user_id
              WHERE b.server_id = ?`, params.id)
    .map((b) => ({ userId: b.user_id, username: b.username, displayName: b.display_name, reason: b.reason }));
});

route('PUT', '/api/servers/:id/bans/:userId', ({ user, params, body }) => {
  requireServerPerm(params.id, user.id, P.BAN_MEMBERS);
  guardTarget(params.id, user.id, params.userId);
  if (!one('SELECT 1 FROM users WHERE id = ?', params.userId)) throw new HttpError(404, 'User not found.');
  run('INSERT OR REPLACE INTO bans (server_id, user_id, reason) VALUES (?, ?, ?)',
    params.id, params.userId, (body.reason || '').slice(0, 256));
  if (one('SELECT 1 FROM members WHERE server_id = ? AND user_id = ?', params.id, params.userId)) {
    removeMember(params.id, params.userId);
  }
  audit(params.id, user.id, 'member.ban', { type: 'user', id: params.userId, name: userName(params.userId) }, body.reason);
});

route('DELETE', '/api/servers/:id/bans/:userId', ({ user, params }) => {
  requireServerPerm(params.id, user.id, P.BAN_MEMBERS);
  run('DELETE FROM bans WHERE server_id = ? AND user_id = ?', params.id, params.userId);
  audit(params.id, user.id, 'member.unban', { type: 'user', id: params.userId, name: userName(params.userId) });
});

// Timeout: the member can still read but can't post, react or use voice.
route('PUT', '/api/servers/:id/members/:userId/timeout', ({ user, params, body }) => {
  requireServerPerm(params.id, user.id, P.MODERATE_MEMBERS);
  guardTarget(params.id, user.id, params.userId);
  const minutes = Math.max(0, Math.min(28 * 24 * 60, Number(body.minutes) || 0));
  const until = minutes ? Date.now() + minutes * 60000 : null;
  run('UPDATE members SET timeout_until = ? WHERE server_id = ? AND user_id = ?', until, params.id, params.userId);
  const m = ser.member(params.id, params.userId);
  if (!m) throw new HttpError(404, 'Member not found.');
  bus.publish(`server:${params.id}`, { t: 'MEMBER_UPDATE', d: { serverId: params.id, member: m } });
  if (until) bus.publish(`user:${params.userId}`, { t: 'VOICE_FORCE_LEAVE_SERVER', d: { serverId: params.id, reason: 'You were timed out.' } });
  audit(params.id, user.id, until ? 'member.timeout' : 'member.timeout_clear',
    { type: 'user', id: params.userId, name: userName(params.userId) }, until ? `${minutes} min${body.reason ? ' \u2014 ' + body.reason : ''}` : body.reason);
  return m;
});

route('PATCH', '/api/servers/:id/members/@me', ({ user, params, body }) => {
  requireServerPerm(params.id, user.id);
  const nick = body.nickname ? str(body.nickname, 'Nickname', 1, 32) : null;
  run('UPDATE members SET nickname = ? WHERE server_id = ? AND user_id = ?', nick, params.id, user.id);
  const m = ser.member(params.id, user.id);
  bus.publish(`server:${params.id}`, { t: 'MEMBER_UPDATE', d: { serverId: params.id, member: m } });
  return m;
});

// ---------- invites ----------
route('POST', '/api/servers/:id/invites', ({ user, params, body }) => {
  requireServerPerm(params.id, user.id, P.CREATE_INVITE);
  const code = randomCode(6);
  const maxUses = body.maxUses ? Math.max(1, Number(body.maxUses) | 0) : null;
  const expiresAt = body.expiresInHours ? Date.now() + Number(body.expiresInHours) * 3600000 : null;
  run(`INSERT INTO invites (code, server_id, creator_id, max_uses, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`, code, params.id, user.id, maxUses, expiresAt, Date.now());
  return { code, maxUses, expiresAt };
});

function validInvite(code) {
  const inv = one('SELECT * FROM invites WHERE code = ?', code);
  if (!inv || (inv.expires_at && inv.expires_at < Date.now()) ||
      (inv.max_uses && inv.uses >= inv.max_uses)) {
    throw new HttpError(404, 'That invite is invalid or has expired.');
  }
  return inv;
}

route('GET', '/api/invites/:code', ({ params }) => {
  const inv = validInvite(params.code);
  const s = one('SELECT id, name, icon FROM servers WHERE id = ?', inv.server_id);
  const count = one('SELECT COUNT(*) AS n FROM members WHERE server_id = ?', inv.server_id).n;
  return { code: inv.code, server: { id: s.id, name: s.name, icon: s.icon, memberCount: count } };
}, { public: true });

route('POST', '/api/invites/:code', ({ user, params }) => {
  const inv = validInvite(params.code);
  const serverId = inv.server_id;
  if (one('SELECT 1 FROM bans WHERE server_id = ? AND user_id = ?', serverId, user.id)) {
    throw new HttpError(403, 'You are banned from this server.');
  }
  const rating = one('SELECT age_rating FROM servers WHERE id = ?', serverId).age_rating;
  if (rating) {
    const { ageOf } = require('./permissions');
    const age = ageOf(user.id);
    if (age === null || age < rating) {
      const e = new HttpError(403, `This server is for people ${rating} and older.`);
      e.extra = { code: 'age_restricted', required: rating, needsBirthdate: age === null };
      throw e;
    }
  }
  if (!one('SELECT 1 FROM members WHERE server_id = ? AND user_id = ?', serverId, user.id)) {
    tx(() => {
      run('INSERT INTO members (server_id, user_id, joined_at) VALUES (?, ?, ?)', serverId, user.id, Date.now());
      run('UPDATE invites SET uses = uses + 1 WHERE code = ?', inv.code);
    });
    bus.publish(`server:${serverId}`, { t: 'MEMBER_ADD', d: { serverId, member: ser.member(serverId, user.id) } });
  }
  const payload = ser.server(serverId, user.id);
  bus.publish(`user:${user.id}`, { t: 'SERVER_CREATE', d: payload });
  return payload;
});

// ---------- channels ----------
route('POST', '/api/servers/:id/channels', ({ user, params, body }) => {
  requireServerPerm(params.id, user.id, P.MANAGE_CHANNELS);
  const type = body.type === 'voice' ? 'voice' : 'text';
  let name = str(body.name, 'Channel name', 1, 64);
  if (type === 'text') name = name.toLowerCase().replace(/\s+/g, '-');
  const pos = one('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM channels WHERE server_id = ?', params.id).p;
  const id = newId();
  run('INSERT INTO channels (id, server_id, name, type, topic, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    id, params.id, name, type, (body.topic || '').slice(0, 256), pos, Date.now());
  const c = ser.channel(one('SELECT * FROM channels WHERE id = ?', id));
  bus.publish(`server:${params.id}`, { t: 'CHANNEL_CREATE', d: c });
  audit(params.id, user.id, 'channel.create', { type: 'channel', id, name });
  return c;
});

route('PATCH', '/api/channels/:id', ({ user, params, body }) => {
  const { channel } = channelAccess(params.id, user.id);
  if (channel.type === 'dm') throw new HttpError(400, 'DM channels cannot be edited.');
  requireServerPerm(channel.server_id, user.id, P.MANAGE_CHANNELS);
  if (body.name !== undefined) {
    let name = str(body.name, 'Channel name', 1, 64);
    if (channel.type === 'text') name = name.toLowerCase().replace(/\s+/g, '-');
    run('UPDATE channels SET name = ? WHERE id = ?', name, channel.id);
  }
  if (body.topic !== undefined) run('UPDATE channels SET topic = ? WHERE id = ?', String(body.topic).slice(0, 256), channel.id);
  if (body.position !== undefined) run('UPDATE channels SET position = ? WHERE id = ?', Number(body.position) | 0, channel.id);
  if (body.slowmode !== undefined) run('UPDATE channels SET slowmode = ? WHERE id = ?', Math.max(0, Math.min(21600, Number(body.slowmode) | 0)), channel.id);
  if (body.ageRating !== undefined) {
    run('UPDATE channels SET age_rating = ? WHERE id = ?', [0, 18, 21].includes(Number(body.ageRating)) ? Number(body.ageRating) : 0, channel.id);
    permsChanged(channel.server_id);
  }
  const c = ser.channel(one('SELECT * FROM channels WHERE id = ?', channel.id));
  bus.publish(`server:${channel.server_id}`, { t: 'CHANNEL_UPDATE', d: c });
  audit(channel.server_id, user.id, 'channel.update', { type: 'channel', id: channel.id, name: c.name });
  return c;
});

route('DELETE', '/api/channels/:id', ({ user, params }) => {
  const { channel } = channelAccess(params.id, user.id);
  if (channel.type === 'dm') throw new HttpError(400, 'DM channels cannot be deleted.');
  requireServerPerm(channel.server_id, user.id, P.MANAGE_CHANNELS);
  audit(channel.server_id, user.id, 'channel.delete', { type: 'channel', id: channel.id, name: channel.name });
  const msgs = all('SELECT * FROM messages WHERE channel_id = ?', channel.id);
  vault.store({
    kind: 'channel', serverId: channel.server_id, label: `#${channel.name}`,
    data: { channel: { id: channel.id, name: channel.name, type: channel.type }, deletedBy: user.id, deletedAt: Date.now(), messages: messageSnapshot(msgs) },
    files: vault.attachmentsOf(msgs),
  });
  run('DELETE FROM channels WHERE id = ?', channel.id);
  deleteChannelFiles(channel.id);
  purgeLog();
  bus.publish(`server:${channel.server_id}`, { t: 'CHANNEL_DELETE', d: { id: channel.id, serverId: channel.server_id } });
});

// ---------- direct messages ----------
route('POST', '/api/dms', ({ user, body }) => {
  const other = one('SELECT * FROM users WHERE username = ?', String(body.username || ''));
  if (!other) throw new HttpError(404, 'No user with that username.');
  if (other.id === user.id) throw new HttpError(400, 'You cannot DM yourself.');
  const existing = one(
    `SELECT a.channel_id AS id FROM dm_recipients a JOIN dm_recipients b ON a.channel_id = b.channel_id
     WHERE a.user_id = ? AND b.user_id = ?`, user.id, other.id);
  if (one('SELECT 1 FROM blocks WHERE user_id = ? AND blocked_id = ?', other.id, user.id)) {
    throw new HttpError(403, 'You can\u2019t message this person.');
  }
  if (existing) return ser.dmChannel(existing.id);
  const id = newId();
  tx(() => {
    run(`INSERT INTO channels (id, server_id, name, type, created_at) VALUES (?, NULL, 'dm', 'dm', ?)`, id, Date.now());
    run('INSERT INTO dm_recipients (channel_id, user_id) VALUES (?, ?), (?, ?)', id, user.id, id, other.id);
  });
  const dm = ser.dmChannel(id);
  bus.publish(`user:${user.id}`, { t: 'DM_CREATE', d: dm });
  bus.publish(`user:${other.id}`, { t: 'DM_CREATE', d: dm });
  return dm;
});

// ---------- messages ----------
route('GET', '/api/channels/:id/messages', ({ user, params, query }) => {
  channelAccess(params.id, user.id);
  const limit = Math.min(100, Math.max(1, Number(query.get('limit')) || 50));
  const before = query.get('before');
  const rows = before
    ? all('SELECT * FROM messages WHERE channel_id = ? AND CAST(id AS INTEGER) < CAST(? AS INTEGER) ORDER BY CAST(id AS INTEGER) DESC LIMIT ?', params.id, before, limit)
    : all('SELECT * FROM messages WHERE channel_id = ? ORDER BY CAST(id AS INTEGER) DESC LIMIT ?', params.id, limit);
  return ser.messages(rows.reverse(), user.id);
});

route('POST', '/api/channels/:id/messages', ({ user, params, body }) => {
  const { channel, perms } = channelAccess(params.id, user.id, P.SEND_MESSAGES);
  if (channel.type === 'voice') throw new HttpError(400, 'Cannot post in a voice channel.');
  const content = typeof body.content === 'string' ? body.content.trim() : '';
  if (content.length > config.maxMessageLength) throw new HttpError(400, 'Message is too long.');
  const attachments = Array.isArray(body.attachments) ? body.attachments.slice(0, 10) : [];
  if (attachments.length && !has(perms, P.ATTACH_FILES)) throw new HttpError(403, 'You cannot attach files here.');
  const clean = attachments.map((a) => {
    const url = checkUploadUrl(a.url, channel.id);
    return { url, name: String(a.name || 'file').slice(0, 128), size: Number(a.size) || 0, type: String(a.type || '') };
  });
  if (!content && !clean.length) throw new HttpError(400, 'Message is empty.');
  // Slowmode: one message per N seconds, unless you can manage messages.
  if (channel.slowmode && !has(perms, P.MANAGE_MESSAGES) && !has(perms, P.MANAGE_CHANNELS)) {
    const last = one('SELECT MAX(created_at) AS t FROM messages WHERE channel_id = ? AND author_id = ?', channel.id, user.id).t;
    const wait = last ? Math.ceil((last + channel.slowmode * 1000 - Date.now()) / 1000) : 0;
    if (wait > 0) throw new HttpError(429, `Slowmode is on. You can send another message in ${wait} second${wait === 1 ? '' : 's'}.`);
  }
  // Blocked: you can't message someone in a DM who has blocked you.
  if (channel.type === 'dm') {
    const other = one('SELECT user_id FROM dm_recipients WHERE channel_id = ? AND user_id != ?', channel.id, user.id);
    if (other && one('SELECT 1 FROM blocks WHERE user_id = ? AND blocked_id = ?', other.user_id, user.id)) {
      throw new HttpError(403, 'You can\u2019t message this person.');
    }
  }
  let replyTo = null;
  if (body.replyTo && one('SELECT 1 FROM messages WHERE id = ? AND channel_id = ?', body.replyTo, channel.id)) {
    replyTo = body.replyTo;
  }
  const id = newId();
  run(`INSERT INTO messages (id, channel_id, author_id, content, attachments, reply_to, created_at, kind)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, id, channel.id, user.id, content,
    clean.length ? JSON.stringify(clean) : null, replyTo, Date.now(), body.kind === 'me' ? 'me' : null);
  const msg = ser.message(id, user.id);
  bus.publish(topicFor(channel), { t: 'MESSAGE_CREATE', d: { ...msg, serverId: channel.server_id } });
  return msg;
});

route('PATCH', '/api/messages/:id', ({ user, params, body }) => {
  const m = one('SELECT * FROM messages WHERE id = ?', params.id);
  if (!m) throw new HttpError(404, 'Message not found.');
  const { channel } = channelAccess(m.channel_id, user.id);
  if (m.author_id !== user.id) throw new HttpError(403, 'You can only edit your own messages.');
  const content = str(body.content, 'Message', 1, config.maxMessageLength);
  if (content !== m.content) {
    vault.store({
      kind: 'edit', userId: m.author_id, serverId: channel.server_id, label: `Earlier version of a message by ${userName(m.author_id)}`,
      data: { messageId: m.id, previousContent: m.content, editedAt: Date.now() },
    });
  }
  run('UPDATE messages SET content = ?, edited_at = ? WHERE id = ?', content, Date.now(), m.id);
  const msg = ser.message(m.id, user.id);
  bus.publish(topicFor(channel), { t: 'MESSAGE_UPDATE', d: { ...msg, serverId: channel.server_id } });
  return msg;
});

route('DELETE', '/api/messages/:id', ({ user, params }) => {
  const m = one('SELECT * FROM messages WHERE id = ?', params.id);
  if (!m) throw new HttpError(404, 'Message not found.');
  const { channel, perms } = channelAccess(m.channel_id, user.id);
  if (m.author_id !== user.id && !has(perms, P.MANAGE_MESSAGES)) {
    throw new HttpError(403, 'You cannot delete that message.');
  }
  vault.store({
    kind: 'message', userId: m.author_id, serverId: channel.server_id, label: `Message by ${userName(m.author_id)}`,
    data: { message: messageSnapshot([m])[0], channel: channel.name, deletedBy: user.id, deletedAt: Date.now() },
    files: vault.attachmentsOf([m]),
  });
  if (m.author_id !== user.id && channel.server_id) {
    audit(channel.server_id, user.id, 'message.delete', { type: 'user', id: m.author_id, name: `${userName(m.author_id)} in #${channel.name}` });
  }
  run('DELETE FROM messages WHERE id = ?', m.id);
  deleteMessageFiles(m);
  bus.publish(topicFor(channel), { t: 'MESSAGE_DELETE', d: { id: m.id, channelId: channel.id, serverId: channel.server_id } });
});

function reaction(add) {
  return ({ user, params }) => {
    const m = one('SELECT * FROM messages WHERE id = ?', params.id);
    if (!m) throw new HttpError(404, 'Message not found.');
    const { channel } = channelAccess(m.channel_id, user.id, P.ADD_REACTIONS);
    const emoji = str(params.emoji, 'Emoji', 1, 32);
    const changed = add
      ? run('INSERT OR IGNORE INTO reactions (message_id, user_id, emoji) VALUES (?, ?, ?)', m.id, user.id, emoji).changes
      : run('DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?', m.id, user.id, emoji).changes;
    if (changed) {
      bus.publish(topicFor(channel), {
        t: add ? 'REACTION_ADD' : 'REACTION_REMOVE',
        d: { messageId: m.id, channelId: channel.id, serverId: channel.server_id, userId: user.id, emoji },
      });
    }
  };
}
route('PUT', '/api/messages/:id/reactions/:emoji', reaction(true));
route('DELETE', '/api/messages/:id/reactions/:emoji', reaction(false));

// ---------- file uploads ----------
// Files live in data/uploads/<channelId>/<random>/<name> and are only served
// to people who can see that channel (checked via the session cookie).
function safeName(name) {
  return (String(name || 'file').replace(/[^\w.\- ]+/g, '_').trim() || 'file').slice(0, 100);
}

function checkUploadUrl(url, channelId) {
  if (url === null || url === '') return null;
  const m = /^\/uploads\/(\d+|avatars)\/([A-Za-z0-9_-]{16,})\/([^/]+)$/.exec(String(url));
  if (!m) throw new HttpError(400, 'Invalid attachment.');
  if (channelId && m[1] !== channelId) throw new HttpError(400, 'Attachment belongs to another channel.');
  const file = path.join(uploadsDir, m[1], m[2], decodeURIComponent(m[3]));
  if (!fs.existsSync(file)) throw new HttpError(400, 'Attachment not found.');
  return url;
}

// ---------- permanent file removal ----------
function uploadKeyDir(url) {
  const m = /^\/uploads\/(\d+|avatars)\/([A-Za-z0-9_-]{16,})\//.exec(String(url || ''));
  return m ? path.join(uploadsDir, m[1], m[2]) : null;
}
function deleteUploadUrl(url) {
  const dir = uploadKeyDir(url);
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
}
function deleteChannelFiles(channelId) {
  if (/^\d+$/.test(channelId)) fs.rmSync(path.join(uploadsDir, channelId), { recursive: true, force: true });
}
function deleteMessageFiles(row) {
  if (!row.attachments) return;
  try { for (const a of JSON.parse(row.attachments)) deleteUploadUrl(a.url); } catch { /* ignore */ }
}

// Files uploaded but never posted (or left behind) are removed after a day,
// so nothing is kept that isn't visibly in use.
function sweepOrphanUploads() {
  const used = new Set();
  for (const r of all('SELECT attachments FROM messages WHERE attachments IS NOT NULL')) {
    try { for (const a of JSON.parse(r.attachments)) used.add(uploadKeyDir(a.url)); } catch { /* ignore */ }
  }
  for (const r of all('SELECT avatar AS u FROM users WHERE avatar IS NOT NULL UNION SELECT icon FROM servers WHERE icon IS NOT NULL')) {
    used.add(uploadKeyDir(r.u));
  }
  const dayAgo = Date.now() - 24 * 3600 * 1000;
  let removed = 0;
  for (const folder of fs.readdirSync(uploadsDir)) {
    const folderPath = path.join(uploadsDir, folder);
    if (folder !== 'avatars' && !one('SELECT 1 FROM channels WHERE id = ?', folder)) {
      fs.rmSync(folderPath, { recursive: true, force: true });
      continue;
    }
    for (const key of fs.readdirSync(folderPath)) {
      const dir = path.join(folderPath, key);
      if (used.has(dir)) continue;
      if (fs.statSync(dir).mtimeMs < dayAgo) { fs.rmSync(dir, { recursive: true, force: true }); removed++; }
    }
  }
  if (removed) console.log(`[cleanup] removed ${removed} unused uploads`);
}
setTimeout(sweepOrphanUploads, 60 * 1000).unref();
setInterval(sweepOrphanUploads, 6 * 3600 * 1000).unref();

function storeUpload(req, folder) {
  const declared = Number(req.headers['content-length'] || 0);
  if (declared > config.maxUploadBytes) throw new HttpError(413, 'File is too large.');
  const name = safeName(decodeURIComponent(req.headers['x-filename'] || 'file'));
  const key = crypto.randomBytes(12).toString('base64url');
  const dir = path.join(uploadsDir, folder, key);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  return new Promise((resolve, reject) => {
    let size = 0;
    const out = fs.createWriteStream(file);
    req.on('data', (c) => {
      size += c.length;
      if (size > config.maxUploadBytes) {
        req.destroy(); out.destroy(); fs.rmSync(dir, { recursive: true, force: true });
        reject(new HttpError(413, 'File is too large.'));
      }
    });
    req.pipe(out);
    out.on('finish', () => resolve({
      url: `/uploads/${folder}/${key}/${encodeURIComponent(name)}`,
      name, size, type: String(req.headers['content-type'] || 'application/octet-stream').slice(0, 100),
    }));
    out.on('error', reject);
  });
}

route('POST', '/api/channels/:id/attachments', async ({ user, params, req }) => {
  channelAccess(params.id, user.id, P.ATTACH_FILES);
  return storeUpload(req, params.id);
}, { raw: true });

route('POST', '/api/uploads/avatar', async ({ req }) => storeUpload(req, 'avatars'), { raw: true });

// Serves an uploaded file if the requester may see it. Returns true if handled.
function serveUpload(req, res) {
  const url = new URL(req.url, 'http://x');
  const m = /^\/uploads\/(\d+|avatars)\/([A-Za-z0-9_-]{16,})\/([^/]+)$/.exec(url.pathname);
  if (!m) return false;
  const user = auth.userFromToken(tokenFrom(req).token);
  try {
    if (!user) throw new HttpError(401, 'Not logged in.');
    if (m[1] !== 'avatars') channelAccess(m[1], user.id);
  } catch (e) {
    res.writeHead(e.status || 404); res.end(); return true;
  }
  const file = path.join(uploadsDir, m[1], m[2], decodeURIComponent(m[3]));
  if (!file.startsWith(uploadsDir) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return true; }
  const ext = path.extname(file).toLowerCase();
  const inline = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
    '.webp': 'image/webp', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg' }[ext];
  res.writeHead(200, {
    'Content-Type': inline || 'application/octet-stream',
    'Content-Disposition': inline ? 'inline' : `attachment; filename="${path.basename(file)}"`,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, max-age=86400',
  });
  fs.createReadStream(file).pipe(res);
  return true;
}

// ---------- roles ----------
// Roles are ordered by position (higher = more senior). You can only
// create, edit, assign or reorder roles below your own highest role, and
// never grant permissions you don't have yourself.
function cleanPerms(value, actorPerms) {
  const p = (Number(value) | 0) & ALL;
  if ((p & ~actorPerms) !== 0) throw new HttpError(403, 'You cannot grant permissions you do not have.');
  return p;
}
function requireBelow(role, actorId) {
  if (!role.is_default && role.position >= topPosition(role.server_id, actorId)) {
    throw new HttpError(403, 'That role is the same as or above your highest role.');
  }
}
// Roles changing changes who can see which channels.
const permsChanged = (serverId) => bus.publish(`server:${serverId}`, { t: 'PERMS_CHANGED', d: { serverId } });

route('POST', '/api/servers/:id/roles', ({ user, params, body }) => {
  const perms = requireServerPerm(params.id, user.id, P.MANAGE_ROLES);
  const id = newId();
  // New roles start just above @everyone; everything else shifts up one.
  tx(() => {
    run('UPDATE roles SET position = position + 1 WHERE server_id = ? AND is_default = 0', params.id);
    run('INSERT INTO roles (id, server_id, name, color, permissions, position) VALUES (?, ?, ?, ?, ?, 1)',
      id, params.id, str(body.name || 'new role', 'Role name', 1, 32),
      /^#[0-9a-fA-F]{6}$/.test(body.color || '') ? body.color : null, cleanPerms(body.permissions || 0, perms));
  });
  for (const r of all('SELECT * FROM roles WHERE server_id = ?', params.id)) bus.publish(`server:${params.id}`, { t: 'ROLE_UPDATE', d: ser.role(r) });
  audit(params.id, user.id, 'role.create', { type: 'role', id, name: body.name || 'new role' });
  return ser.role(one('SELECT * FROM roles WHERE id = ?', id));
});

route('PATCH', '/api/roles/:id', ({ user, params, body }) => {
  const role = one('SELECT * FROM roles WHERE id = ?', params.id);
  if (!role) throw new HttpError(404, 'Role not found.');
  const perms = requireServerPerm(role.server_id, user.id, P.MANAGE_ROLES);
  requireBelow(role, user.id);
  if (body.name !== undefined && !role.is_default) run('UPDATE roles SET name = ? WHERE id = ?', str(body.name, 'Role name', 1, 32), role.id);
  if (body.color !== undefined) run('UPDATE roles SET color = ? WHERE id = ?', /^#[0-9a-fA-F]{6}$/.test(body.color || '') ? body.color : null, role.id);
  if (body.permissions !== undefined) run('UPDATE roles SET permissions = ? WHERE id = ?', cleanPerms(body.permissions, perms), role.id);
  const r = ser.role(one('SELECT * FROM roles WHERE id = ?', role.id));
  bus.publish(`server:${role.server_id}`, { t: 'ROLE_UPDATE', d: r });
  if (body.permissions !== undefined) permsChanged(role.server_id);
  audit(role.server_id, user.id, 'role.update', { type: 'role', id: role.id, name: r.name });
  return r;
});

// Reorder: body.ids lists non-default roles from highest to lowest.
route('PUT', '/api/servers/:id/roles/order', ({ user, params, body }) => {
  requireServerPerm(params.id, user.id, P.MANAGE_ROLES);
  const roles = all('SELECT * FROM roles WHERE server_id = ? AND is_default = 0', params.id);
  const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
  if (ids.length !== roles.length || !roles.every((r) => ids.includes(r.id))) throw new HttpError(400, 'List every role exactly once.');
  const top = topPosition(params.id, user.id);
  const next = new Map(ids.map((id, i) => [id, ids.length - i]));
  for (const r of roles) {
    const np = next.get(r.id);
    if (np !== r.position && (r.position >= top || np >= top)) {
      throw new HttpError(403, 'You can only move roles that stay below your highest role.');
    }
  }
  tx(() => { for (const [id, pos] of next) run('UPDATE roles SET position = ? WHERE id = ?', pos, id); });
  for (const r of all('SELECT * FROM roles WHERE server_id = ?', params.id)) bus.publish(`server:${params.id}`, { t: 'ROLE_UPDATE', d: ser.role(r) });
  audit(params.id, user.id, 'role.reorder');
  return all('SELECT * FROM roles WHERE server_id = ? ORDER BY position DESC', params.id).map(ser.role);
});

route('DELETE', '/api/roles/:id', ({ user, params }) => {
  const role = one('SELECT * FROM roles WHERE id = ?', params.id);
  if (!role) throw new HttpError(404, 'Role not found.');
  if (role.is_default) throw new HttpError(400, 'The @everyone role cannot be deleted.');
  requireServerPerm(role.server_id, user.id, P.MANAGE_ROLES);
  requireBelow(role, user.id);
  run('DELETE FROM roles WHERE id = ?', role.id);
  run(`DELETE FROM channel_overrides WHERE target_type = 'role' AND target_id = ?`, role.id);
  bus.publish(`server:${role.server_id}`, { t: 'ROLE_DELETE', d: { id: role.id, serverId: role.server_id } });
  permsChanged(role.server_id);
  audit(role.server_id, user.id, 'role.delete', { type: 'role', id: role.id, name: role.name });
});

function memberRole(add) {
  return ({ user, params }) => {
    const perms = requireServerPerm(params.id, user.id, P.MANAGE_ROLES);
    const role = one('SELECT * FROM roles WHERE id = ? AND server_id = ?', params.roleId, params.id);
    if (!role || role.is_default) throw new HttpError(404, 'Role not found.');
    requireBelow(role, user.id);
    if ((role.permissions & ~perms) !== 0) throw new HttpError(403, 'That role has permissions you do not have.');
    if (!one('SELECT 1 FROM members WHERE server_id = ? AND user_id = ?', params.id, params.userId)) {
      throw new HttpError(404, 'Member not found.');
    }
    if (params.userId !== user.id && !outranks(params.id, user.id, params.userId)) {
      throw new HttpError(403, 'Their highest role is the same as or above yours.');
    }
    if (add) run('INSERT OR IGNORE INTO member_roles (server_id, user_id, role_id) VALUES (?, ?, ?)', params.id, params.userId, role.id);
    else run('DELETE FROM member_roles WHERE server_id = ? AND user_id = ? AND role_id = ?', params.id, params.userId, role.id);
    const m = ser.member(params.id, params.userId);
    bus.publish(`server:${params.id}`, { t: 'MEMBER_UPDATE', d: { serverId: params.id, member: m } });
    permsChanged(params.id);
    audit(params.id, user.id, add ? 'member.role_add' : 'member.role_remove', { type: 'user', id: params.userId, name: `${userName(params.userId)} → ${role.name}` });
    return m;
  };
}
route('PUT', '/api/servers/:id/members/:userId/roles/:roleId', memberRole(true));
route('DELETE', '/api/servers/:id/members/:userId/roles/:roleId', memberRole(false));

// ---------- channel permission overrides ----------
route('PUT', '/api/channels/:id/overrides/:type/:targetId', ({ user, params, body }) => {
  const { channel } = channelAccess(params.id, user.id);
  if (channel.type === 'dm') throw new HttpError(400, 'Not available for direct messages.');
  const perms = requireServerPerm(channel.server_id, user.id, P.MANAGE_CHANNELS);
  if (!has(perms, P.MANAGE_ROLES)) throw new HttpError(403, 'You need Manage Roles to change channel permissions.');
  const type = params.type === 'member' ? 'member' : 'role';
  if (type === 'role') {
    const role = one('SELECT * FROM roles WHERE id = ? AND server_id = ?', params.targetId, channel.server_id);
    if (!role) throw new HttpError(404, 'Role not found.');
    requireBelow(role, user.id);
  } else if (!one('SELECT 1 FROM members WHERE server_id = ? AND user_id = ?', channel.server_id, params.targetId)) {
    throw new HttpError(404, 'Member not found.');
  }
  const allow = cleanPerms(body.allow || 0, perms) & ~P.ADMINISTRATOR;
  const deny = (Number(body.deny) | 0) & ALL & ~P.ADMINISTRATOR;
  if (!allow && !deny) run('DELETE FROM channel_overrides WHERE channel_id = ? AND target_type = ? AND target_id = ?', channel.id, type, params.targetId);
  else run(`INSERT INTO channel_overrides (channel_id, target_type, target_id, allow, deny) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(channel_id, target_type, target_id) DO UPDATE SET allow = excluded.allow, deny = excluded.deny`,
  channel.id, type, params.targetId, allow, deny);
  permsChanged(channel.server_id);
  audit(channel.server_id, user.id, 'channel.permissions', { type: 'channel', id: channel.id, name: channel.name });
  return ser.channel(one('SELECT * FROM channels WHERE id = ?', channel.id));
});

// ---------- slash command helpers ----------
// Dice and coin results are decided by the server so nobody can fake them.
function postSystemMessage(channel, userId, kind, content) {
  const id = newId();
  run(`INSERT INTO messages (id, channel_id, author_id, content, created_at, kind) VALUES (?, ?, ?, ?, ?, ?)`,
    id, channel.id, userId, content, Date.now(), kind);
  const msg = ser.message(id, userId);
  bus.publish(topicFor(channel), { t: 'MESSAGE_CREATE', d: { ...msg, serverId: channel.server_id } });
  return msg;
}

route('POST', '/api/channels/:id/roll', ({ user, params, body }) => {
  const { channel } = channelAccess(params.id, user.id, P.SEND_MESSAGES);
  const m = /^(\d{0,2})d(\d{1,4})([+-]\d{1,4})?$/i.exec(String(body.dice || 'd6').trim());
  if (!m) throw new HttpError(400, 'Use dice like d20, 2d6 or 3d8+2.');
  const n = Math.min(20, Math.max(1, Number(m[1] || 1)));
  const sides = Math.min(1000, Math.max(2, Number(m[2])));
  const mod = Number(m[3] || 0);
  const rolls = Array.from({ length: n }, () => crypto.randomInt(1, sides + 1));
  const total = rolls.reduce((a, b) => a + b, 0) + mod;
  const detail = n > 1 || mod ? ` (${rolls.join(' + ')}${mod ? (mod > 0 ? ` + ${mod}` : ` - ${-mod}`) : ''})` : '';
  return postSystemMessage(channel, user.id, 'roll', `rolled ${n}d${sides}${mod ? m[3] : ''}: **${total}**${detail}`);
});

route('POST', '/api/channels/:id/flip', ({ user, params }) => {
  const { channel } = channelAccess(params.id, user.id, P.SEND_MESSAGES);
  return postSystemMessage(channel, user.id, 'flip', `flipped a coin: **${crypto.randomInt(0, 2) ? 'Heads' : 'Tails'}**`);
});

// Bulk delete recent messages (moderators). Copies go to the vault.
route('POST', '/api/channels/:id/purge', ({ user, params, body }) => {
  const { channel, perms } = channelAccess(params.id, user.id);
  if (!channel.server_id || !has(perms, P.MANAGE_MESSAGES)) throw new HttpError(403, 'You need Manage Messages for that.');
  const count = Math.max(1, Math.min(100, Number(body.count) | 0));
  const rows = all('SELECT * FROM messages WHERE channel_id = ? ORDER BY CAST(id AS INTEGER) DESC LIMIT ?', channel.id, count);
  if (!rows.length) return { deleted: 0 };
  vault.store({
    kind: 'purge', serverId: channel.server_id, label: `${rows.length} messages purged from #${channel.name}`,
    data: { channel: channel.name, deletedBy: user.id, deletedAt: Date.now(), messages: messageSnapshot(rows) },
    files: vault.attachmentsOf(rows),
  });
  for (const m of rows) {
    run('DELETE FROM messages WHERE id = ?', m.id);
    deleteMessageFiles(m);
    bus.publish(topicFor(channel), { t: 'MESSAGE_DELETE', d: { id: m.id, channelId: channel.id, serverId: channel.server_id } });
  }
  audit(channel.server_id, user.id, 'message.purge', { type: 'channel', id: channel.id, name: `${rows.length} in #${channel.name}` }, body.reason);
  return { deleted: rows.length };
});

route('POST', '/api/admin/users/:id/birthdate-reset', ({ user, params, body }) => {
  requireAdmin(user);
  run('UPDATE users SET birthdate_enc = NULL WHERE id = ?', params.id);
  vault.logAccess(user.id, 'user.birthdate_reset', params.id, body.reason);
});

// ---------- blocking ----------
route('GET', '/api/users/@me/blocks', ({ user }) =>
  all('SELECT b.blocked_id, u.username, u.display_name FROM blocks b JOIN users u ON u.id = b.blocked_id WHERE b.user_id = ?', user.id)
    .map((b) => ({ id: b.blocked_id, username: b.username, displayName: b.display_name })));

route('PUT', '/api/users/@me/blocks/:userId', ({ user, params }) => {
  if (params.userId === user.id) throw new HttpError(400, 'You cannot block yourself.');
  if (!one('SELECT 1 FROM users WHERE id = ?', params.userId)) throw new HttpError(404, 'User not found.');
  run('INSERT OR IGNORE INTO blocks (user_id, blocked_id, created_at) VALUES (?, ?, ?)', user.id, params.userId, Date.now());
  bus.publish(`user:${user.id}`, { t: 'BLOCKS_UPDATE', d: { userId: params.userId, blocked: true } });
});

route('DELETE', '/api/users/@me/blocks/:userId', ({ user, params }) => {
  run('DELETE FROM blocks WHERE user_id = ? AND blocked_id = ?', user.id, params.userId);
  bus.publish(`user:${user.id}`, { t: 'BLOCKS_UPDATE', d: { userId: params.userId, blocked: false } });
});

// ---------- reports ----------
// Where a report goes:
//   - Child safety, anything in a direct message, and reports about a whole
//     server go only to Hearth's platform admins.
//   - Other reports inside a server go to that server's moderators (people
//     with Moderate Members), and also to Hearth if the reporter asks.
// A snapshot of the reported content is preserved in the vault for 1 year,
// even if the content is later deleted.
const REPORT_CATEGORIES = {
  spam: 'Spam or scams',
  harassment: 'Harassment or bullying',
  hate: 'Hate speech',
  violence: 'Threats or violent extremism',
  self_harm: 'Self-harm or suicide',
  sexual: 'Non-consensual or unwanted sexual content',
  child_safety: 'Child sexual abuse or exploitation',
  illegal: 'Other illegal activity',
  privacy: 'Sharing private information',
  impersonation: 'Impersonation',
  other: 'Something else',
};
const PLATFORM_ONLY = new Set(['child_safety']);

route('GET', '/api/reports/categories', () => REPORT_CATEGORIES, { public: true });

route('POST', '/api/reports', ({ user, body }) => {
  auth.hit(`report:${user.id}`, 15, 3600 * 1000);
  const category = String(body.category || '');
  if (!REPORT_CATEGORIES[category]) throw new HttpError(400, 'Pick what kind of problem this is.');
  const details = String(body.details || '').slice(0, 2000);
  const targetType = String(body.targetType || '');
  let serverId = null; let channelId = null; let targetUserId = null; let evidence; let files = [];

  if (targetType === 'message') {
    const m = one('SELECT * FROM messages WHERE id = ?', String(body.targetId));
    if (!m) throw new HttpError(404, 'Message not found.');
    const { channel } = channelAccess(m.channel_id, user.id);
    serverId = channel.server_id; channelId = channel.id; targetUserId = m.author_id;
    evidence = { message: messageSnapshot([m])[0], channel: channel.type === 'dm' ? 'direct message' : `#${channel.name}` };
    files = vault.attachmentsOf([m]);
  } else if (targetType === 'user') {
    const u = one('SELECT id, username, display_name, avatar, created_at FROM users WHERE id = ?', String(body.targetId));
    if (!u) throw new HttpError(404, 'User not found.');
    targetUserId = u.id;
    if (body.serverId && one('SELECT 1 FROM members WHERE server_id = ? AND user_id = ?', String(body.serverId), user.id)) serverId = String(body.serverId);
    evidence = { user: { id: u.id, username: u.username, displayName: u.display_name, avatar: u.avatar, createdAt: u.created_at } };
  } else if (targetType === 'server') {
    const srv = one('SELECT id, name, owner_id FROM servers WHERE id = ?', String(body.targetId));
    if (!srv || !one('SELECT 1 FROM members WHERE server_id = ? AND user_id = ?', srv.id, user.id)) throw new HttpError(404, 'Server not found.');
    targetUserId = srv.owner_id;
    evidence = { server: { id: srv.id, name: srv.name, owner: userName(srv.owner_id) } };
  } else {
    throw new HttpError(400, 'Nothing to report.');
  }
  if (targetUserId === user.id) throw new HttpError(400, 'You cannot report yourself.');

  const evidenceId = vault.store({
    kind: 'report', userId: targetUserId, serverId, label: `Report evidence: ${REPORT_CATEGORIES[category]}`,
    data: { ...evidence, reportedBy: user.id, reporter: user.username, category, details, reportedAt: Date.now() },
    files, days: vault.REPORT_DAYS,
  });

  const scopes = [];
  if (PLATFORM_ONLY.has(category) || targetType === 'server' || !serverId) scopes.push('platform');
  else {
    scopes.push('server');
    if (body.toHearth === true) scopes.push('platform');
  }
  const ids = [];
  for (const scope of scopes) {
    const id = newId();
    ids.push(id);
    run(`INSERT INTO reports (id, reporter_id, scope, server_id, channel_id, target_type, target_id, target_user_id, category, details, evidence_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, id, user.id, scope, serverId, channelId, targetType, String(body.targetId),
    targetUserId, category, details, evidenceId, Date.now());
    if (scope === 'server') bus.publish(`server:${serverId}`, { t: 'REPORTS_CHANGED', d: { serverId } });
    else bus.publish('admins', { t: 'ADMIN_REPORT', d: { id, category } });
  }
  console.log(`[report] ${category} report on ${targetType} (${scopes.join('+')})`);
  return { ok: true, sentTo: scopes };
});

function reportView(r, withEvidence) {
  return {
    id: r.id, scope: r.scope, serverId: r.server_id, channelId: r.channel_id, targetType: r.target_type, targetId: r.target_id,
    targetUserId: r.target_user_id, targetUser: r.target_user_id ? userName(r.target_user_id) : null,
    reporter: r.reporter_id ? userName(r.reporter_id) : null, category: r.category, categoryLabel: REPORT_CATEGORIES[r.category],
    details: r.details, status: r.status, resolution: r.resolution, handledBy: r.handled_by ? userName(r.handled_by) : null,
    createdAt: r.created_at, handledAt: r.handled_at,
    evidence: withEvidence && r.evidence_id ? vault.openForReport(r.evidence_id) : null,
    contentStillExists: r.target_type === 'message' ? !!one('SELECT 1 FROM messages WHERE id = ?', r.target_id) : undefined,
  };
}

// Server moderators' queue.
route('GET', '/api/servers/:id/reports', ({ user, params, query }) => {
  requireServerPerm(params.id, user.id, P.MODERATE_MEMBERS);
  const status = query.get('status') === 'closed' ? "status != 'open'" : "status = 'open'";
  return all(`SELECT * FROM reports WHERE scope = 'server' AND server_id = ? AND ${status} ORDER BY created_at DESC LIMIT 100`, params.id)
    .map((r) => reportView(r, true));
});

route('POST', '/api/servers/:id/reports/:rid/resolve', ({ user, params, body }) => {
  const perms = requireServerPerm(params.id, user.id, P.MODERATE_MEMBERS);
  const r = one(`SELECT * FROM reports WHERE id = ? AND scope = 'server' AND server_id = ?`, params.rid, params.id);
  if (!r) throw new HttpError(404, 'Report not found.');
  const action = String(body.action || 'dismiss');
  const note = String(body.note || '').slice(0, 500);
  const target = r.target_user_id;
  const name = target ? userName(target) : '';
  if (action === 'delete_message') {
    if (!has(perms, P.MANAGE_MESSAGES)) throw new HttpError(403, 'You need Manage Messages for that.');
    const m = one('SELECT * FROM messages WHERE id = ?', r.target_id);
    if (m) {
      vault.store({ kind: 'message', userId: m.author_id, serverId: params.id, label: `Message removed after a report`, data: { message: messageSnapshot([m])[0], deletedBy: user.id, reportId: r.id }, files: vault.attachmentsOf([m]) });
      run('DELETE FROM messages WHERE id = ?', m.id);
      deleteMessageFiles(m);
      bus.publish(`server:${params.id}`, { t: 'MESSAGE_DELETE', d: { id: m.id, channelId: m.channel_id, serverId: params.id } });
      audit(params.id, user.id, 'message.delete', { type: 'user', id: m.author_id, name }, `Report: ${note}`);
    }
  } else if (action === 'timeout' || action === 'kick' || action === 'ban') {
    const need = { timeout: P.MODERATE_MEMBERS, kick: P.KICK_MEMBERS, ban: P.BAN_MEMBERS }[action];
    if (!has(perms, need)) throw new HttpError(403, 'You do not have permission to do that.');
    guardTarget(params.id, user.id, target);
    if (action === 'timeout') {
      const minutes = Math.max(1, Math.min(28 * 24 * 60, Number(body.minutes) || 60));
      run('UPDATE members SET timeout_until = ? WHERE server_id = ? AND user_id = ?', Date.now() + minutes * 60000, params.id, target);
      const m = ser.member(params.id, target);
      if (m) bus.publish(`server:${params.id}`, { t: 'MEMBER_UPDATE', d: { serverId: params.id, member: m } });
      bus.publish(`user:${target}`, { t: 'VOICE_FORCE_LEAVE_SERVER', d: { serverId: params.id, reason: 'You were timed out.' } });
      audit(params.id, user.id, 'member.timeout', { type: 'user', id: target, name }, `${minutes} min — report: ${note}`);
    } else {
      if (action === 'ban') run('INSERT OR REPLACE INTO bans (server_id, user_id, reason) VALUES (?, ?, ?)', params.id, target, note.slice(0, 256));
      if (one('SELECT 1 FROM members WHERE server_id = ? AND user_id = ?', params.id, target)) removeMember(params.id, target);
      audit(params.id, user.id, action === 'ban' ? 'member.ban' : 'member.kick', { type: 'user', id: target, name }, `Report: ${note}`);
    }
  } else if (action !== 'dismiss') {
    throw new HttpError(400, 'Unknown action.');
  }
  run(`UPDATE reports SET status = ?, resolution = ?, handled_by = ?, handled_at = ? WHERE id = ?`,
    action === 'dismiss' ? 'dismissed' : 'resolved', `${action}${note ? ': ' + note : ''}`, user.id, Date.now(), r.id);
  audit(params.id, user.id, 'report.' + (action === 'dismiss' ? 'dismiss' : 'resolve'), { type: 'report', id: r.id, name: REPORT_CATEGORIES[r.category] }, note);
  bus.publish(`server:${params.id}`, { t: 'REPORTS_CHANGED', d: { serverId: params.id } });
  return reportView(one('SELECT * FROM reports WHERE id = ?', r.id), false);
});

// ---------- Hearth platform admin ----------
// Admins handle platform reports, can suspend accounts, place legal holds
// and open the retention vault. Every admin action is logged.
function requireAdmin(user) {
  if (!one('SELECT 1 FROM users WHERE id = ? AND is_admin = 1', user.id)) throw new HttpError(404, 'Not found.');
}

route('GET', '/api/admin/reports', ({ user, query }) => {
  requireAdmin(user);
  const status = query.get('status') === 'closed' ? "status != 'open'" : "status = 'open'";
  vault.logAccess(user.id, 'reports.view', query.get('status') || 'open');
  return all(`SELECT * FROM reports WHERE scope = 'platform' AND ${status}
              ORDER BY (category = 'child_safety') DESC, created_at DESC LIMIT 200`).map((r) => reportView(r, true));
});

route('POST', '/api/admin/reports/:rid/resolve', ({ user, params, body }) => {
  requireAdmin(user);
  const r = one(`SELECT * FROM reports WHERE id = ? AND scope = 'platform'`, params.rid);
  if (!r) throw new HttpError(404, 'Report not found.');
  const action = String(body.action || 'dismiss');
  const note = String(body.note || '').slice(0, 1000);
  if (action === 'remove_content' && r.target_type === 'message') {
    const m = one('SELECT * FROM messages WHERE id = ?', r.target_id);
    if (m) {
      const ch = one('SELECT * FROM channels WHERE id = ?', m.channel_id);
      run('DELETE FROM messages WHERE id = ?', m.id);
      deleteMessageFiles(m);
      bus.publish(ch && ch.server_id ? `server:${ch.server_id}` : `channel:${m.channel_id}`,
        { t: 'MESSAGE_DELETE', d: { id: m.id, channelId: m.channel_id, serverId: ch ? ch.server_id : null } });
    }
  } else if (action === 'suspend_user' && r.target_user_id) {
    suspendUser(r.target_user_id, note || REPORT_CATEGORIES[r.category]);
  } else if (action === 'delete_server' && r.target_type === 'server') {
    const srv = one('SELECT owner_id, name, icon FROM servers WHERE id = ?', r.target_id);
    if (srv) { deleteServerData(r.target_id, srv, user.id); purgeLog(); }
  } else if (action !== 'dismiss') {
    throw new HttpError(400, 'Unknown action.');
  }
  const ncmec = String(body.ncmecReportId || '').slice(0, 64);
  run(`UPDATE reports SET status = ?, resolution = ?, handled_by = ?, handled_at = ? WHERE id = ?`,
    action === 'dismiss' ? 'dismissed' : 'resolved', `${action}${ncmec ? ` (NCMEC report ${ncmec})` : ''}${note ? ': ' + note : ''}`,
    user.id, Date.now(), r.id);
  vault.logAccess(user.id, `report.${action}`, r.id, note);
  return reportView(one('SELECT * FROM reports WHERE id = ?', r.id), false);
});

function suspendUser(userId, reason) {
  run('UPDATE users SET suspended_at = ?, suspended_reason = ? WHERE id = ?', Date.now(), String(reason || '').slice(0, 300), userId);
  auth.revokeAllSessions(userId);
  bus.publish(`user:${userId}`, { t: 'SESSIONS_REVOKED', d: {} });
}

route('GET', '/api/admin/users', ({ user, query }) => {
  requireAdmin(user);
  const q = String(query.get('q') || '').trim().slice(0, 64);
  vault.logAccess(user.id, 'users.search', null, q);
  const rows = q
    ? all(`SELECT * FROM users WHERE username LIKE ? ESCAPE '\\' OR id = ? ORDER BY username LIMIT 50`, `%${q.replace(/[%_\\]/g, (c) => '\\' + c)}%`, q)
    : all('SELECT * FROM users ORDER BY created_at DESC LIMIT 50');
  return rows.map((u) => ({
    id: u.id, username: u.username, displayName: u.display_name, createdAt: u.created_at, isAdmin: !!u.is_admin,
    suspendedAt: u.suspended_at, suspendedReason: u.suspended_reason, hasEmail: !!u.email_enc, emailVerified: !!u.email_verified_at,
    servers: one('SELECT COUNT(*) AS n FROM members WHERE user_id = ?', u.id).n,
  }));
});

// Revealing someone's email is logged with the reason given.
route('POST', '/api/admin/users/:id/reveal-email', ({ user, params, body }) => {
  requireAdmin(user);
  const reason = String(body.reason || '').trim();
  if (reason.length < 5) throw new HttpError(400, 'Give a reason; it is recorded in the admin log.');
  const u = one('SELECT email_enc FROM users WHERE id = ?', params.id);
  if (!u) throw new HttpError(404, 'User not found.');
  vault.logAccess(user.id, 'user.reveal_email', params.id, reason);
  return { email: u.email_enc ? secrets.decryptText('email', u.email_enc) : null };
});

route('POST', '/api/admin/users/:id/suspend', ({ user, params, body }) => {
  requireAdmin(user);
  if (params.id === user.id) throw new HttpError(400, 'You cannot suspend yourself.');
  if (!one('SELECT 1 FROM users WHERE id = ?', params.id)) throw new HttpError(404, 'User not found.');
  suspendUser(params.id, body.reason);
  vault.logAccess(user.id, 'user.suspend', params.id, body.reason);
});

route('POST', '/api/admin/users/:id/unsuspend', ({ user, params }) => {
  requireAdmin(user);
  run('UPDATE users SET suspended_at = NULL, suspended_reason = NULL WHERE id = ?', params.id);
  vault.logAccess(user.id, 'user.unsuspend', params.id);
});

route('GET', '/api/admin/holds', ({ user }) => { requireAdmin(user); return vault.holds(); });

route('POST', '/api/admin/holds', ({ user, body }) => {
  requireAdmin(user);
  const type = body.targetType === 'server' ? 'server' : 'user';
  const reason = String(body.reason || '').trim();
  if (reason.length < 5) throw new HttpError(400, 'Describe the legal reason (for example the request or case number).');
  let targetId = String(body.targetId || '').trim();
  let label = targetId;
  if (type === 'user') {
    const u = one('SELECT id, username FROM users WHERE id = ? OR username = ?', targetId, targetId);
    if (u) { targetId = u.id; label = '@' + u.username; } else if (!one('SELECT 1 FROM vault WHERE user_id = ?', targetId)) throw new HttpError(404, 'No user or stored data with that ID or username.');
  } else {
    const srv = one('SELECT id, name FROM servers WHERE id = ?', targetId);
    if (srv) label = srv.name; else if (!one('SELECT 1 FROM vault WHERE server_id = ?', targetId)) throw new HttpError(404, 'No server or stored data with that ID.');
  }
  return { id: vault.placeHold(type, targetId, label, reason, user.id) };
});

route('DELETE', '/api/admin/holds/:id', ({ user, params }) => { requireAdmin(user); vault.releaseHold(params.id, user.id); });

route('GET', '/api/admin/vault', ({ user, query }) => {
  requireAdmin(user);
  let userId = query.get('user') || null;
  if (userId) { const u = one('SELECT id FROM users WHERE username = ?', userId); if (u) userId = u.id; }
  vault.logAccess(user.id, 'vault.list', userId || query.get('server') || 'all');
  return vault.list({ userId, serverId: query.get('server') || null, kind: query.get('kind') || null });
});

route('POST', '/api/admin/vault/:id/open', ({ user, params, body }) => {
  requireAdmin(user);
  const reason = String(body.reason || '').trim();
  if (reason.length < 5) throw new HttpError(400, 'Give a reason; it is recorded in the admin log.');
  const item = vault.open(params.id, user.id, reason);
  if (!item) throw new HttpError(404, 'Not found (it may have expired).');
  return item;
});

route('GET', '/api/admin/vault/:id/files/:n', ({ user, params, res }) => {
  requireAdmin(user);
  const f = vault.openFile(params.id, params.n, user.id);
  if (!f) throw new HttpError(404, 'Not found.');
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': `attachment; filename="${String(f.meta.name).replace(/[^\w.\- ]+/g, '_')}"`,
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
  });
  res.end(f.body);
});

route('GET', '/api/admin/log', ({ user }) => {
  requireAdmin(user);
  return all('SELECT * FROM admin_log ORDER BY created_at DESC LIMIT 300').map((l) => ({
    id: l.id, admin: userName(l.admin_id), action: l.action, target: l.target, detail: l.detail, createdAt: l.created_at,
  }));
});

route('POST', '/api/admin/users/:id/admin', ({ user, params, body }) => {
  requireAdmin(user);
  if (params.id === user.id && !body.isAdmin) throw new HttpError(400, 'You cannot remove your own admin access.');
  run('UPDATE users SET is_admin = ? WHERE id = ?', body.isAdmin ? 1 : 0, params.id);
  vault.logAccess(user.id, body.isAdmin ? 'admin.grant' : 'admin.revoke', params.id);
});

module.exports = { handle, serveUpload, channelAccess, state, cookie, sameOrigin };
