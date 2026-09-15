'use strict';

// Drives the real overlay renderer, because the drag and the hover cluster are
// both made of state that only exists once the page is running: body classes,
// a hover rect measured against the live window, and pointer capture. A
// regression here is a bar that either cannot be picked up or cannot be put
// down, and neither is visible from a source-level check.

const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'voxden-flow-ui-')));
app.disableHardwareAcceleration();
const deadline = setTimeout(() => { console.error('Flow bar UI test timed out'); app.exit(1); }, 40000);

// Matches overlaySize() in main.js. The hover rects are measured off the
// window, so testing at another size would test another geometry.
const WIDTH = 260;
const HEIGHT = 96;

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: WIDTH,
    height: HEIGHT,
    useContentSize: true,
    webPreferences: {
      preload: path.join(__dirname, '../src/preload.js'),
      contextIsolation: true,
      sandbox: false,
      backgroundThrottling: false,
    },
  });
  const errors = [];
  win.webContents.on('console-message', (event, level, message) => {
    // Electron 36 moved this to a single event object; accept both shapes so
    // the guard keeps working either side of that change.
    const lvl = event && event.level !== undefined ? event.level : level;
    const text = event && event.message !== undefined ? event.message : message;
    const bad = lvl === 'error' || Number(lvl) >= 3;
    if (bad && !/Content-Security-Policy/.test(String(text))) errors.push(String(text));
  });

  // What the two buttons are for is an IPC message, so watch the real channels
  // rather than the window.voxden bridge -- contextBridge objects are frozen,
  // and stubbing one only proves that the stub was called.
  const sent = [];
  ipcMain.on('overlay-settings', () => sent.push('overlaySettings'));
  ipcMain.on('overlay-capture-screen', () => sent.push('captureScreen'));
  ipcMain.on('hud-confirm', () => sent.push('confirm'));
  ipcMain.on('hud-cancel', () => sent.push('cancel'));
  ipcMain.handle('toggle', async () => { sent.push('toggle'); return { mode: 'idle' }; });
  await win.loadFile(path.join(__dirname, '../src/overlay.html'));
  const evaluate = code => win.webContents.executeJavaScript(code);

  // A window with show:false stops producing frames as soon as nothing is
  // animating, so a bare double-rAF never returns once the bar settles. The
  // timeout is the one that fires on a still page; the frames are what make it
  // quick while something is still moving.
  const settle = () => evaluate(
    'new Promise(r => { requestAnimationFrame(() => requestAnimationFrame(() => r(1))); setTimeout(() => r(1), 120); })'
  );

  async function state(payload) {
    win.webContents.send('state', { soundsEnabled: false, alwaysShowFlowBar: true, ...payload });
    await settle();
  }
  async function cursor(x, y, inside) {
    win.webContents.send('hud-cursor', { x, y, inside: inside !== false });
    await settle();
  }
  const cls = () => evaluate('Array.from(document.body.classList)');
  const clickable = id => evaluate(`getComputedStyle(document.getElementById('${id}')).pointerEvents`);
  const finishTransitions = () => evaluate(`document.getAnimations().filter(a => a.transitionProperty)
    .forEach(a => { try { a.finish(); } catch (_) {} }); true`);
  async function clickControl(id, edge) {
    await finishTransitions();
    const point = await evaluate(`(() => {
      const element = document.getElementById(${JSON.stringify(id)});
      const r = element.getBoundingClientRect();
      const x = ${edge ? 'Math.floor(r.right - 1)' : 'Math.round(r.left + r.width / 2)'};
      const y = Math.round(r.top + r.height / 2);
      const target = document.elementFromPoint(x, y);
      return { x, y, hit: target === element || element.contains(target) };
    })()`);
    assert.ok(point.hit, id + ' must be the actual hit target at its ' + (edge ? 'edge' : 'centre'));
    win.webContents.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y });
    win.webContents.sendInputEvent({ type: 'mouseDown', x: point.x, y: point.y, button: 'left', clickCount: 1 });
    // Hold long enough for active/hover transitions to finish. Changing the
    // target's geometry while pressed can silently drop the mouse-up click.
    await finishTransitions();
    win.webContents.sendInputEvent({ type: 'mouseUp', x: point.x, y: point.y, button: 'left', clickCount: 1 });
    await settle();
  }

  // The overlay's own reveal path, same as a real launch.
  await state({ mode: 'idle', reveal: true, flowBarMotion: 'full' });
  assert.ok((await cls()).includes('shown'), 'the bar has to be on screen to be dragged');
  assert.ok((await cls()).includes('always-flow'));
  assert.ok(!(await cls()).includes('flow-expanded'), 'the resting bar starts collapsed');

  // --- The hover cluster ------------------------------------------------------
  // Nothing is grabbable until the pointer is on the bar.
  assert.strictEqual(await clickable('flow-drag'), 'none', 'the grip must not be hit-testable at rest');
  assert.strictEqual(await clickable('flow-settings'), 'none', 'the gear must not be hit-testable at rest');
  assert.strictEqual(await clickable('flow-capture'), 'none', 'the screenshot button must not be hit-testable at rest');

  // The centre of the resting bar: the window's mid-line, just above its floor.
  const barY = HEIGHT - 16;
  await cursor(WIDTH / 2, barY);
  assert.ok((await cls()).includes('flow-expanded'), 'hovering the bar opens it');
  assert.strictEqual(await clickable('flow-drag'), 'auto', 'the grip appears with the mic');
  assert.strictEqual(await clickable('flow-settings'), 'auto', 'the gear appears with the mic');

  // All three buttons must sit inside the hover rect that keeps the cluster
  // open, or they would vanish the moment the cursor left the bar itself.
  await finishTransitions();
  for (const id of ['flow-drag', 'flow-settings', 'flow-capture']) {
    const box = await evaluate(`(() => { const r = document.getElementById('${id}').getBoundingClientRect();
      return { cx: r.left + r.width / 2, cy: r.top + r.height / 2 }; })()`);
    await cursor(box.cx, box.cy);
    assert.ok((await cls()).includes('flow-expanded'), id + ' falls outside the hover zone it lives in');
    assert.strictEqual(await clickable(id), 'auto', id + ' stops being clickable when hovered directly');
  }

  // Leaving collapses it again.
  await cursor(4, 4);
  assert.ok(!(await cls()).includes('flow-expanded'), 'the bar closes when the pointer leaves');

  // --- Picking the bar up and putting it down --------------------------------
  const grab = `(() => {
    const el = document.getElementById('flow-drag');
    const r = el.getBoundingClientRect();
    el.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true, cancelable: true, button: 0, pointerId: 7, isPrimary: true,
      clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
    }));
    return true;
  })()`;

  await cursor(WIDTH / 2, barY);
  await evaluate(grab);
  await settle();
  assert.ok((await cls()).includes('flow-dragging'), 'the grip has to start a drag');
  assert.strictEqual(await evaluate('dragging'), true);

  // The window chases the cursor, so its own hover poll goes stale. Acting on
  // it would collapse the bar to a 6px line halfway through the gesture.
  await cursor(0, 0, false);
  assert.ok((await cls()).includes('flow-dragging'), 'a stale hover reading must not end the drag');
  assert.ok((await cls()).includes('flow-expanded'), 'the bar must stay open while it is carried');
  await evaluate(`window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 7 })); true`);
  await settle();
  assert.strictEqual(await evaluate('dragging'), false, 'a release anywhere has to end the drag');
  assert.ok(!(await cls()).includes('flow-dragging'));

  // Main ends a drag it owns with no pointerup ever reaching the page. This is
  // the stuck-machine case: Windows takes the pointer capture away, so none of
  // the renderer's own release backstops fire, and the bar used to stay open
  // until the next dictation. The hud-drag-end channel is the only thing that
  // puts it down.
  await cursor(WIDTH / 2, barY);
  await evaluate(grab);
  await settle();
  assert.strictEqual(await evaluate('dragging'), true, 'the drag has to be running before main ends it');
  win.webContents.send('hud-drag-end');
  await settle();
  assert.strictEqual(await evaluate('dragging'), false, 'a main-side drag end has to clear the renderer drag flag');
  assert.ok(!(await cls()).includes('flow-dragging'), 'the dragging class has to come off with no pointerup');
  // And hover is obeyed again: a leave now collapses the bar, which it could
  // not do while dragging was latched. Still sent as {x,y,inside} with no hover
  // boolean, so the renderer's own fallback zone test stays exercised.
  await cursor(4, 4, false);
  assert.ok(!(await cls()).includes('flow-expanded'), 'the bar collapses once main has ended the drag');

  // A hotkey can start a dictation with the button still down, and the
  // recording pill has no grip to let go of.
  await cursor(WIDTH / 2, barY);
  await evaluate(grab);
  assert.strictEqual(await evaluate('dragging'), true);
  await state({ mode: 'arming', prepareOnly: true });
  assert.strictEqual(await evaluate('dragging'), false, 'leaving idle has to put the bar down');
  assert.ok(!(await cls()).includes('flow-dragging'));
  assert.strictEqual(await clickable('flow-drag'), 'none', 'the grip belongs to the resting bar only');
  assert.strictEqual(await evaluate("getComputedStyle(document.querySelector('.glyph-mic')).position"), 'absolute',
    'the mic must not jump into flex layout while the capsule is morphing');

  await state({ mode: 'cancel', text: 'Cancelled' });
  await state({ mode: 'idle' });

  // --- The confirm chip says what it does --------------------------------------
  // One chip, two jobs: Stop while recording, Retry once there is something to
  // retry. It wore the same tick for both, and "what does the tick do right
  // now" was a real question. The glyphs are stacked and faded rather than
  // swapped by display, so the row never measures differently mid-morph.
  const lit = sel => evaluate(`Number(getComputedStyle(document.querySelector('${sel}')).opacity)`);
  const confirmTitle = () => evaluate("document.getElementById('btn-confirm').title");
  // A recording state from main opens the microphone first, which a headless
  // harness has none of, so the page would sit in arming. The HUD is set the
  // way capture-ready sets it, straight to the recording shape.
  await state({ canRetry: true });
  await evaluate("setHud('recording'); 1");
  await settle();
  assert.strictEqual(await lit('.act-confirm .ico-stop'), 1, 'recording shows the stop square');
  assert.strictEqual(await lit('.act-confirm .ico-retry'), 0, 'recording does not show the retry arrow');
  assert.strictEqual(await clickable('btn-confirm'), 'auto', 'the chip is clickable while recording');
  assert.match(await confirmTitle(), /^Stop/, 'the chip is titled as a stop while recording');
  await state({ mode: 'success', text: 'Hello there', entryId: 'e1', canRetry: true });
  assert.strictEqual(await lit('.act-confirm .ico-retry'), 1, 'a result with a kept clip shows the retry arrow');
  assert.strictEqual(await lit('.act-confirm .ico-stop'), 0, 'a result does not show the stop square');
  assert.match(await confirmTitle(), /^Retry/, 'the chip is titled as a retry after a result');
  await state({ mode: 'success', text: 'Hello there', entryId: 'e2', canRetry: false });
  assert.strictEqual(await lit('.act-confirm .ico-retry'), 0, 'no clip to retry means no arrow');
  assert.strictEqual(await clickable('btn-confirm'), 'none', 'and no chip to click');
  await state({ mode: 'idle' });

  // Exercise the input path Chromium actually hit-tests. element.click()
  // bypasses pointer-events, invisible layers and overlapping decorations,
  // which made previous tests pass even if a user's Stop click could not land.
  // Main's native click-through flag is covered by test-flow-bar-main.js.
  for (const style of ['classic', 'ribbon', 'orb']) {
    await state({ mode: 'idle', flowBarStyle: style });
    await evaluate("setHud('recording'); true");
    await settle();
    const finish = style === 'orb' ? 'orb-finish' : 'btn-confirm';
    const cancel = style === 'orb' ? 'orb-discard' : 'btn-cancel';
    for (const edge of [false, true]) {
      sent.length = 0;
      await clickControl(finish, edge);
      assert.deepStrictEqual(sent, ['confirm'], style + ' Stop click must reach the real confirm IPC exactly once');
      sent.length = 0;
      await clickControl(cancel, edge);
      assert.deepStrictEqual(sent, ['cancel'], style + ' Cancel click must reach the real cancel IPC exactly once');
    }
    await state({ mode: 'success', text: 'Hello there', entryId: 'retry-' + style, canRetry: true });
    sent.length = 0;
    await clickControl('btn-confirm');
    assert.deepStrictEqual(sent, ['confirm'], style + ' Retry must remain clickable after the recording completes');
    await state({ mode: 'idle' });
  }
  await state({ mode: 'idle', flowBarStyle: 'classic' });

  // The three controls unfold up, left and right. Sample actual Chromium
  // transitions so a shared diagonal translation or a snapped exit fails even
  // if every settled position still happens to be correct.
  const unfoldMotion = `(() => {
    const ids = ['flow-settings', 'flow-capture', 'flow-drag'];
    const finish = () => {
      void pill.offsetWidth;
      document.getAnimations().filter(a => a.transitionProperty)
        .forEach(a => { try { a.finish(); } catch (_) {} });
      void pill.offsetWidth;
    };
    const sample = () => {
      const result = Object.fromEntries(ids.map(id => {
        const element = document.getElementById(id), r = element.getBoundingClientRect();
        const css = getComputedStyle(element);
        return [id, { x: r.left + r.width / 2, y: r.top + r.height / 2,
          size: r.width, opacity: Number(css.opacity), fill: css.backgroundColor, color: css.color,
          durations: css.transitionDuration.split(',').map(parseFloat),
          delays: css.transitionDelay.split(',').map(parseFloat),
          properties: css.transitionProperty.split(',').map(p => p.trim()) }];
      }));
      if (flowBarStyle === 'orb') {
        // The incoming controls pass beneath the sphere. Making them
        // clickable immediately must not steal a quick microphone click.
        const r = orbTrigger.getBoundingClientRect();
        result.orbMisses = [];
        for (const dx of [-8, 0, 8]) {
          for (const dy of [-8, 0, 8]) {
            const target = document.elementFromPoint(r.left + r.width / 2 + dx, r.top + r.height / 2 + dy);
            if (target !== orbTrigger && !orbTrigger.contains(target)) {
              result.orbMisses.push({ dx, dy, target: target && (target.id || target.className) });
            }
          }
        }
      }
      return result;
    };
    onCursor({ inside: false });
    finish();
    const traces = [];
    for (const opening of [true, false]) {
      onCursor({ x: innerWidth / 2, y: innerHeight - 16, inside: opening });
      void pill.offsetWidth;
      const animations = document.getAnimations().filter(a => a.transitionProperty);
      animations.forEach(a => { a.pause(); a.currentTime = 0; });
      const frames = [];
      for (const time of [0, 40, 80, 120, 140, 180, 240, 320, 400]) {
        animations.forEach(a => { a.currentTime = Math.min(time, a.effect.getComputedTiming().endTime); });
        frames.push(sample());
      }
      traces.push(frames);
      finish();
    }
    return traces;
  })()`;
  for (const style of ['classic', 'ribbon', 'orb']) {
    await state({ mode: 'idle', flowBarStyle: style });
    const traces = await evaluate(unfoldMotion);
    for (const [index, frames] of traces.entries()) {
      const opening = index === 0;
      if (style === 'orb') {
        for (const [frame, sample] of frames.entries()) {
          assert.deepStrictEqual(sample.orbMisses, [],
            `Orb microphone must remain the hit target during ${opening ? 'opening' : 'closing'} frame ${frame}`);
        }
      }
      for (const [id, axis, direction] of [
        ['flow-settings', 'x', -1], ['flow-capture', 'y', -1], ['flow-drag', 'x', 1],
      ]) {
        const context = `${style} ${id} ${opening ? 'opening' : 'closing'}`;
        const sign = opening ? direction : -direction;
        const first = frames[0][id], last = frames[frames.length - 1][id];
        assert.ok((last[axis] - first[axis]) * sign > 8, context + ' must travel along its own direction');
        const crossAxis = axis === 'x' ? 'y' : 'x';
        assert.ok(Math.abs(last[crossAxis] - first[crossAxis]) < .2, context + ' must stay on its axis');
        assert.ok((last.size - first.size) * (opening ? 1 : -1) > 4, context + ' must scale with its travel');
        for (const frame of frames) {
          const control = frame[id];
          assert.strictEqual(control.opacity, 1, context + ' stays opaque throughout the reveal');
          assert.strictEqual(control.fill, 'rgb(0, 0, 0)', context + ' keeps a solid black fill');
          assert.strictEqual(control.color, 'rgb(255, 255, 255)', context + ' keeps crisp white icons');
          assert.ok(control.durations.every(seconds => seconds <= .14), context + ' completes within 140ms');
          assert.ok(control.delays.every((seconds, i) => seconds === 0 || (!opening && control.properties[i] === 'visibility')),
            context + ' has no staggered motion');
        }
        assert.ok(Math.abs(frames[4][id][axis] - last[axis]) < .2 && Math.abs(frames[4][id].size - last.size) < .2,
          context + ' reaches its final geometry by 140ms');
        assert.ok(frames[1][id].size > Math.min(first.size, last.size) + .2 && frames[1][id].size < Math.max(first.size, last.size) - .2,
          context + ' travels through intermediate geometry without snapping');
        for (let i = 1; i < frames.length; i++) {
          assert.ok((frames[i][id][axis] - frames[i - 1][id][axis]) * sign >= -.2,
            context + ' must not reverse direction midway');
        }
      }
    }

    await cursor(WIDTH / 2, barY);
    await finishTransitions();
    const boxes = await evaluate(`Object.fromEntries(['pill', 'flow-settings', 'flow-capture', 'flow-drag'].map(id => {
      const r = document.getElementById(id).getBoundingClientRect();
      return [id, { left: r.left, top: r.top, right: r.right, bottom: r.bottom,
        cx: r.left + r.width / 2, cy: r.top + r.height / 2 }];
    }))`);
    const core = boxes.pill, settings = boxes['flow-settings'], capture = boxes['flow-capture'], drag = boxes['flow-drag'];
    assert.ok(Math.abs(capture.cx - core.cx) < .2, style + ' screenshot must be centred above the bar');
    assert.ok(core.top - capture.bottom >= 5, style + ' screenshot must clear the top of the bar');
    assert.ok(settings.right < core.left && drag.left > core.right, style + ' side controls must clear the bar');
    assert.ok(Math.abs(core.cx - settings.cx - (drag.cx - core.cx)) < .2,
      style + ' settings and grip must balance on either side');
    assert.ok(Math.abs(settings.cy - core.cy) < .2 && Math.abs(drag.cy - core.cy) < .2,
      style + ' side controls must align with the bar centre');
    for (const [id, box] of Object.entries(boxes)) {
      assert.ok(box.left >= 0 && box.top >= 4 && box.right <= WIDTH && box.bottom <= HEIGHT,
        style + ' ' + id + ' must fit inside the real overlay window with top clearance');
    }

    // Walk through the empty gap above the microphone, not just directly to
    // the destination. A smaller stay rect would close midway to Screenshot.
    for (let step = 0; step <= 4; step++) {
      await cursor(core.cx, core.cy + (capture.cy - core.cy) * step / 4);
      assert.ok((await cls()).includes('flow-expanded'), style + ' must remain open on the path to Screenshot');
    }
    for (const edge of [false, true]) {
      for (const [id, channel] of [['flow-settings', 'overlaySettings'], ['flow-capture', 'captureScreen']]) {
        const box = boxes[id];
        await cursor(box.cx, box.cy);
        sent.length = 0;
        await clickControl(id, edge);
        assert.deepStrictEqual(sent, [channel], style + ' ' + id + ' must send only its own action');
      }
    }

    await cursor(4, 4, false);
    await finishTransitions();
    await cursor(capture.cx, capture.cy);
    assert.ok(!(await cls()).includes('flow-expanded'), style + ' hidden screenshot slot must not open the bar');
    for (const id of ['flow-settings', 'flow-capture', 'flow-drag']) {
      const hidden = await evaluate(`(() => {
        const element = document.getElementById(${JSON.stringify(id)}), s = getComputedStyle(element);
        const r = element.getBoundingClientRect();
        const target = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return { events: s.pointerEvents, visibility: s.visibility,
          hit: target === element || element.contains(target) };
      })()`);
      assert.deepStrictEqual(hidden, { events: 'none', visibility: 'hidden', hit: false },
        style + ' ' + id + ' must be inert once collapsed');
    }

    await state({ flowBarMotion: 'reduced' });
    await cursor(WIDTH / 2, barY);
    const timing = await evaluate(`Array.from(document.querySelectorAll('.flow-side'), element => {
      const s = getComputedStyle(element);
      return { duration: s.transitionDuration.split(',').map(parseFloat), delay: s.transitionDelay.split(',').map(parseFloat) };
    })`);
    for (const control of timing) {
      assert.ok(control.duration.every(seconds => seconds <= .001), style + ' reduced motion must remove the travel duration');
      assert.ok(control.delay.every(seconds => seconds === 0), style + ' reduced motion must remove the reveal stagger');
    }
    await cursor(4, 4, false);
    await state({ flowBarMotion: 'full' });
  }
  await state({ mode: 'idle', flowBarStyle: 'classic' });

  // --- The morph --------------------------------------------------------------
  // The capsule has no width of its own -- it is as wide as its chips are at
  // that instant -- so any chip that changes size in a step drags the whole
  // shape with it, and the mic, which is placed against the capsule's edge,
  // goes along for the ride. Every one of those steps reads as a stutter on a
  // shape this small, and the two worst were a hundred pixels each.
  //
  // Sampling is done by hand rather than by watching real frames: an offscreen
  // window stops producing them, and stepping the transitions is exact anyway.
  // What is asserted is only that nothing doubles back -- a morph that reverses
  // is a morph with a kink in it, whatever its size.
  const morph = `(function (from, to) {
    const pill = document.getElementById('pill');
    const mic = document.querySelector('.glyph-mic');
    // Every state that can carry a line is measured carrying one, since the
    // line's own width is part of what the capsule has to follow.
    document.getElementById('label').textContent = 'Loading speech model';
    const shape = s => 'shown always-flow flow-expanded' + (s.split(' ')[0] === 'idle' ? ' flow-idle' : '');
    pill.className = 'pill ' + from;
    document.body.className = shape(from);
    document.getAnimations().forEach(a => a.cancel());
    void pill.offsetWidth;
    pill.className = 'pill ' + to;
    document.body.className = shape(to);
    void pill.offsetWidth;
    const anims = document.getAnimations().filter(a => a.transitionProperty);
    anims.forEach(a => { a.pause(); a.currentTime = 0; });
    let worst = 0;
    let prev = null;
    let heading = 0;
    for (let t = 0; t <= 400; t += 5) {
      anims.forEach(a => {
        try { a.currentTime = Math.min(t, a.effect.getTiming().duration); } catch (_) {}
      });
      const box = pill.getBoundingClientRect();
      const eye = mic.getBoundingClientRect();
      const now = { w: box.width, x: eye.left + eye.width / 2 };
      if (prev) {
        for (const k of ['w', 'x']) {
          const step = now[k] - prev[k];
          if (Math.abs(step) < 0.005) continue;
          if (heading[k] && Math.sign(step) !== heading[k]) worst = Math.max(worst, Math.abs(step));
          heading[k] = Math.sign(step);
        }
      } else {
        heading = { w: 0, x: 0 };
      }
      prev = now;
    }
    anims.forEach(a => { try { a.play(); } catch (_) {} });
    return Math.round(worst * 100) / 100;
  })`;
  // Sub-pixel is layout rounding; anything a person could see is not.
  const SMOOTH = 0.5;
  for (const [from, to] of [
    ['idle', 'arming'], ['arming', 'recording'], ['idle', 'recording'],
    ['recording', 'transcribing'], ['transcribing', 'success'],
    ['recording', 'cancel'], ['success', 'idle'],
    // The loading note is the one line a state picks up rather than is born
    // with, so it arrives and leaves mid-morph in a way none of the others do.
    ['transcribing', 'transcribing has-line'], ['transcribing has-line', 'success'],
    ['recording', 'transcribing has-line'],
  ]) {
    const worst = await evaluate(`${morph}(${JSON.stringify(from)}, ${JSON.stringify(to)})`);
    assert.ok(worst < SMOOTH,
      `${from} -> ${to} has to move one way only; it doubled back by ${worst}px`);
  }

  // A real click can interrupt hover, then leave arming before its animation
  // finishes. Settled-state pairs miss both the auto-width dip and the loading
  // chip's shortened reverse transition. Preserve each running transition's
  // time when retargeting, as the browser does during a fast microphone start.
  const interruptedStart = `(function (hoverMs, armingMs) {
    const icon = document.querySelector('.glyph-mic svg');
    const transitions = () => document.getAnimations().filter(a => a.transitionProperty);
    const advance = ms => {
      const animations = transitions();
      const bases = animations.map(a => a.currentTime || 0);
      animations.forEach((a, i) => {
        a.pause(); a.currentTime = Math.min(bases[i] + ms, a.effect.getTiming().duration);
      });
      void pill.offsetWidth;
    };
    const sample = () => {
      const m = icon.getBoundingClientRect();
      return { x: m.x + m.width / 2, w: pill.getBoundingClientRect().width };
    };
    document.body.className = 'shown always-flow flow-idle';
    pill.className = 'pill idle';
    label.textContent = '';
    void pill.offsetWidth;
    document.getAnimations().forEach(a => { try { a.finish(); } catch (_) {} });
    void pill.offsetWidth;
    document.body.classList.add('flow-expanded');
    void pill.offsetWidth;
    advance(hoverMs);
    pill.className = 'pill arming';
    document.body.classList.remove('flow-idle');
    void pill.offsetWidth;
    advance(armingMs);
    const before = sample();
    pill.className = 'pill recording';
    void pill.offsetWidth;
    const animations = transitions();
    const bases = animations.map(a => a.currentTime || 0);
    animations.forEach(a => a.pause());
    let minX = before.x, maxWidth = before.w, rebound = 0, shrink = 0;
    for (let t = 0; t <= 320; t += 5) {
      animations.forEach((a, i) => {
        a.currentTime = Math.min(bases[i] + t, a.effect.getTiming().duration);
      });
      const now = sample();
      minX = Math.min(minX, now.x);
      maxWidth = Math.max(maxWidth, now.w);
      rebound = Math.max(rebound, now.x - minX);
      shrink = Math.max(shrink, maxWidth - now.w);
    }
    document.getAnimations().forEach(a => { try { a.finish(); } catch (_) {} });
    return { rebound, shrink };
  })`;
  for (const hoverMs of [30, 80, 160, 300]) {
    for (const armingMs of [0, 30, 80, 160, 300]) {
      const motion = await evaluate(`${interruptedStart}(${hoverMs}, ${armingMs})`);
      assert.ok(motion.rebound < .2 && motion.shrink < .2,
        `click after ${hoverMs}ms hover, ${armingMs}ms startup: mic rebounded ${motion.rebound}px, capsule shrank ${motion.shrink}px`);
    }
  }
  await state({ mode: 'idle' });

  // The centre still dictates after using the surrounding controls.
  sent.length = 0;
  await cursor(WIDTH / 2, barY);
  await clickControl('pill');
  assert.deepStrictEqual(sent, ['toggle'], 'clicking the bar must still start a dictation');

  assert.deepStrictEqual(errors, []);
  console.log('real overlay: directional controls, hover paths, hidden hit targets, reduced motion, drag, state morphs and interrupted microphone starts passed');
  clearTimeout(deadline);
  win.destroy();
  app.quit();
}).catch(err => { console.error(err); app.exit(1); });
