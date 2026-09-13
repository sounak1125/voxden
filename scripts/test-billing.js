'use strict';

// Payments end to end: the service's billing routes over HTTP, stand-ins for
// the two providers' APIs, webhooks signed the way each provider signs them,
// and the desktop AccountManager driving checkout and noticing the plan flip.
//
// The provider request and event shapes follow their public docs; see the
// note at the top of server/billing.js.

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

  // --- stand-ins for the providers' APIs ------------------------------------
  const providerCalls = [];
  let razorpayAmount = 34900;
  let cancelCurrentEnd = 0;
  let lsEndsAt = '';
  const providerApi = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      providerCalls.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: body ? JSON.parse(body) : null });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (req.url === '/rzp/plans/plan_M') return res.end(JSON.stringify({ period: 'monthly', interval: 1, item: { amount: razorpayAmount, currency: 'INR' } }));
      if (req.url === '/rzp/subscriptions') return res.end(JSON.stringify({ id: 'sub_RZP1', short_url: 'https://rzp.io/i/abc123' }));
      if (req.url === '/rzp/subscriptions/sub_RZP1/cancel') return res.end(JSON.stringify({ id: 'sub_RZP1', status: 'active', current_end: cancelCurrentEnd }));
      if (req.url === '/ls/checkouts') return res.end(JSON.stringify({ data: { id: 'chk_LS1', attributes: { url: 'https://voxden.lemonsqueezy.com/checkout/buy/xyz' } } }));
      if (req.url === '/ls/subscriptions/9001' && req.method === 'DELETE') return res.end(JSON.stringify({ data: { id: '9001', attributes: { status: 'cancelled', ends_at: lsEndsAt, renews_at: null } } }));
      res.end('{}');
    });
  });
  await new Promise((r) => providerApi.listen(0, '127.0.0.1', r));
  const providerBase = 'http://127.0.0.1:' + providerApi.address().port;

  const billing = createBilling({
    now: () => clock,
    razorpay: { keyId: 'rzp_test_key', keySecret: 'rzp_secret', webhookSecret: 'rzp_whsec',
      planMonthly: 'plan_M', planAnnual: 'plan_A', apiUrl: providerBase + '/rzp' },
    lemonsqueezy: { apiKey: 'ls_key', storeId: '777', webhookSecret: 'ls_whsec',
      variantMonthly: '1001', variantAnnual: '1002', apiUrl: providerBase + '/ls', labels: { monthly: '$9 / month' } },
  });
  eq('both providers are offered with their prices', billing.options().map((o) => [o.provider, o.plans.map((p) => p.label)]),
    [['razorpay', ['₹349 / month']], ['lemonsqueezy', ['$9 / month']]]);
  const monthlyOnly = createBilling({ razorpay: { keyId: 'k', keySecret: 's', webhookSecret: 'w', planMonthly: 'plan_M', labels: { monthly: '₹299 / month' } } });
  eq('India is configured without an annual plan and cannot use a stale price label', monthlyOnly.options()[0].plans, [{ id: 'monthly', label: '₹349 / month' }]);
  const monthlyGlobal = createBilling({ lemonsqueezy: { apiKey: 'k', storeId: 's', webhookSecret: 'w', variantMonthly: 'm' } });
  eq('global monthly checkout also needs no annual variant', monthlyGlobal.options()[0].plans.length, 1);
  const half = createBilling({ razorpay: { keyId: 'k' } });
  eq('a provider missing credentials is not offered', half.options(), []);

  // --- the service ------------------------------------------------------------
  const sent = [];
  const store = createStore(':memory:');
  const app = createApp({ store, mailer: { sendCode: async (m) => { sent.push(m); } }, now: () => clock, billing });
  const server = http.createServer(app.handle);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port + '/v1';
  const raw = (route, init) => fetch(base + route, init);
  const post = async (route, headers, body) => {
    const res = await raw(route, { method: 'POST', headers, body });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };

  // --- the app signs in and asks for prices ---------------------------------
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voxden-billing-'));
  const m = new AccountManager({ file: path.join(root, 'account.json'), baseUrl: base, now: () => clock, device: 'Test PC' });
  await m.requestCode('buyer@example.com');
  await m.verifyCode(undefined, sent[0].code);
  eq('free to start', m.snapshot().plan, 'free');
  const options = await m.billingOptions();
  eq('the app sees both regions', options.map((o) => o.region), ['in', 'global']);
  eq('and keeps them in the snapshot', m.snapshot().billing.options.length, 2);

  try {
    // --- checkout ---------------------------------------------------------------
    await assert.rejects(() => m.checkout('paypal', 'monthly'), /not available/);
    await assert.rejects(() => m.checkout('razorpay', 'weekly'), /Only monthly/);
    await assert.rejects(() => m.checkout('razorpay', 'annual'), /Only monthly/);
    await assert.rejects(() => m.checkout('lemonsqueezy', 'annual'), /Only monthly/);
    razorpayAmount = 29900;
    await assert.rejects(() => m.checkout('razorpay', 'monthly'), /₹349 monthly plan is not ready/);
    eq('a mismatched provider price creates no subscription', providerCalls.filter(c => c.url === '/rzp/subscriptions').length, 0);
    razorpayAmount = 34900;
    const rzpUrl = await m.checkout('razorpay', 'monthly');
    eq('Razorpay returns its hosted page', rzpUrl, 'https://rzp.io/i/abc123');
    const rzpCall = providerCalls.find((c) => c.url === '/rzp/subscriptions');
    eq('with basic auth from the server key', rzpCall.auth, 'Basic ' + Buffer.from('rzp_test_key:rzp_secret').toString('base64'));
    eq('the plan id and the user in notes', [rzpCall.body.plan_id, rzpCall.body.notes.voxden_user, rzpCall.body.notes.voxden_plan],
      ['plan_M', String(store.userByEmail('buyer@example.com').id), 'monthly']);
    ok('a checkout is pending', !!m.snapshot().checkoutPending);
    const lsUrl = await m.checkout('lemonsqueezy', 'monthly');
    ok('Lemon Squeezy returns its hosted page', /lemonsqueezy\.com/.test(lsUrl));
    const lsCall = providerCalls.find((c) => c.url === '/ls/checkouts');
    eq('as a JSON:API checkout for the store and variant', [lsCall.auth, lsCall.body.data.relationships.store.data.id, lsCall.body.data.relationships.variant.data.id],
      ['Bearer ls_key', '777', '1001']);
    eq('carrying the user and plan as custom data', lsCall.body.data.attributes.checkout_data.custom,
      { voxden_user: String(store.userByEmail('buyer@example.com').id), voxden_plan: 'monthly' });
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
    const authenticatedHeaders = (id) => ({ 'Content-Type': 'application/json', 'X-Razorpay-Signature': hmacHex('rzp_whsec', rzpAuthenticated), 'X-Razorpay-Event-Id': id });
    eq('an authenticated event before the first charge is handled',
      (await post('/billing/webhook/razorpay', authenticatedHeaders('evt_auth_1'), rzpAuthenticated)).body, { ok: true, handled: true });
    eq('and grants nothing yet', [store.userByEmail('buyer@example.com').plan === 'pro' && Date.parse(store.userByEmail('buyer@example.com').plan_expires_at) > clock], [false]);
    const signedHeaders ={ 'Content-Type': 'application/json', 'X-Razorpay-Signature': hmacHex('rzp_whsec', rzpActivated), 'X-Razorpay-Event-Id': 'evt_1' };
    const activated = await post('/billing/webhook/razorpay', signedHeaders, rzpActivated);
    eq('a signed activation is handled', activated.body, { ok: true, handled: true });
    const user = store.userByEmail('buyer@example.com');
    eq('the plan is pro until the period end plus renewal grace', [user.plan, user.plan_expires_at],
      ['pro', new Date(currentEnd * 1000 + RENEWAL_GRACE_MS).toISOString()]);
    const dup = await post('/billing/webhook/razorpay', signedHeaders, rzpActivated);
    eq('a retried event is acknowledged and ignored', dup.body, { ok: true, handled: false, duplicate: true });
    eq('the subscription is recorded', [store.subscriptionForUser(userId).provider, store.subscriptionForUser(userId).plan, store.subscriptionForUser(userId).status],
      ['razorpay', 'monthly', 'active']);
    const paidThrough = store.userByEmail('buyer@example.com').plan_expires_at;
    eq('an authenticated event arriving after activation is handled',
      (await post('/billing/webhook/razorpay', authenticatedHeaders('evt_auth_2'), rzpAuthenticated)).body, { ok: true, handled: true });
    eq('and leaves the paid plan exactly as it was',
      [store.userByEmail('buyer@example.com').plan, store.userByEmail('buyer@example.com').plan_expires_at], ['pro', paidThrough]);
    eq('with the billing date kept', store.subscriptionForUser(userId).period_end, new Date(currentEnd * 1000).toISOString());

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
    await post('/billing/webhook/razorpay', { 'Content-Type': 'application/json', 'X-Razorpay-Signature': hmacHex('rzp_whsec', rzpCancelled), 'X-Razorpay-Event-Id': 'evt_2' }, rzpCancelled);
    eq('a cancellation runs the plan to the period end, no grace', store.userByEmail('buyer@example.com').plan_expires_at, new Date(currentEnd * 1000).toISOString());
    clock = currentEnd * 1000 + 1000;
    await m.refresh({ force: true });
    eq('and after that date the app is free', m.snapshot().plan, 'free');
    clock = Date.parse('2026-09-11T09:00:00Z');

    // --- Lemon Squeezy webhook, matched by email when custom data is missing ---
    const renews = new Date(clock + 365 * 24 * 3600e3).toISOString();
    const lsCreated = JSON.stringify({ meta: { event_name: 'subscription_created', custom_data: {} },
      data: { id: '9001', attributes: { status: 'active', variant_id: 1002, user_email: 'Buyer@Example.com', renews_at: renews, ends_at: null,
        urls: { customer_portal: 'https://voxden.lemonsqueezy.com/billing?x=1' } } } });
    const lsRes = await post('/billing/webhook/lemonsqueezy', { 'Content-Type': 'application/json', 'X-Signature': hmacHex('ls_whsec', lsCreated), 'X-Event-Name': 'subscription_created' }, lsCreated);
    eq('a signed Lemon Squeezy creation is handled', lsRes.body, { ok: true, handled: true });
    const afterLs = store.userByEmail('buyer@example.com');
    eq('pro for the year plus grace', [afterLs.plan, afterLs.plan_expires_at], ['pro', new Date(Date.parse(renews) + RENEWAL_GRACE_MS).toISOString()]);
    const lsSub = store.subscriptionForUser(userId);
    eq('the plan came from the variant and the portal link was kept', [lsSub.provider, lsSub.plan, lsSub.manage_url],
      ['lemonsqueezy', 'annual', 'https://voxden.lemonsqueezy.com/billing?x=1']);
    lsEndsAt = renews;
    await m.refresh({ force: true });
    const lsCancelled = await m.cancelSubscription();
    eq('Lemon Squeezy is asked to cancel, which ends at the period end', [providerCalls.at(-1).method, providerCalls.at(-1).url], ['DELETE', '/ls/subscriptions/9001']);
    eq('the portal link survives and renewal is off', [lsCancelled.manageUrl, lsCancelled.renews, lsCancelled.periodEnd], ['https://voxden.lemonsqueezy.com/billing?x=1', false, renews]);
    eq('paid through the year, no grace', store.userByEmail('buyer@example.com').plan_expires_at, renews);
    const lsExpired = JSON.stringify({ meta: { event_name: 'subscription_expired', custom_data: { voxden_user: String(userId) } },
      data: { id: '9001', attributes: { status: 'expired', variant_id: 1002, user_email: 'buyer@example.com', renews_at: null, ends_at: new Date(clock - 1000).toISOString() } } });
    await post('/billing/webhook/lemonsqueezy', { 'Content-Type': 'application/json', 'X-Signature': hmacHex('ls_whsec', lsExpired) }, lsExpired);
    eq('an expiry ends the plan at once', store.userByEmail('buyer@example.com').plan_expires_at, new Date(clock - 1000).toISOString());
    await m.refresh({ force: true });
    eq('and the app is free', m.snapshot().plan, 'free');
    let noSub = '';
    try { await m.cancelSubscription(); } catch (err) { noSub = err.message; }
    eq('with nothing left to cancel, the app is told so', noSub, 'There is no active subscription on this account.');

    // --- events for nobody, unknown providers, and a service with no billing ---
    const stranger = JSON.stringify({ event: 'subscription.activated', payload: { subscription: { entity: { id: 'sub_X', status: 'active', current_end: currentEnd, notes: { voxden_email: 'nobody@example.com' } } } } });
    eq('an event for an unknown user is acknowledged, not applied',
      (await post('/billing/webhook/razorpay', { 'Content-Type': 'application/json', 'X-Razorpay-Signature': hmacHex('rzp_whsec', stranger), 'X-Razorpay-Event-Id': 'evt_9' }, stranger)).body,
      { ok: true, handled: false });
    eq('an unknown provider is 404', (await post('/billing/webhook/stripe', { 'Content-Type': 'application/json' }, '{}')).status, 404);
    const bare = createApp({ store, mailer: { sendCode: async () => {} }, now: () => clock });
    const bareServer = http.createServer(bare.handle);
    await new Promise((r) => bareServer.listen(0, '127.0.0.1', r));
    const bareRes = await fetch('http://127.0.0.1:' + bareServer.address().port + '/v1/billing/options');
    eq('a service without payments offers nothing', await bareRes.json(), { options: [] });
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
