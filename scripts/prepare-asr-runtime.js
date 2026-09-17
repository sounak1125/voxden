'use strict';

// Builds the self-contained speech runtime that ships inside Voxden: on
// Windows an embeddable CPython with the DirectML build of ONNX Runtime, on
// macOS arm64 a python-build-standalone CPython. Each platform builds on its
// own machine, and dependency resolution happens here, never on a user's PC.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { extractZip } = require('../src/zip');

const DEFAULT_PYTHON_VERSION = '3.12.10';
const MANIFEST_NAME = 'voxden-asr-runtime.json';

const WIN_ASSET_NAME = 'voxden-asr-runtime-win-x64.zip';
const MAC_ASSET_NAME = 'voxden-asr-runtime-mac-arm64.zip';
// Bumped when the contents change in a way an existing install has to pick up.
// v3 adds Qwen and CPU PyTorch; v2 added DirectML. The mac runtime starts at
// v3 so the two platforms carry the same engine set under the same number.
const WIN_RUNTIME_ID = 'asr-win-x64-v3';
const MAC_RUNTIME_ID = 'asr-mac-arm64-v3';

// python.org publishes no embeddable build for macOS, so the mac runtime comes
// from python-build-standalone: a relocatable CPython whose install_only
// tarball unpacks to a plain python/ prefix.
const MAC_PYTHON_RELEASE_API =
  'https://api.github.com/repos/astral-sh/python-build-standalone/releases/latest';
const MAC_PYTHON_ASSET = /^cpython-3\.12\.(\d+)\+\d+-aarch64-apple-darwin-install_only\.tar\.gz$/;

// macOS gets the plain PyPI wheel: there is no +cpu variant and no PyTorch
// index to point at. Overridable so a broken pin can be worked around in CI
// without editing this file -- but never silently, the value is logged.
const DEFAULT_TORCH_SPEC = '2.11.0';
const SPEECH_PACKAGES = ['qwen-asr==0.0.6', 'faster-whisper==1.2.1', 'onnx-asr[hub]==0.12.0'];

// Shipped app-local under the Visual C++ redistributable terms. The embeddable
// distribution carries VCRUNTIME140 but not the C++ standard library, and
// ctranslate2 and onnxruntime both import it.
const VC_RUNTIME_DLLS = ['MSVCP140.dll', 'MSVCP140_1.dll'];

// Dead weight in a runtime that only ever runs transcribe.py. prune() walks the
// whole tree, so this catches Lib\site-packages\pip on Windows and
// lib/python3.12/site-packages/pip on macOS without knowing either layout.
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
  // A symlink is neither isDirectory() nor isFile() here, so nothing above
  // follows one: prune cannot walk out of the tree or into a loop.
  return removed;
}

// onnxruntime and onnxruntime-directml are the same import under two
// distribution names, so pip cannot see one as satisfying the other. It
// installs the CPU build as a faster-whisper dependency and would then lay the
// DirectML wheel over the top of it, leaving whichever files the two do not
// share behind. Clearing the installed copy first is what makes the second
// install land whole.
//
  // This is the entire AMD story for the CPU runtime. CTranslate2 has one GPU
  // backend and it is CUDA. The bundled torch is CPU-only. Qwen GPU support is
  // a separate CUDA or Windows ROCm pack, never files dropped into this tree.
  // Parakeet through DirectML is still the GPU path this runtime gives AMD,
  // Intel integrated, and Arc. Nobody with a CPU-only PC pays extra for it:
  // the DirectML wheel still carries the CPU provider.
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

// Info-ZIP, without -y, so a symlink that survived flattenSymlinks is stored as
// its target's bytes rather than as a link the app's own extractor cannot make.
function makeZipPosix(sourceDir, zipPath) {
  fs.rmSync(zipPath, { force: true });
  execFileSync('zip', ['-q', '-r', '-X', zipPath, '.'], { cwd: sourceDir, stdio: 'inherit' });
}

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

// src/zip.js writes files, never links, so every symlink in the staged tree has
// to become the thing it points at before the archive is built. python3 ->
// python3.12 in bin/ is the one that matters; the rest are cheap to handle the
// same way rather than guessing which distribution ships what.
function flattenSymlinks(dir, root, report) {
  const base = root || dir;
  const seen = report || { copied: [], dropped: [] };
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      let target = null;
      try { target = fs.realpathSync(p); } catch (_) { target = null; }
      const stat = target ? fs.statSync(target) : null;
      fs.rmSync(p, { force: true });
      if (!stat) {
        // A link to something that was pruned, or that never shipped.
        seen.dropped.push(path.relative(base, p));
      } else if (stat.isDirectory()) {
        fs.cpSync(target, p, { recursive: true, dereference: true });
        seen.copied.push(path.relative(base, p) + '/');
      } else {
        fs.copyFileSync(target, p);
        seen.copied.push(path.relative(base, p));
      }
    } else if (entry.isDirectory()) {
      flattenSymlinks(p, base, seen);
    }
  }
  return seen;
}

async function buildWindows(ctx) {
  const { work, outDir } = ctx;
  const pythonVersion = arg('python-version', DEFAULT_PYTHON_VERSION);
  const stage = path.join(work, 'runtime');
  fs.mkdirSync(stage, { recursive: true });

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
  const zipPath = path.join(outDir, WIN_ASSET_NAME);
  log('Packing ' + files + ' files…');
  makeZip(stage, zipPath);

  return {
    stage,
    zipPath,
    closing: 'The Windows installer bundles this zip and manifest. Run the app build next.',
    runtime: {
      id: WIN_RUNTIME_ID,
      asset: WIN_ASSET_NAME,
      python: 'python.exe',
      pythonVersion,
      platform: 'win32',
      arch: 'x64',
      engine: 'faster-whisper',
      engines: ['whisper', 'qwen3-asr', 'parakeet'],
      torchDevice: 'cpu',
      installedBytes: dirSize(stage),
      files,
    },
  };
}

// The newest python-build-standalone release that still carries a CPython 3.12
// aarch64 install_only tarball. The tag is recorded in the manifest so a build
// can be traced back to the exact interpreter it shipped.
async function resolveMacPython() {
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'Voxden-Asr-Runtime-Build',
  };
  const token = String(process.env.GITHUB_TOKEN || '').trim();
  if (token) headers.Authorization = 'Bearer ' + token;
  const response = await fetch(MAC_PYTHON_RELEASE_API, { headers });
  if (!response.ok) {
    throw new Error('Could not read the python-build-standalone release list ('
      + response.status + '). Set GITHUB_TOKEN if this is a rate limit.');
  }
  const release = await response.json();
  const tag = String(release && release.tag_name || '');
  const assets = Array.isArray(release && release.assets) ? release.assets : [];
  let best = null;
  for (const asset of assets) {
    const match = MAC_PYTHON_ASSET.exec(String(asset && asset.name || ''));
    if (!match) continue;
    const patch = Number(match[1]);
    // A release carries one 3.12 build, but pick the highest patch rather than
    // whichever happens to be listed first if that ever changes.
    if (!best || patch > best.patch) {
      best = { patch, name: String(asset.name), url: String(asset.browser_download_url || '') };
    }
  }
  if (!best || !best.url) {
    throw new Error('python-build-standalone ' + (tag || 'latest')
      + ' has no cpython-3.12 aarch64-apple-darwin install_only build.');
  }
  return { tag, name: best.name, url: best.url };
}

async function buildMac(ctx) {
  const { work, outDir } = ctx;
  const chosen = await resolveMacPython();
  log('Using python-build-standalone ' + chosen.tag);
  log('Downloading ' + chosen.name + '…');
  const tarball = path.join(work, chosen.name);
  log('  ' + bytes(await download(chosen.url, tarball)));
  // install_only unpacks to a single python/ prefix: bin, lib, include, share.
  execFileSync('tar', ['-xzf', tarball, '-C', work], { stdio: 'inherit' });
  fs.rmSync(tarball, { force: true });

  const stage = path.join(work, 'python');
  const python = path.join(stage, 'bin', 'python3.12');
  if (!fs.existsSync(python)) {
    throw new Error('The extracted runtime has no bin/python3.12: ' + chosen.name);
  }
  const pythonVersion = execFileSync(python, [
    '-c', 'import platform; print(platform.python_version())',
  ], { encoding: 'utf8' }).trim();

  // The runtime installs into itself with its own interpreter, so console
  // scripts, the .dist-info records and the platform tags all match the
  // interpreter that will run them. --target would leave all three wrong.
  const torchSpec = 'torch==' + (String(process.env.VOXDEN_TORCH_SPEC || '').trim() || DEFAULT_TORCH_SPEC);
  log('Installing Whisper, Parakeet, and Qwen with the macOS arm64 PyTorch wheel…');
  log('  ' + [torchSpec].concat(SPEECH_PACKAGES).join(' '));
  // No PyTorch index and no +cpu local version: on Apple Silicon the PyPI
  // wheel is the Metal-capable build. If the pin has no macOS wheel, pip says
  // so and the build stops here rather than resolving to something else.
  execFileSync(python, [
    '-m', 'pip', 'install',
    '--quiet',
    '--no-warn-conflicts',
    '--prefer-binary',
    torchSpec,
    ...SPEECH_PACKAGES,
  ], {
    stdio: 'inherit',
    env: { ...process.env, PYTHONNOUSERSITE: '1', PIP_DISABLE_PIP_VERSION_CHECK: '1' },
  });

  const before = dirSize(stage);
  const removed = prune(stage);
  log('Pruned ' + bytes(removed) + ' (' + bytes(before) + ' -> ' + bytes(dirSize(stage)) + ')');

  const links = flattenSymlinks(stage);
  log('Replaced ' + links.copied.length + ' symlink(s) with real files'
    + (links.dropped.length ? ', dropped ' + links.dropped.length + ' broken' : ''));
  if (links.copied.length) log('  ' + links.copied.join(', '));
  if (links.dropped.length) log('  dropped: ' + links.dropped.join(', '));
  if (!fs.statSync(python).isFile()) {
    throw new Error('bin/python3.12 is not a real file after flattening symlinks.');
  }

  log('Verifying the runtime can run the sidecar…');
  const sidecar = path.join(__dirname, '..', 'sidecar', 'transcribe.py');
  const runEnv = (extra) => Object.assign({}, process.env, { PYTHONNOUSERSITE: '1' }, extra || {});
  const check = execFileSync(python, [sidecar, '--check'], {
    encoding: 'utf8',
    env: runEnv({ VOXDEN_ASR_ENGINE: 'whisper' }),
  });
  const parsed = JSON.parse(check.trim().split('\n').pop());
  if (!parsed.ok) throw new Error('The built runtime failed its own check: ' + parsed.error);
  log('  whisper : ' + check.trim());
  const parakeet = execFileSync(python, [sidecar, '--check'], {
    encoding: 'utf8',
    env: runEnv({ VOXDEN_ASR_ENGINE: 'parakeet' }),
  });
  const parsedParakeet = JSON.parse(parakeet.trim().split('\n').pop());
  if (!parsedParakeet.ok || parsedParakeet.warning) {
    throw new Error('The built runtime cannot run Parakeet: '
      + (parsedParakeet.error || parsedParakeet.warning));
  }
  log('  parakeet: ' + parakeet.trim());
  execFileSync(python, ['-I', '-c',
    'import torch, faster_whisper, onnx_asr; from qwen_asr import Qwen3ASRModel; '
    + 'print("All three speech backends import successfully", torch.__version__)'],
  { stdio: 'inherit', env: runEnv() });
  // DirectML is a Windows provider and is not expected here. What must be
  // present is the CPU provider: without it Parakeet has no backend at all.
  // CoreML is logged rather than required -- whether the macOS wheel carries
  // it is the wheel's business, and the sidecar never asks for it.
  const providers = execFileSync(python, [
    '-c',
    'import json, onnxruntime; print(json.dumps(onnxruntime.get_available_providers()))',
  ], { encoding: 'utf8', env: runEnv() }).trim();
  if (!providers.includes('CPUExecutionProvider')) {
    throw new Error('The built runtime has no CPU ONNX provider: ' + providers);
  }
  log('  providers: ' + providers);
  log('  CoreML   : ' + (providers.includes('CoreMLExecutionProvider')
    ? 'available' : 'not in this onnxruntime build'));
  execFileSync(python, [sidecar, '--self-test'], { stdio: 'inherit', env: runEnv() });

  const files = countFiles(stage);
  const zipPath = path.join(outDir, MAC_ASSET_NAME);
  log('Packing ' + files + ' files…');
  makeZipPosix(stage, zipPath);

  return {
    stage,
    zipPath,
    closing: 'The macOS app bundles this zip and manifest. Run the app build next.',
    runtime: {
      id: MAC_RUNTIME_ID,
      asset: MAC_ASSET_NAME,
      python: 'bin/python3.12',
      pythonVersion,
      pythonBuild: chosen.tag,
      platform: 'darwin',
      arch: 'arm64',
      engine: 'faster-whisper',
      engines: ['whisper', 'qwen3-asr', 'parakeet'],
      torchDevice: 'cpu',
      installedBytes: dirSize(stage),
      files,
    },
  };
}

async function main() {
  const outDir = path.resolve(arg('out', 'dist-runtime'));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'voxden-runtime-'));

  try {
    fs.mkdirSync(outDir, { recursive: true });

    let built;
    if (process.platform === 'win32') {
      built = await buildWindows({ work, outDir });
    } else if (process.platform === 'darwin') {
      if (process.arch !== 'arm64') {
        throw new Error('The macOS runtime is Apple Silicon only and must be built on arm64 (this is '
          + process.arch + ').');
      }
      built = await buildMac({ work, outDir });
    } else {
      throw new Error('The runtime targets Windows and macOS arm64, and must be built on one of them.');
    }

    const size = fs.statSync(built.zipPath).size;
    const digest = sha256(built.zipPath);
    const manifest = {
      schemaVersion: 1,
      runtime: Object.assign({}, built.runtime, { size, sha256: digest }),
    };
    fs.writeFileSync(path.join(outDir, MANIFEST_NAME), JSON.stringify(manifest, null, 2) + '\n');
    if (process.argv.includes('--keep-runtime')) {
      await fs.promises.cp(built.stage, path.join(outDir, 'runtime'), { recursive: true });
    }

    log('');
    log('Wrote ' + built.zipPath);
    log('  ' + bytes(size) + '  sha256:' + digest);
    log('Wrote ' + path.join(outDir, MANIFEST_NAME));
    log('');
    log(built.closing);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

main().catch((err) => {
  process.stderr.write((err && err.message ? err.message : err) + '\n');
  process.exit(1);
});
