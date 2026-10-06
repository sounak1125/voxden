'use strict';

// The sign-in for Google Play's app reviewers (reviewLogin in server/app.js):
// one address with a fixed six-digit code, no email, and an account kept on
// Pro. It must leave every other sign-in exactly as it was.

const assert = require('assert');
const http = require('http');
const { createStore } = require('../server/store');
const { createApp } = require('../server/app');

let checks = 0;
function eq(label, actual, expected) {
  assert.deepStrictEqual(actual, expected, label + '\n  got: ' + JSON.stringify(actual));
  checks++; process.stdout.write('ok ' + label + '\n');
}

const DAY = 24 * 3600e3;

async function serve(opts) {
  const sent = [];
  const store = createStore(':memory:');
  const clock = { t: Date.parse('2026-10-07T09:00:00Z') };
  const mailer = { configured: opts.mailer !== false, sendCode: async (m) => { sent.push(m); return { delivered: true }; } };
  const app = createApp({ store, mailer, now: () => clock.t, log: () => {}, reviewLogin: opts.reviewLogin });
  const server = http.createServer(app.handle);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port + '/v1';
  const call = async (route, body) => {
    const res = await fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  return { sent, store, clock, server, request: (email) => call('/auth/code', { email }), verify: (email, code) => call('/auth/verify', { email, code, device: 'Pixel' }) };
}

async function main() {
  const REVIEW = { email: 'Review@Example.com', code: '482915' };

  // Off, the review address is an ordinary one.
  const plain = await serve({});
  eq('without the setting the review address is mailed a code like anyone', [(await plain.request('review@example.com')).status, plain.sent.length], [204, 1]);
  const guess = await plain.verify('review@example.com', '482915');
  eq('and the fixed code means nothing', guess.status, 400);
  plain.server.close();

  // A code that is not six digits leaves it off.
  const malformed = await serve({ reviewLogin: { email: 'review@example.com', code: '4829' } });
  await malformed.request('review@example.com');
  eq('a setting whose code is not six digits is ignored', malformed.sent.length, 1);
  malformed.server.close();

  const s = await serve({ reviewLogin: REVIEW });
  try {
    eq('the review address is sent no email, whatever case the setting and the app use', [(await s.request('REVIEW@example.com')).status, s.sent.length], [204, 0]);
    const wrong = await s.verify('review@example.com', '111111');
    eq('a wrong code is refused', wrong.status, 400);
    const signedIn = await s.verify('review@example.com', '482915');
    eq('the fixed code signs in, on Pro', [signedIn.status, typeof signedIn.body.token, signedIn.body.account.plan], [200, 'string', 'pro']);
    eq('for thirty days', s.store.userByEmail('review@example.com').plan_expires_at, new Date(s.clock.t + 30 * DAY).toISOString());
    eq('and the code is used up', (await s.verify('review@example.com', '482915')).status, 400);

    s.clock.t += 40 * DAY;
    await s.request('review@example.com');
    await s.verify('review@example.com', '482915');
    eq('a later sign-in keeps the account on Pro', s.store.userByEmail('review@example.com').plan_expires_at, new Date(s.clock.t + 30 * DAY).toISOString());

    // Nobody else is touched.
    eq('another address is still emailed a real code', [(await s.request('someone@example.com')).status, s.sent.length, s.sent[0].to], [204, 1, 'someone@example.com']);
    eq('and cannot sign in with the fixed code', (await s.verify('someone@example.com', '482915')).status, 400);
    eq('the real code works for them, on the free plan', (await s.verify('someone@example.com', s.sent[0].code)).body.account.plan, 'free');

    // Guessing is limited like any code: five tries a code, twenty wrong a day.
    await s.request('review@example.com');
    for (let i = 0; i < 5; i++) await s.verify('review@example.com', '000000');
    eq('guessing against one code stops after five tries', (await s.verify('review@example.com', '482915')).body.error.includes('Too many wrong attempts'), true);
    await s.request('review@example.com');
    eq('a new request opens a new code', (await s.verify('review@example.com', '482915')).status, 200);
    for (let i = 0; i < 4; i++) {
      s.clock.t += 61 * 60e3; // the hourly limit on codes is not what this is testing
      await s.request('review@example.com');
      for (let j = 0; j < 5; j++) await s.verify('review@example.com', '000000');
    }
    s.clock.t += 61 * 60e3;
    await s.request('review@example.com');
    const locked = await s.verify('review@example.com', '482915');
    eq('twenty wrong codes in a day lock the address, as for anyone', [locked.status, locked.body.code], [429, 'locked']);
  } finally {
    s.server.close();
  }

  // It must work with the mailer down: the point is that it needs no mail.
  const noMail = await serve({ mailer: false, reviewLogin: REVIEW });
  eq('with email sign-in down the review address still gets a code', (await noMail.request('review@example.com')).status, 204);
  eq('and signs in', (await noMail.verify('review@example.com', '482915')).status, 200);
  eq('while everyone else is told it is unavailable', (await noMail.request('someone@example.com')).status, 503);
  noMail.server.close();

  process.stdout.write('\n' + checks + ' checks passed\n');
}

main().catch((err) => { console.error(err); process.exit(1); });
