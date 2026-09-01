'use strict';

// Drives the real app renderer for the bell. The rules live in
// src/announcements.js and are tested there; what cannot be checked from
// source is the part made of live layout and IPC -- that the bell lands left
// of the Windows caption buttons instead of underneath them, that opening the
// panel is what clears the badge, and that clearing the last notification
// leaves the empty state behind rather than a blank box.

const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'voxden-notif-ui-')));
app.disableHardwareAcceleration();
const deadline = setTimeout(() => { console.error('Notification UI test timed out'); app.exit(1); }, 25000);

// The window the app actually opens. The caption buttons are drawn by Windows
// into the right-hand end of a title bar this wide, so the bell has to fit in
// what is left of it.
const WIDTH = 1120;
const HEIGHT = 760;
// Widest the Windows caption overlay gets: three buttons at 46px.
const CAPTION_WIDTH = 138;

function notification(id, title, body, extra) {
  return Object.assign({ id, kind: 'feature', title, body, ts: Date.now(), unread: true }, extra || {});
}

let store = [
  notification('one', 'A new engine', 'Something to try.', { kind: 'engine', action: { settings: 'general' } }),
  notification('two', 'A new voice model', 'Something else to try.', { kind: 'model' }),
];

function payload() {
  return {
    entries: [],
    phrases: [],
    pendingPhrases: [],
    notifications: store,
    notificationsUnread: store.filter((n) => n.unread).length,
  };
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: WIDTH,
    height: HEIGHT,
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

  // Stand in for the main process. The store is the thing under test as far as
  // the renderer is concerned: read and clear have to come back through IPC or
  // the badge is only being told what it already believed.
  ipcMain.handle('app-load', async () => payload());
  ipcMain.handle('notifications-read', async () => {
    store = store.map((n) => Object.assign({}, n, { unread: false }));
    return payload();
  });
  ipcMain.handle('notifications-dismiss', async (_e, id) => {
    store = store.filter((n) => n.id !== id);
    return payload();
  });
  ipcMain.handle('notifications-clear', async () => {
    store = [];
    return payload();
  });

  await win.loadFile(path.join(__dirname, '../src/app.html'));
  const evaluate = (code) => win.webContents.executeJavaScript(code);
  const settle = () => evaluate(
    'new Promise(r => { requestAnimationFrame(() => requestAnimationFrame(() => r(1))); setTimeout(() => r(1), 140); })'
  );
  const click = (id) => evaluate(`(() => {
    const el = document.getElementById('${id}');
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    el.click();
    return true;
  })()`);
  const box = (selector) => evaluate(`(() => {
    const el = document.querySelector('${selector}');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
  })()`);
  const hidden = (id) => evaluate(`document.getElementById('${id}').hidden`);
  const text = (selector) => evaluate(`(() => {
    const el = document.querySelector('${selector}');
    return el ? el.textContent.trim() : null;
  })()`);
  const count = (selector) => evaluate(`document.querySelectorAll('${selector}').length`);

  await settle();
  await settle();

  // --- The bell keeps out of the caption buttons -----------------------------

  // The size above is what the window asked for, not necessarily what it got:
  // a build agent with a small virtual display hands back a narrower one. The
  // geometry is measured against the page rather than against the request, so
  // a clamped window reads as a narrower title bar instead of a failure.
  const viewport = await evaluate('window.innerWidth');
  assert.ok(viewport > CAPTION_WIDTH * 2, 'the window is too narrow to test a title bar in');

  const bell = await box('#notif-btn');
  const bar = await box('.titlebar');
  assert.ok(bell && bell.width > 0, 'the bell has to be laid out');
  assert.ok(bell.right <= viewport - CAPTION_WIDTH,
    'the bell overlaps the Windows caption buttons: right edge ' + bell.right + ' of ' + viewport);
  assert.ok(bell.top >= bar.top && bell.bottom <= bar.bottom, 'the bell has to sit inside the title bar');
  // Far enough right to read as part of the window controls rather than as
  // part of the branding on the left.
  assert.ok(bell.left > viewport / 2, 'the bell belongs at the right-hand end of the title bar');

  // A title bar is a drag region; a button inside one is only clickable if it
  // opts out.
  assert.strictEqual(
    await evaluate("getComputedStyle(document.getElementById('notif-btn')).webkitAppRegion"),
    'no-drag',
    'the bell would drag the window instead of opening the panel');

  // --- The badge counts what has not been read -------------------------------

  assert.strictEqual(await hidden('notif-badge'), false, 'two unread notifications have to show a badge');
  assert.strictEqual(await text('#notif-badge'), '2');
  assert.strictEqual(
    await evaluate("document.getElementById('notif-btn').getAttribute('aria-label')"),
    'Notifications, 2 unread',
    'the count has to reach a screen reader too');

  const badge = await box('#notif-badge');
  assert.ok(badge.bottom > bell.top + bell.height / 2, 'the count belongs under the bell, not over it');

  // --- Opening reads them ----------------------------------------------------

  assert.strictEqual(await hidden('notif-panel'), true, 'the panel starts closed');
  await click('notif-btn');
  await settle();
  await settle();
  assert.strictEqual(await hidden('notif-panel'), false, 'the bell has to open the panel');
  assert.strictEqual(await hidden('notif-badge'), true, 'opening the panel clears the badge');
  assert.strictEqual(await count('.notif-item'), 2, 'both notifications have to be drawn');
  assert.strictEqual(await hidden('notif-empty'), true, 'the empty state must not show over a full list');

  // Read, but still marked as new while the user is looking at them -- the
  // badge has already gone, and nothing else says which ones were unread.
  assert.strictEqual(await count('.notif-item.is-new'), 2,
    'opening the panel must not erase which notifications were new');

  // An action only appears where a settings pane exists to open.
  assert.strictEqual(await count('.notif-item[data-id="one"] .notif-open'), 1);
  assert.strictEqual(await count('.notif-item[data-id="two"] .notif-open'), 0);

  // The panel has to clear the caption buttons as well, or Windows takes the
  // clicks meant for its top-right corner.
  const panel = await box('#notif-panel');
  assert.ok(panel.top >= bar.bottom, 'the panel has to hang below the title bar');
  assert.ok(panel.right <= viewport, 'the panel runs off the right edge of the window');

  // --- Dismissing one, then clearing the rest --------------------------------

  await evaluate(`document.querySelector('.notif-item[data-id="two"] .notif-dismiss').click(); true`);
  await settle();
  await settle();
  assert.strictEqual(await count('.notif-item'), 1, 'dismissing has to remove that row');
  assert.strictEqual(await hidden('notif-empty'), true);

  await click('notif-clear');
  await settle();
  await settle();
  assert.strictEqual(await count('.notif-item'), 0, 'clear all empties the list');
  assert.strictEqual(await hidden('notif-empty'), false, 'an empty list has to show the empty state');
  assert.strictEqual(await hidden('notif-clear'), true, 'there is nothing left to clear');
  assert.ok(/all caught up/i.test(await text('#notif-empty')), 'the empty state has to say so');

  // The illustration is the flow bar face: a headband, two earcups, two eyes.
  assert.strictEqual(await count('.notif-mascot-band'), 1);
  assert.strictEqual(await count('.notif-mascot-cup'), 2);
  assert.strictEqual(await count('.notif-mascot-eye'), 2);
  const face = await box('.notif-mascot-face');
  assert.ok(face && face.width > 0 && face.height > 0, 'the illustration has to have a size');
  assert.ok(face.bottom <= panel.bottom, 'the illustration has to fit inside the panel');

  // --- Closing ---------------------------------------------------------------

  await evaluate(`document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); true`);
  await settle();
  assert.strictEqual(await hidden('notif-panel'), true, 'a click outside has to close the panel');
  assert.strictEqual(
    await evaluate("document.getElementById('notif-btn').getAttribute('aria-expanded')"),
    'false');

  await click('notif-btn');
  await settle();
  assert.strictEqual(await hidden('notif-panel'), false);
  await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
  await settle();
  assert.strictEqual(await hidden('notif-panel'), true, 'Escape has to close the panel');

  // Settings dims the whole window and paints over the panel, so it has to
  // take the panel with it -- a panel nobody can see is a panel nobody can
  // close.
  await click('notif-btn');
  await settle();
  assert.strictEqual(await hidden('notif-panel'), false);
  await evaluate("document.getElementById('nav-settings').click(); true");
  await settle();
  assert.strictEqual(await hidden('settings-overlay'), false, 'settings has to open');
  assert.strictEqual(await hidden('notif-panel'), true, 'opening settings has to close the panel');

  assert.deepStrictEqual(errors, [], 'the renderer logged errors');

  clearTimeout(deadline);
  console.log('all notification UI checks passed');
  app.exit(0);
}).catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  app.exit(1);
});
