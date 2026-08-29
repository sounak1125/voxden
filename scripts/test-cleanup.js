'use strict';
const { cleanup, dedupeRepeats } = require('../src/cleanup');

const cleanupCases = [
  ['  hello world  ', 'Hello world'],
  ['um this is uh a test er', 'Um this is uh a test er'],
  ['hello new line world', 'Hello\nworld'],
  ['first new paragraph second', 'First\n\nsecond'],
  ['okay period then comma so question mark', 'Okay. Then, so?'],
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
