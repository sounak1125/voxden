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
const existingProfile = process.argv.includes('--existing-profile');
let existingHistory = null;
let existingDictionary = null;
if (existingProfile) {
  const data = path.join(root, 'data');
  fs.mkdirSync(data, { recursive: true });
  existingHistory = Array.from({ length: 1005 }, (_, i) => ({
    id: 'startup-fixture-' + i, ts: Date.now() - i * 60000,
    text: 'Keep every lifetime dictation total.', original: 'Keep every lifetime dictation total.',
    durationMs: 3000, exe: 'notepad.exe', category: 'work',
  }));
  existingDictionary = JSON.stringify({
    phrases: [{ from: 'vox den', to: 'Voxden', kind: 'word', source: 'learned' }],
    variants: [], pending: [],
  });
  fs.writeFileSync(path.join(data, 'history.json'), JSON.stringify({ entries: existingHistory }));
  fs.writeFileSync(path.join(data, 'dictionary.json'), existingDictionary);
  fs.writeFileSync(path.join(data, 'notifications.json'), JSON.stringify({
    seenVersion: require(path.join(appRoot, 'package.json')).version,
    items: { 'flow-input-2-1-2': { ts: Date.now() - 1000, read: true, cleared: true } },
  }));
}
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
  const releaseIds = require(path.join(appRoot, 'src/announcements')).CATALOG
    .filter(row => row.since === version && (!existingProfile || row.id !== 'flow-input-2-1-2'))
    .map(row => row.id).sort();
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
  if (existingProfile) {
    assert.strictEqual(state.entries.length, 1000, 'existing history is capped on real startup');
    assert.strictEqual(state.usageStats.dictations, existingHistory.length, 'lifetime total survives real migration');
    assert.strictEqual(state.wordCount, 5025, 'word total survives real migration');
    assert.ok(state.notifications.some(row => row.id === 'history-retention-2-1-2'), 'same-version rebuild delivers the new notice');
    assert.strictEqual(fs.readFileSync(path.join(root, 'data/dictionary.json'), 'utf8'), existingDictionary, 'learned dictionary is untouched');
    const saved = JSON.parse(fs.readFileSync(path.join(root, 'data/history.json'), 'utf8'));
    assert.strictEqual(saved.entries.length, 1000);
    assert.strictEqual(saved.archived.length, 5);
    assert.deepStrictEqual(saved, JSON.parse(fs.readFileSync(path.join(root, 'data/history.json.bak'), 'utf8')));
    const reply = await window.webContents.executeJavaScript("window.voxden.historyInsights({range:'all'})");
    const expected = require(path.join(appRoot, 'src/insights')).computeInsights(existingHistory, state.phrases, 'all', reply.computedAt);
    assert.deepStrictEqual(reply.result, expected, 'actual startup IPC preserves every Insight');
  }
  assert.deepStrictEqual(errors, [], 'real startup has no renderer exceptions');
  console.log((builtResources ? 'built app.asar' : 'source packaged-mode') + ' startup opens normally with no installed Python or models; version=' + version + ', highlights=' + releaseIds.length + ', existingProfile=' + existingProfile);
  clearTimeout(deadline);
  app.quit();
}).catch(err => { console.error(err); app.exit(1); });
