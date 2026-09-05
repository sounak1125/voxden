'use strict';

const fs = require('fs');
const path = require('path');
const { archivePath } = require('./seven-zip');
const { sha256File, normalizeSha256, ReleaseError, DownloadCancelledError } = require('./release-download');

const INVENTORY = 'voxden-pack-files.json';

function checkCancelled(signal) {
  if (signal?.aborted) throw new DownloadCancelledError('GPU support');
}

function validateInventory(value, root, id) {
  if (value?.schemaVersion !== 1 || value.id !== id
      || !Array.isArray(value.files) || !value.files.length || value.files.length > 100000) {
    throw new ReleaseError('The GPU file inventory is invalid.', 'INVALID_MANIFEST');
  }
  const names = new Set();
  for (const file of value.files) {
    if (typeof file.path !== 'string' || file.path.includes('\\')
        || file.path === INVENTORY || !Number.isSafeInteger(file.size) || file.size < 0
        || !normalizeSha256(file.sha256) || typeof file.shared !== 'boolean') {
      throw new ReleaseError('The GPU file inventory contains an invalid entry.', 'INVALID_MANIFEST');
    }
    const key = archivePath(root, file.path).toLowerCase();
    if (names.has(key) || key === path.resolve(root).toLowerCase()) {
      throw new ReleaseError('The GPU file inventory contains duplicate paths.', 'INVALID_MANIFEST');
    }
    names.add(key);
  }
  return value.files;
}

// Refuse symlinks/junctions in both the reused runtime and the reconstructed one.
async function regularFile(root, name) {
  const target = archivePath(root, name);
  let current = path.resolve(root);
  for (const segment of ['', ...path.relative(current, target).split(path.sep)]) {
    if (segment) current = path.join(current, segment);
    const stat = await fs.promises.lstat(current);
    if (stat.isSymbolicLink()) throw new Error('linked runtime path');
  }
  const stat = await fs.promises.stat(target);
  return stat.isFile() ? { target, stat } : null;
}

async function matchesFile(root, file, signal) {
  checkCancelled(signal);
  try {
    const item = await regularFile(root, file.path);
    if (!item || item.stat.size !== file.size) return false;
    return await sha256File(item.target) === file.sha256;
  } catch (err) {
    checkCancelled(signal);
    if (err?.code === 'CANCELLED') throw err;
    return false;
  }
}

async function reuseFiles(files, source, destination, signal) {
  const missing = [];
  for (const file of files.filter(f => f.shared)) {
    checkCancelled(signal);
    if (!source || !await matchesFile(source, file, signal)) {
      missing.push(file.path);
      continue;
    }
    const target = archivePath(destination, file.path);
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    try {
      // Independent copies: deleting/updating CPU support cannot break GPU support.
      await fs.promises.copyFile(archivePath(source, file.path), target);
      // The source can change while setup is running. The fallback archive
      // repairs changed copies as well as missing files, without user action.
      if (!await matchesFile(destination, file, signal)) missing.push(file.path);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      missing.push(file.path);
    }
  }
  return missing;
}

async function verifyFiles(files, root, signal) {
  const expected = new Set(files.map(file => file.path.toLowerCase()));
  expected.add(INVENTORY);
  async function checkTree(relative = '') {
    checkCancelled(signal);
    for (const entry of await fs.promises.readdir(path.join(root, relative), { withFileTypes: true })) {
      const name = relative ? relative + '/' + entry.name : entry.name;
      if (entry.isSymbolicLink() || (!entry.isDirectory() && !expected.has(name.toLowerCase()))) {
        throw new ReleaseError('The GPU support archive contains unexpected files or links.', 'PACK_INCOMPLETE');
      }
      if (entry.isDirectory()) await checkTree(name);
    }
  }
  await checkTree();
  for (const file of files) {
    if (!await matchesFile(root, file, signal)) {
      throw new ReleaseError('The GPU support files are incomplete or damaged (' + file.path
        + '). Retry the download to repair them.', 'PACK_INCOMPLETE');
    }
  }
  checkCancelled(signal);
}

module.exports = { INVENTORY, checkCancelled, validateInventory, matchesFile, reuseFiles, verifyFiles };
