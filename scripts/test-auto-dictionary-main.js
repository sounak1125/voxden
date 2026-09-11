'use strict';

// Execute the real main-process integration with inert windows and a fake
// observer. No app starts, clipboard changes, keystrokes or real text reads.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createCorrectionTracker } = require('../src/correction-learning');
const autoDictionary = require('../src/auto-dictionary');
const source = fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8');
const integration = source.slice(source.indexOf('let correctionSession = null;'), source.indexOf('let clipboardPaste = null;'));
const pasteFunction = source.slice(source.indexOf('async function pasteDictation('), source.indexOf('\nfunction finishDictation('));
assert(integration && pasteFunction);

function fixture({ delayedObserver = false } = {}) {
  let time = 0;
  let timerId = 0;
  const timers = new Map();
  const handlers = {};
  const observers = [];
  const overlay = { isDestroyed: () => false, webContents: {}, setFocusable: value => { assert.strictEqual(value, false); } };
  const delay = (fn, ms) => { const id = ++timerId; timers.set(id, { fn, at: time + ms }); return id; };
  const cancel = id => timers.delete(id);
  const context = vm.createContext({
    require, process: { platform: 'win32' },
    createCorrectionTracker: opts => createCorrectionTracker({ ...opts, delay, cancel, now: () => time }),
    createCorrectionObserver(opts) {
      const observer = {
        stopped: false, opts,
        start: () => new Promise(resolve => {
          observer.resolveInitial = resolve;
          if (!delayedObserver) resolve({ text: 'Draft: ', fieldId: 'field', hwnd: '42' });
        }),
        stop() {
          if (!this.stopped) {
            this.stopped = true;
            this.resolveInitial?.(null);
            opts.onStop();
          }
        },
        emit(text) { opts.onSnapshot({ text, fieldId: 'field', hwnd: '42' }); },
      };
      observers.push(observer);
      return observer;
    },
    autoDictionary, settings: { autoAddToDictionary: true }, lastHwnd: '42',
    isOurHwnd: hwnd => hwnd === '0', mode: 'transcribing', screenCapture: null,
    dictionary: { phrases: [], variants: [], pending: [], blocked: [] },
    saved: 0, broadcasts: 0, shown: 0, sent: [], pasted: [], failSave: false, failPaste: false,
    saveDict() { if (context.failSave) throw new Error('disk full'); context.saved++; },
    broadcast: () => context.broadcasts++, showOverlay: () => context.shown++,
    sendOverlay: state => context.sent.push(state), overlayWin: overlay,
    overlayEditing: false, vocabularyDirty: false, successTimer: null,
    setTimeout: delay, clearTimeout: cancel,
    ipcMain: { handle: (name, fn) => { handlers[name] = fn; } },
    recordingSessionToken: 1, dictationTiming: {},
    metrics: { markPasteComplete() {} }, style: { autoSendFor: () => '' },
    pasteText: async text => {
      if (context.failPaste) throw new Error('paste failed');
      context.pasted.push(text);
      observers.at(-1)?.emit('Draft: ' + text);
    },
  });
  vm.runInContext(integration + '\n' + pasteFunction, context);
  return { context, observers, handlers, overlay,
    run: code => vm.runInContext(code, context),
    tick(ms) { time += ms; for (const [id, job] of [...timers]) if (job.at <= time) { timers.delete(id); job.fn(); } },
    async prestart() { context.prestartCorrectionLearning(); await Promise.resolve(); },
    async dictate({ prestart = true } = {}) {
      if (prestart) await this.prestart();
      await context.pasteDictation('Use cooper netties today.', 'work');
      context.mode = 'success';
    },
    correct() { observers.at(-1).emit('Draft: Use Kubernetes today.'); this.tick(1800); },
    undo(token) { return handlers['dict-auto-undo']({ sender: overlay.webContents }, token); },
  };
}

(async () => {
  let f = fixture();
  await f.dictate(); f.correct();
  assert.strictEqual(f.context.saved, 1);
  assert.strictEqual(f.context.dictionary.phrases[0].to, 'Kubernetes');
  assert.strictEqual(f.context.dictionary.phrases[0].kind, 'word');
  assert.strictEqual(f.context.mode, 'learned');
  const token = f.context.sent.at(-1).undoToken;
  assert(token);
  const foreign = await f.handlers['dict-auto-undo']({ sender: {} }, token);
  assert.strictEqual(foreign.ok, false);
  assert.strictEqual((await f.undo('stale-token')).ok, false);
  assert.strictEqual((await f.undo(token)).ok, true);
  assert.strictEqual(f.context.dictionary.phrases.length, 0);
  assert.strictEqual(f.observers[0].stopped, true, 'Undo stops relearning');
  assert.strictEqual(f.context.sent.at(-1).text, 'Dictionary addition undone');
  f.tick(1800);
  assert.strictEqual(f.context.mode, 'idle');

  f = fixture(); f.context.settings.autoAddToDictionary = false;
  await f.dictate();
  assert.strictEqual(f.observers.length, 0, 'disabled means no observer process');
  f = fixture(); f.context.style.autoSendFor = () => 'enter'; await f.dictate();
  assert.strictEqual(f.observers[0].stopped, true, 'auto-sent dictations stop the prestarted observer');

  f = fixture();
  await f.dictate({ prestart: false });
  assert.strictEqual(f.context.pasted.length, 1, 'no prestart still pastes immediately');
  assert.strictEqual(f.observers.length, 0, 'paste never starts a new observer');
  assert.match(f.run('lastLearnPath'), /^skipped:no-prestart/);

  f = fixture({ delayedObserver: true });
  const slowObserverPaste = f.dictate();
  // Do not advance fake timers: paste must finish even if observer readiness
  // never arrives. Checking before awaiting also makes a blocked paste fail.
  for (let i = 0; i < 8; i++) await Promise.resolve();
  assert.strictEqual(f.context.pasted.length, 1, 'slow observer never delays paste');
  await slowObserverPaste;
  assert.strictEqual(f.observers[0].stopped, true, 'not-ready observer is abandoned');
  assert.match(f.run('lastLearnPath'), /not-ready/);
  f.observers[0].resolveInitial({ text: 'Draft: Use cooper netties today.', fieldId: 'field', hwnd: '42' });
  f.observers[0].emit('Draft: Use cooper netties today.');
  f.correct();
  assert.strictEqual(f.context.saved, 0, 'late baseline and snapshots cannot teach from a skipped dictation');

  for (const change of ['session', 'hwnd']) {
    f = fixture();
    await f.prestart();
    if (change === 'session') f.context.recordingSessionToken++;
    else f.context.lastHwnd = '43';
    await f.dictate({ prestart: false });
    assert.strictEqual(f.context.pasted.length, 1, 'changed ' + change + ' does not delay paste');
    assert.strictEqual(f.observers.length, 1, 'changed ' + change + ' does not start another observer');
    assert.strictEqual(f.observers[0].stopped, true, 'changed ' + change + ' abandons stale baseline');
    f.correct();
    assert.strictEqual(f.context.saved, 0, 'changed ' + change + ' cannot learn from an old field');
    assert.match(f.run('lastLearnPath'), new RegExp('^skipped:' + change + '-changed'));
  }

  f = fixture();
  f.context.prestartCorrectionLearning();
  // A helper can send readiness and a newer snapshot in one stdout chunk;
  // the newer baseline must survive the readiness Promise microtask.
  f.observers[0].emit('Updated draft: ');
  await Promise.resolve();
  f.context.pasteText = async text => f.observers[0].emit('Updated draft: ' + text);
  await f.dictate({ prestart: false });
  f.observers[0].emit('Updated draft: Use Kubernetes today.');
  f.tick(1800);
  assert.strictEqual(f.context.dictionary.phrases[0]?.to, 'Kubernetes', 'learning anchors against the latest pre-paste baseline');

  f = fixture(); f.context.failPaste = true;
  await assert.rejects(f.dictate(), /paste failed/);
  assert.strictEqual(f.observers[0].stopped, true);
  f = fixture(); await f.dictate(); f.context.failSave = true; f.correct();
  assert.strictEqual(f.context.dictionary.phrases.length, 0, 'failed save rolls back memory');
  assert.strictEqual(f.context.shown, 0, 'never announce an unsaved addition');

  f = fixture(); await f.dictate(); f.correct();
  f.context.failSave = true;
  const receiptToken = f.context.sent.at(-1).undoToken;
  assert.strictEqual((await f.undo(receiptToken)).ok, false);
  assert.strictEqual(f.context.dictionary.phrases.length, 1, 'failed Undo retains dictionary and receipt');
  f.context.failSave = false;
  assert.strictEqual((await f.undo(receiptToken)).ok, true);

  f = fixture(); await f.dictate(); f.correct();
  const expiredToken = f.context.sent.at(-1).undoToken;
  f.tick(8000);
  assert.strictEqual((await f.undo(expiredToken)).ok, false);
  assert.strictEqual(f.context.dictionary.phrases.length, 1);

  f = fixture(); await f.dictate();
  const old = f.observers[0];
  await f.dictate();
  old.emit('Draft: Use Kubernetes today.'); f.tick(1800);
  assert.strictEqual(f.context.dictionary.phrases.length, 0, 'old observer cannot teach newer dictation');
  f.context.stopCorrectionLearning();
  f.observers[1].emit('Draft: Use Kubernetes today.'); f.tick(1800);
  assert.strictEqual(f.context.dictionary.phrases.length, 0, 'turning observation off discards callbacks');

  f = fixture();
  const normalPaste = f.context.pasteText;
  let failOldPaste;
  let enteredOldPaste;
  const entered = new Promise(resolve => { enteredOldPaste = resolve; });
  f.context.pasteText = () => new Promise((_resolve, reject) => { failOldPaste = reject; enteredOldPaste(); });
  await f.prestart();
  const oldPaste = f.context.pasteDictation('Use cooper netties today.', 'work');
  await entered;
  f.context.recordingSessionToken++;
  f.context.pasteText = normalPaste;
  await f.dictate();
  failOldPaste(new Error('old paste failed'));
  await assert.rejects(oldPaste, /old paste failed/);
  assert.strictEqual(f.observers[1].stopped, false, 'late old paste failure cannot stop the new observer');
  f.correct();
  assert.strictEqual(f.context.dictionary.phrases[0].to, 'Kubernetes');
  console.log('ok main auto dictionary: nonblocking readiness, current baseline, stale observer isolation, paste lifecycle, Undo and failure rollback');
})().catch(err => { console.error(err); process.exitCode = 1; });
