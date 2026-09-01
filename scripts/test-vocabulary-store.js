'use strict';

// The structured vocabulary: migration from the flat dictionary, Unicode
// matching, relevance ranking, and the per-engine token budgets.
//
// Every case below is a bug that shipped. The Devanagari ones are the sharpest:
// the app refused to let anyone add "नमस्ते" as a word, and a Hindi replacement
// rule never fired even when it was added by hand, because `\b` has no meaning
// in a script with no ASCII word characters.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vocab = require('../src/vocabulary');
const dict = require('../src/dictionary');
const caps = require('../src/asr-capabilities');

let checks = 0;
function ok(label, value) {
  assert.ok(value, label);
  checks += 1;
  process.stdout.write('ok ' + label + '\n');
}
function eq(label, actual, expected) {
  assert.deepStrictEqual(actual, expected, label + ': ' + JSON.stringify(actual));
  checks += 1;
  process.stdout.write('ok ' + label + '\n');
}

// --- 1. Script detection ----------------------------------------------------
eq('Devanagari is recognised', vocab.detectScript('नमस्ते'), 'deva');
eq('accented Latin is still Latin', vocab.detectScript('Café'), 'latn');
eq('Cyrillic is recognised', vocab.detectScript('Соня'), 'cyrl');
eq('Han is recognised', vocab.detectScript('日本語'), 'hani');
eq('a mixed term reports its dominant script', vocab.detectScript('Voxden नम'), 'latn');
eq('digits alone have no script', vocab.detectScript('123'), null);
ok('Devanagari separates words', vocab.usesWordSeparators('deva'));
ok('Han does not', !vocab.usesWordSeparators('hani'));

// --- 2. Unicode normalisation ----------------------------------------------
// The same word typed two ways must be one term, not two.
const composed = 'José';
const decomposed = 'José';
ok('NFD and NFC fold to the same key', vocab.foldKey(composed) === vocab.foldKey(decomposed));
eq('entries built from either spelling share an id',
  vocab.makeEntry(composed).id, vocab.makeEntry(decomposed).id);

// --- 3. Matching in any script ---------------------------------------------
const hindi = vocab.makeEntry('नमस्ते', {
  language: 'hi',
  rules: [{ from: 'नमसते', to: 'नमस्ते' }],
});
eq('a Devanagari rule fires',
  vocab.applyEntries('मैं नमसते बोलता हूं', [hindi]).text, 'मैं नमस्ते बोलता हूं');
eq('and does not fire inside a longer word',
  vocab.applyEntries('नमसतेजी', [hindi]).text, 'नमसतेजी');

const latin = vocab.makeEntry('Anthropic', { rules: [{ from: 'antro pic', to: 'Anthropic' }] });
eq('a Latin rule fires', vocab.applyEntries('i use antro pic', [latin]).text, 'i use Anthropic');
eq('and respects word edges', vocab.applyEntries('antro pictures', [latin]).text, 'antro pictures');
eq('and is case-insensitive', vocab.applyEntries('ANTRO PIC', [latin]).text, 'Anthropic');
eq('multi-word terms tolerate odd spacing',
  vocab.applyEntries('antro  pic', [latin]).text, 'Anthropic');

const accented = vocab.makeEntry('Café', { rules: [{ from: 'caffay', to: 'Café' }] });
eq('an accented replacement lands', vocab.applyEntries('the caffay is open', [accented]).text,
  'the Café is open');

// --- 4. Validation accepts the world ---------------------------------------
for (const word of ['नमस्ते', 'Café', 'José', 'Müller', 'Соня', '日本語', 'Voxden']) {
  ok('"' + word + '" is a valid dictionary word', dict.validateWord(word).ok);
}
ok('a one-character word is still refused', !dict.validateWord('x').ok);
ok('an ordinary English word is still refused on its own', !dict.validateWord('see').ok);
ok('a Devanagari mapping validates', dict.validatePhrase('नमसते', 'नमस्ते').ok);
ok('punctuation-only input is still refused', !dict.validateWord('...').ok);

// --- 5. Migration preserves the existing dictionary -------------------------
const legacy = {
  phrases: [
    { from: 'newest term', to: 'Newest Term', kind: 'mapping', source: 'manual' },
    { from: 'Voxden', to: 'Voxden', kind: 'word', source: 'manual' },
    { from: 'see dance two', to: 'Seedance 2', kind: 'mapping', source: 'learned' },
    { from: 'C dance 2', to: 'Seedance 2', kind: 'mapping', source: 'learned' },
  ],
  variants: [
    { from: 'voxton', to: 'Voxden' },
    { from: 'vox den', to: 'Voxden' },
  ],
  pending: [],
  blocked: [],
};
const migrated = vocab.fromDictionary(legacy);
eq('phrases collapse onto canonical terms', migrated.length, 3);
const voxden = migrated.find((e) => e.canonical === 'Voxden');
ok('a word entry keeps its generated spellings as aliases',
  voxden.aliases.includes('voxton') && voxden.aliases.includes('vox den'));
const seedance = migrated.find((e) => e.canonical === 'Seedance 2');
eq('two mappings to one term become one entry with two aliases', seedance.aliases.length, 2);
ok('every legacy mapping survives as a rule, plus one self-rule per term',
  migrated.reduce((n, e) => n + e.rules.length, 0) === 7);
eq('a case-only mapping becomes a real rule',
  vocab.applyEntries('the newest term here', migrated).text, 'the Newest Term here');
eq('a plain word entry still normalises its own casing',
  vocab.applyEntries('open voxden now', migrated).text, 'open Voxden now');
eq('and text that already matches is not counted as a correction',
  vocab.applyEntries('open Voxden now', migrated).hits, 0);
eq('provenance is carried over', seedance.source, 'learned');
ok('a manual entry is marked manual', voxden.source === 'manual');

// Nothing the user taught may be lost.
const migratedRules = new Set(migrated.flatMap((e) => e.rules.map((r) => r.from.toLowerCase())));
for (const phrase of legacy.phrases) {
  if (phrase.from === phrase.to) continue;
  ok('rule "' + phrase.from + '" survived migration', migratedRules.has(phrase.from.toLowerCase()));
}
for (const variant of legacy.variants) {
  ok('variant "' + variant.from + '" survived migration', migratedRules.has(variant.from.toLowerCase()));
}

// --- 6. A newly added word outranks an old one ------------------------------
//
// This is the reported bug: adding a word did nothing. upsertPhrase puts the
// newest term at index 0, so migration has to turn list position into recency
// and ranking has to respect it. Otherwise the newest term is the one the
// budget cuts.
const ranked = vocab.rank(migrated, { language: 'en' });
eq('the most recently added term ranks first', ranked[0].canonical, 'Newest Term');

const now = Date.now();
const stale = vocab.makeEntry('Stale', { updatedAt: now - 400 * 86400000, source: 'manual' });
const fresh = vocab.makeEntry('Fresh', { updatedAt: now, source: 'manual' });
eq('recency beats alphabetical order',
  vocab.rank([stale, fresh], { now }).map((e) => e.canonical), ['Fresh', 'Stale']);

const used = vocab.makeEntry('Used', { updatedAt: now - 200 * 86400000, useCount: 30, lastUsedAt: now });
ok('a term the user keeps saying outranks one they never do',
  vocab.rank([stale, used], { now })[0].canonical === 'Used');

const mentioned = vocab.makeEntry('Kubernetes', { updatedAt: now - 100 * 86400000 });
const ignored = vocab.makeEntry('Fortran', { updatedAt: now - 100 * 86400000 });
const recent = vocab.recentTermSet([{ text: 'deploying to kubernetes today' }], 10);
eq('a term in recent transcripts is more relevant',
  vocab.rank([ignored, mentioned], { now, recentTerms: recent })[0].canonical, 'Kubernetes');

// --- 7. Language filtering keeps prompts on topic ---------------------------
const mixed = [
  vocab.makeEntry('नमस्ते', { language: 'hi' }),
  vocab.makeEntry('Anthropic'),
];
eq('an English dictation is not offered Devanagari terms',
  vocab.rank(mixed, { language: 'en' }).map((e) => e.canonical), ['Anthropic']);
ok('a Hindi dictation is offered both',
  vocab.rank(mixed, { language: 'hi' }).length === 2);

// --- 8. Budgets are per engine and never overrun ----------------------------
const many = [];
for (let i = 0; i < 400; i++) {
  many.push(vocab.makeEntry('Terminology' + i, { updatedAt: now - i * 1000 }));
}
const rankedMany = vocab.rank(many, { language: 'en', now });
eq('ranking a large dictionary keeps all of it', rankedMany.length, 400);

for (const engine of caps.ENGINE_IDS) {
  const budget = caps.vocabularyBudget(engine);
  const context = vocab.contextFor(rankedMany, { engine });
  ok(engine + ' respects its term cap', context.budget.terms <= budget.maxTerms);
  ok(engine + ' respects its token cap', context.budget.tokens <= budget.maxTokens);
  eq(engine + ' accounts for everything it dropped',
    context.included.length + context.dropped.length, rankedMany.length);
}

ok('a dictionary far larger than the cap still sends its best terms',
  vocab.contextFor(rankedMany, { engine: 'qwen3-asr' }).included[0] === 'Terminology0');
eq('an engine with no mechanism sends nothing and says everything was dropped',
  vocab.contextFor(rankedMany, { engine: 'parakeet' }).included.length, 0);

// Aliases are misrecognitions. Teaching a decoder the wrong spelling is how
// you get the wrong spelling back.
const aliased = [vocab.makeEntry('Kharagpur', { aliases: ['karagpur', 'carrot pur'] })];
const aliasContext = vocab.contextFor(aliased, { engine: 'qwen3-asr' });
ok('only canonical spellings go into the prompt',
  aliasContext.text.includes('Kharagpur') && !/karagpur/i.test(aliasContext.text));

// Non-Latin costs more tokens per character, and guessing low is what overruns
// a prompt window.
ok('Devanagari is budgeted more expensively than Latin, per character',
  vocab.estimateTokens('नमस्ते') / 'नमस्ते'.length
  > vocab.estimateTokens('namaste') / 'namaste'.length);

// --- 9. Usage is recorded and survives a save/load round trip ---------------
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voxden-vocab-'));
const file = path.join(dir, 'dictionary.json');
try {
  vocab.saveState(file, Object.assign({}, legacy, { entries: migrated }));
  const reloaded = vocab.loadState(file);
  eq('a saved dictionary reloads with the same terms',
    reloaded.entries.map((e) => e.canonical).sort(),
    migrated.map((e) => e.canonical).sort());
  eq('the legacy keys are still written for older builds',
    JSON.parse(fs.readFileSync(file, 'utf8')).phrases.length, legacy.phrases.length);
  ok('an older build can still read it',
    dict.load(file).phrases.length === legacy.phrases.length);

  const usedIds = vocab.usedEntries('I opened Voxden today', migrated);
  eq('a term the transcript contained is counted as used', usedIds, [voxden.id]);
  const touched = vocab.touch(migrated, usedIds, now);
  eq('using a term raises its count',
    touched.find((e) => e.id === voxden.id).useCount, voxden.useCount + 1);

  vocab.saveState(file, Object.assign({}, legacy, { entries: touched }));
  const afterRestart = vocab.loadState(file);
  eq('usage survives a restart',
    afterRestart.entries.find((e) => e.canonical === 'Voxden').useCount, 1);

  // A file from a build that never knew about entries must still load.
  fs.writeFileSync(file, JSON.stringify({ phrases: legacy.phrases, variants: legacy.variants }));
  ok('a v1 file migrates on load', vocab.loadState(file).entries.length === 3);
  fs.writeFileSync(file, 'not json at all');
  eq('a corrupt file loads as empty rather than throwing', vocab.loadState(file).entries, []);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

process.stdout.write('all ' + checks + ' vocabulary store checks passed\n');
