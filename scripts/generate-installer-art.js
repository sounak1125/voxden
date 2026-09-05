'use strict';

// NSIS is built on Windows. Use its bundled drawing API to composite the actual
// app icon. Lettering stays in native NSIS controls so it scales with the display.
const path = require('path');
const { spawnSync } = require('child_process');

if (process.platform !== 'win32') {
  throw new Error('Prepare the Windows installer artwork on Windows.');
}

const result = spawnSync('powershell.exe', [
  '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
  '-File', path.join(__dirname, 'generate-installer-art.ps1'),
], { stdio: 'inherit', windowsHide: true });

if (result.error) throw result.error;
process.exitCode = result.status === null ? 1 : result.status;
