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
// A stand-in account service: the renderer only ever paints the snapshot the
// main process answers with, so these produce the snapshots a real flow would.
const accountCalls = [];
const accountBase = { signedIn: false, email: '', pendingEmail: '', plan: 'free', planExpiresAt: null,
  cloud: { hoursUsed: 0, hoursCap: 0, periodEnd: null }, checkedAt: 0, stale: false, busy: '', lastError: '', tokenProtected: true };
const asrLang = require('../src/asr');
function cloudLanguagePayload(unlocked) {
  return {
    account: unlocked
      ? { ...accountBase, signedIn: true, email: 'me@example.com', plan: 'pro',
          cloud: { hoursUsed: 1.25, hoursCap: 10, periodEnd: '2026-10-01T00:00:00.000Z' }, checkedAt: Date.now() }
      : { ...accountBase },
    cloudTranscription: !!unlocked,
    dictationLanguageUnlocked: !!unlocked,
    dictationLanguageMax: unlocked ? 3 : 1,
    dictationLanguageCatalog: asrLang.DICTATION_LANGUAGES,
    dictationLanguageOffered: unlocked
      ? asrLang.DICTATION_LANGUAGES
      : asrLang.DICTATION_LANGUAGES.filter((l) => l.id === 'en'),
  };
}
ipcMain.handle('account-code', (_event, email) => {
  accountCalls.push(['code', email]);
  payload = { ...payload, account: { ...accountBase, pendingEmail: String(email).trim().toLowerCase() } };
  return payload;
});
ipcMain.handle('account-verify', (_event, email, code) => {
  accountCalls.push(['verify', email, code]);
  payload = { ...payload, account: code === '123456'
    ? { ...accountBase, signedIn: true, email: 'me@example.com', plan: 'pro', planExpiresAt: '2027-01-01T00:00:00.000Z',
      cloud: { hoursUsed: 1.25, hoursCap: 10, periodEnd: '2026-10-01T00:00:00.000Z' }, checkedAt: Date.now(),
      profile: { firstName: 'Me', lastName: 'Tester', pictureUrl: '' } }
    : { ...accountBase, pendingEmail: 'me@example.com', lastError: 'That code is not right. Check the email and try again.' } };
  return payload;
});
ipcMain.handle('account-cancel', () => { accountCalls.push(['cancel']); payload = { ...payload, account: { ...accountBase } }; return payload; });
const billingOptions = [
  { provider: 'razorpay', region: 'in', label: 'India', cloudHoursCap: 10, plans: [{ id: 'monthly', label: '₹349 / month' }, { id: 'annual', label: 'Legacy yearly offer' }] },
  { provider: 'lemonsqueezy', region: 'global', label: 'Everywhere else', plans: [{ id: 'monthly', label: '$8 / month' }, { id: 'annual', label: '$72 / year' }] },
];
ipcMain.handle('account-billing-options', () => {
  accountCalls.push(['billing-options']);
  payload = { ...payload, account: { ...payload.account, billing: { options: billingOptions } } };
  return payload;
});
ipcMain.handle('account-checkout', (_event, provider, plan) => {
  accountCalls.push(['checkout', provider, plan]);
  payload = { ...payload, account: { ...payload.account, checkoutPending: { provider, plan, startedAt: Date.now() } } };
  return payload;
});
ipcMain.handle('account-manage-billing', () => { accountCalls.push(['manage']); return payload; });
const proSubscription = { provider: 'razorpay', plan: 'monthly', status: 'active', periodEnd: '2027-01-01T00:00:00.000Z',
  manageUrl: 'https://rzp.example/portal', renews: true, label: '₹349 / month' };
ipcMain.handle('account-billing', () => {
  accountCalls.push(['billing']);
  if (payload.account.plan === 'pro') payload = { ...payload, account: { ...payload.account, billing: { ...(payload.account.billing || {}), subscription: { ...proSubscription } } } };
  return payload;
});
ipcMain.handle('account-cancel-subscription', () => {
  accountCalls.push(['cancel-subscription']);
  payload = { ...payload, account: { ...payload.account, billing: { subscription: { ...proSubscription, status: 'cancelling', renews: false } } } };
  return payload;
});
ipcMain.handle('account-refresh', () => { accountCalls.push(['refresh']); return payload; });
ipcMain.handle('account-sign-out', () => { accountCalls.push(['signout']); payload = { ...payload, account: { ...accountBase } }; return payload; });
ipcMain.handle('account-update-profile', (_event, profile) => {
  accountCalls.push(['profile', profile]);
  payload = { ...payload, account: { ...payload.account, profile: { ...(payload.account.profile || {}), ...profile } } };
  return payload;
});
ipcMain.handle('account-delete', () => {
  accountCalls.push(['delete']);
  payload = { ...payload, signInRequired: true, account: { ...accountBase } };
  return payload;
});
ipcMain.handle('account-auth-options', () => {
  accountCalls.push(['auth-options']);
  payload = { ...payload, account: { ...payload.account, auth: { google: true, googleClientId: 'cid' } } };
  return payload;
});
let googleOutcome = 'ok';
ipcMain.handle('account-google', async () => {
  accountCalls.push(['google']);
  payload = { ...payload, account: { ...payload.account, busy: 'google' } };
  win.webContents.send('history-updated', payload);
  await new Promise(resolve => setTimeout(resolve, 150));
  payload = googleOutcome === 'ok'
    ? { ...payload, signInRequired: false, account: { ...accountBase, signedIn: true, email: 'me@gmail.com', checkedAt: Date.now(), auth: { google: true } } }
    : { ...payload, account: { ...payload.account, busy: '', lastError: 'Google sign-in was cancelled.' } };
  return payload;
});
ipcMain.handle('account-google-cancel', () => { accountCalls.push(['google-cancel']); googleOutcome = 'cancelled'; return payload; });
let extraInstalls = [];
ipcMain.handle('speech-model-install', (_event, id, options) => {
  extraInstalls.push(options === undefined ? id : [id, options]);
  return payload;
});
const feedbackReports = [];
let feedbackReply = { ok: true };
ipcMain.handle('feedback-send', (e, report) => { feedbackReports.push(report); return feedbackReply; });
ipcMain.handle('feedback-open-issue', () => ({ ok: true, url: 'https://example.test/issue' }));
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
  await click('#nav-settings');
  assert.deepStrictEqual(await evaluate(`Array.from(document.querySelectorAll('.settings-cat-label')).map(el => el.textContent)`),
    ['General', 'Account', 'Plans & billing', 'Speech engines', 'System', 'Sound', 'Data and privacy']);
  assert.deepStrictEqual(await evaluate(`Array.from(document.querySelectorAll('.settings-panel[data-cat="general"] .setting-label')).map(el => el.textContent)`),
    ['Shortcuts', 'Dictation mode', 'Dictation speed', 'Microphone', 'Dictation languages', 'App language', 'Auto-add to dictionary']);
  assert.deepStrictEqual(await evaluate(`(() => { const seen = new Set(); return Array.from(document.querySelectorAll('[id]')).filter(el => {
    if (seen.has(el.id)) return true; seen.add(el.id); return false;
  }).map(el => el.id); })()`), [], 'moving controls must not duplicate IDs');
  for (const id of ['asr-engine-select', 'asr-device-select', 'qwen-upgrade-card', 'gpu-card', 'qwen-accel-card', 'speech-setup-install', 'speech-extras', 'set-tuned-model']) {
    assert.strictEqual(await evaluate(`document.getElementById('${id}').closest('.settings-panel').dataset.cat`), 'speech-engines', id);
  }
  for (const id of ['mic-select', 'dictation-lang-open', 'app-lang-select', 'set-auto-add-dictionary']) {
    assert.strictEqual(await evaluate(`document.getElementById('${id}').closest('.settings-panel').dataset.cat`), 'general', id);
  }
  assert.strictEqual(await evaluate('document.getElementById("app-lang-select").disabled'), true, 'App language remains English only');

  assert.strictEqual(await evaluate("document.getElementById('set-display-name')"), null, 'the name lives on the account page now, not in General');
  await click('#mode-ptt');
  await click('#quality-accurate');
  await click('#shortcuts-change');
  assert.strictEqual(await evaluate('shortcutsDialog.open'), true);
  assert.strictEqual(await evaluate('document.activeElement.id'), 'shortcut-change');
  await click('#shortcut-change');
  await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', bubbles: true })); true`);
  assert.strictEqual(settingsPatches.length, 2, 'a bare key does not save a shortcut');
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
    { dictateMode: 'ptt' }, { dictationQuality: 'accurate' },
    { shortcut: 'CommandOrControl+Shift+J' }, { pasteLastShortcut: 'CommandOrControl+Shift+K' },
  ], 'General controls each send their existing setting once');
  await click('#shortcuts-close');
  await selectOption('mic-select', 'usb');
  // The languages live behind one box that opens a picker. Free users see
  // English only; Pro + Cloud unlocks the cloud menu. Nothing is saved until
  // Save and close; Cancel and Escape drop the draft.
  const tileInfo = (id) => evaluate(`(() => { const b = document.querySelector('#dictation-lang-grid [data-lang="${id}"]');
    return b ? (b.dataset.lang + ':' + b.getAttribute('aria-pressed') + (b.disabled ? ':locked' : '')) : 'missing'; })()`);
  const selectedList = () => evaluate(`Array.from(document.querySelectorAll('#dictation-lang-selected li'), li => li.textContent).join('|')`);
  assert.strictEqual(await evaluate('dictationLangOpenBtn.textContent'), 'English', 'the box names what is picked');
  assert.strictEqual(await evaluate('dictationLangOpenBtn.disabled'), true, 'Free plan cannot change languages');
  assert.ok(/English on this PC/.test(await evaluate('dictationLangHintEl.textContent')),
    'Free hint points at Cloud: ' + await evaluate('dictationLangHintEl.textContent'));
  payload = { ...payload, ...cloudLanguagePayload(true), dictationLanguages: ['en'] };
  win.webContents.send('history-updated', payload);
  await settle();
  assert.strictEqual(await evaluate('dictationLangOpenBtn.disabled'), false, 'Pro + Cloud unlocks the picker');
  await click('#dictation-lang-open');
  assert.strictEqual(await evaluate('dictationLangDialog.open'), true, 'the box opens the picker');
  assert.ok(Number(await evaluate('document.querySelectorAll("#dictation-lang-grid [data-lang]").length')) >= 60,
    'cloud languages are listed');
  assert.strictEqual(await tileInfo('fil'), 'fil:false');
  assert.strictEqual(await tileInfo('yue'), 'yue:false');
  await evaluate(`dictationLangSearchEl.value = 'bengali'; dictationLangSearchEl.dispatchEvent(new Event('input', { bubbles: true })); true`);
  assert.strictEqual(await evaluate('document.querySelector("#dictation-lang-grid [data-lang]:not(.is-hidden)").dataset.lang'), 'bn');
  await evaluate(`dictationLangSearchEl.value = ''; dictationLangSearchEl.dispatchEvent(new Event('input', { bubbles: true })); true`);
  assert.strictEqual(await tileInfo('en'), 'en:true');
  assert.strictEqual(await tileInfo('hg'), 'hg:false');
  assert.strictEqual(await tileInfo('hi'), 'hi:false');
  assert.strictEqual(await tileInfo('de'), 'de:false');
  await click('#dictation-lang-grid [data-lang="hg"]');
  await click('#dictation-lang-grid [data-lang="de"]');
  assert.strictEqual(await tileInfo('en'), 'en:true');
  assert.strictEqual(await tileInfo('hg'), 'hg:true');
  assert.strictEqual(await tileInfo('hi'), 'hi:false', 'Hindi stays open to swap with Hinglish');
  assert.strictEqual(await tileInfo('de'), 'de:true');
  assert.strictEqual(await tileInfo('fr'), 'fr:false:locked', 'three picked, the rest lock');
  assert.strictEqual(await selectedList(), 'Englishmain−|Hinglish−|German−', 'the picked ones are listed in order, the first marked main');
  assert.strictEqual(settingsPatches.length, 5, 'nothing is saved while the picker is open');
  await click('#dictation-lang-save');
  assert.strictEqual(await evaluate('dictationLangDialog.open'), false, 'Save closes the picker');
  assert.deepStrictEqual(settingsPatches.slice(4), [{ microphone: 'usb' }, { dictationLanguages: ['en', 'hg', 'de'] }], 'moved controls each save once; the picker saves the list');
  assert.strictEqual(await evaluate('dictationLangOpenBtn.textContent'), 'English, Hinglish, German');
  assert.ok(/Hindi is written in English letters/.test(await evaluate('dictationLangHintEl.textContent')), 'Hinglish is explained on the row');
  payload = { ...payload, dictationLanguages: ['en', 'hg', 'de'] };
  win.webContents.send('history-updated', { ...payload, ...cloudLanguagePayload(false), account: cloudLanguagePayload(true).account,
    dictationLanguages: ['en', 'hg', 'de'], dictationLanguageUnlocked: false, cloudTranscription: false,
    dictationLanguageOffered: asrLang.DICTATION_LANGUAGES.filter((l) => l.id === 'en') });
  await settle();
  assert.strictEqual(await evaluate('dictationLangOpenBtn.textContent'), 'English', 'Cloud off shows English locally');
  assert.ok(/Local dictation is English/.test(await evaluate('dictationLangHintEl.textContent'))
    && /Hinglish/.test(await evaluate('dictationLangHintEl.textContent')),
    'saved Cloud languages are named in the hint: ' + await evaluate('dictationLangHintEl.textContent'));
  payload = { ...payload, ...cloudLanguagePayload(true), dictationLanguages: ['en', 'hg', 'de'] };
  win.webContents.send('history-updated', payload);
  await settle();
  assert.strictEqual(await evaluate('dictationLangOpenBtn.textContent'), 'English, Hinglish, German', 'turning Cloud back on restores the saved list');
  // Hindi and Hinglish are one language to the engine: picking one replaces
  // the other, even when the list is full.
  await click('#dictation-lang-open');
  await click('#dictation-lang-grid [data-lang="hi"]');
  assert.strictEqual(await selectedList(), 'Englishmain−|German−|Hindi−', 'Hindi took the place of Hinglish');
  await click('#dictation-lang-selected [data-remove="en"]');
  await click('#dictation-lang-selected [data-remove="de"]');
  assert.strictEqual(await selectedList(), 'Hindi−', 'the list can be emptied down from the side');
  await click('#dictation-lang-selected [data-remove="hi"]');
  assert.strictEqual(await selectedList(), 'Nothing picked yet.');
  await click('#dictation-lang-save');
  assert.strictEqual(await evaluate('dictationLangDialog.open'), true, 'an empty list is refused');
  assert.strictEqual(await evaluate('dictationLangErrorEl.textContent'), 'Pick at least one language.');
  await click('#dictation-lang-grid [data-lang="hi"]');
  await click('#dictation-lang-save');
  assert.deepStrictEqual(settingsPatches.at(-1), { dictationLanguages: ['hi'] }, 'the main language can be replaced outright');
  const patchesBeforeCancel = settingsPatches.length;
  await click('#dictation-lang-open');
  await click('#dictation-lang-grid [data-lang="fr"]');
  await click('#dictation-lang-cancel');
  assert.strictEqual(settingsPatches.length, patchesBeforeCancel, 'Cancel saves nothing');
  assert.strictEqual(await evaluate('dictationLangOpenBtn.textContent'), 'Hindi');

  await category('speech-engines');
  await selectOption('asr-engine-select', 'whisper');
  await selectOption('asr-device-select', 'cpu');
  await selectOption('asr-engine-select', 'qwen3-asr');
  assert.deepStrictEqual(settingsPatches.slice(-3), [{ asrEngine: 'whisper' }, { asrDevice: 'cpu' }, { asrEngine: 'qwen3-asr' }]);
  await click('#settings-close');
  await click('#nav-settings');
  assert.strictEqual(await evaluate('settingInputs.asrEngine.value'), 'qwen3-asr');
  assert.strictEqual(await evaluate('settingInputs.asrDevice.value'), 'cpu');
  await category('general');
  assert.strictEqual(await evaluate('modePttEl.getAttribute("aria-checked")'), 'true');
  assert.strictEqual(await evaluate('qualityAccurateEl.getAttribute("aria-checked")'), 'true');
  assert.strictEqual(await evaluate('shortcutDisplayEl.textContent'), 'Ctrl+Shift+J');
  assert.strictEqual(await evaluate('pasteLastShortcutDisplayEl.textContent'), 'Ctrl+Shift+K');
  assert.strictEqual(await evaluate('settingInputs.microphone.value'), 'usb');
  assert.strictEqual(await evaluate('dictationLangOpenBtn.textContent'), 'Hindi', 'the box survives leaving and returning');
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
  assert.deepStrictEqual(busy.engines, ['parakeet', 'qwen3-asr', 'whisper'], 'the default engine is listed first');
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
  assert.strictEqual(await evaluate("document.getElementById('confirm-dialog').open"), true,
    'removal asks first, in the in-app dialog');
  assert.strictEqual(await evaluate("document.getElementById('confirm-title').textContent"), 'Remove the speech engine?');
  assert.strictEqual(removes, 0, 'nothing is removed until the question is answered');
  await click('#confirm-cancel');
  assert.strictEqual(removes, 0, 'Cancel removes nothing');
  assert.strictEqual(await evaluate('speechSetupRemoveBtn.disabled'), false, 'a cancelled removal can be asked again');
  await click('#speech-setup-remove');
  await click('#confirm-ok');
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
    ['Parakeet v3', 'Whisper large-v3'], 'exactly the optional engines: '
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
  await click('#confirm-ok');
  assert.deepStrictEqual(actionCalls.at(-1), ['speech-model-remove', 'whisper']);

  // Language tests leave a Pro Cloud snapshot on the payload. Account tests
  // start from a build with no account service at all.
  payload = { ...payload };
  delete payload.account;
  payload.cloudTranscription = false;
  payload.dictationLanguageUnlocked = false;
  win.webContents.send('history-updated', payload);
  await settle();

  // --- Account: sign in with an emailed code, see the plan, sign out --------
  const accountView = () => evaluate(`({
    out: !document.getElementById('account-signed-out').hidden,
    pending: !document.getElementById('account-pending').hidden,
    in: !document.getElementById('account-signed-in').hidden,
    error: document.getElementById('account-error').hidden ? '' : document.getElementById('account-error').textContent,
    pendingHint: document.getElementById('account-pending-hint').textContent,
    pendingError: document.getElementById('account-pending-error').hidden ? '' : document.getElementById('account-pending-error').textContent,
    email: document.getElementById('profile-email').textContent,
    pro: document.getElementById('profile-avatar-wrap').classList.contains('is-pro') && !document.getElementById('profile-badge').hidden,
    first: document.getElementById('profile-first').value,
    last: document.getElementById('profile-last').value,
    initials: document.getElementById('profile-avatar-initials').textContent,
    photo: !document.getElementById('profile-avatar-img').hidden,
    plan: document.getElementById('account-plan-hint').textContent,
    status: document.getElementById('account-status-hint').textContent,
  })`);
  const noAccount = await accountView();
  assert.ok(noAccount.out && /not available/.test(noAccount.error), 'a build with no account service says so: ' + JSON.stringify(noAccount));
  payload = { ...payload, account: { ...accountBase } };
  win.webContents.send('history-updated', payload);
  await settle();
  await category('account');
  assert.deepStrictEqual(await accountView().then(v => [v.out, v.pending, v.in, v.error]), [true, false, false, ''], 'signed out shows the email row alone');
  await evaluate(`document.getElementById('account-email').value = ' Me@Example.com '; true`);
  await click('#account-send-code');
  await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  // An email input trims for us; the lower-casing is main's job.
  assert.deepStrictEqual(accountCalls, [['code', 'Me@Example.com']], 'the address goes to main as typed; main normalises it');
  const pending = await accountView();
  assert.ok(!pending.out && pending.pending && !pending.in, 'a sent code shows the code row: ' + JSON.stringify(pending));
  assert.ok(/Sent to me@example.com/.test(pending.pendingHint), pending.pendingHint);
  await evaluate(`document.getElementById('account-code').value = '000000'; true`);
  await click('#account-verify');
  await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const wrongCode = await accountView();
  assert.ok(wrongCode.pending && /not right/.test(wrongCode.pendingError), 'a wrong code stays on the code row with the reason: ' + JSON.stringify(wrongCode));
  await evaluate(`document.getElementById('account-code').value = '123456'; true`);
  await evaluate(`document.getElementById('account-code').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); true`);
  await settle();
  await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  assert.deepStrictEqual(accountCalls.slice(1), [['verify', '', '000000'], ['verify', '', '123456']], 'Enter submits the code once');
  const signedIn = await accountView();
  assert.ok(signedIn.in && !signedIn.pending, 'the right code shows the account: ' + JSON.stringify(signedIn));
  assert.strictEqual(signedIn.email, 'me@example.com');
  assert.ok(/^Pro until .*75 of 600 cloud credits/.test(signedIn.plan), 'the plan and cloud credits are spelled out: ' + signedIn.plan);
  assert.ok(/^Checked /.test(signedIn.status), signedIn.status);
  assert.deepStrictEqual([signedIn.first, signedIn.last, signedIn.initials, signedIn.photo, signedIn.pro], ['Me', 'Tester', 'MT', false, true],
    'the profile card shows the names and initials in place of a photo, gilded for Pro');
  assert.strictEqual(await evaluate("document.getElementById('profile-email').tagName + ':' + getComputedStyle(document.getElementById('profile-email')).userSelect"), 'DIV:none',
    'the email is plain text that cannot be selected or edited');
  await click('#profile-first');
  await evaluate(`(() => { const f = document.getElementById('profile-first'); f.dispatchEvent(new FocusEvent('focus')); f.value = ' Sounak '; f.dispatchEvent(new FocusEvent('blur')); })(); true`);
  await waitFor("document.getElementById('profile-avatar-initials').textContent === 'ST'");
  assert.deepStrictEqual(accountCalls.at(-1), ['profile', { firstName: 'Sounak', lastName: 'Tester' }], 'leaving a name field saves the trimmed names');
  await evaluate(`(() => { const f = document.getElementById('profile-first'); f.dispatchEvent(new FocusEvent('focus')); f.dispatchEvent(new FocusEvent('blur')); })(); true`);
  await settle();
  assert.strictEqual(accountCalls.filter(c => c[0] === 'profile').length, 1, 'an unchanged field saves nothing');
  payload = { ...payload, accountAvatar: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=' };
  win.webContents.send('history-updated', payload);
  await waitFor("!document.getElementById('profile-avatar-img').hidden");
  assert.strictEqual((await accountView()).photo, true, 'a photo from main replaces the initials');
  payload = { ...payload, accountAvatar: '' };
  win.webContents.send('history-updated', payload);
  await settle();
  assert.strictEqual(await evaluate(`document.getElementById('account-code').value`), '', 'the code field is cleared after use');
  assert.strictEqual(await evaluate(`document.getElementById('sidebar-credits').hidden`), false, 'Pro shows the credit meter');
  assert.ok(/525 credits left/.test(await evaluate(`document.getElementById('sidebar-credits-count').textContent`)), 'the meter uses remaining credits');

  // --- Voxden Pro card: Pro manages, Free is offered the prices ------------
  const upgradeView = () => evaluate(`({ hidden: accountUpgradeEl.hidden, hint: accountUpgradeHintEl.textContent,
    manage: accountManageActionsEl.hidden, buttons: Array.from(accountUpgradeOptionsEl.querySelectorAll('button'), b => b.textContent),
    error: accountUpgradeErrorEl.hidden ? '' : accountUpgradeErrorEl.textContent })`);
  const proCard = await upgradeView();
  assert.ok(!proCard.hidden && !proCard.manage && proCard.buttons.length === 0, 'a Pro user sees Manage and no prices: ' + JSON.stringify(proCard));
  assert.ok(/Paid access through/.test(proCard.hint), proCard.hint);
  await click('#account-open-billing');
  assert.strictEqual(await evaluate(`document.querySelector('.settings-panel[data-cat="billing"]').hidden`), false);
  // --- Manage subscription: the facts, and cancelling renewal -----------------
  const manageBefore = accountCalls.length;
  await click('#account-manage-billing');
  await waitFor("document.getElementById('subscription-dialog').open && document.getElementById('subscription-provider').textContent === 'Razorpay'");
  assert.deepStrictEqual(accountCalls.slice(manageBefore), [['billing']], 'Manage opens the dialog and refreshes the subscription from the service');
  const subscriptionView = () => evaluate(`({ price: document.getElementById('subscription-price').textContent,
    through: document.getElementById('subscription-through').textContent, renewal: document.getElementById('subscription-renewal').textContent,
    credits: document.getElementById('subscription-credits').textContent, cancelHidden: document.getElementById('subscription-cancel').hidden,
    portalHidden: document.getElementById('subscription-portal').hidden, note: document.getElementById('subscription-note').textContent })`);
  const active = await subscriptionView();
  assert.strictEqual(active.price, '₹349 / month');
  assert.match(active.renewal, /^Renews automatically on /, active.renewal);
  assert.match(active.credits, /75 of 600 used this month/, active.credits);
  assert.ok(!active.cancelHidden && !active.portalHidden, 'an active subscription offers Cancel renewal and the payment portal: ' + JSON.stringify(active));
  assert.match(active.note, /stops the next charge only/, active.note);
  await click('#subscription-cancel');
  assert.strictEqual(await evaluate("document.getElementById('confirm-title').textContent"), 'Cancel renewal?', 'cancelling asks first');
  assert.match(await evaluate("document.getElementById('confirm-body').textContent"), /stays on until .* then the account returns to Free/, 'and says what the user keeps');
  await click('#confirm-cancel');
  assert.strictEqual(accountCalls.filter(c => c[0] === 'cancel-subscription').length, 0, 'backing out cancels nothing');
  await click('#subscription-cancel');
  await click('#confirm-ok');
  await waitFor("document.getElementById('subscription-renewal').textContent.startsWith('Cancelled')");
  assert.deepStrictEqual(accountCalls.at(-1), ['cancel-subscription'], 'confirming asks main to cancel renewal');
  const cancelledView = await subscriptionView();
  assert.ok(cancelledView.cancelHidden, 'once cancelled there is nothing more to cancel');
  assert.match(cancelledView.note, /keep everything in Pro until/, cancelledView.note);
  assert.match((await upgradeView()).hint, /Renewal cancelled; paid access through/, 'the card says renewal is off');
  const portalBefore = accountCalls.length;
  await click('#subscription-portal');
  await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  assert.deepStrictEqual(accountCalls.slice(portalBefore), [['manage']], 'Payment details opens the provider portal through main');
  await click('#subscription-close');
  assert.strictEqual(await evaluate("document.getElementById('subscription-dialog').open"), false);
  payload = { ...payload, account: { ...accountBase, signedIn: true, email: 'me@example.com', plan: 'free', checkedAt: Date.now() } };
  win.webContents.send('history-updated', payload);
  await settle();
  await waitFor('accountUpgradeOptionsEl.querySelector("button").textContent === "Get Pro"');
  const freeCard = await upgradeView();
  assert.deepStrictEqual(freeCard.buttons, ['Get Pro'], 'monthly has one purchase action even with a legacy server annual offer');
  assert.strictEqual(await evaluate(`document.getElementById('billing-price-amount').textContent`), '₹349');
  assert.strictEqual(await evaluate(`document.getElementById('billing-cloud-benefit').textContent`), '600 cloud credits per month', 'the offer reflects the server entitlement');
  assert.ok(/Cancel renewal anytime/.test(freeCard.hint), freeCard.hint);
  assert.ok(accountCalls.some(c => c[0] === 'billing-options'), 'prices were fetched once the card showed');

  // --- Free: the week's words, on the sidebar meter and on the Free card ---
  const wordMeter = () => evaluate(`({ hidden: document.getElementById('sidebar-credits').hidden,
    words: document.getElementById('sidebar-credits').classList.contains('is-words'),
    kicker: document.getElementById('sidebar-credits-kicker').textContent,
    count: document.getElementById('sidebar-credits-count').textContent,
    coins: document.getElementById('sidebar-credits-coins').hidden,
    pages: document.getElementById('sidebar-credits-words').hidden,
    cap: document.getElementById('billing-free-words').textContent,
    usage: document.getElementById('billing-free-usage').textContent,
    spent: document.getElementById('billing-free-usage').classList.contains('is-error') })`);
  const week = { cap: 900, used: 720, remaining: 180, percent: 80, exhausted: false,
    started: true, periodStart: Date.now(), periodEnd: Date.now() + 3 * 86400e3, resetsOn: '2026-09-19' };
  payload = { ...payload, freeWords: week };
  win.webContents.send('history-updated', payload);
  await settle();
  const running = await wordMeter();
  assert.ok(!running.hidden && running.words && running.kicker === 'Free words', 'Free gets the word meter, not the coins: ' + JSON.stringify(running));
  assert.ok(running.coins && !running.pages, 'the gold coins stay with the credits: ' + JSON.stringify(running));
  assert.strictEqual(running.count, '180 words left');
  assert.strictEqual(running.cap, '900 words a week', 'the card advertises the cap the service set');
  assert.ok(/720 of 900 used, back on 2026-09-19/.test(running.usage) && !running.spent, running.usage);

  payload = { ...payload, freeWords: { ...week, used: 900, remaining: 0, percent: 100, exhausted: true } };
  win.webContents.send('history-updated', payload);
  await settle();
  const usedUp = await wordMeter();
  assert.strictEqual(usedUp.count, '0 words left');
  assert.ok(usedUp.spent && /Used up until 2026-09-19/.test(usedUp.usage), 'a spent week says so on the card: ' + JSON.stringify(usedUp));
  assert.strictEqual(await evaluate(`document.getElementById('sidebar-credits').classList.contains('is-critical')`), true, 'and the meter runs red');
  await category('account');
  assert.ok(/900 of 900 words used this week, back on 2026-09-19/.test((await accountView()).plan), (await accountView()).plan);
  await category('billing');

  payload = { ...payload, freeWords: null };
  win.webContents.send('history-updated', payload);
  await settle();
  assert.strictEqual((await wordMeter()).hidden, true, 'no meter until main has measured the week');
  // Review both the desktop and minimum supported billing layouts. The
  // purchase button must remain reachable, and no legacy annual CTA leaks.
  for (const [width, height] of [[1120, 760], [640, 440]]) {
    win.setContentSize(width, height);
    await delay(150);
    await evaluate(`document.querySelector('.settings-detail').scrollTop = 0; true`);
    assert.ok(await evaluate(`(() => { const pane = document.querySelector('.settings-detail'); return pane.scrollWidth <= pane.clientWidth + 1; })()`), 'billing fits at ' + width);
    assert.strictEqual(await evaluate(`document.querySelectorAll('#account-upgrade-options [data-plan="annual"]').length`), 0);
    fs.mkdirSync(path.join(__dirname, '../temp/ui-review'), { recursive: true });
    win.webContents.invalidate();
    await delay(100);
    fs.writeFileSync(path.join(__dirname, '../temp/ui-review/billing-' + width + '.png'), (await win.webContents.capturePage()).toPNG());
    assert.ok(await evaluate(`(() => {
      const button = accountUpgradeOptionsEl.querySelector('button'); button.scrollIntoView({ block: 'center' });
      const box = button.getBoundingClientRect(); return button.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
    })()`), 'billing purchase action is reachable at ' + width);
  }
  win.setContentSize(1120, 760);
  await delay(100);
  await evaluate(`document.querySelector('.settings-detail').scrollTop = 0; true`);
  // Older services can still return an annual offer, but cannot make this
  // client purchase it. A stale monthly price must also stay unpurchasable.
  billingOptions[0].plans[0].label = '₹299 / month';
  payload.account.billing = { options: billingOptions };
  win.webContents.send('history-updated', payload);
  await settle();
  assert.strictEqual(await evaluate(`accountUpgradeOptionsEl.querySelector('button').disabled`), true, 'a stale monthly price cannot be purchased');
  billingOptions[0].plans[0].label = '₹349 / month';
  win.webContents.send('history-updated', payload);
  await settle();
  await evaluate(`billingRegionEl.value = 'lemonsqueezy'; billingRegionEl.dispatchEvent(new Event('change')); true`);
  assert.strictEqual(await evaluate(`document.getElementById('billing-price-amount').textContent`), '$8', 'the selected region determines the displayed currency');
  await evaluate(`billingRegionEl.value = 'razorpay'; billingRegionEl.dispatchEvent(new Event('change')); true`);
  const checkoutBefore = accountCalls.length;
  await click('#account-upgrade-options button');
  await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  assert.deepStrictEqual(accountCalls.slice(checkoutBefore), [['checkout', 'razorpay', 'monthly']], 'the action asks main for the monthly checkout');
  const pendingCard = await upgradeView();
  assert.ok(/Confirming payment/.test(pendingCard.hint) && pendingCard.buttons.length === 1, 'a pending checkout explains itself: ' + JSON.stringify(pendingCard));
  assert.strictEqual(await evaluate('accountUpgradeOptionsEl.querySelector("button").disabled'), true, 'pending payment cannot launch another checkout');
  payload = { ...payload, account: { ...accountBase, signedIn: true, email: 'me@example.com', plan: 'pro', planExpiresAt: '2027-01-01T00:00:00.000Z',
    cloud: { hoursUsed: 1.25, hoursCap: 10, periodEnd: 'p' }, checkedAt: Date.now() } };
  win.webContents.send('history-updated', payload);
  await settle();
  await category('account');
  await click('#account-refresh');
  await click('#account-sign-out');
  await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  assert.deepStrictEqual(accountCalls.slice(-2), [['refresh'], ['signout']]);
  assert.deepStrictEqual(await accountView().then(v => [v.out, v.in]), [true, false], 'sign-out returns to the email row');
  payload = { ...payload, account: { ...accountBase, signedIn: true, email: 'me@example.com', plan: 'free', stale: true, checkedAt: 1, tokenProtected: false } };
  win.webContents.send('history-updated', payload);
  await settle();
  const staleView = await accountView();
  assert.ok(/could not be checked for over a week/.test(staleView.plan), 'a stale plan explains itself: ' + staleView.plan);
  assert.ok(/cannot encrypt/.test(staleView.status), 'an unprotected token is disclosed: ' + staleView.status);
  payload = { ...payload, account: { ...accountBase } };
  win.webContents.send('history-updated', payload);
  await settle();
  await category('speech-engines');

  const publishAccount = async (account, extra) => {
    payload = { ...payload, ...(extra || {}), account };
    win.webContents.send('history-updated', payload);
    await settle();
  };

  // --- Voxden Cloud: armed only for Pro, always says audio leaves the PC ---
  const cloudView = () => evaluate(`({ checked: settingInputs.cloudTranscription.checked, disabled: settingInputs.cloudTranscription.disabled,
    hint: cloudHintEl.textContent, status: cloudStatusEl.hidden ? '' : cloudStatusEl.textContent })`);
  const cloudFree = await cloudView();
  assert.ok(cloudFree.disabled && !cloudFree.checked, 'signed out, the toggle is off and locked: ' + JSON.stringify(cloudFree));
  assert.ok(/Audio leaves your PC/.test(cloudFree.hint) && /sign in under Account/.test(cloudFree.hint), cloudFree.hint);
  await publishAccount({ ...accountBase, signedIn: true, email: 'me@example.com', plan: 'pro',
    cloud: { hoursUsed: 2.5, hoursCap: 10, periodEnd: 'p' }, checkedAt: Date.now() });
  const cloudPro = await cloudView();
  assert.ok(!cloudPro.disabled && /150 of 600 cloud credits/.test(cloudPro.hint), 'Pro unlocks the toggle and shows the credits: ' + JSON.stringify(cloudPro));
  assert.match(cloudPro.hint, /Voxden Cloud transcribes completed phrases as you speak/,
    'the Voxden Cloud option explains work done during recording');
  const cloudPatches = settingsPatches.length;
  await click('#cloud-row .toggle');
  assert.deepStrictEqual(settingsPatches.slice(cloudPatches), [{ cloudTranscription: true }], 'the toggle saves one boolean');
  await publishAccount(payload.account, { cloudTranscription: true, cloudStatus: { lastResult: 'cloud', lastError: '', lastMs: 640, count: 1 } });
  assert.strictEqual((await cloudView()).status, 'Last cloud request: 0.6 s.',
    'request timing is reported without presenting it as stop-to-paste latency');
  await publishAccount(payload.account, { cloudStatus: { lastResult: 'cloud-segments', lastError: '', lastMs: 370, count: 2 } });
  assert.strictEqual((await cloudView()).status, 'Last cloud request: 0.4 s. Phrases were transcribed during recording.',
    'completed phrase requests explain their during-recording route');
  for (const [code, reason] of [
    ['timeout', /Voxden Cloud waited too long.*Retry/],
    ['network', /Voxden Cloud could not be reached.*retry/],
    ['unconfigured', /Voxden Cloud is not configured/],
    ['upstream', /Voxden Cloud could not transcribe.*Try again/],
  ]) {
    await publishAccount(payload.account, { cloudStatus: { lastResult: 'error', lastError: code } });
    const status = (await cloudView()).status;
    assert.match(status, reason, 'a cloud error gives its reason and recovery: ' + code);
    assert.doesNotMatch(status, /fall(?:ing|en)? back|transcribed locally|local engine/i,
      'cloud errors never claim a local fallback: ' + code);
  }
  await publishAccount({ ...accountBase }, { cloudTranscription: true, cloudStatus: { lastResult: 'skipped', lastError: 'signed-out' } });
  const cloudStuck = await cloudView();
  assert.ok(cloudStuck.checked && !cloudStuck.disabled, 'a user who turned it on can still turn it off after signing out: ' + JSON.stringify(cloudStuck));
  assert.match(cloudStuck.status, /Sign in under Account to use Voxden Cloud/);
  await publishAccount({ ...accountBase }, { cloudTranscription: false, cloudStatus: { lastResult: '', lastError: '' } });

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

  // The upgrade card: a fresh install starts on Parakeet, and the 4.7 GB model
  // is offered from here as one click that downloads and switches. It is not
  // repeated in the extras list below, and it is gone once Qwen is in use.
  const upgradePlan = (installed, language) => require('../src/model-plan').plan({
    engine: 'parakeet', device: 'auto', language: language || 'en',
    sizes: { whisper: 3.1e9, 'qwen3-asr': 4.7e9, parakeet: 0.66e9, 'parakeet-fp32': 2.51e9 },
    installed: Object.assign({ parakeet: true }, installed || {}),
  });
  win.webContents.send('history-updated', { ...payload, ...cloudLanguagePayload(false), asrEngine: 'parakeet', asrOperation: null,
    asrRuntimeState: { status: 'idle' }, dictationLanguage: 'en', dictationLanguages: ['en'], modelPlan: upgradePlan() });
  await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const upgradeOffer = await evaluate(`({ hidden: qwenUpgradeCardEl.hidden, hint: qwenUpgradeHintEl.textContent,
    install: qwenUpgradeInstallBtn.hidden ? null : qwenUpgradeInstallBtn.textContent,
    switchHidden: qwenUpgradeSwitchBtn.hidden, removeHidden: qwenUpgradeRemoveBtn.hidden,
    extras: Array.from(speechExtrasEl.querySelectorAll('.speech-extra-name'), el => el.textContent),
    langHint: dictationLangHintEl.textContent })`);
  assert.strictEqual(upgradeOffer.hidden, false, 'the upgrade card shows under Parakeet');
  assert.strictEqual(upgradeOffer.install, 'Download Qwen3-ASR (4.7 GB) and switch', 'one click, priced');
  assert.ok(upgradeOffer.switchHidden && upgradeOffer.removeHidden, 'nothing to switch to or remove yet');
  assert.ok(/nothing leaves it/.test(upgradeOffer.hint), 'the card says it stays local: ' + upgradeOffer.hint);
  assert.ok(!upgradeOffer.extras.some(n => /Qwen/.test(n)), 'Qwen is not offered twice: ' + JSON.stringify(upgradeOffer.extras));
  assert.ok(/English on this PC/.test(upgradeOffer.langHint) && !/Parakeet/.test(upgradeOffer.langHint), 'English on Parakeet needs no warning: ' + upgradeOffer.langHint);
  extraInstalls = [];
  await click('#qwen-upgrade-install');
  await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  assert.deepStrictEqual(extraInstalls, [['qwen3-asr', { select: true }]], 'the card asks for the download and the switch together');

  // Extra languages need Cloud, not a local engine switch. Saved Hindi on a
  // Pro account with Cloud off is kept, but the row says English locally.
  win.webContents.send('history-updated', { ...payload, ...cloudLanguagePayload(false),
    account: cloudLanguagePayload(true).account, asrEngine: 'parakeet', asrOperation: null,
    asrRuntimeState: { status: 'idle' }, engineStatus: 'standby', dictationLanguage: 'en', dictationLanguages: ['hi'],
    cloudTranscription: false, dictationLanguageUnlocked: false, modelPlan: upgradePlan({}, 'hi') });
  await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const hindi = await evaluate('({ hint: qwenUpgradeHintEl.textContent, langHint: dictationLangHintEl.textContent, engineHint: asrEngineHintEl.textContent })');
  assert.ok(/names, accents/.test(hindi.hint) && !/Parakeet cannot recognise/.test(hindi.hint), hindi.hint);
  assert.ok(/Local dictation is English/.test(hindi.langHint) && /Hindi/.test(hindi.langHint), hindi.langHint);
  assert.ok(/Local dictation is English/.test(hindi.engineHint), 'the engine row says so too: ' + hindi.engineHint);
  win.webContents.send('history-updated', { ...payload, ...cloudLanguagePayload(false),
    account: cloudLanguagePayload(true).account, asrEngine: 'parakeet', cloudTranscription: false,
    dictationLanguageUnlocked: false, asrOperation: null, asrRuntimeState: { status: 'idle' }, engineStatus: 'standby',
    dictationLanguages: ['en', 'hg'], modelPlan: upgradePlan({}, 'en') });
  await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const mixedHint = await evaluate('dictationLangHintEl.textContent');
  assert.ok(/Local dictation is English/.test(mixedHint) && /Hinglish/.test(mixedHint), mixedHint);

  // Downloaded but not in use: switch or remove, no second download.
  win.webContents.send('history-updated', { ...payload, asrEngine: 'parakeet', asrOperation: null,
    asrRuntimeState: { status: 'idle' }, dictationLanguage: 'en', dictationLanguages: ['en'], modelPlan: upgradePlan({ 'qwen3-asr': true }) });
  await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const upgradeReady = await evaluate('({ install: qwenUpgradeInstallBtn.hidden, switchHidden: qwenUpgradeSwitchBtn.hidden, removeHidden: qwenUpgradeRemoveBtn.hidden })');
  assert.deepStrictEqual(upgradeReady, { install: true, switchHidden: false, removeHidden: false });
  const patchesBefore = settingsPatches.length;
  await click('#qwen-upgrade-switch');
  await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  assert.deepStrictEqual(settingsPatches.slice(patchesBefore), [{ asrEngine: 'qwen3-asr' }], 'Switch sets the engine and nothing else');
  assert.strictEqual(await evaluate('qwenUpgradeCardEl.hidden'), true, 'the card leaves once Qwen is the engine');
  win.webContents.send('history-updated', { ...payload, asrEngine: 'parakeet', asrOperation: null,
    asrRuntimeState: { status: 'idle' }, modelPlan: upgradePlan({ 'qwen3-asr': true }) });
  await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  await click('#qwen-upgrade-remove');
  assert.strictEqual(await evaluate("document.getElementById('confirm-title').textContent"), 'Remove Qwen3-ASR 1.7B?');
  await click('#confirm-ok');
  assert.deepStrictEqual(actionCalls.at(-1), ['speech-model-remove', 'qwen3-asr']);
  win.webContents.send('history-updated', payload);
  await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');

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
    ['speech-model-remove', 'whisper'], ['speech-model-remove', 'qwen3-asr'],
    ['cuda-pack-install'], ['cuda-pack-cancel'], ['cuda-pack-remove'],
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
        ? ['#shortcuts-change', '#mode-toggle', '#mode-ptt', '#quality-auto', '#quality-fast', '#quality-accurate', '.custom-select:has(#mic-select) .custom-select-trigger']
        : ['.custom-select:has(#asr-engine-select) .custom-select-trigger', '.custom-select:has(#asr-device-select) .custom-select-trigger', '#speech-setup-install', '#speech-setup-remove', '#gpu-remove', '#tuned-row .toggle'];
      for (const selector of selectors) assert.ok(await reachable(selector), selector + ' at ' + width);
      if (cat === 'general') {
        assert.ok(await reachable('#dictation-lang-open', true), 'dictation language summary is visible at ' + width);
        assert.ok(await reachable('.custom-select:has(#app-lang-select) .custom-select-trigger', true), 'English-only app language is visible');
      }
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
        for (const id of (cat === 'general' ? ['mic-select'] : ['asr-engine-select', 'asr-device-select'])) {
          const wrap = '.custom-select:has(#' + id + ')';
          await click(wrap + ' .custom-select-trigger');
          // Opening the selected option can scroll its ancestors. The scroll
          // handler then repositions the list; offscreen CI can deliver that
          // event after settle()'s frame fallback. Observe the final geometry
          // without calling production positioning code from the test.
          let bounds;
          const until = Date.now() + 3000;
          do {
            bounds = await evaluate(`(() => {
              const list = document.querySelector('${wrap} .custom-select-list').getBoundingClientRect();
              const pane = document.querySelector('.settings-detail').getBoundingClientRect();
              return { list: list.toJSON(), pane: pane.toJSON(),
                fits: list.height > 0 && list.top >= pane.top && list.bottom <= pane.bottom && list.left >= pane.left && list.right <= pane.right };
            })()`);
            if (bounds.fits) break;
            await delay(30);
          } while (Date.now() < until);
          assert.ok(bounds.fits, id + ' dropdown fits inside settings at ' + width + ': ' + JSON.stringify(bounds));
          await capture(id + '-' + width + '-open');
          const options = await evaluate(`Array.from(document.querySelectorAll('${wrap} .custom-select-option')).map(el => el.dataset.value)`);
          for (const value of options) assert.ok(await reachable(wrap + ' .custom-select-option[data-value="' + value + '"]'), id + ' option ' + value + ' at ' + width);
          await evaluate('closeAllCustomSelects(); true');
        }
      }
    }
  }
  // --- Help menu ----------------------------------------------------------
  // The sidebar's Help button is a menu: what is new, the quick checks, the
  // setup guide and feedback. Each item closes the menu and opens its thing.
  await evaluate('closeSettings(); true');
  await click('#nav-help');
  assert.strictEqual(await evaluate("document.getElementById('help-menu').hidden"), false, 'Help opens its menu');
  assert.deepStrictEqual(await evaluate(`Array.from(document.querySelectorAll('#help-menu .help-menu-item .help-menu-text')).map(el => el.textContent)`),
    ["What's new", 'Shortcuts', 'Microphone check', 'Dictation languages', 'Setup guide', 'Feedback or bug report']);
  await click('#help-microphone');
  assert.strictEqual(await evaluate("document.getElementById('help-menu').hidden"), true, 'choosing an item closes the menu');
  // The microphone tests above left three simulated devices and USB selected.
  await waitFor("document.querySelectorAll('#mic-list .mic-row').length === 3");
  assert.deepStrictEqual(await evaluate(`Array.from(document.querySelectorAll('#mic-list .mic-row-name')).map(el => el.textContent)`),
    ['Built-in microphone', 'USB Headset', 'Desk microphone'], 'every microphone is listed');
  assert.strictEqual(await evaluate(`document.querySelector('#mic-list .mic-row[aria-checked="true"]').dataset.id`), 'usb',
    'the device in use is marked');
  await waitFor(`Array.from(document.querySelectorAll('#mic-list .mic-row-state')).every(el => el.textContent !== 'Opening…')`);
  const stopsBefore = await evaluate('micTest.stops');
  await click('#mic-dialog-close');
  assert.strictEqual(await evaluate("document.getElementById('mic-dialog').open"), false, 'Done closes the check');
  assert.ok(await evaluate('micTest.stops') >= stopsBefore + 3, 'closing the check releases every microphone it opened');

  await click('#nav-help');
  await click('#help-feedback');
  assert.strictEqual(await evaluate("document.getElementById('feedback-dialog').open"), true, 'feedback opens its dialog');
  await click('#feedback-send');
  assert.match(await evaluate("document.getElementById('feedback-status').textContent"), /few words/, 'an empty report is refused in place');
  await evaluate(`document.getElementById('feedback-text').value = 'The flow bar vanished.'; true`);
  await click('#feedback-kind [data-kind="idea"]');
  await click('#feedback-send');
  await waitFor("document.getElementById('feedback-status').textContent.startsWith('Thanks')");
  assert.deepStrictEqual(feedbackReports.at(-1), { kind: 'idea', message: 'The flow bar vanished.', email: '', includeDetails: true },
    'the report carries the kind, the words, and the details choice');
  await waitFor("!document.getElementById('feedback-dialog').open");
  feedbackReply = { ok: false, error: 'Boom', fallback: true };
  await click('#nav-help');
  await click('#help-feedback');
  await evaluate(`document.getElementById('feedback-text').value = 'Again'; true`);
  await click('#feedback-send');
  await waitFor("!document.getElementById('feedback-github').hidden");
  assert.match(await evaluate("document.getElementById('feedback-status').textContent"), /Boom.*GitHub/, 'a failed send offers GitHub');
  await click('#feedback-cancel');
  assert.strictEqual(await evaluate("document.getElementById('feedback-dialog').open"), false);

  await click('#nav-help');
  await click('#help-guide');
  assert.strictEqual(await evaluate('view'), 'help', 'Setup guide shows the help pane');
  await click('#nav-help');
  await click('#help-shortcuts');
  assert.strictEqual(await evaluate("document.getElementById('shortcuts-dialog').open"), true, 'Shortcuts opens the shortcuts dialog');
  await evaluate('closeShortcutsDialog(); true');
  await click('#nav-help');
  await click('#help-languages');
  if (await evaluate('dictationLanguagesUnlocked(lastPayload || {})')) {
    assert.strictEqual(await evaluate("document.getElementById('dictation-lang-dialog').open"), true, 'with languages unlocked, the item opens the picker');
    await evaluate('closeDictationLangDialog(); true');
  } else {
    assert.strictEqual(await evaluate('settingsOpen'), true, 'with languages locked, the item opens General settings');
    await evaluate('closeSettings(); true');
  }

  // --- The account button at the foot of the sidebar ---------------------------
  await evaluate('closeSettings(); true');
  payload = { ...payload, signInRequired: false, account: { ...accountBase, signedIn: true, email: 'me@example.com', plan: 'pro', planExpiresAt: '2027-01-01T00:00:00.000Z',
    cloud: { hoursUsed: 1.25, hoursCap: 10, periodEnd: '2026-10-01T00:00:00.000Z' }, checkedAt: Date.now(), profile: { firstName: 'Me', lastName: 'Tester', pictureUrl: '' } } };
  win.webContents.send('history-updated', payload);
  await settle();
  assert.strictEqual(await evaluate("document.getElementById('account-btn').hidden"), false, 'a signed-in account shows its avatar in the title bar');
  assert.strictEqual(await evaluate("document.getElementById('account-btn').classList.contains('is-pro')"), true, 'Pro gets the gold ring');
  await click('#account-btn');
  assert.strictEqual(await evaluate("document.getElementById('account-menu').hidden"), false, 'the avatar opens the account sheet');
  assert.deepStrictEqual(await evaluate(`[document.getElementById('account-menu-name').textContent, document.getElementById('account-menu-email').textContent,
    document.getElementById('account-menu-plan').textContent, document.getElementById('account-menu-banner').classList.contains('is-pro')]`),
    ['Me Tester', 'me@example.com', 'VOXDEN PRO · 525 credits left', true], 'the sheet says who, the address, and the plan with credits left');
  await click('#account-menu-manage');
  assert.strictEqual(await evaluate("document.getElementById('account-menu').hidden && settingsOpen && settingsCat === 'account'"), true, 'Manage account opens the Account page');
  await evaluate('closeSettings(); true');
  await click('#sidebar-toggle');
  await settle();
  assert.strictEqual(await evaluate(`(() => { const t = document.getElementById('sidebar-toggle').getBoundingClientRect();
    const s = document.getElementById('sidebar').getBoundingClientRect();
    return Math.abs(t.left + t.width / 2 - (s.left + s.width / 2)) < 2; })()`), true,
    'collapsed, the toggle sits in the middle of the rail');
  assert.strictEqual(await evaluate(`(() => { const a = document.getElementById('account-btn').getBoundingClientRect(); const b = document.getElementById('notif-btn').getBoundingClientRect();
    return a.left > b.right && Math.abs((a.top + a.height / 2) - (b.top + b.height / 2)) < 2 && a.width <= 28; })()`), true,
    'the avatar is a small button right beside the bell');
  await click('#sidebar-toggle');
  await settle();

  // --- Delete account: asks first, then the gate returns ----------------------
  payload = { ...payload, signInRequired: false, account: { ...accountBase, signedIn: true, email: 'me@example.com', checkedAt: Date.now(), profile: { firstName: 'Me', lastName: 'Tester', pictureUrl: '' } } };
  win.webContents.send('history-updated', payload);
  await settle();
  await click('#nav-settings');
  await category('account');
  await click('#account-delete');
  assert.strictEqual(await evaluate("document.getElementById('confirm-title').textContent"), 'Delete your account?', 'deletion asks first');
  assert.match(await evaluate("document.getElementById('confirm-body').textContent"), /me@example\.com.*cannot be undone/, 'and names the account');
  await click('#confirm-cancel');
  assert.strictEqual(accountCalls.filter(c => c[0] === 'delete').length, 0, 'backing out deletes nothing');
  await click('#account-delete');
  await click('#confirm-ok');
  await waitFor("document.getElementById('signin-gate').open");
  assert.strictEqual(accountCalls.filter(c => c[0] === 'delete').length, 1, 'confirming asks main to delete the account, once');
  payload = { ...payload, signInRequired: false, account: { ...accountBase, signedIn: true, email: 'me@example.com', checkedAt: Date.now() } };
  win.webContents.send('history-updated', payload);
  await waitFor("!document.getElementById('signin-gate').open");

  // --- The sign-in gate: nothing else until there is an account ---------------
  await evaluate('closeSettings(); true');
  payload = { ...payload, signInRequired: true, localModelChosen: false, account: { ...accountBase } };
  win.webContents.send('history-updated', payload);
  await waitFor("document.getElementById('signin-gate').open");
  assert.strictEqual(await evaluate("document.getElementById('model-welcome').open"), false, 'the model choice waits behind the gate');
  assert.ok(await reachable('#signin-google') && await reachable('#signin-send'), 'the gate offers Google and the emailed code');
  const gateView = () => evaluate(`({ out: !document.getElementById('signin-view-out').hidden, code: !document.getElementById('signin-view-code').hidden,
    google: !document.getElementById('signin-view-google').hidden,
    error: document.getElementById('signin-error').hidden ? '' : document.getElementById('signin-error').textContent,
    codeError: document.getElementById('signin-code-error').hidden ? '' : document.getElementById('signin-code-error').textContent,
    hint: document.getElementById('signin-code-hint').textContent })`);
  await evaluate(`document.getElementById('signin-email').value = 'Me@Example.com'; true`);
  await click('#signin-send');
  await waitFor("!document.getElementById('signin-view-code').hidden");
  assert.deepStrictEqual(accountCalls.at(-1), ['code', 'Me@Example.com'], 'Send me a code asks main for a code');
  assert.match((await gateView()).hint, /sent a six-digit code to me@example\.com/);
  await evaluate(`document.getElementById('signin-code').value = '000000'; true`);
  await click('#signin-verify');
  await waitFor("!document.getElementById('signin-code-error').hidden");
  assert.match((await gateView()).codeError, /not right/, 'a wrong code is explained in place');
  await click('#signin-back');
  await waitFor("!document.getElementById('signin-view-out').hidden");
  await click('#signin-google');
  await waitFor("!document.getElementById('signin-view-google').hidden");
  assert.strictEqual(accountCalls.at(-1)[0], 'google', 'Continue with Google asks main to start the browser flow');
  await waitFor("!document.getElementById('signin-gate').open");
  assert.strictEqual(await evaluate("document.getElementById('model-welcome').open"), true, 'once signed in, the model choice takes its turn');
  await evaluate("document.getElementById('model-welcome').close(); true");
  payload = { ...payload, signInRequired: true, localModelChosen: true, account: { ...accountBase } };
  win.webContents.send('history-updated', payload);
  await waitFor("document.getElementById('signin-gate').open");
  googleOutcome = 'cancelled';
  await click('#signin-google');
  await waitFor("!document.getElementById('signin-view-google').hidden");
  await click('#signin-google-cancel');
  await waitFor("!document.getElementById('signin-view-out').hidden && !document.getElementById('signin-error').hidden");
  assert.match((await gateView()).error, /cancelled/, 'cancelling Google says so and returns to the choices');
  await evaluate(`document.getElementById('signin-gate').dispatchEvent(new Event('cancel', { cancelable: true })); true`);
  assert.strictEqual(await evaluate("document.getElementById('signin-gate').open"), true, 'Escape does not dismiss the gate');
  payload = { ...payload, signInRequired: false, account: { ...accountBase, signedIn: true, email: 'me@example.com', checkedAt: Date.now() } };
  win.webContents.send('history-updated', payload);
  await waitFor("!document.getElementById('signin-gate').open");

  assert.deepStrictEqual(errors, [], 'no renderer/preload errors after exercising all settings');
  clearTimeout(deadline);
  console.log('all speech setup renderer tests passed');
  win.destroy();
  app.quit();
}).catch(err => { console.error(err); app.exit(1); });
