'use strict';

// CPU vs CUDA (and ROCm when the machine actually has it) Qwen timings.
// Reads consented local audio if present; never copies or writes user profiles.
// Synthetic silence/noise live under temp/ only.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'temp', 'qwen-accel-bench');
const vocab = require('../src/vocabulary');
const wer = require('./lib/wer');

function arg(name, fallback) {
  const index = process.argv.indexOf('--' + name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function writeWav(filePath, samples, sampleRate) {
  const rate = sampleRate || 16000;
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    data.writeInt16LE(Math.round(v * 32767), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  fs.writeFileSync(filePath, Buffer.concat([header, data]));
}

function noise(seconds) {
  const rate = 16000;
  const n = Math.floor(seconds * rate);
  const samples = new Float64Array(n);
  for (let i = 0; i < n; i++) samples[i] = (Math.random() * 2 - 1) * 0.02;
  return samples;
}

function listConsentedWavs() {
  const pending = path.join(ROOT, 'data', 'audio', 'pending');
  if (!fs.existsSync(pending)) return [];
  return fs.readdirSync(pending)
    .filter((name) => name.toLowerCase().endsWith('.wav'))
    .slice(0, 8)
    .map((name) => ({
      id: name,
      path: path.join(pending, name),
      kind: 'consented-pending',
      reference: '',
    }));
}

function pythonCandidates(kind) {
  if (kind === 'cuda') {
    return [
      arg('cuda-python', ''),
      path.join(ROOT, 'dist-qwen-cuda-pack', 'runtime', 'python.exe'),
      path.join(ROOT, 'models', 'qwen-cuda-pack', 'runtime', 'python.exe'),
      process.env.VOXDEN_PYTHON,
    ];
  }
  if (kind === 'rocm') {
    return [
      arg('rocm-python', ''),
      path.join(ROOT, 'dist-qwen-rocm-pack', 'runtime', 'python.exe'),
      path.join(ROOT, 'models', 'qwen-rocm-pack', 'runtime', 'python.exe'),
    ];
  }
  return [
    arg('cpu-python', ''),
    process.env.VOXDEN_PYTHON,
    path.join(ROOT, 'dist-runtime-v3', 'runtime', 'python.exe'),
    path.join(ROOT, 'models', 'asr-runtime', 'runtime', 'python.exe'),
  ];
}

function existingPython(kind) {
  for (const p of pythonCandidates(kind)) {
    if (p && fs.existsSync(p)) return p;
  }
  return '';
}

function transcribeOnce(python, wavPath, options) {
  const opts = options || {};
  const sidecar = path.join(ROOT, 'sidecar', 'transcribe.py');
  const env = Object.assign({}, process.env, {
    PYTHONUTF8: '1',
    PYTHONIOENCODING: 'utf-8',
    PYTHONUNBUFFERED: '1',
    PYTHONNOUSERSITE: '1',
    HF_HUB_OFFLINE: '1',
    TRANSFORMERS_OFFLINE: '1',
    VOXDEN_OFFLINE: '1',
    VOXDEN_ASR_ENGINE: 'qwen3-asr',
    VOXDEN_QWEN_ACCEL: opts.accel || 'cpu',
    VOXDEN_DEVICE: opts.accel === 'cpu' ? 'cpu' : 'auto',
    VOXDEN_QWEN_ASR_MODEL: opts.model || process.env.VOXDEN_QWEN_ASR_MODEL || '',
  });
  if (opts.accel === 'cpu') env.VOXDEN_TORCH_DEVICE = 'cpu';
  else {
    delete env.VOXDEN_TORCH_DEVICE;
    env.VOXDEN_QWEN_ACCEL_READY = '1';
  }
  env.PYTHONPATH = path.join(ROOT, 'sidecar');
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(python, ['-I', sidecar, '--serve'], {
      env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let buf = '';
    let ready = false;
    const timer = setTimeout(() => {
      try { child.kill(); } catch (_) {}
      reject(new Error('timed out'));
    }, opts.timeoutMs || 300000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch (_) { continue; }
        if (msg.ready && !ready) {
          ready = true;
          const coldMs = Date.now() - started;
          child.stdin.write(JSON.stringify({
            path: wavPath,
            prompt: opts.prompt || '',
            language: opts.language || 'en',
            id: '1',
          }) + '\n');
          msg._coldMs = coldMs;
          child._handshake = msg;
          continue;
        }
        if (msg.id === '1' || msg.ok || msg.error) {
          clearTimeout(timer);
          const warmMs = Date.now() - started;
          try { child.stdin.write('QUIT\n'); } catch (_) {}
          resolve({
            ok: !!msg.ok,
            text: msg.text || '',
            backend: msg.backend || (child._handshake && child._handshake.backend) || '',
            device: msg.device || '',
            computeType: msg.compute_type || '',
            fallbackReason: msg.fallback_reason || '',
            recognitionSec: msg.recognition_sec || 0,
            audioSec: msg.audio_sec || 0,
            rtf: msg.rtf || 0,
            coldStartSec: (child._handshake && child._handshake._coldMs)
              ? child._handshake._coldMs / 1000
              : 0,
            endToEndSec: warmMs / 1000,
            error: msg.error || '',
            handshake: child._handshake || {},
          });
        }
      }
    });
    child.stderr.on('data', () => {});
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const silence = path.join(OUT_DIR, 'silence.wav');
  const noiseWav = path.join(OUT_DIR, 'noise.wav');
  writeWav(silence, new Float64Array(16000 * 2));
  writeWav(noiseWav, noise(2));

  const terms = [
    vocab.makeEntry('Voxden'),
    vocab.makeEntry('Kharagpur'),
    vocab.makeEntry('नमस्ते', { language: 'hi' }),
    vocab.makeEntry('Café'),
    vocab.makeEntry('BrandNewToken'),
  ];
  const ctx = vocab.contextFor(terms, { engine: 'qwen3-asr', language: 'en' });

  const fixtures = [
    { id: 'silence', path: silence, kind: 'silence', reference: '' },
    { id: 'noise', path: noiseWav, kind: 'noise', reference: '' },
    ...listConsentedWavs(),
  ];
  const publicEn = path.join(ROOT, 'temp', 'asr_en.wav');
  if (fs.existsSync(publicEn)) {
    fixtures.push({
      id: 'public-en',
      path: publicEn,
      kind: 'english-public',
      reference: 'Uh huh. Oh yeah, yeah. He wasn\'t even that big when I started listening to him, but and his solo music didn\'t do overly well, but he did very well when he started writing for other people.',
    });
  }

  const modelDir = [
    path.join(ROOT, 'models', 'asr-models', 'extras', 'qwen3-asr'),
    process.env.VOXDEN_QWEN_ASR_MODEL,
  ].find((p) => p && fs.existsSync(p));

  const rows = [];
  for (const kind of ['cpu', 'cuda', 'rocm']) {
    const python = existingPython(kind);
    if (!python) {
      rows.push({ backend: kind, skipped: true, reason: 'pack python not present' });
      continue;
    }
    try {
      const probe = execFileSync(python, ['-I', '-c',
        'import torch; print(torch.__version__); print(getattr(torch.version,"cuda",None) or ""); print(getattr(torch.version,"hip",None) or ""); print(torch.cuda.is_available())',
      ], { encoding: 'utf8', windowsHide: true, env: { PYTHONNOUSERSITE: '1', PYTHONUTF8: '1' } });
      process.stdout.write(kind + ' python ' + python + '\n' + probe + '\n');
    } catch (err) {
      rows.push({ backend: kind, skipped: true, reason: String(err && err.message || err) });
      continue;
    }
    for (const fixture of fixtures) {
      const first = await transcribeOnce(python, fixture.path, {
        accel: kind,
        prompt: ctx.text,
        model: modelDir,
      });
      const second = await transcribeOnce(python, fixture.path, {
        accel: kind,
        prompt: ctx.text,
        model: modelDir,
      });
        const score = fixture.reference
        ? wer.wer(fixture.reference, first.text || '')
        : null;
      rows.push({
        backend: kind,
        fixture: fixture.id,
        kind: fixture.kind,
        cold: first,
        warm: second,
        wer: score,
        dictionaryContext: ctx.text,
      });
      process.stdout.write(
        kind + ' ' + fixture.id
        + ' backend=' + (second.backend || first.backend)
        + ' cold=' + (first.coldStartSec || 0).toFixed(2) + 's'
        + ' warm_rtf=' + (second.rtf || 0)
        + ' text=' + JSON.stringify((second.text || first.text || '').slice(0, 80))
        + '\n'
      );
    }
  }

  const report = {
    at: new Date().toISOString(),
    machine: os.cpus()[0] && os.cpus()[0].model,
    context: ctx.text,
    physicalAmd: false,
    rows,
  };
  fs.writeFileSync(path.join(OUT_DIR, 'report.json'), JSON.stringify(report, null, 2));
  process.stdout.write('wrote ' + path.join(OUT_DIR, 'report.json') + '\n');
}

main().catch((err) => {
  process.stderr.write((err && err.stack ? err.stack : err) + '\n');
  process.exit(1);
});
