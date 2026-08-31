'use strict';

const assert = require('assert');
const asr = require('../src/asr');

assert.strictEqual(asr.normalizeAsrEngine('qwen3-asr'), 'qwen3-asr');
assert.strictEqual(asr.normalizeAsrEngine('parakeet'), 'parakeet');
assert.strictEqual(asr.normalizeAsrEngine('PARAKEET'), 'parakeet');
assert.strictEqual(asr.normalizeAsrEngine('VOXTRAL'), 'whisper');
assert.strictEqual(asr.normalizeAsrEngine('voxtral'), 'whisper');
assert.strictEqual(asr.normalizeAsrEngine('unknown'), 'whisper');
assert.strictEqual(asr.normalizeAsrEngine(null), 'whisper');

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
// CPU changes recogniser -- and keeps its sentence correction, which is a
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

assert.strictEqual(asr.engineName('qwen3-asr'), 'Qwen3-ASR 1.7B');
assert.strictEqual(asr.engineName('parakeet'), 'Parakeet TDT 0.6B');
assert.strictEqual(asr.engineName('bad'), 'Whisper large-v3');
assert.strictEqual(asr.engineOptionLabel('voxtral'), 'Whisper large-v3 \u00b7 ~3 GB');
assert.strictEqual(asr.engineOptionLabel('whisper'), 'Whisper large-v3 \u00b7 ~3 GB');
assert.strictEqual(asr.engineOptionLabel('parakeet'), 'Parakeet TDT 0.6B \u00b7 ~0.6 GB');

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
