'use strict';

// The free plan's weekly words, as rules: when a period starts, what it counts,
// when it lapses, and what the app is told to say.

const assert = require('assert');
const quota = require('../src/quota');

let checks = 0;
function eq(label, actual, expected) {
  assert.deepStrictEqual(actual, expected, label + '\n  got: ' + JSON.stringify(actual));
  checks++;
  process.stdout.write('ok ' + label + '\n');
}

function ok(label, actual) {
  assert.strictEqual(actual, true, label + '\n  got: ' + JSON.stringify(actual));
  checks++;
  process.stdout.write('ok ' + label + '\n');
}

const DAY = 86400e3;
const T0 = Date.parse('2026-09-12T09:00:00.000Z');

// --- the cap ----------------------------------------------------------------

eq('the shipped cap is three thousand words', quota.FREE_WEEKLY_WORDS, 3000);
eq('a service figure wins', quota.capFor({ freeWeeklyWords: 1500 }), 1500);
eq('a PC that has never been told falls back', quota.capFor({ freeWeeklyWords: null }), 3000);
eq('so does one told nonsense', quota.capFor({ freeWeeklyWords: -5 }), 3000);
eq('and one with no account at all', quota.capFor(null), 3000);

eq('free accounts are metered', quota.appliesTo({ plan: 'free' }), true);
eq('a signed-out snapshot is still free', quota.appliesTo({ plan: 'free', signedIn: false }), true);
eq('pro is not metered in words', quota.appliesTo({ plan: 'pro' }), false);
eq('no account manager, no meter', quota.appliesTo(null), false);

// --- counting ---------------------------------------------------------------

eq('words are counted the way Insights counts them', quota.countWords('  two  words '), 2);

const fresh = quota.normalizeState(null);
eq('a PC that has never dictated has no period', fresh, { periodStart: 0, words: 0 });
eq('a file with words but no period start keeps neither', quota.normalizeState({ words: 900 }), { periodStart: 0, words: 0 });

const first = quota.add(fresh, 120, T0);
eq('the first dictation starts the seven days', first, { periodStart: T0, words: 120 });

const second = quota.add(first, 80, T0 + 2 * DAY);
eq('a later dictation adds to the same period', second, { periodStart: T0, words: 200 });

eq('an empty dictation starts nothing', quota.add(fresh, 0, T0), { periodStart: 0, words: 0 });

// --- the reading ------------------------------------------------------------

const mid = quota.meter(second, { cap: 3000, now: T0 + 3 * DAY });
eq('used is what was said', mid.used, 200);
eq('remaining is the rest', mid.remaining, 2800);
eq('the week is running', mid.started, true);
eq('and it is not spent', mid.exhausted, false);
eq('the reset day is seven days on', mid.resetsOn, '2026-09-19');

const spent = quota.meter({ periodStart: T0, words: 3000 }, { cap: 3000, now: T0 + DAY });
eq('the cap exactly is spent', spent.exhausted, true);
eq('nothing is left', spent.remaining, 0);
eq('the bar is full', spent.percent, 100);

const over = quota.meter({ periodStart: T0, words: 3200 }, { cap: 3000, now: T0 + DAY });
eq('a dictation that ran past the cap is not charged twice over', over.remaining, 0);
eq('and the bar does not run past full', over.percent, 100);

// A week that has gone by is a week the user gets back.
const lapsed = quota.meter({ periodStart: T0, words: 3000 }, { cap: 3000, now: T0 + 7 * DAY });
eq('seven days later the words are back', [lapsed.used, lapsed.remaining, lapsed.exhausted], [0, 3000, false]);
eq('and no period is running until the next dictation', [lapsed.started, lapsed.periodStart, lapsed.resetsOn], [false, 0, '']);
eq('a dictation after the lapse starts a fresh week',
  quota.add({ periodStart: T0, words: 3000 }, 10, T0 + 7 * DAY),
  { periodStart: T0 + 7 * DAY, words: 10 });

// A clock moved backwards must not hand out a second allowance.
eq('winding the clock back keeps the period that is running',
  quota.add({ periodStart: T0, words: 3000 }, 10, T0 - 3 * DAY),
  { periodStart: T0, words: 3010 });
eq('and the words stay spent',
  quota.meter({ periodStart: T0, words: 3000 }, { cap: 3000, now: T0 - 3 * DAY }).exhausted, true);

// The service can retune the number without an installer.
eq('a smaller cap bites sooner',
  quota.meter({ periodStart: T0, words: 900 }, { cap: 500, now: T0 + DAY }).exhausted, true);
eq('a bigger one gives room back',
  quota.meter({ periodStart: T0, words: 900 }, { cap: 5000, now: T0 + DAY }).remaining, 4100);

// --- what the user is told --------------------------------------------------

eq('a week nobody has started says nothing', quota.pendingWarnings(lapsed), []);
eq('a quiet week says nothing either', quota.pendingWarnings(mid), []);

const warned = quota.pendingWarnings(quota.meter({ periodStart: T0, words: 2400 }, { cap: 3000, now: T0 + DAY }));
eq('one nudge at eighty per cent', warned.map((row) => row.id), ['free-words:' + T0 + ':80']);
eq('it opens the billing page', warned[0].action, { settings: 'billing' });

const stopped = quota.pendingWarnings(spent);
eq('the spent notice replaces the nudge rather than joining it',
  stopped.map((row) => row.id), ['free-words:' + T0 + ':spent']);
ok('it says when the words come back', stopped[0].body.includes('2026-09-19'));

// Each week gets its own notification ids, so a nudge that was cleared in one
// week still arrives in the next.
eq('a later week warns again under its own id',
  quota.pendingWarnings(quota.meter({ periodStart: T0 + 30 * DAY, words: 3000 }, { cap: 3000, now: T0 + 31 * DAY }))[0].id,
  'free-words:' + (T0 + 30 * DAY) + ':spent');

ok('the flow bar gets one short line', quota.blockedFlash().length <= 48);
ok('the long version names the plan that lifts the limit', quota.blockedMessage(spent).includes('Voxden Pro'));

process.stdout.write('\n' + checks + ' checks passed\n');
