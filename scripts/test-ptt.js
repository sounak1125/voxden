'use strict';

const assert = require('assert');
const mainHarness = require('./asr-test-harness');

function prepare(h, mode) {
  h.context.pttStates = [];
  h.run(`
    settings.shortcut = 'CommandOrControl+Shift+Space';
    settings.dictateMode = '${mode || 'ptt'}';
    sidecarState = 'ready'; mode = 'idle';
    showOverlay = () => {}; registerEscape = () => {};
    markerSend = () => {}; rememberFocus = () => Promise.resolve();
    captureDictationContext = () => Promise.resolve();
    pauseBackgroundMedia = () => new Promise(() => {});
    sendOverlay = (extra) => pttStates.push(extra || {});
    refreshTray = () => {};
    overlayWin = { isDestroyed: () => false, webContents: {} };
  `);
}

function testReleaseDuringArming() {
  const h = mainHarness();
  try {
    prepare(h, 'ptt');
    h.run('startRecording(true)');
    assert.strictEqual(h.run('mode'), 'arming');
    assert.strictEqual(h.context.pttStates[0].prepareOnly, false,
      'PTT must open the microphone without waiting for media pause');

    h.run('requestPttStop()');
    assert.strictEqual(h.run('pttReleasePending'), true,
      'a release during getUserMedia must be remembered');
    assert.strictEqual(h.run('mode'), 'arming',
      'a valid early release must not cancel the dictation');

    const captureReady = h.ipcEvents.get('capture-ready');
    captureReady({ sender: h.run('overlayWin.webContents') });
    assert.strictEqual(h.run('mode'), 'transcribing',
      'capture-ready must honor the remembered release');
    assert.deepStrictEqual(
      h.context.pttStates.slice(-2).map(state => state.mode),
      ['recording', 'stop'],
      'the renderer sees a real recording before it is stopped'
    );
    console.log('ok PTT release during arming is preserved until capture-ready');
  } finally { h.close(); }
}

function testNativeWatcherOwnsPttEdges() {
  const h = mainHarness();
  try {
    prepare(h, 'ptt');
    const result = h.run("tryRegisterDictationShortcut('CommandOrControl+Shift+Space')");
    assert.strictEqual(result.ok, true);
    assert.strictEqual(h.shortcuts.has('CommandOrControl+Shift+Space'), true,
      'normal chords remain reserved through Electron');
    assert.strictEqual(h.launches.length, 1,
      'one long-lived native watcher replaces repeated key-state processes');

    h.shortcuts.get('CommandOrControl+Shift+Space')();
    assert.strictEqual(h.run('mode'), 'idle',
      'Electron key-down is ignored in PTT mode to avoid duplicate starts');

    const watcher = h.launches[0].proc;
    watcher.stdout.emit('data', 'DOWN\n');
    assert.strictEqual(h.run('mode'), 'arming',
      'the physical DOWN edge starts PTT');
    h.run('pttPressedAt = Date.now() - 1000');
    watcher.stdout.emit('data', 'UP clean\n');
    assert.strictEqual(h.run('pttReleasePending'), true,
      'the physical UP edge is retained while the mic opens');

    watcher.emit('exit', 1);
    const restart = Array.from(h.timers.values()).find(timer => timer.delay === 250);
    assert(restart, 'an unexpected watcher exit schedules recovery');
    restart.fn();
    assert.strictEqual(h.launches.length, 2,
      'the key watcher restarts without requiring an app restart');
    console.log('ok native PTT watcher owns both edges and recovers after exit');
  } finally { h.close(); }
}

// Changing the shortcut in settings registers the new chord while the user's
// fingers are still on it. The watcher must not read that lingering hold as a
// press, or the release ends a recording that never heard a word: "No speech".
async function testStaleHoldAfterShortcutChange() {
  const h = mainHarness();
  try {
    prepare(h, 'ptt');
    h.run("saveSettings = () => {}; snapshot = () => ({});");
    const set = h.handlers.get('settings-set');
    await set({}, { shortcut: 'CommandOrControl+Shift+D' });
    assert.strictEqual(h.run('settings.shortcut'), 'CommandOrControl+Shift+D');
    assert.strictEqual(h.run('chordStaleHeld'), true,
      'a chord picked on key-down counts as held until the watcher reports');
    const watcher = h.launches.at(-1).proc;
    watcher.stdout.emit('data', 'HELD\n');
    assert.strictEqual(h.run('mode'), 'idle',
      'a chord already down when the watcher starts is not a DOWN edge');
    watcher.stdout.emit('data', 'UP stale\n');
    assert.strictEqual(h.run('mode'), 'idle',
      'letting go of the chord used to pick the shortcut records nothing');
    assert.strictEqual(h.run('chordStaleHeld'), false);
    watcher.stdout.emit('data', 'DOWN\n');
    assert.strictEqual(h.run('mode'), 'arming',
      'the next real press still starts push to talk');
    console.log('ok PTT ignores the hold left over from picking the shortcut');
  } finally { h.close(); }
}

async function testToggleIgnoresAutoRepeatAfterShortcutChange() {
  const h = mainHarness();
  try {
    prepare(h, 'toggle');
    h.run("saveSettings = () => {}; snapshot = () => ({});");
    const set = h.handlers.get('settings-set');
    await set({}, { shortcut: 'CommandOrControl+Shift+D' });
    const fire = h.shortcuts.get('CommandOrControl+Shift+D');
    assert(fire, 'the new chord is registered through Electron');
    fire();
    assert.strictEqual(h.run('mode'), 'idle',
      'keyboard auto-repeat of the chord still held from the picker is ignored');
    const watcher = h.launches.at(-1).proc;
    watcher.stdout.emit('data', 'FREE\n');
    fire();
    assert.strictEqual(h.run('mode'), 'arming',
      'once the watcher sees the chord released, a press starts dictation');
    console.log('ok toggle ignores auto-repeat until the picked chord is released');
  } finally { h.close(); }
}

// A tap is a press let go before a word could have been spoken. Push to talk
// keeps recording after one and ends on the next press, whose own release is
// not a second stop.
function testTapLocksPushToTalk() {
  const h = mainHarness();
  try {
    prepare(h, 'ptt');
    h.run("tryRegisterDictationShortcut('CommandOrControl+Super')");
    const watcher = h.launches[0].proc;
    watcher.stdout.emit('data', 'DOWN\n');
    assert.strictEqual(h.run('mode'), 'arming');
    watcher.stdout.emit('data', 'UP clean\n');
    assert.strictEqual(h.run('mode'), 'arming', 'a tap does not end the dictation');
    assert.strictEqual(h.run('pttReleasePending'), false, 'a tap is not a pending stop');
    assert.strictEqual(h.run('pttLocked'), true, 'a tap locks the dictation on');
    assert.strictEqual(h.context.pttStates.at(-1).pttLocked, true,
      'the overlay is told the dictation is locked');

    const captureReady = h.ipcEvents.get('capture-ready');
    captureReady({ sender: h.run('overlayWin.webContents') });
    assert.strictEqual(h.run('mode'), 'recording', 'the locked dictation keeps recording');

    watcher.stdout.emit('data', 'DOWN\n');
    assert.strictEqual(h.run('mode'), 'transcribing', 'the next press ends a locked dictation');
    watcher.stdout.emit('data', 'UP clean\n');
    assert.strictEqual(h.run('mode'), 'transcribing',
      'the release of the ending press is ignored');
    assert.strictEqual(h.run('pttIgnoreNextUp'), false);

    watcher.stdout.emit('data', 'DOWN\n');
    assert.strictEqual(h.run('mode'), 'transcribing',
      'a press while transcribing is still ignored');
    console.log('ok a tap locks push to talk on and the next press ends it');
  } finally { h.close(); }
}

function testDirtyTapStillCancels() {
  const h = mainHarness();
  try {
    prepare(h, 'ptt');
    h.run("tryRegisterDictationShortcut('CommandOrControl+Super')");
    h.run('flashCancel = () => { mode = "cancel"; }');
    const watcher = h.launches[0].proc;
    watcher.stdout.emit('data', 'DOWN\n');
    watcher.stdout.emit('data', 'UP dirty\n');
    assert.strictEqual(h.run('mode'), 'cancel', 'Ctrl+Win+Left tapped is still not a dictation');
    assert.strictEqual(h.run('pttLocked'), false);
    console.log('ok a dirty tap cancels instead of locking');
  } finally { h.close(); }
}

// A watcher that dies while the chord is held still owes the app the release,
// or a push-to-talk recording would run until the next press.
function testStaleReleaseStillEndsPtt() {
  const h = mainHarness();
  try {
    prepare(h, 'ptt');
    h.run("tryRegisterDictationShortcut('CommandOrControl+Shift+Space')");
    const first = h.launches[0].proc;
    first.stdout.emit('data', 'DOWN\n');
    assert.strictEqual(h.run('mode'), 'arming');
    first.emit('exit', 1);
    const restart = Array.from(h.timers.values()).find(timer => timer.delay === 250);
    restart.fn();
    const second = h.launches[1].proc;
    second.stdout.emit('data', 'HELD\n');
    assert.strictEqual(h.run('mode'), 'arming', 'a stale hold does not restart the recording');
    second.stdout.emit('data', 'UP stale\n');
    assert.strictEqual(h.run('pttReleasePending'), true,
      'the stale release still ends the recording the dead watcher started');
    console.log('ok a restarted watcher still delivers the release of a recording in flight');
  } finally { h.close(); }
}

testReleaseDuringArming();
testNativeWatcherOwnsPttEdges();
testStaleReleaseStillEndsPtt();
testTapLocksPushToTalk();
testDirtyTapStillCancels();
Promise.resolve()
  .then(testStaleHoldAfterShortcutChange)
  .then(testToggleIgnoresAutoRepeatAfterShortcutChange)
  .then(() => {
    console.log('all push-to-talk lifecycle tests passed');
  })
  .catch((err) => { console.error(err); process.exit(1); });
