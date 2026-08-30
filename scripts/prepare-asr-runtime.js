'use strict';

// Builds the self-contained speech-engine runtime that Voxden downloads on
// first run, so a new user never installs Python or runs pip.
//
// The result is python.org's embeddable distribution with faster-whisper and
// its dependencies vendored in, plus the two VC++ runtime DLLs the wheels need
// that the embeddable distribution does not carry. Upload the zip and the
// manifest to a GitHub release tagged asr-runtime-v1.
//
//   node scripts/prepare-asr-runtime.js
//
// Run it on Windows with a python.exe whose version matches --python-version,
// because pip resolves wheels for the interpreter running it.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { extractZip } = require('../src/zip');

const DEFAULT_PYTHON_VERSION = '3.12.10';
const ASSET_NAME = 'voxden-asr-runtime-win-x64.zip';
const MANIFEST_NAME = 'voxden-asr-runtime.json';
const RUNTIME_ID = 'asr-win-x64-v1';

// Shipped app-local under the Visual C++ redistributable terms. The embeddable
// distribution carries VCRUNTIME140 but not the C++ standard library, and
// ctranslate2 and onnxruntime both import it.
const VC_RUNTIME_DLLS = ['MSVCP140.dll', 'MSVCP140_1.dll'];

// Dead weight in a runtime that only ever runs transcribe.py.
const PRUNE_DIRS = new Set([
  '__pycache__',
  'pip',
  'setuptools',
  'pkg_resources',
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

    log('Installing faster-whisper…');
    execFileSync(process.env.VOXDEN_BUILD_PYTHON || 'python', [
      '-m', 'pip', 'install',
      '--quiet',
      '--only-binary', ':all:',
      '--target', sitePackages,
      'faster-whisper',
    ], { stdio: 'inherit' });

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
    log('  ' + check.trim());
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
        files,
        size,
        sha256: digest,
      },
    };
    fs.writeFileSync(path.join(outDir, MANIFEST_NAME), JSON.stringify(manifest, null, 2) + '\n');

    log('');
    log('Wrote ' + zipPath);
    log('  ' + bytes(size) + '  sha256:' + digest);
    log('Wrote ' + path.join(outDir, MANIFEST_NAME));
    log('');
    log('Upload both to a GitHub release tagged asr-runtime-v1.');
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

main().catch((err) => {
  process.stderr.write((err && err.message ? err.message : err) + '\n');
  process.exit(1);
});
