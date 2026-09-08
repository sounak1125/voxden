'use strict';

// Real main/preload/renderers, native visibility and Windows caption hit testing.
// A disposable profile and stubbed login/update/hotkey services keep this test
// separate from the installed app and its preferences. No recording is started.
const { app, BrowserWindow, screen, session, globalShortcut } = require('electron');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const runFile = promisify(execFile);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voxden-system-native-'));
app.setPath('userData', root);
app.disableHardwareAcceleration();
Object.defineProperty(app, 'isPackaged', { value: true });
app.getVersion = () => require('../package.json').version;
const settingsFile = path.join(root, 'data', 'settings.json');
fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
fs.writeFileSync(settingsFile, JSON.stringify({
  launchAtLogin: false, alwaysShowFlowBar: false, flowBarMotion: 'full', soundsEnabled: false,
}));
const loginCalls = [];
app.setLoginItemSettings = options => loginCalls.push(options);
globalShortcut.register = () => true;
globalShortcut.unregister = () => {};
globalShortcut.unregisterAll = () => {};
require('../src/updater').startUpdater = () => {};
// Keep the fixture visible for native hit testing without taking keyboard focus.
const nativeShowInactive = BrowserWindow.prototype.showInactive;
const shown = new Set();
BrowserWindow.prototype.show = function () { shown.add(this); nativeShowInactive.call(this); };
BrowserWindow.prototype.focus = function () {};
app.whenReady().then(() => {
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
});
const errors = [];
app.on('web-contents-created', (_event, contents) => {
  contents.on('render-process-gone', (_event, details) => errors.push('Renderer exited: ' + details.reason));
  contents.on('console-message', event => {
    if ((event.level === 'error' || Number(event.level) >= 3)
        && !/Content-Security-Policy/.test(event.message)) errors.push(event.message);
  });
});
require('../src/main');

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const deadline = setTimeout(() => { console.error('System native test timed out'); app.exit(1); }, 45000);
const findWindow = file => BrowserWindow.getAllWindows().find(win => win.webContents.getURL().endsWith('/' + file));
async function until(predicate, message) {
  const end = Date.now() + 6000;
  do { if (await predicate()) return; await pause(40); } while (Date.now() < end);
  assert.fail(message);
}

// Send WM_NCHITTEST only to this fixture's HWND. Windows reports HTCAPTION=2
// when dragging this point would move the window, and HTCLIENT=1 on controls.
const hitScript = path.join(root, 'caption-hit.ps1');
fs.writeFileSync(hitScript, `param([long]$WindowHandle, [int]$PointX, [int]$PointY)
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class CaptionProbe {
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] public static extern IntPtr SendMessageW(IntPtr hwnd, uint message, IntPtr wparam, IntPtr lparam);
}
'@
[void][CaptionProbe]::SetThreadDpiAwarenessContext([IntPtr]::new(-4))
$packedPoint = (($PointY -band 65535) -shl 16) -bor ($PointX -band 65535)
[CaptionProbe]::SendMessageW([IntPtr]::new($WindowHandle), 132, [IntPtr]::Zero, [IntPtr]::new($packedPoint)).ToInt64()
`);
async function hitTest(win, point) {
  const handle = win.getNativeWindowHandle();
  const hwnd = handle.length === 8 ? handle.readBigUInt64LE().toString() : String(handle.readUInt32LE());
  const bounds = win.getContentBounds();
  const physical = screen.dipToScreenPoint({ x: Math.round(bounds.x + point.x), y: Math.round(bounds.y + point.y) });
  const result = await runFile('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', hitScript,
    '-WindowHandle', hwnd, '-PointX', String(physical.x), '-PointY', String(physical.y),
  ], { windowsHide: true, timeout: 5000 });
  return Number(result.stdout.trim());
}

app.whenReady().then(async () => {
  let dashboard, overlay;
  await until(() => {
    dashboard = findWindow('app.html'); overlay = findWindow('overlay.html');
    return dashboard && overlay && shown.has(dashboard)
      && !dashboard.webContents.isLoading() && !overlay.webContents.isLoading();
  }, 'manual startup with both flags OFF opens the dashboard');
  const run = code => dashboard.webContents.executeJavaScript(code);
  await until(() => run('!!lastPayload'), 'settings snapshot loads');
  assert.strictEqual(dashboard.isVisible(), true);
  assert.strictEqual(dashboard.isMovable(), true);
  assert.strictEqual(overlay.isVisible(), false, 'idle bar starts hidden when always-show is OFF');
  assert.strictEqual(loginCalls.at(-1).openAtLogin, false);

  for (const launchAtLogin of [false, true]) {
    for (const alwaysShowFlowBar of [false, true]) {
      const flags = { launchAtLogin, alwaysShowFlowBar };
      const saved = await run('window.voxden.setSettings(' + JSON.stringify(flags) + ')');
      assert.strictEqual(saved.launchAtLogin, launchAtLogin);
      assert.strictEqual(saved.alwaysShowFlowBar, alwaysShowFlowBar);
      assert.strictEqual(loginCalls.at(-1).openAtLogin, launchAtLogin);
      const disk = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
      assert.strictEqual(disk.launchAtLogin, launchAtLogin);
      assert.strictEqual(disk.alwaysShowFlowBar, alwaysShowFlowBar);
      await until(() => overlay.isVisible() === alwaysShowFlowBar, 'idle native visibility follows always-show');
      await run("openSettingsTarget('system'); true");
      await pause(250);
      const points = await run(`(() => {
        const title = document.querySelector('.titlebar').getBoundingClientRect();
        const close = document.getElementById('settings-close').getBoundingClientRect();
        return { title: { x: innerWidth / 2, y: title.top + title.height / 2 },
          close: { x: close.left + close.width / 2, y: close.top + close.height / 2 } };
      })()`);
      if (process.platform === 'win32') {
        assert.strictEqual(await hitTest(dashboard, points.title), 2, 'native titlebar stays draggable: ' + JSON.stringify(flags));
        assert.strictEqual(await hitTest(dashboard, points.close), 1, 'settings close remains a clickable client control');
      }
      assert.strictEqual(await overlay.webContents.executeJavaScript('hudMode'), 'idle', 'settings never begin capture');
      await run('closeSettings(); true');
      dashboard.hide();
      await overlay.webContents.executeJavaScript('window.voxden.openHistory(); true');
      await until(() => dashboard.isVisible(), 'dashboard can reopen through its real IPC with either flag OFF');
      assert.strictEqual(await run("document.getElementById('settings-overlay').hidden"), true);
      console.log('Native System combination passed: ' + JSON.stringify(flags));
    }
  }
  // Exercise the ON -> OFF transition, including more than one native recovery
  // poll. A bar deliberately hidden by the user must remain hidden.
  await run('window.voxden.setSettings({ launchAtLogin: false, alwaysShowFlowBar: false })');
  await until(() => !overlay.isVisible(), 'switching OFF hides the idle bar');
  await pause(1300);
  assert.strictEqual(overlay.isVisible(), false, 'visibility polling does not resurrect an intentionally hidden bar');
  assert.deepStrictEqual(errors, [], 'real main and renderers stay healthy');
  console.log('System native: OFF/OFF cold startup, all four combinations, caption/control hit tests, settings persistence, hide and reopen passed.');
  clearTimeout(deadline);
  app.quit();
}).catch(error => { console.error(error); clearTimeout(deadline); app.exit(1); });
