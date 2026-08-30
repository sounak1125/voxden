'use strict';
const { cleanup, dedupeRepeats } = require('../src/cleanup');

const cleanupCases = [
  ['  hello world  ', 'Hello world'],
  ['um this is uh a test er', 'Um this is uh a test er'],
  ['hello insert new line world', 'Hello\nworld'],
  ['first insert new paragraph second', 'First\n\nsecond'],
  ['okay insert period then insert comma so insert question mark', 'Okay. Then, so?'],
  ['stop it insert exclamation mark', 'Stop it!'],
  ['wrap it up insert full stop', 'Wrap it up.'],
  // Without the prefix these are ordinary nouns and must survive untouched.
  ['during that period we ran a comma separated export',
    'During that period we ran a comma separated export'],
  ['is that a question mark or not', 'Is that a question mark or not'],
  ['a new line of business', 'A new line of business'],
  ['we came to a full stop', 'We came to a full stop'],
  ['the new paragraph in the contract', 'The new paragraph in the contract'],
  ['please buy milk scratch that buy eggs', 'Buy eggs'],
  ['hello world. scratch that', 'Hello world.'],
  ['UM hello UH there', 'UM hello UH there'],
  ['Thanks for watching.', ''],
  ['open voxden thanks for watching', 'Open voxden'],
];

const dedupeCases = [
  ['hello hello world', 'hello world'],
  ['Hello hello world', 'Hello world'],
  ['hello hello hello world', 'hello world'],
  ['yeah, yeah, yeah', 'yeah'],
  ['Hello. Hello. Hello.', 'Hello.'],
  ['I think I think we should go', 'I think we should go'],
  ['I think I think I think we should go', 'I think we should go'],
  ['the the quick brown fox', 'the quick brown fox'],
  ['this is a longer test this is a longer test', 'this is a longer test'],
];

let failed = 0;

for (const [input, expected] of cleanupCases) {
  const got = cleanup(input);
  if (got !== expected) {
    failed += 1;
    console.error('cleanup FAIL', JSON.stringify(input), '\n  expected', JSON.stringify(expected), '\n  got     ', JSON.stringify(got));
  } else {
    console.log('cleanup ok', JSON.stringify(input), '->', JSON.stringify(got));
  }
}

for (const [input, expected] of dedupeCases) {
  const got = dedupeRepeats(input);
  if (got !== expected) {
    failed += 1;
    console.error('dedupe FAIL', JSON.stringify(input), '\n  expected', JSON.stringify(expected), '\n  got     ', JSON.stringify(got));
  } else {
    console.log('dedupe ok', JSON.stringify(input), '->', JSON.stringify(got));
  }
}

if (failed) {
  console.error(failed + ' failed');
  process.exit(1);
}
console.log('all cleanup tests passed');
