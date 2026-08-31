'use strict';

// Build the self-contained Windows speech runtime included in the installer.
// Dependency resolution happens here, never on an end user's PC. The builder's
// Python must match the embedded interpreter (3.12 by default).

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { extractZip } = require('../src/zip');

const DEFAULT_PYTHON_VERSION = '3.12.10';
const ASSET_NAME = 'voxden-asr-runtime-win-x64.zip';
const MANIFEST_NAME = 'voxden-asr-runtime.json';
// Bumped when the contents change in a way an existing install has to pick up.
// v3 adds Qwen and CPU PyTorch; v2 added DirectML.
const RUNTIME_ID = 'asr-win-x64-v3';

// Shipped app-local under the Visual C++ redistributable terms. The embeddable
// distribution carries VCRUNTIME140 but not the C++ standard library, and
// ctranslate2 and onnxruntime both import it.
const VC_RUNTIME_DLLS = ['MSVCP140.dll', 'MSVCP140_1.dll'];

// Dead weight in a runtime that only ever runs transcribe.py.
const PRUNE_DIRS = new Set([
  '__pycache__',
  'pip',
  'wheel',
  // main.js sets HF_HUB_DISABLE_XET=1, so the Xet transfer backend never loads.
  'hf_xet',
]);

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

function dirSize(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) total += dirSize(p);
    else if (entry.isFile()) total += fs.statSync(p).size;
  }
  return total;
}

function countFiles(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) total += countFiles(path.join(dir, entry.name));
    else total += 1;
  }
  return total;
}

async function download(url, destination) {
  const response = await fetch(url);
  if (!response.ok) throw new Error('Download failed (' + response.status + '): ' + url);
  const buffer = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(destination, buffer);
  return buffer.length;
}

function prune(dir) {
  let removed = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (PRUNE_DIRS.has(entry.name)) {
        removed += dirSize(p);
        fs.rmSync(p, { recursive: true, force: true });
        continue;
      }
      removed += prune(p);
    } else if (entry.name.endsWith('.pyc')) {
      removed += fs.statSync(p).size;
      fs.rmSync(p, { force: true });
    }
  }
  return removed;
}

// onnxruntime and onnxruntime-directml are the same import under two
// distribution names, so pip cannot see one as satisfying the other. It
// installs the CPU build as a faster-whisper dependency and would then lay the
// DirectML wheel over the top of it, leaving whichever files the two do not
// share behind. Clearing the installed copy first is what makes the second
// install land whole.
//
// This is the entire AMD story. CTranslate2 has one GPU backend and it is
// CUDA, and PyTorch has no ROCm wheel for Windows, so Whisper and Qwen3-ASR on
// a Radeon are the CPU and nothing else. Parakeet through DirectML is the only
// GPU dictation those machines can have -- and the same provider covers Intel
// integrated and Arc, because DirectX 12 is what it targets. Nobody with a
// CPU-only PC pays for it either: the DirectML wheel still carries the CPU
// provider.
function swapInDirectmlRuntime(sitePackages) {
  const stale = fs.readdirSync(sitePackages).filter(
    (name) => name === 'onnxruntime'
      || (name.startsWith('onnxruntime-') && name.endsWith('.dist-info'))
  );
  for (const name of stale) {
    fs.rmSync(path.join(sitePackages, name), { recursive: true, force: true });
  }
  // --no-deps: numpy, protobuf and the rest arrived with the CPU build and are
  // still here. Only the import itself is being replaced.
  execFileSync(process.env.VOXDEN_BUILD_PYTHON || 'python', [
    '-m', 'pip', 'install',
    '--quiet',
    '--no-warn-conflicts',
    '--only-binary', ':all:',
    '--no-deps',
    '--target', sitePackages,
    'onnxruntime-directml',
  ], { stdio: 'inherit' });
  return stale;
}

function copyVcRuntime(destination) {
  const source = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
  const copied = [];
  for (const name of VC_RUNTIME_DLLS) {
    const from = path.join(source, name);
    if (!fs.existsSync(from)) {
      throw new Error(
        name + ' was not found in System32. Install the Visual C++ 2015-2022 '
        + 'redistributable on this machine, or the runtime will not load on a clean PC.'
      );
    }
    fs.copyFileSync(from, path.join(destination, name));
    copied.push(name);
  }
  return copied;
}

function makeZip(sourceDir, zipPath) {
  const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  if (!fs.existsSync(tar)) {
    throw new Error('tar.exe was not found. Windows 10 1803 or newer is required to build the archive.');
  }
  fs.rmSync(zipPath, { force: true });
  // bsdtar picks the zip format from the extension with -a.
  execFileSync(tar, ['-a', '-c', '-f', zipPath, '-C', sourceDir, '.'], { stdio: 'inherit' });
}

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

async function main() {
  if (process.platform !== 'win32') {
    throw new Error('The runtime targets Windows and must be built on Windows.');
  }
  const pythonVersion = arg('python-version', DEFAULT_PYTHON_VERSION);
  const outDir = path.resolve(arg('out', 'dist-runtime'));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'voxden-runtime-'));
  const stage = path.join(work, 'runtime');

  try {
    fs.mkdirSync(stage, { recursive: true });
    fs.mkdirSync(outDir, { recursive: true });

    const embedUrl = 'https://www.python.org/ftp/python/' + pythonVersion
      + '/python-' + pythonVersion + '-embed-amd64.zip';
    const embedZip = path.join(work, 'embed.zip');
    log('Downloading Python ' + pythonVersion + ' (embeddable)…');
    log('  ' + bytes(await download(embedUrl, embedZip)));
    await extractZip(embedZip, stage);

    // The embeddable distribution keeps sys.path in a ._pth file and ships with
    // site disabled, so neither site-packages nor pip's layout is visible until
    // both are turned on here.
    const pthName = 'python' + pythonVersion.split('.').slice(0, 2).join('') + '._pth';
    const pth = path.join(stage, pthName);
    if (!fs.existsSync(pth)) {
      throw new Error('Expected ' + pthName + ' in the embeddable distribution.');
    }
    fs.writeFileSync(pth, [
      path.basename(pth).replace('._pth', '.zip'),
      '.',
      'Lib\\site-packages',
      '',
      'import site',
      '',
    ].join('\n'));

    const sitePackages = path.join(stage, 'Lib', 'site-packages');
    fs.mkdirSync(sitePackages, { recursive: true });

    // onnx-asr is what makes Parakeet -- the Fast-dictation engine -- work.
    // It costs about 16 MB because onnxruntime is already here as one of
    // faster-whisper's own dependencies, so leaving it out meant shipping a
    // runtime that could never run an engine the picker offers.
    log('Installing Whisper, Parakeet, and Qwen with self-contained CPU PyTorch…');
    execFileSync(process.env.VOXDEN_BUILD_PYTHON || 'python', [
      '-m', 'pip', 'install',
      '--quiet',
      '--no-warn-conflicts',
      '--prefer-binary',
      '--extra-index-url', 'https://download.pytorch.org/whl/cpu',
      '--target', sitePackages,
      'torch==2.11.0+cpu',
      'qwen-asr==0.0.6',
      'faster-whisper==1.2.1',
      'onnx-asr[hub]==0.12.0',
    ], { stdio: 'inherit' });

    log('Swapping ONNX Runtime for the DirectML build…');
    log('  replaced ' + swapInDirectmlRuntime(sitePackages).join(', '));

    log('Adding the Visual C++ runtime…');
    log('  ' + copyVcRuntime(stage).join(', '));

    const before = dirSize(stage);
    const removed = prune(stage);
    log('Pruned ' + bytes(removed) + ' (' + bytes(before) + ' -> ' + bytes(dirSize(stage)) + ')');

    // A runtime that cannot run the sidecar is not worth shipping.
    log('Verifying the runtime can run the sidecar…');
    const sidecar = path.join(__dirname, '..', 'sidecar', 'transcribe.py');
    const check = execFileSync(path.join(stage, 'python.exe'), [sidecar, '--check'], {
      encoding: 'utf8',
      env: Object.assign({}, process.env, { VOXDEN_ASR_ENGINE: 'whisper' }),
    });
    const parsed = JSON.parse(check.trim().split('\n').pop());
    if (!parsed.ok) throw new Error('The built runtime failed its own check: ' + parsed.error);
    log('  whisper : ' + check.trim());
    // Parakeet is offered in the picker, so a runtime that cannot probe it
    // clean is a runtime that ships a broken menu entry.
    const parakeet = execFileSync(path.join(stage, 'python.exe'), [sidecar, '--check'], {
      encoding: 'utf8',
      env: Object.assign({}, process.env, { VOXDEN_ASR_ENGINE: 'parakeet' }),
    });
    const parsedParakeet = JSON.parse(parakeet.trim().split('\n').pop());
    if (!parsedParakeet.ok || parsedParakeet.warning) {
      throw new Error('The built runtime cannot run Parakeet: '
        + (parsedParakeet.error || parsedParakeet.warning));
    }
    log('  parakeet: ' + parakeet.trim());
    // find_spec alone cannot catch DLL failures or transitive import errors.
    // Import the actual public APIs with no developer site-packages on sys.path.
    execFileSync(path.join(stage, 'python.exe'), ['-I', '-c',
      'import torch, faster_whisper, onnx_asr; from qwen_asr import Qwen3ASRModel; '
      + 'print("All three speech backends import successfully", torch.__version__)'],
    { stdio: 'inherit', env: { ...process.env, PYTHONNOUSERSITE: '1' } });
    // A runtime with no DirectML in it makes the AMD GPU setting a lie: every
    // provider list quietly falls through to the CPU and the user is left
    // reading "active on the CPU" with no reason given. Cheaper to fail the
    // build than to ship that.
    const providers = execFileSync(path.join(stage, 'python.exe'), [
      '-c',
      'import json, onnxruntime; print(json.dumps(onnxruntime.get_available_providers()))',
    ], { encoding: 'utf8' }).trim();
    if (!providers.includes('DmlExecutionProvider')) {
      throw new Error('The built runtime has no DirectML provider: ' + providers);
    }
    log('  providers: ' + providers);
    execFileSync(path.join(stage, 'python.exe'), [sidecar, '--self-test'], { stdio: 'inherit' });

    const files = countFiles(stage);
    const zipPath = path.join(outDir, ASSET_NAME);
    log('Packing ' + files + ' files…');
    makeZip(stage, zipPath);

    const size = fs.statSync(zipPath).size;
    const digest = sha256(zipPath);
    const manifest = {
      schemaVersion: 1,
      runtime: {
        id: RUNTIME_ID,
        asset: ASSET_NAME,
        python: 'python.exe',
        pythonVersion,
        engine: 'faster-whisper',
        engines: ['whisper', 'qwen3-asr', 'parakeet'],
        torchDevice: 'cpu',
        installedBytes: dirSize(stage),
        files,
        size,
        sha256: digest,
      },
    };
    fs.writeFileSync(path.join(outDir, MANIFEST_NAME), JSON.stringify(manifest, null, 2) + '\n');
    if (process.argv.includes('--keep-runtime')) {
      await fs.promises.cp(stage, path.join(outDir, 'runtime'), { recursive: true });
    }

    log('');
    log('Wrote ' + zipPath);
    log('  ' + bytes(size) + '  sha256:' + digest);
    log('Wrote ' + path.join(outDir, MANIFEST_NAME));
    log('');
    log('The Windows installer bundles this zip and manifest. Run the app build next.');
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

main().catch((err) => {
  process.stderr.write((err && err.message ? err.message : err) + '\n');
  process.exit(1);
});
