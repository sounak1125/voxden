'use strict';

const os = require('os');
const MINIMUM_MACOS_VERSION = '14.0';
const MINIMUM_DARWIN_MAJOR = 23; // Sonoma 14 uses Darwin 23; Ventura 13 uses 22.

function macCompatibilityIssue({ platform = process.platform, arch = process.arch, darwinRelease = os.release() } = {}) {
  if (platform !== 'darwin') return '';
  if (arch !== 'arm64') return 'Voxden requires an Apple silicon Mac (M1 or later) running macOS 14 or later. Intel Macs are not supported.';
  const match = /^(\d+)\./.exec(String(darwinRelease));
  if (match && Number(match[1]) >= MINIMUM_DARWIN_MAJOR) return '';
  const major = match ? Number(match[1]) : null;
  const detected = major >= 20 && major <= 22 ? ' Detected macOS ' + (major - 9) + '.' : '';
  return 'Voxden requires macOS 14 (Sonoma) or later on Apple silicon.' + detected
    + ' Update macOS in System Settings > General > Software Update, then reopen Voxden.';
}

function checkMacStartup(app, dialog, system) {
  const issue = macCompatibilityIssue(system);
  if (!issue) return true;
  dialog.showErrorBox('This Mac cannot run Voxden', issue);
  app.quit();
  return false;
}

module.exports = { MINIMUM_MACOS_VERSION, MINIMUM_DARWIN_MAJOR, macCompatibilityIssue, checkMacStartup };
