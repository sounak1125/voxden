'use strict';

// Inspect the real Island renderer: its resting pill across the old idle-scene
// delay, the open capsule and its controls, every dictation state, the spring
// the shape moves on, the pixels painted while it opens, drag by the bar, rapid
// reversals, reduced motion and switching styles. Input goes through Chromium's
// own hit testing.
const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'voxden-island-flow-')));
app.disableHardwareAcceleration();
const deadline = setTimeout(() => { console.error('Island flow UI timed out'); app.exit(1); }, 90000);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const shots = process.argv.includes('--screenshots');
const folder = path.join(__dirname, '../temp/ui-review');

// The spring every Island size term rides (flow-styles.css).
const SPRING = [0, 0.013, 0.0476, 0.0978, 0.159, 0.2269, 0.2984, 0.3708, 0.4422, 0.5109, 0.576, 0.6365, 0.6922, 0.7426, 0.7878, 0.8278, 0.8629, 0.8932, 0.9192, 0.9413, 0.9596, 0.9748, 0.9871, 0.9968, 1.0044, 1.0101, 1.0143, 1.0171, 1.0189, 1.0197, 1.0199, 1.0196, 1.0188, 1.0177, 1.0165, 1.0151, 1.0137, 1.0123, 1.0108, 1.0095, 1.0082, 1.007, 1.0059, 1.0049, 1.0041, 1.0033, 1.0026, 1.002, 1];

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
  const sent = [];
  ipcMain.handle('toggle', () => { sent.push('toggle'); return { mode: 'idle' }; });
  ipcMain.on('overlay-settings', () => sent.push('settings'));
  ipcMain.on('overlay-capture-screen', () => sent.push('capture'));
  ipcMain.on('overlay-drag-start', () => sent.push('drag-start'));
  ipcMain.on('overlay-drag-end', () => sent.push('drag-end'));
  ipcMain.on('hud-confirm', () => sent.push('confirm'));
  ipcMain.on('hud-cancel', () => sent.push('cancel'));
  await win.loadFile(path.join(__dirname, '../src/overlay.html'));
  const run = code => win.webContents.executeJavaScript(code);
  const shoot = async name => {
    if (!shots) return;
    await run(`document.documentElement.style.background = '#23272f'; true`);
    await pause(60);
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'island-' + name + '.png'), (await win.webContents.capturePage()).toPNG());
    await run(`document.documentElement.style.removeProperty('background'); true`);
  };

  assert.strictEqual(await run('document.body.dataset.flowStyle'), 'island', 'a fresh overlay is Island before any state arrives');
  await run(`soundsEnabled = false; alwaysShowFlowBar = true; VoxdenFlowMotion.setPreference('full');
    window.islandMicRequests = 0;
    navigator.mediaDevices.getUserMedia = async () => { islandMicRequests++; throw new Error('Unexpected microphone request'); };
    setHud('idle'); popIn();
    window.island = (() => {
      const box = el => { const r = el.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2 }; };
      const pillBox = () => box(pill);
      // A 1px border can be quantised to .8 CSS pixels at fractional scaling.
      const snapshot = () => {
        const s = getComputedStyle(pill), r = pill.getBoundingClientRect();
        return { width: Math.round(r.width), height: Math.round(r.height), fill: s.backgroundColor,
          border: s.borderTopColor, radius: s.borderTopLeftRadius, shadow: s.boxShadow, overflow: s.overflowX,
          sheen: getComputedStyle(pill, '::before').display, glow: getComputedStyle(pill, '::after').display,
          animations: document.getAnimations().filter(a => a.playState === 'running').length,
          meter: raf, orb: orbVisualRaf };
      };
      const visible = el => { const s = getComputedStyle(el); return s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity) > .9; };
      const inside = (inner, outer, slack = .6) => inner.l >= outer.l - slack && inner.r <= outer.r + slack && inner.t >= outer.t - slack && inner.b <= outer.b + slack;
      const finish = () => { void pill.offsetWidth; document.getAnimations().filter(a => a.transitionProperty).forEach(a => { try { a.finish(); } catch (_) {} }); void pill.offsetWidth; };
      // Glows are blurred shadows, filters, text shadows or radial fills,
      // anywhere in the overlay. Zero-blur rings are edges, and allowed.
      const glows = () => {
        const out = [];
        for (const el of [document.body, ...document.body.querySelectorAll('*')]) {
          // Only what can paint: a display:none subtree draws nothing.
          if (!el.checkVisibility()) continue;
          for (const pseudo of [null, '::before', '::after']) {
            const s = getComputedStyle(el, pseudo);
            if (pseudo && (s.display === 'none' || s.content === 'none')) continue;
            const blurred = s.boxShadow !== 'none' && s.boxShadow.split(/,(?![^(]*\\))/).some(part => {
              const lengths = (part.match(/-?[\\d.]+px/g) || []).map(parseFloat);
              return lengths.length >= 3 && lengths[2] > 0;
            });
            if (blurred || s.filter !== 'none' || s.textShadow !== 'none' || /radial-gradient/.test(s.backgroundImage)) {
              out.push((el.id || el.className.baseVal || el.className) + (pseudo || ''));
            }
          }
        }
        return out;
      };
      const S = ${JSON.stringify(SPRING)};
      const spring = p => { if (p <= 0) return 0; if (p >= 1) return 1; const x = p * 48, i = Math.floor(x); return S[i] + (S[i + 1] - S[i]) * (x - i); };
      // Step the real CSS transitions between two states and compare the
      // capsule with the spring it is meant to follow.
      function morph(from, to, watch = []) {
        from(); finish();
        const a = pillBox();
        to(); void pill.offsetWidth;
        const anims = document.getAnimations().filter(x => x.transitionProperty);
        anims.forEach(x => x.pause());
        const frames = [];
        for (let t = 0; t <= 600; t += 10) {
          anims.forEach(x => { x.currentTime = Math.min(t, x.effect.getComputedTiming().endTime); });
          const p = pillBox();
          const f = { t, w: p.w, h: p.h, cx: p.cx };
          for (const sel of watch) {
            const el = document.querySelector(sel);
            f[sel] = Number(getComputedStyle(el).opacity);
            f[sel + '@'] = box(el);
          }
          frames.push(f);
        }
        finish();
        const b = pillBox();
        let worst = 0;
        for (const f of frames) {
          const e = spring(f.t / 540);
          worst = Math.max(worst, Math.abs(f.w - (a.w + (b.w - a.w) * e)), Math.abs(f.h - (a.h + (b.h - a.h) * e)));
        }
        const ws = frames.map(f => f.w);
        const travel = Math.abs(b.w - a.w);
        const over = b.w > a.w ? Math.max(...ws) - b.w : b.w - Math.min(...ws);
        // How far each watched element travels while it can be seen, measured
        // against where it settles: content that rides the shape shakes.
        const moves = {};
        for (const sel of watch) {
          const end = box(document.querySelector(sel));
          moves[sel] = Math.max(0, ...frames.filter(f => f[sel] > .02)
            .map(f => Math.max(Math.abs(f[sel + '@'].cx - end.cx), Math.abs(f[sel + '@'].cy - end.cy))));
        }
        return { from: a, to: b, worst, overshoot: travel > 1 ? over / travel : 0, drift: Math.max(...frames.map(f => Math.abs(f.cx - frames[0].cx))), frames, moves };
      }
      return { box, pillBox, snapshot, visible, inside, finish, glows, morph };
    })(); true`);
  // The first state springs the boot shape to rest; 540ms and it is done.
  await pause(900);
  const resting = await run('island.snapshot()');
  assert.deepStrictEqual(resting, { width: 36, height: 10, fill: 'rgb(0, 0, 0)', border: 'rgba(255, 255, 255, 0.3)',
    radius: '16px', shadow: 'none', overflow: 'clip', sheen: 'none', glow: 'none', animations: 0, meter: 0, orb: 0 },
  'Island rests as a plain black 36 x 10 pill with a hairline and nothing else');
  assert.ok(await run(`[...pill.querySelectorAll('.glyph-mic, .flow-side, .act, .wave, .spinner, .label, .glyph-check, .glyph-error')].every(el => Number(getComputedStyle(el).opacity) === 0)`),
    'nothing shows inside the resting pill');
  assert.deepStrictEqual(await run('island.glows()'), [], 'the resting pill has no glow or shadow of any kind');

  // This crosses the old 22-second character timer on a real clock. Watching
  // animation starts also catches a scene that has already ended by the sample.
  await run(`window.islandIdleAnimations = [];
    document.addEventListener('animationstart', e => islandIdleAnimations.push(e.animationName));
    document.addEventListener('transitionrun', e => islandIdleAnimations.push('transition:' + e.propertyName)); true`);
  await pause(23000);
  assert.deepStrictEqual(await run('island.snapshot()'), resting, 'idle stays unchanged beyond the former character timer');
  assert.deepStrictEqual(await run('islandIdleAnimations'), [], 'nothing starts moving while the pill rests');
  await shoot('rest');

  // --- Open: settings, microphone and screenshot inside one capsule -----------
  for (const preference of ['full', 'reduced', 'full']) {
    await run(`VoxdenFlowMotion.setPreference('${preference}'); onCursor({ hover: true }); true`);
    const timing = await run(`[settingsBtn, captureScreenBtn, document.querySelector('.glyph-mic')].map(e => {
      const s = getComputedStyle(e), props = s.transitionProperty.split(',').map(p => p.trim());
      const at = name => props.indexOf(name) < 0 ? props.indexOf('all') : props.indexOf(name);
      // Shorter lists repeat, as the used value does (reduced motion writes one duration).
      const d = s.transitionDuration.split(',').map(parseFloat), l = s.transitionDelay.split(',').map(parseFloat);
      const pick = (list, name) => list[at(name) % list.length];
      return { opacity: [pick(d, 'opacity'), pick(l, 'opacity')], transform: [pick(d, 'transform'), pick(l, 'transform')] };
    })`);
    for (const control of timing) {
      if (preference === 'reduced') {
        assert.ok(control.opacity[0] <= .001 && control.transform[0] <= .001 && control.opacity[1] === 0 && control.transform[1] === 0,
          'reduced motion reveals the controls without motion: ' + JSON.stringify(control));
      } else {
        assert.ok(Math.abs(control.opacity[1] - .04) < .001 && control.opacity[0] <= .2,
          'controls fade in about 40ms after the capsule starts growing: ' + JSON.stringify(control));
      }
    }
    await pause(700);
    const open = await run(`(() => {
      const p = island.pillBox(), mic = document.querySelector('.glyph-mic');
      const part = el => { const s = getComputedStyle(el), b = island.box(el);
        return { box: b, fill: s.backgroundColor, color: s.color, pointer: s.pointerEvents, visible: island.visible(el), inPill: pill.contains(el) }; };
      return { p, settings: part(settingsBtn), capture: part(captureScreenBtn), mic: part(mic),
        grip: getComputedStyle(dragHandle).display, gripPointer: getComputedStyle(dragHandle).pointerEvents,
        shadow: getComputedStyle(pill).boxShadow, glows: island.glows(),
        icons: [settingsBtn, captureScreenBtn].map(b => [...b.querySelectorAll('svg')].map(s =>
          (s.classList.contains('side-icon-island') ? 'island' : 'shared') + ':' + getComputedStyle(s).display)) };
    })()`);
    assert.deepStrictEqual(open.icons, [['island:block', 'shared:none'], ['island:block', 'shared:none']],
      preference + ': Island draws its own dashed gear and viewfinder, not the shared icons');
    assert.strictEqual(Math.round(open.p.w), 104, preference + ': the open capsule is 104px wide');
    assert.strictEqual(Math.round(open.p.h), 32, preference + ': the open capsule is 32px tall');
    assert.strictEqual(open.shadow, 'none');
    assert.deepStrictEqual(open.glows, [], preference + ': the open capsule has no glow or shadow');
    assert.strictEqual(open.grip, 'none', 'Island has no grip');
    assert.strictEqual(open.gripPointer, 'none', 'the hidden grip can never take a press');
    for (const [name, part, offset] of [['settings', open.settings, -36], ['mic', open.mic, 0], ['capture', open.capture, 36]]) {
      assert.ok(part.visible && part.inPill, name + ' is shown inside the capsule');
      assert.ok(Math.abs(part.box.w - 28) < .1 && Math.abs(part.box.h - 28) < .1, name + ' is a 28px control');
      assert.ok(Math.abs(part.box.cx - (open.p.cx + offset)) < .6 && Math.abs(part.box.cy - open.p.cy) < .6, name + ' sits ' + offset + 'px from the centre');
      assert.ok(island_inside(part.box, open.p), name + ' lies within the capsule');
    }
    assert.strictEqual(open.mic.fill, 'rgb(44, 44, 46)', 'the microphone is a #2c2c2e disc');
    assert.strictEqual(open.mic.color, 'rgb(255, 255, 255)', 'with a white microphone');
    for (const side of [open.settings, open.capture]) {
      assert.strictEqual(side.fill, 'rgba(0, 0, 0, 0)', 'settings and screenshot are bare glyphs until hovered');
      assert.strictEqual(side.color, 'rgba(235, 235, 245, 0.62)', 'drawn in the secondary grey');
      assert.strictEqual(side.pointer, 'auto', 'and clickable');
    }
    if (shots && preference === 'full') await shoot('hover');
    // Reverse mid-flight repeatedly; the pointer must never latch it open.
    for (let i = 0; i < 8; i++) {
      await run(`onCursor({ hover: ${i % 2 === 0 ? 'false' : 'true'} }); true`);
      await pause(35);
    }
    await run('onCursor({ hover: false }); true');
    await pause(700);
    assert.deepStrictEqual(await run('island.snapshot()'), resting, preference + ' settles exactly after rapid reversals');
  }

  // --- Every dictation state ---------------------------------------------------
  const state = async (code, wait = 700) => { await run(code + '; true'); await pause(wait); };
  const look = () => run(`(() => {
    const p = island.pillBox(), s = getComputedStyle(pill);
    const part = sel => { const el = document.querySelector(sel); return { box: island.box(el), visible: island.visible(el), fill: getComputedStyle(el).backgroundColor, color: getComputedStyle(el).color, pointer: getComputedStyle(el).pointerEvents }; };
    return { p, fill: s.backgroundColor, border: s.borderTopColor, radius: s.borderTopLeftRadius, glows: island.glows(),
      running: document.getAnimations().filter(a => a.playState === 'running').map(a => a.animationName || a.transitionProperty),
      cancel: part('#btn-cancel'), confirm: part('#btn-confirm'), wave: part('#wave'), spinner: part('#spinner'),
      label: part('#label'), check: part('.glyph-check'), error: part('.glyph-error'), undo: part('#btn-undo'), mic: part('.glyph-mic'), polish: part('#btn-polish'),
      bang: Number(getComputedStyle(document.querySelector('.glyph-bang')).opacity),
      stop: Number(getComputedStyle(document.querySelector('.ico-stop')).opacity),
      retry: Number(getComputedStyle(document.querySelector('.ico-retry')).opacity),
      text: label.textContent, overflow: label.scrollWidth > label.clientWidth + .5,
      bars: [...document.querySelectorAll('#wave i')].map(bar => { const b = island.box(bar); return { w: b.w, h: b.h, fill: getComputedStyle(bar).backgroundColor }; }) };
  })()`);
  const material = (seen, name) => {
    assert.strictEqual(seen.fill, 'rgb(0, 0, 0)', name + ' keeps the black body');
    assert.strictEqual(seen.border, 'rgba(255, 255, 255, 0.3)', name + ' keeps the one hairline');
    assert.strictEqual(seen.radius, '16px', name + ' keeps the 16px radius');
    assert.deepStrictEqual(seen.glows, [], name + ' has no glow or shadow of any kind');
    assert.ok(!seen.mic.visible, name + ' hides the idle microphone');
  };
  await run(`onCursor({ hover: true }); true`);
  await pause(300);
  await state("canRetry = true; setHud('arming')");
  let seen = await look();
  material(seen, 'arming');
  assert.deepStrictEqual([Math.round(seen.p.w), Math.round(seen.p.h)], [120, 32], 'arming is a 120 x 32 capsule');
  assert.ok(!seen.cancel.visible && !seen.confirm.visible && seen.cancel.pointer === 'none' && seen.confirm.pointer === 'none', 'arming shows no buttons yet');
  assert.strictEqual(Number(await run("getComputedStyle(document.getElementById('wave')).opacity")), .45, 'arming shows the meter at .45');
  assert.ok(seen.bars.length === 13 && seen.bars.every(bar => bar.h > 2.5 && bar.h < 3.5 && Math.abs(bar.w - 2) < .05), 'arming holds the 13 bars at their 3px minimum');
  assert.deepStrictEqual(seen.running, [], 'arming runs no loop of its own');
  await shoot('arming');

  await state("setHud('recording'); stopWaveLoop(); resetWave(); for (let i = 0; i < 60; i++) updateWave(1 / 60, .02, null)");
  seen = await look();
  material(seen, 'recording');
  assert.deepStrictEqual([Math.round(seen.p.w), Math.round(seen.p.h)], [120, 32], 'recording keeps the arming capsule, so nothing moves on the first audio frame');
  for (const [name, chip, colour] of [['cancel', seen.cancel, 'rgba(235, 235, 245, 0.78)'], ['stop', seen.confirm, 'rgb(255, 255, 255)']]) {
    assert.ok(chip.visible && chip.pointer === 'auto', name + ' is shown and clickable');
    assert.ok(Math.abs(chip.box.w - 24) < .1 && Math.abs(chip.box.h - 24) < .1, name + ' is a 24px disc');
    assert.strictEqual(chip.fill, 'rgb(44, 44, 46)', name + ' is filled #2c2c2e');
    assert.strictEqual(chip.color, colour, name + ' glyph colour');
    assert.ok(Math.abs(chip.box.cy - seen.p.cy) < .6, name + ' is centred vertically');
  }
  assert.ok(Math.abs(seen.cancel.box.l - seen.p.l - 4) < 1 && Math.abs(seen.p.r - seen.confirm.box.r - 4) < 1, 'cancel and stop sit concentric with the capsule ends');
  assert.ok(seen.stop === 1 && seen.retry === 0, 'the stop square, not the retry arrow');
  assert.ok(seen.bars.every(bar => Math.abs(bar.w - 2) < .05 && bar.fill === 'rgb(156, 243, 196)'), 'the meter is 2px mint bars');
  assert.ok(Math.max(...seen.bars.map(bar => bar.h)) > 8 && seen.bars.every(bar => bar.h >= 2.5 && bar.h <= 18.5), 'voice lifts the bars within 3..18px');
  assert.ok(Math.abs(seen.wave.box.cx - seen.p.cx) < .6 && Math.abs(seen.wave.box.w - 50) < .1, 'the 50px meter is centred');
  const steady = await run(`(() => { const w = pill.getBoundingClientRect().width; for (let i = 0; i < 90; i++) updateWave(1 / 60, i % 20 < 10 ? 1 : .0007, null);
    return Math.abs(pill.getBoundingClientRect().width - w) < .05 && [...document.querySelectorAll('#wave i')].every(bar => { const b = bar.getBoundingClientRect(), p = pill.getBoundingClientRect(); return b.top >= p.top + 3 && b.bottom <= p.bottom - 3; }); })()`);
  assert.ok(steady, 'the meter moves inside the capsule without resizing it');
  await shoot('recording');
  await run(`document.getElementById('btn-confirm').click(); document.getElementById('btn-cancel').click(); true`);
  await pause(40);
  assert.deepStrictEqual(sent.slice(-2), ['confirm', 'cancel'], 'stop and cancel keep their IPC actions');

  await state("stopWaveLoop(); setHud('transcribing')");
  seen = await look();
  material(seen, 'transcribing');
  assert.deepStrictEqual([Math.round(seen.p.w), Math.round(seen.p.h)], [56, 32], 'transcribing is a 56 x 32 capsule');
  assert.ok(seen.spinner.visible && Math.abs(seen.spinner.box.w - 16) < .1 && Math.abs(seen.spinner.box.cx - seen.p.cx) < .6, 'a 16px spinner sits at its centre');
  const spin = await run(`(() => { const turn = document.querySelector('.spinner-turn'), a = turn.getAnimations()[0];
    const spokes = [...turn.querySelectorAll('i')].map(i => { const s = getComputedStyle(i), b = i.getBoundingClientRect(); return { opacity: Number(s.opacity), w: s.width, h: s.height, fill: s.backgroundColor }; });
    return { running: a && a.playState, name: a && a.animationName, duration: a && a.effect.getTiming().duration,
      easing: a && getComputedStyle(turn).animationTimingFunction, spokes }; })()`);
  assert.strictEqual(spin.running, 'running', 'the spinner turns while transcribing');
  assert.strictEqual(spin.name, 'island-spin');
  assert.strictEqual(spin.duration, 820, 'about 820ms a turn');
  assert.strictEqual(spin.easing, 'steps(8)', 'in eight steps');
  assert.deepStrictEqual(spin.spokes.map(s => s.opacity), [1, .86, .72, .6, .48, .38, .3, .24], 'eight spokes fading from the brightest');
  assert.ok(spin.spokes.every(s => s.w === '2px' && s.h === '5px' && s.fill === 'rgb(255, 255, 255)'), 'white 2 x 5 spokes');
  assert.deepStrictEqual(seen.running, ['island-spin'], 'the spinner is the only thing moving');
  await shoot('transcribing');
  // Stopping keeps the step the spinner was on while it fades, instead of
  // snapping back to its first; the next turn starts from the first again.
  const hold = await run(`(() => {
    const turn = document.querySelector('.spinner-turn');
    turn.getAnimations()[0].currentTime = 310;
    const before = getComputedStyle(turn).transform;
    setHud('cancel', 'Cancelled');
    const after = getComputedStyle(turn).transform;
    const spinning = document.getAnimations().some(a => a.animationName === 'island-spin');
    setHud('transcribing');
    const m = new DOMMatrix(before);
    return { before, after, spinning, restart: turn.style.transform, angle: Math.round(Math.atan2(m.b, m.a) * 180 / Math.PI) };
  })()`);
  assert.strictEqual(hold.angle, 135, 'the spinner is three steps into its turn');
  assert.strictEqual(hold.after, hold.before, 'and stops on that step rather than snapping back');
  assert.strictEqual(hold.spinning, false, 'without keeping the turn running');
  assert.strictEqual(hold.restart, '', 'a new turn starts from the first step');
  await state("setHud('transcribing', 'Loading speech model…')");
  seen = await look();
  assert.ok(seen.spinner.visible && seen.label.visible, 'the loading note shows beside the spinner');
  assert.ok(seen.spinner.box.r <= seen.label.box.l - 7.5 && Math.abs(seen.spinner.box.cy - seen.p.cy) < .6, 'spinner on the left, the note after it');
  assert.ok(Math.abs(seen.spinner.box.l - seen.p.l - 8) < 1 && Math.abs(seen.p.r - seen.label.box.r - 13) < 2, 'the note capsule is padded from its ends');
  assert.ok(!seen.overflow, 'a short note is never ellipsised');
  await shoot('transcribing-note');

  await state("canRetry = false; successEntryId = 'island-1'; setHud('success', 'A thought, captured clearly.')");
  seen = await look();
  material(seen, 'success');
  assert.strictEqual(Math.round(seen.p.h), 32);
  assert.ok(seen.check.visible && Math.abs(seen.check.box.w - 18) < .1 && seen.check.fill === 'rgb(156, 243, 196)', 'success shows an 18px mint mark');
  assert.strictEqual(await run("getComputedStyle(document.querySelector('.glyph-check')).color"), 'rgb(0, 0, 0)', 'with a black tick');
  assert.ok(Math.abs(seen.check.box.l - seen.p.l - 7) < 1, 'the mark sits concentric with the capsule end');
  assert.ok(seen.label.visible && seen.label.color === 'rgb(255, 255, 255)' && !seen.overflow, 'with the whole line in white');
  assert.ok(Math.abs(seen.label.box.l - seen.check.box.r - 8) < .6 && Math.abs(seen.p.r - seen.label.box.r - 13) < 2, 'mark, 8px gap, text, 12px end');
  assert.ok(!seen.confirm.visible && seen.confirm.pointer === 'none', 'no retry without a kept clip');
  assert.strictEqual(await run(`(() => { const s = getComputedStyle(label); return s.fontWeight + ' ' + s.fontSize + '/' + s.lineHeight; })()`), '600 12px/16px', 'Segoe 600, 12px on 16px');
  await shoot('success');
  await state("canRetry = true; setHud('success', 'A long transcription result that must stay within the floating capsule and leave the action visible.')");
  seen = await look();
  assert.ok(seen.confirm.visible && seen.confirm.pointer === 'auto' && seen.retry === 1 && seen.stop === 0, 'a kept clip adds retry');
  assert.ok(Math.abs(seen.confirm.box.w - 24) < .1 && Math.abs(seen.p.r - seen.confirm.box.r - 4) < 1, 'retry is a 24px disc at the capsule end');
  assert.ok(seen.overflow && seen.label.box.w <= 196.5, 'a long line is ellipsised inside the capsule');
  assert.ok(seen.p.l >= 4 && seen.p.r <= 256, 'the widest result stays inside the 260px window with room to spare');
  assert.ok(Math.abs(seen.label.box.r + 8 - seen.confirm.box.l) < .6, 'text, 8px gap, retry');
  assert.ok(!seen.polish.visible && seen.polish.pointer === 'none', 'no Polish without a Pro offer');
  await shoot('success-retry');
  const retryEnd = seen.p.r - seen.confirm.box.r;
  // Pro: Polish joins Retry, and the line gives up the room for it.
  await state("polishOffer = { label: '0.25 credits', credits: .25 }; setHud('success', 'A long transcription result that must stay within the floating capsule and leave the action visible.')");
  seen = await look();
  material(seen, 'success with Polish');
  assert.ok(seen.polish.visible && seen.polish.pointer === 'auto' && Math.abs(seen.polish.box.w - 24) < .1, 'a Pro result adds a 24px Polish disc');
  assert.strictEqual(seen.polish.fill, 'rgb(245, 200, 76)', 'a solid Pro gold disc');
  assert.strictEqual(seen.polish.color, 'rgb(31, 22, 0)', 'with a dark sparkle');
  assert.ok(Math.abs(seen.label.box.r + 8 - seen.polish.box.l) < .6 && Math.abs(seen.polish.box.r + 6 - seen.confirm.box.l) < .6, 'text, 8px, Polish, 6px, Retry');
  assert.ok(Math.abs(seen.p.r - seen.confirm.box.r - retryEnd) < 1.1 && seen.p.l >= 4 && seen.p.r <= 256, 'Retry keeps the capsule end and the capsule stays inside the window');
  assert.ok(seen.overflow && Math.abs(seen.polish.box.t - seen.p.t - 4) < 1, 'the line ellipsises and Polish sits level with Retry');
  assert.strictEqual(await run('btnPolish.title'), 'Polish · 0.25 credits', 'the price shows before a click');
  await shoot('success-polish');
  await state("canRetry = false; setHud('success', 'A thought, captured clearly.')");
  seen = await look();
  assert.ok(seen.polish.visible && !seen.confirm.visible && Math.abs(seen.p.r - seen.polish.box.r - retryEnd) < 1.1, 'without a kept clip Polish takes the capsule end');
  await state("canRetry = true; polishOffer = null; setHud('success', 'A long transcription result that must stay within the floating capsule and leave the action visible.')");

  // Editing a result: the line wraps, the capsule grows downwards and keeps
  // its radius, and the mark and retry stay level with the first line.
  win.setContentSize(380, 110);
  await pause(80);
  // The words take their wrapped layout at once, under a copy of the one line
  // they were, which fades off them only once they have faded in.
  const begin = await run(`(() => { beginSuccessEdit(); const twin = document.getElementById('label-twin');
    return { copy: twin.textContent === label.textContent, copyOpacity: Number(getComputedStyle(twin).opacity), copyWhite: getComputedStyle(twin).whiteSpace,
      words: Number(getComputedStyle(label).opacity), white: getComputedStyle(label).whiteSpace }; })()`);
  assert.ok(begin.copy && begin.copyOpacity > .99 && begin.copyWhite === 'nowrap', 'the one line stays on screen as a copy when an edit starts');
  assert.ok(begin.white === 'normal' && begin.words < .01, 'while the wrapped words fade in under it');
  await pause(700);
  seen = await look();
  const editing = await run(`({ cls: document.body.classList.contains('flow-editing'), white: getComputedStyle(label).whiteSpace, lines: Math.round(label.getBoundingClientRect().height / 16) })`);
  assert.ok(editing.cls && editing.white === 'normal', 'editing lets the line wrap');
  assert.ok(editing.lines >= 2 && seen.p.h > 40, 'a long line grows the capsule downwards');
  assert.strictEqual(seen.radius, '16px', 'the capsule becomes a rounded rectangle, not a stadium');
  assert.ok(Math.abs(seen.check.box.t - seen.p.t - 7) < 1 && Math.abs(seen.confirm.box.t - seen.p.t - 4) < 1, 'mark and retry stay level with the first line');
  assert.ok(island_inside(seen.label.box, seen.p) && seen.p.l >= 0 && seen.p.r <= 380 && seen.p.t >= 4, 'the edited line stays inside the capsule and the window');
  await shoot('success-editing');
  const closing = await run(`(() => { commitSuccessEdit(); return { wrapped: document.body.classList.contains('line-wrapped'), white: getComputedStyle(label).whiteSpace }; })()`);
  assert.ok(closing.wrapped && closing.white === 'normal', 'the words keep their wrap while the capsule closes around them');
  await pause(900);
  const closed = await run(`({ h: pill.getBoundingClientRect().height, wrapped: document.body.classList.contains('line-wrapped'),
    white: getComputedStyle(label).whiteSpace, ellipsis: label.scrollWidth > label.clientWidth + .5, copy: document.getElementById('label-twin').textContent })`);
  assert.strictEqual(Math.round(closed.h), 32, 'ending the edit returns the capsule to one line');
  assert.ok(!closed.wrapped && closed.white === 'nowrap' && closed.ellipsis && closed.copy === '', 'and once it has settled the words are one line again, ending in an ellipsis');
  win.setContentSize(260, 96);
  await pause(80);

  await state("canRetry = true; setHud('error', 'Mic blocked — allow microphone access')");
  seen = await look();
  material(seen, 'error');
  assert.ok(seen.error.visible && seen.error.fill === 'rgb(255, 69, 58)' && seen.bang === 1, 'an error is a red mark with "!"');
  assert.ok(seen.confirm.visible && seen.retry === 1, 'an error with a kept clip offers retry');
  await shoot('error');
  // A retry re-transcribes the kept clip straight from the result: the failed
  // line goes with it, fading out where it was, not left beside the spinner.
  const retry = await run(`(() => { setHud('transcribing'); const twin = document.getElementById('label-twin');
    return { words: label.textContent, line: pill.classList.contains('has-line'), copy: twin.textContent, copyOpacity: Number(getComputedStyle(twin).opacity) }; })()`);
  assert.deepStrictEqual([retry.words, retry.line], ['', false], 'a retry lets the failed line go');
  assert.ok(retry.copy === 'Mic blocked — allow microphone access' && retry.copyOpacity > .99, 'which fades out where it was');
  await pause(300);
  assert.strictEqual(await run("document.getElementById('label-twin').textContent"), '', 'and is gone once it has faded');
  await state("setHud('cancel', 'Cancelled')");
  seen = await look();
  material(seen, 'cancel');
  assert.ok(seen.error.visible && seen.error.fill === 'rgb(142, 142, 147)' && seen.bang === 0, 'a cancel is a grey mark with an X');
  assert.strictEqual(seen.label.color, 'rgba(235, 235, 245, 0.62)', 'and quieter text');
  assert.ok(!seen.confirm.visible, 'a cancel never offers retry');
  await shoot('cancel');
  win.setContentSize(460, 96);
  await pause(80);
  await state("learnedUndoToken = 'island-undo'; setHud('learned', 'Added “Voxden” to your dictionary')");
  seen = await look();
  material(seen, 'learned');
  assert.ok(!seen.check.visible && !seen.error.visible, 'the learned notice has no mark');
  assert.ok(seen.undo.visible && seen.undo.pointer === 'auto' && seen.undo.fill === 'rgb(44, 44, 46)' && seen.undo.color === 'rgb(255, 255, 255)', 'Undo is a #2c2c2e capsule with white text');
  assert.ok(Math.abs(seen.undo.box.h - 24) < .1 && Math.abs(seen.p.r - seen.undo.box.r - 4) < 1, 'Undo sits at the capsule end');
  assert.ok(Math.abs(seen.label.box.l - seen.p.l - 13) < 1 && Math.abs(seen.label.box.r + 8 - seen.undo.box.l) < .6, 'text, then Undo');
  await shoot('learned');
  await run("learnedUndoToken = ''; setHud('idle'); onCursor({ hover: false }); true");
  win.setContentSize(260, 96);
  await pause(800);
  assert.deepStrictEqual(await run('island.snapshot()'), resting, 'every state returns to the exact resting pill');
  assert.strictEqual(await run("label.textContent === '' && document.getElementById('label-twin').textContent === ''"), true, 'a dismissed line leaves nothing behind');

  // --- The spring ---------------------------------------------------------------
  // One shape: every width and height term rides one spring, so the capsule
  // follows it frame by frame, overshoots about 2% and stays centred. Content
  // fades in only once the shape is moving, and leaves within 100ms.
  const morphs = [
    ['rest -> open', "() => { setHud('idle'); onCursor({ hover: false }); }", "() => onCursor({ hover: true })", ['.glyph-mic', '#flow-settings', '#flow-capture']],
    ['open -> rest', "() => { setHud('idle'); onCursor({ hover: true }); }", "() => onCursor({ hover: false })", []],
    ['open -> arming', "() => { setHud('idle'); onCursor({ hover: true }); }", "() => setHud('arming')", ['#wave']],
    ['recording -> transcribing', "() => { setHud('recording'); stopWaveLoop(); }", "() => setHud('transcribing')", ['#spinner']],
    ['transcribing -> success', "() => { label.textContent = ''; setHud('transcribing'); }", "() => { canRetry = true; setHud('success', 'A thought, captured clearly.'); }", ['.glyph-check', '#label', '#btn-confirm']],
    ['note -> success', "() => { label.textContent = ''; setHud('transcribing', 'Loading speech model…'); }", "() => { canRetry = false; setHud('success', 'Hello there'); }", []],
    ['success -> rest', "() => { canRetry = false; setHud('success', 'A thought, captured clearly.'); }", "() => { setHud('idle'); onCursor({ hover: false }); }", []],
    ['recording -> cancel', "() => { setHud('recording'); stopWaveLoop(); }", "() => setHud('cancel', 'Cancelled')", ['#label']],
  ];
  for (const [name, from, to, watch] of morphs) {
    await run("setHud('idle'); onCursor({ hover: false }); island.finish(); true");
    const trace = await run(`island.morph(${from}, ${to}, ${JSON.stringify(watch)})`);
    assert.ok(trace.worst < .5, name + ' follows the spring frame by frame; worst deviation ' + trace.worst.toFixed(2) + 'px');
    assert.ok(trace.overshoot > .015 && trace.overshoot < .025, name + ' overshoots about 2%: ' + (100 * trace.overshoot).toFixed(2) + '%');
    assert.ok(trace.drift < .2, name + ' stays centred');
    const moved = trace.frames.find(f => Math.abs(f.w - trace.from.w) > .3 || Math.abs(f.h - trace.from.h) > .3);
    for (const sel of watch) {
      const first = trace.frames.find(f => f[sel] > .02);
      assert.ok(first && moved && first.t > moved.t && first.t >= 40, name + ': ' + sel + ' appears after the shape starts moving (' + (first && first.t) + 'ms)');
    }
    // The hover controls sit where they end up from their first visible frame;
    // the capsule grows around them. Riding its height spring read as a shake.
    if (name === 'rest -> open') {
      for (const sel of watch) {
        assert.ok(trace.moves[sel] < .1, name + ': ' + sel + ' stays still while the capsule opens around it (moved ' + trace.moves[sel].toFixed(2) + 'px)');
      }
    }
  }
  // A box is not a pixel. The trace above held the microphone's box still to a
  // tenth of a pixel while, on screen, its glyph hopped a whole one on a third
  // of the frames: the capsule had a layer of its own (will-change), a layer's
  // corner snaps to whole pixels, and that corner moves on every frame of this
  // morph. So read what was painted: walk the morph, capture each frame and
  // follow the glyph's brightness-weighted centre.
  const painted = [];
  await run(`setHud('idle'); onCursor({ hover: false }); island.finish(); onCursor({ hover: true }); void pill.offsetWidth;
    window.paintedAnims = document.getAnimations().filter(a => a.transitionProperty); paintedAnims.forEach(a => a.pause()); true`);
  for (let t = 0; t <= 560; t += 10) {
    const at = await run(`paintedAnims.forEach(a => { a.currentTime = Math.min(${t}, a.effect.getComputedTiming().endTime); });
      new Promise(done => requestAnimationFrame(() => requestAnimationFrame(() => {
        const mic = document.querySelector('.glyph-mic');
        done({ glyph: island.box(mic.querySelector('svg')), disc: island.box(mic), top: island.pillBox().t, opacity: Number(getComputedStyle(mic).opacity), view: innerWidth });
      })))`);
    // Only once the capsule's rim has cleared the box read below and the fade
    // is well up. Before that the rim, not the glyph, is what moves the centre.
    if (at.top > at.glyph.t - 3 || at.opacity < .3) continue;
    await pause(12);
    const image = await win.webContents.capturePage();
    const size = image.getSize(), px = image.toBitmap(), k = size.width / at.view;
    const lum = (x, y) => { const i = (y * size.width + x) * 4; return px[i] * .114 + px[i + 1] * .587 + px[i + 2] * .299; };
    // Brightness above the disc's own fill, read beside the glyph, so the fade
    // scales every weight alike and cancels out of the centre.
    const fill = lum(Math.round((at.disc.l + 4) * k), Math.round(at.disc.cy * k));
    let sum = 0, sx = 0, sy = 0;
    for (let y = Math.floor((at.glyph.t - 1) * k); y <= Math.ceil((at.glyph.b + 1) * k); y++) {
      for (let x = Math.floor((at.glyph.l - 1) * k); x <= Math.ceil((at.glyph.r + 1) * k); x++) {
        const w = Math.max(0, lum(x, y) - fill * 1.6);
        sum += w; sx += w * x; sy += w * y;
      }
    }
    if (sum > 0) painted.push({ t, x: sx / sum, y: sy / sum });
  }
  await run("island.finish(); setHud('idle'); onCursor({ hover: false }); island.finish(); true");
  const wander = axis => Math.max(...painted.map(f => f[axis])) - Math.min(...painted.map(f => f[axis]));
  assert.ok(painted.length >= 30, 'the open morph was read from its painted frames (' + painted.length + ')');
  assert.ok(wander('x') < .25 && wander('y') < .25, 'the painted microphone holds still while the capsule opens around it: wandered '
    + wander('x').toFixed(2) + ' x ' + wander('y').toFixed(2) + ' device px over ' + painted.length + ' frames');
  // The spinner appears on the capsule's centre line and stays there while
  // the recording capsule closes around it; it does not slide in from the side.
  const spinnerDrift = await run(`(() => {
    setHud('idle'); onCursor({ hover: false }); island.finish();
    setHud('recording'); stopWaveLoop(); island.finish();
    setHud('transcribing'); void pill.offsetWidth;
    const anims = document.getAnimations().filter(a => a.transitionProperty);
    anims.forEach(a => a.pause());
    let worst = 0;
    for (let t = 0; t <= 600; t += 10) {
      anims.forEach(a => { a.currentTime = Math.min(t, a.effect.getComputedTiming().endTime); });
      const p = pill.getBoundingClientRect(), s = document.getElementById('spinner').getBoundingClientRect();
      worst = Math.max(worst, Math.abs((s.left + s.right) / 2 - (p.left + p.right) / 2));
    }
    island.finish();
    return worst;
  })()`);
  assert.ok(spinnerDrift < .3, 'the spinner stays on the centre line as recording closes into transcribing: ' + spinnerDrift.toFixed(2) + 'px');
  const leaving = await run(`island.morph(() => { canRetry = false; setHud('success', 'A thought, captured clearly.'); }, () => setHud('idle'), ['#label', '.glyph-check'])`);
  const at100 = leaving.frames.find(f => f.t === 100);
  assert.ok(at100['#label'] < .01 && at100['.glyph-check'] < .01, 'leaving content is gone within 100ms');
  assert.ok(leaving.frames.slice(1, 8).every(f => f['.glyph-check'] < 1 || f.t === 0), 'and starts fading at once');
  const markColour = await run(`(() => {
    setHud('error', 'Transcription failed'); island.finish();
    setHud('idle'); void pill.offsetWidth;
    const colours = [];
    for (const t of [0, 40, 90]) { document.getAnimations().forEach(a => { a.pause(); a.currentTime = t; }); colours.push(getComputedStyle(document.querySelector('.glyph-error')).backgroundColor); }
    island.finish();
    return colours;
  })()`);
  assert.deepStrictEqual(markColour, ['rgb(255, 69, 58)', 'rgb(255, 69, 58)', 'rgb(255, 69, 58)'], 'a leaving error mark stays red while it fades');

  // An interrupted hover never jumps: each 5ms step stays within the spring's
  // own top speed as the direction flips.
  const interrupted = await run(`(() => {
    setHud('idle'); onCursor({ hover: false }); island.finish();
    const flips = { 0: true, 120: false, 210: true, 300: false };
    let prev = null, worst = 0;
    for (let t = 0; t <= 900; t += 5) {
      if (t in flips) { onCursor({ hover: flips[t] }); void pill.offsetWidth; }
      document.getAnimations().filter(a => a.transitionProperty).forEach(a => { a.pause(); a.currentTime = Math.min((a.currentTime || 0) + (t && !(t in flips) ? 5 : 0), a.effect.getComputedTiming().endTime); });
      const r = pill.getBoundingClientRect();
      if (prev) worst = Math.max(worst, Math.abs(r.width - prev.width), Math.abs(r.height - prev.height));
      prev = r;
    }
    island.finish();
    return worst;
  })()`);
  assert.ok(interrupted < 2.5, 'an interrupted hover moves continuously; largest 5ms step ' + interrupted.toFixed(2) + 'px');

  // --- Drag by the bar -----------------------------------------------------------
  // Real input through Chromium's hit testing: a press plus more than 4px of
  // travel drags, a press that stays put dictates, and the click that ends a
  // drag does not. The gear and the screenshot never drag.
  await run("setHud('idle'); VoxdenFlowMotion.setPreference('full'); onCursor({ hover: true }); true");
  await pause(700);
  const at = await run(`(() => { const c = el => { const b = el.getBoundingClientRect(); return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }; };
    return { mic: c(document.querySelector('.glyph-mic')), edge: { x: c(pill).x - 18, y: c(pill).y }, gear: c(settingsBtn), capture: c(captureScreenBtn) }; })()`);
  const gesture = async (points, label) => {
    sent.length = 0;
    const [first, ...rest] = points;
    win.webContents.sendInputEvent({ type: 'mouseMove', x: first.x, y: first.y });
    win.webContents.sendInputEvent({ type: 'mouseDown', x: first.x, y: first.y, button: 'left', clickCount: 1 });
    for (const p of rest) {
      win.webContents.sendInputEvent({ type: 'mouseMove', x: p.x, y: p.y, modifiers: ['leftButtonDown'] });
      await pause(16);
    }
    const mid = await run('({ dragging, cls: document.body.classList.contains("flow-dragging") })');
    const last = points[points.length - 1];
    win.webContents.sendInputEvent({ type: 'mouseUp', x: last.x, y: last.y, button: 'left', clickCount: 1 });
    await pause(120);
    return { mid, sent: sent.slice(), after: await run('({ dragging, cls: document.body.classList.contains("flow-dragging") })'), label };
  };
  let drag = await gesture([at.mic, { x: at.mic.x + 2, y: at.mic.y + 1 }, { x: at.mic.x + 3, y: at.mic.y + 2 }]);
  assert.deepStrictEqual(drag.sent, ['toggle'], 'a press that stays within 4px is still the click that dictates');
  assert.strictEqual(drag.mid.dragging, false, 'and never starts a drag');
  drag = await gesture([at.mic, { x: at.mic.x + 3, y: at.mic.y }, { x: at.mic.x + 9, y: at.mic.y - 2 }, { x: at.mic.x + 20, y: at.mic.y - 4 }]);
  assert.ok(drag.mid.dragging && drag.mid.cls, 'pressing the microphone and moving past 4px drags the bar');
  assert.deepStrictEqual(drag.sent, ['drag-start', 'drag-end'], 'the drag is main\'s gesture, and its release is not a dictation');
  assert.ok(!drag.after.dragging && !drag.after.cls, 'the release puts the bar down');
  drag = await gesture([at.edge, { x: at.edge.x, y: at.edge.y + 6 }, { x: at.edge.x - 10, y: at.edge.y + 6 }]);
  assert.deepStrictEqual(drag.sent, ['drag-start', 'drag-end'], 'the capsule between its controls is a handle too');
  drag = await gesture([at.mic, at.mic]);
  assert.deepStrictEqual(drag.sent, ['toggle'], 'the next plain click after a drag dictates again');
  for (const [name, point, action] of [['gear', at.gear, 'settings'], ['screenshot', at.capture, 'capture']]) {
    drag = await gesture([point, { x: point.x + 8, y: point.y }, { x: point.x + 16, y: point.y }]);
    assert.ok(!drag.mid.dragging && !drag.sent.includes('drag-start'), 'the ' + name + ' never starts a drag');
    assert.ok(!drag.sent.includes('toggle'), 'and a press on it never dictates');
    drag = await gesture([point, point]);
    assert.deepStrictEqual(drag.sent, [action], 'a click on the ' + name + ' does only its own job');
  }
  // Main can end a drag with the button still down (its 30s backstop, a hide):
  // the release that follows is still the end of a drag, not a click.
  sent.length = 0;
  win.webContents.sendInputEvent({ type: 'mouseMove', x: at.mic.x, y: at.mic.y });
  win.webContents.sendInputEvent({ type: 'mouseDown', x: at.mic.x, y: at.mic.y, button: 'left', clickCount: 1 });
  win.webContents.sendInputEvent({ type: 'mouseMove', x: at.mic.x + 12, y: at.mic.y, modifiers: ['leftButtonDown'] });
  await pause(60);
  assert.strictEqual(await run('dragging'), true);
  win.webContents.send('hud-drag-end');
  await pause(60);
  assert.strictEqual(await run('dragging'), false, 'main ending the drag clears the renderer');
  win.webContents.sendInputEvent({ type: 'mouseUp', x: at.mic.x + 12, y: at.mic.y, button: 'left', clickCount: 1 });
  await pause(120);
  assert.ok(!sent.includes('toggle'), 'the release after main ended the drag does not dictate');
  // A dictation starting mid-press takes the handle away.
  await run("onCursor({ hover: true }); true");
  await pause(200);
  sent.length = 0;
  win.webContents.sendInputEvent({ type: 'mouseDown', x: at.mic.x, y: at.mic.y, button: 'left', clickCount: 1 });
  await run("setHud('arming'); true");
  win.webContents.sendInputEvent({ type: 'mouseMove', x: at.mic.x + 14, y: at.mic.y, modifiers: ['leftButtonDown'] });
  await pause(60);
  assert.strictEqual(await run('dragging'), false, 'a press cannot become a drag once the bar has left idle');
  win.webContents.sendInputEvent({ type: 'mouseUp', x: at.mic.x + 14, y: at.mic.y, button: 'left', clickCount: 1 });
  await pause(80);
  assert.ok(!sent.includes('drag-start'));
  await run("setHud('idle'); true");

  // --- Styles and reduced motion ---------------------------------------------------
  await run(`setHud('idle'); onCursor({ hover: false }); applyFlowBarStyle('orb'); true`);
  await pause(300);
  assert.ok(await run(`settingsBtn.parentElement.id === 'flow-hit' && captureScreenBtn.parentElement.id === 'flow-hit'
    && settingsBtn.nextElementSibling === captureScreenBtn && captureScreenBtn.nextElementSibling === dragHandle`),
    'Orb gets its gear and screenshot back beside the sphere, in their original order');
  await run(`applyFlowBarStyle('classic'); true`);
  await pause(700);
  assert.strictEqual(await run('document.body.dataset.flowStyle'), 'island', 'a saved Classic opens as Island');
  assert.ok(await run('settingsBtn.parentElement === pill && captureScreenBtn.parentElement === pill'), 'Island takes them back inside the capsule');
  assert.deepStrictEqual(await run('island.snapshot()'), resting, 'returning from Orb restores the exact resting pill');
  await run(`VoxdenFlowMotion.setPreference('reduced'); setHud('transcribing'); true`);
  await pause(120);
  assert.deepStrictEqual(await run(`document.getAnimations().filter(a => a.playState === 'running').map(a => a.animationName || a.transitionProperty)`), [],
    'reduced motion holds the spinner still and moves nothing');
  assert.ok(await run(`island.visible(document.getElementById('spinner'))`), 'the still spinner still shows the work');
  await run(`VoxdenFlowMotion.setPreference('full'); setHud('idle'); true`);
  await pause(700);

  assert.strictEqual(await run('islandMicRequests'), 0, 'nothing here opens the microphone');
  assert.deepStrictEqual(errors, [], 'no renderer errors');
  win.destroy();
  clearTimeout(deadline);
  console.log('Island flow: 36 x 10 resting pill quiet past 22 seconds, 104 x 32 capsule with its controls inside, every dictation state and edit, one spring with 2% overshoot, content after the shape, drag by the bar with its click guard, rapid reversals, style switching and reduced motion passed.');
  setImmediate(() => app.exit(0));
}).catch(error => { console.error(error); clearTimeout(deadline); app.exit(1); });

function island_inside(inner, outer, slack = .6) {
  return inner.l >= outer.l - slack && inner.r <= outer.r + slack && inner.t >= outer.t - slack && inner.b <= outer.b + slack;
}
