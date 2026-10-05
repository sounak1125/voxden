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

// Only the actions main.js calls ship. Selection, OCR, send, set, keys-down
// and media-list had no caller left and were removed.
for (const action of ['selection', 'ocr', 'send', 'set', 'keys-down', 'media-list']) {
  check(action + ' action is gone', new RegExp('"' + action + '"\\s*\\{').test(src), false);
}
check('paste keys release Ctrl', /PasteKeys\(\) \{[\s\S]*?VK_V, v, KEYEVENTF_KEYUP[\s\S]*?VK_CONTROL, ctrl, KEYEVENTF_KEYUP/.test(src), true);
// Raw input -- what games read -- gets scan code 0 as a key that does not
// exist; Windows does not fill it in from the virtual key.
check('paste keys carry scan codes', /PasteKeys\(\) \{\s*byte ctrl = ScanCode\(VK_CONTROL\);\s*byte v = ScanCode\(VK_V\);/.test(src), true);
check('paste submits and checks one complete input batch',
  /uint sent = SendInput\(\(uint\)inputs.Length, inputs, size\);\s*if \(sent == inputs.Length\) return;/.test(src), true);
check('paste never forces held user keys up', !src.includes('ReleaseModifiers'), true);
check('copy keys release Ctrl', /CopyInsertKeys\(\) \{[\s\S]*?KEYEVENTF_KEYUP[\s\S]*?VK_CONTROL, 0, KEYEVENTF_KEYUP/.test(src), true);
check('paste waits for the hotkey to come up', /WaitModifiersUp/.test(src), true);
check('a game paste refuses keys when held modifiers time out',
  /if \(-not \[VoxdenWin\]::WaitKeysUp\(\)\) \{ throw "Game paste modifiers are still held" \}/.test(src), true);
check('paste does not load WinRT up front', /Ensure-WinRT/.test(src), true);

// The helper used to be a fresh process per call, each compiling the class
// above. The long-lived forms are what keep the paste and the paste target
// off that cost, and both loops have to live in compiled code, not in a
// PowerShell loop that wakes many times a second.
check('foreground-watch action exists', /"foreground-watch"\s*\{/.test(src), true);
check('the foreground loop is compiled', /public static void WatchForeground\(int pollMs\)/.test(src), true);
check('the foreground loop only speaks on change',
  src.includes('bool changed = first || now != last;') && src.includes('if (changed || full != lastFull) {'), true);
// main.js hides the resting flow bar while a fullscreen app is in front on the
// bar's own screen, so the mark carries the monitor it fills.
check('the foreground loop marks a fullscreen window with its monitor',
  src.includes('" fullscreen " + monitor.Left + "," + monitor.Top + "," + monitor.Right + "," + monitor.Bottom'), true);
// ...and explains, in the bell, an app run as administrator in front. Its
// level is asked when the window changes, not on every poll.
check('the foreground loop marks a window run as administrator', src.includes('(admin ? " admin" : "")'), true);
check('the foreground loop asks the level only for a new window',
  /if \(changed\) \{\s*windows = PartOfWindows\(now\);\s*admin = !windows && RunsAboveUs\(now\);\s*shell = windows && ShellSurface\(now\);\s*\}/.test(src), true);
// Windows' own programs get neither mark: the taskbar's window list fills the
// screen, and the bar standing aside for it closed the list (2026-10-05).
check('Windows itself is never fullscreen to the foreground loop',
  src.includes('string full = !windows && FillsMonitor(now, out monitor)'), true);
// Its passing surfaces (Start, Alt+Tab) are marked so main.js leaves the bar
// where it was rather than bring it back over the game underneath.
check('the foreground loop marks Windows\' passing surfaces', src.includes('(shell ? " shell" : "")'), true);
// A lone key pressed with another modifier held is that app's shortcut.
check('the chord watcher says when a modifier was already held',
  src.includes('Console.Out.WriteLine(ExtraModifierDown(chord) ? "DOWN modified" : "DOWN");'), true);
// A game paste checks the clipboard like any other: the player may have
// copied something during its two-second wait for held keys.
const gamePaste = src.slice(src.indexOf('if ($Mode -eq "game") {'), src.indexOf('[VoxdenWin]::PasteKeys()', src.indexOf('if ($Mode -eq "game") {')));
check('a game paste refuses a clipboard changed under it', gamePaste.includes('Clipboard changed before paste'), true);
// An ordinary paste never pulls its window over a fullscreen game in front.
check('an ordinary paste refuses rather than cover a fullscreen app',
  /\$front -ne \$h -and \[VoxdenWin\]::IsFullscreen\(\$front\)[^\n]*\n\s*throw "A fullscreen app is in front"/.test(src.replace(/\r\n/g, '\n')), true);
// Settings offers a restart as administrator only to a Voxden not running as one.
check('elevated action exists', /"elevated"\s*\{[^}]*\[VoxdenWin\]::Elevated\(\)/.test(src), true);
check('elevated means high integrity or above', /Elevated\(\) \{\s*return IntegrityOf\(GetCurrentProcess\(\)\) >= 0x3000;/.test(src), true);
check('serve action exists', /\$Action -eq "serve"/.test(src), true);
check('serve answers with the request id', /@\{ id = \[string\]\$req\.id; out = \[string\]\$out \}/.test(src), true);
check('serve stops on QUIT', /if \(\$line -eq "QUIT"\) \{ break \}/.test(src), true);
check('actions are shared by one-shot and serve', /function Invoke-VoxdenAction/.test(src), true);
check('active render endpoints are enumerated', /EnumAudioEndpoints\(VoxdenDataFlow\.Render, VoxdenDeviceState\.Active/.test(src), true);
check('the Windows endpoint collection IID is exact', src.includes('0BD7A1BE-7A1A-44DB-8397-CC5392387B5E'), true);
check('endpoint mute has ownership receipts', /MuteActiveRenderEndpoints[\s\S]*changed\.Add\(id\)/.test(src), true);
check('already muted endpoints are preserved', /GetMute\(out muted\)[\s\S]{0,60}muted\) continue/.test(src), true);
check('endpoint receipts are restored before media resumes',
  /function Invoke-VoxdenMediaResume[\s\S]*?Invoke-VoxdenEndpointRestore[\s\S]{0,300}\$mgr = Get-VoxdenMediaManager/.test(src), true);

if (failed) {
  console.error(failed + ' failed');
  process.exit(1);
}
console.log('all win32 tests passed');

if (process.platform === 'win32') {
  // Run the compiled wait logic with fake key states. No physical key is
  // pressed and no desktop input is read, including the held-key timeout.
  const keyStateDeclaration = '[DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vKey);';
  const fakeKeyState = `public static int FakeKey = 0, FakeReads = 0;
    public static bool FakeRelease = false;
    public static short GetAsyncKeyState(int vKey) {
      if (vKey != FakeKey) return 0;
      FakeReads++;
      return FakeRelease && FakeReads > 2 ? (short)0 : (short)-32768;
    }`;
  const nativeClass = src.match(/Add-Type @"\r?\n([\s\S]*?)\r?\n"@/)[1];
  if (!nativeClass.includes(keyStateDeclaration)) throw new Error('Native key-state declaration changed');
  const waitTest = `$ErrorActionPreference = 'Stop'
Add-Type @"
${nativeClass.replace(keyStateDeclaration, fakeKeyState)}
"@
if (-not [VoxdenWin]::WaitKeysUp()) { throw 'Unheld keys should paste' }
foreach ($key in @(0x10, 0x11, 0x12, 0x5B, 0x5C)) {
  [VoxdenWin]::FakeKey = $key
  [VoxdenWin]::FakeRelease = $false
  if ([VoxdenWin]::WaitKeysUp()) { throw "Held key $key should refuse the paste" }
}
[VoxdenWin]::FakeKey = 0x10
[VoxdenWin]::FakeReads = 0
[VoxdenWin]::FakeRelease = $true
if (-not [VoxdenWin]::WaitKeysUp()) { throw 'Released keys should paste' }
[VoxdenWin]::FakeKey = 0x20
[VoxdenWin]::FakeRelease = $false
if (-not [VoxdenWin]::WaitKeysUp()) { throw 'A held jump should not block the paste' }
if ([VoxdenWin]::WaitPasteKeysUp('', $true)) { throw 'An ordinary paste waits for held Space' }
[VoxdenWin]::FakeKey = 0x5A
if ([VoxdenWin]::WaitPasteKeysUp('17,91|92,90', $true)) { throw 'The Z in the paste-last shortcut is still held' }
[VoxdenWin]::FakeReads = 0
[VoxdenWin]::FakeRelease = $true
if (-not [VoxdenWin]::WaitPasteKeysUp('17,91|92,90', $true)) { throw 'Released Z should allow paste' }
Write-Output 'ok game paste refuses held modifiers, resumes after release, and permits jump'`;
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    'Invoke-Expression ([Console]::In.ReadToEnd())'],
  { input: waitTest, stdio: ['pipe', 'inherit', 'inherit'], windowsHide: true, timeout: 30000 });
  const sendDeclaration = '[DllImport("user32.dll", SetLastError = true)] public static extern uint SendInput(uint count, INPUT[] inputs, int size);';
  if (!nativeClass.includes(sendDeclaration)) throw new Error('Native SendInput declaration changed');
  const fakeSend = `public static uint FakeSent = 4;
    public static System.Collections.Generic.List<INPUT[]> Calls = new System.Collections.Generic.List<INPUT[]>();
    public static uint SendInput(uint count, INPUT[] inputs, int size) {
      if (size != Marshal.SizeOf(typeof(INPUT)) || count != inputs.Length) throw new Exception("Invalid input buffer");
      Calls.Add(inputs);
      return Calls.Count == 1 ? FakeSent : count;
    }`;
  const inputTest = `$ErrorActionPreference = 'Stop'
Add-Type @"
${nativeClass.replace(sendDeclaration, fakeSend)}
"@
$expectedSize = if ([IntPtr]::Size -eq 8) { 40 } else { 28 }
if ([Runtime.InteropServices.Marshal]::SizeOf([type][VoxdenWin+INPUT]) -ne $expectedSize) { throw 'Wrong native INPUT size' }
foreach ($accepted in @(0, 1, 2, 3, 4)) {
  [VoxdenWin]::FakeSent = $accepted
  [VoxdenWin]::Calls.Clear()
  $failure = ''
  try { [VoxdenWin]::PasteKeys() } catch { $failure = [string]$_ }
  if (($accepted -eq 4) -ne ($failure -eq '')) { throw "Wrong result after accepting $accepted keys" }
  $batch = [VoxdenWin]::Calls[0]
  if ($batch.Count -ne 4) { throw 'Paste was not one complete batch' }
  if (($batch | ForEach-Object { $_.data.keyboard.vk }) -join ',' -ne '17,86,86,17') { throw 'Wrong key order' }
  if (($batch | ForEach-Object { $_.data.keyboard.flags }) -join ',' -ne '0,0,2,2') { throw 'Wrong key transitions' }
  if (@($batch | Where-Object { $_.data.keyboard.scan -eq 0 }).Count) { throw 'Missing scan codes' }
  $expectedCalls = if ($accepted -gt 0 -and $accepted -lt 4) { 2 } else { 1 }
  if ([VoxdenWin]::Calls.Count -ne $expectedCalls) { throw 'Paste was replayed or cleanup is missing' }
  if ($expectedCalls -eq 2) {
    $release = [VoxdenWin]::Calls[1]
    $expectedKeys = if ($accepted -eq 2) { '86,17' } else { '17' }
    if (($release | ForEach-Object { $_.data.keyboard.vk }) -join ',' -ne $expectedKeys) { throw 'Cleanup releases keys that were not left down' }
    if (@($release | Where-Object { $_.data.keyboard.flags -ne 2 }).Count) { throw 'Cleanup retried a key-down' }
  }
}
Write-Output "ok $expectedSize-byte INPUT layout, checked batch delivery and partial-insertion cleanup"`;
  const probeHosts = ['powershell.exe'];
  const x86PowerShell = path.join(process.env.SystemRoot || 'C:\\Windows', 'SysWOW64/WindowsPowerShell/v1.0/powershell.exe');
  if (process.arch === 'x64' && fs.existsSync(x86PowerShell)) probeHosts.push(x86PowerShell);
  for (const host of probeHosts) {
    execFileSync(host, ['-NoProfile', '-NonInteractive', '-Command', 'Invoke-Expression ([Console]::In.ReadToEnd())'],
      { input: inputTest, stdio: ['pipe', 'inherit', 'inherit'], windowsHide: true, timeout: 20000 });
  }
  execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
    path.join(__dirname, 'test-media-win32.ps1')], { stdio: 'inherit', windowsHide: true });
  execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
    path.join(__dirname, 'test-paste-keys-win32.ps1')], { stdio: 'inherit', windowsHide: true });

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
