'use strict';

// The relay's language rules (server/cloud.js resolveLanguage, applied by
// /v1/transcribe in server/app.js), over real HTTP with an in-memory database.
// While the configured model is AssemblyAI's, a language it cannot take is
// refused before any provider is called and before anything is reserved or
// charged, and the 'nb' that apps up to 2.1.9 send for Norwegian reaches it as
// 'no'. Any other model family is forwarded the language exactly as before.
// Runs inside scripts/test-cloud-relay.js, or alone.

const assert = require('assert');
const http = require('http');
const crypto = require('crypto');
const { createStore } = require('../server/store');
const { createApp } = require('../server/app');
const { createCloudTranscriber, resolveLanguage, languageFor, ASSEMBLYAI_LANGUAGES, GENERAL_LANGUAGES } = require('../server/cloud');
const { CloudTranscriber } = require('../src/cloud');

const AAI = 'assemblyai/universal-3-5-pro';
const MAI = 'microsoft/mai-transcribe-2';
// The 18 languages of Universal-3.5 Pro, each accepted with HTTP 200 when sent
// through OpenRouter on 2026-10-14. Spelled out here so that a change to the
// list in server/cloud.js has to be made twice, on purpose.
const ACCEPTED = ['en', 'es', 'fr', 'de', 'it', 'pt', 'ar', 'da', 'nl', 'fi', 'he', 'hi', 'ja', 'zh', 'no', 'sv', 'tr', 'vi'];
// Refused with HTTP 400 on the same day (nb, iw, zh-CN, bn), and the languages
// the app's menu used to offer that the model does not speak.
const REFUSED = ['nb-NO', 'iw', 'zh-CN', 'bn', 'ta', 'ko', 'yue', 'fil', 'th', 'ru', 'pl', 'hg', 'klingon', 'e', 'english', '__proto__', 'constructor'];

let checks = 0;
function eq(label, actual, expected) {
  assert.deepStrictEqual(actual, expected, label + '\n  got: ' + JSON.stringify(actual));
  checks += 1;
}

function audio(seconds) {
  const bytes = Math.round(seconds * 32000), header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(36 + bytes, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22); header.writeUInt32LE(16000, 24); header.writeUInt32LE(32000, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(bytes, 40);
  return Buffer.concat([header, Buffer.alloc(bytes)]);
}

function checkTable() {
  eq('AssemblyAI takes 18 languages', [ASSEMBLYAI_LANGUAGES.length, new Set(ASSEMBLYAI_LANGUAGES).size], [18, 18]);
  eq('and they are the 18 verified live', [...ASSEMBLYAI_LANGUAGES].sort(), [...ACCEPTED].sort());
  eq('the general table is the 60 the relay always forwarded', [GENERAL_LANGUAGES.length, new Set(GENERAL_LANGUAGES).size], [60, 60]);
  for (const code of ACCEPTED) {
    eq('AssemblyAI: ' + code + ' goes up as it is', resolveLanguage(AAI, code), { language: code });
  }
  eq('AssemblyAI: Norwegian from an old app (nb) goes up as no', resolveLanguage(AAI, 'nb'), { language: 'no' });
  eq('case and spaces do not matter', [resolveLanguage(AAI, ' NB '), resolveLanguage(AAI, 'Hi')], [{ language: 'no' }, { language: 'hi' }]);
  for (const empty of [undefined, null, '', '   ', 'auto', 'AUTO', 0]) {
    eq('AssemblyAI: ' + JSON.stringify(empty) + ' means detect, not a refusal', resolveLanguage(AAI, empty), { language: '' });
  }
  for (const code of REFUSED) {
    eq('AssemblyAI: ' + code + ' is refused', resolveLanguage(AAI, code), { refused: true });
  }
  eq('the family is read from the model name, any case',
    [resolveLanguage('AssemblyAI/universal-3-5-pro', 'bn'), resolveLanguage(' assemblyai/universal-4', 'bn')], [{ refused: true }, { refused: true }]);

  // Any other model: what the relay did before, nothing refused.
  for (const model of [MAI, 'test/model', 'openai/gpt-4o-mini-transcribe', '', undefined]) {
    const label = 'model ' + JSON.stringify(model) + ': ';
    eq(label + 'Bengali is forwarded', resolveLanguage(model, 'bn'), { language: 'bn' });
    eq(label + 'Norwegian as the general table spells it is forwarded', resolveLanguage(model, 'nb'), { language: 'nb' });
    eq(label + 'Norwegian from a new app (no) reaches that spelling', resolveLanguage(model, 'no'), { language: 'nb' });
    eq(label + 'Cantonese and Filipino are forwarded', [resolveLanguage(model, 'yue'), resolveLanguage(model, 'fil')], [{ language: 'yue' }, { language: 'fil' }]);
    eq(label + 'a code in no table is dropped to detect, as before', [resolveLanguage(model, 'klingon'), resolveLanguage(model, 'hg'), resolveLanguage(model, 'constructor')],
      [{ language: '' }, { language: '' }, { language: '' }]);
    eq(label + 'empty and auto detect', [resolveLanguage(model, ''), resolveLanguage(model, 'auto')], [{ language: '' }, { language: '' }]);
  }
  for (const code of ACCEPTED.filter((c) => c !== 'no')) {
    assert.ok(GENERAL_LANGUAGES.includes(code), code + ' is in the general table too');
  }

  // Each upstream request spells the settled code its own model's way
  // (languageFor). New with dictation lanes, where MAI as the body model and
  // its AssemblyAI rescue answer the same clip: before, the rescue was sent the
  // main model's code, and AssemblyAI refused MAI's 'nb' with a 400.
  eq('MAI gets Norwegian as nb, AssemblyAI as no, from either spelling',
    [languageFor(MAI, 'no'), languageFor(MAI, 'nb'), languageFor(AAI, 'no'), languageFor(AAI, 'nb')], ['nb', 'nb', 'no', 'no']);
  eq('an OpenAI model is sent the code as it came (the GPT rescue keeps the main model code)',
    [languageFor('openai/gpt-4o-mini-transcribe', 'no'), languageFor('openai/gpt-4o-mini-transcribe', 'nb'), languageFor('openai/gpt-4o-mini-transcribe', 'klingon')], ['no', 'nb', 'klingon']);
  eq('a code a model refuses goes up as it is, for the model to refuse as before', languageFor(AAI, 'bn'), 'bn');
  eq('nothing stays nothing', [languageFor(AAI, ''), languageFor(MAI, undefined), languageFor(MAI, '')], ['', '', '']);
  for (const code of ACCEPTED) {
    eq('an AssemblyAI code is settled already: ' + code, languageFor(AAI, code), code);
    eq('and MAI takes it too: ' + code, languageFor(MAI, code), code === 'no' ? 'nb' : code);
  }
}

module.exports = async function testCloudLanguage() {
  checkTable();

  let clock = Date.parse('2026-10-14T12:00:00Z');
  const store = createStore(':memory:');
  const heard = [];
  const stand = (model) => ({
    configured: true,
    ...(model === undefined ? {} : { model }),
    transcribe: async (request) => {
      heard.push({ model, language: request.language, seconds: request.seconds });
      return { text: 'heard', billedSeconds: Math.max(1, Math.round(request.seconds)), cost: 0 };
    },
  });
  const servers = [];
  const users = [];
  async function relayFor(cloud, options) {
    const app = createApp({ store, mailer: { sendCode: async () => {} }, now: () => clock, cloud, ...(options || {}) });
    const server = http.createServer(app.handle);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    servers.push(server);
    return 'http://127.0.0.1:' + server.address().port + '/v1';
  }
  function account(email) {
    const user = store.findOrCreateUser(email, new Date(clock).toISOString());
    store.setPlan(email, 'pro', '2027-01-01T00:00:00.000Z');
    const token = crypto.randomBytes(24).toString('hex');
    store.createSession({ tokenHash: crypto.createHash('sha256').update(token).digest('hex'),
      userId: user.id, device: 'test', createdAt: new Date(clock).toISOString() });
    users.push(user);
    return { ...user, token };
  }
  async function post(base, user, seconds, language) {
    const body = { audio: audio(seconds).toString('base64'), format: 'wav' };
    if (language !== undefined) body.language = language;
    const res = await fetch(base + '/transcribe', { method: 'POST',
      headers: { Authorization: 'Bearer ' + user.token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  }

  try {
    // --- an AssemblyAI main model ----------------------------------------------
    const aaiBase = await relayFor(stand(AAI), { cloudCreditsCap: 900 });
    const pro = account('language-aai@example.com');

    for (const code of ACCEPTED) {
      heard.length = 0;
      const reply = await post(aaiBase, pro, 1, code);
      eq(code + ' is accepted', reply.status, 200);
      eq(code + ' reaches the model as ' + code, heard.map((h) => h.language), [code]);
    }
    heard.length = 0;
    const norwegian = await post(aaiBase, pro, 1, 'nb');
    eq('an app up to 2.1.9 that sends nb still gets Norwegian', [norwegian.status, norwegian.body.text, heard.map((h) => h.language)], [200, 'heard', ['no']]);
    heard.length = 0;
    eq('no language is unchanged: the model detects', [(await post(aaiBase, pro, 1)).status, heard.map((h) => h.language)], [200, ['']]);
    heard.length = 0;
    eq('so is the word auto', [(await post(aaiBase, pro, 1, 'auto')).status, heard.map((h) => h.language)], [200, ['']]);

    const usedBefore = store.usageSecondsTotal(pro.id);
    heard.length = 0;
    for (const code of ['bn', 'ta', 'ko', 'yue', 'hg', 'zh-CN', 'nb-NO', 'klingon']) {
      const reply = await post(aaiBase, pro, 30, code);
      eq(code + ' is refused with a 400 and code language', [reply.status, reply.body.code], [400, 'language']);
      eq(code + ' is told plainly', reply.body.error, "Voxden Cloud doesn't support that language yet.");
    }
    eq('a refused language reaches no model', heard.length, 0);
    eq('and charges nothing', store.usageSecondsTotal(pro.id), usedBefore);
    eq('the refusal fits the 56 characters an app up to 2.1.9 shows as it is', "Voxden Cloud doesn't support that language yet.".length <= 56, true);

    // A refusal is decided before the clip is measured or reserved: a run of
    // them leaves a one-minute account its whole minute.
    const tight = await relayFor(stand(AAI), { cloudCreditsCap: 1, cloudCreditsReset: 'never' });
    const small = account('language-tight@example.com');
    for (let i = 0; i < 5; i++) eq('refusal ' + (i + 1) + ' on a one-minute account', (await post(tight, small, 30, 'bn')).body.code, 'language');
    heard.length = 0;
    const whole = await post(tight, small, 50, 'en');
    eq('the whole allowance is still there afterwards', [whole.status, heard.length], [200, 1]);

    // A free account with no trial is refused for its plan first, as before.
    const free = account('language-free@example.com');
    store.setPlan('language-free@example.com', 'free', null);
    const noTrial = await relayFor(stand(AAI), { cloudTrialCredits: 0 });
    eq('plan comes before language for an account that cannot dictate at all', (await post(noTrial, free, 2, 'bn')).body.code, 'plan');

    // The desktop client sees the same refusal, with the code it can act on.
    const client = new CloudTranscriber({ baseUrl: aaiBase, token: () => pro.token });
    heard.length = 0;
    await assert.rejects(() => client.transcribe(audio(2), { language: 'bn', audioSeconds: 2 }),
      (err) => err.code === 'language' && err.status === 400 && err.message === "Voxden Cloud doesn't support that language yet.");
    eq('the client gets code language, status 400, and the sentence', heard.length, 0);
    eq('and a supported language through the same client works', (await client.transcribe(audio(2), { language: 'no', audioSeconds: 2 })).text, 'heard');

    // --- any other model: unaffected -------------------------------------------
    for (const model of [MAI, 'test/model', undefined]) {
      const base = await relayFor(stand(model), { cloudCreditsCap: 900 });
      const user = account('language-' + String(model).replace(/\W/g, '') + '@example.com');
      const label = JSON.stringify(model) + ': ';
      const expected = { bn: 'bn', nb: 'nb', no: 'nb', yue: 'yue', fil: 'fil', ko: 'ko', klingon: '', hg: '' };
      for (const [sent, forwarded] of Object.entries(expected)) {
        heard.length = 0;
        const reply = await post(base, user, 1, sent);
        eq(label + sent + ' is accepted and forwarded as ' + JSON.stringify(forwarded), [reply.status, heard.map((h) => h.language)], [200, [forwarded]]);
      }
      heard.length = 0;
      eq(label + 'no language still detects', [(await post(base, user, 1)).status, heard.map((h) => h.language)], [200, ['']]);
    }

    // --- the real transcriber: what the provider is actually sent ---------------
    const bodies = [];
    const real = createCloudTranscriber({ apiKey: 'test-key', model: AAI, rescueModel: 'none', hedgeMs: 0, fetchImpl: async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ text: 'provider text', usage: { seconds: 2 } }) };
    } });
    const realBase = await relayFor(real, { cloudCreditsCap: 900 });
    const realUser = account('language-real@example.com');
    eq('the real transcriber is an AssemblyAI one', real.model, AAI);
    eq('nb from an old app is sent to the provider as no', [(await post(realBase, realUser, 2, 'nb')).status, bodies.map((b) => b.language)], [200, ['no']]);
    bodies.length = 0;
    eq('Bengali never reaches the provider', [(await post(realBase, realUser, 2, 'bn')).status, bodies.length], [400, 0]);
    eq('Hindi does, as hi', [(await post(realBase, realUser, 2, 'hi')).status, bodies.map((b) => b.language)], [200, ['hi']]);
    bodies.length = 0;
    eq('no language sends none, so the model detects', [(await post(realBase, realUser, 2)).status, 'language' in bodies[0]], [200, false]);

    // MAI as the main model with its AssemblyAI rescue: each is sent Norwegian
    // its own way. Before, the rescue got MAI's 'nb' and answered 400.
    const sent = [];
    const pair = createCloudTranscriber({ apiKey: 'test-key', model: MAI, rescueMs: 30, fetchImpl: (_url, init) => {
      const body = JSON.parse(init.body);
      sent.push([body.model, body.language]);
      if (body.model === MAI) return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true }));
      return Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ text: 'rescued', usage: { seconds: 2 } }) });
    } });
    const pairBase = await relayFor(pair, { cloudCreditsCap: 900 });
    const pairUser = account('language-pair@example.com');
    const rescued = await post(pairBase, pairUser, 2, 'no');
    eq('a stuck MAI main model gets nb and its AssemblyAI rescue gets no', [rescued.status, rescued.body.text, sent], [200, 'rescued', [[MAI, 'nb'], [AAI, 'no']]]);
  } finally {
    for (const server of servers) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    store.close();
  }
  console.log('ok cloud language: ' + checks + ' checks, 18 AssemblyAI languages, nb to no, unsupported refused before any call or charge, other models unaffected');
};

if (require.main === module) module.exports().catch((error) => { console.error(error); process.exitCode = 1; });
