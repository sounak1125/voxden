'use strict';

// Native Windows regression: Chromium can answer IPC while RAF delivery is
// stalled. Exercise real CDP suspension, then withhold frame callbacks until a
// native re-show to cover drivers where the slow frame probes cannot restore
// delivery by themselves. The fixture never re-shows the window itself.
const { app, BrowserWindow, globalShortcut, ipcMain } = require('electron');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'voxden-frame-recovery-'));
app.setPath('userData', profile);
app.disableHardwareAcceleration();
Object.defineProperty(app, 'isPackaged', { value: true });
fs.mkdirSync(path.join(profile, 'data'), { recursive: true });
fs.writeFileSync(path.join(profile, 'data', 'settings.json'), JSON.stringify({
  alwaysShowFlowBar: true, soundsEnabled: false, flowBarStyle: 'island',
}));
app.setLoginItemSettings = () => {};
BrowserWindow.prototype.show = function () {};
BrowserWindow.prototype.focus = function () {};
globalShortcut.register = () => true;
globalShortcut.unregister = () => {};
globalShortcut.unregisterAll = () => {};
require('../src/updater').startUpdater = () => {};
if (!process.argv.includes('--hidden')) process.argv.push('--hidden');
process.env.VOXDEN_FLOW_BAR_PING_MS = '300';
process.env.VOXDEN_FLOW_BAR_PING_TIMEOUT_MS = '250';
process.env.VOXDEN_FLOW_BAR_PING_MISSES = '2';
process.env.VOXDEN_FLOW_BAR_FRAME_RECOVERY_MIN_MS = '2000';
require('../src/main');

const deadline = setTimeout(() => { console.error('Flow frame recovery timed out'); app.exit(1); }, 40000);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const events = () => {
  const filename = path.join(profile, 'data', 'flow-bar.log');
  return fs.existsSync(filename)
    ? fs.readFileSync(filename, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
};
const recoveries = () => events().filter(event => event.event === 'overlay-frame-recovery').length;
const healthReplies = { pong: 0, frame: 0 };
ipcMain.on('hud-pong', () => healthReplies.pong++);
ipcMain.on('hud-frame', () => healthReplies.frame++);
async function waitFor(predicate, message, timeoutMs = 6000) {
  const until = Date.now() + timeoutMs;
  do {
    if (await predicate()) return;
    await pause(50);
  } while (Date.now() < until);
  assert.fail(message + '\n' + JSON.stringify({ events: events().slice(-12), healthReplies }));
}

app.whenReady().then(async () => {
  let overlay;
  await waitFor(() => {
    overlay = BrowserWindow.getAllWindows().find(win => win.webContents.getURL().endsWith('/overlay.html'));
    return overlay && !overlay.webContents.isLoading() && overlay.isVisible();
  }, 'overlay becomes visible', 15000);
  const errors = [];
  overlay.webContents.on('console-message', event => {
    if ((event.level === 'error' || Number(event.level) >= 3) && !/Content-Security-Policy/.test(event.message)) errors.push(event.message);
  });
  const run = code => overlay.webContents.executeJavaScript(code);
  const id = overlay.id;
  const bounds = overlay.getBounds();
  overlay.webContents.debugger.attach('1.3');
  await run(`
    window.frameMeterReads = 0;
    window.frameMeter = {
      fftSize: 1024, frequencyBinCount: 512, context: { sampleRate: 48000 },
      getFloatTimeDomainData(samples) {
        frameMeterReads++;
        for (let i = 0; i < samples.length; i++) samples[i] = .01 * Math.sin(i / 8);
      },
      getByteFrequencyData(samples) { samples.fill(90); },
    };
    window.recordingMarker = new Float32Array([.125, -.125]);
    true
  `);
  await pause(1500);
  assert.strictEqual(recoveries(), 0, 'a healthy static Island bar needs no surface recovery');

  for (const [style, mode] of [['island', 'recording'], ['island', 'transcribing'], ['orb', 'transcribing']]) {
    await run(`setHud('idle'); applyFlowBarStyle('${style}');
      pcmChunks = [window.recordingMarker];
      analyser = ${mode === 'recording' ? 'window.frameMeter' : 'null'};
      setHud('${mode}'); popIn(); true`);
    const beforeGeneration = await run('captureGen');
    const before = recoveries();
    const reads = await run('frameMeterReads');
    if (mode === 'recording') {
      await waitFor(async () => await run('frameMeterReads') > reads + 2, 'recording begins with live RAF frames');
    } else {
      await pause(200);
    }

    await overlay.webContents.debugger.sendCommand('Page.setWebLifecycleState', { state: 'frozen' });
    await pause(100);
    await overlay.webContents.debugger.sendCommand('Page.setWebLifecycleState', { state: 'active' });
    // A fresh one-shot frame requested by a health ping can itself wake this
    // compositor. Both natural recovery and native re-show preserve the page.
    const replied = healthReplies.frame;
    await waitFor(() => healthReplies.frame > replied + 1, style + ': actual frames resume after CDP suspension');
    assert.strictEqual(overlay.id, id, style + ': CDP suspension never replaces the page');

    // Model a driver that continues withholding frames despite new probes.
    // Release the queued real callbacks only on production's native show.
    // Unlike stubbing hud-frame IPC, this stalls the live waveform as well.
    await run(`window.nativeRequestFrame = window.requestAnimationFrame;
      window.nativeCancelFrame = window.cancelAnimationFrame;
      window.withheldFrames = new Map();
      window.requestAnimationFrame = callback => {
        const handle = window.nativeRequestFrame(() => {});
        window.withheldFrames.set(handle, callback);
        return handle;
      };
      window.cancelAnimationFrame = handle => {
        window.withheldFrames.delete(handle);
        window.nativeCancelFrame(handle);
      };
      true`);
    overlay.once('show', () => {
      run(`window.requestAnimationFrame = window.nativeRequestFrame;
        window.cancelAnimationFrame = window.nativeCancelFrame;
        for (const callback of window.withheldFrames.values()) window.requestAnimationFrame(callback);
        window.withheldFrames.clear(); true`).catch(error => errors.push(String(error)));
    });
    // The monitor must wait for multiple missing frame acknowledgements while
    // event-loop pongs continue. Its restore operation releases the fault.
    await waitFor(() => recoveries() > before, style + ': production frame monitor detects stalled rendering');
    assert.strictEqual(overlay.id, id, style + ': recovery reuses the existing renderer');
    assert.strictEqual(overlay.isDestroyed(), false, style + ': page and recording survive');
    assert.strictEqual(overlay.isFocused(), false, style + ': recovery preserves the foreground app');
    const afterBounds = overlay.getBounds();
    for (const name of ['x', 'y', 'width', 'height']) {
      assert.ok(Math.abs(afterBounds[name] - bounds[name]) <= 2, style + ': recovery preserves ' + name);
    }
    assert.ok(await run(`hudMode === '${mode}' && captureGen === ${beforeGeneration}
      && pcmChunks.length === 1 && pcmChunks[0] === window.recordingMarker`),
    style + ': native re-show preserves mode, generation and recorded samples');
    if (mode === 'recording') {
      const resumedReads = await run('frameMeterReads');
      await waitFor(async () => await run('frameMeterReads') > resumedReads + 2, 'recovery resumes the existing recording RAF');
    } else if (style === 'orb') {
      const resumedTime = await run('orbProcessingClock');
      await waitFor(async () => await run('orbProcessingClock') > resumedTime, 'recovery resumes the existing Orb processing RAF');
    } else {
      const turnTime = () => run(`document.getAnimations().find(animation => animation.animationName === 'island-spin').currentTime`);
      const resumedTime = await turnTime();
      await waitFor(async () => await turnTime() > resumedTime, 'recovery resumes the Island spinner');
    }
    await pause(2000);
    assert.strictEqual(recoveries(), before + 1, style + ': recovered rendering does not trigger repeated native re-shows');
  }
  assert.ok(!events().some(event => event.event === 'overlay-recreate'), 'a frame-only failure never discards the recording page');
  assert.deepStrictEqual(errors, [], 'recovery produces no renderer errors');
  overlay.webContents.debugger.detach();
  clearTimeout(deadline);
  console.log('Flow frame recovery: native CDP suspension and injected stalled frame delivery recover in place for Island and Orb without resetting samples, mode, geometry or focus.');
  app.exit(0);
}).catch(error => {
  clearTimeout(deadline);
  console.error(error);
  app.exit(1);
});
