'use strict';

// Recordings, and the training pairs made from them.
//
// Every dictation's clip is parked briefly, then claimed by the history entry
// it produced and kept as that entry's recording: what the Dictation page
// plays back, saves as a WAV, and runs through the engine again on a retry.
// Recordings are kept for a fortnight, within a byte budget, and only while
// their entry is still in history. The pruning policy itself is decided by the
// caller, because it depends on settings this module does not read.
//
// A correction is the only moment this app ever learns the ground truth for a
// clip: the user heard themselves, read what the model wrote, and typed what
// they actually said. That is a labelled training pair, if the recording is
// still around -- so promote() moves it into the corpus, where nothing evicts
// it. The corpus is a folder of 16 kHz mono WAVs next to a JSONL manifest,
// which is the shape a Whisper fine-tune wants. Nothing here uploads anything.

const fs = require('fs');
const path = require('path');

// The default retention for recordings: two weeks, half a gigabyte.
const RECORDINGS_MAX_DAYS = 14;
const RECORDINGS_MAX_BYTES = 512 * 1024 * 1024;
// With playback off and training on, recordings are only there to become
// pairs, and most never will, so the window is deliberately small.
const TRAINING_WINDOW_CLIPS = 60;
const TRAINING_WINDOW_BYTES = 200 * 1024 * 1024;
const PARK_TTL_MS = 120000;

let ROOT = null;
let RECORDINGS_DIR = null;
let CORPUS_DIR = null;
let PAIRS_FILE = null;
let PARKED_FILE = null;

function init(audioDir) {
  ROOT = audioDir;
  RECORDINGS_DIR = path.join(ROOT, 'recordings');
  CORPUS_DIR = path.join(ROOT, 'corpus');
  PAIRS_FILE = path.join(ROOT, 'pairs.jsonl');
  PARKED_FILE = path.join(RECORDINGS_DIR, '_last.wav');
  // Builds before playback called this folder "pending". Same clips, same
  // names, so the folder is renamed rather than the clips lost.
  const legacy = path.join(ROOT, 'pending');
  try {
    if (fs.existsSync(legacy) && !fs.existsSync(RECORDINGS_DIR)) fs.renameSync(legacy, RECORDINGS_DIR);
  } catch (_) {}
  invalidate();
  return ROOT;
}

function ready() {
  return Boolean(ROOT);
}

// stats() and recordings() are memoised; every mutation below drops the memos.
let statsCache = null;
let recordingsCache = null;

function invalidate() {
  statsCache = null;
  recordingsCache = null;
}

function ensureDirs() {
  fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
  fs.mkdirSync(CORPUS_DIR, { recursive: true });
}

function safeUnlink(file) {
  try {
    fs.unlinkSync(file);
    return true;
  } catch (_) {
    return false;
  }
}

function statOrNull(file) {
  try {
    return fs.statSync(file);
  } catch (_) {
    return null;
  }
}

// Duration straight from the RIFF header, so a clip recorded at some other
// rate later still reports honestly.
function wavSeconds(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(44);
    const read = fs.readSync(fd, head, 0, 44, 0);
    fs.closeSync(fd);
    if (read < 44 || head.toString('ascii', 0, 4) !== 'RIFF') return 0;
    const byteRate = head.readUInt32LE(28);
    if (!byteRate) return 0;
    const size = statOrNull(file);
    if (!size) return 0;
    return Math.max(0, (size.size - 44) / byteRate);
  } catch (_) {
    return 0;
  }
}

function cleanId(entryId) {
  return String(entryId || '').replace(/[^A-Za-z0-9_-]/g, '');
}

function clipPath(dir, entryId) {
  const id = cleanId(entryId);
  if (!id) return null;
  return path.join(dir, id + '.wav');
}

// --- pairs manifest -----------------------------------------------------

function readPairs() {
  try {
    const raw = fs.readFileSync(PAIRS_FILE, 'utf8');
    const out = [];
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try {
        const rec = JSON.parse(t);
        if (rec && rec.id) out.push(rec);
      } catch (_) {}
    }
    return out;
  } catch (_) {
    return [];
  }
}

function writePairs(records) {
  ensureDirs();
  const body = records.map((r) => JSON.stringify(r)).join('\n');
  fs.writeFileSync(PAIRS_FILE, body ? body + '\n' : '');
}

// --- lifecycle ----------------------------------------------------------

// Hold the clip that was just transcribed. It has no history entry yet, so it
// waits under a fixed name until claim() gives it one.
function park(buffer) {
  if (!ready() || !buffer || !buffer.length) return false;
  try {
    ensureDirs();
    fs.writeFileSync(PARKED_FILE, buffer);
    invalidate();
    return true;
  } catch (_) {
    return false;
  }
}

function dropParked() {
  if (!ready()) return;
  safeUnlink(PARKED_FILE);
}

function retryFile() {
  return ROOT ? path.join(ROOT, 'retry.wav') : null;
}

function parkRetry(buffer) {
  if (!ready() || !buffer || !buffer.length) return false;
  try {
    ensureDirs();
    fs.writeFileSync(retryFile(), buffer);
    return true;
  } catch (_) {
    return false;
  }
}

function retryPath() {
  const file = retryFile();
  if (!file) return null;
  return statOrNull(file) ? file : null;
}

function hasRetry() {
  return Boolean(retryPath());
}

function clearRetry() {
  const file = retryFile();
  if (!file) return false;
  return !statOrNull(file) || safeUnlink(file);
}

// Attach the parked clip to the history entry it became. A stale park means
// the transcript came from somewhere else (the Web Speech fallback carries no
// audio), so it is dropped rather than mislabelled.
function claim(entryId) {
  if (!ready()) return false;
  const target = clipPath(RECORDINGS_DIR, entryId);
  if (!target) return false;
  const stat = statOrNull(PARKED_FILE);
  if (!stat) return false;
  if (Date.now() - stat.mtimeMs > PARK_TTL_MS) {
    safeUnlink(PARKED_FILE);
    return false;
  }
  try {
    fs.renameSync(PARKED_FILE, target);
  } catch (_) {
    safeUnlink(PARKED_FILE);
    return false;
  }
  invalidate();
  return true;
}

// Every kept recording, newest first.
function recordings() {
  if (recordingsCache) return recordingsCache;
  let list = [];
  try {
    list = fs.readdirSync(RECORDINGS_DIR)
      .filter((n) => n.endsWith('.wav') && n !== '_last.wav')
      .map((n) => {
        const file = path.join(RECORDINGS_DIR, n);
        const stat = statOrNull(file);
        return {
          id: n.slice(0, -4),
          file,
          size: stat ? stat.size : 0,
          mtime: stat ? stat.mtimeMs : 0,
        };
      })
      .sort((a, b) => b.mtime - a.mtime);
  } catch (_) {
    list = [];
  }
  recordingsCache = list;
  return list;
}

// Apply a retention policy. Newest recordings are kept first, so whatever a
// cap cuts off is the oldest. Every rule is optional:
//   keepIds  -- an entry no longer in history has no use for its recording
//   maxDays  -- age, from the recording's own timestamp
//   maxBytes -- running total, newest first
//   maxClips -- running count, newest first
// Returns how many were removed.
function prune(policy) {
  if (!ready()) return 0;
  const opts = policy || {};
  const keep = opts.keepIds ? new Set(Array.from(opts.keepIds).map(cleanId)) : null;
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const maxAge = Number(opts.maxDays) > 0 ? Number(opts.maxDays) * 86400000 : null;
  const maxBytes = Number(opts.maxBytes) > 0 ? Number(opts.maxBytes) : null;
  const maxClips = Number(opts.maxClips) > 0 ? Number(opts.maxClips) : null;
  let bytes = 0;
  let kept = 0;
  let removed = 0;
  for (const clip of recordings()) {
    let drop = false;
    if (keep && !keep.has(clip.id)) drop = true;
    else if (maxAge !== null && now - clip.mtime > maxAge) drop = true;
    else {
      kept += 1;
      bytes += clip.size;
      if ((maxClips !== null && kept > maxClips) || (maxBytes !== null && bytes > maxBytes)) drop = true;
    }
    if (drop && safeUnlink(clip.file)) removed += 1;
  }
  if (removed) invalidate();
  return removed;
}

// Where an entry's audio is, if anywhere: a recording still within retention,
// or the corpus copy a correction moved it to.
function recordingPath(entryId) {
  if (!ready()) return null;
  for (const dir of [RECORDINGS_DIR, CORPUS_DIR]) {
    const file = clipPath(dir, entryId);
    if (file && statOrNull(file)) return file;
  }
  return null;
}

function hasRecording(entryId) {
  return Boolean(recordingPath(entryId));
}

// Every entry id that has audio, so a snapshot can flag entries in one pass
// rather than statting a file per card.
function recordingIds() {
  const ids = new Set();
  if (!ready()) return ids;
  for (const clip of recordings()) ids.add(clip.id);
  try {
    for (const n of fs.readdirSync(CORPUS_DIR)) {
      if (n.endsWith('.wav')) ids.add(n.slice(0, -4));
    }
  } catch (_) {}
  return ids;
}

// The user corrected this transcript, so the clip and the corrected text are
// now a labelled pair. Re-editing the same entry updates the pair in place.
function promote(entryId, record) {
  if (!ready()) return false;
  const id = cleanId(entryId);
  if (!id) return false;
  const text = String((record && record.text) || '').trim();
  if (!text) return false;

  const recording = clipPath(RECORDINGS_DIR, id);
  const stored = clipPath(CORPUS_DIR, id);
  try {
    ensureDirs();
    if (statOrNull(recording)) {
      fs.renameSync(recording, stored);
    } else if (!statOrNull(stored)) {
      return false;
    }
  } catch (_) {
    return false;
  }

  const size = statOrNull(stored);
  const pair = {
    id,
    audio: path.posix.join('corpus', id + '.wav'),
    text,
    asr: String((record && record.asr) || ''),
    learned: Array.isArray(record && record.learned) ? record.learned : [],
    seconds: Number(wavSeconds(stored).toFixed(3)),
    bytes: size ? size.size : 0,
    ts: Number((record && record.ts)) || 0,
  };

  try {
    const records = readPairs().filter((r) => r.id !== id);
    records.push(pair);
    writePairs(records);
    invalidate();
  } catch (_) {
    return false;
  }
  return true;
}

// Deleting a dictation deletes its recording too, wherever it got to.
function discard(entryId) {
  if (!ready()) return false;
  const id = cleanId(entryId);
  if (!id) return false;
  let touched = false;
  const recording = clipPath(RECORDINGS_DIR, id);
  const stored = clipPath(CORPUS_DIR, id);
  if (recording && safeUnlink(recording)) touched = true;
  if (stored && safeUnlink(stored)) touched = true;
  try {
    const records = readPairs();
    const next = records.filter((r) => r.id !== id);
    if (next.length !== records.length) {
      writePairs(next);
      touched = true;
    }
  } catch (_) {}
  if (touched) invalidate();
  return touched;
}

// snapshot() runs this on every broadcast, so it is memoised against the
// manifest's mtime rather than re-reading and re-statting the whole corpus.
function stats() {
  if (!ready()) return { pairs: 0, bytes: 0, seconds: 0, pending: 0, pendingBytes: 0 };
  const manifest = statOrNull(PAIRS_FILE);
  const key = manifest ? String(manifest.mtimeMs) + ':' + String(manifest.size) : 'none';
  if (statsCache && statsCache.key === key) return statsCache.value;

  const records = readPairs();
  let bytes = 0;
  let seconds = 0;
  for (const rec of records) {
    bytes += Number(rec.bytes) || 0;
    seconds += Number(rec.seconds) || 0;
  }
  const kept = recordings();
  const value = {
    pairs: records.length,
    bytes,
    seconds: Math.round(seconds),
    // Uncorrected recordings: what a correction could still turn into a pair.
    pending: kept.length,
    pendingBytes: kept.reduce((n, c) => n + c.size, 0),
  };
  statsCache = { key, value };
  return value;
}

// What the privacy pane says about playback recordings.
function recordingStats() {
  const kept = ready() ? recordings() : [];
  return {
    count: kept.length,
    bytes: kept.reduce((n, c) => n + c.size, 0),
  };
}

// Forget the playback recordings. Corpus pairs are the training toggle's to
// keep or drop, so they stay.
function clearRecordings() {
  if (!ready()) return false;
  let cleared = true;
  try {
    for (const name of fs.readdirSync(RECORDINGS_DIR)) {
      if (!safeUnlink(path.join(RECORDINGS_DIR, name))) cleared = false;
    }
  } catch (err) {
    if (err.code !== 'ENOENT') cleared = false;
  }
  invalidate();
  return cleared;
}

// Forget the training pairs, keeping the transcripts and the recordings.
function clearCorpus() {
  if (!ready()) return false;
  let cleared = true;
  try {
    for (const name of fs.readdirSync(CORPUS_DIR)) {
      if (!safeUnlink(path.join(CORPUS_DIR, name))) cleared = false;
    }
  } catch (err) { if (err.code !== 'ENOENT') cleared = false; }
  try {
    const remaining = readPairs().filter(rec => statOrNull(clipPath(CORPUS_DIR, rec.id)));
    if (remaining.length) writePairs(remaining);
    else if (statOrNull(PAIRS_FILE) && !safeUnlink(PAIRS_FILE)) cleared = false;
  } catch (_) { cleared = false; }
  invalidate();
  return cleared;
}

// Forget every recording of every kind, keeping the transcripts.
function clear() {
  if (!ready()) return false;
  clearRecordings();
  clearCorpus();
  return true;
}

module.exports = {
  init,
  ready,
  invalidate,
  park,
  dropParked,
  parkRetry,
  retryPath,
  hasRetry,
  clearRetry,
  claim,
  recordings,
  prune,
  recordingPath,
  hasRecording,
  recordingIds,
  promote,
  discard,
  stats,
  recordingStats,
  clearRecordings,
  clearCorpus,
  clear,
  readPairs,
  writePairs,
  wavSeconds,
  RECORDINGS_MAX_DAYS,
  RECORDINGS_MAX_BYTES,
  TRAINING_WINDOW_CLIPS,
  TRAINING_WINDOW_BYTES,
  PARK_TTL_MS,
};
