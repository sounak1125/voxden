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
  notifications: [], pendingPhrases: [],
  entries: [
    { id: 'one', ts: now, text: 'Let’s keep the next version simple. A little more space, a clearer message, and a flow that feels effortless.', durationMs: 9500, exe: 'slack.exe', title: 'general - Acme - Slack', category: 'work' },
    { id: 'two', ts: now - 3600000, text: 'Hey, I’ll be there in ten minutes. Could you grab us a table by the window?', durationMs: 7400, exe: 'WhatsApp.exe', title: 'WhatsApp', category: 'personal' },
    { id: 'three', ts: now - 86400000, text: 'Thank you for the thoughtful feedback. I will send the updated proposal tomorrow morning.', durationMs: 7100, exe: 'OUTLOOK.EXE', title: 'Inbox - Outlook', category: 'email' },
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
    snapshot = { ...snapshot, ...patch, writingStyles: { ...snapshot.writingStyles, ...patch.writingStyles } };
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
  assert.strictEqual(await evaluate(`document.querySelector('#voice-stage, .hero-app-field, #voice-understanding, #week-bars')`), null,
    'the old hero, voice ring and week bars are gone');
  // Works in every app: two rows of the twelve marks, each holding its set
  // twice, drifting in opposite directions as decoration nobody can tab to.
  assert.ok(await evaluate(`(() => {
    const belts = document.querySelector('.apps-belts');
    const tracks = [...belts.querySelectorAll('.apps-belt-track')];
    const images = [...belts.querySelectorAll('img')];
    const names = images.map(image => new URL(image.currentSrc).pathname.split('/').pop());
    return belts.getAttribute('aria-hidden') === 'true' && tracks.length === 2
      && tracks.every(track => track.querySelectorAll('img').length === 12)
      && new Set(names).size === 12
      && belts.querySelectorAll('button, a, [tabindex]').length === 0
      && images.every(image => image.complete && image.naturalWidth > 0 && image.alt === '');
  })()`), 'twelve SVG app marks load as decorative, non-focusable artwork in two rows');
  // Offsets are read modulo half a track, so a row looping back mid-sample
  // still reads as the small step it took.
  const beltOffsets = () => evaluate(`[...document.querySelectorAll('.apps-belt-track')].map(track => new DOMMatrixReadOnly(getComputedStyle(track).transform).m41)`);
  const beltHalves = await evaluate(`[...document.querySelectorAll('.apps-belt-track')].map(track => track.scrollWidth / 2)`);
  const beltSteps = (before, after) => after.map((x, i) => {
    let step = x - before[i];
    if (step > beltHalves[i] / 2) step -= beltHalves[i];
    if (step < -beltHalves[i] / 2) step += beltHalves[i];
    return step;
  });
  const beltsBefore = await beltOffsets();
  await pause(700);
  const beltStep = beltSteps(beltsBefore, await beltOffsets());
  assert.ok(beltStep[0] > 0.5 && beltStep[1] < -0.5, 'the top row drifts right and the bottom row drifts left: ' + JSON.stringify(beltStep));
  assert.ok(Math.abs(beltStep[0]) < 12 && Math.abs(beltStep[1]) < 12, 'the rows drift slowly: ' + JSON.stringify(beltStep));
  assert.strictEqual(await evaluate(`(() => { const card = document.querySelector('.apps-card');
    return [...card.querySelectorAll('.apps-belt-track')].every(track => track.scrollWidth > track.parentElement.clientWidth)
      && card.scrollWidth <= card.clientWidth; })()`), true, 'the rows are clipped inside their card');
  assert.ok((await text('dm-wpm-context')).includes('typing speed'), 'the typing comparison stays under the pace');
  await click('#dm-wpm-metric');
  assert.strictEqual(await evaluate(`document.getElementById('view-insights').hidden`), false, 'the pace figure opens Insights');
  await click('#nav-dictation');
  assert.strictEqual(toggles, 0, 'ambient artwork does not invoke recording');
  await shoot('home');

  // --- Home: greeting, title and today's line -------------------------------
  await pause(200);
  const home = await evaluate(`(() => {
    const icon = document.getElementById('greeting-icon');
    const line = document.querySelector('#view-dictation .hero-greeting');
    const salute = document.getElementById('greeting-salute'), name = document.getElementById('greeting-name');
    const title = document.querySelector('#view-dictation h1');
    const cs = getComputedStyle(line);
    return { part: icon.dataset.dayPart, iconSize: icon.querySelector('svg').getBoundingClientRect().width,
      beforeSalute: icon.nextElementSibling === salute,
      greeting: { font: cs.fontSize, line: cs.lineHeight, track: cs.letterSpacing, wrap: cs.whiteSpace,
        lines: Math.round(line.getBoundingClientRect().height / parseFloat(cs.lineHeight)),
        salute: salute.textContent, saluteWeight: getComputedStyle(salute).fontWeight,
        nameWeight: getComputedStyle(name).fontWeight,
        // The icon, the words and the name share one line box.
        sameRow: [icon, salute, name].every(el => Math.abs(el.getBoundingClientRect().top
          + el.getBoundingClientRect().height / 2 - (line.getBoundingClientRect().top + line.getBoundingClientRect().height / 2)) < 6) },
      title: title.textContent, titleBelow: title.getBoundingClientRect().top >= line.getBoundingClientRect().bottom - 1,
      today: document.getElementById('home-today').textContent };
  })()`);
  assert.ok(['dawn', 'morning', 'afternoon', 'evening', 'night'].includes(home.part) && home.iconSize === 16 && home.beforeSalute,
    'a 16px time-of-day icon leads the greeting: ' + JSON.stringify(home));
  assert.deepStrictEqual([home.greeting.font, home.greeting.line, home.greeting.track, home.greeting.wrap, home.greeting.lines, home.greeting.sameRow],
    ['18px', '23px', '-0.4px', 'nowrap', 1, true],
    'icon, greeting and name are one 18px line that never wraps: ' + JSON.stringify(home.greeting));
  assert.deepStrictEqual([home.greeting.salute, home.greeting.saluteWeight, home.greeting.nameWeight],
    [home.greeting.salute.replace(/,?$/, ','), '400', '600'],
    'the greeting keeps its comma, the name carries the weight: ' + JSON.stringify(home.greeting));
  assert.deepStrictEqual([home.title, home.titleBelow], ['Your dictations', true], 'the page title sits under the greeting');
  const todayStart = new Date(now).setHours(0, 0, 0, 0);
  const todays = snapshot.entries.filter(entry => entry.ts >= todayStart);
  const todayWords = todays.reduce((sum, entry) => sum + countWords(entry.text), 0);
  assert.strictEqual(home.today, todays.length + ' today · ' + todayWords + ' words', "today's line counts today's dictations and words");
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

  // --- The feed: the newest dictation leads, the rest of its day beside it -----
  const feed = await evaluate(`(() => {
    const cards = [...document.querySelectorAll('#groups .card')];
    const lead = cards[0];
    const markOf = mark => mark.querySelector('img') ? new URL(mark.querySelector('img').currentSrc).pathname.split('/').pop() : 'letter:' + mark.textContent;
    return { ids: cards.map(card => card.dataset.id),
      latest: cards.filter(card => card.classList.contains('is-latest')).map(card => card.dataset.id),
      pill: lead.querySelector('.card-latest').textContent, dest: lead.querySelector('.card-dest > span:first-child').textContent,
      destMark: markOf(lead.querySelector('.card-dest .app-mark')),
      hint: lead.querySelector('.card-paste-hint').textContent,
      leadActions: getComputedStyle(lead.querySelector('.card-actions')).opacity,
      grid: [...document.querySelectorAll('#groups .card-grid .card')].map(card => card.dataset.id),
      days: [...document.querySelectorAll('#groups .day')].map(day => day.textContent),
      apps: cards.slice(1).map(card => card.querySelector('.card-app-name') ? card.querySelector('.card-app-name').textContent : null),
      marks: cards.slice(1).map(card => [...card.querySelectorAll('.app-mark')].map(markOf)) };
  })()`);
  const sameDay = new Date(snapshot.entries[1].ts).toDateString() === new Date(now).toDateString();
  assert.deepStrictEqual([feed.ids, feed.latest, feed.pill, feed.dest, feed.destMark],
    [['one', 'two', 'three', 'old'], ['one'], 'Latest', 'Pasted in Slack', 'letter:S'],
    'the newest dictation leads and says where it was pasted: ' + JSON.stringify(feed));
  assert.ok(feed.hint.includes('Paste it again anywhere with') && /Ctrl.*Alt.*V/.test(feed.hint) && feed.leadActions === '1',
    'the latest card names the paste-again keys and keeps its actions in view: ' + JSON.stringify(feed));
  assert.deepStrictEqual(feed.grid, sameDay ? ['two'] : [], 'the rest of the newest day sits in the two-up grid');
  if (sameDay) assert.strictEqual(feed.days[0], 'Earlier today', 'the grid is headed "Earlier today"');
  assert.deepStrictEqual([feed.apps, feed.marks], [['WhatsApp', 'Outlook', null], [['whatsapp.svg'], ['letter:O'], []]],
    'each card names its app with a mark, or a lettered tile for apps without one: ' + JSON.stringify(feed));

  // --- Where the words went this week, and the numbers ------------------------
  const numbers = await evaluate(`(() => ({
    rows: [...document.querySelectorAll('#apps-week-list .apps-week-row')].map(row =>
      [row.querySelector('.apps-week-name').textContent, row.querySelector('.apps-week-count').textContent]),
    emptyHidden: document.getElementById('apps-week-empty').hidden,
    week: document.getElementById('statWeek').textContent,
    allTime: document.getElementById('statWords').textContent,
    dictations: document.getElementById('statNotes').textContent,
    bars: document.querySelectorAll('#view-dictation .week-bar, #view-dictation [role="img"]').length }))()`);
  let weekTotal = 0;
  let allTimeWords = 0;
  for (const entry of snapshot.entries) {
    const words = countWords(entry.text);
    allTimeWords += words;
    if (entry.ts >= now - 7 * 86400000) weekTotal += words;
  }
  assert.deepStrictEqual(numbers.rows, [['Slack', '1'], ['WhatsApp', '1'], ['Outlook', '1']],
    'this week counts dictations per app, most recent first on a tie: ' + JSON.stringify(numbers));
  assert.deepStrictEqual([numbers.emptyHidden, numbers.week, numbers.allTime, numbers.dictations, numbers.bars],
    [true, await evaluate('(' + weekTotal + ').toLocaleString()'), await evaluate('(' + allTimeWords + ').toLocaleString()'),
      String(snapshot.entries.length), 0], 'the numbers card counts the real history, with no chart: ' + JSON.stringify(numbers));
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
  assert.strictEqual(await evaluate(`document.querySelector('.apps-belts').getAnimations({ subtree: true }).some(animation => animation.playState === 'running')`), false,
    'leaving the page stops the app rows');
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
        // The feed opens the left column; the side cards sit beside it or,
        // when narrow, below it. Nothing overlaps and nothing is cut off.
        const layout = await evaluate(`(() => {
          const box = el => el.getBoundingClientRect();
          const left = box(document.querySelector('.hero-left')), right = box(document.querySelector('.hero-right'));
          const title = box(document.querySelector('.home-title')), tools = box(document.querySelector('.home-tools'));
          const pane = box(document.querySelector('#view-dictation .pane-body'));
          const parts = [...document.querySelectorAll('#view-dictation .card, #view-dictation .apps-card, #view-dictation .week-card')];
          const overlap = (a, b) => a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;
          return { beside: left.right <= right.left + 0.5 && Math.abs(left.top - right.top) < 1,
            below: left.bottom <= right.top + 0.5,
            headingClear: !overlap(title, tools),
            inside: parts.every(el => box(el).right <= pane.right + 0.5 && el.scrollWidth <= el.clientWidth + 1),
            leadFirst: document.querySelector('#groups').firstElementChild.classList.contains('is-latest') };
        })()`);
        assert.ok((layout.beside || layout.below) && layout.headingClear && layout.inside && layout.leadFirst,
          'the feed leads, the columns never overlap and every card fits at ' + width + 'px: ' + JSON.stringify(layout));
        assert.strictEqual(layout.beside, width >= 1000, 'the side cards sit beside the feed only on a wide window at ' + width + 'px');
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
  const stillBelts = await beltOffsets();
  await pause(180);
  assert.deepStrictEqual(await beltOffsets(), stillBelts, 'reduced motion keeps the app rows still');
  assert.strictEqual(await evaluate(`document.querySelector('.apps-belts').getAnimations({ subtree: true }).some(animation => animation.playState === 'running')
    || document.getElementById('greeting-icon').getAnimations({ subtree: true }).some(animation => animation.playState === 'running')`), false,
    'reduced motion stills the app rows and the greeting icon');
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
  console.log('Refinement UI: dictations-first home, latest card, app marks, per-app week, opposite app rows, dictionary, style preview, settings, insights, compact layouts, flow states and reduced motion passed.');
  win.destroy();
  app.quit();
}).catch(error => { console.error(error); clearTimeout(deadline); app.exit(1); });
