// Permission bit flags. A role's permissions are these values OR'd
// together; a member's permissions are the OR of all their roles.
'use strict';
const { one, all } = require('./db');

const P = {
  VIEW_CHANNELS:   1 << 0,
  SEND_MESSAGES:   1 << 1,
  ATTACH_FILES:    1 << 2,
  ADD_REACTIONS:   1 << 3,
  MANAGE_MESSAGES: 1 << 4,
  MANAGE_CHANNELS: 1 << 5,
  MANAGE_ROLES:    1 << 6,
  MANAGE_SERVER:   1 << 7,
  CREATE_INVITE:   1 << 8,
  KICK_MEMBERS:    1 << 9,
  BAN_MEMBERS:     1 << 10,
  CONNECT:         1 << 11, // join voice
  SPEAK:           1 << 12,
  VIDEO:           1 << 13, // camera and screen share
  ADMINISTRATOR:   1 << 30, // bypasses every check
};
const ALL = Object.values(P).reduce((a, b) => a | b, 0);

// What a brand-new server's @everyone role can do.
const DEFAULT_EVERYONE =
  P.VIEW_CHANNELS | P.SEND_MESSAGES | P.ATTACH_FILES | P.ADD_REACTIONS |
  P.CREATE_INVITE | P.CONNECT | P.SPEAK | P.VIDEO;

function memberPermissions(serverId, userId) {
  const server = one('SELECT owner_id FROM servers WHERE id = ?', serverId);
  if (!server) return 0;
  if (!one('SELECT 1 FROM members WHERE server_id = ? AND user_id = ?', serverId, userId)) return 0;
  if (server.owner_id === userId) return ALL;

  let perms = 0;
  const roles = all(
    `SELECT r.permissions FROM roles r
     WHERE r.server_id = ? AND (r.is_default = 1 OR r.id IN
       (SELECT role_id FROM member_roles WHERE server_id = ? AND user_id = ?))`,
    serverId, serverId, userId);
  for (const r of roles) perms |= r.permissions;
  if (perms & P.ADMINISTRATOR) return ALL;
  return perms;
}

function has(perms, flag) {
  return (perms & flag) === flag;
}

module.exports = { P, ALL, DEFAULT_EVERYONE, memberPermissions, has };
