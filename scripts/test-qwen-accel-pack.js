'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { QwenAccelPackManager, MARKER_NAME } = require('../src/qwen-accel-pack');
const { createDownloadProgressGate } = require('../src/release-download');

let failed = 0;
async function ok(name, fn) {
  try {
    await fn();
    console.log('ok ' + name);
  } catch (err) {
    failed += 1;
    console.error('FAIL ' + name + '\n  ' + (err && err.stack ? err.stack : err));
  }
}

function digest(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

const progressGate = createDownloadProgressGate();
let progressBroadcasts = 0;
for (let chunk = 0; chunk < 10000; chunk += 1) {
  if (progressGate({ status: 'downloading', progress: chunk / 100 })) progressBroadcasts += 1;
}
assert.strictEqual(progressBroadcasts, 100,
  'ten thousand network chunks should produce only one UI update per percentage point');
assert.strictEqual(progressGate({ status: 'installing', progress: 89 }), true,
  'status transitions must be reported immediately');
assert.strictEqual(progressGate({ status: 'downloading', progress: 0 }), true,
  'a later download must start with a fresh progress gate');
console.log('ok chunk progress is bounded to integer percentage updates');

function zipFiles(files) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const file of files) {
    const nameBuf = Buffer.from(file.name, 'utf8');
    const raw = Buffer.from(file.body);
    const deflated = zlib.deflateRawSync(raw);
    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    nameBuf.copy(local, 30);
    locals.push(local, deflated);
    const dir = Buffer.alloc(46 + nameBuf.length);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(8, 10);
    dir.writeUInt32LE(deflated.length, 20);
    dir.writeUInt32LE(raw.length, 24);
    dir.writeUInt16LE(nameBuf.length, 28);
    dir.writeUInt32LE(offset, 42);
    nameBuf.copy(dir, 46);
    central.push(dir);
    offset += local.length + deflated.length;
  }
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, eocd]);
}

function packZip(kind) {
  const id = kind === 'rocm' ? 'qwen-rocm-win-x64-v1' : 'qwen-cuda-win-x64-v1';
  const marker = JSON.stringify({ kind, id, torch: 'test', python: '3.12.10' });
  return zipFiles([
    { name: 'python.exe', body: 'fake-python' },
    { name: MARKER_NAME, body: marker },
    { name: 'Lib/site-packages/torch/__init__.py', body: 'print("torch")' },
  ]);
}

function makeFetch(kind, zipBytes, options) {
  const opts = options || {};
  const specAsset = kind === 'rocm'
    ? 'voxden-qwen-rocm-pack-win-x64.zip'
    : 'voxden-qwen-cuda-pack-win-x64.zip';
  const specManifest = kind === 'rocm'
    ? 'voxden-qwen-rocm-pack.json'
    : 'voxden-qwen-cuda-pack.json';
  const id = kind === 'rocm' ? 'qwen-rocm-win-x64-v1' : 'qwen-cuda-win-x64-v1';
  const sha = opts.sha256 || digest(zipBytes);
  const manifest = Buffer.from(JSON.stringify({
    schemaVersion: 1,
    pack: {
      id,
      kind,
      asset: specAsset,
      sha256: sha,
      size: zipBytes.length,
    },
  }));
  const release = {
    assets: [
      {
        name: specManifest,
        browser_download_url: 'https://x/' + specManifest,
        url: 'https://x/' + specManifest,
        size: manifest.length,
      },
      {
        name: specAsset,
        browser_download_url: 'https://x/' + specAsset,
        url: 'https://x/' + specAsset,
        size: zipBytes.length,
        digest: 'sha256:' + sha,
      },
    ],
  };
  return async (url) => {
    const href = String(url);
    if (href.includes('api.github.com')) {
      return new Response(JSON.stringify(release), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (href.endsWith('.json')) return new Response(manifest, { status: 200 });
    if (href.endsWith('.zip')) {
      if (opts.corruptBytes) return new Response(opts.corruptBytes, { status: 200 });
      if (opts.abortAfter) {
        return new Response(zipBytes.subarray(0, opts.abortAfter), { status: 200 });
      }
      return new Response(zipBytes, { status: 200 });
    }
    return new Response('missing', { status: 404 });
  };
}

async function testKind(kind) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voxden-qwen-' + kind + '-'));
  const zipBytes = packZip(kind);
  try {
    const manager = new QwenAccelPackManager({
      kind,
      root,
      releaseApiUrl: 'https://api.github.com/repos/x/y/releases/tags/qwen-' + kind + '-pack-v1',
      fetchImpl: makeFetch(kind, zipBytes),
      validateRuntime: async () => ({ importOk: true, tensorProbeOk: true, qwenProbeOk: false, qwenProbePending: true }),
    });
    assert.strictEqual(manager.installed(), null, 'nothing is installed yet');
    const result = await manager.install();
    assert.ok(result.installed, kind + ' reports installed');
    assert.ok(fs.existsSync(manager.pythonPath()), kind + ' python.exe landed');
    assert.ok(manager.healthy(), kind + ' is healthy after a passing probe');
    assert.strictEqual(manager.snapshot().installed, true);
    assert.strictEqual(manager.snapshot().verified, false, 'pending speech check is not verified');
    assert.strictEqual(manager.snapshot().qwenProbePending, true);

    const cpuMarker = path.join(root, 'runtime', MARKER_NAME);
    assert.ok(fs.existsSync(cpuMarker), 'marker is in the isolated runtime, not the CPU tree');

    await manager.remove();
    assert.strictEqual(manager.installed(), null, kind + ' remove clears the receipt');
    assert.ok(!fs.existsSync(manager.packDir()), kind + ' runtime directory is gone');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

(async () => {
  await ok('7. valid CUDA pack installs atomically', () => testKind('cuda'));
  await ok('8. valid ROCm pack installs atomically', () => testKind('rocm'));

  await ok('7c. split CUDA pack parts assemble and verify', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voxden-qwen-split-'));
    const zipBytes = packZip('cuda');
    const mid = Math.max(1, Math.floor(zipBytes.length / 2));
    const part1 = Buffer.from(zipBytes.subarray(0, mid));
    const part2 = Buffer.from(zipBytes.subarray(mid));
    const sha = digest(zipBytes);
    const specAsset = 'voxden-qwen-cuda-pack-win-x64.zip';
    const specManifest = 'voxden-qwen-cuda-pack.json';
    const parts = [
      { asset: specAsset + '.part01', size: part1.length, sha256: digest(part1) },
      { asset: specAsset + '.part02', size: part2.length, sha256: digest(part2) },
    ];
    const manifest = Buffer.from(JSON.stringify({
      schemaVersion: 1,
      pack: {
        id: 'qwen-cuda-win-x64-v1',
        kind: 'cuda',
        asset: specAsset,
        sha256: sha,
        size: zipBytes.length,
        parts,
      },
    }));
    const bodies = {
      [specManifest]: manifest,
      [parts[0].asset]: part1,
      [parts[1].asset]: part2,
    };
    try {
      const manager = new QwenAccelPackManager({
        kind: 'cuda',
        root,
        releaseApiUrl: 'https://api.github.com/repos/x/y/releases/tags/qwen-cuda-pack-v1',
        fetchImpl: async (url) => {
          const href = String(url);
          if (href.includes('api.github.com')) {
            return new Response(JSON.stringify({
              assets: [
                { name: specManifest, browser_download_url: 'https://x/' + specManifest, url: 'https://x/' + specManifest, size: manifest.length },
                { name: parts[0].asset, browser_download_url: 'https://x/' + parts[0].asset, url: 'https://x/' + parts[0].asset, size: parts[0].size, digest: 'sha256:' + parts[0].sha256 },
                { name: parts[1].asset, browser_download_url: 'https://x/' + parts[1].asset, url: 'https://x/' + parts[1].asset, size: parts[1].size, digest: 'sha256:' + parts[1].sha256 },
              ],
            }), { status: 200, headers: { 'Content-Type': 'application/json' } });
          }
          const name = href.split('/').pop();
          if (bodies[name]) return new Response(bodies[name], { status: 200 });
          return new Response('missing', { status: 404 });
        },
        validateRuntime: async () => ({ importOk: true, tensorProbeOk: true, qwenProbeOk: true }),
      });
      await manager.install();
      assert.ok(manager.healthy(), 'assembled split pack is healthy');
      assert.ok(fs.existsSync(manager.pythonPath()), 'python.exe landed from assembled zip');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await ok('9. missing pack is not installed', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voxden-qwen-missing-'));
    try {
      const manager = new QwenAccelPackManager({ kind: 'cuda', root });
      assert.strictEqual(manager.installed(), null);
      assert.strictEqual(manager.healthy(), null);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await ok('10. invalid receipt is not an install', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voxden-qwen-receipt-'));
    try {
      const manager = new QwenAccelPackManager({ kind: 'cuda', root });
      fs.writeFileSync(path.join(root, 'current-qwen-cuda-pack.json'), JSON.stringify({
        schemaVersion: 1,
        kind: 'cuda',
        id: 'qwen-cuda-win-x64-v1',
        proof: { path: 'runtime/' + MARKER_NAME, size: 10, verifiedMtimeMs: 1 },
      }));
      assert.strictEqual(manager.installed(), null);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await ok('11b. invalid manifest JSON is rejected', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voxden-qwen-manifest-'));
    const zipBytes = packZip('cuda');
    try {
      const sha = digest(zipBytes);
      const manager = new QwenAccelPackManager({
        kind: 'cuda',
        root,
        releaseApiUrl: 'https://api.github.com/repos/x/y/releases/tags/qwen-cuda-pack-v1',
        fetchImpl: async (url) => {
          const href = String(url);
          if (href.includes('api.github.com')) {
            return new Response(JSON.stringify({
              assets: [
                { name: 'voxden-qwen-cuda-pack.json', browser_download_url: 'https://x/voxden-qwen-cuda-pack.json', url: 'https://x/voxden-qwen-cuda-pack.json', size: 12 },
                { name: 'voxden-qwen-cuda-pack-win-x64.zip', browser_download_url: 'https://x/voxden-qwen-cuda-pack-win-x64.zip', url: 'https://x/voxden-qwen-cuda-pack-win-x64.zip', size: zipBytes.length, digest: 'sha256:' + sha },
              ],
            }), { status: 200, headers: { 'Content-Type': 'application/json' } });
          }
          if (href.endsWith('.json')) return new Response('not-json{', { status: 200 });
          if (href.endsWith('.zip')) return new Response(zipBytes, { status: 200 });
          return new Response('missing', { status: 404 });
        },
      });
      await manager.install().then(
        () => { throw new Error('invalid manifest should fail'); },
        () => assert.strictEqual(manager.installed(), null)
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await ok('11. invalid checksum is rejected', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voxden-qwen-sum-'));
    const zipBytes = packZip('cuda');
    try {
      const manager = new QwenAccelPackManager({
        kind: 'cuda',
        root,
        releaseApiUrl: 'https://api.github.com/repos/x/y/releases/tags/qwen-cuda-pack-v1',
        fetchImpl: makeFetch('cuda', zipBytes, {
          sha256: 'a'.repeat(64),
          corruptBytes: Buffer.concat([zipBytes, Buffer.from('nope')]),
        }),
      });
      await manager.install().then(
        () => { throw new Error('checksum mismatch should fail'); },
        (err) => {
          assert.ok(err, 'install failed');
          assert.strictEqual(manager.installed(), null, 'failed checksum left no receipt');
        }
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await ok('13. atomic rollback leaves CPU paths untouched', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voxden-qwen-rollback-'));
    const sentinel = path.join(os.tmpdir(), 'voxden-cpu-sentinel-' + process.pid);
    try {
      fs.writeFileSync(sentinel, 'cpu-runtime-intact');
      const manager = new QwenAccelPackManager({
        kind: 'cuda',
        root,
        releaseApiUrl: 'https://api.github.com/repos/x/y/releases/tags/qwen-cuda-pack-v1',
        fetchImpl: makeFetch('cuda', packZip('cuda')),
        validateRuntime: async () => {
          throw new Error('simulated GPU probe failure');
        },
      });
      await manager.install().then(
        () => { throw new Error('probe failure should fail install'); },
        () => {}
      );
      assert.strictEqual(manager.installed(), null);
      assert.ok(!fs.existsSync(manager.packDir()) || !manager.filesPresent(manager.packDir()));
      assert.ok(fs.existsSync(sentinel), '15. CPU runtime sentinel still exists');
    } finally {
      fs.rmSync(sentinel, { force: true });
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await ok('14. pack removal deletes runtime and receipt', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voxden-qwen-rm-'));
    try {
      const manager = new QwenAccelPackManager({
        kind: 'cuda',
        root,
        releaseApiUrl: 'https://api.github.com/repos/x/y/releases/tags/qwen-cuda-pack-v1',
        fetchImpl: makeFetch('cuda', packZip('cuda')),
        validateRuntime: async () => ({ importOk: true, tensorProbeOk: true, qwenProbeOk: true }),
      });
      await manager.install();
      await manager.remove();
      assert.strictEqual(manager.snapshot().installed, false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await ok('12. interrupted leftover pending is not a receipt', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voxden-qwen-int-'));
    try {
      fs.mkdirSync(path.join(root, 'runtime.pending'), { recursive: true });
      fs.writeFileSync(path.join(root, 'runtime.pending', 'python.exe'), 'partial');
      const manager = new QwenAccelPackManager({ kind: 'cuda', root });
      assert.strictEqual(manager.installed(), null, 'pending extract is not installed');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  if (failed) process.exit(1);
  console.log('all qwen accelerator pack tests passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
