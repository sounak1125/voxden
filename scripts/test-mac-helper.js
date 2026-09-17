'use strict';

// The macOS helper is the counterpart of win32.ps1 and is checked the same
// way: the source must keep the protocol main.js relies on, and on macOS the
// compiled helper must answer a serve round trip. Accessibility is not
// granted on a CI runner, so the paste itself is not exercised here; the
// helper must report that cleanly instead of hanging.

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync, execFileSync } = require('child_process');

function spawnSyncStatus(file, args) {
  return spawnSync(file, args, { encoding: 'utf8', timeout: 5000 }).status;
}

const src = fs.readFileSync(path.join(__dirname, '..', 'helper', 'mac', 'main.swift'), 'utf8');

let failed = 0;
function check(name, cond) {
  if (cond) console.log('ok', name);
  else { failed += 1; console.error('FAIL', name); }
}

check('serve reads QUIT', /if line == "QUIT" \{ break \}/.test(src));
check('serve answers with the request id', /\["id": id, "out": out\]/.test(src));
check('get returns a window id', /case "get":\s*\n\s*return String\(currentWindow\(\)\.id\)/.test(src));
check('info is tab separated', /"\\\(info\.id\)\\t\\\(ownerName\(info\.pid\)\)\\t\\\(title\)"/.test(src));
check('paste reports VOXDEN_OK', /return "VOXDEN_OK"/.test(src));
check('paste refuses without Accessibility', /guard AXIsProcessTrusted\(\) else \{ throw HelperError\.accessibility \}/.test(src));
check('paste waits for the chord to be released', /waitModifiersUp\(\)\s*\n\s*try bringToFront/.test(src));
check('paste posts Command+V', /postKey\(9, flags: \.maskCommand\)/.test(src));
check('foreground watch only speaks on change', /if first \|\| now != last/.test(src));
check('windows are described by CGWindowID', /_AXUIElementGetWindow/.test(src));
check('output is flushed per line', /fflush\(stdout\)/.test(src));
check('chord state is polled, not tapped', /CGEventSource\.keyState\(\.combinedSessionState, key: code\)/.test(src));
check('chord watch opens with HELD or FREE', /emit\(held \? "HELD" : "FREE"\)/.test(src));

if (failed) {
  console.error(failed + ' failed');
  process.exit(1);
}
console.log('all mac helper source checks passed');

if (process.platform !== 'darwin') {
  console.log('skipped mac helper round trip (not macOS)');
  process.exit(0);
}

const { buildMacHelper } = require('./build-mac-helper');
const helper = buildMacHelper({ quiet: true });

const oneShot = execFileSync(helper, ['get'], { encoding: 'utf8' }).trim();
check('one-shot get prints a window id', /^\d+$/.test(oneShot));
const access = execFileSync(helper, ['accessibility'], { encoding: 'utf8' }).trim();
check('accessibility reports granted or missing', access === 'granted' || access === 'missing');

// A chord watcher on a runner where nobody is touching the keyboard: FREE,
// then nothing, and it goes away when killed.
const watch = spawnSync(helper, ['-Action', 'hotkey-watch', '-Vks', '59|62,55|54'], { encoding: 'utf8', timeout: 600 });
check('hotkey watch opens with FREE', String(watch.stdout || '').trim() === 'FREE');
check('hotkey watch runs until killed', watch.signal === 'SIGTERM');
const empty = spawnSyncStatus(helper, ['-Action', 'hotkey-watch', '-Vks', '']);
check('hotkey watch refuses an empty chord', empty === 2);

const proc = spawn(helper, ['-Action', 'serve']);
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
    if (replies.length === 2) proc.stdin.write(JSON.stringify({ id: 'c', action: 'media-pause' }) + '\n');
    if (replies.length === 3) proc.stdin.write('QUIT\n');
  }
});
proc.stdin.write(JSON.stringify({ id: 'a', action: 'get' }) + '\n');
proc.on('exit', (code) => {
  clearTimeout(deadline);
  check('serve exits cleanly on QUIT', code === 0);
  check('serve answered every request', replies.length === 3);
  check('serve echoes the request id', replies[0] && replies[0].id === 'a' && replies[1] && replies[1].id === 'b');
  check('serve returns a window id for get', replies[0] && /^\d+$/.test(String(replies[0].out)));
  check('serve returns tab-separated info', replies[1] && String(replies[1].out).split('\t').length >= 2);
  check('serve answers an unsupported action with nothing', replies[2] && replies[2].out === '');
  if (failed) process.exit(1);
  console.log('mac helper serve mode round trip passed');
});
