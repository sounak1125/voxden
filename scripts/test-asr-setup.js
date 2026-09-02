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
    h.run('delete process.env.VOXDEN_PYTHON; startSidecar();');
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
    h.run('restartSidecar();');
    assert.strictEqual(h.launches.length, 0, 'removal remains disabled even if settings request a restart');
    assert.deepStrictEqual(entered.slice(1), ['remove-runtime', 'remove-model', 'remove-extras']);

    // One optional model goes on its own: the speech process is stopped before
    // its files are touched, only that model's store is asked, and the switch
    // that disables dictation is not thrown.
    fs.rmSync(path.join(h.root, 'asr-runtime', 'disabled.json'), { force: true });
    const removed = [];
    let killedBeforeRemove = null;
    const live = new h.Process();
    h.context.testLive = live;
    h.run('sidecar = testLive;');
    h.context.testExtras.remove = async (ids) => { killedBeforeRemove = live.killed; removed.push(ids); };
    await h.handlers.get('speech-model-remove')(null, 'parakeet');
    assert.strictEqual(killedBeforeRemove, true, 'the speech process is stopped before the model is removed');
    assert.deepStrictEqual(removed.map((ids) => [...ids]), [['parakeet']], 'only the named model is removed');
    assert.strictEqual(h.run('asrIsDisabled()'), false, 'removing one model does not disable dictation');
    assert.strictEqual(h.run('asrOperation'), null);
    assert.strictEqual(h.run('removingAsrRuntime'), false, 'the removal flag does not outlive the removal');
    assert.strictEqual(h.run('asrRuntimeState.status'), 'idle');
    assert(/Parakeet TDT 0.6B was removed/.test(h.run('asrRuntimeState.message')));
    const modelRemovals = entered.filter(e => e === 'remove-model').length;
    await h.handlers.get('speech-model-remove')(null, 'whisper');
    assert.strictEqual(entered.filter(e => e === 'remove-model').length, modelRemovals + 1, 'Whisper goes through its own store');
    await h.handlers.get('speech-model-remove')(null, 'not-a-model');
    assert.deepStrictEqual(removed.map((ids) => [...ids]), [['parakeet']], 'an unknown id removes nothing');

    // A GPU pack's libraries are open in the speech process. It is removed
    // only once that process is gone, and a removal that still fails is
    // reported rather than leaving the card claiming the pack is installed.
    let cudaKilledBeforeRemove = null;
    const gpuProc = new h.Process();
    h.context.testGpuProc = gpuProc;
    h.context.testCuda = { snapshot: () => ({ installed: true }), installed: () => null,
      remove: async () => { cudaKilledBeforeRemove = gpuProc.killed; } };
    h.run('sidecar = testGpuProc; cudaPackManager = testCuda;');
    await h.handlers.get('cuda-pack-remove')();
    assert.strictEqual(cudaKilledBeforeRemove, true, 'the pack goes only after the process holding its libraries');
    assert.strictEqual(h.run('removingAsrRuntime'), false);
    assert.strictEqual(h.run('cudaPackState.status'), 'idle');
    h.context.testCuda.remove = async () => { throw new Error('python.exe is still open'); };
    await h.handlers.get('cuda-pack-remove')();
    assert.strictEqual(h.run('cudaPackState.status'), 'error', 'a failed removal is reported, not swallowed');
    assert(/still open/.test(h.run('cudaPackState.message')), h.run('cudaPackState.message'));
    assert.strictEqual(h.run('removingAsrRuntime'), false, 'even a failed removal releases the flag');

    h.run("asrRuntimeState = {status: 'preparing', step: 'model'}; saveAsrSetupState(); asrRuntimeState = {}; loadAsrSetupState();");
    assert.strictEqual(h.run('asrRuntimeState.status'), 'cancelled', 'interrupted setup survives app restart');
    h.run("settings.asrEngine = 'qwen3-asr'; saveSettings(); loadSettings();");
    assert.strictEqual(h.run('settings.asrEngine'), 'qwen3-asr', 'removal preserves model choice');
    assert(fs.existsSync(path.join(h.root, 'data/settings.json')), 'user settings survive removal');
    console.log('all speech setup lifecycle tests passed');
  } finally { h.close(); }
}
main().catch(err => { console.error(err); process.exitCode = 1; });
