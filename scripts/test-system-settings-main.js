'use strict';

// Exercise the real settings IPC and native overlay lifecycle with an inert
// window. Login registration and profile writes stay inside this fixture.
const assert = require('assert');
const fs = require('fs');
const harness = require('./asr-test-harness');

function fixture({ visible = false } = {}) {
  const h = harness();
  const loginCalls = [];
  const states = [];
  const win = {
    visible,
    showAttempts: 0,
    failShows: 0,
    hides: 0,
    input: [],
    isDestroyed: () => false,
    isVisible() { return this.visible; },
    isFocused: () => false,
    showInactive() {
      this.showAttempts++;
      if (this.failShows-- > 0) throw new Error('Native surface temporarily unavailable');
      this.visible = true;
    },
    hide() { this.visible = false; this.hides++; },
    setBounds() {},
    setAlwaysOnTop() {},
    setFocusable() {},
    setIgnoreMouseEvents(value) { this.input.push(value); },
    webContents: {
      send(channel, value) { if (channel === 'state') states.push(value); },
    },
  };
  h.context.systemTestWindow = win;
  h.context.systemTestLogin = options => loginCalls.push(options);
  h.run(`
    app.setLoginItemSettings = systemTestLogin;
    overlayWin = systemTestWindow;
    overlayRect = { x: 0, y: 0, width: 260, height: 84 };
    positionOverlay = () => {};
    captureOverlayHwnd = () => {};
    overlayCursorTick = (() => {
      const screen = { getCursorScreenPoint: () => ({ x: 130, y: 60 }) };
      return ${h.run('overlayCursorTick.toString()')};
    })();
  `);
  return { h, win, loginCalls, states, set: h.handlers.get('settings-set'), close: h.close };
}

(async () => {
  for (const launchAtLogin of [false, true]) {
    for (const alwaysShowFlowBar of [false, true]) {
      const f = fixture();
      try {
        const result = await f.set({}, { launchAtLogin, alwaysShowFlowBar });
        assert.strictEqual(result.launchAtLogin, launchAtLogin);
        assert.strictEqual(result.alwaysShowFlowBar, alwaysShowFlowBar);
        assert.strictEqual(f.loginCalls.at(-1).openAtLogin, launchAtLogin);
        assert.strictEqual(f.win.visible, alwaysShowFlowBar,
          'cold idle visibility follows the bar preference independently of login');
        assert.strictEqual(f.h.run('mode'), 'idle');
        assert.strictEqual(f.states.at(-1).alwaysShowFlowBar, alwaysShowFlowBar);
        const saved = JSON.parse(fs.readFileSync(f.h.run('SETTINGS_FILE'), 'utf8'));
        assert.strictEqual(saved.launchAtLogin, launchAtLogin);
        assert.strictEqual(saved.alwaysShowFlowBar, alwaysShowFlowBar);
        f.h.run('loadSettings()');
        assert.strictEqual(f.h.run('settings.launchAtLogin'), launchAtLogin);
        assert.strictEqual(f.h.run('settings.alwaysShowFlowBar'), alwaysShowFlowBar);
      } finally { await f.close(); }
    }
  }
  console.log('ok all four login / always-show combinations persist and preserve app mode');

  const hidden = fixture({ visible: true });
  try {
    hidden.win.failShows = 1;
    hidden.h.run('recoverOverlayFrames(100000, { missed: 3 })');
    assert.strictEqual(hidden.win.visible, false);
    assert.notStrictEqual(hidden.h.run('overlayFrameRestore'), null);
    assert.strictEqual(hidden.win.showAttempts, 1);
    await hidden.set({}, { alwaysShowFlowBar: false });
    hidden.h.run('restoreOverlayFrameSurface(110000)');
    assert.strictEqual(hidden.h.run('overlayFrameRestore'), null,
      'hiding the idle bar cancels an older surface recovery');
    assert.strictEqual(hidden.win.visible, false);
    assert.strictEqual(hidden.win.showAttempts, 1,
      'a deferred native retry cannot reopen an intentionally hidden idle bar');
  } finally { await hidden.close(); }
  console.log('ok disabling the idle bar cancels a pending failed native restore');

  for (const mode of ['arming', 'recording', 'transcribing', 'success', 'error', 'cancel', 'learned']) {
    const active = fixture({ visible: true });
    try {
      active.h.run(`settings.alwaysShowFlowBar = false; mode = '${mode}'; recordingSessionToken = 37;`);
      active.win.failShows = 1;
      active.h.run('recoverOverlayFrames(100000, { missed: 3 })');
      assert.strictEqual(active.win.visible, false);
      assert.notStrictEqual(active.h.run('overlayFrameRestore'), null);
      active.h.run('restoreOverlayFrameSurface(110000)');
      assert.strictEqual(active.win.visible, true, mode + ' still needs a visible bar when always-show is off');
      assert.strictEqual(active.h.run('overlayFrameRestore'), null);
      assert.strictEqual(active.win.input.at(-1), false);
      assert.strictEqual(active.h.run('mode'), mode);
      assert.strictEqual(active.h.run('recordingSessionToken'), 37,
        'surface recovery preserves the active dictation');
    } finally { await active.close(); }
  }
  console.log('ok active bars still recover native visibility when always-show is disabled');

  for (const interaction of ['drag', 'edit', 'hover', 'rest']) {
    for (const source of ['settings-login', 'settings-other', 'tray-login']) {
      const f = fixture({ visible: true });
      try {
        f.h.run(`
          mode = 'idle';
          overlayDrag = ${interaction === 'drag' ? '{ startedAt: Date.now(), timer: 1 }' : 'null'};
          overlayEditing = ${interaction === 'edit'};
          overlayHover = ${interaction === 'hover'};
          overlayIgnoreMouse = null;
        `);
        if (source === 'settings-login') await f.set({}, { launchAtLogin: true });
        else if (source === 'settings-other') await f.set({}, { soundsEnabled: false });
        else f.h.run("setTrayFlag('launchAtLogin', true)");
        assert.strictEqual(f.win.input.at(-1), interaction === 'rest',
          source + ' must preserve native input during ' + interaction);
        if (interaction === 'drag') {
          f.h.run('overlayCursorTick()');
          assert.strictEqual(f.win.input.at(-1), false,
            'the drag cannot depend on the paused cursor poll to repair input');
          assert.notStrictEqual(f.h.run('overlayDrag'), null);
        }
      } finally { await f.close(); }
    }
  }
  console.log('ok settings and tray login changes preserve drag, edit and hover input');
})().catch(error => { console.error(error); process.exitCode = 1; });
