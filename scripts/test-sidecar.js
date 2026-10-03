'use strict';

// Runs the sidecar's own assertions from `npm test`.
//
// Some rules only exist in Python -- which engine reports a problem, which one
// stays quiet -- and they surface two layers away in the settings hint, where
// they read as UI bugs. Without this they only ran during a runtime build.

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

function candidates() {
  const managed = [
    path.join(os.homedir(), 'AppData', 'Roaming', 'Voxden', 'asr-runtime', 'runtime', 'python.exe'),
    path.join(ROOT, 'models', 'asr-runtime', 'runtime', 'python.exe'),
  ];
  return [
    String(process.env.VOXDEN_PYTHON || '').trim(),
    path.join(ROOT, 'dist-runtime-v3', 'runtime', 'python.exe'),
    ...managed,
    path.join(ROOT, '.venv', 'Scripts', 'python.exe'),
    path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Python', 'Python312', 'python.exe'),
    process.platform === 'win32' ? 'python.exe' : 'python3',
  ].filter(Boolean);
}

function findPython() {
  for (const p of candidates()) {
    if (p === 'python.exe' || p === 'python3') {
      try {
        execFileSync(p, ['--version'], { stdio: 'ignore', windowsHide: true });
        return p;
      } catch (_) {
        continue;
      }
    }
    if (fs.existsSync(p)) return p;
  }
  return null;
}

const python = findPython();
if (!python) {
  // Not a failure: the suite runs on machines that have no Python, and the
  // app is built to work on exactly those.
  console.log('skipped sidecar self-test (no Python found)');
  process.exit(0);
}

const sidecar = path.join(ROOT, 'sidecar', 'transcribe.py');

function checkSignedSidecarUnchanged() {
  for (const isolated of [false, true]) {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'voxden-signed-sidecar-test-'));
    try {
      const files = fs.readdirSync(path.dirname(sidecar), { withFileTypes: true })
        .filter(entry => entry.isFile()).map(entry => entry.name).sort();
      for (const file of files) fs.copyFileSync(path.join(path.dirname(sidecar), file), path.join(fixture, file));
      const env = require('./python-test-env')();
      // The entrypoint itself must protect the signed bundle, including when
      // isolated mode ignores PYTHON* environment settings. Do not mask this
      // regression with -B or an inherited bytecode/cache redirection option.
      delete env.PYTHONDONTWRITEBYTECODE;
      delete env.PYTHONPYCACHEPREFIX;
      const args = [...(isolated ? ['-I'] : []), path.join(fixture, 'transcribe.py'), '--self-test'];
      const out = execFileSync(python, args, { encoding: 'utf8', windowsHide: true, env });
      assert.strictEqual(JSON.parse(out.trim().split('\n').pop()).ok, true);
      assert.deepStrictEqual(fs.readdirSync(fixture).sort(), files,
        'running the sidecar must not add __pycache__ or other files to the signed bundle');
      for (const file of files) {
        assert(fs.readFileSync(path.join(fixture, file)).equals(fs.readFileSync(path.join(path.dirname(sidecar), file))),
          'running the sidecar must preserve bundled file contents: ' + file);
      }
    } finally {
      const resolved = path.resolve(fixture);
      if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('voxden-signed-sidecar-test-')) {
        throw new Error('Refusing to clean a sidecar fixture outside the temporary directory');
      }
      fs.rmSync(resolved, { recursive: true, force: true });
    }
  }
  console.log('ok signed sidecar remains unchanged in normal and isolated Python mode');
}

try {
  checkSignedSidecarUnchanged();
  execFileSync(python, ['-B', path.join(ROOT, 'scripts', 'test-sidecar-models.py')], {
    encoding: 'utf8',
    windowsHide: true,
    env: require('./python-test-env')(),
  });
  console.log('ok managed speech models on macOS/Windows and fallback errors');
  execFileSync(python, ['-B', path.join(ROOT, 'scripts', 'test-sidecar-performance.py')], {
    encoding: 'utf8',
    windowsHide: true,
    env: require('./python-test-env')(),
  });
  console.log('ok sidecar CPU budgets, passive ONNX pools and lazy VAD options');
  const out = execFileSync(python, [sidecar, '--self-test'], {
    encoding: 'utf8',
    windowsHide: true,
    env: require('./python-test-env')(),
  });
  const parsed = JSON.parse(out.trim().split('\n').pop());
  if (!parsed.ok) throw new Error('self-test reported not ok');
  console.log('ok sidecar self-test (' + path.basename(python) + ')');
  console.log('all sidecar tests passed');
} catch (err) {
  const detail = err && err.stderr ? String(err.stderr).trim().split('\n').slice(-3).join('\n  ') : '';
  console.error('FAIL sidecar self-test');
  if (detail) console.error('  ' + detail);
  else console.error('  ' + (err && err.message || err));
  process.exit(1);
}
