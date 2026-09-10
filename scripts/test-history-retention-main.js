'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');
const harness = require('./asr-test-harness');
const insights = require('../src/insights');
const metrics = require('../src/metrics');
const { createHistoryUsage } = require('../src/history-usage');
const plain = value => JSON.parse(JSON.stringify(value));
const NOW = Date.now();

function fixture(count) {
  return Array.from({ length: count }, (_, i) => ({
    id: 'synthetic-' + i, ts: NOW - i * 60000,
    text: i % 2 ? 'Preserve learned words and exact historical totals.' : 'A synthetic voice entry with important vocabulary.',
    original: 'Original voice entry.', durationMs: i % 3 ? 4000 : 600,
    exe: i % 4 ? 'notepad.exe' : 'chrome.exe', title: i % 4 ? 'Note' : 'ChatGPT', category: 'work',
    learnedPairs: i % 7 ? [] : [{ from: 'voxx', to: 'Voxden' }],
    dictionaryHits: i % 3, styleFixes: i % 2,
    rawAsr: 'Old raw transcript.', afterCleanup: 'Old cleanup transcript.',
  }));
}

function wav() {
  const bytes = Buffer.alloc(44 + 32000);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVE', 8);
  bytes.write('fmt ', 12); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(16000, 24); bytes.writeUInt32LE(32000, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36);
  bytes.writeUInt32LE(32000, 40);
  return bytes;
}

async function main() {
  const h = harness();
  try {
    const full = fixture(1205);
    const file = h.run('HIST_FILE');
    h.context.clip = wav();
    h.run(`dictionary.phrases = [{from:'voxx',to:'Voxden',kind:'word',source:'learned'}];
      dictionary.pending = [{from:'pending',to:'Pending'}]; saveDict();
      corpus.park(clip); corpus.claim('synthetic-1204');
      corpus.promote('synthetic-1204', {text:'Corrected training words',asr:'Training original',ts:Date.now()});
      corpus.park(clip); corpus.claim('synthetic-1203');
      corpus.park(clip); corpus.claim('synthetic-2');`);
    const dictFile = h.run('DICT_FILE');
    const dictBefore = fs.readFileSync(dictFile);
    const audioRoot = h.run('AUDIO');
    const trainingBefore = fs.readFileSync(path.join(audioRoot, 'pairs.jsonl'));
    const trainingClipBefore = fs.readFileSync(path.join(audioRoot, 'corpus', 'synthetic-1204.wav'));
    const vocabularyBefore = plain(h.run("vocabulary.rank(currentVocabulary(), { language:'en', recentTerms:vocabulary.recentTermSet(" + JSON.stringify(full) + ",40) })"));
    fs.writeFileSync(file, JSON.stringify({ entries: full }));
    h.run('loadStores(); pruneRecordings();');
    assert.strictEqual(h.run('history.entries.length'), 1000);
    assert.strictEqual(h.run('history.archived.length'), 205);
    assert.strictEqual(h.run('history.entries[999].id'), 'synthetic-999');
    const phrases = plain(h.run('dictionary.phrases'));
    for (const range of ['all', '7d', '30d']) {
      h.context.testNow = NOW;
      h.context.testRange = range;
      const actual = plain(h.run('historyUsage.getInsights(history,dictionary.phrases,historyAnalyticsRevision,{range:testRange},testNow).result'));
      assert.deepStrictEqual(actual, plain(insights.computeInsights(full, phrases, range, NOW)));
    }
    const snapshot = plain(h.run('snapshot()'));
    assert.strictEqual(snapshot.usageStats.dictations, 1205);
    assert.strictEqual(snapshot.wordCount, full.reduce((sum, e) => sum + metrics.countWords(e.text), 0));
    assert.deepStrictEqual(plain(h.run("vocabularyForDictation('en')")), vocabularyBefore, 'personalized prompt ranking is unchanged');
    assert.deepStrictEqual(fs.readFileSync(dictFile), dictBefore, 'dictionary and automatic learning stay byte-for-byte intact');
    assert.deepStrictEqual(fs.readFileSync(path.join(audioRoot, 'pairs.jsonl')), trainingBefore);
    assert.deepStrictEqual(fs.readFileSync(path.join(audioRoot, 'corpus', 'synthetic-1204.wav')), trainingClipBefore);
    assert(!fs.existsSync(path.join(audioRoot, 'recordings', 'synthetic-1203.wav')), 'orphan playback removed');
    assert(fs.existsSync(path.join(audioRoot, 'recordings', 'synthetic-2.wav')), 'retained playback preserved');
    assert(!('archived' in snapshot), 'archive never crosses normal snapshot IPC');
    assert(snapshot.entries.every(entry => !entry.statsOnly));

    const revision = snapshot.analyticsRevision;
    h.run("lastDurationMs=4000; addHistoryEntry('A newly dictated sentence.');");
    assert.strictEqual(h.run('history.entries.length'), 1000);
    assert.strictEqual(h.run('snapshot().usageStats.dictations'), 1206);
    assert(h.run('historyAnalyticsRevision') > revision);
    h.run('loadStores();');
    assert.strictEqual(h.run('snapshot().usageStats.dictations'), 1206, 'restart counts no entry twice');
    const id = h.run('history.entries[0].id');
    await h.handlers.get('history-edit')(null, id, 'An edited sentence with more words.');
    assert.strictEqual(h.run('snapshot().usageStats.dictations'), 1206, 'edit is not a new dictation');
    const latest = plain(h.run('history.entries.concat(history.archived)'));
    const returned = await h.handlers.get('history-insights')(null, { range: 'all' });
    assert.deepStrictEqual(plain(returned.result), plain(insights.computeInsights(latest, plain(h.run('dictionary.phrases')), 'all', returned.computedAt)));
    assert.strictEqual((await h.handlers.get('history-stats')()).dictations, 1206);
    const beforeFailure = plain(h.run('history'));
    const diskBeforeFailure = fs.readFileSync(file);
    const rename = fs.renameSync;
    fs.renameSync = (from, to) => {
      if (to === file) throw new Error('Synthetic primary failure');
      return rename(from, to);
    };
    try {
      assert.throws(() => h.run("addHistoryEntry('This save must fail');"), /Synthetic primary failure/);
      assert.deepStrictEqual(plain(h.run('history')), beforeFailure, 'failed insert must not evict or count');
      assert.deepStrictEqual(fs.readFileSync(file), diskBeforeFailure);
    } finally { fs.renameSync = rename; }

    // Backup failure delays audio cleanup. The next successful save/launch
    // repairs both envelopes before cleanup may proceed.
    const oldest = h.run('history.entries[999].id');
    h.context.oldest = oldest;
    h.run('corpus.park(clip); corpus.claim(oldest);');
    fs.renameSync = (from, to) => {
      if (to === file + '.bak') throw new Error('Synthetic backup failure');
      return rename(from, to);
    };
    try { h.run("addHistoryEntry('A committed dictation with backup pending.');"); }
    finally { fs.renameSync = rename; }
    assert(h.run('history.cleanupPending'));
    assert(fs.existsSync(path.join(audioRoot, 'recordings', oldest + '.wav')));
    h.run('loadStores(); pruneRecordings();');
    assert(!h.run('history.cleanupPending'));
    assert(!fs.existsSync(path.join(audioRoot, 'recordings', oldest + '.wav')));
    assert.strictEqual(h.run('snapshot().usageStats.dictations'), 1207);
    h.run('var finishRetentionRetry; sidecarTranscribe = () => new Promise(resolve => { finishRetentionRetry = resolve; });');
    const retry = h.run("retryEntry('synthetic-2')");
    await h.handlers.get('history-edit')(null, 'synthetic-2', 'A correction made while retry was running.');
    h.run("finishRetentionRetry('A stale recognition result');");
    const retried = await retry;
    assert.strictEqual(retried.ok, false);
    assert.match(retried.reason, /newer correction/);
    assert.strictEqual(h.run('snapshot().usageStats.dictations'), 1207);
    console.log('ok migration/new dictation/restart preserve all Insights, learning, training, stats and recordings boundaries');
  } finally { await h.close(); }

  const optOut = harness();
  try {
    optOut.context.clip = wav();
    optOut.run("addHistoryEntry('A retained recording'); corpus.park(clip); corpus.claim(history.entries[0].id); corpus.parkRetry(clip);");
    const file = optOut.run('HIST_FILE');
    const rename = fs.renameSync;
    fs.renameSync = (from, to) => {
      if (to === file + '.bak') throw new Error('Synthetic locked backup');
      return rename(from, to);
    };
    try { optOut.run('saveHistory();'); }
    finally { fs.renameSync = rename; }
    assert(optOut.run('history.cleanupPending'));
    optOut.run('settings.keepRecordings = false; settings.keepTrainingAudio = false; pruneRecordings();');
    assert.strictEqual(optOut.run('corpus.recordingIds().size'), 0, 'explicit recording opt-out still clears audio with a pending history backup');
    assert.strictEqual(optOut.run('corpus.hasRetry()'), false, 'explicit opt-out also clears retry audio');
  } finally { optOut.close(); }

  // Production summary caching and old qualifying pace samples, without UI
  // or models. Time expiry and clock rollback must update exact rolling data.
  const full = fixture(5000);
  const store = require('../src/history-store').prepare({ entries: full });
  const usage = createHistoryUsage();
  const stats = usage.getStats(store, 1, NOW);
  assert.strictEqual(usage.getStats(store, 1, NOW + 1), stats);
  const ins = usage.getInsights(store, [], 1, { range: '7d' }, NOW);
  assert.strictEqual(usage.getInsights(store, [], 1, { range: '7d' }, NOW + 1), ins);
  for (const now of [NOW + 7 * 86400000 + 1, NOW - 3 * 86400000]) {
    const actual = usage.getInsights(store, [], 1, { range: '7d' }, now);
    assert.deepStrictEqual(actual.result, insights.computeInsights(full, [], '7d', now));
    assert.strictEqual(usage.getStats(store, 1, now).weekWords,
      full.filter(e => e.ts >= now - 7 * 86400000).reduce((sum, e) => sum + metrics.countWords(e.text), 0));
  }
  const scarcePace = fixture(1020);
  scarcePace.slice(0, 1000).forEach(e => { e.durationMs = 200; });
  const scarceStore = require('../src/history-store').prepare({ entries: scarcePace });
  const actualPace = usage.getStats(scarceStore, 2, NOW).paceSamples;
  assert.deepStrictEqual(actualPace.map(e => e.id), scarcePace.filter(metrics.isPaceSample).slice(0, 8).map(e => e.id));
  assert.strictEqual(actualPace.length, 8);

  const large = fixture(10000).map(e => ({...e, text:e.text.repeat(12), original:e.original.repeat(12),
    rawAsr:e.rawAsr.repeat(12), afterCleanup:e.afterCleanup.repeat(12), afterDedupe:e.afterCleanup.repeat(12)}));
  const capped = require('../src/history-store').prepare({ entries: large });
  const fullBytes = Buffer.byteLength(JSON.stringify({ entries: large }, null, 2));
  const cappedBytes = Buffer.byteLength(JSON.stringify(capped));
  const before = performance.now();
  const initial = usage.getStats(capped, 3, NOW);
  const firstMs = performance.now() - before;
  const cachedStart = performance.now();
  for (let i = 0; i < 100; i++) assert.strictEqual(usage.getStats(capped, 3, NOW), initial);
  assert(cappedBytes < fullBytes * 0.5, 'full transcript/intermediate copies are actually removed');
  console.log(JSON.stringify({ fixture: '10000 synthetic multi-stage transcripts', fullBytes, cappedBytes,
    reductionPercent: Math.round((1 - cappedBytes / fullBytes) * 100), firstStatsMs: +firstMs.toFixed(2),
    cached100StatsMs: +(performance.now() - cachedStart).toFixed(2) }));
  console.log('All main history retention tests passed.');
}

main().catch(err => { console.error(err); process.exitCode = 1; });
