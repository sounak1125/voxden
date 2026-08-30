'use strict';

// Runs the sidecar's own assertions from `npm test`.
//
// Some rules only exist in Python -- which engine reports a problem, which one
// stays quiet -- and they surface two layers away in the settings hint, where
// they read as UI bugs. Without this they only ran during a runtime build.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

function candidates() {
  const managed = [
    path.join(os.homedir(), 'AppData', 'Roaming', 'Voxden', 'asr-runtime', 'runtime', 'python.exe'),
    path.join(ROOT, 'models', 'asr-runtime', 'runtime', 'python.exe'),
  ];
  return [
    String(process.env.VOXDEN_PYTHON || '').trim(),
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
try {
  const out = execFileSync(python, [sidecar, '--self-test'], {
    encoding: 'utf8',
    windowsHide: true,
    env: Object.assign({}, process.env, { PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }),
  });
  const parsed = JSON.parse(out.trim().split('\n').pop());
  if (!parsed.ok) throw new Error('self-test reported not ok');
  console.log('ok sidecar self-test (' + path.basename(python) + ')');
  console.log('all sidecar tests passed');
} catch (err) {
  const detail = err && err.stderr ? String(err.stderr).trim().split('\n').slice(-3).join('\n  ') : '';
  console.error('FAIL sidecar self-test');
  if (detail) console.error('  ' + detail);
  process.exit(1);
}
