'use strict';

// The diagnostic log has one job -- still be there, and still be readable,
// after whatever it was meant to explain -- and one way to fail at it that
// matters: growing without bound on a machine that freezes a lot.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createDiagLog } = require('../src/diag');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voxden-diag-'));
const file = path.join(root, 'nested', 'flow-bar.log');

let passed = 0;
function ok(name, fn) {
  fn();
  passed += 1;
  console.log('ok', name);
}

ok('lines are JSON, timestamped, and the directory is made on demand', () => {
  let t = 0;
  const log = createDiagLog({ file, now: () => new Date(1700000000000 + (t++) * 1000) });
  log.log('renderer-gone', { reason: 'crashed', exitCode: 5, mode: 'idle' });
  log.log('overlay-recreate', { reason: 'renderer-gone', count: 1 });
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.deepStrictEqual(lines[0], { ts: '2023-11-14T22:13:20.000Z', event: 'renderer-gone', reason: 'crashed', exitCode: 5, mode: 'idle' });
  assert.deepStrictEqual(lines[1], { ts: '2023-11-14T22:13:21.000Z', event: 'overlay-recreate', reason: 'renderer-gone', count: 1 });
});

ok('a log that passes its cap rolls once and keeps going', () => {
  const capped = path.join(root, 'capped.log');
  const log = createDiagLog({ file: capped, maxBytes: 4096 });
  for (let i = 0; i < 200; i++) log.log('main-stall', { lateMs: 2000 + i, mode: 'idle' });
  assert.ok(fs.existsSync(capped + '.1'), 'the full file is rolled aside');
  assert.ok(fs.statSync(capped).size <= 4096, 'the live file starts again under the cap');
  assert.ok(fs.statSync(capped + '.1').size <= 4096 + 100, 'the rolled file is about the cap');
  const last = fs.readFileSync(capped, 'utf8').trim().split('\n').pop();
  assert.strictEqual(JSON.parse(last).lateMs, 2199, 'nothing is lost across the roll');
});

ok('a value that cannot be serialised does not lose the event', () => {
  const log = createDiagLog({ file: path.join(root, 'odd.log') });
  const loop = {};
  loop.self = loop;
  log.log('odd', { loop });
  const line = JSON.parse(fs.readFileSync(path.join(root, 'odd.log'), 'utf8').trim());
  assert.strictEqual(line.event, 'odd');
});

ok('no file means no writes and no throw', () => {
  const log = createDiagLog({});
  log.log('anything', { n: 1 });
  assert.strictEqual(log.file, '');
});

fs.rmSync(root, { recursive: true, force: true });
console.log('diag log: ' + passed + ' checks passed');
