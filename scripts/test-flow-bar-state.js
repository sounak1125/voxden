'use strict';

const assert = require('assert');
const harness = require('./asr-test-harness');

const h = harness();
try {
  h.context.states = [];
  h.context.nativeFlags = [];
  h.run(`
    settings.alwaysShowFlowBar = false;
    overlayWin = { isDestroyed: () => false, webContents: {},
      setIgnoreMouseEvents: flag => nativeFlags.push(flag) };
    showOverlay = () => {};
    sendOverlay = extra => states.push({ mode, prepareOnly: mediaPreparing, ...extra });
  `);
  const event = { sender: h.run('overlayWin.webContents') };
  const ready = h.ipcEvents.get('hud-ready');
  for (const mode of ['idle', 'arming', 'recording', 'transcribing']) {
    h.run(`mode = '${mode}'; mediaPreparing = false;`);
    ready(event);
    assert.strictEqual(h.context.states.at(-1).mode, mode,
      'a late ready handshake must replay the current mode');
    assert.strictEqual(h.context.states.at(-1).prepareOnly, false);
    assert.strictEqual(h.context.states.at(-1).reveal, mode !== 'idle');
  }
  const count = h.context.states.length;
  ready({ sender: {} });
  assert.strictEqual(h.context.states.length, count, 'another page cannot reset the overlay');
  console.log('ok late renderer readiness preserves an in-flight dictation');

  const ignore = h.ipcEvents.get('hud-ignore-mouse');
  for (const mode of ['arming', 'recording', 'transcribing', 'success', 'error', 'cancel', 'learned']) {
    h.run(`mode = '${mode}'; overlayIgnoreMouse = null;`);
    ignore(event, true);
    assert.strictEqual(h.context.nativeFlags.at(-1), false,
      'an idle click-through request cannot disable controls in ' + mode);
  }
  h.run('mode = "idle"; overlayHover = true; overlayIgnoreMouse = null;');
  ignore(event, true);
  assert.strictEqual(h.context.nativeFlags.at(-1), false, 'an old leave cannot override the current native hover');
  h.run('overlayHover = false;');
  ignore(event, true);
  assert.strictEqual(h.context.nativeFlags.at(-1), true, 'idle space still passes through clicks');
  h.run('overlayEditing = true;');
  ignore(event, true);
  assert.strictEqual(h.context.nativeFlags.at(-1), false, 'editing keeps native input enabled');
  console.log('ok delayed idle input messages cannot disable active controls');

  h.run(`overlayIgnoreMouse = null; let failNativeInput = true;
    overlayWin.setIgnoreMouseEvents = flag => {
      if (failNativeInput) { failNativeInput = false; throw new Error('Native window temporarily unavailable'); }
      nativeFlags.push(flag);
    };
    setOverlayMouseIgnore(false);`);
  assert.strictEqual(h.run('overlayIgnoreMouse'), null, 'native failures cannot be cached as success');
  const before = h.context.nativeFlags.length;
  h.run('setOverlayMouseIgnore(false);');
  assert.strictEqual(h.context.nativeFlags.length, before + 1, 'the same desired input state is retried');
  assert.strictEqual(h.run('overlayIgnoreMouse'), false);
  console.log('ok failed native input updates can recover');

  // The regular cursor poll must perform that retry even if the cursor and
  // recording state stay unchanged after the initial native failure.
  h.run(`
    overlayWin.isVisible = () => true;
    overlayWin.webContents.send = () => {};
    overlayRect = { x: 0, y: 0, width: 260, height: 84 };
    let inputRetryCalls = 0;
    overlayWin.setIgnoreMouseEvents = flag => {
      inputRetryCalls++;
      if (inputRetryCalls === 1) throw new Error('Temporary native failure');
      nativeFlags.push(flag);
    };
    overlayCursorTick = (() => {
      const screen = { getCursorScreenPoint: () => ({ x: 0, y: 0 }) };
      return ${h.run('overlayCursorTick.toString()')};
    })();
    mode = 'recording'; overlayIgnoreMouse = null;
    overlayCursorTick(); overlayCursorTick();
  `);
  assert.strictEqual(h.run('inputRetryCalls'), 2);
  assert.strictEqual(h.context.nativeFlags.at(-1), false);
  console.log('ok active controls retry native input without another hover or state change');

  h.run('let acceptedTranscripts = 0; onTranscript = async () => { acceptedTranscripts++; };');
  for (const channel of ['capture-failed', 'transcript', 'cancelled']) {
    h.run('mode = "recording";');
    h.ipcEvents.get(channel)({ sender: {} }, 'old page result');
    assert.strictEqual(h.run('mode'), 'recording', channel + ' from an old page cannot alter the new recording');
  }
  assert.strictEqual(h.run('acceptedTranscripts'), 0);
  h.run('mode = "idle";');
  h.ipcEvents.get('capture-failed')(event, 'late failure');
  assert.strictEqual(h.run('mode'), 'idle', 'a settled capture cannot be failed by a late message');
  h.run('mode = "transcribing";');
  h.ipcEvents.get('transcript')(event, 'current result');
  assert.strictEqual(h.run('acceptedTranscripts'), 1, 'the current page still delivers its transcript');
  console.log('ok terminal capture messages belong to the current overlay and active session');
} finally { h.close(); }
