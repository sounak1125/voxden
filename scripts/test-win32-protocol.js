'use strict';

// Exercise the real PowerShell dispatch/server code with inert native methods.
// This never focuses a window, sends keys, or controls an actual media player.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
if (process.platform !== 'win32') {
  console.log('skipped Windows helper protocol (Windows only)');
  process.exit(0);
}
const source = fs.readFileSync(path.join(__dirname, 'win32.ps1'), 'utf8');
const start = source.indexOf('function Invoke-VoxdenAction {');
const serverStart = source.indexOf('if ($Action -eq "serve") {', start);
assert(start > 0 && serverStart > start);
const encoded = script => Buffer.from(script, 'utf16le').toString('base64');
const stub = `
Add-Type @"
using System;
public class VoxdenWin {
 public static int Pastes = 0;
 public static int PasteCalls = 0;
 public static int Forced = 0;
 public static void WaitModifiersUp() {}
 public static bool KeysReady = true;
 public static string LastVks = "";
 public static bool WaitPasteKeysUp(string vks, bool space) { LastVks = vks; return KeysReady; }
 public static IntPtr Foreground = new IntPtr(42);
 public static int FocusOnAttempt = 0;
 public static bool WindowAlive = true;
 public static bool CloseOnFocus = false;
 public static bool CopyOnFocus = false;
 public static bool HoldOnFocus = false;
 public static uint ClipboardSequence = 1;
 public static string Targets = "";
 public static bool IsWindow(IntPtr h) { return WindowAlive; }
 public static uint GetClipboardSequenceNumber() { return ClipboardSequence; }
 public static void ForceForeground(IntPtr h) {
   Forced++; Targets += h.ToString() + ",";
   if (CloseOnFocus) WindowAlive = false;
   if (CopyOnFocus) ClipboardSequence++;
   if (HoldOnFocus) KeysReady = false;
   if (FocusOnAttempt > 0 && Forced >= FocusOnAttempt) Foreground = h;
 }
 // Window 77 stands for an app run as administrator.
 public static bool RunsAboveUs(IntPtr h) { return h == new IntPtr(77); }
 public static IntPtr GetForegroundWindow() { return Foreground; }
 public static bool PasteFails = false;
 public static void PasteKeys() { PasteCalls++; if (PasteFails) throw new Exception("Paste input was not accepted"); Pastes++; }
 public static bool IsElevated = false;
 public static bool Elevated() { return IsElevated; }
 // Window 55 stands for a fullscreen game or film; 66 for one of Windows' own.
 public static bool IsFullscreen(IntPtr h) { return h == new IntPtr(55) || h == new IntPtr(66); }
 public static bool PartOfWindows(IntPtr h) { return h == new IntPtr(66); }
 // A game paste waits for the player's keys; the player may copy meanwhile.
 public static bool CopyWhileWaiting = false;
 public static bool WaitKeysUp() { if (CopyWhileWaiting) ClipboardSequence++; return true; }
}
"@
`;
const checks = `
$ErrorActionPreference = 'Stop'
${stub}
${source.slice(start, serverStart)}
$paste = @(Invoke-VoxdenAction -Action paste -Hwnd '42')
$failed = $false
try { Invoke-VoxdenAction -Action paste -Hwnd '99' } catch { $failed = $true }
$forcedBefore = [VoxdenWin]::Forced
$admin = ''
try { Invoke-VoxdenAction -Action paste -Hwnd '77' } catch { $admin = [string]$_ }
$notElevated = @(Invoke-VoxdenAction -Action elevated) -join ','
[VoxdenWin]::IsElevated = $true
$elevated = @(Invoke-VoxdenAction -Action elevated) -join ','
[VoxdenWin]::KeysReady = $false
$held = ''
try { Invoke-VoxdenAction -Action paste -Hwnd '42' -Vks '17,90' } catch { $held = [string]$_ }
$waitedFor = [VoxdenWin]::LastVks
[VoxdenWin]::KeysReady = $true
[VoxdenWin]::PasteFails = $true
$rejected = ''
try { Invoke-VoxdenAction -Action paste -Hwnd '42' } catch { $rejected = [string]$_ }
$adminForced = [VoxdenWin]::Forced - $forcedBefore
$pastesSoFar = [VoxdenWin]::Pastes
[VoxdenWin]::PasteFails = $false
[VoxdenWin]::Foreground = [IntPtr]55
$coverBefore = [VoxdenWin]::Forced
$overFullscreen = ''
try { Invoke-VoxdenAction -Action paste -Hwnd '42' } catch { $overFullscreen = [string]$_ }
$fullscreenForced = [VoxdenWin]::Forced - $coverBefore
[VoxdenWin]::Foreground = [IntPtr]66
[VoxdenWin]::FocusOnAttempt = 1
$overWindows = ''
try { $overWindows = @(Invoke-VoxdenAction -Action paste -Hwnd '42') -join '' } catch { $overWindows = [string]$_ }
[VoxdenWin]::FocusOnAttempt = 0
[VoxdenWin]::Foreground = [IntPtr]42
[VoxdenWin]::CopyWhileWaiting = $true
$pastesBefore = [VoxdenWin]::Pastes
$gameCopied = ''
try { Invoke-VoxdenAction -Action paste -Hwnd '42' -Mode game } catch { $gameCopied = [string]$_ }
$gameCopiedPastes = [VoxdenWin]::Pastes - $pastesBefore
[VoxdenWin]::CopyWhileWaiting = $false
$baseline = @{paste=($paste -join '');failed=$failed;pastes=$pastesSoFar;admin=$admin;adminForced=$adminForced;notElevated=$notElevated;elevated=$elevated;held=$held;waitedFor=$waitedFor;rejected=$rejected}
$baseline.overFullscreen = $overFullscreen; $baseline.fullscreenForced = $fullscreenForced; $baseline.overWindows = $overWindows
$baseline.gameCopied = $gameCopied; $baseline.gameCopiedPastes = $gameCopiedPastes
$retryCases = @()
foreach ($scenario in @('focused','second','third','refused','closed','closes-during-focus','clipboard-changed','keys-held','input-rejected')) {
 [VoxdenWin]::Foreground = [IntPtr]42
 [VoxdenWin]::Forced = 0
 [VoxdenWin]::Pastes = 0
 [VoxdenWin]::PasteCalls = 0
 [VoxdenWin]::Targets = ''
 [VoxdenWin]::FocusOnAttempt = switch ($scenario) { 'second' {2} 'third' {3} 'clipboard-changed' {1} 'keys-held' {1} 'input-rejected' {2} default {0} }
 [VoxdenWin]::WindowAlive = $scenario -ne 'closed'
 [VoxdenWin]::CloseOnFocus = $scenario -eq 'closes-during-focus'
 [VoxdenWin]::CopyOnFocus = $scenario -eq 'clipboard-changed'
 [VoxdenWin]::HoldOnFocus = $scenario -eq 'keys-held'
 [VoxdenWin]::PasteFails = $scenario -eq 'input-rejected'
 [VoxdenWin]::KeysReady = $true
 $target = if ($scenario -eq 'focused') {'42'} else {'99'}
 $answer = ''; $failure = ''
 try { $answer = @(Invoke-VoxdenAction -Action paste -Hwnd $target) -join '' } catch { $failure = [string]$_ }
 $retryCases += @{name=$scenario;answer=$answer;failure=$failure;pastes=[VoxdenWin]::Pastes;pasteCalls=[VoxdenWin]::PasteCalls;forced=[VoxdenWin]::Forced;targets=[VoxdenWin]::Targets}
}
@{baseline=$baseline;retryCases=$retryCases} | ConvertTo-Json -Compress -Depth 5
`;
const result = spawnSync('powershell.exe', ['-NoProfile','-EncodedCommand',encoded(checks)], {encoding:'utf8',windowsHide:true,timeout:20000});
assert.strictEqual(result.status,0,result.stderr);
const { baseline: data, retryCases } = JSON.parse(result.stdout.trim());
assert.strictEqual(data.paste,'VOXDEN_OK');
assert.strictEqual(data.failed,true);
assert.strictEqual(data.pastes,1);
console.log('ok B09 paste acknowledges delivery and rejects an unfocused target');
assert.strictEqual(data.admin,'Target runs as administrator');
assert.strictEqual(data.adminForced,0,'an app run as administrator is not brought forward');
console.log('ok an app run as administrator is refused before any key or focus change');
assert.strictEqual(data.notElevated,'0');
assert.strictEqual(data.elevated,'1');
console.log('ok the elevated action answers one line, 0 or 1');
assert.strictEqual(data.held, 'Paste keys are still held');
assert.strictEqual(data.waitedFor, '17,90');
assert.match(data.rejected, /Paste input was not accepted/);
console.log('ok a held paste-last chord or rejected input produces no success acknowledgement');
assert.strictEqual(data.overFullscreen, 'A fullscreen app is in front');
assert.strictEqual(data.fullscreenForced, 0, 'nothing is pulled over a fullscreen game or film');
assert.strictEqual(data.overWindows, 'VOXDEN_OK', "Windows' own surfaces are not a fullscreen app");
console.log('ok an ordinary paste never covers a fullscreen app in front');
assert.strictEqual(data.gameCopied, 'Clipboard changed before paste');
assert.strictEqual(data.gameCopiedPastes, 0);
console.log('ok a game paste refuses a clipboard the player changed while it waited');
for (const row of retryCases) {
  const success = ['focused', 'second', 'third'].includes(row.name);
  assert.strictEqual(row.pastes, success ? 1 : 0, row.name + ' pastes at most once');
  assert.strictEqual(row.pasteCalls, success || row.name === 'input-rejected' ? 1 : 0,
    row.name + ' never retries rejected or partially delivered input');
  assert.strictEqual(row.answer, success ? 'VOXDEN_OK' : '', row.name + ' acknowledges only a successful paste');
  const attempts = { focused: 0, second: 2, third: 3, refused: 3, closed: 0,
    'closes-during-focus': 1, 'clipboard-changed': 1, 'keys-held': 1, 'input-rejected': 2 }[row.name];
  assert.strictEqual(row.forced, attempts, row.name + ' retries focus only within the limit');
  assert.strictEqual(row.targets, '99,'.repeat(attempts), row.name + ' never substitutes another window');
  if (!success) assert.match(row.failure, /could not be focused|no longer available|Clipboard changed|keys are still held|input was not accepted/);
}
console.log('ok transient focus refusal recovers; missing windows, clipboard changes, held keys and rejected input never paste');

const server = `
$Action = 'serve'
function Invoke-VoxdenAction {
 param($Action,$Hwnd,$Ids,$Keys,$Vks)
 if ($Action -eq 'media-pause') {
  Write-Output 'player-one'
  Start-Sleep -Milliseconds 700
  throw 'Second player failed'
 }
}
${source.slice(serverStart)}
`;
const child=spawn('powershell.exe',['-NoProfile','-EncodedCommand',encoded(server)],{windowsHide:true,stdio:['pipe','pipe','pipe']});
const messages=[];
let buffer='';
let stderr='';
let partialAt=0;
let doneAt=0;
const deadline=setTimeout(()=>{child.kill();console.error('Helper protocol timeout');process.exitCode=1;},15000);
child.stderr.on('data',chunk=>{stderr+=chunk;});
child.stdout.on('data',chunk=>{
  buffer+=chunk;
  let end;
  while((end=buffer.indexOf('\n'))>=0) {
    const line=buffer.slice(0,end).trim();buffer=buffer.slice(end+1);
    if(!line)continue;
    const msg=JSON.parse(line);messages.push(msg);
    if(msg.partial)partialAt=Date.now();
    else {doneAt=Date.now();child.stdin.end('QUIT\n');}
  }
});
child.on('error',err=>{clearTimeout(deadline);console.error(err);process.exitCode=1;});
child.on('exit',code=>{
  clearTimeout(deadline);
  try {
    assert.strictEqual(code,0,stderr);
    assert.strictEqual(messages.length,2);
    assert.strictEqual(messages[0].partial,true);
    assert.strictEqual(messages[0].out,'player-one');
    assert(!messages[1].partial);
    assert(doneAt-partialAt >= 500,'successful receipt must arrive before the slow/failing player finishes');
    console.log('ok B23 real helper streams successful receipts before a later failure');
  } catch(err) {console.error(err);process.exitCode=1;}
});
child.stdin.write(JSON.stringify({id:'request-1',action:'media-pause'})+'\n');
