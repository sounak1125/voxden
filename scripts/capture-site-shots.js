'use strict';

// Marketing screenshots for the website in site/.
//
// Same fixture approach as the UI tests (test-speech-ui.js, test-flow-styles-ui.js):
// a throwaway Electron profile, the real src/app.html and src/overlay.html loaded
// into offscreen BrowserWindows over the real preload bridge, and a stand-in main
// process that answers every IPC channel with a scripted snapshot. Nothing under
// src/ is touched and no engine, microphone or account service is opened.
//
// Pixels come from CDP rather than capturePage(): Emulation.setDeviceMetricsOverride
// pins the layout viewport and the device scale factor, so the output is exactly
// 2x the CSS size on any display, and Page.captureScreenshot keeps the overlay's
// alpha channel and can clip tight to the flow bar.
//
//   npx electron scripts/capture-site-shots.js
//
// Writes site/assets/img/{dashboard-dictation,dashboard-dictionary,
// dashboard-writing-style,dashboard-insights,flow-bar-recording,flow-bar-idle,
// signin-gate}.png, and a content-panel crop of each of the four dashboard
// shots as dashboard-*-panel.png.

const { app, BrowserWindow, ipcMain, nativeImage } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src');
const OUT = path.join(__dirname, '..', 'site', 'assets', 'img');
const SCALE = 2;
const SETTLE_MS = 1500; // Hidden-window captures otherwise show transition start values.

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'voxden-site-shots-')));
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Without this, an unhandled throw in the main process opens a modal error box
// that no one is watching and the run hangs instead of failing.
process.on('uncaughtException', (error) => { console.error(error); app.exit(1); });
process.on('unhandledRejection', (error) => { console.error(error); app.exit(1); });
const deadline = setTimeout(() => { console.error('Site screenshots timed out'); app.exit(1); }, 180000);
const errors = [];
const written = [];

// --- The scripted snapshot -------------------------------------------------
// Everything the renderer paints comes from here, so the shots are the same on
// every machine. The name is a stand-in, never a real person.

const DAY = 86400000;
const now = Date.now();
const at = (h, m, dayOffset = 0) => {
  const d = new Date(now - dayOffset * DAY);
  d.setHours(h, m, 0, 0);
  return d.getTime();
};

const entries = [
  { id: 'e1', ts: at(10, 12), durationMs: 24000, audio: true,
    text: 'Ship the Qwen3-ASR notes to the team before standup, and flag that the GPU path is now the default on machines that have one.' },
  { id: 'e2', ts: at(9, 48), durationMs: 17000, audio: true,
    text: 'Reply to Priya: the Thursday trip is confirmed for the fourteenth, I will send the itinerary once the tickets are booked.' },
  { id: 'e3', ts: at(9, 5), durationMs: 31000, audio: true,
    text: 'Draft for the changelog. Dictation now warms the cloud model the moment you start recording, so short clips come back in well under a second instead of waiting on a cold start.' },
  { id: 'e4', ts: at(17, 26, 1), durationMs: 12000, audio: true,
    text: 'Remind me to compare the Parakeet and Whisper turbo transcripts on the same recording tomorrow morning.' },
  { id: 'e5', ts: at(16, 2, 1), durationMs: 21000, audio: false,
    text: 'Note to self. The flow bar should stay completely still when idle. Any continuous animation on a transparent window costs about a fifth of a core.' },
  { id: 'e6', ts: at(11, 39, 2), durationMs: 15000, audio: false,
    text: 'Yes, that works for me. Thursday at four, and I will bring the numbers from the last two weeks.' },
];

// --- A worked-in history, for the Insights page only -----------------------
// The dictation feed reads best with the six hand-written entries above, so
// those stay exactly as they are. Insights, though, computes everything it
// draws -- pace, time saved, the streak, the seventeen-week heatmap, the app
// leaderboard, the fix counts -- from the same entry list, and six entries in
// two days leave every card near-empty. These fill twelve weeks behind them.
//
// src/insights.js reads ts, text, original, durationMs, exe, title, category,
// dictionaryHits, styleFixes and learnedPairs, so each generated entry carries
// all of them. The generator is seeded, so the draw order never varies: two
// runs on the same day produce byte-identical history, and a run on another day
// only shifts it by the calendar (which days fall on a weekend, and today's
// date), never into a different shape.

const INSIGHT_APPS = [
  { weight: 5, exe: 'slack.exe', title: 'Slack | #product', category: 'work', lines: [
    'Pushed the fix for the sidebar flicker, it turned out to be a stale layout read on resize.',
    'Standup notes are in the shared doc, the only blocker left is the signing certificate.',
    'I can take the release build this week if nobody else has already picked it up.',
    'Can we move the review to Thursday, the numbers will be a lot cleaner by then.',
    'The cold start is gone now that we warm the model the moment recording begins.',
    'Nice catch on the duplicate handler, I have pulled it out and the tests still pass.',
  ] },
  { weight: 4, exe: 'chrome.exe', title: 'Inbox - Gmail', category: 'email', lines: [
    'Thanks for the quick turnaround, I have signed the revised agreement and sent it back.',
    'Attaching last month invoice, let me know straight away if anything looks off to you.',
    'Happy to join on Wednesday morning, please send over the agenda whenever it is ready.',
    'Following up on my note from last week, no rush at all, whenever suits you best.',
    'We have shipped the update, so the crash you reported should not come back again.',
  ] },
  { weight: 3, exe: 'chrome.exe', title: 'ChatGPT', category: 'work', lines: [
    'Explain the difference between a rolling window and a calendar month for a billing report.',
    'Rewrite this paragraph so it is about half the length and keeps the second sentence intact.',
    'Give me three ways to cache a computed result that has to expire at midnight local time.',
    'Summarise these release notes into a single sentence a customer would actually read.',
  ] },
  { weight: 3, exe: 'Code.exe', title: 'app.js - voxden - Visual Studio Code', category: 'work', lines: [
    'Add a guard so the cache expires at the next calendar day boundary instead of after an hour.',
    'Refactor this helper to take the entry list rather than the whole payload object.',
    'Write a test that covers the case where the duration is missing but the words are there.',
    'Rename this variable so it says what it holds, the current name reads like a flag.',
  ] },
  { weight: 2, exe: 'outlook.exe', title: 'Inbox - Outlook', category: 'email', lines: [
    'Confirming the call for the fourteenth at four, I will send a calendar invite shortly.',
    'The revised quote is attached, it now includes the support hours we talked through.',
    'Apologies for the slow reply, I was away last week and I am catching up today.',
  ] },
  { weight: 2, exe: 'Notion.exe', title: 'Roadmap - Notion', category: 'work', lines: [
    'Roadmap update, the streaming relay lands once the account service is live in production.',
    'Moving the dictionary rework into next month, the insights page took longer than planned.',
    'Decision logged, we stay on the local model by default and offer cloud as a choice.',
  ] },
  { weight: 2, exe: 'WhatsApp.exe', title: 'WhatsApp', category: 'personal', lines: [
    'Picking up groceries on the way home, tell me if we need anything beyond the usual.',
    'The trek is booked for the long weekend, I will send the packing list tonight.',
    'Running about ten minutes late, start without me and I will catch up when I get there.',
    'That photo came out lovely, send me the full size one when you get a chance.',
  ] },
];

const INSIGHT_ENTRIES = (() => {
  // A tiny linear congruential generator, seeded once. Deterministic by design.
  let seed = 20260915;
  const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const pick = (list) => list[Math.floor(rand() * list.length)];

  const slots = [];
  for (const target of INSIGHT_APPS) for (let i = 0; i < target.weight; i++) slots.push(target);

  // Which days have activity. The last nine days are unbroken, so the streak
  // card and the heatmap's highlighted run both have something to show; the
  // weeks before that thin out the way real use does.
  const days = [];
  for (let d = 0; d <= 8; d++) days.push(d);
  for (let d = 10; d <= 82; d++) {
    const weekday = new Date(now - d * DAY).getDay();
    const chance = weekday === 0 || weekday === 6 ? 0.18 : 0.42;
    if (rand() < chance) days.push(d);
  }

  const out = [];
  for (const day of days) {
    const count = day <= 8 ? 2 + Math.floor(rand() * 2) : 1 + Math.floor(rand() * 2);
    for (let i = 0; i < count; i++) {
      const target = pick(slots);
      const sentences = 2 + Math.floor(rand() * 4);
      const lines = [];
      for (let s = 0; s < sentences; s++) lines.push(pick(target.lines));
      const text = lines.join(' ');
      const words = text.trim().split(/\s+/).length;
      // 105-140 words per minute, which is an unremarkable speaking pace.
      const wpm = 105 + rand() * 35;
      const hour = 9 + Math.floor(rand() * 10);
      const minute = Math.floor(rand() * 60);
      const entry = {
        id: 'h' + out.length,
        ts: at(hour, minute, day),
        durationMs: Math.round((words / wpm) * 60000),
        audio: false,
        text,
        original: text,
        exe: target.exe,
        title: target.title,
        category: target.category,
        dictionaryHits: rand() < 0.45 ? 1 + Math.floor(rand() * 2) : 0,
        styleFixes: Math.floor(rand() * 5),
      };
      // Roughly one dictation in six was corrected afterwards, which is what
      // "transcripts you edited" and the learned spellings are counted from.
      if (rand() < 0.16) {
        entry.original = text.replace('Voxden', 'vox den').replace('the', 'teh');
        entry.learnedPairs = [{ from: 'vox den', to: 'Voxden' }];
      }
      out.push(entry);
    }
  }
  return out.sort((a, b) => b.ts - a.ts);
})();

const phrases = [
  { from: 'Voxden', to: 'Voxden', kind: 'word', source: 'manual' },
  { from: 'Postgres', to: 'Postgres', kind: 'word', source: 'manual' },
  { from: 'Figma', to: 'Figma', kind: 'word', source: 'manual' },
  { from: 'Standup', to: 'Standup', kind: 'word', source: 'manual' },
  { from: 'vox den', to: 'Voxden', kind: 'mapping', source: 'learned' },
  { from: 'post gress', to: 'Postgres', kind: 'mapping', source: 'learned' },
  { from: 'stand up notes', to: 'Standup notes', kind: 'mapping', source: 'learned' },
];

const account = {
  signedIn: true, email: 'sam@example.com', plan: 'pro', planExpiresAt: '2027-01-01T00:00:00.000Z',
  cloud: { hoursUsed: 1.25, hoursCap: 15, creditsUsed: 118, creditsCap: 900, periodEnd: '2026-10-01T00:00:00.000Z' },
  checkedAt: now, stale: false, busy: '', lastError: '', tokenProtected: true,
  profile: { firstName: 'Sam', lastName: '', pictureUrl: '' },
  auth: { google: true, googleClientId: 'site-shots' },
};

const signedOutAccount = {
  signedIn: false, email: '', pendingEmail: '', plan: 'free', planExpiresAt: null,
  cloud: { hoursUsed: 0, hoursCap: 0, periodEnd: null }, checkedAt: now, stale: false,
  busy: '', lastError: '', tokenProtected: true, auth: { google: true, googleClientId: 'site-shots' },
};

const base = {
  version: '2.1.1',
  displayName: 'Sam',
  entries,
  phrases,
  pendingPhrases: [],
  notifications: [],
  // One tone per writing context, so the Writing style page shows a real
  // choice rather than an untouched page: Work is the context it opens on and
  // Casual is the tone selected there.
  writingStyles: { personal: 'veryCasual', work: 'casual', email: 'formal', other: 'casual' },
  verbatimMode: false,
  verbatimDictionary: true,
  autoCleanup: true,
  numbersAsDigits: true,
  autoSend: {},
  account,
  signInRequired: false,
  sidebarCollapsed: false,
  shortcut: 'CommandOrControl+Shift+Space',
  shortcutLabel: 'Ctrl+Shift+Space',
  pasteLastShortcutLabel: 'Ctrl+Shift+V',
  dictateMode: 'toggle',
  dictationQuality: 'balanced',
  dictationLanguages: ['en'],
  suggestionsEnabled: true,
  autoAddDictionary: true,
  variantCount: 12,
  // A voice profile part-way along reads better than a fresh 0%.
  understandingPercent: 62,
  understandingProfile: 'personalized',
  understandingProfileName: 'Personalized',
  understandingNextProfileName: 'Attuned',
  understandingCopy: 'Fix a misspelled word in a transcript. Voxden saves that spelling for next time.',
  understandingGoal: 2500,
  wordCount: 1560,
  // A healthy install: nothing to download, so no setup banner and no welcome.
  localModelChosen: true,
  asrEngine: 'qwen3-asr',
  asrDevice: 'auto',
  engineStatus: 'standby',
  asrEngineError: '',
  asrRuntimeWouldHelp: false,
  asrRuntime: { installed: true, bundled: true, downloadBytes: 0 },
  asrModel: { installed: true, downloadBytes: 0 },
  asrRuntimeState: { status: 'idle' },
  cloudTranscription: false,
  speechModels: { installed: true, downloadBytes: 0, packs: [] },
  modelPlan: require('../src/model-plan').plan({
    engine: 'qwen3-asr', device: 'auto', language: 'en',
    sizes: { whisper: 3.1e9, 'whisper-turbo': 1.62e9, 'qwen3-asr': 4.7e9, parakeet: 0.66e9 },
    installed: { 'qwen3-asr': true },
  }),
  flowBarStyle: 'classic',
  alwaysShowFlowBar: true,
  soundsEnabled: false,
};

// The Insights page is the one view that needs the long history behind it.
// Broadcasting this instead of folding it into `base` keeps the Dictation feed
// -- and therefore dashboard-dictation.png -- exactly as it was.
const insightsSnapshot = {
  ...base,
  entries: [...entries, ...INSIGHT_ENTRIES].sort((a, b) => b.ts - a.ts),
};

let snapshot = { ...base };

// Every channel the preload can invoke, answered from the snapshot so nothing
// rejects into the console and no real service is contacted.
const handled = new Set();
const handle = (channel, reply) => { handled.add(channel); ipcMain.handle(channel, reply); };
handle('app-load', () => snapshot);
handle('settings-set', (_e, patch) => (snapshot = { ...snapshot, ...patch }));
handle('history-stats', () => null);
handle('history-insights', () => ({ ok: false }));
handle('history-audio', () => ({ ok: false }));
handle('update-check', () => ({ ok: true, status: 'current' }));
for (const channel of [
  'account-auth-options', 'account-billing', 'account-billing-options', 'account-cancel',
  'account-cancel-subscription', 'account-checkout', 'account-code', 'account-delete', 'account-google',
  'account-google-cancel', 'account-manage-billing', 'account-refresh', 'account-sign-out',
  'account-update-profile', 'account-verify', 'asr-runtime-cancel', 'asr-runtime-install',
  'asr-runtime-remove', 'cuda-pack-cancel', 'cuda-pack-install', 'cuda-pack-remove', 'dict-auto-undo',
  'dict-delete', 'dict-pending-accept', 'dict-pending-dismiss', 'dict-upsert', 'feedback-open-issue',
  'feedback-send', 'flow-bar-reset', 'history-audio-save', 'history-copy', 'history-delete',
  'history-edit', 'history-retry', 'local-model-setup', 'notifications-clear', 'notifications-dismiss',
  'notifications-read', 'park-audio', 'qwen-accel-cancel', 'qwen-accel-info', 'qwen-accel-install',
  'qwen-accel-remove', 'qwen-accel-retry', 'recordings-clear', 'retry-last', 'speech-model-install',
  'speech-model-remove', 'toggle', 'training-clear', 'transcribe-local', 'update-install',
]) {
  if (!handled.has(channel)) handle(channel, () => snapshot);
}

// --- Capture plumbing ------------------------------------------------------

function watch(win, label) {
  win.webContents.on('render-process-gone', (_e, details) => errors.push(label + ': renderer gone (' + details.reason + ')'));
  win.webContents.on('console-message', (event, level, message) => {
    const severity = event.level === undefined ? level : event.level;
    const text = event.message === undefined ? message : event.message;
    if ((severity === 'error' || Number(severity) >= 3) && !/Content-Security-Policy/.test(String(text))) {
      errors.push(label + ': ' + String(text));
    }
  });
}

function windowOptions(width, height, extra) {
  return {
    show: false, width, height, useContentSize: true,
    webPreferences: {
      preload: path.join(SRC, 'preload.js'), contextIsolation: true, sandbox: false,
      backgroundThrottling: false, offscreen: true,
    },
    ...(extra || {}),
  };
}

// Pins the layout viewport and DPR so the PNG is exactly `SCALE`x the CSS size,
// whatever the display this runs on is scaled to.
async function emulate(win, width, height, transparent) {
  const dbg = win.webContents.debugger;
  if (!dbg.isAttached()) dbg.attach('1.3');
  if (transparent) {
    await dbg.sendCommand('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
  }
  await dbg.sendCommand('Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: SCALE, mobile: false,
  });
}

// Tearing a window down while its DevTools session is still attached and the
// renderer still has queued callbacks crashes V8 on the way out ("Invoke in
// DisallowJavascriptExecutionScope", exit code 3) -- reliably enough once the
// Insights page, with its rebuilt heatmap and count-up frames, is in the run.
// Detach, drop the listeners, and let the loop turn once before moving on.
async function close(win) {
  const dbg = win.webContents.debugger;
  if (dbg.isAttached()) dbg.detach();
  win.webContents.removeAllListeners('console-message');
  win.webContents.removeAllListeners('render-process-gone');
  win.destroy();
  await pause(300);
}

async function shoot(win, name, clip) {
  const dbg = win.webContents.debugger;
  const options = { format: 'png', fromSurface: true, captureBeyondViewport: !!clip };
  if (clip) options.clip = { ...clip, scale: 1 };
  const reply = await dbg.sendCommand('Page.captureScreenshot', options);
  const buffer = Buffer.from(reply.data, 'base64');
  const file = path.join(OUT, name + '.png');
  fs.writeFileSync(file, buffer);
  written.push({
    name: name + '.png',
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
    alpha: buffer[25] === 6 || buffer[25] === 4,
    bytes: buffer.length,
  });
  return file;
}

// --- The seven shots -------------------------------------------------------

async function captureApp() {
  const win = new BrowserWindow(windowOptions(1200, 780));
  watch(win, 'app');
  await win.loadFile(path.join(SRC, 'app.html'));
  const run = (code) => win.webContents.executeJavaScript(code);
  await emulate(win, 1200, 780, false);
  await pause(SETTLE_MS);

  if (await run('document.hidden')) throw new Error('The app window reports itself hidden; its views refuse to render.');
  await run('document.getElementById("model-welcome").open ? document.getElementById("model-welcome").close() : 0; true');

  // 1. Dictation page. Blur so no control carries a stray focus ring.
  await run('setView("dictation"); document.activeElement && document.activeElement.blur(); true');
  await pause(SETTLE_MS);
  await shoot(win, 'dashboard-dictation');

  // 2. Dictionary page.
  await run('setView("dictionary"); document.activeElement && document.activeElement.blur(); true');
  await pause(SETTLE_MS);
  await shoot(win, 'dashboard-dictionary');

  // 3. Writing style page, with Work selected and its Casual tone applied to
  // the live preview. The paper scene tilts toward the pointer and setView only
  // clears that tilt on the way OUT of this page, so clear it here as well --
  // an offscreen window has no pointer, and a leftover tilt would be a lie.
  await run('setView("writing-style"); resetWritingLook(); document.activeElement && document.activeElement.blur(); true');
  await pause(SETTLE_MS);
  const styleText = await run('document.getElementById("style-preview-output").textContent.trim()');
  if (!styleText) throw new Error('The writing style preview rendered no text.');
  await shoot(win, 'dashboard-writing-style');

  // 4. Insights page, over the long history. Opening the pane plays a count-up
  // and a card reveal; both are driven by requestAnimationFrame and CSS, and a
  // hidden window is a poor place to wait one out. Rendering a second time --
  // the reveal flag is spent by then -- writes every final value outright.
  snapshot = insightsSnapshot;
  win.webContents.send('history-updated', snapshot);
  await pause(600);
  await run('setView("insights"); document.activeElement && document.activeElement.blur(); true');
  await pause(SETTLE_MS);
  await run('renderInsights(null); true');
  await pause(600);
  const insWords = await run('document.getElementById("ins-summary-words").textContent.trim()');
  if (!insWords || insWords === '0') throw new Error('The insights page reported no words: ' + insWords);
  if (!(await run('document.getElementById("ins-leaderboard").children.length'))) {
    throw new Error('The insights app leaderboard is empty.');
  }
  await shoot(win, 'dashboard-insights');

  // 5. The sign-in gate, as a fresh install shows it: Google offered, email below.
  // Back to Dictation first, so the blurred backdrop is the page a new install
  // would have behind the gate rather than whichever one was shot last.
  snapshot = { ...base };
  win.webContents.send('history-updated', snapshot);
  await run('setView("dictation"); true');
  await pause(600);
  snapshot = { ...base, signInRequired: true, account: signedOutAccount, displayName: '' };
  win.webContents.send('history-updated', snapshot);
  await pause(SETTLE_MS);
  if (!(await run('document.getElementById("signin-gate").open'))) throw new Error('The sign-in gate did not open.');
  if (await run('document.getElementById("signin-google").hidden')) throw new Error('Google sign-in is not offered.');
  await run('document.activeElement && document.activeElement.blur(); true');
  await pause(400);
  await shoot(win, 'signin-gate');

  await close(win);
}

async function captureFlowBar() {
  const width = 320;
  const height = 140;
  const win = new BrowserWindow(windowOptions(width, height, { frame: false, transparent: true }));
  watch(win, 'overlay');
  await win.loadFile(path.join(SRC, 'overlay.html'));
  const run = (code) => win.webContents.executeJavaScript(code);
  await emulate(win, width, height, true);
  // No microphone is ever opened: the meter is driven with synthetic levels.
  await run(`navigator.mediaDevices.getUserMedia = async () => { throw new Error('Screenshots never open a microphone'); };
    soundsEnabled = false; alwaysShowFlowBar = true;
    document.body.classList.remove('entering', 'hiding');
    document.body.classList.add('shown');
    true`);

  // 6. Recording, with a shaped waveform. stopWaveLoop() hands the meter over
  // so updateWave can be stepped to a repeatable frame instead of whatever the
  // animation loop happened to be on.
  await run(`setHud('recording'); stopWaveLoop(); resetWave();
    for (let frame = 0; frame < 96; frame++) updateWave(1 / 60, .018, null);
    true`);
  await pause(SETTLE_MS);
  // The pill morphs between shapes, so both states share the recording state's
  // box. Both PNGs are then the same size with the pill centred, which lets the
  // site swap one for the other without the layout moving.
  const clip = await pillClip(run);
  await shoot(win, 'flow-bar-recording', clip);

  // 7. Idle, at rest: no pointer over it, no dictation running.
  await run(`setHud('idle'); onCursor({ hover: false }); true`);
  await pause(SETTLE_MS);
  await shoot(win, 'flow-bar-idle', clip);

  await close(win);
}

// --- The content-panel crops -----------------------------------------------
// The product tour shows the page, not the chrome around it: everything right
// of the sidebar and below the title bar. One box serves all four dashboard
// shots, so the site can swap one for another without the frame moving.
//
// The numbers are device pixels of the 2400x1560 capture, and they are the box
// the first dashboard-dictionary-panel.png was cut with -- fractions .183/.085
// of the way in from the left and top, .985/.883 to the right and bottom edges
// -- kept as pixels here so the crop cannot drift by a rounding rule.
const PANEL = { x: 439, y: 132, width: 1925, height: 1245 };

function cropPanel(name) {
  const source = path.join(OUT, name + '.png');
  const image = nativeImage.createFromBuffer(fs.readFileSync(source));
  const size = image.getSize();
  if (size.width !== 1200 * SCALE || size.height !== 780 * SCALE) {
    throw new Error(name + '.png is ' + size.width + 'x' + size.height
      + ', not ' + (1200 * SCALE) + 'x' + (780 * SCALE) + '; the panel box would land elsewhere.');
  }
  const buffer = image.crop(PANEL).toPNG();
  const file = path.join(OUT, name + '-panel.png');
  fs.writeFileSync(file, buffer);
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (width !== PANEL.width || height !== PANEL.height) {
    throw new Error(name + '-panel.png came out ' + width + 'x' + height + '.');
  }
  written.push({
    name: name + '-panel.png', width, height,
    alpha: buffer[25] === 6 || buffer[25] === 4, bytes: buffer.length,
  });
}

// The pill plus ~24px, which is enough room for its glow and shadow. Rounded
// out so the clip lands on whole device pixels.
async function pillClip(run) {
  const pad = 24;
  const rect = await run(`(() => { const r = document.getElementById('pill').getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`);
  const x = Math.max(0, Math.floor(rect.x - pad));
  const y = Math.max(0, Math.floor(rect.y - pad));
  return { x, y, width: Math.ceil(rect.x + rect.width + pad) - x, height: Math.ceil(rect.y + rect.height + pad) - y };
}

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  await captureApp();
  await captureFlowBar();
  for (const page of ['dictation', 'dictionary', 'writing-style', 'insights']) {
    cropPanel('dashboard-' + page);
  }
  for (const shot of written) {
    console.log(shot.name.padEnd(34), (shot.width + 'x' + shot.height).padEnd(12),
      (shot.bytes / 1024).toFixed(0) + ' KB', shot.alpha ? 'RGBA' : 'RGB');
  }
  if (errors.length) {
    console.error('Renderer errors:\n  ' + errors.join('\n  '));
    clearTimeout(deadline);
    app.exit(1);
    return;
  }
  console.log('Wrote ' + written.length + ' files to site/assets/img.');
  clearTimeout(deadline);
  await pause(300);
  app.exit(0);
}).catch((error) => { console.error(error); clearTimeout(deadline); app.exit(1); });
