'use strict';

// Exercise the actual frame scheduler through repeated dictations, interrupted
// entrances, hide/reveal and renderer suspension. Only the microphone samples
// are synthetic; no test drives updateWave or advances an animation clock.
// Pass --native to also exercise a shown native window instead of offscreen
// rendering. It uses an isolated profile and never takes keyboard focus.
const { app, BrowserWindow } = require('electron');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'voxden-flow-animation-')));
app.disableHardwareAcceleration();
const deadline = setTimeout(() => { console.error('Flow animation lifecycle timed out'); app.exit(1); }, 45000);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false, width: 260, height: 96, frame: false, transparent: true, useContentSize: true,
    webPreferences: {
      preload: path.join(__dirname, '../src/preload.js'), contextIsolation: true,
      sandbox: false, backgroundThrottling: false, offscreen: !process.argv.includes('--native'),
    },
  });
  const errors = [];
  win.webContents.on('console-message', event => {
    if ((event.level === 'error' || Number(event.level) >= 3) && !/Content-Security-Policy/.test(event.message)) {
      errors.push(event.message);
    }
  });
  win.webContents.on('render-process-gone', (_event, details) => errors.push('Renderer exited: ' + details.reason));
  await win.loadFile(path.join(__dirname, '../src/overlay.html'));
  if (process.argv.includes('--native')) win.showInactive();
  win.webContents.debugger.attach('1.3');
  const run = code => win.webContents.executeJavaScript(code);
  const waitFor = async (predicate, message) => {
    const until = Date.now() + 1800;
    do {
      if (await run(predicate)) return;
      await pause(30);
    } while (Date.now() < until);
    console.error(await run(`({ hidden: document.hidden, visibility: document.visibilityState, snapshot: animationSnapshot() })`));
    assert.fail(message);
  };
  await run(`
    soundsEnabled = false;
    alwaysShowFlowBar = true;
    window.meterReads = 0;
    window.meterInput = 0;
    window.lifecycleAnalyser = {
      fftSize: 1024, frequencyBinCount: 512, context: { sampleRate: 48000 },
      getFloatTimeDomainData(samples) {
        window.meterReads++;
        for (let i = 0; i < samples.length; i++) {
          samples[i] = Math.SQRT2 * window.meterInput * Math.sin(i * 2 * Math.PI / 128);
        }
      },
      getByteFrequencyData(samples) { samples.fill(window.meterInput ? 100 : 0); },
    };
    window.animationSnapshot = () => {
      const canvas = document.getElementById('energy-orb');
      const bytes = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      let hash = 0;
      let covered = 0;
      for (let i = 0; i < bytes.length; i++) hash = (hash * 31 + bytes[i]) | 0;
      for (let i = 3; i < bytes.length; i += 4) if (bytes[i] > 128) covered++;
      const turn = document.getAnimations().find(animation => animation.animationName === 'island-spin');
      return {
        mode: hudMode, reads: window.meterReads, wave: raf, visual: orbVisualRaf,
        clock: waveClock, orbTime: orbVisualTime, processingTime: orbProcessingClock,
        glow: Number(pill.style.getPropertyValue('--voice-glow')),
        bars: waveBars.map(element => element.style.transform),
        hash, covered,
        turn: turn ? turn.currentTime : null,
        classes: [...document.body.classList],
      };
    };
    true
  `);

  for (const reduced of [false, true]) {
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: reduced ? 'reduce' : 'no-preference' }],
    });
    await waitFor(`waveMotionPreference.matches === ${reduced}`, 'motion preference reaches the real page');
    for (const style of ['island', 'orb']) {
      const context = style + (reduced ? ' reduced motion' : ' full motion');
      await run(`setHud('idle'); applyFlowBarStyle('${style}'); popIn(); true`);

      // Re-enter before popIn has ended. This resembles quick hotkey use and
      // state snapshots arriving together on slower machines.
      await run(`popOut(); popIn(); setHud('arming'); popIn(); true`);
      await waitFor(`!document.body.classList.contains('entering') && !document.body.classList.contains('hiding')`,
        context + ': interrupted entrance releases its animation classes');

      for (const outcome of ['success', 'error', 'cancel']) {
        await run(`analyser = window.lifecycleAnalyser; window.meterInput = 0; setHud('recording'); true`);
        const listening = await run('animationSnapshot()');
        await waitFor(`window.meterReads > ${listening.reads + 2}`, context + ': recording starts its frame loop');
        if (!reduced) {
          const moving = await run('animationSnapshot()');
          assert.notDeepStrictEqual(moving.bars, listening.bars, context + ': listening bars move on real frames');
        }
        await run('window.meterInput = .008; true');
        await waitFor(`Number(pill.style.getPropertyValue('--voice-glow')) > .5`, context + ': speech reaches the meter');
        const speech = await run('animationSnapshot()');
        assert.ok(speech.wave > 0, context + ': recording owns a live frame callback');
        assert.strictEqual(speech.visual, 0, context + ': recording has no competing Orb frame loop');
        if (style === 'orb') assert.ok(speech.covered > 100, context + ': speech paints the Orb on software rendering');

        // Suspend Chromium and re-show the native surface, as when an overlay
        // is restored. In this isolated fixture, CDP's active state alone
        // leaves even independent RAFs suspended; the show lifecycle restores
        // frame delivery. Production also issues slow one-shot frame probes.
        // The app's already-pending callback must then resume without a reset.
        if (outcome === 'success') {
          await win.webContents.debugger.sendCommand('Page.setWebLifecycleState', { state: 'frozen' });
          await pause(100);
          await win.webContents.debugger.sendCommand('Page.setWebLifecycleState', { state: 'active' });
          win.hide();
          win.showInactive();
          const resumed = await run('animationSnapshot()');
          await waitFor(`window.meterReads > ${resumed.reads + 2}`, context + ': metering resumes after page suspension');
        }

        await run(`setHud('transcribing'); analyser = null; true`);
        const processing = await run('animationSnapshot()');
        assert.strictEqual(processing.wave, 0, context + ': stopping speech cancels the recording callback');
        await pause(140);
        const processingNext = await run('animationSnapshot()');
        assert.strictEqual(processingNext.reads, processing.reads, context + ': transcription never reads the old microphone');
        if (style === 'orb') {
          assert.strictEqual(processingNext.visual > 0, !reduced, context + ': processing follows the motion preference');
          if (reduced) assert.strictEqual(processingNext.hash, processing.hash, context + ': processing remains static');
          else assert.ok(processingNext.processingTime > processing.processingTime, context + ': processing advances on real frames');
        } else if (!reduced) {
          assert.ok(processingNext.turn > processing.turn, context + ': the transcription spinner advances');
        }

        // Hide while ASR is still working, then reveal the same state. Main
        // can do this around screen capture or a window visibility recovery.
        await run('popOut(); true');
        await waitFor(`!document.body.classList.contains('hiding')`, context + ': exit completes');
        assert.strictEqual(await run('orbVisualRaf'), 0, context + ': hidden processing stops the Orb callback');
        // Island's spinner only turns while the bar is on screen.
        assert.strictEqual((await run('animationSnapshot()')).turn, null, context + ': hidden processing stops the spinner');
        await run('popIn(); setHud(\'transcribing\'); true');
        if (style === 'orb' && !reduced) {
          const revealed = await run('orbProcessingClock');
          await waitFor(`orbProcessingClock > ${revealed}`, context + ': reveal resumes processing motion');
        } else if (!reduced) {
          await waitFor('animationSnapshot().turn > 0', context + ': reveal resumes the spinner');
        }
        await run(`setHud('${outcome}', 'Outcome'); setHud('idle'); true`);
        const idle = await run('animationSnapshot()');
        assert.strictEqual(idle.wave, 0, context + ': ' + outcome + ' releases speech animation');
        assert.strictEqual(idle.glow, 0, context + ': ' + outcome + ' clears speech glow');
        assert.strictEqual(idle.visual > 0, style === 'orb' && !reduced, context + ': ' + outcome + ' restores the correct idle loop');
      }
    }
  }
  assert.deepStrictEqual(errors, [], 'animation transitions have no renderer errors');
  win.webContents.debugger.detach();
  win.destroy();
  clearTimeout(deadline);
  console.log('Flow animation lifecycle: repeated recordings, outcomes, real frames, software rendering, interrupted entrances, hide/reveal, page suspension and reduced motion passed.');
  app.exit(0);
}).catch(error => {
  clearTimeout(deadline);
  console.error(error);
  app.exit(1);
});
