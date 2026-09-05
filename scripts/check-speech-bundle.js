'use strict';
const fs = require('fs');
const path = require('path');
const { sha256File } = require('../src/release-download');

async function main() {
  const root = path.join(__dirname, '../dist-runtime-v3');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'voxden-asr-runtime.json'), 'utf8'));
  const runtime = manifest.runtime;
  if (!runtime || !['whisper', 'qwen3-asr', 'parakeet'].every(id => runtime.engines?.includes(id))) {
    throw new Error('Build the complete speech runtime first: npm run prepare:asr-runtime');
  }
  const archive = path.join(root, 'voxden-asr-runtime-win-x64.zip');
  if (fs.statSync(archive).size !== runtime.size || await sha256File(archive) !== runtime.sha256) {
    throw new Error('The bundled runtime is incomplete or corrupt. Rebuild it before packaging.');
  }
  console.log('Verified bundled speech runtime:', runtime.id);
  for (const required of [
    'node_modules/7zip-bin/win/x64/7za.exe',
    'build/pack-tools-licenses/7zip-License.txt',
    'build/pack-tools-licenses/LGPL-2.1.txt',
    'sidecar/qwen_probe.py', 'sidecar/qwen-probe-audio.json',
  ]) {
    if (!fs.existsSync(path.join(__dirname, '..', required))) throw new Error('Required GPU support resource missing: ' + required);
  }
}
main().catch(err => { console.error(err.message); process.exitCode = 1; });
