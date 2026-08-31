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
assert.strictEqual(gpu.gpuPlan([NVIDIA], true).accelerates, 'Whisper and Parakeet');
assert.notStrictEqual(gpu.gpuPlan([AMD], false).accelerates, 'Whisper and Parakeet');
console.log('ok only NVIDIA is claimed to accelerate Whisper');

// No usable GPU means the CPU, and the card is hidden rather than explaining
// something the user cannot act on.
const none = gpu.gpuPlan([{ vendorId: 5140 }], false);
assert.strictEqual(none.vendor, '');
assert.strictEqual(none.device, 'cpu');
assert.strictEqual(none.ready, false);
console.log('ok an unrecognised adapter plans for the CPU');

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

console.log('all GPU pack tests passed');
