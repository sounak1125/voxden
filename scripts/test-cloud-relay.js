'use strict';

// The metered relay end to end: the desktop CloudTranscriber, the service's
// /v1/transcribe, and a stand-in for the upstream speech model, over real
// HTTP with an in-memory database.

const assert = require('assert');
const http = require('http');
const { createStore } = require('../server/store');
const { createApp, periodOf } = require('../server/app');
const { createCloudTranscriber, wavSeconds } = require('../server/cloud');
const { CloudTranscriber, cloudTimeoutMs, shouldTryCloud } = require('../src/cloud');

let checks = 0;
function ok(label, value) { assert.ok(value, label); checks++; process.stdout.write('ok ' + label + '\n'); }
function eq(label, actual, expected) {
  assert.deepStrictEqual(actual, expected, label + '\n  got: ' + JSON.stringify(actual));
  checks++; process.stdout.write('ok ' + label + '\n');
}

// A canonical 16 kHz mono 16-bit WAV of the given length, silence.
function wav(seconds) {
  const rate = 16000;
  const data = Buffer.alloc(Math.round(seconds * rate) * 2);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + data.length, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

async function checkResponseDeadlines() {
  let bodiesStarted = 0;
  const stalled = http.createServer((req, res) => {
    req.resume();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.write('{"text":');
    bodiesStarted++;
    // A regression must fail the assertion instead of hanging this suite.
    const safeguard = setTimeout(() => res.end('"late"}'), 1500);
    res.on('close', () => clearTimeout(safeguard));
  });
  await new Promise((resolve) => stalled.listen(0, '127.0.0.1', resolve));
  const baseUrl = 'http://127.0.0.1:' + stalled.address().port;
  try {
    const client = new CloudTranscriber({ baseUrl, token: () => 'test-session' });
    await assert.rejects(() => client.transcribe(wav(1), { timeoutMs: 150 }), (err) => err.code === 'timeout');
    eq('the client times out after response headers and a partial body arrive', bodiesStarted, 1);

    const upstream = createCloudTranscriber({ apiKey: 'test-key', upstreamUrl: baseUrl, timeoutMs: 150 });
    await assert.rejects(() => upstream.transcribe({ audioBase64: wav(1).toString('base64') }), (err) => err.code === 'timeout');
    eq('the upstream deadline also covers a stalled response body', bodiesStarted, 2);
  } finally {
    stalled.closeAllConnections();
    await new Promise((resolve) => stalled.close(resolve));
  }

  const malformed = (status) => async () => ({
    ok: status === 200,
    status,
    json: async () => { throw new SyntaxError('Invalid JSON'); },
  });
  const malformedClient = new CloudTranscriber({ token: () => 'test-session', fetchImpl: malformed(200) });
  eq('malformed successful relay JSON keeps its empty-result behavior', (await malformedClient.transcribe(wav(1))).text, '');
  const malformedUpstream = createCloudTranscriber({ apiKey: 'test-key', fetchImpl: malformed(200) });
  eq('malformed successful model JSON keeps its empty-result behavior', (await malformedUpstream.transcribe({})).text, '');
  const rejectedClient = new CloudTranscriber({ token: () => 'test-session', fetchImpl: malformed(401) });
  await assert.rejects(() => rejectedClient.transcribe(wav(1)), (err) => err.code === 'auth' && err.status === 401);
  ok('malformed relay errors preserve their HTTP status mapping', true);
  const rejectedUpstream = createCloudTranscriber({ apiKey: 'test-key', fetchImpl: malformed(502) });
  await assert.rejects(() => rejectedUpstream.transcribe({}), (err) => err.code === 'upstream' && err.status === 502);
  ok('malformed model errors preserve their HTTP status mapping', true);

  const disconnected = async () => { throw new TypeError('Connection closed'); };
  const disconnectedClient = new CloudTranscriber({ token: () => 'test-session', fetchImpl: disconnected });
  await assert.rejects(() => disconnectedClient.transcribe(wav(1)), (err) => err.code === 'network');
  ok('a relay connection failure remains code network', true);
  const disconnectedUpstream = createCloudTranscriber({ apiKey: 'test-key', fetchImpl: disconnected });
  await assert.rejects(() => disconnectedUpstream.transcribe({}), (err) => err.code === 'upstream');
  ok('a model connection failure remains code upstream', true);
}

async function main() {
  // --- pure pieces ----------------------------------------------------------
  eq('a ten second clip measures ten seconds', wavSeconds(wav(10)), 10);
  eq('junk measures zero', wavSeconds(Buffer.from('not a wav at all, really')), 0);
  eq('the budget grows with the clip and stops at twelve seconds', [cloudTimeoutMs(0), cloudTimeoutMs(10), cloudTimeoutMs(100)], [3500, 6000, 12000]);
  const pro = { signedIn: true, plan: 'pro', cloud: { hoursUsed: 1, hoursCap: 10 } };
  eq('off means off', shouldTryCloud({ enabled: false, account: pro, audioSeconds: 5 }).reason, 'off');
  eq('signed out is named', shouldTryCloud({ enabled: true, account: { signedIn: false }, audioSeconds: 5 }).reason, 'signed-out');
  eq('free is named', shouldTryCloud({ enabled: true, account: { ...pro, plan: 'free' }, audioSeconds: 5 }).reason, 'plan');
  eq('a used-up month is named', shouldTryCloud({ enabled: true, account: { ...pro, cloud: { hoursUsed: 10, hoursCap: 10 } }, audioSeconds: 5 }).reason, 'cap');
  eq('a blip is not worth a round trip', shouldTryCloud({ enabled: true, account: pro, audioSeconds: 0.1 }).reason, 'short');
  eq('otherwise go', shouldTryCloud({ enabled: true, account: pro, audioSeconds: 5 }).ok, true);
  await checkResponseDeadlines();

  // --- the upstream stand-in ------------------------------------------------
  const upstreamCalls = [];
  let upstreamMode = 'ok';
  const upstream = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const parsed = JSON.parse(body);
      upstreamCalls.push({ auth: req.headers.authorization, model: parsed.model, format: parsed.input_audio.format,
        bytes: Buffer.from(parsed.input_audio.data, 'base64').length, language: parsed.language,
        phrases: parsed.provider ? parsed.provider.options.azure.phraseList.phrases : null });
      if (upstreamMode === 'fail') { res.writeHead(500, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: { message: 'model exploded' } })); }
      if (upstreamMode === 'hang') return; // never answers
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ text: 'hello from the cloud', usage: { seconds: 4.5, total_tokens: 12, cost: 0.000125 } }));
    });
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const upstreamUrl = 'http://127.0.0.1:' + upstream.address().port + '/audio/transcriptions';

  // --- the service ------------------------------------------------------------
  let clock = Date.parse('2026-09-11T09:00:00Z');
  const store = createStore(':memory:');
  const cloud = createCloudTranscriber({ apiKey: 'sk-test', model: 'test/model', upstreamUrl, timeoutMs: 300 });
  const app = createApp({ store, mailer: { sendCode: async () => {} }, now: () => clock, cloudHoursCap: 10, cloud });
  const server = http.createServer(app.handle);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port + '/v1';
  const user = store.findOrCreateUser('pro@example.com', new Date(clock).toISOString());
  const tokenFor = (email) => {
    const t = 'tok_' + require('crypto').randomBytes(24).toString('hex');
    store.createSession({ tokenHash: require('crypto').createHash('sha256').update(t).digest('hex'),
      userId: store.userByEmail(email).id, device: 'test', createdAt: new Date(clock).toISOString() });
    return t;
  };
  let token = tokenFor('pro@example.com');
  const client = new CloudTranscriber({ baseUrl: base, token: () => token });

  try {
    // Free first.
    await assert.rejects(() => client.transcribe(wav(5), { audioSeconds: 5 }), (err) => err.code === 'plan');
    ok('a free account is refused with code plan', true);

    store.setPlan('pro@example.com', 'pro', '2027-01-01T00:00:00.000Z');
    const first = await client.transcribe(wav(5), { language: 'en', terms: ['Kharagpur', 'Voxden'], audioSeconds: 5 });
    eq('the text comes back', first.text, 'hello from the cloud');
    eq('charged what the provider billed', first.seconds, 4.5);
    eq('with the running total', [first.cloud.hoursUsed, first.cloud.hoursCap], [0, 10]);
    eq('the upstream saw the server key, not the session', upstreamCalls[0].auth, 'Bearer sk-test');
    eq('the configured model', upstreamCalls[0].model, 'test/model');
    eq('the whole clip', upstreamCalls[0].bytes, wav(5).length);
    eq('the language', upstreamCalls[0].language, 'en');
    eq('and the dictionary as phrase hints', upstreamCalls[0].phrases, ['Kharagpur', 'Voxden']);
    eq('usage is recorded on the account', store.usageSeconds(user.id, periodOf(clock)), 5);

    // Metering is from the header, checked before the call.
    store.addUsageSeconds(user.id, periodOf(clock), 10 * 3600 - 6);
    await assert.rejects(() => client.transcribe(wav(10), { audioSeconds: 10 }), (err) => err.code === 'cap' && /used up/.test(err.message));
    ok('a clip that would cross the cap is refused before any upstream call', upstreamCalls.length === 1);
    const meAfterCap = await (await fetch(base + '/me', { headers: { Authorization: 'Bearer ' + token } })).json();
    eq('/me shows the hours', meAfterCap.account.cloud.hoursUsed, 10);
    clock = Date.parse('2026-10-01T00:00:01Z');
    const nextMonth = await client.transcribe(wav(2), { audioSeconds: 2 });
    eq('a new month starts the count again', nextMonth.cloud.hoursUsed, 0);

    // Failures carry codes the app can act on.
    upstreamMode = 'fail';
    await assert.rejects(() => client.transcribe(wav(2), { audioSeconds: 2 }), (err) => err.code === 'upstream' && /500/.test(err.message));
    ok('an upstream failure is code upstream', true);
    eq('and is not charged', store.usageSeconds(user.id, periodOf(clock)), 5);
    upstreamMode = 'hang';
    await assert.rejects(() => client.transcribe(wav(2), { audioSeconds: 2 }), (err) => err.code === 'timeout');
    ok('a hung upstream is code timeout', true);
    upstreamMode = 'ok';
    await assert.rejects(() => client.transcribe(wav(2), { audioSeconds: 2, timeoutMs: 1 }), (err) => err.code === 'timeout');
    ok('the client budget is its own', true);
    token = 'x'.repeat(43);
    await assert.rejects(() => client.transcribe(wav(2), { audioSeconds: 2 }), (err) => err.code === 'auth');
    ok('a dead session is code auth', true);
    token = '';
    await assert.rejects(() => client.transcribe(wav(2), { audioSeconds: 2 }), (err) => err.code === 'auth');
    ok('no session never leaves the PC', true);
    token = tokenFor('pro@example.com');

    // Bad input.
    const bad = await fetch(base + '/transcribe', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ audio: Buffer.from('nope').toString('base64'), format: 'wav' }) });
    eq('junk audio is 400', bad.status, 400);
    const long = await fetch(base + '/transcribe', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ audio: wav(301).toString('base64'), format: 'wav' }) });
    eq('a clip over five minutes is 413', long.status, 413);

    // No key configured.
    const bare = createApp({ store, mailer: { sendCode: async () => {} }, now: () => clock });
    const bareServer = http.createServer(bare.handle);
    await new Promise((r) => bareServer.listen(0, '127.0.0.1', r));
    const bareClient = new CloudTranscriber({ baseUrl: 'http://127.0.0.1:' + bareServer.address().port + '/v1', token: () => token });
    await assert.rejects(() => bareClient.transcribe(wav(2), { audioSeconds: 2 }), (err) => err.code === 'unconfigured' && err.status === 503);
    ok('a service with no model key says so', true);
    bareServer.close();
  } finally {
    server.close();
    upstream.closeAllConnections();
    upstream.close();
    store.close();
  }
  process.stdout.write('all ' + checks + ' cloud relay checks passed\n');
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
