'use strict';

// Real renderer and preload, synthetic history/IPC, and an isolated profile.
// No real recordings, dictionary, user profile, or microphone are accessed.
const { app, BrowserWindow, ipcMain, session } = require('electron');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const metrics = require('../src/metrics');
const { computeInsights } = require('../src/insights');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'voxden-retention-ui-')));
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const deadline = setTimeout(() => { console.error('Retention UI test timed out'); app.exit(1); }, 45000);
const DAY = 24 * 3600 * 1000;
let now = Date.now();
let revision = 1;
let expiryMs = DAY;
const initialNow = now;
const previousYear = new Date(now).getFullYear() - 1;
const entries = Array.from({ length: 1250 }, (_, i) => ({
  id: 'fixture-' + i,
  ts: i < 1100 ? now - i * 3600000 : new Date(previousYear, 6, 1).getTime() - i * 3600000,
  text: 'Five words in this dictation',
  original: 'Five words in that dictation',
  // The newest trusted pace samples have already left retained history.
  durationMs: i < 1000 ? 500 : 3000,
  category: 'work', exe: 'notepad.exe', title: 'Notes', dictionaryHits: 1, styleFixes: 2,
  learnedPairs: i === 1200 ? [{ from: 'vox den', to: 'Voxden' }] : [],
}));
const phrases = [
  { from: 'vox den', to: 'Voxden', source: 'learned', kind: 'word' },
  { from: 'project name', to: 'Project Name', source: 'manual', kind: 'word' },
];
function stats() {
  return {
    revision, computedAt: now, expiresAt: now + expiryMs,
    dictations: entries.length,
    wordCount: entries.reduce((n, entry) => n + metrics.countWords(entry.text), 0),
    weekWords: entries.filter(entry => entry.ts >= now - 7 * DAY)
      .reduce((n, entry) => n + metrics.countWords(entry.text), 0),
    ...metrics.computeMetrics(entries),
    paceSamples: entries.filter(metrics.isPaceSample).slice(0, 8).map(entry => ({
      statsOnly: true, id: entry.id, ts: entry.ts,
      wordCount: metrics.countWords(entry.text), durationMs: entry.durationMs,
    })),
  };
}
function snapshot() {
  return {
    analyticsRevision: revision, usageStats: stats(), entries: entries.slice(0, 1000),
    phrases, pendingPhrases: [], notifications: [], flowBarMotion: 'reduced',
    understandingProfileName: 'Growing', understandingWordCount: 4200,
  };
}
const calls = { insights: [], stats: 0 };
let holdInsights = false;
let failInsights = false;
const pendingInsights = [];
let holdStats = false;
const pendingStats = [];

app.whenReady().then(async () => {
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, done) => done(false));
  ipcMain.handle('app-load', snapshot);
  ipcMain.handle('history-stats', async () => {
    calls.stats++;
    const reply = stats();
    if (holdStats) await new Promise(resolve => pendingStats.push(resolve));
    return reply;
  });
  ipcMain.handle('history-insights', async (_event, options) => {
    calls.insights.push({ ...options, revision });
    const reply = {
      revision, computedAt: now, expiresAt: now + expiryMs,
      result: computeInsights(entries, phrases, options.range, now, { year: options.year }),
    };
    if (holdInsights) await new Promise(resolve => pendingInsights.push(resolve));
    if (failInsights) throw new Error('Synthetic unavailable statistics');
    return reply;
  });
  const win = new BrowserWindow({
    show: false, width: 1120, height: 760,
    webPreferences: { preload: path.join(__dirname, '../src/preload.js'), contextIsolation: true,
      sandbox: false },
  });
  const errors = [];
  win.webContents.on('console-message', event => {
    if ((event.level === 'error' || Number(event.level) >= 3)
      && !/Content-Security-Policy/.test(event.message)) errors.push(event.message);
  });
  await win.loadFile(path.join(__dirname, '../src/app.html'));
  const run = code => win.webContents.executeJavaScript(code);
  const waitFor = async (code, message) => {
    const until = Date.now() + 4000;
    while (Date.now() < until) {
      if (await run(code)) return;
      await pause(20);
    }
    throw new Error(message + ': ' + code);
  };
  const setClock = async value => {
    now = value;
    await run(`window.fixtureNow = ${now}; true`);
  };
  const broadcast = async () => {
    win.webContents.send('history-updated', snapshot());
    await waitFor(`lastPayload && lastPayload.analyticsRevision === ${revision}`, 'snapshot delivery');
  };
  await run(`window.fixtureNow = ${now}; Date.now = () => fixtureNow;
    navigator.mediaDevices.getUserMedia = async () => { throw new Error('No test microphone'); };
    navigator.mediaDevices.enumerateDevices = async () => [];
    window.localInsightCalls = 0;
    const localCompute = voxdenInsights.computeInsights;
    voxdenInsights.computeInsights = function(...args) { localInsightCalls++; return localCompute(...args); };
    true`);
  win.showInactive();
  await waitFor('!document.hidden && statNotesEl.textContent === "1,250"', 'lifetime dashboard count');
  assert.deepStrictEqual(await run(`({ words: statWordsEl.textContent, count: statNotesEl.textContent,
    pace: dmAnim.wpm, retained: lastPayload.entries.length })`), {
    words: '6,250', count: '1,250', pace: 100, retained: 1000,
  }, 'dashboard includes archived statistics without their transcripts');

  await run(`setView('dictionary'); true`);
  assert.strictEqual(await run('dictListEl.children.length'), 2, 'dictionary remains available');
  await run(`setView('insights'); true`);
  await waitFor(`document.getElementById('ins-summary-sessions').textContent === '1,250'`, 'server Insights');
  assert.strictEqual(await run(`document.getElementById('ins-summary-words').textContent`), '6,250');
  assert.strictEqual(await run(`document.getElementById('ins-fix-dict').textContent`), '1,250');
  assert.strictEqual(await run('localInsightCalls'), 0, 'capped entries must never compute lifetime Insights');
  const initialCalls = calls.insights.length;
  await run(`render(structuredClone(lastPayload)); render(structuredClone(lastPayload)); true`);
  assert.strictEqual(calls.insights.length, initialCalls, 'unchanged broadcasts reuse server Insights');
  assert.strictEqual(await run(`document.getElementById('ins-years').children.length`), 2, 'archived years remain selectable');

  // A slower range request must not replace a newer selection's result.
  holdInsights = true;
  await run(`insightsRange = '7d'; renderInsights(null); true`);
  await waitFor('serverInsightsRequest && serverInsightsRequest.range === "7d"', '7-day request');
  while (pendingInsights.length < 1) await pause(10);
  await run(`insightsRange = '30d'; renderInsights(null); true`);
  while (pendingInsights.length < 2) await pause(10);
  holdInsights = false;
  pendingInsights[1]();
  const expected30 = computeInsights(entries, phrases, '30d', now, { year: new Date(now).getFullYear() });
  await waitFor(`document.getElementById('ins-summary-sessions').textContent === ${JSON.stringify(expected30.volume.dictations.toLocaleString())}`, '30-day result');
  const settled30 = await run(`document.getElementById('ins-subtitle').textContent`);
  pendingInsights[0]();
  pendingInsights.length = 0;
  await pause(60);
  assert.strictEqual(await run(`document.getElementById('ins-subtitle').textContent`), settled30, 'late range reply is ignored');

  await run(`insightsYear = ${previousYear}; renderInsights(null); true`);
  await waitFor(`document.querySelector('#ins-years .is-active').textContent === '${previousYear}'`, 'archived year result');
  assert.strictEqual(await run(`document.getElementById('ins-ms-copy').textContent.includes('150 dictations')`), true, 'archived milestone totals remain exact');

  // In-flight answers cannot resurrect a stale analytics revision.
  holdInsights = true;
  await run(`insightsRange = '7d'; renderInsights(null); true`);
  while (pendingInsights.length < 1) await pause(10);
  revision++;
  entries[0].text = 'A corrected retained transcript now contains eight words';
  await broadcast();
  while (pendingInsights.length < 2) await pause(10);
  holdInsights = false;
  pendingInsights[1]();
  await waitFor(`serverInsightsCache.has(serverInsightsKey(lastPayload, insightsRange, insightsYear))`, 'new revision result');
  pendingInsights[0]();
  pendingInsights.length = 0;
  await pause(60);
  assert.strictEqual(await run(`serverInsightsCache.get(serverInsightsKey(lastPayload, insightsRange, insightsYear)).reply.revision`), revision);

  // Refresh at a live time boundary without receiving any history broadcast.
  revision++;
  expiryMs = 100;
  await broadcast();
  await waitFor(`serverInsightsCache.has(serverInsightsKey(lastPayload, insightsRange, insightsYear))`, 'short-lived cache');
  const beforeExpiry = calls.insights.length;
  await setClock(now + 101);
  expiryMs = DAY;
  await waitFor(`serverInsightsCache.get(serverInsightsKey(lastPayload, insightsRange, insightsYear)).reply.computedAt === ${now}`, 'visible Insights time expiry');
  assert(calls.insights.length > beforeExpiry, 'visible Insights reloaded automatically at expiry');

  // A pending request for a pane selection that was abandoned must not delay
  // the time boundary of the cached selection the user returned to.
  revision++;
  expiryMs = 100;
  await broadcast();
  await waitFor(`serverInsightsCache.has(serverInsightsKey(lastPayload, insightsRange, insightsYear))`, 'cache before temporary range');
  holdInsights = true;
  await run(`insightsRange = '30d'; renderInsights(null); true`);
  while (pendingInsights.length < 1) await pause(10);
  await run(`insightsRange = '7d'; renderInsights(null); true`);
  holdInsights = false;
  expiryMs = DAY;
  await setClock(now + 101);
  await waitFor(`serverInsightsCache.get(serverInsightsKey(lastPayload, insightsRange, insightsYear)).reply.computedAt === ${now}`, 'expiry with another range pending');
  pendingInsights.shift()();
  await pause(40);

  // Failed IPC leaves authoritative numbers intact and never falls back to the
  // retained list. A later retry can recover without a new history snapshot.
  failInsights = true;
  revision++;
  await broadcast();
  await waitFor(`document.getElementById('ins-subtitle').textContent.includes('could not be refreshed')`, 'Insights failure feedback');
  assert.strictEqual(await run('localInsightCalls'), 0, 'failed server request cannot produce truncated Insights');
  failInsights = false;
  await setClock(now + 5001);
  await run('scheduleAnalyticsRefresh(); true');
  await waitFor(`serverInsightsCache.has(serverInsightsKey(lastPayload, insightsRange, insightsYear))`, 'Insights error recovery');

  // Clock rollback and timezone changes invalidate an otherwise unexpired
  // server result. Timezone is simulated only in this isolated renderer.
  const beforeRollback = calls.insights.length;
  await setClock(initialNow - DAY);
  await run('renderInsights(null); true');
  await waitFor(`serverInsightsCache.get(serverInsightsKey(lastPayload, insightsRange, insightsYear)).reply.computedAt === ${now}`, 'clock rollback refresh');
  assert(calls.insights.length > beforeRollback);
  const beforeTimezone = calls.insights.length;
  await run(`window.originalAnalyticsTimezone = analyticsTimezone;
    analyticsTimezone = () => originalAnalyticsTimezone() + '|fixture'; renderInsights(null); true`);
  await waitFor(`serverInsightsCache.get(serverInsightsKey(lastPayload, insightsRange, insightsYear)).timezone.endsWith('|fixture')`, 'timezone refresh');
  assert(calls.insights.length > beforeTimezone);
  await run('analyticsTimezone = originalAnalyticsTimezone; true');

  await run(`setView('dictation'); true`);
  await waitFor(`serverStatsCache.stats.computedAt === ${now}`, 'dashboard clock rollback');
  revision++;
  expiryMs = 100;
  await broadcast();
  const beforeStatsExpiry = calls.stats;
  holdStats = true;
  await setClock(now + 101);
  expiryMs = DAY;
  await waitFor('serverStatsRequest !== null', 'dashboard time refresh');
  while (pendingStats.length < 1) await pause(10);
  revision++;
  entries[0].text = 'new words';
  await broadcast();
  const expectedWords = stats().wordCount.toLocaleString();
  await waitFor(`statWordsEl.textContent === ${JSON.stringify(expectedWords)}`, 'new revision dashboard stats');
  holdStats = false;
  pendingStats.shift()();
  await pause(60);
  assert.strictEqual(await run('statWordsEl.textContent'), expectedWords, 'late stats response cannot replace a new revision');
  assert(calls.stats > beforeStatsExpiry, 'dashboard refreshes at live expiry');

  // Tray/hidden state does no periodic work and catches up on native show.
  await run(`setView('insights'); true`);
  await waitFor('serverInsightsRequest === null', 'settled before hiding');
  win.hide();
  await waitFor('document.hidden', 'native hidden state');
  const hiddenCalls = calls.insights.length;
  await setClock(now + 2 * DAY);
  await pause(120);
  assert.strictEqual(calls.insights.length, hiddenCalls, 'hidden window does not refresh Insights');
  win.showInactive();
  await waitFor(`serverInsightsCache.get(serverInsightsKey(lastPayload, insightsRange, insightsYear)).reply.computedAt === ${now}`, 'show refreshes expired Insights');
  assert.strictEqual(await run('localInsightCalls'), 0);
  assert.deepStrictEqual(errors, [], 'renderer has no errors');
  win.destroy();
  clearTimeout(deadline);
  console.log('History retention UI checks passed');
  app.exit(0);
}).catch(error => { console.error(error); clearTimeout(deadline); app.exit(1); });
