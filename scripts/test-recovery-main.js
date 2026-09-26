'use strict';

// Recovery in the main process: which failures keep their clip, which do not,
// what a crashed session leaves behind, and what the handlers do with it.
// Real files in an isolated data directory, driven through the real handlers.
const assert = require('assert');
const harness = require('./asr-test-harness');

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

async function main() {
  const copied = [];
  const h = harness({ clipboard: { writeText: (t) => copied.push(t), readText: () => '' } });
  try {
    h.context.testAudio = wav(4);
    // The overlay is the one thing a headless main cannot have. Everything
    // else in the failure path is the real code.
    h.run(`
      showOverlay = () => {};
      sendOverlay = () => {};
      resumeBackgroundMedia = () => {};
      registerEscape = () => {};
      settings.keepRecordings = true;
      settings.keepTrainingAudio = false;
      settings.cloudTranscription = false;
      saveSettings();
      mode = 'transcribing';
      lastTarget = { hwnd: '1', exe: 'chrome.exe', title: 'Gmail' };
    `);

    // --- a failure keeps its clip --------------------------------------

    h.run("corpus.parkRetry(testAudio); retryEntryOwner = null; flashError('Voxden Cloud timed out — try again');");
    let shelf = h.run('corpus.recoveries()');
    assert.strictEqual(shelf.length, 1, 'a failed dictation shelves its clip');
    assert.strictEqual(shelf[0].reason, 'Voxden Cloud timed out — try again');
    assert.strictEqual(shelf[0].source, 'failure');
    assert.strictEqual(shelf[0].exe, 'chrome.exe', 'the target app is recorded');
    assert.strictEqual(h.run('corpus.hasRetry()'), false, 'the retry slot is emptied by the move');
    assert.strictEqual(h.run('mode'), 'error');

    // The bar has under two seconds to say the words were kept.
    const said = [];
    h.run('sendOverlay = (extra) => { if (extra && extra.mode === "error") overlaySaid.push(extra.text); };');
    h.context.overlaySaid = said;
    h.run("mode = 'transcribing'; corpus.parkRetry(testAudio); flashError('No speech');");
    assert.ok(said[0] && said[0].includes('saved to recover'), 'the error says the clip was kept: ' + said[0]);
    assert.strictEqual(h.run('corpus.recoveries().length'), 2);

    // --- failures that must not shelve anything ------------------------

    h.run("mode = 'transcribing'; flashError('Mic error');");
    assert.strictEqual(h.run('corpus.recoveries().length'), 2, 'a failure with no clip shelves nothing');

    h.run(`
      mode = 'transcribing';
      corpus.parkRetry(testAudio);
      retryEntryOwner = 'entry-that-kept-the-text';
      flashError('Paste failed — text saved in history');
    `);
    assert.strictEqual(h.run('corpus.recoveries().length'), 2, 'a paste failure keeps its audio with its entry');
    assert.strictEqual(h.run('corpus.hasRetry()'), true, 'and leaves the retry slot alone');

    h.run(`
      settings.keepRecordings = false;
      settings.keepTrainingAudio = false;
      mode = 'transcribing';
      retryEntryOwner = null;
      corpus.parkRetry(testAudio);
      flashError('Transcribe failed');
    `);
    assert.strictEqual(h.run('corpus.recoveries().length'), 2, 'recording retention off shelves nothing');
    assert.strictEqual(h.run('snapshot().recoveries.length'), 0, 'and the window is told about none of it');

    // Turning the setting off deletes what is already there.
    h.run('settings.keepRecordings = true; saveSettings();');
    assert.strictEqual(h.run('snapshot().recoveries').length, 2, 'the window sees the shelf again');
    h.run('settings.keepRecordings = false; pruneRecordings();');
    assert.strictEqual(h.run('corpus.recoveries().length'), 0, 'switching retention off clears the shelf');

    // --- a session that never ended ------------------------------------

    h.run(`
      settings.keepRecordings = true;
      saveSettings();
      corpus.parkRetry(testAudio);
      rescueUnfinishedClip();
    `);
    shelf = h.run('corpus.recoveries()');
    assert.strictEqual(shelf.length, 1, 'a clip left in the slot at launch is rescued');
    assert.strictEqual(shelf[0].source, 'crash');
    assert.strictEqual(shelf[0].reason, 'Voxden closed before this dictation finished');
    const rescued = shelf[0].id;

    // --- the handlers --------------------------------------------------

    const audio = await h.handlers.get('recovery-audio')({}, rescued);
    assert.strictEqual(audio.ok, true, 'the clip can be played');
    assert.strictEqual(audio.bytes.length, h.context.testAudio.length);
    assert.strictEqual(Math.round(audio.seconds), 4);
    const missing = await h.handlers.get('recovery-audio')({}, 'nope');
    assert.strictEqual(missing.ok, false, 'a clip that is gone says so');

    h.run("mode = 'recording';");
    let busy = await h.handlers.get('recovery-transcribe')({}, rescued);
    assert.strictEqual(busy.ok, false, 'recovery waits for the dictation in flight');
    assert.match(busy.reason, /Finish the current dictation/);
    h.run("mode = 'idle';");

    const gone = await h.handlers.get('recovery-transcribe')({}, 'nope');
    assert.strictEqual(gone.ok, false, 'recovering a clip that is gone fails cleanly');

    // Nothing heard is not a reason to throw the clip away.
    h.run("transcribeSavedFile = async () => '   ';");
    const silent = await h.handlers.get('recovery-transcribe')({}, rescued);
    assert.strictEqual(silent.ok, false);
    assert.match(silent.reason, /heard no speech/);
    assert.strictEqual(h.run('corpus.recoveries().length'), 1, 'the clip stays on the shelf');

    // A real recovery: history entry, clipboard, and the clip becomes the
    // entry's recording.
    h.run("transcribeSavedFile = async () => 'the words that never made it';");
    const done = await h.handlers.get('recovery-transcribe')({}, rescued);
    assert.strictEqual(done.ok, true, 'the clip is recovered: ' + done.reason);
    assert.strictEqual(done.text, 'The words that never made it', 'the transcript gets the usual cleanup');
    assert.strictEqual(copied.at(-1), done.text, 'the words are on the clipboard');
    assert.strictEqual(h.run('history.entries.length'), 1, 'it is a dictation now');
    assert.strictEqual(h.run('history.entries[0].exe'), undefined, 'a crashed clip knows no target app');
    assert.strictEqual(h.run('history.entries[0].durationMs'), 4000, 'the clip length is its duration');
    assert.strictEqual(h.run('corpus.recoveries().length'), 0, 'and it has left the shelf');
    assert.strictEqual(h.run('corpus.hasRecording(history.entries[0].id)'), true,
      'the entry can play, save and retry it like any other');

    // --- deleting ------------------------------------------------------

    // Starting a dictation clears the owner, which is what makes the next
    // failure a failure with a clip of its own.
    h.run('retryEntryOwner = null; corpus.parkRetry(testAudio); keepFailedClip("Transcribe failed");');
    const id = h.run('corpus.recoveries()[0].id');
    const deleted = await h.handlers.get('recovery-delete')({}, id);
    assert.strictEqual(deleted.ok, true);
    assert.strictEqual(h.run('corpus.recoveries().length'), 0, 'the clip is deleted');

    // The Delete button beside "Keep recordings" takes the shelf too, once no
    // dictation is in flight.
    h.run(`
      history.entries = [];
      saveHistory();
      corpus.park(testAudio); corpus.claim('kept');
      retryEntryOwner = null;
      corpus.parkRetry(testAudio); keepFailedClip('Transcribe failed');
    `);
    assert.strictEqual(h.run('corpus.recoveries().length'), 1);
    h.run("mode = 'recording';");
    const refused = await h.handlers.get('recordings-clear')();
    assert.strictEqual(refused.ok, false, 'clearing waits for the dictation in flight');
    assert.strictEqual(h.run('corpus.recoveries().length'), 1, 'a refused clear keeps the shelf');
    h.run("mode = 'idle';");
    const swept = await h.handlers.get('recordings-clear')();
    assert.strictEqual(swept.ok, true, 'recordings-clear succeeds: ' + swept.reason);
    assert.strictEqual(h.run('corpus.recoveries().length'), 0, 'it clears shelved clips as well');
    assert.strictEqual(h.run('corpus.recordings().length'), 0);

    // --- the live copy, for a session that never ends -------------------

    // The flush handler checks the sender, so the harness needs an overlay
    // window to be the sender of.
    h.run('overlayWin = { isDestroyed: () => false, webContents: { overlay: true } };');
    const sender = h.run('overlayWin.webContents');
    const flush = (seconds) => h.ipcEvents.get('capture-flush')(
      { sender }, Buffer.alloc(Math.round(16000 * seconds) * 2, 1), 16000);

    h.run("settings.keepRecordings = true; saveSettings(); mode = 'recording'; captureVoiceSession = null;");
    flush(3);
    flush(3);
    const liveSeconds = () => Math.round(h.run('corpus.wavSeconds(corpus.recoveryPath("_live"))'));
    assert.strictEqual(h.run('corpus.hasLive()'), true, 'blocks of a running dictation reach the disk');
    assert.strictEqual(liveSeconds(), 6, 'the blocks are appended, not replaced');

    h.run("mode = 'idle';");
    flush(3);
    assert.strictEqual(liveSeconds(), 6,
      'a block arriving after the recording ended is not appended to anything');

    // A dictation that ends at all makes the partial copy redundant.
    h.run("mode = 'recording'; flashCancel();");
    assert.strictEqual(h.run('corpus.hasLive()'), false, 'cancelling drops the live copy');
    h.run("mode = 'recording';");
    flush(6);
    h.run("mode = 'transcribing'; retryEntryOwner = null; flashError('Transcribe failed');");
    assert.strictEqual(h.run('corpus.hasLive()'), false, 'a failure drops the live copy');
    h.run("mode = 'recording';");
    flush(6);
    h.run('parkCompletedClip(testAudio);');
    assert.strictEqual(h.run('corpus.hasLive()'), false, 'a finished recording drops the live copy');
    h.run('corpus.clearRetry(); corpus.dropParked(); corpus.clearRecoveries();');

    // Retention off means nothing is written at all.
    h.run("settings.keepRecordings = false; mode = 'recording';");
    flush(6);
    assert.strictEqual(h.run('corpus.hasLive()'), false, 'retention off writes no live copy');
    h.run("settings.keepRecordings = true; saveSettings(); mode = 'idle';");

    // The launch after a crash mid-sentence.
    h.run("mode = 'recording';");
    flush(6);
    h.run("mode = 'idle'; rescueUnfinishedClip();");
    let crashed = h.run('corpus.recoveries()');
    assert.strictEqual(crashed.length, 1, 'a clip cut off mid-sentence is rescued at launch');
    assert.strictEqual(crashed[0].source, 'crash');
    assert.strictEqual(crashed[0].reason, 'Voxden closed while you were dictating');
    assert.strictEqual(Math.round(crashed[0].seconds), 6, 'with everything that was said');
    assert.strictEqual(h.run('corpus.hasLive()'), false, 'and nothing left live');
    h.run('corpus.clearRecoveries();');

    // A finished recording and a partial copy of the same words: only the
    // finished one is worth offering back.
    h.run("mode = 'recording';");
    flush(6);
    h.run('corpus.parkRetry(testAudio); mode = "idle"; retryEntryOwner = null; rescueUnfinishedClip();');
    const both = h.run('corpus.recoveries()');
    assert.strictEqual(both.length, 1, 'the two copies do not become two recoveries');
    assert.strictEqual(both[0].reason, 'Voxden closed before this dictation finished');
    assert.strictEqual(h.run('corpus.hasLive()'), false, 'the partial copy is dropped');
    h.run('corpus.clearRecoveries(); overlayWin = null;');

    // A dictation that finished, then a shutdown instead of a clean quit: its
    // clip is still in the retry slot, but its words are already in history.
    h.run(`
      corpus.parkRetry(testAudio);
      const recorded = new Date(Date.now() - 2000);
      fs.utimesSync(corpus.retryPath(), recorded, recorded);
      addHistoryEntry('words that were pasted', {});
      rescueUnfinishedClip();
    `);
    assert.strictEqual(h.run('corpus.recoveries().length'), 0, 'a finished dictation is not offered back as lost');
    assert.strictEqual(h.run('corpus.hasLive()'), false);
    h.run('corpus.clearRetry();');

    console.log('recovery main OK');
  } finally {
    await h.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
