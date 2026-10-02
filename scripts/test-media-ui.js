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
  // A deliberately pending fake getUserMedia verifies when the microphone is
  // asked for without opening the user's microphone or playing a start cue.
  await evaluate(`window.mediaTestOpens = 0;
    navigator.mediaDevices.getUserMedia = () => { window.mediaTestOpens++; return new Promise(() => {}); }; undefined;`);
  async function state(payload) {
    win.webContents.send('state', { soundsEnabled: false, ...payload });
    // A timer turn, not requestAnimationFrame: this window is never shown, and
    // a hidden window's frames can arrive a second or two apart, which made the
    // test spend its whole budget waiting for paint it does not need.
    await evaluate('new Promise(resolve => setTimeout(resolve, 20))');
  }
  // The microphone is asked for as soon as arming starts, while other audio is
  // still being paused, so the two waits overlap. What it hears until the
  // pause is done is held back (mediaHold), never recorded.
  await state({ mode: 'arming', prepareOnly: true });
  assert.strictEqual(await evaluate('hudMode'), 'arming');
  assert.strictEqual(await evaluate('window.mediaTestOpens'), 1, 'the microphone opens without waiting for the pause');
  assert.strictEqual(await evaluate('mediaHold'), true, 'and what it hears is held back until the pause is done');
  await state({ mode: 'arming' });
  await state({ mode: 'arming', prepareOnly: true });
  assert.strictEqual(await evaluate('window.mediaTestOpens'), 1, 'status refreshes during the pause must not open a second microphone');
  assert.strictEqual(await evaluate('mediaHold'), true, 'a refresh without the pause being done keeps the hold');
  await state({ mode: 'arming', prepareOnly: false });
  assert.strictEqual(await evaluate('mediaHold'), false, 'the pause being done releases the hold');
  assert.strictEqual(await evaluate('window.mediaTestOpens'), 1, 'releasing the hold must not open a second microphone');
  await state({ mode: 'cancel' });
  assert.strictEqual(await evaluate('window.mediaTestOpens'), 1);
  assert.strictEqual(await evaluate('capturing'), false);
  await state({ mode: 'arming', prepareOnly: true });
  assert.strictEqual(await evaluate('window.mediaTestOpens'), 2, 'the next dictation opens its own microphone at once');
  await state({ mode: 'arming', prepareOnly: false });
  await state({ mode: 'arming', prepareOnly: false });
  assert.strictEqual(await evaluate('window.mediaTestOpens'), 2, 'state refreshes must not open a second microphone');
  await state({ mode: 'cancel' });
  assert.strictEqual(await evaluate('capturing'), false);
  // Push-to-talk has nothing to pause first: no hold at all.
  await state({ mode: 'arming', prepareOnly: false });
  assert.strictEqual(await evaluate('window.mediaTestOpens'), 3);
  assert.strictEqual(await evaluate('mediaHold'), false, 'a press with no pause to wait for holds nothing back');
  await state({ mode: 'cancel' });
  await evaluate('capturing = true; finishCapture(false)');
  assert.strictEqual(captureEnded, 1, 'microphone teardown is reported through the real preload');
  assert.deepStrictEqual(errors, []);
  console.log('real overlay opens the microphone at once, holds audio until media is paused, and handles cancellation (microphone mocked)');
  clearTimeout(deadline);
  win.destroy();
  app.quit();
}).catch(err => { console.error(err); app.exit(1); });
