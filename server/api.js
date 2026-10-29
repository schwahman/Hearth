// REST API. Clients use these endpoints to change things; the resulting
// events are published on the bus so everyone else sees them live.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const config = require('./config');
const { one, all, run, tx } = require('./db');
const { newId, randomCode } = require('./ids');
const { P, ALL, DEFAULT_EVERYONE, memberPermissions, has } = require('./permissions');
const auth = require('./auth');
const { HttpError } = auth;
const ser = require('./serialize');
const bus = require('./bus');
const state = require('./state');

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
      const body = r.raw || req.method === 'GET' || req.method === 'DELETE' ? null : await readJson(req);
      const result = await r.handler({ req, res, params, query: url.searchParams, body, user, token });
      if (!res.headersSent) sendJson(res, result === undefined ? 204 : 200, result);
    } catch (err) {
      if (!(err instanceof HttpError)) console.error(err);
      if (err.headers && !res.headersSent) for (const [k, v] of Object.entries(err.headers)) res.setHeader(k, v);
      if (!res.headersSent) sendJson(res, err.status || 500, { error: err.status ? err.message : 'Server error.' });
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
    perms = memberPermissions(channel.server_id, userId);
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
  const { id, token } = await auth.register(body.username, body.password, body.displayName, meta(req));
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

route('GET', '/api/users/@me/sessions', ({ user, token }) => auth.listSessions(user.id, token));

route('DELETE', '/api/users/@me/sessions/:id', ({ user, params }) => {
  auth.revokeSessionById(user.id, params.id);
  bus.publish(`user:${user.id}`, { t: 'SESSIONS_REVOKED', d: {} });
});

route('GET', '/api/users/@me', ({ user }) => ser.user(user));

route('PATCH', '/api/users/@me', ({ user, body }) => {
  if (body.displayName !== undefined) {
    run('UPDATE users SET display_name = ? WHERE id = ?', str(body.displayName, 'Display name', 1, 32), user.id);
  }
  if (body.avatar !== undefined) {
    run('UPDATE users SET avatar = ? WHERE id = ?', checkUploadUrl(body.avatar), user.id);
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
  const payload = ser.server(serverId);
  bus.publish(`user:${user.id}`, { t: 'SERVER_CREATE', d: payload });
  return payload;
});

route('GET', '/api/servers/:id', ({ user, params }) => {
  requireServerPerm(params.id, user.id);
  return ser.server(params.id);
});

route('PATCH', '/api/servers/:id', ({ user, params, body }) => {
  requireServerPerm(params.id, user.id, P.MANAGE_SERVER);
  if (body.name !== undefined) run('UPDATE servers SET name = ? WHERE id = ?', str(body.name, 'Server name', 1, 64), params.id);
  if (body.icon !== undefined) run('UPDATE servers SET icon = ? WHERE id = ?', checkUploadUrl(body.icon), params.id);
  const s = one('SELECT id, name, icon FROM servers WHERE id = ?', params.id);
  bus.publish(`server:${params.id}`, { t: 'SERVER_UPDATE', d: { id: s.id, name: s.name, icon: s.icon } });
  return s;
});

route('DELETE', '/api/servers/:id', ({ user, params }) => {
  const s = one('SELECT owner_id FROM servers WHERE id = ?', params.id);
  if (!s || s.owner_id !== user.id) throw new HttpError(403, 'Only the owner can delete a server.');
  bus.publish(`server:${params.id}`, { t: 'SERVER_DELETE', d: { id: params.id } });
  run('DELETE FROM servers WHERE id = ?', params.id);
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
}

route('DELETE', '/api/servers/:id/members/:userId', ({ user, params }) => {
  requireServerPerm(params.id, user.id, P.KICK_MEMBERS);
  guardTarget(params.id, user.id, params.userId);
  if (!one('SELECT 1 FROM members WHERE server_id = ? AND user_id = ?', params.id, params.userId)) {
    throw new HttpError(404, 'Member not found.');
  }
  removeMember(params.id, params.userId);
});

route('PUT', '/api/servers/:id/bans/:userId', ({ user, params, body }) => {
  requireServerPerm(params.id, user.id, P.BAN_MEMBERS);
  guardTarget(params.id, user.id, params.userId);
  run('INSERT OR REPLACE INTO bans (server_id, user_id, reason) VALUES (?, ?, ?)',
    params.id, params.userId, (body.reason || '').slice(0, 256));
  if (one('SELECT 1 FROM members WHERE server_id = ? AND user_id = ?', params.id, params.userId)) {
    removeMember(params.id, params.userId);
  }
});

route('DELETE', '/api/servers/:id/bans/:userId', ({ user, params }) => {
  requireServerPerm(params.id, user.id, P.BAN_MEMBERS);
  run('DELETE FROM bans WHERE server_id = ? AND user_id = ?', params.id, params.userId);
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
  if (!one('SELECT 1 FROM members WHERE server_id = ? AND user_id = ?', serverId, user.id)) {
    tx(() => {
      run('INSERT INTO members (server_id, user_id, joined_at) VALUES (?, ?, ?)', serverId, user.id, Date.now());
      run('UPDATE invites SET uses = uses + 1 WHERE code = ?', inv.code);
    });
    bus.publish(`server:${serverId}`, { t: 'MEMBER_ADD', d: { serverId, member: ser.member(serverId, user.id) } });
  }
  const payload = ser.server(serverId);
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
  const c = ser.channel(one('SELECT * FROM channels WHERE id = ?', channel.id));
  bus.publish(`server:${channel.server_id}`, { t: 'CHANNEL_UPDATE', d: c });
  return c;
});

route('DELETE', '/api/channels/:id', ({ user, params }) => {
  const { channel } = channelAccess(params.id, user.id);
  if (channel.type === 'dm') throw new HttpError(400, 'DM channels cannot be deleted.');
  requireServerPerm(channel.server_id, user.id, P.MANAGE_CHANNELS);
  run('DELETE FROM channels WHERE id = ?', channel.id);
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
  let replyTo = null;
  if (body.replyTo && one('SELECT 1 FROM messages WHERE id = ? AND channel_id = ?', body.replyTo, channel.id)) {
    replyTo = body.replyTo;
  }
  const id = newId();
  run(`INSERT INTO messages (id, channel_id, author_id, content, attachments, reply_to, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`, id, channel.id, user.id, content,
    clean.length ? JSON.stringify(clean) : null, replyTo, Date.now());
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
  run('DELETE FROM messages WHERE id = ?', m.id);
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
function cleanPerms(value, actorPerms) {
  const p = (Number(value) | 0) & ALL;
  if ((p & ~actorPerms) !== 0) throw new HttpError(403, 'You cannot grant permissions you do not have.');
  return p;
}

route('POST', '/api/servers/:id/roles', ({ user, params, body }) => {
  const perms = requireServerPerm(params.id, user.id, P.MANAGE_ROLES);
  const id = newId();
  const pos = one('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM roles WHERE server_id = ?', params.id).p;
  run('INSERT INTO roles (id, server_id, name, color, permissions, position) VALUES (?, ?, ?, ?, ?, ?)',
    id, params.id, str(body.name || 'new role', 'Role name', 1, 32),
    /^#[0-9a-fA-F]{6}$/.test(body.color || '') ? body.color : null,
    cleanPerms(body.permissions || 0, perms), pos);
  const r = ser.role(one('SELECT * FROM roles WHERE id = ?', id));
  bus.publish(`server:${params.id}`, { t: 'ROLE_UPDATE', d: r });
  return r;
});

route('PATCH', '/api/roles/:id', ({ user, params, body }) => {
  const role = one('SELECT * FROM roles WHERE id = ?', params.id);
  if (!role) throw new HttpError(404, 'Role not found.');
  const perms = requireServerPerm(role.server_id, user.id, P.MANAGE_ROLES);
  if (body.name !== undefined && !role.is_default) run('UPDATE roles SET name = ? WHERE id = ?', str(body.name, 'Role name', 1, 32), role.id);
  if (body.color !== undefined) run('UPDATE roles SET color = ? WHERE id = ?', /^#[0-9a-fA-F]{6}$/.test(body.color || '') ? body.color : null, role.id);
  if (body.permissions !== undefined) run('UPDATE roles SET permissions = ? WHERE id = ?', cleanPerms(body.permissions, perms), role.id);
  const r = ser.role(one('SELECT * FROM roles WHERE id = ?', role.id));
  bus.publish(`server:${role.server_id}`, { t: 'ROLE_UPDATE', d: r });
  return r;
});

route('DELETE', '/api/roles/:id', ({ user, params }) => {
  const role = one('SELECT * FROM roles WHERE id = ?', params.id);
  if (!role) throw new HttpError(404, 'Role not found.');
  if (role.is_default) throw new HttpError(400, 'The @everyone role cannot be deleted.');
  requireServerPerm(role.server_id, user.id, P.MANAGE_ROLES);
  run('DELETE FROM roles WHERE id = ?', role.id);
  bus.publish(`server:${role.server_id}`, { t: 'ROLE_DELETE', d: { id: role.id, serverId: role.server_id } });
});

function memberRole(add) {
  return ({ user, params }) => {
    const perms = requireServerPerm(params.id, user.id, P.MANAGE_ROLES);
    const role = one('SELECT * FROM roles WHERE id = ? AND server_id = ?', params.roleId, params.id);
    if (!role || role.is_default) throw new HttpError(404, 'Role not found.');
    if ((role.permissions & ~perms) !== 0) throw new HttpError(403, 'That role has permissions you do not have.');
    if (!one('SELECT 1 FROM members WHERE server_id = ? AND user_id = ?', params.id, params.userId)) {
      throw new HttpError(404, 'Member not found.');
    }
    if (add) run('INSERT OR IGNORE INTO member_roles (server_id, user_id, role_id) VALUES (?, ?, ?)', params.id, params.userId, role.id);
    else run('DELETE FROM member_roles WHERE server_id = ? AND user_id = ? AND role_id = ?', params.id, params.userId, role.id);
    const m = ser.member(params.id, params.userId);
    bus.publish(`server:${params.id}`, { t: 'MEMBER_UPDATE', d: { serverId: params.id, member: m } });
    return m;
  };
}
route('PUT', '/api/servers/:id/members/:userId/roles/:roleId', memberRole(true));
route('DELETE', '/api/servers/:id/members/:userId/roles/:roleId', memberRole(false));

module.exports = { handle, serveUpload, channelAccess, state, cookie, sameOrigin };
