'use strict';

// Real HTTP admission and metering with controlled provider completion. No
// sleeps stand in for paid model responses, and each case has its own account.
const assert = require('assert');
const http = require('http');
const crypto = require('crypto');
const { createStore } = require('../server/store');
const { createApp, dayOf } = require('../server/app');

module.exports = async function testReservations() {
  let clock = Date.parse('2026-10-03T12:00:00Z');
  const store = createStore(':memory:');
  const pending = [];
  const provider = kind => args => new Promise((resolve, reject) => {
    const call = { kind, args, resolve, reject, aborted: false };
    pending.push(call);
    args.signal.addEventListener('abort', () => {
      call.aborted = true;
      reject(Object.assign(new Error('cancelled'), { code: 'cancelled' }));
    }, { once: true });
  });
  const app = createApp({ store, mailer: { sendCode: async () => {} }, now: () => clock,
    cloudCreditsCap: 1, cloudCreditsReset: 'never',
    cloud: { configured: true, transcribe: provider('speech') },
    polisher: { configured: true, polish: provider('polish') } });
  const server = http.createServer(app.handle);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port + '/v1';
  const users = [];
  function account(remaining) {
    const email = 'reservation-' + users.length + '@example.com';
    const user = store.findOrCreateUser(email, new Date(clock).toISOString());
    store.setPlan(email, 'pro', '2027-01-01T00:00:00.000Z');
    store.addUsageSeconds(user.id, dayOf(clock), 60 - remaining);
    const token = crypto.randomBytes(24).toString('hex');
    store.createSession({ tokenHash: crypto.createHash('sha256').update(token).digest('hex'),
      userId: user.id, device: 'test', createdAt: new Date(clock).toISOString() });
    users.push(user);
    return { ...user, token };
  }
  function audio(seconds) {
    const bytes = Math.round(seconds * 32000), header = Buffer.alloc(44);
    header.write('RIFF'); header.writeUInt32LE(36 + bytes, 4); header.write('WAVE', 8);
    header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22); header.writeUInt32LE(16000, 24); header.writeUInt32LE(32000, 28);
    header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(bytes, 40);
    return { audio: Buffer.concat([header, Buffer.alloc(bytes)]).toString('base64'), format: 'wav' };
  }
  async function request(user, route, body, signal) {
    const res = await fetch(base + route, { method: 'POST', signal,
      headers: { Authorization: 'Bearer ' + user.token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  }
  async function until(predicate) {
    for (let i = 0; i < 400; i++) {
      if (predicate()) return;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.fail('HTTP provider handoff did not complete');
  }
  async function begin(user, route, body) {
    const index = pending.length;
    const response = request(user, route, body);
    await until(() => pending.length > index);
    return { response, call: pending[index] };
  }
  try {
    const a = account(10), b = account(10);
    const first = await begin(a, '/transcribe', audio(6));
    const denied = await request(a, '/transcribe', audio(6));
    assert.deepStrictEqual([denied.status, denied.body.code], [402, 'cap']);
    assert.strictEqual(pending.length, 1, 'reserved credits reject overspending before a provider call');
    const other = await begin(b, '/transcribe', audio(6));
    clock += 25;
    other.call.resolve({ text: 'other account', billedSeconds: 6 });
    assert.strictEqual((await other.response).status, 200, 'reservations are isolated per account');
    first.call.resolve({ text: 'first', billedSeconds: 6, hedged: true, retried: true });
    const completed = await first.response;
    assert.deepStrictEqual(completed.body.timing, { relayMs: 25, hedged: true, retried: true });
    assert.strictEqual(store.usageSecondsTotal(a.id), 56, 'success charges once');
    const remaining = await begin(a, '/transcribe', audio(4));
    remaining.call.resolve({ text: 'remaining', billedSeconds: 4 });
    assert.deepStrictEqual((await remaining.response).body.timing, { relayMs: 0, hedged: false, retried: false });
    assert.strictEqual(store.usageSecondsTotal(a.id), 60, 'success releases its reservation before the next request');

    for (const firstRoute of ['/polish', '/transcribe']) {
      const user = account(20);
      const routeBody = route => route === '/polish' ? { text: 'Please improve this sentence.' } : audio(10);
      const active = await begin(user, firstRoute, routeBody(firstRoute));
      const secondRoute = firstRoute === '/polish' ? '/transcribe' : '/polish';
      const count = pending.length;
      const blocked = await request(user, secondRoute, routeBody(secondRoute));
      assert.deepStrictEqual([blocked.status, blocked.body.code], [402, 'cap'], 'speech and Polish share reservations');
      assert.strictEqual(pending.length, count);
      active.call.reject(Object.assign(new Error('provider timed out'), { code: 'timeout' }));
      assert.strictEqual((await active.response).status, 502);
      assert.strictEqual(store.usageSecondsTotal(user.id), 40, 'failed work costs nothing');
      const retry = await begin(user, secondRoute, routeBody(secondRoute));
      retry.call.resolve({ text: 'recovered', billedSeconds: 10, model: 'test' });
      assert.strictEqual((await retry.response).status, 200, 'failure releases credits for either operation');
    }

    const abandonedUser = account(10), controller = new AbortController();
    const index = pending.length;
    const abandoned = request(abandonedUser, '/transcribe', audio(10), controller.signal);
    await until(() => pending.length > index);
    controller.abort();
    await assert.rejects(abandoned, error => error.name === 'AbortError');
    await until(() => pending[index].aborted);
    const retry = await begin(abandonedUser, '/transcribe', audio(10));
    retry.call.resolve({ text: 'retry after cancel', billedSeconds: 10 });
    assert.strictEqual((await retry.response).status, 200, 'disconnect releases the complete credit reservation');
    assert.strictEqual(store.usageSecondsTotal(abandonedUser.id), 60, 'abandoned work is not charged');
    console.log('ok cloud reservations: concurrent credit cap, account isolation, shared Polish budget, release on success/failure/disconnect, relay timing');
  } finally {
    for (const call of pending) call.reject(new Error('test complete'));
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
  }
};

if (require.main === module) module.exports().catch(error => { console.error(error); process.exitCode = 1; });
