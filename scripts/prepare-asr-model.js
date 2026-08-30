'use strict';

// Builds the Whisper model assets Voxden downloads on first run, so the whole
// first-run experience comes from one release we control rather than from
// Hugging Face.
//
//   npm run prepare:asr-model
//
// Needs a Python with faster-whisper (the built speech-engine runtime will do)
// so the model can be fetched and, more importantly, loaded once before it is
// published. A model that cannot transcribe is not worth uploading.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const DEFAULT_REPO = 'Systran/faster-whisper-large-v3';
const MANIFEST_NAME = 'voxden-asr-model.json';

// The id names the install directory and every asset, so it has to follow the
// repo. Hardcoding it meant a small.en build shipped assets called large-v3.
function modelIdFor(repo) {
  const name = String(repo).split('/').pop().replace(/^faster-whisper-/, '');
  const id = 'whisper-' + name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
  if (!/^[a-z0-9][a-z0-9._-]{0,100}$/.test(id)) {
    throw new Error('Cannot derive a usable model id from ' + repo);
  }
  return id;
}

// GitHub refuses a release asset over 2 GB, and model.bin is ~3.1 GB. The
// language packs already split this way; the client concatenates and verifies
// the whole file against one digest, so the split is invisible after install.
const PART_BYTES = 1800 * 1000 * 1000;

// Only these ever reach a user's disk. Anything else in a Hugging Face snapshot
// (READMEs, .gitattributes) is not something the app should be shipping.
const ALLOWED = new Set([
  'model.bin',
  'config.json',
  'preprocessor_config.json',
  'tokenizer.json',
  'vocabulary.json',
  'vocabulary.txt',
]);

function arg(name, fallback) {
  const index = process.argv.indexOf('--' + name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function log(message) {
  process.stdout.write(message + '\n');
}

function gb(n) {
  return (n / 1e9).toFixed(2) + ' GB';
}

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.allocUnsafe(8 * 1024 * 1024);
    let bytes;
    while ((bytes = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      hash.update(buf.subarray(0, bytes));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function splitFile(source, outDir, baseName) {
  const size = fs.statSync(source).size;
  const count = Math.ceil(size / PART_BYTES);
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
          const bytes = fs.readSync(fd, buf, 0, want, null);
          if (bytes <= 0) break;
          fs.writeSync(out, buf, 0, bytes);
          written += bytes;
        }
      } finally {
        fs.closeSync(out);
      }
      parts.push({ asset: name, size: written, sha256: sha256File(target) });
      log('  ' + name + '  ' + gb(written));
    }
  } finally {
    fs.closeSync(fd);
  }
  return parts;
}

function fetchModel(python, repo, cacheDir) {
  // faster-whisper pulls the snapshot through huggingface_hub; asking it for the
  // model is simpler and better-tested than reimplementing the Hub protocol.
  const code = [
    'import json, os',
    'from huggingface_hub import snapshot_download',
    'p = snapshot_download(' + JSON.stringify(repo) + ', cache_dir=' + JSON.stringify(cacheDir) + ')',
    'print(json.dumps({"path": p}))',
  ].join('\n');
  const out = execFileSync(python, ['-c', code], {
    encoding: 'utf8',
    env: Object.assign({}, process.env, { HF_HUB_DISABLE_XET: '1', PYTHONUTF8: '1' }),
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  return JSON.parse(out.trim().split('\n').pop()).path;
}

function verifyModel(python, modelDir) {
  const code = [
    'import json, sys',
    'from faster_whisper import WhisperModel',
    'm = WhisperModel(sys.argv[1], device="cpu", compute_type="int8")',
    'segments, info = m.transcribe(sys.argv[2], beam_size=1)',
    'list(segments)',
    'print(json.dumps({"ok": True, "lang": info.language}))',
  ].join('\n');
  // A two-second tone: enough to run the whole decode path without depending on
  // a speech fixture in the repo.
  const wav = path.join(os.tmpdir(), 'voxden-model-check.wav');
  writeToneWav(wav);
  const out = execFileSync(python, ['-c', code, modelDir, wav], {
    encoding: 'utf8',
    env: Object.assign({}, process.env, { HF_HUB_OFFLINE: '1', PYTHONUTF8: '1' }),
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  fs.rmSync(wav, { force: true });
  return JSON.parse(out.trim().split('\n').pop());
}

function writeToneWav(target) {
  const sr = 16000;
  const samples = sr * 2;
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) {
    const t = i / sr;
    data.writeInt16LE(Math.round(11000 * Math.sin(2 * Math.PI * 180 * t)), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sr, 24);
  header.writeUInt32LE(sr * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  fs.writeFileSync(target, Buffer.concat([header, data]));
}

function main() {
  const python = arg('python', process.env.VOXDEN_BUILD_PYTHON || 'python');
  const repo = arg('repo', DEFAULT_REPO);
  const outDir = path.resolve(arg('out', 'dist-model'));
  const modelId = arg('id', modelIdFor(repo));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'voxden-model-'));

  try {
    fs.mkdirSync(outDir, { recursive: true });
    log('Fetching ' + repo + '…');
    const snapshot = fetchModel(python, repo, path.join(work, 'cache'));
    log('  ' + snapshot);

    // Hugging Face snapshots are trees of symlinks into a blob store, and the
    // parts have to be cut from the real bytes.
    const staged = path.join(work, 'model');
    fs.mkdirSync(staged, { recursive: true });
    const files = [];
    for (const name of fs.readdirSync(snapshot)) {
      if (!ALLOWED.has(name)) continue;
      const real = fs.realpathSync(path.join(snapshot, name));
      const target = path.join(staged, name);
      fs.copyFileSync(real, target);
      files.push(name);
    }
    if (!files.includes('model.bin')) {
      throw new Error('The snapshot has no model.bin; ' + repo + ' is not a CTranslate2 model.');
    }
    log('Staged ' + files.length + ' files (' + gb(files.reduce(
      (sum, n) => sum + fs.statSync(path.join(staged, n)).size, 0
    )) + ')');

    log('Loading the model once before publishing it…');
    const verified = verifyModel(python, staged);
    if (!verified.ok) throw new Error('The staged model failed to load.');
    log('  loaded and decoded (detected language: ' + verified.lang + ')');

    const weights = path.join(staged, 'model.bin');
    const weightsSize = fs.statSync(weights).size;
    const weightsSha = sha256File(weights);

    log('Splitting model.bin into parts under GitHub\'s 2 GB asset limit…');
    const parts = splitFile(weights, outDir, 'voxden-' + modelId + '.bin');

    const extras = [];
    for (const name of files) {
      if (name === 'model.bin') continue;
      const assetName = 'voxden-' + modelId + '-' + name;
      fs.copyFileSync(path.join(staged, name), path.join(outDir, assetName));
      extras.push({
        asset: assetName,
        path: name,
        size: fs.statSync(path.join(outDir, assetName)).size,
        sha256: sha256File(path.join(outDir, assetName)),
      });
      log('  ' + assetName);
    }

    const manifest = {
      schemaVersion: 1,
      model: {
        id: modelId,
        source: repo,
        weightsFile: 'model.bin',
        weightsSize,
        weightsSha256: weightsSha,
        parts,
        files: extras,
      },
    };
    fs.writeFileSync(path.join(outDir, MANIFEST_NAME), JSON.stringify(manifest, null, 2) + '\n');

    const totalAssets = parts.reduce((s, p) => s + p.size, 0)
      + extras.reduce((s, f) => s + f.size, 0);
    log('');
    log('Wrote ' + (parts.length + extras.length + 1) + ' files to ' + outDir);
    log('  ' + gb(totalAssets) + ' total, model.bin sha256:' + weightsSha);
    log('');
    log('Upload everything in that directory to a GitHub release tagged asr-model-v1.');
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

try {
  main();
} catch (err) {
  process.stderr.write((err && err.message ? err.message : err) + '\n');
  process.exit(1);
}
