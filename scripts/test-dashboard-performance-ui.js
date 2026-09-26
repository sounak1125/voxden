'use strict';

// Synthetic histories only: no user profile, speech models, real microphone,
// or operating-system preferences are used by this renderer regression test.
const { app, BrowserWindow, ipcMain, session } = require('electron');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'voxden-dashboard-perf-'));
app.setPath('userData', fixtureRoot);
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
const baseline = process.argv.includes('--baseline');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const timeout = setTimeout(() => { console.error('Dashboard performance test timed out'); app.exit(1); }, 60000);

app.whenReady().then(async () => {
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, done) => done(false));
  ipcMain.handle('app-load', () => ({ entries: [], phrases: [], notifications: [], flowBarMotion: 'reduced' }));
  const win = new BrowserWindow({
    show: false, width: 1120, height: 760,
    webPreferences: {
      preload: path.join(__dirname, '../src/preload.js'), contextIsolation: true,
      sandbox: false,
    },
  });
  const errors = [];
  win.webContents.on('console-message', event => {
    if ((event.level === 'error' || Number(event.level) >= 3)
      && !/Content-Security-Policy/.test(event.message)) errors.push(event.message);
  });
  await win.loadFile(path.join(__dirname, '../src/app.html'));
  const run = code => win.webContents.executeJavaScript(code);
  await run(`navigator.mediaDevices.getUserMedia = async () => { throw new Error('No test microphone'); };
    navigator.mediaDevices.enumerateDevices = async () => [];
    window.perfCalls = {};
    for (const name of ['renderStats', 'renderDictionary', 'renderInsights', 'renderSettings', 'renderFeed', 'buildDictRow', 'buildCard']) {
      const original = window[name];
      window[name] = function(...args) {
        const start = performance.now();
        const result = original.apply(this, args);
        const metric = perfCalls[name] || (perfCalls[name] = { count: 0, ms: 0 });
        metric.count++; metric.ms += performance.now() - start;
        return result;
      };
    }
    window.originalInsightsCompute = voxdenInsights.computeInsights;
    voxdenInsights.computeInsights = function(...args) {
      const metric = perfCalls.computeInsights || (perfCalls.computeInsights = { count: 0 });
      metric.count++;
      return originalInsightsCompute.apply(this, args);
    };
    window.makePerfData = (count, terms) => ({
      displayName: 'Test', shortcutLabel: 'Ctrl+Shift+Space', flowBarMotion: 'reduced',
      entries: Array.from({ length: count }, (_, i) => ({
        id: 'synthetic-' + i, ts: Date.now() - i * 1800000,
        text: 'A synthetic dictation for checking dashboard responsiveness. '.repeat(6) + i,
        durationMs: 24000, audio: false,
      })),
      phrases: Array.from({ length: terms }, (_, i) => ({ from: 'term' + i, to: 'Term' + i, source: i % 2 ? 'manual' : 'learned', kind: 'word' })),
      pendingPhrases: [], notifications: [], writingStyles: {},
    }); true`);
  win.showInactive();
  await pause(100);
  const reports = [];
  for (const [count, terms] of [[2000, 500], [10000, 1000]]) {
    reports.push(await run(`(() => {
      setView('dictation');
      window.perfData = makePerfData(${count}, ${terms});
      perfCalls = {};
      const first = performance.now(); render(perfData);
      const initialMs = performance.now() - first;
      perfCalls = {};
      const values = [];
      for (let i = 0; i < 8; i++) {
        const data = structuredClone(perfData); data.updateProgress = i;
        const start = performance.now(); render(data); values.push(performance.now() - start);
      }
      values.sort((a, b) => a - b);
      return { count: ${count}, terms: ${terms}, initialMs, medianUpdateMs: values[4], maxUpdateMs: values[7], calls: perfCalls, hidden: document.hidden };
    })()`));
  }
  const insights = await run(`(() => {
    setView('insights'); perfCalls = {};
    const values = [];
    for (let i = 0; i < 5; i++) {
      const data = structuredClone(perfData); data.updateProgress = i;
      const start = performance.now(); render(data); values.push(performance.now() - start);
    }
    setView('dictation');
    values.sort((a, b) => a - b);
    return { medianUpdateMs: values[2], maxUpdateMs: values[4], calls: perfCalls };
  })()`);
  win.hide();
  await pause(80);
  const hidden = await run(`(() => {
    perfCalls = {};
    const start = performance.now();
    let renderMs = 0;
    for (let i = 0; i < 5; i++) {
      const data = structuredClone(perfData);
      data.entries[0].text = 'Hidden update ' + i;
      const renderStart = performance.now();
      render(data);
      renderMs += performance.now() - renderStart;
    }
    return { totalMsIncludingClone: performance.now() - start, renderMs, hidden: document.hidden, calls: perfCalls };
  })()`);
  console.log(JSON.stringify({ baseline, reports, insights, hidden }, null, 2));
  if (!baseline) {
    assert.strictEqual(hidden.hidden, true, 'native hide changes document visibility');
    assert.strictEqual(hidden.calls.buildCard, undefined, 'hidden updates must not build history cards');
    assert.strictEqual(hidden.calls.buildDictRow, undefined, 'hidden updates must not build dictionary rows');
    for (const report of reports) {
      assert.strictEqual(report.calls.buildDictRow, undefined, 'unopened Dictionary must not build rows on unrelated updates');
      assert.strictEqual(report.calls.buildCard, undefined, 'unchanged history does not rebuild cards');
    }
    assert.strictEqual(insights.calls.computeInsights, undefined, 'unrelated updates reuse Insights calculations');
  }
  win.showInactive();
  await pause(100);
  if (!baseline) {
    assert.strictEqual(await run(`document.querySelector('.card .text').textContent`), 'Hidden update 4', 'show catches up to the latest snapshot');
    await run(`setView('dictionary'); window.firstDictionaryRow = dictListEl.firstElementChild; perfCalls = {}; render(structuredClone(lastPayload)); true`);
    assert.strictEqual(await run(`dictListEl.children.length`), 1000, 'opening Dictionary builds the deferred list');
    assert.strictEqual(await run(`dictListEl.firstElementChild === firstDictionaryRow`), true, 'unchanged dictionary preserves existing controls');
    assert.strictEqual(await run(`perfCalls.buildDictRow === undefined`), true, 'dictionary progress updates do not recreate rows');
    await run(`dictQuery = 'term998'; renderDictionary(); true`);
    assert.strictEqual(await run(`dictListEl.children.length`), 1, 'dictionary search invalidates the cached list');
    await run(`dictQuery = ''; dictTab = 'learned'; renderDictionary(); true`);
    assert.strictEqual(await run(`dictListEl.children.length`), 500, 'dictionary tab changes invalidate the cached list');
    await run(`dictTab = 'all'; lastPayload.phrases[0].to = 'Updated terminology'; render(lastPayload); true`);
    assert.strictEqual(await run(`dictListEl.firstElementChild.textContent.includes('Updated terminology')`), true, 'editing a term in the same snapshot invalidates its row');
    await run(`perfCalls = {}; lastPayload.entries[0].text = 'An update while Dictionary is open'; render(lastPayload); true`);
    assert.strictEqual(await run(`perfCalls.buildCard === undefined`), true, 'a hidden Dictation pane must not build history cards');
    await run(`setView('dictation'); true`);
    assert.strictEqual(await run(`document.querySelector('.card .text').textContent`), 'An update while Dictionary is open', 'returning to Dictation catches up');

    const metrics = await run(`(() => {
      const data = makePerfData(2, 0);
      data.entries[0].text = 'one two three four'; data.entries[0].durationMs = 2400;
      data.entries[1].text = 'five six seven eight'; data.entries[1].durationMs = 2400;
      render(data);
      const first = { words: statWordsEl.textContent, pace: dmAnim.wpm };
      // Preserve IDs and array length, just like a saved transcript correction.
      data.entries[0].text = 'one two three four five six seven eight'; render(data);
      const edited = { words: statWordsEl.textContent, pace: dmAnim.wpm };
      data.entries[0].durationMs = 4800; render(data);
      const duration = { pace: dmAnim.wpm };
      data.entries.pop(); render(data);
      const deleted = { words: statWordsEl.textContent, count: statNotesEl.textContent };
      const realNow = Date.now;
      let week;
      try {
        const now = realNow();
        Date.now = () => now;
        data.entries[0].ts = now - 7 * 24 * 3600 * 1000 + 10; render(data);
        const before = statWeekEl.textContent;
        Date.now = () => now + 11; render(structuredClone(data));
        week = { before, after: statWeekEl.textContent };
      } finally { Date.now = realNow; }
      return { first, edited, duration, deleted, week };
    })()`);
    assert.deepStrictEqual(metrics, {
      first: { words: '8', pace: 100 },
      edited: { words: '12', pace: 150 },
      duration: { pace: 100 },
      deleted: { words: '8', count: '1' },
      week: { before: '8', after: '0' },
    }, 'metrics remain correct after in-place edits, duration corrections, deletions, and rolling-week expiry');

    const insightsCases = await run(`(() => {
      const realNow = Date.now;
      const checked = [];
      try {
        const start = realNow();
        let now = start;
        Date.now = () => now;
        const data = makePerfData(2, 1);
        data.entries[0].original = data.entries[0].text;
        setView('insights');
        const check = label => {
          render(data);
          const expected = originalInsightsCompute(data.entries, data.phrases, insightsRange, now, { year: insightsYear });
          checked.push({ label, correct: JSON.stringify(insightsCache.result) === JSON.stringify(expected) });
        };
        check('initial');
        for (const [field, value] of Object.entries({
          text: 'Edited dictation text has different metrics', original: 'The original words', durationMs: 5000,
          category: 'work', exe: 'chrome.exe', title: 'ChatGPT', dictionaryHits: 4, styleFixes: 3,
          learnedPairs: [{ from: 'vox den', to: 'Voxden' }],
        })) { data.entries[0][field] = value; check('edit ' + field); }
        data.phrases.push({ from: 'new', to: 'New' }); check('dictionary count');
        data.understandingProfileName = 'Updated profile'; render(data);
        checked.push({ label: 'profile changes remain live with cached charts', correct: document.getElementById('ins-profile-name').textContent === 'Updated profile' });
        for (const [range, days] of [['7d', 7], ['30d', 30]]) {
          insightsRange = range; now = start;
          data.entries[0].ts = now - days * 24 * 3600 * 1000 + 10;
          check(range + ' before expiry'); now += 11; check(range + ' after expiry');
        }
        insightsRange = 'all';
        const midnight = new Date(start); midnight.setHours(24, 0, 0, 0);
        now = midnight.getTime() - 1; check('before midnight');
        now += 1; check('after midnight');
        now = start; check('clock moved backward');
        data.entries.pop(); check('delete history');
        return checked;
      } finally { Date.now = realNow; }
    })()`);
    assert(insightsCases.every(test => test.correct), 'cached Insights match fresh computation: ' + JSON.stringify(insightsCases));
    await run(`setView('dictation'); true`);

    win.hide();
    await pause(80);
    const newest = { entries: [{ id: 'last-ipc', ts: Date.now(), text: 'Latest actual IPC snapshot' }], phrases: [], notifications: [] };
    win.webContents.send('history-updated', newest);
    await pause(80);
    assert.strictEqual(await run(`lastPayload.entries[0].id`), 'last-ipc', 'hidden IPC still stores the latest application state');
    win.showInactive();
    await pause(100);
    assert.strictEqual(await run(`document.querySelector('.card .text').textContent`), 'Latest actual IPC snapshot', 'actual hidden IPC renders on native show');
  }
  assert.deepStrictEqual(errors, []);
  win.destroy();
  clearTimeout(timeout);
  console.log('Dashboard performance UI checks passed');
  app.exit(0);
}).catch(error => { console.error(error); clearTimeout(timeout); app.exit(1); });
