'use strict';

// Exercise the shipped extractor and the real installer with tiny offline
// releases. No network, GPU, system Python, or multi-GB fixtures are required.
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { QwenAccelPackManager, MARKER_NAME, catalog, downloadSizeLabel } = require('../src/qwen-accel-pack');
const { runSevenZip, validateListing, archivePath } = require('../src/seven-zip');
const { INVENTORY, validateInventory } = require('../src/qwen-pack-files');
const { validateQwenProbe } = require('../src/qwen-verification');
const harness = require('./asr-test-harness');
const extractor = path.resolve(__dirname, '../node_modules/7zip-bin/win/x64/7za.exe');
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const passed = () => ({ importOk: true, tensorProbeOk: true, qwenProbeOk: true });
let count = 0;

async function fixture(kind = 'cuda', damage = '') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voxden-compact-'));
  const source = path.join(root, 'source');
  const base = path.join(root, 'cpu');
  const spec = catalog[kind];
  const contents = {
    'python.exe': Buffer.from('embedded-python'),
    [MARKER_NAME]: Buffer.from(JSON.stringify({ kind, id: spec.id })),
    'Lib/site-packages/torch/__init__.py': Buffer.from('complete-gpu-torch'),
    'Lib/site-packages/transformers/__init__.py': Buffer.from('complete-transformers'),
    'Lib/site-packages/qwen_asr/__init__.py': Buffer.from('complete-qwen'),
    'Lib/site-packages/other/optional-data.txt': Buffer.from('preserve-even-optional-data'),
  };
  function write(dir, name, bytes) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), bytes);
  }
  const files = Object.entries(contents).map(([name, bytes]) => {
    const shared = !name.includes('torch') && name !== MARKER_NAME;
    write(source, name, bytes);
    if (shared) write(base, name, bytes);
    return { path: name, size: bytes.length, sha256: digest(bytes), shared };
  });
  const blobs = new Map();
  const zip = path.join(root, spec.asset);
  await runSevenZip(extractor, ['a', '-tzip', zip, '.'], { cwd: source });
  blobs.set(spec.asset, fs.readFileSync(zip));
  const inventory = Buffer.from(JSON.stringify({ schemaVersion: 1, id: spec.id, files }));
  write(source, INVENTORY, inventory);
  if (damage === 'file') write(source, 'Lib/site-packages/torch/__init__.py', Buffer.from('damaged-torch'));
  if (damage === 'extra') write(source, 'unlisted.py', Buffer.from('unexpected-code'));
  const descriptions = {};
  for (const group of ['core', 'shared']) {
    const names = files.filter(f => f.shared === (group === 'shared')).map(f => f.path);
    if (group === 'core') {
      names.push(INVENTORY);
      if (damage === 'extra') names.push('unlisted.py');
    }
    const list = path.join(root, group + '.txt');
    fs.writeFileSync(list, names.join('\n') + '\n');
    const asset = group + '.7z';
    await runSevenZip(extractor, ['a', '-t7z', '-mx=1', path.join(root, asset), '@' + list], { cwd: source });
    const bytes = fs.readFileSync(path.join(root, asset));
    // Split the tiny core to exercise assembly without a huge test download.
    const chunks = group === 'core' ? [bytes.subarray(0, 79), bytes.subarray(79)] : [bytes];
    const parts = chunks.map((chunk, i) => {
      const name = chunks.length === 1 ? asset : asset + '.part0' + (i + 1);
      blobs.set(name, chunk);
      return { asset: name, size: chunk.length, sha256: digest(chunk) };
    });
    descriptions[group] = { asset, size: bytes.length, sha256: digest(bytes), format: '7z', parts };
  }
  const legacy = blobs.get(spec.asset);
  const manifest = { schemaVersion: 1, pack: { id: spec.id, kind, asset: spec.asset,
    size: legacy.length, sha256: digest(legacy),
    optimized: { schemaVersion: 1, id: spec.id,
      inventorySha256: damage === 'inventory' ? '0'.repeat(64) : digest(inventory), ...descriptions } } };
  const requests = [];
  const fetchImpl = async url => {
    const href = String(url);
    if (href.includes('api.github.com')) {
      const assets = [...blobs, [spec.manifest, Buffer.from(JSON.stringify(manifest))]].map(([name, bytes]) => ({
        name, size: bytes.length, browser_download_url: 'https://fixture.invalid/' + name,
        url: 'https://fixture.invalid/' + name, digest: 'sha256:' + digest(bytes),
      }));
      return new Response(JSON.stringify({ assets }), { status: 200 });
    }
    const name = new URL(href).pathname.slice(1);
    requests.push(name);
    const bytes = name === spec.manifest ? Buffer.from(JSON.stringify(manifest)) : blobs.get(name);
    return new Response(bytes || 'missing', { status: bytes ? 200 : 404 });
  };
  const manager = new QwenAccelPackManager({ kind, root: path.join(root, 'gpu'), extractorPath: extractor,
    baseRuntimeRoot: base, fetchImpl, validateRuntime: async python => {
      for (const [name, bytes] of Object.entries(contents)) {
        assert.deepStrictEqual(fs.readFileSync(path.join(path.dirname(python), name)), bytes);
      }
      return passed();
    } });
  return { root, base, source, spec, manifest, blobs, requests, files, manager, contents,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

async function test(name, work, kind = 'cuda', damage = '') {
  const f = await fixture(kind, damage);
  try { await work(f); count++; console.log('ok ' + name); }
  finally { f.cleanup(); }
}

async function main() {
  assert.strictEqual(downloadSizeLabel(1881694951, 2101411351), '1.88–2.10 GB');
  assert.strictEqual(downloadSizeLabel(2101411351), '2.10 GB');
  assert.strictEqual(downloadSizeLabel(3094557586), '3.09 GB');
  assert.strictEqual(downloadSizeLabel(219716400), '219.72 MB');
  await test('size lookup uses the complete release without downloading or installing runtime files', async f => {
    assert.strictEqual(f.manager.snapshot().downloadSize, '', 'no stale catalog estimate before the release is checked');
    let updates = 0;
    f.manager.onDownloadInfo = () => { updates++; };
    const first = f.manager.refreshDownloadInfo();
    assert.strictEqual(f.manager.snapshot().downloadSizeStatus, 'checking');
    assert.strictEqual(f.manager.refreshDownloadInfo(), first, 'concurrent renders share one lookup');
    const info = await first;
    const { core, shared } = f.manifest.pack.optimized;
    assert.strictEqual(info.downloadFormat, '7z');
    assert.strictEqual(info.downloadMinBytes, core.size);
    assert.strictEqual(info.downloadBytes, core.size + shared.size);
    assert.strictEqual(info.downloadSize, downloadSizeLabel(core.size, core.size + shared.size));
    assert.strictEqual(info.downloadSizeStatus, 'ready');
    await f.manager.refreshDownloadInfo();
    assert.strictEqual(updates, 1);
    assert.deepStrictEqual(f.requests, [f.spec.manifest], 'only small metadata is fetched, once during the cache period');
    assert(!fs.existsSync(f.manager.root), 'viewing the label never starts installation');
    fs.rmSync(f.base, { recursive: true });
    const absent = f.manager.snapshot();
    assert.strictEqual(absent.downloadMinBytes, core.size + shared.size);
    assert.strictEqual(absent.downloadSize, downloadSizeLabel(core.size + shared.size));
  });
  await test('offline lookup hides stale sizes and a later lookup recovers', async f => {
    const fetchImpl = f.manager.downloader.fetch;
    f.manager.downloader.fetch = async () => { throw new Error('offline'); };
    const offline = await f.manager.refreshDownloadInfo();
    assert.strictEqual(offline.downloadSizeStatus, 'unavailable');
    assert.strictEqual(offline.downloadSize, '');
    assert.strictEqual(offline.downloadBytes, null);
    f.manager.downloader.fetch = fetchImpl;
    f.manager.downloadInfoRefreshAt = 0;
    assert.strictEqual((await f.manager.refreshDownloadInfo()).downloadSizeStatus, 'ready');
    f.manager.downloader.fetch = async () => { throw new Error('offline again'); };
    f.manager.downloadInfoRefreshAt = 0;
    assert.strictEqual((await f.manager.refreshDownloadInfo()).downloadSize, '', 'expired metadata cannot remain advertised after lookup fails');
  });
  for (const mode of ['partial-upload', 'no-extractor', 'old-release']) {
    await test(mode + ': label reports the available legacy ZIP size', async f => {
      if (mode === 'partial-upload') f.blobs.delete('shared.7z');
      if (mode === 'no-extractor') f.manager.extractorPath = '';
      if (mode === 'old-release') delete f.manifest.pack.optimized;
      const info = await f.manager.refreshDownloadInfo();
      assert.strictEqual(info.downloadFormat, 'zip');
      assert.strictEqual(info.downloadMinBytes, f.manifest.pack.size);
      assert.strictEqual(info.downloadBytes, f.manifest.pack.size);
      assert.strictEqual(info.downloadSize, downloadSizeLabel(f.manifest.pack.size));
      assert.deepStrictEqual(f.requests, [f.spec.manifest]);
    });
  }
  for (const kind of ['cuda', 'rocm']) {
    await test(kind + ': reuse exact files, preserve every dependency, independent CPU/GPU copies', async f => {
      await f.manager.install();
      assert(f.manager.snapshot().verified);
      assert(!f.requests.includes('shared.7z'));
      assert(!f.requests.includes(f.spec.asset));
      assert(f.requests.includes('core.7z.part01') && f.requests.includes('core.7z.part02'));
      fs.writeFileSync(path.join(f.base, 'python.exe'), 'CPU runtime updated');
      assert.strictEqual(fs.readFileSync(f.manager.pythonPath(), 'utf8'), 'embedded-python');
      fs.rmSync(f.base, { recursive: true });
      assert(f.manager.healthy(), 'removing CPU files leaves GPU support independent');
    }, kind);
  }
  for (const mode of ['missing', 'corrupt']) {
    await test(mode + ' CPU files trigger a complete fallback download', async f => {
      if (mode === 'missing') fs.rmSync(f.base, { recursive: true });
      else fs.writeFileSync(path.join(f.base, 'python.exe'), 'corrupt-python!');
      await f.manager.install();
      assert(f.requests.includes('shared.7z'));
      assert(f.manager.snapshot().verified);
    });
  }
  for (const mode of ['old-client', 'partial-upload', 'old-release']) {
    await test(mode + ' keeps the legacy ZIP installation working', async f => {
      if (mode === 'old-client') f.manager.extractorPath = '';
      if (mode === 'partial-upload') f.blobs.delete('shared.7z');
      if (mode === 'old-release') delete f.manifest.pack.optimized;
      await f.manager.install();
      assert(f.requests.includes(f.spec.asset));
      assert(!f.requests.some(name => name.startsWith('core.7z')));
      assert(f.manager.snapshot().verified);
    });
  }
  for (const damage of ['file', 'extra', 'inventory']) {
    await test('reject ' + damage + ' damage before executing Python', async f => {
      let probes = 0;
      f.manager.validateRuntime = async () => { probes++; return passed(); };
      await assert.rejects(f.manager.install(), error => ['CHECKSUM_MISMATCH', 'PACK_INCOMPLETE'].includes(error.code));
      assert.strictEqual(probes, 0);
      assert.strictEqual(f.manager.installed(), null);
    }, 'cuda', damage);
  }
  await test('speech failure cannot be presented as verified or replace a working pack', async f => {
    await f.manager.install();
    const receipt = fs.readFileSync(f.manager.receiptPath(), 'utf8');
    f.manager.validateRuntime = async () => ({ ...passed(), qwenProbeOk: false, qwen_error: 'decoder failed' });
    await assert.rejects(f.manager.install({ force: true }), /decoder failed/);
    assert.strictEqual(fs.readFileSync(f.manager.receiptPath(), 'utf8'), receipt);
    assert(f.manager.healthy());
    assert.strictEqual(fs.readFileSync(f.manager.pythonPath(), 'utf8'), 'embedded-python');
  });
  await test('receipt failure rolls back runtime and receipt together', async f => {
    await f.manager.install();
    const receipt = fs.readFileSync(f.manager.receiptPath(), 'utf8');
    f.manager.writeReceipt = async () => { throw new Error('simulated disk failure'); };
    await assert.rejects(f.manager.install({ force: true }));
    assert.strictEqual(fs.readFileSync(f.manager.receiptPath(), 'utf8'), receipt);
    assert(f.manager.healthy());
  });
  await test('model downloaded later: pending speech check upgrades without another pack download', async f => {
    f.manager.validateRuntime = async () => ({ ...passed(), qwenProbeOk: false, qwenProbePending: true });
    await f.manager.install();
    assert(!f.manager.snapshot().verified);
    assert(f.manager.snapshot().qwenProbePending);
    f.requests.length = 0;
    f.manager.validateRuntime = async () => passed();
    f.manager.downloader.fetch = async () => { throw new Error('PC is offline'); };
    assert((await f.manager.install()).reused);
    assert(f.manager.snapshot().verified);
    assert.deepStrictEqual(f.requests, [], 'revalidation must work offline');
  });
  await test('cancellation never activates a partial pack, retry reuses downloaded chunks', async f => {
    f.manager.onProgress = state => { if (state.progress === 92) f.manager.cancel(); };
    await assert.rejects(f.manager.install(), error => error.code === 'CANCELLED');
    assert.strictEqual(f.manager.installed(), null);
    f.requests.length = 0;
    f.manager.onProgress = () => {};
    await f.manager.install();
    assert(f.manager.snapshot().verified);
    assert.deepStrictEqual(f.requests, [f.spec.manifest]);
  });
  await test('missing PyTorch repairs automatically on retry', async f => {
    await f.manager.install();
    fs.rmSync(path.join(f.manager.packDir(), 'Lib/site-packages/torch/__init__.py'));
    const result = await f.manager.install();
    assert(!result.reused);
    assert(f.manager.snapshot().verified);
  });
  await test('reject overlapping download file names', async f => {
    f.manifest.pack.optimized.shared.asset = 'core.7z.part01';
    await assert.rejects(f.manager.install(), error => error.code === 'INVALID_MANIFEST');
  });

  for (const name of ['../escape', 'C:/escape', '/escape', 'folder/file:stream', 'folder/file.', 'NUL.txt']) {
    assert.throws(() => archivePath(os.tmpdir(), name), undefined, name);
  }
  assert.throws(() => validateListing('Path = a\n\nPath = A', os.tmpdir()), /duplicate/);
  assert.throws(() => validateListing('Path = a\nSymbolic Link = target', os.tmpdir()), /links/);
  assert.throws(() => validateInventory({ schemaVersion: 1, id: 'x', files: [
    { path: '../bad', size: 1, sha256: 'a'.repeat(64), shared: true },
  ] }, os.tmpdir(), 'x'));
  assert.throws(() => validateQwenProbe({ importOk: true, tensorProbeOk: true }), /transcription check/);
  assert.throws(() => validateQwenProbe({ ...passed(), importOk: false }), /PyTorch/);
  console.log('ok unsafe archive paths, links and false readiness are rejected');

  const h = harness();
  try {
    let started;
    const entered = new Promise(resolve => { started = resolve; });
    let finish;
    let removed = 0;
    let cancelled = 0;
    const live = new h.Process();
    h.context.compactLive = live;
    h.context.compactManager = { kind: 'cuda', label: 'CUDA', snapshot: () => ({ installed: false }),
      installed: () => null, healthy: () => null,
      install: () => { assert(live.killed); started(); return new Promise(resolve => { finish = resolve; }); },
      remove: async () => { removed++; }, cancel: () => { cancelled++; } };
    h.run('qwenCudaPackManager = compactManager; sidecar = compactLive;');
    const first = h.handlers.get('qwen-accel-install')(null, 'cuda');
    await entered;
    assert.strictEqual(h.handlers.get('qwen-accel-install')(null, 'cuda'), first);
    assert.strictEqual(h.handlers.get('qwen-accel-remove')(null, 'cuda'), first);
    assert.strictEqual(h.handlers.get('asr-runtime-remove')(), first);
    assert.strictEqual(removed, 0, 'no removal races the install');
    h.handlers.get('asr-runtime-cancel')();
    assert.strictEqual(cancelled, 1);
    finish();
    await first;
    assert.strictEqual(h.run('asrOperation'), null);
    assert.strictEqual(h.run('removingAsrRuntime'), false);
    await h.handlers.get('qwen-accel-remove')(null, 'cuda');
    assert.strictEqual(removed, 1);
    console.log('ok GPU install, removal and CPU setup share one lock and stop the sidecar first');
  } finally { h.close(); }
  console.log('All ' + count + ' compact pack scenarios and lifecycle checks passed.');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
