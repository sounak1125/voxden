'use strict';

const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const { createCloudSegmenter, createCloudQueue, joinCloudTexts } = require('../src/cloud-segments');

function voice(length, phase = 0) {
  return Float32Array.from({ length }, (_, i) => Math.sin((i + phase) * 0.07) * 0.2);
}

function join(parts) {
  const result = new Float32Array(parts.reduce((n, part) => n + part.length, 0));
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}

function assertExact(actual, expected, message) {
  assert.strictEqual(actual.length, expected.length, message);
  assert(Buffer.from(actual.buffer, actual.byteOffset, actual.byteLength)
    .equals(Buffer.from(expected.buffer, expected.byteOffset, expected.byteLength)), message);
}

function finish(segmenter, segments) {
  const tail = segmenter.flush();
  if (tail) segments.push(tail);
  assert.strictEqual(segmenter.flush(), null, 'a second flush must not duplicate audio');
  return segments;
}

const empty = createCloudSegmenter();
assert.deepStrictEqual(empty.push(new Float32Array()), []);
assert.strictEqual(empty.flush(), null);
assert.throws(() => empty.push([0]), /Float32Array/);
for (const options of [{ sampleRate: 0 }, { silenceMs: -1 }, { minSegmentMs: -1 }, { speechRms: NaN }]) {
  assert.throws(() => createCloudSegmenter(options), /positive sample rate/);
}

const shortPhrase = join([voice(16000), new Float32Array(8000)]);
const short = createCloudSegmenter();
assert.deepStrictEqual(short.push(shortPhrase), [], 'short dictation waits for stop');
assertExact(short.flush(), shortPhrase, 'short dictation must be complete');

// Every cut takes context from the model, and a speaker who slows down on a
// name ("Higgs... field") pauses inside the word. A short dictation goes up
// whole, even with a long hesitation in it.
for (const pauseMs of [450, 1200]) {
  const hesitant = join([voice(16 * 1800), new Float32Array(16 * pauseMs), voice(16 * 700, 97)]);
  const shortHesitant = createCloudSegmenter();
  assert.deepStrictEqual(shortHesitant.push(hesitant), [], 'a short dictation is never split (' + pauseMs + 'ms pause)');
  assertExact(shortHesitant.flush(), hesitant, 'a short dictation keeps its full context');
}

// A pause shorter than 700ms is a breath, not a break between thoughts, even
// in a long dictation.
const breath = join([voice(16 * 5000), new Float32Array(16 * 500), voice(16 * 700, 97)]);
const longBreath = createCloudSegmenter();
assert.deepStrictEqual(longBreath.push(breath), [], 'a 500ms pause does not split a long dictation');

// Before the 4 second floor even a real pause cuts nothing: the piece would be
// too short for the model to hear context in. A pause that outlasts the floor
// cuts the moment the segment reaches 4 seconds, since it is already quiet.
const earlyPause = join([voice(16 * 2500), new Float32Array(16 * 750), voice(16 * 2000, 97)]);
const beforeFloor = createCloudSegmenter();
assert.deepStrictEqual(beforeFloor.push(earlyPause), [], 'a 750ms pause before the floor does not split');
assertExact(beforeFloor.flush(), earlyPause, 'and the dictation goes up whole');
const floorInPause = createCloudSegmenter();
const floorInPauseSegments = floorInPause.push(join([voice(16 * 3000), new Float32Array(16 * 1500), voice(16 * 700, 97)]));
assert.strictEqual(floorInPauseSegments.length, 1, 'a long pause that spans the floor uploads');
assert(floorInPauseSegments[0].length >= 16 * 4000 && floorInPauseSegments[0].length < 16 * 4100,
  'and the cut lands as soon as the segment is 4 seconds long');

// Past the 4 second floor a real pause still uploads while recording
// continues, leaving only the tail to transcribe at stop.
const paused = join([voice(16 * 4500), new Float32Array(16 * 750), voice(16 * 700, 97)]);
const overFloor = createCloudSegmenter();
const overFloorSegments = overFloor.push(paused);
assert.strictEqual(overFloorSegments.length, 1, 'a pause past the floor uploads during recording');
assert(overFloorSegments[0].length >= 16 * 4500, 'the segment carries the speech before the pause');
assert(overFloor.flush().length <= 16 * 800, 'only the tail is left for stop');

const uninterrupted = voice(16000 * 65);
const continuous = createCloudSegmenter();
for (let offset = 0; offset < uninterrupted.length; offset += 2048) {
  assert.deepStrictEqual(continuous.push(uninterrupted.subarray(offset, offset + 2048)), [],
    'continuous speech must never be cut by a duration limit');
}
assertExact(continuous.flush(), uninterrupted, 'long dictation must be preserved');

// Reading aloud past 45 seconds, a 300ms pause is enough; before that it is a
// breath and stays inside the segment.
const reading = join([voice(16 * 46000), new Float32Array(16 * 350), voice(16 * 700, 97)]);
const reader = createCloudSegmenter();
const readerSegments = reader.push(reading);
assert.strictEqual(readerSegments.length, 1, 'a 300ms pause past 45 seconds uploads');
assert(readerSegments[0].length >= 16 * 46000, 'with all the speech before it');
const earlyBreath = createCloudSegmenter();
assert.deepStrictEqual(earlyBreath.push(join([voice(16 * 20000), new Float32Array(16 * 350), voice(16 * 700, 97)])), [],
  'a 300ms pause before 45 seconds does not');

// Only at 240 seconds, short of the relay's five-minute limit, is speech with
// no pause at all cut, and every sample is still kept.
const marathon = voice(16000 * 250);
const runner = createCloudSegmenter();
const runnerSegments = [];
for (let offset = 0; offset < marathon.length; offset += 4096) {
  runnerSegments.push(...runner.push(marathon.subarray(offset, offset + 4096)));
}
assert.strictEqual(runnerSegments.length, 1, 'unbroken speech is cut once, at 240 seconds');
assert(Math.abs(runnerSegments[0].length - 16000 * 240) <= 256, 'right at the limit');
assertExact(join(finish(runner, runnerSegments)), marathon, 'and nothing is lost across the cut');
for (const options of [{ longSegmentMs: 1000 }, { longSilenceMs: 0 }, { maxSegmentMs: 1000 }]) {
  assert.throws(() => createCloudSegmenter(options), RangeError);
}

// Exact known cut positions: each phrase has 4.4 seconds of speech and a 704ms
// pause (whole detection frames). End with fewer samples than a detection
// frame to catch truncated tails.
const PAUSE = 11264;
const phraseA = join([voice(70400), new Float32Array(PAUSE)]);
const phraseB = join([voice(70400, 97), new Float32Array(PAUSE)]);
const finalWords = voice(137, 37);
const recording = join([phraseA, phraseB, finalWords]);
const whole = createCloudSegmenter();
const firstSegments = whole.push(recording);
assert.strictEqual(firstSegments.length, 2, 'both complete pauses should emit immediately');
assertExact(firstSegments[0], phraseA, 'first phrase order and cut');
assertExact(firstSegments[1], phraseB, 'second phrase order and cut');
assertExact(whole.flush(), finalWords, 'last spoken partial frame must survive');

// Identical spoken phrases are distinct audio and must not be deduplicated.
const repeated = createCloudSegmenter();
assertExact(join(finish(repeated, repeated.push(join([phraseA, phraseA])))), join([phraseA, phraseA]),
  'real repetitions must survive');

// A subthreshold pause within an utterance cannot split it, even after the
// minimum duration. Quiet background samples are kept exactly as recorded.
const briefPause = join([voice(70400), new Float32Array(4000).fill(0.002), voice(20000, 21)]);
const noSplit = createCloudSegmenter();
assert.deepStrictEqual(noSplit.push(briefPause), []);
assertExact(noSplit.flush(), briefPause, 'short pause keeps phrase context');

// Soft speech is still speech. A word that fades below the old 0.012 RMS
// boundary for more than 700ms must stay with the rest of its phrase.
const softVoice = Float32Array.from(voice(16384), sample => sample * 0.045);
const fadingWord = join([voice(70400), softVoice, voice(12800, 91)]);
const softEnding = createCloudSegmenter();
assert.strictEqual(softEnding.push(fadingWord).length, 0,
  'a quieter syllable cannot become a pause in the middle of a word');
const afterWord = softEnding.push(new Float32Array(PAUSE));
assert.strictEqual(afterWord.length, 1, 'the real 700ms pause still emits without extra latency');
assertExact(afterWord[0], join([fadingWord, new Float32Array(PAUSE)]),
  'soft word ending and following speech stay in the same request');

const quietTalker = createCloudSegmenter();
const quietPhrase = join([...Array(5).fill(softVoice), new Float32Array(PAUSE)]);
assert.strictEqual(quietTalker.push(quietPhrase).length, 1,
  'quiet dictation also transcribes during pauses instead of waiting for stop');

const roomPause = createCloudSegmenter();
assert.strictEqual(roomPause.push(join([voice(70400), new Float32Array(PAUSE).fill(0.003)])).length, 1,
  'suppressed background noise still counts as a pause');

// Input partitioning and input buffer reuse must not change cuts or contents.
for (let seed = 1; seed <= 30; seed++) {
  let random = seed;
  const split = createCloudSegmenter();
  const outputs = [];
  let offset = 0;
  while (offset < recording.length) {
    random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
    const length = 1 + random % 4096;
    const block = recording.slice(offset, offset + length);
    outputs.push(...split.push(block));
    block.fill(-0.9); // Simulate the capture system reusing its callback buffer.
    offset += length;
  }
  finish(split, outputs);
  assert.deepStrictEqual(outputs.map(part => part.length), [phraseA.length, phraseB.length, finalWords.length],
    'cuts must be independent of capture block sizes');
  assertExact(join(outputs), recording, 'randomized blocks preserve each sample exactly once');
}

const silence = new Float32Array(100000).fill(0.001);
const silent = createCloudSegmenter();
assert.deepStrictEqual(silent.push(silence), [], 'silence cannot create transcription segments');
assertExact(silent.flush(), silence, 'silence gate remains the caller responsibility');

const reusable = createCloudSegmenter();
const saved = reusable.push(phraseA)[0];
const savedCopy = saved.slice();
reusable.push(phraseB);
reusable.flush();
assertExact(saved, savedCopy, 'later pushes and flushes cannot mutate an earlier output');
assert.deepStrictEqual(reusable.push(finalWords), [], 'flushed instance starts a fresh recording');
assertExact(reusable.flush(), finalWords, 'flush resets counters and pending buffers');

const browser = { Float32Array };
vm.runInNewContext(fs.readFileSync(require.resolve('../src/cloud-segments'), 'utf8'), browser);
assert.strictEqual(typeof browser.voxdenCloudSegments.createCloudSegmenter, 'function');
const browserSegmenter = browser.voxdenCloudSegments.createCloudSegmenter();
browserSegmenter.push(finalWords);
assertExact(browserSegmenter.flush(), finalWords, 'browser global exposes the same API');
assert.strictEqual(browser.voxdenCloudSegments.joinCloudTexts(["it's on a", 'Like the image', 'Kunal said so']),
  "it's on a like the image Kunal said so", 'the browser global joins and lowers capitals the same way');

// Joining: a word the model marked as cut off at the end of one segment is
// rejoined with the rest of it; everything else is kept as said.
assert.strictEqual(joinCloudTexts(['I made it with Higgs-', 'Field and it looks great.']),
  'I made it with Higgsfield and it looks great.');
assert.strictEqual(joinCloudTexts(['I made it with Higgs-.', 'field.']), 'I made it with Higgsfield.');
assert.strictEqual(joinCloudTexts(['Built on Open-', 'AI models.']), 'Built on OpenAI models.',
  'an acronym keeps its capitals');
assert.strictEqual(joinCloudTexts(['Say it again.', 'Say it again.']), 'Say it again. Say it again.',
  'repeated speech is not deduplicated');
assert.strictEqual(joinCloudTexts(['I was going to —', 'anyway, never mind.']), 'I was going to — anyway, never mind.',
  'a dash that stands alone is punctuation, not a cut word');
assert.strictEqual(joinCloudTexts(['Wait...', 'maybe tomorrow.']), 'Wait... maybe tomorrow.',
  'trailing off is not a cut word');
assert.strictEqual(joinCloudTexts(['  ', 'Hello', '', 'world.']), 'Hello world.');
assert.strictEqual(joinCloudTexts(['Higgs-']), 'Higgs-', 'a fragment with nothing after it is left alone');
assert.strictEqual(joinCloudTexts(), '');
assert.strictEqual(joinCloudTexts([]), '');

// A fragment the next segment opens with again is a stutter or a restart, not a
// word cut in two: nothing is merged. The stutter hyphen does not block the
// normal lowering of an ordinary word after it.
assert.strictEqual(joinCloudTexts(['Higgs-', 'field']), 'Higgsfield', 'a real cut still merges');
assert.strictEqual(joinCloudTexts(['I made it with Higgs-', 'field today.']), 'I made it with Higgsfield today.');
assert.strictEqual(joinCloudTexts(['when it comes f-', 'For him']), 'when it comes f- for him',
  'a one-letter stutter is not glued to the word that follows');
assert.strictEqual(joinCloudTexts(['when it comes f-', 'For him, like it should, you know, opens its mouth']),
  'when it comes f- for him, like it should, you know, opens its mouth');
assert.strictEqual(joinCloudTexts(['Hig-', 'Higgsfield']), 'Hig- Higgsfield', 'a restarted whole word stays as said');
assert.strictEqual(joinCloudTexts(['I made it with Hig-', 'Higgsfield today.']), 'I made it with Hig- Higgsfield today.');
assert.strictEqual(joinCloudTexts(['I asked Ku-', 'Kunal to send it']), 'I asked Ku- Kunal to send it',
  'a stuttered name is not lowered after the fragment');
assert.strictEqual(joinCloudTexts(['and so the th-', 'The thing is']), 'and so the th- the thing is',
  'the fragment is compared without regard to case');
assert.strictEqual(joinCloudTexts(['Hig-', 'Higgsfield', 'Is great']), 'Hig- Higgsfield is great',
  'a stutter does not disturb the join after it');
// A dash that stands for a clause break, or a colon, still keeps the capital.
for (const [first, second] of [['it is word —', 'The result'], ['it is word—', 'The result'], ['it is word –', 'The result'],
  ['it is word–', 'The result'], ['it is word -', 'The result'], ['it is word --', 'The result'], ['it is word:', 'The result']]) {
  assert.strictEqual(joinCloudTexts([first, second]), first + ' ' + second, 'capital kept after "' + first + '"');
}

// The model capitalises the first word of every clip it is given. Where the
// piece before has not ended a sentence, an ordinary word that opens the next
// is lowered; nothing that could be a name ever is.
const lowered = [
  [["it's on a", 'Like the image'], "it's on a like the image"],
  [['the script is mentioned and how', 'The script'], 'the script is mentioned and how the script'],
  [['how', 'The script'], 'how the script'],
  [['so, uh,', 'Like, the image'], 'so, uh, like, the image'],
  [['and then we', 'Make it bigger.'], 'and then we make it bigger.'],
  [['and I think', "It's fine"], "and I think it's fine"],
  [['but then', "That's the one"], "but then that's the one"],
  [['but then', 'That’s the one'], 'but then that’s the one'],
  [['and', "Don't do that"], "and don't do that"],
  [['and then', 'Taking the screenshot'], 'and then taking the screenshot'],
  [['and then', 'Shows the result.'], 'and then shows the result.'],
  [['if you', 'Wanted this'], 'if you wanted this'],
  [['I was', 'Using it'], 'I was using it'],
  [['and then', 'Getting there'], 'and then getting there'],
  [['you know, those kind of', 'Stuff, you know'], 'you know, those kind of stuff, you know'],
  [['the picture shows a', 'Cat sitting down, and the cat is orange.'], 'the picture shows a cat sitting down, and the cat is orange.'],
  [['I saw one cat and another', 'Cat was sleeping'], 'I saw one cat and another cat was sleeping'],
  [['and', 'Uh, wait'], 'and uh, wait'],
  [['one two three', 'And four'], 'one two three and four'],
  [['it is on the', 'Like image. Like it.'], 'it is on the like image. Like it.'],
];
for (const [input, expected] of lowered) {
  assert.strictEqual(joinCloudTexts(input), expected, 'lowered: ' + JSON.stringify(input));
}

const kept = [
  [['That is on a table.', 'Like the image'], 'That is on a table. Like the image'],
  [['Is it on a table?', 'Like the image'], 'Is it on a table? Like the image'],
  [['It is on a table!', 'Like the image'], 'It is on a table! Like the image'],
  [['It is on a table…', 'Like the image'], 'It is on a table… Like the image'],
  [['It is on a table...', 'Like the image'], 'It is on a table... Like the image'],
  [['He said "go away."', 'Like the image'], 'He said "go away." Like the image'],
  [['It is (on a table.)', 'Like the image'], 'It is (on a table.) Like the image'],
  [['It is on a table。', 'Like the image'], 'It is on a table。 Like the image'],
  [['and then', "I'm going"], "and then I'm going"],
  [['and then', "I'll go"], "and then I'll go"],
  [['and then', "I've gone"], "and then I've gone"],
  [['and then', 'I think so'], 'and then I think so'],
  [['we use', 'GPT for that'], 'we use GPT for that'],
  [['we use', 'iPhone for that'], 'we use iPhone for that'],
  [['we use', 'OpenAI for that'], 'we use OpenAI for that'],
  [['we use', 'OK for that'], 'we use OK for that'],
  [['print it on', 'A4 paper'], 'print it on A4 paper'],
  [['and', 'Mp3 files'], 'and Mp3 files'],
  [['I asked', 'Kunal to send it'], 'I asked Kunal to send it'],
  [['we called', 'Wes about it'], 'we called Wes about it'],
  [['we sailed with', 'Ming and the crew'], 'we sailed with Ming and the crew'],
  [['we met', "O'Brien there"], "we met O'Brien there"],
  [['a', 'No-Code tool'], 'a No-Code tool'],
  [['and then', 'Transfab is slow'], 'and then Transfab is slow'],
  [['he said', '"Like this"'], 'he said "Like this"'],
  [['I was going to —', 'Anyway, never mind.'], 'I was going to — Anyway, never mind.'],
  [['Here is the list:', 'The first one'], 'Here is the list: The first one'],
  [['मुझे लगता है', 'यह अच्छा है'], 'मुझे लगता है यह अच्छा है'],
  [['Как дела и как', 'Как раз'], 'Как дела и как Как раз'],
  [['Like this', 'one'], 'Like this one'],
];
for (const [input, expected] of kept) {
  assert.strictEqual(joinCloudTexts(input), expected, 'kept: ' + JSON.stringify(input));
}
// A word the dictation says in lowercase is ordinary even when it is not
// in the built-in list, but a capital elsewhere in a sentence keeps it a name.
assert.strictEqual(joinCloudTexts(['the pitch deck has a', 'Slide with a chart. Each slide is fine']),
  'the pitch deck has a slide with a chart. Each slide is fine', 'lowercase elsewhere makes a word ordinary');
assert.strictEqual(joinCloudTexts(['I asked Slide about the deck, and the slide is fine, and', 'Slide said yes']),
  'I asked Slide about the deck, and the slide is fine, and Slide said yes', 'a capital mid-sentence elsewhere beats lowercase elsewhere');
// A capital after a sentence end is not evidence of a name, and the join word
// is never its own evidence ("a Like" would otherwise match itself).
assert.strictEqual(joinCloudTexts(['it is on a', 'Like the image. Like it. Show me.']),
  'it is on a like the image. Like it. Show me.');
// The cut-word rejoin runs first and wins, and the join after it still works.
assert.strictEqual(joinCloudTexts(['It is on Higgs-', 'Field and it looks good so', 'The result is great']),
  'It is on Higgsfield and it looks good so the result is great');
assert.strictEqual(joinCloudTexts(['Built on Open-', 'AI and then', 'Like that']), 'Built on OpenAI and then like that');

// A listed word that starts a name keeps its capital because a capitalised
// word follows it in the same sentence (within three words). Judged alone,
// every lead word below is on the list and would be lowered.
const names = [
  [['I moved to', 'New York last year'], 'I moved to New York last year'],
  [['I read it in the', 'Times of India yesterday'], 'I read it in the Times of India yesterday'],
  [['I banked with', 'Wells Fargo for years'], 'I banked with Wells Fargo for years'],
  [['I was playing', 'Call of Duty last night'], 'I was playing Call of Duty last night'],
  [['The service is written in', 'Go and Rust'], 'The service is written in Go and Rust'],
  [['Please pay the bill and send it to', 'Bill Gates tomorrow'], 'Please pay the bill and send it to Bill Gates tomorrow'],
  [['Thanks for your help', 'Kind regards, Rhea'], 'Thanks for your help Kind regards, Rhea'],
  [['and then', 'Show the plan Rhea'], 'and then Show the plan Rhea'],
  // Accepted cost: a name close behind an ordinary word keeps that word's capital too.
  [['how', 'The script Rhea wrote'], 'how The script Rhea wrote'],
];
for (const [input, expected] of names) {
  assert.strictEqual(joinCloudTexts(input), expected, 'a name keeps its first word: ' + JSON.stringify(input));
}
// A domain-like name (a dot, then a letter) is not a sentence either.
for (const [input, expected] of [
  [['I built the site with', 'Next.js and Tailwind'], 'I built the site with Next.js and Tailwind'],
  [['I host it on', 'Go.dev and Vercel'], 'I host it on Go.dev and Vercel'],
  [['I built it with', 'Next.js'], 'I built it with Next.js'],
]) {
  assert.strictEqual(joinCloudTexts(input), expected, 'a dotted name is kept: ' + JSON.stringify(input));
}
// What does not count as a name: a capital further than three words away or in
// the next sentence, and "I" and its contractions.
for (const [input, expected] of [
  [['and then', 'Show the plan to Rhea'], 'and then show the plan to Rhea'],
  [['and then', 'Make sure I get it'], 'and then make sure I get it'],
  [['and then', "Make sure I'm there"], "and then make sure I'm there"],
  [['and then', 'Like this. Rhea said so'], 'and then like this. Rhea said so'],
]) {
  assert.strictEqual(joinCloudTexts(input), expected, 'not a name: ' + JSON.stringify(input));
}
// The list itself lowers Show and Make when nothing around them is capitalised;
// it is the capital elsewhere in the dictation that keeps them below, so the
// pair differs only by that one capital.
assert.strictEqual(joinCloudTexts(['we watched it on TV and then', 'Show the results']), 'we watched it on TV and then show the results');
assert.strictEqual(joinCloudTexts(['I told her about it and then', 'Make a plan']), 'I told her about it and then make a plan');
assert.strictEqual(joinCloudTexts(['we watched Show on TV and then', 'Show the results']),
  'we watched Show on TV and then Show the results', 'a capital mid-sentence elsewhere keeps a listed word');
assert.strictEqual(joinCloudTexts(['I told Make about it and then', 'Make a plan']),
  'I told Make about it and then Make a plan', 'a capital mid-sentence elsewhere keeps a listed word');

// A word cut in two that the speaker doubles ("Bu-" then "bu") is rejoined; a
// restart, where the next word is longer and starts with the fragment, is not.
for (const [input, expected] of [
  [['I told Bu-', 'bu about it'], 'I told Bubu about it'],
  [['I told Bu-', 'Bu about it.'], 'I told Bubu about it.'],
  [['I told Bu-', 'bu.'], 'I told Bubu.'],
  [['I work at Ta-', 'ta Motors'], 'I work at Tata Motors'],
  [['Say Da-', 'da please'], 'Say Dada please'],
  [['when it comes f-', 'For him'], 'when it comes f- for him'],
  [['It is on Hig-', 'Higgsfield now'], 'It is on Hig- Higgsfield now'],
  [['and so the th-', 'The thing is'], 'and so the th- the thing is'],
  // Known limit: these cut words look like a restart and stay apart.
  [['I ate a pa-', 'paya today'], 'I ate a pa- paya today'],
  [['I flew to Cin-', 'cinnati last week'], 'I flew to Cin- cinnati last week'],
]) {
  assert.strictEqual(joinCloudTexts(input), expected, 'cut or restarted word: ' + JSON.stringify(input));
}

// A clip whose first clause is a question keeps its capital, but only the
// first clause decides.
for (const [input, expected] of [
  [['and then', 'Is that right?'], 'and then Is that right?'],
  [['and then', 'Is that right? I think so.'], 'and then Is that right? I think so.'],
  [['and then', 'It is fine. Is that right?'], 'and then it is fine. Is that right?'],
  [['and then', 'Is that right. Maybe?'], 'and then is that right. Maybe?'],
  [['and then', 'Is that right'], 'and then is that right'],
]) {
  assert.strictEqual(joinCloudTexts(input), expected, 'question start: ' + JSON.stringify(input));
}

// A clip that follows an unclosed quote or bracket opens a clause. A closed
// one does not: the sentence just goes on.
for (const open of ['"', '“', '‘', '(', '[', '("', '(“']) {
  assert.strictEqual(joinCloudTexts(['He said ' + open, 'Then we left.']), 'He said ' + open + ' Then we left.',
    'capital kept after an open ' + open);
}
assert.strictEqual(joinCloudTexts(['I said "no"', 'Like that']), 'I said "no" like that', 'a closing straight quote is not an opener');
assert.strictEqual(joinCloudTexts(['I said (no)', 'Like that']), 'I said (no) like that', 'a closing bracket is not an opener');
assert.strictEqual(joinCloudTexts(['I said “no”', 'Like that']), 'I said “no” like that', 'closing curly quotes are not openers');

// Lowering needs a mostly English dictation. German capitalises its nouns, and
// "Kind" and "Bad" are on the English list; in English the same clip start is lowered.
assert.strictEqual(joinCloudTexts(['Ich habe gestern auf dem Spielplatz ein', 'Kind gesehen, das ganz allein war']),
  'Ich habe gestern auf dem Spielplatz ein Kind gesehen, das ganz allein war', 'a German noun keeps its capital');
assert.strictEqual(joinCloudTexts(['Wir haben im Urlaub jeden Tag ein', 'Bad genommen, weil es so heiss war']),
  'Wir haben im Urlaub jeden Tag ein Bad genommen, weil es so heiss war', 'a German noun keeps its capital');
assert.strictEqual(joinCloudTexts(['I saw a very', 'Kind person at the shop yesterday and she helped']),
  'I saw a very kind person at the shop yesterday and she helped', 'the same word in English is lowered');
// Other scripts count for nothing either way: the Latin words decide.
for (const [input, expected] of [
  [['আমি বাজারে গিয়েছিলাম', 'আর তারপর বাড়ি ফিরলাম'], 'আমি বাজারে গিয়েছিলাম আর তারপর বাড়ি ফিরলাম'],
  [['मैं कल बाज़ार गया था', 'फिर घर आ गया'], 'मैं कल बाज़ार गया था फिर घर आ गया'],
  [['আমি যাব', 'Then we left'], 'আমি যাব then we left'],
  [['लेकिन', 'Third shot is fine'], 'लेकिन third shot is fine'],
]) {
  assert.strictEqual(joinCloudTexts(input), expected, 'other scripts: ' + JSON.stringify(input));
}

// A full stop the model put at a join is removed when the sentence plainly
// goes on (temp/speed-2026-10-12/joinrule.test.js, with the chosen settings:
// the lowercase head and short word lists, no pause rule). Then the capital
// rules above decide the next word exactly as at any other join.
const HINDI = { hindi: true };
for (const [input, expected, why, options] of [
  [['I left it on the.', 'Table near the door.'], 'I left it on the Table near the door.',
    'a never-final word loses the stop; with no evidence the capital stays (it could be a name)'],
  [['The table is big. I left it on the.', 'Table near the door.'], 'The table is big. I left it on the table near the door.',
    'and is lowered when the dictation says the word in lowercase elsewhere'],
  [['I sent it to Rhea and.', 'Kunal said yes.'], 'I sent it to Rhea and Kunal said yes.', 'a name after "and." keeps its capital'],
  [['It is a lot bigger.', 'Than the old one.'], 'It is a lot bigger than the old one.', 'a continuation head ("than")'],
  [['I think we should.', 'go there now.'], 'I think we should go there now.', 'the model wrote the next piece in lowercase'],
  [['I think we should.', 'Go there now.'], 'I think we should. Go there now.', 'no pause rule: an ordinary capital after a stop is a new sentence'],
  [['Yesterday I met.', 'Rhea at the office.'], 'Yesterday I met. Rhea at the office.', 'nor before a possible name'],
  [['Put it in the.', 'Box.'], 'Put it in the Box.', 'the lists work without any pause data'],
  [['I bought a new one.', 'iPhone sales were up.'], 'I bought a new one. iPhone sales were up.', 'a lowercase word with a capital in it is a name'],
  [['So we start now.', 'then we go on.', 'and then we rest.'], 'So we start now then we go on and then we rest.', 'every join is judged'],
  // Real sentence ends the word lists must not take (the reviewer's cases).
  [['I will see you tomorrow.', 'Of course, it depends on the weather.'], 'I will see you tomorrow. Of course, it depends on the weather.',
    '"Of course" opens a sentence'],
  [['Just because.', 'Then I left the room.'], 'Just because. Then I left the room.', 'a two-word piece is a whole sentence'],
  [['Oh my.', 'That is a lot of money.'], 'Oh my. That is a lot of money.', 'so is "Oh my."'],
  [['Oh my.', 'that is a lot of money.'], 'Oh my that is a lot of money.', 'but a lowercase head still joins a short piece'],
  [['I really did want to.', 'So I did it anyway.'], 'I really did want to. So I did it anyway.', 'a stranded preposition ends a sentence'],
  [['That is what I was afraid of.', 'Anyway we moved on.'], 'That is what I was afraid of. Anyway we moved on.', 'and so does "of"'],
  [['It all happened because of my.', 'Brother and his car.'], 'It all happened because of my. Brother and his car.', 'a possessive is not on the list'],
  [['Is that right?', 'go there now.'], 'Is that right? go there now.', 'a question is kept'],
  [['Wow!', 'go there now.'], 'Wow! go there now.', 'an exclamation is kept'],
  [['So my...', 'so what I think is fine.'], 'So my... so what I think is fine.', 'an ellipsis is kept'],
  [['So my…', 'so what I think is fine.'], 'So my… so what I think is fine.', 'a single-character ellipsis too'],
  [['He said "stop."', 'then we left.'], 'He said "stop." then we left.', 'a stop inside a closing quote is kept'],
  [['It is (on a table.)', 'then we left.'], 'It is (on a table.) then we left.', 'and inside a closing bracket'],
  [['I spoke to Mr.', 'Sharma about it.'], 'I spoke to Mr. Sharma about it.', 'an abbreviation is kept'],
  [['I spoke to the Dr.', 'the surgeon.'], 'I spoke to the Dr. the surgeon.', 'even before a lowercase word'],
  [['We moved to the U.S.', 'Then it got busy.'], 'We moved to the U.S. Then it got busy.', 'and dotted initials'],
  [['Things like e.g.', 'the other one.'], 'Things like e.g. the other one.', 'and e.g.'],
  [['I met John J.', 'then left.'], 'I met John J. then left.', 'and a single initial'],
  [['The version is 2.', '5 now.'], 'The version is 2. 5 now.', 'a number then a number is a decimal'],
  [['It is called Higgs-.', 'field now.'], 'It is called Higgsfield now.', 'the cut-word marker is the rejoin\'s'],
  [['Ya terminamos el trabajo.', 'Entonces vamos a casa.'], 'Ya terminamos el trabajo. Entonces vamos a casa.', 'Spanish: a capital after a stop is kept'],
  [['Ya terminamos el.', 'trabajo de hoy.'], 'Ya terminamos el trabajo de hoy.', 'and a lowercase head joins in any language'],
  // Romance and Turkish dictations keep their stops, even for a user who also dictates Hinglish.
  [['Llegó tarde a la reunión.', 'Se fue a casa temprano.'], 'Llegó tarde a la reunión. Se fue a casa temprano.', 'es: "Se" opens a sentence', HINDI],
  [['Vamos a terminar esto ya.', 'Después hablamos.'], 'Vamos a terminar esto ya. Después hablamos.', 'es: "ya" ends one', HINDI],
  [['Ti aiuto con il progetto.', 'Se vuoi possiamo iniziare domani.'], 'Ti aiuto con il progetto. Se vuoi possiamo iniziare domani.', 'it: "Se vuoi"', HINDI],
  [['Eu posso te ajudar amanhã.', 'Se puder me liga depois.'], 'Eu posso te ajudar amanhã. Se puder me liga depois.', 'pt: "Se puder"', HINDI],
  [['Tout va bien se passer.', 'Ne t\'inquiète pas trop.'], 'Tout va bien se passer. Ne t\'inquiète pas trop.', 'fr: "Ne t\'inquiète pas"', HINDI],
  [['Il y a plusieurs options.', 'Par exemple la première.'], 'Il y a plusieurs options. Par exemple la première.', 'fr: "Par exemple"', HINDI],
  [['Bunu yarın konuşalım mı ne.', 'Ne zaman müsaitsin?'], 'Bunu yarın konuşalım mı ne. Ne zaman müsaitsin?', 'tr: "ne"', HINDI],
  [['Toplantıya geç kaldım ama.', 'Ya sen neredeydin?'], 'Toplantıya geç kaldım ama. Ya sen neredeydin?', 'tr: "Ya"', HINDI],
  // Hindi: only for a user who dictates it, and only the danda lists.
  [['मैंने सोचा कि।', 'मैं कल आऊँगा।'], 'मैंने सोचा कि मैं कल आऊँगा।', 'a danda after कि goes', HINDI],
  [['मैंने सोचा कि।', 'मैं कल आऊँगा।'], 'मैंने सोचा कि। मैं कल आऊँगा।', 'not for a user who does not dictate Hindi'],
  [['मैं घर गया।', 'फिर खाना खाया।'], 'मैं घर गया। फिर खाना खाया।', 'a danda after a verb is kept', HINDI],
  [['मैं अपने घर।', 'को जा रहा हूँ।'], 'मैं अपने घर को जा रहा हूँ।', 'a danda before a postposition goes', HINDI],
  [['मैंने सोचा कि.', 'मैं कल आऊँगा.'], 'मैंने सोचा कि मैं कल आऊँगा.', 'a full stop between Devanagari words uses the Hindi lists', HINDI],
  // Hinglish: a Hinglish user, a dictation not mostly English, and Hinglish words in it.
  [['Maine khana khaya aur.', 'Main so gaya tha.'], 'Maine khana khaya aur main so gaya tha.', 'a stop after "aur" goes and "Main" is lowered here', HINDI],
  [['Maine khana khaya aur.', 'Main so gaya tha.'], 'Maine khana khaya aur. Main so gaya tha.', 'not for a user who does not dictate Hinglish'],
  [['Mujhe lagta hai ki yeh.', 'Mein bhi chahta hoon.'], 'Mujhe lagta hai ki yeh mein bhi chahta hoon.', 'a Hinglish continuation head', HINDI],
  [['Maine socha ki.', 'Main kal aaunga, yeh bhi.'], 'Maine socha ki. Main kal aaunga, yeh bhi.', '"ki" may end a sentence ("did"), so its stop is kept', HINDI],
  [['Maine usse baat ki.', 'Phir ghar gaya tha.'], 'Maine usse baat ki. Phir ghar gaya tha.', 'as in "baat ki."', HINDI],
  [['Maine kal kaam kiya.', 'Phir ghar gaya tha.'], 'Maine kal kaam kiya. Phir ghar gaya tha.', 'a stop after a verb is kept', HINDI],
  [['I went to the market aur.', 'Then I came home and it was fine.'], 'I went to the market aur. Then I came home and it was fine.',
    'an English dictation does not use the Hinglish lists', HINDI],
]) {
  assert.strictEqual(joinCloudTexts(input, options), expected, 'join stop: ' + why + ' ' + JSON.stringify(input));
}
// The rule needs a stop at a join: the last piece keeps its own.
assert.strictEqual(joinCloudTexts(['I left it on the.']), 'I left it on the.');
assert.strictEqual(joinCloudTexts(['I went home and', 'then I left it on the.']), 'I went home and then I left it on the.');
// Only the end of a piece is read: a long unspaced run stays fast.
{
  const cjk = 'one two ' + '我'.repeat(20000) + '.';
  const started = process.hrtime.bigint();
  assert.strictEqual(joinCloudTexts([cjk, 'next words here']), cjk.slice(0, -1) + ' next words here');
  assert(Number(process.hrtime.bigint() - started) / 1e6 < 200, 'a 20,000-character unspaced piece joins in well under 200 ms');
}

// AssemblyAI marks a restarted word with an em dash where MAI uses a hyphen.
// The dash stays, and the word after it is judged like any join; a dash after
// a whole word, or a word the next piece does not restart, is a clause break.
for (const [input, expected, why] of [
  [['We need the lang—', 'language settings fixed.'], 'We need the lang— language settings fixed.', 'a restart stays as said'],
  [['We should cha—', 'Change the plan.'], 'We should cha— change the plan.', 'and an ordinary word after it is lowered'],
  [['We need the lang—', 'Language settings fixed.'], 'We need the lang— Language settings fixed.', 'a word that is not provably ordinary keeps its capital'],
  [['The language is fine but the lang—', 'Language menu is not.'], 'The language is fine but the lang— language menu is not.',
    'unless the dictation says it in lowercase elsewhere'],
  [['I asked Ku—', 'Kunal to send it'], 'I asked Ku— Kunal to send it', 'a stuttered name keeps its capital'],
  [['I was going to—', 'Actually, never mind.'], 'I was going to— Actually, never mind.', 'a clause break keeps its capital'],
  [['I was going to—', 'Today we start.'], 'I was going to— Today we start.', 'a whole ordinary word before the dash is a clause break'],
  [['I—', 'Instead we went home.'], 'I— Instead we went home.', 'and so is a single letter'],
  [['We need the lang —', 'Language settings.'], 'We need the lang — Language settings.', 'a dash that stands alone is punctuation'],
]) {
  assert.strictEqual(joinCloudTexts(input), expected, 'em-dash: ' + why + ' ' + JSON.stringify(input));
}

console.log('ok cloud segments: natural pauses, full speech context, exact sample coverage, reusable buffers, browser API');

async function testQueue() {
  const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
  let clock = 100;
  const queue = createCloudQueue({ now: () => clock });
  const started = [], complete = [];
  const jobs = [0, 1, 2, 3].map(index => queue.enqueue(() => {
    started.push(index);
    return new Promise(resolve => { complete[index] = resolve; });
  }));
  await settle();
  assert.deepStrictEqual(started, [0, 1], 'the default runs two at once');
  clock = 140;
  complete[1]('second');
  await settle();
  assert.deepStrictEqual(started, [0, 1, 2], 'finishing either slot starts the oldest waiting job');
  clock = 175;
  complete[2]('third');
  await settle();
  assert.deepStrictEqual(started, [0, 1, 2, 3]);
  clock = 200;
  complete[3]('fourth');
  complete[0]('first');
  assert.deepStrictEqual(await Promise.all(jobs), [
    { value: 'first', queueMs: 0, requestMs: 100 },
    { value: 'second', queueMs: 0, requestMs: 40 },
    { value: 'third', queueMs: 40, requestMs: 35 },
    { value: 'fourth', queueMs: 75, requestMs: 25 },
  ], 'ordered consumer results distinguish queue delay from provider time');

  for (const cancel of [false, true]) {
    const q = createCloudQueue({ concurrency: 1 });
    const reason = new Error(cancel ? 'cancelled by user' : 'provider unavailable');
    let fail, finish, calls = 0;
    const active = q.enqueue(() => new Promise((resolve, reject) => { calls++; finish = resolve; fail = reject; }));
    const waiting = q.enqueue(() => { calls++; return 'must never start'; });
    const results = Promise.allSettled([active, waiting]);
    await settle();
    if (cancel) { q.cancel(reason); finish('already sent'); } else fail(reason);
    const settled = await results;
    assert.strictEqual(calls, 1, 'cancel/failure never dispatches queued paid work');
    assert.strictEqual(settled[1].reason, reason, 'queued work receives the original failure');
    assert.strictEqual(settled[0].status, cancel ? 'fulfilled' : 'rejected');
    await assert.rejects(q.enqueue(() => { calls++; }), error => error === reason);
    assert.strictEqual(calls, 1, 'a failed queue refuses future work too');
  }
  const synchronous = createCloudQueue();
  await assert.rejects(synchronous.enqueue(() => { throw new Error('synchronous failure'); }), /synchronous failure/);
  assert.strictEqual(typeof browser.voxdenCloudSegments.createCloudQueue, 'function');

  // A relay that runs lanes allows up to four pieces at once, never more.
  for (const [concurrency, expected] of [[99, 4], [4, 4], [3, 3], [1, 1], [0, 1], [NaN, 1]]) {
    const q = createCloudQueue({ concurrency });
    let running = 0;
    for (let i = 0; i < 6; i++) q.enqueue(() => { running++; return new Promise(() => {}); });
    await settle();
    assert.strictEqual(running, expected, 'concurrency ' + concurrency + ' runs ' + expected + ' at once');
  }

  // The last piece at stop never waits behind the others, and release()
  // starts every piece still waiting. Results stay with their own callers.
  {
    let clock = 0;
    const q = createCloudQueue({ concurrency: 1, now: () => clock });
    const started = [], complete = {};
    const job = name => () => { started.push(name); return new Promise(resolve => { complete[name] = resolve; }); };
    const a = q.enqueue(job('a'));
    const b = q.enqueue(job('b'));
    const c = q.enqueue(job('c'));
    await settle();
    assert.deepStrictEqual(started, ['a'], 'one at a time');
    clock = 10;
    const tail = q.enqueue(job('tail'), { now: true });
    await settle();
    assert.deepStrictEqual(started, ['a', 'tail'], 'a piece enqueued with now starts while the queue is full');
    clock = 30;
    complete.tail('last words');
    assert.deepStrictEqual(await tail, { value: 'last words', queueMs: 0, requestMs: 20 }, 'and answers on its own');
    await settle();
    assert.deepStrictEqual(started, ['a', 'tail'], 'its slot is not taken from the waiting pieces: a still holds the one slot');
    clock = 40;
    q.release();
    await settle();
    assert.deepStrictEqual(started, ['a', 'tail', 'b', 'c'], 'release starts every waiting piece in order');
    const late = q.enqueue(job('late'));
    await settle();
    assert.deepStrictEqual(started, ['a', 'tail', 'b', 'c', 'late'], 'and after release nothing waits');
    clock = 50;
    complete.c('three'); complete.b('two'); complete.a('one'); complete.late('four');
    assert.deepStrictEqual((await Promise.all([a, b, c, late])).map(r => [r.value, r.queueMs]),
      [['one', 0], ['two', 40], ['three', 40], ['four', 0]], 'each caller gets its own answer and its real wait');
  }
  {
    // What goes up at and after stop shares the relay's tail pool: at most
    // four at once, the now piece included; body pieces already out do not count.
    const q = createCloudQueue({ concurrency: 2 });
    const running = new Set(), finish = {};
    let peakTail = 0;
    const job = (name, tail) => () => {
      running.add(name);
      if (tail) peakTail = Math.max(peakTail, [...running].filter(n => n !== 'b0' && n !== 'b1').length);
      return new Promise(resolve => { finish[name] = () => { running.delete(name); resolve(name); }; });
    };
    const all = [q.enqueue(job('b0')), q.enqueue(job('b1'))];
    for (let i = 2; i < 9; i++) all.push(q.enqueue(job('p' + i, true)));
    await settle();
    assert.deepStrictEqual([...running], ['b0', 'b1'], 'two body pieces out, seven waiting');
    all.push(q.enqueue(job('tail', true), { now: true }));
    q.release();
    await settle();
    assert.deepStrictEqual([...running], ['b0', 'b1', 'tail', 'p2', 'p3', 'p4'], 'the tail and three released pieces: four on the tail pool');
    finish.b0();
    await settle();
    assert.strictEqual(running.size, 5, 'a body piece finishing frees no tail slot');
    finish.tail();
    await settle();
    assert(running.has('p5') && !running.has('p6'), 'a tail piece finishing starts the next');
    while (running.size) {
      for (const name of [...running]) finish[name]();
      await settle();
    }
    assert.strictEqual((await Promise.all(all)).length, 10, 'every piece answers');
    assert.strictEqual(peakTail, 4, 'never more than four on the tail pool');
    const capped = createCloudQueue({ concurrency: 1, tailConcurrency: 9 });
    let tails = 0;
    capped.enqueue(() => new Promise(() => {}));
    for (let i = 0; i < 6; i++) capped.enqueue(() => { tails++; return new Promise(() => {}); });
    capped.release();
    await settle();
    assert.strictEqual(tails, 4, 'the tail limit is capped at four too');
  }
  {
    const q = createCloudQueue({ concurrency: 1 });
    let calls = 0;
    const reason = new Error('provider unavailable');
    const first = q.enqueue(() => { calls++; return Promise.reject(reason); });
    await assert.rejects(first, error => error === reason);
    await assert.rejects(q.enqueue(() => { calls++; }, { now: true }), error => error === reason);
    q.release();
    assert.strictEqual(calls, 1, 'a failed queue starts nothing, now or released');
  }
  {
    const q = createCloudQueue({ concurrency: 1 });
    let calls = 0;
    q.enqueue(() => { calls++; return new Promise(() => {}); });
    const waiting = q.enqueue(() => { calls++; });
    q.cancel(new Error('Dictation cancelled.'));
    q.release();
    await assert.rejects(waiting, /cancelled/);
    await settle();
    assert.strictEqual(calls, 1, 'a cancelled piece is never released');
  }
  console.log('ok cloud queue: concurrency bound, FIFO dispatch, reverse completion, exact timing, failures and cancellation, now and release');
}
testQueue().catch(error => { console.error(error); process.exitCode = 1; });
