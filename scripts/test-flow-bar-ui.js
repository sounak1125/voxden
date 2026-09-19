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
const deadline = setTimeout(() => { console.error('Flow bar UI test timed out'); app.exit(1); }, 60000);

// Matches overlaySize() in main.js. The hover rects are measured off the
// window, so testing at another size would test another geometry.
const WIDTH = 260;
const HEIGHT = 96;

// The spring every Island size term rides (flow-styles.css).
const SPRING = [0, 0.013, 0.0476, 0.0978, 0.159, 0.2269, 0.2984, 0.3708, 0.4422, 0.5109, 0.576, 0.6365, 0.6922, 0.7426, 0.7878, 0.8278, 0.8629, 0.8932, 0.9192, 0.9413, 0.9596, 0.9748, 0.9871, 0.9968, 1.0044, 1.0101, 1.0143, 1.0171, 1.0189, 1.0197, 1.0199, 1.0196, 1.0188, 1.0177, 1.0165, 1.0151, 1.0137, 1.0123, 1.0108, 1.0095, 1.0082, 1.007, 1.0059, 1.0049, 1.0041, 1.0033, 1.0026, 1.002, 1];

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
  ipcMain.on('overlay-drag-start', () => sent.push('dragStart'));
  ipcMain.on('overlay-drag-end', () => sent.push('dragEnd'));
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
  // A real press, moves with the button held, and a release, through
  // Chromium's own hit testing. `hold` runs while the button is still down.
  // Mouse moves are delivered on the next frame, and this hidden window has
  // none, so each move would wait for the release. Input is delivered in
  // order, though: a bare Shift press behind each move flushes it at once.
  async function gesture(points, hold) {
    const [first, ...rest] = points;
    win.webContents.sendInputEvent({ type: 'mouseMove', x: first.x, y: first.y });
    win.webContents.sendInputEvent({ type: 'mouseDown', x: first.x, y: first.y, button: 'left', clickCount: 1 });
    for (const p of rest) {
      win.webContents.sendInputEvent({ type: 'mouseMove', x: p.x, y: p.y, modifiers: ['leftButtonDown'] });
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Shift' });
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Shift' });
      await settle();
    }
    if (hold) await hold();
    const last = points[points.length - 1];
    win.webContents.sendInputEvent({ type: 'mouseUp', x: last.x, y: last.y, button: 'left', clickCount: 1 });
    await settle();
    await settle();
  }
  const centre = id => evaluate(`(() => { const r = document.getElementById(${JSON.stringify(id)}).getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);

  // The overlay's own reveal path, same as a real launch.
  await state({ mode: 'idle', reveal: true, flowBarMotion: 'full' });
  assert.ok((await cls()).includes('shown'), 'the bar has to be on screen to be dragged');
  assert.ok((await cls()).includes('always-flow'));
  assert.ok(!(await cls()).includes('flow-expanded'), 'the resting bar starts collapsed');
  assert.strictEqual(await evaluate('document.body.dataset.flowStyle'), 'island', 'a fresh profile gets Island');

  // --- The hover cluster (Island) ----------------------------------------------
  // Nothing is clickable until the pointer is on the bar, and Island has no
  // grip at all: the capsule itself is the handle.
  assert.strictEqual(await clickable('flow-settings'), 'none', 'the gear must not be hit-testable at rest');
  assert.strictEqual(await clickable('flow-capture'), 'none', 'the screenshot button must not be hit-testable at rest');
  assert.strictEqual(await evaluate("getComputedStyle(document.getElementById('flow-drag')).display"), 'none', 'Island draws no grip');

  // The centre of the resting bar: the window's mid-line, just above its floor.
  const barY = HEIGHT - 16;
  await cursor(WIDTH / 2, barY);
  assert.ok((await cls()).includes('flow-expanded'), 'hovering the bar opens it');
  assert.strictEqual(await clickable('flow-settings'), 'auto', 'the gear appears with the mic');
  assert.strictEqual(await clickable('flow-capture'), 'auto', 'the screenshot appears with the mic');
  assert.strictEqual(await clickable('flow-drag'), 'none', 'the grip never appears for Island');

  // Both buttons must sit inside the hover rect that keeps the capsule open,
  // or they would vanish the moment the cursor left the microphone.
  await finishTransitions();
  for (const id of ['flow-settings', 'flow-capture']) {
    const box = await centre(id);
    await cursor(box.x, box.y);
    assert.ok((await cls()).includes('flow-expanded'), id + ' falls outside the hover zone it lives in');
    assert.strictEqual(await clickable(id), 'auto', id + ' stops being clickable when hovered directly');
  }

  // Leaving collapses it again.
  await cursor(4, 4);
  assert.ok(!(await cls()).includes('flow-expanded'), 'the bar closes when the pointer leaves');

  // --- Picking Island up by the bar and putting it down ---------------------------
  // A press plus more than 4px of travel drags; a press that stays put is the
  // click that dictates; the release that ends a drag is not a click.
  await cursor(WIDTH / 2, barY);
  await finishTransitions();
  const mic = await centre('pill');
  sent.length = 0;
  await gesture([mic, { x: mic.x + 2, y: mic.y + 2 }, { x: mic.x + 3, y: mic.y + 2 }]);
  assert.deepStrictEqual(sent, ['toggle'], 'a press that moves 4px or less still dictates');
  sent.length = 0;
  let mid = null;
  await gesture([mic, { x: mic.x + 3, y: mic.y }, { x: mic.x + 8, y: mic.y - 3 }], async () => {
    mid = { dragging: await evaluate('dragging'), cls: await cls() };
    // The window chases the cursor, so its own hover poll goes stale. Acting on
    // it would collapse the capsule to its resting pill halfway through.
    await cursor(0, 0, false);
    mid.afterStale = await cls();
  });
  assert.ok(mid.dragging && mid.cls.includes('flow-dragging'), 'pressing the capsule and moving past 4px drags it');
  assert.ok(mid.afterStale.includes('flow-dragging'), 'a stale hover reading must not end the drag');
  assert.ok(mid.afterStale.includes('flow-expanded'), 'the capsule must stay open while it is carried');
  assert.strictEqual(await evaluate('dragging'), false, 'a release has to end the drag');
  assert.ok(!(await cls()).includes('flow-dragging'));
  assert.deepStrictEqual(sent, ['dragStart', 'dragEnd'], 'the drag reaches main, and the release that ends it does not dictate');

  // Main ends a drag it owns with no pointerup ever reaching the page. This is
  // the stuck-machine case: Windows takes the pointer capture away, so none of
  // the renderer's own release backstops fire, and the bar used to stay open
  // until the next dictation. The hud-drag-end channel is the only thing that
  // puts it down -- and the release that follows still is not a dictation.
  await cursor(WIDTH / 2, barY);
  sent.length = 0;
  await gesture([mic, { x: mic.x + 10, y: mic.y }], async () => {
    assert.strictEqual(await evaluate('dragging'), true, 'the drag has to be running before main ends it');
    win.webContents.send('hud-drag-end');
    await settle();
    assert.strictEqual(await evaluate('dragging'), false, 'a main-side drag end has to clear the renderer drag flag');
    assert.ok(!(await cls()).includes('flow-dragging'), 'the dragging class has to come off with no pointerup');
  });
  assert.ok(!sent.includes('toggle'), 'the release after main ended the drag is not a dictation');
  // And hover is obeyed again: a leave now collapses the bar, which it could
  // not do while dragging was latched. Still sent as {x,y,inside} with no hover
  // boolean, so the renderer's own fallback zone test stays exercised.
  await cursor(4, 4, false);
  assert.ok(!(await cls()).includes('flow-expanded'), 'the bar collapses once main has ended the drag');

  // A hotkey can start a dictation with the button still down: the recording
  // capsule is not a handle, so the bar is put down.
  await cursor(WIDTH / 2, barY);
  sent.length = 0;
  await gesture([mic, { x: mic.x + 10, y: mic.y }], async () => {
    assert.strictEqual(await evaluate('dragging'), true);
    await state({ mode: 'arming', prepareOnly: true });
    assert.strictEqual(await evaluate('dragging'), false, 'leaving idle has to put the bar down');
    assert.ok(!(await cls()).includes('flow-dragging'));
    assert.strictEqual(await clickable('flow-settings'), 'none', 'the gear belongs to the resting bar only');
  });
  assert.ok(!sent.includes('toggle'));
  assert.strictEqual(await evaluate("getComputedStyle(document.querySelector('.glyph-mic')).position"), 'absolute',
    'the mic must not jump into flex layout while the capsule is morphing');
  await state({ mode: 'cancel', text: 'Cancelled' });
  await state({ mode: 'idle' });

  // --- Orb keeps its grip ----------------------------------------------------------
  await state({ mode: 'idle', flowBarStyle: 'orb' });
  await cursor(WIDTH / 2, barY);
  assert.strictEqual(await clickable('flow-drag'), 'auto', 'Orb\'s grip appears with the sphere');
  const grab = `(() => {
    const el = document.getElementById('flow-drag');
    const r = el.getBoundingClientRect();
    el.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true, cancelable: true, button: 0, pointerId: 7, isPrimary: true,
      clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
    }));
    return true;
  })()`;
  await evaluate(grab);
  await settle();
  assert.ok((await cls()).includes('flow-dragging'), 'the grip has to start a drag');
  await cursor(0, 0, false);
  assert.ok((await cls()).includes('flow-dragging') && (await cls()).includes('flow-expanded'), 'a stale hover reading must not end a grip drag');
  await evaluate(`window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 7 })); true`);
  await settle();
  assert.strictEqual(await evaluate('dragging'), false, 'a release anywhere has to end the grip drag');
  await cursor(WIDTH / 2, barY);
  await evaluate(grab);
  win.webContents.send('hud-drag-end');
  await settle();
  assert.strictEqual(await evaluate('dragging'), false, 'main can end a grip drag too');
  await cursor(4, 4, false);
  await state({ mode: 'idle', flowBarStyle: 'island' });

  // --- The confirm chip says what it does --------------------------------------
  // One chip, two jobs: Stop while recording, Retry once there is something to
  // retry. It wore the same tick for both, and "what does the tick do right
  // now" was a real question. The glyphs are stacked and faded rather than
  // swapped by display, so the row never measures differently mid-morph.
  // The settled face: a chip on its way out holds its old face until it has
  // faded, and this window runs no frames to fade it in.
  const lit = async sel => {
    await finishTransitions();
    return evaluate(`Number(getComputedStyle(document.querySelector('${sel}')).opacity)`);
  };
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
  for (const style of ['island', 'orb']) {
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
  await state({ mode: 'idle', flowBarStyle: 'island' });

  // How the controls arrive. Orb's three unfold up, left and right from behind
  // the sphere. Island's two appear in place inside the capsule: no travel,
  // a small scale-up, and only once the capsule has started to grow. Actual
  // Chromium transitions are sampled so a shared diagonal translation, a
  // snapped exit or a reveal ahead of the shape fails even if every settled
  // position is correct.
  const revealMotion = `(() => {
    const ids = flowBarStyle === 'orb' ? ['flow-settings', 'flow-capture', 'flow-drag'] : ['flow-settings', 'flow-capture'];
    const finish = () => {
      void pill.offsetWidth;
      document.getAnimations().filter(a => a.transitionProperty)
        .forEach(a => { try { a.finish(); } catch (_) {} });
      void pill.offsetWidth;
    };
    const sample = () => {
      const p = pill.getBoundingClientRect();
      const result = { pill: { w: p.width, h: p.height, cx: p.left + p.width / 2, cy: p.top + p.height / 2 } };
      for (const id of ids) {
        const element = document.getElementById(id), r = element.getBoundingClientRect();
        const css = getComputedStyle(element);
        result[id] = { x: r.left + r.width / 2, y: r.top + r.height / 2,
          size: r.width, opacity: Number(css.opacity), fill: css.backgroundColor, color: css.color,
          durations: css.transitionDuration.split(',').map(parseFloat),
          delays: css.transitionDelay.split(',').map(parseFloat),
          properties: css.transitionProperty.split(',').map(p => p.trim()) };
      }
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
      for (const time of [0, 20, 40, 60, 80, 100, 120, 140, 180, 240, 320, 400, 600]) {
        animations.forEach(a => { a.currentTime = Math.min(time, a.effect.getComputedTiming().endTime); });
        frames.push(Object.assign(sample(), { time }));
      }
      traces.push(frames);
      finish();
    }
    return traces;
  })()`;
  for (const style of ['island', 'orb']) {
    await state({ mode: 'idle', flowBarStyle: style });
    const traces = await evaluate(revealMotion);
    for (const [index, frames] of traces.entries()) {
      const opening = index === 0;
      if (style === 'orb') {
        for (const [frame, sample] of frames.entries()) {
          assert.deepStrictEqual(sample.orbMisses, [],
            `Orb microphone must remain the hit target during ${opening ? 'opening' : 'closing'} frame ${frame}`);
        }
        const at140 = frames.findIndex(f => f.time === 140);
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
          assert.ok(Math.abs(frames[at140][id][axis] - last[axis]) < .2 && Math.abs(frames[at140][id].size - last.size) < .2,
            context + ' reaches its final geometry by 140ms');
          assert.ok(frames[1][id].size > Math.min(first.size, last.size) + .2 && frames[1][id].size < Math.max(first.size, last.size) - .2,
            context + ' travels through intermediate geometry without snapping');
          for (let i = 1; i < frames.length; i++) {
            assert.ok((frames[i][id][axis] - frames[i - 1][id][axis]) * sign >= -.2,
              context + ' must not reverse direction midway');
          }
        }
        continue;
      }
      for (const [id, offset] of [['flow-settings', -36], ['flow-capture', 36]]) {
        const context = `island ${id} ${opening ? 'opening' : 'closing'}`;
        const settled = frames[opening ? frames.length - 1 : 0][id];
        for (const frame of frames) {
          const control = frame[id];
          // Placed from the capsule's centre and pinned above its floor: no
          // sideways travel, and no rise, bounce or zoom while the capsule
          // grows around it. Riding the capsule's height read as a shake.
          assert.ok(Math.abs(control.x - (frame.pill.cx + offset)) < .3, context + ' never travels sideways (' + frame.time + 'ms)');
          assert.ok(Math.abs(control.y - settled.y) < .1, context + ' holds still while the capsule moves (' + frame.time + 'ms)');
          assert.strictEqual(control.size, 28, context + ' keeps its 28px size (' + frame.time + 'ms)');
        }
        const shapeMoved = frames.find(f => Math.abs(f.pill.w - frames[0].pill.w) > .3);
        if (opening) {
          const shown = frames.find(f => f[id].opacity > .02);
          assert.ok(shown && shapeMoved && shown.time > shapeMoved.time && shown.time >= 40,
            context + ' appears only after the capsule has started to grow');
          const final = frames[frames.length - 1][id];
          assert.ok(final.opacity === 1 && final.fill === 'rgba(0, 0, 0, 0)', context + ' ends as a bare glyph');
          assert.ok(Math.max(...final.durations) <= .18 + 1e-6 && final.delays.some(d => Math.abs(d - .04) < 1e-6), context + ' fades in over 180ms, 40ms after the shape');
        } else {
          const gone = frames.find(f => f.time === 100);
          assert.ok(gone[id].opacity === 0, context + ' has faded out within 100ms');
          assert.ok(frames[1][id].opacity < 1, context + ' starts leaving at once');
        }
      }
    }

    await cursor(WIDTH / 2, barY);
    await finishTransitions();
    const boxes = await evaluate(`Object.fromEntries(['pill', 'flow-settings', 'flow-capture', 'flow-drag'].map(id => {
      const r = document.getElementById(id).getBoundingClientRect();
      return [id, { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height,
        cx: r.left + r.width / 2, cy: r.top + r.height / 2 }];
    }))`);
    const core = boxes.pill, settings = boxes['flow-settings'], capture = boxes['flow-capture'], drag = boxes['flow-drag'];
    if (style === 'orb') {
      assert.ok(Math.abs(capture.cx - core.cx) < .2, style + ' screenshot must be centred above the bar');
      assert.ok(core.top - capture.bottom >= 5, style + ' screenshot must clear the top of the bar');
      assert.ok(settings.right < core.left && drag.left > core.right, style + ' side controls must clear the bar');
      assert.ok(Math.abs(core.cx - settings.cx - (drag.cx - core.cx)) < .2,
        style + ' settings and grip must balance on either side');
      assert.ok(Math.abs(settings.cy - core.cy) < .2 && Math.abs(drag.cy - core.cy) < .2,
        style + ' side controls must align with the bar centre');
    } else {
      assert.ok(Math.abs(core.width - 104) < 1 && Math.abs(core.height - 32) < .5, 'island opens to a 104 x 32 capsule');
      for (const [box, offset] of [[settings, -36], [capture, 36]]) {
        assert.ok(Math.abs(box.cx - core.cx - offset) < .2 && Math.abs(box.cy - core.cy) < .2, 'island controls sit 36px either side of the microphone');
        assert.ok(box.left >= core.left && box.right <= core.right && box.top >= core.top && box.bottom <= core.bottom,
          'island controls sit inside the capsule');
      }
      assert.ok(drag.width === 0 && drag.height === 0, 'island has no grip to lay out');
    }
    for (const [id, box] of Object.entries(boxes)) {
      if (!box.width) continue;
      assert.ok(box.left >= 0 && box.top >= 4 && box.right <= WIDTH && box.bottom <= HEIGHT,
        style + ' ' + id + ' must fit inside the real overlay window with top clearance');
    }

    if (style === 'orb') {
      // Walk through the empty gap above the microphone, not just directly to
      // the destination. A smaller stay rect would close midway to Screenshot.
      for (let step = 0; step <= 4; step++) {
        await cursor(core.cx, core.cy + (capture.cy - core.cy) * step / 4);
        assert.ok((await cls()).includes('flow-expanded'), style + ' must remain open on the path to Screenshot');
      }
    } else {
      // Sideways from the microphone to each control and a little past it.
      for (const box of [settings, capture]) {
        for (let step = 0; step <= 5; step++) {
          await cursor(core.cx + (box.cx - core.cx) * step / 4, core.cy);
          assert.ok((await cls()).includes('flow-expanded'), 'island must remain open on the way to each control');
        }
      }
      await cursor(core.cx, core.top - 20);
      assert.ok(!(await cls()).includes('flow-expanded'), 'island has nothing above the capsule to keep it open');
      await cursor(WIDTH / 2, barY);
      await finishTransitions();
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
    if (style === 'island') {
      // A press that starts on the gear and ends on the capsule clicks their
      // common parent, the bar. Nobody meant that as a dictation, or a drag.
      for (const id of ['flow-settings', 'flow-capture']) {
        const from = { x: Math.round(boxes[id].cx), y: Math.round(boxes[id].cy) };
        sent.length = 0;
        await gesture([from, { x: from.x + (id === 'flow-settings' ? 14 : -14), y: from.y }, { x: Math.round(core.cx), y: from.y }]);
        assert.deepStrictEqual(sent, [], 'island ' + id + ' slid onto the capsule neither drags nor dictates');
      }
    }

    await cursor(4, 4, false);
    await finishTransitions();
    await cursor(capture.cx, style === 'orb' ? capture.cy : core.top - 20);
    assert.ok(!(await cls()).includes('flow-expanded'), style + ' hidden screenshot slot must not open the bar');
    for (const id of style === 'orb' ? ['flow-settings', 'flow-capture', 'flow-drag'] : ['flow-settings', 'flow-capture']) {
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
  await state({ mode: 'idle', flowBarStyle: 'island' });

  // --- The morph --------------------------------------------------------------
  // The capsule has no width of its own -- it is as wide as its chips and their
  // margins are at that instant -- so any term that changes in a step drags the
  // whole shape with it, and a term on a second curve bends it. Island puts
  // every term on one spring, so the shape follows that spring exactly: it
  // may pass its target once by the spring's own ~2% and settle back, and must
  // never kink, step or double back anywhere else. The microphone never moves
  // sideways at all.
  //
  // Sampling is done by hand rather than by watching real frames: an offscreen
  // window stops producing them, and stepping the transitions is exact anyway.
  await evaluate(`window.morphTrace = (() => {
    const S = ${JSON.stringify(SPRING)};
    const spring = p => { if (p <= 0) return 0; if (p >= 1) return 1; const x = p * 48, i = Math.floor(x); return S[i] + (S[i + 1] - S[i]) * (x - i); };
    const finish = () => { void pill.offsetWidth; document.getAnimations().filter(a => a.transitionProperty).forEach(a => { try { a.finish(); } catch (_) {} }); void pill.offsetWidth; };
    const icon = document.querySelector('.glyph-mic');
    const measure = () => { const b = pill.getBoundingClientRect(), m = icon.getBoundingClientRect(); return { w: b.width, h: b.height, x: m.left + m.width / 2 }; };
    return (from, to) => {
      from(); finish();
      const a = measure();
      to(); void pill.offsetWidth;
      const anims = document.getAnimations().filter(x => x.transitionProperty);
      anims.forEach(x => x.pause());
      const frames = [];
      for (let t = 0; t <= 600; t += 5) {
        anims.forEach(x => { x.currentTime = Math.min(t, x.effect.getComputedTiming().endTime); });
        frames.push(Object.assign(measure(), { t }));
      }
      finish();
      const b = measure();
      // A reversal is a move back of more than .1px from the furthest point
      // reached; layout snaps each term to 1/64px, and near the turn those
      // steps alternate without the shape going anywhere.
      let worst = 0, micDrift = 0, reversals = 0, heading = 0, extreme = frames[0].w;
      for (const f of frames) {
        const e = spring(f.t / 540);
        worst = Math.max(worst, Math.abs(f.w - (a.w + (b.w - a.w) * e)), Math.abs(f.h - (a.h + (b.h - a.h) * e)));
        micDrift = Math.max(micDrift, Math.abs(f.x - a.x));
        const d = f.w - extreme;
        if (!heading) {
          if (Math.abs(d) > .1) { heading = Math.sign(d); extreme = f.w; }
        } else if (Math.sign(d) === heading) {
          extreme = f.w;
        } else if (Math.abs(d) > .1) {
          reversals++;
          heading = -heading;
          extreme = f.w;
        }
      }
      const travel = Math.abs(b.w - a.w);
      const past = b.w > a.w ? Math.max(...frames.map(f => f.w)) - b.w : b.w - Math.min(...frames.map(f => f.w));
      return { worst: Math.round(worst * 100) / 100, micDrift: Math.round(micDrift * 100) / 100, reversals, past: travel ? past / travel : 0, travel };
    };
  })(); true`);
  const hudTo = (mode, text) => `() => { ${text === undefined ? '' : "label.textContent = '';"} setHud(${JSON.stringify(mode)}${text === undefined ? '' : ', ' + JSON.stringify(text)}); }`;
  for (const [from, to] of [
    [`() => { setHud('idle'); onCursor({ hover: false }); }`, `() => onCursor({ hover: true })`],
    [`() => { setHud('idle'); onCursor({ hover: true }); }`, `() => onCursor({ hover: false })`],
    [`() => { setHud('idle'); onCursor({ hover: true }); }`, hudTo('arming')],
    [hudTo('arming'), `() => { setHud('recording'); stopWaveLoop(); }`],
    [`() => { setHud('idle'); onCursor({ hover: false }); }`, `() => { setHud('recording'); stopWaveLoop(); }`],
    [`() => { setHud('recording'); stopWaveLoop(); }`, hudTo('transcribing')],
    [hudTo('transcribing'), `() => { canRetry = true; setHud('success', 'Loading speech model'); }`],
    [`() => { setHud('recording'); stopWaveLoop(); }`, hudTo('cancel', 'Cancelled')],
    [`() => { canRetry = false; setHud('success', 'Loading speech model'); }`, `() => { setHud('idle'); onCursor({ hover: false }); }`],
    // The loading note is the one line a state picks up rather than is born
    // with, and the one a transcript replaces in place.
    [hudTo('transcribing'), hudTo('transcribing', 'Loading speech model')],
    [hudTo('transcribing', 'Loading speech model'), `() => { canRetry = false; setHud('success', 'Hello there'); }`],
    [`() => { setHud('recording'); stopWaveLoop(); }`, hudTo('transcribing', 'Loading speech model')],
  ]) {
    await evaluate("setHud('idle'); onCursor({ hover: false }); true");
    const trace = await evaluate(`morphTrace(${from}, ${to})`);
    const name = from + ' -> ' + to;
    assert.ok(trace.worst < .5, name + ' has to follow the spring; it strayed ' + trace.worst + 'px');
    assert.ok(trace.reversals <= 1 && trace.past < .025, name + ' may only pass its target by the spring\'s own overshoot: '
      + trace.reversals + ' reversals, ' + (100 * trace.past).toFixed(2) + '%');
    assert.ok(trace.micDrift < .3, name + ' must not move the microphone sideways; it moved ' + trace.micDrift + 'px');
  }

  // A real click can interrupt hover, then leave arming before its animation
  // finishes. Settled-state pairs miss both. Preserve each running
  // transition's time when retargeting, as the browser does during a fast
  // microphone start: the capsule must keep growing and the microphone stay
  // put, with nothing but the spring's own settle-back at the end.
  const interruptedStart = `(function (hoverMs, armingMs) {
    const icon = document.querySelector('.glyph-mic svg');
    const transitions = () => document.getAnimations().filter(a => a.transitionProperty);
    const advance = ms => {
      const animations = transitions();
      const bases = animations.map(a => a.currentTime || 0);
      animations.forEach((a, i) => {
        a.pause(); a.currentTime = Math.min(bases[i] + ms, a.effect.getTiming().duration + (a.effect.getTiming().delay || 0));
      });
      void pill.offsetWidth;
    };
    const sample = () => {
      const m = icon.getBoundingClientRect();
      return { x: m.x + m.width / 2, w: pill.getBoundingClientRect().width };
    };
    setHud('idle'); onCursor({ hover: false });
    void pill.offsetWidth;
    document.getAnimations().forEach(a => { try { a.finish(); } catch (_) {} });
    void pill.offsetWidth;
    const start = sample();
    onCursor({ hover: true });
    void pill.offsetWidth;
    advance(hoverMs);
    setHud('arming');
    void pill.offsetWidth;
    advance(armingMs);
    setHud('recording'); stopWaveLoop();
    void pill.offsetWidth;
    const animations = transitions();
    const bases = animations.map(a => a.currentTime || 0);
    animations.forEach(a => a.pause());
    let maxWidth = 0, shrink = 0, drift = 0;
    for (let t = 0; t <= 600; t += 5) {
      animations.forEach((a, i) => {
        a.currentTime = Math.min(bases[i] + t, a.effect.getTiming().duration + (a.effect.getTiming().delay || 0));
      });
      const now = sample();
      maxWidth = Math.max(maxWidth, now.w);
      shrink = Math.max(shrink, maxWidth - now.w);
      drift = Math.max(drift, Math.abs(now.x - start.x));
    }
    document.getAnimations().forEach(a => { try { a.finish(); } catch (_) {} });
    return { drift, shrink, travel: pill.getBoundingClientRect().width - start.w };
  })`;
  for (const hoverMs of [30, 80, 160, 300]) {
    for (const armingMs of [0, 30, 80, 160, 300]) {
      const motion = await evaluate(`${interruptedStart}(${hoverMs}, ${armingMs})`);
      assert.ok(motion.drift < .3 && motion.shrink <= .025 * motion.travel + .2,
        `click after ${hoverMs}ms hover, ${armingMs}ms startup: mic moved ${motion.drift}px, capsule shrank ${motion.shrink}px of ${motion.travel}px`);
    }
  }
  await state({ mode: 'idle' });

  // The centre still dictates after using the surrounding controls.
  sent.length = 0;
  await cursor(WIDTH / 2, barY);
  await clickControl('pill');
  assert.deepStrictEqual(sent, ['toggle'], 'clicking the bar must still start a dictation');

  assert.deepStrictEqual(errors, []);
  console.log('real overlay: Island capsule controls and drag by the bar with its click guard, Orb grip and directional controls, hover paths, hidden hit targets, reduced motion, spring morphs and interrupted microphone starts passed');
  clearTimeout(deadline);
  win.destroy();
  app.quit();
}).catch(err => { console.error(err); app.exit(1); });
