'use strict';

// Reproduce the shared Windows-motion gate in the real settings and overlay
// pages. The profile, settings store and microphone are isolated. --native
// exercises shown, unfocused Windows surfaces; --gpu keeps hardware rendering.
const { app, BrowserWindow, ipcMain, screen, session } = require('electron');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'voxden-flow-motion-')));
if (!process.argv.includes('--gpu')) app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
const native = process.argv.includes('--native');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const deadline = setTimeout(() => { console.error('Flow motion preference UI timed out'); app.exit(1); }, 45000);
const errors = [];
const saves = [];
let failNextSave = false;
let snapshot = {
  displayName: 'Alex', shortcutLabel: 'Ctrl+Shift+Space', entries: [], phrases: [],
  notifications: [], pendingPhrases: [], writingStyles: {}, autoSend: {},
  alwaysShowFlowBar: true, soundsEnabled: false,
};

function watchErrors(win) {
  win.webContents.on('render-process-gone', (_event, details) => errors.push('Renderer exited: ' + details.reason));
  win.webContents.on('console-message', event => {
    const severity = event.level;
    const text = String(event.message);
    if ((severity === 'error' || Number(severity) >= 3) && !/Content-Security-Policy/.test(text)) errors.push(text);
  });
}

async function fixture(file, width, height) {
  const win = new BrowserWindow({
    show: false, width, height, useContentSize: true, frame: false,
    transparent: file === 'overlay.html', focusable: false, skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, '../src/preload.js'), contextIsolation: true,
      sandbox: false, backgroundThrottling: false, offscreen: !native,
    },
  });
  watchErrors(win);
  await win.loadFile(path.join(__dirname, '../src', file));
  win.webContents.debugger.attach('1.3');
  await win.webContents.executeJavaScript(`
    window.testMicRequests = 0;
    navigator.mediaDevices.getUserMedia = async () => {
      testMicRequests++; throw new Error('This fixture must never request a microphone');
    };
    navigator.mediaDevices.enumerateDevices = async () => [];
    true
  `);
  if (native) win.showInactive();
  return win;
}

async function waitFor(win, expression, message) {
  const until = Date.now() + 2500;
  do {
    if (await win.webContents.executeJavaScript(expression)) return;
    await pause(30);
  } while (Date.now() < until);
  assert.fail(message + ': ' + expression);
}

async function emulateMotion(win, reduced) {
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: reduced ? 'reduce' : 'no-preference' }],
  });
  await waitFor(win, `matchMedia('(prefers-reduced-motion: reduce)').matches === ${reduced}`,
    'Chromium receives the emulated Windows preference');
  await waitFor(win, `VoxdenFlowMotion.systemReduced === ${reduced}`,
    'the controller receives Chromium\'s asynchronous media-change event');
}

app.whenReady().then(async () => {
  // app.html enumerates device labels on a timer and whenever General opens.
  // Those unrelated probes cannot acquire the user's microphone, including
  // during the reload below before the renderer's fixture stub is installed.
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  ipcMain.handle('app-load', () => snapshot);
  ipcMain.handle('settings-set', (_event, patch) => {
    saves.push(patch);
    if (failNextSave) { failNextSave = false; throw new Error('Simulated preference save failure'); }
    snapshot = { ...snapshot, ...patch };
    return snapshot;
  });
  ipcMain.handle('toggle', () => { throw new Error('Motion preferences must never start dictation'); });

  const settings = await fixture('app.html', 1120, 860);
  const settingRun = code => settings.webContents.executeJavaScript(code);
  await waitFor(settings, `typeof window.VoxdenFlowMotion === 'object'
    && !!document.getElementById('flow-motion-select')`, 'settings exposes a usable motion preference');
  await emulateMotion(settings, true);
  await settingRun(`document.getElementById('nav-settings').click();
    document.querySelector('.settings-cat[data-cat="display"]').click();
    document.querySelector('#display-more-options > summary').click();
    document.querySelector('.flow-style-card').scrollIntoView({ block: 'center' }); true`);
  await settings.webContents.debugger.sendCommand('DOM.enable');
  await settings.webContents.debugger.sendCommand('CSS.enable');
  const { root } = await settings.webContents.debugger.sendCommand('DOM.getDocument');
  for (const style of ['island', 'orb']) {
    const { nodeId } = await settings.webContents.debugger.sendCommand('DOM.querySelector', {
      nodeId: root.nodeId, selector: `.flow-style-card[data-flow-style="${style}"]`,
    });
    await settings.webContents.debugger.sendCommand('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: ['hover'] });
  }
  await settingRun(`document.querySelector('.flow-style-card[data-flow-style="orb"]')
      .dispatchEvent(new PointerEvent('pointerenter'));
    window.motionPreviewFrame = () => {
      const canvas = document.getElementById('flow-preview-energy-orb');
      const bytes = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      let hash = 2166136261;
      for (const byte of bytes) hash = Math.imul(hash ^ byte, 16777619);
      return {
        island: {
          transform: getComputedStyle(document.querySelector('.flow-preview-island-cap')).transform,
          animations: document.getAnimations().filter(a => a.effect && a.effect.target
            && a.effect.target.closest('.flow-preview-island')).length,
        },
        orb: hash >>> 0,
      };
    }; true`);
  const settingState = () => settingRun(`({
    preference: VoxdenFlowMotion.preference, reduced: VoxdenFlowMotion.matches,
    system: VoxdenFlowMotion.systemReduced, value: document.getElementById('flow-motion-select').value,
    effective: document.documentElement.dataset.flowMotion,
  })`);
  const selectMotion = async value => {
    const before = saves.length;
    await settingRun(`(() => { const select = document.getElementById('flow-motion-select');
      select.value = '${value}'; select.dispatchEvent(new Event('change', { bubbles: true })); })(); true`);
    await waitFor(settings, `!savingFlowMotion && pendingFlowMotion === null`, 'motion save settles');
    assert.strictEqual(saves.length, before + 1, 'one settings IPC saves each motion choice');
    assert.deepStrictEqual(saves[saves.length - 1], { flowBarMotion: value }, 'the saved patch only changes flow motion');
    await pause(80);
  };
  const checkPreview = async moving => {
    await pause(100);
    const before = await settingRun('motionPreviewFrame()');
    await pause(190);
    const after = await settingRun('motionPreviewFrame()');
    assert.strictEqual(after.island.animations, 0, 'the hovered Island preview runs no animation or transition');
    assert.deepStrictEqual(after.island, before.island, 'Island stays still for every motion preference');
    if (moving) assert.notDeepStrictEqual(after.orb, before.orb, 'Orb preview moves on actual frames');
    else assert.deepStrictEqual(after.orb, before.orb, 'Orb preview remains still in reduced motion');
  };

  assert.deepStrictEqual(await settingState(), {
    preference: 'system', reduced: true, system: true, value: 'system', effective: 'reduced',
  }, 'an existing profile follows Windows reduced motion');
  assert.ok(await settingRun(`document.getElementById('flow-motion-hint').textContent.trim().length > 0`),
    'the settings page explains the effective motion state');
  await checkPreview(false);
  await selectMotion('full');
  assert.deepStrictEqual(await settingState(), {
    preference: 'full', reduced: false, system: true, value: 'full', effective: 'full',
  }, 'On overrides the OS for both CSS and JavaScript previews');
  await checkPreview(true);

  await emulateMotion(settings, false);
  await selectMotion('reduced');
  assert.deepStrictEqual(await settingState(), {
    preference: 'reduced', reduced: true, system: false, value: 'reduced', effective: 'reduced',
  }, 'Reduced stays reduced even when Windows animations are enabled');
  await checkPreview(false);
  failNextSave = true;
  await selectMotion('full');
  assert.strictEqual(snapshot.flowBarMotion, 'reduced', 'a failed save preserves the stored preference');
  assert.strictEqual((await settingState()).preference, 'reduced', 'a failed save restores effective motion');
  assert.strictEqual((await settingState()).value, 'reduced', 'a failed save restores the visible choice');
  assert.strictEqual(await settingRun(`document.getElementById('flow-motion-status').hidden`), false,
    'a failed save explains that the choice did not persist');
  await checkPreview(false);

  await selectMotion('system');
  assert.strictEqual(await settingRun(`document.getElementById('flow-motion-status').hidden`), true,
    'a successful retry clears the failure status');
  await checkPreview(true);
  const savesBeforeSystemChange = saves.length;
  await emulateMotion(settings, true);
  await waitFor(settings, 'VoxdenFlowMotion.matches === true', 'a live OS change reaches system mode');
  await checkPreview(false);
  await emulateMotion(settings, false);
  await waitFor(settings, 'VoxdenFlowMotion.matches === false', 'restoring OS animations resumes system mode');
  await checkPreview(true);
  assert.strictEqual(saves.length, savesBeforeSystemChange, 'OS motion changes never rewrite the user preference');
  await selectMotion('full');
  await new Promise(resolve => {
    settings.webContents.once('did-finish-load', resolve);
    settings.webContents.reload();
  });
  await waitFor(settings, `document.getElementById('flow-motion-select').value === 'full'
    && VoxdenFlowMotion.preference === 'full'`, 'the saved override survives reopening the page');

  const overlay = await fixture('overlay.html', 260, 96);
  const run = code => overlay.webContents.executeJavaScript(code);
  await emulateMotion(overlay, true);
  await run(`soundsEnabled = false; alwaysShowFlowBar = true;
    window.motionMeterReads = 0;
    window.motionMeter = {
      fftSize: 1024, frequencyBinCount: 512, context: { sampleRate: 48000 },
      getFloatTimeDomainData(samples) {
        motionMeterReads++;
        const level = .01 + .12 * (.5 + .5 * Math.sin(motionMeterReads / 5));
        for (let i = 0; i < samples.length; i++) samples[i] = level * Math.sin(i / 8);
      },
      getByteFrequencyData(samples) { samples.fill(90); },
    };
    window.motionSamples = new Float32Array([.125, -.125]);
    true`);
  const motionState = async preference => {
    overlay.webContents.send('state', { flowBarMotion: preference });
    await waitFor(overlay, `VoxdenFlowMotion.preference === '${preference}'`, 'overlay receives motion settings through preload IPC');
  };
  // The processing indicator is the flow bar's one looping CSS animation.
  // Island's spinner owns it; its keyframe name is the overlay's business.
  const loopingIndicator = `document.getAnimations().find(a => a.playState === 'running'
    && a.effect && a.effect.getComputedTiming().iterations === Infinity
    && a.effect.target && a.effect.target.closest('#flow-hit'))`;
  for (const style of ['island', 'orb']) {
    for (const mode of ['idle', 'transcribing', 'recording']) {
      const context = style + ' ' + mode;
      await run(`setHud('idle'); applyFlowBarStyle('${style}'); popIn();
        analyser = ${mode === 'recording' ? 'motionMeter' : 'null'};
        pcmChunks = [motionSamples]; setHud('${mode}'); true`);
      const generation = await run('captureGen');
      await motionState('system');
      assert.strictEqual(await run('waveMotionPreference.matches'), true, context + ': system preference reaches the overlay');
      if (style === 'orb' && mode !== 'recording') {
        await pause(90);
        const before = await run('orbVisualTime');
        await pause(130);
        assert.strictEqual(await run('orbVisualTime'), before, context + ': system reduced motion stops the Orb clock');
      }
      const reads = await run('motionMeterReads');
      await motionState('full');
      assert.strictEqual(await run('waveMotionPreference.matches'), false, context + ': On restores overlay motion');
      assert.strictEqual(await run('document.documentElement.dataset.flowMotion'), 'full', context + ': CSS matches the renderer preference');
      if (style === 'orb') {
        const before = await run('orbVisualTime');
        await waitFor(overlay, `orbVisualTime > ${before}`, context + ': On advances the real Orb frame loop');
      } else if (mode === 'transcribing') {
        const before = await run(`(window.motionIndicator = ${loopingIndicator}) ? motionIndicator.currentTime : null`);
        assert.ok(Number.isFinite(before), context + ': On restores the CSS processing indicator');
        await waitFor(overlay, `motionIndicator.currentTime > ${before}`, context + ': the CSS processing clock advances');
      }
      if (mode === 'recording') await waitFor(overlay, `motionMeterReads > ${reads + 2}`, context + ': recording metering remains live');
      await motionState('reduced');
      assert.strictEqual(await run('waveMotionPreference.matches'), true, context + ': Reduced can be restored while busy');
      if (style === 'orb' && mode !== 'recording') assert.strictEqual(await run('orbVisualRaf'), 0, context + ': Reduced releases the ambient loop');
      if (style === 'island' && mode === 'transcribing') {
        assert.strictEqual(await run(`!${loopingIndicator}`), true, context + ': Reduced stops the looping spinner');
      }
      if (mode === 'recording') {
        const reducedReads = await run('motionMeterReads');
        await waitFor(overlay, `motionMeterReads > ${reducedReads + 2}`, context + ': Reduced keeps essential recording feedback live');
      }
      assert.ok(await run(`hudMode === '${mode}' && captureGen === ${generation}
        && pcmChunks.length === 1 && pcmChunks[0] === motionSamples`), context + ': live preferences preserve capture and mode');
    }
  }
  assert.strictEqual(await run('testMicRequests'), 0, 'overlay preference tests never acquire a microphone');
  assert.deepStrictEqual(errors, [], 'both production pages stay free of renderer errors');
  console.log('Flow motion preference: Windows reduced/full, explicit overrides, still Island and moving Orb previews, live system changes, IPC save rollback, page reload, and Island and Orb overlays in idle/transcribing/recording passed.');
  console.log(JSON.stringify({ native, gpuRequested: process.argv.includes('--gpu'),
    displayCount: screen.getAllDisplays().length, electron: process.versions.electron }));
  for (const win of [settings, overlay]) {
    win.webContents.debugger.detach();
    if (!native) win.webContents.stopPainting();
  }
  await pause(100);
  clearTimeout(deadline);
  setImmediate(() => app.exit(0));
}).catch(error => {
  clearTimeout(deadline);
  console.error(error);
  app.exit(1);
});
