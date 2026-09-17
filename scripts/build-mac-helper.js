'use strict';

// Compiles helper/mac/main.swift into build/mac-helper/voxden-helper with the
// command line tools' swiftc; no Xcode project. The binary is packaged by
// build.mac.extraResources and started by main.js on macOS the way
// win32.ps1 is on Windows. Off macOS there is nothing to build.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SOURCE = path.join(ROOT, 'helper', 'mac', 'main.swift');
const OUT_DIR = path.join(ROOT, 'build', 'mac-helper');
const OUT = path.join(OUT_DIR, 'voxden-helper');

function buildMacHelper({ quiet = false } = {}) {
  if (process.platform !== 'darwin') {
    if (!quiet) console.log('skipped mac helper build (not macOS)');
    return null;
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const result = spawnSync('swiftc', [
    '-O',
    '-target', 'arm64-apple-macos12.0',
    '-o', OUT,
    SOURCE,
  ], { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('swiftc exited with ' + result.status);
  fs.chmodSync(OUT, 0o755);
  if (!quiet) console.log('built ' + path.relative(ROOT, OUT));
  return OUT;
}

module.exports = { buildMacHelper, OUT, SOURCE };

if (require.main === module) buildMacHelper();
