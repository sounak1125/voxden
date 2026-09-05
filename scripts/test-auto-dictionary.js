'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const dict = require('../src/dictionary');
const vocab = require('../src/vocabulary');
const { addCorrections, undoCorrections } = require('../src/auto-dictionary');

let checks = 0;
function check(name, run) {
  run();
  checks += 1;
  console.log('ok ' + name);
}
function empty(extra) {
  return Object.assign({ phrases: [], variants: [], pending: [], blocked: [] }, extra);
}
function word(term, source = 'manual') {
  return dict.makePhrase(term, term, { kind: 'word', source });
}
const correction = { from: 'vox don', to: 'Voxden' };

check('automatic spelling becomes a learned canonical term without aliases', () => {
  const original = empty();
  const result = addCorrections(original, [correction]);
  assert.deepStrictEqual(result.added, [word('Voxden', 'learned')]);
  assert.strictEqual(result.added[0], result.dictionary.phrases[0]);
  assert.deepStrictEqual(result.dictionary.variants, []);
  assert.deepStrictEqual(original, empty());
  assert.strictEqual(dict.applyDictionary('vox don remains a phrase', dict.matchList(result.dictionary)),
    'vox don remains a phrase');
  assert.strictEqual(dict.applyDictionary('voxden is ready', dict.matchList(result.dictionary)), 'Voxden is ready');
  assert.strictEqual(dict.promptFrom(result.dictionary.phrases), 'Voxden');
});

check('invalid, unchanged, rephrased and oversized edits do not add words', () => {
  const original = empty();
  const result = addCorrections(original, [
    null, {}, { from: 'Voxden', to: 'Voxden' }, { from: 'milk', to: 'eggs' },
    { from: 'vox don', to: 'Vox$den' }, { from: 'git', to: 'get' },
    { from: 'a long phrase of words', to: 'a long phrase of word' },
    { from: 'a'.repeat(81), to: 'a'.repeat(80) + 'b' },
    { from: 'vx', to: 123 },
  ]);
  assert.deepStrictEqual(result.added, []);
  assert.strictEqual(result.dictionary, original);
});

check('canonical casing and Unicode corrections survive normalization', () => {
  const result = addCorrections(empty(), [
    { from: 'codex', to: 'Codex' },
    { from: 'Jose', to: 'Jose\u0301' },
    { from: 'नमसते', to: 'नमस्ते' },
  ]);
  assert.deepStrictEqual(result.added.map((phrase) => phrase.to), ['Codex', 'José', 'नमस्ते']);
});

check('known sources, targets and generated aliases keep their existing owner', () => {
  const states = [
    empty({ phrases: [dict.makePhrase('vox don', 'Other', { source: 'manual' })] }),
    empty({ phrases: [dict.makePhrase('Voxden', 'Other', { source: 'manual' })] }),
    empty({ phrases: [dict.makePhrase('other', 'VOXDEN', { source: 'manual' })] }),
    empty({ variants: [{ from: 'vox don', to: 'Other' }] }),
    empty({ variants: [{ from: 'Voxden', to: 'Other' }] }),
    empty({ variants: [{ from: 'other', to: 'Voxden' }] }),
  ];
  for (const original of states) {
    const result = addCorrections(original, [correction]);
    assert.deepStrictEqual(result.added, []);
    assert.strictEqual(result.dictionary, original);
  }
});

check('blocked words and equivalent Unicode spellings are respected', () => {
  for (const blocked of [['VOX DON'], ['voxden'], ['  Voxden  ']]) {
    assert.deepStrictEqual(addCorrections(empty({ blocked }), [correction]).added, []);
  }
  const original = empty({ phrases: [word('Jose\u0301')] });
  assert.deepStrictEqual(addCorrections(original, [{ from: 'Jose', to: 'José' }]).added, []);
});

check('one batch cannot teach competing spellings for the same correction', () => {
  const result = addCorrections(empty(), [correction, correction,
    { from: 'vox don', to: 'Voxdin' }, { from: 'vox den', to: 'VOXDEN' }]);
  assert.deepStrictEqual(result.added, [word('Voxden', 'learned')]);
});

check('matching pending proposals stay queued and conflicting proposals block additions', () => {
  const pending = [{ from: 'vox don', to: 'Voxden', ts: 1 }, { from: 'fig ma', to: 'Figma', ts: 2 }];
  const result = addCorrections(empty({ pending }), [correction]);
  assert.strictEqual(result.added.length, 1);
  assert.strictEqual(result.dictionary.pending, pending);
  for (const proposal of [
    { from: 'vox don', to: 'Voxdin' }, { from: 'Voxden', to: 'Other' },
  ]) {
    assert.deepStrictEqual(addCorrections(empty({ pending: [proposal] }), [correction]).added, []);
  }
});

check('frozen existing records and extra dictionary metadata are preserved', () => {
  const manual = Object.freeze(word('Seedance'));
  const original = Object.freeze(empty({
    phrases: Object.freeze([manual]),
    variants: Object.freeze([Object.freeze({ from: 'sidance', to: 'Seedance' })]),
    pending: Object.freeze([]), blocked: Object.freeze(['rejected']), custom: 'retained',
  }));
  const result = addCorrections(original, [correction]);
  assert.strictEqual(result.dictionary.phrases[1], manual);
  assert.strictEqual(result.dictionary.variants, original.variants);
  assert.strictEqual(result.dictionary.blocked, original.blocked);
  assert.strictEqual(result.dictionary.custom, 'retained');
  const undone = undoCorrections(result.dictionary, result.added);
  assert.deepStrictEqual(undone.dictionary, original);
});

check('Undo removes only its own batch and keeps later automatic and manual additions', () => {
  const first = addCorrections(empty(), [correction]);
  const second = addCorrections(first.dictionary, [{ from: 'fig ma', to: 'Figma' }]);
  const later = Object.assign({}, second.dictionary, { phrases: [word('Example')].concat(second.dictionary.phrases) });
  const undone = undoCorrections(later, first.added);
  assert.deepStrictEqual(undone.removed, first.added);
  assert.deepStrictEqual(undone.dictionary.phrases, [word('Example'), word('Figma', 'learned')]);
  assert.strictEqual(later.phrases.length, 3);
  assert.strictEqual(undoCorrections(undone.dictionary, first.added).dictionary, undone.dictionary);
});

check('Undo cannot remove a manually replaced, re-added, cloned or edited receipt', () => {
  for (const replacement of [word('Voxden'), word('Voxden', 'learned'), word('Voxden Pro', 'learned')]) {
    const result = addCorrections(empty(), [correction]);
    const current = Object.assign({}, result.dictionary, { phrases: [replacement] });
    assert.deepStrictEqual(undoCorrections(current, result.added).removed, []);
  }
  const result = addCorrections(empty(), [correction]);
  assert.deepStrictEqual(undoCorrections(result.dictionary, JSON.parse(JSON.stringify(result.added))).removed, []);
  result.added[0].to = 'Voxden Pro';
  assert.deepStrictEqual(undoCorrections(result.dictionary, result.added).removed, []);
});

check('Undo cleans only variants orphaned by that removal and retains other live parents', () => {
  const result = addCorrections(empty(), [correction]);
  const variants = [{ from: 'voks den', to: 'Voxden' }, { from: 'unrelated', to: 'orphan' }];
  const withVariants = Object.assign({}, result.dictionary, { variants });
  assert.deepStrictEqual(undoCorrections(withVariants, result.added).dictionary.variants, [variants[1]]);
  const manualMapping = dict.makePhrase('vox den', 'Voxden', { kind: 'mapping', source: 'manual' });
  const withParent = Object.assign({}, withVariants, { phrases: [manualMapping].concat(withVariants.phrases) });
  assert.deepStrictEqual(undoCorrections(withParent, result.added).dictionary.variants, variants);
});

check('learned word upserts avoid expansion while manual words still generate spellings', () => {
  const learned = dict.upsertPhrase([], 'Seedance', 'Seedance', [], { kind: 'word', source: 'learned' });
  assert.deepStrictEqual(learned.variants, []);
  const updated = dict.upsertPhrase(learned.phrases, 'Seedance', 'Seedance', learned.variants, { kind: 'word' });
  assert.deepStrictEqual(updated.variants, []);
  assert.strictEqual(updated.phrases[0].source, 'learned');
  const manual = dict.upsertPhrase(learned.phrases, 'Seedance', 'Seedance', [], { kind: 'word', source: 'manual' });
  assert.ok(manual.variants.some((variant) => variant.from === 'sidance'));
});

check('dictionary and structured vocabulary roundtrips retain learned words without new rules', () => {
  const file = path.join(os.tmpdir(), 'voxden-auto-dictionary-' + process.pid + '-' + Date.now() + '.json');
  try {
    const result = addCorrections(empty(), [{ from: 'seedance', to: 'Seedance' }]);
    dict.save(file, result.dictionary);
    const loaded = dict.load(file);
    assert.deepStrictEqual(loaded.phrases, result.dictionary.phrases);
    assert.deepStrictEqual(loaded.variants, []);
    // A process restart ends the in-memory Undo lifetime.
    assert.deepStrictEqual(undoCorrections(loaded, result.added).removed, []);
    const entries = vocab.fromDictionary(loaded, [], { now: 10000 });
    assert.strictEqual(entries[0].canonical, 'Seedance');
    assert.strictEqual(entries[0].source, 'learned');
    assert.deepStrictEqual(entries[0].aliases, []);
    assert.deepStrictEqual(entries[0].rules.map(({ from, to }) => ({ from, to })),
      [{ from: 'Seedance', to: 'Seedance' }]);
    vocab.saveState(file, Object.assign({}, loaded, { entries }));
    const structured = vocab.loadState(file);
    assert.deepStrictEqual(structured.entries, entries);
    assert.deepStrictEqual(dict.load(file).variants, []);
    assert.strictEqual(vocab.applyEntries('sidance is ready', structured.entries).text, 'sidance is ready');
    assert.strictEqual(vocab.applyEntries('seedance is ready', structured.entries).text, 'Seedance is ready');
  } finally {
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }
});

console.log('all ' + checks + ' auto-dictionary checks passed');
