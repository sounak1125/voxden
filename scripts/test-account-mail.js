'use strict';

// No external mail: exercise the provider adapter and real HTTP/account path
// with injected delivery outcomes and an isolated database.
const assert = require('node:assert/strict');
const http = require('node:http');
const { createMailer } = require('../server/mail');
const { createApp } = require('../server/app');
const { createStore } = require('../server/store');

async function main() {
  const messages = [];
  const request = { to: 'test@example.test', code: '123456', minutes: 10 };
  const unconfigured = createMailer({ resendApiKey: '  ', log: line => messages.push(line) });
  assert.equal(unconfigured.configured, false);
  await assert.rejects(() => unconfigured.sendCode(request), /not configured/);
  assert.deepEqual(messages, [], 'an unsent code must not leak into logs');
  const ready = createMailer({ resendApiKey: 'fixture-key', from: 'Voxden <signin@example.test>',
    fetchImpl: async (url, init) => {
      assert.equal(url, 'https://api.resend.com/emails');
      assert.equal(init.headers.Authorization, 'Bearer fixture-key');
      assert(init.signal instanceof AbortSignal, 'delivery has a bounded timeout');
      const body = JSON.parse(init.body);
      assert.deepEqual(body.to, [request.to]);
      assert.equal(body.from, 'Voxden <signin@example.test>');
      assert(body.text.includes(request.code));
      return { ok: true };
    } });
  assert.deepEqual(await ready.sendCode(request), { delivered: true, logged: false });
  for (const status of [401, 403, 429, 500]) {
    const rejected = createMailer({ resendApiKey: 'fixture-key',
      fetchImpl: async () => ({ ok: false, status }) });
    await assert.rejects(() => rejected.sendCode(request), new RegExp(String(status)));
  }
  const timeout = createMailer({ resendApiKey: 'fixture-key', fetchImpl: async () => {
    throw new DOMException('Timed out', 'TimeoutError');
  } });
  await assert.rejects(() => timeout.sendCode(request), { name: 'TimeoutError' });

  const store = createStore(':memory:');
  const mailer = { configured: false, sendCode: async () => { throw new Error('should not send'); } };
  const app = createApp({ store, mailer, log: line => messages.push(line),
    google: { clientId: 'fixture-client', clientSecret: 'fixture-secret' } });
  const server = http.createServer(app.handle);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const send = email => fetch(base + '/v1/auth/code', { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) });
  try {
    const unavailable = await send(request.to);
    assert.equal(unavailable.status, 503);
    assert.deepEqual(await unavailable.json(), {
      error: 'Email sign-in is unavailable right now. Please use Google to sign in.',
      code: 'email_unconfigured'
    });
    assert.equal(store.latestLoginCode(request.to), null);
    const options = await (await fetch(base + '/v1/auth/options')).json();
    assert.equal(options.email.configured, false);
    mailer.configured = true;
    let index = 0;
    for (const outcome of [false, undefined, 'throw']) {
      const email = 'failure' + index++ + '@example.test';
      mailer.sendCode = async () => {
        if (outcome === 'throw') throw new Error('provider details stay private');
        return outcome === undefined ? undefined : { delivered: outcome, logged: true };
      };
      const response = await send(email);
      assert.equal(response.status, 503);
      assert.equal((await response.json()).code, 'email_delivery_failed');
      assert.equal(store.latestLoginCode(email), null, 'failed delivery cannot sign in');
      assert.equal(store.codesForEmailSince(email, '2000-01-01'), 1, 'failed delivery still counts toward limits');
    }
    assert(!messages.some(line => /123456|provider details|accepted|@/.test(line)));
    console.log('Email delivery: missing provider, provider acceptance/rejection, timeout, unsent-code invalidation and honest HTTP responses passed.');
  } finally {
    await new Promise(resolve => server.close(resolve));
    store.close();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
