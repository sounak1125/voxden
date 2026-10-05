'use strict';

// Google Play Billing, the Android Play build's payment: the account service's
// /v1/billing/googleplay routes over HTTP, against a stand-in for Google's
// OAuth endpoint and Play Developer API, with notifications shaped the way
// Pub/Sub pushes them. The shapes follow Google's public docs (see the note at
// the top of server/googleplay.js); no real purchase has been made yet.

const assert = require('assert');
const crypto = require('crypto');
const http = require('http');
const { createStore } = require('../server/store');
const { createApp } = require('../server/app');
const { createBilling, RENEWAL_GRACE_MS } = require('../server/billing');

let checks = 0;
function ok(label, value) { assert.ok(value, label); checks++; process.stdout.write('ok ' + label + '\n'); }
function eq(label, actual, expected) {
  assert.deepStrictEqual(actual, expected, label + '\n  got: ' + JSON.stringify(actual));
  checks++; process.stdout.write('ok ' + label + '\n');
}

const PACKAGE = 'com.voxden.android';
const PRODUCT = 'voxden_pro';
const PUSH_KEY = 'push-key-long-and-random';
const iso = (ms) => new Date(ms).toISOString();
const DAY = 24 * 3600e3;

async function main() {
  let clock = Date.parse('2026-10-06T10:00:00Z');

  // --- a stand-in for Google ----------------------------------------------------
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const subs = {};
  const log = [];
  const stats = { tokens: 0, acks: [], cancels: [], gets: 0 };
  let rejectNextWith401 = false;
  let googleDown = false;
  let lastClaims = null;
  const google = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const send = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(value === undefined ? '{}' : JSON.stringify(value)); };
      log.push(req.method + ' ' + req.url);
      if (req.url === '/token') {
        const form = new URLSearchParams(body);
        const [h, p, s] = String(form.get('assertion')).split('.');
        const valid = crypto.createVerify('RSA-SHA256').update(h + '.' + p).verify(publicKey, Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64'));
        lastClaims = JSON.parse(Buffer.from(p, 'base64').toString('utf8'));
        if (form.get('grant_type') !== 'urn:ietf:params:oauth:grant-type:jwt-bearer' || !valid) return send(400, { error: 'invalid_grant' });
        stats.tokens++;
        return send(200, { access_token: 'at-' + stats.tokens, expires_in: 3600 });
      }
      if (googleDown) return send(503, { error: { message: 'backend error' } });
      if (rejectNextWith401) { rejectNextWith401 = false; return send(401, { error: { message: 'expired' } }); }
      if (!/^Bearer at-\d+$/.test(String(req.headers.authorization))) return send(401, {});
      const root = '/v3/applications/' + PACKAGE + '/purchases/';
      const get = req.method === 'GET' && req.url.startsWith(root + 'subscriptionsv2/tokens/');
      const ack = /^\/v3\/applications\/[^/]+\/purchases\/subscriptions\/([^/]+)\/tokens\/([^/:]+):acknowledge$/.exec(req.url);
      const cancel = /^\/v3\/applications\/[^/]+\/purchases\/subscriptionsv2\/tokens\/([^/:]+):cancel$/.exec(req.url);
      if (get) {
        stats.gets++;
        const sub = subs[decodeURIComponent(req.url.slice((root + 'subscriptionsv2/tokens/').length))];
        return sub ? send(200, sub) : send(410, { error: { message: 'purchaseToken no longer valid' } });
      }
      if (ack && req.method === 'POST') {
        const sub = subs[decodeURIComponent(ack[2])];
        if (!sub) return send(404, {});
        stats.acks.push([ack[1], decodeURIComponent(ack[2])]);
        sub.acknowledgementState = 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED';
        return send(200, {});
      }
      if (cancel && req.method === 'POST') {
        const token = decodeURIComponent(cancel[1]);
        stats.cancels.push([token, JSON.parse(body)]);
        if (subs[token]) subs[token].subscriptionState = 'SUBSCRIPTION_STATE_CANCELED';
        return send(200, {});
      }
      send(404, {});
    });
  });
  await new Promise((r) => google.listen(0, '127.0.0.1', r));
  const googleBase = 'http://127.0.0.1:' + google.address().port;
  const purchase = (token, patch) => {
    subs[token] = {
      kind: 'androidpublisher#subscriptionPurchaseV2',
      regionCode: 'IN',
      startTime: iso(clock),
      subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE',
      acknowledgementState: 'ACKNOWLEDGEMENT_STATE_PENDING',
      latestOrderId: 'GPA.0000-0000-0000-00000',
      lineItems: [{ productId: PRODUCT, expiryTime: iso(clock + 30 * DAY), autoRenewingPlan: { autoRenewEnabled: true } }],
      externalAccountIdentifiers: {},
      ...patch,
    };
    return subs[token];
  };

  const config = { serviceAccount: { client_email: 'play@voxden.iam.gserviceaccount.com', private_key: privatePem, token_uri: googleBase + '/token' },
    apiUrl: googleBase + '/v3', packageName: PACKAGE, productId: PRODUCT, pushKey: PUSH_KEY };

  // --- the service ----------------------------------------------------------------
  const sent = [];
  const store = createStore(':memory:');
  const mailer = { configured: true, sendCode: async (m) => { sent.push(m); return { delivered: true }; } };
  const lines = [];
  const serve = async (billing) => {
    const app = createApp({ store, mailer, now: () => clock, billing, log: (l) => lines.push(l) });
    const server = http.createServer(app.handle);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    return { server, base: 'http://127.0.0.1:' + server.address().port + '/v1' };
  };
  const call = async (base, who, method, route, body, raw) => {
    const res = await fetch(base + route, {
      method,
      headers: Object.assign(raw ? {} : { 'Content-Type': 'application/json' }, who ? { Authorization: 'Bearer ' + who.token } : {}),
      body: body === undefined ? undefined : (raw ? body : JSON.stringify(body)),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  const signIn = async (base, email) => {
    await call(base, null, 'POST', '/auth/code', { email });
    const v = await call(base, null, 'POST', '/auth/verify', { email, code: sent.filter((m) => m.to === email).at(-1).code, device: 'Pixel' });
    return { token: v.body.token, email };
  };

  // --- not configured ---------------------------------------------------------------
  const off = await serve(createBilling({ now: () => clock }));
  const early = await signIn(off.base, 'early@example.com');
  eq('without Google Play set up, the app is told so', (await call(off.base, early, 'GET', '/billing/googleplay')).body, { configured: false });
  eq('and a purchase report is refused as not open', (await call(off.base, early, 'POST', '/billing/googleplay/purchase', { purchaseToken: 'x' })).status, 503);
  const half = await serve(createBilling({ now: () => clock, googlePlay: { ...config, pushKey: '' } }));
  eq('a missing push key leaves it off', (await call(half.base, await signIn(half.base, 'half@example.com'), 'GET', '/billing/googleplay')).body, { configured: false });
  off.server.close(); half.server.close();

  // --- configured ----------------------------------------------------------------------
  const billing = createBilling({ now: () => clock, googlePlay: config });
  const { server, base } = await serve(billing);
  try {
    const ann = await signIn(base, 'ann@example.com');
    const bob = await signIn(base, 'bob@example.com');
    const annUser = store.userByEmail('ann@example.com');
    const bobUser = store.userByEmail('bob@example.com');
    const pro = (email) => { const u = store.userByEmail(email); return u.plan === 'pro' && Date.parse(u.plan_expires_at) > clock; };
    const info = (await call(base, ann, 'GET', '/billing/googleplay')).body;
    eq('the app is given the product and the buyer\'s obfuscated id', [info.configured, info.productId, info.accountId.startsWith(annUser.id + '.'), info.accountId.length <= 64], [true, PRODUCT, true, true]);
    ok('another account gets a different id', (await call(base, bob, 'GET', '/billing/googleplay')).body.accountId !== info.accountId);
    eq('a signed-out request is refused', (await call(base, null, 'GET', '/billing/googleplay')).status, 401);
    const accountId = info.accountId;
    const bobId = (await call(base, bob, 'GET', '/billing/googleplay')).body.accountId;
    const report = (who, token, extra) => call(base, who, 'POST', '/billing/googleplay/purchase', { productId: PRODUCT, purchaseToken: token, ...extra });

    // --- refusals ---------------------------------------------------------------------
    eq('a token Google does not know is refused', (await report(ann, 'unknown-token')).body.code, 'purchase');
    eq('a token with spaces is refused before Google is asked', [(await report(ann, 'a b')).status, stats.gets], [400, 1]);
    eq('the wrong product is refused', (await report(ann, 'tok1', { productId: 'something_else' })).status, 400);
    purchase('tok-other', { externalAccountIdentifiers: { obfuscatedExternalAccountId: bobId } });
    const stolen = await report(ann, 'tok-other');
    eq('a purchase made for another account is refused', [stolen.status, stolen.body.code], [409, 'account']);
    ok('and grants nothing', !pro('ann@example.com') && !pro('bob@example.com'));
    purchase('tok-forged', { externalAccountIdentifiers: { obfuscatedExternalAccountId: annUser.id + '.' + '0'.repeat(24) } });
    eq('an id that only looks like the account\'s is refused', (await report(ann, 'tok-forged')).status, 409);
    purchase('tok-other-product', { lineItems: [{ productId: 'another_app_sub', expiryTime: iso(clock + 30 * DAY) }], externalAccountIdentifiers: { obfuscatedExternalAccountId: accountId } });
    eq('a subscription to another product is not Pro', (await report(ann, 'tok-other-product')).status, 400);
    eq('nothing was acknowledged for any of them', stats.acks, []);

    // --- a slow payment -----------------------------------------------------------------
    purchase('tok1', { subscriptionState: 'SUBSCRIPTION_STATE_PENDING', externalAccountIdentifiers: { obfuscatedExternalAccountId: accountId } });
    const pending = await report(ann, 'tok1');
    eq('a payment still settling is answered 202 and grants nothing', [pending.status, pending.body.pending, pro('ann@example.com')], [202, true, false]);
    eq('and is not acknowledged', stats.acks, []);

    // --- the purchase ------------------------------------------------------------------
    subs.tok1.subscriptionState = 'SUBSCRIPTION_STATE_ACTIVE';
    const periodEnd = clock + 30 * DAY;
    const bought = await report(ann, 'tok1');
    eq('a settled purchase switches Pro on', [bought.status, bought.body.account.plan], [200, 'pro']);
    eq('until the paid period plus the renewal grace', store.userByEmail('ann@example.com').plan_expires_at, iso(periodEnd + RENEWAL_GRACE_MS));
    eq('Google was asked to acknowledge it, once', stats.acks, [[PRODUCT, 'tok1']]);
    eq('the subscription is on file, renewing, with its Play management page',
      [bought.body.subscription.provider, bought.body.subscription.status, bought.body.subscription.renews, bought.body.subscription.periodEnd, /play\.google\.com\/store\/account\/subscriptions/.test(bought.body.subscription.manageUrl)],
      ['googleplay', 'active', true, iso(periodEnd), true]);
    const again = await report(ann, 'tok1');
    eq('reporting it again changes nothing and acknowledges nothing more', [again.status, stats.acks.length, again.body.account.plan], [200, 1, 'pro']);
    const taken = await report(bob, 'tok1');
    eq('another account cannot report the same token', [taken.status, taken.body.code], [409, 'account']);
    eq('and the owner is undisturbed', store.subscriptionByProviderId('googleplay', 'tok1').user_id, annUser.id);
    eq('the buyer is told another subscription is live', (await call(base, ann, 'GET', '/billing/googleplay')).body.blocked, 'subscription');
    eq('the Razorpay checkout cannot be used to start a second one', (await call(base, ann, 'POST', '/billing/checkout', { provider: 'googleplay', plan: 'monthly' })).status, 400);
    eq('access tokens are cached across calls', [stats.tokens, lastClaims.iss, lastClaims.scope, lastClaims.aud], [1, 'play@voxden.iam.gserviceaccount.com', 'https://www.googleapis.com/auth/androidpublisher', googleBase + '/token']);

    // --- notifications -------------------------------------------------------------------
    const push = (note, key = PUSH_KEY, id = 'm1') => call(base, null, 'POST', '/billing/webhook/googleplay' + (key === null ? '' : '?key=' + key),
      JSON.stringify({ message: { data: Buffer.from(JSON.stringify(note)).toString('base64'), messageId: id }, subscription: 'projects/x/subscriptions/play' }), true);
    const subscriptionNote = (token, type = 2, packageName = PACKAGE) => ({ version: '1.0', packageName, eventTimeMillis: String(clock), subscriptionNotification: { version: '1.0', notificationType: type, purchaseToken: token } });
    const getsBefore = stats.gets;
    eq('a push with no key is refused', (await push(subscriptionNote('tok1'), null)).status, 403);
    eq('and one with the wrong key', (await push(subscriptionNote('tok1'), 'nope')).status, 403);
    eq('neither made a call to Google', stats.gets, getsBefore);
    eq('Play Console\'s test message is accepted', (await push({ version: '1.0', packageName: PACKAGE, eventTimeMillis: '1', testNotification: { version: '1.0' } })).body, { ok: true, handled: false, test: true });
    eq('a message about another package is ignored', [(await push(subscriptionNote('tok1', 2, 'com.someone.else'))).body.handled, stats.gets], [false, getsBefore]);
    eq('a body that is not a notification is ignored', (await call(base, null, 'POST', '/billing/webhook/googleplay?key=' + PUSH_KEY, '{"hello":1}', true)).body.handled, false);

    clock += 30 * DAY;
    subs.tok1.lineItems[0].expiryTime = iso(clock + 30 * DAY);
    const renewed = await push(subscriptionNote('tok1', 2));
    eq('a renewal notification is believed only after Google confirms it', [renewed.status, renewed.body.handled, stats.gets > getsBefore], [200, true, true]);
    eq('and extends the plan to the new period plus grace', store.userByEmail('ann@example.com').plan_expires_at, iso(clock + 30 * DAY + RENEWAL_GRACE_MS));
    eq('with no second acknowledgement', stats.acks.length, 1);

    subs.tok1.subscriptionState = 'SUBSCRIPTION_STATE_CANCELED';
    await push(subscriptionNote('tok1', 3));
    eq('a cancellation keeps access to the exact end of the paid period, no grace',
      [store.subscriptionByProviderId('googleplay', 'tok1').status, store.userByEmail('ann@example.com').plan_expires_at], ['cancelling', iso(clock + 30 * DAY)]);
    eq('and the app sees a subscription that renews no more', (await call(base, ann, 'GET', '/billing')).body.subscription.renews, false);

    subs.tok1.subscriptionState = 'SUBSCRIPTION_STATE_ACTIVE';
    await push(subscriptionNote('tok1', 7));
    eq('a restart in Play puts it back', [store.subscriptionByProviderId('googleplay', 'tok1').status, (await call(base, ann, 'GET', '/billing')).body.subscription.renews], ['active', true]);

    // A notification about a purchase no row names yet finds its owner by the id.
    purchase('tok-bob', { externalAccountIdentifiers: { obfuscatedExternalAccountId: bobId } });
    const early2 = await push(subscriptionNote('tok-bob', 4), PUSH_KEY, 'm2');
    eq('a notification beats the app\'s report and still finds its account', [early2.body.handled, pro('bob@example.com'), stats.acks.length], [true, true, 2]);
    eq('then the app\'s report finds it done', [(await report(bob, 'tok-bob')).status, stats.acks.length], [200, 2]);
    purchase('tok-orphan', { externalAccountIdentifiers: { obfuscatedExternalAccountId: '999.' + 'a'.repeat(24) } });
    eq('a purchase no account can claim is left alone', [(await push(subscriptionNote('tok-orphan', 4))).body.handled, store.subscriptionByProviderId('googleplay', 'tok-orphan')], [false, null]);
    purchase('tok-anon', {});
    eq('and so is one with no id at all', (await push(subscriptionNote('tok-anon', 4))).body.handled, false);
    eq('a token Google no longer keeps ends the notification quietly', (await push(subscriptionNote('gone', 13))).body.handled, false);

    // --- a hold, and a lapse ------------------------------------------------------------
    clock += 31 * DAY;
    subs.tok1.subscriptionState = 'SUBSCRIPTION_STATE_ON_HOLD';
    await push(subscriptionNote('tok1', 5));
    eq('a payment hold ends access at the period that was paid for', [store.userByEmail('ann@example.com').plan_expires_at, pro('ann@example.com')], [iso(clock - 31 * DAY + 30 * DAY), false]);
    eq('and the account can buy again', (await call(base, ann, 'GET', '/billing/googleplay')).body.blocked, undefined);

    // --- buying again with a new token; the old one's late news cannot shorten it ----------
    purchase('tok2', { externalAccountIdentifiers: { obfuscatedExternalAccountId: accountId } });
    const rebought = await report(ann, 'tok2');
    const newEnd = clock + 30 * DAY;
    eq('a new purchase after a lapse switches Pro back on', [rebought.status, rebought.body.account.plan, rebought.body.subscription.status], [200, 'pro', 'active']);
    subs.tok1.subscriptionState = 'SUBSCRIPTION_STATE_EXPIRED';
    const late = await push(subscriptionNote('tok1', 13));
    eq('the old token\'s expiry arriving late leaves the new subscription alone', [late.body.handled, store.userByEmail('ann@example.com').plan_expires_at, store.subscriptionForUser(annUser.id).provider_id], [false, iso(newEnd + RENEWAL_GRACE_MS), 'tok2']);

    // --- cancelling from the account, as the desktop app's Manage subscription does ---------
    const cancelled = await call(base, ann, 'POST', '/billing/cancel');
    eq('Google is told to stop renewals, as the user asked', stats.cancels, [['tok2', { cancellationContext: { cancellationType: 'USER_REQUESTED_STOP_RENEWALS' } }]]);
    eq('the account keeps the paid period, no grace', [cancelled.status, cancelled.body.subscription.status, cancelled.body.subscription.renews, store.userByEmail('ann@example.com').plan_expires_at],
      [200, 'cancelling', false, iso(newEnd)]);

    // --- Google having trouble ------------------------------------------------------------
    googleDown = true;
    purchase('tok-down', { externalAccountIdentifiers: { obfuscatedExternalAccountId: bobId } });
    const down = await report(bob, 'tok-down');
    eq('when Google does not answer the app is told to try again', [down.status, down.body.code], [502, 'provider']);
    eq('and a notification is answered with a failure so Pub/Sub sends it again', (await push(subscriptionNote('tok-down', 4))).status, 502);
    googleDown = false;

    // --- an expired access token ------------------------------------------------------------
    rejectNextWith401 = true;
    const ticks = stats.tokens;
    eq('a refused access token is replaced and the call retried', [(await report(bob, 'tok-bob')).status, stats.tokens - ticks], [200, 1]);
    clock += 2 * 3600e3;
    await report(bob, 'tok-bob');
    eq('and an expired one is replaced before it is used', stats.tokens - ticks, 2);
  } finally {
    server.close(); google.close();
  }

  process.stdout.write('\n' + checks + ' checks passed\n');
}

main().catch((err) => { console.error(err); process.exit(1); });
