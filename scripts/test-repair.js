'use strict';

// Acoustic recognition repair.
//
// The whole risk of this stage is one sentence: "I said 'his field' and it
// typed 'Higgsfield'." The negative set below is therefore longer than the
// positive one, and it is the part that must never be relaxed to make a
// positive case pass.
//
// Every sentence in NEVER_TOUCH was produced by a version of this code that
// broke it, or by the dictionary that came before it. They are kept as
// literals rather than generated, because the point is that these exact
// English sentences survive contact with a dictionary full of terms that sound
// like their words.

const assert = require('assert');
const repair = require('../src/repair');
const vocab = require('../src/vocabulary');

let checks = 0;
function ok(label, value) {
  assert.ok(value, label);
  checks += 1;
  process.stdout.write('ok ' + label + '\n');
}
function eq(label, actual, expected) {
  assert.deepStrictEqual(actual, expected, label + '\n  got: ' + JSON.stringify(actual));
  checks += 1;
  process.stdout.write('ok ' + label + '\n');
}

// A dictionary of exactly the terms that collide with ordinary English.
const TERMS = [
  'LoRA', 'Soul Character', 'Anthropic', 'SixtyFPS', 'Higgsfield', 'Kling',
  'ScriptUI', 'Hailuo', 'Seedance 2', 'Voxden', 'Kharagpur', 'ONNX',
  'JSON payload', 'Jimeng', 'Bhubaneswar',
];
const entries = TERMS.map((t) => vocab.makeEntry(t));

function repaired(text, options) {
  return repair.repairTranscript(text, entries, Object.assign({ language: 'en' }, options || {}));
}

// --- 1. Ordinary speech is never rewritten ---------------------------------

const NEVER_TOUCH = [
  // Each of these was broken by a real rule or a real threshold.
  'Laura called me this morning',
  'the sole character in the play',
  'an entropic system loses order',
  'it runs at sixty frames per second',
  'he is a leader in his field',
  'they played in a big field',
  'lower a flag to half mast',
  'a single owner vehicle',
  'the timing was perfect',
  'just happened to be there',
  'I am saying it again',
  'cling film over the bowl',
  'hail damage on the roof',
  'the script was hard to read',
  'please see the attached document',
  'I need to get two of those',
  'the service was slow today',
  'she brought a bouquet of roses',
  'I will get the file later',
  'the owner of the studio',
  'can we increase the transcription timing',
  'update the gate at the back of the house',
  'she is a prompt and careful worker',
  'the paid ones. So it is not that accurate',
  'we sorted the sequence by name',
  'the json file is in the folder',
  'a clean shot of the sole of the shoe',
];
for (const sentence of NEVER_TOUCH) {
  eq('untouched: ' + sentence, repaired(sentence).text, sentence);
}

// The same sentences with a boundary the window could straddle.
eq('a span may not be assembled across a full stop',
  repaired('I am not using the paid ones. So it is fine').text,
  'I am not using the paid ones. So it is fine');
eq('nor across a comma',
  repaired('after the ones, so we moved on').text,
  'after the ones, so we moved on');
ok('the boundary check sees punctuation between tokens',
  repair.crossesBoundary('ones. So', [{ start: 0, end: 4 }, { start: 6, end: 8 }]));
ok('and not a plain space',
  !repair.crossesBoundary('ones so', [{ start: 0, end: 4 }, { start: 5, end: 7 }]));

// --- 2. Inflections count as ordinary words --------------------------------
for (const word of ['timing', 'saying', 'happened', 'running', 'carries', 'owners', 'quickly']) {
  ok('"' + word + '" reads as ordinary English', repair.isEverydayWord(word));
}
for (const word of ['seedance', 'voxden', 'kharagpur', 'onnx']) {
  ok('"' + word + '" does not', !repair.isEverydayWord(word));
}

// --- 3. What repair is allowed to fix --------------------------------------
//
// Only two things license a rewrite without a user in the loop: the letters
// are identical and only the spacing moved, or the decoder itself said it was
// unsure of that span.

eq('a spacing-only mishearing is repaired',
  repaired('i used seedance2 today').text, 'i used Seedance 2 today');
eq('and so is one with punctuation in the way',
  repaired('open vox-den now').text, 'open Voxden now');
eq('a phonetic mishearing is NOT repaired on its own',
  repaired('i visited karagpur last year').text, 'i visited karagpur last year');
ok('but it is reported as worth rechecking',
  repaired('i visited karagpur last year').escalate.some((e) => e.term === 'Kharagpur'));

// With the decoder's own uncertainty, the same span is repaired.
const uncertain = repaired('i visited karagpur last year', {
  segments: [{ text: 'i visited karagpur last year', logprob: -1.2 }],
});
eq('a span the engine doubted is repaired', uncertain.text, 'i visited Kharagpur last year');

// And an engine that reports confidence for a span it was sure about does not
// license the rewrite.
const confident = repaired('i visited karagpur last year', { segments: [] });
eq('an engine that reported no doubt gets no repair',
  confident.text, 'i visited karagpur last year');
eq('and with no doubt to act on, nothing is escalated either',
  confident.escalate.length, 0);

// The badly mangled proper noun, which is the case the phonetic rule exists
// for -- still only with uncertainty behind it.
eq('a mangled name is repaired when the decoder was unsure',
  repaired('ping bubba neshwar now', {
    segments: [{ text: 'ping bubba neshwar now', logprob: -1.0 }],
  }).text,
  'ping Bhubaneswar now');

// --- 4. Terms that are ordinary words are never guessed at -----------------
//
// Somebody may legitimately add "Owner" or "Service" to their dictionary --
// they are product names somewhere. What must not happen is a phonetic guess
// landing on one, because a guess at an everyday word cannot be told apart
// from a wrong one.
const commonTerms = [vocab.makeEntry('Owner'), vocab.makeEntry('Service')];
for (const entry of commonTerms) {
  ok('"' + entry.canonical + '" is not reachable by guessing', !repair.isRepairable(entry));
}
eq('so a sentence using those words is left alone',
  repair.repairTranscript('the owner called the service', commonTerms, { language: 'en' }).text,
  'the owner called the service');
eq('even when the decoder was unsure of the span',
  repair.repairTranscript('the ohner called the servis', commonTerms, {
    language: 'en',
    segments: [{ text: 'the ohner called the servis', logprob: -1.4 }],
  }).text,
  'the ohner called the servis');

// --- 5. Scoring -------------------------------------------------------------
eq('identical letters, different spacing, is the strongest evidence',
  repair.scoreMatch('seedance2', 'Seedance 2').reason, 'spacing');
eq('and it outranks a homophone when both match',
  repair.betterMatch(
    { confidence: repair.CONFIDENCE.strong, reason: 'spacing' },
    { confidence: repair.CONFIDENCE.strong, reason: 'homophone' }
  ), true);
eq('a word that is already correct scores nothing',
  repair.scoreMatch('Voxden', 'Voxden').confidence, repair.CONFIDENCE.none);
eq('two different scripts are not a mishearing',
  repair.scoreMatch('नमस्ते', 'Namaste').confidence, repair.CONFIDENCE.none);

// --- 6. Non-Latin repair ----------------------------------------------------
const devanagari = [vocab.makeEntry('नमस्ते', { language: 'hi' })];
const hindiClose = repair.repairTranscript('मैं नमस्ते बोलता', devanagari, { language: 'hi' });
eq('a correct Devanagari term is left alone', hindiClose.text, 'मैं नमस्ते बोलता');
const hindiFar = repair.repairTranscript('मैं कुत्ता बोलता', devanagari, { language: 'hi' });
eq('an unrelated Devanagari word is not replaced', hindiFar.text, 'मैं कुत्ता बोलता');

// --- 7. Language scoping ----------------------------------------------------
const bilingual = [
  vocab.makeEntry('नमस्ते', { language: 'hi' }),
  vocab.makeEntry('Kharagpur'),
];
const englishRun = repair.repairTranscript('i visited karagpur', bilingual, {
  language: 'en',
  segments: [{ text: 'i visited karagpur', logprob: -1.1 }],
});
eq('an English dictation still uses its Latin terms', englishRun.text, 'i visited Kharagpur');

// --- 8. Structure -----------------------------------------------------------
eq('empty input is safe', repair.repairTranscript('', entries).text, '');
eq('an empty dictionary is safe', repair.repairTranscript('hello there', []).text, 'hello there');
ok('every decision is reported, applied or not',
  repaired('i visited karagpur last year').considered.length > 0);
ok('a repair records what it heard and what it wrote',
  repaired('i used seedance2 today').repairs.every(
    (r) => r.heard && r.term && r.reason && typeof r.applied === 'boolean'
  ));

// --- 9. The aggressive policy exists only for measurement -------------------
// It is what the safe policy is measured against; it must never be the default.
const aggressive = repaired('Laura called me this morning', { policy: 'aggressive' });
ok('the aggressive policy would break ordinary speech', aggressive.text !== 'Laura called me this morning');
eq('which is why the default does not use it',
  repaired('Laura called me this morning').text, 'Laura called me this morning');

process.stdout.write('all ' + checks + ' repair checks passed\n');
