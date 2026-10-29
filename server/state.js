// Live, in-memory state: who is online and who is in which voice channel.
// Every node applies the same PRESENCE_UPDATE / VOICE_STATE_UPDATE events
// from the bus, so all nodes agree on this state.
'use strict';
const bus = require('./bus');

const online = new Map();      // userId -> Set of session keys
const voiceStates = new Map(); // userId -> voice state

bus.on('event', (topic, ev) => {
  if (ev.t === 'PRESENCE_UPDATE') {
    const { userId, sessionKey, online: isOnline } = ev.d;
    let set = online.get(userId);
    if (isOnline) {
      if (!set) online.set(userId, (set = new Set()));
      set.add(sessionKey);
    } else if (set) {
      set.delete(sessionKey);
      if (!set.size) online.delete(userId);
    }
  } else if (ev.t === 'VOICE_STATE_UPDATE') {
    const s = ev.d;
    if (s.channelId) voiceStates.set(s.userId, s);
    else voiceStates.delete(s.userId);
  }
});

function isOnline(userId) { return online.has(userId); }

function voiceStatesForServer(serverId) {
  return [...voiceStates.values()].filter((v) => v.serverId === serverId);
}

function voiceStatesForChannel(channelId) {
  return [...voiceStates.values()].filter((v) => v.channelId === channelId);
}

function voiceStateOf(userId) { return voiceStates.get(userId) || null; }

module.exports = { isOnline, voiceStatesForServer, voiceStatesForChannel, voiceStateOf };
