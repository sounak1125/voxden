'use strict';

// Spoken corrections through Voxden Cloud: the model call and its fallback
// (server/corrections.js), the relay's /v1/corrections with its plan gate and
// no charge, and the desktop client over real HTTP with an in-memory database.
// The model is a stand-in; what it may change is checked in the app
// (scripts/test-spoken-corrections.js).

const assert = require('assert');
const http = require('http');
const crypto = require('crypto');
const { PolishClient } = require('../src/polish');
const { createCorrector, piecesFrom, PROMPT } = require('../server/corrections');
const { createStore } = require('../server/store');
const { createApp, dayOf, creditMonthOf } = require('../server/app');

let checks = 0;
function ok(label, value) { assert.ok(value, label); checks++; process.stdout.write('ok ' + label + '\n'); }
function eq(label, actual, expected) {
  assert.deepStrictEqual(actual, expected, label + '\n  got: ' + JSON.stringify(actual));
  checks++; process.stdout.write('ok ' + label + '\n');
}

const said = "Yes, let's commit. And push to mean. No, no, don't push to main.";
const answer = (content, extra) => Object.assign({
  choices: [{ finish_reason: 'stop', message: { content } }],
  usage: { prompt_tokens: 600, completion_tokens: 30, cost: 0.0004 },
}, extra || {});

function fakeFetch(answers, seen) {
  return async (url, init) => {
    const body = JSON.parse(init.body);
    seen.push(body);
    const next = answers.shift();
    if (next === 'hang') {
      return new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      });
    }
    if (next === 'fail') return { ok: false, status: 500, json: async () => ({ error: { message: 'exploded' } }) };
    return { ok: true, status: 200, json: async () => answer(next) };
  };
}

async function unit() {
  eq('the pieces come out of the answer', piecesFrom('{"remove":["And push to mean. No, no,"]}', said), ['And push to mean. No, no,']);
  eq('an empty list is an answer', piecesFrom('{"remove":[]}', said), []);
  eq('a piece that is not in the dictation is no answer', piecesFrom('{"remove":["push to production"]}', said), null);
  eq('nor is an answer that does not parse', piecesFrom('{"remove": ["And push', said), null);
  eq('nor nothing at all, as a model that spent its tokens thinking sends', piecesFrom(null, said), null);
  ok('the prompt tells the model to copy pieces, not to rewrite', /Copy each piece exactly/.test(PROMPT) && /Return the pieces in the "remove" field/.test(PROMPT));

  const seen = [];
  const corrector = createCorrector({ apiKey: 'k', fetchImpl: fakeFetch(['{"remove":["And push to mean. No, no,"]}'], seen) });
  const first = await corrector.takeBack({ text: said });
  eq('the fast model answers first', [first.model, first.remove, first.fallback], ['openai/gpt-oss-120b', ['And push to mean. No, no,'], false]);
  eq('on Cerebras, zero data retention, reasoning low',
    [seen[0].provider, seen[0].reasoning], [{ zdr: true, order: ['cerebras'], allow_fallbacks: true }, { effort: 'low' }]);
  eq('with the dictation inside transcript tags', seen[0].messages[1].content, '<transcript>' + said + '</transcript>');

  const backup = createCorrector({ apiKey: 'k', fetchImpl: fakeFetch([null, '{"remove":["And push to mean. No, no,"]}'], []) });
  const second = await backup.takeBack({ text: said });
  eq('an empty answer goes to the careful model', [second.model, second.fallback], ['openai/gpt-4.1-mini', true]);

  const slow = createCorrector({ apiKey: 'k', timeoutMs: 50, fetchImpl: fakeFetch(['hang', 'fail'], []) });
  await assert.rejects(() => slow.takeBack({ text: said }), (err) => err.code === 'upstream');
  ok('a timeout and then a failure is an error, not an edit', true);

  const alone = createCorrector({ apiKey: 'k', fallbackModel: '', timeoutMs: 50, fetchImpl: fakeFetch(['hang'], []) });
  await assert.rejects(() => alone.takeBack({ text: said }), (err) => err.code === 'timeout');
  ok('without a fallback a timeout is a timeout', true);
  await assert.rejects(() => corrector.takeBack({ text: 'word '.repeat(401) }), (err) => err.code === 'long');
  ok('a dictation over 400 words is never sent', true);
  ok('no key, not configured', !createCorrector({}).configured);
}

async function relay() {
  // --- the upstream stand-in --------------------------------------------------------
  let reply = '{"remove":["And push to mean. No, no,"]}';
  const upstream = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      if (reply === 'fail') {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'exploded' } }));
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(answer(reply)));
    });
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const url = 'http://127.0.0.1:' + upstream.address().port + '/chat/completions';

  // --- the service ------------------------------------------------------------------
  const clock = Date.parse('2026-10-05T09:00:00Z');
  const store = createStore(':memory:');
  const corrector = createCorrector({ apiKey: 'sk-test', url, timeoutMs: 500 });
  const logs = [];
  const app = createApp({ store, mailer: { sendCode: async () => {} }, now: () => clock, cloudCreditsCap: 900,
    cloudTrialCredits: 0, corrector, log: (line) => logs.push(String(line)) });
  const server = http.createServer(app.handle);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port + '/v1';
  const tokenFor = (email) => {
    store.findOrCreateUser(email, new Date(clock).toISOString());
    const t = 'tok_' + crypto.randomBytes(24).toString('hex');
    store.createSession({ tokenHash: crypto.createHash('sha256').update(t).digest('hex'),
      userId: store.userByEmail(email).id, device: 'test', createdAt: new Date(clock).toISOString() });
    return t;
  };
  const token = tokenFor('pro@example.com');
  const client = new PolishClient({ baseUrl: base, token: () => token });
  const usage = () => {
    const month = creditMonthOf(0, clock);
    return store.usageSecondsBetween(store.userByEmail('pro@example.com').id, dayOf(month.start), dayOf(month.end));
  };

  try {
    await assert.rejects(() => client.takeBack(said), (err) => err.code === 'plan' && err.status === 402);
    ok('a free account is refused with code plan', true);

    store.setPlan('pro@example.com', 'pro', '2027-01-01T00:00:00.000Z');
    const done = await client.takeBack(said);
    eq('Pro gets the pieces to take out', done.remove, ['And push to mean. No, no,']);
    eq('and nothing is charged', usage(), 0);
    ok('the log says how it went, not the words', logs.some((l) => /^corrections \d+ words for pro@example\.com in \d+ms with openai\/gpt-oss-120b \(1 piece, \$0\.00040\)$/.test(l))
      && !logs.some((l) => l.includes('push to mean')));

    reply = '{"remove":[]}';
    eq('nothing taken back is an empty list', (await client.takeBack('Please push it to the main branch, no rush.')).remove, []);

    reply = 'fail';
    await assert.rejects(() => client.takeBack(said), (err) => err.status === 502 && err.code === 'upstream');
    ok('a model failure is a 502, which the app treats as no edit', true);
    reply = '{"remove":["And push to mean. No, no,"]}';

    const long = await fetch(base + '/corrections', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'word '.repeat(401) }) });
    eq('over 400 words is refused', [long.status, (await long.json()).code], [413, 'long']);

    await assert.rejects(() => new PolishClient({ baseUrl: base, token: () => '' }).takeBack(said), (err) => err.code === 'auth');
    ok('signed out never reaches the relay', true);

    const bare = createApp({ store, mailer: { sendCode: async () => {} }, now: () => clock });
    const bareServer = http.createServer(bare.handle);
    await new Promise((r) => bareServer.listen(0, '127.0.0.1', r));
    try {
      const bareClient = new PolishClient({ baseUrl: 'http://127.0.0.1:' + bareServer.address().port + '/v1', token: () => token });
      await assert.rejects(() => bareClient.takeBack(said), (err) => err.code === 'unconfigured' && err.status === 503);
      ok('a service without the model says so', true);
    } finally {
      await new Promise((r) => bareServer.close(r));
    }

    // A relay from before this route answers 404; the app keeps to its rules.
    const old = http.createServer((req, res) => { req.resume(); req.on('end', () => {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found.' }));
    }); });
    await new Promise((r) => old.listen(0, '127.0.0.1', r));
    try {
      const oldClient = new PolishClient({ baseUrl: 'http://127.0.0.1:' + old.address().port + '/v1', token: () => token });
      await assert.rejects(() => oldClient.takeBack(said), (err) => err.code === 'unsupported');
      ok('an older relay without the route is unsupported, not an error to show', true);
    } finally {
      old.closeAllConnections();
      await new Promise((r) => old.close(r));
    }

    const hung = http.createServer(() => {});
    await new Promise((r) => hung.listen(0, '127.0.0.1', r));
    try {
      const hungClient = new PolishClient({ baseUrl: 'http://127.0.0.1:' + hung.address().port + '/v1', token: () => token });
      const t = Date.now();
      await assert.rejects(() => hungClient.takeBack(said, { timeoutMs: 150 }), (err) => err.code === 'timeout');
      ok('the app waits no longer than it said', Date.now() - t < 1500);
    } finally {
      hung.closeAllConnections();
      await new Promise((r) => hung.close(r));
    }
  } finally {
    server.closeAllConnections();
    upstream.closeAllConnections();
    await new Promise((r) => server.close(r));
    await new Promise((r) => upstream.close(r));
  }
}

(async () => {
  await unit();
  await relay();
  console.log('\n' + checks + ' spoken correction cloud checks passed.');
})().catch((err) => { console.error(err); process.exit(1); });
