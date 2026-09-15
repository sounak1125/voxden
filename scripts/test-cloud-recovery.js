'use strict';
const assert = require('assert');
const http = require('http');
const crypto = require('crypto');
const { createCloudTranscriber } = require('../server/cloud');
const { CloudTranscriber } = require('../src/cloud');
const { createStore } = require('../server/store');
const { createApp, dayOf, creditMonthOf } = require('../server/app');
const response = (status, retryAfter) => ({ ok: status === 200, status,
  headers: { get: () => retryAfter },
  json: async () => status === 200 ? { text: 'recovered speech', usage: { seconds: 2 } } : { error: { message: 'Provider busy' } },
});
const wav = () => {
  const b = Buffer.alloc(64044);
  b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVE', 8); b.write('fmt ', 12);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(64000, 40); return b;
};
async function checkRecovery() {
  {
    const bodies = [], delays = [];
    const cloud = createCloudTranscriber({ apiKey: 'test', retryWait: async ms => delays.push(ms),
      fetchImpl: async (_url, req) => { bodies.push(req.body); return response(bodies.length < 3 ? 429 : 200, '2.5'); } });
    const r = await cloud.transcribe({ audioBase64: 'same-audio', terms: ['Voxden'] });
    assert.strictEqual(r.text, 'recovered speech');
    assert.strictEqual(r.retries, 2);
    assert.deepStrictEqual(delays, [2500, 2500], 'provider Retry-After is never shortened');
    assert.strictEqual(new Set(bodies).size, 1, 'retries preserve exact failed audio and its hints');
  }
  {
    const bodies = [], statuses = [400, 429, 200];
    const cloud = createCloudTranscriber({ apiKey: 'test', retryWait: async () => {},
      fetchImpl: async (_url, req) => { bodies.push(JSON.parse(req.body)); return response(statuses.shift()); } });
    const r = await cloud.transcribe({ audioBase64: 'same-audio', terms: ['Voxden'] });
    assert.strictEqual(r.hintsDropped, true);
    assert.strictEqual(r.retried, true);
    assert(bodies[0].provider && !bodies[1].provider && !bodies[2].provider, 'optional hint fallback remains active across a rate-limit retry');
  }
  for (const status of [400, 401, 403, 404, 413, 422, 429, 503]) {
    let calls = 0;
    const cloud = createCloudTranscriber({ apiKey: 'test', retryWait: async () => {},
      fetchImpl: async () => { calls++; return response(status); } });
    await assert.rejects(cloud.transcribe({}), e => e.status === status);
    assert.strictEqual(calls, [429, 503].includes(status) ? 3 : 1, 'bounded retries apply only to temporary failures');
  }
  {
    let calls = 0;
    const cloud = createCloudTranscriber({ apiKey: 'test', timeoutMs: 100,
      fetchImpl: async () => { calls++; return response(429, '60'); } });
    await assert.rejects(cloud.transcribe({}), e => e.status === 429);
    assert.strictEqual(calls, 1, 'a Retry-After beyond the recovery budget never triggers an early retry');
  }
  {
    let calls = 0;
    const controller = new AbortController();
    const cloud = createCloudTranscriber({ apiKey: 'test', fetchImpl: async () => { calls++; return response(429); } });
    const pending = cloud.transcribe({ signal: controller.signal });
    const checked = assert.rejects(pending, e => e.code === 'cancelled');
    await new Promise(resolve => setTimeout(resolve, 30));
    controller.abort();
    await checked;
    assert.strictEqual(calls, 1, 'cancellation interrupts a pending backoff');
  }
  {
    const controller = new AbortController();
    let signal;
    const client = new CloudTranscriber({ token: () => 'test', fetchImpl: async (_url, req) => {
      signal = req.signal;
      return new Promise((_resolve, reject) => req.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    } });
    const pending = client.transcribe(wav(), { signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, e => e.code === 'cancelled');
    assert(signal.aborted, 'desktop cancellation aborts the in-flight network request');
  }

  // Real HTTP relay and real metering, with only the external model stubbed.
  const store = createStore(':memory:');
  const now = Date.now(), stamp = new Date(now).toISOString();
  const user = store.findOrCreateUser('recovery@example.test', stamp);
  store.setPlan('recovery@example.test', 'pro', new Date(now + 86400000).toISOString());
  const token = 'test-recovery-session';
  store.createSession({ tokenHash: crypto.createHash('sha256').update(token).digest('hex'), userId: user.id, device: 'test', createdAt: stamp });
  let calls = 0, cancelMode = false, noticedAbort;
  const aborted = new Promise(resolve => { noticedAbort = resolve; });
  const cloud = createCloudTranscriber({ apiKey: 'test', retryWait: async (_ms, signal) => {
    if (!cancelMode) return;
    await new Promise((_resolve, reject) => signal.addEventListener('abort', () => { noticedAbort(); reject(new Error('aborted')); }, { once: true }));
  }, fetchImpl: async () => { calls++; return response(cancelMode || calls <= 2 ? 429 : 200); } });
  const relay = createApp({ store, mailer: { sendCode: async () => {} }, now: () => now, cloud });
  const server = http.createServer(relay.handle);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const client = new CloudTranscriber({ baseUrl: 'http://127.0.0.1:' + server.address().port + '/v1', token: () => token });
  const month = creditMonthOf(0, now);
  const usage = () => store.usageSecondsBetween(user.id, dayOf(month.start), dayOf(month.end));
  try {
    assert.strictEqual((await client.transcribe(wav(), { audioSeconds: 2 })).text, 'recovered speech');
    assert.strictEqual(calls, 3, 'two rejected provider attempts recover on the third');
    assert.strictEqual(usage(), 2, 'the recovered segment is charged once, not once per provider attempt');
    cancelMode = true;
    const controller = new AbortController();
    const pending = client.transcribe(wav(), { signal: controller.signal });
    const checked = assert.rejects(pending, e => e.code === 'cancelled');
    for (let i = 0; calls < 4 && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.strictEqual(calls, 4);
    controller.abort();
    await checked;
    let timeout;
    await Promise.race([aborted, new Promise((_resolve, reject) => { timeout = setTimeout(() => reject(new Error('Relay did not cancel')), 1000); })]).finally(() => clearTimeout(timeout));
    assert.strictEqual(calls, 4, 'client disconnect prevents further upstream retries');
    assert.strictEqual(usage(), 2, 'cancelled recovery adds no usage');
  } finally {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close();
  }
  console.log('ok cloud recovery: rate limits, backoff, exact audio, permanent errors, bounded deadline, cancellation, single metering');
}
module.exports = checkRecovery;
if (require.main === module) checkRecovery().catch(e => { console.error(e); process.exitCode = 1; });
