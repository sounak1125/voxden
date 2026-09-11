'use strict';

const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const { createCloudSegmenter } = require('../src/cloud-segments');

function voice(length, phase = 0) {
  return Float32Array.from({ length }, (_, i) => Math.sin((i + phase) * 0.07) * 0.2);
}

function join(parts) {
  const result = new Float32Array(parts.reduce((n, part) => n + part.length, 0));
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}

function assertExact(actual, expected, message) {
  assert.strictEqual(actual.length, expected.length, message);
  assert(Buffer.from(actual.buffer, actual.byteOffset, actual.byteLength)
    .equals(Buffer.from(expected.buffer, expected.byteOffset, expected.byteLength)), message);
}

function finish(segmenter, segments) {
  const tail = segmenter.flush();
  if (tail) segments.push(tail);
  assert.strictEqual(segmenter.flush(), null, 'a second flush must not duplicate audio');
  return segments;
}

const empty = createCloudSegmenter();
assert.deepStrictEqual(empty.push(new Float32Array()), []);
assert.strictEqual(empty.flush(), null);
assert.throws(() => empty.push([0]), /Float32Array/);
for (const options of [{ sampleRate: 0 }, { silenceMs: -1 }, { minSegmentMs: -1 }, { speechRms: NaN }]) {
  assert.throws(() => createCloudSegmenter(options), /positive sample rate/);
}

const shortPhrase = join([voice(16000), new Float32Array(8000)]);
const short = createCloudSegmenter();
assert.deepStrictEqual(short.push(shortPhrase), [], 'short dictation waits for stop');
assertExact(short.flush(), shortPhrase, 'short dictation must be complete');

const uninterrupted = voice(16000 * 65);
const continuous = createCloudSegmenter();
for (let offset = 0; offset < uninterrupted.length; offset += 2048) {
  assert.deepStrictEqual(continuous.push(uninterrupted.subarray(offset, offset + 2048)), [],
    'continuous speech must never be cut by a duration limit');
}
assertExact(continuous.flush(), uninterrupted, 'long dictation must be preserved');

// Exact known cut positions: each phrase has 3.2 seconds of speech and a 400ms
// pause. End with fewer samples than a detection frame to catch truncated tails.
const phraseA = join([voice(51200), new Float32Array(6400)]);
const phraseB = join([voice(51200, 97), new Float32Array(6400)]);
const finalWords = voice(137, 37);
const recording = join([phraseA, phraseB, finalWords]);
const whole = createCloudSegmenter();
const firstSegments = whole.push(recording);
assert.strictEqual(firstSegments.length, 2, 'both complete pauses should emit immediately');
assertExact(firstSegments[0], phraseA, 'first phrase order and cut');
assertExact(firstSegments[1], phraseB, 'second phrase order and cut');
assertExact(whole.flush(), finalWords, 'last spoken partial frame must survive');

// Identical spoken phrases are distinct audio and must not be deduplicated.
const repeated = createCloudSegmenter();
assertExact(join(finish(repeated, repeated.push(join([phraseA, phraseA])))), join([phraseA, phraseA]),
  'real repetitions must survive');

// A subthreshold pause within an utterance cannot split it, even after the
// minimum duration. Quiet background samples are kept exactly as recorded.
const briefPause = join([voice(60000), new Float32Array(4000).fill(0.002), voice(20000, 21)]);
const noSplit = createCloudSegmenter();
assert.deepStrictEqual(noSplit.push(briefPause), []);
assertExact(noSplit.flush(), briefPause, 'short pause keeps phrase context');

// Input partitioning and input buffer reuse must not change cuts or contents.
for (let seed = 1; seed <= 30; seed++) {
  let random = seed;
  const split = createCloudSegmenter();
  const outputs = [];
  let offset = 0;
  while (offset < recording.length) {
    random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
    const length = 1 + random % 4096;
    const block = recording.slice(offset, offset + length);
    outputs.push(...split.push(block));
    block.fill(-0.9); // Simulate the capture system reusing its callback buffer.
    offset += length;
  }
  finish(split, outputs);
  assert.deepStrictEqual(outputs.map(part => part.length), [phraseA.length, phraseB.length, finalWords.length],
    'cuts must be independent of capture block sizes');
  assertExact(join(outputs), recording, 'randomized blocks preserve each sample exactly once');
}

const silence = new Float32Array(100000).fill(0.001);
const silent = createCloudSegmenter();
assert.deepStrictEqual(silent.push(silence), [], 'silence cannot create transcription segments');
assertExact(silent.flush(), silence, 'silence gate remains the caller responsibility');

const reusable = createCloudSegmenter();
const saved = reusable.push(phraseA)[0];
const savedCopy = saved.slice();
reusable.push(phraseB);
reusable.flush();
assertExact(saved, savedCopy, 'later pushes and flushes cannot mutate an earlier output');
assert.deepStrictEqual(reusable.push(finalWords), [], 'flushed instance starts a fresh recording');
assertExact(reusable.flush(), finalWords, 'flush resets counters and pending buffers');

const browser = { Float32Array };
vm.runInNewContext(fs.readFileSync(require.resolve('../src/cloud-segments'), 'utf8'), browser);
assert.strictEqual(typeof browser.voxdenCloudSegments.createCloudSegmenter, 'function');
const browserSegmenter = browser.voxdenCloudSegments.createCloudSegmenter();
browserSegmenter.push(finalWords);
assertExact(browserSegmenter.flush(), finalWords, 'browser global exposes the same API');

console.log('ok cloud segments: natural pauses, full speech context, exact sample coverage, reusable buffers, browser API');
