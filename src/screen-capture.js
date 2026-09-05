'use strict';

const path = require('path');
const crypto = require('crypto');
const { pixelCrop, rectangle, annotationLayout } = require('./capture-geometry');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const MAX_PIXELS = 40000000;
const MAX_PNG_BYTES = 64 * 1024 * 1024;

function capturePng(dataUrl, expectedSize, nativeImage) {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/png;base64,')
    || dataUrl.length > MAX_PNG_BYTES * 4 / 3 + 32) throw new Error('The screenshot is too large or is not a PNG.');
  const buffer = Buffer.from(dataUrl.slice(22), 'base64');
  if (buffer.length < 24 || buffer.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('The screenshot could not be read.');
  const width = buffer.readUInt32BE(16), height = buffer.readUInt32BE(20);
  if (!width || !height || width * height > MAX_PIXELS || width !== expectedSize.width || height !== expectedSize.height) {
    throw new Error('The screenshot size changed. Try again.');
  }
  const image = nativeImage.createFromBuffer(buffer, { scaleFactor: 1 });
  if (image.isEmpty()) throw new Error('The screenshot could not be read.');
  return { image, buffer, hash: crypto.createHash('sha256').update(buffer).digest('hex') };
}

function createScreenCapture({ electron, canStart, hideVoxden, restoreVoxden,
  getTarget, targetInfo, isOurTarget, toggleVoice, cancelVoice, pasteImage, pasteText,
  shortcutLabel = () => 'Ctrl+Shift+Space', retryPaste = () => {}, pasteGapMs = 350,
  currentTarget = async () => null }) {
  const { BrowserWindow, desktopCapturer, screen, ipcMain, nativeImage, globalShortcut } = electron;
  let session = null, sequence = 0, exportSequence = 0;
  const windows = new Map();
  const targetValid = target => !!(target && target.hwnd && target.hwnd !== '0' && !isOurTarget(target.hwnd));
  const cancelled = () => Object.assign(new Error('Capture cancelled.'), { cancelled: true });

  function send(win, data) {
    if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send('screen-capture-event', data);
  }
  function owns(hwnd) {
    for (const win of windows.keys()) {
      if (win.isDestroyed()) continue;
      const handle = win.getNativeWindowHandle();
      if (String(hwnd) === (handle.length >= 8 ? handle.readBigUInt64LE().toString() : handle.readUInt32LE().toString())) return true;
    }
    return false;
  }
  function destroyWindow(win) {
    const entry = windows.get(win);
    if (entry) entry.ready();
    windows.delete(win);
    if (!win.isDestroyed()) win.destroy();
  }
  function escape(on) {
    try { globalShortcut.unregister('Escape'); } catch (_) {}
    if (on) globalShortcut.register('Escape', () => close());
  }
  function close(cancelRecording = true) {
    const s = session;
    if (!s) return;
    session = null;
    escape(false);
    if (s.exportRequest) s.exportRequest.reject(cancelled());
    if (cancelRecording) cancelVoice(s.id);
    for (const [win, entry] of windows) if (entry.session === s) destroyWindow(win);
    s.image = null;
    s.failedText = '';
    restoreVoxden();
  }
  function fail(s, message) {
    if (session !== s) return;
    s.stage = 'annotating';
    send(s.win, { type: 'error', message, retry: !!s.failedText, shortcut: shortcutLabel() });
    if (s.win && !s.win.isDestroyed()) s.win.showInactive();
    escape(true);
  }
  function entryFor(event) {
    for (const [win, entry] of windows) {
      if (!win.isDestroyed() && event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame
        && entry.session === session) return { win, ...entry };
    }
    throw new Error('This capture session has ended.');
  }
  async function createSelector(s, bitmap, display) {
    const win = new BrowserWindow({ ...display.bounds, show: false, useContentSize: true, frame: false,
      transparent: true, backgroundColor: '#00000000', skipTaskbar: true, alwaysOnTop: true,
      resizable: false, minimizable: false, maximizable: false, fullscreenable: false, hasShadow: false,
      title: 'Voxden Capture', webPreferences: { preload: path.join(__dirname, 'capture-preload.js'),
        contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
    let ready;
    const rendered = new Promise(resolve => { ready = resolve; });
    windows.set(win, { session: s, kind: 'selection', bitmap, display, ready });
    win.setMenuBarVisibility(false);
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', event => event.preventDefault());
    win.webContents.on('render-process-gone', () => { if (session === s) close(); });
    win.on('closed', () => { if (windows.has(win) && session === s) close(); });
    try { await win.loadFile(path.join(__dirname, 'capture.html')); }
    catch (err) { if (!windows.has(win) || session !== s) return; throw err; }
    let timer;
    try {
      await Promise.race([rendered, new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Capture did not open. Try again.')), 10000);
      })]);
    } finally { clearTimeout(timer); }
  }
  async function start() {
    if (session) {
      for (const win of windows.keys()) if (!win.isDestroyed()) win.showInactive();
      return;
    }
    const reason = canStart();
    if (reason) throw new Error(reason);
    const s = { id: ++sequence, stage: 'selecting', revision: 0, win: null, image: null,
      target: null, targetUpdate: null, targetSequence: 0, exportRequest: null,
      failedText: '', pastedText: null, busy: false };
    session = s;
    try {
      s.target = await getTarget();
      if (session !== s) return;
      hideVoxden(); escape(true);
      await wait(180);
      if (session !== s) return;
      const displays = screen.getAllDisplays();
      const thumbnailSize = {
        width: Math.min(7680, Math.max(...displays.map(d => Math.ceil(d.size.width * d.scaleFactor)))),
        height: Math.min(4320, Math.max(...displays.map(d => Math.ceil(d.size.height * d.scaleFactor)))),
      };
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize, fetchWindowIcons: false });
      if (session !== s) return;
      for (const display of displays) {
        const source = sources.find(item => item.display_id === String(display.id))
          || (displays.length === 1 && sources.length === 1 ? sources[0] : null);
        if (!source || source.thumbnail.isEmpty()) throw new Error('This display could not be captured. Try again.');
        // Normalize NativeImage's representation to pixels before cropping.
        const bitmap = nativeImage.createFromBuffer(source.thumbnail.toPNG(), { scaleFactor: 1 });
        await createSelector(s, bitmap, display);
        if (session !== s) return;
      }
      for (const win of windows.keys()) {
        win.setAlwaysOnTop(true, 'screen-saver');
        win.show();
      }
    } catch (err) {
      if (session !== s) return;
      close(); throw err;
    }
  }

  ipcMain.handle('screen-capture-load', event => {
    const entry = entryFor(event);
    if (entry.kind !== 'selection') throw new Error('Capture has already started.');
    return { image: entry.bitmap.toDataURL(), shortcut: shortcutLabel() };
  });
  ipcMain.handle('screen-capture-select', (event, rect) => {
    try {
      const entry = entryFor(event), s = session;
      if (entry.kind !== 'selection' || s.stage !== 'selecting') return { ok: false, reason: 'Selection has ended.' };
      const viewport = entry.win.getContentBounds();
      const crop = pixelCrop(rect, viewport, entry.bitmap.getSize());
      if (!crop) return { ok: false, reason: 'Drag a slightly larger area.' };
      const selection = rectangle({ x: rect.x, y: rect.y }, { x: rect.x + rect.width, y: rect.y + rect.height }, viewport);
      s.image = entry.bitmap.crop(crop);
      s.revision++;
      s.stage = 'preparing';
      s.win = entry.win;
      s.layout = annotationLayout(selection, viewport);
      // Keep the same native surface and screen position. Only the crop, tools,
      // and short status line retain an input region after selection.
      for (const win of windows.keys()) if (win !== entry.win) destroyWindow(win);
      Object.assign(windows.get(entry.win), { kind: 'annotation', bitmap: null });
      return { ok: true, image: s.image.toDataURL(), revision: s.revision,
        rect: selection, layout: s.layout, shortcut: shortcutLabel() };
    } catch (err) { return { ok: false, reason: err.message }; }
  });
  ipcMain.handle('screen-capture-action', async (event, name, payload = {}) => {
    try {
      const entry = entryFor(event), s = session;
      if (name === 'ready') { entry.ready(); return { ok: true }; }
      if (name === 'cancel' || name === 'load-failed') { close(); return { ok: true }; }
      if (entry.kind !== 'annotation') throw new Error('Select an area first.');
      if (name === 'annotation-ready' && s.stage === 'preparing' && payload.revision === s.revision) {
        entry.win.setShape(s.layout.shapes);
        s.stage = 'annotating';
        try { await toggleVoice(s.id); }
        catch (err) { fail(s, err.message); }
        return { ok: true };
      }
      if (name === 'export') {
        const request = s.exportRequest;
        if (!request || payload.requestId !== request.id || payload.revision !== s.revision) throw new Error('The screenshot changed. Try again.');
        try { request.resolve(capturePng(payload.image, s.image.getSize(), nativeImage)); }
        catch (err) { request.reject(err); }
        return { ok: true };
      }
      if (name === 'retake' && s.stage === 'annotating') { close(); await start(); return { ok: true }; }
      if (name === 'voice' && s.stage === 'annotating') { await toggleVoice(s.id); return { ok: true }; }
      if (name === 'retry' && s.failedText && !s.busy) { retryPaste(); return { ok: true }; }
      throw new Error('Finish the current capture first.');
    } catch (err) { return { ok: false, reason: err.message }; }
  });

  function exportImage(s) {
    return new Promise((resolve, reject) => {
      const id = ++exportSequence;
      const timer = setTimeout(() => finish(new Error('The screenshot could not be prepared. Try again.')), 5000);
      function finish(err, image) {
        clearTimeout(timer);
        if (s.exportRequest && s.exportRequest.id === id) s.exportRequest = null;
        if (err) reject(err); else resolve(image);
      }
      s.exportRequest = { id, resolve: image => finish(null, image), reject: err => finish(err) };
      send(s.win, { type: 'export', requestId: id, revision: s.revision });
    });
  }
  function observeTarget(hwnd) {
    const s = session;
    if (!s || s.stage !== 'annotating' || isOurTarget(hwnd)) return;
    const generation = ++s.targetSequence;
    s.targetUpdate = targetInfo(hwnd).then(target => {
      if (session === s && generation === s.targetSequence) s.target = targetValid(target) ? target : null;
    }).catch(() => { if (session === s && generation === s.targetSequence) s.target = null; });
  }
  async function complete(text, id) {
    const s = session;
    if (!s || s.id !== id) throw cancelled();
    if (s.busy) return false;
    s.busy = true; s.stage = 'finishing'; s.failedText = text;
    const valid = () => session === s;
    try {
      const png = await exportImage(s);
      if (s.targetUpdate) await s.targetUpdate;
      if (!valid()) throw cancelled();
      if (!targetValid(s.target)) throw new Error('Click your chat box, then retry with ' + shortcutLabel() + '.');
      const target = { ...s.target };
      const current = await targetInfo(target.hwnd);
      if (!valid()) throw cancelled();
      if (!targetValid(current) || current.hwnd !== target.hwnd || current.exe !== target.exe) {
        throw new Error('The chat window changed. Click your chat box and retry.');
      }
      s.stage = 'pasting';
      s.win.hide();
      // Text goes first so an image attachment dialog cannot swallow the words.
      // This is one automatic operation; no insertion confirmation is shown.
      if (!s.pastedText || s.pastedText.hwnd !== target.hwnd || s.pastedText.text !== text) {
        await pasteText(text, target.hwnd, valid);
        s.pastedText = { hwnd: target.hwnd, text };
        await wait(pasteGapMs);
      }
      if (!valid()) throw cancelled();
      await pasteImage(png.image, target.hwnd, valid);
      if (!valid()) throw cancelled();
      close(false);
      return true;
    } catch (err) {
      if (valid()) fail(s, err.message);
      throw err;
    } finally { s.busy = false; }
  }
  const displayChanged = () => {
    // Screen coordinates are no longer meaningful after a scale/layout change.
    if (session) close();
  };
  screen.on('display-metrics-changed', displayChanged);
  screen.on('display-added', displayChanged);
  screen.on('display-removed', displayChanged);
  return {
    start, close, owns, observeTarget, complete,
    retry: () => session && session.failedText ? complete(session.failedText, session.id) : Promise.resolve(false),
    get active() { return !!session; },
    get sessionId() { return session && session.id; },
    get hidesOverlay() { return !!session && ['selecting', 'preparing', 'pasting'].includes(session.stage); },
    get canRecord() { return !!session && session.stage === 'annotating' && !session.busy && !session.failedText; },
    get hasRetry() { return !!session && !!session.failedText && !session.busy; },
    speechState(state) {
      const s = session;
      if (!s) return;
      if (['stop', 'transcribing'].includes(state.mode)) {
        if (s.stage === 'annotating') {
          // Sample foreground at the stop gesture too, so a click immediately
          // followed by the shortcut does not race the foreground watcher.
          const pending = s.targetUpdate;
          const foreground = currentTarget().catch(() => null);
          s.targetUpdate = Promise.all([pending, foreground]).then(([_unused, target]) => {
            if (session === s && targetValid(target)) s.target = target;
          });
        }
        s.stage = 'finishing';
      } else if (state.mode === 'error') { s.stage = 'annotating'; escape(true); }
      if (state.mode === 'cancel') { close(false); return; }
      send(s.win, { type: 'speech', mode: state.mode, message: state.text || '', shortcut: shortcutLabel() });
    },
  };
}

module.exports = { createScreenCapture, capturePng };
