'use strict';
const assert = require('assert');
const { createCorrectionTracker, correctionPairs, locateInsertion, SETTLE_MS } = require('../src/correction-learning');

function fixture(before = '', text = 'Please use cooper netties today.') {
  let clock = 0;
  let nextTimer = 0;
  const timers = new Map();
  const learned = [];
  let stops = 0;
  const tracker = createCorrectionTracker({
    initial: { text: before, fieldId: 'editor', hwnd: '42' }, text,
    onPairs: pairs => learned.push(...pairs), onStop: () => stops++, now: () => clock,
    delay: (fn, ms) => { const id = ++nextTimer; timers.set(id, { fn, at: clock + ms }); return id; },
    cancel: id => timers.delete(id),
  });
  return { tracker, learned,
    observe: (value, fieldId = 'editor', hwnd = '42') => tracker.observe({ text: value, fieldId, hwnd }),
    tick(ms = SETTLE_MS) { clock += ms; for (const [id, job] of [...timers]) if (job.at <= clock) { timers.delete(id); job.fn(); } },
    get stops() { return stops; },
  };
}

let f = fixture('Draft: old text\nSignature');
f.observe('Draft: Please use cooper netties today.\nSignature');
f.observe('Draft: Please use Kubernetes today.\nSignature');
assert.deepStrictEqual(f.learned, [], 'do not learn mid-keystroke');
f.tick();
assert.deepStrictEqual(f.learned, [{ from: 'cooper netties', to: 'Kubernetes' }]);
f.observe('Draft: Please use Kubernetes today.!\nSignature');
f.tick();
assert.strictEqual(f.learned.length, 1, 'same correction is not learned twice');

f = fixture();
f.observe('Please use cooper netties today.');
f.observe('Please use Kubernete today.');
f.tick(1000);
f.observe('Please use Kubernetes today.');
f.tick(1000);
assert.deepStrictEqual(f.learned, []);
f.tick(800);
assert.strictEqual(f.learned[0].to, 'Kubernetes', 'only the settled spelling is learned');

for (const loss of ['field', 'window', 'clear', 'cancel', 'expired']) {
  f = fixture();
  f.observe('Please use cooper netties today.');
  f.observe('Please use Kubernetes today.');
  if (loss === 'field') f.observe('private field', 'another-editor');
  if (loss === 'window') f.observe('private field', 'editor', '99');
  if (loss === 'clear') f.observe('');
  if (loss === 'cancel') f.tracker.stop();
  if (loss === 'expired') { f.tick(1000); f.tick(89000); f.observe('Please use Kubernetes today.'); }
  if (loss !== 'expired') { f.tick(); assert.deepStrictEqual(f.learned, [], loss + ' discards pending text'); }
  assert.strictEqual(f.tracker.active, false, loss + ' stops observation');
}

f = fixture('Existing prefix: ');
f.observe('Existing prefix: Please use cooper netties today.');
f.observe('Edited prefix: Please use Kubernetes today.');
f.tick();
assert.strictEqual(f.tracker.active, false);
assert.deepStrictEqual(f.learned, [], 'unrelated field edits are never diffed as dictation');

f = fixture('same old field');
f.observe('some unrelated newly typed text');
f.observe('Please use Kubernetes today.');
f.tick();
assert.deepStrictEqual(f.learned, [], 'a confirmed paste is required');

f = fixture();
f.observe('Please use cooper netties today.');
f.observe('Please use cooper netties today. Add Kubernetes to our plan.');
f.tick();
assert.deepStrictEqual(f.learned, [], 'ordinary typing after dictation is not a correction');
assert.deepStrictEqual(correctionPairs('Meet Bob.', 'Meet Bob!'), []);
assert.deepStrictEqual(correctionPairs('Bring the blue box tomorrow.', 'Send her all the files tonight.'), []);
assert.deepStrictEqual(correctionPairs('Use 1234.', 'Use 4321.'), []);
assert.deepStrictEqual(correctionPairs('Email jane@example.com', 'Email june@example.com'), []);
assert.deepStrictEqual(correctionPairs('hello '.repeat(251), 'hallo '.repeat(251)), []);
assert.deepStrictEqual(correctionPairs('Use voxdin today.', 'Use Voxden today.'), [{ from: 'voxdin', to: 'Voxden' }]);
assert.deepStrictEqual(correctionPairs('मेरा नम सौनक है', 'मेरा नम सौनाक है'), [{ from: 'सौनक', to: 'सौनाक' }]);
assert.deepStrictEqual(locateInsertion('xx', 'xxx', 'x'), null, 'ambiguous repeated pastes are skipped');
assert.deepStrictEqual(locateInsertion('Earlier word. ', 'Earlier word. word.', 'word.'), { prefix: 'Earlier word. ', suffix: '' });

f = fixture('Draft:\r\n', 'Use voxdin today.');
f.observe('Draft:\r\nUse voxdin today.');
f.observe('Draft:\nUse Voxden today.');
f.tick();
assert.strictEqual(f.learned[0].to, 'Voxden');
console.log('ok correction learning: paste scope, stable edits, focus/clear cancellation, normal typing, Unicode and bounds');
