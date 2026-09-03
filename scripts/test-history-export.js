'use strict';

// Exercise the real export handler and filesystem, with only the save dialog
// and clock controlled. Everything is written under the harness's temp folder.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const harness = require('./asr-test-harness');

async function main() {
  let now = new Date(2026, 8, 3, 12, 34, 56).getTime();
  let target;
  let cancelled = false;
  const dialogs = [];
  const h = harness({ dialog: {
    showSaveDialog: async (_parent, options) => {
      dialogs.push(options);
      // The user may leave the dialog open before choosing where to save.
      now += 90000;
      return { canceled: cancelled, filePath: target };
    },
  } });
  try {
    const originalTime = new Date(2020, 0, 2, 3, 4, 5);
    // A valid, empty 16 kHz mono WAV. Export must preserve every audio byte.
    const audio = Buffer.from('524946462400000057415645666d74201000000001000100803e0000007d0000020010006461746100000000', 'hex');
    h.context.exportAudio = audio;
    h.context.originalTimestamp = originalTime.getTime();
    h.run(`
      history.entries = [{ id: 'export-test', ts: originalTimestamp, text: 'Old dictation' }];
      corpus.park(exportAudio);
      corpus.claim('export-test');
    `);
    const source = h.run("corpus.recordingPath('export-test')");
    fs.utimesSync(source, originalTime, originalTime);
    h.context.exportClock = () => now;
    h.run(`Date = class extends Date {
      constructor(...args) { super(...(args.length ? args : [exportClock()])); }
      static now() { return exportClock(); }
    };`);
    const save = () => h.handlers.get('history-audio-save')({}, 'export-test');
    fs.mkdirSync(path.join(h.root, 'Chosen folder'));
    target = path.join(h.root, 'Chosen folder', 'custom recording.wav');

    for (const overwrite of [false, true]) {
      if (overwrite) {
        fs.writeFileSync(target, 'older export');
        fs.utimesSync(target, originalTime, originalTime);
        now = new Date(2026, 8, 3, 13, 45, 6).getTime();
      }
      const result = await save();
      assert.strictEqual(result.ok, true, result.reason);
      assert.strictEqual(result.path, target, 'the chosen destination is respected');
      assert.deepStrictEqual(fs.readFileSync(target), audio, 'the exported WAV is byte-for-byte identical');
      assert.ok(Math.abs(fs.statSync(target).mtimeMs - now) < 2,
        'Date modified is when saving finishes, including when overwriting');
      assert.strictEqual(fs.statSync(source).mtimeMs, originalTime.getTime(), 'the stored recording keeps its date');
      assert.strictEqual(h.run('history.entries[0].ts'), originalTime.getTime(), 'the history date is unchanged');
      console.log('ok ' + (overwrite ? 'overwritten' : 'new') + ' export has the save time and preserves the original');
    }
    assert.strictEqual(dialogs[0].defaultPath, path.join(h.root, 'Voxden 2026-09-03 12-34-56.wav'),
      'the Downloads filename uses the export time, with seconds');
    assert.strictEqual(path.basename(dialogs[1].defaultPath), 'Voxden 2026-09-03 13-45-06.wav');

    cancelled = true;
    const beforeCancel = fs.statSync(target).mtimeMs;
    const result = await save();
    assert.strictEqual(result.cancelled, true);
    assert.strictEqual(fs.statSync(target).mtimeMs, beforeCancel, 'cancel does not touch an existing export');
    console.log('all history export tests passed');
  } finally {
    assert.strictEqual(path.dirname(path.resolve(h.root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(h.root).startsWith('voxden-lifecycle-'));
    h.close();
  }
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
