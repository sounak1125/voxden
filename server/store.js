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
CREATE TABLE IF NOT EXISTS subscriptions (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users (id),
  provider TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  plan TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT '',
  period_end TEXT,
  manage_url TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  UNIQUE (provider, provider_id)
);
CREATE INDEX IF NOT EXISTS subscriptions_user ON subscriptions (user_id, updated_at);
CREATE TABLE IF NOT EXISTS billing_events (
  id INTEGER PRIMARY KEY,
  provider TEXT NOT NULL,
  event_key TEXT NOT NULL,
  received_at TEXT NOT NULL,
  UNIQUE (provider, event_key)
);
CREATE TABLE IF NOT EXISTS feedback (
  id INTEGER PRIMARY KEY,
  user_id INTEGER REFERENCES users (id),
  email TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL,
  message TEXT NOT NULL,
  diagnostics TEXT NOT NULL DEFAULT '',
  ip TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  thread_id TEXT NOT NULL DEFAULT '',
  message_id TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open',
  resolved_at TEXT,
  resolved_by TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS feedback_ip ON feedback (ip, created_at);
`;

// Columns added after a table first shipped. CREATE TABLE IF NOT EXISTS
// leaves an existing table alone, so each is added on its own when missing.
const MIGRATIONS = [
  ['feedback', 'thread_id', "TEXT NOT NULL DEFAULT ''"],
  ['feedback', 'message_id', "TEXT NOT NULL DEFAULT ''"],
  ['feedback', 'status', "TEXT NOT NULL DEFAULT 'open'"],
  ['feedback', 'resolved_at', 'TEXT'],
  ['feedback', 'resolved_by', "TEXT NOT NULL DEFAULT ''"],
];

function migrate(db) {
  for (const [table, column, type] of MIGRATIONS) {
    const columns = db.prepare('PRAGMA table_info(' + table + ')').all().map((row) => row.name);
    if (!columns.includes(column)) db.exec('ALTER TABLE ' + table + ' ADD COLUMN ' + column + ' ' + type);
  }
  // Indexes on migrated columns can only exist once the columns do.
  db.exec('CREATE INDEX IF NOT EXISTS feedback_thread ON feedback (thread_id);');
}

function createStore(file) {
  const db = new DatabaseSync(file || ':memory:');
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  migrate(db);

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
    usageTotal: db.prepare('SELECT COALESCE(SUM(seconds), 0) AS n FROM usage WHERE user_id = ?'),
    addUsage: db.prepare('INSERT INTO usage (user_id, period, seconds) VALUES (?, ?, ?) ON CONFLICT (user_id, period) DO UPDATE SET seconds = seconds + excluded.seconds'),
    pruneCodes: db.prepare('DELETE FROM login_codes WHERE created_at < ?'),
    upsertSubscription: db.prepare('INSERT INTO subscriptions (user_id, provider, provider_id, plan, status, period_end, manage_url, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      + ' ON CONFLICT (provider, provider_id) DO UPDATE SET user_id = excluded.user_id, plan = CASE WHEN excluded.plan = \'\' THEN plan ELSE excluded.plan END,'
      + ' status = excluded.status, period_end = excluded.period_end, manage_url = CASE WHEN excluded.manage_url = \'\' THEN manage_url ELSE excluded.manage_url END, updated_at = excluded.updated_at'),
    latestSubscription: db.prepare('SELECT * FROM subscriptions WHERE user_id = ? ORDER BY updated_at DESC, id DESC LIMIT 1'),
    insertBillingEvent: db.prepare('INSERT OR IGNORE INTO billing_events (provider, event_key, received_at) VALUES (?, ?, ?)'),
    insertFeedback: db.prepare('INSERT INTO feedback (user_id, email, kind, message, diagnostics, ip, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'),
    feedbackByIpSince: db.prepare('SELECT COUNT(*) AS n FROM feedback WHERE ip = ? AND created_at >= ?'),
    recentFeedback: db.prepare('SELECT * FROM feedback ORDER BY id DESC LIMIT ?'),
    feedbackById: db.prepare('SELECT * FROM feedback WHERE id = ?'),
    feedbackByThread: db.prepare('SELECT * FROM feedback WHERE thread_id = ? ORDER BY id DESC LIMIT 1'),
    setFeedbackThread: db.prepare('UPDATE feedback SET thread_id = ?, message_id = ? WHERE id = ?'),
    setFeedbackStatus: db.prepare('UPDATE feedback SET status = ?, resolved_at = ?, resolved_by = ? WHERE id = ?'),
    openFeedback: db.prepare("SELECT * FROM feedback WHERE status = 'open' ORDER BY id DESC LIMIT ?"),
    openFeedbackCount: db.prepare("SELECT COUNT(*) AS n FROM feedback WHERE status = 'open'"),
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
    usageSecondsTotal(userId) {
      return Number(q.usageTotal.get(userId).n) || 0;
    },
    addUsageSeconds: (userId, period, seconds) => q.addUsage.run(userId, period, Math.max(0, Math.round(seconds))),
    pruneLoginCodes: (before) => q.pruneCodes.run(before).changes,
    upsertSubscription(row) {
      q.upsertSubscription.run(row.userId, row.provider, row.providerId, row.plan || '', row.status || '',
        row.periodEnd || null, row.manageUrl || '', row.updatedAt);
    },
    subscriptionForUser: (userId) => q.latestSubscription.get(userId) || null,
    // True the first time an event key is seen; a provider's retry is false.
    recordBillingEvent: (provider, key, now) => q.insertBillingEvent.run(provider, key, now).changes > 0,
    // Returns the new report's id.
    createFeedback(row) {
      return Number(q.insertFeedback.run(row.userId || null, row.email || '', row.kind, row.message, row.diagnostics || '', row.ip || '', row.createdAt).lastInsertRowid);
    },
    feedbackForIpSince: (ip, since) => Number(q.feedbackByIpSince.get(ip, since).n),
    recentFeedback: (limit) => q.recentFeedback.all(Math.max(1, Math.min(200, Number(limit) || 20))),
    feedbackById: (id) => q.feedbackById.get(id) || null,
    feedbackByThread: (threadId) => q.feedbackByThread.get(String(threadId)) || null,
    setFeedbackThread: (id, threadId, messageId) => q.setFeedbackThread.run(String(threadId || ''), String(messageId || ''), id).changes > 0,
    setFeedbackStatus: (id, status, resolvedAt, resolvedBy) => q.setFeedbackStatus.run(status, resolvedAt || null, resolvedBy || '', id).changes > 0,
    openFeedback: (limit) => q.openFeedback.all(Math.max(1, Math.min(200, Number(limit) || 25))),
    openFeedbackCount: () => Number(q.openFeedbackCount.get().n),
    close: () => db.close(),
  };
}

module.exports = { createStore };
