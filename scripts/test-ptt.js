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

testReleaseDuringArming();
testNativeWatcherOwnsPttEdges();
console.log('all push-to-talk lifecycle tests passed');
