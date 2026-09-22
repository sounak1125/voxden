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
  // macOS reports a bundle id instead of an exe name. Same categories, and the
  // title still decides for a browser.
  ['net.whatsapp.WhatsApp', 'Chat', 'personal'],
  ['com.hnc.Discord', 'general', 'personal'],
  ['ru.keepcoder.Telegram', 'Saved Messages', 'personal'],
  ['com.apple.MobileSMS', 'Messages', 'personal'],
  ['com.tinyspeck.slackmacgap', 'project-updates', 'work'],
  ['com.microsoft.teams2', 'Calls', 'work'],
  ['com.notion.id', 'Roadmap', 'work'],
  ['com.figma.Desktop', 'Untitled', 'work'],
  ['com.apple.mail', 'Inbox', 'email'],
  ['com.microsoft.Outlook', 'Inbox', 'email'],
  ['com.google.Chrome', 'Gmail - Inbox', 'email'],
  ['com.google.Chrome', 'LinkedIn', 'work'],
  ['com.google.Chrome', 'ChatGPT', 'other'],
  ['com.apple.Safari', 'Proton Mail', 'email'],
  ['org.mozilla.firefox', 'WhatsApp Web', 'personal'],
  ['com.brave.Browser', 'Notion', 'work'],
  ['com.microsoft.edgemac', 'Outlook', 'email'],
  ['company.thebrowser.Browser', 'Figma', 'work'],
  // A prefix match is by whole segment: a channel of com.google.Chrome counts,
  // com.microsoft.VSCode is not swallowed by com.microsoft.Outlook.
  ['com.google.Chrome.canary', 'Gmail - Inbox', 'email'],
  ['com.microsoft.VSCode', 'main.js - Visual Studio Code', 'other'],
  ['com.apple.TextEdit', 'notes.txt', 'other'],
  ['com.apple.Notes', 'Shopping', 'other'],
  // Case is not meaningful in a bundle id.
  ['COM.HNC.DISCORD', 'general', 'personal'],
];

// A tone changes capitals and punctuation. The words are the ones spoken.
const styleCases = [
  ['Hey yeah I do not wanna go', 'formal', 'personal', 'Hey yeah I do not wanna go.'],
  ['Hey yeah I do not wanna go', 'veryCasual', 'personal', 'hey yeah I do not wanna go'],
  ['Hello there.', 'casual', 'work', 'Hello there.'],
];

const pipelineCases = [
  // Without punctuation, "you know" is part of the sentence and stays.
  ['um you know I think we should go', 'formal', 'You know I think we should go.'],
  ['um you know I think we should go', 'casual', 'You know I think we should go'],
  ['um, you know, I think we should go', 'formal', 'I think we should go.'],
  ['I was, you know, thinking we should leave', 'formal', 'I was thinking we should leave.'],
  ['Um, I think we should go', 'casual', 'I think we should go'],
  ['UM hey there.', 'veryCasual', 'UM hey there'],
  ["um, you know, I don't wanna go", 'formal', "I don't wanna go."],
  ['Do you know the answer?', 'formal', 'Do you know the answer?'],
  ['I like this design.', 'formal', 'I like this design.'],
  ['What kind of music do you like?', 'formal', 'What kind of music do you like?'],
  // Filler goes whatever the tone: a casual message is a short message, not a
  // less tidy one.
  ['I was, you know, thinking we should leave', 'casual', 'I was thinking we should leave'],
  ['I was, you know, thinking we should leave', 'veryCasual', 'I was thinking we should leave'],
  // "like", "I mean", "kind of" and "sort of" carry meaning -- "like, 40
  // degrees" is a guess -- so they stay, commas and all.
  ['It was, like, huge.', 'casual', 'It was, like, huge.'],
  ['We should, I mean, probably leave', 'formal', 'We should, I mean, probably leave.'],
  ['this thing, I mean, like, can you help', 'formal', 'This thing, I mean, like, can you help.'],
  // Next to one of them, "you know" leaves the comma its neighbour needs.
  ['we are, you know, like, thinking', 'casual', 'We are, like, thinking'],
  ['So, I was thinking we should go.', 'formal', 'So, I was thinking we should go.'],
  ['So far, I am enjoying this.', 'formal', 'So far, I am enjoying this.'],
  ['So far, I am enjoying this.', 'casual', 'So far, I am enjoying this.'],
  ['So long as it holds, we are fine.', 'formal', 'So long as it holds, we are fine.'],
  // Said twice on purpose, kept.
  ['um yeah hello hello world', 'casual', 'Yeah hello hello world'],
  ['yeah yeah yeah I am going', 'veryCasual', 'yeah yeah yeah I am going'],
  // Real words that only look like fillers.
  ['I went to the ER last night.', 'casual', 'I went to the ER last night.'],
  ['To err is human.', 'formal', 'To err is human.'],
  ['Did you get it? Uh-huh.', 'casual', 'Did you get it? Uh-huh.'],
  // The engine capitalises the word after a filler; with the filler gone it is
  // mid-sentence again.
  ['It should be, you know, Add a section here.', 'casual', 'It should be add a section here.'],
  ['I need to again, uh... Add some credit.', 'casual', 'I need to again add some credit.'],
  // A small word capitalised mid-sentence is the engine's, unless a capital
  // beside it makes it part of a title.
  ["also Let's update the github", 'casual', "Also let's update the github"],
  ['turn on Do Not Disturb now', 'casual', 'Turn on Do Not Disturb now'],
  // A short form's stop is not a sentence end.
  ['Let us meet at 3 p.m. tomorrow.', 'casual', 'Let us meet at 3 p.m. tomorrow.'],
  // The engine's stop at a pause, before a joining word, was never a sentence end.
  ['a soft smile. and a natural look.', 'formal', 'A soft smile and a natural look.'],
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

if (applyFormal('Thanks') !== 'Thanks.') {
  failed += 1;
  console.error('formal punct FAIL', applyFormal('Thanks'));
}

if (applyVeryCasual('Hello World.') !== 'hello World') {
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
  ['com.tinyspeck.slackmacgap', 'project-updates', 'auto', 'fast'],
  ['com.openai.chat', 'ChatGPT', 'auto', 'fast'],
  ['com.apple.mail', 'Inbox', 'auto', 'accurate'],
  ['com.microsoft.VSCode', 'main.js - Visual Studio Code', 'auto', 'accurate'],
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

// Every tone keeps every word; only capitals and punctuation differ.
const toneExamples = [
  ['Could you please send the notes when you are ready?', [
    'Could you please send the notes when you are ready?',
    'Could you please send the notes when you are ready?',
    'could you please send the notes when you are ready?',
  ]],
  ['um, so I am sending the notes tonight, you know, once we are done. thanks for waiting', [
    'So I am sending the notes tonight once we are done. Thanks for waiting.',
    'So I am sending the notes tonight once we are done. Thanks for waiting',
    'so I am sending the notes tonight once we are done. thanks for waiting',
  ]],
  ['Please let me know if you want to join. I cannot stay.', [
    'Please let me know if you want to join. I cannot stay.',
    'Please let me know if you want to join. I cannot stay.',
    'please let me know if you want to join. I cannot stay',
  ]],
  ["Hey, I’m gonna call Alex on Monday. Thanks!", [
    'Hey, I’m gonna call Alex on Monday. Thanks!',
    'Hey, I’m gonna call Alex on Monday. Thanks!',
    'hey, I’m gonna call Alex on Monday. thanks!',
  ]],
];
for (const [input, expected] of toneExamples) {
  for (const [i, tone] of ['formal', 'casual', 'veryCasual'].entries()) {
    const result = applyStyleWithTone(input, tone);
    assert.strictEqual(result, expected[i], tone + ': ' + input);
    assert.strictEqual(applyStyleWithTone(result, tone), result, 'styling stays stable');
  }
  assert.strictEqual(new Set(expected.map(s => s.toLowerCase().replace(/[^a-z ]/g, ''))).size, 1, 'same words in every tone');
}

// Very casual drops the capital from every sentence that starts with an
// everyday word, however it is inflected, and from none that starts with a
// name: before this, 24 hard-coded starters left most messages half and half.
assert.strictEqual(
  applyStyleWithTone('Analyze it. Moving on. Alex said yes. Will you check? Will is here. NASA called. Users are here.', 'veryCasual'),
  'analyze it. moving on. Alex said yes. will you check? Will is here. NASA called. users are here');

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
assert.strictEqual(applyStyleWithTone('I am going to London.', 'veryCasual'), 'I am going to London');
assert.strictEqual(applyStyleWithTone('I am going to work.', 'veryCasual'), 'I am going to work');
for (const tone of ['formal', 'casual', 'veryCasual']) {
  for (const name of ['iPhone', 'eBay', 'Will', 'NASA']) assert(applyStyleWithTone(name + ' is here.', tone).startsWith(name), tone + ' keeps ' + name);
}
assert.strictEqual(applyStyleWithTone('I am. You are too. That is where we are.', 'casual'), 'I am. You are too. That is where we are.');
assert.strictEqual(applyStyleWithTone('I have a car. Let us through.', 'casual'), 'I have a car. Let us through.');
assert.strictEqual(applyStyleWithTone('Can you swim? I asked if you could send it.', 'formal'), 'Can you swim? I asked if you could send it.');
assert.strictEqual(applyStyleWithTone("Bill's here. O'Reilly won't join. He'll call.", 'formal'), "Bill's here. O'Reilly won't join. He'll call.");

if (failed) {
  console.error(failed + ' failed');
  process.exit(1);
}
console.log('all style tests passed');
