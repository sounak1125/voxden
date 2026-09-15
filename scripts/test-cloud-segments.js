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

// The 1.5 second floor is what decides whether a dictation pays its round trip
// after the user stops or during a pause they were taking anyway. A phrase
// with a real pause past the floor must go up while recording continues,
// leaving only its tail to transcribe at stop.
const paused = join([voice(16 * 1800), new Float32Array(16 * 450), voice(16 * 700, 97)]);
const overFloor = createCloudSegmenter();
const overFloorSegments = overFloor.push(paused);
assert.strictEqual(overFloorSegments.length, 1, 'a pause past the floor uploads during recording');
assert(overFloorSegments[0].length >= 16 * 1500, 'the segment carries the speech before the pause');
assert(overFloor.flush().length <= 16 * 800, 'only the tail is left for stop');

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

// Soft speech is still speech. A word that fades below the old 0.012 RMS
// boundary for more than 400ms must stay with the rest of its phrase.
const softVoice = Float32Array.from(voice(16384), sample => sample * 0.045);
const fadingWord = join([voice(25600), softVoice, voice(12800, 91)]);
const softEnding = createCloudSegmenter();
assert.strictEqual(softEnding.push(fadingWord).length, 0,
  'a quieter syllable cannot become a pause in the middle of a word');
const afterWord = softEnding.push(new Float32Array(6400));
assert.strictEqual(afterWord.length, 1, 'the real 400ms pause still emits without extra latency');
assertExact(afterWord[0], join([fadingWord, new Float32Array(6400)]),
  'soft word ending and following speech stay in the same request');

const quietTalker = createCloudSegmenter();
const quietPhrase = join([softVoice, softVoice, new Float32Array(6400)]);
assert.strictEqual(quietTalker.push(quietPhrase).length, 1,
  'quiet dictation also transcribes during pauses instead of waiting for stop');

const roomPause = createCloudSegmenter();
assert.strictEqual(roomPause.push(join([voice(51200), new Float32Array(6400).fill(0.003)])).length, 1,
  'suppressed background noise still counts as a pause');

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
