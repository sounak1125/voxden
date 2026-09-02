'use strict';

// End-to-end dictation evaluation harness.
//
// Drives the real sidecar over its real stdio protocol -- the same JSON line
// src/main.js writes -- so what this measures is what a dictation actually
// gets. Nothing is stubbed except the microphone, which is replaced by the
// consented recordings the corpus already parked.
//
//   node scripts/eval-asr.js --engine qwen3-asr --device cuda --label baseline
//   node scripts/eval-asr.js --engine qwen3-asr --vocab data/dictionary.json
//   node scripts/eval-asr.js --list
//
// Results land in temp/eval/<label>.json. scripts/eval-report.js diffs two of
// them. Audio never leaves the machine and nothing here uploads or publishes.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const readline = require('readline');

const metrics = require('./lib/wer');
const vocabulary = require('../src/vocabulary');
const repair = require('../src/repair');
const capabilities = require('../src/asr-capabilities');

const ROOT = path.join(__dirname, '..');
const DEFAULT_MANIFEST = path.join(ROOT, 'data', 'audio', 'pairs.jsonl');
const FIXTURE_MANIFEST = path.join(ROOT, 'scripts', 'fixtures', 'eval-manifest.json');
const OUT_DIR = path.join(ROOT, 'temp', 'eval');

function parseArgs(argv) {
  const out = {
    engine: 'whisper',
    device: 'auto',
    language: 'en',
    quality: '',
    label: '',
    vocab: '',
    manifest: '',
    fixtures: false,
    list: false,
    limit: 0,
    timeoutMs: 300000,
    python: '',
    out: '',
    maxTerms: 0,
    prefix: null,
    raw: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === '--engine') out.engine = next();
    else if (arg === '--device') out.device = next();
    else if (arg === '--language') out.language = next();
    else if (arg === '--quality') out.quality = next();
    else if (arg === '--label') out.label = next();
    else if (arg === '--vocab') out.vocab = next();
    else if (arg === '--manifest') out.manifest = next();
    else if (arg === '--python') out.python = next();
    else if (arg === '--out') out.out = next();
    else if (arg === '--limit') out.limit = Number(next()) || 0;
    else if (arg === '--timeout') out.timeoutMs = Number(next()) || 300000;
    else if (arg === '--max-terms') out.maxTerms = Number(next()) || 0;
    else if (arg === '--prefix') out.prefix = next();
    else if (arg === '--no-prefix') out.prefix = '';
    else if (arg === '--raw') out.raw = true;
    else if (arg === '--fixtures') out.fixtures = true;
    else if (arg === '--list') out.list = true;
  }
  if (!out.label) out.label = out.engine + '-' + out.device;
  if (!out.out) out.out = path.join(OUT_DIR, out.label + '.json');
  return out;
}

function findPython(explicit) {
  const candidates = [
    explicit,
    process.env.VOXDEN_PYTHON,
    path.join(ROOT, '.venv', 'Scripts', 'python.exe'),
    path.join(ROOT, '.venv', 'bin', 'python'),
    'python',
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (candidate === 'python') return candidate;
    if (fs.existsSync(candidate)) return candidate;
  }
  return 'python';
}

// One evaluation item. `terms` are the custom words the clip is expected to
// contain; `forbidden` are terms that must not be introduced, which is how the
// negative cases -- ordinary speech that a dictionary must leave alone -- get
// scored rather than merely eyeballed.
function normalizeCase(raw, baseDir) {
  const audio = String((raw && raw.audio) || '');
  if (!audio) return null;
  const file = path.isAbsolute(audio) ? audio : path.join(baseDir, audio);
  if (!fs.existsSync(file)) return null;
  return {
    id: String((raw && raw.id) || path.basename(file, path.extname(file))),
    audio: file,
    reference: String((raw && (raw.reference || raw.text)) || '').trim(),
    language: String((raw && raw.language) || 'en'),
    terms: Array.isArray(raw && raw.terms) ? raw.terms.map(String) : [],
    forbidden: Array.isArray(raw && raw.forbidden) ? raw.forbidden.map(String) : [],
    tags: Array.isArray(raw && raw.tags) ? raw.tags.map(String) : [],
    seconds: Number((raw && raw.seconds) || 0) || 0,
  };
}

function loadManifest(opts) {
  const files = [];
  if (opts.manifest) files.push(opts.manifest);
  else {
    if (fs.existsSync(DEFAULT_MANIFEST)) files.push(DEFAULT_MANIFEST);
    if (opts.fixtures && fs.existsSync(FIXTURE_MANIFEST)) files.push(FIXTURE_MANIFEST);
  }
  const cases = [];
  for (const file of files) {
    const baseDir = path.dirname(file);
    const raw = fs.readFileSync(file, 'utf8');
    const rows = file.endsWith('.jsonl')
      ? raw.split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l))
      : (JSON.parse(raw).cases || []);
    for (const row of rows) {
      const item = normalizeCase(row, baseDir);
      if (item && item.reference) cases.push(item);
    }
  }
  return opts.limit ? cases.slice(0, opts.limit) : cases;
}

// The vocabulary the engine is told about, built through the same ranking and
// budget code the app uses. Passing a raw list here would measure a prompt no
// user will ever get.
function buildVocabulary(opts) {
  if (!opts.vocab) return { entries: [], terms: [], context: '', budget: null };
  const state = vocabulary.loadState(opts.vocab);
  // Ranked without a cap; contextFor owns the budget so the `dropped` count in
  // the report is the truth about what the engine was not told.
  const entries = vocabulary.rank(state.entries, {
    language: opts.language,
    engine: opts.engine,
  });
  const context = vocabulary.contextFor(entries, {
    engine: opts.engine,
    language: opts.language,
    maxTerms: opts.maxTerms || undefined,
    prefix: opts.prefix,
  });
  return {
    entries,
    terms: entries.map((e) => e.canonical),
    context: context.text,
    budget: context.budget,
    dropped: context.dropped,
  };
}

function startSidecar(opts) {
  const py = findPython(opts.python);
  const script = path.join(ROOT, 'sidecar', 'transcribe.py');
  const env = Object.assign({}, process.env, {
    HF_HOME: process.env.HF_HOME || path.join(ROOT, 'models', 'huggingface'),
    VOXDEN_MODEL_DIR: path.join(ROOT, 'models'),
    VOXDEN_MODEL: process.env.VOXDEN_MODEL || 'large-v3',
    VOXDEN_ASR_ENGINE: opts.engine,
    VOXDEN_DEVICE: opts.device,
    PYTHONUTF8: '1',
    PYTHONIOENCODING: 'utf-8',
    PYTHONUNBUFFERED: '1',
    HF_HUB_DISABLE_XET: '1',
  });
  const proc = spawn(py, [script, '--serve'], { env, windowsHide: true });
  proc.stdout.setEncoding('utf8');
  proc.stderr.setEncoding('utf8');
  const stderr = [];
  proc.stderr.on('data', (d) => {
    stderr.push(d);
    if (stderr.length > 400) stderr.splice(0, stderr.length - 400);
  });
  return { proc, stderr };
}

function waitForReady(rl, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('sidecar did not become ready')), timeoutMs);
    const onLine = (line) => {
      let msg = null;
      try { msg = JSON.parse(line); } catch (_) { return; }
      if (!msg || msg.ready !== true) return;
      clearTimeout(timer);
      rl.off('line', onLine);
      resolve(msg);
    };
    rl.on('line', onLine);
  });
}

function request(proc, rl, payload, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      rl.off('line', onLine);
      reject(new Error('transcribe timed out'));
    }, timeoutMs);
    const onLine = (line) => {
      let msg = null;
      try { msg = JSON.parse(line); } catch (_) { return; }
      if (!msg || String(msg.id || '') !== String(payload.id)) return;
      clearTimeout(timer);
      rl.off('line', onLine);
      resolve(msg);
    };
    rl.on('line', onLine);
    proc.stdin.write(JSON.stringify(payload) + '\n');
  });
}

function summarize(results, ready, opts, vocab) {
  const latencies = results.map((r) => r.latencyMs).filter(Number.isFinite);
  const rtf = results
    .filter((r) => r.seconds > 0 && Number.isFinite(r.latencyMs))
    .map((r) => r.latencyMs / 1000 / r.seconds);
  let expected = 0;
  let recalled = 0;
  let inserted = 0;
  let scriptOk = 0;
  let scriptTotal = 0;
  for (const r of results) {
    if (!r.terms) continue;
    expected += r.terms.expected;
    recalled += r.terms.recalled;
    inserted += r.terms.falseInsertions;
    if (r.expectedScript) {
      scriptTotal += 1;
      if (r.script === r.expectedScript) scriptOk += 1;
    }
  }
  return {
    label: opts.label,
    engine: opts.engine,
    device: opts.device,
    language: opts.language,
    quality: opts.quality || 'default',
    vocabularyFile: opts.vocab || null,
    vocabularyTerms: vocab.terms.length,
    vocabularyBudget: vocab.budget,
    resolved: {
      engine: (ready && ready.engine) || '',
      model: (ready && ready.model) || '',
      device: (ready && ready.device) || '',
      computeType: (ready && ready.compute_type) || '',
      fastEngine: (ready && ready.fast_engine) || '',
      fastDevice: (ready && ready.fast_device) || '',
      warning: (ready && ready.warning) || '',
      capabilities: (ready && ready.capabilities) || null,
    },
    finalize: opts.raw ? 'raw' : 'vocabulary+repair',
    clips: results.length,
    failures: results.filter((r) => r.error).length,
    dictionaryHits: results.reduce((a, r) => a + (r.dictionaryHits || 0), 0),
    repairsApplied: results.reduce((a, r) => a + ((r.repairs || []).length), 0),
    escalationsSuggested: results.reduce((a, r) => a + ((r.escalations || []).length), 0),
    uncertainSpans: results.reduce((a, r) => a + (r.uncertainSpans || 0), 0),
    wer: metrics.pooled(results, 'werRaw'),
    cer: metrics.pooled(results, 'cerRaw'),
    termRecall: expected ? recalled / expected : null,
    termPrecision: (recalled + inserted) ? recalled / (recalled + inserted) : null,
    termsExpected: expected,
    termsRecalled: recalled,
    falseInsertions: inserted,
    scriptAccuracy: scriptTotal ? scriptOk / scriptTotal : null,
    latencyMedianMs: metrics.median(latencies),
    latencyP95Ms: metrics.percentile(latencies, 95),
    latencyMeanMs: metrics.mean(latencies),
    asrMedianMs: metrics.median(results.map((r) => r.asrMs).filter(Number.isFinite)),
    finalizeMedianMs: metrics.median(results.map((r) => r.finalizeMs).filter(Number.isFinite)),
    realtimeFactorMedian: metrics.median(rtf),
    audioSeconds: results.reduce((a, r) => a + (r.seconds || 0), 0),
  };
}

function fmt(value, digits) {
  if (value == null || !Number.isFinite(value)) return 'n/a';
  return value.toFixed(digits == null ? 3 : digits);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const cases = loadManifest(opts);
  if (opts.list) {
    for (const c of cases) {
      process.stdout.write(`${c.id}\t${c.seconds || '?'}s\t${c.language}\t${c.reference.slice(0, 70)}\n`);
    }
    process.stdout.write(`${cases.length} cases\n`);
    return 0;
  }
  if (!cases.length) {
    process.stderr.write('No evaluation cases found. Record some dictations with training audio on,\n'
      + 'or pass --manifest with your own reference transcripts.\n');
    return 2;
  }

  const vocab = buildVocabulary(opts);
  const { proc, stderr } = startSidecar(opts);
  const rl = readline.createInterface({ input: proc.stdout });
  const results = [];
  let ready = null;
  let exitCode = 0;
  try {
    ready = await waitForReady(rl, opts.timeoutMs);
    process.stdout.write(`engine=${ready.engine} model=${ready.model} device=${ready.device}`
      + `${ready.fast_engine ? ' fast=' + ready.fast_engine + '/' + ready.fast_device : ''}\n`);
    if (ready.warning) process.stdout.write(`warning: ${ready.warning}\n`);
    process.stdout.write(`vocabulary: ${vocab.terms.length} terms`
      + `${vocab.budget ? ' (~' + vocab.budget.tokens + ' tokens)' : ''}\n\n`);

    let id = 0;
    for (const item of cases) {
      const payload = {
        path: item.audio,
        language: item.language || opts.language,
        id: String(++id),
      };
      if (vocab.context) payload.prompt = vocab.context;
      if (opts.quality) payload.quality = opts.quality;
      const started = process.hrtime.bigint();
      let msg;
      try {
        msg = await request(proc, rl, payload, opts.timeoutMs);
      } catch (err) {
        msg = { ok: false, error: (err && err.message) || 'failed' };
      }
      const asrMs = Number(process.hrtime.bigint() - started) / 1e6;
      const recognized = msg && msg.ok ? String(msg.text || '') : '';

      // What the user would actually be pasted. --raw stops here and reports
      // the engine on its own, which is what the capability comparisons want;
      // by default the vocabulary rules and the repair stage run too, because
      // that is the text the product delivers.
      const finalizeStart = process.hrtime.bigint();
      let hypothesis = recognized;
      let applied = { hits: 0, applied: [] };
      let repaired = { repairs: [], escalate: [], considered: [] };
      if (!opts.raw && vocab.entries.length && recognized) {
        applied = vocabulary.applyEntries(recognized, vocab.entries, { language: item.language });
        repaired = repair.repairTranscript(applied.text, vocab.entries, {
          language: item.language,
          segments: msg && msg.segments,
        });
        hypothesis = repaired.text;
      }
      const finalizeMs = Number(process.hrtime.bigint() - finalizeStart) / 1e6;
      const latencyMs = asrMs + finalizeMs;
      const expectedScript = metrics.scriptOf(item.reference).script;
      const row = {
        id: item.id,
        seconds: item.seconds,
        language: item.language,
        tags: item.tags,
        reference: item.reference,
        recognized,
        hypothesis,
        engine: (msg && msg.engine) || '',
        vocabularyVia: (msg && msg.vocabulary) || '',
        routed: (msg && msg.routed) || '',
        uncertainSpans: ((msg && msg.segments) || []).length,
        dictionaryHits: applied.hits,
        repairs: repaired.repairs.map((r) => ({ heard: r.heard, term: r.term, reason: r.reason })),
        escalations: repaired.escalate.map((r) => ({ heard: r.heard, term: r.term })),
        error: msg && msg.ok ? null : String((msg && msg.error) || 'failed'),
        asrMs,
        finalizeMs,
        latencyMs,
        werRaw: metrics.wer(item.reference, hypothesis),
        cerRaw: metrics.cer(item.reference, hypothesis),
        terms: metrics.termScore(
          item.reference,
          hypothesis,
          item.terms.length ? item.terms : vocab.terms,
          item.forbidden
        ),
        script: metrics.scriptOf(hypothesis).script,
        expectedScript,
      };
      results.push(row);
      process.stdout.write(
        `${row.id.padEnd(16)} wer=${fmt(row.werRaw.rate)} `
        + `cer=${fmt(row.cerRaw.rate)} ${Math.round(latencyMs)}ms`
        + `${row.error ? ' ERROR ' + row.error : ''}\n`
      );
      if (row.terms.missed.length) {
        process.stdout.write(`${' '.repeat(16)} missed: ${row.terms.missed.join(', ')}\n`);
      }
      if (row.terms.inserted.length) {
        process.stdout.write(`${' '.repeat(16)} FALSE INSERT: ${row.terms.inserted.join(', ')}\n`);
      }
      for (const r of row.repairs) {
        process.stdout.write(`${' '.repeat(16)} repaired: "${r.heard}" -> "${r.term}" (${r.reason})\n`);
      }
      if (row.escalations.length) {
        process.stdout.write(`${' '.repeat(16)} escalate: `
          + row.escalations.map((r) => `"${r.heard}"~"${r.term}"`).join(', ') + '\n');
      }
    }
  } catch (err) {
    process.stderr.write('harness failed: ' + ((err && err.message) || err) + '\n');
    process.stderr.write(stderr.join('').slice(-4000) + '\n');
    exitCode = 1;
  } finally {
    try { proc.stdin.write('QUIT\n'); } catch (_) {}
    try { proc.kill(); } catch (_) {}
    rl.close();
  }

  const summary = summarize(results, ready, opts, vocab);
  fs.mkdirSync(path.dirname(opts.out), { recursive: true });
  fs.writeFileSync(opts.out, JSON.stringify({ summary, results }, null, 2));

  process.stdout.write(
    `\n${summary.label}: WER ${fmt(summary.wer)} CER ${fmt(summary.cer)}`
    + ` term-recall ${fmt(summary.termRecall)} false-inserts ${summary.falseInsertions}`
    + ` p50 ${Math.round(summary.latencyMedianMs || 0)}ms p95 ${Math.round(summary.latencyP95Ms || 0)}ms\n`
    + `written to ${path.relative(ROOT, opts.out)}\n`
  );
  return exitCode;
}

if (require.main === module) {
  main().then((code) => process.exit(code)).catch((err) => {
    process.stderr.write(String((err && err.stack) || err) + '\n');
    process.exit(1);
  });
}

module.exports = { parseArgs, loadManifest, summarize, normalizeCase };
