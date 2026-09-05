'use strict';

// Synthetic helper messages only: these tests never inspect the active desktop.
const assert = require('assert');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const { createCorrectionObserver, MAX_FIELD_LENGTH } = require('../src/correction-observer');

function fixture(platform = 'win32') {
  const processes = [];
  const timers = new Map();
  const snapshots = [];
  const stops = [];
  const calls = [];
  const observer = createCorrectionObserver({
    onSnapshot: snapshot => snapshots.push(snapshot), onStop: reason => stops.push(reason), scriptPath: 'fixture.ps1',
  }, {
    platform,
    spawn(command, args, options) {
      calls.push({ command, args, options });
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.kills = 0;
      child.kill = () => { child.kills++; };
      child.send = message => child.stdout.write(JSON.stringify(message) + '\n');
      processes.push(child);
      return child;
    },
    setTimeout(fn, ms) { const id = {}; timers.set(id, { fn, ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
  });
  return { observer, processes, timers, snapshots, stops, calls };
}

const initial = { type: 'ready', fieldId: '7:42.1', hwnd: '42', text: 'A synthetic field.' };

(async () => {
  {
    const f = fixture();
    assert.equal(f.processes.length, 0, 'constructing the observer must not observe anything');
    const start = f.observer.start({ hwnd: '42' });
    const child = f.processes[0];
    const line = JSON.stringify(initial);
    child.stdout.write(line.slice(0, 13));
    child.stdout.write(line.slice(13) + '\n');
    assert.deepStrictEqual(await start, { fieldId: initial.fieldId, hwnd: '42', text: initial.text });
    assert.equal(f.snapshots.length, 0, 'initial value is returned, not emitted as a change');
    child.send({ ...initial, type: 'snapshot', text: 'A corrected synthetic field.' });
    child.send({ ...initial, type: 'snapshot', text: 'A corrected synthetic field.' });
    assert.equal(f.snapshots.length, 1, 'unchanged snapshots do not retrigger learning');
    assert.equal(f.calls[0].options.windowsHide, true);
    assert.deepStrictEqual(f.calls[0].options.stdio, ['ignore', 'pipe', 'ignore']);
    assert(f.calls[0].args.includes('-NonInteractive'));
    assert.deepStrictEqual(f.calls[0].args.slice(-2), ['-Hwnd', '42']);
    assert.equal(f.timers.size, 1, 'startup timer is removed after ready');
    f.observer.stop();
    child.send({ ...initial, type: 'snapshot', text: 'Ignored after stop.' });
    child.emit('exit', 0);
    assert.equal(child.kills, 1);
    assert.equal(f.snapshots.length, 1);
    assert.deepStrictEqual(f.stops, ['stopped']);
    assert.equal(f.timers.size, 0);
    console.log('ok correction observer is on demand, returns baseline, streams changes and cleans up');
  }
  {
    const f = fixture();
    for (const hwnd of [undefined, '', '0', '-42', '42;anything', '1e2', '9999999999999999999']) {
      assert.equal(await f.observer.start({ hwnd }), null);
    }
    assert.equal(f.processes.length, 0);
    assert.equal(await fixture('linux').observer.start({ hwnd: '42' }), null);
    console.log('ok correction observer rejects invalid handles and unsupported platforms');
  }
  {
    const f = fixture();
    const old = f.observer.start({ hwnd: '42' });
    const current = f.observer.start({ hwnd: '42' });
    assert.equal(await old, null);
    f.processes[0].send(initial);
    f.processes[1].send(initial);
    assert.equal((await current).fieldId, initial.fieldId);
    f.processes[0].emit('exit', 0);
    f.processes[1].send({ ...initial, type: 'snapshot', text: 'Current session only.' });
    assert.equal(f.snapshots.length, 1);
    f.observer.stop();
    console.log('ok overlapping observation sessions resolve cancellation and ignore stale events');
  }
  for (const message of [
    { ...initial, fieldId: '' },
    { ...initial, hwnd: '43' },
    { ...initial, text: 'x'.repeat(MAX_FIELD_LENGTH + 1) },
    { ...initial, type: 'snapshot' },
    { type: 'stop', reason: 'unsupported' },
  ]) {
    const f = fixture();
    const start = f.observer.start({ hwnd: '42' });
    f.processes[0].send(message);
    assert.equal(await start, null);
    assert.equal(f.processes[0].kills, 1);
    assert.equal(f.snapshots.length, 0);
  }
  for (const difference of [{ fieldId: 'another-field' }, { hwnd: '43' }]) {
    const f = fixture();
    const start = f.observer.start({ hwnd: '42' });
    f.processes[0].send(initial);
    await start;
    f.processes[0].send({ ...initial, ...difference, type: 'snapshot', text: 'Unrelated field.' });
    assert.equal(f.snapshots.length, 0);
    assert.equal(f.processes[0].kills, 1);
  }
  console.log('ok correction observer fails closed on field changes, oversized values and malformed snapshots');
  for (const timeout of [3000, 90000]) {
    const f = fixture();
    const start = f.observer.start({ hwnd: '42' });
    if (timeout === 90000) { f.processes[0].send(initial); await start; }
    [...f.timers.values()].find(timer => timer.ms === timeout).fn();
    if (timeout === 3000) assert.equal(await start, null);
    assert.equal(f.processes[0].kills, 1);
    assert.equal(f.timers.size, 0);
  }
  for (const badOutput of ['not json\n', 'x'.repeat(MAX_FIELD_LENGTH * 6 + 4097)]) {
    const f = fixture();
    const start = f.observer.start({ hwnd: '42' });
    f.processes[0].stdout.write(badOutput);
    assert.equal(await start, null);
    assert.equal(f.processes[0].kills, 1);
  }
  {
    const f = fixture();
    const start = f.observer.start({ hwnd: '42' });
    f.processes[0].emit('error', new Error('synthetic provider startup failure'));
    assert.equal(await start, null);
    assert.deepStrictEqual(f.stops, ['unavailable']);
  }
  console.log('ok correction observer bounds startup, lifetime and protocol buffering');
})().catch(err => { console.error(err); process.exitCode = 1; });
