'use strict';

// A cloud request that goes quiet or hiccups is sent once more before the
// dictation is allowed to fail (src/main.js, tryCloudTranscribe). The provider
// sometimes never answers one request while the next, for the same audio,
// answers in a second or two; one such piece of a long dictation used to fail
// all of it. This drives main.js in the harness, first with a scripted client
// (every code and status the rule decides on), then through the real relay and
// the real client, with only the speech model stubbed.

const assert = require('assert');
const crypto = require('crypto');
const http = require('http');
const harness = require('./asr-test-harness');
const { createStore } = require('../server/store');
const { createApp, dayOf, creditMonthOf } = require('../server/app');

let checks = 0;
function eq(label, actual, expected) {
  assert.deepStrictEqual(actual, expected, label + '\n  got: ' + JSON.stringify(actual));
  checks += 1;
  process.stdout.write('ok ' + label + '\n');
}

function wavClip(seconds) {
  const data = Buffer.alloc(16000 * 2 * seconds);
  const hdr = Buffer.alloc(44);
  hdr.write('RIFF', 0); hdr.writeUInt32LE(36 + data.length, 4); hdr.write('WAVE', 8); hdr.write('fmt ', 12);
  hdr.writeUInt32LE(16, 16); hdr.writeUInt16LE(1, 20); hdr.writeUInt16LE(1, 22); hdr.writeUInt32LE(16000, 24);
  hdr.writeUInt32LE(32000, 28); hdr.writeUInt16LE(2, 32); hdr.writeUInt16LE(16, 34); hdr.write('data', 36); hdr.writeUInt32LE(data.length, 40);
  return Buffer.concat([hdr, data]);
}

const failure = (code, message, status) => async () => {
  throw Object.assign(new Error(message), status ? { code, status } : { code });
};
const answer = (text) => async () => ({
  text, seconds: 3, ms: 800, cloud: null, timing: { relayMs: 600, hedged: false, retried: false },
});

async function main() {
  const h = harness();
  const calls = [];
  const diags = [];
  const overlays = [];
  let steps = [];
  let busyStarts = 0;
  let localRuns = 0;
  let store = null;
  let server = null;
  try {
    // --- stand-ins inside main.js ---------------------------------------------
    h.context.fakeTranscribe = async (wav, options) => {
      const step = steps[calls.length];
      calls.push({ wav, language: options.language, terms: JSON.stringify(options.terms), inFlight: h.run('cloudRequestsInFlight') });
      if (!step) throw Object.assign(new Error('unexpected extra cloud call'), { code: 'upstream', status: 502 });
      return step(wav, options);
    };
    h.context.recordDiag = (event, fields) => { diags.push(Object.assign({ event }, fields)); };
    h.context.recordOverlay = (extra) => { overlays.push(Object.assign({}, extra)); };
    h.context.countBusyStart = () => { busyStarts += 1; };
    h.context.countLocalRun = async () => { localRuns += 1; return 'typed on this PC'; };
    h.context.account = {
      signedIn: true, plan: 'pro',
      cloud: { creditsCap: 900, creditsUsed: 0, hoursCap: 15, hoursUsed: 0 },
    };
    h.run(`accountManager.snapshot = () => account;
      accountManager.noteCloudUsage = () => {};
      var refreshes = 0;
      accountManager.refresh = async () => { refreshes++; return account; };
      cloudTranscriber.transcribe = fakeTranscribe;
      diagLog = recordDiag;
      sendOverlay = recordOverlay;
      startLocalForBusyCloud = countBusyStart;
      sidecarTranscribe = countLocalRun;
      settings.cloudTranscription = true;
      settings.dictationLanguage = 'en';`);
    const clip = wavClip(3);

    function reset(nextSteps, nextMode) {
      steps = nextSteps;
      calls.length = 0; diags.length = 0; overlays.length = 0;
      busyStarts = 0; localRuns = 0;
      h.run(`mode = ${JSON.stringify(nextMode || 'transcribing')};
        cloudStatus = { lastResult: '', lastError: '', lastAt: 0, lastMs: 0, count: 0 };
        refreshes = 0;`);
    }
    const inFlight = () => h.run('cloudRequestsInFlight');
    const failedDiags = () => diags.filter((d) => d.event === 'cloud-request-failed');
    const okDiags = () => diags.filter((d) => d.event === 'cloud-request');
    const SLOW = [{ mode: 'transcribing', text: 'Cloud is slow. Trying again…' }];
    // Resolves to the error a rejected call carried, or null.
    const settle = (promise) => promise.then(() => null, (err) => err);

    eq('nothing is in flight to begin with', inFlight(), 0);

    // --- a timeout, then success --------------------------------------------
    reset([failure('timeout', 'Cloud transcription timed out.'), answer('rescued words')]);
    eq('a timed out request is sent again and the second answer is the text',
      await h.run('tryCloudTranscribe(Buffer.alloc(44), { segment: false }, 3)'), 'rescued words');
    eq('two requests were made, one at a time (never two in flight)', [calls.length, calls.map((c) => c.inFlight)], [2, [1, 1]]);
    eq('the retry carries the same audio, language and terms',
      [calls[1].wav === calls[0].wav, calls[1].language === calls[0].language, calls[1].terms === calls[0].terms], [true, true, true]);
    eq('the failed request is in the diagnostics log: no audio, no text',
      failedDiags().map((d) => Object.assign({}, d, { elapsedMs: typeof d.elapsedMs })),
      [{ event: 'cloud-request-failed', audioMs: 3000, code: 'timeout', elapsedMs: 'number', attempt: 1, segment: false }]);
    eq('then the normal request line, marked rescued on its second attempt',
      okDiags().map((d) => [d.rescued, d.attempt, d.audioMs, d.roundTripMs, d.relayMs]), [[true, 2, 3000, 800, 600]]);
    eq('the order was failure, then rescue', diags.map((d) => d.event), ['cloud-request-failed', 'cloud-request']);
    eq('the bar said so while the user was waiting', overlays, SLOW);
    eq('the status card is a plain success afterwards',
      [h.run('cloudStatus.lastResult'), h.run('cloudStatus.lastError'), h.run('cloudStatus.count')], ['cloud', '', 1]);
    eq('and nothing is left in flight', inFlight(), 0);

    reset([failure('timeout', 'Cloud transcription timed out.'), answer('rescued while talking')], 'recording');
    eq('a piece retried while the user is still recording succeeds the same way',
      await h.run('tryCloudTranscribe(Buffer.alloc(44), { segment: true }, 4)'), 'rescued while talking');
    eq('but the bar is left alone while they talk', overlays, []);
    eq('and the log says it was a phrase request', failedDiags().map((d) => d.segment), [true]);
    eq('the phrase route is reported', h.run('lastAsrReport.routed'), 'cloud-segments');
    eq('nothing in flight again', inFlight(), 0);

    // --- a timeout twice ------------------------------------------------------
    reset([failure('timeout', 'Cloud transcription timed out.'), failure('timeout', 'Cloud transcription timed out.')]);
    const twice = await settle(h.run('tryCloudTranscribe(Buffer.alloc(44), {}, 3)'));
    eq('a second timeout fails the request with the same coded error', [twice && twice.code, twice && twice.message], ['timeout', 'Cloud transcription timed out.']);
    eq('after exactly two requests', calls.length, 2);
    eq('both are in the diagnostics log, attempts 1 and 2', failedDiags().map((d) => [d.attempt, d.code]), [[1, 'timeout'], [2, 'timeout']]);
    eq('with no success line', okDiags(), []);
    eq('the bar was told once, on the first failure only', overlays, SLOW);
    eq('the status card keeps the real reason', [h.run('cloudStatus.lastResult'), h.run('cloudStatus.lastError')], ['error', 'timeout']);
    h.context.wrappedTimeout = "Error invoking remote method 'transcribe-local': Error: " + twice.message;
    eq('and the user sees the same friendly message as before', h.run('friendlyEngineError(wrappedTimeout)'), 'Voxden Cloud timed out — try again');
    eq('nothing in flight', inFlight(), 0);

    // The relay's own 20 s deadline is a 502 with code `timeout`; the second
    // attempt failing differently still ends with the second error.
    reset([failure('timeout', 'The speech model did not answer in time.', 502), failure('timeout', 'The speech model did not answer in time.', 502)]);
    const relayTwice = await settle(h.run('tryCloudTranscribe(Buffer.alloc(44), {}, 3)'));
    h.context.wrappedRelayTimeout = "Error invoking remote method 'transcribe-local': Error: " + relayTwice.message;
    eq('a relay deadline twice: two requests, the friendly message unchanged',
      [calls.length, failedDiags().map((d) => [d.attempt, d.status]), h.run('friendlyEngineError(wrappedRelayTimeout)')],
      [2, [[1, 502], [2, 502]], 'Voxden Cloud timed out — try again']);
    reset([failure('timeout', 'Cloud transcription timed out.'), failure('network', 'Cloud transcription could not be reached.')]);
    const different = await settle(h.run('tryCloudTranscribe(Buffer.alloc(44), {}, 3)'));
    eq('if the retry fails another way, that error is the one thrown', [different && different.code, calls.length], ['network', 2]);
    eq('nothing in flight', inFlight(), 0);

    // --- failures that are worth another request ------------------------------
    for (const [label, first] of [
      ['a network failure', failure('network', 'Cloud transcription could not be reached.')],
      ['a relay deadline (502, code timeout)', failure('timeout', 'The speech model did not answer in time.', 502)],
      ['the provider answering 503 behind the relay', failure('upstream', 'The speech model returned 503: Service Unavailable.', 502)],
      ['the provider answering 500 behind the relay', failure('upstream', 'The speech model returned 500.', 502)],
      ['the provider answering 504 behind the relay', failure('upstream', 'The speech model returned 504.', 502)],
      ['the provider answering 502 behind the relay', failure('upstream', 'The speech model returned 502.', 502)],
      ['the provider not reachable from the relay', failure('upstream', 'The speech model could not be reached.', 502)],
      ['a bare relay 502', failure('upstream', 'The speech model failed.', 502)],
      ['a relay 503', failure('upstream', 'Cloud transcription returned 503.', 503)],
      ['a relay 504', failure('upstream', 'Cloud transcription returned 504.', 504)],
      ['a relay 500', failure('upstream', 'Something went wrong on our side. Try again in a minute.', 500)],
    ]) {
      reset([first, answer('second try')]);
      const text = await h.run('tryCloudTranscribe(Buffer.alloc(44), {}, 3)');
      eq(label + ' is retried and rescued', [text, calls.length, okDiags().map((d) => d.rescued), inFlight()], ['second try', 2, [true], 0]);
    }

    // --- failures that must not be retried ------------------------------------
    for (const [label, step, code] of [
      ['a cancelled dictation', failure('cancelled', 'Dictation cancelled.'), 'cancelled'],
      ['a sign-in problem', failure('auth', 'Not signed in.'), 'auth'],
      ['a relay that rejects the session (401)', failure('auth', 'Sign in again.', 401), 'auth'],
      ['a plan that is not Pro', failure('plan', 'Cloud transcription needs a Pro plan.', 402), 'plan'],
      ['hours used up', failure('cap', 'Your cloud credits are used up.', 402), 'cap'],
      ['the free trial used up', failure('trial_used', 'Your free Voxden Cloud minutes are used up.', 402), 'trial_used'],
      ['a relay that is not configured (503)', failure('unconfigured', 'Cloud transcription is not available right now.', 503), 'unconfigured'],
      ['the relay cap on requests at once (429, busy)', failure('busy', 'Too many cloud requests at once. Wait for the last one to finish.', 429), 'busy'],
      ['a bad request (400)', failure('upstream', 'Send base64 WAV audio.', 400), 'upstream'],
      ['a refused request (403)', failure('upstream', 'Forbidden.', 403), 'upstream'],
      ['a clip that is too big (413)', failure('upstream', 'Clips over five minutes are not accepted.', 413), 'upstream'],
      ['a bare 429 from the relay', failure('upstream', 'Cloud transcription returned 429.', 429), 'upstream'],
      ['the provider refusing the clip (400 behind the relay)', failure('upstream', 'The speech model returned 400: Invalid audio.', 502), 'upstream'],
      ['the provider refusing the key (403 behind the relay)', failure('upstream', 'The speech model returned 403.', 502), 'upstream'],
      ['a failure that names no status at all', failure('upstream', 'Something odd.'), 'upstream'],
    ]) {
      reset([step, answer('must never be asked for')]);
      const err = await settle(h.run('tryCloudTranscribe(Buffer.alloc(44), {}, 3)'));
      eq(label + ' is not retried: one request, the original error', [err && err.code, calls.length, failedDiags().length, okDiags().length, overlays, inFlight()], [code, 1, 1, 0, [], 0]);
    }
    reset([failure('cap', 'Your cloud credits are used up.', 402)]);
    await settle(h.run('tryCloudTranscribe(Buffer.alloc(44), {}, 3)'));
    eq('a cap failure still refreshes the real meter, once', h.run('refreshes'), 1);

    // The dictation went away while the first request was out.
    reset([async () => { h.run('advanceRecordingSession()'); throw Object.assign(new Error('Cloud transcription timed out.'), { code: 'timeout' }); }, answer('too late')]);
    const gone = await settle(h.run('tryCloudTranscribe(Buffer.alloc(44), {}, 3)'));
    eq('a dictation that was replaced mid-request is not retried', [gone && gone.code, calls.length, overlays, inFlight()], ['timeout', 1, [], 0]);
    eq('though the failure is still logged', failedDiags().map((d) => d.attempt), [1]);

    // Same token, but the session's cancel signal has fired.
    reset([async () => { h.run('cloudSessionAbort.abort()'); throw Object.assign(new Error('Cloud transcription could not be reached.'), { code: 'network' }); }, answer('too late')]);
    const aborted = await settle(h.run('tryCloudTranscribe(Buffer.alloc(44), {}, 3)'));
    eq('a fired session abort signal is not retried either', [aborted && aborted.code, calls.length, overlays, inFlight()], ['network', 1, [], 0]);
    h.run('advanceRecordingSession()');

    // The retry itself is replaced mid-flight: the answer is still handed back
    // (the caller discards it), and the reports of the new dictation are untouched.
    reset([failure('timeout', 'Cloud transcription timed out.'), async () => {
      h.run('advanceRecordingSession(); cloudStatus = { lastResult: "other", lastError: "", lastAt: 1, lastMs: 2, count: 9 };');
      return { text: 'stale', seconds: 3, ms: 5, cloud: null, timing: null };
    }]);
    eq('a retry that lands after the dictation was replaced returns its text',
      await h.run('tryCloudTranscribe(Buffer.alloc(44), {}, 3)'), 'stale');
    eq('and leaves the new dictation status alone', h.run('cloudStatus.lastResult'), 'other');
    eq('with the counter balanced', inFlight(), 0);

    // --- through main's transcribe handler: the busy provider keeps its fallback
    const transcribeLocal = h.handlers.get('transcribe-local');
    reset([failure('upstream', 'The speech model returned 429: Provider busy.', 502), answer('must never be asked for')]);
    eq('a busy provider (429 behind the relay) still ends on the local engine',
      await transcribeLocal(null, clip, { park: false }), 'typed on this PC');
    eq('after one cloud request, no retry', [calls.length, busyStarts, localRuns, failedDiags().length, overlays], [1, 1, 1, 1, []]);
    eq('with the counter balanced', inFlight(), 0);

    reset([failure('timeout', 'The speech model did not answer in time.', 502), answer('through the handler')]);
    eq('the handler returns a rescued piece as an ordinary answer', await transcribeLocal(null, clip, { park: false, segment: true }), 'through the handler');
    eq('without touching the local engine', [calls.length, busyStarts, localRuns, overlays], [2, 0, 0, SLOW]);

    reset([failure('timeout', 'The speech model did not answer in time.', 502), failure('timeout', 'The speech model did not answer in time.', 502)]);
    const handlerErr = await settle(transcribeLocal(null, clip, { park: false }));
    eq('twice stuck, the handler fails with the relay timeout and no local fallback', [handlerErr && handlerErr.code, calls.length, localRuns], ['timeout', 2, 0]);
    eq('with the counter balanced', inFlight(), 0);

    // --- the real client, the real relay --------------------------------------
    store = createStore(':memory:');
    const now = Date.now();
    const stamp = new Date(now).toISOString();
    const user = store.findOrCreateUser('rescue@example.test', stamp);
    store.setPlan('rescue@example.test', 'pro', new Date(now + 86400000).toISOString());
    const token = 'test-rescue-session-token';
    store.createSession({ tokenHash: crypto.createHash('sha256').update(token).digest('hex'), userId: user.id, device: 'test', createdAt: stamp });
    let modelCalls = 0;
    let modelStep = [];
    const model = {
      configured: true,
      transcribe: async () => {
        const step = modelStep[modelCalls++];
        if (!step) throw Object.assign(new Error('unexpected extra model call'), { code: 'upstream', status: 500 });
        return step();
      },
    };
    const relay = createApp({ store, mailer: { sendCode: async () => {} }, now: () => now, cloud: model });
    server = http.createServer(relay.handle);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    h.context.liveFetch = (url, init) => fetch(url, init);
    // Deleting the scripted own property brings back the real class method.
    h.run(`cloudTranscriber.baseUrl = ${JSON.stringify('http://127.0.0.1:' + server.address().port + '/v1')};
      cloudTranscriber.token = () => ${JSON.stringify(token)};
      cloudTranscriber.fetch = liveFetch;
      delete cloudTranscriber.transcribe;`);
    const month = creditMonthOf(0, now);
    const usage = () => store.usageSecondsBetween(user.id, dayOf(month.start), dayOf(month.end));
    const heard = (text) => async () => ({ text, billedSeconds: 3, cost: 0 });
    const modelFails = (message, extra) => async () => { throw Object.assign(new Error(message), extra); };

    modelCalls = 0; modelStep = [modelFails('The speech model did not answer in time.', { code: 'timeout' }), heard('from the second request')];
    reset([], 'transcribing');
    eq('a stuck model behind the real relay: the second request answers', await transcribeLocal(null, clip, { park: false, segment: true }), 'from the second request');
    eq('the relay reached the model twice', modelCalls, 2);
    eq('the failure that was logged is the relay deadline: 502, code timeout', failedDiags().map((d) => [d.code, d.status, d.attempt]), [['timeout', 502, 1]]);
    eq('and the bar said so', overlays, SLOW);
    eq('the clip was charged once: three seconds, not six', usage(), 3);
    eq('no request left in flight', inFlight(), 0);

    modelCalls = 0; modelStep = [modelFails('The speech model returned 503: Overloaded.', { code: 'upstream', status: 503 }), heard('after a 503')];
    reset([], 'recording');
    eq('a provider 503 behind the real relay is rescued', await transcribeLocal(null, clip, { park: false, segment: true }), 'after a 503');
    eq('logging both the relay status and the provider status', failedDiags().map((d) => [d.code, d.status, d.providerStatus]), [['upstream', 502, 503]]);
    eq('charged once more, three seconds', usage(), 6);

    modelCalls = 0; modelStep = [modelFails('The speech model returned 400: Invalid audio.', { code: 'upstream', status: 400 }), heard('must never be asked for')];
    reset([], 'transcribing');
    const refused = await settle(transcribeLocal(null, clip, { park: false }));
    eq('a provider 400 behind the real relay is not retried',
      [refused && refused.code, modelCalls, failedDiags().map((d) => d.providerStatus), usage()], ['upstream', 1, [400], 6]);

    modelCalls = 0; modelStep = [modelFails('The speech model returned 429: Provider busy.', { code: 'upstream', status: 429 }), heard('must never be asked for')];
    reset([], 'transcribing');
    eq('a provider 429 behind the real relay goes to the local engine, as before',
      await transcribeLocal(null, clip, { park: false }), 'typed on this PC');
    eq('after one model request and no retry', [modelCalls, busyStarts, localRuns, overlays], [1, 1, 1, []]);

    modelCalls = 0; modelStep = [modelFails('The speech model did not answer in time.', { code: 'timeout' }), modelFails('The speech model did not answer in time.', { code: 'timeout' })];
    reset([], 'transcribing');
    const stuck = await settle(transcribeLocal(null, clip, { park: false }));
    h.context.wrappedStuck = "Error invoking remote method 'transcribe-local': Error: " + stuck.message;
    eq('stuck twice behind the real relay: the user-facing message is unchanged',
      [modelCalls, stuck.code, h.run('friendlyEngineError(wrappedStuck)'), usage(), inFlight()], [2, 'timeout', 'Voxden Cloud timed out — try again', 6, 0]);
  } finally {
    await h.close();
    if (server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
    if (store) store.close();
  }
  process.stdout.write('all ' + checks + ' cloud rescue checks passed\n');
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
