'use strict';

const {
  isAiContext,
  displayBucket,
  computeInsights,
  computeStreaks,
  filterByRange,
  milestoneText,
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

const NOW = Date.UTC(2026, 7, 29, 12, 0, 0);

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

check('empty insights subtitle', computeInsights([], [], '7d', NOW).subtitle, 'No dictations this week');

const weekEntries = [
  { ts: NOW - 2 * 86400000, text: 'hello world', durationMs: 60000, exe: 'cursor.exe', title: 'Cursor', category: 'other' },
  { ts: NOW - 86400000, text: 'email body here', durationMs: 30000, exe: 'outlook.exe', title: 'Inbox', category: 'email' },
];
const ins = computeInsights(weekEntries, [{ from: 'a', to: 'b' }], '7d', NOW);
check('insights dictation count', ins.volume.dictations, 2);
check('insights has timed pace', ins.pace.hasTimed, true);
check('insights where has target', ins.where.withTarget, 2);
check('insights ai bucket present', ins.where.rows.some((r) => r.id === 'ai'), true);

check('streak single day', computeStreaks([{ ts: NOW }], NOW).currentStreak, 1);
check(
  'streak gap breaks',
  computeStreaks([
    { ts: NOW - 5 * 86400000, text: 'a' },
    { ts: NOW, text: 'b' },
  ], NOW).currentStreak,
  1
);
check(
  'streak consecutive',
  computeStreaks([
    { ts: NOW, text: 'a' },
    { ts: NOW - 86400000, text: 'b' },
    { ts: NOW - 2 * 86400000, text: 'c' },
  ], NOW).currentStreak,
  3
);

check('milestone pages', milestoneText(500), 'About 2 pages of writing');
check('filter 7d', filterByRange(weekEntries, '7d', NOW).length, 2);
check(
  'filter 7d excludes old',
  filterByRange([{ ts: NOW - 20 * 86400000, text: 'old' }], '7d', NOW).length,
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

if (failed) {
  console.error(failed + ' failed');
  process.exit(1);
}
console.log('all insights tests passed');
