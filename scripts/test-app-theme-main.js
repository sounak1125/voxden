'use strict';
const assert = require('assert');
const fs = require('fs');
const harness = require('./asr-test-harness');
const theme = require('../src/app-theme');

(async () => {
  const h = harness();
  const chrome = [], messages = [];
  try {
    for (const value of [undefined, null, '', 'light', 'WHITE', {}, 7]) assert.strictEqual(theme.normalize(value), 'voxden');
    assert.strictEqual(h.run('settings.appTheme'), 'voxden');
    h.context.themeBackground = value => chrome.push(['background', value]);
    h.context.themeCaption = value => chrome.push(['caption', value]);
    h.context.themeMessage = (channel, value) => messages.push([channel, value]);
    h.run(`historyWin = { isDestroyed: () => false, setBackgroundColor: themeBackground,
      setTitleBarOverlay: themeCaption, webContents: { send: themeMessage } };
      mode = 'recording'; recordingSessionToken = 42;
      sendOverlay = () => { throw new Error('Theme must not touch the recording overlay'); };
      broadcastHistory = () => { throw new Error('Theme must not rerender history'); };
      applySystemSettings = () => { throw new Error('Theme must not change system controls'); };`);
    const set = h.handlers.get('settings-set');
    for (const value of ['white', 'voxden', 'white']) {
      assert.strictEqual((await set(null, { appTheme: value })).appTheme, value);
      const disk = JSON.parse(fs.readFileSync(h.run('SETTINGS_FILE'), 'utf8'));
      assert.strictEqual(disk.appTheme, value);
      h.run('loadSettings()');
      assert.strictEqual(h.run('settings.appTheme'), value, 'survives restart');
      const event = {};
      h.ipcEvents.get('app-theme-get')(event);
      assert.strictEqual(event.returnValue, value, 'read-only preload reads saved preference');
      assert.strictEqual(chrome.at(-2)[1], theme.chrome(value).background);
      assert.strictEqual(chrome.at(-1)[1].symbolColor, theme.chrome(value).symbols);
      assert.deepStrictEqual(messages.at(-1), ['app-theme-changed', value]);
      assert.strictEqual(h.run('mode'), 'recording');
      assert.strictEqual(h.run('recordingSessionToken'), 42);
    }
    h.run('themeRealSave = saveSettings; saveSettings = () => { throw new Error("disk unavailable"); };');
    const count = messages.length;
    await assert.rejects(set(null, { appTheme: 'voxden' }), /disk unavailable/);
    assert.strictEqual(h.run('settings.appTheme'), 'white');
    assert.strictEqual(messages.length, count, 'failed save sends no theme change');
    assert.strictEqual(JSON.parse(fs.readFileSync(h.run('SETTINGS_FILE'), 'utf8')).appTheme, 'white');
    h.run('saveSettings = themeRealSave;');
    await set(null, { appTheme: 'unknown' });
    assert.strictEqual(h.run('settings.appTheme'), 'voxden');
    const file = h.run('SETTINGS_FILE');
    fs.writeFileSync(file, JSON.stringify({ appTheme: 'corrupt' }));
    h.run('loadSettings()');
    assert.strictEqual(h.run('settings.appTheme'), 'voxden', 'invalid disk value uses the default');
    console.log('App theme main: persistence, startup IPC, invalid values, failed writes, native chrome and uninterrupted recording passed.');
  } finally { await h.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
