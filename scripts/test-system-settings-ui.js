'use strict';

// Exercise the actual System settings DOM using an isolated Electron profile.
// Main-process settings are deliberately mocked: this must never change the
// tester's Windows startup entry, access a microphone, or start dictation.
const { app, BrowserWindow, ipcMain, session } = require('electron');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'voxden-system-ui-')));
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const deadline = setTimeout(() => { console.error('System settings UI timed out'); app.exit(1); }, 45000);
const errors = [];
const saves = [];
let rejectSave = false;
let notificationReads = 0;
let snapshot = {
  displayName: 'Alex', shortcutLabel: 'Ctrl+Shift+Space', entries: [], phrases: [],
  notifications: [], pendingPhrases: [], writingStyles: {}, autoSend: {},
  launchAtLogin: false, alwaysShowFlowBar: false, showInTaskbar: false,
  flowBarStyle: 'island', flowBarMotion: 'full', soundsEnabled: false,
  updateStatus: 'idle', appVersion: '2.1.1', flowBarMoved: true,
};

app.whenReady().then(async () => {
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  ipcMain.handle('app-load', () => snapshot);
  ipcMain.handle('settings-set', (_event, patch) => {
    saves.push(patch);
    if (rejectSave) { rejectSave = false; throw new Error('Expected System preference test failure'); }
    snapshot = { ...snapshot, ...patch };
    return snapshot;
  });
  ipcMain.handle('flow-bar-reset', () => { snapshot = { ...snapshot, flowBarMoved: false }; return snapshot; });
  ipcMain.handle('update-check', () => ({ state: 'idle' }));
  ipcMain.handle('notifications-read', () => { notificationReads++; return snapshot; });
  ipcMain.handle('toggle', () => { assert.fail('System controls must never start dictation'); });

  const win = new BrowserWindow({
    show: false, width: 1120, height: 760, useContentSize: true,
    titleBarStyle: 'hidden', titleBarOverlay: { color: '#101113', symbolColor: '#a3ada6', height: 48 },
    webPreferences: {
      preload: path.join(__dirname, '../src/preload.js'), contextIsolation: true,
      sandbox: false, backgroundThrottling: false, offscreen: true,
    },
  });
  win.webContents.on('render-process-gone', (_event, details) => errors.push('Renderer exited: ' + details.reason));
  win.webContents.on('console-message', event => {
    if ((event.level === 'error' || Number(event.level) >= 3)
        && !/Content-Security-Policy|Expected System preference test failure/.test(event.message)) errors.push(event.message);
  });
  await win.loadFile(path.join(__dirname, '../src/app.html'));
  const run = code => win.webContents.executeJavaScript(code);
  await run(`window.systemMicRequests = 0;
    navigator.mediaDevices.getUserMedia = async () => { systemMicRequests++; throw new Error('No test microphone'); };
    navigator.mediaDevices.enumerateDevices = async () => []; true`);
  const waitFor = async (expression, message) => {
    const until = Date.now() + 2500;
    do { if (await run(expression)) return; await pause(25); } while (Date.now() < until);
    assert.fail(message + ': ' + expression);
  };
  const click = async selector => {
    const point = await run(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`);
    win.webContents.sendInputEvent({ type: 'mouseMove', ...point });
    win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
    win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
    await pause(40);
  };
  const openSystem = async () => {
    await run(`openSettingsTarget('system'); true`);
    await pause(220);
    assert.strictEqual(await run(`document.querySelector('.settings-panel[data-cat="system"]').hidden`), false);
    assert.strictEqual(await run(`document.getElementById('notif-btn').disabled`), true, 'the notification bell is disabled behind Settings');
    await click('#notif-btn');
    assert.strictEqual(await run(`document.getElementById('notif-panel').hidden`), true, 'clicking the disabled bell never opens a hidden panel');
    assert.strictEqual(notificationReads, 0, 'Settings must not mark unseen notifications as read');
  };
  const checkFlag = async (key, id, value) => {
    await click('.settings-cat[data-cat="' + (key === 'alwaysShowFlowBar' ? 'display' : 'system') + '"]');
    if (key === 'alwaysShowFlowBar') await openDisplayOptions();
    if (snapshot[key] !== value) {
      await click(`#${id} + .toggle-track`);
      await waitFor(`document.getElementById('${id}').checked === ${value}`, key + ' control should match saved value');
    }
    assert.strictEqual(snapshot[key], value, key + ' saves via IPC');
  };
  const openDisplayOptions = async () => {
    await click('.settings-cat[data-cat="display"]');
    if (!(await run(`document.getElementById('display-more-options').open`))) await click('#display-more-options > summary');
    assert.strictEqual(await run(`document.getElementById('display-more-options').open`), true);
  };
  const dragResults = [];
  await waitFor(`lastPayload && lastPayload.displayName === 'Alex'`, 'initial settings load');
  // The page has one delayed startup device-list refresh; allow that isolated,
  // rejected probe to finish before attributing requests to System controls.
  await pause(1400);
  await run('systemMicRequests = 0; true');
  assert.strictEqual(await run(`document.getElementById('display-more-options').open`), false, 'optional display controls start collapsed');
  for (const id of ['flow-style-options', 'set-always-flow', 'flow-motion-select', 'flow-bar-reset']) {
    assert.strictEqual(await run(`document.getElementById('${id}').closest('.settings-panel').dataset.cat`), 'display', id + ' lives in Display');
  }
  assert.deepStrictEqual(await run(`Array.from(document.querySelectorAll('[data-cat="system"].settings-panel .setting-label'), el => el.textContent)`),
    ['Launch at login', 'Show app in taskbar', 'App version'], 'System contains only startup, window and updates');
  assert.strictEqual(await run(`document.querySelectorAll('.app-theme-card[role="radio"]').length`), 2, 'Display offers Voxden and White themes');
  for (const launchAtLogin of [false, true]) {
    for (const alwaysShowFlowBar of [false, true]) {
      await openSystem();
      await checkFlag('launchAtLogin', 'set-launch-login', launchAtLogin);
      await checkFlag('alwaysShowFlowBar', 'set-always-flow', alwaysShowFlowBar);

      for (const style of ['orb', 'island']) {
        await click(`.flow-style-card[data-flow-style="${style}"]`);
        await waitFor(`document.querySelector('.flow-style-card[data-flow-style="${style}"]').getAttribute('aria-checked') === 'true'`, 'style stays selectable');
        assert.strictEqual(snapshot.flowBarStyle, style);
      }
      // The last click leaves the pointer on the Island card, so its hover
      // state is part of this: the artwork must neither animate nor move.
      const islandPreview = () => run(`(() => {
        const cap = document.querySelector('.flow-preview-island-cap'), box = cap.getBoundingClientRect();
        return { transform: getComputedStyle(cap).transform, width: box.width, height: box.height,
          animations: document.getAnimations().filter(a => a.effect && a.effect.target && a.effect.target.closest('.flow-preview-island')).length };
      })()`);
      const before = await islandPreview();
      await pause(130);
      const flags = JSON.stringify({ launchAtLogin, alwaysShowFlowBar });
      assert.strictEqual(before.animations, 0, 'Island preview runs no animation or transition with flags ' + flags);
      assert.deepStrictEqual(await islandPreview(), before, 'Island preview stays still with flags ' + flags);

      await click('.settings-cat[data-cat="sound"]');
      assert.strictEqual(await run(`document.querySelector('.settings-panel[data-cat="sound"]').hidden`), false);
      await click('.settings-cat[data-cat="system"]');
      dragResults.push(await run(`(() => {
        const bar = document.querySelector('.titlebar'); const rect = bar.getBoundingClientRect();
        const top = document.elementFromPoint(Math.round(innerWidth / 2), Math.round(rect.top + rect.height / 2));
        return { launchAtLogin: ${launchAtLogin}, alwaysShowFlowBar: ${alwaysShowFlowBar},
          target: top && (top.id || top.className), isTitlebar: !!(top && top.closest('.titlebar')),
          region: getComputedStyle(bar).getPropertyValue('-webkit-app-region') };
      })()`));
      await click('#settings-close');
      assert.strictEqual(await run(`document.getElementById('settings-overlay').hidden`), true, 'close always responds');
      assert.strictEqual(await run(`document.getElementById('notif-btn').disabled`), false, 'closing Settings re-enables the bell');
      await click('#nav-dictionary');
      assert.strictEqual(await run(`document.getElementById('view-dictionary').hidden`), false, 'navigation remains responsive');
    }
  }

  await openSystem();
  for (const [key, id] of [['launchAtLogin', 'set-launch-login'], ['alwaysShowFlowBar', 'set-always-flow'], ['showInTaskbar', 'set-taskbar']]) {
    if (key === 'alwaysShowFlowBar') await openDisplayOptions();
    else await click('.settings-cat[data-cat="system"]');
    const before = snapshot[key];
    rejectSave = true;
    await click(`#${id} + .toggle-track`);
    await waitFor(`document.getElementById('${id}').checked === ${before}`, 'rejected save restores ' + key);
    assert.strictEqual(snapshot[key], before);
    await click(`#${id} + .toggle-track`);
    assert.strictEqual(snapshot[key], !before, key + ' can be changed after a failure');
  }
  await openDisplayOptions();
  await click('#flow-bar-reset');
  assert.strictEqual(snapshot.flowBarMoved, false);
  assert.strictEqual(await run(`document.getElementById('flow-bar-position-row').hidden`), true);
  await click('.settings-cat[data-cat="system"]');
  await click('#update-check-btn');
  assert.strictEqual(await run(`document.getElementById('update-check-btn').disabled`), false, 'update check releases its button');
  // Its reply is the updater's status alone; rendering that as a snapshot put
  // every setting on screen back to its default. Show in taskbar is on by now,
  // from the failure loop above, so a switched-off toggle gives that away.
  assert.strictEqual(await run(`document.getElementById('general-shortcut-keys').textContent`), 'Ctrl+Shift+Space',
    'an update check keeps the shortcut on screen');
  assert.ok(snapshot.showInTaskbar, 'a toggle is on before the update check');
  assert.deepStrictEqual(await run(`['set-launch-login', 'set-always-flow', 'set-taskbar'].map(id => document.getElementById(id).checked)`),
    [snapshot.launchAtLogin, snapshot.alwaysShowFlowBar, snapshot.showInTaskbar], 'an update check keeps the toggles on screen');

  for (const category of ['system', 'display']) {
  await click('.settings-cat[data-cat="' + category + '"]');
  for (const [width, height, zoom] of [[1120, 760, 1], [800, 650, 1], [640, 440, 1], [640, 440, 1.25]]) {
    win.setContentSize(width, height);
    win.webContents.setZoomFactor(zoom);
    await pause(220);
    const bounds = await run(`(() => {
      const r = document.querySelector('.settings-dialog').getBoundingClientRect();
      const close = document.getElementById('settings-close').getBoundingClientRect();
      const title = document.querySelector('.titlebar').getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: innerWidth, height: innerHeight,
        titleBottom: title.bottom, closeReachable: document.elementFromPoint(close.x + close.width / 2, close.y + close.height / 2).id === 'settings-close' };
    })()`);
    assert.ok(bounds.left >= 0 && bounds.right <= bounds.width && bounds.top >= bounds.titleBottom && bounds.bottom <= bounds.height,
      'settings fits below the titlebar at ' + width + 'x' + height + ' zoom ' + zoom + ': ' + JSON.stringify(bounds));
    assert.ok(bounds.closeReachable, 'close remains reachable at ' + width + 'x' + height + ' zoom ' + zoom);
    if (process.argv.includes('--screenshots')) {
      await run(`document.querySelector('.settings-detail').scrollTop = 0; true`);
      await pause(100);
      const folder = path.join(__dirname, '../temp/system-settings-review');
      fs.mkdirSync(folder, { recursive: true });
      fs.writeFileSync(path.join(folder, category + '-' + width + '-' + height + '-' + zoom + '.png'), (await win.webContents.capturePage()).toPNG());
    }
    assert.ok(await run(`(() => { const el = document.querySelector('.settings-detail');
      el.scrollTop = el.scrollHeight; return el.scrollWidth <= el.clientWidth && (el.scrollHeight <= el.clientHeight || el.scrollTop > 0); })()`), category + ' fits horizontally and longer content stays scrollable');
  }
  }
  assert.strictEqual(await run('systemMicRequests'), 0, 'no System control accesses the microphone');
  assert.deepStrictEqual(errors, [], 'renderer remains error-free');
  console.log('System settings: all four launch/flow combinations, clickable controls, still Island preview, navigation, save failures and compact layouts passed.');
  console.log('Settings titlebar hit tests: ' + JSON.stringify(dragResults));
  assert.ok(dragResults.every(result => result.isTitlebar && result.region === 'drag'),
    'opening Settings must keep the actual titlebar available for native window dragging');
  clearTimeout(deadline);
  win.destroy();
  app.quit();
}).catch(error => { console.error(error); clearTimeout(deadline); app.exit(1); });
