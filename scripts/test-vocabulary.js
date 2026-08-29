'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const dict = require('../src/dictionary');

const dictPath = path.join(__dirname, '..', 'data', 'dictionary.json');
const seedPath = path.join(__dirname, 'vocabulary-seed.json');
const { phrases } = dict.load(fs.existsSync(dictPath) ? dictPath : seedPath);

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
];

let fail = 0;
for (const [input, expected] of cases) {
  const got = dict.applyDictionary(input, phrases);
  if (got !== expected) {
    fail++;
    console.error('FAIL  ' + input + '\n  got: ' + got + '\n  exp: ' + expected);
  }
}

const prompt = dict.promptFrom(phrases, []);
const terms = prompt ? prompt.split(', ') : [];
console.log('prompt terms: ' + terms.length + '/64');
assert.ok(terms.length <= 64, 'prompt must stay within 64 terms');
for (const must of ['Seedance', 'Seedance 2.5', 'Higgsfield', 'Voxden', 'After Effects', 'MOGRT']) {
  assert.ok(terms.includes(must), must + ' must reach the Whisper prompt');
}

console.log(fail ? fail + ' failing case(s)' : 'all vocabulary cases pass');
process.exit(fail ? 1 : 0);
