'use strict';

// The game shortcut in main.js: one key, F8 unless the user picks another, that
// works the same as the dictation shortcut -- toggle or push to talk -- and
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
async function test(name, fn) {
  const h = mainHarness();
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
  await test('the game shortcut starts on F8', async (h) => {
    assert.strictEqual(h.run('settings.gameShortcut'), 'F8');
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
    h.run('saveSettings = () => {}; snapshot = () => ({});');
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
    const watch = h.launches.filter(l => Array.isArray(l.args[1]) && l.args[1].includes('foreground-watch')).at(-1).proc;
    say(watch, '4242 fullscreen');
    assert.strictEqual(h.run('restingBarWanted()'), false);
    assert.deepStrictEqual(JSON.parse(h.run('JSON.stringify(sent)')), [{ mode: 'idle' }], 'the page slides the bar out');
    say(watch, '4242');
    assert.strictEqual(h.run('restingBarWanted()'), true);
    assert.strictEqual(h.run('shown'), 1, 'it comes back when the app leaves fullscreen');
    assert.deepStrictEqual(JSON.parse(h.run('JSON.stringify(sent.at(-1))')), { mode: 'idle', reveal: true });
    // A dictation keeps its bar: going fullscreen mid-dictation sends nothing.
    h.run("sent = []; mode = 'recording';");
    say(watch, '4242 fullscreen');
    assert.deepStrictEqual(JSON.parse(h.run('JSON.stringify(sent)')), []);
    // Someone who turned the resting bar off is not shown one on the way out.
    h.run("mode = 'idle'; settings.alwaysShowFlowBar = false; shown = 0;");
    say(watch, '4242');
    assert.strictEqual(h.run('shown'), 0);
  });

  await tick();
  console.log('all ' + checks + ' game shortcut tests passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
