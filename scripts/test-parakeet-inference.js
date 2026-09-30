'use strict';

// Opt-in integration test (~670 MB download). Exercises the production installer
// and sidecar with real Parakeet V3 weights and the repository's synthetic speech.
// Usage: VOXDEN_PYTHON=/path/to/runtime/python node scripts/test-parakeet-inference.js
//   [--json report.json] [--model-cache temp/parakeet-inference]
//   [--expect-platform darwin --expect-arch arm64 --expect-os-major 14]
// A supplied model cache must be empty or owned by this test. No user caches,
// microphone recordings, cloud transcription, or paid services are used.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { spawn, execFileSync } = require('node:child_process');
const { SpeechModelsManager } = require('../src/speech-models');
const catalog = require('../src/speech-model-catalog.json');

const options = {};
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i];
  assert(['--json', '--model-cache', '--expect-platform', '--expect-arch', '--expect-os-major'].includes(key), `Unknown option ${key}`);
  assert(process.argv[i + 1] && !process.argv[i + 1].startsWith('--'), `Missing value for ${key}`);
  options[key.slice(2)] = process.argv[i + 1];
}
const ROOT = path.resolve(__dirname, '..');
const python = process.env.VOXDEN_PYTHON;
assert(python, 'Set VOXDEN_PYTHON to the built speech runtime interpreter; no system-Python fallback is allowed.');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'voxden-parakeet-inference-'));
const modelCache = options['model-cache'] ? path.resolve(options['model-cache']) : path.join(temporary, 'models');
const marker = path.join(modelCache, '.voxden-parakeet-inference-test');
const cpus = os.cpus();
const report = { startedAt: new Date().toISOString(), platform: process.platform, arch: process.arch,
  host: { kernelRelease: os.release(), osVersion: os.version(),
    cpuModels: [...new Set(cpus.map(cpu => cpu.model))], logicalCpuCount: cpus.length,
    totalMemoryBytes: os.totalmem(), runnerImage: process.env.ImageOS || null, runnerImageVersion: process.env.ImageVersion || null },
  coverage: 'Real catalog install and offline sidecar inference; no physical microphone, Accessibility paste, or sleep/wake coverage.',
  checks: [], status: 'running' };
const clients = new Set();
let manager;

function writeReport() {
  if (options.json) fs.writeFileSync(path.resolve(options.json), JSON.stringify(report, null, 2) + '\n');
}

// A hard bound also covers a stalled download/socket or native model load.
const watchdog = setTimeout(() => {
  manager?.cancel();
  for (const client of clients) client.child.kill('SIGKILL');
  report.status = 'failed';
  report.error = 'Integration test exceeded its 20 minute total deadline';
  report.finishedAt = new Date().toISOString();
  writeReport();
  console.error(report.error, '(temporary test files retained at ' + temporary + ')');
  process.exit(1);
}, 20 * 60 * 1000);

async function check(name, action) {
  console.log('START', name);
  const started = Date.now();
  try {
    const detail = await action();
    report.checks.push({ name, status: 'passed', durationMs: Date.now() - started, detail });
    console.log('PASS ', name, '(' + ((Date.now() - started) / 1000).toFixed(1) + 's)');
    return detail;
  } catch (error) {
    report.checks.push({ name, status: 'failed', durationMs: Date.now() - started, error: error.message });
    throw error;
  }
}

function isolatedEnvironment(modelDirectory) {
  const env = { ...process.env };
  // Settings from a developer's running application must not select another
  // backend, GPU pack, cache, model, or Python module search path.
  for (const key of Object.keys(env)) {
    if (/^(VOXDEN_|HF_|HUGGINGFACE_|TRANSFORMERS_|PYTHONPATH$|PYTHONHOME$)/i.test(key)) delete env[key];
  }
  return Object.assign(env, {
    PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', PYTHONNOUSERSITE: '1',
    HF_HOME: path.join(temporary, 'empty-hub'), HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1',
    VOXDEN_OFFLINE: '1', VOXDEN_MODEL_DIR: path.join(temporary, 'empty-cache'),
    VOXDEN_MODEL: path.join(temporary, 'absent-whisper'), VOXDEN_ASR_ENGINE: 'parakeet',
    VOXDEN_DEVICE: 'cpu', VOXDEN_TORCH_DEVICE: 'cpu', VOXDEN_QWEN_ACCEL: 'cpu',
    VOXDEN_PARAKEET_INT8_DIR: modelDirectory,
    VOXDEN_PARAKEET_FP32_DIR: path.join(temporary, 'absent-fp32'),
    VOXDEN_QWEN_ASR_MODEL: path.join(temporary, 'absent-qwen'),
  });
}

function sidecar(modelDirectory) {
  const child = spawn(python, ['-I', '-B', path.join(__dirname, 'test-parakeet-inference.py'), '--serve'], {
    cwd: ROOT, env: isolatedEnvironment(modelDirectory), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const client = { child, stderr: '', messages: [], pending: null, closed: false };
  clients.add(client);
  child.stderr.on('data', data => { client.stderr = (client.stderr + data).slice(-16000); });
  child.stdin.on('error', error => { if (client.pending) client.pending.reject(error); });
  const lines = readline.createInterface({ input: child.stdout });
  lines.on('line', line => {
    try {
      const message = JSON.parse(line);
      if (client.pending) client.pending.resolve(message);
      else client.messages.push(message);
    } catch (error) {
      client.protocolError = new Error('Non-JSON data on sidecar stdout: ' + line.slice(0, 200));
      if (client.pending) client.pending.reject(client.protocolError);
    }
  });
  client.exited = new Promise(resolve => {
    child.on('error', error => {
      client.protocolError = error;
      if (client.pending) client.pending.reject(error);
    });
    child.on('close', (code, signal) => {
      client.closed = true;
      clients.delete(client);
      if (client.pending) client.pending.reject(new Error(`Sidecar closed (${code}/${signal}): ${client.stderr}`));
      resolve({ code, signal });
    });
  });
  client.next = (timeout = 180000) => {
    if (client.protocolError) return Promise.reject(client.protocolError);
    if (client.messages.length) return Promise.resolve(client.messages.shift());
    if (client.closed) return Promise.reject(new Error('Sidecar is closed: ' + client.stderr));
    assert(!client.pending, 'One outstanding sidecar request at a time');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        client.pending.reject(new Error('Sidecar response exceeded ' + timeout + 'ms: ' + client.stderr));
      }, timeout);
      const finish = fn => value => { clearTimeout(timer); client.pending = null; fn(value); };
      client.pending = { resolve: finish(resolve), reject: finish(reject) };
    });
  };
  client.request = async request => {
    child.stdin.write(JSON.stringify(request) + '\n');
    const response = await client.next();
    assert.equal(response.id, request.id, 'Sidecar must preserve request IDs');
    return response;
  };
  client.stop = async (force = false) => {
    if (force) child.kill('SIGKILL');
    else if (!client.closed) child.stdin.end('QUIT\n');
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    try { return await client.exited; } finally { clearTimeout(timer); }
  };
  return client;
}

function assertReady(message) {
  assert.equal(message.ok, true, JSON.stringify(message));
  assert.equal(message.ready, true);
  assert.equal(message.engine, 'parakeet', 'No silent Whisper fallback');
  assert.equal(message.selected_engine, 'parakeet');
  assert.equal(message.model, 'nemo-parakeet-tdt-0.6b-v3');
  assert.equal(message.device, 'cpu');
  assert.equal(message.compute_type, 'int8');
  assert.equal(message.warning, '');
  assert.equal(message.fallback_reason, '');
  return { engine: message.engine, model: message.model, device: message.device, computeType: message.compute_type };
}

function assertTranscript(response, expected) {
  assert.equal(response.ok, true, JSON.stringify(response));
  assert.equal(response.engine, 'parakeet', 'Transcript must come from Parakeet');
  assert.equal(response.device, 'cpu');
  const wanted = expected.toLowerCase().match(/[a-z]+/g);
  const actual = (response.text || '').toLowerCase().match(/[a-z]+/g) || [];
  // Levenshtein word error rate checks order and penalizes repeated/hallucinated
  // output, unlike a nonempty or word-set-only assertion.
  let previous = Array.from({ length: actual.length + 1 }, (_, i) => i);
  for (let i = 1; i <= wanted.length; i++) {
    const current = [i];
    for (let j = 1; j <= actual.length; j++) {
      current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + (wanted[i - 1] === actual[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  const wordErrorRate = previous[actual.length] / wanted.length;
  assert(wordErrorRate <= 0.25, `Unexpected transcript (WER ${wordErrorRate}): ${response.text}`);
  return { text: response.text, wordErrorRate, recognitionSeconds: response.recognition_sec };
}

async function main() {
  await check('Native runtime identity', async () => {
    if (options['expect-platform']) assert.equal(process.platform, options['expect-platform']);
    if (options['expect-arch']) assert.equal(process.arch, options['expect-arch']);
    const runtime = JSON.parse(execFileSync(python, ['-I', '-B', path.join(__dirname, 'test-parakeet-inference.py'), '--runtime-info'],
      { encoding: 'utf8', timeout: 30000, windowsHide: true, env: isolatedEnvironment(path.join(temporary, 'absent')) }));
    assert.equal(runtime.platform, process.platform === 'win32' ? 'win32' : process.platform);
    if (process.platform === 'darwin') assert.equal(runtime.machine, 'arm64', 'Mac CI must run native ARM Python, without Rosetta');
    if (options['expect-os-major']) assert.equal(runtime.osVersion.split('.')[0], options['expect-os-major'], 'The actual OS must match the requested major version');
    assert(runtime.packages['onnx-asr'], 'Use a speech runtime with onnx-asr installed');
    report.runtime = runtime;
    return runtime;
  });
  await check('Download and SHA-256 verify catalog Parakeet V3 int8 pack', async () => {
    if (fs.existsSync(modelCache) && fs.readdirSync(modelCache).length && !fs.existsSync(marker)) {
      throw new Error('Refusing a nonempty model cache not owned by this integration test: ' + modelCache);
    }
    fs.mkdirSync(modelCache, { recursive: true });
    fs.writeFileSync(marker, 'Only test-parakeet-inference.js manages this test cache.\n');
    let progress = -1;
    manager = new SpeechModelsManager({ root: modelCache, purgeLegacy: false, onProgress: state => {
      const bucket = Math.floor((state.progress || 0) / 10);
      if (bucket !== progress) { progress = bucket; console.log('MODEL', state.message, state.progress + '%'); }
    } });
    await manager.install(['parakeet']);
    assert(manager.installed('parakeet'));
    const pack = catalog.packs.find(item => item.id === 'parakeet');
    for (const file of pack.files) {
      const filename = path.join(manager.directory('parakeet'), file.path);
      assert.equal(fs.statSync(filename).size, file.size);
      const digest = crypto.createHash('sha256');
      for await (const chunk of fs.createReadStream(filename)) digest.update(chunk);
      assert.equal(digest.digest('hex'), file.sha256, file.path + ' failed full integrity verification');
    }
    report.model = { id: pack.id, revision: pack.revision, files: pack.files.map(({ path: name, size, sha256 }) => ({ name, size, sha256 })) };
    return report.model;
  });
  const fixture = JSON.parse(fs.readFileSync(path.join(ROOT, 'sidecar/qwen-probe-audio.json'), 'utf8'));
  assert.equal(fixture.encoding, 'pcm_s16le');
  assert.equal(fixture.schemaVersion, 1);
  assert.equal(fixture.sampleRate, 16000);
  const pcm = Buffer.from(fixture.pcmBase64, 'base64');
  assert(pcm.length > 0 && pcm.length % 2 === 0);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(fixture.sampleRate, 24); header.writeUInt32LE(fixture.sampleRate * 2, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  const audio = path.join(temporary, 'synthetic-public-fixture.wav');
  fs.writeFileSync(audio, Buffer.concat([header, pcm]));
  report.fixture = { source: fixture.source, expected: fixture.text, seconds: pcm.length / 2 / fixture.sampleRate,
    sha256: crypto.createHash('sha256').update(pcm).digest('hex') };
  let client = sidecar(manager.directory('parakeet'));
  await check('Real offline V3 model load and protocol readiness', async () => assertReady(await client.next()));
  for (const id of ['first', 'repeat']) {
    await check('Real sample transcription: ' + id, async () => {
      const result = await client.request({ id, path: audio, language: 'en', prompt: 'Voxden' });
      assert.equal(result.vocabulary, 'unsupported', 'Parakeet must report vocabulary limitations');
      return assertTranscript(result, fixture.text);
    });
  }
  await check('Unsupported language errors without terminating the sidecar', async () => {
    const result = await client.request({ id: 'unsupported-language', path: audio, language: 'hi' });
    assert.equal(result.ok, false); assert.match(result.error, /does not support this language/i);
    return result.error;
  });
  await check('Missing recording errors without terminating the sidecar', async () => {
    const result = await client.request({ id: 'missing-recording', path: path.join(temporary, 'missing.wav'), language: 'en' });
    assert.equal(result.ok, false); assert(result.error);
    return result.error;
  });
  await check('Real transcription recovers after request errors', async () =>
    assertTranscript(await client.request({ id: 'recovered', path: audio, language: 'en' }), fixture.text));
  await check('Interrupt a sidecar request and restart with the same verified model', async () => {
    // This exercises process interruption/restart, not OS microphone cancellation.
    client.child.stdin.write(JSON.stringify({ id: 'interrupted', path: audio, language: 'en' }) + '\n');
    await client.stop(true);
    client = sidecar(manager.directory('parakeet'));
    assertReady(await client.next());
    const detail = assertTranscript(await client.request({ id: 'restart', path: audio, language: 'en' }), fixture.text);
    assert.equal((await client.stop()).code, 0, 'QUIT must shut down normally');
    return detail;
  });
  await check('Missing model retains Parakeet setup error when fallback is unavailable', async () => {
    client = sidecar(path.join(temporary, 'absent-parakeet'));
    const result = await client.next();
    assert.equal(result.ok, false);
    assert.match(result.error, /Parakeet/i); assert.match(result.error, /setup.*Settings/i);
    assert.notEqual((await client.stop()).code, 0);
    return result.error;
  });
  report.status = 'passed';
}

main().catch(error => {
  report.status = 'failed'; report.error = error.stack || error.message;
  console.error(report.error);
  process.exitCode = 1;
}).finally(async () => {
  manager?.cancel();
  await Promise.all([...clients].map(client => client.stop(true)));
  clearTimeout(watchdog);
  report.finishedAt = new Date().toISOString();
  writeReport();
  // This exact unique path was created above, never supplied by a caller.
  fs.rmSync(temporary, { recursive: true, force: true });
  console.log('PARAKEET INFERENCE', report.status.toUpperCase(), report.checks.filter(item => item.status === 'passed').length + '/' + report.checks.length);
});
