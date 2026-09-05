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
const deadline = setTimeout(() => { console.error('History UI test timed out'); app.exit(1); }, 35000);

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
let canRetry = true;
let clearFails = true;
let finishClear;
let holdAudio = false;
let finishAudio;
const calls = { audio: 0, save: 0, retry: 0, del: 0, clear: 0, settings: [] };

function payload() {
  return {
    entries,
    phrases: [],
    pendingPhrases: [],
    notifications: [],
    notificationsUnread: 0,
    keepRecordings,
    canRetry,
    recordings: { count: entries.filter(e => e.audio).length, bytes: entries.filter(e => e.audio).length * 38444 },
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
    if (holdAudio) await new Promise(resolve => { finishAudio = resolve; });
    return { ok: true, bytes: wav(1.2), seconds: 1.2 };
  });
  ipcMain.handle('history-audio-save', async (_e, id) => {
    calls.save += 1;
    return id === 'with' ? { ok: true, path: 'C:\\Users\\x\\Downloads\\Voxden.wav' } : { ok: false, reason: 'No recording kept for this dictation.' };
  });
  ipcMain.handle('history-retry', async (_e, id) => {
    calls.retry += 1;
    if (id !== 'with') return { ok: false, reason: 'No recording kept for this dictation.' };
    // The invoke reply and broadcast can arrive in either order. Deliver the
    // broadcast afterward to check that rebuilding retains the result status.
    entries = entries.map((e) => (e.id === id ? Object.assign({}, e, { text: 'a dictation retried by the engine' }) : e));
    const updated = payload();
    setTimeout(() => win.webContents.send('history-updated', updated), 50);
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
  ipcMain.handle('recordings-clear', async () => {
    calls.clear++;
    if (clearFails) return { ok: false, reason: 'Some recordings could not be deleted. Try again.', snapshot: payload() };
    await new Promise(resolve => { finishClear = resolve; });
    entries = entries.map(entry => ({ ...entry, audio: false }));
    canRetry = false;
    const snapshot = payload();
    win.webContents.send('history-updated', snapshot);
    return { ok: true, snapshot };
  });

  await win.loadFile(path.join(__dirname, '../src/app.html'));
  const evaluate = (code) => win.webContents.executeJavaScript(code);
  await evaluate(`navigator.mediaDevices.getUserMedia = async () => { throw new Error('No test microphone'); };
    navigator.mediaDevices.enumerateDevices = async () => []; true`);
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
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const waitFor = async (code, message) => {
    const until = Date.now() + 2500;
    do {
      if (await evaluate(code)) return;
      await delay(40);
    } while (Date.now() < until);
    assert.fail(message);
  };
  const box = (selector) => evaluate(`document.querySelector('${selector}').getBoundingClientRect().toJSON()`);
  const center = async (selector) => {
    const r = await box(selector);
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  };
  const move = (point) => win.webContents.sendInputEvent({ type: 'mouseMove', ...point });
  const pointerClick = async (selector) => {
    move(await center(selector));
    await delay(180);
    const point = await center(selector);
    move(point);
    win.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 });
    win.webContents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 });
  };
  const assertMenuVisible = async (selector) => {
    const result = await evaluate(`(() => {
      const menu = document.querySelector('${selector}');
      const pane = menu.closest('.pane-body');
      const p = pane.getBoundingClientRect();
      const r = menu.getBoundingClientRect();
      return {
        hidden: menu.hidden,
        inside: r.top >= p.top && r.bottom <= Math.min(innerHeight, p.top + pane.clientHeight)
          && r.left >= p.left && r.right <= Math.min(innerWidth, p.left + pane.clientWidth),
        reachable: Array.from(menu.children).every(item => {
          const b = item.getBoundingClientRect();
          return item.contains(document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2));
        })
      };
    })()`);
    assert.strictEqual(result.hidden, false, 'the menu stays open while its button is visible');
    assert.ok(result.inside, 'the entire menu fits inside the visible history pane');
    assert.ok(result.reachable, 'all four menu actions are reachable by the pointer');
  };

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
  await pointerClick(card('with') + ' .card-menu-item:nth-child(3)');
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
  await pointerClick(card('without') + ' .card-menu-item.danger');
  await settle();
  await settle();
  assert.strictEqual(calls.del, 1, 'delete asks main');
  assert.strictEqual(await count('.card'), 1, 'the deleted card is gone');

  // --- Hovering an overlapping menu must not hand the pointer to the next card.
  // Direct DOM clicks bypass hit testing and cannot catch the stacking flicker.
  const savedEntries = entries;
  entries = Array.from({ length: 10 }, (_, i) => ({
    id: 'layout-' + i,
    ts: Date.now() - i * 60000,
    text: i === 2 ? 'The following card\nhas enough text\nto sit underneath\nboth lower actions\nin the open menu.' : 'History entry ' + i,
    audio: true,
  }));
  win.webContents.send('history-updated', payload());
  await settle();
  const overlapCard = card('layout-1');
  // Anchor the fixture near the top regardless of the dashboard above the
  // library. This case deliberately needs a downward-opening menu.
  await evaluate(`document.querySelector('${overlapCard}').scrollIntoView({ block: 'start' }); true`);
  await settle();
  await pointerClick(overlapCard + ' .card-more');
  await settle();
  const following = await box(card('layout-2'));
  for (const nth of [3, 4]) {
    const selector = overlapCard + ' .card-menu-item:nth-child(' + nth + ')';
    const point = await center(selector);
    assert.ok(point.y > following.top && point.y < following.bottom,
      'the lower menu action must overlap the following card to exercise the regression');
    let hovered = false;
    for (let sample = 0; sample < 35; sample++) {
      move(point);
      await delay(40);
      const state = await evaluate(`(() => {
        const item = document.querySelector('${selector}');
        return {
          hit: item.contains(document.elementFromPoint(${point.x}, ${point.y})),
          hovered: item.closest('.card').matches(':hover')
        };
      })()`);
      assert.ok(state.hit, 'Retry/Delete must stay above the next card throughout hover');
      hovered = hovered || state.hovered;
    }
    assert.ok(hovered, 'real pointer input must exercise the card hover style');
  }
  await assertMenuVisible(overlapCard + ' .card-menu');
  await evaluate("document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); true");

  // A menu near the bottom opens upward, and follows its anchor as the pane
  // scrolls or the window changes size. Once its anchor leaves view it closes.
  const edgeCard = card('layout-8');
  const edgeMenu = edgeCard + ' .card-menu';
  await evaluate(`document.querySelector('${edgeCard} .card-more').scrollIntoView({ block: 'end' }); true`);
  await settle();
  await pointerClick(edgeCard + ' .card-more');
  await settle();
  await assertMenuVisible(edgeMenu);
  assert.ok((await box(edgeMenu)).bottom <= (await box(edgeCard + ' .card-more')).top,
    'a menu near the bottom opens above its button');
  const beforeScroll = await box(edgeMenu);
  await evaluate("document.querySelector('#view-dictation .pane-body').scrollTop += 24; true");
  await delay(180);
  await assertMenuVisible(edgeMenu);
  assert.ok((await box(edgeMenu)).top < beforeScroll.top - 10, 'the menu follows a scrolled card');
  win.setContentSize(960, 820);
  await delay(220);
  await assertMenuVisible(edgeMenu);
  await evaluate("document.querySelector('#view-dictation .pane-body').scrollTop = 0; true");
  await waitFor(`document.querySelector('${edgeMenu}').hidden`,
    'scrolling the anchor out of view closes the menu');
  win.setContentSize(1120, 760);
  entries = savedEntries;
  win.webContents.send('history-updated', payload());
  await settle();

  // --- The privacy toggle ----------------------------------------------------

  await click(card('with') + ' .card-more');
  await click(card('with') + ' .card-menu-item:nth-child(1)');
  await settle();
  assert.strictEqual(await evaluate('!!activePlayer'), true);
  await evaluate("document.getElementById('nav-settings').click(); document.querySelector('.settings-cat[data-cat=\"privacy\"]').click(); true");
  await settle();
  assert.strictEqual(await evaluate("document.getElementById('set-keep-recordings').checked"), true, 'on by default');
  assert.ok(/Keeping 1 recording/.test(await text('#recordings-hint')), 'the hint carries the live count');
  for (const [width, height] of [[1120, 760], [640, 440]]) {
    win.setContentSize(width, height);
    await delay(200);
    assert.ok(await evaluate(`(() => {
      const button = document.getElementById('recordings-clear');
      button.scrollIntoView({ block: 'center' });
      const r = button.getBoundingClientRect();
      const pane = document.querySelector('.settings-detail');
      return !button.disabled && pane.scrollWidth <= pane.clientWidth
        && button.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
    })()`), 'Delete is visible and reachable at ' + width);
  }
  await evaluate('window.confirm = () => false; true');
  await pointerClick('#recordings-clear');
  await settle();
  assert.strictEqual(calls.clear, 0, 'cancelling confirmation sends no deletion request');
  assert.strictEqual(await evaluate('!!activePlayer'), true, 'cancelling leaves playback intact');
  await evaluate('window.confirm = () => true; true');
  await pointerClick('#recordings-clear');
  await settle();
  assert.strictEqual(calls.clear, 1);
  assert.match(await text('#recordings-clear-status'), /could not be deleted/);
  assert.strictEqual(await evaluate('recordingsClearBtn.disabled'), false, 'failed deletion can be retried');

  clearFails = false;
  const transcriptsBefore = entries.map(entry => entry.text);
  // A playback reply already in flight must not restart deleted audio.
  await click('#settings-close');
  holdAudio = true;
  await click(card('with') + ' .card-more');
  await click(card('with') + ' .card-menu-item:nth-child(1)');
  await settle();
  await click('#nav-settings');
  await evaluate('recordingsClearBtn.scrollIntoView({ block: "center" }); true');
  await pointerClick('#recordings-clear');
  await waitFor('clearingRecordings', 'deletion becomes busy');
  finishAudio();
  await settle();
  assert.strictEqual(await evaluate('activePlayer'), null, 'a pending playback response cannot start during deletion');
  await evaluate('for (let i = 0; i < 200; i++) renderSettings(lastPayload); recordingsClearBtn.click(); true');
  assert.strictEqual(calls.clear, 2, 'one confirmed click sends one request even across repeated renders');
  assert.strictEqual(await evaluate('recordingsClearBtn.disabled'), true);
  finishClear();
  await waitFor('!clearingRecordings', 'deletion finishes');
  assert.strictEqual(await text('#recordings-clear-status'), 'Saved recordings deleted.');
  assert.strictEqual(await evaluate('recordingsClearBtn.disabled'), true, 'Delete is disabled when no audio remains');
  assert.strictEqual(await evaluate('settingInputs.keepRecordings.checked'), true, 'deletion preserves the retention toggle');
  assert.strictEqual(await evaluate('activePlayer'), null, 'deletion stops audio playback');
  assert.deepStrictEqual(entries.map(entry => entry.text), transcriptsBefore, 'transcripts stay in history');
  assert.strictEqual(await count(card('with') + ' .card-menu-item:disabled'), 3, 'play, save and retry disable after audio is removed');
  assert.ok(/No saved recordings/.test(await text('#recordings-hint')));

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
