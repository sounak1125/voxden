'use strict';

// Keep the local service address explicit when restarting a development build.
// The normal start command retains the production default.
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const installed = process.argv.includes('--installed');
const executable = installed
  ? path.join(process.env.LOCALAPPDATA || path.join(require('os').homedir(), 'AppData', 'Local'), 'Programs', 'Voxden', 'Voxden.exe')
  : require('electron');
if (!fs.existsSync(executable)) {
  console.error('Voxden is not installed at:', executable);
  process.exit(1);
}
const child = spawn(executable, installed ? [] : ['.'], {
  cwd: path.join(__dirname, '..'),
  env: {
    ...process.env,
    VOXDEN_ACCOUNT_URL: process.env.VOXDEN_ACCOUNT_URL || 'http://127.0.0.1:8787/v1',
    VOXDEN_LOCAL_PREVIEW: '1',
  },
  stdio: 'inherit',
  windowsHide: true,
});
child.on('error', error => { console.error('Voxden could not start:', error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code || 0; });
