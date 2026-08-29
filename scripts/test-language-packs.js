'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { LanguagePackManager } = require('../src/language-packs');

const fsPromises = fs.promises;

function digest(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function makeFixture() {
  const files = {
    'runtime-llama-server.exe': Buffer.from('fake local runtime'),
    'standard.part1': Buffer.from('standard model '),
    'standard.part2': Buffer.from('bytes'),
    'enhanced.gguf': Buffer.from('enhanced model bytes'),
  };
  const standard = Buffer.concat([files['standard.part1'], files['standard.part2']]);
  const enhanced = files['enhanced.gguf'];
  const manifest = {
    schemaVersion: 1,
    runtime: {
      id: 'llama-test-v1',
      executable: 'llama-server.exe',
      files: [{ asset: 'runtime-llama-server.exe', path: 'llama-server.exe' }],
    },
    packs: {
      standard: {
        id: 'standard-test-v1',
        version: 1,
        displayName: 'Standard',
        modelAlias: 'voxden-standard',
        modelFile: 'standard.gguf',
        modelSize: standard.length,
        modelSha256: digest(standard),
        parts: ['standard.part1', 'standard.part2'],
      },
      enhanced: {
        id: 'enhanced-test-v1',
        version: 1,
        displayName: 'Enhanced',
        modelAlias: 'voxden-enhanced',
        modelFile: 'enhanced.gguf',
        modelSize: enhanced.length,
        modelSha256: digest(enhanced),
        parts: ['enhanced.gguf'],
      },
    },
  };
  files['voxden-language-packs.json'] = Buffer.from(JSON.stringify(manifest));
  return { files, standard };
}

function fixtureFetch(fixture, calls) {
  const assets = Object.entries(fixture.files).map(([name, bytes]) => ({
    name,
    size: bytes.length,
    digest: 'sha256:' + digest(bytes),
    browser_download_url: 'https://downloads.test/' + name,
  }));
  return async (url, options) => {
    const href = String(url);
    const opts = options || {};
    calls.push({ url: href, range: opts.headers && (opts.headers.Range || opts.headers.range) });
    if (href === 'https://api.test/release') {
      return new Response(JSON.stringify({ tag_name: 'language-packs-v1', assets }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    const name = decodeURIComponent(href.split('/').pop());
    const bytes = fixture.files[name];
    if (!bytes) return new Response('missing', { status: 404 });
    const range = opts.headers && (opts.headers.Range || opts.headers.range);
    if (range) {
      const match = /^bytes=([0-9]+)-([0-9]*)$/.exec(range);
      if (!match) return new Response('bad range', { status: 416 });
      const offset = Number(match[1]);
      const end = match[2] === '' ? bytes.length - 1 : Number(match[2]);
      return new Response(bytes.subarray(offset, end + 1), {
        status: 206,
        headers: { 'Content-Range': 'bytes ' + offset + '-' + end + '/' + bytes.length },
      });
    }
    return new Response(bytes, { status: 200 });
  };
}

async function main() {
  const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'voxden-language-packs-'));
  const fixture = makeFixture();
  const calls = [];
  const progress = [];
  const manager = new LanguagePackManager({
    root,
    releaseApiUrl: 'https://api.test/release',
    fetchImpl: fixtureFetch(fixture, calls),
    onProgress: (state) => progress.push(state),
  });
  try {
    const partialDir = path.join(root, 'downloads', 'standard-test-v1');
    await fsPromises.mkdir(partialDir, { recursive: true });
    await fsPromises.writeFile(path.join(partialDir, 'standard.part1.partial'), fixture.files['standard.part1'].subarray(0, 4));

    const first = await manager.install('standard');
    assert.strictEqual(first.reused, false);
    assert.ok(first.installed.modelPath.startsWith(root));
    assert.deepStrictEqual(await fsPromises.readFile(first.installed.modelPath), fixture.standard);
    assert.ok(calls.some((call) => call.url.endsWith('/standard.part1') && call.range === 'bytes=4-'));
    assert.ok(progress.some((state) => state.status === 'downloading'));
    assert.strictEqual(progress[progress.length - 1].progress, 100);

    const assetCallsBefore = calls.filter((call) => /runtime-|standard\.part/.test(call.url)).length;
    const second = await manager.install('standard');
    const assetCallsAfter = calls.filter((call) => /runtime-|standard\.part/.test(call.url)).length;
    assert.strictEqual(second.reused, true);
    assert.strictEqual(assetCallsAfter, assetCallsBefore, 'installed assets must not download again');

    const afterAppUpdate = new LanguagePackManager({
      root,
      releaseApiUrl: 'https://should-not-be-called.test',
      fetchImpl: async () => { throw new Error('network should not be used'); },
    });
    assert.ok(afterAppUpdate.installed('standard'), 'a new app version should reuse the persistent receipt');
    assert.strictEqual(afterAppUpdate.snapshot('standard').packs.standard.installed, true);

    await manager.remove('standard');
    assert.strictEqual(manager.installed('standard'), null);
    assert.strictEqual(fs.existsSync(first.installed.modelPath), false);

    const enhanced = await manager.install('enhanced');
    assert.deepStrictEqual(
      await fsPromises.readFile(enhanced.installed.modelPath),
      fixture.files['enhanced.gguf']
    );
    assert.strictEqual(fs.existsSync(path.join(root, 'downloads', 'enhanced-test-v1', 'enhanced.gguf')), false);
    await manager.remove('enhanced');

    // Large assets download as concurrent byte ranges; small ones must not.
    const segRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'voxden-segments-'));
    const segCalls = [];
    const segManager = new LanguagePackManager({
      root: segRoot,
      releaseApiUrl: 'https://api.test/release',
      fetchImpl: fixtureFetch(fixture, segCalls),
      segmentThreshold: 20,
      segmentSize: 8,
      segmentConcurrency: 4,
    });
    const segmented = await segManager.install('enhanced');
    assert.deepStrictEqual(
      await fsPromises.readFile(segmented.installed.modelPath),
      fixture.files['enhanced.gguf'],
      'a segmented download must reassemble byte for byte'
    );
    const closedRanges = segCalls
      .filter((call) => call.url.endsWith('/enhanced.gguf') && /^bytes=[0-9]+-[0-9]+$/.test(call.range || ''))
      .map((call) => call.range)
      .sort();
    assert.deepStrictEqual(closedRanges, ['bytes=0-7', 'bytes=16-19', 'bytes=8-15']);
    assert.ok(
      !segCalls.some((call) => call.url.includes('runtime-') && /^bytes=[0-9]+-[0-9]+$/.test(call.range || '')),
      'assets below the threshold stay on the single-connection path'
    );
    await fsPromises.rm(segRoot, { recursive: true, force: true });

    // A partial left by the old single-connection downloader keeps its bytes.
    const resumeRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'voxden-resume-'));
    const resumeCalls = [];
    const resumeStaging = path.join(resumeRoot, 'downloads', 'enhanced-test-v1');
    await fsPromises.mkdir(resumeStaging, { recursive: true });
    await fsPromises.writeFile(
      path.join(resumeStaging, 'enhanced.gguf.partial'),
      fixture.files['enhanced.gguf'].subarray(0, 8)
    );
    const resumeManager = new LanguagePackManager({
      root: resumeRoot,
      releaseApiUrl: 'https://api.test/release',
      fetchImpl: fixtureFetch(fixture, resumeCalls),
      segmentThreshold: 20,
      segmentSize: 8,
      segmentConcurrency: 4,
    });
    const resumed = await resumeManager.install('enhanced');
    assert.deepStrictEqual(
      await fsPromises.readFile(resumed.installed.modelPath),
      fixture.files['enhanced.gguf'],
      'a resumed segmented download must still match the digest'
    );
    const resumedRanges = resumeCalls
      .filter((call) => call.url.endsWith('/enhanced.gguf'))
      .map((call) => call.range)
      .sort();
    assert.deepStrictEqual(resumedRanges, ['bytes=16-19', 'bytes=8-15'], 'the first segment was already on disk');
    await fsPromises.rm(resumeRoot, { recursive: true, force: true });
  } finally {
    await fsPromises.rm(root, { recursive: true, force: true });
  }
  console.log('all language pack tests passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
