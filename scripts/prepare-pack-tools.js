'use strict';

// Fetch pinned upstream archives. The former transitive 7zip-bin shipped 21.07.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const VERSION = '26.03';
const ASSETS = {
  'win32-x64': ['7z2603-extra.7z', '191894e6acb3647ffb69ce630479ff318523b2e2b9890aa7f05c1127c2e59b8f', 'x64/7za.exe'],
  'darwin-arm64': ['7z2603-mac.tar.xz', '5ca87677072c59f5602e5c49baa27d4694bacd2259b4e507f0094249d4281480', '7zz'],
  'darwin-x64': ['7z2603-mac.tar.xz', '5ca87677072c59f5602e5c49baa27d4694bacd2259b4e507f0094249d4281480', '7zz'],
  'linux-x64': ['7z2603-linux-x64.tar.xz', 'dc99eff5008f1ab79bd7084c68513701547a808a89502bf4133683535ab3c695', '7zzs'],
  'linux-arm64': ['7z2603-linux-arm64.tar.xz', '2389ba20e4d8295e8709c20b6263b69bd1ec4972fe38a04ad7a1badbf595b996', '7zzs'],
};

async function main() {
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
      execFileSync('tar', ['-xf', archive, '-C', work], { stdio: 'pipe' });
    }
    const source = path.join(work, member);
    if (process.platform !== 'win32') fs.chmodSync(source, 0o755);
    const info = execFileSync(source, ['i'], { encoding: 'utf8', windowsHide: true });
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

if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { main };
