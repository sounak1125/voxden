'use strict';

// Lanes, the desktop half (src/main.js, src/cloud.js). When the relay
// advertises lanes for the account (account.cloud.dictation), a piece cut while
// the user talks goes up on the body lane, the last piece and anything sent
// after stop on the tail lane, and at stop the relay is asked to hurry the
// body pieces still out. Without the advertisement every request is exactly
// what 2.1.10 sent. main.js runs in the harness with a scripted client; the
// client itself runs against a fake fetch. Nothing here reaches the network.
// The overlay's half (tail first, release at stop, never on cancel) is in
// test-cloud-recording.js.

const assert = require('assert');
const harness = require('./asr-test-harness');
const { CloudTranscriber } = require('../src/cloud');

let checks = 0;
// Values made inside the harness come from another realm; compare them as plain data.
function eq(label, actual, expected) {
  actual = structuredClone(actual);
  assert.deepStrictEqual(actual, expected, label + '\n  got: ' + JSON.stringify(actual));
  checks += 1;
  process.stdout.write('ok ' + label + '\n');
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function settle() { for (let i = 0; i < 20; i++) await Promise.resolve(); }

const LANES = { lanes: true, minSegmentMs: 4000, silenceMs: 700, longSegmentMs: 45000, longSilenceMs: 300, bodyConcurrency: 4 };

async function mainChecks() {
  const h = harness();
  const calls = [];
  const diags = [];
  const hurries = [];
  const warms = [];
  const sentStates = [];
  let steps = [];
  try {
    const overlayContents = { send: (channel, payload) => { if (channel === 'state') sentStates.push(payload); } };
    h.context.overlayContents = overlayContents;
    h.context.fakeTranscribe = async (wav, options) => {
      const step = steps[calls.length];
      calls.push(Object.assign({}, options, { signal: !!options.signal }));
      if (!step) throw Object.assign(new Error('unexpected extra cloud call'), { code: 'upstream', status: 502 });
      return step(wav, options);
    };
    h.context.recordDiag = (event, fields) => { diags.push(Object.assign({ event }, fields)); };
    h.context.fakeHurry = (options) => { hurries.push(JSON.parse(JSON.stringify(options))); return new Promise(() => {}); };
    h.context.fakeWarm = (options) => { warms.push(options); return Promise.resolve(true); };
    h.context.account = {
      signedIn: true, plan: 'pro',
      cloud: { creditsCap: 900, creditsUsed: 0, hoursCap: 15, hoursUsed: 0 },
    };
    h.run(`accountManager.snapshot = () => account;
      accountManager.noteCloudUsage = () => {};
      accountManager.refresh = async () => account;
      cloudTranscriber.transcribe = fakeTranscribe;
      cloudTranscriber.hurry = fakeHurry;
      cloudTranscriber.warm = fakeWarm;
      diagLog = recordDiag;
      sendOverlay = () => {};
      settings.cloudTranscription = true;
      settings.dictationLanguage = 'en';
      overlayWin = { isDestroyed: () => false, webContents: overlayContents };`);
    const finishing = h.ipcEvents.get('cloud-finishing');
    const fromOverlay = { sender: overlayContents };
    const lanesOn = (dictation) => { h.context.account.cloud = Object.assign({}, h.context.account.cloud, { dictation }); };
    const answer = (text, timing) => async () => ({ text, seconds: 4, ms: 700, cloud: null, timing: timing || { relayMs: 500 } });
    const failure = (code) => async () => { throw Object.assign(new Error('Cloud transcription timed out.'), { code }); };
    function reset(nextSteps, nextMode) {
      steps = nextSteps;
      calls.length = 0; diags.length = 0; hurries.length = 0; warms.length = 0;
      h.run(`mode = ${JSON.stringify(nextMode || 'recording')};
        cloudStatus = { lastResult: '', lastError: '', lastAt: 0, lastMs: 0, count: 0 };`);
    }
    const send = (opts) => h.run('tryCloudTranscribe(Buffer.alloc(44), ' + JSON.stringify(opts) + ', 4)');
    const laneOf = (call) => [call.lane, call.piece];
    const okDiags = () => diags.filter((d) => d.event === 'cloud-request');
    // As a dictation starts: a new session, and its lanes decided once.
    const newRecording = () => h.run('startCloudLaneSession(advanceRecordingSession())');

    // --- the advertised settings, checked and clamped -------------------------
    const parse = (raw) => h.context.cloudDictationSettings(raw);
    eq('valid settings pass through unchanged', parse(LANES), LANES);
    eq('each size is clamped to what the segmenter and the relay take',
      parse({ lanes: true, minSegmentMs: 900, silenceMs: 50, longSegmentMs: 100, longSilenceMs: 50, bodyConcurrency: 0 }),
      { lanes: true, minSegmentMs: 1500, silenceMs: 250, longSegmentMs: 1500, longSilenceMs: 200, bodyConcurrency: 1 });
    eq('from above too',
      parse({ lanes: true, minSegmentMs: 20000, silenceMs: 5000, longSegmentMs: 90000, longSilenceMs: 5000, bodyConcurrency: 9 }),
      { lanes: true, minSegmentMs: 8000, silenceMs: 1000, longSegmentMs: 45000, longSilenceMs: 700, bodyConcurrency: 4 });
    eq('fractions are rounded, and the pool is a whole number',
      parse({ lanes: true, minSegmentMs: 2500.4, silenceMs: 300.6, longSegmentMs: 3000, longSilenceMs: 299.5, bodyConcurrency: 3.9 }),
      { lanes: true, minSegmentMs: 2500, silenceMs: 301, longSegmentMs: 3000, longSilenceMs: 300, bodyConcurrency: 3 });
    eq('the long-piece limit is never below the minimum',
      parse(Object.assign({}, LANES, { minSegmentMs: 6000, longSegmentMs: 5000 })).longSegmentMs, 6000);
    const invalid = [
      undefined, null, 'lanes', true, {}, Object.assign({}, LANES, { lanes: false }), Object.assign({}, LANES, { lanes: 'true' }),
      Object.assign({}, LANES, { minSegmentMs: undefined }), Object.assign({}, LANES, { silenceMs: '700' }),
      Object.assign({}, LANES, { longSegmentMs: NaN }), Object.assign({}, LANES, { bodyConcurrency: Infinity }),
      Object.assign({}, LANES, { longSilenceMs: null }),
    ];
    eq('anything missing or malformed means no lanes', invalid.map(parse), invalid.map(() => null));
    eq('main reads them from the account', [h.run('cloudDictationConfig()'), (lanesOn(LANES), h.run('cloudDictationConfig()'))], [null, LANES]);
    lanesOn(Object.assign({}, LANES, { bodyConcurrency: 7 }));
    eq('clamped on the way', h.run('cloudDictationConfig().bodyConcurrency'), 4);

    // --- the overlay is told ----------------------------------------------------
    {
      // The real sendOverlay (stubbed above), restored from main.js's source.
      const src = require('fs').readFileSync(require.resolve('../src/main.js'), 'utf8');
      const start = src.indexOf('\nfunction sendOverlay(extra) {');
      const end = src.indexOf('\n}\n', start) + 3;
      h.run(src.slice(start, end));
      lanesOn(LANES);
      sentStates.length = 0;
      h.run("sendOverlay({ mode: 'arming' })");
      eq('the overlay state carries the checked settings', sentStates.map((s) => s.cloudDictation), [LANES]);
      lanesOn(undefined);
      h.run("sendOverlay({ mode: 'arming' })");
      eq('and null without them', sentStates.map((s) => s.cloudDictation), [LANES, null]);
      lanesOn(LANES);
      newRecording();
      h.run("mode = 'recording'");
      lanesOn(undefined);
      h.run("sendOverlay({})");
      eq('a recording in progress keeps the settings it started with', sentStates[2].cloudDictation, LANES);
      h.run("mode = 'idle'");
      h.run("sendOverlay({})");
      eq('and the next one is told the account settings', sentStates[3].cloudDictation, null);
      h.run("settings.dictationLanguages = ['en', 'hg']");
      h.run("sendOverlay({})");
      eq('the Hindi flag follows the dictation languages', [sentStates[3].cloudHindi, typeof sentStates[4].cloudHindi], [false, 'boolean']);
      h.run("settings.dictationLanguages = ['en']");
      h.run('sendOverlay = () => {}');
    }

    // --- warm-up ----------------------------------------------------------------
    reset([]);
    await h.run('warmCloudNow()');
    lanesOn(LANES);
    await h.run('warmCloudNow()');
    eq('the warm-up asks for the body lane only when lanes are on', warms, [{ lane: '' }, { lane: 'body' }]);

    // --- no lanes: exactly 2.1.10's request --------------------------------------
    lanesOn(undefined);
    newRecording();
    reset([answer('plain'), answer('plain'), answer('plain'), answer('plain')]);
    await send({ segment: true, piece: 0, final: false });
    lanesOn(LANES);
    await send({ segment: true, piece: 1, final: false });
    newRecording();
    await send({ segment: true });
    await send({ segment: false, piece: 1, final: true });
    eq('without lanes (even advertised mid-recording), without a piece index, or for a whole clip, no lane fields are sent',
      calls.map((c) => Object.keys(c).sort()), [0, 1, 2, 3].map(() => ['audioSeconds', 'language', 'signal', 'terms']));
    eq('and the request line is unchanged', okDiags().map((d) => ['lane' in d, 'piece' in d, 'trigger' in d, 'source' in d]),
      [0, 1, 2, 3].map(() => [false, false, false, false]));
    lanesOn(LANES);
    h.run('settings.cloudTranscription = false');
    newRecording();
    h.run('settings.cloudTranscription = true');
    eq('a recording that starts with Cloud off has no lanes', h.run('cloudLaneSession.lanes'), null);

    // --- lanes: body while talking, tail for the last piece ----------------------
    lanesOn(LANES);
    newRecording();
    reset([
      answer('body words', { relayMs: 2900, lane: 'body', trigger: '', source: 'main' }),
      answer('tail words', { relayMs: 600, lane: 'tail', trigger: '', source: 'main' }),
    ]);
    await send({ segment: true, piece: 0, final: false });
    await send({ segment: true, piece: 1, final: true });
    eq('a piece cut while talking goes on the body lane, the last piece on the tail lane', calls.map(laneOf), [['body', 0], ['tail', 1]]);
    eq('both carry the recording\'s id, a random 16-hex-digit string',
      [calls[0].dictation === calls[1].dictation, /^[0-9a-f]{16}$/.test(calls[0].dictation)], [true, true]);
    eq('the request line names the lane, the piece, and what answered on the relay',
      okDiags().map((d) => [d.lane, d.piece, d.trigger, d.source]), [['body', 0, '', 'main'], ['tail', 1, '', 'main']]);
    const firstId = calls[0].dictation;
    newRecording();
    reset([answer('next')]);
    await send({ segment: true, piece: 0, final: false });
    eq('a new recording has a new id', calls[0].dictation !== firstId && /^[0-9a-f]{16}$/.test(calls[0].dictation), true);
    eq('nothing is left on the body list once answered', h.run('cloudLaneSession.body.size'), 0);

    // --- stop: hurry the body pieces still out, everything after is the tail -----
    newRecording();
    const slow = [deferred(), deferred()];
    reset([() => slow[0].promise, () => slow[1].promise, answer('tail')]);
    const pending = [send({ segment: true, piece: 0, final: false }), send({ segment: true, piece: 2, final: false })];
    await settle();
    eq('two body pieces are out', [calls.map(laneOf), h.run('[...cloudLaneSession.body]')], [[['body', 0], ['body', 2]], [0, 2]]);
    finishing({ sender: {} });
    h.run("mode = 'recording'");
    finishing(fromOverlay);
    eq('another sender, or a recording still going, hurries nothing', [hurries, h.run('cloudLaneSession.stopped')], [[], false]);
    h.run("mode = 'transcribing'");
    const returned = finishing(fromOverlay);
    eq('at stop the relay is asked to hurry exactly the body pieces still out, without waiting for it',
      [hurries, returned], [[{ dictation: calls[0].dictation, pieces: [0, 2] }], undefined]);
    eq('and logs it', diags.filter((d) => d.event === 'cloud-hurry').map((d) => d.pieces), [2]);
    await send({ segment: true, piece: 3, final: false });
    eq('anything sent after stop goes on the tail lane, even if not marked final', laneOf(calls[2]), ['tail', 3]);
    slow[0].resolve({ text: 'a', seconds: 4, ms: 900, cloud: null, timing: { lane: 'body', trigger: 'urgent', source: 'rescue' } });
    slow[1].resolve({ text: 'b', seconds: 4, ms: 900, cloud: null, timing: { lane: 'body', trigger: 'urgent', source: 'main' } });
    await Promise.all(pending);
    eq('the hurried pieces report how they were answered',
      okDiags().filter((d) => d.lane === 'body').map((d) => [d.piece, d.trigger, d.source]), [[0, 'urgent', 'rescue'], [2, 'urgent', 'main']]);
    eq('the body list is empty again', h.run('cloudLaneSession.body.size'), 0);

    newRecording();
    reset([answer('only the tail')], 'transcribing');
    finishing(fromOverlay);
    await send({ segment: true, piece: 0, final: true });
    eq('with no body piece out, nothing is hurried', hurries, []);
    eq('and the stop is remembered for the recording', [h.run('cloudLaneSession.stopped'), laneOf(calls[0])], [true, ['tail', 0]]);

    newRecording();
    const tailOut = deferred();
    reset([() => tailOut.promise], 'transcribing');
    const tailPending = send({ segment: true, piece: 0, final: true });
    await settle();
    finishing(fromOverlay);
    eq('a tail piece in flight is not hurried either', hurries, []);
    tailOut.resolve({ text: 'x', seconds: 1, ms: 1, cloud: null, timing: null });
    await tailPending;

    newRecording();
    const out = deferred();
    reset([() => out.promise], 'transcribing');
    h.run('cloudTranscriber.hurry = () => { throw new Error("thrown outright"); }');
    const outPending = send({ segment: true, piece: 0, final: false });
    await settle();
    let threw = null;
    try { finishing(fromOverlay); } catch (err) { threw = err; }
    eq('a hurry that throws never reaches the overlay', threw, null);
    out.resolve({ text: 'x', seconds: 1, ms: 1, cloud: null, timing: null });
    await outPending;
    h.run('cloudTranscriber.hurry = fakeHurry');

    newRecording();
    const lateOff = deferred();
    reset([() => lateOff.promise], 'transcribing');
    const lateOffPending = send({ segment: true, piece: 0, final: false });
    await settle();
    lanesOn(undefined);
    steps.push(answer('after'));
    await send({ segment: true, piece: 1, final: false });
    finishing(fromOverlay);
    eq('lanes withdrawn mid-recording: the recording keeps its lanes', laneOf(calls[1]), ['body', 1]);
    eq('and its body pieces are still hurried', hurries.map((x) => x.pieces), [[0]]);
    lateOff.resolve({ text: 'x', seconds: 1, ms: 1, cloud: null, timing: null });
    await lateOffPending;
    lanesOn(LANES);

    // --- a retry is decided afresh: after stop it goes up as the tail -----------
    newRecording();
    reset([async () => {
      h.run("mode = 'transcribing'");
      finishing(fromOverlay);
      throw Object.assign(new Error('Cloud transcription timed out.'), { code: 'timeout' });
    }, answer('rescued')], 'recording');
    eq('a body piece that times out across the stop is retried', await send({ segment: true, piece: 4, final: false }), 'rescued');
    eq('first on the body lane, then on the tail lane', calls.map(laneOf), [['body', 4], ['tail', 4]]);
    eq('it was hurried while out', hurries.map((x) => x.pieces), [[4]]);
    eq('the failed line keeps its 2.1.10 fields', diags.filter((d) => d.event === 'cloud-request-failed').map((d) => Object.keys(d).sort()),
      [['attempt', 'audioMs', 'code', 'elapsedMs', 'event', 'segment']]);
    eq('the success line says tail and clientRetry', okDiags().map((d) => [d.lane, d.piece, d.clientRetry, d.attempt]), [['tail', 4, true, 2]]);
    eq('and the body list is empty', h.run('cloudLaneSession.body.size'), 0);

    newRecording();
    reset([failure('timeout'), answer('again')], 'recording');
    await send({ segment: true, piece: 1, final: false });
    eq('a retry while the user still talks stays on the body lane', calls.map(laneOf), [['body', 1], ['body', 1]]);

    newRecording();
    reset([failure('auth')], 'recording');
    const refused = await send({ segment: true, piece: 0, final: false }).then(() => null, (err) => err.code);
    eq('a body piece that fails for good leaves the body list too', [refused, h.run('cloudLaneSession.body.size')], ['auth', 0]);
  } finally {
    await h.close();
  }
}

// --- the client: what goes over the wire --------------------------------------
async function clientChecks() {
  const requests = [];
  const respond = { status: 200, ok: true };
  const pendingFetches = [];
  let hold = false;
  const fetchImpl = async (url, init) => {
    requests.push({ url, init, body: init.body ? JSON.parse(init.body) : null });
    if (hold) {
      const d = deferred();
      pendingFetches.push(d);
      return d.promise;
    }
    return { ok: respond.ok, status: respond.status, json: async () => ({ text: 'ok', seconds: 1 }) };
  };
  const warmLog = [];
  const client = new CloudTranscriber({ baseUrl: 'https://relay.test/v1/', fetchImpl, token: () => 'tok', onWarm: (r) => warmLog.push(r) });
  const wav = Buffer.alloc(44);

  await client.transcribe(wav, { language: 'en', terms: ['Voxden'] });
  eq('a request without a lane is exactly today\'s body', Object.keys(requests[0].body).sort(), ['audio', 'format', 'language', 'terms']);
  await client.transcribe(wav, { lane: 'body', dictation: 'abcdef0123456789', piece: 7 });
  eq('a lane request adds lane, dictation and piece',
    [requests[1].body.lane, requests[1].body.dictation, requests[1].body.piece], ['body', 'abcdef0123456789', 7]);
  await client.transcribe(wav, { lane: 'tail', dictation: 'Ab_-1234', piece: 0 });
  eq('tail, an 8-character id with _ and -, and piece 0', [requests[2].body.lane, requests[2].body.dictation, requests[2].body.piece], ['tail', 'Ab_-1234', 0]);
  await client.transcribe(wav, { lane: 'side', dictation: 'abcdef0123456789', piece: 1 });
  eq('an unknown lane sends none of the three', ['lane', 'dictation', 'piece'].map((k) => k in requests[3].body), [false, false, false]);
  for (const [dictation, piece] of [['short', 1000], ['has space 123', -1], ['x'.repeat(33), 1.5], [12345678, '3']]) {
    await client.transcribe(wav, { lane: 'body', dictation, piece });
  }
  eq('a malformed id or piece index is left out', requests.slice(4).map((r) => ['dictation' in r.body, 'piece' in r.body]),
    [[false, false], [false, false], [false, false], [false, false]]);

  requests.length = 0;
  await Promise.all([client.warm(), client.warm()]);
  await Promise.all([client.warm({ lane: 'body' }), client.warm({ lane: 'body' }), client.warm({ lane: 'tail' })]);
  eq('warm-ups coalesce per lane; only body changes the URL', requests.map((r) => r.url),
    ['https://relay.test/v1/transcribe/warm', 'https://relay.test/v1/transcribe/warm?lane=body', 'https://relay.test/v1/transcribe/warm']);
  eq('the warm-up log is unchanged without a lane and names it with one', warmLog.map((w) => Object.keys(w).sort()),
    [['accepted', 'requestMs', 'status'], ['accepted', 'lane', 'requestMs', 'status'], ['accepted', 'requestMs', 'status']]);

  requests.length = 0;
  eq('hurry posts the pieces and says yes when the relay accepts',
    await client.hurry({ dictation: 'abcdef0123456789', pieces: [3, 1, 3, -1, 1000, 2.5, '4', 0] }), true);
  eq('to /transcribe/urgent, signed in, with the valid pieces once each',
    [requests[0].url, requests[0].init.method, requests[0].init.headers.Authorization, requests[0].body],
    ['https://relay.test/v1/transcribe/urgent', 'POST', 'Bearer tok', { dictation: 'abcdef0123456789', pieces: [3, 1, 0] }]);
  requests.length = 0;
  await client.hurry({ dictation: 'abcdef0123456789', pieces: Array.from({ length: 100 }, (_, i) => i) });
  eq('at most 64 pieces', requests[0].body.pieces.length, 64);
  requests.length = 0;
  eq('no pieces, a bad id, or no session: nothing is sent',
    [await client.hurry({ dictation: 'abcdef0123456789', pieces: [] }), await client.hurry({ dictation: 'bad id', pieces: [1] }),
      await client.hurry(), await new CloudTranscriber({ fetchImpl, token: () => '' }).hurry({ dictation: 'abcdef0123456789', pieces: [1] }),
      requests.length], [false, false, false, false, 0]);
  respond.ok = false; respond.status = 404;
  eq('an old relay\'s 404 is a quiet no', await client.hurry({ dictation: 'abcdef0123456789', pieces: [1] }), false);
  respond.ok = true; respond.status = 200;
  const broken = new CloudTranscriber({ fetchImpl: async () => { throw new Error('ECONNRESET'); }, token: () => 'tok' });
  eq('a network failure is a quiet no', await broken.hurry({ dictation: 'abcdef0123456789', pieces: [1] }), false);
  const throwing = new CloudTranscriber({ fetchImpl: () => { throw new Error('sync'); }, token: () => { throw new Error('store'); } });
  eq('so is anything that throws', await throwing.hurry({ dictation: 'abcdef0123456789', pieces: [1] }), false);

  // The four-second bound, without waiting four seconds.
  const realSetTimeout = global.setTimeout;
  const delays = [];
  global.setTimeout = (fn, ms) => { delays.push(ms); return realSetTimeout(fn, 0); };
  hold = true;
  let hung;
  try {
    hung = client.hurry({ dictation: 'abcdef0123456789', pieces: [1] });
  } finally {
    global.setTimeout = realSetTimeout;
  }
  const signal = requests[requests.length - 1].init.signal;
  signal.addEventListener('abort', () => pendingFetches.forEach((d) => d.reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
  eq('a relay that never answers is given up on after four seconds', [delays, await hung], [[4000], false]);
  hold = false;
}

(async () => {
  await mainChecks();
  await clientChecks();
  process.stdout.write('all ' + checks + ' cloud lanes checks passed\n');
})().catch((err) => { console.error(err); process.exitCode = 1; });
