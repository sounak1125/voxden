'use strict';

// Real deletion handler and files, all confined to an isolated test directory.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const harness = require('./asr-test-harness');

async function main() {
  const h = harness();
  const unlink = fs.unlinkSync;
  try {
    h.context.testAudio = Buffer.from('524946462400000057415645666d74201000000001000100803e0000007d0000020010006461746100000000', 'hex');
    h.run(`
      history.entries = [{ id: 'saved', ts: Date.now(), text: 'Keep this transcript' },
        { id: 'trained', ts: Date.now(), text: 'Keep this correction' }];
      settings.keepRecordings = true;
      settings.keepTrainingAudio = true;
      saveSettings(); saveHistory();
      corpus.park(testAudio); corpus.claim('saved');
      corpus.park(testAudio); corpus.claim('trained');
      corpus.promote('trained', { text: 'Keep this correction' });
      corpus.parkRetry(testAudio);
    `);
    const source = h.run("corpus.recordingPath('saved')");
    const trained = h.run("corpus.recordingPath('trained')");
    const settingsFile = h.run('SETTINGS_FILE');
    const historyFile = h.run('HIST_FILE');
    const settingsBefore = fs.readFileSync(settingsFile);
    const historyBefore = fs.readFileSync(historyFile);
    const exported = path.join(h.root, 'exported.wav');
    fs.copyFileSync(source, exported);
    const clear = () => h.handlers.get('recordings-clear')();

    // An active operation owns its audio until it completes.
    for (const state of ["mode = 'arming'", "mode = 'recording'", "mode = 'transcribing'", "mode = 'idle'; retryingEntryId = 'saved'"]) {
      h.run(state);
      const blocked = await clear();
      assert.strictEqual(blocked.ok, false);
      assert.ok(fs.existsSync(source), 'busy deletion must keep the source file');
      assert.strictEqual(h.run('corpus.hasRetry()'), true);
    }
    h.run("mode = 'idle'; retryingEntryId = null;");

    fs.unlinkSync = file => {
      if (path.resolve(file) === path.resolve(source)) throw Object.assign(new Error('Locked test file'), { code: 'EPERM' });
      return unlink(file);
    };
    const partial = await clear();
    fs.unlinkSync = unlink;
    assert.strictEqual(partial.ok, false, 'a failed unlink must not report successful deletion');
    assert.strictEqual(partial.snapshot.recordings.count, 1);
    assert.strictEqual(partial.snapshot.entries.find(e => e.id === 'saved').audio, true);
    assert.match(partial.reason, /could not be deleted/);

    const done = await clear();
    assert.strictEqual(done.ok, true);
    assert.strictEqual(done.snapshot.recordings.count, 0);
    assert.strictEqual(done.snapshot.recordings.bytes, 0);
    assert.strictEqual(done.snapshot.canRetry, false);
    assert.strictEqual(fs.existsSync(source), false);
    assert.strictEqual(!!done.snapshot.entries.find(e => e.id === 'saved').audio, false);
    assert.strictEqual(done.snapshot.entries.find(e => e.id === 'saved').text, 'Keep this transcript');
    assert.strictEqual(done.snapshot.training.pairs, 1);
    assert.strictEqual(done.snapshot.entries.find(e => e.id === 'trained').audio, true);
    assert.ok(fs.existsSync(trained), 'training clips stay under their separate control');
    assert.deepStrictEqual(fs.readFileSync(exported), h.context.testAudio, 'exported WAVs stay untouched');
    assert.deepStrictEqual(fs.readFileSync(settingsFile), settingsBefore, 'deleting does not change either retention setting');
    assert.deepStrictEqual(fs.readFileSync(historyFile), historyBefore, 'deleting audio does not rewrite history');
    assert.strictEqual((await clear()).ok, true, 'an empty store is safe to clear again');

    h.run("corpus.park(testAudio); corpus.claim('new-recording');");
    assert.strictEqual(h.run("corpus.hasRecording('new-recording')"), true, 'future recordings can still be saved');
    console.log('all recordings deletion checks passed');
  } finally {
    fs.unlinkSync = unlink;
    assert.strictEqual(path.dirname(path.resolve(h.root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(h.root).startsWith('voxden-lifecycle-'));
    h.close();
  }
}

main().catch(err => { console.error(err); process.exitCode = 1; });
