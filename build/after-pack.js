'use strict';

// electron-builder copies extraResources with their source permissions, and the
// 7zip-bin package ships its macOS binary without the execute bit. The packaged
// app would refuse to spawn it, so the bit is set here once per build.
const fs = require('fs');
const path = require('path');

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const app = context.packager.appInfo.productFilename + '.app';
  const sevenZip = path.join(context.appOutDir, app, 'Contents', 'Resources', 'pack-tools', '7za');
  if (!fs.existsSync(sevenZip)) throw new Error('after-pack: ' + sevenZip + ' is missing');
  fs.chmodSync(sevenZip, 0o755);
};
