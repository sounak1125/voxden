'use strict';

// Strictly identify a newly built installer and the code/resources beside it.
// Unlike smoke checks, a stale package must fail this comparison.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const asar = require('@electron/asar');
const { sha256File } = require('../src/release-download');
const root = path.resolve(__dirname, '..');
const output = path.resolve(process.argv[2] || path.join(root, 'dist'));
const resources = path.join(output, 'win-unpacked', 'resources');
const archive = path.join(resources, 'app.asar');
const pkg = require('../package.json');
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function files(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    if (entry.name === '__pycache__' || entry.name.endsWith('.pyc')) return [];
    const name = path.join(dir, entry.name);
    return entry.isDirectory() ? files(name) : [name];
  });
}
async function main() {
  const built = JSON.parse(asar.extractFile(archive, 'package.json').toString('utf8'));
  assert.strictEqual(built.version, pkg.version, 'built version differs from source');
  assert.strictEqual(built.buildId, pkg.buildId, 'built identifier differs from source');
  let sourceFiles = 0;
  for (const file of files(path.join(root, 'src'))) {
    const relative = path.relative(root, file).replace(/\\/g, '/');
    assert.strictEqual(digest(asar.extractFile(archive, relative)), digest(fs.readFileSync(file)), relative + ' is stale in app.asar');
    sourceFiles++;
  }
  let sidecarFiles = 0;
  for (const file of files(path.join(root, 'sidecar'))) {
    const relative = path.relative(root, file);
    assert.strictEqual(await sha256File(path.join(resources, relative)), await sha256File(file), relative + ' is stale in resources');
    sidecarFiles++;
  }
  for (const relative of ['scripts/win32.ps1', 'scripts/correction-watch.ps1', 'scripts/vocabulary-seed.json']) {
    assert.strictEqual(await sha256File(path.join(resources, relative)), await sha256File(path.join(root, relative)), relative + ' is stale in resources');
  }
  const manifestPath = path.join(resources, 'speech-runtime', 'voxden-asr-runtime.json');
  assert.strictEqual(await sha256File(manifestPath), await sha256File(path.join(root, 'dist-runtime-v3/voxden-asr-runtime.json')));
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const runtimePath = path.join(resources, 'speech-runtime', 'voxden-asr-runtime-win-x64.zip');
  assert.strictEqual(fs.statSync(runtimePath).size, manifest.runtime.size);
  assert.strictEqual(await sha256File(runtimePath), manifest.runtime.sha256, 'bundled runtime hash mismatch');
  const highlights = require('../src/announcements').CATALOG.filter(row => row.since === pkg.version);
  const installer = path.join(output, 'Voxden-Setup-' + pkg.version + '.exe');
  const report = {
    version: built.version, buildId: built.buildId, sourceFiles, sidecarFiles,
    releaseHighlights: highlights.map(row => ({ id: row.id, title: row.title })),
    runtimeId: manifest.runtime.id, installer, installerBytes: fs.statSync(installer).size,
    installerSha256: await sha256File(installer), appAsarSha256: await sha256File(archive),
  };
  fs.writeFileSync(path.join(output, 'verification.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
