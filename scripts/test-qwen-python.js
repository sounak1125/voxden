'use strict';

// Syntax-compile every sidecar Python file and run the sidecar self-test.
// Uses a local interpreter when one exists; never the user's installed app.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SIDECAR_DIR = path.join(ROOT, 'sidecar');

function candidates() {
  return [
    String(process.env.VOXDEN_PYTHON || '').trim(),
    path.join(ROOT, 'dist-runtime-v3', 'runtime', 'python.exe'),
    path.join(ROOT, 'models', 'asr-runtime', 'runtime', 'python.exe'),
    path.join(ROOT, '.venv', 'Scripts', 'python.exe'),
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
  console.log('skipped qwen python compile (no Python found)');
  process.exit(0);
}

const pyFiles = fs.readdirSync(SIDECAR_DIR)
  .filter((name) => name.endsWith('.py'))
  .map((name) => path.join(SIDECAR_DIR, name));
if (!pyFiles.length) throw new Error('no sidecar Python files');

execFileSync(python, ['-m', 'compileall', '-q', SIDECAR_DIR], {
  stdio: 'inherit',
  windowsHide: true,
});
console.log('ok compiled ' + pyFiles.length + ' sidecar Python files');

const out = execFileSync(python, [path.join(SIDECAR_DIR, 'transcribe.py'), '--self-test'], {
  encoding: 'utf8',
  windowsHide: true,
  env: Object.assign({}, process.env, {
    PYTHONUTF8: '1',
    PYTHONIOENCODING: 'utf-8',
    PYTHONNOUSERSITE: '1',
  }),
});
const parsed = JSON.parse(out.trim().split('\n').pop());
if (!parsed.ok) throw new Error('sidecar self-test reported not ok');
console.log('ok Qwen/sidecar self-test (' + python + ')');
console.log('all qwen python checks passed');
