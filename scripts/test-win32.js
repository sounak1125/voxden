'use strict';

// win32.ps1 is not exercised by the JS suite, and the bug this guards against
// was silent: assigning to a read-only automatic variable fails without
// stopping the script, so every dictation was attributed to the helper's own
// process for weeks before anyone noticed the app breakdown looked wrong.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

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

check('selection action exists', /"selection"\s*\{/.test(src), true);
check('ocr action exists', /"ocr"\s*\{/.test(src), true);
check('send action exists', /"send"\s*\{/.test(src), true);
check('copy keys release Ctrl', /VK_C[\s\S]*KEYEVENTF_KEYUP[\s\S]*VK_CONTROL/.test(src), true);
check('return key is paired with key-up', /VK_RETURN[\s\S]*KEYEVENTF_KEYUP/.test(src), true);
check('ctrl-enter releases modifiers', /SendCtrlEnter[\s\S]*VK_CONTROL, 0, KEYEVENTF_KEYUP/.test(src), true);
check('paste waits for the hotkey to come up', /WaitModifiersUp/.test(src), true);
check('paste does not load WinRT up front', /Ensure-WinRT/.test(src), true);

// The helper used to be a fresh process per call, each compiling the class
// above. The long-lived forms are what keep the paste and the paste target
// off that cost, and both loops have to live in compiled code, not in a
// PowerShell loop that wakes many times a second.
check('foreground-watch action exists', /"foreground-watch"\s*\{/.test(src), true);
check('the foreground loop is compiled', /public static void WatchForeground\(int pollMs\)/.test(src), true);
check('the foreground loop only speaks on change', /if \(first \|\| now != last\)/.test(src), true);
check('serve action exists', /\$Action -eq "serve"/.test(src), true);
check('serve answers with the request id', /@\{ id = \[string\]\$req\.id; out = \[string\]\$out \}/.test(src), true);
check('serve stops on QUIT', /if \(\$line -eq "QUIT"\) \{ break \}/.test(src), true);
check('actions are shared by one-shot and serve', /function Invoke-VoxdenAction/.test(src), true);

if (failed) {
  console.error(failed + ' failed');
  process.exit(1);
}
console.log('all win32 tests passed');

if (process.platform === 'win32') {
  execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
    path.join(__dirname, 'test-media-win32.ps1')], { stdio: 'inherit', windowsHide: true });

  // Live round trip through the server: a numeric foreground handle back for
  // the id it was asked with, then a clean exit on QUIT.
  const { spawn } = require('child_process');
  const proc = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
    path.join(__dirname, 'win32.ps1'), '-Action', 'serve'], { windowsHide: true });
  let buf = '';
  const replies = [];
  const deadline = setTimeout(() => {
    console.error('FAIL serve mode did not answer within 20s');
    proc.kill();
    process.exit(1);
  }, 20000);
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      replies.push(JSON.parse(line));
      if (replies.length === 1) proc.stdin.write(JSON.stringify({ id: 'b', action: 'info' }) + '\n');
      if (replies.length === 2) proc.stdin.write('QUIT\n');
    }
  });
  proc.on('exit', (code) => {
    clearTimeout(deadline);
    let bad = 0;
    const ok = (name, cond) => { if (cond) console.log('ok', name); else { bad += 1; console.error('FAIL', name); } };
    ok('serve exits cleanly on QUIT', code === 0);
    ok('serve answered both requests', replies.length === 2);
    ok('serve echoes the request id', replies[0] && replies[0].id === 'a' && replies[1] && replies[1].id === 'b');
    ok('serve returns a window handle for get', replies[0] && /^\d+$/.test(String(replies[0].out)));
    ok('serve returns tab-separated info', replies[1] && String(replies[1].out).split('\t').length >= 2);
    if (bad) process.exit(1);
    console.log('win32 serve mode round trip passed');
  });
  proc.stdin.write(JSON.stringify({ id: 'a', action: 'get' }) + '\n');
}
