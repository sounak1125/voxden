'use strict';

// Opt-in, real-artifact test. Reads local release files only and installs to a
// new temp/ profile. No user profiles, pip, system Python or external requests.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { promisify } = require('util');
const { execFile } = require('child_process');
const { QwenAccelPackManager, pathWithRuntimeBins, catalog } = require('../src/qwen-accel-pack');
const { validateQwenProbe } = require('../src/qwen-verification');
const run = promisify(execFile);
const ROOT = path.resolve(__dirname, '..');

async function main() {
  const kind = process.argv.includes('--rocm') ? 'rocm' : 'cuda';
  const spec = catalog[kind];
  const out = path.join(ROOT, 'dist-qwen-' + kind + '-pack');
  const manifest = JSON.parse(fs.readFileSync(path.join(out, spec.manifest), 'utf8'));
  assert(manifest.pack.optimized, 'Build and verify the compact pack first');
  const entries = [...manifest.pack.parts, ...manifest.pack.optimized.core.parts, ...manifest.pack.optimized.shared.parts];
  const assets = entries.map(part => ({ name: part.asset, size: part.size, digest: 'sha256:' + part.sha256,
    url: 'https://local-artifacts.invalid/' + part.asset, browser_download_url: 'https://local-artifacts.invalid/' + part.asset }));
  assets.push({ name: spec.manifest, size: fs.statSync(path.join(out, spec.manifest)).size,
    url: 'https://local-artifacts.invalid/' + spec.manifest,
    browser_download_url: 'https://local-artifacts.invalid/' + spec.manifest });
  const known = new Map(assets.map(asset => [asset.name, asset]));
  let downloadBytes = 0;
  const requests = new Set();
  const fetchImpl = async (url, options = {}) => {
    if (String(url).includes('api.github.com')) return new Response(JSON.stringify({ assets }));
    const name = new URL(url).pathname.slice(1);
    assert(known.has(name), 'Only declared local release files may be read');
    if (name === spec.manifest) return new Response(JSON.stringify(manifest));
    const file = path.join(out, name);
    const size = fs.statSync(file).size;
    const range = new Headers(options.headers).get('range');
    const match = range && /^bytes=(\d+)-(\d*)$/.exec(range);
    const start = match ? Number(match[1]) : 0;
    const end = match && match[2] ? Number(match[2]) : size - 1;
    requests.add(name);
    downloadBytes += end - start + 1;
    const headers = { 'Content-Length': String(end - start + 1) };
    if (match) headers['Content-Range'] = 'bytes ' + start + '-' + end + '/' + size;
    return new Response(Readable.toWeb(fs.createReadStream(file, { start, end, signal: options.signal })), {
      status: match ? 206 : 200, headers,
    });
  };
  fs.mkdirSync(path.join(ROOT, 'temp'), { recursive: true });
  const root = fs.mkdtempSync(path.join(ROOT, 'temp/qwen-compact-smoke-'));
  const resources = path.join(ROOT, 'dist/win-unpacked/resources');
  const sidecar = path.join(resources, 'sidecar/transcribe.py');
  const baseEnv = { SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP,
    PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', PYTHONNOUSERSITE: '1',
    VOXDEN_OFFLINE: '1', HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', HF_HUB_DISABLE_XET: '1',
    HF_HOME: path.join(root, 'empty-hub'), VOXDEN_QWEN_ACCEL: kind,
    VOXDEN_QWEN_ASR_MODEL: path.join(ROOT, 'models/asr-models/extras/qwen3-asr') };
  const environment = python => ({ ...baseEnv,
    PATH: pathWithRuntimeBins(python, path.join(process.env.SystemRoot, 'System32')) });
  let last = '';
  let speech;
  const manager = new QwenAccelPackManager({ kind, root: path.join(root, 'gpu'), fetchImpl,
    extractorPath: path.join(resources, 'pack-tools/7za.exe'),
    baseRuntimeRoot: path.join(out, 'compact-work/base'),
    onProgress: state => {
      const key = state.status + ':' + Math.floor((state.progress || 0) / 10);
      if (key !== last) { last = key; console.log(state.message, state.progress + '%'); }
    },
    validateRuntime: async python => {
      const result = await run(python, ['-I', '-B', sidecar, '--probe-qwen-accel'], {
        env: environment(python), timeout: 300000, windowsHide: true, maxBuffer: 4 * 1024 * 1024,
      });
      speech = JSON.parse(result.stdout.trim().split('\n').pop());
      assert.strictEqual(speech.backend, kind);
      assert(speech.qwenProbeOk);
      return validateQwenProbe(speech);
    } });
  await manager.install();
  assert(manager.snapshot().verified);
  assert.strictEqual(downloadBytes, manifest.pack.optimized.core.size, 'Matching base needs only the core');
  const python = manager.pythonPath();
  await run(python, ['-I', '-B', '-c',
    'import torch, qwen_asr, transformers, accelerate, faster_whisper, onnx_asr, onnxruntime, numpy, soundfile, scipy; print("All speech dependencies import")'], {
    env: environment(python), timeout: 120000, windowsHide: true,
  });
  const cpuCode = [
    'import sys,json',
    'sys.path.insert(0,' + JSON.stringify(path.dirname(sidecar)) + ')',
    'import transcribe,qwen_probe',
    'backend=transcribe.QwenBackend()',
    'assert backend.runtime["backend"] == "cpu"',
    'text=qwen_probe.run_probe(backend.model,backend.torch)',
    'print(json.dumps({"backend":"cpu","text":text}))',
  ].join(';');
  const cpu = await run(python, ['-I', '-B', '-c', cpuCode], {
    env: { ...environment(python), VOXDEN_QWEN_FORCE_CPU: '1' }, timeout: 300000, windowsHide: true,
  });
  const report = { kind, downloadBytes, requests: [...requests], modelChanged: false, gpuSpeech: speech,
    cpuSpeech: JSON.parse(cpu.stdout.trim().split('\n').pop()), allSpeechImports: true,
    packagedExtractor: true, packagedSidecar: true, externalDownloads: false, profile: root };
  fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
}

main().catch(error => { console.error(error); process.exitCode = 1; });
