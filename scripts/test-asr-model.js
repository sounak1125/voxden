'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { AsrModelManager } = require('../src/asr-model');

let failed = 0;
async function ok(name, fn) {
  try {
    await fn();
    console.log('ok ' + name);
  } catch (err) {
    failed += 1;
    console.error('FAIL ' + name + '\n  ' + (err && err.stack ? err.stack : err));
  }
}

const digest = (b) => crypto.createHash('sha256').update(b).digest('hex');

// A stand-in for the real thing: weights cut into parts, plus the small files
// faster-whisper opens beside them.
function makeFixture() {
  const weights = Buffer.from('WEIGHTS:' + 'w'.repeat(300));
  const half = Math.ceil(weights.length / 2);
  return {
    weights,
    parts: [weights.subarray(0, half), weights.subarray(half)],
    files: {
      'config.json': Buffer.from('{"model_type":"whisper"}'),
      'tokenizer.json': Buffer.from('{"tokens":[]}'),
      'vocabulary.json': Buffer.from('["a","b"]'),
    },
  };
}

function makeFetch(fixture, calls, options) {
  const opts = options || {};
  const assetBytes = new Map();
  const manifestParts = [];
  const manifestFiles = [];

  fixture.parts.forEach((buf, i) => {
    const name = 'voxden-whisper-large-v3.bin.part0' + (i + 1);
    assetBytes.set(name, buf);
    manifestParts.push({ asset: name, size: buf.length, sha256: digest(buf) });
  });
  for (const [name, buf] of Object.entries(fixture.files)) {
    const asset = 'voxden-whisper-large-v3-' + name;
    assetBytes.set(asset, buf);
    manifestFiles.push({
      asset,
      path: opts.evilPath && name === 'config.json' ? opts.evilPath : name,
      size: buf.length,
      sha256: digest(buf),
    });
  }

  const manifest = Buffer.from(JSON.stringify({
    schemaVersion: 1,
    model: {
      id: opts.id || 'whisper-large-v3',
      source: 'Systran/faster-whisper-large-v3',
      weightsFile: 'model.bin',
      weightsSize: fixture.weights.length,
      weightsSha256: opts.badWeightsDigest ? '0'.repeat(64) : digest(fixture.weights),
      parts: manifestParts,
      files: manifestFiles,
    },
  }));
  assetBytes.set('voxden-asr-model.json', manifest);

  const assets = [...assetBytes.entries()].map(([name, buf]) => ({
    name,
    size: buf.length,
    digest: 'sha256:' + digest(buf),
    browser_download_url: 'https://downloads.test/' + name,
  }));

  return async (url, init) => {
    const href = String(url);
    const o = init || {};
    calls.push({ url: href, range: o.headers && (o.headers.Range || o.headers.range) });
    if (href.includes('api.github.com')) {
      return new Response(JSON.stringify({ tag_name: 'asr-model-v1', assets }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    const name = decodeURIComponent(href.split('/').pop());
    const bytes = assetBytes.get(name);
    if (!bytes) return new Response('missing', { status: 404 });
    const range = o.headers && (o.headers.Range || o.headers.range);
    if (range) {
      const m = /^bytes=(\d+)-(\d*)$/.exec(range);
      if (!m) return new Response('bad range', { status: 416 });
      const start = Number(m[1]);
      const end = m[2] === '' ? bytes.length - 1 : Number(m[2]);
      return new Response(bytes.subarray(start, end + 1), { status: 206 });
    }
    return new Response(bytes, { status: 200 });
  };
}

function manager(root, fixture, calls, opts) {
  return new AsrModelManager({
    root,
    fetchImpl: makeFetch(fixture, calls, opts),
    releaseApiUrl: 'https://api.github.com/repos/x/y/releases/tags/asr-model-v1',
    segmentThreshold: 1 << 30,
  });
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voxden-model-'));
  const fixture = makeFixture();

  await ok('assembles the parts into one verified model directory', async () => {
    const home = path.join(root, 'a');
    const calls = [];
    const progress = [];
    const m = new AsrModelManager({
      root: home,
      fetchImpl: makeFetch(fixture, calls),
      releaseApiUrl: 'https://api.github.com/repos/x/y/releases/tags/asr-model-v1',
      onProgress: (s) => progress.push(s),
      segmentThreshold: 1 << 30,
    });
    assert.strictEqual(m.installed(), null);
    const result = await m.install();
    assert.strictEqual(result.reused, false);

    const dir = result.installed.path;
    // The whole point: the two parts became the original file, byte for byte.
    assert.deepStrictEqual(fs.readFileSync(path.join(dir, 'model.bin')), fixture.weights);
    for (const [name, buf] of Object.entries(fixture.files)) {
      assert.deepStrictEqual(fs.readFileSync(path.join(dir, name)), buf, name + ' landed');
    }
    assert.strictEqual(progress[progress.length - 1].progress, 100);
    // Staging held a second copy of a 3 GB model; it must not survive.
    assert.strictEqual(fs.existsSync(path.join(home, 'downloads')), false);
  });

  await ok('a second install reuses the receipt', async () => {
    const home = path.join(root, 'b');
    const calls = [];
    const m = manager(home, fixture, calls);
    await m.install();
    const before = calls.filter((c) => c.url.includes('.part')).length;
    const again = await m.install();
    assert.strictEqual(again.reused, true);
    assert.strictEqual(calls.filter((c) => c.url.includes('.part')).length, before);
  });

  await ok('the receipt survives a new manager', async () => {
    const home = path.join(root, 'c');
    const calls = [];
    await manager(home, fixture, calls).install();
    const next = manager(home, fixture, calls);
    assert.ok(next.installed());
    assert.strictEqual(next.snapshot().installed, true);
    assert.strictEqual(next.snapshot().id, 'whisper-large-v3');
  });

  await ok('parts that do not reassemble into the right file are refused', async () => {
    const home = path.join(root, 'd');
    const calls = [];
    const m = manager(home, fixture, calls, { badWeightsDigest: true });
    await assert.rejects(() => m.install(), (err) => err.code === 'CHECKSUM_MISMATCH');
    assert.strictEqual(m.installed(), null, 'nothing usable is left behind');
  });

  await ok('a manifest naming a path outside the model directory is refused', async () => {
    const home = path.join(root, 'e');
    const calls = [];
    const m = manager(home, fixture, calls, { evilPath: '../../escaped.json' });
    await assert.rejects(
      () => m.install(),
      (err) => err.code === 'INVALID_MANIFEST' || err.code === 'UNSAFE_PATH'
    );
    assert.strictEqual(fs.existsSync(path.join(root, 'escaped.json')), false);
  });

  await ok('remove deletes the model and the receipt', async () => {
    const home = path.join(root, 'f');
    const calls = [];
    const m = manager(home, fixture, calls);
    const installed = await m.install();
    assert.ok(fs.existsSync(path.join(installed.installed.path, 'model.bin')));
    await m.remove();
    assert.strictEqual(m.installed(), null);
    assert.strictEqual(fs.existsSync(installed.installed.path), false);
  });

  await ok('a deleted weight file invalidates the install', async () => {
    const home = path.join(root, 'g');
    const calls = [];
    const m = manager(home, fixture, calls);
    const installed = await m.install();
    fs.rmSync(path.join(installed.installed.path, 'model.bin'), { force: true });
    assert.strictEqual(m.installed(), null, 'a missing file must not read as installed');
  });

  fs.rmSync(root, { recursive: true, force: true });
  if (failed) {
    console.error(failed + ' failed');
    process.exit(1);
  }
  console.log('all asr model tests passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
