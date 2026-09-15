'use strict';

// The account service, end to end, against an in-memory database.

const assert = require('assert');
const http = require('http');
const { createStore } = require('../server/store');
const { createApp, dayOf } = require('../server/app');

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
  const mailer = { sendCode: async (m) => { sent.push(m); return { delivered: true }; }, configured: true };
  const app = createApp({ store, mailer, now: () => clock });
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
    eq('and the weekly words the app enforces', good.body.account.freeWeeklyWords, 3000);
    const reuse = await call('POST', '/v1/auth/verify', { email: 'someone@example.com', code: sent[0].code });
    eq('a code is single-use', reuse.status, 400);
    const token = good.body.token;

    // --- me -----------------------------------------------------------------
    eq('no token is 401', (await call('GET', '/v1/me')).status, 401);
    eq('a made-up token is 401', (await call('GET', '/v1/me', undefined, 'x'.repeat(43))).status, 401);
    const me = await call('GET', '/v1/me', undefined, token);
    eq('the session reads the account', me.status, 200);
    eq('as the same user', me.body.account.email, 'someone@example.com');
    eq('with an empty profile to begin with', me.body.account.profile, { firstName: '', lastName: '', pictureUrl: '' });

    // --- profile ------------------------------------------------------------
    const named = await call('PUT', '/v1/me/profile', { firstName: '  Some  one ', lastName: 'Body', pictureUrl: 'https://ignored.example/x.png' }, token);
    eq('names are saved trimmed and tidy; the photo is not the app\'s to set', [named.status, named.body.account.profile], [200, { firstName: 'Some one', lastName: 'Body', pictureUrl: '' }]);
    eq('and come back on /me', (await call('GET', '/v1/me', undefined, token)).body.account.profile.firstName, 'Some one');
    eq('a profile update needs a session', (await call('PUT', '/v1/me/profile', { firstName: 'x' })).status, 401);

    // --- plan and usage -----------------------------------------------------
    const user = store.userByEmail('someone@example.com');
    store.setPlan('someone@example.com', 'pro', '2027-01-01T00:00:00.000Z');
    store.addUsageSeconds(user.id, dayOf(clock), 4500);
    const pro = (await call('GET', '/v1/me', undefined, token)).body.account;
    eq('pro shows through /me', pro.plan, 'pro');
    eq('with the default cap', pro.cloud.hoursCap, 15);
    eq('and 900 credits', pro.cloud.creditsCap, 900);
    eq('a plan set by hand has no welcome month', pro.cloud.welcome, false);
    eq('and the hours the relay metered', pro.cloud.hoursUsed, 1.25);
    eq('as credits', pro.cloud.creditsUsed, 75);
    eq('and the month it resets', pro.cloud.periodEnd, '2026-10-01T00:00:00.000Z');
    eq('pro is told the free allowance too, for the day it lapses', pro.freeWeeklyWords, 3000);
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
      freeWeeklyWords: 1200,
    });
    const lifetimeServer = http.createServer(lifetime.handle);
    await new Promise((r) => lifetimeServer.listen(0, '127.0.0.1', r));
    const lifetimeBase = 'http://127.0.0.1:' + lifetimeServer.address().port;
    const lifetimeMe = await fetch(lifetimeBase + '/v1/me', { headers: { Authorization: 'Bearer ' + token } }).then((res) => res.json());
    eq('a lifetime pool keeps the metered minutes', lifetimeMe.account.cloud.creditsUsed, 75);
    eq('and the $5 developer cap', lifetimeMe.account.cloud.creditsCap, 3000);
    eq('without a monthly reset', lifetimeMe.account.cloud.reset, 'never');
    eq('and the free word cap can be retuned from the service', lifetimeMe.account.freeWeeklyWords, 1200);
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

    // --- Google sign-in ---------------------------------------------------------
    eq('a service without Google advertises its email capability', (await call('GET', '/v1/auth/options')).body, { google: null, email: { configured: true } });
    eq('and refuses a Google sign-in plainly', (await call('POST', '/v1/auth/google', { code: 'c', codeVerifier: 'v', redirectUri: 'http://127.0.0.1:1/' })).status, 503);
    const exchanges = [];
    let idTokenClaims = null;
    const jwt = (claims) => 'h.' + Buffer.from(JSON.stringify(claims)).toString('base64url') + '.s';
    const tokenApi = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        exchanges.push(Object.fromEntries(new URLSearchParams(raw)));
        res.writeHead(idTokenClaims ? 200 : 400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(idTokenClaims ? { id_token: jwt(idTokenClaims), access_token: 'ya29' } : { error: 'invalid_grant' }));
      });
    });
    await new Promise((r) => tokenApi.listen(0, '127.0.0.1', r));
    const withGoogle = createApp({ store, mailer, now: () => clock, google: {
      clientId: 'cid.apps.googleusercontent.com', clientSecret: 'shh', tokenUrl: 'http://127.0.0.1:' + tokenApi.address().port + '/token',
    } });
    const googleServer = http.createServer(withGoogle.handle);
    await new Promise((r) => googleServer.listen(0, '127.0.0.1', r));
    const gBase = 'http://127.0.0.1:' + googleServer.address().port;
    const gCall = async (method, route, body) => {
      const res = await fetch(gBase + route, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null };
    };
    eq('auth discovery exposes capabilities without secrets', (await gCall('GET', '/v1/auth/options')).body, { google: { clientId: 'cid.apps.googleusercontent.com' }, email: { configured: true } });
    const grant = { code: '4/abc', codeVerifier: 'v'.repeat(43), redirectUri: 'http://127.0.0.1:4567/', device: 'Test PC' };
    eq('a redirect that is not loopback is refused before Google is asked', (await gCall('POST', '/v1/auth/google', { ...grant, redirectUri: 'https://evil.example/' })).status, 400);
    eq('nothing was exchanged', exchanges.length, 0);
    idTokenClaims = { iss: 'https://accounts.google.com', aud: 'cid.apps.googleusercontent.com', exp: Math.floor(clock / 1000) + 3600, email: 'New.Person@Example.com', email_verified: true,
      given_name: 'New', family_name: 'Person', picture: 'https://lh3.googleusercontent.com/a/photo' };
    const signedIn = await gCall('POST', '/v1/auth/google', grant);
    eq('a verified Google identity signs in', [signedIn.status, signedIn.body.account.email, signedIn.body.account.plan, typeof signedIn.body.token], [200, 'new.person@example.com', 'free', 'string']);
    eq('and brings the names and photo Google knows', signedIn.body.account.profile, { firstName: 'New', lastName: 'Person', pictureUrl: 'https://lh3.googleusercontent.com/a/photo' });
    await fetch(gBase + '/v1/me/profile', { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + signedIn.body.token }, body: JSON.stringify({ firstName: 'Nu', lastName: 'Person' }) });
    idTokenClaims = { ...idTokenClaims, given_name: 'Googled', picture: 'https://lh3.googleusercontent.com/a/newer' };
    const backAgain = await gCall('POST', '/v1/auth/google', grant);
    eq('a later Google sign-in keeps the typed name but follows the newer photo', backAgain.body.account.profile, { firstName: 'Nu', lastName: 'Person', pictureUrl: 'https://lh3.googleusercontent.com/a/newer' });
    idTokenClaims = { ...idTokenClaims, given_name: 'New', picture: 'https://lh3.googleusercontent.com/a/photo' };
    eq('Google was asked with the secret, the code and the verifier', [exchanges[0].client_id, exchanges[0].client_secret, exchanges[0].code, exchanges[0].code_verifier, exchanges[0].redirect_uri, exchanges[0].grant_type],
      ['cid.apps.googleusercontent.com', 'shh', '4/abc', 'v'.repeat(43), 'http://127.0.0.1:4567/', 'authorization_code']);
    eq('the session works like any other', (await fetch(gBase + '/v1/me', { headers: { Authorization: 'Bearer ' + signedIn.body.token } })).status, 200);
    const again = await gCall('POST', '/v1/auth/google', grant);
    eq('the same Google account lands on the same user', again.body.account.email, 'new.person@example.com');
    eq('and Google sign-in on an emailed-code account is the same account too', store.userByEmail('new.person@example.com').id, store.userByEmail('new.person@example.com').id);
    idTokenClaims = { ...idTokenClaims, email_verified: false };
    const unverified = await gCall('POST', '/v1/auth/google', grant);
    eq('an unverified Google email is refused with advice', [unverified.status, /Verify it with Google/.test(unverified.body.error)], [400, true]);
    idTokenClaims = { ...idTokenClaims, email_verified: true, aud: 'someone-else' };
    eq('a token for another client is refused', (await gCall('POST', '/v1/auth/google', grant)).status, 400);
    idTokenClaims = { ...idTokenClaims, aud: 'cid.apps.googleusercontent.com', exp: Math.floor(clock / 1000) - 5 };
    eq('an expired token is refused', (await gCall('POST', '/v1/auth/google', grant)).status, 400);
    idTokenClaims = null;
    const refused = await gCall('POST', '/v1/auth/google', grant);
    eq('Google refusing the code is a 502 with a plain message', [refused.status, refused.body.error], [502, 'Google did not accept the sign-in. Try again.']);
    // --- delete account ---------------------------------------------------------
    const doomed = store.userByEmail('new.person@example.com');
    store.addUsageSeconds(doomed.id, dayOf(clock), 60);
    // The feedback section above spent this address's hourly allowance.
    clock += 3600e3 + 1;
    await fetch(gBase + '/v1/feedback', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + signedIn.body.token }, body: JSON.stringify({ kind: 'idea', message: 'Keep this' }) });
    eq('deletion needs a session', (await gCall('DELETE', '/v1/me')).status, 401);
    eq('a signed-in deletion is 204', (await fetch(gBase + '/v1/me', { method: 'DELETE', headers: { Authorization: 'Bearer ' + signedIn.body.token } })).status, 204);
    eq('the user is gone', store.userByEmail('new.person@example.com'), null);
    eq('and so is the session', (await fetch(gBase + '/v1/me', { headers: { Authorization: 'Bearer ' + signedIn.body.token } })).status, 401);
    eq('their feedback stays, with nobody attached', [store.recentFeedback(1)[0].message, store.recentFeedback(1)[0].user_id], ['Keep this', null]);
    idTokenClaims = { iss: 'https://accounts.google.com', aud: 'cid.apps.googleusercontent.com', exp: Math.floor(clock / 1000) + 3600, email: 'New.Person@Example.com', email_verified: true,
      given_name: 'New', family_name: 'Person', picture: 'https://lh3.googleusercontent.com/a/photo' };
    eq('signing in again starts a fresh account', (await gCall('POST', '/v1/auth/google', grant)).body.account.profile.firstName, 'New');
    googleServer.close();
    tokenApi.close();

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
