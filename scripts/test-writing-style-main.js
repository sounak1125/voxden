'use strict';

const assert = require('assert');
const fs = require('fs');
const harness = require('./asr-test-harness');

(async () => {
  const h = harness();
  try {
    // A tone changes capitals and punctuation; every word survives.
    const input = 'Hello, I am going to send the notes when we are done. Thank you.';
    const expected = {
      formal: input,
      casual: input,
      veryCasual: 'hello, I am going to send the notes when we are done. thank you',
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

    // Spoken corrections are off until turned on. Then what the speaker took
    // back is gone, and the history entry says what was taken out.
    h.context.takenBack = 'The cat is running on the field, no, no, in the park.';
    assert.strictEqual(h.run('settings.spokenCorrections'), false);
    assert.strictEqual(h.run("composeTranscript(takenBack, 'casual', 'fast').text"), h.context.takenBack, 'off by default');
    await set({ spokenCorrections: true });
    h.run('loadSettings()');
    assert.strictEqual(h.run('settings.spokenCorrections'), true, 'the choice is saved');
    const fixed = JSON.parse(h.run("JSON.stringify(composeTranscript(takenBack, 'casual', 'fast'))"));
    assert.strictEqual(fixed.text, 'The cat is running in the park.');
    assert.deepStrictEqual(fixed.meta.spokenCorrections, ['on the field, no, no,']);
    assert.strictEqual(fixed.meta.afterCorrections, 'The cat is running in the park.');
    assert.strictEqual(h.run("composeTranscript('Meet at three, no, four.', 'casual', 'fast').text"), 'Meet at four.');
    assert.strictEqual(h.run("composeTranscript('Sorry, my bad, it closed.', 'casual', 'fast').text"), 'Sorry, my bad, it closed.',
      'an apology is not a correction');
    h.run("(() => { const c = composeTranscript(takenBack, 'casual', 'fast'); addHistoryEntry(c.text, c.meta); })()");
    const entry = JSON.parse(h.run('JSON.stringify(history.entries[0])'));
    assert.strictEqual(entry.text, 'The cat is running in the park.');
    assert.strictEqual(entry.original, h.context.takenBack, 'what was said is kept');
    assert.deepStrictEqual(entry.spokenCorrections, ['on the field, no, no,']);
    const plain = JSON.parse(h.run("(() => { const c = composeTranscript('Nothing to take back here.', 'casual', 'fast'); addHistoryEntry(c.text, c.meta); return JSON.stringify(history.entries[0]); })()"));
    assert.strictEqual(plain.spokenCorrections, undefined, 'an entry with nothing taken out says nothing');
    assert.strictEqual(plain.afterCorrections, undefined);

    // With Voxden Cloud the model names what was taken back. Its pieces are
    // checked and used; any other answer, or none, leaves the rules alone.
    h.context.walked = "Okay, uh, so let's Uh walk into the Plane field. Uh. No, no, uh... Not in the plain field. Let's, uh... put it in the water.";
    h.run(`
      var takeBackCalls = []; var takeBackReply = null;
      var savedPolishClient = polishClient; var savedSnapshot = accountManager.snapshot;
      polishClient = { takeBack: async (text) => {
        takeBackCalls.push(text);
        if (takeBackReply instanceof Error) throw takeBackReply;
        return takeBackReply;
      } };
      accountManager.snapshot = () => ({ signedIn: true, plan: 'pro' });
    `);
    const modelCompose = async (said) => {
      h.context.said = said;
      await h.run('modelTakeBack(said).then(answer => { lastTakeBack = answer; })'.replace('lastTakeBack', 'globalThis.lastTakeBack'));
      return JSON.parse(h.run("JSON.stringify(composeTranscript(said, 'casual', 'fast', globalThis.lastTakeBack))"));
    };
    h.run(`takeBackReply = { remove: ["walk into the Plane field. Uh. No, no, uh... Not in the plain field. Let's, uh..."] }`);
    const walked = await modelCompose(h.context.walked);
    assert.strictEqual(walked.text, "Okay so let's put it in the water.", 'the model catches what the rules cannot');
    assert.strictEqual(walked.meta.rawAsr, h.context.walked, 'what was said is still kept');
    assert.deepStrictEqual(walked.meta.spokenCorrections, ["walk into the Plane field. Uh. No, no, uh... Not in the plain field. Let's, uh..."]);
    h.run("takeBackReply = { remove: ['No, no,'] }");
    assert.strictEqual((await modelCompose('No, no, you made it way too dark. Keep the old colors.')).text,
      'No, no, you made it way too dark. Keep the old colors.', 'a piece that is not words taken back is not used');
    h.run("takeBackReply = Object.assign(new Error('timed out'), { code: 'timeout' })");
    assert.strictEqual((await modelCompose(h.context.takenBack)).text, 'The cat is running in the park.',
      'a model that fails leaves the rules to it');
    const calls = h.run('takeBackCalls.length');
    await modelCompose('Please send the notes when we are done.');
    assert.strictEqual(h.run('takeBackCalls.length'), calls, 'a dictation with no cue word is never sent');
    h.run("accountManager.snapshot = () => ({ signedIn: true, plan: 'free' })");
    await modelCompose(h.context.walked);
    assert.strictEqual(h.run('takeBackCalls.length'), calls, 'nor one from a free account');
    h.run("accountManager.snapshot = () => ({ signedIn: true, plan: 'pro' })");
    await set({ spokenCorrections: false });
    await modelCompose(h.context.walked);
    assert.strictEqual(h.run('takeBackCalls.length'), calls, 'nor with the setting off');
    await set({ spokenCorrections: true });
    h.run('polishClient = savedPolishClient; accountManager.snapshot = savedSnapshot;');

    await set({ verbatimMode: true });
    assert.strictEqual(h.run("composeTranscript(sample, 'veryCasual', 'fast').text"), input);
    assert.strictEqual(h.run("composeTranscript(takenBack, 'casual', 'fast').text"), h.context.takenBack,
      'verbatim keeps every word, corrections too');
    assert.strictEqual(await h.run('modelTakeBack(takenBack)'), null, 'and never asks the model');
    await set({ verbatimMode: false });
    h.run("settings.cloudTranscription = true; accountManager.snapshot = function () { return { signedIn: true, plan: 'pro' }; };");
    await set({ dictationLanguage: 'de' });
    assert.strictEqual(h.run("composeTranscript('Er ist hier.', 'formal', 'accurate').text"), 'Er ist hier.');
    assert.strictEqual(h.run("composeTranscript(takenBack, 'casual', 'accurate').text"), h.context.takenBack,
      'the cue words are English ones');
    h.run("accountManager.snapshot = function () { return { signedIn: false, plan: 'free' }; }; settings.cloudTranscription = false;");

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
