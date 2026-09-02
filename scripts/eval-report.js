'use strict';

// Compare two evaluation runs and say whether the change was an improvement.
//
//   node scripts/eval-report.js temp/eval/baseline-qwen-cuda.json temp/eval/after-qwen-cuda.json
//   node scripts/eval-report.js --gate temp/eval/baseline-*.json temp/eval/after-*.json
//
// With --gate the process exits non-zero when a threshold is missed, so a
// release can be blocked on the measurement rather than on a claim about it.
// The thresholds are set against the baseline and are not to be relaxed
// afterwards to make a run pass; moving one is a decision to be argued for in
// the commit that moves it.

const fs = require('fs');
const path = require('path');

// What a change to the recognition pipeline has to clear.
//
// Chosen from the measured baseline on the held-out recordings, on this
// hardware: an RTX 4070 with the CUDA runtime present. They are deliberately
// asymmetric -- accuracy must improve or hold, latency may drift a little,
// and a single false dictionary substitution fails the run outright, because
// that is the error a user cannot forgive or predict.
const GATES = Object.freeze({
  // Word error rate may not get worse. A small tolerance absorbs decoder
  // nondeterminism; it is not a licence to regress.
  werRegression: 0.01,
  cerRegression: 0.01,
  // Custom-term recall is the whole point of the vocabulary work.
  termRecallRegression: 0,
  // A term forced into speech that did not contain it. Zero, always.
  falseInsertions: 0,
  // Latency may drift by a quarter before it is a problem, and p95 is what
  // people feel.
  latencyP95Factor: 1.25,
  latencyMedianFactor: 1.25,
});

function load(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!raw || !raw.summary) throw new Error(file + ' is not an eval result');
  return raw;
}

function fmt(value, digits) {
  if (value == null || !Number.isFinite(value)) return '   n/a';
  return value.toFixed(digits == null ? 3 : digits).padStart(6);
}

function delta(before, after, lowerIsBetter) {
  if (before == null || after == null || !Number.isFinite(before) || !Number.isFinite(after)) {
    return '';
  }
  const diff = after - before;
  if (Math.abs(diff) < 1e-9) return '  =';
  const better = lowerIsBetter ? diff < 0 : diff > 0;
  return (better ? '  +' : '  -') + ' ' + (diff > 0 ? '+' : '') + diff.toFixed(3);
}

function row(label, before, after, lowerIsBetter, digits) {
  return label.padEnd(26) + fmt(before, digits) + '  ->' + fmt(after, digits)
    + delta(before, after, lowerIsBetter);
}

// Which clips moved, and by how much. A corpus-level number can hide one clip
// getting much worse while another gets much better, and that trade is usually
// not one anybody agreed to.
function perClip(before, after) {
  const byId = new Map((before.results || []).map((r) => [r.id, r]));
  const moved = [];
  for (const a of after.results || []) {
    const b = byId.get(a.id);
    if (!b) continue;
    const diff = (a.werRaw ? a.werRaw.rate : 0) - (b.werRaw ? b.werRaw.rate : 0);
    if (Math.abs(diff) < 0.02) continue;
    moved.push({ id: a.id, diff, before: b.hypothesis, after: a.hypothesis, reference: a.reference });
  }
  return moved.sort((x, y) => x.diff - y.diff);
}

function checkGates(before, after) {
  const b = before.summary;
  const a = after.summary;
  const failures = [];
  const pass = [];
  function gate(name, ok, detail) {
    (ok ? pass : failures).push(name + ': ' + detail);
  }

  if (b.wer != null && a.wer != null) {
    gate('word error rate', a.wer <= b.wer + GATES.werRegression,
      fmt(b.wer) + ' -> ' + fmt(a.wer) + ' (allowed +' + GATES.werRegression + ')');
  }
  if (b.cer != null && a.cer != null) {
    gate('character error rate', a.cer <= b.cer + GATES.cerRegression,
      fmt(b.cer) + ' -> ' + fmt(a.cer) + ' (allowed +' + GATES.cerRegression + ')');
  }
  if (b.termRecall != null && a.termRecall != null) {
    gate('custom-term recall', a.termRecall >= b.termRecall - GATES.termRecallRegression,
      fmt(b.termRecall) + ' -> ' + fmt(a.termRecall));
  }
  gate('false dictionary insertions', (a.falseInsertions || 0) <= GATES.falseInsertions,
    String(a.falseInsertions || 0) + ' (allowed ' + GATES.falseInsertions + ')');
  if (b.latencyP95Ms && a.latencyP95Ms) {
    gate('p95 stop-to-text', a.latencyP95Ms <= b.latencyP95Ms * GATES.latencyP95Factor,
      Math.round(b.latencyP95Ms) + 'ms -> ' + Math.round(a.latencyP95Ms) + 'ms');
  }
  if (b.latencyMedianMs && a.latencyMedianMs) {
    gate('median stop-to-text', a.latencyMedianMs <= b.latencyMedianMs * GATES.latencyMedianFactor,
      Math.round(b.latencyMedianMs) + 'ms -> ' + Math.round(a.latencyMedianMs) + 'ms');
  }
  gate('no clip failed to transcribe', (a.failures || 0) === 0, String(a.failures || 0) + ' failures');
  if (a.scriptAccuracy != null) {
    gate('language/script preserved', a.scriptAccuracy >= 1,
      fmt(a.scriptAccuracy) + ' of clips answered in the spoken script');
  }
  return { pass, failures };
}

function main(argv) {
  const gateMode = argv.includes('--gate');
  const files = argv.filter((a) => !a.startsWith('--'));
  if (files.length !== 2) {
    process.stderr.write('usage: node scripts/eval-report.js [--gate] <before.json> <after.json>\n');
    return 2;
  }
  const before = load(files[0]);
  const after = load(files[1]);
  const b = before.summary;
  const a = after.summary;

  const out = [];
  out.push('');
  out.push(b.label + '  ->  ' + a.label);
  out.push('engine    ' + (b.resolved.engine || b.engine) + '/' + (b.resolved.device || b.device)
    + '  ->  ' + (a.resolved.engine || a.engine) + '/' + (a.resolved.device || a.device));
  out.push('clips     ' + b.clips + ' (' + Math.round(b.audioSeconds) + 's of audio)');
  out.push('finalize  ' + (b.finalize || 'raw') + '  ->  ' + (a.finalize || 'raw'));
  out.push('');
  out.push(row('word error rate', b.wer, a.wer, true));
  out.push(row('character error rate', b.cer, a.cer, true));
  out.push(row('custom-term recall', b.termRecall, a.termRecall, false));
  out.push(row('custom-term precision', b.termPrecision, a.termPrecision, false));
  out.push(row('false insertions', b.falseInsertions, a.falseInsertions, true, 0));
  out.push(row('language/script accuracy', b.scriptAccuracy, a.scriptAccuracy, false));
  out.push(row('median latency (ms)', b.latencyMedianMs, a.latencyMedianMs, true, 0));
  out.push(row('p95 latency (ms)', b.latencyP95Ms, a.latencyP95Ms, true, 0));
  out.push(row('realtime factor', b.realtimeFactorMedian, a.realtimeFactorMedian, true));
  out.push('');
  out.push('vocabulary  offered ' + (b.vocabularyTerms || 0) + ' terms; sent '
    + ((b.vocabularyBudget && b.vocabularyBudget.terms) || 0) + '  ->  '
    + ((a.vocabularyBudget && a.vocabularyBudget.terms) || 0)
    + ' (~' + ((a.vocabularyBudget && a.vocabularyBudget.tokens) || 0) + ' tokens)');
  if (a.dictionaryHits != null) {
    out.push('applied     ' + (a.dictionaryHits || 0) + ' explicit replacements, '
      + (a.repairsApplied || 0) + ' repairs, '
      + (a.escalationsSuggested || 0) + ' escalations suggested');
  }

  const moved = perClip(before, after);
  if (moved.length) {
    out.push('');
    out.push('clips that moved');
    for (const m of moved) {
      out.push('  ' + m.id + '  ' + (m.diff > 0 ? '+' : '') + m.diff.toFixed(3));
      out.push('    ref    ' + m.reference.slice(0, 100));
      out.push('    before ' + String(m.before).slice(0, 100));
      out.push('    after  ' + String(m.after).slice(0, 100));
    }
  }

  const gates = checkGates(before, after);
  out.push('');
  out.push('release gates');
  for (const line of gates.pass) out.push('  PASS  ' + line);
  for (const line of gates.failures) out.push('  FAIL  ' + line);
  out.push('');
  out.push(gates.failures.length
    ? gates.failures.length + ' gate(s) failed'
    : 'all ' + gates.pass.length + ' gates passed');
  out.push('');
  process.stdout.write(out.join('\n'));

  return gateMode && gates.failures.length ? 1 : 0;
}

if (require.main === module) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (err) {
    process.stderr.write(String((err && err.message) || err) + '\n');
    process.exit(2);
  }
}

module.exports = { GATES, checkGates, perClip, load: (f) => load(path.resolve(f)) };
