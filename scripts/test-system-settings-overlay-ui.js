'use strict';

// Send real main-process settings snapshots into the actual overlay renderer.
// The native window and login registration are inert, and capture is observed
// without opening a microphone or running a speech engine.
const { app, BrowserWindow, ipcMain, session } = require('electron');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const harness = require('./asr-test-harness');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'voxden-system-overlay-')));
app.disableHardwareAcceleration();
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const deadline = setTimeout(() => { console.error('System overlay settings timed out'); app.exit(1); }, 30000);

app.whenReady().then(async () => {
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  const win = new BrowserWindow({ show: false, width: 260, height: 84, useContentSize: true,
    webPreferences: { preload: path.join(__dirname, '../src/preload.js'), contextIsolation: true,
      sandbox: false, backgroundThrottling: false, offscreen: true } });
  const errors = [];
  win.webContents.on('console-message', event => {
    if ((event.level === 'error' || Number(event.level) >= 3)
        && !/Content-Security-Policy/.test(event.message)) errors.push(event.message);
  });
  await win.loadFile(path.join(__dirname, '../src/overlay.html'));
  const run = code => win.webContents.executeJavaScript(code);
  const h = harness();
  const native = {
    visible: true,
    isDestroyed: () => false,
    isVisible() { return this.visible; },
    showInactive() { this.visible = true; },
    hide() { this.visible = false; },
    isFocused: () => false,
    setBounds() {}, setAlwaysOnTop() {}, setFocusable() {}, setIgnoreMouseEvents() {}, focus() {},
    webContents: win.webContents,
  };
  let editCalls = 0;
  ipcMain.handle('history-edit', () => { editCalls++; return {}; });
  for (const channel of ['hud-hidden', 'overlay-hold', 'overlay-release', 'hud-ignore-mouse', 'overlay-drag-end']) {
    ipcMain.on(channel, (...args) => h.ipcEvents.get(channel)(...args));
  }
  h.context.systemOverlayWindow = native;
  h.run(`
    app.setLoginItemSettings = () => {};
    overlayWin = systemOverlayWindow;
    positionOverlay = () => {};
    captureOverlayHwnd = () => {};
    settings.soundsEnabled = false;
    settings.alwaysShowFlowBar = true;
    settings.keepTrainingAudio = false;
    corpus.hasRetry = () => true;
  `);
  await run(`
    window.systemCaptureStarts = 0;
    window.systemMicRequests = 0;
    window.systemCues = [];
    startCapture = async () => { window.systemCaptureStarts++; };
    navigator.mediaDevices.getUserMedia = async () => {
      window.systemMicRequests++; throw new Error('A System settings test must not open a microphone');
    };
    playCue = kind => window.systemCues.push(kind);
    true
  `);
  const patch = async value => { await h.handlers.get('settings-set')({}, value); await pause(35); };
  const state = async value => {
    h.context.systemState = value;
    h.run('mode = systemState.mode; sendOverlay(systemState)');
    await pause(35);
  };
  const checkRetry = async available => {
    assert.deepStrictEqual(await run(`({ retry: pill.classList.contains('can-retry'),
      pointer: getComputedStyle(btnConfirm).pointerEvents, tab: btnConfirm.tabIndex,
      title: btnConfirm.title, aria: btnConfirm.getAttribute('aria-label') })`), {
      retry: available, pointer: available ? 'auto' : 'none', tab: available ? 0 : -1,
      title: available ? 'Retry last dictation' : 'Stop and transcribe',
      aria: available ? 'Retry last dictation' : 'Stop recording and transcribe',
    }, 'retry availability must update its visible, pointer, keyboard and accessible controls together');
  };

  try {
    for (const style of ['classic', 'ribbon', 'orb']) {
      await state({ mode: 'idle' });
      await patch({ alwaysShowFlowBar: true, flowBarStyle: style, keepRecordings: true });
      await state({ mode: 'success', text: 'Original result', entryId: 'entry-123', reveal: true });
      await run("beginSuccessEdit(); label.textContent = 'Unsaved user edit'; true");
      await pause(20);
      const before = await run(`({ text: label.textContent, id: successEntryId, editable: label.isContentEditable,
        editing: editingSuccess, generation: captureGen, cues: window.systemCues.length })`);
      assert.strictEqual(before.editable, true);
      assert.strictEqual(before.editing, true);
      assert.strictEqual(h.run('overlayEditing'), true, 'the real hold channel must be active');
      await checkRetry(true);
      for (const value of [{ launchAtLogin: true }, { soundsEnabled: false }, { alwaysShowFlowBar: false },
        { flowBarMotion: 'reduced' }, { alwaysShowFlowBar: true }, { keepRecordings: false }, { keepRecordings: true }]) {
        await patch(value);
        assert.deepStrictEqual(await run(`({ text: label.textContent, id: successEntryId, editable: label.isContentEditable,
          editing: editingSuccess, generation: captureGen, cues: window.systemCues.length })`), before,
        style + ' preferences must preserve a held editable result and its unsaved text');
        assert.strictEqual(h.run('overlayEditing'), true);
        await checkRetry(h.run('settings.keepRecordings'));
      }
      assert.strictEqual(editCalls, 0, 'preference updates cannot silently commit an unfinished edit');
      await run('cancelSuccessEdit = true; commitSuccessEdit(); true');
      await state({ mode: 'error', text: 'Microphone was disconnected. Reconnect it and try again.', reveal: true });
      const errorBefore = await run('({text:label.textContent,generation:captureGen,cues:window.systemCues.length})');
      await checkRetry(true);
      await patch({ launchAtLogin: false, alwaysShowFlowBar: false });
      assert.deepStrictEqual(await run('({text:label.textContent,generation:captureGen,cues:window.systemCues.length})'),
        errorBefore, style + ' preferences must preserve the specific error without replaying its cue');
      await patch({ keepRecordings: false });
      await checkRetry(false);
      assert.deepStrictEqual(await run('({text:label.textContent,generation:captureGen,cues:window.systemCues.length})'),
        errorBefore, 'removing retry cannot clear the error or replay its transition');
    }
    console.log('ok all flow styles preserve held edits and errors while retry controls follow retained audio');

    for (const mode of ['arming', 'recording', 'transcribing']) {
      await state({ mode: 'idle' });
      await patch({ flowBarStyle: 'classic', alwaysShowFlowBar: true });
      h.run(`mode = '${mode}'; recordingSessionToken = 77;`);
      await run(`capturing = ${mode === 'recording'}; captureGen = 41;
        pcmChunks = [new Float32Array([0.1, 0.2])]; setHud('${mode}'); popIn(); true`);
      const before = await run(`({ mode: hudMode, capturing, generation: captureGen,
        chunks: pcmChunks.length, starts: window.systemCaptureStarts, cues: window.systemCues.length })`);
      for (const value of [{ launchAtLogin: true }, { alwaysShowFlowBar: false },
        { flowBarStyle: 'orb', flowBarMotion: 'full' }, { flowBarMotion: 'reduced' }, { alwaysShowFlowBar: true }]) {
        await patch(value);
        assert.deepStrictEqual(await run(`({ mode: hudMode, capturing, generation: captureGen,
          chunks: pcmChunks.length, starts: window.systemCaptureStarts, cues: window.systemCues.length })`), before,
        'preferences cannot restart or reset ' + mode);
        assert.strictEqual(h.run('recordingSessionToken'), 77);
        if (mode === 'recording') {
          assert.strictEqual(await run('pill.title'),
            'Press ' + h.run('formatShortcutLabel(settings.shortcut)') + ' again to finish',
            'a preference update must retain the recording shortcut tooltip');
        }
      }
      if (mode === 'recording') {
        await patch({ dictateMode: 'ptt' });
        assert.strictEqual(await run('pill.title'),
          'Release ' + h.run('formatShortcutLabel(settings.shortcut)') + ' to finish');
        h.run('pttLocked = true');
        await patch({ soundsEnabled: false });
        assert.strictEqual(await run('pill.title'),
          'Press ' + h.run('formatShortcutLabel(settings.shortcut)') + ' again to finish',
          'a locked push-to-talk tooltip must survive the engine status in preference snapshots');
        h.run('pttLocked = false');
        await patch({ dictateMode: 'toggle' });
      }
      assert.deepStrictEqual(await run(`({ style: flowBarStyle, pending: pendingFlowBarStyle,
        motion: window.VoxdenFlowMotion.preference, css: document.documentElement.dataset.flowMotion })`),
      { style: 'classic', pending: 'orb', motion: 'reduced', css: 'reduced' },
      'active style changes remain queued while motion changes apply immediately');
      await run('capturing = false; pcmChunks = []; true');
      await state({ mode: 'idle' });
      assert.strictEqual(await run('flowBarStyle'), 'orb', 'the queued style applies on the real idle transition');
    }
    console.log('ok active capture state survives preference updates while style and motion preferences still apply');

    await patch({ alwaysShowFlowBar: false });
    await pause(400);
    assert.strictEqual(await run("document.body.classList.contains('shown')"), false);
    assert.strictEqual(native.visible, false, 'idle OFF still completes the renderer-to-main hide handshake');
    await patch({ alwaysShowFlowBar: true });
    assert.strictEqual(native.visible, true);
    assert.strictEqual(await run("document.body.classList.contains('shown')"), true);
    assert.strictEqual(await run('window.systemMicRequests'), 0);
    assert.strictEqual(await run('window.systemCaptureStarts'), 0, 'no settings change may start capture');
    assert.deepStrictEqual(errors, []);
    console.log('ok idle visibility toggles still hide and reveal the bar without requesting a microphone');
  } finally {
    clearTimeout(deadline);
    h.close();
    win.destroy();
  }
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
