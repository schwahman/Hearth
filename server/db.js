// Database layer. Uses Node's built-in SQLite (node:sqlite) so there are
// zero third-party dependencies. Every query lives here so the storage
// engine can be swapped later (e.g. for a clustered database) without
// touching the rest of the server.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const config = require('./config');

fs.mkdirSync(config.dataDir, { recursive: true });
const db = new DatabaseSync(path.join(config.dataDir, 'hearth.db'));

// Several nodes on one machine can share this file; wait for locks
// instead of failing.
db.exec('PRAGMA busy_timeout = 5000;');
// Overwrite deleted data with zeros inside the database file, so deleted
// accounts and messages can't be recovered from the file afterwards.
db.exec('PRAGMA secure_delete = ON;');
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name  TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  avatar        TEXT,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS servers (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  owner_id   TEXT NOT NULL REFERENCES users(id),
  icon       TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS members (
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  nickname  TEXT,
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (server_id, user_id)
);

CREATE TABLE IF NOT EXISTS bans (
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason    TEXT,
  PRIMARY KEY (server_id, user_id)
);

CREATE TABLE IF NOT EXISTS roles (
  id          TEXT PRIMARY KEY,
  server_id   TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  color       TEXT,
  permissions INTEGER NOT NULL DEFAULT 0,
  position    INTEGER NOT NULL DEFAULT 0,
  is_default  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS member_roles (
  server_id TEXT NOT NULL,
  user_id   TEXT NOT NULL,
  role_id   TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  PRIMARY KEY (server_id, user_id, role_id)
);

-- server_id is NULL for direct-message channels
CREATE TABLE IF NOT EXISTS channels (
  id         TEXT PRIMARY KEY,
  server_id  TEXT REFERENCES servers(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  type       TEXT NOT NULL CHECK (type IN ('text','voice','dm')),
  topic      TEXT,
  position   INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS dm_recipients (
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (channel_id, user_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id          TEXT PRIMARY KEY,
  channel_id  TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  author_id   TEXT NOT NULL REFERENCES users(id),
  content     TEXT NOT NULL DEFAULT '',
  attachments TEXT,
  reply_to    TEXT,
  created_at  INTEGER NOT NULL,
  edited_at   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id, id);

CREATE TABLE IF NOT EXISTS reactions (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji      TEXT NOT NULL,
  PRIMARY KEY (message_id, user_id, emoji)
);

CREATE TABLE IF NOT EXISTS invites (
  code       TEXT PRIMARY KEY,
  server_id  TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  creator_id TEXT NOT NULL REFERENCES users(id),
  uses       INTEGER NOT NULL DEFAULT 0,
  max_uses   INTEGER,
  expires_at INTEGER,
  created_at INTEGER NOT NULL
);
`);

// Sessions store only a SHA-256 hash of each login token.
db.exec(`
CREATE TABLE IF NOT EXISTS auth_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  last_seen  INTEGER NOT NULL,
  user_agent TEXT,
  ip         TEXT
);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions(user_id);
`);

// Migrate v0.1 sessions (raw tokens) to hashed ones, then drop the old table.
{
  const crypto = require('node:crypto');
  const old = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sessions'").get();
  if (old) {
    db.exec('BEGIN');
    try {
      const ins = db.prepare('INSERT OR IGNORE INTO auth_sessions (token_hash, user_id, created_at, last_seen) VALUES (?, ?, ?, ?)');
      for (const s of db.prepare('SELECT token, user_id, created_at FROM sessions').all()) {
        ins.run(crypto.createHash('sha256').update(s.token).digest('hex'), s.user_id, s.created_at, Date.now());
      }
      db.exec('DROP TABLE sessions');
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  }
}

// v0.3: channels can be categories. SQLite can't change a CHECK constraint,
// so the table is rebuilt once (following SQLite's documented procedure,
// with foreign keys paused so no messages are touched).
{
  const t = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'channels'").get();
  if (t && !t.sql.includes("'category'")) {
    const cols = db.prepare('PRAGMA table_info(channels)').all().map((c) => c.name);
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec('BEGIN');
    try {
      db.exec(`CREATE TABLE channels_v3 (
        id         TEXT PRIMARY KEY,
        server_id  TEXT REFERENCES servers(id) ON DELETE CASCADE,
        name       TEXT NOT NULL,
        type       TEXT NOT NULL CHECK (type IN ('text','voice','dm','category')),
        topic      TEXT,
        position   INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      )`);
      db.exec('INSERT INTO channels_v3 (id, server_id, name, type, topic, position, created_at) SELECT id, server_id, name, type, topic, position, created_at FROM channels');
      // Carry over any columns added later (slowmode, age rating, ...).
      const base = ['id', 'server_id', 'name', 'type', 'topic', 'position', 'created_at'];
      const extra = cols.filter((c) => !base.includes(c));
      for (const c of extra) {
        const info = db.prepare('PRAGMA table_info(channels)').all().find((x) => x.name === c);
        db.exec(`ALTER TABLE channels_v3 ADD COLUMN ${c} ${info.type}${info.notnull ? ` NOT NULL DEFAULT ${info.dflt_value}` : ''}`);
        db.exec(`UPDATE channels_v3 SET ${c} = (SELECT ${c} FROM channels WHERE channels.id = channels_v3.id)`);
      }
      db.exec('DROP TABLE channels');
      db.exec('ALTER TABLE channels_v3 RENAME TO channels');
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; } finally { db.exec('PRAGMA foreign_keys = ON'); }
  }
}

// Columns added after v0.1.
function addColumn(table, column, type) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}
addColumn('users', 'terms_accepted_at', 'INTEGER');
addColumn('users', 'email_enc', 'TEXT');          // encrypted email address
addColumn('users', 'email_hash', 'TEXT');         // keyed hash, for lookups
addColumn('users', 'email_verified_at', 'INTEGER');
addColumn('users', 'is_admin', 'INTEGER NOT NULL DEFAULT 0'); // Hearth platform admin
addColumn('users', 'suspended_at', 'INTEGER');
addColumn('users', 'suspended_reason', 'TEXT');
addColumn('members', 'timeout_until', 'INTEGER');
addColumn('channels', 'slowmode', 'INTEGER NOT NULL DEFAULT 0');
addColumn('channels', 'age_rating', 'INTEGER NOT NULL DEFAULT 0'); // 0, 18 or 21
addColumn('servers', 'age_rating', 'INTEGER NOT NULL DEFAULT 0');
addColumn('users', 'birthdate_enc', 'TEXT');                     // encrypted YYYY-MM-DD
addColumn('messages', 'kind', 'TEXT');                           // null, 'me', 'roll', 'flip'
addColumn('channels', 'parent_id', 'TEXT');                      // category this channel sits in
addColumn('messages', 'import_source', 'TEXT');                  // 'discord' for imported history
addColumn('messages', 'imported_author', 'TEXT');                // JSON: original sender's name, id, avatar, bot
addColumn('messages', 'imported_reactions', 'TEXT');             // JSON: [{emoji, count}] from the original
addColumn('channels', 'pending_review', 'INTEGER NOT NULL DEFAULT 0'); // imported: hidden from members until the owner reviews it
addColumn('users', 'is_system', 'INTEGER NOT NULL DEFAULT 0');   // locked system accounts (e.g. the Discord archive)
db.exec(`
CREATE TABLE IF NOT EXISTS import_jobs (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  server_id   TEXT,
  source      TEXT NOT NULL,
  source_name TEXT,
  status      TEXT NOT NULL,
  options     TEXT NOT NULL,
  progress    TEXT NOT NULL,
  error       TEXT,
  created_at  INTEGER NOT NULL,
  finished_at INTEGER
);
-- Links original IDs to Hearth IDs so an interrupted import can resume
-- without duplicating anything.
CREATE TABLE IF NOT EXISTS import_map (
  job_id    TEXT NOT NULL,
  kind      TEXT NOT NULL,
  source_id TEXT NOT NULL,
  hearth_id TEXT NOT NULL,
  PRIMARY KEY (job_id, kind, source_id)
);
`);
// A Hearth always has a platform admin: if none exists yet, the oldest
// account (the person who set the server up) becomes it.
db.exec(`UPDATE users SET is_admin = 1 WHERE id = (SELECT id FROM users ORDER BY created_at LIMIT 1)
         AND NOT EXISTS (SELECT 1 FROM users WHERE is_admin = 1)`);

db.exec(`
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email_hash) WHERE email_hash IS NOT NULL;

-- One-time codes sent by email (verification, password reset, email change).
-- Only a hash of each code is stored.
CREATE TABLE IF NOT EXISTS email_codes (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose     TEXT NOT NULL,
  code_hash   TEXT NOT NULL,
  target_enc  TEXT,
  target_hash TEXT,
  attempts    INTEGER NOT NULL DEFAULT 0,
  expires_at  INTEGER NOT NULL,
  created_at  INTEGER NOT NULL
);

-- Backup codes for account recovery without email. Hashes only.
CREATE TABLE IF NOT EXISTS recovery_codes (
  user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  used_at   INTEGER,
  PRIMARY KEY (user_id, code_hash)
);

-- Per-channel permission overrides (private channels, read-only, etc.).
CREATE TABLE IF NOT EXISTS channel_overrides (
  channel_id  TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL CHECK (target_type IN ('role','member')),
  target_id   TEXT NOT NULL,
  allow       INTEGER NOT NULL DEFAULT 0,
  deny        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (channel_id, target_type, target_id)
);

-- What moderators did, viewable by people with View Audit Log.
CREATE TABLE IF NOT EXISTS audit_log (
  id          TEXT PRIMARY KEY,
  server_id   TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  actor_id    TEXT,
  action      TEXT NOT NULL,
  target_type TEXT,
  target_id   TEXT,
  target_name TEXT,
  reason      TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_server ON audit_log(server_id, created_at);

CREATE TABLE IF NOT EXISTS blocks (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, blocked_id)
);

-- Reports deliberately don't cascade-delete: they must survive the reported
-- content (and accounts) being deleted.
CREATE TABLE IF NOT EXISTS reports (
  id             TEXT PRIMARY KEY,
  reporter_id    TEXT,
  scope          TEXT NOT NULL CHECK (scope IN ('server','platform')),
  server_id      TEXT,
  channel_id     TEXT,
  target_type    TEXT NOT NULL,
  target_id      TEXT NOT NULL,
  target_user_id TEXT,
  category       TEXT NOT NULL,
  details        TEXT,
  evidence_id    TEXT,
  status         TEXT NOT NULL DEFAULT 'open',
  resolution     TEXT,
  handled_by     TEXT,
  created_at     INTEGER NOT NULL,
  handled_at     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_reports_scope ON reports(scope, status, created_at);

-- Encrypted copies of deleted content and report evidence, kept for a
-- limited time for safety and legal reasons, then purged automatically.
CREATE TABLE IF NOT EXISTS vault (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  user_id    TEXT,
  server_id  TEXT,
  label      TEXT,
  payload    BLOB NOT NULL,
  files      TEXT,
  created_at INTEGER NOT NULL,
  purge_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_vault_purge ON vault(purge_at);
CREATE INDEX IF NOT EXISTS idx_vault_user ON vault(user_id);
CREATE INDEX IF NOT EXISTS idx_vault_server ON vault(server_id);

CREATE TABLE IF NOT EXISTS legal_holds (
  id          TEXT PRIMARY KEY,
  target_type TEXT NOT NULL CHECK (target_type IN ('user','server')),
  target_id   TEXT NOT NULL,
  label       TEXT,
  reason      TEXT NOT NULL,
  created_by  TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  released_at INTEGER
);

-- Every time an admin opens protected data, it's recorded here.
CREATE TABLE IF NOT EXISTS admin_log (
  id         TEXT PRIMARY KEY,
  admin_id   TEXT NOT NULL,
  action     TEXT NOT NULL,
  target     TEXT,
  detail     TEXT,
  created_at INTEGER NOT NULL
);
`);

// Moves recently deleted data out of the write-ahead log into the (securely
// overwritten) main file, so nothing lingers there either.
function purgeLog() {
  try { db.exec('PRAGMA wal_checkpoint(TRUNCATE);'); } catch { /* busy; next checkpoint will do it */ }
}

// Small helpers so callers don't deal with prepared statements directly.
const cache = new Map();
function stmt(sql) {
  let s = cache.get(sql);
  if (!s) { s = db.prepare(sql); cache.set(sql, s); }
  return s;
}
const one = (sql, ...a) => stmt(sql).get(...a);
const all = (sql, ...a) => stmt(sql).all(...a);
const run = (sql, ...a) => stmt(sql).run(...a);

function tx(fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}

module.exports = { db, one, all, run, tx, purgeLog };
