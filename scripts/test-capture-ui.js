'use strict';

// Real renderer/IPC with synthetic screens and mock paste callbacks. No capture
// of the user's desktop, microphone recording, or typing into their apps.
const electron = require('electron');
const { app, BrowserWindow, nativeImage } = electron;
const { EventEmitter } = require('events');
const { createScreenCapture } = require('../src/screen-capture');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voxden-capture-ui-'));
app.setPath('userData', root);
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
const deadline = setTimeout(() => { console.error('Capture UI test timed out'); app.exit(1); }, 60000);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const errors = [], shapes = [];
app.on('browser-window-created', (_event, win) => {
  win.show = () => {};
  win.showInactive = () => {};
  win.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message); });
});
const evaluate = (win, code) => win.webContents.executeJavaScript(code);
function captureWindows() { return BrowserWindow.getAllWindows().filter(win => win.webContents.getURL().endsWith('/capture.html')); }
async function until(check, message) {
  for (let i = 0; i < 100; i++) { if (await check()) return; await wait(20); }
  throw new Error(message);
}
function drag(win, a, b, release = true) {
  win.webContents.sendInputEvent({ type: 'mouseDown', x: a.x, y: a.y, button: 'left', clickCount: 1 });
  win.webContents.sendInputEvent({ type: 'mouseMove', x: b.x, y: b.y, button: 'left' });
  if (release) win.webContents.sendInputEvent({ type: 'mouseUp', x: b.x, y: b.y, button: 'left', clickCount: 1 });
}

app.whenReady().then(async () => {
  const fixture = new BrowserWindow({ width: 1280, height: 800, useContentSize: true, show: false });
  await fixture.loadURL('data:text/html,' + encodeURIComponent('<!doctype html><style>body{margin:0;background:#edf1ee;color:#243a2b;font:18px Segoe UI;padding:60px}h1{font-size:38px}article{background:white;padding:30px;border:1px solid #dfe5df;border-radius:12px;width:650px}button{margin-top:25px;background:#285c41;border:0;border-radius:7px;padding:14px 25px;color:white;font:15px Segoe UI}</style><h1>Profile settings</h1><article>Make the workspace your own.<p>Display name: Alex Morgan</p><p>Email: alex@example.com</p><button>Save changes</button></article>'));
  const bitmap = nativeImage.createFromBuffer((await fixture.webContents.capturePage()).toPNG(), { scaleFactor: 1 }).resize({ width: 1280, height: 800 });
  fixture.destroy();
  const screen = new EventEmitter();
  const display = { id: 1, scaleFactor: 1.25, bounds: { x: 0, y: 0, width: 1024, height: 640 },
    size: { width: 1024, height: 640 }, workArea: { x: 0, y: 0, width: 1024, height: 620 } };
  screen.getAllDisplays = () => [display];
  const shortcuts = new Map();
  const originalTarget = { hwnd: '12345', exe: 'test-chat', title: 'Design review' };
  let foreground = null, starts = 0, cancelled = 0, restoreCount = 0, failImage = false, closeDuringText = false, failCapture = false;
  const pasted = [];
  const controller = createScreenCapture({
    electron: { ...electron, screen,
      BrowserWindow: class extends BrowserWindow {
        constructor(options) { super({ ...options, webPreferences: { ...options.webPreferences, offscreen: true } }); }
        setShape(rectangles) { shapes.push(rectangles); super.setShape(rectangles); }
      },
      desktopCapturer: { getSources: async () => { if (failCapture) throw new Error('Capture unavailable'); return [{ display_id: '1', thumbnail: bitmap }]; } },
      globalShortcut: { register: (key, fn) => { shortcuts.set(key, fn); return true; }, unregister: key => shortcuts.delete(key) },
    },
    canStart: () => '', hideVoxden: () => {}, restoreVoxden: () => restoreCount++,
    getTarget: async () => originalTarget,
    currentTarget: async () => foreground,
    targetInfo: async hwnd => ({ ...originalTarget, hwnd }),
    isOurTarget: hwnd => controller.owns(hwnd),
    toggleVoice: () => { starts++; controller.speechState({ mode: 'recording' }); },
    cancelVoice: () => cancelled++,
    shortcutLabel: () => 'Ctrl+Alt+D', pasteGapMs: 5,
    pasteText: async (text, hwnd, valid) => {
      assert(valid()); pasted.push({ type: 'text', text, hwnd });
      if (closeDuringText) controller.close();
    },
    pasteImage: async (image, hwnd, valid) => {
      assert(valid()); if (failImage) throw new Error('Test attachment failed');
      pasted.push({ type: 'image', image, hwnd });
    },
  });
  async function select() {
    await controller.start();
    const win = captureWindows()[0], id = win.id, before = starts;
    drag(win, { x: 80, y: 80 }, { x: 780, y: 430 });
    await until(async () => starts > before && await evaluate(win, '!document.getElementById("annotation").hidden'), 'Selection did not start recording');
    assert.strictEqual(win.id, id);
    assert.strictEqual(captureWindows().length, 1);
    return win;
  }
  let win = await select();
  assert.strictEqual(starts, 1, 'selecting a region starts listening without another click');
  assert.strictEqual(await evaluate(win, 'document.querySelectorAll("textarea,#editor,#insert,#target-picker").length'), 0);
  const rect = await evaluate(win, 'JSON.parse(JSON.stringify(document.getElementById("image-canvas").getBoundingClientRect()))');
  assert(Math.abs(rect.x - 80) < 2 && Math.abs(rect.y - 80) < 2, 'the screenshot stays at its original screen position');
  assert(Math.abs(rect.width - 700) < 2 && Math.abs(rect.height - 350) < 2);
  assert(shapes[0].length === 3, 'only the image, toolbar and status line receive mouse input');
  assert.strictEqual(controller.hidesOverlay, false, 'the normal floater is available while annotating/speaking');
  assert((await evaluate(win, 'document.getElementById("status").textContent')).includes('Ctrl+Alt+D'));
  console.log('ok selection becomes in-place annotation on the same surface and starts speech automatically');

  drag(win, { x: 110, y: 110 }, { x: 280, y: 170 });
  await until(() => evaluate(win, '!document.getElementById("undo").disabled'), 'Circle was not drawn');
  await evaluate(win, 'document.getElementById("undo").click(); document.querySelector("[data-tool=hide]").click(); true');
  drag(win, { x: 110, y: 110 }, { x: 240, y: 170 });
  await wait(60);
  const preview = path.join(root, 'capture-inline.png');
  fs.writeFileSync(preview, (await win.webContents.capturePage()).toPNG());
  console.log('Capture preview: ' + preview);

  controller.observeTarget('67890');
  await wait(10);
  // The stop gesture is the only completion action. Later focus changes must
  // not redirect the screenshot while transcription/paste is in flight.
  controller.speechState({ mode: 'stop' });
  controller.observeTarget('99999');
  await controller.complete('Make this button wider.', controller.sessionId);
  assert.deepStrictEqual(pasted.map(p => p.type), ['text', 'image']);
  assert(pasted.every(p => p.hwnd === '67890'));
  const image = pasted[1].image, size = image.getSize();
  const x = Math.floor((170 - rect.x) * size.width / rect.width), y = Math.floor((140 - rect.y) * size.height / rect.height);
  const offset = (y * size.width + x) * 4;
  assert.deepStrictEqual([...image.toBitmap().subarray(offset, offset + 4)], [25, 23, 20, 255], 'Hide exports opaque covered pixels');
  assert.strictEqual(controller.active, false);
  assert.strictEqual(captureWindows().length, 0);
  assert.strictEqual(cancelled, 0, 'successful paste does not invalidate the finishing dictation');
  console.log('ok stopping speech automatically pastes text and marked image to the chosen chat, then dismisses capture');

  // An in-progress mark is committed by Stop, even before mouse-up.
  pasted.length = 0; foreground = { ...originalTarget, hwnd: '55555' };
  win = await select();
  await evaluate(win, 'document.querySelector("[data-tool=hide]").click(); true');
  drag(win, { x: 100, y: 100 }, { x: 220, y: 160 }, false);
  await wait(40);
  controller.speechState({ mode: 'stop' });
  failImage = true;
  await assert.rejects(controller.complete('Keep these instructions.', controller.sessionId), /attachment failed/);
  assert.strictEqual(pasted.length, 1);
  assert.strictEqual(pasted[0].hwnd, '55555', 'foreground is sampled at the stop gesture');
  assert.strictEqual(controller.hasRetry, true);
  assert.strictEqual(captureWindows().length, 1, 'failure keeps only the inline annotation');
  failImage = false;
  controller.speechState({ mode: 'transcribing' });
  await controller.retry();
  assert.deepStrictEqual(pasted.map(p => p.type), ['text', 'image'], 'retry does not duplicate text already pasted');
  const retryImage = pasted[1].image, retryWidth = retryImage.getSize().width;
  const retryOffset = (Math.floor(40 * retryImage.getSize().height / 350) * retryWidth + Math.floor(60 * retryWidth / 700)) * 4;
  assert.deepStrictEqual([...retryImage.toBitmap().subarray(retryOffset, retryOffset + 4)], [25, 23, 20, 255]);
  console.log('ok stop commits an unfinished annotation; image failure retries without duplicating the spoken text');

  pasted.length = 0; foreground = null;
  win = await select();
  controller.speechState({ mode: 'stop' });
  closeDuringText = true;
  await assert.rejects(controller.complete('Cancel between the pastes.', controller.sessionId), /cancelled/);
  assert.deepStrictEqual(pasted.map(p => p.type), ['text']);
  assert.strictEqual(controller.active, false);
  closeDuringText = false;
  win = await select();
  const staleId = controller.sessionId;
  shortcuts.get('Escape')();
  await assert.rejects(controller.complete('Old speech.', staleId), /cancelled/);
  assert.strictEqual(captureWindows().length, 0);
  win = await select();
  screen.emit('display-metrics-changed');
  assert.strictEqual(controller.active, false);
  failCapture = true;
  await assert.rejects(controller.start(), /unavailable/);
  assert.strictEqual(captureWindows().length, 0);
  assert(restoreCount >= 6);
  assert.deepStrictEqual(errors, []);
  console.log('ok Escape, display changes and failures release the capture; cancelled work cannot paste later');
  clearTimeout(deadline); app.quit();
}).catch(err => { console.error(err); app.exit(1); });
