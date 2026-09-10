'use strict';

const fs = require('fs');
const path = require('path');
const atomicStore = require('./atomic-store');
const insights = require('./insights');

const HISTORY_LIMIT = 1000;
const RETENTION_VERSION = 1;
const validatedFacts = new WeakSet();
const validatedArchives = new WeakSet();
const validatedFiles = new Map();

function storeError(message, code) {
  return Object.assign(new Error(message), { code });
}

function checkVersion(value) {
  if (value && typeof value === 'object'
      && Object.prototype.hasOwnProperty.call(value, 'retentionVersion')
      && value.retentionVersion !== RETENTION_VERSION) {
    throw storeError('This history was saved by an unsupported app version. The saved files were kept.',
      'HISTORY_UNSUPPORTED_VERSION');
  }
}

function isHistory(value) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.entries)) return false;
  if (!value.entries.every(entry => entry && typeof entry === 'object'
      && !Array.isArray(entry) && entry.statsOnly !== true && typeof entry.text === 'string')) return false;
  if (value.retentionVersion === RETENTION_VERSION) {
    return Array.isArray(value.archived);
  }
  // A legacy history has no statistics archive. Do not silently discard an
  // archive from an unrecognized envelope while migrating its transcripts.
  return value.retentionVersion === undefined && value.archived === undefined;
}

function immutableFact(fact) {
  if (validatedFacts.has(fact)) return fact;
  if (!insights.isAnalyticsEntry(fact)) {
    throw storeError('The saved usage statistics are invalid. The saved files were kept.', 'HISTORY_INVALID_STORE');
  }
  // Copy before freezing: callers may still own and edit the input objects.
  // Only these private, deeply immutable facts can bypass future validation.
  const copy = { ...fact, termCounts: Object.freeze(fact.termCounts.map(term => Object.freeze(term.slice()))) };
  Object.freeze(copy);
  validatedFacts.add(copy);
  return copy;
}

function immutableArchive(archive) {
  if (validatedArchives.has(archive)) return archive;
  const copy = Object.freeze(archive.map(immutableFact));
  validatedArchives.add(copy);
  return copy;
}

function validate(value) {
  checkVersion(value);
  if (!isHistory(value)) {
    throw storeError('The saved history or its usage statistics are invalid. The saved files were kept.',
      'HISTORY_INVALID_STORE');
  }
  return value.retentionVersion === RETENTION_VERSION
    ? { ...value, archived: immutableArchive(value.archived) } : value;
}

// This prepares a candidate without changing the caller's committed state.
// Entries are already newest first. Preserving that order also preserves
// equal-timestamp ordering and the tie-breaking used by usage charts.
function prepare(history) {
  const source = validate(history);
  const entries = source.entries.slice(0, HISTORY_LIMIT);
  const dropped = source.entries.slice(HISTORY_LIMIT);
  const archived = dropped.length
    ? immutableArchive(dropped.map(insights.toAnalyticsEntry).concat(source.archived || []))
    : source.archived || immutableArchive([]);
  return { retentionVersion: RETENTION_VERSION, entries, archived };
}

// Persistence status is deliberately not part of the file or IPC payload.
// A committed primary with an out-of-date backup is usable, but the caller
// must postpone dependent recording cleanup until both copies are current.
function withStatus(history, error) {
  Object.defineProperties(history, {
    cleanupPending: { value: Boolean(error), enumerable: false },
    persistenceError: { value: error ? String(error.message || error) : '', enumerable: false },
  });
  return history;
}

function fingerprint(file) {
  try {
    const stat = fs.statSync(file);
    return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function rememberFile(file) {
  try { validatedFiles.set(path.resolve(file), fingerprint(file)); }
  catch (_) { validatedFiles.delete(path.resolve(file)); }
}

function readCandidate(file) {
  let raw;
  let before;
  try {
    before = fingerprint(file);
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { missing: true };
    return { error };
  }
  try {
    const value = JSON.parse(raw);
    // An app downgrade must never replace a newer, otherwise readable store
    // with an older backup or an empty fallback.
    checkVersion(value);
    const accepted = validate(value);
    if (before === fingerprint(file)) validatedFiles.set(path.resolve(file), before);
    return { value: accepted, raw };
  } catch (error) {
    if (error.code === 'HISTORY_UNSUPPORTED_VERSION') throw error;
    return { error };
  }
}

function refreshBackup(file, body, history) {
  try {
    atomicStore.replace(file + '.bak', body);
    return withStatus(history);
  } catch (error) {
    console.warn('Could not refresh history backup:', error.message);
    return withStatus(history, error);
  }
}

function save(file, history) {
  const next = prepare(history);
  // Guard direct save callers too, including another app version having
  // replaced the primary since this process originally loaded its history.
  const current = fingerprint(file);
  if (current !== null && validatedFiles.get(path.resolve(file)) !== current) {
    const existing = readCandidate(file);
    if (existing.error) {
      throw storeError('The history file changed and could not be read safely. The saved files were kept.', 'HISTORY_UNREADABLE');
    }
  }
  // Histograms contain many tiny arrays. Pretty-printing them costs more
  // space than the removed transcripts for ordinary, varied sentences.
  const body = JSON.stringify(next);
  atomicStore.replace(file, body);
  rememberFile(file);
  return refreshBackup(file, body, next);
}

function load(file) {
  const primary = readCandidate(file);
  const backup = readCandidate(file + '.bak');
  if (primary.missing && backup.missing) {
    return withStatus({ retentionVersion: RETENTION_VERSION, entries: [], archived: [] });
  }
  const source = primary.value ? primary : backup;
  if (!source.value) {
    throw storeError('History and its backup could not be read safely. The saved files were kept.',
      'HISTORY_UNREADABLE');
  }
  if (source === backup) console.warn('Recovered history from backup:', file);
  const next = prepare(source.value);
  const body = JSON.stringify(next);
  const needsPrimary = source !== primary || JSON.stringify(source.value) !== JSON.stringify(next);
  if (needsPrimary) {
    try {
      atomicStore.replace(file, body);
      rememberFile(file);
    } catch (error) {
      // Startup remains usable with the original, complete history. Returning
      // a pruned candidate here would make recording cleanup discard audio
      // for transcripts whose migration never reached the committed store.
      console.warn('Could not persist history migration:', error.message);
      // The caller has recovered a complete source, even when the primary
      // was damaged. Permit retrying this exact failed repair on the next
      // save, while still detecting subsequent external file changes.
      rememberFile(file);
      const original = source.value.retentionVersion === RETENTION_VERSION
        ? { retentionVersion: RETENTION_VERSION, entries: source.value.entries.slice(), archived: source.value.archived.slice() }
        : { entries: source.value.entries.slice() };
      return withStatus(original, error);
    }
  }
  if (backup.value && JSON.stringify(backup.value) === JSON.stringify(next)) return withStatus(next);
  return refreshBackup(file, body, next);
}

module.exports = { HISTORY_LIMIT, prepare, load, save };
