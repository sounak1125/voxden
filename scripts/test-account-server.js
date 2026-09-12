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
    eq('and 600 credits', pro.cloud.creditsCap, 600);
    eq('and the hours the relay metered', pro.cloud.hoursUsed, 1.25);
    eq('as credits', pro.cloud.creditsUsed, 75);
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

    const lifetime = createApp({
      store, mailer, now: () => clock, cloudHoursCap: 10, cloudCreditsCap: 3000, cloudCreditsReset: 'never',
    });
    const lifetimeServer = http.createServer(lifetime.handle);
    await new Promise((r) => lifetimeServer.listen(0, '127.0.0.1', r));
    const lifetimeBase = 'http://127.0.0.1:' + lifetimeServer.address().port;
    const lifetimeMe = await fetch(lifetimeBase + '/v1/me', { headers: { Authorization: 'Bearer ' + token } }).then((res) => res.json());
    eq('a lifetime pool keeps the metered minutes', lifetimeMe.account.cloud.creditsUsed, 75);
    eq('and the $5 developer cap', lifetimeMe.account.cloud.creditsCap, 3000);
    eq('without a monthly reset', lifetimeMe.account.cloud.reset, 'never');
    lifetimeServer.close();

    // --- feedback -----------------------------------------------------------
    eq('a report needs a kind', (await call('POST', '/v1/feedback', { message: 'x' })).status, 400);
    eq('and some words', (await call('POST', '/v1/feedback', { kind: 'bug', message: ' ' })).status, 400);
    eq('a bad address is refused', (await call('POST', '/v1/feedback', { kind: 'bug', message: 'x', email: 'nope' })).status, 400);
    eq('an anonymous report is 204', (await call('POST', '/v1/feedback',
      { kind: 'idea', message: 'Dark icons', diagnostics: { version: '2.1.2', plan: 'free', device: '' } })).status, 204);
    const anonReport = store.recentFeedback(1)[0];
    eq('it is stored with no account and its details as lines',
      [anonReport.user_id, anonReport.email, anonReport.kind, anonReport.diagnostics], [null, '', 'idea', 'version: 2.1.2\nplan: free']);
    eq('and open, with no thread yet', [anonReport.status, anonReport.thread_id], ['open', '']);
    eq('a signed-in report is 204', (await call('POST', '/v1/feedback', { kind: 'bug', message: 'Paste lands twice' }, token)).status, 204);
    eq('and carries the account address', store.recentFeedback(1)[0].email, 'someone@example.com');
    eq('a stale token still gets through as anonymous',
      (await call('POST', '/v1/feedback', { kind: 'other', message: 'hi' }, 'x'.repeat(43))).status, 204);
    // With Discord configured, the post happens after the row exists and a
    // Discord failure keeps the row.
    const discordPosts = [];
    let discordDown = false;
    const withDiscord = createApp({ store, mailer, now: () => clock, discord: {
      configured: true,
      post: async (report) => { discordPosts.push(report); if (discordDown) throw new Error('Discord returned 502'); return { threadId: 't-' + report.id, messageId: 'm-' + report.id }; },
    } });
    const discordServer = http.createServer(withDiscord.handle);
    await new Promise((r) => discordServer.listen(0, '127.0.0.1', r));
    const discordBase = 'http://127.0.0.1:' + discordServer.address().port;
    const postJson = (body) => fetch(discordBase + '/v1/feedback', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    eq('a report with Discord configured is 204', (await postJson({ kind: 'bug', message: 'Crash on paste', diagnostics: { version: '2.1.2' } })).status, 204);
    const posted = store.recentFeedback(1)[0];
    eq('the post carried the row id, words and details', [discordPosts.at(-1).id, discordPosts.at(-1).kind, discordPosts.at(-1).diagnostics], [posted.id, 'bug', 'version: 2.1.2']);
    eq('and the thread is remembered on the row', [posted.thread_id, posted.message_id], ['t-' + posted.id, 'm-' + posted.id]);
    discordDown = true;
    eq('a Discord failure does not lose the report', (await postJson({ kind: 'bug', message: 'still stored' })).status, 204);
    eq('it is in the table without a thread', [store.recentFeedback(1)[0].message, store.recentFeedback(1)[0].thread_id], ['still stored', '']);
    discordServer.close();
    // Five reports so far from this address (the store is shared); ten an
    // hour is the ceiling.
    for (let i = 5; i < 10; i++) eq('report ' + (i + 1) + ' is still taken', (await call('POST', '/v1/feedback', { kind: 'other', message: 'more ' + i })).status, 204);
    eq('the eleventh report in an hour is 429', (await call('POST', '/v1/feedback', { kind: 'other', message: 'one more' })).status, 429);

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
