'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  applyDictionary,
  extractPhrasePairs,
  learn,
  reviseLearned,
  upsertPhrase,
  validatePhrase,
  validateWord,
  normalizePhrase,
  matchList,
  load,
  understandingState,
} = require('../src/dictionary');

function p(from, to, extra) {
  return Object.assign({
    from,
    to,
    kind: from === to ? 'word' : 'mapping',
    source: 'manual',
  }, extra || {});
}

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

check(
  'case phrase',
  extractPhrasePairs('please use seedance 2 today', 'please use Seedance 2 today'),
  [{ from: 'seedance', to: 'Seedance' }]
);
check(
  'whole short phrase',
  extractPhrasePairs('seedance 2', 'Seedance 2'),
  [{ from: 'seedance', to: 'Seedance' }]
);
check(
  'word swap',
  extractPhrasePairs('buy milk', 'buy eggs'),
  [{ from: 'milk', to: 'eggs' }]
);
check(
  'no change',
  extractPhrasePairs('Hello world', 'Hello world'),
  []
);

const phrases = learn([], 'seedance 2 is ready', 'Seedance 2 is ready').phrases;
check('learn seedance', phrases, [p('seedance', 'Seedance', { source: 'learned' })]);
check(
  'apply case',
  applyDictionary('Use seedance 2 now', phrases),
  'Use Seedance 2 now'
);
check(
  'longest first',
  applyDictionary(
    'open ai and openai',
    [
      { from: 'ai', to: 'AI' },
      { from: 'open ai', to: 'OpenAI' },
    ]
  ),
  'OpenAI and openai'
);
check(
  'case insensitive match',
  applyDictionary('SEEDANCE 2', [{ from: 'seedance', to: 'Seedance' }]),
  'Seedance 2'
);

const upserted = upsertPhrase(
  [{ from: 'old', to: 'Old' }, { from: 'sea dance', to: 'Seedance' }],
  'vox don',
  'Voxden'
);
check('upsert prepends', upserted.ok, true);
check('upsert first pair', upserted.phrases[0], p('vox don', 'Voxden'));
check('upsert length', upserted.phrases.length, 3);

const replaced = upsertPhrase(upserted.phrases, 'VOX DON', 'Voxden Pro');
check('upsert replaces same from', replaced.phrases.filter((x) => x.from.toLowerCase() === 'vox don').length, 1);
check('upsert replace keeps front', replaced.phrases[0], p('VOX DON', 'Voxden Pro'));

check('validate rejects empty', validatePhrase('', 'Voxden').ok, false);
check('validate rejects dollar', validatePhrase('bad', 'Seed$ance').ok, false);
check('validate rejects poison get', validatePhrase('get', 'git').ok, false);
check('validate allows multi-word get', validatePhrase('get commit', 'git commit').ok, true);
check('validate mapping requires different sides', validatePhrase('Voxden', 'Voxden', 'mapping').ok, false);
check('validate word allows same spelling', validatePhrase('Seedance', 'Seedance', 'word').ok, true);
check('validateWord accepts a name', validateWord('Seedance').ok, true);
check('validateWord rejects poison', validateWord('get').ok, false);

check(
  'vox don replacement',
  applyDictionary('open vox don now', [{ from: 'vox don', to: 'Voxden' }]),
  'open Voxden now'
);
check(
  'unrelated get unchanged',
  applyDictionary('I will get the file later', [{ from: 'vox don', to: 'Voxden' }]),
  'I will get the file later'
);

check(
  'punct around misspelling',
  extractPhrasePairs('open vox don, now', 'open Voxden, now'),
  [{ from: 'vox don', to: 'Voxden' }]
);
check(
  'learn while correcting',
  learn([], 'I used vox don today', 'I used Voxden today').learned,
  [p('vox don', 'Voxden', { source: 'learned' })]
);
check(
  'learn skips content swaps',
  learn([], 'buy milk later', 'buy eggs later').learned,
  []
);
check(
  'learn keeps case fixes',
  learn([], 'please use seedance 2', 'please use Seedance 2').learned,
  [p('seedance', 'Seedance', { source: 'learned' })]
);
check(
  'learn tags source',
  learn([], 'I used vox don today', 'I used Voxden today').phrases[0].source,
  'learned'
);

const worded = upsertPhrase([], 'Seedance', 'Seedance', [], { kind: 'word', source: 'manual' });
check('upsert word ok', worded.ok, true);
check('upsert word kind', worded.phrases[0], p('Seedance', 'Seedance', { kind: 'word' }));
check(
  'apply skips same-from-to word',
  applyDictionary('Seedance is ready', worded.phrases),
  'Seedance is ready'
);
check(
  'word variants still apply',
  applyDictionary('see dance is ready', matchList(worded)),
  'Seedance is ready'
);
check(
  'added word still case-folds',
  applyDictionary('seedance is ready', worded.phrases),
  'Seedance is ready'
);

const npmWord = upsertPhrase([], 'npm start', 'npm start', [], { kind: 'word', source: 'manual' });
check('npm word ok', npmWord.ok, true);
check(
  'npm gets letter variants',
  npmWord.variants.some((v) => v.from === 'n p m start'),
  true
);
check(
  'npm letter spelling applies',
  applyDictionary('run n p m start now', matchList(npmWord)),
  'run npm start now'
);
check(
  'npm and-pm applies',
  applyDictionary('run and pm start now', matchList(npmWord)),
  'run npm start now'
);
check(
  'npm case fold',
  applyDictionary('run NPM start now', npmWord.phrases),
  'run npm start now'
);

check(
  'normalize old json',
  normalizePhrase({ from: 'vox don', to: 'Voxden' }),
  p('vox don', 'Voxden')
);

const tmp = path.join(os.tmpdir(), 'voxden-dict-test-' + Date.now() + '.json');
fs.writeFileSync(tmp, JSON.stringify({ phrases: [{ from: 'old', to: 'Old' }] }));
const loaded = load(tmp);
check('load old json kind', loaded.phrases[0].kind, 'mapping');
check('load old json source', loaded.phrases[0].source, 'manual');
fs.unlinkSync(tmp);

const tmpWord = path.join(os.tmpdir(), 'voxden-dict-word-' + Date.now() + '.json');
fs.writeFileSync(tmpWord, JSON.stringify({
  phrases: [{ from: 'npm start', to: 'npm start', kind: 'word', source: 'manual' }],
}));
const loadedWord = load(tmpWord);
check('load word expands npm variant', loadedWord.variants.some((v) => v.from === 'n p m start'), true);
fs.unlinkSync(tmpWord);

function liveCorrect(original, steps) {
  let nextPhrases = [];
  let learnedPairs = [];
  for (const next of steps) {
    const r = reviseLearned(nextPhrases, learnedPairs, original, next);
    nextPhrases = r.phrases;
    learnedPairs = r.learned;
  }
  return { phrases: nextPhrases, learnedPairs };
}

check(
  'live edit retracts mid-word junk',
  liveCorrect('open vox don now', ['open vox do now', 'open Voxden now']).phrases,
  [p('vox don', 'Voxden', { source: 'learned' })]
);

check('voice profiles expose five milestones', understandingState(0).understandingProfiles.map((item) => item.name), [
  'Learning',
  'Personalized',
  'Attuned',
  'Fluent',
  'Expert',
]);
check('voice profile stays below complete before a threshold', understandingState(2499).understandingPercent, 99);
check('personalized profile starts at 2500 words', understandingState(2500).understandingProfileName, 'Personalized');
check('attuned profile starts at 5000 words', understandingState(5000).understandingProfileName, 'Attuned');
check('fluent profile starts at 10000 words', understandingState(10000).understandingProfileName, 'Fluent');
check('expert profile starts at 25000 words', understandingState(25000).understandingProfileName, 'Expert');
check('expert profile is the final milestone', understandingState(25000).understandingMaxed, true);

if (failed) {
  console.error(failed + ' failed');
  process.exit(1);
}
console.log('all dictionary tests passed');
