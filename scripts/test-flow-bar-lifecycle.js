'use strict';

// Real main-process lifecycle code, with an inert native window and a fake
// clock. Exercise renderer liveness independently of microphone/ASR speed.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const mainHarness = require('./asr-test-harness');
const mainSource = fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8');
const createOverlaySource = mainSource.slice(
  mainSource.indexOf('function createOverlay() {'),
  mainSource.indexOf('\nfunction createHistoryWindow() {')
);

function fixture({ ready = true, visible = true, mode = 'idle', failLoad = false } = {}) {
  const h = mainHarness();
  const windows = [];
  const events = [];
  h.context.testNow = 100000;
  h.context.testEvents = events;
  h.context.testResumes = 0;
  h.context.MockOverlayWindow = class extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.destroyed = false;
      this.visible = visible;
      this.hides = 0;
      this.shows = 0;
      this.webContents = new EventEmitter();
      this.webContents.sent = [];
      this.webContents.send = (channel, value) => this.webContents.sent.push({ channel, value });
      windows.push(this);
    }
    isDestroyed() { return this.destroyed; }
    isVisible() { return this.visible; }
    isFocused() { return this.focused || false; }
    hide() { this.visible = false; this.hides++; }
    showInactive() { this.visible = true; this.shows++; }
    setAlwaysOnTop() {}
    setVisibleOnAllWorkspaces() {}
    setMenuBarVisibility() {}
    setIgnoreMouseEvents(value) { this.ignoreMouse = value; }
    setFocusable(value) { this.focusable = value; }
    loadFile() {
      this.webContents.emit('did-start-loading');
      return failLoad ? Promise.reject(Object.assign(new Error('Load failed'), { code: 'ERR_FAILED' })) : Promise.resolve();
    }
    destroy() { this.destroyed = true; this.emit('closed'); }
  };
  h.run(`
    Date.now = () => testNow;
    diagLog = (event, fields) => testEvents.push({ event, ...fields });
    resumeBackgroundMedia = () => { testResumes++; };
    showOverlay = () => {};
    applyWindowIcon = () => {};
    positionOverlay = () => {};
    captureOverlayHwnd = () => {};
    createOverlay = (() => {
      const BrowserWindow = MockOverlayWindow;
      return ${createOverlaySource};
    })();
    mode = ${JSON.stringify(mode)};
    createOverlay();
  `);
  if (ready) {
    h.ipcEvents.get('hud-ready')({ sender: windows.at(-1).webContents });
  }
  function tick(ms, answer = false, frame = true) {
    for (let elapsed = 0; elapsed < ms; elapsed += 1000) {
      h.context.testNow += Math.min(1000, ms - elapsed);
      h.run('overlayHealthTick(Date.now())');
      if (answer) pong(frame);
    }
  }
  function pong(frame = true) {
    const win = windows.at(-1);
    const ping = win.webContents.sent.filter(entry => entry.channel === 'hud-ping').at(-1);
    if (ping) {
      h.ipcEvents.get('hud-pong')({ sender: win.webContents }, ping.value);
      if (frame) h.ipcEvents.get('hud-frame')({ sender: win.webContents }, ping.value);
    }
  }
  return { h, windows, events, tick, pong, close: h.close };
}

let passed = 0;
async function check(name, run) {
  await run();
  passed++;
  console.log('ok', name);
}

(async () => {
for (const mode of ['recording', 'transcribing', 'success']) {
  await check('a permanently frozen ' + mode + ' renderer is replaced after its grace period', async () => {
    const f = fixture({ mode });
    try {
      f.h.run('recordingSessionToken = 7; overlayEditing = true; pttLocked = true');
      f.tick(19000);
      assert.strictEqual(f.windows.length, 1, 'the existing miss threshold still gives busy pages time');
      assert.strictEqual(f.h.run('mode'), mode);
      f.tick(9000);
      assert.strictEqual(f.windows.length, 1, 'a busy page gets extra grace after becoming frozen');
      f.tick(1000);
      assert.strictEqual(f.windows.length, 2, 'a busy state cannot permanently exempt a dead renderer');
      assert(f.windows[0].isDestroyed());
      assert.strictEqual(f.h.run('mode'), 'idle');
      assert.strictEqual(f.h.run('recordingSessionToken'), 8, 'late dictation work is invalidated');
      assert.strictEqual(f.h.run('overlayEditing'), false);
      assert.strictEqual(f.h.run('pttLocked'), false);
      assert.strictEqual(f.h.context.testResumes, 1, 'paused media is released');
      assert.strictEqual(f.events.filter(e => e.event === 'overlay-frozen-busy').length, 1);
    } finally { await f.close(); }
  });
}

await check('healthy long transcription work is never limited by the renderer watchdog', async () => {
  const f = fixture({ mode: 'transcribing' });
  try {
    f.tick(180000, true);
    assert.strictEqual(f.windows.length, 1);
    assert.strictEqual(f.h.run('mode'), 'transcribing');
    assert.strictEqual(f.events.length, 0);
  } finally { await f.close(); }
});

await check('stalled animation frames re-show the existing window without abandoning capture', async () => {
  const f = fixture({ mode: 'recording' });
  try {
    const win = f.windows[0];
    f.h.run('recordingSessionToken = 7; recordingStartedAt = Date.now(); setOverlayMouseIgnore(false)');
    f.tick(18000, true, false);
    assert.strictEqual(win.hides, 0, 'frame delivery has the same generous miss threshold');
    f.tick(1000, true, false);
    assert.strictEqual(win.hides, 1);
    assert.strictEqual(win.shows, 1);
    assert.strictEqual(f.windows.length, 1, 'the page holding audio remains alive');
    assert.strictEqual(win.isDestroyed(), false);
    assert.strictEqual(win.ignoreMouse, false, 'recording controls remain clickable');
    assert.strictEqual(f.h.run('mode'), 'recording');
    assert.strictEqual(f.h.run('recordingSessionToken'), 7);
    assert.strictEqual(f.h.run('recordingStartedAt'), 100000);
    assert.strictEqual(f.h.context.testResumes, 0, 'a paint repair cannot release the live recording');
    f.tick(29000, true, false);
    assert.strictEqual(win.hides, 1, 'a repeated compositor failure is rate limited');
    f.tick(1000, true, false);
    assert.strictEqual(win.hides, 2);
    f.tick(60000, true);
    assert.strictEqual(win.hides, 2, 'restored frames end compositor recovery');
  } finally { await f.close(); }
});

await check('stalled frames never blur a held result editor', async () => {
  const f = fixture({ mode: 'success' });
  try {
    f.h.run('overlayEditing = true');
    f.windows[0].focused = true;
    f.tick(60000, true, false);
    assert.strictEqual(f.windows[0].hides, 0);
    assert.strictEqual(f.h.run('mode'), 'success');
    assert.strictEqual(f.windows.length, 1);
  } finally { await f.close(); }
});

await check('stalled frames never hide a window while the flow bar is being dragged', async () => {
  const f = fixture();
  try {
    f.h.run('overlayDrag = { startedAt: Date.now() }');
    f.tick(60000, true, false);
    assert.strictEqual(f.windows[0].hides, 0, 'native surface repair must not break pointer capture');
    assert.strictEqual(f.windows.length, 1);
    assert.notStrictEqual(f.h.run('overlayDrag'), null);
    assert.strictEqual(f.h.run('overlayFrameRestore'), null);
  } finally { await f.close(); }
});

await check('a failed native show is retried at the ping cadence without discarding live capture', async () => {
  const f = fixture({ mode: 'recording' });
  try {
    const win = f.windows[0];
    const page = win.webContents;
    let attempts = 0;
    const show = win.showInactive.bind(win);
    win.showInactive = () => {
      attempts++;
      if (attempts === 1) throw Object.assign(new Error('Native surface unavailable'), { code: 'TEST_SHOW' });
      show();
    };
    f.h.run('recordingSessionToken = 7; recordingStartedAt = Date.now(); setOverlayMouseIgnore(false)');
    const priorStates = page.sent.filter(e => e.channel === 'state').length;
    f.tick(19000, true, false);
    assert.strictEqual(attempts, 1);
    assert.strictEqual(win.isVisible(), false);
    assert.notStrictEqual(f.h.run('overlayFrameRestore'), null, 'a failed show keeps a pending same-page restore');
    f.tick(4000, true, false);
    assert.strictEqual(attempts, 1, 'native retries cannot loop on each health tick');
    f.tick(1000, true, false);
    assert.strictEqual(attempts, 2);
    assert.strictEqual(win.isVisible(), true);
    assert.strictEqual(win.hides, 1);
    assert.strictEqual(f.h.run('overlayFrameRestore'), null);
    assert.strictEqual(f.windows.length, 1);
    assert.strictEqual(win.webContents, page, 'the renderer holding recorded PCM is retained');
    assert.strictEqual(page.sent.filter(e => e.channel === 'state').length, priorStates,
      'surface recovery must not send capture stop/reset state');
    assert.strictEqual(f.h.run('mode'), 'recording');
    assert.strictEqual(f.h.run('recordingSessionToken'), 7);
    assert.strictEqual(f.h.run('recordingStartedAt'), 100000);
    assert.strictEqual(f.h.context.testResumes, 0);
    assert.strictEqual(win.ignoreMouse, false);
  } finally { await f.close(); }
});

await check('a deferred idle surface restore uses current recording input state', async () => {
  const f = fixture();
  try {
    const win = f.windows[0];
    let attempts = 0;
    const show = win.showInactive.bind(win);
    win.showInactive = () => {
      if (++attempts === 1) throw new Error('Native surface unavailable');
      show();
    };
    f.h.run('overlayHover = false; setOverlayMouseIgnore(true)');
    f.tick(19000, true, false);
    assert.strictEqual(win.isVisible(), false);
    assert.strictEqual(win.ignoreMouse, true);
    // A shortcut can change mode before a native show succeeds. The old idle
    // ignore flag must not overwrite the current recording's clickable HUD.
    f.h.run('mode = "recording"; recordingSessionToken = 8; recordingStartedAt = Date.now()');
    f.tick(5000, true, false);
    assert.strictEqual(attempts, 2);
    assert.strictEqual(win.isVisible(), true);
    assert.strictEqual(win.ignoreMouse, false);
    assert.strictEqual(f.h.run('overlayIgnoreMouse'), false);
    assert.strictEqual(f.h.run('mode'), 'recording');
    assert.strictEqual(f.h.run('recordingSessionToken'), 8);
    assert.strictEqual(f.h.context.testResumes, 0);
    assert.strictEqual(f.windows.length, 1);
  } finally { await f.close(); }
});

await check('hidden and locked pages do not accumulate frozen renderer or frame verdicts', async () => {
  for (const locked of [false, true]) {
    const f = fixture({ mode: 'recording', visible: locked });
    try {
      f.h.run(`overlayScreenLocked = ${locked}`);
      f.tick(90000);
      assert.strictEqual(f.windows.length, 1);
      assert.strictEqual(f.windows[0].hides, 0);
      assert.strictEqual(f.h.run('mode'), 'recording');
      f.h.run('overlayScreenLocked = false; resetOverlayHealth()');
      f.windows[0].visible = true;
      f.tick(18000, true);
      assert.strictEqual(f.windows.length, 1);
      assert.strictEqual(f.windows[0].hides, 0);
    } finally { await f.close(); }
  }
});

await check('a busy renderer can recover during grace and starts fresh on a later freeze', async () => {
  const f = fixture({ mode: 'recording' });
  try {
    f.tick(24000);
    assert.strictEqual(f.windows.length, 1);
    f.pong();
    f.tick(10000, true);
    assert.strictEqual(f.h.run('overlayFrozenSince'), null);
    assert.strictEqual(f.windows.length, 1);
    f.tick(22000);
    assert.strictEqual(f.windows.length, 1, 'the prior episode cannot consume the next grace period');
  } finally { await f.close(); }
});

await check('a hidden renderer that never sends ready is replaced with a bounded retry rate', async () => {
  const f = fixture({ ready: false, visible: false });
  try {
    f.tick(19000);
    assert.strictEqual(f.windows.length, 1);
    f.tick(1000);
    assert.strictEqual(f.windows.length, 2);
    assert.strictEqual(f.events.at(-1).reason, 'ready-timeout');
    f.tick(19000);
    assert.strictEqual(f.windows.length, 2, 'the replacement gets a fresh loading deadline');
    f.tick(1000);
    assert.strictEqual(f.windows.length, 3);
    f.h.ipcEvents.get('hud-ready')({ sender: f.windows.at(-1).webContents });
    f.tick(60000, true);
    assert.strictEqual(f.windows.length, 3, 'a recovered hidden page is not repeatedly rebuilt');
  } finally { await f.close(); }
});

await check('main-process stalls reset frozen grace and loading deadlines', async () => {
  const f = fixture({ mode: 'recording' });
  try {
    f.tick(24000);
    f.h.context.testNow += 60000;
    f.h.run('overlayHealthTick(Date.now())');
    assert.strictEqual(f.h.run('overlayFrozenSince'), null);
    f.tick(24000);
    assert.strictEqual(f.windows.length, 1);
  } finally { await f.close(); }
  const loading = fixture({ ready: false, visible: false });
  try {
    loading.tick(19000);
    loading.h.context.testNow += 60000;
    loading.h.run('overlayHealthTick(Date.now())');
    loading.tick(19000);
    assert.strictEqual(loading.windows.length, 1, 'sleep/stall time does not consume startup grace');
  } finally { await loading.close(); }
});

await check('a second renderer crash during cooldown cannot leave a dead page marked ready', async () => {
  const f = fixture();
  try {
    f.windows[0].webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
    assert.strictEqual(f.windows.length, 2);
    f.h.ipcEvents.get('hud-ready')({ sender: f.windows[1].webContents });
    f.windows[1].webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
    assert.strictEqual(f.windows.length, 2, 'the cooldown avoids an immediate crash loop');
    assert.strictEqual(f.h.run('overlayReady'), false);
    const timer = f.h.timers.get(f.h.run('overlayRecreateTimer'));
    assert(timer);
    assert.strictEqual(timer.delay, 10000);
    f.h.context.testNow += timer.delay;
    timer.fn();
    assert.strictEqual(f.windows.length, 3, 'the deferred retry really replaces the crashed page');
    assert(f.windows[1].isDestroyed());
  } finally { await f.close(); }
});

await check('a ready event from a replaced renderer cannot reset the active page', async () => {
  const f = fixture({ mode: 'recording' });
  try {
    const before = f.windows[0].webContents.sent.length;
    f.h.ipcEvents.get('hud-ready')({ sender: {} });
    assert.strictEqual(f.windows[0].webContents.sent.length, before);
    f.h.ipcEvents.get('hud-ready')({ sender: f.windows[0].webContents });
    assert.strictEqual(f.windows[0].webContents.sent.at(-1).value.mode, 'recording');
  } finally { await f.close(); }
});

for (const mode of ['arming', 'recording', 'transcribing', 'success']) {
  await check('reloading a ready ' + mode + ' page discards its interrupted session before replay', async () => {
    const f = fixture({ mode });
    try {
      const win = f.windows[0];
      f.h.run(`
        recordingSessionToken = 9;
        recordingStartedAt = Date.now();
        mediaPreparing = true;
        pttReleasePending = true;
        overlayEditing = true;
        successTimer = setTimeout(() => {}, 1800);
        armingTimer = setTimeout(() => {}, ARMING_TIMEOUT_MS);
      `);
      win.setFocusable(true);
      win.webContents.emit('did-start-loading');
      assert.strictEqual(f.h.run('mode'), 'idle', 'the new document cannot continue old PCM or an old awaited result');
      assert.strictEqual(f.h.run('recordingSessionToken'), 10, 'asynchronous old work is invalidated');
      assert.strictEqual(f.h.run('overlayReady'), false);
      assert.strictEqual(f.h.run('overlayEditing'), false);
      assert.strictEqual(f.h.run('recordingStartedAt'), 0);
      assert.strictEqual(f.h.run('mediaPreparing'), false);
      assert.strictEqual(f.h.run('pttReleasePending'), false);
      assert.strictEqual(f.h.run('successTimer'), null);
      assert.strictEqual(f.h.run('armingTimer'), null);
      assert.strictEqual(win.focusable, false, 'a held success editor cannot leave the reloaded page focusable');
      assert.strictEqual(f.h.context.testResumes, 1, 'reload releases media held by the lost capture');
      assert(f.events.some(e => e.event === 'dictation-abandoned' && e.why === 'renderer-reload'));
      f.h.ipcEvents.get('hud-ready')({ sender: win.webContents });
      assert.strictEqual(win.webContents.sent.at(-1).value.mode, 'idle', 'ready must not reopen the lost microphone or spinner');
      assert.strictEqual(f.windows.length, 1, 'ordinary reload reuses the native window');
    } finally { await f.close(); }
  });
}

await check('initial cold arming survives loading and replays the current media preparation state', async () => {
  for (const preparing of [true, false]) {
    const f = fixture({ mode: 'arming', ready: false });
    try {
      f.h.run(`recordingSessionToken = 9; mediaPreparing = ${preparing}`);
      f.windows[0].webContents.emit('did-start-loading');
      assert.strictEqual(f.h.run('mode'), 'arming');
      assert.strictEqual(f.h.run('recordingSessionToken'), 9);
      assert.strictEqual(f.h.context.testResumes, 0, 'initial loading must not abandon the queued dictation');
      f.h.ipcEvents.get('hud-ready')({ sender: f.windows[0].webContents });
      const state = f.windows[0].webContents.sent.at(-1).value;
      assert.strictEqual(state.mode, 'arming');
      assert.strictEqual(state.prepareOnly, preparing);
      assert.strictEqual(state.reveal, true);
      assert.strictEqual(f.h.run('recordingSessionToken'), 9);
      assert.strictEqual(f.h.run('overlayReady'), true);
    } finally { await f.close(); }
  }
});

  const f = fixture({ ready: false, visible: false, failLoad: true });
  try {
    // Allow both failed load promises to reach the production rejection path.
    await Promise.resolve();
    await Promise.resolve();
    assert.strictEqual(f.windows.length, 2, 'the first load failure is replaced promptly');
    assert.strictEqual(f.h.run('overlayReady'), false);
    const timer = f.h.timers.get(f.h.run('overlayRecreateTimer'));
    assert(timer, 'repeated load failures schedule one bounded retry');
    assert.strictEqual(timer.delay, 10000);
    assert.strictEqual(f.events.filter(e => e.event === 'overlay-load-failed').length, 2);
    f.h.context.testNow += timer.delay;
    timer.fn();
    await Promise.resolve();
    assert.strictEqual(f.windows.length, 3, 'a failed page is retried after cooldown');
    assert(f.h.timers.get(f.h.run('overlayRecreateTimer')));
    passed++;
    console.log('ok repeated page-load rejection is caught and rate-limited');
  } finally { await f.close(); }
  console.log('flow bar lifecycle: ' + passed + ' checks passed');
})().catch(err => { console.error(err); process.exitCode = 1; });
