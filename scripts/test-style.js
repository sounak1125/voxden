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
  ['um you know I think we should go', 'formal', 'I think we should go.'],
  ['um you know I think we should go', 'casual', 'You know I think we should go'],
  ['um yeah hello hello world', 'casual', 'Yeah hello world'],
  ['hello hello hello world', 'casual', 'Hello world'],
  ['yeah yeah yeah I am going', 'veryCasual', 'yeah I am going'],
  ['UM hey there.', 'veryCasual', 'hey there'],
  ["um you know I don't wanna go", 'formal', 'I do not want to go.'],
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

if (stripFillers('Um you know hello', 'formal') !== 'hello') {
  failed += 1;
  console.error('formal filler FAIL', stripFillers('Um you know hello', 'formal'));
}

if (failed) {
  console.error(failed + ' failed');
  process.exit(1);
}
console.log('all style tests passed');
