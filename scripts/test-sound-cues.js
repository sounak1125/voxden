'use strict';
const assert = require('assert');
const crypto = require('crypto');
const sound = require('../src/sound-cues');
// Approved 16-bit Soft Glass preview PCM, so the selection cannot drift.
const hashes = {
  opening: '799173f4788e295a3f8a02d82b0dbd5555d9ec00afcc6efce505bd246eb70e69',
  start: '97e2188ea98750d6f30c4f6afffa0e31cc5abef8e2e803ddd8bc2d17f839909b',
  success: '12a3ec498085901d194d5e82c5eb102fc3ca45d78f0e6e6f457fb102ca7faec4',
  error: '2571598c86d4952b2ca462722d07a288ecbf47cc114e7c1cf0aad47d6949e185',
};
for (const [kind, hash] of Object.entries(hashes)) {
  const samples = sound.samples(kind), pcm = Buffer.alloc(samples.length * 2);
  samples.forEach((value, index) => {
    assert(Number.isFinite(value) && Math.abs(value) < .16);
    pcm.writeInt16LE(Math.round(value * 32768), index * 2);
  });
  assert.strictEqual(crypto.createHash('sha256').update(pcm).digest('hex'), hash);
}
assert.strictEqual(sound.samples('unknown'), null);
assert.strictEqual(sound.samples('start').length / sound.RATE, .08, 'recording starts after the same 80 ms cue');
const sources = [];
let buffers = 0;
const ctx = { state: 'running', currentTime: 3, destination: {},
  createBuffer(channels, count, rate) { buffers++; return { duration: count / rate, copyToChannel() {} }; },
  createBufferSource() {
    const source = { connect() {}, disconnect() {}, start(t) { this.at = t; }, stop() { this.stopped = true; } };
    sources.push(source); return source;
  },
};
const player = sound.createPlayer(ctx);
assert.strictEqual(player.play('opening'), 3.25);
assert.strictEqual(player.play('start'), 3.08);
assert.strictEqual(sources[0].stopped, true, 'recording stops the opening cue');
sources[0].onended();
player.stop();
assert.strictEqual(sources[1].stopped, true, 'a late ended event cannot clear the next cue');
player.play('success'); player.play('error');
assert.strictEqual(buffers, 4, 'all subsequent playback reuses prepared audio');
ctx.state = 'closed';
assert.strictEqual(player.play('start'), 0);
console.log('Soft Glass: exact previews, safe levels, 80 ms start, cached playback and interruption passed');

(async () => {
  let resume;
  ctx.state = 'suspended';
  ctx.resume = () => new Promise(resolve => { resume = () => { ctx.state = 'running'; resolve(); }; });
  const before = sources.length;
  const opening = player.playOpening();
  assert.strictEqual(sources.length, before, 'launch waits for the output to resume');
  resume();
  assert.strictEqual(await opening, 3.37);
  assert.strictEqual(sources.at(-1).at, 3.12, 'launch has a 120 ms output lead-in');
  assert.strictEqual(player.play('start'), 3.08, 'recording never inherits launch delay');
  ctx.state = 'suspended';
  const cancelled = player.playOpening();
  player.stop(); // Sound off, or a newer recording cancels pending launch work.
  const cancelledCount = sources.length;
  resume();
  assert.strictEqual(await cancelled, 0);
  assert.strictEqual(sources.length, cancelledCount);
  ctx.state = 'suspended';
  const resumes = [];
  ctx.resume = () => new Promise(resolve => resumes.push(resolve));
  const interrupted = player.playOpening();
  assert.strictEqual(player.play('start'), 3.08);
  const startCount = sources.length;
  ctx.state = 'running';
  resumes.forEach(resolve => resolve());
  assert.strictEqual(await interrupted, 0, 'recording cancels a launch waiting for the device');
  assert.strictEqual(sources.length, startCount, 'opening cannot replace the recording cue');
  ctx.baseLatency = .08; ctx.outputLatency = .1;
  assert(Math.abs(await player.playOpening() - 3.45) < 1e-9);
  ctx.outputLatency = 1;
  assert.strictEqual(await player.playOpening(), 3.55, 'high output latency is capped at 300 ms');
  ctx.state = 'suspended';
  ctx.resume = async () => { throw new Error('No output device'); };
  assert.strictEqual(await player.playOpening(), 0, 'failed resume is contained');
  console.log('Launch readiness, output lead-in, cancellation, and unchanged recording latency passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
