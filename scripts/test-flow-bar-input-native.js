'use strict';

// Real main.js, real overlay window, real OS mouse. The flow bar used to come
// back from being covered by another window, from a display power-off, or from
// a hide/minimize it did not do itself, looking right and expanding on hover
// while no click or drag ever reached the page again: Chromium hides the child
// window that takes the renderer's input and, with backgroundThrottling off,
// never re-shows it. Nothing in the app's IPC could see that state, so this
// sends genuine mouse_event clicks and asks the page what it received.
//
// Windows only, and it needs a desktop: the cursor is moved onto the bar and
// put back afterwards, and an opaque topmost window from another process
// covers the bar for a few seconds. A disposable profile keeps the installed
// app's preferences out of it; no recording is started.
const { app, BrowserWindow, screen, globalShortcut } = require('electron');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');
const { promisify } = require('util');
const runFile = promisify(execFile);

if (process.platform !== 'win32') {
  console.log('flow bar input: skipped, Windows only');
  app.exit(0);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voxden-flowbar-input-'));
app.setPath('userData', root);
Object.defineProperty(app, 'isPackaged', { value: true });
app.getVersion = () => require('../package.json').version;
const settingsFile = path.join(root, 'data', 'settings.json');
fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
// A fixed spot on the primary display, away from wherever the user keeps
// their own bar, so the clicks below can only land on this fixture.
fs.writeFileSync(settingsFile, JSON.stringify({
  alwaysShowFlowBar: true, flowBarAnchor: { x: 700, y: 620 }, flowBarStyle: 'classic',
  flowBarMotion: 'reduced', soundsEnabled: false,
}));
app.setLoginItemSettings = () => {};
globalShortcut.register = () => true;
globalShortcut.unregister = () => {};
globalShortcut.unregisterAll = () => {};
require('../src/updater').startUpdater = () => {};
// The overlay must be genuinely on screen; the dashboard has no business appearing.
BrowserWindow.prototype.show = function () {};
BrowserWindow.prototype.focus = function () {};
if (!process.argv.includes('--hidden')) process.argv.push('--hidden');

const errors = [];
app.on('web-contents-created', (_event, contents) => {
  contents.on('render-process-gone', (_event, details) => errors.push('Renderer exited: ' + details.reason));
  contents.on('console-message', (event, level, message) => {
    const lvl = event && event.level !== undefined ? event.level : level;
    const text = event && event.message !== undefined ? event.message : message;
    if ((lvl === 'error' || Number(lvl) >= 3) && !/Content-Security-Policy/.test(String(text))) errors.push(String(text));
  });
});

require('../src/main');

const deadline = setTimeout(() => { console.error('Flow bar input test timed out'); app.exit(1); }, 90000);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const overlayWindow = () => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/overlay.html'));

// Cursor and clicks in physical pixels from a per-monitor DPI aware helper;
// the cover is an opaque topmost WinForms window from that same other process.
const helper = path.join(root, 'mouse.ps1');
fs.writeFileSync(helper, `param([string]$Action, [int]$X = 0, [int]$Y = 0, [int]$W = 0, [int]$H = 0, [int]$Ms = 0)
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class MouseProbe {
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, int dx, int dy, uint data, IntPtr extra);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
}
'@
[void][MouseProbe]::SetProcessDpiAwarenessContext([IntPtr]::new(-4))
switch ($Action) {
  'cursor' { $p = New-Object MouseProbe+POINT; [void][MouseProbe]::GetCursorPos([ref]$p); Write-Output ($p.X.ToString() + ' ' + $p.Y.ToString()) }
  'move' { [void][MouseProbe]::SetCursorPos($X, $Y); Write-Output 'ok' }
  'click' {
    [void][MouseProbe]::SetCursorPos($X, $Y)
    Start-Sleep -Milliseconds 60
    [MouseProbe]::mouse_event(2, 0, 0, 0, [IntPtr]::Zero)
    Start-Sleep -Milliseconds 60
    [MouseProbe]::mouse_event(4, 0, 0, 0, [IntPtr]::Zero)
    Write-Output 'ok'
  }
  'cover' {
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    $f = New-Object System.Windows.Forms.Form
    $f.FormBorderStyle = 'None'; $f.StartPosition = 'Manual'; $f.ShowInTaskbar = $false; $f.TopMost = $true
    $f.BackColor = [System.Drawing.Color]::DarkSlateGray
    $f.Location = New-Object System.Drawing.Point($X, $Y)
    $f.Size = New-Object System.Drawing.Size($W, $H)
    $f.Show(); $f.TopMost = $true
    $end = (Get-Date).AddMilliseconds($Ms)
    while ((Get-Date) -lt $end) { [System.Windows.Forms.Application]::DoEvents(); Start-Sleep -Milliseconds 30 }
    $f.Close()
    Write-Output 'covered'
  }
}
`);
const psArgs = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper, '-Action'];
async function mouse(action, extra = []) {
  const result = await runFile('powershell.exe', [...psArgs, action, ...extra], { windowsHide: true, timeout: 15000 });
  return result.stdout.trim();
}
function physical(win, dip) {
  return screen.dipToScreenPoint({ x: Math.round(dip.x), y: Math.round(dip.y) });
}

app.whenReady().then(async () => {
  const disabled = String(app.commandLine.getSwitchValue('disable-features')).split(',');
  assert.ok(disabled.includes('CalculateNativeWinOcclusion'),
    'Chromium occlusion tracking must stay off for the overlay: ' + disabled.join(','));
  assert.ok(disabled.includes('OverlayScrollbar'), 'the earlier feature switch must survive the merge');

  let overlay;
  for (let i = 0; i < 150 && !(overlay && !overlay.webContents.isLoading() && overlay.isVisible()); i++) {
    overlay = overlayWindow();
    await pause(100);
  }
  assert(overlay && overlay.isVisible(), 'the flow bar has to be on screen');
  await pause(600);
  const page = code => overlay.webContents.executeJavaScript(code);
  // Count what the page receives and swallow it: a real pointerdown on the
  // resting bar would otherwise start a dictation or a drag.
  await page(`window.__probe = { down: 0 };
    window.addEventListener('pointerdown', e => { window.__probe.down++; e.stopImmediatePropagation(); e.preventDefault(); }, true);
    for (const t of ['mousedown', 'click', 'pointerup', 'mouseup']) window.addEventListener(t, e => { e.stopImmediatePropagation(); e.preventDefault(); }, true);
    true`);

  const savedCursor = (await mouse('cursor')).split(' ').map(Number);
  const bounds = overlay.getBounds();
  // Inside the hover entry zone of the resting bar (bottom centre), which is
  // where main turns click-through off and the pixel where a user would grab.
  const hoverDip = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height - 23 };
  const hover = physical(overlay, hoverDip);
  const away = physical(overlay, { x: bounds.x + bounds.width + 200, y: bounds.y - 200 });
  const rect = screen.dipToScreenRect(overlay, bounds);

  async function clickReachesPage(label) {
    await mouse('move', ['-X', String(hover.x), '-Y', String(hover.y)]);
    // The cursor poll runs every 40 ms; give it a few ticks to decide hover
    // and rearm before the button goes down.
    await pause(350);
    const before = await page('window.__probe.down');
    await mouse('click', ['-X', String(hover.x), '-Y', String(hover.y)]);
    await pause(400);
    const after = await page('window.__probe.down');
    assert.strictEqual(after - before, 1, label + ': a click on the bar must reach the page');
  }
  async function leave() {
    await mouse('move', ['-X', String(away.x), '-Y', String(away.y)]);
    await pause(300);
  }

  try {
    await clickReachesPage('fresh bar');

    // Covered by another process's topmost window, as a full-screen video, a
    // game overlay or a meeting toolbar does. Chromium used to count that as
    // occlusion and hide the input window for good.
    await leave();
    await new Promise((resolve, reject) => {
      const cover = spawn('powershell.exe', [...psArgs, 'cover',
        '-X', String(rect.x - 40), '-Y', String(rect.y - 40), '-W', String(rect.width + 80), '-H', String(rect.height + 80), '-Ms', '3000',
      ], { windowsHide: true });
      cover.on('error', reject);
      cover.on('exit', resolve);
    });
    await pause(800);
    assert.strictEqual(overlay.isVisible(), true, 'a covered bar is never hidden');
    await clickReachesPage('after another window covered the bar');

    // Hidden and re-shown behind main's back, synchronously so the visibility
    // rescue never runs: what Windows does when it minimizes and restores the
    // bar, and what a hide()/showInactive() from anywhere but showOverlay does.
    await leave();
    const before = overlay.getBounds();
    overlay.hide();
    overlay.showInactive();
    assert.strictEqual(overlay.isVisible(), true);
    await pause(300);
    await clickReachesPage('after a hide and show that main did not perform');
    await leave();
    overlay.minimize();
    overlay.showInactive();
    assert.strictEqual(overlay.isVisible(), true);
    await pause(300);
    await clickReachesPage('after Windows minimized and restored the bar');
    assert.deepStrictEqual(overlay.getBounds(), before, 'the rearm leaves the bar exactly where it was');
  } finally {
    await mouse('move', ['-X', String(savedCursor[0]), '-Y', String(savedCursor[1])]).catch(() => {});
  }

  assert.deepStrictEqual(errors, []);
  console.log('flow bar input: clicks reach the page after another window covered the bar and after a hide, show, minimize or restore that main did not perform');
  clearTimeout(deadline);
  app.exit(0);
}).catch(err => { console.error(err); app.exit(1); });
