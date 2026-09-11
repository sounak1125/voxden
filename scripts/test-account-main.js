'use strict';

// The main process's account handlers against the real account service:
// src/main.js in the harness, talking over HTTP to server/app.js with an
// in-memory database. Proves the IPC shape, the token round trip, and that
// a failure comes back as a message in the snapshot rather than a rejection.

const assert = require('assert');
const http = require('http');
const fs = require('fs');
const path = require('path');
const harness = require('./asr-test-harness');
const { createStore } = require('../server/store');
const { createApp } = require('../server/app');

let checks = 0;
function eq(label, actual, expected) {
  assert.deepStrictEqual(actual, expected, label + '\n  got: ' + JSON.stringify(actual));
  checks += 1;
  process.stdout.write('ok ' + label + '\n');
}

async function main() {
  const sent = [];
  const store = createStore(':memory:');
  const app = createApp({ store, mailer: { sendCode: async (m) => { sent.push(m); } } });
  const server = http.createServer(app.handle);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port + '/v1';

  const h = harness();
  try {
    // The harness's vm has no fetch; hand main's manager the real one and
    // point it at the local service.
    h.context.testFetch = (url, init) => fetch(url, init);
    h.run('accountManager.fetch = testFetch; accountManager.baseUrl = ' + JSON.stringify(base) + ';');
    const call = (channel, ...args) => h.handlers.get(channel)(null, ...args);

    const fresh = await call('account-refresh');
    eq('signed out to begin with', [fresh.account.signedIn, fresh.account.plan], [false, 'free']);

    const bad = await call('account-code', 'not-an-email');
    eq('a bad address is a message, not a throw', bad.account.lastError, 'Enter a valid email address.');

    const pending = await call('account-code', 'Person@Example.com');
    eq('a code is requested for the normalised address', [pending.account.pendingEmail, sent[0].to], ['person@example.com', 'person@example.com']);

    const wrong = await call('account-verify', '', '000000');
    eq('a wrong code reports the service reason', wrong.account.lastError, 'That code is not right. Check the email and try again.');

    const signed = await call('account-verify', '', sent[0].code);
    eq('the right code signs main in', [signed.account.signedIn, signed.account.email, signed.account.plan], [true, 'person@example.com', 'free']);
    const file = path.join(h.root, 'data', 'account.json');
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
    eq('the harness has no safeStorage, so the token is stored as is and disclosed', [typeof onDisk.tokenPlain, signed.account.tokenProtected], ['string', false]);

    store.setPlan('person@example.com', 'pro', '2027-01-01T00:00:00.000Z');
    const refreshed = await call('account-refresh');
    eq('a refresh picks up a granted plan', [refreshed.account.plan, refreshed.account.cloud.hoursCap], ['pro', 10]);

    const out = await call('account-sign-out');
    eq('sign-out clears the snapshot', [out.account.signedIn, out.account.email], [false, '']);
    eq('and the file', 'tokenPlain' in JSON.parse(fs.readFileSync(file, 'utf8')), false);
  } finally {
    await h.close();
    server.close();
    store.close();
  }
  process.stdout.write('all ' + checks + ' account main-process checks passed\n');
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
