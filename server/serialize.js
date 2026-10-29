// Turns database rows into the JSON shapes sent to clients.
'use strict';
const { one, all } = require('./db');
const state = require('./state');

function user(row) {
  return { id: row.id, username: row.username, displayName: row.display_name, avatar: row.avatar || null };
}

function channel(row) {
  return {
    id: row.id, serverId: row.server_id, name: row.name, type: row.type,
    topic: row.topic || '', position: row.position,
  };
}

function role(row) {
  return {
    id: row.id, serverId: row.server_id, name: row.name, color: row.color,
    permissions: row.permissions, position: row.position, isDefault: !!row.is_default,
  };
}

function member(serverId, userId) {
  const row = one(
    `SELECT u.id, u.username, u.display_name, u.avatar, m.nickname, m.joined_at
     FROM members m JOIN users u ON u.id = m.user_id
     WHERE m.server_id = ? AND m.user_id = ?`, serverId, userId);
  if (!row) return null;
  return memberFromRow(serverId, row);
}

function memberFromRow(serverId, row) {
  const roles = all('SELECT role_id FROM member_roles WHERE server_id = ? AND user_id = ?', serverId, row.id)
    .map((r) => r.role_id);
  return {
    user: user(row), nickname: row.nickname || null, joinedAt: row.joined_at,
    roles, online: state.isOnline(row.id),
  };
}

function server(serverId) {
  const s = one('SELECT * FROM servers WHERE id = ?', serverId);
  if (!s) return null;
  const members = all(
    `SELECT u.id, u.username, u.display_name, u.avatar, m.nickname, m.joined_at
     FROM members m JOIN users u ON u.id = m.user_id WHERE m.server_id = ?`, serverId)
    .map((r) => memberFromRow(serverId, r));
  return {
    id: s.id, name: s.name, ownerId: s.owner_id, icon: s.icon || null,
    channels: all('SELECT * FROM channels WHERE server_id = ? ORDER BY position, id', serverId).map(channel),
    roles: all('SELECT * FROM roles WHERE server_id = ? ORDER BY position DESC', serverId).map(role),
    members,
    voiceStates: state.voiceStatesForServer(serverId),
  };
}

function dmChannel(channelId) {
  const c = one('SELECT * FROM channels WHERE id = ?', channelId);
  const recipients = all(
    `SELECT u.* FROM dm_recipients d JOIN users u ON u.id = d.user_id WHERE d.channel_id = ?`, channelId)
    .map((u) => ({ ...user(u), online: state.isOnline(u.id) }));
  return { ...channel(c), recipients };
}

function messages(rows, viewerId) {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const marks = ids.map(() => '?').join(',');
  const reactRows = all(
    `SELECT message_id, emoji, COUNT(*) AS n, SUM(user_id = ?) AS me
     FROM reactions WHERE message_id IN (${marks}) GROUP BY message_id, emoji`, viewerId, ...ids);
  const reactions = new Map();
  for (const r of reactRows) {
    if (!reactions.has(r.message_id)) reactions.set(r.message_id, []);
    reactions.get(r.message_id).push({ emoji: r.emoji, count: r.n, me: !!r.me });
  }
  const authors = new Map();
  return rows.map((r) => {
    if (!authors.has(r.author_id)) {
      authors.set(r.author_id, user(one('SELECT * FROM users WHERE id = ?', r.author_id)));
    }
    return {
      id: r.id, channelId: r.channel_id, author: authors.get(r.author_id),
      content: r.content, attachments: r.attachments ? JSON.parse(r.attachments) : [],
      replyTo: r.reply_to || null, createdAt: r.created_at, editedAt: r.edited_at || null,
      reactions: reactions.get(r.id) || [],
    };
  });
}

function message(id, viewerId) {
  const row = one('SELECT * FROM messages WHERE id = ?', id);
  return row ? messages([row], viewerId)[0] : null;
}

module.exports = { user, channel, role, member, server, dmChannel, messages, message };
