'use strict';

// Repackage the existing, pinned runtime byte-for-byte. No pip, dependency
// upgrades, model conversion, or changes to the legacy release assets.
const fs = require('fs');
const path = require('path');
const { extractZip } = require('../src/zip');
const { runSevenZip, extractSevenZip, archivePath } = require('../src/seven-zip');
const { sha256File, isInside } = require('../src/release-download');
const { INVENTORY, verifyFiles } = require('../src/qwen-pack-files');
const catalog = require('../src/qwen-accel-catalog.json');

const ROOT = path.resolve(__dirname, '..');
const PART_BYTES = 1800000000;
const arg = (name, fallback) => {
  const at = process.argv.indexOf('--' + name);
  return at < 0 ? fallback : process.argv[at + 1];
};

async function removeChild(parent, child) {
  if (!isInside(parent, child) || path.resolve(parent) === path.resolve(child)) throw new Error('Unsafe build path');
  await fs.promises.rm(child, { recursive: true, force: true });
}

async function listFiles(root, prefix = '') {
  const result = [];
  for (const entry of await fs.promises.readdir(path.join(root, prefix), { withFileTypes: true })) {
    const name = prefix ? prefix + '/' + entry.name : entry.name;
    if (entry.isSymbolicLink()) throw new Error('Runtime contains a link: ' + name);
    if (entry.isDirectory()) result.push(...await listFiles(root, name));
    else if (entry.isFile()) result.push(name);
  }
  return result.sort();
}

async function describeArchive(file) {
  const size = (await fs.promises.stat(file)).size;
  const sha256 = await sha256File(file);
  const description = { asset: path.basename(file), size, sha256, format: '7z', parts: [] };
  if (size <= PART_BYTES) {
    description.parts.push({ asset: description.asset, size, sha256 });
    return description;
  }
  const input = await fs.promises.open(file, 'r');
  const buffer = Buffer.alloc(8 * 1024 * 1024);
  try {
    let position = 0;
    while (position < size) {
      const part = file + '.part' + String(description.parts.length + 1).padStart(2, '0');
      const output = await fs.promises.open(part, 'w');
      let written = 0;
      try {
        while (written < PART_BYTES && position < size) {
          const { bytesRead } = await input.read(buffer, 0, Math.min(buffer.length, PART_BYTES - written, size - position), position);
          if (!bytesRead) throw new Error('Archive truncated during splitting');
          let offset = 0;
          while (offset < bytesRead) {
            const result = await output.write(buffer, offset, bytesRead - offset);
            if (!result.bytesWritten) throw new Error('Archive part could not be written');
            offset += result.bytesWritten;
          }
          written += bytesRead;
          position += bytesRead;
        }
      } finally { await output.close(); }
      description.parts.push({ asset: path.basename(part), size: written, sha256: await sha256File(part) });
    }
  } finally { await input.close(); }
  return description;
}

async function main() {
  const kind = arg('kind', 'cuda');
  const spec = catalog[kind];
  if (!['cuda', 'rocm'].includes(kind)) throw new Error('Pass --kind cuda or --kind rocm');
  const out = path.resolve(arg('out', 'dist-qwen-' + kind + '-pack'));
  const executable = path.join(ROOT, 'node_modules/7zip-bin/win/x64/7za.exe');
  const work = path.join(out, 'compact-work');
  const source = path.join(work, 'source');
  const base = path.join(work, 'base');
  const rebuilt = path.join(work, 'verified-runtime');
  const legacyArchive = path.join(out, spec.asset);
  const baseArchive = path.join(ROOT, 'dist-runtime-v3/voxden-asr-runtime-win-x64.zip');
  const baseManifest = JSON.parse(await fs.promises.readFile(path.join(ROOT, 'dist-runtime-v3/voxden-asr-runtime.json'), 'utf8'));
  const manifest = JSON.parse(await fs.promises.readFile(path.join(out, spec.manifest), 'utf8'));
  console.log('Verifying original ' + kind + ' and CPU archives...');
  if (manifest.pack.id !== spec.id || manifest.pack.sha256 !== spec.sha256
      || await sha256File(legacyArchive) !== spec.sha256
      || await sha256File(baseArchive) !== baseManifest.runtime.sha256) {
    throw new Error('The input archives do not match their pinned manifests.');
  }
  // Some upstream archives contain Linux-only file names, even when labelled
  // Windows. Never silently rename/drop those files to get a smaller pack.
  const listing = await runSevenZip(executable, ['l', '-slt', '-ba', '-sccUTF-8', '--', legacyArchive]);
  for (const line of listing.split(/\r?\n/).filter(line => line.startsWith('Path = '))) {
    try { archivePath(source, line.slice(7)); }
    catch (error) { throw new Error('The original ' + kind + ' pack cannot be reproduced on Windows: '
      + line.slice(7) + '. Rebuild and validate the original pack before compacting it. ' + error.message); }
  }
  await removeChild(out, work);
  await fs.promises.mkdir(work, { recursive: true });
  await extractZip(legacyArchive, source);
  await extractZip(baseArchive, base);
  console.log('Comparing every runtime file by SHA-256...');
  const files = [];
  for (const name of await listFiles(source)) {
    const file = path.join(source, name);
    const size = (await fs.promises.stat(file)).size;
    const sha256 = await sha256File(file);
    let shared = false;
    try {
      const other = path.join(base, name);
      shared = (await fs.promises.stat(other)).size === size && await sha256File(other) === sha256;
    } catch (err) { if (err.code !== 'ENOENT') throw err; }
    files.push({ path: name, size, sha256, shared });
  }
  const inventory = { schemaVersion: 1, id: spec.id, baseRuntimeId: baseManifest.runtime.id, files };
  await fs.promises.writeFile(path.join(source, INVENTORY), JSON.stringify(inventory));
  const inventorySha256 = await sha256File(path.join(source, INVENTORY));
  const stem = 'voxden-qwen-' + kind + '-pack-win-x64-compact-v1';
  const level = arg('level', '5');
  if (!/^[0-9]$/.test(level)) throw new Error('Invalid compression level');
  const descriptions = {};
  for (const group of ['core', 'shared']) {
    const selected = files.filter(f => f.shared === (group === 'shared')).map(f => f.path);
    if (group === 'core') selected.push(INVENTORY);
    const list = path.join(work, group + '.txt');
    await fs.promises.writeFile(list, selected.join('\n') + '\n');
    const archive = path.join(out, stem + '-' + group + '.7z');
    await fs.promises.rm(archive, { force: true });
    console.log('Compressing ' + group + ' (' + selected.length + ' files), losslessly...');
    await runSevenZip(executable, ['a', '-t7z', '-mx=' + level, '-md=32m', '-mmt=4', '-ms=128m',
      '-scsUTF-8', '-sccUTF-8', archive, '@' + list], { cwd: source });
    descriptions[group] = await describeArchive(archive);
    console.log(group + ': ' + (descriptions[group].size / 1e6).toFixed(1) + ' MB');
    await extractSevenZip(executable, archive, rebuilt);
  }
  console.log('Verifying every reconstructed byte against the original runtime...');
  await verifyFiles(files, rebuilt);
  const optimized = {
    schemaVersion: 1, id: spec.id, inventorySha256, ...descriptions,
    files: files.length, sharedFiles: files.filter(f => f.shared).length,
    installedBytes: files.reduce((sum, file) => sum + file.size, 0),
    baseRuntimeId: baseManifest.runtime.id,
    completeDownloadBytes: descriptions.core.size + descriptions.shared.size,
  };
  // Old clients continue using pack.asset / pack.parts. New clients opt in only
  // once all compact assets are present, so partially uploaded releases work.
  manifest.pack.optimized = optimized;
  await fs.promises.writeFile(path.join(out, spec.manifest), JSON.stringify(manifest, null, 2) + '\n');
  await fs.promises.writeFile(path.join(out, 'compact-report.json'), JSON.stringify({
    kind, legacyDownloadBytes: manifest.pack.size, ...optimized,
    allFilesVerified: true, modelChanged: false, runtime: rebuilt,
  }, null, 2) + '\n');
  console.log('Verified compact ' + kind + ' pack. Complete fallback download: '
    + (optimized.completeDownloadBytes / 1e9).toFixed(3) + ' GB; reusing CPU files: '
    + (optimized.core.size / 1e9).toFixed(3) + ' GB.');
  console.log('Runtime for hardware tests: ' + rebuilt);
}

if (require.main === module) main().catch(err => { console.error(err); process.exitCode = 1; });
module.exports = { listFiles, describeArchive };
