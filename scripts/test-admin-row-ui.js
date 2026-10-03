'use strict';

// Settings > System > Run as administrator, in the real renderer against
// fixture IPC: the button while Voxden is not elevated, the wait while Windows
// asks, the reason when it did not go through, the line that replaces the
// button once Voxden is elevated, the bell note's way into this pane, and no
// row at all on a Mac. Nothing is restarted: restart-as-admin is a stub.
// --screenshots writes the row in both themes to temp/ui-review.
const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'voxden-admin-row-ui-')));
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
const deadline = setTimeout(() => { console.error('Run as administrator UI timed out'); app.exit(1); }, 60000);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const errors = [];
let snapshot = {};
let restartCalls = 0;
let answerRestart = null;

const HINT = 'Only needed for games and apps that run as administrator. Windows asks first; it lasts until Voxden restarts.';
const NOTE = {
  id: 'admin-app:game.exe', kind: 'paste', title: 'Game.exe runs as administrator',
  body: 'Windows does not let Voxden hear its shortcuts or type into it while it is in front.',
  ts: Date.now(), unread: true, action: { settings: 'system' },
};

async function openSystem(data) {
  snapshot = {
    displayName: 'Alex', shortcutLabel: 'Ctrl+Win', entries: [], phrases: [], notifications: [],
    pendingPhrases: [], writingStyles: {}, soundsEnabled: false, version: '2.1.6', packaged: true,
    ...data,
  };
  const win = new BrowserWindow({
    show: false, width: 1120, height: 760, useContentSize: true,
    titleBarStyle: 'hidden', titleBarOverlay: { color: '#101113', symbolColor: '#a3ada6', height: 48 },
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
  await run(`navigator.mediaDevices.getUserMedia = async () => { throw new Error('No test microphone'); };
    navigator.mediaDevices.enumerateDevices = async () => []; true`);
  await pause(250);
  await run(`window.VoxdenAppTheme.apply(${JSON.stringify(snapshot.appTheme || 'voxden')});
    openSettingsTarget('system'); true`);
  await pause(250);
  return { win, run };
}

// What the row shows, as a person would see it: hidden means not drawn.
const rowState = run => run(`(() => {
  const shown = el => !!el && getComputedStyle(el).display !== 'none' && el.getClientRects().length > 0;
  const row = document.getElementById('run-as-admin-row');
  const btn = document.getElementById('run-as-admin-btn');
  const error = document.getElementById('run-as-admin-error');
  return {
    pane: document.querySelector('.settings-panel[data-cat="system"]').hidden === false,
    row: shown(row),
    label: row.querySelector('.setting-label').textContent.trim(),
    hint: document.getElementById('run-as-admin-hint').textContent.trim(),
    button: shown(btn) ? { text: btn.textContent.trim(), disabled: btn.disabled, cls: btn.className } : null,
    error: shown(error) ? error.textContent.trim() : null,
  };
})()`);

const clickButton = run => run(`document.getElementById('run-as-admin-btn').click(); true`);

async function screenshot(win, run, name) {
  if (!process.argv.includes('--screenshots')) return;
  // Settled colours, not a transition's first frame: reduced motion makes
  // every change a .01ms transition, and an offscreen page can sit on it.
  await run(`document.getAnimations().forEach(a => { try { a.finish(); } catch (_) {} });
    document.getElementById('run-as-admin-row').scrollIntoView({ block: 'center' }); true`);
  await pause(600);
  const folder = path.join(__dirname, '../temp/ui-review');
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'admin-row-' + name + '.png'), (await win.webContents.capturePage()).toPNG());
}

app.whenReady().then(async () => {
  ipcMain.handle('app-load', () => snapshot);
  ipcMain.handle('notifications-read', () => snapshot);
  ipcMain.handle('style-preview', (_event, text) => text);
  ipcMain.handle('restart-as-admin', () => {
    restartCalls += 1;
    return new Promise(resolve => { answerRestart = resolve; });
  });

  for (const theme of ['voxden', 'white']) {
    const { win, run } = await openSystem({ appTheme: theme, runningAsAdmin: false });
    assert.deepStrictEqual(await rowState(run), {
      pane: true, row: true, label: 'Run as administrator', hint: HINT,
      button: { text: 'Restart as administrator', disabled: false, cls: 'btn-secondary' }, error: null,
    });
    await screenshot(win, run, theme);

    // Windows is asking: one request, and the button cannot ask twice.
    await clickButton(run);
    await pause(60);
    await clickButton(run);
    await pause(60);
    assert.strictEqual(restartCalls, 1, 'a second click while Windows asks sends nothing');
    assert.deepStrictEqual((await rowState(run)).button, { text: 'Waiting for Windows…', disabled: true, cls: 'btn-secondary' });

    // A no at the prompt: the reason, under the hint, and the button back.
    answerRestart({ ok: false, reason: 'Not restarted: the Windows prompt was cancelled.' });
    await pause(80);
    assert.deepStrictEqual(await rowState(run), {
      pane: true, row: true, label: 'Run as administrator', hint: HINT,
      button: { text: 'Restart as administrator', disabled: false, cls: 'btn-secondary' },
      error: 'Not restarted: the Windows prompt was cancelled.',
    });
    // A broadcast in the meantime does not wipe the reason.
    win.webContents.send('history-updated', { ...snapshot });
    await pause(80);
    assert.strictEqual((await rowState(run)).error, 'Not restarted: the Windows prompt was cancelled.');
    await screenshot(win, run, theme + '-error');

    // Yes at the prompt: this window closes with the app, so the row only waits.
    await clickButton(run);
    await pause(60);
    assert.strictEqual(restartCalls, 2);
    assert.strictEqual((await rowState(run)).error, null, 'a new try clears the old reason');
    answerRestart({ ok: true });
    await pause(80);
    assert.deepStrictEqual((await rowState(run)).button, { text: 'Waiting for Windows…', disabled: true, cls: 'btn-secondary' });
    restartCalls = 0;
    win.destroy();
    console.log('ok ' + theme + ': the button, the wait, the reason when Windows says no');

    // Elevated: nothing to offer, and the row says so.
    const elevated = await openSystem({ appTheme: theme, runningAsAdmin: true });
    assert.deepStrictEqual(await rowState(elevated.run), {
      pane: true, row: true, label: 'Run as administrator', hint: 'Voxden is running as administrator.',
      button: null, error: null,
    });
    await screenshot(elevated.win, elevated.run, theme + '-elevated');
    elevated.win.destroy();
    console.log('ok ' + theme + ': running as administrator replaces the button with a line');
  }

  // The bell note an app run as administrator raises opens this pane.
  {
    const { win, run } = await openSystem({ runningAsAdmin: false, notifications: [NOTE], notificationsUnread: 1 });
    await run(`closeSettings(); true`);
    await pause(150);
    await run(`document.getElementById('notif-btn').click(); true`);
    await pause(200);
    assert.strictEqual(await run(`document.querySelectorAll('.notif-item[data-id="admin-app:game.exe"] .notif-open').length`), 1,
      'the note offers Open settings');
    await run(`document.querySelector('.notif-item[data-id="admin-app:game.exe"] .notif-open').click(); true`);
    await pause(200);
    assert.strictEqual(await run('settingsCat'), 'system');
    assert.strictEqual((await rowState(run)).row, true, 'and the row is there to press');
    win.destroy();
    console.log('ok the admin note opens Settings > System');
  }

  {
    const { win, run } = await openSystem({ platform: 'darwin' });
    const state = await run(`(() => { const row = document.getElementById('run-as-admin-row');
      return { hidden: row.hidden, drawn: getComputedStyle(row).display !== 'none' }; })()`);
    assert.deepStrictEqual(state, { hidden: true, drawn: false });
    win.destroy();
    console.log('ok the row is hidden on a Mac');
  }

  assert.deepStrictEqual(errors, []);
  clearTimeout(deadline);
  console.log('Run as administrator settings UI passed');
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
