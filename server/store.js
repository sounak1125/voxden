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
  created_at TEXT NOT NULL,
  first_name TEXT NOT NULL DEFAULT '',
  last_name TEXT NOT NULL DEFAULT '',
  picture_url TEXT NOT NULL DEFAULT ''
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
-- What a free account has dictated in the seven-day period it is inside.
-- The desktop app owns this count -- free dictation is local and offline, so
-- the app enforces it -- and reports the figure when it next asks /v1/me.
-- This table exists only so the numbers can be seen; nothing reads it back to
-- the app. One row per account per period; a second PC reporting the same
-- period raises the figure rather than replacing it, so the higher of two
-- machines is what shows.
CREATE TABLE IF NOT EXISTS word_usage (
  user_id INTEGER NOT NULL REFERENCES users (id),
  period_start TEXT NOT NULL,
  words INTEGER NOT NULL DEFAULT 0,
  cap INTEGER NOT NULL DEFAULT 0,
  reported_at TEXT NOT NULL,
  PRIMARY KEY (user_id, period_start)
);
CREATE INDEX IF NOT EXISTS word_usage_period ON word_usage (period_start);
-- One row a day, written by the service. The other tables hold only what is
-- true now -- a plan that changed overwrote what it was -- so this is the
-- only place a trend can be read from later.
CREATE TABLE IF NOT EXISTS stat_days (
  day TEXT PRIMARY KEY,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
-- Small facts the service itself needs to remember between restarts, such as
-- the last week it posted a digest for.
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
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
  ['users', 'first_name', "TEXT NOT NULL DEFAULT ''"],
  ['users', 'last_name', "TEXT NOT NULL DEFAULT ''"],
  ['users', 'picture_url', "TEXT NOT NULL DEFAULT ''"],
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
    setProfile: db.prepare('UPDATE users SET first_name = ?, last_name = ?, picture_url = ? WHERE id = ?'),
    deleteUserSessions: db.prepare('DELETE FROM sessions WHERE user_id = ?'),
    deleteUserUsage: db.prepare('DELETE FROM usage WHERE user_id = ?'),
    deleteUserWordUsage: db.prepare('DELETE FROM word_usage WHERE user_id = ?'),
    deleteUserSubscriptions: db.prepare('DELETE FROM subscriptions WHERE user_id = ?'),
    detachUserFeedback: db.prepare('UPDATE feedback SET user_id = NULL WHERE user_id = ?'),
    deleteUserCodes: db.prepare('DELETE FROM login_codes WHERE email = ?'),
    deleteUserRow: db.prepare('DELETE FROM users WHERE id = ?'),
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
    addWordUsage: db.prepare('INSERT INTO word_usage (user_id, period_start, words, cap, reported_at) VALUES (?, ?, ?, ?, ?)'
      + ' ON CONFLICT (user_id, period_start) DO UPDATE SET words = MAX(words, excluded.words),'
      + ' cap = excluded.cap, reported_at = excluded.reported_at'),
    wordUsage: db.prepare('SELECT * FROM word_usage WHERE user_id = ? AND period_start = ?'),
    countUsers: db.prepare('SELECT COUNT(*) AS n FROM users'),
    countUsersSince: db.prepare('SELECT COUNT(*) AS n FROM users WHERE created_at >= ?'),
    countPaid: db.prepare("SELECT COUNT(*) AS n FROM users WHERE plan != 'free' AND (plan_expires_at IS NULL OR plan_expires_at > ?)"),
    countActive: db.prepare('SELECT COUNT(DISTINCT user_id) AS n FROM sessions WHERE revoked_at IS NULL AND last_seen_at >= ?'),
    cloudForPeriod: db.prepare('SELECT COALESCE(SUM(seconds), 0) AS seconds, COUNT(*) AS users FROM usage WHERE period = ?'),
    wordsSince: db.prepare('SELECT COUNT(*) AS accounts, COALESCE(SUM(words), 0) AS words,'
      + ' COALESCE(SUM(CASE WHEN cap > 0 AND words >= cap THEN 1 ELSE 0 END), 0) AS at_cap'
      + ' FROM word_usage WHERE period_start >= ?'),
    liveSubscriptions: db.prepare('SELECT provider, plan, COUNT(*) AS n FROM subscriptions'
      + ' WHERE status NOT IN (\'cancelled\', \'expired\', \'halted\', \'unpaid\') GROUP BY provider, plan'),
    putDay: db.prepare('INSERT INTO stat_days (day, body, created_at) VALUES (?, ?, ?)'
      + ' ON CONFLICT (day) DO UPDATE SET body = excluded.body, created_at = excluded.created_at'),
    dayBefore: db.prepare('SELECT * FROM stat_days WHERE day < ? ORDER BY day DESC LIMIT 1'),
    recentDays: db.prepare('SELECT * FROM stat_days ORDER BY day DESC LIMIT ?'),
    getMeta: db.prepare('SELECT value FROM meta WHERE key = ?'),
    putMeta: db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value'),
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
    setProfile(userId, profile) {
      const p = profile || {};
      return q.setProfile.run(String(p.firstName || ''), String(p.lastName || ''), String(p.pictureUrl || ''), userId).changes > 0;
    },
    // The account and everything held about it, in one transaction. Feedback
    // stays but no longer points at anyone.
    deleteUser(userId) {
      const user = q.userById.get(userId);
      if (!user) return false;
      db.exec('BEGIN');
      try {
        q.deleteUserSessions.run(userId);
        q.deleteUserUsage.run(userId);
        q.deleteUserWordUsage.run(userId);
        q.deleteUserSubscriptions.run(userId);
        q.detachUserFeedback.run(userId);
        q.deleteUserCodes.run(user.email);
        q.deleteUserRow.run(userId);
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
      return true;
    },
    usageSeconds(userId, period) {
      const row = q.usage.get(userId, period);
      return row ? Number(row.seconds) : 0;
    },
    usageSecondsTotal(userId) {
      return Number(q.usageTotal.get(userId).n) || 0;
    },
    addUsageSeconds: (userId, period, seconds) => q.addUsage.run(userId, period, Math.max(0, Math.round(seconds))),
    pruneLoginCodes: (before) => q.pruneCodes.run(before).changes,
    // The app's own figure for the seven days it is inside. Never additive:
    // the app holds the count, this only records what it last said.
    reportWordUsage(userId, periodStart, words, cap, now) {
      q.addWordUsage.run(userId, periodStart, Math.max(0, Math.round(words)), Math.max(0, Math.round(cap)), now);
    },
    wordUsage: (userId, periodStart) => q.wordUsage.get(userId, periodStart) || null,
    // --- the numbers ---------------------------------------------------------
    countUsers: () => Number(q.countUsers.get().n),
    countUsersSince: (since) => Number(q.countUsersSince.get(since).n),
    countPaid: (now) => Number(q.countPaid.get(now).n),
    countActiveSince: (since) => Number(q.countActive.get(since).n),
    cloudForPeriod(period) {
      const row = q.cloudForPeriod.get(period);
      return { seconds: Number(row.seconds) || 0, users: Number(row.users) || 0 };
    },
    wordsSince(since) {
      const row = q.wordsSince.get(since);
      return { accounts: Number(row.accounts) || 0, words: Number(row.words) || 0, atCap: Number(row.at_cap) || 0 };
    },
    liveSubscriptions: () => q.liveSubscriptions.all().map((row) => ({ provider: row.provider, plan: row.plan, count: Number(row.n) })),
    // One row a day. `day` is YYYY-MM-DD; writing the same day again replaces
    // it, so a service restarted twice in one day does not double-count.
    putStatDay: (day, body, now) => q.putDay.run(day, JSON.stringify(body), now),
    statDayBefore(day) {
      const row = q.dayBefore.get(day);
      if (!row) return null;
      try { return { day: row.day, body: JSON.parse(row.body) }; } catch (_) { return null; }
    },
    statDays: (limit) => q.recentDays.all(Math.max(1, Math.min(400, Number(limit) || 30))).map((row) => {
      try { return { day: row.day, body: JSON.parse(row.body) }; } catch (_) { return { day: row.day, body: null }; }
    }),
    meta(key) {
      const row = q.getMeta.get(String(key));
      return row ? String(row.value) : '';
    },
    setMeta: (key, value) => q.putMeta.run(String(key), String(value)),
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
