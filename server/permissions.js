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

// ---------- the permission engine ----------
// One set of rules decides what someone can do. The same code enforces
// permissions and powers "View as" / "Why can't they?", so the preview can
// never disagree with what actually happens.
//
// who: { roleIds: Set, userId?, owner?, timedOut? }

// Server-wide permissions from @everyone plus the given roles.
function rolePermissions(serverId, who) {
  if (who.owner) return { perms: ALL, why: 'server owner' };
  const roles = all('SELECT id, name, permissions, is_default FROM roles WHERE server_id = ?', serverId)
    .filter((r) => r.is_default || who.roleIds.has(r.id));
  let perms = 0;
  for (const r of roles) perms |= r.permissions;
  if (perms & P.ADMINISTRATOR) return { perms: ALL, why: `Administrator (${roles.filter((r) => r.permissions & P.ADMINISTRATOR).map((r) => r.name).join(', ')})` };
  if (who.timedOut) perms &= ~TIMEOUT_STRIPS;
  return { perms, roles };
}

// The capabilities "Why" explains, in plain words.
const EXPLAIN = { view: P.VIEW_CHANNELS, send: P.SEND_MESSAGES, connect: P.CONNECT, speak: P.SPEAK, video: P.VIDEO, manageMessages: P.MANAGE_MESSAGES };

// Permissions in one channel, optionally with the reason for each key
// capability (which rule decided it).
function resolveChannel(channel, who, { explain = false, ageBlocked = false } = {}) {
  const reasons = {};
  const all1 = (why) => { if (explain) for (const k of Object.keys(EXPLAIN)) reasons[k] = why; };
  if (ageBlocked) { all1(`this channel is ${requiredAge(channel)}+ only`); return { perms: 0, reasons }; }
  const base = rolePermissions(channel.server_id, who);
  if (base.why) { all1(base.why); return { perms: ALL, reasons }; }
  if (channel.pending_review) { all1('it’s an imported channel still waiting for review'); return { perms: 0, reasons }; }
  let perms = base.perms;
  if (explain) {
    const names = base.roles.map((r) => r.name);
    for (const [k, bit] of Object.entries(EXPLAIN)) {
      const from = base.roles.filter((r) => r.permissions & bit).map((r) => r.name);
      reasons[k] = perms & bit ? `role permissions (${from.join(', ')})` : `none of their roles (${names.join(', ')}) allow it`;
    }
  }
  const overrides = all('SELECT target_type, target_id, allow, deny FROM channel_overrides WHERE channel_id = ?', channel.id);
  const step = (allow, deny, label) => {
    const before = perms;
    perms = (perms & ~deny) | allow;
    if (explain) {
      for (const [k, bit] of Object.entries(EXPLAIN)) {
        if ((allow | deny) & bit) reasons[k] = `${perms & bit ? 'allowed' : 'blocked'} in this channel for ${label}`;
      }
    }
    return before !== perms;
  };
  if (overrides.length) {
    const everyone = one('SELECT id FROM roles WHERE server_id = ? AND is_default = 1', channel.server_id);
    const eo = overrides.find((o) => o.target_type === 'role' && everyone && o.target_id === everyone.id);
    if (eo) step(eo.allow, eo.deny, '@everyone');
    let allow = 0; let deny = 0; const which = [];
    for (const o of overrides) {
      if (o.target_type === 'role' && who.roleIds.has(o.target_id) && (!everyone || o.target_id !== everyone.id)) {
        allow |= o.allow; deny |= o.deny; which.push(o.target_id);
      }
    }
    if (which.length) {
      const names = all(`SELECT name FROM roles WHERE id IN (${which.map(() => '?').join(',')})`, ...which).map((r) => r.name);
      step(allow, deny, `their role${names.length > 1 ? 's' : ''} ${names.join(', ')}`);
    }
    const mo = who.userId && overrides.find((o) => o.target_type === 'member' && o.target_id === who.userId);
    if (mo) step(mo.allow, mo.deny, 'them personally');
  }
  if (who.timedOut) {
    perms &= ~TIMEOUT_STRIPS;
    if (explain) for (const [k, bit] of Object.entries(EXPLAIN)) if (bit & TIMEOUT_STRIPS) reasons[k] = 'they’re timed out';
  }
  // Without View Channels, nothing else in the channel applies.
  if (!(perms & P.VIEW_CHANNELS)) {
    if (explain) for (const k of Object.keys(EXPLAIN)) if (k !== 'view') reasons[k] = 'they can’t see this channel';
    return { perms: 0, reasons };
  }
  return { perms, reasons };
}

// The real member's situation, from the database.
function whoIs(serverId, userId) {
  const server = one('SELECT owner_id FROM servers WHERE id = ?', serverId);
  if (!server) return null;
  const m = memberRow(serverId, userId);
  if (!m) return null;
  return { userId, owner: server.owner_id === userId, timedOut: isTimedOut(m), roleIds: new Set(roleIdsOf(serverId, userId)) };
}

// Server-wide permissions (before channel overrides).
function memberPermissions(serverId, userId) {
  const who = whoIs(serverId, userId);
  return who ? rolePermissions(serverId, who).perms : 0;
}

// Permissions inside one channel.
function channelPermissions(channel, userId) {
  const who = whoIs(channel.server_id, userId);
  if (!who) return 0;
  // Age limits apply to everyone, owners and admins included.
  return resolveChannel(channel, who, { ageBlocked: !!ageBlock(channel, userId) }).perms;
}

// "View as": what a member, or anyone with a given set of roles, can do.
function preview(serverId, { userId, roleIds }) {
  let who;
  if (userId) {
    who = whoIs(serverId, userId);
    if (!who) return null;
  } else {
    const valid = new Set(all('SELECT id FROM roles WHERE server_id = ? AND is_default = 0', serverId).map((r) => r.id));
    who = { roleIds: new Set((roleIds || []).filter((id) => valid.has(id))), owner: false, timedOut: false };
  }
  const base = rolePermissions(serverId, who);
  const channels = all(`SELECT * FROM channels WHERE server_id = ? ORDER BY position, id`, serverId).map((c) => {
    // Age limits aren't shown here: they'd reveal someone's age to moderators.
    const r = resolveChannel(c, who, { explain: true });
    return { id: c.id, perms: r.perms, reasons: r.reasons, ageRating: requiredAge(c) };
  });
  return { serverPerms: base.perms, owner: !!who.owner, timedOut: !!who.timedOut, roleIds: [...who.roleIds], channels };
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
  P, ALL, DEFAULT_EVERYONE, TIMEOUT_STRIPS, memberPermissions, channelPermissions, preview, resolveChannel,
  topPosition, outranks, has, isTimedOut, ageOf, ageFromDate, ageBlock, requiredAge,
};
