'use strict';

// Drives the real renderer for the recovery shelf on the Dictation page: the
// cards a failed dictation leaves behind, what the Recover button says it will
// cost, and the play, recover and delete round-trips through IPC. The
// main-process half is stubbed here and tested in test-recovery-main.js.

const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'voxden-recovery-ui-')));
app.disableHardwareAcceleration();
const deadline = setTimeout(() => { console.error('Recovery UI test timed out'); app.exit(1); }, 35000);

function wav(seconds) {
  const rate = 16000;
  const n = Math.round(rate * seconds);
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(n * 2, 40);
  return buf;
}

const now = Date.now();
let recoveries = [
  { id: 'r1', ts: now, seconds: 92, bytes: 2944044, reason: 'Voxden Cloud timed out — try again', source: 'failure', exe: 'chrome.exe', title: 'Gmail' },
  { id: 'r2', ts: now - 120000, seconds: 8, bytes: 256044, reason: '', source: 'crash', exe: '', title: '' },
];
let cloudTranscription = false;
let recoverFails = false;
const calls = { audio: 0, recover: [], del: [], save: 0 };

function payload() {
  return {
    entries: [{ id: 'e1', ts: now - 300000, text: 'a dictation that worked' }],
    phrases: [],
    pendingPhrases: [],
    notifications: [],
    notificationsUnread: 0,
    keepRecordings: true,
    cloudTranscription,
    recoveries,
    recordings: { count: recoveries.length, bytes: 3200088 },
  };
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: 1120,
    height: 760,
    useContentSize: true,
    webPreferences: {
      preload: path.join(__dirname, '../src/preload.js'),
      contextIsolation: true,
      sandbox: false,
      backgroundThrottling: false,
    },
  });

  const errors = [];
  win.webContents.on('console-message', (event, level, message) => {
    const lvl = event && event.level !== undefined ? event.level : level;
    const text = event && event.message !== undefined ? event.message : message;
    const bad = lvl === 'error' || Number(lvl) >= 3;
    if (bad && !/Content-Security-Policy|No handler registered/.test(String(text))) errors.push(String(text));
  });

  ipcMain.handle('app-load', async () => payload());
  ipcMain.handle('recovery-audio', async (_e, id) => {
    calls.audio += 1;
    return id === 'r1' ? { ok: true, bytes: wav(10), seconds: 10 } : { ok: false, reason: 'That recording is no longer here.' };
  });
  ipcMain.handle('recovery-save', async () => { calls.save += 1; return { ok: true, path: 'C:\\Users\\x\\Downloads\\Voxden.wav' }; });
  ipcMain.handle('recovery-transcribe', async (_e, id) => {
    calls.recover.push(id);
    if (recoverFails) return { ok: false, reason: 'Voxden Cloud unreachable — check connection and retry' };
    recoveries = recoveries.filter((r) => r.id !== id);
    setTimeout(() => win.webContents.send('history-updated', payload()), 50);
    return { ok: true, text: 'the words that never made it', entryId: 'e2' };
  });
  ipcMain.handle('recovery-delete', async (_e, id) => {
    calls.del.push(id);
    recoveries = recoveries.filter((r) => r.id !== id);
    win.webContents.send('history-updated', payload());
    return { ok: true, snapshot: payload() };
  });

  await win.loadFile(path.join(__dirname, '../src/app.html'));
  const evaluate = (code) => win.webContents.executeJavaScript(code);
  await evaluate(`navigator.mediaDevices.getUserMedia = async () => { throw new Error('No test microphone'); };
    navigator.mediaDevices.enumerateDevices = async () => []; true`);
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const settle = async () => { await delay(90); return evaluate(
    'new Promise(r => { requestAnimationFrame(() => requestAnimationFrame(() => r(1))); setTimeout(() => r(1), 140); })'
  ); };
  const count = (selector) => evaluate(`document.querySelectorAll('${selector}').length`);
  const text = (selector) => evaluate(`(() => { const el = document.querySelector('${selector}'); return el ? el.textContent.trim() : null; })()`);
  const hiddenOf = (selector) => evaluate(`(() => { const el = document.querySelector('${selector}'); return el ? el.hidden : null; })()`);
  const click = (selector) => evaluate(`(() => {
    const el = document.querySelector('${selector}');
    if (!el) return false;
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    el.click();
    return true;
  })()`);
  const waitFor = async (code, message) => {
    const until = Date.now() + 2500;
    do {
      if (await evaluate(code)) return;
      await delay(40);
    } while (Date.now() < until);
    assert.fail(message);
  };
  const card = (id) => `#recoveries .card[data-id="${id}"]`;

  try {
    await settle();

    // --- the shelf ----------------------------------------------------

    assert.strictEqual(await hiddenOf('#recoveries'), false, 'the shelf is shown when clips are waiting');
    assert.strictEqual(await count('#recoveries .recovery-card'), 2, 'one card per shelved clip');
    assert.strictEqual(await text('.recovery-day'), 'Not transcribed', 'one label for the group, not a count');
    assert.strictEqual(await count('#groups .card'), 1, 'the feed is untouched');

    // The whole card is a name and one line: length, time, and why it is here.
    assert.strictEqual(await text(card('r1') + ' .recovery-name'), 'Recover voice');
    const facts = await text(card('r1') + ' .recovery-facts');
    assert.match(facts, /^2 min · .+ · Voxden Cloud timed out — try again$/, 'facts read as one line: ' + facts);
    assert.strictEqual(await count(card('r1') + ' .card-body > *'), 3,
      'name, facts and the hidden player -- nothing else in the body');
    // Three later stylesheets redefine .card and flatten its shadow, so the
    // amber edge and the always-visible actions are asserted on the computed
    // values rather than on the rule being written down somewhere.
    const computed = await evaluate(`(() => {
      const el = document.querySelector('${card('r1')}');
      return {
        edge: getComputedStyle(el).boxShadow,
        actions: getComputedStyle(el.querySelector('.card-actions')).opacity,
      };
    })()`);
    assert.match(computed.edge, /inset/, 'the card keeps its amber edge: ' + computed.edge);
    assert.strictEqual(computed.actions, '1', 'the Recover button does not wait for a hover');
    // A crash carries no reason of its own, so the card explains itself.
    assert.match(await text(card('r2') + ' .recovery-facts'),
      /^8 sec · .+ · Voxden closed before this dictation finished$/);

    // --- what the button says it costs --------------------------------

    assert.strictEqual(await text(card('r1') + ' .recovery-recover'), 'Recover',
      'the local engine is free, so no cost is quoted');
    assert.strictEqual(await count(card('r1') + ' .recovery-cost'), 0);
    cloudTranscription = true;
    win.webContents.send('history-updated', payload());
    await settle();
    assert.strictEqual(await text(card('r1') + ' .recovery-cost'), '2 credits',
      'cloud quotes the credits a 92 second clip will cost');
    assert.strictEqual(await text(card('r2') + ' .recovery-cost'), '1 credit',
      'a short clip still costs the minimum');

    // --- playing ------------------------------------------------------

    assert.strictEqual(await hiddenOf(card('r1') + ' .card-player'), true, 'the player waits until it is asked for');
    await click(card('r1') + ' .card-more');
    await waitFor(`document.querySelector('${card('r1')} .card-menu').hidden === false`, 'the menu opens');
    await click(card('r1') + ' .card-menu .card-menu-item');
    await waitFor(`document.querySelector('${card('r1')} .card-player').hidden === false`, 'the player opens');
    assert.strictEqual(calls.audio, 1, 'the clip is fetched once');

    // --- recovering ---------------------------------------------------

    recoverFails = true;
    await click(card('r1') + ' .recovery-recover');
    await waitFor(`/unreachable/.test(document.querySelector('${card('r1')} .card-status').textContent)`,
      'a failed recovery says why on the card');
    assert.deepStrictEqual(calls.recover, ['r1']);
    assert.strictEqual(await evaluate(`document.querySelector('${card('r1')} .recovery-recover').disabled`), false,
      'and the button comes back for another go');

    recoverFails = false;
    await click(card('r1') + ' .recovery-recover');
    await waitFor(`document.querySelectorAll('#recoveries .recovery-card').length === 1`,
      'a recovered clip leaves the shelf');
    assert.deepStrictEqual(calls.recover, ['r1', 'r1']);

    // --- another pane and back ----------------------------------------

    // The shelf renders for the Dictation pane only, so leaving and returning
    // has to rebuild it rather than show what was there before.
    await evaluate("document.querySelector('[data-view=\"insights\"]').click(); true");
    recoveries = recoveries.concat([{ id: 'r3', ts: now - 30000, seconds: 12, bytes: 400044, reason: 'Speech engine not set up', source: 'failure', exe: '', title: '' }]);
    win.webContents.send('history-updated', payload());
    await settle();
    await evaluate("document.querySelector('[data-view=\"dictation\"]').click(); true");
    await settle();
    assert.strictEqual(await count('#recoveries .recovery-card'), 2,
      'a failure that happened on another pane is waiting on return');

    // --- deleting -----------------------------------------------------

    await click(card('r2') + ' .card-more');
    await waitFor(`document.querySelector('${card('r2')} .card-menu').hidden === false`, 'the menu opens');
    await click(card('r2') + ' .card-menu .card-menu-item.danger');
    await waitFor("document.querySelectorAll('#recoveries .recovery-card').length === 1",
      'the deleted clip leaves the shelf');
    await click(card('r3') + ' .card-more');
    await waitFor(`document.querySelector('${card('r3')} .card-menu').hidden === false`, 'the menu opens on the last card');
    await click(card('r3') + ' .card-menu .card-menu-item.danger');
    await waitFor('document.getElementById("recoveries").hidden === true',
      'the shelf disappears once the last clip is gone');
    assert.deepStrictEqual(calls.del, ['r2', 'r3']);

    assert.deepStrictEqual(errors, [], 'the page logged no errors');
    console.log('recovery UI OK');
    clearTimeout(deadline);
    app.exit(0);
  } catch (err) {
    console.error(err);
    console.error('console errors:', errors);
    clearTimeout(deadline);
    app.exit(1);
  }
});
