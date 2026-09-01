'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const harness = require('./asr-test-harness');

async function main() {
  const h = harness();
  try {
    assert.strictEqual(h.run('findPython()'), null, 'a packaged app never borrows system Python');
    h.run("process.env.VOXDEN_PYTHON = 'custom-python.exe'");
    assert.strictEqual(h.run('findPython()'), 'custom-python.exe');
    h.run('delete process.env.VOXDEN_PYTHON; startSidecar(); startMarker();');
    assert.strictEqual(h.launches.length, 0, 'missing runtime starts no subprocesses');
    assert.strictEqual(h.run('sidecarState'), 'unavailable');

    let finishRuntime;
    let signalRuntimeStarted;
    const runtimeStarted = new Promise(resolve => { signalRuntimeStarted = resolve; });
    const entered = [];
    h.context.testRuntime = {
      snapshot: () => ({ installed: false, downloadBytes: 100 }), installed: () => null,
      install: () => { entered.push('runtime'); signalRuntimeStarted(); return new Promise(resolve => { finishRuntime = resolve; }); },
      remove: async () => { entered.push('remove-runtime'); }, cancel() {},
    };
    h.context.testModel = {
      snapshot: () => ({ installed: false, downloadBytes: 200 }), installed: () => null,
      install: async () => { entered.push('model'); }, remove: async () => { entered.push('remove-model'); }, cancel() {},
    };
    h.context.testExtras = {
      // `packs` and `pendingBytes` are what src/model-plan.js reads to decide
      // which models this configuration actually needs; setup asks for a named
      // subset now rather than for everything. One pack here, so the plan has
      // something to select and the engine choice below still means something.
      snapshot: () => ({ installed: false, downloadBytes: 300,
        packs: [{ id: 'qwen3-asr', name: 'Qwen3-ASR', installed: false, downloadBytes: 300 }] }),
      installed: () => null,
      pendingBytes: () => 300,
      install: async () => { entered.push('extras'); }, remove: async () => { entered.push('remove-extras'); }, cancel() {},
    };
    h.run('asrRuntimeManager = testRuntime; asrModelManager = testModel; speechModelsManager = testExtras;');
    const first = h.handlers.get('asr-runtime-install')();
    const second = h.handlers.get('asr-runtime-install')();
    assert.strictEqual(first, second, 'repeated installs share one operation');
    await Promise.race([runtimeStarted, first.then(() => { throw new Error('Setup ended before the runtime started'); })]);
    assert.deepStrictEqual(entered, ['runtime']);
    h.run("reportSetup('engine', {status: 'installed', progress: 100})");
    assert.strictEqual(h.run('asrRuntimeState.status'), 'installing', 'component success cannot unlock setup');
    assert.strictEqual(h.handlers.get('asr-runtime-remove')(), first, 'removal cannot race an active install');
    h.handlers.get('asr-runtime-cancel')();
    finishRuntime();
    await first;
    assert.deepStrictEqual(entered, ['runtime'], 'cancel between components cannot start another download');
    assert.strictEqual(h.run('asrRuntimeState.status'), 'cancelled');
    assert.strictEqual(h.run('asrOperation'), null);

    const pendingProbe = new h.Process();
    h.context.testProbe = pendingProbe;
    h.run('sidecarProbe = testProbe; sidecarRestartTimer = setTimeout(() => startSidecar(), 5000); sidecarRestartNow = true;');
    await h.handlers.get('asr-runtime-remove')();
    assert(pendingProbe.killed, 'removal kills an outstanding dependency probe');
    assert.strictEqual(h.timers.size, 0, 'removal clears scheduled restarts and process timeout timers');
    assert.strictEqual(h.run('asrIsDisabled()'), true);
    assert.strictEqual(h.run('sidecarState'), 'unavailable');
    h.run('restartSidecar(); startMarker();');
    assert.strictEqual(h.launches.length, 0, 'removal remains disabled even if settings request a restart');
    assert.deepStrictEqual(entered.slice(1), ['remove-runtime', 'remove-model', 'remove-extras']);

    h.run("asrRuntimeState = {status: 'preparing', step: 'model'}; saveAsrSetupState(); asrRuntimeState = {}; loadAsrSetupState();");
    assert.strictEqual(h.run('asrRuntimeState.status'), 'cancelled', 'interrupted setup survives app restart');
    h.run("settings.asrEngine = 'qwen3-asr'; saveSettings(); loadSettings();");
    assert.strictEqual(h.run('settings.asrEngine'), 'qwen3-asr', 'removal preserves model choice');
    assert(fs.existsSync(path.join(h.root, 'data/settings.json')), 'user settings survive removal');
    console.log('all speech setup lifecycle tests passed');
  } finally { h.close(); }
}
main().catch(err => { console.error(err); process.exitCode = 1; });
