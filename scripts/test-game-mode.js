'use strict';

// Game Mode in main.js: which dictations count as going to a game, and what
// each then asks of the Windows helper -- a paste with no fake key-ups that
// never pulls the game forward, a media pause that leaves the speakers on, no
// Polish select-back. main.js runs in the harness with the helper played by a
// stub, so nothing is pasted, muted or pressed for real. win32.ps1's side of
// each request is tested live in test-paste-keys-win32.ps1.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
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

// Every helper request, by its argument list. A paste answers like the helper
// unless the test says otherwise.
function stubHelper(h, pasteAnswer) {
  h.context.pasteAnswer = pasteAnswer || 'VOXDEN_OK';
  h.run(`
    var helperCalls = [];
    ps = async (args) => { helperCalls.push(args.slice()); return args[0] === 'paste' ? pasteAnswer : ''; };
    clipboardPaste = { paste: (text, send) => send(), restore() {} };
  `);
}

const calls = (h) => JSON.parse(h.run('JSON.stringify(helperCalls)'));

// The window the dictation goes to. A game is one that fills its screen.
function target(h, { fullscreen, mode }) {
  h.run(`
    settings.gameMode = ${JSON.stringify(mode || 'auto')};
    lastHwnd = '7';
    lastTarget = { hwnd: '7', exe: 'game.exe', title: 'Match', fullscreen: ${!!fullscreen} };
  `);
}

async function main() {
  await test('Game Mode starts on auto', async (h) => {
    assert.strictEqual(h.run('settings.gameMode'), 'auto');
  });

  await test('window info carries the fullscreen mark', async (h) => {
    const parse = (line) => JSON.parse(h.run(`JSON.stringify(parseWinInfo(${JSON.stringify(line)}))`));
    assert.deepStrictEqual(parse('42\tgame.exe\tMatch\tfullscreen'),
      { hwnd: '42', exe: 'game.exe', title: 'Match', fullscreen: true });
    assert.deepStrictEqual(parse('42\tchrome.exe\tInbox'),
      { hwnd: '42', exe: 'chrome.exe', title: 'Inbox', fullscreen: false });
    // A window called "fullscreen" is a title, not the mark.
    assert.deepStrictEqual(parse('42\tvlc.exe\tfullscreen'),
      { hwnd: '42', exe: 'vlc.exe', title: 'fullscreen', fullscreen: false });
  });

  await test('auto means a window that fills its screen, and only the one pasted to', async (h) => {
    const game = (mode, fullscreen, hwnd) => h.run(`settings.gameMode = ${JSON.stringify(mode)};
      gameModeFor({ hwnd: '7', fullscreen: ${fullscreen} }, ${JSON.stringify(hwnd)})`);
    assert.strictEqual(game('auto', true, '7'), true);
    assert.strictEqual(game('auto', false, '7'), false);
    assert.strictEqual(game('always', false, '7'), true);
    assert.strictEqual(game('off', true, '7'), false);
    // lastTarget can lag lastHwnd when a lookup failed: its verdict is not the
    // paste target's.
    assert.strictEqual(game('auto', true, '8'), false);
    assert.strictEqual(game('always', true, '8'), false);
  });

  await test('a paste into a game asks for Game Mode', async (h) => {
    stubHelper(h);
    target(h, { fullscreen: true });
    await h.run("pasteText('gg well played')");
    assert.deepStrictEqual(calls(h), [['paste', '-Hwnd', '7', '-Mode', 'game']]);
  });

  await test('a paste anywhere else is the ordinary paste', async (h) => {
    stubHelper(h);
    target(h, { fullscreen: false });
    await h.run("pasteText('hello')");
    target(h, { fullscreen: true, mode: 'off' });
    await h.run("pasteText('hello')");
    assert.deepStrictEqual(calls(h), [['paste', '-Hwnd', '7'], ['paste', '-Hwnd', '7']]);
  });

  await test('always makes every paste a game paste', async (h) => {
    stubHelper(h);
    target(h, { fullscreen: false, mode: 'always' });
    await h.run("pasteText('hello')");
    assert.deepStrictEqual(calls(h), [['paste', '-Hwnd', '7', '-Mode', 'game']]);
  });

  await test('a game no longer in front fails the paste and says so', async (h) => {
    stubHelper(h, 'Game is no longer in front');
    target(h, { fullscreen: true });
    await assert.rejects(h.run("pasteText('gg')"), /game no longer in front/);
  });

  await test('a game keeps its sound on; players still pause', async (h) => {
    stubHelper(h);
    h.run('settings.soundsEnabled = false; settings.muteMusicWhileDictating = true;');
    target(h, { fullscreen: true });
    await h.run('pauseBackgroundMedia()');
    await h.run('resumeBackgroundMedia()');
    target(h, { fullscreen: false });
    await h.run('pauseBackgroundMedia()');
    assert.deepStrictEqual(calls(h), [['media-pause', '-Mode', 'game'], ['media-pause']]);
  });

  await test('the pause waits for the window lookup before deciding', async (h) => {
    stubHelper(h);
    h.run('settings.soundsEnabled = false; settings.muteMusicWhileDictating = true;');
    target(h, { fullscreen: false });
    h.run(`
      var found;
      var paused = pauseBackgroundMedia(new Promise((resolve) => {
        found = () => { lastTarget = { hwnd: '7', exe: 'game.exe', title: '', fullscreen: true }; resolve(); };
      }));
    `);
    await tick();
    assert.deepStrictEqual(calls(h), [], 'nothing is paused before the lookup answers');
    h.run('found()');
    await h.run('paused');
    assert.deepStrictEqual(calls(h), [['media-pause', '-Mode', 'game']]);
  });

  await test('a lookup that never answers holds the pause for 300 ms only', async (h) => {
    stubHelper(h);
    h.run('settings.soundsEnabled = false; settings.muteMusicWhileDictating = true;');
    target(h, { fullscreen: false });
    h.run('var paused = pauseBackgroundMedia(new Promise(() => {}));');
    await tick();
    assert.deepStrictEqual(calls(h), []);
    const cap = Array.from(h.timers.values()).find((timer) => timer.delay === 300);
    assert(cap, 'the wait has a cap');
    cap.fn();
    await h.run('paused');
    assert.deepStrictEqual(calls(h), [['media-pause']], 'the window known before decides');
  });

  await test('Polish does not select back over a game', async (h) => {
    stubHelper(h);
    h.run("lastPaste = { entryId: 'e', text: 'gg', hwnd: '7', exe: 'game.exe', ts: Date.now(), game: true };");
    assert.strictEqual(await h.run("replaceLastPaste('gg', 'GG.')"), false);
    assert.deepStrictEqual(calls(h), [], 'no keys are sent into the game');
  });

  await test('settings keep only the three Game Mode values', async (h) => {
    h.run('saveSettings = () => {}; snapshot = () => ({});');
    const set = h.handlers.get('settings-set');
    await set({}, { gameMode: 'off' });
    assert.strictEqual(h.run('settings.gameMode'), 'off');
    await set({}, { gameMode: 'turbo' });
    assert.strictEqual(h.run('settings.gameMode'), 'off');
    await set({}, { gameMode: 'always' });
    assert.strictEqual(h.run('settings.gameMode'), 'always');
  });

  // onTranscript's paste record is what Polish reads later.
  const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  assert(/lastPaste = \{[\s\S]{0,200}game: gameModeFor\(lastTarget, pastedInto\)/.test(mainSrc),
    'a dictation remembers whether it was pasted into a game');
  checks++;
  console.log('ok a dictation remembers whether it went to a game');

  console.log('all ' + checks + ' Game Mode tests passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
