'use strict';

// The Game shortcut row in Settings > Shortcuts, in the real renderer against
// fixture IPC: it shows the saved key, picks a new one through the same key
// capture as the other two shortcuts, and is hidden on a Mac, where it does
// nothing. --screenshots writes the dialog in both themes to temp/ui-review.
const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'voxden-game-shortcut-ui-')));
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
const deadline = setTimeout(() => { console.error('Game shortcut UI timed out'); app.exit(1); }, 35000);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const errors = [];
const saves = [];
let snapshot = {};

async function openShortcuts(data) {
  snapshot = {
    displayName: 'Alex', shortcutLabel: 'Ctrl+Win', pasteLastShortcutLabel: 'Ctrl+Alt+V',
    entries: [], phrases: [], notifications: [], pendingPhrases: [], writingStyles: {}, soundsEnabled: false,
    ...data,
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
    document.getElementById('shortcuts-change').click(); true`);
  await pause(120);
  return { win, run };
}

async function screenshot(win, name) {
  if (!process.argv.includes('--screenshots')) return;
  await pause(150);
  const folder = path.join(__dirname, '../temp/ui-review');
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'game-shortcut-' + name + '.png'), (await win.webContents.capturePage()).toPNG());
}

app.whenReady().then(async () => {
  ipcMain.handle('app-load', () => snapshot);
  ipcMain.handle('settings-set', (_event, patch) => {
    saves.push(patch);
    snapshot = { ...snapshot, ...patch, gameShortcutLabel: patch.gameShortcut || snapshot.gameShortcutLabel };
    return snapshot;
  });

  let { win, run } = await openShortcuts({ appTheme: 'voxden', gameShortcut: 'F8', gameShortcutLabel: 'F8', gameShortcutEnabled: false });
  const readRow = () => run(`(() => {
    const row = document.getElementById('game-shortcut-row');
    return {
      open: document.getElementById('shortcuts-dialog').open,
      label: row.querySelector('.setting-label').textContent.trim(),
      hint: row.querySelector('.setting-hint').textContent.trim(),
      on: document.getElementById('set-game-shortcut').checked,
      keys: document.getElementById('game-shortcut-display').hidden ? null
        : document.getElementById('game-shortcut-display').textContent.trim(),
      change: !document.getElementById('game-shortcut-change').hidden,
      hidden: row.hidden,
    };
  })()`);
  const hint = 'Dictate into a game’s chat without leaving the game. While on, its key works only for Voxden.';
  // Off by default: the key is not shown, because nothing is taken.
  assert.deepStrictEqual(await readRow(), {
    open: true, label: 'Game shortcut', hint, on: false, keys: null, change: false, hidden: false,
  });
  console.log('ok the game shortcut starts off, with no key taken');
  await screenshot(win, 'voxden-off');

  await run(`document.getElementById('set-game-shortcut').click(); true`);
  await pause(120);
  assert.deepStrictEqual(saves.at(-1), { gameShortcutEnabled: true });
  assert.deepStrictEqual(await readRow(), {
    open: true, label: 'Game shortcut', hint, on: true, keys: 'F8', change: true, hidden: false,
  });
  console.log('ok turned on, it shows its key and can be changed');
  await screenshot(win, 'voxden');

  // The same capture as the other shortcuts: Change, then a key on its own.
  await run(`document.getElementById('game-shortcut-change').click(); true`);
  assert.strictEqual(await run(`document.getElementById('game-shortcut-change').textContent`), 'Listening…');
  await run(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'F7', bubbles: true })); true`);
  await pause(120);
  assert.deepStrictEqual(saves.at(-1), { gameShortcut: 'F7' });
  assert.strictEqual(await run(`document.getElementById('game-shortcut-display').textContent.trim()`), 'F7');
  assert.strictEqual(await run(`document.getElementById('game-shortcut-change').textContent`), 'Change');
  console.log('ok a new key is picked the same way as the other shortcuts');
  win.destroy();

  ({ win } = await openShortcuts({ appTheme: 'white', gameShortcut: 'F8', gameShortcutLabel: 'F8', gameShortcutEnabled: true }));
  await screenshot(win, 'white');
  win.destroy();

  ({ win, run } = await openShortcuts({ platform: 'darwin' }));
  assert.strictEqual(await run(`document.getElementById('game-shortcut-row').hidden`), true);
  console.log('ok the row is hidden on a Mac');
  win.destroy();

  assert.deepStrictEqual(errors, []);
  clearTimeout(deadline);
  console.log('Game shortcut settings UI passed');
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
