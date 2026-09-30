'use strict';

// A tampered download must never reach an extractor or replace a working tool.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voxden-pack-tools-test-'));
const target = path.join(root, 'build', 'pack-tools', '7za.exe');
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, 'existing tool');
const moduleStub = { exports: {} };
let executions = 0;
vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'prepare-pack-tools.js'), 'utf8'), {
  __dirname: path.join(root, 'scripts'), module: moduleStub, Buffer, AbortSignal,
  process: { platform: 'win32', arch: 'x64' }, console,
  fetch: async () => ({ ok: true, arrayBuffer: async () => Buffer.from('tampered archive') }),
  require(name) {
    if (name === 'child_process') return { execFileSync() { executions++; } };
    return require(name);
  },
});
(async () => {
  try {
    await assert.rejects(moduleStub.exports.main(), /SHA-256 mismatch/);
    assert.strictEqual(executions, 0, 'unverified bytes must not be extracted or executed');
    assert.strictEqual(fs.readFileSync(target, 'utf8'), 'existing tool');
    assert.deepStrictEqual(fs.readdirSync(path.dirname(target)), ['7za.exe'], 'failed download staging is removed');
    console.log('Pack tool integrity: corrupt download rejected, no execution, existing binary preserved.');
  } finally {
    if (path.dirname(path.resolve(root)) === path.resolve(os.tmpdir()) && path.basename(root).startsWith('voxden-pack-tools-test-')) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
