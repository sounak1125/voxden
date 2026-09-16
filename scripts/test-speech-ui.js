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
let rejectNextSettings = false;
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
    sizes: { whisper: 3.1e9, 'whisper-turbo': 1.62e9, 'qwen3-asr': 4.7e9, parakeet: 0.66e9, 'parakeet-fp32': 2.51e9 },
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
  if (rejectNextSettings) { rejectNextSettings = false; throw new Error('Expected General save failure'); }
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
          cloud: { hoursUsed: 1.25, hoursCap: 15, periodEnd: '2026-10-01T00:00:00.000Z' }, checkedAt: Date.now() }
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
      cloud: { hoursUsed: 1.25, hoursCap: 15, periodEnd: '2026-10-01T00:00:00.000Z' }, checkedAt: Date.now(),
      profile: { firstName: 'Me', lastName: 'Tester', pictureUrl: '' } }
    : { ...accountBase, pendingEmail: 'me@example.com', lastError: 'That code is not right. Check the email and try again.' } };
  return payload;
});
ipcMain.handle('account-cancel', () => { accountCalls.push(['cancel']); payload = { ...payload, account: { ...accountBase } }; return payload; });
const billingOptions = [
  { provider: 'razorpay', region: 'in', label: 'India', cloudHoursCap: 15, cloudCreditsCap: 900, welcomeCreditsCap: 1200, plans: [{ id: 'monthly', label: '₹349 / month' }, { id: 'annual', label: 'Legacy yearly offer' }] },
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
    if ((lvl === 'error' || Number(lvl) >= 3) && !/Content-Security-Policy|Expected General save failure/.test(String(msg))) errors.push(String(msg));
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
  const frames = () => evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  // Settings > Speech engines. A panel button that cannot act carries
  // aria-disabled rather than disabled, so a focused one keeps its focus
  // mid-download. reachable() only refuses the disabled property, so those
  // buttons are checked through the attribute, and clicking one proves its
  // handler ignores it.
  const row = id => '#speech-model-list [data-engine="' + id + '"]';
  const rowAction = id => row(id) + ' [data-role="action"]';
  const download = key => '#speech-downloads-list [data-key="' + key + '"]';
  const openAdvanced = async () => {
    if (!(await evaluate('speechAdvancedEl.open'))) await click('#speech-advanced > summary');
    assert.strictEqual(await evaluate('speechAdvancedEl.open'), true, 'Advanced opens from its summary');
  };
  const speechSizes = { whisper: 3.1e9, 'whisper-turbo': 1.62e9, 'qwen3-asr': 4.7e9, parakeet: 0.66e9, 'parakeet-fp32': 2.51e9 };
  const speechPlan = (installed, options) => require('../src/model-plan').plan({
    engine: 'qwen3-asr', device: 'auto', language: 'en', sizes: speechSizes, installed: installed || {}, ...(options || {}),
  });
  const rowsView = () => evaluate(`Array.from(document.querySelectorAll('#speech-model-list [data-engine]'), li => {
    const part = role => li.querySelector('[data-role="' + role + '"]');
    const button = part('action');
    return { id: li.dataset.engine, name: li.querySelector('.speech-extra-name').textContent,
      line: part('line').hidden ? null : part('line').textContent,
      size: part('size').hidden ? null : part('size').textContent,
      state: part('state').hidden ? null : part('state').textContent,
      button: button.hidden ? null : button.textContent,
      action: button.hidden ? null : button.dataset.action,
      disabled: button.hidden ? null : button.getAttribute('aria-disabled') === 'true',
      progress: part('progress-row').hidden ? null : part('progress').getAttribute('aria-valuenow'),
      error: part('error').hidden ? null : part('error').textContent,
      errorTone: part('error').hidden ? null : part('error').classList.contains('is-error') };
  })`);
  const noticeView = () => evaluate(`({
    text: speechModelNoticeEl.hidden ? null : speechModelNoticeEl.textContent,
    error: speechModelNoticeEl.hidden ? null : speechModelNoticeEl.classList.contains('is-error'),
    detail: document.getElementById('speech-model-detail').hidden ? null : document.getElementById('speech-model-detail').textContent,
    detailError: document.getElementById('speech-model-detail').hidden ? null : document.getElementById('speech-model-detail').classList.contains('is-error'),
    repair: !document.getElementById('speech-model-notice-actions').hidden,
    list: !speechModelListEl.hidden })`);
  const quietNotice = { text: null, error: null, detail: null, detailError: null, repair: false, list: true };
  const downloadsView = () => evaluate(`({ hidden: document.getElementById('speech-downloads-row').hidden,
    items: Array.from(speechDownloadsListEl.children, li => {
      const part = role => li.querySelector('[data-role="' + role + '"]');
      const remove = part('remove');
      return { key: li.dataset.key, name: part('name').textContent,
        line: part('line').hidden ? null : part('line').textContent,
        size: part('size').hidden ? null : part('size').textContent,
        state: part('state').hidden ? null : part('state').textContent,
        remove: remove.hidden ? null : remove.textContent,
        disabled: remove.hidden ? null : remove.getAttribute('aria-disabled') === 'true' };
    }) })`);
  const gpuView = () => evaluate(`(() => {
    const byId = id => document.getElementById(id);
    return { hidden: speechGpuRowEl.hidden, hint: speechGpuHintEl.textContent,
      hintError: speechGpuHintEl.classList.contains('is-error'),
      action: speechGpuActionBtn.hidden ? null : speechGpuActionBtn.dataset.action,
      kind: speechGpuActionBtn.dataset.kind,
      label: speechGpuActionBtn.hidden ? null : speechGpuActionBtn.textContent,
      disabled: speechGpuActionBtn.getAttribute('aria-disabled') === 'true',
      progress: byId('speech-gpu-progress-row').hidden ? null : byId('speech-gpu-progress').getAttribute('aria-valuenow'),
      note: byId('speech-gpu-note').hidden ? null : byId('speech-gpu-note').textContent,
      error: byId('speech-gpu-error').hidden ? null : byId('speech-gpu-error').textContent,
      errorTone: byId('speech-gpu-error').classList.contains('is-error') };
  })()`);
  const confirmView = () => evaluate(`({ open: document.getElementById('confirm-dialog').open,
    title: document.getElementById('confirm-title').textContent, body: document.getElementById('confirm-body').textContent,
    ok: document.getElementById('confirm-ok').textContent })`);
  const panelText = () => evaluate(`document.querySelector('.settings-panel[data-cat="speech-engines"]').innerText`);
  // Paints one snapshot straight through render(), for the state tables.
  const paint = snapshot => evaluate('render(' + JSON.stringify(snapshot) + '); true');
  await waitFor('!!lastPayload');
  await delay(1250); // Let the deferred startup enumeration finish before counting visits.
  await click('#nav-settings');
  assert.deepStrictEqual(await evaluate(`Array.from(document.querySelectorAll('.settings-cat-label')).map(el => el.textContent)`),
    ['General', 'Account', 'Plans & billing', 'Speech engines', 'System', 'Display', 'Sound', 'Data and privacy']);
  assert.deepStrictEqual(await evaluate(`Array.from(document.querySelectorAll('.settings-panel[data-cat="general"] .setting-label')).map(el => el.textContent)`),
    ['Shortcuts', 'Dictation mode', 'Microphone', 'Dictation languages', 'More options', 'Dictation speed', 'App language', 'Auto-add to dictionary']);
  assert.strictEqual(await evaluate(`document.getElementById('general-more-options').open`), false, 'occasional settings start collapsed');
  assert.deepStrictEqual(await evaluate(`Array.from(document.querySelectorAll('.general-settings .settings-group .setting-label'), el => el.textContent)`),
    ['Shortcuts', 'Dictation mode', 'Microphone', 'Dictation languages'], 'everyday controls stay visible');
  assert.deepStrictEqual(await evaluate(`(() => { const seen = new Set(); return Array.from(document.querySelectorAll('[id]')).filter(el => {
    if (seen.has(el.id)) return true; seen.add(el.id); return false;
  }).map(el => el.id); })()`), [], 'moving controls must not duplicate IDs');
  for (const id of ['speech-mode-options', 'speech-mode-local', 'speech-mode-cloud', 'speech-model-notice', 'speech-model-list', 'speech-gpu-row',
    'speech-advanced', 'asr-device-select', 'set-tuned-model', 'speech-downloads-list', 'speech-repair', 'speech-remove-all']) {
    assert.strictEqual(await evaluate(`document.getElementById('${id}').closest('.settings-panel').dataset.cat`), 'speech-engines', id);
  }
  for (const id of ['asr-engine-select', 'asr-engine-hint', 'qwen-upgrade-card', 'gpu-card', 'qwen-accel-card', 'cloud-row', 'set-cloud-transcription',
    'speech-setup-install', 'speech-setup-cancel', 'speech-setup-remove', 'speech-extras']) {
    assert.strictEqual(await evaluate(`!!document.getElementById('${id}')`), false, 'the retired ' + id + ' is gone');
  }
  assert.deepStrictEqual(await evaluate(`Array.from(document.querySelectorAll('#speech-model-list [data-engine]'), li => li.dataset.engine + ':' + li.querySelectorAll('button').length)`),
    ['parakeet:1', 'whisper-turbo:1', 'qwen3-asr:1', 'whisper:1'], 'one row per local model, the default first, each with exactly one action');
  assert.deepStrictEqual(await evaluate(`Array.from(document.querySelectorAll('#speech-mode-options [role="radio"]'), el => el.dataset.listen)`), ['local', 'cloud']);
  assert.strictEqual(await evaluate(`document.querySelectorAll('#speech-mode-options .flow-style-card').length`), 0,
    'the listen cards do not borrow the flow-style card shell that other tests count');
  for (const id of ['mic-select', 'dictation-lang-open', 'app-lang-select', 'set-auto-add-dictionary']) {
    assert.strictEqual(await evaluate(`document.getElementById('${id}').closest('.settings-panel').dataset.cat`), 'general', id);
  }
  assert.strictEqual(await evaluate('document.getElementById("app-lang-select").disabled'), true, 'App language remains English only');

  assert.strictEqual(await evaluate("document.getElementById('set-display-name')"), null, 'the name lives on the account page now, not in General');
  await click('#mode-ptt');
  await click('#general-more-options > summary');
  assert.strictEqual(await evaluate(`document.getElementById('general-more-options').open`), true);
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
  // The language tests left a Pro account with Voxden Cloud on and no local
  // model downloaded. Cloud needs no model, so the list steps aside.
  const cloudFirst = await evaluate(`({ local: speechModeLocalEl.getAttribute('aria-checked'), cloud: speechModeCloudEl.getAttribute('aria-checked'),
    tabs: [speechModeLocalEl.tabIndex, speechModeCloudEl.tabIndex], badge: !document.getElementById('speech-mode-cloud-badge').hidden,
    credits: speechModeCreditsEl.hidden ? null : speechModeCreditsEl.textContent, gpu: speechGpuRowEl.hidden })`);
  assert.deepStrictEqual(cloudFirst, { local: 'false', cloud: 'true', tabs: [-1, 0], badge: false, credits: '75 of 900 cloud credits used this month.', gpu: true },
    'Cloud on checks its card, names the credits, and the checked card is the tab stop: ' + JSON.stringify(cloudFirst));
  assert.deepStrictEqual(await noticeView(), { ...quietNotice, text: 'No model is downloaded on this PC, and none is needed while Voxden Cloud is on.', error: false, list: false },
    'with Cloud on and nothing on disk, the notice says no model is needed');
  const beforeLocal = settingsPatches.length;
  assert.ok(await reachable('#speech-mode-local'), 'On this PC is reachable');
  assert.deepStrictEqual(await evaluate(`(() => { speechModeLocalEl.click();
    return [speechModeLocalEl.getAttribute('aria-checked'), speechModeCloudEl.getAttribute('aria-checked'), savingListenMode]; })()`),
    ['true', 'false', true], 'the choice shows at once, while its save is in flight');
  await waitFor('!savingListenMode && lastPayload.cloudTranscription === false');
  assert.deepStrictEqual(settingsPatches.slice(beforeLocal), [{ cloudTranscription: false }], 'On this PC saves the one boolean, once');
  // Nothing is downloaded and dictation cannot start: every row offers its own
  // priced download, and the notice says what to do.
  assert.deepStrictEqual(await noticeView(), { ...quietNotice, text: 'Download a model below to start dictating on this PC.', error: true },
    'a PC with no model says to download one');
  const setupRows = await rowsView();
  assert.deepStrictEqual(setupRows.map(r => [r.name, r.line, r.size, r.state, r.button, r.action, r.disabled, r.progress]), [
    ['Parakeet v3', 'Small and quick, even without a graphics card.', '660 MB', null, 'Download and use', 'install', false, null],
    ['Whisper large-v3 turbo', 'Mid-size, and uses your dictionary while it listens.', '1.6 GB', null, 'Download and use', 'install', false, null],
    ['Qwen3-ASR 1.7B', 'Best with names and accents.', '4.7 GB', null, 'Download and use', 'install', false, null],
    ['Whisper large-v3', 'Full-size, and the only one that can use a model trained on your voice.', '3.1 GB', null, 'Download and use', 'install', false, null],
  ], 'with nothing on disk, each row offers one priced download: ' + JSON.stringify(setupRows));
  assert.deepStrictEqual(await evaluate(`[speechAdvancedEl.open, document.getElementById('speech-downloads-row').hidden,
    document.getElementById('speech-remove-all-row').hidden, document.getElementById('speech-repair-row').hidden, speechGpuRowEl.hidden]`),
  [false, true, true, false, true], 'Advanced starts closed, there is nothing to remove, repair stays available, and no GPU offer without a model in use');
  await click(rowAction('whisper'));
  await frames();
  assert.deepStrictEqual(extraInstalls, [['whisper', { select: true }]], 'Download and use asks for the download and the switch together');
  await openAdvanced();
  assert.deepStrictEqual(await evaluate('[Array.from(settingInputs.asrDevice.options, o => o.value), speechProcessorHintEl.textContent]'),
    [['auto', 'cpu'], 'Auto uses your graphics card whenever the model in use can.'], 'Processor offers only what a PC with no graphics card can use');
  const beforeProcessor = settingsPatches.length;
  await selectOption('asr-device-select', 'cpu');
  await waitFor('lastPayload.asrDevice === "cpu" && !speechPending.has("processor")');
  assert.deepStrictEqual(settingsPatches.slice(beforeProcessor), [{ asrDevice: 'cpu' }], 'Processor saves one setting');
  assert.strictEqual(await evaluate("document.getElementById('confirm-dialog').open"), false, 'Qwen needs no second download for a processor change');
  assert.deepStrictEqual([installs, extraInstalls.length], [0, 1], 'choosing a processor downloads nothing');
  await click('#settings-close');
  await click('#nav-settings');
  assert.strictEqual(await evaluate('settingInputs.asrDevice.value'), 'cpu');
  assert.strictEqual(await evaluate('lastPayload.asrEngine'), 'qwen3-asr', 'no download finished, so the engine did not change');
  await category('general');
  assert.strictEqual(await evaluate('modePttEl.getAttribute("aria-checked")'), 'true');
  assert.strictEqual(await evaluate('qualityAccurateEl.getAttribute("aria-checked")'), 'true');
  assert.strictEqual(await evaluate('shortcutDisplayEl.textContent'), 'Ctrl+Shift+J');
  assert.strictEqual(await evaluate('pasteLastShortcutDisplayEl.textContent'), 'Ctrl+Shift+K');
  assert.strictEqual(await evaluate('settingInputs.microphone.value'), 'usb');
  assert.strictEqual(await evaluate('dictationLangOpenBtn.textContent'), 'Hindi', 'the box survives leaving and returning');
  await category('speech-engines');
  assert.strictEqual(await evaluate('speechAdvancedEl.open'), true, 'Advanced stays open across closing Settings and changing category');
  assert.deepStrictEqual(await evaluate(`Array.from(document.querySelectorAll('#speech-model-list [data-engine]'), li => li.dataset.engine)`),
    ['parakeet', 'whisper-turbo', 'qwen3-asr', 'whisper'], 'the default engine is listed first');
  await evaluate('for (let i = 0; i < 200; i++) renderSpeechEngines(lastPayload); true');
  await click('#speech-repair');
  // A round-trip ensures queued IPC and its following render have completed.
  await frames();
  await waitFor('lastPayload.asrOperation === "install"');
  assert.strictEqual(installs, 1, '200 renders must still send only one install');
  const busy = await evaluate(`({ bannerEnabled: !engineBannerBtnEl.disabled, action: engineBannerBtnEl.dataset.action,
    repair: [speechRepairBtn.textContent, speechRepairBtn.getAttribute('aria-disabled')],
    processor: settingInputs.asrDevice.disabled,
    trigger: document.querySelector('.custom-select:has(#asr-device-select) .custom-select-trigger').disabled })`);
  assert.deepStrictEqual(busy, { bannerEnabled: true, action: 'cancel', repair: ['Checking…', 'true'], processor: true, trigger: true },
    'while setup runs, the banner can cancel, and repair and Processor wait: ' + JSON.stringify(busy));
  const installingRows = await rowsView();
  assert.deepStrictEqual(installingRows.map(r => [r.id, r.line === null, r.button, r.action, r.disabled, r.progress]), [
    ['parakeet', false, 'Download and use', 'install', true, null],
    ['whisper-turbo', false, 'Download and use', 'install', true, null],
    ['qwen3-asr', true, 'Cancel', 'cancel', false, '5'],
    ['whisper', false, 'Download and use', 'install', true, null],
  ], 'the missing model draws the download and its Cancel in place of its line; every other row waits: ' + JSON.stringify(installingRows));
  assert.deepStrictEqual(await noticeView(), { ...quietNotice, text: 'Dictation on this PC is paused until this download finishes.', error: false });
  const heldBack = extraInstalls.length;
  await click(rowAction('parakeet'));
  await click('#speech-repair');
  await frames();
  assert.deepStrictEqual([extraInstalls.length, installs], [heldBack, 1], 'a waiting row and a running repair ignore clicks');
  // Cancel takes the place of the button under the pointer, so a double-click
  // on "Download and use" must not cancel the download it has just started.
  const armedClick = await evaluate(`(() => {
    const snapshot = lastPayload;
    render({ ...snapshot, asrOperation: null, asrRuntimeState: { status: 'idle' } });
    render(snapshot);
    const btn = document.querySelector('${rowAction('qwen3-asr')}');
    btn.click();
    return btn.dataset.action + ':' + btn.textContent;
  })()`);
  await frames();
  assert.strictEqual(armedClick, 'cancel:Cancel');
  assert.strictEqual(cancels, 0, 'a Cancel that has just appeared ignores the click');
  await category('general');
  payload = { ...payload, asrRuntimeState: { status: 'downloading', progress: 42 } };
  win.webContents.send('history-updated', payload);
  await settle();
  assert.strictEqual(await evaluate('document.querySelector(".settings-panel[data-cat=speech-engines]").hidden'), true);
  await category('speech-engines');
  assert.deepStrictEqual(await evaluate(`[document.querySelector('${row('qwen3-asr')} [role="progressbar"]').getAttribute('aria-valuenow'),
    document.querySelector('${row('qwen3-asr')} [data-role="progress-label"]').textContent]`), ['42', '42%'], 'download updates while its panel is hidden');
  assert.strictEqual(await evaluate('document.querySelector(".settings-detail").scrollTop'), 0, 'changing category starts at the top');
  // Every progress tick re-renders the panel. The focused Cancel, its row and
  // the open Advanced disclosure must all come through untouched.
  await evaluate(`window.focusedCancel = document.querySelector('${rowAction('qwen3-asr')}'); focusedCancel.focus();
    window.qwenRowNode = focusedCancel.closest('li'); true`);
  payload = { ...payload, asrRuntimeState: { status: 'downloading', progress: 43 } };
  win.webContents.send('history-updated', payload);
  await settle();
  await evaluate('for (let i = 0; i < 200; i++) renderSettings(lastPayload); true');
  assert.deepStrictEqual(await evaluate(`[document.activeElement === focusedCancel, speechAdvancedEl.open,
    document.querySelector('${row('qwen3-asr')}') === qwenRowNode, document.querySelector('${rowAction('qwen3-asr')}') === focusedCancel,
    document.querySelector('${row('qwen3-asr')} [role="progressbar"]').getAttribute('aria-valuenow')]`),
  [true, true, true, true, '43'], 'a progress render keeps focus on Cancel, the same row and button nodes, and Advanced open');
  await delay(550);
  await click(rowAction('qwen3-asr'));
  await frames();
  assert.strictEqual(cancels, 1);
  await waitFor('!lastPayload.asrOperation');
  const cancelledRows = await rowsView();
  assert.deepStrictEqual(cancelledRows.map(r => [r.button, r.disabled, r.progress, r.error]),
    [['Download and use', false, null, null], ['Download and use', false, null, null], ['Download and use', false, null, null], ['Download and use', false, null, null]],
    'a cancelled download offers itself again and releases the other rows: ' + JSON.stringify(cancelledRows));
  assert.deepStrictEqual(await evaluate(`[getComputedStyle(document.querySelector('${row('qwen3-asr')} [data-role="progress-row"]')).display,
    getComputedStyle(document.querySelector('${row('qwen3-asr')} [data-role="state"]')).display, document.activeElement === focusedCancel]`),
  ['none', 'none', true], 'hidden progress and state actually disappear, and focus stays on the same button through the change');
  assert.deepStrictEqual(await noticeView(), { ...quietNotice, text: 'Download a model below to start dictating on this PC.', error: true, detail: 'Cancelled.', detailError: false },
    'a repair the user cancelled is reported under the notice, not as a failure');
  assert.deepStrictEqual(await evaluate('[speechRepairBtn.textContent, speechRepairBtn.getAttribute("aria-disabled"), settingInputs.asrDevice.disabled]'),
    ['Check and repair', 'false', false], 'repair and Processor are usable again');
  payload = { ...payload, asrModel: { installed: true }, asrRuntime: { installed: true },
    modelPlan: require('../src/model-plan').plan({ engine: 'qwen3-asr', installed: { 'qwen3-asr': true } }) };
  win.webContents.send('history-updated', payload);
  await settle();
  // The chosen model is on disk but the engine still reports unavailable.
  assert.deepStrictEqual(await noticeView(), { ...quietNotice, text: 'Voxden could not start dictation on this PC.', error: true, detail: 'Cancelled.', detailError: false, repair: true },
    'a model on disk that will not start offers Check and repair beside the notice');
  assert.deepStrictEqual((await rowsView()).map(r => [r.state, r.button]), [[null, 'Download and use'], [null, 'Download and use'], ['In use', null], [null, 'Download and use']]);
  assert.deepStrictEqual(await downloadsView(), { hidden: false, items: [
    { key: 'model:qwen3-asr', name: 'Qwen3-ASR 1.7B', line: null, size: null, state: 'In use', remove: null, disabled: null },
  ] }, 'the model in use is listed without a Remove');
  await evaluate('for (let i = 0; i < 200; i++) renderSpeechEngines(lastPayload); true');
  await click('#speech-remove-all');
  assert.deepStrictEqual(await confirmView(), { open: true, title: 'Remove all speech models?',
    body: 'Qwen3-ASR 1.7B is removed from this PC, and dictation on this PC stops until you download a model again. Your history, settings and GPU speed-up downloads are kept.',
    ok: 'Remove all' }, 'removal asks first, in the in-app dialog, and says what goes');
  assert.strictEqual(await evaluate('speechRemoveAllBtn.getAttribute("aria-disabled")'), 'true', 'no second removal can queue while the question is open');
  assert.strictEqual(removes, 0, 'nothing is removed until the question is answered');
  await click('#confirm-cancel');
  assert.strictEqual(removes, 0, 'Cancel removes nothing');
  assert.strictEqual(await evaluate('speechRemoveAllBtn.getAttribute("aria-disabled")'), 'false', 'a cancelled removal can be asked again');
  await click('#speech-remove-all');
  await click('#confirm-ok');
  await evaluate('new Promise(resolve => requestAnimationFrame(resolve))');
  assert.strictEqual(removes, 1, '200 renders must still send only one removal');
  assert.strictEqual(await evaluate('lastPayload.asrEngine'), 'qwen3-asr');

  // Back to the resting offer: the cancel above left the banner reporting the
  // cancellation, which is a different message with a different job.
  payload = { ...payload, asrOperation: null, asrRuntimeState: { status: 'idle' }, asrModel: { installed: false },
    modelPlan: require('../src/model-plan').plan({ engine: 'qwen3-asr', device: 'auto', language: 'en',
      sizes: { whisper: 3.1e9, 'whisper-turbo': 1.62e9, 'qwen3-asr': 4.7e9, parakeet: 0.66e9, 'parakeet-fp32': 2.51e9 }, installed: {} }) };
  win.webContents.send('history-updated', payload);
  await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');

  // The download the user is quoted is the one they will actually make. The
  // banner used to add up every model that existed and say "up to 11.0 GB".
  const quoted = await evaluate('engineBannerTextEl.textContent');
  assert(/4\.7 GB/.test(quoted), 'the banner quotes the chosen engine: ' + quoted);
  assert(/Qwen3-ASR/.test(quoted), 'and names it: ' + quoted);
  assert(!/11(\.0)? GB/.test(quoted), 'and never the all-in figure: ' + quoted);

  // Every model is priced at its own size, and Parakeet at the precision this
  // processor loads: the float32 pack is not offered to a CPU-only setting.
  const pricedRows = await rowsView();
  assert.deepStrictEqual(pricedRows.map(r => [r.name, r.size, r.button]), [
    ['Parakeet v3', '660 MB', 'Download and use'], ['Whisper large-v3 turbo', '1.6 GB', 'Download and use'],
    ['Qwen3-ASR 1.7B', '4.7 GB', 'Download and use'], ['Whisper large-v3', '3.1 GB', 'Download and use'],
  ], 'turbo is priced at its own size, not large-v3’s: ' + JSON.stringify(pricedRows));
  assert.ok(!/for GPU|2\.5 GB/.test(await evaluate(`document.querySelector('.settings-panel[data-cat="speech-engines"]').textContent`)),
    'no GPU-only pack off the AMD or Intel processor');
  await click(rowAction('whisper-turbo'));
  await evaluate('new Promise(resolve => requestAnimationFrame(resolve))');
  await click(rowAction('parakeet'));
  await frames();
  assert.deepStrictEqual(extraInstalls, [['whisper', { select: true }], ['whisper-turbo', { select: true }], ['parakeet', { select: true }]],
    'each model requests its own download exactly once');

  // A downloaded model that is not in use offers Use on its row; its Remove
  // lives under Advanced > Downloaded models and asks first.
  payload = { ...payload, modelPlan: speechPlan({ whisper: true }) };
  win.webContents.send('history-updated', payload);
  await frames();
  const installedRows = await rowsView();
  assert.deepStrictEqual(installedRows.map(r => [r.id, r.button]),
    [['parakeet', 'Download and use'], ['whisper-turbo', 'Download and use'], ['qwen3-asr', 'Download and use'], ['whisper', 'Use']],
    'a downloaded model offers Use, not a second download: ' + JSON.stringify(installedRows));
  assert.deepStrictEqual(await noticeView(), { ...quietNotice, text: 'Choose a model below to start dictating on this PC.', error: true },
    'with another model on disk, the notice points at Use before any download');
  assert.deepStrictEqual(await downloadsView(), { hidden: false, items: [
    { key: 'model:whisper', name: 'Whisper large-v3', line: null, size: '3.1 GB', state: null, remove: 'Remove', disabled: false },
  ] });
  const removesBefore = actionCalls.length;
  await click(download('model:whisper') + ' [data-role="remove"]');
  assert.deepStrictEqual(await confirmView(), { open: true, title: 'Remove Whisper large-v3?',
    body: 'It frees 3.1 GB. You can download it again from here at any time.', ok: 'Remove' });
  await click('#confirm-cancel');
  assert.strictEqual(actionCalls.length, removesBefore, 'backing out removes nothing');
  await click(download('model:whisper') + ' [data-role="remove"]');
  await click('#confirm-ok');
  await frames();
  assert.deepStrictEqual(actionCalls.slice(removesBefore), [['speech-model-remove', 'whisper']]);

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
  assert.ok(/^Pro until .*75 of 900 cloud credits/.test(signedIn.plan), 'the plan and cloud credits are spelled out: ' + signedIn.plan);
  assert.ok(/^Checked /.test(signedIn.status), signedIn.status);
  assert.deepStrictEqual([signedIn.first, signedIn.last, signedIn.initials, signedIn.photo, signedIn.pro], ['Me', 'Tester', 'MT', false, true],
    'the profile card shows the names and initials in place of a photo, gilded for Pro');
  assert.strictEqual(await evaluate("document.getElementById('profile-email').tagName + ':' + getComputedStyle(document.getElementById('profile-email')).userSelect"), 'DIV:none',
    'the email is plain text that cannot be selected or edited');
  await click('#profile-first');
  await evaluate(`(() => { const f = document.getElementById('profile-first'); f.dispatchEvent(new FocusEvent('focus')); f.value = ' Sam '; f.dispatchEvent(new FocusEvent('blur')); })(); true`);
  await waitFor("document.getElementById('profile-avatar-initials').textContent === 'ST'");
  assert.deepStrictEqual(accountCalls.at(-1), ['profile', { firstName: 'Sam', lastName: 'Tester' }], 'leaving a name field saves the trimmed names');
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
  assert.ok(/825 credits left/.test(await evaluate(`document.getElementById('sidebar-credits-count').textContent`)), 'the meter uses remaining credits');

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
  assert.match(active.credits, /75 of 900 used this month/, active.credits);
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
  assert.ok(/Cancel renewal anytime/.test(freeCard.hint), freeCard.hint);
  assert.ok(accountCalls.some(c => c[0] === 'billing-options'), 'prices were fetched once the card showed');

  // --- the one-time welcome offer: 1,200 in the first month, then 900 --------
  const welcomeView = () => evaluate(`({ hidden: document.getElementById('billing-welcome').hidden,
    credits: document.getElementById('billing-welcome-credits').textContent,
    detail: document.getElementById('billing-welcome-detail').textContent,
    benefit: document.getElementById('billing-cloud-benefit').textContent,
    badge: document.getElementById('billing-plan-badge').textContent,
    faqWelcome: document.getElementById('billing-faq-welcome-item').hidden ? '' : document.getElementById('billing-faq-welcome').textContent,
    faqCredits: document.getElementById('billing-faq-credits').textContent })`);
  const offerShown = await welcomeView();
  assert.deepStrictEqual([offerShown.hidden, offerShown.credits, offerShown.detail, offerShown.benefit],
    [false, '1,200', 'Up to 20 hours of cloud dictation, about 40 minutes a day.', 'Then 900 cloud credits every month, up to 15 hours'],
    'the offer and the month after it reflect the server entitlement: ' + JSON.stringify(offerShown));
  assert.match(offerShown.faqWelcome, /first month of Voxden Pro comes with 1,200 cloud credits instead of 900\. It runs from the day you subscribe until your first renewal, and each account gets it once/);
  assert.match(offerShown.faqCredits, /so 1,200 credits cover up to 20 hours and 900 credits cover up to 15 hours\./);
  payload = { ...payload, account: { ...payload.account, welcomeOffer: { credits: 1200, monthlyCredits: 900, eligible: false } } };
  win.webContents.send('history-updated', payload);
  await settle();
  const offerTaken = await welcomeView();
  assert.deepStrictEqual([offerTaken.hidden, offerTaken.benefit], [true, '900 cloud credits every month, up to 15 hours'],
    'an account that already had its welcome month is offered the plain month: ' + JSON.stringify(offerTaken));
  payload = { ...payload, account: { ...payload.account, welcomeOffer: null,
    billing: { options: billingOptions.map(({ welcomeCreditsCap, ...group }) => group) } } };
  win.webContents.send('history-updated', payload);
  await settle();
  const olderService = await welcomeView();
  assert.deepStrictEqual([olderService.hidden, olderService.faqWelcome], [true, ''], 'a service that never stated an offer shows none');
  payload = { ...payload, account: { ...accountBase } };
  win.webContents.send('history-updated', payload);
  await settle();
  const signedOutOffer = await welcomeView();
  const shipped = require('../src/credits');
  assert.deepStrictEqual([signedOutOffer.hidden, signedOutOffer.credits, signedOutOffer.benefit],
    [false, shipped.WELCOME_CREDITS.toLocaleString(), 'Then ' + shipped.creditsFromHours(shipped.DEFAULT_HOURS_CAP) + ' cloud credits every month, up to 15 hours'],
    'before the service answers, the page shows the figures the service ships with: ' + JSON.stringify(signedOutOffer));
  payload = { ...payload, account: { ...accountBase, signedIn: true, email: 'me@example.com', plan: 'pro', planExpiresAt: '2026-10-23T10:00:00.000Z', checkedAt: Date.now(),
    cloud: { creditsUsed: 75, creditsCap: 1200, creditsRemaining: 1125, hoursUsed: 1.25, hoursCap: 20, reset: 'month',
      periodEnd: '2026-10-20T00:00:00.000Z', welcome: true, monthlyCredits: 900 },
    welcomeOffer: { credits: 1200, monthlyCredits: 900, eligible: false } } };
  win.webContents.send('history-updated', payload);
  await settle();
  const welcomeMonth = await welcomeView();
  assert.strictEqual(welcomeMonth.badge, 'WELCOME MONTH');
  assert.ok(welcomeMonth.hidden && /^1,200 cloud credits this month, then 900 a month from /.test(welcomeMonth.benefit),
    'a subscriber in the welcome month is told when it becomes 900: ' + JSON.stringify(welcomeMonth));
  await click('#account-manage-billing');
  await waitFor("document.getElementById('subscription-dialog').open");
  assert.match(await evaluate("document.getElementById('subscription-credits').textContent"), /^75 of 1,200 used this month · welcome month$/);
  await click('#subscription-close');
  payload = { ...payload, account: { ...accountBase, signedIn: true, email: 'me@example.com', plan: 'free', checkedAt: Date.now(),
    billing: { options: billingOptions } } };
  win.webContents.send('history-updated', payload);
  await settle();

  // --- regional prices: the service's region picks the one price shown -----
  const priceView = () => evaluate(`({ picker: !document.querySelector('.billing-region-label').hidden,
    pro: document.getElementById('billing-price-amount').textContent,
    caption: document.getElementById('billing-price-caption').textContent,
    free: document.getElementById('billing-free-price').textContent,
    languages: document.getElementById('billing-cloud-languages').textContent,
    button: accountUpgradeOptionsEl.querySelector('button') ? [accountUpgradeOptionsEl.querySelector('button').textContent, accountUpgradeOptionsEl.querySelector('button').dataset.provider] : null })`);
  const unplacedPrices = await priceView();
  assert.deepStrictEqual([unplacedPrices.picker, unplacedPrices.pro, unplacedPrices.free], [true, '₹349', '₹0'],
    'an account the service has not placed keeps the picker and the India offer: ' + JSON.stringify(unplacedPrices));
  const showRegion = async (region, options) => {
    payload = { ...payload, account: { ...payload.account, region, billing: { options } } };
    win.webContents.send('history-updated', payload);
    await settle();
    return priceView();
  };
  const globalPrices = await showRegion('global', billingOptions.filter(group => group.region === 'global'));
  assert.deepStrictEqual(globalPrices, { picker: false, pro: '$8', caption: '$8 billed every month.', free: '$0',
    languages: '60 languages through the cloud',
    button: ['Get Pro', 'lemonsqueezy'] }, 'an account placed outside India sees dollars only: ' + JSON.stringify(globalPrices));
  const globalNotOpen = await showRegion('global', []);
  assert.deepStrictEqual([globalNotOpen.picker, globalNotOpen.pro, globalNotOpen.free, globalNotOpen.button], [false, '$8', '$0', ['Not available yet', 'lemonsqueezy']],
    'before global payments open, the dollar price still shows, not the rupee one: ' + JSON.stringify(globalNotOpen));
  const indiaPrices = await showRegion('in', billingOptions.filter(group => group.region === 'in'));
  assert.deepStrictEqual([indiaPrices.picker, indiaPrices.pro, indiaPrices.free, indiaPrices.button, indiaPrices.languages],
    [false, '₹349', '₹0', ['Get Pro', 'razorpay'], '60 languages through the cloud, Hindi and Hinglish included'],
    'an account placed in India sees rupees only, with Hindi and Hinglish named: ' + JSON.stringify(indiaPrices));
  payload = { ...payload, account: { ...payload.account, plan: 'pro', region: 'global', planExpiresAt: '2027-01-01T00:00:00.000Z',
    cloud: { creditsUsed: 75, creditsCap: 900, creditsRemaining: 825, reset: 'month', periodEnd: '2026-10-20T00:00:00.000Z', welcome: false, monthlyCredits: 900 } } };
  win.webContents.send('history-updated', payload);
  await settle();
  assert.strictEqual(await evaluate(`document.getElementById('billing-cloud-languages').textContent`),
    '60 languages through the cloud', 'a subscriber outside India gets the same list');
  // DB-IP's table is CC BY 4.0, so the credit has to exist somewhere. It is no
  // longer under the price, where it sat while someone was deciding to pay.
  assert.strictEqual(await evaluate(`document.getElementById('billing-region-note')`), null,
    'the region credit no longer sits in the billing panel');
  assert.match(await evaluate(`Array.from(document.querySelectorAll('.settings-panel[data-cat="privacy"] .setting-hint'), el => el.textContent).join(' ')`),
    /IP Geolocation by DB-IP/, 'the DB-IP credit lives in Data and privacy instead');
  payload = { ...payload, account: { ...payload.account, plan: 'free', planExpiresAt: null, cloud: { hoursUsed: 0, hoursCap: 0, periodEnd: null } } };
  payload = { ...payload, account: { ...payload.account, region: null, billing: { options: billingOptions } } };
  win.webContents.send('history-updated', payload);
  await settle();

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
    cloud: { hoursUsed: 1.25, hoursCap: 15, periodEnd: 'p' }, checkedAt: Date.now() } };
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

  // --- How Voxden listens: Voxden Cloud only for Pro, never a dead end -------
  const cloudView = () => evaluate(`({ checked: speechModeCloudEl.getAttribute('aria-checked'), local: speechModeLocalEl.getAttribute('aria-checked'),
    disabled: speechModeCloudEl.getAttribute('aria-disabled') === 'true',
    badge: document.getElementById('speech-mode-cloud-badge').hidden ? null : document.getElementById('speech-mode-cloud-badge').textContent,
    line: document.getElementById('speech-mode-cloud-line').textContent,
    credits: speechModeCreditsEl.hidden ? null : speechModeCreditsEl.textContent,
    status: speechModeErrorEl.hidden ? '' : speechModeErrorEl.textContent,
    describedBy: speechModeCloudEl.getAttribute('aria-describedby') })`);
  const cloudFree = await cloudView();
  assert.deepStrictEqual(cloudFree, { checked: 'false', local: 'true', disabled: true, badge: 'Needs Pro',
    line: 'Your audio goes to Voxden Cloud, which knows more languages.', credits: null, status: '',
    describedBy: 'speech-mode-cloud-badge speech-mode-cloud-line' },
  'signed out, Voxden Cloud is unchecked, locked, says it needs Pro and that audio leaves the PC: ' + JSON.stringify(cloudFree));
  const lockedPatches = settingsPatches.length;
  await click('#speech-mode-cloud');
  await evaluate('speechModeLocalEl.focus(); speechModeLocalEl.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true })); true');
  await settle();
  assert.strictEqual(await evaluate('document.activeElement === speechModeCloudEl'), true, 'the arrow key still reaches the locked card, so it is read out');
  assert.strictEqual(settingsPatches.length, lockedPatches, 'a locked Voxden Cloud card saves nothing, by click or by key');
  assert.strictEqual((await cloudView()).checked, 'false');
  await publishAccount({ ...accountBase, signedIn: true, email: 'me@example.com', plan: 'pro',
    cloud: { hoursUsed: 2.5, hoursCap: 15, periodEnd: 'p' }, checkedAt: Date.now() });
  const cloudPro = await cloudView();
  assert.deepStrictEqual([cloudPro.disabled, cloudPro.badge, cloudPro.credits, cloudPro.describedBy],
    [false, null, '150 of 900 cloud credits used this month.', 'speech-mode-cloud-line speech-mode-cloud-credits'],
    'Pro unlocks the card and shows the credits: ' + JSON.stringify(cloudPro));
  assert.strictEqual(await evaluate('speechModeCloudEl.hasAttribute("aria-disabled")'), false);
  const cloudPatches = settingsPatches.length;
  await click('#speech-mode-cloud');
  await waitFor('!savingListenMode && lastPayload.cloudTranscription === true');
  assert.deepStrictEqual(settingsPatches.slice(cloudPatches), [{ cloudTranscription: true }], 'the card saves one boolean');
  assert.deepStrictEqual(await evaluate('[speechModeLocalEl.tabIndex, speechModeCloudEl.tabIndex]'), [-1, 0], 'the checked card is the tab stop');
  // Arrow keys and Home/End move the choice, like any radio group.
  await evaluate('speechModeCloudEl.focus(); speechModeCloudEl.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true })); true');
  await waitFor('!savingListenMode && lastPayload.cloudTranscription === false');
  assert.strictEqual(await evaluate('document.activeElement === speechModeLocalEl && speechModeLocalEl.getAttribute("aria-checked") === "true"'), true,
    'ArrowLeft moves focus and the choice to On this PC');
  await evaluate('speechModeLocalEl.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true, cancelable: true })); true');
  await waitFor('!savingListenMode && lastPayload.cloudTranscription === true');
  assert.deepStrictEqual(settingsPatches.slice(cloudPatches), [{ cloudTranscription: true }, { cloudTranscription: false }, { cloudTranscription: true }],
    'each key press saves the card it lands on, once');
  // With Cloud on, the model on disk is named and the list steps aside.
  assert.deepStrictEqual(await noticeView(), { ...quietNotice, text: 'Whisper large-v3 stays on this PC and is not used while Voxden Cloud is on.', error: false, list: false },
    'Cloud names the downloaded model when the chosen one is not on disk');
  assert.strictEqual(await evaluate('speechGpuRowEl.hidden'), true, 'no GPU offer while Voxden Cloud listens');
  await publishAccount(payload.account, { cloudTranscription: true, cloudStatus: { lastResult: 'cloud', lastError: 'timeout', lastMs: 640, count: 1 } });
  assert.strictEqual((await cloudView()).status, '', 'a request that worked adds no line to the card, whatever failed before it');
  await publishAccount(payload.account, { cloudStatus: { lastResult: 'cloud-segments', lastError: '', lastMs: 370, count: 2 } });
  assert.strictEqual((await cloudView()).status, '', 'nor does one transcribed during recording');
  for (const [code, reason] of [
    ['timeout', /Voxden Cloud waited too long.*Retry/],
    ['network', /Voxden Cloud could not be reached.*retry/],
    ['unconfigured', /Voxden Cloud is not configured/],
    ['upstream', /Voxden Cloud could not transcribe.*Try again/],
    ['cap', /^Your cloud credits are used up\.$/],
    ['mystery', /^Voxden Cloud could not finish the dictation \(mystery\)\.$/],
  ]) {
    await publishAccount(payload.account, { cloudStatus: { lastResult: 'error', lastError: code } });
    const view = await cloudView();
    assert.match(view.status, reason, 'a cloud error gives its reason and recovery: ' + code);
    assert.doesNotMatch(view.status, /fall(?:ing|en)? back|transcribed locally|local engine/i,
      'cloud errors never claim a local fallback: ' + code);
    assert.ok(view.describedBy.endsWith('speech-mode-cloud-error'), 'the reason is read with the card: ' + view.describedBy);
  }
  await publishAccount({ ...accountBase }, { cloudTranscription: true, cloudStatus: { lastResult: 'skipped', lastError: 'signed-out' } });
  const cloudStuck = await cloudView();
  assert.ok(cloudStuck.checked === 'true' && !cloudStuck.disabled && cloudStuck.badge === 'Needs Pro',
    'a user who turned it on still sees it on, unlocked, after signing out: ' + JSON.stringify(cloudStuck));
  assert.strictEqual(cloudStuck.status, 'Sign in under Account to use Voxden Cloud dictation.');
  const stuckPatches = settingsPatches.length;
  await click('#speech-mode-local');
  await waitFor('!savingListenMode && lastPayload.cloudTranscription === false');
  assert.deepStrictEqual(settingsPatches.slice(stuckPatches), [{ cloudTranscription: false }], 'and can turn it off from On this PC');
  const cloudRelocked = await cloudView();
  assert.ok(cloudRelocked.disabled && cloudRelocked.local === 'true', 'once off, a signed-out account cannot turn it back on: ' + JSON.stringify(cloudRelocked));
  await publishAccount({ ...accountBase }, { cloudTranscription: false, cloudStatus: { lastResult: '', lastError: '' } });

  // --- The Model notice: one line, strict priority, first match wins ---------
  const noticeBase = { ...payload, asrEngine: 'qwen3-asr', asrDevice: 'auto', engineStatus: 'ready', asrOperation: null,
    asrRuntimeState: { status: 'idle' }, asrRuntime: { installed: true }, cloudTranscription: false, cloudStatus: {},
    asrEngineWarning: '', asrEngineError: '', asrEngineFix: '', usingManagedRuntime: true,
    modelPlan: speechPlan({ 'qwen3-asr': true, whisper: true }) };
  const noticeFor = async patch => { await paint({ ...noticeBase, ...patch }); return noticeView(); };
  assert.deepStrictEqual(await noticeFor({}), quietNotice, 'a model in use and nothing wrong: no notice');
  assert.deepStrictEqual(await noticeFor({ cloudTranscription: true, engineStatus: 'unavailable', asrEngineWarning: 'Engine warning.' }),
    { ...quietNotice, text: 'Qwen3-ASR 1.7B stays on this PC and is not used while Voxden Cloud is on.', error: false, list: false },
    'Cloud on outranks a local failure');
  assert.deepStrictEqual(await noticeFor({ cloudTranscription: true, asrEngine: 'whisper', modelPlan: speechPlan({ parakeet: true, 'whisper-turbo': true }) }),
    { ...quietNotice, text: 'Parakeet v3 stays on this PC and is not used while Voxden Cloud is on.', error: false, list: false },
    'with the chosen model missing, Cloud names the first model on disk in panel order');
  assert.deepStrictEqual(await noticeFor({ cloudTranscription: true, engineStatus: 'unavailable', asrOperation: 'remove',
    asrRuntimeState: { status: 'removing', message: 'Removing Whisper large-v3…' } }),
  { ...quietNotice, text: 'Removing Whisper large-v3…', error: false }, 'a removal outranks Cloud, in main’s own words');
  const lockedByRemoval = await evaluate(`({ rows: Array.from(document.querySelectorAll('#speech-model-list [data-role="action"]:not([hidden])'), b => b.getAttribute('aria-disabled')),
    remove: document.querySelector('${download('model:whisper')} [data-role="remove"]').getAttribute('aria-disabled'),
    removeAll: speechRemoveAllBtn.getAttribute('aria-disabled'), repair: speechRepairBtn.getAttribute('aria-disabled'), processor: settingInputs.asrDevice.disabled })`);
  assert.deepStrictEqual(lockedByRemoval, { rows: ['true', 'true', 'true'], remove: 'true', removeAll: 'true', repair: 'true', processor: true },
    'every panel action waits while a removal holds the engine: ' + JSON.stringify(lockedByRemoval));
  assert.deepStrictEqual(await noticeFor({ asrOperation: 'install', engineStatus: 'unavailable', asrRuntimeState: { status: 'preparing' } }),
    { ...quietNotice, text: 'Dictation on this PC is paused while Voxden checks the speech engine.', error: false },
    'a repair with nothing to fetch does not promise a download');
  assert.deepStrictEqual((await rowsView()).filter(r => r.progress !== null || r.action === 'cancel'), [], 'and draws no row as downloading');
  await paint(noticeBase);
  assert.deepStrictEqual(await noticeFor({ asrOperation: 'install', engineStatus: 'unavailable', modelPlan: speechPlan({ 'qwen3-asr': true }),
    asrRuntimeState: { status: 'downloading', step: 'extras', progress: 30, downloadedBytes: 0.5e9, totalBytes: 1.62e9 } }),
  { ...quietNotice, text: 'Dictation on this PC is paused until this download finishes.', error: false });
  assert.deepStrictEqual(await evaluate("[speechModelAnnounceEl.hidden, speechModelAnnounceEl.getAttribute('role'), speechModelAnnounceEl.textContent, speechModelNoticeEl.hasAttribute('role')]"),
    [false, 'status', 'Dictation on this PC is paused until this download finishes.', false],
    'the notice is announced through a live region that is never hidden, not the notice line that appears with it');
  const matchedDownload = (await rowsView())[1];
  assert.deepStrictEqual([matchedDownload.button, matchedDownload.progress, matchedDownload.size], ['Cancel', '30', '500 MB of 1.6 GB'],
    'a download started elsewhere is drawn on the one row whose size it matches: ' + JSON.stringify(matchedDownload));
  await paint(noticeBase);
  await paint({ ...noticeBase, asrEngine: 'whisper', asrOperation: 'install', modelPlan: speechPlan({}),
    asrRuntimeState: { status: 'downloading', step: 'model', progress: 10, downloadedBytes: 0.31e9, totalBytes: 3.1e9 } });
  const largeDownload = (await rowsView())[3];
  assert.deepStrictEqual([largeDownload.button, largeDownload.progress, largeDownload.size], ['Cancel', '10', '310 MB of 3.1 GB'],
    'the download that reports a model step is Whisper large-v3: ' + JSON.stringify(largeDownload));
  await paint(noticeBase);
  assert.deepStrictEqual(await noticeFor({ asrOperation: 'gpu-install', engineStatus: 'unavailable' }), quietNotice, 'a GPU pack install leaves the notice to its own row');
  assert.ok((await rowsView()).filter(r => r.button !== null).every(r => r.disabled), 'but the rows still wait for it');
  assert.deepStrictEqual(await noticeFor({ engineStatus: 'unavailable', asrEngineWarning: 'Engine warning.', modelPlan: speechPlan({}) }),
    { ...quietNotice, text: 'Download a model below to start dictating on this PC.', error: true }, 'nothing on disk outranks an engine warning');
  assert.deepStrictEqual(await noticeFor({ engineStatus: 'unavailable', modelPlan: speechPlan({ parakeet: true }) }),
    { ...quietNotice, text: 'Choose a model below to start dictating on this PC.', error: true }, 'a model already on disk is offered before a download');
  assert.deepStrictEqual(await noticeFor({ engineStatus: 'unavailable', asrEngineError: 'The speech engine stopped responding.', asrEngineWarning: 'Engine warning.' }),
    { ...quietNotice, text: 'Voxden could not start dictation on this PC.', error: true, detail: 'The speech engine stopped responding.', detailError: true, repair: true },
    'a model on disk that will not start names the reason and offers repair, ahead of any warning');
  assert.deepStrictEqual(await noticeFor({ engineStatus: 'unavailable', asrRuntime: null }),
    { ...quietNotice, text: 'Voxden could not start dictation on this PC.', error: true }, 'a build with no managed runtime has nothing to repair');
  assert.strictEqual(await evaluate("document.getElementById('speech-repair-row').hidden"), true, 'Advanced hides Check and repair there too');
  assert.deepStrictEqual(await noticeFor({ asrEngineWarning: 'Whisper large-v3 needs a newer speech engine.', asrEngineFix: 'pip install -U faster-whisper',
    asrEngineFixEngine: 'whisper', usingManagedRuntime: false, asrRuntime: { installed: true, needsUpgrade: true } }),
  { ...quietNotice, text: 'Whisper large-v3 needs a newer speech engine.', error: true, detail: 'To enable Whisper large-v3, run: pip install -U faster-whisper', detailError: true },
  'a warning outranks a runtime repair, and a development build gets the command');
  assert.deepStrictEqual(await noticeFor({ asrEngineWarning: 'Whisper large-v3 needs a newer speech engine.', asrEngineFix: 'pip install -U faster-whisper',
    asrEngineFixEngine: 'whisper', usingManagedRuntime: true }),
  { ...quietNotice, text: 'Whisper large-v3 needs a newer speech engine.', error: true, repair: true }, 'the shipped app offers repair instead of a command');
  assert.deepStrictEqual(await noticeFor({ asrRuntime: { installed: true, needsUpgrade: true }, asrRuntimeState: { status: 'error', message: 'Setup failed. Try again.' } }),
    { ...quietNotice, text: 'The speech engine needs repair.', error: true, detail: 'Setup failed. Try again.', detailError: true, repair: true },
    'a runtime needing repair outranks the last setup error, which becomes its detail');
  assert.deepStrictEqual(await noticeFor({ asrRuntimeState: { status: 'error',
    message: 'Speech setup needs about 6 GB of free disk space, including temporary files. Free some space and try again.' } }),
  { ...quietNotice, text: 'Speech setup needs about 6 GB of free disk space, including temporary files. Free some space and try again.', error: true },
  'a setup error no other slot shows lands on the notice');
  assert.deepStrictEqual(await noticeFor({ asrRuntimeState: { status: 'cancelled', message: 'Setup cancelled. Download again to resume.' } }),
    { ...quietNotice, text: 'Setup cancelled. Download again to resume.', error: false }, 'a cancellation is not an error');
  // A download a row started reports its own failure under that row, once.
  const beforeRowError = payload;
  await paint(noticeBase);
  payload = { ...noticeBase, asrRuntimeState: { status: 'error', message: 'That speech model could not be downloaded.' } };
  await click(rowAction('whisper-turbo'));
  await waitFor(`!document.querySelector('${row('whisper-turbo')} [data-role="error"]').hidden`);
  const failedRow = (await rowsView())[1];
  assert.deepStrictEqual([failedRow.error, failedRow.errorTone, failedRow.button], ['That speech model could not be downloaded.', true, 'Download and use'],
    'the failed row says why and offers the download again: ' + JSON.stringify(failedRow));
  assert.deepStrictEqual(extraInstalls.at(-1), ['whisper-turbo', { select: true }]);
  assert.strictEqual((await noticeView()).text, null, 'and the notice does not repeat it');
  win.webContents.send('history-updated', { ...payload, asrRuntimeState: { status: 'cancelled',
    message: 'Speech models download cancelled. The partial download was kept so it can resume later.' } });
  await settle();
  const cancelledRow = (await rowsView())[1];
  assert.deepStrictEqual([cancelledRow.error, cancelledRow.errorTone],
    ['Speech models download cancelled. The partial download was kept so it can resume later.', false], 'a cancelled row download is not drawn as an error');
  // A Qwen pack install never replaces asrRuntimeState. An error the user moved
  // past (every other panel action dismisses it first) stays gone after one.
  const rowCancelled = await evaluate('lastPayload');
  await evaluate('speechDismissError(lastPayload); true');
  await paint({ ...rowCancelled, asrOperation: 'gpu-install' });
  await paint(rowCancelled);
  assert.deepStrictEqual([(await rowsView())[1].error, (await noticeView()).text], [null, null],
    'a GPU pack install in between does not bring back a dismissed setup error');
  payload = beforeRowError;
  win.webContents.send('history-updated', payload);
  await settle();

  assert.deepStrictEqual(errors, [], 'no renderer/preload errors');

  const diagnosticsVisible = await evaluate(`(() => { const card = buildCard({
    id: 'timing-test', ts: Date.now(), text: 'timed dictation',
    recognitionMs: 1476, modelRecognitionMs: 1200, rewriteMs: 2101,
    pasteMs: 150, stopToPasteMs: 3950,
    vocabulary: { summary: 'Qwen3-ASR · dictionary sent to the model · 8 terms' },
  }); return !!card.querySelector('.card-timing, .card-route'); })()`);
  assert.strictEqual(diagnosticsVisible, false,
    'history keeps timing and model-routing diagnostics internal');

  // Qwen acceleration must never look verified from the processor setting.
  payload = {
    ...payload,
    asrEngine: 'qwen3-asr',
    engineStatus: 'ready',
    asrRuntimeWouldHelp: false,
    asrEngineActive: 'qwen3-asr',
    device: 'cuda',
    asrOperation: null,
    asrRuntimeState: { status: 'idle' },
    cloudTranscription: false,
    modelPlan: speechPlan({ 'qwen3-asr': true, whisper: true }),
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
  await frames();
  // The processor tests above left CPU only, which is the one thing keeping
  // Qwen off the card, so the row offers the setting rather than a download.
  const cpuOnly = await gpuView();
  assert.deepStrictEqual([cpuOnly.hidden, cpuOnly.hint, cpuOnly.action, cpuOnly.label],
    [false, 'Your processor setting keeps Qwen3-ASR off your NVIDIA GPU.', 'use-gpu', 'Use NVIDIA GPU'], JSON.stringify(cpuOnly));
  const useGpuPatches = settingsPatches.length;
  const useGpuActions = actionCalls.length;
  await click('#speech-gpu-action');
  await waitFor('lastPayload.asrDevice === "auto" && !speechPending.has("gpu:use-gpu")');
  assert.deepStrictEqual(settingsPatches.slice(useGpuPatches), [{ asrDevice: 'auto' }], 'Use NVIDIA GPU puts Processor back on Auto, and nothing else');
  assert.strictEqual(actionCalls.length, useGpuActions, 'without downloading anything');
  await openAdvanced();
  const unverified = await downloadsView();
  assert.deepStrictEqual(unverified.items.find(i => i.key === 'qwen:cuda'), { key: 'qwen:cuda', name: 'NVIDIA speed-up for Qwen3-ASR',
    line: 'Qwen3-ASR stays on the processor until Voxden checks this download on your GPU.', size: '5.26 GB', state: null, remove: 'Remove', disabled: false },
  'an unverified pack says Qwen stays on the processor: ' + JSON.stringify(unverified));
  assert.strictEqual(await evaluate('speechGpuRowEl.hidden'), true, 'an installed pack is not offered again');
  assert.ok(!/using your GPU|acceleration is active/i.test(await panelText()), 'nothing claims the GPU before sidecar verification');

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
  await frames();
  const qwenPackLine = async () => (await downloadsView()).items.find(i => i.key === 'qwen:cuda').line;
  assert.strictEqual(await qwenPackLine(), 'Qwen3-ASR is using your GPU.', 'verified and running, the pack says so');
  assert.strictEqual(await evaluate('speechGpuRowEl.hidden'), true, 'a verified pack needs no GPU row');
  // While the engine loads, even a verified pack claims nothing yet.
  win.webContents.send('history-updated', { ...payload, engineStatus: 'loading', asrEngineProgress: { percent: 30 } });
  await frames();
  const loadingQwen = (await rowsView())[2];
  assert.deepStrictEqual([loadingQwen.state, loadingQwen.button, loadingQwen.progress, loadingQwen.line], ['Loading…', null, '30', null],
    'a loading model says Loading… with its progress, not In use: ' + JSON.stringify(loadingQwen));
  assert.strictEqual(await qwenPackLine(), null, 'a verified pack claims the GPU only once Qwen is running');
  win.webContents.send('history-updated', { ...payload, engineStatus: 'starting', asrEngineProgress: null });
  await frames();
  const startingQwen = (await rowsView())[2];
  assert.deepStrictEqual([startingQwen.state, startingQwen.progress, startingQwen.line], ['Loading…', null, 'Best with names and accents.'],
    'starting with no progress keeps the strength line: ' + JSON.stringify(startingQwen));
  win.webContents.send('history-updated', payload);
  await frames();
  assert.strictEqual((await rowsView())[2].state, 'In use');

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
  await frames();
  assert.strictEqual(await evaluate('speechGpuRowEl.hidden'), true, 'an unsupported AMD card is offered no pack');
  assert.strictEqual(await qwenPackLine(), null, 'and no pack claims the GPU for it');
  assert.ok(!/using your GPU|ROCm acceleration is active/i.test(await panelText()), 'unsupported AMD is not active ROCm');

  // --- Speed up with your GPU: one row, only when it helps the model in use --
  // Each pack belongs to one model. A GeForce with both packs on offer used to
  // show both cards under every engine, and the Whisper one read as a Qwen offer.
  const gpuBase = { ...payload, asrOperation: null, asrRuntimeState: { status: 'idle' }, cloudTranscription: false, engineStatus: 'ready',
    asrDevice: 'auto', device: 'cpu', gpu: { vendor: 'nvidia', label: 'NVIDIA GeForce RTX 4070', needsPack: true },
    cudaPack: { downloadSize: '553 MB' }, cudaPackState: { status: 'idle' },
    qwenAccel: { vendor: 'nvidia', gpuName: 'NVIDIA GeForce RTX 4070', uiStatus: 'offer', backend: 'cpu', verified: false,
      uiLabel: 'CPU Qwen', recommendedPack: 'cuda', supported: true, reason: 'Qwen CUDA acceleration is a separate download.' },
    qwenCudaPack: { installed: false, downloadSize: '2.8 GB' }, qwenCudaPackState: { status: 'idle' },
    qwenRocmPack: { installed: false, downloadSize: '2.5 GB' }, qwenRocmPackState: { status: 'idle' } };
  const gpuFor = async (engine, patch) => {
    await paint({ ...gpuBase, asrEngine: engine, modelPlan: speechPlan({ [engine]: true }), ...(patch || {}) });
    return gpuView();
  };
  const noGpuRow = async (engine, patch, message) => assert.strictEqual((await gpuFor(engine, patch)).hidden, true, message);
  const underQwen = await gpuFor('qwen3-asr');
  assert.deepStrictEqual([underQwen.hidden, underQwen.hint, underQwen.action, underQwen.kind, underQwen.label, underQwen.note],
    [false, 'Your NVIDIA GPU can run Qwen3-ASR after a one-time 2.8 GB download.', 'qwen-install', 'cuda', 'Download 2.8 GB', null],
    'Qwen in use is offered its own pack: ' + JSON.stringify(underQwen));
  const underWhisper = await gpuFor('whisper');
  assert.deepStrictEqual([underWhisper.hint, underWhisper.action, underWhisper.label],
    ['Your NVIDIA GPU can run Whisper large-v3 after a one-time 553 MB download.', 'cuda-install', 'Download 553 MB'],
    'Whisper in use is offered the cuBLAS pack, not Qwen’s: ' + JSON.stringify(underWhisper));
  // Turbo is CTranslate2 too, so the same pack moves it onto the GPU. The
  // large-v3 CPU figure is not repeated at it: it was never measured on turbo.
  const underTurbo = await gpuFor('whisper-turbo');
  assert.strictEqual(underTurbo.hint, 'Your NVIDIA GPU can run Whisper large-v3 turbo after a one-time 553 MB download.');
  assert.ok(!/twenty times/.test(underTurbo.hint), 'large-v3 timings are not quoted at turbo: ' + underTurbo.hint);
  await noGpuRow('parakeet', {}, 'no GPU row under Parakeet on a GeForce');
  await noGpuRow('parakeet', { gpu: { vendor: 'amd', needsPack: false }, qwenAccel: { vendor: 'amd', uiStatus: 'unsupported', supported: false } },
    'no GPU row under Parakeet on an AMD card either');
  await noGpuRow('whisper', { modelPlan: speechPlan({}) }, 'no offer for a model that is not downloaded');
  for (const device of ['cpu', 'directml']) {
    const offCard = await gpuFor('whisper', { asrDevice: device });
    assert.deepStrictEqual([offCard.hint, offCard.action, offCard.label], ['Your processor setting keeps Whisper off your NVIDIA GPU.', 'use-gpu', 'Use NVIDIA GPU'], device);
  }
  await noGpuRow('whisper', { gpu: { vendor: 'nvidia', needsPack: false }, device: 'cuda' }, 'Whisper already running on the card needs nothing');
  const fellBack = await gpuFor('whisper', { gpu: { vendor: 'nvidia', needsPack: false }, device: 'cpu' });
  assert.deepStrictEqual([fellBack.hidden, fellBack.hint, fellBack.hintError, fellBack.action],
    [false, 'Your NVIDIA GPU could not run Whisper, so it is using the processor.', true, null], 'a pack that did not take says so, with nothing to click');
  await noGpuRow('whisper', { gpu: { vendor: 'amd', needsPack: false } }, 'Whisper has no pack for an AMD or Intel card');
  const packFailed = await gpuFor('whisper', { cudaPackState: { status: 'error', message: 'Could not reach the Voxden GPU-support release on GitHub. Check the connection and try again.' } });
  assert.deepStrictEqual([packFailed.action, packFailed.error, packFailed.errorTone],
    ['cuda-install', 'Could not reach the Voxden GPU-support release on GitHub. Check the connection and try again.', true]);
  const packCancelled = await gpuFor('whisper', { cudaPackState: { status: 'cancelled', message: 'NVIDIA GPU support download cancelled. The partial download was kept so it can resume later.' } });
  assert.deepStrictEqual([packCancelled.error, packCancelled.errorTone], ['NVIDIA GPU support download cancelled. The partial download was kept so it can resume later.', false]);
  await noGpuRow('whisper', { cloudTranscription: true }, 'no GPU offer while Voxden Cloud listens');
  await noGpuRow('whisper', { asrOperation: 'remove' }, 'no GPU offer while another operation holds the engine');
  const runningPack = await gpuFor('whisper', { cloudTranscription: true, cudaPackState: { status: 'downloading', progress: 40 } });
  assert.deepStrictEqual([runningPack.hidden, runningPack.action, runningPack.label, runningPack.progress, runningPack.note],
    [false, 'cuda-cancel', 'Cancel', '40', 'You can keep dictating while it downloads.'], 'a running pack download keeps its bar and Cancel whatever else changed');
  const packUnderModelDownload = await gpuFor('whisper', { asrOperation: 'install', cudaPackState: { status: 'downloading', progress: 40 } });
  assert.deepStrictEqual([packUnderModelDownload.action, packUnderModelDownload.note], ['cuda-cancel', null],
    'while a model download pauses dictation, the pack does not promise dictation keeps working');
  // The pack restarts the engine once it lands. Until the old process exits
  // the snapshot still reads ready on the processor, which is not a failure.
  const landed = { gpu: { vendor: 'nvidia', needsPack: false }, device: 'cpu', cudaPack: { installed: true }, cudaPackState: { status: 'installed', progress: 100 } };
  assert.strictEqual((await gpuFor('whisper', landed)).hidden, true, 'a pack that has just landed is not called a failure before the engine restarts');
  await gpuFor('whisper', { ...landed, engineStatus: 'starting' });
  const restartedOnCpu = await gpuFor('whisper', landed);
  assert.deepStrictEqual([restartedOnCpu.hidden, restartedOnCpu.hint, restartedOnCpu.hintError], [false, 'Your NVIDIA GPU could not run Whisper, so it is using the processor.', true],
    'once the engine has restarted and is still on the processor, it says so');
  const qwenOffCard = await gpuFor('qwen3-asr', { asrDevice: 'cpu' });
  assert.deepStrictEqual([qwenOffCard.hint, qwenOffCard.action, qwenOffCard.label], ['Your processor setting keeps Qwen3-ASR off your NVIDIA GPU.', 'use-gpu', 'Use NVIDIA GPU']);
  const amdPlan = { vendor: 'amd', gpuName: 'AMD Radeon RX 7900 XTX', uiStatus: 'offer', backend: 'cpu', recommendedPack: 'rocm', supported: true };
  const qwenOffAmd = await gpuFor('qwen3-asr', { asrDevice: 'cpu', gpu: { vendor: 'amd', needsPack: false }, qwenAccel: amdPlan });
  assert.deepStrictEqual([qwenOffAmd.hint, qwenOffAmd.label], ['Your processor setting keeps Qwen3-ASR off your AMD GPU.', 'Use AMD GPU']);
  await noGpuRow('qwen3-asr', { asrDevice: 'cpu', qwenAccel: { ...amdPlan, uiStatus: 'unsupported', supported: false } }, 'an unsupported card is not offered from CPU only');
  // Under CPU only the plan skips its hardware checks, so the row repeats the ones Auto would apply.
  await noGpuRow('qwen3-asr', { asrDevice: 'cpu', gpu: { vendor: 'amd', needsPack: false }, qwenAccel: { ...amdPlan, windows11: false } },
    'a listed AMD card on Windows 10 is not offered from CPU only');
  await noGpuRow('qwen3-asr', { asrDevice: 'cpu', qwenAccel: { ...gpuBase.qwenAccel, driverVersion: '560.94' } },
    'an NVIDIA driver below the Qwen pack floor is not offered from CPU only');
  const dchDriver = await gpuFor('qwen3-asr', { asrDevice: 'cpu', qwenAccel: { ...gpuBase.qwenAccel, driverVersion: '32.0.15.6094' } });
  assert.deepStrictEqual([dchDriver.hidden, dchDriver.action], [false, 'use-gpu'], 'a Windows driver number is left to the engine probe, as the plan does');
  assert.strictEqual(await evaluate('SPEECH_QWEN_MIN_NVIDIA_DRIVER'), Number.parseFloat(require('../src/qwen-accel-catalog.json').cuda.minNvidiaDriver),
    'the renderer driver floor matches the catalog');
  const amdOffer = await gpuFor('qwen3-asr', { gpu: { vendor: 'amd', needsPack: false }, qwenAccel: amdPlan });
  assert.deepStrictEqual([amdOffer.hint, amdOffer.action, amdOffer.kind, amdOffer.label],
    ['Your AMD GPU can run Qwen3-ASR after a one-time 2.5 GB download.', 'qwen-install', 'rocm', 'Download 2.5 GB'], 'a listed AMD card is offered the ROCm pack');
  const qwenFallback = await gpuFor('qwen3-asr', { qwenAccel: { ...gpuBase.qwenAccel, uiStatus: 'fallback', sessionBlocked: true }, qwenCudaPack: { installed: true } });
  assert.deepStrictEqual([qwenFallback.hint, qwenFallback.hintError, qwenFallback.action, qwenFallback.label],
    ['Your GPU stopped working with Qwen3-ASR, so it is using the processor.', true, 'qwen-retry', 'Try GPU again']);
  const qwenInstalling = await gpuFor('qwen3-asr', { asrOperation: 'gpu-install', qwenCudaPackState: { status: 'downloading', progress: 55 } });
  assert.deepStrictEqual([qwenInstalling.hidden, qwenInstalling.action, qwenInstalling.kind, qwenInstalling.progress, qwenInstalling.note],
    [false, 'qwen-cancel', 'cuda', '55', 'Dictation on this PC is paused until this download finishes.'], 'the Qwen pack draws its own download under its lock');
  for (const uiStatus of ['installed', 'verified', 'unsupported', 'hidden']) {
    await noGpuRow('qwen3-asr', { qwenAccel: { ...gpuBase.qwenAccel, uiStatus }, qwenCudaPack: { installed: uiStatus === 'installed' || uiStatus === 'verified' } },
      'no Qwen row once the pack is ' + uiStatus);
  }
  await paint({ ...gpuBase, asrEngine: 'qwen3-asr', modelPlan: speechPlan({ 'qwen3-asr': true }), qwenCudaPack: { installed: true }, qwenCudaPackState: { status: 'downloading', progress: 10 } });
  assert.strictEqual((await downloadsView()).items.find(i => i.key === 'qwen:cuda').disabled, true, 'a pack cannot be removed while it downloads');
  // A tuned model runs Whisper large-v3 without the hosted weights, but only on
  // a working runtime. Without one, getting it back fetches the 3.1 GB weights
  // too, so the row must price that download rather than offer a bare Use.
  const tunedOnly = { ...gpuBase, asrEngine: 'parakeet', modelPlan: speechPlan({ parakeet: true }, { engine: 'parakeet' }),
    tunedModel: { builtAt: Date.now() }, useTunedModel: true };
  await paint({ ...tunedOnly, asrRuntime: { installed: true, needsUpgrade: false } });
  assert.deepStrictEqual([(await rowsView())[3].button, (await rowsView())[3].action], ['Use', 'use'], 'a tuned model on a working runtime is ready to use');
  await paint({ ...tunedOnly, asrRuntime: { installed: false } });
  const tunedNoRuntime = (await rowsView())[3];
  assert.deepStrictEqual([tunedNoRuntime.button, tunedNoRuntime.action, tunedNoRuntime.size], ['Download and use', 'install', '3.1 GB'],
    'without a runtime the tuned model does not make a 3.1 GB download look like Use: ' + JSON.stringify(tunedNoRuntime));
  win.webContents.send('history-updated', payload);
  await frames();

  // A fresh install starts on Parakeet. The 4.7 GB model is offered from its
  // own row as one click that downloads and switches, it is listed once, and
  // its row reads In use once Qwen is the engine.
  const upgradePlan = (installed, language) => require('../src/model-plan').plan({
    engine: 'parakeet', device: 'auto', language: language || 'en', sizes: speechSizes,
    installed: Object.assign({ parakeet: true }, installed || {}),
  });
  win.webContents.send('history-updated', { ...payload, ...cloudLanguagePayload(false), asrEngine: 'parakeet', asrOperation: null,
    asrRuntimeState: { status: 'idle' }, dictationLanguage: 'en', dictationLanguages: ['en'], modelPlan: upgradePlan() });
  await frames();
  const upgradeRows = await rowsView();
  assert.deepStrictEqual([upgradeRows[2].button, upgradeRows[2].size, upgradeRows[2].line, upgradeRows[2].disabled], ['Download and use', '4.7 GB', 'Best with names and accents.', false],
    'one click, priced: ' + JSON.stringify(upgradeRows[2]));
  assert.strictEqual(upgradeRows[0].state, 'In use', 'Parakeet is the model in use');
  // Every visible Download button in the panel whose row or section names Qwen:
  // a second offer (the GPU row, a Downloaded models entry) would count here.
  assert.deepStrictEqual(await evaluate(`(() => {
    const panel = document.querySelector('.settings-panel[data-cat="speech-engines"]');
    const offers = Array.from(panel.querySelectorAll('button')).filter(b => !b.closest('[hidden]') && /Download/.test(b.textContent)
      && /Qwen/.test((b.closest('li, .setting-row') || {}).textContent || ''));
    return offers.map(b => { const owner = b.closest('[data-engine]'); return owner ? owner.dataset.engine : b.id; });
  })()`), ['qwen3-asr'], 'Qwen is offered once, from its own row');
  assert.strictEqual((await noticeView()).text, null, 'a working model needs no notice');
  const upgradeLangHint = await evaluate('dictationLangHintEl.textContent');
  assert.ok(/English on this PC/.test(upgradeLangHint) && !/Parakeet/.test(upgradeLangHint), 'English on Parakeet needs no warning: ' + upgradeLangHint);
  extraInstalls = [];
  const upgradePatches = settingsPatches.length;
  await click(rowAction('qwen3-asr'));
  await frames();
  assert.deepStrictEqual(extraInstalls, [['qwen3-asr', { select: true }]], 'the row asks for the download and the switch together');
  assert.strictEqual(settingsPatches.length, upgradePatches, 'and does not switch engines before the download lands');

  // Extra languages need Cloud, not a local engine switch. Saved Hindi on a
  // Pro account with Cloud off is kept, but the row says English locally.
  win.webContents.send('history-updated', { ...payload, ...cloudLanguagePayload(false),
    account: cloudLanguagePayload(true).account, asrEngine: 'parakeet', asrOperation: null,
    asrRuntimeState: { status: 'idle' }, engineStatus: 'standby', dictationLanguage: 'en', dictationLanguages: ['hi'],
    cloudTranscription: false, dictationLanguageUnlocked: false, modelPlan: upgradePlan({}, 'hi') });
  await frames();
  const hindi = await evaluate(`({ line: document.querySelector('${row('qwen3-asr')} [data-role="line"]').textContent, langHint: dictationLangHintEl.textContent })`);
  assert.ok(/names and accents/.test(hindi.line) && !/Parakeet cannot recognise/.test(hindi.line), hindi.line);
  assert.ok(/Local dictation is English/.test(hindi.langHint) && /Hindi/.test(hindi.langHint), hindi.langHint);
  win.webContents.send('history-updated', { ...payload, ...cloudLanguagePayload(false),
    account: cloudLanguagePayload(true).account, asrEngine: 'parakeet', cloudTranscription: false,
    dictationLanguageUnlocked: false, asrOperation: null, asrRuntimeState: { status: 'idle' }, engineStatus: 'standby',
    dictationLanguages: ['en', 'hg'], modelPlan: upgradePlan({}, 'en') });
  await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const mixedHint = await evaluate('dictationLangHintEl.textContent');
  assert.ok(/Local dictation is English/.test(mixedHint) && /Hinglish/.test(mixedHint), mixedHint);

  // Downloaded but not in use: Use on the row, Remove under Advanced, no second download.
  win.webContents.send('history-updated', { ...payload, asrEngine: 'parakeet', asrOperation: null,
    asrRuntimeState: { status: 'idle' }, dictationLanguage: 'en', dictationLanguages: ['en'], modelPlan: upgradePlan({ 'qwen3-asr': true }) });
  await frames();
  const readyRows = await rowsView();
  assert.deepStrictEqual([readyRows[0].state, readyRows[2].button, readyRows[2].action], ['In use', 'Use', 'use'], 'a downloaded model offers Use: ' + JSON.stringify(readyRows));
  assert.deepStrictEqual((await downloadsView()).items.filter(i => i.key.startsWith('model:')).map(i => [i.key, i.state, i.remove]),
    [['model:parakeet', 'In use', null], ['model:qwen3-asr', null, 'Remove']],
    'the model in use cannot be removed; the other can');
  const patchesBefore = settingsPatches.length;
  const downloadsBeforeUse = [installs, extraInstalls.length];
  await evaluate(`document.querySelector('${rowAction('qwen3-asr')}').focus(); true`);
  await click(rowAction('qwen3-asr'));
  await waitFor(`!document.querySelector('${row('qwen3-asr')} [data-role="state"]').hidden && !speechPending.has('use:qwen3-asr')`);
  assert.deepStrictEqual(settingsPatches.slice(patchesBefore), [{ asrEngine: 'qwen3-asr' }], 'Use sets the engine and nothing else');
  assert.deepStrictEqual([installs, extraInstalls.length], downloadsBeforeUse, 'choosing a downloaded model downloads nothing');
  assert.deepStrictEqual(await evaluate(`[document.querySelector('${row('qwen3-asr')} [data-role="state"]').textContent,
    document.querySelector('${rowAction('qwen3-asr')}').hidden, document.activeElement === speechModelListEl]`),
  ['In use', true, true], 'the row reads In use, and focus falls back to the model list instead of the page');
  win.webContents.send('history-updated', { ...payload, asrEngine: 'parakeet', asrOperation: null,
    asrRuntimeState: { status: 'idle' }, modelPlan: upgradePlan({ 'qwen3-asr': true }) });
  await frames();
  await openAdvanced();
  await click(download('model:qwen3-asr') + ' [data-role="remove"]');
  assert.strictEqual(await evaluate("document.getElementById('confirm-title').textContent"), 'Remove Qwen3-ASR 1.7B?');
  await click('#confirm-ok');
  await frames();
  assert.deepStrictEqual(actionCalls.at(-1), ['speech-model-remove', 'qwen3-asr']);
  win.webContents.send('history-updated', payload);
  await frames();

  // Parakeet on an AMD or Intel card gets no GPU row. Advanced > Processor
  // offers the card, and asks before the separate download that needs. The
  // processor changes only once that download is on disk.
  const amdParakeet = { ...payload, asrEngine: 'parakeet', asrDevice: 'auto', engineStatus: 'ready',
    gpu: { vendor: 'amd', label: 'AMD Radeon RX 7800 XT', needsPack: false, accelerates: 'Parakeet' },
    qwenAccel: { vendor: 'amd', uiStatus: 'unsupported', backend: 'cpu', supported: false },
    modelPlan: speechPlan({ parakeet: true }, { engine: 'parakeet' }) };
  win.webContents.send('history-updated', amdParakeet);
  await frames();
  await openAdvanced();
  const parakeetAmd = await evaluate(`({ gpuHidden: speechGpuRowEl.hidden, options: Array.from(settingInputs.asrDevice.options, o => o.value),
    hint: speechProcessorHintEl.textContent, size: document.querySelector('${row('parakeet')} [data-role="size"]').textContent })`);
  assert.deepStrictEqual(parakeetAmd, { gpuHidden: true, options: ['auto', 'directml', 'cpu'],
    hint: 'Auto keeps Parakeet v3 on the processor; choose AMD or Intel GPU to run it on your graphics card.', size: '660 MB' },
  'Parakeet on AMD: no GPU row, and Processor offers the card: ' + JSON.stringify(parakeetAmd));
  assert.deepStrictEqual(await evaluate(`(() => { const trigger = document.querySelector('.custom-select:has(#asr-device-select) .custom-select-trigger');
    return [trigger.getAttribute('aria-labelledby'), document.getElementById('speech-processor-label').textContent, document.getElementById('speech-processor-value').textContent]; })()`),
  ['speech-processor-label speech-processor-value', 'Processor', 'Auto'], 'the Processor trigger people operate is named by its row label and its value');
  const amdPatches = settingsPatches.length;
  const amdInstalls = extraInstalls.length;
  await selectOption('asr-device-select', 'directml');
  await waitFor("document.getElementById('confirm-dialog').open");
  assert.deepStrictEqual(await confirmView(), { open: true, title: 'Switch Parakeet v3 to your AMD or Intel GPU?',
    body: 'This needs a separate 2.5 GB download, and dictation on this PC pauses until it finishes.', ok: 'Download and switch' });
  assert.strictEqual(await evaluate('settingInputs.asrDevice.value'), 'auto', 'Processor does not move while the question is open');
  await click('#confirm-cancel');
  await waitFor('!speechPending.has("processor")');
  assert.deepStrictEqual([settingsPatches.length, extraInstalls.length, await evaluate('settingInputs.asrDevice.value')], [amdPatches, amdInstalls, 'auto'],
    'Cancel changes nothing and downloads nothing');
  await selectOption('asr-device-select', 'directml');
  await waitFor("document.getElementById('confirm-dialog').open");
  await click('#confirm-ok');
  await waitFor('!speechPending.has("processor")');
  assert.deepStrictEqual(extraInstalls.slice(amdInstalls), [['parakeet-fp32', { select: true }]], 'confirming downloads the GPU weights first');
  assert.strictEqual(settingsPatches.length, amdPatches, 'and keeps the processor while they are not on disk');
  win.webContents.send('history-updated', amdParakeet);
  await frames();
  const beforeFp32 = payload;
  payload = { ...amdParakeet, modelPlan: speechPlan({ parakeet: true, 'parakeet-fp32': true }, { engine: 'parakeet', device: 'directml' }) };
  await selectOption('asr-device-select', 'directml');
  await waitFor("document.getElementById('confirm-dialog').open");
  await click('#confirm-ok');
  await waitFor('!speechPending.has("processor") && lastPayload.asrDevice === "directml"');
  assert.deepStrictEqual(extraInstalls.slice(amdInstalls), [['parakeet-fp32', { select: true }], ['parakeet-fp32', { select: true }]]);
  assert.deepStrictEqual(settingsPatches.slice(amdPatches), [{ asrDevice: 'directml' }], 'once the weights are on disk, the processor switches');
  assert.strictEqual(await evaluate(`document.querySelector('${row('parakeet')} [data-role="size"]').textContent`), '2.5 GB', 'and Parakeet is priced at the pack it now loads');
  assert.deepStrictEqual((await downloadsView()).items.filter(i => i.key.startsWith('model:')).map(i => [i.name, i.state, i.remove]),
    [['Parakeet v3', null, 'Remove'], ['Parakeet v3 for GPU', 'In use', null]],
    'the CPU pack becomes removable once the GPU pack is the one in use');
  payload = beforeFp32;
  win.webContents.send('history-updated', payload);
  await frames();

  const publish = async patch => {
    payload = { ...payload, ...patch };
    win.webContents.send('history-updated', payload);
    await settle();
  };
  const cudaOffer = { vendor: 'nvidia', recommendedPack: 'cuda', supported: true, uiStatus: 'offer',
    pack: { downloadSize: '3.09 GB' } };
  // The Qwen row's size is the live one from the release listing, looked up
  // once per pack however often the panel renders.
  await publish({ asrEngine: 'qwen3-asr', asrDevice: 'auto', engineStatus: 'ready', device: 'cpu', cloudTranscription: false, asrOperation: null,
    asrRuntimeState: { status: 'idle' }, modelPlan: speechPlan({ 'qwen3-asr': true, whisper: true }),
    gpu: { vendor: 'nvidia', label: 'NVIDIA GPU', needsPack: false },
    qwenAccel: cudaOffer, qwenCudaPackState: { status: 'idle' },
    qwenCudaPack: { installed: false, downloadSize: '', downloadSizeStatus: 'idle', downloadSizeRefreshAt: 0 } });
  await waitFor('qwenAccelInfoRequests.has("cuda")');
  const sizeChecking = await gpuView();
  assert.deepStrictEqual([sizeChecking.hint, sizeChecking.label, sizeChecking.note],
    ['Your NVIDIA GPU can run Qwen3-ASR after a one-time download.', 'Download', 'Checking download size…'], JSON.stringify(sizeChecking));
  await evaluate('for (let i = 0; i < 200; i++) renderSettings(lastPayload); true');
  assert.deepStrictEqual(accelInfoCalls, ['cuda'], 'repeated renders share the pending metadata request');
  payload = { ...payload, qwenCudaPack: { installed: false, downloadSizeStatus: 'ready',
    downloadSizeRefreshAt: Date.now() + 300000, downloadSize: '1.88–2.10 GB',
    downloadMinBytes: 1881694951, downloadBytes: 2101411351 } };
  finishAccelInfo();
  await waitFor('speechGpuActionBtn.textContent === "Download 1.88–2.10 GB" && !qwenAccelInfoRequests.has("cuda")');
  const compactOffer = await gpuView();
  assert.deepStrictEqual([compactOffer.hint, compactOffer.note], ['Your NVIDIA GPU can run Qwen3-ASR after a one-time 1.88–2.10 GB download.', null]);
  assert(!JSON.stringify(compactOffer).includes('3.09'), 'the legacy plan estimate cannot leak into the available size');
  await evaluate('for (let i = 0; i < 200; i++) renderSettings(lastPayload); true');
  assert.deepStrictEqual(accelInfoCalls, ['cuda'], 'cached metadata avoids repeated lookups');
  await publish({ qwenCudaPack: { ...payload.qwenCudaPack, downloadSize: '2.10 GB', downloadMinBytes: 2101411351 } });
  assert.deepStrictEqual(await evaluate('[speechGpuActionBtn.textContent, speechGpuHintEl.textContent]'),
    ['Download 2.10 GB', 'Your NVIDIA GPU can run Qwen3-ASR after a one-time 2.10 GB download.']);
  await publish({ qwenCudaPack: { installed: false, downloadSize: '', downloadSizeStatus: 'idle', downloadSizeRefreshAt: 0 } });
  await waitFor('qwenAccelInfoRequests.has("cuda")');
  payload = { ...payload, qwenCudaPack: { installed: false, downloadSizeStatus: 'unavailable',
    downloadSizeRefreshAt: Date.now() + 30000, downloadSize: '', downloadBytes: null, downloadMinBytes: null } };
  finishAccelInfo();
  await waitFor('document.getElementById("speech-gpu-note").textContent === "Download size is temporarily unavailable." && !qwenAccelInfoRequests.has("cuda")');
  const sizeOffline = await gpuView();
  assert.deepStrictEqual([sizeOffline.label, sizeOffline.disabled], ['Download', false], 'metadata failure still allows an installation retry');
  await evaluate('for (let i = 0; i < 200; i++) renderSettings(lastPayload); true');
  assert.deepStrictEqual(accelInfoCalls, ['cuda', 'cuda'], 'offline metadata lookup respects its retry delay');

  // Every GPU action goes through the one row button, each remove through
  // Advanced > Downloaded models with a confirm.
  await publish({ asrEngine: 'whisper', asrDevice: 'auto', device: 'cpu', gpu: { vendor: 'nvidia', label: 'NVIDIA GPU', needsPack: true },
    cudaPackState: { status: 'idle' }, cudaPack: { installed: false, downloadSize: '553 MB' } });
  await evaluate('for (let i = 0; i < 200; i++) renderSettings(lastPayload); true');
  assert.deepStrictEqual(await evaluate('[speechGpuActionBtn.dataset.action, speechGpuActionBtn.textContent]'), ['cuda-install', 'Download 553 MB']);
  await click('#speech-gpu-action');
  await frames();
  await publish({ cudaPackState: { status: 'downloading', progress: 25 } });
  const packDownload = await gpuView();
  assert.deepStrictEqual([packDownload.action, packDownload.label, packDownload.disabled, packDownload.progress, packDownload.note],
    ['cuda-cancel', 'Cancel', false, '25', 'You can keep dictating while it downloads.'], JSON.stringify(packDownload));
  // This pack downloads outside the engine lock: Processor stays usable, an
  // open Processor list survives a progress render, and so does focus on Cancel.
  await openAdvanced();
  assert.strictEqual(await evaluate('settingInputs.asrDevice.disabled'), false, 'a GPU pack download does not lock Processor');
  await click('.custom-select:has(#asr-device-select) .custom-select-trigger');
  await publish({ cudaPackState: { status: 'downloading', progress: 40 } });
  assert.deepStrictEqual(await evaluate(`[!document.querySelector('.custom-select:has(#asr-device-select) .custom-select-list').hidden,
    document.getElementById('speech-gpu-progress').getAttribute('aria-valuenow')]`), [true, '40'], 'the open Processor list stays open across a progress render');
  await evaluate('closeAllCustomSelects(); speechGpuActionBtn.focus(); true');
  await publish({ cudaPackState: { status: 'downloading', progress: 45 } });
  assert.deepStrictEqual(await evaluate('[document.activeElement === speechGpuActionBtn, speechAdvancedEl.open]'), [true, true],
    'focus on the pack Cancel and the open disclosure survive a progress render');
  const gpuArmed = await evaluate(`(() => {
    const snapshot = lastPayload;
    render({ ...snapshot, cudaPackState: { status: 'idle' } });
    render(snapshot);
    speechGpuActionBtn.click();
    return speechGpuActionBtn.dataset.action;
  })()`);
  await frames();
  assert.strictEqual(gpuArmed, 'cuda-cancel');
  assert.deepStrictEqual(actionCalls.at(-1), ['cuda-pack-install'], 'a pack Cancel that has just appeared ignores the click');
  await delay(550);
  await click('#speech-gpu-action');
  await frames();
  assert.deepStrictEqual(await evaluate('[speechGpuActionBtn.textContent, speechGpuActionBtn.getAttribute("aria-disabled")]'), ['Cancelling…', 'true'],
    'Cancel says it is working until the pack stops');
  await click('#speech-gpu-action');
  await publish({ gpu: { vendor: 'nvidia', label: 'NVIDIA GPU', needsPack: false }, device: 'cuda', cudaPackState: { status: 'idle' }, cudaPack: { installed: true } });
  assert.deepStrictEqual(await evaluate('[speechGpuRowEl.hidden, document.activeElement === speechModelListEl]'), [true, true],
    'an installed pack on a working card needs no row, and focus falls back to the model list');
  await click(download('cuda') + ' [data-role="remove"]');
  assert.deepStrictEqual(await confirmView(), { open: true, title: 'Remove NVIDIA speed-up for Whisper?',
    body: 'It frees 771 MB. You can download it again from here at any time.', ok: 'Remove' });
  await click('#confirm-ok');
  await frames();
  for (const kind of ['cuda', 'rocm']) {
    const stateKey = kind === 'cuda' ? 'qwenCudaPackState' : 'qwenRocmPackState';
    const packKey = kind === 'cuda' ? 'qwenCudaPack' : 'qwenRocmPack';
    const plan = { vendor: kind === 'cuda' ? 'nvidia' : 'amd', recommendedPack: kind, supported: true, uiStatus: 'offer' };
    const gpuButton = () => evaluate('[speechGpuActionBtn.dataset.action, speechGpuActionBtn.dataset.kind, speechGpuActionBtn.textContent]');
    await publish({ asrEngine: 'qwen3-asr', qwenAccel: plan, [stateKey]: { status: 'idle' }, [packKey]: { installed: false, downloadSize: '2.8 GB' } });
    await evaluate('for (let i = 0; i < 200; i++) renderSettings(lastPayload); true');
    assert.deepStrictEqual(await gpuButton(), ['qwen-install', kind, 'Download 2.8 GB'], kind + ' offer');
    await click('#speech-gpu-action');
    await frames();
    // main takes the engine lock at the click and stops the speech process
    // before the pack reports anything; the row and its focused button stay.
    await evaluate('speechGpuActionBtn.focus(); true');
    await publish({ asrOperation: 'gpu-install', [stateKey]: { status: 'idle' } });
    const stopping = await gpuView();
    assert.deepStrictEqual([stopping.hidden, stopping.action, stopping.label, stopping.disabled, stopping.progress, stopping.note,
      await evaluate('document.activeElement === speechGpuActionBtn')],
    [false, 'qwen-cancel', 'Cancel', true, '0', 'Dictation on this PC is paused until this download finishes.', true],
    kind + ' install keeps its row while the engine stops: ' + JSON.stringify(stopping));
    await publish({ asrOperation: 'gpu-install', [stateKey]: { status: 'downloading', progress: 50 } });
    assert.deepStrictEqual(await gpuButton(), ['qwen-cancel', kind, 'Cancel'], kind + ' download');
    await delay(550);
    await click('#speech-gpu-action');
    await frames();
    await publish({ asrOperation: null, qwenAccel: { ...plan, uiStatus: 'fallback', sessionBlocked: true }, [stateKey]: { status: 'idle' }, [packKey]: { installed: true } });
    assert.deepStrictEqual(await gpuButton(), ['qwen-retry', '', 'Try GPU again'], kind + ' fallback retries whichever pack is recommended');
    await click('#speech-gpu-action');
    await frames();
    await click(download('qwen:' + kind) + ' [data-role="remove"]');
    assert.strictEqual(await evaluate("document.getElementById('confirm-title').textContent"), 'Remove ' + (kind === 'cuda' ? 'NVIDIA' : 'AMD') + ' speed-up for Qwen3-ASR?');
    await click('#confirm-ok');
    await frames();
  }
  assert.deepStrictEqual(actionCalls, [
    ['speech-model-remove', 'whisper'], ['speech-model-remove', 'qwen3-asr'],
    ['cuda-pack-install'], ['cuda-pack-cancel'], ['cuda-pack-remove'],
    ['qwen-accel-install', 'cuda'], ['qwen-accel-cancel', 'cuda'], ['qwen-accel-retry'], ['qwen-accel-remove', 'cuda'],
    ['qwen-accel-install', 'rocm'], ['qwen-accel-cancel', 'rocm'], ['qwen-accel-retry'], ['qwen-accel-remove', 'rocm'],
  ], 'every moved action sends exactly one request with the correct pack');
  await publish({ tunedModel: { builtAt: Date.now() }, useTunedModel: false });
  assert.strictEqual(await evaluate('tunedRowEl.hidden'), true, 'a tuned model is offered only while Whisper large-v3 is in use');
  await publish({ asrEngine: 'whisper' });
  await openAdvanced();
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
      if (cat === 'speech-engines') {
        assert.strictEqual(await evaluate('speechAdvancedEl.open'), true, 'Advanced is still open for the session at ' + width);
        const cards = await evaluate(`(() => { const a = speechModeLocalEl.getBoundingClientRect(), b = speechModeCloudEl.getBoundingClientRect();
          return { sideBySide: b.left >= a.right && Math.abs(a.top - b.top) < 1, stacked: Math.abs(a.left - b.left) < 1 && b.top >= a.bottom }; })()`);
        assert.ok(width > 760 ? cards.sideBySide : cards.stacked,
          'the listen cards sit ' + (width > 760 ? 'side by side' : 'stacked') + ' at ' + width + ': ' + JSON.stringify(cards));
      }
      const selectors = cat === 'general'
        ? ['#shortcuts-change', '#mode-toggle', '#mode-ptt', '#quality-auto', '#quality-fast', '#quality-accurate', '.custom-select:has(#mic-select) .custom-select-trigger']
        : ['#speech-mode-local', '#speech-mode-cloud', rowAction('parakeet'), rowAction('qwen3-asr'), '#speech-advanced > summary',
          '.custom-select:has(#asr-device-select) .custom-select-trigger', '#tuned-row .toggle', download('model:qwen3-asr') + ' [data-role="remove"]',
          '#speech-repair', '#speech-remove-all'];
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
        for (const id of (cat === 'general' ? ['mic-select'] : ['asr-device-select'])) {
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

  // --- The account button in the title bar --------------------------------------
  win.setContentSize(1120, 760);
  await delay(250);
  await evaluate('closeSettings(); true');
  payload = { ...payload, signInRequired: false, account: { ...accountBase, signedIn: true, email: 'me@example.com', plan: 'pro', planExpiresAt: '2027-01-01T00:00:00.000Z',
    cloud: { hoursUsed: 1.25, hoursCap: 15, periodEnd: '2026-10-01T00:00:00.000Z' }, checkedAt: Date.now(), profile: { firstName: 'Me', lastName: 'Tester', pictureUrl: '' } } };
  win.webContents.send('history-updated', payload);
  await settle();
  assert.strictEqual(await evaluate("document.getElementById('account-btn').hidden"), false, 'a signed-in account shows its avatar in the title bar');
  assert.strictEqual(await evaluate("document.getElementById('account-btn').classList.contains('is-pro')"), true, 'Pro gets the gold ring');
  await click('#account-btn');
  assert.strictEqual(await evaluate("document.getElementById('account-menu').hidden"), false, 'the avatar opens the account sheet');
  assert.deepStrictEqual(await evaluate(`[document.getElementById('account-menu-name').textContent, document.getElementById('account-menu-email').textContent,
    document.getElementById('account-menu-plan').textContent, document.getElementById('account-menu-banner').classList.contains('is-pro')]`),
    ['Me Tester', 'me@example.com', 'VOXDEN PRO · 825 credits left', true], 'the sheet says who, the address, and the plan with credits left');
  await click('#account-menu-manage');
  assert.strictEqual(await evaluate("document.getElementById('account-menu').hidden && settingsOpen && settingsCat === 'account'"), true, 'Manage account opens the Account page');
  await evaluate('closeSettings(); true');
  // Follow the rail through a whole toggle, frame by frame: every icon (the
  // toggle's too) must hold its x, and the buttons at the foot must not move
  // up or down while cards above them fold.
  const toggleRail = async () => {
    await evaluate(`window.railWatch = (() => {
      const icons = [...document.querySelectorAll('#sidebar .nav-icon')];
      const foot = [document.getElementById('nav-settings'), document.getElementById('sidebar-toggle')];
      const cx = el => { const b = el.getBoundingClientRect(); return b.left + b.width / 2; };
      const x0 = icons.map(cx);
      const y0 = foot.map(el => el.getBoundingClientRect().top);
      const watch = { drift: 0, shift: 0, frames: 0, done: false };
      const tick = () => {
        watch.frames++;
        icons.forEach((icon, n) => { watch.drift = Math.max(watch.drift, Math.abs(cx(icon) - x0[n])); });
        foot.forEach((el, n) => { watch.shift = Math.max(watch.shift, Math.abs(el.getBoundingClientRect().top - y0[n])); });
        if (!watch.done) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      return watch;
    })(), true`);
    await click('#sidebar-toggle');
    await delay(450);
    return evaluate('(() => { railWatch.done = true; return railWatch; })()');
  };
  const railOffsets = () => evaluate(`(() => {
    const s = document.getElementById('sidebar').getBoundingClientRect();
    const rail = s.left + s.width / 2;
    return [...document.querySelectorAll('#sidebar .nav-icon')].map(icon => {
      const i = icon.getBoundingClientRect();
      const b = icon.closest('button').getBoundingClientRect();
      const x = i.left + i.width / 2;
      return Math.round(Math.max(Math.abs(x - rail), Math.abs(x - (b.left + b.width / 2)),
        Math.abs((i.top + i.height / 2) - (b.top + b.height / 2))) * 100) / 100;
    });
  })()`);
  const closing = await toggleRail();
  assert.strictEqual(await evaluate(`document.getElementById('sidebar').classList.contains('is-collapsed')`), true, 'the toggle closes the rail');
  assert.ok(closing.frames > 3 && closing.drift < 0.6,
    'no icon moves while the rail closes, the toggle included (' + closing.drift + 'px over ' + closing.frames + ' frames)');
  const closedOffsets = await railOffsets();
  assert.ok(Math.max(...closedOffsets) < 0.6,
    'closed, every icon is centred on the rail and in its own hover box (' + closedOffsets.join(', ') + ')');
  assert.strictEqual(await evaluate(`(() => { const a = document.getElementById('account-btn').getBoundingClientRect(); const b = document.getElementById('notif-btn').getBoundingClientRect();
    return a.left > b.right && Math.abs((a.top + a.height / 2) - (b.top + b.height / 2)) < 2 && a.width <= 28; })()`), true,
    'the avatar is a small button right beside the bell');
  const opening = await toggleRail();
  assert.ok(opening.drift < 0.6, 'no icon moves while the rail opens, the toggle included (' + opening.drift + 'px)');
  assert.deepStrictEqual(settingsPatches.slice(-2), [{ sidebarCollapsed: true }, { sidebarCollapsed: false }], 'each toggle saves the rail state');

  // The Free plan's upgrade card folds with the rail instead of re-wrapping
  // into it, so nothing below it is pushed around.
  payload = { ...payload, account: { ...payload.account, plan: 'free', cloud: { hoursUsed: 0, hoursCap: 0, periodEnd: null } } };
  win.webContents.send('history-updated', payload);
  await settle();
  assert.strictEqual(await evaluate(`document.getElementById('sidebar-pro').hidden`), false, 'Free shows the upgrade card');
  const freeClosing = await toggleRail();
  const freeOpening = await toggleRail();
  assert.ok(Math.max(freeClosing.shift, freeOpening.shift) < 0.6 && Math.max(freeClosing.drift, freeOpening.drift) < 0.6,
    'with the upgrade card, Settings and the toggle hold still both ways (' + freeClosing.shift + ' / ' + freeOpening.shift + 'px)');

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

  // General controls still save exactly once, render their confirmed value,
  // and recover when persistence fails after being moved into groups/details.
  if (!(await evaluate('settingsOpen'))) await click('#nav-settings');
  await category('general');
  if (!(await evaluate(`document.getElementById('general-more-options').open`))) await click('#general-more-options > summary');
  for (const mode of ['toggle', 'ptt', 'toggle']) {
    const before = settingsPatches.length;
    await click(mode === 'ptt' ? '#mode-ptt' : '#mode-toggle');
    assert.deepStrictEqual(settingsPatches.slice(before), [{ dictateMode: mode }]);
    assert.strictEqual(await evaluate(`document.getElementById('mode-${mode === 'ptt' ? 'ptt' : 'toggle'}').getAttribute('aria-checked')`), 'true');
    assert.match(await evaluate(`document.getElementById('dictation-mode-hint').textContent`), mode === 'ptt' ? /Hold.*Release/ : /Press once/);
  }
  for (const quality of ['auto', 'fast', 'accurate', 'auto']) {
    const before = settingsPatches.length;
    await click('#quality-' + quality);
    assert.deepStrictEqual(settingsPatches.slice(before), [{ dictationQuality: quality }]);
    assert.deepStrictEqual(await evaluate(`Array.from(document.querySelectorAll('[data-quality][aria-checked="true"]'), el => el.dataset.quality)`), [quality]);
  }
  for (const [selector, value] of [['#mode-ptt', 'toggle'], ['#quality-fast', 'auto']]) {
    const before = settingsPatches.length;
    rejectNextSettings = true;
    await click(selector);
    assert.strictEqual(settingsPatches.length, before, 'failed save cannot become the confirmed preference');
    assert.strictEqual(await evaluate(selector.startsWith('#mode') ? 'lastPayload.dictateMode' : 'lastPayload.dictationQuality'), value);
  }
  await click('#general-more-options > summary');
  assert.strictEqual(await evaluate(`document.getElementById('general-more-options').open`), false);
  win.webContents.send('open-settings', 'general#app-language');
  await settle();
  assert.strictEqual(await evaluate(`document.getElementById('general-more-options').open`), true, 'a direct link reveals its collapsed setting');
  assert.strictEqual(await evaluate('document.activeElement.dataset.settingsSection'), 'app-language');
  console.log('General: modes, all three speeds, save failures, disclosure and direct links passed; microphone and language flows passed above.');
  assert.deepStrictEqual(errors, [], 'no renderer/preload errors after exercising all settings');
  clearTimeout(deadline);
  console.log('all speech setup renderer tests passed');
  win.destroy();
  app.quit();
}).catch(err => { console.error(err); app.exit(1); });
