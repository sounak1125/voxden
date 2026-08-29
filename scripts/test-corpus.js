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
const pending = (id) => path.join(root, 'pending', id + '.wav');
const stored = (id) => path.join(root, 'corpus', id + '.wav');
const pairsFile = path.join(root, 'pairs.jsonl');

// --- park and claim -----------------------------------------------------

check('claim with nothing parked', corpus.claim('a1'), false);

corpus.park(wav(2));
check('parked clip is claimed', corpus.claim('a1'), true);
check('claimed clip lands in pending', fs.existsSync(pending('a1')), true);
check('claiming twice finds nothing left', corpus.claim('a2'), false);

// A transcript that arrived without audio (the Web Speech fallback) must not
// pick up somebody else's recording.
corpus.park(wav(1));
const parked = path.join(root, 'pending', '_last.wav');
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
    text: 'I met Subhrajit today',
    asr: 'I met sub trees today',
    learned: [{ from: 'sub trees', to: 'Subhrajit' }],
    ts: 1234,
  }),
  true
);
check('the clip moved out of pending', fs.existsSync(pending('a1')), false);
check('the clip landed in the corpus', fs.existsSync(stored('a1')), true);

let pairs = corpus.readPairs();
check('one pair on the manifest', pairs.length, 1);
check('pair keeps the corrected text', pairs[0].text, 'I met Subhrajit today');
check('pair keeps what the model heard', pairs[0].asr, 'I met sub trees today');
check('pair keeps what was learned', pairs[0].learned, [{ from: 'sub trees', to: 'Subhrajit' }]);
check('pair audio path is relative', pairs[0].audio, 'corpus/a1.wav');
check('pair duration comes from the header', pairs[0].seconds, 2);

// Editing the same entry again refines the label rather than duplicating it.
corpus.promote('a1', { text: 'I met Subhrajit Roy today', asr: 'I met sub trees today', ts: 1234 });
pairs = corpus.readPairs();
check('re-editing updates in place', pairs.length, 1);
check('re-editing keeps the newest text', pairs[0].text, 'I met Subhrajit Roy today');

// --- stats --------------------------------------------------------------

corpus.park(wav(3));
corpus.claim('b1');
let st = corpus.stats();
check('stats count pairs', st.pairs, 1);
check('stats count pending', st.pending, 1);
check('stats sum audio seconds', st.seconds, 2);
check('stats report bytes', st.bytes > 0, true);

// stats() is memoised; a mutation has to drop the memo.
corpus.promote('b1', { text: 'second clip', asr: 'sekond klip', ts: 5 });
st = corpus.stats();
check('stats refresh after promote', st.pairs, 2);
check('stats add the new duration', st.seconds, 5);
check('promoted clip leaves pending', st.pending, 0);

// --- discard ------------------------------------------------------------

check('discarding a dictation reports work', corpus.discard('a1'), true);
check('discarding removes the recording', fs.existsSync(stored('a1')), false);
check('discarding removes the pair', corpus.readPairs().map((r) => r.id), ['b1']);
check('discarding an unknown id is a no-op', corpus.discard('ghost'), false);

// --- pending window -----------------------------------------------------

for (let i = 0; i < corpus.PENDING_MAX_CLIPS + 8; i += 1) {
  corpus.park(wav(0.2));
  corpus.claim('p' + i);
}
const held = fs.readdirSync(path.join(root, 'pending')).filter((n) => n !== '_last.wav');
check('pending window is bounded', held.length <= corpus.PENDING_MAX_CLIPS, true);

// --- clear --------------------------------------------------------------

corpus.clear();
check('clear empties the corpus', fs.readdirSync(path.join(root, 'corpus')), []);
check('clear empties pending', fs.readdirSync(path.join(root, 'pending')), []);
check('clear drops the manifest', fs.existsSync(pairsFile), false);
check('clear resets stats', corpus.stats().pairs, 0);

// --- safety -------------------------------------------------------------

// Entry ids come from nid(); anything path-shaped in one must not escape.
check('traversal ids are refused', corpus.promote('../../evil', { text: 'x' }), false);
check('no file escaped the sandbox', fs.existsSync(path.join(root, '..', 'evil.wav')), false);

fs.rmSync(root, { recursive: true, force: true });

if (failed) {
  console.error(failed + ' failed');
  process.exit(1);
}
console.log('all corpus tests passed');
