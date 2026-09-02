'use strict';
const assert = require('assert');
const { spokenNumbersToDigits } = require('../src/numbers');

const cases = [
  // Versions and decimals.
  ['one point zero point sixteen', '1.0.16'],
  ['We shipped version one point zero point sixteen today.', 'We shipped version 1.0.16 today.'],
  ['three point one four', '3.14'],
  ['zero point five', '0.5'],
  ['it costs two point five million', 'it costs 2.5 million'],
  ['Python three point twelve', 'Python 3.12'],

  // Cardinals.
  ['twenty five', '25'],
  ['twenty-five', '25'],
  ['a hundred people', '100 people'],
  ['two hundred and five', '205'],
  ['two thousand and five', '2005'],
  ['one thousand two hundred and thirty four', '1234'],
  ['three million', '3000000'],
  ['ten', '10'],
  ['I need forty two of them', 'I need 42 of them'],

  // Years.
  ['in twenty twenty six', 'in 2026'],
  ['back in nineteen ninety nine', 'back in 1999'],

  // Units and labels make a small number a figure.
  ['twenty percent', '20%'],
  ['five percent', '5%'],
  ['five per cent', '5%'],
  ['twenty five dollars', '$25'],
  ['five dollars', '$5'],
  ['five kg', '5 kg'],
  ['page three', 'page 3'],
  ['chapter seven', 'chapter 7'],
  ['version two', 'version 2'],
  ['at nine am', 'at 9 am'],

  // Digit runs.
  ['call five five five one two three four', 'call 5551234'],
  ['the code is one two three', 'the code is 123'],

  // Ordinals.
  ['the twenty fifth of May', 'the 25th of May'],
  ['the twentieth century', 'the 20th century'],
  ['one hundred and first', '101st'],
  ['twenty second', '22nd'],
  ['thirty third', '33rd'],

  // Prose that must stay prose.
  ['one of them', 'one of them'],
  ['no one came', 'no one came'],
  ['One of the reasons', 'One of the reasons'],
  ['I have two cats', 'I have two cats'],
  ['on second thoughts', 'on second thoughts'],
  ['the first time', 'the first time'],
  ['a second later', 'a second later'],
  ['two and three make five', 'two and three make five'],
  ['five. Six is next', 'five. Six is next'],
  ['point taken', 'point taken'],
  ['and one more thing', 'and one more thing'],
  ['', ''],

  // Mixed sentence.
  ['Send twenty five copies to room four by two pm on the twenty first.',
    'Send 25 copies to room 4 by 2 pm on the 21st.'],
];

let failed = 0;
for (const [input, expected] of cases) {
  const got = spokenNumbersToDigits(input);
  if (got !== expected) {
    failed += 1;
    console.error('FAIL', JSON.stringify(input), '\n  expected', JSON.stringify(expected), '\n  got     ', JSON.stringify(got));
  }
}
assert.strictEqual(failed, 0, failed + ' number cases failed');
console.log('all ' + cases.length + ' spoken number checks passed');
