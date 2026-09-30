'use strict';

// Fetch pinned upstream archives. The former transitive 7zip-bin shipped 21.07.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { MINIMUM_MACOS_VERSION, macCompatibilityIssue } = require('../src/mac-compatibility');
const { assertMacBinaryFloor } = require('./mac-binary-compatibility');
const VERSION = '26.03';
const ASSETS = {
  'win32-x64': ['7z2603-extra.7z', '191894e6acb3647ffb69ce630479ff318523b2e2b9890aa7f05c1127c2e59b8f', 'x64/7za.exe'],
  // Upstream's 26.03 Mac executable requires macOS 26. Build the same patched
  // source for our supported OS; never execute that incompatible bootstrap.
  'darwin-arm64': ['7z2603-src.tar.xz', '9cbde5099c6deb73691b0579063da5827522ccbbcba3f0020fd04e8c8c16c0d4', 'CPP/7zip/Bundles/Alone2/b/m_arm64/7zz'],
  'linux-x64': ['7z2603-linux-x64.tar.xz', 'dc99eff5008f1ab79bd7084c68513701547a808a89502bf4133683535ab3c695', '7zzs'],
  'linux-arm64': ['7z2603-linux-arm64.tar.xz', '2389ba20e4d8295e8709c20b6263b69bd1ec4972fe38a04ad7a1badbf595b996', '7zzs'],
};

async function main() {
  if (process.platform === 'darwin') {
    const issue = macCompatibilityIssue();
    if (issue) throw new Error(issue);
  }
  const asset = ASSETS[process.platform + '-' + process.arch];
  if (!asset) throw new Error('No verified extractor for ' + process.platform + '/' + process.arch);
  const [filename, expectedHash, member] = asset;
  const root = path.resolve(__dirname, '..', 'build', 'pack-tools');
  fs.mkdirSync(root, { recursive: true });
  const work = fs.mkdtempSync(path.join(root, 'stage-'));
  try {
    const response = await fetch(`https://github.com/ip7z/7zip/releases/download/${VERSION}/${filename}`, {
      signal: AbortSignal.timeout(120000),
    });
    if (!response.ok) throw new Error('7-Zip download failed: HTTP ' + response.status);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (crypto.createHash('sha256').update(bytes).digest('hex') !== expectedHash) {
      throw new Error('7-Zip archive SHA-256 mismatch; refusing extraction');
    }
    const archive = path.join(work, filename);
    fs.writeFileSync(archive, bytes);
    if (process.platform === 'win32') {
      // Bootstrap handles only this verified upstream archive; it is not shipped.
      const bootstrap = await require('app-builder-lib/out/toolsets/7zip').getPath7za();
      execFileSync(bootstrap, ['x', '-y', '-o' + work, archive], { stdio: 'pipe', windowsHide: true });
    } else {
      execFileSync('tar', ['-xf', archive, '-C', work], { stdio: 'pipe', timeout: 30000 });
    }
    const source = path.join(work, member);
    if (process.platform === 'darwin') {
      const cwd = path.join(work, 'CPP', '7zip', 'Bundles', 'Alone2');
      const args = ['-s', '-j2', '-f', '../../cmpl_mac_arm64.mak', 'MY_ARCH=-arch arm64 -mmacosx-version-min=' + MINIMUM_MACOS_VERSION];
      console.log('Building verified 7-Zip ' + VERSION + ' source for macOS ' + MINIMUM_MACOS_VERSION + ' ARM64');
      execFileSync('make', args, { cwd, stdio: 'inherit', timeout: 600000,
        env: { ...process.env, MACOSX_DEPLOYMENT_TARGET: MINIMUM_MACOS_VERSION } });
      const compatibility = assertMacBinaryFloor(path.dirname(source));
      const reports = path.resolve(__dirname, '..', 'dist-test-report');
      fs.mkdirSync(reports, { recursive: true });
      fs.writeFileSync(path.join(reports, 'mac-pack-tool-compatibility.json'), JSON.stringify({
        version: VERSION, sourceUrl: 'https://github.com/ip7z/7zip/releases/download/' + VERSION + '/' + filename,
        sourceSha256: expectedHash, command: ['make', ...args], ...compatibility,
      }, null, 2) + '\n');
    }
    if (process.platform !== 'win32') fs.chmodSync(source, 0o755);
    const info = execFileSync(source, ['i'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    if (!info.includes(' ' + VERSION + ' ')) throw new Error('Unexpected 7-Zip executable version');
    fs.copyFileSync(source, path.join(root, process.platform === 'win32' ? '7za.exe' : '7za'));
    if (process.platform !== 'win32') fs.chmodSync(path.join(root, '7za'), 0o755);
    console.log('Prepared upstream 7-Zip ' + VERSION + ' for ' + process.platform + '/' + process.arch);
  } finally {
    if (path.dirname(path.resolve(work)) === root && path.basename(work).startsWith('stage-')) {
      fs.rmSync(work, { recursive: true, force: true });
    }
  }
}

function outputPath() {
  return path.resolve(__dirname, '..', 'build', 'pack-tools', process.platform === 'win32' ? '7za.exe' : '7za');
}

// True when a previous run left a working extractor of this exact version.
function preparedVersionPresent() {
  const target = outputPath();
  if (!fs.existsSync(target)) return false;
  try {
    const info = execFileSync(target, ['i'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    return info.includes(' ' + VERSION + ' ');
  } catch (_) { return false; }
}

// The entry point for npm. postinstall runs it with --optional so that npm
// install never fails, and never rebuilds a good extractor: only packaging and
// the source runtime install need it, and they run it strictly (prepare:pack-tools)
// or fail with a missing-file error. VOXDEN_SKIP_PACK_TOOLS=1 skips it outright.
async function ensure({ optional = false, force = false, env = process.env } = {}) {
  if (env.VOXDEN_SKIP_PACK_TOOLS === '1') {
    console.log('Skipping the 7-Zip extractor (VOXDEN_SKIP_PACK_TOOLS=1)');
    return false;
  }
  if (!force && preparedVersionPresent()) {
    console.log('7-Zip ' + VERSION + ' is already prepared for ' + process.platform + '/' + process.arch);
    return false;
  }
  try {
    await main();
    return true;
  } catch (error) {
    if (!optional) throw error;
    console.warn('Could not prepare 7-Zip ' + VERSION + ': ' + (error && error.message ? error.message : error)
      + '. Installing continues. Packaging and installing the speech runtime from source need it: run '
      + '"npm run prepare:pack-tools" once the cause is fixed.');
    return false;
  }
}

if (require.main === module) {
  ensure({ optional: process.argv.includes('--optional'), force: process.argv.includes('--force') })
    .catch(error => { console.error(error); process.exitCode = 1; });
}
module.exports = { main, ensure };
