'use strict';

// The gate between a finished recording and the speech engine. The two ways
// it can be wrong pull against each other: a floor high enough to catch every
// silent recording also catches a quiet talker, and a quiet talker losing
// their words is worse than a silent recording pasting a stray "Thank you."
// So the cases here are the ones that must pass and the ones that must not,
// built as signals rather than recorded, so the numbers are exact.

const assert = require('assert');
const gate = require('../src/speech-gate');

let passed = 0;
function ok(name, fn) {
  fn();
  passed += 1;
  console.log('ok', name);
}

const RATE = 16000;

function silence(seconds) {
  return new Float32Array(Math.round(seconds * RATE));
}

// Deterministic, so a failure here reproduces.
function noise(seconds, amplitude) {
  const out = new Float32Array(Math.round(seconds * RATE));
  let x = 12345;
  for (let i = 0; i < out.length; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    out[i] = ((x / 0x7fffffff) * 2 - 1) * amplitude;
  }
  return out;
}

function tone(seconds, amplitude, hz) {
  const out = new Float32Array(Math.round(seconds * RATE));
  for (let i = 0; i < out.length; i++) {
    out[i] = Math.sin(2 * Math.PI * (hz || 200) * i / RATE) * amplitude;
  }
  return out;
}

function place(into, part, atSeconds) {
  into.set(part.subarray(0, Math.min(part.length, into.length - Math.round(atSeconds * RATE))), Math.round(atSeconds * RATE));
  return into;
}

ok('silence is not speech', () => {
  const v = gate.analyseSpeech(silence(1.5));
  assert.strictEqual(v.speech, false);
  assert.strictEqual(v.peak, 0);
  assert.strictEqual(v.activeMs, 0);
  assert.strictEqual(v.durationMs, 1500);
});

ok('suppressed room noise is not speech', () => {
  // Uniform noise at ±0.005 has an RMS near 0.003, which is where a quiet
  // room with noise suppression on sits.
  const v = gate.analyseSpeech(noise(2, 0.005));
  assert.strictEqual(v.speech, false, JSON.stringify(v));
  assert.ok(v.rms < gate.ACTIVE_RMS, 'the noise floor has to sit under the active floor: ' + v.rms);
});

ok('a spoken phrase is speech', () => {
  const clip = place(silence(1.5), tone(0.3, 0.03), 0.5);
  const v = gate.analyseSpeech(clip);
  assert.strictEqual(v.speech, true, JSON.stringify(v));
  assert.ok(v.activeMs >= 270 && v.activeMs <= 330, 'active time has to match the phrase: ' + v.activeMs);
  assert.ok(v.longestRunMs >= 270, 'the phrase is one run: ' + v.longestRunMs);
});

ok('a quiet talker on a distant microphone still passes', () => {
  // Amplitude 0.008 is an RMS near 0.0057, well under the chunker's idea of
  // speech (0.012) and under half of it. 150 ms is one short word.
  const clip = place(silence(1), tone(0.15, 0.008), 0.4);
  const v = gate.analyseSpeech(clip);
  assert.strictEqual(v.speech, true, JSON.stringify(v));
});

ok('a single click is not speech', () => {
  // 20 ms of a loud tick touches at most two frames, and its peak is under
  // the floor that lets a lone sample through.
  const clip = place(silence(1), tone(0.02, 0.1, 1000), 0.5);
  const v = gate.analyseSpeech(clip);
  assert.strictEqual(v.speech, false, JSON.stringify(v));
  assert.ok(v.longestRunMs < gate.MIN_RUN_FRAMES * gate.FRAME_MS, 'a click must not make a run: ' + v.longestRunMs);
});

ok('anything that clips the peak floor is a real signal, however brief', () => {
  const clip = silence(1);
  clip[8000] = 0.5;
  const v = gate.analyseSpeech(clip);
  assert.strictEqual(v.speech, true, JSON.stringify(v));
  assert.strictEqual(v.peak, 0.5);
});

ok('the sample rate is honoured', () => {
  const rate = 48000;
  const n = Math.round(1.2 * rate);
  const clip = new Float32Array(n);
  for (let i = Math.round(0.5 * rate); i < Math.round(0.8 * rate); i++) {
    clip[i] = Math.sin(2 * Math.PI * 200 * i / rate) * 0.03;
  }
  const v = gate.analyseSpeech(clip, { sampleRate: rate });
  assert.strictEqual(v.speech, true, JSON.stringify(v));
  assert.strictEqual(v.durationMs, 1200);
  assert.ok(v.activeMs >= 270 && v.activeMs <= 330, v.activeMs);
});

ok('an empty or missing clip is not speech and does not throw', () => {
  assert.strictEqual(gate.analyseSpeech(new Float32Array(0)).speech, false);
  assert.strictEqual(gate.analyseSpeech(null).speech, false);
  assert.strictEqual(gate.analyseSpeech(new Float32Array(10)).durationMs, 1);
});

ok('the floors are tunable without editing the module', () => {
  const clip = place(silence(1), tone(0.3, 0.006), 0.2);
  assert.strictEqual(gate.analyseSpeech(clip).speech, true);
  assert.strictEqual(gate.analyseSpeech(clip, { activeRms: 0.01 }).speech, false);
  assert.strictEqual(gate.analyseSpeech(clip, { activeRms: 0.01, peakFloor: 0.005 }).speech, true);
});

console.log('speech gate: ' + passed + ' checks passed');
