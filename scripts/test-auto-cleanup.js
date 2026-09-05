'use strict';

const assert = require('assert');
const fs = require('fs');
const { autoCleanup } = require('../src/auto-cleanup');
const harness = require('./asr-test-harness');

const corrections = [
  ['we was gonna send the notes', 'We were gonna send the notes.'],
  ['hey we was gonna send the notes', 'Hey we were gonna send the notes.'],
  ['i is ready', 'I am ready.'],
  ['they has the file', 'They have the file.'],
  ['she have the file', 'She has the file.'],
  ["he don't know", "He doesn't know."],
  ['we doesnt need it', "We don't need it."],
  ['they isn’t ready', 'They aren’t ready.'],
  ["I didn't went there", "I didn't go there."],
  ['I didnt went there', "I didn't go there."],
  ['I did went there', 'I did go there.'],
  ['we has already went home', 'We have already gone home.'],
  ['I could of gone', 'I could have gone.'],
  ['can you send it', 'Can you send it?'],
  ['does they need it', 'Do they need it?'],
  ['did he went there', 'Did he go there?'],
  ['hello ,world;please send it', 'Hello, world; please send it.'],
  ['we are ready. can you send it', 'We are ready. Can you send it?'],
  ["hello. i think i'm ready", "Hello. I think I'm ready."],
  ['first line\n\nwe was ready', 'First line.\n\nWe were ready.'],
];
for (const [before, after] of corrections) {
  assert.strictEqual(autoCleanup(before), after, before);
  assert.strictEqual(autoCleanup(after), after, 'cleanup is stable: ' + after);
}

// Correct prose and ambiguous constructions must not be "fixed" into errors.
const preserved = [
  'Does he have the file?', 'Can she do this?', 'Why does he have it?',
  'What I need is a break.', 'If I were you, I would wait.',
  'I wish he were here.', 'I insist he have a chance.', 'You and I are ready.',
  'Let it have a chance.', 'I saw it have an effect.',
  'What he did went unnoticed.', 'Everything she does makes sense.',
  'The things he did made me cry.', 'I can saw wood.', 'I did saw wood.',
  'The experiments he did had an impact.', 'John and he have tickets.',
  'She suggested he have a chance.', 'I asked that he have a chance.',
  'I have saw blades.', 'We have spoke wheels.', 'I have broke friends.',
  'A can of beans.', 'I could of course help.', 'I like this kind of music.',
  "Yeah, I'm gonna go, you know, when we're ready.",
  'The deadline is not tomorrow.', 'I never said we should leave.',
  'Send it, please!', 'Really?!', 'Thanks...', 'Notes:', 'Thanks 😊',
  'She said "we was gonna go"', "She said 'we was gonna go'", 'She said “we was gonna go”',
  '`we has went`', '```js\nconst we = "was";\n```',
  'Use Ctrl+Shift+Space', 'Open C:\\Users\\Test\\we_was.txt',
  'Visit https://example.com/WeWas?x=1&y=2.',
  'Email Test@Example.com; send 1,234.56 or version 1.0.16.',
  'Dr. Smith is here.', 'E.g. this one.',
];
for (const text of preserved) assert.strictEqual(autoCleanup(text), text, text);
assert.strictEqual(autoCleanup('we was ready with He Is We', { protectedTerms: ['He Is We'] }), 'We were ready with He Is We.');
for (const [language, text] of [['pt', 'Preciso de um documento.'], ['de', 'Er ist hier.'], ['hi', 'यह ठीक है।']]) {
  assert.strictEqual(autoCleanup(text, { language }), text);
}
assert.strictEqual(autoCleanup(''), '');
assert.strictEqual(autoCleanup('   '), '   ');
assert.strictEqual(autoCleanup('we was ready', { language: 'en-US' }), 'We were ready.');

async function main() {
  const h = harness();
  try {
    assert.strictEqual(h.run('settings.autoCleanup'), false, 'existing users stay opted out');
    assert.strictEqual(h.run("composeTranscript('we was gonna go', 'casual', 'fast').text"), 'We was gonna go');
    // Exercise the actual settings IPC and reload, not just in-memory state.
    h.run('applySystemSettings = () => {}; sendOverlay = () => {}; broadcast = () => {};');
    const set = patch => h.handlers.get('settings-set')({}, patch);
    assert.strictEqual((await set({ autoCleanup: true })).autoCleanup, true);
    h.run('loadSettings()');
    assert.strictEqual(h.run('snapshot().autoCleanup'), true);
    await set({ autoCleanup: 'false' });
    assert.strictEqual(h.run('settings.autoCleanup'), true, 'only booleans can change the setting');
    for (const quality of ['fast', 'accurate']) {
      for (const [tone, expected] of [['casual', 'We were gonna go.'], ['formal', 'We were going to go.'], ['veryCasual', 'we were gonna go']]) {
        h.context.tone = tone; h.context.quality = quality;
        assert.strictEqual(h.run("composeTranscript('we was gonna go', tone, quality).text"), expected);
      }
    }
    assert.strictEqual(h.run("composeTranscript('we was gonna go', 'casual', 'fast').meta.afterAutoCleanup"), 'We were gonna go.');
    assert.strictEqual(h.run("settings.verbatimMode = true; composeTranscript('we was gonna go', 'formal', 'accurate').text"), 'We was gonna go');
    assert.strictEqual(h.run('settings.autoCleanup'), true, 'verbatim preserves the preference');
    h.run("settings.verbatimMode = false; settings.dictationLanguage = 'pt'");
    assert.strictEqual(h.run("composeTranscript('Preciso de um documento.', 'formal', 'fast').text"), 'Preciso de um documento.');
    h.run("settings.dictationLanguage = 'en'; settings.numbersAsDigits = false");
    assert.strictEqual(h.run("composeTranscript('we was twenty five', 'casual', 'fast').text"), 'We were twenty five.');
    h.run('settings.numbersAsDigits = true');
    assert.strictEqual(h.run("composeTranscript('we was twenty five', 'casual', 'fast').text"), 'We were 25.');
    assert(h.run("composeTranscript('we was ready insert new paragraph they has notes', 'casual', 'fast').text").includes('\n\n'));
    h.run("dictionary.phrases = [{ from: 'he is we', to: 'He Is We', kind: 'replacement' }]; saveDict();");
    assert(h.run("composeTranscript('we was listening to he is we', 'casual', 'fast').text").includes('He Is We'));
    await set({ autoCleanup: false });
    assert.strictEqual(h.run("composeTranscript('we was gonna go', 'casual', 'fast').text"), 'We was gonna go');
    const settingsFile = h.run('SETTINGS_FILE');
    const saved = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    fs.writeFileSync(settingsFile, JSON.stringify({ ...saved, autoCleanup: 'true' }));
    h.run('loadSettings()');
    assert.strictEqual(h.run('settings.autoCleanup'), false, 'malformed saved settings do not opt users in');
  } finally { h.close(); }
  console.log('Auto cleanup: corrections, preserved prose/tokens, tones, languages, verbatim, number preferences, settings IPC and persistence passed.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
