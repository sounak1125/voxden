'use strict';

const assert = require('assert');
const { createMediaController } = require('../src/media-controller');
const mainHarness = require('./asr-test-harness');
const tick = () => new Promise(resolve => setImmediate(resolve));

function harness() {
  const calls = [];
  const errors = [];
  const request = (action, ids) => new Promise((resolve, reject) => calls.push({ action, ids, resolve, reject }));
  return { calls, errors, media: createMediaController({
    pause: () => request('pause'), resume: ids => request('resume', ids),
    onError: err => errors.push(err.message),
  }) };
}

async function test(name, fn) {
  await fn();
  console.log('ok', name);
}

async function main() {
  await test('paused/no-session music is never played', async () => {
    const h = harness();
    const begin = h.media.begin(); await tick();
    h.calls[0].resolve([]); await begin;
    await h.media.end(); await h.media.close();
    assert.deepStrictEqual(h.calls.map(c => c.action), ['pause']);
  });

  await test('only successfully paused sessions are restored, once', async () => {
    const h = harness();
    const begin = h.media.begin(); await tick();
    h.calls[0].resolve(['player-a', 'player-a', 'player-b', '__toggle__']); await begin;
    const end = h.media.end(); await tick();
    assert.deepStrictEqual(h.calls[1].ids, ['player-a', 'player-b']);
    h.calls[1].resolve(); await end;
    await h.media.end(); await h.media.close();
    assert.strictEqual(h.calls.length, 2);
  });

  await test('disabled option sends no media commands', async () => {
    const h = harness();
    await h.media.begin(false); await h.media.end(); await h.media.close();
    assert.strictEqual(h.calls.length, 0);
  });

  await test('start-cue preparation finishes before audio is muted', async () => {
    const h = harness();
    let release;
    const preparation = new Promise(resolve => { release = resolve; });
    const begin = h.media.begin(true, preparation); await tick();
    assert.strictEqual(h.calls.length, 0);
    release(); await tick();
    assert.strictEqual(h.calls[0].action, 'pause');
    h.calls[0].resolve([]); await begin;
    await h.media.end(); await h.media.close();
  });

  await test('cancel during start-cue preparation never mutes audio late', async () => {
    const h = harness();
    let release;
    const preparation = new Promise(resolve => { release = resolve; });
    const begin = h.media.begin(true, preparation); await tick();
    const end = h.media.end();
    release();
    await begin; await end; await h.media.close();
    assert.strictEqual(h.calls.length, 0);
  });

  await test('cancel before preparation starts does not touch playback', async () => {
    const h = harness();
    await Promise.all([h.media.begin(), h.media.end()]);
    assert.strictEqual(h.calls.length, 0);
  });

  await test('cancel/error during a slow pause restores it when it finishes', async () => {
    const h = harness();
    const begin = h.media.begin(); await tick();
    const end = h.media.end(); await tick();
    assert.strictEqual(h.calls.length, 1);
    h.calls[0].resolve(['player']); await begin; await tick();
    assert.deepStrictEqual(h.calls[1].ids, ['player']);
    h.calls[1].resolve(); await end;
  });

  await test('a newer dictation suppresses an old queued resume and keeps ownership', async () => {
    const h = harness();
    const first = h.media.begin(); await tick();
    const oldEnd = h.media.end();
    const next = h.media.begin();
    h.calls[0].resolve(['player']); await first; await oldEnd; await tick();
    assert.deepStrictEqual(h.calls.map(c => c.action), ['pause', 'pause']);
    h.calls[1].resolve([]); await next;
    const end = h.media.end(); await tick();
    assert.deepStrictEqual(h.calls[2].ids, ['player']);
    h.calls[2].resolve(); await end;
  });

  await test('a resume already in flight finishes before the next pause and microphone readiness', async () => {
    const h = harness();
    const first = h.media.begin(); await tick();
    h.calls[0].resolve(['player']); await first;
    const oldEnd = h.media.end(); await tick();
    let ready = false;
    const next = h.media.begin().then(() => { ready = true; }); await tick();
    assert.deepStrictEqual(h.calls.map(c => c.action), ['pause', 'resume']);
    assert.strictEqual(ready, false);
    h.calls[1].resolve(); await oldEnd; await tick();
    assert.strictEqual(h.calls[2].action, 'pause');
    assert.strictEqual(ready, false);
    h.calls[2].resolve(['player']); await next;
    assert.strictEqual(ready, true);
    const end = h.media.end(); await tick(); h.calls[3].resolve(); await end;
  });

  await test('a rejected pause does not invent ownership or poison later dictations', async () => {
    const h = harness();
    const first = h.media.begin(); await tick(); h.calls[0].reject(new Error('timeout')); await first;
    await h.media.end();
    const next = h.media.begin(); await tick(); h.calls[1].resolve([]); await next;
    assert.deepStrictEqual(h.errors, ['timeout']);
    assert.deepStrictEqual(h.calls.map(c => c.action), ['pause', 'pause']);
  });

  await test('quit waits for a pending pause and restores once', async () => {
    const h = harness();
    const begin = h.media.begin(); await tick();
    const close = h.media.close();
    assert.strictEqual(h.media.close(), close);
    h.calls[0].resolve(['player']); await begin; await tick();
    assert.deepStrictEqual(h.calls[1].ids, ['player']);
    h.calls[1].resolve(); await close;
    await h.media.begin(); await h.media.end();
    assert.strictEqual(h.calls.length, 2);
  });

  await test('main lifecycle gates capture, survives state refresh, and restores on cancel/error', async () => {
    const h = mainHarness();
    try {
      const states = [];
      h.context.mediaStates = states;
      h.run(`
        sidecarState = 'ready'; mode = 'idle'; settings.soundsEnabled = false;
        showOverlay = () => {}; registerEscape = () => {};
        rememberFocus = () => Promise.resolve();
        refreshTray = () => {};
        overlayWin = {isDestroyed: () => false, webContents: {send: (event, state) => mediaStates.push(state)}};
        startRecording(false);
      `);
      await tick();
      assert.strictEqual(states.at(-1).prepareOnly, true);
      assert.strictEqual(states.at(-1).playStartCue, true);
      h.run('sendOverlay();');
      assert.strictEqual(states.at(-1).prepareOnly, true, 'unrelated status updates must not open the microphone');
      // Media commands go through the long-lived Win32 helper: one process,
      // JSON requests on stdin, JSON replies on stdout. The test plays the
      // helper's part, answering each request in the order it was made.
      const helper = h.launches.find(l => l.args[1].includes('serve'));
      assert(helper, 'the pause starts the helper server rather than a one-shot process');
      assert.strictEqual(h.launches.filter(l => l.args[1].includes('media-pause')).length, 0,
        'no one-shot process is started for a command the server can answer');
      const requests = (action) => helper.proc.stdin.written
        .map(s => JSON.parse(s)).filter(r => r.action === action);
      const reply = (req, out) => helper.proc.stdout.emit('data', JSON.stringify({ id: req.id, out }) + '\n');
      const receipts = 'player\n__endpoint__:ZGVmYXVsdC1zcGVha2Vycw==';
      const resumeIds = 'player,__endpoint__:ZGVmYXVsdC1zcGVha2Vycw==';
      // The hello that proves the class compiled, then the pause.
      reply(requests('get')[0], '1');
      let pauses = requests('media-pause');
      assert.strictEqual(pauses.length, 1);
      reply(pauses[0], receipts); await tick();
      assert.strictEqual(states.at(-1).prepareOnly, false);
      h.run("mode = 'recording'; flashCancel();"); await tick();
      assert.strictEqual(h.run('mode'), 'cancel');
      let resumes = requests('media-resume');
      assert.strictEqual(resumes.length, 1);
      assert.strictEqual(resumes[0].ids, resumeIds);
      // Start again while the old resume is in flight. No new pause or capture yet.
      h.run('startRecording(false);'); await tick();
      assert.strictEqual(requests('media-pause').length, 1);
      assert.strictEqual(states.at(-1).prepareOnly, true);
      reply(resumes[0], ''); await tick();
      pauses = requests('media-pause');
      assert.strictEqual(pauses.length, 2);
      reply(pauses[1], receipts); await tick();
      assert.strictEqual(states.at(-1).prepareOnly, false);
      h.run("mode = 'recording'; requestStop();"); await tick();
      assert.strictEqual(h.run('mode'), 'transcribing');
      assert.strictEqual(requests('media-resume').length, 1,
        'output stays muted until the renderer confirms microphone teardown');
      const captureEnded = h.ipcEvents.get('capture-ended');
      assert(captureEnded, 'capture-ended listener is registered');
      captureEnded({ sender: h.run('overlayWin.webContents') }); await tick();
      resumes = requests('media-resume');
      assert.strictEqual(resumes.length, 2);
      assert.strictEqual(resumes[1].ids, resumeIds);
      h.run("flashError('test');"); await tick();
      assert.strictEqual(requests('media-resume').length, 2,
        'the later result path does not restore owned audio twice');
      reply(resumes[1], ''); await tick();
      // Cancel before pause completes: a late reply must not reopen the mic.
      h.run('startRecording(false);'); await tick();
      h.run('flashCancel();');
      const cancelledAt = states.length;
      pauses = requests('media-pause');
      assert.strictEqual(pauses.length, 3);
      reply(pauses[2], receipts); await tick();
      assert.strictEqual(states.length, cancelledAt);
      resumes = requests('media-resume');
      assert.strictEqual(resumes.length, 3);
      reply(resumes[2], ''); await tick();
      await h.run('backgroundMedia.close()');
      // Every command went through the one helper.
      assert.strictEqual(h.launches.filter(l => l.args[1].includes('serve')).length, 1);
    } finally { h.close(); }
  });
  console.log('all media lifecycle tests passed');
}

main().catch(err => { console.error(err); process.exitCode = 1; });
