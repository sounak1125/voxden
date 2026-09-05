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
const deadline = setTimeout(() => { console.error('Speech UI test timed out'); app.exit(1); }, 60000);
let win;
let installs = 0;
let removes = 0;
let cancels = 0;
let finishInstall;
const settingsPatches = [];
const actionCalls = [];
const accelInfoCalls = [];
let finishAccelInfo;
const micReports = [];
ipcMain.on('mic-devices', (_event, report) => micReports.push(report));
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
  asrRuntimeState: { status: 'idle' }, writingStyles: {},
};
const errors = [];
ipcMain.handle('app-load', () => payload);
ipcMain.handle('qwen-accel-info', (_event, kind) => {
  accelInfoCalls.push(kind);
  return new Promise(resolve => { finishAccelInfo = () => resolve(payload); });
});
ipcMain.handle('settings-set', (_event, patch) => {
  settingsPatches.push(patch);
  payload = { ...payload, ...patch };
  if (patch.shortcut) payload.shortcutLabel = require('../src/hotkeys').formatShortcutLabel(patch.shortcut);
  if (patch.pasteLastShortcut) payload.pasteLastShortcutLabel = require('../src/hotkeys').formatShortcutLabel(patch.pasteLastShortcut);
  return payload;
});
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
for (const channel of ['qwen-accel-install', 'qwen-accel-cancel', 'qwen-accel-remove', 'qwen-accel-retry',
  'cuda-pack-install', 'cuda-pack-cancel', 'cuda-pack-remove', 'speech-model-remove']) {
  ipcMain.handle(channel, (_event, ...args) => { actionCalls.push([channel, ...args]); return payload; });
}

app.whenReady().then(async () => {
  win = new BrowserWindow({ width: 1120, height: 760, useContentSize: true, show: false,
    webPreferences: { preload: path.join(__dirname, '../src/preload.js'), contextIsolation: true, sandbox: false, backgroundThrottling: false, offscreen: true } });
  win.webContents.on('console-message', (event, level, message) => {
    const lvl = event && event.level !== undefined ? event.level : level;
    const msg = event && event.message !== undefined ? event.message : message;
    if ((lvl === 'error' || Number(lvl) >= 3) && !/Content-Security-Policy/.test(String(msg))) errors.push(String(msg));
  });
  await win.loadFile(path.join(__dirname, '../src/app.html'));
  const evaluate = code => win.webContents.executeJavaScript(code);
  // Keep device discovery and capture entirely off the user's microphone.
  await evaluate(`window.micTest = { opens: 0, stops: 0, enumerations: 0, pending: false, fail: false,
    devices: [{ kind: 'audioinput', deviceId: 'built-in', label: 'Built-in microphone' },
      { kind: 'audioinput', deviceId: 'usb', label: 'USB Headset' }] };
    navigator.mediaDevices.getUserMedia = async () => {
      micTest.opens++;
      const track = { getSettings: () => ({ deviceId: 'built-in' }), stop: () => micTest.stops++ };
      return { getAudioTracks: () => [track], getTracks: () => [track] };
    };
    navigator.mediaDevices.enumerateDevices = async () => {
      micTest.enumerations++;
      if (micTest.pending) await new Promise(resolve => { micTest.release = resolve; });
      if (micTest.fail) throw new Error('Simulated device failure');
      return micTest.devices;
    }; true`);
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const settle = () => evaluate('new Promise(resolve => { requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))); setTimeout(() => resolve(true), 100); })');
  const waitFor = async (code) => {
    const until = Date.now() + 3000;
    while (Date.now() < until) {
      if (await evaluate(code)) return;
      await delay(30);
    }
    assert.fail('Timed out waiting for ' + code);
  };
  // Unlike an unconditional .click(), this refuses hidden or covered controls.
  const reachable = (selector, allowDisabled = false) => evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el || !el.getClientRects().length || (el.disabled && !${allowDisabled})) return false;
    el.scrollIntoView({ block: 'center', inline: 'nearest' });
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
  })()`);
  const click = async selector => {
    assert.ok(await reachable(selector), selector + ' must be visible and reachable');
    await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)});
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); el.click(); })()`);
    await settle();
  };
  const category = name => click('.settings-cat[data-cat="' + name + '"]');
  const selectOption = async (id, value) => {
    const wrap = '.custom-select:has(#' + id + ')';
    await click(wrap + ' .custom-select-trigger');
    await click(wrap + ' .custom-select-option[data-value="' + value + '"]');
  };
  await waitFor('!!lastPayload');
  await delay(1250); // Let the deferred startup enumeration finish before counting visits.
  await evaluate('window.confirm = () => true; true');
  await click('#nav-settings');
  assert.deepStrictEqual(await evaluate(`Array.from(document.querySelectorAll('.settings-cat-label')).map(el => el.textContent)`),
    ['General', 'Speech engines', 'System', 'Sound', 'Data and privacy']);
  assert.deepStrictEqual(await evaluate(`Array.from(document.querySelectorAll('.settings-panel[data-cat="general"] .setting-label')).map(el => el.textContent)`),
    ['Your name', 'Shortcuts', 'Dictation mode', 'Dictation speed', 'Microphone', 'Dictation language', 'App language']);
  assert.deepStrictEqual(await evaluate(`(() => { const seen = new Set(); return Array.from(document.querySelectorAll('[id]')).filter(el => {
    if (seen.has(el.id)) return true; seen.add(el.id); return false;
  }).map(el => el.id); })()`), [], 'moving controls must not duplicate IDs');
  for (const id of ['asr-engine-select', 'asr-device-select', 'gpu-card', 'qwen-accel-card', 'speech-setup-install', 'speech-extras', 'set-tuned-model']) {
    assert.strictEqual(await evaluate(`document.getElementById('${id}').closest('.settings-panel').dataset.cat`), 'speech-engines', id);
  }
  for (const id of ['mic-select', 'dictation-lang-select', 'app-lang-select']) {
    assert.strictEqual(await evaluate(`document.getElementById('${id}').closest('.settings-panel').dataset.cat`), 'general', id);
  }
  assert.strictEqual(await evaluate('document.getElementById("app-lang-select").disabled'), true, 'App language remains English only');

  await click('#set-display-name');
  await evaluate(`settingInputs.displayName.dispatchEvent(new FocusEvent('focus'));
    settingInputs.displayName.value = 'Settings tester';
    settingInputs.displayName.dispatchEvent(new FocusEvent('blur')); true`);
  await settle();
  await click('#mode-ptt');
  await click('#quality-accurate');
  await click('#shortcuts-change');
  assert.strictEqual(await evaluate('shortcutsDialog.open'), true);
  assert.strictEqual(await evaluate('document.activeElement.id'), 'shortcut-change');
  await click('#shortcut-change');
  await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', bubbles: true })); true`);
  assert.strictEqual(settingsPatches.length, 3, 'a bare key does not save a shortcut');
  assert.ok(await evaluate('shortcutCaptureHint.classList.contains("is-error")'));
  const escape = () => evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); true`);
  await escape();
  assert.strictEqual(await evaluate('capturingShortcutKind'), null, 'Escape first cancels capture');
  assert.strictEqual(await evaluate('shortcutsDialog.open'), true);
  await escape();
  assert.strictEqual(await evaluate('shortcutsDialog.open'), false, 'the next Escape closes only Shortcuts');
  assert.strictEqual(await evaluate('settingsOpen'), true);
  assert.strictEqual(await evaluate('document.activeElement.id'), 'shortcuts-change', 'focus returns to General');
  await click('#shortcuts-change');
  await evaluate('for (let i = 0; i < 200; i++) renderSettings(lastPayload); true');
  for (const [id, key, code] of [['shortcut-change', 'j', 'KeyJ'], ['paste-last-shortcut-change', 'k', 'KeyK']]) {
    await click('#' + id);
    await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: '${key}', code: '${code}', ctrlKey: true, shiftKey: true, bubbles: true })); true`);
    await settle();
  }
  assert.deepStrictEqual(settingsPatches, [
    { displayName: 'Settings tester' }, { dictateMode: 'ptt' }, { dictationQuality: 'accurate' },
    { shortcut: 'CommandOrControl+Shift+J' }, { pasteLastShortcut: 'CommandOrControl+Shift+K' },
  ], 'General controls each send their existing setting once');
  await click('#shortcuts-close');
  await selectOption('mic-select', 'usb');
  await selectOption('dictation-lang-select', 'hi');
  assert.deepStrictEqual(settingsPatches.slice(5), [{ microphone: 'usb' }, { dictationLanguage: 'hi' }], 'moved controls each save once');

  await category('speech-engines');
  await selectOption('asr-engine-select', 'whisper');
  await selectOption('asr-device-select', 'cpu');
  await selectOption('asr-engine-select', 'qwen3-asr');
  assert.deepStrictEqual(settingsPatches.slice(7), [{ asrEngine: 'whisper' }, { asrDevice: 'cpu' }, { asrEngine: 'qwen3-asr' }]);
  await click('#settings-close');
  await click('#nav-settings');
  assert.strictEqual(await evaluate('settingInputs.asrEngine.value'), 'qwen3-asr');
  assert.strictEqual(await evaluate('settingInputs.asrDevice.value'), 'cpu');
  await category('general');
  assert.strictEqual(await evaluate('settingInputs.displayName.value'), 'Settings tester');
  assert.strictEqual(await evaluate('modePttEl.getAttribute("aria-checked")'), 'true');
  assert.strictEqual(await evaluate('qualityAccurateEl.getAttribute("aria-checked")'), 'true');
  assert.strictEqual(await evaluate('shortcutDisplayEl.textContent'), 'Ctrl+Shift+J');
  assert.strictEqual(await evaluate('pasteLastShortcutDisplayEl.textContent'), 'Ctrl+Shift+K');
  assert.strictEqual(await evaluate('settingInputs.microphone.value'), 'usb');
  assert.strictEqual(await evaluate('settingInputs.dictationLanguage.value'), 'hi');
  await category('speech-engines');
  await evaluate('for (let i = 0; i < 200; i++) renderSpeechSetup(lastPayload); true');
  await click('#speech-setup-install');
  // A round-trip ensures queued IPC and its following render have completed.
  await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  assert.strictEqual(installs, 1, '200 renders must still send only one install');
  const busy = await evaluate(`({ cancelVisible: !speechSetupCancelBtn.hidden,
    bannerEnabled: !engineBannerBtnEl.disabled, action: engineBannerBtnEl.dataset.action,
    engines: Array.from(settingInputs.asrEngine.options, o => o.value) })`);
  assert(busy.cancelVisible && busy.bannerEnabled);
  assert.strictEqual(busy.action, 'cancel');
  assert.deepStrictEqual(busy.engines, ['whisper', 'qwen3-asr', 'parakeet']);
  await category('general');
  payload = { ...payload, asrRuntimeState: { status: 'downloading', progress: 42 } };
  win.webContents.send('history-updated', payload);
  await settle();
  assert.strictEqual(await evaluate('document.querySelector(".settings-panel[data-cat=speech-engines]").hidden'), true);
  await category('speech-engines');
  assert.strictEqual(await evaluate('speechSetupProgressEl.getAttribute("aria-valuenow")'), '42', 'download updates while its panel is hidden');
  assert.strictEqual(await evaluate('document.querySelector(".settings-detail").scrollTop'), 0, 'changing category starts at the top');
  await click('#speech-setup-cancel');
  await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  assert.strictEqual(cancels, 1);
  assert.strictEqual(await evaluate('getComputedStyle(speechSetupCancelBtn).display'), 'none', 'hidden cancel controls must actually disappear');
  payload = { ...payload, asrModel: { installed: true }, asrRuntime: { installed: true },
    modelPlan: require('../src/model-plan').plan({ engine: 'qwen3-asr', installed: { 'qwen3-asr': true } }) };
  win.webContents.send('history-updated', payload);
  await settle();
  await evaluate('for (let i = 0; i < 200; i++) renderSpeechSetup(lastPayload); true');
  await click('#speech-setup-remove');
  await evaluate('new Promise(resolve => requestAnimationFrame(resolve))');
  assert.strictEqual(removes, 1, '200 renders must still send only one removal');
  const selection = await evaluate('settingInputs.asrEngine.value');
  assert.strictEqual(selection, 'qwen3-asr');

  // Back to the resting offer: the cancel above left the banner reporting the
  // cancellation, which is a different message with a different job.
  payload = { ...payload, asrOperation: null, asrRuntimeState: { status: 'idle' }, asrModel: { installed: false },
    modelPlan: require('../src/model-plan').plan({ engine: 'qwen3-asr', device: 'auto', language: 'en',
      sizes: { whisper: 3.1e9, 'qwen3-asr': 4.7e9, parakeet: 0.66e9, 'parakeet-fp32': 2.51e9 }, installed: {} }) };
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

  await click('#speech-extras button');
  await evaluate('new Promise(resolve => requestAnimationFrame(resolve))');
  await click('#speech-extras .speech-extra:nth-child(2) button');
  assert.deepStrictEqual(extraInstalls, ['whisper', 'parakeet'], 'each optional model requests its own download exactly once');

  // A model that is installed but not needed by the chosen engine can go on
  // its own, from the same row that offered it.
  payload = { ...payload, modelPlan: require('../src/model-plan').plan({
    engine: 'qwen3-asr', device: 'auto', language: 'en',
    sizes: { whisper: 3.1e9, 'qwen3-asr': 4.7e9, parakeet: 0.66e9, 'parakeet-fp32': 2.51e9 },
    installed: { whisper: true },
  }) };
  win.webContents.send('history-updated', payload);
  await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const installedRows = await evaluate(`Array.from(speechExtrasEl.querySelectorAll('.speech-extra'), (row) => ({
    name: row.querySelector('.speech-extra-name').textContent,
    state: row.querySelector('.speech-extra-state') ? row.querySelector('.speech-extra-state').textContent : null,
    button: row.querySelector('button') ? row.querySelector('button').textContent : null,
  }))`);
  const whisperRow = installedRows.find((r) => /Whisper/.test(r.name));
  assert(whisperRow && whisperRow.state === 'Installed' && whisperRow.button === 'Remove',
    'an installed optional model offers Remove: ' + JSON.stringify(installedRows));
  assert(installedRows.some((r) => /Parakeet/.test(r.name) && /Download/.test(r.button || '')),
    'the others still offer their download: ' + JSON.stringify(installedRows));
  await click('#speech-extras .speech-setup-remove');
  assert.deepStrictEqual(actionCalls.at(-1), ['speech-model-remove', 'whisper']);

  assert.deepStrictEqual(errors, [], 'no renderer/preload errors');

  const diagnosticsVisible = await evaluate(`(() => { const card = buildCard({
    id: 'timing-test', ts: Date.now(), text: 'timed dictation',
    recognitionMs: 1476, modelRecognitionMs: 1200, rewriteMs: 2101,
    pasteMs: 150, stopToPasteMs: 3950,
    vocabulary: { summary: 'Qwen3-ASR · dictionary sent to the model · 8 terms' },
  }); return !!card.querySelector('.card-timing, .card-route'); })()`);
  assert.strictEqual(diagnosticsVisible, false,
    'history keeps timing and model-routing diagnostics internal');

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

  // Each acceleration card belongs to one engine and shows only while that
  // engine is selected. A GeForce with both packs on offer used to show both
  // cards under every engine, and the Whisper one read as a Qwen offer.
  const cards = async (engine) => {
    win.webContents.send('history-updated', {
      ...payload,
      asrEngine: engine,
      gpu: { vendor: 'nvidia', label: 'NVIDIA GeForce RTX 4070', needsPack: true },
      cudaPack: { downloadSize: '553 MB' },
      cudaPackState: { status: 'idle' },
      qwenAccel: {
        vendor: 'nvidia', gpuName: 'NVIDIA GeForce RTX 4070', uiStatus: 'offer',
        backend: 'cpu', verified: false, uiLabel: 'CPU Qwen', recommendedPack: 'cuda', supported: true,
        reason: 'Qwen CUDA acceleration is a separate download.',
      },
    });
    await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    return evaluate('({ whisper: gpuCardEl.hidden, qwen: qwenAccelCardEl.hidden, hint: gpuCardHintEl.textContent })');
  };
  const underQwen = await cards('qwen3-asr');
  assert.strictEqual(underQwen.whisper, true, 'the Whisper card must not show while Qwen is selected');
  assert.strictEqual(underQwen.qwen, false, 'the Qwen card shows while Qwen is selected');
  const underWhisper = await cards('whisper');
  assert.strictEqual(underWhisper.whisper, false, 'the Whisper card shows while Whisper is selected');
  assert.strictEqual(underWhisper.qwen, true, 'the Qwen card must not show while Whisper is selected');
  assert.ok(/cuBLAS/.test(underWhisper.hint), 'the Whisper card offers cuBLAS: ' + underWhisper.hint);
  const underParakeet = await cards('parakeet');
  assert.strictEqual(underParakeet.whisper, true, 'no Whisper card under Parakeet on a GeForce');
  assert.strictEqual(underParakeet.qwen, true, 'no Qwen card under Parakeet');

  // Parakeet on an AMD or Intel card gets the one note that is about it:
  // DirectML is already there, nothing to download.
  win.webContents.send('history-updated', {
    ...payload,
    asrEngine: 'parakeet',
    asrDevice: 'auto',
    gpu: { vendor: 'amd', label: 'AMD Radeon RX 7800 XT', needsPack: false, accelerates: 'Parakeet' },
    qwenAccel: { vendor: 'amd', uiStatus: 'unsupported', backend: 'cpu', supported: false },
  });
  await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const parakeetAmd = await evaluate('({ hidden: gpuCardEl.hidden, title: gpuCardTitleEl.textContent, hint: gpuCardHintEl.textContent, install: gpuInstallBtn.hidden })');
  assert.strictEqual(parakeetAmd.hidden, false, 'Parakeet on AMD keeps the DirectML note');
  assert.strictEqual(parakeetAmd.title, 'Parakeet acceleration');
  assert.ok(/DirectML/.test(parakeetAmd.hint) && /Nothing to download/.test(parakeetAmd.hint), parakeetAmd.hint);
  assert.strictEqual(parakeetAmd.install, true, 'the note offers nothing to download');
  win.webContents.send('history-updated', payload);
  await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');

  const publish = async patch => {
    payload = { ...payload, ...patch };
    win.webContents.send('history-updated', payload);
    await settle();
  };
  const cudaOffer = { vendor: 'nvidia', recommendedPack: 'cuda', supported: true, uiStatus: 'offer',
    pack: { downloadSize: '3.09 GB' } };
  await publish({ asrEngine: 'qwen3-asr', qwenAccel: cudaOffer, qwenCudaPackState: { status: 'idle' },
    qwenCudaPack: { installed: false, downloadSize: '', downloadSizeStatus: 'idle', downloadSizeRefreshAt: 0 } });
  await waitFor('qwenAccelInfoRequests.has("cuda")');
  assert.strictEqual(await evaluate('qwenAccelInstallBtn.textContent'), 'Download Qwen CUDA acceleration');
  assert.match(await evaluate('qwenAccelHintEl.textContent'), /Checking download size/);
  await evaluate('for (let i = 0; i < 200; i++) renderSettings(lastPayload); true');
  assert.deepStrictEqual(accelInfoCalls, ['cuda'], 'repeated renders share the pending metadata request');
  payload = { ...payload, qwenCudaPack: { installed: false, downloadSizeStatus: 'ready',
    downloadSizeRefreshAt: Date.now() + 300000, downloadSize: '1.88–2.10 GB',
    downloadMinBytes: 1881694951, downloadBytes: 2101411351 } };
  finishAccelInfo();
  await waitFor('qwenAccelInstallBtn.textContent.includes("1.88–2.10 GB") && !qwenAccelInfoRequests.has("cuda")');
  const compactHint = await evaluate('qwenAccelHintEl.textContent');
  assert.match(compactHint, /1.88–2.10 GB/);
  assert.match(compactHint, /support files can be reused/);
  assert(!compactHint.includes('3.09'), 'the legacy plan estimate cannot leak into the available size');
  await evaluate('for (let i = 0; i < 200; i++) renderSettings(lastPayload); true');
  assert.deepStrictEqual(accelInfoCalls, ['cuda'], 'cached metadata avoids repeated lookups');
  await publish({ qwenCudaPack: { ...payload.qwenCudaPack, downloadSize: '2.10 GB', downloadMinBytes: 2101411351 } });
  assert.strictEqual(await evaluate('qwenAccelInstallBtn.textContent'), 'Download Qwen CUDA acceleration (2.10 GB)');
  assert(!/support files can be reused/.test(await evaluate('qwenAccelHintEl.textContent')));
  await publish({ qwenCudaPack: { installed: false, downloadSize: '', downloadSizeStatus: 'idle', downloadSizeRefreshAt: 0 } });
  await waitFor('qwenAccelInfoRequests.has("cuda")');
  payload = { ...payload, qwenCudaPack: { installed: false, downloadSizeStatus: 'unavailable',
    downloadSizeRefreshAt: Date.now() + 30000, downloadSize: '', downloadBytes: null, downloadMinBytes: null } };
  finishAccelInfo();
  await waitFor('qwenAccelHintEl.textContent.includes("temporarily unavailable") && !qwenAccelInfoRequests.has("cuda")');
  assert.strictEqual(await evaluate('qwenAccelInstallBtn.textContent'), 'Download Qwen CUDA acceleration');
  assert.strictEqual(await evaluate('qwenAccelInstallBtn.disabled'), false, 'metadata failure still allows an installation retry');
  await evaluate('for (let i = 0; i < 200; i++) renderSettings(lastPayload); true');
  assert.deepStrictEqual(accelInfoCalls, ['cuda', 'cuda'], 'offline metadata lookup respects its retry delay');

  await publish({ asrEngine: 'whisper', gpu: { vendor: 'nvidia', label: 'NVIDIA GPU', needsPack: true },
    cudaPackState: { status: 'idle' }, cudaPack: { installed: false, downloadSize: '553 MB' } });
  await evaluate('for (let i = 0; i < 200; i++) renderSettings(lastPayload); true');
  await click('#gpu-install');
  await publish({ cudaPackState: { status: 'downloading', progress: 25 } });
  await click('#gpu-cancel');
  await publish({ gpu: { vendor: 'nvidia', label: 'NVIDIA GPU', needsPack: false }, cudaPackState: { status: 'idle' }, cudaPack: { installed: true } });
  await click('#gpu-remove');
  for (const kind of ['cuda', 'rocm']) {
    const stateKey = kind === 'cuda' ? 'qwenCudaPackState' : 'qwenRocmPackState';
    const packKey = kind === 'cuda' ? 'qwenCudaPack' : 'qwenRocmPack';
    const plan = { vendor: kind === 'cuda' ? 'nvidia' : 'amd', recommendedPack: kind, supported: true, uiStatus: 'offer' };
    await publish({ asrEngine: 'qwen3-asr', qwenAccel: plan, [stateKey]: { status: 'idle' }, [packKey]: { installed: false, downloadSize: '2.8 GB' } });
    await evaluate('for (let i = 0; i < 200; i++) renderSettings(lastPayload); true');
    await click('#qwen-accel-install');
    await publish({ [stateKey]: { status: 'downloading', progress: 50 } });
    await click('#qwen-accel-cancel');
    await publish({ qwenAccel: { ...plan, uiStatus: 'fallback', sessionBlocked: true }, [stateKey]: { status: 'idle' }, [packKey]: { installed: true } });
    await click('#qwen-accel-retry');
    await click('#qwen-accel-remove');
  }
  assert.deepStrictEqual(actionCalls, [
    ['speech-model-remove', 'whisper'], ['cuda-pack-install'], ['cuda-pack-cancel'], ['cuda-pack-remove'],
    ['qwen-accel-install', 'cuda'], ['qwen-accel-cancel', 'cuda'], ['qwen-accel-retry'], ['qwen-accel-remove', 'cuda'],
    ['qwen-accel-install', 'rocm'], ['qwen-accel-cancel', 'rocm'], ['qwen-accel-retry'], ['qwen-accel-remove', 'rocm'],
  ], 'every moved action sends exactly one request with the correct pack');
  await publish({ asrEngine: 'whisper', tunedModel: { builtAt: Date.now() }, useTunedModel: false });
  await click('#tuned-row .toggle');
  assert.deepStrictEqual(settingsPatches.at(-1), { useTunedModel: true });
  await category('general');
  await category('speech-engines');
  assert.strictEqual(await evaluate('settingInputs.useTunedModel.checked'), true);

  // Old category links and new row links both navigate through the real IPC bridge.
  for (const section of ['microphone', 'dictation-language', 'app-language']) {
    for (const target of [section, 'general#' + section]) {
      await category('speech-engines');
      win.webContents.send('open-settings', target);
      await settle();
      assert.strictEqual(await evaluate('settingsCat'), 'general', target);
      assert.strictEqual(await evaluate('document.activeElement.dataset.settingsSection'), section, target + ' focuses its row');
      assert.ok(await reachable('[data-settings-section="' + section + '"]'), target + ' reveals its row');
    }
  }
  for (const target of ['unknown', 'general#unknown', 'speech-engines#microphone', 'general#microphone#extra']) {
    win.webContents.send('open-settings', target);
    await settle();
    assert.strictEqual(await evaluate('settingsCat'), 'general', 'unknown links keep the current category');
  }

  // Changing categories during discovery must not open another stream or leave
  // General's microphone picker disabled when the in-flight query completes.
  await category('speech-engines');
  const micOpens = await evaluate('micTest.opens');
  await evaluate('micTest.pending = true; micTest.release = null; true');
  await category('general');
  await waitFor('!!micTest.release');
  await category('general');
  assert.strictEqual(await evaluate('micTest.opens'), micOpens + 1, 'concurrent discovery is deduplicated');
  assert.strictEqual(await evaluate('settingInputs.microphone.disabled'), true);
  await category('speech-engines');
  await evaluate('micTest.pending = false; micTest.release(); true');
  await waitFor('!micListLoading');
  await category('general');
  assert.strictEqual(await evaluate('settingInputs.microphone.value'), 'usb');
  await evaluate('micTest.fail = true; navigator.mediaDevices.dispatchEvent(new Event("devicechange")); true');
  await settle();
  assert.strictEqual(await evaluate('settingInputs.microphone.disabled'), false, 'failed enumeration leaves the previous picker usable');
  assert.strictEqual(await evaluate('settingInputs.microphone.value'), 'usb');
  await evaluate(`micTest.fail = false; micTest.devices.push({ kind: 'audioinput', deviceId: 'desk', label: 'Desk microphone' });
    navigator.mediaDevices.dispatchEvent(new Event('devicechange')); true`);
  await waitFor('Array.from(settingInputs.microphone.options).some(opt => opt.value === "desk")');
  assert.ok(micReports.at(-1).devices.some(device => device.id === 'desk'), 'device updates also reach the tray');
  const beforeReopen = await evaluate('micTest.opens');
  await click('#settings-close');
  await click('#nav-settings');
  assert.strictEqual(await evaluate('micTest.opens'), beforeReopen + 1, 'reopening General refreshes devices once');
  assert.strictEqual(await evaluate('micTest.opens === micTest.stops'), true, 'every simulated discovery stream is stopped');

  payload = { ...payload, hotkeyNotice: 'The dictation shortcut is unavailable. Choose another shortcut.' };
  win.webContents.send('history-updated', payload);
  await settle();
  assert.strictEqual(await evaluate('shortcutsStatusEl.hidden'), false, 'General shows shortcut failures while the editor is closed');

  await click('#shortcuts-change');
  assert.strictEqual(await evaluate('shortcutCaptureHint.textContent'), payload.hotkeyNotice, 'the dialog also explains the shortcut failure');
  assert.strictEqual(await evaluate('shortcutsDialog.matches(":modal")'), true, 'Shortcuts is a modal child of Settings');
  assert.strictEqual(await reachable('#settings-close'), false, 'the outer dialog is blocked while Shortcuts is open');
  await click('#paste-last-shortcut-change');
  await evaluate(`shortcutsDialog.dispatchEvent(new MouseEvent('click', { clientX: 1, clientY: 1, bubbles: true })); true`);
  assert.strictEqual(await evaluate('shortcutsDialog.open'), false, 'clicking the backdrop closes only Shortcuts');
  assert.strictEqual(await evaluate('settingsOpen && !capturingShortcutKind'), true, 'closing cancels capture without closing Settings');
  assert.strictEqual(await evaluate('shortcutsStatusEl.hidden'), false, 'cancelling capture retains the standing notice');
  payload = { ...payload, hotkeyNotice: '' };
  win.webContents.send('history-updated', payload);
  await settle();
  await click('#shortcuts-change');
  await click('#shortcut-change');
  win.webContents.send('open-settings', 'speech-engines');
  await settle();
  assert.strictEqual(await evaluate('shortcutsDialog.open || !!capturingShortcutKind'), false, 'external navigation cancels the child dialog');

  // Inspect the real categories at normal and minimum supported window sizes.
  // Scroll every visible control into view and verify it can receive a click;
  // a DOM-only test would also pass for controls clipped outside the dialog.
  fs.mkdirSync(path.join(__dirname, '../temp'), { recursive: true });
  const capture = async name => {
    win.webContents.invalidate();
    await delay(100);
    fs.writeFileSync(path.join(__dirname, '../temp/settings-' + name + '.png'), (await win.webContents.capturePage()).toPNG());
  };
  for (const [width, height] of [[1120, 760], [640, 440]]) {
    win.setContentSize(width, height);
    await delay(200);
    assert.deepStrictEqual(await evaluate('[innerWidth, innerHeight]'), [width, height], 'layout uses the requested CSS viewport');
    for (const cat of ['general', 'speech-engines']) {
      await category(cat);
      assert.strictEqual(await evaluate('document.querySelector(".settings-detail").scrollTop'), 0);
      await capture(cat + '-' + width);
      assert.ok(await evaluate(`(() => { const pane = document.querySelector('.settings-detail'); return pane.scrollWidth <= pane.clientWidth + 1; })()`),
        cat + ' must not overflow horizontally at ' + width);
      const selectors = cat === 'general'
        ? ['#set-display-name', '#shortcuts-change', '#mode-toggle', '#mode-ptt', '#quality-auto', '#quality-fast', '#quality-accurate', '.custom-select:has(#mic-select) .custom-select-trigger', '.custom-select:has(#dictation-lang-select) .custom-select-trigger']
        : ['.custom-select:has(#asr-engine-select) .custom-select-trigger', '.custom-select:has(#asr-device-select) .custom-select-trigger', '#speech-setup-install', '#speech-setup-remove', '#gpu-remove', '#tuned-row .toggle'];
      for (const selector of selectors) assert.ok(await reachable(selector), selector + ' at ' + width);
      if (cat === 'general') assert.ok(await reachable('.custom-select:has(#app-lang-select) .custom-select-trigger', true), 'English-only app language is visible');
      await capture(cat + '-' + width + '-bottom');
      if (cat === 'general') {
        await click('#shortcuts-change');
        for (const selector of ['#shortcut-change', '#paste-last-shortcut-change', '#shortcuts-close']) {
          assert.ok(await reachable(selector), selector + ' inside the dialog at ' + width);
        }
        assert.ok(await evaluate(`(() => { const r = shortcutsDialog.getBoundingClientRect();
          return r.top >= 0 && r.bottom <= innerHeight && shortcutsDialog.scrollWidth <= shortcutsDialog.clientWidth; })()`), 'shortcut dialog fits at ' + width);
        await capture('shortcuts-' + width);
        await click('#shortcuts-close');
      }
      {
        for (const id of (cat === 'general' ? ['mic-select', 'dictation-lang-select'] : ['asr-engine-select', 'asr-device-select'])) {
          const wrap = '.custom-select:has(#' + id + ')';
          await click(wrap + ' .custom-select-trigger');
          assert.ok(await evaluate(`(() => {
            const list = document.querySelector('${wrap} .custom-select-list').getBoundingClientRect();
            const pane = document.querySelector('.settings-detail').getBoundingClientRect();
            return list.top >= pane.top && list.bottom <= pane.bottom && list.left >= pane.left && list.right <= pane.right;
          })()`), id + ' dropdown fits inside settings at ' + width);
          await capture(id + '-' + width + '-open');
          const options = await evaluate(`Array.from(document.querySelectorAll('${wrap} .custom-select-option')).map(el => el.dataset.value)`);
          for (const value of options) assert.ok(await reachable(wrap + ' .custom-select-option[data-value="' + value + '"]'), id + ' option ' + value + ' at ' + width);
          await evaluate('closeAllCustomSelects(); true');
        }
      }
    }
  }
  assert.deepStrictEqual(errors, [], 'no renderer/preload errors after exercising all settings');
  clearTimeout(deadline);
  console.log('all speech setup renderer tests passed');
  win.destroy();
  app.quit();
}).catch(err => { console.error(err); app.exit(1); });
