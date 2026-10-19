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
const { countWords, computeMetrics } = require('../src/metrics');
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
  // A development build offers Spoken corrections; a release hides the row.
  spokenCorrectionsAvailable: true,
  entries: [
    { id: 'one', ts: now, text: 'Let’s keep the next version simple. A little more space, a clearer message, and a flow that feels effortless.', durationMs: 9500, targetExe: 'slack.exe', category: 'work',
      exe: 'slack.exe', title: 'Slack | #product', audio: true },
    { id: 'two', ts: now - 3600000, text: 'Hey, I’ll be there in ten minutes. Could you grab us a table by the window?', durationMs: 7400, targetExe: 'whatsapp.exe', category: 'personal',
      exe: 'chrome.exe', title: 'Inbox - Gmail - Google Chrome' },
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
  // Polishing a dictation from its card: the reply comes after a moment, and
  // the history broadcast carries the polished version.
  const polishCalls = [];
  ipcMain.handle('polish-quote', () => ({ words: 0, credits: 0, label: '', ok: false, reason: 'empty' }));
  ipcMain.handle('polish-entry', async (_event, id, mode) => {
    polishCalls.push([id, mode]);
    await new Promise(resolve => setTimeout(resolve, 200));
    snapshot = { ...snapshot, entries: snapshot.entries.map(entry => entry.id === id
      ? { ...entry, polished: { text: 'Let’s keep the next version simple.', at: Date.now(), credits: 0.25, mode } } : entry) };
    win.webContents.send('history-updated', snapshot);
    return { ok: true, text: 'Let’s keep the next version simple.', credits: 0.25, mode, placed: 'none' };
  });
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
  assert.strictEqual(await evaluate(`document.querySelector('.hero-waveform, #voice-stage, .hero-app-field, #hero-typed, #dictation-metrics')`), null,
    'the voice stage, its floating app marks, the typed headline and the pace card are gone');
  assert.ok((await text('home-shortcut')).includes('to dictate anywhere'), 'the shortcut line says what the keys do');
  await pause(200);
  const white = process.argv.includes('--white');

  // --- Home: greeting, page layout, latest dictation, cards -----------------
  const home = await evaluate(`(() => {
    const icon = document.getElementById('greeting-icon'), line = document.querySelector('#view-dictation .hero-greeting');
    const salute = document.getElementById('greeting-salute'), name = document.getElementById('greeting-name');
    const cs = getComputedStyle(line);
    const page = document.querySelector('#view-dictation .dictation-page'), feed = document.getElementById('dictation-feed');
    const aside = document.querySelector('.dictation-aside'), pcs = getComputedStyle(page), fcs = getComputedStyle(feed);
    const ring = document.getElementById('vu-ring-progress'), card = document.getElementById('voice-understanding');
    return { part: icon.dataset.dayPart, iconSize: icon.querySelector('svg').getBoundingClientRect().width,
      beforeSalute: icon.nextElementSibling === salute,
      greeting: { tag: line.tagName, font: cs.fontSize, line: cs.lineHeight, track: cs.letterSpacing, wrap: cs.whiteSpace,
        weight: cs.fontWeight, lines: Math.round(line.getBoundingClientRect().height / parseFloat(cs.lineHeight)),
        salute: salute.textContent, saluteWeight: getComputedStyle(salute).fontWeight, nameWeight: getComputedStyle(name).fontWeight,
        // The icon, the words and the name share one line box.
        sameRow: [icon, salute, name].every(el => Math.abs(el.getBoundingClientRect().top
          + el.getBoundingClientRect().height / 2 - (line.getBoundingClientRect().top + line.getBoundingClientRect().height / 2)) < 6) },
      page: { display: pcs.display, gap: pcs.columnGap, padding: pcs.padding, overflow: pcs.overflowY },
      feed: { overflow: fcs.overflowY, fades: fcs.maskImage !== 'none', scrollsPage: page.scrollHeight > page.clientHeight + 1 },
      aside: { width: Math.round(aside.getBoundingClientRect().width), right: aside.getBoundingClientRect().right <= page.getBoundingClientRect().right },
      ringBox: ring.ownerSVGElement.getBoundingClientRect().width, stroke: getComputedStyle(ring).strokeWidth,
      chip: getComputedStyle(document.getElementById('vu-profile')).backgroundColor, name: document.getElementById('vu-profile').textContent,
      link: card.getAttribute('role') + ':' + card.tabIndex };
  })()`);
  assert.ok(['dawn', 'morning', 'afternoon', 'evening', 'night'].includes(home.part) && home.iconSize === 21 && home.beforeSalute,
    'a 21px time-of-day icon leads the greeting: ' + JSON.stringify(home));
  assert.deepStrictEqual([home.greeting.tag, home.greeting.font, home.greeting.line, home.greeting.track,
    home.greeting.wrap, home.greeting.weight, home.greeting.lines, home.greeting.sameRow],
    ['H1', '28px', '33.6px', '-0.45px', 'nowrap', '600', 1, true],
    'icon, greeting and name are one 28px line that never wraps: ' + JSON.stringify(home.greeting));
  assert.deepStrictEqual([home.greeting.salute, home.greeting.saluteWeight, home.greeting.nameWeight],
    [home.greeting.salute.replace(/,?$/, ','), '500', '600'],
    'the greeting keeps its comma, the name carries the weight: ' + JSON.stringify(home.greeting));
  assert.deepStrictEqual(home.page, { display: 'flex', gap: '40px', padding: '30px 40px 0px 48px', overflow: 'hidden' },
    'the page is two columns that do not scroll as a whole: ' + JSON.stringify(home.page));
  assert.deepStrictEqual([home.feed.overflow, home.feed.fades, home.feed.scrollsPage, home.aside.width, home.aside.right],
    ['auto', true, false, 288, true], 'the feed scrolls and fades inside its column beside a 288px aside: ' + JSON.stringify(home));
  assert.deepStrictEqual([home.ringBox, home.stroke, home.chip, home.name, home.link], [42, '4px', 'rgba(0, 0, 0, 0)', 'Learning', 'button:0'],
    'the voice profile is a 42px ring beside a plain stage name: ' + JSON.stringify(home));
  assert.strictEqual(await evaluate(`document.querySelectorAll('#view-dictation .stats, #view-dictation .stat').length`), 0,
    'the old three-cell totals row is gone');

  // The latest dictation of today leads the feed on the mint surface, with its
  // actions in the open; every other card is a plain surface.
  const lead = await evaluate(`(() => {
    const card = document.querySelector('#groups .card'), cs = getComputedStyle(card), words = card.querySelector('.text');
    const copy = card.querySelector('.copy-main'), play = card.querySelector('.pill-play'), polish = card.querySelector('.pill-polish');
    return { id: card.dataset.id, latest: document.querySelectorAll('#groups .card.is-latest').length, first: card.classList.contains('is-latest'),
      radius: cs.borderRadius, bg: cs.backgroundColor, pad: cs.padding, font: getComputedStyle(words).fontSize, line: getComputedStyle(words).lineHeight,
      app: card.querySelector('.card-app').textContent, windowTitle: card.querySelector('.card-title').textContent,
      icon: card.querySelector('.card-app-icon').tagName, time: !!card.querySelector('.card-head .time'),
      copyBg: getComputedStyle(copy).backgroundColor, copyInk: getComputedStyle(copy).color, copyLabel: copy.textContent.trim(),
      play: play ? play.getAttribute('aria-label') : null, wave: play ? play.querySelectorAll('.wave rect').length : 0,
      polish: polish.textContent.trim(), more: card.querySelectorAll('.card-more').length };
  })()`);
  assert.deepStrictEqual([lead.id, lead.latest, lead.first, lead.radius, lead.pad, lead.font, lead.line],
    ['one', 1, true, '18px', '16px 20px 18px', '17px', '27.2px'], 'the newest dictation of today is the one lead card: ' + JSON.stringify(lead));
  assert.strictEqual(lead.bg, white ? 'rgb(230, 244, 236)' : 'rgb(20, 35, 28)', 'the lead card is mint-tinted');
  assert.deepStrictEqual([lead.app, lead.windowTitle, lead.icon, lead.time], ['Slack', 'Slack | #product', 'SPAN', true],
    'the header names the app and the window, with a neutral mark for an app without one: ' + JSON.stringify(lead));
  assert.deepStrictEqual([lead.copyBg, lead.copyInk, lead.copyLabel, lead.play, lead.wave, lead.polish, lead.more],
    ['rgb(156, 243, 196)', 'rgb(14, 36, 25)', 'Copy', 'Play recording, 0:10', 11, 'Polish', 1],
    'Copy, a Play pill with its bars and a duration, and Polish: ' + JSON.stringify(lead));
  const second = await evaluate(`(() => {
    const card = document.querySelector('#groups .card:not(.is-latest)'), cs = getComputedStyle(card), words = card.querySelector('.text');
    const actions = card.querySelector('.card-actions');
    return { id: card.dataset.id, radius: cs.borderRadius, bg: cs.backgroundColor, pad: cs.padding, font: getComputedStyle(words).fontSize,
      line: getComputedStyle(words).lineHeight, app: card.querySelector('.card-app').textContent,
      icon: card.querySelector('.card-app-icon').getAttribute('src'), rest: getComputedStyle(actions).opacity,
      buttons: [...actions.children].map(b => b.className.replace('cbtn ', '')) };
  })()`);
  assert.deepStrictEqual([second.radius, second.pad, second.font, second.line, second.rest], ['16px', '14px 18px 16px', '15px', '23.7px', '0'],
    'other cards are 16px surfaces with 15px words, their buttons waiting: ' + JSON.stringify(second));
  assert.strictEqual(second.bg, white ? 'rgb(255, 255, 255)' : 'rgb(25, 29, 32)', 'other cards are the surface colour');
  assert.ok(second.icon.endsWith('/assets/hero-apps/gmail.svg') && second.app === 'Gmail',
    'a web app named in the title is shown instead of the browser: ' + JSON.stringify(second));
  assert.deepStrictEqual(second.buttons, ['cbtn-copy', 'card-more'], 'no recording, no Play button');
  const secondBox = await evaluate(`(() => { const r = document.querySelector('#groups .card:not(.is-latest)').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: secondBox.x, y: secondBox.y });
  await pause(450);
  assert.deepStrictEqual(await evaluate(`(() => { const card = document.querySelector('#groups .card:not(.is-latest)');
    return [getComputedStyle(card.querySelector('.card-actions')).opacity, getComputedStyle(card).translate]; })()`),
    ['1', '0px -1px'], 'hovering a card reveals its round buttons and lifts it 1px');
  await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 });
  const feedShape = await evaluate(`(() => {
    const groups = [...document.querySelectorAll('#groups .day-group')];
    return { labels: groups.map(g => g.querySelector('.day-label').textContent), counts: groups.map(g => g.querySelector('.day-count').textContent),
      cards: groups.map(g => g.querySelectorAll('.card').length),
      sticky: groups.map(g => getComputedStyle(g.querySelector('.day')).position + ':' + getComputedStyle(g.querySelector('.day')).top),
      sections: groups.every(g => g.tagName === 'SECTION') };
  })()`);
  assert.deepStrictEqual([feedShape.labels[0], feedShape.labels[1], feedShape.labels.length, feedShape.sections], ['Today', 'Yesterday', 3, true],
    'each day is its own section: ' + JSON.stringify(feedShape));
  assert.ok(feedShape.sticky.every(value => value === 'sticky:0px'), 'every day header sticks to the top of the feed: ' + JSON.stringify(feedShape));
  assert.strictEqual(feedShape.counts.join('|'), feedShape.cards.map(n => n === 1 ? '1 dictation' : n + ' dictations').join('|'), 'the headers count their cards');

  // Polish from the lead card: a free account is taken to the Polish page, a Pro
  // account polishes in place (the card shows the work and then the result).
  await click('#groups .card.is-latest .pill-polish');
  await pause(120);
  assert.strictEqual(await evaluate(`document.getElementById('view-polish').hidden`), false, 'Polish on a free account opens the Polish page');
  await click('#nav-dictation');
  await pause(120);
  snapshot = { ...snapshot, account: { signedIn: true, plan: 'pro', cloud: { creditsCap: 900, creditsUsed: 0 } } };
  win.webContents.send('history-updated', snapshot);
  await pause(120);
  await click('#groups .card.is-latest .pill-polish');
  await pause(60);
  assert.deepStrictEqual(await evaluate(`(() => { const pill = document.querySelector('#groups .card.is-latest .pill-polish');
    return [pill.textContent.trim(), pill.disabled, document.querySelector('#groups .card.is-latest .text').classList.contains('is-polishing')]; })()`),
    ['Polishing', true, true], 'the pill and the words show that a polish is running');
  await pause(300);
  assert.deepStrictEqual(polishCalls, [['one', 'polish']], 'the pill polishes this dictation through the entry channel');
  assert.deepStrictEqual(await evaluate(`(() => { const card = document.querySelector('#groups .card.is-latest');
    return [card.querySelector('.pill-polish').textContent.trim(), card.querySelector('.card-polished-text').textContent,
      card.querySelector('.pill-polish').disabled, card.querySelector('.text').classList.contains('is-polishing')]; })()`),
    ['Polish again', 'Let’s keep the next version simple.', false, false], 'the polished version appears under the words');
  const { account: _proAccount, ...freeSnapshot } = snapshot;
  snapshot = freeSnapshot;
  win.webContents.send('history-updated', snapshot);
  await pause(120);

  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  const todayEntries = snapshot.entries.filter(entry => entry.ts >= todayStart.getTime() && entry.ts < todayStart.getTime() + 86400000);
  const week = await evaluate(`(() => {
    const bars = document.getElementById('week-bars');
    const cells = [...bars.querySelectorAll('.week-day')];
    return { role: bars.getAttribute('role'), label: bars.getAttribute('aria-label'),
      days: cells.length, letters: cells.map(cell => cell.querySelector('.week-dow').textContent),
      heights: cells.map(cell => Math.round(parseFloat(getComputedStyle(cell.querySelector('.week-bar')).height))),
      empty: cells.map(cell => cell.classList.contains('is-empty')), today: cells.map(cell => cell.classList.contains('is-today')),
      colors: cells.map(cell => getComputedStyle(cell.querySelector('.week-bar')).backgroundColor),
      tips: cells.map(cell => cell.querySelector('.week-tip').textContent), tipOpacity: getComputedStyle(cells[0].querySelector('.week-tip')).opacity,
      barWidth: getComputedStyle(cells[0].querySelector('.week-bar')).width, chart: Math.round(bars.getBoundingClientRect().height),
      number: document.getElementById('statWeek').textContent,
      allTime: document.getElementById('statWords').textContent,
      dictations: document.getElementById('statNotes').textContent,
      todayWords: document.getElementById('words-today').textContent, todayUnit: document.getElementById('words-today-unit').textContent,
      weekday: document.getElementById('words-weekday').textContent, sub: document.getElementById('words-today-sub').textContent,
      saved: document.getElementById('words-saved').textContent,
      expectedWeekday: new Date().toLocaleDateString(undefined, { weekday: 'long' }),
      savedPhrase: typingSavedPhrase(${JSON.stringify(computeMetrics(todayEntries).timeSavedMs)}),
      weekSaved: formatDmSaved(${JSON.stringify(computeMetrics(snapshot.entries.filter(entry => entry.ts >= now - 7 * 86400000)).timeSavedMs)}) };
  })()`);
  const weekDays = [0, 0, 0, 0, 0, 0, 0];
  let weekTotal = 0;
  let allTimeWords = 0;
  let todayWords = 0;
  for (const entry of snapshot.entries) {
    const words = countWords(entry.text);
    allTimeWords += words;
    if (entry.ts >= todayStart.getTime() && entry.ts < todayStart.getTime() + 86400000) todayWords += words;
    if (entry.ts < now - 7 * 86400000) continue;
    weekTotal += words;
    weekDays[(new Date(entry.ts).getDay() + 6) % 7] += words;
  }
  // Today's bar counts today alone, whatever else the rolling week holds for that weekday.
  const todayIndex = (new Date().getDay() + 6) % 7;
  weekDays[todayIndex] = todayWords;
  assert.deepStrictEqual([week.role, week.days, week.number, week.allTime, week.dictations, week.todayWords, week.todayUnit, week.weekday],
    ['img', 7, await evaluate('(' + weekTotal + ').toLocaleString()'), await evaluate('(' + allTimeWords + ').toLocaleString()'),
      String(snapshot.entries.length), await evaluate('(' + todayWords + ').toLocaleString()'), todayWords === 1 ? 'word' : 'words',
      week.expectedWeekday], 'the words panel counts the real history: ' + JSON.stringify(week));
  assert.strictEqual(week.sub, (todayEntries.length === 1 ? '1 dictation' : todayEntries.length + ' dictations')
    + (week.savedPhrase ? ' · ' + week.savedPhrase : ''), 'the line under today says how many dictations and how much typing they saved: ' + week.sub);
  assert.ok(week.saved.includes(week.weekSaved) && week.saved.includes('against typing at 40 words a minute'),
    'the week says what it saved against typing: ' + week.saved);
  assert.ok(week.label.startsWith('Words per day this week:') && weekDays.every((words, i) => week.label.includes(' ' + words))
    && week.label.includes('Today ' + todayWords), 'the bar group is labelled with every day figure: ' + week.label);
  assert.deepStrictEqual(week.empty, weekDays.map(words => words === 0), 'empty days are marked as such');
  assert.deepStrictEqual(week.today, weekDays.map((_w, i) => i === todayIndex), 'today is the one marked day');
  const busiest = Math.max(...weekDays);
  assert.deepStrictEqual(week.heights, weekDays.map(words => words > 0 ? Math.max(4, Math.round(72 * words / busiest)) : 3),
    'bars scale to the busiest day, empty days keep a 3px stub: ' + JSON.stringify(week));
  assert.deepStrictEqual([week.barWidth, week.chart, week.tipOpacity], ['20px', 92, '0'], 'bars are 20px wide in a 92px chart, tips wait for a hover');
  assert.strictEqual(new Set(week.colors.filter((_c, i) => weekDays[i] === 0)).size, 1, 'every empty day draws the same pale stub');
  assert.notStrictEqual(week.colors[todayIndex], week.colors[(todayIndex + 1) % 7], 'today is drawn in the accent');
  assert.ok(week.tips[todayIndex].startsWith('Today · ') && week.tips.every((tip, i) => tip.endsWith(weekDays[i] > 0 ? (weekDays[i] === 1 ? '1 word' : weekDays[i] + ' words') : 'no dictation')),
    'every bar has its tooltip: ' + JSON.stringify(week.tips));

  // A long name gives way with an ellipsis rather than wrapping or widening.
  snapshot = { ...snapshot, displayName: 'Bartholomew Maximilian Featherstonehaugh III' };
  win.webContents.send('history-updated', snapshot);
  await pause(120);
  assert.ok(await evaluate(`(() => {
    const line = document.querySelector('#view-dictation .hero-greeting'), name = document.getElementById('greeting-name');
    const body = document.querySelector('#view-dictation .pane-body'), search = document.getElementById('dictation-search');
    return Math.round(line.getBoundingClientRect().height / parseFloat(getComputedStyle(line).lineHeight)) === 1
      && getComputedStyle(name).textOverflow === 'ellipsis'
      && name.getBoundingClientRect().right <= line.getBoundingClientRect().right + 1
      && line.getBoundingClientRect().right <= search.getBoundingClientRect().left
      && body.scrollWidth - body.clientWidth <= 1;
  })()`), 'a long name ellipsizes on the one greeting line, clear of the search');
  snapshot = { ...snapshot, displayName: 'Alex' };
  win.webContents.send('history-updated', snapshot);
  await pause(120);

  // The voice profile opens Insights, as it always has.
  await click('#voice-understanding');
  assert.deepStrictEqual(await evaluate(`[document.getElementById('view-insights').hidden, document.getElementById('ins-tab-voice').hidden]`), [false, false],
    'the voice profile still opens Insights, on the voice tab');
  await click('[data-tab="usage"]');
  await click('#nav-dictation');
  assert.strictEqual(toggles, 0, 'nothing on the page invokes recording');
  await shoot('home');

  // --- Search: a pill that is always there ----------------------------------
  const searchState = () => evaluate(`(() => {
    const root = document.getElementById('dictation-search'), r = root.getBoundingClientRect(), input = document.getElementById('search');
    const hits = window.CSS && CSS.highlights && CSS.highlights.get('dictation-hit');
    return { w: Math.round(r.width), h: Math.round(r.height), radius: getComputedStyle(root).borderRadius, value: input.value,
      count: document.getElementById('search-count').textContent, clear: !document.getElementById('search-clear').hidden,
      cards: document.querySelectorAll('#groups .card').length, leads: document.querySelectorAll('#groups .card.is-latest').length,
      headers: [...document.querySelectorAll('#groups .day-count')].map(el => el.textContent),
      hits: hits ? hits.size : -1, focus: document.activeElement && document.activeElement.id };
  })()`);
  const type = value => evaluate(`(() => { const input = document.getElementById('search'); input.value = ${JSON.stringify(value)}; input.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  const restSearch = await searchState();
  assert.deepStrictEqual([restSearch.w, restSearch.h, restSearch.radius, restSearch.value, restSearch.clear, restSearch.cards, restSearch.leads],
    [248, 38, '19px', '', false, 4, 1], 'search rests as an open 248x38 pill: ' + JSON.stringify(restSearch));
  await evaluate(`document.getElementById('search').focus(); true`);
  await type('table');
  await pause(220);
  const openSearch = await searchState();
  assert.deepStrictEqual([openSearch.count, openSearch.clear, openSearch.cards, openSearch.leads, openSearch.headers, openSearch.focus],
    ['1 of 4', true, 1, 0, ['1 match'], 'search'], 'the query filters the feed, with a count, a clear button and no lead card: ' + JSON.stringify(openSearch));
  if (openSearch.hits !== -1) assert.strictEqual(openSearch.hits, 1, 'the match is highlighted in place');
  if (openSearch.hits !== -1) {
    // A card being edited is not highlighted, and its text stays plain.
    await evaluate(`document.querySelector('#groups .card .text').focus(); true`);
    assert.strictEqual((await searchState()).hits, 0, 'a card being edited carries no highlight');
    assert.strictEqual(await evaluate(`document.querySelector('#groups .card .text').childNodes.length`), 1, 'the editable text is still one text node');
    await evaluate(`document.querySelector('#groups .card .text').blur(); true`);
    assert.strictEqual((await searchState()).hits, 1, 'the highlight returns when the edit ends');
    await evaluate(`document.getElementById('search').focus(); true`);
  }
  await evaluate(`document.getElementById('search').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); true`);
  await pause(60);
  const closedSearch = await searchState();
  assert.deepStrictEqual([closedSearch.value, closedSearch.count, closedSearch.clear, closedSearch.cards, closedSearch.leads, closedSearch.focus],
    ['', '', false, 4, 1, 'search'], 'Escape clears the search and brings the lead card back: ' + JSON.stringify(closedSearch));
  await type('proposal');
  await pause(200);
  await click('#search-clear');
  assert.deepStrictEqual([(await searchState()).value, (await searchState()).cards, (await searchState()).focus], ['', 4, 'search'], 'the clear button does the same');
  await type('zzzz');
  await pause(200);
  assert.deepStrictEqual(await evaluate(`(() => { const empty = document.getElementById('empty');
    return [empty.hidden, empty.querySelector('.empty-title').textContent, !!empty.querySelector('.empty-clear')]; })()`),
    [false, 'No dictations match “zzzz”', true], 'a search with no match says so and offers a way back');
  await click('#empty .empty-clear');
  assert.deepStrictEqual([(await searchState()).cards, await evaluate(`document.getElementById('empty').hidden`)], [4, true], 'Clear search restores the feed');
  await evaluate(`document.getElementById('search').blur(); true`);
  const pressCtrlF = () => evaluate(`(() => { const event = new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true, cancelable: true }); document.dispatchEvent(event); return event.defaultPrevented; })()`);
  assert.strictEqual(await pressCtrlF(), true, 'Ctrl+F is taken over on the Dictation page');
  assert.strictEqual((await searchState()).focus, 'search', 'Ctrl+F focuses the Dictation search');
  await evaluate(`document.getElementById('search').blur(); true`);
  await click('#nav-dictionary');
  await pause(100);
  assert.strictEqual(await evaluate(`document.getElementById('greeting-icon').getAnimations({ subtree: true }).some(animation => animation.playState === 'running')`), false, 'the hidden page has no running animations');
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
  assert.notStrictEqual((await searchState()).focus, 'search', 'Ctrl+F on Dictionary leaves the Dictation search alone');
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
  assert.deepStrictEqual([prefs.cards, prefs.example, prefs.labels, prefs.toggles], [0, 0, ['Verbatim mode', 'Auto cleanup', 'Spoken corrections', 'Write numbers as digits'], ['set-verbatim', 'set-auto-cleanup', 'set-spoken-corrections', 'set-numbers-digits']],
    'preferences are one list of four rows with their toggles: ' + JSON.stringify(prefs));
  assert.deepStrictEqual(prefs.hints, ['Your exact words. No cleanup, commands or tone.', 'Fixes grammar and punctuation, keeps your wording.', 'Change your mind mid-sentence. “At 3, no, 4” types “At 4”.', 'twenty five becomes 25.']);
  assert.deepStrictEqual([prefs.dividers, prefs.toggleRight, prefs.oneSurface, prefs.subHidden], [[false, true, true, true], true, true, true], 'hairlines between rows, toggles at the right, one card: ' + JSON.stringify(prefs));
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
  // Spoken corrections: off until turned on, saved like the others.
  assert.strictEqual(await evaluate(`document.getElementById('set-spoken-corrections').checked`), false);
  await click('#set-spoken-corrections');
  await pause(100);
  assert.strictEqual(snapshot.spokenCorrections, true, 'spoken corrections save through settings IPC');
  // A release build offers no switch at all.
  win.webContents.send('history-updated', { ...snapshot, spokenCorrectionsAvailable: false });
  await pause(100);
  assert.strictEqual(await evaluate(`document.getElementById('spoken-corrections-card').hidden`), true, 'a release hides the row');
  win.webContents.send('history-updated', snapshot);
  await pause(100);
  assert.strictEqual(await evaluate(`document.getElementById('spoken-corrections-card').hidden`), false);
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
  assert.strictEqual(await evaluate(`document.getElementById('set-spoken-corrections').disabled`), true, 'verbatim keeps every word, corrections too');
  assert.strictEqual(await text('spoken-corrections-status'), 'Paused while Verbatim mode is on.');
  assert.strictEqual(await evaluate(`document.getElementById('set-spoken-corrections').checked`), true, 'and keeps the saved choice');
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
  assert.strictEqual(await evaluate(`document.getElementById('set-spoken-corrections').disabled`), true, 'its cue words are English');
  assert.ok((await text('spoken-corrections-status')).includes('English'));
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
        // Beside the feed on a wide window, above it once the columns stack, and
        // the greeting never runs into the search at any width.
        assert.ok(await evaluate(`(() => {
          const feed = document.getElementById('dictation-feed'), aside = document.querySelector('.dictation-aside');
          const body = document.querySelector('#view-dictation .pane-body');
          const f = feed.getBoundingClientRect(), a = aside.getBoundingClientRect();
          const apart = f.right <= a.left + 0.5 || f.bottom <= a.top + 0.5 || a.right <= f.left + 0.5 || a.bottom <= f.top + 0.5;
          const stacked = innerWidth <= 900;
          const hello = document.querySelector('.dictation-hello').getBoundingClientRect(), search = document.getElementById('dictation-search').getBoundingClientRect();
          const rowsApart = hello.right <= search.left + 0.5 || hello.bottom <= search.top + 0.5;
          const scrolls = (el) => ['auto', 'scroll'].includes(getComputedStyle(el).overflowY);
          return apart && rowsApart && a.right <= body.getBoundingClientRect().right
            && (stacked ? a.bottom <= f.top + 0.5 && scrolls(body) && !scrolls(feed) : a.left >= f.right && scrolls(feed) && !scrolls(body));
        })()`), 'the feed and the words panel never overlap, and stack in the right order at ' + width + 'px');
        assert.ok(await evaluate(`(() => {
          const cards = [...document.querySelectorAll('#groups .card')], feed = document.getElementById('dictation-feed').getBoundingClientRect();
          return cards.length > 0 && cards.every(card => card.getBoundingClientRect().right <= feed.right + 1 && card.scrollWidth <= card.clientWidth + 1);
        })()`), 'cards stay inside their column at ' + width + 'px');
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
  assert.strictEqual(await evaluate(`document.getElementById('greeting-icon').getAnimations({ subtree: true }).some(animation => animation.playState === 'running')
    || [...document.querySelectorAll('#groups .card, #week-bars .week-bar, #vu-ring-progress, .words-today')].some(el => el.getAnimations().length > 0)`),
    false, 'reduced motion stills the greeting icon, the cards, the bars and the ring');
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
  console.log('Refinement UI: Dictation page (greeting, lead card, cards, words panel, search), dictionary, style preview, settings, insights, compact layouts, flow states and reduced motion passed.');
  win.destroy();
  app.quit();
}).catch(error => { console.error(error); clearTimeout(deadline); app.exit(1); });
