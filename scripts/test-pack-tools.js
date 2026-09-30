'use strict';

// Tampered binary/source downloads cannot reach extraction or compilation.
// Compilation and archive round trips are checked separately by native Mac CI.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voxden-pack-tools-test-'));
const sourceText = fs.readFileSync(path.join(__dirname, 'prepare-pack-tools.js'), 'utf8');
let checks = 0;

function fixture(platform, { validDownload = false, compileFails = false, auditFails = false, reported = '7-Zip 26.03 test fixture', macIssue = '' } = {}) {
  const dir = fs.mkdtempSync(path.join(root, platform + '-'));
  const target = path.join(dir, 'build', 'pack-tools', platform === 'win32' ? '7za.exe' : '7za');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, 'existing tool');
  const moduleStub = { exports: {} };
  const commands = [];
  const urls = [];
  vm.runInNewContext(sourceText, {
    __dirname: path.join(dir, 'scripts'), module: moduleStub, Buffer, AbortSignal,
    process: { platform, arch: platform === 'darwin' ? 'arm64' : 'x64', env: {} }, console,
    fetch: async url => { urls.push(url); return { ok: true, arrayBuffer: async () => Buffer.from('fixture archive') }; },
    require(name) {
      if (name === '../src/mac-compatibility') return { MINIMUM_MACOS_VERSION: '14.0', macCompatibilityIssue: () => macIssue };
      if (name === 'crypto' && validDownload) return { createHash: () => ({ update() { return this; },
        digest: () => '9cbde5099c6deb73691b0579063da5827522ccbbcba3f0020fd04e8c8c16c0d4' }) };
      if (name === './mac-binary-compatibility') return { assertMacBinaryFloor: directory => {
        commands.push(['audit', directory]);
        if (auditFails) throw new Error('Native dependencies exceed the declared macOS 14.0 minimum');
        assert(fs.existsSync(path.join(directory, '7zz')));
        return { checkedBinaries: 1, minimumSystemVersion: '14.0', highestBinaryMinimum: '14.0.0' };
      } };
      if (name === 'child_process') return { execFileSync(file, args, options) {
        commands.push([file, Array.from(args), options]);
        if (file === 'make') {
          if (compileFails) throw new Error('Compiler failure');
          const output = path.join(options.cwd, 'b', 'm_arm64', '7zz');
          fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, 'compiled fixture');
        }
        // Only the extractor already installed reports the (possibly stale) fixture version.
        return file === target ? reported : '7-Zip 26.03 test fixture';
      } };
      return require(name);
    },
  });
  return { run: moduleStub.exports.main, ensure: moduleStub.exports.ensure, target, commands, urls, dir };
}
function preserved(f) {
  assert.strictEqual(fs.readFileSync(f.target, 'utf8'), 'existing tool');
  assert.deepStrictEqual(fs.readdirSync(path.dirname(f.target)), [path.basename(f.target)], 'failed staging is removed');
}
(async () => {
  try {
    for (const platform of ['win32', 'darwin']) {
      const f = fixture(platform);
      await assert.rejects(f.run(), /SHA-256 mismatch/);
      assert.strictEqual(f.commands.length, 0, 'unverified bytes must not be extracted, compiled or executed');
      preserved(f); checks++;
      console.log('ok ' + platform + ': corrupt download refused before execution; installed tool preserved');
    }
    const mac = fixture('darwin', { validDownload: true });
    await mac.run();
    assert.strictEqual(mac.urls[0], 'https://github.com/ip7z/7zip/releases/download/26.03/7z2603-src.tar.xz');
    const build = mac.commands.find(command => command[0] === 'make');
    assert(build[1].includes('MY_ARCH=-arch arm64 -mmacosx-version-min=14.0'));
    assert.strictEqual(build[2].env.MACOSX_DEPLOYMENT_TARGET, '14.0');
    assert.strictEqual(build[2].timeout, 600000);
    assert.strictEqual(mac.commands[2][0], 'audit', 'deployment audit precedes first execution');
    assert(mac.commands[3][0].endsWith('7zz'));
    assert.strictEqual(mac.commands[3][2].timeout, 10000);
    assert.strictEqual(fs.readFileSync(mac.target, 'utf8'), 'compiled fixture');
    assert(fs.existsSync(path.join(mac.dir, 'dist-test-report', 'mac-pack-tool-compatibility.json')));
    checks++; console.log('ok Mac source build pins version/hash, targets 14.0, audits before execution, and records evidence');
    for (const options of [{ compileFails: true }, { auditFails: true }]) {
      const f = fixture('darwin', { validDownload: true, ...options });
      await assert.rejects(f.run(), /Compiler failure|exceed the declared/);
      preserved(f);
      assert(!f.commands.some(command => command[0].endsWith('7zz')), 'failed or incompatible build cannot execute');
      checks++; console.log('ok failed/incompatible Mac build preserves the installed extractor');
    }
    // npm's entry point: never redo good work, never fail an install.
    const silent = { log() {}, warn() {} };
    const withoutOutput = async run => {
      const real = { log: console.log, warn: console.warn };
      Object.assign(console, silent);
      try { return await run(); } finally { Object.assign(console, real); }
    };
    const skipped = fixture('darwin', { validDownload: true });
    assert.strictEqual(await withoutOutput(() => skipped.ensure({ env: { VOXDEN_SKIP_PACK_TOOLS: '1' } })), false);
    assert.deepStrictEqual([skipped.urls.length, skipped.commands.length], [0, 0], 'the skip switch does nothing');
    checks++; console.log('ok VOXDEN_SKIP_PACK_TOOLS=1 downloads and runs nothing');

    for (const platform of ['win32', 'darwin']) {
      const reused = fixture(platform, { validDownload: true });
      assert.strictEqual(await withoutOutput(() => reused.ensure({ optional: true, env: {} })), false);
      assert.strictEqual(reused.urls.length, 0, 'a current extractor is not downloaded again');
      assert(!reused.commands.some(command => command[0] === 'make'), 'a current extractor is not recompiled');
      assert.strictEqual(fs.readFileSync(reused.target, 'utf8'), 'existing tool');
      checks++; console.log('ok ' + platform + ': an installed 26.03 extractor is reused without download or compile');
    }

    const stale = fixture('darwin', { validDownload: true, reported: '7-Zip 21.07 test fixture' });
    assert.strictEqual(await withoutOutput(() => stale.ensure({ optional: true, env: {} })), true);
    assert.strictEqual(fs.readFileSync(stale.target, 'utf8'), 'compiled fixture', 'an older extractor is replaced');
    const forced = fixture('darwin', { validDownload: true });
    assert.strictEqual(await withoutOutput(() => forced.ensure({ force: true, env: {} })), true);
    assert.strictEqual(fs.readFileSync(forced.target, 'utf8'), 'compiled fixture', '--force rebuilds a current extractor');
    checks++; console.log('ok an outdated extractor and --force both rebuild');

    const failing = { validDownload: false };
    const optionalFailure = fixture('darwin', failing);
    assert.strictEqual(await withoutOutput(() => optionalFailure.ensure({ optional: true, force: true, env: {} })), false);
    preserved(optionalFailure);
    await assert.rejects(fixture('darwin', failing).ensure({ force: true, env: {} }), /SHA-256 mismatch/);
    const unsupported = fixture('darwin', { macIssue: 'Voxden requires an Apple silicon Mac' });
    assert.strictEqual(await withoutOutput(() => unsupported.ensure({ optional: true, force: true, env: {} })), false);
    await assert.rejects(fixture('darwin', { macIssue: 'Voxden requires an Apple silicon Mac' }).ensure({ force: true, env: {} }), /Apple silicon/);
    checks++; console.log('ok postinstall (--optional) warns and continues on failure; packaging (strict) fails');
    console.log('All ' + checks + ' pack tool integrity/build groups passed');
  } finally {
    if (path.dirname(path.resolve(root)) === path.resolve(os.tmpdir()) && path.basename(root).startsWith('voxden-pack-tools-test-')) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
