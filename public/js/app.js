// Hearth web client.
import { api, upload } from './api.js';
import { Gateway } from './gateway.js';
import { Voice } from './voice.js';
import {
  el, $, renderMarkdown, initials, colorFor, fmtTime, fmtDay, fmtSize, toast, modal, confirmDialog,
} from './util.js';
import * as sfx from './sfx.js';
import { startTour } from './tour.js';

// ---------------------------------------------------------------- appearance
// A palette (retro color scheme) plus a mode: dark, grey, light, or auto.
const PALETTES = [
  { id: 'phosphor', name: 'Phosphor', blurb: 'Green-screen terminal', colors: ['#0d1510', '#39d98a', '#ffb000'] },
  { id: 'pocket', name: 'Pocket Classic', blurb: '4-shade handheld green', colors: ['#0f380f', '#9bbc0f', '#c4e05a'] },
  { id: 'twilight', name: 'Twilight 16', blurb: '16-bit console grey and violet', colors: ['#1a1922', '#a48bff', '#ff5a6e'] },
  { id: 'neon', name: 'Neon Arcade', blurb: 'Synthwave cabinet glow', colors: ['#0f0b26', '#00e5ff', '#ff3cd6'] },
  { id: 'dungeon', name: 'Dungeon Crawl', blurb: 'Stone, torchlight and gold', colors: ['#181714', '#e8b04a', '#d9483b'] },
  { id: 'vector', name: 'Vector Space', blurb: 'Black-and-white vector arcade', colors: ['#070707', '#f2f2f2', '#53e0ff'] },
  { id: 'plains', name: 'Pixel Plains', blurb: 'Platformer sky, grass and coins', colors: ['#0e1b3c', '#6ad04b', '#ffcc00'] },
  { id: 'lava', name: 'Lava Castle', blurb: 'Final-level fire and gold', colors: ['#1a0f0d', '#ff6a2b', '#ffd23f'] },
];
const systemLight = window.matchMedia('(prefers-color-scheme: light)');
function pref(key, fallback) { try { return localStorage.getItem(key) || fallback; } catch { return fallback; } }
function themePref() { return pref('hearth_theme', 'dark'); }
function palettePref() { const p = pref('hearth_palette', 'phosphor'); return PALETTES.some((x) => x.id === p) ? p : 'phosphor'; }
function applyTheme(mode = themePref(), palette = palettePref()) {
  const resolved = mode === 'system' ? (systemLight.matches ? 'light' : 'dark') : mode;
  document.documentElement.dataset.theme = resolved;
  document.documentElement.dataset.palette = palette;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = getComputedStyle(document.documentElement).getPropertyValue('--bg-1').trim() || '#0d1510';
}
systemLight.addEventListener('change', () => { if (themePref() === 'system') applyTheme(); });
applyTheme();

// Must match server/permissions.js
const P = {
  VIEW_CHANNELS: 1 << 0, SEND_MESSAGES: 1 << 1, ATTACH_FILES: 1 << 2, ADD_REACTIONS: 1 << 3,
  MANAGE_MESSAGES: 1 << 4, MANAGE_CHANNELS: 1 << 5, MANAGE_ROLES: 1 << 6, MANAGE_SERVER: 1 << 7,
  CREATE_INVITE: 1 << 8, KICK_MEMBERS: 1 << 9, BAN_MEMBERS: 1 << 10, CONNECT: 1 << 11,
  SPEAK: 1 << 12, VIDEO: 1 << 13, MODERATE_MEMBERS: 1 << 14, VIEW_AUDIT_LOG: 1 << 15, ADMINISTRATOR: 1 << 30,
};
const PERM_LABELS = {
  ADMINISTRATOR: 'Administrator (everything)', MANAGE_SERVER: 'Manage server', MANAGE_ROLES: 'Manage roles',
  MANAGE_CHANNELS: 'Manage channels', MODERATE_MEMBERS: 'Timeout members and handle reports', VIEW_AUDIT_LOG: 'View audit log',
  KICK_MEMBERS: 'Kick members', BAN_MEMBERS: 'Ban members',
  MANAGE_MESSAGES: 'Delete others’ messages', CREATE_INVITE: 'Create invites', VIEW_CHANNELS: 'View channels',
  SEND_MESSAGES: 'Send messages', ATTACH_FILES: 'Attach files', ADD_REACTIONS: 'Add reactions',
  CONNECT: 'Join voice', SPEAK: 'Speak in voice', VIDEO: 'Camera & screen share',
};
const QUICK_EMOJI = ['👍', '❤️', '😂', '😮', '😢', '🔥', '🎉', '👀', '✅', '❌', '💯', '🙏'];

// ---------------------------------------------------------------- state
const S = {
  me: null,
  sessionId: null,
  servers: new Map(),   // id -> server payload
  dms: new Map(),       // id -> dm channel
  dmVoice: [],          // voice states in DM calls
  serverId: null,       // null = home (DMs)
  channelId: null,
  lastChannel: JSON.parse(localStorage.getItem('hearth_last') || '{}'), // serverId -> channelId
  messages: new Map(),  // channelId -> { list, hasMore, loading }
  unread: new Set(),
  typing: new Map(),    // channelId -> Map(userId -> timeout)
  replyTo: null,
  pending: [],          // files waiting to be sent
  presence: new Map(),  // userId -> online (live updates)
  blocked: new Set(),   // user ids I've blocked
  collapsed: new Set(JSON.parse((() => { try { return localStorage.getItem('hearth_collapsed') || '[]'; } catch { return '[]'; } })())),
  revealed: new Set(),  // blocked messages I chose to show
  viewingVoice: null,   // voice channel shown full-screen in the main area
  stageWasFull: false,
};

const gw = new Gateway();
const voice = new Voice(gw);

// ---------------------------------------------------------------- helpers
const server = () => (S.serverId ? S.servers.get(S.serverId) : null);
const findChannel = (id) => {
  for (const s of S.servers.values()) { const c = s.channels.find((x) => x.id === id); if (c) return c; }
  return S.dms.get(id) || null;
};
const memberOf = (srv, userId) => srv && srv.members.find((m) => m.user.id === userId);

function permsIn(srv) {
  if (!srv) return P.SEND_MESSAGES | P.ATTACH_FILES | P.ADD_REACTIONS | P.CONNECT | P.SPEAK | P.VIDEO | P.VIEW_CHANNELS;
  if (srv.ownerId === S.me.id) return 0x7fffffff;
  const m = memberOf(srv, S.me.id);
  let p = 0;
  for (const r of srv.roles) if (r.isDefault || (m && m.roles.includes(r.id))) p |= r.permissions;
  return p & P.ADMINISTRATOR ? 0x7fffffff : p;
}
const can = (flag, srv = server()) => (permsIn(srv) & flag) === flag;

function displayName(user, srv = server()) {
  const m = memberOf(srv, user.id);
  return (m && m.nickname) || user.displayName || user.username;
}

function roleColor(userId, srv = server()) {
  const m = memberOf(srv, userId);
  if (!m) return null;
  const roles = srv.roles.filter((r) => m.roles.includes(r.id) && r.color).sort((a, b) => b.position - a.position);
  return roles[0] ? roles[0].color : null;
}

function userById(id) {
  if (S.me && S.me.id === id) return S.me;
  for (const s of S.servers.values()) { const m = memberOf(s, id); if (m) return m.user; }
  for (const d of S.dms.values()) { const u = d.recipients.find((r) => r.id === id); if (u) return u; }
  return { id, username: 'unknown', displayName: 'Unknown user' };
}

function isOnline(userId) {
  if (userId === S.me.id) return true;
  if (S.presence.has(userId)) return S.presence.get(userId);
  for (const s of S.servers.values()) { const m = memberOf(s, userId); if (m) return m.online; }
  for (const d of S.dms.values()) { const r = d.recipients.find((x) => x.id === userId); if (r) return !!r.online; }
  return false;
}

function avatar(user, { status = false, size } = {}) {
  const a = el('span', { class: 'avatar' });
  if (user.avatar) a.style.backgroundImage = `url("${user.avatar}")`;
  else { a.textContent = initials(user.displayName || user.username); a.style.background = colorFor(user.id); }
  if (size) { a.style.width = a.style.height = size + 'px'; }
  if (status) a.append(el('span', { class: 'status' + (isOnline(user.id) ? ' on' : '') }));
  return a;
}

function allVoiceStates() {
  const out = [...S.dmVoice];
  for (const s of S.servers.values()) out.push(...s.voiceStates);
  return out;
}
const voiceIn = (channelId) => allVoiceStates().filter((v) => v.channelId === channelId);

const DELETED_USER = { id: 'deleted', username: 'deleted', displayName: 'Deleted user', avatar: null };
function dmOther(dm) { return dm.recipients.find((r) => r.id !== S.me.id) || DELETED_USER; }

function saveCollapsed() { try { localStorage.setItem('hearth_collapsed', JSON.stringify([...S.collapsed])); } catch { /* ignore */ } }
function saveLast() { localStorage.setItem('hearth_last', JSON.stringify(S.lastChannel)); }

// ---------------------------------------------------------------- auth screen
let registering = false;
function showAuth(invite) {
  $('app').classList.add('hidden');
  $('auth').classList.remove('hidden');
  const inviteNote = $('auth-invite');
  if (invite) { inviteNote.textContent = `You've been invited to join ${invite.server.name}. Log in or register to accept.`; inviteNote.classList.remove('hidden'); }
  setAuthMode(registering);
}

function setAuthMode(reg) {
  registering = reg;
  $('auth-title').textContent = reg ? 'Create an account' : 'Welcome back';
  $('auth-submit').textContent = reg ? 'Register' : 'Log in';
  $('auth-toggle').textContent = reg ? 'Have an account? Log in' : 'Need an account? Register';
  $('auth-display-wrap').classList.toggle('hidden', !reg);
  for (const id of ['auth-email-wrap', 'auth-dob-wrap', 'auth-dob-hint', 'auth-password2-wrap']) $(id).classList.toggle('hidden', !reg);
  $('auth-password2').required = reg;
  $('auth-email').required = reg;
  $('auth-dob').required = reg;
  $('auth-dob').max = new Date().toISOString().slice(0, 10);
  $('auth-forgot-wrap').classList.toggle('hidden', reg);
  $('auth-terms-wrap').classList.toggle('hidden', !reg);
  $('auth-terms').required = reg;
  $('auth-password').autocomplete = reg ? 'new-password' : 'current-password';
  $('auth-password').minLength = reg ? 12 : 1;
  $('auth-password-hint').classList.toggle('hidden', !reg);
  $('auth-error').textContent = '';
}

$('auth-toggle').onclick = (e) => { e.preventDefault(); setAuthMode(!registering); };
$('auth-forgot').onclick = (e) => { e.preventDefault(); forgotModal(); };
// Show/hide buttons on password fields.
document.addEventListener('click', (e) => {
  const b = e.target.closest('.pw-eye');
  if (!b) return;
  const input = $(b.dataset.for) || b.previousElementSibling;
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  b.title = show ? 'Hide password' : 'Show password';
  b.classList.toggle('on', show);
});
$('auth-form').onsubmit = async (e) => {
  e.preventDefault();
  $('auth-error').textContent = '';
  try {
    const body = { username: $('auth-username').value.trim(), password: $('auth-password').value };
    if (registering) {
      // Catch typos before the account is created with a password nobody knows.
      if ($('auth-password').value !== $('auth-password2').value) {
        $('auth-error').textContent = 'The two passwords don\u2019t match. Retype them carefully.';
        $('auth-password2').focus();
        return;
      }
      body.displayName = $('auth-display').value.trim() || undefined;
      body.acceptTerms = $('auth-terms').checked;
      body.email = $('auth-email').value.trim();
      body.birthdate = $('auth-dob').value;
    }
    const res = await api('POST', registering ? '/auth/register' : '/auth/login', body);
    S.me = res.user;
    $('auth-password').value = '';
    start();
    if (registering) setTimeout(() => verifyEmailModal(true), 600);
  } catch (err) {
    $('auth-error').textContent = err.message;
  }
};

// ---------------------------------------------------------------- startup
function inviteCodeFromUrl() {
  const m = location.pathname.match(/^\/invite\/([\w-]+)/);
  return m ? m[1] : null;
}

async function boot() {
  const code = inviteCodeFromUrl();
  let invite = null;
  if (code) invite = await api('GET', `/invites/${code}`).catch(() => null);
  try {
    S.me = await api('GET', '/users/@me');
    start();
  } catch {
    showAuth(invite);
  }
}

function start() {
  $('auth').classList.add('hidden');
  $('app').classList.remove('hidden');
  gw.connect();
}

gw.on('INVALID_SESSION', () => { voice.forceLeave(); location.href = '/'; });
gw.on('DISCONNECTED', () => { if (voice.active) voice.forceLeave(); });

gw.on('READY', async (d) => {
  S.me = d.user;
  S.sessionId = d.sessionId;
  voice.sessionId = d.sessionId;
  voice.iceServers = d.iceServers;
  S.gifs = d.gifs || null;
  $('gif-btn').classList.toggle('hidden', !S.gifs);
  S.servers = new Map(d.servers.map((s) => [s.id, s]));
  S.dms = new Map(d.dms.map((c) => [c.id, c]));
  S.dmVoice = d.dmVoiceStates;
  S.blocked = new Set(d.blocked || []);
  S.messages.clear();
  renderMe();
  renderRail();
  renderAccountBanner();
  updateAdminButton();
  maybeWelcome();

  const code = inviteCodeFromUrl();
  if (code) {
    history.replaceState(null, '', '/');
    await acceptInvite(code);
    return;
  }
  const keep = S.serverId && S.servers.has(S.serverId) ? S.serverId : (S.lastChannel._server || null);
  selectServer(keep && S.servers.has(keep) ? keep : null);
});

// ---------------------------------------------------------------- live events
gw.on('MESSAGE_CREATE', (m) => {
  const bucket = S.messages.get(m.channelId);
  if (bucket && !bucket.list.some((x) => x.id === m.id)) bucket.list.push(m);
  clearTyping(m.channelId, m.author.id);
  if (m.channelId === S.channelId) {
    appendMessage(m);
  } else if (m.author.id !== S.me.id) {
    S.unread.add(m.channelId);
    renderRail();
    renderSidebar();
  }
  if (m.author.id !== S.me.id) notifyMessage(m);
});

gw.on('MESSAGE_UPDATE', (m) => {
  const bucket = S.messages.get(m.channelId);
  if (!bucket) return;
  const i = bucket.list.findIndex((x) => x.id === m.id);
  if (i >= 0) bucket.list[i] = { ...m, reactions: bucket.list[i].reactions };
  if (m.channelId === S.channelId) renderMessages({ keepScroll: true });
});

gw.on('MESSAGE_DELETE', ({ id, channelId }) => {
  const bucket = S.messages.get(channelId);
  if (bucket) bucket.list = bucket.list.filter((x) => x.id !== id);
  if (channelId === S.channelId) renderMessages({ keepScroll: true });
});

function onReaction(d, add) {
  const bucket = S.messages.get(d.channelId);
  const msg = bucket && bucket.list.find((x) => x.id === d.messageId);
  if (!msg) return;
  let r = msg.reactions.find((x) => x.emoji === d.emoji);
  if (add) {
    if (!r) msg.reactions.push((r = { emoji: d.emoji, count: 0, me: false }));
    r.count++;
    if (d.userId === S.me.id) r.me = true;
  } else if (r) {
    r.count--;
    if (d.userId === S.me.id) r.me = false;
    if (r.count <= 0) msg.reactions = msg.reactions.filter((x) => x !== r);
  }
  if (d.channelId === S.channelId) renderMessages({ keepScroll: true });
}
gw.on('REACTION_ADD', (d) => onReaction(d, true));
gw.on('REACTION_REMOVE', (d) => onReaction(d, false));

gw.on('TYPING_START', ({ channelId, userId }) => {
  if (userId === S.me.id) return;
  if (!S.typing.has(channelId)) S.typing.set(channelId, new Map());
  const map = S.typing.get(channelId);
  clearTimeout(map.get(userId));
  map.set(userId, setTimeout(() => clearTyping(channelId, userId), 8000));
  renderTyping();
});

function clearTyping(channelId, userId) {
  const map = S.typing.get(channelId);
  if (!map || !map.has(userId)) return;
  clearTimeout(map.get(userId));
  map.delete(userId);
  renderTyping();
}

gw.on('SERVER_CREATE', (s) => { S.servers.set(s.id, s); renderRail(); });
gw.on('IMPORT_PROGRESS', (job) => {
  if (IMPORT.onJob) IMPORT.onJob(job);
  else if (job.status === 'done') toast(`Import finished: ${job.sourceName}. Open it to review its channels.`);
  else if (job.status === 'interrupted') toast(`The import of ${job.sourceName} paused. Open “Move a server from Discord” to continue.`);
});
gw.on('SERVER_UPDATE', (d) => {
  const s = S.servers.get(d.id);
  if (!s) return;
  Object.assign(s, d);
  renderRail();
  if (S.serverId === d.id) renderSidebar();
});
gw.on('SERVER_DELETE', ({ id }) => {
  if (!S.servers.has(id)) return;
  if (voice.active && findChannel(voice.channelId)?.serverId === id) voice.forceLeave();
  S.servers.delete(id);
  renderRail();
  if (S.serverId === id) { toast('You are no longer in that server.'); selectServer(null); }
});

gw.on('CHANNEL_CREATE', (c) => {
  const s = S.servers.get(c.serverId);
  if (s && !s.channels.some((x) => x.id === c.id)) { s.channels.push(c); if (S.serverId === s.id) renderSidebar(); }
});
gw.on('CHANNEL_UPDATE', (c) => {
  const s = S.servers.get(c.serverId);
  if (!s) return;
  const i = s.channels.findIndex((x) => x.id === c.id);
  if (i >= 0) s.channels[i] = c;
  s.channels.sort((a, b) => a.position - b.position);
  if (S.serverId === s.id) { renderSidebar(); renderHeader(); }
});
gw.on('CHANNEL_DELETE', ({ id, serverId }) => {
  const s = S.servers.get(serverId);
  if (!s) return;
  s.channels = s.channels.filter((x) => x.id !== id);
  if (voice.channelId === id) voice.forceLeave();
  if (S.channelId === id) selectServer(serverId);
  else if (S.serverId === serverId) renderSidebar();
});

gw.on('DM_CREATE', (dm) => { S.dms.set(dm.id, dm); if (!S.serverId) renderSidebar(); });

gw.on('MEMBER_ADD', ({ serverId, member }) => {
  const s = S.servers.get(serverId);
  if (!s || memberOf(s, member.user.id)) return;
  s.members.push(member);
  if (S.serverId === serverId) renderMembers();
});
gw.on('MEMBER_UPDATE', ({ serverId, member }) => {
  const s = S.servers.get(serverId);
  if (!s) return;
  const i = s.members.findIndex((m) => m.user.id === member.user.id);
  if (i >= 0) s.members[i] = member; else s.members.push(member);
  if (S.serverId === serverId) { renderMembers(); renderSidebar(); renderHeader(); }
});
gw.on('MEMBER_REMOVE', ({ serverId, userId }) => {
  const s = S.servers.get(serverId);
  if (!s) return;
  s.members = s.members.filter((m) => m.user.id !== userId);
  if (S.serverId === serverId) renderMembers();
});

gw.on('ROLE_UPDATE', (r) => {
  const s = S.servers.get(r.serverId);
  if (!s) return;
  const i = s.roles.findIndex((x) => x.id === r.id);
  if (i >= 0) s.roles[i] = r; else s.roles.push(r);
  s.roles.sort((a, b) => b.position - a.position);
  if (S.serverId === r.serverId) { renderMembers(); renderSidebar(); renderHeader(); }
});
gw.on('ROLE_DELETE', ({ id, serverId }) => {
  const s = S.servers.get(serverId);
  if (!s) return;
  s.roles = s.roles.filter((x) => x.id !== id);
  for (const m of s.members) m.roles = m.roles.filter((r) => r !== id);
  if (S.serverId === serverId) renderMembers();
});

// An account was permanently deleted: remove everything of theirs on screen.
gw.on('USER_DELETE', ({ userId }) => {
  for (const bucket of S.messages.values()) bucket.list = bucket.list.filter((m) => m.author.id !== userId);
  for (const s of S.servers.values()) s.members = s.members.filter((m) => m.user.id !== userId);
  for (const d of S.dms.values()) d.recipients = d.recipients.filter((r) => r.id !== userId);
  renderMembers();
  renderSidebar();
  renderHeader();
  if (S.channelId) renderMessages({ keepScroll: true });
});

gw.on('USER_UPDATE', (u) => {
  if (u.id === S.me.id) { S.me = { ...S.me, ...u }; renderMe(); }
  for (const s of S.servers.values()) { const m = memberOf(s, u.id); if (m) m.user = u; }
  for (const d of S.dms.values()) d.recipients = d.recipients.map((r) => (r.id === u.id ? u : r));
  renderMembers();
  if (S.channelId) renderMessages({ keepScroll: true });
});

gw.on('PRESENCE_UPDATE', ({ userId, online }) => {
  S.presence.set(userId, online);
  for (const s of S.servers.values()) {
    const m = memberOf(s, userId);
    if (m) m.online = online;
  }
  renderMembers();
  if (!S.serverId) renderSidebar();
});

gw.on('VOICE_STATE_UPDATE', (v) => {
  // Blip when someone else enters or leaves the call you're in.
  if (voice.active && v.userId !== S.me.id) {
    const was = voiceIn(voice.channelId).some((x) => x.userId === v.userId);
    const now = v.channelId === voice.channelId;
    if (now && !was) sfx.play('peerIn');
    if (!now && was) sfx.play('peerOut');
  }
  const scope = v.serverId ? S.servers.get(v.serverId)?.voiceStates : S.dmVoice;
  if (!scope) return;
  const i = scope.findIndex((x) => x.userId === v.userId);
  if (i >= 0) scope.splice(i, 1);
  if (v.channelId) scope.push(v);
  if (v.serverId) { const s = S.servers.get(v.serverId); s.voiceStates = scope; }
  else S.dmVoice = scope;

  if (v.userId === S.me.id && v.sessionId !== S.sessionId && voice.active && v.channelId) {
    // We joined voice from another device.
  }
  if (voice.active) voice.sync(voiceIn(voice.channelId));
  renderSidebar();
  renderVoiceUI();
});

gw.on('VOICE_SIGNAL', (d) => voice.handleSignal(d));
gw.on('SERVER_REFRESH', ({ id }) => refreshServer(id));
gw.on('BLOCKS_UPDATE', ({ userId, blocked }) => {
  if (blocked) S.blocked.add(userId); else S.blocked.delete(userId);
  if (S.channelId) renderMessages({ keepScroll: true });
});
gw.on('REPORTS_CHANGED', ({ serverId }) => {
  if (S.serverId === serverId && can(P.MODERATE_MEMBERS)) toast('The report queue changed (Server settings \u2192 Reports).');
});
gw.on('ADMIN_REPORT', ({ category }) => {
  toast(category === 'child_safety' ? 'URGENT: new child-safety report in the Hearth admin panel.' : 'New report in the Hearth admin panel.');
});
gw.on('VOICE_FORCE_LEAVE', (d) => { voice.forceLeave(); toast(d.reason || 'Disconnected from voice.'); });
gw.on('ERROR', (d) => toast(d.message));

voice.addEventListener('change', () => renderVoiceUI());
voice.addEventListener('speaking', (e) => {
  const speaking = e.detail;
  document.querySelectorAll('[data-voice-user]').forEach((node) => {
    const uid = node.dataset.voiceUser;
    node.classList.toggle('speaking', speaking.has(uid) || (uid === S.me.id && speaking.has('me')));
  });
});

// ---------------------------------------------------------------- notifications
// DMs and @mentions notify when you're not looking at that conversation.
function notifyMessage(m) {
  const c = findChannel(m.channelId);
  if (!c) return;
  const mentioned = new RegExp(`(^|\\W)@${S.me.username.replace(/\./g, '\\.')}(\\W|$)`, 'i').test(m.content);
  if (c.type !== 'dm' && !mentioned) return;
  if (!document.hidden && m.channelId === S.channelId) return;
  if (window.hearthDesktop) window.hearthDesktop.flash();
  sfx.play('ping');
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const where = c.type === 'dm' ? '' : ` in #${c.name}`;
  const text = m.content || (m.attachments.length ? 'Sent a file' : '');
  const n = new Notification(`${displayName(m.author, S.servers.get(c.serverId))}${where}`, {
    body: text.length > 140 ? text.slice(0, 140) + '\u2026' : text, tag: m.channelId, silent: false,
  });
  n.onclick = () => { window.focus(); selectServer(c.serverId || null); selectChannel(c.id); n.close(); };
}
document.addEventListener('click', () => {
  if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission().catch(() => {});
}, { once: true });

function updateBadge() {
  if (window.hearthDesktop) window.hearthDesktop.setBadge(S.unread.size);
}

// Desktop app: global hotkeys that work even inside games.
if (window.hearthDesktop) {
  window.hearthDesktop.onToggleMute(() => { if (voice.active) { voice.setMuted(!voice.muted); sfx.play(voice.muted ? 'mute' : 'unmute'); toast(voice.muted ? 'Muted' : 'Unmuted'); } });
  window.hearthDesktop.onToggleDeafen(() => { if (voice.active) { voice.setDeafened(!voice.deafened); toast(voice.deafened ? 'Deafened' : 'Undeafened'); } });
}

// ---------------------------------------------------------------- navigation
function selectServer(serverId) {
  S.serverId = serverId;
  S.lastChannel._server = serverId;
  saveLast();
  const key = serverId || '@me';
  let channelId = S.lastChannel[key];
  if (serverId) {
    const s = S.servers.get(serverId);
    const text = s.channels.filter((c) => c.type === 'text');
    if (!text.some((c) => c.id === channelId)) channelId = text[0] ? text[0].id : null;
  } else if (!S.dms.has(channelId)) {
    channelId = null;
  }
  renderRail();
  selectChannel(channelId);
}

function selectChannel(channelId) {
  S.channelId = channelId;
  S.lastChannel[S.serverId || '@me'] = channelId;
  saveLast();
  S.unread.delete(channelId);
  updateBadge();
  S.viewingVoice = null;
  S.stageWasFull = false;
  S.replyTo = null;
  S.pending = [];
  $('app').classList.remove('nav-open');
  renderSidebar();
  renderHeader();
  renderMembers();
  renderComposerExtras();
  renderVoiceUI();
  if (channelId) loadMessages(channelId);
  else renderMessages();
}

async function loadMessages(channelId, older = false) {
  let bucket = S.messages.get(channelId);
  if (bucket && !older) return renderMessages();
  if (!bucket) { bucket = { list: [], hasMore: true, loading: false }; S.messages.set(channelId, bucket); }
  if (bucket.loading || !bucket.hasMore) return;
  bucket.loading = true;
  try {
    const before = older && bucket.list.length ? `&before=${bucket.list[0].id}` : '';
    const batch = await api('GET', `/channels/${channelId}/messages?limit=50${before}`);
    bucket.hasMore = batch.length === 50;
    const known = new Set(bucket.list.map((m) => m.id));
    bucket.list = [...batch.filter((m) => !known.has(m.id)), ...bucket.list];
  } catch (err) {
    toast(err.message);
  } finally {
    bucket.loading = false;
  }
  if (channelId === S.channelId) renderMessages({ keepScroll: older });
}

// ---------------------------------------------------------------- rendering
function renderMe() {
  $('me-name').textContent = S.me.displayName;
  $('me-username').textContent = '@' + S.me.username;
  $('me-avatar').replaceWith(Object.assign(avatar(S.me), { id: 'me-avatar' }));
}

function renderRail() {
  const list = $('server-list');
  list.replaceChildren(...[...S.servers.values()].map((s) => {
    const btn = el('button', {
      class: 'rail-btn' + (S.serverId === s.id ? ' active' : ''), title: s.name,
      onclick: () => selectServer(s.id),
    });
    if (s.icon) btn.append(el('img', { src: s.icon, alt: s.name }));
    else btn.textContent = initials(s.name);
    if (s.channels.some((c) => S.unread.has(c.id))) btn.append(el('span', { class: 'badge' }));
    return btn;
  }));
  $('home-btn').classList.toggle('active', !S.serverId);
  updateBadge();
}

function renderSidebar() {
  const list = $('channel-list');
  const s = server();
  $('sidebar-title').textContent = s ? s.name : 'Direct messages';
  $('server-settings-btn').classList.toggle('hidden', !s);

  if (!s) {
    const items = [...S.dms.values()].map((dm) => {
      const other = dmOther(dm);
      const inCall = voiceIn(dm.id).length > 0;
      return el('div', { class: 'chan' + (S.channelId === dm.id ? ' active' : ''), onclick: () => selectChannel(dm.id) },
        avatar(other, { status: true, size: 28 }),
        el('span', { class: 'name' }, other.displayName),
        inCall ? el('span', { title: 'Call in progress' }, '📞') : null,
        S.unread.has(dm.id) ? el('span', { class: 'unread' }) : null);
    });
    list.replaceChildren(
      el('div', { class: 'cat' }, el('span', {}, 'Direct messages'),
        el('button', { class: 'icon-btn', title: 'New message', onclick: newDmModal }, '+')),
      ...(items.length ? items : [el('p', { class: 'muted small', style: { padding: '0 8px' } }, 'No conversations yet. Press + to message someone by username.')]));
    return;
  }

  const manage = can(P.MANAGE_CHANNELS, s);
  const byPos = (a, b) => a.position - b.position || (a.id < b.id ? -1 : 1);
  const row = (c) => {
    const isText = c.type === 'text';
    const out = [];
    const tools = manage ? el('span', { class: 'tools' },
      el('button', { class: 'icon-btn', title: 'Edit channel', onclick: (e) => { e.stopPropagation(); channelModal(s, c.type, c); } }, '⚙')) : null;
    out.push(el('div', {
      class: 'chan' + ((isText ? S.channelId === c.id && !S.viewingVoice : S.viewingVoice === c.id) ? ' active' : ''),
      onclick: () => openChannel(c),
      title: isText ? c.topic || c.name : 'Join voice',
    },
    el('span', { class: 'channel-icon' }, c.locked ? '\u{1F512}' : isText ? '#' : '🔊'),
    el('span', { class: 'name' }, c.name),
    c.ageRating ? el('span', { class: 'age-badge', title: `${c.ageRating}+ only` }, `${c.ageRating}+`) : null,
    c.pendingReview ? el('span', { class: 'age-badge', title: 'Hidden from members until you review its permissions' }, 'HIDDEN') : null,
    S.unread.has(c.id) ? el('span', { class: 'unread' }) : null,
    tools));
    if (!isText) {
      const people = voiceIn(c.id);
      if (people.length) {
        out.push(el('div', { class: 'voice-users' }, people.map((v) => {
          const u = userById(v.userId);
          return el('div', { class: 'voice-user', 'data-voice-user': v.userId },
            avatar(u), el('span', {}, displayName(u, s)),
            el('span', { class: 'flags' },
              v.screen ? '🖥' : '', v.video ? '📷' : '', v.deaf ? '🔇' : v.mute ? '🎙̸' : ''));
        })));
      }
    }
    return out;
  };
  // Channels inside a category show text first, then voice (like Discord).
  const kids = (parentId) => s.channels.filter((c) => (c.parentId || null) === parentId && c.type !== 'category')
    .sort((a, b) => (a.type === b.type ? byPos(a, b) : a.type === 'text' ? -1 : 1));
  const out = [];
  const pending = s.channels.filter((c) => c.pendingReview && c.type !== 'category');
  if (pending.length) {
    out.push(el('div', { class: 'review-banner' },
      el('strong', {}, `${pending.length} imported channel${pending.length === 1 ? ' is' : 's are'} hidden`),
      el('div', { class: 'muted' }, 'Only you and Administrators can see them until you set who has access.'),
      el('button', { class: 'btn primary small', onclick: () => reviewModal(s) }, 'Review channels')));
  }
  const loose = kids(null);
  const looseText = loose.filter((c) => c.type === 'text');
  const looseVoice = loose.filter((c) => c.type === 'voice');
  const cats = s.channels.filter((c) => c.type === 'category').sort(byPos);
  if (looseText.length || !cats.length) {
    out.push(el('div', { class: 'cat' }, el('span', {}, 'Text channels'),
      manage ? el('button', { class: 'icon-btn', title: 'Create text channel', onclick: () => channelModal(s, 'text') }, '+') : null));
    for (const c of looseText) out.push(...row(c));
  }
  if (looseVoice.length || !cats.length) {
    out.push(el('div', { class: 'cat' }, el('span', {}, 'Voice channels'),
      manage ? el('button', { class: 'icon-btn', title: 'Create voice channel', onclick: () => channelModal(s, 'voice') }, '+') : null));
    for (const c of looseVoice) out.push(...row(c));
  }
  for (const cat of cats) {
    const collapsed = S.collapsed.has(cat.id);
    const children = kids(cat.id);
    out.push(el('div', { class: 'cat category' + (collapsed ? ' collapsed' : '') },
      el('span', { class: 'cat-name', onclick: () => { if (collapsed) S.collapsed.delete(cat.id); else S.collapsed.add(cat.id); saveCollapsed(); renderSidebar(); } },
        el('span', { class: 'chev' }, collapsed ? '▸' : '▾'), cat.name),
      manage ? el('span', {},
        el('button', { class: 'icon-btn', title: 'Create channel here', onclick: () => channelModal(s, 'text', null, cat.id) }, '+'),
        el('button', { class: 'icon-btn', title: 'Edit category', onclick: () => categoryModal(s, cat) }, '⚙')) : null));
    for (const c of children) {
      if (collapsed && !(S.channelId === c.id || S.unread.has(c.id) || voiceIn(c.id).length)) continue;
      out.push(...row(c));
    }
  }
  if (manage) out.push(el('button', { class: 'new-cat', onclick: () => categoryModal(s) }, '+ New category'));
  list.replaceChildren(...out);
}

function renderHeader() {
  const c = S.channelId ? findChannel(S.channelId) : null;
  const isDm = c && c.type === 'dm';
  $('channel-icon').textContent = c ? (isDm ? '@' : '#') : '';
  $('channel-name').textContent = c ? (isDm ? dmOther(c).displayName : c.name) : '';
  $('channel-topic').textContent = c && !isDm ? c.topic || '' : '';
  $('channel-topic').classList.toggle('hidden', !(c && c.topic && !isDm));
  $('call-btn').classList.toggle('hidden', !isDm);
  $('members-btn').classList.toggle('hidden', !S.serverId);
  $('composer').classList.toggle('hidden', !c);
  $('typing').classList.toggle('hidden', !c);
  $('composer-input').placeholder = c ? `Message ${isDm ? '@' + dmOther(c).displayName : '#' + c.name}` : '';
  const empty = $('empty');
  if (!c) {
    empty.classList.remove('hidden');
    $('messages').classList.add('hidden');
    empty.replaceChildren(S.serverId
      ? el('div', {}, el('h2', {}, 'No text channels'), el('p', {}, 'Create one with the + next to “Text channels”.'))
      : el('div', {}, el('h2', {}, `Welcome, ${S.me.displayName}`),
        el('p', {}, 'Pick a conversation, start one with +, or create your own server.'),
        el('button', { class: 'press-start', onclick: addServerModal }, 'PRESS START')));
  } else {
    empty.classList.add('hidden');
    $('messages').classList.remove('hidden');
  }
  if (c && !isDm && !can(P.SEND_MESSAGES)) {
    $('composer-input').disabled = true;
    $('composer-input').placeholder = 'You do not have permission to send messages here.';
  } else {
    $('composer-input').disabled = false;
  }
}

function renderMembers() {
  const s = server();
  const box = $('members');
  $('app').classList.toggle('no-members', !s || localStorage.getItem('hearth_members') === 'hidden');
  if (!s) { box.replaceChildren(); return; }
  const online = s.members.filter((m) => m.online);
  const offline = s.members.filter((m) => !m.online);
  const row = (m) => el('div', { class: 'member' + (m.online ? '' : ' offline'), onclick: () => memberModal(s, m) },
    avatar(m.user, { status: true }),
    el('span', { style: { color: roleColor(m.user.id, s) || '' } }, m.nickname || m.user.displayName),
    s.ownerId === m.user.id ? el('span', { title: 'Owner' }, '👑') : null);
  const byName = (a, b) => (a.nickname || a.user.displayName).localeCompare(b.nickname || b.user.displayName);
  box.replaceChildren(
    el('div', { class: 'cat' }, `Online — ${online.length}`), ...online.sort(byName).map(row),
    el('div', { class: 'cat' }, `Offline — ${offline.length}`), ...offline.sort(byName).map(row));
}

function renderTyping() {
  const map = S.typing.get(S.channelId);
  const names = map ? [...map.keys()].map((id) => displayName(userById(id))) : [];
  $('typing').textContent = !names.length ? ''
    : names.length === 1 ? `${names[0]} is typing…`
      : names.length <= 3 ? `${names.join(', ')} are typing…` : 'Several people are typing…';
}

// ----- messages
const messagesBox = $('messages');
messagesBox.addEventListener('scroll', () => {
  if (messagesBox.scrollTop < 80 && S.channelId) {
    const b = S.messages.get(S.channelId);
    if (b && b.hasMore && !b.loading) loadMessages(S.channelId, true);
  }
});

function renderMessages({ keepScroll = false } = {}) {
  const bucket = S.channelId && S.messages.get(S.channelId);
  if (!bucket) { messagesBox.replaceChildren(); return; }
  const fromBottom = messagesBox.scrollHeight - messagesBox.scrollTop;
  const nodes = [];
  if (!bucket.hasMore) {
    const c = findChannel(S.channelId);
    nodes.push(el('div', { class: 'empty', style: { padding: '24px 16px', textAlign: 'left', placeItems: 'start' } },
      el('div', {}, el('h2', {}, c.type === 'dm' ? dmOther(c).displayName : `Welcome to #${c.name}`),
        el('p', {}, c.type === 'dm' ? 'This is the start of your conversation.' : 'This is the start of the channel.'))));
  } else {
    nodes.push(el('div', { class: 'load-more' }, bucket.loading ? 'Loading…' : 'Scroll up for older messages'));
  }
  let prev = null;
  for (const m of bucket.list) {
    nodes.push(...messageNodes(m, prev, bucket));
    prev = m;
  }
  messagesBox.replaceChildren(...nodes);
  if (keepScroll) messagesBox.scrollTop = messagesBox.scrollHeight - fromBottom;
  else messagesBox.scrollTop = messagesBox.scrollHeight;
  renderTyping();
}

// Imported history shows under the original sender's name. They're a
// stand-in "author" that isn't any Hearth account.
function asShown(m) {
  if (!m || !m.imported || m.kind) return m;
  const i = m.imported;
  return { ...m, author: { id: `imported:${i.id || i.name}`, displayName: i.name || 'unknown', username: i.username || '', avatar: i.avatar || null } };
}

function messageNodes(m, prev, bucket) {
  m = asShown(m); prev = asShown(prev);
  const out = [];
  if (!prev || new Date(prev.createdAt).toDateString() !== new Date(m.createdAt).toDateString()) {
    out.push(el('div', { class: 'day-sep' }, fmtDay(m.createdAt)));
    prev = null;
  }
  // Messages from people you've blocked are collapsed until you choose to look.
  if (S.blocked.has(m.author.id) && !S.revealed.has(m.id)) {
    out.push(el('div', { class: 'msg blocked-msg' }, el('div', { class: 'gutter' }),
      el('div', { class: 'muted small' }, 'Message from someone you blocked. ',
        el('a', { href: '#', onclick: (e) => { e.preventDefault(); S.revealed.add(m.id); renderMessages({ keepScroll: true }); } }, 'Show'))));
    return out;
  }
  // Where imported history ends and this server's own messages begin.
  if (m.kind === 'import_marker') {
    out.push(el('div', { class: 'import-marker', 'data-id': m.id }, el('span', {}, '▲ Archived from Discord · new Hearth messages below ▼')));
    return out;
  }
  // Slash-command results (/me, dice, coin) are shown as one action line.
  if (m.kind && m.kind !== 'gif') {
    const icon = { me: '*', roll: '\u{1F3B2}', flip: '\u{1FA99}' }[m.kind] || '*';
    out.push(el('div', { class: 'msg action-msg', 'data-id': m.id }, el('div', { class: 'gutter' }, el('span', { class: 'action-icon' }, icon)),
      el('div', { class: 'body' }, el('strong', { style: { color: roleColor(m.author.id) || '' } }, displayName(m.author)), ' ',
        el('span', { html: renderMarkdown(m.content) }), ' ', el('span', { class: 'time' }, fmtTime(m.createdAt))),
      m.author.id === S.me.id || (S.serverId && can(P.MANAGE_MESSAGES))
        ? el('div', { class: 'actions' }, el('button', { title: 'Delete', onclick: () => deleteMessage(m) }, '\u{1F5D1}')) : null));
    return out;
  }
  const cont = prev && prev.author.id === m.author.id && !m.replyTo && (!prev.kind || prev.kind === 'gif') && m.createdAt - prev.createdAt < 5 * 60000;
  const mine = m.author.id === S.me.id;
  const canManage = S.serverId ? can(P.MANAGE_MESSAGES) : false;

  const actions = el('div', { class: 'actions' },
    el('button', { title: 'React', onclick: (e) => openPicker(e, m) }, '🙂'),
    el('button', { title: 'Reply', onclick: () => setReply(m) }, '↩'),
    mine && !m.imported && !m.kind ? el('button', { title: 'Edit', onclick: () => editMessage(m) }, '✎') : null,
    mine || canManage ? el('button', { title: 'Delete', onclick: () => deleteMessage(m) }, '🗑') : null,
    mine && !m.imported ? null : el('button', { title: 'Report', onclick: () => reportModal({ targetType: 'message', targetId: m.id, serverId: S.serverId, label: 'message' }) }, '\u2691'));

  let replyRef = null;
  if (m.replyTo) {
    const target = asShown(bucket.list.find((x) => x.id === m.replyTo));
    replyRef = el('div', { class: 'reply-ref', onclick: () => jumpTo(m.replyTo) },
      target ? el('span', {}, el('strong', {}, displayName(target.author)), ' ', target.kind === 'gif' ? 'GIF' : target.content.slice(0, 80) || '(attachment)')
        : el('span', {}, 'Original message was deleted or is older'));
  }

  const body = m.kind === 'gif' ? gifBody(m) : el('div', { class: 'body', html: renderMarkdown(m.content) });
  if (m.editedAt) body.append(' ', el('span', { class: 'edited', title: fmtTime(m.editedAt) }, '(edited)'));

  const attachments = m.attachments.length ? el('div', { class: 'attachments' }, m.attachments.map((a) => {
    if (a.type.startsWith('image/')) return el('img', { src: a.url, alt: a.name, loading: 'lazy', onclick: () => window.open(a.url, '_blank') });
    if (a.type.startsWith('video/')) return el('video', { src: a.url, controls: true, preload: 'metadata' });
    if (a.type.startsWith('audio/')) return el('audio', { src: a.url, controls: true });
    return el('a', { class: 'file-card', href: a.url, download: a.name }, '📄', el('span', {}, a.name, el('div', { class: 'muted small' }, fmtSize(a.size))));
  })) : null;

  const oldReactions = (m.importedReactions || []).map((r) =>
    el('span', { class: 'reaction archived', title: 'Reaction from the Discord archive' }, `${r.emoji} ${r.count}`));
  const reactions = m.reactions.length || oldReactions.length ? el('div', { class: 'reactions' }, oldReactions, m.reactions.map((r) =>
    el('button', { class: 'reaction' + (r.me ? ' me' : ''), onclick: () => toggleReaction(m, r.emoji, !r.me) }, `${r.emoji} ${r.count}`))) : null;

  out.push(el('div', { class: 'msg' + (cont ? ' cont' : ''), 'data-id': m.id },
    el('div', { class: 'gutter' }, avatar(m.author)),
    el('div', {},
      replyRef,
      cont ? null : el('div', { class: 'head' },
        el('span', { class: 'author', style: { color: roleColor(m.author.id) || '' } }, displayName(m.author)),
        m.imported && m.imported.bot ? el('span', { class: 'tag bot-tag' }, 'BOT') : null,
        m.imported ? el('span', { class: 'tag archived-tag', title: `Archived from Discord${m.author.username ? ` \u00B7 @${m.author.username}` : ''}. Not linked to any Hearth account.` }, 'ARCHIVED') : null,
        el('span', { class: 'time', title: new Date(m.createdAt).toLocaleString() }, fmtTime(m.createdAt))),
      body, attachments, reactions),
    actions));
  return out;
}

function appendMessage(m) {
  const nearBottom = messagesBox.scrollHeight - messagesBox.scrollTop - messagesBox.clientHeight < 150;
  renderMessages({ keepScroll: !nearBottom && m.author.id !== S.me.id });
}

function jumpTo(id) {
  const node = messagesBox.querySelector(`[data-id="${id}"]`);
  if (!node) return toast('That message is not loaded.');
  node.scrollIntoView({ block: 'center', behavior: 'smooth' });
  node.classList.add('highlight');
  setTimeout(() => node.classList.remove('highlight'), 1600);
}

function openPicker(e, m) {
  e.stopPropagation();
  document.querySelectorAll('.picker').forEach((p) => p.remove());
  const rect = e.currentTarget.getBoundingClientRect();
  const picker = el('div', { class: 'picker', style: { top: rect.bottom + 4 + 'px', left: Math.max(8, rect.right - 210) + 'px', position: 'fixed' } },
    QUICK_EMOJI.map((em) => el('button', { onclick: () => { picker.remove(); toggleReaction(m, em, true); } }, em)));
  document.body.append(picker);
  setTimeout(() => document.addEventListener('click', () => picker.remove(), { once: true }), 0);
}

async function toggleReaction(m, emoji, add) {
  try { await api(add ? 'PUT' : 'DELETE', `/messages/${m.id}/reactions/${encodeURIComponent(emoji)}`); }
  catch (err) { toast(err.message); }
}

function setReply(m) {
  S.replyTo = m;
  renderComposerExtras();
  $('composer-input').focus();
}

function editMessage(m) {
  const input = el('textarea', { rows: 4 }, m.content);
  const save = async () => {
    try { await api('PATCH', `/messages/${m.id}`, { content: input.value }); dlg.close(); }
    catch (err) { toast(err.message); }
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); save(); } });
  const dlg = modal([el('h2', {}, 'Edit message'), input,
    el('div', { class: 'row' }, el('button', { class: 'btn', onclick: () => dlg.close() }, 'Cancel'),
      el('button', { class: 'btn primary', onclick: save }, 'Save'))]);
}

async function deleteMessage(m) {
  if (!(await confirmDialog('Delete message', 'This message and its files will be removed for everyone and can\u2019t be restored. (An encrypted copy is kept for 30 days for safety and legal reasons, then erased.)', 'Delete'))) return;
  try { await api('DELETE', `/messages/${m.id}`); } catch (err) { toast(err.message); }
}

// ----- composer
const input = $('composer-input');
input.addEventListener('input', () => {
  input.style.height = 'auto';
  input.style.height = Math.min(200, input.scrollHeight) + 'px';
  updateCommandMenu();
  if (input.value && !input.value.startsWith('/') && S.channelId) gw.send({ op: 'TYPING', channelId: S.channelId });
});
input.addEventListener('keydown', (e) => {
  if (commandMenuKey(e)) return;
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('composer').requestSubmit(); }
  if (e.key === 'Escape' && S.replyTo) { S.replyTo = null; renderComposerExtras(); }
  if (e.key === 'ArrowUp' && !input.value) {
    const b = S.messages.get(S.channelId);
    const last = b && [...b.list].reverse().find((m) => m.author.id === S.me.id);
    if (last) { e.preventDefault(); editMessage(last); }
  }
});
input.addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.files || [])];
  if (files.length) { e.preventDefault(); addFiles(files); }
});
$('main').addEventListener('dragover', (e) => e.preventDefault());
$('main').addEventListener('drop', (e) => { e.preventDefault(); if (S.channelId) addFiles([...e.dataTransfer.files]); });
$('file-input').addEventListener('change', (e) => { addFiles([...e.target.files]); e.target.value = ''; });

function addFiles(files) {
  S.pending.push(...files.slice(0, 10 - S.pending.length));
  renderComposerExtras();
}

function renderComposerExtras() {
  const bar = $('reply-bar');
  if (S.replyTo) {
    bar.replaceChildren(el('span', {}, 'Replying to ', el('strong', {}, displayName(S.replyTo.author))),
      el('button', { class: 'icon-btn', onclick: () => { S.replyTo = null; renderComposerExtras(); } }, '✕'));
    bar.classList.remove('hidden');
  } else bar.classList.add('hidden');
  $('pending-files').replaceChildren(...S.pending.map((f, i) => el('span', { class: 'file-card' },
    `📎 ${f.name} (${fmtSize(f.size)})`,
    el('button', { class: 'icon-btn', onclick: () => { S.pending.splice(i, 1); renderComposerExtras(); } }, '✕'))));
}

$('composer').addEventListener('submit', async (e) => {
  e.preventDefault();
  const channelId = S.channelId;
  const content = input.value.trim();
  if (!channelId || (!content && !S.pending.length)) return;
  if (content.startsWith('/') && !S.pending.length) {
    const handled = await runCommand(content);
    if (handled) { input.value = ''; input.style.height = 'auto'; hideCommandMenu(); return; }
  }
  const files = S.pending.splice(0);
  const replyTo = S.replyTo ? S.replyTo.id : undefined;
  S.replyTo = null;
  input.value = '';
  input.style.height = 'auto';
  renderComposerExtras();
  try {
    const attachments = [];
    for (const f of files) {
      attachments.push(await upload(`/channels/${channelId}/attachments`, f, (p) => {
        $('typing').textContent = `Uploading ${f.name}… ${Math.round(p * 100)}%`;
      }));
    }
    const msg = await api('POST', `/channels/${channelId}/messages`, { content, attachments, replyTo });
    const bucket = S.messages.get(channelId);
    if (bucket && !bucket.list.some((x) => x.id === msg.id)) {
      bucket.list.push(msg);
      if (S.channelId === channelId) renderMessages();
    }
  } catch (err) {
    toast(err.message);
    input.value = content;
  }
  renderTyping();
});

// ---------------------------------------------------------------- voice UI
async function joinVoice(channelId) {
  const isVoiceChannel = findChannel(channelId)?.type === 'voice';
  if (isVoiceChannel) {
    S.viewingVoice = channelId;
    $('app').classList.remove('nav-open');
    renderSidebar();
  }
  if (voice.channelId === channelId) { renderVoiceUI(); return; }
  try {
    await voice.join(channelId);
    sfx.play('join');
  } catch (err) {
    if (isVoiceChannel) S.viewingVoice = null;
    toast(err.message);
    renderVoiceUI();
  }
}

function renderVoiceUI() {
  const panel = $('voice-panel');
  const vc = voice.channelId && findChannel(voice.channelId);
  panel.classList.toggle('hidden', !voice.active);
  if (vc) {
    const where = vc.type === 'dm' ? `Call with ${dmOther(vc).displayName}`
      : `${vc.name} / ${S.servers.get(vc.serverId)?.name || ''}`;
    $('voice-where').textContent = where;
  }
  $('vc-mute').classList.toggle('off', voice.muted);
  $('vc-deaf').classList.toggle('off', voice.deafened);
  $('vc-cam').classList.toggle('on', !!voice.cam);
  $('vc-screen').classList.toggle('on', !!voice.screen);

  // Incoming DM call banner
  const banner = $('call-banner');
  const cur = S.channelId && findChannel(S.channelId);
  const dmCall = cur && cur.type === 'dm' ? voiceIn(cur.id) : [];
  if (cur && cur.type === 'dm' && dmCall.length && voice.channelId !== cur.id) {
    banner.replaceChildren(el('span', {}, '📞 ', el('strong', {}, dmOther(cur).displayName), ' is in a call.'),
      el('button', { class: 'btn primary', onclick: () => joinVoice(cur.id) }, 'Join call'));
    banner.classList.remove('hidden');
  } else banner.classList.add('hidden');

  renderStage();
}

function renderStage() {
  const stage = $('stage');
  if (S.viewingVoice && S.viewingVoice !== voice.channelId) S.viewingVoice = null;
  // Full view: a server voice channel you clicked. Strip view: a DM call above the chat.
  const full = voice.active && S.viewingVoice === voice.channelId;
  const strip = voice.active && !full && voice.channelId === S.channelId;
  if (!full && !strip) {
    stage.classList.add('hidden');
    stage.replaceChildren();
    if (S.stageWasFull) { S.stageWasFull = false; renderHeader(); renderSidebar(); }
    return;
  }
  stage.classList.remove('hidden');
  stage.classList.toggle('full', full);
  if (full) {
    S.stageWasFull = true;
    for (const id of ['messages', 'composer', 'typing', 'empty']) $(id).classList.add('hidden');
    $('channel-icon').textContent = '🔊';
    $('channel-name').textContent = findChannel(voice.channelId).name;
    $('channel-topic').classList.add('hidden');
    $('call-btn').classList.add('hidden');
  }

  const tiles = [];
  for (const v of voiceIn(voice.channelId)) {
    const isMe = v.sessionId === S.sessionId;
    const u = userById(v.userId);
    const name = displayName(u, S.servers.get(v.serverId));
    const makeVideo = (stream, mirrored) => {
      const video = el('video', { autoplay: true, playsinline: true, muted: true });
      video.muted = true;
      video.srcObject = stream;
      if (mirrored) video.style.transform = 'scaleX(-1)';
      return video;
    };
    const camStream = isMe ? voice.cam : v.video ? voice.remoteStream(v.sessionId, 'cam') : null;
    tiles.push(el('div', { class: 'tile', 'data-voice-user': v.userId },
      camStream ? makeVideo(camStream, isMe) : avatar(u),
      el('span', { class: 'label' }, name, v.mute || v.deaf ? ' 🔇' : '')));
    const screenStream = isMe ? voice.screen : v.screen ? voice.remoteStream(v.sessionId, 'screen') : null;
    if (screenStream) {
      const tile = el('div', { class: 'tile screen' }, makeVideo(screenStream, false),
        el('span', { class: 'label' }, `🖥 ${name}'s screen`),
        el('button', { class: 'expand', title: 'Full screen', onclick: () => tile.querySelector('video').requestFullscreen?.() }, '⤢'));
      tiles.unshift(tile);
    }
  }
  stage.replaceChildren(...tiles);
}

$('vc-mute').onclick = () => { voice.setMuted(!voice.muted); sfx.play(voice.muted ? 'mute' : 'unmute'); };
$('vc-deaf').onclick = () => voice.setDeafened(!voice.deafened);
$('vc-cam').onclick = () => voice.toggleCamera().catch((e) => toast(e.message || 'Camera unavailable.'));
$('vc-screen').onclick = () => voice.toggleScreen().catch((e) => { if (e.name !== 'NotAllowedError') toast(e.message || 'Screen share failed.'); });
$('vc-leave').onclick = () => { voice.leave(); sfx.play('leave'); S.viewingVoice = null; renderVoiceUI(); };
$('call-btn').onclick = () => S.channelId && joinVoice(S.channelId);
window.addEventListener('beforeunload', () => voice.active && voice.leave());

// ---------------------------------------------------------------- modals & actions
$('home-btn').onclick = () => selectServer(null);
$('add-server-btn').onclick = addServerModal;
$('server-settings-btn').onclick = () => server() && serverSettingsModal(server());
$('me-btn').onclick = profileModal;
$('menu-btn').onclick = (e) => { e.stopPropagation(); $('app').classList.toggle('nav-open'); };
$('members-btn').onclick = (e) => {
  e.stopPropagation();
  if (window.matchMedia('(max-width: 860px)').matches) { $('app').classList.toggle('members-open'); return; }
  const hidden = localStorage.getItem('hearth_members') === 'hidden';
  localStorage.setItem('hearth_members', hidden ? 'shown' : 'hidden');
  renderMembers();
};
$('main').addEventListener('click', () => $('app').classList.remove('nav-open', 'members-open'));
$('logout-btn').onclick = async () => {
  if (!(await confirmDialog('Log out', 'You will need your password to log back in.', 'Log out'))) return;
  voice.leave();
  await api('POST', '/auth/logout').catch(() => {});
  gw.close();
  location.href = '/';
};

function field(label, attrs = {}) {
  const input = el('input', attrs);
  return [el('label', {}, label, input), input];
}

function addServerModal() {
  const dlg = modal([
    el('h2', {}, 'Add a server'),
    el('div', { class: 'choice' },
      el('button', { onclick: () => { dlg.close(); createServerModal(); } }, el('strong', {}, 'Create my own'), el('div', { class: 'muted small' }, 'Start a new server for your friends or community.')),
      el('button', { onclick: () => { dlg.close(); joinServerModal(); } }, el('strong', {}, 'Join with an invite'), el('div', { class: 'muted small' }, 'Paste an invite link or code.')),
      el('button', { onclick: () => { dlg.close(); importWizard(); } }, el('strong', {}, 'Move a server from Discord'), el('div', { class: 'muted small' }, 'Bring over channels, roles and chat history with a step-by-step guide.'))),
  ]);
}

function createServerModal() {
  const [lbl, name] = field('Server name', { maxlength: 64, value: `${S.me.displayName}'s server` });
  const err = el('p', { class: 'error' });
  const go = async () => {
    try { const s = await api('POST', '/servers', { name: name.value }); S.servers.set(s.id, s); dlg.close(); selectServer(s.id); }
    catch (e) { err.textContent = e.message; }
  };
  name.addEventListener('keydown', (e) => e.key === 'Enter' && go());
  const dlg = modal([el('h2', {}, 'Create a server'), lbl, err,
    el('div', { class: 'row' }, el('button', { class: 'btn', onclick: () => dlg.close() }, 'Cancel'), el('button', { class: 'btn primary', onclick: go }, 'Create'))]);
}

function joinServerModal() {
  const [lbl, code] = field('Invite link or code', { placeholder: `${location.origin}/invite/abc123` });
  const err = el('p', { class: 'error' });
  const go = async () => {
    const c = code.value.trim().split('/').pop();
    if (!c) return;
    dlg.close();
    await acceptInvite(c, err);
  };
  code.addEventListener('keydown', (e) => e.key === 'Enter' && go());
  const dlg = modal([el('h2', {}, 'Join a server'), lbl, err,
    el('div', { class: 'row' }, el('button', { class: 'btn', onclick: () => dlg.close() }, 'Cancel'), el('button', { class: 'btn primary', onclick: go }, 'Join'))]);
}

async function acceptInvite(code) {
  try {
    const s = await api('POST', `/invites/${code}`);
    S.servers.set(s.id, s);
    renderRail();
    selectServer(s.id);
    toast(`Joined ${s.name}`);
  } catch (e) {
    toast(e.message);
    if (!S.channelId) selectServer(S.serverId);
  }
}

function newDmModal() {
  const [lbl, name] = field('Their username');
  const err = el('p', { class: 'error' });
  const go = async () => {
    try { const dm = await api('POST', '/dms', { username: name.value.trim() }); S.dms.set(dm.id, dm); dlg.close(); selectServer(null); selectChannel(dm.id); }
    catch (e) { err.textContent = e.message; }
  };
  name.addEventListener('keydown', (e) => e.key === 'Enter' && go());
  const dlg = modal([el('h2', {}, 'New message'), lbl, err,
    el('div', { class: 'row' }, el('button', { class: 'btn', onclick: () => dlg.close() }, 'Cancel'), el('button', { class: 'btn primary', onclick: go }, 'Open'))]);
}

async function inviteBlock(s) {
  const box = el('div', {}, el('p', { class: 'muted' }, 'Creating invite…'));
  try {
    const inv = await api('POST', `/servers/${s.id}/invites`, { expiresInHours: 168 });
    const link = `${location.origin}/invite/${inv.code}`;
    const inputEl = el('input', { value: link, readonly: true });
    box.replaceChildren(el('label', {}, 'Invite link (expires in 7 days)'),
      el('div', { class: 'invite-box' }, inputEl,
        el('button', { class: 'btn primary', onclick: async () => {
          try { await navigator.clipboard.writeText(link); toast('Invite link copied'); }
          catch { inputEl.select(); toast('Press Ctrl+C to copy'); }
        } }, 'Copy')));
  } catch (e) { box.replaceChildren(el('p', { class: 'error' }, e.message)); }
  return box;
}

function overviewTab(s, dlg) {
  const wrap = el('div', { style: { display: 'grid', gap: '14px' } });
  const err = el('p', { class: 'error' });
  if (can(P.MANAGE_SERVER, s)) {
    const [lbl, name] = field('Server name', { value: s.name, maxlength: 64 });
    const icon = el('input', { type: 'file', accept: 'image/*' });
    const age = el('select', {}, [[0, 'Everyone (13+)'], [18, '18+ only'], [21, '21+ only']]
      .map(([v, l]) => el('option', { value: v, selected: (s.ageRating || 0) === v }, l)));
    wrap.append(lbl, el('label', {}, 'Server icon', icon), el('label', {}, 'Age requirement for the whole server', age),
      el('div', { class: 'row' }, el('button', { class: 'btn primary', onclick: async () => {
        try {
          const patch = { name: name.value, ageRating: Number(age.value) };
          if (icon.files[0]) patch.icon = (await upload('/uploads/avatar', icon.files[0])).url;
          await api('PATCH', `/servers/${s.id}`, patch);
          toast('Saved');
        } catch (e) { err.textContent = e.message; }
      } }, 'Save')));
  }
  const [lblNick, nick] = field('Your nickname in this server', { value: memberOf(s, S.me.id)?.nickname || '', maxlength: 32 });
  wrap.append(lblNick, el('div', { class: 'row' }, el('button', { class: 'btn', onclick: async () => {
    try { await api('PATCH', `/servers/${s.id}/members/@me`, { nickname: nick.value }); toast('Nickname updated'); }
    catch (e) { err.textContent = e.message; }
  } }, 'Update nickname')), err);

  if (s.ownerId === S.me.id) {
    const others = s.members.filter((m) => m.user.id !== S.me.id);
    wrap.append(el('div', { class: 'row' },
      others.length ? el('button', { class: 'btn', style: { marginRight: 'auto' }, onclick: () => { dlg.close(); transferModal(s); } }, 'Transfer ownership') : null,
      el('button', { class: 'btn danger', onclick: () => {
        dlg.close();
        dangerDialog({
          title: `Delete ${s.name}?`,
          lines: [
            'Every channel, message, role, invite and uploaded file in this server will be deleted for everyone.',
            'Members will be removed immediately.',
          ],
          confirmText: s.name, confirmLabel: 'Delete server',
          run: () => api('DELETE', `/servers/${s.id}`, { confirmName: s.name }),
        });
      } }, 'Delete server')));
  } else {
    wrap.append(el('div', { class: 'row' }, el('button', { class: 'btn danger', onclick: async () => {
      if (!(await confirmDialog('Leave server', `Leave ${s.name}? You'll need a new invite to come back.`, 'Leave'))) return;
      try { await api('DELETE', `/servers/${s.id}/members/@me`); dlg.close(); } catch (e) { err.textContent = e.message; }
    } }, 'Leave server')));
  }
  return wrap;
}

function memberModal(s, m) {
  const self = m.user.id === S.me.id;
  const dlg = modal([
    el('div', { style: { display: 'flex', gap: '14px', alignItems: 'center' } }, avatar(m.user, { size: 64 }),
      el('div', {}, el('h2', {}, m.nickname || m.user.displayName), el('div', { class: 'muted' }, '@' + m.user.username))),
    memberRow(s, m, () => dlg.close()),
    el('div', { class: 'row' },
      self ? null : el('button', { class: 'btn primary', onclick: async () => {
        try { const dm = await api('POST', '/dms', { username: m.user.username }); S.dms.set(dm.id, dm); dlg.close(); selectServer(null); selectChannel(dm.id); }
        catch (e) { toast(e.message); }
      } }, 'Message'),
      self ? null : el('button', { class: 'btn', onclick: () => { dlg.close(); toggleBlock(m.user); } }, S.blocked.has(m.user.id) ? 'Unblock' : 'Block'),
      self ? null : el('button', { class: 'btn', onclick: () => { dlg.close(); reportModal({ targetType: 'user', targetId: m.user.id, serverId: s.id, label: m.user.displayName }); } }, 'Report'),
      el('button', { class: 'btn', onclick: () => dlg.close() }, 'Close')),
  ]);
}

function profileModal() {
  const [lbl, name] = field('Display name', { value: S.me.displayName, maxlength: 32 });
  const pic = el('input', { type: 'file', accept: 'image/*' });
  const err = el('p', { class: 'error' });
  const dlg = modal([
    el('h2', {}, 'Your profile'),
    el('div', { style: { display: 'flex', gap: '14px', alignItems: 'center' } }, avatar(S.me, { size: 64 }),
      el('div', {}, el('strong', {}, '@' + S.me.username))),
    lbl, el('label', {}, 'Avatar image', pic),
    el('label', {}, 'Appearance', themePicker()),
    el('label', { class: 'check' }, soundToggle(), 'Retro sound effects'),
    S.gifs ? el('label', { class: 'check' }, gifToggle(), 'Show GIFs automatically (they load from GIPHY, which can see your IP address; when off, tap a GIF to load it)') : null,
    err,
    el('div', { class: 'row', style: { justifyContent: 'flex-start' } },
      el('button', { class: 'btn', onclick: () => { dlg.close(); passwordModal(); } }, 'Change password'),
      el('button', { class: 'btn', onclick: () => { dlg.close(); sessionsModal(); } }, 'Signed-in devices'),
      el('button', { class: 'btn', onclick: () => { dlg.close(); accountSecurityModal(); } }, 'Account recovery'),
      el('button', { class: 'btn', onclick: () => { dlg.close(); blockedModal(); } }, 'Blocked users'),
      el('a', { class: 'btn', href: '/api/users/@me/export', download: '' }, 'Download my data'),
      el('button', { class: 'btn danger', onclick: () => { dlg.close(); deleteAccountModal(); } }, 'Delete account')),
    el('p', { class: 'muted small', style: { margin: 0 } },
      el('a', { href: '/privacy.html', target: '_blank' }, 'Privacy Policy'), ' \u00b7 ',
      el('a', { href: '/terms.html', target: '_blank' }, 'Terms')),
    el('div', { class: 'row' },
      el('button', { class: 'btn', onclick: () => dlg.close() }, 'Cancel'),
      el('button', { class: 'btn primary', onclick: async () => {
        try {
          const patch = { displayName: name.value };
          if (pic.files[0]) patch.avatar = (await upload('/uploads/avatar', pic.files[0])).url;
          S.me = await api('PATCH', '/users/@me', patch);
          renderMe();
          dlg.close();
        } catch (e) { err.textContent = e.message; }
      } }, 'Save')),
  ]);
}

function passwordModal() {
  const cur = el('input', { type: 'password', autocomplete: 'current-password', maxlength: 256 });
  const next = el('input', { type: 'password', autocomplete: 'new-password', minlength: 12, maxlength: 256 });
  const again = el('input', { type: 'password', autocomplete: 'new-password', maxlength: 256 });
  const err = el('p', { class: 'error' });
  const save = async () => {
    err.textContent = '';
    if (next.value !== again.value) { err.textContent = 'The new passwords do not match.'; return; }
    try {
      await api('POST', '/users/@me/password', { currentPassword: cur.value, newPassword: next.value });
      dlg.close();
      toast('Password changed. Your other devices have been signed out.');
    } catch (e) { err.textContent = e.message; }
  };
  const dlg = modal([
    el('h2', {}, 'Change password'),
    el('label', {}, 'Current password', cur),
    el('label', {}, 'New password', next),
    el('p', { class: 'muted small', style: { margin: 0 } }, 'At least 12 characters. A few random words work well.'),
    el('label', {}, 'New password again', again), err,
    el('div', { class: 'row' },
      el('button', { class: 'btn', onclick: () => dlg.close() }, 'Cancel'),
      el('button', { class: 'btn primary', onclick: save }, 'Change password')),
  ]);
}

function describeDevice(ua) {
  if (!ua) return 'Unknown device';
  const os = /iPhone|iPad/.test(ua) ? 'iPhone/iPad' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows'
    : /Mac OS/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : 'Device';
  const br = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox'
    : /Safari\//.test(ua) ? 'Safari' : 'app';
  return `${br} on ${os}`;
}

async function sessionsModal() {
  const list = el('div');
  const dlg = modal([
    el('h2', {}, 'Signed-in devices'),
    el('p', { class: 'muted small', style: { margin: 0 } }, 'Sign out any device you don\u2019t recognize, then change your password.'),
    list,
    el('div', { class: 'row' },
      el('button', { class: 'btn danger', style: { marginRight: 'auto' }, onclick: async () => {
        if (!(await confirmDialog('Sign out everywhere', 'This signs out every device, including this one.', 'Sign out all'))) return;
        await api('POST', '/auth/logout-all').catch(() => {});
        location.href = '/';
      } }, 'Sign out everywhere'),
      el('button', { class: 'btn', onclick: () => dlg.close() }, 'Close')),
  ]);
  const draw = async () => {
    try {
      const sessions = await api('GET', '/users/@me/sessions');
      list.replaceChildren(...sessions.map((x) => el('div', { class: 'list-row' },
        el('div', {}, el('strong', {}, describeDevice(x.userAgent), x.current ? ' (this device)' : ''),
          el('div', { class: 'muted small' }, `Last active ${fmtTime(x.lastSeen)}${x.ip ? ' \u00b7 ' + x.ip : ''}`)),
        el('span', { class: 'spacer' }),
        x.current ? null : el('button', { class: 'btn', onclick: async () => {
          try { await api('DELETE', `/users/@me/sessions/${x.id}`); draw(); } catch (e) { toast(e.message); }
        } }, 'Sign out'))));
    } catch (e) { list.replaceChildren(el('p', { class: 'error' }, e.message)); }
  };
  draw();
}

// A confirmation for actions that destroy data. The person must type an
// exact phrase (and optionally their password) before the button unlocks.
function dangerDialog({ title, lines, confirmText, confirmLabel, password = false, run }) {
  const typed = el('input', { autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' });
  const pw = password ? el('input', { type: 'password', autocomplete: 'current-password' }) : null;
  const err = el('p', { class: 'error' });
  const go = el('button', { class: 'btn danger', disabled: true }, confirmLabel);
  const check = () => { go.disabled = typed.value !== confirmText || (pw && !pw.value); };
  typed.addEventListener('input', check);
  if (pw) pw.addEventListener('input', check);
  go.onclick = async () => {
    go.disabled = true;
    err.textContent = '';
    try {
      await run({ password: pw ? pw.value : undefined });
      dlg.close();
      toast('Permanently deleted.');
    } catch (e) { err.textContent = e.message; check(); }
  };
  const dlg = modal([
    el('h2', {}, title),
    el('div', { class: 'danger-box' },
      el('strong', {}, '\u26a0 This can\u2019t be undone.'),
      ...lines.map((l) => el('p', {}, l)),
      el('p', {}, 'It disappears from Hearth right away and can\u2019t be restored. For safety and legal reasons, an encrypted copy is kept for 30 days where only Hearth\u2019s safety team can reach it, then it\u2019s erased for good.')),
    el('label', {}, 'Type ', el('code', {}, confirmText), ' to confirm', typed),
    pw ? el('label', {}, 'Your password', pw) : null,
    err,
    el('div', { class: 'row' }, el('button', { class: 'btn', onclick: () => dlg.close() }, 'Cancel'), go),
  ]);
}

function deleteAccountModal() {
  const owned = [...S.servers.values()].filter((s) => s.ownerId === S.me.id);
  if (owned.length) {
    const dlg = modal([
      el('h2', {}, 'Delete account'),
      el('p', {}, 'You still own these servers: ', el('strong', {}, owned.map((s) => s.name).join(', ')), '.'),
      el('p', { class: 'muted' }, 'Delete each one, or transfer it to another member (Server settings \u2192 Overview), then come back here.'),
      el('div', { class: 'row' }, el('button', { class: 'btn', onclick: () => dlg.close() }, 'OK')),
    ]);
    return;
  }
  dangerDialog({
    title: 'Delete your account?',
    lines: [
      'Your profile, every message you have sent, your uploaded files, reactions and memberships will be deleted.',
      'You will be signed out on all devices. Your username becomes available to others.',
      'Want a copy first? Use \u201cDownload my data\u201d in your profile before continuing.',
    ],
    confirmText: 'DELETE', confirmLabel: 'Delete my account', password: true,
    run: async ({ password }) => {
      voice.leave();
      await api('DELETE', '/users/@me', { password, confirm: 'DELETE' });
      gw.close();
      setTimeout(() => { location.href = '/'; }, 800);
    },
  });
}

function transferModal(s) {
  const select = el('select', {}, s.members.filter((m) => m.user.id !== S.me.id)
    .map((m) => el('option', { value: m.user.id }, `${m.nickname || m.user.displayName} (@${m.user.username})`)));
  const pw = el('input', { type: 'password', autocomplete: 'current-password' });
  const err = el('p', { class: 'error' });
  const dlg = modal([
    el('h2', {}, `Transfer ${s.name}`),
    el('p', { class: 'muted' }, 'The new owner gets full control, including deleting the server. You stay a member but lose owner powers.'),
    el('label', {}, 'New owner', select), el('label', {}, 'Your password', pw), err,
    el('div', { class: 'row' }, el('button', { class: 'btn', onclick: () => dlg.close() }, 'Cancel'),
      el('button', { class: 'btn danger', onclick: async () => {
        try { await api('POST', `/servers/${s.id}/transfer`, { userId: select.value, password: pw.value }); dlg.close(); toast('Ownership transferred.'); }
        catch (e) { err.textContent = e.message; }
      } }, 'Transfer ownership')),
  ]);
}

function themePicker() {
  const wrap = el('div', { style: { display: 'grid', gap: '10px', marginTop: '6px' } });
  const seg = el('div', { class: 'seg' });
  for (const [k, label] of [['dark', 'Dark'], ['grey', 'Grey'], ['light', 'Light'], ['system', 'Auto']]) {
    seg.append(el('button', { type: 'button', class: themePref() === k ? 'on' : '', 'data-k': k, onclick: () => {
      try { localStorage.setItem('hearth_theme', k); } catch { /* ignore */ }
      applyTheme();
      seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.k === k));
    } }, label));
  }
  const grid = el('div', { class: 'palette-grid' }, PALETTES.map((p) => el('button', {
    type: 'button', class: 'palette' + (palettePref() === p.id ? ' on' : ''), 'data-id': p.id, title: p.blurb,
    onclick: () => {
      try { localStorage.setItem('hearth_palette', p.id); } catch { /* ignore */ }
      applyTheme();
      grid.querySelectorAll('.palette').forEach((b) => b.classList.toggle('on', b.dataset.id === p.id));
    },
  },
  el('span', { class: 'swatch' }, p.colors.map((c) => el('i', { style: { background: c } }))),
  el('span', { class: 'pname' }, p.name),
  el('span', { class: 'pblurb' }, p.blurb))));
  wrap.append(seg, grid);
  return wrap;
}

function soundToggle() {
  const cb = el('input', { type: 'checkbox' });
  cb.checked = sfx.enabled();
  cb.onchange = () => { sfx.setEnabled(cb.checked); if (cb.checked) sfx.play('unmute'); };
  return cb;
}


// ================================================================ account recovery
function forgotModal() {
  const id = el('input', { placeholder: 'Username or email', autocomplete: 'username' });
  const err = el('p', { class: 'error' });
  const step1 = el('div', { style: { display: 'grid', gap: '12px' } },
    el('p', { class: 'muted', style: { margin: 0 } }, 'We’ll email a reset code to the address on your account. No email on your account? Use one of your backup recovery codes instead.'),
    el('label', {}, 'Username or email', id));
  const code = el('input', { autocomplete: 'one-time-code', autocapitalize: 'characters', maxlength: 12 });
  const useRecovery = el('input', { type: 'checkbox' });
  const pw = el('input', { type: 'password', autocomplete: 'new-password', maxlength: 256 });
  const pw2 = el('input', { type: 'password', autocomplete: 'new-password', maxlength: 256 });
  const codeLabel = el('label', {}, 'Code from the email', code);
  useRecovery.onchange = () => { codeLabel.firstChild.textContent = useRecovery.checked ? 'Backup recovery code' : 'Code from the email'; };
  const step2 = el('div', { class: 'hidden', style: { display: 'grid', gap: '12px' } },
    codeLabel, el('label', { class: 'check' }, useRecovery, 'I’m using a backup recovery code'),
    el('label', {}, 'New password', pw), el('label', {}, 'Type it again', pw2),
    el('p', { class: 'muted small', style: { margin: 0 } }, 'At least 12 characters. All your devices will be signed out.'));
  const btn = el('button', { class: 'btn primary' }, 'Send code');
  const skip = el('button', { class: 'btn', style: { marginRight: 'auto' } }, 'I have a recovery code');
  let stage = 1;
  const toStep2 = () => { stage = 2; step2.classList.remove('hidden'); step2.style.display = 'grid'; btn.textContent = 'Reset password'; skip.remove(); };
  skip.onclick = () => { useRecovery.checked = true; useRecovery.onchange(); toStep2(); };
  btn.onclick = async () => {
    err.textContent = '';
    try {
      if (stage === 1) {
        const r = await api('POST', '/auth/forgot', { identifier: id.value.trim() });
        toast(r.message);
        toStep2();
      } else {
        if (pw.value !== pw2.value) { err.textContent = 'The two passwords don\u2019t match.'; return; }
        const body = { identifier: id.value.trim(), newPassword: pw.value };
        if (useRecovery.checked) body.recoveryCode = code.value.trim(); else body.code = code.value.trim();
        const r = await api('POST', '/auth/reset', body);
        dlg.close();
        S.me = r.user;
        toast('Password reset. You’re signed in.');
        start();
      }
    } catch (e) { err.textContent = e.message; }
  };
  const dlg = modal([el('h2', {}, 'Reset your password'), step1, step2, err, el('div', { class: 'row' }, skip, el('button', { class: 'btn', onclick: () => dlg.close() }, 'Cancel'), btn)]);
}

async function verifyEmailModal(justRegistered) {
  const sec = await api('GET', '/users/@me/security').catch(() => null);
  if (!sec || !sec.email || sec.emailVerified) return;
  const code = el('input', { inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 6, placeholder: '123456' });
  const err = el('p', { class: 'error' });
  const dlg = modal([
    el('h2', {}, 'Verify your email'),
    el('p', { class: 'muted', style: { margin: 0 } }, justRegistered ? `We sent a 6-digit code to ${sec.email}.` : `Enter the code sent to ${sec.email}.`,
      sec.emailEnabled ? '' : ' (Email sending isn’t set up on this server yet, so the code may not arrive.)'),
    el('label', {}, 'Verification code', code), err,
    el('div', { class: 'row' },
      el('button', { class: 'btn', style: { marginRight: 'auto' }, onclick: async () => {
        try { await api('POST', '/users/@me/email/resend'); toast('New code sent.'); } catch (e) { err.textContent = e.message; }
      } }, 'Resend code'),
      el('button', { class: 'btn', onclick: () => dlg.close() }, 'Later'),
      el('button', { class: 'btn primary', onclick: async () => {
        try { await api('POST', '/users/@me/email/verify', { code: code.value.trim() }); S.me.emailVerified = true; renderAccountBanner(); dlg.close(); toast('Email verified.'); }
        catch (e) { err.textContent = e.message; }
      } }, 'Verify')),
  ]);
}

async function accountSecurityModal() {
  const sec = await api('GET', '/users/@me/security');
  const body = el('div', { style: { display: 'grid', gap: '14px' } });
  const dlg = modal([el('h2', {}, 'Account recovery'), body, el('div', { class: 'row' }, el('button', { class: 'btn', onclick: () => dlg.close() }, 'Done'))]);
  const draw = (sec) => {
    const err = el('p', { class: 'error' });
    const pw = el('input', { type: 'password', autocomplete: 'current-password', placeholder: 'The password you log in with' });
    const pwErr = el('p', { class: 'error', style: { margin: '4px 0 0' } });
    const email = el('input', { type: 'email', placeholder: 'you@example.com', value: sec.email || '' });
    const code = el('input', { inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 6, placeholder: '123456' });
    const codeRow = el('div', { class: 'hidden', style: { display: 'grid', gap: '8px' } },
      el('label', {}, 'Code from the email', code),
      el('div', { class: 'row' }, el('button', { class: 'btn primary', onclick: async () => {
        err.textContent = '';
        try {
          const updated = await api('POST', '/users/@me/email/confirm', { code: code.value.trim() });
          S.me.hasEmail = true; S.me.emailVerified = true; renderAccountBanner(); toast('Email confirmed.'); draw(updated);
        } catch (e) { err.textContent = e.message; }
      } }, 'Confirm')));
    pw.addEventListener('input', () => { pwErr.textContent = ''; });
    const status = !sec.email ? 'Add an email so you can recover your account.'
      : sec.emailVerified ? 'Verified: used for password resets and security alerts.'
        : sec.emailEnabled ? 'Not verified yet. Verify it so you can recover your account.'
          : 'Saved. It will be verified once this Hearth’s admin sets up email sending. Until then, use backup recovery codes.';
    body.replaceChildren(
      el('div', { class: 'list-row' }, el('div', {},
        el('strong', {}, 'Email: '), sec.email || 'none',
        el('div', { class: 'muted small' }, status)),
      el('span', { class: 'spacer' }),
      sec.email && !sec.emailVerified && sec.emailEnabled ? el('button', { class: 'btn', onclick: () => { dlg.close(); verifyEmailModal(false); } }, 'Verify') : null),
      el('label', {}, sec.email ? 'New email address' : 'Email address', email),
      el('label', {}, 'Your Hearth password', pw), pwErr,
      el('div', { class: 'row' }, el('button', { class: 'btn primary', onclick: async () => {
        err.textContent = ''; pwErr.textContent = '';
        if (!email.value.trim()) { err.textContent = 'Enter an email address.'; return; }
        if (!pw.value) { pwErr.textContent = 'Enter your password to confirm it’s you.'; pw.focus(); return; }
        try {
          const r = await api('POST', '/users/@me/email', { email: email.value.trim(), password: pw.value });
          S.me = { ...S.me, ...r.me };
          renderAccountBanner();
          if (r.codeSent) {
            toast(`Code sent to ${email.value.trim()}`);
            codeRow.classList.remove('hidden'); codeRow.style.display = 'grid'; code.focus();
          } else {
            toast('Email saved.');
            draw(r.security);
          }
        } catch (e) {
          if (e.status === 403) { pwErr.textContent = e.message; pw.select(); } else err.textContent = e.message;
        }
      } }, sec.email ? 'Save new email' : 'Save email')),
      codeRow,
      el('div', { class: 'list-row' }, el('div', {},
        el('strong', {}, 'Backup recovery codes'),
        el('div', { class: 'muted small' }, sec.recoveryCodesLeft === null
          ? 'Ten one-time codes that reset your password if you ever lose your email. Store them somewhere safe.'
          : `${sec.recoveryCodesLeft} of 10 unused. Making new ones cancels the old ones.`)),
      el('span', { class: 'spacer' }),
      el('button', { class: 'btn', onclick: async () => {
        err.textContent = '';
        if (!pw.value) { err.textContent = 'Enter your password above first.'; return; }
        try {
          const { codes } = await api('POST', '/users/@me/recovery-codes', { password: pw.value });
          const text = `Hearth recovery codes for @${S.me.username}\nEach code works once.\n\n${codes.join('\n')}\n`;
          body.replaceChildren(
            el('div', { class: 'danger-box' }, el('strong', {}, 'Save these now. They won’t be shown again.')),
            el('pre', { style: { fontSize: '16px', background: 'var(--bg-0)', padding: '12px', borderRadius: '6px', columns: '2' } }, codes.join('\n')),
            el('div', { class: 'row' },
              el('button', { class: 'btn', onclick: () => navigator.clipboard.writeText(text).then(() => toast('Copied')) }, 'Copy'),
              el('a', { class: 'btn', href: URL.createObjectURL(new Blob([text], { type: 'text/plain' })), download: 'hearth-recovery-codes.txt' }, 'Download')));
        } catch (e) { err.textContent = e.message; }
      } }, sec.recoveryCodesLeft === null ? 'Create codes' : 'New codes')),
      err);
  };
  draw(sec);
}

function renderAccountBanner() {
  let bar = $('account-banner');
  if (!bar) {
    bar = el('div', { id: 'account-banner', class: 'call-banner hidden' });
    $('main').insertBefore(bar, $('call-banner'));
  }
  if (S.me && (!S.me.hasEmail || (!S.me.emailVerified && S.me.emailEnabled))) {
    bar.replaceChildren(el('span', {}, S.me.hasEmail ? 'Verify your email so you can recover your account if you forget your password.' : 'Add an email so you can recover your account if you forget your password.'),
      el('span', { class: 'spacer' }),
      el('button', { class: 'btn primary', onclick: () => (S.me.hasEmail ? verifyEmailModal(false) : accountSecurityModal()) }, S.me.hasEmail ? 'Verify' : 'Add email'),
      el('button', { class: 'icon-btn', title: 'Dismiss', onclick: () => bar.classList.add('hidden') }, '✕'));
    bar.classList.remove('hidden');
  } else bar.classList.add('hidden');
}

// ================================================================ age gates
function birthdateModal(required, onDone) {
  const dob = el('input', { type: 'date', max: new Date().toISOString().slice(0, 10) });
  const err = el('p', { class: 'error' });
  const dlg = modal([
    el('h2', {}, 'Confirm your age'),
    el('p', { class: 'muted', style: { margin: 0 } }, `This is for people ${required} and older. Enter your date of birth to continue. You can only set it once, so enter it accurately. It’s stored encrypted and never shown to anyone.`),
    el('label', {}, 'Date of birth', dob), err,
    el('div', { class: 'row' }, el('button', { class: 'btn', onclick: () => dlg.close() }, 'Cancel'),
      el('button', { class: 'btn primary', onclick: async () => {
        try { S.me = { ...S.me, ...(await api('POST', '/users/@me/birthdate', { date: dob.value })) }; dlg.close(); onDone && onDone(); }
        catch (e) { err.textContent = e.message; }
      } }, 'Confirm')),
  ]);
}

// Shown the first time you open an age-restricted channel on this device.
function ageWarning(c, go) {
  const key = `hearth_agegate_${c.id}`;
  try { if (localStorage.getItem(key)) return go(); } catch { /* ignore */ }
  const dlg = modal([
    el('h2', {}, `${c.ageRating}+ channel`),
    el('div', { class: 'danger-box' }, el('strong', {}, 'Age-restricted content'),
      el('p', {}, `#${c.name} may contain content only suitable for people ${c.ageRating} and older. You confirmed you meet the age requirement.`)),
    el('div', { class: 'row' }, el('button', { class: 'btn', onclick: () => dlg.close() }, 'Go back'),
      el('button', { class: 'btn primary', onclick: () => { try { localStorage.setItem(key, '1'); } catch { /* ignore */ } dlg.close(); go(); } }, 'Continue')),
  ]);
}

// ================================================================ reports & blocking
let reportCategories = null;
async function reportModal({ targetType, targetId, serverId, label }) {
  reportCategories = reportCategories || await api('GET', '/reports/categories');
  const err = el('p', { class: 'error' });
  const details = el('textarea', { rows: 3, maxlength: 2000, placeholder: 'Anything that helps moderators understand (optional)' });
  const toHearth = el('input', { type: 'checkbox' });
  let chosen = null;
  const hearthRow = el('label', { class: 'check' }, toHearth, 'Also send this to the Hearth safety team');
  const note = el('p', { class: 'muted small', style: { margin: 0 } });
  const updateNote = () => {
    const platformOnly = chosen === 'child_safety' || !serverId || targetType === 'server';
    hearthRow.classList.toggle('hidden', platformOnly);
    note.textContent = chosen === 'child_safety'
      ? 'This goes straight to the Hearth safety team, not server moderators. The content is preserved as evidence and reported to the National Center for Missing & Exploited Children as US law requires. If a child is in immediate danger, call 911.'
      : platformOnly ? 'This goes to the Hearth safety team.' : 'This goes to this server’s moderators.';
  };
  const choices = el('div', { class: 'choice' }, Object.entries(reportCategories).map(([k, v]) =>
    el('button', { type: 'button', onclick: (e) => {
      chosen = k;
      choices.querySelectorAll('button').forEach((b) => b.classList.toggle('picked', b === e.currentTarget));
      updateNote();
    } }, v)));
  updateNote();
  const dlg = modal([
    el('h2', {}, `Report ${label || targetType}`),
    el('p', { class: 'muted', style: { margin: 0 } }, 'What’s wrong? The person you report won’t see who reported them.'),
    choices, details, hearthRow, note, err,
    el('div', { class: 'row' }, el('button', { class: 'btn', onclick: () => dlg.close() }, 'Cancel'),
      el('button', { class: 'btn danger', onclick: async () => {
        if (!chosen) { err.textContent = 'Pick what kind of problem this is.'; return; }
        try {
          await api('POST', '/reports', { targetType, targetId, serverId, category: chosen, details: details.value, toHearth: toHearth.checked });
          dlg.close();
          toast('Report sent. Thank you for helping keep Hearth safe.');
        } catch (e) { err.textContent = e.message; }
      } }, 'Send report')),
  ], { wide: false });
}

async function toggleBlock(u) {
  const blocked = S.blocked.has(u.id);
  if (!blocked && !(await confirmDialog(`Block ${u.displayName}?`, 'Their messages will be hidden from you and they won’t be able to send you direct messages. They aren’t told.', 'Block'))) return;
  try {
    await api(blocked ? 'DELETE' : 'PUT', `/users/@me/blocks/${u.id}`);
    toast(blocked ? 'Unblocked.' : 'Blocked.');
  } catch (e) { toast(e.message); }
}

// Opening a channel goes through the age checks first.
function openChannel(c) {
  if (c.locked) return birthdateModal(c.ageRating || 18, () => refreshServer(c.serverId).then(() => {
    const now = server() && server().channels.find((x) => x.id === c.id);
    if (now && !now.locked) openChannel(now); else toast(`This channel is for people ${c.ageRating}+ only.`);
  }));
  const go = () => (c.type === 'voice' ? joinVoice(c.id) : selectChannel(c.id));
  if (c.ageRating) return ageWarning(c, go);
  go();
}

async function refreshServer(id) {
  try {
    const s = await api('GET', `/servers/${id}`);
    S.servers.set(id, s);
    if (S.serverId === id) {
      if (S.channelId && !findChannel(S.channelId)) selectServer(id);
      else { renderSidebar(); renderHeader(); renderMembers(); }
    }
    renderRail();
  } catch {
    if (S.servers.delete(id) && S.serverId === id) selectServer(null);
  }
}

function blockedModal() {
  const list = el('div');
  const dlg = modal([el('h2', {}, 'Blocked users'), list, el('div', { class: 'row' }, el('button', { class: 'btn', onclick: () => dlg.close() }, 'Close'))]);
  api('GET', '/users/@me/blocks').then((rows) => {
    list.replaceChildren(...(rows.length ? rows.map((u) => el('div', { class: 'list-row' }, el('strong', {}, u.displayName), el('span', { class: 'muted small' }, '@' + u.username),
      el('span', { class: 'spacer' }), el('button', { class: 'btn', onclick: async () => { await toggleBlock({ id: u.id, displayName: u.displayName }); dlg.close(); } }, 'Unblock')))
      : [el('p', { class: 'muted' }, 'You haven’t blocked anyone.')]));
  });
}


// ================================================================ server settings
function serverSettingsModal(s, start = 'overview') {
  const tabs = [['overview', 'Overview', true], ['invite', 'Invite', can(P.CREATE_INVITE, s)],
    ['roles', 'Roles', can(P.MANAGE_ROLES, s)], ['members', 'Members', true],
    ['reports', 'Reports', can(P.MODERATE_MEMBERS, s)], ['bans', 'Bans', can(P.BAN_MEMBERS, s)],
    ['audit', 'Audit log', can(P.VIEW_AUDIT_LOG, s)]].filter((t) => t[2]);
  const body = el('div');
  const tabBar = el('div', { class: 'tabs', style: { overflowX: 'auto' } });
  const show = async (key) => {
    tabBar.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.k === key));
    body.replaceChildren(el('p', { class: 'muted' }, 'Loading…'));
    const s2 = S.servers.get(s.id) || s;
    const view = {
      overview: () => overviewTab(s2, dlg), invite: () => inviteBlock(s2), roles: () => rolesTab(s2),
      members: () => membersTab(s2), reports: () => reportsTab(s2), bans: () => bansTab(s2), audit: () => auditTab(s2),
    }[key];
    try { body.replaceChildren(await view()); } catch (e) { body.replaceChildren(el('p', { class: 'error' }, e.message)); }
  };
  for (const [k, label] of tabs) tabBar.append(el('button', { 'data-k': k, onclick: () => show(k) }, label));
  const dlg = modal([el('h2', {}, s.name), tabBar, body], { wide: true });
  show(start);
}

function reasonPrompt(title, extra) {
  return new Promise((resolve) => {
    const reason = el('input', { maxlength: 300, placeholder: 'Reason (shown in the audit log)' });
    const minutes = extra === 'timeout' ? el('select', {}, [['10', '10 minutes'], ['60', '1 hour'], ['1440', '1 day'], ['10080', '1 week']].map(([v, l]) => el('option', { value: v }, l))) : null;
    let done = false;
    const finish = (v) => { if (!done) { done = true; dlg.close(); resolve(v); } };
    const dlg = modal([el('h2', {}, title), minutes ? el('label', {}, 'How long', minutes) : null, el('label', {}, 'Reason', reason),
      el('div', { class: 'row' }, el('button', { class: 'btn', onclick: () => finish(null) }, 'Cancel'),
        el('button', { class: 'btn danger', onclick: () => finish({ reason: reason.value, minutes: minutes ? Number(minutes.value) : undefined }) }, 'Confirm'))],
    { onClose: () => { if (!done) { done = true; resolve(null); } } });
  });
}

function myTop(s) {
  if (s.ownerId === S.me.id) return Infinity;
  const m = memberOf(s, S.me.id);
  return Math.max(0, ...s.roles.filter((r) => m && m.roles.includes(r.id)).map((r) => r.position));
}
function topOf(s, userId) {
  if (s.ownerId === userId) return Infinity;
  const m = memberOf(s, userId);
  return Math.max(0, ...s.roles.filter((r) => m && m.roles.includes(r.id)).map((r) => r.position));
}

function rolesTab(s) {
  const wrap = el('div', { style: { display: 'grid', gap: '12px' } });
  const editor = el('div');
  const list = el('div');
  const top = myTop(s);
  const draw = () => {
    const roles = s.roles.filter((r) => !r.isDefault).sort((a, b) => b.position - a.position);
    const move = async (r, dir) => {
      const ids = roles.map((x) => x.id);
      const i = ids.indexOf(r.id); const j = i + dir;
      if (j < 0 || j >= ids.length) return;
      [ids[i], ids[j]] = [ids[j], ids[i]];
      try { s.roles = await api('PUT', `/servers/${s.id}/roles/order`, { ids }); draw(); } catch (e) { toast(e.message); }
    };
    list.replaceChildren(...[...roles, s.roles.find((r) => r.isDefault)].map((r) => el('div', { class: 'list-row' },
      el('span', { class: 'dot', style: { background: r.color || 'var(--muted)' } }),
      el('strong', { style: { cursor: 'pointer' }, onclick: () => edit(r) }, r.name),
      el('span', { class: 'spacer' }),
      r.isDefault ? el('span', { class: 'muted small' }, 'everyone') : null,
      !r.isDefault && r.position < top ? el('button', { class: 'icon-btn', title: 'Move up', onclick: () => move(r, -1) }, '▲') : null,
      !r.isDefault && r.position < top ? el('button', { class: 'icon-btn', title: 'Move down', onclick: () => move(r, 1) }, '▼') : null,
      r.isDefault || r.position < top ? el('button', { class: 'btn', onclick: () => edit(r) }, 'Edit') : el('span', { class: 'muted small' }, 'above you'))));
  };
  const edit = (r) => {
    const [lblName, name] = field('Role name', { value: r.name, maxlength: 32, disabled: r.isDefault });
    const color = el('input', { type: 'color', value: r.color || '#39d98a', style: { width: '64px', padding: '2px' } });
    const boxes = Object.keys(PERM_LABELS).map((k) => {
      const cb = el('input', { type: 'checkbox' });
      cb.checked = (r.permissions & P[k]) === P[k];
      cb.dataset.k = k;
      return el('label', {}, cb, PERM_LABELS[k]);
    });
    const err = el('p', { class: 'error' });
    editor.replaceChildren(el('div', { style: { display: 'grid', gap: '10px', borderTop: '1px solid var(--line)', paddingTop: '12px' } },
      lblName, el('label', {}, 'Color ', color), el('div', { class: 'perm-grid' }, boxes), err,
      el('div', { class: 'row' },
        r.isDefault ? null : el('button', { class: 'btn danger', style: { marginRight: 'auto' }, onclick: async () => {
          if (!(await confirmDialog('Delete role', `Delete the ${r.name} role? Members lose it immediately.`, 'Delete role'))) return;
          try { await api('DELETE', `/roles/${r.id}`); s.roles = s.roles.filter((x) => x.id !== r.id); editor.replaceChildren(); draw(); }
          catch (e) { err.textContent = e.message; }
        } }, 'Delete role'),
        el('button', { class: 'btn primary', onclick: async () => {
          let perms = 0;
          editor.querySelectorAll('input[type=checkbox]').forEach((cb) => { if (cb.checked) perms |= P[cb.dataset.k]; });
          try {
            const updated = await api('PATCH', `/roles/${r.id}`, { name: name.value, color: color.value, permissions: perms });
            Object.assign(r, updated); draw(); toast('Role saved');
          } catch (e) { err.textContent = e.message; }
        } }, 'Save role'))));
  };
  wrap.append(
    el('p', { class: 'muted small', style: { margin: 0 } }, 'Higher roles outrank lower ones. You can only edit, assign and move roles below your own highest role.'),
    el('div', { class: 'row' }, el('button', { class: 'btn primary', onclick: async () => {
      try {
        const r = await api('POST', `/servers/${s.id}/roles`, { name: 'new role', permissions: 0 });
        const fresh = await api('GET', `/servers/${s.id}`); s.roles = fresh.roles; S.servers.set(s.id, fresh);
        draw(); edit(s.roles.find((x) => x.id === r.id));
      } catch (e) { toast(e.message); }
    } }, 'Create role')), list, editor);
  draw();
  return wrap;
}

function membersTab(s) {
  const wrap = el('div');
  const q = el('input', { placeholder: 'Search members' });
  const list = el('div', { style: { marginTop: '10px' } });
  const draw = () => {
    const term = q.value.trim().toLowerCase();
    const cur = S.servers.get(s.id) || s;
    list.replaceChildren(...cur.members.filter((m) => !term || (m.nickname || m.user.displayName).toLowerCase().includes(term) || m.user.username.includes(term))
      .slice(0, 200).map((m) => memberRow(cur, m, draw)));
  };
  q.oninput = draw;
  wrap.append(q, list);
  draw();
  return wrap;
}

function memberRow(s, m, refresh) {
  const roles = s.roles.filter((r) => !r.isDefault).sort((a, b) => b.position - a.position);
  const top = myTop(s);
  const canRoles = can(P.MANAGE_ROLES, s);
  const self = m.user.id === S.me.id;
  const owner = m.user.id === s.ownerId;
  const outranked = top > topOf(s, m.user.id);
  const act = (perm) => !self && !owner && outranked && can(perm, s);
  const timedOut = m.timeoutUntil && m.timeoutUntil > Date.now();
  return el('div', { class: 'list-row', style: { flexWrap: 'wrap' } },
    avatar(m.user, { status: true }),
    el('div', {}, el('strong', {}, m.nickname || m.user.displayName, owner ? ' \u{1F451}' : '', timedOut ? ' ⏳' : ''),
      el('div', { class: 'muted small' }, '@' + m.user.username, timedOut ? ` · timed out until ${new Date(m.timeoutUntil).toLocaleString()}` : '')),
    el('span', { class: 'spacer' }),
    el('div', { style: { display: 'flex', gap: '4px', flexWrap: 'wrap' } }, roles.map((r) => {
      const has = m.roles.includes(r.id);
      const allowed = canRoles && r.position < top && (self || outranked);
      return el('span', { class: 'chip' + (has ? ' on' : ''), title: allowed ? 'Toggle role' : '', style: { opacity: allowed || has ? 1 : 0.5 }, onclick: async () => {
        if (!allowed) return;
        try { const upd = await api(has ? 'DELETE' : 'PUT', `/servers/${s.id}/members/${m.user.id}/roles/${r.id}`); Object.assign(m, upd); refresh && refresh(); }
        catch (e) { toast(e.message); }
      } }, r.name);
    })),
    act(P.MODERATE_MEMBERS) ? el('button', { class: 'btn', onclick: async () => {
      if (timedOut) { await api('PUT', `/servers/${s.id}/members/${m.user.id}/timeout`, { minutes: 0 }).catch((e) => toast(e.message)); refresh && refresh(); return; }
      const r = await reasonPrompt(`Time out ${m.user.displayName}`, 'timeout');
      if (!r) return;
      try { Object.assign(m, await api('PUT', `/servers/${s.id}/members/${m.user.id}/timeout`, r)); refresh && refresh(); } catch (e) { toast(e.message); }
    } }, timedOut ? 'End timeout' : 'Timeout') : null,
    act(P.KICK_MEMBERS) ? el('button', { class: 'btn', onclick: async () => {
      const r = await reasonPrompt(`Kick ${m.user.displayName}?`);
      if (!r) return;
      try { await api('DELETE', `/servers/${s.id}/members/${m.user.id}`, r); refresh && refresh(); } catch (e) { toast(e.message); }
    } }, 'Kick') : null,
    act(P.BAN_MEMBERS) ? el('button', { class: 'btn danger', onclick: async () => {
      const r = await reasonPrompt(`Ban ${m.user.displayName}?`);
      if (!r) return;
      try { await api('PUT', `/servers/${s.id}/bans/${m.user.id}`, r); refresh && refresh(); } catch (e) { toast(e.message); }
    } }, 'Ban') : null);
}

async function bansTab(s) {
  const wrap = el('div');
  const draw = async () => {
    const bans = await api('GET', `/servers/${s.id}/bans`);
    wrap.replaceChildren(...(bans.length ? bans.map((b) => el('div', { class: 'list-row' },
      el('div', {}, el('strong', {}, b.displayName || 'Deleted user'), el('div', { class: 'muted small' }, (b.username ? '@' + b.username : '') + (b.reason ? ` · ${b.reason}` : ''))),
      el('span', { class: 'spacer' }),
      el('button', { class: 'btn', onclick: async () => { await api('DELETE', `/servers/${s.id}/bans/${b.userId}`).catch((e) => toast(e.message)); draw(); } }, 'Unban')))
      : [el('p', { class: 'muted' }, 'Nobody is banned.')]));
  };
  await draw();
  return wrap;
}

const AUDIT_LABELS = {
  'member.kick': 'kicked', 'member.ban': 'banned', 'member.unban': 'unbanned', 'member.timeout': 'timed out',
  'member.timeout_clear': 'ended the timeout for', 'member.role_add': 'gave a role to', 'member.role_remove': 'removed a role from',
  'role.create': 'created role', 'role.update': 'updated role', 'role.delete': 'deleted role', 'role.reorder': 'reordered roles',
  'channel.create': 'created channel', 'channel.update': 'updated channel', 'channel.delete': 'deleted channel',
  'channel.permissions': 'changed permissions for', 'message.delete': 'deleted a message by', 'message.purge': 'purged messages:',
  'server.update': 'updated server settings', 'report.resolve': 'resolved a report:', 'report.dismiss': 'dismissed a report:',
};
async function auditTab(s) {
  const rows = await api('GET', `/servers/${s.id}/audit-log`);
  if (!rows.length) return el('p', { class: 'muted' }, 'Nothing yet. Moderator actions will show up here for 90 days.');
  return el('div', {}, rows.map((a) => el('div', { class: 'list-row' },
    el('div', {}, el('strong', {}, a.actor), ' ', AUDIT_LABELS[a.action] || a.action, ' ', a.targetName ? el('strong', {}, a.targetName) : '',
      a.reason ? el('div', { class: 'muted small' }, `Reason: ${a.reason}`) : null),
    el('span', { class: 'spacer' }), el('span', { class: 'muted small' }, fmtTime(a.createdAt)))));
}

function evidenceView(ev) {
  if (!ev) return el('p', { class: 'muted small' }, 'No preserved content.');
  if (ev.message) {
    return el('div', { class: 'evidence' },
      el('div', { class: 'muted small' }, `${ev.message.author} in ${ev.channel} · ${fmtTime(ev.message.createdAt)}`),
      el('div', { class: 'body', html: renderMarkdown(ev.message.content || '(no text)') }),
      ev.message.attachments && ev.message.attachments.length ? el('div', { class: 'muted small' }, `${ev.message.attachments.length} attachment(s) preserved`) : null);
  }
  if (ev.user) return el('div', { class: 'evidence' }, `User @${ev.user.username} (${ev.user.displayName})`);
  if (ev.server) return el('div', { class: 'evidence' }, `Server "${ev.server.name}" owned by @${ev.server.owner}`);
  return el('pre', {}, JSON.stringify(ev, null, 2));
}

async function reportsTab(s) {
  const wrap = el('div', { style: { display: 'grid', gap: '10px' } });
  let closed = false;
  const toggle = el('button', { class: 'btn' }, 'Show closed');
  const list = el('div');
  const draw = async () => {
    const rows = await api('GET', `/servers/${s.id}/reports${closed ? '?status=closed' : ''}`);
    toggle.textContent = closed ? 'Show open' : 'Show closed';
    list.replaceChildren(...(rows.length ? rows.map((r) => {
      const note = el('input', { placeholder: 'Note (optional)', maxlength: 300 });
      const resolve = async (action, extra = {}) => {
        try { await api('POST', `/servers/${s.id}/reports/${r.id}/resolve`, { action, note: note.value, ...extra }); draw(); }
        catch (e) { toast(e.message); }
      };
      return el('div', { class: 'report-card' },
        el('div', { class: 'row', style: { justifyContent: 'space-between' } },
          el('strong', {}, r.categoryLabel), el('span', { class: 'muted small' }, `${r.reporter || 'someone'} · ${fmtTime(r.createdAt)}`)),
        el('div', { class: 'muted small' }, `About @${r.targetUser || 'unknown'}`, r.details ? ` — “${r.details}”` : ''),
        evidenceView(r.evidence),
        r.status === 'open' ? el('div', { style: { display: 'grid', gap: '8px' } }, note,
          el('div', { class: 'row', style: { justifyContent: 'flex-start' } },
            el('button', { class: 'btn', onclick: () => resolve('dismiss') }, 'Dismiss'),
            r.targetType === 'message' && r.contentStillExists && can(P.MANAGE_MESSAGES, s) ? el('button', { class: 'btn', onclick: () => resolve('delete_message') }, 'Delete message') : null,
            can(P.MODERATE_MEMBERS, s) ? el('button', { class: 'btn', onclick: () => resolve('timeout', { minutes: 60 }) }, 'Timeout 1h') : null,
            can(P.KICK_MEMBERS, s) ? el('button', { class: 'btn', onclick: () => resolve('kick') }, 'Kick') : null,
            can(P.BAN_MEMBERS, s) ? el('button', { class: 'btn danger', onclick: () => resolve('ban') }, 'Ban')
              : null))
          : el('div', { class: 'muted small' }, `${r.status} by ${r.handledBy || '?'}: ${r.resolution || ''}`));
    }) : [el('p', { class: 'muted' }, closed ? 'No closed reports.' : 'No open reports. Nice.')]));
  };
  toggle.onclick = () => { closed = !closed; draw(); };
  wrap.append(el('div', { class: 'row', style: { justifyContent: 'space-between' } },
    el('p', { class: 'muted small', style: { margin: 0 } }, 'Reports from members of this server. Child-safety reports go only to the Hearth safety team.'), toggle), list);
  await draw();
  return wrap;
}

// ================================================================ channel settings
function channelModal(s, type, existing, parentId) {
  const [lblName, name] = field('Channel name', { maxlength: 64, value: existing ? existing.name : '' });
  const [lblTopic, topic] = field('Topic (optional)', { maxlength: 256, value: existing ? existing.topic : '' });
  const slow = el('select', {}, [[0, 'Off'], [5, '5 seconds'], [30, '30 seconds'], [60, '1 minute'], [300, '5 minutes'], [900, '15 minutes'], [3600, '1 hour']]
    .map(([v, l]) => el('option', { value: v, selected: existing && existing.slowmode === v }, l)));
  const age = el('select', {}, [[0, 'Everyone (13+)'], [18, '18+ only (adult content)'], [21, '21+ only (alcohol, cannabis, gambling)']]
    .map(([v, l]) => el('option', { value: v, selected: existing && existing.ageRating === v }, l)));
  const cats = s.channels.filter((c) => c.type === 'category');
  const parentSel = el('select', {}, el('option', { value: '' }, 'No category'),
    cats.map((c) => el('option', { value: c.id, selected: (existing ? existing.parentId : parentId) === c.id }, c.name)));
  const err = el('p', { class: 'error' });

  const canPerms = can(P.MANAGE_ROLES, s);
  const perms = canPerms ? overrideEditor(s, type, existing) : null;
  const permBox = perms ? perms.node : null;
  const applyPerms = async (channelId) => { if (perms) await perms.apply(channelId); };
  const openUp = el('input', { type: 'checkbox' });
  const pendingBox = existing && existing.pendingReview ? el('div', { class: 'review-banner', style: { margin: 0 } },
    el('strong', {}, 'Hidden from members'),
    el('div', { class: 'muted' }, 'This channel came from an import. Set who can see it below, then open it up.'),
    el('label', { class: 'check', style: { marginTop: '6px' } }, openUp, 'Open this channel to members when I save')) : null;
  const save = async () => {
    err.textContent = '';
    try {
      const patch = { name: name.value, ageRating: Number(age.value), slowmode: Number(slow.value), parentId: parentSel.value || null };
      if (type === 'text') patch.topic = topic.value;
      let id;
      if (openUp.checked) { await applyPerms(existing.id); patch.pendingReview = false; }
      if (existing) { await api('PATCH', `/channels/${existing.id}`, patch); id = existing.id; }
      else {
        const c = await api('POST', `/servers/${s.id}/channels`, { name: name.value, type, topic: topic.value, parentId: parentSel.value || null });
        id = c.id;
        if (patch.ageRating || patch.slowmode) await api('PATCH', `/channels/${id}`, patch);
      }
      await applyPerms(id);
      dlg.close();
      if (!existing && type === 'text') selectChannel(id);
    } catch (e) { err.textContent = e.message; }
  };
  const del = async () => {
    dlg.close();
    dangerDialog({
      title: `Delete #${existing.name}?`,
      lines: ['Every message and file in this channel will be removed for everyone.'],
      confirmText: existing.name, confirmLabel: 'Delete channel',
      run: () => api('DELETE', `/channels/${existing.id}`),
    });
  };
  name.addEventListener('keydown', (e) => e.key === 'Enter' && save());
  const dlg = modal([
    el('h2', {}, existing ? 'Edit channel' : `Create ${type} channel`), lblName, type === 'text' ? lblTopic : null,
    cats.length ? el('label', {}, 'Category', parentSel) : null,
    type === 'text' ? el('label', {}, 'Slowmode', slow) : null,
    el('label', {}, 'Who can view it', age),
    pendingBox, permBox, err,
    el('div', { class: 'row' },
      existing ? el('button', { class: 'btn danger', onclick: del, style: { marginRight: 'auto' } }, 'Delete') : null,
      el('button', { class: 'btn', onclick: () => dlg.close() }, 'Cancel'),
      el('button', { class: 'btn primary', onclick: save }, existing ? 'Save' : 'Create')),
  ]);
}


// ================================================================ Hearth admin panel
function updateAdminButton() {
  let b = $('admin-btn');
  if (S.me && S.me.isAdmin) {
    if (!b) {
      b = el('button', { class: 'rail-btn admin', id: 'admin-btn', title: 'Hearth admin', onclick: adminPanel }, '\u{1F6E1}');
      $('rail').insertBefore(b, $('add-server-btn'));
    }
  } else if (b) b.remove();
}

function askReason(title, hint) {
  return new Promise((resolve) => {
    const r = el('textarea', { rows: 2, maxlength: 1000, placeholder: hint || 'Why you need this (recorded in the admin log)' });
    let done = false;
    const finish = (v) => { if (!done) { done = true; dlg.close(); resolve(v); } };
    const dlg = modal([el('h2', {}, title), r, el('div', { class: 'row' },
      el('button', { class: 'btn', onclick: () => finish(null) }, 'Cancel'),
      el('button', { class: 'btn primary', onclick: () => finish(r.value.trim()) }, 'Continue'))],
    { onClose: () => { if (!done) { done = true; resolve(null); } } });
  });
}

function adminPanel() {
  const tabs = [['reports', 'Reports'], ['users', 'Users'], ['holds', 'Legal holds'], ['vault', 'Retention vault'], ['log', 'Admin log']];
  const body = el('div');
  const tabBar = el('div', { class: 'tabs', style: { overflowX: 'auto' } });
  const show = async (key) => {
    tabBar.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.k === key));
    body.replaceChildren(el('p', { class: 'muted' }, 'Loading…'));
    try { body.replaceChildren(await ({ reports: adminReports, users: adminUsers, holds: adminHolds, vault: adminVault, log: adminLog })[key](show)); }
    catch (e) { body.replaceChildren(el('p', { class: 'error' }, e.message)); }
  };
  for (const [k, l] of tabs) tabBar.append(el('button', { 'data-k': k, onclick: () => show(k) }, l));
  modal([el('h2', {}, 'Hearth admin'),
    el('p', { class: 'muted small', style: { margin: 0 } }, 'Platform-wide safety tools. Everything you open or do here is recorded in the admin log.'),
    tabBar, body], { wide: true });
  show('reports');
}

async function adminReports() {
  const wrap = el('div', { style: { display: 'grid', gap: '10px' } });
  let closed = false;
  const draw = async () => {
    const rows = await api('GET', `/admin/reports${closed ? '?status=closed' : ''}`);
    wrap.replaceChildren(el('div', { class: 'row' }, el('button', { class: 'btn', onclick: () => { closed = !closed; draw(); } }, closed ? 'Show open' : 'Show closed')),
      ...(rows.length ? rows.map((r) => {
        const note = el('input', { placeholder: 'Note', maxlength: 500 });
        const tip = el('input', { placeholder: 'NCMEC CyberTipline report number', maxlength: 64 });
        const act = async (action) => {
          if (r.category === 'child_safety' && action !== 'dismiss' && !tip.value.trim()
            && !(await confirmDialog('No CyberTipline number', 'Child sexual abuse material must be reported to NCMEC. Continue without recording a report number?', 'Continue'))) return;
          try { await api('POST', `/admin/reports/${r.id}/resolve`, { action, note: note.value, ncmecReportId: tip.value.trim() }); draw(); }
          catch (e) { toast(e.message); }
        };
        return el('div', { class: 'report-card' + (r.category === 'child_safety' ? ' urgent' : '') },
          el('div', { class: 'row', style: { justifyContent: 'space-between' } }, el('strong', {}, r.categoryLabel),
            el('span', { class: 'muted small' }, `${r.reporter || 'someone'} · ${fmtTime(r.createdAt)}`)),
          el('div', { class: 'muted small' }, `${r.targetType} · about @${r.targetUser || 'unknown'}`, r.details ? ` — “${r.details}”` : ''),
          evidenceView(r.evidence),
          r.category === 'child_safety' && r.status === 'open' ? el('div', { class: 'danger-box' },
            el('strong', {}, 'Legal duty: report to NCMEC'),
            el('p', {}, 'US law (18 U.S.C. 2258A) requires reporting apparent child sexual abuse material to the NCMEC CyberTipline as soon as reasonably possible. File at report.cybertip.org, then record the report number here. Do not download, copy or share the material. The evidence is preserved for 1 year automatically.'),
            tip) : null,
          r.status === 'open' ? el('div', { style: { display: 'grid', gap: '8px' } }, note, el('div', { class: 'row', style: { justifyContent: 'flex-start' } },
            el('button', { class: 'btn', onclick: () => act('dismiss') }, 'Dismiss'),
            r.targetType === 'message' && r.contentStillExists ? el('button', { class: 'btn', onclick: () => act('remove_content') }, 'Remove message') : null,
            r.targetUserId ? el('button', { class: 'btn danger', onclick: () => act('suspend_user') }, 'Suspend account') : null,
            r.targetType === 'server' ? el('button', { class: 'btn danger', onclick: () => act('delete_server') }, 'Delete server') : null))
            : el('div', { class: 'muted small' }, `${r.status} by ${r.handledBy || '?'}: ${r.resolution || ''}`));
      }) : [el('p', { class: 'muted' }, closed ? 'No closed reports.' : 'No open reports.')]));
  };
  await draw();
  return wrap;
}

async function adminUsers() {
  const q = el('input', { placeholder: 'Search by username or ID' });
  const list = el('div', { style: { marginTop: '10px' } });
  const draw = async () => {
    const rows = await api('GET', `/admin/users?q=${encodeURIComponent(q.value.trim())}`);
    list.replaceChildren(...rows.map((u) => el('div', { class: 'list-row', style: { flexWrap: 'wrap' } },
      el('div', {}, el('strong', {}, u.displayName, u.isAdmin ? ' (admin)' : ''), el('div', { class: 'muted small' },
        `@${u.username} · joined ${new Date(u.createdAt).toLocaleDateString()} · ${u.servers} servers · email ${u.hasEmail ? (u.emailVerified ? 'verified' : 'unverified') : 'none'}`,
        u.suspendedAt ? ` · SUSPENDED: ${u.suspendedReason || ''}` : '')),
      el('span', { class: 'spacer' }),
      el('button', { class: 'btn', onclick: async () => {
        const why = await askReason('Reveal email address'); if (!why) return;
        try { const r = await api('POST', `/admin/users/${u.id}/reveal-email`, { reason: why }); toast(r.email || 'No email on file.'); } catch (e) { toast(e.message); }
      } }, 'Email'),
      el('button', { class: 'btn', onclick: async () => {
        const why = await askReason('Reset date of birth', 'Reason, e.g. user proved a typo with ID'); if (!why) return;
        await api('POST', `/admin/users/${u.id}/birthdate-reset`, { reason: why }).catch((e) => toast(e.message)); toast('Birth date cleared; they can set it again.');
      } }, 'Reset DOB'),
      u.id === S.me.id ? null : el('button', { class: 'btn', onclick: async () => {
        await api('POST', `/admin/users/${u.id}/admin`, { isAdmin: !u.isAdmin }).catch((e) => toast(e.message)); draw();
      } }, u.isAdmin ? 'Remove admin' : 'Make admin'),
      u.id === S.me.id ? null : el('button', { class: 'btn danger', onclick: async () => {
        if (u.suspendedAt) { await api('POST', `/admin/users/${u.id}/unsuspend`).catch((e) => toast(e.message)); return draw(); }
        const why = await askReason(`Suspend @${u.username}`, 'Reason (shown to them when they try to log in)'); if (!why) return;
        await api('POST', `/admin/users/${u.id}/suspend`, { reason: why }).catch((e) => toast(e.message)); draw();
      } }, u.suspendedAt ? 'Unsuspend' : 'Suspend'))));
  };
  q.addEventListener('keydown', (e) => e.key === 'Enter' && draw());
  await draw();
  return el('div', {}, q, list);
}

async function adminHolds() {
  const wrap = el('div', { style: { display: 'grid', gap: '10px' } });
  const type = el('select', {}, el('option', { value: 'user' }, 'User'), el('option', { value: 'server' }, 'Server'));
  const target = el('input', { placeholder: 'Username or ID' });
  const reason = el('input', { placeholder: 'Legal basis, e.g. "2703(f) preservation request, case #123"', maxlength: 1000 });
  const list = el('div');
  const draw = async () => {
    const rows = await api('GET', '/admin/holds');
    list.replaceChildren(...(rows.length ? rows.map((h) => el('div', { class: 'list-row' },
      el('div', {}, el('strong', {}, `${h.targetType}: ${h.label || h.targetId}`), el('div', { class: 'muted small' }, `${h.reason} · placed ${fmtTime(h.createdAt)}${h.releasedAt ? ` · released ${fmtTime(h.releasedAt)}` : ''}`)),
      el('span', { class: 'spacer' }),
      h.releasedAt ? null : el('button', { class: 'btn', onclick: async () => { await api('DELETE', `/admin/holds/${h.id}`); draw(); } }, 'Release')))
      : [el('p', { class: 'muted' }, 'No legal holds.')]));
  };
  wrap.append(
    el('p', { class: 'muted small', style: { margin: 0 } }, 'A legal hold stops the retention vault from erasing anything belonging to that user or server until you release it. Use it when you receive a preservation request from law enforcement or expect legal action.'),
    el('div', { class: 'row', style: { justifyContent: 'flex-start', flexWrap: 'wrap' } }, type, target, reason,
      el('button', { class: 'btn primary', onclick: async () => {
        try { await api('POST', '/admin/holds', { targetType: type.value, targetId: target.value.trim(), reason: reason.value }); target.value = ''; reason.value = ''; draw(); }
        catch (e) { toast(e.message); }
      } }, 'Place hold')), list);
  await draw();
  return wrap;
}

async function adminVault() {
  const q = el('input', { placeholder: 'Username, user ID, or leave empty for recent' });
  const list = el('div', { style: { marginTop: '10px' } });
  const draw = async () => {
    const v = q.value.trim();
    const rows = await api('GET', `/admin/vault${v ? (/^\d+$/.test(v) ? `?user=${v}` : `?user=${encodeURIComponent(v)}`) : ''}`);
    list.replaceChildren(...(rows.length ? rows.map((it) => el('div', { class: 'list-row' },
      el('div', {}, el('strong', {}, it.label || it.kind), el('div', { class: 'muted small' },
        `${it.kind} · stored ${fmtTime(it.createdAt)} · ${it.held ? 'ON LEGAL HOLD' : `erased ${new Date(it.purgeAt).toLocaleDateString()}`}${it.files.length ? ` · ${it.files.length} file(s)` : ''}`)),
      el('span', { class: 'spacer' }),
      el('button', { class: 'btn', onclick: async () => {
        const why = await askReason('Open preserved data'); if (!why) return;
        try {
          const item = await api('POST', `/admin/vault/${it.id}/open`, { reason: why });
          modal([el('h2', {}, item.label || item.kind),
            el('pre', { style: { maxHeight: '50vh', overflow: 'auto', background: 'var(--bg-0)', padding: '10px', borderRadius: '6px', whiteSpace: 'pre-wrap' } }, JSON.stringify(item.data, null, 2)),
            item.files.length ? el('div', {}, item.files.map((f) => el('div', {}, el('a', { href: `/api/admin/vault/${it.id}/files/${f.n}` }, `Download ${f.name} (${fmtSize(f.size)})`)))) : null], { wide: true });
        } catch (e) { toast(e.message); }
      } }, 'Open')))
      : [el('p', { class: 'muted' }, 'Nothing stored.')]));
  };
  q.addEventListener('keydown', (e) => e.key === 'Enter' && draw());
  await draw();
  return el('div', {}, el('p', { class: 'muted small', style: { margin: '0 0 8px' } }, 'Deleted content is kept here encrypted for 30 days (report evidence for 1 year) and then erased automatically, unless a legal hold applies. Only open it for safety or legal reasons.'), q, list);
}

async function adminLog() {
  const rows = await api('GET', '/admin/log');
  return el('div', {}, rows.map((l) => el('div', { class: 'list-row' },
    el('div', {}, el('strong', {}, l.admin), ' ', l.action, ' ', el('span', { class: 'muted' }, l.target || ''), l.detail ? el('div', { class: 'muted small' }, l.detail) : null),
    el('span', { class: 'spacer' }), el('span', { class: 'muted small' }, fmtTime(l.createdAt)))));
}


// ================================================================ slash commands
const COMMANDS = [
  { name: 'help', desc: 'Show all commands' },
  { name: 'me', args: '<action>', desc: 'Say what you’re doing, like /me grabs snacks' },
  { name: 'gif', args: '[search]', desc: 'Search for a GIF and send it' },
  { name: 'shrug', args: '[text]', desc: 'Add ¯\\_(ツ)_/¯ to a message' },
  { name: 'tableflip', args: '[text]', desc: 'Flip a table (╯°□°)╯︵ ┻━┻' },
  { name: 'unflip', args: '[text]', desc: 'Put it back ┬─┬ノ( º _ ºノ)' },
  { name: 'roll', args: '[dice]', desc: 'Roll dice: d20, 2d6, 3d8+2' },
  { name: 'flip', desc: 'Flip a coin' },
  { name: 'nick', args: '[name]', desc: 'Change your nickname in this server (empty to reset)', server: true },
  { name: 'invite', desc: 'Copy an invite link for this server', server: true, perm: P.CREATE_INVITE },
  { name: 'report', args: '@user', desc: 'Report someone to the moderators' },
  { name: 'block', args: '@user', desc: 'Block or unblock someone' },
  { name: 'timeout', args: '@user <minutes> [reason]', desc: 'Stop someone posting for a while', server: true, perm: P.MODERATE_MEMBERS },
  { name: 'kick', args: '@user [reason]', desc: 'Remove someone from the server', server: true, perm: P.KICK_MEMBERS },
  { name: 'ban', args: '@user [reason]', desc: 'Ban someone from the server', server: true, perm: P.BAN_MEMBERS },
  { name: 'slowmode', args: '<seconds | off>', desc: 'Limit how often people can post here', server: true, perm: P.MANAGE_CHANNELS },
  { name: 'purge', args: '<count>', desc: 'Delete the last 1–100 messages here', server: true, perm: P.MANAGE_MESSAGES },
];
const availableCommands = () => COMMANDS.filter((c) => (!c.server || S.serverId) && (!c.perm || (S.serverId && can(c.perm))));

let cmdIndex = 0;
function commandMatches() {
  const v = input.value;
  if (!v.startsWith('/') || /\s/.test(v)) return [];
  const q = v.slice(1).toLowerCase();
  return availableCommands().filter((c) => c.name.startsWith(q));
}
function hideCommandMenu() { const m = $('cmd-menu'); if (m) m.remove(); }
function updateCommandMenu() {
  const list = commandMatches();
  hideCommandMenu();
  if (!list.length) return;
  cmdIndex = Math.min(cmdIndex, list.length - 1);
  const menu = el('div', { id: 'cmd-menu', class: 'cmd-menu', role: 'listbox' }, list.map((c, i) =>
    el('div', { class: 'cmd' + (i === cmdIndex ? ' on' : ''), onmousedown: (e) => { e.preventDefault(); pickCommand(c); } },
      el('span', { class: 'cmd-name' }, `/${c.name}`, c.args ? el('span', { class: 'muted' }, ` ${c.args}`) : null),
      el('span', { class: 'muted small' }, c.desc))));
  $('composer').prepend(menu);
}
function pickCommand(c) {
  input.value = `/${c.name}${c.args ? ' ' : ''}`;
  hideCommandMenu();
  input.focus();
  if (!c.args) $('composer').requestSubmit();
}
function commandMenuKey(e) {
  const list = commandMatches();
  if (!list.length || !$('cmd-menu')) return false;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    cmdIndex = (cmdIndex + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length;
    updateCommandMenu();
    return true;
  }
  if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) { e.preventDefault(); pickCommand(list[cmdIndex]); return true; }
  if (e.key === 'Escape') { hideCommandMenu(); return true; }
  return false;
}

// Find a member from "@name", a username, or a display name/nickname.
function findMember(token) {
  const t = String(token || '').replace(/^@/, '').toLowerCase();
  if (!t) return null;
  const srv = server();
  const pool = srv ? srv.members.map((m) => ({ user: m.user, nick: m.nickname }))
    : (findChannel(S.channelId)?.recipients || []).map((u) => ({ user: u }));
  const hit = pool.find((p) => p.user.username.toLowerCase() === t)
    || pool.find((p) => (p.nick || '').toLowerCase() === t || p.user.displayName.toLowerCase() === t);
  return hit ? hit.user : null;
}

async function runCommand(text) {
  const m = /^\/(\S+)\s*([\s\S]*)$/.exec(text);
  if (!m) return false;
  const name = m[1].toLowerCase();
  const rest = m[2].trim();
  const cmd = availableCommands().find((c) => c.name === name);
  if (!cmd) {
    if (COMMANDS.some((c) => c.name === name)) { toast(`You can’t use /${name} here.`); return true; }
    return false; // not a command: send as a normal message
  }
  const chan = S.channelId;
  const say = (content, extra = {}) => api('POST', `/channels/${chan}/messages`, { content, ...extra });
  const needUser = () => {
    const [who, ...more] = rest.split(/\s+/);
    const u = findMember(who);
    if (!u) throw new Error(who ? `No member called ${who}.` : 'Name someone, like @username.');
    return { u, more };
  };
  try {
    switch (name) {
      case 'help':
        modal([el('h2', {}, 'Commands'), el('div', {}, availableCommands().map((c) =>
          el('div', { class: 'list-row' }, el('code', {}, `/${c.name}${c.args ? ' ' + c.args : ''}`), el('span', { class: 'muted small' }, c.desc))))]);
        break;
      case 'me': if (!rest) throw new Error('Try /me waves.'); await say(rest, { kind: 'me' }); break;
      case 'gif':
        if (!S.gifs) throw new Error('GIFs aren\u2019t set up on this Hearth yet. The admin adds a GIPHY key to turn them on.');
        gifPicker(rest); break;
      case 'shrug': await say(`${rest} ¯\\_(ツ)_/¯`.trim()); break;
      case 'tableflip': await say(`${rest} (╯°□°)╯︵ ┻━┻`.trim()); break;
      case 'unflip': await say(`${rest} ┬─┬ノ( º _ ºノ)`.trim()); break;
      case 'roll': await api('POST', `/channels/${chan}/roll`, { dice: rest || 'd6' }); break;
      case 'flip': await api('POST', `/channels/${chan}/flip`); break;
      case 'nick': await api('PATCH', `/servers/${S.serverId}/members/@me`, { nickname: rest }); toast(rest ? `Nickname set to ${rest}.` : 'Nickname reset.'); break;
      case 'invite': {
        const inv = await api('POST', `/servers/${S.serverId}/invites`, { expiresInHours: 168 });
        const link = `${location.origin}/invite/${inv.code}`;
        await navigator.clipboard.writeText(link).then(() => toast('Invite link copied (expires in 7 days).'), () => toast(link));
        break;
      }
      case 'report': { const { u } = needUser(); reportModal({ targetType: 'user', targetId: u.id, serverId: S.serverId, label: u.displayName }); break; }
      case 'block': { const { u } = needUser(); await toggleBlock(u); break; }
      case 'timeout': {
        const { u, more } = needUser();
        const minutes = Number(more[0]);
        if (!minutes) throw new Error('Say how many minutes, like /timeout @name 10 spamming.');
        await api('PUT', `/servers/${S.serverId}/members/${u.id}/timeout`, { minutes, reason: more.slice(1).join(' ') });
        toast(`${u.displayName} is timed out for ${minutes} minutes.`);
        break;
      }
      case 'kick': case 'ban': {
        const { u, more } = needUser();
        if (!(await confirmDialog(`${name === 'ban' ? 'Ban' : 'Kick'} ${u.displayName}?`, name === 'ban' ? 'They won’t be able to rejoin.' : 'They can rejoin with an invite.', name === 'ban' ? 'Ban' : 'Kick'))) break;
        const reason = more.join(' ');
        if (name === 'ban') await api('PUT', `/servers/${S.serverId}/bans/${u.id}`, { reason });
        else await api('DELETE', `/servers/${S.serverId}/members/${u.id}`, { reason });
        toast(`${u.displayName} was ${name === 'ban' ? 'banned' : 'kicked'}.`);
        break;
      }
      case 'slowmode': {
        const secs = /^off$/i.test(rest) ? 0 : Number(rest);
        if (!Number.isFinite(secs) || secs < 0) throw new Error('Use /slowmode 10 or /slowmode off.');
        await api('PATCH', `/channels/${chan}`, { slowmode: secs });
        toast(secs ? `Slowmode: one message every ${secs} seconds.` : 'Slowmode off.');
        break;
      }
      case 'purge': {
        const n = Number(rest);
        if (!n || n < 1 || n > 100) throw new Error('Use /purge 1 to /purge 100.');
        if (!(await confirmDialog(`Delete the last ${n} messages?`, 'They’re removed for everyone right away.', 'Delete'))) break;
        const r = await api('POST', `/channels/${chan}/purge`, { count: n });
        toast(`Deleted ${r.deleted} messages.`);
        break;
      }
      default: return false;
    }
  } catch (err) {
    toast(err.message);
  }
  return true;
}


// ================================================================ welcome, tour, help
const isPhone = () => window.matchMedia('(max-width: 860px)').matches;
const onboardKey = () => `hearth_onboarded_${S.me.id}`;
let welcomed = false;

function maybeWelcome() {
  if (welcomed) return;
  welcomed = true;
  try { if (localStorage.getItem(onboardKey())) return; } catch { return; }
  setTimeout(() => {
    if (document.querySelector('.modal-backdrop')) { welcomed = false; setTimeout(maybeWelcome, 1000); return; } // wait for other popups
    let done = false;
    const close = (tour) => {
      if (done) return;
      done = true;
      try { localStorage.setItem(onboardKey(), '1'); } catch { /* ignore */ }
      dlg.close();
      if (tour) runTour();
    };
    const dlg = modal([
      el('div', { class: 'welcome-hero' }, el('img', { src: '/icon.svg', alt: '' }),
        el('h2', {}, `Welcome to Hearth, ${S.me.displayName}`)),
      el('p', {}, 'Hearth is where your groups hang out: text channels, voice and video calls, screen sharing for games, and direct messages. Private by design, with no ads or tracking.'),
      el('p', { class: 'muted' }, 'Want a quick tour? It takes about a minute and shows where everything is.'),
      el('div', { class: 'row' },
        el('a', { class: 'btn', href: '/help.html', target: '_blank', style: { marginRight: 'auto' } }, 'Read the guide'),
        el('button', { class: 'btn', onclick: () => close(false) }, 'I’ll explore'),
        el('button', { class: 'btn primary', onclick: () => close(true) }, 'Show me around')),
    ], { onClose: () => close(false) });
  }, 1500);
}

function tourSteps() {
  const inServer = () => !!S.serverId;
  const manages = () => inServer() && (can(P.MANAGE_CHANNELS) || can(P.MANAGE_ROLES) || can(P.KICK_MEMBERS) || can(P.MANAGE_SERVER));
  return [
    { title: 'Welcome to Hearth', text: 'This quick tour shows the main parts of the screen. Use Next and Back, or the arrow keys. You can replay it anytime from the ? button at the bottom left.' },
    { nav: true, target: '#server-list', when: () => S.servers.size > 0, title: 'Your servers',
      text: 'Each cartridge on the left is a server you belong to: a group with its own channels, roles and members. Tap one to open it.' },
    { nav: true, target: '#add-server-btn', title: 'Create or join a server',
      text: 'Use + to start your own server or join one with an invite link. Invite links look like hearth-address/invite/abc123.' },
    { nav: true, target: '#home-btn', title: 'Direct messages',
      text: 'The flame takes you to your direct messages: private one-on-one chats and calls. Start one with the + next to "Direct messages", or tap someone’s name.' },
    { nav: true, target: '#channel-list', title: 'Channels',
      text: 'Channels starting with # are for text. Ones with a speaker are voice channels: tap one to jump into a voice call, and tap again to see everyone’s video and screen shares.',
      tip: 'A lock means the channel is age-restricted; 18+ and 21+ channels only appear for people old enough.' },
    { target: '#composer', when: () => !!S.channelId, title: 'Send messages',
      text: 'Type here and press Enter. Shift+Enter makes a new line. Drag in or paste images and files. Hover a message to react, reply, edit or report it.',
      tip: 'Type / to see commands like /roll 2d6, /me, /shrug and more.' },
    { target: () => (isPhone() ? $('members-btn') : $('members')), when: () => inServer(), title: 'Members',
      text: 'See who’s online. Tap a person to message them, view their roles, or block or report them.' },
    { nav: true, target: '#server-settings-btn', when: manages, title: 'Running your server',
      text: 'The gear opens server settings: roles and permissions, private channels, members, timeouts and bans, reports from your members, and the audit log. The Server Admin guide explains everything.' },
    { nav: true, target: '#me-btn', title: 'Your profile',
      text: 'Change your name and picture, pick one of the retro color palettes with Dark, Grey or Light mode, set up account recovery, see signed-in devices, and download or delete your data.' },
    { nav: true, target: '#help-btn', title: 'Help is always here',
      text: 'Tap ? anytime to replay this tour or open the Getting Started and Server Admin guides.',
      finishLabel: S.servers.size ? 'Done' : 'PRESS START',
      onFinish: () => { if (!S.servers.size) addServerModal(); } },
  ];
}

function runTour() {
  startTour(tourSteps(), {
    onStepEnter: (s) => { if (isPhone()) $('app').classList.toggle('nav-open', !!s.nav); },
    onDone: () => { $('app').classList.remove('nav-open'); try { localStorage.setItem(onboardKey(), '1'); } catch { /* ignore */ } },
  });
}

function helpMenu() {
  const dlg = modal([
    el('h2', {}, 'Help'),
    el('div', { class: 'choice' },
      el('button', { onclick: () => { dlg.close(); runTour(); } }, el('strong', {}, 'Take the tour'), el('div', { class: 'muted small' }, 'A one-minute walkthrough of the screen.')),
      el('button', { onclick: () => window.open('/help.html', '_blank') }, el('strong', {}, 'Getting Started guide'), el('div', { class: 'muted small' }, 'Everything you can do on Hearth, step by step.')),
      el('button', { onclick: () => window.open('/admin-guide.html', '_blank') }, el('strong', {}, 'Server Admin guide'), el('div', { class: 'muted small' }, 'Roles, permissions, private channels, moderation and reports.')),
      el('button', { onclick: () => { dlg.close(); runCommand('/help'); } }, el('strong', {}, 'Slash commands'), el('div', { class: 'muted small' }, 'Shortcuts you can type in any chat.'))),
    el('p', { class: 'muted small', style: { margin: 0 } }, el('a', { href: '/privacy.html', target: '_blank' }, 'Privacy'), ' · ', el('a', { href: '/terms.html', target: '_blank' }, 'Terms')),
  ]);
}
$('help-btn').onclick = helpMenu;

function categoryModal(s, existing) {
  const [lbl, name] = field('Category name', { maxlength: 64, value: existing ? existing.name : '' });
  const err = el('p', { class: 'error' });
  const save = async () => {
    try {
      if (existing) await api('PATCH', `/channels/${existing.id}`, { name: name.value });
      else await api('POST', `/servers/${s.id}/channels`, { name: name.value, type: 'category' });
      dlg.close();
    } catch (e) { err.textContent = e.message; }
  };
  name.addEventListener('keydown', (e) => e.key === 'Enter' && save());
  const dlg = modal([
    el('h2', {}, existing ? 'Edit category' : 'New category'), lbl,
    el('p', { class: 'muted small', style: { margin: 0 } }, 'Categories group channels in the list. Put a channel in a category from that channel’s settings.'),
    err,
    el('div', { class: 'row' },
      existing ? el('button', { class: 'btn danger', style: { marginRight: 'auto' }, onclick: async () => {
        if (!(await confirmDialog('Delete category', `Delete "${existing.name}"? Its channels stay; they just won’t be grouped.`, 'Delete'))) return;
        try { await api('DELETE', `/channels/${existing.id}`); dlg.close(); } catch (e) { err.textContent = e.message; }
      } }, 'Delete') : null,
      el('button', { class: 'btn', onclick: () => dlg.close() }, 'Cancel'),
      el('button', { class: 'btn primary', onclick: save }, existing ? 'Save' : 'Create')),
  ]);
}


// ---------------------------------------------------------------- channel permissions
// Discord-style per-channel overrides: for each role, every permission is
// Allow (✓), Deny (✕) or "use the role's normal setting" (/).
const CHANNEL_PERMS = {
  text: [[P.VIEW_CHANNELS, 'View channel', 'See the channel and read its messages'], [P.SEND_MESSAGES, 'Send messages'],
    [P.ATTACH_FILES, 'Attach files'], [P.ADD_REACTIONS, 'Add reactions'], [P.MANAGE_MESSAGES, 'Manage messages', 'Delete other people’s messages'],
    [P.MANAGE_CHANNELS, 'Manage channel'], [P.CREATE_INVITE, 'Create invite']],
  voice: [[P.VIEW_CHANNELS, 'View channel'], [P.CONNECT, 'Connect'], [P.SPEAK, 'Speak'], [P.VIDEO, 'Video & screen share'],
    [P.MANAGE_CHANNELS, 'Manage channel'], [P.CREATE_INVITE, 'Create invite']],
};

function overrideEditor(s, type, existing) {
  const everyone = s.roles.find((r) => r.isDefault);
  const original = new Map();
  for (const o of (existing && existing.overrides) || []) if (o.type === 'role') original.set(o.id, { allow: o.allow, deny: o.deny });
  const model = new Map([...original].map(([k, v]) => [k, { ...v }]));
  const get = (id) => model.get(id) || { allow: 0, deny: 0 };
  const top = myTop(s);
  const editable = (r) => r.isDefault || r.position < top;
  let selected = everyone.id;

  const isPrivate = el('input', { type: 'checkbox' });
  const sync = () => { isPrivate.checked = !!(get(everyone.id).deny & P.VIEW_CHANNELS); };
  isPrivate.onchange = () => {
    const o = { ...get(everyone.id) };
    if (isPrivate.checked) { o.deny |= P.VIEW_CHANNELS; o.allow &= ~P.VIEW_CHANNELS; } else o.deny &= ~P.VIEW_CHANNELS;
    model.set(everyone.id, o);
    if (selected === everyone.id) draw();
  };
  const roleList = el('div', { class: 'ov-roles' });
  const grid = el('div', { class: 'ov-grid' });
  const adder = el('select', { class: 'ov-add' });
  adder.onchange = () => { if (adder.value) { model.set(adder.value, get(adder.value)); selected = adder.value; draw(); } };

  function draw() {
    sync();
    const shown = s.roles.filter((r) => r.isDefault || model.has(r.id)).sort((a, b) => (a.isDefault ? 1 : b.isDefault ? -1 : b.position - a.position));
    shown.unshift(...shown.splice(shown.indexOf(everyone), 1));
    roleList.replaceChildren(...shown.map((r) => el('button', {
      class: 'ov-role' + (r.id === selected ? ' active' : ''), type: 'button', onclick: () => { selected = r.id; draw(); },
      style: { color: r.color || '' },
    }, r.name, get(r.id).allow || get(r.id).deny ? el('span', { class: 'ov-dot' }) : null)));
    const rest = s.roles.filter((r) => !r.isDefault && !model.has(r.id)).sort((a, b) => b.position - a.position);
    adder.replaceChildren(el('option', { value: '' }, rest.length ? '+ Add a role…' : 'All roles added'), ...rest.map((r) => el('option', { value: r.id }, r.name)));
    adder.disabled = !rest.length;
    const role = s.roles.find((r) => r.id === selected) || everyone;
    const can = editable(role);
    const o = get(role.id);
    grid.replaceChildren(
      el('div', { class: 'ov-head' }, el('span', {}, role.isDefault ? 'Everyone (@everyone)' : role.name),
        can ? null : el('span', { class: 'muted small' }, 'Above your highest role: view only')),
      ...CHANNEL_PERMS[type === 'voice' ? 'voice' : 'text'].map(([bit, label, hint]) => {
        const state = o.deny & bit ? 'deny' : o.allow & bit ? 'allow' : 'inherit';
        const set = (st) => {
          const n = { allow: o.allow & ~bit, deny: o.deny & ~bit };
          if (st === 'allow') n.allow |= bit;
          if (st === 'deny') n.deny |= bit;
          model.set(role.id, n); draw();
        };
        const b = (st, txt, title) => el('button', { type: 'button', class: `ov-btn ${st}` + (state === st ? ' on' : ''), title, disabled: !can, onclick: () => set(st) }, txt);
        return el('div', { class: 'ov-row' }, el('div', {}, label, hint ? el('div', { class: 'muted small' }, hint) : null),
          el('div', { class: 'ov-tri' }, b('deny', '✕', 'Deny'), b('inherit', '/', 'Use the role’s normal setting'), b('allow', '✓', 'Allow')));
      }),
      role.isDefault ? null : el('button', { type: 'button', class: 'btn small', disabled: !can, onclick: () => { model.set(role.id, { allow: 0, deny: 0 }); if (!original.has(role.id)) model.delete(role.id); selected = everyone.id; draw(); } }, 'Remove this role’s overrides'));
  }
  draw();
  const node = el('div', { class: 'ov' },
    el('div', { class: 'ov-title' }, 'Permissions'),
    el('label', { class: 'check' }, isPrivate, 'Private channel: only roles you allow below can see it'),
    el('div', { class: 'ov-body' }, el('div', { class: 'ov-side' }, roleList, adder), grid),
    el('p', { class: 'muted small', style: { margin: 0 } }, 'Deny beats the role’s normal setting; Allow on a role beats a Deny on @everyone. Owners and Administrators always have access.'));
  async function apply(channelId) {
    for (const [id, o] of model) {
      const was = original.get(id) || { allow: 0, deny: 0 };
      if (was.allow === o.allow && was.deny === o.deny) continue;
      const r = s.roles.find((x) => x.id === id);
      if (!r || !editable(r)) continue;
      await api('PUT', `/channels/${channelId}/overrides/role/${id}`, { allow: o.allow, deny: o.deny });
    }
  }
  return { node, apply };
}

// Who can see a channel, in a few words.
function accessSummary(s, c) {
  const everyone = s.roles.find((r) => r.isDefault);
  const ov = (id) => (c.overrides || []).find((o) => o.type === 'role' && o.id === id) || { allow: 0, deny: 0 };
  const priv = ov(everyone.id).deny & P.VIEW_CHANNELS;
  const parts = [];
  if (priv) {
    const who = s.roles.filter((r) => !r.isDefault && ov(r.id).allow & P.VIEW_CHANNELS).map((r) => r.name);
    parts.push(who.length ? `Private: ${who.join(', ')}` : 'Private: owner & admins only');
  } else if (!(everyone.permissions & P.VIEW_CHANNELS)) parts.push('Only roles with View channels');
  else parts.push('Everyone');
  if (c.type === 'text' && ov(everyone.id).deny & P.SEND_MESSAGES) parts.push('read-only');
  if (c.ageRating) parts.push(`${c.ageRating}+`);
  return parts.join(' · ');
}

// After an import: go through the hidden channels and open them up.
function reviewModal(s0) {
  const list = el('div', { class: 'review-list' });
  const closeBtn = el('button', { class: 'btn', onclick: () => dlg.close() }, 'Done for now');
  const openAll = el('button', { class: 'btn primary', onclick: async () => {
    if (!(await confirmDialog('Open all channels?', 'Every hidden channel becomes visible to the members its permissions allow.', 'Open all'))) return;
    try { await api('POST', `/servers/${s0.id}/channels/open`, {}); } catch (e) { toast(e.message); }
  } }, 'Open all');
  const draw = () => {
    const s = S.servers.get(s0.id) || s0;
    const pending = s.channels.filter((c) => c.pendingReview);
    openAll.style.display = pending.length ? '' : 'none';
    closeBtn.textContent = pending.length ? 'Done for now' : 'Close';
    if (!pending.length) { list.replaceChildren(el('p', {}, '✔ All channels are open. Members can now see everything their roles allow.')); return; }
    const cats = new Map(s.channels.filter((c) => c.type === 'category').map((c) => [c.id, c.name]));
    list.replaceChildren(...pending.filter((c) => c.type !== 'category').map((c) => el('div', { class: 'review-row' },
      el('div', {}, el('strong', {}, (c.type === 'voice' ? '\u{1F50A} ' : '# ') + c.name),
        el('div', { class: 'muted small' }, (c.parentId && cats.get(c.parentId) ? cats.get(c.parentId) + ' · ' : '') + accessSummary(s, c))),
      el('div', { class: 'row', style: { margin: 0 } },
        el('button', { class: 'btn small', onclick: () => channelModal(s, c.type, c) }, 'Permissions'),
        el('button', { class: 'btn primary small', onclick: async () => {
          try { await api('PATCH', `/channels/${c.id}`, { pendingReview: false }); } catch (e) { toast(e.message); }
        } }, 'Open')))));
  };
  draw();
  const timer = setInterval(draw, 800); // reflect changes made in other dialogs
  const dlg = modal([
    el('h2', {}, 'Review imported channels'),
    el('p', { class: 'muted small', style: { margin: 0 } },
      'Permissions work differently here than on Discord, so imported channels start hidden. Roles came over with matching permissions; check them, set who can see each channel, then open it.'),
    el('div', { class: 'row', style: { justifyContent: 'flex-start', margin: 0 } },
      can(P.MANAGE_ROLES, s0) ? el('button', { class: 'btn small', onclick: () => serverSettingsModal(S.servers.get(s0.id) || s0, 'roles') }, 'Edit roles') : null),
    list,
    el('div', { class: 'row' }, closeBtn, openAll),
  ], { wide: true, onClose: () => clearInterval(timer) });
}


// ================================================================ Discord import wizard
// The bot token lives only in this variable (never in browser storage) and
// is sent to Hearth with each step.
const IMPORT = { token: '', info: null, guildId: null, preview: null, onJob: null };

function importWizard() {
  const body = el('div', { class: 'wiz' });
  const stepBar = el('ol', { class: 'wiz-steps' }, ['About', 'Create bot', 'Add bot', 'Choose', 'Confirm', 'Move'].map((t) => el('li', {}, t)));
  const dlg = modal([el('h2', {}, 'Move a server from Discord'), stepBar, body], { wide: true, onClose: () => { IMPORT.onJob = null; } });
  const mark = (n) => [...stepBar.children].forEach((li, i) => { li.className = i < n ? 'done' : i === n ? 'on' : ''; });
  const err = () => el('p', { class: 'error' });
  const nav = (...btns) => el('div', { class: 'row' }, ...btns);
  const btn = (label, onclick, cls = '') => el('button', { class: 'btn ' + cls, onclick }, label);
  const busy = async (b, fn) => { const t = b.textContent; b.disabled = true; b.textContent = 'Working…'; try { await fn(); } finally { b.disabled = false; b.textContent = t; } };
  const ext = (href, text) => el('a', { href, target: '_blank', rel: 'noopener noreferrer' }, text);

  // ---- 0. what this does
  function intro() {
    mark(0);
    body.replaceChildren(
      el('p', {}, 'This makes a ', el('strong', {}, 'new Hearth server'), ' that copies the setup of your Discord server, and the chat history you choose. Your Discord server isn’t changed.'),
      el('div', { class: 'wiz-cols' },
        el('div', { class: 'wiz-box ok' }, el('h3', {}, '✔ Comes over'), el('ul', {},
          el('li', {}, 'Server name and icon'),
          el('li', {}, 'Categories, text and voice channels, in order, with topics, slowmode and 18+ settings'),
          el('li', {}, 'Roles: names, colors, order and matching permissions'),
          el('li', {}, 'Who can see or post in each channel (role permissions)'),
          el('li', {}, 'Chat history for the channels you pick: text, replies, files, embeds and reaction counts'))),
        el('div', { class: 'wiz-box no' }, el('h3', {}, '✖ Doesn’t come over'), el('ul', {},
          el('li', {}, 'Members and their accounts (people join with an invite and start fresh)'),
          el('li', {}, 'Discord bots and their commands, webhooks and integrations'),
          el('li', {}, 'Threads, forum and media channels, pins, custom emoji and stickers (shown as text)'),
          el('li', {}, 'Per-person channel permissions, DMs, voice recordings')))),
      el('div', { class: 'wiz-box' }, el('h3', {}, 'How old messages look'),
        el('p', {}, 'Each message keeps the name and picture of whoever sent it on Discord, with an ', el('span', { class: 'tag archived-tag' }, 'ARCHIVED'),
          ' tag. Archived messages belong to no one on Hearth: if that person joins later, their new account starts fresh and can’t edit or claim them. Moderators can still delete them.'),
        el('p', { class: 'muted small' }, 'Imported channels start hidden from everyone but you, because permissions work a little differently here. You’ll review them and open them up at the end.')),
      el('p', { class: 'muted small' }, 'You’ll need: to be the owner or an admin of the Discord server, and about 5 minutes. Big servers can take a while to copy; you can close this window and it keeps going.'),
      nav(btn('Cancel', () => dlg.close()), btn('Let’s start', bot, 'primary')));
  }

  // ---- 1. create the bot and paste its token
  function bot() {
    mark(1);
    const tok = el('input', { type: 'password', placeholder: 'Paste the bot token here', autocomplete: 'off', spellcheck: 'false', value: IMPORT.token });
    const e = err();
    const check = btn('Check token', () => busy(check, async () => {
      e.textContent = '';
      try {
        IMPORT.token = tok.value.trim();
        IMPORT.info = await api('POST', '/imports/discord/inspect', { token: IMPORT.token });
        invite();
      } catch (x) { e.textContent = x.message; }
    }), 'primary');
    tok.addEventListener('keydown', (ev) => ev.key === 'Enter' && check.click());
    body.replaceChildren(
      el('p', {}, 'Hearth reads your server through a Discord ', el('em', {}, 'bot'), ' that you create. It can only look, not post or change anything.'),
      el('ol', { class: 'wiz-howto' },
        el('li', {}, 'Open the ', ext('https://discord.com/developers/applications', 'Discord Developer Portal'), ' and sign in. Click ', el('strong', {}, 'New Application'), ', name it something like "Hearth Mover", and create it.'),
        el('li', {}, 'Click ', el('strong', {}, 'Bot'), ' on the left. Under ', el('strong', {}, 'Privileged Gateway Intents'), ', turn on ', el('strong', {}, 'Message Content Intent'), ' and click ', el('strong', {}, 'Save Changes'), '. (Without it, Discord hides what messages say.)'),
        el('li', {}, 'On the same page click ', el('strong', {}, 'Reset Token'), ', confirm, then ', el('strong', {}, 'Copy'), '. Paste it below.')),
      el('div', { class: 'wiz-box warn' }, '\u{1F511} The token is like a password for the bot. Hearth only keeps it in memory while copying, never saves it, and you’ll reset it when you’re done.'),
      el('label', {}, 'Bot token', tok), e,
      nav(btn('Back', intro), check));
  }

  // ---- 2. add the bot to the Discord server, pick the server
  function invite() {
    mark(2);
    const info = IMPORT.info;
    const e = err();
    const list = el('div', { class: 'wiz-guilds' });
    const drawGuilds = () => list.replaceChildren(...(info.guilds.length ? info.guilds.map((g) => el('button', {
      class: 'wiz-guild' + (IMPORT.guildId === g.id ? ' on' : ''), onclick: () => { IMPORT.guildId = g.id; drawGuilds(); },
    }, el('span', { class: 'avatar', style: { background: colorFor(g.id) } }, initials(g.name)), g.name))
      : [el('p', { class: 'muted' }, 'The bot isn’t in any servers yet. Use the link above, then click Refresh.')]));
    const refresh = btn('Refresh', () => busy(refresh, async () => {
      try { IMPORT.info = await api('POST', '/imports/discord/inspect', { token: IMPORT.token }); Object.assign(info, IMPORT.info); drawGuilds(); } catch (x) { e.textContent = x.message; }
    }));
    const next = btn('Next', () => busy(next, async () => {
      e.textContent = '';
      if (!IMPORT.guildId) { e.textContent = 'Pick the server to move.'; return; }
      try { IMPORT.preview = await api('POST', '/imports/discord/preview', { token: IMPORT.token, guildId: IMPORT.guildId }); choose(); } catch (x) { e.textContent = x.message; }
    }), 'primary');
    drawGuilds();
    body.replaceChildren(
      el('p', {}, '✔ Token works for bot ', el('strong', {}, info.bot.name), '.'),
      info.messageContentIntent ? null : el('div', { class: 'wiz-box warn' }, '⚠ Message Content Intent is off, so message text can’t be copied. Turn it on (Bot page → Privileged Gateway Intents), save, then click Refresh. You can still copy the server’s setup without it.'),
      el('ol', { class: 'wiz-howto' },
        el('li', {}, ext(info.inviteUrl, 'Open this invite link'), ', choose your Discord server, and click ', el('strong', {}, 'Authorize'), '. It only asks for ', el('em', {}, 'View Channels'), ' and ', el('em', {}, 'Read Message History'), '.'),
        el('li', {}, 'Private channels: the bot can only copy channels it can see. In Discord, add the bot’s role to those channels, or give the bot’s role ', el('strong', {}, 'Administrator'), ' just for the move.'),
        el('li', {}, 'Come back here, click Refresh, and pick the server.')),
      el('div', { class: 'row', style: { justifyContent: 'space-between', margin: 0 } }, el('strong', {}, 'Servers the bot is in'), refresh),
      list, e, nav(btn('Back', bot), next));
  }

  // ---- 3. choose what comes over
  function choose() {
    mark(3);
    const pv = IMPORT.preview;
    const canRead = IMPORT.info.messageContentIntent;
    const nameIn = el('input', { maxlength: 64, value: pv.guild.name });
    const files = el('input', { type: 'checkbox', checked: true });
    const avatars = el('input', { type: 'checkbox', checked: true });
    const since = el('input', { type: 'date' });
    const toggles = new Map();
    const row = (c) => {
      const notes = [];
      if (c.private) notes.push(el('span', { class: 'age-badge' }, 'PRIVATE'));
      if (c.nsfw) notes.push(el('span', { class: 'age-badge' }, '18+'));
      if (c.type === 'unsupported') {
        return el('div', { class: 'wiz-ch skip' }, el('span', {}, '✖ ', c.name), el('span', { class: 'muted small' }, `${c.label}: won’t transfer`));
      }
      if (c.type === 'voice') return el('div', { class: 'wiz-ch' }, el('span', {}, '\u{1F50A} ', c.name, ...notes), el('span', { class: 'muted small' }, 'voice channel'));
      const cb = el('input', { type: 'checkbox', checked: canRead && c.readable, disabled: !canRead || !c.readable });
      toggles.set(c.id, cb);
      return el('div', { class: 'wiz-ch' }, el('span', {}, '# ', c.name, ...notes),
        c.readable ? el('label', { class: 'check small' }, cb, 'Bring messages')
          : el('span', { class: 'muted small', title: 'Give the bot access in Discord, then go Back and Next to check again' }, '⚠ Bot can’t read: comes over empty'));
    };
    const groups = [];
    const loose = pv.channels.filter((c) => !c.parentId);
    if (loose.length) groups.push(el('div', { class: 'wiz-cat' }, el('div', { class: 'wiz-cat-name' }, 'No category'), ...loose.map(row)));
    for (const cat of pv.categories) {
      const kids = pv.channels.filter((c) => c.parentId === cat.id);
      groups.push(el('div', { class: 'wiz-cat' }, el('div', { class: 'wiz-cat-name' }, cat.name), ...(kids.length ? kids.map(row) : [el('div', { class: 'muted small' }, '(empty)')])));
    }
    const all = (v) => toggles.forEach((cb) => { if (!cb.disabled) cb.checked = v; });
    body.replaceChildren(
      el('label', {}, 'Hearth server name', nameIn),
      el('div', { class: 'row', style: { justifyContent: 'space-between', margin: 0, alignItems: 'center' } },
        el('strong', {}, 'Channels'),
        el('span', {}, btn('Bring all', () => all(true), 'small'), ' ', btn('Bring none', () => all(false), 'small'))),
      el('p', { class: 'muted small', style: { margin: 0 } }, 'Every channel is created. Untick "Bring messages" for channels that should start blank (spam, memes, bot commands); keep it for the ones worth saving (rules, guides, announcements).'),
      el('div', { class: 'wiz-chs' }, ...groups),
      el('div', { class: 'wiz-box' }, el('strong', {}, `Roles (${pv.roles.length}): `),
        pv.roles.length ? pv.roles.map((r, i) => el('span', { style: { color: r.color || '' } }, (i ? ', ' : '') + r.name)) : 'none',
        pv.skippedRoles.length ? el('div', { class: 'muted small' }, `Skipped (belong to Discord bots): ${pv.skippedRoles.join(', ')}`) : null),
      el('div', { class: 'wiz-opts' },
        el('label', { class: 'check' }, files, 'Copy files and images (up to 25 MB each)'),
        el('label', { class: 'check' }, avatars, 'Copy senders’ profile pictures'),
        el('label', {}, 'Only messages since (optional)', since)),
      nav(btn('Back', invite), btn('Next', () => {
        IMPORT.options = {
          guildId: pv.guild.id, name: nameIn.value.trim() || pv.guild.name, files: files.checked, avatars: avatars.checked, since: since.value || null,
          channels: Object.fromEntries([...toggles].map(([id, cb]) => [id, { messages: cb.checked && !cb.disabled }])),
        };
        confirmStep();
      }, 'primary')));
  }

  // ---- 4. confirm
  function confirmStep() {
    mark(4);
    const o = IMPORT.options;
    const withMsgs = Object.values(o.channels).filter((c) => c.messages).length;
    const own = el('input', { type: 'checkbox' });
    const told = el('input', { type: 'checkbox' });
    const e = err();
    const go = btn('Start moving', () => busy(go, async () => {
      e.textContent = '';
      if (!own.checked || !told.checked) { e.textContent = 'Please tick both boxes to continue.'; return; }
      try { const job = await api('POST', '/imports/discord', { token: IMPORT.token, options: o, accepted: true }); progress(job); } catch (x) { e.textContent = x.message; }
    }), 'primary');
    body.replaceChildren(
      el('div', { class: 'wiz-box' }, el('h3', {}, 'Ready to move'), el('ul', {},
        el('li', {}, 'New Hearth server: ', el('strong', {}, o.name)),
        el('li', {}, `${IMPORT.preview.channels.filter((c) => c.type !== 'unsupported').length} channels in ${IMPORT.preview.categories.length} categories, ${IMPORT.preview.roles.length} roles`),
        el('li', {}, withMsgs ? `Chat history from ${withMsgs} channel${withMsgs === 1 ? '' : 's'}${o.since ? ` since ${o.since}` : ''}${o.files ? ', with files' : ', without files'}` : 'No chat history (setup only)'))),
      el('label', { class: 'check' }, own, 'I own or am an admin of this Discord server, and I’m allowed to move its content.'),
      el('label', { class: 'check' }, told, 'I’ve told (or will tell) the members that their messages are being copied to Hearth.'),
      el('p', { class: 'muted small' }, 'Imported content follows Hearth’s Terms like anything else posted here. You can delete the new server at any time.'),
      e, nav(btn('Back', choose), go));
  }

  // ---- 5. live progress, then the wrap-up
  function progress(job) {
    mark(5);
    const bar = el('div', { class: 'wiz-bar' }, el('div'));
    const line = el('p', {});
    const stats = el('p', { class: 'muted small' });
    const e = err();
    const tokIn = el('input', { type: 'password', placeholder: 'Paste the bot token again', autocomplete: 'off' });
    const actions = el('div', { class: 'row' });
    const draw = (j) => {
      const p = j.progress;
      const pct = p.phase === 'done' ? 100 : p.channelsTotal ? Math.round((p.channelsDone / p.channelsTotal) * 90) + 10 : p.phase === 'messages' ? 10 : 5;
      bar.firstChild.style.width = pct + '%';
      if (j.status === 'done') return done(j);
      line.textContent = j.status === 'cancelled' ? 'Import cancelled. Anything already copied is in the new server; you can delete it from its settings.'
        : j.status === 'interrupted' ? `Paused: ${j.error || 'the import stopped.'} Paste the bot token to pick up where it left off.`
          : p.phase === 'messages' ? `Copying messages${p.currentChannel ? ` in #${p.currentChannel}` : ''}… (channel ${Math.min(p.channelsDone + 1, p.channelsTotal)} of ${p.channelsTotal})`
            : 'Creating the server, roles and channels…';
      stats.textContent = `${p.messages.toLocaleString()} messages · ${p.files.toLocaleString()} files`;
      if (j.status === 'running') {
        actions.replaceChildren(btn('Close (keeps going)', () => dlg.close()),
          btn('Cancel import', async () => { if (await confirmDialog('Cancel the import?', 'Copying stops. What’s already copied stays in the new server.', 'Cancel import')) api('POST', `/imports/${j.id}/cancel`).then(draw).catch((x) => { e.textContent = x.message; }); }, 'danger'));
      } else if (j.status === 'interrupted') {
        tokIn.value = IMPORT.token;
        const r = btn('Continue', () => busy(r, async () => {
          try { IMPORT.token = tokIn.value.trim(); draw(await api('POST', `/imports/${j.id}/resume`, { token: IMPORT.token })); } catch (x) { e.textContent = x.message; }
        }), 'primary');
        actions.replaceChildren(btn('Stop for good', () => api('POST', `/imports/${j.id}/cancel`).then(draw)), r);
      } else actions.replaceChildren(btn('Close', () => dlg.close()));
      tokIn.style.display = j.status === 'interrupted' ? '' : 'none';
    };
    IMPORT.onJob = (j) => { if (j.id === job.id) draw(j); };
    body.replaceChildren(line, bar, stats, tokIn, e, actions);
    draw(job);
  }

  function done(job) {
    mark(6);
    IMPORT.onJob = null;
    IMPORT.token = ''; // finished with it
    const p = job.progress;
    body.replaceChildren(
      el('div', { class: 'wiz-box ok' }, el('h3', {}, `✔ ${job.sourceName} is on Hearth`),
        el('p', {}, `${p.messages.toLocaleString()} messages and ${p.files.toLocaleString()} files copied.`)),
      p.notes.length ? el('details', { class: 'wiz-box' }, el('summary', {}, `Notes (${p.notes.length})`), el('ul', {}, p.notes.map((n) => el('li', {}, n)))) : null,
      el('h3', {}, 'What to do next'),
      el('ol', { class: 'wiz-howto' },
        el('li', {}, el('strong', {}, 'Review channel permissions. '), 'Your channels are hidden from members until you open them. Check the roles, set who can see each channel, then open it.'),
        el('li', {}, el('strong', {}, 'Retire the bot. '), 'In the ', ext('https://discord.com/developers/applications', 'Developer Portal'), ', click Reset Token (or delete the app), and remove the bot from your Discord server.'),
        el('li', {}, el('strong', {}, 'Invite your people. '), 'Create an invite link and share it on Discord. Give roles to people as they join.')),
      nav(btn('Close', () => dlg.close()), btn('Review channels', () => {
        dlg.close(); selectServer(job.serverId); const s = S.servers.get(job.serverId); if (s) reviewModal(s);
      }, 'primary')));
  }

  // Pick up an import that's still going (or paused) instead of starting over.
  api('GET', '/imports').then((jobs) => {
    const live = jobs.find((j) => j.status === 'running' || j.status === 'interrupted');
    if (live) progress(live); else intro();
  }).catch(() => intro());
}


// ================================================================ GIFs (GIPHY)
// GIPHY's rules: search and GIFs load straight from GIPHY in the app (no
// copying or proxying through Hearth), results aren't reordered, and
// "Powered by GIPHY" is shown. Hearth only stores the GIF's address.
const gifsOn = () => pref('hearth_gifs', 'on') !== 'off';
function gifToggle() {
  const cb = el('input', { type: 'checkbox', checked: gifsOn() });
  cb.onchange = () => { try { localStorage.setItem('hearth_gifs', cb.checked ? 'on' : 'off'); } catch { /* ignore */ } if (S.channelId) renderMessages({ keepScroll: true }); };
  return cb;
}

function gifBody(m) {
  const box = el('div', { class: 'body gif-body' });
  const show = () => box.replaceChildren(el('img', { class: 'gif', src: m.content, alt: 'GIF', loading: 'lazy', referrerpolicy: 'no-referrer' }));
  if (gifsOn() || S.revealed.has(m.id)) show();
  else box.append(el('button', { class: 'gif-placeholder', title: 'Loads from GIPHY', onclick: () => { S.revealed.add(m.id); show(); } }, '▶ GIF · tap to load'));
  return box;
}

let gifPop = null;
function gifPicker(initial = '') {
  if (!S.gifs || !S.channelId) return;
  if (gifPop) { gifPop.close(); }
  const chan = findChannel(S.channelId);
  const srv = server();
  const adult = Math.max(chan.ageRating || 0, (srv && srv.ageRating) || 0) >= 18;
  const q = el('input', { type: 'search', placeholder: 'Search GIPHY', value: initial, maxlength: 50, autocomplete: 'off' });
  const grid = el('div', { class: 'gif-grid' });
  const status = el('div', { class: 'muted small gif-status' });
  const more = el('button', { class: 'btn small', style: { display: 'none' } }, 'More');
  let offset = 0; let timer = null; let seq = 0;
  const load = async (append) => {
    const mine = ++seq;
    const term = q.value.trim();
    const params = new URLSearchParams({ api_key: S.gifs.key, limit: '24', offset: String(append ? offset : 0), rating: adult ? 'r' : 'pg-13', bundle: 'messaging_non_clips' });
    if (term) params.set('q', term);
    status.textContent = 'Loading…';
    try {
      const res = await fetch(`https://api.giphy.com/v1/gifs/${term ? 'search' : 'trending'}?${params}`, { referrerPolicy: 'no-referrer', credentials: 'omit' });
      if (res.status === 429) throw new Error('GIF search is busy right now. Try again in a little while.');
      if (!res.ok) throw new Error('GIF search isn’t working right now.');
      const data = await res.json();
      if (mine !== seq) return;
      if (!append) { grid.replaceChildren(); offset = 0; grid.scrollTop = 0; }
      offset += data.data.length;
      for (const g of data.data) {
        const thumb = g.images.fixed_width_small || g.images.fixed_width;
        const send = g.images.fixed_height || g.images.downsized || g.images.original;
        grid.append(el('button', { class: 'gif-cell', title: g.title || 'GIF', onclick: () => pick(send.url) },
          el('img', { src: thumb.webp || thumb.url, alt: g.title || 'GIF', loading: 'lazy', referrerpolicy: 'no-referrer' })));
      }
      status.textContent = data.data.length || append ? '' : 'No GIFs found.';
      more.style.display = data.pagination && offset < Math.min(data.pagination.total_count, 4999) ? '' : 'none';
    } catch (e) { if (mine === seq) status.textContent = e.message; }
  };
  const pick = async (url) => {
    close();
    const replyTo = S.replyTo ? S.replyTo.id : undefined;
    S.replyTo = null; renderComposerExtras();
    try { await api('POST', `/channels/${chan.id}/messages`, { content: url, kind: 'gif', replyTo }); } catch (e) { toast(e.message); }
  };
  q.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => load(false), 500); });
  q.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); if (e.key === 'Enter') { e.preventDefault(); clearTimeout(timer); load(false); } });
  more.onclick = () => load(true);
  const pop = el('div', { class: 'gif-pop', role: 'dialog', 'aria-label': 'GIF picker' },
    el('div', { class: 'gif-top' }, q, el('button', { class: 'icon-btn', title: 'Close', onclick: () => close() }, '✕')),
    grid, status, el('div', { class: 'gif-foot' }, more, el('span', { class: 'spacer' }), el('span', { class: 'giphy-attr' }, 'Powered by GIPHY')));
  const outside = (e) => { if (!pop.contains(e.target) && e.target.id !== 'gif-btn') close(); };
  function close() { pop.remove(); document.removeEventListener('mousedown', outside); gifPop = null; }
  $('composer').append(pop);
  setTimeout(() => document.addEventListener('mousedown', outside), 0);
  gifPop = { close };
  q.focus();
  load(false);
}
$('gif-btn').addEventListener('click', () => (gifPop ? gifPop.close() : gifPicker()));

boot();
