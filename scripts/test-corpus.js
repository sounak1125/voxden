'use strict';
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

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voxden-corpus-'));
corpus.init(root);
const recording = (id) => path.join(root, 'recordings', id + '.wav');
const stored = (id) => path.join(root, 'corpus', id + '.wav');
const pairsFile = path.join(root, 'pairs.jsonl');
const setAge = (file, ms) => {
  const when = new Date(Date.now() - ms);
  fs.utimesSync(file, when, when);
  corpus.invalidate();
};

// --- park and claim -----------------------------------------------------

check('claim with nothing parked', corpus.claim('a1'), false);

corpus.park(wav(2));
check('parked clip is claimed', corpus.claim('a1'), true);
check('claimed clip becomes the recording', fs.existsSync(recording('a1')), true);
check('claiming twice finds nothing left', corpus.claim('a2'), false);
check('the recording is findable by id', corpus.recordingPath('a1'), recording('a1'));
check('hasRecording agrees', corpus.hasRecording('a1'), true);
check('an unknown id has no recording', corpus.recordingPath('zz'), null);
check('recordingIds lists it', Array.from(corpus.recordingIds()), ['a1']);

// A transcript that arrived without audio (the Web Speech fallback) must not
// pick up somebody else's recording.
corpus.park(wav(1));
const parked = path.join(root, 'recordings', '_last.wav');
const old = new Date(Date.now() - corpus.PARK_TTL_MS - 5000);
fs.utimesSync(parked, old, old);
check('a stale park is refused', corpus.claim('a3'), false);
check('a stale park is deleted', fs.existsSync(parked), false);

// --- promote ------------------------------------------------------------

check('promote without audio', corpus.promote('nope', { text: 'hello' }), false);
check('promote without text', corpus.promote('a1', { text: '   ' }), false);

check(
  'a correction becomes a pair',
  corpus.promote('a1', {
    text: 'I flew to Bhubaneswar today',
    asr: 'I flew to bubba neshwar today',
    learned: [{ from: 'bubba neshwar', to: 'Bhubaneswar' }],
    ts: 1234,
  }),
  true
);
check('the clip moved out of recordings', fs.existsSync(recording('a1')), false);
check('the clip landed in the corpus', fs.existsSync(stored('a1')), true);
// Playback does not lose the clip to the correction.
check('a corrected entry still has a recording', corpus.recordingPath('a1'), stored('a1'));
check('recordingIds includes corpus clips', Array.from(corpus.recordingIds()), ['a1']);

let pairs = corpus.readPairs();
check('one pair on the manifest', pairs.length, 1);
check('pair keeps the corrected text', pairs[0].text, 'I flew to Bhubaneswar today');
check('pair keeps what the model heard', pairs[0].asr, 'I flew to bubba neshwar today');
check('pair keeps what was learned', pairs[0].learned, [{ from: 'bubba neshwar', to: 'Bhubaneswar' }]);
check('pair audio path is relative', pairs[0].audio, 'corpus/a1.wav');
check('pair duration comes from the header', pairs[0].seconds, 2);

// Editing the same entry again refines the label rather than duplicating it.
corpus.promote('a1', { text: 'I flew to Bhubaneswar Airport today', asr: 'I flew to bubba neshwar today', ts: 1234 });
pairs = corpus.readPairs();
check('re-editing updates in place', pairs.length, 1);
check('re-editing keeps the newest text', pairs[0].text, 'I flew to Bhubaneswar Airport today');

// --- stats --------------------------------------------------------------

corpus.park(wav(3));
corpus.claim('b1');
let st = corpus.stats();
check('stats count pairs', st.pairs, 1);
check('stats count uncorrected recordings as pending', st.pending, 1);
check('stats sum audio seconds', st.seconds, 2);
check('stats report bytes', st.bytes > 0, true);
let rs = corpus.recordingStats();
check('recording stats count the kept clips', rs.count, 1);
check('recording stats report their bytes', rs.bytes, 44 + 3 * 16000 * 2);

// stats() is memoised; a mutation has to drop the memo.
corpus.promote('b1', { text: 'second clip', asr: 'sekond klip', ts: 5 });
st = corpus.stats();
check('stats refresh after promote', st.pairs, 2);
check('stats add the new duration', st.seconds, 5);
check('promoted clip leaves the recordings', st.pending, 0);

// --- discard ------------------------------------------------------------

check('discarding a dictation reports work', corpus.discard('a1'), true);
check('discarding removes the recording', fs.existsSync(stored('a1')), false);
check('discarding removes the pair', corpus.readPairs().map((r) => r.id), ['b1']);
check('discarding an unknown id is a no-op', corpus.discard('ghost'), false);

// --- retention ----------------------------------------------------------

// The policy is the caller's; every rule is independent and optional.
for (const id of ['r1', 'r2', 'r3', 'r4']) {
  corpus.park(wav(0.5));
  corpus.claim(id);
}
check('prune with no policy keeps everything', corpus.prune({}), 0);

// An entry gone from history takes its clip along.
check('prune drops clips whose entries are gone', corpus.prune({ keepIds: ['r1', 'r2', 'r3'] }), 1);
check('the orphan is the one removed', fs.existsSync(recording('r4')), false);
check('the kept ones stay', ['r1', 'r2', 'r3'].map((id) => fs.existsSync(recording(id))), [true, true, true]);

// Age, from the clip's own timestamp.
setAge(recording('r1'), 15 * 86400000);
check('prune drops clips past the day limit', corpus.prune({ maxDays: 14 }), 1);
check('the old one is gone', fs.existsSync(recording('r1')), false);
check('a younger one is kept', fs.existsSync(recording('r2')), true);

// Bytes, newest first, so the oldest is what a full budget cuts.
setAge(recording('r2'), 60000);
const clipBytes = 44 + 0.5 * 16000 * 2;
check('prune drops the oldest over the byte budget', corpus.prune({ maxBytes: clipBytes + 1 }), 1);
check('the newer clip survives the byte budget', fs.existsSync(recording('r3')), true);
check('the older clip does not', fs.existsSync(recording('r2')), false);

// Count.
for (let i = 0; i < 5; i += 1) {
  corpus.park(wav(0.1));
  corpus.claim('c' + i);
}
corpus.prune({ maxClips: 3 });
check('prune keeps at most maxClips', corpus.recordings().length, 3);

// --- clearing -----------------------------------------------------------

// Two toggles, two stores. Turning one off must not empty the other.
corpus.clearRecordings();
check('clearRecordings empties the recordings', corpus.recordings().length, 0);
check('clearRecordings keeps the corpus', fs.existsSync(stored('b1')), true);
check('clearRecordings keeps the manifest', corpus.readPairs().length, 1);

corpus.park(wav(0.2));
corpus.claim('d1');
corpus.clearCorpus();
check('clearCorpus empties the corpus', fs.readdirSync(path.join(root, 'corpus')), []);
check('clearCorpus drops the manifest', fs.existsSync(pairsFile), false);
check('clearCorpus keeps the recordings', fs.existsSync(recording('d1')), true);
check('clearCorpus resets stats', corpus.stats().pairs, 0);

corpus.clear();
check('clear empties everything', corpus.recordings().length + fs.readdirSync(path.join(root, 'corpus')).length, 0);

corpus.parkRetry(wav(1));
check('retry clip is kept', corpus.hasRetry(), true);
corpus.clear();
check('clear does not drop retry audio', corpus.hasRetry(), true);
check('retry path points at audio/retry.wav', path.basename(corpus.retryPath()), 'retry.wav');
corpus.clearRetry();
check('clearRetry removes the last clip', corpus.hasRetry(), false);
check('missing retry path is null', corpus.retryPath(), null);

// --- migration ----------------------------------------------------------

// A data folder from before playback has its clips under "pending". They are
// the same clips, so the folder is carried over rather than left behind.
const legacyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'voxden-corpus-legacy-'));
fs.mkdirSync(path.join(legacyRoot, 'pending'), { recursive: true });
fs.writeFileSync(path.join(legacyRoot, 'pending', 'old1.wav'), wav(0.3));
corpus.init(legacyRoot);
check('a legacy pending folder becomes recordings', fs.existsSync(path.join(legacyRoot, 'recordings', 'old1.wav')), true);
check('the legacy folder is gone', fs.existsSync(path.join(legacyRoot, 'pending')), false);
check('legacy clips are findable', corpus.hasRecording('old1'), true);
fs.rmSync(legacyRoot, { recursive: true, force: true });
corpus.init(root);

// --- safety -------------------------------------------------------------

// Entry ids come from nid(); anything path-shaped in one must not escape.
check('traversal ids are refused', corpus.promote('../../evil', { text: 'x' }), false);
check('no file escaped the sandbox', fs.existsSync(path.join(root, '..', 'evil.wav')), false);
check('traversal ids find no recording', corpus.recordingPath('../retry'), null);

fs.rmSync(root, { recursive: true, force: true });

if (failed) {
  console.error(failed + ' failed');
  process.exit(1);
}
console.log('all corpus tests passed');
