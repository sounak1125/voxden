'use strict';

// Production power-event callbacks and overlay bookkeeping with a fake native
// window/clock. This cannot establish physical sleep, TCC or microphone recovery.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const harness = require('./asr-test-harness');
const source = fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8');
const registrations = source.split('\n').filter(line => /^\s*powerMonitor\.on\('(resume|unlock-screen|suspend|lock-screen)'/.test(line));
assert.strictEqual(registrations.length, 4, 'all four production power subscriptions are exercised');

function fixture({ visible = true, destroyed = false, mode = 'idle', editing = false } = {}) {
  const h = harness();
  const power = new EventEmitter();
  const calls = [];
  const window = {
    isDestroyed: () => destroyed,
    isVisible: () => visible,
    setBounds: rect => calls.push(['bounds', { ...rect }]),
    setIgnoreMouseEvents: value => calls.push(['ignore', value]),
    setAlwaysOnTop: (...args) => calls.push(['top', ...args]),
    webContents: { send: (...args) => calls.push(['send', ...args]) },
  };
  Object.assign(h.context, { fixtureWindow: window, fixturePower: power, fixtureNow: 100000, fixtureCalls: calls });
  h.run(`
    Date.now = () => fixtureNow;
    diagLog = (event, fields) => fixtureCalls.push(['diag', event, fields]);
    recreateOverlay = reason => fixtureCalls.push(['recreate', reason]);
    overlayWin = fixtureWindow;
    overlayReady = true;
    overlayRect = { x: 150, y: 300, width: 260, height: 96 };
    mode = ${JSON.stringify(mode)};
    overlayEditing = ${editing};
    recordingSessionToken = 17;
    (() => { const powerMonitor = fixturePower; ${registrations.join('\n')} })();
  `);
  return { h, power, calls, close: h.close };
}

let checks = 0;
async function test(name, work) {
  await work();
  checks++;
  console.log('ok ' + name);
}

(async () => {
  await test('sleep and lock independently suppress health recovery until both are cleared', async () => {
    const f = fixture();
    try {
      for (const event of ['resume', 'unlock-screen', 'suspend', 'lock-screen']) assert.strictEqual(f.power.listenerCount(event), 1);
      f.h.run('overlayHealth.send(fixtureNow - 100000); overlayFrameHealth.send(1, fixtureNow - 100000); overlayFrameHealth.pong(1)');
      f.power.emit('suspend');
      f.power.emit('lock-screen');
      assert.strictEqual(f.h.run('overlaySystemSuspended && overlayScreenLocked'), true);
      for (let i = 0; i < 60; i++) f.h.run('fixtureNow += 1000; overlayHealthTick(fixtureNow)');
      assert.strictEqual(f.calls.some(call => call[0] === 'recreate' || call[0] === 'send'), false, 'asleep/locked time does not ping or replace a renderer');
      f.power.emit('resume');
      assert.strictEqual(f.h.run('overlaySystemSuspended'), false);
      assert.strictEqual(f.h.run('overlayScreenLocked'), true, 'resume cannot unlock the screen');
      f.calls.length = 0;
      for (let i = 0; i < 30; i++) f.h.run('fixtureNow += 1000; overlayHealthTick(fixtureNow)');
      assert.strictEqual(f.calls.some(call => call[0] === 'recreate' || call[0] === 'send'), false);
      f.power.emit('unlock-screen');
      assert.strictEqual(f.h.run('overlaySystemSuspended || overlayScreenLocked'), false);
      assert.strictEqual(f.h.run('overlayHealth.check(fixtureNow).status'), 'ok');
      assert.strictEqual(f.h.run('overlayFrameHealth.check(fixtureNow).stalled'), false);
      f.calls.length = 0;
      f.h.run('overlayHealthTick(fixtureNow)');
      assert.strictEqual(f.calls.some(call => call[0] === 'recreate'), false, 'the first waking tick receives a fresh deadline');
      f.h.run('fixtureNow += HUD_PING_MS; lastHwndTickAt = fixtureNow - HWND_TICK_MS; overlayHealthTick(fixtureNow)');
      assert(f.calls.some(call => call[0] === 'send' && call[1] === 'hud-ping'), 'normal probes restart after waking');
    } finally { await f.close(); }
  });

  await test('unlock before resume leaves the suspended guard in place', async () => {
    const f = fixture();
    try {
      f.power.emit('suspend'); f.power.emit('lock-screen'); f.power.emit('unlock-screen');
      assert.strictEqual(f.h.run('overlayScreenLocked'), false);
      assert.strictEqual(f.h.run('overlaySystemSuspended'), true);
      f.calls.length = 0;
      f.h.run('fixtureNow += 1000; overlayHealthTick(fixtureNow)');
      assert.strictEqual(f.calls.some(call => call[0] === 'send' || call[0] === 'recreate'), false);
      f.power.emit('resume');
      assert.strictEqual(f.h.run('overlaySystemSuspended'), false);
    } finally { await f.close(); }
  });

  await test('wake clears stale drag/hover and forces native input recovery without drifting the bar', async () => {
    for (const [mode, editing, expectedIgnore] of [['idle', false, true], ['idle', true, false], ['arming', false, false], ['recording', false, false], ['transcribing', false, false], ['success', true, false]]) {
      const f = fixture({ mode, editing });
      try {
        f.h.run(`overlayDrag = { timer: 123 }; overlayHover = true; lastCursor = { x: 100, y: 100 }; overlayIgnoreMouse = ${expectedIgnore}; lastHwndTickAt = fixtureNow - 100000`);
        f.power.emit('resume');
        assert.strictEqual(f.h.run('overlayDrag'), null);
        assert.strictEqual(f.h.run('overlayHover'), false);
        assert.strictEqual(f.h.run('lastCursor'), null);
        assert.strictEqual(f.h.run('lastHwndTickAt'), 0);
        assert(f.calls.some(call => call[0] === 'send' && call[1] === 'hud-drag-end'));
        assert.deepStrictEqual(f.calls.filter(call => call[0] === 'ignore'), [['ignore', expectedIgnore]], mode + ': native flag is reasserted even when the cache already matched');
        assert.deepStrictEqual(f.calls.filter(call => call[0] === 'bounds'), [
          ['bounds', { x: 150, y: 299, width: 260, height: 97 }],
          ['bounds', { x: 150, y: 300, width: 260, height: 96 }],
        ]);
        assert(f.calls.some(call => call[0] === 'top' && call[1] === true));
        assert.strictEqual(f.h.run('mode'), mode, 'power bookkeeping does not manufacture a different dictation result');
        assert.strictEqual(f.h.run('recordingSessionToken'), 17);
      } finally { await f.close(); }
    }
  });

  await test('a hidden window stays hidden; missing/destroyed windows are safe during wake', async () => {
    for (const state of ['hidden', 'destroyed', 'missing']) {
      const f = fixture({ visible: state !== 'hidden', destroyed: state === 'destroyed' });
      try {
        if (state === 'missing') f.h.run('overlayWin = null');
        f.power.emit('suspend'); f.power.emit('resume');
        assert.strictEqual(f.h.run('overlaySystemSuspended'), false);
        assert.strictEqual(f.calls.some(call => ['bounds', 'top', 'recreate'].includes(call[0])), false, state + ' window is not shown or resized');
        if (state !== 'hidden') assert.strictEqual(f.calls.some(call => call[0] === 'ignore'), false);
      } finally { await f.close(); }
    }
  });

  await test('repeated sleep/lock cycles refresh deadlines without accumulating stale health misses', async () => {
    const f = fixture();
    try {
      for (let cycle = 0; cycle < 20; cycle++) {
        f.h.run('overlayReady = false; overlayLoadStartedAt = fixtureNow - 100000; overlayHealth.send(fixtureNow - 100000)');
        f.power.emit('lock-screen'); f.power.emit('suspend');
        f.h.run('fixtureNow += 100000');
        f.power.emit('resume'); f.power.emit('unlock-screen');
        assert.strictEqual(f.h.run('overlayLoadStartedAt'), f.h.context.fixtureNow);
        f.h.run('overlayHealthTick(fixtureNow)');
        assert.strictEqual(f.h.run('overlayHealth.check(fixtureNow).status'), 'ok');
      }
      assert.strictEqual(f.calls.some(call => call[0] === 'recreate'), false);
      assert.strictEqual(f.calls.filter(call => call[0] === 'ignore').length, 40);
      assert.strictEqual(f.h.run('overlaySystemSuspended || overlayScreenLocked'), false);
    } finally { await f.close(); }
  });

  console.log('Power lifecycle: ' + checks + ' groups passed (simulated OS events; no physical sleep or microphone claim).');
})().catch(error => { console.error(error); process.exitCode = 1; });
