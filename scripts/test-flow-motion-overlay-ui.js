'use strict';

// Reproduce the cross-PC difference with Chromium's real Windows motion media
// query. Exercise the actual page, CSS, Canvas and preference IPC without a mic.
const { app, BrowserWindow } = require('electron');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'voxden-motion-overlay-')));
app.disableHardwareAcceleration();
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const deadline = setTimeout(() => { console.error('Flow motion overlay timed out'); app.exit(1); }, 60000);

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 260, height: 84, frame: false,
    transparent: true, useContentSize: true,
    webPreferences: { preload: path.join(__dirname, '../src/preload.js'), contextIsolation: true,
      sandbox: false, backgroundThrottling: false, offscreen: true } });
  const errors = [];
  win.webContents.on('console-message', event => {
    if ((event.level === 'error' || Number(event.level) >= 3) && !/Content-Security-Policy/.test(event.message)) {
      errors.push(event.message);
    }
  });
  await win.loadFile(path.join(__dirname, '../src/overlay.html'));
  win.webContents.debugger.attach('1.3');
  const run = code => win.webContents.executeJavaScript(code);
  await run(`
    soundsEnabled = false;
    alwaysShowFlowBar = true;
    window.motionMeterInput = 0;
    window.motionMeterReads = 0;
    window.motionAnalyser = {
      fftSize: 1024, frequencyBinCount: 512, context: { sampleRate: 48000 },
      getFloatTimeDomainData(samples) {
        window.motionMeterReads++;
        for (let i = 0; i < samples.length; i++) samples[i] = Math.SQRT2 * window.motionMeterInput * Math.sin(i * 2 * Math.PI / 128);
      },
      getByteFrequencyData(samples) { samples.fill(window.motionMeterInput ? 100 : 0); },
    };
    window.motionSample = () => {
      const canvas = document.getElementById('energy-orb');
      const bytes = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      let hash = 0;
      for (const byte of bytes) hash = (hash * 31 + byte) | 0;
      const turn = document.getAnimations().find(animation => animation.animationName === 'generation-turn');
      return { bars: waveBars.map(bar => bar.style.transform), ribbon: ribbonWavePath.getAttribute('d'),
        hash, orbTime: orbVisualTime, processingTime: orbProcessingClock, visual: orbVisualRaf,
        reads: window.motionMeterReads, generation: captureGen, mode: hudMode,
        glow: Number(pill.style.getPropertyValue('--voice-glow')), turn: turn ? turn.currentTime : null };
    };
    true
  `);

  for (const systemReduced of [false, true]) {
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: systemReduced ? 'reduce' : 'no-preference' }],
    });
    await pause(40);
    for (const preference of ['system', 'full', 'reduced']) {
      const reduced = preference === 'reduced' || (preference === 'system' && systemReduced);
      // Use the normal preload subscription; applying a patch may arrive in
      // the middle of a dictation and must not restart capture or change mode.
      win.webContents.send('state', { flowBarMotion: preference });
      await pause(40);
      assert.deepStrictEqual(await run(`({ preference: window.VoxdenFlowMotion.preference,
        matches: waveMotionPreference.matches, systemReduced: window.VoxdenFlowMotion.systemReduced,
        css: document.documentElement.dataset.flowMotion })`),
      { preference, matches: reduced, systemReduced, css: reduced ? 'reduced' : 'full' });

      for (const style of ['classic', 'ribbon', 'orb']) {
        const context = `${style}, Windows ${systemReduced ? 'reduced' : 'full'}, preference ${preference}`;
        await run(`setHud('idle'); applyFlowBarStyle('${style}'); popIn();
          window.motionMeterInput = 0; analyser = window.motionAnalyser; setHud('recording'); true`);
        await pause(170);
        const quiet = await run('motionSample()');
        await run('window.motionMeterInput = .007; true');
        await pause(520);
        const first = await run('motionSample()');
        await pause(180);
        const second = await run('motionSample()');
        assert.ok(second.reads > first.reads + 2, context + ': real microphone frames remain active');
        assert.ok(second.glow > quiet.glow + .5, context + ': reduced motion retains live voice feedback');
        assert.strictEqual(second.generation, quiet.generation, context + ': visual preferences never restart capture');
        if (reduced) {
          assert.deepStrictEqual(second.bars, first.bars, context + ': constant sound keeps decorative waves still');
          if (style === 'orb') assert.strictEqual(second.orbTime, first.orbTime, context + ': reduced material clock stays still');
        } else {
          assert.notDeepStrictEqual(second.bars, first.bars, context + ': listening and speech waves animate');
          if (style === 'ribbon') assert.notStrictEqual(second.ribbon, first.ribbon, context + ': Ribbon path moves');
          if (style === 'orb') assert.notStrictEqual(second.hash, first.hash, context + ': actual Orb pixels move');
        }
        win.webContents.send('state', { flowBarMotion: preference });
        await pause(30);
        assert.strictEqual(await run('hudMode'), 'recording', context + ': preference-only snapshots retain recording');

        await run("setHud('transcribing'); analyser = null; true");
        await pause(80);
        const processing = await run('motionSample()');
        await pause(160);
        const nextProcessing = await run('motionSample()');
        assert.strictEqual(nextProcessing.reads, processing.reads, context + ': processing releases the microphone meter');
        if (style === 'orb') {
          assert.strictEqual(nextProcessing.visual > 0, !reduced, context + ': Orb loop follows the effective setting');
          if (reduced) assert.strictEqual(nextProcessing.hash, processing.hash, context + ': reduced processing stays static');
          else assert.notStrictEqual(nextProcessing.hash, processing.hash, context + ': full processing pixels move');
        } else if (reduced) {
          assert.strictEqual(nextProcessing.turn, null, context + ': CSS processing respects reduced motion');
        } else {
          assert.ok(nextProcessing.turn > processing.turn, context + ': CSS processing moves even with Windows effects disabled');
        }
      }
    }
  }
  assert.deepStrictEqual(errors, [], 'motion changes cause no renderer errors');
  win.webContents.debugger.detach();
  win.webContents.stopPainting();
  clearTimeout(deadline);
  console.log('Flow motion overlay: Classic/Ribbon/Orb, Windows full/reduced × System/Full/Reduced, real recording frames, voice feedback, state IPC and CSS/Canvas processing passed.');
  setImmediate(() => app.exit(0));
}).catch(error => { clearTimeout(deadline); console.error(error); app.exit(1); });
