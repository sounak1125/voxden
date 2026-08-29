'use strict';

// win32.ps1 is not exercised by the JS suite, and the bug this guards against
// was silent: assigning to a read-only automatic variable fails without
// stopping the script, so every dictation was attributed to the helper's own
// process for weeks before anyone noticed the app breakdown looked wrong.

const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, 'win32.ps1'), 'utf8');

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

// PowerShell variables are case-insensitive, so $pid, $Pid and $PID are all the
// same read-only automatic variable. Same for the other assignable-looking ones
// that silently belong to the shell. $null is deliberately absent: `$null = ...`
// is the idiomatic way to discard output, not a mistake.
const RESERVED = ['pid', 'host', 'home', 'pwd', 'true', 'false', 'error', 'input'];

function assignmentsTo(name) {
  const re = new RegExp('\\$' + name + '\\s*=(?!=)', 'gi');
  return (src.match(re) || []).length;
}

function refsTo(name) {
  const re = new RegExp('\\[ref\\]\\s*\\$' + name + '\\b', 'gi');
  return (src.match(re) || []).length;
}

for (const name of RESERVED) {
  check('never assigns to the automatic $' + name, assignmentsTo(name), 0);
  check('never passes [ref] $' + name, refsTo(name), 0);
}

// The foreground-window lookup has to resolve the process behind the window it
// was handed, not whatever process happens to be asking.
check(
  'window process id is captured into its own variable',
  /\[ref\]\s*\$targetPid\b/.test(src),
  true
);
check(
  'the process lookup uses that variable',
  /Get-Process\s+-Id\s+\$targetPid\b/.test(src),
  true
);

if (failed) {
  console.error(failed + ' failed');
  process.exit(1);
}
console.log('all win32 tests passed');
