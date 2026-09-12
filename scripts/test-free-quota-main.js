'use strict';

// The free plan's weekly words in the main process: charged where dictations
// end, enforced where they start, written to a file of their own, and never
// applied to a Pro account.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const mainHarness = require('./asr-test-harness');

let checks = 0;
function eq(label, actual, expected) {
  assert.deepStrictEqual(actual, expected, label + '\n  got: ' + JSON.stringify(actual));
  checks += 1;
  process.stdout.write('ok ' + label + '\n');
}

// Values built inside the harness's vm have that realm's prototypes, which
// deepStrictEqual counts as a difference. Compare the data, not the realm.
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

// A main process that is ready to dictate, with an account of the given plan
// and everything that would touch a window or a microphone stubbed out.
function prepare(h, plan, cap) {
  h.context.flashes = [];
  h.context.opened = [];
  h.run(`
    settings.shortcut = 'CommandOrControl+Shift+Space';
    settings.dictateMode = 'toggle';
    settings.cloudTranscription = false;
    sidecarState = 'ready'; mode = 'idle';
    showOverlay = () => {}; registerEscape = () => {};
    rememberFocus = () => Promise.resolve();
    pauseBackgroundMedia = () => new Promise(() => {});
    sendOverlay = () => {};
    refreshTray = () => {};
    broadcast = () => {};
    overlayWin = { isDestroyed: () => false, webContents: {} };
    flashError = (msg) => { mode = 'error'; flashes.push(msg); };
    openHistory = (cat) => { opened.push(cat || ''); };
    accountManager = {
      signedIn: () => true,
      token: () => '',
      snapshot: () => ({ signedIn: true, plan: ${JSON.stringify(plan)}, freeWeeklyWords: ${Number(cap)} }),
    };
  `);
}

function meter(h) {
  return h.run('freeWordsMeter()');
}

async function testChargingAndBlocking() {
  const h = mainHarness();
  try {
    prepare(h, 'free', 20);
    eq('a fresh PC has the whole week', [meter(h).used, meter(h).remaining, meter(h).started], [0, 20, false]);

    h.run("finishDictation('one two three four five', {})");
    eq('a finished dictation is charged in words', [meter(h).used, meter(h).remaining], [5, 15]);
    eq('and the week it started is running', meter(h).started, true);

    // A paste that failed still leaves the words in history, where the
    // paste-last shortcut can place them, so they are charged there too.
    h.run("addHistoryEntry('saved in history', {})");
    eq('a transcript kept after a failed paste is charged', meter(h).used, 8);

    h.run("chargeFreeWords('   ')");
    eq('silence costs nothing', meter(h).used, 8);

    const file = path.join(h.root, 'data', 'free-words.json');
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    eq('the count is on disk, not in dictation history', saved.words, 8);
    eq('with the day the week began', saved.periodStart > 0, true);

    // Dictation is still allowed while there are words left.
    h.run('startRecording(false)');
    eq('a free account with words left starts dictating', h.run('mode'), 'arming');
    h.run("mode = 'idle';");

    h.run("finishDictation('" + 'word '.repeat(12).trim() + "', {})");
    eq('the last words of the week are spent', [meter(h).used, meter(h).exhausted], [20, true]);

    h.run('startRecording(false)');
    eq('the next dictation is refused before the microphone opens', h.run('mode'), 'error');
    eq('with one line on the bar', h.context.flashes, ['Free words used up — upgrade to keep dictating']);
    eq('and Plans & billing opened behind it', h.context.opened, ['billing']);

    const noted = plain(h.run('Object.keys(notifications.items).filter((id) => id.startsWith("free-words:"))'));
    eq('the bell carries the spent notice', noted.map((id) => id.split(':').pop()), ['spent']);

    const snap = h.run('snapshot()');
    eq('the windows are told what is left', [snap.freeWords.cap, snap.freeWords.used, snap.freeWords.exhausted], [20, 20, true]);
  } finally { await h.close(); }
}

async function testWeekTurningOver() {
  const h = mainHarness();
  try {
    prepare(h, 'free', 20);
    h.run('freeWords = { periodStart: Date.now() - 8 * 86400e3, words: 20 }; saveFreeWords();');
    eq('a week that has gone by is not spent', [meter(h).used, meter(h).exhausted], [0, false]);

    h.run('startRecording(false)');
    eq('so dictation starts again on its own', h.run('mode'), 'arming');
    h.run("mode = 'idle';");

    h.run("finishDictation('a new week', {})");
    eq('and the next dictation opens a fresh seven days', meter(h).used, 3);
  } finally { await h.close(); }
}

async function testScreenshotDictationCounts() {
  const h = mainHarness();
  try {
    prepare(h, 'free', 900);
    h.run(`
      screenCapture = { sessionId: 4, active: true, speechState: () => {},
        complete: async () => true, retry: async () => true };
      captureVoiceSession = 4; recordingSessionToken = 1; mode = 'transcribing';
    `);
    await h.run("finishCaptureDictation('spoken into a screenshot', 4, 1)");
    eq('words spoken into a screenshot are charged like any other', meter(h).used, 4);

    await h.run("finishCaptureDictation(null, 4, 1)");
    eq('and re-pasting that capture does not charge them twice', meter(h).used, 4);
  } finally { await h.close(); }
}

async function testProIsNotMetered() {
  const h = mainHarness();
  try {
    prepare(h, 'pro', 20);
    eq('Pro has no word meter', meter(h), null);

    h.run("finishDictation('" + 'word '.repeat(50).trim() + "', {})");
    eq('and a Pro dictation spends nothing', plain(h.run('freeWords')), { periodStart: 0, words: 0 });

    h.run('startRecording(false)');
    eq('Pro dictates whatever it has said this week', h.run('mode'), 'arming');
    eq('and its snapshot carries no word meter', h.run('snapshot()').freeWords, null);

    // A subscription that lapses inherits an untouched week rather than a bill
    // for the words it dictated while it was paying.
    h.run(`accountManager.snapshot = () => ({ signedIn: true, plan: 'free', freeWeeklyWords: 20 });`);
    eq('so a lapsed account starts Free with every word intact', meter(h).remaining, 20);
  } finally { await h.close(); }
}

async function main() {
  await testChargingAndBlocking();
  await testWeekTurningOver();
  await testScreenshotDictationCounts();
  await testProIsNotMetered();
  process.stdout.write('\n' + checks + ' checks passed\n');
}

main().catch((err) => {
  process.stderr.write((err && err.stack ? err.stack : String(err)) + '\n');
  process.exitCode = 1;
});
