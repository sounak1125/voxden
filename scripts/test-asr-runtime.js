'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { AsrRuntimeManager } = require('../src/asr-runtime');

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

function digest(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

// A zip holding a stand-in python.exe, built inline so the test needs no tools.
function makeRuntimeZip(names) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const name of names) {
    const nameBuf = Buffer.from(name, 'utf8');
    const raw = Buffer.from('contents of ' + name);
    const deflated = zlib.deflateRawSync(raw);
    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    nameBuf.copy(local, 30);
    locals.push(local, deflated);

    const dir = Buffer.alloc(46 + nameBuf.length);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(8, 10);
    dir.writeUInt32LE(deflated.length, 20);
    dir.writeUInt32LE(raw.length, 24);
    dir.writeUInt16LE(nameBuf.length, 28);
    dir.writeUInt32LE(offset, 42);
    nameBuf.copy(dir, 46);
    central.push(dir);
    offset += local.length + deflated.length;
  }
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(names.length, 8);
  eocd.writeUInt16LE(names.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, eocd]);
}

function makeFetch(zipBytes, calls, options) {
  const opts = options || {};
  const manifest = Buffer.from(JSON.stringify({
    schemaVersion: 1,
    runtime: {
      id: opts.id || 'asr-win-x64-v1',
      asset: 'voxden-asr-runtime-win-x64.zip',
      python: 'python.exe',
      pythonVersion: '3.12.10',
      files: 3,
      size: zipBytes.length,
      sha256: digest(zipBytes),
    },
  }));
  const release = {
    assets: [
      {
        name: 'voxden-asr-runtime.json',
        browser_download_url: 'https://example.test/voxden-asr-runtime.json',
        size: manifest.length,
        digest: 'sha256:' + digest(manifest),
      },
      {
        name: 'voxden-asr-runtime-win-x64.zip',
        browser_download_url: 'https://example.test/voxden-asr-runtime-win-x64.zip',
        size: zipBytes.length,
        // Where GitHub supplies a digest it is the one that must be trusted.
        digest: opts.badDigest ? 'sha256:' + '0'.repeat(64) : 'sha256:' + digest(zipBytes),
      },
    ],
  };

  return async function fetchImpl(url, init) {
    const href = String(url);
    const opts = init || {};
    calls.push({ url: href, range: opts.headers && (opts.headers.Range || opts.headers.range) });
    if (href.includes('api.github.com')) {
      return new Response(JSON.stringify(release), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (href.endsWith('voxden-asr-runtime.json')) {
      return new Response(manifest, { status: 200 });
    }
    if (href.endsWith('.zip')) {
      const range = opts.headers && (opts.headers.Range || opts.headers.range);
      if (range) {
        const match = /^bytes=([0-9]+)-([0-9]*)$/.exec(range);
        if (!match) return new Response('bad range', { status: 416 });
        const offset = Number(match[1]);
        const end = match[2] === '' ? zipBytes.length - 1 : Number(match[2]);
        return new Response(zipBytes.subarray(offset, end + 1), { status: 206 });
      }
      return new Response(zipBytes, { status: 200 });
    }
    return new Response('missing', { status: 404 });
  };
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voxden-asr-'));
  const zipBytes = makeRuntimeZip(['python.exe', 'Lib/site-packages/faster_whisper/__init__.py', 'MSVCP140.dll']);

  await ok('installs, verifies and records a receipt', async () => {
    const home = path.join(root, 'a');
    const calls = [];
    const progress = [];
    const manager = new AsrRuntimeManager({
      root: home,
      fetchImpl: makeFetch(zipBytes, calls),
      releaseApiUrl: 'https://api.github.com/repos/x/y/releases/tags/asr-runtime-v1',
      onProgress: (s) => progress.push(s),
      segmentThreshold: 1 << 30,
    });
    assert.strictEqual(manager.installed(), null, 'nothing is installed to begin with');

    const result = await manager.install();
    assert.strictEqual(result.reused, false);
    assert.ok(result.installed.pythonPath.startsWith(path.resolve(home)));
    assert.ok(fs.existsSync(result.installed.pythonPath), 'python.exe landed on disk');
    assert.ok(
      fs.existsSync(path.join(home, 'runtime', 'Lib', 'site-packages', 'faster_whisper', '__init__.py')),
      'nested entries were extracted'
    );
    assert.strictEqual(progress[progress.length - 1].status, 'installed');
    assert.strictEqual(progress[progress.length - 1].progress, 100);
    // The staging copy is not left behind taking up another 92 MB.
    assert.strictEqual(fs.existsSync(path.join(home, 'downloads')), false);
  });

  await ok('a second install reuses the receipt without downloading', async () => {
    const home = path.join(root, 'b');
    const calls = [];
    const manager = new AsrRuntimeManager({
      root: home,
      fetchImpl: makeFetch(zipBytes, calls),
      releaseApiUrl: 'https://api.github.com/repos/x/y/releases/tags/asr-runtime-v1',
      segmentThreshold: 1 << 30,
    });
    await manager.install();
    const before = calls.filter((c) => c.url.endsWith('.zip')).length;
    const again = await manager.install();
    const after = calls.filter((c) => c.url.endsWith('.zip')).length;
    assert.strictEqual(again.reused, true);
    assert.strictEqual(after, before, 'an installed runtime must not download again');
  });

  await ok('a fresh manager sees the install a later app version left', async () => {
    const home = path.join(root, 'c');
    const calls = [];
    const opts = {
      root: home,
      fetchImpl: makeFetch(zipBytes, calls),
      releaseApiUrl: 'https://api.github.com/repos/x/y/releases/tags/asr-runtime-v1',
      segmentThreshold: 1 << 30,
    };
    await new AsrRuntimeManager(opts).install();
    const next = new AsrRuntimeManager(opts);
    assert.ok(next.installed(), 'the receipt survives the process that wrote it');
    assert.strictEqual(next.snapshot().installed, true);
    assert.strictEqual(next.snapshot().pythonVersion, '3.12.10');
  });

  await ok('a payload that does not match the digest is refused', async () => {
    const home = path.join(root, 'd');
    const calls = [];
    const manager = new AsrRuntimeManager({
      root: home,
      fetchImpl: makeFetch(zipBytes, calls, { badDigest: true }),
      releaseApiUrl: 'https://api.github.com/repos/x/y/releases/tags/asr-runtime-v1',
      segmentThreshold: 1 << 30,
    });
    await assert.rejects(() => manager.install(), (err) => err.code === 'CHECKSUM_MISMATCH');
    assert.strictEqual(manager.installed(), null, 'a failed install leaves nothing usable');
  });

  await ok('remove deletes the runtime and the receipt', async () => {
    const home = path.join(root, 'e');
    const calls = [];
    const manager = new AsrRuntimeManager({
      root: home,
      fetchImpl: makeFetch(zipBytes, calls),
      releaseApiUrl: 'https://api.github.com/repos/x/y/releases/tags/asr-runtime-v1',
      segmentThreshold: 1 << 30,
    });
    const installed = await manager.install();
    assert.ok(fs.existsSync(installed.installed.pythonPath));
    await manager.remove();
    assert.strictEqual(manager.installed(), null);
    assert.strictEqual(fs.existsSync(path.join(home, 'runtime')), false);
  });

  await ok('an archive with no interpreter is refused', async () => {
    const home = path.join(root, 'f');
    const calls = [];
    const wrong = makeRuntimeZip(['readme.txt']);
    const manager = new AsrRuntimeManager({
      root: home,
      fetchImpl: makeFetch(wrong, calls),
      releaseApiUrl: 'https://api.github.com/repos/x/y/releases/tags/asr-runtime-v1',
      segmentThreshold: 1 << 30,
    });
    await assert.rejects(() => manager.install(), (err) => err.code === 'RUNTIME_INCOMPLETE');
    assert.strictEqual(manager.installed(), null);
  });

  fs.rmSync(root, { recursive: true, force: true });
  if (failed) {
    console.error(failed + ' failed');
    process.exit(1);
  }
  console.log('all asr runtime tests passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
