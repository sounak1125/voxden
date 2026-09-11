'use strict';

// The account service: who you are, and what your plan entitles you to.
//
// Sign-in is a six-digit code sent to an email address and typed into the app.
// No password to store, no OAuth client to register, and nothing for the
// desktop app to catch from a browser. A session is a random token the app
// keeps; only its hash is stored here, so a copy of the database signs nobody
// in.
//
//   POST /v1/auth/code     { email }                -> 204
//   POST /v1/auth/verify   { email, code, device }  -> 200 { token, account }
//   GET  /v1/me            Bearer token             -> 200 { account }
//   POST /v1/auth/signout  Bearer token             -> 204
//   GET  /healthz                                   -> 200 { ok: true }
//
// `account` is { email, plan, planExpiresAt, cloud: { hoursUsed, hoursCap,
// periodEnd }, serverTime }. The app caches it and treats it as the truth for
// a grace period, so a laptop on a plane keeps its plan.

const crypto = require('crypto');

const CODE_MINUTES = 10;
const CODE_ATTEMPTS = 5;
const CODES_PER_EMAIL_PER_HOUR = 5;
const CODES_PER_IP_PER_HOUR = 30;
const MAX_BODY_BYTES = 4096;
const DEFAULT_CLOUD_HOURS_CAP = 10;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function normalizeEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  return EMAIL_RE.test(email) && email.length <= 254 ? email : '';
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function sixDigits() {
  // 0..999999, uniform; randomInt is unbiased.
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

function iso(ms) {
  return new Date(ms).toISOString();
}

function periodOf(ms) {
  const d = new Date(ms);
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0');
}

function periodEndOf(ms) {
  const d = new Date(ms);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString();
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function createApp(options) {
  const opts = options || {};
  const store = opts.store;
  const mailer = opts.mailer;
  const now = opts.now || (() => Date.now());
  const cloudHoursCap = Number.isFinite(opts.cloudHoursCap) ? opts.cloudHoursCap : DEFAULT_CLOUD_HOURS_CAP;
  const log = opts.log || (() => {});
  if (!store || !mailer) throw new Error('createApp needs a store and a mailer');

  function accountFor(user) {
    const t = now();
    let plan = String(user.plan || 'free');
    let planExpiresAt = user.plan_expires_at || null;
    if (plan !== 'free' && planExpiresAt && Date.parse(planExpiresAt) <= t) {
      plan = 'free';
    }
    const seconds = store.usageSeconds(user.id, periodOf(t));
    return {
      email: user.email,
      plan,
      planExpiresAt: plan === 'free' ? null : planExpiresAt,
      cloud: {
        hoursUsed: Math.round((seconds / 3600) * 100) / 100,
        hoursCap: plan === 'free' ? 0 : cloudHoursCap,
        periodEnd: periodEndOf(t),
      },
      serverTime: iso(t),
    };
  }

  async function requestCode(body, ip) {
    const email = normalizeEmail(body.email);
    if (!email) throw new HttpError(400, 'Enter a valid email address.');
    const t = now();
    const hourAgo = iso(t - 3600e3);
    if (store.codesForEmailSince(email, hourAgo) >= CODES_PER_EMAIL_PER_HOUR
        || store.codesForIpSince(ip, hourAgo) >= CODES_PER_IP_PER_HOUR) {
      throw new HttpError(429, 'Too many codes requested. Wait an hour and try again.');
    }
    const code = sixDigits();
    store.createLoginCode({
      email, codeHash: sha256(email + ':' + code), ip,
      expiresAt: iso(t + CODE_MINUTES * 60e3), createdAt: iso(t),
    });
    await mailer.sendCode({ to: email, code, minutes: CODE_MINUTES });
    log('code sent to ' + email);
  }

  function verifyCode(body) {
    const email = normalizeEmail(body.email);
    const code = String(body.code || '').replace(/\D/g, '');
    if (!email || code.length !== 6) throw new HttpError(400, 'Enter the six-digit code from the email.');
    const t = now();
    const row = store.latestLoginCode(email);
    const expired = !row || Date.parse(row.expires_at) <= t;
    if (expired) throw new HttpError(400, 'That code has expired. Request a new one.');
    if (row.attempts >= CODE_ATTEMPTS) {
      throw new HttpError(400, 'Too many wrong attempts. Request a new code.');
    }
    const expect = Buffer.from(row.code_hash, 'hex');
    const got = Buffer.from(sha256(email + ':' + code), 'hex');
    if (expect.length !== got.length || !crypto.timingSafeEqual(expect, got)) {
      store.bumpAttempts(row.id);
      throw new HttpError(400, 'That code is not right. Check the email and try again.');
    }
    store.useLoginCode(row.id, iso(t));
    const user = store.findOrCreateUser(email, iso(t));
    const token = crypto.randomBytes(32).toString('base64url');
    store.createSession({
      tokenHash: sha256(token), userId: user.id,
      device: String(body.device || '').slice(0, 120), createdAt: iso(t),
    });
    log('session created for ' + email);
    return { token, account: accountFor(user) };
  }

  function sessionFrom(req) {
    const header = String(req.headers.authorization || '');
    const match = /^Bearer\s+([A-Za-z0-9_-]{20,200})$/.exec(header);
    if (!match) throw new HttpError(401, 'Sign in again.');
    const session = store.sessionByTokenHash(sha256(match[1]));
    if (!session) throw new HttpError(401, 'Sign in again.');
    const user = store.userById(session.user_id);
    if (!user) throw new HttpError(401, 'Sign in again.');
    return { session, user };
  }

  function me(req) {
    const { session, user } = sessionFrom(req);
    store.touchSession(session.id, iso(now()));
    return { account: accountFor(user) };
  }

  function signOut(req) {
    const { session } = sessionFrom(req);
    store.revokeSession(session.id, iso(now()));
  }

  function readJson(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          // Drain rather than destroy: a destroyed socket takes the 413 with
          // it, and the client sees a dropped connection instead of an answer.
          req.removeAllListeners('data');
          req.resume();
          reject(new HttpError(413, 'Request too large.'));
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        if (!chunks.length) return resolve({});
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          resolve(parsed && typeof parsed === 'object' ? parsed : {});
        } catch (_) {
          reject(new HttpError(400, 'Send JSON.'));
        }
      });
      req.on('error', reject);
    });
  }

  function send(res, status, body) {
    const payload = body === undefined ? '' : JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Length': Buffer.byteLength(payload),
    });
    res.end(payload);
  }

  function clientIp(req) {
    // Behind a reverse proxy the socket address is the proxy's; the proxy is
    // configured to set this header and to overwrite any the client sent.
    const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    return forwarded || (req.socket && req.socket.remoteAddress) || '';
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const route = req.method + ' ' + url.pathname;
    try {
      if (route === 'GET /healthz') return send(res, 200, { ok: true });
      if (route === 'POST /v1/auth/code') {
        await requestCode(await readJson(req), clientIp(req));
        return send(res, 204);
      }
      if (route === 'POST /v1/auth/verify') {
        return send(res, 200, verifyCode(await readJson(req)));
      }
      if (route === 'GET /v1/me') return send(res, 200, me(req));
      if (route === 'POST /v1/auth/signout') {
        signOut(req);
        return send(res, 204);
      }
      return send(res, 404, { error: 'Not found.' });
    } catch (err) {
      if (err instanceof HttpError) return send(res, err.status, { error: err.message });
      log('error on ' + route + ': ' + ((err && err.stack) || err));
      return send(res, 500, { error: 'Something went wrong on our side. Try again in a minute.' });
    }
  }

  return { handle, requestCode, verifyCode, accountFor, CODE_MINUTES };
}

module.exports = { createApp, normalizeEmail, periodOf, HttpError };
