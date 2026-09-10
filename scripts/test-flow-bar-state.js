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

  // Exercise the native cursor decision along the paths users take to each
  // revealed control. The screenshot sits above the original horizontal band;
  // it must stay clickable there without revealing from empty space at rest.
  h.context.hoverCursor = { x: 0, y: 0 };
  h.run(`
    overlayWin.isVisible = () => true;
    overlayWin.webContents.send = () => {};
    overlayRect = { x: 0, y: 0, width: 260, height: 96 };
    overlayCursorTick = (() => {
      const screen = { getCursorScreenPoint: () => hoverCursor };
      return ${h.run('overlayCursorTick.toString()')};
    })();
    mode = 'idle'; overlayEditing = false;
  `);
  const cursor = (x, y, expected, message) => {
    h.context.hoverCursor = { x, y };
    h.run('overlayCursorTick();');
    assert.strictEqual(h.run('overlayHover'), expected, message);
    assert.strictEqual(h.context.nativeFlags.at(-1), !expected,
      message + ': native click-through must agree with the visible hover state');
  };
  for (const [style, micY, captureY, sideOffset] of [
    ['classic', 60, 26, 33], ['ribbon', 62, 30, 39], ['orb', 58, 22, 33],
  ]) {
    h.run(`settings.flowBarStyle = '${style}'; overlayHover = false; overlayIgnoreMouse = null;`);
    cursor(130, captureY, false, style + ' screenshot cannot reveal itself while the bar is collapsed');
    cursor(130, 73, true, style + ' resting bar opens the controls');
    for (let y = 73; y >= captureY - 11; y--) {
      cursor(130, y, true, style + ' moving upward must keep the screenshot reachable');
    }
    for (const direction of [-1, 1]) {
      cursor(130, micY, true, style + ' return to the microphone');
      for (let x = 0; x <= sideOffset + 11; x++) {
        cursor(130 + direction * x, micY, true, style + ' moving sideways keeps the side control reachable');
      }
    }
    cursor(170, captureY, false, style + ' the empty upper corner passes through clicks');
    cursor(130, captureY, false, style + ' leaving the cluster restores the tight entry target');
  }
  h.run('settings.flowBarStyle = "classic";');
  console.log('ok screenshot and side controls remain reachable while empty upper corners stay click-through');

  // Arriving on the resting bar must wake the page's input window: Chromium
  // hides it whenever the bar was hidden, minimized or counted as occluded,
  // and only a resize brings it back. One grow-and-restore per entry, from
  // our own rect, never on the ticks that follow, never on the active states
  // showOverlay already rearms, and never under a drag.
  h.context.bounds = [];
  h.run(`
    overlayWin.setBounds = rect => bounds.push(Object.assign({}, rect));
    overlayRect = { x: 40, y: 500, width: 260, height: 96 };
    mode = 'idle'; overlayHover = false; overlayIgnoreMouse = null; overlayDrag = null;
  `);
  h.context.hoverCursor = { x: 170, y: 573 };
  h.run('overlayCursorTick();');
  assert.strictEqual(h.run('overlayHover'), true);
  // Plain JSON: these objects were built inside the harness realm, and a
  // strict deep comparison would reject their foreign Object prototype.
  const plain = value => JSON.parse(JSON.stringify(value));
  assert.deepStrictEqual(plain(h.context.bounds), [
    { x: 40, y: 499, width: 260, height: 97 },
    { x: 40, y: 500, width: 260, height: 96 },
  ], 'hover entry grows the window one pixel upward and puts it straight back');
  assert.deepStrictEqual(plain(h.run('overlayRect')), { x: 40, y: 500, width: 260, height: 96 });
  h.run('overlayCursorTick();');
  assert.strictEqual(h.context.bounds.length, 2, 'staying on the bar does not resize it again');
  h.context.hoverCursor = { x: 900, y: 900 };
  h.run('overlayCursorTick();');
  assert.strictEqual(h.run('overlayHover'), false);
  assert.strictEqual(h.context.bounds.length, 2, 'leaving the bar does not resize it');
  h.run("mode = 'recording';");
  h.context.hoverCursor = { x: 170, y: 573 };
  h.run('overlayCursorTick();');
  assert.strictEqual(h.context.bounds.length, 2, 'active controls were rearmed by showOverlay, not by hover');
  h.run("mode = 'idle'; overlayHover = false; overlayDrag = { x: 40, y: 500 };");
  h.run('overlayCursorTick();');
  assert.strictEqual(h.context.bounds.length, 2, 'a held grip is never resized under the hand');
  h.run('overlayDrag = null; overlayHover = false; rearmOverlayInput();');
  assert.strictEqual(h.context.bounds.length, 4, 'showOverlay-style rearm resizes once the drag is over');
  console.log('ok hover entry rearms the native input window once, in place');

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
    overlayRect = { x: 0, y: 0, width: 260, height: 96 };
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
