'use strict';

// The extractor is shipped with Voxden. Never look for a user's 7-Zip install.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { safeEntryPath } = require('./zip');
const { ReleaseError, DownloadCancelledError } = require('./release-download');

function archivePath(root, name) {
  const normalized = String(name || '').replace(/\\/g, '/');
  if (/[\x00-\x1f<>:"|?*]/.test(normalized)
      || normalized.split('/').some(p => (/[. ]$/.test(p) && p !== '.')
        || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) {
    throw new ReleaseError('The GPU archive contains an unsafe file name.', 'INVALID_ARCHIVE');
  }
  return safeEntryPath(root, normalized);
}

function runSevenZip(executable, args, options = {}) {
  if (!executable || !fs.existsSync(executable)) {
    return Promise.reject(new ReleaseError('Voxden’s archive extractor is missing. Reinstall Voxden to repair it.', 'EXTRACTOR_MISSING'));
  }
  return new Promise((resolve, reject) => {
    execFile(executable, args, {
      windowsHide: true, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
      cwd: options.cwd, signal: options.signal,
    }, (err, stdout, stderr) => {
      if (options.signal?.aborted || err?.name === 'AbortError') {
        reject(new DownloadCancelledError('GPU support'));
      } else if (err) {
        reject(new ReleaseError('The GPU archive could not be unpacked: '
          + String(stderr || err.message).slice(-500), 'INVALID_ARCHIVE'));
      } else resolve(stdout);
    });
  });
}

function validateListing(listing, destination) {
  const names = new Set();
  for (const block of listing.trim().split(/\r?\n\s*\r?\n/)) {
    const fields = {};
    for (const line of block.split(/\r?\n/)) {
      const at = line.indexOf(' = ');
      if (at > 0) fields[line.slice(0, at)] = line.slice(at + 3);
    }
    if (!fields.Path) throw new ReleaseError('The GPU archive listing is incomplete.', 'INVALID_ARCHIVE');
    const target = archivePath(destination, fields.Path);
    const key = target.toLowerCase();
    if (names.has(key) || target === path.resolve(destination)
        || fields['Symbolic Link'] || fields['Hard Link']
        || fields['Alternate Stream'] === '+' || /[lL]/.test(fields.Attributes || '')) {
      throw new ReleaseError('The GPU archive contains duplicate paths or links.', 'INVALID_ARCHIVE');
    }
    names.add(key);
  }
  return names.size;
}

async function extractSevenZip(executable, archive, destination, options = {}) {
  const listing = await runSevenZip(executable,
    ['l', '-slt', '-ba', '-sccUTF-8', '--', path.resolve(archive)], options);
  validateListing(listing, destination);
  await fs.promises.mkdir(destination, { recursive: true });
  await runSevenZip(executable,
    ['x', '-y', '-bsp0', '-sccUTF-8', '-o' + path.resolve(destination), '--', path.resolve(archive)], options);
}

module.exports = { archivePath, runSevenZip, validateListing, extractSevenZip };
