'use strict';

// Inspect the real Classic renderer through an entire former idle-scene delay,
// rapid hover reversals, theme/motion preferences and active dictation states.
const { app, BrowserWindow } = require('electron');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'voxden-classic-flow-')));
app.disableHardwareAcceleration();
const deadline = setTimeout(() => { console.error('Classic flow UI timed out'); app.exit(1); }, 45000);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 260, height: 96, frame: false,
    transparent: true, useContentSize: true, webPreferences: {
      preload: path.join(__dirname, '../src/preload.js'), contextIsolation: true,
      sandbox: false, backgroundThrottling: false, offscreen: true,
    } });
  const errors = [];
  win.webContents.on('console-message', event => {
    if ((event.level === 'error' || Number(event.level) >= 3) && !/Content-Security-Policy/.test(event.message)) errors.push(event.message);
  });
  await win.loadFile(path.join(__dirname, '../src/overlay.html'));
  const run = code => win.webContents.executeJavaScript(code);
  await run(`soundsEnabled = false; alwaysShowFlowBar = true; VoxdenFlowMotion.setPreference('full');
    window.classicMicRequests = 0;
    navigator.mediaDevices.getUserMedia = async () => { classicMicRequests++; throw new Error('Unexpected microphone request'); };
    setHud('idle'); popIn();
    window.classicSnapshot = () => {
      const s = getComputedStyle(pill), r = pill.getBoundingClientRect();
      // Windows fractional DPI can quantize a 1px border to .8 CSS pixels.
      return { width: Math.round(r.width), height: Math.round(r.height), fill: s.backgroundColor, border: s.borderColor,
        shadow: s.boxShadow, glow: getComputedStyle(pill, '::after').display,
        animations: document.getAnimations().filter(a => a.playState === 'running').length,
        meter: raf, orb: orbVisualRaf, pulse: document.body.classList.contains('flow-pulse') };
    }; true`);
  await pause(500);
  const resting = await run('classicSnapshot()');
  assert.deepStrictEqual(resting, { width: 40, height: 6, fill: 'rgb(156, 243, 196)',
    border: 'rgb(93, 152, 121)', shadow: 'none', glow: 'none', animations: 0, meter: 0, orb: 0, pulse: false });

  // This crosses the old 22-second character timer on a real clock. Watching
  // animation starts also catches a scene that has already ended by the sample.
  await run(`window.classicIdleAnimations = [];
    document.addEventListener('animationstart', e => classicIdleAnimations.push(e.animationName)); true`);
  await pause(23000);
  assert.deepStrictEqual(await run('classicSnapshot()'), resting, 'idle stays unchanged beyond the former character timer');
  assert.deepStrictEqual(await run('classicIdleAnimations'), [], 'no idle scene or glow started between samples');
  if (process.argv.includes('--screenshots')) {
    await run(`document.documentElement.style.background = '#23272f'; true`);
    await pause(30);
    const folder = path.join(__dirname, '../temp/ui-review');
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'classic-enamel-idle.png'), (await win.webContents.capturePage()).toPNG());
  }

  for (const preference of ['full', 'reduced', 'full']) {
    await run(`VoxdenFlowMotion.setPreference('${preference}'); onCursor({ hover: true }); true`);
    await pause(220);
    const controls = await run(`[pill, settingsBtn, captureScreenBtn, dragHandle].map(e => {
      const s = getComputedStyle(e); return { fill:s.backgroundColor, opacity:s.opacity,
        border:s.borderColor, color:s.color, pointer:s.pointerEvents, visibility:s.visibility,
        duration:s.transitionDuration.split(',').map(parseFloat), delay:s.transitionDelay.split(',').map(parseFloat) };
    })`);
    for (const control of controls) {
      assert.strictEqual(control.fill, 'rgb(0, 0, 0)', 'every hover control is opaque black');
      assert.strictEqual(control.opacity, '1');
      assert.strictEqual(control.border, 'rgb(69, 69, 69)');
      assert.strictEqual(control.color, 'rgb(255, 255, 255)');
      assert.strictEqual(control.pointer, 'auto');
      assert.strictEqual(control.visibility, 'visible');
      assert.ok(control.duration.every(n => n <= (preference === 'reduced' ? .001 : .14)), 'no slower property trails the reveal');
      assert.ok(control.delay.every(n => n === 0), 'controls reveal together');
    }
    if (process.argv.includes('--screenshots') && preference === 'full') {
      fs.writeFileSync(path.join(__dirname, '../temp/ui-review/classic-black-controls.png'), (await win.webContents.capturePage()).toPNG());
    }
    // Reverse mid-flight repeatedly; pointer capture must never latch open.
    for (let i = 0; i < 8; i++) {
      await run(`onCursor({ hover: ${i % 2 === 0 ? 'false' : 'true'} }); true`);
      await pause(35);
    }
    await run('onCursor({ hover: false }); true');
    await pause(250);
    assert.deepStrictEqual(await run('classicSnapshot()'), resting, preference + ' settles exactly after rapid reversals');
  }

  for (const mode of ['arming', 'recording', 'transcribing', 'success', 'error', 'cancel', 'learned']) {
    await run(`setHud('${mode}', 'Preview'); true`);
    await pause(170);
    assert.strictEqual(await run("getComputedStyle(pill, '::after').display"), 'none', mode + ' has no glow layer');
  }
  await run(`setHud('idle'); applyFlowBarStyle('ribbon'); applyFlowBarStyle('classic'); true`);
  await pause(300);
  assert.deepStrictEqual(await run('classicSnapshot()'), resting, 'returning from Ribbon does not retain its pulse');
  assert.strictEqual(await run('classicMicRequests'), 0, 'decorative changes never open the microphone');
  assert.deepStrictEqual(errors, [], 'no renderer errors');
  win.destroy();
  clearTimeout(deadline);
  console.log('Classic flow: 40px enamel, opaque controls, shared 140ms reveal, rapid reversals, quiet idle past 22 seconds, no glow, style switching and reduced motion passed.');
  app.exit(0);
}).catch(error => { console.error(error); clearTimeout(deadline); app.exit(1); });
