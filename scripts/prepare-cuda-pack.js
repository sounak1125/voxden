'use strict';

// Builds the optional CUDA pack: the two cuBLAS DLLs that CTranslate2 needs
// before it will run Whisper on an NVIDIA GPU.
//
//   node scripts/prepare-cuda-pack.js
//
// Nothing else is missing. cuDNN already ships inside the ctranslate2 wheel in
// the base runtime, so these two files are the entire difference between a
// GeForce that dictates a nine-second clip in 0.39s and one that takes 8.7s on
// the CPU because the library it wanted was not there.
//
// AMD and Intel have no equivalent pack and do not need one -- DirectML is in
// the base runtime already. That asymmetry is the truth about the platform,
// not an oversight.
//
// The layout matches what pip produces for nvidia-cublas-cu12, because the
// sidecar already knows how to read it: find_cuda_bin_dirs scans
// <root>/nvidia/*/bin, and VOXDEN_CUDA_BIN points it at this pack's root. That
// is why installing this needs no sidecar change at all.
//
// LICENSING: these DLLs are NVIDIA's. The CUDA EULA has a redistribution
// clause covering the runtime libraries, and you should read the current terms
// before publishing this asset. The build refuses to run without an explicit
// acknowledgement so nobody ships it by reflex.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ASSET_NAME = 'voxden-cuda-pack-win-x64.zip';
const MANIFEST_NAME = 'voxden-cuda-pack.json';
const PACK_ID = 'cuda-win-x64-v1';
const PIP_PACKAGE = 'nvidia-cublas-cu12';

// Only these. The rest of the wheel is import libraries and headers that a
// loaded DLL never asks for, and this pack is already the largest thing a user
// would download for dictation.
const WANTED_DLLS = ['cublas64_12.dll', 'cublasLt64_12.dll'];

function arg(name, fallback) {
  const index = process.argv.indexOf('--' + name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function log(message) {
  process.stdout.write(message + '\n');
}

function bytes(n) {
  return (n / 1e6).toFixed(1) + ' MB';
}

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function findDlls(root) {
  const found = new Map();
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (WANTED_DLLS.includes(entry.name) && !found.has(entry.name)) found.set(entry.name, p);
    }
  };
  walk(root);
  return found;
}

function makeZip(sourceDir, zipPath) {
  const tar = path.join(process.env.SystemRoot || 'C:\Windows', 'System32', 'tar.exe');
  if (!fs.existsSync(tar)) {
    throw new Error('tar.exe was not found. Windows 10 1803 or newer is required.');
  }
  fs.rmSync(zipPath, { force: true });
  execFileSync(tar, ['-a', '-c', '-f', zipPath, '-C', sourceDir, '.'], { stdio: 'inherit' });
}

async function main() {
  if (process.platform !== 'win32') {
    throw new Error('The pack targets Windows and must be built on Windows.');
  }
  if (process.argv.indexOf('--accept-nvidia-license') < 0) {
    throw new Error(
      'These are NVIDIA redistributables. Read the CUDA EULA redistribution terms '
      + 'for ' + PIP_PACKAGE + ', then re-run with --accept-nvidia-license.'
    );
  }
  const outDir = path.resolve(arg('out', 'dist-cuda-pack'));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'voxden-cuda-'));
  // The layout pip would have produced, which is the layout the sidecar scans.
  const stage = path.join(work, 'pack');
  const binDir = path.join(stage, 'nvidia', 'cublas', 'bin');

  try {
    fs.mkdirSync(binDir, { recursive: true });
    fs.mkdirSync(outDir, { recursive: true });

    const wheelDir = path.join(work, 'wheel');
    log('Downloading ' + PIP_PACKAGE + '…');
    execFileSync(process.env.VOXDEN_BUILD_PYTHON || 'python', [
      '-m', 'pip', 'install',
      '--quiet',
      '--only-binary', ':all:',
      '--no-deps',
      '--target', wheelDir,
      PIP_PACKAGE,
    ], { stdio: 'inherit' });

    const found = findDlls(wheelDir);
    const missing = WANTED_DLLS.filter((name) => !found.has(name));
    if (missing.length) {
      throw new Error('The wheel did not contain ' + missing.join(', ') + '.');
    }
    let total = 0;
    for (const name of WANTED_DLLS) {
      const from = found.get(name);
      const to = path.join(binDir, name);
      fs.copyFileSync(from, to);
      const size = fs.statSync(to).size;
      total += size;
      log('  ' + name + '  ' + bytes(size));
    }

    const zipPath = path.join(outDir, ASSET_NAME);
    log('Packing…');
    makeZip(stage, zipPath);

    const size = fs.statSync(zipPath).size;
    const digest = sha256(zipPath);
    fs.writeFileSync(path.join(outDir, MANIFEST_NAME), JSON.stringify({
      schemaVersion: 1,
      pack: {
        id: PACK_ID,
        asset: ASSET_NAME,
        vendor: 'nvidia',
        files: WANTED_DLLS.length,
        installedSize: total,
        size,
        sha256: digest,
      },
    }, null, 2) + '\n');

    log('');
    log('Wrote ' + zipPath);
    log('  ' + bytes(size) + ' compressed, ' + bytes(total) + ' installed');
    log('  sha256:' + digest);
    log('');
    log('Upload both to a GitHub release tagged cuda-pack-v1, marked pre-release.');
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

main().catch((err) => {
  process.stderr.write((err && err.message ? err.message : err) + '\n');
  process.exit(1);
});
