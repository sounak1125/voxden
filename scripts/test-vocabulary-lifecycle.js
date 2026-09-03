'use strict';

// The promise the whole feature rests on: add a word, and the very next thing
// you say uses it. No restart, no re-index, no waiting.
//
// This drives the real src/main.js through the lifecycle harness, so what it
// asserts is what the app does -- the request it writes to the sidecar, the
// text it finalizes, and the record it keeps of both.

const assert = require('assert');
const path = require('path');
const harness = require('./asr-test-harness');

let checks = 0;
function ok(label, value) {
  assert.ok(value, label);
  checks += 1;
  process.stdout.write('ok ' + label + '\n');
}
function eq(label, actual, expected) {
  assert.deepStrictEqual(actual, expected, label + '\n  got: ' + JSON.stringify(actual));
  checks += 1;
  process.stdout.write('ok ' + label + '\n');
}

const h = harness();

// The same entry point the Dictionary view uses, so this test adds words the
// way a person does rather than by reaching past the UI into the store.
function addTerm(from, to, meta) {
  const handler = h.handlers.get('dict-upsert');
  assert.ok(handler, 'main.js must expose the dict-upsert handler');
  return handler(null, from, to, meta);
}

async function main() {
  ok('this test profile is not the installed Voxden dictionary',
    !/appdata[\\/]+roaming[\\/]+voxden[\\/]+data/i.test(h.run('DICT_FILE')));
  ok('and it is not the development dictionary either',
    path.normalize(h.run('DICT_FILE')) !== path.normalize(path.join(__dirname, '..', 'data', 'dictionary.json')));

  // Stand in for a running sidecar so sidecarTranscribe will build a request.
  // The write is captured rather than sent.
  h.run(`
    var sentPayloads = [];
    sidecar = { stdin: { write: function (line) { sentPayloads.push(JSON.parse(line)); return true; } } };
    sidecarReady = true;
    engineBackend = 'qwen3-asr';
    engineDevice = 'cuda';
    engineFastBackend = 'parakeet';
    settings.dictationLanguage = 'en';
    // sidecarTranscribe awaits waitForSidecarReady before it writes, so the
    // payload lands a couple of microtasks after the call rather than during it.
    function requestFor(quality) {
      var before = sentPayloads.length;
      sidecarTranscribe('clip.wav', { quality: quality || 'accurate' }).catch(function () {});
      return Promise.resolve()
        .then(function () {})
        .then(function () { return sentPayloads[before]; });
    }
    function requestAuto() {
      var before = sentPayloads.length;
      sidecarTranscribe('clip.wav', {}).catch(function () {});
      return Promise.resolve()
        .then(function () {})
        .then(function () { return sentPayloads[before]; });
    }
    function requestWith(opts) {
      var before = sentPayloads.length;
      sidecarTranscribe('clip.wav', opts || {}).catch(function () {});
      return Promise.resolve()
        .then(function () {})
        .then(function () { return sentPayloads[before]; });
    }
  `);

  // --- 1. An empty dictionary sends no vocabulary --------------------------
  eq('an empty dictionary sends no prompt', (await h.run('requestFor()')).prompt, undefined);

  // --- 2. A word added now is in the very next request ---------------------
  await addTerm('Kharagpur', 'Kharagpur', { kind: 'word' });
  const first = await h.run('requestFor()');
  ok('the next request carries the new word', /Kharagpur/.test(first.prompt || ''));
  eq('and it is tagged with the dictation language', first.language, 'en');

  // Added second, so it is the newest -- and the newest term is the one the
  // user just stopped to type, which is the one that must never be dropped.
  await addTerm('Bhubaneswar', 'Bhubaneswar', { kind: 'word' });
  const second = await h.run('requestFor()');
  ok('a second word joins it', /Bhubaneswar/.test(second.prompt));
  ok('without displacing the first', /Kharagpur/.test(second.prompt));
  ok('and the newest term leads the prompt',
    second.prompt.indexOf('Bhubaneswar') < second.prompt.indexOf('Kharagpur'));

  // --- 3. It survives a restart -------------------------------------------
  h.run('loadStores();');
  const afterRestart = await h.run('requestFor()');
  ok('both words survive a reload from disk',
    /Kharagpur/.test(afterRestart.prompt) && /Bhubaneswar/.test(afterRestart.prompt));

  // --- 4. A dictionary far larger than any prompt window -------------------
  //
  // The old builder took the first 64 entries and joined them, whatever engine
  // was running and whatever the terms cost in tokens.
  for (let i = 0; i < 300; i++) {
    await addTerm('Terminology' + i, 'Terminology' + i, { kind: 'word' });
  }
  eq('the dictionary really is that large', h.run('currentVocabulary().length'), 302);

  const qwen = await h.run('requestFor()');
  const qwenTerms = qwen.prompt.split(', ');
  ok('Qwen is given many terms but not all 302', qwenTerms.length > 64 && qwenTerms.length <= 96);

  h.run("engineBackend = 'whisper'; engineDevice = 'cuda';");
  const whisper = await h.run('requestFor()');
  const whisperTerms = whisper.prompt.split(', ');
  ok('Whisper is given fewer, because its prompt window is smaller',
    whisperTerms.length < qwenTerms.length);
  ok('and it stays inside its budget', whisperTerms.length <= 48);
  ok('the newest term is never the one cut', /Terminology299/.test(whisper.prompt));

  const report = h.run('lastVocabularyReport');
  eq('the report says how many terms were offered', report.offered, 302);
  eq('and how many actually fitted', report.sent, whisperTerms.length);
  eq('and that the rest were dropped', report.dropped, 302 - report.sent);
  eq('and names the mechanism used', report.mechanism, 'initial_prompt');

  // --- 5. An engine with no vocabulary input --------------------------------
  h.run("engineBackend = 'parakeet'; engineFastBackend = '';");
  const parakeet = await h.run('requestFor()');
  eq('Parakeet is sent no prompt, because it has nowhere to put one',
    parakeet.prompt, undefined);
  eq('and the report says the terms will be applied afterwards',
    h.run('lastVocabularyReport.via'), 'repair');
  eq('rather than claiming a mechanism it does not have',
    h.run('lastVocabularyReport.mechanism'), 'unsupported');

  // --- 6. An accurate dictation does not lose its dictionary for speed ------
  //
  // The shipped behaviour: Whisper on a CPU is slow, so an accurate dictation
  // was handed to Parakeet -- which cannot take a vocabulary at all.
  h.run("engineBackend = 'whisper'; engineFastBackend = 'parakeet'; engineDevice = 'cpu';");
  eq('an accurate dictation with a dictionary stays on the capable engine',
    h.run("asrQualityFor('accurate')"), 'accurate');
  eq('and the engine it names is the capable one',
    h.run("asrEngineFor('accurate')"), 'whisper');

  h.run('dictionary = { phrases: [], variants: [], pending: [], blocked: [] }; vocabularyDirty = true;');
  eq('with no dictionary to protect, speed wins again',
    h.run("asrQualityFor('accurate')"), 'fast');

  await addTerm('Kharagpur', 'Kharagpur', { kind: 'word' });
  eq('an explicitly fast dictation is still fast', h.run("asrQualityFor('fast')"), 'fast');
  eq('and names Parakeet as the engine that will run',
    h.run("asrEngineFor('fast')"), 'parakeet');

  // --- 6b. Auto must not silently become Parakeet when Qwen has a dictionary --
  h.run(`
    engineBackend = 'qwen3-asr';
    engineFastBackend = 'parakeet';
    engineDevice = 'cpu';
    settings.asrEngine = 'qwen3-asr';
    settings.dictationQuality = 'auto';
    settings.dictationLanguage = 'en';
    lastTarget = { hwnd: '0', exe: 'Slack.exe', title: 'project-updates' };
    lastDurationMs = 2000;
  `);
  eq('the Auto heuristic for Slack is Fast',
    h.run('currentDictationQuality()'), 'fast');
  eq('but Auto with a dictionary still plans Qwen',
    h.run("planDictationRoute({}).engine"), 'qwen3-asr');
  eq('and the sidecar is told Accurate so it cannot swap',
    h.run("planDictationRoute({}).sidecarQuality"), 'accurate');
  const autoPayload = await h.run('requestAuto()');
  ok('Auto + Qwen sends the dictionary into the request', /Kharagpur/.test(autoPayload.prompt || ''));
  eq('Auto + Qwen does not ask the sidecar for Fast', autoPayload.quality, 'accurate');
  eq('and tells the sidecar how many terms were offered before the prompt was built',
    autoPayload.termCount, h.run('lastVocabularyReport.offered'));
  eq('and requires in-model vocabulary', autoPayload.requireVocabulary, true);
  eq('and the report names Qwen, not Parakeet',
    h.run('lastVocabularyReport.engine'), 'qwen3-asr');
  ok('and it actually sent terms', h.run('lastVocabularyReport.sent') > 0);
  ok('rather than dropping the whole dictionary',
    h.run('lastVocabularyReport.dropped') < h.run('lastVocabularyReport.offered'));
  eq('and the mechanism is Qwen context',
    h.run('lastVocabularyReport.mechanism'), 'context');

  h.run("settings.dictationQuality = 'accurate';");
  const accurateQwen = await h.run("requestFor('accurate')");
  ok('Accurate + Qwen also sends the dictionary', /Kharagpur/.test(accurateQwen.prompt || ''));
  eq('Accurate + Qwen stays on Qwen', h.run('lastVocabularyReport.engine'), 'qwen3-asr');

  h.run("settings.dictationQuality = 'fast'; lastDurationMs = 2000;");
  const explicitFast = await h.run("requestFor('fast')");
  eq('explicit Fast English may omit the in-model prompt',
    explicitFast.prompt, undefined);
  eq('and asks the sidecar for Fast', explicitFast.quality, 'fast');
  eq('and does not require in-model vocabulary', explicitFast.requireVocabulary, false);
  eq('and the report names Parakeet', h.run('lastVocabularyReport.engine'), 'parakeet');
  eq('and says the dictionary is applied afterwards',
    h.run('lastVocabularyReport.via'), 'repair');
  ok('and the summary says so',
    /after recognition/.test(h.run('lastVocabularyReport.summary')));

  h.run(`
    settings.dictationLanguage = 'hi';
    settings.dictationQuality = 'fast';
    engineBackend = 'qwen3-asr';
    engineFastBackend = 'parakeet';
    engineDevice = 'cpu';
  `);
  eq('Hindi Fast never plans Parakeet',
    h.run("planDictationRoute({ quality: 'fast', language: 'hi' }).engine"), 'qwen3-asr');
  const hindiFast = await h.run("requestWith({ quality: 'fast', language: 'hi' })");
  eq('Hindi Fast does not send quality=fast to Parakeet', hindiFast.quality, 'accurate');
  eq('and the engine in the report is still Qwen',
    h.run('lastVocabularyReport.engine'), 'qwen3-asr');

  h.run("settings.dictationLanguage = 'en'; settings.dictationQuality = 'auto';");

  // --- 7. The finalized text, and what is recorded about it ----------------
  h.run(`
    engineBackend = 'parakeet'; engineDevice = 'cpu'; engineFastBackend = '';
    settings.verbatimMode = false;
    lastAsrReport = {
      engine: 'parakeet', device: 'cpu', vocabulary: 'unsupported',
      routed: 'primary', segments: null,
    };
    var pasted = null;
    pasteDictation = function (text) { pasted = text; return Promise.resolve(); };
  `);
  await addTerm('carrot pur', 'Kharagpur', { kind: 'mapping' });
  await h.run("onTranscript('we met in carrot pur last year')");
  ok('an explicit rule is applied to the transcript', /Kharagpur/.test(h.run('pasted')));

  const entry = h.run('history.entries[0]');
  ok('the dictation records what the vocabulary did', entry.vocabulary);
  eq('including which engine ran', entry.vocabulary.engine, 'parakeet');
  eq('and that the dictionary could not reach the model',
    entry.vocabulary.vocabularyVia, 'repair');
  ok('and how many replacements were made', entry.vocabulary.dictionaryHits >= 1);
  // The diagnostics must be safe to keep whatever the privacy settings say.
  ok('the record carries no transcript text',
    !JSON.stringify(entry.vocabulary).includes('we met in'));

  h.run(`
    lastAsrReport = {
      engine: 'qwen3-asr', device: 'cpu', vocabulary: 'context',
      routed: 'primary', segments: null,
    };
    lastVocabularyReport = {
      selectedEngine: 'qwen3-asr', engine: 'qwen3-asr', language: 'en',
      requestedQuality: 'auto', quality: 'accurate',
      mechanism: 'context', via: 'context', offered: 1, sent: 1, dropped: 0,
      tokens: 4, reason: '', fallbackFrom: '',
    };
  `);
  await h.run("onTranscript('we met in Kharagpur last year')");
  eq('Qwen history records the engine that really ran',
    h.run('history.entries[0].asrEngine'), 'qwen3-asr');
  eq('and that the dictionary reached the model',
    h.run('history.entries[0].vocabulary.vocabularyVia'), 'context');
  ok('and the summary is readable',
    /Qwen3-ASR/.test(h.run('history.entries[0].vocabulary.summary'))
    && /sent to the model/.test(h.run('history.entries[0].vocabulary.summary')));

  // --- 8. Ordinary speech is not rewritten ---------------------------------
  await h.run("onTranscript('we will get the file later')");
  eq('a sentence with nothing to correct keeps its words',
    h.run('pasted'), 'We will get the file later');
  eq('and records no dictionary hits',
    h.run('history.entries[0].vocabulary.dictionaryHits'), 0);
}

main().then(() => {
  h.close();
  process.stdout.write('all ' + checks + ' vocabulary lifecycle checks passed\n');
}).catch((err) => {
  h.close();
  process.stderr.write(String((err && err.stack) || err) + '\n');
  process.exit(1);
});
