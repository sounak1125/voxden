'use strict';

// Chunk boundary reconciliation.
//
// The chunker cuts a long dictation into slices while the user is still
// talking, so most of the recognition is finished by the time they stop. Each
// slice keeps OVERLAP_MS of the previous one at its front, which means the two
// transcripts are supposed to share their seam.
//
// That overlap used to be joined with `texts.join(' ')` and handed to the
// repeat collapser -- so the duplicated words came through, and the collapser
// aimed at the whole transcript to remove them also flattened repetition the
// speaker had actually produced. Overlap is removed at the seam now, and a
// seam that cannot be stitched is reported rather than pasted over.

const assert = require('assert');
const chunking = require('../src/chunking');

let checks = 0;
function eq(label, actual, expected) {
  assert.deepStrictEqual(actual, expected, label + '\n  got: ' + JSON.stringify(actual));
  checks += 1;
  process.stdout.write('ok ' + label + '\n');
}
function ok(label, value) {
  assert.ok(value, label);
  checks += 1;
  process.stdout.write('ok ' + label + '\n');
}

const join = (parts, bridges) => chunking.reconcileChunkTranscripts(parts, bridges);

// --- 1. The overlap the chunker created is removed --------------------------
eq('a one-word overlap is stitched',
  join(['the quick brown', 'brown fox jumps']).text, 'the quick brown fox jumps');
eq('a multi-word overlap is stitched',
  join(['i am saying the words', 'saying the words out loud']).text,
  'i am saying the words out loud');
eq('the longest overlap wins',
  join(['a b c d e f', 'd e f g']).text, 'a b c d e f g');
eq('punctuation and case do not hide an overlap',
  join(['one two three,', 'Three four five']).text, 'one two three, four five');
eq('three slices stitch in sequence',
  join(['one two', 'two three', 'three four']).text, 'one two three four');

// --- 2. Speech that only looks like an overlap is preserved -----------------
eq('two unrelated slices are simply joined',
  join(['hello there', 'general kenobi']).text, 'hello there general kenobi');
eq('a repetition the speaker actually made survives',
  join(['it was very very good', 'good enough for me']).text,
  'it was very very good enough for me');
eq('a single slice is returned as it is',
  join(['nothing to stitch here']).text, 'nothing to stitch here');
eq('empty parts are skipped', join(['one', '', 'one two']).text, 'one two');
eq('no parts at all is empty', join([]).text, '');
eq('and reports no boundaries', join([]).boundaries, []);

// --- 3. Boundaries are reported ---------------------------------------------
const stitched = join(['the quick brown', 'brown fox']);
eq('a stitched boundary reports its overlap', stitched.boundaries[0].overlap, 1);
ok('and is not suspect', !stitched.boundaries[0].suspect);

const broken = join(['can we increase the trans', 'cription timing please']);
ok('a seam with no overlap is flagged suspect', broken.boundaries[0].suspect);
eq('and it is offered for an audio recheck',
  chunking.suspectBoundaries(broken.boundaries, 2), [1]);
eq('the recheck list is capped',
  chunking.suspectBoundaries(
    [{ suspect: true, index: 1 }, { suspect: true, index: 2 }, { suspect: true, index: 3 }], 2
  ), [1, 2]);
eq('a healthy transcript asks for no rechecks',
  chunking.suspectBoundaries(stitched.boundaries, 2), []);

// --- 4. The audio bridge ----------------------------------------------------
//
// A cut through the middle of a word leaves half of it on each side. Neither
// transcript ever contained "transcription", so no amount of string handling
// recovers it -- only re-recognising the audio that spans the seam does.
const parts = ['can we increase the trans', 'cription timing please'];
eq('without a bridge the fragments stay',
  join(parts).text, 'can we increase the trans cription timing please');
const bridged = join(parts, { 1: 'the transcription timing' });
eq('a bridge that anchors on both sides repairs the word',
  bridged.text, 'can we increase the transcription timing please');
eq('and it is counted', bridged.bridged, 1);
ok('and the boundary records that it was bridged', bridged.boundaries[0].bridged);

eq('a bridge that anchors on neither side is ignored',
  join(parts, { 1: 'totally unrelated words' }).text,
  'can we increase the trans cription timing please');
eq('a bridge that anchors on only one side is ignored',
  join(parts, { 1: 'the trans something else entirely' }).text,
  'can we increase the trans cription timing please');
eq('an empty bridge is ignored',
  join(parts, { 1: '' }).text, 'can we increase the trans cription timing please');
eq('a bridge is not used where the text already stitched',
  join(['the quick brown', 'brown fox'], { 1: 'quick brown fox' }).text,
  'the quick brown fox');

// The failure a bridge must never cause: the same words three times.
const triple = join(['one two three', 'four five six'], { 1: 'two three four five' });
ok('a bridge never repeats what both sides already had',
  (triple.text.match(/three/g) || []).length === 1
  && (triple.text.match(/four/g) || []).length === 1);

// --- 5. spliceBridge on its own ---------------------------------------------
const splice = chunking.spliceBridge(
  ['can', 'we', 'increase', 'the', 'trans'],
  ['cription', 'timing', 'please'],
  'the transcription timing'
);
ok('splicing drops the broken fragment from the left', !splice.left.includes('trans'));
eq('and returns the whole word once',
  splice.left.concat(splice.tokens).join(' '),
  'can we increase the transcription timing please');
ok('an unanchored splice declines',
  !chunking.spliceBridge(['a', 'b'], ['c', 'd'], 'x y z').applied);

// --- 6. joinChunkTranscripts is the same thing plus repeat collapsing -------
eq('the joined helper stitches too',
  chunking.joinChunkTranscripts(['the quick brown', 'brown fox jumps']),
  'the quick brown fox jumps');
eq('and passes bridges through',
  chunking.joinChunkTranscripts(parts, { 1: 'the transcription timing' }),
  'can we increase the transcription timing please');
eq('nothing in means nothing out', chunking.joinChunkTranscripts([]), '');

// --- 7. Long dictations -----------------------------------------------------
// Forty slices with a one-word overlap each: the result must be the sentence,
// not the sentence with forty extra words in it.
const many = [];
const words = [];
for (let i = 0; i < 40; i++) words.push('w' + i);
for (let i = 0; i < words.length; i += 2) {
  many.push(words.slice(i, Math.min(i + 3, words.length)).join(' '));
}
eq('a long chain of overlapping slices reconstructs the sequence',
  chunking.reconcileChunkTranscripts(many).text, words.join(' '));

process.stdout.write('all ' + checks + ' chunk boundary checks passed\n');
