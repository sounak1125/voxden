'use strict';

const {
  computeMetrics,
  isPaceSample,
  formatTimeSaved,
  formatWpm,
  beginDictationTiming,
  markRecognitionComplete,
  addRewriteDuration,
  markPasteComplete,
  dictationTimingFields,
  formatLatency,
} = require('../src/metrics');

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

// A recording too short to measure is noise, not a fast speaker: three words in
// 0.3s is 600 WPM. It used to be counted, and on a fresh install with only a
// couple of dictations one such reading defined the whole average.
check('ignores sub-second recordings', computeMetrics([
  { text: 'quick clipped tail', durationMs: 300 },
]).avgWpm, null);

// Long enough to measure but still impossible: seven words in one second is
// 420 WPM, a clipped or mismatched reading rather than real speech.
check('ignores impossible rates', computeMetrics([
  { text: 'one two three four five six seven', durationMs: 1000 },
]).avgWpm, null);

// A genuine short dictation -- three words in a full second, 180 WPM -- is kept.
check('counts a real short dictation', computeMetrics([
  { text: 'one two three', durationMs: 1000 },
]).avgWpm, 180);

// The whole point: one bad reading next to a real one cannot move the average.
check('one glitch cannot skew the average', computeMetrics([
  { text: 'four real words counted', durationMs: 2000 },
  { text: 'clipped', durationMs: 200 },
]).avgWpm, 120);

check('isPaceSample rejects a sub-second recording', isPaceSample({ text: 'hi there friend', durationMs: 500 }), false);
check('isPaceSample rejects an impossible rate', isPaceSample({ text: 'a b c d e f g', durationMs: 1000 }), false);
check('isPaceSample accepts a real sample', isPaceSample({ text: 'one two three', durationMs: 1500 }), true);
check('isPaceSample rejects a missing duration', isPaceSample({ text: 'legacy entry only' }), false);

// The reported bug: a fresh user's few dictations are all quick clipped bursts.
// The average is a duration-weighted mean of the per-entry rates, so it can only
// be pulled down by dropping the impossible ones -- the two fast bursts here go,
// leaving the one plausible sample rather than a headline of 232.
check('a run of fast bursts cannot inflate the headline', computeMetrics([
  { text: 'yes lets ship it today', durationMs: 1100 }, // 5 words / 1.1s = 273 wpm, dropped
  { text: 'sounds good to me', durationMs: 1000 },       // 4 words / 1.0s = 240 wpm, dropped
  { text: 'okay done thanks', durationMs: 1000 },        // 3 words / 1.0s = 180 wpm, kept
]).avgWpm, 180);

// Even when every kept sample rides the ceiling, the headline stays at it and
// never climbs past it -- 11 words in 3s is exactly 220 wpm.
check('the average is bounded by the plausible ceiling', computeMetrics([
  { text: Array(11).fill('word').join(' '), durationMs: 3000 },
  { text: Array(11).fill('word').join(' '), durationMs: 3000 },
]).avgWpm, 220);
check('a sample one word over the ceiling is dropped', isPaceSample({ text: Array(12).fill('word').join(' '), durationMs: 3000 }), false);

// Time saved is not gated by the pace filter: a fresh user whose only dictations
// are too short to time for pace still gets credit for the typing they skipped.
const shortOnly = computeMetrics([
  { text: 'okay', durationMs: 400 },        // 1 word
  { text: 'yes thanks', durationMs: 600 },  // 2 words
]);
check('short dictations still save time', shortOnly.timeSavedMs, 3500); // (3/40)*60000 - 1000
check('short dictations do not report a pace', shortOnly.avgWpm, null);
check('short dictations leave the pace basis empty', shortOnly.timedWords, 0);

const saved = computeMetrics([
  { text: Array(40).fill('word').join(' '), durationMs: 30000 },
]);
check('time saved ms', saved.timeSavedMs, 30000);

check('format wpm', formatWpm(128), '128');
check('format wpm empty', formatWpm(null), '—');
check('format time sec', formatTimeSaved(45000), '45 sec');
check('format time min', formatTimeSaved(720000), '12 min');
check('format time hrs', formatTimeSaved(4500000), '1.3 hrs');

const latency = beginDictationTiming(1000);
markRecognitionComplete(latency, 2500, 1234.4);
addRewriteDuration(latency, 2100.6);
markPasteComplete(latency, 4800, 4950);
check('dictation timing fields', dictationTimingFields(latency), {
  recognitionMs: 1500,
  modelRecognitionMs: 1234,
  rewriteMs: 2101,
  pasteMs: 150,
  postProcessMs: 199,
  stopToPasteMs: 3950,
});
check('recognition is marked once', markRecognitionComplete(latency, 9000, 8000).recognitionMs, 1500);
check('timing requires a completed paste', dictationTimingFields(beginDictationTiming(1)), {});
check('format latency ms', formatLatency(842), '842 ms');
check('format latency seconds', formatLatency(1476), '1.48 s');

if (failed) {
  process.exitCode = 1;
  console.error(failed + ' test(s) failed');
} else {
  console.log('All metrics tests passed.');
}
