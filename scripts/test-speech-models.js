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

    // Older versions downloaded into the Hub cache and setup copied from it,
    // leaving both. Install now takes over the cached copy; remove drops it.
    const cacheRoot = path.join(root, 'cache');
    const hubDir = path.join(cacheRoot, 'huggingface', 'hub', 'models--test--model');
    const hubLocks = path.join(cacheRoot, 'huggingface', 'hub', '.locks', 'models--test--model');
    const plantHub = () => {
      const snapshot = path.join(hubDir, 'snapshots', 'pinned');
      fs.mkdirSync(snapshot, { recursive: true });
      for (const name of ['config.json', 'model.safetensors']) fs.writeFileSync(path.join(snapshot, name), bytes);
      fs.mkdirSync(hubLocks, { recursive: true });
    };
    await manager.remove();
    plantHub();
    const before = downloads;
    const cached = new SpeechModelsManager({ root, packs, cacheRoot, fetchImpl: async () => {
      downloads++; return new Response(bytes);
    } });
    await cached.install();
    assert(cached.installed('qwen3-asr'), 'a verified cache copy installs');
    assert.strictEqual(downloads, before, 'without fetching what the cache already had');
    assert.strictEqual(fs.existsSync(hubDir), false, 'install takes over the cached copy instead of keeping both');
    assert.strictEqual(fs.existsSync(hubLocks), false, 'and its lock directory');
    plantHub();
    await cached.remove(['qwen3-asr']);
    assert.strictEqual(cached.installed('qwen3-asr'), null);
    assert.strictEqual(fs.existsSync(hubDir), false, 'remove drops the cached copy too');
    for (const dir of [root, cacheRoot, path.join(cacheRoot, 'huggingface', 'hub')]) {
      assert(!fs.readdirSync(dir).some(name => name.includes('.removing-')), 'nothing half-removed is left in ' + dir);
    }
    plantHub();
    const dev = new SpeechModelsManager({ root, packs, cacheRoot, purgeLegacy: false,
      fetchImpl: async () => new Response(bytes) });
    await dev.install();
    assert(fs.existsSync(hubDir), 'a developer build keeps its cache');
    await dev.remove();

    // One pack at a time: the other stays, with its receipt and its files.
    const both = packs.concat([{ id: 'parakeet', name: 'Parakeet test', revision: 'pinned',
      repository: 'test/parakeet', files: [{ path: 'encoder.onnx', url: 'https://model.test/encoder.onnx',
        size: bytes.length, sha256 }] }]);
    const legacyParakeet = path.join(cacheRoot, 'parakeet-tdt-0.6b-v2');
    fs.mkdirSync(legacyParakeet, { recursive: true });
    fs.writeFileSync(path.join(legacyParakeet, 'stale.onnx'), 'old');
    const pair = new SpeechModelsManager({ root, packs: both, cacheRoot, fetchImpl: async () => new Response(bytes) });
    await pair.install();
    assert(pair.installed('qwen3-asr') && pair.installed('parakeet'));
    assert.strictEqual(fs.existsSync(legacyParakeet), false, 'the bare cache directory goes with the install');
    fs.mkdirSync(legacyParakeet, { recursive: true });
    await pair.remove(['parakeet']);
    assert.strictEqual(pair.installed('parakeet'), null, 'the named pack is gone');
    assert.strictEqual(fs.existsSync(pair.directory('parakeet')), false);
    assert.strictEqual(fs.existsSync(legacyParakeet), false, 'and so is its cached copy');
    assert(pair.installed('qwen3-asr'), 'the other pack is untouched');
    assert(fs.existsSync(path.join(root, 'qwen3-asr', 'model.safetensors')));

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
