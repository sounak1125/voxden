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
 public static int Sends = 0;
 public static void WaitModifiersUp() {}
 public static void ForceForeground(IntPtr h) {}
 public static IntPtr GetForegroundWindow() { return new IntPtr(42); }
 public static void PasteKeys() { Pastes++; }
 public static void SendEnter() { Sends++; }
 public static void SendCtrlEnter() { Sends++; }
}
"@
`;
const checks = `
$ErrorActionPreference = 'Stop'
${stub}
${source.slice(start, serverStart)}
$paste = @(Invoke-VoxdenAction -Action paste -Hwnd '42')
$send = @(Invoke-VoxdenAction -Action send -Hwnd '42' -Keys enter)
$failed = $false
try { Invoke-VoxdenAction -Action paste -Hwnd '99' } catch { $failed = $true }
@{paste=($paste -join '');send=($send -join '');failed=$failed;pastes=[VoxdenWin]::Pastes;sends=[VoxdenWin]::Sends} | ConvertTo-Json -Compress
`;
const result = spawnSync('powershell.exe', ['-NoProfile','-EncodedCommand',encoded(checks)], {encoding:'utf8',windowsHide:true,timeout:20000});
assert.strictEqual(result.status,0,result.stderr);
const data = JSON.parse(result.stdout.trim());
assert.strictEqual(data.paste,'VOXDEN_OK');
assert.strictEqual(data.send,'VOXDEN_OK');
assert.strictEqual(data.failed,true);
assert.strictEqual(data.pastes,1);
assert.strictEqual(data.sends,1);
console.log('ok B09 paste/send acknowledge delivery and reject an unfocused target');

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
