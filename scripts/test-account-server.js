'use strict';

// The account service, end to end, against an in-memory database.

const assert = require('assert');
const http = require('http');
const { createStore } = require('../server/store');
const { createApp, periodOf } = require('../server/app');

let checks = 0;
function ok(label, value) { assert.ok(value, label); checks++; process.stdout.write('ok ' + label + '\n'); }
function eq(label, actual, expected) {
  assert.deepStrictEqual(actual, expected, label + '\n  got: ' + JSON.stringify(actual));
  checks++; process.stdout.write('ok ' + label + '\n');
}

async function main() {
  let clock = Date.parse('2026-09-11T09:00:00Z');
  const sent = [];
  const store = createStore(':memory:');
  const mailer = { sendCode: async (m) => { sent.push(m); }, configured: false };
  const app = createApp({ store, mailer, now: () => clock, cloudHoursCap: 10 });
  const server = http.createServer(app.handle);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const call = async (method, route, body, token) => {
    const res = await fetch(base + route, {
      method, headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };

  try {
    eq('health', (await call('GET', '/healthz')).status, 200);
    eq('unknown route', (await call('GET', '/v1/nothing')).status, 404);

    // --- request a code -----------------------------------------------------
    eq('a bad address is refused', (await call('POST', '/v1/auth/code', { email: 'nope' })).status, 400);
    eq('a good address gets 204', (await call('POST', '/v1/auth/code', { email: ' Someone@Example.com ' })).status, 204);
    eq('the code went to the normalised address', sent[0].to, 'someone@example.com');
    ok('six digits', /^\d{6}$/.test(sent[0].code));

    // --- verify -------------------------------------------------------------
    const wrong = await call('POST', '/v1/auth/verify', { email: 'someone@example.com', code: '000000' });
    eq('a wrong code is 400', wrong.status, 400);
    const good = await call('POST', '/v1/auth/verify', { email: 'someone@example.com', code: sent[0].code, device: 'Test PC' });
    eq('the right code signs in', good.status, 200);
    ok('with a token', typeof good.body.token === 'string' && good.body.token.length >= 40);
    eq('and a free account', good.body.account.plan, 'free');
    eq('with no cloud hours', good.body.account.cloud.hoursCap, 0);
    const reuse = await call('POST', '/v1/auth/verify', { email: 'someone@example.com', code: sent[0].code });
    eq('a code is single-use', reuse.status, 400);
    const token = good.body.token;

    // --- me -----------------------------------------------------------------
    eq('no token is 401', (await call('GET', '/v1/me')).status, 401);
    eq('a made-up token is 401', (await call('GET', '/v1/me', undefined, 'x'.repeat(43))).status, 401);
    const me = await call('GET', '/v1/me', undefined, token);
    eq('the session reads the account', me.status, 200);
    eq('as the same user', me.body.account.email, 'someone@example.com');

    // --- plan and usage -----------------------------------------------------
    const user = store.userByEmail('someone@example.com');
    store.setPlan('someone@example.com', 'pro', '2027-01-01T00:00:00.000Z');
    store.addUsageSeconds(user.id, periodOf(clock), 4500);
    const pro = (await call('GET', '/v1/me', undefined, token)).body.account;
    eq('pro shows through /me', pro.plan, 'pro');
    eq('with the cap', pro.cloud.hoursCap, 10);
    eq('and the hours the relay metered', pro.cloud.hoursUsed, 1.25);
    eq('and the month it resets', pro.cloud.periodEnd, '2026-10-01T00:00:00.000Z');
    clock = Date.parse('2027-01-02T00:00:00Z');
    const lapsed = (await call('GET', '/v1/me', undefined, token)).body.account;
    eq('an expired pro is free', lapsed.plan, 'free');
    eq('and says so without a date', lapsed.planExpiresAt, null);
    clock = Date.parse('2026-09-11T09:00:00Z');

    // --- attempts and expiry ------------------------------------------------
    await call('POST', '/v1/auth/code', { email: 'second@example.com' });
    for (let i = 0; i < 5; i++) await call('POST', '/v1/auth/verify', { email: 'second@example.com', code: '111111' });
    const burned = await call('POST', '/v1/auth/verify', { email: 'second@example.com', code: sent[1].code });
    ok('five wrong attempts burn the code', burned.status === 400 && /Too many/.test(burned.body.error));
    await call('POST', '/v1/auth/code', { email: 'second@example.com' });
    clock += 11 * 60e3;
    const late = await call('POST', '/v1/auth/verify', { email: 'second@example.com', code: sent[2].code });
    ok('a code is dead after ten minutes', late.status === 400 && /expired/.test(late.body.error));

    // --- rate limit ---------------------------------------------------------
    let last = 0;
    for (let i = 0; i < 6; i++) last = (await call('POST', '/v1/auth/code', { email: 'third@example.com' })).status;
    eq('the sixth code in an hour is refused', last, 429);
    clock += 3600e3 + 1;
    eq('and allowed again an hour later', (await call('POST', '/v1/auth/code', { email: 'third@example.com' })).status, 204);

    // --- sign out -----------------------------------------------------------
    eq('sign-out is 204', (await call('POST', '/v1/auth/signout', undefined, token)).status, 204);
    eq('and the token is dead', (await call('GET', '/v1/me', undefined, token)).status, 401);

    // --- oversized and malformed bodies -------------------------------------
    eq('junk JSON is 400', (await fetch(base + '/v1/auth/code', { method: 'POST', body: '{nope' })).status, 400);
    eq('a huge body is refused', (await fetch(base + '/v1/auth/code', { method: 'POST', body: '{"email":"' + 'a'.repeat(5000) + '"}' })).status, 413);
  } finally {
    server.close();
    store.close();
  }
  process.stdout.write('all ' + checks + ' account service checks passed\n');
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
