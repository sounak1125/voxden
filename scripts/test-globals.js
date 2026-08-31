'use strict';

// src/*.js are loaded two ways: required as CommonJS modules by this suite, and
// dropped into a page as classic <script> tags by app.html and overlay.html. The
// first way gives every file its own scope. The second does not -- every
// top-level name in every script on a page lands in one shared global scope.
//
// So a duplicate top-level `const` is a SyntaxError that kills the whole second
// file at parse time, and nothing in Node ever notices. That is not theoretical:
// suggestions.js and chunking.js had both been dead on arrival, each colliding
// on a bare `const api`. chunking.js taking itself out was the expensive one --
// overlay.js only builds a chunker `&& chunkingApi()`, so streaming
// transcription silently never ran and every dictation did all of its ASR work
// after the user stopped speaking.
//
// This walks each page's real <script> list and fails on a repeat.

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src');
const DECL = /^(const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/;

// Collisions that are known, harmless, and deliberately left alone. Function
// declarations do not throw when redeclared -- the last one loaded simply wins
// -- so identical implementations coexist safely. They are listed rather than
// ignored so the set cannot grow without someone deciding it should.
const ALLOWED = new Map();

let failed = 0;
function fail(msg) {
  failed += 1;
  console.error('FAIL ' + msg);
}

function scriptsIn(html) {
  const src = fs.readFileSync(path.join(SRC, html), 'utf8');
  return [...src.matchAll(/<script\s+src="([^"]+)"/g)].map((m) => m[1]);
}

function topLevelDecls(file) {
  const out = [];
  const full = path.join(SRC, file);
  if (!fs.existsSync(full)) return out;
  fs.readFileSync(full, 'utf8').split('\n').forEach((line, i) => {
    const m = DECL.exec(line);
    if (m) out.push({ kind: m[1], name: m[2], line: i + 1 });
  });
  return out;
}

const pages = fs.readdirSync(SRC).filter((f) => f.endsWith('.html'));
if (!pages.length) fail('no HTML pages found in src/ -- this guard is not looking at anything');

let checkedPages = 0;
let checkedScripts = 0;

for (const page of pages) {
  const scripts = scriptsIn(page);
  if (!scripts.length) continue;
  checkedPages += 1;
  const before = failed;
  const owner = new Map();
  for (const file of scripts) {
    const decls = topLevelDecls(file);
    if (!decls.length) continue;
    checkedScripts += 1;
    for (const d of decls) {
      const prev = owner.get(d.name);
      if (!prev) {
        owner.set(d.name, Object.assign({ file }, d));
        continue;
      }
      // Only a repeat involving let/const/class is a parse error. Two function
      // declarations shadow instead of throwing.
      const fatal = d.kind !== 'function' || prev.kind !== 'function';
      const where = prev.kind + ' ' + prev.file + ':' + prev.line
        + ' vs ' + d.kind + ' ' + file + ':' + d.line;
      if (fatal) {
        fail(page + ' loads two scripts declaring `' + d.name + '` (' + where + ').'
          + '\n     The second one throws on load and never runs. Give it a'
          + ' module-specific name.');
      } else if (ALLOWED.has(d.name)) {
        console.log('ok  ' + page + ' tolerates shadowed `' + d.name + '` -- ' + ALLOWED.get(d.name));
      } else {
        fail(page + ' loads two scripts declaring `' + d.name + '` (' + where + ').'
          + '\n     Not fatal, but the last one loaded silently wins for every'
          + ' caller on the page. Rename it, or add it to ALLOWED with a reason.');
      }
    }
  }
  if (failed === before) {
    console.log('ok  ' + page + ' has no top-level collisions across ' + scripts.length + ' scripts');
  }
}

// A script that does not parse is the same failure this file exists for, just
// arrived at from the other direction: the page loads, the tag is there, and
// every line in it is dead. Node never sees these files run, so nothing else
// would notice -- an unterminated string in app.js passed the whole suite.
const vm = require('vm');
for (const page of pages) {
  for (const file of scriptsIn(page)) {
    const full = path.join(SRC, file);
    if (!fs.existsSync(full)) continue;
    try {
      new vm.Script(fs.readFileSync(full, 'utf8'), { filename: file });
    } catch (err) {
      fail(page + ' loads ' + file + ', which does not parse: ' + err.message
        + '\n     The whole file is dead on the page and takes its exports with it.');
    }
  }
}
console.log('ok  every script on every page parses');

// The scan is worthless if it silently matches nothing, so pin what it covered.
if (checkedPages < 2) fail('expected to scan at least 2 pages, scanned ' + checkedPages);
if (checkedScripts < 6) fail('expected to scan at least 6 scripts, scanned ' + checkedScripts);

// Each browser-loaded module publishes itself on globalThis when there is no
// module.exports. A rename that missed one of those lines would leave the export
// undefined in the app while every Node test kept passing.
const EXPORTS = [
  ['metrics.js', 'voxdenMetrics'],
  ['insights.js', 'voxdenInsights'],
  ['suggestions.js', 'voxdenSuggestions'],
  ['cleanup.js', 'voxdenCleanup'],
  ['chunking.js', 'voxdenChunking'],
];
for (const [file, global] of EXPORTS) {
  const src = fs.readFileSync(path.join(SRC, file), 'utf8');
  const m = new RegExp('globalThis\\.' + global + ' = ([A-Za-z_$][\\w$]*);').exec(src);
  if (!m) {
    fail(file + ' no longer assigns globalThis.' + global);
    continue;
  }
  const binding = m[1];
  const declared = new RegExp('^const ' + binding + '\\b', 'm').test(src);
  const exported = new RegExp('module\\.exports = ' + binding + ';').test(src);
  if (!declared) fail(file + ' assigns globalThis.' + global + ' from `' + binding + '`, which it never declares');
  if (!exported) fail(file + ' exports a different binding than it publishes as ' + global);
  if (declared && exported) console.log('ok  ' + file + ' publishes `' + binding + '` both ways');
}

if (failed) {
  process.exitCode = 1;
  console.error('\n' + failed + ' check(s) failed');
} else {
  console.log('All global-scope tests passed.');
}
