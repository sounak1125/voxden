'use strict';

// Run the real overlay with an isolated profile. Idle characters must remain
// decorative, finish on their own, and yield immediately to actual dictation.
const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'voxden-idle-face-')));
app.disableHardwareAcceleration();
const deadline = setTimeout(() => { console.error('Idle face UI test timed out'); app.exit(1); }, 45000);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const variants = ['talk', 'sleep'];
const decorations = ['.idle-hand-mic', '.idle-mouth', '.idle-snooze', '.idle-startle'];

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 260, height: 84, frame: false,
    transparent: true, useContentSize: true,
    webPreferences: { preload: path.join(__dirname, '../src/preload.js'), contextIsolation: true,
      sandbox: false, backgroundThrottling: false, offscreen: true } });
  const errors = [];
  let toggles = 0;
  ipcMain.handle('toggle', () => { toggles++; return { mode: 'idle' }; });
  win.webContents.on('console-message', (event, level, message) => {
    const severity = event && event.level !== undefined ? event.level : level;
    const text = event && event.message !== undefined ? event.message : message;
    if ((severity === 'error' || Number(severity) >= 3) && !/Content-Security-Policy/.test(String(text))) errors.push(String(text));
  });
  await win.loadFile(path.join(__dirname, '../src/overlay.html'));
  const evaluate = code => win.webContents.executeJavaScript(code);
  await evaluate(`window.testMicRequests = 0;
    navigator.mediaDevices.getUserMedia = async () => { window.testMicRequests++; throw new Error('Idle animation requested microphone'); };
    soundsEnabled = false; true`);

  async function start(variant, open = true) {
    await evaluate(`resetIdleFace(); overInteractive = false; alwaysShowFlowBar = true;
      document.body.classList.remove('hiding', 'entering'); document.body.classList.add('shown');
      setHud('idle'); resetIdleFace(); nextIdleFaceVariant = ${JSON.stringify(variant)};
      startIdleFace(); true`);
    if (open) await pause(360);
  }
  const state = () => evaluate(`({ playing: idleFacePlaying, steps: idleFaceSteps.length,
    scheduled: !!idleFaceTimer, classes: [...document.body.classList],
    face: document.body.classList.contains('flow-face'),
    open: document.body.classList.contains('flow-face-open') })`);
  function assertStopped(snapshot, label, scheduled = false) {
    assert.strictEqual(snapshot.playing, false, label + ': playback stops');
    assert.strictEqual(snapshot.steps, 0, label + ': no delayed face steps remain');
    assert.strictEqual(snapshot.scheduled, scheduled, label + ': scheduling follows visibility and interaction');
    assert.ok(!snapshot.classes.some(name => ['flow-face', 'flow-face-open', 'flow-talking', 'flow-sleeping'].includes(name)), label + ': face classes are removed');
  }
  async function shoot(name) {
    if (!process.argv.includes('--screenshots')) return;
    const folder = path.join(__dirname, '../temp/ui-review');
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, name + '.png'), (await win.webContents.capturePage()).toPNG());
  }

  // A normal idle cycle eventually offers every character, without replacing
  // the older expressions or starving either new animation.
  const cycle = await evaluate(`(() => {
    alwaysShowFlowBar = true; document.body.classList.add('shown'); setHud('idle');
    resetIdleFace(); const seen = []; nextIdleFaceVariant = 'talk';
    for (let i = 0; i < 12; i++) {
      seen.push(nextIdleFaceVariant); startIdleFace(); finishIdleFace(); resetIdleFace();
    }
    return seen;
  })()`);
  for (const variant of ['talk', 'sleep', 'look', 'listen', 'curious', 'wink']) {
    assert.ok(cycle.includes(variant), variant + ' appears in the idle rotation: ' + cycle.join(', '));
  }

  for (const variant of variants) {
    await start(variant);
    let snapshot = await state();
    assert.ok(snapshot.face && snapshot.open && snapshot.playing, variant + ' opens naturally');
    assert.ok(snapshot.classes.includes(variant === 'talk' ? 'flow-talking' : 'flow-sleeping'));
    const inert = await evaluate(`(${JSON.stringify(decorations)}).map(selector => {
      const element = document.querySelector(selector);
      return { selector, exists: !!element, inert: !!element && getComputedStyle(element).pointerEvents === 'none',
        hiddenFromAT: !!element && !!element.closest('[aria-hidden="true"]') };
    })`);
    for (const item of inert) assert.ok(item.exists && item.inert && item.hiddenFromAT,
      item.selector + ' must remain a noninteractive decoration: ' + JSON.stringify(item));
    const animations = await evaluate(`document.getAnimations().filter(a => a instanceof CSSAnimation && a.animationName.startsWith('idle'))
      .map(a => ({ name: a.animationName, duration: a.effect.getComputedTiming().endTime }))`);
    assert.ok(animations.length > 0, variant + ' has visible character animation');
    assert.ok(animations.every(animation => Number.isFinite(animation.duration) && animation.duration > 0), variant + ' animations are finite');
    const finishBy = Date.now() + 8000;
    while ((await state()).playing && Date.now() < finishBy) await pause(120);
    snapshot = await state();
    assertStopped(snapshot, variant + ' completes naturally', true);
    await pause(300);
    const rest = await evaluate(`(() => { const box = pill.getBoundingClientRect();
      return { width: box.width, height: box.height, micRequests: window.testMicRequests }; })()`);
    assert.ok(rest.width > 40 && rest.width < 65 && rest.height < 10, variant + ' returns to the small resting bar');
    assert.strictEqual(rest.micRequests, 0, 'pretend talking never opens the microphone');
  }

  // Interrupt both the entrance timer and an already-visible character. A
  // stale timer must never put a robot back over recording or hover controls.
  for (const variant of variants) {
    for (const open of [false, true]) {
      for (const action of ['onCursor({ hover: true })', "setHud('recording')", "setHud('transcribing')", 'popOut()']) {
        await start(variant, open);
        await evaluate(action + '; true');
        assertStopped(await state(), variant + ' interrupted by ' + action);
        await pause(open ? 30 : 280);
        assertStopped(await state(), variant + ' stays interrupted by ' + action);
      }
    }
  }

  // Sample the actual CSS timeline at several phases. Use CSS play-state and
  // delay: calling Animation.pause()/play()/currentTime detaches animations
  // from their stylesheet lifecycle in Chromium and would taint cleanup checks.
  for (const scale of [1, 1.25, 1.5]) {
    win.setContentSize(Math.round(260 * scale), Math.round(84 * scale));
    win.webContents.setZoomFactor(scale);
    for (const variant of variants) {
      await start(variant);
      const sampled = await evaluate(`(() => {
        const animations = document.getAnimations().filter(a => a instanceof CSSAnimation && a.animationName.startsWith('idle'));
        window.testIdleFrames = animations.map(a => {
          const element = a.effect.target;
          const playState = element.style.animationPlayState;
          const delay = element.style.animationDelay;
          element.style.animationPlayState = 'paused';
          void getComputedStyle(element).animationPlayState;
          return { element, playState, delay, localTime: a.currentTime, duration: a.effect.getTiming().duration };
        });
        const capsule = pill.getBoundingClientRect();
        const diagnostics = [];
        const states = [];
        for (const fraction of [0, .12, .3, .5, .66, .78, .9, 1]) {
          window.testIdleFrames.forEach(frame => { frame.element.style.animationDelay = (frame.localTime - frame.duration * fraction) + 'ms'; });
          const box = pill.getBoundingClientRect();
          if (Math.abs(box.left - capsule.left) > .15 || Math.abs(box.top - capsule.top) > .15
            || Math.abs(box.width - capsule.width) > .15 || Math.abs(box.height - capsule.height) > .15) diagnostics.push('capsule moved at ' + fraction);
          const visible = [];
          for (const selector of ${JSON.stringify(decorations)}) {
            const root = document.querySelector(selector);
            for (const element of [root, ...root.querySelectorAll('*')]) {
              let opacity = 1;
              for (let node = element; node instanceof Element; node = node.parentElement) opacity *= Number(getComputedStyle(node).opacity);
              if (opacity < .02) continue;
              const rect = element.getBoundingClientRect();
              if (rect.width && rect.height && (rect.left < 1 || rect.right > innerWidth - 1 || rect.top < 1 || rect.bottom > innerHeight - 1)) {
                diagnostics.push(selector + ' clipped at ' + fraction + ': ' + JSON.stringify(rect.toJSON()));
              }
              visible.push(selector);
            }
          }
          states.push({ fraction, visible: [...new Set(visible)], eyes: [...document.querySelectorAll('.idle-eye')].map(e => getComputedStyle(e).transform) });
        }
        return { diagnostics, states };
      })()`);
      assert.deepStrictEqual(sampled.diagnostics, [], variant + ' stays contained and stable at scale ' + scale);
      const shown = new Set(sampled.states.flatMap(item => item.visible));
      for (const selector of variant === 'talk' ? ['.idle-hand-mic', '.idle-mouth'] : ['.idle-snooze', '.idle-startle']) {
        assert.ok(shown.has(selector), variant + ' visibly uses ' + selector + ' during its sequence');
      }
      if (variant === 'sleep') {
        assert.ok(new Set(sampled.states.map(item => JSON.stringify(item.eyes))).size > 2,
          'sleep changes the eye expression through sleep and waking');
      }
      if (scale === 1) {
        for (const [fraction, label] of variant === 'talk' ? [[.35, 'talking']] : [[.35, 'sleeping'], [.68, 'surprised']]) {
          await evaluate(`window.testIdleFrames.forEach(frame => {
            frame.element.style.animationDelay = (frame.localTime - frame.duration * ${fraction}) + 'ms';
          }); true`);
          await shoot('flow-idle-' + label);
        }
      }
      await evaluate(`resetIdleFace(); window.testIdleFrames.forEach(frame => {
        frame.element.style.animationPlayState = frame.playState;
        frame.element.style.animationDelay = frame.delay;
      }); window.testIdleFrames = []; true`);
      const remaining = await evaluate(`document.getAnimations().filter(a => a instanceof CSSAnimation && a.animationName.startsWith('idle'))
        .map(a => ({ name: a.animationName, state: a.playState, target: a.effect.target.className,
          css: getComputedStyle(a.effect.target).animationName }))`);
      assert.deepStrictEqual(remaining, [], 'reset removes the CSS-owned character animations: ' + JSON.stringify(remaining));
    }
  }

  // Changing the OS preference mid-performance must work as well as launching
  // with reduced motion already enabled.
  win.webContents.debugger.attach('1.3');
  for (const variant of variants) {
    await start(variant);
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await pause(100);
    assertStopped(await state(), variant + ' stops when reduced motion is enabled');
    await evaluate(`startIdleFace(); true`);
    assertStopped(await state(), variant + ' cannot restart under reduced motion');
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
    await pause(50);
  }
  await evaluate(`resetIdleFace(); alwaysShowFlowBar = false; syncFlowVisual(); startIdleFace(); true`);
  assertStopped(await state(), 'disabled persistent bar does not animate');
  assert.strictEqual(await evaluate('window.testMicRequests'), 0, 'no idle behavior accesses the microphone');
  assert.strictEqual(toggles, 0, 'idle behavior does not issue a record command');
  assert.deepStrictEqual(errors, [], 'renderer stays free of errors');
  win.webContents.debugger.detach();
  win.webContents.stopPainting();
  await pause(100);
  clearTimeout(deadline);
  console.log('Idle face UI: talking/sleeping cycle, natural completion, cancellation, inert decorations, stable geometry at 3 scales, and live reduced motion passed.');
  // This isolated fixture has no application shutdown handlers to exercise.
  // Exit on a fresh main-loop turn after stopping offscreen painting: destroying
  // the last OSR window inside this promise can re-enter V8 during native view
  // teardown in Electron 36 and crash after every assertion has already passed.
  setImmediate(() => app.exit(0));
}).catch(error => { console.error(error); clearTimeout(deadline); app.exit(1); });
