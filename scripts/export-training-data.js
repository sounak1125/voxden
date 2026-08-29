'use strict';

// Inspect and export the training pairs Voxden has collected.
//
//   node scripts/export-training-data.js            summary only
//   node scripts/export-training-data.js --write    also write train/eval manifests
//
// The written manifests carry absolute audio paths and a `sentence` key, which
// is what `datasets.load_dataset("json", data_files=...)` expects, so a
// fine-tune can point straight at them.

const fs = require('fs');
const path = require('path');

const AUDIO = path.join(__dirname, '..', 'data', 'audio');
const PAIRS = path.join(AUDIO, 'pairs.jsonl');
const EVAL_SHARE = 0.1;

function readPairs() {
  let raw;
  try {
    raw = fs.readFileSync(PAIRS, 'utf8');
  } catch (_) {
    return null;
  }
  const out = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const rec = JSON.parse(t);
      if (rec && rec.id && rec.text) out.push(rec);
    } catch (_) {}
  }
  return out;
}

function pendingCount() {
  try {
    return fs.readdirSync(path.join(AUDIO, 'pending'))
      .filter((n) => n.endsWith('.wav') && n !== '_last.wav').length;
  } catch (_) {
    return 0;
  }
}

function hms(seconds) {
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? h + 'h ' + m + 'm' : m + 'm ' + (s % 60) + 's';
}

function main() {
  const pairs = readPairs();
  if (!pairs || !pairs.length) {
    // Clips waiting in the pending window mean collection is already on; the
    // only thing missing is a correction, which is what supplies the label.
    const held = pendingCount();
    if (held) {
      console.log('No pairs yet. ' + held + (held === 1 ? ' clip is' : ' clips are') + ' held and waiting.');
      console.log('Correct a dictation in history — that edit is the label that makes a pair.');
    } else {
      console.log('No training data yet.');
      console.log('Turn on Settings -> Data and privacy -> "Keep audio for training", then correct a dictation.');
    }
    return 0;
  }

  const usable = pairs.filter((p) => fs.existsSync(path.join(AUDIO, p.audio || '')));
  const orphans = pairs.length - usable.length;
  const seconds = usable.reduce((n, p) => n + (Number(p.seconds) || 0), 0);
  const bytes = usable.reduce((n, p) => n + (Number(p.bytes) || 0), 0);
  const stamps = usable.map((p) => Number(p.ts) || 0).filter(Boolean).sort((a, b) => a - b);

  console.log('pairs      ' + usable.length + (orphans ? '  (' + orphans + ' orphaned, audio missing)' : ''));
  console.log('audio      ' + hms(seconds) + '  (' + (bytes / (1024 * 1024)).toFixed(1) + ' MB)');
  if (stamps.length) {
    console.log('collected  ' + new Date(stamps[0]).toISOString().slice(0, 10)
      + ' to ' + new Date(stamps[stamps.length - 1]).toISOString().slice(0, 10));
  }

  const terms = new Map();
  for (const p of usable) {
    for (const l of p.learned || []) {
      if (l && l.to) terms.set(l.to, (terms.get(l.to) || 0) + 1);
    }
  }
  const top = [...terms.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  if (top.length) {
    console.log('\nmost corrected terms');
    for (const [term, n] of top) console.log('  ' + String(n).padStart(4) + '  ' + term);
  }

  // A LoRA on Whisper starts moving proper nouns at a few hundred clips; below
  // that the honest answer is that there is not enough here yet.
  console.log('');
  if (usable.length < 100) {
    console.log('Keep collecting. Proper nouns start to shift somewhere north of a few hundred clips.');
  } else if (seconds < 3600) {
    console.log('Enough to try a LoRA on names. General accuracy wants hours, not minutes.');
  } else {
    console.log('Enough audio for a serious fine-tune.');
  }

  if (!process.argv.includes('--write')) {
    console.log('Re-run with --write to emit train/eval manifests.');
    return 0;
  }
  if (!usable.length) {
    console.log('Nothing to write.');
    return 0;
  }

  // Deterministic split on the id, so re-running does not shuffle a clip from
  // eval into train and quietly contaminate the measurement.
  const rows = usable.map((p) => ({
    audio: path.resolve(AUDIO, p.audio),
    sentence: p.text,
    asr: p.asr || '',
    learned: p.learned || [],
    seconds: p.seconds || 0,
  }));
  const keyed = usable.map((p, i) => ({ row: rows[i], hash: hashId(p.id) }));
  keyed.sort((a, b) => a.hash - b.hash);
  const cut = Math.max(1, Math.round(keyed.length * EVAL_SHARE));
  const evalRows = keyed.slice(0, cut).map((k) => k.row);
  const trainRows = keyed.slice(cut).map((k) => k.row);

  writeJsonl(path.join(AUDIO, 'train.jsonl'), trainRows);
  writeJsonl(path.join(AUDIO, 'eval.jsonl'), evalRows);
  console.log('wrote ' + trainRows.length + ' train / ' + evalRows.length + ' eval rows to ' + AUDIO);
  return 0;
}

function hashId(id) {
  let h = 2166136261;
  for (let i = 0; i < id.length; i += 1) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function writeJsonl(file, rows) {
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

process.exit(main());
