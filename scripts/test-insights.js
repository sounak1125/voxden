'use strict';

const {
  isAiContext,
  displayBucket,
  computeInsights,
  computeStreaks,
  computeHeatmap,
  computeFixes,
  computeMilestone,
  computeClock,
  computeLength,
  filterByRange,
  wordDiffCount,
} = require('../src/insights');
const { applyDictionary } = require('../src/dictionary');

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

const DAY = 86400000;
const NOW = new Date(2026, 7, 29, 12, 0, 0).getTime();

check('ai context cursor title', isAiContext('cursor.exe', 'Fix bug - Cursor'), true);
check('ai context chatgpt title', isAiContext('chrome.exe', 'ChatGPT - Google Chrome'), true);
check('ai context slack false', isAiContext('slack.exe', 'general - Slack'), false);

check(
  'display bucket ai overrides other',
  displayBucket({ exe: 'chrome.exe', title: 'Claude', category: 'other' }),
  'ai'
);
check(
  'display bucket keeps work',
  displayBucket({ exe: 'slack.exe', title: 'team', category: 'work' }),
  'work'
);

check(
  'empty insights subtitle',
  computeInsights([], [], '7d', NOW).subtitle,
  'No dictations in the last 7 days'
);

const weekEntries = [
  { ts: NOW - 2 * DAY, text: 'hello world', durationMs: 60000, exe: 'cursor.exe', title: 'Cursor', category: 'other', dictionaryHits: 2, styleFixes: 3 },
  { ts: NOW - DAY, text: 'email body here', durationMs: 30000, exe: 'outlook.exe', title: 'Inbox', category: 'email', dictionaryHits: 1, styleFixes: 0 },
];
const ins = computeInsights(weekEntries, [{ from: 'a', to: 'b' }], '7d', NOW);
check('insights dictation count', ins.volume.dictations, 2);
check('insights has timed pace', ins.pace.hasTimed, true);
check('insights where has target', ins.where.withTarget, 2);
check('insights ai bucket present', ins.where.rows.some((r) => r.id === 'ai'), true);
check('insights keeps zero buckets for the chart', ins.where.rows.length, 5);
check('insights counts distinct apps', ins.where.totalApps, 2);
check('insights fixes total', ins.fixes.total, 6);
check('insights average length', ins.length.average, 3);

check('streak single day', computeStreaks([{ ts: NOW }], NOW).currentStreak, 1);
check(
  'streak gap breaks',
  computeStreaks([
    { ts: NOW - 5 * DAY, text: 'a' },
    { ts: NOW, text: 'b' },
  ], NOW).currentStreak,
  1
);
check(
  'streak consecutive',
  computeStreaks([
    { ts: NOW, text: 'a' },
    { ts: NOW - DAY, text: 'b' },
    { ts: NOW - 2 * DAY, text: 'c' },
  ], NOW).currentStreak,
  3
);
check(
  'streak counts yesterday when today is idle',
  computeStreaks([
    { ts: NOW - DAY, text: 'a' },
    { ts: NOW - 2 * DAY, text: 'b' },
  ], NOW).currentStreak,
  2
);

const streaks = computeStreaks([{ ts: NOW, text: 'a' }], NOW);
const heat = computeHeatmap([{ ts: NOW, text: 'one two three' }], NOW, streaks.currentDays);
check('heatmap column count', heat.columns.length, heat.weeks);
check('heatmap rows per column', heat.columns[0].length, 7);
check('heatmap starts on sunday', new Date(heat.columns[0][0].ts).getDay(), 0);
check('heatmap labels months', heat.months.length > 0, true);
check(
  'heatmap marks today in the streak',
  heat.columns[heat.weeks - 1].some((c) => c.inStreak && c.words === 3),
  true
);
check(
  'heatmap marks days after today as future',
  heat.columns[heat.weeks - 1].filter((c) => c.future).length,
  6 - new Date(NOW).getDay()
);

check('milestone reached', computeMilestone(900).text, "You've written a blog post!");
check('milestone next target', computeMilestone(900).next, 'a long essay');
check('milestone below first tier', computeMilestone(10).text, null);
check('milestone progress is bounded', computeMilestone(10).percent <= 100, true);

check('fixes without tracked data', computeFixes([{ ts: NOW, text: 'a' }]).hasData, false);
check('fixes split', computeFixes(weekEntries), { dictionary: 3, style: 3, total: 6, hasData: true });

const clock = computeClock([
  { ts: new Date(2026, 7, 29, 9, 0, 0).getTime() },
  { ts: new Date(2026, 7, 28, 9, 30, 0).getTime() },
  { ts: new Date(2026, 7, 27, 22, 0, 0).getTime() },
]);
check('clock peak hour', clock.peakHour, 9);
check('clock total', clock.total, 3);
check('clock peak is full height', clock.hours[9].percent, 100);
check('clock empty has no peak', computeClock([]).peakHour, null);

check('length longest', computeLength([{ text: 'a b c' }, { text: 'a' }]).longest, 3);

check('word diff identical', wordDiffCount('hello there world', 'hello there world'), 0);
check('word diff substitution', wordDiffCount('vox don is here', 'Voxden is here'), 2);
check('word diff insertion', wordDiffCount('hello world', 'hello big world'), 1);
check('word diff deletion', wordDiffCount('um hello world', 'hello world'), 1);
check('word diff from empty', wordDiffCount('', 'hello world'), 2);
check('word diff both empty', wordDiffCount('', ''), 0);

check('filter 7d', filterByRange(weekEntries, '7d', NOW).length, 2);
check(
  'filter 7d excludes old',
  filterByRange([{ ts: NOW - 20 * DAY, text: 'old' }], '7d', NOW).length,
  0
);

check(
  'dictionary hits meta',
  applyDictionary('open vox don now', [{ from: 'vox don', to: 'Voxden' }], true),
  { text: 'open Voxden now', hits: 1 }
);
check(
  'dictionary hits none',
  applyDictionary('hello world', [{ from: 'vox don', to: 'Voxden' }], true).hits,
  0
);

check(
  'insights no crash without category',
  computeInsights([{ ts: NOW, text: 'hello there' }], [], 'all', NOW).volume.words,
  2
);
check(
  'insights no crash on empty history',
  computeInsights([], [], 'all', NOW).rhythm.currentStreak,
  0
);

if (failed) {
  console.error(failed + ' failed');
  process.exit(1);
}
console.log('all insights tests passed');
