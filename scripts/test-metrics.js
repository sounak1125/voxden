'use strict';

const { computeMetrics, formatTimeSaved, formatWpm } = require('../src/metrics');

let failed = 0;
function check(name, got, expected) {
  const g = JSON.stringify(got);
  const e = JSON.stringify(expected);
  if (g !== e) {
    failed += 1;
    console.error('FAIL', name, '\n  expected', e, '\n  got     ', g);
  } else {
    console.log('ok', name);
  }
}

check('no entries', computeMetrics([]), {
  avgWpm: null,
  timeSavedMs: null,
  timedWords: 0,
  totalDurationMs: 0,
  typingWpmBaseline: 40,
});

check('avg wpm', computeMetrics([
  { text: 'one two three four five', durationMs: 60000 },
]).avgWpm, 5);

check('ignores entries without duration', computeMetrics([
  { text: 'hello world', durationMs: 0 },
  { text: 'legacy entry only' },
]).avgWpm, null);

const saved = computeMetrics([
  { text: Array(40).fill('word').join(' '), durationMs: 30000 },
]);
check('time saved ms', saved.timeSavedMs, 30000);

check('format wpm', formatWpm(128), '128');
check('format wpm empty', formatWpm(null), '—');
check('format time sec', formatTimeSaved(45000), '45 sec');
check('format time min', formatTimeSaved(720000), '12 min');
check('format time hrs', formatTimeSaved(4500000), '1.3 hrs');

if (failed) {
  process.exitCode = 1;
  console.error(failed + ' test(s) failed');
} else {
  console.log('All metrics tests passed.');
}
