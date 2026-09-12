'use strict';

const assert = require('assert');
const asr = require('../src/asr');

assert.strictEqual(asr.normalizeAsrEngine('qwen3-asr'), 'qwen3-asr');
assert.strictEqual(asr.normalizeAsrEngine('parakeet'), 'parakeet');
assert.strictEqual(asr.normalizeAsrEngine('PARAKEET'), 'parakeet');
// Unknown and empty values land on the default; the retired-engine migration
// to Qwen is main.js's, applied to the raw settings value before this runs.
assert.strictEqual(asr.DEFAULT_ASR_ENGINE, 'parakeet');
assert.strictEqual(asr.normalizeAsrEngine('VOXTRAL'), 'parakeet');
assert.strictEqual(asr.normalizeAsrEngine('voxtral'), 'parakeet');
assert.strictEqual(asr.normalizeAsrEngine('unknown'), 'parakeet');
assert.strictEqual(asr.normalizeAsrEngine(null), 'parakeet');

assert.strictEqual(asr.normalizeAsrDevice('cuda'), 'cuda');
assert.strictEqual(asr.normalizeAsrDevice('CPU'), 'cpu');
assert.strictEqual(asr.normalizeAsrDevice('directml'), 'directml');
assert.strictEqual(asr.normalizeAsrDevice('DirectML'), 'directml');
// Not device names anyone can pick. ROCm in particular has no backend here at
// all -- DirectML is how an AMD card gets used.
assert.strictEqual(asr.normalizeAsrDevice('rocm'), 'auto');
assert.strictEqual(asr.normalizeAsrDevice('gpu'), 'auto');
assert.strictEqual(asr.normalizeAsrDevice(null), 'auto');
assert.deepStrictEqual(asr.ASR_DEVICES.slice(), ['auto', 'cuda', 'directml', 'cpu']);

assert.strictEqual(asr.deviceLabel('cuda'), 'NVIDIA GPU');
assert.strictEqual(asr.deviceLabel('directml'), 'AMD or Intel GPU');
assert.strictEqual(asr.deviceLabel('cpu'), 'CPU');
// 'auto' reaches the hint from --check, before anything has resolved it.
assert.strictEqual(asr.deviceLabel('auto'), 'CPU');
assert.strictEqual(asr.deviceLabel(null), 'CPU');

// The settings dropdown and the sidecar have to agree on the ids, and the
// renderer keeps its own copy of the labels because it cannot require this
// file. Both copies are read here from where they actually live.
const html = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'app.html'), 'utf8');
for (const id of asr.ASR_DEVICES) {
  assert.ok(html.includes('<option value="' + id + '">'), 'app.html is missing the ' + id + ' option');
}
const rendererLabels = require('fs')
  .readFileSync(require('path').join(__dirname, '..', 'src', 'app.js'), 'utf8')
  .match(/const DEVICE_LABELS = \{[^}]*\}/);
assert.ok(rendererLabels, 'app.js no longer declares DEVICE_LABELS');
for (const [id, label] of Object.entries(asr.DEVICE_LABELS)) {
  assert.ok(
    rendererLabels[0].includes("'" + label + "'") && rendererLabels[0].includes(id + ':'),
    'app.js and asr.js disagree about ' + id
  );
}

// Whisper large-v3 on a CPU is what makes a nine-second clip take nine
// seconds. Parakeet recognises it in under two, so an accurate dictation on a
// CPU changes recogniser -- and keeps the rest of its cleanup, which is a
// separate decision this function does not make.
assert.strictEqual(
  asr.prefersFastAsr({ device: 'cpu', fastEngine: 'parakeet', language: 'en' }),
  true
);
// A GPU makes Whisper quick enough that there is nothing to trade away.
assert.strictEqual(
  asr.prefersFastAsr({ device: 'cuda', fastEngine: 'parakeet', language: 'en' }),
  false
);
assert.strictEqual(
  asr.prefersFastAsr({ device: 'directml', fastEngine: 'parakeet', language: 'en' }),
  false
);
// Without Parakeet loaded, the fast path is only Whisper with a narrower beam
// -- speed bought by losing accuracy, which is not the trade being made here.
assert.strictEqual(asr.prefersFastAsr({ device: 'cpu', fastEngine: '', language: 'en' }), false);
// Parakeet is English-only.
assert.strictEqual(
  asr.prefersFastAsr({ device: 'cpu', fastEngine: 'parakeet', language: 'hi' }),
  false
);
// Nothing reported yet: main.js starts with device 'cpu' and no fast engine,
// so the sidecar has to answer before this can turn on.
assert.strictEqual(asr.prefersFastAsr(), false);
assert.strictEqual(asr.prefersFastAsr({ device: 'cpu' }), false);
// Missing language means English, which is what dictationLanguage is pinned to.
assert.strictEqual(asr.prefersFastAsr({ device: 'cpu', fastEngine: 'parakeet' }), true);

// Dictation language. The menu is the cloud recognizer's 60 languages plus
// Hinglish as a Voxden overlay. Local engines always hear English.
assert.strictEqual(asr.normalizeDictationLanguage('hi'), 'hi');
assert.strictEqual(asr.normalizeDictationLanguage('HI'), 'hi');
assert.strictEqual(asr.normalizeDictationLanguage(' de '), 'de');
assert.strictEqual(asr.normalizeDictationLanguage('fil'), 'fil');
assert.strictEqual(asr.normalizeDictationLanguage('yue'), 'yue');
assert.strictEqual(asr.normalizeDictationLanguage('zh'), 'zh');
// Anything unsupported falls back rather than reaching an engine that would
// mishandle it quietly.
assert.strictEqual(asr.normalizeDictationLanguage('klingon'), 'en');
assert.strictEqual(asr.normalizeDictationLanguage(''), 'en');
assert.strictEqual(asr.normalizeDictationLanguage(null), 'en');
assert.strictEqual(asr.dictationLanguageName('nl'), 'Dutch');
assert.strictEqual(asr.dictationLanguageName('nope'), 'English');
assert.ok(asr.DICTATION_LANGUAGE_IDS.includes('en'));
assert.strictEqual(asr.DICTATION_LANGUAGES.length, 61);
assert.strictEqual(asr.CLOUD_ENGINE_LANGUAGE_IDS.length, 60);
assert.ok(asr.CLOUD_ENGINE_LANGUAGE_IDS.includes('fil'));
assert.ok(asr.CLOUD_ENGINE_LANGUAGE_IDS.includes('yue'));
assert.ok(!asr.CLOUD_ENGINE_LANGUAGE_IDS.includes('hg'));

// Tiles are built in JS from the catalog. The HTML must not hard-code a
// stale nine-language menu, and it must offer search.
const langHtml = require('fs').readFileSync(
  require('path').join(__dirname, '..', 'src', 'app.html'), 'utf8'
);
const chipsStart = langHtml.indexOf('id="dictation-lang-grid"');
assert.ok(chipsStart > 0, 'the dictation language picker is gone');
assert.ok(!/data-lang=/.test(langHtml.slice(chipsStart, langHtml.indexOf('id="dictation-lang-selected"'))),
  'tiles are built from the cloud catalog in JS');
assert.ok(langHtml.includes('id="dictation-lang-search"'), 'the picker has search');

// Up to three languages, first is the main one; garbage and repeats drop out.
assert.strictEqual(asr.MAX_DICTATION_LANGUAGES, 3);
assert.deepStrictEqual(asr.normalizeDictationLanguages(['hi', 'en']), ['hi', 'en']);
assert.deepStrictEqual(asr.normalizeDictationLanguages(['en', 'EN', ' hi ', 'klingon', 'de', 'fr']), ['en', 'hi', 'de']);
assert.deepStrictEqual(asr.normalizeDictationLanguages('hi'), ['hi'], 'a scalar from an old settings file is a list of one');
assert.deepStrictEqual(asr.normalizeDictationLanguages('en,hi'), ['en', 'hi']);
assert.deepStrictEqual(asr.normalizeDictationLanguages([]), ['en']);
assert.deepStrictEqual(asr.normalizeDictationLanguages(null), ['en']);
assert.deepStrictEqual(asr.normalizeDictationLanguages(['nope']), ['en']);
assert.deepStrictEqual(asr.normalizeDictationLanguages(['bn', 'ta', 'fil']), ['bn', 'ta', 'fil']);
assert.deepStrictEqual(asr.dictationLanguageNames(['en', 'hi']), ['English', 'Hindi']);
// Hinglish is Hindi to the engine and English letters to the user, and the
// two cannot both be on: whichever came first stands.
assert.strictEqual(asr.engineLanguageId('hg'), 'hi');
assert.strictEqual(asr.engineLanguageId('en'), 'en');
assert.deepStrictEqual(asr.normalizeDictationLanguages(['en', 'hg', 'hi']), ['en', 'hg']);
assert.deepStrictEqual(asr.normalizeDictationLanguages(['hi', 'hg', 'de']), ['hi', 'de']);
assert.deepStrictEqual(asr.dictationLanguageNames(['hg']), ['Hinglish']);

assert.strictEqual(asr.dictationLanguageUnlocked({ plan: 'free', cloud: true }), false);
assert.strictEqual(asr.dictationLanguageUnlocked({ plan: 'pro', cloud: false }), false);
assert.strictEqual(asr.dictationLanguageUnlocked({ plan: 'pro', cloud: true }), true);
assert.deepStrictEqual(asr.offeredDictationLanguages({ plan: 'free' }).map((l) => l.id), ['en']);
assert.strictEqual(asr.offeredDictationLanguages({ plan: 'pro', cloud: true }).length, 61);
assert.deepStrictEqual(asr.constrainDictationLanguages(['hi', 'en'], { plan: 'free' }), ['en']);
assert.deepStrictEqual(asr.constrainDictationLanguages(['hi', 'bn', 'ta', 'de'], { plan: 'pro', cloud: false }), ['hi', 'bn', 'ta']);
assert.deepStrictEqual(asr.constrainDictationLanguages(['en', 'hg', 'hi'], { plan: 'pro', cloud: true }), ['en', 'hg']);
assert.strictEqual(asr.wireLanguage(['hi', 'bn'], { plan: 'pro', cloud: false }), 'en');
assert.strictEqual(asr.wireLanguage(['en', 'de'], { plan: 'free' }), 'en');
assert.strictEqual(asr.wireLanguage(['hi'], { plan: 'pro', cloud: true }), 'hi');
assert.strictEqual(asr.wireLanguage(['hg'], { plan: 'pro', cloud: true }), 'hi');
assert.strictEqual(asr.wireLanguage(['hi', 'bn'], { plan: 'pro', cloud: true }), 'auto');
assert.strictEqual(asr.normalizeCloudLanguage('fil'), 'fil');
assert.strictEqual(asr.normalizeCloudLanguage('yue'), 'yue');
assert.strictEqual(asr.normalizeCloudLanguage('auto'), '');
assert.strictEqual(asr.normalizeCloudLanguage('hg'), '');
assert.strictEqual(asr.normalizeCloudLanguage('klingon'), '');

// Parakeet must not be chosen for a language it cannot read. The sidecar
// enforces this too; this is the settings half of the same rule.
assert.strictEqual(
  asr.prefersFastAsr({ device: 'cpu', fastEngine: 'parakeet', language: 'nl' }),
  false
);

assert.strictEqual(asr.engineName('qwen3-asr'), 'Qwen3-ASR 1.7B');
assert.strictEqual(asr.engineName('parakeet'), 'Parakeet v3');
assert.strictEqual(asr.engineName('bad'), 'Parakeet v3');
assert.strictEqual(asr.engineOptionLabel('voxtral'), 'Parakeet v3 \u00b7 ~0.6 GB');
assert.strictEqual(asr.engineOptionLabel('whisper'), 'Whisper large-v3 \u00b7 ~3 GB');
assert.strictEqual(asr.engineOptionLabel('parakeet'), 'Parakeet v3 \u00b7 ~0.6 GB');

let parsed = asr.parseEngineProgress('', 'Fetching 2 files:   0%|          | 0/2');
assert.deepStrictEqual(parsed.progress, {
  index: 0,
  phase: 'downloading',
  percent: 0,
  detail: '',
});

parsed = asr.parseEngineProgress(parsed.buffer, '\rFetching 2 files:  50%|#####     | 1/2');
assert.strictEqual(parsed.progress.phase, 'downloading');
assert.strictEqual(parsed.progress.percent, 50);

parsed = asr.parseEngineProgress('', '\u001b[32mLoading checkpoint shards: 100%|##########| 2/2\u001b[0m');
assert.strictEqual(parsed.progress.phase, 'loading');
assert.strictEqual(parsed.progress.percent, 100);

parsed = asr.parseEngineProgress('', '\rmodel-00001-of-00002.safetensors: 37%|###7      |');
assert.strictEqual(parsed.progress.phase, 'downloading');
assert.strictEqual(parsed.progress.percent, 37);
assert.strictEqual(parsed.progress.detail, 'model-00001-of-00002.safetensors');

parsed = asr.parseEngineProgress(
  '',
  'Fetching 2 files:   0%|          | 0/2 [00:00<?, ?it/s]\r'
    + 'model-00001-of-00002.safetensors: 37%|###7      | 1.85G/4.99G\r'
    + 'Fetching 2 files:   0%|          | 0/2 [01:12<?, ?it/s]'
);
assert.strictEqual(parsed.progress.phase, 'downloading');
assert.strictEqual(parsed.progress.percent, 37);
assert.strictEqual(parsed.progress.detail, 'model-00001-of-00002.safetensors');

parsed = asr.parseEngineProgress(
  '',
  'Fetching 2 files:   0%|          | 0/2\nVOXDEN_PROGRESS 0 Fetching 2 files\nVOXDEN_PROGRESS 22 model-00001-of-00002.safetensors\n'
);
assert.strictEqual(parsed.progress.percent, 22);
assert.strictEqual(parsed.progress.detail, 'model-00001-of-00002.safetensors');

console.log('all ASR setting tests passed');
