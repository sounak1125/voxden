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
const { countWords } = require('../src/metrics');
const { fitViewport } = require('./fit-viewport');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'voxden-refinement-')));
app.disableHardwareAcceleration();
const deadline = setTimeout(() => { console.error('Refinement UI timed out'); app.exit(1); }, 90000);
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
  // The Writing style preview is worked out in main (the preload is sandboxed).
  ipcMain.handle('style-preview', (_event, text, tone, clean) => {
    const sample = String(text || '');
    return require('../src/style').applyStyleWithTone(clean === true ? require('../src/auto-cleanup').autoCleanup(sample) : sample, String(tone || ''));
  });
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
    await fitViewport(win, width, 760);
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
  await fitViewport(win, 1120, 760);
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

  // --- Home: greeting icon, typed headline, voice ring, round search --------
  // The hero's loops restart from an IntersectionObserver callback, a frame
  // or two after the page comes back.
  await pause(200);
  const home = await evaluate(`(() => {
    const icon = document.getElementById('greeting-icon'), stage = document.getElementById('voice-stage');
    const ring = document.getElementById('vu-ring-progress'), card = document.getElementById('voice-understanding');
    const line = document.querySelector('#view-dictation .hero-greeting');
    const salute = document.getElementById('greeting-salute'), name = document.getElementById('greeting-name');
    const cs = getComputedStyle(line);
    return { part: icon.dataset.dayPart, iconSize: icon.querySelector('svg').getBoundingClientRect().width,
      beforeSalute: icon.nextElementSibling === salute,
      greeting: { tag: line.tagName, font: cs.fontSize, line: cs.lineHeight, track: cs.letterSpacing, wrap: cs.whiteSpace,
        lines: Math.round(line.getBoundingClientRect().height / parseFloat(cs.lineHeight)),
        salute: salute.textContent, saluteWeight: getComputedStyle(salute).fontWeight,
        nameWeight: getComputedStyle(name).fontWeight,
        // The icon, the words and the name share one line box.
        sameRow: [icon, salute, name].every(el => Math.abs(el.getBoundingClientRect().top
          + el.getBoundingClientRect().height / 2 - (line.getBoundingClientRect().top + line.getBoundingClientRect().height / 2)) < 6) },
      typing: stage.classList.contains('is-typing'), label: stage.querySelector('h2').getAttribute('aria-label'),
      caret: stage.querySelector('.hero-caret').getAnimations().some(a => a.playState === 'running'),
      ringBox: ring.ownerSVGElement.getBoundingClientRect().width, stroke: getComputedStyle(ring).strokeWidth,
      removed: ['.vu-bar', '.vu-copy', '.vu-title-icon', '.vu-glow'].filter(selector => card.querySelector(selector)),
      chip: getComputedStyle(document.getElementById('vu-profile')).backgroundColor,
      link: card.querySelector('.vu-affordance').textContent.trim() };
  })()`);
  assert.ok(['dawn', 'morning', 'afternoon', 'evening', 'night'].includes(home.part) && home.iconSize === 16 && home.beforeSalute,
    'a 16px time-of-day icon leads the greeting: ' + JSON.stringify(home));
  assert.deepStrictEqual([home.greeting.tag, home.greeting.font, home.greeting.line, home.greeting.track,
    home.greeting.wrap, home.greeting.lines, home.greeting.sameRow],
    ['H1', '18px', '23px', '-0.4px', 'nowrap', 1, true],
    'icon, greeting and name are one 18px line that never wraps: ' + JSON.stringify(home.greeting));
  assert.deepStrictEqual([home.greeting.salute, home.greeting.saluteWeight, home.greeting.nameWeight],
    [home.greeting.salute.replace(/,?$/, ','), '400', '600'],
    'the greeting keeps its comma, the name carries the weight: ' + JSON.stringify(home.greeting));
  assert.strictEqual(await evaluate(`document.querySelectorAll('#view-dictation .stats, #view-dictation .stat').length`), 0,
    'the old three-cell totals row is gone');
  // A long name gives way with an ellipsis rather than wrapping or widening.
  snapshot = { ...snapshot, displayName: 'Bartholomew Maximilian Featherstonehaugh III' };
  win.webContents.send('history-updated', snapshot);
  await pause(120);
  assert.ok(await evaluate(`(() => {
    const line = document.querySelector('#view-dictation .hero-greeting'), name = document.getElementById('greeting-name');
    const body = document.querySelector('#view-dictation .pane-body');
    return Math.round(line.getBoundingClientRect().height / parseFloat(getComputedStyle(line).lineHeight)) === 1
      && getComputedStyle(name).textOverflow === 'ellipsis'
      && name.getBoundingClientRect().right <= line.getBoundingClientRect().right + 1
      && body.scrollWidth - body.clientWidth <= 1;
  })()`), 'a long name ellipsizes on the one greeting line');
  snapshot = { ...snapshot, displayName: 'Alex' };
  win.webContents.send('history-updated', snapshot);
  await pause(120);

  // --- The week up front ----------------------------------------------------
  const week = await evaluate(`(() => {
    const bars = document.getElementById('week-bars');
    const cells = [...bars.querySelectorAll('.week-day')];
    return { role: bars.getAttribute('role'), label: bars.getAttribute('aria-label'),
      days: cells.length, letters: cells.map(cell => cell.querySelector('.week-dow').textContent),
      heights: cells.map(cell => Math.round(parseFloat(getComputedStyle(cell.querySelector('.week-bar')).height))),
      empty: cells.map(cell => cell.classList.contains('is-empty')),
      colors: cells.map(cell => getComputedStyle(cell.querySelector('.week-bar')).backgroundColor),
      number: document.getElementById('statWeek').textContent,
      allTime: document.getElementById('statWords').textContent,
      dictations: document.getElementById('statNotes').textContent };
  })()`);
  const weekDays = [0, 0, 0, 0, 0, 0, 0];
  let weekTotal = 0;
  let allTimeWords = 0;
  for (const entry of snapshot.entries) {
    const words = countWords(entry.text);
    allTimeWords += words;
    if (entry.ts < now - 7 * 86400000) continue;
    weekTotal += words;
    weekDays[(new Date(entry.ts).getDay() + 6) % 7] += words;
  }
  assert.deepStrictEqual([week.role, week.days, week.number, week.allTime, week.dictations],
    ['img', 7, await evaluate('(' + weekTotal + ').toLocaleString()'), await evaluate('(' + allTimeWords + ').toLocaleString()'),
      String(snapshot.entries.length)], 'the week card counts the real history: ' + JSON.stringify(week));
  assert.ok(week.label.startsWith('Words per day this week:') && weekDays.every((words, i) => week.label.includes(' ' + words)),
    'the bar group is labelled with every day figure: ' + week.label);
  assert.deepStrictEqual(week.empty, weekDays.map(words => words === 0), 'empty days are marked as such');
  const busiest = Math.max(...weekDays);
  assert.deepStrictEqual(week.heights, weekDays.map(words => words > 0 ? Math.max(4, Math.round(34 * words / busiest)) : 3),
    'bars scale to the busiest day, empty days keep a 3px stub: ' + JSON.stringify(week));
  assert.strictEqual(new Set(week.colors.filter((_c, i) => weekDays[i] === 0)).size, 1, 'every empty day draws the same pale stub');
  assert.ok(week.colors.some((color, i) => weekDays[i] > 0 && color !== week.colors[weekDays.indexOf(0)]),
    'days with words are drawn in the accent, not the stub colour');
  assert.deepStrictEqual([home.typing, home.caret, home.label], [true, true, 'Your thoughts, in writing.'],
    'the headline types its ending behind one stable accessible name');
  assert.deepStrictEqual([home.ringBox, home.stroke, home.removed, home.chip, home.link], [96, '8px', [], 'rgba(0, 0, 0, 0)', 'Your voice'],
    'the voice profile is a 96px ring beside a plain stage name: ' + JSON.stringify(home));
  const searchState = () => evaluate(`(() => {
    const root = document.getElementById('dictation-search'), field = document.getElementById('search-field');
    return { open: root.classList.contains('is-open'), toggle: !document.getElementById('search-toggle').hidden,
      field: !field.hidden, width: Math.round(field.getBoundingClientRect().width), value: document.getElementById('search').value,
      count: document.getElementById('search-count').textContent, cards: document.querySelectorAll('#groups .card').length,
      focus: document.activeElement && document.activeElement.id };
  })()`);
  const restSearch = await searchState();
  assert.deepStrictEqual([restSearch.open, restSearch.toggle, restSearch.field, restSearch.cards], [false, true, false, 4], 'search rests as a round button: ' + JSON.stringify(restSearch));
  assert.deepStrictEqual(await evaluate(`(() => { const r = document.getElementById('search-toggle').getBoundingClientRect(); return [r.width, r.height, getComputedStyle(document.getElementById('search-toggle')).borderRadius]; })()`),
    [34, 34, '17px'], 'the resting search is a 34px circle');
  await click('#search-toggle');
  await pause(260);
  await evaluate(`(() => { const input = document.getElementById('search'); input.value = 'table'; input.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await pause(200);
  const openSearch = await searchState();
  assert.deepStrictEqual([openSearch.open, openSearch.toggle, openSearch.field, openSearch.width, openSearch.count, openSearch.cards, openSearch.focus],
    [true, false, true, 240, '1 of 4', 1, 'search'], 'the opened search is a 240px field with the query and a result count: ' + JSON.stringify(openSearch));
  await evaluate(`document.getElementById('search').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); true`);
  await pause(60);
  const closedSearch = await searchState();
  assert.deepStrictEqual([closedSearch.open, closedSearch.toggle, closedSearch.value, closedSearch.count, closedSearch.cards, closedSearch.focus],
    [false, true, '', '', 4, 'search-toggle'], 'Escape collapses the search and clears the filter: ' + JSON.stringify(closedSearch));
  await click('#search-toggle');
  await evaluate(`(() => { const input = document.getElementById('search'); input.value = 'proposal'; input.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await pause(200);
  await click('#search-close');
  assert.deepStrictEqual([(await searchState()).open, (await searchState()).cards], [false, 4], 'the close button does the same');
  const pressCtrlF = () => evaluate(`(() => { const event = new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true, cancelable: true }); document.dispatchEvent(event); return event.defaultPrevented; })()`);
  assert.strictEqual(await pressCtrlF(), true, 'Ctrl+F is taken over on the Dictation page');
  assert.deepStrictEqual([(await searchState()).open, (await searchState()).focus], [true, 'search'], 'Ctrl+F opens the Dictation search and focuses it');
  await click('#search-close');
  await click('#nav-dictionary');
  await pause(100);
  const pausedIcons = await iconTransforms();
  await pause(180);
  assert.deepStrictEqual(await iconTransforms(), pausedIcons, 'leaving the page pauses icon motion');
  assert.strictEqual(await evaluate(`document.getElementById('voice-stage').classList.contains('is-typing')`), false, 'leaving the page stops the typed headline');
  assert.strictEqual(await evaluate(`document.querySelector('.hero-app-field').getAnimations({ subtree: true }).some(animation => animation.playState === 'running')`), false, 'hidden hero has no running icon animations');
  assert.strictEqual(await text('dict-total-count'), '4');
  assert.strictEqual(await text('dict-learned-count'), '2');
  // The overview shows one of the user's own learned corrections happening.
  const fixState = () => evaluate(`(() => {
    const strip = document.getElementById('vocab-fix'), to = document.getElementById('vocab-fix-to');
    return { from: document.getElementById('vocab-fix-from').textContent, to: to.textContent, fixed: strip.classList.contains('is-fixed'),
      running: strip.classList.contains('is-running'), example: strip.classList.contains('is-example'), timer: !!vocabFix.timer,
      label: strip.getAttribute('aria-label'), font: getComputedStyle(strip).fontFamily.split(',')[0],
      heading: document.querySelector('.vocab-overview h2').textContent, line: document.getElementById('vocab-overview-line').textContent,
      monogram: document.querySelectorAll('.vocab-monogram').length, counts: document.querySelectorAll('.vocab-overview .vocab-count').length };
  })()`);
  const waitForFix = async (test, label) => {
    for (let i = 0; i < 120; i++) { const state = await fixState(); if (test(state)) return state; await pause(50); }
    assert.fail(label + ': ' + JSON.stringify(await fixState()));
  };
  const heard = await waitForFix(state => state.running && !state.fixed, 'the strip starts on the heard form');
  assert.deepStrictEqual([heard.heading, heard.line, heard.monogram, heard.counts, heard.font, heard.example],
    ['Always spelled your way.', 'Fix a word once. Voxden remembers.', 0, 2, 'Georgia', false], 'overview copy, serif strip and both counts: ' + JSON.stringify(heard));
  const learnedPairs = snapshot.phrases.filter(p => p.source === 'learned').map(p => p.from + '>' + p.to);
  assert.ok(learnedPairs.includes(heard.from + '>' + heard.to), 'the strip shows a real learned correction: ' + JSON.stringify(heard));
  const fixed = await waitForFix(state => state.fixed, 'the heard form is struck out and the corrected form slides in');
  assert.deepStrictEqual([fixed.from, fixed.to, fixed.label], [heard.from, heard.to, heard.from + ' becomes ' + heard.to]);
  const following = await waitForFix(state => state.from !== heard.from, 'the strip moves on to the next correction');
  assert.ok(learnedPairs.includes(following.from + '>' + following.to) && following.from !== heard.from, 'the next correction is the user’s too');
  await shoot('dictionary');
  // Nothing learned yet: one static example and a line that says how to get one.
  const learnedPhrases = snapshot.phrases;
  snapshot = { ...snapshot, phrases: learnedPhrases.filter(p => p.source !== 'learned') };
  win.webContents.send('history-updated', snapshot);
  await pause(150);
  const example = await fixState();
  assert.deepStrictEqual([example.from, example.to, example.fixed, example.running, example.timer, example.example, example.line],
    ['vox den', 'Voxden', true, false, false, true, 'Correct a word in any dictation and it will appear here.'], 'no corrections: a static example: ' + JSON.stringify(example));
  await pause(1500);
  assert.deepStrictEqual([(await fixState()).from, (await fixState()).fixed], ['vox den', true], 'the example does not animate');
  snapshot = { ...snapshot, phrases: learnedPhrases };
  win.webContents.send('history-updated', snapshot);
  await pause(150);
  assert.strictEqual((await fixState()).timer, true, 'learned corrections start the strip again');
  // Hidden window and reduced motion stop the loop on the settled first correction.
  await evaluate(`Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); true`);
  const hiddenFix = await fixState();
  assert.deepStrictEqual([hiddenFix.timer, hiddenFix.running, hiddenFix.fixed, hiddenFix.from], [false, false, true, 'fig ma'], 'a hidden window stops the strip: ' + JSON.stringify(hiddenFix));
  await evaluate(`delete document.hidden; document.dispatchEvent(new Event('visibilitychange')); true`);
  assert.strictEqual((await fixState()).timer, true, 'showing the window resumes it');
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await pause(100);
  const reducedFix = await fixState();
  assert.deepStrictEqual([reducedFix.timer, reducedFix.running, reducedFix.fixed, reducedFix.from, reducedFix.to], [false, false, true, 'fig ma', 'Figma'], 'reduced motion shows the settled correction: ' + JSON.stringify(reducedFix));
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [] });
  await pause(100);
  assert.strictEqual((await fixState()).timer, true, 'full motion resumes it');

  // The Dictionary search is the same round component as the Dictation one.
  const dictSearchState = () => evaluate(`(() => {
    const root = document.getElementById('dictionary-search'), field = document.getElementById('dict-search-field'), toggle = document.getElementById('dict-search-toggle');
    const box = toggle.getBoundingClientRect(), tabs = document.querySelector('.dict-tabs').getBoundingClientRect();
    return { open: root.classList.contains('is-open'), toggle: !toggle.hidden, field: !field.hidden, width: Math.round(field.getBoundingClientRect().width),
      circle: toggle.hidden ? null : [box.width, box.height, getComputedStyle(toggle).borderRadius], besideTabs: toggle.hidden || (box.left > tabs.right && box.top < tabs.bottom && box.bottom > tabs.top),
      value: document.getElementById('dict-search').value, count: document.getElementById('dict-search-count').textContent,
      rows: document.querySelectorAll('.dict-row').length, focus: document.activeElement && document.activeElement.id, oldBox: document.querySelectorAll('.dict-toolbar input.search').length };
  })()`);
  const restDictSearch = await dictSearchState();
  assert.deepStrictEqual([restDictSearch.open, restDictSearch.toggle, restDictSearch.field, restDictSearch.circle, restDictSearch.besideTabs, restDictSearch.oldBox],
    [false, true, false, [34, 34, '17px'], true, 0], 'dictionary search rests as a 34px circle beside the filter: ' + JSON.stringify(restDictSearch));
  await click('#dict-tab-learned');
  assert.strictEqual(await evaluate(`document.querySelectorAll('.dict-row').length`), 2);
  assert.strictEqual(await pressCtrlF(), true, 'Ctrl+F is taken over on the Dictionary page');
  await pause(260);
  await evaluate(`(() => { const field = document.getElementById('dict-search'); field.value = 'fig'; field.dispatchEvent(new Event('input')); return true; })()`);
  const openDictSearch = await dictSearchState();
  assert.deepStrictEqual([openDictSearch.open, openDictSearch.toggle, openDictSearch.field, openDictSearch.width, openDictSearch.count, openDictSearch.rows, openDictSearch.focus],
    [true, false, true, 240, '1 of 4', 1, 'dict-search'], 'Ctrl+F opens a 240px field; search combines with the learned filter: ' + JSON.stringify(openDictSearch));
  assert.strictEqual(await text('dict-result-count'), '1 of 4 entries');
  assert.strictEqual((await searchState()).open, false, 'Ctrl+F on Dictionary leaves the Dictation search alone');
  await shoot('dictionary-search');
  await evaluate(`document.getElementById('dict-search').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); true`);
  await pause(60);
  const closedDictSearch = await dictSearchState();
  assert.deepStrictEqual([closedDictSearch.open, closedDictSearch.toggle, closedDictSearch.value, closedDictSearch.count, closedDictSearch.rows, closedDictSearch.focus],
    [false, true, '', '', 2, 'dict-search-toggle'], 'Escape collapses it and clears the query, keeping the Learned filter: ' + JSON.stringify(closedDictSearch));
  await click('#dict-search-toggle');
  await evaluate(`(() => { const field = document.getElementById('dict-search'); field.value = 'notion'; field.dispatchEvent(new Event('input')); return true; })()`);
  await click('#dict-search-close');
  assert.deepStrictEqual([(await dictSearchState()).open, (await dictSearchState()).rows], [false, 2], 'the close button does the same');
  await click('#dict-add-new');
  assert.strictEqual(await evaluate(`document.getElementById('dict-vocab-overlay').hidden`), false, 'add-word dialog opens');
  assert.strictEqual(await pressCtrlF(), false, 'Ctrl+F stays out of the way while a dialog covers the page');
  assert.strictEqual((await dictSearchState()).open, false);
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
  assert.strictEqual(new Set(previewTexts).size, 3, 'each tone looks different');
  assert.strictEqual(new Set(previewTexts.map(t => t.toLowerCase().replace(/[^a-z ]/g, ''))).size, 1, 'every tone keeps the same words');
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
  assert.strictEqual(await text('style-preview-output'), applyStyleWithTone("um, so I am sending the notes tonight, you know, once we are done. thanks for waiting", 'formal'));
  await click('[data-preview-cat="email"]');
  await pause(50);
  assert.strictEqual(await evaluate(`document.querySelector('[data-preview-tone="veryCasual"]').getAttribute('aria-pressed')`), 'true', 'email keeps the tone saved earlier');
  await click('[data-preview-cat="work"]');
  await pause(50);
  const stylesBeforeCleanup = JSON.stringify(snapshot.writingStyles);
  const prefs = await evaluate(`(() => {
    const list = document.getElementById('writing-prefs'), rows = [...list.querySelectorAll('.prefs-row')];
    return { cards: document.querySelectorAll('#view-writing-style .verbatim-card').length, example: document.querySelectorAll('#auto-cleanup-example, #auto-cleanup-preview').length,
      labels: rows.map(row => row.querySelector('.setting-label').textContent), hints: rows.map(row => row.querySelector('.setting-hint').textContent),
      toggles: rows.map(row => row.querySelector('.toggle input').id), dividers: rows.map(row => parseFloat(getComputedStyle(row).borderTopWidth) > 0),
      toggleRight: rows.every(row => row.querySelector('.toggle').getBoundingClientRect().left > row.querySelector('.setting-copy').getBoundingClientRect().right - 1),
      oneSurface: rows.every(row => getComputedStyle(row).backgroundColor === 'rgba(0, 0, 0, 0)') && parseFloat(getComputedStyle(list).borderTopWidth) > 0,
      subHidden: document.getElementById('verbatim-dict-row').hidden };
  })()`);
  assert.deepStrictEqual([prefs.cards, prefs.example, prefs.labels, prefs.toggles], [0, 0, ['Verbatim mode', 'Auto cleanup', 'Write numbers as digits'], ['set-verbatim', 'set-auto-cleanup', 'set-numbers-digits']],
    'preferences are one list of three rows with their original toggles: ' + JSON.stringify(prefs));
  assert.deepStrictEqual(prefs.hints, ['Your exact words. No cleanup, commands or tone.', 'Fixes grammar and punctuation, keeps your wording.', 'twenty five becomes 25.']);
  assert.deepStrictEqual([prefs.dividers, prefs.toggleRight, prefs.oneSurface, prefs.subHidden], [[false, true, true], true, true, true], 'hairlines between rows, toggles at the right, one card: ' + JSON.stringify(prefs));
  assert.strictEqual(await evaluate(`document.getElementById('set-auto-cleanup').checked`), false);
  await click('#set-auto-cleanup');
  await pause(100);
  assert.strictEqual(snapshot.autoCleanup, true, 'cleanup saves through settings IPC');
  assert.strictEqual(JSON.stringify(snapshot.writingStyles), stylesBeforeCleanup, 'cleanup never changes the tone selections');
  await click('#set-numbers-digits');
  await pause(100);
  assert.strictEqual(snapshot.numbersAsDigits, false, 'the digits toggle still saves through settings IPC');
  await click('#set-numbers-digits');
  await pause(100);
  assert.strictEqual(snapshot.numbersAsDigits, true);
  await click('#set-verbatim');
  await pause(100);
  assert.strictEqual(snapshot.verbatimMode, true, 'verbatim saves through settings IPC');
  assert.strictEqual(await evaluate(`document.getElementById('verbatim-dict-row').hidden`), false, 'verbatim reveals its dictionary option inside the list');
  assert.strictEqual(await text('auto-cleanup-status'), 'Paused while Verbatim mode is on.');
  assert.strictEqual(await evaluate(`document.getElementById('auto-cleanup-card').classList.contains('is-unavailable')`), true);
  assert.strictEqual(await text('style-preview-tone'), 'Verbatim');
  assert.strictEqual(await evaluate(`document.querySelectorAll('[data-preview-tone]:not(:disabled)').length`), 0, 'verbatim disables all tone controls');
  assert.strictEqual(await text('style-preview-output'), "um, so I am sending the notes tonight, you know, once we are done. thanks for waiting");
  assert.strictEqual(await evaluate(`document.getElementById('set-auto-cleanup').disabled`), true);
  assert.strictEqual(await evaluate(`document.getElementById('set-auto-cleanup').checked`), true, 'verbatim keeps the saved cleanup choice');
  await click('#set-verbatim');
  await pause(100);
  assert.strictEqual(await evaluate(`document.getElementById('set-auto-cleanup').disabled`), false);
  assert.strictEqual(await evaluate(`document.getElementById('verbatim-dict-row').hidden`), true);
  assert.strictEqual(await text('auto-cleanup-status'), '');
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
  await shoot('writing-style-preferences');
  await evaluate(`document.querySelector('#view-writing-style .pane-body').scrollTop = 0; true`);
  await shoot('writing-style');

  await click('#nav-insights');
  await pause(600);
  await shoot('insights');
  const milestones = computeInsights(snapshot.entries, snapshot.phrases, 'all').milestones;
  const shelfState = () => evaluate(`(() => {
    const books = [...document.querySelectorAll('#ins-shelf-books > *')];
    return { tags: books.map(book => book.tagName + ':' + book.type), states: books.map(book => ['reached', 'next', 'locked'].find(state => book.classList.contains('is-' + state))),
      picked: books.map(book => book.classList.contains('is-picked')).indexOf(true), pressed: books.map(book => book.getAttribute('aria-pressed')).indexOf('true'),
      labels: books.map(book => book.getAttribute('aria-label')), transforms: books.map(book => getComputedStyle(book).transform),
      borders: books.map(book => getComputedStyle(book).borderTopStyle), caption: document.getElementById('ins-shelf-caption').textContent,
      mascots: document.querySelectorAll('#ins-milestones-card .notif-mascot, #ins-milestones-card .ins-ms-mascot').length,
      strip: document.querySelectorAll('#ins-ms-strip .ins-ms-step').length, focus: books.indexOf(document.activeElement) };
  })()`);
  const shelf = await shelfState();
  const nextIndex = milestones.milestones.findIndex(m => m.state === 'next');
  assert.ok(nextIndex >= 0 && milestones.next, 'the fixture has a next milestone');
  assert.deepStrictEqual([shelf.tags.length, new Set(shelf.tags).size, shelf.tags[0], shelf.mascots, shelf.strip], [8, 1, 'BUTTON:button', 0, 8],
    'eight real buttons replace the mascot and the dot strip stays: ' + JSON.stringify(shelf));
  assert.deepStrictEqual(shelf.states, milestones.milestones.map(m => m.state), 'spines follow the real milestone states');
  const shortName = label => { const name = label.replace(/^an?\s+/i, ''); return name.charAt(0).toUpperCase() + name.slice(1); };
  // Numbers and dates are formatted by the renderer, whose locale can differ from this process.
  const pageNumber = value => evaluate('(' + Number(value) + ').toLocaleString()');
  const pageDate = ts => evaluate('new Date(' + Number(ts) + ").toLocaleDateString(undefined, { month: 'short', day: 'numeric' })");
  const nextCaption = shortName(milestones.next.label) + ' · next · ' + await pageNumber(milestones.next.remaining) + ' words to go';
  assert.deepStrictEqual([shelf.picked, shelf.pressed, shelf.caption], [nextIndex, nextIndex, nextCaption], 'the shelf opens on the next milestone: ' + JSON.stringify(shelf));
  assert.strictEqual(shelf.borders[nextIndex], 'dashed', 'the next spine is a dashed outline');
  assert.ok(/^matrix\(0\.97/.test(shelf.transforms[nextIndex]), 'the next spine leans 13 degrees: ' + shelf.transforms[nextIndex]);
  const lastIndex = milestones.milestones.length - 1;
  await evaluate(`document.querySelectorAll('.ins-shelf-book')[${lastIndex}].dispatchEvent(new MouseEvent('mouseenter')); true`);
  await pause(320);
  const hoveredShelf = await shelfState();
  const last = milestones.milestones[lastIndex];
  assert.deepStrictEqual([hoveredShelf.picked, hoveredShelf.caption, hoveredShelf.transforms[lastIndex]],
    [lastIndex, shortName(last.label) + ' · ' + await pageNumber(last.words) + ' words', 'matrix(1, 0, 0, 1, 0, -6)'], 'hovering a spine lifts it 6px and names it: ' + JSON.stringify(hoveredShelf));
  await evaluate(`document.querySelectorAll('.ins-shelf-book')[${nextIndex + 1}].focus(); true`);
  const focusedShelf = await shelfState();
  assert.deepStrictEqual([focusedShelf.picked, focusedShelf.focus], [nextIndex + 1, nextIndex + 1], 'keyboard focus picks a spine');
  win.webContents.send('history-updated', snapshot);
  await pause(150);
  assert.deepStrictEqual([(await shelfState()).picked, (await shelfState()).focus], [nextIndex + 1, nextIndex + 1], 'a re-render keeps the picked spine and its focus');
  // A longer history: reached spines fill in and carry the day they were reached.
  const shortHistory = snapshot.entries;
  const yearStart = new Date(new Date(now).getFullYear(), 0, 1).getTime() + 1000;
  const essay = { id: 'essay', ts: Math.max(now - 10 * 86400000, yearStart), text: 'word '.repeat(600).trim(), durationMs: 300000 };
  snapshot = { ...snapshot, entries: [...shortHistory, essay] };
  win.webContents.send('history-updated', snapshot);
  await pause(200);
  const longer = computeInsights(snapshot.entries, snapshot.phrases, 'all').milestones;
  assert.ok(longer.reachedCount >= 1 && longer.next, 'the longer fixture reaches a milestone');
  await click('.ins-shelf-book.is-reached');
  const filledShelf = await shelfState();
  assert.deepStrictEqual(filledShelf.states, longer.milestones.map(m => m.state), 'spines follow the new states');
  assert.deepStrictEqual([filledShelf.borders[0], filledShelf.picked], ['solid', 0]);
  assert.strictEqual(filledShelf.caption, shortName(longer.milestones[0].label) + ' · ' + await pageDate(longer.milestones[0].reachedAt), 'a reached spine shows the day it was reached');
  await shoot('insights-shelf');
  snapshot = { ...snapshot, entries: shortHistory };
  win.webContents.send('history-updated', snapshot);
  await pause(200);
  await click('[data-range="7d"]');
  const expected = computeInsights(snapshot.entries, snapshot.phrases, '7d');
  assert.strictEqual(await text('ins-summary-words'), expected.volume.words.toLocaleString(), 'summary follows the selected range');
  assert.strictEqual(await text('ins-summary-sessions'), '3');
  await click('[data-tab="voice"]');
  assert.strictEqual(await evaluate(`document.getElementById('ins-tab-usage').hidden`), true);
  await shoot('voice-insights');

  for (const [width, height] of [[1120, 760], [800, 650], [640, 440]]) {
    await fitViewport(win, width, height);
    await pause(120);
    for (const page of ['dictation', 'dictionary', 'writing-style', 'insights', 'help']) {
      await click('#nav-' + page);
      await pause(250);
      await evaluate(`document.querySelector('#view-${page} .pane-body').scrollTop = 0; true`);
      const overflow = await evaluate(`(() => { const el = document.querySelector('#view-${page} .pane-body'); return el.scrollWidth - el.clientWidth; })()`);
      assert.ok(overflow <= 1, page + ' must fit at ' + width + 'px, overflow=' + overflow);
      if (width === 1120) await shoot(page + '-theme');
      if (page === 'dictation') {
        // The hero now opens the left column, with the library directly under
        // it and the right-hand cards beside it or, when narrow, below.
        assert.ok(await evaluate(`(() => {
          const left = document.querySelector('.hero-left'), right = document.querySelector('.hero-right');
          const stage = document.querySelector('.voice-stage').getBoundingClientRect();
          const toolbar = document.querySelector('#view-dictation .toolbar').getBoundingClientRect();
          const l = left.getBoundingClientRect(), r = right.getBoundingClientRect();
          const apart = l.right <= r.left + 0.5 || l.bottom <= r.top + 0.5 || r.right <= l.left + 0.5 || r.bottom <= l.top + 0.5;
          return left.firstElementChild === document.querySelector('.voice-stage')
            && Math.round(toolbar.top - stage.bottom) === 12 && apart;
        })()`), 'the hero opens the left column, the library follows it, and the columns never overlap at ' + width + 'px');
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
        // The typed headline: two lines that never wrap, in a column that
        // clips, beside a separate zone that owns the app marks.
        const headline = await evaluate(`(() => {
          const h2 = document.querySelector('#voice-stage h2'), copy = document.querySelector('.voice-stage-copy');
          const field = document.querySelector('.hero-app-field'), typed = document.getElementById('hero-typed');
          const saved = typed.textContent; typed.textContent = 'in the doc, done.';
          const line = parseFloat(getComputedStyle(h2).lineHeight);
          const out = { lines: Math.round(h2.getBoundingClientRect().height / line), wrap: getComputedStyle(h2).whiteSpace,
            fits: typed.parentElement.lastElementChild.getBoundingClientRect().right <= copy.getBoundingClientRect().right,
            copyClips: getComputedStyle(copy).overflow, fieldShown: getComputedStyle(field).display !== 'none',
            gap: field.getBoundingClientRect().left - copy.getBoundingClientRect().right,
            shown: [...field.querySelectorAll('.hero-app-slot:not(.is-parked)')].length };
          typed.textContent = saved; return out;
        })()`);
        assert.deepStrictEqual([headline.lines, headline.wrap, headline.copyClips, headline.fits], [2, 'nowrap', 'hidden', true],
          'the headline stays on two lines with its longest ending at ' + width + 'px: ' + JSON.stringify(headline));
        if (width === 640) assert.strictEqual(headline.fieldShown, false, 'the app marks are gone at the minimum window width');
        else assert.ok(headline.fieldShown && headline.gap >= 0 && headline.shown > 0, 'the app marks keep their own zone at ' + width + 'px: ' + JSON.stringify(headline));
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
  assert.deepStrictEqual(await evaluate(`[document.getElementById('voice-stage').classList.contains('is-typing'), document.getElementById('hero-typed').textContent,
    getComputedStyle(document.querySelector('.hero-caret')).visibility,
    document.getElementById('greeting-icon').getAnimations({ subtree: true }).some(animation => animation.playState === 'running')]`),
    [false, 'in writing.', 'hidden', false], 'reduced motion rests on the settled headline, without a caret or a moving greeting icon');
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
