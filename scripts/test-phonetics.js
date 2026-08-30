'use strict';
const phon = require('../src/phonetics');
const dict = require('../src/dictionary');

let failed = 0;
function check(name, got, expected) {
  const g = JSON.stringify(got);
  const e = JSON.stringify(expected);
  if (g !== e) {
    failed += 1;
    console.error('FAIL', name, '\n  expected', e, '\n  got     ', g);
  } else {
    console.log('ok', name);
  }
}

// --- phonetic coding ----------------------------------------------------

check('aspirated kh folds onto k', phon.phoneticCode('Kharagpur'), phon.phoneticCode('sucky'));
check('aspirated bh folds onto b', phon.phoneticCode('bhai'), 'B');
check('v and w merge', phon.phoneticCode('Chandrayaan'), phon.phoneticCode('no way'));
check('leading vowel kept as one marker', phon.phoneticCode('Amritsar'), 'ASVR');
check('x expands to ks', phon.phoneticCode('Voxden'), 'VKSDN');
check('doubles collapse', phon.phoneticCode('Ollama'), 'ALM');
check('empty input is empty', phon.phoneticCode('   '), '');
check('unrelated words stay unrelated', phon.sharedPrefix(phon.phoneticCode('milk'), phon.phoneticCode('eggs')), 0);

// --- the gate: names Whisper mangles must now be learnable ---------------

const LEARNABLE = [
  ['sucky', 'Kharagpur'],
  ['no way', 'Chandrayaan'],
  ['sub trees', 'Bhubaneswar'],
  ['i shall', 'Amritsar'],
  ['so knock', 'Kharagpur'],
  ['thakur mar jhuli', 'Thakumar Jhuli'],
  ['vox don', 'Voxden'],
  ['seedance', 'Seedance'],
];
for (const [from, to] of LEARNABLE) {
  check('learns ' + from + ' -> ' + to, dict.isLikelySpelling(from, to), true);
}

// --- the gate must still refuse content edits ---------------------------

const REJECTED = [
  ['milk', 'eggs'],
  ['john', 'Sarah'],
  ['tuesday', 'budget'],
  ['the report', 'the invoice'],
  ['sam', 'Simran'],
  ['cat', 'elephant'],
];
for (const [from, to] of REJECTED) {
  check('refuses ' + from + ' -> ' + to, dict.isLikelySpelling(from, to), false);
}

// --- variant generation -------------------------------------------------

const subh = phon.generateVariants('Bhubaneswar', 10);
check('splits at the closed syllable', subh.includes('sub rajit'), true);
check('drops the aspirate', subh.includes('subrajit'), true);
check('respects the cap', subh.length <= 10, true);
check('never repeats the canonical', subh.includes('subhrajit'), false);

check('rebuilds a hand-written variant', phon.generateVariants('Voxden', 10).includes('vox den'), true);
check('rebuilds see dance', phon.generateVariants('Seedance', 10).includes('see dance'), true);
check('runs multi-word terms together', phon.generateVariants('Nano Banana', 12).includes('nanobanana'), true);
check('spells out npm', phon.generateVariants('npm start', 10).includes('n p m start'), true);
check('hears and pm for npm', phon.generateVariants('npm start', 10).includes('and pm start'), true);
check('skips terms too short to be safe', phon.generateVariants('Ram', 10), []);

// Nothing generated may be able to fire on ordinary speech.
const SAMPLE_NAMES = ['Bhubaneswar', 'Kharagpur', 'Kharagpur', 'Chandrayaan', 'Amritsar', 'Voxden',
  'Thakumar', 'Amritsar', 'Amritsar', 'Seedance', 'Nano Banana', 'Higgsfield', 'npm start'];
const unsafe = [];
for (const name of SAMPLE_NAMES) {
  for (const v of phon.generateVariants(name, 12)) {
    const parts = v.split(' ');
    if (parts.length === 1 && phon.isCommonWord(v)) unsafe.push(name + ' -> ' + v);
    if (parts.length > 1 && parts.every((p) => phon.isCommonWord(p))) unsafe.push(name + ' -> ' + v);
    if (!dict.validatePhrase(v, name).ok) unsafe.push(name + ' -> ' + v + ' (invalid)');
  }
}
check('no generated variant collides with common speech', unsafe, []);

check('rejects a common single word', phon.isSafeVariant('water', 'Vatar'), false);
check('rejects an all-common phrase', phon.isSafeVariant('no way', 'Chandrayaan'), false);
check('accepts a mixed phrase', phon.isSafeVariant('sub rajit', 'Bhubaneswar'), true);
check('accepts letter-spelled jargon', phon.isSafeVariant('n p m start', 'npm start'), true);

// --- end to end through the dictionary ----------------------------------

const taught = dict.learn([], 'I met sub trees today', 'I met Bhubaneswar today', []);
check('one correction is taught', taught.learned, [{ from: 'sub trees', to: 'Bhubaneswar', kind: 'mapping', source: 'learned' }]);
check('phrases hold only what the user taught', taught.phrases, [{ from: 'sub trees', to: 'Bhubaneswar', kind: 'mapping', source: 'learned' }]);
check('variants were generated', taught.variants.length > 0, true);
check('every variant points at the canonical', taught.variants.every((v) => v.to === 'Bhubaneswar'), true);

const state = { phrases: taught.phrases, variants: taught.variants };
const list = dict.matchList(state);
check(
  'the taught spelling applies',
  dict.applyDictionary('ping sub trees now', list),
  'ping Bhubaneswar now'
);
check(
  'a spelling nobody taught also applies',
  dict.applyDictionary('I met sub rajit today', list),
  'I met Bhubaneswar today'
);
check(
  'ordinary speech is untouched',
  dict.applyDictionary('I will submit the report tomorrow', list),
  'I will submit the report tomorrow'
);

// Variants share their parent's `to`, and promptFrom de-dupes on `to`, so the
// whole generated set has to cost zero of the 64 acoustic prompt slots.
check(
  'variants cost no prompt slots',
  dict.promptFrom(list, []),
  dict.promptFrom(state.phrases, [])
);

// --- lifecycle ----------------------------------------------------------

const removed = dict.removePhrase(state.phrases, state.variants, 'sub trees');
check('deleting a term drops its variants', removed.variants, []);
check('deleting a term drops the term', removed.phrases, []);

const orphaned = dict.syncVariants(
  [{ from: 'a', to: 'Kept' }],
  [{ from: 'x', to: 'Kept' }, { from: 'y', to: 'Gone' }]
);
check('orphaned variants are swept', orphaned, [{ from: 'x', to: 'Kept' }]);

const revised = dict.reviseLearned(
  state.phrases,
  taught.learned,
  'I met sub trees today',
  'I met sub trees today',
  state.variants
);
check('retracting a correction retracts its variants', revised.variants, []);
check('retracting a correction retracts the phrase', revised.phrases, []);

if (failed) {
  console.error(failed + ' failed');
  process.exit(1);
}
console.log('all phonetics tests passed');
