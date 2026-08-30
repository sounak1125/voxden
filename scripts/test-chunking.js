'use strict';

const assert = require('assert');
const chunking = require('../src/chunking');
const { createSidecarQueue } = require('../src/sidecar-queue');

function tone(seconds, amp, rate) {
  const sr = rate || chunking.SAMPLE_RATE;
  const n = Math.round(seconds * sr);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * 440 * i) / sr);
  return out;
}

function silence(seconds, rate) {
  return new Float32Array(Math.round(seconds * (rate || chunking.SAMPLE_RATE)));
}

function concat(parts) {
  let len = 0;
  for (const part of parts) len += part.length;
  const out = new Float32Array(len);
  let off = 0;
  for (const part of parts) {
    out.set(part, off);
    off += part.length;
  }
  return out;
}

const quiet = chunking.rms(silence(0.2), 0);
const voiced = chunking.rms(tone(0.2, 0.2), 0);
assert.ok(voiced > chunking.SPEECH_RMS, 'speech rms is above the VAD threshold');
assert.ok(quiet < chunking.SPEECH_RMS, 'silence rms is below the VAD threshold');

const splitter = chunking.createChunker({
  silenceMs: 700,
  maxSpeechMs: 8000,
  overlapMs: 400,
  minSliceMs: 300,
});
const twoUtterances = concat([tone(1.2, 0.25), silence(0.9), tone(1.1, 0.25)]);
const mid = splitter.push(twoUtterances);
const tail = splitter.flush();
const slices = mid.concat(tail ? [tail] : []);
assert.ok(slices.length >= 2, 'silence splits a long recording into at least two slices');
assert.ok(slices[0].length > slices[1].length * 0.2, 'first slice kept speech');

const forced = chunking.createChunker({
  silenceMs: 700,
  maxSpeechMs: 800,
  overlapMs: 400,
  minSliceMs: 300,
});
const longSpeech = tone(2.2, 0.25);
const forcedSlices = forced.push(longSpeech);
assert.ok(forcedSlices.length >= 1, 'max speech window commits before stop');

const shorty = chunking.createChunker({ minSliceMs: 800, silenceMs: 200, flushMinMs: 800 });
shorty.push(tone(0.2, 0.25));
shorty.push(silence(0.4));
assert.strictEqual(shorty.flush(), null, 'too-short slices are dropped');

assert.strictEqual(
  chunking.joinChunkTranscripts(['hello world', 'world today']),
  'hello world today'
);
assert.strictEqual(chunking.joinChunkTranscripts(['  ', '', null]), '');
assert.strictEqual(chunking.joinChunkTranscripts(['one two two three']), 'one two three');

assert.strictEqual(chunking.shouldIgnoreGeneration(3, 4), true);
assert.strictEqual(chunking.shouldIgnoreGeneration(4, 4), false);
assert.strictEqual(chunking.shouldIgnoreGeneration('7', 7), false);

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function testQueue() {
  const queue = createSidecarQueue();
  let aText = null;
  let aErr = null;
  let bText = null;
  queue.register('a', (msg) => { aText = msg.text; }, (err) => { aErr = err; }, 25);
  queue.register('b', (msg) => { bText = msg.text; }, () => {}, 5000);
  await wait(60);
  assert.ok(aErr, 'chunk A times out on its own');
  assert.strictEqual(queue.dispatch({ id: 'a', ok: true, text: 'from-a' }), false);
  assert.strictEqual(aText, null, 'late A must not attach to anyone');
  assert.strictEqual(queue.dispatch({ id: 'b', ok: true, text: 'from-b' }), true);
  assert.strictEqual(bText, 'from-b');
  assert.strictEqual(queue.dispatch({ id: 'missing', ok: true, text: 'nope' }), false);

  const q2 = createSidecarQueue();
  let rejected = null;
  q2.register('x', () => {}, (err) => { rejected = err; }, 5000);
  q2.rejectAll(new Error('sidecar exited'));
  assert.strictEqual(rejected.message, 'sidecar exited');
  assert.strictEqual(q2.size(), 0);
}

testQueue().then(() => {
  console.log('all chunking tests passed');
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
