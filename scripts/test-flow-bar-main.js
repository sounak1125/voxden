'use strict';

// End-to-end for the half of the flow bar that only exists in the main
// process: the real overlay window, the real IPC channels, the real settings
// file. src/flow-bar.js is unit-tested on its own and the renderer is driven by
// test-flow-bar-ui.js; this is the seam between them, where a sender check or a
// missing saveSettings would silently drop a drag on the floor.

const { app, BrowserWindow, screen } = require('electron');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voxden-flowbar-'));
app.setPath('userData', root);
app.disableHardwareAcceleration();
Object.defineProperty(app, 'isPackaged', { value: true });
const SETTINGS_FILE = path.join(root, 'data', 'settings.json');

// A saved position from a previous session, somewhere the default placement
// would never put the bar. Written before main.js loads, because the point is
// that startup honours it rather than re-centring on the primary display.
//
// Kept hard against the left edge rather than merely off-centre. The check
// below distinguishes "restored" from "re-centred" by distance, so the point
// has to be far from the centre of whatever display the test lands on -- and a
// build agent runs at 1024x768, where a comfortably off-centre point on a
// desktop monitor sits close enough to the middle to fail a bar that was
// restored perfectly.
fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
const SAVED = { x: 150, y: 640 };
fs.writeFileSync(SETTINGS_FILE, JSON.stringify({ alwaysShowFlowBar: true, flowBarAnchor: SAVED }));

// Same stubs the packaged-startup test uses: exercise real startup without
// touching login entries, global shortcuts, updates, or the user's screen.
app.setLoginItemSettings = () => {};
// The overlay must be genuinely visible -- a drag refuses to start on a hidden
// window -- but the dashboard has no business appearing during a test.
BrowserWindow.prototype.show = function () {};
BrowserWindow.prototype.focus = function () {};
const updater = require('../src/updater');
updater.startUpdater = () => {};
const shortcuts = require('electron').globalShortcut;
shortcuts.register = () => true;
shortcuts.unregister = () => {};
shortcuts.unregisterAll = () => {};
if (!process.argv.includes('--hidden')) process.argv.push('--hidden');

const errors = [];
app.on('web-contents-created', (_event, contents) => {
  contents.on('console-message', (event, level, message) => {
    const lvl = event && event.level !== undefined ? event.level : level;
    const text = event && event.message !== undefined ? event.message : message;
    if ((lvl === 'error' || Number(lvl) >= 3) && !/Content-Security-Policy/.test(String(text))) {
      errors.push(String(text));
    }
  });
});

require('../src/main');

const deadline = setTimeout(() => { console.error('Flow bar main test timed out'); app.exit(1); }, 30000);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function overlayWindow() {
  return BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/overlay.html'));
}

function readSettings() {
  return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
}

app.whenReady().then(async () => {
  let overlay;
  for (let i = 0; i < 150; i++) {
    overlay = overlayWindow();
    if (overlay && !overlay.webContents.isLoading() && overlay.isVisible()) break;
    await wait(100);
  }
  assert(overlay, 'the overlay window has to exist');
  assert(overlay.isVisible(), 'the flow bar has to be on screen when alwaysShowFlowBar is set');

  // The overlay's own logical size, from overlaySize() in main.js, and the
  // clearance flow-bar.js leaves below the anchor.
  const WIDTH = 260;
  const HEIGHT = 84;
  const BOTTOM_GAP = 4;
  // A window's bounds do not round-trip exactly through a scaled display: the
  // set rounds into device pixels and the read rounds back out, costing up to
  // a pixel each way.
  const SLOP = 3;
  const near = (got, want, what) => assert.ok(Math.abs(got - want) <= SLOP,
    what + ': ' + got + ' is more than ' + SLOP + 'px from ' + want);
  // The top-left the bar should be at if its bottom centre is on `anchor`.
  const cornerFor = anchor => ({ x: anchor.x - WIDTH / 2, y: anchor.y - HEIGHT });

  // --- A saved position is honoured, not recentred ---------------------------
  const bounds = overlay.getBounds();
  const wa = screen.getDisplayNearestPoint(SAVED).workArea;
  const want = cornerFor(SAVED);
  const fits = want.x >= wa.x && want.x + WIDTH <= wa.x + wa.width
    && want.y >= wa.y && want.y + HEIGHT <= wa.y + wa.height;
  if (fits) {
    near(bounds.x, want.x, 'startup must put the bar back where it was left, not on the primary centre');
    near(bounds.y, want.y, 'the saved top edge');
    assert.ok(Math.abs(bounds.x - (wa.x + (wa.width - WIDTH) / 2)) > 100,
      'a saved position must not collapse back to the default centre');
  } else {
    // A screen too small for the saved point still has to leave the bar on it.
    assert.ok(bounds.x + SLOP >= wa.x && bounds.x + WIDTH - SLOP <= wa.x + wa.width
      && bounds.y + SLOP >= wa.y && bounds.y + HEIGHT - SLOP <= wa.y + wa.height,
    'a saved point that no longer fits must be clamped onto a real display');
  }

  // --- A drag round trip through the real channels ---------------------------
  // The renderer sends these, and main refuses them from anywhere else, so they
  // have to be sent from the overlay's own context. Nothing moves the cursor
  // here, so this is the "picked it up and put it straight back down" case --
  // which is exactly the one that must not shift anything.
  const fromOverlay = code => overlay.webContents.executeJavaScript(code);
  const before = overlay.getBounds();

  // The bar follows the real cursor, and this test cannot hold a real mouse
  // still -- a hand resting on it mid-run would move the bar for genuinely
  // correct reasons. So measure the pointer around each drag and require the
  // bar to have moved by that and by nothing else, which is the stronger
  // statement anyway. With nobody touching the mouse the sum is zero and this
  // is exactly a no-drift assertion.
  let expectX = 0;
  let expectY = 0;
  for (let i = 0; i < 5; i++) {
    const from = screen.getCursorScreenPoint();
    await fromOverlay('window.voxden.overlayDragStart(); true');
    await wait(80);
    const to = screen.getCursorScreenPoint();
    await fromOverlay('window.voxden.overlayDragEnd(); true');
    await wait(120);
    expectX += to.x - from.x;
    expectY += to.y - from.y;
  }

  const saved = readSettings();
  assert.ok(saved.flowBarAnchor, 'a completed drag has to be written to settings');
  // A few pixels of slack for the gap between sampling the pointer and the
  // drag actually ending. The bug this guards produced tens of pixels per
  // second of drag, so the slack cannot hide it.
  near(saved.flowBarAnchor.x - SAVED.x, expectX, 'the anchor must move with the pointer and by nothing else');
  near(saved.flowBarAnchor.y - SAVED.y, expectY, 'the anchor must move with the pointer and by nothing else');
  const after = overlay.getBounds();
  near(after.x - before.x, expectX, 'the window must move with the pointer and by nothing else');
  near(after.y - before.y, expectY, 'the window must move with the pointer and by nothing else');

  // The window must not have grown. setPosition() re-sends the size it read
  // back from the window, which does not round-trip on a scaled display, so a
  // drag loop built on it inflated the overlay by about 48x48 for every second
  // the user held the grip. The bar sits at the bottom of that window, so a
  // taller one slid it down the screen -- which is what a drag looked like.
  assert.ok(Math.abs(after.width - WIDTH) <= SLOP && Math.abs(after.height - HEIGHT) <= SLOP,
    'dragging must not resize the overlay: ' + after.width + 'x' + after.height
      + ' after five drags, expected ' + WIDTH + 'x' + HEIGHT);

  // The anchor has to survive a resize, which is the whole reason the position
  // is stored as one rather than as a window rect.
  overlay.webContents.send('state', { mode: 'idle' });
  await wait(250);
  const idle = overlay.getBounds();
  assert.deepStrictEqual({ x: idle.x, y: idle.y }, { x: after.x, y: after.y },
    'an idle state refresh must not walk the bar away from its anchor');

  // --- Nothing in the drag path may steal the paste target -------------------
  // Dictation goes to whatever window had focus. If the overlay ever became
  // focusable or foreground during a drag, the text would land on the bar's own
  // screen instead of where the user was typing.
  assert.strictEqual(overlay.isFocused(), false, 'a drag must never focus the flow bar');

  // --- Reset puts it back ----------------------------------------------------
  await fromOverlay('window.voxden.resetFlowBar()');
  await wait(250);
  assert.strictEqual(readSettings().flowBarAnchor, null, 'reset has to clear the saved position');
  const home = overlay.getBounds();
  const primary = screen.getPrimaryDisplay().workArea;
  near(home.x, Math.round(primary.x + (primary.width - WIDTH) / 2),
    'reset has to return the bar to the middle of the primary display');
  near(home.y, primary.y + primary.height - BOTTOM_GAP - HEIGHT,
    'reset has to return the bar to the bottom of the primary display');

  // --- The bar comes back if something hides it ------------------------------
  // ensureOverlayVisible runs on the foreground poll, which ticks twice a
  // second, so a bar hidden behind main's back must not stay hidden.
  overlay.hide();
  assert.strictEqual(overlay.isVisible(), false);
  for (let i = 0; i < 40; i++) {
    if (overlay.isVisible()) break;
    await wait(100);
  }
  assert.strictEqual(overlay.isVisible(), true, 'a flow bar that goes missing has to come back on its own');

  assert.deepStrictEqual(errors, []);
  console.log('flow bar: a saved position survives a restart, a drag is persisted as an anchor, and a hidden bar returns');
  clearTimeout(deadline);
  app.exit(0);
}).catch(err => { console.error(err); app.exit(1); });
