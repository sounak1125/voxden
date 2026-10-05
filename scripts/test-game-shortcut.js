'use strict';

// The game shortcut in main.js: one key, F8 unless the user picks another, off
// until the user turns it on (a key Voxden takes stops working in every other
// app), that works the same as the dictation shortcut -- toggle or push to talk -- and
// dictates the game's way: its sound stays on, the paste sends no fake key-ups
// and pulls no game forward, Polish does not select back over it. Also the
// resting flow bar standing aside while a fullscreen app is in front. main.js
// runs in the harness; the native helpers are played by stubs, so nothing is
// pressed, pasted or muted for real. win32.ps1's side is tested live in
// test-paste-keys-win32.ps1 and test-media-win32.ps1.

const assert = require('assert');
const mainHarness = require('./asr-test-harness');

const tick = () => new Promise(resolve => setImmediate(resolve));

let checks = 0;
async function test(name, fn, options) {
  const h = mainHarness(options);
  try {
    await fn(h);
  } finally {
    await h.close();
  }
  checks++;
  console.log('ok', name);
}

// Signed in, engine ready, the bar and the media pause played by stubs.
function prepare(h, dictateMode) {
  h.run(`
    accountManager = { signedIn: () => true, token: () => '', snapshot: () => ({ signedIn: true, plan: 'free' }) };
    settings.dictateMode = ${JSON.stringify(dictateMode || 'toggle')};
    settings.gameShortcutEnabled = true;
    sidecarState = 'ready'; mode = 'idle';
    showOverlay = () => {}; registerEscape = () => {};
    rememberFocus = () => Promise.resolve();
    pauseBackgroundMedia = () => new Promise(() => {});
    sendOverlay = () => {};
    refreshTray = () => {};
    overlayWin = { isDestroyed: () => false, webContents: {} };
  `);
}

// The native watcher main started for the game key.
function gameWatcher(h, vk) {
  const launch = h.launches.filter(l => Array.isArray(l.args[1]) && l.args[1].includes('hotkey-watch')
    && l.args[1].includes(String(vk))).at(-1);
  assert(launch, 'a key watcher runs for virtual key ' + vk);
  return launch.proc;
}
const say = (proc, ...lines) => proc.stdout.emit('data', lines.join('\n') + '\n');
const foregroundWatcher = h => h.launches.filter(l => Array.isArray(l.args[1])
  && l.args[1].includes('foreground-watch')).at(-1).proc;

// The bar's delayed return (FULLSCREEN_REVEAL_MS); harness timers never fire
// on their own.
function revealTimer(h) {
  const timer = [...h.timers.entries()].find(([, t]) => t.delay === 600);
  assert(timer, 'a return is scheduled');
  h.timers.delete(timer[0]);
  return timer[1];
}

// Every helper request, by its argument list.
function stubHelper(h) {
  h.run(`
    var helperCalls = [];
    ps = async (args) => { helperCalls.push(args.slice()); return args[0] === 'paste' ? 'VOXDEN_OK' : ''; };
    clipboardPaste = { paste: (text, send) => send(), restore() {} };
  `);
}
const calls = h => JSON.parse(h.run('JSON.stringify(helperCalls)'));

async function main() {
  await test('the game shortcut starts on F8, off: no key taken, nothing watched', async (h) => {
    assert.strictEqual(h.run('settings.gameShortcut'), 'F8');
    assert.strictEqual(h.run('settings.gameShortcutEnabled'), false);
    h.run('registerHotkeys()');
    assert.strictEqual(h.shortcuts.has('F8'), false, 'F8 still reaches every other app');
    assert.strictEqual(h.launches.some(l => Array.isArray(l.args[1]) && l.args[1].includes('hotkey-watch')
      && l.args[1].includes('119')), false, 'and nobody watches it');
    assert.strictEqual(h.run('hotkeyNotice'), '', 'off is not a failure to report');
  });

  await test('turning it on takes and watches the key; turning it off gives it back', async (h) => {
    h.run('saveSettings = () => {}; snapshot = () => ({});');
    const set = h.handlers.get('settings-set');
    let res = await set({}, { gameShortcutEnabled: true });
    assert.strictEqual(res.shortcutError, undefined);
    assert.strictEqual(h.run('settings.gameShortcutEnabled'), true);
    assert.strictEqual(h.shortcuts.has('F8'), true);
    const watcher = gameWatcher(h, 0x77);
    res = await set({}, { gameShortcutEnabled: false });
    assert.strictEqual(h.run('settings.gameShortcutEnabled'), false);
    assert.strictEqual(h.shortcuts.has('F8'), false, 'F8 works in other apps again');
    assert.strictEqual(watcher.killed, true, 'and its watcher is stopped');
  });

  await test('a key already used elsewhere cannot be turned on as the game key', async (h) => {
    h.run("saveSettings = () => {}; snapshot = () => ({}); settings.shortcut = 'F8';");
    const res = await h.handlers.get('settings-set')({}, { gameShortcutEnabled: true });
    assert.match(res.shortcutError, /already used for dictation/);
    assert.strictEqual(h.run('settings.gameShortcutEnabled'), false, 'it stays off');
  });

  await test('F8 is held from the app in front and watched; the hotkey itself does nothing', async (h) => {
    prepare(h);
    assert.deepStrictEqual(JSON.parse(h.run("JSON.stringify(tryRegisterGameShortcut('F8'))")), { ok: true, reason: '' });
    h.shortcuts.get('F8')();
    assert.strictEqual(h.run('mode'), 'idle', 'auto-repeat of a held key must not toggle');
    gameWatcher(h, 0x77);
  });

  await test('toggle: a press starts a game dictation, keys held with it change nothing', async (h) => {
    prepare(h, 'toggle');
    h.run("tryRegisterGameShortcut('F8')");
    const watcher = gameWatcher(h, 0x77);
    say(watcher, 'FREE', 'DOWN', 'UP dirty');
    assert.strictEqual(h.run('mode'), 'arming', 'W held while pressing F8 still starts');
    assert.strictEqual(h.run('gameDictation'), true);
  });

  await test('push to talk works the same with the game key', async (h) => {
    prepare(h, 'ptt');
    h.run("tryRegisterGameShortcut('F8')");
    const watcher = gameWatcher(h, 0x77);
    say(watcher, 'FREE', 'DOWN');
    assert.strictEqual(h.run('mode'), 'arming');
    assert.strictEqual(h.run('gameDictation'), true);
    h.run('pttPressedAt = Date.now() - 1000');
    say(watcher, 'UP dirty');
    assert.notStrictEqual(h.run('mode'), 'cancel', 'keys held with it do not cancel');
    assert.strictEqual(h.run('pttReleasePending'), true, 'the release ends the dictation the normal way');
  });

  await test('the dictation shortcut is not a game dictation', async (h) => {
    prepare(h, 'toggle');
    h.run('gameDictation = true; dictationHotkeyHandler()');
    assert.strictEqual(h.run('mode'), 'arming');
    assert.strictEqual(h.run('gameDictation'), false);
  });

  for (const game of [true, false]) {
    const name = game ? 'game' : 'ordinary';
    const watchers = (h) => {
      prepare(h, 'ptt');
      h.run("tryRegisterGameShortcut('F8'); tryRegisterDictationShortcut('CommandOrControl+Super');");
      const gameWatch = gameWatcher(h, 0x77);
      const ordinaryWatch = gameWatcher(h, '17,91|92');
      return game ? [gameWatch, ordinaryWatch] : [ordinaryWatch, gameWatch];
    };

    await test(name + ' PTT hold ignores the other shortcut without changing its tap timer', async (h) => {
      const [owner, other] = watchers(h);
      say(owner, 'FREE', 'DOWN');
      h.run('pttPressedAt = Date.now() - 1000');
      const pressedAt = h.run('pttPressedAt');
      say(other, 'FREE', 'DOWN', 'UP dirty');
      assert.strictEqual(h.run('mode'), 'arming', 'another shortcut must not cancel the held recording');
      assert.strictEqual(h.run('pttPressedAt'), pressedAt);
      assert.strictEqual(h.run('pttLocked'), false);
      assert.strictEqual(h.run('pttReleasePending'), false);
      assert.strictEqual(h.run('gameDictation'), game);
      say(owner, 'UP clean');
      assert.strictEqual(h.run('pttReleasePending'), true, 'only the owner release finishes the hold');
    });

    await test(name + ' PTT survives the other watcher restart but honors its own stale release', async (h) => {
      const [owner, other] = watchers(h);
      say(owner, 'FREE', 'DOWN');
      say(other, 'HELD', 'UP stale');
      assert.strictEqual(h.run('pttReleasePending'), false, 'another watcher cannot finish this hold');
      say(owner, 'HELD', 'UP stale');
      assert.strictEqual(h.run('pttReleasePending'), true, 'a restarted owner can still finish its hold');
    });

    await test(name + ' tap-locked dictation can still be stopped by the other shortcut', async (h) => {
      const [owner, other] = watchers(h);
      say(owner, 'FREE', 'DOWN', 'UP clean');
      assert.strictEqual(h.run('pttLocked'), true);
      say(other, 'FREE', 'DOWN', 'UP dirty');
      assert.strictEqual(h.run('mode'), 'arming', 'the stop key release must not cancel the transcript');
      assert.strictEqual(h.run('pttReleasePending'), true);
      assert.strictEqual(h.run('pttIgnoreNextUp'), false);
    });
  }

  await test('the key just picked, still held, is not a press', async (h) => {
    prepare(h, 'toggle');
    h.run('saveSettings = () => {}; snapshot = () => ({});');
    await h.handlers.get('settings-set')({}, { gameShortcut: 'F7' });
    assert.strictEqual(h.run('settings.gameShortcut'), 'F7');
    const watcher = gameWatcher(h, 0x76);
    say(watcher, 'HELD', 'UP stale');
    assert.strictEqual(h.run('mode'), 'idle');
    say(watcher, 'DOWN', 'UP clean');
    assert.strictEqual(h.run('mode'), 'arming', 'the next real press works');
  });

  await test('the three shortcuts cannot share a key', async (h) => {
    h.run('saveSettings = () => {}; snapshot = () => ({}); settings.gameShortcutEnabled = true;');
    const set = h.handlers.get('settings-set');
    h.run("settings.shortcut = 'CommandOrControl+Super'; settings.pasteLastShortcut = 'CommandOrControl+Alt+V'");
    let res = await set({}, { gameShortcut: 'CommandOrControl+Super' });
    assert.match(res.shortcutError, /already used for dictation/);
    res = await set({}, { gameShortcut: 'CommandOrControl+Alt+V' });
    assert.match(res.shortcutError, /already used to paste your last dictation/);
    assert.strictEqual(h.run('settings.gameShortcut'), 'F8');
    res = await set({}, { shortcut: 'F8' });
    assert.match(res.shortcutError, /already your game shortcut/);
    res = await set({}, { pasteLastShortcut: 'F8' });
    assert.match(res.shortcutError, /already your game shortcut/);
    // Off, the game key holds nothing back.
    await set({}, { gameShortcutEnabled: false });
    res = await set({}, { pasteLastShortcut: 'F8' });
    assert.strictEqual(res.shortcutError, undefined);
  });

  // Shift+F8 in an editor is the editor's shortcut. Only over a fullscreen
  // game is a key held with it normal (sprint, crouch).
  await test('a lone key pressed with a modifier held is left to the app, unless a game fills the screen', async (h) => {
    prepare(h, 'toggle');
    h.run("tryRegisterGameShortcut('F8'); settings.shortcut = 'F9'; tryRegisterDictationShortcut('F9');");
    const game = gameWatcher(h, 0x77);
    const dictation = gameWatcher(h, 0x78);
    say(game, 'FREE', 'DOWN modified', 'UP dirty');
    say(dictation, 'FREE', 'DOWN modified', 'UP dirty');
    assert.strictEqual(h.run('mode'), 'idle');
    h.run('foregroundFillsMonitor = { x: 0, y: 0, width: 1920, height: 1080 }');
    say(game, 'DOWN modified', 'UP dirty');
    assert.strictEqual(h.run('mode'), 'arming');
    assert.strictEqual(h.run('gameDictation'), true);
  });

  await test('the game key never brings a window forward, where the dictation key would', async (h) => {
    prepare(h, 'toggle');
    h.run(`
      var opened = []; var flashed = []; var retried = 0;
      openHistory = (c) => opened.push(c);
      flashError = (m) => flashed.push(m);
      retryPendingCapture = () => { retried++; };
      noteFreeWordWarnings = () => {};
      tryRegisterGameShortcut('F8');
    `);
    const game = gameWatcher(h, 0x77);
    const blockers = {
      'signed out': ['signInRequired = () => true', 'signInRequired = () => false', 'account'],
      'out of free words': ['freeWordsMeter = () => ({ exhausted: true })', 'freeWordsMeter = () => null', 'billing'],
      'engine not ready': ["sidecarState = 'unavailable'", "sidecarState = 'ready'", 'speech-engines'],
    };
    for (const [why, [block, unblock, pane]] of Object.entries(blockers)) {
      h.run(block + '; opened = []; flashed = [];');
      say(game, 'DOWN', 'UP clean');
      assert.deepStrictEqual(JSON.parse(h.run('JSON.stringify(opened)')), [], why + ': no dashboard over the game');
      assert.strictEqual(h.run('flashed.length'), 1, why + ': the bar says why');
      h.run('dictationHotkeyHandler()');
      assert.deepStrictEqual(JSON.parse(h.run('JSON.stringify(opened)')), [pane], why + ': the dictation key still opens it');
      h.run(unblock + "; mode = 'idle';");
    }
    h.run('screenCapture = { hasRetry: true }; flashed = [];');
    say(game, 'DOWN', 'UP clean');
    assert.strictEqual(h.run('retried'), 0, 'a screenshot retry would pull its app over the game');
    assert.strictEqual(h.run('flashed.length'), 1);
  });

  await test('a game dictation leaves Escape and the correction watcher alone', async (h) => {
    prepare(h, 'toggle');
    h.run("var escapes = []; registerEscape = (on) => escapes.push(on); tryRegisterGameShortcut('F8'); settings.autoAddToDictionary = true; lastHwnd = '4242';");
    say(gameWatcher(h, 0x77), 'FREE', 'DOWN', 'UP clean');
    assert.strictEqual(h.run('gameDictation'), true);
    assert.deepStrictEqual(JSON.parse(h.run('JSON.stringify(escapes)')), [false], 'Escape stays the game\'s key');
    assert.strictEqual(h.run('correctionLearningWanted()'), false);
    h.run("mode = 'idle'; escapes = []; dictationHotkeyHandler()");
    assert.deepStrictEqual(JSON.parse(h.run('JSON.stringify(escapes)')), [true], 'an ordinary dictation still takes it');
    assert.strictEqual(h.run('correctionLearningWanted()'), true);
  });

  await test('a game dictation bar takes no click and its result cannot be edited', async (h) => {
    prepare(h, 'toggle');
    h.run(`
      var ignored = []; var focusable = []; var focused = 0;
      overlayWin = { isDestroyed: () => false, webContents: {}, setIgnoreMouseEvents: (v) => ignored.push(v),
        setFocusable: (v) => focusable.push(v), isFocusable: () => false, focus: () => { focused++; } };
      overlayIgnoreMouse = null; positionOverlay = () => {};
      gameDictation = true; mode = 'success';
      setOverlayMouseIgnore(false);
    `);
    assert.deepStrictEqual(JSON.parse(h.run('JSON.stringify(ignored)')), [true], 'clicks go to the game');
    h.ipcEvents.get('overlay-hold')({ sender: h.run('overlayWin.webContents') });
    assert.deepStrictEqual(JSON.parse(h.run('JSON.stringify(focusable)')), []);
    assert.strictEqual(h.run('focused'), 0, 'the game keeps focus');
    h.run("gameDictation = false; overlayIgnoreMouse = null; ignored = []; setOverlayMouseIgnore(false);");
    assert.deepStrictEqual(JSON.parse(h.run('JSON.stringify(ignored)')), [false], 'an ordinary result stays clickable');
  });

  await test('push to talk: a recording started from the bar ends with the shortcut', async (h) => {
    prepare(h, 'ptt');
    h.run("tryRegisterDictationShortcut('CommandOrControl+Super'); startRecording(false);");
    assert.strictEqual(h.run('mode'), 'arming');
    assert.strictEqual(h.run('pttOwner'), null);
    const watcher = gameWatcher(h, '17,91|92');
    say(watcher, 'FREE', 'DOWN');
    assert.strictEqual(h.run('pttOwner'), 'dictation', 'the key takes the recording over');
    h.run('pttPressedAt = Date.now() - 5000');
    say(watcher, 'UP clean');
    assert.strictEqual(h.run('pttReleasePending'), true, 'and its release ends it');
  });

  await test('a game dictation keeps the sound on; any other mutes as before', async (h) => {
    stubHelper(h);
    h.run('settings.soundsEnabled = false; settings.muteMusicWhileDictating = true; gameDictation = true;');
    await h.run('pauseBackgroundMedia()');
    await h.run('resumeBackgroundMedia()');
    h.run('gameDictation = false');
    await h.run('pauseBackgroundMedia()');
    assert.deepStrictEqual(calls(h), [['media-pause', '-Mode', 'game'], ['media-pause']]);
  });

  await test('a game dictation pastes the game way; paste last and the rest do not', async (h) => {
    stubHelper(h);
    h.run("lastHwnd = '7';");
    await h.run("pasteText('gg', { game: true })");
    await h.run("pasteText('hello')");
    assert.deepStrictEqual(calls(h), [['paste', '-Hwnd', '7', '-Mode', 'game'], ['paste', '-Hwnd', '7']]);
  });

  await test('Polish does not select back over a game paste', async (h) => {
    stubHelper(h);
    h.run("lastPaste = { entryId: 'e', text: 'gg', hwnd: '7', exe: 'game.exe', ts: Date.now(), game: true };");
    assert.strictEqual(await h.run("replaceLastPaste('gg', 'GG.')"), false);
    assert.deepStrictEqual(calls(h), [], 'no keys are sent into the game');
  });

  // Google Play Games' Android VM (crosvm.exe) pastes from its own copy of the
  // clipboard. A paste there gives that copy time to land before Ctrl+V and
  // keeps the dictation on the clipboard for 3 s; everything else is unchanged.
  for (const [name, exe, hwnd, settle, restore] of [
    ['a paste into Google Play Games waits for its clipboard copy', 'crosvm.exe', '9', 300, 3000],
    ['a paste into any other app goes at once', 'notepad.exe', '9', 0, 500],
    ['an old lookup of the VM window does not slow another app', 'crosvm.exe', '10', 0, 500],
  ]) {
    await test(name, async (h) => {
      const state = { 'text/plain': 'the user copy' };
      h.context.fakeClip = {
        availableFormats: () => Object.keys(state),
        readText: () => state['text/plain'] || '',
        readHTML: () => '', readRTF: () => '', readImage: () => null,
        readBookmark: () => ({ title: '', url: '' }),
        readBuffer: (format) => Buffer.from(String(state[format] || '')),
        writeText: (text) => { for (const k of Object.keys(state)) delete state[k]; state['text/plain'] = text; },
        write: (data) => { for (const k of Object.keys(state)) delete state[k]; if ('text' in data) state['text/plain'] = data.text; },
      };
      h.run(`
        var helperCalls = [];
        ps = async (args) => { helperCalls.push(args.slice()); return 'VOXDEN_OK'; };
        // The harness's own timers, so the test decides when each wait ends.
        clipboardPaste = createClipboardPaste(fakeClip, { delay: setTimeout, cancel: clearTimeout });
        lastHwnd = '9';
        lastTarget = { hwnd: ${JSON.stringify(hwnd)}, exe: ${JSON.stringify(exe)}, title: 'Match' };
      `);
      const done = h.run("pasteText('gg')");
      await tick();
      const waits = () => Array.from(h.timers.values()).map(t => t.delay);
      if (settle) {
        assert.deepStrictEqual(calls(h), [], 'no Ctrl+V before the copy has had time');
        assert.strictEqual(state['text/plain'], 'gg', 'the words are already on the clipboard');
        Array.from(h.timers.values()).find(t => t.delay === settle).fn();
      }
      await done;
      assert.deepStrictEqual(calls(h), [['paste', '-Hwnd', '9']]);
      assert.ok(waits().includes(restore), 'the old copy goes back after ' + restore + ' ms');
      assert.strictEqual(state['text/plain'], 'gg', 'and not before');
    });
  }

  await test('the resting bar stands aside while a fullscreen app is in front', async (h) => {
    h.run(`
      var sent = []; var shown = 0;
      sendOverlay = (x) => sent.push(x || {});
      showOverlay = () => { shown++; };
      settings.alwaysShowFlowBar = true; mode = 'idle';
    `);
    h.run('launchForegroundWatch()');
    const watch = foregroundWatcher(h);
    say(watch, '4242 fullscreen 0,0,1920,1080');
    assert.strictEqual(h.run('restingBarWanted()'), false);
    assert.deepStrictEqual(JSON.parse(h.run('JSON.stringify(sent)')), [{ mode: 'idle' }], 'the page slides the bar out');
    say(watch, '4242');
    assert.strictEqual(h.run('restingBarWanted()'), false, 'it waits before coming back');
    revealTimer(h).fn();
    assert.strictEqual(h.run('restingBarWanted()'), true);
    assert.strictEqual(h.run('shown'), 1, 'it comes back when the app leaves fullscreen');
    assert.deepStrictEqual(JSON.parse(h.run('JSON.stringify(sent.at(-1))')), { mode: 'idle', reveal: true });
    // A dictation keeps its bar: going fullscreen mid-dictation sends nothing.
    h.run("sent = []; mode = 'recording';");
    say(watch, '4242 fullscreen 0,0,1920,1080');
    assert.deepStrictEqual(JSON.parse(h.run('JSON.stringify(sent)')), []);
    // Someone who turned the resting bar off is not shown one on the way out.
    h.run("mode = 'idle'; settings.alwaysShowFlowBar = false; shown = 0;");
    say(watch, '4242');
    revealTimer(h).fn();
    assert.strictEqual(h.run('shown'), 0);
  });

  // Two side-by-side screens at scale 1: 0-1920 and 1920-3840.
  const twoScreens = {
    screenToDipRect: (_w, r) => r,
    getDisplayMatching: (r) => ({ id: r.x + r.width / 2 < 1920 ? 1 : 2 }),
  };
  const restingBar = (h) => {
    h.run(`
      var sent = []; var shown = 0; var raised = 0;
      sendOverlay = (x) => sent.push(x || {});
      showOverlay = () => { shown++; };
      raiseOverlay = () => { raised++; };
      settings.alwaysShowFlowBar = true; mode = 'idle';
      overlayRect = { x: 2800, y: 1000, width: 260, height: 96 };
      launchForegroundWatch();
    `);
    return foregroundWatcher(h);
  };

  await test('a fullscreen app moves the bar only on the screen the bar is on', async (h) => {
    const watch = restingBar(h);
    say(watch, '4242 fullscreen 0,0,1920,1080');
    assert.strictEqual(h.run('restingBarWanted()'), true, 'a game on the other screen leaves the bar alone');
    assert.deepStrictEqual(JSON.parse(h.run('JSON.stringify(sent)')), []);
    say(watch, '4343 fullscreen 1920,0,3840,1080');
    assert.strictEqual(h.run('restingBarWanted()'), false, 'one on its own screen sends it away');
    // The bar carried over to the game's screen stands aside there too.
    h.run('overlayRect = { x: 800, y: 1000, width: 260, height: 96 }; refreshFullscreenUnderBar()');
    revealTimer(h).fn();
    assert.strictEqual(h.run('restingBarWanted()'), true, '4343 is not on the bar\'s screen any more');
  }, { screen: twoScreens });

  await test('Windows\' own passing windows neither bring the bar back nor raise it over them', async (h) => {
    const watch = restingBar(h);
    say(watch, '4343 fullscreen 1920,0,3840,1080');
    h.run('raised = 0; sent = [];');
    say(watch, '77 shell');
    assert.strictEqual(h.run('restingBarWanted()'), false, 'the game is still under Start or Alt+Tab');
    assert.strictEqual(h.run('raised'), 0, 'the bar is not put over the taskbar list');
    assert.strictEqual([...h.timers.values()].some(t => t.delay === 600), false, 'and no return is scheduled');
    say(watch, '4343 fullscreen 1920,0,3840,1080');
    assert.deepStrictEqual(JSON.parse(h.run('JSON.stringify(sent)')), [], 'back to the game: nothing moved at all');
    // A window passed through on the way back to the game does not flash the bar.
    say(watch, '88', '4343 fullscreen 1920,0,3840,1080');
    assert.strictEqual(h.run('shown'), 0);
    assert.strictEqual(h.run('restingBarWanted()'), false);
  }, { screen: twoScreens });

  await test('a watcher lost while a game was in front gives the bar back', async (h) => {
    const watch = restingBar(h);
    say(watch, '4343 fullscreen 1920,0,3840,1080');
    assert.strictEqual(h.run('restingBarWanted()'), false);
    watch.emit('exit', 1);
    revealTimer(h).fn();
    assert.strictEqual(h.run('restingBarWanted()'), true);
  }, { screen: twoScreens });

  await tick();
  console.log('all ' + checks + ' game shortcut tests passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
