'use strict';

const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'voxden-media-ui-')));
app.disableHardwareAcceleration();
const deadline = setTimeout(() => { console.error('Media UI test timed out'); app.exit(1); }, 15000);

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false,
    webPreferences: { preload: path.join(__dirname, '../src/preload.js'), contextIsolation: true, sandbox: false,
      backgroundThrottling: false } });
  const errors = [];
  let captureEnded = 0;
  ipcMain.on('capture-ended', event => {
    if (event.sender === win.webContents) captureEnded += 1;
  });
  win.webContents.on('console-message', (_event, level, message) => {
    if (level >= 3 && !/Content-Security-Policy/.test(message)) errors.push(message);
  });
  await win.loadFile(path.join(__dirname, '../src/overlay.html'));
  const evaluate = code => win.webContents.executeJavaScript(code);
  // A deliberately pending fake getUserMedia verifies microphone gating
  // without opening the user's microphone or playing a start cue.
  await evaluate(`window.mediaTestOpens = 0;
    navigator.mediaDevices.getUserMedia = () => { window.mediaTestOpens++; return new Promise(() => {}); }; undefined;`);
  async function state(payload) {
    win.webContents.send('state', { soundsEnabled: false, ...payload });
    await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  }
  await state({ mode: 'arming', prepareOnly: true });
  assert.strictEqual(await evaluate('hudMode'), 'arming');
  assert.strictEqual(await evaluate('window.mediaTestOpens'), 0);
  await state({ mode: 'arming' });
  assert.strictEqual(await evaluate('window.mediaTestOpens'), 0, 'unrelated arming updates must not bypass media preparation');
  await state({ mode: 'cancel' });
  assert.strictEqual(await evaluate('window.mediaTestOpens'), 0);
  await state({ mode: 'arming', prepareOnly: true });
  await state({ mode: 'arming', prepareOnly: false });
  assert.strictEqual(await evaluate('window.mediaTestOpens'), 1);
  await state({ mode: 'arming', prepareOnly: false });
  assert.strictEqual(await evaluate('window.mediaTestOpens'), 1, 'state refreshes must not open a second microphone');
  await state({ mode: 'cancel' });
  assert.strictEqual(await evaluate('capturing'), false);
  await evaluate('capturing = true; finishCapture(false)');
  assert.strictEqual(captureEnded, 1, 'microphone teardown is reported through the real preload');
  assert.deepStrictEqual(errors, []);
  console.log('real overlay waits for media preparation and handles cancellation (microphone mocked)');
  clearTimeout(deadline);
  win.destroy();
  app.quit();
}).catch(err => { console.error(err); app.exit(1); });
