'use strict';

// What a user's saved dictation languages become now that the menu is the 18
// languages of Voxden Cloud's recognizer plus Hinglish (src/asr.js), driven
// through main.js in the harness and, for what is actually sent, through the
// real desktop client and the real relay with only the speech model stubbed.
//
//  - a saved selection that includes a removed language (Bengali, Tamil,
//    Korean, ...) loses it on load, from a list, from an older single value
//    and from a settings change, and with nothing left it is English;
//  - Norwegian keeps its saved id 'nb' and is sent as 'no';
//  - no saved selection makes the app send a removed code;
//  - a relay that refuses a language (a 2.1.9 app's 'bn') is not retried, and
//    the user is told in one plain sentence.

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const harness = require('./asr-test-harness');
const { createStore } = require('../server/store');
const { createApp, dayOf, creditMonthOf } = require('../server/app');

const AAI = 'assemblyai/universal-3-5-pro';
const plain = (value) => JSON.parse(JSON.stringify(value));
let checks = 0;
function eq(label, actual, expected) {
  assert.deepStrictEqual(actual, expected, label + '\n  got: ' + JSON.stringify(actual));
  checks += 1;
  process.stdout.write('ok ' + label + '\n');
}

function wavClip(seconds) {
  const data = Buffer.alloc(16000 * 2 * seconds);
  const hdr = Buffer.alloc(44);
  hdr.write('RIFF', 0); hdr.writeUInt32LE(36 + data.length, 4); hdr.write('WAVE', 8); hdr.write('fmt ', 12);
  hdr.writeUInt32LE(16, 16); hdr.writeUInt16LE(1, 20); hdr.writeUInt16LE(1, 22); hdr.writeUInt32LE(16000, 24);
  hdr.writeUInt32LE(32000, 28); hdr.writeUInt16LE(2, 32); hdr.writeUInt16LE(16, 34); hdr.write('data', 36); hdr.writeUInt32LE(data.length, 40);
  return Buffer.concat([hdr, data]);
}

async function main() {
  const h = harness();
  let store = null;
  let server = null;
  try {
    h.run("accountPlan = () => 'pro';");

    // --- saved settings, as the next launch reads them -------------------------
    const load = (saved) => {
      fs.writeFileSync(h.run('SETTINGS_FILE'), JSON.stringify({ cloudTranscription: true, ...saved }));
      h.run('loadSettings()');
      return plain({
        list: h.run('settings.dictationLanguages'), scalar: h.run('settings.dictationLanguage'),
        wire: h.run('engineLanguage()'), text: h.run('textLanguage()'), hinglish: h.run('wantsHinglish()'),
      });
    };
    const result = (list, wire, text, hinglish) => ({ list, scalar: list[0], wire, text, hinglish: !!hinglish });

    eq('Bengali alone becomes English', load({ dictationLanguages: ['bn'] }), result(['en'], 'en', 'en'));
    eq('and the file on disk is clean after the next save', (() => {
      h.run('saveSettings()');
      const saved = JSON.parse(fs.readFileSync(h.run('SETTINGS_FILE'), 'utf8'));
      return [saved.dictationLanguages, saved.dictationLanguage];
    })(), [['en'], 'en']);
    eq('Bengali beside English is English alone, sent as en and not auto',
      load({ dictationLanguages: ['bn', 'en'] }), result(['en'], 'en', 'en'));
    eq('Hindi beside Bengali is Hindi alone, sent as hi',
      load({ dictationLanguages: ['hi', 'bn'] }), result(['hi'], 'hi', 'hi'));
    eq('Bengali first, Hindi second: Hindi is the main language now',
      load({ dictationLanguages: ['bn', 'hi'] }), result(['hi'], 'hi', 'hi'));
    eq('three removed languages become English',
      load({ dictationLanguages: ['ta', 'ko', 'th'] }), result(['en'], 'en', 'en'));
    eq('a removed language between two kept ones leaves the two, still detecting',
      load({ dictationLanguages: ['fr', 'bn', 'de'] }), result(['fr', 'de'], 'auto', 'fr'));
    eq('Cantonese becomes English; Mandarin stays',
      [load({ dictationLanguages: ['yue'] }), load({ dictationLanguages: ['zh'] })],
      [result(['en'], 'en', 'en'), result(['zh'], 'zh', 'zh')]);
    eq('an older file with a single removed language is English',
      load({ dictationLanguage: 'ta' }), result(['en'], 'en', 'en'));
    eq('an older file with a single kept language keeps it',
      load({ dictationLanguage: 'de' }), result(['de'], 'de', 'de'));
    eq('a file that names no language is English', load({}), result(['en'], 'en', 'en'));
    eq('Norwegian keeps its saved id and is sent as no',
      load({ dictationLanguages: ['nb'] }), result(['nb'], 'no', 'no'));
    eq('Norwegian beside English detects', load({ dictationLanguages: ['en', 'nb'] }), result(['en', 'nb'], 'auto', 'en'));
    eq('Hinglish is sent as hi and written in English letters',
      load({ dictationLanguages: ['hg'] }), result(['hg'], 'hi', 'en', true));
    eq('Hinglish beside English and Bengali is English and Hinglish, detecting',
      load({ dictationLanguages: ['en', 'hg', 'bn'] }), result(['en', 'hg'], 'auto', 'en', true));
    h.run("accountPlan = () => 'free';");
    eq('a free account is English whatever was saved', load({ dictationLanguages: ['fr', 'nb'] }), result(['en'], 'en', 'en'));
    h.run("accountPlan = () => 'pro';");

    // --- a change made in Settings ---------------------------------------------
    const set = h.handlers.get('settings-set');
    h.run("settings.cloudTranscription = true; overlayWin = { isDestroyed: () => true };");
    let snapshot = plain(await set(null, { dictationLanguages: ['bn', 'fr'] }));
    eq('a patch that includes Bengali keeps French only', [snapshot.dictationLanguages, snapshot.dictationLanguage, h.run('engineLanguage()')], [['fr'], 'fr', 'fr']);
    snapshot = plain(await set(null, { dictationLanguage: 'ko' }));
    eq('an older renderer sending Korean gets English', [snapshot.dictationLanguages, h.run('engineLanguage()')], [['en'], 'en']);
    snapshot = plain(await set(null, { dictationLanguages: ['nb'] }));
    eq('a Norwegian patch is saved as nb and sent as no',
      [snapshot.dictationLanguages, JSON.parse(fs.readFileSync(h.run('SETTINGS_FILE'), 'utf8')).dictationLanguages, h.run('engineLanguage()')], [['nb'], ['nb'], 'no']);
    eq('the picker is given the 19 entries, in order',
      snapshot.dictationLanguageCatalog.map((l) => l.id),
      ['en', 'hg', 'ar', 'zh', 'da', 'nl', 'fi', 'fr', 'de', 'he', 'hi', 'it', 'ja', 'nb', 'pt', 'es', 'sv', 'tr', 'vi']);
    eq('Norwegian in it is still nb, with no as the engine code',
      snapshot.dictationLanguageCatalog.filter((l) => l.id === 'nb').map((l) => [l.id, l.engine]), [['nb', 'no']]);
    eq('and what a Pro account with Cloud on is offered is the same list',
      snapshot.dictationLanguageOffered.length, 19);

    // --- what is sent: the real client, the real relay -------------------------
    store = createStore(':memory:');
    const now = Date.now();
    const stamp = new Date(now).toISOString();
    const user = store.findOrCreateUser('languages@example.test', stamp);
    store.setPlan('languages@example.test', 'pro', new Date(now + 86400000).toISOString());
    const token = 'test-language-session-token';
    store.createSession({ tokenHash: crypto.createHash('sha256').update(token).digest('hex'), userId: user.id, device: 'test', createdAt: stamp });
    const heard = [];
    const model = {
      configured: true, model: AAI,
      transcribe: async (request) => { heard.push(request.language); return { text: 'words', billedSeconds: 3, cost: 0 }; },
    };
    const relay = createApp({ store, mailer: { sendCode: async () => {} }, now: () => now, cloud: model });
    server = http.createServer(relay.handle);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    h.context.liveFetch = (url, init) => fetch(url, init);
    h.context.account = {
      signedIn: true, plan: 'pro', cloud: { creditsCap: 900, creditsUsed: 0, hoursCap: 15, hoursUsed: 0 },
    };
    const diags = [];
    h.context.recordDiag = (event, fields) => { diags.push(Object.assign({ event }, fields)); };
    h.run(`accountManager.snapshot = () => account;
      accountManager.noteCloudUsage = () => {};
      accountManager.refresh = async () => account;
      diagLog = recordDiag;
      sendOverlay = () => {};
      cloudTranscriber.baseUrl = ${JSON.stringify('http://127.0.0.1:' + server.address().port + '/v1')};
      cloudTranscriber.token = () => ${JSON.stringify(token)};
      cloudTranscriber.fetch = liveFetch;
      settings.cloudTranscription = true;
      mode = 'transcribing';`);
    const month = creditMonthOf(0, now);
    const usage = () => store.usageSecondsBetween(user.id, dayOf(month.start), dayOf(month.end));
    h.context.clipBuf = wavClip(3);
    const settleError = (promise) => promise.then(() => null, (err) => err);

    // Every kind of saved selection, from the file, dictated for real. Whatever
    // the relay was asked for must be a language the model takes.
    const ACCEPTED = ['en', 'es', 'fr', 'de', 'it', 'pt', 'ar', 'da', 'nl', 'fi', 'he', 'hi', 'ja', 'zh', 'no', 'sv', 'tr', 'vi'];
    const saved = [
      [['bn'], 'en'], [['en', 'bn'], 'en'], [['hi', 'bn'], 'hi'], [['ta', 'ko', 'th'], 'en'], [['yue'], 'en'], [['fil', 'de'], 'de'],
      [['nb'], 'no'], [['hg'], 'hi'], [['en', 'hg', 'bn'], ''], [['fr', 'bn', 'de'], ''], [['zh'], 'zh'], [['he'], 'he'],
    ];
    for (const [selection, expected] of saved) {
      load({ dictationLanguages: selection });
      heard.length = 0;
      const text = await h.run('tryCloudTranscribe(clipBuf, {}, 3)');
      eq('dictating ' + JSON.stringify(selection) + ' reaches the model as ' + JSON.stringify(expected || 'detect'),
        [text, heard.length, heard[0]], ['words', 1, expected]);
      assert.ok(heard[0] === '' || ACCEPTED.includes(heard[0]), 'the model was asked for ' + heard[0]);
    }
    eq('nothing was refused along the way', diags.filter((d) => d.event === 'cloud-request-failed'), []);

    // An app up to 2.1.9 that still has Bengali saved, or any caller that
    // names a language itself, is refused by the relay. Once, not retried, not
    // charged, and the user is told in one sentence.
    const usedBefore = usage();
    heard.length = 0;
    diags.length = 0;
    const refused = await settleError(h.run("tryCloudTranscribe(clipBuf, { language: 'bn' }, 3)"));
    eq('the relay refuses Bengali with code language and a 400', [refused && refused.code, refused && refused.status], ['language', 400]);
    eq('the model was never asked and nothing was charged', [heard.length, usage()], [0, usedBefore]);
    eq('the app asked once: refusals are not retried',
      diags.filter((d) => d.event === 'cloud-request-failed').map((d) => [d.attempt, d.code, d.status]), [[1, 'language', 400]]);
    h.context.refusedError = refused;
    eq('the app does not call it transient', h.run('cloudFailureIsTransient(refusedError)'), false);
    eq('nor does it for the same error in any wrapping', h.run("cloudFailureIsTransient({ code: 'language', status: 400, message: 'x' })"), false);
    eq('the cloud status card keeps the reason', [h.run('cloudStatus.lastResult'), h.run('cloudStatus.lastError')], ['error', 'language']);
    h.context.wrappedRefusal = "Error invoking remote method 'transcribe': Error: " + refused.message;
    eq('the user reads one plain sentence', h.run('friendlyEngineError(wrappedRefusal)'),
      "Voxden Cloud doesn't support that language yet. Change it in Settings.");
    eq('whichever apostrophe the message carries',
      h.run("friendlyEngineError('Voxden Cloud doesn\\u2019t support that language yet.')"),
      "Voxden Cloud doesn't support that language yet. Change it in Settings.");
    eq('the relay sentence is short enough that an app up to 2.1.9 shows it as it is (it keeps 56 characters or fewer)',
      refused.message.length <= 56, true);

    // Should a relay ever add the list of languages to its sentence, the new
    // app still reads it as the same refusal.
    h.context.longRefusal = "Voxden Cloud doesn't support that language yet. It supports English, Hindi, Spanish, French, German.";
    eq('a longer message with the list after it reads the same',
      h.run('friendlyEngineError(longRefusal)'), "Voxden Cloud doesn't support that language yet. Change it in Settings.");
  } finally {
    await h.close();
    if (server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
    if (store) store.close();
  }
  process.stdout.write('all ' + checks + ' dictation language checks passed\n');
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
