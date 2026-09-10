'use strict';

// Archived facts must be interchangeable with the transcript they replace.
// Exercise the complete result, not only lifetime counters: rolling windows,
// milestone dates, stable ranking ties and vocabulary also depend on history.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const metrics = require('../src/metrics');
const insights = require('../src/insights');
const dictionary = require('../src/dictionary');

const DAY = 86400000;
const NOW = new Date(2026, 8, 10, 12, 34, 56, 789).getTime();
const words = n => Array(n).fill('word').join(' ');
const archive = entries => entries.map(insights.toAnalyticsEntry);
const persisted = value => JSON.parse(JSON.stringify(value));
let comparisons = 0;

function equal(actual, expected, message) {
  assert.deepStrictEqual(actual, expected, message);
  comparisons += 1;
}

function checkEquivalent(entries, at = NOW) {
  const facts = persisted(archive(entries));
  assert.ok(facts.every(insights.isAnalyticsEntry), 'every projected fact survives JSON and validation');
  for (let keep of new Set([0, Math.min(1, entries.length), Math.min(1000, entries.length), entries.length])) {
    const mixed = entries.slice(0, keep).concat(facts.slice(keep));
    equal(metrics.computeMetrics(mixed), metrics.computeMetrics(entries), 'pace and time-saved after retaining ' + keep);
    for (let i = 0; i < entries.length; i++) {
      equal(metrics.entryWordCount(mixed[i]), metrics.countWords(entries[i].text), 'word count for entry ' + i);
      equal(metrics.isPaceSample(mixed[i]), metrics.isPaceSample(entries[i]), 'pace gate for entry ' + i);
    }
    for (const range of ['all', '7d', '30d']) {
      for (const year of [undefined, 2024, 2025, 2026, 2027, 1999]) {
        equal(
          insights.computeInsights(mixed, [{ from: 'vox don', to: 'Voxden' }], range, at, { year }),
          insights.computeInsights(entries, [{ from: 'vox don', to: 'Voxden' }], range, at, { year }),
          'complete insights for ' + range + '/' + year + ', retained ' + keep
        );
      }
    }
    equal(insights.computeStreaks(mixed, at), insights.computeStreaks(entries, at), 'streak day sets');
    equal(insights.computeHeatmap(mixed, at, new Set()), insights.computeHeatmap(entries, at, new Set()), 'heatmap');
    equal(insights.availableYears(mixed, at), insights.availableYears(entries, at), 'available years');
    equal(insights.computeFixes(mixed), insights.computeFixes(entries), 'fix totals and presence');
    equal(insights.wordCloud(mixed, 100), insights.wordCloud(entries, 100), 'word-cloud ranking and weights');
    equal(insights.computeClock(mixed), insights.computeClock(entries), 'local-hour counts');
    equal(insights.computeLength(mixed), insights.computeLength(entries), 'average and longest');
  }
  return facts;
}

const fixture = [
  { id: 'numeric-duration', ts: NOW, text: 'Invoice invoice team', original: 'Invoice team', durationMs: '2000', exe: 'SLACK.EXE', category: 'work', learnedPairs: [{ from: 'teem', to: 'team' }], dictionaryHits: 0, styleFixes: 2 },
  { id: 'ai-host-a', ts: NOW - DAY, text: 'draft draft invoice', original: 'draft draft invoice', durationMs: 1000, exe: 'powershell.exe', title: 'ChatGPT', category: 'personal' },
  { id: 'ai-host-b', ts: NOW - 2 * DAY, text: 'invoice draft alpha', durationMs: 1500, exe: 'chrome.exe', title: 'ChatGPT - Google Chrome', category: 'other', learnedPairs: ['a', 'b'], dictionaryHits: 3 },
  { id: 'case-and-order', ts: NOW - 3 * DAY, text: 'zebra alpha zebra', original: '', durationMs: 3000, exe: 'slack.exe', category: 'email', styleFixes: 0 },
  { id: 'title-only', ts: NOW - 4 * DAY, text: 'Claude helps here', title: 'Claude', learnedPairs: null },
  { id: 'category-only', ts: NOW - 5 * DAY, text: 'other context', category: 'WORK', dictionaryHits: '2', styleFixes: null },
  { id: 'empty-target', ts: NOW - 6 * DAY, text: '\t \n', original: '', durationMs: 1500, exe: '', title: '', category: '', learnedPairs: [] },
  { id: 'missing-metadata', text: 'plain words' },
  { id: 'no-time-app', text: 'untimed app words', exe: 'editor.exe', category: 'work' },
  { id: 'no-text', ts: NOW - 10 * DAY, durationMs: 60000 },
  { id: 'zero-time', ts: 0, text: 'epoch entry', exe: 'editor.exe' },
  { id: 'null-time', ts: null, text: 'untimed words', exe: 'editor.exe' },
  { id: 'unicode', ts: NOW - 15 * DAY, text: "你好 世界 नमस्ते café CAFÉ can't can't naïve 123 constructor __proto__ THE and", original: 'raw', durationMs: 60000, exe: 'C:\\Apps\\MY-EDITOR.EXE', title: 'A private full window title' },
  { id: 'unknown-category', ts: NOW - 20 * DAY, text: 'unknown bucket', category: 'unrecognized', exe: 'unknown.exe' },
  { id: 'ai-category-alone', ts: NOW - 25 * DAY, text: 'category alone', category: 'ai' },
  { id: 'windows-path-ai', ts: NOW - 28 * DAY, text: 'coding words here', exe: 'C:\\Apps\\code.exe', category: 'work' },
  { id: 'old-year', ts: new Date(2025, 11, 31, 23, 59, 59, 999).getTime(), text: words(249), original: words(249), durationMs: 120000, exe: 'editor.exe', dictionaryHits: 4 },
  { id: 'year-crossing', ts: new Date(2025, 11, 31, 23, 59, 59, 998).getTime(), text: words(1), durationMs: 1000, exe: 'editor.exe' },
  { id: 'new-year', ts: new Date(2026, 0, 1).getTime(), text: words(249), durationMs: 120000, exe: 'editor.exe' },
  { id: 'new-year-milestone', ts: new Date(2026, 0, 2).getTime(), text: words(501), durationMs: 180000, exe: 'editor.exe' },
  { id: 'ancient', ts: new Date(2024, 0, 1).getTime(), text: words(1500), durationMs: 600000 },
  { id: 'future', ts: NOW + DAY, text: 'scheduled future timestamp', durationMs: 60000, exe: 'future.exe', category: 'email' },
];

// Exact millisecond cutoffs matter: per-day totals would lose these distinctions.
for (const days of [7, 14, 30, 60]) {
  for (const offset of [-1, 0, 1]) {
    fixture.push({
      id: 'boundary-' + days + '-' + offset,
      ts: NOW - days * DAY + offset,
      text: 'boundary ' + days + ' ' + offset,
      original: 'original boundary',
      durationMs: 1600,
      exe: 'boundary.exe',
      category: offset === 0 ? 'work' : 'email',
      learnedPairs: ['one'],
      dictionaryHits: 1,
    });
  }
}

// No timing, sub-second samples, impossible rates and the exact plausibility
// ceiling retain their different effects on pace and saved typing time.
const timing = [
  { text: 'short words', durationMs: 500 },
  { text: 'three short words', durationMs: 999 },
  { text: 'one two three', durationMs: 1000 },
  { text: 'one two three four', durationMs: 1000 },
  { text: words(220), durationMs: 60000 },
  { text: words(221), durationMs: 60000 },
  { text: 'no duration' },
  { text: 'zero duration', durationMs: 0 },
  { text: 'negative duration', durationMs: -1 },
  { text: 'invalid duration', durationMs: 'unknown' },
  { text: 'infinite duration', durationMs: Infinity },
  { text: 'not a number duration', durationMs: NaN },
  { text: '', durationMs: 120000 },
  { text: 'slow phrase', durationMs: 600000 },
].map((entry, i) => ({ id: 'timing-' + i, ts: NOW - i * 12345, ...entry }));

checkEquivalent([]);
checkEquivalent(fixture);
checkEquivalent(timing);
checkEquivalent(fixture, NOW + 1);
checkEquivalent(fixture, NOW + DAY);
checkEquivalent(fixture, new Date(2027, 0, 1).getTime());

const archivedTiming = archive(timing);
equal(archivedTiming.map(metrics.isPaceSample), timing.map(metrics.isPaceSample), 'all pace gate edge cases');
equal(metrics.computeMetrics(archive([{ text: 'a b', durationMs: 500 }])), metrics.computeMetrics([{ text: 'a b', durationMs: 500 }]), 'subsecond time saved survives independently of pace');
equal(metrics.entryWordCount({ text: 'one two', wordCount: 900, statsOnly: false }), 2, 'full entries ignore cached word counts');
equal(metrics.entryWordCount({ statsOnly: true, wordCount: NaN }), 0, 'invalid compact word count is not propagated');

// Ties have two distinct semantics: frequent terms keep insertion order while
// the cloud uses alphabetical order. App rows retain the final raw exe value.
const tied = [
  { id: 'first', ts: NOW, text: 'zebra apple', exe: 'SLACK.EXE', category: 'work' },
  { id: 'second', ts: NOW - 1, text: 'apple zebra', exe: 'slack.exe', category: 'email' },
  { id: 'third', ts: NOW - 2, text: 'beta gamma delta epsilon', exe: 'teams.exe', category: 'personal' },
];
checkEquivalent(tied);
const tiedResult = insights.computeInsights(archive(tied), [], 'all', NOW);
equal(tiedResult.words, dictionary.frequentTerms(tied, 18), 'frequent terms preserve established dictionary behavior');
equal(tiedResult.wordCloud.slice(0, 2).map(row => row.word), ['apple', 'zebra'], 'word cloud alphabetizes tied counts');
equal(tiedResult.where.apps[0].exe, 'slack.exe', 'raw app spelling follows the last entry in the group');
equal(tiedResult.where.leaderboard.rows.find(row => row.key === 'exe:slack.exe').bucket, 'work', 'equal app bucket counts preserve first occurrence');

const privateEntry = {
  ...fixture[0],
  text: 'A unique transcript sentence with private details',
  original: 'Original private dictated sentence',
  title: 'Private document - Editor',
  verbatim: 'Private raw ASR output',
  pipeline: [{ text: 'private intermediate sentence' }],
  audio: 'private.wav',
  learnedPairs: [{ from: 'private source', to: 'private target' }],
};
const privateFact = insights.toAnalyticsEntry(privateEntry);
for (const field of ['text', 'original', 'title', 'category', 'verbatim', 'pipeline', 'audio', 'learnedPairs']) {
  assert.ok(!(field in privateFact), 'archive omits ' + field);
}
assert.ok(!JSON.stringify(privateFact).includes(privateEntry.text), 'archive contains no complete transcript');
equal(insights.toAnalyticsEntry(privateFact), privateFact, 'projecting an existing fact is idempotent');
equal(insights.toAnalyticsEntry(insights.toAnalyticsEntry({})), insights.toAnalyticsEntry({}), 'missing duration remains idempotent');
equal(privateFact.learnedPairCount, 1, 'learned pairs become only a count');
assert.ok(insights.isAnalyticsEntry(persisted(privateFact)), 'serialized archive passes shared validator');
for (const patch of [
  { text: 'a leaked sentence' }, { title: 'leaked title' }, { wordCount: -1 },
  { wordCount: 1.5 }, { durationMs: '1000' }, { appKey: null }, { appLabel: 4 },
  { bucket: 'unsupported' }, { hasTarget: 1 }, { edited: 'true' },
  { learnedPairCount: -1 }, { dictionaryHits: null }, { styleFixes: Infinity },
  { termCounts: [['private', 0]] }, { termCounts: [['private', 1], ['private', 2]] },
  { termCounts: [['a sentence', 1]] }, { termCounts: [['the', 1]] },
]) {
  assert.strictEqual(insights.isAnalyticsEntry({ ...privateFact, ...patch }), false, 'reject corrupt fact: ' + JSON.stringify(patch));
}

// A busy user can exceed the cap inside a rolling window. Conversion must not
// make the 1,001st record disappear from any metric or vocabulary count.
const busy = Array.from({ length: 1025 }, (_, i) => ({
  id: 'busy-' + i,
  ts: NOW - i * 1000,
  text: i % 2 ? 'busy dictation words' : 'busy repeated repeated',
  original: i % 3 ? 'busy dictation words' : 'raw speech',
  durationMs: 1000 + i % 4 * 100,
  exe: i % 2 ? 'chrome.exe' : 'slack.exe',
  title: i % 2 ? 'ChatGPT' : 'General',
  category: i % 3 ? 'work' : 'email',
  dictionaryHits: i % 4,
  learnedPairs: i % 3 ? [] : ['one'],
}));
checkEquivalent(busy);
const mixedBusy = busy.slice(0, 1000).concat(archive(busy.slice(1000)));
equal(insights.computeInsights(mixedBusy, [], '7d', NOW).volume.dictations, 1025, 'recent totals exceed transcript cap');
for (const mutation of ['edit', 'retry', 'delete']) {
  const changed = busy.map(entry => ({ ...entry }));
  if (mutation === 'delete') changed.splice(5, 1);
  else if (mutation === 'edit') {
    changed[5].text = 'newly corrected shorter sentence';
    changed[5].learnedPairs = [];
  } else {
    changed[5].text = 'retried text with a changed duration and correction count';
    changed[5].durationMs = 8000;
    changed[5].dictionaryHits = 0;
    changed[5].styleFixes = 2;
  }
  checkEquivalent(changed);
}

// Calendar calculations run in the viewing computer's current timezone, not
// the timezone in force when an archived entry was first compacted.
const oldTimezone = process.env.TZ;
try {
  for (const zone of ['UTC', 'America/New_York', 'Asia/Kolkata']) {
    process.env.TZ = zone;
    const dst = [
      Date.UTC(2026, 2, 8, 6, 59, 59, 999), Date.UTC(2026, 2, 8, 7),
      Date.UTC(2026, 10, 1, 5, 59, 59, 999), Date.UTC(2026, 10, 1, 6),
    ].map((ts, i) => ({ id: 'dst-' + i, ts, text: 'calendar event words', durationMs: 1200 }));
    checkEquivalent(dst, Date.UTC(2026, 10, 2, 12));
  }
} finally {
  if (oldTimezone === undefined) delete process.env.TZ;
  else process.env.TZ = oldTimezone;
}

// Both modules are classic scripts in Electron. Verify the browser path uses
// the same term filtering, order, and compact-entry support as CommonJS.
const browser = vm.createContext({});
for (const file of ['metrics.js', 'insights.js']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', file), 'utf8'), browser, { filename: file });
}
browser.fixture = persisted(fixture);
browser.at = NOW;
for (const range of ['all', '7d', '30d']) {
  browser.range = range;
  const result = vm.runInContext('voxdenInsights.computeInsights(fixture.map(voxdenInsights.toAnalyticsEntry), [], range, at)', browser);
  equal(persisted(result), persisted(insights.computeInsights(fixture, [], range, NOW)), 'browser and Node agree for ' + range);
}

console.log('History analytics tests passed (' + comparisons + ' equivalence checks).');
