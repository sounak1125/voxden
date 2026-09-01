'use strict';

// The capability contract is the thing that stops a vocabulary request being
// accepted and thrown away. It is written twice -- once in JavaScript for the
// app and once in Python for the sidecar, which has to answer --check before
// any JavaScript has run -- so the first job here is proving the two copies
// still say the same thing.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const caps = require('../src/asr-capabilities');

let checks = 0;
function ok(label, value) {
  assert.ok(value, label);
  checks += 1;
  process.stdout.write('ok ' + label + '\n');
}
function eq(label, actual, expected) {
  assert.deepStrictEqual(actual, expected, label + ': ' + JSON.stringify(actual));
  checks += 1;
  process.stdout.write('ok ' + label + '\n');
}

// --- 1. The two tables agree ------------------------------------------------

// Pulled out of the Python source rather than by running it: the sidecar needs
// torch and onnxruntime to import, and this assertion has to hold on a machine
// that has neither.
function pythonCapabilities() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'sidecar', 'transcribe.py'), 'utf8');
  const start = source.indexOf('ENGINE_CAPABILITIES = {');
  assert.ok(start >= 0, 'sidecar must declare ENGINE_CAPABILITIES');
  let depth = 0;
  let end = -1;
  for (let i = source.indexOf('{', start); i < source.length; i++) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  assert.ok(end > 0, 'ENGINE_CAPABILITIES must be a closed literal');
  const literal = source.slice(source.indexOf('{', start), end)
    .replace(/\bNone\b/g, 'null')
    .replace(/\bTrue\b/g, 'true')
    .replace(/\bFalse\b/g, 'false')
    .replace(/,(\s*[}\]])/g, '$1');
  return JSON.parse(literal);
}

const python = pythonCapabilities();
eq('both sides list the same engines', Object.keys(python).sort(), caps.ENGINE_IDS.slice().sort());

for (const id of caps.ENGINE_IDS) {
  const js = caps.capabilitiesFor(id);
  const py = python[id];
  eq(id + ': same vocabulary mechanism', py.vocabulary, js.vocabulary.mechanism);
  eq(id + ': same token budget', py.max_vocabulary_tokens, js.vocabulary.maxTokens);
  eq(id + ': same languages', py.languages, js.languages.slice());
  eq(id + ': same confidence claim', py.confidence, js.confidence);
}

// --- 2. The mechanisms are the real ones ------------------------------------
//
// These names are not labels, they are argument names in somebody else's
// library. faster-whisper takes initial_prompt; qwen_asr 0.0.6 takes context
// and puts it in the system message; onnx-asr's recognize() takes neither.
eq('whisper biases through initial_prompt', caps.vocabularyMechanism('whisper'), 'initial_prompt');
eq('qwen biases through context', caps.vocabularyMechanism('qwen3-asr'), 'context');
eq('parakeet cannot be biased', caps.vocabularyMechanism('parakeet'), null);
ok('parakeet reports no vocabulary support', !caps.supportsVocabulary('parakeet'));
ok('parakeet is English only', caps.supportsLanguage('parakeet', 'en') && !caps.supportsLanguage('parakeet', 'hi'));
ok('whisper takes Hindi', caps.supportsLanguage('whisper', 'hi'));
ok('qwen takes Hindi', caps.supportsLanguage('qwen3-asr', 'hi'));

// Whisper's prompt window is 223 tokens; the budget has to leave room under it
// rather than aim at it, because the tail is what gets cut and the tail, after
// ranking, is the newest terms.
ok('whisper budget stays under its prompt window', caps.vocabularyBudget('whisper').maxTokens < 223);
ok('qwen budget is larger than whisper’s', caps.vocabularyBudget('qwen3-asr').maxTokens
  > caps.vocabularyBudget('whisper').maxTokens);
eq('an engine with no mechanism has no budget', caps.vocabularyBudget('parakeet').maxTokens, 0);

// --- 3. A vocabulary request is never silently dropped ----------------------

eq('no terms means no vocabulary route', caps.vocabularyRoute('whisper', 0), 'none');
eq('a capable engine names its mechanism', caps.vocabularyRoute('qwen3-asr', 5), 'context');
eq('an incapable engine falls to repair, not to nothing',
  caps.vocabularyRoute('parakeet', 5), 'repair');

// The case that shipped broken: an accurate dictation on a CPU was handed to
// Parakeet for speed, and the user's dictionary went nowhere.
const lost = caps.planRoute({
  engine: 'whisper',
  fastEngine: 'parakeet',
  language: 'en',
  device: 'cpu',
  quality: 'accurate',
  termCount: 12,
});
eq('the swap still happens by default', lost.engine, 'parakeet');
ok('and the loss is named', lost.lostCapabilities.includes('vocabulary:in-model'));
ok('and it is marked degraded', lost.degraded);
ok('and the reason says so in words', /dictionary/i.test(lost.reason));
eq('and the vocabulary falls back to repair', lost.vocabularyVia, 'repair');

const kept = caps.planRoute({
  engine: 'whisper',
  fastEngine: 'parakeet',
  language: 'en',
  device: 'cpu',
  quality: 'accurate',
  termCount: 12,
  requireInModelVocabulary: true,
});
eq('requiring in-model vocabulary keeps the capable engine', kept.engine, 'whisper');
eq('and the terms reach the model', kept.vocabularyVia, 'initial_prompt');
eq('and nothing is lost', kept.lostCapabilities, []);

const noTerms = caps.planRoute({
  engine: 'whisper',
  fastEngine: 'parakeet',
  language: 'en',
  device: 'cpu',
  quality: 'accurate',
  termCount: 0,
  requireInModelVocabulary: true,
});
eq('with an empty dictionary there is nothing to protect', noTerms.engine, 'parakeet');
eq('and nothing is reported lost', noTerms.lostCapabilities, []);

const hindi = caps.planRoute({
  engine: 'whisper',
  fastEngine: 'parakeet',
  language: 'hi',
  device: 'cpu',
  quality: 'fast',
  termCount: 3,
});
eq('Hindi never reaches the English-only engine', hindi.engine, 'whisper');

const hindiOnParakeet = caps.planRoute({ engine: 'parakeet', language: 'hi', termCount: 0 });
ok('choosing Parakeet for Hindi is reported, not hidden',
  hindiOnParakeet.degraded && hindiOnParakeet.lostCapabilities.includes('language:hi'));

// A fast dictation with a vocabulary-capable primary and no fast engine stays
// put rather than inventing a route.
eq('no fast engine means no swap',
  caps.planRoute({ engine: 'qwen3-asr', language: 'en', quality: 'fast', termCount: 4 }).engine,
  'qwen3-asr');

eq('Auto and Accurate keep in-model vocabulary',
  caps.shouldRequireInModelVocabulary('auto'), true);
eq('Accurate does too', caps.shouldRequireInModelVocabulary('accurate'), true);
eq('explicit Fast is allowed to drop it', caps.shouldRequireInModelVocabulary('fast'), false);

const qwenAuto = caps.planRoute({
  engine: 'qwen3-asr',
  fastEngine: 'parakeet',
  language: 'en',
  device: 'cpu',
  quality: 'fast',
  termCount: 97,
  requireInModelVocabulary: true,
});
eq('Qwen + Auto heuristic + dictionary stays on Qwen', qwenAuto.engine, 'qwen3-asr');
eq('and the dictionary still goes in as context', qwenAuto.vocabularyVia, 'context');
eq('and nothing is lost', qwenAuto.lostCapabilities, []);

const qwenAccurate = caps.planRoute({
  engine: 'qwen3-asr',
  fastEngine: 'parakeet',
  language: 'en',
  device: 'cpu',
  quality: 'accurate',
  termCount: 12,
  requireInModelVocabulary: true,
});
eq('Qwen + Accurate + dictionary stays on Qwen', qwenAccurate.engine, 'qwen3-asr');

const qwenFast = caps.planRoute({
  engine: 'qwen3-asr',
  fastEngine: 'parakeet',
  language: 'en',
  device: 'cpu',
  quality: 'fast',
  termCount: 12,
  requireInModelVocabulary: false,
});
eq('explicit Fast English may use Parakeet', qwenFast.engine, 'parakeet');
ok('and the loss is named', qwenFast.degraded && qwenFast.lostCapabilities.includes('vocabulary:in-model'));
eq('and vocabulary is applied afterwards', qwenFast.vocabularyVia, 'repair');

eq('Qwen Hindi Fast never reaches Parakeet',
  caps.planRoute({
    engine: 'qwen3-asr', fastEngine: 'parakeet', language: 'hi',
    quality: 'fast', termCount: 8, requireInModelVocabulary: false,
  }).engine,
  'qwen3-asr');
eq('Hinglish is still not English-only Parakeet',
  caps.planRoute({
    engine: 'qwen3-asr', fastEngine: 'parakeet', language: 'hi',
    quality: 'fast', termCount: 0,
  }).engine,
  'qwen3-asr');

eq('term count is what the planner sees, not an engine-specific prompt',
  caps.planRoute({
    engine: 'qwen3-asr', fastEngine: 'parakeet', language: 'en',
    device: 'cpu', quality: 'fast', termCount: 97, requireInModelVocabulary: true,
  }).engine,
  'qwen3-asr');

// --- 4. What the user is told ----------------------------------------------

ok('the description names the engine', /Parakeet/.test(caps.describeRoute(lost, { device: 'CPU' })));
ok('and says the dictionary was applied afterwards',
  /after recognition/.test(caps.describeRoute(lost, { device: 'CPU' })));
ok('and a good route says the model was told',
  /sent to the model/.test(caps.describeRoute(kept, { device: 'CPU' })));
eq('the compact line names Qwen and the term count',
  caps.summarizeRoute(qwenAuto, { termsSent: 96 }),
  'Qwen3-ASR · dictionary sent to the model · 96 terms');
eq('and Fast Parakeet says the dictionary was applied afterwards',
  caps.summarizeRoute(qwenFast, { quality: 'fast' }),
  'Parakeet Fast · dictionary applied after recognition');

// --- 5. The mechanism's dependency is pinned --------------------------------
//
// Qwen3-ASR's vocabulary support is one keyword argument on a 0.0.x package.
// A floating requirement could remove or rename it, and the failure would be
// silent in the worst way: the request still succeeds, the terms still go
// nowhere, and nothing reports it. That is the exact bug this work fixed, so
// the version it was verified against is pinned and the pin is guarded here.
const requirements = fs.readFileSync(
  path.join(__dirname, '..', 'sidecar', 'requirements-asr.txt'), 'utf8'
);
const requirementLines = requirements.split(/\r?\n/).map((line) => line.trim());
for (const pkg of ['qwen-asr', 'transformers', 'accelerate', 'onnx-asr[hub]']) {
  ok(pkg + ' is pinned to an exact version',
    requirementLines.some((line) => line.startsWith(pkg + '==')));
}
// The pinned version has to be the one the mechanism was verified against.
ok('qwen-asr is pinned to the version whose transcribe() takes context',
  requirementLines.includes('qwen-asr==0.0.6'));

const sidecarSource = fs.readFileSync(path.join(__dirname, '..', 'sidecar', 'transcribe.py'), 'utf8');
const qwenStart = sidecarSource.indexOf('class QwenBackend:');
const qwenEnd = sidecarSource.indexOf('\ndef wav_duration_sec');
ok('QwenBackend is present in the sidecar', qwenStart >= 0 && qwenEnd > qwenStart);
const qwenBlock = sidecarSource.slice(qwenStart, qwenEnd);
ok('QwenBackend.transcribe passes context=', /context\s*=\s*context/.test(qwenBlock));
ok('QwenBackend.transcribe does not discard prompt', !/^\s*del prompt\b/m.test(qwenBlock));

// --- 6. Unknown input does not become a silent default ----------------------
eq('an unknown engine normalises to whisper', caps.normalizeEngine('nope'), 'whisper');
eq('and so does an empty one', caps.normalizeEngine(''), 'whisper');

process.stdout.write('all ' + checks + ' ASR capability checks passed\n');
