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
  // Setup fetches the engine that was chosen, so the renderer is given a plan
  // rather than the sum of every model that exists. Built here through the real
  // module so the test cannot drift from what main.js actually sends.
  modelPlan: require('../src/model-plan').plan({
    engine: 'qwen3-asr', device: 'auto', language: 'en',
    sizes: { whisper: 3.1e9, 'qwen3-asr': 4.7e9, parakeet: 0.66e9, 'parakeet-fp32': 2.51e9 },
    installed: {},
  }),
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
let extraInstalls = [];
ipcMain.handle('speech-model-install', (_event, id) => { extraInstalls.push(id); return payload; });
ipcMain.handle('qwen-accel-install', () => payload);
ipcMain.handle('qwen-accel-cancel', () => payload);
ipcMain.handle('qwen-accel-remove', () => payload);
ipcMain.handle('qwen-accel-retry', () => payload);

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

  // Back to the resting offer: the cancel above left the banner reporting the
  // cancellation, which is a different message with a different job.
  payload = { ...payload, asrOperation: null, asrRuntimeState: { status: 'idle' } };
  win.webContents.send('history-updated', payload);
  await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');

  // The download the user is quoted is the one they will actually make. The
  // banner used to add up every model that existed and say "up to 11.0 GB".
  const quoted = await evaluate('engineBannerTextEl.textContent');
  assert(/4\.7 GB/.test(quoted), 'the banner quotes the chosen engine: ' + quoted);
  assert(/Qwen3-ASR/.test(quoted), 'and names it: ' + quoted);
  assert(!/11(\.0)? GB/.test(quoted), 'and never the all-in figure: ' + quoted);

  // Everything else is offered separately, priced separately.
  const extras = await evaluate(`({
    hidden: speechExtrasEl.hidden,
    rows: Array.from(speechExtrasEl.querySelectorAll('.speech-extra'), (row) => ({
      name: row.querySelector('.speech-extra-name').textContent,
      button: row.querySelector('button') ? row.querySelector('button').textContent : null,
    })),
  })`);
  assert(!extras.hidden, 'optional models are listed');
  assert.deepStrictEqual(extras.rows.map(r => r.name).sort(),
    ['Parakeet TDT 0.6B', 'Whisper large-v3'], 'exactly the optional engines: '
    + JSON.stringify(extras.rows));
  assert(extras.rows.some(r => /0\.7 GB|660|0\.66/.test(r.button || '')),
    'the fast English path shows its own size: ' + JSON.stringify(extras.rows));
  // The float32 Parakeet is not offered on a machine that cannot load it.
  assert(!extras.rows.some(r => /GPU/.test(r.name)), 'no GPU-only pack on auto');

  await evaluate("speechExtrasEl.querySelector('button').click()");
  await evaluate('new Promise(resolve => requestAnimationFrame(resolve))');
  assert.strictEqual(extraInstalls.length, 1, 'one click, one download: ' + JSON.stringify(extraInstalls));

  assert.deepStrictEqual(errors, [], 'no renderer/preload errors');

  const timingText = await evaluate(`buildCard({
    id: 'timing-test', ts: Date.now(), text: 'timed dictation',
    recognitionMs: 1476, modelRecognitionMs: 1200, rewriteMs: 2101,
    pasteMs: 150, stopToPasteMs: 3950,
  }).querySelector('.card-timing').textContent`);
  assert.strictEqual(
    timingText,
    'Recognize 1.48 s · Rewrite 2.10 s · Paste 150 ms · Total 3.95 s',
    'history exposes the complete user-visible timing breakdown'
  );

  // Qwen acceleration must never look verified from the processor dropdown.
  payload = {
    ...payload,
    asrEngine: 'qwen3-asr',
    engineStatus: 'ready',
    asrRuntimeWouldHelp: false,
    asrEngineActive: 'qwen3-asr',
    device: 'cuda',
    qwenAccel: {
      vendor: 'nvidia',
      gpuName: 'NVIDIA GeForce RTX 4070',
      uiStatus: 'installed',
      backend: 'cpu',
      verified: false,
      uiLabel: 'CPU Qwen',
      recommendedPack: 'cuda',
      supported: true,
      reason: 'Qwen CUDA acceleration is installed and will be used only after the sidecar verifies GPU execution.',
    },
    qwenCudaPack: { installed: true, downloadSize: '2.8 GB' },
    qwenCudaPackState: { status: 'idle' },
  };
  win.webContents.send('history-updated', payload);
  await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const installedCard = await evaluate(`({
    hidden: qwenAccelCardEl.hidden,
    hint: qwenAccelHintEl.textContent,
    engineHint: asrEngineHintEl.textContent,
  })`);
  assert.strictEqual(installedCard.hidden, false, 'Qwen card is visible for NVIDIA');
  assert.ok(/CPU Qwen/.test(installedCard.hint) || /not verified/i.test(installedCard.hint),
    'unverified pack stays on CPU Qwen: ' + installedCard.hint);
  assert.ok(!/Qwen CUDA acceleration is active/.test(installedCard.hint),
    'must not claim CUDA is active before sidecar verification: ' + installedCard.hint);
  assert.ok(/CPU/.test(installedCard.engineHint),
    'engine hint stays on CPU until verified: ' + installedCard.engineHint);
  assert.ok(!/NVIDIA GPU/.test(installedCard.engineHint),
    'engine hint must not use the NVIDIA GPU label for unverified Qwen: ' + installedCard.engineHint);

  payload = {
    ...payload,
    qwenAccel: {
      vendor: 'nvidia',
      gpuName: 'NVIDIA GeForce RTX 4070',
      uiStatus: 'verified',
      backend: 'cuda',
      verified: true,
      uiLabel: 'Qwen CUDA acceleration',
      computeType: 'float16',
      recommendedPack: 'cuda',
      supported: true,
    },
    device: 'cuda',
  };
  win.webContents.send('history-updated', payload);
  await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const verifiedCard = await evaluate('qwenAccelHintEl.textContent');
  assert.ok(/Qwen CUDA acceleration/.test(verifiedCard), 'verified hint names Qwen CUDA acceleration: ' + verifiedCard);
  assert.ok(/sidecar verification/.test(verifiedCard), 'verified hint mentions sidecar verification: ' + verifiedCard);

  payload = {
    ...payload,
    qwenAccel: {
      vendor: 'amd',
      gpuName: 'AMD Radeon RX 7800 XT',
      uiStatus: 'unsupported',
      backend: 'cpu',
      verified: false,
      uiLabel: 'CPU Qwen',
      reason: 'AMD Radeon RX 7800 XT is not on AMD’s Windows ROCm PyTorch compatibility list, so Qwen3-ASR stays on CPU Qwen. DirectML still accelerates Parakeet only. Not every AMD GPU is supported.',
    },
  };
  win.webContents.send('history-updated', payload);
  await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const amdHint = await evaluate('qwenAccelHintEl.textContent');
  assert.ok(/not every AMD GPU is supported/i.test(amdHint), 'unsupported AMD is honest: ' + amdHint);
  assert.ok(!/Qwen ROCm acceleration is active/.test(amdHint), 'unsupported AMD is not active ROCm: ' + amdHint);

  fs.mkdirSync(path.join(__dirname, '../temp'), { recursive: true });
  await evaluate('speechSetupInstallBtn.scrollIntoView({block: "center"})');
  fs.writeFileSync(path.join(__dirname, '../temp/speech-setup-ui.png'), (await win.webContents.capturePage()).toPNG());
  console.log('all speech setup renderer tests passed');
  win.destroy();
  app.quit();
}).catch(err => { console.error(err); app.exit(1); });
