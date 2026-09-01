'use strict';

// Drives the real overlay renderer, because the drag and the hover cluster are
// both made of state that only exists once the page is running: body classes,
// a hover rect measured against the live window, and pointer capture. A
// regression here is a bar that either cannot be picked up or cannot be put
// down, and neither is visible from a source-level check.

const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'voxden-flow-ui-')));
app.disableHardwareAcceleration();
const deadline = setTimeout(() => { console.error('Flow bar UI test timed out'); app.exit(1); }, 20000);

// Matches overlaySize() in main.js. The hover rects are measured off the
// window, so testing at another size would test another geometry.
const WIDTH = 260;
const HEIGHT = 84;

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
    // Electron 36 moved this to a single event object; accept both shapes so
    // the guard keeps working either side of that change.
    const lvl = event && event.level !== undefined ? event.level : level;
    const text = event && event.message !== undefined ? event.message : message;
    const bad = lvl === 'error' || Number(lvl) >= 3;
    if (bad && !/Content-Security-Policy/.test(String(text))) errors.push(String(text));
  });

  // What the two buttons are for is an IPC message, so watch the real channels
  // rather than the window.voxden bridge -- contextBridge objects are frozen,
  // and stubbing one only proves that the stub was called.
  const sent = [];
  ipcMain.on('overlay-settings', () => sent.push('overlaySettings'));
  ipcMain.handle('toggle', async () => { sent.push('toggle'); return { mode: 'idle' }; });
  await win.loadFile(path.join(__dirname, '../src/overlay.html'));
  const evaluate = code => win.webContents.executeJavaScript(code);

  // A window with show:false stops producing frames as soon as nothing is
  // animating, so a bare double-rAF never returns once the bar settles. The
  // timeout is the one that fires on a still page; the frames are what make it
  // quick while something is still moving.
  const settle = () => evaluate(
    'new Promise(r => { requestAnimationFrame(() => requestAnimationFrame(() => r(1))); setTimeout(() => r(1), 120); })'
  );

  async function state(payload) {
    win.webContents.send('state', { soundsEnabled: false, alwaysShowFlowBar: true, ...payload });
    await settle();
  }
  async function cursor(x, y, inside) {
    win.webContents.send('hud-cursor', { x, y, inside: inside !== false });
    await settle();
  }
  const cls = () => evaluate('Array.from(document.body.classList)');
  const clickable = id => evaluate(`getComputedStyle(document.getElementById('${id}')).pointerEvents`);

  // The overlay's own reveal path, same as a real launch.
  await state({ mode: 'idle', reveal: true });
  assert.ok((await cls()).includes('shown'), 'the bar has to be on screen to be dragged');
  assert.ok((await cls()).includes('always-flow'));
  assert.ok(!(await cls()).includes('flow-expanded'), 'the resting bar starts collapsed');

  // --- The hover cluster ------------------------------------------------------
  // Nothing is grabbable until the pointer is on the bar.
  assert.strictEqual(await clickable('flow-drag'), 'none', 'the grip must not be hit-testable at rest');
  assert.strictEqual(await clickable('flow-settings'), 'none', 'the gear must not be hit-testable at rest');

  // The centre of the resting bar: the window's mid-line, just above its floor.
  const barY = HEIGHT - 16;
  await cursor(WIDTH / 2, barY);
  assert.ok((await cls()).includes('flow-expanded'), 'hovering the bar opens it');
  assert.strictEqual(await clickable('flow-drag'), 'auto', 'the grip appears with the mic');
  assert.strictEqual(await clickable('flow-settings'), 'auto', 'the gear appears with the mic');

  // Both new buttons must sit inside the hover rect that keeps the cluster
  // open, or they would vanish the moment the cursor left the bar itself.
  for (const id of ['flow-drag', 'flow-settings']) {
    const box = await evaluate(`(() => { const r = document.getElementById('${id}').getBoundingClientRect();
      return { cx: r.left + r.width / 2, cy: r.top + r.height / 2 }; })()`);
    await cursor(box.cx, box.cy);
    assert.ok((await cls()).includes('flow-expanded'), id + ' falls outside the hover zone it lives in');
    assert.strictEqual(await clickable(id), 'auto', id + ' stops being clickable when hovered directly');
  }

  // Leaving collapses it again.
  await cursor(4, 4);
  assert.ok(!(await cls()).includes('flow-expanded'), 'the bar closes when the pointer leaves');

  // --- Picking the bar up and putting it down --------------------------------
  const grab = `(() => {
    const el = document.getElementById('flow-drag');
    const r = el.getBoundingClientRect();
    el.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true, cancelable: true, button: 0, pointerId: 7, isPrimary: true,
      clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
    }));
    return true;
  })()`;

  await cursor(WIDTH / 2, barY);
  await evaluate(grab);
  await settle();
  assert.ok((await cls()).includes('flow-dragging'), 'the grip has to start a drag');
  assert.strictEqual(await evaluate('dragging'), true);

  // The window chases the cursor, so its own hover poll goes stale. Acting on
  // it would collapse the bar to a 6px line halfway through the gesture.
  await cursor(0, 0, false);
  assert.ok((await cls()).includes('flow-dragging'), 'a stale hover reading must not end the drag');
  assert.ok((await cls()).includes('flow-expanded'), 'the bar must stay open while it is carried');
  await evaluate(`window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 7 })); true`);
  await settle();
  assert.strictEqual(await evaluate('dragging'), false, 'a release anywhere has to end the drag');
  assert.ok(!(await cls()).includes('flow-dragging'));

  // A hotkey can start a dictation with the button still down, and the
  // recording pill has no grip to let go of.
  await cursor(WIDTH / 2, barY);
  await evaluate(grab);
  assert.strictEqual(await evaluate('dragging'), true);
  await state({ mode: 'arming', prepareOnly: true });
  assert.strictEqual(await evaluate('dragging'), false, 'leaving idle has to put the bar down');
  assert.ok(!(await cls()).includes('flow-dragging'));
  assert.strictEqual(await clickable('flow-drag'), 'none', 'the grip belongs to the resting bar only');
  assert.strictEqual(await evaluate("getComputedStyle(document.querySelector('.glyph-mic')).position"), 'absolute',
    'the mic must not jump into flex layout while the capsule is morphing');

  await state({ mode: 'cancel', text: 'Cancelled' });
  await state({ mode: 'idle' });

  // --- The gear ---------------------------------------------------------------
  // Clicking it must open settings and must not also start a dictation: the
  // dictate handler is on the document, so the gear is inside its reach.
  sent.length = 0;
  await cursor(WIDTH / 2, barY);
  await evaluate(`document.getElementById('flow-settings').click(); true`);
  await settle();
  assert.deepStrictEqual(sent, ['overlaySettings'], 'the gear must open settings and nothing else');

  // The bar itself still dictates.
  await evaluate(`document.getElementById('pill').click(); true`);
  await settle();
  assert.deepStrictEqual(sent, ['overlaySettings', 'toggle'], 'clicking the bar must still start a dictation');

  assert.deepStrictEqual(errors, []);
  console.log('real overlay: the bar opens on hover, drags from the grip, drops on release, and the gear opens settings');
  clearTimeout(deadline);
  win.destroy();
  app.quit();
}).catch(err => { console.error(err); app.exit(1); });
