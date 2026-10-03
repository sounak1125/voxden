'use strict';

// Exercise main's destination selection and completion with a fake native
// window. No microphone, real clipboard, or OS paste keys are involved.
const assert = require('assert');
const harness = require('./asr-test-harness');

async function main() {
  const h = harness();
  const fixture = {
    focused: '200', editable: true, visible: true, minimized: false, destroyed: false,
    inserted: [], clipboardTexts: [], helperCalls: [], captureTargets: [], states: [],
  };
  h.context.fixture = fixture;
  try {
    h.run(`
      historyHwnd = '200'; overlayHwnd = '300'; lastHwnd = '100'; foregroundHwnd = '100';
      lastTarget = { hwnd: '100', exe: 'previous-app.exe', title: 'Previous app' };
      historyWin = { isDestroyed: () => fixture.destroyed, isVisible: () => fixture.visible,
        isMinimized: () => fixture.minimized,
        webContents: { send() {}, executeJavaScript: async () => fixture.editable,
          insertText: async text => fixture.inserted.push(text) } };
      screenCapture = { owns: hwnd => hwnd === '400',
        observeTarget: hwnd => fixture.captureTargets.push(hwnd) };
      raiseOverlay = () => {};
      showOverlay = () => {};
      sendOverlay = state => fixture.states.push(state);
      ps = async args => {
        fixture.helperCalls.push(Array.from(args));
        const hwnd = args[2] || fixture.focused;
        return args[0] === 'info' ? hwnd + '\\tvoxden.exe\\tVoxden' : 'VOXDEN_OK';
      };
      clipboardPaste = { paste: async (text, send) => { fixture.clipboardTexts.push(text); await send(); } };
    `);

    assert.strictEqual(h.run("isOurHwnd('200')"), true, 'dashboard remains excluded from non-dictation targets');
    h.run("adoptForegroundHwnd('100')");
    fixture.captureTargets.length = 0;
    h.run("adoptForegroundHwnd('200')");
    assert.strictEqual(h.run('lastHwnd'), '200', 'foreground watcher selects the dashboard');
    assert.deepStrictEqual(fixture.captureTargets, [], 'screenshot target selection still excludes the dashboard');
    h.run("lastHwnd = '100';");
    await h.run('rememberFocus()');
    assert.strictEqual(h.run('lastHwnd'), '200', 'start-time focus refresh selects the dashboard');
    assert.strictEqual(h.run('lastTarget.exe'), 'voxden.exe', 'destination metadata refreshes too');
    assert.strictEqual((await h.run('captureTargetInfo()')).hwnd, '100', 'Capture retains its previous external destination');
    assert.strictEqual(h.run('lastHwnd'), '200', 'reading the Capture destination preserves the dashboard dictation target');
    assert.strictEqual(h.run('correctionLearningWanted()'), false, 'no OS correction watcher for an internal field');
    for (const hwnd of ['0', '300', '400']) h.run(`adoptForegroundHwnd('${hwnd}')`);
    assert.strictEqual(h.run('lastHwnd'), '200', 'overlay and capture windows cannot replace the destination');

    h.run("mode = 'recording'; adoptForegroundHwnd('100');");
    assert.strictEqual(h.run('lastHwnd'), '200', 'switching apps while recording preserves the initial destination');
    assert.deepStrictEqual(fixture.captureTargets, ['100'], 'external screenshot targets are still observed');
    h.run("screenCapture = null; mode = 'transcribing';");
    fixture.helperCalls.length = 0;
    for (const platform of ['win32', 'darwin']) {
      h.context.process.platform = platform;
      for (const cloud of [false, true]) {
        h.run(`settings.cloudTranscription = ${cloud}; mode = 'transcribing';`);
        await h.run("onTranscript('The feedback box should accept dictated words.')");
        assert.strictEqual(h.run('mode'), 'success', platform + ': dictation finishes with cloud=' + cloud);
        assert.match(fixture.inserted.at(-1), /feedback box/i);
      }
    }
    assert.strictEqual(fixture.inserted.length, 4);
    assert.strictEqual(h.run('history.entries.length'), 4, 'internal dictations are saved normally');
    assert.deepStrictEqual(fixture.clipboardTexts, [], 'internal insertion never borrows the clipboard');
    assert.deepStrictEqual(fixture.helperCalls, [], 'internal insertion never invokes an OS helper');
    console.log('ok dashboard targeting, own-window exclusions, cloud/local completion, and Windows/macOS insertion');

    fixture.editable = false;
    h.run("mode = 'transcribing';");
    await h.run("onTranscript('Keep these words if the dialog has closed.')");
    assert.strictEqual(h.run('mode'), 'error', 'a non-editable destination cannot claim success');
    assert.strictEqual(h.run('history.entries.length'), 5, 'words are retained on insertion failure');
    assert.strictEqual(fixture.inserted.length, 4);
    assert.deepStrictEqual(fixture.helperCalls, [], 'an unavailable internal field never falls back to another app');
    fixture.editable = true;
    for (const [key, value] of [['visible', false], ['minimized', true], ['destroyed', true]]) {
      fixture[key] = value;
      await assert.rejects(h.run("pasteText('Unreachable field')"), /no longer available/);
      fixture[key] = key === 'visible';
    }
    h.run(`historyWin.webContents.executeJavaScript = () => new Promise(resolve => fixture.resolveField = resolve);`);
    const cancelled = h.run("pasteText('A cancelled dictation')");
    h.run('advanceRecordingSession()');
    fixture.resolveField(true);
    await assert.rejects(cancelled, /cancelled/);
    assert.strictEqual(fixture.inserted.length, 4, 'cancellation during field validation prevents insertion');
    console.log('ok closed/non-editable fields retain words without a stale paste, and cancelled sessions cannot insert');

    h.context.process.platform = 'win32';
    h.run("mode = 'idle'; adoptForegroundHwnd('100');");
    fixture.focused = '100';
    await h.run('rememberFocus()');
    fixture.helperCalls.length = 0;
    await h.run("pasteText('External dictation')");
    assert.deepStrictEqual(fixture.clipboardTexts, ['External dictation']);
    assert.deepStrictEqual(fixture.helperCalls.map(args => [...args]), [['paste', '-Hwnd', '100']], 'external dictation keeps the original paste path');
    console.log('ok external dictation still uses clipboard paste into its selected window');
  } finally { await h.close(); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
