'use strict';

// Use the actual dashboard, main's pasteText, and Electron's native text
// insertion. Focus/window detection is simulated; speech and OS paste are not.
const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const harness = require('./asr-test-harness');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'voxden-app-dictation-ui-')));
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
const deadline = setTimeout(() => { console.error('App dictation UI timed out'); app.exit(1); }, 60000);
const payload = { version: 'test', entries: [], phrases: [], writingStyles: {}, notifications: [],
  asrEngine: 'parakeet', cloudTranscription: true,
  account: { signedIn: true, email: 'test@example.com', plan: 'pro' } };
ipcMain.handle('app-load', () => payload);
ipcMain.handle('style-preview', (_e, text) => text);
ipcMain.handle('account-auth-options', () => ({ google: false }));
const reports = [];
ipcMain.handle('feedback-send', (_e, report) => { reports.push(report); return { ok: false, error: 'Test report retained' }; });

app.whenReady().then(async () => {
  const h = harness();
  const win = new BrowserWindow({ show: false, width: 1120, height: 760,
    webPreferences: { preload: path.join(__dirname, '../src/preload.js'), contextIsolation: true,
      sandbox: true, backgroundThrottling: false, offscreen: true } });
  try {
    await win.loadFile(path.join(__dirname, '../src/app.html'));
    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
    const evaluate = code => win.webContents.executeJavaScript(code);
    // A hidden test window has real fields but is not visible to the OS. Wrap
    // only that visibility check; all renderer and text insertion calls are real.
    h.context.testWindow = win;
    h.run(`historyHwnd = '200'; overlayHwnd = '300'; lastHwnd = '100';
      historyWin = { isDestroyed: () => testWindow.isDestroyed(), isVisible: () => true,
        isMinimized: () => false, webContents: testWindow.webContents };
      showOverlay = () => {}; raiseOverlay = () => {}; sendOverlay = () => {};
      ps = async args => { if (args[0] !== 'info') throw new Error('Unexpected OS paste'); return '200\\tvoxden.exe\\tVoxden'; };
      clipboardPaste = { paste: () => { throw new Error('Unexpected clipboard paste'); } };`);
    await evaluate(`navigator.mediaDevices.getUserMedia = async () => { throw new Error('No test microphone'); };
      navigator.mediaDevices.enumerateDevices = async () => []; true`);
    const value = () => evaluate("document.getElementById('feedback-text').value");
    for (const kind of ['bug', 'idea', 'other']) {
      await evaluate(`openFeedbackDialog(); setFeedbackKind('${kind}');
        feedbackTextEl.value = ''; feedbackTextEl.focus(); true`);
      await h.run('rememberFocus()');
      assert.strictEqual(h.run('lastHwnd'), '200', 'feedback replaces the cached external destination');
      h.run("mode = 'transcribing';");
      await h.run("onTranscript('Dictation works in this feedback field.')");
      assert.match(await value(), /Dictation works/i, kind + ' receives the recognized text');
      assert.strictEqual(h.run('mode'), 'success', kind + ' finishes dictation');
      await evaluate('sendFeedback(); true');
      assert.strictEqual(reports.at(-1).kind, kind);
      assert.strictEqual(reports.at(-1).message, await value(), 'sending reads the inserted words');
      await evaluate('closeFeedbackDialog(); true');
    }
    console.log('ok Bug, Idea, and Something else receive and submit dictated text through the real dashboard');

    await evaluate(`openFeedbackDialog(); feedbackTextEl.value = 'Before old after';
      feedbackTextEl.focus(); feedbackTextEl.setSelectionRange(7, 10);
      window.dictationInputs = 0; feedbackTextEl.addEventListener('input', () => dictationInputs++); true`);
    await h.run("pasteText('new')");
    assert.strictEqual(await value(), 'Before new after', 'dictation replaces the selected text');
    assert.strictEqual(await evaluate('feedbackTextEl.selectionStart'), 10, 'caret follows the inserted text');
    assert.strictEqual(await evaluate('dictationInputs'), 1, 'native insertion fires an input event');
    win.webContents.undo();
    // undo() dispatches a native editing command without a completion Promise.
    // Wait for its renderer input event before reading across a different IPC
    // channel; otherwise executeJavaScript can overtake that command.
    for (let tries = 0; tries < 100 && await evaluate('dictationInputs') < 2; tries++) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.strictEqual(await value(), 'Before old after', 'one undo restores the replaced text');
    assert.strictEqual(await evaluate('dictationInputs'), 2, 'one native undo fires one additional input event');
    await evaluate("feedbackTextEl.setSelectionRange(feedbackTextEl.value.length, feedbackTextEl.value.length); true");
    await h.run("pasteText(' at the end')");
    assert.strictEqual(await value(), 'Before old after at the end', 'dictation inserts at the caret');
    await evaluate("feedbackTextEl.value = 'x'.repeat(3998); feedbackTextEl.setSelectionRange(3998, 3998); true");
    await h.run("pasteText('abcdef')");
    assert.strictEqual((await value()).length, 4000, 'native insertion respects the feedback character limit');
    console.log('ok selection replacement, cursor insertion, input events, undo, and feedback maxlength');

    await evaluate('feedbackTextEl.readOnly = true; true');
    await assert.rejects(h.run("pasteText('Read-only field')"), /Click a text field/);
    await evaluate('feedbackTextEl.readOnly = false; feedbackTextEl.disabled = true; true');
    await assert.rejects(h.run("pasteText('Disabled field')"), /Click a text field/);
    await evaluate('feedbackTextEl.disabled = false; closeFeedbackDialog(); true');
    await assert.rejects(h.run("pasteText('Closed feedback dialog')"), /Click a text field/);
    assert.strictEqual((await value()).length, 4000, 'unavailable fields remain untouched');

    await evaluate(`openFeedbackDialog(); feedbackEmailRowEl.hidden = false;
      feedbackEmailEl.value = ''; feedbackEmailEl.focus(); true`);
    await h.run("pasteText('reply@example.com')");
    assert.strictEqual(await evaluate('feedbackEmailEl.value'), 'reply@example.com', 'email inputs support internal dictation');
    console.log('ok non-editable, disabled, and closed fields reject insertion; other editable inputs accept it');
  } finally {
    win.destroy();
    await h.close();
  }
  clearTimeout(deadline);
  app.exit(0);
}).catch(error => { console.error(error); clearTimeout(deadline); app.exit(1); });
