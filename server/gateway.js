// Real-time gateway. Each client keeps one WebSocket open. The gateway:
//  - authenticates it (IDENTIFY) and sends the initial state (READY)
//  - subscribes it to the topics it should hear (its servers, DMs, itself)
//  - relays bus events to it as they happen
//  - tracks presence, typing and voice channel membership
//  - relays WebRTC signaling between voice participants
'use strict';
const config = require('./config');
const { one, all } = require('./db');
const { randomCode } = require('./ids');
const { P, has, memberPermissions } = require('./permissions');
const auth = require('./auth');
const bus = require('./bus');
const state = require('./state');
const ser = require('./serialize');
const { channelAccess, cookie, sameOrigin } = require('./api');

const sessions = new Map(); // sessionId -> session
const byTopic = new Map();  // topic -> Set(session)

function subscribe(session, topic) {
  if (session.topics.has(topic)) return;
  session.topics.add(topic);
  if (!byTopic.has(topic)) byTopic.set(topic, new Set());
  byTopic.get(topic).add(session);
}

function unsubscribe(session, topic) {
  session.topics.delete(topic);
  const set = byTopic.get(topic);
  if (set) { set.delete(session); if (!set.size) byTopic.delete(topic); }
}

// Deliver bus events to local sessions.
bus.on('event', (topic, ev) => {
  const set = byTopic.get(topic);
  if (!set) return;
  for (const s of [...set]) {
    // Events addressed to one specific session (voice signaling).
    if (ev.toSession && ev.toSession !== s.id) continue;
    // Password changed or devices signed out: drop connections whose login
    // is no longer valid.
    if (ev.t === 'SESSIONS_REVOKED') {
      if (!auth.userFromToken(s.token)) s.ws.close(4004, 'session revoked');
      continue;
    }
    // Keep subscriptions in step with membership changes.
    if (ev.t === 'SERVER_CREATE') subscribe(s, `server:${ev.d.id}`);
    if (ev.t === 'SERVER_DELETE') {
      unsubscribe(s, `server:${ev.d.id}`);
      if (s.voice && s.voice.serverId === ev.d.id) leaveVoice(s);
    }
    if (ev.t === 'DM_CREATE') subscribe(s, `channel:${ev.d.id}`);
    if (ev.t === 'CHANNEL_DELETE' && s.voice && s.voice.channelId === ev.d.id) leaveVoice(s);
    // Clients only need "is this person online at all", not per-session detail.
    if (ev.t === 'PRESENCE_UPDATE') {
      s.ws.sendJSON({ t: ev.t, d: { userId: ev.d.userId, online: state.isOnline(ev.d.userId) } });
      continue;
    }
    s.ws.sendJSON({ t: ev.t, d: ev.d });
  }
});

function onConnection(ws, req) {
  // Refuse WebSocket connections opened by other websites (cross-site
  // WebSocket hijacking). Browsers always send Origin on WebSocket requests.
  const origin = sameOrigin(req);
  if (origin === false) return ws.close(4003, 'bad origin');
  const cookieToken = cookie(req, 'hearth_token');
  const session = { id: randomCode(9), ws, user: null, token: null, topics: new Set(), voice: null, lastTyping: 0 };
  const identifyTimer = setTimeout(() => ws.close(4001, 'identify timeout'), 10000);

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return ws.close(4002, 'bad json'); }
    if (!session.user) {
      if (msg.op !== 'IDENTIFY') return ws.close(4003, 'identify first');
      // Browsers authenticate with the HttpOnly cookie; bots/tests may send a token.
      const token = typeof msg.token === 'string' && msg.token ? msg.token : (origin ? cookieToken : null);
      const user = auth.userFromToken(token);
      if (!user) return ws.close(4004, 'invalid token');
      session.token = token;
      clearTimeout(identifyTimer);
      session.user = user;
      sessions.set(session.id, session);
      ready(session);
      return;
    }
    try { handleOp(session, msg); } catch (err) { console.error('[gateway]', err); }
  });

  ws.on('close', () => {
    clearTimeout(identifyTimer);
    if (!session.user) return;
    if (session.voice) leaveVoice(session);
    sessions.delete(session.id);
    for (const t of [...session.topics]) unsubscribe(session, t);
    setPresence(session, false);
  });
}

function ready(session) {
  const u = session.user;
  subscribe(session, `user:${u.id}`);
  const serverIds = all('SELECT server_id FROM members WHERE user_id = ?', u.id).map((r) => r.server_id);
  for (const id of serverIds) subscribe(session, `server:${id}`);
  const dmIds = all('SELECT channel_id FROM dm_recipients WHERE user_id = ?', u.id).map((r) => r.channel_id);
  for (const id of dmIds) subscribe(session, `channel:${id}`);

  setPresence(session, true); // before building READY so we show as online
  session.ws.sendJSON({
    t: 'READY',
    d: {
      sessionId: session.id,
      user: ser.user(one('SELECT * FROM users WHERE id = ?', u.id)),
      servers: serverIds.map(ser.server),
      dms: dmIds.map(ser.dmChannel),
      dmVoiceStates: dmIds.flatMap(state.voiceStatesForChannel),
      iceServers: config.iceServers,
    },
  });
}

function setPresence(session, online) {
  const u = session.user;
  const ev = { t: 'PRESENCE_UPDATE', d: { userId: u.id, sessionKey: `${bus.nodeTag}:${session.id}`, online } };
  // Apply to shared state everywhere, then tell people who share a server.
  const serverIds = all('SELECT server_id FROM members WHERE user_id = ?', u.id).map((r) => r.server_id);
  const dmIds = all('SELECT channel_id FROM dm_recipients WHERE user_id = ?', u.id).map((r) => r.channel_id);
  bus.publish(`user:${u.id}`, ev);
  for (const id of serverIds) bus.publish(`server:${id}`, ev);
  for (const id of dmIds) bus.publish(`channel:${id}`, ev);
}

function handleOp(session, msg) {
  switch (msg.op) {
    case 'HEARTBEAT':
      return session.ws.sendJSON({ t: 'HEARTBEAT_ACK' });

    case 'TYPING': {
      const now = Date.now();
      if (now - session.lastTyping < 3000) return;
      session.lastTyping = now;
      const { channel } = channelAccess(String(msg.channelId), session.user.id, P.SEND_MESSAGES);
      const topic = channel.type === 'dm' ? `channel:${channel.id}` : `server:${channel.server_id}`;
      bus.publish(topic, { t: 'TYPING_START', d: { channelId: channel.id, userId: session.user.id } });
      return;
    }

    case 'VOICE_JOIN':
      return joinVoice(session, String(msg.channelId), msg);

    case 'VOICE_LEAVE':
      return leaveVoice(session);

    case 'VOICE_STATE': {
      if (!session.voice) return;
      const v = session.voice;
      const perms = v.serverId ? memberPermissions(v.serverId, session.user.id) : -1;
      if (typeof msg.mute === 'boolean') v.mute = msg.mute || !has(perms, P.SPEAK);
      if (typeof msg.deaf === 'boolean') v.deaf = msg.deaf;
      if (typeof msg.video === 'boolean') v.video = msg.video && has(perms, P.VIDEO);
      if (typeof msg.screen === 'boolean') v.screen = msg.screen && has(perms, P.VIDEO);
      publishVoice(session);
      return;
    }

    // WebRTC offer/answer/ICE candidate for another participant.
    case 'VOICE_SIGNAL': {
      if (!session.voice) return;
      const target = state.voiceStatesForChannel(session.voice.channelId)
        .find((v) => v.sessionId === msg.toSession);
      if (!target) return;
      bus.publish(`user:${target.userId}`, {
        t: 'VOICE_SIGNAL',
        toSession: target.sessionId,
        d: { fromSession: session.id, fromUser: session.user.id, data: msg.data },
      });
      return;
    }
  }
}

function joinVoice(session, channelId, opts) {
  let access;
  try { access = channelAccess(channelId, session.user.id, P.CONNECT); }
  catch (e) { return session.ws.sendJSON({ t: 'ERROR', d: { message: e.message } }); }
  const { channel, perms } = access;
  if (channel.type !== 'voice' && channel.type !== 'dm') {
    return session.ws.sendJSON({ t: 'ERROR', d: { message: 'That is not a voice channel.' } });
  }
  if (session.voice) leaveVoice(session);
  // One voice connection per user: kick an older session of the same user.
  const existing = state.voiceStateOf(session.user.id);
  if (existing) {
    bus.publish(`user:${session.user.id}`, {
      t: 'VOICE_FORCE_LEAVE', toSession: existing.sessionId, d: { reason: 'Joined voice elsewhere.' },
    });
    const old = sessions.get(existing.sessionId);
    if (old) old.voice = null;
  }
  session.voice = {
    userId: session.user.id,
    sessionId: session.id,
    channelId: channel.id,
    serverId: channel.server_id || null,
    mute: !!opts.mute || !has(perms, P.SPEAK),
    deaf: !!opts.deaf,
    video: false,
    screen: false,
  };
  publishVoice(session);
}

function leaveVoice(session) {
  if (!session.voice) return;
  const { channelId, serverId } = session.voice;
  session.voice = null;
  const d = { userId: session.user.id, sessionId: session.id, channelId: null, serverId, previousChannelId: channelId };
  bus.publish(voiceTopic(serverId, channelId), { t: 'VOICE_STATE_UPDATE', d });
}

function publishVoice(session) {
  const v = session.voice;
  bus.publish(voiceTopic(v.serverId, v.channelId), { t: 'VOICE_STATE_UPDATE', d: { ...v } });
}

function voiceTopic(serverId, channelId) {
  return serverId ? `server:${serverId}` : `channel:${channelId}`;
}

module.exports = { onConnection, sessions };
