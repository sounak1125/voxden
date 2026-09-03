'use strict';

// The score-keeping behind "is the flow bar's page still running". Main
// sends pings and destroys the window on a frozen verdict, so a verdict that
// comes too easily tears a healthy bar down and one that never comes leaves
// a dead one up. Both edges are pinned here with a fake clock.

const assert = require('assert');
const { createHealthMonitor, timerLateness } = require('../src/overlay-health');

let passed = 0;
function ok(name, fn) {
  fn();
  passed += 1;
  console.log('ok', name);
}

ok('a fresh monitor is healthy with nothing in flight', () => {
  const m = createHealthMonitor({ timeoutMs: 4000, misses: 3 });
  assert.deepStrictEqual(m.check(0), { status: 'ok', missed: 0, sinceAnswer: null, sinceSent: null });
});

ok('one ping in flight at a time; an answer clears it', () => {
  const m = createHealthMonitor({ timeoutMs: 4000, misses: 3 });
  assert.strictEqual(m.send(0), 1);
  assert.strictEqual(m.send(1000), null, 'a ping still within its time is not re-sent');
  assert.strictEqual(m.check(1000).status, 'waiting');
  assert.strictEqual(m.answer(1, 1500), true);
  const v = m.check(2000);
  assert.strictEqual(v.status, 'ok');
  assert.strictEqual(v.missed, 0);
  assert.strictEqual(v.sinceAnswer, 500);
  assert.strictEqual(v.sinceSent, 2000);
});

ok('three unanswered pings in a row is frozen, and one answer is enough to recover', () => {
  const m = createHealthMonitor({ timeoutMs: 4000, misses: 3 });
  assert.strictEqual(m.send(0), 1);
  // Past its time but not yet replaced: counts as a miss already, so the
  // verdict does not wait for the next ping to change.
  assert.deepStrictEqual([m.check(4000).status, m.check(4000).missed], ['waiting', 1]);
  assert.strictEqual(m.send(5000), 2, 'an expired ping is replaced');
  assert.strictEqual(m.check(5000).missed, 1);
  assert.strictEqual(m.send(10000), 3);
  assert.strictEqual(m.check(10000).missed, 2);
  assert.strictEqual(m.check(13999).status, 'waiting');
  assert.strictEqual(m.check(14000).status, 'frozen');
  assert.strictEqual(m.check(14000).missed, 3);
  assert.strictEqual(m.answer(3, 14001), true);
  assert.strictEqual(m.check(14001).status, 'ok');
  assert.strictEqual(m.check(14001).missed, 0);
});

ok('an answer to a ping that was already replaced does not count', () => {
  const m = createHealthMonitor({ timeoutMs: 100, misses: 3 });
  m.send(0);
  m.send(200);
  assert.strictEqual(m.answer(1, 250), false, 'the page is slow, not back');
  assert.strictEqual(m.check(250).missed, 1);
  assert.strictEqual(m.answer(2, 260), true);
  assert.strictEqual(m.check(260).missed, 0);
});

ok('a busy page that answers late but within time is never a miss', () => {
  const m = createHealthMonitor({ timeoutMs: 4000, misses: 3 });
  for (let t = 0; t < 60000; t += 5000) {
    assert.strictEqual(typeof m.send(t), 'number');
    assert.strictEqual(m.check(t + 3999).status, 'waiting');
    m.answer(m.check(t).missed === 0 ? (t / 5000) + 1 : -1, t + 3999);
    assert.strictEqual(m.check(t + 4000).status, 'ok');
  }
});

ok('reset forgets the pings in flight, not the sequence', () => {
  const m = createHealthMonitor({ timeoutMs: 100, misses: 2 });
  m.send(0);
  m.send(200);
  assert.strictEqual(m.check(400).status, 'frozen');
  m.reset();
  assert.strictEqual(m.check(400).status, 'ok');
  assert.strictEqual(m.send(400), 3, 'the sequence keeps counting so a stale answer stays stale');
});

ok('defaults are the documented ones', () => {
  const m = createHealthMonitor();
  m.send(0);
  assert.strictEqual(m.check(3999).missed, 0);
  assert.strictEqual(m.check(4000).missed, 1);
});

ok('timer lateness is zero on time and on the first tick', () => {
  assert.strictEqual(timerLateness(1000, 0, 5000), 0);
  assert.strictEqual(timerLateness(1000, 1000, 2000), 0);
  assert.strictEqual(timerLateness(1000, 1000, 1990), 0);
  assert.strictEqual(timerLateness(1000, 1000, 2500), 500);
  assert.strictEqual(timerLateness(1000, 1000, 61000), 59000);
});

console.log('overlay health: ' + passed + ' checks passed');
