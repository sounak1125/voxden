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

  // Spoken shortcuts become the chord, not four words of prose.
  ['control plus shift plus space', 'Ctrl+Shift+Space'],
  ['press control plus c to copy it', 'Press Ctrl+C to copy it'],
  ['use control plus alt plus delete', 'Use Ctrl+Alt+Delete'],
  ['windows key plus r opens run', 'Win+R opens run'],
  ['shift plus tab goes back', 'Shift+Tab goes back'],
  ['control plus page down', 'Ctrl+PageDown'],
  ['alt plus f4', 'Alt+F4'],
  ['control plus right arrow', 'Ctrl+Right'],
  ['try command plus option plus escape', 'Try Cmd+Alt+Esc'],
  // The engine sometimes writes the joiner as the symbol already.
  ['control + shift + space', 'Ctrl+Shift+Space'],
  // Two chords in one sentence, and the prose between them survives.
  ['control plus c then control plus v', 'Ctrl+C then Ctrl+V'],

  // The chain needs a modifier AND a joiner, which is what keeps ordinary
  // speech out of it. Each of these is missing one or both.
  ['he lost control of it', 'He lost control of it'],
  ['two plus two is four', 'Two plus two is four'],
  ['control the output flow', 'Control the output flow'],
  ['control c is not a chord here', 'Control c is not a chord here'],
  ['the shift ended at six', 'The shift ended at six'],
  // "plus" that is not joining a key leaves the whole phrase alone.
  ['control plus the button on the left', 'Control plus the button on the left'],
  ['shift plus or minus a little', 'Shift plus or minus a little'],
  // A chord cannot straddle punctuation.
  ['in control, plus we shipped it', 'In control, plus we shipped it'],
  ['control plus a to select all', 'Ctrl+A to select all'],
  // Known limit, pinned so it cannot change by accident: a single-letter key is
  // indistinguishable from the article that follows "plus". Keeping Ctrl+A
  // working costs this sentence. See shortcutKeyName in src/cleanup.js.
  ['temperature control plus a humidifier', 'Temperature Ctrl+A humidifier'],
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
