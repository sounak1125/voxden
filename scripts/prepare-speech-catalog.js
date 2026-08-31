'use strict';

// Pin model revisions and every byte at build time. Client setup never executes
// Hub code or resolves a moving "main" revision.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

async function main() {
  const definitions = [
    { id: 'qwen3-asr', name: 'Qwen3-ASR 1.7B', repo: 'Qwen/Qwen3-ASR-1.7B',
      include: /\.(json|safetensors|txt|tiktoken)$/ },
    { id: 'parakeet', name: 'Parakeet TDT 0.6B (CPU)', repo: 'istupakov/parakeet-tdt-0.6b-v2-onnx',
      include: /^(config\.json|vocab\.txt|encoder-model\.int8\.onnx|decoder_joint-model\.int8\.onnx)$/ },
    { id: 'parakeet-fp32', name: 'Parakeet TDT 0.6B (GPU)', repo: 'istupakov/parakeet-tdt-0.6b-v2-onnx',
      include: /^(config\.json|vocab\.txt|encoder-model\.onnx(\.data)?|decoder_joint-model\.onnx)$/ },
  ];
  const packs = [];
  for (const def of definitions) {
    const response = await fetch('https://huggingface.co/api/models/' + def.repo + '?blobs=true');
    if (!response.ok) throw new Error('Could not inspect ' + def.repo + ': ' + response.status);
    const info = await response.json();
    const files = [];
    for (const file of info.siblings.filter(f => def.include.test(f.rfilename))) {
      const url = 'https://huggingface.co/' + def.repo + '/resolve/' + info.sha + '/' + file.rfilename;
      let sha256 = file.lfs && file.lfs.sha256;
      let size = file.size;
      if (!sha256) {
        const small = await fetch(url);
        if (!small.ok) throw new Error('Could not read ' + url);
        const bytes = Buffer.from(await small.arrayBuffer());
        size = bytes.length;
        sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
      }
      files.push({ path: file.rfilename, url, size, sha256 });
    }
    if (files.length < 4) throw new Error('Incomplete file list for ' + def.id);
    packs.push({ id: def.id, name: def.name, repository: def.repo, revision: info.sha, files });
    console.log(def.id, files.length, 'files,', files.reduce((n, f) => n + f.size, 0), 'bytes');
  }
  fs.writeFileSync(path.join(__dirname, '../src/speech-model-catalog.json'), JSON.stringify({ schemaVersion: 1, packs }, null, 2) + '\n');
}
main().catch(err => { console.error(err); process.exitCode = 1; });
