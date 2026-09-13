'use strict';

// The welcome month. A subscriber's first credit month brings 1,200 cloud
// credits, every month after it 900, and credit months run from one billing
// date to the next. Real HTTP against an in-memory database, with signed
// Razorpay webhooks and a stand-in speech model.

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { createStore } = require('../server/store');
const { createApp, creditMonthOf } = require('../server/app');
const { createBilling, hmacHex } = require('../server/billing');

let checks = 0;
function eq(label, actual, expected) {
  assert.deepStrictEqual(actual, expected, label + '\n  got: ' + JSON.stringify(actual));
  checks++;
  process.stdout.write('ok ' + label + '\n');
}

const at = (text) => Date.parse(text);
const iso = (ms) => new Date(ms).toISOString();

// A canonical 16 kHz mono 16-bit WAV of the given length, silence.
function wav(seconds) {
  const rate = 16000;
  const data = Buffer.alloc(Math.round(seconds * rate) * 2);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + data.length, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

function checkCreditMonths() {
  const span = (month) => [iso(month.start), iso(month.end)];
  eq('without a billing date, the credit month is the calendar month',
    span(creditMonthOf(0, at('2026-09-13T12:00:00Z'))), ['2026-09-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z']);
  const renewal = at('2026-10-20T10:30:00Z');
  eq('a subscriber\'s month runs from billing date to billing date',
    span(creditMonthOf(renewal, at('2026-09-25T08:00:00Z'))), ['2026-09-20T00:00:00.000Z', '2026-10-20T00:00:00.000Z']);
  eq('and the next one starts at midnight on the renewal day',
    span(creditMonthOf(renewal, at('2026-10-20T00:00:00Z'))), ['2026-10-20T00:00:00.000Z', '2026-11-20T00:00:00.000Z']);
  eq('months long after the last renewal still land on the billing day',
    span(creditMonthOf(renewal, at('2027-03-02T00:00:00Z'))), ['2027-02-20T00:00:00.000Z', '2027-03-20T00:00:00.000Z']);
  const monthEnd = at('2027-01-31T09:00:00Z');
  eq('the 31st renews on the last day of a short month',
    span(creditMonthOf(monthEnd, at('2027-02-15T00:00:00Z'))), ['2027-01-31T00:00:00.000Z', '2027-02-28T00:00:00.000Z']);
  eq('and on the 31st again once the month has one',
    span(creditMonthOf(monthEnd, at('2027-03-05T00:00:00Z'))), ['2027-02-28T00:00:00.000Z', '2027-03-31T00:00:00.000Z']);
}

// A database written before usage was kept by day.
function checkMonthlyUsageMigrates() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voxden-usage-'));
  const file = path.join(dir, 'before.sqlite');
  const before = new DatabaseSync(file);
  before.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE, plan TEXT NOT NULL DEFAULT 'free', plan_expires_at TEXT, created_at TEXT NOT NULL);"
    + ' CREATE TABLE usage (user_id INTEGER NOT NULL REFERENCES users (id), period TEXT NOT NULL, seconds INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (user_id, period));'
    + " INSERT INTO users (id, email, created_at) VALUES (1, 'early@example.com', '2026-08-01T00:00:00Z');"
    + " INSERT INTO usage VALUES (1, '2026-08', 600), (1, '2026-09', 2088);");
  before.close();
  const store = createStore(file);
  eq('a month of usage moves to its first day', store.usageSecondsBetween(1, '2026-09-01', '2026-10-01'), 2088);
  eq('and each month keeps its own', store.usageSecondsBetween(1, '2026-08-01', '2026-09-01'), 600);
  eq('nothing is lost', store.usageSecondsTotal(1), 2688);
  store.close();
  const again = createStore(file);
  eq('opening it again moves nothing twice', again.usageSecondsTotal(1), 2688);
  again.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

async function main() {
  checkCreditMonths();
  checkMonthlyUsageMigrates();

  let clock = at('2026-09-20T10:00:00Z');
  const store = createStore(':memory:');
  const billing = createBilling({
    razorpay: { keyId: 'rzp_key', keySecret: 'rzp_secret', webhookSecret: 'whsec', planMonthly: 'plan_M' },
    now: () => clock,
  });
  const speech = { configured: true, async transcribe() { return { text: 'hello', billedSeconds: 5, cost: 0 }; } };
  const mailer = { sendCode: async () => {} };
  const servers = [];
  const serve = async (app) => {
    const server = http.createServer(app.handle);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    servers.push(server);
    return 'http://127.0.0.1:' + server.address().port + '/v1';
  };
  const base = await serve(createApp({ store, mailer, now: () => clock, billing, cloud: speech }));

  const signIn = (email) => {
    const user = store.findOrCreateUser(email, iso(clock));
    const token = 'tok_' + crypto.randomBytes(24).toString('hex');
    store.createSession({ tokenHash: crypto.createHash('sha256').update(token).digest('hex'), userId: user.id, device: 'test', createdAt: iso(clock) });
    return { user, token };
  };
  const me = async (url, token) => (await (await fetch(url + '/me', { headers: { Authorization: 'Bearer ' + token } })).json()).account;
  const offer = async (url) => (await (await fetch(url + '/billing/options')).json()).options[0];
  const transcribe = async (url, token, seconds) => {
    const res = await fetch(url + '/transcribe', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ audio: wav(seconds).toString('base64'), format: 'wav' }),
    });
    return { status: res.status, body: await res.json() };
  };
  let eventId = 0;
  const webhook = async (url, event, entity) => {
    const raw = JSON.stringify({ event, payload: { subscription: { entity } } });
    const res = await fetch(url + '/billing/webhook/razorpay', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Razorpay-Signature': hmacHex('whsec', raw), 'X-Razorpay-Event-Id': 'evt_' + (++eventId) },
      body: raw,
    });
    return res.json();
  };
  const subscription = (user, id, status, currentEnd) => ({
    id, status, plan_id: 'plan_M', current_end: Math.floor(at(currentEnd) / 1000),
    notes: { voxden_user: String(user.id), voxden_plan: 'monthly' },
  });

  try {
    // --- before subscribing ---------------------------------------------------
    const offered = await offer(base);
    eq('the plan offers 900 credits a month and 1,200 in the first',
      [offered.cloudCreditsCap, offered.cloudHoursCap, offered.welcomeCreditsCap], [900, 15, 1200]);
    const { user, token } = signIn('new@example.com');
    let account = await me(base, token);
    eq('a new account can take the offer', account.welcomeOffer, { credits: 1200, monthlyCredits: 900, eligible: true });
    eq('and has no cloud credits on Free', account.cloud.creditsCap, 0);
    store.addUsageSeconds(user.id, '2026-09-19', 600);

    // --- the welcome month ----------------------------------------------------
    eq('Razorpay activates the subscription',
      (await webhook(base, 'subscription.activated', subscription(user, 'sub_1', 'active', '2026-10-20T10:00:00Z'))).handled, true);
    account = await me(base, token);
    eq('the first month is the welcome month, with 1,200 credits',
      [account.plan, account.cloud.welcome, account.cloud.creditsCap, account.cloud.hoursCap], ['pro', true, 1200, 20]);
    eq('it ends at midnight on the first renewal day', account.cloud.periodEnd, '2026-10-20T00:00:00.000Z');
    eq('and says what every month after it brings', account.cloud.monthlyCredits, 900);
    eq('the offer is now taken', account.welcomeOffer.eligible, false);
    eq('usage from the day before subscribing is not this month\'s', account.cloud.creditsUsed, 0);

    store.addUsageSeconds(user.id, '2026-09-25', 900 * 60 + 30);
    const past900 = await transcribe(base, token, 5);
    eq('past 900 credits the welcome month keeps dictating',
      [past900.status, past900.body.cloud.creditsCap, past900.body.cloud.welcome], [200, 1200, true]);
    store.addUsageSeconds(user.id, '2026-10-01', 300 * 60 - 40);
    const past1200 = await transcribe(base, token, 10);
    eq('and stops at 1,200', [past1200.status, past1200.body.code], [402, 'cap']);

    await webhook(base, 'subscription.charged', subscription(user, 'sub_1', 'active', '2026-10-20T10:00:00Z'));
    eq('another event for the same period starts nothing new',
      [(await me(base, token)).cloud.welcome, store.userById(user.id).welcome_until], [true, '2026-10-20T10:00:00.000Z']);
    store.upsertSubscription({ userId: user.id, provider: 'razorpay', providerId: 'sub_1', plan: 'monthly', status: 'active',
      periodEnd: null, manageUrl: '', updatedAt: iso(clock) });
    eq('an event without a period end keeps the billing date', store.subscriptionForUser(user.id).period_end, '2026-10-20T10:00:00.000Z');

    // --- every month after ----------------------------------------------------
    clock = at('2026-10-20T03:00:00Z');
    account = await me(base, token);
    eq('on the renewal day the month turns over to 900 credits, from zero',
      [account.plan, account.cloud.welcome, account.cloud.creditsCap, account.cloud.creditsUsed], ['pro', false, 900, 0]);
    eq('running to the next billing date', account.cloud.periodEnd, '2026-11-20T00:00:00.000Z');
    await webhook(base, 'subscription.charged', subscription(user, 'sub_1', 'active', '2026-11-20T10:00:00Z'));
    account = await me(base, token);
    eq('the renewal itself changes nothing more',
      [account.cloud.welcome, account.cloud.creditsCap, account.cloud.periodEnd], [false, 900, '2026-11-20T00:00:00.000Z']);
    const renewed = await transcribe(base, token, 5);
    eq('and the month is charged from zero', [renewed.status, renewed.body.cloud.creditsUsed, renewed.body.cloud.creditsCap], [200, 0.08, 900]);

    // --- once per account -----------------------------------------------------
    await webhook(base, 'subscription.cancelled', subscription(user, 'sub_1', 'cancelled', '2026-11-20T10:00:00Z'));
    clock = at('2027-01-05T09:00:00Z');
    account = await me(base, token);
    eq('a lapsed subscriber is on Free and cannot take the offer again', [account.plan, account.welcomeOffer.eligible], ['free', false]);
    await webhook(base, 'subscription.activated', subscription(user, 'sub_2', 'active', '2027-02-05T09:00:00Z'));
    account = await me(base, token);
    eq('coming back starts an ordinary month on the new billing date',
      [account.plan, account.cloud.welcome, account.cloud.creditsCap, account.cloud.periodEnd], ['pro', false, 900, '2027-02-05T00:00:00.000Z']);

    // --- a service with the offer switched off ----------------------------------
    const plain = await serve(createApp({ store, mailer, now: () => clock, billing, cloud: speech, cloudWelcomeCredits: 0 }));
    eq('no welcome figure is offered', (await offer(plain)).welcomeCreditsCap, 0);
    const later = signIn('later@example.com');
    eq('and nobody is told they can take one', (await me(plain, later.token)).welcomeOffer, { credits: 0, monthlyCredits: 900, eligible: false });
    await webhook(plain, 'subscription.activated', subscription(later.user, 'sub_3', 'active', '2027-02-05T09:00:00Z'));
    account = await me(plain, later.token);
    eq('a first month is then an ordinary one', [account.cloud.welcome, account.cloud.creditsCap], [false, 900]);
  } finally {
    for (const server of servers) server.close();
    store.close();
  }
  process.stdout.write('all ' + checks + ' welcome credit checks passed\n');
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
