'use strict';

// The metered relay end to end: the desktop CloudTranscriber, the service's
// /v1/transcribe, and a stand-in for the upstream speech model, over real
// HTTP with an in-memory database.

const assert = require('assert');
const http = require('http');
const { createStore } = require('../server/store');
const { createApp, dayOf, creditMonthOf } = require('../server/app');
const {
  createCloudTranscriber, wavSeconds, hedgeAfterMs, rescueAfterMs,
  DEFAULT_MODEL, DEFAULT_HEDGE_MS, DEFAULT_RESCUE_MODEL, DEFAULT_RESCUE_MS, RESCUE_PROMPT_MAX, WARM_FRESH_MS, MAX_PHRASES,
} = require('../server/cloud');
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

// A stand-in provider that follows a script, one entry per request it receives:
// answer after `after` ms, fail with `status`, or never answer at all (`hang`).
// Each call records whether it was cancelled, which is what a hedge must do to
// the request that lost.
function scriptedProvider(plans) {
  const calls = [];
  const fetchImpl = (_url, init) => {
    const plan = plans[Math.min(calls.length, plans.length - 1)];
    const call = { cancelled: false, answered: false };
    calls.push(call);
    return new Promise((resolve, reject) => {
      let timer = null;
      if (!plan.hang) {
        timer = setTimeout(() => {
          call.answered = true;
          const status = plan.status || 200;
          resolve({
            ok: status === 200, status, headers: { get: () => null },
            json: async () => (status === 200 ? { text: plan.text, usage: { seconds: 1 } } : { error: { message: 'No' } }),
          });
        }, plan.after || 0);
      }
      init.signal.addEventListener('abort', () => {
        call.cancelled = true;
        clearTimeout(timer);
        reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
      }, { once: true });
    });
  };
  return { fetchImpl, calls };
}

async function checkHedging() {
  // The same-model hedge on its own: the rescue model is checked in checkRescue.
  const make = (plans, options) => {
    const provider = scriptedProvider(plans);
    const cloud = createCloudTranscriber({
      apiKey: 'k', fetchImpl: provider.fetchImpl, timeoutMs: 2000, hedgeMs: 40, rescueModel: 'none', retryWait: async () => {}, ...(options || {}),
    });
    return { cloud, calls: provider.calls };
  };
  const audio = { audioBase64: wav(1).toString('base64') };

  // The first request goes quiet: the second one answers, the first is cancelled.
  let t = make([{ hang: true }, { after: 5, text: 'second answered' }]);
  let result = await t.cloud.transcribe(audio);
  eq('a quiet request is answered by a second one beside it', result.text, 'second answered');
  eq('which is reported', [result.hedged, result.hedgeWon], [true, true]);
  eq('and the quiet one is cancelled', t.calls.map((call) => call.cancelled), [true, false]);

  // Slow but not quiet: the hedge fires, the first still answers first.
  t = make([{ after: 120, text: 'first answered' }, { after: 400, text: 'second answered' }]);
  result = await t.cloud.transcribe(audio);
  eq('the first answer wins even when a hedge was sent', result.text, 'first answered');
  eq('the hedge is reported without a win', [result.hedged, result.hedgeWon], [true, undefined]);
  eq('and the slower request is cancelled', t.calls.map((call) => call.cancelled), [false, true]);

  // Answers inside the allowance cost nothing extra.
  t = make([{ after: 5, text: 'quick' }, { after: 5, text: 'unused' }]);
  result = await t.cloud.transcribe(audio);
  eq('a prompt answer sends one request', t.calls.length, 1);
  eq('and is not marked hedged', result.hedged, undefined);
  await new Promise((r) => setTimeout(r, 80));
  eq('nothing is sent late either', t.calls.length, 1);

  // A failure before the hedge fires is the ordinary failure: no second request.
  t = make([{ status: 400 }], { retryWait: async () => {} });
  await assert.rejects(() => t.cloud.transcribe(audio), (err) => err.status === 400);
  eq('an early failure is not hedged', t.calls.length, 1);

  // A failure after the hedge has fired waits for the other request.
  t = make([{ after: 90, status: 400 }, { after: 5, text: 'rescued' }]);
  result = await t.cloud.transcribe(audio);
  eq('a failed first request is rescued by the hedge already in flight', result.text, 'rescued');

  // Both fail: the first one's error is reported, and a retry does not hedge again.
  t = make([{ after: 90, status: 503 }, { after: 20, status: 503 }, { after: 5, text: 'after retry' }]);
  result = await t.cloud.transcribe(audio);
  eq('after both fail the ordinary retry still runs', result.text, 'after retry');
  eq('one hedge per transcription, not one per attempt', t.calls.length, 3);
  eq('and it is reported', [result.hedged, result.retried], [true, true]);

  // Off switches: the warm-up's own request, and a base of zero.
  t = make([{ after: 120, text: 'warm' }, { after: 5, text: 'extra' }]);
  await t.cloud.transcribe({ ...audio, hedge: false });
  eq('a request that asks not to be hedged is not', t.calls.length, 1);
  t = make([{ after: 120, text: 'slow' }, { after: 5, text: 'extra' }], { hedgeMs: 0 });
  await t.cloud.transcribe(audio);
  eq('a base of zero turns hedging off', t.calls.length, 1);

  // The caller giving up stops every request in flight.
  t = make([{ hang: true }, { hang: true }]);
  const asked = new AbortController();
  const pending = t.cloud.transcribe({ ...audio, signal: asked.signal });
  await new Promise((r) => setTimeout(r, 90));
  eq('both requests are out when the caller gives up', t.calls.length, 2);
  asked.abort();
  await assert.rejects(() => pending, (err) => err.code === 'cancelled');
  eq('and both are cancelled', t.calls.map((call) => call.cancelled), [true, true]);

  // A longer clip is allowed longer before it counts as quiet.
  eq('the allowance is the base for an instant clip', hedgeAfterMs(DEFAULT_HEDGE_MS, 0), DEFAULT_HEDGE_MS);
  eq('and grows with the clip', hedgeAfterMs(DEFAULT_HEDGE_MS, 10), DEFAULT_HEDGE_MS + 1000);
  eq('up to a ceiling', hedgeAfterMs(DEFAULT_HEDGE_MS, 3600), 6000);
  eq('zero means never', hedgeAfterMs(0, 10), 0);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A stand-in provider with one script per MODEL, because the main model and the
// rescue are asked different things. A plan is as in scriptedProvider, plus
// `usage`; each model walks through its own plans, repeating the last one.
// Every call keeps its parsed body, url and headers so request shapes can be
// checked, and whether it was cancelled.
function routedProvider(scripts) {
  const calls = [];
  const used = {};
  const fetchImpl = (fetchUrl, init) => {
    const body = JSON.parse(init.body);
    const plans = scripts[body.model] || [{ hang: true }];
    const plan = plans[Math.min(used[body.model] || 0, plans.length - 1)];
    used[body.model] = (used[body.model] || 0) + 1;
    const call = { model: body.model, body, url: fetchUrl, headers: init.headers, cancelled: false, answered: false };
    calls.push(call);
    return new Promise((resolve, reject) => {
      let timer = null;
      const abort = () => {
        if (call.answered) return;
        call.cancelled = true;
        clearTimeout(timer);
        reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
      };
      if (init.signal.aborted) return abort();
      if (!plan.hang) {
        timer = setTimeout(() => {
          call.answered = true;
          const status = plan.status || 200;
          resolve({
            ok: status === 200, status, headers: { get: () => null },
            json: async () => (status === 200 ? { text: plan.text, usage: plan.usage || { seconds: 1 } } : { error: { message: 'No' } }),
          });
        }, plan.after || 0);
      }
      init.signal.addEventListener('abort', abort, { once: true });
    });
  };
  return { fetchImpl, calls };
}

// The rescue: one request to a different model when the main one has gone quiet
// or failed for a reason that is worth another try.
async function checkRescue() {
  const MAI = DEFAULT_MODEL;
  const RESCUE = DEFAULT_RESCUE_MODEL;
  const audio = { audioBase64: wav(1).toString('base64') };
  const make = (scripts, options) => {
    const provider = routedProvider(scripts);
    const cloud = createCloudTranscriber({
      apiKey: 'k', fetchImpl: provider.fetchImpl, timeoutMs: 5000, rescueMs: 60, retryWait: async () => {}, ...(options || {}),
    });
    return {
      cloud, provider,
      models: () => provider.calls.map((call) => call.model),
      cancelled: () => provider.calls.map((call) => [call.model, call.cancelled]),
    };
  };

  // The allowance, the defaults and what the options come to.
  eq('the rescue model defaults to gpt-4o-mini-transcribe', DEFAULT_RESCUE_MODEL, 'openai/gpt-4o-mini-transcribe');
  eq('and its base to four seconds', DEFAULT_RESCUE_MS, 4000);
  eq('the allowance is the base for an instant clip', rescueAfterMs(DEFAULT_RESCUE_MS, 0), 4000);
  eq('and grows 100 ms per second of audio', rescueAfterMs(DEFAULT_RESCUE_MS, 4), 4400);
  eq('up to eight seconds', rescueAfterMs(DEFAULT_RESCUE_MS, 3600), 8000);
  eq('a base above the ceiling is not cut down to it', rescueAfterMs(9000, 5), 9000);
  eq('zero, a negative or junk base means never', [rescueAfterMs(0, 10), rescueAfterMs(-5, 3), rescueAfterMs('junk', 3)], [0, 0, 0]);
  const settings = (options) => createCloudTranscriber({ apiKey: 'k', ...options }).settings;
  eq('with the defaults the rescue is on and the hedge is off',
    settings({}), { hedgeMs: 0, rescueModel: DEFAULT_RESCUE_MODEL, rescueMs: DEFAULT_RESCUE_MS });
  eq('the environment passing nothing, or empty text, is the same as the defaults',
    [settings({ hedgeMs: undefined, rescueModel: undefined, rescueMs: undefined }), settings({ hedgeMs: '', rescueMs: '' })],
    [{ hedgeMs: 0, rescueModel: DEFAULT_RESCUE_MODEL, rescueMs: DEFAULT_RESCUE_MS }, { hedgeMs: 0, rescueModel: DEFAULT_RESCUE_MODEL, rescueMs: DEFAULT_RESCUE_MS }]);
  eq('none or empty text turns the rescue off and brings the default hedge back',
    [settings({ rescueModel: 'none' }), settings({ rescueModel: '' }), settings({ rescueModel: 'NONE' })].map((s) => [s.hedgeMs, s.rescueModel]),
    [[DEFAULT_HEDGE_MS, ''], [DEFAULT_HEDGE_MS, ''], [DEFAULT_HEDGE_MS, '']]);
  eq('a base of zero turns the rescue off too', [settings({ rescueMs: 0 }).rescueModel, settings({ rescueMs: '0' }).hedgeMs], ['', DEFAULT_HEDGE_MS]);
  eq('a hedge asked for by name stays, beside the rescue', settings({ hedgeMs: 40 }), { hedgeMs: 40, rescueModel: DEFAULT_RESCUE_MODEL, rescueMs: DEFAULT_RESCUE_MS });
  eq('and zero still means no hedge', settings({ rescueModel: 'none', hedgeMs: '0' }).hedgeMs, 0);
  eq('another model can be named', settings({ rescueModel: 'other/model', rescueMs: '2500' }).rescueModel, 'other/model');

  // The main model answers before the rescue is due: nothing else is ever sent.
  let t = make({ [MAI]: [{ after: 5, text: 'quick' }], [RESCUE]: [{ after: 5, text: 'unused' }] });
  let result = await t.cloud.transcribe(audio);
  await sleep(150);
  eq('a prompt answer sends no rescue, then or later', t.models(), [MAI]);
  eq('and is returned unmarked', [result.text, result.model, result.rescued, result.rescueFired], ['quick', MAI, undefined, undefined]);

  // The main model is stuck: the rescue goes out when due and answers.
  t = make({ [MAI]: [{ hang: true }], [RESCUE]: [{ after: 5, text: 'rescued text', usage: { seconds: 2, cost: 0.0004 } }] });
  let started = Date.now();
  result = await t.cloud.transcribe(audio);
  let took = Date.now() - started;
  eq('a stuck main model is answered by the rescue', result.text, 'rescued text');
  eq('which carries its own model, billing and cost', [result.rescued, result.model, result.billedSeconds, result.cost], [true, RESCUE, 2, 0.0004]);
  ok('and went out at the allowance, not before and not much after', took >= 50 && took < 600);
  eq('it says what sent the rescue and when', [result.rescueTrigger, result.rescueFiredAtMs >= 50 && result.rescueFiredAtMs < 600, result.rescuedAfterMs >= took - 20], ['timer', true, true]);
  eq('exactly one request each, and the stuck one is cancelled', t.cancelled(), [[MAI, true], [RESCUE, false]]);
  eq('the main model was never hedged', [result.hedged, result.retried], [undefined, undefined]);
  await sleep(120);
  eq('and nothing is sent afterwards', t.models(), [MAI, RESCUE]);

  // The allowance counts the clip: a longer one is allowed longer.
  t = make({ [MAI]: [{ hang: true }], [RESCUE]: [{ after: 5, text: 'long clip' }] }, { rescueMs: 40 });
  started = Date.now();
  await t.cloud.transcribe({ ...audio, seconds: 3 });
  took = Date.now() - started;
  ok('a three second clip waits 300 ms more', took >= 330 && took < 900);

  // The main model answers after the rescue went out, before it answered.
  t = make({ [MAI]: [{ after: 120, text: 'main wins' }], [RESCUE]: [{ after: 600, text: 'too late' }] });
  result = await t.cloud.transcribe(audio);
  eq('the main answer wins over a rescue still out', [result.text, result.model, result.rescued], ['main wins', MAI, undefined]);
  eq('and says the rescue went out for nothing', [result.rescueFired, result.rescueFailed], [true, undefined]);
  eq('the rescue is cancelled', t.cancelled(), [[MAI, false], [RESCUE, true]]);

  // The rescue fails or only echoes its prompt: the main model still answers.
  for (const [label, plan, failed] of [
    ['an error', { after: 5, status: 400 }, 'HTTP 400'],
    ['a server error', { after: 5, status: 500 }, 'HTTP 500'],
    ['an echo of its prompt', { after: 5, text: 'Vocabulary: Voxden, Kharagpur' }, 'prompt echo'],
    ['an echo in other case', { after: 5, text: 'and so the VOCABULARY: voxden' }, 'prompt echo'],
    ['an empty answer', { after: 5, text: '' }, 'empty answer'],
    ['a blank answer', { after: 5, text: '  \n ' }, 'empty answer'],
  ]) {
    t = make({ [MAI]: [{ after: 200, text: 'main text' }], [RESCUE]: [plan] });
    result = await t.cloud.transcribe({ ...audio, terms: ['Voxden', 'Kharagpur'] });
    eq(label + ' from the rescue leaves the main answer to arrive', [result.text, result.rescued], ['main text', undefined]);
    eq('the failed rescue is reported and is not retried', [result.rescueFailed, t.models()], [failed, [MAI, RESCUE]]);
  }

  // The main model fails with something temporary: the rescue goes out at once.
  for (const status of [503, 429, 408, 502]) {
    t = make({ [MAI]: [{ after: 5, status }], [RESCUE]: [{ after: 40, text: 'saved ' + status }] }, { rescueMs: 10000 });
    started = Date.now();
    result = await t.cloud.transcribe(audio);
    took = Date.now() - started;
    eq('a ' + status + ' sends the rescue without waiting for its clock', [result.text, result.rescued, result.rescueTrigger], ['saved ' + status, true, 'error']);
    ok('within a moment, not ten seconds', took < 800);
    eq('the rescue goes out on the first failure, and the main model still uses its attempts', t.models(), [MAI, RESCUE, MAI, MAI]);
  }
  // An unreachable provider is the same.
  {
    const calls = [];
    const cloud = createCloudTranscriber({ apiKey: 'k', timeoutMs: 2000, rescueMs: 10000, retryWait: async () => {},
      fetchImpl: async (_url, init) => {
        const model = JSON.parse(init.body).model;
        calls.push(model);
        if (model === MAI) throw new TypeError('fetch failed');
        return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ text: 'reached', usage: { seconds: 1 } }) };
      } });
    result = await cloud.transcribe(audio);
    eq('an unreachable main model sends the rescue at once too', [result.text, result.rescued, calls.filter((m) => m === RESCUE).length], ['reached', true, 1]);
  }
  // It does not wait for the first one's retries to run out first.
  let backoffEnded = false;
  t = make({ [MAI]: [{ after: 5, status: 503 }], [RESCUE]: [{ after: 20, text: 'during backoff' }] }, {
    rescueMs: 10000,
    retryWait: (_ms, signal) => new Promise((_resolve, reject) => { signal.addEventListener('abort', () => { backoffEnded = true; reject(new Error('Aborted')); }, { once: true }); }),
  });
  result = await t.cloud.transcribe(audio);
  eq('a rescue that answers during the main model backoff wins', [result.text, result.rescued], ['during backoff', true]);
  eq('and ends the backoff', [backoffEnded, t.models()], [true, [MAI, RESCUE]]);
  // The main model recovers on its retry before the rescue answers.
  t = make({ [MAI]: [{ after: 5, status: 503 }, { after: 120, text: 'main again' }], [RESCUE]: [{ after: 500, text: 'slow rescue' }] }, { rescueMs: 10000 });
  result = await t.cloud.transcribe(audio);
  eq('a main model that recovers beats a rescue still out', [result.text, result.model, result.retried, result.rescueFired, result.rescued], ['main again', MAI, true, true, undefined]);
  eq('and cancels it', t.cancelled(), [[MAI, false], [RESCUE, true], [MAI, false]]);
  // Everything temporary fails and the rescue fails too: the main error stands.
  t = make({ [MAI]: [{ after: 5, status: 503 }], [RESCUE]: [{ after: 30, status: 500 }] }, { rescueMs: 10000 });
  await assert.rejects(() => t.cloud.transcribe(audio), (err) => err.status === 503 && err.code === 'upstream');
  eq('both failing reports the main model failure, after trying the rescue once', t.models(), [MAI, RESCUE, MAI, MAI]);
  // The main model gives up while the rescue is still out: its answer is awaited.
  t = make({ [MAI]: [{ after: 5, status: 429 }], [RESCUE]: [{ after: 150, text: 'last hope' }] }, { rescueMs: 10000 });
  result = await t.cloud.transcribe(audio);
  eq('a main model out of retries leaves the rescue to answer', [result.text, result.rescued, result.rescueTrigger], ['last hope', true, 'error']);
  // The dictionary list the main model refused still goes to the rescue.
  t = make({ [MAI]: [{ after: 5, status: 400 }, { hang: true }], [RESCUE]: [{ after: 5, text: 'with hints' }] });
  result = await t.cloud.transcribe({ ...audio, terms: ['Voxden'] });
  eq('a refused phrase list is dropped for the main model only', [t.provider.calls[0].body.provider !== undefined, t.provider.calls[1].body.provider], [true, undefined]);
  eq('the rescue still carries the dictionary', [result.rescued, result.hintsDropped, t.provider.calls[2].body.provider.options.openai.prompt], [true, true, 'Vocabulary: Voxden']);

  // Anything else the main model refuses is the answer today, rescue or no rescue.
  for (const status of [400, 401, 403, 404, 413, 422]) {
    t = make({ [MAI]: [{ after: 1, status }], [RESCUE]: [{ after: 5, text: 'unwanted' }] }, { rescueMs: 80 });
    await assert.rejects(() => t.cloud.transcribe(audio), (err) => err.status === status);
    await sleep(150);
    eq('a ' + status + ' is thrown as before, with no rescue before or after', t.models(), [MAI]);
  }
  t = make({ [MAI]: [{ after: 1, status: 400 }, { after: 1, status: 400 }], [RESCUE]: [{ after: 5, text: 'unwanted' }] }, { rescueMs: 80 });
  await assert.rejects(() => t.cloud.transcribe({ ...audio, terms: ['Voxden'] }), (err) => err.status === 400);
  await sleep(150);
  eq('a 400 after the phrase list was dropped is thrown, with no rescue', [t.models(), t.provider.calls[1].body.provider], [[MAI, MAI], undefined]);
  t = make({ [MAI]: [{ after: 100, status: 400 }], [RESCUE]: [{ hang: true }] }, { rescueMs: 30 });
  await assert.rejects(() => t.cloud.transcribe(audio), (err) => err.status === 400);
  eq('a refusal while the rescue is out is thrown at once and cancels it', t.cancelled(), [[MAI, false], [RESCUE, true]]);

  // Cancellation by the caller, before and after the rescue went out.
  t = make({ [MAI]: [{ hang: true }], [RESCUE]: [{ hang: true }] }, { rescueMs: 100 });
  let asked = new AbortController();
  let pending = t.cloud.transcribe({ ...audio, signal: asked.signal });
  await sleep(30);
  asked.abort();
  await assert.rejects(() => pending, (err) => err.code === 'cancelled');
  await sleep(150);
  eq('giving up before the rescue is due means it is never sent', [t.models(), t.cancelled()], [[MAI], [[MAI, true]]]);
  t = make({ [MAI]: [{ hang: true }], [RESCUE]: [{ hang: true }] });
  asked = new AbortController();
  pending = t.cloud.transcribe({ ...audio, signal: asked.signal });
  await sleep(130);
  eq('both requests are out when the caller gives up', t.models(), [MAI, RESCUE]);
  asked.abort();
  await assert.rejects(() => pending, (err) => err.code === 'cancelled');
  eq('and both are cancelled', t.cancelled(), [[MAI, true], [RESCUE, true]]);

  // The deadline still bounds everything.
  t = make({ [MAI]: [{ hang: true }], [RESCUE]: [{ hang: true }] }, { timeoutMs: 400, rescueMs: 50 });
  started = Date.now();
  await assert.rejects(() => t.cloud.transcribe(audio), (err) => err.code === 'timeout' && err.message === 'The speech model did not answer in time.');
  took = Date.now() - started;
  ok('both stalling hits the deadline and no later', took >= 350 && took < 1200);
  eq('with both requests cancelled', t.cancelled(), [[MAI, true], [RESCUE, true]]);
  // A temporary failure that lands with no time left sends no rescue: the clock
  // is moved past the deadline inside the main model's answer.
  {
    const realNow = Date.now;
    let clock = 5e6;
    Date.now = () => clock;
    try {
      const calls = [];
      const cloud = createCloudTranscriber({ apiKey: 'k', timeoutMs: 500, rescueMs: 10000, retryWait: async () => {},
        fetchImpl: async (_url, init) => {
          calls.push(JSON.parse(init.body).model);
          clock += 1000;
          return { ok: false, status: 503, headers: { get: () => null }, json: async () => ({ error: { message: 'No' } }) };
        } });
      await assert.rejects(() => cloud.transcribe(audio), (err) => err.status === 503);
      eq('and a failure with nothing left of the deadline sends no rescue', calls, [MAI]);
    } finally {
      Date.now = realNow;
    }
  }

  // Off switches: the model, and the warm-up.
  t = make({ [MAI]: [{ hang: true }, { after: 5, text: 'second answered' }], [RESCUE]: [{ after: 5, text: 'unused' }] }, { rescueModel: 'none', hedgeMs: 40 });
  result = await t.cloud.transcribe(audio);
  eq('with the rescue off the hedge runs as it always did', [result.text, result.hedged, result.hedgeWon, t.models()], ['second answered', true, true, [MAI, MAI]]);
  t = make({ [MAI]: [{ after: 5, status: 503 }, { after: 5, text: 'retried' }], [RESCUE]: [{ after: 5, text: 'unused' }] }, { rescueModel: '' });
  result = await t.cloud.transcribe(audio);
  eq('and a temporary failure is retried as it always was', [result.text, result.retried, result.rescued, t.models()], ['retried', true, undefined, [MAI, MAI]]);
  t = make({ [MAI]: [{ hang: true }], [RESCUE]: [{ after: 5, text: 'unused' }] }, { rescueMs: 0, timeoutMs: 200 });
  await assert.rejects(() => t.cloud.transcribe(audio), (err) => err.code === 'timeout');
  eq('a base of zero sends no rescue', t.models(), [MAI]);
  t = make({ [MAI]: [{ hang: true }], [RESCUE]: [{ after: 5, text: 'unused' }] }, { timeoutMs: 300 });
  eq('the warm-up that times out sends no rescue', [await t.cloud.warmUp(), t.models()], [false, [MAI]]);
  t = make({ [MAI]: [{ after: 5, status: 503 }], [RESCUE]: [{ after: 5, text: 'unused' }] });
  eq('nor does one the provider refuses', [await t.cloud.warmUp(), t.models()], [false, [MAI, MAI, MAI]]);
  t = make({ [MAI]: [{ hang: true }], [RESCUE]: [{ after: 5, text: 'unused' }] }, { timeoutMs: 300 });
  await assert.rejects(() => t.cloud.transcribe({ ...audio, rescue: false }), (err) => err.code === 'timeout');
  eq('a request can ask not to be rescued', t.models(), [MAI]);

  // Both asked for by name: both run, and the hedge is still one per clip.
  t = make({ [MAI]: [{ hang: true }, { hang: true }], [RESCUE]: [{ after: 5, text: 'beside the hedge' }] }, { hedgeMs: 30, rescueMs: 100 });
  result = await t.cloud.transcribe(audio);
  eq('with a hedge named, both run', [result.text, result.rescued, result.hedged], ['beside the hedge', true, true]);
  eq('one hedge and one rescue, everything else cancelled', t.cancelled(), [[MAI, true], [MAI, true], [RESCUE, false]]);
  t = make({ [MAI]: [{ after: 60, status: 503 }, { after: 60, status: 503 }, { after: 5, text: 'main ok' }], [RESCUE]: [{ hang: true }] }, { hedgeMs: 20, rescueMs: 10000 });
  result = await t.cloud.transcribe(audio);
  eq('a retry does not hedge again, and the rescue is only ever one request',
    [result.text, result.hedged, result.retried, result.rescueFired, t.models()], ['main ok', true, true, true, [MAI, MAI, RESCUE, MAI]]);
  eq('and is cancelled when the main model answers', t.provider.calls[2].cancelled, true);

  // What goes up.
  const url = 'https://upstream.test/audio/transcriptions';
  t = make({ [MAI]: [{ hang: true }], [RESCUE]: [{ after: 5, text: 'shape' }] }, { upstreamUrl: url });
  await t.cloud.transcribe({ ...audio, language: 'hi', terms: ['Voxden', ' Kharagpur ', '', 'Ashwini'] });
  const [mainCall, rescueCall] = t.provider.calls;
  eq('the rescue goes to the same endpoint with the same key and headers', [rescueCall.url, rescueCall.headers], [url, mainCall.headers]);
  eq('as a bearer of the server key', rescueCall.headers.Authorization, 'Bearer k');
  eq('the rescue body is the model, the audio, the language and the dictionary as a prompt', rescueCall.body, {
    model: 'openai/gpt-4o-mini-transcribe',
    input_audio: mainCall.body.input_audio,
    language: 'hi',
    provider: { options: { openai: { prompt: 'Vocabulary: Voxden, Kharagpur, Ashwini' } } },
  });
  ok('with nothing of the main model\'s phrase list', !/phraseList|azure|phrases/.test(JSON.stringify(rescueCall.body)));
  eq('while the main model keeps its own', mainCall.body.provider, { options: { azure: { phraseList: { phrases: ['Voxden', 'Kharagpur', 'Ashwini'] } } } });
  t = make({ [MAI]: [{ hang: true }], [RESCUE]: [{ after: 5, text: 'bare' }] });
  await t.cloud.transcribe(audio);
  eq('without terms or a language the rescue sends neither', Object.keys(t.provider.calls[1].body), ['model', 'input_audio']);
  const names = Array.from({ length: MAX_PHRASES + 20 }, (_, i) => 'Name' + String(i).padStart(3, '0') + '-' + 'x'.repeat(30));
  t = make({ [MAI]: [{ hang: true }], [RESCUE]: [{ after: 5, text: 'capped' }] });
  await t.cloud.transcribe({ ...audio, terms: names });
  const prompt = t.provider.calls[1].body.provider.options.openai.prompt;
  const used = prompt.split(', ').length;
  ok('a long dictionary is cut to at most ' + RESCUE_PROMPT_MAX + ' characters', prompt.length <= RESCUE_PROMPT_MAX && prompt.length > RESCUE_PROMPT_MAX - 60);
  eq('on a term boundary, in the app\'s order', prompt, 'Vocabulary: ' + names.slice(0, used).join(', '));
  ok('where the next term would not have fitted', ('Vocabulary: ' + names.slice(0, used + 1).join(', ')).length > RESCUE_PROMPT_MAX && used < MAX_PHRASES);
  eq('while the main model still gets its whole list', t.provider.calls[0].body.provider.options.azure.phraseList.phrases, names.slice(0, MAX_PHRASES));
}

// The relay in front of it: what the app is told and what the log says.
async function checkRescueInRelay() {
  const MAI = DEFAULT_MODEL;
  const RESCUE = DEFAULT_RESCUE_MODEL;
  const provider = routedProvider({
    // One entry per request, in order: stuck, then slow, then quick.
    [MAI]: [{ hang: true }, { after: 400, text: 'main answered' }, { after: 5, text: 'quick answer' }],
    [RESCUE]: [{ after: 5, text: 'saved by the rescue', usage: { seconds: 3, cost: 0.0003 } }, { hang: true }],
  });
  const logs = [];
  const now = Date.now();
  const store = createStore(':memory:');
  const cloud = createCloudTranscriber({ apiKey: 'k', fetchImpl: provider.fetchImpl, timeoutMs: 2000, rescueMs: 40 });
  const app = createApp({ store, mailer: { sendCode: async () => {} }, now: () => now, cloudHoursCap: 10, cloudTrialCredits: 0, cloud, log: (line) => logs.push(String(line)) });
  const server = http.createServer(app.handle);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port + '/v1';
  const crypto = require('crypto');
  const user = store.findOrCreateUser('second@example.com', new Date(now).toISOString());
  store.setPlan('second@example.com', 'pro', new Date(now + 86400000).toISOString());
  const token = 'tok_' + crypto.randomBytes(24).toString('hex');
  store.createSession({ tokenHash: crypto.createHash('sha256').update(token).digest('hex'), userId: user.id, device: 'test', createdAt: new Date(now).toISOString() });
  const month = creditMonthOf(0, now);
  const usage = () => store.usageSecondsBetween(user.id, dayOf(month.start), dayOf(month.end));
  const send = async () => {
    const res = await fetch(base + '/transcribe', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ audio: wav(1).toString('base64'), format: 'wav', terms: ['Voxden'] }) });
    return { status: res.status, body: await res.json() };
  };
  const lastLog = () => logs.filter((line) => line.includes('cloud transcribed')).pop() || '';
  try {
    let reply = await send();
    eq('a rescued clip is answered', [reply.status, reply.body.text], [200, 'saved by the rescue']);
    eq('and the reply says it was rescued', [reply.body.timing.rescued, reply.body.timing.hedged, reply.body.timing.retried], [true, false, false]);
    ok('the log says who rescued it and when', /rescued by openai\/gpt-4o-mini-transcribe after \d+\.\ds \(sent at \d+\.\ds when the main model went quiet\)/.test(lastLog()));
    ok('and what the winner cost', lastLog().includes('$0.0003'));
    eq('the user is charged the rescue\'s audio seconds, like any answer', usage(), 3);
    ok('with no mention of a hedge or a recovery', !/hedge|recovered/.test(lastLog()));

    reply = await send();
    eq('a clip the main model answers is not marked', [reply.body.text, reply.body.timing.rescued], ['main answered', false]);
    ok('and the log says the rescue went out for nothing', lastLog().includes('rescue fired but the main model answered first') && !lastLog().includes('rescued by'));

    reply = await send();
    eq('a prompt answer carries no rescue', [reply.body.text, reply.body.timing.rescued], ['quick answer', false]);
    ok('and the log is silent about it', !/rescue/.test(lastLog()));
    eq('requests sent: main x3, rescue x2', provider.calls.map((call) => call.model), [MAI, RESCUE, MAI, RESCUE, MAI]);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    store.close();
  }
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

// While the user records, the app asks for a warm-up every 2.5 s. Each ask must
// reach the model unless something answered within WARM_FRESH_MS, a real clip
// included, so the model is warm at stop without paying for redundant clips.
async function testKeepWarm() {
  const realNow = Date.now;
  let clock = 1e6;
  Date.now = () => clock;
  try {
    const { calls, fetchImpl } = scriptedProvider([{ after: 0, text: '' }]);
    const cloud = createCloudTranscriber({ apiKey: 'test-key', fetchImpl });
    ok('the relay forgets warmth sooner than the app asks again', WARM_FRESH_MS < 2500);
    eq('a warm-up reaches the model', [await cloud.warmUp(), calls.length], [true, 1]);
    clock += 200;
    eq('a second hotkey tap moments later does not', [await cloud.warmUp(), calls.length], [true, 1]);
    clock += 2500;
    eq('the next ask during recording does', [await cloud.warmUp(), calls.length], [true, 2]);
    clock += 2500;
    await cloud.transcribe({ audioBase64: wav(1).toString('base64'), seconds: 1, hedge: false });
    eq('a real clip goes up', calls.length, 3);
    clock += 1000;
    eq('and a warm-up right after it is skipped', [await cloud.warmUp(), calls.length], [true, 3]);
  } finally {
    Date.now = realNow;
  }
}

// A big dictionary goes up as its top MAX_PHRASES terms, in the app's order.
async function testHintCap() {
  const bodies = [];
  const cloud = createCloudTranscriber({ apiKey: 'test-key', fetchImpl: async (_url, req) => {
    bodies.push(JSON.parse(req.body));
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ text: 'ok' }) };
  } });
  const terms = Array.from({ length: 150 }, (_, i) => 'Term' + i);
  await cloud.transcribe({ audioBase64: wav(1).toString('base64'), seconds: 1, hedge: false, terms });
  eq('the relay sends up to 100 hints', MAX_PHRASES, 100);
  eq('a 150-term dictionary sends its top 100, in order',
    bodies[0].provider.options.azure.phraseList.phrases, terms.slice(0, MAX_PHRASES));
}

async function main() {
  // --- pure pieces ----------------------------------------------------------
  eq('a ten second clip measures ten seconds', wavSeconds(wav(10)), 10);
  eq('junk measures zero', wavSeconds(Buffer.from('not a wav at all, really')), 0);
  const inflated = wav(60);
  inflated.writeUInt32LE(16000 * 2 * 100, 28);
  eq('a byte rate inflated to under-count the clip is refused, not believed', wavSeconds(inflated), 0);
  const stereo48k = wav(1);
  stereo48k.writeUInt16LE(2, 22); stereo48k.writeUInt32LE(48000, 24); stereo48k.writeUInt32LE(48000 * 4, 28); stereo48k.writeUInt16LE(4, 32);
  eq('an honest header of another shape still measures', wavSeconds(stereo48k), 32000 / (48000 * 4));
  ok('the desktop deadline leaves room for the relay recovery budget and is bounded',
    cloudTimeoutMs(0) > 20000 && cloudTimeoutMs(10) > cloudTimeoutMs(0) && cloudTimeoutMs(1000) === 40000);
  const pro = { signedIn: true, plan: 'pro', cloud: { hoursUsed: 1, hoursCap: 10 } };
  eq('off means off', shouldTryCloud({ enabled: false, account: pro, audioSeconds: 5 }).reason, 'off');
  eq('signed out is named', shouldTryCloud({ enabled: true, account: { signedIn: false }, audioSeconds: 5 }).reason, 'signed-out');
  eq('free is named', shouldTryCloud({ enabled: true, account: { ...pro, plan: 'free' }, audioSeconds: 5 }).reason, 'plan');
  eq('a used-up month is named', shouldTryCloud({ enabled: true, account: { ...pro, cloud: { hoursUsed: 10, hoursCap: 10 } }, audioSeconds: 5 }).reason, 'cap');
  eq('a blip is not worth a round trip', shouldTryCloud({ enabled: true, account: pro, audioSeconds: 0.1 }).reason, 'short');
  eq('otherwise go', shouldTryCloud({ enabled: true, account: pro, audioSeconds: 5 }).ok, true);
  await checkResponseDeadlines();
  await checkHedging();
  await checkRescue();
  await checkRescueInRelay();
  await require('./test-cloud-recovery')();
  await require('./test-cloud-reservations')();

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
      const answer = () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ text: 'hello from the cloud', usage: { seconds: 4.5, total_tokens: 12, cost: 0.000125 } }));
      };
      // Answers, but long after the app's deadline.
      if (upstreamMode === 'slow') return void setTimeout(answer, 250);
      answer();
    });
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const upstreamUrl = 'http://127.0.0.1:' + upstream.address().port + '/audio/transcriptions';

  // --- the service ------------------------------------------------------------
  let clock = Date.parse('2026-09-11T09:00:00Z');
  const store = createStore(':memory:');
  const cloud = createCloudTranscriber({ apiKey: 'sk-test', model: 'test/model', upstreamUrl, timeoutMs: 300 });
  // The free trial is off here: this test pins what a free account is refused
  // when there is none (scripts/test-cloud-trial.js covers the trial).
  const app = createApp({ store, mailer: { sendCode: async () => {} }, now: () => clock, cloudHoursCap: 10, cloudTrialCredits: 0, cloud });
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
  // Seconds metered in the calendar month the clock is in: this account has no
  // subscription, so that is its credit month.
  const monthUsage = (id) => {
    const month = creditMonthOf(0, clock);
    return store.usageSecondsBetween(id, dayOf(month.start), dayOf(month.end));
  };

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
    eq('usage is recorded on the account', monthUsage(user.id), 5);

    // Metering is from the header, checked before the call.
    store.addUsageSeconds(user.id, dayOf(clock), 10 * 3600 - 6);
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
    eq('and is not charged', monthUsage(user.id), 5);
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

    // --- a clip the app stopped waiting for -----------------------------------
    // The model sometimes answers after the app has given up and told the
    // user it timed out. Those words reach nobody, so they are not charged.
    upstreamMode = 'slow';
    const beforeAbandon = monthUsage(store.userByEmail('pro@example.com').id);
    const controller = new AbortController();
    const abandoned = fetch(base + '/transcribe', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ audio: wav(4).toString('base64'), format: 'wav' }),
      signal: controller.signal,
    });
    // Long enough for the service to forward the clip, sooner than the answer.
    await new Promise((r) => setTimeout(r, 60));
    controller.abort();
    await assert.rejects(() => abandoned, (err) => err.name === 'AbortError');
    // Let the slow answer land and the service finish with it.
    await new Promise((r) => setTimeout(r, 400));
    eq('a clip the app gave up on is not charged',
      monthUsage(store.userByEmail('pro@example.com').id), beforeAbandon);
    upstreamMode = 'ok';
    const afterAbandon = await client.transcribe(wav(4), { audioSeconds: 4 });
    eq('and the next clip still works', afterAbandon.text, 'hello from the cloud');
    ok('and is charged as usual',
      monthUsage(store.userByEmail('pro@example.com').id) > beforeAbandon);

    // --- clips fired together to race the credit check -----------------------
    upstreamMode = 'slow';
    const burst = await Promise.all([1, 2, 3, 4].map(() => fetch(base + '/transcribe', {
      method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ audio: wav(1).toString('base64'), format: 'wav' }),
    }).then(async (res) => [res.status, (await res.json()).code || ''])));
    eq('three clips at once run, a fourth is refused as busy',
      burst.map((r) => r.join(' ')).sort(), ['200 ', '200 ', '200 ', '429 busy']);
    upstreamMode = 'ok';
    eq('once they finish, the next clip runs', (await client.transcribe(wav(1), { audioSeconds: 1 })).text, 'hello from the cloud');

    // --- the warm-up a recording start asks for ---------------------------------
    // A clip was answered just now, so the model is already warm: a warm-up is
    // a yes without a silent clip until that has gone stale.
    const beforeFresh = upstreamCalls.length;
    eq('a warm-up just after a real clip is a yes', await client.warm(), true);
    await new Promise((r) => setTimeout(r, 50));
    eq('that costs no silent clip', upstreamCalls.length, beforeFresh);
    await new Promise((r) => setTimeout(r, WARM_FRESH_MS + 50));
    const upstreamBefore = upstreamCalls.length;
    const usageBeforeWarm = monthUsage(store.userByEmail('pro@example.com').id);
    eq('a Pro client gets a yes for a warm-up', await client.warm(), true);
    // The relay answers before the model does; give the silent clip time to land.
    for (let i = 0; i < 30 && upstreamCalls.length === upstreamBefore; i++) await new Promise((r) => setTimeout(r, 10));
    eq('the upstream saw one silent clip', upstreamCalls.length, upstreamBefore + 1);
    eq('of a third of a second', upstreamCalls[upstreamBefore].bytes, 44 + 0.3 * 16000 * 2);
    eq('with no hints', upstreamCalls[upstreamBefore].phrases, null);
    eq('and nothing is metered for it', monthUsage(store.userByEmail('pro@example.com').id), usageBeforeWarm);
    eq('a second warm-up moments later is answered from the first', await client.warm(), true);
    await new Promise((r) => setTimeout(r, 50));
    eq('without another upstream call', upstreamCalls.length, upstreamBefore + 1);
    store.findOrCreateUser('free@example.com', new Date(clock).toISOString());
    const freeClient = new CloudTranscriber({ baseUrl: base, token: () => tokenFor('free@example.com') });
    eq('a free account is told no', await freeClient.warm(), false);
    eq('a signed-out client is told no without a request', await new CloudTranscriber({ baseUrl: base, token: () => '' }).warm(), false);
    await new Promise((r) => setTimeout(r, 50));
    eq('and neither reached the model', upstreamCalls.length, upstreamBefore + 1);

    // No key configured.
    const bare = createApp({ store, mailer: { sendCode: async () => {} }, now: () => clock });
    const bareServer = http.createServer(bare.handle);
    await new Promise((r) => bareServer.listen(0, '127.0.0.1', r));
    const bareClient = new CloudTranscriber({ baseUrl: 'http://127.0.0.1:' + bareServer.address().port + '/v1', token: () => token });
    await assert.rejects(() => bareClient.transcribe(wav(2), { audioSeconds: 2 }), (err) => err.code === 'unconfigured' && err.status === 503);
    ok('a service with no model key says so', true);
    eq('and declines a warm-up', await bareClient.warm(), false);
    bareServer.close();
  } finally {
    server.close();
    upstream.closeAllConnections();
    upstream.close();
    store.close();
  }
  process.stdout.write('all ' + checks + ' cloud relay checks passed\n');
}

testKeepWarm().then(testHintCap).then(main).catch((err) => { console.error(err); process.exitCode = 1; });
