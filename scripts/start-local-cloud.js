'use strict';

// Keep the local service address explicit when restarting a development build.
// The normal start command retains the production default.
const { spawn } = require('child_process');
const path = require('path');

const child = spawn(require('electron'), ['.'], {
  cwd: path.join(__dirname, '..'),
  env: { ...process.env, VOXDEN_ACCOUNT_URL: process.env.VOXDEN_ACCOUNT_URL || 'http://127.0.0.1:8787/v1' },
  stdio: 'inherit',
  windowsHide: true,
});
child.on('error', error => { console.error('Voxden could not start:', error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code || 0; });
