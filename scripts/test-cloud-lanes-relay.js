'use strict';

// Dictation lanes in the relay (server/app.js, server/cloud.js), over real HTTP
// with an in-memory database and only OpenRouter replaced. Body pieces go to the
// body model (MAI) with AssemblyAI as its rescue; tail pieces and every request
// without a lane go to the usual model (AssemblyAI, with the GPT rescue). The
// urgent route hurries the caller's own body pieces at stop. Requests without a
// lane, which every app up to 2.1.10 sends, must not change in any way: the
// upstream body byte for byte, the charge, and the timing object.

const assert = require('assert');
const http = require('http');
const crypto = require('crypto');
const { createStore } = require('../server/store');
const { createApp } = require('../server/app');
const { createCloudTranscriber } = require('../server/cloud');

const AAI = 'assemblyai/universal-3-5-pro';
const GPT = 'openai/gpt-4o-mini-transcribe';
const MAI = 'microsoft/mai-transcribe-2';
const ME = 'me@example.com';
const DICTATION = 'dict_0123456789';

let checks = 0;
function ok(label, value) { assert.ok(value, label); checks++; process.stdout.write('ok ' + label + '\n'); }
function eq(label, actual, expected) {
  assert.deepStrictEqual(actual, expected, label + '\n  got: ' + JSON.stringify(actual));
  checks++; process.stdout.write('ok ' + label + '\n');
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(label, predicate) {
  for (let i = 0; i < 400; i++) {
    if (predicate()) return;
    await sleep(5);
  }
  assert.fail('timed out waiting: ' + label);
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

// A stand-in for OpenRouter with one script per model, as in
// scripts/test-cloud-relay.js routedProvider: each model walks through its own
// plans and repeats the last. A plan answers after `after` ms, fails with
// `status`, never answers (`hang`), or waits to be released by the test
// (`manual`: call.release(text, usage)). Every call keeps its raw body.
function provider(scripts) {
  const calls = [];
  const used = {};
  const fetchImpl = (fetchUrl, init) => {
    const body = JSON.parse(init.body);
    const plans = scripts[body.model] || [{ hang: true }];
    const plan = plans[Math.min(used[body.model] || 0, plans.length - 1)];
    used[body.model] = (used[body.model] || 0) + 1;
    const call = { model: body.model, body, raw: init.body, cancelled: false, answered: false, at: Date.now(), release: null };
    calls.push(call);
    return new Promise((resolve, reject) => {
      let timer = null;
      const answer = (text, usage, status) => {
        if (call.answered || call.cancelled) return;
        call.answered = true;
        const code = status || 200;
        resolve({
          ok: code === 200, status: code, headers: { get: () => null },
          json: async () => (code === 200 ? { text, usage: usage || { seconds: 1 } } : { error: { message: 'No' } }),
        });
      };
      const abort = () => {
        if (call.answered) return;
        call.cancelled = true;
        clearTimeout(timer);
        reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
      };
      if (init.signal.aborted) return abort();
      init.signal.addEventListener('abort', abort, { once: true });
      if (plan.manual) call.release = (text, usage) => answer(text, usage);
      else if (!plan.hang) timer = setTimeout(() => answer(plan.text, plan.usage, plan.status), plan.after || 0);
    });
  };
  return { fetchImpl, calls, of: (model) => calls.filter((call) => call.model === model) };
}

// One relay: the usual transcriber (AssemblyAI main, GPT rescue) and, unless
// `body: false`, the body transcriber (MAI main, AssemblyAI rescue), both on
// the same stand-in provider. The clock is the relay's own and only moves
// when a test moves it.
async function relay(options) {
  const o = options || {};
  const upstream = provider(o.scripts || {});
  const logs = [];
  const clock = { t: Date.parse('2026-10-15T09:00:00Z') };
  const store = createStore(':memory:');
  const common = { apiKey: 'k', fetchImpl: upstream.fetchImpl, timeoutMs: 4000, retryWait: async () => {} };
  const cloud = createCloudTranscriber({ ...common, model: AAI, rescueModel: GPT, rescueMs: o.legacyRescueMs || 4000, warmup: o.legacyWarmup });
  const cloudBody = o.body === false ? null : createCloudTranscriber({
    ...common, model: MAI,
    rescueModel: o.bodyRescue === undefined ? AAI : o.bodyRescue,
    rescueMs: o.bodyRescueMs === undefined ? 8000 : o.bodyRescueMs,
    urgentDelayMs: o.urgentDelayMs,
  });
  const app = createApp({
    store, mailer: { sendCode: async () => {} }, now: () => clock.t, cloudHoursCap: 10, cloudTrialCredits: 0,
    cloud, cloudBody, cloudLanes: { users: o.users === undefined ? ME : o.users, ...(o.lanes || {}) },
    polisher: { configured: true, polish: async ({ text }) => ({ text: text + ' (polished)', model: 'test/polish', cost: 0 }) },
    log: (line) => logs.push(String(line)),
  });
  const server = http.createServer(app.handle);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port + '/v1';
  const accounts = {};
  const account = (email) => {
    if (accounts[email]) return accounts[email];
    const user = store.findOrCreateUser(email, new Date(clock.t).toISOString());
    store.setPlan(email, 'pro', new Date(clock.t + 30 * 86400e3).toISOString());
    const token = 'tok_' + crypto.randomBytes(24).toString('hex');
    store.createSession({ tokenHash: crypto.createHash('sha256').update(token).digest('hex'), userId: user.id, device: 'test', createdAt: new Date(clock.t).toISOString() });
    accounts[email] = { id: user.id, token };
    return accounts[email];
  };
  const call = async (email, route, body, method) => {
    const headers = { Authorization: 'Bearer ' + account(email).token };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(base + route, { method: method || 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  const transcribe = (email, fields, seconds) => call(email, '/transcribe', { audio: wav(seconds || 1).toString('base64'), format: 'wav', ...(fields || {}) });
  const urgent = (email, body) => call(email, '/transcribe/urgent', body);
  const usage = (email) => store.usageSecondsTotal(account(email).id);
  const close = async () => {
    for (const c of upstream.calls) if (c.release) c.release('test over');
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    store.close();
  };
  return { app, upstream, logs, clock, store, base, account, call, transcribe, urgent, usage, close, cloud, cloudBody };
}

const piece = (lane, n, extra) => ({ lane, dictation: DICTATION, piece: n, ...(extra || {}) });

async function checkLegacyUnchanged() {
  const terms = ['Voxden', 'Kharagpur'];
  const scripts = { [AAI]: [{ after: 5, text: 'main answered', usage: { seconds: 1.04, cost: 0.00013 } }], [MAI]: [{ after: 5, text: 'never' }] };
  const raws = [];
  for (const options of [{ scripts }, { scripts, body: false, users: '*' }]) {
    const r = await relay(options);
    try {
      const reply = await r.transcribe(ME, { language: 'hi', terms });
      eq('a request without a lane is answered by AssemblyAI', [reply.status, reply.body.text, r.upstream.calls.map((c) => c.model)], [200, 'main answered', [AAI]]);
      raws.push(r.upstream.calls[0].raw);
      eq('its timing is exactly the four fields it always had', reply.body.timing, { relayMs: 0, hedged: false, retried: false, rescued: false });
      eq('and it is charged what the provider billed, as before', [reply.body.seconds, r.usage(ME)], [1.04, 1]);
      ok('its log line has no lane in it', r.logs.some((l) => l.startsWith('cloud transcribed 1.0s for ' + ME)) && !r.logs.some((l) => / lane=|model=/.test(l)));
      // A lane the relay does not know is no lane: the legacy path in full.
      const odd = await r.transcribe(ME, { language: 'hi', terms, lane: 'middle', dictation: DICTATION, piece: 1 });
      eq('an unknown lane is the legacy path, timing included', [odd.status, odd.body.timing], [200, { relayMs: 0, hedged: false, retried: false, rescued: false }]);
      eq('and the same upstream body', r.upstream.calls[1].raw, r.upstream.calls[0].raw);
    } finally {
      await r.close();
    }
  }
  // Byte for byte what the relay sent before lanes existed, key order included.
  const expected = JSON.stringify({
    model: AAI,
    input_audio: { data: wav(1).toString('base64'), format: 'wav' },
    language: 'hi',
    provider: { options: { assemblyai: { keyterms_prompt: terms } }, zdr: true },
  });
  eq('the upstream body of a no-lane request is byte-identical, lanes on or off', raws, [expected, expected]);

  // The GPT rescue of a no-lane request is unchanged too, Norwegian included:
  // AssemblyAI gets 'no' for an old app's 'nb', and GPT the same 'no'.
  const r = await relay({ scripts: { [AAI]: [{ hang: true }], [GPT]: [{ after: 5, text: 'gpt rescued' }] }, legacyRescueMs: 40 });
  try {
    const reply = await r.transcribe(ME, { language: 'nb', terms });
    eq('a stuck AssemblyAI main model is rescued by GPT as before', [reply.status, reply.body.text, reply.body.timing],
      [200, 'gpt rescued', { relayMs: 0, hedged: false, retried: false, rescued: true }]);
    eq('the main model got no and the GPT rescue the same no', r.upstream.calls.map((c) => [c.model, c.body.language]), [[AAI, 'no'], [GPT, 'no']]);
    eq('the GPT rescue body is what it always was', r.upstream.calls[1].raw, JSON.stringify({
      model: GPT,
      input_audio: { data: wav(1).toString('base64'), format: 'wav' },
      language: 'no',
      provider: { options: { openai: { prompt: 'Vocabulary: Voxden, Kharagpur' } }, data_collection: 'deny' },
    }));
    ok('and its log line is the legacy one', /rescued by openai\/gpt-4o-mini-transcribe after \d+\.\ds \(sent at \d+\.\ds when the main model went quiet\)\)$/.test(r.logs.filter((l) => l.includes('cloud transcribed')).pop()));
  } finally {
    await r.close();
  }
}

async function checkBodyAndTail() {
  const terms = ['Voxden', 'Kharagpur'];
  const r = await relay({ scripts: {
    [MAI]: [{ after: 5, text: 'from mai', usage: { seconds: 3, cost: 0.0001 } }],
    [AAI]: [{ after: 5, text: 'from aai', usage: { seconds: 2.4 } }],
  } });
  try {
    let reply = await r.transcribe(ME, piece('body', 0, { language: 'en', terms }), 2.4);
    eq('a body piece is answered by MAI', [reply.status, reply.body.text, r.upstream.calls.map((c) => c.model)], [200, 'from mai', [MAI]]);
    eq('with its phrase list, zero data retention and the language', r.upstream.calls[0].body, {
      model: MAI,
      input_audio: { data: wav(2.4).toString('base64'), format: 'wav' },
      language: 'en',
      provider: { options: { azure: { phraseList: { phrases: terms } } }, zdr: true },
    });
    eq('the timing adds the lane, no trigger and the main model as source', reply.body.timing,
      { relayMs: 0, hedged: false, retried: false, rescued: false, lane: 'body', trigger: '', source: 'main' });
    eq('charged its exact 2.4 audio seconds, not the 3 MAI billed', [reply.body.seconds, r.usage(ME)], [2.4, 2]);
    ok('the log line ends with the lane, the piece and the model', / lane=body piece=0 model=microsoft\/mai-transcribe-2$/.test(r.logs.filter((l) => l.includes('cloud transcribed')).pop()));

    reply = await r.transcribe(ME, piece('tail', 1, { language: 'en', terms }), 2.4);
    eq('a tail piece is answered by AssemblyAI', [reply.status, reply.body.text, r.upstream.calls[1].model], [200, 'from aai', AAI]);
    eq('with its keyterms and zero data retention', r.upstream.calls[1].body.provider, { options: { assemblyai: { keyterms_prompt: terms } }, zdr: true });
    eq('and the tail lane in its timing', reply.body.timing, { relayMs: 0, hedged: false, retried: false, rescued: false, lane: 'tail', trigger: '', source: 'main' });
    eq('charged its audio seconds too', [reply.body.seconds, r.usage(ME)], [2.4, 4]);

    // A short piece is still at least a second.
    reply = await r.transcribe(ME, piece('body', 2), 0.4);
    eq('a 0.4 s body piece is charged one second', [reply.body.seconds, r.usage(ME)], [1, 5]);

    // A body piece from an account the lanes are not on for goes to AssemblyAI.
    reply = await r.transcribe('other@example.com', piece('body', 0, { language: 'en' }), 2);
    eq('a body piece from someone not on the list goes to AssemblyAI', [reply.status, reply.body.text, r.upstream.calls[3].model], [200, 'from aai', AAI]);
    eq('it still says its lane', [reply.body.timing.lane, reply.body.timing.source], ['body', 'main']);
    eq('and its meter says lanes off with dictation: null', reply.body.cloud.dictation, null);

    // A body piece with no usable id still goes to MAI; it just cannot be hurried.
    reply = await r.transcribe(ME, { lane: 'body', dictation: 'short', piece: 3.5 }, 1);
    eq('a body piece without a usable id still reaches MAI', [reply.status, r.upstream.calls[4].model, reply.body.timing.lane], [200, MAI, 'body']);
    ok('logged with no piece number', / lane=body piece=- model=/.test(r.logs.filter((l) => l.includes('cloud transcribed')).pop()));
  } finally {
    await r.close();
  }
}

async function checkUrgent() {
  // A body piece MAI is sitting on is hurried: AssemblyAI answers it at once.
  let r = await relay({ scripts: { [MAI]: [{ manual: true }], [AAI]: [{ after: 5, text: 'aai answered', usage: { seconds: 5, cost: 0.0002 } }] } });
  try {
    const pending = r.transcribe(ME, piece('body', 0, { language: 'en', terms: ['Voxden'] }), 2);
    await until('the body piece reaches MAI', () => r.upstream.of(MAI).length === 1);
    const hurry = await r.urgent(ME, { dictation: DICTATION, pieces: [0] });
    eq('urgent answers what it hurried', [hurry.status, hurry.body], [200, { hurried: 1, early: 0 }]);
    const reply = await pending;
    eq('the piece is answered by the AssemblyAI rescue', [reply.status, reply.body.text], [200, 'aai answered']);
    eq('the timing says the app stopped it and the rescue answered', reply.body.timing,
      { relayMs: 0, hedged: false, retried: false, rescued: true, lane: 'body', trigger: 'urgent', source: 'rescue' });
    eq('MAI is cancelled and AssemblyAI answered', r.upstream.calls.map((c) => [c.model, c.cancelled]), [[MAI, true], [AAI, false]]);
    eq('the rescue went with its keyterms and zero data retention', r.upstream.calls[1].body.provider, { options: { assemblyai: { keyterms_prompt: ['Voxden'] } }, zdr: true });
    eq('one charge, of the audio seconds, not what the rescue billed', [reply.body.seconds, r.usage(ME)], [2, 2]);
    const line = r.logs.filter((l) => l.includes('cloud transcribed')).pop();
    ok('the log says the rescue went out after the app stopped', /rescued by assemblyai\/universal-3-5-pro after \d+\.\ds \(sent at \d+\.\ds after the app stopped\)/.test(line));
    ok('with the lane and piece', / lane=body piece=0 model=assemblyai\/universal-3-5-pro$/.test(line));
    ok('and the urgent call is logged', r.logs.includes('urgent for ' + ME + ': hurried 1, early 0'));
    await sleep(30);
    eq('nothing else goes upstream', r.upstream.calls.length, 2);
    // Hurrying a piece that has already answered marks it early and changes nothing.
    eq('a piece already answered is not hurried', (await r.urgent(ME, { dictation: DICTATION, pieces: [0] })).body, { hurried: 0, early: 1 });

    // Nobody else can hurry it: another account's urgent for the same ids is its own.
    const mine = r.transcribe(ME, piece('body', 5), 1);
    await until('the second body piece reaches MAI', () => r.upstream.of(MAI).length === 2);
    const theirs = await r.urgent('intruder@example.com', { dictation: DICTATION, pieces: [5] });
    eq('another account hurries nothing of mine (the lanes are not even on for it)', theirs.body, { hurried: 0, early: 0 });
    ok('and its call writes no log line', !r.logs.some((l) => l.includes('intruder@example.com')));
    r.upstream.of(MAI)[1].release('mai answered', { seconds: 1 });
    const answered = await mine;
    eq('my piece is answered by MAI, untouched', [answered.body.text, answered.body.timing.source, answered.body.timing.trigger], ['mai answered', 'main', '']);
  } finally {
    await r.close();
  }

  // Two accounts both on the lanes, the same dictation id and piece: each
  // hurries only its own.
  r = await relay({ users: '*', scripts: { [MAI]: [{ manual: true }], [AAI]: [{ after: 5, text: 'aai answered' }] } });
  try {
    const mine = r.transcribe(ME, piece('body', 7), 1);
    await until('my body piece reaches MAI', () => r.upstream.of(MAI).length === 1);
    const theirs = await r.urgent('peer@example.com', { dictation: DICTATION, pieces: [7] });
    eq('a peer on the lanes, same ids, marks its own piece early and hurries none of mine', theirs.body, { hurried: 0, early: 1 });
    await sleep(30);
    eq('my piece is still with MAI, nothing rescued', [r.upstream.calls.length, r.upstream.calls[0].cancelled], [1, false]);
    const peerPiece = await r.transcribe('peer@example.com', piece('body', 7), 1);
    eq('the peer own piece goes straight to AssemblyAI', [peerPiece.body.text, r.upstream.calls[1].model, r.upstream.of(MAI).length], ['aai answered', AAI, 1]);
    r.upstream.of(MAI)[0].release('mine from mai');
    eq('and mine is answered by MAI', (await mine).body.text, 'mine from mai');
  } finally {
    await r.close();
  }

  // CLOUD_URGENT_DELAY_MS holds the rescue back that long after the urgent call.
  r = await relay({ urgentDelayMs: 150, scripts: { [MAI]: [{ manual: true }], [AAI]: [{ after: 5, text: 'later' }] } });
  try {
    const pending = r.transcribe(ME, piece('body', 0), 1);
    await until('the body piece reaches MAI', () => r.upstream.of(MAI).length === 1);
    const asked = Date.now();
    eq('the urgent call answers at once', (await r.urgent(ME, { dictation: DICTATION, pieces: [0] })).body, { hurried: 1, early: 0 });
    const reply = await pending;
    const waited = r.upstream.of(AAI)[0].at - asked;
    ok('the rescue went out after the delay (' + waited + ' ms)', waited >= 130 && waited < 2000);
    eq('and answered with trigger urgent', [reply.body.text, reply.body.timing.trigger], ['later', 'urgent']);
  } finally {
    await r.close();
  }

  // Bad urgent calls.
  r = await relay({});
  try {
    eq('a bad dictation id is a 400', [(await r.urgent(ME, { dictation: 'x', pieces: [0] })).status], [400]);
    eq('no pieces list is a 400', (await r.urgent(ME, { dictation: DICTATION })).status, 400);
    eq('more than 64 pieces is a 400', (await r.urgent(ME, { dictation: DICTATION, pieces: Array.from({ length: 65 }, (_, i) => i) })).status, 400);
    eq('pieces out of range or not whole are ignored', (await r.urgent(ME, { dictation: DICTATION, pieces: [-1, 1000, 2.5, '3', 4, 4] })).body, { hurried: 0, early: 1 });
    const res = await fetch(r.base + '/transcribe/urgent', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dictation: DICTATION, pieces: [0] }) });
    eq('a signed-out urgent call is a 401', res.status, 401);
    eq('and no urgent call charged anything', r.usage(ME), 0);
  } finally {
    await r.close();
  }
}

async function checkEarlyUrgent() {
  const r = await relay({ scripts: { [MAI]: [{ after: 5, text: 'from mai' }], [AAI]: [{ after: 5, text: 'from aai' }] } });
  try {
    // The app stopped before piece 1's request arrived: it goes straight to AssemblyAI.
    eq('an urgent call for a piece not arrived yet marks it early', (await r.urgent(ME, { dictation: DICTATION, pieces: [1] })).body, { hurried: 0, early: 1 });
    ok('and is logged', r.logs.includes('urgent for ' + ME + ': hurried 0, early 1'));
    let reply = await r.transcribe(ME, piece('body', 1, { language: 'no' }), 2);
    eq('the late body piece is answered by AssemblyAI, MAI never called', [reply.body.text, r.upstream.calls.map((c) => c.model)], ['from aai', [AAI]]);
    eq('as the main model, in the body lane', reply.body.timing, { relayMs: 0, hedged: false, retried: false, rescued: false, lane: 'body', trigger: '', source: 'main' });
    eq('with AssemblyAI Norwegian', r.upstream.calls[0].body.language, 'no');
    eq('charged its audio seconds', [reply.body.seconds, r.usage(ME)], [2, 2]);
    ok('the log says it was hurried before it arrived', r.logs.filter((l) => l.includes('cloud transcribed')).pop().includes(' lane=body piece=1 (hurried before it arrived, sent to the main model) model=' + AAI));
    // The mark is used up: the same piece again goes to MAI.
    reply = await r.transcribe(ME, piece('body', 1), 1);
    eq('the mark is used once', [reply.body.text, r.upstream.calls[1].model], ['from mai', MAI]);
    // A tail piece is not affected by a mark.
    await r.urgent(ME, { dictation: DICTATION, pieces: [2] });
    reply = await r.transcribe(ME, piece('tail', 2), 1);
    eq('a tail piece goes to AssemblyAI as usual', [reply.body.text, reply.body.timing.lane], ['from aai', 'tail']);
    // A mark lapses after 30 s.
    eq('another early mark', (await r.urgent(ME, { dictation: DICTATION, pieces: [3, 4] })).body, { hurried: 0, early: 2 });
    r.clock.t += 29000;
    reply = await r.transcribe(ME, piece('body', 3), 1);
    eq('within 30 s it still holds', [reply.body.text, r.upstream.calls[r.upstream.calls.length - 1].model], ['from aai', AAI]);
    r.clock.t += 1001;
    reply = await r.transcribe(ME, piece('body', 4), 1);
    eq('after 30 s it has lapsed and the piece goes to MAI', [reply.body.text, r.upstream.calls[r.upstream.calls.length - 1].model], ['from mai', MAI]);
    // A mark for another dictation does not touch this one.
    await r.urgent(ME, { dictation: 'other_dictation', pieces: [5] });
    reply = await r.transcribe(ME, piece('body', 5), 1);
    eq('a mark is per dictation', reply.body.text, 'from mai');
  } finally {
    await r.close();
  }
}

// At most 512 early marks live per account, so one account cannot crowd the
// shared bound once the lanes are on for everyone.
async function checkEarlyCap() {
  const r = await relay({ users: '*', scripts: { [MAI]: [{ after: 1, text: 'from mai' }], [AAI]: [{ after: 1, text: 'from aai' }] } });
  try {
    const all = Array.from({ length: 64 }, (_, i) => i);
    const marked = [];
    for (let n = 0; n < 8; n++) marked.push((await r.urgent(ME, { dictation: 'dictation_' + n, pieces: all })).body.early);
    eq('eight calls of 64 store 512 marks', marked, Array(8).fill(64));
    const over = await r.urgent(ME, { dictation: 'dictation_8', pieces: [0, 1, 2] });
    eq('the next ones are refused, still 200, early counting none', [over.status, over.body], [200, { hurried: 0, early: 0 }]);
    ok('and logged as such', r.logs.includes('urgent for ' + ME + ': hurried 0, early 0'));
    let reply = await r.transcribe(ME, { lane: 'body', dictation: 'dictation_8', piece: 0 }, 1);
    eq('a piece refused a mark goes to MAI like any other', reply.body.text, 'from mai');
    eq('marking one again is a refresh, not a new mark', (await r.urgent(ME, { dictation: 'dictation_0', pieces: [5] })).body.early, 1);
    eq('another account is not affected', (await r.urgent('peer@example.com', { dictation: 'dictation_0', pieces: [0, 1] })).body.early, 2);
    // A used mark frees its place.
    reply = await r.transcribe(ME, { lane: 'body', dictation: 'dictation_1', piece: 0 }, 1);
    eq('a marked piece still goes to AssemblyAI', reply.body.text, 'from aai');
    eq('and frees one place', (await r.urgent(ME, { dictation: 'dictation_9', pieces: [0, 1] })).body.early, 1);
    // Lapsed marks free theirs.
    r.clock.t += 30001;
    eq('after 30 s every place is free again', (await r.urgent(ME, { dictation: 'dictation_10', pieces: all })).body.early, 64);
  } finally {
    await r.close();
  }
}

async function checkPools() {
  // Everything waits until released, and no rescue is due within the test.
  const r = await relay({ scripts: { [MAI]: [{ manual: true }], [AAI]: [{ manual: true }] } });
  try {
    const out = [];
    for (let n = 0; n < 4; n++) out.push(r.transcribe(ME, piece('body', n), 1));
    for (let n = 4; n < 10; n++) out.push(r.transcribe(ME, piece('tail', n), 1));
    for (let n = 0; n < 3; n++) out.push(r.transcribe(ME, {}, 1));
    await until('thirteen requests upstream', () => r.upstream.calls.length === 13);
    eq('four body pieces went to MAI and nine requests (six tail) to AssemblyAI', [r.upstream.of(MAI).length, r.upstream.of(AAI).length], [4, 9]);
    const body5 = await r.transcribe(ME, piece('body', 8), 1);
    eq('a fifth body piece is busy', [body5.status, body5.body.code], [429, 'busy']);
    const tail7 = await r.transcribe(ME, piece('tail', 11), 1);
    eq('a seventh tail piece is busy', [tail7.status, tail7.body.code], [429, 'busy']);
    const general4 = await r.transcribe(ME, {}, 1);
    eq('a fourth no-lane clip is busy, as before', [general4.status, general4.body.code], [429, 'busy']);
    const polish = await r.call(ME, '/polish', { text: 'Please improve this.' });
    eq('so is a Polish, which shares the general pool', [polish.status, polish.body.code], [429, 'busy']);
    const hurry = await r.urgent(ME, { dictation: 'another_dictation', pieces: [0] });
    eq('an urgent call takes no slot', [hurry.status, hurry.body], [200, { hurried: 0, early: 1 }]);
    const peer = r.transcribe('peer@example.com', piece('body', 0), 1);
    await until('another account still gets a slot', () => r.upstream.calls.length === 14);
    for (const c of r.upstream.calls) if (c.release) c.release('done', { seconds: 1 });
    const replies = await Promise.all(out);
    eq('all thirteen are answered', replies.map((reply) => reply.status), Array(13).fill(200));
    eq('and so is the other account, which has pools of its own', (await peer).status, 200);
    const again = r.transcribe(ME, piece('body', 10), 1);
    await until('the next body piece upstream', () => r.upstream.calls.length === 15);
    r.upstream.calls[14].release('again');
    eq('and the slots come back', (await again).status, 200);
  } finally {
    await r.close();
  }

  // CLOUD_BODY_CALLS sets the body pool, and the app is told it.
  const small = await relay({ lanes: { bodyCalls: 2 }, scripts: { [MAI]: [{ manual: true }] } });
  try {
    const out = [small.transcribe(ME, piece('body', 0), 1), small.transcribe(ME, piece('body', 1), 1)];
    await until('two body pieces upstream', () => small.upstream.calls.length === 2);
    eq('a third body piece is busy with CLOUD_BODY_CALLS=2', (await small.transcribe(ME, piece('body', 2), 1)).status, 429);
    eq('and the advertised concurrency is 2', (await small.call(ME, '/me', undefined, 'GET')).body.account.cloud.dictation.bodyConcurrency, 2);
    for (const c of small.upstream.calls) c.release('done');
    await Promise.all(out);
  } finally {
    await small.close();
  }

  // The credit reservation is still one total across the pools.
  const tight = await relay({ scripts: { [MAI]: [{ manual: true }], [AAI]: [{ manual: true }] } });
  try {
    const user = tight.account(ME);
    tight.store.addUsageSeconds(user.id, '2026-10-15', 10 * 3600 - 10);
    const first = tight.transcribe(ME, piece('body', 0), 6);
    await until('the body piece upstream', () => tight.upstream.calls.length === 1);
    const tail = await tight.transcribe(ME, piece('tail', 1), 6);
    eq('a tail piece cannot spend credits a body piece has reserved', [tail.status, tail.body.code], [402, 'cap']);
    tight.upstream.calls[0].release('done');
    eq('the body piece is answered', (await first).status, 200);
  } finally {
    await tight.close();
  }
}

async function checkLanguage() {
  const r = await relay({ scripts: { [MAI]: [{ manual: true }], [AAI]: [{ after: 5, text: 'aai' }] } });
  try {
    // A new app sends AssemblyAI's 'no'; an old app's 'nb' reaches the same place.
    for (const [sent, n] of [['no', 0], ['nb', 1]]) {
      const before = r.upstream.calls.length;
      const pending = r.transcribe(ME, piece('body', n, { language: sent }), 1);
      await until('the body piece reaches MAI', () => r.upstream.calls.length === before + 1);
      await r.urgent(ME, { dictation: DICTATION, pieces: [n] });
      const reply = await pending;
      eq('Norwegian sent as ' + sent + ': MAI gets nb and its AssemblyAI rescue gets no',
        [reply.status, r.upstream.calls.slice(before).map((c) => [c.model, c.body.language])], [200, [[MAI, 'nb'], [AAI, 'no']]]);
    }
    // The offered set stays AssemblyAI's 18: Bengali is refused for a body piece too.
    const before = r.upstream.calls.length;
    const bn = await r.transcribe(ME, piece('body', 9, { language: 'bn' }), 1);
    eq('a language AssemblyAI cannot take is refused for a body piece, before anything is sent', [bn.status, bn.body.code, r.upstream.calls.length], [400, 'language', before]);
    eq('and nothing is charged for it', r.usage(ME), 2);
  } finally {
    await r.close();
  }
}

async function checkWarm() {
  const warm = async (r, email, query) => {
    const res = await fetch(r.base + '/transcribe/warm' + (query || ''), { method: 'POST', headers: { Authorization: 'Bearer ' + r.account(email).token } });
    await sleep(60);
    return [res.status, r.upstream.calls.map((c) => c.model).sort()];
  };
  const scripts = { [MAI]: [{ after: 1, text: '' }], [AAI]: [{ after: 1, text: '' }] };
  // Production's shape: AssemblyAI skips its warm-up (CLOUD_WARMUP=auto), MAI does not.
  let r = await relay({ scripts });
  try {
    eq('?lane=body sends MAI its silent clip, and AssemblyAI (auto) none', await warm(r, ME, '?lane=body'), [204, [MAI]]);
    eq('as a third of a second of silence with zero data retention', [Buffer.from(r.upstream.calls[0].body.input_audio.data, 'base64').length, r.upstream.calls[0].body.provider], [44 + 0.3 * 16000 * 2, { zdr: true }]);
    ok('and is logged', r.logs.some((l) => l.startsWith('body speech model warm-up {"ok":true')));
    eq('nothing is metered for it', r.usage(ME), 0);
  } finally {
    await r.close();
  }
  // With the usual model's warm-up on, ?lane=body warms both.
  for (const [label, email, query, expected] of [
    ['?lane=body warms both models', ME, '?lane=body', [AAI, MAI]],
    ['no query warms the usual model only, as before', ME, '', [AAI]],
    ['?lane=body for someone not on the list warms the usual model only', 'other@example.com', '?lane=body', [AAI]],
    ['another lane value is the plain warm-up', ME, '?lane=tail', [AAI]],
  ]) {
    r = await relay({ scripts, legacyWarmup: 'on' });
    try {
      eq(label, await warm(r, email, query), [204, expected]);
    } finally {
      await r.close();
    }
  }
  r = await relay({ scripts, legacyWarmup: 'on', body: false, users: '*' });
  try {
    eq('?lane=body with the lanes off warms the usual model only', await warm(r, ME, '?lane=body'), [204, [AAI]]);
  } finally {
    await r.close();
  }
}

async function checkAdvertised() {
  const scripts = { [MAI]: [{ after: 1, text: 'mai' }], [AAI]: [{ after: 1, text: 'aai' }] };
  const me = async (r, email) => (await r.call(email, '/me', undefined, 'GET')).body.account.cloud;
  let r = await relay({ scripts });
  try {
    eq('the start-up summary says the lanes are on', r.app.lanes, {
      on: true, model: MAI, rescueModel: AAI, users: 1,
      settings: { lanes: true, minSegmentMs: 4000, silenceMs: 700, longSegmentMs: 45000, longSilenceMs: 300, bodyConcurrency: 4 },
    });
    eq('/v1/me tells an account on the list the piece sizes (rule r4)', (await me(r, ME)).dictation,
      { lanes: true, minSegmentMs: 4000, silenceMs: 700, longSegmentMs: 45000, longSilenceMs: 300, bodyConcurrency: 4 });
    eq('and tells everybody else null', (await me(r, 'other@example.com')).dictation, null);
    eq('every transcribe answer carries them, a no-lane one included', (await r.transcribe(ME, {}, 1)).body.cloud.dictation.lanes, true);
    eq('and a lane one', (await r.transcribe(ME, piece('tail', 0), 1)).body.cloud.dictation.minSegmentMs, 4000);
    eq('but null for someone not on the list', (await r.transcribe('other@example.com', piece('body', 0), 1)).body.cloud.dictation, null);
    const legacy = await r.transcribe('other@example.com', {}, 1);
    eq('a no-lane answer for them carries the null too, and the legacy timing', [legacy.body.cloud.dictation, legacy.body.timing],
      [null, { relayMs: 0, hedged: false, retried: false, rescued: false }]);
    eq('the meter around it is unchanged', Object.keys(await me(r, 'other@example.com')).sort(),
      Object.keys(await me(r, ME)).sort());
  } finally {
    await r.close();
  }
  // Settings from the environment, a list in any case with spaces, and '*'.
  r = await relay({ scripts, users: ' Someone@Example.com , ME@example.COM ', lanes: { minSegmentMs: '3000', silenceMs: '500', longSegmentMs: '8000', longSilenceMs: '250', bodyCalls: '3' } });
  try {
    eq('the environment sets the sizes, and the list ignores case and spaces', (await me(r, ME)).dictation,
      { lanes: true, minSegmentMs: 3000, silenceMs: 500, longSegmentMs: 8000, longSilenceMs: 250, bodyConcurrency: 3 });
    eq('a second address on the list', (await me(r, 'someone@example.com')).dictation.lanes, true);
  } finally {
    await r.close();
  }
  r = await relay({ scripts, users: '*', lanes: { minSegmentMs: 'junk', silenceMs: '-5', bodyCalls: '0' } });
  try {
    eq('* is everyone, and junk sizes fall back to the defaults', (await me(r, 'anyone@example.com')).dictation,
      { lanes: true, minSegmentMs: 4000, silenceMs: 700, longSegmentMs: 45000, longSilenceMs: 300, bodyConcurrency: 4 });
    eq('the summary says everyone', r.app.lanes.users, '*');
  } finally {
    await r.close();
  }
  for (const [label, users] of [['an empty list is nobody', ''], ['an unset list is nobody', null]]) {
    r = await relay({ scripts, users });
    try {
      eq(label, [(await me(r, ME)).dictation, r.app.lanes.users], [null, 0]);
      const reply = await r.transcribe(ME, piece('body', 0), 1);
      eq('and a body piece goes to AssemblyAI', [reply.body.text, reply.body.timing.lane], ['aai', 'body']);
    } finally {
      await r.close();
    }
  }
  // Without CLOUD_BODY_MODEL nobody is told, whatever the list says.
  r = await relay({ scripts, body: false, users: '*' });
  try {
    eq('without a body model the lanes are off', r.app.lanes.on, false);
    eq('and everybody is told null', [(await me(r, ME)).dictation, (await r.transcribe(ME, {}, 1)).body.cloud.dictation], [null, null]);
  } finally {
    await r.close();
  }
}

// Every cloud meter the relay returns carries `dictation`, Polish's included,
// so any answer from a new relay refreshes what an app has cached.
async function checkPolishMeter() {
  for (const [label, options, expected] of [
    ['on the list', {}, { lanes: true, minSegmentMs: 4000, silenceMs: 700, longSegmentMs: 45000, longSilenceMs: 300, bodyConcurrency: 4 }],
    ['lanes switched off', { body: false, users: '*' }, null],
  ]) {
    const r = await relay(options);
    try {
      const reply = await r.call(ME, '/polish', { text: 'Please improve this sentence.' });
      eq('a Polish answer carries dictation, ' + label, [reply.status, reply.body.cloud.dictation], [200, expected]);
    } finally {
      await r.close();
    }
  }
}

// At the overall bound of early marks (lowered here), the caller's own oldest
// mark goes first, not another account's.
async function checkEarlyEviction() {
  const r = await relay({ users: '*', lanes: { earlyMax: 4 }, scripts: { [MAI]: [{ after: 1, text: 'from mai' }], [AAI]: [{ after: 1, text: 'from aai' }] } });
  try {
    eq('another account holds two marks', (await r.urgent('peer@example.com', { dictation: DICTATION, pieces: [0, 1] })).body.early, 2);
    eq('I hold two', (await r.urgent(ME, { dictation: DICTATION, pieces: [0, 1] })).body.early, 2);
    eq('at the bound my next two still store', (await r.urgent(ME, { dictation: DICTATION, pieces: [2, 3] })).body.early, 2);
    const peer0 = await r.transcribe('peer@example.com', piece('body', 0), 1);
    const peer1 = await r.transcribe('peer@example.com', piece('body', 1), 1);
    eq('the other account keeps both its marks', [peer0.body.text, peer1.body.text], ['from aai', 'from aai']);
    const mine = [];
    for (const n of [0, 1, 2, 3]) mine.push((await r.transcribe(ME, piece('body', n), 1)).body.text);
    eq('my two oldest went to make room, my newest two stayed', mine, ['from mai', 'from mai', 'from aai', 'from aai']);
  } finally {
    await r.close();
  }
}

async function checkLanesOff() {
  // A body model without a rescue is refused, and said so in the log.
  for (const [label, options] of [['CLOUD_BODY_RESCUE_MODEL=none', { bodyRescue: 'none' }], ['CLOUD_BODY_RESCUE_MS=0', { bodyRescueMs: 0 }]]) {
    const r = await relay({ ...options, users: '*', scripts: { [MAI]: [{ after: 1, text: 'mai' }], [AAI]: [{ after: 1, text: 'aai' }] } });
    try {
      eq(label + ' leaves the lanes off', r.app.lanes.on, false);
      ok('and the log says why', r.logs.some((l) => l.startsWith('cloud lanes off: the body model ' + MAI + ' has no rescue')));
      eq('everybody is told null', (await r.call(ME, '/me', undefined, 'GET')).body.account.cloud.dictation, null);
      const reply = await r.transcribe(ME, piece('body', 0), 1);
      eq('and a body piece goes to AssemblyAI', [reply.body.text, r.upstream.calls.map((c) => c.model)], ['aai', [AAI]]);
      eq('the urgent route hurries nothing', (await r.urgent(ME, { dictation: DICTATION, pieces: [0] })).body, { hurried: 0, early: 0 });
    } finally {
      await r.close();
    }
  }

  // No CLOUD_BODY_MODEL: lane requests go to AssemblyAI, body pieces in the body pool.
  const r = await relay({ body: false, users: '*', scripts: { [AAI]: [{ manual: true }] } });
  try {
    const out = [];
    for (let n = 0; n < 4; n++) out.push(r.transcribe(ME, piece('body', n), 1));
    for (let n = 0; n < 3; n++) out.push(r.transcribe(ME, {}, 1));
    await until('seven requests upstream', () => r.upstream.calls.length === 7);
    eq('four body pieces and three no-lane clips all reach AssemblyAI at once', r.upstream.of(AAI).length, 7);
    const fifth = await r.transcribe(ME, piece('body', 4), 1);
    eq('a fifth body piece is busy', [fifth.status, fifth.body.code], [429, 'busy']);
    for (const c of r.upstream.calls) c.release('done', { seconds: 3 });
    const replies = await Promise.all(out);
    eq('all seven are answered', replies.map((reply) => reply.status), Array(7).fill(200));
    eq('a body piece says its lane and that AssemblyAI answered as main', [replies[0].body.timing.lane, replies[0].body.timing.source], ['body', 'main']);
    eq('body pieces are charged their audio, no-lane clips what was billed', [replies[0].body.seconds, replies[4].body.seconds], [1, 3]);
    eq('no-lane timing is the legacy one', replies[4].body.timing, { relayMs: 0, hedged: false, retried: false, rescued: false });
  } finally {
    await r.close();
  }
}

// The urgent signal on the transcriber itself (server/cloud.js).
async function checkUrgentSignal() {
  const audio = { audioBase64: wav(1).toString('base64'), seconds: 1 };
  const make = (scripts, options) => {
    const upstream = provider(scripts);
    const cloud = createCloudTranscriber({ apiKey: 'k', model: MAI, rescueModel: AAI, rescueMs: 8000, timeoutMs: 3000,
      fetchImpl: upstream.fetchImpl, retryWait: async () => {}, ...(options || {}) });
    return { cloud, upstream };
  };
  // Already hurried when it starts: the rescue goes out with the main request.
  let t = make({ [MAI]: [{ hang: true }], [AAI]: [{ after: 5, text: 'rescued' }] });
  let urgent = new AbortController();
  urgent.abort();
  let result = await t.cloud.transcribe({ ...audio, urgent: urgent.signal });
  eq('a clip hurried before it starts is rescued at once', [result.text, result.rescued, result.rescueTrigger, t.upstream.calls.map((c) => [c.model, c.cancelled]).sort()],
    ['rescued', true, 'urgent', [[AAI, false], [MAI, true]]]);
  // Hurried after the main model already answered: nothing more is sent.
  t = make({ [MAI]: [{ after: 5, text: 'main' }], [AAI]: [{ after: 5, text: 'unused' }] });
  urgent = new AbortController();
  result = await t.cloud.transcribe({ ...audio, urgent: urgent.signal });
  urgent.abort();
  await sleep(30);
  eq('a hurry after the answer sends nothing', [result.text, result.rescueFired, t.upstream.calls.length], ['main', undefined, 1]);
  // The rescue already went out on its timer: a hurry does not send a second.
  t = make({ [MAI]: [{ hang: true }], [AAI]: [{ manual: true }] }, { rescueMs: 30 });
  urgent = new AbortController();
  const pending = t.cloud.transcribe({ ...audio, urgent: urgent.signal });
  await until('the timer rescue', () => t.upstream.of(AAI).length === 1);
  urgent.abort();
  await sleep(20);
  t.upstream.of(AAI)[0].release('timer rescue');
  result = await pending;
  eq('one rescue only, and it says the timer sent it', [result.text, result.rescueTrigger, t.upstream.of(AAI).length], ['timer rescue', 'timer', 1]);
  // No rescue configured: a hurry has nothing to send.
  t = make({ [MAI]: [{ after: 80, text: 'main only' }] }, { rescueModel: 'none' });
  urgent = new AbortController();
  urgent.abort();
  result = await t.cloud.transcribe({ ...audio, urgent: urgent.signal });
  eq('without a rescue a hurry changes nothing', [result.text, result.rescueFired, t.upstream.calls.length], ['main only', undefined, 1]);
  // A warm-up never rescues, hurried or not (it never gets the signal anyway).
  eq('the warm-up of a MAI body model sends one silent clip', [await make({ [MAI]: [{ after: 1, text: '' }] }).cloud.warmUp()], [true]);
}

async function main() {
  await checkUrgentSignal();
  await checkLegacyUnchanged();
  await checkBodyAndTail();
  await checkUrgent();
  await checkEarlyUrgent();
  await checkEarlyCap();
  await checkPools();
  await checkLanguage();
  await checkWarm();
  await checkAdvertised();
  await checkLanesOff();
  await checkPolishMeter();
  await checkEarlyEviction();
  process.stdout.write('all ' + checks + ' cloud lanes relay checks passed\n');
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
