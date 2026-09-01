'use strict';

const assert = require('assert');
const path = require('path');
const os = require('os');
const fs = require('fs');
const gpu = require('../src/gpu');
const { CudaPackManager, PROOF_DLL, ADVERTISED } = require('../src/cuda-pack');

const NVIDIA = { vendorId: 4318 };
const AMD = { vendorId: 4098 };
const INTEL = { vendorId: 32902 };

assert.strictEqual(gpu.vendorOf(4318), 'nvidia');
assert.strictEqual(gpu.vendorOf(4098), 'amd');
assert.strictEqual(gpu.vendorOf(32902), 'intel');
assert.strictEqual(gpu.vendorOf(5140), '');
assert.strictEqual(gpu.vendorOf(undefined), '');
console.log('ok vendor ids map to vendors');

// NVIDIA outranks the others because it is the only one that can carry
// Whisper. A laptop with an iGPU beside a GeForce should plan for the GeForce.
assert.deepStrictEqual(gpu.vendorsPresent([INTEL, NVIDIA]), ['nvidia', 'intel']);
assert.deepStrictEqual(gpu.vendorsPresent([INTEL, AMD]), ['amd', 'intel']);
assert.deepStrictEqual(gpu.vendorsPresent([]), []);
console.log('ok the strongest usable vendor is ranked first');

// NVIDIA is the only vendor with something to download, and the plan flips
// once it is on disk.
const cold = gpu.gpuPlan([NVIDIA], false);
assert.strictEqual(cold.device, 'cuda');
assert.strictEqual(cold.needsPack, true);
assert.strictEqual(cold.ready, false);
const warm = gpu.gpuPlan([NVIDIA], true);
assert.strictEqual(warm.needsPack, false);
assert.strictEqual(warm.ready, true);
console.log('ok the CUDA pack is what makes an NVIDIA plan ready');

// AMD and Intel need nothing fetched: DirectML is in the base runtime. They
// are ready immediately, and only for Parakeet.
for (const device of [AMD, INTEL]) {
  const plan = gpu.gpuPlan([device], false);
  assert.strictEqual(plan.device, 'directml');
  assert.strictEqual(plan.needsPack, false, 'DirectML ships already; nothing to download');
  assert.strictEqual(plan.ready, true);
  assert.strictEqual(plan.accelerates, 'Parakeet');
}
console.log('ok AMD and Intel are ready with no download');

// Whisper is NVIDIA-only, and the plan says so rather than implying parity.
assert.strictEqual(gpu.gpuPlan([NVIDIA], true).accelerates, 'Whisper');
assert.strictEqual(gpu.gpuPlan([AMD], false).accelerates, 'Parakeet');
console.log('ok only NVIDIA is claimed to accelerate Whisper');

// The CUDA pack is two files, cublas64_12.dll and cublasLt64_12.dll, and
// cuBLAS is what CTranslate2 wants. Nothing else in the bundled runtime can
// use it: ONNX Runtime ships as the DirectML build and reports no CUDA
// execution provider, and torch is 2.11.0+cpu with no CUDA at all. Claiming
// the download accelerates Parakeet or Qwen costs somebody 553 MB for nothing.
for (const packInstalled of [true, false]) {
  const claim = gpu.gpuPlan([NVIDIA], packInstalled).accelerates;
  assert.ok(!/Parakeet/.test(claim), 'cuBLAS cannot reach Parakeet: ' + claim);
  assert.ok(!/Qwen/.test(claim), 'cuBLAS cannot reach Qwen: ' + claim);
}
console.log('ok the CUDA pack never claims an engine it cannot accelerate');

// No usable GPU means the CPU, and the card is hidden rather than explaining
// something the user cannot act on.
const none = gpu.gpuPlan([{ vendorId: 5140 }], false);
assert.strictEqual(none.vendor, '');
assert.strictEqual(none.device, 'cpu');
assert.strictEqual(none.ready, false);
console.log('ok an unrecognised adapter plans for the CPU');

// The download path itself, against a stubbed release. Hand-staging a pack
// proved the sidecar reads it; only this proves the manager can fetch one. It
// is here because the first version of resolveAsset called a downloader method
// that does not exist -- which surfaced to the user as "check the connection",
// because the TypeError fell through to the network branch of the error
// handler. A test that never opened the download path could not have caught it.
async function testDownloadPath() {
  const crypto = require('crypto');
  const zlib = require('zlib');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voxden-cuda-dl-'));
  try {
    // A zip carrying the one file the install checks for.
    const entryName = 'nvidia/cublas/bin/cublas64_12.dll';
    const nameBuf = Buffer.from(entryName, 'utf8');
    const raw = Buffer.from('not really cuBLAS');
    const deflated = zlib.deflateRawSync(raw);
    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    nameBuf.copy(local, 30);
    const dir = Buffer.alloc(46 + nameBuf.length);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(8, 10);
    dir.writeUInt32LE(deflated.length, 20);
    dir.writeUInt32LE(raw.length, 24);
    dir.writeUInt16LE(nameBuf.length, 28);
    nameBuf.copy(dir, 46);
    const localPart = Buffer.concat([local, deflated]);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(1, 8);
    end.writeUInt16LE(1, 10);
    end.writeUInt32LE(dir.length, 12);
    end.writeUInt32LE(localPart.length, 16);
    const zipBytes = Buffer.concat([localPart, dir, end]);
    const sha = crypto.createHash('sha256').update(zipBytes).digest('hex');

    const manifest = JSON.stringify({
      schemaVersion: 1,
      pack: { id: 'cuda-win-x64-v1', asset: 'voxden-cuda-pack-win-x64.zip', sha256: sha, size: zipBytes.length },
    });
    const release = {
      assets: [
        {
          name: 'voxden-cuda-pack.json',
          browser_download_url: 'https://x/voxden-cuda-pack.json',
          url: 'https://x/voxden-cuda-pack.json',
          size: manifest.length,
        },
        {
          name: 'voxden-cuda-pack-win-x64.zip',
          browser_download_url: 'https://x/voxden-cuda-pack-win-x64.zip',
          url: 'https://x/voxden-cuda-pack-win-x64.zip',
          size: zipBytes.length,
          digest: 'sha256:' + sha,
        },
      ],
    };
    const manager = new CudaPackManager({
      root,
      releaseApiUrl: 'https://api.github.com/repos/x/y/releases/tags/cuda-pack-v1',
      fetchImpl: async (url) => {
        const href = String(url);
        if (href.includes('api.github.com')) {
          return new Response(release_json(), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        if (href.endsWith('voxden-cuda-pack.json')) return new Response(manifest, { status: 200 });
        if (href.endsWith('.zip')) return new Response(zipBytes, { status: 200 });
        return new Response('missing', { status: 404 });
      },
    });
    function release_json() { return JSON.stringify(release); }

    const result = await manager.install();
    assert.ok(result && result.installed, 'the pack reports itself installed');
    assert.ok(fs.existsSync(path.join(manager.packDir(), PROOF_DLL)), 'cuBLAS landed on disk');
    assert.strictEqual(manager.snapshot().installed, true);
    // main.js hands this to the sidecar as VOXDEN_CUDA_BIN, and the sidecar
    // scans nvidia/*/bin below it -- so the layout matters, not just the file.
    assert.ok(fs.existsSync(path.join(manager.packDir(), 'nvidia', 'cublas', 'bin')));
    console.log('ok the pack downloads, verifies and installs');

    await manager.remove();
    assert.strictEqual(manager.installed(), null, 'remove clears the receipt');
    console.log('ok remove deletes the pack and its receipt');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voxden-cuda-test-'));
try {
  const manager = new CudaPackManager({ root });
  assert.strictEqual(manager.installed(), null, 'nothing is installed yet');
  assert.strictEqual(manager.snapshot().installed, false);
  assert.strictEqual(manager.cancel(), false, 'nothing to cancel');

  // The proof file is the one CTranslate2 opens and the one the sidecar tests
  // for, so a receipt pointing at anything else must not read as installed.
  assert.ok(PROOF_DLL.endsWith('cublas64_12.dll'));
  assert.ok(ADVERTISED.downloadSize.length > 0);

  // A receipt with no file behind it is not an install. This is the case that
  // matters: a half-unpacked pack fails inside CTranslate2, far from here.
  fs.writeFileSync(path.join(root, 'current-cuda-pack.json'), JSON.stringify({
    schemaVersion: 1,
    id: 'cuda-win-x64-v1',
    proof: { path: path.join('pack', PROOF_DLL), size: 10, verifiedMtimeMs: 1 },
  }));
  assert.strictEqual(manager.installed(), null, 'a receipt without its DLL is not an install');
  console.log('ok a receipt without cuBLAS behind it is not an install');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

testDownloadPath().then(() => {
  console.log('all GPU pack tests passed');
}).catch((err) => {
  console.error('FAIL ' + (err && err.stack ? err.stack : err));
  process.exit(1);
});
