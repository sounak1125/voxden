'use strict';

// Drives the real renderer for the Dictation page cards: the ⋯ menu, what it
// offers with and without a kept recording, the player it opens, and the
// retry, save and delete round-trips through IPC. The main-process half --
// retention, the sidecar, the save dialog -- is stubbed here and tested in
// test-corpus.js and by hand.

const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'voxden-history-ui-')));
app.disableHardwareAcceleration();
const deadline = setTimeout(() => { console.error('History UI test timed out'); app.exit(1); }, 25000);

function wav(seconds) {
  const rate = 16000;
  const n = Math.round(rate * seconds);
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(n * 2, 40);
  return buf;
}

let entries = [
  { id: 'with', ts: Date.now(), text: 'a dictation with its recording', durationMs: 1200, audio: true },
  { id: 'without', ts: Date.now() - 60000, text: 'an older dictation whose recording is gone' },
];
let keepRecordings = true;
const calls = { audio: 0, save: 0, retry: 0, del: 0, settings: [] };

function payload() {
  return {
    entries,
    phrases: [],
    pendingPhrases: [],
    notifications: [],
    notificationsUnread: 0,
    keepRecordings,
    recordings: { count: 1, bytes: 38444 },
  };
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: 1120,
    height: 760,
    useContentSize: true,
    webPreferences: {
      preload: path.join(__dirname, '../src/preload.js'),
      contextIsolation: true,
      sandbox: false,
      backgroundThrottling: false,
    },
  });

  const errors = [];
  win.webContents.on('console-message', (event, level, message) => {
    const lvl = event && event.level !== undefined ? event.level : level;
    const text = event && event.message !== undefined ? event.message : message;
    const bad = lvl === 'error' || Number(lvl) >= 3;
    if (bad && !/Content-Security-Policy/.test(String(text))) errors.push(String(text));
  });

  ipcMain.handle('app-load', async () => payload());
  ipcMain.handle('history-copy', async () => true);
  ipcMain.handle('history-audio', async (_e, id) => {
    calls.audio += 1;
    if (id !== 'with') return { ok: false, reason: 'No recording kept for this dictation.' };
    return { ok: true, bytes: wav(1.2), seconds: 1.2 };
  });
  ipcMain.handle('history-audio-save', async (_e, id) => {
    calls.save += 1;
    return id === 'with' ? { ok: true, path: 'C:\\Users\\x\\Downloads\\Voxden.wav' } : { ok: false, reason: 'No recording kept for this dictation.' };
  });
  ipcMain.handle('history-retry', async (_e, id) => {
    calls.retry += 1;
    if (id !== 'with') return { ok: false, reason: 'No recording kept for this dictation.' };
    // Main saves and broadcasts before it answers, so the renderer sees the
    // new text arrive ahead of the reply, exactly as in the app.
    entries = entries.map((e) => (e.id === id ? Object.assign({}, e, { text: 'a dictation retried by the engine' }) : e));
    win.webContents.send('history-updated', payload());
    return { ok: true, changed: true, text: 'a dictation retried by the engine' };
  });
  ipcMain.handle('history-delete', async (_e, id) => {
    calls.del += 1;
    entries = entries.filter((e) => e.id !== id);
    win.webContents.send('history-updated', payload());
    return true;
  });
  ipcMain.handle('settings-set', async (_e, patch) => {
    calls.settings.push(patch);
    if (typeof patch.keepRecordings === 'boolean') keepRecordings = patch.keepRecordings;
    return payload();
  });

  await win.loadFile(path.join(__dirname, '../src/app.html'));
  const evaluate = (code) => win.webContents.executeJavaScript(code);
  const settle = () => evaluate(
    'new Promise(r => { requestAnimationFrame(() => requestAnimationFrame(() => r(1))); setTimeout(() => r(1), 140); })'
  );
  const count = (selector) => evaluate(`document.querySelectorAll('${selector}').length`);
  const text = (selector) => evaluate(`(() => { const el = document.querySelector('${selector}'); return el ? el.textContent.trim() : null; })()`);
  const hiddenOf = (selector) => evaluate(`(() => { const el = document.querySelector('${selector}'); return el ? el.hidden : null; })()`);
  const click = (selector) => evaluate(`(() => {
    const el = document.querySelector('${selector}');
    if (!el) return false;
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    el.click();
    return true;
  })()`);
  const card = (id) => `.card[data-id="${id}"]`;

  await settle();
  await settle();

  // --- Every card has Copy and ⋯; delete moved into the menu ------------------

  assert.strictEqual(await count('.card'), 2, 'both dictations are drawn');
  assert.strictEqual(await count('.card .card-more'), 2, 'every card has a ⋯ button');
  assert.strictEqual(await count('.card .icon-btn.danger'), 0, 'delete is no longer a bare icon on the card');
  assert.strictEqual(await count('.card .card-menu'), 2, 'every card carries a menu');
  assert.strictEqual(await count('.card .card-menu:not([hidden])'), 0, 'menus start closed');

  // --- What the menu offers depends on whether the recording was kept -------

  await click(card('with') + ' .card-more');
  await settle();
  assert.strictEqual(await hiddenOf(card('with') + ' .card-menu'), false, '⋯ opens the menu');
  assert.strictEqual(await count(card('with') + ' .card-menu-item'), 4, 'play, save, retry, delete');
  assert.strictEqual(await count(card('with') + ' .card-menu-item:disabled'), 0, 'with a recording, everything is on offer');
  assert.strictEqual(
    await evaluate(`document.querySelector('${card('with')} .card-more').getAttribute('aria-expanded')`),
    'true');

  // Opening another card's menu closes the first.
  await click(card('without') + ' .card-more');
  await settle();
  assert.strictEqual(await hiddenOf(card('with') + ' .card-menu'), true, 'one menu at a time');
  assert.strictEqual(await hiddenOf(card('without') + ' .card-menu'), false);
  assert.strictEqual(await count(card('without') + ' .card-menu-item:disabled'), 3,
    'without a recording, play, save and retry are greyed out');
  assert.strictEqual(await count(card('without') + ' .card-menu-item.danger:not(:disabled)'), 1,
    'delete stays available without a recording');
  assert.ok(/No recording kept/.test(await evaluate(`document.querySelector('${card('without')} .card-menu-item:disabled').title`)),
    'a greyed item says why');

  // Escape closes; a click elsewhere closes.
  await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
  await settle();
  assert.strictEqual(await hiddenOf(card('without') + ' .card-menu'), true, 'Escape closes the menu');
  await click(card('with') + ' .card-more');
  await settle();
  await evaluate(`document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); true`);
  await settle();
  assert.strictEqual(await hiddenOf(card('with') + ' .card-menu'), true, 'a click outside closes the menu');

  // --- Play opens the player on that card ------------------------------------

  await click(card('with') + ' .card-more');
  await settle();
  await click(card('with') + ' .card-menu-item:nth-child(1)');
  await settle();
  await settle();
  assert.strictEqual(calls.audio, 1, 'play asks main for the recording');
  assert.strictEqual(await hiddenOf(card('with') + ' .card-menu'), true, 'choosing an item closes the menu');
  assert.strictEqual(await hiddenOf(card('with') + ' .card-player'), false, 'the player appears on the card');
  assert.ok(/\/ 0:01/.test(await text(card('with') + ' .card-player-time')), 'the player shows the clip length');
  assert.strictEqual(await hiddenOf(card('without') + ' .card-player'), true, 'only the playing card shows a player');

  // --- Save round-trips and reports ------------------------------------------

  await click(card('with') + ' .card-more');
  await settle();
  await click(card('with') + ' .card-menu-item:nth-child(2)');
  await settle();
  await settle();
  assert.strictEqual(calls.save, 1, 'save asks main to write the WAV');
  assert.strictEqual(await text(card('with') + ' .card-status'), 'Saved as WAV');

  // --- Retry replaces the transcript and says so -----------------------------

  await click(card('with') + ' .card-more');
  await settle();
  await click(card('with') + ' .card-menu-item:nth-child(3)');
  await settle();
  await settle();
  assert.strictEqual(calls.retry, 1, 'retry asks main to run the engine again');
  assert.strictEqual(await text(card('with') + ' .text'), 'a dictation retried by the engine',
    'the card shows the retried transcript');
  assert.strictEqual(await text(card('with') + ' .card-status'), 'Transcript updated',
    'the status lands on the rebuilt card');
  assert.strictEqual(await count('.card.is-retrying'), 0, 'the busy state clears');

  // --- Delete lives in the menu ----------------------------------------------

  await click(card('without') + ' .card-more');
  await settle();
  await click(card('without') + ' .card-menu-item.danger');
  await settle();
  await settle();
  assert.strictEqual(calls.del, 1, 'delete asks main');
  assert.strictEqual(await count('.card'), 1, 'the deleted card is gone');

  // --- The privacy toggle ----------------------------------------------------

  await evaluate("document.getElementById('nav-settings').click(); document.querySelector('.settings-cat[data-cat=\"privacy\"]').click(); true");
  await settle();
  assert.strictEqual(await evaluate("document.getElementById('set-keep-recordings').checked"), true, 'on by default');
  assert.ok(/Keeping 1 recording/.test(await text('#recordings-hint')), 'the hint carries the live count');
  await evaluate("const t = document.getElementById('set-keep-recordings'); t.checked = false; t.dispatchEvent(new Event('change', { bubbles: true })); true");
  await settle();
  await settle();
  assert.deepStrictEqual(calls.settings.filter((p) => 'keepRecordings' in p), [{ keepRecordings: false }],
    'turning it off reaches main');
  assert.ok(/Off: nothing is kept/.test(await text('#recordings-hint')), 'the hint says it is off');

  assert.deepStrictEqual(errors, [], 'the renderer logged errors');

  clearTimeout(deadline);
  console.log('all history UI checks passed');
  app.exit(0);
}).catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  app.exit(1);
});
