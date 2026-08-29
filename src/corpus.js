'use strict';

// Training-pair collection.
//
// A correction is the only moment this app ever learns the ground truth for a
// clip: the user heard themselves, read what the model wrote, and typed what
// they actually said. That is a labelled training pair — but only if the audio
// still exists, and today it is deleted the instant transcription returns.
//
// So every clip is parked briefly, claimed by the history entry it produced,
// and promoted to a permanent pair the moment the user edits that entry. Clips
// nobody corrects fall out of the pending window and are gone.
//
// Nothing here uploads anything. The corpus is a folder of 16 kHz mono WAVs
// next to a JSONL manifest, which is the shape a Whisper fine-tune wants.

const fs = require('fs');
const path = require('path');

// Pending clips are speculative — most are never corrected — so the window is
// deliberately small. Corpus pairs are the point of the exercise and are never
// evicted automatically.
const PENDING_MAX_CLIPS = 60;
const PENDING_MAX_BYTES = 200 * 1024 * 1024;
const PARK_TTL_MS = 120000;

let ROOT = null;
let PENDING_DIR = null;
let CORPUS_DIR = null;
let PAIRS_FILE = null;
let PARKED_FILE = null;

function init(audioDir) {
  ROOT = audioDir;
  PENDING_DIR = path.join(ROOT, 'pending');
  CORPUS_DIR = path.join(ROOT, 'corpus');
  PAIRS_FILE = path.join(ROOT, 'pairs.jsonl');
  PARKED_FILE = path.join(PENDING_DIR, '_last.wav');
  return ROOT;
}

function ready() {
  return Boolean(ROOT);
}

// stats() is memoised; every mutation below drops the memo.
let statsCache = null;

function invalidate() {
  statsCache = null;
}

function ensureDirs() {
  fs.mkdirSync(PENDING_DIR, { recursive: true });
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

function clipPath(dir, entryId) {
  const id = String(entryId || '').replace(/[^A-Za-z0-9_-]/g, '');
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

// Attach the parked clip to the history entry it became. A stale park means
// the transcript came from somewhere else (the Web Speech fallback carries no
// audio), so it is dropped rather than mislabelled.
function claim(entryId) {
  if (!ready()) return false;
  const target = clipPath(PENDING_DIR, entryId);
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
  prunePending();
  invalidate();
  return true;
}

function pendingClips() {
  try {
    return fs.readdirSync(PENDING_DIR)
      .filter((n) => n.endsWith('.wav') && n !== '_last.wav')
      .map((n) => {
        const file = path.join(PENDING_DIR, n);
        const stat = statOrNull(file);
        return { file, size: stat ? stat.size : 0, mtime: stat ? stat.mtimeMs : 0 };
      })
      .sort((a, b) => b.mtime - a.mtime);
  } catch (_) {
    return [];
  }
}

// Oldest first out, on either count or bytes.
function prunePending() {
  const clips = pendingClips();
  let bytes = 0;
  let kept = 0;
  for (const clip of clips) {
    kept += 1;
    bytes += clip.size;
    if (kept > PENDING_MAX_CLIPS || bytes > PENDING_MAX_BYTES) safeUnlink(clip.file);
  }
}

// The user corrected this transcript, so the clip and the corrected text are
// now a labelled pair. Re-editing the same entry updates the pair in place.
function promote(entryId, record) {
  if (!ready()) return false;
  const id = String(entryId || '').replace(/[^A-Za-z0-9_-]/g, '');
  if (!id) return false;
  const text = String((record && record.text) || '').trim();
  if (!text) return false;

  const pending = clipPath(PENDING_DIR, id);
  const stored = clipPath(CORPUS_DIR, id);
  try {
    ensureDirs();
    if (statOrNull(pending)) {
      fs.renameSync(pending, stored);
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
  const id = String(entryId || '').replace(/[^A-Za-z0-9_-]/g, '');
  if (!id) return false;
  let touched = false;
  const pending = clipPath(PENDING_DIR, id);
  const stored = clipPath(CORPUS_DIR, id);
  if (pending && safeUnlink(pending)) touched = true;
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
  const pending = pendingClips();
  const value = {
    pairs: records.length,
    bytes,
    seconds: Math.round(seconds),
    pending: pending.length,
    pendingBytes: pending.reduce((n, c) => n + c.size, 0),
  };
  statsCache = { key, value };
  return value;
}

// Forget every recording, keeping the transcripts. Used by the settings toggle
// and by the explicit delete button.
function clear() {
  if (!ready()) return false;
  for (const dir of [PENDING_DIR, CORPUS_DIR]) {
    try {
      for (const name of fs.readdirSync(dir)) safeUnlink(path.join(dir, name));
    } catch (_) {}
  }
  safeUnlink(PAIRS_FILE);
  invalidate();
  return true;
}

module.exports = {
  init,
  ready,
  invalidate,
  park,
  dropParked,
  claim,
  promote,
  discard,
  stats,
  clear,
  readPairs,
  writePairs,
  wavSeconds,
  prunePending,
  PENDING_MAX_CLIPS,
  PENDING_MAX_BYTES,
  PARK_TTL_MS,
};
