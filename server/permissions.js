// Permissions, Discord-style:
//  - Each role has a set of permission flags; a member gets the OR of the
//    @everyone role and all their roles.
//  - Roles are ordered. You can only manage members and roles that sit
//    below your own highest role (the owner can manage everything).
//  - Channels can override permissions per role or per member: deny first,
//    then allow, with member overrides winning. That's how private and
//    read-only channels work.
//  - Members in a timeout keep read access but can't post, react or talk.
//  - Channels brought over by an import are hidden ("pending review") from
//    everyone except the owner and Administrators until they're opened up.
'use strict';
const { one, all } = require('./db');

const P = {
  VIEW_CHANNELS:    1 << 0,
  SEND_MESSAGES:    1 << 1,
  ATTACH_FILES:     1 << 2,
  ADD_REACTIONS:    1 << 3,
  MANAGE_MESSAGES:  1 << 4,
  MANAGE_CHANNELS:  1 << 5,
  MANAGE_ROLES:     1 << 6,
  MANAGE_SERVER:    1 << 7,
  CREATE_INVITE:    1 << 8,
  KICK_MEMBERS:     1 << 9,
  BAN_MEMBERS:      1 << 10,
  CONNECT:          1 << 11, // join voice
  SPEAK:            1 << 12,
  VIDEO:            1 << 13, // camera and screen share
  MODERATE_MEMBERS: 1 << 14, // timeouts and the server's report queue
  VIEW_AUDIT_LOG:   1 << 15,
  ADMINISTRATOR:    1 << 30, // bypasses every check
};
const ALL = Object.values(P).reduce((a, b) => a | b, 0);

const DEFAULT_EVERYONE =
  P.VIEW_CHANNELS | P.SEND_MESSAGES | P.ATTACH_FILES | P.ADD_REACTIONS |
  P.CREATE_INVITE | P.CONNECT | P.SPEAK | P.VIDEO;

// What a timeout takes away.
const TIMEOUT_STRIPS = P.SEND_MESSAGES | P.ADD_REACTIONS | P.ATTACH_FILES | P.CONNECT | P.SPEAK | P.VIDEO | P.CREATE_INVITE;

function memberRow(serverId, userId) {
  return one('SELECT timeout_until FROM members WHERE server_id = ? AND user_id = ?', serverId, userId);
}

function isTimedOut(m) {
  return !!(m && m.timeout_until && m.timeout_until > Date.now());
}

function roleIdsOf(serverId, userId) {
  return all('SELECT role_id FROM member_roles WHERE server_id = ? AND user_id = ?', serverId, userId).map((r) => r.role_id);
}

// Server-wide permissions (before channel overrides).
function memberPermissions(serverId, userId) {
  const server = one('SELECT owner_id FROM servers WHERE id = ?', serverId);
  if (!server) return 0;
  const m = memberRow(serverId, userId);
  if (!m) return 0;
  if (server.owner_id === userId) return ALL;
  let perms = 0;
  const roles = all(
    `SELECT permissions FROM roles WHERE server_id = ? AND (is_default = 1 OR id IN
       (SELECT role_id FROM member_roles WHERE server_id = ? AND user_id = ?))`,
    serverId, serverId, userId);
  for (const r of roles) perms |= r.permissions;
  if (perms & P.ADMINISTRATOR) return ALL;
  if (isTimedOut(m)) perms &= ~TIMEOUT_STRIPS;
  return perms;
}

// Permissions inside one channel.
function channelPermissions(channel, userId) {
  const serverId = channel.server_id;
  const base = memberPermissions(serverId, userId);
  if (!base) return 0;
  // Age limits apply to everyone, owners and admins included.
  if (ageBlock(channel, userId)) return 0;
  if ((base & P.ADMINISTRATOR) || one('SELECT 1 FROM servers WHERE id = ? AND owner_id = ?', serverId, userId)) return ALL;
  // Imported channels stay hidden from everyone but the owner and
  // Administrators until someone reviews their permissions and opens them up.
  if (channel.pending_review) return 0;
  const overrides = all('SELECT target_type, target_id, allow, deny FROM channel_overrides WHERE channel_id = ?', channel.id);
  if (!overrides.length) return base;
  let perms = base;
  const everyone = one('SELECT id FROM roles WHERE server_id = ? AND is_default = 1', serverId);
  const eo = overrides.find((o) => o.target_type === 'role' && everyone && o.target_id === everyone.id);
  if (eo) { perms &= ~eo.deny; perms |= eo.allow; }
  const mine = new Set(roleIdsOf(serverId, userId));
  let allow = 0; let deny = 0;
  for (const o of overrides) {
    if (o.target_type === 'role' && mine.has(o.target_id)) { allow |= o.allow; deny |= o.deny; }
  }
  perms &= ~deny; perms |= allow;
  const mo = overrides.find((o) => o.target_type === 'member' && o.target_id === userId);
  if (mo) { perms &= ~mo.deny; perms |= mo.allow; }
  if (isTimedOut(memberRow(serverId, userId))) perms &= ~TIMEOUT_STRIPS;
  // Without View Channels, nothing else in the channel applies.
  if (!(perms & P.VIEW_CHANNELS)) return 0;
  return perms;
}

// ---------- age-restricted content ----------
// Channels (or whole servers) can be rated 18+ or 21+. Only people whose
// date of birth shows they're old enough can see them. Date of birth is
// stored encrypted and can only be set once by the user.
let secrets = null;
function ageOf(userId) {
  const r = one('SELECT birthdate_enc FROM users WHERE id = ?', userId);
  if (!r || !r.birthdate_enc) return null;
  secrets = secrets || require('./secrets');
  return ageFromDate(secrets.decryptText('birthdate', r.birthdate_enc));
}
function ageFromDate(iso, now = new Date()) {
  const [y, m, d] = String(iso).split('-').map(Number);
  let age = now.getUTCFullYear() - y;
  if (now.getUTCMonth() + 1 < m || (now.getUTCMonth() + 1 === m && now.getUTCDate() < d)) age--;
  return age;
}
function requiredAge(channel) {
  if (!channel.server_id) return 0;
  const s = one('SELECT age_rating FROM servers WHERE id = ?', channel.server_id);
  return Math.max(channel.age_rating || 0, s ? s.age_rating || 0 : 0);
}
// null = allowed; otherwise { required, known } (known: has a birth date on file)
function ageBlock(channel, userId) {
  const need = requiredAge(channel);
  if (!need) return null;
  const age = ageOf(userId);
  if (age !== null && age >= need) return null;
  return { required: need, known: age !== null };
}

// Highest role position a member holds (owner = Infinity).
function topPosition(serverId, userId) {
  if (one('SELECT 1 FROM servers WHERE id = ? AND owner_id = ?', serverId, userId)) return Infinity;
  const r = one(
    `SELECT MAX(r.position) AS p FROM member_roles mr JOIN roles r ON r.id = mr.role_id
     WHERE mr.server_id = ? AND mr.user_id = ?`, serverId, userId);
  return r && r.p !== null ? r.p : 0;
}

// Can actor take moderation action on target? (strictly higher role)
function outranks(serverId, actorId, targetId) {
  return topPosition(serverId, actorId) > topPosition(serverId, targetId);
}

function has(perms, flag) {
  return (perms & flag) === flag;
}

module.exports = {
  P, ALL, DEFAULT_EVERYONE, TIMEOUT_STRIPS, memberPermissions, channelPermissions,
  topPosition, outranks, has, isTimedOut, ageOf, ageFromDate, ageBlock, requiredAge,
};
