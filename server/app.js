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
//   GET  /v1/auth/options                           -> 200 { google: { clientId } | null, email: { configured } }
//   POST /v1/auth/google   { code, codeVerifier, redirectUri, device } -> 200 { token, account }
//   GET  /v1/me            Bearer token             -> 200 { account }
//   PUT  /v1/me/profile    Bearer + { firstName, lastName } -> 200 { account }
//   DELETE /v1/me          Bearer token             -> 204  (the account and everything held about it)
//   POST /v1/me            Bearer + { freeWords }   -> 200 { account }
//   POST /v1/auth/signout  Bearer token             -> 204
//   POST /v1/transcribe    Bearer + { audio, format, language, terms, lane?, dictation?, piece? }
//                                                   -> 200 { text, seconds, timing, cloud, trial? }
//   POST /v1/transcribe/warm[?lane=body]  Bearer    -> 204  (wakes the speech model; metered nothing)
//   POST /v1/transcribe/urgent Bearer + { dictation, pieces } -> 200 { hurried, early }  (metered nothing)
//   POST /v1/polish        Bearer + { text, terms, mode }  -> 200 { text, mode, credits, cloud, trial? }
//   POST /v1/corrections   Bearer + { text }        -> 200 { remove }  (pieces the speaker took back; metered nothing)
//   GET  /v1/billing/options   [Bearer]             -> 200 { region, options, unavailable? }  (the region's plans only)
//   POST /v1/billing/cancel    Bearer               -> 200 { subscription, account }  (stops renewal, keeps the paid period)
//   POST /v1/billing/checkout  Bearer + { provider, plan, region? } -> 200 { url }
//   GET  /v1/billing       Bearer token             -> 200 { subscription, account }
//   POST /v1/billing/webhook/:provider              -> 200 { ok }  (signed by the provider)
//   GET  /v1/billing/googleplay  Bearer             -> 200 { configured, productId?, accountId?, blocked? }  (the Android Play build)
//   POST /v1/billing/googleplay/purchase  Bearer + { productId, purchaseToken } -> 200 { subscription, account } | 202 { pending: true, ... }
//   POST /v1/billing/webhook/googleplay?key=...     -> 200 { ok }  (Pub/Sub push of Play's real-time notifications)
//   GET  /v1/support       public                   -> 200 { goalInr, raisedInr, contributions, deadline, usdInr, recent, open }
//   GET  /v1/support/stream public                  -> text/event-stream of the same, on connect and after each payment
//   POST /v1/support/order public + { amount, currency } -> 200 { orderId, keyId, amount, currency }
//   GET  /healthz                                   -> 200 { ok: true }
//
// The /v1/support routes are the only ones a web page may call: they
// answer CORS for the website's own origins (SUPPORT_ORIGINS), and nothing
// else here does.
//
// `account` is { email, plan, planExpiresAt, region, cloud: { creditsUsed, creditsCap,
// periodEnd, welcome, monthlyCredits, ... }, welcomeOffer, trial, freeWeeklyWords,
// serverTime }. The app caches it and treats it as the truth for a grace
// period, so a laptop on a plane keeps its plan.
//
// The cloud routes (/v1/transcribe, /v1/transcribe/warm, /v1/polish) are Pro's,
// and a refusal is a 402 whose `code` says why: `plan` (a free account with no
// trial on offer, or a plan that is neither), `cap` (Pro's credits for the month
// are spent) or `trial_used` (a free account's trial minutes are spent).
//
// /v1/transcribe also refuses a `language` the configured model cannot take
// (server/cloud.js resolveLanguage, applied while the model is AssemblyAI's):
// a 400 with code `language`, before any provider is called and with nothing
// charged. Without a `language` the model detects.
//
// The free trial is a one-time allowance of Voxden Cloud minutes for an account
// that has never paid -- `cloudTrialCredits` in createApp, 60 by default, 0 for
// none -- so a new user can try cloud dictation before deciding on Pro. It runs
// through the same relay and the same meter as Pro, with the same reservations,
// the same three-calls-at-once cap and the same rule that a call the app has
// stopped waiting for is not charged. The one difference is the window: Pro's
// credits are those of the credit month, the trial's are every second the
// account has ever had metered, so an account that lapses out of Pro is a free
// account with its past use counted. `account.trial` is
// { credits, used, left, available }: the trial's size, what is used and what is
// left of it (credits, which are minutes, rounded as the cloud meter's are), and
// whether this is a free account on a service that offers the trial. `available`
// stays true when the minutes run out, with `left` at 0, so an app can tell a
// spent trial from no trial. A Pro account always reads { credits, used: 0,
// left: 0, available: false }. A trial account's /v1/transcribe and /v1/polish
// answers carry the updated `trial` beside `cloud`, which for it is the free
// plan's empty meter; a Pro account's answers have no `trial`.
//
// Dictation lanes. An app that cuts a dictation into pieces while the user
// talks may name each piece's lane: `lane: 'body'` for a piece cut mid-speech,
// `lane: 'tail'` for the last one and anything still unsent when the user
// stops, with `dictation` (the recording's random id, 8-32 of A-Z a-z 0-9 _ -)
// and `piece` (0-999). While the body lane is on (CLOUD_BODY_MODEL) and the
// account is on its list (CLOUD_BODY_USERS), body pieces go to the body
// transcriber (`cloudBody`: a cheaper main model with the usual model as its
// rescue) and tail pieces to the usual one. When the user stops, the app posts
// the body pieces still out to /v1/transcribe/urgent, and each one's rescue is
// sent at once; a piece hurried before its request has arrived goes straight
// to the usual model when it does (for 30 s). Lane requests are charged their
// exact audio seconds, at least one, and their `timing` adds `lane`, `trigger`
// ('' | 'timer' | 'error' | 'urgent': what sent the rescue) and `source`
// ('main' | 'rescue': which answered). For an account the body lane is on for,
// `account.cloud.dictation` is { lanes: true, minSegmentMs, silenceMs,
// longSegmentMs, longSilenceMs, bodyConcurrency }, the piece sizes the app
// should cut at; for everyone else it is null (not absent, so an app that
// cached lane settings drops them on its next clip after a rollback). A
// request without a valid `lane` is the one every app up to 2.1.10 sends, and
// nothing about it changes but that null in its meter, which those apps ignore.
//
// freeWeeklyWords is the free plan's seven-day word allowance. Free dictation
// runs on the user's own PC and never reaches this service, so the app is what
// enforces it; the number is served from here only so it can be changed
// without shipping a build.

const crypto = require('crypto');
const { wavSeconds, resolveLanguage } = require('./cloud');
const { normalizePlan } = require('./billing');
const { MODES: POLISH_MODES } = require('./polish');
const credits = require('../src/credits');
const quota = require('../src/quota');

const CODE_MINUTES = 10;
const CODE_ATTEMPTS = 5;
const CODES_PER_EMAIL_PER_HOUR = 5;
const CODES_PER_IP_PER_HOUR = 30;
// Wrong codes one address may have typed across all its codes in a day. Five
// tries a code and five codes an hour would still allow 600 guesses a day at a
// one-in-a-million code; this holds it to twenty.
const WRONG_CODES_PER_EMAIL_PER_DAY = 20;
// Cloud calls one account may have running at once. A dictation and a polish
// can overlap; more than that is a script racing the credit check.
const CLOUD_CALLS_PER_USER = 3;
// Dictation pieces that name a lane (see the header) are counted apart from
// those three, so a dictation's own pieces never meet a 429 "busy" from each
// other or from a Polish running beside them: up to CLOUD_BODY_CALLS body
// pieces and six tail pieces at once. Tail has the margin: at stop the final
// piece, the queued pieces released as tail and a body piece retried as tail
// can all be out together. The credit reservation stays one total across all
// of them.
const DEFAULT_BODY_CALLS = 4;
const TAIL_CALLS_PER_USER = 6;
const DEFAULT_TAIL_WARM_EVERY_MS = 20000;
// The piece sizes an account on the body lane is told to cut at, in ms:
// a piece ends at the first pause of silenceMs once it is minSegmentMs long,
// or at a pause of longSilenceMs once it is longSegmentMs long. These are the
// app's own defaults (rule r4 in the 2026-10-15 measurement).
const DEFAULT_SEGMENT = Object.freeze({ minSegmentMs: 4000, silenceMs: 700, longSegmentMs: 45000, longSilenceMs: 300 });
// How long a piece hurried before its request arrived is remembered, and how
// many such marks the service holds at most across everyone.
const URGENT_EARLY_MS = 30e3;
const URGENT_EARLY_MAX = 20000;
// And at most this many live per account, so that with CLOUD_BODY_USERS=* one
// account cannot crowd everyone else's out of the shared bound above. A
// dictation hurries a few pieces at a time, so a real app never comes close.
const URGENT_EARLY_PER_USER = 512;
const URGENT_MAX_PIECES = 64;
// A dictation is hurried once, at stop, and only for the body pieces it still
// has out: the app runs at most bodyConcurrency of those (4 at most) and sends
// them all in its one urgent call. So each dictation id answers one urgent call
// per account, for at most this many times its body concurrency of pieces; a
// second call, or the pieces past the cap, hurry nothing. Each hurried piece
// that is out has its rescue paid for on top of the body model, so this is
// what keeps a client from doubling the provider cost of a whole dictation.
const URGENT_PIECES_PER_BODY_CALL = 2;
// How long a dictation's urgent call is remembered, and how many are kept at
// most across everyone (the oldest are forgotten first).
const URGENT_DICTATION_MS = 10 * 60e3;
const URGENT_DICTATION_MAX = 20000;
// Rate limits on the two cheap cloud routes, per account, as token buckets:
// a burst of `burst` calls, then one call per `everyMs`. The app warms at each
// recording start and every three quiet seconds while recording (about 20 a
// minute at most), and hurries once per dictation at stop; these leave it
// several times that. A refusal is a 429, which the app ignores for both.
const WARM_RATE = Object.freeze({ burst: 30, everyMs: 1000 });
const URGENT_RATE = Object.freeze({ burst: 20, everyMs: 3000 });
// Refusals are logged once per account and route per minute, with a count.
const RATE_NOTICE_MS = 60e3;
// Cloud request bodies being read, before the account's pools can be checked
// (a clip's pool is named inside its body). An account may have no more of
// them in flight than its pools have slots, nor more than this many bytes
// (two full-length clips); the whole service no more than UPLOAD_BYTES_TOTAL.
// Past any of them the request is refused with the pools' own 429 "busy"
// before a byte of it is held.
const UPLOAD_BYTES_PER_USER = 24 * 1024 * 1024;
const UPLOAD_BYTES_TOTAL = 128 * 1024 * 1024;
const DICTATION_ID_RE = /^[A-Za-z0-9_-]{8,32}$/;
const MAX_BODY_BYTES = 4096;
// A 16 kHz mono 16-bit clip is 32 KB a second; base64 makes it 43 KB. Twelve
// megabytes is about four and a half minutes, far past any dictation.
const MAX_AUDIO_BODY_BYTES = 12 * 1024 * 1024;
const MAX_CLIP_SECONDS = 300;
// What a refused language is told. 47 characters: an app up to 2.1.9 shows a
// relay message as it is only if it is 56 or fewer, and this is the sentence
// those users should read.
const LANGUAGE_REFUSED = "Voxden Cloud doesn't support that language yet.";
// 2,000 words is about 13 KB; the rest is room for the terms and JSON.
const MAX_POLISH_BODY_BYTES = 64 * 1024;
// Spoken corrections check one dictation at a time (server/corrections.js).
const CORRECTIONS_MAX_WORDS = require('./corrections').MAX_WORDS;
const DEFAULT_CLOUD_HOURS_CAP = credits.DEFAULT_HOURS_CAP;
// Voxden Cloud minutes a free account may use, once, with no card; 1 credit is
// 1 minute. cloudTrialCredits: 0 switches the trial off.
const DEFAULT_CLOUD_TRIAL_CREDITS = 60;
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

// A first or last name as typed: trimmed, one line, forty characters.
function cleanName(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 40);
}

function isPiece(value) {
  return Number.isInteger(value) && value >= 0 && value <= 999;
}

// A transcribe request's lane (see the header) as { lane, dictation, piece },
// or null for a request without a valid one, which is the legacy path. A lane
// with a missing or malformed dictation id or piece number still counts as
// that lane; it just cannot be hurried.
function laneOf(body) {
  const lane = body && (body.lane === 'body' || body.lane === 'tail') ? body.lane : '';
  if (!lane) return null;
  const dictation = DICTATION_ID_RE.test(String(body.dictation || '')) ? String(body.dictation) : '';
  const piece = isPiece(body.piece) ? body.piece : -1;
  return { lane, dictation: dictation && piece >= 0 ? dictation : '', piece };
}

// What a lane piece's log line ends with.
function laneNote(lane, hurriedFirst) {
  return ' lane=' + lane.lane + ' piece=' + (lane.piece >= 0 ? lane.piece : '-')
    + (hurriedFirst ? ' (hurried before it arrived, sent to the main model)' : '');
}

function sixDigits() {
  // 0..999999, uniform; randomInt is unbiased.
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

function iso(ms) {
  return new Date(ms).toISOString();
}

const DAY_MS = 24 * 3600e3;

// The calendar month, YYYY-MM.
function periodOf(ms) {
  const d = new Date(ms);
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0');
}

// The UTC day, YYYY-MM-DD: the key cloud usage is kept under.
function dayOf(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function dayStartOf(ms) {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

// The day `ms` falls on, moved by whole months. A day the target month does
// not have becomes its last: the 31st renews on the 30th, or the 28th.
function addMonths(ms, months) {
  const d = new Date(ms);
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  return Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), Math.min(d.getUTCDate(), last));
}

// The midnight UTC nearest `ms`. Credits are kept by UTC day, so a credit
// month can only turn at a midnight, and it turns at the one nearest the
// renewal. Razorpay renews an Indian subscription at midnight IST, which is
// 18:30 UTC the day before: the midnight that began that UTC day turned the
// month 18.5 hours before the renewal, and a welcome month ended a day early.
// The nearest one turns it at 05:30 IST on the billing date.
function nearestMidnightOf(ms) {
  return dayStartOf(ms + DAY_MS / 2);
}

// The credit month `t` is in, as { start, end } at midnight UTC. A
// subscriber's runs from one billing date to the next, counted from the
// renewal the provider last reported (`anchor`), so credits refresh when the
// plan renews; each month turns at the midnight nearest the renewal time
// (nearestMidnightOf). An account with no billing date, a plan set by hand,
// uses the calendar month.
//
// `periodStart`, when the provider reported it (Razorpay's current_start), is
// where the paid period ending at `anchor` began, and is used as it is: a
// period that ends on a clamped day began on a later day of the month before
// than the same day number (Jan 31 -> Feb 28 began on the 31st, not the 28th),
// so rebuilding the start from the end began those months up to three days
// early. It is trusted only while it looks like the start of a monthly period
// ending at `anchor` (27 to 32 days before it); a start left over from an
// earlier period, or an annual plan's, falls back to counting from `anchor`.
// Before that start, the months are counted back from it.
function creditMonthOf(anchor, t, periodStart) {
  if (!(anchor > 0)) {
    const d = new Date(t);
    return { start: Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1), end: Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) };
  }
  anchor = nearestMidnightOf(anchor);
  const start = periodStart > 0 ? nearestMidnightOf(periodStart) : 0;
  if (start && anchor - start >= 27 * DAY_MS && anchor - start <= 32 * DAY_MS) {
    if (t >= start && t < anchor) return { start, end: anchor };
    if (t < start) return creditMonthOf(start, t);
  }
  const a = new Date(anchor);
  const at = new Date(t);
  let n = (at.getUTCFullYear() - a.getUTCFullYear()) * 12 + at.getUTCMonth() - a.getUTCMonth();
  while (addMonths(anchor, n) <= t) n++;
  while (addMonths(anchor, n - 1) > t) n--;
  return { start: addMonths(anchor, n - 1), end: addMonths(anchor, n) };
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

// The price regions: India pays in rupees, everywhere else in dollars, both
// through Razorpay. Each offer in billing.js names its region.
function regionOfCountry(country) {
  return country === 'IN' ? 'in' : 'global';
}

// Countries the global offer is not sold in yet, by ISO code. Razorpay is not a
// merchant of record, and these tax a foreign seller's digital services from
// the first sale: the EU's 27 and the UK, with Monaco and the Isle of Man,
// which sit inside the French and UK VAT areas. An account placed in India is
// not affected. CLOSED_COUNTRIES in the environment replaces the list.
const DEFAULT_CLOSED_COUNTRIES = Object.freeze([
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU',
  'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE',
  'GB', 'IM', 'MC',
]);

// Subscription statuses after which no further charge is coming. 'cancelling'
// is ours: renewal stopped, paid period still running.
const ENDED_STATUSES = ['cancelling', 'cancelled', 'completed', 'expired', 'halted', 'paused', 'unpaid'];

// How long a started checkout's page is handed out again to the same account
// asking for the same offer, instead of creating another subscription at the
// provider for each click (or each call of a script).
const CHECKOUT_REUSE_MS = 10 * 60e3;

const FEEDBACK_KINDS = ['bug', 'idea', 'other'];
const FEEDBACK_MAX_MESSAGE = 4000;
const FEEDBACK_MAX_DIAGNOSTICS = 2000;
const FEEDBACK_PER_IP_PER_HOUR = 10;

// Support toward code-signing Voxden: a goal in rupees, paid in rupees or
// dollars. Amounts are in the currency's smallest unit. The floor keeps the
// form from being a cheap way to test stolen cards; the ceiling keeps a typo
// from becoming a refund.
const SUPPORT_LIMITS = Object.freeze({
  INR: Object.freeze({ min: 5000, max: 5000000 }),
  USD: Object.freeze({ min: 100, max: 50000 }),
});
const SUPPORT_ORDERS_PER_IP_PER_HOUR = 20;
// Pages that may hold the live stream open at once; the rest poll.
const SUPPORT_STREAMS_MAX = 2000;
const DEFAULT_SUPPORT_GOAL_INR = 25000;
// The end of 31 December 2026 in India.
const DEFAULT_SUPPORT_DEADLINE = '2026-12-31T18:29:59.000Z';
// Rupees to a dollar, for dollar payments and for showing the goal in dollars.
const DEFAULT_SUPPORT_USD_INR = 88;
const DEFAULT_SUPPORT_ORIGINS = Object.freeze(['https://voxden.app', 'https://www.voxden.app']);

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
  const cloudWelcomeCredits = Number.isFinite(opts.cloudWelcomeCredits) && opts.cloudWelcomeCredits >= 0
    ? Math.round(opts.cloudWelcomeCredits)
    : credits.WELCOME_CREDITS;
  // A subscriber's first credit month is a one-time welcome offer. It is only
  // an offer while it gives more than every other month does, and a lifetime
  // pool has no months to be first in.
  const welcomeOn = cloudCreditsReset !== 'never' && cloudWelcomeCredits > cloudCreditsCap;
  // The free trial (see the header): the credits a free account may spend over
  // its whole life on the cloud routes. Zero is no trial.
  const cloudTrialCredits = Number.isFinite(opts.cloudTrialCredits) && opts.cloudTrialCredits >= 0
    ? Math.round(opts.cloudTrialCredits)
    : DEFAULT_CLOUD_TRIAL_CREDITS;
  const freeWeeklyWords = Number.isFinite(opts.freeWeeklyWords) && opts.freeWeeklyWords > 0
    ? Math.round(opts.freeWeeklyWords)
    : DEFAULT_FREE_WEEKLY_WORDS;
  const log = opts.log || (() => {});
  // The upstream speech model. Optional: a service without one answers
  // /v1/transcribe with 503 and everything else works.
  const cloud = opts.cloud || null;
  // The body lane's transcriber (see the header), and who it is on for. It is
  // off without one, without a configured usual transcriber for the tail
  // pieces, or when it has no rescue: a body piece the app is waiting on at
  // stop is only fast because its rescue can be sent at once, so a body model
  // without one would make every stop wait on it.
  const laneOpts = opts.cloudLanes || {};
  let cloudBody = opts.cloudBody && opts.cloudBody.configured ? opts.cloudBody : null;
  if (cloudBody && !(cloudBody.settings && cloudBody.settings.rescueModel)) {
    log('cloud lanes off: the body model ' + cloudBody.model + ' has no rescue (CLOUD_BODY_RESCUE_MODEL is none or CLOUD_BODY_RESCUE_MS is 0)');
    cloudBody = null;
  }
  if (cloudBody && !(cloud && cloud.configured)) {
    log('cloud lanes off: there is no main speech model for tail pieces');
    cloudBody = null;
  }
  // CLOUD_BODY_USERS: emails, or '*' for every account. Empty is nobody.
  const laneUsers = (Array.isArray(laneOpts.users) ? laneOpts.users : String(laneOpts.users || '').split(','))
    .map((email) => String(email || '').trim().toLowerCase()).filter(Boolean);
  const lanesForAll = laneUsers.includes('*');
  const laneUserSet = new Set(laneUsers);
  const positiveMs = (value, fallback) => (Number(value) > 0 && Number.isFinite(Number(value)) ? Math.round(Number(value)) : fallback);
  const bodyCalls = positiveMs(laneOpts.bodyCalls, DEFAULT_BODY_CALLS);
  // CLOUD_TAIL_WARM_EVERY_MS: how often a body-lane warm-up (?lane=body) also
  // warms the usual model. The app asks at every recording start and every
  // three quiet seconds, and each warm-up that reaches the usual model is a
  // billed silent clip, while its tail pieces are only a few per dictation.
  // So it is warmed only when nothing has warmed it or been answered by it for
  // this long. 0 warms it on every call, as before.
  const tailWarmEveryMs = laneOpts.tailWarmEveryMs === undefined || laneOpts.tailWarmEveryMs === null || laneOpts.tailWarmEveryMs === ''
    || !(Number(laneOpts.tailWarmEveryMs) >= 0) ? DEFAULT_TAIL_WARM_EVERY_MS : Math.round(Number(laneOpts.tailWarmEveryMs));
  // When the usual model was last warmed from here or last answered a clip.
  let legacyWarmAt = 0;
  const dictationSettings = Object.freeze({
    lanes: true,
    minSegmentMs: positiveMs(laneOpts.minSegmentMs, DEFAULT_SEGMENT.minSegmentMs),
    silenceMs: positiveMs(laneOpts.silenceMs, DEFAULT_SEGMENT.silenceMs),
    longSegmentMs: positiveMs(laneOpts.longSegmentMs, DEFAULT_SEGMENT.longSegmentMs),
    longSilenceMs: positiveMs(laneOpts.longSilenceMs, DEFAULT_SEGMENT.longSilenceMs),
    bodyConcurrency: bodyCalls,
  });
  function lanesFor(user) {
    return !!cloudBody && !!user && (lanesForAll || laneUserSet.has(String(user.email || '').toLowerCase()));
  }
  // A cloud meter (every one the relay returns: the account's, transcribe's
  // and Polish's) with the piece sizes for an account on the body lane, and
  // `dictation: null` for everyone else. The null is there for rollback: the
  // app folds each transcribe answer's meter into its cached account
  // (src/account.js noteCloudUsage), so a field left out would leave lane
  // settings it cached earlier in place until its next /v1/me, hours later.
  // An app up to 2.1.10 ignores the field.
  function withDictation(meter, user) {
    return Object.assign(meter, { dictation: lanesFor(user) ? { ...dictationSettings } : null });
  }
  // The text model behind Polish (server/polish.js). Optional in the same way:
  // without one, /v1/polish answers 503.
  const polisher = opts.polisher || null;
  // The text model behind spoken corrections (server/corrections.js). Without
  // one, /v1/corrections answers 503 and the app keeps to its own rules.
  const corrector = opts.corrector || null;
  // Payments. Optional too: without it the app shows no upgrade offer and
  // plans are set by hand with server/grant.js.
  const billing = opts.billing || null;
  // A sign-in for the people who review the Android app for Google Play. They
  // cannot read an emailed code and may not use a personal account, so one
  // address has a fixed six-digit code, set in the environment and handed
  // over in Play Console only. It goes through the same code table as every
  // other sign-in (expiry, five tries a code, twenty wrong codes a day), sends
  // no email, and keeps its account on Pro. Unset, or malformed, it is off.
  const reviewLogin = opts.reviewLogin && normalizeEmail(opts.reviewLogin.email) && /^\d{6}$/.test(String(opts.reviewLogin.code || ''))
    ? { email: normalizeEmail(opts.reviewLogin.email), code: String(opts.reviewLogin.code) } : null;
  // Where the global offer is not sold yet (DEFAULT_CLOSED_COUNTRIES).
  const closedCountries = new Set((Array.isArray(opts.closedCountries) ? opts.closedCountries : DEFAULT_CLOSED_COUNTRIES)
    .map((code) => String(code || '').trim().toUpperCase()).filter(Boolean));
  // Where feedback goes beyond the table: Discord forum posts, when webhooks
  // are configured (discord.js).
  const discord = opts.discord || null;
  // Which country a request comes from (geo.js). Optional: without it no
  // account is placed in a region, and the app offers every region.
  const geo = opts.geo || null;
  // Google sign-in. Optional: without a client, only the emailed code exists.
  const google = opts.google && opts.google.clientId && opts.google.clientSecret ? {
    clientId: String(opts.google.clientId),
    clientSecret: String(opts.google.clientSecret),
    tokenUrl: String(opts.google.tokenUrl || 'https://oauth2.googleapis.com/token'),
    fetchImpl: opts.google.fetchImpl || globalThis.fetch,
  } : null;
  if (!store || !mailer) throw new Error('createApp needs a store and a mailer');
  // The signing goal (/v1/support). Payments need billing's Razorpay keys;
  // the goal itself is always readable.
  const supportOpts = opts.support || {};
  const supportGoalInr = Number(supportOpts.goalInr) > 0 ? Math.round(Number(supportOpts.goalInr)) : DEFAULT_SUPPORT_GOAL_INR;
  const supportDeadline = supportOpts.deadline === '' ? null
    : (Number.isFinite(Date.parse(supportOpts.deadline || '')) ? iso(Date.parse(supportOpts.deadline)) : DEFAULT_SUPPORT_DEADLINE);
  const supportUsdInr = Number(supportOpts.usdInr) > 0 ? Number(supportOpts.usdInr) : DEFAULT_SUPPORT_USD_INR;
  const supportOrigins = new Set((Array.isArray(supportOpts.origins) ? supportOpts.origins : DEFAULT_SUPPORT_ORIGINS)
    .map((origin) => String(origin || '').trim().replace(/\/+$/, '')).filter(Boolean));
  // Orders asked for in the last hour, by address. In memory: a restart
  // forgiving someone is fine, and Razorpay charges nothing for an order.
  const supportOrdersByIp = new Map();
  // Pages watching the goal live (GET /v1/support/stream). Each gets the new
  // totals the moment a payment is recorded.
  const supportStreams = new Set();

  // Cloud calls running now, by account and pool. The credit check happens
  // before the model is asked and the charge after, so calls fired together
  // would all pass the check; this caps how many can. Each account has three
  // pools, each with its own cap: 'general' (a clip with no lane, Polish,
  // spoken corrections), 'body' and 'tail' (dictation pieces that name their
  // lane). Credits reserved are one total per account whichever pool a call
  // is in, so the cap check still sees them all.
  const cloudCalls = new Map();
  const cloudReserved = new Map();
  const poolCaps = { general: CLOUD_CALLS_PER_USER, body: bodyCalls, tail: TAIL_CALLS_PER_USER };
  async function oneCloudCall(user, run, pool) {
    const key = user.id + '|' + (poolCaps[pool] ? pool : 'general');
    const running = cloudCalls.get(key) || 0;
    if (running >= (poolCaps[pool] || CLOUD_CALLS_PER_USER)) {
      throw Object.assign(new HttpError(429, 'Too many cloud requests at once. Wait for the last one to finish.'), { code: 'busy' });
    }
    cloudCalls.set(key, running + 1);
    const reservation = { seconds: 0 };
    try {
      return await run(reservation);
    } finally {
      const reserved = (cloudReserved.get(user.id) || 0) - reservation.seconds;
      if (reserved > 0) cloudReserved.set(user.id, reserved); else cloudReserved.delete(user.id);
      const left = (cloudCalls.get(key) || 1) - 1;
      if (left > 0) cloudCalls.set(key, left); else cloudCalls.delete(key);
    }
  }

  // Admission for a cloud request's body, checked before it is read (see
  // UPLOAD_BYTES_PER_USER): a body over `limit` by its Content-Length is a 413,
  // and one the account's pools or the byte budgets have no room for is the
  // pools' 429 "busy". A body without a Content-Length is counted at `limit`.
  // Returns the release, which is safe to call twice; it also runs when the
  // request closes, so an upload abandoned halfway gives its room back.
  const uploads = new Map();
  let uploadBytes = 0;
  const uploadBytesTotal = positiveMs(opts.uploadBytesTotal, UPLOAD_BYTES_TOTAL);
  const slotsPerUser = Object.values(poolCaps).reduce((sum, cap) => sum + cap, 0);
  function admitUpload(user, req, limit) {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) throw new HttpError(413, 'Request too large.');
    const bytes = Number.isFinite(declared) && declared >= 0 ? declared : limit;
    const mine = uploads.get(user.id) || { count: 0, bytes: 0 };
    const running = Object.keys(poolCaps).reduce((sum, pool) => sum + (cloudCalls.get(user.id + '|' + pool) || 0), 0);
    if (mine.count + running >= slotsPerUser || mine.bytes + bytes > UPLOAD_BYTES_PER_USER || uploadBytes + bytes > uploadBytesTotal) {
      throw Object.assign(new HttpError(429, 'Too many cloud requests at once. Wait for the last one to finish.'), { code: 'busy' });
    }
    mine.count++;
    mine.bytes += bytes;
    uploads.set(user.id, mine);
    uploadBytes += bytes;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      req.removeListener('close', release);
      uploadBytes -= bytes;
      mine.count--;
      mine.bytes -= bytes;
      if (mine.count <= 0) uploads.delete(user.id);
    };
    req.once('close', release);
    return release;
  }

  // Reads a cloud request's body once admitUpload lets it in, and gives the
  // room back as soon as it is read (the pools take over from there).
  async function readCloudBody(user, req, limit) {
    const release = admitUpload(user, req, limit);
    try {
      return await readJson(req, limit);
    } finally {
      release();
    }
  }

  // The per-account rate limits (WARM_RATE, URGENT_RATE). Each bucket is
  // { tokens, at, refused, noticeAt }; a refusal throws a 429 and is logged
  // once a minute per account and route, with how many there were.
  function rateLimiter(name, rate) {
    const buckets = new Map();
    return function take(user) {
      const t = now();
      let bucket = buckets.get(user.id);
      if (!bucket) {
        if (buckets.size >= 10000) {
          // A bucket that has filled back up is the same as no bucket.
          for (const [id, old] of buckets) if (t - old.at >= rate.burst * rate.everyMs && !old.refused) buckets.delete(id);
        }
        bucket = { tokens: rate.burst, at: t, refused: 0, noticeAt: 0 };
        buckets.set(user.id, bucket);
      }
      bucket.tokens = Math.min(rate.burst, bucket.tokens + Math.max(0, t - bucket.at) / rate.everyMs);
      bucket.at = t;
      if (bucket.tokens >= 1) {
        bucket.tokens -= 1;
        return;
      }
      bucket.refused++;
      if (!bucket.noticeAt || t - bucket.noticeAt >= RATE_NOTICE_MS) {
        log(name + ' rate limited for ' + user.email + ': ' + bucket.refused + ' refused'
          + (bucket.noticeAt ? ' in the last ' + Math.round((t - bucket.noticeAt) / 1000) + 's' : ''));
        bucket.noticeAt = t;
        bucket.refused = 0;
      }
      throw Object.assign(new HttpError(429, 'Too many requests. Try again in a moment.'), { code: 'rate' });
    };
  }
  // cloudRates: { warm, urgent } replaces either rate, for the tests only.
  const rates = opts.cloudRates || {};
  const takeWarm = rateLimiter('warm-up', rates.warm || WARM_RATE);
  const takeUrgent = rateLimiter('urgent', rates.urgent || URGENT_RATE);

  // Body pieces out with the body transcriber, by account, dictation and
  // piece, so POST /v1/transcribe/urgent can hurry exactly the caller's own:
  // each entry is the set of `urgent` controllers of that piece's requests (a
  // retry can overlap the first try). And the pieces hurried before their
  // request arrived, with when the mark lapses.
  const piecesOut = new Map();
  const hurriedEarly = new Map();
  function pieceKey(user, dictation, piece) {
    return user.id + '|' + dictation + '|' + piece;
  }
  // Each mark is { until, userId }; earlyByUser counts each account's marks.
  const earlyByUser = new Map();
  // The overall bound; cloudLanes.earlyMax lowers it, for the tests only.
  const earlyMax = positiveMs(laneOpts.earlyMax, URGENT_EARLY_MAX);
  function dropMark(key) {
    const mark = hurriedEarly.get(key);
    if (!mark) return null;
    hurriedEarly.delete(key);
    const left = (earlyByUser.get(mark.userId) || 1) - 1;
    if (left > 0) earlyByUser.set(mark.userId, left); else earlyByUser.delete(mark.userId);
    return mark;
  }
  // Marks a piece of `user`'s; false when the account already holds
  // URGENT_EARLY_PER_USER live marks, and nothing is stored.
  function markHurriedEarly(user, key) {
    const t = now();
    // Marks are kept in the order they lapse (a mark set again moves to the
    // end), so the sweep stops at the first one still current.
    for (const [old, mark] of hurriedEarly) {
      if (mark.until > t) break;
      dropMark(old);
    }
    dropMark(key);
    if ((earlyByUser.get(user.id) || 0) >= URGENT_EARLY_PER_USER) return false;
    // A bound on what a burst of urgent calls can make the service hold. At
    // the bound the caller's own oldest mark goes first, so a busy account
    // pushes out its own marks before anyone else's; only a caller with none
    // pushes out the oldest of all. A piece that loses its mark just goes to
    // the body model like any other.
    if (hurriedEarly.size >= earlyMax) {
      let victim = hurriedEarly.keys().next().value;
      for (const [old, mark] of hurriedEarly) {
        if (mark.userId === user.id) { victim = old; break; }
      }
      dropMark(victim);
    }
    hurriedEarly.set(key, { until: t + URGENT_EARLY_MS, userId: user.id });
    earlyByUser.set(user.id, (earlyByUser.get(user.id) || 0) + 1);
    return true;
  }
  // Whether a piece was hurried before it arrived; the mark is used up.
  function takeHurriedEarly(key) {
    const mark = dropMark(key);
    return !!mark && mark.until > now();
  }
  // The dictations that have had their urgent call (URGENT_PIECES_PER_BODY_CALL),
  // by account and dictation id, with when that is forgotten. Kept in the order
  // they lapse, like the marks above.
  const urgentDictations = new Map();
  const urgentPiecesPerDictation = bodyCalls * URGENT_PIECES_PER_BODY_CALL;
  // True the first time a dictation is hurried; false after that.
  function firstUrgent(user, dictation) {
    const t = now();
    for (const [old, until] of urgentDictations) {
      if (until > t) break;
      urgentDictations.delete(old);
    }
    const key = user.id + '|' + dictation;
    if (urgentDictations.has(key)) return false;
    if (urgentDictations.size >= URGENT_DICTATION_MAX) urgentDictations.delete(urgentDictations.keys().next().value);
    urgentDictations.set(key, t + URGENT_DICTATION_MS);
    return true;
  }

  function countryOf(req) {
    return geo ? geo.countryOf(clientIp(req)) : '';
  }

  // Puts an account in a price region the first time one of its requests can
  // be placed in a country, from the address it comes from. After that the
  // region stays, wherever the account signs in from; only server/region.js
  // changes it.
  function placeUser(user, req) {
    if (!user || user.region) return user;
    const country = countryOf(req);
    if (!country || !store.placeUser(user.id, regionOfCountry(country), country)) return user;
    log('region ' + regionOfCountry(country) + ' (' + country + ') for ' + user.email);
    return store.userById(user.id);
  }

  // Where an account stands on cloud credits at `t`: whether the credit month
  // it is in is its welcome month, the credits that month allows, the seconds
  // already metered against them, and when the month ends.
  function cloudStanding(user, t) {
    if (cloudCreditsReset === 'never') {
      return { welcome: false, capCredits: cloudCreditsCap, seconds: store.usageSecondsTotal(user.id), periodEnd: null };
    }
    const sub = store.subscriptionForUser(user.id);
    const month = creditMonthOf(sub ? Date.parse(sub.period_end || '') : 0, t, sub ? Date.parse(sub.period_start || '') : 0);
    // The welcome month is the credit month that ends on the first renewal.
    // A day either way absorbs a provider restating that renewal's time.
    const until = Date.parse(user.welcome_until || '');
    const welcome = welcomeOn && Number.isFinite(until) && Math.abs(month.end - nearestMidnightOf(until)) <= DAY_MS;
    return {
      welcome,
      capCredits: welcome ? cloudWelcomeCredits : cloudCreditsCap,
      seconds: store.usageSecondsBetween(user.id, dayOf(month.start), dayOf(month.end)),
      periodEnd: iso(month.end),
    };
  }

  // The meter the app shows. `monthlyCredits` is what every month after a
  // welcome month brings, so the app can say what comes next.
  function cloudMeter(standing) {
    return Object.assign(credits.meterFromSeconds(standing.seconds, {
      creditsCap: standing.capCredits,
      reset: cloudCreditsReset,
      periodEnd: standing.periodEnd,
    }), { welcome: standing.welcome, monthlyCredits: cloudCreditsCap });
  }

  // The meter a free account reads on `cloud`: no monthly credits, whatever it
  // has used on its trial (that is `trial`'s to say).
  function freeCloudMeter(t) {
    return credits.meterFromSeconds(0, {
      creditsCap: 0,
      reset: cloudCreditsReset,
      periodEnd: iso(creditMonthOf(0, t).end),
    });
  }

  // Where a free account stands on its trial: the same shape as cloudStanding's
  // answer, so the admission checks below read either. The window is the
  // account's whole life, not a credit month.
  function trialStanding(user) {
    return { capCredits: cloudTrialCredits, seconds: store.usageSecondsTotal(user.id) };
  }

  // `account.trial`, from the lifetime seconds metered when the account is a
  // free one, and null seconds when it is not. Used and left are rounded by the
  // cloud meter's own arithmetic.
  function trialView(seconds) {
    if (seconds === null) return { credits: cloudTrialCredits, used: 0, left: 0, available: false };
    const meter = credits.meterFromSeconds(seconds, { creditsCap: cloudTrialCredits, reset: 'never' });
    return { credits: cloudTrialCredits, used: meter.creditsUsed, left: meter.creditsRemaining, available: cloudTrialCredits > 0 };
  }

  // The refusal for a free account whose trial minutes cannot cover a request.
  function trialUsed() {
    return Object.assign(new HttpError(402, 'Your free Voxden Cloud minutes are used up.'), { code: 'trial_used' });
  }

  // Whether an account has any cloud time left, in-flight clips included: the
  // trial's minutes for a free account, the credit month's for Pro. Calls that
  // are not charged (warm-ups, spoken corrections) stop where dictation does.
  function cloudTimeLeft(user, onTrial, t) {
    const standing = onTrial ? trialStanding(user) : cloudStanding(user, t);
    return standing.seconds + (cloudReserved.get(user.id) || 0) < credits.secondsFromCredits(standing.capCredits);
  }

  function cloudTimeUsed(account, onTrial) {
    return onTrial ? trialUsed() : Object.assign(new HttpError(402, credits.capMessage(account.cloud)), { code: 'cap' });
  }

  function accountFor(user) {
    const t = now();
    let plan = String(user.plan || 'free');
    let planExpiresAt = user.plan_expires_at || null;
    if (plan !== 'free' && planExpiresAt && Date.parse(planExpiresAt) <= t) {
      plan = 'free';
    }
    const standing = plan === 'free' ? null : cloudStanding(user, t);
    return {
      email: user.email,
      // Who they are, as far as they have told us: typed in the app, or
      // carried over from Google at sign-in.
      profile: {
        firstName: String(user.first_name || ''),
        lastName: String(user.last_name || ''),
        pictureUrl: String(user.picture_url || ''),
      },
      plan,
      planExpiresAt: plan === 'free' ? null : planExpiresAt,
      // 'in' or 'global' once the account is placed; null before.
      region: user.region || null,
      // With the piece sizes for an account on the body lane (see the header).
      cloud: withDictation(standing ? cloudMeter(standing) : freeCloudMeter(t), user),
      // The one-time welcome offer: the credits a first month brings, the
      // monthly figure after it, and whether this account can still have it.
      welcomeOffer: {
        credits: welcomeOn ? cloudWelcomeCredits : 0,
        monthlyCredits: cloudCreditsCap,
        eligible: welcomeOn && !user.welcome_until,
      },
      // The free trial: { credits, used, left, available }, for a free account
      // read from everything it has ever had metered.
      trial: trialView(plan === 'free' ? trialStanding(user).seconds : null),
      // The free plan's weekly word allowance. Sent whatever the plan is, so
      // an account that lapses out of Pro already knows the number.
      freeWeeklyWords,
      serverTime: iso(t),
    };
  }

  function tooManyWrongCodes() {
    return Object.assign(new HttpError(429, 'Too many wrong codes for this email today. Try again tomorrow'
      + (google ? ', or sign in with Google.' : '.')), { code: 'locked' });
  }

  async function requestCode(body, ip) {
    const email = normalizeEmail(body.email);
    if (!email) throw new HttpError(400, 'Enter a valid email address.');
    const forReview = !!reviewLogin && email === reviewLogin.email;
    if (mailer.configured !== true && !forReview) {
      throw Object.assign(new HttpError(503, 'Email sign-in is unavailable right now.'
        + (google ? ' Please use Google to sign in.' : ' Please try again later.')), { code: 'email_unconfigured' });
    }
    const t = now();
    const hourAgo = iso(t - 3600e3);
    if (store.wrongCodesForEmailSince(email, iso(t - DAY_MS)) >= WRONG_CODES_PER_EMAIL_PER_DAY) throw tooManyWrongCodes();
    if (store.codesForEmailSince(email, hourAgo) >= CODES_PER_EMAIL_PER_HOUR
        || store.codesForIpSince(ip, hourAgo) >= CODES_PER_IP_PER_HOUR) {
      throw new HttpError(429, 'Too many codes requested. Wait an hour and try again.');
    }
    const code = forReview ? reviewLogin.code : sixDigits();
    const codeId = store.createLoginCode({
      email, codeHash: sha256(email + ':' + code), ip,
      expiresAt: iso(t + CODE_MINUTES * 60e3), createdAt: iso(t),
    });
    if (forReview) {
      log('review sign-in code opened');
      return;
    }
    try {
      const result = await mailer.sendCode({ to: email, code, minutes: CODE_MINUTES });
      if (result?.delivered !== true) throw new Error('Email was not accepted by the provider.');
    } catch (_) {
      // Keep failed attempts in rate limits, but never accept an unsent code.
      store.useLoginCode(codeId, iso(now()));
      log('sign-in email delivery failed');
      throw Object.assign(new HttpError(503, 'We couldn\'t send your sign-in code. Please try again in a moment.'
        + (google ? ' You can also use Google to sign in.' : '')), { code: 'email_delivery_failed' });
    }
    log('sign-in email accepted by provider');
  }

  function verifyCode(body, req) {
    const email = normalizeEmail(body.email);
    const code = String(body.code || '').replace(/\D/g, '');
    if (!email || code.length !== 6) throw new HttpError(400, 'Enter the six-digit code from the email.');
    const t = now();
    if (store.wrongCodesForEmailSince(email, iso(t - DAY_MS)) >= WRONG_CODES_PER_EMAIL_PER_DAY) throw tooManyWrongCodes();
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
    return openSession(email, body.device, t, req);
  }

  // A signed-in PC: the user row (created on first sign-in, and placed in a
  // price region then) and a fresh session token. Shared by every sign-in
  // route.
  function openSession(email, device, t, req) {
    let user = placeUser(store.findOrCreateUser(email, iso(t)), req);
    // The reviewer's account is Pro for as long as the login is on, so Google's
    // reviewers need no purchase and no trial to see every part of the app.
    if (reviewLogin && email === reviewLogin.email) {
      store.setPlan(email, 'pro', iso(t + 30 * DAY_MS));
      user = store.userByEmail(email);
    }
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
    return { google: google ? { clientId: google.clientId } : null, email: { configured: mailer.configured === true } };
  }

  // Google sign-in, finished here. The app sends the authorization code from
  // the browser and its PKCE verifier; this service, which alone holds the
  // client secret, trades them with Google for the identity token. The
  // token arrives straight from Google over TLS, so its claims are checked
  // but its signature need not be re-verified.
  async function googleSignIn(body, req) {
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
    // Names Google knows fill in only what the user has not typed themselves;
    // the photo follows Google, since it is Google's to change.
    const user = store.findOrCreateUser(email, iso(t));
    const picture = /^https:\/\//.test(String(claims.picture || '')) ? String(claims.picture).slice(0, 500) : user.picture_url;
    store.setProfile(user.id, {
      firstName: user.first_name || cleanName(claims.given_name),
      lastName: user.last_name || cleanName(claims.family_name),
      pictureUrl: picture || '',
    });
    return openSession(email, body.device, t, req);
  }

  // The names on the account. The photo is not editable here; it comes from
  // Google or stays empty.
  function updateProfile(req, body) {
    const { user } = sessionFrom(req);
    const firstName = cleanName(body.firstName);
    const lastName = cleanName(body.lastName);
    store.setProfile(user.id, { firstName, lastName, pictureUrl: user.picture_url || '' });
    return { account: accountFor(store.userById(user.id)) };
  }

  // Everything the service holds about the account, gone: sessions, usage,
  // subscription rows and the user itself. Feedback they sent stays, with no
  // account attached. Their own PC keeps its history; that was never here.
  // A subscription still set to renew is cancelled with the provider first:
  // a deleted account must not go on being charged. If that fails, nothing
  // is deleted.
  async function deleteAccount(req) {
    const { user } = sessionFrom(req);
    const sub = store.subscriptionForUser(user.id);
    if (sub && !ENDED_STATUSES.includes(String(sub.status || '').toLowerCase())) {
      if (!billing) throw Object.assign(new HttpError(503, 'Payments are not reachable, so the subscription could not be cancelled. Nothing was deleted.'), { code: 'subscription' });
      try {
        await billing.cancel(sub.provider, sub.provider_id);
      } catch (err) {
        log('delete refused for ' + user.email + ': cancelling ' + sub.provider + ' failed: ' + ((err && err.message) || err));
        throw Object.assign(new HttpError(502, 'Your subscription could not be cancelled, so nothing was deleted. Try again in a minute.'), { code: 'subscription' });
      }
      log('renewal cancelled for ' + user.email + ' before deleting the account');
    }
    store.deleteUser(user.id);
    log('account deleted for ' + user.email);
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

  // The session, when the request carries a good one; null otherwise. For
  // routes that also answer the signed-out.
  function sessionIfAny(req) {
    try {
      return sessionFrom(req);
    } catch (err) {
      if (err instanceof HttpError && err.status === 401) return null;
      throw err;
    }
  }

  function me(req, body) {
    const { session, user: found } = sessionFrom(req);
    // An account from before regions, or first seen from an address no table
    // could place, is placed the first time it checks in from one that can.
    const user = placeUser(found, req);
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
  // when it gives one and the header otherwise, and never fewer than one per
  // clip. A free account's trial goes through the same steps against its
  // lifetime minutes (see the header).
  async function transcribe(req, body, reservation) {
    const { session, user } = sessionFrom(req);
    if (!cloud || !cloud.configured) {
      throw Object.assign(new HttpError(503, 'Cloud transcription is not available right now.'), { code: 'unconfigured' });
    }
    const account = accountFor(user);
    // Pro runs on its credit month; a free account runs on its one-time trial
    // while the service offers one.
    const onTrial = account.plan === 'free' && account.trial.available;
    if (account.plan !== 'pro' && !onTrial) {
      throw Object.assign(new HttpError(402, 'Cloud transcription needs a Pro plan.'), { code: 'plan' });
    }
    // The language is checked against what the configured model takes before
    // the clip is measured or reserved, so a refusal reaches no provider and
    // charges nothing (see resolveLanguage in server/cloud.js). The message is
    // short on purpose: an app up to 2.1.9 shows a relay message of 56
    // characters or fewer as it is, and says only "Transcribe failed" for a
    // longer one.
    const wanted = resolveLanguage(cloud.model, body.language);
    if (wanted.refused) {
      log('cloud language refused for ' + user.email + ': ' + String(body.language).slice(0, 24).replace(/[^A-Za-z0-9_-]/g, '?'));
      throw Object.assign(new HttpError(400, LANGUAGE_REFUSED), { code: 'language' });
    }
    const language = wanted.language;
    const audioBase64 = String(body.audio || '');
    const format = String(body.format || 'wav').toLowerCase();
    if (format !== 'wav' || !audioBase64) throw new HttpError(400, 'Send base64 WAV audio.');
    const audio = Buffer.from(audioBase64, 'base64');
    const seconds = wavSeconds(audio);
    if (!(seconds > 0)) throw new HttpError(400, 'That is not a readable WAV clip.');
    if (seconds > MAX_CLIP_SECONDS) throw new HttpError(413, 'Clips over five minutes are not accepted.');
    const t = now();
    const standing = onTrial ? trialStanding(user) : cloudStanding(user, t);
    if (standing.seconds + (cloudReserved.get(user.id) || 0) + Math.ceil(seconds) > credits.secondsFromCredits(standing.capCredits)) {
      throw onTrial ? trialUsed() : Object.assign(new HttpError(402, credits.capMessage(account.cloud)), { code: 'cap' });
    }
    reservation.seconds = Math.ceil(seconds);
    cloudReserved.set(user.id, (cloudReserved.get(user.id) || 0) + reservation.seconds);
    const terms = Array.isArray(body.terms) ? body.terms.slice(0, 100).map((x) => String(x || '').slice(0, 64)) : [];
    // Which transcriber: a body piece goes to the body model while its lane is
    // on for this account, unless the app hurried it before it arrived, in
    // which case it goes straight to the usual model the rescue would have
    // reached. Everything else, tail pieces included, goes to the usual model.
    const lane = laneOf(body);
    const key = lane && lane.dictation ? pieceKey(user, lane.dictation, lane.piece) : '';
    const hurriedFirst = !!key && lane.lane === 'body' && takeHurriedEarly(key);
    const transcriber = lane && lane.lane === 'body' && lanesFor(user) && !hurriedFirst ? cloudBody : cloud;
    // A body piece out with the body model can be hurried (see urgent below).
    const urgent = transcriber === cloudBody && key ? new AbortController() : null;
    if (urgent) {
      if (!piecesOut.has(key)) piecesOut.set(key, new Set());
      piecesOut.get(key).add(urgent);
    }
    let result;
    const cancellation = new AbortController();
    const disconnected = () => cancellation.abort();
    req.socket?.once('close', disconnected);
    if (req.aborted || req.socket?.destroyed) disconnected();
    try {
      result = await transcriber.transcribe({ audioBase64, format, language, terms, seconds, signal: cancellation.signal,
        ...(urgent ? { urgent: urgent.signal } : {}) });
    } catch (err) {
      log('upstream failed for ' + user.email + ': ' + (err && err.message) + (lane ? laneNote(lane, hurriedFirst) : ''));
      throw Object.assign(new HttpError(502, (err && err.message) || 'The speech model failed.'), { code: err && err.code === 'timeout' ? 'timeout' : 'upstream' });
    } finally {
      req.socket?.removeListener('close', disconnected);
      if (urgent) {
        const out = piecesOut.get(key);
        if (out) {
          out.delete(urgent);
          if (!out.size) piecesOut.delete(key);
        }
      }
    }
    // At least one second per answered clip. AssemblyAI reports the audio's
    // exact length, and the store rounds each request to a whole second, so a
    // clip under half a second was charged nothing (MAI bills whole seconds,
    // which kept a one-word clip at 1). A client could have dictated in
    // sub-half-second pieces and used none of its allowance.
    //
    // A lane piece is charged its exact audio seconds from its own header,
    // whichever model answered and whatever that model bills: smaller pieces
    // must not drain an allowance faster because MAI rounds each one up.
    const charged = lane ? Math.max(1, seconds) : Math.max(1, result.billedSeconds > 0 ? result.billedSeconds : seconds);
    // Whether anybody is still listening. The app gives a clip a few seconds
    // and then tells the user it timed out; the model sometimes answers after
    // that. Those words reach nobody, so they are not charged for them. The
    // provider still bills us for the inference, and absorbing that is the
    // right way round: a dictation the user never saw is not one they bought.
    // The socket, not the request: an IncomingMessage destroys itself once its
    // body has been read, so req.destroyed is true on every healthy call. The
    // connection outliving the handler is what says somebody is still there.
    const abandoned = req.aborted === true || !!(req.socket && req.socket.destroyed);
    if (!abandoned) store.addUsageSeconds(user.id, dayOf(t), charged);
    store.touchSession(session.id, iso(t));
    // An answer from the usual model, as main or as the body model's rescue,
    // leaves it as warm as a warm-up would.
    if (result.model === cloud.model) legacyWarmAt = now();
    const after = onTrial ? trialStanding(user) : cloudStanding(user, t);
    log('cloud transcribed ' + charged.toFixed(1) + 's for ' + user.email + ' in ' + (now() - t) + 'ms'
      + ' (' + Math.round(after.seconds) + 's metered' + (result.cost ? ', $' + result.cost.toFixed(4) : '')
      + (result.hintsDropped ? ', hints dropped after a 400' : '')
      // A different model answered because the main one had gone quiet or
      // failed; the cost above is that model's. Logged with when the rescue
      // went out and why, so the timing can be tuned from real traffic.
      + (result.rescued
        ? ', rescued by ' + result.model + ' after ' + ((result.rescuedAfterMs || 0) / 1000).toFixed(1) + 's'
          + ' (sent at ' + ((result.rescueFiredAtMs || 0) / 1000).toFixed(1) + 's '
          + (result.rescueTrigger === 'error' ? 'after the main model failed'
            : result.rescueTrigger === 'urgent' ? 'after the app stopped' : 'when the main model went quiet') + ')'
          + (result.hedged ? ', hedge had fired too' : '')
        : (result.retried ? ', recovered after ' + (result.retries || 1) + ' retries' : '')
          // A second request was sent because the first went quiet. Logged so the
          // threshold can be tuned from real traffic: how often it fires, and how
          // often the second one is the one that answers.
          + (result.hedged ? (result.hedgeWon ? ', hedge fired and its request answered first' : ', hedge fired but the first request answered first') : '')
          // The rescue went out and the main model still answered first (or the
          // rescue failed). Each of these is a paid request that bought nothing.
          + (result.rescueFired ? (result.rescueFailed ? ', rescue fired and failed (' + result.rescueFailed + ')' : ', rescue fired but the main model answered first') : '')
          // The app hurried this piece at stop and the main model answered
          // inside CLOUD_URGENT_DELAY_MS, so no rescue was sent or paid for.
          + (result.hurried && !result.rescueFired ? ', hurried but answered before the rescue' : ''))
      + (onTrial ? ', trial' : '')
      + (abandoned ? ', NOT CHARGED: the app had stopped waiting' : '') + ')'
      // A lane piece says which lane and piece it was and which model answered,
      // so requests, speed and spend can be read per lane from the log.
      + (lane ? laneNote(lane, hurriedFirst) + ' model=' + result.model : ''));
    const timing = { relayMs: Math.max(0, now() - t), hedged: !!result.hedged, retried: !!result.retried, rescued: !!result.rescued };
    // Only a request that named its lane is told the lane, what sent a rescue
    // and which model answered; an app up to 2.1.10 gets the timing it always had.
    if (lane) {
      Object.assign(timing, {
        lane: lane.lane,
        trigger: result.rescueFired || result.rescued ? String(result.rescueTrigger || '') : '',
        source: result.rescued ? 'rescue' : 'main',
      });
    }
    return {
      text: result.text,
      seconds: Math.round(charged * 100) / 100,
      timing,
      ...(onTrial ? { cloud: withDictation(freeCloudMeter(t), user), trial: trialView(after.seconds) } : { cloud: withDictation(cloudMeter(after), user) }),
    };
  }

  // Hurry the caller's body pieces: the app has stopped and is waiting on
  // them. A piece out with the body model has its rescue sent now; a piece
  // whose request has not arrived yet is marked, for URGENT_EARLY_MS, to go
  // straight to the usual model when it does (at most URGENT_EARLY_PER_USER
  // marks live per account; `early` counts the ones stored). Pieces are the caller's own by
  // construction (keyed by account), so nobody can hurry someone else's.
  // Needs a session and nothing else: no slot, no credit check, no charge. It
  // is rate limited (URGENT_RATE), and each dictation is hurried once, for at
  // most urgentPiecesPerDictation pieces (URGENT_PIECES_PER_BODY_CALL).
  function hurryPieces(req, body) {
    const { user } = sessionFrom(req);
    // An account the body lane is not on for has no body pieces to hurry. It
    // is answered without a log line: the call costs nothing, and a log line
    // per call would let any signed-in client fill the log.
    if (!lanesFor(user)) return { hurried: 0, early: 0 };
    const dictation = String(body.dictation || '');
    if (!DICTATION_ID_RE.test(dictation)) throw Object.assign(new HttpError(400, 'Send the dictation id.'), { code: 'dictation' });
    if (!Array.isArray(body.pieces) || body.pieces.length > URGENT_MAX_PIECES) {
      throw Object.assign(new HttpError(400, 'Send up to ' + URGENT_MAX_PIECES + ' pieces.'), { code: 'pieces' });
    }
    // A dictation's second urgent call hurries nothing, and says so the same
    // way an account off the lanes is told: the app ignores the answer.
    if (!firstUrgent(user, dictation)) return { hurried: 0, early: 0 };
    const pieces = [...new Set(body.pieces.filter(isPiece))].slice(0, urgentPiecesPerDictation);
    let hurried = 0, early = 0;
    for (const piece of pieces) {
      const key = pieceKey(user, dictation, piece);
      const out = piecesOut.get(key);
      if (out && out.size) {
        for (const urgent of out) urgent.abort();
        hurried++;
      } else if (markHurriedEarly(user, key)) {
        // Counted only when stored: past the per-account bound a piece is
        // neither hurried nor marked, and goes to the body model if it comes.
        early++;
      }
    }
    // Logged only when it did something, so a stream of empty calls writes
    // nothing (the rate limit logs its own refusals).
    if (hurried + early > 0) log('urgent for ' + user.email + ': hurried ' + hurried + ', early ' + early);
    return { hurried, early };
  }

  // Spoken corrections: which pieces of a dictation the speaker took back.
  // For the same accounts as Polish, but not charged: the app asks only when a
  // dictation has a cue word in it, the answer is a few words, and a check in
  // the app decides whether any of it is used (src/spoken-corrections.js).
  async function takeBackPieces(req, body) {
    const { session, user } = sessionFrom(req);
    if (!corrector || !corrector.configured) {
      throw Object.assign(new HttpError(503, 'Spoken corrections are not available right now.'), { code: 'unconfigured' });
    }
    const account = accountFor(user);
    const onTrial = account.plan === 'free' && account.trial.available;
    if (account.plan !== 'pro' && !onTrial) {
      throw Object.assign(new HttpError(402, 'Spoken corrections with Voxden Cloud are part of Pro.'), { code: 'plan' });
    }
    // Not charged, but only while the account has cloud time to dictate with:
    // trial.available says a trial exists, not that any of it is left.
    if (!cloudTimeLeft(user, onTrial, now())) throw cloudTimeUsed(account, onTrial);
    const text = String(body.text || '').trim();
    if (!text) throw Object.assign(new HttpError(400, 'Send the dictation to check.'), { code: 'empty' });
    const words = (text.match(/\S+/g) || []).length;
    // A word count alone lets one unspaced run through as one word.
    if (words > CORRECTIONS_MAX_WORDS || text.length > CORRECTIONS_MAX_WORDS * 24) {
      throw Object.assign(new HttpError(413, 'Too long to check for corrections.'), { code: 'long' });
    }
    const cancellation = new AbortController();
    const disconnected = () => cancellation.abort();
    req.socket?.once('close', disconnected);
    if (req.aborted || req.socket?.destroyed) disconnected();
    const t = now();
    let result;
    try {
      result = await corrector.takeBack({ text, signal: cancellation.signal });
    } catch (err) {
      const code = (err && err.code) || 'upstream';
      log('corrections failed for ' + user.email + ' (' + words + ' words, ' + code + ', ' + (now() - t) + 'ms): '
        + (err && err.message));
      throw Object.assign(new HttpError(502, 'Spoken corrections did not answer this time.'),
        { code: code === 'timeout' ? 'timeout' : 'upstream' });
    } finally {
      req.socket?.removeListener('close', disconnected);
    }
    store.touchSession(session.id, iso(t));
    log('corrections ' + words + ' words for ' + user.email + ' in ' + (now() - t) + 'ms with ' + result.model
      + ' (' + result.remove.length + ' piece' + (result.remove.length === 1 ? '' : 's')
      + (result.cost ? ', $' + result.cost.toFixed(5) : '') + (result.fallback ? ', after the first model failed' : '') + ')');
    return { remove: result.remove };
  }

  // Polish, on request: Pro, or a free account's trial. Charged from the cloud
  // credits by length (src/credits.js), checked against the month's cap -- the
  // trial's minutes, for a free account -- before the model is asked, and
  // charged only when polished text comes back to somebody still waiting for
  // it. A refusal, a timeout or an answer the checks in server/polish.js reject
  // costs the user nothing.
  async function polishText(req, body, reservation) {
    const { session, user } = sessionFrom(req);
    if (!polisher || !polisher.configured) {
      throw Object.assign(new HttpError(503, 'Polish is not available right now.'), { code: 'unconfigured' });
    }
    const account = accountFor(user);
    const onTrial = account.plan === 'free' && account.trial.available;
    if (account.plan !== 'pro' && !onTrial) {
      throw Object.assign(new HttpError(402, 'Polish is part of Voxden Pro.'), { code: 'plan' });
    }
    const text = String(body.text || '').trim();
    if (!text) throw Object.assign(new HttpError(400, 'Send some text to polish.'), { code: 'empty' });
    // Polish, Grammar or Tighten (server/polish.js MODES), all at one price.
    // An app from before the modes sends none, and gets polish.
    const mode = body.mode === undefined ? 'polish' : String(body.mode);
    if (!POLISH_MODES.includes(mode)) throw Object.assign(new HttpError(400, 'Unknown polish mode.'), { code: 'mode' });
    const words = credits.polishWords(text);
    if (words > credits.POLISH_MAX_WORDS) {
      throw Object.assign(new HttpError(413, 'Polish takes up to ' + credits.POLISH_MAX_WORDS.toLocaleString() + ' words at a time.'), { code: 'long' });
    }
    const charge = credits.polishCredits(words);
    const seconds = credits.secondsFromCredits(charge);
    const t = now();
    const standing = onTrial ? trialStanding(user) : cloudStanding(user, t);
    if (standing.seconds + (cloudReserved.get(user.id) || 0) + Math.ceil(seconds) > credits.secondsFromCredits(standing.capCredits)) {
      throw onTrial ? trialUsed() : Object.assign(new HttpError(402, 'Not enough cloud credits left to polish this. It needs '
        + credits.creditAmountLabel(charge) + '.'), { code: 'cap' });
    }
    reservation.seconds = Math.ceil(seconds);
    cloudReserved.set(user.id, (cloudReserved.get(user.id) || 0) + reservation.seconds);
    const terms = Array.isArray(body.terms) ? body.terms.slice(0, 100).map((x) => String(x || '').slice(0, 64)) : [];
    const cancellation = new AbortController();
    const disconnected = () => cancellation.abort();
    req.socket?.once('close', disconnected);
    if (req.aborted || req.socket?.destroyed) disconnected();
    let result;
    try {
      result = await polisher.polish({ text, terms, mode, signal: cancellation.signal });
    } catch (err) {
      const code = (err && err.code) || 'upstream';
      // What the failure still cost the relay's key: every answer that came
      // back was priced; a call cut off by a timeout or a cancel was not.
      const e = err || {};
      const spent = (typeof e.cost === 'number' ? ', $' + e.cost.toFixed(5) : '')
        + (e.unpriced ? ', ' + e.unpriced + ' call unpriced' : '');
      log('polish failed for ' + user.email + ' (' + words + ' words, ' + code + spent + '): ' + (err && err.message));
      if (code === 'blocked') {
        throw Object.assign(new HttpError(422, 'This text could not be polished. Nothing was charged.'), { code });
      }
      throw Object.assign(new HttpError(502, code === 'timeout' ? 'Polish timed out. Nothing was charged.'
        : 'Polish did not work this time. Nothing was charged.'), { code: code === 'timeout' ? 'timeout' : 'upstream' });
    } finally {
      req.socket?.removeListener('close', disconnected);
    }
    const abandoned = req.aborted === true || !!(req.socket && req.socket.destroyed);
    if (!abandoned) store.addUsageSeconds(user.id, dayOf(t), seconds);
    store.touchSession(session.id, iso(t));
    const after = onTrial ? trialStanding(user) : cloudStanding(user, t);
    log((mode === 'polish' ? 'polished ' : mode + ' ') + words + ' words for ' + user.email + ' in ' + (now() - t) + 'ms with ' + result.model
      + ' (' + charge + ' credits' + (result.cost ? ', $' + result.cost.toFixed(5) : '')
      + (result.fallback ? ', after the first model declined' : '')
      + (onTrial ? ', trial' : '')
      + (abandoned ? ', NOT CHARGED: the app had stopped waiting' : '') + ')');
    return {
      text: result.text,
      mode,
      credits: abandoned ? 0 : charge,
      // With `dictation` as on a transcribe answer, so any cloud answer
      // refreshes the lane settings an app has cached.
      ...(onTrial ? { cloud: withDictation(freeCloudMeter(t), user), trial: trialView(after.seconds) } : { cloud: withDictation(cloudMeter(after), user) }),
    };
  }

  // Wake the model for a dictation that has just started. Nothing is metered
  // (the clip is the relay's own third of a second of silence) and the answer
  // is not awaited: the app fires this as the microphone opens and wants
  // nothing back. Same gates as a real clip, so a signed-out client, or a free
  // one with no trial minutes left, cannot make the service spend on warm-ups.
  //
  // ?lane=body is the warm-up of an app that sends body pieces: it wakes the
  // body model as well as the usual one (which still follows its own
  // CLOUD_WARMUP), for an account the body lane is on for. For anyone else it
  // is the plain warm-up.
  function warmModel(req, lane) {
    const { user } = sessionFrom(req);
    if (!cloud || !cloud.configured) {
      throw Object.assign(new HttpError(503, 'Cloud transcription is not available right now.'), { code: 'unconfigured' });
    }
    const account = accountFor(user);
    const onTrial = account.plan === 'free' && account.trial.available;
    if (account.plan !== 'pro' && !onTrial) {
      throw Object.assign(new HttpError(402, 'Cloud transcription needs a Pro plan.'), { code: 'plan' });
    }
    // An account warms the model only while it has cloud time to use it with,
    // a trial's minutes or Pro's month; once that is gone a warm-up is spend
    // with nothing to follow it.
    if (!cloudTimeLeft(user, onTrial, now())) throw cloudTimeUsed(account, onTrial);
    const started = now();
    // A body-lane warm-up reaches the usual model only once per
    // CLOUD_TAIL_WARM_EVERY_MS (see tailWarmEveryMs); a skipped one sends and
    // logs nothing. Every other warm-up reaches it as before, and is logged
    // only when the model is not already warm (isWarm: a clip in flight, one
    // answered moments ago, or warm-ups off for it), since only then does it
    // send anything.
    const bodyLane = lane === 'body' && lanesFor(user);
    if (!bodyLane || !tailWarmEveryMs || !legacyWarmAt || started - legacyWarmAt >= tailWarmEveryMs) {
      legacyWarmAt = started;
      if (!(typeof cloud.isWarm === 'function' && cloud.isWarm())) {
        cloud.warmUp().then(ok => {
          log('speech model warm-up ' + JSON.stringify({ ok: !!ok, ms: Math.max(0, now() - started) }));
        }, () => { log('speech model warm-up failed'); });
      }
    }
    // The body model's own window (CLOUD_BODY_WARM_EVERY_MS, counting its
    // answers) decides whether a clip goes up; a skipped one logs nothing.
    if (bodyLane && !cloudBody.isWarm()) {
      cloudBody.warmUp().then(ok => {
        log('body speech model warm-up ' + JSON.stringify({ ok: !!ok, ms: Math.max(0, now() - started) }));
      }, () => { log('body speech model warm-up failed'); });
    }
  }

  // --- billing --------------------------------------------------------------

  // The plans on offer to whoever asks. A placed account sees only its own
  // region's; a signed-out request, the region its address is in; a request
  // nothing can place, every region. A country the global offer is closed in
  // sees none, and is told why.
  function billingOptions(req) {
    const signedIn = sessionIfAny(req);
    const user = signedIn ? placeUser(signedIn.user, req) : null;
    const country = user ? String(user.country || '') : countryOf(req);
    const region = user ? (user.region || null) : (country ? regionOfCountry(country) : null);
    const closed = region === 'global' && closedCountries.has(country);
    const groups = billing && !closed ? billing.options().filter(group => !region || group.region === region) : [];
    return {
      region,
      ...(closed ? { unavailable: 'country' } : {}),
      options: groups.map(group => ({
        ...group,
        cloudHoursCap: credits.hoursFromCredits(cloudCreditsCap),
        cloudCreditsCap,
        // Zero when there is no welcome offer to make.
        welcomeCreditsCap: welcomeOn ? cloudWelcomeCredits : 0,
      })),
    };
  }

  // The checkouts each account started lately, by offer (provider, plan and
  // region), so a repeat within CHECKOUT_REUSE_MS is answered with the same
  // page. In memory: a restart forgets them, which only costs one more
  // subscription at the provider.
  const recentCheckouts = new Map();
  function rememberCheckout(userId, offerKey, answer, t) {
    if (recentCheckouts.size >= 5000) {
      for (const [id, offers] of recentCheckouts) {
        for (const [key, entry] of offers) if (t - entry.at >= CHECKOUT_REUSE_MS) offers.delete(key);
        if (!offers.size) recentCheckouts.delete(id);
      }
    }
    if (!recentCheckouts.has(userId)) recentCheckouts.set(userId, new Map());
    recentCheckouts.get(userId).set(offerKey, { answer, at: t });
  }

  async function checkout(req, body) {
    const { user: found } = sessionFrom(req);
    const user = placeUser(found, req);
    if (!billing) throw Object.assign(new HttpError(503, 'Payments are not set up yet.'), { code: 'unconfigured' });
    // Hiding the other region's price is the app's part; refusing it is this.
    // A placed account checks out in its own region, whatever it asks for. An
    // unplaced one names the region it picked. An app from before Razorpay
    // sold both names none, and to it Razorpay meant India.
    const asked = ['in', 'global'].includes(body.region) ? body.region : '';
    const region = user.region || asked || 'in';
    if ((asked && asked !== region) || (billing.provider(body.provider) && !billing.offerFor(body.provider, region))) {
      // The provider is the client's own text: quoted and cut, so a newline in
      // it cannot start a line of its own in the log.
      log('checkout refused for ' + user.email + ': ' + JSON.stringify(String(body.provider || '').slice(0, 40)) + ' '
        + (asked || region) + ' is not for region ' + region);
      throw Object.assign(new HttpError(400, 'That plan is not offered in your region.'), { code: 'region' });
    }
    if (region === 'global' && closedCountries.has(String(user.country || ''))) {
      log('checkout refused for ' + user.email + ': Pro is not sold in ' + user.country + ' yet');
      throw Object.assign(new HttpError(400, 'Voxden Pro is not sold in your country yet.'), { code: 'country' });
    }
    // One subscription per account. The app hides the button once Pro, but a
    // restart clears that state, and a user whose webhook is slow will happily
    // click again and pay twice. Same judgement as cancelling: anything not
    // ended is still going to charge.
    const live = store.subscriptionForUser(user.id);
    if (live && !ENDED_STATUSES.includes(String(live.status || '').toLowerCase())) {
      log('checkout refused for ' + user.email + ': ' + live.provider + ' subscription is still ' + live.status);
      throw Object.assign(new HttpError(409, 'This account already has a subscription. Open Plans and billing to manage it.'), { code: 'subscription' });
    }
    // Each checkout creates a subscription at the provider under our key, so
    // the same account asking again for the same offer within
    // CHECKOUT_REUSE_MS gets the page it was given, and nothing is created.
    const plan = normalizePlan(body.plan);
    const offerKey = String(body.provider || '').trim().toLowerCase() + '|' + plan + '|' + region;
    const t = now();
    const recent = recentCheckouts.get(user.id);
    const reused = recent && recent.get(offerKey);
    if (reused && t - reused.at < CHECKOUT_REUSE_MS) return { ...reused.answer };
    try {
      const result = await billing.createCheckout({ provider: body.provider, plan, user, region });
      log('checkout started for ' + user.email + ' via ' + result.provider + ' ' + result.plan + ' (' + result.region + ')');
      const answer = { url: result.url, provider: result.provider, plan: result.plan, region: result.region };
      rememberCheckout(user.id, offerKey, answer, t);
      return answer;
    } catch (err) {
      if (err && (err.code === 'provider' || err.code === 'plan')) throw new HttpError(400, err.message);
      log('checkout failed for ' + user.email + ': ' + ((err && err.message) || err));
      throw Object.assign(new HttpError(502, (err && err.message) || 'The payment provider did not answer.'), { code: 'provider' });
    }
  }

  function subscriptionView(sub, user) {
    if (!sub) return null;
    return {
      provider: sub.provider, plan: sub.plan, status: sub.status,
      periodEnd: sub.period_end, manageUrl: sub.manage_url,
      // Whether another charge is coming. Ended and cancelling both mean no.
      renews: !ENDED_STATUSES.includes(String(sub.status || '').toLowerCase()),
      label: billing ? billing.labelFor(sub.provider, sub.plan, user && user.region) : '',
    };
  }

  function billingStatus(req) {
    const { user } = sessionFrom(req);
    return { subscription: subscriptionView(store.subscriptionForUser(user.id), user), account: accountFor(user) };
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
    if (event.kind === 'support') return recordSupport(providerId, event);
    const t = now();
    if (!store.recordBillingEvent(providerId, event.eventKey, iso(t))) return { ok: true, handled: false, duplicate: true };
    // The account id in the provider's notes counts only while it still
    // belongs to the email sent with it: a deleted account's id is handed to
    // the next person who signs up, and its renewal must not make them Pro.
    const eventEmail = normalizeEmail(event.email);
    let user = event.userId ? store.userById(event.userId) : null;
    if (user && eventEmail && user.email !== eventEmail) user = null;
    if (!user && eventEmail) user = store.userByEmail(eventEmail);
    if (!user) {
      log('webhook ' + providerId + ' ' + event.type + ' for no known user (' + (event.email || 'no email') + ')');
      return { ok: true, handled: false };
    }
    applyBillingEvent(providerId, user, event);
    return { ok: true, handled: true };
  }

  // One normalised event on one account: the subscription row, the plan's
  // expiry, and the welcome month the first paid period starts.
  function applyBillingEvent(providerId, user, event) {
    const t = now();
    const expiry = billing.planExpiryFor(event);
    store.upsertSubscription({
      userId: user.id, provider: providerId, providerId: event.providerId, plan: event.plan,
      status: event.status, periodEnd: event.periodEnd ? iso(event.periodEnd) : null,
      periodStart: event.periodStart > 0 ? iso(event.periodStart) : null,
      manageUrl: event.manageUrl, updatedAt: iso(t),
    });
    // A live subscription that does not say when its paid period ends, such as
    // Razorpay's authenticated before the first charge, has nothing to grant.
    // Providers do not promise order, so it can also land after activation,
    // and then it must not end the period that activation paid for.
    if (event.type === 'active' && !expiry) {
      log('webhook ' + providerId + ' active without a period end: ' + user.email + ', plan unchanged');
      return;
    }
    store.setPlan(user.email, 'pro', expiry ? iso(expiry) : iso(t));
    log('webhook ' + providerId + ' ' + event.type + ': ' + user.email + ' pro until ' + (expiry ? iso(expiry) : 'now'));
    // The first paid period an account ever has is its welcome month, and it
    // ends at that period's end. Once per account: resubscribing later starts
    // no second one.
    if (event.type === 'active' && event.periodEnd > t && store.startWelcome(user.id, iso(event.periodEnd))) {
      log('welcome month for ' + user.email + ' until ' + iso(event.periodEnd));
    }
  }

  // --- Google Play Billing ----------------------------------------------------
  // The Android Play build buys on Google's sheet and reports the purchase
  // token here. See googleplay.js for the flow.

  function googlePlayOrThrow() {
    const google = billing && billing.googlePlay();
    if (!google) throw Object.assign(new HttpError(503, 'Payments are not open yet.'), { code: 'unconfigured' });
    return google;
  }

  // What the Android app needs to start a purchase: the product to ask Play
  // for, and the buyer's obfuscated id to hand it. `blocked` says why this
  // account should not buy: another subscription still has time on it.
  function googlePlayInfo(req) {
    const { user } = sessionFrom(req);
    const google = billing && billing.googlePlay();
    if (!google) return { configured: false };
    const latest = store.subscriptionForUser(user.id);
    const live = latest && !ENDED_STATUSES.includes(String(latest.status || '').toLowerCase());
    return {
      configured: true,
      productId: google.productId,
      accountId: google.accountIdFor(user),
      ...(live ? { blocked: 'subscription', provider: latest.provider } : {}),
    };
  }

  // Ask Google what a purchase token is, tie it to `user`, acknowledge it, and
  // apply it. Throws a purchase or provider error from Google as is. When the
  // buyer's own app is the one reporting, a purchase made for another account
  // is refused; a notification found its account by that id already.
  async function applyGooglePurchase(google, user, token, { reported = false } = {}) {
    const sub = await google.getSubscription(token);
    const event = google.describe(sub);
    if (reported && event.accountId && !google.accountIdMatches(user, event.accountId)) {
      log('googleplay purchase refused for ' + user.email + ': it was made for another account');
      throw Object.assign(new HttpError(409, 'That purchase belongs to another Voxden account.'), { code: 'account' });
    }
    if (event.type === 'ignored') {
      log('googleplay ' + user.email + ': a purchase that is not ours or not paid (' + event.status + ')');
      return { handled: false };
    }
    if (event.type === 'pending') return { handled: false, pending: true };
    // A cancelled or expired subscription from a token that an account's newer
    // subscription has replaced must not shorten the newer one's paid time.
    if (event.type === 'ended') {
      const latest = store.subscriptionForUser(user.id);
      if (latest && !(latest.provider === 'googleplay' && latest.provider_id === token) && Date.parse(latest.period_end) > now()) {
        log('googleplay ' + user.email + ': an older purchase ended; a newer subscription has paid time left, plan unchanged');
        return { handled: false, superseded: true };
      }
    }
    if (event.needsAcknowledge) {
      try {
        await google.acknowledge(event.productId, token);
      } catch (err) {
        // Google refunds an unacknowledged purchase after three days. The buyer
        // has paid, so they keep Pro, and the app's next report tries again.
        log('googleplay acknowledge failed for ' + user.email + ': ' + ((err && err.message) || err));
      }
    }
    if (event.testPurchase) log('googleplay test purchase for ' + user.email);
    applyBillingEvent('googleplay', user, { ...event, providerId: token, userId: user.id, email: user.email });
    return { handled: true };
  }

  // The Android app reports a purchase token Play gave it. 200 with the
  // billing status when Pro is on, 202 when the payment is still settling.
  async function googlePlayPurchase(req, body) {
    const { user } = sessionFrom(req);
    const google = googlePlayOrThrow();
    const token = String(body.purchaseToken || '');
    if (!token || token.length > 4096 || /\s/.test(token)) throw Object.assign(new HttpError(400, 'That purchase could not be read.'), { code: 'purchase' });
    if (body.productId && String(body.productId) !== google.productId) throw Object.assign(new HttpError(400, 'That is not the Voxden Pro product.'), { code: 'purchase' });
    const held = store.subscriptionByProviderId('googleplay', token);
    if (held && held.user_id !== user.id) {
      log('googleplay purchase refused for ' + user.email + ': the token belongs to another account');
      throw Object.assign(new HttpError(409, 'That purchase belongs to another Voxden account.'), { code: 'account' });
    }
    let result;
    try {
      result = await applyGooglePurchase(google, user, token, { reported: true });
    } catch (err) {
      if (err instanceof HttpError) throw err;
      if (err && err.code === 'purchase') throw Object.assign(new HttpError(400, 'Google Play does not know that purchase.'), { code: 'purchase' });
      log('googleplay purchase failed for ' + user.email + ': ' + ((err && err.message) || err));
      throw Object.assign(new HttpError(502, 'Google Play did not answer. Try again in a minute.'), { code: 'provider' });
    }
    if (result.pending) return { status: 202, body: { pending: true, ...billingStatus(req) } };
    if (!result.handled && !result.superseded) throw Object.assign(new HttpError(400, 'That purchase is not an active Voxden Pro subscription.'), { code: 'purchase' });
    return { status: 200, body: billingStatus(req) };
  }

  // Play's real-time developer notifications, pushed by Pub/Sub. The key in
  // the address is the only check on the sender, which is enough because a
  // notification grants nothing by itself: the token in it is looked up at
  // Google, and only for an account this service can tie it to. Anything but
  // a 2xx makes Pub/Sub send it again, so only a failure worth retrying is one.
  async function googlePlayNotification(req, raw) {
    const google = googlePlayOrThrow();
    const key = new URL(req.url, 'http://x').searchParams.get('key');
    if (!google.pushKeyOk(key)) throw new HttpError(403, 'Bad key.');
    let message = null;
    try { message = google.parsePush(JSON.parse(raw.toString('utf8'))); } catch (_) { /* not JSON */ }
    if (!message) return { ok: true, handled: false };
    if (message.test) { log('googleplay test notification received'); return { ok: true, handled: false, test: true }; }
    if (message.ignored) return { ok: true, handled: false };
    const known = store.subscriptionByProviderId('googleplay', message.token);
    let user = known ? store.userById(known.user_id) : null;
    try {
      if (!user) {
        const claimed = google.describe(await google.getSubscription(message.token)).accountId;
        const owner = google.accountIdUser(claimed) ? store.userById(google.accountIdUser(claimed)) : null;
        user = owner && google.accountIdMatches(owner, claimed) ? owner : null;
      }
      if (!user) {
        log('googleplay notification for a purchase no account can be tied to yet; the app\'s report will settle it');
        return { ok: true, handled: false };
      }
      const result = await applyGooglePurchase(google, user, message.token);
      return { ok: true, handled: result.handled };
    } catch (err) {
      if (err && err.code === 'purchase') return { ok: true, handled: false };
      log('googleplay notification failed: ' + ((err && err.message) || err));
      throw new HttpError(502, 'Google Play did not answer.');
    }
  }

  // --- support toward the signing goal ----------------------------------------

  // Rupees, for a payment in `currency`'s smallest unit.
  function rupeesOf(amount, currency) {
    return currency === 'USD' ? (amount / 100) * supportUsdInr : amount / 100;
  }

  // The goal as the website draws it. Public, and cheap enough to be asked
  // every few seconds by every open page: two small queries.
  function supportGoal() {
    const totals = store.supportTotals();
    const t = now();
    return {
      goalInr: supportGoalInr,
      raisedInr: Math.round(totals.inr),
      contributions: totals.count,
      deadline: supportDeadline,
      usdInr: supportUsdInr,
      // Amounts and times only: nobody's name or email ever leaves here.
      recent: store.recentSupport(6).map((row) => ({ amount: row.amount / 100, currency: row.currency, at: row.paidAt })),
      open: !!(billing && billing.supportProvider && billing.supportProvider()),
      serverTime: iso(t),
    };
  }

  async function supportOrder(body, ip) {
    if (!billing || !billing.supportProvider || !billing.supportProvider()) {
      throw Object.assign(new HttpError(503, 'Payments are not set up yet.'), { code: 'unconfigured' });
    }
    const currency = String(body.currency || '').trim().toUpperCase();
    const limits = SUPPORT_LIMITS[currency];
    if (!limits) throw Object.assign(new HttpError(400, 'Pay in rupees or dollars.'), { code: 'currency' });
    const amount = Number(body.amount);
    if (!Number.isInteger(amount) || amount < limits.min || amount > limits.max) {
      const unit = currency === 'INR' ? '₹' : '$';
      throw Object.assign(new HttpError(400, 'Choose an amount from ' + unit + (limits.min / 100).toLocaleString('en-IN')
        + ' to ' + unit + (limits.max / 100).toLocaleString('en-IN') + '.'), { code: 'amount' });
    }
    const t = now();
    const recent = (supportOrdersByIp.get(ip) || []).filter((at) => at > t - 3600e3);
    if (recent.length >= SUPPORT_ORDERS_PER_IP_PER_HOUR) {
      throw Object.assign(new HttpError(429, 'That is a lot of tries for one hour. Wait a little and try again.'), { code: 'busy' });
    }
    recent.push(t);
    supportOrdersByIp.set(ip, recent);
    if (supportOrdersByIp.size > 5000) {
      for (const [key, times] of supportOrdersByIp) if (!times.some((at) => at > t - 3600e3)) supportOrdersByIp.delete(key);
    }
    try {
      const order = await billing.createSupportOrder({ amount, currency, receipt: 'support-' + t.toString(36) });
      log('support order ' + order.orderId + ' for ' + (amount / 100) + ' ' + currency);
      return { provider: order.provider, orderId: order.orderId, keyId: order.keyId, amount: order.amount, currency: order.currency };
    } catch (err) {
      log('support order failed: ' + ((err && err.message) || err));
      throw Object.assign(new HttpError(502, 'The payment could not be started. Try again in a minute.'), { code: 'provider' });
    }
  }

  // A paid support order, from the provider's signed webhook: the only way
  // the total grows. Idempotent by payment, so a retried event counts once.
  function recordSupport(providerId, event) {
    const limits = SUPPORT_LIMITS[event.currency];
    if (!limits) {
      log('support payment ' + event.paymentId + ' in ' + event.currency + ' not counted: unknown currency');
      return { ok: true, handled: false };
    }
    const t = now();
    const fresh = store.recordSupport({
      provider: providerId, paymentId: event.paymentId, orderId: event.orderId,
      amount: event.amount, currency: event.currency, amountInr: rupeesOf(event.amount, event.currency),
      paidAt: iso(event.paidAt || t), createdAt: iso(t),
    });
    if (!fresh) return { ok: true, handled: false, duplicate: true };
    const totals = store.supportTotals();
    log('support payment ' + event.paymentId + ': ' + (event.amount / 100) + ' ' + event.currency
      + '; raised ₹' + Math.round(totals.inr) + ' of ₹' + supportGoalInr + ' from ' + totals.count);
    broadcastSupport();
    return { ok: true, handled: true };
  }

  // The goal as a stream of server-sent events: the totals once on connect,
  // again after every recorded payment, and a comment every 25 s so nothing
  // in between closes an idle line. Past the cap a page is told to poll.
  function openSupportStream(req, res, cors) {
    if (supportStreams.size >= SUPPORT_STREAMS_MAX) {
      return send(res, 503, { error: 'Too many pages watching. Polling works too.', code: 'busy' }, cors);
    }
    res.writeHead(200, Object.assign({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no',
    }, cors || {}));
    // Something in the body at once, so a proxy that holds headers until the
    // first byte (Caddy's encode does) still opens the stream.
    res.write('retry: 5000\n\ndata: ' + JSON.stringify(supportGoal()) + '\n\n');
    supportStreams.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    ping.unref();
    const close = () => { clearInterval(ping); supportStreams.delete(res); };
    req.on('close', close);
    res.on('close', close);
  }

  function broadcastSupport() {
    if (!supportStreams.size) return;
    const message = 'data: ' + JSON.stringify(supportGoal()) + '\n\n';
    for (const res of supportStreams) {
      try { res.write(message); } catch (_) { supportStreams.delete(res); }
    }
  }

  // CORS for the support routes, for the website's own origins only.
  function supportCors(req) {
    const origin = String(req.headers.origin || '').replace(/\/+$/, '');
    if (!origin || !supportOrigins.has(origin)) return {};
    return { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' };
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
        // A web page can send text/plain here without asking first; only
        // application/json needs the browser's permission, which is given
        // only to voxden.app and only for /v1/support. So a page someone
        // visits cannot mail codes or post feedback.
        if (!/^application\/json\b/i.test(String(req.headers['content-type'] || '').trim())) {
          return reject(new HttpError(415, 'Send JSON with Content-Type: application/json.'));
        }
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

  function send(res, status, body, headers) {
    const payload = body === undefined ? '' : JSON.stringify(body);
    res.writeHead(status, Object.assign({
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Length': Buffer.byteLength(payload),
    }, headers || {}));
    res.end(payload);
  }

  function clientIp(req) {
    // Behind a reverse proxy the socket address is the proxy's; the proxy is
    // configured to set this header and to overwrite any the client sent.
    const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    return forwarded || (req.socket && req.socket.remoteAddress) || '';
  }

  async function handle(req, res) {
    // Node's parser lets through request targets WHATWG URL refuses ("//[").
    // Thrown here, outside the try below, one left the request unanswered.
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch (_) { return send(res, 400, { error: 'Bad request.' }); }
    const route = req.method + ' ' + url.pathname;
    // Every answer on a support route carries CORS, errors included, so the
    // page can read why it was refused.
    const cors = ['/v1/support', '/v1/support/order', '/v1/support/stream'].includes(url.pathname) ? supportCors(req) : null;
    try {
      if (route === 'GET /healthz') return send(res, 200, { ok: true });
      if (cors && req.method === 'OPTIONS') {
        return send(res, 204, undefined, cors['Access-Control-Allow-Origin'] ? Object.assign({
          'Access-Control-Allow-Methods': 'GET, POST',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '600',
        }, cors) : {});
      }
      if (route === 'GET /v1/support') return send(res, 200, supportGoal(), cors);
      if (route === 'GET /v1/support/stream') return openSupportStream(req, res, cors);
      if (route === 'POST /v1/support/order') return send(res, 200, await supportOrder(await readJson(req), clientIp(req)), cors);
      if (route === 'POST /v1/auth/code') {
        await requestCode(await readJson(req), clientIp(req));
        return send(res, 204);
      }
      if (route === 'POST /v1/auth/verify') {
        return send(res, 200, verifyCode(await readJson(req), req));
      }
      if (route === 'GET /v1/auth/options') return send(res, 200, authOptions());
      if (route === 'POST /v1/auth/google') return send(res, 200, await googleSignIn(await readJson(req), req));
      if (route === 'GET /v1/me') return send(res, 200, me(req));
      if (route === 'PUT /v1/me/profile') return send(res, 200, updateProfile(req, await readJson(req)));
      if (route === 'DELETE /v1/me') {
        await deleteAccount(req);
        return send(res, 204);
      }
      // The same answer, for a client that has a free-word figure to report.
      if (route === 'POST /v1/me') return send(res, 200, me(req, await readJson(req)));
      if (route === 'GET /v1/billing/options') return send(res, 200, billingOptions(req));
      if (route === 'POST /v1/billing/checkout') return send(res, 200, await checkout(req, await readJson(req)));
      if (route === 'GET /v1/billing') return send(res, 200, billingStatus(req));
      if (route === 'POST /v1/billing/cancel') return send(res, 200, await cancelSubscription(req));
      if (route === 'GET /v1/billing/googleplay') return send(res, 200, googlePlayInfo(req));
      if (route === 'POST /v1/billing/googleplay/purchase') {
        const result = await googlePlayPurchase(req, await readJson(req));
        return send(res, result.status, result.body);
      }
      if (route === 'POST /v1/billing/webhook/googleplay') return send(res, 200, await googlePlayNotification(req, await readRaw(req, 256 * 1024)));
      const hook = /^POST \/v1\/billing\/webhook\/([a-z]+)$/.exec(route);
      if (hook) return send(res, 200, webhook(hook[1], req, await readRaw(req, 256 * 1024)));
      // The session, and room for the body (admitUpload), are checked before
      // the body is read, so a request without either is refused before the
      // service holds megabytes of it.
      if (route === 'POST /v1/transcribe') {
        const { user } = sessionFrom(req);
        const body = await readCloudBody(user, req, MAX_AUDIO_BODY_BYTES);
        // A piece that names its lane runs in that lane's pool, whichever
        // model it ends up with; anything else in the general one.
        const lane = laneOf(body);
        return send(res, 200, await oneCloudCall(user, reservation => transcribe(req, body, reservation), lane ? lane.lane : 'general'));
      }
      if (route === 'POST /v1/polish') {
        const { user } = sessionFrom(req);
        const body = await readCloudBody(user, req, MAX_POLISH_BODY_BYTES);
        return send(res, 200, await oneCloudCall(user, reservation => polishText(req, body, reservation)));
      }
      if (route === 'POST /v1/corrections') {
        const { user } = sessionFrom(req);
        const body = await readCloudBody(user, req, MAX_POLISH_BODY_BYTES);
        return send(res, 200, await oneCloudCall(user, () => takeBackPieces(req, body)));
      }
      if (route === 'POST /v1/transcribe/warm') {
        takeWarm(sessionFrom(req).user);
        warmModel(req, url.searchParams.get('lane'));
        return send(res, 204);
      }
      if (route === 'POST /v1/transcribe/urgent') {
        takeUrgent(sessionFrom(req).user);
        return send(res, 200, hurryPieces(req, await readJson(req)));
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
        return send(res, err.status, err.code ? { error: err.message, code: err.code } : { error: err.message }, cors);
      }
      log('error on ' + route + ': ' + ((err && err.stack) || err));
      return send(res, 500, { error: 'Something went wrong on our side. Try again in a minute.' }, cors);
    }
  }

  // Ends every live goal stream, so a server closing for a restart is not
  // held open by pages that are only watching. They reconnect on their own.
  function closeStreams() {
    for (const res of supportStreams) { try { res.end(); } catch (_) {} }
    supportStreams.clear();
  }

  // `lanes` is what the lane options came to, for the start-up log line.
  const lanes = {
    on: !!cloudBody,
    model: cloudBody ? cloudBody.model : '',
    rescueModel: cloudBody ? cloudBody.settings.rescueModel : '',
    users: lanesForAll ? '*' : laneUserSet.size,
    settings: dictationSettings,
    tailWarmEveryMs,
  };
  return { handle, requestCode, verifyCode, accountFor, closeStreams, lanes, CODE_MINUTES };
}

module.exports = { createApp, normalizeEmail, periodOf, dayOf, creditMonthOf, regionOfCountry, DEFAULT_CLOSED_COUNTRIES, SUPPORT_LIMITS, HttpError };
