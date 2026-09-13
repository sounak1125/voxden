'use strict';

const assert = require('assert');
const { cleanup, dedupeRepeats } = require('../src/cleanup');
const {
  classifyTarget,
  applyStyle,
  applyStyleWithTone,
  applyFormal,
  applyVeryCasual,
  stripFillers,
  normalizeWritingStyles,
  isFastDictationTarget,
  dictationPath,
} = require('../src/style');

function pipeline(raw, tone) {
  const cleaned = cleanup(raw);
  const deduped = dedupeRepeats(cleaned);
  return applyStyleWithTone(deduped, tone);
}

const classifyCases = [
  ['WhatsApp.exe', 'Chat', 'personal'],
  ['Discord.exe', 'general', 'personal'],
  ['Slack.exe', 'project-updates', 'work'],
  ['OUTLOOK.EXE', 'Inbox', 'email'],
  ['chrome.exe', 'Gmail - Inbox', 'email'],
  ['chrome.exe', 'LinkedIn', 'work'],
  ['chrome.exe', 'ChatGPT', 'other'],
  ['Code.exe', 'main.js - Visual Studio Code', 'other'],
  ['notepad.exe', 'notes.txt', 'other'],
];

const styleCases = [
  ['Hey yeah I do not wanna go', 'formal', 'personal', 'Hello, yes I do not want to go.'],
  ['Hey yeah I do not wanna go', 'veryCasual', 'personal', "hey yeah I don't wanna go"],
  ['Hello there.', 'casual', 'work', 'Hi there.'],
];

const pipelineCases = [
  // Without punctuation, "you know" is ambiguous and the deterministic
  // fallback preserves it for the sentence-aware model to decide.
  ['um you know I think we should go', 'formal', 'You know I think we should go.'],
  ['um you know I think we should go', 'casual', 'You know I think we should go'],
  ['um, you know, I think we should go', 'formal', 'I think we should go.'],
  ['I was, you know, thinking we should leave', 'formal', 'I was thinking we should leave.'],
  ['We should, I mean, probably leave', 'formal', 'We should probably leave.'],
  ['Um, I think we should go', 'casual', 'I think we should go'],
  ['um yeah hello hello world', 'casual', 'Yeah hello world'],
  ['hello hello hello world', 'casual', 'Hi world'],
  ['yeah yeah yeah I am going', 'veryCasual', "yeah I'm going"],
  ['UM hey there.', 'veryCasual', 'hey there'],
  ["um, you know, I don't wanna go", 'formal', 'I do not want to go.'],
  ['Do you know the answer?', 'formal', 'Do you know the answer?'],
  ['I like this design.', 'formal', 'I like this design.'],
  ['What kind of music do you like?', 'formal', 'What kind of music do you like?'],
  // An aside is filler whatever the tone: a casual message is a short
  // message, not a less tidy one.
  ['I was, you know, thinking we should leave', 'casual', 'I was thinking we should leave'],
  ['I was, you know, thinking we should leave', 'veryCasual', 'I was thinking we should leave'],
  ['It was, like, huge.', 'casual', 'It was huge.'],
  // A run of markers shares its commas, so the run matches as one piece.
  // Phrase-at-a-time removal left the last of them stranded as "thing like,".
  ['this thing, I mean, like, can you help', 'formal', 'This thing can you help.'],
  // Only a comma makes an opening "So" a throat-clear. Without one it is the
  // sentence, and dropping it used to leave "Far, I am enjoying this."
  ['So, I was thinking we should go.', 'formal', 'I was thinking we should go.'],
  ['So far, I am enjoying this.', 'formal', 'So far, I am enjoying this.'],
  ['So far, I am enjoying this.', 'casual', "So far, I'm enjoying this."],
  ['So long as it holds, we are fine.', 'formal', 'So long as it holds, we are fine.'],
];

let failed = 0;

for (const [exe, title, expected] of classifyCases) {
  const got = classifyTarget(exe, title);
  if (got !== expected) {
    failed += 1;
    console.error('classify FAIL', exe, title, 'expected', expected, 'got', got);
  } else {
    console.log('classify ok', exe, '->', got);
  }
}

for (const [input, tone, cat, expected] of styleCases) {
  const got = applyStyle(input, cat, { [cat]: tone });
  if (got !== expected) {
    failed += 1;
    console.error('style FAIL', JSON.stringify(input), tone, cat);
    console.error('  expected', JSON.stringify(expected));
    console.error('  got     ', JSON.stringify(got));
  } else {
    console.log('style ok', tone, '->', JSON.stringify(got));
  }
}

for (const [input, tone, expected] of pipelineCases) {
  const got = pipeline(input, tone);
  if (got !== expected) {
    failed += 1;
    console.error('pipeline FAIL', JSON.stringify(input), tone);
    console.error('  expected', JSON.stringify(expected));
    console.error('  got     ', JSON.stringify(got));
  } else {
    console.log('pipeline ok', tone, '->', JSON.stringify(got));
  }
}

const normalized = normalizeWritingStyles({ personal: 'nope', work: 'formal' });
if (normalized.personal !== 'veryCasual' || normalized.work !== 'formal') {
  failed += 1;
  console.error('normalize FAIL', normalized);
}

if (applyFormal('Thanks') !== 'Thank you.') {
  failed += 1;
  console.error('formal punct FAIL');
}

if (applyVeryCasual('Hello World.') !== 'hey World') {
  failed += 1;
  console.error('very casual FAIL', applyVeryCasual('Hello World.'));
}

if (stripFillers('Um you know hello', 'casual') !== 'you know hello') {
  failed += 1;
  console.error('casual filler FAIL', stripFillers('Um you know hello', 'casual'));
}

if (stripFillers('Um you know hello', 'formal') !== 'you know hello') {
  failed += 1;
  console.error('formal filler FAIL', stripFillers('Um you know hello', 'formal'));
}

if (stripFillers('I was, you know, thinking', 'formal') !== 'I was thinking') {
  failed += 1;
  console.error('formal aside FAIL', stripFillers('I was, you know, thinking', 'formal'));
}

const pathCases = [
  ['Slack.exe', 'project-updates', 'auto', 'fast'],
  ['Discord.exe', 'general', 'auto', 'fast'],
  ['ChatGPT.exe', 'ChatGPT', 'auto', 'fast'],
  ['Cursor.exe', 'Cursor Agents', 'auto', 'fast'],
  ['OUTLOOK.EXE', 'Inbox', 'auto', 'accurate'],
  ['chrome.exe', 'Gmail - Inbox', 'auto', 'accurate'],
  ['Code.exe', 'main.js - Visual Studio Code', 'auto', 'accurate'],
  ['Slack.exe', 'project-updates', 'accurate', 'accurate'],
  ['OUTLOOK.EXE', 'Inbox', 'fast', 'fast'],
];
for (const [exe, title, quality, expected] of pathCases) {
  const cat = classifyTarget(exe, title);
  const got = dictationPath(cat, { dictationQuality: quality }, { exe, title });
  if (got !== expected) {
    failed += 1;
    console.error('path FAIL', exe, title, quality, 'expected', expected, 'got', got);
  } else {
    console.log('path ok', exe, quality, '->', got);
  }
}
if (dictationPath('other', { dictationQuality: 'auto' }, { exe: 'ChatGPT.exe', title: 'ChatGPT' }, 9000) !== 'accurate') {
  failed += 1;
  console.error('long auto dictation must use the accurate path');
}
if (dictationPath('other', { dictationQuality: 'fast' }, { exe: 'ChatGPT.exe', title: 'ChatGPT' }, 9000) !== 'fast') {
  failed += 1;
  console.error('explicit fast must override duration routing');
}
if (!isFastDictationTarget({ exe: 'ChatGPT.exe', title: 'ChatGPT' })) {
  failed += 1;
  console.error('AI chat fast-target detection FAIL');
}

// The same thought must differ in wording, not just capitalization/punctuation.
const toneExamples = [
  ['Could you please send the notes when you are ready?', [
    'Could you please send the notes when you are ready?',
    "Could you send the notes when you're ready?",
    "can you send the notes when you're ready?",
  ]],
  ['Hello, I am going to send the notes when we are done. Thank you.', [
    'Hello, I am going to send the notes when we are done. Thank you.',
    "Hi, I'm going to send the notes when we're done. Thanks.",
    "hey, I'm gonna send the notes when we're done. thanks",
  ]],
  ['Please let me know if you want to join. I cannot stay.', [
    'Please let me know if you want to join. I cannot stay.',
    "Let me know if you want to join. I can't stay.",
    "let me know if you wanna join. I can't stay",
  ]],
  ["Hey, I’m gonna call Alex on Monday. Thanks!", [
    'Hello, I am going to call Alex on Monday. Thank you!',
    'Hi, I’m going to call Alex on Monday. Thanks!',
    'hey, I’m gonna call Alex on Monday. thanks!',
  ]],
];
for (const [input, expected] of toneExamples) {
  for (const [i, tone] of ['formal', 'casual', 'veryCasual'].entries()) {
    const result = applyStyleWithTone(input, tone);
    assert.strictEqual(result, expected[i], tone + ': ' + input);
    assert.strictEqual(applyStyleWithTone(result, tone), result, 'styling stays stable');
  }
  assert.strictEqual(new Set(expected.map(s => s.toLowerCase().replace(/[^a-z ]/g, ''))).size, 3);
}

for (const tone of ['formal', 'casual', 'veryCasual']) {
  const result = applyStyleWithTone('Alex uses iPhone and NASA on Monday. Visit https://Example.com/Case?Id=2 or Test@Example.com, version 1.0.16. Say "I am gonna go" or `I am ready`. Open C:\\Users\\Alex\\Notes.txt', tone);
  for (const token of ['Alex', 'iPhone', 'NASA', 'Monday', 'https://Example.com/Case?Id=2', 'Test@Example.com', '1.0.16', '"I am gonna go"', '`I am ready`', 'C:\\Users\\Alex\\Notes.txt']) {
    assert(result.includes(token), tone + ' preserves ' + token + ': ' + result);
  }
  assert(applyStyleWithTone('Hello from He Is We and Hi Team.', tone, 'en', ['He Is We', 'Hi Team']).includes('He Is We and Hi Team'));
  assert.strictEqual(applyStyleWithTone('Er ist hier.', tone, 'de'), 'Er ist hier.');
  assert.strictEqual(applyStyleWithTone('', tone), '');
  assert(applyStyleWithTone('First line.\n\nSecond line?', tone).includes('\n\n'));
  for (const input of ["I'd already finished.", "It's been a long day.", 'I like this kind of music.', 'Thanks to Alex, we finished.', 'Really?!', 'Wait...']) {
    const result = applyStyleWithTone(input, tone);
    assert.strictEqual(result.replace(/[.!?]+$/, '').toLowerCase(), input.replace(/[.!?]+$/, '').toLowerCase(), input);
  }
}
assert.strictEqual(applyStyleWithTone('I am going to London.', 'veryCasual'), "I'm going to London");
assert.strictEqual(applyStyleWithTone('I am going to work.', 'veryCasual'), "I'm going to work");
for (const tone of ['formal', 'casual', 'veryCasual']) {
  for (const name of ['iPhone', 'eBay', 'Will', 'NASA']) assert(applyStyleWithTone(name + ' is here.', tone).startsWith(name), tone + ' keeps ' + name);
}
assert.strictEqual(applyStyleWithTone('I am. You are too. That is where we are.', 'casual'), 'I am. You are too. That is where we are.');
assert.strictEqual(applyStyleWithTone('I have a car. Let us through.', 'casual'), 'I have a car. Let us through.');
assert.strictEqual(applyStyleWithTone('Can you swim? I asked if you could send it.', 'formal'), 'Can you swim? I asked if you could send it.');
assert.strictEqual(applyStyleWithTone("Bill's here. O'Reilly won't join. He'll call.", 'formal'), "Bill's here. O'Reilly will not join. He will call.");

if (failed) {
  console.error(failed + ' failed');
  process.exit(1);
}
console.log('all style tests passed');
