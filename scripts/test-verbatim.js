'use strict';
const { cleanup, cleanupVerbatim } = require('../src/cleanup');
const style = require('../src/style');

let failed = 0;

function check(label, got, expected) {
  if (got !== expected) {
    failed += 1;
    console.error('FAIL', label,
      '\n  expected', JSON.stringify(expected),
      '\n  got     ', JSON.stringify(got));
  } else {
    console.log('ok', label, '->', JSON.stringify(got));
  }
}

// Words the styled pipeline replaces or deletes must survive verbatim intact.
const keepsExactWords = [
  ['during that period we ran a comma separated export',
    'During that period we ran a comma separated export'],
  ['please buy milk scratch that buy eggs',
    'Please buy milk scratch that buy eggs'],
  ['hello new line world', 'Hello new line world'],
  ['first new paragraph second', 'First new paragraph second'],
  ['is that a question mark or not', 'Is that a question mark or not'],
  ['um this is uh a test er', 'Um this is uh a test er'],
  ['I don\'t think it\'s gonna work, yeah', 'I don\'t think it\'s gonna work, yeah'],
  ['very very good', 'Very very good'],
  ['I think I think we should go', 'I think I think we should go'],
];

for (const [input, expected] of keepsExactWords) {
  check('verbatim ' + JSON.stringify(input), cleanupVerbatim(input), expected);
}

// Text alone cannot tell genuine speech from a hallucination. The audio gate
// rejects silence before recognition; verbatim keeps a speaker's chosen words.
check('keeps spoken sign-off', cleanupVerbatim('Thanks for watching.'), 'Thanks for watching.');
check('keeps trailing sign-off',
  cleanupVerbatim('open voxden thanks for watching'), 'Open voxden thanks for watching');
check('empty input', cleanupVerbatim(''), '');
check('whitespace only', cleanupVerbatim('   '), '');

// Typography still runs: spacing and sentence capitalisation change no words.
check('collapses runs of spaces', cleanupVerbatim('  hello   world  '), 'Hello world');
check('spaces after sentence end',
  cleanupVerbatim('one!two three'), 'One! Two three');
check('preserves domain-shaped text', cleanupVerbatim('example.de and example.technology'), 'example.de and example.technology');

// Every case above must actually differ from the styled path, or the mode
// would be pointless. Guard that the two pipelines really diverge.
const divergent = keepsExactWords.filter(([input]) => {
  const styled = style.applyStyleWithTone(cleanup(input), 'formal');
  return styled !== cleanupVerbatim(input);
});
if (divergent.length !== keepsExactWords.length) {
  failed += 1;
  console.error('FAIL verbatim matched the styled pipeline on some cases;',
    'expected all', keepsExactWords.length, 'to differ, got', divergent.length);
} else {
  console.log('ok all', divergent.length, 'cases differ from the styled pipeline');
}

// Verbatim must not be reachable by accident: it is off unless asked for.
const main = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'main.js'), 'utf8');
for (const key of ['verbatimMode', 'verbatimDictionary']) {
  if (!main.includes(key + ': false')) {
    failed += 1;
    console.error('FAIL', key, 'does not default to false in main.js');
  } else {
    console.log('ok', key, 'defaults to false');
  }
}

if (failed) {
  console.error(failed + ' failed');
  process.exit(1);
}
console.log('all verbatim tests passed');
