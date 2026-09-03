'use strict';

// Setup downloads the engine you chose, and nothing else.
//
// The old flow called asrModelManager.install() and speechModelsManager
// .install() unconditionally, one after the other, so every install fetched
// Whisper, Qwen and both Parakeet precisions -- 11.0 GB, most of it for
// engines the user had not selected. These tests drive the real src/main.js
// and assert on which downloads it actually starts.

const assert = require('assert');
const harness = require('./asr-test-harness');

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

const PACKS = [
  { id: 'qwen3-asr', name: 'Qwen3-ASR 1.7B', downloadBytes: 4700000000 },
  { id: 'parakeet', name: 'Parakeet TDT 0.6B', downloadBytes: 660000000 },
  { id: 'parakeet-fp32', name: 'Parakeet TDT 0.6B (GPU)', downloadBytes: 2510000000 },
];

const h = harness();

// Managers that record what they were asked to fetch instead of fetching it.
function install(state) {
  h.context.testRuntime = {
    snapshot: () => ({ installed: true, needsUpgrade: false, downloadBytes: 0 }),
    installed: () => ({ torchDevice: 'cpu' }),
    install: async () => { state.calls.push('runtime'); },
    remove: async () => {}, cancel() {},
  };
  h.context.testModel = {
    snapshot: () => ({ installed: !!state.installed.whisper, downloadBytes: 3.1e9 }),
    installed: () => (state.installed.whisper ? { path: 'whisper' } : null),
    install: async () => { state.calls.push('whisper'); },
    remove: async () => {}, cancel() {},
  };
  h.context.testExtras = {
    snapshot: () => ({
      packs: PACKS.map((p) => Object.assign({}, p, { installed: !!state.installed[p.id] })),
      installed: PACKS.every((p) => state.installed[p.id]),
      downloadBytes: PACKS.filter((p) => !state.installed[p.id])
        .reduce((n, p) => n + p.downloadBytes, 0),
    }),
    installed: (id) => (state.installed[id] ? { id } : null),
    pendingBytes: (ids) => PACKS
      .filter((p) => (ids || PACKS.map((x) => x.id)).includes(p.id) && !state.installed[p.id])
      .reduce((n, p) => n + p.downloadBytes, 0),
    install: async (ids) => { state.calls.push('speech:' + (ids || ['*']).join('+')); },
    remove: async () => {}, cancel() {},
  };
  h.run('asrRuntimeManager = testRuntime; asrModelManager = testModel; speechModelsManager = testExtras;');
}

async function main() {
  // --- 1. A Qwen install fetches Qwen only --------------------------------
  const qwen = { calls: [], installed: {} };
  install(qwen);
  h.run("settings.asrEngine = 'qwen3-asr'; settings.asrDevice = 'auto'; settings.dictationLanguage = 'en';");
  eq('the plan asks for Qwen and nothing else',
    h.run('currentModelPlan().required'), ['qwen3-asr']);
  eq('and prices it on its own',
    Number((h.run('currentModelPlan().requiredBytes') / 1e9).toFixed(2)), 4.7);

  await h.handlers.get('asr-runtime-install')();
  eq('setup downloaded the runtime and Qwen, nothing more',
    qwen.calls, ['runtime', 'speech:qwen3-asr']);
  ok('Whisper was never fetched', !qwen.calls.includes('whisper'));
  ok('and neither Parakeet precision was',
    !qwen.calls.some((c) => c.includes('parakeet')));

  // --- 2. A Whisper install fetches Whisper only ---------------------------
  const whisper = { calls: [], installed: {} };
  install(whisper);
  h.run("settings.asrEngine = 'whisper';");
  await h.handlers.get('asr-runtime-install')();
  eq('a Whisper install touches only the Whisper download',
    whisper.calls, ['runtime', 'whisper']);

  // --- 3. Parakeet installs the precision its processor can load -----------
  const parakeet = { calls: [], installed: {} };
  install(parakeet);
  h.run("settings.asrEngine = 'parakeet'; settings.asrDevice = 'auto';");
  await h.handlers.get('asr-runtime-install')();
  eq('auto gets the int8 build', parakeet.calls, ['runtime', 'speech:parakeet']);

  const dml = { calls: [], installed: {} };
  install(dml);
  h.run("settings.asrEngine = 'parakeet'; settings.asrDevice = 'directml';");
  await h.handlers.get('asr-runtime-install')();
  eq('the AMD or Intel processor gets the float32 build',
    dml.calls, ['runtime', 'speech:parakeet-fp32']);
  ok('and never both at once', dml.calls.filter((c) => c.includes('parakeet')).length === 1);

  // --- 4. The fast English path is its own download ------------------------
  const extra = { calls: [], installed: { 'qwen3-asr': true } };
  install(extra);
  h.run("settings.asrEngine = 'qwen3-asr'; settings.asrDevice = 'auto';");
  ok('with its engine present, setup has nothing left to do',
    h.run('currentModelPlan().ready'));
  // asrRuntimeWouldHelp also fires when the sidecar itself will not start, so
  // that has to be healthy before the plan is the only thing left to judge.
  h.run("sidecarState = 'ready';");
  eq('and the banner stops asking', h.run('asrRuntimeWouldHelp()'), false);
  ok('but the fast path is on offer',
    h.run('currentModelPlan().optional').includes('parakeet'));

  await h.handlers.get('speech-model-install')(null, 'parakeet');
  eq('accepting the offer fetches only that pack',
    extra.calls, ['runtime', 'speech:parakeet']);

  // --- 5. An unknown component is refused ----------------------------------
  const before = extra.calls.length;
  await h.handlers.get('speech-model-install')(null, 'not-a-model');
  eq('an unknown component downloads nothing', extra.calls.length, before);

  // --- 6. Switching engine names the download rather than breaking ---------
  h.run("settings.asrEngine = 'whisper';");
  ok('switching to an engine with no model is not ready',
    !h.run('currentModelPlan().ready'));
  eq('and says exactly what is missing', h.run('currentModelPlan().missing'), ['whisper']);
  eq('and the banner offers it again', h.run('asrRuntimeWouldHelp()'), true);
  h.run("settings.asrEngine = 'qwen3-asr';");
  ok('switching back needs no download at all', h.run('currentModelPlan().ready'));

  // --- 7. The snapshot the renderer reads ----------------------------------
  const snap = h.run('snapshot()');
  ok('the snapshot carries the plan', snap.modelPlan);
  eq('with the engine it was built for', snap.modelPlan.engine, 'qwen3-asr');
  ok('and every component accounted for',
    snap.modelPlan.required.length + snap.modelPlan.optional.length
      + snap.modelPlan.hidden.length === 4);
  ok('the required figure is not the sum of everything that exists',
    snap.modelPlan.requiredBytes === 0);

  // Recording blocked by setup must land at the controls that can fix it.
  h.context.openedSettings = [];
  h.run("openHistory = cat => openedSettings.push(cat); sidecarState = 'unavailable'; startRecording(false);");
  h.run("sidecarState = 'ready'; asrOperation = { kind: 'install' }; startRecording(true); asrOperation = null;");
  h.run("fs.mkdirSync(path.dirname(asrDisabledPath()), { recursive: true }); fs.writeFileSync(asrDisabledPath(), '{}'); startRecording(false);");
  eq('missing, installing, and disabled engines each open Speech engines once',
    h.context.openedSettings, ['speech-engines', 'speech-engines', 'speech-engines']);
}

main().then(() => {
  h.close();
  process.stdout.write('all ' + checks + ' speech setup plan checks passed\n');
}).catch((err) => {
  h.close();
  process.stderr.write(String((err && err.stack) || err) + '\n');
  process.exit(1);
});
