'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// Self-tests must never inspect or download into the user's real model cache.
module.exports = function pythonTestEnv() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voxden-python-test-'));
  process.once('exit', () => {
    if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('voxden-python-test-')) return;
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    ...process.env,
    HF_HOME: root, VOXDEN_MODEL_DIR: root, VOXDEN_OFFLINE: '1',
    HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1',
    PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', PYTHONNOUSERSITE: '1',
  };
};
