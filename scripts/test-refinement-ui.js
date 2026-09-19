'use strict';

// Exercise the real renderer and preload without opening the user's store or
// microphone. Optional screenshots are written to the ignored temp directory.
const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { applyStyleWithTone } = require('../src/style');
const { computeInsights } = require('../src/insights');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'voxden-refinement-')));
app.disableHardwareAcceleration();
const deadline = setTimeout(() => { console.error('Refinement UI timed out'); app.exit(1); }, 60000);
const now = Date.now();
let snapshot = {
  appTheme: process.argv.includes('--white') ? 'white' : 'voxden',
  displayName: 'Alex', shortcutLabel: 'Ctrl+Shift+Space',
  writingStyles: { personal: 'veryCasual', work: 'casual', email: 'formal', other: 'casual' },
  autoSend: {}, notifications: [], pendingPhrases: [],
  entries: [
    { id: 'one', ts: now, text: 'Let’s keep the next version simple. A little more space, a clearer message, and a flow that feels effortless.', durationMs: 9500, targetExe: 'slack.exe', category: 'work' },
    { id: 'two', ts: now - 3600000, text: 'Hey, I’ll be there in ten minutes. Could you grab us a table by the window?', durationMs: 7400, targetExe: 'whatsapp.exe', category: 'personal' },
    { id: 'three', ts: now - 86400000, text: 'Thank you for the thoughtful feedback. I will send the updated proposal tomorrow morning.', durationMs: 7100, targetExe: 'outlook.exe', category: 'email' },
    { id: 'old', ts: now - 20 * 86400000, text: 'A small thought from a few weeks ago.', durationMs: 4000 },
  ],
  phrases: [
    { from: 'Voxden', to: 'Voxden', kind: 'word', source: 'manual' },
    { from: 'fig ma', to: 'Figma', kind: 'replacement', source: 'learned' },
    { from: 'Anthropic', to: 'Anthropic', kind: 'word', source: 'manual' },
    { from: 'notion', to: 'Notion', kind: 'replacement', source: 'learned' },
  ],
};

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1120, height: 760, useContentSize: true,
    webPreferences: { preload: path.join(__dirname, '../src/preload.js'), contextIsolation: true, sandbox: false, backgroundThrottling: false, offscreen: true } });
  const errors = [];
  const saves = [];
  let toggles = 0;
  win.webContents.on('console-message', (event, level, message) => {
    const severity = event.level === undefined ? level : event.level;
    const text = event.message === undefined ? message : event.message;
    if ((severity === 'error' || Number(severity) >= 3) && !/Content-Security-Policy/.test(text)) errors.push(text);
  });
  ipcMain.handle('app-load', () => snapshot);
  ipcMain.handle('toggle', () => { toggles++; return { mode: 'idle' }; });
  ipcMain.handle('settings-set', (_event, patch) => {
    saves.push(patch);
    snapshot = { ...snapshot, ...patch, writingStyles: { ...snapshot.writingStyles, ...patch.writingStyles }, autoSend: { ...snapshot.autoSend, ...patch.autoSend } };
    return snapshot;
  });
  await win.loadFile(path.join(__dirname, '../src/app.html'));
  win.webContents.debugger.attach('1.3');
  await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
  const evaluate = code => win.webContents.executeJavaScript(code).catch(error => { console.error('Renderer evaluation:', code, errors); throw error; });
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click(); true`);
  const text = id => evaluate(`document.getElementById(${JSON.stringify(id)}).textContent`);
  await evaluate(`window.__testMicrophoneRequests = 0;
    navigator.mediaDevices.getUserMedia = async () => { window.__testMicrophoneRequests++; throw new Error('No test microphone'); };
    navigator.mediaDevices.enumerateDevices = async () => []; true`);
  // Allow the renderer's scheduled startup device discovery to finish before
  // attributing media requests to the bubble controls.
  await pause(1400);
  const shoot = async name => {
    if (!process.argv.includes('--screenshots')) return;
    await pause(500);
    const folder = path.join(__dirname, '../temp/ui-review');
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, name + '.png'), (await win.webContents.capturePage()).toPNG());
  };
  assert.strictEqual(await evaluate(`(() => { const ids = [...document.querySelectorAll('[id]')].map(e => e.id); return ids.length === new Set(ids).size; })()`), true, 'IDs stay unique');
  assert.ok((await text('home-shortcut-keys')).includes('Ctrl'), 'home uses the configured shortcut');
  assert.strictEqual(await evaluate(`document.querySelector('.hero-waveform')`), null, 'the old waveform is removed');
  assert.ok(await evaluate(`(() => {
    const field = document.querySelector('.hero-app-field');
    const bubbles = [...field.querySelectorAll('.hero-app-bubble')];
    const icons = bubbles.map(bubble => bubble.querySelector('img'));
    return field.getAttribute('aria-hidden') === 'true' && bubbles.length === 12
      && field.querySelectorAll('button, a, [tabindex], [aria-pressed]').length === 0
      && bubbles.every(bubble => bubble.tagName === 'SPAN' && getComputedStyle(bubble).pointerEvents !== 'none')
      && icons.every(image => image.complete && image.naturalWidth > 0
        && new URL(image.currentSrc).pathname.endsWith('.svg') && image.alt === '');
  })()`), 'twelve SVG app marks load as decorative, non-focusable artwork');
  const iconTransforms = () => evaluate(`[...document.querySelectorAll('.hero-app-slot')].map(icon => getComputedStyle(icon).transform)`);
  const bubbleSnapshot = () => evaluate(`(() => {
    const field = document.querySelector('.hero-app-field').getBoundingClientRect();
    return [...document.querySelectorAll('.hero-app-slot')].map((slot, index) => {
      const bubble = slot.querySelector('.hero-app-bubble');
      const rect = bubble.getBoundingClientRect();
      const matrix = new DOMMatrixReadOnly(getComputedStyle(slot).transform);
      const inner = new DOMMatrixReadOnly(getComputedStyle(bubble).transform);
      const scale = Math.hypot(inner.m11, inner.m12);
      return { index, x: matrix.m41, y: matrix.m42, angle: Math.atan2(matrix.m12, matrix.m11),
        cx: (rect.left + rect.right) / 2, cy: (rect.top + rect.bottom) / 2,
        top: rect.top, bottom: rect.bottom, radius: bubble.offsetWidth * scale / 2,
        scale, opacity: Number(getComputedStyle(slot).opacity),
        visible: rect.bottom > field.top && rect.top < field.bottom,
        fullyVisible: rect.top > field.top + 20 && rect.bottom < field.bottom - 20,
        fieldTop: field.top, fieldBottom: field.bottom };
    });
  })()`);
  const assertSeparated = (bubbles, context) => {
    const visible = bubbles.filter(bubble => bubble.visible && bubble.opacity > .1);
    for (let i = 0; i < visible.length; i++) for (let j = i + 1; j < visible.length; j++) {
      const a = visible[i], b = visible[j];
      const clearance = Math.hypot(a.cx - b.cx, a.cy - b.cy) - a.radius - b.radius;
      assert.ok(clearance >= -1, context + ': app bubbles ' + a.index + '/' + b.index + ' overlap by ' + (-clearance).toFixed(2) + 'px');
    }
  };
  const initialIcons = await bubbleSnapshot();
  await pause(650);
  const nextIcons = await bubbleSnapshot();
  const rises = nextIcons.map((bubble, index) => bubble.y - initialIcons[index].y).filter(delta => delta < -2);
  assert.ok(rises.length >= 3, 'the app bubbles rise noticeably while the hero is on screen');
  assert.ok(new Set(rises.map(delta => delta.toFixed(2))).size >= 2, 'bubbles rise at independent speeds');
  assert.ok(nextIcons.some((bubble, index) => Math.abs(bubble.x - initialIcons[index].x) > .1), 'bubbles also drift sideways');
  assert.ok(nextIcons.some((bubble, index) => Math.abs(bubble.angle - initialIcons[index].angle) > .001), 'bubbles rotate gently as they rise');
  assertSeparated(nextIcons, 'Initial positions');
  for (const width of [1120, 1000]) {
    win.setContentSize(width, 760);
    await pause(200);
    const continuity = await evaluate(`new Promise(resolve => {
      const field = document.querySelector('.hero-app-field');
      const slots = [...field.querySelectorAll('.hero-app-slot')];
      const widths = new Set(), errors = [];
      const clicks = [80, 230, 520, 750, 1000, 1310];
      const start = performance.now();
      let previous = null, lastTime = start, clickIndex = 0, frames = 0, rises = 0;
      function sample(now) {
        const fieldTop = field.getBoundingClientRect().top;
        const current = slots.map(slot => {
          const matrix = new DOMMatrixReadOnly(getComputedStyle(slot).transform);
          const rect = slot.getBoundingClientRect();
          return { y: matrix.m42 + slot.offsetHeight / 2, size: slot.offsetHeight,
            top: rect.top - fieldTop, bottom: rect.bottom - fieldTop,
            angle: Math.atan2(matrix.m12, matrix.m11) };
        });
        widths.add(field.clientWidth);
        if (previous) current.forEach((bubble, index) => {
          const before = previous[index], dy = bubble.y - before.y;
          const recycled = before.bottom < 0 && bubble.top > field.clientHeight;
          if (!recycled) {
            if (dy < -.01) rises++;
            if ((dy > .05 || dy < -18 * Math.min((now - lastTime) / 1000, .1) - .2
              || Math.abs(bubble.angle - before.angle) > .04) && errors.length < 4) {
              errors.push({ index, dy, angleJump: bubble.angle - before.angle, elapsed: now - start });
            }
          }
        });
        previous = current; lastTime = now; frames++;
        if (clickIndex < clicks.length && now - start >= clicks[clickIndex]) {
          document.getElementById('sidebar-toggle').click(); clickIndex++;
        }
        if (now - start < 1800) requestAnimationFrame(sample);
        else resolve({ errors, frames, rises, widths: widths.size, clicks: clickIndex });
      }
      requestAnimationFrame(sample);
    })`);
    assert.ok(continuity.frames > 30 && continuity.rises > 100 && continuity.widths > 5 && continuity.clicks === 6,
      'the test exercises repeated, interrupted sidebar transitions with live icons: ' + JSON.stringify(continuity));
    assert.deepStrictEqual(continuity.errors, [], 'sidebar changes preserve upward speed and rotation at ' + width + 'px');
    assertSeparated(await bubbleSnapshot(), 'After sidebar transitions at ' + width + 'px');
  }
  win.setContentSize(1120, 760);
  await pause(200);
  const microphoneRequestsBeforeBubbles = await evaluate(`window.__testMicrophoneRequests`);
  const target = (await bubbleSnapshot()).find(bubble => bubble.fullyVisible && bubble.opacity > .7);
  assert.ok(target, 'a visible app mark can be hovered');
  await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: target.cx, y: target.cy });
  await pause(300);
  const hoveredIcons = await bubbleSnapshot();
  assert.ok(hoveredIcons[target.index].scale > 1.02 && hoveredIcons[target.index].scale <= 1.18, 'native hover gently enlarges the app mark');
  assert.ok(hoveredIcons[target.index].y < target.y - 1, 'hover never pauses upward movement');
  assertSeparated(hoveredIcons, 'Hovered positions');
  await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, x: target.cx, y: target.cy });
  await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, x: target.cx, y: target.cy });
  await pause(300);
  const clickedIcons = await bubbleSnapshot();
  assert.ok(clickedIcons[target.index].y < hoveredIcons[target.index].y - 1, 'clicking never pins or stops a bubble');
  await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 200, y: 20 });
  await pause(250);
  assert.ok((await bubbleSnapshot())[target.index].scale <= 1.01, 'leaving returns the app mark to its usual size');
  assert.strictEqual(await evaluate(`document.getElementById('view-dictation').hidden`), false, 'bubble interactions stay on the dictation page');
  assert.strictEqual(await evaluate(`window.__testMicrophoneRequests`), microphoneRequestsBeforeBubbles, 'bubble interactions never request the microphone');
  let previousBubbles = await bubbleSnapshot();
  let independentRecycle = false;
  for (let sample = 0; sample < 50 && !independentRecycle; sample++) {
    await pause(200);
    const currentBubbles = await bubbleSnapshot();
    assertSeparated(currentBubbles, 'During continuous rise');
    const recycled = currentBubbles.filter((bubble, index) => bubble.y - previousBubbles[index].y > 100);
    if (recycled.length) {
      assert.ok(recycled.every(bubble => previousBubbles[bubble.index].bottom <= bubble.fieldTop + 2
        && bubble.top >= bubble.fieldBottom - 2), 'bubbles recycle only after disappearing above the field, returning below it');
      assert.ok(recycled.length < currentBubbles.length, 'a recycle never resets the whole group');
      independentRecycle = true;
    }
    previousBubbles = currentBubbles;
  }
  assert.ok(independentRecycle, 'at least one app bubble independently recycles during the observation window');
  assert.strictEqual(await evaluate(`document.querySelector('#dm-wpm-metric .dm-plot')`), null, 'the pace summary has no mini-chart');
  assert.ok((await text('dm-wpm-context')).includes('typing speed'), 'the live typing comparison remains visible');
  await click('#dm-wpm-metric');
  assert.strictEqual(await evaluate(`document.getElementById('view-insights').hidden`), false, 'the simplified pace card still opens Insights');
  await click('#nav-dictation');
  assert.strictEqual(toggles, 0, 'ambient artwork does not invoke recording');
  await shoot('home');
  await click('#nav-dictionary');
  await pause(100);
  const pausedIcons = await iconTransforms();
  await pause(180);
  assert.deepStrictEqual(await iconTransforms(), pausedIcons, 'leaving the page pauses icon motion');
  assert.strictEqual(await evaluate(`document.querySelector('.hero-app-field').getAnimations({ subtree: true }).some(animation => animation.playState === 'running')`), false, 'hidden hero has no running icon animations');
  assert.strictEqual(await text('dict-total-count'), '4');
  assert.strictEqual(await text('dict-learned-count'), '2');
  await shoot('dictionary');
  await click('#dict-tab-learned');
  assert.strictEqual(await evaluate(`document.querySelectorAll('.dict-row').length`), 2);
  await evaluate(`const searchField = document.getElementById('dict-search'); searchField.value = 'fig'; searchField.dispatchEvent(new Event('input')); true`);
  assert.strictEqual(await evaluate(`document.querySelectorAll('.dict-row').length`), 1, 'search combines with the learned filter');
  assert.strictEqual(await text('dict-result-count'), '1 of 4 entries');
  await click('#dict-add-new');
  assert.strictEqual(await evaluate(`document.getElementById('dict-vocab-overlay').hidden`), false, 'add-word dialog opens');
  await evaluate('closeVocabModal(); true');

  await click('#nav-writing-style');
  assert.strictEqual(await evaluate(`document.querySelectorAll('.ws-row, .ws-rows, [data-style-cat], .ws-send, [data-send-cat]').length`), 0, 'duplicate preference rows and After paste controls are removed');
  const previewTexts = [];
  for (const tone of ['formal', 'casual', 'veryCasual']) {
    await click('[data-preview-tone="' + tone + '"]');
    await pause(100);
    previewTexts.push(await text('style-preview-output'));
    assert.strictEqual(await evaluate(`document.querySelector('.style-preview').dataset.tone`), tone, 'the illustration follows the chosen tone');
    await shoot('writing-preview-' + tone);
  }
  assert.strictEqual(new Set(previewTexts.map(t => t.toLowerCase().replace(/[^a-z ]/g, ''))).size, 3, 'all three tones differ in wording');
  await click('[data-preview-tone="casual"]');
  await pause(100);
  assert.strictEqual(snapshot.writingStyles.work, 'casual', 'preview tones save the selected context immediately');
  await evaluate(`document.getElementById('style-preview-output').textContent = ('I am going to send the notes when we are done. ').repeat(11); true`);
  assert.strictEqual(await evaluate(`(() => { const p = document.getElementById('style-preview-output'); return p.scrollHeight > p.clientHeight && p.tabIndex === 0 && p.scrollWidth <= p.clientWidth + 1; })()`), true, 'long previews scroll with keyboard access without spilling out of the note');
  await click('[data-preview-tone="casual"]');
  await pause(100);
  await evaluate(`(() => { const scene = document.getElementById('writing-scene'); const r = scene.getBoundingClientRect(); scene.dispatchEvent(new PointerEvent('pointermove', { pointerType: 'mouse', clientX: r.right - 2, clientY: r.top + 2 })); })()`);
  await pause(60);
  assert.ok(await evaluate(`(() => { const x = parseFloat(document.querySelector('.style-preview').style.getPropertyValue('--look-x')); return x > 0 && x <= 5; })()`), 'paper and illustrated face follow the pointer with bounded movement');
  await evaluate(`document.getElementById('writing-scene').dispatchEvent(new PointerEvent('pointerleave')); true`);
  assert.strictEqual(await evaluate(`document.querySelector('.style-preview').style.getPropertyValue('--look-x')`), '', 'leaving returns the illustration to rest');
  await click('[data-preview-cat="email"]');
  await pause(50);
  assert.strictEqual(await evaluate(`document.querySelector('[data-preview-tone="formal"]').getAttribute('aria-pressed')`), 'true', 'email loads its saved formal tone');
  await click('[data-preview-tone="veryCasual"]');
  await pause(100);
  assert.strictEqual(snapshot.writingStyles.email, 'veryCasual', 'preview controls save to the selected context');
  assert.strictEqual(await evaluate(`document.querySelector('[data-preview-tone="veryCasual"]').getAttribute('aria-pressed')`), 'true');
  await click('[data-preview-cat="work"]');
  await pause(50);
  assert.strictEqual(await evaluate(`document.querySelector('[data-preview-tone="casual"]').getAttribute('aria-pressed')`), 'true', 'switching context loads that context’s saved tone');
  await click('[data-preview-tone="formal"]');
  await pause(100);
  assert.ok(saves.some(p => p.writingStyles && p.writingStyles.work === 'formal'), 'tone changes go through settings IPC');
  assert.strictEqual(await text('style-preview-output'), applyStyleWithTone("Hello, I am going to send the notes when we are done. Thank you.", 'formal'));
  await click('[data-preview-cat="email"]');
  await pause(50);
  assert.strictEqual(await evaluate(`document.querySelector('[data-preview-tone="veryCasual"]').getAttribute('aria-pressed')`), 'true', 'email keeps the tone saved earlier');
  await click('[data-preview-cat="work"]');
  await pause(50);
  const stylesBeforeCleanup = JSON.stringify(snapshot.writingStyles);
  assert.strictEqual(await evaluate(`document.getElementById('set-auto-cleanup').checked`), false);
  assert.strictEqual(await evaluate(`document.getElementById('auto-cleanup-example').hidden`), true);
  await click('#set-auto-cleanup');
  await pause(100);
  assert.strictEqual(snapshot.autoCleanup, true, 'cleanup saves through settings IPC');
  assert.strictEqual(JSON.stringify(snapshot.writingStyles), stylesBeforeCleanup, 'cleanup never changes the tone selections');
  assert.strictEqual(await text('auto-cleanup-preview'), 'We were going to send the notes.');
  assert.strictEqual(await evaluate(`document.getElementById('auto-cleanup-example').hidden`), false);
  await click('#set-verbatim');
  await pause(100);
  assert.strictEqual(await text('style-preview-tone'), 'Verbatim');
  assert.strictEqual(await evaluate(`document.querySelectorAll('[data-preview-tone]:not(:disabled)').length`), 0, 'verbatim disables all tone controls');
  assert.strictEqual(await text('style-preview-output'), "Hello, I am going to send the notes when we are done. Thank you.");
  assert.strictEqual(await evaluate(`document.getElementById('set-auto-cleanup').disabled`), true);
  assert.strictEqual(await evaluate(`document.getElementById('set-auto-cleanup').checked`), true, 'verbatim keeps the saved cleanup choice');
  assert.strictEqual(await evaluate(`document.getElementById('auto-cleanup-example').hidden`), true);
  await click('#set-verbatim');
  await pause(100);
  assert.strictEqual(await evaluate(`document.getElementById('set-auto-cleanup').disabled`), false);
  snapshot.dictationLanguage = 'de';
  win.webContents.send('history-updated', snapshot);
  await pause(100);
  assert.strictEqual(await evaluate(`document.getElementById('set-auto-cleanup').disabled`), true);
  assert.ok((await text('auto-cleanup-status')).includes('English'));
  assert.strictEqual(await text('style-preview-tone'), 'Styles paused');
  assert.strictEqual(await evaluate(`document.querySelectorAll('[data-preview-tone]:not(:disabled)').length`), 0);
  snapshot.dictationLanguage = 'en';
  win.webContents.send('history-updated', snapshot);
  await pause(100);
  assert.strictEqual(await evaluate(`document.getElementById('set-auto-cleanup').disabled`), false);
  await evaluate(`const toneButton = document.querySelector('[data-preview-tone="formal"]'); toneButton.focus(); toneButton.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); true`);
  await pause(100);
  assert.strictEqual(snapshot.writingStyles.work, 'casual', 'arrow keys select and save a tone');
  assert.strictEqual(await text('auto-cleanup-preview'), 'We were going to send the notes.');
  await shoot('writing-style-preferences');
  await evaluate(`document.querySelector('#view-writing-style .pane-body').scrollTop = 0; true`);
  await shoot('writing-style');

  await click('#nav-insights');
  await pause(600);
  await shoot('insights');
  await click('[data-range="7d"]');
  const expected = computeInsights(snapshot.entries, snapshot.phrases, '7d');
  assert.strictEqual(await text('ins-summary-words'), expected.volume.words.toLocaleString(), 'summary follows the selected range');
  assert.strictEqual(await text('ins-summary-sessions'), '3');
  await click('[data-tab="voice"]');
  assert.strictEqual(await evaluate(`document.getElementById('ins-tab-usage').hidden`), true);
  await shoot('voice-insights');

  for (const [width, height] of [[1120, 760], [800, 650], [640, 440]]) {
    win.setContentSize(width, height);
    await pause(120);
    for (const page of ['dictation', 'dictionary', 'writing-style', 'insights', 'help']) {
      await click('#nav-' + page);
      await pause(250);
      await evaluate(`document.querySelector('#view-${page} .pane-body').scrollTop = 0; true`);
      const overflow = await evaluate(`(() => { const el = document.querySelector('#view-${page} .pane-body'); return el.scrollWidth - el.clientWidth; })()`);
      assert.ok(overflow <= 1, page + ' must fit at ' + width + 'px, overflow=' + overflow);
      if (width === 1120) await shoot(page + '-theme');
      if (page === 'dictation') {
        assert.strictEqual(await evaluate(`document.querySelector('.voice-stage').getBoundingClientRect().bottom <= document.querySelector('.hero-left').getBoundingClientRect().top`), true, 'home stage and library never overlap at ' + width + 'px');
        assert.ok(await evaluate(`(() => {
          const hero = document.getElementById('voice-stage').getBoundingClientRect();
          const copy = document.querySelector('.voice-stage-copy').getBoundingClientRect();
          return copy.left >= hero.left && copy.right <= hero.right && copy.bottom <= hero.bottom;
        })()`), 'hero content stays inside its surface at ' + width + 'px');
        assert.ok(await evaluate(`(() => {
          const hero = document.getElementById('voice-stage');
          return hero.scrollWidth <= hero.clientWidth + 1 && getComputedStyle(hero).overflow === 'hidden';
        })()`), 'floating artwork is clipped without widening the hero at ' + width + 'px');
        assert.ok(await evaluate(`(() => {
          const copy = [...document.querySelector('.voice-stage-copy').children].map(element => element.getBoundingClientRect());
          const field = document.querySelector('.hero-app-field').getBoundingClientRect();
          return [...document.querySelectorAll('.hero-app-bubble')].every(icon => {
            const box = icon.getBoundingClientRect();
            const mark = { left: Math.max(box.left, field.left), right: Math.min(box.right, field.right),
              top: Math.max(box.top, field.top), bottom: Math.min(box.bottom, field.bottom) };
            if (mark.right <= mark.left || mark.bottom <= mark.top) return true;
            return copy.every(text => mark.right <= text.left || mark.left >= text.right
              || mark.bottom <= text.top || mark.top >= text.bottom);
          });
        })()`), 'app marks stay clear of the headline, body, and shortcut at ' + width + 'px');
        assertSeparated(await bubbleSnapshot(), 'Layout at ' + width + 'px');
      }
      if (width === 640) await shoot(page + '-compact');
      if (width === 640 && page === 'writing-style') {
        await evaluate(`document.getElementById('writing-scene').scrollIntoView({ block: 'center' }); true`);
        await shoot('writing-preview-compact-note');
      }
    }
  }
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await click('#nav-writing-style');
  await click('[data-preview-tone="formal"]');
  await pause(100);
  await evaluate(`document.getElementById('writing-scene').dispatchEvent(new PointerEvent('pointermove', { pointerType: 'mouse', clientX: 999, clientY: 999 })); true`);
  await pause(40);
  assert.strictEqual(await evaluate(`document.querySelector('.style-preview').style.getPropertyValue('--look-x')`), '', 'reduced motion disables pointer movement');
  assert.strictEqual(await evaluate(`document.querySelector('.style-preview').getAnimations({ subtree: true }).some(a => a.playState === 'running')`), false, 'reduced motion keeps the whole preview still');
  await click('#nav-dictation');
  await pause(80);
  const stillIcons = await iconTransforms();
  await pause(180);
  assert.deepStrictEqual(await iconTransforms(), stillIcons, 'reduced motion keeps all app marks still');
  assert.strictEqual(await evaluate(`document.querySelector('.hero-app-field').getAnimations({ subtree: true }).some(animation => animation.playState === 'running')`), false, 'reduced motion stops all ambient icon animations');
  assertSeparated(await bubbleSnapshot(), 'Reduced-motion layout');
  assert.deepStrictEqual(errors, [], 'renderer stays free of errors');

  const overlay = new BrowserWindow({ show: false, width: 260, height: 96, frame: false, transparent: true, useContentSize: true,
    webPreferences: { preload: path.join(__dirname, '../src/preload.js'), contextIsolation: true, sandbox: false, backgroundThrottling: false, offscreen: true } });
  await overlay.loadFile(path.join(__dirname, '../src/overlay.html'));
  const overlayEval = code => overlay.webContents.executeJavaScript(code);
  await overlayEval(`alwaysShowFlowBar = true; document.body.classList.add('shown'); setHud('idle'); true`);
  for (const state of ['idle', 'recording', 'transcribing', 'success', 'error']) {
    await overlayEval(`setHud(${JSON.stringify(state)}, ${JSON.stringify(state === 'success' ? 'Words, beautifully written.' : state === 'error' ? 'Please try again' : '')}); true`);
    // Island's capsule settles on a 540ms spring.
    await pause(650);
    if (process.argv.includes('--screenshots')) {
      fs.writeFileSync(path.join(__dirname, '../temp/ui-review/flow-' + state + '.png'), (await overlay.webContents.capturePage()).toPNG());
    }
  }
  // Island's transcribing indicator is its spinner. Sample every painted spoke
  // at each of the eight steps it turns through, not the box that turns: the
  // spokes, the note and the capsule must never clip or push one another.
  // Keep a 260x96 CSS-pixel overlay at each scale, as Windows DPI scaling does.
  for (const scale of [1, 1.25, 1.5]) {
    overlay.setContentSize(Math.round(260 * scale), Math.round(96 * scale));
    overlay.webContents.setZoomFactor(scale);
    for (const note of ['', 'Loading speech model', 'Preparing a very long speech model name and loading its transcription engine']) {
      await overlayEval(`label.textContent = ''; setHud('transcribing', ${JSON.stringify(note)}); true`);
      await pause(650);
      const check = await overlayEval(`(() => {
        const capsule = pill.getBoundingClientRect();
        const slot = document.getElementById('spinner').getBoundingClientRect();
        const line = label.getBoundingClientRect();
        const turn = document.querySelector('.spinner-turn');
        // Use a temporary CSS transform. Taking control with Animation.play()
        // detaches a CSS animation from its stylesheet lifecycle, which would
        // leave a test-owned animation running after reduced motion is enabled.
        turn.style.animation = 'none';
        let fits = slot.left >= capsule.left + 1 && slot.right <= capsule.right - 1
          && slot.top >= capsule.top + 1 && slot.bottom <= capsule.bottom - 1
          && capsule.left >= 0 && capsule.right <= innerWidth
          && (!${JSON.stringify(note)} || (line.left >= slot.right + 7.5 && line.right <= capsule.right - 1));
        let stable = true;
        for (let step = 0; step < 8; step++) {
          turn.style.transform = 'rotate(' + step * 45 + 'deg)';
          for (const spoke of turn.querySelectorAll('i')) {
            const r = spoke.getBoundingClientRect();
            fits = fits && r.left >= slot.left - .05 && r.right <= slot.right + .05
              && r.top >= slot.top - .05 && r.bottom <= slot.bottom + .05;
          }
          stable = stable && Math.abs(pill.getBoundingClientRect().width - capsule.width) < .1;
        }
        turn.style.removeProperty('animation');
        turn.style.removeProperty('transform');
        return { fits, stable, spinnerVisible: getComputedStyle(document.getElementById('spinner')).opacity === '1',
          micHidden: getComputedStyle(document.querySelector('.glyph-mic')).opacity === '0' };
      })()`);
      assert.deepStrictEqual(check, { fits: true, stable: true, spinnerVisible: true, micHidden: true }, 'the spinner stays unclipped and stable at scale ' + scale + ', note length ' + note.length);
    }
  }
  overlay.setContentSize(260, 96);
  overlay.webContents.setZoomFactor(1);
  await overlayEval(`setHud('idle'); true`);
  await pause(300);
  await pause(400);
  assert.strictEqual(await overlayEval(`document.getAnimations().filter(a => a instanceof CSSAnimation).length`), 0, 'Island has no idle animation');
  overlay.webContents.debugger.attach('1.3');
  await overlay.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  // CDP resolves before Chromium delivers the MediaQueryList change event to
  // the shared motion controller. Assert the settled preference, not that race.
  for (let i = 0; i < 50 && !await overlayEval('window.VoxdenFlowMotion.matches'); i++) await pause(20);
  assert.strictEqual(await overlayEval('window.VoxdenFlowMotion.matches'), true);
  await overlayEval(`setHud('idle'); true`);
  assert.strictEqual(await overlayEval(`document.body.classList.contains('flow-face')`), false, 'reduced motion preserves a quiet idle bar');
  await overlayEval(`setHud('transcribing'); true`);
  await pause(150);
  assert.strictEqual(await overlayEval(`getComputedStyle(document.getElementById('spinner')).opacity`), '1', 'reduced motion keeps the spinner visible');
  const reducedSpin = await overlayEval(`(() => { const turn = document.querySelector('.spinner-turn'); return {
    reduced: matchMedia('(prefers-reduced-motion: reduce)').matches,
    css: getComputedStyle(turn).animationName,
    animations: turn.getAnimations().map(a => ({ name: a.animationName, state: a.playState, time: a.currentTime, duration: a.effect.getTiming().duration }))
  }; })()`);
  assert.strictEqual(reducedSpin.animations.some(a => a.state === 'running'), false, 'reduced motion stops the spinner: ' + JSON.stringify(reducedSpin));
  overlay.destroy();
  clearTimeout(deadline);
  console.log('Refinement UI: independent app drift and recycling, continuous motion on hover/click, gentle hover enlargement, collision clearance, dictionary, style preview, settings, insights, compact layouts, flow states and reduced motion passed.');
  win.destroy();
  app.quit();
}).catch(error => { console.error(error); clearTimeout(deadline); app.exit(1); });
