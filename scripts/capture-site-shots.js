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
// flow-bar-recording,flow-bar-idle,signin-gate}.png

const { app, BrowserWindow, ipcMain } = require('electron');
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
const deadline = setTimeout(() => { console.error('Site screenshots timed out'); app.exit(1); }, 120000);
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
  writingStyles: {},
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

// --- The five shots --------------------------------------------------------

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

  // 3. The sign-in gate, as a fresh install shows it: Google offered, email below.
  // Back to Dictation first, so the blurred backdrop is the page a new install
  // would have behind the gate rather than whichever one was shot last.
  await run('setView("dictation"); true');
  await pause(400);
  snapshot = { ...base, signInRequired: true, account: signedOutAccount, displayName: '' };
  win.webContents.send('history-updated', snapshot);
  await pause(SETTLE_MS);
  if (!(await run('document.getElementById("signin-gate").open'))) throw new Error('The sign-in gate did not open.');
  if (await run('document.getElementById("signin-google").hidden')) throw new Error('Google sign-in is not offered.');
  await run('document.activeElement && document.activeElement.blur(); true');
  await pause(400);
  await shoot(win, 'signin-gate');

  win.destroy();
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

  // 3. Recording, with a shaped waveform. stopWaveLoop() hands the meter over
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

  // 4. Idle, at rest: no pointer over it, no dictation running.
  await run(`setHud('idle'); onCursor({ hover: false }); true`);
  await pause(SETTLE_MS);
  await shoot(win, 'flow-bar-idle', clip);

  win.destroy();
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
  for (const shot of written) {
    console.log(shot.name.padEnd(26), (shot.width + 'x' + shot.height).padEnd(12),
      (shot.bytes / 1024).toFixed(0) + ' KB', shot.alpha ? 'RGBA' : 'RGB');
  }
  if (errors.length) {
    console.error('Renderer errors:\n  ' + errors.join('\n  '));
    clearTimeout(deadline);
    app.exit(1);
    return;
  }
  console.log('Wrote ' + written.length + ' screenshots to site/assets/img.');
  clearTimeout(deadline);
  app.exit(0);
}).catch((error) => { console.error(error); clearTimeout(deadline); app.exit(1); });
