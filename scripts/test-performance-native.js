'use strict';

// Real application windows and IPC with a private empty profile. Report costs,
// but assert behavior/work counts rather than machine-dependent CPU thresholds.
const { app, BrowserWindow, session, globalShortcut } = require('electron');
const { monitorEventLoopDelay } = require('perf_hooks');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voxden-perf-native-'));
app.setPath('userData', root);
if (process.argv.includes('--software')) app.disableHardwareAcceleration();
Object.defineProperty(app, 'isPackaged', { value: true });
app.getVersion = () => require('../package.json').version;
fs.mkdirSync(path.join(root, 'data'), { recursive: true });
fs.writeFileSync(path.join(root, 'data', 'settings.json'), JSON.stringify({
  launchAtLogin: false, alwaysShowFlowBar: true, soundsEnabled: false, flowBarMotion: 'full',
}));
app.setLoginItemSettings = () => {};
globalShortcut.register = () => true;
globalShortcut.unregister = () => {};
globalShortcut.unregisterAll = () => {};
require('../src/updater').startUpdater = () => {};
const nativeShow = BrowserWindow.prototype.showInactive;
BrowserWindow.prototype.show = function () { nativeShow.call(this); };
BrowserWindow.prototype.focus = function () {};
const errors = [];
app.on('web-contents-created', (_event, contents) => {
  contents.on('render-process-gone', (_event, detail) => errors.push(detail.reason));
  contents.on('console-message', event => {
    if ((event.level === 'error' || Number(event.level) >= 3)
        && !/Content-Security-Policy/.test(event.message)) errors.push(event.message);
  });
});
const started = Date.now();
const lag = monitorEventLoopDelay({ resolution: 10 });
lag.enable();
require('../src/main');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const deadline = setTimeout(() => { console.error('Native performance test timed out'); app.exit(1); }, 45000);
async function until(predicate, message) {
  const end = Date.now() + 10000;
  do { if (await predicate()) return; await pause(40); } while (Date.now() < end);
  assert.fail(message);
}
app.whenReady().then(async () => {
  // main has now installed its normal handler; the fixture denies all media.
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  let dashboard, overlay;
  await until(() => {
    dashboard = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/app.html'));
    overlay = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/overlay.html'));
    return dashboard && overlay && !dashboard.webContents.isLoading() && !overlay.webContents.isLoading();
  }, 'both production windows load');
  const page = code => dashboard.webContents.executeJavaScript(code);
  const bar = code => overlay.webContents.executeJavaScript(code);
  await until(() => page("!!lastPayload && lastPayload.engineStatus === 'unavailable'"), 'empty profile settles without a model');
  const startupMs = Date.now() - started;
  console.log(JSON.stringify({ phase: 'startup', startupMs, mainMaxDelayMs: +(lag.max / 1e6).toFixed(2),
    softwareRequested: process.argv.includes('--software') }));
  await pause(1500);
  await page('window.performanceSnapshots = 0; window.voxden.onHistory(() => window.performanceSnapshots++); true');

  for (const state of ['hidden', 'minimized']) {
    if (state === 'hidden') dashboard.hide();
    else { nativeShow.call(dashboard); dashboard.minimize(); }
    await until(() => state === 'hidden' ? !dashboard.isVisible() : dashboard.isMinimized(), state + ' applies natively');
    await pause(100);
    await page('window.performanceSnapshots = 0; true');
    for (let i = 0; i < 5; i++) {
      await bar('window.voxden.setSettings({ displayName: ' + JSON.stringify(state + '-' + i) + ' })');
    }
    await pause(100);
    assert.strictEqual(await page('window.performanceSnapshots'), 0, state + ' dashboard receives no background history broadcasts');
    if (state === 'hidden') nativeShow.call(dashboard);
    else dashboard.restore();
    await until(() => page('lastPayload.displayName === ' + JSON.stringify(state + '-4')), 'native restore receives latest background settings');
    assert.strictEqual(await page('window.performanceSnapshots'), 1, state + ' changes merge into a single fresh snapshot');
  }

  dashboard.hide();
  for (const style of ['classic', 'ribbon', 'orb']) {
    await bar('window.voxden.setSettings({ flowBarStyle: ' + JSON.stringify(style) + ' })');
    await pause(500);
    lag.reset(); app.getAppMetrics();
    await pause(1800);
    const processes = app.getAppMetrics().map(row => ({
      type: row.type, cpuPercent: +row.cpu.percentCPUUsage.toFixed(2), workingSetMB: +(row.memory.workingSetSize / 1024).toFixed(1),
    }));
    console.log(JSON.stringify({ phase: 'idle', style, mainP99DelayMs: +(lag.percentile(99) / 1e6).toFixed(2),
      mainMaxDelayMs: +(lag.max / 1e6).toFixed(2), processes }));
    assert.strictEqual(await bar('hudMode'), 'idle');
  }
  await bar('window.voxden.setSettings({alwaysShowFlowBar:false})');
  await until(() => !overlay.isVisible(), 'idle overlay can sleep while disabled');
  assert.deepStrictEqual(errors, []);
  console.log('Native performance: hidden/minimized dashboards receive no broadcasts, show/restore catches up once, all idle styles remain healthy.');
  clearTimeout(deadline); lag.disable(); app.quit();
}).catch(error => { console.error(error); clearTimeout(deadline); app.exit(1); });
