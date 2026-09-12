'use strict';

const assert = require('assert');
const fs = require('fs');
const harness = require('./asr-test-harness');

(async () => {
  const h = harness();
  try {
    const input = 'Hello, I am going to send the notes when we are done. Thank you.';
    const expected = {
      formal: input,
      casual: "Hi, I'm going to send the notes when we're done. Thanks.",
      veryCasual: "hey, I'm gonna send the notes when we're done. thanks",
    };
    h.context.sample = input;
    h.run('applySystemSettings = () => {}; sendOverlay = () => {}; broadcast = () => {};');
    const set = patch => h.handlers.get('settings-set')({}, patch);
    for (const category of ['personal', 'work', 'email', 'other']) {
      h.context.category = category;
      for (const [tone, text] of Object.entries(expected)) {
        await set({ writingStyles: { [category]: tone } });
        h.run('loadSettings()');
        for (const quality of ['fast', 'accurate']) {
          h.context.quality = quality;
          assert.strictEqual(h.run('composeTranscript(sample, style.toneForCategory(category, settings.writingStyles), quality).text'), text, category + '/' + tone + '/' + quality);
        }
      }
    }
    h.run("dictionary.phrases = [{ from: 'he is we', to: 'He Is We', kind: 'replacement' }]; saveDict();");
    assert(h.run("composeTranscript('I am listening to he is we', 'veryCasual', 'fast').text").includes('He Is We'));
    await set({ verbatimMode: true });
    assert.strictEqual(h.run("composeTranscript(sample, 'veryCasual', 'fast').text"), input);
    await set({ verbatimMode: false, dictationLanguage: 'de' });
    assert.strictEqual(h.run("composeTranscript('Er ist hier.', 'formal', 'accurate').text"), 'Er ist hier.');

    // Upgrade from an old settings file. A hidden preference must never send.
    const settingsFile = h.run('SETTINGS_FILE');
    const saved = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    fs.writeFileSync(settingsFile, JSON.stringify({ ...saved, autoSend: { work: 'enter', email: 'ctrl-enter' } }));
    h.run('loadSettings()');
    assert.strictEqual(h.run('settings.autoSend'), undefined);
    assert.strictEqual((await set({ autoSend: { work: 'enter' } })).autoSend, undefined);
    assert.strictEqual(JSON.parse(fs.readFileSync(settingsFile, 'utf8')).autoSend, undefined);
    h.run(`var pasteCalls = [];
      clipboardPaste = { paste: async (text, action) => { pasteCalls.push(['clipboard', text]); return action(); } };
      ps = async args => { pasteCalls.push(args); return 'VOXDEN_OK'; };
      settings.autoSend = { work: 'enter', email: 'ctrl-enter' };
      prepareCorrectionLearning = async () => null;`);
    await h.run("pasteDictation('A draft to review.', 'work')");
    await h.run("pasteDictation('Another draft.', 'email')");
    assert.deepStrictEqual(JSON.parse(h.run('JSON.stringify(pasteCalls.map(call => call[0]))')), ['clipboard', 'paste', 'clipboard', 'paste']);
  } finally { await h.close(); }
  console.log('Writing style integration: all contexts and qualities, saved tones, dictionary, verbatim, language, and removal of auto-send passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
