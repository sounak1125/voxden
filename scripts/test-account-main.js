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
const { createCloudTranscriber } = require('../server/cloud');

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
  let upstream = null;
  let cloudServer = null;
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

    // --- the cloud path through main's own transcribe handler -------------
    // A stand-in speech model behind the relay; main's cloud client is given
    // the real fetch and the local base URL the same way the account was.
    upstream = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ text: 'cloud heard this', usage: { seconds: 3 } }));
      });
    });
    await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
    const cloudApp = createApp({ store, mailer: { sendCode: async (m) => { sent.push(m); } },
      cloud: createCloudTranscriber({ apiKey: 'sk-test', upstreamUrl: 'http://127.0.0.1:' + upstream.address().port + '/t' }) });
    cloudServer = http.createServer(cloudApp.handle);
    await new Promise((r) => cloudServer.listen(0, '127.0.0.1', r));
    const cloudBase = 'http://127.0.0.1:' + cloudServer.address().port + '/v1';
    h.run('accountManager.baseUrl = ' + JSON.stringify(cloudBase) + '; cloudTranscriber.baseUrl = accountManager.baseUrl; cloudTranscriber.fetch = testFetch;');
    await call('account-code', 'person@example.com');
    await call('account-verify', '', sent[1].code);
    const clip = (() => {
      const data = Buffer.alloc(16000 * 2 * 3);
      const hdr = Buffer.alloc(44);
      hdr.write('RIFF', 0); hdr.writeUInt32LE(36 + data.length, 4); hdr.write('WAVE', 8); hdr.write('fmt ', 12);
      hdr.writeUInt32LE(16, 16); hdr.writeUInt16LE(1, 20); hdr.writeUInt16LE(1, 22); hdr.writeUInt32LE(16000, 24);
      hdr.writeUInt32LE(32000, 28); hdr.writeUInt16LE(2, 32); hdr.writeUInt16LE(16, 34); hdr.write('data', 36); hdr.writeUInt32LE(data.length, 40);
      return Buffer.concat([hdr, data]);
    })();
    h.run("settings.cloudTranscription = true; settings.dictationLanguage = 'en';");
    const text = await h.handlers.get('transcribe-local')(null, clip, { park: false });
    eq('a Pro user with cloud on gets the cloud transcript', text, 'cloud heard this');
    eq('and the report names the engine', [h.run('lastAsrReport.engine'), h.run('lastVocabularyReport.engine')], ['cloud', 'cloud']);
    eq('and the status card knows', [h.run('cloudStatus.lastResult'), h.run('cloudStatus.count')], ['cloud', 1]);
    eq('and the cached account carries the metered hours', h.run('accountManager.snapshot().cloud.hoursUsed'), 0);
    h.run("settings.cloudTranscription = false;");
    eq('with cloud off the decision is null before any request', await h.run('tryCloudTranscribe(Buffer.alloc(44), {}, 3)'), null);
    h.run("settings.cloudTranscription = true;");
    store.setPlan('person@example.com', 'free', null);
    await call('account-refresh');
    eq('a Free account is skipped and the reason kept', [await h.run('tryCloudTranscribe(Buffer.alloc(44), {}, 3)'), h.run('cloudStatus.lastError')], [null, 'plan']);
    h.run('accountManager.baseUrl = ' + JSON.stringify(base) + ';');

    const out = await call('account-sign-out');
    eq('sign-out clears the snapshot', [out.account.signedIn, out.account.email], [false, '']);
    eq('and the file', 'tokenPlain' in JSON.parse(fs.readFileSync(file, 'utf8')), false);
  } finally {
    await h.close();
    for (const s of [server, cloudServer, upstream]) {
      if (!s) continue;
      if (typeof s.closeAllConnections === 'function') s.closeAllConnections();
      s.close();
    }
    store.close();
  }
  process.stdout.write('all ' + checks + ' account main-process checks passed\n');
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
