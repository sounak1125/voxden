'use strict';

// Contract checks that do not need a built installer, plus packaged-artifact
// checks when dist/win-unpacked exists. VOXDEN_BUILD_OUTPUT selects a required
// build output directory (relative to the repo root, or absolute).
// Never installs the app. Never touches
// the user's development or installed data profiles.

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUTPUT_OVERRIDE = process.env.VOXDEN_BUILD_OUTPUT;
const REQUIRE_PACKAGED = OUTPUT_OVERRIDE !== undefined;
assert.ok(!REQUIRE_PACKAGED || OUTPUT_OVERRIDE.trim(), 'VOXDEN_BUILD_OUTPUT must name a build output directory');
const BUILD_OUTPUT = path.resolve(ROOT, OUTPUT_OVERRIDE || 'dist');
const pkg = require('../package.json');

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

let checks = 0;
function ok(label, value) {
  assert.ok(value, label);
  checks += 1;
  process.stdout.write('ok ' + label + '\n');
}
function eq(label, actual, expected) {
  assert.deepStrictEqual(actual, expected, label);
  checks += 1;
  process.stdout.write('ok ' + label + '\n');
}

// The Windows installer ships the shared extraResources plus build.win's own.
const extra = JSON.stringify([].concat(pkg.build.extraResources || [],
  (pkg.build.win && pkg.build.win.extraResources) || []));
ok('40. the main installer extraResources do not bundle the Qwen CUDA pack zip',
  !/qwen-cuda-pack-win-x64\.zip/.test(extra));
ok('40b. the main installer extraResources do not bundle the Qwen ROCm pack zip',
  !/qwen-rocm-pack-win-x64\.zip/.test(extra));
ok('40c. the CPU speech runtime zip is still bundled',
  extra.includes('voxden-asr-runtime-win-x64.zip'));

const catalog = require('../src/qwen-accel-catalog.json');
if (catalog.cuda && catalog.cuda.sha256) {
  ok('cuda catalog sha256 is 64 hex', /^[a-f0-9]{64}$/.test(catalog.cuda.sha256));
  const parts = catalog.cuda.parts || [];
  if (parts.length) {
    const sum = parts.reduce((n, p) => n + p.size, 0);
    eq('cuda GitHub parts sum to the assembled zip size', sum, catalog.cuda.downloadBytes);
    ok('each CUDA part is under the GitHub 2 GiB limit', parts.every((p) => p.size < 2 * 1024 * 1024 * 1024));
  }
}
if (catalog.rocm && catalog.rocm.sha256) {
  ok('rocm catalog sha256 is 64 hex', /^[a-f0-9]{64}$/.test(catalog.rocm.sha256));
  const parts = catalog.rocm.parts || [];
  if (parts.length) {
    const sum = parts.reduce((n, p) => n + p.size, 0);
    eq('rocm GitHub parts sum to the assembled zip size', sum, catalog.rocm.downloadBytes);
    ok('each ROCm part is under the GitHub 2 GiB limit', parts.every((p) => p.size < 2 * 1024 * 1024 * 1024));
  }
}

const sourceSidecar = path.join(ROOT, 'sidecar', 'transcribe.py');
const sourceAccel = path.join(ROOT, 'sidecar', 'qwen_accel.py');
ok('43. source sidecar is present', fs.existsSync(sourceSidecar));
ok('43b. source qwen_accel.py is present', fs.existsSync(sourceAccel));
const sidecarSrc = fs.readFileSync(sourceSidecar, 'utf8');
ok('43c. source QwenBackend still passes context=context', /context\s*=\s*context/.test(sidecarSrc));
ok('43d. source QwenBackend does not discard prompt', !/^\s*del prompt\b/m.test(
  sidecarSrc.slice(sidecarSrc.indexOf('class QwenBackend:'), sidecarSrc.indexOf('def wav_duration_sec'))
));
ok('44. managed recognition is offline (no Hub at dictation time)',
  /HF_HUB_OFFLINE/.test(fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8')));
ok('44b. Qwen loads with local_files_only when offline',
  /local_files_only=self\._offline/.test(sidecarSrc));

const nsh = fs.readFileSync(path.join(ROOT, 'build', 'installer.nsh'), 'utf8');
ok('47. the uninstaller keeps history and preferences',
  /history and local preferences are kept/i.test(nsh));
ok('47b. packaged data lives under userData, not the install directory',
  /app\.getPath\('userData'\)/.test(fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8')));
ok('47c. welcome copy is unchanged', /Your voice, ready anywhere/.test(nsh));
ok('47d. finish page uses the current Voxden title', /!define MUI_FINISHPAGE_TITLE "Voxden is ready"/.test(nsh));
// The 1.0.19 installer page that removed the leftover language-pack writer
// is gone; the app removes the same folder and log on every launch.
ok('48. the installer no longer carries the 1.0.19 writer cleanup',
  !/WriterCleanupPageCreate|customPageAfterChangeDir|!macro customInstall/.test(nsh));
ok('48b. the installer deletes no user folders', !/RMDir\s+\/r/i.test(nsh));
const mainSrc48 = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
ok('48c. launch removes the leftover writer folder and its log',
  /removeTree\(path\.join\(MODELS, 'writer'\)\)/.test(mainSrc48) && /path\.join\(DATA, 'local-correction\.log'\)/.test(mainSrc48));

const devData = path.join(ROOT, 'data');
const installedData = path.join(
  process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
  'Voxden',
  'data'
);
ok('39. development data is not the installed profile',
  path.normalize(devData).toLowerCase() !== path.normalize(installedData).toLowerCase());

const resources = path.join(BUILD_OUTPUT, 'win-unpacked', 'resources');
const unpacked = path.join(resources, 'sidecar');
if (!fs.existsSync(unpacked)) {
  assert.ok(!REQUIRE_PACKAGED, 'Requested packaged sidecar directory is missing: ' + unpacked);
  console.log('ok packaged artifacts not present yet (run npm run dist to produce them)');
  process.stdout.write(checks + ' qwen packaged contract checks passed\n');
  process.exit(0);
}

const packedSidecar = path.join(unpacked, 'transcribe.py');
const packedAccel = path.join(unpacked, 'qwen_accel.py');
ok('41. packaged sidecar exists', fs.existsSync(packedSidecar));
if (!fs.existsSync(packedAccel)) {
  assert.ok(!REQUIRE_PACKAGED, 'Requested packaged qwen_accel.py is missing: ' + packedAccel);
  console.log('ok packaged qwen_accel.py not in this unpack yet (run npm run dist)');
  process.stdout.write(checks + ' qwen packaged contract checks passed\n');
  process.exit(0);
}
ok('41b. packaged qwen_accel.py exists', fs.existsSync(packedAccel));
eq('14. packaged transcribe.py SHA-256 matches source', sha256(packedSidecar), sha256(sourceSidecar));
eq('14b. packaged qwen_accel.py SHA-256 matches source', sha256(packedAccel), sha256(sourceAccel));
ok('43e. packaged sidecar still has context=context',
  /context\s*=\s*context/.test(fs.readFileSync(packedSidecar, 'utf8')));

for (const name of ['qwen_probe.py', 'qwen-probe-audio.json']) {
  eq('bundled offline speech check matches source: ' + name,
    sha256(path.join(unpacked, name)), sha256(path.join(ROOT, 'sidecar', name)));
}
eq('bundled extractor matches the tested executable',
  sha256(path.join(resources, 'pack-tools/7za.exe')),
  sha256(path.join(ROOT, 'node_modules/7zip-bin/win/x64/7za.exe')));
for (const name of ['7zip-License.txt', 'LGPL-2.1.txt', '7zip-bin-MIT.txt']) {
  ok('extractor license is bundled: ' + name, fs.existsSync(path.join(resources, 'pack-tools/licenses', name)));
}
function walkNames(dir, acc) {
  if (!fs.existsSync(dir)) return acc;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    acc.push(entry.name.toLowerCase());
    if (entry.isDirectory() && entry.name !== 'app.asar.unpacked') walkNames(p, acc);
  }
  return acc;
}
const names = walkNames(resources, []);
ok('40d. unpacked resources do not contain the Qwen CUDA pack zip',
  !names.includes('voxden-qwen-cuda-pack-win-x64.zip'));
ok('40e. unpacked resources do not contain the Qwen ROCm pack zip',
  !names.includes('voxden-qwen-rocm-pack-win-x64.zip'));

const setup = fs.readdirSync(BUILD_OUTPUT).filter((n) => /^Voxden-Setup-.*\.exe$/i.test(n));
ok('installer artifact exists after dist', setup.length > 0);

process.stdout.write(checks + ' qwen packaged checks passed\n');
