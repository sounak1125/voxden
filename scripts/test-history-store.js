'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const historyStore = require('../src/history-store');
const atomicStore = require('../src/atomic-store');
const insights = require('../src/insights');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voxden-history-store-'));
let checks = 0;

function entry(index) {
  return {
    id: 'entry-' + index,
    text: 'Private transcript marker' + index,
    original: 'Original transcript marker' + index,
    rawAsr: 'Raw transcript marker' + index,
    previousText: 'Previous transcript marker' + index,
    afterCleanup: 'Cleanup transcript marker' + index,
    ts: 1800000000000 - index * 60000,
    durationMs: 4000,
    exe: 'chrome.exe',
    title: 'Private window marker' + index,
    category: 'browser',
  };
}

function legacy(count) {
  return { entries: Array.from({ length: count }, (_, index) => entry(index)) };
}

function read(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function seededFile(name, value) {
  const file = path.join(root, name + '.json');
  fs.writeFileSync(file, JSON.stringify(value));
  return file;
}

function check(name, work) {
  work();
  checks += 1;
  console.log('ok ' + name);
}

try {
  check('a new installation starts empty without touching disk', () => {
    const file = path.join(root, 'fresh.json');
    const result = historyStore.load(file);
    assert.deepStrictEqual(result, { retentionVersion: 1, entries: [], archived: [] });
    assert.strictEqual(result.cleanupPending, false);
    assert.strictEqual(fs.existsSync(file), false);
  });

  check('retention handles empty, below-limit, exact-limit, and crossing-limit history without mutation', () => {
    for (const count of [0, 999, 1000, 1001]) {
      const original = legacy(count);
      const before = JSON.stringify(original);
      const prepared = historyStore.prepare(original);
      assert.strictEqual(prepared.entries.length, Math.min(count, 1000));
      assert.strictEqual(prepared.archived.length, Math.max(0, count - 1000));
      assert.strictEqual(JSON.stringify(original), before);
      assert.notStrictEqual(prepared.entries, original.entries);
    }
    assert.strictEqual(historyStore.HISTORY_LIMIT, 1000);
  });

  check('migration preserves existing ordering instead of sorting equal or unusual timestamps', () => {
    const original = legacy(1002);
    original.entries[1001].ts = original.entries[0].ts + 100000;
    const prepared = historyStore.prepare(original);
    assert.deepStrictEqual(prepared.entries.map(row => row.id), original.entries.slice(0, 1000).map(row => row.id));
    assert.deepStrictEqual(prepared.archived.map(row => row.id), ['entry-1000', 'entry-1001']);
  });

  check('a legacy 5000-entry store migrates transcripts and full statistics together in both copies', () => {
    const original = legacy(5000);
    const file = seededFile('migration', original);
    fs.copyFileSync(file, file + '.bak');
    const result = historyStore.load(file);
    assert.strictEqual(result.entries.length, 1000);
    assert.strictEqual(result.archived.length, 4000);
    assert.strictEqual(result.cleanupPending, false);
    assert.strictEqual(result.archived.reduce((sum, row) => sum + row.wordCount, 0), 12000);
    assert.ok(result.archived.every(insights.isAnalyticsEntry));
    assert.deepStrictEqual(read(file), read(file + '.bak'));
    for (const copy of [file, file + '.bak']) {
      const saved = read(copy);
      for (const row of saved.archived) {
        for (const field of ['text', 'original', 'rawAsr', 'previousText', 'afterCleanup', 'title', 'category']) {
          assert.strictEqual(Object.prototype.hasOwnProperty.call(row, field), false, field + ' is absent from archived statistics');
        }
      }
    }
    assert.deepStrictEqual(historyStore.load(file), result);
    assert.deepStrictEqual(historyStore.prepare(result), result);
    assert.strictEqual(historyStore.load(file).archived.length, 4000, 'restarting does not count history twice');
  });

  check('the next dictation retains the newest 1000 and prepends only the new statistics fact', () => {
    const before = historyStore.prepare(legacy(1002));
    const after = historyStore.prepare({ ...before, entries: [entry(-1), ...before.entries] });
    assert.strictEqual(after.entries.length, 1000);
    assert.strictEqual(after.entries[0].id, 'entry--1');
    assert.deepStrictEqual(after.archived.map(row => row.id), ['entry-999', 'entry-1000', 'entry-1001']);
    assert.strictEqual(before.archived.length, 2);
  });

  check('validated facts are immutable private copies without freezing or trusting mutable caller data', () => {
    const mutable = JSON.parse(JSON.stringify(historyStore.prepare(legacy(1001))));
    const sourceFact = mutable.archived[0];
    const result = historyStore.prepare(mutable);
    assert.strictEqual(Object.isFrozen(sourceFact), false);
    assert.strictEqual(Object.isFrozen(sourceFact.termCounts), false);
    assert.notStrictEqual(result.archived[0], sourceFact);
    assert.ok(Object.isFrozen(result.archived));
    assert.ok(Object.isFrozen(result.archived[0]));
    assert.ok(Object.isFrozen(result.archived[0].termCounts));
    assert.ok(Object.isFrozen(result.archived[0].termCounts[0]));
    sourceFact.wordCount = -1;
    assert.strictEqual(result.archived[0].wordCount, 3);
    assert.throws(() => historyStore.prepare(mutable), error => error.code === 'HISTORY_INVALID_STORE');
    sourceFact.wordCount = 3;
    sourceFact.termCounts[0][0] = 'A leaked sentence';
    assert.throws(() => historyStore.prepare(mutable), error => error.code === 'HISTORY_INVALID_STORE');
    const validate = insights.isAnalyticsEntry;
    let validations = 0;
    insights.isAnalyticsEntry = fact => { validations += 1; return validate(fact); };
    try { assert.deepStrictEqual(historyStore.prepare(result), result); }
    finally { insights.isAnalyticsEntry = validate; }
    assert.strictEqual(validations, 0, 'immutable private facts do not repeat full histogram validation');
  });

  check('normal varied sentences use less storage after migration, including their term histograms', () => {
    const text = 'Please send the revised project document tomorrow morning and confirm whether every team member has reviewed these notes before our next meeting';
    const rows = Array.from({ length: 5000 }, (_, index) => ({
      ...entry(index), text, original: text, rawAsr: text, previousText: text,
      afterCleanup: text, afterDedupe: text, afterDictionary: text, afterAutoCleanup: text,
    }));
    const file = seededFile('varied-speech', { entries: rows });
    fs.writeFileSync(file, JSON.stringify({ entries: rows }, null, 2));
    const before = fs.statSync(file).size;
    const result = historyStore.load(file);
    const after = fs.statSync(file).size;
    assert.strictEqual(result.archived.length, 4000);
    assert.ok(after < before * 0.65, 'varied-speech history should shrink materially: ' + after + ' / ' + before);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), JSON.stringify(result), 'the persisted envelope is compact JSON');
    assert.deepStrictEqual(read(file), read(file + '.bak'));
  });

  check('normal saves avoid rereading a trusted unchanged file but detect a later unsupported version', () => {
    const file = path.join(root, 'trusted-fingerprint.json');
    const original = historyStore.save(file, legacy(1001));
    const readFile = fs.readFileSync;
    let reads = 0;
    fs.readFileSync = (target, ...args) => {
      if (target === file) reads += 1;
      return readFile(target, ...args);
    };
    try { historyStore.save(file, original); }
    finally { fs.readFileSync = readFile; }
    assert.strictEqual(reads, 0);
    const future = { retentionVersion: 2, entries: [], archived: [], futureStats: { dictations: 9000 } };
    fs.writeFileSync(file, JSON.stringify(future));
    const primaryBefore = fs.readFileSync(file);
    const backupBefore = fs.readFileSync(file + '.bak');
    assert.throws(() => historyStore.save(file, original), error => error.code === 'HISTORY_UNSUPPORTED_VERSION');
    assert.deepStrictEqual(fs.readFileSync(file), primaryBefore);
    assert.deepStrictEqual(fs.readFileSync(file + '.bak'), backupBefore);
  });

  check('an externally corrupted primary blocks direct saves until explicit backup recovery', () => {
    const file = path.join(root, 'external-corruption.json');
    const original = historyStore.save(file, legacy(1001));
    fs.writeFileSync(file, '{external corruption');
    const primaryBefore = fs.readFileSync(file);
    const backupBefore = fs.readFileSync(file + '.bak');
    assert.throws(() => historyStore.save(file, original), error => error.code === 'HISTORY_UNREADABLE');
    assert.deepStrictEqual(fs.readFileSync(file), primaryBefore);
    assert.deepStrictEqual(fs.readFileSync(file + '.bak'), backupBefore);
    assert.deepStrictEqual(historyStore.load(file), original);
    assert.strictEqual(historyStore.save(file, original).cleanupPending, false);
  });

  check('partial writes preserve the committed primary, backup, and supplied state', () => {
    const file = path.join(root, 'partial.json');
    const original = historyStore.save(file, legacy(1000));
    const primaryBefore = fs.readFileSync(file);
    const backupBefore = fs.readFileSync(file + '.bak');
    const candidate = { ...original, entries: [entry(-1), ...original.entries] };
    const candidateBefore = JSON.stringify(candidate);
    const write = fs.writeFileSync;
    fs.writeFileSync = (target, body, ...args) => {
      if (typeof target === 'number') {
        write(target, String(body).slice(0, 12), ...args);
        throw Object.assign(new Error('No space'), { code: 'ENOSPC' });
      }
      return write(target, body, ...args);
    };
    try { assert.throws(() => historyStore.save(file, candidate), /No space/); }
    finally { fs.writeFileSync = write; }
    assert.deepStrictEqual(fs.readFileSync(file), primaryBefore);
    assert.deepStrictEqual(fs.readFileSync(file + '.bak'), backupBefore);
    assert.strictEqual(JSON.stringify(candidate), candidateBefore);
    assert.strictEqual(fs.readdirSync(root).some(name => name.endsWith('.tmp')), false);
  });

  check('a failed startup migration returns complete history pending a retry, never an empty or pruned fallback', () => {
    const original = legacy(1001);
    const file = seededFile('migration-failure', original);
    const before = fs.readFileSync(file);
    const replace = atomicStore.replace;
    atomicStore.replace = (target, body) => {
      if (target === file) throw new Error('Read-only disk');
      return replace(target, body);
    };
    let result;
    try { result = historyStore.load(file); }
    finally { atomicStore.replace = replace; }
    assert.deepStrictEqual(result, original);
    assert.strictEqual(result.cleanupPending, true);
    assert.match(result.persistenceError, /Read-only disk/);
    assert.deepStrictEqual(fs.readFileSync(file), before);
    assert.strictEqual(historyStore.load(file).entries.length, 1000);
    assert.strictEqual(historyStore.load(file).archived.length, 1);
  });

  check('backup failure keeps committed statistics and reports pending cleanup until a startup repair succeeds', () => {
    const file = seededFile('backup-failure', legacy(1001));
    fs.copyFileSync(file, file + '.bak');
    const backupBefore = fs.readFileSync(file + '.bak');
    const replace = atomicStore.replace;
    atomicStore.replace = (target, body) => {
      if (target === file + '.bak') throw new Error('Backup locked');
      return replace(target, body);
    };
    let result;
    try {
      result = historyStore.save(file, legacy(1001));
      assert.strictEqual(result.cleanupPending, true);
      assert.strictEqual(result.entries.length, 1000);
      assert.strictEqual(result.archived.length, 1);
      assert.strictEqual(historyStore.load(file).cleanupPending, true, 'startup attempts backup repair again');
    } finally { atomicStore.replace = replace; }
    assert.deepStrictEqual(fs.readFileSync(file + '.bak'), backupBefore);
    assert.strictEqual(read(file).entries.length, 1000);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(read(file), 'cleanupPending'), false);
    assert.strictEqual(JSON.stringify(result).includes('Backup locked'), false);
    const repaired = historyStore.load(file);
    assert.strictEqual(repaired.cleanupPending, false);
    assert.deepStrictEqual(read(file), read(file + '.bak'));
  });

  check('the next save also repairs a previously failed backup without double counting', () => {
    const file = path.join(root, 'backup-save-retry.json');
    const replace = atomicStore.replace;
    atomicStore.replace = (target, body) => {
      if (target === file + '.bak') throw new Error('Backup locked');
      return replace(target, body);
    };
    let committed;
    try { committed = historyStore.save(file, legacy(1001)); }
    finally { atomicStore.replace = replace; }
    const result = historyStore.save(file, committed);
    assert.strictEqual(result.cleanupPending, false);
    assert.strictEqual(result.archived.length, 1);
    assert.deepStrictEqual(read(file), read(file + '.bak'));
  });

  check('a corrupt primary recovers complete transcript and statistics state from the current backup', () => {
    const file = path.join(root, 'recovery.json');
    const original = historyStore.save(file, legacy(1002));
    fs.writeFileSync(file, '{broken');
    assert.deepStrictEqual(historyStore.load(file), original);
    assert.deepStrictEqual(read(file), read(file + '.bak'));
  });

  check('recovery from a legacy backup applies retention before publishing it', () => {
    const file = seededFile('legacy-backup', legacy(1002));
    fs.copyFileSync(file, file + '.bak');
    fs.writeFileSync(file, '{broken');
    const result = historyStore.load(file);
    assert.strictEqual(result.entries.length, 1000);
    assert.strictEqual(result.archived.length, 2);
    assert.strictEqual(result.cleanupPending, false);
    assert.deepStrictEqual(read(file), read(file + '.bak'));
  });

  check('invalid statistics do not replace valid backup facts or silently lose lifetime totals', () => {
    const file = path.join(root, 'invalid-statistics.json');
    const original = historyStore.save(file, legacy(1001));
    const invalid = read(file);
    invalid.archived[0].wordCount = -1;
    fs.writeFileSync(file, JSON.stringify(invalid));
    assert.deepStrictEqual(historyStore.load(file), original);
    const withText = read(file);
    withText.archived[0].text = 'An unlimited hidden transcript';
    fs.writeFileSync(file, JSON.stringify(withText));
    assert.deepStrictEqual(historyStore.load(file), original);
  });

  check('two damaged copies fail without writing empty history over either file', () => {
    const file = seededFile('unreadable', { entries: 'broken' });
    fs.writeFileSync(file + '.bak', '{broken backup');
    const primaryBefore = fs.readFileSync(file);
    const backupBefore = fs.readFileSync(file + '.bak');
    assert.throws(() => historyStore.load(file), error => error.code === 'HISTORY_UNREADABLE');
    assert.deepStrictEqual(fs.readFileSync(file), primaryBefore);
    assert.deepStrictEqual(fs.readFileSync(file + '.bak'), backupBefore);
  });

  check('an unrecognized future schema is never overwritten by a fallback or direct save', () => {
    const future = { retentionVersion: 2, entries: [], archived: [], futureStats: { dictations: 5000 } };
    const file = seededFile('future', future);
    fs.writeFileSync(file + '.bak', JSON.stringify(legacy(2)));
    const primaryBefore = fs.readFileSync(file);
    const backupBefore = fs.readFileSync(file + '.bak');
    assert.throws(() => historyStore.load(file), error => error.code === 'HISTORY_UNSUPPORTED_VERSION');
    assert.throws(() => historyStore.save(file, legacy(1)), error => error.code === 'HISTORY_UNSUPPORTED_VERSION');
    assert.deepStrictEqual(fs.readFileSync(file), primaryBefore);
    assert.deepStrictEqual(fs.readFileSync(file + '.bak'), backupBefore);
    assert.throws(() => historyStore.prepare(future), error => error.code === 'HISTORY_UNSUPPORTED_VERSION');
  });

  console.log('all ' + checks + ' history store checks passed');
} finally {
  assert.strictEqual(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(root).startsWith('voxden-history-store-'));
  fs.rmSync(root, { recursive: true, force: true });
}
