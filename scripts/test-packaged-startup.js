'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voxden-startup-'));
app.setPath('userData', root);
// Readiness assertions should not depend on GPU contention from other desktop
// apps or parallel renderer tests. The real main/preload/renderers still run.
app.disableHardwareAcceleration();
Object.defineProperty(app, 'isPackaged', { value: true });
// Exercise real startup without changing login entries, registering shortcuts,
// downloading updates, or briefly covering the user's current work.
app.setLoginItemSettings = () => {};
const shown = new Set();
BrowserWindow.prototype.show = function () { shown.add(this); };
BrowserWindow.prototype.showInactive = function () {};
BrowserWindow.prototype.focus = function () {};
const updater = require('../src/updater');
updater.startUpdater = () => {};
const hotkeys = require('electron').globalShortcut;
hotkeys.register = () => true;
hotkeys.unregister = () => {};
hotkeys.unregisterAll = () => {};
const errors = [];
app.on('web-contents-created', (_event, contents) => {
  contents.on('console-message', (_e, level, message) => {
    if (level >= 3 && !/Content-Security-Policy/.test(message)) errors.push(message);
  });
});
require('../src/main');
const deadline = setTimeout(() => { console.error('Startup test timed out'); app.exit(1); }, 20000);
app.whenReady().then(async () => {
  // Poll only inside this bounded test until the two real renderers finish.
  let window;
  for (let i = 0; i < 100; i++) {
    window = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/app.html'));
    if (window && !window.webContents.isLoading() && shown.has(window)) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!window || !shown.has(window)) console.log('Startup windows:', BrowserWindow.getAllWindows().map(w => ({
    url: w.webContents.getURL(), loading: w.webContents.isLoading(), shown: shown.has(w), visible: w.isVisible(),
  })));
  assert(window && shown.has(window), 'manual startup opens the dashboard');
  const state = await window.webContents.executeJavaScript('window.voxden.loadApp()');
  assert.strictEqual(state.engineStatus, 'unavailable');
  assert.strictEqual(state.asrRuntime.installed, false);
  assert.strictEqual(state.asrRuntimeWouldHelp, true);
  assert.strictEqual(state.qwenAccel.backend, 'cpu');
  assert.notStrictEqual(state.qwenAccel.uiStatus, 'verified');
  assert.strictEqual(state.qwenCudaPack.installed, false);
  assert.strictEqual(state.qwenRocmPack.installed, false);
  assert.deepStrictEqual(errors, [], 'real startup has no renderer exceptions');
  console.log('packaged startup opens normally with no Python and no models');
  clearTimeout(deadline);
  app.quit();
}).catch(err => { console.error(err); app.exit(1); });
