'use strict';

// One validator for export, training and evaluation. No Electron imports.
// Set VOXDEN_TRAINING_PYTHON to select an isolated training environment.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const root = path.resolve(__dirname, '..');
const candidates = process.env.VOXDEN_TRAINING_PYTHON
  ? [process.env.VOXDEN_TRAINING_PYTHON]
  : [path.join(root, 'training', 'work', 'venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'),
    path.join(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'),
    process.platform === 'win32' ? 'python' : 'python3'];
const python = candidates.find((name) => fs.existsSync(name) || !path.isAbsolute(name));
if (!python) {
  console.error('Python 3.11+ is required. Set VOXDEN_TRAINING_PYTHON to its executable.');
  process.exit(1);
}
const result = spawnSync(python, [path.join(root, 'training', 'dataset.py'), ...process.argv.slice(2)], {
  stdio: 'inherit', windowsHide: true, env: { ...process.env, PYTHONUTF8: '1' },
});
if (result.error) console.error('Cannot start Python: ' + result.error.message);
process.exit(result.status === null ? 1 : result.status);
