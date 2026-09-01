'use strict';

// Build an isolated Qwen accelerator pack: CUDA PyTorch or Windows ROCm PyTorch.
//
//   node scripts/prepare-qwen-accel-pack.js --kind cuda
//   node scripts/prepare-qwen-accel-pack.js --kind rocm
//
// The pack is its own embeddable Python tree. Nothing is copied into the CPU
// speech runtime. The zip is an optional GitHub prerelease, never extraResources.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { extractZip } = require('../src/zip');
const catalog = require('../src/qwen-accel-catalog.json');
const { pathWithRuntimeBins } = require('../src/qwen-accel-pack');

const DEFAULT_PYTHON_VERSION = catalog.python || '3.12.10';
const VC_RUNTIME_DLLS = ['MSVCP140.dll', 'MSVCP140_1.dll'];
const PRUNE_DIRS = new Set(['__pycache__', 'pip', 'wheel', 'hf_xet']);
const MARKER_NAME = 'voxden-qwen-accel.json';
const ROOT = path.join(__dirname, '..');
// GitHub refuses a release asset over 2 GiB. Same split size as the Whisper model.
const PART_BYTES = 1800 * 1000 * 1000;

const ROCM_SDK = [
  'https://repo.radeon.com/rocm/windows/rocm-rel-7.2.1/rocm_sdk_core-7.2.1-py3-none-win_amd64.whl',
  'https://repo.radeon.com/rocm/windows/rocm-rel-7.2.1/rocm_sdk_devel-7.2.1-py3-none-win_amd64.whl',
  'https://repo.radeon.com/rocm/windows/rocm-rel-7.2.1/rocm_sdk_libraries_custom-7.2.1-py3-none-win_amd64.whl',
  'https://repo.radeon.com/rocm/windows/rocm-rel-7.2.1/rocm-7.2.1.tar.gz',
];
const ROCM_TORCH = [
  'https://repo.radeon.com/rocm/windows/rocm-rel-7.2.1/torch-2.9.1%2Brocm7.2.1-cp312-cp312-win_amd64.whl',
  'https://repo.radeon.com/rocm/windows/rocm-rel-7.2.1/torchaudio-2.9.1%2Brocm7.2.1-cp312-cp312-win_amd64.whl',
  'https://repo.radeon.com/rocm/windows/rocm-rel-7.2.1/torchvision-0.24.1%2Brocm7.2.1-cp312-cp312-win_amd64.whl',
];
const ROCM_WHEELS = ROCM_SDK.concat(ROCM_TORCH);

function arg(name, fallback) {
  const index = process.argv.indexOf('--' + name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function hasFlag(name) {
  return process.argv.includes('--' + name);
}

function log(message) {
  process.stdout.write(message + '\n');
}

function bytes(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + ' GB';
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

async function cachedUrls(urls, cacheDir) {
  fs.mkdirSync(cacheDir, { recursive: true });
  const local = [];
  for (const url of urls) {
    const name = decodeURIComponent(String(url).split('/').pop());
    const dest = path.join(cacheDir, name);
    if (!fs.existsSync(dest) || fs.statSync(dest).size < 1024) {
      log('  downloading ' + name);
      await download(url, dest);
      log('    ' + bytes(fs.statSync(dest).size));
    } else {
      log('  cached ' + name + ' (' + bytes(fs.statSync(dest).size) + ')');
    }
    local.push(dest);
  }
  return local;
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

function swapInDirectmlRuntime(sitePackages) {
  const stale = fs.readdirSync(sitePackages).filter(
    (name) => name === 'onnxruntime'
      || (name.startsWith('onnxruntime-') && name.endsWith('.dist-info'))
  );
  for (const name of stale) {
    fs.rmSync(path.join(sitePackages, name), { recursive: true, force: true });
  }
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
      throw new Error(name + ' was not found in System32. Install the VC++ redistributable.');
    }
    fs.copyFileSync(from, path.join(destination, name));
    copied.push(name);
  }
  return copied;
}

function makeZip(sourceDir, zipPath) {
  const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  if (!fs.existsSync(tar)) {
    throw new Error('tar.exe was not found. Windows 10 1803 or newer is required.');
  }
  fs.rmSync(zipPath, { force: true });
  execFileSync(tar, ['-a', '-c', '-f', zipPath, '-C', sourceDir, '.'], { stdio: 'inherit' });
}

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.allocUnsafe(8 * 1024 * 1024);
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      hash.update(buf.subarray(0, n));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function splitFile(source, outDir, baseName) {
  const size = fs.statSync(source).size;
  const count = Math.max(1, Math.ceil(size / PART_BYTES));
  const parts = [];
  const fd = fs.openSync(source, 'r');
  try {
    const buf = Buffer.allocUnsafe(8 * 1024 * 1024);
    for (let index = 0; index < count; index += 1) {
      const name = baseName + '.part' + String(index + 1).padStart(2, '0');
      const target = path.join(outDir, name);
      const out = fs.openSync(target, 'w');
      let written = 0;
      try {
        while (written < PART_BYTES) {
          const want = Math.min(buf.length, PART_BYTES - written);
          const n = fs.readSync(fd, buf, 0, want, null);
          if (n <= 0) break;
          fs.writeSync(out, buf, 0, n);
          written += n;
        }
      } finally {
        fs.closeSync(out);
      }
      parts.push({ asset: name, size: written, sha256: sha256File(target) });
      log('  ' + name + '  ' + bytes(written));
    }
  } finally {
    fs.closeSync(fd);
  }
  return parts;
}

function writePackArtifacts(kind, spec, outDir, zipPath, extras) {
  const extra = extras || {};
  const size = fs.statSync(zipPath).size;
  log('Hashing ' + spec.asset + ' (' + bytes(size) + ')…');
  const digest = sha256File(zipPath);
  let parts = [{ asset: spec.asset, size, sha256: digest }];
  if (size > PART_BYTES) {
    log('Splitting for the GitHub 2 GiB asset limit…');
    parts = splitFile(zipPath, outDir, spec.asset);
  }
  const manifest = {
    schemaVersion: 1,
    pack: {
      id: spec.id,
      kind,
      asset: spec.asset,
      python: spec.python,
      torch: spec.torch,
      files: extra.files || 0,
      size,
      sha256: digest,
      installedBytes: extra.installedBytes || 0,
      parts,
    },
  };
  fs.writeFileSync(path.join(outDir, spec.manifest), JSON.stringify(manifest, null, 2) + '\n');
  if (!hasFlag('no-catalog')) {
    updateCatalog(kind, {
      sha256: digest,
      downloadBytes: size,
      downloadSize: bytes(size),
      installedSize: extra.installedBytes ? bytes(extra.installedBytes) : spec.installedSize,
      parts,
    });
  }
  log('');
  log('Wrote ' + zipPath);
  log('  ' + bytes(size) + '  sha256:' + digest);
  log('Wrote ' + path.join(outDir, spec.manifest));
  return { size, digest, parts };
}

function pipTarget(sitePackages, extraArgs, packages) {
  execFileSync(process.env.VOXDEN_BUILD_PYTHON || 'python', [
    '-m', 'pip', 'install',
    '--no-warn-conflicts',
    '--prefer-binary',
    '--target', sitePackages,
    ...extraArgs,
    ...packages,
  ], { stdio: 'inherit' });
}

function pythonEval(python, code) {
  return execFileSync(python, ['-I', '-c', code], {
    encoding: 'utf8',
    timeout: 180000,
    env: Object.assign({}, process.env, { PYTHONNOUSERSITE: '1', PYTHONUTF8: '1' }),
  }).trim();
}

function updateCatalog(kind, fields) {
  const file = path.join(ROOT, 'src', 'qwen-accel-catalog.json');
  const current = JSON.parse(fs.readFileSync(file, 'utf8'));
  current[kind] = Object.assign({}, current[kind], fields);
  fs.writeFileSync(file, JSON.stringify(current, null, 2) + '\n');
}

async function main() {
  if (process.platform !== 'win32') {
    throw new Error('Qwen accelerator packs are Windows x64 artifacts.');
  }
  const kind = String(arg('kind', '') || '').trim().toLowerCase();
  if (kind !== 'cuda' && kind !== 'rocm') {
    throw new Error('Pass --kind cuda or --kind rocm.');
  }
  const spec = catalog[kind];
  const pythonVersion = arg('python-version', spec.python || DEFAULT_PYTHON_VERSION);
  const outDir = path.resolve(arg('out', kind === 'rocm' ? 'dist-qwen-rocm-pack' : 'dist-qwen-cuda-pack'));
  fs.mkdirSync(outDir, { recursive: true });

  if (hasFlag('finalize')) {
    const zipPath = path.join(outDir, spec.asset);
    if (!fs.existsSync(zipPath)) {
      throw new Error('Cannot finalize: ' + zipPath + ' is missing.');
    }
    const existing = (() => {
      try {
        return JSON.parse(fs.readFileSync(path.join(outDir, spec.manifest), 'utf8'));
      } catch (_) {
        return null;
      }
    })();
    writePackArtifacts(kind, spec, outDir, zipPath, {
      files: (existing && existing.pack && existing.pack.files) || 33463,
      installedBytes: (existing && existing.pack && existing.pack.installedBytes) || 5260000000,
    });
    return;
  }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'voxden-qwen-' + kind + '-'));
  const stage = path.join(work, 'runtime');
  const skipProbe = hasFlag('skip-probe');

  try {
    fs.mkdirSync(stage, { recursive: true });
    fs.mkdirSync(outDir, { recursive: true });

    const embedUrl = 'https://www.python.org/ftp/python/' + pythonVersion
      + '/python-' + pythonVersion + '-embed-amd64.zip';
    const embedZip = path.join(work, 'embed.zip');
    log('Downloading Python ' + pythonVersion + ' (embeddable)…');
    log('  ' + bytes(await download(embedUrl, embedZip)));
    await extractZip(embedZip, stage);

    const pthName = 'python' + pythonVersion.split('.').slice(0, 2).join('') + '._pth';
    const pth = path.join(stage, pthName);
    if (!fs.existsSync(pth)) throw new Error('Expected ' + pthName);
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
    const python = path.join(stage, 'python.exe');

    if (kind === 'cuda') {
      log('Installing CUDA PyTorch ' + spec.torch + ' and speech backends…');
      pipTarget(sitePackages, ['--extra-index-url', 'https://download.pytorch.org/whl/cu128'], [
        'torch==2.11.0+cu128',
        'qwen-asr==0.0.6',
        'transformers==4.57.6',
        'accelerate==1.12.0',
        'faster-whisper==1.2.1',
        'onnx-asr[hub]==0.12.0',
      ]);
      const torchInfo = pythonEval(python,
        'import torch; print(torch.__version__); print(torch.version.cuda or "")');
      log('  torch: ' + torchInfo.replace(/\n/g, ' / '));
      if (!/\+cu|cuda/i.test(torchInfo)) {
        log('CUDA torch was replaced; reinstalling torch==2.11.0+cu128…');
        pipTarget(sitePackages, ['--extra-index-url', 'https://download.pytorch.org/whl/cu128', '--no-deps'], [
          'torch==2.11.0+cu128',
        ]);
      }
    } else {
      log('Installing AMD Windows ROCm SDK 7.2.1…');
      const wheelCache = path.join(ROOT, 'temp', 'qwen-rocm-wheels');
      pipTarget(sitePackages, [], await cachedUrls(ROCM_SDK, wheelCache));
      log('Installing AMD Windows ROCm PyTorch ' + spec.torch + '…');
      pipTarget(sitePackages, ['--no-deps'], await cachedUrls(ROCM_TORCH, wheelCache));
      pipTarget(sitePackages, [], [
        'filelock',
        'typing-extensions>=4.10.0',
        'setuptools',
        'sympy>=1.13.3',
        'networkx>=2.5.1',
        'jinja2',
        'fsspec>=0.8.5',
        'pillow',
        'numpy',
      ]);
      log('Installing Qwen, Whisper, and Parakeet on top of ROCm torch…');
      pipTarget(sitePackages, [], [
        'qwen-asr==0.0.6',
        'transformers==4.57.6',
        'accelerate==1.12.0',
        'faster-whisper==1.2.1',
        'onnx-asr[hub]==0.12.0',
      ]);
      log('Restoring pinned ROCm PyTorch after speech-package installs…');
      pipTarget(sitePackages, ['--no-deps', '--upgrade'], await cachedUrls(ROCM_TORCH, wheelCache));
      const torchInfo = pythonEval(python,
        'import torch; print(torch.__version__); print(getattr(torch.version,"hip",None) or "")');
      log('  torch: ' + torchInfo.replace(/\n/g, ' / '));
      if (!/rocm|hip/i.test(torchInfo)) {
        log('ROCm torch was replaced; reinstalling pinned ROCm wheels…');
        pipTarget(sitePackages, ['--no-deps', '--upgrade'], await cachedUrls(ROCM_TORCH, wheelCache));
        const again = pythonEval(python,
          'import torch; print(torch.__version__); print(getattr(torch.version,"hip",None) or "")');
        log('  torch: ' + again.replace(/\n/g, ' / '));
        if (!/rocm|hip/i.test(again)) {
          throw new Error('ROCm PyTorch did not land. torch reported:\n' + again);
        }
      }
    }

    log('Swapping ONNX Runtime for the DirectML build (Parakeet Fast English)…');
    log('  replaced ' + swapInDirectmlRuntime(sitePackages).join(', '));
    log('Adding the Visual C++ runtime…');
    log('  ' + copyVcRuntime(stage).join(', '));

    fs.writeFileSync(path.join(stage, MARKER_NAME), JSON.stringify({
      kind,
      id: spec.id,
      torch: spec.torch,
      python: pythonVersion,
      qwenAsr: catalog.qwenAsr,
      transformers: catalog.transformers,
    }, null, 2) + '\n');

    const before = dirSize(stage);
    const removed = prune(stage);
    log('Pruned ' + bytes(removed) + ' (' + bytes(before) + ' -> ' + bytes(dirSize(stage)) + ')');

    log('Verifying imports…');
    pythonEval(python,
      'import torch, faster_whisper, onnx_asr; from qwen_asr import Qwen3ASRModel; '
      + 'print(torch.__version__, getattr(torch.version,"cuda",None), getattr(torch.version,"hip",None))');

    if (!skipProbe) {
      const sidecar = path.join(ROOT, 'sidecar', 'transcribe.py');
      const probeEnv = Object.assign({}, process.env, {
        PYTHONNOUSERSITE: '1',
        PYTHONUTF8: '1',
        PYTHONPATH: path.join(ROOT, 'sidecar'),
        PATH: pathWithRuntimeBins(python, process.env.PATH),
        VOXDEN_QWEN_ACCEL: kind,
        VOXDEN_OFFLINE: '1',
        HF_HUB_OFFLINE: '1',
        TRANSFORMERS_OFFLINE: '1',
      });
      delete probeEnv.VOXDEN_TORCH_DEVICE;
      const modelDir = path.join(ROOT, 'models', 'asr-models', 'extras', 'qwen3-asr');
      if (fs.existsSync(modelDir)) probeEnv.VOXDEN_QWEN_ASR_MODEL = modelDir;
      try {
        const probe = execFileSync(python, ['-I', sidecar, '--probe-qwen-accel'], {
          encoding: 'utf8',
          env: probeEnv,
          timeout: 300000,
        });
        log('  probe: ' + probe.trim().split('\n').pop());
      } catch (err) {
        if (kind === 'rocm') {
          log('ROCm tensor/Qwen probe did not succeed on this machine. The zip is still produced.');
          log('Physical AMD verification remains outstanding.');
          if (err && err.stdout) log(String(err.stdout).slice(-500));
        } else {
          throw new Error('CUDA pack probe failed: ' + ((err && err.message) || err));
        }
      }
    } else {
      log('Skipping GPU probe (--skip-probe).');
    }

    const files = countFiles(stage);
    const zipPath = path.join(outDir, spec.asset);
    log('Packing ' + files + ' files…');
    makeZip(stage, zipPath);
    writePackArtifacts(kind, spec, outDir, zipPath, {
      files,
      installedBytes: dirSize(stage),
    });
    if (hasFlag('keep-runtime')) {
      await fs.promises.cp(stage, path.join(outDir, 'runtime'), { recursive: true });
    }
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

main().catch((err) => {
  process.stderr.write((err && err.stack ? err.stack : err) + '\n');
  process.exit(1);
});
