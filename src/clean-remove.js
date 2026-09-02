'use strict';

// Taking a model, runtime or pack off the disk.
//
// A plain recursive rm has two failure modes on Windows that both look like
// Voxden hanging. A file the speech process still has open makes the delete
// fail part way, leaving a directory that is neither installed nor gone; and a
// large tree (the runtime is 33,000 files) takes long enough that the store is
// read mid-delete and reports a half-present install. So the tree is renamed
// out of the way first, which is atomic and instant: from that moment the
// store sees nothing installed, and the slow delete works on a name nothing
// else will open. Callers stop the processes that hold the files before
// calling in; the retries here cover a handle that is still closing.
//
// A delete that still fails, or that the app quits in the middle of, leaves a
// directory with REMOVING in its name. sweepRemoved() finishes those on the
// next launch, so a failed removal costs a restart rather than disk space.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REMOVING = '.removing-';
const RM_OPTIONS = { recursive: true, force: true, maxRetries: 10, retryDelay: 200 };

function isRemovingLeftover(name) {
  return String(name || '').includes(REMOVING);
}

async function removeTree(target) {
  if (!target) return false;
  const resolved = path.resolve(target);
  let stat;
  try {
    stat = await fs.promises.lstat(resolved);
  } catch (err) {
    if (err && err.code === 'ENOENT') return false;
    throw err;
  }
  let victim = resolved;
  if (stat.isDirectory()) {
    const aside = resolved + REMOVING + crypto.randomBytes(4).toString('hex');
    try {
      await fs.promises.rename(resolved, aside);
      victim = aside;
    } catch (_) {
      // An open file inside refuses the rename on Windows. Delete in place;
      // the retries below wait for the handle to close.
    }
  }
  await fs.promises.rm(victim, RM_OPTIONS);
  return true;
}

async function sweepRemoved(root) {
  const entries = await fs.promises.readdir(root, { withFileTypes: true }).catch(() => []);
  const swept = [];
  for (const entry of entries) {
    if (!isRemovingLeftover(entry.name)) continue;
    const leftover = path.join(root, entry.name);
    try {
      await fs.promises.rm(leftover, { ...RM_OPTIONS, maxRetries: 3 });
      swept.push(leftover);
    } catch (_) {
      // Still held open by something. The next launch tries again.
    }
  }
  return swept;
}

module.exports = { removeTree, sweepRemoved, isRemovingLeftover, REMOVING };
