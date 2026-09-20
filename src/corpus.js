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
// A dictation that never became a transcript has no entry to claim its clip,
// and used to lose it. Those clips go to the recovery shelf instead, with their
// own manifest because they have no entry to hang anything off, and they stay
// there until the user recovers the words or deletes the clip.
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
// The recovery shelf. Deliberately smaller than the recordings budget: these
// are clips nobody has read yet, and a broken engine or a dead microphone can
// produce them all day without the user noticing.
const RECOVERY_MAX_DAYS = 14;
const RECOVERY_MAX_CLIPS = 25;
const RECOVERY_MAX_BYTES = 200 * 1024 * 1024;

let ROOT = null;
let RECORDINGS_DIR = null;
let CORPUS_DIR = null;
let RECOVERY_DIR = null;
let PAIRS_FILE = null;
let RECOVERY_FILE = null;
let PARKED_FILE = null;

function init(audioDir) {
  ROOT = audioDir;
  RECORDINGS_DIR = path.join(ROOT, 'recordings');
  CORPUS_DIR = path.join(ROOT, 'corpus');
  RECOVERY_DIR = path.join(ROOT, 'recovery');
  PAIRS_FILE = path.join(ROOT, 'pairs.jsonl');
  RECOVERY_FILE = path.join(ROOT, 'recovery.jsonl');
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
let recoveriesCache = null;

function invalidate() {
  statsCache = null;
  recordingsCache = null;
  recoveriesCache = null;
}

function ensureDirs() {
  fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
  fs.mkdirSync(CORPUS_DIR, { recursive: true });
  fs.mkdirSync(RECOVERY_DIR, { recursive: true });
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
  return readJsonl(PAIRS_FILE);
}

function writePairs(records) {
  ensureDirs();
  const body = records.map((r) => JSON.stringify(r)).join('\n');
  fs.writeFileSync(PAIRS_FILE, body ? body + '\n' : '');
}

// --- recovery manifest --------------------------------------------------

function readJsonl(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
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

function readRecoveryRecords() {
  return readJsonl(RECOVERY_FILE);
}

function writeRecoveryRecords(records) {
  ensureDirs();
  const body = records.map((r) => JSON.stringify(r)).join('\n');
  fs.writeFileSync(RECOVERY_FILE, body ? body + '\n' : '');
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

// --- recovery shelf -----------------------------------------------------

function recoveryId() {
  return 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// Take the clip the failed dictation left in the retry slot and shelve it.
// The bytes are moved, not copied: the retry slot belongs to the session that
// is running, and the session that recorded this one is over.
//
// The manifest is written after the move, so a failure to write it leaves a
// clip the user can still play and recover -- just without the reason text.
// recoveries() reads the folder, not the manifest, for exactly that reason.
function keepFailure(meta) {
  if (!ready()) return null;
  const source = retryPath();
  if (!source) return null;
  const id = recoveryId();
  const target = clipPath(RECOVERY_DIR, id);
  if (!target) return null;
  try {
    ensureDirs();
    fs.renameSync(source, target);
  } catch (_) {
    return null;
  }
  const stat = statOrNull(target);
  const record = Object.assign({}, meta || {}, {
    id,
    ts: Date.now(),
    bytes: stat ? stat.size : 0,
    seconds: Math.round(wavSeconds(target) * 10) / 10,
  });
  try {
    writeRecoveryRecords(readRecoveryRecords().concat(record));
  } catch (_) {}
  invalidate();
  return id;
}

// Every shelved clip, newest first, each with whatever the manifest knows
// about it. The underscore prefix is the live clip below, which is not a
// recovery until the launch after the crash that left it behind.
function recoveries() {
  if (recoveriesCache) return recoveriesCache;
  const meta = new Map();
  if (ready()) {
    for (const rec of readRecoveryRecords()) meta.set(cleanId(rec.id), rec);
  }
  let list = [];
  try {
    list = fs.readdirSync(RECOVERY_DIR)
      .filter((n) => n.endsWith('.wav') && !n.startsWith('_'))
      .map((n) => {
        const id = n.slice(0, -4);
        const file = path.join(RECOVERY_DIR, n);
        const stat = statOrNull(file);
        const rec = meta.get(id) || {};
        return {
          id,
          file,
          size: stat ? stat.size : 0,
          mtime: stat ? stat.mtimeMs : 0,
          ts: Number(rec.ts) || (stat ? stat.mtimeMs : 0),
          seconds: Number(rec.seconds) || Math.round(wavSeconds(file) * 10) / 10,
          reason: String(rec.reason || ''),
          source: rec.source === 'crash' ? 'crash' : 'failure',
          engine: String(rec.engine || ''),
          exe: String(rec.exe || ''),
          title: String(rec.title || ''),
        };
      })
      .sort((a, b) => b.ts - a.ts);
  } catch (_) {
    list = [];
  }
  recoveriesCache = list;
  return list;
}

function recoveryPath(id) {
  if (!ready()) return null;
  const file = clipPath(RECOVERY_DIR, id);
  return file && statOrNull(file) ? file : null;
}

// Drop the manifest records that no longer have a clip beside them. Every
// removal path goes through here, so the manifest cannot outgrow the folder.
function forgetRecoveries(ids) {
  const gone = new Set(Array.from(ids).map(cleanId));
  if (!gone.size) return;
  try {
    const records = readRecoveryRecords();
    const next = records.filter((r) => !gone.has(cleanId(r.id)));
    if (next.length !== records.length) writeRecoveryRecords(next);
  } catch (_) {}
}

function dropRecovery(id) {
  if (!ready()) return false;
  const file = clipPath(RECOVERY_DIR, id);
  if (!file) return false;
  const removed = !statOrNull(file) || safeUnlink(file);
  forgetRecoveries([id]);
  invalidate();
  return removed;
}

// The recovered clip becomes its entry's recording: playable, savable,
// retryable, and a training pair the moment the user corrects it.
function adoptRecovery(id, entryId) {
  if (!ready()) return false;
  const source = recoveryPath(id);
  const target = clipPath(RECORDINGS_DIR, entryId);
  if (!source || !target) return false;
  try {
    ensureDirs();
    fs.renameSync(source, target);
  } catch (_) {
    return false;
  }
  forgetRecoveries([id]);
  invalidate();
  return true;
}

// Same policy shape as prune(), over the shelf. Newest first, so a cap cuts
// off the oldest.
function pruneRecoveries(policy) {
  if (!ready()) return 0;
  const opts = policy || {};
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const maxAge = Number(opts.maxDays) > 0 ? Number(opts.maxDays) * 86400000 : null;
  const maxBytes = Number(opts.maxBytes) > 0 ? Number(opts.maxBytes) : null;
  const maxClips = Number(opts.maxClips) > 0 ? Number(opts.maxClips) : null;
  let bytes = 0;
  let kept = 0;
  const removed = [];
  for (const clip of recoveries()) {
    let drop = false;
    if (maxAge !== null && now - clip.ts > maxAge) drop = true;
    else {
      kept += 1;
      bytes += clip.size;
      if ((maxClips !== null && kept > maxClips) || (maxBytes !== null && bytes > maxBytes)) drop = true;
    }
    if (drop && safeUnlink(clip.file)) removed.push(clip.id);
  }
  if (removed.length) {
    forgetRecoveries(removed);
    invalidate();
  }
  return removed.length;
}

function clearRecoveries() {
  if (!ready()) return false;
  let cleared = true;
  try {
    for (const name of fs.readdirSync(RECOVERY_DIR)) {
      if (!safeUnlink(path.join(RECOVERY_DIR, name))) cleared = false;
    }
  } catch (err) {
    if (err.code !== 'ENOENT') cleared = false;
  }
  try {
    if (statOrNull(RECOVERY_FILE) && !safeUnlink(RECOVERY_FILE)) cleared = false;
  } catch (_) { cleared = false; }
  invalidate();
  return cleared;
}

// --- the live clip ------------------------------------------------------
//
// Everything above needs the recording to have finished. A power cut or a
// crash while the user is still talking has no finished recording: the audio
// exists only in the renderer's memory, and used to die with it.
//
// So a long dictation also writes itself to disk as it goes. The header is
// written with zero sizes, because the length is not known until the clip
// stops and a clip that stops properly deletes this file anyway. Only a
// session that never ended leaves one behind, and the launch that finds it
// repairs the header and shelves it.

// Two seconds of audio. Below that a recovered clip is a throat-clear, and
// offering it back is noise.
const LIVE_MIN_SECONDS = 2;

function liveFile() {
  return RECOVERY_DIR ? path.join(RECOVERY_DIR, '_live.wav') : null;
}

function wavHeader(sampleRate, dataBytes) {
  const head = Buffer.alloc(44);
  head.write('RIFF', 0, 'ascii');
  head.writeUInt32LE(dataBytes ? 36 + dataBytes : 0, 4);
  head.write('WAVE', 8, 'ascii');
  head.write('fmt ', 12, 'ascii');
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(sampleRate, 24);
  head.writeUInt32LE(sampleRate * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write('data', 36, 'ascii');
  head.writeUInt32LE(dataBytes || 0, 40);
  return head;
}

// Append 16-bit mono PCM to the clip being recorded, starting it if this is
// the first block. Returns false rather than throwing: losing the insurance
// copy must never take the dictation down with it.
function appendLive(buffer, sampleRate) {
  if (!ready() || !buffer || !buffer.length) return false;
  const file = liveFile();
  if (!file) return false;
  const rate = Number(sampleRate) > 0 ? Math.round(Number(sampleRate)) : 16000;
  try {
    ensureDirs();
    if (!statOrNull(file)) fs.writeFileSync(file, wavHeader(rate, 0));
    fs.appendFileSync(file, buffer);
    return true;
  } catch (_) {
    return false;
  }
}

// The dictation ended, one way or another, so the partial copy is redundant.
function dropLive() {
  if (!ready()) return false;
  const file = liveFile();
  if (!file) return false;
  return !statOrNull(file) || safeUnlink(file);
}

function hasLive() {
  const file = liveFile();
  return Boolean(file && statOrNull(file));
}

// A clip that stopped mid-write has a header claiming no audio at all. Both
// sizes follow from the file's own length.
function repairWavHeader(file) {
  try {
    const stat = statOrNull(file);
    if (!stat || stat.size <= 44) return false;
    const fd = fs.openSync(file, 'r+');
    try {
      const sizes = Buffer.alloc(4);
      sizes.writeUInt32LE(stat.size - 8, 0);
      fs.writeSync(fd, sizes, 0, 4, 4);
      sizes.writeUInt32LE(stat.size - 44, 0);
      fs.writeSync(fd, sizes, 0, 4, 40);
    } finally {
      fs.closeSync(fd);
    }
    return true;
  } catch (_) {
    return false;
  }
}

// Called at launch: a live clip here means the last session never ended.
function rescueLive(meta) {
  if (!ready()) return null;
  const file = liveFile();
  if (!file || !statOrNull(file)) return null;
  if (wavSeconds(file) < LIVE_MIN_SECONDS) {
    safeUnlink(file);
    return null;
  }
  if (!repairWavHeader(file)) {
    safeUnlink(file);
    return null;
  }
  const id = recoveryId();
  const target = clipPath(RECOVERY_DIR, id);
  if (!target) return null;
  try {
    fs.renameSync(file, target);
  } catch (_) {
    return null;
  }
  const stat = statOrNull(target);
  const record = Object.assign({}, meta || {}, {
    id,
    ts: stat ? stat.mtimeMs : Date.now(),
    bytes: stat ? stat.size : 0,
    seconds: Math.round(wavSeconds(target) * 10) / 10,
    source: 'crash',
  });
  try {
    writeRecoveryRecords(readRecoveryRecords().concat(record));
  } catch (_) {}
  invalidate();
  return id;
}

// What the privacy pane counts: shelved clips are audio kept under the same
// toggle, so they belong in the same total.
function recoveryStats() {
  const shelved = ready() ? recoveries() : [];
  return {
    count: shelved.length,
    bytes: shelved.reduce((n, c) => n + c.size, 0),
  };
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

// What the privacy pane says about playback recordings. Shelved clips are kept
// under the same setting and deleted by the same button, so they are counted
// here too -- a storage figure that leaves some of the audio out is a figure
// the user cannot act on.
function recordingStats() {
  const kept = ready() ? recordings() : [];
  const shelved = recoveryStats();
  return {
    count: kept.length + shelved.count,
    bytes: kept.reduce((n, c) => n + c.size, 0) + shelved.bytes,
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
  clearRecoveries();
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
  keepFailure,
  recoveries,
  recoveryPath,
  dropRecovery,
  adoptRecovery,
  pruneRecoveries,
  clearRecoveries,
  recoveryStats,
  appendLive,
  dropLive,
  hasLive,
  rescueLive,
  repairWavHeader,
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
  RECOVERY_MAX_DAYS,
  RECOVERY_MAX_CLIPS,
  RECOVERY_MAX_BYTES,
  LIVE_MIN_SECONDS,
  TRAINING_WINDOW_CLIPS,
  TRAINING_WINDOW_BYTES,
  PARK_TTL_MS,
};
