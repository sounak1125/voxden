'use strict';

// One migration for existing installations. Only obsolete files in a managed
// GPU pack's own storage are eligible; model weights and runtime/ never are.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { removeTree } = require('./clean-remove');
const { isInside, readJson, writeJsonAtomic } = require('./release-download');

const CLEANUP_RECEIPT = 'legacy-cleanup-v1.json';
const INSTALL_STATE = 'install-state.json';
const OLD_DIRECTORIES = ['runtime.pending', 'runtime.previous'];

function installationKey(receipt) {
  return crypto.createHash('sha256').update(JSON.stringify({ id: receipt.id,
    kind: receipt.kind, installedAt: receipt.installedAt, proof: receipt.proof })).digest('hex');
}

function childPath(root, name) {
  const target = path.resolve(root, name);
  if (!isInside(root, target) || target === path.resolve(root)) throw new Error('Unsafe cleanup target');
  return target;
}

async function statOrNull(file) {
  try { return await fs.promises.lstat(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function archiveName(name, kind) {
  const stem = 'voxden-qwen-' + kind + '-pack-win-x64';
  return name === stem + '.zip' || new RegExp('^' + stem + '\\.zip\\.part[0-9]+$').test(name)
    || new RegExp('^' + stem + '-compact-v[0-9]+-(core|shared)\\.7z(?:\\.part[0-9]+)?$').test(name);
}

// ctime and birthtime matter on Windows: extraction can preserve an archive's
// old mtime even though an interrupted repair created the file just now.
async function inspectTree(file, cutoff, alive) {
  if (!alive()) throw new Error('Cleanup interrupted');
  const stat = await statOrNull(file);
  if (!stat) return null;
  if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) return { safe: false };
  let safe = [stat.mtimeMs, stat.ctimeMs, stat.birthtimeMs].every(value => Number.isFinite(value) && value <= cutoff);
  if (!safe) return { safe: false };
  let bytes = stat.isFile() ? stat.size : 0;
  let files = stat.isFile() ? 1 : 0;
  const children = [];
  if (stat.isDirectory()) {
    for (const name of (await fs.promises.readdir(file)).sort()) {
      const child = await inspectTree(path.join(file, name), cutoff, alive);
      if (!child) { safe = false; continue; }
      safe = safe && child.safe;
      if (!safe) return { safe: false };
      bytes += child.bytes || 0;
      files += child.files || 0;
      children.push([name, child.fingerprint]);
    }
  }
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify([
    stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs, stat.birthtimeMs, children,
  ])).digest('hex');
  return { safe, bytes, files, fingerprint };
}

async function cleanupLegacyPack({ root, kind, receipt, isCurrent, canContinue = () => true, signal, remove = removeTree }) {
  root = path.resolve(root);
  const alive = () => !signal?.aborted && canContinue();
  const cutoff = Date.parse(receipt.installedAt);
  if (!Number.isFinite(cutoff) || cutoff > Date.now()) return { skipped: 'unknown-install-date' };
  const rootStat = await statOrNull(root);
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) return { skipped: 'linked-storage' };
  const canonicalRoot = await fs.promises.realpath(root);
  const key = installationKey(receipt);
  const markerPath = childPath(root, CLEANUP_RECEIPT);
  const done = await readJson(markerPath);
  if (done?.schemaVersion === 1 && done.installationKey === key) return { skipped: 'already-complete' };
  if (!alive() || !isCurrent()) return { skipped: 'busy' };

  // Future versions record intent before a new download. A failed/cancelled
  // repair stays resumable even when the old installed runtime still works.
  const statePath = childPath(root, INSTALL_STATE);
  if (await statOrNull(statePath)) {
    const state = await readJson(statePath);
    if (state?.schemaVersion !== 1 || state.status !== 'complete' || state.id !== receipt.id) {
      return { skipped: 'resumable-install' };
    }
  }

  const candidates = [];
  const kept = [];
  let resumable = false;
  const downloads = childPath(root, 'downloads');
  const downloadStat = await statOrNull(downloads);
  if (downloadStat) {
    if (!downloadStat.isDirectory() || downloadStat.isSymbolicLink()) return { skipped: 'unsafe-downloads' };
    for (const name of await fs.promises.readdir(downloads)) {
      // Partial data and range maps always remain available for Resume.
      if (!archiveName(name, kind)) {
        resumable = true;
        kept.push('downloads/' + name);
        continue;
      }
      const relative = 'downloads/' + name;
      const item = await inspectTree(childPath(root, relative), cutoff, alive);
      if (!item?.safe || !(await fs.promises.lstat(childPath(root, relative))).isFile()) resumable = true;
      candidates.push({ relative, item });
    }
  }
  if (resumable) return { skipped: 'resumable-files', kept };
  const directories = [];
  for (const relative of OLD_DIRECTORIES) {
    const item = await inspectTree(childPath(root, relative), cutoff, alive);
    if (!item) continue;
    if (!item.safe) resumable = true;
    directories.push({ relative, item });
  }
  // Older releases have no install journal. Any newer/partial/unrecognised
  // leftover makes the whole group ambiguous, so keep it together for repair.
  if (resumable) return { skipped: 'resumable-files', kept };
  candidates.push(...directories);

  let removedBytes = 0;
  let removedFiles = 0;
  const removed = [];
  for (const candidate of candidates) {
    if (!alive() || !isCurrent() || await fs.promises.realpath(root) !== canonicalRoot) return { skipped: 'changed', removedBytes };
    const target = childPath(root, candidate.relative);
    // A changed file is left alone. The manager also serializes this migration
    // against installation/removal, including while directory deletion runs.
    const fresh = await inspectTree(target, cutoff, alive);
    if (!fresh?.safe || fresh.fingerprint !== candidate.item.fingerprint) return { skipped: 'changed', removedBytes };
    if (await remove(target)) {
      removedBytes += fresh.bytes;
      removedFiles += fresh.files;
      removed.push(candidate.relative);
    }
  }
  if (!alive() || !isCurrent()) return { skipped: 'interrupted', removedBytes };
  const result = { schemaVersion: 1, id: receipt.id, kind, installationKey: key,
    completedAt: new Date().toISOString(), removedBytes, removedFiles, removed };
  await writeJsonAtomic(markerPath, result);
  return result;
}

module.exports = { CLEANUP_RECEIPT, INSTALL_STATE, installationKey, cleanupLegacyPack };
