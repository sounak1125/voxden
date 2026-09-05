'use strict';

// Exercise the real overlay and preference controls in an isolated Electron
// profile. Microphone input is synthetic; this never starts an ASR engine.
const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'voxden-flow-styles-')));
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {}); // The settings fixture follows the overlay fixture.
const deadline = setTimeout(() => { console.error('Flow styles UI timed out'); app.exit(1); }, 75000);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const styles = ['classic', 'ribbon', 'orb'];
const errors = [];
const actions = [];
const saves = [];
let saveDelay = 0;
let failNextSave = false;
let snapshot = {
  displayName: 'Alex', shortcutLabel: 'Ctrl+Shift+Space', entries: [], phrases: [],
  notifications: [], pendingPhrases: [], writingStyles: {}, autoSend: {},
  alwaysShowFlowBar: true, soundsEnabled: false,
};

function windowOptions(width, height) {
  return {
    show: false, width, height, frame: false, transparent: true, useContentSize: true,
    webPreferences: {
      preload: path.join(__dirname, '../src/preload.js'), contextIsolation: true,
      sandbox: false, backgroundThrottling: false, offscreen: true,
    },
  };
}
function watchErrors(win) {
  win.webContents.on('render-process-gone', (_event, details) => errors.push('Renderer process exited: ' + details.reason));
  win.webContents.on('console-message', (event, level, message) => {
    const severity = event.level === undefined ? level : event.level;
    const text = event.message === undefined ? message : event.message;
    if ((severity === 'error' || Number(severity) >= 3) && !/Content-Security-Policy/.test(String(text))) errors.push(String(text));
  });
}
async function screenshot(win, name) {
  if (!process.argv.includes('--screenshots')) return;
  await pause(40); // Let the offscreen surface paint the latest synthetic frame.
  const folder = path.join(__dirname, '../temp/ui-review');
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'flow-style-' + name + '.png'), (await win.webContents.capturePage()).toPNG());
  if (process.argv.includes('--desktop-background') && /^(orb|ribbon)-/.test(name)) {
    // Transparent PNG viewers can display unpremultiplied, near-zero-alpha
    // colours as bright fringes. Also review Chromium's actual composition.
    await win.webContents.executeJavaScript("document.documentElement.style.background = '#191d23'; true");
    await pause(45);
    fs.writeFileSync(path.join(folder, 'flow-style-' + name + '-desktop.png'), (await win.webContents.capturePage()).toPNG());
    await win.webContents.executeJavaScript("document.documentElement.style.removeProperty('background'); true");
  }
}

app.whenReady().then(async () => {
  ipcMain.on('overlay-settings', () => actions.push('settings'));
  ipcMain.on('hud-cancel', () => actions.push('cancel'));
  ipcMain.on('hud-confirm', () => actions.push('confirm'));
  ipcMain.handle('toggle', () => { actions.push('toggle'); return { mode: 'idle' }; });
  ipcMain.handle('app-load', () => snapshot);
  ipcMain.handle('settings-set', async (_event, patch) => {
    saves.push(patch);
    if (saveDelay) await pause(saveDelay);
    if (failNextSave) { failNextSave = false; throw new Error('Simulated preference save failure'); }
    snapshot = { ...snapshot, ...patch };
    return snapshot;
  });

  if (!process.argv.includes('--settings-only')) {
  const overlay = new BrowserWindow(windowOptions(260, 84));
  watchErrors(overlay);
  await overlay.loadFile(path.join(__dirname, '../src/overlay.html'));
  const run = code => overlay.webContents.executeJavaScript(code);
  const assertTransparentOrbShell = async mode => {
    const shell = await run(`(() => { const css = getComputedStyle(pill);
      return { color: css.backgroundColor, image: css.backgroundImage, shadow: css.boxShadow }; })()`);
    const alpha = shell.color.match(/^rgba\([^,]+,[^,]+,[^,]+,\s*([\d.]+)\)$/);
    assert.ok(alpha && Number(alpha[1]) === 0, 'Orb ' + mode + ' has no opaque legacy pill fill: ' + shell.color);
    assert.strictEqual(shell.image, 'none', 'Orb ' + mode + ' has no legacy pill gradient');
    assert.strictEqual(shell.shadow, 'none', 'Orb ' + mode + ' has no legacy pill shadow');
  };
  const state = async payload => {
    overlay.webContents.send('state', payload);
    await pause(35);
  };
  await run(`window.testMicRequests = 0;
    navigator.mediaDevices.getUserMedia = async () => { window.testMicRequests++; throw new Error('Style preview requested a microphone'); };
    soundsEnabled = false; alwaysShowFlowBar = true;
    document.body.classList.add('shown'); setHud('idle'); true`);

  assert.strictEqual(await run('document.body.dataset.flowStyle'), 'classic', 'existing profiles retain Classic by default');
  await state({ flowBarStyle: 'unknown-style' });
  assert.strictEqual(await run('document.body.dataset.flowStyle'), 'classic', 'unsupported preferences fall back safely');

  await run(`window.styleTest = (() => {
    const particlePool = [...document.querySelectorAll('.orb-particle')];
    const box = element => {
      const r = element.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
    };
    const within = (inner, outer, slack = .6) => inner.left >= outer.left - slack && inner.right <= outer.right + slack
      && inner.top >= outer.top - slack && inner.bottom <= outer.bottom + slack;
    function geometry() {
      const p = box(pill);
      const viewport = { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
      const controls = ['btn-cancel', 'btn-confirm', 'orb-trigger', 'orb-discard', 'orb-finish', 'flow-settings', 'flow-capture', 'flow-drag'].map(id => {
        const element = document.getElementById(id), css = getComputedStyle(element), rect = box(element);
        return { id, rect, clickable: css.pointerEvents !== 'none', opacity: Number(css.opacity),
          inside: within(rect, id.startsWith('flow-') || ['orb-discard', 'orb-finish'].includes(id) ? viewport : p) };
      });
      const visibleGlyphs = ['.glyph-mic', '.glyph-check', '.glyph-error', '.generation-star'].map(selector => {
        const element = document.querySelector(selector), css = getComputedStyle(element);
        return { selector, opacity: Number(css.opacity), rect: box(element), inside: within(box(element), p) };
      });
      return { pill: p, fits: within(p, viewport), controls, visibleGlyphs, mode: hudMode };
    }
    function advance(level, frames = 45) {
      for (let frame = 0; frame < frames; frame++) updateWave(1 / 60, level, null);
      return { heights: waveBars.map(el => new DOMMatrix(el.style.transform).m22 * 22),
        path: document.querySelector('.ribbon-wave-path').getAttribute('d'),
        glow: Number(pill.style.getPropertyValue('--voice-glow')), width: pill.getBoundingClientRect().width };
    }
    function particles() {
      const nodes = [...document.querySelectorAll('.orb-particle')];
      const viewport = { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
      const dots = nodes.map(element => {
        const css = getComputedStyle(element), rect = box(element);
        let unclipped = within(rect, viewport);
        if (Number(css.opacity) > .001) {
          for (let ancestor = element.parentElement; ancestor && ancestor !== document.body; ancestor = ancestor.parentElement) {
            const parentStyle = getComputedStyle(ancestor), parentBox = box(ancestor);
            if (['hidden', 'clip'].includes(parentStyle.overflowX)) unclipped = unclipped && rect.left >= parentBox.left - .6 && rect.right <= parentBox.right + .6;
            if (['hidden', 'clip'].includes(parentStyle.overflowY)) unclipped = unclipped && rect.top >= parentBox.top - .6 && rect.bottom <= parentBox.bottom + .6;
          }
        }
        return { opacity: Number(css.opacity), rect, unclipped,
          inert: css.pointerEvents === 'none' && !!element.closest('[aria-hidden="true"]') };
      });
      return { count: nodes.length, reused: nodes.every((node, i) => node === particlePool[i]),
        visible: dots.filter(dot => dot.opacity > .001).length, dots, hidden: document.hidden };
    }
    function canvasFrame() {
      const canvas = document.getElementById('energy-orb');
      const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      let hash = 2166136261, covered = 0;
      for (let i = 0; i < pixels.length; i++) hash = Math.imul(hash ^ pixels[i], 16777619);
      for (let i = 3; i < pixels.length; i += 4) if (pixels[i] > 200) covered++;
      return { hash: hash >>> 0, covered, width: canvas.width, height: canvas.height };
    }
    function orbMotion() {
      const core = document.querySelector('.orb-core'), rect = box(core);
      const canvas = document.getElementById('energy-orb');
      const halo = getComputedStyle(core, '::before'), matrix = new DOMMatrix(halo.transform);
      return { rect, x: (rect.left + rect.right) / 2, y: (rect.top + rect.bottom) / 2,
        halo: Number(halo.opacity), haloScale: Math.hypot(matrix.m11, matrix.m12), haloX: matrix.m41, haloY: matrix.m42,
        backing: [canvas.width, canvas.height], hit: box(document.getElementById('orb-trigger')) };
    }
    function processingEchoes() {
      const parent = document.querySelector('.orb-processing-echoes'), css = getComputedStyle(parent);
      const shown = css.display !== 'none' && css.visibility !== 'hidden' && Number(css.opacity) > .01;
      return { shown, groups: [...parent.querySelectorAll('g')].map(group => {
        const groupCss = getComputedStyle(group), path = group.querySelector('path'), matrix = path.getScreenCTM();
        const length = path.getTotalLength(), opacity = Number(groupCss.opacity);
        let fits = true, right = 0;
        if (shown && opacity > .01 && matrix) for (let step = 0; step <= 32; step++) {
          const point = path.getPointAtLength(length * step / 32);
          const screen = new DOMPoint(point.x, point.y).matrixTransform(matrix);
          fits = fits && screen.x >= 1 && screen.x <= innerWidth - 1 && screen.y >= 1 && screen.y <= innerHeight - 1;
          right = Math.max(right, screen.x);
        }
        return { opacity, scale: new DOMMatrix(groupCss.transform).m11, fits, right,
          decorative: groupCss.pointerEvents === 'none' && !!group.closest('[aria-hidden="true"]'),
          fill: getComputedStyle(path).fill };
      }) };
    }
    function speechTrace(level, syllabic) {
      const draws = [], samples = [], paint = energyOrb.draw;
      resetWave(); advance(0, 120);
      const silent = orbMotion();
      energyOrb.draw = options => { draws.push({ time: options.time, energy: options.energy, pulse: options.pulse }); paint(options); };
      try {
        for (let frame = 0; frame < 216; frame++) {
          const input = !syllabic || frame % 36 < 12 ? level : 0;
          updateWave(1 / 60, input, null);
          const motion = orbMotion();
          samples.push({ input, energy: orbVoiceEnergy, pulse: orbPulse, halo: motion.halo, haloScale: motion.haloScale,
            haloX: motion.haloX, haloY: motion.haloY,
            width: motion.rect.width, x: motion.x, y: motion.y });
        }
      } finally { energyOrb.draw = paint; }
      advance(0, 180);
      return { silent, samples, draws, released: { energy: orbVoiceEnergy, pulse: orbPulse, motion: orbMotion() } };
    }
    return { geometry, advance, particles, canvasFrame, orbMotion, processingEchoes, speechTrace, box, within };
  })(); true`);

  const particlePool = await run('styleTest.particles()');
  assert.strictEqual(particlePool.count, 16, 'Orb uses one bounded pool of sixteen particles');
  assert.ok(particlePool.dots.every(dot => dot.inert), 'particles are decorative and never intercept controls or screen readers');
  assert.ok(await run(`(() => {
    const effect = document.querySelector('.orb-atmosphere');
    return effect.parentElement === pill.parentElement && !pill.contains(effect)
      && !document.querySelector('.orb-core .orb-particle');
  })()`), 'particles sit behind the whole capsule, outside the microphone and clipped pill');

  for (const style of styles) {
    await run(`setHud('idle'); onCursor({ hover: false }); applyFlowBarStyle(${JSON.stringify(style)}); true`);
    await pause(350);
    assert.strictEqual(await run('document.body.dataset.flowStyle'), style, 'idle style changes immediately');
    const rest = await run('styleTest.geometry()');
    const restingOrb = style === 'orb' ? await run('styleTest.orbMotion()') : null;
    if (style === 'orb') await assertTransparentOrbShell('idle');
    assert.ok(rest.fits, style + ' resting silhouette stays in the window');
    if (style === 'orb') assert.ok(Math.abs(rest.pill.width - rest.pill.height) < 2, 'Orb rests as a circle');
    else assert.ok(rest.pill.width > rest.pill.height * 2, style + ' rests as a strip');
    await screenshot(overlay, style + '-idle');
    if (style === 'orb') {
      assert.ok(restingOrb.rect.width <= 33, 'the resting sphere is visually smaller than its fixed hit area');
      assert.ok(rest.controls.filter(control => ['btn-cancel', 'btn-confirm'].includes(control.id)).every(control => !control.clickable), 'Orb idle never exposes the old recording chips');
      const before = await run('styleTest.canvasFrame()');
      await pause(120);
      const after = await run('styleTest.canvasFrame()');
      assert.ok(after.covered > 200 && before.hash !== after.hash, 'the real Canvas2D sphere has visible flowing energy while idle');
      assert.ok(await run('orbVisualRaf > 0 && raf === 0'), 'idle sphere animation never starts the microphone meter');
    }
    if (style === 'ribbon') {
      const pulses = await run(`document.getAnimations().filter(a => a instanceof CSSAnimation && /rest-breathe/.test(a.animationName))
        .map(a => ({ duration: a.effect.getComputedTiming().endTime }))`);
      assert.ok(pulses.length > 0 && pulses.every(pulse => Number.isFinite(pulse.duration) && pulse.duration > 0), style + ' idle effects finish on their own');
    }

    await run('onCursor({ x: innerWidth / 2, y: innerHeight - 49, inside: true }); true');
    assert.strictEqual(await run("document.body.classList.contains('flow-expanded')"), style === 'orb', style + ' hover entry matches the actual resting silhouette');
    await run('onCursor({ hover: false }); true');

    await run('resetIdleFace(); startIdleFace(); true');
    if (style === 'classic') assert.strictEqual(await run('idleFacePlaying'), true, 'Classic keeps its robot character');
    else assert.strictEqual(await run("document.body.classList.contains('flow-face')"), false, style + ' does not become a robot');
    await run('resetIdleFace(); onCursor({ hover: true }); true');
    await pause(300);
    const hover = await run('styleTest.geometry()');
    if (style === 'orb') {
      await assertTransparentOrbShell('hover');
      const hoveringOrb = await run('styleTest.orbMotion()');
      assert.ok(hoveringOrb.rect.width > restingOrb.rect.width + 1.5, 'Orb hover adds a small visible pop inside a fixed hit area');
      assert.ok(hoveringOrb.y < restingOrb.y - .2, 'Orb lifts slightly on hover');
      assert.ok(hoveringOrb.halo > restingOrb.halo + .15, 'hover visibly brightens the soft glow');
      assert.ok(['left', 'top', 'width', 'height'].every(key => Math.abs(hover.pill[key] - rest.pill[key]) < .1), 'hover never resizes or moves the capture target');
      assert.deepStrictEqual(hoveringOrb.backing, restingOrb.backing, 'hover scales the visual without resizing its image buffer');
    }
    for (const id of ['flow-settings', 'flow-capture', 'flow-drag']) {
      const control = hover.controls.find(item => item.id === id);
      assert.ok(control.clickable && control.inside, style + ' retains reachable ' + id);
      await run(`onCursor({ x: ${(control.rect.left + control.rect.right) / 2}, y: ${(control.rect.top + control.rect.bottom) / 2}, inside: true }); true`);
      assert.ok(await run("document.body.classList.contains('flow-expanded')"), style + ' keeps the cluster open while reaching ' + id);
    }
    await run(`document.getElementById('flow-settings').click(); true`);
    await pause(30);
    assert.strictEqual(actions.at(-1), 'settings', style + ' gear opens settings without recording');
    await run(style === 'orb' ? `document.getElementById('orb-trigger').click(); true` : `pill.click(); true`);
    await pause(30);
    assert.strictEqual(actions.at(-1), 'toggle', style + ' idle microphone starts dictation');
    await screenshot(overlay, style + '-hover');

    if (style === 'orb') {
      const reversals = await run(`new Promise(resolve => {
        const flips = [0, 45, 90, 135, 180, 225, 320, 500];
        const started = performance.now(), baseline = styleTest.orbMotion();
        let nextFlip = 0, previous = baseline, stableHit = true, stableBacking = true, centred = true, smooth = true;
        function frame(now) {
          while (nextFlip < flips.length && now - started >= flips[nextFlip]) {
            onCursor({ hover: nextFlip % 2 === 0 }); nextFlip++;
          }
          const current = styleTest.orbMotion();
          stableHit = stableHit && ['left', 'top', 'width', 'height'].every(key => Math.abs(current.hit[key] - baseline.hit[key]) < .1);
          stableBacking = stableBacking && current.backing.every((value, i) => value === baseline.backing[i]);
          centred = centred && Math.abs(current.x - baseline.x) < .1;
          smooth = smooth && Math.abs(current.y - previous.y) < .7 && Math.abs(current.rect.width - previous.rect.width) < 1.5;
          previous = current;
          if (now - started < 850) requestAnimationFrame(frame);
          else resolve({ stableHit, stableBacking, centred, smooth, final: current });
        }
        requestAnimationFrame(frame);
      })`);
      assert.ok(reversals.stableHit && reversals.stableBacking && reversals.centred && reversals.smooth,
        'rapid interrupted hover reversals remain smooth with a fixed hit area and backing bitmap: ' + JSON.stringify(reversals));
      await run('onCursor({ x: innerWidth / 2, y: innerHeight - 49, inside: true }); true');
      await pause(100);
      const held = await run(`new Promise(resolve => {
        const started = performance.now(); let expanded = true;
        function frame(now) {
          onCursor({ x: innerWidth / 2, y: innerHeight - 49, inside: true });
          expanded = expanded && document.body.classList.contains('flow-expanded');
          if (now - started < 350) requestAnimationFrame(frame); else resolve(expanded);
        }
        requestAnimationFrame(frame);
      })`);
      assert.ok(held, 'a stationary pointer near the entry edge never oscillates the hover state');
      for (const readyAfter of [20, 90, 220]) {
        await run("setHud('idle'); onCursor({ hover: true }); true");
        await pause(280);
        const centred = await run(`new Promise(resolve => {
          const started = performance.now(); let recording = false, maxOffset = 0, previousTime = orbVisualTime, continuousTime = true;
          setHud('arming');
          const sphere = document.getElementById('energy-orb');
          function frame(now) {
            if (!recording && now - started >= ${readyAfter}) {
              recording = true; setHud('recording'); stopWaveLoop();
            }
            const mic = document.querySelector('.orb-core').getBoundingClientRect(), capsule = pill.getBoundingClientRect();
            continuousTime = continuousTime && orbVisualTime >= previousTime;
            previousTime = orbVisualTime;
            maxOffset = Math.max(maxOffset, Math.abs((mic.left + mic.right - capsule.left - capsule.right) / 2));
            if (now - started < ${readyAfter + 340}) requestAnimationFrame(frame);
            else resolve({ maxOffset, continuousTime, sameCanvas: sphere === document.getElementById('energy-orb') });
          }
          requestAnimationFrame(frame);
        })`);
        assert.ok(centred.maxOffset < 1.2, 'Orb energy sphere stays centred through startup at ' + readyAfter + 'ms; offset=' + centred.maxOffset);
        assert.ok(centred.sameCanvas, 'Orb retains its renderer through capture readiness at ' + readyAfter + 'ms');
        assert.ok(centred.continuousTime, 'Orb flow keeps its phase through capture readiness at ' + readyAfter + 'ms');
      }
    }

    // Enter the recording HUD directly; production capture readiness calls the
    // same function, but opening a real microphone is outside this fixture.
    await run("setHud('arming'); true");
    await pause(300);
    if (style === 'orb') await assertTransparentOrbShell('arming');
    await run("setHud('recording'); stopWaveLoop(); resetWave(); styleTest.advance(.015); true");
    await pause(300);
    if (style === 'orb') await assertTransparentOrbShell('recording');
    const first = await run('styleTest.advance(.015, 1)');
    const second = await run('styleTest.advance(.015, 12)');
    assert.ok(second.glow > .2, style + ' preserves voice feedback');
    assert.ok(Math.abs(first.width - second.width) < .1, style + ' waveform motion never resizes controls');
    if (style === 'ribbon') {
      assert.ok(first.path && first.path !== second.path, 'Ribbon has a moving continuous waveform');
      assert.ok(await run(`(() => { const path = document.querySelector('.ribbon-wave-path');
        return getComputedStyle(path).stroke !== 'none' && path.getTotalLength() > 30; })()`), 'Ribbon is visibly stroked');
      const layers = await run(`['.ribbon-wave-trail', '.ribbon-wave-halo'].map(selector => {
        const el = document.querySelector(selector); return { selector, exists: !!el,
          path: el && el.getAttribute('d'), stroke: el && getComputedStyle(el).stroke,
          inert: el && getComputedStyle(el).pointerEvents === 'none' };
      })`);
      assert.ok(layers.every(layer => layer.exists && layer.path && layer.stroke !== 'none' && layer.inert), 'Ribbon layers form a visible, noninteractive contour');
    }
    if (style !== 'orb') assert.strictEqual(await run('styleTest.particles().visible'), 0, style + ' never emits Orb particles');
    if (style === 'orb') {
      const recordingControls = await run(`({ circle: styleTest.geometry().pill,
        oldChips: [btnCancel, btnConfirm].map(el => getComputedStyle(el).pointerEvents),
        mic: Number(getComputedStyle(document.querySelector('.glyph-mic')).opacity),
        buttons: ['orb-discard', 'orb-finish'].map(id => {
          const element = document.getElementById(id), rect = styleTest.box(element), css = getComputedStyle(element);
          const target = document.elementFromPoint((rect.left + rect.right) / 2, (rect.top + rect.bottom) / 2);
          return { id, rect, text: element.textContent.trim(), name: element.getAttribute('aria-label') || element.title,
            icon: !!element.querySelector('svg'), color: css.color, opacity: Number(css.opacity),
            reachable: element === target || element.contains(target), tabIndex: element.tabIndex, disabled: element.disabled };
        }) })`);
      assert.ok(Math.abs(recordingControls.circle.width - recordingControls.circle.height) < .5, 'Orb recording keeps the energy sphere circular');
      assert.ok(recordingControls.oldChips.every(pointer => pointer === 'none') && recordingControls.mic === 0, 'Orb recording removes the square, cross and microphone glyph');
      const [discard, finish] = recordingControls.buttons, circle = recordingControls.circle;
      assert.ok(discard.rect.right <= circle.left && finish.rect.left >= circle.right,
        'Discard sits left and Finish sits right without overlapping the sphere');
      assert.ok(recordingControls.buttons.every(item => item.icon && !item.text && item.opacity > .9 && item.reachable
        && item.tabIndex >= 0 && !item.disabled && item.rect.width >= 22 && item.rect.height >= 22),
        'side icons remain visible, reachable and keyboard accessible');
      assert.match(discard.name, /discard/i, 'the cross keeps its accessible action name');
      assert.match(finish.name, /finish|transcribe/i, 'the tick keeps its accessible action name');
      const finishColor = finish.color.match(/[\d.]+/g).map(Number);
      assert.ok(finishColor[2] > finishColor[0] + 25 && finishColor[2] > finishColor[1], 'the finish tick has the requested blue accent');
      for (const [id, action] of [['orb-trigger', 'confirm'], ['orb-finish', 'confirm'], ['orb-discard', 'cancel']]) {
        await run("setHud('idle'); setHud('recording'); stopWaveLoop(); true");
        const before = actions.length;
        await run(`document.getElementById('${id}').click(); true`);
        await pause(30);
        assert.deepStrictEqual(actions.slice(before), [action], id + ' sends exactly one action without restarting dictation');
      }
      overlay.webContents.debugger.attach('1.3');
      await overlay.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
      for (const [id, action] of [['orb-finish', 'confirm'], ['orb-discard', 'cancel']]) {
        for (const [key, code, keyCode] of [['Enter', 'Enter', 13], [' ', 'Space', 32]]) {
          await run(`setHud('idle'); setHud('recording'); stopWaveLoop(); document.getElementById('${id}').focus(); true`);
          assert.strictEqual(await run('document.activeElement.id'), id, 'keyboard focus reaches ' + id);
          const before = actions.length;
          for (const type of ['keyDown', 'keyUp']) {
            await overlay.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
              type, key, code, windowsVirtualKeyCode: keyCode,
              ...(type === 'keyDown' ? { text: key === 'Enter' ? '\r' : key, unmodifiedText: key === 'Enter' ? '\r' : key } : {}),
            });
          }
          await pause(30);
          assert.deepStrictEqual(actions.slice(before), [action], id + ' activates exactly once with ' + code);
        }
      }
      await overlay.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: false });
      overlay.webContents.debugger.detach();
      await run('document.activeElement.blur(); true');
      await run("setHud('recording'); stopWaveLoop(); styleTest.advance(.015); true");
      await pause(300);
    } else {
      await run("document.getElementById('btn-confirm').click(); document.getElementById('btn-cancel').click(); true");
      await pause(30);
      assert.deepStrictEqual(actions.slice(-2), ['confirm', 'cancel'], style + ' recording controls keep their IPC actions');
    }
    await screenshot(overlay, style + '-recording');

    // Active preferences must not dismantle a live analyser or restart its
    // phase. The effective style changes after the result is dismissed.
    const nextStyle = styles[(styles.indexOf(style) + 1) % styles.length];
    await run(`window.syntheticReads = 0;
      window.styleAnalyser = {
        fftSize: 1024, frequencyBinCount: 512, context: { sampleRate: 48000 },
        getFloatTimeDomainData: samples => { window.syntheticReads++; for (let i = 0; i < samples.length; i++) samples[i] = Math.SQRT2 * .006 * Math.sin(i * 2 * Math.PI / 128); },
        getByteFrequencyData: samples => samples.fill(90),
      };
      analyser = window.styleAnalyser; startWaveLoop(); true`);
    await pause(250);
    const before = await run('({ reads: syntheticReads, gen: captureGen, clock: waveClock })');
    await state({ flowBarStyle: nextStyle });
    await pause(100);
    const during = await run(`({ style: document.body.dataset.flowStyle, reads: syntheticReads, gen: captureGen,
      clock: waveClock, active: !!raf, sameAnalyser: analyser === window.styleAnalyser,
      visualLoop: orbVisualRaf, glow: Number(pill.style.getPropertyValue('--voice-glow')) })`);
    assert.strictEqual(during.style, style, 'a recording keeps its chosen silhouette');
    assert.ok(during.active && during.sameAnalyser && during.reads > before.reads && during.glow > .2, 'recording feedback survives a preference update');
    if (style === 'orb') assert.strictEqual(during.visualLoop, 0, 'recording shares the audio frame loop instead of scheduling a competing sphere loop');
    assert.strictEqual(during.gen, before.gen, 'style choice cannot discard an in-flight transcription');
    const phaseAdvance = (during.clock - before.clock + Math.PI * 2) % (Math.PI * 2);
    assert.ok(phaseAdvance > 0 && phaseAdvance < 2, 'style choice cannot restart the waveform phase');
    await run("setHud('transcribing'); analyser = null; true");
    assert.strictEqual(await run('document.body.dataset.flowStyle'), style, 'transcription preserves the active style');
    assert.strictEqual(await run('raf'), 0, 'transcription stops recording animation');
    await pause(300);
    await screenshot(overlay, style + '-transcribing');
    await run("setHud('success', 'A thought, captured clearly.'); true");
    assert.strictEqual(await run('document.body.dataset.flowStyle'), style, 'the result preserves the active style');
    await run("setHud('idle'); true");
    assert.strictEqual(await run('document.body.dataset.flowStyle'), nextStyle, 'dismissal applies the pending preference');
  }

  await run("setHud('idle'); applyFlowBarStyle('orb'); onCursor({ hover: false }); setHud('recording'); stopWaveLoop(); true");
  await pause(300);
  const quietSpeech = await run('styleTest.speechTrace(.0007, true)');
  const loudSpeech = await run('styleTest.speechTrace(.02, true)');
  const steadySpeech = await run('styleTest.speechTrace(.02, false)');
  const peak = (trace, key) => Math.max(...trace.samples.map(sample => sample[key]));
  assert.ok(peak(quietSpeech, 'energy') > .1 && peak(quietSpeech, 'pulse') > .08, 'low-gain speech receives clear energy and onset feedback');
  assert.ok(peak(loudSpeech, 'energy') > peak(quietSpeech, 'energy') + .2, 'loud speech has more energy than quiet speech');
  assert.ok(peak(quietSpeech, 'width') > quietSpeech.silent.rect.width + .5
    && peak(quietSpeech, 'halo') > quietSpeech.silent.halo + .15, 'quiet speech visibly grows and lights the sphere');
  assert.ok(peak(quietSpeech, 'haloScale') > quietSpeech.silent.haloScale + .02, 'the computed halo transform expands with quiet speech');
  assert.ok(peak(loudSpeech, 'width') > peak(quietSpeech, 'width') + .75, 'loud speech has a stronger visual pulse');
  for (const [name, trace] of [['quiet', quietSpeech], ['loud', loudSpeech]]) {
    for (let word = 0; word < 6; word++) {
      const samples = trace.samples.slice(word * 36, (word + 1) * 36);
      const onset = Math.max(...samples.slice(0, 12).map(sample => sample.pulse));
      const gap = Math.min(...samples.slice(25).map(sample => sample.pulse));
      assert.ok(onset > gap + .04, name + ' syllable ' + word + ' creates a distinct pulse rather than one constant glow');
    }
    assert.ok(trace.draws.length >= 70 && trace.draws.every(draw => Number.isFinite(draw.time)
      && draw.energy >= 0 && draw.energy <= 1 && draw.pulse >= 0 && draw.pulse <= 1), name + ' speech drives bounded energy and pulse into the real renderer');
    assert.ok(Math.max(...trace.draws.map(draw => draw.pulse)) > .08, name + ' onset reaches the actual material deformation');
    assert.ok(trace.samples.every(sample => Math.abs(sample.x - trace.silent.x) < .8 && Math.abs(sample.y - trace.silent.y) < .8), name + ' movement remains subtle and bounded');
    assert.ok(trace.samples.every(sample => Math.abs(sample.haloX) < 2.5 && Math.abs(sample.haloY) < 2.5), name + ' moving glow remains bounded');
    assert.ok(trace.released.energy < .01 && trace.released.pulse < .01, name + ' speech releases naturally into silence');
  }
  const tailPulse = Math.max(...steadySpeech.samples.slice(-72).map(sample => sample.pulse));
  assert.ok(tailPulse < .03 && peak(loudSpeech, 'pulse') > tailPulse + .25, 'syllabic input is visibly different from steady intensity');
  for (const [name, level, frames] of [['voice-quiet', .0007, 12], ['voice-syllable', .02, 7], ['voice-gap', 0, 18]]) {
    await run(`resetWave(); styleTest.advance(0, 60); ${level ? '' : 'styleTest.advance(.02, 12);'} styleTest.advance(${level}, ${frames}); orbVisualTime = 4; drawEnergyOrb(0, true); true`);
    await screenshot(overlay, 'orb-' + name);
  }

  // Particles follow speech energy rather than the decorative listening ripple.
  // Sample the real updateWave path so a second timer or a growing DOM pool
  // cannot accidentally keep emitting after a recording has ended.
  await run("setHud('idle'); applyFlowBarStyle('orb'); onCursor({ hover: false }); true");
  for (const mode of ['idle', 'arming', 'recording']) {
    await run(`setHud(${JSON.stringify(mode)}); stopWaveLoop(); resetWave(); styleTest.advance(${mode === 'recording' ? 0 : .02}, 180); true`);
    assert.strictEqual(await run('styleTest.particles().visible'), 0, mode + ' does not emit particles without active speech');
  }
  await pause(320); // The fixture just changed several HUD states synchronously.
  const quietParticles = await run('styleTest.advance(.0007, 90); styleTest.particles()');
  assert.ok(quietParticles.visible > 0, 'very soft speech emits a few particles: ' + JSON.stringify(quietParticles));
  assert.ok(quietParticles.visible <= 16 && quietParticles.dots.every(dot => dot.opacity <= .8), 'quiet speech stays restrained and bounded');
  await screenshot(overlay, 'orb-soft-particles');
  if (process.argv.includes('--screenshots')) {
    for (let phase = 1; phase <= 3; phase++) {
      await run('styleTest.advance(.012, 12); true');
      await screenshot(overlay, 'orb-particles-phase-' + phase);
    }
  }
  await run('styleTest.advance(0, 180); true');
  assert.strictEqual(await run('styleTest.particles().visible'), 0, 'particles fade away after speech settles into silence');
  const retained = await run('styleTest.advance(.08, 1800); styleTest.particles()');
  assert.ok(retained.count === 16 && retained.reused, 'long continuous speech reuses the same sixteen nodes');
  assert.ok(retained.visible > 0, 'the bounded pool continues responding during long speech');
  const perimeter = await run(`(() => {
    const p = styleTest.box(pill), stage = styleTest.box(document.querySelector('.orb-atmosphere'));
    const z = getComputedStyle(pill).zIndex, effectZ = getComputedStyle(document.querySelector('.orb-atmosphere')).zIndex;
    const seen = { left: false, right: false, top: false, bottom: false, larger: false };
    for (let frame = 0; frame < 300; frame++) {
      updateWave(1 / 60, .02, null);
      for (const dot of styleTest.particles().dots.filter(dot => dot.opacity > .08)) {
        seen.left ||= dot.rect.right < p.left;
        seen.right ||= dot.rect.left > p.right;
        seen.top ||= dot.rect.bottom < p.top;
        seen.bottom ||= dot.rect.top > p.bottom;
        seen.larger ||= dot.rect.width >= 2;
      }
    }
    return { seen, behind: Number(effectZ) < Number(z), follows: ['left', 'top', 'width', 'height'].every(key => Math.abs(stage[key] - p[key]) < .2) };
  })()`);
  assert.ok(Object.values(perimeter.seen).every(Boolean) && perimeter.behind && perimeter.follows,
    'larger particles emerge around all four sides, behind the complete capsule: ' + JSON.stringify(perimeter));

  const processing = await run(`new Promise(resolve => {
    const paint = energyOrb.draw, draws = [], samples = [], hashes = [], started = performance.now();
    energyOrb.draw = options => { draws.push({ time: options.time, mix: options.processing, pulse: options.pulse }); paint(options); };
    setHud('transcribing'); analyser = null;
    let frame = 0;
    function sample(now) {
      const dots = styleTest.particles(), motion = styleTest.orbMotion(), p = styleTest.box(pill);
      samples.push({ elapsed: now - started, frame: orbVisualRaf, audio: raf, halo: motion.halo, haloScale: motion.haloScale,
        echoes: styleTest.processingEchoes(), width: motion.rect.width,
        count: dots.count, visible: dots.visible, reused: dots.reused,
        fits: dots.dots.every(dot => dot.opacity < .001 || dot.unclipped),
        left: dots.dots.some(dot => dot.opacity > .04 && dot.rect.right < p.left),
        right: dots.dots.some(dot => dot.opacity > .04 && dot.rect.left > p.right),
        opacity: Math.max(...dots.dots.map(dot => dot.opacity)) });
      if (frame++ % 10 === 0) hashes.push(styleTest.canvasFrame().hash);
      if (now - started < 3000) requestAnimationFrame(sample);
      else { energyOrb.draw = paint; resolve({ draws, samples, hashes }); }
    }
    requestAnimationFrame(sample);
  })`);
  assert.ok(processing.samples.every(sample => sample.frame > 0 && sample.audio === 0),
    'processing owns one visual loop after the microphone meter stops');
  assert.ok(processing.draws.length >= 25 && processing.draws.every(draw => Number.isFinite(draw.time)
    && draw.mix >= 0 && draw.mix <= 1 && draw.pulse >= 0 && draw.pulse <= 1), 'processing drives bounded morph and pulse values into the real canvas');
  assert.ok(processing.draws[0].mix < .1 && processing.draws.at(-1).mix > .99,
    'the final speech frame smoothly becomes the complete glass shape');
  assert.ok(processing.draws.slice(1).every((draw, i) => draw.mix >= processing.draws[i].mix
    && draw.mix - processing.draws[i].mix < .35 && draw.time >= processing.draws[i].time), 'processing advances without morph or clock resets');
  assert.ok(new Set(processing.hashes).size > 4, 'the actual glass material keeps moving through processing');
  const settledGlow = processing.samples.filter(sample => sample.elapsed > 450);
  assert.ok(Math.max(...settledGlow.map(sample => sample.halo)) > .85 && Math.min(...settledGlow.map(sample => sample.halo)) > .5
    && Math.max(...settledGlow.map(sample => sample.haloScale)) > 1.1, 'the colored processing glow stays visible and expands through its brighter pulse');
  const glowPeak = (start, end) => Math.max(...processing.samples.filter(sample => sample.elapsed >= start && sample.elapsed < end).map(sample => sample.halo));
  const glowDip = Math.min(...processing.samples.filter(sample => sample.elapsed > 740 && sample.elapsed < 950).map(sample => sample.halo));
  assert.ok(glowPeak(350, 700) > glowDip + .12 && glowPeak(1000, 1350) > glowDip + .025,
    'processing has a distinct leading pulse and softer answering pulse');
  assert.ok(processing.samples.every(sample => sample.echoes.groups.length === 2 && sample.echoes.groups.every(group => group.decorative
    && group.fill === 'none' && group.fits && group.opacity <= .41)), 'two outlined pulse echoes stay decorative and within the viewport');
  for (let index = 0; index < 2; index++) {
    const samples = processing.samples.map(sample => sample.echoes.groups[index]);
    assert.ok(Math.max(...samples.map(group => group.opacity)) > .12 && samples.some(group => group.opacity < .005)
      && Math.max(...samples.filter(group => group.opacity > .03).map(group => group.scale)) > 1.4,
      'each colored echo expands visibly and fades out between pulses');
  }
  assert.ok(processing.samples.some(sample => sample.left) && processing.samples.some(sample => sample.right),
    'processing sheds a few particles from both sides of its material');
  assert.ok(processing.samples.every(sample => sample.fits && sample.count === 16 && sample.reused
    && sample.visible <= 8 && sample.opacity <= .55), 'processing particles remain restrained, bounded and unclipped');
  await run("document.documentElement.style.background = '#191d23'; true");
  await pause(45);
  const glowFrame = await overlay.webContents.capturePage();
  const glowPixels = glowFrame.toBitmap(), glowSize = glowFrame.getSize();
  const glowPosition = await run('({ x: styleTest.orbMotion().x, y: styleTest.orbMotion().y, width: innerWidth, height: innerHeight })');
  await run("document.documentElement.style.removeProperty('background'); true");
  let coloredHaloPixels = 0;
  for (let y = 0; y < glowSize.height; y++) for (let x = 0; x < glowSize.width; x++) {
    const distance = Math.hypot(x * glowPosition.width / glowSize.width - glowPosition.x,
      y * glowPosition.height / glowSize.height - glowPosition.y);
    const at = (y * glowSize.width + x) * 4;
    // Green is channel one in either RGBA or BGRA; comparing both outer
    // channels makes the hue check independent of native bitmap byte order.
    if (distance > 19 && distance < 25 && glowPixels[at + 1] > 37
      && glowPixels[at + 1] > Math.min(glowPixels[at], glowPixels[at + 2]) + 8) coloredHaloPixels++;
  }
  assert.ok(coloredHaloPixels > 45, 'the compositor renders a visible colored halo outside the star, not only CSS values: ' + coloredHaloPixels);
  const repeated = await run(`(() => {
    const snapshot = () => ({ time: orbVisualTime, frame: orbVisualRaf, serial: orbParticleSerial, mix: orbProcessingMix,
      particles: orbParticles.map(particle => ({ life: particle.life, age: particle.age })) });
    const before = snapshot();
    setHud('transcribing');
    return { before, after: snapshot() };
  })()`);
  assert.deepStrictEqual(repeated.after, repeated.before, 'repeated transcription state preserves the glass phase, morph and live particles');
  assert.ok(await run(`(() => {
    const canvas = getComputedStyle(document.getElementById('energy-orb'));
    const hidden = selector => {
      for (let element = document.querySelector(selector); element; element = element.parentElement) {
        const css = getComputedStyle(element);
        if (css.display === 'none' || css.visibility === 'hidden' || Number(css.opacity) === 0) return true;
        if (element === document.body) return false;
      }
      return true;
    };
    return canvas.visibility === 'visible' && Number(canvas.opacity) > .9
      && hidden('.generation-star') && hidden('.generation-star-glint') && hidden('.orb-star-glow');
  })()`), 'processing renders one glass material without a separate SVG star or duplicate backdrop');
  await screenshot(overlay, 'orb-processing-glass');
  if (process.argv.includes('--screenshots')) {
    for (let phase = 1; phase <= 2; phase++) {
      await pause(400);
      await screenshot(overlay, 'orb-processing-glass-phase-' + phase);
    }
  }
  for (const mode of ['idle', 'success', 'error', 'cancel']) {
    await run("setHud('transcribing'); true");
    await pause(180);
    await run('setHud(' + JSON.stringify(mode) + '); true');
    assert.strictEqual(await run('orbVisualRaf > 0'), mode === 'idle', mode + ' keeps only the appropriate sphere animation');
    assert.strictEqual(await run('styleTest.particles().visible'), 0, mode + ' clears processing particles');
    assert.strictEqual(await run('styleTest.processingEchoes().shown'), false, mode + ' removes the processing echoes');
  }
  await run("setHud('transcribing'); true");
  await pause(400);
  await run('popOut(); true');
  assert.ok(await run(`['orb-trigger', 'orb-discard', 'orb-finish'].every(id => {
    const element = document.getElementById(id); return element.disabled && element.tabIndex === -1;
  })`), 'hidden Orb actions are disabled and removed from keyboard navigation');
  await pause(200);
  assert.strictEqual(await run('orbVisualRaf'), 0, 'hiding the overlay stops the sphere and processing particle loop');
  assert.strictEqual(await run('styleTest.particles().visible'), 0, 'hidden processing cannot emit new particles');
  await run('popIn(); true');
  await pause(400);
  assert.ok(await run('orbVisualRaf > 0 && raf === 0'), 'revealing an in-flight transcription resumes only the glass visual loop');
  await run("setHud('idle'); true");

  for (const exit of ["setHud('transcribing')", "setHud('cancel')", "setHud('success', 'Done')", "setHud('error', 'Try again')", "setHud('idle')", 'stopWaveLoop()', 'popOut()']) {
    await run("document.body.classList.remove('hiding', 'entering'); document.body.classList.add('shown'); setHud('recording'); stopWaveLoop(); resetWave(); styleTest.advance(.012, 90); true");
    assert.ok(await run('styleTest.particles().visible > 0'), 'speech particles are present before ' + exit);
    await run(exit + '; true');
    assert.strictEqual(await run('styleTest.particles().visible'), 0, exit + ' clears particles immediately');
  }
  await pause(300);
  await run("document.body.classList.remove('hiding', 'entering'); document.body.classList.add('shown'); setHud('idle'); true");

  // Long results, expanded controls and decorative waves must fit at the
  // scaling factors used by overlaySize(), including maximum input energy.
  for (const scale of [1, 1.25, 1.5]) {
    overlay.setContentSize(Math.round(260 * scale), Math.round(84 * scale));
    overlay.webContents.setZoomFactor(scale);
    for (const style of styles) {
      await run(`setHud('idle'); onCursor({ hover: false }); applyFlowBarStyle(${JSON.stringify(style)}); canRetry = true; true`);
      for (const mode of ['idle', 'arming', 'recording', 'transcribing', 'success', 'error', 'cancel']) {
        await run(`setHud(${JSON.stringify(mode)}, ${JSON.stringify(['success', 'error'].includes(mode) ? 'A long transcription result that must stay within the floating capsule and leave the action visible.' : '')});
          stopWaveLoop(); ${mode === 'recording' ? 'styleTest.advance(1, 90);' : ''} true`);
        await pause(280);
        const geometry = await run('styleTest.geometry()');
        assert.ok(geometry.fits, style + ' ' + mode + ' fits at scale ' + scale + ': ' + JSON.stringify(geometry.pill));
        for (const control of geometry.controls) {
          if (control.clickable) assert.ok(control.inside && control.rect.width >= 18, style + ' ' + mode + ' preserves ' + control.id + ' at scale ' + scale);
        }
        if (mode === 'recording') {
          const fit = await run(`(() => {
            const p = styleTest.box(pill); let fits = true;
            for (let frame = 0; frame < 120; frame++) {
              updateWave(1 / 60, frame % 20 < 10 ? 1 : .0007, null);
              const style = document.body.dataset.flowStyle;
              const elements = style === 'ribbon' ? [document.querySelector('.ribbon-wave-path')]
                : style === 'orb' ? [document.getElementById('energy-orb')] : waveBars;
              const boundary = style === 'orb' ? { left: 0, top: 0, right: innerWidth, bottom: innerHeight } : p;
              for (const element of elements) fits = fits && styleTest.within(styleTest.box(element), boundary);
            }
            return fits;
          })()`);
          assert.ok(fit, style + ' audio animation stays within the capsule at scale ' + scale);
          if (style === 'orb') {
            const stable = await run(`(() => {
              const elements = [pill, ...['orb-trigger', 'orb-discard', 'orb-finish'].map(id => document.getElementById(id))];
              const baseline = elements.map(styleTest.box);
              const canvasSize = styleTest.orbMotion().backing;
              let fits = true, still = true, emitted = false, smooth = true;
              let previous = styleTest.particles().dots;
              for (let frame = 0; frame < 240; frame++) {
                updateWave(1 / 60, frame < 160 ? .03 : 0, null);
                const next = styleTest.particles();
                const motion = styleTest.orbMotion(), centre = styleTest.box(pill);
                still = still && motion.backing.every((value, i) => value === canvasSize[i])
                  && Math.abs(motion.x - (centre.left + centre.right) / 2) < .8
                  && Math.abs(motion.y - (centre.top + centre.bottom) / 2) < .8;
                emitted = emitted || next.visible > 0;
                fits = fits && next.dots.every(dot => dot.opacity <= .001 || dot.unclipped);
                still = still && elements.every((element, i) => {
                  const rect = styleTest.box(element), before = baseline[i];
                  return ['left', 'top', 'width', 'height'].every(key => Math.abs(rect[key] - before[key]) < .1);
                });
                for (let i = 0; i < next.dots.length; i++) {
                  const before = previous[i], after = next.dots[i];
                  if (before.opacity > .06 && after.opacity > .06) {
                    smooth = smooth && Math.hypot(after.rect.left - before.rect.left, after.rect.top - before.rect.top) < 3;
                  }
                }
                previous = next.dots;
              }
              return { fits, still, emitted, smooth, pooled: styleTest.particles().reused };
            })()`);
            assert.ok(stable.emitted && stable.fits, 'Orb particles remain visible and unclipped at scale ' + scale + ': ' + JSON.stringify(stable));
            assert.ok(stable.still && stable.smooth && stable.pooled, 'speech motion stays bounded while controls and image storage remain fixed at scale ' + scale + ': ' + JSON.stringify(stable));
          }
        }
        if (mode === 'transcribing') {
          if (style === 'orb') {
            await run("setHud('transcribing', 'Finishing your longer dictation with the selected writing style'); true");
            await pause(300);
            assert.ok(await run(`styleTest.geometry().fits && orbVisualRaf > 0 && raf === 0
              && styleTest.within(styleTest.box(document.getElementById('energy-orb')), { left: 0, top: 0, right: innerWidth, bottom: innerHeight })
              && styleTest.particles().dots.every(dot => dot.opacity < .001 || dot.unclipped)
              && styleTest.processingEchoes().groups.every(group => group.fits && group.right < styleTest.box(label).left)`),
              'long processing text, glass and particles stay contained at scale ' + scale);
            assert.ok(await run(`(() => {
              for (let frame = 0; frame < 180; frame++) {
                drawEnergyOrb(1 / 60); updateOrbParticles(1 / 60, false);
                if (!styleTest.processingEchoes().groups.every(group => group.fits && group.right < styleTest.box(label).left)) return false;
              }
              return true;
            })()`), 'expanding echoes preserve text clearance throughout a full pulse cycle at scale ' + scale);
          } else {
            assert.ok(await run(`(() => { const el = document.querySelector('.generation-star'), css = getComputedStyle(el);
              return Number(css.opacity) > .9 && styleTest.within(styleTest.box(el), styleTest.box(pill)); })()`), style + ' keeps the shared generation star visible and contained');
          }
        }
      }
    }
  }

  overlay.webContents.debugger.attach('1.3');
  await run("setHud('idle'); applyFlowBarStyle('orb'); setHud('recording'); stopWaveLoop(); resetWave(); styleTest.advance(.012, 90); true");
  assert.ok(await run('styleTest.particles().visible > 0'), 'particles are active before reduced motion changes');
  await overlay.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await pause(35);
  assert.strictEqual(await run('styleTest.particles().visible'), 0, 'enabling reduced motion clears existing particles immediately');
  await run("setHud('transcribing'); true");
  await pause(180);
  assert.strictEqual(await run('orbVisualRaf'), 0, 'reduced motion never starts the sphere or processing particle loop');
  assert.strictEqual(await run('styleTest.particles().visible'), 0, 'reduced motion leaves processing static without particles');
  assert.strictEqual(await run('styleTest.processingEchoes().shown'), false, 'reduced motion suppresses the expanding pulse echoes');
  const staticProcessing = await run('styleTest.canvasFrame()');
  await pause(150);
  assert.strictEqual((await run('styleTest.canvasFrame()')).hash, staticProcessing.hash, 'reduced processing keeps the actual glass pixels still');
  assert.ok(staticProcessing.covered > 100, 'reduced motion retains a visible processing shape');
  for (const style of styles) {
    await run(`setHud('idle'); applyFlowBarStyle(${JSON.stringify(style)}); onCursor({ hover: false }); resetIdleFace(); startIdleFace(); true`);
    assert.strictEqual(await run('idleFacePlaying'), false, style + ' respects reduced motion at rest');
    await run("setHud('recording'); stopWaveLoop(); resetWave(); styleTest.advance(.006, 180); true");
    const before = await run('styleTest.advance(.006, 1)');
    const canvasBefore = style === 'orb' ? await run('styleTest.canvasFrame()') : null;
    const after = await run('styleTest.advance(.006, 30)');
    assert.ok(before.heights.every((h, i) => Math.abs(h - after.heights[i]) < .05), style + ' stops decorative recording movement for reduced motion');
    if (style === 'ribbon') assert.strictEqual(before.path, after.path, 'reduced-motion Ribbon remains stable at constant input');
    assert.ok(after.glow > .2, style + ' reduced motion retains microphone feedback');
    if (style === 'orb') assert.strictEqual((await run('styleTest.canvasFrame()')).hash, canvasBefore.hash, 'reduced motion keeps the actual energy texture still at constant input');
    assert.strictEqual(await run('styleTest.particles().visible'), 0, style + ' reduced motion never emits particles');
  }
  assert.strictEqual(await run('testMicRequests'), 0, 'changing styles and running idle scenes never requests microphone access');
  await run("window.dispatchEvent(new Event('beforeunload')); true");
  assert.strictEqual(await run('orbVisualRaf'), 0, 'unloading releases the sphere frame loop');
  assert.strictEqual((await run('styleTest.canvasFrame()')).covered, 0, 'unloading disposes the rendered sphere pixels');
  overlay.webContents.debugger.detach();
  overlay.webContents.stopPainting();
  await pause(100);
  overlay.destroy();
  }

  const settings = new BrowserWindow(windowOptions(1120, 760));
  watchErrors(settings);
  await settings.loadFile(path.join(__dirname, '../src/app.html'));
  const settingRun = code => settings.webContents.executeJavaScript(code);
  await settingRun(`navigator.mediaDevices.getUserMedia = async () => { throw new Error('Preference preview requested a microphone'); };
    navigator.mediaDevices.enumerateDevices = async () => []; true`);
  await pause(250);
  await settingRun(`document.getElementById('nav-settings').click(); document.querySelector('.settings-cat[data-cat="system"]').click(); true`);
  await settingRun(`window.previewPaints = 0;
    const previewCanvas = document.getElementById('flow-preview-energy-orb');
    const previewContext = previewCanvas.getContext('2d');
    const putPreviewImage = previewContext.putImageData.bind(previewContext);
    previewContext.putImageData = (...args) => { window.previewPaints++; return putPreviewImage(...args); };
    window.previewFrame = () => {
      const data = previewContext.getImageData(0, 0, previewCanvas.width, previewCanvas.height).data;
      let hash = 2166136261, covered = 0;
      for (let i = 0; i < data.length; i++) hash = Math.imul(hash ^ data[i], 16777619);
      for (let i = 3; i < data.length; i += 4) if (data[i] > 200) covered++;
      return { hash: hash >>> 0, covered, paints: previewPaints };
    }; true`);
  const selected = () => settingRun(`Array.from(document.querySelectorAll('.flow-style-card')).filter(el => el.getAttribute('aria-checked') === 'true').map(el => el.dataset.flowStyle)`);
  assert.deepStrictEqual(await selected(), ['classic'], 'settings visibly defaults to Classic for an existing profile');
  assert.deepStrictEqual(await settingRun(`Array.from(document.querySelectorAll('.flow-style-card')).map(el => ({ style: el.dataset.flowStyle, role: el.getAttribute('role') }))`), styles.map(style => ({ style, role: 'radio' })), 'all three choices have accessible radio semantics');
  const togglesBefore = actions.filter(action => action === 'toggle').length;
  for (const style of styles) {
    await settingRun(`document.querySelector('.flow-style-card[data-flow-style="${style}"]').click(); true`);
    await pause(60);
    assert.deepStrictEqual(await selected(), [style], 'only the selected style is checked');
    if (style !== 'classic') assert.strictEqual(snapshot.flowBarStyle, style, 'style preference is saved through the real preload');
  }
  await settingRun(`const card = document.querySelector('.flow-style-card[data-flow-style="orb"]'); card.focus(); card.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })); true`);
  await pause(60);
  assert.deepStrictEqual(await selected(), ['ribbon'], 'arrow keys select the adjacent style');
  assert.strictEqual(snapshot.flowBarStyle, 'ribbon', 'keyboard selection persists');
  assert.strictEqual(await settingRun('document.activeElement.dataset.flowStyle'), 'ribbon', 'keyboard focus follows the selected style');
  for (const [key, expected] of [['Home', 'classic'], ['End', 'orb'], ['ArrowRight', 'classic'], ['ArrowUp', 'orb']]) {
    await settingRun(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true })); true`);
    await pause(60);
    assert.deepStrictEqual(await selected(), [expected], key + ' selects the expected card');
    assert.strictEqual(await settingRun('document.activeElement.dataset.flowStyle'), expected, key + ' moves focus');
    assert.strictEqual(await settingRun(`document.querySelectorAll('.flow-style-card[tabindex="0"]').length`), 1, 'only one radio card is in the tab order');
  }
  saveDelay = 100;
  await settingRun(`for (const style of ['classic', 'ribbon', 'orb', 'ribbon']) document.querySelector('.flow-style-card[data-flow-style="' + style + '"]').click(); true`);
  await pause(280);
  assert.strictEqual(snapshot.flowBarStyle, 'ribbon', 'rapid choices persist the final preference');
  assert.deepStrictEqual(await selected(), ['ribbon'], 'a slower earlier save cannot overwrite the final visible choice');
  saveDelay = 0;
  failNextSave = true;
  await settingRun(`document.querySelector('.flow-style-card[data-flow-style="orb"]').click(); true`);
  await pause(80);
  assert.strictEqual(snapshot.flowBarStyle, 'ribbon', 'failed saves preserve the existing preference');
  assert.deepStrictEqual(await selected(), ['ribbon'], 'failed saves restore the actual selected style');
  assert.strictEqual(await settingRun(`document.getElementById('flow-style-status').hidden`), false, 'save failure is visible and recoverable');
  await settingRun(`document.querySelector('.flow-style-card[data-flow-style="orb"]').click(); true`);
  await pause(60);
  assert.deepStrictEqual(await selected(), ['orb'], 'a failed style choice can be retried');
  assert.strictEqual(await settingRun(`document.getElementById('flow-style-status').hidden`), true, 'a successful retry clears the failure');
  await settingRun(`document.querySelector('.flow-style-card[data-flow-style="ribbon"]').click(); true`);
  await pause(60);
  assert.ok(saves.some(patch => patch.flowBarStyle === 'orb') && saves.some(patch => patch.flowBarStyle === 'ribbon'), 'both new styles reach settings IPC');
  assert.strictEqual(actions.filter(action => action === 'toggle').length, togglesBefore, 'preview selection never starts a recording');
  await screenshot(settings, 'settings');
  // A hidden test window cannot acquire native keyboard focus. Apply Chromium's
  // actual focus-visible pseudo state after testing the radio keyboard handler.
  await settingRun(`document.querySelector('.flow-style-card[data-flow-style="classic"]').focus(); true`);
  settings.webContents.debugger.attach('1.3');
  await settings.webContents.debugger.sendCommand('DOM.enable');
  await settings.webContents.debugger.sendCommand('CSS.enable');
  const { root } = await settings.webContents.debugger.sendCommand('DOM.getDocument');
  let previousPreview = 0;
  for (const style of styles) {
    if (previousPreview) await settings.webContents.debugger.sendCommand('CSS.forcePseudoState', { nodeId: previousPreview, forcedPseudoClasses: [] });
    const { nodeId } = await settings.webContents.debugger.sendCommand('DOM.querySelector', { nodeId: root.nodeId, selector: '.flow-style-card[data-flow-style="' + style + '"]' });
    await settings.webContents.debugger.sendCommand('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: ['focus-visible'] });
    await settingRun(`(() => { const card = document.querySelector('.flow-style-card[data-flow-style="${style}"]');
      card.focus();
      // The hidden native window keeps document.hasFocus() false. Exercise the
      // same focus event the visible app receives, alongside Chromium's CSS state.
      if (!document.hasFocus()) card.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    })(); true`);
    await pause(80);
    if (style === 'orb') {
      const before = await settingRun('previewFrame()');
      await pause(120);
      const after = await settingRun('previewFrame()');
      const visibility = await settingRun(`({ hidden: document.hidden, active: document.activeElement.dataset.flowStyle,
        rect: document.getElementById('flow-preview-energy-orb').getBoundingClientRect().toJSON(),
        display: getComputedStyle(document.getElementById('flow-preview-energy-orb')).display })`);
      assert.ok(after.covered > 200 && after.hash !== before.hash && after.paints > before.paints,
        'focused Orb preview renders the same flowing material as the overlay: ' + JSON.stringify({ before, after, visibility }));
    } else {
      assert.ok(await settingRun(`document.getAnimations().some(animation => animation instanceof CSSAnimation && animation.effect.target.closest('.flow-style-card[data-flow-style="${style}"]'))`), style + ' keyboard focus animates its live preview');
    }
    await screenshot(settings, 'settings-' + style + '-preview');
    previousPreview = nodeId;
  }
  await settingRun(`document.querySelector('.settings-cat[data-cat="sound"]').click(); true`);
  await pause(100);
  const hiddenPreview = await settingRun('previewFrame()');
  await pause(120);
  assert.deepStrictEqual(await settingRun('previewFrame()'), hiddenPreview, 'an offscreen settings card stops drawing its energy texture');
  await settingRun(`document.querySelector('.settings-cat[data-cat="system"]').click(); document.querySelector('.flow-style-card[data-flow-style="orb"]').focus(); true`);
  await pause(140);
  assert.ok((await settingRun('previewFrame()')).paints > hiddenPreview.paints, 'returning to the focused card resumes its preview');
  await settings.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await pause(50);
  assert.ok(await settingRun(`document.getAnimations().every(animation => !animation.effect.target.closest('.flow-style-preview'))`), 'preference previews respect reduced motion');
  assert.strictEqual(await settingRun(`document.querySelector('.flow-preview-orb-particles')`), null, 'Orb preview is a single flowing sphere without the old particle and chip artwork');
  const reducedPreview = await settingRun('previewFrame()');
  await pause(140);
  assert.deepStrictEqual(await settingRun('previewFrame()'), reducedPreview, 'reduced motion renders one static preview and stops scheduling frames');
  for (const width of [800, 640]) {
    settings.setContentSize(width, 650);
    await pause(160);
    const fit = await settingRun(`(() => {
      const cards = [...document.querySelectorAll('.flow-style-card')];
      return cards.every(el => { const r = el.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth + 1 && el.scrollWidth <= el.clientWidth + 1; });
    })()`);
    assert.ok(fit, 'style choices remain readable at ' + width + 'px');
  }
  await settingRun("window.dispatchEvent(new PageTransitionEvent('pagehide')); true");
  assert.strictEqual((await settingRun('previewFrame()')).covered, 0, 'leaving the page disposes the preview texture');
  await new Promise(resolve => { settings.webContents.once('did-finish-load', resolve); settings.webContents.reload(); });
  await pause(180);
  assert.deepStrictEqual(await selected(), ['ribbon'], 'saved style is restored after opening the app again');
  assert.deepStrictEqual(errors, [], 'overlay and preference renderers remain free of errors');
  settings.webContents.debugger.detach();
  settings.webContents.stopPainting();
  await pause(100);
  clearTimeout(deadline);
  console.log(process.argv.includes('--settings-only')
    ? 'Flow style settings: persistence, keyboard access, rapid choices, failed-save recovery, focused previews, reduced motion and compact layout passed.'
    : 'Flow styles: state and control geometry at three scales, continuous recording, deferred changes, Ribbon layers, pooled speech particles, reduced motion, preference persistence and keyboard access passed.');
  // Let the main loop finish pending offscreen paint callbacks before exiting.
  // Destroying the last OSR window from this promise can re-enter V8 during
  // Electron 36 native teardown after all assertions have already passed.
  setImmediate(() => app.exit(0));
}).catch(error => { console.error(error); clearTimeout(deadline); app.exit(1); });
