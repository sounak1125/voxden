'use strict';

// The dashboard of a free-only build (no account service), in the real
// app.html over the real preload: sign-in, plans, Polish and Voxden Cloud are
// not on screen anywhere, the copy does not promise them, and a build that is
// pointed at a service still shows all of it.

const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { fitViewport } = require('./fit-viewport');
const { computeInsights } = require('../src/insights');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'voxden-free-only-ui-')));
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const deadline = setTimeout(() => { console.error('Free-only UI timed out'); app.exit(1); }, 120000);
process.on('uncaughtException', error => { console.error(error); app.exit(1); });
process.on('unhandledRejection', error => { console.error(error); app.exit(1); });

// Where to leave screenshots, for a person to look at. Optional.
const shots = process.env.VOXDEN_FREE_ONLY_SHOTS || '';

const errors = [];
const base = {
  appTheme: 'voxden', displayName: 'Sam', shortcutLabel: 'Ctrl+Win', localModelChosen: true,
  entries: Array.from({ length: 6 }, (_, i) => ({ id: 'e' + i, ts: Date.now() - i * 3600000, text: 'Send the notes before standup.', durationMs: 9000 })),
  phrases: [], pendingPhrases: [], notifications: [], writingStyles: {}, flowBarStyle: 'island', flowBarMotion: 'full',
  appVersion: '2.2.0', updateStatus: 'idle',
};
const freeOnly = { ...base, account: null, freeOnly: true, signInRequired: false, freeWords: null, cloudTranscription: false };
const withService = { ...base, freeOnly: false,
  account: { signedIn: true, email: 'sam@example.com', plan: 'free', cloud: { hoursUsed: 0, hoursCap: 0, periodEnd: null },
    checkedAt: Date.now(), profile: { firstName: 'Sam', lastName: '' } },
  freeWords: { cap: 3000, used: 1760, remaining: 1240, percent: 59, exhausted: false, resetsOn: '2026-12-01' } };
let snapshot = freeOnly;

app.whenReady().then(async () => {
  ipcMain.on('app-theme-get', event => { event.returnValue = snapshot.appTheme; });
  ipcMain.handle('app-load', () => snapshot);
  ipcMain.handle('insights-get', (_e, range) => computeInsights(snapshot.entries, { range }));
  ipcMain.handle('notifications-read', () => snapshot);
  ipcMain.handle('account-billing-options', () => snapshot);
  ipcMain.handle('settings-set', (_e, patch) => (snapshot = { ...snapshot, ...patch }));
  const win = new BrowserWindow({ show: false, width: 1200, height: 780, useContentSize: true,
    backgroundColor: '#101113', titleBarStyle: 'hidden', titleBarOverlay: { color: '#101113', symbolColor: '#a3ada6', height: 60 },
    webPreferences: { preload: path.join(__dirname, '../src/preload.js'), additionalArguments: ['--voxden-theme-bootstrap'],
      contextIsolation: true, sandbox: false, backgroundThrottling: false, offscreen: true } });
  win.webContents.on('console-message', event => {
    if ((event.level === 'error' || Number(event.level) >= 3) && !/Content-Security-Policy/.test(event.message)) errors.push(event.message);
  });
  await win.loadFile(path.join(__dirname, '../src/app.html'));
  const run = code => win.webContents.executeJavaScript(code);
  const waitFor = async expression => {
    for (let i = 0; i < 100; i++) { if (await run(expression)) return; await pause(20); }
    assert.fail(expression);
  };
  const shoot = async (name) => {
    if (!shots) return;
    await pause(1500);
    fs.mkdirSync(shots, { recursive: true });
    fs.writeFileSync(path.join(shots, name + '.png'), (await win.webContents.capturePage()).toPNG());
  };
  await run(`navigator.mediaDevices.getUserMedia = async () => { throw new Error('No test microphone'); };
    navigator.mediaDevices.enumerateDevices = async () => []; true`);
  await waitFor('!!lastPayload');
  assert.ok(await fitViewport(win, 1200, 780), 'the page is 1200px wide');
  await pause(200);

  // --- Free-only: nothing paid is on screen ----------------------------------
  const paid = `[...document.querySelectorAll('[data-paid]')].map(el => [el.id || el.dataset.cat || el.className, getComputedStyle(el).display])`;
  const first = await run(`({
    flag: document.documentElement.classList.contains('free-only'),
    paid: ${paid},
    sections: [...document.querySelectorAll('#island > .island-link')].filter(b => getComputedStyle(b).display !== 'none').map(b => b.dataset.view),
    view: view,
    proWords: [...document.querySelectorAll('#island *, .titlebar-end *')].filter(el => el.offsetParent && /\\b(Pro|PRO|Upgrade|Sign in)\\b/.test(el.textContent)).map(el => el.id || el.className),
    engines: document.getElementById('help-engines-note').textContent,
    privacy: document.getElementById('help-privacy-note').textContent,
  })`);
  assert.strictEqual(first.flag, true, 'the page knows the build is free-only');
  assert.ok(first.paid.length >= 9, 'the paid parts are tagged');
  assert.deepStrictEqual(first.paid.filter(([, display]) => display !== 'none'), [], 'none of them is displayed');
  assert.deepStrictEqual(first.sections, ['dictation', 'dictionary', 'writing-style', 'insights'], 'the island has no Polish section');
  assert.deepStrictEqual(first.proWords, [], 'the header offers no Pro, upgrade or sign-in');
  const pills = await run(`[...document.querySelectorAll('.pill-polish')].map(el => getComputedStyle(el).display)`);
  assert.ok(pills.length > 0 && pills.every(d => d === 'none'), 'no dictation card offers Polish');
  assert.ok(!/Cloud|Pro\b/.test(first.engines + first.privacy), 'Help no longer mentions Voxden Cloud or Pro');
  assert.ok(/stays on this PC/.test(first.privacy), 'and says the audio stays on this PC');
  await shoot('dashboard');

  // Polish cannot be opened, even by a click that reaches its hidden button.
  await run(`document.getElementById('nav-polish').click(); true`);
  assert.strictEqual(await run('view'), first.view, 'a click on the hidden Polish button changes nothing');
  assert.strictEqual(await run(`document.getElementById('view-polish').hidden`), true, 'and the Polish page stays closed');

  // Settings: no Account, no Plans & billing, no "How Voxden listens", and the
  // language row does not point at a plan.
  await run(`document.getElementById('nav-settings').click(); true`);
  await pause(200);
  const settings = await run(`({
    cats: [...document.querySelectorAll('.settings-cat')].filter(b => getComputedStyle(b).display !== 'none').map(b => b.dataset.cat),
    hint: document.getElementById('dictation-lang-hint').textContent,
    open: !document.getElementById('settings-overlay').hidden,
  })`);
  assert.strictEqual(settings.open, true, 'Settings opens');
  assert.ok(settings.cats.length >= 3 && !settings.cats.includes('account') && !settings.cats.includes('billing'),
    'Settings lists no Account and no Plans & billing: ' + settings.cats.join(', '));
  assert.strictEqual(settings.hint, 'English on this PC.', 'the language hint stops at English');
  await run(`openSettingsTarget('billing'); true`);
  assert.ok(!['account', 'billing'].includes(await run('settingsCat')), 'a link to billing goes nowhere');
  await run(`setSettingsCat('speech-engines'); true`);
  await pause(150);
  assert.strictEqual(await run(`getComputedStyle(document.getElementById('speech-mode-section')).display`), 'none', 'the Cloud choice is gone from Speech engines');
  await shoot('settings-speech');
  await run(`setSettingsCat('general'); true`);
  await pause(150);
  await shoot('settings-general');
  await run('closeSettings(); true');

  // --- A build pointed at a service still has all of it ----------------------
  snapshot = withService;
  win.webContents.send('history-updated', snapshot);
  await pause(250);
  const second = await run(`({
    flag: document.documentElement.classList.contains('free-only'),
    polish: getComputedStyle(document.getElementById('nav-polish')).display,
    cats: [...document.querySelectorAll('.settings-cat')].filter(b => getComputedStyle(b).display !== 'none').map(b => b.dataset.cat),
  })`);
  assert.strictEqual(second.flag, false, 'a build with a service is not free-only');
  assert.notStrictEqual(second.polish, 'none', 'and shows Polish');
  assert.ok(second.cats.includes('account') && second.cats.includes('billing'), 'and Account and Plans & billing');

  assert.deepStrictEqual(errors, [], 'no renderer errors');
  console.log('Free-only dashboard: paid parts hidden, copy reworded, Polish and billing unreachable, and a build with a service unchanged.');
  clearTimeout(deadline);
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
