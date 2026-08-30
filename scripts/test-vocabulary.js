'use strict';
const assert = require('assert');
const path = require('path');
const dict = require('../src/dictionary');

// This tests the seed that actually ships (package.json extraResources), because
// src/main.js ensureData() copies it verbatim into every new user's
// data/dictionary.json on first launch. Nothing personal may ride along, and
// nothing here may rewrite ordinary English.
const seedPath = path.join(__dirname, 'vocabulary-seed.json');
const { phrases } = dict.load(seedPath);

const cases = [
  ['I made this in sea dance 2.5',   'I made this in Seedance 2.5'],
  ['open C dance and Higgs field',   'open Seedance and Higgsfield'],
  ['run it through comfy you I',     'run it through ComfyUI'],
  ['train a Laura on her face',      'train a LoRA on her face'],
  ['get commit and get push',        'git commit and git push'],
  ['export a Jason file',            'export a JSON file'],
  ['shoot it as an owner shot',      'shoot it as an oner shot'],
  ['render the mogurt in after fx',  'render the MOGRT in After Effects'],
  // note: no capitalization here — cleanup() does that, and it runs before this
  // guards: these must NOT change
  ['I will get the file later',      'I will get the file later'],
  ['Laura called me this morning',   'Laura called me this morning'],
  ['she brought a bouquet of roses', 'she brought a bouquet of roses'],
  ['the owner of the studio',        'the owner of the studio'],
  ['he is a leader in his field',    'he is a leader in his field'],
  ['they played in a big field',     'they played in a big field'],
  ['lower a flag to half mast',      'lower a flag to half mast'],
  ['the sole character in the play', 'the sole character in the play'],
  ['an entropic system loses order', 'an entropic system loses order'],
  ['a single owner vehicle',         'a single owner vehicle'],
  ['it runs at sixty frames per second', 'it runs at sixty frames per second'],
  ["Java's type system is verbose",  "Java's type system is verbose"],
];

let fail = 0;
for (const [input, expected] of cases) {
  const got = dict.applyDictionary(input, phrases);
  if (got !== expected) {
    fail++;
    console.error('FAIL  ' + input + '\n  got: ' + got + '\n  exp: ' + expected);
  }
}

// The seed is a public default, not the maintainer's dictionary. Personal names,
// private project names and anything health-related stay in
// scripts/vocabulary-pack.personal.json, which is never packaged.
const BANNED = /sounak|so knock|sunak|sownak|dobby|dobie|margo|mango|sakhi|sucky|soggy|mogfx|mo gfx|mogul fx|moe graphics|refboard|ref board|rev board|red board|deskpets|desk pets|disk pets|desk bets|seqsort|sec sort|seek sort|sex sort|sequel sort|cinegrade|cine grade|cinnagrade|scene grade|thakumar|thakur|taku mar|jarvis|java's|pcos|peacocks|rakshasa|rock shasa|byangoma|bang goma/i;
for (const p of phrases) {
  assert.ok(!BANNED.test(p.from), 'personal term in shipped seed: ' + p.from);
  assert.ok(!BANNED.test(p.to), 'personal term in shipped seed: ' + p.to);
}

const prompt = dict.promptFrom(phrases, []);
const terms = prompt ? prompt.split(', ') : [];
console.log('seed entries: ' + phrases.length + ', prompt terms: ' + terms.length + '/64');
assert.ok(terms.length <= 64, 'prompt must stay within 64 terms');
for (const must of ['Seedance', 'Seedance 2.5', 'Higgsfield', 'Voxden', 'After Effects', 'MOGRT']) {
  assert.ok(terms.includes(must), must + ' must reach the Whisper prompt');
}

console.log(fail ? fail + ' failing case(s)' : 'all vocabulary cases pass');
process.exit(fail ? 1 : 0);
