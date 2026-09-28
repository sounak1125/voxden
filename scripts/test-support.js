'use strict';

// Support toward code-signing Voxden, end to end: the public goal the website
// polls, the order it asks for before opening Razorpay's checkout, CORS for
// the website's origins only, and the signed order.paid webhook that is the
// only thing able to move the total.
//
// The order and event shapes follow Razorpay's public docs; see the note at
// the top of server/billing.js. No real order.paid has reached the service yet.

const assert = require('assert');
const http = require('http');
const { createStore } = require('../server/store');
const { createApp } = require('../server/app');
const { createBilling, hmacHex } = require('../server/billing');

let checks = 0;
function ok(label, value) { assert.ok(value, label); checks++; process.stdout.write('ok ' + label + '\n'); }
function eq(label, actual, expected) {
  assert.deepStrictEqual(actual, expected, label + '\n  got: ' + JSON.stringify(actual));
  checks++; process.stdout.write('ok ' + label + '\n');
}

async function main() {
  let clock = Date.parse('2026-10-01T09:00:00Z');

  // --- a stand-in for Razorpay's API ------------------------------------------
  const orders = [];
  let ordersFail = false;
  const providerApi = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.url === '/rzp/orders' && req.method === 'POST') {
        const parsed = JSON.parse(body);
        orders.push({ auth: req.headers.authorization, body: parsed });
        res.writeHead(ordersFail ? 500 : 200, { 'Content-Type': 'application/json' });
        if (ordersFail) return res.end('{"error":{"description":"down"}}');
        return res.end(JSON.stringify({ id: 'order_S' + orders.length, amount: parsed.amount, currency: parsed.currency, status: 'created', notes: parsed.notes }));
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise((r) => providerApi.listen(0, '127.0.0.1', r));
  const providerBase = 'http://127.0.0.1:' + providerApi.address().port;

  // Keys only, no plan on sale: support still works.
  const billing = createBilling({
    now: () => clock,
    razorpay: { keyId: 'rzp_test_key', keySecret: 'rzp_secret', webhookSecret: 'rzp_whsec', apiUrl: providerBase + '/rzp' },
  });
  eq('keys without a plan sell no subscription', billing.options(), []);
  ok('but take support', !!billing.supportProvider());
  ok('a provider without keys takes none', !createBilling({ razorpay: { keyId: 'k' } }).supportProvider());

  const store = createStore(':memory:');
  const logs = [];
  const app = createApp({
    store, now: () => clock, billing, log: (line) => logs.push(line),
    mailer: { configured: true, sendCode: async () => ({ delivered: true }) },
    support: { goalInr: 25000, deadline: '2026-12-31T18:29:59Z', usdInr: 88, origins: ['https://voxden.app', 'http://127.0.0.1:4174'] },
  });
  const server = http.createServer(app.handle);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port + '/v1';
  const call = async (method, route, headers, body) => {
    const res = await fetch(base + route, { method, headers, body });
    const text = await res.text();
    return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
  };
  const site = { Origin: 'https://voxden.app' };
  const order = (amount, currency, extra) => call('POST', '/support/order',
    Object.assign({ 'Content-Type': 'application/json' }, site, extra || {}), JSON.stringify({ amount, currency }));
  const paid = (o, payment, eventId) => {
    const raw = JSON.stringify({
      entity: 'event', event: 'order.paid',
      payload: {
        payment: { entity: Object.assign({ entity: 'payment', status: 'captured', order_id: o.id, created_at: Math.floor(clock / 1000) }, payment) },
        order: { entity: Object.assign({ entity: 'order', status: 'paid' }, o) },
      },
    });
    return call('POST', '/billing/webhook/razorpay',
      { 'Content-Type': 'application/json', 'X-Razorpay-Signature': hmacHex('rzp_whsec', raw), 'X-Razorpay-Event-Id': eventId }, raw);
  };

  try {
    // --- the goal, before anyone has paid ---------------------------------------
    const empty = await call('GET', '/support', site);
    eq('the goal starts at zero, open for payments', [empty.status, empty.body.goalInr, empty.body.raisedInr, empty.body.contributions, empty.body.open, empty.body.recent],
      [200, 25000, 0, 0, true, []]);
    eq('with the countdown and the dollar rate', [empty.body.deadline, empty.body.usdInr], ['2026-12-31T18:29:59.000Z', 88]);
    eq('voxden.app may read it', empty.headers.get('access-control-allow-origin'), 'https://voxden.app');
    const elsewhere = await call('GET', '/support', { Origin: 'https://evil.example' });
    eq('another site gets the answer but no CORS, so its page cannot read it', [elsewhere.status, elsewhere.headers.get('access-control-allow-origin')], [200, null]);
    const preflight = await call('OPTIONS', '/support/order', Object.assign({ 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' }, site));
    eq('the preflight for an order allows a JSON POST from voxden.app',
      [preflight.status, preflight.headers.get('access-control-allow-origin'), preflight.headers.get('access-control-allow-methods'), preflight.headers.get('access-control-allow-headers')],
      [204, 'https://voxden.app', 'GET, POST', 'Content-Type']);
    const foreignPreflight = await call('OPTIONS', '/support/order', { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' });
    eq('and refuses it from anywhere else', [foreignPreflight.status, foreignPreflight.headers.get('access-control-allow-origin')], [204, null]);
    const otherRoute = await call('OPTIONS', '/auth/code', site);
    eq('no other route answers CORS, even for voxden.app', [otherRoute.status, otherRoute.headers.get('access-control-allow-origin')], [404, null]);

    // --- orders -------------------------------------------------------------------
    eq('an amount under the floor is refused, with CORS so the page can say why',
      [(await order(4900, 'INR')).status, (await order(4900, 'INR')).body.code, (await order(4900, 'INR')).headers.get('access-control-allow-origin')], [400, 'amount', 'https://voxden.app']);
    eq('and over the ceiling', (await order(5000100, 'INR')).body.code, 'amount');
    eq('a fraction of a paisa is not an amount', (await order(10050.5, 'INR')).body.code, 'amount');
    eq('dollars have their own floor', (await order(99, 'USD')).body.code, 'amount');
    eq('only rupees and dollars', (await order(10000, 'EUR')).body.code, 'currency');
    eq('text/plain is refused, so no page gets an order without the preflight',
      (await call('POST', '/support/order', Object.assign({ 'Content-Type': 'text/plain' }, site), JSON.stringify({ amount: 25000, currency: 'INR' }))).status, 415);
    eq('none of those reached Razorpay', orders.length, 0);

    const rupees = await order(25000, 'INR');
    eq('₹250 becomes a Razorpay order, with the public key for checkout',
      [rupees.status, rupees.body.orderId, rupees.body.keyId, rupees.body.amount, rupees.body.currency], [200, 'order_S1', 'rzp_test_key', 25000, 'INR']);
    eq('made with the server key and marked as support',
      [orders[0].auth, orders[0].body.amount, orders[0].body.currency, orders[0].body.notes], ['Basic ' + Buffer.from('rzp_test_key:rzp_secret').toString('base64'), 25000, 'INR', { voxden_kind: 'support' }]);
    const dollars = await order(500, 'usd');
    eq('$5 works too, currency in any case', [dollars.status, dollars.body.currency], [200, 'USD']);
    ordersFail = true;
    eq('a Razorpay failure is a 502 that says to try again', [(await order(10000, 'INR')).status], [502]);
    ordersFail = false;

    // --- a page watching live ------------------------------------------------------
    const streamEvents = [];
    let streamHeaders = null;
    const streamReq = http.get(base + '/support/stream', { headers: site }, (res) => {
      streamHeaders = res.headers;
      let buffer = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buffer += chunk;
        let at;
        while ((at = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, at);
          buffer = buffer.slice(at + 2);
          const data = block.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('');
          if (data) streamEvents.push(JSON.parse(data));
        }
      });
    });
    const waitFor = async (test, label) => {
      for (let i = 0; i < 100; i++) { if (test()) return; await new Promise((r) => setTimeout(r, 20)); }
      throw new Error('timed out waiting: ' + label);
    };
    await waitFor(() => streamEvents.length >= 1, 'first stream event');
    eq('the stream opens as server-sent events, readable by voxden.app',
      [streamHeaders['content-type'], streamHeaders['access-control-allow-origin']], ['text/event-stream; charset=utf-8', 'https://voxden.app']);
    eq('and starts with the totals as they are', [streamEvents[0].raisedInr, streamEvents[0].contributions], [0, 0]);

    // --- the webhook moves the total ---------------------------------------------
    eq('an order alone moves nothing', (await call('GET', '/support', site)).body.raisedInr, 0);
    const first = await paid({ id: 'order_S1', amount: 25000, amount_paid: 25000, currency: 'INR', notes: { voxden_kind: 'support' } },
      { id: 'pay_1', amount: 25000, currency: 'INR' }, 'evt_1');
    eq('order.paid for a support order is counted', first.body, { ok: true, handled: true });
    await waitFor(() => streamEvents.length >= 2, 'pushed totals');
    eq('and every watching page is told at once, without asking', [streamEvents[1].raisedInr, streamEvents[1].contributions, streamEvents[1].recent[0].amount], [250, 1, 250]);
    const again = await paid({ id: 'order_S1', amount: 25000, amount_paid: 25000, currency: 'INR', notes: { voxden_kind: 'support' } },
      { id: 'pay_1', amount: 25000, currency: 'INR' }, 'evt_1b');
    eq('a retry of the same payment is not counted twice, even under a new event id', again.body, { ok: true, handled: false, duplicate: true });
    await new Promise((r) => setTimeout(r, 60));
    eq('and a retry pushes nothing', streamEvents.length, 2);
    streamReq.destroy();
    clock += 60e3;
    await paid({ id: 'order_S2', amount: 500, amount_paid: 500, currency: 'USD', notes: { voxden_kind: 'support' } },
      { id: 'pay_2', amount: 500, currency: 'USD', international: true }, 'evt_2');
    const subscriptionOrder = await paid({ id: 'order_SUB', amount: 34900, amount_paid: 34900, currency: 'INR', notes: [] },
      { id: 'pay_3', amount: 34900, currency: 'INR', invoice_id: 'inv_1' }, 'evt_3');
    eq('a subscription\'s own order.paid is not support', subscriptionOrder.body, { ok: true, handled: false });
    const raw = JSON.stringify({ event: 'order.paid', payload: { order: { entity: { id: 'order_X', notes: { voxden_kind: 'support' } } }, payment: { entity: { id: 'pay_X', amount: 999999, currency: 'INR' } } } });
    eq('an unsigned order.paid is refused', (await call('POST', '/billing/webhook/razorpay', { 'Content-Type': 'application/json', 'X-Razorpay-Signature': hmacHex('wrong', raw) }, raw)).status, 400);

    const goal = (await call('GET', '/support', site)).body;
    eq('₹250 plus $5 at ₹88 is ₹690 from two payments', [goal.raisedInr, goal.contributions], [690, 2]);
    eq('the newest first, amounts and times only',
      goal.recent, [{ amount: 5, currency: 'USD', at: '2026-10-01T09:01:00.000Z' }, { amount: 250, currency: 'INR', at: '2026-10-01T09:00:00.000Z' }]);
    ok('and the log says where the total stands', logs.some((line) => /support payment pay_2: 5 USD; raised ₹690 of ₹25000 from 2/.test(line)));

    // --- abuse ---------------------------------------------------------------------
    let refused = null;
    for (let i = 0; i < 25 && !refused; i++) {
      const res = await order(10000, 'INR');
      if (res.status === 429) refused = res;
    }
    ok('one address gets twenty orders an hour, then a 429', refused && refused.body.code === 'busy');
    clock += 3601e3;
    eq('an hour later it may try again', (await order(10000, 'INR')).status, 200);

    // --- configuration ---------------------------------------------------------------
    const bare = createApp({ store: createStore(':memory:'), now: () => clock, mailer: { sendCode: async () => {} }, support: { deadline: '' } });
    const bareServer = http.createServer(bare.handle);
    await new Promise((r) => bareServer.listen(0, '127.0.0.1', r));
    const bareBase = 'http://127.0.0.1:' + bareServer.address().port + '/v1';
    const bareGoal = await (await fetch(bareBase + '/support')).json();
    eq('without payments the goal still reads, closed, with the default goal and no countdown',
      [bareGoal.open, bareGoal.goalInr, bareGoal.deadline], [false, 25000, null]);
    const bareOrder = await fetch(bareBase + '/support/order', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"amount":10000,"currency":"INR"}' });
    eq('and an order is a 503', bareOrder.status, 503);
    bareServer.close();
  } finally {
    server.close();
    providerApi.closeAllConnections();
    providerApi.close();
    store.close();
  }
  process.stdout.write('all ' + checks + ' support checks passed\n');
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
