'use strict';

// Regional pricing on the service: an account is placed in India or global
// pricing from the country its first sign-in comes from, keeps that region,
// sees only that region's plans, and cannot check out with the other one. The
// global plan is not sold at all in the countries closed to it.

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { createStore } = require('../server/store');
const { createApp, regionOfCountry, DEFAULT_CLOSED_COUNTRIES } = require('../server/app');
const { createBilling } = require('../server/billing');
const region = require('../server/region');

let checks = 0;
function eq(label, actual, expected) {
  assert.deepStrictEqual(actual, expected, label + '\n  got: ' + JSON.stringify(actual));
  checks++;
  process.stdout.write('ok ' + label + '\n');
}

// Stand-in addresses: what the country table would say about each.
const COUNTRIES = { '49.36.10.1': 'IN', '2401:4900::7': 'IN', '8.8.8.8': 'US', '81.2.69.160': 'GB', '91.198.174.192': 'NL' };
const geo = { countryOf: (ip) => COUNTRIES[ip] || '' };

// Razorpay as billing.js builds it, with both regions on sale.
function fakeRazorpay() {
  return {
    id: 'razorpay', configured: true,
    offers: [
      { region: 'in', label: 'India', labels: { monthly: '₹349 / month' } },
      { region: 'global', label: 'Everywhere else', labels: { monthly: '$8 / month' } },
    ],
    createCheckout: async ({ region }) => ({ url: 'https://pay.example/razorpay/' + region, providerId: 'sub_' + region }),
  };
}

async function main() {
  eq('India is the India region and every other country is global',
    ['IN', 'US', 'GB', 'AE'].map(regionOfCountry), ['in', 'global', 'global', 'global']);

  const sent = [];
  const store = createStore(':memory:');
  const billing = createBilling({ providers: { razorpay: fakeRazorpay() } });
  const servers = [];
  const serve = async (app) => {
    const server = http.createServer(app.handle);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    servers.push(server);
    return 'http://127.0.0.1:' + server.address().port + '/v1';
  };
  const mailer = { sendCode: async (m) => { sent.push(m); return { delivered: true }; }, configured: true };
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
  const offersIn = (options) => options.map((group) => group.provider + ':' + group.region);

  try {
    // --- before sign-in -------------------------------------------------------
    const fromIndia = (await call(base, 'GET', '/billing/options', { from: '49.36.10.1' })).body;
    eq('a signed-out request from India is offered the India plan only', [fromIndia.region, offersIn(fromIndia.options)], ['in', ['razorpay:in']]);
    const fromUs = (await call(base, 'GET', '/billing/options', { from: '8.8.8.8' })).body;
    eq('from the US, the global plan only, through the same Razorpay', [fromUs.region, offersIn(fromUs.options), fromUs.unavailable], ['global', ['razorpay:global'], undefined]);
    eq('at the global price', fromUs.options[0].plans, [{ id: 'monthly', label: '$8 / month' }]);
    const unknown = (await call(base, 'GET', '/billing/options', { from: '203.0.113.9' })).body;
    eq('an address the table cannot place is offered both, India first', [unknown.region, offersIn(unknown.options)], [null, ['razorpay:in', 'razorpay:global']]);
    const fromUk = (await call(base, 'GET', '/billing/options', { from: '81.2.69.160' })).body;
    eq('from the UK, nothing, and the reason', [fromUk.region, fromUk.options, fromUk.unavailable], ['global', [], 'country']);
    eq('nor from the Netherlands', (await call(base, 'GET', '/billing/options', { from: '91.198.174.192' })).body.unavailable, 'country');
    eq('the closed list is the EU, the UK, Monaco and the Isle of Man', [DEFAULT_CLOSED_COUNTRIES.length, ['GB', 'IM', 'MC', 'DE', 'GR', 'IE'].every((code) => DEFAULT_CLOSED_COUNTRIES.includes(code)),
      ['US', 'IN', 'CH', 'NO', 'AE'].some((code) => DEFAULT_CLOSED_COUNTRIES.includes(code))], [30, true, false]);

    // --- the first sign-in decides ----------------------------------------------
    const indian = await signIn(base, 'priya@example.com', '49.36.10.1');
    eq('a first sign-in from India places the account in India', indian.account.region, 'in');
    eq('and records the country that decided it', [store.userByEmail('priya@example.com').region, store.userByEmail('priya@example.com').country], ['in', 'IN']);
    const travelling = (await call(base, 'GET', '/me', { from: '8.8.8.8', token: indian.token })).body.account;
    eq('checking in later from the US changes nothing', travelling.region, 'in');
    const again = await signIn(base, 'priya@example.com', '81.2.69.160');
    eq('nor does signing in again from the UK', [again.account.region, store.userByEmail('priya@example.com').country], ['in', 'IN']);
    const indianOptions = (await call(base, 'GET', '/billing/options', { from: '8.8.8.8', token: indian.token })).body;
    eq('signed in, the account\'s region decides the plans, not the address', [indianOptions.region, offersIn(indianOptions.options)], ['in', ['razorpay:in']]);
    const indianFromUk = (await call(base, 'GET', '/billing/options', { from: '81.2.69.160', token: indian.token })).body;
    eq('an India account visiting the UK still sees its own plan', [indianFromUk.region, offersIn(indianFromUk.options), indianFromUk.unavailable], ['in', ['razorpay:in'], undefined]);

    const american = await signIn(base, 'sam@example.com', '8.8.8.8');
    eq('a first sign-in from the US places the account in global pricing', american.account.region, 'global');
    const americanOptions = (await call(base, 'GET', '/billing/options', { from: '49.36.10.1', token: american.token })).body;
    eq('which later sees only the global plan, even from India', [americanOptions.region, offersIn(americanOptions.options)], ['global', ['razorpay:global']]);
    const americanFromUk = (await call(base, 'GET', '/billing/options', { from: '81.2.69.160', token: american.token })).body;
    eq('and keeps it when visiting the UK, where the country it was placed from decides', [offersIn(americanFromUk.options), americanFromUk.unavailable], [['razorpay:global'], undefined]);

    // --- checkout holds the line -------------------------------------------------
    const cheap = await call(base, 'POST', '/billing/checkout', { from: '49.36.10.1', token: american.token, body: { provider: 'razorpay', plan: 'monthly', region: 'in' } });
    eq('a global account cannot check out at the India price', [cheap.status, cheap.body.code], [400, 'region']);
    const own = await call(base, 'POST', '/billing/checkout', { from: '8.8.8.8', token: american.token, body: { provider: 'razorpay', plan: 'monthly' } });
    eq('and naming no region checks out at its own', [own.status, own.body.provider, own.body.region], [200, 'razorpay', 'global']);
    const indianCheckout = await call(base, 'POST', '/billing/checkout', { from: '8.8.8.8', token: indian.token, body: { provider: 'razorpay', plan: 'monthly' } });
    eq('an India account checks out in rupees from anywhere', [indianCheckout.status, indianCheckout.body.region], [200, 'in']);
    const dollars = await call(base, 'POST', '/billing/checkout', { token: indian.token, body: { provider: 'razorpay', plan: 'monthly', region: 'global' } });
    eq('and not on the global plan', [dollars.status, dollars.body.code], [400, 'region']);

    // --- the closed countries ------------------------------------------------------
    const briton = await signIn(base, 'alex@example.com', '81.2.69.160');
    eq('a first sign-in from the UK places the account in global pricing, recording GB',
      [briton.account.region, store.userByEmail('alex@example.com').country], ['global', 'GB']);
    const britonOptions = (await call(base, 'GET', '/billing/options', { from: '8.8.8.8', token: briton.token })).body;
    eq('it is offered nothing, even from the US, and told why', [britonOptions.options, britonOptions.unavailable], [[], 'country']);
    const britonCheckout = await call(base, 'POST', '/billing/checkout', { from: '8.8.8.8', token: briton.token, body: { provider: 'razorpay', plan: 'monthly' } });
    eq('and cannot check out', [britonCheckout.status, britonCheckout.body.code], [400, 'country']);
    const open = await serve(createApp({ store, mailer, billing, geo, closedCountries: [] }));
    eq('an empty closed list sells there after all', offersIn((await call(open, 'GET', '/billing/options', { from: '81.2.69.160', token: briton.token })).body.options), ['razorpay:global']);
    const usClosed = await serve(createApp({ store, mailer, billing, geo, closedCountries: ['us'] }));
    eq('and a list names its own countries, in either case', (await call(usClosed, 'GET', '/billing/options', { from: '8.8.8.8' })).body.unavailable, 'country');
    eq('leaving the UK open under it', offersIn((await call(usClosed, 'GET', '/billing/options', { from: '81.2.69.160', token: briton.token })).body.options), ['razorpay:global']);
    eq('the closed list never touches the UK account\'s record',
      [store.userByEmail('alex@example.com').region, store.userByEmail('alex@example.com').country], ['global', 'GB']);

    // --- an account nothing could place yet -----------------------------------------
    const unplaced = await signIn(base, 'dev@example.com', '127.0.0.1');
    eq('a sign-in from an address the table cannot place leaves the account unplaced', unplaced.account.region, null);
    const devOptions = (await call(base, 'GET', '/billing/options', { from: '127.0.0.1', token: unplaced.token })).body;
    eq('it is offered both regions meanwhile', [devOptions.region, offersIn(devOptions.options)], [null, ['razorpay:in', 'razorpay:global']]);
    const either = await call(base, 'POST', '/billing/checkout', { token: unplaced.token, body: { provider: 'razorpay', plan: 'monthly', region: 'global' } });
    eq('and may check out in the region it picks', [either.status, either.body.region], [200, 'global']);
    const unnamed = await call(base, 'POST', '/billing/checkout', { token: unplaced.token, body: { provider: 'razorpay', plan: 'monthly', region: 'mars' } });
    eq('a region it cannot name is India, as for apps that send none', [unnamed.status, unnamed.body.region], [200, 'in']);
    const placedLater = (await call(base, 'GET', '/me', { from: '2401:4900::7', token: unplaced.token })).body.account;
    eq('its first check-in from a placeable address places it', placedLater.region, 'in');
    eq('for good', (await call(base, 'GET', '/me', { from: '8.8.8.8', token: unplaced.token })).body.account.region, 'in');

    // --- a service with no country table --------------------------------------------
    const blind = await serve(createApp({ store, mailer, billing }));
    const blindUser = await signIn(blind, 'nomad@example.com', '8.8.8.8');
    eq('without a country table nobody is placed', blindUser.account.region, null);
    eq('and everyone is offered both', offersIn((await call(blind, 'GET', '/billing/options', { from: '8.8.8.8' })).body.options), ['razorpay:in', 'razorpay:global']);
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
