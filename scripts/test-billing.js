'use strict';

// Payments end to end: the service's billing routes over HTTP, a stand-in for
// Razorpay's API, webhooks signed the way Razorpay signs them, and the desktop
// AccountManager driving checkout and noticing the plan flip, in both price
// regions.
//
// The request and event shapes follow Razorpay's public docs; see the note at
// the top of server/billing.js.

const assert = require('assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createStore } = require('../server/store');
const { createApp } = require('../server/app');
const { createBilling, hmacHex, RENEWAL_GRACE_MS } = require('../server/billing');
const { AccountManager } = require('../src/account');

let checks = 0;
function ok(label, value) { assert.ok(value, label); checks++; process.stdout.write('ok ' + label + '\n'); }
function eq(label, actual, expected) {
  assert.deepStrictEqual(actual, expected, label + '\n  got: ' + JSON.stringify(actual));
  checks++; process.stdout.write('ok ' + label + '\n');
}

async function main() {
  let clock = Date.parse('2026-09-11T09:00:00Z');

  // --- a stand-in for Razorpay's API ----------------------------------------
  const providerCalls = [];
  let razorpayAmount = 34900;
  const globalPlan = { amount: 800, currency: 'USD' };
  let cancelCurrentEnd = 0;
  const providerApi = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      providerCalls.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: body ? JSON.parse(body) : null });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (req.url === '/rzp/plans/plan_M') return res.end(JSON.stringify({ period: 'monthly', interval: 1, item: { amount: razorpayAmount, currency: 'INR' } }));
      if (req.url === '/rzp/plans/plan_G') return res.end(JSON.stringify({ period: 'monthly', interval: 1, item: { ...globalPlan } }));
      if (req.url === '/rzp/subscriptions') return res.end(JSON.stringify({ id: 'sub_RZP1', short_url: 'https://rzp.io/i/abc123' }));
      const cancel = /^\/rzp\/subscriptions\/(sub_\w+)\/cancel$/.exec(req.url);
      if (cancel) return res.end(JSON.stringify({ id: cancel[1], status: 'active', current_end: cancelCurrentEnd }));
      res.end('{}');
    });
  });
  await new Promise((r) => providerApi.listen(0, '127.0.0.1', r));
  const providerBase = 'http://127.0.0.1:' + providerApi.address().port;

  const billing = createBilling({
    now: () => clock,
    razorpay: { keyId: 'rzp_test_key', keySecret: 'rzp_secret', webhookSecret: 'rzp_whsec',
      planMonthly: 'plan_M', planAnnual: 'plan_A', planMonthlyGlobal: 'plan_G', apiUrl: providerBase + '/rzp' },
  });
  eq('Razorpay offers both regions, India first, each at its price',
    billing.options().map((o) => [o.provider, o.region, o.plans.map((p) => p.label)]),
    [['razorpay', 'in', ['₹349 / month']], ['razorpay', 'global', ['$8 / month']]]);
  const indiaOnly = createBilling({ razorpay: { keyId: 'k', keySecret: 's', webhookSecret: 'w', planMonthly: 'plan_M', labels: { monthly: '₹299 / month' } } });
  eq('without a dollar plan only India is on sale, and no label can change its price',
    indiaOnly.options().map((o) => [o.region, o.plans]), [['in', [{ id: 'monthly', label: '₹349 / month' }]]]);
  const globalOnly = createBilling({ razorpay: { keyId: 'k', keySecret: 's', webhookSecret: 'w', planMonthlyGlobal: 'plan_G' } });
  eq('the dollar plan can be on sale by itself', globalOnly.options().map((o) => o.region), ['global']);
  const half = createBilling({ razorpay: { keyId: 'k', planMonthly: 'plan_M', planMonthlyGlobal: 'plan_G' } });
  eq('plans without every credential are not offered', half.options(), []);

  // --- the service ------------------------------------------------------------
  const sent = [];
  const store = createStore(':memory:');
  const app = createApp({ store, mailer: { configured: true, sendCode: async (m) => { sent.push(m); return { delivered: true }; } }, now: () => clock, billing });
  const server = http.createServer(app.handle);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port + '/v1';
  const raw = (route, init) => fetch(base + route, init);
  const post = async (route, headers, body) => {
    const res = await raw(route, { method: 'POST', headers, body });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voxden-billing-'));
  const signIn = async (email) => {
    const manager = new AccountManager({ file: path.join(root, email + '.json'), baseUrl: base, now: () => clock, device: 'Test PC' });
    await manager.requestCode(email);
    await manager.verifyCode(undefined, sent.filter((m) => m.to === email).at(-1).code);
    return manager;
  };
  const subscriptionsCreated = () => providerCalls.filter((c) => c.url === '/rzp/subscriptions').length;
  const signedWebhook = (rawBody, eventId) => post('/billing/webhook/razorpay',
    { 'Content-Type': 'application/json', 'X-Razorpay-Signature': hmacHex('rzp_whsec', rawBody), 'X-Razorpay-Event-Id': eventId }, rawBody);

  // --- the app signs in and asks for prices ---------------------------------
  const m = await signIn('buyer@example.com');
  eq('free to start', m.snapshot().plan, 'free');
  const options = await m.billingOptions();
  eq('an account no country table has placed sees both regions', options.map((o) => o.region), ['in', 'global']);
  eq('and keeps them in the snapshot, with nothing marked unavailable', [m.snapshot().billing.options.length, m.snapshot().billing.unavailable], [2, '']);

  try {
    // --- checkout ---------------------------------------------------------------
    await assert.rejects(() => m.checkout('paypal', 'monthly'), /not available/);
    await assert.rejects(() => m.checkout('lemonsqueezy', 'monthly', 'global'), /not available/);
    await assert.rejects(() => m.checkout('razorpay', 'weekly'), /Only monthly/);
    await assert.rejects(() => m.checkout('razorpay', 'annual'), /Only monthly/);
    razorpayAmount = 29900;
    await assert.rejects(() => m.checkout('razorpay', 'monthly'), /₹349 monthly plan is not ready/);
    razorpayAmount = 34900;
    globalPlan.amount = 900;
    await assert.rejects(() => m.checkout('razorpay', 'monthly', 'global'), /\$8 monthly plan is not ready/);
    Object.assign(globalPlan, { amount: 800, currency: 'INR' });
    await assert.rejects(() => m.checkout('razorpay', 'monthly', 'global'), /\$8 monthly plan is not ready/);
    globalPlan.currency = 'USD';
    eq('a plan whose amount or currency disagrees creates no subscription', subscriptionsCreated(), 0);
    const rzpUrl = await m.checkout('razorpay', 'monthly');
    eq('Razorpay returns its hosted page', rzpUrl, 'https://rzp.io/i/abc123');
    const rzpCall = providerCalls.find((c) => c.url === '/rzp/subscriptions');
    eq('with basic auth from the server key', rzpCall.auth, 'Basic ' + Buffer.from('rzp_test_key:rzp_secret').toString('base64'));
    eq('naming no region, an unplaced account gets India, as apps from before the dollar plan expect',
      [rzpCall.body.plan_id, rzpCall.body.notes.voxden_user, rzpCall.body.notes.voxden_plan, rzpCall.body.notes.voxden_region],
      ['plan_M', String(store.userByEmail('buyer@example.com').id), 'monthly', 'in']);
    ok('a checkout is pending', !!m.snapshot().checkoutPending);
    await m.checkout('razorpay', 'monthly', 'global');
    eq('an unplaced account that picks everywhere else gets the dollar plan',
      [providerCalls.filter((c) => c.url === '/rzp/subscriptions').at(-1).body.plan_id, providerCalls.filter((c) => c.url === '/rzp/subscriptions').at(-1).body.notes.voxden_region],
      ['plan_G', 'global']);
    eq('a signed-out checkout is refused', (await post('/billing/checkout', { 'Content-Type': 'application/json' }, JSON.stringify({ provider: 'razorpay', plan: 'monthly' }))).status, 401);

    // --- Razorpay webhook: activation ------------------------------------------
    const userId = store.userByEmail('buyer@example.com').id;
    const currentEnd = Math.floor((clock + 30 * 24 * 3600e3) / 1000);
    const rzpActivated = JSON.stringify({ event: 'subscription.activated', payload: { subscription: { entity: {
      id: 'sub_RZP1', status: 'active', plan_id: 'plan_M', current_end: currentEnd,
      notes: { voxden_user: String(userId), voxden_email: 'buyer@example.com', voxden_plan: 'monthly' } } } } });
    const unsigned = await post('/billing/webhook/razorpay', { 'Content-Type': 'application/json' }, rzpActivated);
    eq('an unsigned webhook is refused', unsigned.status, 400);
    const badSig = await post('/billing/webhook/razorpay', { 'Content-Type': 'application/json', 'X-Razorpay-Signature': hmacHex('wrong', rzpActivated) }, rzpActivated);
    eq('a wrongly signed webhook is refused', badSig.status, 400);
    eq('and neither changed the plan', store.userByEmail('buyer@example.com').plan, 'free');
    // Razorpay's authenticated carries no current_end, and webhooks are not
    // promised to arrive in order: it can come before activation or after it.
    const rzpAuthenticated = JSON.stringify({ event: 'subscription.authenticated', payload: { subscription: { entity: {
      id: 'sub_RZP1', status: 'authenticated', plan_id: 'plan_M', current_end: null,
      notes: { voxden_user: String(userId), voxden_email: 'buyer@example.com', voxden_plan: 'monthly' } } } } });
    eq('an authenticated event before the first charge is handled', (await signedWebhook(rzpAuthenticated, 'evt_auth_1')).body, { ok: true, handled: true });
    eq('and grants nothing yet', [store.userByEmail('buyer@example.com').plan === 'pro' && Date.parse(store.userByEmail('buyer@example.com').plan_expires_at) > clock], [false]);
    const activated = await signedWebhook(rzpActivated, 'evt_1');
    eq('a signed activation is handled', activated.body, { ok: true, handled: true });
    const user = store.userByEmail('buyer@example.com');
    eq('the plan is pro until the period end plus renewal grace', [user.plan, user.plan_expires_at],
      ['pro', new Date(currentEnd * 1000 + RENEWAL_GRACE_MS).toISOString()]);
    const dup = await signedWebhook(rzpActivated, 'evt_1');
    eq('a retried event is acknowledged and ignored', dup.body, { ok: true, handled: false, duplicate: true });
    eq('the subscription is recorded', [store.subscriptionForUser(userId).provider, store.subscriptionForUser(userId).plan, store.subscriptionForUser(userId).status],
      ['razorpay', 'monthly', 'active']);
    const paidThrough = store.userByEmail('buyer@example.com').plan_expires_at;
    eq('an authenticated event arriving after activation is handled', (await signedWebhook(rzpAuthenticated, 'evt_auth_2')).body, { ok: true, handled: true });
    eq('and leaves the paid plan exactly as it was',
      [store.userByEmail('buyer@example.com').plan, store.userByEmail('buyer@example.com').plan_expires_at], ['pro', paidThrough]);
    eq('with the billing date kept', store.subscriptionForUser(userId).period_end, new Date(currentEnd * 1000).toISOString());

    // --- one subscription per account -------------------------------------------
    const subscriptionCallsBefore = subscriptionsCreated();
    let secondCheckout = '';
    try { await m.checkout('razorpay', 'monthly'); } catch (err) { secondCheckout = err.message; }
    ok('a second checkout on a live subscription is refused', /already has a subscription/i.test(secondCheckout));
    eq('and the provider is never asked to create another', subscriptionsCreated(), subscriptionCallsBefore);

    // --- the app notices --------------------------------------------------------
    await m.refresh({ force: true });
    eq('the app is Pro after a refresh', m.snapshot().plan, 'pro');
    eq('and the checkout is settled', m.checkoutSettled(), true);
    eq('with no pending state left', m.snapshot().checkoutPending, null);
    const status = await m.billingStatus();
    eq('billing status names the provider', [status.provider, status.plan], ['razorpay', 'monthly']);
    eq('and says it renews, at the advertised price', [status.renews, status.label], [true, '₹349 / month']);

    // --- the app cancels renewal from Manage subscription ----------------------
    cancelCurrentEnd = currentEnd;
    const cancelled = await m.cancelSubscription();
    const cancelCall = providerCalls.at(-1);
    eq('Razorpay is told to cancel at the end of the paid cycle', [cancelCall.method, cancelCall.url, cancelCall.body], ['POST', '/rzp/subscriptions/sub_RZP1/cancel', { cancel_at_cycle_end: 1 }]);
    eq('the app sees a subscription that renews no more', [cancelled.renews, cancelled.status, cancelled.periodEnd], [false, 'cancelling', new Date(currentEnd * 1000).toISOString()]);
    eq('the plan now runs to exactly the period end, no grace', store.userByEmail('buyer@example.com').plan_expires_at, new Date(currentEnd * 1000).toISOString());
    eq('and the app is still Pro until then', m.snapshot().plan, 'pro');
    const callsBefore = providerCalls.length;
    const again = await m.cancelSubscription();
    eq('cancelling twice asks the provider nothing more', [providerCalls.length - callsBefore, again.renews], [0, false]);

    // --- Razorpay: cancellation keeps access to the period end --------------
    const rzpCancelled = JSON.stringify({ event: 'subscription.cancelled', payload: { subscription: { entity: {
      id: 'sub_RZP1', status: 'cancelled', plan_id: 'plan_M', current_end: currentEnd, notes: { voxden_user: String(userId) } } } } });
    await signedWebhook(rzpCancelled, 'evt_2');
    eq('a cancellation runs the plan to the period end, no grace', store.userByEmail('buyer@example.com').plan_expires_at, new Date(currentEnd * 1000).toISOString());
    clock = currentEnd * 1000 + 1000;
    await m.refresh({ force: true });
    eq('and after that date the app is free', m.snapshot().plan, 'free');
    let noSub = '';
    try { await m.cancelSubscription(); } catch (err) { noSub = err.message; }
    eq('with nothing left to cancel, the app is told so', noSub, 'There is no active subscription on this account.');
    clock = Date.parse('2026-09-11T09:00:00Z');

    // --- everywhere else: dollars through the same Razorpay account -------------
    const abroad = await signIn('abroad@example.com');
    const abroadId = store.userByEmail('abroad@example.com').id;
    store.placeUser(abroadId, 'global', 'US');
    eq('an account placed outside India is offered dollars only',
      (await abroad.billingOptions()).map((o) => [o.provider, o.region, o.plans[0].label]), [['razorpay', 'global', '$8 / month']]);
    const beforeAbroad = subscriptionsCreated();
    await assert.rejects(() => abroad.checkout('razorpay', 'monthly', 'in'), /not offered in your region/);
    eq('asking for the India price creates nothing', subscriptionsCreated(), beforeAbroad);
    await abroad.checkout('razorpay', 'monthly');
    const usdCall = providerCalls.filter((c) => c.url === '/rzp/subscriptions').at(-1);
    eq('naming no region, it checks out on the dollar plan', [usdCall.body.plan_id, usdCall.body.notes.voxden_region, usdCall.body.notes.voxden_user],
      ['plan_G', 'global', String(abroadId)]);
    const usdEnd = Math.floor((clock + 30 * 24 * 3600e3) / 1000);
    const usdActivated = JSON.stringify({ event: 'subscription.activated', payload: { subscription: { entity: {
      id: 'sub_RZPG', status: 'active', plan_id: 'plan_G', current_end: usdEnd, notes: { voxden_user: String(abroadId) } } } } });
    eq('a dollar activation is handled', (await signedWebhook(usdActivated, 'evt_usd_1')).body, { ok: true, handled: true });
    eq('the account is Pro to the period end plus grace, with the plan read from the dollar plan id',
      [store.userByEmail('abroad@example.com').plan, store.userByEmail('abroad@example.com').plan_expires_at, store.subscriptionForUser(abroadId).plan],
      ['pro', new Date(usdEnd * 1000 + RENEWAL_GRACE_MS).toISOString(), 'monthly']);
    await abroad.refresh({ force: true });
    const usdStatus = await abroad.billingStatus();
    eq('and Manage subscription shows the dollar price', [usdStatus.provider, usdStatus.label, usdStatus.renews], ['razorpay', '$8 / month', true]);
    cancelCurrentEnd = usdEnd;
    const usdCancelled = await abroad.cancelSubscription();
    eq('cancelling asks Razorpay about the dollar subscription', [providerCalls.at(-1).url, usdCancelled.renews], ['/rzp/subscriptions/sub_RZPG/cancel', false]);

    // --- a country the dollar offer is closed in ---------------------------------
    const london = await signIn('london@example.com');
    store.placeUser(store.userByEmail('london@example.com').id, 'global', 'GB');
    eq('an account placed in the UK is offered nothing', await london.billingOptions(), []);
    eq('and the app is told why', london.snapshot().billing.unavailable, 'country');
    const beforeLondon = subscriptionsCreated();
    await assert.rejects(() => london.checkout('razorpay', 'monthly'), /not sold in your country yet/);
    eq('a checkout from there creates nothing', subscriptionsCreated(), beforeLondon);

    // --- events for nobody, unknown providers, and a service with no billing ---
    const stranger = JSON.stringify({ event: 'subscription.activated', payload: { subscription: { entity: { id: 'sub_X', status: 'active', current_end: currentEnd, notes: { voxden_email: 'nobody@example.com' } } } } });
    eq('an event for an unknown user is acknowledged, not applied', (await signedWebhook(stranger, 'evt_9')).body, { ok: true, handled: false });
    eq('an unknown provider is 404', (await post('/billing/webhook/stripe', { 'Content-Type': 'application/json' }, '{}')).status, 404);
    eq('and so is Lemon Squeezy, which is gone', (await post('/billing/webhook/lemonsqueezy', { 'Content-Type': 'application/json' }, '{}')).status, 404);
    const bare = createApp({ store, mailer: { sendCode: async () => {} }, now: () => clock });
    const bareServer = http.createServer(bare.handle);
    await new Promise((r) => bareServer.listen(0, '127.0.0.1', r));
    const bareRes = await fetch('http://127.0.0.1:' + bareServer.address().port + '/v1/billing/options');
    eq('a service without payments offers nothing', await bareRes.json(), { region: null, options: [] });
    bareServer.close();
  } finally {
    server.close();
    providerApi.closeAllConnections();
    providerApi.close();
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
  process.stdout.write('all ' + checks + ' billing checks passed\n');
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
