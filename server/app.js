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
//   GET  /v1/auth/options                           -> 200 { google: { clientId } | null }
//   POST /v1/auth/google   { code, codeVerifier, redirectUri, device } -> 200 { token, account }
//   GET  /v1/me            Bearer token             -> 200 { account }
//   POST /v1/me            Bearer + { freeWords }   -> 200 { account }
//   POST /v1/auth/signout  Bearer token             -> 204
//   POST /v1/transcribe    Bearer + { audio, format, language, terms }
//                                                   -> 200 { text, seconds, cloud }
//   GET  /v1/billing/options                        -> 200 { options }
//   POST /v1/billing/cancel    Bearer               -> 200 { subscription, account }  (stops renewal, keeps the paid period)
//   POST /v1/billing/checkout  Bearer + { provider, plan } -> 200 { url }
//   GET  /v1/billing       Bearer token             -> 200 { subscription, account }
//   POST /v1/billing/webhook/:provider              -> 200 { ok }  (signed by the provider)
//   GET  /healthz                                   -> 200 { ok: true }
//
// `account` is { email, plan, planExpiresAt, cloud: { hoursUsed, hoursCap,
// periodEnd }, freeWeeklyWords, serverTime }. The app caches it and treats it
// as the truth for a grace period, so a laptop on a plane keeps its plan.
//
// freeWeeklyWords is the free plan's seven-day word allowance. Free dictation
// runs on the user's own PC and never reaches this service, so the app is what
// enforces it; the number is served from here only so it can be changed
// without shipping a build.

const crypto = require('crypto');
const { wavSeconds } = require('./cloud');
const { normalizePlan } = require('./billing');
const credits = require('../src/credits');
const quota = require('../src/quota');
const asr = require('../src/asr');

const CODE_MINUTES = 10;
const CODE_ATTEMPTS = 5;
const CODES_PER_EMAIL_PER_HOUR = 5;
const CODES_PER_IP_PER_HOUR = 30;
const MAX_BODY_BYTES = 4096;
// A 16 kHz mono 16-bit clip is 32 KB a second; base64 makes it 43 KB. Twelve
// megabytes is about four and a half minutes, far past any dictation.
const MAX_AUDIO_BODY_BYTES = 12 * 1024 * 1024;
const MAX_CLIP_SECONDS = 300;
const DEFAULT_CLOUD_HOURS_CAP = credits.DEFAULT_HOURS_CAP;
// How many words a free account may dictate in a seven-day period, on this
// PC's own model. The app enforces it -- free dictation never reaches this
// service -- but the number is served from here so it can be retuned for
// everyone without shipping a build.
const DEFAULT_FREE_WEEKLY_WORDS = quota.FREE_WEEKLY_WORDS;

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

// The claims inside a JWT, without checking its signature. Only for tokens
// this service received directly from their issuer.
function decodeJwtClaims(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  try {
    const json = Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const claims = JSON.parse(json);
    return claims && typeof claims === 'object' ? claims : null;
  } catch (_) {
    return null;
  }
}

// Subscription statuses after which no further charge is coming. 'cancelling'
// is ours: renewal stopped, paid period still running.
const ENDED_STATUSES = ['cancelling', 'cancelled', 'completed', 'expired', 'halted', 'paused', 'unpaid'];

const FEEDBACK_KINDS = ['bug', 'idea', 'other'];
const FEEDBACK_MAX_MESSAGE = 4000;
const FEEDBACK_MAX_DIAGNOSTICS = 2000;
const FEEDBACK_PER_IP_PER_HOUR = 10;

function createApp(options) {
  const opts = options || {};
  const store = opts.store;
  const mailer = opts.mailer;
  const now = opts.now || (() => Date.now());
  const cloudHoursCap = Number.isFinite(opts.cloudHoursCap) ? opts.cloudHoursCap : DEFAULT_CLOUD_HOURS_CAP;
  const cloudCreditsCap = Number.isFinite(opts.cloudCreditsCap) && opts.cloudCreditsCap > 0
    ? Math.round(opts.cloudCreditsCap)
    : credits.creditsFromHours(cloudHoursCap);
  const cloudCreditsReset = opts.cloudCreditsReset === 'never' ? 'never' : 'month';
  const freeWeeklyWords = Number.isFinite(opts.freeWeeklyWords) && opts.freeWeeklyWords > 0
    ? Math.round(opts.freeWeeklyWords)
    : DEFAULT_FREE_WEEKLY_WORDS;
  const log = opts.log || (() => {});
  // The upstream speech model. Optional: a service without one answers
  // /v1/transcribe with 503 and everything else works.
  const cloud = opts.cloud || null;
  // Payments. Optional too: without it the app shows no upgrade offer and
  // plans are set by hand with server/grant.js.
  const billing = opts.billing || null;
  // Where feedback goes beyond the table: Discord forum posts, when webhooks
  // are configured (discord.js).
  const discord = opts.discord || null;
  // Google sign-in. Optional: without a client, only the emailed code exists.
  const google = opts.google && opts.google.clientId && opts.google.clientSecret ? {
    clientId: String(opts.google.clientId),
    clientSecret: String(opts.google.clientSecret),
    tokenUrl: String(opts.google.tokenUrl || 'https://oauth2.googleapis.com/token'),
    fetchImpl: opts.google.fetchImpl || globalThis.fetch,
  } : null;
  if (!store || !mailer) throw new Error('createApp needs a store and a mailer');

  function accountFor(user) {
    const t = now();
    let plan = String(user.plan || 'free');
    let planExpiresAt = user.plan_expires_at || null;
    if (plan !== 'free' && planExpiresAt && Date.parse(planExpiresAt) <= t) {
      plan = 'free';
    }
    const seconds = plan === 'free'
      ? 0
      : (cloudCreditsReset === 'never' ? store.usageSecondsTotal(user.id) : store.usageSeconds(user.id, periodOf(t)));
    return {
      email: user.email,
      plan,
      planExpiresAt: plan === 'free' ? null : planExpiresAt,
      cloud: credits.meterFromSeconds(seconds, {
        creditsCap: plan === 'free' ? 0 : cloudCreditsCap,
        reset: cloudCreditsReset,
        periodEnd: periodEndOf(t),
      }),
      // The free plan's weekly word allowance. Sent whatever the plan is, so
      // an account that lapses out of Pro already knows the number.
      freeWeeklyWords,
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
    return openSession(email, body.device, t);
  }

  // A signed-in PC: the user row (created on first sign-in) and a fresh
  // session token. Shared by every sign-in route.
  function openSession(email, device, t) {
    const user = store.findOrCreateUser(email, iso(t));
    const token = crypto.randomBytes(32).toString('base64url');
    store.createSession({
      tokenHash: sha256(token), userId: user.id,
      device: String(device || '').slice(0, 120), createdAt: iso(t),
    });
    log('session created for ' + email);
    return { token, account: accountFor(user) };
  }

  // Which sign-in routes exist besides the emailed code. Public: the app asks
  // before it draws the sign-in page.
  function authOptions() {
    return { google: google ? { clientId: google.clientId } : null };
  }

  // Google sign-in, finished here. The app sends the authorization code from
  // the browser and its PKCE verifier; this service, which alone holds the
  // client secret, trades them with Google for the identity token. The
  // token arrives straight from Google over TLS, so its claims are checked
  // but its signature need not be re-verified.
  async function googleSignIn(body) {
    if (!google) throw Object.assign(new HttpError(503, 'Google sign-in is not set up on this service yet. Use your email instead.'), { code: 'unconfigured' });
    const code = String(body.code || '').trim();
    const codeVerifier = String(body.codeVerifier || '').trim();
    const redirectUri = String(body.redirectUri || '').trim();
    if (!code || !codeVerifier || !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/.test(redirectUri)) {
      throw new HttpError(400, 'Google sign-in did not finish. Try again from the app.');
    }
    let tokens = null;
    try {
      const res = await google.fetchImpl(google.tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: google.clientId, client_secret: google.clientSecret,
          code, code_verifier: codeVerifier, redirect_uri: redirectUri, grant_type: 'authorization_code',
        }).toString(),
      });
      tokens = await res.json().catch(() => null);
      if (!res.ok || !tokens || !tokens.id_token) {
        const detail = tokens && (tokens.error_description || tokens.error);
        log('google exchange refused: ' + (detail || res.status));
        throw new Error('refused');
      }
    } catch (err) {
      throw Object.assign(new HttpError(502, 'Google did not accept the sign-in. Try again.'), { code: 'provider' });
    }
    const claims = decodeJwtClaims(tokens.id_token);
    const t = now();
    const issuerOk = claims && ['accounts.google.com', 'https://accounts.google.com'].includes(String(claims.iss || ''));
    const audienceOk = claims && String(claims.aud || '') === google.clientId;
    const fresh = claims && Number(claims.exp) * 1000 > t;
    if (!issuerOk || !audienceOk || !fresh) throw new HttpError(400, 'Google sign-in did not finish. Try again from the app.');
    const email = normalizeEmail(claims.email);
    if (!email) throw new HttpError(400, 'Google did not share an email address for this account.');
    if (claims.email_verified !== true && claims.email_verified !== 'true') {
      throw new HttpError(400, 'Google has not verified ' + email + '. Verify it with Google, or sign in with an emailed code.');
    }
    return openSession(email, body.device, t);
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

  // A year either side of now. A report outside that is a clock this
  // service cannot reason about, and is dropped rather than stored.
  const REPORT_WINDOW_MS = 366 * 24 * 3600e3;
  const MAX_REPORTED_WORDS = 10e6;

  // The desktop app's own free-word meter, riding along on the plan check it
  // already makes every few hours. Free dictation is local and often offline,
  // so this is the only way the service ever learns how much of a free week
  // is used -- and what it learns is a count, never a word of anyone's text.
  // Nothing is sent back: the app remains the one that enforces the cap.
  function noteWordReport(user, report, t) {
    if (!report || typeof report !== 'object') return;
    const periodStart = Number(report.periodStart);
    const words = Number(report.used);
    const cap = Number(report.cap);
    if (!Number.isFinite(periodStart) || Math.abs(periodStart - t) > REPORT_WINDOW_MS) return;
    if (!Number.isFinite(words) || words < 0 || words > MAX_REPORTED_WORDS) return;
    store.reportWordUsage(user.id, iso(periodStart), words,
      Number.isFinite(cap) && cap > 0 ? Math.min(cap, MAX_REPORTED_WORDS) : 0, iso(t));
  }

  function me(req, body) {
    const { session, user } = sessionFrom(req);
    const t = now();
    store.touchSession(session.id, iso(t));
    noteWordReport(user, body && body.freeWords, t);
    return { account: accountFor(user) };
  }

  // A report from the app's Help menu. Anyone can send one; a signed-in
  // sender is attached to their account, and a bad token simply means
  // anonymous rather than a refusal. The report is stored first, so a
  // Discord problem never loses it.
  async function feedback(req, body, ip) {
    const kind = String(body.kind || '').trim().toLowerCase();
    if (!FEEDBACK_KINDS.includes(kind)) throw new HttpError(400, 'Say whether this is a bug, an idea, or something else.');
    const message = String(body.message || '').replace(/\r\n?/g, '\n').trim();
    if (!message) throw new HttpError(400, 'Write a few words first.');
    if (message.length > FEEDBACK_MAX_MESSAGE) throw new HttpError(400, 'Keep it under 4,000 characters.');
    let email = '';
    if (body.email) {
      email = normalizeEmail(body.email);
      if (!email) throw new HttpError(400, 'Enter a valid email address, or leave it empty.');
    }
    const t = now();
    if (store.feedbackForIpSince(ip, iso(t - 3600e3)) >= FEEDBACK_PER_IP_PER_HOUR) {
      throw new HttpError(429, 'That is plenty for one hour. Thank you; try again later.');
    }
    let user = null;
    if (req.headers.authorization) {
      try { user = sessionFrom(req).user; } catch (_) { user = null; }
    }
    if (!email && user) email = user.email;
    const diagnostics = body.diagnostics && typeof body.diagnostics === 'object'
      ? Object.entries(body.diagnostics)
        .filter(([, v]) => v !== '' && v !== null && v !== undefined)
        .map(([k, v]) => k + ': ' + String(v).slice(0, 200))
        .join('\n')
        .slice(0, FEEDBACK_MAX_DIAGNOSTICS)
      : '';
    const id = store.createFeedback({ userId: user ? user.id : null, email, kind, message, diagnostics, ip, createdAt: iso(t) });
    if (discord && discord.configured) {
      try {
        const posted = await discord.post({ id, kind, message, email, diagnostics, createdAt: iso(t) });
        if (posted && posted.threadId) store.setFeedbackThread(id, posted.threadId, posted.messageId);
      } catch (err) {
        log('feedback #' + id + ' stored but not posted to Discord: ' + ((err && err.message) || err));
      }
    }
  }

  function signOut(req) {
    const { session } = sessionFrom(req);
    store.revokeSession(session.id, iso(now()));
  }

  // The metered relay. Audio comes in as base64 WAV with the session token,
  // and goes out to the speech model under the server's key; the app never
  // holds that key. The clip is measured from its own WAV header before any
  // call is made, checked against the plan's monthly cap, and only then
  // forwarded. Seconds are charged on success, from the provider's figure
  // when it gives one and the header otherwise.
  async function transcribe(req, body) {
    const { session, user } = sessionFrom(req);
    if (!cloud || !cloud.configured) {
      throw Object.assign(new HttpError(503, 'Cloud transcription is not available right now.'), { code: 'unconfigured' });
    }
    const account = accountFor(user);
    if (account.plan !== 'pro') {
      throw Object.assign(new HttpError(402, 'Cloud transcription needs a Pro plan.'), { code: 'plan' });
    }
    const audioBase64 = String(body.audio || '');
    const format = String(body.format || 'wav').toLowerCase();
    if (format !== 'wav' || !audioBase64) throw new HttpError(400, 'Send base64 WAV audio.');
    const audio = Buffer.from(audioBase64, 'base64');
    const seconds = wavSeconds(audio);
    if (!(seconds > 0)) throw new HttpError(400, 'That is not a readable WAV clip.');
    if (seconds > MAX_CLIP_SECONDS) throw new HttpError(413, 'Clips over five minutes are not accepted.');
    const t = now();
    const period = periodOf(t);
    const capSeconds = credits.secondsFromCredits(cloudCreditsCap);
    const used = cloudCreditsReset === 'never'
      ? store.usageSecondsTotal(user.id)
      : store.usageSeconds(user.id, period);
    if (used + seconds > capSeconds) {
      throw Object.assign(new HttpError(402, credits.capMessage(account.cloud)), { code: 'cap' });
    }
    const terms = Array.isArray(body.terms) ? body.terms.slice(0, 100).map((x) => String(x || '').slice(0, 64)) : [];
    const language = asr.normalizeCloudLanguage(body.language);
    let result;
    try {
      result = await cloud.transcribe({ audioBase64, format, language, terms });
    } catch (err) {
      log('upstream failed for ' + user.email + ': ' + (err && err.message));
      throw Object.assign(new HttpError(502, (err && err.message) || 'The speech model failed.'), { code: err && err.code === 'timeout' ? 'timeout' : 'upstream' });
    }
    const charged = result.billedSeconds > 0 ? result.billedSeconds : seconds;
    // Whether anybody is still listening. The app gives a clip a few seconds
    // and then tells the user it timed out; the model sometimes answers after
    // that. Those words reach nobody, so they are not charged for them. The
    // provider still bills us for the inference, and absorbing that is the
    // right way round: a dictation the user never saw is not one they bought.
    // The socket, not the request: an IncomingMessage destroys itself once its
    // body has been read, so req.destroyed is true on every healthy call. The
    // connection outliving the handler is what says somebody is still there.
    const abandoned = req.aborted === true || !!(req.socket && req.socket.destroyed);
    if (!abandoned) store.addUsageSeconds(user.id, period, charged);
    store.touchSession(session.id, iso(t));
    const total = cloudCreditsReset === 'never'
      ? store.usageSecondsTotal(user.id)
      : store.usageSeconds(user.id, period);
    log('cloud transcribed ' + charged.toFixed(1) + 's for ' + user.email + ' in ' + (now() - t) + 'ms'
      + ' (' + Math.round(total) + 's metered' + (result.cost ? ', $' + result.cost.toFixed(4) : '')
      + (result.hintsDropped ? ', hints dropped after a 400' : '')
      + (abandoned ? ', NOT CHARGED: the app had stopped waiting' : '') + ')');
    return {
      text: result.text,
      seconds: Math.round(charged * 100) / 100,
      cloud: credits.meterFromSeconds(total, {
        creditsCap: cloudCreditsCap,
        reset: cloudCreditsReset,
        periodEnd: periodEndOf(t),
      }),
    };
  }

  // --- billing --------------------------------------------------------------

  function billingOptions() {
    return { options: billing ? billing.options().map(group => ({
      ...group,
      cloudHoursCap,
      cloudCreditsCap,
    })) : [] };
  }

  async function checkout(req, body) {
    const { user } = sessionFrom(req);
    if (!billing) throw Object.assign(new HttpError(503, 'Payments are not set up yet.'), { code: 'unconfigured' });
    try {
      const result = await billing.createCheckout({ provider: body.provider, plan: normalizePlan(body.plan), user });
      log('checkout started for ' + user.email + ' via ' + result.provider + ' ' + result.plan);
      return { url: result.url, provider: result.provider, plan: result.plan };
    } catch (err) {
      if (err && (err.code === 'provider' || err.code === 'plan')) throw new HttpError(400, err.message);
      log('checkout failed for ' + user.email + ': ' + ((err && err.message) || err));
      throw Object.assign(new HttpError(502, (err && err.message) || 'The payment provider did not answer.'), { code: 'provider' });
    }
  }

  function subscriptionView(sub) {
    if (!sub) return null;
    return {
      provider: sub.provider, plan: sub.plan, status: sub.status,
      periodEnd: sub.period_end, manageUrl: sub.manage_url,
      // Whether another charge is coming. Ended and cancelling both mean no.
      renews: !ENDED_STATUSES.includes(String(sub.status || '').toLowerCase()),
      label: billing ? billing.labelFor(sub.provider, sub.plan) : '',
    };
  }

  function billingStatus(req) {
    const { user } = sessionFrom(req);
    return { subscription: subscriptionView(store.subscriptionForUser(user.id)), account: accountFor(user) };
  }

  // Stop the subscription renewing. The paid period stays paid: the plan now
  // runs to exactly the period end, with no renewal grace, and the provider's
  // own webhook confirms the ending when it arrives. Asking twice is a no-op.
  async function cancelSubscription(req) {
    const { user } = sessionFrom(req);
    if (!billing) throw Object.assign(new HttpError(503, 'Payments are not set up yet.'), { code: 'unconfigured' });
    const sub = store.subscriptionForUser(user.id);
    if (!sub || ENDED_STATUSES.includes(String(sub.status || '').toLowerCase())) {
      if (sub && sub.status === 'cancelling') return billingStatus(req);
      throw new HttpError(404, 'There is no active subscription on this account.');
    }
    let result;
    try {
      result = await billing.cancel(sub.provider, sub.provider_id);
    } catch (err) {
      if (err && (err.code === 'provider' || err.code === 'subscription')) throw new HttpError(400, err.message);
      log('cancel failed for ' + user.email + ': ' + ((err && err.message) || err));
      throw Object.assign(new HttpError(502, (err && err.message) || 'The payment provider did not answer.'), { code: 'provider' });
    }
    const t = now();
    const periodEnd = result.periodEnd || (sub.period_end ? Date.parse(sub.period_end) : 0) || t;
    store.upsertSubscription({
      userId: user.id, provider: sub.provider, providerId: sub.provider_id, plan: sub.plan,
      status: 'cancelling', periodEnd: iso(periodEnd), manageUrl: sub.manage_url, updatedAt: iso(t),
    });
    store.setPlan(user.email, 'pro', iso(periodEnd));
    log('renewal cancelled for ' + user.email + ' via ' + sub.provider + '; paid through ' + iso(periodEnd));
    return billingStatus(req);
  }

  // A provider telling us what happened. Verified against the raw body, made
  // idempotent by event key, and reduced to one write on the user's plan.
  // Answers 200 for anything verified, including events we do not act on;
  // a provider retries non-2xx and there is nothing to retry.
  function webhook(providerId, req, raw) {
    if (!billing) throw new HttpError(503, 'Payments are not set up yet.');
    let event;
    try {
      event = billing.webhook(providerId, req.headers, raw);
    } catch (err) {
      if (err && err.code === 'signature') throw new HttpError(400, 'Bad signature.');
      if (err && err.code === 'body') throw new HttpError(400, 'Not JSON.');
      throw new HttpError(404, 'Unknown provider.');
    }
    if (!event) return { ok: true, handled: false };
    const t = now();
    if (!store.recordBillingEvent(providerId, event.eventKey, iso(t))) return { ok: true, handled: false, duplicate: true };
    let user = event.userId ? store.userById(event.userId) : null;
    if (!user && event.email) user = store.userByEmail(normalizeEmail(event.email));
    if (!user) {
      log('webhook ' + providerId + ' ' + event.type + ' for no known user (' + (event.email || 'no email') + ')');
      return { ok: true, handled: false };
    }
    const expiry = billing.planExpiryFor(event);
    store.upsertSubscription({
      userId: user.id, provider: providerId, providerId: event.providerId, plan: event.plan,
      status: event.status, periodEnd: event.periodEnd ? iso(event.periodEnd) : null,
      manageUrl: event.manageUrl, updatedAt: iso(t),
    });
    store.setPlan(user.email, 'pro', expiry ? iso(expiry) : iso(t));
    log('webhook ' + providerId + ' ' + event.type + ': ' + user.email + ' pro until ' + (expiry ? iso(expiry) : 'now'));
    return { ok: true, handled: true };
  }

  function readRaw(req, limit) {
    const max = Number(limit) > 0 ? Number(limit) : MAX_BODY_BYTES;
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > max) {
          req.removeAllListeners('data');
          req.resume();
          reject(new HttpError(413, 'Request too large.'));
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }

  function readJson(req, limit) {
    const max = Number(limit) > 0 ? Number(limit) : MAX_BODY_BYTES;
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > max) {
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
      if (route === 'GET /v1/auth/options') return send(res, 200, authOptions());
      if (route === 'POST /v1/auth/google') return send(res, 200, await googleSignIn(await readJson(req)));
      if (route === 'GET /v1/me') return send(res, 200, me(req));
      // The same answer, for a client that has a free-word figure to report.
      if (route === 'POST /v1/me') return send(res, 200, me(req, await readJson(req)));
      if (route === 'GET /v1/billing/options') return send(res, 200, billingOptions());
      if (route === 'POST /v1/billing/checkout') return send(res, 200, await checkout(req, await readJson(req)));
      if (route === 'GET /v1/billing') return send(res, 200, billingStatus(req));
      if (route === 'POST /v1/billing/cancel') return send(res, 200, await cancelSubscription(req));
      const hook = /^POST \/v1\/billing\/webhook\/([a-z]+)$/.exec(route);
      if (hook) return send(res, 200, webhook(hook[1], req, await readRaw(req, 256 * 1024)));
      if (route === 'POST /v1/transcribe') {
        return send(res, 200, await transcribe(req, await readJson(req, MAX_AUDIO_BODY_BYTES)));
      }
      if (route === 'POST /v1/auth/signout') {
        signOut(req);
        return send(res, 204);
      }
      if (route === 'POST /v1/feedback') {
        await feedback(req, await readJson(req), clientIp(req));
        return send(res, 204);
      }
      return send(res, 404, { error: 'Not found.' });
    } catch (err) {
      if (err instanceof HttpError) {
        return send(res, err.status, err.code ? { error: err.message, code: err.code } : { error: err.message });
      }
      log('error on ' + route + ': ' + ((err && err.stack) || err));
      return send(res, 500, { error: 'Something went wrong on our side. Try again in a minute.' });
    }
  }

  return { handle, requestCode, verifyCode, accountFor, CODE_MINUTES };
}

module.exports = { createApp, normalizeEmail, periodOf, HttpError };
