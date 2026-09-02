'use strict';

const { app, BrowserWindow, globalShortcut, ipcMain, clipboard, screen, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, execFile } = require('child_process');
const { cleanup, cleanupVerbatim, dedupeRepeats } = require('./cleanup');
const { spokenNumbersToDigits } = require('./numbers');
const dict = require('./dictionary');
const vocabulary = require('./vocabulary');
const repair = require('./repair');
const capabilities = require('./asr-capabilities');
const modelPlan = require('./model-plan');
const style = require('./style');
const rewriter = require('./rewriter');
const metrics = require('./metrics');
const insights = require('./insights');
const corpus = require('./corpus');
const models = require('./models');
const asr = require('./asr');
const hotkeys = require('./hotkeys');
const flowBar = require('./flow-bar');
const announcements = require('./announcements');
const updater = require('./updater');
const { createSidecarQueue } = require('./sidecar-queue');
const { createMediaController } = require('./media-controller');
const { LanguagePackManager, normalizeTier } = require('./language-packs');
const { AsrRuntimeManager } = require('./asr-runtime');
const { AsrModelManager } = require('./asr-model');
const { SpeechModelsManager } = require('./speech-models');
const cleanRemove = require('./clean-remove');
const { CudaPackManager } = require('./cuda-pack');
const gpu = require('./gpu');
const qwenAccel = require('./qwen-accel');
const { QwenAccelPackManager, pathWithRuntimeBins } = require('./qwen-accel-pack');
const { createDownloadProgressGate } = require('./release-download');
const { LocalRewriteRuntime } = require('./local-rewrite-runtime');
const { startSidecarAfterGpuDetection } = require('./startup-gpu');

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
let engineVocabulary = '';
let engineFastVocabulary = '';
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
let pttReleasePending = false;
let hwndTimer = null;
let sidecar = null;
let sidecarReady = false;
let sidecarState = 'starting';
let sidecarRestarts = 0;
let sidecarRestartNow = false;
let sidecarStartToken = 0;
let sidecarProbe = null;
let sidecarRestartTimer = null;
// A cold app launch only probes the speech runtime. The multi-gigabyte model
// process is requested by the first dictation, so opening Voxden never competes
// with the desktop for disk, RAM, CPU and GPU all at once.
let sidecarStartRequested = false;
let asrOperation = null;
let asrSetupController = null;
let sidecarQueue = createSidecarQueue();
let sidecarReadyWaiters = [];
let sidecarBuf = '';
let sidecarProgressBuf = '';
// Set while the speech engine is being deleted. Windows will not remove a
// directory whose python.exe is running, so the sidecar has to be stopped and
// seen to exit first -- and its exit handler otherwise schedules a restart
// five seconds later, which would put a live interpreter straight back inside
// the directory and make the delete fail all over again.
let removingAsrRuntime = false;
let recordingStartedAt = 0;
let lastDurationMs = 0;
let dictationTiming = null;
let successTimer = null;
let isQuitting = false;
let dictionary = { phrases: [], variants: [] };
// Structured vocabulary derived from `dictionary`, rebuilt whenever the
// dictionary is edited. Kept as a cache rather than as the store: the
// dictionary file stays the thing the UI edits and the thing an older Voxden
// can still read, and this is the ranked, script-aware view of it that the
// engines and the repair stage actually consume.
let vocabularyEntries = [];
let vocabularyDirty = true;
// What the last dictation's vocabulary actually did, for the diagnostics
// panel. Never contains audio or transcript text -- only term names the user
// typed in themselves and the decisions taken about them.
let lastVocabularyReport = null;
// What the sidecar said about the dictation it just finished.
let lastAsrReport = null;
let history = { entries: [] };
// What the bell has already told this user about. Ids stay in here after they
// are cleared, which is the only reason a cleared notification stays gone.
let notifications = { seenVersion: '', items: {} };
let settings = {
  dictateMode: 'toggle',
  shortcut: 'CommandOrControl+Shift+Space',
  pasteLastShortcut: 'CommandOrControl+Alt+V',
  launchAtLogin: false,
  alwaysShowFlowBar: true,
  // Where the user dragged the flow bar to, as the screen point its bottom
  // centre sits on. null means "wherever the primary display's bottom centre
  // is", which is where it has always been.
  flowBarAnchor: null,
  showInTaskbar: false,
  soundsEnabled: true,
  suggestionsEnabled: true,
  contextAwareness: true,
  keepTrainingAudio: false,
  useTunedModel: true,
  asrEngine: 'qwen3-asr',
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
  // Spoken numbers written as figures: "one point zero point sixteen" is
  // 1.0.16, "twenty five percent" is 25%.
  numbersAsDigits: true,
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
let speechModelsManager = null;
let cudaPackManager = null;
let cudaPackState = { status: 'idle', progress: null, message: '' };
let qwenCudaPackManager = null;
let qwenRocmPackManager = null;
let qwenCudaPackState = { status: 'idle', progress: null, message: '' };
let qwenRocmPackState = { status: 'idle', progress: null, message: '' };
const languagePackProgressGate = createDownloadProgressGate();
const whisperCudaProgressGate = createDownloadProgressGate();
const qwenCudaProgressGate = createDownloadProgressGate();
const qwenRocmProgressGate = createDownloadProgressGate();
let qwenAccelSessionBlock = null;
let engineQwenBackend = 'cpu';
let engineComputeType = '';
let engineGpuName = '';
let engineGpuArch = '';
let engineTorchVersion = '';
let enginePackId = '';
let engineQwenProbe = false;
let engineQwenInit = false;
let engineFallbackReason = '';
let gpuRenderer = '';
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
// The helper process watches physical press/release edges for push to talk.
// Modifier-only shortcuts also use it for toggle mode because RegisterHotKey
// cannot express those chords.
let chordWatch = null;
let chordWatchAccel = '';
let chordWatchRestartTimer = null;
let chordWatchRestartDelay = 250;
// True while the dictation chord is physically down from before the current
// watcher (or hotkey registration) existed. Changing the shortcut in settings
// registers the new chord on key-down, while the user's fingers are still on
// it; without this, keyboard auto-repeat or the watcher's first poll turned
// that lingering hold into a dictation of nothing, reported as "No speech".
let chordStaleHeld = false;
// Push to talk, tapped. A chord let go within this many milliseconds of going
// down was a tap, not a hold: keep recording and let the next press end it.
// The mic itself takes a couple of hundred milliseconds to open, so a hold
// this short could never have carried a word anyway.
const PTT_TAP_MS = 300;
let pttPressedAt = 0;
let pttLocked = false;
// The press that ends a locked dictation has a release of its own coming;
// that release must not be read as a second stop.
let pttIgnoreNextUp = false;
let registeredPasteShortcut = null;
let pasteLastBusy = false;
const backgroundMedia = createMediaController({
  pause: async () => (await mediaCommand(['media-pause'])).split(/\r?\n/).map(s => s.trim()).filter(Boolean),
  resume: ids => mediaCommand(['media-resume', '-Ids', ids.join(',')]),
  onError: err => console.warn('Media control failed:', err.message),
});
let mediaShutdownDone = false;
let mediaPreparing = false;
let recordingSessionToken = 0;
let dictationContext = { selectedText: '', clipboardText: '', windowText: '' };

let ROOT;
let DATA;
let AUDIO;
let DICT_FILE;
let VOCAB_SEED;
let HIST_FILE;
let SETTINGS_FILE;
let NOTIFICATIONS_FILE;
let WIN32;
let SIDECAR;
let MODELS;
let WRITER_MODELS;
let ASR_RUNTIME;
let ASR_MODELS;
let CUDA_PACK;
let QWEN_CUDA_PACK;
let QWEN_ROCM_PACK;
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
    AUDIO = path.join(DATA, 'audio');
    DICT_FILE = path.join(DATA, 'dictionary.json');
    HIST_FILE = path.join(DATA, 'history.json');
    SETTINGS_FILE = path.join(DATA, 'settings.json');
    NOTIFICATIONS_FILE = path.join(DATA, 'notifications.json');
    VOCAB_SEED = path.join(res, 'scripts', 'vocabulary-seed.json');
    WIN32 = path.join(res, 'scripts', 'win32.ps1');
    SIDECAR = path.join(res, 'sidecar', 'transcribe.py');
    MODELS = path.join(app.getPath('userData'), 'models');
    WRITER_MODELS = path.join(MODELS, 'writer');
    ASR_RUNTIME = path.join(app.getPath('userData'), 'asr-runtime');
    ASR_MODELS = path.join(app.getPath('userData'), 'asr-models');
    CUDA_PACK = path.join(app.getPath('userData'), 'cuda-pack');
    QWEN_CUDA_PACK = path.join(app.getPath('userData'), 'qwen-cuda-pack');
    QWEN_ROCM_PACK = path.join(app.getPath('userData'), 'qwen-rocm-pack');
    ICON_PNG = resolveAssetIcon('icon.png');
    ICON_ICO = resolveAssetIcon('icon.ico');
  } else {
    DATA = path.join(ROOT, 'data');
    AUDIO = path.join(DATA, 'audio');
    DICT_FILE = path.join(DATA, 'dictionary.json');
    VOCAB_SEED = path.join(ROOT, 'scripts', 'vocabulary-seed.json');
    HIST_FILE = path.join(DATA, 'history.json');
    SETTINGS_FILE = path.join(DATA, 'settings.json');
    NOTIFICATIONS_FILE = path.join(DATA, 'notifications.json');
    WIN32 = path.join(ROOT, 'scripts', 'win32.ps1');
    SIDECAR = path.join(ROOT, 'sidecar', 'transcribe.py');
    MODELS = path.join(ROOT, 'models');
    WRITER_MODELS = path.join(MODELS, 'writer');
    ASR_RUNTIME = path.join(ROOT, 'models', 'asr-runtime');
    ASR_MODELS = path.join(ROOT, 'models', 'asr-models');
    CUDA_PACK = path.join(ROOT, 'models', 'cuda-pack');
    QWEN_CUDA_PACK = path.join(ROOT, 'models', 'qwen-cuda-pack');
    QWEN_ROCM_PACK = path.join(ROOT, 'models', 'qwen-rocm-pack');
    ICON_PNG = path.join(ROOT, 'assets', 'icon.png');
    ICON_ICO = path.join(ROOT, 'assets', 'icon.ico');
  }
  languagePackManager = new LanguagePackManager({
    root: WRITER_MODELS,
    releaseApiUrl: process.env.VOXDEN_LANGUAGE_PACK_RELEASE_API || undefined,
    onProgress: (state) => {
      languagePackState = Object.assign({}, languagePackState, state);
      if (languagePackProgressGate(languagePackState)) broadcast();
    },
  });
  asrRuntimeManager = new AsrRuntimeManager({
    root: ASR_RUNTIME,
    bundledRoot: app.isPackaged ? path.join(process.resourcesPath, 'speech-runtime')
      : path.join(ROOT, 'dist-runtime-v3'),
    validateRuntime: (python, signal) => new Promise((resolve, reject) => {
      execFile(python, ['-I', '-c', 'import faster_whisper, onnx_asr; from qwen_asr import Qwen3ASRModel'],
        { windowsHide: true, timeout: 120000, signal }, err => err ? reject(
          new Error('The speech engine could not load on this PC. ' + err.message)) : resolve());
    }),
    releaseApiUrl: process.env.VOXDEN_ASR_RUNTIME_RELEASE_API || undefined,
    onProgress: (state) => reportSetup('engine', state),
  });
  asrModelManager = new AsrModelManager({
    root: ASR_MODELS,
    cacheRoot: MODELS,
    purgeLegacy: app.isPackaged,
    releaseApiUrl: process.env.VOXDEN_ASR_MODEL_RELEASE_API || undefined,
    onProgress: (state) => reportSetup('model', state),
  });
  speechModelsManager = new SpeechModelsManager({
    root: path.join(ASR_MODELS, 'extras'),
    cacheRoot: MODELS,
    purgeLegacy: app.isPackaged,
    onProgress: state => reportSetup('extras', state),
  });
  cudaPackManager = new CudaPackManager({
    root: CUDA_PACK,
    releaseApiUrl: process.env.VOXDEN_CUDA_PACK_RELEASE_API || undefined,
    onProgress: (state) => {
      cudaPackState = Object.assign({}, cudaPackState, state);
      if (whisperCudaProgressGate(cudaPackState)) broadcast();
    },
  });
  const validateQwenAccel = (kind) => (python, signal) => new Promise((resolve, reject) => {
    const env = Object.assign({}, process.env, {
      PYTHONNOUSERSITE: '1',
      PYTHONUTF8: '1',
      PYTHONPATH: path.dirname(SIDECAR),
      PATH: pathWithRuntimeBins(python, process.env.PATH),
      VOXDEN_QWEN_ACCEL: kind,
      VOXDEN_OFFLINE: '1',
    });
    if (speechModelsManager) {
      env.VOXDEN_QWEN_ASR_MODEL = speechModelsManager.directory('qwen3-asr');
    }
    execFile(python, ['-I', SIDECAR, '--probe-qwen-accel'], {
      windowsHide: true,
      timeout: 300000,
      signal,
      env,
    }, (err, stdout) => {
      let parsed = null;
      try { parsed = JSON.parse(String(stdout || '').trim().split('\n').pop()); } catch (_) {}
      if (!parsed || !parsed.importOk) {
        reject(new Error((parsed && parsed.error) || (err && err.message) || 'The accelerator could not import PyTorch.'));
        return;
      }
      if (!parsed.tensorProbeOk) {
        reject(new Error(
          (parsed && parsed.error)
          || 'The accelerator imported PyTorch but could not run a GPU tensor. Qwen stays on CPU Qwen.'
        ));
        return;
      }
      resolve({
        importOk: true,
        tensorProbeOk: true,
        qwenProbeOk: !!parsed.qwenProbeOk,
        gpuName: parsed.gpu_name || '',
        at: new Date().toISOString(),
      });
    });
  });
  qwenCudaPackManager = new QwenAccelPackManager({
    kind: 'cuda',
    root: QWEN_CUDA_PACK,
    releaseApiUrl: process.env.VOXDEN_QWEN_CUDA_PACK_RELEASE_API || undefined,
    validateRuntime: validateQwenAccel('cuda'),
    onProgress: (state) => {
      qwenCudaPackState = Object.assign({}, qwenCudaPackState, state);
      if (qwenCudaProgressGate(qwenCudaPackState)) broadcast();
    },
  });
  qwenRocmPackManager = new QwenAccelPackManager({
    kind: 'rocm',
    root: QWEN_ROCM_PACK,
    releaseApiUrl: process.env.VOXDEN_QWEN_ROCM_PACK_RELEASE_API || undefined,
    validateRuntime: validateQwenAccel('rocm'),
    onProgress: (state) => {
      qwenRocmPackState = Object.assign({}, qwenRocmPackState, state);
      if (qwenRocmProgressGate(qwenRocmPackState)) broadcast();
    },
  });
  localRewriteRuntime = new LocalRewriteRuntime({
    logPath: path.join(DATA, 'local-correction.log'),
  });
}

function ensureData() {
  fs.mkdirSync(DATA, { recursive: true });
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
    flowBarAnchor: null,
    sidebarCollapsed: false,
    showInTaskbar: false,
    soundsEnabled: true,
    suggestionsEnabled: true,
    contextAwareness: true,
    keepTrainingAudio: false,
    useTunedModel: true,
    asrEngine: 'qwen3-asr',
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
    numbersAsDigits: true,
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
        settings.asrEngine = 'qwen3-asr';
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
      settings.numbersAsDigits = settings.numbersAsDigits !== false;
      settings.flowBarAnchor = flowBar.normalizeAnchor(settings.flowBarAnchor);
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
      args: ['--hidden'],
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
  // Usage counters and provenance timestamps live in the same file under a
  // separate key; dict.load ignores them, so they are read here and folded in.
  // A file written by an older build simply has none, and every entry starts
  // from its dictionary position instead.
  storedVocabularyEntries = readStoredEntries(DICT_FILE);
  vocabularyDirty = true;
  loadSettings();
  loadNotifications();
  try {
    const raw = JSON.parse(fs.readFileSync(HIST_FILE, 'utf8'));
    history = { entries: Array.isArray(raw.entries) ? raw.entries : [] };
  } catch (_) {
    history = { entries: [] };
  }
}

function loadNotifications() {
  try {
    notifications = announcements.normalizeState(JSON.parse(fs.readFileSync(NOTIFICATIONS_FILE, 'utf8')));
  } catch (_) {
    // No file yet is the fresh-install case, and announcements treats an empty
    // store as one: the user is told what shipped in this build and nothing
    // about the releases before it.
    notifications = announcements.normalizeState(null);
  }
}

function saveNotifications() {
  ensureData();
  fs.writeFileSync(NOTIFICATIONS_FILE, JSON.stringify(notifications, null, 2));
}

// Apply a result from announcements: persist only when something moved, and
// let the window know only when it did.
function applyNotifications(result, options) {
  if (!result || !result.changed) return false;
  notifications = result.state;
  try { saveNotifications(); } catch (_) {}
  if (!options || options.broadcast !== false) broadcast();
  return true;
}

function deliverAnnouncements() {
  applyNotifications(
    announcements.deliver(notifications, { version: app.getVersion() }),
    { broadcast: false },
  );
}

function saveHistory() {
  ensureData();
  fs.writeFileSync(HIST_FILE, JSON.stringify({ entries: history.entries }, null, 2));
}

function saveDict() {
  dict.save(DICT_FILE, dictionary);
  // The structured view is written back alongside the legacy keys so usage and
  // provenance survive a restart. Rebuilt first, so what is persisted is what
  // the next dictation will use -- an edit takes effect on the very next
  // utterance, with no restart and no cache to go stale.
  vocabularyDirty = true;
  storedVocabularyEntries = currentVocabulary();
  try {
    vocabulary.saveState(DICT_FILE, {
      phrases: dictionary.phrases,
      variants: dictionary.variants,
      pending: dictionary.pending,
      blocked: dictionary.blocked,
      entries: storedVocabularyEntries,
    });
  } catch (_) {
    // The legacy write above already succeeded; losing the usage counters is
    // not worth failing a dictionary edit over.
  }
}

let storedVocabularyEntries = [];

function readStoredEntries(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(raw.entries) ? raw.entries : [];
  } catch (_) {
    return [];
  }
}

// The ranked vocabulary for right now. Cheap enough to rebuild on demand --
// the dictionaries in the wild are in the low hundreds of terms -- and only
// rebuilt when something actually changed.
function currentVocabulary() {
  if (vocabularyDirty) {
    vocabularyEntries = vocabulary.fromDictionary(dictionary, storedVocabularyEntries);
    vocabularyDirty = false;
  }
  return vocabularyEntries;
}

// The terms offered to a dictation, in the order they deserve the budget.
// Language filtering happens here: a Devanagari term has no business in the
// prompt for an English dictation, and including it is both wasted budget and
// a false-substitution risk.
function vocabularyForDictation(language) {
  return vocabulary.rank(currentVocabulary(), {
    language: language || settings.dictationLanguage || 'en',
    recentTerms: vocabulary.recentTermSet(history.entries, 40),
  });
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
  const notificationList = announcements.list(notifications);
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
    speechModels: speechModelsManager ? speechModelsManager.snapshot() : null,
    // What this configuration needs, what it is offered, and what each costs.
    // The renderer shows the required figure rather than the sum of everything
    // that exists, because the sum was never what anybody had to download.
    modelPlan: (asrModelManager && speechModelsManager) ? currentModelPlan() : null,
    asrOperation: asrOperation ? asrOperation.kind : null,
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
    qwenAccel: currentQwenAccelPlan(),
    qwenCudaPack: qwenCudaPackManager ? qwenCudaPackManager.snapshot() : null,
    qwenCudaPackState,
    qwenRocmPack: qwenRocmPackManager ? qwenRocmPackManager.snapshot() : null,
    qwenRocmPackState,
    asrFastOnCpu: asr.prefersFastAsr({
      device: engineDevice,
      fastEngine: engineFastBackend,
      language: settings.dictationLanguage,
    }),
    fastModel: engineFastModel,
    fastDevice: engineFastDevice,
    // What the dictionary can actually do on the engine that is running.
    // 'context' and 'initial_prompt' mean the terms are given to the model
    // before it decodes; 'unsupported' means the engine has no such input and
    // the dictionary is applied to the transcript afterwards. Reporting it is
    // the point: a request that cannot be honoured must not look like one that
    // was.
    vocabularyMechanism: engineVocabulary,
    fastVocabularyMechanism: engineFastVocabulary,
    vocabularyBudget: capabilities.vocabularyBudget(engineBackend),
    vocabularyTerms: currentVocabulary().length,
    lastDictationVocabulary: lastVocabularyReport,
    dictateMode: settings.dictateMode,
    shortcut: settings.shortcut,
    shortcutLabel: formatShortcutLabel(settings.shortcut),
    pasteLastShortcut: settings.pasteLastShortcut,
    pasteLastShortcutLabel: formatShortcutLabel(settings.pasteLastShortcut),
    hotkeyNotice,
    launchAtLogin: settings.launchAtLogin,
    alwaysShowFlowBar: settings.alwaysShowFlowBar,
    flowBarMoved: !!settings.flowBarAnchor,
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
    numbersAsDigits: settings.numbersAsDigits !== false,
    autoSend: style.normalizeAutoSend(settings.autoSend),
    canRetry: corpus.hasRetry(),
    notifications: notificationList,
    notificationsUnread: announcements.unreadCount(notificationList),
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

// Weight setup progress by the model bytes still needed, including Qwen and Parakeet.
let setupWeights = { engine: 0.05, model: 0.27, extras: 0.68 };

function reportSetup(step, state) {
  const before = step === 'model' ? setupWeights.engine
    : step === 'extras' ? setupWeights.engine + setupWeights.model : 0;
  const own = Number.isFinite(state.progress) ? Math.max(0, Math.min(100, state.progress)) : 0;
  // An individual component completing is still part of the same busy operation.
  const status = state.status === 'installed' ? 'installing' : state.status;
  asrRuntimeState = { ...state, status, step,
    progress: Math.floor(100 * before + (setupWeights[step] || 0) * own) };
  if (asrProgressIsWorthSending(asrRuntimeState)) broadcast();
}

function asrDisabledPath() { return path.join(ASR_RUNTIME, 'disabled.json'); }
function asrIsDisabled() { return fs.existsSync(asrDisabledPath()); }

function runAsrOperation(kind, work) {
  // Share the result across every caller, including the banner and settings.
  // Never let a second click overwrite the first operation's progress/error.
  if (asrOperation) return asrOperation.promise;
  const operation = { kind, promise: null };
  asrOperation = operation;
  operation.promise = Promise.resolve().then(work).finally(() => {
    asrOperation = null;
    asrSetupController = null;
    removingAsrRuntime = false;
    if (kind === 'install' && asrRuntimeState.status === 'installed' && !isQuitting) {
      restartSidecar();
    }
    broadcast();
  }).then(() => snapshot());
  return operation.promise;
}

// What this PC needs for the engine and processor it is set to, and what it is
// merely being offered. One call, so the banner, the settings panel and the
// downloader cannot disagree about the size of the download.
function currentModelPlan(overrides) {
  const opts = overrides || {};
  const speech = speechModelsManager ? speechModelsManager.snapshot() : { packs: [] };
  const model = asrModelManager ? asrModelManager.snapshot() : {};
  const sizes = { whisper: model.downloadBytes || 0 };
  const installed = { whisper: !!model.installed };
  for (const pack of speech.packs || []) {
    sizes[pack.id] = pack.downloadBytes || 0;
    installed[pack.id] = !!pack.installed;
  }
  return modelPlan.plan({
    engine: opts.engine || settings.asrEngine,
    device: opts.device || settings.asrDevice,
    language: opts.language || settings.dictationLanguage,
    gpu: currentGpuPlan(),
    sizes,
    installed,
  });
}

// Split a plan's component ids by which manager owns the download.
function componentsByManager(ids) {
  const wanted = new Set(ids || []);
  return {
    whisper: wanted.has('whisper'),
    speech: [...wanted].filter((id) => id !== 'whisper'),
  };
}

// Install exactly the components named, or the ones the current settings
// require when nothing is named.
//
// This used to fetch every engine plus both Parakeet precisions unconditionally
// -- 11.0 GB before a first-run user had said a word, most of it for engines
// they had not chosen and a duplicate of a model only one precision of which
// can ever load. What a configuration actually needs is src/model-plan.js.
async function setupDictation(signal, options) {
  const opts = options || {};
  const runtime = asrRuntimeManager.snapshot();
  const plan = currentModelPlan();
  const wanted = opts.components && opts.components.length
    ? opts.components
    : plan.missing;
  const parts = componentsByManager(wanted);
  const model = asrModelManager.snapshot();
  const engineBytes = runtime.installed && !runtime.needsUpgrade ? 0 : Math.max(runtime.downloadBytes, 50e6);
  const modelBytes = parts.whisper && !model.installed ? model.downloadBytes : 0;
  const extrasBytes = speechModelsManager.pendingBytes(parts.speech);
  const total = engineBytes + modelBytes + extrasBytes || 1;
  setupWeights = { engine: engineBytes / total, model: modelBytes / total, extras: extrasBytes / total };
  const names = wanted.map((id) => (modelPlan.COMPONENTS[id] || {}).name || id);
  asrRuntimeState = {
    status: 'preparing',
    progress: 0,
    message: names.length ? 'Preparing ' + names.join(' and ') + '…' : 'Preparing dictation…',
    step: 'engine',
  };
  saveAsrSetupState();
  broadcast();
  await fs.promises.mkdir(ASR_MODELS, { recursive: true });
  const disk = await fs.promises.statfs(ASR_MODELS);
  // Whisper assembly temporarily needs both its parts and the finished file.
  const required = (engineBytes ? 1.5e9 : 0) + modelBytes * 2 + extrasBytes + 512e6;
  if (disk.bavail * disk.bsize < required) {
    throw new Error('Speech setup needs about ' + Math.ceil(required / 1e9)
      + ' GB of free disk space, including temporary files. Free some space and try again.');
  }
  await cancelListen();
  removingAsrRuntime = true;
  await stopPythonProcesses();
  const checkCancelled = () => {
    if (signal.aborted) throw Object.assign(new Error('Setup cancelled. Download again to resume.'), { code: 'CANCELLED' });
  };
  checkCancelled();
  await asrRuntimeManager.install();
  checkCancelled();
  if (parts.whisper) {
    await asrModelManager.install();
    checkCancelled();
  }
  if (parts.speech.length) {
    await speechModelsManager.install(parts.speech);
    checkCancelled();
  }
  fs.rmSync(asrDisabledPath(), { force: true });
  asrRuntimeState = {
    status: 'installed',
    progress: 100,
    message: (names.length ? names.join(' and ') + ' installed. ' : '') + 'Starting dictation…',
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
  if (!['preparing', 'error', 'cancelled', 'installed', 'removed'].includes(status)) return;
  try {
    fs.mkdirSync(ASR_RUNTIME, { recursive: true });
    fs.writeFileSync(asrSetupStatePath(), JSON.stringify({
      status,
      message: String(asrRuntimeState.message || ''),
      step: String(asrRuntimeState.step || ''),
    }));
  } catch (_) {}
}

// Finish what an earlier run could not, and drop what it never should have
// kept. A removal the app quit in the middle of, or that a locked file cut
// short, left its tree set aside under a .removing- name; those go now. And
// setup in older versions copied models out of the cache into the managed
// store and left the originals, which is how a PC ended up holding every
// model twice: once the managed copies are what the engine loads, the cached
// ones go too. A developer build without the managed runtime still reads the
// cache, so it keeps it. Not awaited: none of this is needed to dictate.
function tidyModelStorage() {
  const roots = [
    ASR_RUNTIME, ASR_MODELS, path.join(ASR_MODELS, 'extras'),
    CUDA_PACK, QWEN_CUDA_PACK, QWEN_ROCM_PACK, path.join(WRITER_MODELS, 'packs'),
    MODELS, path.join(MODELS, '.locks'),
    path.join(MODELS, 'huggingface', 'hub'), path.join(MODELS, 'huggingface', 'hub', '.locks'),
  ];
  return (async () => {
    for (const root of roots) await cleanRemove.sweepRemoved(root);
    if (!usingManagedRuntime()) return;
    if (asrModelManager && asrModelManager.installed()) await asrModelManager.purgeLegacy();
    if (speechModelsManager) {
      const installed = speechModelsManager.snapshot().packs.filter(p => p.installed).map(p => p.id);
      if (installed.length) await speechModelsManager.purgeLegacy(installed);
    }
  })().catch(err => console.error('model storage tidy failed:', err && err.message ? err.message : err));
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
  if (!['preparing', 'error', 'cancelled'].includes(saved.status)) return;
  if (asrRuntimeManager && asrModelManager && speechModelsManager
    && asrRuntimeManager.installed() && currentModelPlan().ready) return;
  asrRuntimeState = {
    status: saved.status === 'preparing' ? 'cancelled' : saved.status,
    progress: null,
    message: saved.status === 'preparing' ? 'Setup was interrupted. Download again to resume.'
      : String(saved.message || 'Dictation setup did not finish.'),
    step: String(saved.step || 'engine'),
  };
}

function nid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// --- Win32 helper ------------------------------------------------------------
// Every call used to be a fresh powershell.exe that compiled the helper class
// before doing anything: a quarter of a CPU second and most of a wall second,
// and a dictation made four or five of them. The paste alone put the text on
// screen a full second after the engine had finished with it. The helper now
// runs as a small pool of long-lived servers speaking JSON over stdin/stdout,
// compiled once each. A call that finds every server busy still gets the old
// one-shot process, so nothing ever waits on somebody else's OCR.
const PS_SERVER_POOL = 2;
const PS_SERVER_IDLE_MS = 90000;
const PS_SERVER_START_MS = 15000;

let psServers = [];
let psServersAllowed = true;
let psRequestId = 0;

function psParseArgs(args) {
  const list = Array.isArray(args) ? args.map((a) => String(a)) : [];
  if (!list.length || list[0].startsWith('-')) return null;
  const req = { action: list[0] };
  for (let i = 1; i < list.length; i += 2) {
    const name = list[i];
    if (!name.startsWith('-') || i + 1 >= list.length) return null;
    req[name.slice(1).toLowerCase()] = list[i + 1];
  }
  return req;
}

function psOneShot(args, timeoutMs) {
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

function psRetireServer(server, reason) {
  psServers = psServers.filter((s) => s !== server);
  if (server.idleTimer) clearTimeout(server.idleTimer);
  if (server.startTimer) clearTimeout(server.startTimer);
  const pending = server.pending;
  server.pending = null;
  try { server.proc.stdin.write('QUIT\n'); } catch (_) {}
  try { server.proc.kill(); } catch (_) {}
  if (pending) pending.fail(reason || 'helper gone');
}

function psScheduleIdle(server) {
  if (server.idleTimer) clearTimeout(server.idleTimer);
  // One server stays warm so the next paste is instant; extras go away.
  server.idleTimer = setTimeout(() => {
    server.idleTimer = null;
    if (server.pending) return;
    const idle = psServers.filter((s) => !s.pending && s.ready);
    if (idle.length > 1) psRetireServer(server, 'idle');
  }, PS_SERVER_IDLE_MS);
}

function psLaunchServer() {
  if (!psServersAllowed || isQuitting || psServers.length >= PS_SERVER_POOL) return null;
  let proc;
  try {
    proc = spawn(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', WIN32, '-Action', 'serve'],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }
    );
  } catch (_) {
    return null;
  }
  const server = { proc, pending: null, ready: false, buf: '', idleTimer: null, startTimer: null };
  psServers.push(server);
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (chunk) => {
    server.buf += chunk;
    let idx;
    while ((idx = server.buf.indexOf('\n')) >= 0) {
      const line = server.buf.slice(0, idx).trim();
      server.buf = server.buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch (_) { continue; }
      if (!server.ready) {
        server.ready = true;
        if (server.startTimer) clearTimeout(server.startTimer);
        server.startTimer = null;
      }
      const pending = server.pending;
      if (pending && String(msg.id) === pending.id) {
        server.pending = null;
        pending.done(String(msg.out || ''));
        psScheduleIdle(server);
      }
    }
  });
  proc.stderr.on('data', () => {});
  const lost = () => psRetireServer(server, 'exited');
  proc.on('error', lost);
  proc.on('exit', lost);
  // A hello so the caller knows the class has compiled, and a deadline on it:
  // a PowerShell that cannot get this far is a PowerShell not worth waiting
  // on, and callers fall back to one-shot processes from then on.
  server.startTimer = setTimeout(() => {
    server.startTimer = null;
    if (!server.ready) {
      psRetireServer(server, 'start timeout');
      if (!psServers.length) psServersAllowed = false;
    }
  }, PS_SERVER_START_MS);
  psSend(server, { id: 'hello', action: 'get' }, 'hello');
  return server;
}

function psSend(server, req, id) {
  const line = JSON.stringify(Object.assign({}, req, { id }));
  try {
    server.proc.stdin.write(line + '\n');
    return true;
  } catch (_) {
    psRetireServer(server, 'write failed');
    return false;
  }
}

function warmPsServers() {
  if (!psServers.length) psLaunchServer();
}

function stopPsServers() {
  psServersAllowed = false;
  for (const server of psServers.slice()) psRetireServer(server, 'quit');
}

function ps(args, timeoutMs) {
  const req = psParseArgs(args);
  const timeout = Number(timeoutMs) || 4000;
  if (!req || !psServersAllowed || isQuitting) return psOneShot(args, timeoutMs);
  let server = psServers.find((s) => s.ready && !s.pending);
  if (!server) {
    // Nothing idle: grow the pool if there is room, otherwise do not queue
    // behind whatever the busy server is doing.
    const starting = psServers.find((s) => !s.ready && !s.pending);
    server = starting || psLaunchServer();
    if (!server) return psOneShot(args, timeoutMs);
  }
  return new Promise((resolve) => {
    const id = String(++psRequestId);
    let settled = false;
    let timer = null;
    const finish = (out) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(String(out || '').trim());
    };
    server.pending = {
      id,
      done: finish,
      fail: () => finish(''),
    };
    if (server.idleTimer) clearTimeout(server.idleTimer);
    timer = setTimeout(() => {
      // A stuck helper is replaced, not waited for. The reply, if it ever
      // comes, has nobody to go to.
      psRetireServer(server, 'timeout');
      finish('');
    }, timeout + (server.ready ? 0 : PS_SERVER_START_MS));
    if (!psSend(server, req, id)) finish('');
  });
}

function findPython() {
  const configured = String(process.env.VOXDEN_PYTHON || '').trim();
  if (configured) return configured;
  const managed = asrRuntimeManager && asrRuntimeManager.installed();
  if (managed) return managed.pythonPath;
  // Installed builds never borrow Python from PATH or open the Store alias.
  if (app.isPackaged) return null;
  const local = path.join(ROOT, '.venv', 'Scripts', 'python.exe');
  return fs.existsSync(local) ? local : 'python.exe';
}

function findSidecarPython() {
  const configured = String(process.env.VOXDEN_PYTHON || '').trim();
  if (configured) return configured;
  const engine = process.env.VOXDEN_ASR_ENGINE || (settings && settings.asrEngine);
  if (String(engine || '').toLowerCase() === 'qwen3-asr' && !qwenAccelSessionBlock) {
    const plan = currentQwenAccelPlan();
    if (qwenAccel.shouldUseAccelPython(plan, 'qwen3-asr')) {
      const manager = plan.recommendedPack === 'rocm' ? qwenRocmPackManager : qwenCudaPackManager;
      const installed = manager && manager.installed();
      if (installed && installed.pythonPath && fs.existsSync(installed.pythonPath)) {
        return installed.pythonPath;
      }
    }
  }
  return findPython();
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
  if (!asrRuntimeManager || !asrModelManager || !speechModelsManager) return false;
  // What is missing for the engine actually selected, not for all three. A
  // Qwen user with no Whisper download is not a broken install, and telling
  // them to fetch 3.1 GB to fix nothing is how "up to 11.0 GB" happened.
  return asrIsDisabled() || !asrRuntimeManager.installed()
    || asrRuntimeManager.snapshot().needsUpgrade || !currentModelPlan().ready
    || sidecarState === 'unavailable';
}

function sendOverlay(extra) {
  // Cheap: the signature check exits before building anything unless the
  // dictation actually started or finished.
  refreshTray();
  // The grip only exists next to the resting bar, but a hotkey can start a
  // dictation with the button still down. Put the bar down where it is rather
  // than let the recording pill carry on following the cursor.
  if (extra && extra.mode && extra.mode !== 'idle') stopOverlayDrag(true);
  if (extra && extra.mode === 'idle') {
    overlayEditing = false;
    if (overlayWin && !overlayWin.isDestroyed()) {
      // positionOverlay sets the size too, and it reads overlayEditing, which
      // the line above just cleared.
      try { positionOverlay(); } catch (_) {}
    }
  }
  if (!overlayWin || overlayWin.isDestroyed()) return;
  overlayWin.webContents.send('state', Object.assign({
    mode,
    prepareOnly: mediaPreparing,
    engine,
    engineStatus: sidecarState,
    model: engineModel,
    device: engineDevice,
    asrEngineActive: engineBackend,
    fastEngine: engineFastBackend,
    dictateMode: settings.dictateMode,
    pttLocked,
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
  // The idle width also has to hold the hover cluster -- gear, mic and drag
  // grip -- with room for the halo either side of it.
  if (overlayEditing) return { ww: 380, wh: 110 };
  return { ww: 260, wh: 84 };
}

function overlaySizeRect() {
  const { ww, wh } = overlaySize();
  return { width: ww, height: wh };
}

// The saved anchor read through whatever monitors exist right now. A point
// left behind by a display that has since been unplugged resolves onto the
// nearest one that is still there, so the bar can never end up parked in dead
// space -- which is one of the ways it used to go missing.
function overlayAnchor(size) {
  return flowBar.resolveAnchor(
    settings.flowBarAnchor,
    screen.getAllDisplays(),
    screen.getPrimaryDisplay(),
    size || overlaySizeRect()
  );
}

// Sets the whole rect, never just the corner. setPosition() re-sends the size
// it reads back from the window, and that read-back does not survive a scaled
// display: at 125% a 260x84 overlay comes back a pixel or two larger, gets set
// to that, and comes back larger again. One call is invisible. Sixty a second,
// which is what dragging did, grew the window by about 48x48 per second -- and
// because the bar is bottom-aligned inside it, a taller window slid the bar
// steadily down the screen while it was being dragged.
//
// This is the only function that decides where the overlay window is or how big
// it is, so the size is pinned in one place and cannot drift anywhere.
let overlayRect = null;

function placeOverlay(rect) {
  if (!overlayWin || overlayWin.isDestroyed()) return;
  overlayRect = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  try {
    overlayWin.setBounds({ x: rect.x, y: rect.y, width: rect.width, height: rect.height });
  } catch (_) {}
}

function positionOverlay() {
  if (!overlayWin || overlayWin.isDestroyed()) return;
  // A drag owns the window position outright; re-centring it mid-gesture would
  // fight the user's hand.
  if (overlayDrag) return;
  const size = overlaySizeRect();
  placeOverlay(flowBar.rectFor(overlayAnchor(size), size));
}

// --- Dragging ---------------------------------------------------------------
// The bar is moved from here rather than by a `-webkit-app-region: drag`
// region. The renderer only reports that the grip went down and came back up;
// every frame in between comes from the OS cursor, which is the one coordinate
// space that stays correct as the window crosses a monitor boundary. A drag
// region would also have to fight setIgnoreMouseEvents, which this window
// spends most of its life inside.
let overlayDrag = null;

// Half a frame. The tick is cheap now that it no longer resizes anything, and
// polling twice per frame roughly halves how far the bar can trail the cursor.
const DRAG_TICK_MS = 8;
// A pointerup that never arrives -- Alt+Tab mid-drag, a lock screen, the OS
// taking the capture away -- would otherwise leave the bar glued to the
// cursor with no way to put it down.
const DRAG_MAX_MS = 30000;

function overlayDragTick() {
  if (!overlayDrag) return;
  if (!overlayWin || overlayWin.isDestroyed()) {
    stopOverlayDrag(false);
    return;
  }
  if (Date.now() - overlayDrag.startedAt > DRAG_MAX_MS) {
    stopOverlayDrag(true);
    return;
  }
  let point;
  try {
    point = screen.getCursorScreenPoint();
  } catch (_) {
    return;
  }
  const x = Math.round(point.x - overlayDrag.grabX);
  const y = Math.round(point.y - overlayDrag.grabY);
  // A hand holding still is the common case between flicks, and moving a window
  // to where it already is still costs a full SetWindowPos on a layered window.
  if (x === overlayDrag.x && y === overlayDrag.y) return;
  overlayDrag.x = x;
  overlayDrag.y = y;
  placeOverlay({ x, y, width: overlayDrag.size.width, height: overlayDrag.size.height });
}

function startOverlayDrag() {
  if (!overlayWin || overlayWin.isDestroyed() || !overlayWin.isVisible()) return;
  stopOverlayDrag(false);
  let point;
  try {
    point = screen.getCursorScreenPoint();
  } catch (_) {
    return;
  }
  // Where the window is according to us, never according to getBounds(). The
  // read-back does not round-trip on a scaled display, and a gesture that both
  // read and wrote its own position would accumulate that error into a drift.
  const size = overlaySizeRect();
  const rect = flowBar.rectFor(overlayAnchor(size), size);
  overlayDrag = {
    // Where inside the window the grab happened, held fixed for the whole
    // gesture so the bar does not jump to the pointer on the first frame.
    grabX: point.x - rect.x,
    grabY: point.y - rect.y,
    x: rect.x,
    y: rect.y,
    size,
    startedAt: Date.now(),
    timer: setInterval(overlayDragTick, DRAG_TICK_MS),
  };
}

function stopOverlayDrag(commit) {
  if (!overlayDrag) return;
  const drag = overlayDrag;
  clearInterval(drag.timer);
  overlayDrag = null;
  // The hover poll went quiet for the whole drag; forget the last reading so
  // the next tick tells the renderer where the cursor really is.
  lastCursor = null;
  if (!commit) return;
  if (!overlayWin || overlayWin.isDestroyed()) return;
  // The bar was free to cross monitors while the button was down. Only the
  // landing is clamped, so a drop half over an edge still leaves all of it
  // reachable on the display it came down on.
  const landed = flowBar.resolveAnchor(
    flowBar.anchorFor({ x: drag.x, y: drag.y, width: drag.size.width, height: drag.size.height }),
    screen.getAllDisplays(),
    screen.getPrimaryDisplay(),
    overlaySizeRect()
  );
  settings.flowBarAnchor = landed;
  try { saveSettings(); } catch (_) {}
  positionOverlay();
}

function resetFlowBarPosition() {
  settings.flowBarAnchor = null;
  try { saveSettings(); } catch (_) {}
  positionOverlay();
  ensureOverlayVisible();
}

// Windows hands "topmost" to whoever asked for it last, so another always-on-top
// window -- a game overlay, a meeting toolbar, a UAC-adjacent shell window --
// can bury the bar with nothing reporting that it happened. The only moment
// that can have changed is when the foreground window changes, so the bar
// reclaims the top there rather than on a timer.
function raiseOverlay() {
  if (!overlayWin || overlayWin.isDestroyed() || !overlayWin.isVisible()) return;
  // Re-asserting the level rather than moveTop(): this is a pure z-order
  // change, where moveTop also re-sends a position and can nudge the bar by a
  // pixel on a scaled display every time it runs.
  try { overlayWin.setAlwaysOnTop(true, 'screen-saver'); } catch (_) {}
}

// The bar should be on screen whenever the user asked for it to be. Anything
// that hid it without going through hideOverlayWindow -- a renderer reload, a
// display swap, a hide that raced a mode change -- gets undone here.
let lastOverlayRescue = 0;

const OVERLAY_RESCUE_MS = 3000;

function ensureOverlayVisible() {
  if (!settings.alwaysShowFlowBar) return;
  if (mode !== 'idle') return;
  if (!overlayWin || overlayWin.isDestroyed()) return;
  if (overlayWin.isVisible()) return;
  // Backing off matters: this runs on the foreground poll, twice a second, and
  // if showing the window does not take -- a compositor that has gone away, a
  // session that is locked -- an unthrottled retry turns a missing bar into a
  // permanent burn of tray rebuilds and IPC on every tick.
  const now = Date.now();
  if (now - lastOverlayRescue < OVERLAY_RESCUE_MS) return;
  lastOverlayRescue = now;
  showOverlay();
  sendOverlay({ mode: 'idle', reveal: true });
}

// Monitors coming and going is exactly when a saved position stops making
// sense, and the events arrive in bursts, so the answer is computed once the
// dust settles. The saved anchor is deliberately left alone: unplug a screen
// and the bar moves to one that exists, plug it back in and it goes home.
let overlayReflowTimer = null;

function scheduleOverlayReflow() {
  if (overlayReflowTimer) clearTimeout(overlayReflowTimer);
  overlayReflowTimer = setTimeout(() => {
    overlayReflowTimer = null;
    if (overlayDrag) return;
    positionOverlay();
    ensureOverlayVisible();
    raiseOverlay();
  }, 250);
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
// Whether the pointer is on the resting bar, decided here rather than in the
// renderer. The window is click-through while idle, and it used to become
// clickable only after a round trip -- cursor sample to renderer, hover
// verdict back to main -- so a quick click on the bar could land on whatever
// was behind it. Main knows the cursor and the window; it decides at once.
let overlayHover = false;

const CURSOR_POLL_MS = 40;

// Hover target, in window coordinates; mirrors the renderer's constants. Two
// rects: a tight one to enter, a larger one to stay in, so the cursor cannot
// fall out of its own target by moving towards a button that only exists once
// the bar has opened.
const HOVER_ENTER_W = 62;
const HOVER_STAY_W = 120;
const HOVER_ENTER_H = 26;
const HOVER_STAY_H = 46;
const HOVER_BOTTOM = 10;

function inHoverZone(x, y, width, height, stay) {
  const zoneW = stay ? HOVER_STAY_W : HOVER_ENTER_W;
  const left = (width - zoneW) / 2;
  if (x < left || x > left + zoneW) return false;
  const bottom = height - HOVER_BOTTOM;
  const zoneH = stay ? HOVER_STAY_H : HOVER_ENTER_H;
  return y >= bottom - zoneH && y <= bottom;
}

function overlayCursorTick() {
  if (!overlayWin || overlayWin.isDestroyed() || !overlayWin.isVisible()) return;
  // The bar is under the cursor by definition while it is being carried, and
  // the renderer discards hover readings for the whole gesture anyway.
  if (overlayDrag) return;
  let point;
  try {
    point = screen.getCursorScreenPoint();
  } catch (_) {
    return;
  }
  // The rect placeOverlay last wrote, not a native read-back on every tick.
  const bounds = overlayRect || overlayWin.getContentBounds();
  const x = point.x - bounds.x;
  const y = point.y - bounds.y;
  const inside = x >= 0 && y >= 0 && x <= bounds.width && y <= bounds.height;
  const hover = inside && inHoverZone(x, y, bounds.width, bounds.height, overlayHover);
  const hoverChanged = hover !== overlayHover;
  overlayHover = hover;
  // The renderer only ever turns these readings into a boolean, so it only
  // hears about the boolean changing -- not about every pixel the pointer
  // crosses inside the window.
  if (hoverChanged && mode === 'idle' && !overlayEditing) setOverlayMouseIgnore(!hover);
  if (lastCursor && lastCursor.inside === inside && !hoverChanged) return;
  lastCursor = { x, y, inside, hover };
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

// A window that comes back from hide() with showInactive() looks right and
// even reports hover, but no mouse-down reaches the page until it is resized:
// Chromium only re-shows the child window that takes the renderer's input
// when the bounds change, and a move alone does not count. Turning "show the
// flow bar at all times" off and on left the grip dead until a restart. One
// pixel of height and straight back, both from our own rect so the
// scaled-display rounding never drifts in, is enough to wake it.
function rearmOverlayInput() {
  if (!overlayWin || overlayWin.isDestroyed() || !overlayRect) return;
  const rect = overlayRect;
  placeOverlay({ x: rect.x, y: rect.y, width: rect.width, height: rect.height + 1 });
  placeOverlay(rect);
}

function showOverlay() {
  if (!overlayWin || overlayWin.isDestroyed()) return;
  positionOverlay();
  if (!overlayWin.isVisible()) {
    overlayWin.showInactive();
    rearmOverlayInput();
  }
  raiseOverlay();
  captureOverlayHwnd();
  if (mode === 'idle') setOverlayMouseIgnore(true);
  else setOverlayMouseIgnore(false);
  startCursorWatch();
}

function hideOverlayWindow() {
  if (!overlayWin || overlayWin.isDestroyed()) return;
  if (settings.alwaysShowFlowBar) return;
  stopOverlayDrag(false);
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
  historyWin.on('ready-to-show', () => {
    applyWindowIcon(historyWin);
    try {
      historyHwnd = nativeHwnd(historyWin.getNativeWindowHandle());
    } catch (_) {}
  });
  if (!process.argv.includes('--hidden')) {
    let opened = false;
    const openWhenReady = () => {
      if (opened) return;
      opened = true;
      openHistory();
    };
    historyWin.once('ready-to-show', openWhenReady);
    historyWin.webContents.once('did-finish-load', openWhenReady);
  }
  historyWin.loadFile(path.join(__dirname, 'app.html'));
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
  if (historyWin.isMinimized()) historyWin.restore();
  historyWin.show();
  historyWin.focus();
  try {
    historyHwnd = nativeHwnd(historyWin.getNativeWindowHandle());
  } catch (_) {}
  try {
    historyWin.webContents.send('history-updated', snapshot());
  } catch (err) {
    try { fs.appendFileSync(path.join(DATA || os.tmpdir(), 'sidecar.log'), String(err && err.stack || err) + '\n'); } catch (_) {}
  }
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
  if (next === 'toggle') pttReleasePending = false;
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

function mediaCommand(args) {
  // The helper reports each successful pause immediately. Retain those
  // receipts even if a different player's request subsequently times out.
  return ps(args, 4000);
}

function pauseBackgroundMedia() {
  return backgroundMedia.begin(muteMusicEnabled());
}

function resumeBackgroundMedia() {
  return backgroundMedia.end();
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
  if (isQuitting) return;
  if (asrOperation || asrIsDisabled() || sidecarState === 'unavailable') {
    openHistory('general');
    return;
  }
  if (mode === 'arming' || mode === 'recording' || mode === 'transcribing') return;
  requestSidecarStart();
  const sessionToken = ++recordingSessionToken;
  if (successTimer) clearTimeout(successTimer);
  dictationContext = { selectedText: '', clipboardText: '', windowText: '' };
  recordingStartedAt = 0;
  lastDurationMs = 0;
  dictationTiming = null;
  pttReleasePending = false;
  pttLocked = false;
  pttIgnoreNextUp = false;
  const pttSession = !!fromPtt && isPtt();
  // Do not call this "recording" until the renderer has a live audio graph.
  // Short commands often begin immediately; showing the waveform while
  // getUserMedia is still starting silently clips their first word.
  mode = 'arming';
  // PTT has a physical key-up deadline, so open its microphone immediately.
  // Waiting for the optional media pause made short holds end during arming and
  // appear not to register. Toggle mode waits for the pause so the tail of a
  // song is not the first thing on the recording -- a wait that is now a few
  // tens of milliseconds, because the pause goes through the long-lived
  // helper rather than a fresh PowerShell process.
  mediaPreparing = !pttSession;
  showOverlay();
  sendOverlay({ mode: 'arming', prepareOnly: mediaPreparing, reveal: true });
  registerEscape(true);

  // The foreground watcher already gives us a usable cached paste target.
  // Refresh its metadata while media is paused. Show the preparing HUD now,
  // but do not open the microphone until any old resume and this pause settle.
  rememberFocus().then(() => {
    if (sessionToken !== recordingSessionToken) return;
    if (mode !== 'arming' && mode !== 'recording' && mode !== 'transcribing') return;
    return captureDictationContext();
  }).catch(() => {});
  const mediaPause = pauseBackgroundMedia();
  if (!pttSession) mediaPause.then(() => {
    if (isQuitting || sessionToken !== recordingSessionToken || mode !== 'arming') return;
    mediaPreparing = false;
    sendOverlay({ mode: 'arming', prepareOnly: false });
  }).catch(() => {});
  else mediaPause.catch(() => {});
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
  pttReleasePending = false;
  pttLocked = false;
  dictationTiming = metrics.beginDictationTiming(Date.now());
  mode = 'transcribing';
  sendOverlay({ mode: 'stop' });
  registerEscape(true);
}

// The physical DOWN edge. While a tapped dictation is locked on, the next
// press is the one that ends it.
function pttPress() {
  if (pttLocked && (mode === 'arming' || mode === 'recording')) {
    pttLocked = false;
    pttIgnoreNextUp = true;
    requestPttStop();
    return;
  }
  pttPressedAt = Date.now();
  startRecording(true);
}

// The physical UP edge. A release within PTT_TAP_MS of the press locks the
// dictation on instead of ending it; a dirty tap still cancels, because the
// chord was really some other shortcut.
function pttRelease(dirty) {
  if (pttIgnoreNextUp) {
    pttIgnoreNextUp = false;
    return;
  }
  if (dirty) {
    cancelListen();
    return;
  }
  const active = mode === 'arming' || mode === 'recording';
  if (active && !pttLocked && pttPressedAt && Date.now() - pttPressedAt < PTT_TAP_MS) {
    pttLocked = true;
    sendOverlay({ pttLocked: true });
    return;
  }
  requestPttStop();
}

// A clean release can beat getUserMedia on a cold microphone. Remember it
// until capture-ready instead of turning a valid PTT press into Cancelled.
function requestPttStop() {
  if (mode === 'arming') {
    pttReleasePending = true;
    return;
  }
  requestStop();
}

async function cancelListen() {
  if (mode !== 'arming' && mode !== 'recording' && mode !== 'transcribing') return;
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
  const entry = {
    id: nid(),
    ts: Date.now(),
    text,
    original: meta && typeof meta.rawAsr === 'string' ? meta.rawAsr : text,
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
    const timingFields = [
      'recognitionMs', 'modelRecognitionMs', 'rewriteMs', 'pasteMs',
      'postProcessMs', 'stopToPasteMs',
    ];
    for (const field of timingFields) {
      if (Number.isFinite(meta[field]) && meta[field] >= 0) entry[field] = Math.round(meta[field]);
    }
    // What the vocabulary did to this dictation: which engine ran, whether the
    // terms reached the model or were applied afterwards, how much of the
    // dictionary fitted, and every repair that was made or declined.
    //
    // Everything here is either a number or a term the user typed in
    // themselves. No audio, no clipboard, no window text, nothing from the
    // context features -- this record is safe to keep whatever the privacy
    // settings say, which is the point of writing it this way.
    if (meta.vocabulary && typeof meta.vocabulary === 'object') {
      entry.vocabulary = meta.vocabulary;
    }
  }
  lastDurationMs = 0;
  history.entries.unshift(entry);
  if (history.entries.length > 400) history.entries.length = 400;
  if (settings.keepTrainingAudio) corpus.claim(entry.id);
  else corpus.dropParked();
  saveHistory();
  broadcast();
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

async function timedRewriteWithLanguagePack(text, options) {
  const startedAt = Date.now();
  try {
    return await rewriteWithLanguagePack(text, options);
  } finally {
    metrics.addRewriteDuration(dictationTiming, Date.now() - startedAt);
  }
}

// Every dictation path ends the same way. Keeping the tail in one place is
// what stops the verbatim path from drifting away from the styled one.
async function pasteDictation(text, category) {
  const startedAt = Date.now();
  try { overlayWin && overlayWin.setFocusable(false); } catch (_) {}
  await pasteText(text, style.autoSendFor(category, settings));
  metrics.markPasteComplete(dictationTiming, startedAt, Date.now());
}

function finishDictation(text, meta) {
  mode = 'success';
  const timedMeta = Object.assign({}, meta || {}, metrics.dictationTimingFields(dictationTiming));
  const entry = addHistoryEntry(text, timedMeta);
  dictationTiming = null;
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

// Apply the user's vocabulary to a finished transcript.
//
// Two stages, deliberately kept apart:
//
//   1. explicit replacement -- the rules the user wrote, matched exactly, in
//      any script. No judgement, so it runs on every path including verbatim.
//   2. acoustic repair -- deciding that a span the engine produced is a
//      mangled vocabulary term. This is a judgement, so it only fires on the
//      evidence src/repair.js requires: identical letters, or a span the
//      decoder itself flagged as uncertain.
//
// Anything repair wanted to do but could not justify comes back as an
// escalation: a term worth rechecking against the audio on an engine that can
// be told about it. The caller decides whether that recheck is worth its
// latency.
function applyVocabulary(text, options) {
  const opts = options || {};
  const language = opts.language || settings.dictationLanguage || 'en';
  const entries = vocabularyForDictation(language);
  if (!entries.length || !String(text || '').trim()) {
    return { text: String(text || ''), hits: 0, applied: [], repairs: [], escalate: [], entries };
  }
  const replaced = vocabulary.applyEntries(text, entries, { language });
  if (opts.replacementsOnly) {
    return Object.assign({ repairs: [], escalate: [], entries }, replaced);
  }
  const repaired = repair.repairTranscript(replaced.text, entries, {
    language,
    segments: opts.segments,
  });
  return {
    text: repaired.text,
    hits: replaced.hits,
    applied: replaced.applied,
    repairs: repaired.repairs,
    escalate: repaired.escalate,
    entries,
  };
}

// Mark the terms a finished dictation actually used, so ranking learns what is
// current. Written through saveDict, which also rebuilds the ranked view.
function recordVocabularyUse(text, entries) {
  const used = vocabulary.usedEntries(text, entries || []);
  if (!used.length) return;
  storedVocabularyEntries = vocabulary.touch(currentVocabulary(), used);
  vocabularyDirty = true;
  try {
    vocabulary.saveState(DICT_FILE, {
      phrases: dictionary.phrases,
      variants: dictionary.variants,
      pending: dictionary.pending,
      blocked: dictionary.blocked,
      entries: storedVocabularyEntries,
    });
  } catch (_) {}
}

function vocabularyViaFromReports(asrReport, report) {
  const actual = String((asrReport && asrReport.vocabulary) || '');
  if (actual === 'context' || actual === 'initial_prompt') return actual;
  if (actual === 'unsupported') return (report && report.offered) ? 'repair' : 'none';
  if ((report && report.via) === 'repair' && (report.offered || 0) > 0) return 'repair';
  return actual || (report && report.via) || 'none';
}

// One line the user can read about what just happened to their words.
function vocabularyDiagnostics(result) {
  const report = lastVocabularyReport || {};
  const asrReport = lastAsrReport || {};
  const via = vocabularyViaFromReports(asrReport, report);
  const actualEngine = asrReport.engine || report.engine || '';
  const plan = {
    engine: actualEngine || report.engine,
    vocabularyVia: via,
    reason: report.reason || '',
    degraded: !!report.degraded,
    lostCapabilities: report.lostCapabilities || [],
  };
  return {
    selectedEngine: report.selectedEngine || engineBackend || '',
    selectedDevice: report.selectedDevice || settings.asrDevice || '',
    engine: actualEngine,
    device: asrReport.device || report.device || '',
    backend: asrReport.backend || report.backend || engineQwenBackend || 'cpu',
    gpuName: asrReport.gpuName || engineGpuName || '',
    gpuArch: asrReport.gpuArch || engineGpuArch || '',
    driverVersion: (currentGpuPlan() && gpuDevices[0] && gpuDevices[0].driverVersion) || '',
    torchVersion: asrReport.torchVersion || engineTorchVersion || '',
    packId: asrReport.packId || enginePackId || '',
    computeType: asrReport.computeType || engineComputeType || '',
    probePassed: asrReport.probePassed || engineQwenProbe,
    initPassed: asrReport.initPassed || engineQwenInit,
    fallbackReason: asrReport.fallbackReason || report.fallbackReason || engineFallbackReason || '',
    sidecarWarning: engineWarning || '',
    audioSec: asrReport.audioSec || 0,
    recognitionSec: asrReport.recognitionSec || 0,
    rtf: asrReport.rtf || 0,
    language: report.language || '',
    requestedQuality: report.requestedQuality || '',
    effectiveQuality: report.quality || '',
    vocabularyVia: via,
    vocabularyMechanism: asrReport.vocabulary || report.mechanism || '',
    termsOffered: report.offered || 0,
    termsSent: report.sent || 0,
    termsDropped: report.dropped || 0,
    droppedTerms: report.droppedTerms || [],
    promptTokens: report.tokens || 0,
    uncertainSpans: (asrReport.segments || []).length,
    dictionaryHits: (result && result.hits) || 0,
    repairs: ((result && result.repairs) || []).map((r) => ({
      heard: r.heard, term: r.term, reason: r.reason,
    })),
    rejectedRepairs: ((result && result.escalate) || []).map((r) => ({
      heard: r.heard, term: r.term,
    })),
    escalations: ((result && result.escalate) || []).map((r) => ({
      heard: r.heard, term: r.term,
    })),
    reason: report.reason || '',
    fallbackFrom: report.fallbackFrom || '',
    summary: capabilities.summarizeRoute(plan, {
      quality: report.quality,
      termsSent: report.sent,
    }),
  };
}

async function onTranscript(raw) {
  metrics.markRecognitionComplete(
    dictationTiming,
    Date.now(),
    lastAsrReport && lastAsrReport.modelRecognitionMs
  );
  const category = style.classifyTarget(lastTarget.exe, lastTarget.title);
  const tone = style.toneForCategory(category, settings.writingStyles);
  const quality = currentDictationQuality();
  const context = dictationContext || {};
  // Numbers after the commands and before the dictionary: "insert period"
  // must not be read as a decimal point, and a dictionary term can contain a
  // figure the user typed as a figure.
  const cleaned = settings.numbersAsDigits !== false
    ? spokenNumbersToDigits(cleanup(raw))
    : cleanup(raw);
  let selectedText = context.selectedText || '';
  if (settings.selectedTextRewrite !== false && rewriter.matchRewriteCommand(cleaned)) {
    selectedText = await captureSelectionIfNeeded();
  }
  const rewriteCommand = settings.selectedTextRewrite !== false
    && selectedText
    && rewriter.matchRewriteCommand(cleaned);

  if (rewriteCommand) {
    const rewriteResult = await timedRewriteWithLanguagePack(cleaned, {
      mode: 'transform',
      selectedText: selectedText,
      tone,
      category,
      dictionaryTerms: currentVocabulary().map((e) => e.canonical),
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
    // Verbatim pastes what was said, so only the explicit rules run. Acoustic
    // repair is a guess about what the speaker meant, and a mode whose whole
    // promise is "your exact words" is the wrong place for a guess.
    const verbatimDict = settings.verbatimDictionary
      ? applyVocabulary(verbatim, { replacementsOnly: true })
      : { text: verbatim, hits: 0, entries: [] };
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
      asrEngine: (lastAsrReport && lastAsrReport.engine)
        || (lastVocabularyReport && lastVocabularyReport.engine)
        || asrEngineFor(quality),
      dictationQuality: (lastVocabularyReport && lastVocabularyReport.quality) || quality,
      vocabulary: vocabularyDiagnostics(verbatimDict),
    });
    recordVocabularyUse(verbatimDict.text, verbatimDict.entries);
    return;
  }

  const deduped = dedupeRepeats(cleaned);
  const dictResult = applyVocabulary(deduped, {
    segments: lastAsrReport && lastAsrReport.segments,
  });
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
    rewriteResult = await timedRewriteWithLanguagePack(deterministic, {
      tone,
      category,
      dictionaryTerms: currentVocabulary().map((e) => e.canonical),
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
    asrEngine: (lastAsrReport && lastAsrReport.engine)
      || (lastVocabularyReport && lastVocabularyReport.engine)
      || asrEngineFor(quality),
    dictationQuality: (lastVocabularyReport && lastVocabularyReport.quality) || quality,
    vocabulary: vocabularyDiagnostics(dictResult),
  });
  recordVocabularyUse(styled, dictResult.entries);
}

async function retryLast() {
  if (mode === 'arming' || mode === 'recording' || mode === 'transcribing') return;
  const file = corpus.retryPath();
  if (!file) {
    flashError('Nothing to retry');
    return;
  }
  if (successTimer) clearTimeout(successTimer);
  dictationTiming = metrics.beginDictationTiming(Date.now());
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
  pttReleasePending = false;
  pttLocked = false;
  // This dictation produced no entry, so its clip has nothing to be labelled
  // with. Drop it rather than leave it for the next entry to claim.
  corpus.dropParked();
  registerEscape(false);
  recordingStartedAt = 0;
  lastDurationMs = 0;
  dictationTiming = null;
  mode = 'error';
  resumeBackgroundMedia();
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
  pttReleasePending = false;
  pttLocked = false;
  corpus.dropParked();
  registerEscape(false);
  recordingStartedAt = 0;
  lastDurationMs = 0;
  dictationTiming = null;
  mode = 'cancel';
  resumeBackgroundMedia();
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

// --- Foreground window ------------------------------------------------------
// The paste target is whichever window was in front before the dictation
// started. It used to be read by starting a new powershell.exe every 500 ms,
// and each of those compiled the Win32 helper class before answering -- about
// a quarter of a CPU second per poll, twice a second, for as long as the app
// ran. That was the single largest idle cost of the app, and on a busy machine
// each poll took longer than the interval, so a helper process was alive
// essentially all the time. One long-lived watcher that only writes a line
// when the foreground window changes replaces it, in the same shape as the
// push-to-talk chord watcher.
//
// Two values are kept: what is in front right now, and what the text is owed
// to. They differ during a dictation, when the user may click around while
// speaking -- the transcript still goes to the window that had focus when the
// recording started.
let foregroundHwnd = '0';
let foregroundWatch = null;
let foregroundWatchRestartTimer = null;
let foregroundWatchRestartDelay = 250;
// Fallback when the watcher cannot be started at all: a slow spawn poll, so a
// broken PowerShell still leaves dictation working, just at a leisurely pace.
let foregroundFallbackTimer = null;
let foregroundFallbackBusy = false;

const FOREGROUND_FALLBACK_MS = 2000;
const HWND_TICK_MS = 1000;

function adoptForegroundHwnd(hwnd) {
  if (!hwnd || isOurHwnd(hwnd)) return;
  foregroundHwnd = hwnd;
  // Reading the foreground window mid-dictation would replace the window the
  // text is owed to with whatever the user clicked on since.
  if (mode === 'arming' || mode === 'recording' || mode === 'transcribing') return;
  if (hwnd !== lastHwnd) {
    lastHwnd = hwnd;
    // A different app is in front, which is the only moment something can
    // have taken the topmost slot away from the bar.
    raiseOverlay();
  }
}

function launchForegroundWatch() {
  let proc;
  try {
    proc = spawn(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', WIN32, '-Action', 'foreground-watch'],
      { windowsHide: true }
    );
  } catch (_) {
    return false;
  }
  foregroundWatch = proc;
  let buf = '';
  proc.stdout.on('data', (chunk) => {
    if (foregroundWatch !== proc) return;
    foregroundWatchRestartDelay = 250;
    buf += String(chunk);
    const lines = buf.split(/\r?\n/);
    buf = lines.pop() || '';
    for (const line of lines) {
      const hwnd = line.trim();
      if (/^\d+$/.test(hwnd)) adoptForegroundHwnd(hwnd);
    }
  });
  proc.stderr.on('data', () => {});
  const lost = () => {
    if (foregroundWatch !== proc) return;
    foregroundWatch = null;
    scheduleForegroundWatchRestart();
  };
  proc.on('error', lost);
  proc.on('exit', lost);
  return true;
}

function scheduleForegroundWatchRestart() {
  if (isQuitting || foregroundWatchRestartTimer) return;
  const delay = foregroundWatchRestartDelay;
  foregroundWatchRestartDelay = Math.min(10000, foregroundWatchRestartDelay * 2);
  foregroundWatchRestartTimer = setTimeout(() => {
    foregroundWatchRestartTimer = null;
    if (isQuitting || foregroundWatch) return;
    if (!launchForegroundWatch()) scheduleForegroundWatchRestart();
  }, delay);
}

function stopForegroundWatch() {
  if (foregroundWatchRestartTimer) {
    clearTimeout(foregroundWatchRestartTimer);
    foregroundWatchRestartTimer = null;
  }
  if (foregroundFallbackTimer) {
    clearInterval(foregroundFallbackTimer);
    foregroundFallbackTimer = null;
  }
  if (foregroundWatch) {
    const proc = foregroundWatch;
    foregroundWatch = null;
    try { proc.kill(); } catch (_) {}
  }
}

async function foregroundFallbackTick() {
  // Only while the watcher is down. PowerShell startup can exceed the
  // interval on a busy machine, so never stack a second process on the first.
  if (foregroundWatch || foregroundFallbackBusy || isQuitting) return;
  if (mode === 'arming' || mode === 'recording' || mode === 'transcribing') return;
  foregroundFallbackBusy = true;
  try {
    adoptForegroundHwnd(await ps(['get']));
  } finally {
    foregroundFallbackBusy = false;
  }
}

function startHwndPoll() {
  if (hwndTimer) clearInterval(hwndTimer);
  stopForegroundWatch();
  if (!launchForegroundWatch()) scheduleForegroundWatchRestart();
  foregroundFallbackTimer = setInterval(foregroundFallbackTick, FOREGROUND_FALLBACK_MS);
  // In-process only: nothing here starts a process. The bar can go missing
  // while a dictation is nowhere near, so its health check runs on every tick,
  // and a foreground change that arrived during a dictation is adopted as the
  // next paste target once the dictation is over.
  hwndTimer = setInterval(() => {
    ensureOverlayVisible();
    if (mode === 'arming' || mode === 'recording' || mode === 'transcribing') return;
    if (foregroundHwnd !== '0' && foregroundHwnd !== lastHwnd) adoptForegroundHwnd(foregroundHwnd);
  }, HWND_TICK_MS);
}

function tunedModelInfo() {
  return models.tunedModelInfo(MODELS);
}

// Whether the sidecar is running on the interpreter Voxden installed rather
// than one the user manages. It carries all three backends; end users never run pip.
function usingManagedRuntime() {
  const py = findSidecarPython();
  const managed = asrRuntimeManager && asrRuntimeManager.installed();
  if (managed && py === managed.pythonPath) return true;
  const cuda = qwenCudaPackManager && qwenCudaPackManager.installed();
  if (cuda && py === cuda.pythonPath) return true;
  const rocm = qwenRocmPackManager && qwenRocmPackManager.installed();
  if (rocm && py === rocm.pythonPath) return true;
  return false;
}

function usingCpuManagedRuntime(py) {
  const managed = asrRuntimeManager && asrRuntimeManager.installed();
  return !!(managed && py === managed.pythonPath);
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
  clearTimeout(sidecarRestartTimer);
  sidecarRestartTimer = null;
  sidecarRestarts = 0;
  sidecarStartToken += 1;
  if (sidecarProbe) { sidecarProbe.kill(); sidecarProbe = null; }
  if (asrOperation || removingAsrRuntime || isQuitting) return;
  if (!sidecar) {
    // A settings change while cold makes the probed launch plan stale: the
    // engine or processor it was built for is no longer the one selected.
    // Probe again; the warm start that follows picks up the new choice.
    if (sidecarState === 'standby') {
      clearSidecarLaunchPlan();
      startSidecar(true);
      return;
    }
    startSidecar();
    return;
  }
  sidecarRestartNow = true;
  try { sidecar.kill(); } catch (_) {}
}

// Stop every process holding the managed interpreter open, and wait for the
// handles to actually go. kill() only asks; the file stays locked until the
// process is gone, which is why this waits for 'exit' rather than returning
// as soon as the signal is sent.
function stopPythonProcesses(timeoutMs) {
  ++sidecarStartToken;
  clearTimeout(sidecarRestartTimer);
  sidecarRestartTimer = null;
  sidecarRestartNow = false;
  sidecarStartRequested = false;
  clearSidecarLaunchPlan();
  sidecarReady = false;
  sidecarBuf = '';
  sidecarProgressBuf = '';
  finishSidecarWaiters(new Error('speech engine not ready'));
  sidecarQueue.rejectAll(new Error('speech engine not ready'));
  const waits = [];
  const stop = (proc) => {
    if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
    waits.push(new Promise((resolve, reject) => {
      let done = false;
      let timer;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve();
      };
      proc.once('exit', finish);
      proc.once('error', finish);
      // A process that will not die must not hang the click for ever. The
      // removal then fails on a locked file and says so, which is a better
      // outcome than a button that never returns.
      timer = setTimeout(() => {
        if (done) return;
        done = true;
        reject(new Error('The speech process is still closing. Please try again.'));
      }, Number(timeoutMs) || 10000);
      try { proc.kill(); } catch (_) { finish(); }
    }));
  };
  stop(sidecar);
  stop(sidecarProbe);
  sidecarProbe = null;
  engineProgress = null;
  engineFastBackend = '';
  engineVocabulary = '';
  engineFastVocabulary = '';
  engineAvailability = {};
  setSidecarState('unavailable');
  return Promise.all(waits);
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
  return sidecarState === 'standby'
    || sidecarState === 'starting'
    || sidecarState === 'loading';
}

// --- Warm start ---------------------------------------------------------------
// A cold launch probes the runtime first (cheap: a find_spec per engine), and
// the probe leaves behind everything the real process needs -- interpreter,
// environment, accelerator choice. The model process is then started a moment
// later, after the window has painted, rather than on the first dictation:
// loading a multi-gigabyte model is exactly the work a user should never be
// waiting on with the microphone already open. Starting it straight from the
// plan also skips the second --check that used to sit in front of every cold
// dictation.
//
// VOXDEN_LAZY_ASR=1 keeps the old behaviour of waiting for the first
// dictation, for machines where the memory is better spent elsewhere.
let sidecarLaunchPlan = null;
let sidecarWarmTimer = null;

const SIDECAR_WARM_DELAY_MS = 1500;

function lazyAsr() {
  return String(process.env.VOXDEN_LAZY_ASR || '').trim() === '1';
}

function clearSidecarLaunchPlan() {
  sidecarLaunchPlan = null;
  if (sidecarWarmTimer) {
    clearTimeout(sidecarWarmTimer);
    sidecarWarmTimer = null;
  }
}

function scheduleSidecarWarmStart() {
  if (sidecarWarmTimer || lazyAsr()) return;
  sidecarWarmTimer = setTimeout(() => {
    sidecarWarmTimer = null;
    if (!sidecarLaunchPlan || sidecarState !== 'standby') return;
    spawnSidecarServe(sidecarLaunchPlan);
  }, SIDECAR_WARM_DELAY_MS);
}

function requestSidecarStart() {
  sidecarStartRequested = true;
  if (sidecarState !== 'standby' || sidecar || sidecarProbe) return;
  // The probe already ran for this configuration; go straight to the model.
  if (sidecarLaunchPlan) {
    spawnSidecarServe(sidecarLaunchPlan);
    return;
  }
  // While the startup probe is running, retain the request. Its callback will
  // launch the real process after GPU detection and capability checks finish.
  startSidecar();
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

function startSidecar(probeOnly) {
  if (isQuitting || removingAsrRuntime || asrOperation || sidecar || sidecarProbe) return;
  const checkOnly = probeOnly === true;
  if (!checkOnly) sidecarStartRequested = false;
  clearSidecarLaunchPlan();
  const startToken = ++sidecarStartToken;
  const py = findSidecarPython();
  const selected = process.env.VOXDEN_ASR_ENGINE || settings.asrEngine;
  const managed = usingManagedRuntime();
  const cpuManaged = usingCpuManagedRuntime(py);
  // Parakeet is two packs, and which one counts depends on the processor: the
  // float32 weights are only ever loaded on DirectML. Asking model-plan keeps
  // that rule in one place instead of two that can drift.
  const requiredPack = modelPlan.modelForEngine(selected, settings.asrDevice);
  const hasSelectedModel = requiredPack === 'whisper'
    ? (hostedModelPath() || usingTunedModel())
    : speechModelsManager && speechModelsManager.installed(requiredPack);
  if (asrIsDisabled() || !py || (managed && !hasSelectedModel)) {
    engine = 'webspeech';
    engineProgress = null;
    // Name the download rather than the state. Switching engine is the common
    // way to land here now that setup fetches only what was selected, and
    // "setup is incomplete" reads as a fault when it is a one-click offer.
    const missing = modelPlan.COMPONENTS[requiredPack];
    const size = speechModelsManager && requiredPack !== 'whisper'
      ? speechModelsManager.pendingBytes([requiredPack])
      : (asrModelManager ? asrModelManager.snapshot().downloadBytes : 0);
    engineError = (missing && managed && py && !asrIsDisabled())
      ? missing.name + ' is not downloaded yet ('
        + (size / 1e9).toFixed(1) + ' GB). Download it in Settings to use this engine.'
      : 'Dictation is disabled until speech setup is complete. Download it in Settings.';
    setSidecarState('unavailable');
    finishSidecarWaiters(new Error('speech engine not ready'));
    return;
  }
  const qwenPlan = currentQwenAccelPlan();
  const accelKind = (qwenPlan.usePackPython && (qwenPlan.recommendedPack === 'cuda' || qwenPlan.recommendedPack === 'rocm'))
    ? qwenPlan.recommendedPack
    : 'cpu';
  const env = Object.assign({}, process.env, {
    HF_HOME: process.env.HF_HOME || path.join(MODELS, 'huggingface'),
    VOXDEN_MODEL_DIR: MODELS,
    VOXDEN_MODEL: resolveModel(),
    // Explicit developer overrides remain available; packaged builds use the managed runtime.
    VOXDEN_ASR_ENGINE: process.env.VOXDEN_ASR_ENGINE || settings.asrEngine,
    VOXDEN_DEVICE: process.env.VOXDEN_DEVICE || settings.asrDevice,
    // Belt and braces for the router inside the sidecar: a request carrying a
    // vocabulary must not be handed to a backend that cannot take one, even
    // when it arrives by a path that did not go through asrQualityFor.
    VOXDEN_REQUIRE_VOCABULARY: '1',
    VOXDEN_QWEN_ACCEL: process.env.VOXDEN_QWEN_ACCEL || accelKind,
    VOXDEN_QWEN_PACK_ID: qwenPlan.recommendedPack === 'rocm'
      ? (qwenPlan.rocmPack && qwenPlan.rocmPack.id) || ''
      : (qwenPlan.pack && qwenPlan.pack.id) || '',
    VOXDEN_QWEN_PACK_VERSION: qwenPlan.recommendedPack === 'rocm'
      ? (qwenPlan.rocmPack && qwenPlan.rocmPack.version) || ''
      : (qwenPlan.pack && qwenPlan.pack.version) || '',
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
    PYTHONPATH: path.dirname(SIDECAR),
    PATH: pathWithRuntimeBins(py, process.env.PATH),
    // Xet stalls on the first Hub shard for some Windows networks.
    HF_HUB_DISABLE_XET: process.env.HF_HUB_DISABLE_XET || '1',
    ...(qwenAccelSessionBlock ? { VOXDEN_QWEN_FORCE_CPU: '1' } : {}),
    ...(managed ? {
      HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', VOXDEN_OFFLINE: '1',
      PYTHONNOUSERSITE: '1',
      VOXDEN_QWEN_ASR_MODEL: speechModelsManager.directory('qwen3-asr'),
      VOXDEN_PARAKEET_INT8_DIR: speechModelsManager.directory('parakeet'),
      VOXDEN_PARAKEET_FP32_DIR: speechModelsManager.directory('parakeet-fp32'),
      ...(cpuManaged ? {
        VOXDEN_TORCH_DEVICE: asrRuntimeManager.installed().torchDevice || 'cpu',
      } : {}),
    } : {}),
  });
  engineProgress = null;
  engineError = '';
  engineFix = '';
  engineFixEngine = '';
  sidecarProgressBuf = '';
  setSidecarState('starting');
  sidecarProbe = execFile(py, [SIDECAR, '--check'], { timeout: 60000, windowsHide: true, env }, (err, stdout) => {
    if (startToken !== sidecarStartToken || isQuitting) return;
    sidecarProbe = null;
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
    // Preserve the user's selection through missing/removed dependencies.
    // Setup restores it instead of silently changing Qwen to Whisper.
    const plan = { py, env, cpuManaged, accelKind };
    if (checkOnly && !sidecarStartRequested) {
      sidecarLaunchPlan = plan;
      setSidecarState('standby');
      scheduleSidecarWarmStart();
      return;
    }
    spawnSidecarServe(plan);
  });
}

// The log is one append stream per sidecar process rather than a synchronous
// append per stderr chunk: a model download reports progress several times a
// second, and each of those used to block the main thread on disk while the
// machine was already busy loading a model.
let sidecarLog = null;

const SIDECAR_LOG_MAX_BYTES = 4 * 1024 * 1024;

function openSidecarLog() {
  closeSidecarLog();
  const file = path.join(DATA, 'sidecar.log');
  try {
    const stat = fs.statSync(file);
    if (stat.size > SIDECAR_LOG_MAX_BYTES) fs.truncateSync(file, 0);
  } catch (_) {}
  try {
    sidecarLog = fs.createWriteStream(file, { flags: 'a' });
    sidecarLog.on('error', () => { sidecarLog = null; });
  } catch (_) {
    sidecarLog = null;
  }
}

function closeSidecarLog() {
  if (!sidecarLog) return;
  try { sidecarLog.end(); } catch (_) {}
  sidecarLog = null;
}

function spawnSidecarServe(plan) {
  if (isQuitting || removingAsrRuntime || asrOperation || sidecar || sidecarProbe) return;
  const { py, env, cpuManaged, accelKind } = plan;
  clearSidecarLaunchPlan();
  sidecarStartRequested = false;
  setSidecarState('loading');
  sidecar = spawn(py, [SIDECAR, '--serve'], {
    env,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  // Model initialization should yield to the foreground desktop. This does
  // not make recognition slow once loaded: normal priority comes back with
  // the ready handshake, so a dictation the user is waiting on is not
  // starved by whatever else the machine is doing.
  if (process.platform === 'win32' && sidecar.pid) {
    try { os.setPriority(sidecar.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch (_) {}
  }
  const launched = sidecar;
  sidecarBuf = '';
  openSidecarLog();
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
    if (sidecarLog) {
      try { sidecarLog.write(String(chunk)); } catch (_) {}
    }
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
      // A model that failed to load says why on stdout and exits. That line
      // carries no request id, so it used to be dropped on the floor, the
      // user was told "not ready", and the same failing load was repeated
      // three more times. Keep the reason, and do not retry a load that
      // has just explained it cannot succeed.
      if (msg.ok === false && msg.id === undefined && !msg.ready) {
        engineError = String(msg.error || engineError || 'The speech engine could not load.');
        sidecarRestarts = 3;
        continue;
      }
      if (msg.ready) {
        sidecarReady = true;
        engineProgress = null;
        engine = 'whisper';
        if (process.platform === 'win32' && launched.pid) {
          try { os.setPriority(launched.pid, os.constants.priority.PRIORITY_NORMAL); } catch (_) {}
        }
        if (msg.model) engineModel = String(msg.model);
        if (msg.device) engineDevice = String(msg.device);
        if (msg.engine) engineBackend = String(msg.engine);
        engineFastBackend = msg.fast_engine ? String(msg.fast_engine) : '';
        engineFastModel = msg.fast_model ? String(msg.fast_model) : '';
        engineFastDevice = msg.fast_device ? String(msg.fast_device) : '';
        engineWarning = msg.warning ? String(msg.warning) : '';
        engineFix = msg.warning_fix ? String(msg.warning_fix) : '';
        engineFixEngine = msg.warning_fix_engine ? String(msg.warning_fix_engine) : '';
        // How the running engine takes a vocabulary, straight from the
        // engine rather than inferred here. The settings panel needs to be
        // able to say "your dictionary is sent to the model" or "applied
        // after recognition" without either side guessing.
        engineVocabulary = msg.vocabulary ? String(msg.vocabulary) : '';
        engineFastVocabulary = msg.fast_vocabulary ? String(msg.fast_vocabulary) : '';
        applyQwenSidecarReport(msg);
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
  sidecar.stdin.on('error', () => handleSidecarGone());
  function handleSidecarGone() {
    if (gone) return;
    gone = true;
    if (sidecar !== launched) return;
    closeSidecarLog();
    sidecar = null;
    sidecarReady = false;
    engineProgress = null;
    sidecarProgressBuf = '';
    engine = 'webspeech';
    engineFastBackend = '';
engineVocabulary = '';
engineFastVocabulary = '';
    engineFastModel = '';
    engineFastDevice = '';
    engineQwenBackend = 'cpu';
    engineComputeType = '';
    engineGpuName = '';
    engineGpuArch = '';
    engineTorchVersion = '';
    enginePackId = '';
    engineQwenProbe = false;
    engineQwenInit = false;
    engineFallbackReason = '';
    setSidecarState('unavailable');
    sidecarQueue.rejectAll(new Error('sidecar exited'));
    if (removingAsrRuntime || asrOperation || isQuitting) {
      sidecarRestartNow = false;
      finishSidecarWaiters(new Error('speech engine not ready'));
    } else if (!cpuManaged && accelKind !== 'cpu' && !qwenAccelSessionBlock) {
      qwenAccelSessionBlock = {
        backend: accelKind,
        reason: 'The GPU accelerator process exited. Dictation will continue as CPU Qwen.',
        at: Date.now(),
      };
      sidecarRestartNow = false;
      sidecarRestarts = 0;
      if (!isQuitting) {
        setSidecarState('starting');
        sidecarRestartTimer = setTimeout(() => startSidecar(), 250);
      }
    } else if (sidecarRestartNow) {
      sidecarRestartNow = false;
      if (!isQuitting) {
        setSidecarState('starting');
        sidecarRestartTimer = setTimeout(() => startSidecar(), 250);
      }
    } else if (!isQuitting && sidecarRestarts < 3) {
      sidecarRestarts += 1;
      setSidecarState('starting');
      sidecarRestartTimer = setTimeout(() => startSidecar(), 5000);
    } else {
      finishSidecarWaiters(new Error('speech engine not ready'));
    }
  }
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

function applyQwenSidecarReport(msg) {
  const report = msg || {};
  const backend = String(report.backend || '').trim().toLowerCase();
  engineQwenBackend = backend === 'cuda' || backend === 'rocm' ? backend : 'cpu';
  engineComputeType = String(report.compute_type || '');
  engineGpuName = String(report.gpu_name || '');
  engineGpuArch = String(report.gpu_arch || '');
  engineTorchVersion = String(report.torch_version || '');
  enginePackId = String(report.pack_id || '');
  engineQwenProbe = !!report.probe_passed;
  engineQwenInit = !!report.init_passed;
  engineFallbackReason = String(report.fallback_reason || '');
  if (engineQwenBackend !== 'cpu' && qwenAccelSessionBlock) qwenAccelSessionBlock = null;
}

function currentQwenAccelPlan() {
  const cudaSnap = qwenCudaPackManager ? qwenCudaPackManager.snapshot() : {};
  const rocmSnap = qwenRocmPackManager ? qwenRocmPackManager.snapshot() : {};
  return qwenAccel.resolve({
    device: settings.asrDevice,
    engine: settings.asrEngine,
    language: settings.dictationLanguage,
    devices: gpuDevices,
    renderer: gpuRenderer,
    cudaPack: {
      installed: !!cudaSnap.installed,
      healthy: !!cudaSnap.healthy,
      verified: engineQwenBackend === 'cuda',
      failureReason: cudaSnap.failureReason || '',
    },
    rocmPack: {
      installed: !!rocmSnap.installed,
      healthy: !!rocmSnap.healthy,
      verified: engineQwenBackend === 'rocm',
      failureReason: rocmSnap.failureReason || '',
    },
    sessionFailure: qwenAccelSessionBlock,
    sidecar: {
      backend: engineQwenBackend,
      bf16: engineComputeType === 'bfloat16',
      computeType: engineComputeType,
      probePassed: engineQwenProbe,
      initPassed: engineQwenInit,
    },
  });
}

// Electron knows the graphics without spawning anything, and it reports PCI
// vendor ids, which is the one identifier that survives a driver update or a
// rename. A failure here is not worth reporting: the plan then says "no usable
// GPU", which is the same answer as a PC that has none, and dictation still
// runs on the CPU.
async function detectGpu() {
  try {
    const info = await app.getGPUInfo('complete');
    gpuDevices = (info && Array.isArray(info.gpuDevice)) ? info.gpuDevice : [];
    gpuRenderer = (info && info.auxAttributes && info.auxAttributes.glRenderer) || '';
  } catch (_) {
    try {
      const info = await app.getGPUInfo('basic');
      gpuDevices = (info && Array.isArray(info.gpuDevice)) ? info.gpuDevice : [];
    } catch (__) {
      gpuDevices = [];
    }
    gpuRenderer = '';
  }
}

// Plan which engine will recognise this clip.
//
// Order matters, and the old order was the bug: it picked Parakeet from an
// Auto-resolved Fast heuristic, built the vocabulary prompt for Parakeet
// (which has no mechanism, so the prompt was empty), then the sidecar only
// bounced back to Qwen when it saw a nonempty prompt. Count the applicable
// terms first, ask the capability planner with that count, then size the
// prompt for the engine that will actually run.
function planDictationRoute(options) {
  const opts = options || {};
  const language = opts.language || settings.dictationLanguage || 'en';
  const requested = style.normalizeDictationQuality(
    opts.requestedQuality || opts.quality || settings.dictationQuality
  );
  const heuristic = requested === 'auto'
    ? currentDictationQuality()
    : requested;
  const ranked = opts.ranked || vocabularyForDictation(language);
  const requireInModel = capabilities.shouldRequireInModelVocabulary(requested);
  const plan = capabilities.planRoute({
    engine: engineBackend,
    fastEngine: engineFastBackend,
    language,
    device: engineDevice,
    quality: heuristic === 'fast' || requested === 'fast' ? 'fast' : 'accurate',
    termCount: ranked.length,
    requireInModelVocabulary: requireInModel,
  });
  const usingFast = !!(engineFastBackend && plan.engine === engineFastBackend);
  return {
    language,
    requested,
    heuristic,
    ranked,
    plan,
    requireInModel,
    engine: plan.engine,
    sidecarQuality: usingFast ? 'fast' : 'accurate',
  };
}

// Whether an "accurate" dictation should still be handed to the fast engine.
function asrQualityFor(quality) {
  return planDictationRoute({ quality }).sidecarQuality;
}

// Which engine will run this clip, for callers that have not yet heard back
// from the sidecar. History prefers the sidecar-reported engine.
function asrEngineFor(quality) {
  return planDictationRoute({ quality }).engine;
}

function currentDictationQuality() {
  const category = style.classifyTarget(lastTarget.exe, lastTarget.title);
  return style.dictationPath(category, settings, lastTarget, lastDurationMs);
}

async function sidecarTranscribe(wavPath, options) {
  const opts = options || {};
  try {
    return await sidecarTranscribeAttempt(wavPath, opts);
  } catch (err) {
    const backend = engineQwenBackend;
    const blocked = qwenAccelSessionBlock && qwenAccelSessionBlock.backend;
    const gpuKind = (backend === 'cuda' || backend === 'rocm')
      ? backend
      : ((blocked === 'cuda' || blocked === 'rocm') ? blocked : '');
    if (!opts._cpuRetry && gpuKind) {
      if (!qwenAccelSessionBlock) {
        qwenAccelSessionBlock = {
          backend: gpuKind,
          reason: (err && err.message) || 'GPU recognition failed.',
          at: Date.now(),
        };
      }
      sidecarReady = false;
      restartSidecar();
      return sidecarTranscribeAttempt(wavPath, Object.assign({}, opts, { _cpuRetry: true }));
    }
    throw err;
  }
}

async function sidecarTranscribeAttempt(wavPath, options) {
  const opts = options || {};
  requestSidecarStart();
  await waitForSidecarReady(600000);
  return new Promise((resolve, reject) => {
    if (!sidecar || !sidecarReady) {
      reject(new Error('speech engine not ready'));
      return;
    }
    const id = sidecarQueue.nextId();
    sidecarQueue.register(id, (msg) => {
      if (!msg || !msg.ok) {
        reject(new Error(friendlyEngineError((msg && msg.error) || 'speech engine failed')));
        return;
      }
      lastAsrReport = Object.assign({
        engine: String(msg.engine || ''),
        device: String(msg.device || ''),
        vocabulary: String(msg.vocabulary || ''),
        routed: String(msg.routed || ''),
        segments: Array.isArray(msg.segments) ? msg.segments : null,
        modelRecognitionMs: Number(msg.recognition_sec) > 0
          ? Math.round(Number(msg.recognition_sec) * 1000)
          : 0,
      }, qwenAccel.sidecarDiagnostics(msg));
      if (msg.backend) applyQwenSidecarReport(msg);
      if (lastVocabularyReport) {
        lastVocabularyReport.actualEngine = lastAsrReport.engine;
        lastVocabularyReport.device = lastAsrReport.device || lastVocabularyReport.device;
        if (lastAsrReport.engine && lastVocabularyReport.engine
            && lastAsrReport.engine !== lastVocabularyReport.engine) {
          lastVocabularyReport.reason = lastVocabularyReport.reason
            || ('Sidecar ran ' + capabilities.engineLabel(lastAsrReport.engine)
              + ' instead of ' + capabilities.engineLabel(lastVocabularyReport.engine) + '.');
        }
      }
      resolve(msg.text || '');
    }, reject, Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 60000);
    const language = opts.language || settings.dictationLanguage || 'en';
    const route = planDictationRoute({
      language,
      quality: opts.quality,
      requestedQuality: opts.requestedQuality,
    });
    const engine = route.engine;
    const context = vocabulary.contextFor(route.ranked, { engine, language: route.language });
    const payload = { path: wavPath, language: route.language, id };
    if (context.text) payload.prompt = context.text;
    payload.termCount = route.ranked.length;
    payload.requireVocabulary = route.requireInModel;
    if (opts.vad === false) payload.vad = false;
    if (route.sidecarQuality === 'fast' || route.sidecarQuality === 'accurate') {
      payload.quality = route.sidecarQuality;
    }
    lastVocabularyReport = {
      selectedEngine: engineBackend || '',
      selectedDevice: settings.asrDevice || '',
      backend: engineQwenBackend || 'cpu',
      gpuName: engineGpuName || '',
      computeType: engineComputeType || '',
      packId: enginePackId || '',
      fallbackReason: engineFallbackReason || '',
      engine,
      device: engineDevice || '',
      language: route.language,
      requestedQuality: route.requested,
      quality: route.sidecarQuality,
      heuristicQuality: route.heuristic,
      mechanism: context.mechanism || 'unsupported',
      via: route.plan.vocabularyVia,
      offered: route.ranked.length,
      sent: context.budget.terms,
      tokens: context.budget.tokens,
      dropped: context.dropped.length,
      droppedTerms: context.dropped.slice(0, 8),
      reason: route.plan.reason || '',
      fallbackFrom: route.plan.fallbackFrom || '',
      degraded: !!route.plan.degraded,
      lostCapabilities: route.plan.lostCapabilities || [],
      summary: capabilities.summarizeRoute(route.plan, {
        quality: route.sidecarQuality,
        termsSent: context.budget.terms,
      }),
    };
    sidecar.stdin.write(JSON.stringify(payload) + '\n');
  });
}

function dictationHotkeyHandler() {
  // globalShortcut reports key-down but has no matching key-up callback. The
  // native watcher owns both edges in PTT mode; accepting this callback too
  // would start or stop the same recording twice.
  if (isPtt()) return;
  if (chordStaleHeld) return;
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
  if (chordWatchRestartTimer) {
    clearTimeout(chordWatchRestartTimer);
    chordWatchRestartTimer = null;
  }
  chordWatchAccel = '';
  chordWatchRestartDelay = 250;
  chordStaleHeld = false;
  if (chordWatch) {
    const proc = chordWatch;
    chordWatch = null;
    try { proc.kill(); } catch (_) {}
  }
}

function scheduleChordWatchRestart(accel) {
  if (isQuitting || chordWatchRestartTimer || !sameShortcut(chordWatchAccel, accel)) return;
  const delay = chordWatchRestartDelay;
  chordWatchRestartDelay = Math.min(5000, chordWatchRestartDelay * 2);
  chordWatchRestartTimer = setTimeout(() => {
    chordWatchRestartTimer = null;
    if (!isQuitting && !chordWatch && sameShortcut(chordWatchAccel, accel)
        && !launchChordWatch(accel)) scheduleChordWatchRestart(accel);
  }, delay);
}

// One compiled Win32 loop reports physical DOWN/UP edges for every PTT chord.
// It replaces the old 70 ms setInterval that started a new PowerShell process
// on every tick and treated a timeout or empty result as a key release.
function launchChordWatch(accel) {
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
  let buf = '';
  proc.stdout.on('data', (chunk) => {
    if (chordWatch !== proc) return;
    chordWatchRestartDelay = 250;
    buf += String(chunk);
    const lines = buf.split(/\r?\n/);
    buf = lines.pop() || '';
    for (const line of lines) {
      const msg = line.trim();
      if (!msg) continue;
      // The watcher's opening line says whether the chord was already down
      // when it started looking. That hold predates the watcher, so it is
      // never a press: "UP stale" only ends a recording a previous watcher
      // began before it died mid-hold.
      if (msg === 'HELD') { chordStaleHeld = true; continue; }
      if (msg === 'FREE') { chordStaleHeld = false; continue; }
      if (msg === 'UP stale') {
        chordStaleHeld = false;
        if (isPtt() && (mode === 'arming' || mode === 'recording')) requestPttStop();
        continue;
      }
      // Push to talk wants the edges; toggle wants one event per press, and it
      // has to be the release -- "dirty" is how a chord that was really
      // Ctrl+Win+Left stays a virtual-desktop switch and nothing more.
      if (isPtt()) {
        if (msg === 'DOWN') pttPress();
        // Push to talk cannot know a chord is dirty until it ends, so it starts
        // recording either way and throws the result out rather than leaving a
        // stray transcript behind every virtual-desktop switch.
        else if (msg === 'UP dirty') pttRelease(true);
        else if (msg === 'UP clean') pttRelease(false);
      } else if (msg === 'UP clean' && hotkeys.isModifierOnly(chordWatchAccel)) {
        dictationHotkeyHandler();
      }
    }
  });
  const lost = () => {
    if (chordWatch === proc) {
      chordWatch = null;
      scheduleChordWatchRestart(accel);
    }
  };
  proc.on('error', lost);
  proc.on('exit', lost);
  return true;
}

function startChordWatch(accel) {
  stopChordWatch();
  chordWatchAccel = accel;
  chordWatchRestartDelay = 250;
  if (launchChordWatch(accel)) return true;
  chordWatchAccel = '';
  return false;
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
    if (!startChordWatch(candidate)) {
      unregisterDictationShortcut();
      return { ok: false, reason: formatShortcutLabel(candidate) + ' could not be watched. Try another combination.' };
    }
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
  if (mode !== 'arming' || mediaPreparing) return;
  const stopOnReady = pttReleasePending;
  pttReleasePending = false;
  recordingStartedAt = Date.now();
  mode = 'recording';
  sendOverlay({ mode: 'recording' });
  if (stopOnReady) requestStop();
});
ipcMain.on('hud-hidden', (e) => {
  // Only the overlay may hide the overlay. The same preload is loaded by the
  // main window, and a stray call from there would take the bar off screen
  // with nothing to bring it back.
  if (!overlayWin || overlayWin.isDestroyed() || e.sender !== overlayWin.webContents) return;
  hideOverlayWindow();
});
ipcMain.on('hud-ignore-mouse', (e, ignore) => {
  if (!overlayWin || overlayWin.isDestroyed()) return;
  if (e.sender !== overlayWin.webContents) return;
  setOverlayMouseIgnore(!!ignore);
});
ipcMain.on('overlay-drag-start', (e) => {
  if (!overlayWin || overlayWin.isDestroyed() || e.sender !== overlayWin.webContents) return;
  startOverlayDrag();
});
ipcMain.on('overlay-drag-end', (e) => {
  if (!overlayWin || overlayWin.isDestroyed() || e.sender !== overlayWin.webContents) return;
  stopOverlayDrag(true);
});
ipcMain.on('overlay-settings', (e) => {
  if (!overlayWin || overlayWin.isDestroyed() || e.sender !== overlayWin.webContents) return;
  openHistory('general');
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
ipcMain.handle('flow-bar-reset', async () => {
  resetFlowBarPosition();
  broadcast();
  return snapshot();
});
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
    positionOverlay();
    overlayWin.focus();
  }
  setOverlayMouseIgnore(false);
});
ipcMain.on('overlay-release', () => {
  overlayEditing = false;
  try { overlayWin && overlayWin.setFocusable(false); } catch (_) {}
  positionOverlay();
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
  // Asynchronous: this thread also drives the overlay's drag and cursor
  // timers, and a multi-megabyte synchronous write is a visible hitch in the
  // bar at exactly the moment the user stops talking.
  await fs.promises.writeFile(tmp, buf);
  // 16 kHz mono 16-bit: the clip length is in the byte count. A long clip on
  // a CPU engine can legitimately outlast a flat minute, and a timeout that
  // fires while the engine is still decoding leaves the next request queued
  // behind work nobody will read.
  const audioSec = Math.max(0, (buf.length - 44) / 32000);
  opts.timeoutMs = Math.max(60000, Math.round(20000 + audioSec * 8000));
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
ipcMain.handle('asr-runtime-install', () => runAsrOperation('install', async () => {
  asrSetupController = new AbortController();
  try {
    await setupDictation(asrSetupController.signal);
    engineError = '';
  } catch (err) {
    asrRuntimeState = {
      status: asrSetupController.signal.aborted || (err && err.code === 'CANCELLED') ? 'cancelled' : 'error',
      progress: null, step: asrRuntimeState.step || 'engine',
      message: err && err.message ? err.message : 'Dictation could not be set up.',
    };
  }
  saveAsrSetupState();
}));
// Download one optional component -- the fast English path, or another engine
// to switch to later. Same operation lock and the same progress reporting as a
// first-time setup, because to a user it is the same thing happening.
ipcMain.handle('speech-model-install', (_e, id) => {
  const wanted = String(id || '').trim();
  if (!modelPlan.COMPONENT_IDS.includes(wanted)) return snapshot();
  return runAsrOperation('install', async () => {
    asrSetupController = new AbortController();
    try {
      await setupDictation(asrSetupController.signal, { components: [wanted] });
      engineError = '';
    } catch (err) {
      asrRuntimeState = {
        status: asrSetupController.signal.aborted || (err && err.code === 'CANCELLED') ? 'cancelled' : 'error',
        progress: null,
        step: asrRuntimeState.step || 'model',
        message: err && err.message ? err.message : 'That speech model could not be downloaded.',
      };
    }
    saveAsrSetupState();
  });
});

// Remove one model the settings list as installed but the chosen engine does
// not need. The engine's own model goes with "Remove engine and model"; this
// leaves the engine, the switch that enables dictation, and every other model
// exactly as they are. Same operation lock as an install, so a removal cannot
// run under a download or under another removal.
ipcMain.handle('speech-model-remove', (_e, id) => {
  const wanted = String(id || '').trim();
  const component = modelPlan.COMPONENTS[wanted];
  if (!component) return snapshot();
  if (asrOperation) return asrOperation.promise;
  return runAsrOperation('remove', async () => {
    removingAsrRuntime = true;
    asrRuntimeState = { status: 'removing', progress: null, step: component.manager,
      message: 'Removing ' + component.name + '…' };
    broadcast();
    try {
      await cancelListen();
      await stopPythonProcesses();
      if (component.manager === 'model') {
        if (asrModelManager) await asrModelManager.remove();
      } else if (speechModelsManager) {
        await speechModelsManager.remove([wanted]);
      }
      const engineInstalled = !!(asrRuntimeManager && asrRuntimeManager.installed());
      asrRuntimeState = { status: engineInstalled ? 'installed' : 'idle', progress: null, step: '',
        message: component.name + ' was removed from this PC.' };
    } catch (err) {
      asrRuntimeState = { ...removeFailure(component.name, err), step: component.manager };
    }
    saveAsrSetupState();
  }).then((result) => {
    // The operation lock held the restart back. The process comes back now,
    // on whatever is still installed; if that no longer includes the model
    // the chosen engine needs, it says so and offers the download.
    restartSidecar();
    return result;
  });
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
// A pack's libraries are open in the speech process for as long as it runs,
// and Windows will not delete an open file: removing under a live process
// used to fail half way and leave a pack that was neither installed nor gone,
// or sit on a locked handle until the click looked hung. So the process is
// stopped and gone before the first file is touched, and comes back
// afterwards on whatever is still installed. The flag keeps the exit handler
// from restarting it in between.
async function removeWithProcessStopped(remove) {
  removingAsrRuntime = true;
  try {
    await stopPythonProcesses();
    return await remove();
  } finally {
    removingAsrRuntime = false;
  }
}

function removeFailure(label, err) {
  return { status: 'error', progress: null,
    message: 'Could not remove ' + label + ': ' + (err && err.message ? err.message : 'Unknown error') + '. Try again.' };
}

ipcMain.handle('cuda-pack-remove', async () => {
  if (cudaPackManager) {
    try {
      await removeWithProcessStopped(() => cudaPackManager.remove());
      cudaPackState = { status: 'idle', progress: null, message: '' };
    } catch (err) {
      cudaPackState = removeFailure('NVIDIA GPU support', err);
    }
    // Back to the CPU.
    restartSidecar();
  }
  broadcast();
  return snapshot();
});

function qwenAccelManager(kind) {
  return String(kind || '').trim().toLowerCase() === 'rocm' ? qwenRocmPackManager : qwenCudaPackManager;
}

ipcMain.handle('qwen-accel-install', async (_e, kind) => {
  const manager = qwenAccelManager(kind);
  if (!manager) return snapshot();
  const label = manager.label;
  try {
    qwenAccelSessionBlock = null;
    await manager.install();
    restartSidecar();
  } catch (err) {
    const state = {
      status: err && err.code === 'CANCELLED' ? 'cancelled' : 'error',
      progress: null,
      message: err && err.message ? err.message : (label + ' could not be installed.'),
    };
    if (manager.kind === 'rocm') qwenRocmPackState = state;
    else qwenCudaPackState = state;
  }
  broadcast();
  return snapshot();
});
ipcMain.handle('qwen-accel-cancel', async (_e, kind) => {
  const manager = qwenAccelManager(kind);
  if (manager) manager.cancel();
  return snapshot();
});
ipcMain.handle('qwen-accel-remove', async (_e, kind) => {
  const manager = qwenAccelManager(kind);
  if (manager) {
    let state;
    try {
      await removeWithProcessStopped(() => manager.remove());
      state = { status: 'idle', progress: null, message: '' };
    } catch (err) {
      state = removeFailure(manager.label, err);
    }
    if (manager.kind === 'rocm') qwenRocmPackState = state;
    else qwenCudaPackState = state;
    qwenAccelSessionBlock = null;
    restartSidecar();
  }
  broadcast();
  return snapshot();
});
ipcMain.handle('qwen-accel-retry', async () => {
  qwenAccelSessionBlock = null;
  restartSidecar();
  broadcast();
  return snapshot();
});
ipcMain.handle('asr-runtime-cancel', () => {
  if (asrSetupController) asrSetupController.abort();
  if (asrRuntimeManager) asrRuntimeManager.cancel();
  if (asrModelManager) asrModelManager.cancel();
  if (speechModelsManager) speechModelsManager.cancel();
  if (asrOperation && asrOperation.kind === 'install') {
    asrRuntimeState = { ...asrRuntimeState, status: 'cancelling', message: 'Cancelling setup…' };
    broadcast();
  }
  return snapshot();
});
ipcMain.handle('asr-runtime-remove', () => runAsrOperation('remove', async () => {
  removingAsrRuntime = true;
  asrRuntimeState = { status: 'removing', progress: null, step: 'engine', message: 'Removing speech engines and models…' };
  broadcast();
  try {
    // Persist the user's intent before touching files. A failed delete or an
    // app restart must never start a model the user just asked to disable.
    fs.mkdirSync(ASR_RUNTIME, { recursive: true });
    fs.writeFileSync(asrDisabledPath(), '{}');
    await cancelListen();
    await stopPythonProcesses();
    if (asrRuntimeManager) await asrRuntimeManager.remove();
    if (asrModelManager) await asrModelManager.remove();
    if (speechModelsManager) await speechModelsManager.remove();
    asrRuntimeState = { status: 'removed', progress: null,
      message: 'Speech engines removed. Dictation is disabled until you set it up again.', step: '' };
  } catch (err) {
    asrRuntimeState = { status: 'error', progress: null, step: 'engine',
      message: 'Could not remove the speech engine: ' + (err.message || 'Unknown error')
        + '. Dictation remains disabled. Try Remove again.' };
  }
  engineError = 'Speech engines are disabled. Set up dictation to use them again.';
  engineWarning = '';
  engineFix = '';
  engineFixEngine = '';
  setSidecarState('unavailable');
  saveAsrSetupState();
}));
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
// Opening the panel is what counts as reading it, so the badge clears on open
// rather than on a per-item click the user has no reason to make.
ipcMain.handle('notifications-read', async () => {
  applyNotifications(announcements.markAllRead(notifications), { broadcast: false });
  return snapshot();
});
ipcMain.handle('notifications-dismiss', async (_e, id) => {
  applyNotifications(announcements.clearOne(notifications, id), { broadcast: false });
  return snapshot();
});
ipcMain.handle('notifications-clear', async () => {
  applyNotifications(announcements.clearAll(notifications), { broadcast: false });
  return snapshot();
});
ipcMain.handle('settings-set', async (_e, patch) => {
  if (!patch || typeof patch !== 'object') return snapshot();

  if (patch.dictateMode === 'ptt' || patch.dictateMode === 'toggle') {
    settings.dictateMode = patch.dictateMode;
    if (patch.dictateMode === 'toggle') pttReleasePending = false;
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
    // The picker reports a chord on key-down, so the keys are still held as
    // the new registration goes live. Treat them as held until the watcher
    // says otherwise; a hotkey auto-repeat arriving before it has even
    // started must not become a recording.
    if (res.ok) chordStaleHeld = true;
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
    'smartRewriteEnabled', 'verbatimMode', 'verbatimDictionary', 'numbersAsDigits',
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
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (app.isReady()) openHistory();
    else app.once('ready', () => openHistory());
  });

  app.whenReady().then(async () => {
    initPaths();
    loadStores();
    loadAsrSetupState();
    tidyModelStorage();
    deliverAnnouncements();
    updater.startUpdater({
      getMode: () => mode,
      onStatusChange: (status) => {
        // Only a finished download is news. Checking and downloading are
        // states the System settings pane already reports, and neither is
        // something the user has to do anything about.
        if (status && status.status === 'ready') {
          applyNotifications(
            announcements.note(notifications, announcements.updateReadyEntry(status.availableVersion)),
            { broadcast: false },
          );
        }
        broadcast();
      },
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
    // Compile the Win32 helper now, while nothing is waiting on it, so the
    // first paste does not pay for it.
    warmPsServers();
    // Resolution, scale and taskbar changes all come through metrics-changed;
    // plugging a monitor in or out does not, and that is the case that used to
    // leave the bar parked on a screen the user no longer had.
    screen.on('display-metrics-changed', scheduleOverlayReflow);
    screen.on('display-added', scheduleOverlayReflow);
    screen.on('display-removed', scheduleOverlayReflow);
    // Qwen's interpreter is selected from the detected GPU vendor. Starting
    // before getGPUInfo resolves locks a verified CUDA or ROCm installation to
    // CPU until something else happens to restart the sidecar.
    // Probe imports and model availability, but defer the expensive --serve
    // process until the user starts dictating.
    await startSidecarAfterGpuDetection(detectGpu, startSidecar, broadcast, { probeOnly: true });
  });

  app.on('before-quit', (event) => {
    if (mediaShutdownDone) return;
    event.preventDefault();
    if (isQuitting) return;
    isQuitting = true;
    recordingSessionToken += 1;
    if (mode === 'arming' || mode === 'recording' || mode === 'transcribing') {
      mode = 'cancel';
      sendOverlay({ mode: 'cancel', text: 'Cancelled' });
    }
    if (languagePackManager) languagePackManager.cancel();
    if (asrRuntimeManager) asrRuntimeManager.cancel();
    if (asrModelManager) asrModelManager.cancel();
    if (speechModelsManager) speechModelsManager.cancel();
    if (asrSetupController) asrSetupController.abort();
    clearTimeout(sidecarRestartTimer);
    if (sidecarProbe) sidecarProbe.kill();
    backgroundMedia.close().finally(() => {
      mediaShutdownDone = true;
      app.quit();
    });
  });

  app.on('will-quit', (e) => {
    if (updater.tryInstallOnQuit()) {
      e.preventDefault();
      return;
    }
    updater.stopUpdater();
    if (localRewriteRuntime) localRewriteRuntime.stop();
    globalShortcut.unregisterAll();
    pttReleasePending = false;
    // A watcher left running would outlive the app and hold a powershell process.
    stopChordWatch();
    stopForegroundWatch();
    stopPsServers();
    stopOverlayDrag(false);
    if (overlayReflowTimer) clearTimeout(overlayReflowTimer);
    if (hwndTimer) clearInterval(hwndTimer);
    clearSidecarLaunchPlan();
    closeSidecarLog();
    if (sidecar) {
      try { sidecar.stdin.write('QUIT\n'); } catch (_) {}
      sidecar.kill();
    }
    corpus.clearRetry();
  });
}
