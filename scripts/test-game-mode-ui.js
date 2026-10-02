'use strict';

// The Game Mode row in Settings > General > More options, in the real renderer
// against fixture IPC: it shows the saved choice, saves a new one, and is
// hidden on a Mac, where Game Mode does nothing. --screenshots writes the row
// in both themes to temp/ui-review.
const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'voxden-game-mode-ui-')));
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
const deadline = setTimeout(() => { console.error('Game Mode UI timed out'); app.exit(1); }, 35000);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const errors = [];
const saves = [];
let snapshot = {};

async function openSettings(data) {
  snapshot = {
    displayName: 'Alex', shortcutLabel: 'F8', entries: [], phrases: [], notifications: [],
    pendingPhrases: [], writingStyles: {}, soundsEnabled: false, ...data,
  };
  const win = new BrowserWindow({
    show: false, width: 900, height: 760, frame: false, transparent: true, useContentSize: true,
    webPreferences: {
      preload: path.join(__dirname, '../src/preload.js'), contextIsolation: true,
      sandbox: false, backgroundThrottling: false, offscreen: true,
    },
  });
  win.webContents.on('console-message', (event, level, message) => {
    const severity = event.level === undefined ? level : event.level;
    const text = event.message === undefined ? message : event.message;
    if ((severity === 'error' || Number(severity) >= 3) && !/Content-Security-Policy/.test(String(text))) errors.push(String(text));
  });
  await win.loadFile(path.join(__dirname, '../src/app.html'));
  const run = code => win.webContents.executeJavaScript(code);
  await pause(200);
  await run(`document.getElementById('nav-settings').click();
    document.querySelector('#general-more-options > summary').click(); true`);
  await pause(80);
  return { win, run };
}

async function screenshot(win, run, name) {
  if (!process.argv.includes('--screenshots')) return;
  await run(`document.getElementById('game-mode-row').scrollIntoView({ block: 'center' }); true`);
  await pause(120);
  const folder = path.join(__dirname, '../temp/ui-review');
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'game-mode-' + name + '.png'), (await win.webContents.capturePage()).toPNG());
}

app.whenReady().then(async () => {
  ipcMain.handle('app-load', () => snapshot);
  ipcMain.handle('settings-set', (_event, patch) => {
    saves.push(patch);
    snapshot = { ...snapshot, ...patch };
    return snapshot;
  });

  // A settings file from before Game Mode has no gameMode: the row shows Auto.
  let { win, run } = await openSettings({ appTheme: 'voxden' });
  const row = await run(`(() => {
    const select = document.getElementById('game-mode-select');
    return {
      panel: select.closest('.settings-panel').dataset.cat,
      label: [...select.labels].map(l => l.textContent.trim()).join(' '),
      hint: document.getElementById(select.getAttribute('aria-describedby')).textContent.trim(),
      value: select.value,
      shown: document.querySelector('#game-mode-row .custom-select-label').textContent,
      options: [...select.options].map(o => o.value + ':' + o.textContent.trim()),
      hidden: document.getElementById('game-mode-row').hidden,
    };
  })()`);
  assert.deepStrictEqual(row, {
    panel: 'general',
    label: 'Game Mode',
    hint: 'In games, keeps their sound on and leaves your keys alone.',
    value: 'auto',
    shown: 'Fullscreen apps',
    options: ['auto:Fullscreen apps', 'always:Always', 'off:Off'],
    hidden: false,
  });
  console.log('ok the row shows Auto for settings saved before Game Mode');

  // Through the dropdown drawn over the select, as a person picks.
  await run(`document.querySelector('#game-mode-row .custom-select-trigger').click(); true`);
  await run(`document.querySelector('#game-mode-row .custom-select-option[data-value="off"]').click(); true`);
  await pause(80);
  assert.deepStrictEqual(saves.at(-1), { gameMode: 'off' });
  assert.strictEqual(await run(`document.querySelector('#game-mode-row .custom-select-label').textContent`), 'Off');
  console.log('ok choosing Off saves it');
  await screenshot(win, run, 'voxden');
  win.destroy();

  ({ win, run } = await openSettings({ appTheme: 'white', gameMode: 'always' }));
  assert.strictEqual(await run(`document.getElementById('game-mode-select').value`), 'always');
  // What is on screen is the dropdown's label, not the select's value.
  assert.strictEqual(await run(`document.querySelector('#game-mode-row .custom-select-label').textContent`), 'Always');
  console.log('ok a saved choice is shown');
  await screenshot(win, run, 'white');
  win.destroy();

  ({ win, run } = await openSettings({ platform: 'darwin' }));
  assert.strictEqual(await run(`document.getElementById('game-mode-row').hidden`), true);
  assert.strictEqual(await run(`document.getElementById('general-more-hint').textContent`),
    'Speed, app language & dictionary learning', 'the summary does not promise a row the Mac hides');
  console.log('ok the row is hidden on a Mac');
  win.destroy();

  assert.deepStrictEqual(errors, []);
  clearTimeout(deadline);
  console.log('Game Mode settings UI passed');
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
