'use strict';

const { suggestionsEnabled } = require('../src/suggestions');

let failed = 0;
function check(name, got, expected) {
  if (got !== expected) {
    failed += 1;
    console.error('FAIL', name, '\n  expected', expected, '\n  got     ', got);
  } else {
    console.log('ok', name);
  }
}

check('missing settings defaults on', suggestionsEnabled(null), true);
check('empty object defaults on', suggestionsEnabled({}), true);
check('explicit on', suggestionsEnabled({ suggestionsEnabled: true }), true);
check('explicit off', suggestionsEnabled({ suggestionsEnabled: false }), false);

if (failed) {
  console.error(failed + ' test(s) failed');
  process.exit(1);
}
console.log('all suggestions tests passed');
