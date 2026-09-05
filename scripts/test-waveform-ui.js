'use strict';

// Drive the real meter with deterministic microphone levels. No microphone,
// dictation engine, or user settings are opened by this test.
const { app, BrowserWindow } = require('electron');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'voxden-waveform-')));
app.disableHardwareAcceleration();
const deadline = setTimeout(() => { console.error('Waveform UI timed out'); app.exit(1); }, 25000);

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 260, height: 84, frame: false, transparent: true, useContentSize: true,
    webPreferences: { preload: path.join(__dirname, '../src/preload.js'), contextIsolation: true, sandbox: false, backgroundThrottling: false, offscreen: true } });
  const errors = [];
  win.webContents.on('console-message', event => {
    if ((event.level === 'error' || Number(event.level) >= 3) && !/Content-Security-Policy/.test(event.message)) errors.push(event.message);
  });
  await win.loadFile(path.join(__dirname, '../src/overlay.html'));
  const run = code => win.webContents.executeJavaScript(code);
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  await run(`alwaysShowFlowBar = true; document.body.classList.add('shown'); setHud('recording'); stopWaveLoop(); true`);
  await pause(300);
  await run(`window.waveTest = (() => {
    function snapshot() {
      const heights = waveBars.map(el => new DOMMatrix(el.style.transform).m22 * 22);
      return {
        glow: Number(pill.style.getPropertyValue('--voice-glow')),
        halo: Number(getComputedStyle(waveStrip, '::before').opacity),
        heights,
        mean: heights.reduce((sum, h) => sum + h, 0) / heights.length,
        width: pill.getBoundingClientRect().width
      };
    }
    function advance(level, seconds, fps = 60) {
      for (let frame = 0; frame < Math.round(seconds * fps); frame++) updateWave(1 / fps, level, null);
      return snapshot();
    }
    function fresh(level, seconds = 0.5, fps = 60) { resetWave(); return advance(level, seconds, fps); }
    return { snapshot, advance, fresh };
  })(); true`);

  const listening = await run('waveTest.fresh(0, 1)');
  const quiet = await run('waveTest.fresh(0.001, 0.2)');
  assert.ok(quiet.glow > 0.2, 'quiet speech lights the halo without crossing the former 0.014 RMS threshold');
  assert.ok(quiet.mean > listening.mean + .5, 'quiet speech visibly lifts the waveform above listening motion');
  assert.strictEqual(quiet.halo, quiet.glow, 'the painted halo uses the same continuous intensity');
  const softer = await run('waveTest.fresh(0.0007, 0.3)');
  assert.ok(softer.glow > 0.15, 'even very low gain input has feedback');
  const normal = await run('waveTest.fresh(0.012, 0.5)');
  assert.ok(normal.glow > quiet.glow && normal.mean > quiet.mean, 'normal speech grows naturally from the quiet response');
  assert.ok(Math.max(...normal.heights) - Math.min(...normal.heights) > 4, 'the waveform has a shaped silhouette');
  assert.ok(await run(`(() => { const first = waveTest.snapshot().heights; const next = waveTest.advance(0.012, .2).heights; return first.some((h, i) => Math.abs(h - next[i]) > .3); })()`), 'voice gives the strip fluid motion');

  const gaps = await run(`(() => {
    resetWave();
    const glows = [];
    for (let phrase = 0; phrase < 6; phrase++) {
      waveTest.advance(.003, .18);
      glows.push(waveTest.advance(0, .1).glow);
    }
    return glows;
  })()`);
  assert.ok(gaps.every(glow => glow > 0.2), 'the halo bridges short pauses between syllables');
  const silent = await run('waveTest.advance(0, 2.5)');
  assert.strictEqual(silent.glow, 0, 'sustained silence fully releases the halo');
  assert.ok(silent.heights.every(h => h >= 3 && h < 6.5), 'silence settles into a shallow listening ripple');
  const drifting = await run('waveTest.advance(0, .5)');
  assert.ok(drifting.heights.some((h, i) => Math.abs(h - silent.heights[i]) > .5), 'listening keeps moving when input is silent');
  for (const level of [0, .012]) {
    const motion = await run(`(() => {
      waveTest.fresh(${level}, 1);
      const peaks = new Set();
      let maxStep = 0;
      let before = waveTest.snapshot().heights;
      for (let frame = 0; frame < 240; frame++) {
        const next = waveTest.advance(${level}, 1 / 60).heights;
        peaks.add(next.indexOf(Math.max(...next)));
        maxStep = Math.max(maxStep, ...next.map((h, i) => Math.abs(h - before[i])));
        before = next;
      }
      return { peaks: peaks.size, maxStep };
    })()`);
    assert.ok(motion.peaks >= 5, 'the crest travels across the strip instead of stretching in place at input ' + level);
    assert.ok(motion.maxStep < 1.2, 'motion stays smooth through phase wraps at input ' + level);
  }
  const afterLoud = await run('waveTest.fresh(.25, 1); waveTest.advance(.002, .5)');
  assert.ok(afterLoud.glow > .15, 'a loud phrase does not suppress the next quiet phrase');

  const rates = [];
  for (const fps of [30, 60, 120]) rates.push(await run(`waveTest.fresh(.005, .6, ${fps})`));
  assert.ok(Math.max(...rates.map(s => s.glow)) - Math.min(...rates.map(s => s.glow)) < .04, 'glow is stable across refresh rates');
  assert.ok(Math.max(...rates.map(s => s.mean)) - Math.min(...rates.map(s => s.mean)) < .4, 'wave timing does not depend on refresh rate');

  const measured = await run(`(() => {
    const samples = new Float32Array(1024);
    for (let i = 0; i < samples.length; i++) samples[i] = .125 + Math.SQRT2 * .0007 * Math.sin(i * 2 * Math.PI / 128);
    const quietRms = waveRms(samples);
    samples.fill(.125);
    return { quietRms, dcRms: waveRms(samples) };
  })()`);
  assert.ok(Math.abs(measured.quietRms - .0007) < .000001, 'float metering retains sub-byte speech detail');
  assert.strictEqual(measured.dcRms, 0, 'DC bias does not produce a false halo');

  // Exercise the requestAnimationFrame path too, so swapping back to the byte
  // API or forgetting to feed the meter fails even if updateWave itself works.
  await run(`window.floatReads = 0;
    analyser = {
      fftSize: 1024, frequencyBinCount: 512, context: { sampleRate: 48000 },
      getFloatTimeDomainData: samples => { window.floatReads++; for (let i = 0; i < samples.length; i++) samples[i] = Math.SQRT2 * .002 * Math.sin(i * 2 * Math.PI / 128); },
      getByteTimeDomainData: () => { throw new Error('Low-precision metering must not return'); },
      getByteFrequencyData: samples => { samples.fill(0); samples.fill(150, 2, 30); }
    }; startWaveLoop(); true`);
  await pause(500);
  assert.ok(await run('floatReads > 2 && waveTest.snapshot().glow > .2'), 'live analyser frames reach the visible waveform');
  await run('stopWaveLoop(); analyser = null; true');

  const shoot = async name => {
    if (!process.argv.includes('--screenshots')) return;
    const folder = path.join(__dirname, '../temp/ui-review');
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'wave-' + name + '.png'), (await win.webContents.capturePage()).toPNG());
  };
  for (const [name, level] of [['silence', 0], ['quiet', .002], ['speaking', .02]]) {
    await run(`waveTest.fresh(${level}, .6); true`);
    await shoot(name);
    if (process.argv.includes('--screenshots')) {
      for (let phase = 1; phase <= 3; phase++) {
        await run(`waveTest.advance(${level}, .2); true`);
        await shoot(name + '-' + phase);
      }
    }
  }
  for (const scale of [1, 1.25, 1.5]) {
    win.setContentSize(Math.round(260 * scale), Math.round(84 * scale));
    win.webContents.setZoomFactor(scale);
    await pause(100);
    const fit = await run(`(() => {
      const baseline = pill.getBoundingClientRect();
      let fits = true;
      for (let frame = 0; frame < 180; frame++) {
        updateWave(1 / 60, frame % 20 < 10 ? 1 : .0007, null);
        for (const bar of waveBars) {
          const rect = bar.getBoundingClientRect();
          fits = fits && rect.top - 3 >= baseline.top && rect.bottom + 3 <= baseline.bottom
            && rect.left - 3 >= baseline.left && rect.right + 3 <= baseline.right;
        }
        fits = fits && Math.abs(pill.getBoundingClientRect().width - baseline.width) < .1;
      }
      return fits;
    })()`);
    assert.ok(fit, 'bars and their halo fit without resizing the capsule at scale ' + scale);
  }
  await run(`setHud('transcribing'); true`);
  assert.strictEqual(await run(`Number(pill.style.getPropertyValue('--voice-glow'))`), 0, 'transcription clears recording glow');
  assert.strictEqual(await run('raf'), 0, 'the waveform loop ends when recording ends');

  win.webContents.debugger.attach('1.3');
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await run(`setHud('recording'); stopWaveLoop(); waveTest.fresh(.005, 2); true`);
  const reducedBefore = await run('waveTest.snapshot()');
  const reducedAfter = await run('waveTest.advance(.005, .5)');
  assert.ok(reducedBefore.heights.every((h, i) => Math.abs(h - reducedAfter.heights[i]) < .05), 'reduced motion keeps level feedback without decorative ripples');
  assert.ok(reducedAfter.glow > .2, 'reduced motion preserves the input indicator');
  const reducedSilent = await run('waveTest.advance(0, 3)');
  const reducedSilentLater = await run('waveTest.advance(0, .5)');
  assert.ok(reducedSilent.heights.every((h, i) => Math.abs(h - reducedSilentLater.heights[i]) < .04), 'reduced motion disables the decorative listening ripple');
  assert.strictEqual(reducedSilentLater.glow, 0, 'reduced motion still releases the halo in silence');
  assert.deepStrictEqual(errors, [], 'renderer stays free of errors');
  console.log('Waveform: travelling crests, quiet input, continuous glow, phrase gaps, listening motion, float analyser, refresh rates, clipping, state cleanup and reduced motion passed.');
  clearTimeout(deadline);
  win.destroy();
  app.quit();
}).catch(error => { console.error(error); clearTimeout(deadline); app.exit(1); });
