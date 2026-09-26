'use strict';
const { app, BrowserWindow, ipcMain, session } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const harness = require('./asr-test-harness');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'voxden-changelog-ui-')));
app.disableHardwareAcceleration();
const timeout = setTimeout(() => app.exit(1), 20000);
app.whenReady().then(async () => {
  const opened = [];
  let fail = false, reads = 0;
  const h = harness({ shell: { openExternal: async url => {
    if (fail) throw new Error('Test browser unavailable');
    opened.push(url);
  } } });
  try {
    const handler = h.handlers.get('changelog-open');
    assert.equal(typeof handler, 'function');
    await handler(null, 'https://example.test/untrusted');
    assert.deepEqual(opened, ['https://voxden.app/changelog'], 'main opens only the fixed changelog destination');
    opened.length = 0;
    ipcMain.handle('changelog-open', handler);
    ipcMain.handle('app-load', () => ({ entries: [], phrases: [], notifications: [], pendingPhrases: [], writingStyles: {} }));
    ipcMain.handle('notifications-read', () => { reads++; return {}; });
    session.defaultSession.setPermissionRequestHandler((_w, _p, cb) => cb(false));
    const win = new BrowserWindow({ show: false, webPreferences: {
      preload: path.join(__dirname, '../src/preload.js'), sandbox: false, contextIsolation: true, offscreen: true,
    } });
    await win.loadFile(path.join(__dirname, '../src/app.html'));
    const run = code => win.webContents.executeJavaScript(code);
    const waitFor = async condition => {
      for (let i=0;i<100;i++) { if (await condition()) return; await new Promise(r=>setTimeout(r,20)); }
      assert.fail('Changelog action did not complete');
    };
    await run(`window.alert = message => { window.changelogError = message; }; true`);
    for (const theme of ['voxden', 'white']) {
      await run(`document.documentElement.dataset.appTheme='${theme}'; openHelpMenu(); document.getElementById('help-whats-new').click(); true`);
      await waitFor(() => opened.length === (theme === 'voxden' ? 1 : 2));
      assert.equal(opened.at(-1), 'https://voxden.app/changelog');
      assert.equal(await run(`document.getElementById('help-menu').hidden && document.getElementById('notif-panel').hidden`), true);
      assert.equal(await run(`document.getElementById('help-whats-new').href`), opened.at(-1), 'web preview has the same direct link');
    }
    assert.equal(reads, 0, 'opening the website does not mark notifications as read');
    fail = true;
    await run(`openHelpMenu(); document.getElementById('help-whats-new').click(); true`);
    await waitFor(() => run(`Boolean(window.changelogError)`));
    assert.match(await run('window.changelogError'), /Could not open your browser/);
    fail = false;
    h.run(`process.env.VOXDEN_LOCAL_PREVIEW = '1'`);
    await handler(null, 'https://example.test/untrusted');
    assert.equal(opened.at(-1), 'http://127.0.0.1:4174/changelog', 'installed local-test build uses the preview');
    h.run(`delete process.env.VOXDEN_LOCAL_PREVIEW`);
    h.run(`require('electron').app.isPackaged = false`);
    await handler(null, 'https://example.test/untrusted');
    assert.equal(opened.at(-1), 'http://127.0.0.1:4174/changelog', 'developer app uses the local website');
    win.destroy();
    console.log('PASS: What’s new reaches the fixed website changelog through the real preload/main handler in both themes; browser failure is reported.');
  } finally { await h.close(); }
  clearTimeout(timeout); app.quit();
}).catch(error => { console.error(error); clearTimeout(timeout); app.exit(1); });
