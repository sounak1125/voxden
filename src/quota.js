'use strict';

// The free plan's weekly words.
//
// Voxden Free dictates on this PC with whichever engine the user picked --
// Parakeet, Qwen or Whisper -- and never through the cloud: server/app.js
// refuses /v1/transcribe to a free account and src/cloud.js does not even ask.
// What Free does not do is run forever. An account gets FREE_WEEKLY_WORDS
// words in a seven-day period, and when they are spent dictation stops until
// the period turns over or the account upgrades.
//
// The period starts on the first dictation, not on a calendar day. Somebody
// who installs on a Thursday gets their words back on a Thursday, and a week
// in which nothing was dictated never starts one at all.
//
// The counter lives on this PC. Free dictation runs with no network, so there
// is nobody to ask when the words are spent; the file is the only ledger that
// is always there. Dictation history is not that ledger -- it can be cleared
// and it prunes itself. The cap itself comes from the account service when it
// has been heard from, so the number can be retuned without shipping a build,
// and falls back to FREE_WEEKLY_WORDS.
//
// Pure: state goes in, a new state or a reading comes out. main.js owns the
// file, the plan check and the notifications.

const metrics = require('./metrics');

const FREE_WEEKLY_WORDS = 3000;
const PERIOD_MS = 7 * 24 * 3600e3;
// One nudge before the words run out, then the one that says they have.
const WARN_AT = 80;

// Words are counted exactly the way Insights counts them, so the sidebar
// meter and the dictation totals can never disagree about what a word is.
const countWords = metrics.countWords;

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function normalizeCap(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : FREE_WEEKLY_WORDS;
}

function normalizeState(raw) {
  const state = raw && typeof raw === 'object' ? raw : {};
  const periodStart = Math.max(0, Math.round(num(state.periodStart)));
  return {
    periodStart,
    words: periodStart > 0 ? Math.max(0, Math.round(num(state.words))) : 0,
  };
}

// Whether the seven days that were started are still running.
//
// A clock moved backwards leaves `now` before the period it is inside. That
// keeps the period live rather than starting a fresh one, which is the strict
// reading and the only one that does not hand out a second allowance for
// changing a system setting.
function periodLive(state, now) {
  const s = normalizeState(state);
  return s.periodStart > 0 && num(now) < s.periodStart + PERIOD_MS;
}

function isoDay(ms) {
  return ms > 0 ? new Date(ms).toISOString().slice(0, 10) : '';
}

// What the app should act on: how many words this account has left, and when
// it gets more. `cap` is the service's figure when there is one.
function meter(state, options) {
  const opts = options || {};
  const s = normalizeState(state);
  const now = num(opts.now) || Date.now();
  const cap = normalizeCap(opts.cap);
  const live = periodLive(s, now);
  const used = live ? Math.min(s.words, Number.MAX_SAFE_INTEGER) : 0;
  const periodEnd = live ? s.periodStart + PERIOD_MS : 0;
  return {
    cap,
    used,
    remaining: Math.max(0, cap - used),
    percent: cap > 0 ? Math.min(100, Math.max(0, (used / cap) * 100)) : 0,
    exhausted: cap > 0 && used >= cap,
    // False until the first dictation of a period, and again once it lapses.
    started: live,
    periodStart: live ? s.periodStart : 0,
    periodEnd,
    resetsOn: isoDay(periodEnd),
  };
}

// Charge a finished dictation. Starts a period when none is running, so the
// seven days are counted from the first word said rather than from install.
function add(state, words, now) {
  const s = normalizeState(state);
  const n = Math.max(0, Math.round(num(words)));
  if (!n) return s;
  const t = num(now) || Date.now();
  return periodLive(s, t)
    ? { periodStart: s.periodStart, words: s.words + n }
    : { periodStart: t, words: n };
}

// The cap this account is under, as the account service last reported it.
function capFor(account) {
  return normalizeCap(account && account.freeWeeklyWords);
}

// Whether this snapshot is a free account at all. Pro has no word meter.
function appliesTo(account) {
  return !!(account && account.plan !== 'pro');
}

function displayWords(value) {
  return Math.max(0, Math.round(num(value))).toLocaleString();
}

function usageLabel(reading) {
  if (!reading || !(reading.cap > 0)) return '';
  return displayWords(reading.used) + ' of ' + displayWords(reading.cap) + ' free words used this week.';
}

function remainingLabel(reading) {
  if (!reading || !(reading.cap > 0)) return '';
  const left = displayWords(reading.remaining);
  return left + (left === '1' ? ' word left' : ' words left');
}

// Short enough for the flow bar, which has one line and no room for a date.
function blockedFlash() {
  return 'Free words used up — upgrade to keep dictating';
}

// The long version, for the notification and the billing page.
function blockedMessage(reading) {
  const cap = displayWords(reading && reading.cap);
  const on = reading && reading.resetsOn;
  return 'Your ' + cap + ' free words for this week are used up.'
    + (on ? ' They come back on ' + on + '.' : '')
    + ' Voxden Pro lifts the weekly limit and adds cloud dictation.';
}

// Notifications for the bell, idempotent by id: the period start makes each
// week its own, so a nudge fires once per period and never comes back after
// it is cleared.
function pendingWarnings(reading) {
  if (!reading || !(reading.cap > 0) || !reading.started) return [];
  const key = 'free-words:' + reading.periodStart;
  if (reading.exhausted) {
    return [{
      id: key + ':spent',
      kind: 'credits',
      title: 'Free words used up',
      body: blockedMessage(reading),
      action: { settings: 'billing' },
    }];
  }
  if (reading.percent >= WARN_AT) {
    return [{
      id: key + ':' + WARN_AT,
      kind: 'credits',
      title: 'Most of this week’s free words are used',
      body: usageLabel(reading)
        + ' Dictation pauses when they run out'
        + (reading.resetsOn ? ', until ' + reading.resetsOn : '')
        + '. Voxden Pro lifts the weekly limit.',
      action: { settings: 'billing' },
    }];
  }
  return [];
}

module.exports = {
  FREE_WEEKLY_WORDS,
  PERIOD_MS,
  WARN_AT,
  countWords,
  normalizeCap,
  normalizeState,
  periodLive,
  meter,
  add,
  capFor,
  appliesTo,
  displayWords,
  usageLabel,
  remainingLabel,
  blockedFlash,
  blockedMessage,
  pendingWarnings,
};
