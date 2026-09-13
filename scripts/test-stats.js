'use strict';

// The numbers the service can answer for, and the way the bot says them:
// what the store counts, what /v1/me records when an app reports its free
// week, and what /stats and the Monday digest put in the channel.

const assert = require('assert');
const http = require('http');
const { createStore } = require('../server/store');
const { createApp } = require('../server/app');
const { createDesk } = require('../server/desk');
const stats = require('../server/stats');

let checks = 0;
function eq(label, actual, expected) {
  assert.deepStrictEqual(actual, expected, label + '\n  got: ' + JSON.stringify(actual));
  checks += 1;
  process.stdout.write('ok ' + label + '\n');
}

function ok(label, actual) {
  assert.strictEqual(actual, true, label + '\n  got: ' + JSON.stringify(actual));
  checks += 1;
  process.stdout.write('ok ' + label + '\n');
}

const DAY = 86400e3;
// A Saturday, so the digest's Monday rule has something to refuse.
const SATURDAY = Date.parse('2026-09-12T09:00:00.000Z');
const MONDAY = Date.parse('2026-09-14T09:00:00.000Z');

function iso(ms) {
  return new Date(ms).toISOString();
}

async function main() {
  eq('the week key is the Monday it falls in', stats.mondayOf(SATURDAY), '2026-09-07');
  eq('and a Monday is its own key', stats.mondayOf(MONDAY), '2026-09-14');

  // --- what /v1/me records ---------------------------------------------------
  const store = createStore(':memory:');
  const sent = [];
  let clock = SATURDAY;
  const app = createApp({
    store, now: () => clock, freeWeeklyWords: 3000,
    mailer: { sendCode: async (m) => { sent.push(m); } },
  });
  const server = http.createServer(app.handle);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;

  const call = async (method, path, body, token) => {
    const res = await fetch(base + path, {
      method,
      headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };

  await call('POST', '/v1/auth/code', { email: 'free@example.com' });
  const signIn = await call('POST', '/v1/auth/verify', { email: 'free@example.com', code: sent[0].code });
  const token = signIn.body.token;
  const user = store.userByEmail('free@example.com');

  const periodStart = SATURDAY - 2 * DAY;
  const reported = await call('POST', '/v1/me', { freeWords: { used: 1840, cap: 3000, periodStart } }, token);
  eq('a report is answered with the same account as a plain check', reported.body.account.email, 'free@example.com');
  eq('and the week is recorded', store.wordUsage(user.id, iso(periodStart)).words, 1840);

  await call('POST', '/v1/me', { freeWords: { used: 900, cap: 3000, periodStart } }, token);
  eq('a second PC reporting less does not lower it', store.wordUsage(user.id, iso(periodStart)).words, 1840);
  await call('POST', '/v1/me', { freeWords: { used: 2600, cap: 3000, periodStart } }, token);
  eq('reporting more raises it', store.wordUsage(user.id, iso(periodStart)).words, 2600);

  eq('a plain GET still works and records nothing new',
    (await call('GET', '/v1/me', undefined, token)).body.account.plan, 'free');
  eq('junk is dropped rather than stored',
    (await call('POST', '/v1/me', { freeWords: { used: -5, cap: 3000, periodStart: SATURDAY - 5 * DAY } }, token)).status, 200);
  eq('so nothing was written for it', store.wordUsage(user.id, iso(SATURDAY - 5 * DAY)), null);
  eq('and a period from another decade is refused',
    store.wordUsage(user.id, iso(SATURDAY - 900 * DAY)), null);
  await call('POST', '/v1/me', { freeWords: { used: 10, cap: 3000, periodStart: SATURDAY - 900 * DAY } }, token);
  eq('really refused', store.wordUsage(user.id, iso(SATURDAY - 900 * DAY)), null);
  eq('no token, no report', (await call('POST', '/v1/me', { freeWords: { used: 1, cap: 3000, periodStart } })).status, 401);
  server.close();

  // --- what the numbers say --------------------------------------------------
  const paid = store.findOrCreateUser('pro@example.com', iso(SATURDAY - 3 * DAY));
  store.setPlan('pro@example.com', 'pro', iso(SATURDAY + 30 * DAY));
  store.addUsageSeconds(paid.id, '2026-09-10', 3000);
  store.addUsageSeconds(paid.id, '2026-09-11', 1500);
  store.addUsageSeconds(paid.id, '2026-08-31', 600);
  store.upsertSubscription({
    userId: paid.id, provider: 'razorpay', providerId: 'sub_1', plan: 'monthly',
    status: 'active', periodEnd: iso(SATURDAY + 30 * DAY), manageUrl: '', updatedAt: iso(SATURDAY),
  });
  const lapsed = store.findOrCreateUser('was@example.com', iso(SATURDAY - 40 * DAY));
  store.setPlan('was@example.com', 'pro', iso(SATURDAY - DAY));
  store.reportWordUsage(lapsed.id, iso(SATURDAY - DAY), 3000, 3000, iso(SATURDAY));

  const snap = stats.snapshot(store, SATURDAY);
  eq('every account is counted', snap.users, 3);
  eq('an expired plan is not paid any more', snap.paid, 1);
  eq('conversion is a percentage of accounts', snap.conversion, 33.3);
  eq('cloud minutes come from the metered seconds', [snap.cloudMinutes, snap.cloudAccounts], [75, 1]);
  eq('free weeks that are still running are counted', [snap.freeReporting, snap.freeWords, snap.freeAtCap], [2, 5600, 1]);
  eq('and the cap-hit rate is of those reporting', snap.capHitRate, 50);
  eq('live subscriptions are grouped', snap.subscriptions, [{ provider: 'razorpay', plan: 'monthly', count: 1 }]);

  const old = stats.snapshot(store, SATURDAY + 30 * DAY);
  eq('a week that has turned over drops out of the figures', [old.freeReporting, old.freeAtCap], [0, 0]);

  // --- how it reads ----------------------------------------------------------
  const text = stats.format(snap, null);
  ok('it leads with the day', text.startsWith('**Voxden — 2026-09-12**'));
  ok('it names the cap-hit rate', /1 of 2\*\* hit the cap \(50%\)/.test(text));
  ok('it says where money actually lives', /provider dashboards/.test(text));
  ok('no address reaches the channel', !/example\.com/.test(text));

  const risen = stats.format(snap, Object.assign({}, snap, { users: 1, paid: 0 }));
  ok('a rise against yesterday is shown', /Accounts \*\*3\*\* \+2/.test(risen));
  ok('on every figure that moved', /Pro \*\*1\*\* \+1/.test(risen));
  const fallen = stats.format(snap, Object.assign({}, snap, { users: 5, activeThisWeek: 9 }));
  ok('a fall is shown as one', /Accounts \*\*3\*\* −2/.test(fallen));
  ok('and not dressed up as a rise', !/Accounts \*\*3\*\* \+/.test(fallen));
  eq('a day with nothing to compare shows no movement', /[+−]/.test(stats.format(snap, null).split('\n')[1]), false);

  const quiet = stats.snapshot(createStore(':memory:'), SATURDAY);
  ok('a service nobody uses still reads sensibly', /no app has reported a running week yet/.test(stats.format(quiet, null)));

  // --- the bot ---------------------------------------------------------------
  const rest = [];
  let deskClock = SATURDAY;
  const deskFetch = async (url, init) => {
    const method = (init && init.method) || 'GET';
    const path = url.replace('https://discord.com/api/v10', '');
    rest.push({ method, path, body: init && init.body ? JSON.parse(init.body) : undefined });
    return { ok: true, status: 200, text: async () => '{}', json: async () => ({}) };
  };
  const desk = createDesk({
    token: 'bot-token', store, fetchImpl: deskFetch, log: () => {},
    statsChannelId: 'chan-stats', now: () => deskClock,
    setTimeout: () => 1, clearTimeout: () => {},
  });

  await desk.onInteraction({ type: 2, id: 'i-1', token: 'tok', data: { name: 'stats' }, member: { user: { username: 'x' } } });
  const reply = rest.at(-1);
  eq('/stats answers the interaction', reply.path, '/interactions/i-1/tok/callback');
  eq('and only the person who asked sees it', reply.body.data.flags, 1 << 6);
  ok('with the numbers in it', reply.body.data.content.startsWith('**Voxden — '));

  rest.length = 0;
  eq('the digest holds off until Monday', await desk.postDigest(false), false);
  eq('and posted nothing', rest.length, 0);

  deskClock = MONDAY;
  eq('on Monday it posts', await desk.postDigest(false), true);
  eq('into the channel it was given', rest.at(-1).path, '/channels/chan-stats/messages');
  ok('with nobody pinged', rest.at(-1).body.allowed_mentions.parse.length === 0);
  eq('and not twice in the same week', await desk.postDigest(false), false);
  eq('unless it is asked for by hand', await desk.postDigest(true), true);

  deskClock = MONDAY + 7 * DAY;
  eq('the next Monday is its own week', await desk.postDigest(false), true);

  const silent = createDesk({ token: 'bot-token', store, fetchImpl: deskFetch, log: () => {}, setTimeout: () => 1, clearTimeout: () => {} });
  eq('a service with no stats channel posts nothing', await silent.postDigest(true), false);

  store.close();
  process.stdout.write('\n' + checks + ' checks passed\n');
}

main().catch((err) => {
  process.stderr.write((err && err.stack ? err.stack : String(err)) + '\n');
  process.exitCode = 1;
});
