'use strict';

// Production main functions with temporary synthetic history and inert windows.
// Count expensive work as well as timing it: CI speed cannot hide a regression.
const assert = require('assert');
const { performance } = require('perf_hooks');
const harness = require('./asr-test-harness');
async function main() {
const h = harness();
try {
  const messages = [];
  const win = {
    visible: true, minimized: false, destroyed: false,
    isDestroyed() { return this.destroyed; },
    isVisible() { return this.visible; },
    isMinimized() { return this.minimized; },
    webContents: { send(channel, value) { messages.push({ channel, value }); } },
  };
  h.context.performanceWindow = win;
  h.run(`historyWin = performanceWindow;
    history.entries = Array.from({length: 10000}, (_, i) => ({
      id: 'synthetic-' + i, ts: Date.now() - i * 60000, durationMs: 14000,
      text: 'This synthetic dictation contains enough words to measure history processing without using any personal data.'
    }));
    globalThis.performanceSnapshots = 0;
    const originalPerformanceSnapshot = snapshot;
    snapshot = () => { performanceSnapshots++; return originalPerformanceSnapshot(); };
  `);
  const batch = (label, count) => {
    const before = h.run('performanceSnapshots');
    const start = performance.now();
    for (let i = 0; i < count; i++) h.run('broadcast()');
    const ms = performance.now() - start;
    const snapshots = h.run('performanceSnapshots') - before;
    console.log(JSON.stringify({ label, updates: count, snapshots, ms: +ms.toFixed(2) }));
    return snapshots;
  };
  assert.strictEqual(batch('visible 10k history', 3), 3);
  win.visible = false;
  const hidden = batch('hidden 10k history', 20);
  win.visible = true; win.minimized = true;
  const minimized = batch('minimized 10k history', 20);
  if (process.argv.includes('--baseline')) {
    console.log('Baseline only; no regression assertions applied.');
  } else {
    assert.strictEqual(hidden, 0, 'hidden dashboard updates must not compute or serialize history');
    assert.strictEqual(minimized, 0, 'minimized dashboard updates must not compute or serialize history');
    win.minimized = false;
    h.run("settings.displayName = 'Latest background change'; refreshHistoryWindow()");
    assert.strictEqual(messages.at(-1).value.displayName, 'Latest background change');
    const sent = messages.length;
    h.run('refreshHistoryWindow()');
    assert.strictEqual(messages.length, sent, 'show and restore notifications cannot duplicate an unchanged snapshot');
    win.destroyed = true;
    assert.strictEqual(batch('destroyed window', 2), 0);
  }
} finally { await h.close(); }

// Keep the old global mouse-lag fix covered across styles and active states.
// Stationary cursor ticks must neither reinstall native input handling nor
// flood the renderer, and no call may enable the Windows forwarding hook.
for (const style of ['classic', 'ribbon', 'orb']) {
  for (const mode of ['idle', 'arming', 'recording', 'transcribing', 'success', 'error', 'cancel', 'learned']) {
    const f = harness();
    const input = [], cursor = [];
    f.context.performanceOverlay = {
      isDestroyed: () => false, isVisible: () => true,
      setIgnoreMouseEvents(...args) { input.push(args); },
      webContents: { send(channel) { cursor.push(channel); } },
    };
    try {
      f.run(`overlayWin = performanceOverlay; mode = '${mode}'; settings.flowBarStyle = '${style}';
        overlayRect = { x: 0, y: 0, width: 260, height: 84 };
        overlayCursorTick = (() => {
          const screen = { getCursorScreenPoint: () => ({x: 900, y: 500}) };
          return ${f.run('overlayCursorTick.toString()')};
        })();
        for (let i = 0; i < 500; i++) overlayCursorTick();
      `);
      assert.strictEqual(input.length, 1, style + '/' + mode + ' caches successful native input changes');
      assert.deepStrictEqual(input[0], [mode === 'idle'], 'never installs the global forwarding mouse hook');
      assert.deepStrictEqual(cursor, ['hud-cursor'], 'stationary hover sends one message, not one per poll');
    } finally { await f.close(); }
  }
}
console.log('Main performance: all three styles/eight states avoid repeated native mouse calls and cursor IPC.');

}
main().catch(error => { console.error(error); process.exitCode = 1; });
