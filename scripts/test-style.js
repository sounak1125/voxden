'use strict';

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
  autoSendFor,
  normalizeAutoSend,
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
  ['Hey yeah I do not wanna go', 'veryCasual', 'personal', 'hey yeah I do not wanna go'],
  ['Hello there.', 'casual', 'work', 'Hello there.'],
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
  ['hello hello hello world', 'casual', 'Hello world'],
  ['yeah yeah yeah I am going', 'veryCasual', 'yeah I am going'],
  ['UM hey there.', 'veryCasual', 'hey there'],
  ["um, you know, I don't wanna go", 'formal', 'I do not want to go.'],
  ['Do you know the answer?', 'formal', 'Do you know the answer?'],
  ['I like this design.', 'formal', 'I like this design.'],
  ['What kind of music do you like?', 'formal', 'What kind of music do you like?'],
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
  console.error('formal punct FAIL');
}

if (applyVeryCasual('Hello World.') !== 'hello world') {
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

const sendMap = normalizeAutoSend({ personal: 'enter', work: 'ENTER', email: 'nope' });
if (sendMap.personal !== 'enter' || sendMap.work !== 'enter' || sendMap.email !== 'off') {
  failed += 1;
  console.error('autoSend normalize FAIL', sendMap);
}
if (autoSendFor('personal', { autoSend: { personal: 'ctrl-enter' } }) !== 'ctrl-enter') {
  failed += 1;
  console.error('autoSend lookup FAIL');
}
if (autoSendFor('email', { autoSend: {} }) !== 'off') {
  failed += 1;
  console.error('autoSend default FAIL');
}

if (failed) {
  console.error(failed + ' failed');
  process.exit(1);
}
console.log('all style tests passed');
