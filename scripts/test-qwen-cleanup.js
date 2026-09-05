'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { QwenAccelPackManager, MARKER_NAME, catalog } = require('../src/qwen-accel-pack');
const { cleanupLegacyPack, CLEANUP_RECEIPT, INSTALL_STATE } = require('../src/qwen-pack-cleanup');
const harness = require('./asr-test-harness');
const passed = () => ({ importOk: true, tensorProbeOk: true, qwenProbeOk: true });
const tick = () => new Promise(resolve => setTimeout(resolve, 20));

function put(root, name, body = 'leftover') {
  const file = path.join(root, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  return file;
}

async function fixture(kind = 'cuda', extraBeforeCommit = null) {
  const top = fs.mkdtempSync(path.join(os.tmpdir(), 'voxden-cleanup-'));
  const root = path.join(top, 'gpu');
  const spec = catalog[kind];
  const manager = new QwenAccelPackManager({ root, kind,
    fetchImpl: async () => { throw new Error('Cleanup must never download'); },
    validateRuntime: async () => passed() });
  put(root, 'runtime/python.exe', 'working-python');
  put(root, 'runtime/' + MARKER_NAME, JSON.stringify({ id: spec.id, kind }));
  put(root, 'runtime/Lib/site-packages/torch/__init__.py', 'working-torch');
  put(root, 'runtime/Lib/site-packages/qwen_asr/__init__.py', 'working-qwen');
  put(root, 'downloads/' + spec.asset, 'old-archive');
  put(root, 'downloads/' + spec.asset + '.part01', 'old-part');
  put(root, 'runtime.previous/python.exe', 'old-python');
  put(root, 'runtime.pending/abandoned.txt', 'old-extraction');
  put(top, 'models/qwen/weights.safetensors', 'keep-model');
  put(top, 'data/history.json', 'keep-history');
  put(top, 'data/settings.json', 'keep-settings');
  if (extraBeforeCommit) extraBeforeCommit(root, spec);
  // Use real filesystem creation times on Windows, including ctime/birthtime.
  await tick();
  await manager.writeReceipt({ id: spec.id, asset: spec.asset, sha256: spec.sha256 }, passed());
  const receipt = JSON.parse(fs.readFileSync(manager.receiptPath()));
  const confirmation = { ...passed(), kind, id: spec.id, pythonPath: manager.pythonPath() };
  const intact = () => {
    assert.strictEqual(fs.readFileSync(manager.pythonPath(), 'utf8'), 'working-python');
    assert.strictEqual(fs.readFileSync(path.join(root, 'runtime/Lib/site-packages/torch/__init__.py'), 'utf8'), 'working-torch');
    assert.strictEqual(fs.readFileSync(path.join(root, 'runtime/Lib/site-packages/qwen_asr/__init__.py'), 'utf8'), 'working-qwen');
    assert.strictEqual(fs.readFileSync(path.join(top, 'models/qwen/weights.safetensors'), 'utf8'), 'keep-model');
    assert.strictEqual(fs.readFileSync(path.join(top, 'data/history.json'), 'utf8'), 'keep-history');
    assert.strictEqual(fs.readFileSync(path.join(top, 'data/settings.json'), 'utf8'), 'keep-settings');
    assert(manager.healthy());
  };
  const leftovers = () => {
    assert(fs.existsSync(path.join(root, 'downloads', spec.asset)));
    assert(fs.existsSync(path.join(root, 'runtime.previous/python.exe')));
    assert(fs.existsSync(path.join(root, 'runtime.pending/abandoned.txt')));
  };
  return { top, root, spec, manager, receipt, confirmation, intact, leftovers,
    cleanup: () => fs.rmSync(top, { recursive: true, force: true }) };
}

let count = 0;
async function test(name, work, kind, before) {
  const f = await fixture(kind, before);
  try { await work(f); f.intact(); console.log('ok ' + name); count++; }
  finally { f.cleanup(); }
}

async function main() {
  for (const kind of ['cuda', 'rocm']) {
    await test(kind + ': one-time cleanup removes only obsolete pack files', async f => {
      const result = await f.manager.cleanupLegacyFiles(f.confirmation);
      assert.strictEqual(result.removedFiles, 4);
      assert.strictEqual(result.removedBytes, Buffer.byteLength('old-archiveold-partold-pythonold-extraction'));
      assert(!fs.existsSync(path.join(f.root, 'runtime.previous')));
      assert(!fs.existsSync(path.join(f.root, 'runtime.pending')));
      assert.deepStrictEqual(fs.readdirSync(path.join(f.root, 'downloads')), []);
      const marker = JSON.parse(fs.readFileSync(path.join(f.root, CLEANUP_RECEIPT)));
      assert.strictEqual(marker.removedBytes, result.removedBytes);
      assert.strictEqual(marker.kind, kind);
      const next = new QwenAccelPackManager({ root: f.root, kind });
      assert.strictEqual((await next.cleanupLegacyFiles(f.confirmation)).skipped, 'already-complete');
    }, kind);
  }
  for (const field of ['importOk', 'tensorProbeOk', 'qwenProbeOk', 'id', 'pythonPath']) {
    await test('no cleanup without matching fresh verification: ' + field, async f => {
      const bad = { ...f.confirmation, [field]: field.endsWith('Ok') ? false : 'wrong' };
      assert.strictEqual((await f.manager.cleanupLegacyFiles(bad)).skipped, 'not-verified');
      f.leftovers();
      assert(!fs.existsSync(path.join(f.root, CLEANUP_RECEIPT)));
    });
  }
  await test('old pending-speech receipts can clean up after actual GPU startup succeeds', async f => {
    const old = { ...f.receipt, verified: { importOk: true, tensorProbeOk: true } };
    delete old.verificationVersion;
    fs.writeFileSync(f.manager.receiptPath(), JSON.stringify(old));
    assert(!f.manager.snapshot().verified);
    assert((await f.manager.cleanupLegacyFiles(f.confirmation)).removedFiles > 0);
  });
  await test('revalidation preserves the original installation cutoff', async f => {
    await tick();
    const newer = put(f.root, 'downloads/' + f.spec.asset + '.part02', 'resumable-new-part');
    assert((await f.manager.install()).reused);
    assert.strictEqual(f.manager.installed().installedAt, f.receipt.installedAt);
    assert.strictEqual((await f.manager.cleanupLegacyFiles(f.confirmation)).skipped, 'resumable-files');
    assert(fs.existsSync(newer));
    f.leftovers();
  });
  await test('revalidation cannot invent a cutoff for an old receipt without an install date', async f => {
    const old = { ...f.receipt };
    delete old.installedAt;
    fs.writeFileSync(f.manager.receiptPath(), JSON.stringify(old));
    assert((await f.manager.install()).reused);
    assert.strictEqual(f.manager.installed().installedAt, '');
    assert.strictEqual((await f.manager.cleanupLegacyFiles(f.confirmation)).skipped, 'unknown-install-date');
    f.leftovers();
  });
  for (const suffix of ['.partial', '.part02.partial.segments', '.part02.partial.segments.tmp']) {
    await test('Resume data is preserved even when old: ' + suffix, async f => {
      assert.strictEqual((await f.manager.cleanupLegacyFiles(f.confirmation)).skipped, 'resumable-files');
      f.leftovers();
    }, 'cuda', (root, spec) => put(root, 'downloads/' + spec.asset + suffix, 'resume-map'));
  }
  await test('unknown files keep the ambiguous download group intact', async f => {
    assert.strictEqual((await f.manager.cleanupLegacyFiles(f.confirmation)).skipped, 'resumable-files');
    f.leftovers();
  }, 'cuda', root => put(root, 'downloads/user-notes.txt', 'keep'));
  await test('new pending extraction is protected despite old archive mtimes', async f => {
    await tick();
    const file = put(f.root, 'runtime.pending/new.dll', 'partial-extraction');
    fs.utimesSync(file, new Date(0), new Date(0));
    assert.strictEqual((await f.manager.cleanupLegacyFiles(f.confirmation)).skipped, 'resumable-files');
    f.leftovers();
  });
  for (const state of [{ schemaVersion: 1, status: 'pending' }, { broken: true }]) {
    await test('interrupted or unreadable install journal prevents cleanup', async f => {
      put(f.root, INSTALL_STATE, JSON.stringify({ id: f.spec.id, ...state }));
      assert.strictEqual((await f.manager.cleanupLegacyFiles(f.confirmation)).skipped, 'resumable-install');
      f.leftovers();
    });
  }
  await test('junctions cannot redirect cleanup outside GPU storage', async f => {
    fs.rmSync(path.join(f.root, 'downloads'), { recursive: true });
    fs.symlinkSync(path.join(f.top, 'models'), path.join(f.root, 'downloads'), 'junction');
    assert.strictEqual((await f.manager.cleanupLegacyFiles(f.confirmation)).skipped, 'unsafe-downloads');
    assert(fs.existsSync(path.join(f.root, 'runtime.previous/python.exe')));
  });
  await test('links inside an abandoned runtime preserve the whole group', async f => {
    fs.symlinkSync(path.join(f.top, 'models'), path.join(f.root, 'runtime.previous/models'), 'junction');
    assert.strictEqual((await f.manager.cleanupLegacyFiles(f.confirmation)).skipped, 'resumable-files');
    f.leftovers();
  });
  await test('cleanup failure leaves no completion marker and can retry', async f => {
    await assert.rejects(cleanupLegacyPack({ root: f.root, kind: 'cuda', receipt: f.receipt, isCurrent: () => true,
      remove: async () => { throw Object.assign(new Error('file locked'), { code: 'EPERM' }); } }), /locked/);
    assert(!fs.existsSync(path.join(f.root, CLEANUP_RECEIPT)));
    f.leftovers();
    assert((await f.manager.cleanupLegacyFiles(f.confirmation)).removedFiles > 0);
  });
  await test('a changed receipt stops cleanup before deleting anything', async f => {
    let checks = 0;
    const result = await cleanupLegacyPack({ root: f.root, kind: 'cuda', receipt: f.receipt,
      isCurrent: () => ++checks === 1 });
    assert.strictEqual(result.skipped, 'changed');
    f.leftovers();
  });
  await test('active installation prevents cleanup', async f => {
    f.manager.abortController = new AbortController();
    assert.strictEqual((await f.manager.cleanupLegacyFiles(f.confirmation)).skipped, 'not-verified');
    f.manager.abortController = null;
    f.leftovers();
  });
  await test('interrupted deletion does not falsely mark the migration complete', async f => {
    const controller = new AbortController();
    const result = await cleanupLegacyPack({ root: f.root, kind: 'cuda', receipt: f.receipt,
      isCurrent: () => true, signal: controller.signal,
      remove: async () => { controller.abort(); return false; } });
    assert(result.skipped);
    assert(!fs.existsSync(path.join(f.root, CLEANUP_RECEIPT)));
    f.leftovers();
  });

  const h = harness();
  try {
    const live = new h.Process();
    h.context.cleanupLive = live;
    const calls = [];
    let finishCleanup;
    let enterCleanup;
    let cancelled = false;
    const entered = new Promise(resolve => { enterCleanup = resolve; });
    const task = new Promise(resolve => { finishCleanup = resolve; });
    h.context.cleanupManager = { kind: 'cuda', label: 'CUDA', snapshot: () => ({}), installed: () => null,
      cleanupLegacyFiles: async confirmation => { calls.push(confirmation); enterCleanup(); return task; },
      stopCleanup: () => { cancelled = true; return task; },
      install: async () => { calls.push('install'); } };
    h.context.cleanupMessage = { ready: true, engine: 'qwen3-asr', backend: 'cuda',
      pack_id: catalog.cuda.id, probe_passed: true, init_passed: true };
    h.run('qwenCudaPackManager = cleanupManager; sidecar = cleanupLive; sidecarReady = true; applyQwenSidecarReport(cleanupMessage);');
    for (const override of [{ backend: 'cpu' }, { init_passed: false }, { probe_passed: false },
      { engine: 'parakeet' }, { fallback_reason: 'failed' }]) {
      h.context.badCleanupMessage = { ...h.context.cleanupMessage, ...override };
      await h.run('cleanupVerifiedQwenPack(badCleanupMessage, "python.exe", cleanupLive)');
    }
    assert.strictEqual(calls.length, 0);
    const cleaning = h.run('cleanupVerifiedQwenPack(cleanupMessage, "python.exe", cleanupLive)');
    await entered;
    assert.strictEqual(calls[0].qwenProbeOk, true);
    const installing = h.handlers.get('qwen-accel-install')(null, 'cuda');
    await tick();
    assert(cancelled, 'user action cancels maintenance first');
    assert.strictEqual(calls.length, 1, 'installation waits for deletion already in flight');
    finishCleanup({ skipped: 'cancelled' });
    await Promise.all([cleaning, installing]);
    assert.strictEqual(calls[1], 'install', 'the user action is executed, not discarded');
    assert.strictEqual(h.run('asrOperation'), null);
    console.log('ok packaged readiness triggers cleanup; user installation takes priority');
  } finally { h.close(); }
  console.log('All ' + count + ' GPU cleanup scenarios and main-process lifecycle checks passed.');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
