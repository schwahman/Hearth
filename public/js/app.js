// Hearth web client.
import { api, upload } from './api.js';
import { Gateway } from './gateway.js';
import { Voice } from './voice.js';
import {
  el, $, renderMarkdown, initials, colorFor, fmtTime, fmtDay, fmtSize, toast, modal, confirmDialog,
} from './util.js';

// Must match server/permissions.js
const P = {
  VIEW_CHANNELS: 1 << 0, SEND_MESSAGES: 1 << 1, ATTACH_FILES: 1 << 2, ADD_REACTIONS: 1 << 3,
  MANAGE_MESSAGES: 1 << 4, MANAGE_CHANNELS: 1 << 5, MANAGE_ROLES: 1 << 6, MANAGE_SERVER: 1 << 7,
  CREATE_INVITE: 1 << 8, KICK_MEMBERS: 1 << 9, BAN_MEMBERS: 1 << 10, CONNECT: 1 << 11,
  SPEAK: 1 << 12, VIDEO: 1 << 13, ADMINISTRATOR: 1 << 30,
};
const PERM_LABELS = {
  ADMINISTRATOR: 'Administrator (everything)', MANAGE_SERVER: 'Manage server', MANAGE_ROLES: 'Manage roles',
  MANAGE_CHANNELS: 'Manage channels', KICK_MEMBERS: 'Kick members', BAN_MEMBERS: 'Ban members',
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
  $('auth-terms-wrap').classList.toggle('hidden', !reg);
  $('auth-terms').required = reg;
  $('auth-password').autocomplete = reg ? 'new-password' : 'current-password';
  $('auth-password').minLength = reg ? 12 : 1;
  $('auth-password-hint').classList.toggle('hidden', !reg);
  $('auth-error').textContent = '';
}

$('auth-toggle').onclick = (e) => { e.preventDefault(); setAuthMode(!registering); };
$('auth-form').onsubmit = async (e) => {
  e.preventDefault();
  $('auth-error').textContent = '';
  try {
    const body = { username: $('auth-username').value.trim(), password: $('auth-password').value };
    if (registering) {
      body.displayName = $('auth-display').value.trim() || undefined;
      body.acceptTerms = $('auth-terms').checked;
    }
    const res = await api('POST', registering ? '/auth/register' : '/auth/login', body);
    S.me = res.user;
    $('auth-password').value = '';
    start();
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
  S.servers = new Map(d.servers.map((s) => [s.id, s]));
  S.dms = new Map(d.dms.map((c) => [c.id, c]));
  S.dmVoice = d.dmVoiceStates;
  S.messages.clear();
  renderMe();
  renderRail();

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
  if (u.id === S.me.id) { S.me = u; renderMe(); }
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
  const section = (type, label) => {
    const chans = s.channels.filter((c) => c.type === type);
    const out = [el('div', { class: 'cat' }, el('span', {}, label),
      manage ? el('button', { class: 'icon-btn', title: `Create ${type} channel`, onclick: () => channelModal(s, type) }, '+') : null)];
    for (const c of chans) {
      const isText = type === 'text';
      const tools = manage ? el('span', { class: 'tools' },
        el('button', { class: 'icon-btn', title: 'Edit channel', onclick: (e) => { e.stopPropagation(); channelModal(s, type, c); } }, '⚙')) : null;
      out.push(el('div', {
        class: 'chan' + ((isText ? S.channelId === c.id && !S.viewingVoice : S.viewingVoice === c.id) ? ' active' : ''),
        onclick: () => (isText ? selectChannel(c.id) : joinVoice(c.id)),
        title: isText ? c.topic || c.name : 'Join voice',
      },
      el('span', { class: 'channel-icon' }, isText ? '#' : '🔊'),
      el('span', { class: 'name' }, c.name),
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
    }
    return out;
  };
  list.replaceChildren(...section('text', 'Text channels'), ...section('voice', 'Voice channels'));
}

function renderHeader() {
  const c = S.channelId ? findChannel(S.channelId) : null;
  const isDm = c && c.type === 'dm';
  $('channel-icon').textContent = isDm ? '@' : '#';
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
      : el('div', {}, el('h2', {}, `Hi, ${S.me.displayName}`),
        el('p', {}, 'Pick a conversation, start a new one with +, or use the + on the left to create or join a server.')));
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

function messageNodes(m, prev, bucket) {
  const out = [];
  if (!prev || new Date(prev.createdAt).toDateString() !== new Date(m.createdAt).toDateString()) {
    out.push(el('div', { class: 'day-sep' }, fmtDay(m.createdAt)));
    prev = null;
  }
  const cont = prev && prev.author.id === m.author.id && !m.replyTo && m.createdAt - prev.createdAt < 5 * 60000;
  const mine = m.author.id === S.me.id;
  const canManage = S.serverId ? can(P.MANAGE_MESSAGES) : false;

  const actions = el('div', { class: 'actions' },
    el('button', { title: 'React', onclick: (e) => openPicker(e, m) }, '🙂'),
    el('button', { title: 'Reply', onclick: () => setReply(m) }, '↩'),
    mine ? el('button', { title: 'Edit', onclick: () => editMessage(m) }, '✎') : null,
    mine || canManage ? el('button', { title: 'Delete', onclick: () => deleteMessage(m) }, '🗑') : null);

  let replyRef = null;
  if (m.replyTo) {
    const target = bucket.list.find((x) => x.id === m.replyTo);
    replyRef = el('div', { class: 'reply-ref', onclick: () => jumpTo(m.replyTo) },
      target ? el('span', {}, el('strong', {}, displayName(target.author)), ' ', target.content.slice(0, 80) || '(attachment)')
        : el('span', {}, 'Original message was deleted or is older'));
  }

  const body = el('div', { class: 'body', html: renderMarkdown(m.content) });
  if (m.editedAt) body.append(' ', el('span', { class: 'edited', title: fmtTime(m.editedAt) }, '(edited)'));

  const attachments = m.attachments.length ? el('div', { class: 'attachments' }, m.attachments.map((a) => {
    if (a.type.startsWith('image/')) return el('img', { src: a.url, alt: a.name, loading: 'lazy', onclick: () => window.open(a.url, '_blank') });
    if (a.type.startsWith('video/')) return el('video', { src: a.url, controls: true, preload: 'metadata' });
    if (a.type.startsWith('audio/')) return el('audio', { src: a.url, controls: true });
    return el('a', { class: 'file-card', href: a.url, download: a.name }, '📄', el('span', {}, a.name, el('div', { class: 'muted small' }, fmtSize(a.size))));
  })) : null;

  const reactions = m.reactions.length ? el('div', { class: 'reactions' }, m.reactions.map((r) =>
    el('button', { class: 'reaction' + (r.me ? ' me' : ''), onclick: () => toggleReaction(m, r.emoji, !r.me) }, `${r.emoji} ${r.count}`))) : null;

  out.push(el('div', { class: 'msg' + (cont ? ' cont' : ''), 'data-id': m.id },
    el('div', { class: 'gutter' }, avatar(m.author)),
    el('div', {},
      replyRef,
      cont ? null : el('div', { class: 'head' },
        el('span', { class: 'author', style: { color: roleColor(m.author.id) || '' } }, displayName(m.author)),
        el('span', { class: 'time' }, fmtTime(m.createdAt))),
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
  if (!(await confirmDialog('Delete message', 'This message and any attached files will be permanently deleted. This cannot be undone.', 'Delete forever'))) return;
  try { await api('DELETE', `/messages/${m.id}`); } catch (err) { toast(err.message); }
}

// ----- composer
const input = $('composer-input');
input.addEventListener('input', () => {
  input.style.height = 'auto';
  input.style.height = Math.min(200, input.scrollHeight) + 'px';
  if (input.value && S.channelId) gw.send({ op: 'TYPING', channelId: S.channelId });
});
input.addEventListener('keydown', (e) => {
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

$('vc-mute').onclick = () => voice.setMuted(!voice.muted);
$('vc-deaf').onclick = () => voice.setDeafened(!voice.deafened);
$('vc-cam').onclick = () => voice.toggleCamera().catch((e) => toast(e.message || 'Camera unavailable.'));
$('vc-screen').onclick = () => voice.toggleScreen().catch((e) => { if (e.name !== 'NotAllowedError') toast(e.message || 'Screen share failed.'); });
$('vc-leave').onclick = () => { voice.leave(); S.viewingVoice = null; renderVoiceUI(); };
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
      el('button', { onclick: () => { dlg.close(); joinServerModal(); } }, el('strong', {}, 'Join with an invite'), el('div', { class: 'muted small' }, 'Paste an invite link or code.'))),
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

function channelModal(s, type, existing) {
  const [lblName, name] = field('Channel name', { maxlength: 64, value: existing ? existing.name : '' });
  const [lblTopic, topic] = field('Topic (optional)', { maxlength: 256, value: existing ? existing.topic : '' });
  const err = el('p', { class: 'error' });
  const save = async () => {
    try {
      if (existing) await api('PATCH', `/channels/${existing.id}`, { name: name.value, topic: topic.value });
      else {
        const c = await api('POST', `/servers/${s.id}/channels`, { name: name.value, type, topic: topic.value });
        if (type === 'text') { dlg.close(); return selectChannel(c.id); }
      }
      dlg.close();
    } catch (e) { err.textContent = e.message; }
  };
  const del = async () => {
    dlg.close();
    dangerDialog({
      title: `Delete #${existing.name}?`,
      lines: ['Every message and file in this channel will be permanently deleted for everyone.'],
      confirmText: existing.name, confirmLabel: 'Delete channel forever',
      run: () => api('DELETE', `/channels/${existing.id}`),
    });
  };
  name.addEventListener('keydown', (e) => e.key === 'Enter' && save());
  const dlg = modal([
    el('h2', {}, existing ? 'Edit channel' : `Create ${type} channel`), lblName, type === 'text' ? lblTopic : null, err,
    el('div', { class: 'row' },
      existing ? el('button', { class: 'btn danger', onclick: del, style: { marginRight: 'auto' } }, 'Delete') : null,
      el('button', { class: 'btn', onclick: () => dlg.close() }, 'Cancel'),
      el('button', { class: 'btn primary', onclick: save }, existing ? 'Save' : 'Create')),
  ]);
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

function serverSettingsModal(s) {
  const tabs = [['overview', 'Overview'], ['invite', 'Invite'], ['roles', 'Roles'], ['members', 'Members']];
  const body = el('div');
  const tabBar = el('div', { class: 'tabs' });
  let current = 'overview';
  const show = async (key) => {
    current = key;
    tabBar.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.k === key));
    body.replaceChildren();
    if (key === 'overview') body.append(overviewTab(s, dlg));
    if (key === 'invite') body.append(can(P.CREATE_INVITE, s) ? await inviteBlock(s) : el('p', { class: 'muted' }, 'You cannot create invites here.'));
    if (key === 'roles') body.append(rolesTab(s));
    if (key === 'members') body.append(membersTab(s, () => show('members')));
  };
  for (const [k, label] of tabs) tabBar.append(el('button', { 'data-k': k, onclick: () => show(k) }, label));
  const dlg = modal([el('h2', {}, s.name), tabBar, body], { wide: true });
  show(current);
}

function overviewTab(s, dlg) {
  const wrap = el('div', { style: { display: 'grid', gap: '14px' } });
  const err = el('p', { class: 'error' });
  if (can(P.MANAGE_SERVER, s)) {
    const [lbl, name] = field('Server name', { value: s.name, maxlength: 64 });
    const icon = el('input', { type: 'file', accept: 'image/*' });
    wrap.append(lbl, el('label', {}, 'Server icon', icon),
      el('div', { class: 'row' }, el('button', { class: 'btn primary', onclick: async () => {
        try {
          const patch = { name: name.value };
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
            'Every channel, message, role, invite and uploaded file in this server will be permanently deleted for everyone.',
            'Members will be removed immediately.',
          ],
          confirmText: s.name, confirmLabel: 'Delete server forever',
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

function rolesTab(s) {
  const wrap = el('div', { style: { display: 'grid', gap: '12px' } });
  if (!can(P.MANAGE_ROLES, s)) { wrap.append(el('p', { class: 'muted' }, 'You cannot manage roles here.')); return wrap; }
  const editor = el('div');
  const list = el('div');
  const draw = () => {
    list.replaceChildren(...s.roles.map((r) => el('div', { class: 'list-row', style: { cursor: 'pointer' }, onclick: () => edit(r) },
      el('span', { class: 'dot', style: { background: r.color || 'var(--muted)' } }), el('strong', {}, r.name),
      el('span', { class: 'spacer' }), el('span', { class: 'muted small' }, r.isDefault ? 'everyone' : ''))));
  };
  const edit = (r) => {
    const [lblName, name] = field('Role name', { value: r.name, maxlength: 32, disabled: r.isDefault });
    const color = el('input', { type: 'color', value: r.color || '#ff7a29', style: { width: '64px', padding: '2px' } });
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
  wrap.append(el('div', { class: 'row' }, el('button', { class: 'btn primary', onclick: async () => {
    try {
      const r = await api('POST', `/servers/${s.id}/roles`, { name: 'new role', permissions: 0 });
      if (!s.roles.some((x) => x.id === r.id)) s.roles.unshift(r);
      draw(); edit(r);
    } catch (e) { toast(e.message); }
  } }, 'Create role')), list, editor);
  draw();
  return wrap;
}

function membersTab(s, refresh) {
  const wrap = el('div');
  for (const m of s.members) wrap.append(memberRow(s, m, refresh));
  return wrap;
}

function memberRow(s, m, refresh) {
  const roles = s.roles.filter((r) => !r.isDefault);
  const canRoles = can(P.MANAGE_ROLES, s);
  const self = m.user.id === S.me.id;
  const owner = m.user.id === s.ownerId;
  return el('div', { class: 'list-row', style: { flexWrap: 'wrap' } },
    avatar(m.user, { status: true }),
    el('div', {}, el('strong', {}, m.nickname || m.user.displayName), el('div', { class: 'muted small' }, '@' + m.user.username)),
    el('span', { class: 'spacer' }),
    el('div', { style: { display: 'flex', gap: '4px', flexWrap: 'wrap' } }, roles.map((r) => {
      const has = m.roles.includes(r.id);
      return el('span', { class: 'chip' + (has ? ' on' : ''), title: canRoles ? 'Toggle role' : '', onclick: async () => {
        if (!canRoles) return;
        try { const upd = await api(has ? 'DELETE' : 'PUT', `/servers/${s.id}/members/${m.user.id}/roles/${r.id}`); Object.assign(m, upd); refresh && refresh(); }
        catch (e) { toast(e.message); }
      } }, r.name);
    })),
    !self && !owner && can(P.KICK_MEMBERS, s) ? el('button', { class: 'btn', onclick: async () => {
      if (!(await confirmDialog('Kick member', `Remove ${m.user.displayName} from the server? They can rejoin with an invite.`, 'Kick'))) return;
      try { await api('DELETE', `/servers/${s.id}/members/${m.user.id}`); refresh && refresh(); } catch (e) { toast(e.message); }
    } }, 'Kick') : null,
    !self && !owner && can(P.BAN_MEMBERS, s) ? el('button', { class: 'btn danger', onclick: async () => {
      if (!(await confirmDialog('Ban member', `Ban ${m.user.displayName}? They will not be able to rejoin.`, 'Ban'))) return;
      try { await api('PUT', `/servers/${s.id}/bans/${m.user.id}`, {}); refresh && refresh(); } catch (e) { toast(e.message); }
    } }, 'Ban') : null);
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
    lbl, el('label', {}, 'Avatar image', pic), err,
    el('div', { class: 'row', style: { justifyContent: 'flex-start' } },
      el('button', { class: 'btn', onclick: () => { dlg.close(); passwordModal(); } }, 'Change password'),
      el('button', { class: 'btn', onclick: () => { dlg.close(); sessionsModal(); } }, 'Signed-in devices'),
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
      el('strong', {}, '\u26a0 This is permanent.'),
      ...lines.map((l) => el('p', {}, l)),
      el('p', {}, 'There is no undo and no backup. Not even the server administrator can recover it.')),
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
      'Your profile, every message you have sent, your uploaded files, reactions and memberships will be permanently deleted.',
      'You will be signed out on all devices. Your username becomes available to others.',
      'Want a copy first? Use \u201cDownload my data\u201d in your profile before continuing.',
    ],
    confirmText: 'DELETE', confirmLabel: 'Delete my account forever', password: true,
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

boot();
