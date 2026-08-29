'use strict';
const {
  applyDictionary,
  extractPhrasePairs,
  learn,
  reviseLearned,
  upsertPhrase,
  validatePhrase,
} = require('../src/dictionary');

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
check('learn seedance', phrases, [{ from: 'seedance', to: 'Seedance' }]);
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
check('upsert first pair', upserted.phrases[0], { from: 'vox don', to: 'Voxden' });
check('upsert length', upserted.phrases.length, 3);

const replaced = upsertPhrase(upserted.phrases, 'VOX DON', 'Voxden Pro');
check('upsert replaces same from', replaced.phrases.filter((p) => p.from.toLowerCase() === 'vox don').length, 1);
check('upsert replace keeps front', replaced.phrases[0], { from: 'VOX DON', to: 'Voxden Pro' });

check('validate rejects empty', validatePhrase('', 'Voxden').ok, false);
check('validate rejects dollar', validatePhrase('bad', 'Seed$ance').ok, false);
check('validate rejects poison get', validatePhrase('get', 'git').ok, false);
check('validate allows multi-word get', validatePhrase('get commit', 'git commit').ok, true);

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
  [{ from: 'vox don', to: 'Voxden' }]
);
check(
  'learn skips content swaps',
  learn([], 'buy milk later', 'buy eggs later').learned,
  []
);
check(
  'learn keeps case fixes',
  learn([], 'please use seedance 2', 'please use Seedance 2').learned,
  [{ from: 'seedance', to: 'Seedance' }]
);

function liveCorrect(original, steps) {
  let phrases = [];
  let learnedPairs = [];
  for (const next of steps) {
    const r = reviseLearned(phrases, learnedPairs, original, next);
    phrases = r.phrases;
    learnedPairs = r.learned;
  }
  return { phrases, learnedPairs };
}

check(
  'live edit retracts mid-word junk',
  liveCorrect('open vox don now', ['open vox do now', 'open Voxden now']).phrases,
  [{ from: 'vox don', to: 'Voxden' }]
);

if (failed) {
  console.error(failed + ' failed');
  process.exit(1);
}
console.log('all dictionary tests passed');
