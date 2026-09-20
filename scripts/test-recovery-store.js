'use strict';

// The recovery shelf: clips from dictations that never became text. Real files
// in an isolated directory, the same way test-corpus.js exercises recordings.
const fs = require('fs');
const os = require('os');
const path = require('path');
const corpus = require('../src/corpus');

let failed = 0;
function check(name, got, expected) {
  const g = JSON.stringify(got);
  const e = JSON.stringify(expected);
  if (g !== e) {
    failed += 1;
    console.error('FAIL', name, '\n  expected', e, '\n  got     ', g);
  } else {
    console.log('ok', name);
  }
}

// 16 kHz mono 16-bit, the exact format overlay.js encodes.
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

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voxden-recovery-'));
corpus.init(root);
const manifest = path.join(root, 'recovery.jsonl');
const shelf = (id) => path.join(root, 'recovery', id + '.wav');
const setAge = (file, ms) => {
  const when = new Date(Date.now() - ms);
  fs.utimesSync(file, when, when);
  corpus.invalidate();
};
const readManifest = () => (fs.existsSync(manifest)
  ? fs.readFileSync(manifest, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  : []);
// Retention reads the manifest's own timestamp, not the file's, so this is how
// a clip is made old.
const backdate = (id, ms) => {
  const records = readManifest().map((r) => (r.id === id ? { ...r, ts: r.ts - ms } : r));
  fs.writeFileSync(manifest, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  corpus.invalidate();
};

// --- shelving -----------------------------------------------------------

check('nothing in the retry slot, nothing to shelve', corpus.keepFailure({ reason: 'x' }), null);
check('an empty shelf lists nothing', corpus.recoveries().length, 0);

corpus.parkRetry(wav(3));
const first = corpus.keepFailure({ reason: 'Voxden Cloud timed out', source: 'failure', exe: 'chrome.exe' });
check('a failed clip is shelved', typeof first === 'string' && first.length > 1, true);
check('the clip is moved, not copied', corpus.hasRetry(), false);
check('the shelved clip is on disk', fs.existsSync(shelf(first)), true);

const shelved = corpus.recoveries();
check('one clip on the shelf', shelved.length, 1);
check('the reason is kept', shelved[0].reason, 'Voxden Cloud timed out');
check('the source is kept', shelved[0].source, 'failure');
check('the target app is kept', shelved[0].exe, 'chrome.exe');
check('the duration comes from the clip', shelved[0].seconds, 3);
check('findable by id', corpus.recoveryPath(first), shelf(first));
check('an unknown id has no path', corpus.recoveryPath('nope'), null);

// --- a clip whose manifest line never made it ---------------------------

corpus.parkRetry(wav(1));
const second = corpus.keepFailure({ reason: 'Speech engine not set up', source: 'failure' });
fs.writeFileSync(manifest, '');
corpus.invalidate();
const orphans = corpus.recoveries();
check('clips survive a lost manifest', orphans.length, 2);
check('an orphan still reports a duration', orphans.every((r) => r.seconds > 0), true);
check('an orphan defaults to a failure', orphans[0].source, 'failure');

// --- ordering and stats -------------------------------------------------

setAge(shelf(first), 60000);
check('newest first', corpus.recoveries()[0].id, second);
const stats = corpus.recoveryStats();
check('the shelf is counted', stats.count, 2);
check('the shelf is measured', stats.bytes > 0, true);

// --- recovering ---------------------------------------------------------

check('a recovered clip becomes its entry recording', corpus.adoptRecovery(second, 'entry1'), true);
check('the clip has left the shelf', fs.existsSync(shelf(second)), false);
check('the entry can play it', corpus.recordingPath('entry1'), path.join(root, 'recordings', 'entry1.wav'));
check('one clip left', corpus.recoveries().length, 1);
check('adopting a clip that is gone fails', corpus.adoptRecovery(second, 'entry2'), false);

// --- deleting -----------------------------------------------------------

corpus.parkRetry(wav(1));
const third = corpus.keepFailure({ reason: 'Transcribe failed' });
check('two on the shelf', corpus.recoveries().length, 2);
check('one is deleted', corpus.dropRecovery(third), true);
check('the other one stays', corpus.recoveries().map((r) => r.id), [first]);
check('its manifest line went with it', readManifest().some((r) => r.id === third), false);

// --- retention ----------------------------------------------------------

for (let i = 0; i < 4; i += 1) {
  corpus.parkRetry(wav(1));
  corpus.keepFailure({ reason: 'clip ' + i });
}
check('five on the shelf', corpus.recoveries().length, 5);
check('a count cap cuts the oldest', corpus.pruneRecoveries({ maxClips: 3 }), 2);
check('three left', corpus.recoveries().length, 3);
check('the newest survived', corpus.recoveries()[0].reason, 'clip 3');

const stale = corpus.recoveries()[2];
backdate(stale.id, 15 * 86400000);
check('an old clip ages out', corpus.pruneRecoveries({ maxDays: 14 }), 1);
check('two left', corpus.recoveries().length, 2);
check('a byte cap keeps the newest', corpus.pruneRecoveries({ maxBytes: 1 }), 2);
check('the shelf is empty', corpus.recoveries().length, 0);
check('an empty shelf prunes nothing', corpus.pruneRecoveries({ maxClips: 1 }), 0);

// --- the live copy ------------------------------------------------------

const live = path.join(root, 'recovery', '_live.wav');
const pcm = (seconds) => Buffer.alloc(Math.round(16000 * seconds) * 2, 1);

check('nothing live to start with', corpus.hasLive(), false);
check('nothing live rescues nothing', corpus.rescueLive({ reason: 'x' }), null);

check('the first block writes a header', corpus.appendLive(pcm(2), 16000), true);
check('there is a live clip now', corpus.hasLive(), true);
check('the header is 44 bytes plus the block', fs.statSync(live).size, 44 + 16000 * 2 * 2);
check('a header is written once, not per block', corpus.appendLive(pcm(2), 16000)
  && fs.statSync(live).size, 44 + 16000 * 4 * 2);
check('the length is readable before the header is repaired', Math.round(corpus.wavSeconds(live)), 4);
check('an unfinished clip is not a recovery yet', corpus.recoveries().length, 0);

// What a crash leaves: sizes never patched.
check('the sizes are still zero', [fs.readFileSync(live).readUInt32LE(4), fs.readFileSync(live).readUInt32LE(40)], [0, 0]);
const rescued = corpus.rescueLive({ reason: 'Voxden closed while you were dictating' });
check('the live clip is rescued', typeof rescued === 'string' && rescued.length > 1, true);
check('and is no longer live', corpus.hasLive(), false);
const repaired = fs.readFileSync(shelf(rescued));
check('the RIFF size is repaired', repaired.readUInt32LE(4), repaired.length - 8);
check('the data size is repaired', repaired.readUInt32LE(40), repaired.length - 44);
check('it is a crash, whatever the caller said', corpus.recoveries()[0].source, 'crash');
check('with its reason', corpus.recoveries()[0].reason, 'Voxden closed while you were dictating');
check('and its duration', corpus.recoveries()[0].seconds, 4);

corpus.appendLive(pcm(4), 16000);
check('a live clip is dropped on demand', corpus.dropLive(), true);
check('and leaves nothing behind', fs.existsSync(live), false);
check('dropping nothing is fine', corpus.dropLive(), true);

// A throat-clear is not worth offering back.
corpus.appendLive(pcm(1), 16000);
check('a clip under two seconds is discarded', corpus.rescueLive({ reason: 'x' }), null);
check('and deleted rather than left', corpus.hasLive(), false);
check('so the shelf is unchanged', corpus.recoveries().length, 1);

corpus.dropRecovery(rescued);

// --- clearing -----------------------------------------------------------

corpus.parkRetry(wav(1));
corpus.keepFailure({ reason: 'last one' });
check('the shelf is cleared', corpus.clearRecoveries(), true);
check('nothing left', corpus.recoveries().length, 0);
check('the manifest is gone too', fs.existsSync(manifest), false);
check('clearing an empty shelf is fine', corpus.clearRecoveries(), true);

corpus.parkRetry(wav(1));
corpus.keepFailure({ reason: 'swept' });
corpus.clear();
check('clear() sweeps the shelf as well', corpus.recoveries().length, 0);

fs.rmSync(root, { recursive: true, force: true });
if (failed) {
  console.error(failed + ' check(s) failed');
  process.exit(1);
}
console.log('recovery store OK');
