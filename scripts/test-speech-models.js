'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { SpeechModelsManager } = require('../src/speech-models');
const { ReleaseDownloader } = require('../src/release-download');

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voxden-models-'));
  const bytes = Buffer.from('a complete model');
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  const packs = [{ id: 'qwen3-asr', name: 'Qwen test', revision: 'pinned', repository: 'test/model',
    files: ['config.json', 'model.safetensors'].map(name => ({ path: name,
      url: 'https://model.test/' + name, size: bytes.length, sha256 })) }];
  let downloads = 0;
  const manager = new SpeechModelsManager({ root, packs, fetchImpl: async () => {
    downloads++; return new Response(bytes);
  } });
  try {
    await manager.install();
    assert(manager.installed('qwen3-asr'));
    assert(manager.snapshot().installed);
    const first = downloads;
    await manager.install();
    assert.strictEqual(downloads, first, 'completed setup does not fetch models again');
    const next = new SpeechModelsManager({ root, packs, fetchImpl: () => { throw new Error('Offline'); } });
    await next.install();
    fs.writeFileSync(path.join(root, 'qwen3-asr/config.json'), 'broken');
    assert.strictEqual(manager.installed('qwen3-asr'), null, 'partial/corrupt models cannot be loaded');
    await manager.install();
    assert(manager.installed('qwen3-asr'));
    await manager.remove();
    assert.strictEqual(manager.installed('qwen3-asr'), null);
    await manager.install();
    assert(manager.installed('qwen3-asr'), 'remove then reinstall works');

    // A checksum failure after all ranges arrived used to poison every Retry.
    let corrupt = true;
    const downloader = new ReleaseDownloader({ segmentSize: 4, segmentThreshold: 1, segmentConcurrency: 2,
      fetchImpl: async (_url, init) => {
        const [, start, end] = /bytes=(\d+)-(\d+)/.exec(init.headers.Range);
        const body = Buffer.from(bytes.subarray(Number(start), Number(end) + 1));
        if (corrupt) body.fill(0);
        return new Response(body, { status: 206 });
      } });
    const target = path.join(root, 'segmented.bin');
    const asset = { asset: 'segmented.bin', url: 'https://model.test/segmented', size: bytes.length, sha256 };
    await assert.rejects(downloader.downloadAsset(asset, target), err => err.code === 'CHECKSUM_MISMATCH');
    corrupt = false;
    await downloader.downloadAsset(asset, target);
    assert.deepStrictEqual(fs.readFileSync(target), bytes, 'a fresh retry repairs corrupt segments');
    console.log('all managed speech model tests passed');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
main().catch(err => { console.error(err); process.exitCode = 1; });
