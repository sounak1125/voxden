'use strict';

// Renderer-only performance probe, with real Chromium CSS/Canvas and synthetic
// meter input. Default: software rendering; --gpu exercises hardware rendering.
// --shader=PATH compares an earlier energy-orb.js inside the same loaded page,
// so concurrent CSS/markup edits cannot confound the shader comparison.
// --style=orb (or classic/ribbon) narrows an optional comparison run.
// --shader-only skips the state matrix and measures deterministic draw inputs.
// No production main process, recording, login registration or user profile is
// used. Results measure renderer tasks, not whole-app/system CPU or ASR speed.
const { app, BrowserWindow, session } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const gpu = process.argv.includes('--gpu');
const shaderArgument = process.argv.find(value => value.startsWith('--shader='));
const shaderFile = shaderArgument ? path.resolve(shaderArgument.slice('--shader='.length)) : null;
const styleArgument = process.argv.find(value => value.startsWith('--style='));
const styles = process.argv.includes('--shader-only') ? []
  : styleArgument ? [styleArgument.slice('--style='.length)] : ['classic', 'ribbon', 'orb'];
if (styles.some(value => !['classic', 'ribbon', 'orb'].includes(value))) throw new Error('Unknown --style');
// Read the pure sizing helper once; importing production main would start
// services. Both compared shaders use this same geometry and loaded page.
const sizingSource = fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8')
  .match(/function overlaySize\(\) \{[\s\S]*?\n\}/);
if (!sizingSource) throw new Error('Could not find production overlay sizing');
const sizeFor = mode => vm.runInNewContext('(' + sizingSource[0] + ')()', { mode, overlayEditing: false });
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'voxden-flow-bench-')));
if (!gpu) app.disableHardwareAcceleration();
const pause = ms => new Promise(done => setTimeout(done, ms));
const sampleMs = 550;
const deadline = setTimeout(() => { console.error('Flow renderer benchmark timed out'); app.exit(1); }, 60000);

app.whenReady().then(async () => {
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, done) => done(false));
  const initial = sizeFor('idle');
  const win = new BrowserWindow({ show: false, width: initial.ww, height: initial.wh, useContentSize: true,
    frame: false, transparent: true, focusable: false, skipTaskbar: true,
    webPreferences: { preload: path.join(__dirname, '../src/preload.js'), contextIsolation: true,
      sandbox: false, backgroundThrottling: false, offscreen: true } });
  await win.loadFile(path.join(__dirname, '../src/overlay.html'));
  const run = code => win.webContents.executeJavaScript(code);
  if (shaderFile) {
    await run('window.benchmarkCurrentShader = window.VoxdenEnergyOrb; true');
    await run(fs.readFileSync(shaderFile, 'utf8'));
    await run(`window.benchmarkEarlierOrb = VoxdenEnergyOrb.create(document.getElementById('energy-orb'));
      window.VoxdenEnergyOrb = window.benchmarkCurrentShader; true`);
  }
  win.webContents.debugger.attach('1.3');
  await win.webContents.debugger.sendCommand('Performance.enable');
  const metrics = async () => Object.fromEntries((await win.webContents.debugger.sendCommand('Performance.getMetrics')).metrics.map(value => [value.name, value.value]));
  await run(`soundsEnabled = false; alwaysShowFlowBar = true; VoxdenFlowMotion.setPreference('full');
    window.benchmarkCounts = { draws: 0, drawMs: 0, frames: 0, frameCallbackMs: 0, meterReads: 0 };
    const benchmarkNativeRaf = window.requestAnimationFrame;
    const benchmarkNativeDraw = energyOrb.draw;
    let benchmarkDrawImplementation = benchmarkNativeDraw;
    window.selectBenchmarkShader = variant => {
      benchmarkDrawImplementation = variant === 'earlier' ? window.benchmarkEarlierOrb.draw : benchmarkNativeDraw;
    };
    window.measureBenchmarkDraws = (variant, processing) => {
      selectBenchmarkShader(variant);
      const draw = frame => benchmarkDrawImplementation({ time: frame / 60, energy: .45, pulse: .3, hover: .2, processing });
      for (let frame = 0; frame < 40; frame++) draw(frame);
      const start = performance.now();
      for (let frame = 0; frame < 160; frame++) draw(frame);
      return { shader: variant, processing, meanMs: (performance.now() - start) / 160,
        canvasWidth: document.getElementById('energy-orb').width };
    };
    window.requestAnimationFrame = callback => benchmarkNativeRaf(stamp => {
      const start = performance.now(); callback(stamp);
      benchmarkCounts.frames++; benchmarkCounts.frameCallbackMs += performance.now() - start;
    });
    energyOrb.draw = options => {
      const start = performance.now(); benchmarkDrawImplementation(options);
      benchmarkCounts.draws++; benchmarkCounts.drawMs += performance.now() - start;
    };
    window.benchmarkAnalyser = { fftSize: 1024, frequencyBinCount: 512, context: { sampleRate: 48000 },
      getFloatTimeDomainData(bytes) { benchmarkCounts.meterReads++; for (let i = 0; i < bytes.length; i++) bytes[i] = .005 * Math.sin(i / 8); },
      getByteFrequencyData(bytes) { bytes.fill(90); } };
    window.finishBenchmark = () => { stopWaveLoop(); stopOrbVisuals(); analyser = null;
      window.requestAnimationFrame = benchmarkNativeRaf; energyOrb.draw = benchmarkNativeDraw;
      if (window.benchmarkEarlierOrb) window.benchmarkEarlierOrb.dispose(); };
    true`);
  const records = [];
  for (const style of styles) {
    for (const state of ['idle', 'arming', 'recording', 'transcribing', 'success', 'error', 'cancel', 'learned', 'hidden']) {
      const geometry = sizeFor(state);
      win.setContentSize(geometry.ww, geometry.wh);
      const message = { success: 'A short test dictation.', error: 'Synthetic microphone error',
        transcribing: 'Transcribing test audio', cancel: 'Cancelled', learned: 'Added to dictionary' }[state] || '';
      await run(`stopWaveLoop(); stopOrbVisuals(); setHud('idle');
        selectBenchmarkShader('${shaderFile ? 'earlier' : 'current'}'); applyFlowBarStyle('${style}');
        orbVisualTime = 0; orbDrawBudget = 0;
        analyser = ${state === 'recording' ? 'window.benchmarkAnalyser' : 'null'};
        successEntryId = '${state === 'success' ? 'benchmark-result' : ''}';
        learnedUndoToken = '${state === 'learned' ? 'benchmark-undo' : ''}';
        setHud('${state === 'hidden' ? 'idle' : state}', ${JSON.stringify(message)});
        ${state === 'hidden' ? 'popOut();' : 'popIn();'} true`);
      await pause(450);
      // Keep the same live state while swapping only draw(). Re-entering a
      // state here would compare differing CSS entrance/morph transitions.
      for (const variant of shaderFile ? ['earlier', 'current'] : ['current']) {
        await run(`selectBenchmarkShader('${variant}'); true`);
        await pause(80);
        await run(`Object.assign(benchmarkCounts, { draws: 0, drawMs: 0, frames: 0, frameCallbackMs: 0, meterReads: 0 }); true`);
        const before = await metrics();
        await pause(sampleMs);
        const after = await metrics();
        const work = Object.fromEntries(['TaskDuration', 'LayoutDuration', 'RecalcStyleDuration', 'LayoutCount', 'RecalcStyleCount']
          .map(key => [key, after[key] - before[key]]));
        records.push({ style, state, shader: variant, geometry, ...await run(`({...benchmarkCounts, dpr: devicePixelRatio,
          visibility: document.visibilityState, canvasWidth: document.getElementById('energy-orb').width})`), ...work });
      }
    }
  }
  await run('stopWaveLoop(); stopOrbVisuals(); analyser = null; true');
  const drawBenchmarks = [];
  for (const variant of shaderFile ? ['earlier', 'current'] : ['current']) {
    for (const processing of [0, .5, 1]) {
      drawBenchmarks.push(await run(`measureBenchmarkDraws('${variant}', ${processing})`));
    }
  }
  await run('finishBenchmark(); true');
  const report = { gpuRequested: gpu, earlierShader: shaderFile, sampleMs,
    electron: process.versions.electron, features: app.getGPUFeatureStatus(), records, drawBenchmarks };
  const folder = path.join(__dirname, '../temp/performance');
  fs.mkdirSync(folder, { recursive: true });
  const output = path.join(folder, 'flow-renderer-' + (gpu ? 'gpu' : 'software') + '-' + Date.now() + '.json');
  fs.writeFileSync(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  console.log('Saved renderer benchmark: ' + output);
  clearTimeout(deadline);
  win.destroy(); app.quit();
}).catch(error => { console.error(error); clearTimeout(deadline); app.exit(1); });
