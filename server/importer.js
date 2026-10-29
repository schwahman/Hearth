// Discord server import.
//
// The server owner creates a Discord bot (it only needs to read), adds it to
// their Discord server, and pastes its token into the import wizard. We read
// the server's structure and (optionally) its message history over Discord's
// public REST API and rebuild it as a brand-new Hearth server.
//
// What comes over: server name and icon, roles (name, color, order,
// permissions), categories, text and voice channels (topic, slowmode, 18+
// flag, role-based privacy), and message history for the channels the owner
// picks: text, replies, files, embeds as text, reaction counts, each shown
// under the original sender's name with an "Archived" tag.
//
// People do not come over. Imported messages are owned by a locked system
// account and are never handed to a Hearth account later, even one with the
// same name: everyone starts fresh.
//
// The bot token is only ever kept in memory while it's in use. It is never
// written to the database, logs or disk.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const config = require('./config');
const { one, all, run, tx } = require('./db');
const { newId } = require('./ids');
const { P, DEFAULT_EVERYONE } = require('./permissions');
const bus = require('./bus');
const ser = require('./serialize');

const API = (process.env.DISCORD_API_BASE || 'https://discord.com/api/v10').replace(/\/$/, '');
const CDN = (process.env.DISCORD_CDN_BASE || 'https://cdn.discordapp.com').replace(/\/$/, '');
const FILE_HOSTS = new Set(['cdn.discordapp.com', 'media.discordapp.net', new URL(CDN).host]);
const MAX_JOBS = Number(process.env.IMPORT_MAX_JOBS || 2);
const MAX_FILE_BYTES_TOTAL = Number(process.env.IMPORT_MAX_GB || 5) * 1024 ** 3;
const uploadsDir = path.join(config.dataDir, 'uploads');

// The permissions the bot needs: View Channels + Read Message History.
const BOT_PERMISSIONS = (1 << 10) + (1 << 16);

const { HttpError } = require('./auth');
class ImportError extends HttpError {}

// ---------- Discord REST client ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function checkToken(token) {
  const t = String(token || '').trim().replace(/^Bot\s+/i, '');
  if (!/^[A-Za-z0-9._-]{40,120}$/.test(t)) throw new ImportError(400, 'That doesn’t look like a bot token. Copy it from the Bot page of your app in the Discord Developer Portal.');
  return t;
}

function client(token) {
  let waitUntil = 0;
  async function call(p, { allow404 = false } = {}) {
    for (let attempt = 0; attempt < 6; attempt++) {
      const wait = waitUntil - Date.now();
      if (wait > 0) await sleep(wait);
      let res;
      try {
        res = await fetch(API + p, {
          headers: { Authorization: `Bot ${token}`, 'User-Agent': 'DiscordBot (https://github.com/schwahman/Hearth, 0.1) Hearth-Import' },
          redirect: 'error',
          signal: AbortSignal.timeout(30000),
        });
      } catch {
        await sleep(1000 * (attempt + 1));
        continue;
      }
      // Pace ourselves using Discord's rate-limit headers.
      if (res.headers.get('x-ratelimit-remaining') === '0') {
        waitUntil = Date.now() + Number(res.headers.get('x-ratelimit-reset-after') || 1) * 1000;
      }
      if (res.status === 429) {
        const body = await res.json().catch(() => ({}));
        waitUntil = Date.now() + Math.ceil(Number(body.retry_after || res.headers.get('retry-after') || 1) * 1000) + 50;
        continue;
      }
      if (res.status >= 500) { await sleep(1000 * (attempt + 1)); continue; }
      if (res.status === 401) throw new ImportError(400, 'Discord didn’t accept that token. On the Bot page, click Reset Token and copy the new one.');
      if (res.status === 404 && allow404) return null;
      if (res.status === 403) { const e = new ImportError(403, 'The bot doesn’t have access to that.'); e.discord403 = true; throw e; }
      if (!res.ok) throw new ImportError(502, `Discord returned an error (${res.status}).`);
      return res.json();
    }
    throw new ImportError(502, 'Discord isn’t responding right now. Try again in a few minutes.');
  }
  return { call };
}

// Downloads a file from Discord's CDN into uploads/<folder>/<key>/<name>.
async function download(url, folder, name, maxBytes) {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (!FILE_HOSTS.has(u.host) || !/^https?:$/.test(u.protocol)) return null;
  try {
    const res = await fetch(u, { redirect: 'error', signal: AbortSignal.timeout(120000) });
    if (!res.ok) return null;
    if (Number(res.headers.get('content-length') || 0) > maxBytes) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) return null;
    const safe = (String(name || 'file').replace(/[^\w.\- ]+/g, '_').trim() || 'file').slice(0, 100);
    const key = crypto.randomBytes(12).toString('base64url');
    const dir = path.join(uploadsDir, folder, key);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, safe), buf);
    return { url: `/uploads/${folder}/${key}/${encodeURIComponent(safe)}`, name: safe, size: buf.length, type: String(res.headers.get('content-type') || '').slice(0, 100) };
  } catch {
    return null;
  }
}

// ---------- mapping ----------
const D = {
  CREATE_INVITE: 1n << 0n, KICK: 1n << 1n, BAN: 1n << 2n, ADMINISTRATOR: 1n << 3n, MANAGE_CHANNELS: 1n << 4n,
  MANAGE_GUILD: 1n << 5n, ADD_REACTIONS: 1n << 6n, VIEW_AUDIT_LOG: 1n << 7n, STREAM: 1n << 9n, VIEW_CHANNEL: 1n << 10n,
  SEND_MESSAGES: 1n << 11n, MANAGE_MESSAGES: 1n << 13n, ATTACH_FILES: 1n << 15n, READ_HISTORY: 1n << 16n,
  CONNECT: 1n << 20n, SPEAK: 1n << 21n, MANAGE_ROLES: 1n << 28n, MODERATE_MEMBERS: 1n << 40n,
};
const PERM_MAP = [
  [D.VIEW_CHANNEL, P.VIEW_CHANNELS], [D.SEND_MESSAGES, P.SEND_MESSAGES], [D.ATTACH_FILES, P.ATTACH_FILES],
  [D.ADD_REACTIONS, P.ADD_REACTIONS], [D.MANAGE_MESSAGES, P.MANAGE_MESSAGES], [D.MANAGE_CHANNELS, P.MANAGE_CHANNELS],
  [D.MANAGE_ROLES, P.MANAGE_ROLES], [D.MANAGE_GUILD, P.MANAGE_SERVER], [D.CREATE_INVITE, P.CREATE_INVITE],
  [D.KICK, P.KICK_MEMBERS], [D.BAN, P.BAN_MEMBERS], [D.CONNECT, P.CONNECT], [D.SPEAK, P.SPEAK], [D.STREAM, P.VIDEO],
  [D.MODERATE_MEMBERS, P.MODERATE_MEMBERS], [D.VIEW_AUDIT_LOG, P.VIEW_AUDIT_LOG], [D.ADMINISTRATOR, P.ADMINISTRATOR],
];
function mapPerms(discordBits) {
  const b = BigInt(discordBits || 0);
  let out = 0;
  for (const [d, h] of PERM_MAP) if (b & d) out |= h;
  return out;
}

// Discord channel types
const T = { TEXT: 0, VOICE: 2, CATEGORY: 4, ANNOUNCEMENT: 5, STAGE: 13, FORUM: 15, MEDIA: 16 };
function hearthType(c) {
  if (c.type === T.TEXT || c.type === T.ANNOUNCEMENT) return 'text';
  if (c.type === T.VOICE || c.type === T.STAGE) return 'voice';
  if (c.type === T.CATEGORY) return 'category';
  return null; // forums, media channels, threads: not supported yet
}
const TYPE_LABEL = { [T.FORUM]: 'forum channel', [T.MEDIA]: 'media channel' };

// What the bot can do in a channel, worked out the same way Discord does.
function botCanRead(guild, botMember, channel) {
  const everyone = guild.roles.find((r) => r.id === guild.id);
  let perms = BigInt(everyone ? everyone.permissions : 0);
  for (const r of guild.roles) if (botMember.roles.includes(r.id)) perms |= BigInt(r.permissions);
  if (perms & D.ADMINISTRATOR) return true;
  const ow = channel.permission_overwrites || [];
  const apply = (o) => { if (o) perms = (perms & ~BigInt(o.deny)) | BigInt(o.allow); };
  apply(ow.find((o) => o.id === guild.id));
  let allow = 0n; let deny = 0n;
  for (const o of ow) if (o.type === 0 && botMember.roles.includes(o.id)) { allow |= BigInt(o.allow); deny |= BigInt(o.deny); }
  perms = (perms & ~deny) | allow;
  apply(ow.find((o) => o.type === 1 && o.id === botMember.user.id));
  return (perms & D.VIEW_CHANNEL) !== 0n && (perms & D.READ_HISTORY) !== 0n;
}

// ---------- wizard steps (stateless: the token is sent with each call) ----------
async function inspectToken(rawToken) {
  const token = checkToken(rawToken);
  const dc = client(token);
  const me = await dc.call('/users/@me');
  if (!me.bot) throw new ImportError(400, 'That’s not a bot token. Hearth only accepts bot tokens (user tokens break Discord’s rules).');
  const app = await dc.call('/oauth2/applications/@me');
  const flags = Number(app.flags || 0);
  const messageContent = !!(flags & ((1 << 18) | (1 << 19)));
  const guilds = await dc.call('/users/@me/guilds');
  return {
    bot: { id: me.id, name: me.username },
    applicationId: app.id,
    messageContentIntent: messageContent,
    inviteUrl: `https://discord.com/oauth2/authorize?client_id=${app.id}&scope=bot&permissions=${BOT_PERMISSIONS}`,
    guilds: guilds.map((g) => ({ id: g.id, name: g.name, icon: g.icon ? `${CDN}/icons/${g.id}/${g.icon}.png?size=64` : null })),
  };
}

async function loadGuild(dc, guildId) {
  if (!/^\d{5,25}$/.test(String(guildId))) throw new ImportError(400, 'Pick a server.');
  let guild;
  try { guild = await dc.call(`/guilds/${guildId}`); } catch (e) {
    if (e.discord403) throw new ImportError(400, 'The bot isn’t in that server yet. Use the invite link to add it.');
    throw e;
  }
  const channels = await dc.call(`/guilds/${guildId}/channels`);
  const me = await dc.call('/users/@me');
  const botMember = await dc.call(`/guilds/${guildId}/members/${me.id}`);
  return { guild, channels, botMember };
}

async function preview(rawToken, guildId) {
  const dc = client(checkToken(rawToken));
  const { guild, channels, botMember } = await loadGuild(dc, guildId);
  const roles = guild.roles.filter((r) => r.id !== guild.id && !r.managed).sort((a, b) => b.position - a.position);
  const cats = channels.filter((c) => c.type === T.CATEGORY).sort((a, b) => a.position - b.position);
  const list = channels.filter((c) => c.type !== T.CATEGORY).sort((a, b) => a.position - b.position).map((c) => {
    const type = hearthType(c);
    return {
      id: c.id, name: c.name, parentId: c.parent_id || null, type: type || 'unsupported',
      label: type ? null : (TYPE_LABEL[c.type] || 'channel type'),
      topic: c.topic || '', nsfw: !!c.nsfw, readable: type === 'text' ? botCanRead(guild, botMember, c) : null,
      private: !!(c.permission_overwrites || []).find((o) => o.id === guild.id && (BigInt(o.deny) & D.VIEW_CHANNEL)),
    };
  });
  return {
    guild: { id: guild.id, name: guild.name, icon: guild.icon ? `${CDN}/icons/${guild.id}/${guild.icon}.png?size=128` : null },
    roles: roles.map((r) => ({ name: r.name, color: r.color ? '#' + r.color.toString(16).padStart(6, '0') : null })),
    skippedRoles: guild.roles.filter((r) => r.managed).map((r) => r.name),
    categories: cats.map((c) => ({ id: c.id, name: c.name })),
    channels: list,
  };
}

// ---------- jobs ----------
const running = new Map(); // jobId -> { token, cancel }

function archiveUserId() {
  const u = one(`SELECT id FROM users WHERE username = 'discord-archive'`);
  if (u) return u.id;
  const id = newId();
  // A locked system account: '!' is not a valid password hash, so no one can
  // ever sign in as it, and the name can't be registered by a person.
  run(`INSERT INTO users (id, username, display_name, password_hash, created_at, is_system) VALUES (?, 'discord-archive', 'Discord archive', '!', ?, 1)`, id, Date.now());
  return id;
}

function jobView(j) {
  return {
    id: j.id, serverId: j.server_id, sourceName: j.source_name, status: j.status,
    progress: JSON.parse(j.progress), error: j.error, createdAt: j.created_at, finishedAt: j.finished_at,
    needsToken: j.status === 'interrupted',
  };
}

function listJobs(userId) {
  return all('SELECT * FROM import_jobs WHERE user_id = ? ORDER BY created_at DESC LIMIT 10', userId).map(jobView);
}

function cleanOptions(o) {
  const channels = {};
  for (const [id, v] of Object.entries((o && o.channels) || {})) if (/^\d+$/.test(id)) channels[id] = { messages: !!(v && v.messages) };
  const since = o && o.since ? Date.parse(o.since) : NaN;
  return {
    guildId: String((o && o.guildId) || ''), channels,
    since: Number.isFinite(since) ? since : null,
    files: o ? o.files !== false : true,
    avatars: o ? o.avatars !== false : true,
    name: o && o.name ? String(o.name).trim().slice(0, 64) : null,
  };
}

async function start(userId, rawToken, rawOptions, acceptedResponsibility) {
  if (!acceptedResponsibility) throw new ImportError(400, 'Please confirm you’re allowed to move this server’s content.');
  const token = checkToken(rawToken);
  const options = cleanOptions(rawOptions);
  if (one(`SELECT 1 FROM import_jobs WHERE user_id = ? AND status = 'running'`, userId)) {
    throw new ImportError(409, 'You already have an import running. Wait for it to finish first.');
  }
  if (running.size >= MAX_JOBS) throw new ImportError(503, 'Hearth is busy with other imports right now. Try again in a little while.');
  const dc = client(token);
  const { guild } = await loadGuild(dc, options.guildId);
  const id = newId();
  run(`INSERT INTO import_jobs (id, user_id, source, source_name, status, options, progress, created_at)
       VALUES (?, ?, 'discord', ?, 'running', ?, ?, ?)`, id, userId, guild.name, JSON.stringify(options),
  JSON.stringify({ phase: 'starting', channelsDone: 0, channelsTotal: 0, messages: 0, files: 0, notes: [] }), Date.now());
  launch(id, token);
  return jobView(one('SELECT * FROM import_jobs WHERE id = ?', id));
}

async function resume(userId, jobId, rawToken) {
  const j = one('SELECT * FROM import_jobs WHERE id = ? AND user_id = ?', jobId, userId);
  if (!j) throw new ImportError(404, 'Import not found.');
  if (j.status !== 'interrupted') throw new ImportError(400, 'That import isn’t paused.');
  if (running.size >= MAX_JOBS) throw new ImportError(503, 'Hearth is busy with other imports right now. Try again in a little while.');
  const token = checkToken(rawToken);
  await loadGuild(client(token), JSON.parse(j.options).guildId); // same bot still has access
  run(`UPDATE import_jobs SET status = 'running', error = NULL WHERE id = ?`, jobId);
  launch(jobId, token);
  return jobView(one('SELECT * FROM import_jobs WHERE id = ?', jobId));
}

function cancel(userId, jobId) {
  const j = one('SELECT * FROM import_jobs WHERE id = ? AND user_id = ?', jobId, userId);
  if (!j) throw new ImportError(404, 'Import not found.');
  if (j.status === 'running' || j.status === 'interrupted') {
    run(`UPDATE import_jobs SET status = 'cancelled', finished_at = ? WHERE id = ?`, Date.now(), jobId);
    const r = running.get(jobId);
    if (r) r.cancelled = true;
  }
  return jobView(one('SELECT * FROM import_jobs WHERE id = ?', jobId));
}

function launch(jobId, token) {
  const handle = { token, cancelled: false };
  running.set(jobId, handle);
  runJob(jobId, handle)
    .catch((e) => {
      const msg = e instanceof ImportError ? e.message : 'Something went wrong during the import.';
      if (!(e instanceof ImportError)) console.error('[import]', e && e.stack ? e.stack.replace(token, '[token]') : e);
      run(`UPDATE import_jobs SET status = 'interrupted', error = ? WHERE id = ? AND status = 'running'`, msg, jobId);
      publish(jobId, true);
    })
    .finally(() => { handle.token = null; running.delete(jobId); });
}

// An import that was running when the server restarted can be continued
// (the token was only in memory, so the owner pastes it again).
run(`UPDATE import_jobs SET status = 'interrupted', error = 'Hearth restarted during the import.' WHERE status = 'running'`);

let lastPublish = new Map();
function publish(jobId, force) {
  const now = Date.now();
  if (!force && now - (lastPublish.get(jobId) || 0) < 750) return;
  lastPublish.set(jobId, now);
  const j = one('SELECT * FROM import_jobs WHERE id = ?', jobId);
  if (j) bus.publish(`user:${j.user_id}`, { t: 'IMPORT_PROGRESS', d: jobView(j) });
}

async function runJob(jobId, handle) {
  const job = one('SELECT * FROM import_jobs WHERE id = ?', jobId);
  const opts = JSON.parse(job.options);
  const progress = JSON.parse(job.progress);
  const dc = client(handle.token);
  const save = (force) => {
    run('UPDATE import_jobs SET progress = ? WHERE id = ?', JSON.stringify(progress), jobId);
    publish(jobId, force);
  };
  const note = (text) => { if (!progress.notes.includes(text) && progress.notes.length < 50) progress.notes.push(text); };
  const stopped = () => handle.cancelled || (one('SELECT status FROM import_jobs WHERE id = ?', jobId) || {}).status !== 'running';
  const mapGet = (kind, sourceId) => (one('SELECT hearth_id FROM import_map WHERE job_id = ? AND kind = ? AND source_id = ?', jobId, kind, String(sourceId)) || {}).hearth_id;
  const mapSet = (kind, sourceId, hearthId) => run('INSERT OR REPLACE INTO import_map (job_id, kind, source_id, hearth_id) VALUES (?, ?, ?, ?)', jobId, kind, String(sourceId), String(hearthId));

  const { guild, channels } = await loadGuild(dc, opts.guildId);
  progress.phase = 'structure';
  save(true);

  // ----- server -----
  let serverId = job.server_id;
  if (!serverId) {
    serverId = newId();
    const now = Date.now();
    const adult = guild.nsfw_level === 1 || guild.nsfw_level === 3 ? 18 : 0;
    tx(() => {
      run('INSERT INTO servers (id, name, owner_id, created_at, age_rating) VALUES (?, ?, ?, ?, ?)', serverId, (opts.name || guild.name).slice(0, 64), job.user_id, now, adult);
      run('INSERT INTO members (server_id, user_id, joined_at) VALUES (?, ?, ?)', serverId, job.user_id, now);
      run('UPDATE import_jobs SET server_id = ? WHERE id = ?', serverId, jobId);
    });
    if (guild.icon) {
      const icon = await download(`${CDN}/icons/${guild.id}/${guild.icon}.png?size=256`, 'avatars', 'icon.png', 10 * 1024 * 1024);
      if (icon) run('UPDATE servers SET icon = ? WHERE id = ?', icon.url, serverId);
    }
  }

  // ----- roles -----
  const everyone = guild.roles.find((r) => r.id === guild.id);
  if (!mapGet('role', guild.id)) {
    let perms = everyone ? mapPerms(everyone.permissions) : DEFAULT_EVERYONE;
    if (perms & P.ADMINISTRATOR) { perms &= ~P.ADMINISTRATOR; note('@everyone had Administrator on Discord. For safety it was left off in Hearth.'); }
    const rid = newId();
    run(`INSERT INTO roles (id, server_id, name, permissions, position, is_default) VALUES (?, ?, '@everyone', ?, 0, 1)`, rid, serverId, perms);
    mapSet('role', guild.id, rid);
  }
  const roles = guild.roles.filter((r) => r.id !== guild.id).sort((a, b) => a.position - b.position || (BigInt(a.id) < BigInt(b.id) ? 1 : -1));
  let pos = 1;
  for (const r of roles) {
    if (r.managed) { note(`Skipped the "${r.name}" role (it belongs to a Discord bot or integration).`); continue; }
    if (!mapGet('role', r.id)) {
      const rid = newId();
      run('INSERT INTO roles (id, server_id, name, color, permissions, position) VALUES (?, ?, ?, ?, ?, ?)',
        rid, serverId, (r.name || 'role').slice(0, 32), r.color ? '#' + r.color.toString(16).padStart(6, '0') : null, mapPerms(r.permissions), pos);
      mapSet('role', r.id, rid);
    }
    pos++;
  }

  // ----- channels -----
  const sorted = [...channels].sort((a, b) => a.position - b.position || (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
  const make = (c) => {
    if (mapGet('channel', c.id)) return;
    const type = hearthType(c);
    if (!type) { note(`Skipped #${c.name}: ${TYPE_LABEL[c.type] || 'that channel type'}s aren’t supported yet.`); return; }
    let name = String(c.name || 'channel').slice(0, 64);
    if (type === 'text') name = name.toLowerCase().replace(/\s+/g, '-');
    const id = newId();
    tx(() => {
      run(`INSERT INTO channels (id, server_id, name, type, topic, position, created_at, parent_id, slowmode, age_rating, pending_review)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`, id, serverId, name, type, String(c.topic || '').slice(0, 256), c.position | 0, Date.now(),
      c.parent_id ? mapGet('channel', c.parent_id) || null : null,
      type === 'text' ? Math.min(21600, c.rate_limit_per_user | 0) : 0, c.nsfw ? 18 : 0);
      // Role-based permission overrides (per-person ones need the person).
      for (const o of c.permission_overwrites || []) {
        if (o.type !== 0) continue;
        const roleId = mapGet('role', o.id);
        if (!roleId) continue;
        run('INSERT OR REPLACE INTO channel_overrides (channel_id, target_type, target_id, allow, deny) VALUES (?, \'role\', ?, ?, ?)',
          id, roleId, mapPerms(o.allow), mapPerms(o.deny));
      }
      mapSet('channel', c.id, id);
    });
    if (c.type === T.ANNOUNCEMENT) note(`#${c.name} was an announcement channel; it’s a regular text channel in Hearth.`);
    if (c.type === T.STAGE) note(`${c.name} was a stage channel; it’s a regular voice channel in Hearth.`);
  };
  for (const c of sorted.filter((x) => x.type === T.CATEGORY)) make(c);
  for (const c of sorted.filter((x) => x.type !== T.CATEGORY)) make(c);

  // ----- messages -----
  const toImport = sorted.filter((c) => hearthType(c) === 'text' && opts.channels[c.id] && opts.channels[c.id].messages);
  progress.phase = 'messages';
  progress.channelsTotal = toImport.length;
  save(true);
  const archiveId = archiveUserId();
  const names = { channels: new Map(channels.map((c) => [c.id, c.name])), roles: new Map(guild.roles.map((r) => [r.id, r.name])) };
  let fileBytes = Number(progress.fileBytes || 0);

  const avatarFor = async (u) => {
    if (!opts.avatars || !u.avatar) return null;
    const key = `${u.id}:${u.avatar}`;
    const known = mapGet('avatar', key);
    if (known) return known;
    const a = await download(`${CDN}/avatars/${u.id}/${u.avatar}.png?size=128`, 'avatars', 'avatar.png', 5 * 1024 * 1024);
    if (a) mapSet('avatar', key, a.url);
    return a ? a.url : null;
  };

  for (const c of toImport) {
    if (stopped()) return;
    const channelId = mapGet('channel', c.id);
    if (mapGet('done', c.id)) continue;
    progress.currentChannel = c.name;
    save(true);
    // Start after the last message we already brought over (when resuming),
    // or after the cut-off date, or from the very beginning.
    let after = mapGet('cursor', c.id) || (opts.since ? String((BigInt(opts.since) - 1420070400000n) << 22n) : '0');
    let reachable = true;
    for (;;) {
      if (stopped()) return;
      let page;
      try { page = await dc.call(`/channels/${c.id}/messages?limit=100&after=${after}`); } catch (e) {
        if (e.discord403) { reachable = false; break; }
        throw e;
      }
      if (!page.length) break;
      page.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
      // Download first (slow, outside the database transaction)...
      const prepared = [];
      for (const m of page) {
        if (![0, 19, 20, 23].includes(m.type)) continue; // skip joins, pins, boosts and other system notices
        const attachments = [];
        const extra = [];
        for (const a of m.attachments || []) {
          if (!opts.files) { extra.push(`[file: ${a.filename}]`); continue; }
          if (a.size > config.maxUploadBytes || fileBytes + a.size > MAX_FILE_BYTES_TOTAL) {
            extra.push(`[file not transferred: ${a.filename}]`); progress.skippedFiles = (progress.skippedFiles || 0) + 1; continue;
          }
          const f = await download(a.url, channelId, a.filename, config.maxUploadBytes);
          if (f) { attachments.push({ ...f, type: a.content_type || f.type }); fileBytes += f.size; progress.files++; } else {
            extra.push(`[file not transferred: ${a.filename}]`); progress.skippedFiles = (progress.skippedFiles || 0) + 1;
          }
        }
        prepared.push({ m, attachments, extra, avatar: await avatarFor(m.author) });
      }
      // ...then write the whole page at once.
      tx(() => {
        for (const { m, attachments, extra, avatar } of prepared) {
          if (mapGet('message', m.id)) continue;
          const content = [convertContent(m, names), ...embedText(m), ...extra].filter(Boolean).join('\n').slice(0, 8000);
          if (!content && !attachments.length) continue;
          const id = newId();
          const ref = m.message_reference && m.message_reference.message_id ? mapGet('message', m.message_reference.message_id) || null : null;
          const author = {
            name: String(m.author.global_name || m.author.username || 'unknown').slice(0, 64),
            username: String(m.author.username || '').slice(0, 64), id: m.author.id, avatar, bot: !!(m.author.bot || m.webhook_id),
          };
          const reactions = (m.reactions || []).map((r) => ({ emoji: r.emoji.id ? `:${r.emoji.name}:` : r.emoji.name, count: r.count | 0 })).filter((r) => r.emoji && r.count);
          run(`INSERT INTO messages (id, channel_id, author_id, content, attachments, reply_to, created_at, edited_at, import_source, imported_author, imported_reactions)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'discord', ?, ?)`,
          id, channelId, archiveId, content, attachments.length ? JSON.stringify(attachments) : null, ref,
          Date.parse(m.timestamp) || Date.now(), m.edited_timestamp ? Date.parse(m.edited_timestamp) : null,
          JSON.stringify(author), reactions.length ? JSON.stringify(reactions) : null);
          mapSet('message', m.id, id);
          progress.messages++;
        }
        after = page[page.length - 1].id;
        mapSet('cursor', c.id, after);
        progress.fileBytes = fileBytes;
        run('UPDATE import_jobs SET progress = ? WHERE id = ?', JSON.stringify(progress), jobId);
      });
      publish(jobId);
      if (page.length < 100) break;
    }
    if (!reachable) note(`#${c.name}: the bot couldn’t read this channel, so it came over empty.`);
    else if (progress.messages) {
      // A divider so it's clear where the archive ends and Hearth begins.
      run(`INSERT INTO messages (id, channel_id, author_id, content, created_at, kind, import_source) VALUES (?, ?, ?, ?, ?, 'import_marker', 'discord')`,
        newId(), channelId, archiveId, 'Messages above were archived from Discord.', Date.now());
    }
    mapSet('done', c.id, '1');
    progress.channelsDone++;
    save(true);
  }

  if (stopped()) return;
  progress.phase = 'done';
  progress.currentChannel = null;
  tx(() => {
    run('UPDATE import_jobs SET progress = ?, status = \'done\', finished_at = ? WHERE id = ?', JSON.stringify(progress), Date.now(), jobId);
    run('DELETE FROM import_map WHERE job_id = ? AND kind IN (\'cursor\', \'done\', \'avatar\')', jobId);
  });
  run(`INSERT INTO audit_log (id, server_id, actor_id, action, target_type, target_id, target_name, reason, created_at)
       VALUES (?, ?, ?, 'server.import', 'server', ?, ?, ?, ?)`, newId(), serverId, job.user_id, serverId, guild.name,
  `Imported from Discord: ${progress.messages} messages, ${progress.files} files`, Date.now());
  const payload = ser.server(serverId, job.user_id);
  bus.publish(`user:${job.user_id}`, { t: 'SERVER_CREATE', d: payload });
  publish(jobId, true);
  console.log(`[import] job ${jobId} finished: ${progress.messages} messages, ${progress.files} files`);
}

// Turns Discord's mention codes into readable text.
function convertContent(m, names) {
  let s = String(m.content || '');
  const users = new Map((m.mentions || []).map((u) => [u.id, u.global_name || u.username]));
  s = s.replace(/<@!?(\d+)>/g, (_, id) => `@${users.get(id) || 'unknown-user'}`);
  s = s.replace(/<@&(\d+)>/g, (_, id) => `@${names.roles.get(id) || 'role'}`);
  s = s.replace(/<#(\d+)>/g, (_, id) => `#${names.channels.get(id) || 'channel'}`);
  s = s.replace(/<a?:(\w+):\d+>/g, ':$1:');
  s = s.replace(/<t:(-?\d+)(?::[tTdDfFR])?>/g, (_, t) => new Date(Number(t) * 1000).toUTCString().replace(':00 GMT', ' UTC'));
  s = s.replace(/<\/([\w -]+):\d+>/g, '/$1');
  if (m.type === 20 && m.interaction_metadata && m.interaction_metadata.name) s = `*used /${m.interaction_metadata.name}*\n${s}`;
  for (const st of m.sticker_items || []) s += `${s ? '\n' : ''}[sticker: ${st.name}]`;
  if (m.poll && m.poll.question) s += `${s ? '\n' : ''}[poll: ${m.poll.question.text || ''}]`;
  return s.trim();
}

// Rich embeds (link previews, bot cards) become plain text lines.
function embedText(m) {
  const out = [];
  for (const e of m.embeds || []) {
    if (e.type === 'image' || e.type === 'gifv' || e.type === 'video') {
      if (e.url && !String(m.content || '').includes(e.url)) out.push(e.url);
      continue;
    }
    if (e.type === 'link' || e.type === 'article') continue; // a preview of a link that's already in the text
    const parts = [];
    if (e.author && e.author.name) parts.push(`**${e.author.name}**`);
    if (e.title) parts.push(e.url ? `**${e.title}** ${e.url}` : `**${e.title}**`);
    if (e.description) parts.push(e.description);
    for (const f of e.fields || []) parts.push(`**${f.name}**: ${f.value}`);
    if (e.image && e.image.url) parts.push(e.image.url);
    if (e.footer && e.footer.text) parts.push(`_${e.footer.text}_`);
    if (parts.length) out.push('> ' + parts.join('\n').replace(/\n/g, '\n> '));
  }
  return out;
}

module.exports = { inspectToken, preview, start, resume, cancel, listJobs, ImportError, BOT_PERMISSIONS, mapPerms, convertContent };
