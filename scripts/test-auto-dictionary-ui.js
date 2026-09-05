'use strict';

// Run the real renderer and preload against isolated IPC fixtures. No microphone,
// user dictionary, or external target application is opened by this test.
const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'voxden-auto-dictionary-ui-')));
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
const deadline = setTimeout(() => { console.error('Auto dictionary UI timed out'); app.exit(1); }, 35000);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const errors = [];
const saves = [];
const undos = [];
const actions = [];
let undoResult = { ok: true };
let undoDelay = 0;
let snapshot = {
  displayName: 'Alex', shortcutLabel: 'Ctrl+Shift+Space', entries: [], phrases: [],
  notifications: [], pendingPhrases: [], writingStyles: {}, autoSend: {}, soundsEnabled: false,
};

function makeWindow(width, height) {
  const win = new BrowserWindow({
    show: false, width, height, frame: false, transparent: true, useContentSize: true,
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
  return win;
}

async function screenshot(win, name) {
  if (!process.argv.includes('--screenshots')) return;
  await pause(50);
  const folder = path.join(__dirname, '../temp/ui-review');
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'auto-dictionary-' + name + '.png'), (await win.webContents.capturePage()).toPNG());
}

app.whenReady().then(async () => {
  ipcMain.handle('app-load', () => snapshot);
  ipcMain.handle('settings-set', (_event, patch) => {
    saves.push(patch);
    snapshot = { ...snapshot, ...patch };
    return snapshot;
  });
  ipcMain.handle('dict-auto-undo', async (_event, token) => {
    undos.push(token);
    const result = undoResult;
    await pause(undoDelay);
    return result;
  });
  ipcMain.on('overlay-hold', () => actions.push('hold'));
  ipcMain.on('overlay-release', () => actions.push('release'));
  ipcMain.on('hud-confirm', () => actions.push('confirm'));
  ipcMain.handle('toggle', () => { actions.push('toggle'); return {}; });

  const settings = makeWindow(900, 760);
  await settings.loadFile(path.join(__dirname, '../src/app.html'));
  const settingsRun = code => settings.webContents.executeJavaScript(code);
  await pause(200);
  await settingsRun(`document.getElementById('nav-settings').click(); true`);
  assert.strictEqual(await settingsRun(`document.getElementById('set-auto-add-dictionary').checked`), true, 'older snapshots default to auto-add enabled');
  const toggle = await settingsRun(`(() => { const e = document.getElementById('set-auto-add-dictionary');
    return { category: e.closest('.settings-panel').dataset.cat, name: [...e.labels].map(l => l.textContent.trim()).filter(Boolean).join(' '), description: e.getAttribute('aria-describedby') };
  })()`);
  assert.strictEqual(toggle.category, 'general');
  assert.ok(toggle.name.includes('Auto-add to dictionary'), 'toggle has an accessible name');
  assert.ok(toggle.description.includes('auto-add-dictionary-scope'), 'local supported-app scope is associated with the toggle');
  await settingsRun(`document.getElementById('set-auto-add-dictionary').click(); true`);
  await pause(80);
  assert.deepStrictEqual(saves.at(-1), { autoAddToDictionary: false });
  assert.strictEqual(await settingsRun(`document.getElementById('set-auto-add-dictionary').checked`), false, 'saved off state renders');
  await settings.reload();
  await pause(200);
  assert.strictEqual(await settingsRun(`document.getElementById('set-auto-add-dictionary').checked`), false, 'disabled preference survives reloading');
  await settingsRun(`document.getElementById('nav-settings').click(); document.getElementById('set-auto-add-dictionary').click(); true`);
  await pause(80);
  assert.deepStrictEqual(saves.at(-1), { autoAddToDictionary: true });
  await settingsRun(`document.getElementById('set-auto-add-dictionary').scrollIntoView({ block: 'center' }); true`);
  await screenshot(settings, 'settings');
  settings.destroy();

  const overlay = makeWindow(460, 84);
  await overlay.loadFile(path.join(__dirname, '../src/overlay.html'));
  const run = code => overlay.webContents.executeJavaScript(code);
  const state = async payload => {
    overlay.webContents.send('state', { soundsEnabled: false, ...payload });
    await pause(300);
  };
  const geometry = () => run(`(() => {
    const p = pill.getBoundingClientRect(), u = btnUndo.getBoundingClientRect(), l = label.getBoundingClientRect();
    const css = getComputedStyle(btnUndo);
    return { fits: p.left >= 0 && p.right <= innerWidth && p.top >= 0 && p.bottom <= innerHeight,
      undoFits: u.left >= p.left && u.right <= p.right && u.top >= p.top && u.bottom <= p.bottom,
      labelFits: l.left >= p.left && l.right <= u.left, readable: l.width > 35,
      undoVisible: Number(css.opacity) > .9 && css.pointerEvents === 'auto' && !btnUndo.disabled,
      retryVisible: Number(getComputedStyle(btnConfirm).opacity) > .1, editable: label.isContentEditable,
      active: isActiveHud(), ignored: ignoreMouse, focused: document.activeElement.id };
  })()`);

  for (const style of ['classic', 'ribbon', 'orb']) {
    await state({ mode: 'idle', alwaysShowFlowBar: true, flowBarStyle: style });
    await state({ mode: 'learned', text: 'Added “Kubernetes” to dictionary', undoToken: style, canRetry: true });
    const g = await geometry();
    assert.ok(g.fits && g.undoFits && g.labelFits && g.readable, style + ' notice and Undo fit inside the flow bar');
    assert.ok(g.undoVisible && !g.retryVisible && !g.editable, style + ' learned state exposes only Undo');
    assert.ok(g.active && g.ignored === false, style + ' learned state accepts pointer input');
    assert.strictEqual(g.focused, '', 'notice does not focus a control');
    assert.strictEqual(await run(`label.getAttribute('role')`), 'status');
    assert.strictEqual(await run(`label.title`), 'Added “Kubernetes” to dictionary');
    await screenshot(overlay, style);

    actions.length = 0;
    await run(`pill.dispatchEvent(new PointerEvent('pointerenter')); true`);
    await pause(30);
    assert.strictEqual(actions.at(-1), 'hold', 'hover keeps Undo available');
    await run(`pill.dispatchEvent(new PointerEvent('pointerleave')); true`);
    await pause(30);
    assert.strictEqual(actions.at(-1), 'release', 'leaving resumes notice dismissal');
    assert.strictEqual(await run(`btnUndo.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))`), false, 'mouse press prevents focus transfer');
    const priorUndos = undos.length;
    undoDelay = 120;
    await run(`btnUndo.click(); btnUndo.click(); true`);
    await pause(40);
    assert.strictEqual(await run('btnUndo.disabled'), true, 'Undo disables while its IPC request is pending');
    await pause(130);
    assert.strictEqual(undos.length, priorUndos + 1, 'a repeated click cannot undo twice');
    assert.strictEqual(undos.at(-1), style, 'Undo passes the exact token through the production preload');
    assert.ok(!actions.includes('toggle') && !actions.includes('confirm'), 'Undo never starts or retries dictation');
    await state({ mode: 'learned', text: 'Dictionary addition undone', undoToken: '' });
    assert.strictEqual(await run('btnUndo.disabled'), true);
    assert.strictEqual(await run('btnUndo.tabIndex'), -1);
    assert.strictEqual(await run(`pill.classList.contains('can-undo')`), false);
  }

  overlay.setContentSize(260, 84);
  const hostileText = 'Added “<img src=x onerror=alert(1)>” to dictionary';
  await state({ mode: 'learned', text: hostileText, undoToken: 'long-word' });
  assert.strictEqual(await run('label.textContent'), hostileText, 'learned terms are plain text');
  assert.strictEqual(await run('label.children.length'), 0, 'terms cannot inject markup');
  const narrow = await geometry();
  assert.ok(narrow.fits && narrow.undoFits && narrow.labelFits && narrow.readable && narrow.undoVisible, 'long terms truncate without displacing Undo in a narrow window');

  await run(`pill.dispatchEvent(new PointerEvent('pointerenter')); true`);
  await pause(30);
  actions.length = 0;
  await state({ mode: 'learned', text: 'Added 2 words to dictionary', undoToken: 'new-receipt' });
  assert.strictEqual(actions.at(-1), 'hold', 'an updated notice renews its dismissal hold while already hovered');
  await run(`pill.dispatchEvent(new PointerEvent('pointerleave')); true`);

  undoResult = { ok: false, error: 'This dictionary entry has changed.' };
  undoDelay = 0;
  await run('btnUndo.click(); true');
  await pause(100);
  assert.strictEqual(await run('label.textContent'), undoResult.error, 'Undo failure explains why the addition remains');
  assert.strictEqual(await run('btnUndo.disabled'), false, 'failure leaves the action available');

  undoDelay = 180;
  await run('btnUndo.click(); true');
  await state({ mode: 'idle' });
  assert.strictEqual(await run('hudMode'), 'idle', 'late Undo results never replace a newer state');
  assert.strictEqual(await run('learnedUndoToken'), '', 'leaving the notice discards its action token');
  assert.deepStrictEqual(errors, []);
  clearTimeout(deadline);
  overlay.destroy();
  console.log('Auto dictionary settings, safe notices, Undo IPC and all flow bar styles passed.');
  app.quit();
}).catch(error => { console.error(error); app.exit(1); });
