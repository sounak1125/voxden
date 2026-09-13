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
  let upstreamFailure = false;
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

    // --- feedback -----------------------------------------------------------
    const sentReport = await call('feedback-send', { kind: 'bug', message: '  Paste landed twice.\n', includeDetails: true });
    eq('a report reaches the service', [sentReport.ok, sentReport.error], [true, undefined]);
    const storedReport = store.recentFeedback(1)[0];
    eq('it is stored against the signed-in account', [storedReport.email, storedReport.kind, storedReport.message],
      ['person@example.com', 'bug', 'Paste landed twice.']);
    eq('with the app details attached', /^version: /.test(storedReport.diagnostics) && /plan: free/.test(storedReport.diagnostics), true);
    const refusedReport = await call('feedback-send', { kind: 'bug', message: '   ' });
    eq('an empty report is refused before any request', [refusedReport.ok, refusedReport.error], [false, 'Write a few words first.']);
    h.run('accountManager.baseUrl = "http://127.0.0.1:1";');
    const offlineReport = await call('feedback-send', { kind: 'idea', message: 'Dark icons' });
    eq('an unreachable service offers the GitHub fallback', [offlineReport.ok, offlineReport.fallback, typeof offlineReport.error], [false, true, 'string']);
    h.run('accountManager.baseUrl = ' + JSON.stringify(base) + ';');

    store.setPlan('person@example.com', 'pro', '2027-01-01T00:00:00.000Z');
    const refreshed = await call('account-refresh');
    eq('a refresh picks up a granted plan', [refreshed.account.plan, refreshed.account.cloud.hoursCap, refreshed.account.cloud.creditsCap], ['pro', 20, 1200]);

    // --- Google sign-in through main --------------------------------------------
    const noGoogle = await call('account-google');
    eq('without Google on the service, the app is told to use email', noGoogle.account.lastError, 'Google sign-in is not set up on this service yet. Use your email instead.');
    const gExchanges = [];
    const gToken = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        gExchanges.push(Object.fromEntries(new URLSearchParams(raw)));
        const claims = { iss: 'https://accounts.google.com', aud: 'cid', exp: Math.floor(Date.now() / 1000) + 3600, email: 'G.User@Example.com', email_verified: true };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id_token: 'h.' + Buffer.from(JSON.stringify(claims)).toString('base64url') + '.s' }));
      });
    });
    await new Promise((r) => gToken.listen(0, '127.0.0.1', r));
    const gApp = createApp({ store, mailer: { sendCode: async () => {} },
      google: { clientId: 'cid', clientSecret: 's', tokenUrl: 'http://127.0.0.1:' + gToken.address().port + '/token' } });
    const gServer = http.createServer(gApp.handle);
    await new Promise((r) => gServer.listen(0, '127.0.0.1', r));
    await call('account-sign-out');
    eq('signed out, the app is gated', (await call('account-refresh')).signInRequired, true);
    h.run('accountManager.baseUrl = ' + JSON.stringify('http://127.0.0.1:' + gServer.address().port + '/v1') + '; accountManager.auth = null;');
    h.run("googleAuth.signIn = () => ({ promise: Promise.resolve({ code: '4/x', codeVerifier: 'v'.repeat(43), redirectUri: 'http://127.0.0.1:4567/' }), cancel() {} });");
    const viaGoogle = await call('account-google');
    eq('a Google grant signs main in as the verified address and lifts the gate',
      [viaGoogle.account.signedIn, viaGoogle.account.email, viaGoogle.account.busy, viaGoogle.signInRequired], [true, 'g.user@example.com', '', false]);
    eq('the service exchanged the code with the verifier', [gExchanges[0].code, gExchanges[0].code_verifier], ['4/x', 'v'.repeat(43)]);
    await call('account-sign-out');
    h.run('accountManager.baseUrl = ' + JSON.stringify(base) + '; accountManager.auth = null;');
    await call('account-code', 'person@example.com');
    await call('account-verify', '', sent.at(-1).code);
    eq('back on the emailed code, signed in again for the rest', (await call('account-refresh')).account.email, 'person@example.com');

    // --- profile and deletion through main ---------------------------------------
    const namedMain = await call('account-update-profile', { firstName: 'Per', lastName: 'Son' });
    eq('a profile update comes back in the snapshot', [namedMain.account.profile.firstName, namedMain.account.profile.lastName], ['Per', 'Son']);
    eq('and the greeting name follows the first name', [h.run('settings.displayName'), namedMain.displayName], ['Per', 'Per']);
    const planBefore = store.userByEmail('person@example.com');
    const deleted = await call('account-delete');
    eq('deleting the account signs main out and gates the app', [deleted.account.signedIn, deleted.signInRequired, deleted.account.lastError], [false, true, '']);
    eq('the service no longer knows the address', store.userByEmail('person@example.com'), null);
    await call('account-code', 'person@example.com');
    await call('account-verify', '', sent.at(-1).code);
    eq('a fresh sign-in makes a fresh account for the rest', (await call('account-refresh')).account.profile.firstName, '');
    // The cloud tests below expect the plan this account had before it was deleted.
    store.setPlan('person@example.com', planBefore.plan, planBefore.plan_expires_at);
    await call('account-refresh');
    gServer.close();
    gToken.close();

    // --- the cloud path through main's own transcribe handler -------------
    // A stand-in speech model behind the relay; main's cloud client is given
    // the real fetch and the local base URL the same way the account was.
    upstream = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        res.writeHead(upstreamFailure ? 503 : 200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(upstreamFailure
          ? { error: { message: 'Synthetic model outage' } }
          : { text: 'cloud heard this', usage: { seconds: 3 } }));
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
    // Observe only this harness's fs wrapper, leaving Node's shared fs alone.
    // Cloud audio stays in memory; a local engine would write a temporary WAV.
    h.context.cloudTempWrites = [];
    h.context.originalWriteFile = fs.promises.writeFile;
    h.run(`Object.defineProperty(fs, 'promises', {
      value: Object.assign({}, fs.promises, { writeFile: (...args) => {
        cloudTempWrites.push(String(args[0]));
        return originalWriteFile(...args);
      } }), configurable: true,
    });
    var localSidecarCalls = 0;
    sidecarTranscribe = async () => { localSidecarCalls++; return 'local transcript'; };`);
    const text = await h.handlers.get('transcribe-local')(null, clip, { park: false });
    eq('a Pro user with cloud on gets the cloud transcript', text, 'cloud heard this');
    eq('and the report names the engine', [h.run('lastAsrReport.engine'), h.run('lastVocabularyReport.engine')], ['cloud', 'cloud']);
    eq('and the status card knows', [h.run('cloudStatus.lastResult'), h.run('cloudStatus.count')], ['cloud', 1]);
    eq('and the cached account carries the metered hours', h.run('accountManager.snapshot().cloud.hoursUsed'), 0);
    eq('successful cloud audio needs no temporary WAV write', h.context.cloudTempWrites, []);
    eq('successful cloud audio never calls a local sidecar', h.run('localSidecarCalls'), 0);

    const segment = await h.handlers.get('transcribe-local')(null, clip, { park: false, cloud: true, segment: true });
    eq('a phrase request gets its transcript through the same cloud relay', segment, 'cloud heard this');
    eq('phrase diagnostics retain the during-recording route',
      [h.run('lastAsrReport.routed'), h.run('lastVocabularyReport.device'), h.run('cloudStatus.lastResult')],
      ['cloud-segments', 'cloud-segments', 'cloud-segments']);

    upstreamFailure = true;
    await assert.rejects(h.handlers.get('transcribe-local')(null, clip, { park: false }),
      err => err.code === 'upstream' && /Synthetic model outage/.test(err.message));
    eq('a selected cloud failure reports the actual error',
      [h.run('cloudStatus.lastResult'), h.run('cloudStatus.lastError')], ['error', 'upstream']);
    eq('a selected cloud failure never falls through to the local sidecar', h.run('localSidecarCalls'), 0);
    eq('cloud success, segments, and failure never write a local-engine WAV', h.context.cloudTempWrites, []);
    upstreamFailure = false;

    // invoke() wraps main's error before the renderer reports capture-failed.
    // Exercise a real CloudTranscriber network failure through that message
    // shape, so its useful cause survives the HUD's short-message limit.
    h.context.disconnectedCloudFetch = async () => { throw new TypeError('fetch failed'); };
    h.run('var originalCloudFetch = cloudTranscriber.fetch; cloudTranscriber.fetch = disconnectedCloudFetch;');
    let networkError;
    try { await h.handlers.get('transcribe-local')(null, clip, { park: false }); }
    catch (err) { networkError = err; }
    eq('a disconnected relay is still a coded network failure', networkError && networkError.code, 'network');
    h.context.wrappedNetworkError = "Error invoking remote method 'transcribe-local': Error: " + networkError.message;
    eq('the HUD keeps an actionable network reason across Electron IPC',
      h.run('friendlyEngineError(wrappedNetworkError)'), 'Voxden Cloud unreachable — check connection and retry');
    h.run('cloudTranscriber.fetch = originalCloudFetch;');
    for (const [label, message, expected] of [
      ['cloud timeout', "Error invoking remote method 'transcribe-local': Error: Cloud transcription timed out.", 'Voxden Cloud timed out — try again'],
      ['unavailable cloud', "Error invoking remote method 'transcribe-local': Error: Voxden Cloud transcription is unavailable. Check Cloud settings and try again.", 'Voxden Cloud unavailable — check Cloud settings'],
      ['local timeout', "Error invoking remote method 'transcribe-local': Error: speech engine timeout", 'Transcription timed out'],
      ['microphone failure', 'Microphone unavailable — check your input device', 'Microphone unavailable — check your input device'],
      ['unknown long error', 'An unrecognized backend error with a very long internal diagnostic that does not belong on the HUD.', 'Transcribe failed'],
    ]) {
      h.context.testEngineError = message;
      eq('friendly errors preserve ' + label + ' behavior', h.run('friendlyEngineError(testEngineError)'), expected);
    }

    // A cancelled dictation can finish after its replacement has started.
    // Its result must not relabel the replacement's timing or provider status.
    h.run(`var originalCloudTranscribe = cloudTranscriber.transcribe;
      var finishStaleCloud;
      cloudTranscriber.transcribe = () => new Promise(resolve => { finishStaleCloud = resolve; });`);
    const stale = h.handlers.get('transcribe-local')(null, clip, { park: false, segment: true });
    h.context.currentReport = { engine: 'cloud', device: 'current-session', modelRecognitionMs: 12 };
    h.context.currentVocabularyReport = { engine: 'cloud', summary: 'current session' };
    h.context.currentCloudStatus = { lastResult: 'cloud', lastMs: 12, count: 9 };
    h.run(`recordingSessionToken++;
      lastAsrReport = currentReport;
      lastVocabularyReport = currentVocabularyReport;
      cloudStatus = currentCloudStatus;
      finishStaleCloud({ text: 'late cancelled transcript', ms: 999 });`);
    await stale;
    eq('late cancelled cloud results preserve the current recognition report', h.run('lastAsrReport'), h.context.currentReport);
    eq('late cancelled cloud results preserve the current vocabulary report', h.run('lastVocabularyReport'), h.context.currentVocabularyReport);
    eq('late cancelled cloud results preserve the current cloud status', h.run('cloudStatus'), h.context.currentCloudStatus);
    h.run('cloudTranscriber.transcribe = originalCloudTranscribe;');

    h.run("settings.cloudTranscription = false;");
    eq('with cloud off the decision is null before any request', await h.run('tryCloudTranscribe(Buffer.alloc(44), {}, 3)'), null);
    h.run("settings.cloudTranscription = true;");
    store.setPlan('person@example.com', 'free', null);
    await call('account-refresh');
    eq('a Free account is skipped and the reason kept', [await h.run('tryCloudTranscribe(Buffer.alloc(44), {}, 3)'), h.run('cloudStatus.lastError')], [null, 'plan']);
    await assert.rejects(h.handlers.get('transcribe-local')(null, clip, { park: false }), /Voxden Cloud transcription is unavailable/);
    eq('unavailable selected cloud does not silently use a local engine', h.run('localSidecarCalls'), 0);
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
