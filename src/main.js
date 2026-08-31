'use strict';

const { app, BrowserWindow, globalShortcut, ipcMain, clipboard, screen, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, execFile, execFileSync } = require('child_process');
const { cleanup, cleanupVerbatim, dedupeRepeats } = require('./cleanup');
const dict = require('./dictionary');
const style = require('./style');
const rewriter = require('./rewriter');
const metrics = require('./metrics');
const insights = require('./insights');
const corpus = require('./corpus');
const models = require('./models');
const asr = require('./asr');
const hotkeys = require('./hotkeys');
const updater = require('./updater');
const { createSidecarQueue } = require('./sidecar-queue');
const { LanguagePackManager, normalizeTier } = require('./language-packs');
const { AsrRuntimeManager } = require('./asr-runtime');
const { AsrModelManager } = require('./asr-model');
const { CudaPackManager } = require('./cuda-pack');
const gpu = require('./gpu');
const { LocalRewriteRuntime } = require('./local-rewrite-runtime');

app.setName('Voxden');
if (process.platform === 'win32') {
  app.setAppUserModelId('com.voxden.app');
}
app.commandLine.appendSwitch('disable-features', 'OverlayScrollbar');
app.commandLine.appendSwitch('disable-blink-features', 'OverlayScrollbars');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

let overlayWin = null;
let historyWin = null;
let tray = null;
// Last built menu's signature, so a rebuild only happens when the menu would
// actually come out different.
let trayMenuSig = '';
// A settings pane the tray asked for before the window had loaded.
let pendingSettingsCat = '';
// Audio inputs, reported by the renderer. Only a renderer can enumerate them,
// and the tray needs the list to offer a picker rather than a link.
let micDevices = [];
let micDefaultId = '';
let lastHwnd = '0';
let lastTarget = { hwnd: '0', exe: '', title: '' };
let overlayHwnd = '0';
let historyHwnd = '0';
let mode = 'idle';
let engine = 'webspeech';
let engineModel = 'large-v3';
let engineDevice = 'cpu';
let engineBackend = 'faster-whisper';
let engineFastBackend = '';
let engineFastModel = '';
let engineFastDevice = '';
let engineWarning = '';
// Set when a hotkey could not be registered at launch and the app fell back to
// a different chord. Shown in settings until the shortcut is changed.
let hotkeyNotice = '';
let engineFix = '';
let engineFixEngine = '';
let engineError = '';
let engineProgress = null;
let pttPolling = false;
let hwndTimer = null;
let pttTimer = null;
let sidecar = null;
let sidecarReady = false;
let sidecarState = 'starting';
let sidecarRestarts = 0;
let sidecarRestartNow = false;
let sidecarStartToken = 0;
let sidecarQueue = createSidecarQueue();
let sidecarReadyWaiters = [];
let sidecarBuf = '';
let sidecarProgressBuf = '';
let markerProc = null;
let markerReady = false;
let markerBuf = '';
let currentMarks = [];
let recordingStartedAt = 0;
let lastDurationMs = 0;
let successTimer = null;
let isQuitting = false;
let dictionary = { phrases: [], variants: [] };
let history = { entries: [] };
let settings = {
  dictateMode: 'toggle',
  shortcut: 'CommandOrControl+Shift+Space',
  pasteLastShortcut: 'CommandOrControl+Alt+V',
  launchAtLogin: false,
  alwaysShowFlowBar: true,
  showInTaskbar: false,
  soundsEnabled: true,
  suggestionsEnabled: true,
  contextAwareness: true,
  keepTrainingAudio: false,
  useTunedModel: true,
  asrEngine: 'whisper',
  asrDevice: 'auto',
  dictationLanguage: 'en',
  appLanguage: 'en',
  microphone: 'default',
  displayName: '',
  muteMusicWhileDictating: true,
  smartRewriteEnabled: false,
  languagePack: 'standard',
  writingStyles: Object.assign({}, style.DEFAULT_WRITING_STYLES),
  dictationQuality: 'auto',
  selectedTextRewrite: true,
  verbatimMode: false,
  verbatimDictionary: false,
  autoSend: Object.assign({}, style.DEFAULT_AUTO_SEND),
};

let rewriteState = {
  status: 'disabled',
  message: 'Sentence correction is off.',
};
let languagePackState = {
  status: 'idle',
  tier: 'standard',
  progress: null,
  message: 'Choose a language pack to get started.',
};
let languagePackManager = null;
let localRewriteRuntime = null;
let asrRuntimeManager = null;
let asrModelManager = null;
let cudaPackManager = null;
let cudaPackState = { status: 'idle', progress: null, message: '' };
// What Electron reports about the graphics on this PC, resolved once at
// startup. Empty until it answers, which is why gpuPlan treats an empty list
// as "no usable GPU" rather than guessing.
let gpuDevices = [];
// One state for the whole first-run setup. The engine and the weights are two
// downloads but not two decisions -- neither is any use without the other, so
// the user is shown one operation with one bar.
// What each engine can actually run on this PC, as reported by the sidecar's
// --check. Empty until the first check answers.
let engineAvailability = {};
let asrRuntimeState = {
  status: 'idle',
  progress: null,
  message: '',
  step: '',
};

let registeredShortcut = null;
// The helper process watching a modifier-only chord, and the chord it watches.
// Only ever running when the dictation shortcut has no real key in it.
let chordWatch = null;
let chordWatchAccel = '';
let registeredPasteShortcut = null;
let pasteLastBusy = false;
let pausedMediaIds = [];
let mediaPausedByUs = false;
let mediaPausePromise = null;
let recordingSessionToken = 0;
let dictationContext = { selectedText: '', clipboardText: '', windowText: '' };

let ROOT;
let DATA;
let MARKS;
let AUDIO;
let DICT_FILE;
let VOCAB_SEED;
let HIST_FILE;
let SETTINGS_FILE;
let WIN32;
let SIDECAR;
let MARKER;
let MODELS;
let WRITER_MODELS;
let ASR_RUNTIME;
let ASR_MODELS;
let CUDA_PACK;
let ICON_PNG;
let ICON_ICO;

function resolveAssetIcon(name) {
  const asarPath = path.join(ROOT, 'assets', name);
  const unpacked = asarPath.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
  if (unpacked !== asarPath && fs.existsSync(unpacked)) return unpacked;
  return asarPath;
}

function initPaths() {
  ROOT = path.join(__dirname, '..');
  if (app.isPackaged) {
    const res = process.resourcesPath;
    DATA = path.join(app.getPath('userData'), 'data');
    MARKS = path.join(DATA, 'marks');
    AUDIO = path.join(DATA, 'audio');
    DICT_FILE = path.join(DATA, 'dictionary.json');
    HIST_FILE = path.join(DATA, 'history.json');
    SETTINGS_FILE = path.join(DATA, 'settings.json');
    VOCAB_SEED = path.join(res, 'scripts', 'vocabulary-seed.json');
    WIN32 = path.join(res, 'scripts', 'win32.ps1');
    SIDECAR = path.join(res, 'sidecar', 'transcribe.py');
    MARKER = path.join(res, 'sidecar', 'marker.py');
    MODELS = path.join(app.getPath('userData'), 'models');
    WRITER_MODELS = path.join(MODELS, 'writer');
    ASR_RUNTIME = path.join(app.getPath('userData'), 'asr-runtime');
    ASR_MODELS = path.join(app.getPath('userData'), 'asr-models');
    CUDA_PACK = path.join(app.getPath('userData'), 'cuda-pack');
    ICON_PNG = resolveAssetIcon('icon.png');
    ICON_ICO = resolveAssetIcon('icon.ico');
  } else {
    DATA = path.join(ROOT, 'data');
    MARKS = path.join(DATA, 'marks');
    AUDIO = path.join(DATA, 'audio');
    DICT_FILE = path.join(DATA, 'dictionary.json');
    VOCAB_SEED = path.join(ROOT, 'scripts', 'vocabulary-seed.json');
    HIST_FILE = path.join(DATA, 'history.json');
    SETTINGS_FILE = path.join(DATA, 'settings.json');
    WIN32 = path.join(ROOT, 'scripts', 'win32.ps1');
    SIDECAR = path.join(ROOT, 'sidecar', 'transcribe.py');
    MARKER = path.join(ROOT, 'sidecar', 'marker.py');
    MODELS = path.join(ROOT, 'models');
    WRITER_MODELS = path.join(MODELS, 'writer');
    ASR_RUNTIME = path.join(ROOT, 'models', 'asr-runtime');
    ASR_MODELS = path.join(ROOT, 'models', 'asr-models');
    CUDA_PACK = path.join(ROOT, 'models', 'cuda-pack');
    ICON_PNG = path.join(ROOT, 'assets', 'icon.png');
    ICON_ICO = path.join(ROOT, 'assets', 'icon.ico');
  }
  languagePackManager = new LanguagePackManager({
    root: WRITER_MODELS,
    releaseApiUrl: process.env.VOXDEN_LANGUAGE_PACK_RELEASE_API || undefined,
    onProgress: (state) => {
      languagePackState = Object.assign({}, languagePackState, state);
      if (packProgressIsWorthSending(languagePackState)) broadcast();
    },
  });
  asrRuntimeManager = new AsrRuntimeManager({
    root: ASR_RUNTIME,
    releaseApiUrl: process.env.VOXDEN_ASR_RUNTIME_RELEASE_API || undefined,
    onProgress: (state) => reportSetup('engine', state),
  });
  asrModelManager = new AsrModelManager({
    root: ASR_MODELS,
    releaseApiUrl: process.env.VOXDEN_ASR_MODEL_RELEASE_API || undefined,
    onProgress: (state) => reportSetup('model', state),
  });
  cudaPackManager = new CudaPackManager({
    root: CUDA_PACK,
    releaseApiUrl: process.env.VOXDEN_CUDA_PACK_RELEASE_API || undefined,
    onProgress: (state) => {
      cudaPackState = Object.assign({}, cudaPackState, state);
      broadcast();
    },
  });
  localRewriteRuntime = new LocalRewriteRuntime({
    logPath: path.join(DATA, 'local-correction.log'),
  });
}

function ensureData() {
  fs.mkdirSync(MARKS, { recursive: true });
  corpus.init(AUDIO);
  if (!fs.existsSync(DICT_FILE) && fs.existsSync(VOCAB_SEED)) {
    fs.copyFileSync(VOCAB_SEED, DICT_FILE);
  }
}

function appIconPath() {
  if (process.platform === 'win32' && ICON_ICO && fs.existsSync(ICON_ICO)) return ICON_ICO;
  if (ICON_PNG && fs.existsSync(ICON_PNG)) return ICON_PNG;
  if (ICON_ICO && fs.existsSync(ICON_ICO)) return ICON_ICO;
  return null;
}

function windowIconPath() {
  const src = appIconPath();
  if (!src) return null;
  if (process.platform !== 'win32') return src;
  try {
    const buf = fs.readFileSync(src);
    const hash = require('crypto').createHash('sha1').update(buf).digest('hex').slice(0, 12);
    const dest = path.join(os.tmpdir(), 'voxden-icon-' + hash + path.extname(src));
    if (!fs.existsSync(dest)) fs.writeFileSync(dest, buf);
    return dest;
  } catch (_) {
    return src;
  }
}

function loadAppIconImage() {
  if (ICON_PNG && fs.existsSync(ICON_PNG)) {
    const png = nativeImage.createFromPath(ICON_PNG);
    if (png && !png.isEmpty()) return png;
  }
  const p = windowIconPath() || appIconPath();
  if (!p) return nativeImage.createEmpty();
  const img = nativeImage.createFromPath(p);
  return img.isEmpty() ? nativeImage.createEmpty() : img;
}

function applyWindowIcon(win) {
  if (!win || win.isDestroyed()) return;
  const p = windowIconPath();
  if (p) {
    try { win.setIcon(p); } catch (_) {}
  }
  const img = loadAppIconImage();
  if (!img.isEmpty()) {
    try { win.setIcon(img); } catch (_) {}
  }
}

function trayImage() {
  const img = loadAppIconImage();
  if (img.isEmpty()) return img;
  const size = img.getSize();
  if (size.width <= 32 && size.height <= 32) return img;
  return img.resize({ width: 32, height: 32 });
}

// Engines whose backend no longer exists at all. A value left behind in
// settings.json outlives the option that set it, so a removal is only half the
// job without this. qwen3-asr is deliberately not here: its backend is alive
// and works on a Python that carries torch and qwen_asr, so it is gated on
// detection rather than retired -- see engineAvailability.
const RETIRED_ASR_ENGINES = new Set(['voxtral']);

function loadSettings() {
  const defaults = {
    dictateMode: 'toggle',
    shortcut: 'CommandOrControl+Shift+Space',
    pasteLastShortcut: 'CommandOrControl+Alt+V',
    launchAtLogin: false,
    alwaysShowFlowBar: true,
    sidebarCollapsed: false,
    showInTaskbar: false,
    soundsEnabled: true,
    suggestionsEnabled: true,
    contextAwareness: true,
    keepTrainingAudio: false,
    useTunedModel: true,
    asrEngine: 'whisper',
    asrDevice: 'auto',
    dictationLanguage: 'en',
    appLanguage: 'en',
    microphone: 'default',
    displayName: '',
    muteMusicWhileDictating: true,
    smartRewriteEnabled: false,
    languagePack: 'standard',
    writingStyles: Object.assign({}, style.DEFAULT_WRITING_STYLES),
    dictationQuality: 'auto',
    selectedTextRewrite: true,
    verbatimMode: false,
    verbatimDictionary: false,
    autoSend: Object.assign({}, style.DEFAULT_AUTO_SEND),
  };
  let migratedEngine = false;
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
      if (!settings.pasteLastShortcut || typeof settings.pasteLastShortcut !== 'string') {
        settings.pasteLastShortcut = defaults.pasteLastShortcut;
      }
      settings.dictationLanguage = asr.normalizeDictationLanguage(settings.dictationLanguage);
      settings.smartRewriteEnabled = !!settings.smartRewriteEnabled;
      settings.languagePack = normalizeTier(settings.languagePack);
      settings.asrEngine = asr.normalizeAsrEngine(settings.asrEngine);
      if (RETIRED_ASR_ENGINES.has(String(raw.asrEngine || '').trim().toLowerCase())) {
        settings.asrEngine = 'whisper';
        migratedEngine = true;
      }
      settings.asrDevice = asr.normalizeAsrDevice(settings.asrDevice);
      delete settings.smartRewriteEndpoint;
      delete settings.smartRewriteModel;
      settings.writingStyles = style.normalizeWritingStyles(settings.writingStyles);
      settings.dictationQuality = style.normalizeDictationQuality(settings.dictationQuality);
      settings.selectedTextRewrite = settings.selectedTextRewrite !== false;
      settings.verbatimMode = !!settings.verbatimMode;
      settings.verbatimDictionary = !!settings.verbatimDictionary;
      settings.autoSend = style.normalizeAutoSend(settings.autoSend);
    } else {
      settings = defaults;
    }
  } catch (_) {
    settings = defaults;
  }
  if (migratedEngine) {
    try { saveSettings(); } catch (_) {}
  }
}

const formatShortcutLabel = hotkeys.formatShortcutLabel;

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

function smartRewriteSnapshot() {
  if ((languagePackState.status === 'downloading'
      || languagePackState.status === 'preparing'
      || languagePackState.status === 'verifying'
      || languagePackState.status === 'error'
      || languagePackState.status === 'cancelled')
      && languagePackState.tier === settings.languagePack) {
    return languagePackState;
  }
  if (settings.verbatimMode) {
    return { status: 'disabled', message: 'Verbatim mode is on, so sentence correction never runs.' };
  }
  if (!settings.smartRewriteEnabled) {
    return { status: 'disabled', message: 'Sentence correction is off.' };
  }
  if (!languagePackManager || !languagePackManager.installed(settings.languagePack)) {
    const packName = settings.languagePack === 'enhanced' ? 'Enhanced' : 'Standard';
    return { status: 'needs-model', message: 'Download the ' + packName + ' language pack to enable correction.' };
  }
  return rewriteState.status === 'disabled'
    ? { status: 'ready', message: 'Your language pack is installed and ready.' }
    : rewriteState;
}

function snapshot() {
  const wordCount = dict.countWordsInHistory(history.entries);
  const understanding = dict.understandingState(wordCount);
  const dictationMetrics = metrics.computeMetrics(history.entries);
  const languagePackInfo = languagePackManager
    ? languagePackManager.snapshot(settings.languagePack)
    : { selected: normalizeTier(settings.languagePack), root: '', packs: {} };
  return {
    entries: history.entries,
    phrases: dictionary.phrases,
    pendingPhrases: dictionary.pending || [],
    variantCount: (dictionary.variants || []).length,
    engine,
    engineStatus: sidecarState,
    model: engineModel,
    device: engineDevice,
    asrEngine: settings.asrEngine,
    asrDevice: settings.asrDevice,
    asrEngineActive: engineBackend,
    asrEngineWarning: engineWarning,
    asrEngineFix: engineFix,
    asrEngineFixEngine: engineFixEngine,
    asrEngineAvailable: engineAvailability,
    usingManagedRuntime: usingManagedRuntime(),
    asrEngineError: engineError,
    asrRuntime: asrRuntimeManager ? asrRuntimeManager.snapshot() : null,
    asrModel: asrModelManager ? asrModelManager.snapshot() : null,
    asrRuntimeState,
    asrRuntimeWouldHelp: asrRuntimeWouldHelp(),
    asrEngineProgress: engineProgress,
    fastEngine: engineFastBackend,
    // Whether every dictation is going through Parakeet, not just the fast
    // ones. The settings hint says so out loud, and must not re-derive the
    // rule -- a second copy is how a hint ends up describing routing that
    // stopped happening.
    gpu: currentGpuPlan(),
    cudaPack: cudaPackManager ? cudaPackManager.snapshot() : null,
    cudaPackState,
    asrFastOnCpu: asr.prefersFastAsr({
      device: engineDevice,
      fastEngine: engineFastBackend,
      language: settings.dictationLanguage,
    }),
    fastModel: engineFastModel,
    fastDevice: engineFastDevice,
    dictateMode: settings.dictateMode,
    shortcut: settings.shortcut,
    shortcutLabel: formatShortcutLabel(settings.shortcut),
    pasteLastShortcut: settings.pasteLastShortcut,
    pasteLastShortcutLabel: formatShortcutLabel(settings.pasteLastShortcut),
    hotkeyNotice,
    launchAtLogin: settings.launchAtLogin,
    alwaysShowFlowBar: settings.alwaysShowFlowBar,
    sidebarCollapsed: !!settings.sidebarCollapsed,
    showInTaskbar: settings.showInTaskbar,
    soundsEnabled: settings.soundsEnabled,
    suggestionsEnabled: settings.suggestionsEnabled,
    contextAwareness: settings.contextAwareness,
    keepTrainingAudio: !!settings.keepTrainingAudio,
    training: corpus.stats(),
    useTunedModel: settings.useTunedModel !== false,
    tunedModel: tunedModelInfo(),
    modelIsTuned: usingTunedModel(),
    dictationLanguage: settings.dictationLanguage,
    appLanguage: settings.appLanguage,
    microphone: settings.microphone,
    displayName: settings.displayName || '',
    muteMusicWhileDictating: settings.muteMusicWhileDictating !== false,
    smartRewriteEnabled: !!settings.smartRewriteEnabled,
    languagePack: languagePackInfo.selected,
    languagePacks: languagePackInfo.packs,
    languagePackStoragePath: languagePackInfo.root,
    languagePackState,
    smartRewriteState: smartRewriteSnapshot(),
    writingStyles: style.normalizeWritingStyles(settings.writingStyles),
    dictationQuality: style.normalizeDictationQuality(settings.dictationQuality),
    selectedTextRewrite: settings.selectedTextRewrite !== false,
    verbatimMode: !!settings.verbatimMode,
    verbatimDictionary: !!settings.verbatimDictionary,
    autoSend: style.normalizeAutoSend(settings.autoSend),
    canRetry: corpus.hasRetry(),
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
  // The tray menu shows the same settings and the same history, so it goes
  // stale on exactly the events that refresh the window.
  refreshTray();
}

// Download progress fires once per network chunk, and snapshot() walks the whole
// history and stats the installed packs synchronously. Forwarding every chunk
// froze the window for the length of the download. The bar only has a hundred
// states, so send it a hundred times.
let lastPackProgressKey = '';

function packProgressIsWorthSending(state) {
  if (state.status !== 'downloading') {
    lastPackProgressKey = '';
    return true;
  }
  const percent = Number.isFinite(state.progress) ? Math.floor(state.progress) : -1;
  const key = percent + ':' + (state.asset || '');
  if (key === lastPackProgressKey) return false;
  lastPackProgressKey = key;
  return true;
}

let lastAsrProgressKey = '';

function asrProgressIsWorthSending(state) {
  if (state.status !== 'downloading' && state.status !== 'installing') {
    lastAsrProgressKey = '';
    return true;
  }
  const percent = Number.isFinite(state.progress) ? Math.floor(state.progress) : -1;
  const key = state.step + ':' + state.status + ':' + percent;
  if (key === lastAsrProgressKey) return false;
  lastAsrProgressKey = key;
  return true;
}

// The engine is 110 MB and the weights are 3.1 GB, so a bar that gave each half
// would sit at 50% for the whole real wait. Split it by what is actually being
// transferred.
const SETUP_WEIGHTS = { engine: 0.03, model: 0.97 };

function reportSetup(step, state) {
  const share = SETUP_WEIGHTS[step] || 0;
  const before = step === 'model' ? SETUP_WEIGHTS.engine : 0;
  const own = Number.isFinite(state.progress) ? Math.max(0, Math.min(100, state.progress)) : 0;
  const combined = Math.floor((before + share * (own / 100)) * 100);
  asrRuntimeState = Object.assign({}, asrRuntimeState, state, {
    step,
    progress: state.status === 'installed' && step === 'model' ? 100 : combined,
    message: step === 'engine'
      ? (state.status === 'installed' ? 'Speech engine ready. Fetching the model…' : state.message)
      : state.message,
  });
  if (asrProgressIsWorthSending(asrRuntimeState)) broadcast();
}

// Both halves of a working dictation setup, in the order that fails cheapest:
// the engine is small, so a network problem surfaces in seconds rather than
// after three gigabytes.
async function setupDictation() {
  asrRuntimeState = { status: 'preparing', progress: 0, message: 'Starting setup…', step: 'engine' };
  broadcast();
  await asrRuntimeManager.install();
  await asrModelManager.install();
  asrRuntimeState = {
    status: 'installed',
    progress: 100,
    message: 'Dictation is ready.',
    step: 'done',
  };
}

function asrSetupStatePath() {
  return path.join(ASR_RUNTIME, 'setup-state.json');
}

// The setup state used to live only in memory, so quitting after a failed or
// cancelled download threw away the only record that it had ever been tried.
// Only a finished run is written -- progress is not worth a disk write per
// percent, and a run still going is already described by the live state.
// A success is written even though nothing reads it back: it is what
// overwrites an earlier failure note, so a retry that works stops the banner
// re-accusing the app on every launch that follows.
function saveAsrSetupState() {
  const status = asrRuntimeState.status;
  if (status !== 'error' && status !== 'cancelled' && status !== 'installed') return;
  try {
    fs.mkdirSync(ASR_RUNTIME, { recursive: true });
    fs.writeFileSync(asrSetupStatePath(), JSON.stringify({
      status,
      message: String(asrRuntimeState.message || ''),
      step: String(asrRuntimeState.step || ''),
    }));
  } catch (_) {}
}

// Restores an interrupted setup so the banner can explain itself on the next
// launch rather than starting over silent. The receipts on disk outrank the
// file: if both halves are present now the run finished, however it ended.
function loadAsrSetupState() {
  let saved = null;
  try {
    saved = JSON.parse(fs.readFileSync(asrSetupStatePath(), 'utf8'));
  } catch (_) {
    return;
  }
  if (!saved || typeof saved !== 'object') return;
  if (saved.status !== 'error' && saved.status !== 'cancelled') return;
  if (asrRuntimeManager && asrModelManager
    && asrRuntimeManager.installed() && asrModelManager.installed()) return;
  asrRuntimeState = {
    status: saved.status,
    progress: null,
    message: String(saved.message || 'Dictation setup did not finish.'),
    step: String(saved.step || 'engine'),
  };
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

function ps(args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', WIN32, ...args],
      { windowsHide: true, timeout: Number(timeoutMs) || 4000 },
      (err, stdout) => {
        if (err) return resolve('');
        resolve(String(stdout || '').trim());
      }
    );
  });
}

function findPython() {
  const configured = String(process.env.VOXDEN_PYTHON || '').trim();
  // The downloaded runtime wins over anything on the machine. It is the one
  // interpreter we know has faster-whisper in it, and preferring a system
  // Python would make dictation depend on what else the user happens to have
  // installed -- which is the whole problem this exists to remove.
  // VOXDEN_PYTHON still overrides, so a developer can point at their own env.
  const managed = asrRuntimeManager && asrRuntimeManager.installed();
  const locals = app.isPackaged
    ? [
      configured,
      managed ? managed.pythonPath : '',
      path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Python', 'Python312', 'python.exe'),
      path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Python', 'Python311', 'python.exe'),
      'python.exe',
    ]
    : [
      configured,
      managed ? managed.pythonPath : '',
      path.join(ROOT, '.venv', 'Scripts', 'python.exe'),
      path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Python', 'Python312', 'python.exe'),
      'python.exe',
    ];
  for (const p of locals) {
    if (!p) continue;
    if (p === 'python.exe') return p;
    if (fs.existsSync(p)) return p;
  }
  return 'python.exe';
}

// Voxden transcribes through a Python sidecar it does not bundle. When that
// interpreter is missing entirely, `execFile` fails before the sidecar can
// explain anything, so the explanation has to come from here. On a clean
// Windows box `python.exe` resolves to the Microsoft Store stub, which exits
// non-zero without ever running the script -- indistinguishable from ENOENT
// as far as the user is concerned, and the same fix applies to both.
function pythonLaunchError(err, py) {
  const code = err && err.code;
  const usedPathLookup = py === 'python.exe';
  if (code === 'ETIMEDOUT') {
    return 'The speech engine took too long to start. Restart Voxden to try again.';
  }
  if (code === 'ENOENT' || usedPathLookup) {
    return 'The speech engine is not set up on this PC yet.';
  }
  return 'Voxden could not run the speech engine (' + path.basename(py) + ').';
}

// Whether the Set up button has something to fix. A machine with no
// interpreter and one whose interpreter lacks faster-whisper are the same
// problem to a user, and the same download solves both -- but so is a setup
// that stopped halfway, which is not a failure the sidecar can report.
function asrRuntimeWouldHelp() {
  if (!asrRuntimeManager || !asrModelManager) return false;
  const hasRuntime = !!asrRuntimeManager.installed();
  const hasModel = !!asrModelManager.installed();
  if (hasRuntime && hasModel) return false;
  // Our own interpreter is here and its weights are not, which only happens
  // when setup was interrupted partway. That half-state used to hide the
  // offer for good: the engine starts, so sidecarState never reaches
  // "unavailable" again, and resolveModel quietly falls back to the bare
  // model name -- leaving faster-whisper to pull three gigabytes from Hugging
  // Face on the first dictation with nothing on screen to explain the wait.
  if (hasRuntime && !hasModel) return true;
  // Otherwise only offer where it is the actual problem. A machine with its
  // own working Python has no reason to be shown a 3 GB download -- without
  // the hosted model, resolveModel falls back to the model name and
  // faster-whisper fetches it from Hugging Face exactly as it always did.
  return sidecarState === 'unavailable';
}

function sendOverlay(extra) {
  // Cheap: the signature check exits before building anything unless the
  // dictation actually started or finished.
  refreshTray();
  if (extra && extra.mode === 'idle') {
    overlayEditing = false;
    if (overlayWin && !overlayWin.isDestroyed()) {
      try {
        overlayWin.setSize(220, 84);
        positionOverlay();
      } catch (_) {}
    }
  }
  if (!overlayWin || overlayWin.isDestroyed()) return;
  overlayWin.webContents.send('state', Object.assign({
    mode,
    engine,
    engineStatus: sidecarState,
    model: engineModel,
    device: engineDevice,
    asrEngineActive: engineBackend,
    fastEngine: engineFastBackend,
    dictateMode: settings.dictateMode,
    shortcut: settings.shortcut,
    shortcutLabel: formatShortcutLabel(settings.shortcut),
    alwaysShowFlowBar: settings.alwaysShowFlowBar,
    soundsEnabled: settings.soundsEnabled,
    contextAwareness: settings.contextAwareness,
    dictationQuality: settings.dictationQuality,
    microphone: settings.microphone || 'default',
    canRetry: corpus.hasRetry(),
  }, extra || {}));
}

let overlayIgnoreMouse = null;
let overlayEditing = false;

function overlaySize() {
  // The window is bottom-anchored, so extra height is headroom above the pill.
  // It has to clear the tallest shape plus its glow, or the halo gets cut off.
  if (overlayEditing) return { ww: 380, wh: 110 };
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
  if (mode === 'arming' || mode === 'recording' || mode === 'transcribing' || mode === 'success' || mode === 'error' || mode === 'cancel') return;
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
  const icon = windowIconPath() || appIconPath();
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
  applyWindowIcon(overlayWin);
  overlayWin.once('ready-to-show', () => {
    applyWindowIcon(overlayWin);
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
  const icon = windowIconPath() || appIconPath();
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
  applyWindowIcon(historyWin);
  historyWin.loadFile(path.join(__dirname, 'app.html'));
  historyWin.on('ready-to-show', () => {
    applyWindowIcon(historyWin);
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

// settingsCat opens the window straight onto one settings pane, which is how
// the tray reaches things it has no business duplicating in a menu.
function openHistory(settingsCat) {
  if (!historyWin || historyWin.isDestroyed()) createHistoryWindow();
  applyWindowIcon(historyWin);
  try { historyWin.setSkipTaskbar(false); } catch (_) {}
  historyWin.show();
  historyWin.focus();
  try {
    historyHwnd = nativeHwnd(historyWin.getNativeWindowHandle());
  } catch (_) {}
  historyWin.webContents.send('history-updated', snapshot());
  if (!settingsCat) return;
  const cat = String(settingsCat);
  // A window created a moment ago has not loaded app.js yet, so a message sent
  // now lands nowhere. Hold it for the app-ready the renderer sends on load --
  // the same handshake the initial snapshot already relies on.
  if (historyWin.webContents.isLoading()) pendingSettingsCat = cat;
  else historyWin.webContents.send('open-settings', cat);
}

function setDictateMode(next) {
  if (next !== 'ptt' && next !== 'toggle') return;
  settings.dictateMode = next;
  if (next === 'toggle') stopPttWatch();
  saveSettings();
  broadcast();
}

function setDictationQuality(next) {
  settings.dictationQuality = style.normalizeDictationQuality(next);
  saveSettings();
  broadcast();
}

function setMicrophone(id) {
  const next = String(id || 'default');
  if (settings.microphone === next) return;
  settings.microphone = next;
  saveSettings();
  broadcast();
}

// The device the tray should show as chosen. A microphone that has since been
// unplugged must not leave every radio unchecked, so an id that is no longer in
// the list reads as the system default -- which is what capture falls back to
// anyway.
function activeMicId() {
  const current = settings.microphone || 'default';
  if (current === 'default') return 'default';
  return micDevices.some((d) => d.id === current) ? current : 'default';
}

function microphoneSubmenu() {
  const active = activeMicId();
  const defaultDevice = micDevices.find((d) => d.id === micDefaultId);
  const items = [{
    label: defaultDevice ? 'System default (' + defaultDevice.label + ')' : 'System default',
    type: 'radio',
    checked: active === 'default',
    click: () => setMicrophone('default'),
  }];
  if (micDevices.length) {
    items.push({ type: 'separator' });
    for (const device of micDevices) {
      items.push({
        label: device.label,
        type: 'radio',
        checked: active === device.id,
        click: () => setMicrophone(device.id),
      });
    }
  }
  items.push({ type: 'separator' });
  // The pane has the level meter and the device test, which a menu cannot show.
  items.push({ label: 'Microphone settings…', click: () => openHistory('microphone') });
  return items;
}

function setTrayFlag(key, value) {
  settings[key] = !!value;
  saveSettings();
  if (key === 'launchAtLogin') applySystemSettings();
  broadcast();
}

// Everything the menu reads, flattened. Rebuilding on every overlay tick would
// be wasteful and rebuilding only at startup would leave the menu lying about
// its own checkboxes, so the rebuild is driven by whether any of this changed.
function trayMenuSignature() {
  return [
    mode === 'arming' || mode === 'recording' ? 'busy' : 'idle',
    settings.shortcut,
    settings.pasteLastShortcut,
    settings.dictateMode,
    style.normalizeDictationQuality(settings.dictationQuality),
    settings.verbatimMode ? 'v1' : 'v0',
    settings.muteMusicWhileDictating !== false ? 'm1' : 'm0',
    settings.launchAtLogin ? 'l1' : 'l0',
    lastDictationText() ? 'paste' : 'nopaste',
    activeMicId(),
    micDefaultId,
    micDevices.map((d) => d.id + ':' + d.label).join(','),
  ].join('|');
}

function buildTrayTemplate() {
  const busy = mode === 'arming' || mode === 'recording';
  const quality = style.normalizeDictationQuality(settings.dictationQuality);
  return [
    { label: 'Open Voxden', click: () => openHistory() },
    { type: 'separator' },
    {
      // The one item whose label is worth changing: from the tray there is no
      // other sign of whether a dictation is already running.
      label: busy ? 'Finish dictation' : 'Start dictation',
      // Display only. globalShortcut already owns these chords, and a menu
      // accelerator would bind a second handler to the same keys. Electron
      // never validates the string here -- it renders whatever it is given --
      // so an unregistrable shortcut still shows correctly next to the label.
      accelerator: settings.shortcut,
      registerAccelerator: false,
      click: () => dictationHotkeyHandler(),
    },
    {
      label: 'Paste last dictation',
      accelerator: settings.pasteLastShortcut,
      registerAccelerator: false,
      enabled: !!lastDictationText(),
      click: () => { pasteLastDictation().catch(() => {}); },
    },
    { type: 'separator' },
    {
      label: 'Dictation mode',
      submenu: [
        { label: 'Toggle', type: 'radio', checked: !isPtt(), click: () => setDictateMode('toggle') },
        { label: 'Push to talk', type: 'radio', checked: isPtt(), click: () => setDictateMode('ptt') },
      ],
    },
    {
      label: 'Dictation speed',
      submenu: [
        { label: 'Auto', type: 'radio', checked: quality === 'auto', click: () => setDictationQuality('auto') },
        { label: 'Fast', type: 'radio', checked: quality === 'fast', click: () => setDictationQuality('fast') },
        { label: 'Accurate', type: 'radio', checked: quality === 'accurate', click: () => setDictationQuality('accurate') },
      ],
    },
    { label: 'Microphone', submenu: microphoneSubmenu() },
    {
      label: 'Verbatim mode',
      type: 'checkbox',
      checked: !!settings.verbatimMode,
      click: (item) => setTrayFlag('verbatimMode', item.checked),
    },
    {
      label: 'Mute music while dictating',
      type: 'checkbox',
      checked: settings.muteMusicWhileDictating !== false,
      click: (item) => setTrayFlag('muteMusicWhileDictating', item.checked),
    },
    { type: 'separator' },
    {
      // Deep links rather than a mirror of the settings screen. The microphone
      // list in particular is enumerated by the renderer, so pointing at the
      // pane that owns it beats keeping a second copy here that goes stale
      // whenever the window has not been opened.
      label: 'Settings',
      submenu: [
        { label: 'General', click: () => openHistory('general') },
        // Microphone is deliberately absent: it has its own submenu above, and
        // that one already links into this pane.
        { label: 'Dictation language', click: () => openHistory('dictation-language') },
        { label: 'Sound', click: () => openHistory('sound') },
        { label: 'Data and privacy', click: () => openHistory('privacy') },
      ],
    },
    {
      label: 'Start with Windows',
      type: 'checkbox',
      checked: !!settings.launchAtLogin,
      click: (item) => setTrayFlag('launchAtLogin', item.checked),
    },
    {
      label: 'Check for updates…',
      click: () => {
        // Opened first: a check with no window to report into looks like the
        // menu item did nothing.
        openHistory('system');
        updater.checkNow().then(broadcast).catch(() => {});
      },
    },
    { type: 'separator' },
    { label: 'Exit Voxden', click: () => app.quit() },
  ];
}

function refreshTray() {
  if (!tray || tray.isDestroyed()) return;
  const sig = trayMenuSignature();
  if (sig === trayMenuSig) return;
  trayMenuSig = sig;
  try {
    tray.setContextMenu(Menu.buildFromTemplate(buildTrayTemplate()));
  } catch (_) {
    // This runs from sendOverlay, which fires mid-dictation. A tray that failed
    // to rebuild is worth far less than a recording, so it must not throw into
    // the caller.
    trayMenuSig = '';
  }
}

function createTray() {
  const img = trayImage();
  tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img);
  tray.setToolTip('Voxden');
  trayMenuSig = '';
  refreshTray();
  tray.on('double-click', () => openHistory());
}

function muteMusicEnabled() {
  return settings.muteMusicWhileDictating !== false;
}

function pauseBackgroundMedia() {
  if (!muteMusicEnabled() || mediaPausedByUs) return Promise.resolve();
  if (mediaPausePromise) return mediaPausePromise;
  const task = ps(['media-pause']).then((out) => {
    pausedMediaIds = String(out || '')
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    mediaPausedByUs = pausedMediaIds.length > 0;
  });
  const wrapped = task.finally(() => {
    if (mediaPausePromise === wrapped) mediaPausePromise = null;
  });
  mediaPausePromise = wrapped;
  return wrapped;
}

async function resumeBackgroundMedia() {
  // A short dictation can finish while the Windows media request is still in
  // flight. Wait for it here so a late pause cannot leave music suspended.
  const pending = mediaPausePromise;
  if (pending) {
    try { await pending; } catch (_) {}
  }
  // A new dictation may have started while the pending pause completed. Its
  // eventual completion will resume the same sessions.
  if (mode === 'arming' || mode === 'recording' || mode === 'transcribing') return;
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

async function captureDictationContext() {
  dictationContext = { selectedText: '', clipboardText: '', windowText: '' };
  if (!settings.contextAwareness) return dictationContext;
  try { dictationContext.clipboardText = rewriter.clipContext(clipboard.readText()); } catch (_) {}
  const hwnd = String(lastHwnd || '0');
  ps(['ocr', '-Hwnd', hwnd], 12000).then((text) => {
    dictationContext.windowText = rewriter.clipContext(text);
  }).catch(() => {});
  return dictationContext;
}

async function captureSelectionIfNeeded() {
  if (settings.selectedTextRewrite === false) return '';
  if (dictationContext.selectedText) return dictationContext.selectedText;
  const text = await ps(['selection', '-Hwnd', String(lastHwnd || '0')]);
  dictationContext.selectedText = rewriter.clipContext(text);
  return dictationContext.selectedText;
}

function startRecording(fromPtt) {
  if (mode === 'arming' || mode === 'recording' || mode === 'transcribing') return;
  const sessionToken = ++recordingSessionToken;
  if (successTimer) clearTimeout(successTimer);
  currentMarks = [];
  dictationContext = { selectedText: '', clipboardText: '', windowText: '' };
  recordingStartedAt = 0;
  lastDurationMs = 0;
  // Do not call this "recording" until the renderer has a live audio graph.
  // Short commands often begin immediately; showing the waveform while
  // getUserMedia is still starting silently clips their first word.
  mode = 'arming';
  showOverlay();
  sendOverlay({ mode: 'arming', reveal: true });
  registerEscape(true);
  if (fromPtt && isPtt()) startPttWatch();

  // The foreground-window poll already gives us a usable cached paste target.
  // Refresh its metadata and pause media in parallel without holding up mic/UI.
  rememberFocus().then(() => {
    if (sessionToken !== recordingSessionToken) return;
    if (mode !== 'arming' && mode !== 'recording' && mode !== 'transcribing') return;
    return captureDictationContext();
  }).catch(() => {});
  pauseBackgroundMedia().catch(() => {});
}

async function requestStop() {
  if (mode === 'arming') {
    cancelListen();
    return;
  }
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
  if (mode !== 'arming' && mode !== 'recording' && mode !== 'transcribing') return;
  currentMarks = [];
  recordingStartedAt = 0;
  lastDurationMs = 0;
  flashCancel();
}

async function pasteText(text, sendKeys) {
  const prev = clipboard.readText();
  clipboard.writeText(text);
  try { overlayWin && overlayWin.setFocusable(false); } catch (_) {}
  await ps(['paste', '-Hwnd', String(lastHwnd || '0')]);
  const send = String(sendKeys || '').trim().toLowerCase();
  if (send === 'enter' || send === 'ctrl-enter') {
    await ps(['send', '-Hwnd', String(lastHwnd || '0'), '-Keys', send]);
  }
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
    original: meta && typeof meta.rawAsr === 'string' ? meta.rawAsr : text,
    mark: toRelMark(markAbs),
  };
  if (lastDurationMs > 0) entry.durationMs = lastDurationMs;
  if (meta) {
    if (meta.exe) entry.exe = meta.exe;
    if (meta.title) entry.title = meta.title;
    if (meta.category) entry.category = meta.category;
    if (typeof meta.dictionaryHits === 'number') entry.dictionaryHits = meta.dictionaryHits;
    if (typeof meta.styleFixes === 'number') entry.styleFixes = meta.styleFixes;
    const traceFields = [
      'rawAsr', 'afterCleanup', 'afterDedupe', 'afterDictionary',
      'afterDeterministic', 'rewriteCandidate', 'rewriteStatus', 'rewriteMessage',
      'asrEngine', 'dictationQuality',
    ];
    for (const field of traceFields) {
      if (typeof meta[field] === 'string') entry[field] = meta[field];
    }
    if (typeof meta.rewriteApplied === 'boolean') entry.rewriteApplied = meta.rewriteApplied;
  }
  lastDurationMs = 0;
  history.entries.unshift(entry);
  if (history.entries.length > 400) history.entries.length = 400;
  if (settings.keepTrainingAudio) corpus.claim(entry.id);
  else corpus.dropParked();
  saveHistory();
  broadcast();
  currentMarks = [];
  return entry;
}

async function rewriteWithLanguagePack(text, options) {
  const original = String(text || '').trim();
  const opts = options || {};
  const transform = opts.mode === 'transform';
  const failText = transform ? '' : original;
  if (!settings.smartRewriteEnabled && !opts.force) {
    return {
      text: failText,
      applied: false,
      status: 'disabled',
      message: 'Sentence correction is off.',
    };
  }
  const installed = languagePackManager && languagePackManager.installed(settings.languagePack);
  if (!installed || !localRewriteRuntime) {
    return {
      text: failText,
      applied: false,
      status: 'fallback',
      message: 'Language pack unavailable; safe cleanup was used.',
    };
  }
  try {
    rewriteState = { status: 'loading', message: 'Loading your local language pack…' };
    const runtime = await localRewriteRuntime.ensureStarted(installed);
    return rewriter.rewriteTranscript(original, Object.assign({}, opts, {
      enabled: true,
      endpoint: runtime.endpoint,
      model: runtime.model,
      provider: 'openai',
      apiKey: runtime.apiKey,
      timeoutMs: Number(opts.timeoutMs) || 15000,
    }));
  } catch (err) {
    return {
      text: failText,
      applied: false,
      status: 'fallback',
      message: (err && err.message ? err.message : 'Local language pack unavailable') + '; safe cleanup was used.',
    };
  }
}

// Every dictation path ends the same way. Keeping the tail in one place is
// what stops the verbatim path from drifting away from the styled one.
async function pasteDictation(text, category) {
  try { overlayWin && overlayWin.setFocusable(false); } catch (_) {}
  await pasteText(text, style.autoSendFor(category, settings));
}

function finishDictation(text, meta) {
  mode = 'success';
  const entry = addHistoryEntry(text, meta);
  sendOverlay({ mode: 'success', text, entryId: entry.id });
  registerEscape(false);
  resumeBackgroundMedia();
  if (successTimer) clearTimeout(successTimer);
  successTimer = setTimeout(() => {
    mode = 'idle';
    sendOverlay({ mode: 'idle' });
  }, corpus.hasRetry() ? 4000 : 1600);
  return entry;
}

async function onTranscript(raw) {
  const category = style.classifyTarget(lastTarget.exe, lastTarget.title);
  const tone = style.toneForCategory(category, settings.writingStyles);
  const quality = currentDictationQuality();
  const context = dictationContext || {};
  const cleaned = cleanup(raw);
  let selectedText = context.selectedText || '';
  if (settings.selectedTextRewrite !== false && rewriter.matchRewriteCommand(cleaned)) {
    selectedText = await captureSelectionIfNeeded();
  }
  const rewriteCommand = settings.selectedTextRewrite !== false
    && selectedText
    && rewriter.matchRewriteCommand(cleaned);

  if (rewriteCommand) {
    const rewriteResult = await rewriteWithLanguagePack(cleaned, {
      mode: 'transform',
      selectedText: selectedText,
      tone,
      category,
      dictionaryTerms: dictionary.phrases.map((p) => p.to),
    });
    rewriteState = { status: rewriteResult.status, message: rewriteResult.message };
    const styled = dedupeRepeats(style.finalizeStyle(rewriteResult.text, tone));
    if (!styled || rewriteResult.status === 'fallback' || rewriteResult.status === 'disabled') {
      flashError(rewriteResult.message || 'Rewrite failed');
      return;
    }
    await pasteDictation(styled, category);
    const selectedWords = String(selectedText || '').trim().split(/\s+/).filter(Boolean);
    const styledWords = String(styled || '').trim().split(/\s+/).filter(Boolean);
    if (selectedWords.length && selectedWords.length <= 8 && styledWords.length <= 8) {
      const proposals = dict.propose(
        selectedText, styled, dictionary.phrases, dictionary.pending
      );
      if (proposals.length) {
        dictionary.pending = dict.queuePending(dictionary.pending, proposals);
        saveDict();
      }
    }
    finishDictation(styled, {
      exe: lastTarget.exe || '',
      title: lastTarget.title || '',
      category,
      dictionaryHits: 0,
      styleFixes: insights.wordDiffCount(selectedText, styled),
    });
    return;
  }

  // Verbatim pastes what was said. Repeat collapsing, tone, and the
  // language-pack rewrite all exist to change words, so none of them run.
  // The dictionary is the one stage that can stay: it corrects spellings the
  // engine got wrong rather than words the speaker chose, so it is opt-in.
  if (settings.verbatimMode) {
    const verbatim = cleanupVerbatim(raw);
    const verbatimDict = settings.verbatimDictionary
      ? dict.applyDictionary(verbatim, dict.matchList(dictionary), true)
      : { text: verbatim, hits: 0 };
    if (!verbatimDict.text) {
      flashError('No speech');
      return;
    }
    // rewriteState is deliberately untouched: smartRewriteSnapshot() already
    // reports verbatim, and writing here would leave a stale message behind
    // once verbatim is switched back off.
    await pasteDictation(verbatimDict.text, category);
    finishDictation(verbatimDict.text, {
      exe: lastTarget.exe || '',
      title: lastTarget.title || '',
      category,
      dictionaryHits: verbatimDict.hits || 0,
      styleFixes: 0,
      rawAsr: String(raw || '').trim(),
      afterCleanup: verbatim,
      afterDictionary: verbatimDict.text,
      rewriteStatus: 'skipped',
      rewriteMessage: 'Verbatim mode pasted your exact words.',
      rewriteApplied: false,
      asrEngine: asrEngineFor(quality),
      dictationQuality: quality,
    });
    return;
  }

  const deduped = dedupeRepeats(cleaned);
  const dictResult = dict.applyDictionary(deduped, dict.matchList(dictionary), true);
  const text = dictResult.text;
  if (!text) {
    flashError('No speech');
    return;
  }
  const deterministic = dedupeRepeats(style.applyStyleWithTone(text, tone));
  let rewriteResult;
  if (quality === 'fast') {
    rewriteResult = {
      text: deterministic,
      applied: false,
      status: 'skipped',
      message: 'Fast dictation skipped sentence correction.',
    };
  } else {
    rewriteResult = await rewriteWithLanguagePack(deterministic, {
      tone,
      category,
      dictionaryTerms: dictionary.phrases.map((p) => p.to),
      selectedText: context.selectedText,
      clipboardText: context.clipboardText,
      windowText: context.windowText,
    });
  }
  rewriteState = { status: rewriteResult.status, message: rewriteResult.message };
  const styled = dedupeRepeats(style.finalizeStyle(rewriteResult.text, tone));
  if (!styled) {
    flashError('No speech');
    return;
  }
  await pasteDictation(styled, category);
  finishDictation(styled, {
    exe: lastTarget.exe || '',
    title: lastTarget.title || '',
    category,
    dictionaryHits: dictResult.hits || 0,
    styleFixes: insights.wordDiffCount(raw, deduped) + insights.wordDiffCount(text, styled),
    rawAsr: String(raw || '').trim(),
    afterCleanup: cleaned,
    afterDedupe: deduped,
    afterDictionary: text,
    afterDeterministic: deterministic,
    rewriteCandidate: String(rewriteResult.candidate || rewriteResult.text || '').trim(),
    rewriteStatus: String(rewriteResult.status || ''),
    rewriteMessage: String(rewriteResult.message || ''),
    rewriteApplied: !!rewriteResult.applied,
    asrEngine: asrEngineFor(quality),
    dictationQuality: quality,
  });
}

async function retryLast() {
  if (mode === 'arming' || mode === 'recording' || mode === 'transcribing') return;
  const file = corpus.retryPath();
  if (!file) {
    flashError('Nothing to retry');
    return;
  }
  if (successTimer) clearTimeout(successTimer);
  mode = 'transcribing';
  showOverlay();
  sendOverlay({ mode: 'transcribing', reveal: true });
  registerEscape(true);
  try {
    const text = await sidecarTranscribe(file);
    await onTranscript(text);
  } catch (err) {
    flashError(friendlyEngineError((err && err.message) || 'Retry failed'));
  }
}

function flashError(msg) {
  stopPttWatch();
  markerSend('STOP');
  // This dictation produced no entry, so its clip has nothing to be labelled
  // with. Drop it rather than leave it for the next entry to claim.
  corpus.dropParked();
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

// Escape and the overlay's X are deliberate. They tear down the same way a
// failure does, but they are not failures -- reporting one as "Transcription
// failed" told the user their dictation broke when they were the one who
// stopped it.
function flashCancel() {
  stopPttWatch();
  markerSend('STOP');
  corpus.dropParked();
  registerEscape(false);
  recordingStartedAt = 0;
  lastDurationMs = 0;
  resumeBackgroundMedia();
  mode = 'cancel';
  showOverlay();
  try { overlayWin && overlayWin.setFocusable(false); } catch (_) {}
  sendOverlay({ mode: 'cancel', text: 'Cancelled' });
  if (successTimer) clearTimeout(successTimer);
  successTimer = setTimeout(() => {
    mode = 'idle';
    sendOverlay({ mode: 'idle' });
  }, 1200);
}

function toggleListen() {
  if (mode === 'idle' || mode === 'success' || mode === 'error' || mode === 'cancel') {
    startRecording(false);
  } else if (mode === 'arming' || mode === 'recording') {
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
  // A modifier-only chord is already being watched edge by edge, and that
  // watcher stops the recording on release. A second poller would race it.
  if (chordWatch) return;
  // Watch the chord the user actually bound. Polling VK_SPACE regardless of the
  // hotkey meant hold-to-dictate never released on anything that did not end in
  // Space -- Ctrl+Alt+V recorded until the hotkey was pressed a second time.
  const groups = hotkeys.acceleratorVkGroups(settings.shortcut);
  if (!groups.length) {
    // Nothing pollable (a hand-edited settings file, say). Leave the watch off
    // rather than spin on a poll that can never fire; the hotkey handler still
    // stops the recording on the next press, so push-to-talk degrades to
    // toggle instead of recording forever.
    stopPttWatch();
    return;
  }
  const encoded = hotkeys.encodeVkGroups(groups);
  pttPolling = true;
  if (pttTimer) clearInterval(pttTimer);
  pttTimer = setInterval(async () => {
    if (!pttPolling) return;
    const down = await ps(['keys-down', '-Vks', encoded]);
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
    if (mode === 'arming' || mode === 'recording' || mode === 'transcribing') return;
    const hwnd = await ps(['get']);
    if (hwnd && !isOurHwnd(hwnd)) lastHwnd = hwnd;
  }, 500);
}

function tunedModelInfo() {
  return models.tunedModelInfo(MODELS);
}

// Whether the sidecar is running on the interpreter Voxden installed rather
// than one the user manages. It ships Whisper only and has no pip, so telling
// someone on it to install a package is advice they cannot act on.
function usingManagedRuntime() {
  const managed = asrRuntimeManager && asrRuntimeManager.installed();
  if (!managed) return false;
  return findPython() === managed.pythonPath;
}

function hostedModelPath() {
  const hosted = asrModelManager && asrModelManager.installed();
  return hosted ? hosted.path : null;
}

function resolveModel() {
  return models.resolveModel(MODELS, settings, process.env, hostedModelPath());
}

function usingTunedModel() {
  return models.usingTunedModel(MODELS, settings, process.env, hostedModelPath());
}

function restartSidecar() {
  sidecarRestarts = 0;
  sidecarStartToken += 1;
  if (!sidecar) {
    startSidecar();
    return;
  }
  sidecarRestartNow = true;
  try { sidecar.kill(); } catch (_) {}
}

function setSidecarState(state) {
  sidecarState = state;
  if (state === 'ready') finishSidecarWaiters(null);
  sendOverlay();
  broadcast();
}

function finishSidecarWaiters(err) {
  const list = sidecarReadyWaiters;
  sidecarReadyWaiters = [];
  for (const waiter of list) {
    clearTimeout(waiter.timer);
    if (err) waiter.reject(err);
    else waiter.resolve();
  }
}

function sidecarMayBecomeReady() {
  if (sidecar && sidecarReady) return false;
  if (sidecarRestartNow) return true;
  if (sidecar) return true;
  return sidecarState === 'starting' || sidecarState === 'loading';
}

function waitForSidecarReady(timeoutMs) {
  if (sidecar && sidecarReady) return Promise.resolve();
  if (!sidecarMayBecomeReady()) {
    return Promise.reject(new Error('speech engine not ready'));
  }
  return new Promise((resolve, reject) => {
    const waiter = { resolve, reject, timer: null };
    waiter.timer = setTimeout(() => {
      sidecarReadyWaiters = sidecarReadyWaiters.filter((item) => item !== waiter);
      reject(new Error('speech engine not ready'));
    }, Number(timeoutMs) || 600000);
    sidecarReadyWaiters.push(waiter);
  });
}

function startSidecar() {
  const startToken = ++sidecarStartToken;
  const py = findPython();
  const env = Object.assign({}, process.env, {
    HF_HOME: process.env.HF_HOME || path.join(MODELS, 'huggingface'),
    VOXDEN_MODEL_DIR: MODELS,
    VOXDEN_MODEL: resolveModel(),
    // Retiring an engine from the picker must not delete the capability.
    // qwen3-asr is gone from Settings and migrated out of settings.json
    // because the runtime Voxden installs can never satisfy it -- but the
    // sidecar still carries the backend, so anyone running their own Python
    // with torch keeps a way in. Same shape as the device override below.
    VOXDEN_ASR_ENGINE: process.env.VOXDEN_ASR_ENGINE || settings.asrEngine,
    VOXDEN_DEVICE: process.env.VOXDEN_DEVICE || settings.asrDevice,
    // The optional CUDA pack, if it is installed. find_cuda_bin_dirs has
    // always read this variable and has always scanned nvidia/*/bin below it,
    // so the pack needed no sidecar change -- it is installed in the layout
    // pip would have written and named here.
    VOXDEN_CUDA_BIN: process.env.VOXDEN_CUDA_BIN
      || (cudaPackManager && cudaPackManager.installed()
        ? cudaPackManager.installed().packDir
        : ''),
    PYTHONUTF8: '1',
    PYTHONIOENCODING: 'utf-8',
    PYTHONUNBUFFERED: '1',
    // Xet stalls on the first Hub shard for some Windows networks.
    HF_HUB_DISABLE_XET: process.env.HF_HUB_DISABLE_XET || '1',
  });
  engineProgress = null;
  engineError = '';
  engineFix = '';
  engineFixEngine = '';
  sidecarProgressBuf = '';
  setSidecarState('starting');
  execFile(py, [SIDECAR, '--check'], { timeout: 20000, windowsHide: true, env }, (err, stdout) => {
    if (startToken !== sidecarStartToken || isQuitting) return;
    // Parse before looking at `err`. A missing dependency makes the sidecar
    // report the problem on stdout and then exit 1, which execFile surfaces as
    // an error -- so checking `err` first would throw away the one message that
    // actually tells the user which package to install.
    let parsed = null;
    try { parsed = JSON.parse(String(stdout).trim().split('\n').pop()); } catch (_) {}
    if (!parsed || !parsed.ok) {
      engine = 'webspeech';
      engineError = (parsed && parsed.error)
        ? String(parsed.error)
        : pythonLaunchError(err, py);
      setSidecarState('unavailable');
      finishSidecarWaiters(new Error('speech engine not ready'));
      return;
    }
    if (err) {
      engine = 'webspeech';
      engineError = pythonLaunchError(err, py);
      setSidecarState('unavailable');
      finishSidecarWaiters(new Error('speech engine not ready'));
      return;
    }
    if (parsed.model) engineModel = String(parsed.model);
    if (parsed.device) engineDevice = String(parsed.device);
    if (parsed.engine) engineBackend = String(parsed.engine);
    engineWarning = parsed.warning ? String(parsed.warning) : '';
    engineFix = parsed.warning_fix ? String(parsed.warning_fix) : '';
    engineFixEngine = parsed.warning_fix_engine ? String(parsed.warning_fix_engine) : '';
    engineAvailability = (parsed.engines && typeof parsed.engines === 'object')
      ? parsed.engines
      : {};
    // A choice this PC cannot honour is not a choice. Users who picked
    // Qwen3-ASR back when the picker offered it unconditionally kept that value
    // through every update, and it bought them a permanent "not installed on
    // this PC" banner for an engine no Voxden download has ever supplied. The
    // sidecar has already fallen back to Whisper by this point, so this only
    // makes the stored setting agree with what is running.
    if (settings.asrEngine !== 'whisper' && engineAvailability[settings.asrEngine] === false) {
      settings.asrEngine = 'whisper';
      try { saveSettings(); } catch (_) {}
      engineWarning = '';
      engineFix = '';
      engineFixEngine = '';
    }
    setSidecarState('loading');
    sidecar = spawn(py, [SIDECAR, '--serve'], {
      env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    sidecar.stdout.setEncoding('utf8');
    sidecar.stderr.on('data', (chunk) => {
      const parsedProgress = asr.parseEngineProgress(sidecarProgressBuf, String(chunk));
      sidecarProgressBuf = parsedProgress.buffer;
      if (parsedProgress.progress) {
        const nextProgress = {
          phase: parsedProgress.progress.phase,
          percent: parsedProgress.progress.percent,
          detail: parsedProgress.progress.detail || '',
        };
        if (!engineProgress
          || engineProgress.phase !== nextProgress.phase
          || engineProgress.percent !== nextProgress.percent
          || engineProgress.detail !== nextProgress.detail) {
          engineProgress = nextProgress;
          broadcast();
        }
      }
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
          engineProgress = null;
          engine = 'whisper';
          if (msg.model) engineModel = String(msg.model);
          if (msg.device) engineDevice = String(msg.device);
          if (msg.engine) engineBackend = String(msg.engine);
          engineFastBackend = msg.fast_engine ? String(msg.fast_engine) : '';
          engineFastModel = msg.fast_model ? String(msg.fast_model) : '';
          engineFastDevice = msg.fast_device ? String(msg.fast_device) : '';
          engineWarning = msg.warning ? String(msg.warning) : '';
          engineFix = msg.warning_fix ? String(msg.warning_fix) : '';
          engineFixEngine = msg.warning_fix_engine ? String(msg.warning_fix_engine) : '';
          engineError = '';
          sidecarRestarts = 0;
          setSidecarState('ready');
          continue;
        }
        if (!sidecarQueue.dispatch(msg)) continue;
      }
    });
    // spawn reports a missing or unrunnable interpreter through 'error', not
    // 'exit'. With no listener that is an unhandled EventEmitter error, which
    // in the main process means an uncaught exception and a crash dialog --
    // on exactly the machine this app is meant to set itself up on.
    // A failed spawn can emit both, and a second pass would schedule a second
    // restart on the same death.
    let gone = false;
    sidecar.on('error', () => handleSidecarGone());
    sidecar.on('exit', () => handleSidecarGone());
    function handleSidecarGone() {
      if (gone) return;
      gone = true;
      sidecar = null;
      sidecarReady = false;
      engineProgress = null;
      sidecarProgressBuf = '';
      engine = 'webspeech';
      engineFastBackend = '';
      engineFastModel = '';
      engineFastDevice = '';
      setSidecarState('unavailable');
      sidecarQueue.rejectAll(new Error('sidecar exited'));
      if (sidecarRestartNow) {
        sidecarRestartNow = false;
        if (!isQuitting) {
          setSidecarState('starting');
          setTimeout(() => { if (!isQuitting) startSidecar(); }, 250);
        }
      } else if (!isQuitting && sidecarRestarts < 3) {
        sidecarRestarts += 1;
        setSidecarState('starting');
        setTimeout(() => { if (!isQuitting) startSidecar(); }, 5000);
      } else {
        finishSidecarWaiters(new Error('speech engine not ready'));
      }
    }
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
  // Screen marks are a nicety. Losing them because there is no interpreter yet
  // is fine; crashing the app before the user can install one is not.
  markerProc.on('error', () => {
    markerProc = null;
    markerReady = false;
  });
  markerProc.on('exit', () => {
    markerProc = null;
    markerReady = false;
  });
}

function friendlyEngineError(msg) {
  const m = String(msg || '');
  if (/charmap|codec can't encode|character maps/i.test(m)) return "Couldn't send transcript — try again";
  if (/speech engine timeout|whisper timeout/i.test(m)) return 'Transcription timed out';
  if (/speech engine not ready|whisper not ready|sidecar exited/i.test(m)) return 'Speech engine not ready';
  if (m.length > 56) return 'Transcribe failed';
  return m || 'Transcribe failed';
}

function parkCompletedClip(buf) {
  if (!buf || !buf.length) return;
  corpus.parkRetry(buf);
  if (settings.keepTrainingAudio) corpus.park(buf);
}

// What the recogniser is asked for, which is not always what the dictation is.
// An accurate dictation on a CPU still goes through Parakeet and still gets
// sentence correction afterwards -- only the model changes.
// What this PC can do about GPU dictation. One call, so the environment the
// sidecar is started with and the card the user reads are answering the same
// question -- a second copy is how a settings panel ends up offering a
// download that the engine will not use.
function currentGpuPlan() {
  return gpu.gpuPlan(gpuDevices, !!(cudaPackManager && cudaPackManager.installed()));
}

// Electron knows the graphics without spawning anything, and it reports PCI
// vendor ids, which is the one identifier that survives a driver update or a
// rename. A failure here is not worth reporting: the plan then says "no usable
// GPU", which is the same answer as a PC that has none, and dictation still
// runs on the CPU.
async function detectGpu() {
  try {
    const info = await app.getGPUInfo('basic');
    gpuDevices = (info && Array.isArray(info.gpuDevice)) ? info.gpuDevice : [];
  } catch (_) {
    gpuDevices = [];
  }
}

function asrQualityFor(quality) {
  if (quality !== 'accurate') return quality;
  return asr.prefersFastAsr({
    device: engineDevice,
    fastEngine: engineFastBackend,
    language: settings.dictationLanguage,
  }) ? 'fast' : quality;
}

// Which engine actually ran, for the history entry and the insights that read
// it. Derived from the same call the request was, so the record cannot claim
// Whisper for a clip Parakeet recognised.
function asrEngineFor(quality) {
  return asrQualityFor(quality) === 'fast' && engineFastBackend
    ? engineFastBackend
    : engineBackend;
}

function currentDictationQuality() {
  const category = style.classifyTarget(lastTarget.exe, lastTarget.title);
  return style.dictationPath(category, settings, lastTarget, lastDurationMs);
}

async function sidecarTranscribe(wavPath, options) {
  const opts = options || {};
  await waitForSidecarReady(600000);
  return new Promise((resolve, reject) => {
    if (!sidecar || !sidecarReady) {
      reject(new Error('speech engine not ready'));
      return;
    }
    const id = sidecarQueue.nextId();
    sidecarQueue.register(id, (msg) => {
      if (msg && msg.ok) resolve(msg.text || '');
      else reject(new Error(friendlyEngineError((msg && msg.error) || 'speech engine failed')));
    }, reject, 60000);
    const prompt = dict.promptFrom(dictionary.phrases, history.entries, 64);
    const payload = {
      path: wavPath,
      language: settings.dictationLanguage || 'en',
      id,
    };
    if (prompt) payload.prompt = prompt;
    if (opts.vad === false) payload.vad = false;
    const quality = asrQualityFor(opts.quality || currentDictationQuality());
    if (quality === 'fast' || quality === 'accurate') payload.quality = quality;
    sidecar.stdin.write(JSON.stringify(payload) + '\n');
  });
}

function dictationHotkeyHandler() {
  if (mode === 'idle' || mode === 'success' || mode === 'error' || mode === 'cancel') startRecording(true);
  else if (mode === 'arming' || mode === 'recording') requestStop();
}

function lastDictationText() {
  const entry = history.entries && history.entries[0];
  return entry ? String(entry.text || '').trim() : '';
}

function flashHud(kind, text, ms) {
  const next = kind === 'error' ? 'error' : 'success';
  showOverlay();
  try { overlayWin && overlayWin.setFocusable(false); } catch (_) {}
  mode = next;
  sendOverlay({ mode: next, text: text || '', reveal: true });
  if (successTimer) clearTimeout(successTimer);
  successTimer = setTimeout(() => {
    mode = 'idle';
    sendOverlay({ mode: 'idle' });
  }, Number(ms) || 1600);
}

async function pasteLastDictation() {
  if (pasteLastBusy) return;
  if (mode === 'arming' || mode === 'recording' || mode === 'transcribing') return;
  const text = lastDictationText();
  if (!text) {
    flashHud('error', 'Nothing to paste', 1600);
    return;
  }
  pasteLastBusy = true;
  try {
    await rememberFocus();
    try { overlayWin && overlayWin.setFocusable(false); } catch (_) {}
    await pasteText(text);
    flashHud('success', text, 1200);
  } finally {
    pasteLastBusy = false;
  }
}

function sameShortcut(a, b) {
  return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
}

function unregisterDictationShortcut() {
  if (registeredShortcut) {
    try { globalShortcut.unregister(registeredShortcut); } catch (_) {}
    registeredShortcut = null;
  }
}

function unregisterPasteLastShortcut() {
  if (registeredPasteShortcut) {
    try { globalShortcut.unregister(registeredPasteShortcut); } catch (_) {}
    registeredPasteShortcut = null;
  }
}

const shortcutFailureReason = hotkeys.shortcutFailureReason;

function stopChordWatch() {
  if (!chordWatch) return;
  const proc = chordWatch;
  chordWatch = null;
  chordWatchAccel = '';
  try { proc.kill(); } catch (_) {}
}

// Ctrl+Win and friends cannot go through globalShortcut, so a helper process
// polls the key state and reports the edges. See WatchChord in scripts/win32.ps1
// for why the loop lives there rather than here.
function startChordWatch(accel) {
  stopChordWatch();
  const encoded = hotkeys.encodeVkGroups(hotkeys.acceleratorVkGroups(accel));
  if (!encoded) return false;
  let proc;
  try {
    proc = spawn(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', WIN32, '-Action', 'hotkey-watch', '-Vks', encoded],
      { windowsHide: true }
    );
  } catch (_) {
    return false;
  }
  chordWatch = proc;
  chordWatchAccel = accel;
  let buf = '';
  proc.stdout.on('data', (chunk) => {
    buf += String(chunk);
    const lines = buf.split(/\r?\n/);
    buf = lines.pop() || '';
    for (const line of lines) {
      const msg = line.trim();
      if (!msg) continue;
      // Push to talk wants the edges; toggle wants one event per press, and it
      // has to be the release -- "dirty" is how a chord that was really
      // Ctrl+Win+Left stays a virtual-desktop switch and nothing more.
      if (isPtt()) {
        if (msg === 'DOWN') startRecording(true);
        // Push to talk cannot know a chord is dirty until it ends, so it starts
        // recording either way and throws the result out rather than leaving a
        // stray transcript behind every virtual-desktop switch.
        else if (msg === 'UP dirty') cancelListen();
        else if (msg.startsWith('UP')) requestStop();
      } else if (msg === 'UP clean') {
        dictationHotkeyHandler();
      }
    }
  });
  proc.on('exit', () => {
    if (chordWatch === proc) {
      chordWatch = null;
      chordWatchAccel = '';
    }
  });
  return true;
}

function tryRegisterDictationShortcut(accel) {
  unregisterDictationShortcut();
  stopChordWatch();
  const candidate = accel || settings.shortcut || 'CommandOrControl+Shift+Space';
  if (sameShortcut(candidate, settings.pasteLastShortcut)) {
    return { ok: false, reason: formatShortcutLabel(candidate) + ' is already used to paste your last dictation.' };
  }
  if (hotkeys.isModifierOnly(candidate)) {
    if (!startChordWatch(candidate)) {
      return { ok: false, reason: formatShortcutLabel(candidate) + ' could not be watched. Try another combination.' };
    }
    registeredShortcut = null;
    return { ok: true, reason: '' };
  }
  try {
    const ok = globalShortcut.register(candidate, dictationHotkeyHandler);
    if (!ok) return { ok: false, reason: shortcutFailureReason(candidate, false) };
    registeredShortcut = candidate;
    return { ok: true, reason: '' };
  } catch (_) {
    return { ok: false, reason: shortcutFailureReason(candidate, true) };
  }
}

function tryRegisterPasteLastShortcut(accel) {
  unregisterPasteLastShortcut();
  const candidate = accel || settings.pasteLastShortcut || 'CommandOrControl+Alt+V';
  if (sameShortcut(candidate, settings.shortcut)) {
    return { ok: false, reason: formatShortcutLabel(candidate) + ' is already used for dictation.' };
  }
  try {
    const ok = globalShortcut.register(candidate, () => {
      pasteLastDictation().catch(() => {});
    });
    if (!ok) return { ok: false, reason: shortcutFailureReason(candidate, false) };
    registeredPasteShortcut = candidate;
    return { ok: true, reason: '' };
  } catch (_) {
    return { ok: false, reason: shortcutFailureReason(candidate, true) };
  }
}

function registerHotkeys() {
  // A hotkey that will not register at launch gets swapped for the default.
  // That used to happen in total silence: the shortcut shown in settings was
  // simply not the one the user picked, with nothing to say why. The notice
  // stands until the shortcut is changed or the app is restarted.
  //
  // settings.shortcut is reassigned but deliberately not saved -- next launch
  // should try the user's real choice again, in case whatever was holding the
  // chord is gone.
  const notices = [];

  const dictation = tryRegisterDictationShortcut(settings.shortcut);
  if (!dictation.ok) {
    settings.shortcut = 'CommandOrControl+Shift+Space';
    const fallback = tryRegisterDictationShortcut(settings.shortcut);
    notices.push(dictation.reason + (fallback.ok
      ? ' Dictation is on ' + formatShortcutLabel(settings.shortcut) + ' for now.'
      : ' Dictation has no shortcut right now.'));
  }

  const paste = tryRegisterPasteLastShortcut(settings.pasteLastShortcut);
  if (!paste.ok) {
    settings.pasteLastShortcut = sameShortcut(settings.shortcut, 'CommandOrControl+Alt+V')
      // "Period" is not an accelerator name Electron accepts -- it throws on
      // conversion, which this function's catch turned into "no paste hotkey at
      // all". The literal character is the spelling that registers.
      ? 'CommandOrControl+Shift+.'
      : 'CommandOrControl+Alt+V';
    const fallback = tryRegisterPasteLastShortcut(settings.pasteLastShortcut);
    notices.push(paste.reason + (fallback.ok
      ? ' Paste last is on ' + formatShortcutLabel(settings.pasteLastShortcut) + ' for now.'
      : ' Paste last has no shortcut right now.'));
  }

  hotkeyNotice = notices.join(' ');
}

ipcMain.on('hud-ready', () => {
  sendOverlay({ mode: 'idle' });
  if (settings.alwaysShowFlowBar) {
    showOverlay();
    sendOverlay({ reveal: true });
  }
});
ipcMain.on('capture-ready', (e) => {
  if (!overlayWin || overlayWin.isDestroyed() || e.sender !== overlayWin.webContents) return;
  if (mode !== 'arming') return;
  recordingStartedAt = Date.now();
  mode = 'recording';
  if (settings.contextAwareness) markerSend('START');
  sendOverlay({ mode: 'recording' });
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
    if (pendingSettingsCat) {
      historyWin.webContents.send('open-settings', pendingSettingsCat);
      pendingSettingsCat = '';
    }
  }
});
ipcMain.on('mic-devices', (e, payload) => {
  if (!historyWin || historyWin.isDestroyed() || e.sender !== historyWin.webContents) return;
  const list = (payload && Array.isArray(payload.devices)) ? payload.devices : [];
  micDevices = list
    .filter((d) => d && d.id)
    .map((d) => ({ id: String(d.id), label: String(d.label || 'Microphone') }));
  micDefaultId = String((payload && payload.defaultId) || '');
  refreshTray();
});
ipcMain.on('open-history', () => openHistory());
ipcMain.handle('toggle', async () => { toggleListen(); return { mode, engine }; });
ipcMain.on('hud-cancel', () => cancelListen());
ipcMain.on('hud-confirm', () => {
  if (mode === 'arming' || mode === 'recording') requestStop();
  else if (mode === 'success' || mode === 'error') retryLast();
});
ipcMain.on('overlay-hold', () => {
  if (successTimer) {
    clearTimeout(successTimer);
    successTimer = null;
  }
  overlayEditing = true;
  try { overlayWin && overlayWin.setFocusable(true); } catch (_) {}
  if (overlayWin && !overlayWin.isDestroyed()) {
    const { ww, wh } = overlaySize();
    overlayWin.setSize(ww, wh);
    positionOverlay();
    overlayWin.focus();
  }
  setOverlayMouseIgnore(false);
});
ipcMain.on('overlay-release', () => {
  overlayEditing = false;
  try { overlayWin && overlayWin.setFocusable(false); } catch (_) {}
  if (overlayWin && !overlayWin.isDestroyed()) {
    const { ww, wh } = overlaySize();
    overlayWin.setSize(ww, wh);
    positionOverlay();
  }
  if (mode === 'success' || mode === 'error') {
    if (successTimer) clearTimeout(successTimer);
    successTimer = setTimeout(() => {
      mode = 'idle';
      sendOverlay({ mode: 'idle' });
    }, 1400);
  }
});
ipcMain.on('transcript', (_e, text) => onTranscript(text));
ipcMain.on('capture-failed', (_e, msg) => flashError(friendlyEngineError(msg || 'Mic error')));
ipcMain.on('cancelled', () => {
  mode = 'idle';
  registerEscape(false);
  try { overlayWin && overlayWin.setFocusable(false); } catch (_) {}
  sendOverlay({ mode: 'idle' });
});
ipcMain.handle('transcribe-local', async (_e, wav, options) => {
  const buf = Buffer.isBuffer(wav) ? wav : Buffer.from(wav);
  const opts = options || {};
  const tmp = path.join(os.tmpdir(), 'voxden-' + Date.now() + '-' + process.hrtime.bigint() + '.wav');
  fs.writeFileSync(tmp, buf);
  try {
    const text = await sidecarTranscribe(tmp, opts);
    // Hold the clip until the history entry it becomes can claim it. Without
    // this the audio is gone before the user ever gets to correct it.
    if (opts.park !== false) parkCompletedClip(buf);
    return text;
  } finally {
    fs.unlink(tmp, () => {});
  }
});
ipcMain.handle('park-audio', async (_e, wav) => {
  const buf = Buffer.isBuffer(wav) ? wav : Buffer.from(wav);
  parkCompletedClip(buf);
  return true;
});
ipcMain.handle('retry-last', async () => {
  await retryLast();
  return snapshot();
});
ipcMain.handle('app-load', async () => snapshot());
ipcMain.handle('smart-rewrite-check', async () => {
  const result = await rewriteWithLanguagePack('Um, I think we should leave.', {
    force: true,
    tone: 'formal',
    category: 'other',
    dictionaryTerms: [],
  });
  rewriteState = { status: result.status, message: result.message };
  broadcast();
  return Object.assign(snapshot(), { smartRewriteState: rewriteState });
});
ipcMain.handle('language-pack-install', async (_e, requestedTier) => {
  const tier = normalizeTier(requestedTier);
  settings.languagePack = tier;
  saveSettings();
  try {
    await languagePackManager.install(tier);
    settings.smartRewriteEnabled = true;
    rewriteState = { status: 'ready', message: 'Your language pack is installed and ready.' };
    languagePackState = {
      status: 'installed',
      tier,
      progress: 100,
      message: (tier === 'enhanced' ? 'Enhanced' : 'Standard') + ' is installed and ready.',
    };
    saveSettings();
  } catch (err) {
    if (err && err.code === 'CANCELLED') {
      languagePackState = { status: 'cancelled', tier, progress: null, message: err.message };
    } else {
      languagePackState = {
        status: 'error',
        tier,
        progress: null,
        message: err && err.message ? err.message : 'Language pack installation failed.',
      };
    }
  }
  broadcast();
  return snapshot();
});
ipcMain.handle('asr-runtime-install', async () => {
  try {
    await setupDictation();
    engineError = '';
    // The engine that was missing a moment ago now exists, so bring it up
    // rather than making the user restart Voxden to use what they downloaded.
    restartSidecar();
    if (!markerProc) startMarker();
  } catch (err) {
    const step = asrRuntimeState.step || 'engine';
    if (err && err.code === 'CANCELLED') {
      asrRuntimeState = { status: 'cancelled', progress: null, message: err.message, step };
    } else {
      asrRuntimeState = {
        status: 'error',
        progress: null,
        message: err && err.message ? err.message : 'Dictation could not be set up.',
        step,
      };
    }
  }
  saveAsrSetupState();
  broadcast();
  return snapshot();
});
ipcMain.handle('cuda-pack-install', async () => {
  if (!cudaPackManager) return snapshot();
  try {
    await cudaPackManager.install();
    // cuBLAS is read when CTranslate2 loads the model, so a running sidecar
    // would keep using the CPU it started on. Restarting is the difference
    // between a download that works now and one that works after a restart
    // nobody told the user to perform.
    restartSidecar();
  } catch (err) {
    cudaPackState = {
      status: err && err.code === 'CANCELLED' ? 'cancelled' : 'error',
      progress: null,
      message: err && err.message ? err.message : 'NVIDIA GPU support could not be installed.',
    };
  }
  broadcast();
  return snapshot();
});
ipcMain.handle('cuda-pack-cancel', async () => {
  if (cudaPackManager) cudaPackManager.cancel();
  return snapshot();
});
ipcMain.handle('cuda-pack-remove', async () => {
  if (cudaPackManager) {
    await cudaPackManager.remove();
    cudaPackState = { status: 'idle', progress: null, message: '' };
    // Back to the CPU, and again only on a restart.
    restartSidecar();
  }
  broadcast();
  return snapshot();
});
ipcMain.handle('asr-runtime-cancel', async () => {
  if (asrRuntimeManager) asrRuntimeManager.cancel();
  if (asrModelManager) asrModelManager.cancel();
  return snapshot();
});
ipcMain.handle('asr-runtime-remove', async () => {
  if (asrRuntimeManager) await asrRuntimeManager.remove();
  if (asrModelManager) await asrModelManager.remove();
  asrRuntimeState = { status: 'idle', progress: null, message: '', step: '' };
  // remove() clears the receipts but not this, and a stale failure note would
  // outlive the install it described.
  try { fs.rmSync(asrSetupStatePath(), { force: true }); } catch (_) {}
  restartSidecar();
  broadcast();
  return snapshot();
});
ipcMain.handle('language-pack-cancel', async () => {
  if (languagePackManager) languagePackManager.cancel();
  return snapshot();
});
ipcMain.handle('language-pack-remove', async (_e, requestedTier) => {
  const tier = normalizeTier(requestedTier);
  if (localRewriteRuntime) await localRewriteRuntime.stop();
  await languagePackManager.remove(tier);
  if (settings.languagePack === tier) settings.smartRewriteEnabled = false;
  languagePackState = {
    status: 'idle',
    tier,
    progress: null,
    message: (tier === 'enhanced' ? 'Enhanced' : 'Standard') + ' was removed from this PC.',
  };
  rewriteState = { status: 'disabled', message: 'Sentence correction is off.' };
  saveSettings();
  broadcast();
  return snapshot();
});
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
    if (sameShortcut(next, settings.pasteLastShortcut)) {
      return Object.assign(snapshot(), {
        shortcutError: formatShortcutLabel(next) + ' is already used to paste your last dictation.',
      });
    }
    settings.shortcut = next;
    const res = tryRegisterDictationShortcut(next);
    if (!res.ok) {
      settings.shortcut = prev;
      tryRegisterDictationShortcut(prev);
      // Say which chord and why, not just "unavailable" -- a Windows-reserved
      // combination is indistinguishable from a broken app otherwise.
      return Object.assign(snapshot(), { shortcutError: res.reason });
    }
    // The chord the user just picked works, so any standing launch-time notice
    // about the old one is stale.
    hotkeyNotice = '';
    saveSettings();
  }

  if (typeof patch.pasteLastShortcut === 'string' && patch.pasteLastShortcut.trim()) {
    const prev = settings.pasteLastShortcut;
    const next = patch.pasteLastShortcut.trim();
    if (sameShortcut(next, settings.shortcut)) {
      return Object.assign(snapshot(), {
        shortcutError: formatShortcutLabel(next) + ' is already used for dictation.',
      });
    }
    settings.pasteLastShortcut = next;
    const res = tryRegisterPasteLastShortcut(next);
    if (!res.ok) {
      settings.pasteLastShortcut = prev;
      tryRegisterPasteLastShortcut(prev);
      return Object.assign(snapshot(), { shortcutError: res.reason });
    }
    hotkeyNotice = '';
    saveSettings();
  }

  const boolKeys = [
    'launchAtLogin', 'alwaysShowFlowBar', 'sidebarCollapsed', 'showInTaskbar',
    'soundsEnabled', 'suggestionsEnabled', 'contextAwareness', 'muteMusicWhileDictating',
    'smartRewriteEnabled', 'verbatimMode', 'verbatimDictionary',
  ];
  for (const key of boolKeys) {
    if (typeof patch[key] === 'boolean') settings[key] = patch[key];
  }
  if (patch.smartRewriteEnabled === false && localRewriteRuntime) {
    await localRewriteRuntime.stop();
    rewriteState = { status: 'disabled', message: 'Sentence correction is off.' };
  }

  // Switching models means reloading the engine, so this cannot ride along
  // with the plain booleans above.
  if (typeof patch.useTunedModel === 'boolean'
      && patch.useTunedModel !== settings.useTunedModel) {
    settings.useTunedModel = patch.useTunedModel;
    if (tunedModelInfo()) restartSidecar();
  }

  const nextAsrEngine = patch.asrEngine === undefined
    ? settings.asrEngine
    : asr.normalizeAsrEngine(patch.asrEngine);
  const nextAsrDevice = patch.asrDevice === undefined
    ? settings.asrDevice
    : asr.normalizeAsrDevice(patch.asrDevice);
  if (nextAsrEngine !== settings.asrEngine || nextAsrDevice !== settings.asrDevice) {
    settings.asrEngine = nextAsrEngine;
    settings.asrDevice = nextAsrDevice;
    engineWarning = '';
    engineFix = '';
    engineFixEngine = '';
    engineError = '';
    restartSidecar();
  }

  // Turning recording off means the recordings go, not just the collecting.
  if (typeof patch.keepTrainingAudio === 'boolean') {
    settings.keepTrainingAudio = patch.keepTrainingAudio;
    if (!patch.keepTrainingAudio) corpus.clear();
  }

  if (typeof patch.dictationLanguage === 'string') {
    settings.dictationLanguage = asr.normalizeDictationLanguage(patch.dictationLanguage);
  }

  if (typeof patch.displayName === 'string') {
    settings.displayName = patch.displayName.trim().slice(0, 40);
  }

  if (typeof patch.microphone === 'string' && patch.microphone) {
    settings.microphone = patch.microphone;
  }

  if (patch.languagePack === 'standard' || patch.languagePack === 'enhanced') {
    const nextTier = normalizeTier(patch.languagePack);
    if (nextTier !== settings.languagePack && localRewriteRuntime) {
      await localRewriteRuntime.stop();
    }
    settings.languagePack = nextTier;
    languagePackState = {
      status: languagePackManager && languagePackManager.installed(nextTier) ? 'installed' : 'idle',
      tier: nextTier,
      progress: null,
      message: languagePackManager && languagePackManager.installed(nextTier)
        ? (nextTier === 'enhanced' ? 'Enhanced' : 'Standard') + ' is installed and ready.'
        : 'Download this language pack once to use it locally.',
    };
    rewriteState = { status: 'ready', message: 'Your language pack is installed and ready.' };
  }

  if (patch.writingStyles && typeof patch.writingStyles === 'object') {
    settings.writingStyles = style.normalizeWritingStyles(
      Object.assign({}, settings.writingStyles, patch.writingStyles)
    );
  }

  if (patch.dictationQuality !== undefined) {
    settings.dictationQuality = style.normalizeDictationQuality(patch.dictationQuality);
  }
  if (typeof patch.selectedTextRewrite === 'boolean') {
    settings.selectedTextRewrite = patch.selectedTextRewrite;
  }
  if (patch.autoSend && typeof patch.autoSend === 'object') {
    settings.autoSend = style.normalizeAutoSend(
      Object.assign({}, settings.autoSend, patch.autoSend)
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
    corpus.discard(id);
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

  // Retraction still runs: rules an older build learned silently must come
  // back out when the user corrects that transcript again. New pairs only get
  // proposed, so editing a transcript no longer rewrites every later one.
  const kept = dict.retractPairs(dictionary.phrases, entry.learnedPairs);
  dictionary.phrases = kept;
  dictionary.variants = dict.syncVariants(kept, dictionary.variants);
  const proposals = dict.propose(entry.original, next, kept, dictionary.pending);
  if (proposals.length) {
    dictionary.pending = dict.queuePending(dictionary.pending, proposals);
  }
  entry.learnedPairs = [];
  entry.text = next;
  // The user just supplied ground truth for this clip. If the audio is still
  // around, that is a labelled training pair.
  if (settings.keepTrainingAudio) {
    corpus.promote(entry.id, {
      text: next,
      asr: entry.original,
      learned: [],
      ts: entry.ts,
    });
  }
  saveDict();
  saveHistory();
  broadcast();
  return { ok: true, learned: [], proposed: proposals };
});
ipcMain.handle('dict-upsert', async (_e, from, to, meta) => {
  const result = dict.upsertPhrase(
    dictionary.phrases, from, to, dictionary.variants,
    Object.assign({}, meta || {}, { blocked: dictionary.blocked })
  );
  if (!result.ok) return { ok: false, error: result.error };
  dictionary.phrases = result.phrases;
  dictionary.variants = result.variants;
  saveDict();
  broadcast();
  return { ok: true };
});
ipcMain.handle('dict-pending-accept', async (_e, from) => {
  const proposal = dict.findPending(dictionary.pending, from);
  if (!proposal) return { ok: false, error: 'That suggestion is no longer queued.' };
  const result = dict.upsertPhrase(
    dictionary.phrases, proposal.from, proposal.to, dictionary.variants,
    { kind: 'mapping', source: 'learned', blocked: dictionary.blocked }
  );
  if (!result.ok) {
    // A proposal that can no longer be added is not worth keeping around.
    dictionary.pending = dict.removePending(dictionary.pending, from);
    saveDict();
    broadcast();
    return { ok: false, error: result.error };
  }
  dictionary.phrases = result.phrases;
  dictionary.variants = result.variants;
  dictionary.pending = dict.removePending(dictionary.pending, from);
  saveDict();
  broadcast();
  return { ok: true };
});
ipcMain.handle('dict-pending-dismiss', async (_e, from) => {
  dictionary.pending = dict.removePending(dictionary.pending, from);
  saveDict();
  broadcast();
  return true;
});
ipcMain.handle('dict-delete', async (_e, from) => {
  // Deleting a term also drops the spellings generated from it.
  const result = dict.removePhrase(dictionary.phrases, dictionary.variants, from);
  dictionary.phrases = result.phrases;
  dictionary.variants = result.variants;
  saveDict();
  broadcast();
  return true;
});
ipcMain.handle('training-clear', async () => {
  corpus.clear();
  broadcast();
  return snapshot();
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
    loadAsrSetupState();
    // Asked for once and not awaited: the answer only decides which card the
    // settings pane shows, and nothing downstream should wait on graphics
    // detection to start dictating.
    detectGpu().then(broadcast);
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
    if (languagePackManager) languagePackManager.cancel();
    if (asrRuntimeManager) asrRuntimeManager.cancel();
    if (asrModelManager) asrModelManager.cancel();
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
    if (localRewriteRuntime) localRewriteRuntime.stop();
    globalShortcut.unregisterAll();
    stopPttWatch();
    // A watcher left running would outlive the app and hold a powershell process.
    stopChordWatch();
    if (hwndTimer) clearInterval(hwndTimer);
    if (sidecar) {
      try { sidecar.stdin.write('QUIT\n'); } catch (_) {}
      sidecar.kill();
    }
    if (markerProc) {
      try { markerProc.stdin.write('QUIT\n'); } catch (_) {}
      markerProc.kill();
    }
    corpus.clearRetry();
  });
}
