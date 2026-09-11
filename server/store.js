'use strict';

// Everything the account service remembers, behind one object.
//
// SQLite through node:sqlite, so the service is a single Node process with a
// single file next to it and nothing to provision. The relay that meters cloud
// transcription writes `usage`; this service only reads it.

const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  plan TEXT NOT NULL DEFAULT 'free',
  plan_expires_at TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS login_codes (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  ip TEXT NOT NULL DEFAULT '',
  attempts INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS login_codes_email ON login_codes (email, created_at);
CREATE INDEX IF NOT EXISTS login_codes_ip ON login_codes (ip, created_at);
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL REFERENCES users (id),
  device TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE TABLE IF NOT EXISTS usage (
  user_id INTEGER NOT NULL REFERENCES users (id),
  period TEXT NOT NULL,
  seconds INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, period)
);
`;

function createStore(file) {
  const db = new DatabaseSync(file || ':memory:');
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);

  const q = {
    userByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
    userById: db.prepare('SELECT * FROM users WHERE id = ?'),
    insertUser: db.prepare('INSERT INTO users (email, plan, created_at) VALUES (?, ?, ?)'),
    setPlan: db.prepare('UPDATE users SET plan = ?, plan_expires_at = ? WHERE email = ?'),
    insertCode: db.prepare('INSERT INTO login_codes (email, code_hash, ip, expires_at, created_at) VALUES (?, ?, ?, ?, ?)'),
    latestCode: db.prepare('SELECT * FROM login_codes WHERE email = ? AND used_at IS NULL ORDER BY id DESC LIMIT 1'),
    bumpAttempts: db.prepare('UPDATE login_codes SET attempts = attempts + 1 WHERE id = ?'),
    useCode: db.prepare('UPDATE login_codes SET used_at = ? WHERE id = ?'),
    codesByEmailSince: db.prepare('SELECT COUNT(*) AS n FROM login_codes WHERE email = ? AND created_at >= ?'),
    codesByIpSince: db.prepare('SELECT COUNT(*) AS n FROM login_codes WHERE ip = ? AND created_at >= ?'),
    insertSession: db.prepare('INSERT INTO sessions (token_hash, user_id, device, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)'),
    sessionByHash: db.prepare('SELECT * FROM sessions WHERE token_hash = ? AND revoked_at IS NULL'),
    touchSession: db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?'),
    revokeSession: db.prepare('UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL'),
    revokeAll: db.prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL'),
    usage: db.prepare('SELECT seconds FROM usage WHERE user_id = ? AND period = ?'),
    addUsage: db.prepare('INSERT INTO usage (user_id, period, seconds) VALUES (?, ?, ?) ON CONFLICT (user_id, period) DO UPDATE SET seconds = seconds + excluded.seconds'),
    pruneCodes: db.prepare('DELETE FROM login_codes WHERE created_at < ?'),
  };

  return {
    findOrCreateUser(email, now) {
      const found = q.userByEmail.get(email);
      if (found) return found;
      q.insertUser.run(email, 'free', now);
      return q.userByEmail.get(email);
    },
    userByEmail: (email) => q.userByEmail.get(email) || null,
    userById: (id) => q.userById.get(id) || null,
    setPlan(email, plan, expiresAt) {
      return q.setPlan.run(plan, expiresAt || null, email).changes > 0;
    },
    createLoginCode(row) {
      q.insertCode.run(row.email, row.codeHash, row.ip || '', row.expiresAt, row.createdAt);
    },
    latestLoginCode: (email) => q.latestCode.get(email) || null,
    bumpAttempts: (id) => q.bumpAttempts.run(id),
    useLoginCode: (id, now) => q.useCode.run(now, id),
    codesForEmailSince: (email, since) => Number(q.codesByEmailSince.get(email, since).n),
    codesForIpSince: (ip, since) => Number(q.codesByIpSince.get(ip, since).n),
    createSession(row) {
      q.insertSession.run(row.tokenHash, row.userId, row.device || '', row.createdAt, row.createdAt);
    },
    sessionByTokenHash: (hash) => q.sessionByHash.get(hash) || null,
    touchSession: (id, now) => q.touchSession.run(now, id),
    revokeSession: (id, now) => q.revokeSession.run(now, id).changes > 0,
    revokeAllSessions: (userId, now) => q.revokeAll.run(now, userId).changes,
    usageSeconds(userId, period) {
      const row = q.usage.get(userId, period);
      return row ? Number(row.seconds) : 0;
    },
    addUsageSeconds: (userId, period, seconds) => q.addUsage.run(userId, period, Math.max(0, Math.round(seconds))),
    pruneLoginCodes: (before) => q.pruneCodes.run(before).changes,
    close: () => db.close(),
  };
}

module.exports = { createStore };
