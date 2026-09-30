'use strict';

// electron-builder copies extraResources with their source permissions. A
// copied archive tool may have lost its macOS execute bit. The packaged
// app would refuse to spawn it, so the bit is set here once per build.
//
// The bundle is then signed ad hoc. electron-builder 25 only signs with a real
// identity: with CSC_IDENTITY_AUTO_DISCOVERY=false and none configured it logs
// "skipped macOS application code signing" and leaves the signature Electron
// shipped with, which the rebranding (renamed executable, rewritten
// Info.plist, added resources) has already broken. Apple Silicon will not run
// arm64 code whose signature does not verify, and Gatekeeper calls a download
// in that state "damaged" with no way past it. An ad-hoc signature is valid,
// just not tied to a developer, so the app gets the ordinary unidentified
// developer path instead (Privacy & Security > Open Anyway). This runs in
// afterPack because the zip and dmg targets are built from this bundle after
// the hook returns. A real identity (CSC_LINK or CSC_NAME) skips it and lets
// electron-builder sign.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { assertMacBinaryFloor } = require('../scripts/mac-binary-compatibility');

const ENTITLEMENTS = path.join(__dirname, 'entitlements.mac.plist');

function codesign(args) {
  execFileSync('codesign', args, { stdio: 'inherit' });
}

function signAdHoc(appPath, binaries, log = console.log) {
  // Mach-O files under Resources are not code locations --deep walks, so each
  // gets its own signature first; the bundle seal then covers them as files.
  for (const file of binaries) codesign(['--force', '--sign', '-', '--timestamp=none', file]);
  codesign([
    '--force', '--deep', '--sign', '-', '--timestamp=none',
    '--options', 'runtime',
    '--entitlements', ENTITLEMENTS,
    appPath,
  ]);
  codesign(['--verify', '--deep', '--strict', '--verbose=2', appPath]);
  log('after-pack: signed ad hoc and verified ' + appPath);
}

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const app = context.packager.appInfo.productFilename + '.app';
  const appPath = path.join(context.appOutDir, app);
  const resources = path.join(appPath, 'Contents', 'Resources');
  const binaries = [path.join(resources, 'pack-tools', '7za'), path.join(resources, 'helper', 'voxden-helper')];
  for (const file of binaries) {
    if (!fs.existsSync(file)) throw new Error('after-pack: ' + file + ' is missing');
    fs.chmodSync(file, 0o755);
  }
  const compatibility = assertMacBinaryFloor(appPath);
  const reports = path.join(__dirname, '..', 'dist-test-report');
  fs.mkdirSync(reports, { recursive: true });
  fs.writeFileSync(path.join(reports, 'mac-packaged-native-compatibility.json'), JSON.stringify(compatibility, null, 2) + '\n');
  console.log('after-pack: verified ' + compatibility.checkedBinaries + ' ARM64 native binaries support macOS ' + compatibility.minimumSystemVersion);
  if (process.env.CSC_LINK || process.env.CSC_NAME) {
    console.log('after-pack: a signing identity is configured, leaving the signature to electron-builder');
    return;
  }
  if (process.platform !== 'darwin') throw new Error('after-pack: an ad-hoc signature needs codesign, which only exists on macOS');
  signAdHoc(appPath, binaries);
};

module.exports.signAdHoc = signAdHoc;
module.exports.ENTITLEMENTS = ENTITLEMENTS;
