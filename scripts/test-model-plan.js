'use strict';

// What a machine has to download, and what it is merely offered.
//
// Setup used to be all-or-nothing. SpeechModelsManager.install() took no
// argument and fetched every pack; setupDictation called it next to the
// Whisper download unconditionally; the banner added the lot up and told a
// first-run user "up to 11.0 GB" before they had dictated a word:
//
//   Whisper large-v3   3.10 GB    only if you pick Whisper
//   Qwen3-ASR 1.7B     4.70 GB    only if you pick Qwen
//   Parakeet int8      0.66 GB    the CPU fast path
//   Parakeet float32   2.51 GB    the DirectML fast path
//
// Exactly one Parakeet precision can ever load on a given machine, and on the
// runtime Voxden ships there is no CUDA execution provider at all, so the
// float32 weights are reachable only when the processor is set to AMD or Intel
// by hand. These tests hold that line.

const assert = require('assert');
const plan = require('../src/model-plan');
const asr = require('../src/asr');

let checks = 0;
function ok(label, value) {
  assert.ok(value, label);
  checks += 1;
  process.stdout.write('ok ' + label + '\n');
}
function eq(label, actual, expected) {
  assert.deepStrictEqual(actual, expected, label + '\n  got: ' + JSON.stringify(actual));
  checks += 1;
  process.stdout.write('ok ' + label + '\n');
}

// The real catalogue sizes, so the figures below are the ones users see.
const SIZES = {
  whisper: 3.1e9,
  'qwen3-asr': 4700000000,
  parakeet: 660000000,
  'parakeet-fp32': 2510000000,
};
const GB = (n) => Number((n / 1e9).toFixed(2));

function planFor(overrides) {
  return plan.plan(Object.assign({ sizes: SIZES, installed: {} }, overrides));
}

// --- 1. A first run downloads one engine, not all of them -------------------
const qwenFirstRun = planFor({ engine: 'qwen3-asr', device: 'auto' });
eq('a Qwen install needs only Qwen', qwenFirstRun.required, ['qwen3-asr']);
eq('and that is what it costs', GB(qwenFirstRun.requiredBytes), 4.7);
ok('which is far less than every model added together',
  qwenFirstRun.requiredBytes < Object.values(SIZES).reduce((a, b) => a + b, 0) / 2);

eq('a Whisper install needs only Whisper',
  planFor({ engine: 'whisper', device: 'auto' }).required, ['whisper']);
eq('a Parakeet install needs only the int8 weights',
  planFor({ engine: 'parakeet', device: 'auto' }).required, ['parakeet']);
eq('and that is the smallest install there is',
  GB(planFor({ engine: 'parakeet', device: 'auto' }).requiredBytes), 0.66);

// --- 2. The duplicate Parakeet is never fetched twice -----------------------
for (const device of ['auto', 'cpu', 'cuda']) {
  const p = planFor({ engine: 'qwen3-asr', device });
  ok('on ' + device + ', the float32 Parakeet is not even offered',
    p.hidden.includes('parakeet-fp32') && !p.optional.includes('parakeet-fp32'));
  ok('and the int8 build is the one on offer', p.optional.includes('parakeet'));
}
const directml = planFor({ engine: 'qwen3-asr', device: 'directml' });
ok('choosing the AMD or Intel processor offers the float32 build instead',
  directml.optional.includes('parakeet-fp32') && !directml.optional.includes('parakeet'));
eq('and Parakeet as a primary engine there needs the float32 build',
  planFor({ engine: 'parakeet', device: 'directml' }).required, ['parakeet-fp32']);

for (const p of [qwenFirstRun, directml, planFor({ engine: 'whisper', device: 'cpu' })]) {
  ok('no plan ever asks for both Parakeet precisions',
    !(p.required.concat(p.optional).includes('parakeet')
      && p.required.concat(p.optional).includes('parakeet-fp32')));
}

// The sidecar's own rule, mirrored: int8 on the CPU, float32 on a GPU.
eq('auto resolves to the int8 pack', plan.parakeetPackFor('auto'), 'parakeet');
eq('cpu resolves to the int8 pack', plan.parakeetPackFor('cpu'), 'parakeet');
eq('cuda resolves to the int8 pack, because the runtime has no CUDA provider',
  plan.parakeetPackFor('cuda'), 'parakeet');
eq('directml resolves to the float32 pack', plan.parakeetPackFor('directml'), 'parakeet-fp32');

// --- 3. The fast English path is a separate, small download -----------------
const fast = qwenFirstRun.items.find((i) => i.id === 'parakeet');
eq('the fast path is optional', fast.role, 'optional');
eq('and costs 0.66 GB', GB(fast.bytes), 0.66);
ok('and says what it is for', /fast/i.test(fast.summary) && /English/i.test(fast.summary));

eq('a Hindi dictation is not offered an English-only engine',
  planFor({ engine: 'qwen3-asr', device: 'auto', language: 'hi' }).optional, ['whisper']);
ok('and Parakeet is hidden rather than shown as unavailable',
  planFor({ engine: 'qwen3-asr', device: 'auto', language: 'hi' }).hidden.includes('parakeet'));
ok('choosing Parakeet itself does not offer Parakeet again',
  !planFor({ engine: 'parakeet', device: 'auto' }).optional.includes('parakeet'));

// --- 4. Other engines are an offer, not a requirement -----------------------
eq('a Qwen user is offered Whisper as a fallback',
  qwenFirstRun.optional.includes('whisper'), true);
eq('but does not need it to dictate', qwenFirstRun.missing, ['qwen3-asr']);
const qwenReady = planFor({ engine: 'qwen3-asr', device: 'auto', installed: { 'qwen3-asr': true } });
ok('with its engine installed the plan is ready', qwenReady.ready);
eq('and nothing is missing', qwenReady.missing, []);
ok('even though the other engines are still absent', qwenReady.optional.length > 0);

// --- 5. Switching engine names the download instead of failing --------------
eq('switching to Whisper with only Qwen installed asks for Whisper',
  plan.missingFor({ engine: 'whisper', device: 'auto', sizes: SIZES, installed: { 'qwen3-asr': true } }),
  ['whisper']);
eq('switching back costs nothing',
  plan.missingFor({ engine: 'qwen3-asr', device: 'auto', sizes: SIZES, installed: { 'qwen3-asr': true } }),
  []);
eq('switching the processor to AMD or Intel needs the float32 weights',
  plan.missingFor({ engine: 'parakeet', device: 'directml', sizes: SIZES, installed: { parakeet: true } }),
  ['parakeet-fp32']);

// --- 6. Every engine the picker offers has a plan ---------------------------
for (const engine of Object.keys(asr.ASR_ENGINES)) {
  for (const device of asr.ASR_DEVICES) {
    const p = planFor({ engine, device });
    eq(engine + '/' + device + ' requires exactly one model', p.required.length, 1);
    ok(engine + '/' + device + ' accounts for every component',
      p.required.length + p.optional.length + p.hidden.length === plan.COMPONENT_IDS.length);
    ok(engine + '/' + device + ' costs less than the old all-in download',
      p.requiredBytes < 5e9);
  }
}

// --- 7. Sizes come from the caller, not from here ---------------------------
eq('a component with no size reported costs nothing',
  plan.plan({ engine: 'whisper', device: 'auto', sizes: {}, installed: {} }).requiredBytes, 0);
eq('an unknown engine falls back to Whisper',
  plan.modelForEngine('nonsense', 'auto'), 'whisper');

process.stdout.write('all ' + checks + ' model plan checks passed\n');
