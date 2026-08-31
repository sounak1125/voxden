'use strict';

// Exercise the real HTML, preload bridge, and renderer. Re-rendering setup must
// never attach another listener or leave the banner's Cancel button disabled.
const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voxden-ui-'));
app.setPath('userData', root);
app.disableHardwareAcceleration();
let win;
let installs = 0;
let removes = 0;
let cancels = 0;
let finishInstall;
let payload = {
  version: 'test', entries: [], phrases: [], asrEngine: 'qwen3-asr', engineStatus: 'unavailable',
  asrRuntimeWouldHelp: true, asrRuntime: { installed: false, bundled: true, downloadBytes: 0 },
  asrModel: { installed: false, downloadBytes: 3.1e9 },
  speechModels: { installed: false, downloadBytes: 7.88e9, packs: [] },
  asrRuntimeState: { status: 'idle' }, languagePacks: {}, writingStyles: {},
};
const errors = [];
ipcMain.handle('app-load', () => payload);
ipcMain.handle('settings-set', (_event, patch) => { payload = { ...payload, ...patch }; return payload; });
ipcMain.handle('asr-runtime-install', () => {
  installs++;
  payload = { ...payload, asrOperation: 'install', asrRuntimeState: { status: 'downloading', progress: 5 } };
  win.webContents.send('history-updated', payload);
  return new Promise(resolve => { finishInstall = resolve; });
});
ipcMain.handle('asr-runtime-cancel', () => {
  cancels++;
  payload = { ...payload, asrOperation: null, asrRuntimeState: { status: 'cancelled', message: 'Cancelled.' } };
  finishInstall(payload);
  return payload;
});
ipcMain.handle('asr-runtime-remove', () => { removes++; return payload; });

app.whenReady().then(async () => {
  win = new BrowserWindow({ width: 1120, height: 800, show: false,
    webPreferences: { preload: path.join(__dirname, '../src/preload.js'), contextIsolation: true, sandbox: false } });
  win.webContents.on('console-message', (_event, level, message) => {
    if (level >= 3 && !/Content-Security-Policy/.test(message)) errors.push(message);
  });
  await win.loadFile(path.join(__dirname, '../src/app.html'));
  const evaluate = code => win.webContents.executeJavaScript(code);
  await evaluate(`window.confirm = () => true; openSettings();
    for (let i = 0; i < 200; i++) renderSmartRewrite(lastPayload);
    speechSetupInstallBtn.click();`);
  // A round-trip ensures queued IPC and its following render have completed.
  await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  assert.strictEqual(installs, 1, '200 renders must still send only one install');
  const busy = await evaluate(`({ cancelVisible: !speechSetupCancelBtn.hidden,
    bannerEnabled: !engineBannerBtnEl.disabled, action: engineBannerBtnEl.dataset.action,
    engines: Array.from(settingInputs.asrEngine.options, o => o.value) })`);
  assert(busy.cancelVisible && busy.bannerEnabled);
  assert.strictEqual(busy.action, 'cancel');
  assert.deepStrictEqual(busy.engines, ['whisper', 'qwen3-asr', 'parakeet']);
  await evaluate('engineBannerBtnEl.click()');
  await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  assert.strictEqual(cancels, 1);
  assert.strictEqual(await evaluate('getComputedStyle(speechSetupCancelBtn).display'), 'none', 'hidden cancel controls must actually disappear');
  await evaluate(`for (let i = 0; i < 200; i++) renderSmartRewrite(lastPayload);
    speechSetupRemoveBtn.hidden = false; speechSetupRemoveBtn.click();`);
  await evaluate('new Promise(resolve => requestAnimationFrame(resolve))');
  assert.strictEqual(removes, 1, '200 renders must still send only one removal');
  const selection = await evaluate('settingInputs.asrEngine.value');
  assert.strictEqual(selection, 'qwen3-asr');
  assert.deepStrictEqual(errors, [], 'no renderer/preload errors');
  fs.mkdirSync(path.join(__dirname, '../temp'), { recursive: true });
  await evaluate('speechSetupInstallBtn.scrollIntoView({block: "center"})');
  fs.writeFileSync(path.join(__dirname, '../temp/speech-setup-ui.png'), (await win.webContents.capturePage()).toPNG());
  console.log('all speech setup renderer tests passed');
  win.destroy();
  app.quit();
}).catch(err => { console.error(err); app.exit(1); });
