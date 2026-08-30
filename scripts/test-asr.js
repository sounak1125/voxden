'use strict';

const assert = require('assert');
const asr = require('../src/asr');

assert.strictEqual(asr.normalizeAsrEngine('qwen3-asr'), 'qwen3-asr');
assert.strictEqual(asr.normalizeAsrEngine('VOXTRAL'), 'voxtral');
assert.strictEqual(asr.normalizeAsrEngine('unknown'), 'whisper');
assert.strictEqual(asr.normalizeAsrEngine(null), 'whisper');

assert.strictEqual(asr.normalizeAsrDevice('cuda'), 'cuda');
assert.strictEqual(asr.normalizeAsrDevice('CPU'), 'cpu');
assert.strictEqual(asr.normalizeAsrDevice('gpu'), 'auto');
assert.strictEqual(asr.normalizeAsrDevice(null), 'auto');

assert.strictEqual(asr.engineName('qwen3-asr'), 'Qwen3-ASR 1.7B');
assert.strictEqual(asr.engineName('bad'), 'Whisper large-v3');
assert.strictEqual(asr.engineOptionLabel('voxtral'), 'Voxtral Mini 3B \u00b7 ~5 GB');
assert.strictEqual(asr.engineOptionLabel('whisper'), 'Whisper large-v3 \u00b7 ~3 GB');

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
