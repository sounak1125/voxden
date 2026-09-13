'use strict';

// Regional pricing on the service: an account is placed in India or global
// pricing from the country its first sign-in comes from, keeps that region,
// sees only that region's plans, and cannot check out with the other one.

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { createStore } = require('../server/store');
const { createApp, regionOfCountry } = require('../server/app');
const { createBilling } = require('../server/billing');
const region = require('../server/region');

let checks = 0;
function eq(label, actual, expected) {
  assert.deepStrictEqual(actual, expected, label + '\n  got: ' + JSON.stringify(actual));
  checks++;
  process.stdout.write('ok ' + label + '\n');
}

// Stand-in addresses: what the country table would say about each.
const COUNTRIES = { '49.36.10.1': 'IN', '2401:4900::7': 'IN', '8.8.8.8': 'US', '81.2.69.160': 'GB' };
const geo = { countryOf: (ip) => COUNTRIES[ip] || '' };

function fakeProvider(id, regionName, label) {
  return {
    id, region: regionName, label: regionName === 'in' ? 'India' : 'Everywhere else', configured: true,
    labels: { monthly: label },
    createCheckout: async () => ({ url: 'https://pay.example/' + id, providerId: id + '_1' }),
  };
}

async function main() {
  eq('India is the India region and every other country is global',
    ['IN', 'US', 'GB', 'AE'].map(regionOfCountry), ['in', 'global', 'global', 'global']);

  const sent = [];
  const store = createStore(':memory:');
  const billing = createBilling({ providers: {
    razorpay: fakeProvider('razorpay', 'in', '₹349 / month'),
    lemonsqueezy: fakeProvider('lemonsqueezy', 'global', '$8 / month'),
  } });
  const servers = [];
  const serve = async (app) => {
    const server = http.createServer(app.handle);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    servers.push(server);
    return 'http://127.0.0.1:' + server.address().port + '/v1';
  };
  const mailer = { sendCode: async (m) => { sent.push(m); }, configured: false };
  const base = await serve(createApp({ store, mailer, billing, geo }));
  const call = async (url, method, route, { from, token, body } = {}) => {
    const headers = { 'Content-Type': 'application/json' };
    if (from) headers['X-Forwarded-For'] = from;
    if (token) headers.Authorization = 'Bearer ' + token;
    const res = await fetch(url + route, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  const signIn = async (url, email, from) => {
    await call(url, 'POST', '/auth/code', { from, body: { email } });
    const code = sent.filter((m) => m.to === email).at(-1).code;
    return (await call(url, 'POST', '/auth/verify', { from, body: { email, code, device: 'Test PC' } })).body;
  };
  const providersIn = (options) => options.map((group) => group.provider);

  try {
    // --- before sign-in -------------------------------------------------------
    const fromIndia = (await call(base, 'GET', '/billing/options', { from: '49.36.10.1' })).body;
    eq('a signed-out request from India is offered the India plan only', [fromIndia.region, providersIn(fromIndia.options)], ['in', ['razorpay']]);
    const fromUs = (await call(base, 'GET', '/billing/options', { from: '8.8.8.8' })).body;
    eq('from the US, the global plan only', [fromUs.region, providersIn(fromUs.options)], ['global', ['lemonsqueezy']]);
    eq('at the global price', fromUs.options[0].plans, [{ id: 'monthly', label: '$8 / month' }]);
    const unknown = (await call(base, 'GET', '/billing/options', { from: '203.0.113.9' })).body;
    eq('an address the table cannot place is offered both', [unknown.region, providersIn(unknown.options)], [null, ['razorpay', 'lemonsqueezy']]);

    // --- the first sign-in decides ----------------------------------------------
    const indian = await signIn(base, 'priya@example.com', '49.36.10.1');
    eq('a first sign-in from India places the account in India', indian.account.region, 'in');
    eq('and records the country that decided it', [store.userByEmail('priya@example.com').region, store.userByEmail('priya@example.com').country], ['in', 'IN']);
    const travelling = (await call(base, 'GET', '/me', { from: '8.8.8.8', token: indian.token })).body.account;
    eq('checking in later from the US changes nothing', travelling.region, 'in');
    const again = await signIn(base, 'priya@example.com', '81.2.69.160');
    eq('nor does signing in again from the UK', [again.account.region, store.userByEmail('priya@example.com').country], ['in', 'IN']);
    const indianOptions = (await call(base, 'GET', '/billing/options', { from: '8.8.8.8', token: indian.token })).body;
    eq('signed in, the account\'s region decides the plans, not the address', [indianOptions.region, providersIn(indianOptions.options)], ['in', ['razorpay']]);

    const american = await signIn(base, 'sam@example.com', '8.8.8.8');
    eq('a first sign-in from the US places the account in global pricing', american.account.region, 'global');
    const americanOptions = (await call(base, 'GET', '/billing/options', { from: '49.36.10.1', token: american.token })).body;
    eq('which later sees only the global plan, even from India', [americanOptions.region, providersIn(americanOptions.options)], ['global', ['lemonsqueezy']]);

    // --- checkout holds the line -------------------------------------------------
    const cheap = await call(base, 'POST', '/billing/checkout', { from: '49.36.10.1', token: american.token, body: { provider: 'razorpay', plan: 'monthly' } });
    eq('a global account cannot check out at the India price', [cheap.status, cheap.body.code], [400, 'region']);
    const own = await call(base, 'POST', '/billing/checkout', { from: '8.8.8.8', token: american.token, body: { provider: 'lemonsqueezy', plan: 'monthly' } });
    eq('and checks out at its own', [own.status, own.body.provider], [200, 'lemonsqueezy']);
    const indianCheckout = await call(base, 'POST', '/billing/checkout', { from: '8.8.8.8', token: indian.token, body: { provider: 'razorpay', plan: 'monthly' } });
    eq('an India account checks out through Razorpay from anywhere', [indianCheckout.status, indianCheckout.body.provider], [200, 'razorpay']);
    const dollars = await call(base, 'POST', '/billing/checkout', { token: indian.token, body: { provider: 'lemonsqueezy', plan: 'monthly' } });
    eq('and not through the global plan', [dollars.status, dollars.body.code], [400, 'region']);

    // --- an account nothing could place yet -----------------------------------------
    const unplaced = await signIn(base, 'dev@example.com', '127.0.0.1');
    eq('a sign-in from an address the table cannot place leaves the account unplaced', unplaced.account.region, null);
    const devOptions = (await call(base, 'GET', '/billing/options', { from: '127.0.0.1', token: unplaced.token })).body;
    eq('it is offered both regions meanwhile', [devOptions.region, providersIn(devOptions.options)], [null, ['razorpay', 'lemonsqueezy']]);
    const either = await call(base, 'POST', '/billing/checkout', { token: unplaced.token, body: { provider: 'razorpay', plan: 'monthly' } });
    eq('and may check out with either', either.status, 200);
    const placedLater = (await call(base, 'GET', '/me', { from: '2401:4900::7', token: unplaced.token })).body.account;
    eq('its first check-in from a placeable address places it', placedLater.region, 'in');
    eq('for good', (await call(base, 'GET', '/me', { from: '8.8.8.8', token: unplaced.token })).body.account.region, 'in');

    // --- a service with no country table --------------------------------------------
    const blind = await serve(createApp({ store, mailer, billing }));
    const blindUser = await signIn(blind, 'nomad@example.com', '8.8.8.8');
    eq('without a country table nobody is placed', blindUser.account.region, null);
    eq('and everyone is offered both', providersIn((await call(blind, 'GET', '/billing/options', { from: '8.8.8.8' })).body.options), ['razorpay', 'lemonsqueezy']);
  } finally {
    for (const server of servers) server.close();
    store.close();
  }

  // --- fixing a region by hand ---------------------------------------------------
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voxden-region-'));
  const file = path.join(dir, 'voxden.sqlite');
  const seeded = createStore(file);
  seeded.findOrCreateUser('vpn@example.com', new Date().toISOString());
  seeded.placeUser(seeded.userByEmail('vpn@example.com').id, 'global', 'NL');
  seeded.close();
  const before = process.env.VOXDEN_DB;
  const write = process.stdout.write.bind(process.stdout);
  const printed = [];
  process.env.VOXDEN_DB = file;
  process.stdout.write = (text) => { printed.push(String(text)); return true; };
  let codes;
  try {
    codes = [region.main(['vpn@example.com', 'show']), region.main(['vpn@example.com', 'in']), region.main(['nobody@example.com', 'in']), region.main(['vpn@example.com', 'mars'])];
  } finally {
    process.stdout.write = write;
    if (before === undefined) delete process.env.VOXDEN_DB; else process.env.VOXDEN_DB = before;
  }
  eq('the script shows the region and where it came from', printed[0], 'vpn@example.com is in region global, first seen from NL\n');
  eq('and sets it, or says why not', codes, [0, 0, 1, 2]);
  const fixed = createStore(file);
  eq('a region set by hand sticks and no longer claims a country',
    [fixed.userByEmail('vpn@example.com').region, fixed.userByEmail('vpn@example.com').country], ['in', '']);
  eq('the first-sign-in rule does not overwrite it', fixed.placeUser(fixed.userByEmail('vpn@example.com').id, 'global', 'NL'), false);
  fixed.close();
  fs.rmSync(dir, { recursive: true, force: true });

  process.stdout.write('all ' + checks + ' region checks passed\n');
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
