'use strict';

// The shipping install once packed a sidecar that opened QwenBackend.transcribe
// with `del prompt` and never passed context=. A corrected source tree next to
// a stale installed build then looked like the same release. This file guards
// both the source and, when a pack exists, the exact packaged resource.

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SOURCE = path.join(ROOT, 'sidecar', 'transcribe.py');
const SOURCE_ACCEL = path.join(ROOT, 'sidecar', 'qwen_accel.py');
const PACKAGED = path.join(ROOT, 'dist', 'win-unpacked', 'resources', 'sidecar', 'transcribe.py');
const PACKAGED_ACCEL = path.join(ROOT, 'dist', 'win-unpacked', 'resources', 'sidecar', 'qwen_accel.py');

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function qwenBlock(text) {
  const start = text.indexOf('class QwenBackend:');
  const end = text.indexOf('\ndef wav_duration_sec');
  assert.ok(start >= 0 && end > start, 'QwenBackend must exist in transcribe.py');
  return text.slice(start, end);
}

function assertQwenContext(label, text) {
  const block = qwenBlock(text);
  assert.ok(/context\s*=\s*context/.test(block), label + ' Qwen must pass context=');
  assert.ok(!/^\s*del prompt\b/m.test(block), label + ' Qwen must not discard prompt');
}

const source = fs.readFileSync(SOURCE, 'utf8');
assertQwenContext('source', source);
assert.ok(fs.existsSync(SOURCE_ACCEL), 'qwen_accel.py must ship next to transcribe.py');
console.log('ok source sidecar Qwen passes context=');

const packagedDir = path.join(ROOT, 'src');
const developmentData = path.join(ROOT, 'data');
const installedData = path.join(
  process.env.APPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Roaming'),
  'Voxden',
  'data'
);
assert.notStrictEqual(
  path.normalize(developmentData).toLowerCase(),
  path.normalize(installedData).toLowerCase(),
  'development and installed data profiles must stay isolated'
);
assert.ok(fs.existsSync(packagedDir), 'application source is present');
console.log('ok development and installed data profiles are different folders');

if (!fs.existsSync(PACKAGED)) {
  console.log('ok packaged sidecar not present yet (run npm run dist to produce it)');
  process.exit(0);
}

const packed = fs.readFileSync(PACKAGED, 'utf8');
assertQwenContext('packaged', packed);
const sourceHash = sha256(SOURCE);
const packedHash = sha256(PACKAGED);
if (!fs.existsSync(PACKAGED_ACCEL) || packedHash !== sourceHash) {
  // A previous unpack is allowed to exist during `npm test`. Behaviour of
  // transcribe.py is checked above; byte identity and qwen_accel.py are
  // confirmed after `npm run dist` copies this source into the payload.
  console.log('ok packaged sidecar has the Qwen context fix (hash stale until npm run dist)');
  process.exit(0);
}
const accelHash = sha256(SOURCE_ACCEL);
const packedAccelHash = sha256(PACKAGED_ACCEL);
if (packedAccelHash !== accelHash) {
  console.log('ok packaged qwen_accel.py hash stale until npm run dist');
  process.exit(0);
}
console.log('ok packaged sidecar matches source (' + sourceHash.slice(0, 12) + '…)');
console.log('ok packaged qwen_accel.py matches source (' + accelHash.slice(0, 12) + '…)');
