'use strict';

const { app, BrowserWindow, globalShortcut, ipcMain, clipboard, screen, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, execFile, execFileSync } = require('child_process');
const { cleanup, dedupeRepeats } = require('./cleanup');
const dict = require('./dictionary');
const style = require('./style');
const metrics = require('./metrics');
const insights = require('./insights');
const updater = require('./updater');

app.setName('Voxden');
if (process.platform === 'win32') {
  app.setAppUserModelId('com.voxden.app');
}
app.commandLine.appendSwitch('disable-features', 'OverlayScrollbar');
app.commandLine.appendSwitch('disable-blink-features', 'OverlayScrollbars');

let overlayWin = null;
let historyWin = null;
let tray = null;
let lastHwnd = '0';
let lastTarget = { hwnd: '0', exe: '', title: '' };
let overlayHwnd = '0';
let historyHwnd = '0';
let mode = 'idle';
let engine = 'webspeech';
let engineModel = 'large-v3';
let engineDevice = 'cpu';
let pttPolling = false;
let hwndTimer = null;
let pttTimer = null;
let sidecar = null;
let sidecarReady = false;
let sidecarState = 'starting';
let sidecarRestarts = 0;
let sidecarQueue = [];
let sidecarBuf = '';
let markerProc = null;
let markerReady = false;
let markerBuf = '';
let currentMarks = [];
let recordingStartedAt = 0;
let lastDurationMs = 0;
let successTimer = null;
let isQuitting = false;
let dictionary = { phrases: [] };
let history = { entries: [] };
let settings = {
  dictateMode: 'toggle',
  shortcut: 'CommandOrControl+Shift+Space',
  launchAtLogin: false,
  alwaysShowFlowBar: false,
  showInTaskbar: false,
  soundsEnabled: true,
  suggestionsEnabled: true,
  contextAwareness: true,
  dictationLanguage: 'en',
  appLanguage: 'en',
  microphone: 'default',
  displayName: '',
  muteMusicWhileDictating: true,
  writingStyles: Object.assign({}, style.DEFAULT_WRITING_STYLES),
};

let registeredShortcut = null;
let pausedMediaIds = [];
let mediaPausedByUs = false;

let ROOT;
let DATA;
let MARKS;
let DICT_FILE;
let VOCAB_SEED;
let HIST_FILE;
let SETTINGS_FILE;
let WIN32;
let SIDECAR;
let MARKER;
let MODELS;
let ICON_PNG;
let ICON_ICO;

function initPaths() {
  ROOT = path.join(__dirname, '..');
  if (app.isPackaged) {
    const res = process.resourcesPath;
    DATA = path.join(app.getPath('userData'), 'data');
    MARKS = path.join(DATA, 'marks');
    DICT_FILE = path.join(DATA, 'dictionary.json');
    HIST_FILE = path.join(DATA, 'history.json');
    SETTINGS_FILE = path.join(DATA, 'settings.json');
    VOCAB_SEED = path.join(res, 'scripts', 'vocabulary-seed.json');
    WIN32 = path.join(res, 'scripts', 'win32.ps1');
    SIDECAR = path.join(res, 'sidecar', 'transcribe.py');
    MARKER = path.join(res, 'sidecar', 'marker.py');
    MODELS = path.join(app.getPath('userData'), 'models');
    ICON_PNG = path.join(ROOT, 'assets', 'icon.png');
    ICON_ICO = path.join(ROOT, 'assets', 'icon.ico');
  } else {
    DATA = path.join(ROOT, 'data');
    MARKS = path.join(DATA, 'marks');
    DICT_FILE = path.join(DATA, 'dictionary.json');
    VOCAB_SEED = path.join(ROOT, 'scripts', 'vocabulary-seed.json');
    HIST_FILE = path.join(DATA, 'history.json');
    SETTINGS_FILE = path.join(DATA, 'settings.json');
    WIN32 = path.join(ROOT, 'scripts', 'win32.ps1');
    SIDECAR = path.join(ROOT, 'sidecar', 'transcribe.py');
    MARKER = path.join(ROOT, 'sidecar', 'marker.py');
    MODELS = path.join(ROOT, 'models');
    ICON_PNG = path.join(ROOT, 'assets', 'icon.png');
    ICON_ICO = path.join(ROOT, 'assets', 'icon.ico');
  }
}

function ensureData() {
  fs.mkdirSync(MARKS, { recursive: true });
  if (!fs.existsSync(DICT_FILE) && fs.existsSync(VOCAB_SEED)) {
    fs.copyFileSync(VOCAB_SEED, DICT_FILE);
  }
}

function appIconPath() {
  if (fs.existsSync(ICON_ICO)) return ICON_ICO;
  if (fs.existsSync(ICON_PNG)) return ICON_PNG;
  return null;
}

function appNativeImage() {
  const p = appIconPath();
  if (!p) return nativeImage.createEmpty();
  const img = nativeImage.createFromPath(p);
  return img.isEmpty() ? nativeImage.createEmpty() : img;
}

function trayImage() {
  const img = appNativeImage();
  if (img.isEmpty()) return img;
  const size = img.getSize();
  if (size.width <= 32 && size.height <= 32) return img;
  return img.resize({ width: 16, height: 16 });
}

function loadSettings() {
  const defaults = {
    dictateMode: 'toggle',
    shortcut: 'CommandOrControl+Shift+Space',
    launchAtLogin: false,
    alwaysShowFlowBar: false,
    showInTaskbar: false,
    soundsEnabled: true,
    suggestionsEnabled: true,
    contextAwareness: true,
    dictationLanguage: 'en',
    appLanguage: 'en',
    microphone: 'default',
    displayName: '',
    muteMusicWhileDictating: true,
    writingStyles: Object.assign({}, style.DEFAULT_WRITING_STYLES),
  };
  try {
    const raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    if (raw && typeof raw === 'object') {
      settings = Object.assign({}, defaults, raw);
      if (settings.dictateMode !== 'ptt' && settings.dictateMode !== 'toggle') {
        settings.dictateMode = 'toggle';
      }
      if (!settings.shortcut || typeof settings.shortcut !== 'string') {
        settings.shortcut = defaults.shortcut;
      }
      if (settings.dictationLanguage !== 'en') {
        settings.dictationLanguage = 'en';
      }
      settings.writingStyles = style.normalizeWritingStyles(settings.writingStyles);
    } else {
      settings = defaults;
    }
  } catch (_) {
    settings = defaults;
  }
}

function formatShortcutLabel(accel) {
  const s = String(accel || 'CommandOrControl+Shift+Space');
  return s
    .replace(/CommandOrControl/g, 'Ctrl')
    .replace(/Command/g, 'Cmd')
    .split('+')
    .join('+');
}

function applySystemSettings() {
  try {
    app.setLoginItemSettings({
      openAtLogin: !!settings.launchAtLogin,
      openAsHidden: true,
    });
  } catch (_) {}
  if (historyWin && !historyWin.isDestroyed()) {
    try {
      if (settings.showInTaskbar) historyWin.setSkipTaskbar(false);
      else if (!historyWin.isVisible()) historyWin.setSkipTaskbar(true);
    } catch (_) {}
  }
  if (settings.alwaysShowFlowBar) {
    showOverlay();
    sendOverlay({ mode: mode === 'idle' ? 'idle' : mode, reveal: true });
  }
}

function saveSettings() {
  ensureData();
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

function isPtt() {
  return settings.dictateMode === 'ptt';
}

function loadStores() {
  ensureData();
  dictionary = dict.load(DICT_FILE);
  loadSettings();
  try {
    const raw = JSON.parse(fs.readFileSync(HIST_FILE, 'utf8'));
    history = { entries: Array.isArray(raw.entries) ? raw.entries : [] };
  } catch (_) {
    history = { entries: [] };
  }
}

function saveHistory() {
  ensureData();
  fs.writeFileSync(HIST_FILE, JSON.stringify({ entries: history.entries }, null, 2));
}

function saveDict() {
  dict.save(DICT_FILE, dictionary);
}

function snapshot() {
  const wordCount = dict.countWordsInHistory(history.entries);
  const understanding = dict.understandingState(wordCount);
  const dictationMetrics = metrics.computeMetrics(history.entries);
  return {
    entries: history.entries,
    phrases: dictionary.phrases,
    engine,
    engineStatus: sidecarState,
    model: engineModel,
    device: engineDevice,
    dictateMode: settings.dictateMode,
    shortcut: settings.shortcut,
    shortcutLabel: formatShortcutLabel(settings.shortcut),
    launchAtLogin: settings.launchAtLogin,
    alwaysShowFlowBar: settings.alwaysShowFlowBar,
    showInTaskbar: settings.showInTaskbar,
    soundsEnabled: settings.soundsEnabled,
    suggestionsEnabled: settings.suggestionsEnabled,
    contextAwareness: settings.contextAwareness,
    dictationLanguage: settings.dictationLanguage,
    appLanguage: settings.appLanguage,
    microphone: settings.microphone,
    displayName: settings.displayName || '',
    muteMusicWhileDictating: settings.muteMusicWhileDictating !== false,
    writingStyles: style.normalizeWritingStyles(settings.writingStyles),
    wordCount,
    ...dictationMetrics,
    ...understanding,
    ...updater.getUpdateStatus(),
  };
}

function broadcast() {
  if (historyWin && !historyWin.isDestroyed()) {
    historyWin.webContents.send('history-updated', snapshot());
  }
}

function nid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function toRelMark(absPath) {
  if (!absPath) return null;
  const rel = path.relative(DATA, absPath);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

function ps(args) {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', WIN32, ...args],
      { windowsHide: true, timeout: 4000 },
      (err, stdout) => {
        if (err) return resolve('');
        resolve(String(stdout || '').trim());
      }
    );
  });
}

function findPython() {
  const locals = app.isPackaged
    ? [
      path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Python', 'Python312', 'python.exe'),
      path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Python', 'Python311', 'python.exe'),
      'python.exe',
    ]
    : [
      path.join(ROOT, '.venv', 'Scripts', 'python.exe'),
      path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Python', 'Python312', 'python.exe'),
      'python.exe',
    ];
  for (const p of locals) {
    if (p === 'python.exe') return p;
    if (fs.existsSync(p)) return p;
  }
  return 'python.exe';
}

function sendOverlay(extra) {
  if (!overlayWin || overlayWin.isDestroyed()) return;
  overlayWin.webContents.send('state', Object.assign({
    mode,
    engine,
    engineStatus: sidecarState,
    dictateMode: settings.dictateMode,
    shortcut: settings.shortcut,
    shortcutLabel: formatShortcutLabel(settings.shortcut),
    alwaysShowFlowBar: settings.alwaysShowFlowBar,
    soundsEnabled: settings.soundsEnabled,
    contextAwareness: settings.contextAwareness,
    microphone: settings.microphone || 'default',
  }, extra || {}));
}

let overlayIgnoreMouse = null;

function overlaySize() {
  // The window is bottom-anchored, so extra height is headroom above the pill.
  // It has to clear the tallest shape plus its glow, or the halo gets cut off.
  return { ww: 220, wh: 84 };
}

function positionOverlay() {
  if (!overlayWin) return;
  const display = screen.getPrimaryDisplay();
  const wa = display.workArea;
  const { ww, wh } = overlaySize();
  const x = Math.round(wa.x + (wa.width - ww) / 2);
  const y = Math.round(wa.y + wa.height - wh - 4);
  overlayWin.setPosition(x, y);
}

function captureOverlayHwnd() {
  try {
    overlayHwnd = nativeHwnd(overlayWin.getNativeWindowHandle());
  } catch (_) {}
}

// The overlay is click-through most of the time, and a click-through window on
// Windows never gets WM_MOUSELEAVE -- so the renderer cannot tell when the
// pointer leaves. Poll the OS cursor here instead and feed the renderer window
// coordinates; that is the only signal that stays correct in both modes.
let cursorTimer = 0;
let lastCursor = null;

const CURSOR_POLL_MS = 40;

function overlayCursorTick() {
  if (!overlayWin || overlayWin.isDestroyed() || !overlayWin.isVisible()) return;
  let point;
  let bounds;
  try {
    point = screen.getCursorScreenPoint();
    bounds = overlayWin.getContentBounds();
  } catch (_) {
    return;
  }
  const x = point.x - bounds.x;
  const y = point.y - bounds.y;
  const inside = x >= 0 && y >= 0 && x <= bounds.width && y <= bounds.height;
  // Outside the window the exact coordinates are irrelevant, so send one
  // "left" message and then stay quiet until something changes.
  if (!inside && lastCursor && !lastCursor.inside) return;
  if (lastCursor && lastCursor.inside === inside && lastCursor.x === x && lastCursor.y === y) return;
  lastCursor = { x, y, inside };
  try {
    overlayWin.webContents.send('hud-cursor', lastCursor);
  } catch (_) {}
}

function startCursorWatch() {
  if (cursorTimer) return;
  lastCursor = null;
  cursorTimer = setInterval(overlayCursorTick, CURSOR_POLL_MS);
}

function stopCursorWatch() {
  if (cursorTimer) clearInterval(cursorTimer);
  cursorTimer = 0;
  lastCursor = null;
}

function setOverlayMouseIgnore(ignore) {
  if (!overlayWin || overlayWin.isDestroyed()) return;
  if (overlayIgnoreMouse === ignore) return;
  overlayIgnoreMouse = ignore;
  try {
    if (ignore) overlayWin.setIgnoreMouseEvents(true, { forward: true });
    else overlayWin.setIgnoreMouseEvents(false);
  } catch (_) {}
}

function showOverlay() {
  if (!overlayWin || overlayWin.isDestroyed()) return;
  positionOverlay();
  if (!overlayWin.isVisible()) overlayWin.showInactive();
  captureOverlayHwnd();
  if (mode === 'idle') setOverlayMouseIgnore(true);
  else setOverlayMouseIgnore(false);
  startCursorWatch();
}

function hideOverlayWindow() {
  if (!overlayWin || overlayWin.isDestroyed()) return;
  if (settings.alwaysShowFlowBar) return;
  if (mode === 'recording' || mode === 'transcribing' || mode === 'success' || mode === 'error') return;
  try { overlayWin.setFocusable(false); } catch (_) {}
  setOverlayMouseIgnore(true);
  stopCursorWatch();
  overlayWin.hide();
}

function nativeHwnd(buf) {
  try {
    if (buf.length >= 8) return buf.readBigUInt64LE(0).toString();
    if (buf.length >= 4) return buf.readUInt32LE(0).toString();
  } catch (_) {}
  return '0';
}

function isOurHwnd(hwnd) {
  if (!hwnd || hwnd === '0') return true;
  if (hwnd === overlayHwnd || hwnd === historyHwnd) return true;
  return false;
}

function createOverlay() {
  const icon = appIconPath();
  const { ww, wh } = overlaySize();
  overlayWin = new BrowserWindow({
    width: ww,
    height: wh,
    useContentSize: true,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    hasShadow: false,
    focusable: false,
    show: false,
    icon: icon || undefined,
    title: 'Voxden',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });

  overlayWin.setAlwaysOnTop(true, 'screen-saver');
  try { overlayWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch (_) {}
  overlayWin.setMenuBarVisibility(false);
  setOverlayMouseIgnore(true);
  overlayWin.loadFile(path.join(__dirname, 'overlay.html'));
  overlayWin.once('ready-to-show', () => {
    positionOverlay();
    captureOverlayHwnd();
  });
  overlayWin.on('closed', () => {
    stopCursorWatch();
    overlayWin = null;
    overlayIgnoreMouse = null;
  });
}

function createHistoryWindow() {
  const icon = appIconPath();
  historyWin = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 640,
    minHeight: 440,
    backgroundColor: '#0e0e10',
    title: 'Voxden',
    icon: icon || undefined,
    autoHideMenuBar: true,
    show: false,
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#0e0e10',
      symbolColor: '#c8c8cc',
      height: 44,
    },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  historyWin.setMenuBarVisibility(false);
  historyWin.loadFile(path.join(__dirname, 'app.html'));
  historyWin.on('ready-to-show', () => {
    try {
      historyHwnd = nativeHwnd(historyWin.getNativeWindowHandle());
    } catch (_) {}
  });
  historyWin.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      historyWin.hide();
      if (!settings.showInTaskbar) {
        try { historyWin.setSkipTaskbar(true); } catch (_) {}
      }
    }
  });
  historyWin.on('closed', () => { historyWin = null; historyHwnd = '0'; });
}

function openHistory() {
  if (!historyWin || historyWin.isDestroyed()) createHistoryWindow();
  try { historyWin.setSkipTaskbar(false); } catch (_) {}
  historyWin.show();
  historyWin.focus();
  try {
    historyHwnd = nativeHwnd(historyWin.getNativeWindowHandle());
  } catch (_) {}
  historyWin.webContents.send('history-updated', snapshot());
}

function createTray() {
  const img = trayImage();
  tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img);
  tray.setToolTip('Voxden');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Voxden', click: () => openHistory() },
    { label: 'Dictate', click: () => toggleListen() },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]));
  tray.on('double-click', () => openHistory());
}

function muteMusicEnabled() {
  return settings.muteMusicWhileDictating !== false;
}

async function pauseBackgroundMedia() {
  if (!muteMusicEnabled() || mediaPausedByUs) return;
  const out = await ps(['media-pause']);
  pausedMediaIds = String(out || '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  mediaPausedByUs = pausedMediaIds.length > 0;
}

async function resumeBackgroundMedia() {
  if (!mediaPausedByUs) return;
  const ids = pausedMediaIds.slice();
  pausedMediaIds = [];
  mediaPausedByUs = false;
  await ps(['media-resume', '-Ids', ids.join(',')]);
}

function parseWinInfo(out) {
  const line = String(out || '').trim();
  if (!line) return { hwnd: '0', exe: '', title: '' };
  const parts = line.split('\t');
  return {
    hwnd: parts[0] || '0',
    exe: parts[1] || '',
    title: parts.slice(2).join('\t') || '',
  };
}

async function winInfo(hwnd) {
  const args = ['info'];
  if (hwnd && hwnd !== '0') args.push('-Hwnd', String(hwnd));
  const out = await ps(args);
  return parseWinInfo(out);
}

async function rememberFocus() {
  const info = await winInfo();
  if (info.hwnd && !isOurHwnd(info.hwnd)) {
    lastHwnd = info.hwnd;
    lastTarget = info;
  }
}

function markerSend(cmd) {
  if (!markerProc || !markerReady) return;
  try { markerProc.stdin.write(cmd + '\n'); } catch (_) {}
}

async function startRecording(fromPtt) {
  if (mode === 'recording' || mode === 'transcribing') return;
  await rememberFocus();
  await pauseBackgroundMedia();
  if (successTimer) clearTimeout(successTimer);
  currentMarks = [];
  recordingStartedAt = Date.now();
  lastDurationMs = 0;
  mode = 'recording';
  showOverlay();
  sendOverlay({ reveal: true });
  registerEscape(true);
  if (settings.contextAwareness) markerSend('START');
  if (fromPtt && isPtt()) startPttWatch();
}

async function requestStop() {
  if (mode !== 'recording') return;
  if (recordingStartedAt > 0) {
    lastDurationMs = Math.max(0, Date.now() - recordingStartedAt);
    recordingStartedAt = 0;
  }
  stopPttWatch();
  markerSend('STOP');
  mode = 'transcribing';
  sendOverlay({ mode: 'stop' });
  registerEscape(true);
}

async function cancelListen() {
  if (mode !== 'recording' && mode !== 'transcribing') return;
  currentMarks = [];
  recordingStartedAt = 0;
  lastDurationMs = 0;
  flashError('Transcription failed');
}

async function pasteText(text) {
  const prev = clipboard.readText();
  clipboard.writeText(text);
  try { overlayWin && overlayWin.setFocusable(false); } catch (_) {}
  await ps(['paste', '-Hwnd', String(lastHwnd || '0')]);
  setTimeout(() => {
    try { clipboard.writeText(prev); } catch (_) {}
  }, 500);
}

function addHistoryEntry(text, meta) {
  const markAbs = currentMarks.length ? currentMarks[currentMarks.length - 1] : null;
  const entry = {
    id: nid(),
    ts: Date.now(),
    text,
    original: text,
    mark: toRelMark(markAbs),
  };
  if (lastDurationMs > 0) entry.durationMs = lastDurationMs;
  if (meta) {
    if (meta.exe) entry.exe = meta.exe;
    if (meta.title) entry.title = meta.title;
    if (meta.category) entry.category = meta.category;
    if (typeof meta.dictionaryHits === 'number') entry.dictionaryHits = meta.dictionaryHits;
    if (typeof meta.styleFixes === 'number') entry.styleFixes = meta.styleFixes;
  }
  lastDurationMs = 0;
  history.entries.unshift(entry);
  if (history.entries.length > 400) history.entries.length = 400;
  saveHistory();
  broadcast();
  currentMarks = [];
}

async function onTranscript(raw) {
  const category = style.classifyTarget(lastTarget.exe, lastTarget.title);
  const cleaned = cleanup(raw);
  const deduped = dedupeRepeats(cleaned);
  const dictResult = dict.applyDictionary(deduped, dictionary.phrases, true);
  const text = dictResult.text;
  if (!text) {
    flashError('No speech');
    return;
  }
  const styled = dedupeRepeats(style.applyStyle(text, category, settings.writingStyles));
  mode = 'success';
  sendOverlay({ mode: 'success', text: styled });
  registerEscape(false);
  try { overlayWin && overlayWin.setFocusable(false); } catch (_) {}
  addHistoryEntry(styled, {
    exe: lastTarget.exe || '',
    title: lastTarget.title || '',
    category,
    dictionaryHits: dictResult.hits || 0,
    styleFixes: insights.wordDiffCount(raw, deduped) + insights.wordDiffCount(text, styled),
  });
  await pasteText(styled);
  resumeBackgroundMedia();
  if (successTimer) clearTimeout(successTimer);
  successTimer = setTimeout(() => {
    mode = 'idle';
    sendOverlay({ mode: 'idle' });
  }, 1600);
}

function flashError(msg) {
  stopPttWatch();
  markerSend('STOP');
  registerEscape(false);
  recordingStartedAt = 0;
  lastDurationMs = 0;
  resumeBackgroundMedia();
  mode = 'error';
  showOverlay();
  try { overlayWin && overlayWin.setFocusable(false); } catch (_) {}
  sendOverlay({ mode: 'error', text: msg });
  if (successTimer) clearTimeout(successTimer);
  successTimer = setTimeout(() => {
    mode = 'idle';
    sendOverlay({ mode: 'idle' });
  }, 1800);
}

function toggleListen() {
  if (mode === 'idle' || mode === 'success' || mode === 'error') {
    startRecording(false);
  } else if (mode === 'recording') {
    requestStop();
  }
}

function registerEscape(on) {
  try { globalShortcut.unregister('Escape'); } catch (_) {}
  if (on) {
    globalShortcut.register('Escape', () => cancelListen());
  }
}

function startPttWatch() {
  pttPolling = true;
  if (pttTimer) clearInterval(pttTimer);
  pttTimer = setInterval(async () => {
    if (!pttPolling) return;
    const down = await ps(['space-down']);
    if (down !== '1') {
      pttPolling = false;
      requestStop();
    }
  }, 70);
}

function stopPttWatch() {
  pttPolling = false;
  if (pttTimer) {
    clearInterval(pttTimer);
    pttTimer = null;
  }
}

function startHwndPoll() {
  if (hwndTimer) clearInterval(hwndTimer);
  hwndTimer = setInterval(async () => {
    if (mode === 'recording' || mode === 'transcribing') return;
    const hwnd = await ps(['get']);
    if (hwnd && !isOurHwnd(hwnd)) lastHwnd = hwnd;
  }, 500);
}

function setSidecarState(state) {
  sidecarState = state;
  sendOverlay();
  broadcast();
}

function startSidecar() {
  const py = findPython();
  const env = Object.assign({}, process.env, {
    VOXDEN_MODEL_DIR: MODELS,
    VOXDEN_MODEL: process.env.VOXDEN_MODEL || 'large-v3',
    VOXDEN_DEVICE: process.env.VOXDEN_DEVICE || 'auto',
    PYTHONUTF8: '1',
    PYTHONIOENCODING: 'utf-8',
  });
  setSidecarState('starting');
  execFile(py, [SIDECAR, '--check'], { timeout: 20000, windowsHide: true, env }, (err, stdout) => {
    if (err) {
      engine = 'webspeech';
      setSidecarState('unavailable');
      return;
    }
    let parsed = null;
    try { parsed = JSON.parse(String(stdout).trim().split('\n').pop()); } catch (_) {}
    if (!parsed || !parsed.ok) {
      engine = 'webspeech';
      setSidecarState('unavailable');
      return;
    }
    if (parsed.model) engineModel = String(parsed.model);
    if (parsed.device) engineDevice = String(parsed.device);
    setSidecarState('loading');
    sidecar = spawn(py, [SIDECAR, '--serve'], {
      env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    sidecar.stdout.setEncoding('utf8');
    sidecar.stderr.on('data', (chunk) => {
      try {
        fs.appendFileSync(path.join(DATA, 'sidecar.log'), String(chunk));
      } catch (_) {}
    });
    sidecar.stdout.on('data', (chunk) => {
      sidecarBuf += chunk;
      let idx;
      while ((idx = sidecarBuf.indexOf('\n')) >= 0) {
        const line = sidecarBuf.slice(0, idx).trim();
        sidecarBuf = sidecarBuf.slice(idx + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch (_) { continue; }
        if (msg.ready) {
          sidecarReady = true;
          engine = 'whisper';
          if (msg.model) engineModel = String(msg.model);
          if (msg.device) engineDevice = String(msg.device);
          sidecarRestarts = 0;
          setSidecarState('ready');
          continue;
        }
        const waiter = sidecarQueue.shift();
        if (waiter) waiter(msg);
      }
    });
    sidecar.on('exit', () => {
      sidecar = null;
      sidecarReady = false;
      engine = 'webspeech';
      setSidecarState('unavailable');
      while (sidecarQueue.length) {
        const w = sidecarQueue.shift();
        w({ ok: false, error: 'sidecar exited' });
      }
      if (!isQuitting && sidecarRestarts < 3) {
        sidecarRestarts += 1;
        setTimeout(() => { if (!isQuitting) startSidecar(); }, 5000);
      }
    });
  });
}

function startMarker() {
  const py = findPython();
  const env = Object.assign({}, process.env, { VOXDEN_MARKS_DIR: MARKS });
  markerProc = spawn(py, [MARKER], {
    env,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  markerProc.stdout.setEncoding('utf8');
  markerProc.stderr.on('data', () => {});
  markerProc.stdout.on('data', (chunk) => {
    markerBuf += chunk;
    let idx;
    while ((idx = markerBuf.indexOf('\n')) >= 0) {
      const line = markerBuf.slice(0, idx).trim();
      markerBuf = markerBuf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch (_) { continue; }
      if (msg.ready) {
        markerReady = true;
        continue;
      }
      if (msg.marked && msg.path) {
        currentMarks.push(msg.path);
        sendOverlay({ marked: true });
      }
    }
  });
  markerProc.on('exit', () => {
    markerProc = null;
    markerReady = false;
  });
}

function friendlyEngineError(msg) {
  const m = String(msg || '');
  if (/charmap|codec can't encode|character maps/i.test(m)) return "Couldn't send transcript — try again";
  if (/whisper timeout/i.test(m)) return 'Transcription timed out';
  if (/whisper not ready|sidecar exited/i.test(m)) return 'Speech engine not ready';
  if (m.length > 56) return 'Transcribe failed';
  return m || 'Transcribe failed';
}

function sidecarTranscribe(wavPath, options) {
  const opts = options || {};
  return new Promise((resolve, reject) => {
    if (!sidecar || !sidecarReady) {
      reject(new Error('whisper not ready'));
      return;
    }
    const t = setTimeout(() => {
      const i = sidecarQueue.indexOf(handler);
      if (i >= 0) sidecarQueue.splice(i, 1);
      reject(new Error('whisper timeout'));
    }, 60000);
    function handler(msg) {
      clearTimeout(t);
      if (msg && msg.ok) resolve(msg.text || '');
      else reject(new Error(friendlyEngineError((msg && msg.error) || 'whisper failed')));
    }
    sidecarQueue.push(handler);
    const prompt = dict.promptFrom(dictionary.phrases, history.entries, 64);
    const payload = { path: wavPath, language: settings.dictationLanguage || 'en' };
    if (prompt) payload.prompt = prompt;
    if (opts.vad === false) payload.vad = false;
    sidecar.stdin.write(JSON.stringify(payload) + '\n');
  });
}

function dictationHotkeyHandler() {
  if (mode === 'idle' || mode === 'success' || mode === 'error') startRecording(true);
  else if (mode === 'recording') requestStop();
}

function unregisterDictationShortcut() {
  if (registeredShortcut) {
    try { globalShortcut.unregister(registeredShortcut); } catch (_) {}
    registeredShortcut = null;
  }
}

function tryRegisterShortcut(accel) {
  unregisterDictationShortcut();
  const candidate = accel || settings.shortcut || 'CommandOrControl+Shift+Space';
  try {
    const ok = globalShortcut.register(candidate, dictationHotkeyHandler);
    if (!ok) return false;
    registeredShortcut = candidate;
    return true;
  } catch (_) {
    return false;
  }
}

function registerHotkeys() {
  if (!tryRegisterShortcut(settings.shortcut)) {
    settings.shortcut = 'CommandOrControl+Shift+Space';
    tryRegisterShortcut(settings.shortcut);
  }
}

ipcMain.on('hud-ready', () => {
  sendOverlay({ mode: 'idle' });
  if (settings.alwaysShowFlowBar) {
    showOverlay();
    sendOverlay({ reveal: true });
  }
});
ipcMain.on('hud-hidden', () => hideOverlayWindow());
ipcMain.on('hud-ignore-mouse', (e, ignore) => {
  if (!overlayWin || overlayWin.isDestroyed()) return;
  if (e.sender !== overlayWin.webContents) return;
  setOverlayMouseIgnore(!!ignore);
});
ipcMain.on('app-ready', () => {
  if (historyWin && !historyWin.isDestroyed()) {
    historyWin.webContents.send('history-updated', snapshot());
  }
});
ipcMain.on('open-history', () => openHistory());
ipcMain.handle('toggle', async () => { toggleListen(); return { mode, engine }; });
ipcMain.on('hud-cancel', () => cancelListen());
ipcMain.on('hud-confirm', () => { if (mode === 'recording') requestStop(); });
ipcMain.on('transcript', (_e, text) => onTranscript(text));
ipcMain.on('capture-failed', (_e, msg) => flashError(friendlyEngineError(msg || 'Mic error')));
ipcMain.on('cancelled', () => {
  mode = 'idle';
  registerEscape(false);
  try { overlayWin && overlayWin.setFocusable(false); } catch (_) {}
  sendOverlay({ mode: 'idle' });
});
ipcMain.handle('transcribe-local', async (_e, wav, options) => {
  const tmp = path.join(os.tmpdir(), 'voxden-' + Date.now() + '-' + process.hrtime.bigint() + '.wav');
  fs.writeFileSync(tmp, Buffer.isBuffer(wav) ? wav : Buffer.from(wav));
  try {
    const text = await sidecarTranscribe(tmp, options);
    return text;
  } finally {
    fs.unlink(tmp, () => {});
  }
});
ipcMain.handle('app-load', async () => snapshot());
ipcMain.handle('update-check', async () => {
  await updater.checkNow();
  broadcast();
  return updater.getUpdateStatus();
});
ipcMain.handle('settings-set', async (_e, patch) => {
  if (!patch || typeof patch !== 'object') return snapshot();

  if (patch.dictateMode === 'ptt' || patch.dictateMode === 'toggle') {
    settings.dictateMode = patch.dictateMode;
    if (patch.dictateMode === 'toggle') stopPttWatch();
  }

  if (typeof patch.shortcut === 'string' && patch.shortcut.trim()) {
    const prev = settings.shortcut;
    const next = patch.shortcut.trim();
    settings.shortcut = next;
    if (!tryRegisterShortcut(next)) {
      settings.shortcut = prev;
      tryRegisterShortcut(prev);
      return Object.assign(snapshot(), { shortcutError: 'Shortcut unavailable' });
    }
    saveSettings();
  }

  const boolKeys = [
    'launchAtLogin', 'alwaysShowFlowBar', 'showInTaskbar',
    'soundsEnabled', 'suggestionsEnabled', 'contextAwareness', 'muteMusicWhileDictating',
  ];
  for (const key of boolKeys) {
    if (typeof patch[key] === 'boolean') settings[key] = patch[key];
  }

  if (patch.dictationLanguage === 'en') {
    settings.dictationLanguage = 'en';
  }

  if (typeof patch.displayName === 'string') {
    settings.displayName = patch.displayName.trim().slice(0, 40);
  }

  if (typeof patch.microphone === 'string' && patch.microphone) {
    settings.microphone = patch.microphone;
  }

  if (patch.writingStyles && typeof patch.writingStyles === 'object') {
    settings.writingStyles = style.normalizeWritingStyles(
      Object.assign({}, settings.writingStyles, patch.writingStyles)
    );
  }

  saveSettings();
  applySystemSettings();
  sendOverlay();
  broadcast();
  return snapshot();
});
ipcMain.handle('history-copy', async (_e, id) => {
  const entry = history.entries.find((x) => x.id === id);
  if (!entry) return false;
  clipboard.writeText(entry.text || '');
  return true;
});
ipcMain.handle('history-delete', async (_e, id) => {
  const before = history.entries.length;
  history.entries = history.entries.filter((x) => x.id !== id);
  if (history.entries.length !== before) {
    saveHistory();
    broadcast();
  }
  return true;
});
ipcMain.handle('history-edit', async (_e, id, text) => {
  const entry = history.entries.find((x) => x.id === id);
  if (!entry) return { ok: false, learned: [] };
  const next = String(text || '');
  if (next === entry.text) return { ok: true, learned: [] };
  if (!entry.original) entry.original = entry.text;

  const result = dict.reviseLearned(
    dictionary.phrases,
    entry.learnedPairs,
    entry.original,
    next
  );
  dictionary.phrases = result.phrases;
  entry.learnedPairs = result.learned;
  entry.text = next;
  saveDict();
  saveHistory();
  broadcast();
  return { ok: true, learned: result.learned };
});
ipcMain.handle('dict-upsert', async (_e, from, to) => {
  const result = dict.upsertPhrase(dictionary.phrases, from, to);
  if (!result.ok) return { ok: false, error: result.error };
  dictionary.phrases = result.phrases;
  saveDict();
  broadcast();
  return { ok: true };
});
ipcMain.handle('dict-delete', async (_e, from) => {
  const key = String(from || '').toLowerCase();
  dictionary.phrases = dictionary.phrases.filter((p) => String(p.from).toLowerCase() !== key);
  saveDict();
  broadcast();
  return true;
});
ipcMain.handle('mark-data', async (_e, rel) => {
  if (!rel) return null;
  const root = path.resolve(DATA);
  const abs = path.resolve(root, String(rel));
  const prefix = root + path.sep;
  if (abs !== root && !abs.toLowerCase().startsWith(prefix.toLowerCase())) return null;
  if (!fs.existsSync(abs)) return null;
  const img = nativeImage.createFromPath(abs);
  if (img.isEmpty()) return null;
  const size = img.getSize();
  const h = 56;
  const w = Math.max(1, Math.round(size.width * (h / Math.max(1, size.height))));
  return img.resize({ width: w, height: h }).toDataURL();
});

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    openHistory();
  });

  app.whenReady().then(() => {
    initPaths();
    loadStores();
    updater.startUpdater({
      getMode: () => mode,
      onStatusChange: () => broadcast(),
    });
    const ses = require('electron').session.defaultSession;
    ses.setPermissionRequestHandler((_wc, permission, cb) => {
      if (permission === 'media' || permission === 'microphone' || permission === 'audioCapture') cb(true);
      else cb(false);
    });
    Menu.setApplicationMenu(null);
    createOverlay();
    createHistoryWindow();
    createTray();
    registerHotkeys();
    applySystemSettings();
    startHwndPoll();
    startSidecar();
    startMarker();
    screen.on('display-metrics-changed', positionOverlay);
  });

  app.on('before-quit', () => {
    isQuitting = true;
    if (mediaPausedByUs && pausedMediaIds.length) {
      try {
        execFileSync('powershell.exe', [
          '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', WIN32,
          'media-resume', '-Ids', pausedMediaIds.join(','),
        ], { windowsHide: true, timeout: 4000 });
      } catch (_) {}
      mediaPausedByUs = false;
      pausedMediaIds = [];
    }
  });

  app.on('will-quit', (e) => {
    if (updater.tryInstallOnQuit()) {
      e.preventDefault();
      return;
    }
    updater.stopUpdater();
    globalShortcut.unregisterAll();
    stopPttWatch();
    if (hwndTimer) clearInterval(hwndTimer);
    if (sidecar) {
      try { sidecar.stdin.write('QUIT\n'); } catch (_) {}
      sidecar.kill();
    }
    if (markerProc) {
      try { markerProc.stdin.write('QUIT\n'); } catch (_) {}
      markerProc.kill();
    }
  });
}
