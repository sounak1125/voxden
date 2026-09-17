'use strict';

// electron-builder copies extraResources with their source permissions, and the
// 7zip-bin package ships its macOS binary without the execute bit. The packaged
// app would refuse to spawn it, so the bit is set here once per build.
const fs = require('fs');
const path = require('path');

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const app = context.packager.appInfo.productFilename + '.app';
  const resources = path.join(context.appOutDir, app, 'Contents', 'Resources');
  for (const file of [path.join(resources, 'pack-tools', '7za'), path.join(resources, 'helper', 'voxden-helper')]) {
    if (!fs.existsSync(file)) throw new Error('after-pack: ' + file + ' is missing');
    fs.chmodSync(file, 0o755);
  }
};
