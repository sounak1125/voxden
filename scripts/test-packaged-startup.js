'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
// Optional actual build: exercise its asar main/preload/renderers and external
// resources, while retaining the isolated profile and inert OS integrations.
const resourceArg = process.argv.find(value => value.startsWith('--resources='));
const builtResources = resourceArg ? path.resolve(resourceArg.slice('--resources='.length)) : null;
const appRoot = builtResources ? path.join(builtResources, 'app.asar') : path.join(__dirname, '..');
if (builtResources) Object.defineProperty(process, 'resourcesPath', { value: builtResources });
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voxden-startup-'));
app.setPath('userData', root);
// Readiness assertions should not depend on GPU contention from other desktop
// apps or parallel renderer tests. The real main/preload/renderers still run.
app.disableHardwareAcceleration();
Object.defineProperty(app, 'isPackaged', { value: true });
// A script launched through electron otherwise reports Electron's own version,
// so release announcement delivery would never exercise the app's catalog.
app.getVersion = () => require(path.join(appRoot, 'package.json')).version;
// Exercise real startup without changing login entries, registering shortcuts,
// downloading updates, or briefly covering the user's current work.
app.setLoginItemSettings = () => {};
const shown = new Set();
BrowserWindow.prototype.show = function () { shown.add(this); };
BrowserWindow.prototype.showInactive = function () {};
BrowserWindow.prototype.focus = function () {};
const updater = require(path.join(appRoot, 'src/updater'));
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
require(path.join(appRoot, 'src/main'));
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
  const packagedInfo = require(path.join(appRoot, 'package.json'));
  const version = packagedInfo.version;
  assert.strictEqual(state.version, version, 'startup harness uses the Voxden version');
  assert.strictEqual(state.buildId, packagedInfo.buildId, 'startup delivers the actual build identifier');
  const releaseIds = require(path.join(appRoot, 'src/announcements')).CATALOG.filter(row => row.since === version).map(row => row.id).sort();
  assert.ok(releaseIds.length > 0, 'the running release has highlights');
  assert.deepStrictEqual(state.notifications.map(row => row.id).sort(), releaseIds, 'real startup delivers the release highlights');
  assert.strictEqual(state.notificationsUnread, releaseIds.length, 'real startup lights the bell for new highlights');
  assert.strictEqual(state.engineStatus, 'unavailable');
  assert.strictEqual(state.asrRuntime.installed, false);
  assert.strictEqual(state.asrRuntimeWouldHelp, true);
  assert.strictEqual(state.qwenAccel.backend, 'cpu');
  assert.notStrictEqual(state.qwenAccel.uiStatus, 'verified');
  assert.strictEqual(state.qwenCudaPack.installed, false);
  assert.strictEqual(state.qwenRocmPack.installed, false);
  assert.deepStrictEqual(errors, [], 'real startup has no renderer exceptions');
  console.log((builtResources ? 'built app.asar' : 'source packaged-mode') + ' startup opens normally with no installed Python or models; version=' + version + ', build=' + state.buildId + ', highlights=' + releaseIds.length);
  clearTimeout(deadline);
  app.quit();
}).catch(err => { console.error(err); app.exit(1); });
