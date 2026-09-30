'use strict';

// Real dashboard CSS and platform rendering, with a delayed synthetic first
// snapshot. Capture native-control clearance before any animation frame.
const { app, BrowserWindow, ipcMain, session } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const motionFixture = require('./motion-fixture');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'voxden-mac-titlebar-')));
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
const deadline = setTimeout(() => { console.error('Mac titlebar UI timed out'); app.exit(1); }, 30000);
let theme = 'voxden';
let deliverSnapshot;

app.whenReady().then(async () => {
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.setPermissionRequestHandler((_window, _permission, reply) => reply(false));
  ipcMain.on('app-theme-get', event => { event.returnValue = theme; });
  ipcMain.handle('app-load', () => new Promise(resolve => { deliverSnapshot = resolve; }));
  ipcMain.handle('insights-get', () => ({}));
  ipcMain.handle('style-preview', () => ({}));
  for (theme of ['white', 'voxden']) for (const reduced of [false, true]) {
    deliverSnapshot = null;
    const win = new BrowserWindow({ show: false, width: 1120, height: 760,
      webPreferences: { preload: path.join(__dirname, '../src/preload.js'),
        additionalArguments: ['--voxden-theme-bootstrap'], contextIsolation: true,
        sandbox: false, backgroundThrottling: false, offscreen: true } });
    await win.loadFile(path.join(__dirname, '../src/app.html'));
    await motionFixture(win, reduced ? 'reduce' : 'no-preference');
    const run = code => win.webContents.executeJavaScript(code);
    const context = theme + (reduced ? ' reduced motion' : ' full motion');
    // Page loading and dispatch of its preload IPC complete independently.
    for (let attempt = 0; !deliverSnapshot && attempt < 100; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(typeof deliverSnapshot, 'function', context + ': first platform snapshot is held');
    assert.equal(await run("getComputedStyle(document.querySelector('.titlebar')).paddingLeft"),
      '16px', context + ': the ordinary titlebar starts with Windows clearance');
    await run(`(() => {
      const original = applyPlatformCopy;
      window.platformSamples = [];
      applyPlatformCopy = function(platform) {
        original(platform);
        const bar = document.querySelector('.titlebar'), css = getComputedStyle(bar);
        platformSamples.push({ platform: document.documentElement.dataset.platform,
          left: css.paddingLeft, right: css.paddingRight,
          transitions: bar.getAnimations().filter(animation => animation instanceof CSSTransition)
            .map(animation => ({ property: animation.transitionProperty, pending: animation.pending,
              state: animation.playState, time: animation.currentTime })) });
      };
      return true;
    })()`);
    // Delay real frame delivery, without manually advancing or completing an
    // animation. The captured value must already be right within platform setup.
    win.webContents.setFrameRate(2);
    deliverSnapshot({ platform: 'darwin', appTheme: theme, displayName: 'Fixture',
      entries: [], phrases: [], notifications: [], pendingPhrases: [], writingStyles: {},
      shortcutLabel: 'Cmd+Shift+Space', appVersion: 'fixture', updateStatus: 'idle' });
    let samples;
    for (let attempt = 0; attempt < 100; attempt++) {
      samples = await run('platformSamples');
      if (samples.length) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.ok(samples.length, context + ': the real renderer receives its Darwin snapshot');
    const initial = samples[0];
    assert.equal(initial.platform, 'darwin', context + ': platform copy marks the real document');
    assert.equal(initial.left, '84px', context + ': immediate traffic-light clearance: ' + JSON.stringify(initial));
    assert.equal(initial.right, '16px', context + ': no Windows caption space remains on the right');
    assert.deepEqual(initial.transitions, [], context + ': platform geometry never animates');
    console.log('PASS ' + context + ': immediate 84px/16px titlebar padding, no geometry transition');
    win.webContents.debugger.detach();
    win.destroy();
  }
  clearTimeout(deadline);
  app.quit();
}).catch(error => { console.error(error); clearTimeout(deadline); app.exit(1); });
