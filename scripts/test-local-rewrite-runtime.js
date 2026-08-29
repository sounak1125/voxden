'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { LocalRewriteRuntime } = require('../src/local-rewrite-runtime');

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voxden-runtime-'));
  const executable = path.join(root, 'llama-server.exe');
  const model = path.join(root, 'model.gguf');
  fs.writeFileSync(executable, 'fake');
  fs.writeFileSync(model, 'fake model');
  let spawnCount = 0;
  let spawnArgs = null;
  let killed = false;
  const runtime = new LocalRewriteRuntime({
    startTimeoutMs: 3000,
    fetchImpl: async () => ({ ok: spawnCount > 0 }),
    spawnImpl: (_command, args, options) => {
      spawnCount += 1;
      spawnArgs = { args, options };
      const child = new EventEmitter();
      child.kill = () => {
        killed = true;
        child.emit('exit', 0);
      };
      return child;
    },
  });
  try {
    const installed = {
      packId: 'standard-test-v1',
      runtimePath: executable,
      runtimeDir: root,
      modelPath: model,
      modelAlias: 'voxden-standard',
    };
    const first = await runtime.ensureStarted(installed);
    assert.match(first.endpoint, /^http:\/\/127\.0\.0\.1:\d+\/v1\/chat\/completions$/);
    assert.strictEqual(first.model, 'voxden-standard');
    assert.strictEqual(spawnCount, 1);
    assert.ok(spawnArgs.args.includes('--model'));
    assert.ok(spawnArgs.args.includes(model));
    assert.ok(spawnArgs.args.includes('--host'));
    assert.ok(spawnArgs.args.includes('--api-key'));
    assert.match(first.apiKey, /^[a-f0-9]{48}$/);
    assert.strictEqual(spawnArgs.options.windowsHide, true);

    const second = await runtime.ensureStarted(installed);
    assert.strictEqual(second.endpoint, first.endpoint);
    assert.strictEqual(spawnCount, 1, 'a healthy runtime must be reused');
    await runtime.stop();
    assert.strictEqual(killed, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log('all local rewrite runtime tests passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
