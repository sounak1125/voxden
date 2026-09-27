'use strict';

const navButtons = document.querySelectorAll('.nav-item:not(.sidebar-toggle)');
const panes = {
  dictation: document.getElementById('view-dictation'),
  dictionary: document.getElementById('view-dictionary'),
  'writing-style': document.getElementById('view-writing-style'),
  polish: document.getElementById('view-polish'),
  insights: document.getElementById('view-insights'),
  help: document.getElementById('view-help'),
};

const navSettingsBtn = document.getElementById('nav-settings');
const sidebarEl = document.getElementById('sidebar');
const sidebarToggleEl = document.getElementById('sidebar-toggle');
const settingsOverlay = document.getElementById('settings-overlay');
const settingsCloseBtn = document.getElementById('settings-close');
const settingsDetailEl = document.querySelector('.settings-detail');
const shortcutsDialog = document.getElementById('shortcuts-dialog');
const shortcutsChangeBtn = document.getElementById('shortcuts-change');
const shortcutsCloseBtn = document.getElementById('shortcuts-close');
const shortcutsStatusEl = document.getElementById('shortcuts-status');

const notifBtnEl = document.getElementById('notif-btn');
const notifBadgeEl = document.getElementById('notif-badge');
const notifPanelEl = document.getElementById('notif-panel');
const notifListEl = document.getElementById('notif-list');
const notifEmptyEl = document.getElementById('notif-empty');
const notifClearEl = document.getElementById('notif-clear');

// Declared up here with the elements rather than beside the code that uses
// them: openSettings closes the panel, and openSettings can run before the
// bottom of this file has been reached.
let notifOpen = false;
// The ids that were unread at the moment the panel opened. They are marked
// read immediately -- the badge has done its job by then -- but they keep the
// highlight until the panel closes, so opening it does not erase the only clue
// about which ones are new.
let notifNewIds = new Set();
// What the list was last built from. render() runs on every broadcast from the
// main process, including one per dictation, and rebuilding unconditionally
// would restart the row animations and drop the hover under the pointer.
let notifSignature = '';

const emptyEl = document.getElementById('empty');
const groupsEl = document.getElementById('groups');
const recoveriesEl = document.getElementById('recoveries');
const searchEl = document.getElementById('search');
const dictFormEl = document.getElementById('dict-form');
const dictFromEl = document.getElementById('dict-from');
const dictToEl = document.getElementById('dict-to');
const dictToMapEl = document.getElementById('dict-to-map');
const dictSubmitEl = document.getElementById('dict-submit');
const dictErrorEl = document.getElementById('dict-error');
const dictSearchEl = document.getElementById('dict-search');
const dictEmptyEl = document.getElementById('dict-empty');
const dictNoMatchEl = document.getElementById('dict-no-match');
const dictListEl = document.getElementById('dict-list');
const dictVariantsEl = document.getElementById('dict-variants');
const dictAddNewEl = document.getElementById('dict-add-new');
const vocabOverlayEl = document.getElementById('dict-vocab-overlay');
const vocabMisspellEl = document.getElementById('vocab-misspell');
const vocabCancelEl = document.getElementById('vocab-cancel');
const vocabWordFieldEl = document.getElementById('vocab-word-field');
const vocabMappingEl = document.getElementById('vocab-mapping-fields');
const vocabTitleEl = document.getElementById('vocab-title');
const greetingSaluteEl = document.getElementById('greeting-salute');
const greetingNameEl = document.getElementById('greeting-name');
const statWordsEl = document.getElementById('statWords');
const statNotesEl = document.getElementById('statNotes');
const statWeekEl = document.getElementById('statWeek');
const weekBarsEl = document.getElementById('week-bars');
const statWpmEl = document.getElementById('statWpm');
const statTimeSavedEl = document.getElementById('statTimeSaved');
const modeToggleEl = document.getElementById('mode-toggle');
const modePttEl = document.getElementById('mode-ptt');
const qualityAutoEl = document.getElementById('quality-auto');
const qualityFastEl = document.getElementById('quality-fast');
const qualityAccurateEl = document.getElementById('quality-accurate');

const settingsCatButtons = document.querySelectorAll('.settings-cat');
const settingsPanels = document.querySelectorAll('.settings-panel');
const shortcutDisplayEl = document.getElementById('shortcut-display');
const shortcutChangeBtn = document.getElementById('shortcut-change');
const pasteLastShortcutDisplayEl = document.getElementById('paste-last-shortcut-display');
const pasteLastShortcutChangeBtn = document.getElementById('paste-last-shortcut-change');
const shortcutCaptureHint = document.getElementById('shortcut-capture-hint');

const vuCardEl = document.getElementById('voice-understanding');
const vuPctEl = document.getElementById('vu-pct');
const vuMetaEl = document.getElementById('vu-meta');
const vuRingProgressEl = document.getElementById('vu-ring-progress');
const vuProfileEl = document.getElementById('vu-profile');
const vuGainEl = document.getElementById('vu-gain');

// 2 * pi * 43: the ring's radius in its 96px box. Matches stroke-dasharray in app.css.
const VU_RING_LEN = 270.2;
const DM_COUNT_MS = 1100;

const dmWpmMetricEl = document.getElementById('dm-wpm-metric');
const dmSavedMetricEl = document.getElementById('dm-saved-metric');

const dmMetricsEl = document.getElementById('dictation-metrics');
const dmWpmContextEl = document.getElementById('dm-wpm-context');
const dmSavedContextEl = document.getElementById('dm-saved-context');
const dmAnim = { wpm: null, savedMs: 0, wpmRaf: 0, savedRaf: 0 };
let vuLastWordCount = null;
let vuGainTimer = 0;

const customSelectMap = new WeakMap();
const customSelectEls = [];

function closeCustomSelect(select, focusTrigger) {
  const state = customSelectMap.get(select);
  if (!state || !state.open) return;
  state.open = false;
  state.activeIndex = -1;
  state.list.hidden = true;
  state.wrap.classList.remove('is-open');
  state.trigger.setAttribute('aria-expanded', 'false');
  for (const opt of state.list.querySelectorAll('.custom-select-option')) {
    opt.classList.remove('is-active');
  }
  if (focusTrigger) state.trigger.focus();
}

function closeAllCustomSelects(except) {
  for (const select of customSelectEls) {
    if (select !== except) closeCustomSelect(select, false);
  }
}

function positionSettingsSelect(state) {
  const pane = state.wrap.closest('.settings-detail');
  if (!pane || !state.open) return;
  const bounds = pane.getBoundingClientRect();
  const trigger = state.trigger.getBoundingClientRect();
  const below = Math.max(0, bounds.bottom - trigger.bottom - 8);
  const above = Math.max(0, trigger.top - bounds.top - 8);
  const desiredHeight = Math.min(220, state.list.scrollHeight + 2);
  const openAbove = below < desiredHeight && above > below;
  state.list.style.top = openAbove ? 'auto' : 'calc(100% + 4px)';
  state.list.style.bottom = openAbove ? 'calc(100% + 4px)' : 'auto';
  state.list.style.maxHeight = Math.min(220, openAbove ? above : below) + 'px';
}

function repositionSettingsSelects() {
  for (const select of customSelectEls) positionSettingsSelect(customSelectMap.get(select));
}

function openCustomSelect(select) {
  const state = customSelectMap.get(select);
  if (!state || select.disabled) return;
  closeAllCustomSelects(select);
  state.open = true;
  state.list.hidden = false;
  state.wrap.classList.add('is-open');
  state.trigger.setAttribute('aria-expanded', 'true');
  const options = state.list.querySelectorAll('.custom-select-option');
  let idx = select.selectedIndex;
  if (idx < 0) idx = 0;
  state.activeIndex = idx;
  for (let i = 0; i < options.length; i++) {
    options[i].classList.toggle('is-active', i === idx);
  }
  positionSettingsSelect(state);
  const active = options[idx];
  if (active) active.scrollIntoView({ block: 'nearest' });
}

function chooseCustomSelectOption(select, value) {
  if (select.disabled || select.value === value) {
    closeCustomSelect(select, true);
    return;
  }
  select.value = value;
  select.dispatchEvent(new Event('change', { bubbles: true }));
  syncCustomSelect(select);
  closeCustomSelect(select, true);
}

function moveCustomSelectActive(select, delta) {
  const state = customSelectMap.get(select);
  if (!state) return;
  const options = state.list.querySelectorAll('.custom-select-option');
  if (!options.length) return;
  if (!state.open) {
    openCustomSelect(select);
    return;
  }
  let next = state.activeIndex + delta;
  if (next < 0) next = options.length - 1;
  if (next >= options.length) next = 0;
  state.activeIndex = next;
  for (let i = 0; i < options.length; i++) {
    options[i].classList.toggle('is-active', i === next);
  }
  options[next].scrollIntoView({ block: 'nearest' });
}

function syncCustomSelect(select) {
  const state = customSelectMap.get(select);
  if (!state) return;
  const { wrap, trigger, label, list } = state;
  wrap.classList.toggle('is-loading', select.classList.contains('is-loading'));
  const disabled = select.disabled;
  trigger.disabled = disabled;
  wrap.classList.toggle('is-disabled', disabled);
  const selected = select.options[select.selectedIndex];
  label.textContent = selected ? selected.textContent : '';
  trigger.setAttribute('aria-label', selected ? selected.textContent : 'Select');
  const signature = JSON.stringify(Array.from(select.options, opt => [opt.value, opt.textContent, opt.selected]));
  if (state.signature === signature) return;
  state.signature = signature;
  list.innerHTML = '';
  for (const opt of select.options) {
    const li = document.createElement('li');
    li.className = 'custom-select-option';
    li.setAttribute('role', 'option');
    li.dataset.value = opt.value;
    li.textContent = opt.textContent;
    if (opt.selected) {
      li.classList.add('is-selected');
      li.setAttribute('aria-selected', 'true');
    } else {
      li.setAttribute('aria-selected', 'false');
    }
    li.addEventListener('mousedown', (e) => e.preventDefault());
    li.addEventListener('click', () => chooseCustomSelectOption(select, opt.value));
    list.appendChild(li);
  }
  if (state.open) {
    state.activeIndex = select.selectedIndex;
    const options = list.querySelectorAll('.custom-select-option');
    for (let i = 0; i < options.length; i++) {
      options[i].classList.toggle('is-active', i === state.activeIndex);
    }
  }
}

function upgradeCustomSelect(select) {
  if (!select || customSelectMap.has(select)) return customSelectMap.get(select);
  const wrap = document.createElement('div');
  wrap.className = 'custom-select';
  if (select.classList.contains('setting-select-wide')) wrap.classList.add('custom-select-wide');
  select.classList.add('custom-select-native');
  select.parentNode.insertBefore(wrap, select);
  wrap.appendChild(select);

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'custom-select-trigger';
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-expanded', 'false');

  const label = document.createElement('span');
  label.className = 'custom-select-label';
  const chevron = document.createElement('span');
  chevron.className = 'custom-select-chevron';
  chevron.setAttribute('aria-hidden', 'true');
  trigger.appendChild(label);
  trigger.appendChild(chevron);

  const list = document.createElement('ul');
  list.className = 'custom-select-list';
  list.setAttribute('role', 'listbox');
  list.hidden = true;
  wrap.appendChild(trigger);
  wrap.appendChild(list);

  const state = { wrap, trigger, label, list, open: false, activeIndex: -1 };
  customSelectMap.set(select, state);
  customSelectEls.push(select);

  trigger.addEventListener('click', () => {
    if (select.disabled) return;
    if (state.open) closeCustomSelect(select, true);
    else openCustomSelect(select);
  });
  trigger.addEventListener('keydown', (e) => {
    if (select.disabled) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      moveCustomSelectActive(select, 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      moveCustomSelectActive(select, -1);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (state.open) {
        const options = list.querySelectorAll('.custom-select-option');
        const active = options[state.activeIndex];
        if (active) chooseCustomSelectOption(select, active.dataset.value);
      } else {
        openCustomSelect(select);
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeCustomSelect(select, true);
    }
  });

  const observer = new MutationObserver(() => syncCustomSelect(select));
  observer.observe(select, { childList: true, attributes: true, attributeFilter: ['disabled', 'class'] });

  syncCustomSelect(select);
  return state;
}

function initCustomSelects() {
  for (const select of document.querySelectorAll('select.setting-select')) {
    upgradeCustomSelect(select);
  }
}

const STYLE_DEFAULTS = {
  personal: 'veryCasual',
  work: 'casual',
  email: 'formal',
  other: 'casual',
};

const verbatimDictRowEl = document.getElementById('verbatim-dict-row');

const flowBarPositionRow = document.getElementById('flow-bar-position-row');
const flowBarResetBtn = document.getElementById('flow-bar-reset');
const flowStyleOptions = document.getElementById('flow-style-options');
const flowStyleCards = Array.from(document.querySelectorAll('.flow-style-card[data-flow-style]'));
const flowStyleStatus = document.getElementById('flow-style-status');
let pendingFlowStyle = null;
let savingFlowStyle = false;
const flowMotionSelect = document.getElementById('flow-motion-select');
const flowMotionHint = document.getElementById('flow-motion-hint');
const flowMotionStatus = document.getElementById('flow-motion-status');
const flowMotion = window.VoxdenFlowMotion;
let pendingFlowMotion = null;
let savingFlowMotion = false;

const settingInputs = {
  launchAtLogin: document.getElementById('set-launch-login'),
  alwaysShowFlowBar: document.getElementById('set-always-flow'),
  showInTaskbar: document.getElementById('set-taskbar'),
  soundsEnabled: document.getElementById('set-sounds'),
  muteMusicWhileDictating: document.getElementById('set-mute-music'),
  suggestionsEnabled: document.getElementById('set-suggestions'),
  autoAddToDictionary: document.getElementById('set-auto-add-dictionary'),
  verbatimMode: document.getElementById('set-verbatim'),
  verbatimDictionary: document.getElementById('set-verbatim-dictionary'),
  numbersAsDigits: document.getElementById('set-numbers-digits'),
  autoCleanup: document.getElementById('set-auto-cleanup'),
  keepTrainingAudio: document.getElementById('set-training-audio'),
  keepRecordings: document.getElementById('set-keep-recordings'),
  useTunedModel: document.getElementById('set-tuned-model'),
  asrDevice: document.getElementById('asr-device-select'),
  microphone: document.getElementById('mic-select'),
};

const tunedRowEl = document.getElementById('tuned-row');
const tunedHintEl = document.getElementById('tuned-hint');
const engineBannerEl = document.getElementById('engine-banner');
const engineBannerTextEl = document.getElementById('engine-banner-text');
const engineBannerBtnEl = document.getElementById('engine-banner-btn');
const engineBannerProgressEl = document.getElementById('engine-banner-progress');
const engineBannerFillEl = document.getElementById('engine-banner-fill');
const engineBannerPctEl = document.getElementById('engine-banner-pct');

// ---------------------------------------------------------------------------
// Platform awareness.
//
// One renderer serves Windows and macOS. The state snapshot says which one it
// is running on, which engines that platform offers, and whether GPU speed-up
// packs exist there at all -- a Mac has no CUDA, no DirectML and no Qwen3-ASR
// build, so those rows are removed rather than shown empty. An older snapshot
// carries none of these fields, and an older snapshot can only be Windows, so
// every default here is the Windows one.
let uiPlatform = 'win32';
let platformCopyApplied = '';

function platformOf(data) {
  return (data || {}).platform === 'darwin' ? 'darwin' : 'win32';
}
function isMacUi() { return uiPlatform === 'darwin'; }
// Windows calls the machine "this PC"; a Mac calls it "this Mac". One helper,
// so the status lines further down carry no platform branch of their own.
function thisDevice() { return isMacUi() ? 'this Mac' : 'this PC'; }
// The labels main.js sends already use this platform's key names (hotkeys.js
// formatShortcutLabel); these stand in only until the first snapshot lands.
function defaultShortcutLabel() { return isMacUi() ? 'Cmd+Shift+Space' : 'Ctrl+Win'; }
function defaultPasteShortcutLabel() { return isMacUi() ? 'Cmd+Option+V' : 'Ctrl+Alt+V'; }
function gpuPacksOffered(data) {
  const gpu = (data || {}).gpu || {};
  return gpu.packsOffered !== false;
}
function engineOffered(data, engine) {
  const list = (data || {}).availableEngines;
  return !Array.isArray(list) || list.includes(engine);
}

// Element id -> the words a Mac uses instead. Applied once, from the first
// snapshot: on Windows nothing in here is ever read, so that text stays exactly
// as app.html writes it. A value containing '<' is markup the element has to
// keep (the sign-in bullets carry their own icon, the help steps their keycaps).
const MAC_COPY = {
  'signin-kicker': 'DICTATION FOR MAC',
  'help-step-paste': 'Need them again? <kbd>Cmd</kbd> + <kbd>Option</kbd> + <kbd>V</kbd> pastes your last dictation.',
  'signin-point-local': '<i></i>Stays on this Mac until you choose the cloud',
  'launch-login-hint': 'Start Voxden when you log in to your Mac.',
  'taskbar-label': 'Show app in the Dock',
  'taskbar-hint': 'Keep Voxden in the Dock when the window is closed.',
  'flow-motion-system-option': 'Follow macOS',
  'speech-mode-local-name': 'On this Mac',
  'speech-mode-local-line': 'Your audio stays on this Mac.',
  'speech-remove-all-hint': 'Removes every downloaded model from this Mac.',
  'auto-add-dictionary-scope': 'Learns on this Mac in supported apps. Undo from the flow bar.',
  'privacy-store-label': 'Store data on this Mac',
  'privacy-training-hint': 'Keeps audio behind corrected dictations to train on your voice. Stays on this Mac, off by default.',
  'sidebar-pro-copy': 'Fast cloud dictation, without running a model on your Mac.',
  'billing-free-copy': 'Keep your dictation on this Mac.',
  'billing-pro-no-limit': 'No weekly word limit on this Mac',
  'billing-faq-model': 'Cloud dictation needs the Voxden app and an internet connection. The Free plan uses a speech model installed on your Mac.',
  'billing-faq-limit': 'The Free plan dictates 3,000 words in any seven days, on the speech model you chose for this Mac. The week starts with your first dictation and the words come back seven days later. Voxden Pro has no weekly word limit and adds cloud dictation.',
  'help-engines-hint': 'Choose your model when you first open Voxden. Parakeet v3 is recommended for a small, fast start. <b>To use the words in your dictionary, try Whisper</b> under Settings › Speech engines. These models run on your Mac.',
  'help-engine-whisper-lead': 'Uses the words in your dictionary. A larger download than Parakeet, and slower.',
  'help-engines-note': 'On this Mac, dictation is in English whichever model you use. Hindi, Hinglish and other languages need Voxden Cloud on a Pro plan: pick up to three under Settings › General, and Voxden Cloud works out which one each dictation is in. Hinglish writes Hindi in English letters.',
  'help-privacy-note': 'Only if you turn on Voxden Cloud, which needs a Pro plan. With it off, your audio stays on this Mac and dictation works offline once your model is downloaded. With it on, your audio is sent to Voxden Cloud to be transcribed.',
  'model-welcome-description': 'Choose a free speech model to get started. It runs on this Mac, in English.',
};

// Sections that only mean something on Windows: GPU speed-up packs, and the
// Qwen3-ASR build, which has no macOS release.
const MAC_HIDDEN = ['help-gpu-section', 'help-engine-qwen'];

// Two shortcut-capture hints name the Super modifier by its Windows keycap.
// They are produced at runtime, so setShortcutHint maps them on the way out.
const MAC_SHORTCUT_HINTS = {
  'Hold Ctrl, Alt, Shift or the Windows key as well.': 'Hold Ctrl, Alt, Shift or the Command key as well.',
  'Hold at least two keys, such as Ctrl and the Windows key.': 'Hold at least two keys, such as Ctrl and the Command key.',
};

// Runs once per platform, from the first snapshot. Idempotent: a repeat with
// the same platform does nothing, so a later render cannot undo it.
function applyPlatformCopy(platform) {
  const next = platform === 'darwin' ? 'darwin' : 'win32';
  uiPlatform = next;
  if (platformCopyApplied === next) return;
  platformCopyApplied = next;
  if (next !== 'darwin') return;
  for (const [id, text] of Object.entries(MAC_COPY)) {
    const el = document.getElementById(id);
    if (!el) continue;
    if (text.includes('<')) el.innerHTML = text;
    else el.textContent = text;
  }
  for (const id of MAC_HIDDEN) {
    const el = document.getElementById(id);
    if (el) el.hidden = true;
  }
}

// Settings > Speech engines. The four model rows in panel order (default
// first, then the step up a Parakeet user actually takes), and every model
// Advanced > Downloaded models can list. The renderer cannot require
// model-plan.js, so the names are repeated here.
const SPEECH_MODEL_ROWS = Object.freeze([
  Object.freeze({ id: 'parakeet', name: 'Parakeet v3' }),
  Object.freeze({ id: 'whisper-turbo', name: 'Whisper large-v3 turbo' }),
  Object.freeze({ id: 'qwen3-asr', name: 'Qwen3-ASR 1.7B' }),
  Object.freeze({ id: 'whisper', name: 'Whisper large-v3' }),
]);
const SPEECH_DOWNLOAD_MODELS = Object.freeze([
  ['parakeet', 'Parakeet v3'], ['parakeet-fp32', 'Parakeet v3 for GPU'],
  ['whisper-turbo', 'Whisper large-v3 turbo'], ['qwen3-asr', 'Qwen3-ASR 1.7B'], ['whisper', 'Whisper large-v3'],
]);
// A Cancel that replaces the button under the pointer ignores clicks this long,
// so a double-click on "Download and use" cannot cancel the download it started.
const SPEECH_ARM_MS = 500;

const speechModeOptionsEl = document.getElementById('speech-mode-options');
const speechModeLocalEl = document.getElementById('speech-mode-local');
const speechModeCloudEl = document.getElementById('speech-mode-cloud');
const speechModeBadgeEl = document.getElementById('speech-mode-cloud-badge');
const speechModeCreditsEl = document.getElementById('speech-mode-cloud-credits');
const speechModeErrorEl = document.getElementById('speech-mode-cloud-error');
const speechModelNoticeEl = document.getElementById('speech-model-notice');
// Always in the page, so the notice is announced the moment its text arrives;
// a live region that appears already full is often not announced.
const speechModelAnnounceEl = document.getElementById('speech-model-announce');
const speechModelDetailEl = document.getElementById('speech-model-detail');
const speechModelNoticeActionsEl = document.getElementById('speech-model-notice-actions');
const speechModelRepairBtn = document.getElementById('speech-model-repair');
const speechModelListEl = document.getElementById('speech-model-list');
const speechGpuRowEl = document.getElementById('speech-gpu-row');
const speechGpuHintEl = document.getElementById('speech-gpu-hint');
const speechGpuProgressRowEl = document.getElementById('speech-gpu-progress-row');
const speechGpuProgressEl = document.getElementById('speech-gpu-progress');
const speechGpuProgressFillEl = document.getElementById('speech-gpu-progress-fill');
const speechGpuProgressLabelEl = document.getElementById('speech-gpu-progress-label');
const speechGpuNoteEl = document.getElementById('speech-gpu-note');
const speechGpuErrorEl = document.getElementById('speech-gpu-error');
const speechGpuActionBtn = document.getElementById('speech-gpu-action');
const speechAdvancedEl = document.getElementById('speech-advanced');
const speechProcessorRowEl = document.getElementById('speech-processor-row');
const speechProcessorHintEl = document.getElementById('speech-processor-hint');
const speechDownloadsRowEl = document.getElementById('speech-downloads-row');
const speechDownloadsListEl = document.getElementById('speech-downloads-list');
const speechDownloadsErrorEl = document.getElementById('speech-downloads-error');
const speechRepairRowEl = document.getElementById('speech-repair-row');
const speechRepairBtn = document.getElementById('speech-repair');
const speechRemoveAllRowEl = document.getElementById('speech-remove-all-row');
const speechRemoveAllBtn = document.getElementById('speech-remove-all');
const speechRemoveAllErrorEl = document.getElementById('speech-remove-all-error');
// Captured before the custom select upgrades the element, so render can
// detach and reattach them without rebuilding.
const speechProcessorOptions = settingInputs.asrDevice
  ? Object.fromEntries(Array.from(settingInputs.asrDevice.options, (opt) => [opt.value, opt]))
  : {};

let pendingListenMode = null;      // true | false | null
let savingListenMode = false;
const speechPending = new Set();   // action keys a click has started and not yet settled
let speechOp = null;               // { kind: 'install'|'repair'|'remove'|'remove-all', row?, component?, key?, pending, localError }
let speechActiveRow = null;        // engine id the running install is drawn on
let speechDismissedError = '';     // asrRuntimeState error the user has moved past
let speechCudaRestartPending = false; // the NVIDIA pack ran; the engine has not restarted on it yet
const speechArmedAt = new Map();   // engine id or 'gpu' -> ms before which Cancel ignores clicks
const speechDownloadNodes = new Map(); // Downloaded models key -> <li>
const qwenAccelInfoRequests = new Set();

// Mirrors DEVICE_LABELS in asr.js; a renderer cannot require it. One DirectX 12
// backend serves AMD and Intel, so the label names the badge on the machine
// rather than the API behind it.
const DEVICE_LABELS = { cuda: 'NVIDIA GPU', directml: 'AMD or Intel GPU', rocm: 'supported AMD GPU', cpu: 'CPU' };

const trainingRowEl = document.getElementById('training-row');
const trainingStatsEl = document.getElementById('training-stats');
const recordingsHintEl = document.getElementById('recordings-hint');
const recordingsClearBtn = document.getElementById('recordings-clear');
const recordingsClearStatusEl = document.getElementById('recordings-clear-status');
let clearingRecordings = false;
const trainingClearBtn = document.getElementById('training-clear');

const appVersionDisplayEl = document.getElementById('app-version-display');
const updateStatusHintEl = document.getElementById('update-status-hint');
const updateCheckBtn = document.getElementById('update-check-btn');
const updateRestartBtn = document.getElementById('update-restart-btn');

let micDevices = [];
let defaultMicId = null;
let micListLoading = false;

let view = 'dictation';
let settingsOpen = false;
let settingsCat = 'general';
let lastPayload = null;
let sidebarCollapsed = false;
let sidebarSaving = 0;

function suggestionsOn(data) {
  const payload = data || lastPayload || {};
  const api = globalThis.voxdenSuggestions;
  return api ? api.suggestionsEnabled(payload) : payload.suggestionsEnabled !== false;
}
let query = '';
let dictQuery = '';
let dictEditingFrom = null;
let dictTab = 'all';
let capturingShortcutKind = null;
// A launch-time hotkey failure the main process is still reporting. Unlike a
// rejected change, this one stays put until the shortcut is fixed.
let hotkeyNoticeText = '';
let shortcutHintTimer = 0;
// A chord of modifiers alone -- Ctrl+Win -- has no key press to end it, so the
// capture remembers the most modifiers held at once and commits on release.
// captureSawKey keeps an ordinary chord from also being read that way.
let captureMods = [];
let captureSawKey = false;
let insightsRange = 'all';
// The year the milestones card is reading. null until the first render picks
// the latest year with history.
let insightsYear = null;
// The spine picked on the milestones shelf, as { year, index }. null shows the
// default: the next milestone, or the last one once every rung is cleared.
let insShelfPick = null;
// Set when the pane is opened; the next render plays the reveal and clears it.
let insightsReveal = false;

function setView(name) {
  if (!panes[name]) return;
  if (name !== 'writing-style') resetWritingLook();
  view = name;
  closeSettings();
  for (const btn of navButtons) {
    if (btn === navSettingsBtn) continue;
    const on = btn.dataset.view === name;
    btn.classList.toggle('is-active', on);
    if (on) btn.setAttribute('aria-current', 'page');
    else btn.removeAttribute('aria-current');
  }
  for (const [key, el] of Object.entries(panes)) {
    el.hidden = key !== name;
  }
  // Opening the pane is the one moment its numbers count up and its cards
  // settle in; every later render while it stays open lands silently.
  if (name === 'polish') schedulePolishQuote(0);
  if (name === 'insights') {
    insightsReveal = true;
    renderInsights(null);
  }
  syncVocabFix();
  if (lastPayload && !document.hidden) {
    if (name === 'dictionary') renderDictionary(lastPayload);
    if (name === 'dictation') {
      renderStats(lastPayload.entries || [], lastPayload);
      // A dictation can fail while another pane is open, and the shelf only
      // renders for this one. Without this, coming back shows yesterday's.
      renderRecoveries(lastPayload);
      renderFeed(lastPayload, lastPayload.entries || []);
    }
  }
  scheduleAnalyticsRefresh();
}

function openSettings() {
  const wasOpen = settingsOpen;
  settingsOpen = true;
  // The settings overlay dims the app content and paints over the panel, so
  // a panel left open behind it is only reachable by dismissing settings.
  closeNotifications();
  // Keep the dimmed titlebar draggable without opening a notification panel
  // behind the modal or marking unseen notifications as read.
  if (notifBtnEl) notifBtnEl.disabled = true;
  settingsOverlay.hidden = false;
  navSettingsBtn.classList.add('is-active');
  for (const btn of navButtons) {
    if (btn !== navSettingsBtn) {
      btn.classList.remove('is-active');
      btn.removeAttribute('aria-current');
    }
  }
  navSettingsBtn.setAttribute('aria-current', 'page');
  if (!wasOpen && settingsCat === 'general') refreshMicrophones();
}

function closeSettings() {
  if (!settingsOpen && settingsOverlay.hidden) return;
  closeShortcutsDialog(false);
  closeAllCustomSelects();
  settingsOpen = false;
  settingsOverlay.hidden = true;
  if (notifBtnEl) notifBtnEl.disabled = false;
  navSettingsBtn.classList.remove('is-active');
  navSettingsBtn.removeAttribute('aria-current');
  stopShortcutCapture();
  for (const btn of navButtons) {
    if (btn === navSettingsBtn) continue;
    const on = btn.dataset.view === view;
    btn.classList.toggle('is-active', on);
    if (on) btn.setAttribute('aria-current', 'page');
    else btn.removeAttribute('aria-current');
  }
}

function setSettingsCat(name) {
  const changed = settingsCat !== name;
  if (changed) {
    closeShortcutsDialog(false);
    closeAllCustomSelects();
  }
  settingsCat = name;
  for (const btn of settingsCatButtons) {
    const on = btn.dataset.cat === name;
    btn.classList.toggle('is-active', on);
  }
  for (const panel of settingsPanels) {
    panel.hidden = panel.dataset.cat !== name;
  }
  if (changed) {
    settingsDetailEl.scrollTop = 0;
  }
  if (settingsOpen && name === 'general') {
    refreshMicrophones();
  } else if (settingInputs.microphone) {
    settingInputs.microphone.disabled = false;
    settingInputs.microphone.classList.remove('is-loading');
  }
}

// One in-app question with two answers. It stands in for window.confirm,
// whose native Windows box looked nothing like the rest of the app. Escape,
// the Cancel button, and a second question all answer the pending one with
// false.
const confirmDialog = document.getElementById('confirm-dialog');
const confirmTitleEl = document.getElementById('confirm-title');
const confirmBodyEl = document.getElementById('confirm-body');
const confirmOkBtn = document.getElementById('confirm-ok');
const confirmCancelBtn = document.getElementById('confirm-cancel');
let confirmResolve = null;

function settleConfirm(answer) {
  const resolve = confirmResolve;
  confirmResolve = null;
  if (confirmDialog.open) confirmDialog.close();
  if (resolve) resolve(answer);
}

function askConfirm(opts) {
  const o = typeof opts === 'string' ? { body: opts } : (opts || {});
  if (confirmResolve) settleConfirm(false);
  confirmTitleEl.textContent = o.title || 'Are you sure?';
  confirmBodyEl.textContent = o.body || '';
  confirmBodyEl.hidden = !o.body;
  confirmOkBtn.textContent = o.confirmLabel || 'OK';
  closeAllCustomSelects();
  return new Promise((resolve) => {
    confirmResolve = resolve;
    confirmDialog.showModal();
    confirmOkBtn.focus();
  });
}

confirmOkBtn.addEventListener('click', () => settleConfirm(true));
confirmCancelBtn.addEventListener('click', () => settleConfirm(false));
confirmDialog.addEventListener('cancel', (event) => { event.preventDefault(); settleConfirm(false); });
confirmDialog.addEventListener('close', () => settleConfirm(false));

// --- Help menu -------------------------------------------------------------
// The sidebar's Help button opens a small sheet: what is new, the quick
// checks (shortcuts, microphone, languages), the setup guide, and feedback.
const navHelpBtn = document.getElementById('nav-help');
const helpMenuEl = document.getElementById('help-menu');
let helpMenuOpen = false;

function positionHelpMenu() {
  if (!helpMenuOpen || !navHelpBtn || !helpMenuEl) return;
  const anchor = navHelpBtn.getBoundingClientRect();
  const height = helpMenuEl.offsetHeight;
  const top = Math.max(8, Math.min(anchor.bottom - height, window.innerHeight - height - 8));
  helpMenuEl.style.left = Math.round(anchor.right + 10) + 'px';
  helpMenuEl.style.top = Math.round(top) + 'px';
}

function openHelpMenu() {
  if (helpMenuOpen || !helpMenuEl) return;
  closeAllCustomSelects();
  helpMenuOpen = true;
  helpMenuEl.hidden = false;
  navHelpBtn.classList.add('is-open');
  navHelpBtn.setAttribute('aria-expanded', 'true');
  positionHelpMenu();
  window.addEventListener('resize', positionHelpMenu);
  const first = helpMenuEl.querySelector('.help-menu-item');
  if (first) first.focus({ preventScroll: true });
}

function closeHelpMenu(restoreFocus = false) {
  if (!helpMenuOpen) return;
  helpMenuOpen = false;
  helpMenuEl.hidden = true;
  navHelpBtn.classList.remove('is-open');
  navHelpBtn.setAttribute('aria-expanded', 'false');
  window.removeEventListener('resize', positionHelpMenu);
  if (restoreFocus) navHelpBtn.focus({ preventScroll: true });
}

if (helpMenuEl) {
  const changelogLink = document.getElementById('help-whats-new');
  if (['127.0.0.1', 'localhost'].includes(window.location.hostname)) {
    changelogLink.href = 'http://127.0.0.1:4174/changelog';
  }
  changelogLink.addEventListener('click', event => {
    closeHelpMenu();
    if (!window.voxden?.openChangelog) return; // Normal link in the web preview.
    event.preventDefault();
    window.voxden.openChangelog().catch(() => {
      window.alert('Could not open your browser. Please try What’s new again.');
    });
  });
  const actions = {
    'help-shortcuts': () => openShortcutsDialog(),
    'help-microphone': () => openMicCheck(),
    'help-languages': () => {
      if (dictationLanguagesUnlocked(lastPayload || {})) openDictationLangDialog();
      else openSettingsTarget('general#dictation-language');
    },
    'help-guide': () => setView('help'),
    'help-feedback': () => openFeedbackDialog(navHelpBtn),
  };
  for (const [id, action] of Object.entries(actions)) {
    const item = document.getElementById(id);
    if (!item) continue;
    item.addEventListener('click', () => {
      closeHelpMenu();
      action();
    });
  }
  helpMenuEl.addEventListener('keydown', (event) => {
    const items = Array.from(helpMenuEl.querySelectorAll('.help-menu-item'));
    const index = items.indexOf(document.activeElement);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      const next = items[(index + step + items.length) % items.length];
      if (next) next.focus({ preventScroll: true });
    } else if (event.key === 'Escape') {
      event.preventDefault();
      closeHelpMenu(true);
    }
  });
  document.addEventListener('mousedown', (event) => {
    if (!helpMenuOpen) return;
    if (helpMenuEl.contains(event.target) || navHelpBtn.contains(event.target)) return;
    closeHelpMenu();
  });
}

// --- The account button and its sheet ------------------------------------------
// The avatar in the title bar, beside the bell. Its sheet drops below it with
// who is signed in, the plan, and the three things worth doing from there.
const sidebarAccountBtn = document.getElementById('account-btn');
const sidebarAccountImg = document.getElementById('account-btn-img');
const sidebarAccountInitials = document.getElementById('account-btn-initials');
const accountMenuEl = document.getElementById('account-menu');
let accountMenuOpen = false;

function accountDisplayName(account) {
  const profile = (account && account.profile) || {};
  const full = [profile.firstName, profile.lastName].map((s) => String(s || '').trim()).filter(Boolean).join(' ');
  return full || String((account && account.email) || '').split('@')[0] || 'Your account';
}

function renderSidebarAccount(data) {
  if (!sidebarAccountBtn) return;
  const account = (data && data.account) || null;
  const signedIn = !!(account && account.signedIn);
  sidebarAccountBtn.hidden = !signedIn;
  if (!signedIn) { if (accountMenuOpen) closeAccountMenu(); return; }
  const photo = (data && data.accountAvatar) || '';
  const pro = account.plan === 'pro';
  if (photo) { sidebarAccountImg.src = photo; sidebarAccountImg.hidden = false; }
  else { sidebarAccountImg.removeAttribute('src'); sidebarAccountImg.hidden = true; }
  sidebarAccountBtn.classList.toggle('has-photo', !!photo);
  sidebarAccountBtn.classList.toggle('is-pro', pro);
  sidebarAccountInitials.textContent = profileInitials(account.profile, account.email);
  sidebarAccountBtn.title = accountDisplayName(account) + (pro ? ' · Voxden Pro' : '');
  if (accountMenuOpen) renderAccountMenu(data);
}

function renderAccountMenu(data) {
  if (!accountMenuEl) return;
  const account = (data && data.account) || {};
  const pro = account.plan === 'pro';
  const photo = (data && data.accountAvatar) || '';
  document.getElementById('account-menu-banner').classList.toggle('is-pro', pro);
  const avatar = document.getElementById('account-menu-avatar');
  const img = document.getElementById('account-menu-img');
  if (photo) { img.src = photo; img.hidden = false; } else { img.removeAttribute('src'); img.hidden = true; }
  avatar.classList.toggle('has-photo', !!photo);
  document.getElementById('account-menu-initials').textContent = profileInitials(account.profile, account.email);
  document.getElementById('account-menu-name').textContent = accountDisplayName(account);
  document.getElementById('account-menu-email').textContent = account.email || '';
  const meter = pro ? cloudMeterFromAccount(account) : null;
  document.getElementById('account-menu-plan').textContent = pro
    ? 'VOXDEN PRO' + (meter ? ' · ' + Math.max(0, Math.round(meter.creditsCap - meter.creditsUsed)).toLocaleString() + ' credits left' : '')
    : 'FREE PLAN';
}

function positionAccountMenu() {
  if (!accountMenuOpen || !sidebarAccountBtn || !accountMenuEl) return;
  const anchor = sidebarAccountBtn.getBoundingClientRect();
  const height = accountMenuEl.offsetHeight;
  const width = accountMenuEl.offsetWidth;
  const top = Math.max(8, Math.min(anchor.bottom + 8, window.innerHeight - height - 8));
  const left = Math.max(8, Math.min(anchor.right - width, window.innerWidth - width - 8));
  accountMenuEl.style.left = Math.round(left) + 'px';
  accountMenuEl.style.top = Math.round(top) + 'px';
}

function openAccountMenu() {
  if (accountMenuOpen || !accountMenuEl) return;
  closeAllCustomSelects();
  if (helpMenuOpen) closeHelpMenu();
  accountMenuOpen = true;
  renderAccountMenu(lastPayload || {});
  accountMenuEl.hidden = false;
  sidebarAccountBtn.classList.add('is-open');
  sidebarAccountBtn.setAttribute('aria-expanded', 'true');
  positionAccountMenu();
  window.addEventListener('resize', positionAccountMenu);
  const first = accountMenuEl.querySelector('.help-menu-item');
  if (first) first.focus({ preventScroll: true });
}

function closeAccountMenu(restoreFocus = false) {
  if (!accountMenuOpen) return;
  accountMenuOpen = false;
  accountMenuEl.hidden = true;
  sidebarAccountBtn.classList.remove('is-open');
  sidebarAccountBtn.setAttribute('aria-expanded', 'false');
  window.removeEventListener('resize', positionAccountMenu);
  if (restoreFocus) sidebarAccountBtn.focus({ preventScroll: true });
}

if (sidebarAccountBtn && accountMenuEl) {
  sidebarAccountBtn.addEventListener('click', () => {
    if (accountMenuOpen) closeAccountMenu();
    else openAccountMenu();
  });
  document.getElementById('account-menu-manage').addEventListener('click', () => { closeAccountMenu(); openSettingsTarget('account'); });
  document.getElementById('account-menu-billing').addEventListener('click', () => { closeAccountMenu(); openSettingsTarget('billing'); });
  document.getElementById('account-menu-signout').addEventListener('click', () => {
    closeAccountMenu();
    if (window.voxden && window.voxden.accountSignOut) window.voxden.accountSignOut().then((next) => { if (next) render(next); }).catch(() => {});
  });
  accountMenuEl.addEventListener('keydown', (event) => {
    const items = Array.from(accountMenuEl.querySelectorAll('.help-menu-item'));
    const index = items.indexOf(document.activeElement);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const next = items[(index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length];
      if (next) next.focus({ preventScroll: true });
    } else if (event.key === 'Escape') {
      event.preventDefault();
      closeAccountMenu(true);
    }
  });
  document.addEventListener('mousedown', (event) => {
    if (!accountMenuOpen) return;
    if (accountMenuEl.contains(event.target) || sidebarAccountBtn.contains(event.target)) return;
    closeAccountMenu();
  });
}

// --- Microphone check --------------------------------------------------------
// Every microphone at once, each with a live level, so the user can see which
// one actually hears them and pick it. Streams are opened only while the
// dialog is up and closed the moment it goes.
const micDialog = document.getElementById('mic-dialog');
const micListEl = document.getElementById('mic-list');
const micDialogStatusEl = document.getElementById('mic-dialog-status');
const micDialogCloseBtn = document.getElementById('mic-dialog-close');
let micMonitors = [];
let micMeterFrame = 0;
let micCheckGeneration = 0;

function setMicStatus(text) {
  if (!micDialogStatusEl) return;
  micDialogStatusEl.textContent = text || '';
  micDialogStatusEl.hidden = !text;
}

function micInUseId() {
  const selected = (lastPayload && lastPayload.microphone) || 'default';
  // A saved device that is unplugged falls back to the default, which is
  // what the capture window does too.
  if (selected !== 'default' && micDevices.some((d) => d.deviceId === selected)) return selected;
  return defaultMicId || (micDevices[0] ? micDevices[0].deviceId : '');
}

function markMicInUse() {
  const inUse = micInUseId();
  for (const row of micListEl.querySelectorAll('.mic-row')) {
    const on = row.dataset.id === inUse;
    row.setAttribute('aria-checked', on ? 'true' : 'false');
    row.querySelector('.mic-row-tag').hidden = !on;
  }
}

function renderMicRows() {
  micListEl.replaceChildren();
  if (!micDevices.length) {
    setMicStatus('No microphone found. Plug one in and it appears here.');
    return;
  }
  setMicStatus('');
  for (const device of micDevices) {
    const li = document.createElement('li');
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'mic-row';
    row.dataset.id = device.deviceId;
    row.setAttribute('role', 'radio');
    row.setAttribute('aria-checked', 'false');
    const name = document.createElement('span');
    name.className = 'mic-row-name';
    name.textContent = cleanMicLabel(device.label);
    const tag = document.createElement('span');
    tag.className = 'mic-row-tag';
    tag.textContent = 'In use';
    tag.hidden = true;
    const meter = document.createElement('span');
    meter.className = 'mic-meter';
    meter.setAttribute('aria-hidden', 'true');
    const fill = document.createElement('i');
    meter.appendChild(fill);
    const state = document.createElement('span');
    state.className = 'mic-row-state';
    state.textContent = 'Opening…';
    row.append(name, tag, meter, state);
    row.addEventListener('click', () => {
      patchSettings({ microphone: device.deviceId }).then(() => markMicInUse());
    });
    li.appendChild(row);
    micListEl.appendChild(li);
  }
  markMicInUse();
}

function stopMicMonitors() {
  micCheckGeneration += 1;
  if (micMeterFrame) cancelAnimationFrame(micMeterFrame);
  micMeterFrame = 0;
  for (const monitor of micMonitors) {
    try { monitor.stream.getTracks().forEach((track) => track.stop()); } catch (_) {}
    if (monitor.context) monitor.context.close().catch(() => {});
  }
  micMonitors = [];
}

function tickMicMeters() {
  for (const monitor of micMonitors) {
    if (!monitor.analyser) continue;
    monitor.analyser.getByteTimeDomainData(monitor.samples);
    let sum = 0;
    for (let i = 0; i < monitor.samples.length; i++) {
      const v = (monitor.samples[i] - 128) / 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / monitor.samples.length);
    const level = Math.min(1, rms * 4);
    monitor.fill.style.transform = 'scaleX(' + level.toFixed(3) + ')';
    const live = level > 0.06;
    if (live !== monitor.live) {
      monitor.live = live;
      monitor.row.classList.toggle('is-live', live);
      monitor.state.textContent = live ? 'Hearing you' : 'Quiet';
    }
  }
  micMeterFrame = requestAnimationFrame(tickMicMeters);
}

async function startMicMonitors() {
  stopMicMonitors();
  const generation = micCheckGeneration;
  const Context = window.AudioContext || window.webkitAudioContext;
  const rows = Array.from(micListEl.querySelectorAll('.mic-row'));
  for (const row of rows) {
    const state = row.querySelector('.mic-row-state');
    const fill = row.querySelector('.mic-meter i');
    let stream = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: row.dataset.id } } });
    } catch (_) {
      state.textContent = 'Could not open this microphone.';
      continue;
    }
    if (generation !== micCheckGeneration) {
      try { stream.getTracks().forEach((track) => track.stop()); } catch (_) {}
      return;
    }
    const monitor = { row, state, fill, stream, context: null, analyser: null, samples: null, live: false };
    try {
      const context = new Context();
      const source = context.createMediaStreamSource(stream);
      const analyser = context.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      monitor.context = context;
      monitor.analyser = analyser;
      monitor.samples = new Uint8Array(analyser.fftSize);
      state.textContent = 'Quiet';
    } catch (_) {
      state.textContent = 'Open, but the level cannot be read here.';
    }
    micMonitors.push(monitor);
  }
  if (micMonitors.some((m) => m.analyser) && !micMeterFrame) micMeterFrame = requestAnimationFrame(tickMicMeters);
}

async function openMicCheck() {
  if (!micDialog || micDialog.open) return;
  closeAllCustomSelects();
  micListEl.replaceChildren();
  setMicStatus('Looking for microphones…');
  micDialog.showModal();
  if (micDialogCloseBtn) micDialogCloseBtn.focus();
  await refreshMicrophones();
  if (!micDialog.open) return;
  renderMicRows();
  await startMicMonitors();
}

if (micDialog) {
  micDialog.addEventListener('close', stopMicMonitors);
  micDialog.addEventListener('cancel', (event) => { event.preventDefault(); micDialog.close(); });
  if (micDialogCloseBtn) micDialogCloseBtn.addEventListener('click', () => micDialog.close());
}

// --- Feedback ----------------------------------------------------------------
const feedbackDialog = document.getElementById('feedback-dialog');
const feedbackKindEl = document.getElementById('feedback-kind');
const feedbackTextEl = document.getElementById('feedback-text');
const feedbackEmailRowEl = document.getElementById('feedback-email-row');
const feedbackEmailEl = document.getElementById('feedback-email');
const feedbackDetailsEl = document.getElementById('feedback-details');
const feedbackDetailsSummaryEl = document.getElementById('feedback-details-summary');
const feedbackStatusEl = document.getElementById('feedback-status');
const feedbackGithubBtn = document.getElementById('feedback-github');
const feedbackCloseBtn = document.getElementById('feedback-close');
const feedbackSendBtn = document.getElementById('feedback-send');
const feedbackSendLabelEl = document.getElementById('feedback-send-label');
// The message box asks for the thing the chosen kind actually needs.
const FEEDBACK_ASKS = {
  bug: 'What were you doing, and what did Voxden do instead?',
  idea: 'What would make Voxden better for you?',
  other: 'Go on, we read every one.',
};
// Long enough for the paper plane to leave the chip before the tick lands.
const FEEDBACK_FLY_MS = 520;
let feedbackKind = 'bug';
let feedbackSending = false;
let feedbackOpener = null;
let feedbackCloseTimer = 0;

function setFeedbackStatus(text, isError) {
  if (!feedbackStatusEl) return;
  feedbackStatusEl.textContent = text || '';
  feedbackStatusEl.hidden = !text;
  feedbackStatusEl.classList.toggle('is-error', !!isError);
}

function setFeedbackKind(kind) {
  feedbackKind = kind;
  for (const btn of feedbackKindEl.querySelectorAll('.feedback-kind-btn')) {
    const on = btn.dataset.kind === kind;
    btn.classList.toggle('is-active', on);
    btn.setAttribute('aria-checked', on ? 'true' : 'false');
  }
  feedbackTextEl.placeholder = FEEDBACK_ASKS[kind] || FEEDBACK_ASKS.bug;
}

// What travels with the report, one chip each: the build, the recognizer in
// use, and the plan. Every value comes from the snapshot the app already has.
function feedbackDetailChips(data) {
  const d = data || {};
  const chips = [];
  if (d.version) chips.push('Voxden v' + d.version);
  chips.push(d.cloudTranscription === true ? 'Voxden Cloud' : (d.asrEngine || 'local engine'));
  const account = d.account || null;
  chips.push(account && account.signedIn && account.plan === 'pro' ? 'Pro' : 'Free');
  return chips;
}

function renderFeedbackChips(data) {
  if (!feedbackDetailsSummaryEl) return;
  feedbackDetailsSummaryEl.textContent = '';
  for (const text of feedbackDetailChips(data)) {
    const chip = document.createElement('span');
    chip.className = 'feedback-chip';
    chip.textContent = text;
    feedbackDetailsSummaryEl.append(chip);
  }
}

function syncFeedbackDetails() {
  const row = feedbackDetailsEl && feedbackDetailsEl.closest('.feedback-details');
  if (row) row.classList.toggle('is-off', !feedbackDetailsEl.checked);
}

// idle -> sending -> sent. The plane drifts, flies off, and the tick lands.
function setFeedbackSendPhase(phase) {
  feedbackSendBtn.classList.toggle('is-sending', phase === 'sending');
  feedbackSendBtn.classList.toggle('is-sent', phase === 'sent');
  feedbackSendLabelEl.textContent = phase === 'sending' ? 'Sending' : phase === 'sent' ? 'Sent' : 'Send';
}

// The drift is a loop, so it runs only in a visible window, on an open dialog,
// and never under reduced motion, where every state shows settled instead.
function syncFeedbackMotion() {
  if (!feedbackDialog) return;
  feedbackDialog.classList.toggle('is-still', !feedbackDialog.open || document.hidden || motionStill());
}

function feedbackReport() {
  return {
    kind: feedbackKind,
    message: feedbackTextEl.value,
    email: feedbackEmailRowEl.hidden ? '' : feedbackEmailEl.value,
    includeDetails: feedbackDetailsEl.checked,
  };
}

function openFeedbackDialog(opener) {
  if (!feedbackDialog || feedbackDialog.open) return;
  closeAllCustomSelects();
  clearTimeout(feedbackCloseTimer);
  const data = lastPayload || {};
  const account = data.account || null;
  feedbackOpener = opener || (document.activeElement !== document.body ? document.activeElement : null) || navHelpBtn;
  feedbackEmailRowEl.hidden = !!(account && account.signedIn);
  renderFeedbackChips(data);
  syncFeedbackDetails();
  feedbackGithubBtn.hidden = true;
  setFeedbackStatus('');
  feedbackSending = false;
  feedbackSendBtn.disabled = false;
  setFeedbackSendPhase('idle');
  feedbackDialog.showModal();
  syncFeedbackMotion();
  feedbackTextEl.focus();
}

function closeFeedbackDialog() {
  if (!feedbackDialog || !feedbackDialog.open) return;
  clearTimeout(feedbackCloseTimer);
  feedbackDialog.close();
  setFeedbackSendPhase('idle');
  syncFeedbackMotion();
  const opener = feedbackOpener;
  feedbackOpener = null;
  if (opener && opener.isConnected && !opener.hidden) opener.focus({ preventScroll: true });
}

async function sendFeedback() {
  if (feedbackSending) return;
  const report = feedbackReport();
  if (!report.message.trim()) {
    setFeedbackStatus('Write a few words first.', true);
    feedbackTextEl.focus();
    return;
  }
  feedbackSending = true;
  feedbackSendBtn.disabled = true;
  feedbackGithubBtn.hidden = true;
  setFeedbackSendPhase('sending');
  setFeedbackStatus('Sending…');
  const started = Date.now();
  let result = null;
  try {
    result = window.voxden && window.voxden.sendFeedback ? await window.voxden.sendFeedback(report) : null;
  } catch (err) {
    result = { ok: false, error: (err && err.message) || 'Could not send right now.', fallback: true };
  }
  feedbackSending = false;
  feedbackSendBtn.disabled = false;
  if (result && result.ok) {
    // Let the plane clear the chip before the tick replaces it, unless motion
    // is reduced, where the swap is immediate.
    const left = motionStill() ? 0 : Math.max(0, FEEDBACK_FLY_MS - (Date.now() - started));
    if (left) await new Promise((resolve) => setTimeout(resolve, left));
    setFeedbackSendPhase('sent');
    setFeedbackStatus('Thanks. It is on its way.');
    feedbackTextEl.value = '';
    feedbackCloseTimer = setTimeout(() => { if (feedbackDialog.open && !feedbackSending) closeFeedbackDialog(); }, 1100);
    return;
  }
  // A refusal puts the plane back on the pill and says why underneath.
  setFeedbackSendPhase('idle');
  const error = (result && result.error) || 'Could not send right now.';
  setFeedbackStatus(error + (result && result.fallback ? ' You can post it on GitHub instead.' : ''), true);
  feedbackGithubBtn.hidden = !(result && result.fallback);
}

if (feedbackDialog) {
  feedbackKindEl.addEventListener('click', (event) => {
    const btn = event.target.closest('.feedback-kind-btn');
    if (btn && btn.dataset.kind) setFeedbackKind(btn.dataset.kind);
  });
  // A radio group moves with the arrow keys; Tab still reaches each one.
  feedbackKindEl.addEventListener('keydown', (event) => {
    const keys = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 };
    const step = keys[event.key];
    if (!step) return;
    const buttons = Array.from(feedbackKindEl.querySelectorAll('.feedback-kind-btn'));
    const from = buttons.indexOf(document.activeElement);
    if (from < 0) return;
    event.preventDefault();
    const next = buttons[(from + step + buttons.length) % buttons.length];
    setFeedbackKind(next.dataset.kind);
    next.focus();
  });
  feedbackDetailsEl.addEventListener('change', syncFeedbackDetails);
  feedbackSendBtn.addEventListener('click', sendFeedback);
  feedbackCloseBtn.addEventListener('click', () => closeFeedbackDialog());
  feedbackGithubBtn.addEventListener('click', async () => {
    if (!window.voxden || !window.voxden.openFeedbackIssue) return;
    const result = await window.voxden.openFeedbackIssue(feedbackReport()).catch(() => null);
    if (result && result.ok) closeFeedbackDialog();
    else setFeedbackStatus((result && result.error) || 'Could not open GitHub.', true);
  });
  feedbackTextEl.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      sendFeedback();
    }
  });
  feedbackDialog.addEventListener('cancel', (event) => { event.preventDefault(); closeFeedbackDialog(); });
  if (flowMotion) flowMotion.addEventListener('change', syncFeedbackMotion);
  if (window.matchMedia) {
    window.matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', syncFeedbackMotion);
  }
  syncFeedbackMotion();
}

function openShortcutsDialog() {
  if (shortcutsDialog.open) return;
  closeAllCustomSelects();
  shortcutsDialog.showModal();
  shortcutChangeBtn.focus();
}

function closeShortcutsDialog(restoreFocus = true) {
  if (!shortcutsDialog.open) return;
  stopShortcutCapture();
  shortcutsDialog.close();
  if (restoreFocus && settingsOpen) shortcutsChangeBtn.focus({ preventScroll: true });
}

// Keep old links working after their standalone categories move into General.
// IPC still carries one string; an optional section points at a specific row.
function resolveSettingsTarget(value) {
  const sections = ['microphone', 'dictation-language', 'app-language'];
  const target = String(value || '');
  const parts = (sections.includes(target) ? 'general#' + target : target).split('#');
  const [category, section] = parts;
  if (parts.length > 2 || !Array.from(settingsCatButtons).some(btn => btn.dataset.cat === category)) return null;
  if (parts.length === 2 && (category !== 'general' || !sections.includes(section))) return null;
  return { category, section };
}

function openSettingsTarget(value) {
  const target = resolveSettingsTarget(value);
  if (!target) return;
  closeShortcutsDialog(false);
  setSettingsCat(target.category);
  openSettings();
  settingsDetailEl.scrollTop = 0;
  if (target.section) {
    const row = document.querySelector('[data-settings-section="' + target.section + '"]');
    const disclosure = row.closest('details');
    if (disclosure) disclosure.open = true;
    row.scrollIntoView({ block: 'center' });
    row.focus({ preventScroll: true });
  }
}

function cleanMicLabel(label) {
  return String(label || 'Microphone')
    .replace(/^Default\s*-\s*/i, '')
    .replace(/\s*\(default\)\s*$/i, '')
    .trim() || 'Microphone';
}

// One open of the default microphone does both jobs: it unlocks device labels
// for enumerateDevices, and the track it hands back names the default device.
// This used to open the microphone twice at every launch.
async function detectDefaultMicId() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return null;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const track = stream.getAudioTracks()[0];
    const id = track && track.getSettings ? track.getSettings().deviceId : null;
    stream.getTracks().forEach((t) => t.stop());
    return id || null;
  } catch (_) {
    return null;
  }
}

async function refreshMicrophones() {
  const select = settingInputs.microphone;
  if (!select || micListLoading || !navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
  micListLoading = true;
  const showLoading = settingsOpen && settingsCat === 'general';
  select.disabled = showLoading;
  select.classList.toggle('is-loading', showLoading);
  try {
    defaultMicId = await detectDefaultMicId();
    const all = await navigator.mediaDevices.enumerateDevices();
    micDevices = all.filter((d) => {
      if (d.kind !== 'audioinput' || !d.deviceId) return false;
      if (d.deviceId === 'default' || d.deviceId === 'communications') return false;
      return true;
    });
  } catch (_) {
    // Keep the previous list if Windows temporarily cannot enumerate devices.
  } finally {
    micListLoading = false;
    select.classList.remove('is-loading');
    select.disabled = false;
  }
  renderMicSelect(lastPayload || {});
  reportMicDevices();
}

// Only a renderer can enumerate audio devices, so the tray menu gets its list
// from here. This window is created at startup and stays alive hidden, so the
// list is ready before anyone opens it -- the tray does not have to wait for a
// visit to General to know what is plugged in.
function reportMicDevices() {
  if (!window.voxden || !window.voxden.reportMicDevices) return;
  window.voxden.reportMicDevices({
    defaultId: defaultMicId || '',
    devices: micDevices.map((d) => ({ id: d.deviceId, label: cleanMicLabel(d.label) })),
  });
}

function renderMicSelect(data) {
  const select = settingInputs.microphone;
  if (!select) return;
  const selected = (data && data.microphone) || 'default';
  const defaultDevice = defaultMicId
    ? micDevices.find((d) => d.deviceId === defaultMicId)
    : null;

  select.innerHTML = '';
  const defaultOpt = document.createElement('option');
  defaultOpt.value = 'default';
  defaultOpt.textContent = defaultDevice
    ? cleanMicLabel(defaultDevice.label) + ' (Default)'
    : 'System default (Default)';
  select.appendChild(defaultOpt);

  for (const device of micDevices) {
    const opt = document.createElement('option');
    opt.value = device.deviceId;
    const isDefault = device.deviceId === defaultMicId;
    opt.textContent = cleanMicLabel(device.label) + (isDefault ? ' (Default)' : '');
    select.appendChild(opt);
  }

  const hasSelected = selected === 'default' || micDevices.some((d) => d.deviceId === selected);
  select.value = hasSelected ? selected : 'default';
  const loading = micListLoading && settingsOpen && settingsCat === 'general';
  select.classList.toggle('is-loading', loading);
  select.disabled = loading;
  syncCustomSelect(select);
}

function salute(now = new Date()) {
  const h = now.getHours();
  if (h >= 5 && h < 12) return 'Good morning';
  if (h >= 12 && h < 17) return 'Good afternoon';
  if (h >= 17 && h < 22) return 'Good evening';
  return 'Up late?';
}

// The greeting's icon follows the PC clock in five parts of the day, each with
// one slow movement (the keyframes live in dictation-hero.css). The words
// above keep their own, older boundaries.
function dayPart(now = new Date()) {
  const h = now.getHours();
  if (h >= 5 && h < 8) return 'dawn';
  if (h >= 8 && h < 12) return 'morning';
  if (h >= 12 && h < 17) return 'afternoon';
  if (h >= 17 && h < 21) return 'evening';
  return 'night';
}

const GREETING_ICONS = {
  dawn: '<g class="gi-sun gi-rise"><path d="M7 18a5 5 0 0 1 10 0"/><path d="M12 9.5V7.5M5.3 12.3l-1.4-1.4M18.7 12.3l1.4-1.4"/></g><path class="gi-ink" d="M3 18h18"/>',
  morning: '<circle class="gi-sun" cx="12" cy="12" r="4"/><g class="gi-sun gi-spin"><path d="M12 3.5v2M12 18.5v2M3.5 12h2M18.5 12h2M6 6l1.4 1.4M16.6 16.6L18 18M18 6l-1.4 1.4M7.4 16.6L6 18"/></g>',
  afternoon: '<g class="gi-sun"><path d="M10.2 9.2a4 4 0 0 1 7.3 1.6"/><path d="M14 3v1.6M8.3 5.3l1.1 1.1M19.7 5.3l-1.1 1.1M21.5 10.5h-1.6"/></g><g class="gi-ink gi-drift"><path d="M7.5 19.5h8.8a3 3 0 0 0 .4-5.97A4.5 4.5 0 0 0 8 12.6a3.5 3.5 0 0 0-.5 6.9z"/></g>',
  evening: '<g class="gi-sun gi-set"><path d="M7 18a5 5 0 0 1 10 0"/><path d="M12 9.5V8M5.6 12.6l-1-1M18.4 12.6l1-1"/></g><path class="gi-ink" d="M3 18h18"/><path class="gi-ink" d="M8 21.2h8" opacity=".55"/>',
  night: '<path class="gi-ink" d="M19 14.2A7.5 7.5 0 1 1 9.8 5a6 6 0 0 0 9.2 9.2z"/><g class="gi-star"><path class="gi-twinkle" d="M16.5 4v2.4M15.3 5.2h2.4"/><path class="gi-twinkle gi-twinkle-late" d="M20.5 8.2v1.6M19.7 9h1.6"/></g>',
};

const greetingIconEl = document.getElementById('greeting-icon');

// Rebuilt only when the part of the day changes, so the minute-by-minute
// greeting refresh never restarts the icon's movement.
function renderGreetingIcon(now = new Date()) {
  if (!greetingIconEl) return;
  const part = dayPart(now);
  if (greetingIconEl.dataset.dayPart === part) return;
  greetingIconEl.dataset.dayPart = part;
  greetingIconEl.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">'
    + GREETING_ICONS[part] + '</svg>';
}

function renderGreeting(data) {
  const timeSalute = salute();
  renderGreetingIcon();
  const name = String((data && data.displayName) || '').trim();
  if (name) {
    // The greeting, the comma and the name are one line, so the comma belongs
    // to the words, not to the markup.
    greetingSaluteEl.textContent = timeSalute + ',';
    greetingSaluteEl.hidden = false;
    greetingNameEl.textContent = name;
  } else {
    greetingSaluteEl.hidden = true;
    greetingNameEl.textContent = timeSalute;
  }
}

function formatTime(ts) {
  return new Date(ts).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function dayLabel(ts) {
  const d = new Date(ts);
  const today = new Date();
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  const sameDay = (a, b) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (sameDay(d, today)) return 'Today';
  if (sameDay(d, yesterday)) return 'Yesterday';
  return d.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
}

function shortcutKbdHtml(label, joiner = '+') {
  const parts = String(label || defaultShortcutLabel()).split('+');
  return parts.map((p) => '<kbd>' + p + '</kbd>').join(joiner);
}

// Help's second step names the keys this user really has and how their mode
// finishes a dictation, not the default app.html starts out with.
function renderHelpDictateStep(mode, label) {
  const step = document.getElementById('help-step-dictate');
  const finish = document.getElementById('help-step-finish');
  if (step) step.innerHTML = (mode === 'ptt' ? 'Hold ' : 'Press ') + shortcutKbdHtml(label, ' + ') + ' and talk';
  if (finish) finish.textContent = mode === 'ptt' ? 'Let go when you are done.' : 'Press the same keys again when you are done.';
}

// Keys whose KeyboardEvent name is not already the name Electron wants.
// Anything absent from here and not a letter, digit, punctuation mark or
// function key cannot be bound, which is what the capture reports back.
const CAPTURE_KEY_NAMES = {
  ' ': 'Space',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Enter: 'Return',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  Delete: 'Delete',
  Backspace: 'Backspace',
  Insert: 'Insert',
  Tab: 'Tab',
};

// A keydown for one of these is the user still assembling a chord, not a chord.
const CAPTURE_MODIFIER_KEYS = ['Control', 'Shift', 'Alt', 'Meta', 'OS', 'AltGraph'];

// The Windows key is its own modifier. Folding it into CommandOrControl the way
// this used to meant a chord held with Win was recorded as a plain Ctrl chord --
// and the app could never emit a Win-key accelerator at all.
function modifierPartsOf(e) {
  const parts = [];
  if (e.ctrlKey) parts.push('CommandOrControl');
  if (e.metaKey) parts.push('Super');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  return parts;
}

function keyEventToAccelerator(e) {
  if (e.key === 'Escape') return null;
  const parts = modifierPartsOf(e);
  if (CAPTURE_MODIFIER_KEYS.includes(e.key)) return null;
  let key = e.key;
  if (CAPTURE_KEY_NAMES[key]) key = CAPTURE_KEY_NAMES[key];
  else if (key.length === 1) key = key.toUpperCase();
  else if (/^F([1-9]|1\d|2[0-4])$/.test(key)) key = key.toUpperCase();
  else return null;
  parts.push(key);
  if (parts.length < 2) return null;
  return parts.join('+');
}

// Why a press did not become a shortcut. null means nothing is wrong yet -- the
// user is holding modifiers and has not pressed the real key. Without this the
// capture just sat on "Listening…" forever for any key it could not map, which
// is indistinguishable from the setting being broken.
function shortcutCaptureProblem(e) {
  if (e.key === 'Escape' || CAPTURE_MODIFIER_KEYS.includes(e.key)) return null;
  if (!(e.ctrlKey || e.metaKey || e.altKey || e.shiftKey)) {
    return 'Hold Ctrl, Alt, Shift or the Windows key as well.';
  }
  const named = e.key === ' ' ? 'Space' : e.key;
  return named + ' can’t be part of a shortcut. Try another key.';
}

function shortcutCaptureButton(kind) {
  return kind === 'pasteLastShortcut' ? pasteLastShortcutChangeBtn : shortcutChangeBtn;
}

function setShortcutHint(rawText, kind) {
  // The capture helpers are pure functions of the key event -- test-hotkeys.js
  // lifts them out of this file and runs them on their own -- so the Mac
  // wording for the Super modifier is applied here, at the one place their
  // text reaches the screen.
  const text = (isMacUi() && MAC_SHORTCUT_HINTS[rawText]) || rawText;
  if (shortcutHintTimer) {
    clearTimeout(shortcutHintTimer);
    shortcutHintTimer = 0;
  }
  shortcutCaptureHint.classList.toggle('is-error', kind === 'error');
  shortcutCaptureHint.hidden = !text;
  shortcutCaptureHint.textContent = text || '';
  shortcutsStatusEl.hidden = kind !== 'error' || !text;
  shortcutsStatusEl.textContent = kind === 'error' ? text || '' : '';
}

// Clearing the hint falls back to the standing notice rather than to nothing,
// so a hotkey that failed at launch stays on screen after a capture ends or a
// transient error times out.
function restoreShortcutHint() {
  if (capturingShortcutKind) return;
  setShortcutHint(hotkeyNoticeText, hotkeyNoticeText ? 'error' : '');
}

function startShortcutCapture(kind) {
  stopShortcutCapture();
  capturingShortcutKind = kind;
  captureMods = [];
  captureSawKey = false;
  const btn = shortcutCaptureButton(kind);
  if (btn) {
    btn.classList.add('is-capturing');
    btn.textContent = 'Listening…';
  }
  setShortcutHint('Press a new shortcut. Escape to cancel.', '');
}

function stopShortcutCapture() {
  capturingShortcutKind = null;
  captureMods = [];
  captureSawKey = false;
  for (const btn of [shortcutChangeBtn, pasteLastShortcutChangeBtn]) {
    if (!btn) continue;
    btn.classList.remove('is-capturing');
    btn.textContent = 'Change';
  }
  restoreShortcutHint();
}

function renderWritingStyles(payload) {
  const data = payload || lastPayload || {};
  const verbatim = !!data.verbatimMode;
  if (settingInputs.verbatimMode) settingInputs.verbatimMode.checked = verbatim;
  if (settingInputs.verbatimDictionary) {
    settingInputs.verbatimDictionary.checked = !!data.verbatimDictionary;
  }
  if (verbatimDictRowEl) verbatimDictRowEl.hidden = !verbatim;
  if (settingInputs.numbersAsDigits) settingInputs.numbersAsDigits.checked = data.numbersAsDigits !== false;
  if (settingInputs.autoCleanup) {
    const english = /^en(?:-|$)/i.test(data.dictationLanguage || 'en');
    settingInputs.autoCleanup.checked = data.autoCleanup === true;
    settingInputs.autoCleanup.disabled = verbatim || !english;
    document.getElementById('auto-cleanup-card').classList.toggle('is-unavailable', verbatim || !english);
    document.getElementById('auto-cleanup-status').textContent = verbatim
      ? 'Paused while Verbatim mode is on.' : !english ? 'Available for English dictation. Your preference is saved.' : '';
  }
  renderStylePreview(data);
}

let previewCategory = 'work';
const STYLE_TONE_LABELS = { formal: 'Formal', casual: 'Casual', veryCasual: 'Very casual' };
// Spoken, not typed: the filler shows what every tone takes out, and the lower
// case and missing full stop show what each tone puts back.
const STYLE_PREVIEW_SAMPLE = 'um, so I am sending the notes tonight, you know, once we are done. thanks for waiting';

function previewStyledText(sample, tone, clean) {
  try {
    if (window.voxden && typeof window.voxden.previewStyle === 'function') {
      return window.voxden.previewStyle(sample, tone, clean);
    }
  } catch (_) { /* Keep the original sample if the preview helper is missing. */ }
  return sample;
}

let stylePreviewRender = 0;
function renderStylePreview(data) {
  const output = document.getElementById('style-preview-output');
  if (!output) return;
  const tone = (data.writingStyles || STYLE_DEFAULTS)[previewCategory] || STYLE_DEFAULTS[previewCategory];
  const sample = STYLE_PREVIEW_SAMPLE;
  const english = /^en(?:-|$)/i.test(data.dictationLanguage || 'en');
  const paused = !!data.verbatimMode || !english;
  const playground = document.querySelector('.style-preview');
  const toneChanged = playground.dataset.tone !== tone;
  const styled = paused ? sample : previewStyledText(sample, tone, data.autoCleanup === true);
  const render = ++stylePreviewRender;
  playground.dataset.tone = tone;
  playground.dataset.paused = String(paused);
  document.getElementById('writing-scene-caption').textContent = paused ? 'Your words, just as you said them.' : {
    formal: 'A thoughtful note. Beautifully put.',
    casual: 'A little warmth goes a long way.',
    veryCasual: 'Less buttoned up. Still all you.',
  }[tone];
  // The styled text comes from main (see preload.js), so it may arrive a
  // moment later; only the latest render places its text.
  const place = (text) => {
    if (render !== stylePreviewRender || output.textContent === text) return;
    output.textContent = text;
    if (toneChanged && !prefersReducedMotion()) {
      output.getAnimations().forEach(animation => animation.cancel());
      output.animate([{ opacity: .3, transform: 'translateY(3px)' }, { opacity: 1, transform: 'none' }], { duration: 180, easing: 'ease-out' });
    }
  };
  if (styled && typeof styled.then === 'function') styled.then(place, () => place(sample));
  else place(styled);
  document.getElementById('style-preview-tone').textContent = data.verbatimMode ? 'Verbatim' : !english ? 'Styles paused' : STYLE_TONE_LABELS[tone];
  for (const button of document.querySelectorAll('[data-preview-cat]')) {
    const active = button.dataset.previewCat === previewCategory;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', String(active));
  }
  for (const button of document.querySelectorAll('[data-preview-tone]')) {
    const on = button.dataset.previewTone === tone;
    button.setAttribute('aria-pressed', String(on));
    button.tabIndex = on ? 0 : -1;
    button.disabled = paused;
  }
}

// A bounded pointer response brings the little paper illustration to life.
// No perpetual animation, and touch/reduced motion keep the scene still.
let writingLookFrame = 0;
let writingPointer = null;
const writingSceneEl = document.getElementById('writing-scene');
const writingPlaygroundEl = document.querySelector('.style-preview');
function resetWritingLook() {
  cancelAnimationFrame(writingLookFrame);
  writingLookFrame = 0;
  writingPointer = null;
  writingPlaygroundEl.style.removeProperty('--look-x');
  writingPlaygroundEl.style.removeProperty('--look-y');
}
writingSceneEl.addEventListener('pointermove', event => {
  if (event.pointerType === 'touch' || prefersReducedMotion()) return;
  writingPointer = { x: event.clientX, y: event.clientY };
  if (writingLookFrame) return;
  writingLookFrame = requestAnimationFrame(() => {
    writingLookFrame = 0;
    if (!writingPointer || document.hidden || prefersReducedMotion()) return;
    const box = writingSceneEl.getBoundingClientRect();
    if (!box.width || !box.height) return;
    const x = Math.max(-1, Math.min(1, (writingPointer.x - box.left) / box.width * 2 - 1));
    const y = Math.max(-1, Math.min(1, (writingPointer.y - box.top) / box.height * 2 - 1));
    writingPlaygroundEl.style.setProperty('--look-x', (x * 5).toFixed(2) + 'px');
    writingPlaygroundEl.style.setProperty('--look-y', (y * 4).toFixed(2) + 'px');
  });
});
writingSceneEl.addEventListener('pointerleave', resetWritingLook);
writingSceneEl.addEventListener('pointercancel', resetWritingLook);
window.addEventListener('blur', resetWritingLook);
document.addEventListener('visibilitychange', () => { if (document.hidden) resetWritingLook(); });
window.matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', event => {
  resetWritingLook();
  if (event.matches) document.getElementById('style-preview-output').getAnimations().forEach(animation => animation.cancel());
});

function renderDictationQuality(data) {
  const quality = data && data.dictationQuality === 'fast'
    ? 'fast'
    : data && data.dictationQuality === 'accurate'
      ? 'accurate'
      : 'auto';
  const buttons = [
    [qualityAutoEl, 'auto'],
    [qualityFastEl, 'fast'],
    [qualityAccurateEl, 'accurate'],
  ];
  for (const [el, id] of buttons) {
    if (!el) continue;
    const on = quality === id;
    el.classList.toggle('active', on);
    el.setAttribute('aria-checked', on ? 'true' : 'false');
  }
}

// Why the last restart was refused, shown in place of the usual copy for a
// few seconds. A refusal that produced no visible change would read as a
// button that does nothing.
let updateNotice = '';
let updateNoticeTimer = null;

function showUpdateNotice(reason) {
  updateNotice = reason || '';
  clearTimeout(updateNoticeTimer);
  if (!updateNotice) return;
  updateNoticeTimer = setTimeout(() => {
    updateNotice = '';
    render();
  }, 6000);
  render();
}

// Whether the running build has a downloaded update waiting or on its way in.
function updateWaiting(data) {
  return !!data && data.packaged !== false
    && (data.status === 'ready' || data.status === 'installing');
}

function updateVersionLabel(data) {
  return data && data.availableVersion ? 'Voxden ' + data.availableVersion : 'the new version';
}

// Ask the main process to restart into the downloaded update. The status
// changes to 'installing' and comes back through the ordinary broadcast; only
// a refusal needs handling here, and it carries its own reason.
function requestUpdateInstall() {
  if (!window.voxden || !window.voxden.installUpdate) return Promise.resolve(null);
  return window.voxden.installUpdate()
    .then((res) => {
      if (res && res.ok === false) showUpdateNotice(res.reason || 'Voxden could not restart right now.');
      return res;
    })
    .catch(() => {
      showUpdateNotice('Voxden could not restart right now.');
      return null;
    });
}

function renderUpdateStatus(data) {
  const version = data && data.version ? data.version : '—';
  if (appVersionDisplayEl) appVersionDisplayEl.textContent = 'v' + version;

  let hint = 'Updates run automatically when you install Voxden from a release build.';
  const next = updateVersionLabel(data);
  if (data && data.packaged === false) {
    hint = 'Auto-update is disabled in development mode (npm start).';
  } else if (data) {
    switch (data.status) {
      case 'checking':
        hint = 'Checking for updates…';
        break;
      case 'downloading':
        hint = data.progress != null
          ? 'Downloading ' + next + '… ' + data.progress + '%'
          : 'Downloading ' + next + '…';
        break;
      case 'ready':
        hint = next + ' is ready. Restart to finish installing it, or it installs when you next quit.';
        break;
      case 'installing':
        hint = 'Restarting to install ' + next + '…';
        break;
      case 'error':
        hint = 'Could not check for updates. Try again later.';
        break;
      default:
        hint = data.availableVersion
          ? 'You are on the latest release.'
          : 'You are up to date.';
        break;
    }
  }
  if (updateNotice && updateWaiting(data)) hint = updateNotice;
  if (data && data.installError) hint = data.installError;
  if (updateStatusHintEl) updateStatusHintEl.textContent = hint;
  const waiting = updateWaiting(data);
  if (updateRestartBtn) {
    updateRestartBtn.hidden = !waiting;
    updateRestartBtn.disabled = !waiting || data.status === 'installing';
    updateRestartBtn.textContent = waiting && data.status === 'installing' ? 'Restarting…' : 'Restart now';
  }
  if (updateCheckBtn) {
    updateCheckBtn.disabled = !data || data.packaged === false
      || data.status === 'checking' || data.status === 'installing';
  }
}

function formatBytes(n) {
  const bytes = Number(n) || 0;
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

function formatClipTime(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  if (s < 60) return s + ' sec';
  const m = Math.round(s / 60);
  if (m < 60) return m + ' min';
  return (s / 3600).toFixed(1) + ' hr';
}

function renderTunedModel(data) {
  if (!tunedRowEl) return;
  const tuned = data.tunedModel || null;
  tunedRowEl.hidden = !tuned || data.asrEngine !== 'whisper';
  if (settingInputs.useTunedModel) {
    settingInputs.useTunedModel.checked = data.useTunedModel !== false;
  }
  if (!tunedHintEl || !tuned) return;
  const built = tuned.builtAt ? new Date(tuned.builtAt) : null;
  const when = built
    ? built.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
    : 'an earlier run';
  tunedHintEl.textContent = data.modelIsTuned
    ? 'Transcribing with the model you trained on ' + when + '.'
    : 'A model you trained on ' + when + ' is installed but not in use.';
}

function asrEngineId(value) {
  const id = String(value || '').trim().toLowerCase();
  return SPEECH_MODEL_ROWS.some((row) => row.id === id) ? id : 'parakeet';
}

// The engines the cuBLAS pack can actually accelerate. Both Whisper builds run
// on CTranslate2, which is the only thing that pack speeds up; Qwen ships CPU
// torch and Parakeet's ONNX Runtime is the DirectML build with no CUDA
// provider, so neither is ever offered it.
function usesCtranslate2(engine) {
  const id = String(engine || '').trim().toLowerCase();
  return id === 'whisper' || id === 'whisper-turbo';
}

// Decimal, to match how both downloads are advertised.
function formatSetupBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n >= 1e9) return (n / 1e9).toFixed(1) + ' GB';
  return Math.round(n / 1e6) + ' MB';
}

// What setup still has to fetch for the engine that is actually selected.
//
// This used to add up every model that existed -- both large engines and both
// Parakeet precisions -- and show the total, which is where "up to 11.0 GB"
// came from. Only one of the two Parakeet packs can ever load on a given
// machine and only one engine runs at a time, so the number a user is quoted
// is now the one they will actually download. The rest is listed separately,
// priced separately, and downloaded only if asked for.
function speechSetupInfo(data) {
  const runtime = data.asrRuntime || {};
  const plan = data.modelPlan || null;
  const needsEngine = !runtime.installed || runtime.needsUpgrade;
  const needsModel = plan ? !plan.ready : false;
  const pending = (needsEngine ? (runtime.downloadBytes || 0) : 0)
    + (plan ? (plan.requiredBytes || 0) : 0);
  const status = (data.asrRuntimeState || {}).status;
  const busy = !!data.asrOperation || ['preparing', 'downloading', 'installing', 'cancelling', 'removing'].includes(status);
  return { runtime, plan, needsEngine, needsModel, pending, busy };
}

// Settings > Speech engines: the Model section and Advanced.
//
// render() runs on every progress broadcast, so everything here is created
// once in app.html and updated in place: text and attributes are written only
// when they differ, each row keeps one action button whose label and
// data-action change, and listeners are attached once at module load.
// Unavailable panel buttons carry aria-disabled rather than disabled, because
// a focused button that becomes disabled drops focus to <body> mid-download.
function speechSetText(el, text) { if (el && el.textContent !== text) el.textContent = text; }
function speechShow(el, on) { if (el && el.hidden === !!on) el.hidden = !on; }
function speechSetDisabled(btn, off) {
  const value = off ? 'true' : 'false';
  if (btn && btn.getAttribute('aria-disabled') !== value) btn.setAttribute('aria-disabled', value);
}
function speechIsDisabled(btn) { return !btn || btn.getAttribute('aria-disabled') === 'true'; }
function speechPercent(value) {
  return Number.isFinite(Number(value)) && value !== null ? Math.max(0, Math.min(100, Math.round(Number(value)))) : 0;
}
function speechPackBusy(state) { return ['preparing', 'downloading', 'installing'].includes((state || {}).status); }
function speechDevice(data) { return ['cuda', 'directml', 'cpu'].includes(data.asrDevice) ? data.asrDevice : 'auto'; }
// Mirrors modelForEngine in model-plan.js; the renderer cannot require it.
function speechComponent(engine, device) {
  if (engine === 'parakeet') return device === 'directml' ? 'parakeet-fp32' : 'parakeet';
  return engine;
}
function speechPlanItem(data, id) {
  const items = data && data.modelPlan && Array.isArray(data.modelPlan.items) ? data.modelPlan.items : null;
  return items ? items.find((item) => item.id === id) || null : null;
}
function speechRowName(engine) {
  const row = SPEECH_MODEL_ROWS.find((r) => r.id === engine);
  return row ? row.name : 'that engine';
}
// The rows this platform actually offers. Every "is anything installed / is
// anything usable" question is asked of these, so a model with no build here
// cannot be counted as an option the user has.
function speechModelRows(data) {
  return SPEECH_MODEL_ROWS.filter((row) => engineOffered(data, row.id));
}
function speechRuntimeUsable(data) {
  const runtime = data.asrRuntime;
  return !runtime || (!!runtime.installed && !runtime.needsUpgrade);
}
function speechRowInstalled(data, engine) {
  if (!data.modelPlan) return asrEngineId(data.asrEngine) === engine;
  const item = speechPlanItem(data, speechComponent(engine, speechDevice(data)));
  if (item && item.installed) return true;
  // main.js starts Whisper large-v3 from a tuned model without the hosted
  // weights, but only on a working runtime: repairing one fetches the hosted
  // 3.1 GB too, so without it the row must say Download, not Use.
  return engine === 'whisper' && !!data.tunedModel && data.useTunedModel !== false && speechRuntimeUsable(data);
}
function speechRowState(data, engine) {
  if (data.asrOperation === 'install' && speechActiveRow === engine) return 'downloading';
  const selected = asrEngineId(data.asrEngine) === engine;
  const installed = speechRowInstalled(data, engine);
  if (selected && installed) {
    return data.cloudTranscription !== true && ['loading', 'starting'].includes(data.engineStatus) ? 'loading' : 'in-use';
  }
  if (installed || !data.modelPlan) return 'use';
  return 'download';
}
function speechErrorSignature(state) {
  return state && ['error', 'cancelled'].includes(state.status) ? state.status + '|' + (state.message || '') : '';
}
// The finished setup error still on screen, or null.
function speechVisibleError(data) {
  const state = data.asrRuntimeState || {};
  const signature = speechErrorSignature(state);
  return !data.asrOperation && signature && signature !== speechDismissedError ? state : null;
}
function speechDismissError(data) { speechDismissedError = speechErrorSignature((data || {}).asrRuntimeState); }
// Whether a panel slot (row, Downloaded models, Remove everything) already draws the asrRuntimeState error.
function speechOwnsError() {
  return !!speechOp && !speechOp.pending
    && (speechOp.kind === 'install' || speechOp.kind === 'remove-all'
      || (speechOp.kind === 'remove' && String(speechOp.key).startsWith('model:')));
}
function speechJoinNames(names) {
  return names.length <= 1 ? (names[0] || '') : names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
}

// Which row a running install belongs to. asrRuntimeState never names the
// component it is fetching, so: the row the panel started it on; else
// large-v3, the only download reporting step 'model'; else the one pack whose
// byte count matches the total; else the selected model when the plan is
// missing it (the banner, onboarding and Check and repair fetch plan.missing).
// Once found it sticks for the life of the operation.
function updateSpeechActiveRow(data) {
  if (data.asrOperation !== 'install') { speechActiveRow = null; return; }
  const state = data.asrRuntimeState || {};
  let row = null;
  if (speechOp && speechOp.kind === 'install' && speechOp.pending) {
    row = speechOp.row;
  } else if (state.step === 'model') {
    row = 'whisper';
  } else if (state.step === 'extras' && Number(state.totalBytes) > 0) {
    const matches = ['parakeet', 'parakeet-fp32', 'whisper-turbo', 'qwen3-asr']
      .filter((id) => { const item = speechPlanItem(data, id); return item && item.bytes === Number(state.totalBytes); });
    if (matches.length === 1) row = matches[0] === 'parakeet-fp32' ? 'parakeet' : matches[0];
  }
  if (!row) {
    const selected = asrEngineId(data.asrEngine);
    const missing = (data.modelPlan && data.modelPlan.missing) || [];
    if (missing.includes(speechComponent(selected, speechDevice(data)))) row = selected;
  }
  if (row) speechActiveRow = row;
}

function renderSpeechEngines(data) {
  if (!speechModelListEl) return;
  // Only an install or a removal replaces asrRuntimeState. A GPU pack
  // operation leaves it alone, so an error the user moved past stays dismissed.
  if (data.asrOperation === 'install' || data.asrOperation === 'remove') speechDismissedError = '';
  if (speechOp && !speechOp.pending && data.asrOperation) speechOp = null;  // a later operation retires the record of the last one
  // The NVIDIA pack restarts the engine once it lands, but until the old
  // process exits the snapshot still says 'ready' on the processor.
  if (speechPackBusy(data.cudaPackState)) speechCudaRestartPending = true;
  else if (data.engineStatus !== 'ready') speechCudaRestartPending = false;
  if (!speechPackBusy(data.cudaPackState)) speechPending.delete('gpu:cuda-cancel');
  if (!speechPackBusy(data.qwenCudaPackState) && !speechPackBusy(data.qwenRocmPackState)) speechPending.delete('gpu:qwen-cancel');
  if (data.asrOperation !== 'install') speechPending.delete('cancel');
  updateSpeechActiveRow(data);
  renderListenMode(data);
  renderSpeechModelSection(data);
  renderSpeechGpuRow(data);
  renderSpeechProcessor(data);
  renderTunedModel(data);
  renderSpeechDownloads(data);
  renderSpeechMaintenance(data);
}

function renderSpeechModelSection(data) {
  const cloudOnly = data.cloudTranscription === true && !data.asrOperation;
  speechShow(speechModelListEl, !cloudOnly);
  for (const row of SPEECH_MODEL_ROWS) renderSpeechModelRow(data, row);
  const notice = speechNotice(data);
  speechSetText(speechModelNoticeEl, notice.text || '');
  speechSetText(speechModelAnnounceEl, notice.text || '');
  speechModelNoticeEl.classList.toggle('is-error', !!notice.error);
  speechShow(speechModelNoticeEl, !!notice.text);
  speechSetText(speechModelDetailEl, notice.detail || '');
  speechModelDetailEl.classList.toggle('is-error', notice.detailError !== false);
  speechShow(speechModelDetailEl, !!notice.detail);
  const repairFocused = speechModelNoticeActionsEl.contains(document.activeElement);
  speechShow(speechModelNoticeActionsEl, !!notice.repair);
  speechSetText(speechModelRepairBtn, speechOp && speechOp.kind === 'repair' && speechOp.pending ? 'Checking…' : 'Check and repair');
  speechSetDisabled(speechModelRepairBtn, !!data.asrOperation || speechPending.has('repair'));
  if (repairFocused && !notice.repair) speechModelListEl.focus({ preventScroll: true });
}

// The one line under "Model". First match wins: Cloud on, a removal, an
// install, a GPU pack operation, dictation unable to start, an engine warning,
// a runtime that needs repair, then any setup error no other slot is showing.
function speechNotice(data) {
  const selected = asrEngineId(data.asrEngine);
  const visible = speechOwnsError() ? null : speechVisibleError(data);
  const repairError = speechOp && speechOp.kind === 'repair' && !speechOp.pending ? speechOp.localError : '';
  const u = repairError ? { text: repairError, isError: true }
    : visible ? { text: visible.message || '', isError: visible.status === 'error' } : null;
  if (data.cloudTranscription === true && !data.asrOperation) {
    const shown = speechRowInstalled(data, selected) ? selected
      : (speechModelRows(data).find((row) => speechRowInstalled(data, row.id)) || {}).id;
    return { text: shown
      ? speechRowName(shown) + ' stays on ' + thisDevice() + ' and is not used while Voxden Cloud is on.'
      : 'No model is downloaded on ' + thisDevice() + ', and none is needed while Voxden Cloud is on.' };
  }
  const st = data.asrRuntimeState || {};
  if (data.asrOperation === 'remove') return { text: st.message || '' };
  if (data.asrOperation === 'install') {
    return { text: speechActiveRow
      ? 'Dictation on ' + thisDevice() + ' is paused until this download finishes.'
      : 'Dictation on ' + thisDevice() + ' is paused while Voxden checks the speech engine.' };
  }
  if (data.asrOperation) return { text: '' };
  // Removing the NVIDIA pack stops the engine for a moment; that is not a failure.
  const packRemoving = !!speechOp && speechOp.kind === 'remove' && speechOp.pending && speechOp.key === 'cuda';
  if (data.engineStatus === 'unavailable' && !packRemoving) {
    if (data.modelPlan && !speechRowInstalled(data, selected)) {
      const canUse = speechModelRows(data).some((row) => speechRowState(data, row.id) === 'use');
      return { text: canUse ? 'Choose a model below to start dictating on ' + thisDevice() + '.'
        : 'Download a model below to start dictating on ' + thisDevice() + '.',
      error: true, detail: u ? u.text : '', detailError: u ? u.isError : true };
    }
    return { text: 'Voxden could not start dictation on ' + thisDevice() + '.', error: true,
      detail: data.asrEngineError || (u ? u.text : ''), detailError: data.asrEngineError ? true : (u ? u.isError : true),
      repair: !!data.asrRuntime };
  }
  if (data.asrEngineWarning) {
    const fix = data.asrEngineFix && !data.usingManagedRuntime
      ? 'To enable ' + speechRowName(data.asrEngineFixEngine) + ', run: ' + data.asrEngineFix : '';
    return { text: data.asrEngineWarning, error: true, detail: fix, detailError: true,
      repair: !!(data.asrEngineFix && data.usingManagedRuntime) };
  }
  if (data.asrRuntime && data.asrRuntime.installed && data.asrRuntime.needsUpgrade) {
    return { text: 'The speech engine needs repair.', error: true, detail: u ? u.text : '', detailError: u ? u.isError : true, repair: true };
  }
  if (u) return { text: u.text, error: u.isError };
  return { text: '' };
}

function renderSpeechModelRow(data, row) {
  const li = speechModelListEl.querySelector('[data-engine="' + row.id + '"]');
  if (!li) return;
  // A model with no build for this platform leaves the list entirely; the
  // markup stays in app.html so one renderer can serve both.
  if (!engineOffered(data, row.id)) { speechShow(li, false); return; }
  speechShow(li, true);
  const part = (role) => li.querySelector('[data-role="' + role + '"]');
  const lineEl = part('line'), barRowEl = part('progress-row'), barEl = part('progress');
  const fillEl = part('progress-fill'), labelEl = part('progress-label'), errorEl = part('error');
  const sizeEl = part('size'), stateEl = part('state'), btn = part('action');
  const st = data.asrRuntimeState || {};
  const state = speechRowState(data, row.id);
  const item = speechPlanItem(data, speechComponent(row.id, speechDevice(data)));
  const bytes = item ? Number(item.bytes) || 0 : 0;
  const loadPct = state === 'loading' ? speechPercent((data.asrEngineProgress || {}).percent) : 0;
  const showBar = state === 'downloading' || loadPct > 0;
  const pct = state === 'downloading' ? speechPercent(st.progress) : loadPct;
  speechShow(lineEl, !showBar);
  speechShow(barRowEl, showBar);
  if (showBar) {
    if (fillEl.style.width !== pct + '%') fillEl.style.width = pct + '%';
    if (barEl.getAttribute('aria-valuenow') !== String(pct)) barEl.setAttribute('aria-valuenow', String(pct));
    const valueText = pct > 0 ? pct + '% complete' : 'Preparing download';
    if (barEl.getAttribute('aria-valuetext') !== valueText) barEl.setAttribute('aria-valuetext', valueText);
    speechSetText(labelEl, pct > 0 ? pct + '%' : '');
  }
  const counted = state === 'downloading' && ['model', 'extras'].includes(st.step) && Number(st.totalBytes) > 0;
  const sizeText = counted
    ? formatSetupBytes(Number(st.downloadedBytes) || 0) + ' of ' + formatSetupBytes(Number(st.totalBytes))
    : (bytes > 0 ? formatSetupBytes(bytes) : '');
  speechSetText(sizeEl, sizeText);
  speechShow(sizeEl, !!sizeText);
  const hadFocus = btn === document.activeElement;
  if (state === 'in-use' || state === 'loading') {
    speechSetText(stateEl, state === 'loading' ? 'Loading…' : 'In use');
    speechShow(stateEl, true);
    speechShow(btn, false);
    if (hadFocus) speechModelListEl.focus({ preventScroll: true });
  } else {
    speechShow(stateEl, false);
    const action = state === 'downloading' ? 'cancel' : state === 'use' ? 'use' : 'install';
    if (btn.dataset.action !== action) {
      if (action === 'cancel') speechArmedAt.set(row.id, Date.now() + SPEECH_ARM_MS);
      btn.dataset.action = action;
    }
    const cancelling = st.status === 'cancelling' || speechPending.has('cancel');
    speechSetText(btn, action === 'cancel' ? (cancelling ? 'Cancelling…' : 'Cancel') : action === 'use' ? 'Use' : 'Download and use');
    speechSetDisabled(btn, action === 'cancel' ? cancelling
      : (!!data.asrOperation || speechPending.has('install:' + row.id) || speechPending.has('use:' + row.id)));
    speechShow(btn, true);
  }
  let errorText = '';
  let errorIsError = true;
  if (state !== 'downloading' && speechOp && speechOp.kind === 'install' && speechOp.row === row.id && !speechOp.pending) {
    const visible = speechVisibleError(data);
    if (speechOp.localError) errorText = speechOp.localError;
    else if (visible) { errorText = visible.message || ''; errorIsError = visible.status === 'error'; }
  }
  speechSetText(errorEl, errorText);
  errorEl.classList.toggle('is-error', errorIsError);
  speechShow(errorEl, !!errorText);
}

// Advanced > Processor. All four options stay in app.html (test-asr.js reads
// them there); the ones that make no sense on this PC are detached at runtime.
function renderSpeechProcessor(data) {
  const select = settingInputs.asrDevice;
  if (!select) return;
  // cuda and directml are Windows backends. Where neither exists there is no
  // choice to make, so the whole row goes rather than offering Auto alone.
  if (!gpuPacksOffered(data)) {
    speechShow(speechProcessorRowEl, false);
    return;
  }
  speechShow(speechProcessorRowEl, true);
  const gpu = data.gpu || {};
  const vendors = Array.isArray(gpu.vendors) ? gpu.vendors : (gpu.vendor ? [gpu.vendor] : []);
  const device = speechDevice(data);
  const amdIntel = vendors.includes('amd') || vendors.includes('intel');
  const want = ['auto'];
  if (vendors.includes('nvidia') || device === 'cuda') want.push('cuda');
  if (amdIntel || device === 'directml') want.push('directml');
  want.push('cpu');
  if (Array.from(select.options, (opt) => opt.value).join() !== want.join()) {
    for (const opt of Object.values(speechProcessorOptions)) if (opt.parentNode && !want.includes(opt.value)) opt.remove();
    want.forEach((value, i) => { const opt = speechProcessorOptions[value]; if (opt && select.options[i] !== opt) select.insertBefore(opt, select.options[i] || null); });
  }
  if (select.value !== device) select.value = device;
  const off = !!data.asrOperation || speechPending.has('processor');
  if (select.disabled !== off) select.disabled = off;
  syncCustomSelect(select);
  speechSetText(speechProcessorHintEl, amdIntel
    ? 'Auto keeps Parakeet v3 on the processor; choose AMD or Intel GPU to run it on your graphics card.'
    : 'Auto uses your graphics card whenever the model in use can.');
}

// Advanced > Downloaded models, in list order: speech models, then GPU packs.
function speechDownloadEntries(data) {
  const inUse = speechComponent(asrEngineId(data.asrEngine), speechDevice(data));
  const entries = [];
  const packs = gpuPacksOffered(data);
  for (const [id, name] of SPEECH_DOWNLOAD_MODELS) {
    // parakeet-fp32 is the GPU build of Parakeet, so it belongs with the packs.
    if (id === 'parakeet-fp32' ? !packs : !engineOffered(data, id)) continue;
    const item = speechPlanItem(data, id);
    if (!item || !item.installed) continue;
    entries.push({ key: 'model:' + id, type: 'model', id, name, bytes: item.bytes || 0,
      size: item.bytes ? formatSetupBytes(item.bytes) : '', inUse: id === inUse, line: '' });
  }
  const cuda = data.cudaPack || {};
  if (packs && cuda.installed) {
    entries.push({ key: 'cuda', type: 'cuda', name: 'NVIDIA speed-up for Whisper', size: cuda.installedSize || '771 MB', inUse: false, line: '' });
  }
  for (const kind of packs ? ['cuda', 'rocm'] : []) {
    const pack = (kind === 'rocm' ? data.qwenRocmPack : data.qwenCudaPack) || {};
    if (!pack.installed) continue;
    entries.push({ key: 'qwen:' + kind, type: 'qwen', kind,
      name: kind === 'rocm' ? 'AMD speed-up for Qwen3-ASR' : 'NVIDIA speed-up for Qwen3-ASR',
      size: pack.installedSize || (kind === 'rocm' ? '6.99 GB' : '5.26 GB'), inUse: false, line: speechQwenPackLine(data, kind) });
  }
  return entries;
}
// A Qwen pack claims the GPU only once the sidecar has verified it and Qwen is running.
function speechQwenPackLine(data, kind) {
  const plan = data.qwenAccel || {};
  if (plan.recommendedPack !== kind) return '';
  if (plan.uiStatus === 'verified' && plan.backend === kind
      && asrEngineId(data.asrEngine) === 'qwen3-asr' && data.engineStatus === 'ready') return 'Qwen3-ASR is using your GPU.';
  if (plan.uiStatus === 'installed') return 'Qwen3-ASR stays on the processor until Voxden checks this download on your GPU.';
  return '';
}

function speechCreateDownloadItem(key) {
  const li = document.createElement('li');
  li.className = 'speech-extra';
  li.dataset.key = key;
  const copy = document.createElement('div');
  copy.className = 'speech-extra-copy';
  const name = document.createElement('span');
  name.className = 'speech-extra-name';
  name.dataset.role = 'name';
  const line = document.createElement('span');
  line.className = 'speech-extra-hint';
  line.dataset.role = 'line';
  line.hidden = true;
  copy.append(name, line);
  const size = document.createElement('span');
  size.className = 'speech-extra-state speech-model-size';
  size.dataset.role = 'size';
  const action = document.createElement('div');
  action.className = 'speech-model-action';
  const state = document.createElement('span');
  state.className = 'speech-extra-state';
  state.dataset.role = 'state';
  state.textContent = 'In use';
  state.hidden = true;
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'speech-setup-remove';
  remove.dataset.role = 'remove';
  remove.dataset.key = key;
  remove.setAttribute('aria-disabled', 'false');
  remove.textContent = 'Remove';
  action.append(state, remove);
  li.append(copy, size, action);
  return li;
}

// Keyed by entry, so an item that stays keeps its node (and its focus).
function renderSpeechDownloads(data) {
  if (!speechDownloadsListEl) return;
  const entries = speechDownloadEntries(data);
  const keys = new Set(entries.map((entry) => entry.key));
  for (const [key, li] of speechDownloadNodes) {
    if (keys.has(key)) continue;
    if (li.contains(document.activeElement)) speechAdvancedEl.querySelector('summary').focus({ preventScroll: true });
    li.remove();
    speechDownloadNodes.delete(key);
  }
  entries.forEach((entry, index) => {
    let li = speechDownloadNodes.get(entry.key);
    if (!li) { li = speechCreateDownloadItem(entry.key); speechDownloadNodes.set(entry.key, li); }
    const at = speechDownloadsListEl.children[index] || null;
    if (at !== li) speechDownloadsListEl.insertBefore(li, at);
    const part = (role) => li.querySelector('[data-role="' + role + '"]');
    speechSetText(part('name'), entry.name);
    speechSetText(part('line'), entry.line);
    speechShow(part('line'), !!entry.line);
    speechSetText(part('size'), entry.size);
    speechShow(part('size'), !!entry.size);
    const remove = part('remove');
    const hadFocus = remove === document.activeElement;
    speechShow(part('state'), entry.inUse);
    speechShow(remove, !entry.inUse);
    if (entry.inUse) { if (hadFocus) speechAdvancedEl.querySelector('summary').focus({ preventScroll: true }); return; }
    const removing = !!speechOp && speechOp.kind === 'remove' && speechOp.key === entry.key && speechOp.pending;
    speechSetText(remove, removing ? 'Removing…' : 'Remove');
    const packState = entry.type === 'cuda' ? data.cudaPackState
      : entry.type === 'qwen' ? (entry.kind === 'rocm' ? data.qwenRocmPackState : data.qwenCudaPackState) : null;
    speechSetDisabled(remove, speechPending.has('remove:' + entry.key) || !!data.asrOperation || speechPackBusy(packState));
  });
  speechShow(speechDownloadsRowEl, entries.length > 0);
  let error = '';
  if (speechOp && speechOp.kind === 'remove' && !speechOp.pending) {
    if (speechOp.localError) error = speechOp.localError;
    else if (String(speechOp.key).startsWith('model:')) {
      const visible = speechVisibleError(data);
      if (visible && visible.status === 'error') error = visible.message || '';
    } else {
      const state = (speechOp.key === 'cuda' ? data.cudaPackState
        : speechOp.key === 'qwen:rocm' ? data.qwenRocmPackState : data.qwenCudaPackState) || {};
      if (state.status === 'error') error = state.message || '';
    }
  }
  speechSetText(speechDownloadsErrorEl, error);
  speechShow(speechDownloadsErrorEl, !!error);
}

// Advanced > Check and repair, and Remove everything.
function renderSpeechMaintenance(data) {
  if (!speechRepairBtn || !speechRemoveAllBtn) return;
  const repairing = !!speechOp && speechOp.kind === 'repair' && speechOp.pending;
  speechShow(speechRepairRowEl, !!data.asrRuntime);
  speechSetText(speechRepairBtn, repairing ? 'Checking…' : 'Check and repair');
  speechSetDisabled(speechRepairBtn, !!data.asrOperation || speechPending.has('repair'));
  const models = speechDownloadEntries(data).filter((entry) => entry.type === 'model');
  const runtime = data.asrRuntime;
  const visible = !!runtime && (!!runtime.installed || models.length > 0 || !!(data.asrModel && data.asrModel.installed));
  const hadFocus = speechRemoveAllBtn === document.activeElement;
  speechShow(speechRemoveAllRowEl, visible);
  if (!visible && hadFocus) speechAdvancedEl.querySelector('summary').focus({ preventScroll: true });
  const removing = !!speechOp && speechOp.kind === 'remove-all' && speechOp.pending;
  speechSetText(speechRemoveAllBtn, removing ? 'Removing…' : 'Remove everything');
  speechSetDisabled(speechRemoveAllBtn, !!data.asrOperation || speechPending.has('remove-all'));
  let error = '';
  if (speechOp && speechOp.kind === 'remove-all' && !speechOp.pending) {
    const shown = speechVisibleError(data);
    error = speechOp.localError || (shown && shown.status === 'error' ? shown.message || '' : '');
  }
  speechSetText(speechRemoveAllErrorEl, error);
  speechShow(speechRemoveAllErrorEl, !!error);
}

// Model rows: one button each. "Download and use" and "Use" need no confirm;
// the Model notice says local dictation is paused while a download runs.
speechModelListEl.addEventListener('click', (event) => {
  const btn = event.target.closest('button[data-role="action"]');
  if (!btn || speechIsDisabled(btn)) return;
  const engine = btn.closest('[data-engine]').dataset.engine;
  if (btn.dataset.action === 'cancel') speechCancelInstall(engine);
  else if (btn.dataset.action === 'use') speechUseModel(engine);
  else speechInstallModel(engine);
});

async function speechInstallModel(engine, component) {
  const data = lastPayload || {};
  const key = 'install:' + engine;
  if (data.asrOperation || speechPending.has(key) || !window.voxden || !window.voxden.installSpeechModel) return null;
  const id = component || speechComponent(engine, speechDevice(data));
  speechDismissError(data);
  const op = { kind: 'install', row: engine, component: id, pending: true, localError: '' };
  speechOp = op;
  speechPending.add(key);
  render();
  try {
    const next = await window.voxden.installSpeechModel(id, { select: true });
    op.pending = false;
    if (next) render(next);
    return next || null;
  } catch (err) {
    op.pending = false;
    op.localError = (err && err.message) || 'The download could not start. Try again.';
    return null;
  } finally {
    speechPending.delete(key);
    render();
  }
}

function speechUseModel(engine) {
  const data = lastPayload || {};
  const key = 'use:' + engine;
  if (data.asrOperation || speechPending.has(key)) return;
  // A pack on disk with no usable runtime: the install path unpacks the runtime, then switches.
  if (data.modelPlan && !speechRuntimeUsable(data)) { speechInstallModel(engine); return; }
  speechDismissError(data);
  speechPending.add(key);
  render();
  patchSettings({ asrEngine: engine }).finally(() => { speechPending.delete(key); render(); });
}

function speechCancelInstall(engine) {
  if (Date.now() < (speechArmedAt.get(engine) || 0) || speechPending.has('cancel')) return;
  speechPending.add('cancel');
  render();
  window.voxden.cancelAsrRuntime()
    .then((next) => { if (next) render(next); })
    .catch(() => {});
  // 'cancel' is cleared in renderSpeechEngines once asrOperation leaves 'install'.
}

// The Model notice's repair button and Advanced > Check and repair.
async function speechRepair() {
  const data = lastPayload || {};
  if (data.asrOperation || speechPending.has('repair') || !window.voxden) return;
  speechDismissError(data);
  const op = { kind: 'repair', pending: true, localError: '' };
  speechOp = op;
  speechPending.add('repair');
  render();
  try {
    const next = await window.voxden.installAsrRuntime();
    op.pending = false;
    if (next) render(next);
  } catch (err) {
    op.pending = false;
    op.localError = (err && err.message) || 'Setup failed. Try again.';
  } finally {
    speechPending.delete('repair');
    render();
  }
}
speechModelRepairBtn.addEventListener('click', () => { if (!speechIsDisabled(speechModelRepairBtn)) speechRepair(); });
speechRepairBtn.addEventListener('click', () => { if (!speechIsDisabled(speechRepairBtn)) speechRepair(); });

// Advanced > Downloaded models > Remove.
speechDownloadsListEl.addEventListener('click', (event) => {
  const btn = event.target.closest('button[data-role="remove"]');
  if (btn && !speechIsDisabled(btn)) speechRemoveDownloaded(btn.dataset.key);
});

async function speechRemoveDownloaded(key) {
  const data = lastPayload || {};
  const entry = speechDownloadEntries(data).find((e) => e.key === key);
  const pendingKey = 'remove:' + key;
  if (!entry || entry.inUse || data.asrOperation || speechPending.has(pendingKey) || !window.voxden) return;
  // Before the prompt: clicks while it is open must not queue removals.
  speechPending.add(pendingKey);
  render();
  let op = null;
  try {
    if (!(await askConfirm({
      title: 'Remove ' + entry.name + '?',
      body: (entry.size ? 'It frees ' + entry.size + '. ' : '') + 'You can download it again from here at any time.',
      confirmLabel: 'Remove',
    }))) return;
    speechDismissError(lastPayload);
    op = { kind: 'remove', key, pending: true, localError: '' };
    speechOp = op;
    render();
    const next = entry.type === 'model' ? await window.voxden.removeSpeechModel(entry.id)
      : entry.type === 'cuda' ? await window.voxden.removeCudaPack()
        : await window.voxden.removeQwenAccel(entry.kind);
    op.pending = false;
    if (next) render(next);
  } catch (err) {
    if (op) { op.pending = false; op.localError = 'Could not remove ' + entry.name + '. ' + ((err && err.message) ? err.message : 'Try again.'); }
  } finally {
    speechPending.delete(pendingKey);
    render();
  }
}

// Advanced > Remove everything. The body names what actually goes: the
// runtime, Whisper large-v3 and every speech pack; GPU packs and the tuned
// model stay.
speechRemoveAllBtn.addEventListener('click', async () => {
  const data = lastPayload || {};
  if (speechIsDisabled(speechRemoveAllBtn) || data.asrOperation || speechPending.has('remove-all') || !window.voxden) return;
  speechPending.add('remove-all');
  render();
  let op = null;
  try {
    const models = speechDownloadEntries(data).filter((e) => e.type === 'model');
    const total = models.reduce((n, e) => n + (e.bytes || 0), 0);
    const tail = ' removed from ' + thisDevice() + ', and dictation on ' + thisDevice() + ' stops until you download a model again.'
      + ' Your history, settings and GPU speed-up downloads are kept.';
    const body = models.length
      ? speechJoinNames(models.map((e) => e.name)) + (total ? ' (' + formatSetupBytes(total) + ')' : '')
        + (models.length === 1 ? ' is' : ' are') + tail
      : 'The speech engine is' + tail;
    if (!(await askConfirm({ title: 'Remove all speech models?', body, confirmLabel: 'Remove all' }))) return;
    speechDismissError(lastPayload);
    op = { kind: 'remove-all', pending: true, localError: '' };
    speechOp = op;
    render();
    const next = await window.voxden.removeAsrRuntime();
    op.pending = false;
    if (next) render(next);
  } catch (err) {
    if (op) { op.pending = false; op.localError = 'Could not remove the speech engine. ' + ((err && err.message) ? err.message : 'Try again.'); }
  } finally {
    speechPending.delete('remove-all');
    render();
  }
});

// The engine hint lives in Settings, which a first-run user has no reason to
// open. If dictation cannot work at all, say so on the page they land on -- and
// where a download fixes it, put that download here rather than describing it.
function renderEngineBanner(data) {
  if (!engineBannerEl) return;
  const runtime = data.asrRuntimeState || {};
  const { busy, needsEngine, needsModel, pending } = speechSetupInfo(data);
  const broken = data.engineStatus === 'unavailable';
  const offer = !!data.asrRuntimeWouldHelp;
  engineBannerEl.hidden = !broken && !busy && !offer;
  if (engineBannerEl.hidden) return;
  const size = formatSetupBytes(pending);
  const required = (data.modelPlan ? data.modelPlan.items : [])
    .filter((item) => item.role === 'required')
    .map((item) => item.name);
  const what = required.length ? ' for ' + required.join(' and ') : ' for the speech model';

  let text;
  if (busy) {
    text = runtime.message || 'Setting up dictation…';
  } else if (runtime.status === 'error' || runtime.status === 'cancelled') {
    text = runtime.message;
  } else if (offer && needsEngine) {
    text = 'Dictation needs a one-time download of ' + size + what
      + '. Nothing else to install: no Python, no command line.';
  } else if (offer) {
    text = pending ? 'Setup did not finish. Complete the download (up to ' + size + ')'
      + what + '. Dictation never downloads missing models in the background.'
      : 'The speech engine needs repair. Run setup again to check its files.';
  } else {
    text = data.asrEngineError
      || ('Voxden could not start its speech engine on ' + thisDevice() + '. Dictation is unavailable.');
  }
  if (engineBannerTextEl) engineBannerTextEl.textContent = text;

  const percent = Number.isFinite(runtime.progress)
    ? Math.max(0, Math.min(100, Math.round(runtime.progress)))
    : 0;
  if (engineBannerProgressEl) engineBannerProgressEl.hidden = !busy;
  if (engineBannerFillEl) engineBannerFillEl.style.width = percent + '%';
  if (engineBannerPctEl) {
    engineBannerPctEl.textContent = runtime.status === 'downloading' && percent > 0
      ? percent + '%'
      : '';
  }
  const bar = engineBannerProgressEl && engineBannerProgressEl.querySelector('.engine-banner-bar');
  if (bar) bar.setAttribute('aria-valuenow', String(percent));

  if (!engineBannerBtnEl) return;
  engineBannerBtnEl.disabled = runtime.status === 'cancelling' || runtime.status === 'removing';
  if (busy) {
    engineBannerBtnEl.hidden = false;
    engineBannerBtnEl.textContent = runtime.status === 'removing' ? 'Removing…'
      : runtime.status === 'cancelling' ? 'Cancelling…' : 'Cancel';
    engineBannerBtnEl.dataset.action = 'cancel';
  } else if (data.localModelChosen === false) {
    engineBannerBtnEl.hidden = false;
    engineBannerBtnEl.textContent = 'Choose a model';
    engineBannerBtnEl.dataset.action = 'choose';
  } else if (offer || runtime.status === 'error' || runtime.status === 'cancelled') {
    engineBannerBtnEl.hidden = false;
    engineBannerBtnEl.textContent = runtime.status === 'error' || runtime.status === 'cancelled'
      ? 'Try again'
      : (needsEngine ? 'Set up dictation' : 'Finish setup');
    engineBannerBtnEl.dataset.action = 'install';
  } else {
    engineBannerBtnEl.hidden = true;
  }
}

if (engineBannerBtnEl) {
  engineBannerBtnEl.addEventListener('click', () => {
    if (engineBannerBtnEl.disabled) return;
    const action = engineBannerBtnEl.dataset.action;
    if (action === 'choose') return window.VoxdenOnboarding.open();
    if (!window.voxden) return;
    if (action === 'cancel') {
      window.voxden.cancelAsrRuntime();
      return;
    }
    // Disable immediately: install() rejects a second concurrent call, and the
    // first progress event that would repaint the button is a moment away.
    engineBannerBtnEl.disabled = true;
    window.voxden.installAsrRuntime()
      .then((next) => { if (next) render(next); })
      .catch(err => { engineBannerTextEl.textContent = err.message || 'Setup failed. Try again.'; })
      .finally(() => { engineBannerBtnEl.disabled = false; });
  });
}

// Settings › Account. Three rows, one visible at a time: sign in with an
// email, enter the code that was sent, or the signed-in summary. Every action
// answers with a full snapshot, so the panel only ever paints from render().
const accountSignedOutEl = document.getElementById('account-signed-out');
const accountPendingEl = document.getElementById('account-pending');
const accountSignedInEl = document.getElementById('account-signed-in');
const accountEmailInput = document.getElementById('account-email');
const accountSendCodeBtn = document.getElementById('account-send-code');
const accountErrorEl = document.getElementById('account-error');
const accountPendingHintEl = document.getElementById('account-pending-hint');
const accountPendingErrorEl = document.getElementById('account-pending-error');
const accountCodeInput = document.getElementById('account-code');
const accountVerifyBtn = document.getElementById('account-verify');
const accountPendingBackBtn = document.getElementById('account-pending-back');

const accountPlanHintEl = document.getElementById('account-plan-hint');
const accountStatusHintEl = document.getElementById('account-status-hint');
const accountRefreshBtn = document.getElementById('account-refresh');
const accountSignOutBtn = document.getElementById('account-sign-out');

function formatAccountDate(value) {
  const t = Date.parse(value || '');
  if (!Number.isFinite(t)) return '';
  return new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function renderAccount(data) {
  if (!accountSignedOutEl || !accountPendingEl || !accountSignedInEl) return;
  const account = data.account || null;
  if (!account) {
    accountSignedOutEl.hidden = false;
    accountPendingEl.hidden = true;
    accountSignedInEl.hidden = true;
    if (accountSendCodeBtn) accountSendCodeBtn.disabled = true;
    if (accountErrorEl) {
      accountErrorEl.hidden = false;
      accountErrorEl.textContent = 'Accounts are not available in this build.';
    }
    return;
  }
  const busy = !!account.busy;
  const view = account.signedIn ? 'in' : account.pendingEmail ? 'pending' : 'out';
  accountSignedOutEl.hidden = view !== 'out';
  accountPendingEl.hidden = view !== 'pending';
  accountSignedInEl.hidden = view !== 'in';

  if (view === 'out') {
    const signInHint = document.getElementById('account-signin-hint');
    if (signInHint) {
      signInHint.textContent = 'A code goes to your email; no password to remember. Dictation works the same signed out.';
    }
    if (accountSendCodeBtn) {
      accountSendCodeBtn.disabled = busy;
      accountSendCodeBtn.textContent = account.busy === 'code' ? 'Sending…' : 'Send code';
    }
    if (accountEmailInput) accountEmailInput.disabled = busy;
    if (accountErrorEl) {
      accountErrorEl.hidden = !account.lastError;
      accountErrorEl.textContent = account.lastError || '';
    }
    return;
  }
  if (view === 'pending') {
    if (accountPendingHintEl) {
      accountPendingHintEl.textContent = 'Sent to ' + account.pendingEmail
        + '. It is six digits and expires in ten minutes. Check spam if it has not arrived.';
    }
    if (accountVerifyBtn) {
      accountVerifyBtn.disabled = busy;
      accountVerifyBtn.textContent = account.busy === 'verify' ? 'Signing in…' : 'Sign in';
    }
    if (accountCodeInput) accountCodeInput.disabled = busy;
    if (accountPendingBackBtn) accountPendingBackBtn.disabled = busy;
    if (accountPendingErrorEl) {
      accountPendingErrorEl.hidden = !account.lastError;
      accountPendingErrorEl.textContent = account.lastError || '';
    }
    return;
  }
  renderProfileCard(account, data);
  if (accountPlanHintEl) {
    if (account.plan === 'pro') {
      const cloud = account.cloud || {};
      const until = formatAccountDate(account.planExpiresAt);
      accountPlanHintEl.textContent = 'Pro' + (until ? ' until ' + until : '') + '. '
        + (cloudMeterFromAccount(account)
          ? (function () {
            const meter = cloudMeterFromAccount(account);
            const used = Math.max(0, Math.round(meter.creditsUsed)).toLocaleString();
            const cap = Math.max(0, Math.round(meter.creditsCap)).toLocaleString();
            return used + ' of ' + cap + ' cloud credits used'
              + (meter.reset === 'never' ? '.' : ' this month.');
          }())
          : (Number(cloud.hoursUsed) || 0) + ' of ' + (Number(cloud.hoursCap) || 0) + ' hours used this month.');
    } else if (account.stale) {
      accountPlanHintEl.textContent = 'Free for now. Your plan could not be checked for over a week; refresh once you are online.';
    } else {
      const words = freeWordMeter(data);
      accountPlanHintEl.textContent = 'Free plan. Everything runs on ' + thisDevice() + '.'
        + (words
          ? ' ' + wholeNumber(words.used) + ' of ' + wholeNumber(words.cap) + ' words used this week'
            + (words.resetsOn ? ', back on ' + words.resetsOn + '.' : '.')
          : '');
    }
  }
  if (accountStatusHintEl) {
    let status = '';
    if (account.busy === 'refresh') status = 'Checking…';
    else if (account.busy === 'signout') status = 'Signing out…';
    else if (account.busy === 'profile') status = 'Saving…';
    else if (account.busy === 'delete') status = 'Deleting your account…';
    else if (profileSavedAt && Date.now() - profileSavedAt < 4000) status = 'Saved.';
    else if (account.lastError) status = account.lastError;
    else if (account.checkedAt) status = 'Checked ' + new Date(account.checkedAt).toLocaleString();
    if (!account.tokenProtected) {
      status += (status ? ' ' : '') + (isMacUi() ? 'This Mac' : 'This PC')
        + ' cannot encrypt the sign-in token, so it is stored as is.';
    }
    accountStatusHintEl.textContent = status;
    accountStatusHintEl.classList.toggle('is-error', !busy && !!account.lastError);
  }
  if (accountRefreshBtn) accountRefreshBtn.disabled = busy;
  if (accountSignOutBtn) accountSignOutBtn.disabled = busy;
  if (accountDeleteBtn) accountDeleteBtn.disabled = busy;
}

// --- The profile card ----------------------------------------------------------
// Names are saved when a field loses focus and its value changed. The photo
// comes from the main process as a data URL (Google's, fetched once), and
// initials stand in for it otherwise.
const profileFirstEl = document.getElementById('profile-first');
const profileLastEl = document.getElementById('profile-last');
const profileEmailEl = document.getElementById('profile-email');
const profileAvatarEl = document.getElementById('profile-avatar');
const profileAvatarImgEl = document.getElementById('profile-avatar-img');
const profileAvatarInitialsEl = document.getElementById('profile-avatar-initials');
const accountDeleteBtn = document.getElementById('account-delete');
let profileFieldFocused = false;
let profileSavedAt = 0;

function profileInitials(profile, email) {
  const first = String((profile && profile.firstName) || '').trim();
  const last = String((profile && profile.lastName) || '').trim();
  const letters = (first ? first[0] : '') + (last ? last[0] : '');
  if (letters) return letters.toUpperCase();
  const address = String(email || '').trim();
  return address ? address[0].toUpperCase() : '?';
}

function renderProfileCard(account, data) {
  if (!profileFirstEl) return;
  const profile = account.profile || {};
  if (!profileFieldFocused) {
    profileFirstEl.value = profile.firstName || '';
    profileLastEl.value = profile.lastName || '';
  }
  profileEmailEl.textContent = account.email || '';
  const pro = account.plan === 'pro';
  const wrap = document.getElementById('profile-avatar-wrap');
  if (wrap) wrap.classList.toggle('is-pro', pro);
  const badge = document.getElementById('profile-badge');
  if (badge) badge.hidden = !pro;
  const card = profileAvatarEl.closest('.profile-card');
  if (card) card.classList.toggle('is-pro', pro);
  const photo = (data && data.accountAvatar) || '';
  if (photo) {
    profileAvatarImgEl.src = photo;
    profileAvatarImgEl.hidden = false;
  } else {
    profileAvatarImgEl.removeAttribute('src');
    profileAvatarImgEl.hidden = true;
  }
  profileAvatarEl.classList.toggle('has-photo', !!photo);
  profileAvatarInitialsEl.textContent = profileInitials(profile, account.email);
  const busy = !!account.busy;
  profileFirstEl.disabled = busy;
  profileLastEl.disabled = busy;
}

function saveProfileIfChanged() {
  const account = (lastPayload && lastPayload.account) || null;
  if (!account || !account.signedIn || !window.voxden || !window.voxden.accountUpdateProfile) return;
  const profile = account.profile || {};
  const next = { firstName: profileFirstEl.value.trim().slice(0, 40), lastName: profileLastEl.value.trim().slice(0, 40) };
  if (next.firstName === (profile.firstName || '') && next.lastName === (profile.lastName || '')) return;
  window.voxden.accountUpdateProfile(next).then((payload) => {
    if (payload && payload.account && !payload.account.lastError) profileSavedAt = Date.now();
    if (payload) render(payload);
  }).catch(() => {});
}

for (const input of [profileFirstEl, profileLastEl]) {
  if (!input) continue;
  input.addEventListener('focus', () => { profileFieldFocused = true; });
  input.addEventListener('blur', () => { profileFieldFocused = false; saveProfileIfChanged(); });
  input.addEventListener('keydown', (event) => { if (event.key === 'Enter') input.blur(); });
}

if (accountDeleteBtn) {
  accountDeleteBtn.addEventListener('click', async () => {
    const account = (lastPayload && lastPayload.account) || null;
    if (!account || !account.signedIn) return;
    const yes = await askConfirm({
      title: 'Delete your account?',
      body: 'This removes ' + account.email + ', its plan and its cloud usage from Voxden for good. Dictation history on '
        + thisDevice() + ' stays. This cannot be undone.',
      confirmLabel: 'Delete account',
    });
    if (!yes) return;
    accountAction(accountDeleteBtn, () => window.voxden.accountDelete());
  });
}

// Monthly offers live in Plans & billing. Existing subscriptions use their
// actual entitlement and paid-through date, not today's advertised price.
const accountUpgradeEl = document.getElementById('account-upgrade');
const accountUpgradeHintEl = document.getElementById('account-upgrade-hint');
const accountUpgradeErrorEl = document.getElementById('account-upgrade-error');
const accountUpgradeOptionsEl = document.getElementById('account-upgrade-options');
const accountManageActionsEl = document.getElementById('account-manage-actions');
const accountManageBillingBtn = document.getElementById('account-manage-billing');
let billingOptionsRequested = false;
const billingRegionEl = document.getElementById('billing-region');
let billingViewData = null;
// Both price regions pay through Razorpay, so the picker is keyed by region.
// Each price is fixed here as well as at Razorpay, and checkout refuses a plan
// that disagrees.
let billingRegion = 'in';
const BILLING_PRICES = { in: '₹349 / month', global: '$8 / month' };
const BILLING_REGION_LABELS = { in: 'India · INR', global: 'Everywhere else' };

// What the Free card promises, and how much of it is left. The cap comes from
// the account service, so the card never advertises a number the app is not
// actually enforcing.
function renderFreePlanWords(data) {
  const words = freeWordMeter(data);
  const cap = document.getElementById('billing-free-words');
  const usage = document.getElementById('billing-free-usage');
  if (cap) cap.textContent = (words ? wholeNumber(words.cap) : '3,000') + ' words a week';
  if (!usage) return;
  if (!words) {
    usage.hidden = true;
    usage.textContent = '';
    return;
  }
  usage.hidden = false;
  usage.classList.toggle('is-error', !!words.exhausted);
  usage.textContent = words.exhausted
    ? 'Used up' + (words.resetsOn ? ' until ' + words.resetsOn : '') + '. Dictation is paused until then.'
    : wholeNumber(words.used) + ' of ' + wholeNumber(words.cap) + ' used'
      + (words.resetsOn ? ', back on ' + words.resetsOn + '.' : ' this week.');
}

// The Pro allowance in cloud credits: `monthly` for every credit month,
// `welcome` for a subscriber's first (0 when there is no offer), and whether
// this account can still take the offer. The service states them; until it
// has, these are the defaults it ships with in src/credits.js.
const PRO_MONTHLY_CREDITS = 900;
const PRO_WELCOME_CREDITS = 1200;

function cloudCreditFigures(account, group) {
  const offer = account && account.welcomeOffer;
  const monthly = group && Number(group.cloudCreditsCap) > 0 ? Number(group.cloudCreditsCap)
    : offer && Number(offer.monthlyCredits) > 0 ? Number(offer.monthlyCredits)
      : group && Number(group.cloudHoursCap) > 0 ? Math.round(Number(group.cloudHoursCap) * 60)
        : PRO_MONTHLY_CREDITS;
  // A service that answered without a welcome figure predates the offer, and
  // an offer it does not know about must not be shown.
  const welcome = group && group.welcomeCreditsCap !== undefined ? Number(group.welcomeCreditsCap) || 0
    : offer ? Number(offer.credits) || 0
      : group ? 0 : PRO_WELCOME_CREDITS;
  return { monthly, welcome, eligible: !(offer && offer.eligible === false) };
}

// A credit is a minute of cloud audio, so the hours a figure covers are exact.
function creditHours(credits) {
  const minutes = Math.max(0, Math.round(Number(credits) || 0));
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  const parts = [];
  if (hours) parts.push(hours + (hours === 1 ? ' hour' : ' hours'));
  if (rest || !hours) parts.push(rest + (rest === 1 ? ' minute' : ' minutes'));
  return parts.join(' ');
}

// A month's credits spread over thirty days.
function creditMinutesPerDay(credits) {
  const minutes = Math.round(Math.max(0, Number(credits) || 0) / 30);
  return minutes + (minutes === 1 ? ' minute' : ' minutes');
}

function renderCreditFaq(figures) {
  const offer = figures.welcome > figures.monthly;
  const welcomeItem = document.getElementById('billing-faq-welcome-item');
  if (welcomeItem) welcomeItem.hidden = !offer;
  const welcome = document.getElementById('billing-faq-welcome');
  if (welcome && offer) {
    welcome.textContent = 'Your first month of Voxden Pro comes with ' + wholeNumber(figures.welcome) + ' cloud credits instead of '
      + wholeNumber(figures.monthly) + '. It runs from the day you subscribe until your first renewal, and each account gets it once. '
      + 'From your first renewal on, Pro includes ' + wholeNumber(figures.monthly) + ' credits a month.';
  }
  const cover = document.getElementById('billing-faq-credits');
  if (cover) {
    const amounts = (offer ? [figures.welcome, figures.monthly] : [figures.monthly])
      .map(value => wholeNumber(value) + ' credits cover up to ' + creditHours(value));
    cover.textContent = 'One credit is one minute of audio sent to Voxden Cloud, so ' + amounts.join(' and ') + '. '
      + 'Audio is counted in whole seconds, phrase by phrase, and pauses inside a dictation count too, so the time you spend '
      + 'actually speaking comes in a little under those hours. Credits refresh on your billing date each month, and unused '
      + 'credits do not carry over.';
  }
}

function renderAccountUpgrade(data) {
  if (!accountUpgradeEl) return;
  billingViewData = data;
  const account = data.account || null;
  accountUpgradeEl.hidden = false;
  const busy = !!(account && account.busy);
  const billing = (account && account.billing) || null;
  const pending = (account && account.checkoutPending) || null;
  const isPro = !!(account && account.plan === 'pro');
  if (account && account.signedIn && !isPro && (!billing || !Array.isArray(billing.options)) && !billingOptionsRequested && window.voxden && window.voxden.accountBillingOptions) {
    billingOptionsRequested = true;
    window.voxden.accountBillingOptions().then((next) => { if (next) render(next); }).catch(() => {})
      .finally(() => { billingOptionsRequested = false; });
  }
  if (accountUpgradeErrorEl) {
    const show = !busy && !!(account && account.lastError) && (pending || !isPro);
    accountUpgradeErrorEl.hidden = !show;
    accountUpgradeErrorEl.textContent = show ? account.lastError : '';
  }

  const welcomeMonth = !!(isPro && account.cloud && account.cloud.welcome);
  document.getElementById('billing-free-card').hidden = isPro;
  document.querySelector('.billing-plans').classList.toggle('is-subscribed', isPro);
  document.getElementById('billing-offer-price').hidden = isPro;
  document.getElementById('billing-welcome').hidden = true;
  // Hindi and Hinglish are the point for India. An account placed anywhere
  // else is told about the cloud's languages without them.
  document.getElementById('billing-cloud-languages').textContent = account && account.region === 'global'
    ? '60 languages through the cloud' : '60 languages through the cloud, Hindi and Hinglish included';
  document.getElementById('billing-plan-badge').textContent = welcomeMonth ? 'WELCOME MONTH' : isPro ? 'YOUR PLAN' : 'FOR YOUR EVERYDAY';
  document.querySelector('.billing-toolbar').hidden = isPro;
  const benefit = document.getElementById('billing-cloud-benefit');
  if (isPro) {
    const subscription = billing && billing.subscription;
    const until = formatAccountDate((subscription && subscription.periodEnd) || account.planExpiresAt);
    const renewalOff = !!(subscription && subscription.renews === false);
    renderSubscriptionDialog(data);
    renderCreditFaq(cloudCreditFigures(account, null));
    benefit.textContent = (function () {
      const meter = cloudMeterFromAccount(account);
      if (!meter) return (Number((account.cloud || {}).hoursCap) || 0) + ' cloud hours per month';
      const next = Number(account.cloud.monthlyCredits);
      if (welcomeMonth && account.cloud.periodEnd && next > 0) {
        return wholeNumber(meter.creditsCap) + ' cloud credits this month, then ' + wholeNumber(next)
          + ' a month from ' + formatAccountDate(account.cloud.periodEnd);
      }
      return wholeNumber(meter.creditsCap) + ' cloud credits' + (meter.reset === 'never' ? '' : ' every month')
        + ', up to ' + creditHours(meter.creditsCap);
    }());
    if (accountUpgradeHintEl) {
      const meter = cloudMeterFromAccount(account);
      accountUpgradeHintEl.textContent = (meter
        ? Math.round(meter.creditsUsed).toLocaleString() + ' of ' + Math.round(meter.creditsCap).toLocaleString()
          + ' cloud credits used' + (meter.reset === 'never' ? '.' : ' this month.')
        : (Number((account.cloud || {}).hoursUsed) || 0) + ' cloud hours used this month.')
        + (until ? (renewalOff ? ' Renewal cancelled; paid access through ' : ' Paid access through ') + until + '.' : '');
    }
    if (accountUpgradeOptionsEl) { accountUpgradeOptionsEl.replaceChildren(); accountUpgradeOptionsEl.hidden = true; }
    if (accountManageActionsEl) accountManageActionsEl.hidden = false;
    if (accountManageBillingBtn) accountManageBillingBtn.disabled = busy;
    return;
  }

  if (accountManageActionsEl) accountManageActionsEl.hidden = true;
  renderFreePlanWords(data);
  const options = ((billing && billing.options) || []).filter(group => (group.plans || []).some(plan => plan.id === 'monthly'));
  // The service places a signed-in account in a price region from the country
  // it first signed in from, and sends only that region's plans. The account
  // sees that one price and no picker. An account it could not place, and the
  // signed-out, keep the picker: India always, everywhere else once it is on
  // sale.
  const placed = account && account.signedIn && ['in', 'global'].includes(account.region) ? account.region : null;
  const regions = placed ? [placed] : ['in', ...(options.some(group => group.region === 'global') ? ['global'] : [])];
  if (!regions.includes(billingRegion)) billingRegion = regions[0];
  document.querySelector('.billing-region-label').hidden = !!placed;
  const signature = JSON.stringify(regions);
  if (billingRegionEl.dataset.options !== signature) {
    billingRegionEl.replaceChildren(...regions.map(region => {
      const option = document.createElement('option'); option.value = region; option.textContent = BILLING_REGION_LABELS[region]; return option;
    }));
    billingRegionEl.dataset.options = signature;
  }
  billingRegionEl.value = billingRegion;
  billingRegionEl.disabled = busy || !!pending;
  syncCustomSelect(billingRegionEl);
  const group = options.find(option => option.region === billingRegion);
  const plan = group && group.plans.find(option => option.id === 'monthly');
  // Before a region's payments open, or where Pro is not sold, its price still
  // shows; the button says it is not available.
  const label = BILLING_PRICES[billingRegion];
  const closed = !!(billing && billing.unavailable === 'country');
  const amount = label.replace(/\s*\/\s*month\s*$/i, '');
  document.getElementById('billing-price-amount').textContent = amount;
  document.getElementById('billing-price-caption').textContent = amount + ' billed every month.';
  // Free costs nothing in the same currency the Pro price is shown in.
  document.getElementById('billing-free-price').textContent = (amount.match(/^[^\d]*/) || [''])[0] + '0';
  const figures = cloudCreditFigures(account, group);
  const offer = figures.welcome > figures.monthly && figures.eligible;
  document.getElementById('billing-welcome').hidden = !offer;
  if (offer) {
    document.getElementById('billing-welcome-credits').textContent = wholeNumber(figures.welcome);
    document.getElementById('billing-welcome-detail').textContent = 'Up to ' + creditHours(figures.welcome)
      + ' of cloud dictation, about ' + creditMinutesPerDay(figures.welcome) + ' a day.';
  }
  benefit.textContent = (offer ? 'Then ' : '') + wholeNumber(figures.monthly) + ' cloud credits every month, up to '
    + creditHours(figures.monthly);
  renderCreditFaq(figures);
  const priceMatches = !!(plan && plan.label === label);
  if (accountUpgradeHintEl) {
    if (pending) {
      accountUpgradeHintEl.textContent = 'Confirming payment. Your plan updates automatically after your payment is verified.';
    } else if (!account || !account.signedIn) {
      accountUpgradeHintEl.textContent = 'Sign in to check availability and upgrade.';
    } else if (!billing || !Array.isArray(billing.options)) {
      accountUpgradeHintEl.textContent = 'Checking availability…';
    } else if (closed) {
      accountUpgradeHintEl.textContent = 'Voxden Pro is not sold in your country yet.';
    } else if (!plan || !priceMatches) {
      accountUpgradeHintEl.textContent = 'Payments for this plan are not open yet.';
    } else {
      accountUpgradeHintEl.textContent = 'Cancel renewal anytime. Your paid access continues through the billing period.';
    }
  }
  if (!accountUpgradeOptionsEl) return;
  accountUpgradeOptionsEl.hidden = false;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'btn-primary';
  const region = billingRegion;
  const provider = (group && group.provider) || 'razorpay';
  button.dataset.provider = provider;
  button.dataset.region = region;
  button.dataset.plan = 'monthly';
  const signedIn = !!(account && account.signedIn);
  const purchasable = !!(plan && priceMatches) && !closed;
  button.disabled = !account || busy || !!pending || (signedIn && !purchasable);
  button.textContent = pending ? 'Confirming payment…' : signedIn ? (purchasable ? 'Get Pro' : 'Not available yet') : 'Sign in to upgrade';
  button.addEventListener('click', () => {
    if (!signedIn) { setSettingsCat('account'); if (accountEmailInput) accountEmailInput.focus(); return; }
    accountAction(button, () => window.voxden.accountCheckout(provider, 'monthly', region));
  });
  accountUpgradeOptionsEl.replaceChildren(button);
}

if (billingRegionEl) billingRegionEl.addEventListener('change', () => {
  billingRegion = billingRegionEl.value;
  if (billingViewData) renderAccountUpgrade(billingViewData);
});
document.getElementById('account-open-billing').addEventListener('click', () => setSettingsCat('billing'));

// --- Manage subscription -----------------------------------------------------
// The facts of the plan in one place, and the way to stop it renewing. The
// paid period stays paid; only the next charge is cancelled.
const subscriptionDialog = document.getElementById('subscription-dialog');
const subscriptionEls = {
  lead: document.getElementById('subscription-lead'),
  price: document.getElementById('subscription-price'),
  through: document.getElementById('subscription-through'),
  renewal: document.getElementById('subscription-renewal'),
  credits: document.getElementById('subscription-credits'),
  provider: document.getElementById('subscription-provider'),
  email: document.getElementById('subscription-email'),
  note: document.getElementById('subscription-note'),
  error: document.getElementById('subscription-error'),
  portal: document.getElementById('subscription-portal'),
  cancel: document.getElementById('subscription-cancel'),
  close: document.getElementById('subscription-close'),
};
const PROVIDER_NAMES = { razorpay: 'Razorpay' };
let subscriptionBusy = false;

function subscriptionOf(data) {
  const account = (data && data.account) || null;
  const billing = (account && account.billing) || null;
  return { account, subscription: (billing && billing.subscription) || null };
}

function renderSubscriptionDialog(data) {
  if (!subscriptionDialog || !subscriptionDialog.open) return;
  const { account, subscription } = subscriptionOf(data || lastPayload || {});
  const isPro = !!(account && account.signedIn && account.plan === 'pro');
  const through = formatAccountDate((subscription && subscription.periodEnd) || (account && account.planExpiresAt));
  const renews = !!(subscription && subscription.renews !== false);
  const knownPrice = (subscription && subscription.label)
    || (subscription && subscription.provider === 'razorpay' ? BILLING_PRICES[account && account.region === 'global' ? 'global' : 'in'] : '');
  subscriptionEls.lead.textContent = isPro
    ? (subscription && subscription.plan === 'annual' ? 'Voxden Pro, billed yearly.' : 'Voxden Pro, billed monthly.')
    : 'No active subscription on this account.';
  subscriptionEls.price.textContent = knownPrice || (isPro ? 'Set by your payment provider' : '—');
  subscriptionEls.through.textContent = through || '—';
  subscriptionEls.renewal.textContent = !isPro ? '—' : (subscription
    ? (renews ? 'Renews automatically' + (through ? ' on ' + through : '') : 'Cancelled. Nothing more will be charged.')
    : 'Managed by your payment provider');
  subscriptionEls.renewal.classList.toggle('is-off', isPro && subscription && !renews);
  const meter = account ? cloudMeterFromAccount(account) : null;
  subscriptionEls.credits.textContent = meter
    ? Math.round(meter.creditsUsed).toLocaleString() + ' of ' + Math.round(meter.creditsCap).toLocaleString() + ' used' + (meter.reset === 'never' ? '' : ' this month')
      + (account.cloud && account.cloud.welcome ? ' · welcome month' : '')
    : (account && account.cloud && Number(account.cloud.hoursCap) ? (Number(account.cloud.hoursUsed) || 0) + ' of ' + account.cloud.hoursCap + ' hours used' : '—');
  subscriptionEls.provider.textContent = subscription ? (PROVIDER_NAMES[subscription.provider] || subscription.provider) : '—';
  subscriptionEls.email.textContent = (account && account.email) || '—';
  subscriptionEls.note.textContent = !isPro ? ''
    : (subscription && !renews
      ? 'You keep everything in Pro until ' + (through || 'the end of the paid period') + '. After that the account goes back to Free on its own.'
      : 'Cancelling stops the next charge only. Everything you paid for stays yours until ' + (through || 'the end of the period') + '.');
  const busy = subscriptionBusy || !!(account && account.busy);
  subscriptionEls.cancel.hidden = !isPro || !subscription || !renews;
  subscriptionEls.cancel.disabled = busy;
  subscriptionEls.portal.hidden = !(subscription && subscription.manageUrl);
  subscriptionEls.portal.disabled = busy;
  const error = account && account.lastError && subscriptionBusy === false && account.busy === '' ? account.lastError : '';
  subscriptionEls.error.hidden = !error;
  subscriptionEls.error.textContent = error;
}

function setSubscriptionError(text) {
  subscriptionEls.error.textContent = text || '';
  subscriptionEls.error.hidden = !text;
}

function openSubscriptionDialog() {
  if (!subscriptionDialog || subscriptionDialog.open) return;
  closeAllCustomSelects();
  setSubscriptionError('');
  subscriptionDialog.showModal();
  renderSubscriptionDialog(lastPayload || {});
  subscriptionEls.close.focus();
  // The facts come from the service, so ask it while the dialog is up.
  if (window.voxden && window.voxden.accountBilling) {
    window.voxden.accountBilling().then((next) => {
      if (next) render(next);
      renderSubscriptionDialog(next || lastPayload || {});
    }).catch(() => {});
  }
}

async function cancelSubscriptionRenewal() {
  if (subscriptionBusy || !window.voxden || !window.voxden.accountCancelSubscription) return;
  const { account, subscription } = subscriptionOf(lastPayload || {});
  const through = formatAccountDate((subscription && subscription.periodEnd) || (account && account.planExpiresAt));
  const yes = await askConfirm({
    title: 'Cancel renewal?',
    body: 'Voxden Pro stays on until ' + (through || 'the end of the paid period') + ', then the account returns to Free. Nothing more is charged.',
    confirmLabel: 'Cancel renewal',
  });
  if (!yes || !subscriptionDialog.open) return;
  subscriptionBusy = true;
  setSubscriptionError('');
  renderSubscriptionDialog(lastPayload || {});
  try {
    const next = await window.voxden.accountCancelSubscription();
    if (next) render(next);
    const after = subscriptionOf(next || lastPayload || {});
    if (after.account && after.account.lastError) setSubscriptionError(after.account.lastError);
  } catch (err) {
    setSubscriptionError((err && err.message) || 'Could not cancel right now. Try again.');
  } finally {
    subscriptionBusy = false;
    renderSubscriptionDialog(lastPayload || {});
  }
}

if (accountManageBillingBtn) {
  accountManageBillingBtn.addEventListener('click', openSubscriptionDialog);
}
if (subscriptionDialog) {
  subscriptionEls.close.addEventListener('click', () => subscriptionDialog.close());
  subscriptionDialog.addEventListener('cancel', (event) => { event.preventDefault(); subscriptionDialog.close(); });
  subscriptionEls.cancel.addEventListener('click', cancelSubscriptionRenewal);
  subscriptionEls.portal.addEventListener('click', () => {
    accountAction(subscriptionEls.portal, () => window.voxden.accountManageBilling());
  });
}

function accountAction(button, work) {
  if (!button || button.disabled || !window.voxden) return;
  button.disabled = true;
  Promise.resolve().then(work)
    .then((next) => { if (next) render(next); })
    .catch(() => {})
    .finally(() => { button.disabled = false; });
}

if (accountSendCodeBtn) {
  accountSendCodeBtn.addEventListener('click', () => {
    accountAction(accountSendCodeBtn, () => window.voxden.accountRequestCode(accountEmailInput ? accountEmailInput.value : ''));
  });
}
if (accountEmailInput) {
  accountEmailInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && accountSendCodeBtn) accountSendCodeBtn.click();
  });
}
if (accountVerifyBtn) {
  accountVerifyBtn.addEventListener('click', () => {
    accountAction(accountVerifyBtn, () => window.voxden.accountVerifyCode('', accountCodeInput ? accountCodeInput.value : '')
      .then((next) => {
        if (next && next.account && next.account.signedIn && accountCodeInput) accountCodeInput.value = '';
        return next;
      }));
  });
}
if (accountCodeInput) {
  accountCodeInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && accountVerifyBtn) accountVerifyBtn.click();
  });
}
if (accountPendingBackBtn) {
  accountPendingBackBtn.addEventListener('click', () => {
    accountAction(accountPendingBackBtn, () => window.voxden.accountCancel());
  });
}
if (accountRefreshBtn) {
  accountRefreshBtn.addEventListener('click', () => {
    accountAction(accountRefreshBtn, () => window.voxden.accountRefresh());
  });
}
if (accountSignOutBtn) {
  accountSignOutBtn.addEventListener('click', () => {
    accountAction(accountSignOutBtn, () => window.voxden.accountSignOut());
  });
}

// Why Voxden Cloud did not take the last dictation, shown on the Voxden Cloud card.
const CLOUD_SKIP_REASONS = {
  timeout: 'Voxden Cloud waited too long to respond. Retry the dictation.',
  network: 'Voxden Cloud could not be reached. Check your connection and retry.',
  upstream: 'Voxden Cloud could not transcribe the last dictation. Try again.',
  auth: 'The cloud did not accept this sign-in. Sign in again under Account.',
  plan: 'Voxden Cloud dictation needs a Pro account.',
  cap: 'Your cloud credits are used up.',
  'signed-out': 'Sign in under Account to use Voxden Cloud dictation.',
  unconfigured: 'Voxden Cloud is not configured on the service.',
};

// Settings > Speech engines > How Voxden listens. Two radio cards writing the
// one cloudTranscription boolean. Voxden Cloud can be chosen only on a Pro
// account, but a Cloud setting left on after the plan lapsed stays selectable
// so it can be turned off.
function renderListenMode(data) {
  if (!speechModeLocalEl || !speechModeCloudEl) return;
  const account = data.account || null;
  const pro = !!(account && account.signedIn && account.plan === 'pro');
  const enabled = data.cloudTranscription === true;
  const on = pendingListenMode !== null ? pendingListenMode : enabled;
  speechModeLocalEl.setAttribute('aria-checked', on ? 'false' : 'true');
  speechModeLocalEl.tabIndex = on ? -1 : 0;
  speechModeCloudEl.setAttribute('aria-checked', on ? 'true' : 'false');
  speechModeCloudEl.tabIndex = on ? 0 : -1;
  if (!pro && !enabled) speechModeCloudEl.setAttribute('aria-disabled', 'true');
  else speechModeCloudEl.removeAttribute('aria-disabled');
  speechShow(speechModeBadgeEl, !pro);
  let credits = '';
  if (pro) {
    const meter = cloudMeterFromAccount(account);
    const cloud = account.cloud || {};
    credits = meter
      ? Math.round(meter.creditsUsed).toLocaleString() + ' of ' + Math.round(meter.creditsCap).toLocaleString()
        + ' cloud credits used' + (meter.reset === 'never' ? '.' : ' this month.')
      : (Number(cloud.hoursUsed) || 0) + ' of ' + (Number(cloud.hoursCap) || 0) + ' hours used this month.';
  }
  speechSetText(speechModeCreditsEl, credits);
  speechShow(speechModeCreditsEl, !!credits);
  const status = data.cloudStatus || {};
  const error = enabled && status.lastError && !['cloud', 'cloud-segments'].includes(status.lastResult)
    ? (CLOUD_SKIP_REASONS[status.lastError] || ('Voxden Cloud could not finish the dictation (' + status.lastError + ').'))
    : '';
  speechSetText(speechModeErrorEl, error);
  speechShow(speechModeErrorEl, !!error);
  const described = [!pro && 'speech-mode-cloud-badge', 'speech-mode-cloud-line', credits && 'speech-mode-cloud-credits', error && 'speech-mode-cloud-error']
    .filter(Boolean).join(' ');
  if (speechModeCloudEl.getAttribute('aria-describedby') !== described) speechModeCloudEl.setAttribute('aria-describedby', described);
}

function speechCloudSelectable(data) {
  const account = data.account || null;
  return !!(account && account.signedIn && account.plan === 'pro') || data.cloudTranscription === true;
}
function pickListenMode(mode) {
  const data = lastPayload || {};
  const on = mode === 'cloud';
  const current = pendingListenMode !== null ? pendingListenMode : data.cloudTranscription === true;
  if (on === current) return;
  if (on && !speechCloudSelectable(data)) return;
  pendingListenMode = on;
  renderListenMode(data);
  saveListenMode();
}
// Same serial save as saveFlowStyle: only the latest choice is kept while a
// save is in flight, so quick arrow keys cannot persist an earlier one last.
async function saveListenMode() {
  if (savingListenMode) return;
  savingListenMode = true;
  while (pendingListenMode !== null) {
    const value = pendingListenMode;
    await patchSettings({ cloudTranscription: value });
    if (pendingListenMode !== value) continue;
    pendingListenMode = null;
  }
  savingListenMode = false;
  render();
}
speechModeLocalEl.addEventListener('click', () => pickListenMode('local'));
speechModeCloudEl.addEventListener('click', () => { if (!speechIsDisabled(speechModeCloudEl)) pickListenMode('cloud'); });
// Roving tabindex, like the flow-style cards. Arrowing onto a card that needs
// Pro moves focus there, so it is read out, without selecting it.
speechModeOptionsEl.addEventListener('keydown', (event) => {
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
  const cards = [speechModeLocalEl, speechModeCloudEl];
  const current = cards.indexOf(document.activeElement);
  if (current < 0) return;
  event.preventDefault();
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? cards.length - 1
    : (current + (event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : -1) + cards.length) % cards.length;
  cards[next].focus();
  if (!speechIsDisabled(cards[next])) pickListenMode(cards[next].dataset.listen);
});

// Dictation languages come from the main-process snapshot (the cloud menu plus
// Hinglish). The renderer cannot require asr.js, so names live on the payload.
const FALLBACK_DICTATION_LANGUAGES = Object.freeze([
  { id: 'en', name: 'English', native: 'English', engine: 'en' },
]);
const dictationLangOpenBtn = document.getElementById('dictation-lang-open');
const dictationLangDialog = document.getElementById('dictation-lang-dialog');
const dictationLangGridEl = document.getElementById('dictation-lang-grid');
const dictationLangSearchEl = document.getElementById('dictation-lang-search');
const dictationLangSelectedEl = document.getElementById('dictation-lang-selected');
const dictationLangErrorEl = document.getElementById('dictation-lang-error');
const dictationLangSaveBtn = document.getElementById('dictation-lang-save');
const dictationLangCancelBtn = document.getElementById('dictation-lang-cancel');
const dictationLangHintEl = document.getElementById('dictation-lang-hint');
// What the picker holds while it is open; saved only on Save and close.
let dictationLangDraft = null;
let dictationLangTilesSignature = '';

function dictationLanguageCatalog(data) {
  const list = data && Array.isArray(data.dictationLanguageCatalog) && data.dictationLanguageCatalog.length
    ? data.dictationLanguageCatalog
    : (data && Array.isArray(data.dictationLanguageOffered) && data.dictationLanguageOffered.length
      ? data.dictationLanguageOffered
      : FALLBACK_DICTATION_LANGUAGES);
  return list;
}

function dictationLanguageById(data, id) {
  return dictationLanguageCatalog(data).find((l) => l.id === id) || null;
}

function dictationLanguageLabel(data, id) {
  const found = dictationLanguageById(data, id);
  return found ? found.name : 'English';
}

function dictationLanguagesUnlocked(data) {
  return !!(data && data.dictationLanguageUnlocked);
}

function dictationLanguageMax(data) {
  const n = Number(data && data.dictationLanguageMax);
  return n > 0 ? n : (dictationLanguagesUnlocked(data) ? 3 : 1);
}

function offeredDictationLanguageList(data) {
  const offered = data && Array.isArray(data.dictationLanguageOffered) && data.dictationLanguageOffered.length
    ? data.dictationLanguageOffered
    : (dictationLanguagesUnlocked(data) ? dictationLanguageCatalog(data) : FALLBACK_DICTATION_LANGUAGES);
  return offered;
}

// The list as the main process sent it, or the scalar from an older
// snapshot as a list of one.
function selectedDictationLanguages(data) {
  const known = new Set(dictationLanguageCatalog(data).map((l) => l.id));
  const list = Array.isArray(data.dictationLanguages) && data.dictationLanguages.length
    ? data.dictationLanguages
    : [data.dictationLanguage || 'en'];
  const out = list.map((id) => String(id || '').trim().toLowerCase()).filter((id) => known.has(id));
  return out.length ? out : ['en'];
}

function languageListText(ids, data) {
  const names = ids.map((id) => dictationLanguageLabel(data || lastPayload || {}, id));
  return names.length > 1 ? names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1] : (names[0] || '');
}

function ensureDictationLangTiles(data) {
  if (!dictationLangGridEl) return;
  const offered = offeredDictationLanguageList(data);
  const sig = offered.map((l) => l.id).join(',') + ':' + (dictationLanguagesUnlocked(data) ? '1' : '0');
  if (sig === dictationLangTilesSignature && dictationLangGridEl.childElementCount) return;
  dictationLangTilesSignature = sig;
  const tiles = offered.map((lang) => {
    const tile = document.createElement('button');
    tile.type = 'button';
    tile.className = 'lang-tile';
    tile.dataset.lang = lang.id;
    tile.setAttribute('aria-pressed', 'false');
    const name = document.createElement('span');
    name.className = 'lang-tile-name';
    name.textContent = lang.name;
    tile.append(name);
    if (lang.native && lang.native !== lang.name) {
      const native = document.createElement('span');
      native.className = 'lang-tile-native';
      native.textContent = lang.native;
      tile.append(native);
    }
    return tile;
  });
  dictationLangGridEl.replaceChildren(...tiles);
}

function applyDictationLangSearch() {
  if (!dictationLangGridEl) return;
  const q = String(dictationLangSearchEl && dictationLangSearchEl.value || '').trim().toLowerCase();
  for (const tile of dictationLangGridEl.querySelectorAll('[data-lang]')) {
    if (!q) {
      tile.classList.remove('is-hidden');
      continue;
    }
    const id = tile.dataset.lang;
    const name = (tile.querySelector('.lang-tile-name') || {}).textContent || '';
    const native = (tile.querySelector('.lang-tile-native') || {}).textContent || '';
    const hit = id === q || name.toLowerCase().includes(q) || native.toLowerCase().includes(q);
    tile.classList.toggle('is-hidden', !hit);
  }
}

function renderDictationLanguages(data) {
  const unlocked = dictationLanguagesUnlocked(data);
  const chosen = selectedDictationLanguages(data);
  ensureDictationLangTiles(data);
  renderDictationLanguageHint(data);
  if (dictationLangOpenBtn) {
    dictationLangOpenBtn.disabled = !unlocked;
    dictationLangOpenBtn.textContent = unlocked
      ? chosen.map((id) => dictationLanguageLabel(data, id)).join(', ')
      : 'English';
    dictationLangOpenBtn.title = unlocked && chosen.length > 1
      ? 'Main language ' + dictationLanguageLabel(data, chosen[0])
      : (unlocked ? '' : dictationLangHintEl ? dictationLangHintEl.textContent : '');
  }
}

function renderDictationLangDialog() {
  const data = lastPayload || {};
  const draft = dictationLangDraft || [];
  const max = dictationLanguageMax(data);
  const full = draft.length >= max;
  ensureDictationLangTiles(data);
  applyDictationLangSearch();
  if (dictationLangGridEl) {
    for (const tile of dictationLangGridEl.querySelectorAll('[data-lang]')) {
      const id = tile.dataset.lang;
      const on = draft.includes(id);
      const twin = id === 'hi' ? 'hg' : id === 'hg' ? 'hi' : null;
      tile.setAttribute('aria-pressed', on ? 'true' : 'false');
      tile.disabled = !on && full && !(twin && draft.includes(twin));
    }
  }
  if (dictationLangSelectedEl) {
    const rows = draft.map((id, index) => {
      const row = document.createElement('li');
      const name = document.createElement('span');
      name.textContent = dictationLanguageLabel(data, id);
      if (index === 0 && draft.length > 1) {
        const tag = document.createElement('small');
        tag.textContent = 'main';
        name.append(tag);
      }
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.dataset.remove = id;
      remove.setAttribute('aria-label', 'Remove ' + dictationLanguageLabel(data, id));
      remove.textContent = '−';
      row.append(name, remove);
      return row;
    });
    if (!rows.length) {
      const empty = document.createElement('li');
      empty.className = 'lang-selected-empty';
      empty.textContent = 'Nothing picked yet.';
      rows.push(empty);
    }
    dictationLangSelectedEl.replaceChildren(...rows);
  }
  if (dictationLangErrorEl) {
    dictationLangErrorEl.hidden = true;
    dictationLangErrorEl.textContent = '';
  }
}

function openDictationLangDialog() {
  if (!dictationLangDialog || dictationLangDialog.open) return;
  if (!dictationLanguagesUnlocked(lastPayload || {})) return;
  closeAllCustomSelects();
  dictationLangDraft = selectedDictationLanguages(lastPayload || {});
  if (dictationLangSearchEl) dictationLangSearchEl.value = '';
  renderDictationLangDialog();
  dictationLangDialog.showModal();
  if (dictationLangSearchEl) dictationLangSearchEl.focus();
  else if (dictationLangSaveBtn) dictationLangSaveBtn.focus();
}

function closeDictationLangDialog(restoreFocus = true) {
  if (!dictationLangDialog || !dictationLangDialog.open) return;
  dictationLangDialog.close();
  dictationLangDraft = null;
  if (restoreFocus && settingsOpen && dictationLangOpenBtn) dictationLangOpenBtn.focus({ preventScroll: true });
}

// Toggle one language in the draft. Hindi and Hinglish are one language to
// the engine, so picking one replaces the other.
function toggleDictationLangDraft(id) {
  const draft = dictationLangDraft || [];
  const max = dictationLanguageMax(lastPayload || {});
  if (draft.includes(id)) {
    dictationLangDraft = draft.filter((x) => x !== id);
  } else {
    const twin = id === 'hi' ? 'hg' : id === 'hg' ? 'hi' : null;
    const without = twin ? draft.filter((x) => x !== twin) : draft;
    if (without.length >= max) return;
    dictationLangDraft = without.concat(id);
  }
  renderDictationLangDialog();
}

function renderDictationLanguageHint(data) {
  if (!dictationLangHintEl) return;
  const account = data.account || null;
  const pro = !!(account && account.signedIn && account.plan === 'pro');
  const unlocked = dictationLanguagesUnlocked(data);
  const chosen = selectedDictationLanguages(data);
  const extras = chosen.filter((id) => id !== 'en');
  let hint;
  if (unlocked) {
    hint = 'Choose up to three languages for cloud dictation.';
    if (chosen.length > 1) {
      hint = 'Auto-detected. Main language: ' + dictationLanguageLabel(data, chosen[0]) + '.';
    }
    if (chosen.includes('hg')) hint += ' Hindi is written in English letters.';
  } else if (pro) {
    hint = extras.length
      ? 'Local dictation is English. Turn on Voxden Cloud to use ' + languageListText(extras, data) + '.'
      : 'Local dictation is English. More languages with Voxden Cloud.';
  } else {
    hint = 'English on ' + thisDevice() + '. More with Voxden Cloud on Pro.';
  }
  dictationLangHintEl.textContent = hint;
}

function qwenAccelKind(plan) {
  return plan && plan.recommendedPack === 'rocm' ? 'rocm' : 'cuda';
}

// Under CPU only the Qwen plan returns before its hardware checks, so its
// `supported` says only that the vendor could work. Whether Auto would really
// offer the card mirrors resolve() in qwen-accel.js: AMD needs Windows 11, and
// NVIDIA needs the catalog's minimum driver (qwen-accel-catalog.json
// cuda.minNvidiaDriver) unless the version is unreadable or in Windows DCH
// numbering, which the engine's own probe decides. main.js passes no VRAM.
const SPEECH_QWEN_MIN_NVIDIA_DRIVER = 570;
function speechQwenGpuUsable(plan, kind) {
  if (!plan.supported) return false;
  if (kind === 'rocm') return plan.windows11 !== false;
  const version = String(plan.driverVersion || '').trim();
  const match = /(\d+)(?:\.(\d+))?/.exec(version);
  const have = match ? (Number(match[1]) || 0) + (Number(match[2]) || 0) / 1000 : 0;
  if (!have || (have < 100 && version.split('.').length >= 4)) return true;
  return have + 1e-9 >= SPEECH_QWEN_MIN_NVIDIA_DRIVER;
}

// Settings > Speech engines > Speed up with your GPU. One row, shown only when
// a download or a setting would move the model in use onto the graphics card,
// or while a GPU download runs. Each pack speeds up one model: the cuBLAS pack
// is CTranslate2's (both Whispers), the Qwen packs are Qwen's. Parakeet on an
// AMD or Intel card is never offered here; that stays behind Advanced >
// Processor. Returns what to draw, or null to hide the row. First match wins.
function speechGpuModel(data) {
  // No packs on this platform means no row: an Apple GPU is already what the
  // model runs on, and there is nothing to download to get there.
  if (!gpuPacksOffered(data)) return null;
  const engine = asrEngineId(data.asrEngine);
  const device = speechDevice(data);
  const gpu = data.gpu || {};
  const cudaState = data.cudaPackState || {};
  const qPlan = data.qwenAccel || {};
  const kind = qwenAccelKind(qPlan);
  const qPack = (kind === 'rocm' ? data.qwenRocmPack : data.qwenCudaPack) || {};
  const qState = (kind === 'rocm' ? data.qwenRocmPackState : data.qwenCudaPackState) || {};
  const vendor = kind === 'rocm' ? 'AMD GPU' : 'NVIDIA GPU';
  const whisperName = engine === 'whisper-turbo' ? 'Whisper large-v3 turbo' : 'Whisper large-v3';
  const cudaSize = (data.cudaPack && data.cudaPack.downloadSize) || '553 MB';
  const whisperOffer = 'Your NVIDIA GPU can run ' + whisperName + ' after a one-time ' + cudaSize + ' download.';
  // The live size from the release listing, never the catalog estimate: while
  // it is unknown the sentence leaves the number out.
  const qSize = qPack.downloadSize || '';
  const qwenOffer = 'Your ' + vendor + ' can run Qwen3-ASR after a one-time ' + (qSize ? qSize + ' ' : '') + 'download.';
  const qwenFallback = 'Your GPU stopped working with Qwen3-ASR, so it is using the processor.';
  const packError = (s) => (['error', 'cancelled'].includes(s.status) && s.message
    ? { error: s.message, errorIsError: s.status === 'error' } : {});

  // A running pack download is always drawn, so its Cancel stays reachable.
  // The NVIDIA pack leaves the engine running, unless a model download has
  // paused it meanwhile (the Model notice says so).
  if (speechPackBusy(cudaState)) {
    return { hint: whisperOffer, progress: speechPercent(cudaState.progress),
      note: data.asrOperation ? '' : 'You can keep dictating while it downloads.', action: 'cuda-cancel', label: 'Cancel' };
  }
  const qwenBusy = { hint: qPlan.uiStatus === 'fallback' ? qwenFallback : qwenOffer,
    note: 'Dictation on ' + thisDevice() + ' is paused until this download finishes.', action: 'qwen-cancel', kind, label: 'Cancel' };
  if (speechPackBusy(qState)) return { ...qwenBusy, progress: speechPercent(qState.progress) };
  // 'gpu-install' is only ever a Qwen pack. It takes the engine lock at the
  // click, but the pack reports nothing until the speech process has stopped,
  // so the row stays with its button in place; Cancel has nothing to stop yet.
  if (data.asrOperation === 'gpu-install') return { ...qwenBusy, progress: 0, waiting: true };
  if (data.cloudTranscription === true || data.asrOperation) return null;
  const rowState = speechRowState(data, engine);
  if (rowState !== 'in-use' && rowState !== 'loading') return null;

  if (usesCtranslate2(engine) && gpu.vendor === 'nvidia') {
    if (device === 'cpu' || device === 'directml') {
      return { hint: 'Your processor setting keeps Whisper off your NVIDIA GPU.', action: 'use-gpu', label: 'Use NVIDIA GPU' };
    }
    if (gpu.needsPack) return { hint: whisperOffer, action: 'cuda-install', label: 'Download ' + cudaSize, ...packError(cudaState) };
    if (data.engineStatus === 'ready' && data.device !== 'cuda' && !speechCudaRestartPending) {
      return { hint: 'Your NVIDIA GPU could not run Whisper, so it is using the processor.', hintError: true };
    }
    return null;
  }
  if (engine === 'qwen3-asr' && qPlan.vendor && qPlan.recommendedPack && qPlan.uiStatus !== 'hidden') {
    if (device === 'cpu') {
      return speechQwenGpuUsable(qPlan, kind)
        ? { hint: 'Your processor setting keeps Qwen3-ASR off your ' + vendor + '.', action: 'use-gpu', label: 'Use ' + vendor }
        : null;
    }
    if (qPlan.uiStatus === 'fallback') {
      return { hint: qwenFallback, hintError: true, action: 'qwen-retry', label: 'Try GPU again', ...packError(qState) };
    }
    if (qPlan.uiStatus === 'offer' && !qPack.installed) {
      const checking = qPack.downloadSizeStatus === 'idle' || qPack.downloadSizeStatus === 'checking';
      return { hint: qwenOffer,
        note: qSize ? '' : (checking ? 'Checking download size…' : 'Download size is temporarily unavailable.'),
        action: 'qwen-install', kind, label: qSize ? 'Download ' + qSize : 'Download', refreshSize: kind, ...packError(qState) };
    }
  }
  return null;
}

function renderSpeechGpuRow(data) {
  if (!speechGpuRowEl) return;
  const m = speechGpuModel(data);
  const hadFocus = speechGpuRowEl.contains(document.activeElement);
  speechShow(speechGpuRowEl, !!m);
  if (!m) { if (hadFocus) speechModelListEl.focus({ preventScroll: true }); return; }
  if (m.refreshSize) speechRefreshQwenSize(data, m.refreshSize);
  speechSetText(speechGpuHintEl, m.hint || '');
  speechGpuHintEl.classList.toggle('is-error', !!m.hintError);
  const hasBar = m.progress != null;
  speechShow(speechGpuProgressRowEl, hasBar);
  if (hasBar) {
    if (speechGpuProgressFillEl.style.width !== m.progress + '%') speechGpuProgressFillEl.style.width = m.progress + '%';
    if (speechGpuProgressEl.getAttribute('aria-valuenow') !== String(m.progress)) speechGpuProgressEl.setAttribute('aria-valuenow', String(m.progress));
    speechSetText(speechGpuProgressLabelEl, m.progress + '%');
  }
  speechSetText(speechGpuNoteEl, m.note || '');
  speechShow(speechGpuNoteEl, !!m.note);
  speechSetText(speechGpuErrorEl, m.error || '');
  speechGpuErrorEl.classList.toggle('is-error', !!m.errorIsError);
  speechShow(speechGpuErrorEl, !!m.error);
  const btn = speechGpuActionBtn;
  if (!m.action) {
    speechShow(btn, false);
    if (hadFocus && btn === document.activeElement) speechModelListEl.focus({ preventScroll: true });
    return;
  }
  if (btn.dataset.action !== m.action) {
    if (m.action.endsWith('-cancel')) speechArmedAt.set('gpu', Date.now() + SPEECH_ARM_MS);
    btn.dataset.action = m.action;
  }
  if (btn.dataset.kind !== (m.kind || '')) btn.dataset.kind = m.kind || '';
  const pending = speechPending.has('gpu:' + m.action);
  speechSetText(btn, m.action.endsWith('-cancel') && pending ? 'Cancelling…' : m.label);
  speechSetDisabled(btn, pending || !!m.waiting || (['qwen-install', 'qwen-retry'].includes(m.action) && !!data.asrOperation));
  speechShow(btn, true);
}

// One size lookup per pack kind at a time, however often render runs; a
// failed lookup is retried only after the delay the payload carries.
function speechRefreshQwenSize(data, kind) {
  const pack = (kind === 'rocm' ? data.qwenRocmPack : data.qwenCudaPack) || {};
  if (qwenAccelInfoRequests.has(kind) || !window.voxden || !window.voxden.refreshQwenAccelInfo) return;
  if (pack.downloadSizeStatus === 'idle'
      || (pack.downloadSizeStatus !== 'checking' && Number.isFinite(pack.downloadSizeRefreshAt)
        && Date.now() >= pack.downloadSizeRefreshAt)) {
    qwenAccelInfoRequests.add(kind);
    window.voxden.refreshQwenAccelInfo(kind).then((next) => { if (next) render(next); })
      .catch(() => {}).finally(() => qwenAccelInfoRequests.delete(kind));
  }
}

// A hidden dashboard receives no snapshots, so the engine may restart unseen;
// the next visible snapshot is then trusted as it stands.
document.addEventListener('visibilitychange', () => { if (document.hidden) speechCudaRestartPending = false; });

speechGpuActionBtn.addEventListener('click', () => {
  const btn = speechGpuActionBtn;
  if (speechIsDisabled(btn)) return;
  const action = btn.dataset.action;
  const kind = btn.dataset.kind === 'rocm' ? 'rocm' : 'cuda';
  const key = 'gpu:' + action;
  if (action.endsWith('-cancel') && Date.now() < (speechArmedAt.get('gpu') || 0)) return;
  if (speechPending.has(key) || !window.voxden) return;
  const calls = {
    'cuda-install': () => window.voxden.installCudaPack(),
    'cuda-cancel': () => window.voxden.cancelCudaPack(),
    'qwen-install': () => window.voxden.installQwenAccel(kind),
    'qwen-cancel': () => window.voxden.cancelQwenAccel(kind),
    'qwen-retry': () => window.voxden.retryQwenAccel(),
    'use-gpu': () => patchSettings({ asrDevice: 'auto' }),
  };
  if (!calls[action]) return;
  speechDismissError(lastPayload);
  speechPending.add(key);
  render();
  Promise.resolve().then(calls[action])
    .then((next) => { if (next && action !== 'use-gpu') render(next); })
    .catch(() => {})
    // A cancel stays pending until the pack stops being busy (renderSpeechEngines).
    .finally(() => { if (!action.endsWith('-cancel')) speechPending.delete(key); render(); });
});

// The privacy row's hint carries the live count, so "kept for 14 days" is
// followed by what that currently amounts to on this PC.
const RECORDINGS_HINT = 'Keeps the audio behind each dictation for 14 days (up to 500 MB)'
  + ' so you can replay, save, or retry it, and recover the ones that failed to transcribe.';

function renderRecordingsHint(data) {
  if (!recordingsHintEl) return;
  const r = data.recordings || {};
  const count = Number(r.count) || 0;
  recordingsClearBtn.disabled = clearingRecordings || (count < 1 && !data.canRetry);
  recordingsClearBtn.textContent = clearingRecordings ? 'Deleting…' : 'Delete';
  if (data.recordingsError) {
    recordingsHintEl.textContent = data.recordingsError;
    recordingsClearBtn.disabled = clearingRecordings;
    return;
  }
  if (data.keepRecordings === false) {
    recordingsHintEl.textContent = RECORDINGS_HINT
      + ' Off: nothing is kept, and a failed dictation cannot be recovered.';
    return;
  }
  recordingsHintEl.textContent = count
    ? RECORDINGS_HINT + ' Keeping ' + count + (count === 1 ? ' recording' : ' recordings')
      + ' · ' + formatBytes(r.bytes) + '.'
    : RECORDINGS_HINT + ' No saved recordings.';
}

function renderTraining(data) {
  if (!trainingRowEl) return;
  const on = !!data.keepTrainingAudio;
  const t = data.training || {};
  const pairs = Number(t.pairs) || 0;
  trainingRowEl.hidden = !on && pairs < 1 && !data.trainingError;
  if (trainingClearBtn) trainingClearBtn.disabled = pairs < 1 && !(Number(t.pending) || 0) && !data.trainingError;
  if (!trainingStatsEl) return;
  if (data.trainingError) { trainingStatsEl.textContent = data.trainingError; return; }
  if (!pairs) {
    trainingStatsEl.textContent = on
      ? (suggestionsOn(data)
        ? 'Nothing collected yet. Correct a dictation and its recording is kept as a training pair.'
        : 'Nothing collected yet.')
      : 'Recording is off.';
    return;
  }
  trainingStatsEl.textContent = pairs + (pairs === 1 ? ' corrected clip' : ' corrected clips')
    + ' · ' + formatClipTime(t.seconds) + ' of audio · ' + formatBytes(t.bytes);
}

function renderSidebar(data) {
  if (data && typeof data.sidebarCollapsed === 'boolean') {
    // A snapshot sent before main saw the latest toggle still carries the old
    // state; the click wins until the save has landed.
    if (sidebarSaving) data.sidebarCollapsed = sidebarCollapsed;
    else sidebarCollapsed = data.sidebarCollapsed;
  }
  if (sidebarEl) sidebarEl.classList.toggle('is-collapsed', sidebarCollapsed);
  if (!sidebarToggleEl) return;
  sidebarToggleEl.setAttribute('aria-expanded', sidebarCollapsed ? 'false' : 'true');
  sidebarToggleEl.setAttribute(
    'aria-label',
    sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'
  );
  sidebarToggleEl.title = sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar';
  const label = sidebarToggleEl.querySelector('.nav-label');
  if (label) label.textContent = sidebarCollapsed ? 'Expand' : 'Collapse';
}

function cloudMeterFromAccount(account) {
  const cloud = account && account.cloud;
  if (!cloud) return null;
  const creditsCap = Number(cloud.creditsCap);
  if (creditsCap > 0) {
    const creditsUsed = Math.max(0, Number(cloud.creditsUsed) || 0);
    return {
      creditsUsed,
      creditsCap,
      creditsRemaining: Math.max(0, Number(cloud.creditsRemaining != null
        ? cloud.creditsRemaining
        : creditsCap - creditsUsed)),
      reset: cloud.reset === 'never' ? 'never' : 'month',
    };
  }
  const hoursCap = Number(cloud.hoursCap);
  if (!(hoursCap > 0)) return null;
  const hoursUsed = Math.max(0, Number(cloud.hoursUsed) || 0);
  const cap = Math.round(hoursCap * 60);
  const used = Math.round(hoursUsed * 60 * 100) / 100;
  return {
    creditsUsed: used,
    creditsCap: cap,
    creditsRemaining: Math.max(0, Math.round((cap - used) * 100) / 100),
    reset: cloud.periodEnd ? 'month' : 'never',
  };
}

function creditTone(percent) {
  if (percent >= 95) return 'critical';
  if (percent >= 90) return 'high';
  if (percent >= 75) return 'warn';
  return 'ok';
}

function wholeNumber(value) {
  return Math.max(0, Math.round(Number(value) || 0)).toLocaleString();
}

// The free plan's week, as main.js measured it. Null on Pro, which is metered
// in cloud credits instead, and null before the first snapshot arrives.
function freeWordMeter(data) {
  const meter = data && data.freeWords;
  return meter && Number(meter.cap) > 0 ? meter : null;
}

// A credit is a minute of cloud dictation, so the balance reads as time. It
// rounds down: "13 h" must never promise more than is there. Under an hour it
// counts minutes.
function cloudTimeLeft(creditsRemaining) {
  const minutes = Math.max(0, Math.floor(Number(creditsRemaining) || 0));
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    return { figure: hours.toLocaleString() + ' h', mini: hours.toLocaleString() + 'h',
      spoken: 'About ' + hours.toLocaleString() + (hours === 1 ? ' hour' : ' hours') };
  }
  return { figure: minutes + ' min', mini: minutes + 'm',
    spoken: minutes + (minutes === 1 ? ' minute' : ' minutes') };
}

function compactCount(value) {
  const n = Math.max(0, Math.round(Number(value) || 0));
  if (n < 1000) return String(n);
  return (Math.floor(n / 100) / 10).toLocaleString() + 'k';
}

// One widget for both plans: cloud time counting down on Pro (with the credits
// behind it in small print), the week's words on Free. Both open Plans &
// billing, and both use the same hairline and the same warning tones. The
// closed rail shows the short form in the nav column.
function renderCloudCredits(data) {
  const el = document.getElementById('sidebar-credits');
  const count = document.getElementById('sidebar-credits-count');
  const kicker = document.getElementById('sidebar-credits-kicker');
  const detail = document.getElementById('sidebar-credits-detail');
  const mini = document.getElementById('sidebar-credits-mini');
  if (!el) return;
  const account = data && data.account;
  const signedIn = !!(account && account.signedIn);
  const cloud = signedIn && account.plan === 'pro' ? cloudMeterFromAccount(account) : null;
  const words = signedIn && !cloud ? freeWordMeter(data) : null;
  if (!cloud && !words) {
    el.hidden = true;
    return;
  }
  const percent = cloud
    ? (cloud.creditsCap > 0 ? Math.min(100, Math.max(0, (cloud.creditsUsed / cloud.creditsCap) * 100)) : 0)
    : Math.min(100, Math.max(0, Number(words.percent) || 0));
  const left = cloud ? wholeNumber(cloud.creditsRemaining) : wholeNumber(words.remaining);
  const cap = cloud ? wholeNumber(cloud.creditsCap) : wholeNumber(words.cap);
  const time = cloud ? cloudTimeLeft(cloud.creditsRemaining) : null;
  const tone = creditTone(percent);
  el.hidden = false;
  el.classList.toggle('is-words', !cloud);
  el.classList.toggle('is-warn', tone === 'warn');
  el.classList.toggle('is-high', tone === 'high');
  el.classList.toggle('is-critical', tone === 'critical');
  el.title = cloud
    ? left + ' cloud credits left'
    : left + ' of ' + cap + ' free words left this week'
      + (words.resetsOn ? '. They come back on ' + words.resetsOn : '');
  el.setAttribute('aria-label', cloud
    ? time.spoken + ' of cloud dictation left, ' + left + ' of ' + cap + ' credits. Open plans and billing'
    : el.title + '. Open plans and billing');
  if (count) count.textContent = cloud ? time.figure : left;
  if (kicker) {
    kicker.textContent = cloud ? 'of cloud left' : (left === '1' ? 'free word left' : 'free words left');
  }
  if (detail) {
    detail.textContent = cloud
      ? left + ' of ' + cap + (cap === '1' ? ' credit' : ' credits')
      : left + ' of ' + cap + ' words this week';
  }
  if (mini) mini.textContent = cloud ? time.mini : compactCount(words.remaining);
  el.style.setProperty('--credits-left', Math.max(0, 100 - percent) + '%');
}

// Only the rail changes, and it is already easing: re-rendering the whole
// dashboard from the saved snapshot would land in its first frames and stall
// them, so the save is fire-and-forget.
function toggleSidebar() {
  sidebarCollapsed = !sidebarCollapsed;
  lastPayload = Object.assign({}, lastPayload || {}, { sidebarCollapsed });
  renderSidebar({ sidebarCollapsed });
  if (!window.voxden || !window.voxden.setSettings) return;
  sidebarSaving++;
  window.voxden.setSettings({ sidebarCollapsed })
    .catch(() => {})
    .finally(() => { sidebarSaving--; });
}

// Island replaced Classic (and Ribbon before it); only Orb survives from the
// older choices, so every other saved or unknown value shows as Island.
function normalizeFlowStyle(style) {
  return style === 'orb' ? 'orb' : 'island';
}

function renderFlowStyle(data) {
  const selected = pendingFlowStyle || normalizeFlowStyle(data.flowBarStyle);
  for (const card of flowStyleCards) {
    const checked = card.dataset.flowStyle === selected;
    card.setAttribute('aria-checked', checked ? 'true' : 'false');
    card.tabIndex = checked ? 0 : -1;
  }
}

function renderFlowMotionHint() {
  if (!flowMotionHint || !flowMotion) return;
  flowMotionHint.textContent = flowMotion.preference === 'full'
    ? 'Animations are on for the flow bar and its previews.'
    : flowMotion.preference === 'reduced'
      ? 'Decorative motion is reduced. The microphone level still responds to your voice.'
      : flowMotion.systemReduced
        ? (isMacUi()
          ? 'macOS is set to reduce motion. Choose On to animate the flow bar and its previews.'
          : 'Windows animation effects are off. Choose On to animate the flow bar and its previews.')
        : (isMacUi()
          ? 'Follows macOS motion settings. Hover or focus a style to preview.'
          : 'Follows Windows animation effects. Hover or focus a style to preview.');
}

function renderFlowMotion(data) {
  if (!flowMotion) return;
  const choice = pendingFlowMotion === null ? flowMotion.normalizePreference(data.flowBarMotion) : pendingFlowMotion;
  flowMotion.setPreference(choice);
  if (flowMotionSelect) flowMotionSelect.value = choice;
  renderFlowMotionHint();
}
if (flowMotion) flowMotion.addEventListener('change', renderFlowMotionHint);
if (flowMotion) flowMotion.addEventListener('change', () => syncVocabFix());
if (window.matchMedia) {
  window.matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', () => syncVocabFix());
}

function renderSettings(payload) {
  const data = payload || lastPayload || {};
  const mode = data.dictateMode === 'ptt' ? 'ptt' : 'toggle';
  const label = data.shortcutLabel || defaultShortcutLabel();

  modeToggleEl.classList.toggle('active', mode === 'toggle');
  modePttEl.classList.toggle('active', mode === 'ptt');
  modeToggleEl.setAttribute('aria-checked', mode === 'toggle' ? 'true' : 'false');
  modePttEl.setAttribute('aria-checked', mode === 'ptt' ? 'true' : 'false');
  document.getElementById('dictation-mode-hint').textContent = mode === 'ptt'
    ? 'Hold the shortcut to speak. Release to finish.'
    : 'Press once to start, again to stop.';
  document.getElementById('general-shortcut-keys').innerHTML = shortcutKbdHtml(label);
  renderHelpDictateStep(mode, label);
  renderDictationQuality(data);

  shortcutDisplayEl.innerHTML = shortcutKbdHtml(label);
  document.getElementById('home-shortcut-keys').innerHTML = shortcutKbdHtml(label);
  if (pasteLastShortcutDisplayEl) {
    pasteLastShortcutDisplayEl.innerHTML = shortcutKbdHtml(
      data.pasteLastShortcutLabel || defaultPasteShortcutLabel()
    );
  }

  if (settingInputs.launchAtLogin) settingInputs.launchAtLogin.checked = !!data.launchAtLogin;
  if (settingInputs.alwaysShowFlowBar) settingInputs.alwaysShowFlowBar.checked = !!data.alwaysShowFlowBar;
  renderFlowStyle(data);
  renderFlowMotion(data);
  // Only worth offering once there is something to undo -- a bar still at its
  // default has nothing to reset to.
  if (flowBarPositionRow) flowBarPositionRow.hidden = !data.flowBarMoved;
  if (settingInputs.showInTaskbar) settingInputs.showInTaskbar.checked = !!data.showInTaskbar;
  if (settingInputs.soundsEnabled) settingInputs.soundsEnabled.checked = data.soundsEnabled !== false;
  if (settingInputs.muteMusicWhileDictating) {
    settingInputs.muteMusicWhileDictating.checked = data.muteMusicWhileDictating !== false;
  }
  if (settingInputs.suggestionsEnabled) settingInputs.suggestionsEnabled.checked = data.suggestionsEnabled !== false;
  if (settingInputs.autoAddToDictionary) settingInputs.autoAddToDictionary.checked = data.autoAddToDictionary !== false;
  if (settingInputs.keepRecordings) {
    settingInputs.keepRecordings.checked = data.keepRecordings !== false;
  }
  renderRecordingsHint(data);
  if (settingInputs.keepTrainingAudio) {
    settingInputs.keepTrainingAudio.checked = !!data.keepTrainingAudio;
  }
  renderTraining(data);
  renderEngineBanner(data);
  renderSpeechEngines(data);
  renderDictationLanguages(data);
  renderAccount(data);
  renderSidebarAccount(data);
  window.VoxdenSignIn?.render(data, { render });
  window.VoxdenOnboarding?.render(data, { render, openBilling: () => openSettingsTarget('billing') });
  renderAccountUpgrade(data);

  renderMicSelect(data);

  renderUpdateStatus(data);

  renderUnderstanding(data);

  hotkeyNoticeText = data.hotkeyNotice || '';
  if (data.shortcutError) {
    // The rejected chord is never applied, so the row above still shows the
    // shortcut that works -- the message is the only thing telling the user
    // their key press did not take.
    setShortcutHint(data.shortcutError, 'error');
    shortcutHintTimer = setTimeout(restoreShortcutHint, 6000);
  } else if (!capturingShortcutKind) {
    restoreShortcutHint();
  }
}

function voiceProfileMetaText(data, profile) {
  const words = Math.max(0, Number(data.wordCount) || 0);
  const goal = Math.max(0, Number(data.understandingGoal) || 2500);
  const profileName = data.understandingProfileName || 'Learning';
  if (data.understandingMaxed) {
    return words.toLocaleString() + ' words · ' + profileName + ' profile active';
  }
  const nextName = data.understandingNextProfileName || 'Personalized';
  return Math.max(0, goal - words).toLocaleString() + ' words until ' + nextName;
}

function renderUnderstanding(data) {
  const pct = data.understandingPercent || 0;
  const profile = data.understandingProfile || 'learning';
  const profileName = data.understandingProfileName || 'Learning';
  const profileMeta = voiceProfileMetaText(data, profile);
  const words = Math.max(0, Number(data.wordCount) || 0);

  if (vuCardEl) {
    vuCardEl.classList.remove('is-unlocked', 'is-personalized', 'is-attuned', 'is-fluent', 'is-expert', 'is-learning', 'is-complete');
    if (profile === 'personalized') vuCardEl.classList.add('is-personalized');
    if (profile === 'attuned') vuCardEl.classList.add('is-attuned');
    if (profile === 'fluent') vuCardEl.classList.add('is-fluent');
    if (profile === 'expert') vuCardEl.classList.add('is-expert');
    if (profile !== 'learning') vuCardEl.classList.add('is-unlocked');
    if (pct >= 100 || profile === 'expert') vuCardEl.classList.add('is-complete');
    else vuCardEl.classList.add('is-learning');
  }
  if (vuPctEl) vuPctEl.textContent = pct + '%';
  if (vuProfileEl) vuProfileEl.textContent = profileName;
  if (vuMetaEl) vuMetaEl.textContent = profileMeta;
  if (vuRingProgressEl) {
    vuRingProgressEl.style.strokeDashoffset = String(VU_RING_LEN * (1 - pct / 100));
    // A round cap would leave a dot at the top of an empty ring.
    vuRingProgressEl.style.opacity = pct > 0 ? '' : '0';
  }
  if (vuCardEl) {
    vuCardEl.setAttribute(
      'aria-label',
      'Voice profile, ' + profileName + ', ' + pct + ' percent complete. Open Your voice insights'
    );
  }
  if (vuGainEl && vuLastWordCount != null && words > vuLastWordCount) {
    clearTimeout(vuGainTimer);
    vuGainEl.textContent = '+' + (words - vuLastWordCount).toLocaleString() + ' words';
    vuGainEl.hidden = false;
    vuGainTimer = setTimeout(() => {
      vuGainEl.hidden = true;
    }, 2600);
  }
  vuLastWordCount = words;
}

function emptyCopy(mode, label) {
  const keys = shortcutKbdHtml(label || defaultShortcutLabel());
  if (mode === 'ptt') {
    return 'Hold ' + keys + ' anywhere to dictate. Release to finish, or tap to keep listening until the next press.<br/>Your transcripts will appear here.';
  }
  return 'Press ' + keys + ' anywhere to start dictation. Press it again to finish.<br/>Your transcripts will appear here.';
}

function renderFeedEmpty(data, all, entries, q) {
  if (!emptyEl) return;
  const mode = data.dictateMode === 'ptt' ? 'ptt' : 'toggle';
  const label = data.shortcutLabel || defaultShortcutLabel();
  const searchNoMatch = !!q && entries.length === 0;

  if (searchNoMatch) {
    emptyEl.hidden = false;
    emptyEl.innerHTML = all.length > 0
      ? 'No dictations match your search.'
      : (suggestionsOn(data) ? emptyCopy(mode, label) : '');
    if (all.length === 0 && !suggestionsOn(data)) emptyEl.hidden = true;
    return;
  }

  if (all.length > 0) {
    emptyEl.hidden = true;
    return;
  }

  if (!suggestionsOn(data)) {
    emptyEl.hidden = true;
    return;
  }

  emptyEl.hidden = false;
  emptyEl.innerHTML = emptyCopy(mode, label);
}

// The edit is a correction to one transcript, not yet a standing rule. Say
// what actually happened rather than promising the next dictation will change.
function showProposedToast(pairs) {
  const el = document.getElementById('learn-toast');
  if (!el || !pairs || !pairs.length || !suggestionsOn()) return;
  const first = pairs[0];
  const extra = pairs.length > 1 ? ' and ' + (pairs.length - 1) + ' more' : '';
  el.textContent = 'Suggested “' + first.from + '” → “' + first.to + '”'
    + extra + '. Add it in Dictionary to use it everywhere.';
  el.hidden = false;
  clearTimeout(showProposedToast._t);
  showProposedToast._t = setTimeout(() => {
    el.hidden = true;
  }, 3400);
}

function editingCardId() {
  const el = document.activeElement;
  if (!el || !el.closest) return null;
  // Only a transcript being typed into holds the feed still. Any focused
  // descendant used to count -- and a click focuses the copy and delete
  // buttons -- so deleting a card left it on screen until focus moved on.
  if (!el.isContentEditable) return null;
  const card = el.closest('#groups .card');
  return card ? card.dataset.id : null;
}

function prefersReducedMotion() {
  return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// Looping decoration obeys the system setting and the app's own choice.
function motionStill() {
  return !!prefersReducedMotion() || !!(flowMotion && flowMotion.preference === 'reduced');
}

function easeOutExpo(t) {
  return t >= 1 ? 1 : 1 - Math.pow(2, -10 * t);
}

function formatDmSaved(ms) {
  if (globalThis.voxdenMetrics) return globalThis.voxdenMetrics.formatTimeSaved(ms);
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return '—';
  const sec = Math.round(ms / 1000);
  if (sec < 60) return sec + ' sec';
  const min = Math.round(sec / 60);
  if (min < 60) return min + ' min';
  const hrs = min / 60;
  return hrs >= 10 ? Math.round(hrs) + ' hrs' : hrs.toFixed(1) + ' hrs';
}

function cancelDmRaf(key) {
  if (dmAnim[key]) {
    cancelAnimationFrame(dmAnim[key]);
    dmAnim[key] = 0;
  }
}

function setDmMetricLive(el, live) {
  if (!el) return;
  el.classList.toggle('is-live', live);
  el.classList.toggle('is-idle', !live);
}

function popDmValue(el) {
  if (!el || prefersReducedMotion()) return;
  el.classList.remove('is-updating');
  void el.offsetWidth;
  el.classList.add('is-updating');
}

function setDmValueText(el, text) {
  if (!el) return;
  const raw = String(text == null ? '' : text);
  const parts = raw.match(/^(-?\d[\d,]*(?:\.\d+)?)\s+([A-Za-z]+)$/);
  if (!parts) {
    el.textContent = raw;
    return;
  }
  let num = el.querySelector(':scope > .dm-num');
  let unit = el.querySelector(':scope > .dm-unit');
  if (!num || !unit) {
    el.replaceChildren();
    num = document.createElement('span');
    num.className = 'dm-num';
    unit = document.createElement('span');
    unit.className = 'dm-unit';
    el.append(num, unit);
  }
  num.textContent = parts[1];
  unit.textContent = parts[2];
}

function countDmValue(el, rafKey, from, to, duration, format) {
  cancelDmRaf(rafKey);
  if (!el) return;
  if (prefersReducedMotion() || from === to) {
    setDmValueText(el, format(to));
    return;
  }
  const start = performance.now();
  const tick = (now) => {
    const t = Math.min(1, (now - start) / duration);
    const value = from + (to - from) * easeOutExpo(t);
    setDmValueText(el, format(value));
    if (t < 1) dmAnim[rafKey] = requestAnimationFrame(tick);
    else {
      dmAnim[rafKey] = 0;
      setDmValueText(el, format(to));
    }
  };
  dmAnim[rafKey] = requestAnimationFrame(tick);
}

function renderDictationMetrics(avgWpm, timeSavedMs) {
  const wpm = (avgWpm != null && Number.isFinite(avgWpm) && avgWpm > 0) ? avgWpm : null;
  const savedMs = (timeSavedMs != null && Number.isFinite(timeSavedMs) && timeSavedMs > 0)
    ? timeSavedMs
    : 0;
  const savedLive = savedMs > 0;
  const wpmChanged = wpm !== dmAnim.wpm;
  const savedChanged = savedMs !== dmAnim.savedMs;
  if (!wpmChanged && !savedChanged) return;

  const hasAny = wpm != null || savedLive;
  if (dmMetricsEl) dmMetricsEl.classList.toggle('is-empty', !hasAny);

  if (wpmChanged) {
    setDmMetricLive(dmWpmMetricEl, wpm != null);
    if (statWpmEl) {
      statWpmEl.classList.toggle('is-empty', wpm == null);
      if (wpm == null) {
        cancelDmRaf('wpmRaf');
        setDmValueText(statWpmEl, '—');
      } else {
        const from = dmAnim.wpm == null ? 0 : dmAnim.wpm;
        countDmValue(statWpmEl, 'wpmRaf', from, wpm, DM_COUNT_MS, (n) => Math.max(0, Math.round(n)).toLocaleString());
        popDmValue(statWpmEl);
      }
    }
    if (dmWpmMetricEl) {
      if (wpm == null) {
        dmWpmMetricEl.setAttribute('aria-label', 'No speaking pace recorded yet. Open pace insights');
      } else {
        dmWpmMetricEl.setAttribute('aria-label', Math.round(wpm).toLocaleString() + ' words per minute, all time. Open pace insights');
      }
    }
    if (dmWpmContextEl) {
      const typingBaseline = (globalThis.voxdenMetrics && globalThis.voxdenMetrics.TYPING_WPM_BASELINE) || 40;
      dmWpmContextEl.textContent = wpm == null
        ? 'Dictate to measure your pace'
        : (wpm / typingBaseline).toFixed(1) + '× typing speed';
    }
    dmAnim.wpm = wpm;
  }

  if (savedChanged) {
    setDmMetricLive(dmSavedMetricEl, savedLive);
    if (statTimeSavedEl) {
      statTimeSavedEl.classList.toggle('is-empty', !savedLive);
      if (!savedLive) {
        cancelDmRaf('savedRaf');
        setDmValueText(statTimeSavedEl, '0 min');
      } else {
        const from = dmAnim.savedMs || 0;
        countDmValue(statTimeSavedEl, 'savedRaf', from, savedMs, DM_COUNT_MS, (n) => formatDmSaved(Math.max(0, n)));
        popDmValue(statTimeSavedEl);
      }
    }
    if (dmSavedMetricEl) {
      if (!savedLive) {
        dmSavedMetricEl.setAttribute('aria-label', 'No time saved yet. Open usage insights');
      } else {
        dmSavedMetricEl.setAttribute('aria-label', formatDmSaved(savedMs) + ' saved all time versus typing. Open usage insights');
      }
    }
    if (dmSavedContextEl) {
      const typingBaseline = (globalThis.voxdenMetrics && globalThis.voxdenMetrics.TYPING_WPM_BASELINE) || 40;
      dmSavedContextEl.textContent = 'Compared with typing at ' + typingBaseline + ' WPM';
    }
    dmAnim.savedMs = savedMs;
  }
}

// IPC creates new entry objects even when only a download percentage changed.
// Compare the fields these metrics use, rather than recounting every word in
// the entire history on every settings/progress broadcast. Keep value copies:
// editing a card can also mutate an entry in the current renderer snapshot.
let statsEntryValues = null;
let statsWeekExpiry = 0;
let statsComputedAt = 0;
let serverStatsCache = null;
let serverStatsRequest = null;
let serverStatsRetryAt = 0;
let serverStatsSignature = '';
let analyticsRefreshTimer = 0;

function analyticsTimezone() {
  return new Date().getTimezoneOffset() + '|' + Intl.DateTimeFormat().resolvedOptions().timeZone;
}

function analyticsReplyCurrent(reply, revision, now) {
  return !!reply && reply.revision === revision
    && now >= reply.computedAt && now < reply.expiresAt;
}

function currentAnalyticsRevision(data) {
  return data.analyticsRevision == null ? data.usageStats.revision : data.analyticsRevision;
}

// Only the visible pane needs time-sensitive statistics. Wake at a rolling
// window/calendar boundary, and periodically notice clock or timezone changes.
// A hidden window catches up when shown without polling in the tray.
function scheduleAnalyticsRefresh() {
  clearTimeout(analyticsRefreshTimer);
  analyticsRefreshTimer = 0;
  if (document.hidden || !lastPayload || !lastPayload.usageStats
      || (view !== 'dictation' && view !== 'insights')) return;
  const now = Date.now();
  let due = now + 60000;
  if (view === 'dictation') {
    const stats = serverStatsCache && serverStatsCache.stats || lastPayload.usageStats;
    const pending = serverStatsRequest && serverStatsRequest.revision === currentAnalyticsRevision(lastPayload)
      && now >= serverStatsRequest.now;
    if (!pending) due = serverStatsRetryAt > now ? serverStatsRetryAt : Number(stats.expiresAt);
  } else {
    const key = serverInsightsKey(lastPayload, insightsRange, insightsYear);
    const cache = serverInsightsCache.get(key);
    if (!serverInsightsRequest || serverInsightsRequest.key !== key || now < serverInsightsRequest.now) {
      due = serverInsightsRetry && serverInsightsRetry.key === key && serverInsightsRetry.at > now
        ? serverInsightsRetry.at : cache ? Number(cache.reply.expiresAt) : now;
    }
  }
  const delay = Math.max(50, Math.min(60000, Number.isNaN(due) ? 60000 : due - now));
  analyticsRefreshTimer = setTimeout(() => {
    analyticsRefreshTimer = 0;
    if (document.hidden || !lastPayload || !lastPayload.usageStats) return;
    if (view === 'dictation') renderStats(lastPayload.entries || [], lastPayload);
    else if (view === 'insights') renderInsights(lastPayload);
  }, delay);
}

function refreshServerStats(revision, timezone, now) {
  if (serverStatsRequest && serverStatsRequest.revision === revision
      && serverStatsRequest.timezone === timezone && now >= serverStatsRequest.now) return;
  if (serverStatsRetryAt > now + 5000) serverStatsRetryAt = 0;
  if (serverStatsRetryAt > now || typeof window.voxden.historyStats !== 'function') return;
  const request = { revision, timezone, now };
  serverStatsRequest = request;
  window.voxden.historyStats().then(stats => {
    if (serverStatsRequest !== request) return;
    serverStatsRequest = null;
    const latest = lastPayload;
    if (!latest || !latest.usageStats || currentAnalyticsRevision(latest) !== revision) return;
    if (timezone !== analyticsTimezone() || !analyticsReplyCurrent(stats, revision, Date.now())) {
      serverStatsRetryAt = Date.now() + 1000;
      return;
    }
    serverStatsCache = { stats, timezone };
    serverStatsRetryAt = 0;
    if (!document.hidden && view === 'dictation') renderStats(latest.entries || [], latest);
  }).catch(() => {
    if (serverStatsRequest !== request) return;
    serverStatsRequest = null;
    serverStatsRetryAt = Date.now() + 5000;
  }).finally(scheduleAnalyticsRefresh);
}

// The week up front: one bar per day of the very week the "words this week"
// counter already measures. That counter is a rolling seven days (see
// history-usage.js), so bucketing exactly those entries by their local weekday
// makes the seven bars add up to the number beside them.
const WEEK_BAR_HEIGHT = 34;
const WEEK_BAR_STUB = 3;
// 2024-01-01 was a Monday, so this walks Monday to Sunday in the user's locale.
const WEEK_DAY_NAMES = Array.from({ length: 7 }, (_unused, index) => {
  const day = new Date(2024, 0, 1 + index);
  return {
    narrow: day.toLocaleDateString(undefined, { weekday: 'narrow' }),
    short: day.toLocaleDateString(undefined, { weekday: 'short' }),
  };
});

let weekBarCells = null;
let weekBarsSignature = '';

function renderWeekBars(days) {
  if (!weekBarsEl) return;
  // A payload without per-day figures (an older main process, or a history
  // whose transcripts are gone) still shows the real counters: the bars simply
  // show nothing rather than an invented shape.
  const values = Array.isArray(days) && days.length === 7
    ? days.map(value => (Number(value) > 0 ? Math.round(Number(value)) : 0))
    : [0, 0, 0, 0, 0, 0, 0];
  const signature = values.join(',');
  if (weekBarCells && signature === weekBarsSignature) return;
  weekBarsSignature = signature;
  if (!weekBarCells) {
    weekBarsEl.textContent = '';
    weekBarCells = WEEK_DAY_NAMES.map(name => {
      const cell = document.createElement('div');
      cell.className = 'week-day';
      const slot = document.createElement('div');
      slot.className = 'week-bar-slot';
      const bar = document.createElement('span');
      bar.className = 'week-bar';
      slot.appendChild(bar);
      const label = document.createElement('span');
      label.className = 'week-dow';
      label.textContent = name.narrow;
      cell.appendChild(slot);
      cell.appendChild(label);
      weekBarsEl.appendChild(cell);
      return { cell, bar };
    });
  }
  const busiest = Math.max(...values);
  values.forEach((words, index) => {
    const { cell, bar } = weekBarCells[index];
    cell.classList.toggle('is-empty', words <= 0);
    bar.style.height = words > 0
      ? Math.max(4, Math.round(WEEK_BAR_HEIGHT * words / busiest)) + 'px'
      : WEEK_BAR_STUB + 'px';
  });
  weekBarsEl.setAttribute('aria-label', 'Words per day this week: '
    + values.map((words, index) => WEEK_DAY_NAMES[index].short + ' ' + words.toLocaleString()).join(', '));
}

function renderServerStats(payload) {
  const now = Date.now();
  const timezone = analyticsTimezone();
  const revision = currentAnalyticsRevision(payload);
  if (!serverStatsCache || serverStatsCache.stats.revision !== revision) {
    serverStatsCache = { stats: payload.usageStats, timezone };
    serverStatsRetryAt = 0;
  } else if (payload.usageStats.computedAt > serverStatsCache.stats.computedAt
      && analyticsReplyCurrent(payload.usageStats, revision, now)) {
    serverStatsCache = { stats: payload.usageStats, timezone };
  }
  const stats = serverStatsCache.stats;
  if (serverStatsCache.timezone !== timezone || !analyticsReplyCurrent(stats, revision, now)) {
    refreshServerStats(revision, timezone, now);
  }
  const signature = [revision, stats.wordCount, stats.dictations, stats.weekWords,
    JSON.stringify(stats.weekDays || null), stats.avgWpm, stats.timeSavedMs].join('|');
  if (signature !== serverStatsSignature) {
    serverStatsSignature = signature;
    statsEntryValues = null;
    statWordsEl.textContent = Number(stats.wordCount).toLocaleString();
    statNotesEl.textContent = Number(stats.dictations).toLocaleString();
    statWeekEl.textContent = Number(stats.weekWords).toLocaleString();
    renderWeekBars(stats.weekDays);
    renderDictationMetrics(stats.avgWpm, stats.timeSavedMs);
  }
  scheduleAnalyticsRefresh();
}

function renderStats(entries, payload) {
  if (payload && payload.usageStats) {
    renderServerStats(payload);
    return;
  }
  serverStatsSignature = '';
  const now = Date.now();
  if (statsEntryValues && now >= statsComputedAt && now < statsWeekExpiry && entries.length === statsEntryValues.length
      && entries.every((entry, i) => {
        const previous = statsEntryValues[i];
        return entry.id === previous.id && entry.text === previous.text
          && entry.ts === previous.ts && entry.durationMs === previous.durationMs;
      })) return;
  statsEntryValues = entries.map(({ id, text, ts, durationMs }) => ({ id, text, ts, durationMs }));
  statsComputedAt = now;
  statsWeekExpiry = Infinity;
  let words = 0;
  let week = 0;
  const weekDays = [0, 0, 0, 0, 0, 0, 0];
  const weekMs = 7 * 24 * 3600 * 1000;
  const weekAgo = now - weekMs;
  for (const e of entries) {
    const n = globalThis.voxdenMetrics.countWords(e.text);
    words += n;
    if (e.ts >= weekAgo) {
      week += n;
      // Monday first, from the same entries the week counter just added up.
      weekDays[(new Date(Number(e.ts)).getDay() + 6) % 7] += n;
      statsWeekExpiry = Math.min(statsWeekExpiry, Number(e.ts) + weekMs + 1);
    }
  }
  statWordsEl.textContent = words.toLocaleString();
  statNotesEl.textContent = entries.length.toLocaleString();
  statWeekEl.textContent = week.toLocaleString();
  renderWeekBars(weekDays);

  const m = globalThis.voxdenMetrics
    ? globalThis.voxdenMetrics.computeMetrics(entries)
    : { avgWpm: payload && payload.avgWpm, timeSavedMs: payload && payload.timeSavedMs };
  renderDictationMetrics(m.avgWpm, m.timeSavedMs);
}

function makeIconBtn(title, svgPath, danger) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'icon-btn' + (danger ? ' danger' : '');
  btn.title = title;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '15');
  svg.setAttribute('height', '15');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('fill', 'currentColor');
  p.setAttribute('d', svgPath);
  svg.appendChild(p);
  btn.appendChild(svg);
  return btn;
}

const COPY_PATH = 'M16 1H4a2 2 0 0 0-2 2v14h2V3h12V1zm3 4H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2zm0 16H8V7h11v14z';
const TRASH_PATH = 'M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z';
const EDIT_PATH = 'M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z';
const MORE_PATH = 'M12 8a2 2 0 1 0 0-4 2 2 0 0 0 0 4zm0 2a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm0 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4z';
const PLAY_PATH = 'M8 5v14l11-7z';
const PAUSE_PATH = 'M6 19h4V5H6v14zm8-14v14h4V5h-4z';
const DOWNLOAD_PATH = 'M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z';
const RETRY_PATH = 'M17.65 6.35A7.96 7.96 0 0 0 12 4a8 8 0 1 0 7.73 10h-2.08A6 6 0 1 1 12 6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z';

function setIconBtn(btn, svgPath, title) {
  const p = btn.querySelector('path');
  if (p) p.setAttribute('d', svgPath);
  btn.title = title;
  btn.setAttribute('aria-label', title);
}

function menuItem(label, svgPath, enabled, disabledTitle) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'card-menu-item';
  btn.setAttribute('role', 'menuitem');
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '14');
  svg.setAttribute('height', '14');
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('fill', 'currentColor');
  p.setAttribute('d', svgPath);
  svg.appendChild(p);
  btn.appendChild(svg);
  const text = document.createElement('span');
  text.textContent = label;
  btn.appendChild(text);
  btn.disabled = !enabled;
  if (!enabled && disabledTitle) btn.title = disabledTitle;
  return btn;
}

// --- Card menu and player --------------------------------------------------
// One menu open at a time, one recording playing at a time. Both are looked
// up by entry id when they need the card, because the feed rebuilds its cards
// whenever a transcript changes -- which a retry does.

let openCardMenu = null;
let activePlayer = null;
let playbackGeneration = 0;

function closeCardMenu() {
  if (!openCardMenu) return;
  openCardMenu.menu.hidden = true;
  openCardMenu.button.setAttribute('aria-expanded', 'false');
  openCardMenu.card.classList.remove('has-open-menu');
  openCardMenu.pane.removeEventListener('scroll', positionCardMenu);
  window.removeEventListener('resize', positionCardMenu);
  openCardMenu = null;
}

function positionCardMenu() {
  if (!openCardMenu) return;
  const { button, menu, card, pane } = openCardMenu;
  const anchor = button.getBoundingClientRect();
  const viewport = pane.getBoundingClientRect();
  const inset = 8;
  const left = Math.max(0, viewport.left + pane.clientLeft) + inset;
  const right = Math.min(window.innerWidth, viewport.left + pane.clientLeft + pane.clientWidth) - inset;
  const top = Math.max(0, viewport.top + pane.clientTop) + inset;
  const bottom = Math.min(window.innerHeight, viewport.top + pane.clientTop + pane.clientHeight) - inset;
  if (anchor.bottom <= top || anchor.top >= bottom || anchor.right <= left || anchor.left >= right) {
    closeCardMenu();
    return;
  }

  // Measure within the pane before choosing a side. A very small window can
  // scroll the menu itself; its buttons keep their normal height.
  menu.style.maxHeight = Math.max(0, bottom - top) + 'px';
  menu.style.maxWidth = Math.max(0, right - left) + 'px';
  const rect = menu.getBoundingClientRect();
  const below = anchor.bottom + 4;
  const above = anchor.top - 4 - rect.height;
  const y = below + rect.height <= bottom ? below : above >= top ? above
    : Math.max(top, Math.min(below, bottom - rect.height));
  const x = Math.max(left, Math.min(anchor.right - rect.width, right - rect.width));
  const origin = card.getBoundingClientRect();
  menu.style.top = (y - origin.top - card.clientTop) + 'px';
  menu.style.left = (x - origin.left - card.clientLeft) + 'px';
}

function openCardMenuFor(button, menu) {
  if (openCardMenu && openCardMenu.menu === menu) {
    closeCardMenu();
    return;
  }
  closeCardMenu();
  const card = button.closest('.card');
  const pane = card.closest('.pane-body');
  card.classList.add('has-open-menu');
  // Do not let a stale position from an earlier opening enlarge the scroller
  // while the menu is being measured.
  menu.style.top = '0px';
  menu.style.left = '0px';
  menu.scrollTop = 0;
  menu.hidden = false;
  button.setAttribute('aria-expanded', 'true');
  openCardMenu = { button, menu, card, pane };
  pane.addEventListener('scroll', positionCardMenu, { passive: true });
  window.addEventListener('resize', positionCardMenu);
  positionCardMenu();
}

document.addEventListener('mousedown', (e) => {
  if (!openCardMenu) return;
  if (openCardMenu.menu.contains(e.target) || openCardMenu.button.contains(e.target)) return;
  closeCardMenu();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && openCardMenu) closeCardMenu();
});

function stopActivePlayer() {
  playbackGeneration += 1;
  if (!activePlayer) return;
  const p = activePlayer;
  activePlayer = null;
  try { p.audio.pause(); } catch (_) {}
  if (p.url) {
    try { URL.revokeObjectURL(p.url); } catch (_) {}
  }
  p.teardown();
}

function formatClock(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

// A short line in the card's meta row: what a menu action did, or why it
// could not. Found by id so it lands on whichever card element is live.
// The retry reply and history broadcast can arrive in either order, so the
// status must survive a card being rebuilt after the reply.
const cardStatuses = new Map();

function applyCardStatus(el, status) {
  el.textContent = status ? status.text : '';
  el.className = 'card-status' + (status ? ' is-shown' : '')
    + (status && status.kind ? ' is-' + status.kind : '');
}

function cardStatus(id, text, kind, sticky) {
  const card = (recoveriesEl && recoveriesEl.querySelector('.card[data-id="' + id + '"]'))
    || (groupsEl && groupsEl.querySelector('.card[data-id="' + id + '"]'));
  const el = card && card.querySelector('.card-status');
  const previous = cardStatuses.get(id);
  if (previous) clearTimeout(previous.timer);
  cardStatuses.delete(id);
  if (!el) return;
  const status = text ? { text, kind } : null;
  applyCardStatus(el, status);
  if (status) {
    if (!sticky) status.timer = setTimeout(() => cardStatus(id, ''), 4000);
    cardStatuses.set(id, status);
  }
}

// The playback strip a card shows while its clip is playing, wired to seek.
// Both kinds of card use it: a dictation's recording and a shelved clip differ
// in where the bytes come from, not in how they play.
function makeCardPlayer(id) {
  const player = document.createElement('div');
  player.className = 'card-player';
  player.hidden = true;
  const playToggle = makeIconBtn('Pause', PAUSE_PATH, false);
  playToggle.classList.add('card-player-toggle');
  const track = document.createElement('div');
  track.className = 'card-player-track';
  const fill = document.createElement('div');
  fill.className = 'card-player-fill';
  track.appendChild(fill);
  const clock = document.createElement('span');
  clock.className = 'card-player-time';
  clock.textContent = '0:00';
  player.appendChild(playToggle);
  player.appendChild(track);
  player.appendChild(clock);
  track.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!activePlayer || activePlayer.id !== id) return;
    const rect = track.getBoundingClientRect();
    const dur = activePlayer.audio.duration;
    if (!rect.width || !Number.isFinite(dur) || dur <= 0) return;
    activePlayer.audio.currentTime = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)) * dur;
  });
  return { player, playToggle, track, fill, clock };
}

// Play bytes the caller has already fetched. One player at a time, whichever
// card owns it.
function startPlayback(id, res, parts) {
  const { player, playToggle, fill, clock } = parts;
  const url = URL.createObjectURL(new Blob([res.bytes], { type: 'audio/wav' }));
  const audio = new Audio(url);
  const total = Number(res.seconds) || 0;
  const update = () => {
    const dur = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : total;
    fill.style.width = dur ? Math.min(100, (audio.currentTime / dur) * 100) + '%' : '0%';
    clock.textContent = formatClock(audio.currentTime) + ' / ' + formatClock(dur);
  };
  audio.addEventListener('timeupdate', update);
  audio.addEventListener('loadedmetadata', update);
  audio.addEventListener('play', () => setIconBtn(playToggle, PAUSE_PATH, 'Pause'));
  audio.addEventListener('pause', () => setIconBtn(playToggle, PLAY_PATH, 'Play'));
  audio.addEventListener('ended', () => { if (activePlayer && activePlayer.audio === audio) stopActivePlayer(); });
  activePlayer = {
    id,
    audio,
    url,
    teardown: () => {
      player.hidden = true;
      fill.style.width = '0%';
      setIconBtn(playToggle, PAUSE_PATH, 'Pause');
    },
  };
  player.hidden = false;
  update();
  audio.play().catch(() => cardStatus(id, 'Playback failed.', 'error'));
}

// What each Polish mode is called while it runs and once it is done: the
// Polish page's button and result, and a history card's label. A result from
// before the modes has none, and was a polish.
const POLISH_MODE_WORDS = {
  polish: { busy: 'Polishing…', done: 'Polished' },
  grammar: { busy: 'Checking…', done: 'Grammar fixed' },
  tighten: { busy: 'Tightening…', done: 'Tightened' },
};

function polishModeWords(mode) {
  return POLISH_MODE_WORDS[mode] || POLISH_MODE_WORDS.polish;
}

// A polished dictation shows its polished version under its own words, in
// Pro gold, joined to them by an arrow. It is text, not a recording, so copy
// is all it offers: its button, or a click anywhere on it that is not the end
// of selecting some of its words.
function buildPolishedLine(entry) {
  const done = polishModeWords(entry.polished.mode).done;
  const line = document.createElement('div');
  line.className = 'card-polished';
  line.setAttribute('role', 'group');
  line.setAttribute('aria-label', done + ' version');
  line.innerHTML = '<svg class="card-polished-arrow" viewBox="0 0 22 28" aria-hidden="true">'
    + '<path d="M6 1v12.5a6 6 0 0 0 6 6h7" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>'
    + '<path d="M15.5 16l3.5 3.5-3.5 3.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>'
    + '</svg>';
  const panel = document.createElement('div');
  panel.className = 'card-polished-panel';
  const label = document.createElement('span');
  label.className = 'card-polished-label';
  label.innerHTML = '<svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true">'
    + '<path d="M6.6 1.6c.5 2.8 1.4 3.7 4.2 4.2-2.8.5-3.7 1.4-4.2 4.2-.5-2.8-1.4-3.7-4.2-4.2 2.8-.5 3.7-1.4 4.2-4.2Z" fill="currentColor"/>'
    + '<path d="M12.2 9.3c.26 1.3.66 1.7 1.96 1.96-1.3.26-1.7.66-1.96 1.96-.26-1.3-.66-1.7-1.96-1.96 1.3-.26 1.7-.66 1.96-1.96Z" fill="currentColor"/>'
    + '</svg>';
  const word = document.createElement('span');
  word.textContent = done;
  label.appendChild(word);
  const copy = makeIconBtn('Copy polished text', COPY_PATH, false);
  copy.classList.add('card-polished-copy');
  const head = document.createElement('div');
  head.className = 'card-polished-head';
  head.append(label, copy);
  const words = document.createElement('p');
  words.className = 'card-polished-text';
  words.textContent = entry.polished.text;
  panel.append(head, words);
  line.appendChild(panel);

  let copiedTimer = 0;
  const copyPolished = () => window.voxden.copyEntry(entry.id, 'polished').then((ok) => {
    if (!ok) return;
    clearTimeout(copiedTimer);
    line.classList.add('is-copied');
    word.textContent = 'Copied';
    copiedTimer = setTimeout(() => {
      line.classList.remove('is-copied');
      word.textContent = done;
    }, 1200);
  });
  copy.addEventListener('click', (e) => {
    e.stopPropagation();
    copyPolished();
  });
  line.addEventListener('click', (e) => {
    // The card's own click copies the dictation; this one copies the polish.
    e.stopPropagation();
    const selected = window.getSelection();
    if (selected && !selected.isCollapsed && words.contains(selected.anchorNode)) return;
    copyPolished();
  });
  return line;
}

function buildCard(entry) {
  const card = document.createElement('div');
  card.className = 'card';
  card.dataset.id = entry.id;

  const body = document.createElement('div');
  body.className = 'card-body';

  const meta = document.createElement('div');
  meta.className = 'card-meta';
  const time = document.createElement('time');
  time.className = 'time';
  time.textContent = formatTime(entry.ts);
  const copiedTag = document.createElement('span');
  copiedTag.className = 'copied-tag';
  copiedTag.textContent = 'Copied';
  const learnedTag = document.createElement('span');
  learnedTag.className = 'copied-tag learned-tag';
  learnedTag.textContent = 'Learned';
  const statusTag = document.createElement('span');
  applyCardStatus(statusTag, cardStatuses.get(entry.id));
  meta.appendChild(time);
  meta.appendChild(copiedTag);
  meta.appendChild(learnedTag);
  meta.appendChild(statusTag);
  const text = document.createElement('div');
  text.className = 'text';
  text.contentEditable = 'true';
  text.spellcheck = true;
  text.textContent = entry.text || '';

  // The player, shown only while this card's recording is playing.
  const playerParts = makeCardPlayer(entry.id);
  const { player, playToggle } = playerParts;

  body.appendChild(meta);
  body.appendChild(text);
  if (entry.polished && entry.polished.text) body.appendChild(buildPolishedLine(entry));
  body.appendChild(player);
  card.appendChild(body);

  const actions = document.createElement('div');
  actions.className = 'card-actions';
  const copyBtn = makeIconBtn('Copy', COPY_PATH, false);
  const moreBtn = makeIconBtn('More', MORE_PATH, false);
  moreBtn.classList.add('card-more');
  moreBtn.setAttribute('aria-haspopup', 'menu');
  moreBtn.setAttribute('aria-expanded', 'false');
  actions.appendChild(copyBtn);
  actions.appendChild(moreBtn);
  card.appendChild(actions);

  // The menu. Everything that needs the recording is greyed out without one:
  // an entry from before recordings were kept, or one whose fortnight is up.
  const hasAudio = !!entry.audio;
  const noAudio = 'No recording kept for this dictation';
  const menu = document.createElement('div');
  menu.className = 'card-menu';
  menu.setAttribute('role', 'menu');
  menu.hidden = true;
  const playItem = menuItem('Play recording', PLAY_PATH, hasAudio, noAudio);
  const saveItem = menuItem('Save as WAV…', DOWNLOAD_PATH, hasAudio, noAudio);
  const retryItem = menuItem('Retry transcript', RETRY_PATH, hasAudio, noAudio);
  const deleteItem = menuItem('Delete', TRASH_PATH, true, '');
  deleteItem.classList.add('danger');
  for (const item of [playItem, saveItem, retryItem, deleteItem]) menu.appendChild(item);
  card.appendChild(menu);

  async function playRecording() {
    if (activePlayer && activePlayer.id === entry.id) {
      if (activePlayer.audio.paused) activePlayer.audio.play().catch(() => {});
      else activePlayer.audio.pause();
      return;
    }
    stopActivePlayer();
    const generation = playbackGeneration;
    let res = null;
    try {
      res = await window.voxden.entryAudio(entry.id);
    } catch (_) {
      res = null;
    }
    if (generation !== playbackGeneration) return;
    if (!res || !res.ok || !res.bytes) {
      cardStatus(entry.id, (res && res.reason) || 'No recording kept for this dictation.', 'error');
      return;
    }
    // Deleting recordings can finish while the audio request is in flight.
    if (clearingRecordings || !card.isConnected || !(lastPayload.entries || []).some(e => e.id === entry.id && e.audio)) return;
    startPlayback(entry.id, res, playerParts);
  }

  playToggle.addEventListener('click', (e) => {
    e.stopPropagation();
    playRecording();
  });

  moreBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    openCardMenuFor(moreBtn, menu);
  });
  playItem.addEventListener('click', (e) => {
    e.stopPropagation();
    closeCardMenu();
    playRecording();
  });
  saveItem.addEventListener('click', (e) => {
    e.stopPropagation();
    closeCardMenu();
    cardStatus(entry.id, 'Saving…', 'busy', true);
    window.voxden.saveEntryAudio(entry.id).then((res) => {
      if (res && res.ok) cardStatus(entry.id, 'Saved as WAV', '');
      else if (res && res.cancelled) cardStatus(entry.id, '');
      else cardStatus(entry.id, (res && res.reason) || 'The recording could not be saved.', 'error');
    }).catch(() => cardStatus(entry.id, 'The recording could not be saved.', 'error'));
  });
  retryItem.addEventListener('click', (e) => {
    e.stopPropagation();
    closeCardMenu();
    card.classList.add('is-retrying');
    cardStatus(entry.id, 'Retrying…', 'busy', true);
    window.voxden.retryEntry(entry.id).then((res) => {
      // The broadcast may already have rebuilt this card, or may still be on
      // its way. cardStatus keeps the result across either delivery order.
      card.classList.remove('is-retrying');
      if (res && res.ok) cardStatus(entry.id, res.changed ? 'Transcript updated' : 'Same transcript', '');
      else cardStatus(entry.id, (res && res.reason) || 'Retry failed.', 'error');
    }).catch(() => {
      card.classList.remove('is-retrying');
      cardStatus(entry.id, 'Retry failed.', 'error');
    });
  });

  function flashCopied() {
    card.classList.add('copied');
    setTimeout(() => card.classList.remove('copied'), 900);
  }

  function flashLearned() {
    card.classList.add('learned');
    setTimeout(() => card.classList.remove('learned'), 1600);
  }

  function saveEdit() {
    const next = text.innerText.replace(/\u00a0/g, ' ').trimEnd();
    if (next === (entry.text || '')) return;
    window.voxden.editEntry(entry.id, next).then((res) => {
      if (!res || res.ok === false) return;
      entry.text = next;
      if (res.proposed && res.proposed.length) {
        flashLearned();
        showProposedToast(res.proposed);
      }
    });
  }

  let learnTimer = 0;
  text.addEventListener('input', () => {
    clearTimeout(learnTimer);
    learnTimer = setTimeout(saveEdit, 900);
  });
  text.addEventListener('blur', () => {
    clearTimeout(learnTimer);
    saveEdit();
  });
  text.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      text.blur();
    }
  });

  card.addEventListener('click', (e) => {
    if (e.target.closest('.text') || e.target.closest('.icon-btn')) return;
    if (e.target.closest('.card-menu') || e.target.closest('.card-player')) return;
    window.voxden.copyEntry(entry.id).then((ok) => { if (ok) flashCopied(); });
  });
  copyBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    window.voxden.copyEntry(entry.id).then((ok) => { if (ok) flashCopied(); });
  });
  deleteItem.addEventListener('click', (e) => {
    e.stopPropagation();
    closeCardMenu();
    clearTimeout(learnTimer);
    if (activePlayer && activePlayer.id === entry.id) stopActivePlayer();
    window.voxden.deleteEntry(entry.id);
  });

  return card;
}

// --- the recovery shelf -------------------------------------------------
//
// A dictation that never produced words still produced audio. One card per
// clip, and deliberately quiet: a name, one line of facts, and a small button
// that says what pressing it costs. Everything else -- playing the clip,
// saving it, throwing it away -- lives in the menu, because none of it is what
// the user came to this card to do.

function recoveryReason(item) {
  if (item.reason) return item.reason;
  return item.source === 'crash'
    ? 'Voxden closed before this dictation finished'
    : 'This dictation did not transcribe';
}

// One quiet line: how long it was, when it was, and why it is here.
function recoveryFacts(item) {
  return [formatClipTime(item.seconds), formatTime(item.ts), recoveryReason(item)]
    .filter(Boolean).join(' \u00b7 ');
}

// The local engine is free. Cloud costs a credit a minute, so the button says
// so rather than spending it quietly.
function recoveryCost(item, data) {
  if (data.cloudTranscription !== true) return '';
  const credits = Math.max(1, Math.ceil((Number(item.seconds) || 0) / 60));
  return credits === 1 ? '1 credit' : credits + ' credits';
}

function buildRecoveryCard(item, data) {
  const card = document.createElement('div');
  card.className = 'card recovery-card';
  card.dataset.id = item.id;

  const body = document.createElement('div');
  body.className = 'card-body';

  const head = document.createElement('div');
  head.className = 'card-meta';
  const name = document.createElement('span');
  name.className = 'recovery-name';
  name.textContent = 'Recover voice';
  const statusTag = document.createElement('span');
  applyCardStatus(statusTag, cardStatuses.get(item.id));
  head.appendChild(name);
  head.appendChild(statusTag);

  const facts = document.createElement('div');
  facts.className = 'recovery-facts';
  facts.textContent = recoveryFacts(item);
  facts.title = recoveryFacts(item);

  const playerParts = makeCardPlayer(item.id);
  const { player, playToggle } = playerParts;

  body.appendChild(head);
  body.appendChild(facts);
  body.appendChild(player);
  card.appendChild(body);

  const actions = document.createElement('div');
  actions.className = 'card-actions recovery-actions';
  const recoverBtn = document.createElement('button');
  recoverBtn.type = 'button';
  recoverBtn.className = 'recovery-recover';
  const recoverLabel = document.createElement('span');
  recoverLabel.textContent = 'Recover';
  recoverBtn.appendChild(recoverLabel);
  const cost = recoveryCost(item, data);
  if (cost) {
    const costTag = document.createElement('span');
    costTag.className = 'recovery-cost';
    costTag.textContent = cost;
    recoverBtn.appendChild(costTag);
  }
  const moreBtn = makeIconBtn('More', MORE_PATH, false);
  moreBtn.classList.add('card-more');
  moreBtn.setAttribute('aria-haspopup', 'menu');
  moreBtn.setAttribute('aria-expanded', 'false');
  actions.appendChild(recoverBtn);
  actions.appendChild(moreBtn);
  card.appendChild(actions);

  const menu = document.createElement('div');
  menu.className = 'card-menu';
  menu.setAttribute('role', 'menu');
  menu.hidden = true;
  const playItem = menuItem('Play recording', PLAY_PATH, true, '');
  const saveItem = menuItem('Save as WAV\u2026', DOWNLOAD_PATH, true, '');
  const deleteItem = menuItem('Delete', TRASH_PATH, true, '');
  deleteItem.classList.add('danger');
  for (const entryItem of [playItem, saveItem, deleteItem]) menu.appendChild(entryItem);
  card.appendChild(menu);

  async function playClip() {
    if (activePlayer && activePlayer.id === item.id) {
      if (activePlayer.audio.paused) activePlayer.audio.play().catch(() => {});
      else activePlayer.audio.pause();
      return;
    }
    stopActivePlayer();
    const generation = playbackGeneration;
    let res = null;
    try {
      res = await window.voxden.recoveryAudio(item.id);
    } catch (_) {
      res = null;
    }
    if (generation !== playbackGeneration) return;
    if (!res || !res.ok || !res.bytes) {
      cardStatus(item.id, (res && res.reason) || 'That recording is no longer here.', 'error');
      return;
    }
    if (clearingRecordings || !card.isConnected) return;
    startPlayback(item.id, res, playerParts);
  }

  playToggle.addEventListener('click', (e) => { e.stopPropagation(); playClip(); });
  moreBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    openCardMenuFor(moreBtn, menu);
  });
  playItem.addEventListener('click', (e) => {
    e.stopPropagation();
    closeCardMenu();
    playClip();
  });
  saveItem.addEventListener('click', (e) => {
    e.stopPropagation();
    closeCardMenu();
    cardStatus(item.id, 'Saving\u2026', 'busy', true);
    window.voxden.saveRecoveryAudio(item.id).then((res) => {
      if (res && res.ok) cardStatus(item.id, 'Saved as WAV', '');
      else if (res && res.cancelled) cardStatus(item.id, '');
      else cardStatus(item.id, (res && res.reason) || 'The recording could not be saved.', 'error');
    }).catch(() => cardStatus(item.id, 'The recording could not be saved.', 'error'));
  });
  deleteItem.addEventListener('click', (e) => {
    e.stopPropagation();
    closeCardMenu();
    if (activePlayer && activePlayer.id === item.id) stopActivePlayer();
    window.voxden.deleteRecovery(item.id).catch(() => {});
  });
  recoverBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    // A cold engine can take most of a minute, so the button stays disabled
    // and the card says what it is doing rather than inviting a second press.
    recoverBtn.disabled = true;
    card.classList.add('is-recovering');
    cardStatus(item.id, 'Recovering\u2026', 'busy', true);
    window.voxden.recoverRecording(item.id).then((res) => {
      card.classList.remove('is-recovering');
      recoverBtn.disabled = false;
      if (res && res.ok) cardStatus(item.id, 'Recovered \u2014 copied to clipboard', '');
      else cardStatus(item.id, (res && res.reason) || 'Recovery failed.', 'error');
    }).catch(() => {
      card.classList.remove('is-recovering');
      recoverBtn.disabled = false;
      cardStatus(item.id, 'Recovery failed.', 'error');
    });
  });

  return card;
}

let recoverySignature = '';

// Rendered above the feed, in its own container: the feed's signature diff is
// a deliberate performance fix and has no business learning about these. The
// heading is the feed's own day label, so the shelf reads as part of the list
// rather than as a panel bolted above it.
function renderRecoveries(data) {
  if (!recoveriesEl) return;
  const items = Array.isArray(data.recoveries) ? data.recoveries : [];
  // Keeping recordings off empties this list in main, so there is nothing to
  // explain here; the setting itself says what turning it off costs.
  const sig = items.map((r) => r.id + ':' + r.reason).join('|')
    + '|' + (data.cloudTranscription === true ? 'cloud' : 'local');
  if (sig === recoverySignature) return;
  recoverySignature = sig;
  // These cards are about to be replaced, and the menu and the player hang off
  // them. A clip playing from the feed is none of this render's business.
  closeCardMenu();
  if (activePlayer && recoveriesEl.querySelector('.card[data-id="' + activePlayer.id + '"]')) stopActivePlayer();
  recoveriesEl.innerHTML = '';
  recoveriesEl.hidden = !items.length;
  if (!items.length) return;

  const label = document.createElement('div');
  label.className = 'day recovery-day';
  label.textContent = 'Not transcribed';
  recoveriesEl.appendChild(label);
  for (const item of items) recoveriesEl.appendChild(buildRecoveryCard(item, data));
}

function setDictError(message) {
  if (!dictErrorEl) return;
  const msg = String(message || '').trim();
  if (!msg) {
    dictErrorEl.hidden = true;
    dictErrorEl.textContent = '';
    return;
  }
  dictErrorEl.hidden = false;
  dictErrorEl.textContent = msg;
}

function dictMisspellOn() {
  return !!(vocabMisspellEl && vocabMisspellEl.checked);
}

function syncVocabFields() {
  const mapping = dictMisspellOn();
  if (vocabWordFieldEl) vocabWordFieldEl.hidden = mapping;
  if (vocabMappingEl) vocabMappingEl.hidden = !mapping;
  if (dictToEl) dictToEl.disabled = mapping;
  if (dictFromEl) dictFromEl.disabled = !mapping;
  if (dictToMapEl) dictToMapEl.disabled = !mapping;
}

function closeVocabModal() {
  if (vocabOverlayEl) vocabOverlayEl.hidden = true;
  resetDictForm();
}

function openVocabModal(phrase) {
  resetDictForm();
  if (phrase) {
    dictEditingFrom = phrase.from;
    const mapping = phrase.kind !== 'word' && phrase.from !== phrase.to;
    if (vocabMisspellEl) vocabMisspellEl.checked = mapping;
    if (mapping) {
      if (dictFromEl) dictFromEl.value = phrase.from;
      if (dictToMapEl) dictToMapEl.value = phrase.to;
    } else if (dictToEl) {
      dictToEl.value = phrase.to || phrase.from;
    }
    if (vocabTitleEl) vocabTitleEl.textContent = 'Edit vocabulary';
    if (dictSubmitEl) dictSubmitEl.textContent = 'Save';
  } else {
    if (vocabTitleEl) vocabTitleEl.textContent = 'Add to vocabulary';
    if (dictSubmitEl) dictSubmitEl.textContent = 'Add word';
  }
  syncVocabFields();
  if (vocabOverlayEl) vocabOverlayEl.hidden = false;
  const focusEl = dictMisspellOn() ? dictFromEl : dictToEl;
  if (focusEl) focusEl.focus();
}

function resetDictForm() {
  dictEditingFrom = null;
  if (dictFromEl) dictFromEl.value = '';
  if (dictToEl) dictToEl.value = '';
  if (dictToMapEl) dictToMapEl.value = '';
  if (vocabMisspellEl) vocabMisspellEl.checked = false;
  if (dictSubmitEl) dictSubmitEl.textContent = 'Add word';
  if (vocabTitleEl) vocabTitleEl.textContent = 'Add to vocabulary';
  setDictError('');
  syncVocabFields();
}

function startDictEdit(phrase) {
  openVocabModal(phrase);
}

function sparkleIcon() {
  const span = document.createElement('span');
  span.className = 'dict-sparkle';
  span.title = 'Learned from a correction';
  span.innerHTML = '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path fill="currentColor" d="M8 1.2l1.1 3.4 3.5.2-2.7 2.2.9 3.4L8 8.6 4.2 10.4l.9-3.4L2.4 4.8l3.5-.2z"/></svg>';
  return span;
}

const dictPendingEl = document.getElementById('dict-pending');
const dictPendingListEl = document.getElementById('dict-pending-list');

// A proposal is a find-and-replace that will fire on every future dictation,
// so it gets an explicit accept rather than appearing in the list as fact.
function buildPendingRow(item) {
  const row = document.createElement('div');
  row.className = 'dict-pending-row';

  const pair = document.createElement('div');
  pair.className = 'dict-pending-pair';
  const from = document.createElement('span');
  from.className = 'dict-pending-from';
  from.textContent = item.from;
  const arrow = document.createElement('span');
  arrow.className = 'dict-pending-arrow';
  arrow.textContent = '→';
  arrow.setAttribute('aria-hidden', 'true');
  const to = document.createElement('span');
  to.className = 'dict-pending-to';
  to.textContent = item.to;
  pair.appendChild(from);
  pair.appendChild(arrow);
  pair.appendChild(to);

  const actions = document.createElement('div');
  actions.className = 'dict-pending-actions';
  const accept = document.createElement('button');
  accept.type = 'button';
  accept.className = 'btn-secondary dict-pending-accept';
  accept.textContent = 'Add';
  accept.setAttribute('aria-label', 'Add ' + item.from + ' to ' + item.to);
  accept.addEventListener('click', async () => {
    accept.disabled = true;
    const res = await window.voxden.acceptPending(item.from);
    if (res && res.ok === false && res.error) setDictError(res.error);
  });
  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.className = 'dict-pending-dismiss';
  dismiss.textContent = 'Dismiss';
  dismiss.setAttribute('aria-label', 'Dismiss ' + item.from);
  dismiss.addEventListener('click', async () => {
    dismiss.disabled = true;
    await window.voxden.dismissPending(item.from);
  });
  actions.appendChild(accept);
  actions.appendChild(dismiss);

  row.appendChild(pair);
  row.appendChild(actions);
  return row;
}

function renderPending(data) {
  if (!dictPendingEl || !dictPendingListEl) return;
  const pending = (data && data.pendingPhrases) || [];
  dictPendingEl.hidden = !pending.length;
  dictPendingListEl.innerHTML = '';
  for (const item of pending.slice().reverse()) {
    dictPendingListEl.appendChild(buildPendingRow(item));
  }
}

function buildDictRow(phrase) {
  const mapping = phrase.kind !== 'word' && phrase.from !== phrase.to;
  const row = document.createElement('div');
  row.className = 'dict-row' + (mapping ? ' is-mapping' : '');
  if (dictEditingFrom && phrase.from.toLowerCase() === dictEditingFrom.toLowerCase()) {
    row.classList.add('is-editing');
  }

  if (mapping) {
    const from = document.createElement('div');
    from.className = 'dict-row-from';
    from.textContent = phrase.from;
    from.title = phrase.from;
    const arrow = document.createElement('div');
    arrow.className = 'dict-row-arrow';
    arrow.textContent = '→';
    arrow.setAttribute('aria-hidden', 'true');
    const to = document.createElement('div');
    to.className = 'dict-row-to';
    to.textContent = phrase.to;
    to.title = phrase.to;
    if (phrase.source === 'learned') to.appendChild(sparkleIcon());
    row.appendChild(from);
    row.appendChild(arrow);
    row.appendChild(to);
  } else {
    const term = document.createElement('div');
    term.className = 'dict-row-term';
    term.textContent = phrase.to || phrase.from;
    term.title = phrase.to || phrase.from;
    if (phrase.source === 'learned') term.appendChild(sparkleIcon());
    row.appendChild(term);
  }

  const actions = document.createElement('div');
  actions.className = 'dict-row-actions';
  const editBtn = makeIconBtn('Edit', EDIT_PATH, false);
  const delBtn = makeIconBtn('Delete', TRASH_PATH, true);
  actions.appendChild(editBtn);
  actions.appendChild(delBtn);

  editBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    startDictEdit(phrase);
  });
  delBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    window.voxden.deletePhrase(phrase.from).then(() => {
      if (dictEditingFrom && phrase.from.toLowerCase() === dictEditingFrom.toLowerCase()) {
        closeVocabModal();
      }
    });
  });

  row.appendChild(actions);
  return row;
}

// --- Dictionary overview: a correction happening ---------------------------
// The strip cycles the user's own learned corrections: the heard form alone,
// then struck out as the corrected form slides in, a hold, and the next one.
// It runs only while the Dictionary page shows in a visible window, and not
// under reduced motion, where it rests on the first correction, settled. With
// nothing learned yet it shows one static example.
const vocabFixEl = document.getElementById('vocab-fix');
const vocabFixFromEl = document.getElementById('vocab-fix-from');
const vocabFixToEl = document.getElementById('vocab-fix-to');
const vocabOverviewLineEl = document.getElementById('vocab-overview-line');
const VOCAB_FIX_EXAMPLE = { from: 'vox den', to: 'Voxden' };
const VOCAB_FIX_HEARD_MS = 1200;
const VOCAB_FIX_HOLD_MS = 2200;
const VOCAB_FIX_SWAP_MS = 320;
const vocabFix = { pairs: [], key: '', index: 0, timer: 0 };

function vocabFixStill() {
  return motionStill();
}

function learnedCorrections(phrases) {
  return (phrases || []).filter((p) => p && p.source === 'learned' && p.kind !== 'word'
    && p.from && p.to && p.from !== p.to);
}

function paintVocabFix(pair, fixed) {
  if (!vocabFixEl) return;
  vocabFixFromEl.textContent = pair.from;
  vocabFixToEl.textContent = pair.to;
  vocabFixEl.setAttribute('aria-label', pair.from + ' becomes ' + pair.to);
  vocabFixEl.classList.toggle('is-fixed', fixed);
}

function stopVocabFix() {
  clearTimeout(vocabFix.timer);
  vocabFix.timer = 0;
  if (vocabFixEl) vocabFixEl.classList.remove('is-running');
}

function stepVocabFix(phase) {
  const pair = vocabFix.pairs[vocabFix.index % vocabFix.pairs.length];
  if (phase === 'heard') {
    paintVocabFix(pair, false);
    vocabFix.timer = setTimeout(() => stepVocabFix('fixed'), VOCAB_FIX_HEARD_MS);
  } else if (phase === 'fixed') {
    vocabFixEl.classList.add('is-fixed');
    vocabFix.timer = setTimeout(() => stepVocabFix('swap'), VOCAB_FIX_HOLD_MS);
  } else {
    // The corrected form fades out before the words change underneath it.
    vocabFixEl.classList.remove('is-fixed');
    vocabFix.index = (vocabFix.index + 1) % vocabFix.pairs.length;
    vocabFix.timer = setTimeout(() => stepVocabFix('heard'), VOCAB_FIX_SWAP_MS);
  }
}

function syncVocabFix() {
  if (!vocabFixEl) return;
  const awake = view === 'dictionary' && !document.hidden && vocabFix.pairs.length > 0 && !vocabFixStill();
  if (awake) {
    if (vocabFix.timer) return;
    vocabFixEl.classList.add('is-running');
    stepVocabFix('heard');
    return;
  }
  stopVocabFix();
  // Stopped, it rests settled: the first correction, or the example.
  vocabFix.index = 0;
  paintVocabFix(vocabFix.pairs[0] || VOCAB_FIX_EXAMPLE, true);
}

function renderVocabFix(phrases) {
  if (!vocabFixEl) return;
  const pairs = learnedCorrections(phrases);
  const key = JSON.stringify(pairs.map((p) => [p.from, p.to]));
  if (key === vocabFix.key) return;
  vocabFix.key = key;
  vocabFix.pairs = pairs;
  vocabFix.index = 0;
  stopVocabFix();
  vocabFixEl.classList.toggle('is-example', !pairs.length);
  if (vocabOverviewLineEl) {
    vocabOverviewLineEl.textContent = pairs.length
      ? 'Fix a word once. Voxden remembers.'
      : 'Correct a word in any dictation and it will appear here.';
  }
  syncVocabFix();
}

let dictionarySignature = '';

function renderDictionary(payload) {
  if (view !== 'dictionary' || document.hidden) return;
  const data = payload || lastPayload || {};
  renderPending(data);
  if (!dictListEl) return;
  const phrases = data.phrases || [];
  const signature = JSON.stringify([
    dictQuery, dictTab, dictEditingFrom, suggestionsOn(data), data.variantCount,
    phrases.map(({ from, to, source, kind }) => [from, to, source, kind]),
  ]);
  if (signature === dictionarySignature) return;
  dictionarySignature = signature;
  document.getElementById('dict-total-count').textContent = phrases.length.toLocaleString();
  document.getElementById('dict-learned-count').textContent = phrases.filter(p => p.source === 'learned').length.toLocaleString();
  renderVocabFix(phrases);
  const q = dictQuery.trim().toLowerCase();
  let filtered = phrases;
  if (dictTab === 'added') {
    filtered = filtered.filter((p) => p.source !== 'learned');
  } else if (dictTab === 'learned') {
    filtered = filtered.filter((p) => p.source === 'learned');
  }
  if (q) {
    filtered = filtered.filter((p) =>
      (p.from || '').toLowerCase().includes(q) || (p.to || '').toLowerCase().includes(q));
  }

  const tabEmpty = dictTab !== 'all' && phrases.length > 0 && !filtered.length && !q;
  dictEmptyEl.hidden = phrases.length > 0 || !suggestionsOn(data);
  dictNoMatchEl.hidden = !((q || tabEmpty) && phrases.length > 0 && !filtered.length);
  if (dictNoMatchEl && tabEmpty) {
    dictNoMatchEl.textContent = dictTab === 'learned'
      ? 'Nothing learned yet. Edit a transcript, then add the suggestion above.'
      : 'No words added yet.';
  } else if (dictNoMatchEl) {
    dictNoMatchEl.textContent = 'No entries match this filter.';
  }

  dictListEl.innerHTML = '';
  for (const phrase of filtered) {
    dictListEl.appendChild(buildDictRow(phrase));
  }
  if (dictionarySearch) dictionarySearch.setCount(q ? filtered.length.toLocaleString() + ' of ' + phrases.length.toLocaleString() : '');
  document.getElementById('dict-result-count').textContent = phrases.length
    ? filtered.length.toLocaleString() + ' of ' + phrases.length.toLocaleString() + ' entries' : '';

  if (dictVariantsEl) {
    const count = Number(data.variantCount) || 0;
    dictVariantsEl.hidden = count < 1;
    dictVariantsEl.textContent = count === 1
      ? 'Plus 1 spelling Voxden worked out on its own. Delete a term to drop its spellings.'
      : 'Plus ' + count + ' spellings Voxden worked out on its own. Delete a term to drop its spellings.';
  }
}

async function submitDictForm(e) {
  e.preventDefault();
  const mapping = dictMisspellOn();
  const from = mapping
    ? (dictFromEl ? dictFromEl.value.trim() : '')
    : (dictToEl ? dictToEl.value.trim() : '');
  const to = mapping
    ? (dictToMapEl ? dictToMapEl.value.trim() : '')
    : from;
  if (!from || !to) {
    setDictError(mapping ? 'Both sides are required.' : 'Enter a word.');
    return;
  }

  let result;
  try {
    result = await window.voxden.upsertPhrase(from, to, {
      kind: mapping ? 'mapping' : 'word',
      source: 'manual',
      renameFrom: dictEditingFrom || '',
    });
  } catch (_) {
    setDictError('Could not save that entry. Try again.');
    return;
  }
  if (!result || !result.ok) {
    setDictError((result && result.error) || 'Could not save that entry.');
    return;
  }

  closeVocabModal();
}

const INS_GAUGE_LEN = 176;

// styleFixes spans every stage except the dictionary, so the label cannot
// name all of them on its own.
const INS_FIX_EXPLAINER = 'Words changed covers filler cleanup and your writing style.';
const INS_DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const INS_ICON_ATTRS = 'viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" '
  + 'stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"';

// What each app on the leaderboard is mostly used for, as a one-word tag.
const INS_BUCKET_TAGS = {
  ai: 'AI',
  work: 'Work',
  email: 'Email',
  personal: 'Personal',
  other: 'Other',
};

// Direction against the previous period. "none" is an app with nothing in
// either window, which only happens on the all-time ranking.
const INS_TREND_ICONS = {
  up: '<svg ' + INS_ICON_ATTRS + '><path d="M6 17 17 6"/><path d="M9 6h8v8"/></svg>',
  down: '<svg ' + INS_ICON_ATTRS + '><path d="M6 7l11 11"/><path d="M9 18h8v-8"/></svg>',
  flat: '<svg ' + INS_ICON_ATTRS + '><path d="M5 12h14"/></svg>',
  new: '<svg ' + INS_ICON_ATTRS + '><path d="M12 5.5 13.4 10 18 11.5 13.4 13 12 17.5 10.6 13 6 11.5 10.6 10z"/></svg>',
  none: '',
};

const INS_TREND_TITLES = {
  up: 'More than the period before',
  down: 'Less than the period before',
  flat: 'About the same as the period before',
  new: 'New this period',
  none: '',
};

function insSetText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

function insHourLabel(h) {
  if (h === 0) return '12 AM';
  if (h === 12) return '12 PM';
  return (h % 12 === 0 ? 12 : h % 12) + (h < 12 ? ' AM' : ' PM');
}

function renderInsPace(pace, tips, reveal) {
  const showTips = tips !== false;
  const fill = document.getElementById('ins-gauge-fill');
  const foot = document.getElementById('ins-pace-foot');
  const has = pace.hasTimed && pace.avgWpm != null;
  insCountUp('ins-pace-num', has ? pace.avgWpm : 0, (v) => (v > 0 ? Math.round(v).toLocaleString() : '—'), reveal);
  insSetText('ins-pace-mult', has && pace.multiplier ? pace.multiplier + '×' : '—');
  if (fill) {
    const pct = has && pace.percent != null ? pace.percent : 0;
    const offset = String(INS_GAUGE_LEN * (1 - pct / 100));
    if (reveal) {
      // Sweep from empty: the dashoffset transition needs a frame at the start.
      fill.style.strokeDashoffset = String(INS_GAUGE_LEN);
      requestAnimationFrame(() => requestAnimationFrame(() => { fill.style.strokeDashoffset = offset; }));
    } else {
      fill.style.strokeDashoffset = offset;
    }
  }
  if (foot) {
    if (!has && !showTips) {
      foot.textContent = '';
      foot.hidden = true;
    } else {
      foot.hidden = false;
      foot.textContent = has
        ? 'From ' + pace.timedWords.toLocaleString() + ' timed words, against ' + pace.typingBaseline + ' WPM typing.'
        : 'Dictate with the overlay to measure your pace.';
    }
  }
}

function renderInsFixes(fixes, tips, reveal) {
  const showTips = tips !== false;
  const foot = document.getElementById('ins-fix-foot');
  insCountUp('ins-fix-total', fixes.total, null, reveal);
  insSetText('ins-fix-style', fixes.style.toLocaleString());
  insSetText('ins-fix-dict', fixes.dictionary.toLocaleString());
  // The row label names one bucket but the count spans several stages, so the
  // foot says which -- swapped for the onboarding hint until there is data.
  if (foot) {
    if (!fixes.hasData && !showTips) {
      foot.textContent = '';
      foot.hidden = true;
    } else {
      foot.hidden = false;
      foot.textContent = fixes.hasData
        ? INS_FIX_EXPLAINER
        : 'Fix counts start with your next dictation.';
    }
  }
}

// A width that is meant to be seen growing has to start from nothing on the
// frame before it is set, or the transition has nothing to travel.
function insSetWidth(el, percent, reveal) {
  if (!el) return;
  const target = Math.max(0, Math.min(100, percent)) + '%';
  if (!reveal) {
    el.style.width = target;
    return;
  }
  el.style.width = '0%';
  requestAnimationFrame(() => requestAnimationFrame(() => { el.style.width = target; }));
}

// Milestone labels read "a full page" in a sentence; on the strip the article
// is noise.
function insMilestoneShort(label) {
  const s = String(label || '').replace(/^an?\s+/i, '');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function insShortDate(ts) {
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// Spine heights, one per rung. Uneven on purpose, so the row reads as books.
const INS_SHELF_HEIGHTS = [52, 66, 58, 70, 60, 74, 64, 80];

function insShelfCaption(m, ms) {
  const name = insMilestoneShort(m.label);
  if (m.state === 'reached') return name + ' · ' + insShortDate(m.reachedAt);
  if (m.state === 'next') {
    const left = ms.next ? ms.next.remaining : 0;
    return name + ' · next · ' + left.toLocaleString() + (left === 1 ? ' word to go' : ' words to go');
  }
  return name + ' · ' + m.words.toLocaleString() + ' words';
}

// The bookshelf beside the milestones copy. Hovering, focusing or clicking a
// spine lifts it and names it in the caption under the shelf.
function renderInsShelf(ms) {
  const books = document.getElementById('ins-shelf-books');
  const caption = document.getElementById('ins-shelf-caption');
  if (!books || !caption) return;
  const list = ms.milestones || [];
  if (insShelfPick && (insShelfPick.year !== ms.year || insShelfPick.index >= list.length)) insShelfPick = null;
  const nextIndex = list.findIndex((m) => m.state === 'next');
  const fallback = nextIndex >= 0 ? nextIndex : list.length - 1;
  const focused = books.contains(document.activeElement)
    ? [...books.children].indexOf(document.activeElement) : -1;

  const pick = (index) => {
    insShelfPick = { year: ms.year, index };
    [...books.children].forEach((el, i) => {
      el.classList.toggle('is-picked', i === index);
      el.setAttribute('aria-pressed', i === index ? 'true' : 'false');
    });
    caption.textContent = list[index] ? insShelfCaption(list[index], ms) : '';
  };

  books.textContent = '';
  list.forEach((m, i) => {
    const book = document.createElement('button');
    book.type = 'button';
    book.className = 'ins-shelf-book is-' + m.state
      + (nextIndex >= 0 && i === nextIndex + 1 ? ' is-after-next' : '');
    book.style.setProperty('--h', (INS_SHELF_HEIGHTS[i % INS_SHELF_HEIGHTS.length]) + 'px');
    book.setAttribute('aria-label', insShelfCaption(m, ms).replace(/ · /g, ', '));
    book.addEventListener('mouseenter', () => pick(i));
    book.addEventListener('focus', () => pick(i));
    book.addEventListener('click', () => pick(i));
    books.appendChild(book);
  });
  const shown = insShelfPick ? insShelfPick.index : fallback;
  const kept = insShelfPick;
  if (list.length) pick(shown);
  // Showing the default is not a choice; only a hover, focus or click is.
  insShelfPick = kept;
  if (focused >= 0 && books.children[focused]) books.children[focused].focus();
}

function renderInsMilestones(ms, years, tips, reveal) {
  const showTips = tips !== false;
  const card = document.getElementById('ins-milestones-card');
  const yearsEl = document.getElementById('ins-years');
  const strip = document.getElementById('ins-ms-strip');
  const fill = document.getElementById('ins-ms-fill');
  if (!card || !yearsEl || !strip) return;

  const thisYear = new Date().getFullYear();
  const yearWord = ms.year === thisYear ? 'this year' : 'in ' + ms.year;

  // One year needs no switch. The buttons are rebuilt each render because the
  // set of years only ever grows, and it grows rarely.
  yearsEl.textContent = '';
  yearsEl.hidden = years.length <= 1;
  for (const y of years) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ins-range-btn' + (y === ms.year ? ' is-active' : '');
    btn.textContent = String(y);
    btn.setAttribute('aria-pressed', y === ms.year ? 'true' : 'false');
    btn.addEventListener('click', () => {
      if (insightsYear === y) return;
      insightsYear = y;
      renderInsights(null);
    });
    yearsEl.appendChild(btn);
  }

  let title;
  let copy;
  if (ms.latest) {
    title = "You've written " + ms.latest.label + ' ' + yearWord;
  } else if (ms.words > 0 && ms.next) {
    title = insMilestoneShort(ms.next.label) + ' is ' + ms.next.remaining.toLocaleString() + ' words away';
  } else {
    title = ms.year === thisYear ? 'Nothing dictated yet this year' : 'No dictations in ' + ms.year;
  }
  if (ms.words > 0) {
    copy = ms.words.toLocaleString() + ' words across ' + ms.dictations.toLocaleString()
      + (ms.dictations === 1 ? ' dictation ' : ' dictations ') + yearWord + '.';
  } else {
    copy = showTips ? 'Start dictating and Voxden keeps count.' : '';
  }
  insSetText('ins-ms-title', title);
  insSetText('ins-ms-copy', copy);
  insSetText('ins-ms-next', ms.next
    ? ms.next.remaining.toLocaleString() + ' words to ' + ms.next.label
    : 'Every milestone cleared');
  insSetWidth(fill, ms.next ? ms.next.percent : 100, reveal);

  renderInsShelf(ms);

  strip.textContent = '';
  ms.milestones.forEach((m, i) => {
    const li = document.createElement('li');
    li.className = 'ins-ms-step is-' + m.state;
    li.style.setProperty('--i', String(i));
    const dot = document.createElement('span');
    dot.className = 'ins-ms-dot';
    const name = document.createElement('b');
    name.textContent = insMilestoneShort(m.label);
    const when = document.createElement('small');
    // The bar above already says how far the next one is.
    if (m.state === 'reached') when.textContent = insShortDate(m.reachedAt);
    else if (m.state === 'next') when.textContent = 'Next';
    else when.textContent = m.words.toLocaleString() + ' words';
    li.title = m.state === 'reached'
      ? insMilestoneShort(m.label) + ', reached ' + insShortDate(m.reachedAt) + ' ' + yearWord
      : insMilestoneShort(m.label) + ' at ' + m.words.toLocaleString() + ' words';
    li.append(dot, name, when);
    strip.appendChild(li);
  });
}

function insSavedLine(ms) {
  if (!ms || !Number.isFinite(ms) || ms <= 0) return '';
  const hours = ms / 3600000;
  if (hours >= 8) {
    const days = hours / 8;
    return 'About ' + (days >= 1.5 ? Math.round(days) + ' working days' : 'a working day') + ' you did not spend typing.';
  }
  if (hours >= 1) {
    return 'About ' + (hours >= 1.5 ? Math.round(hours) + ' hours' : 'an hour') + ' you did not spend typing.';
  }
  return 'Every dictation adds to this.';
}

function renderInsSaved(pace, tips, reveal) {
  const showTips = tips !== false;
  const foot = document.getElementById('ins-saved-foot');
  const has = pace.hasTimed && Number.isFinite(pace.timeSavedMs) && pace.timeSavedMs > 0;
  insCountUp('ins-saved-num', has ? pace.timeSavedMs : 0, (v) => (v > 0 ? formatDmSaved(v) : '—'), reveal);
  insSetText('ins-saved-line', has ? insSavedLine(pace.timeSavedMs) : '');
  if (foot) {
    if (!has && !showTips) {
      foot.textContent = '';
      foot.hidden = true;
    } else {
      foot.hidden = false;
      foot.textContent = has
        ? 'Compared with typing at ' + pace.typingBaseline + ' words per minute.'
        : 'Time saved shows up with your first timed dictation.';
    }
  }
}

function renderInsWhere(where, tips, reveal) {
  const showTips = tips !== false;
  const listEl = document.getElementById('ins-leaderboard');
  const emptyEl = document.getElementById('ins-where-empty');
  if (!listEl || !emptyEl) return;
  const lb = where.leaderboard || { rows: [], total: 0 };

  insSetText('ins-where-apps-total', lb.total.toLocaleString());
  const has = lb.rows.length > 0;
  emptyEl.hidden = has || !showTips;
  listEl.hidden = !has;
  listEl.textContent = '';
  if (!has) return;

  // Bars are relative to the leader, not to the total: with six apps sharing
  // the words, shares of the whole all read as short.
  const top = lb.rows[0].words || 1;
  for (const row of lb.rows) {
    const li = document.createElement('li');
    li.className = 'ins-lb-row';
    li.dataset.rank = String(row.rank);

    const rank = document.createElement('span');
    rank.className = 'ins-lb-rank';
    rank.textContent = String(row.rank);

    const main = document.createElement('div');
    main.className = 'ins-lb-main';
    const name = document.createElement('div');
    name.className = 'ins-lb-name';
    const label = document.createElement('b');
    label.textContent = row.label;
    const tag = document.createElement('span');
    tag.className = 'ins-lb-tag';
    tag.textContent = INS_BUCKET_TAGS[row.bucket] || INS_BUCKET_TAGS.other;
    name.append(label, tag);
    const track = document.createElement('div');
    track.className = 'ins-lb-track';
    const fill = document.createElement('div');
    fill.className = 'ins-lb-fill';
    insSetWidth(fill, (row.words / top) * 100, reveal);
    track.appendChild(fill);
    main.append(name, track);

    const words = document.createElement('span');
    words.className = 'ins-lb-words';
    const count = document.createElement('b');
    count.textContent = row.words.toLocaleString();
    words.append(count, document.createTextNode(row.share + '% of words'));

    const trend = document.createElement('span');
    trend.className = 'ins-lb-trend is-' + row.trend;
    trend.innerHTML = INS_TREND_ICONS[row.trend] || '';
    trend.title = INS_TREND_TITLES[row.trend] || '';
    trend.setAttribute('aria-label', INS_TREND_TITLES[row.trend] || '');

    li.append(rank, main, words, trend);
    listEl.appendChild(li);
  }
}

function renderInsRhythm(rhythm) {
  const gridEl = document.getElementById('ins-heat-grid');
  const daysEl = document.getElementById('ins-heat-days');
  const monthsEl = document.getElementById('ins-heat-months');
  const heat = rhythm.heatmap;

  insSetText('ins-streak-current', String(rhythm.currentStreak));
  insSetText('ins-streak-longest', String(rhythm.longestStreak));

  if (daysEl && !daysEl.childElementCount) {
    for (let row = 0; row < 7; row++) {
      const span = document.createElement('span');
      span.textContent = INS_DAY_LABELS[row];
      daysEl.appendChild(span);
    }
  }

  if (monthsEl) {
    monthsEl.style.setProperty('--heat-weeks', String(heat.weeks));
    monthsEl.textContent = '';
    for (const m of heat.months) {
      const span = document.createElement('span');
      span.className = 'ins-heat-month';
      span.style.gridColumn = String(m.column + 1);
      span.textContent = m.label;
      monthsEl.appendChild(span);
    }
  }

  if (!gridEl) return;
  gridEl.style.setProperty('--heat-weeks', String(heat.weeks));
  gridEl.textContent = '';
  heat.columns.forEach((col, colIndex) => {
    for (const cell of col) {
      const span = document.createElement('span');
      span.className = 'ins-heat-cell';
      // The reveal sweeps left to right, a column at a time.
      span.style.setProperty('--c', String(colIndex));
      // Only future days are blanked. Days before your first dictation stay
      // drawn: the empty cells are what make the grid read as a calendar, and
      // without them a short history looks like a rendering fault.
      if (cell.future) span.classList.add('is-outside');
      if (cell.inStreak) span.classList.add('is-streak');
      span.dataset.level = String(cell.level);
      if (!cell.future) {
        const day = new Date(cell.ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
        span.title = cell.words > 0 ? day + ' · ' + cell.words + ' words' : day + ' · no dictations';
      }
      gridEl.appendChild(span);
    }
  });
}

function renderInsVoice(ins, tips) {
  const showTips = tips !== false;
  const cloudEl = document.getElementById('ins-cloud');
  const wordsEmptyEl = document.getElementById('ins-words-empty');
  const clockEl = document.getElementById('ins-clock');
  const clockEmptyEl = document.getElementById('ins-clock-empty');

  insSetText('ins-taught-dict', ins.taught.dictionarySize.toLocaleString());
  insSetText('ins-taught-learned', ins.taught.learnedPairs.toLocaleString());
  insSetText('ins-taught-edited', ins.taught.editedTranscripts.toLocaleString());
  insSetText('ins-len-avg', ins.length.average.toLocaleString());
  insSetText('ins-len-max', ins.length.longest.toLocaleString());
  insSetText('ins-words-count', String(ins.words.length));

  if (cloudEl && wordsEmptyEl) {
    const cloud = Array.isArray(ins.wordCloud) ? ins.wordCloud : [];
    const has = cloud.length > 0;
    wordsEmptyEl.hidden = has || !showTips;
    cloudEl.hidden = !has;
    cloudEl.textContent = '';
    // Sized by each word's own count against the leader, so two words said
    // equally often look the same and the runaway favourite stands out.
    for (const item of cloud) {
      const chip = document.createElement('span');
      chip.className = 'ins-word-chip';
      const w = Math.max(0, Math.min(100, item.weight));
      chip.dataset.rank = w >= 75 ? '0' : (w >= 45 ? '1' : (w >= 25 ? '2' : '3'));
      chip.style.fontSize = (11.5 + (w / 100) * 6.5).toFixed(1) + 'px';
      chip.textContent = item.word;
      chip.title = item.count.toLocaleString() + (item.count === 1 ? ' time' : ' times');
      cloudEl.appendChild(chip);
    }
  }

  if (clockEl && clockEmptyEl) {
    const has = ins.clock.total > 0;
    clockEmptyEl.hidden = has || !showTips;
    clockEl.hidden = !has;
    clockEl.textContent = '';
    insSetText('ins-clock-peak', has && ins.clock.peakHour != null
      ? 'MOST ACTIVE ' + insHourLabel(ins.clock.peakHour)
      : '');
    if (has) {
      for (const slot of ins.clock.hours) {
        const col = document.createElement('div');
        col.className = 'ins-clock-col'
          + (slot.count > 0 ? '' : ' is-empty')
          + (slot.hour === ins.clock.peakHour ? ' is-peak' : '');
        col.title = insHourLabel(slot.hour) + ' · ' + slot.count + ' dictations';
        const bar = document.createElement('div');
        bar.className = 'ins-clock-bar';
        bar.style.height = Math.max(3, slot.percent) + '%';
        const tick = document.createElement('span');
        tick.className = 'ins-clock-tick';
        tick.textContent = slot.hour % 6 === 0 ? String(slot.hour).padStart(2, '0') : '';
        col.appendChild(bar);
        col.appendChild(tick);
        clockEl.appendChild(col);
      }
    }
  }
}

function renderInsVoiceProfile(data) {
  const profileName = data.understandingProfileName || 'Learning';
  const copy = data.understandingCopy
    || 'Fix a misspelled word in a transcript. Voxden saves that spelling for next time.';
  const percent = Math.max(0, Math.min(100, Number(data.understandingPercent) || 0));
  const words = Math.max(0, Number(data.wordCount) || 0);
  const currentIndex = Math.max(0, Number(data.understandingProfileIndex) || 0);
  const profiles = Array.isArray(data.understandingProfiles) && data.understandingProfiles.length
    ? data.understandingProfiles
    : [
      { id: 'learning', name: 'Learning', threshold: 0 },
      { id: 'personalized', name: 'Personalized', threshold: 2500 },
      { id: 'attuned', name: 'Attuned', threshold: 5000 },
      { id: 'fluent', name: 'Fluent', threshold: 10000 },
      { id: 'expert', name: 'Expert', threshold: 25000 },
    ];

  insSetText('ins-profile-name', profileName);
  insSetText('ins-profile-copy', copy);
  insSetText('ins-profile-percent', percent + '%');
  // The mascot wakes up a step per level: dim and sleepy while learning,
  // fully lit once the profile is expert.
  const mascot = document.getElementById('ins-profile-mascot');
  if (mascot) mascot.dataset.level = String(Math.min(4, currentIndex));
  insSetText('ins-profile-progress-meta', voiceProfileMetaText(data, data.understandingProfile || 'learning'));
  insSetText('ins-profile-word-count', words.toLocaleString() + ' words analyzed');

  const progress = document.getElementById('ins-profile-progress');
  const fill = document.getElementById('ins-profile-progress-fill');
  if (progress) {
    progress.setAttribute('aria-valuenow', String(percent));
    progress.setAttribute('aria-label', profileName + ' voice profile, ' + percent + ' percent to the next milestone');
  }
  if (fill) fill.style.width = percent + '%';

  const ladder = document.getElementById('ins-profile-ladder');
  if (!ladder) return;
  ladder.textContent = '';
  profiles.forEach((profile, index) => {
    const step = document.createElement('div');
    step.className = 'ins-profile-step';
    if (index < currentIndex || (data.understandingMaxed && index === currentIndex)) {
      step.classList.add('is-complete');
    }
    if (index === currentIndex) {
      step.classList.add('is-current');
      step.setAttribute('aria-current', 'step');
    }

    const marker = document.createElement('span');
    marker.className = 'ins-profile-step-marker';
    marker.textContent = index < currentIndex || (data.understandingMaxed && index === currentIndex) ? '✓' : '';

    const name = document.createElement('b');
    name.textContent = profile.name;

    const threshold = document.createElement('small');
    threshold.textContent = Number(profile.threshold) > 0
      ? Number(profile.threshold).toLocaleString() + ' words'
      : 'Start';

    step.append(marker, name, threshold);
    ladder.appendChild(step);
  });
}

let insightsCache = null;
const serverInsightsCache = new Map();
let serverInsightsRequest = null;
let serverInsightsGeneration = 0;
let serverInsightsRetry = null;
const INSIGHTS_ENTRY_FIELDS = [
  'ts', 'text', 'durationMs', 'original', 'category', 'exe', 'title', 'dictionaryHits', 'styleFixes',
];

function serverInsightsKey(data, range, year) {
  return JSON.stringify([currentAnalyticsRevision(data), range, year]);
}

function cachedServerInsights(data) {
  const revision = currentAnalyticsRevision(data);
  const range = insightsRange;
  const year = insightsYear;
  const key = serverInsightsKey(data, range, year);
  const timezone = analyticsTimezone();
  const now = Date.now();
  const cache = serverInsightsCache.get(key);
  if (cache && cache.timezone === timezone && analyticsReplyCurrent(cache.reply, revision, now)) {
    panes.insights.removeAttribute('aria-busy');
    return cache.reply.result;
  }
  if (serverInsightsRetry && serverInsightsRetry.key === key
      && now >= serverInsightsRetry.now && now < serverInsightsRetry.at) return null;
  panes.insights.setAttribute('aria-busy', 'true');
  if (serverInsightsRequest && serverInsightsRequest.key === key
      && serverInsightsRequest.timezone === timezone && now >= serverInsightsRequest.now) return null;
  if (typeof window.voxden.historyInsights !== 'function') {
    insSetText('ins-subtitle', 'Insights could not be loaded.');
    panes.insights.removeAttribute('aria-busy');
    return null;
  }
  insSetText('ins-subtitle', 'Loading insights…');
  const request = { key, revision, range, year, timezone, now, generation: ++serverInsightsGeneration };
  serverInsightsRequest = request;
  window.voxden.historyInsights({ range, year }).then(reply => {
    if (serverInsightsRequest !== request) return;
    serverInsightsRequest = null;
    const latest = lastPayload;
    if (!latest || !latest.usageStats || currentAnalyticsRevision(latest) !== revision) return;
    if (timezone !== analyticsTimezone() || !analyticsReplyCurrent(reply, revision, Date.now()) || !reply.result) {
      throw new Error('Insights changed while loading');
    }
    const value = { reply, timezone };
    serverInsightsCache.set(key, value);
    // The initial null year resolves to the latest year that has activity.
    const settledYear = reply.result.milestones ? reply.result.milestones.year : null;
    serverInsightsCache.set(serverInsightsKey(latest, range, settledYear), value);
    while (serverInsightsCache.size > 12) serverInsightsCache.delete(serverInsightsCache.keys().next().value);
    serverInsightsRetry = null;
    if (!document.hidden && view === 'insights' && range === insightsRange && year === insightsYear) {
      renderInsights(latest);
    }
  }).catch(() => {
    // A replaced request belongs to an older range or revision and must not
    // overwrite the current pane, including its loading/error state.
    if (serverInsightsGeneration !== request.generation) return;
    serverInsightsRequest = null;
    const latest = lastPayload;
    if (!latest || !latest.usageStats || serverInsightsKey(latest, insightsRange, insightsYear) !== key) return;
    const failedAt = Date.now();
    serverInsightsRetry = { key, now: failedAt, at: failedAt + 5000 };
    if (!document.hidden && view === 'insights') {
      panes.insights.removeAttribute('aria-busy');
      insSetText('ins-subtitle', 'Insights could not be refreshed. Retrying…');
    }
  }).finally(scheduleAnalyticsRefresh);
  return null;
}

function cachedInsights(data, api) {
  const entries = data.entries || [];
  const phrases = data.phrases || [];
  const now = Date.now();
  if (insightsCache && insightsCache.range === insightsRange && insightsCache.year === insightsYear
      && insightsCache.phraseCount === phrases.length && now >= insightsCache.now && now < insightsCache.expires
      && entries.length === insightsCache.entries.length && entries.every((entry, i) => {
        const previous = insightsCache.entries[i];
        return INSIGHTS_ENTRY_FIELDS.every(field => entry[field] === previous[field])
          && (Array.isArray(entry.learnedPairs) ? entry.learnedPairs.length : 0) === previous.pairCount;
      })) return insightsCache.result;

  // The result changes when a rolling window loses an entry or the calendar
  // reaches a new day, even with no new history. Expire at that boundary so
  // caching cannot leave the range, streak, heatmap, or app trends stale.
  const tomorrow = new Date(now);
  tomorrow.setHours(24, 0, 0, 0);
  let expires = tomorrow.getTime();
  const span = (insightsRange === '7d' ? 7 : 30) * 24 * 3600 * 1000;
  const values = entries.map(entry => {
    const ts = Number(entry.ts);
    for (const boundary of [ts, ts + span + 1, ts + 2 * span + 1]) {
      if (boundary > now) expires = Math.min(expires, boundary);
    }
    const value = { pairCount: Array.isArray(entry.learnedPairs) ? entry.learnedPairs.length : 0 };
    for (const field of INSIGHTS_ENTRY_FIELDS) value[field] = entry[field];
    return value;
  });
  const result = api.computeInsights(entries, phrases, insightsRange, now, { year: insightsYear });
  insightsCache = {
    range: insightsRange, year: result.milestones ? result.milestones.year : null,
    phraseCount: phrases.length, entries: values, expires, now, result,
  };
  return result;
}

function renderInsights(payload) {
  const api = globalThis.voxdenInsights;
  if (!api) return;
  // The insights pane recomputes several passes over the whole history and
  // rebuilds a hundred-cell heatmap. While it is not on screen that is pure
  // waste, so it waits until the pane is opened.
  if (view !== 'insights' || document.hidden) return;
  const data = payload || lastPayload || {};
  const tips = suggestionsOn(data);
  const ins = data.usageStats ? cachedServerInsights(data) : cachedInsights(data, api);
  renderInsVoiceProfile(data);
  if (!ins) {
    scheduleAnalyticsRefresh();
    return;
  }
  // The year the page settled on, so a stale choice (a year with no history
  // in a fresh account) does not stick.
  insightsYear = ins.milestones ? ins.milestones.year : null;
  const reveal = insightsReveal && !prefersReducedMotion();
  insightsReveal = false;

  insSetText('ins-subtitle', ins.subtitle);
  insSetText('ins-summary-words', ins.volume.words.toLocaleString());
  insSetText('ins-summary-sessions', ins.volume.dictations.toLocaleString());
  insSetText('ins-summary-streak', ins.rhythm.currentStreak + (ins.rhythm.currentStreak === 1 ? ' day' : ' days'));
  renderInsMilestones(ins.milestones, ins.years || [], tips, reveal);
  renderInsPace(ins.pace, tips, reveal);
  renderInsSaved(ins.pace, tips, reveal);
  renderInsFixes(ins.fixes, tips, reveal);
  renderInsWhere(ins.where, tips, reveal);
  renderInsRhythm(ins.rhythm);
  renderInsVoice(ins, tips);
  insPlayReveal(reveal);
  scheduleAnalyticsRefresh();
}

// Cards settle in with a short stagger and the heatmap sweeps in by column.
// Both are CSS animations keyed off a class, so re-adding the class (after a
// reflow, or the browser coalesces the change) is what replays them.
function insPlayReveal(reveal) {
  const grids = [document.getElementById('ins-tab-usage'), document.getElementById('ins-tab-voice')];
  const heat = document.getElementById('ins-heat-grid');
  for (const grid of grids) {
    if (!grid) continue;
    grid.classList.remove('is-revealing');
    grid.querySelectorAll('.ins-card').forEach((card, i) => card.style.setProperty('--i', String(i)));
  }
  if (heat) heat.classList.remove('is-revealing');
  if (!reveal) return;
  void document.body.offsetWidth;
  for (const grid of grids) if (grid) grid.classList.add('is-revealing');
  if (heat) heat.classList.add('is-revealing');
}

// A number that counts up to its value the first time the pane is opened.
// Everything after that -- a broadcast while the pane is open, a range
// change -- sets it outright.
function insCountUp(id, value, format, animate) {
  const el = document.getElementById(id);
  if (!el) return;
  const fmt = typeof format === 'function' ? format : (v) => Math.round(v).toLocaleString();
  if (!animate || !Number.isFinite(value) || value <= 0) {
    el.textContent = fmt(Number.isFinite(value) ? value : 0);
    return;
  }
  const start = performance.now();
  const duration = 760;
  const step = (t) => {
    const p = Math.min(1, (t - start) / duration);
    el.textContent = fmt(value * easeOutExpo(p));
    if (p < 1) requestAnimationFrame(step);
    else el.textContent = fmt(value);
  };
  requestAnimationFrame(step);
}

function setInsightsTab(name) {
  for (const btn of document.querySelectorAll('.ins-tab')) {
    const on = btn.dataset.tab === name;
    btn.classList.toggle('is-active', on);
    btn.setAttribute('aria-selected', on ? 'true' : 'false');
  }
  const usage = document.getElementById('ins-tab-usage');
  const voice = document.getElementById('ins-tab-voice');
  if (usage) usage.hidden = name !== 'usage';
  if (voice) voice.hidden = name !== 'voice';
}

// What the feed was last built from. Every broadcast carries the whole
// history, and most broadcasts -- a setting toggled, a download ticking over
// a percent -- change none of it; rebuilding four hundred cards and their
// listeners for those was the largest single cost in this window.
let feedSignature = '';
let feedDeferred = false;

function feedSignatureFor(entries, q) {
  let sig = q + '|' + entries.length;
  for (const e of entries) sig += '|' + e.id + ':' + (e.audio ? 'a' : '') + ':' + (e.text || '') + ':' + ((e.polished && e.polished.text) || '');
  return sig;
}

let feedLimit = 400;
let feedQuery = '';
function renderFeed(data, all) {
  const q = query.trim().toLowerCase();
  if (q !== feedQuery) { feedQuery = q; feedLimit = 400; }
  const matches = q ? all.filter((e) => ((e.text || '') + '\n' + ((e.polished && e.polished.text) || '')).toLowerCase().includes(q)) : all;
  const entries = matches.slice(0, feedLimit);

  renderFeedEmpty(data, all, entries, q);
  if (dictationSearch) dictationSearch.setCount(q ? matches.length.toLocaleString() + ' of ' + all.length.toLocaleString() : '');

  if (editingCardId()) {
    // The edit in progress owns the DOM. Remember that a rebuild is owed so
    // the next render after the edit ends does not skip it as unchanged.
    feedDeferred = true;
    return;
  }

  const sig = feedSignatureFor(entries, q) + '|' + matches.length;
  if (!feedDeferred && sig === feedSignature) return;
  feedSignature = sig;
  feedDeferred = false;

  // The cards are about to be replaced, and the menu and player hang off them.
  closeCardMenu();
  stopActivePlayer();
  groupsEl.innerHTML = '';
  let currentDay = null;
  for (const entry of entries) {
    const day = dayLabel(entry.ts);
    if (day !== currentDay) {
      currentDay = day;
      const h = document.createElement('div');
      h.className = 'day';
      h.textContent = day;
      groupsEl.appendChild(h);
    }
    groupsEl.appendChild(buildCard(entry));
  }
  if (matches.length > entries.length) {
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'btn-secondary';
    more.id = 'history-show-more';
    more.textContent = 'Show earlier dictations';
    more.addEventListener('click', () => { feedLimit += 400; renderFeed(data, all); });
    groupsEl.appendChild(more);
  }
}

let dashboardRenderPending = false;

// --- Polish ---------------------------------------------------------------------
// Any text, or a recent dictation, rewritten as clean writing by Voxden Cloud.
// Pro only, paid from the cloud credits. What a polish costs is asked of main
// as the words change (src/polish.js polishQuote) and shown on the button
// before anything is sent.
const polishStudioEl = document.getElementById('polish-studio');
const polishInputEl = document.getElementById('polish-input');
const polishRunEl = document.getElementById('polish-run');
const polishRunLabelEl = document.getElementById('polish-run-label');
const polishRunCostEl = document.getElementById('polish-run-cost');
const polishWordsEl = document.getElementById('polish-words');
const polishClearEl = document.getElementById('polish-clear');
const polishOutputEl = document.getElementById('polish-output');
const polishStatusEl = document.getElementById('polish-status');
const polishCopyEl = document.getElementById('polish-copy');
const polishChangesEl = document.getElementById('polish-changes');
const polishErrorEl = document.getElementById('polish-error');
const polishBalanceEl = document.getElementById('polish-balance');
const polishRecentsEl = document.getElementById('polish-recents');
const polishLockEl = document.getElementById('polish-lock');
const polishLockTitleEl = document.getElementById('polish-lock-title');
const polishLockCopyEl = document.getElementById('polish-lock-copy');
const polishLockActionEl = document.getElementById('polish-lock-action');
const navPolishProEl = document.querySelector('#nav-polish .nav-pro');
const polishNoteTitleEl = document.getElementById('polish-note-title');
// Polish, Grammar and Tighten: three buttons, one text, one price.
const polishModeButtons = {
  polish: polishRunEl,
  grammar: document.getElementById('polish-grammar'),
  tighten: document.getElementById('polish-tighten'),
};
const POLISH_DIFF_MAX_WORDS = 800;

// A dictation picked from history: polishing it also updates its entry.
let polishSource = null;
let polishResult = null;
let polishBusy = false;
let polishQuote = null;
let polishQuoteTimer = 0;
let polishQuoteSeq = 0;
let polishRecentsKey = '';

function polishAppName(exe) {
  const base = String(exe || '').replace(/\.exe$/i, '').trim();
  if (!base) return '';
  return base.length <= 3 ? base.toUpperCase() : base[0].toUpperCase() + base.slice(1);
}

function polishCountLabel(words) {
  return words === 1 ? '1 word' : Number(words || 0).toLocaleString() + ' words';
}

function setPolishState(state) {
  if (polishStudioEl) polishStudioEl.dataset.state = state;
}

function renderPolishRecents(entries) {
  if (!polishRecentsEl) return;
  const recent = (entries || []).filter((e) => e && String(e.text || '').trim().split(/\s+/).length >= 3).slice(0, 3);
  const key = recent.map((e) => e.id + ':' + e.text.length).join('|') + '|' + (polishSource ? polishSource.entryId : '');
  if (key === polishRecentsKey) return;
  polishRecentsKey = key;
  polishRecentsEl.textContent = '';
  if (!recent.length) {
    const empty = document.createElement('span');
    empty.className = 'polish-recents-empty';
    empty.textContent = 'Your recent dictations show up here.';
    polishRecentsEl.appendChild(empty);
    return;
  }
  for (const entry of recent) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'polish-recent';
    button.setAttribute('aria-pressed', String(!!polishSource && polishSource.entryId === entry.id));
    button.title = entry.text;
    const app = polishAppName(entry.exe);
    if (app) {
      const tag = document.createElement('span');
      tag.className = 'polish-recent-app';
      tag.textContent = app;
      button.appendChild(tag);
    }
    const words = document.createElement('span');
    words.className = 'polish-recent-text';
    words.textContent = entry.text;
    button.appendChild(words);
    button.addEventListener('click', () => {
      if (polishBusy || !polishInputEl || polishInputEl.disabled) return;
      polishInputEl.value = entry.text;
      polishSource = { entryId: entry.id, text: entry.text };
      polishRecentsKey = '';
      renderPolishRecents((lastPayload && lastPayload.entries) || []);
      onPolishInput();
      polishInputEl.focus();
    });
    polishRecentsEl.appendChild(button);
  }
}

// Behind the Pro card, the studio shows what Polish does, on an example rather
// than an empty box. Whatever was in the box waits aside and comes back with
// the plan.
const POLISH_EXAMPLE = {
  before: 'um so I was thinking we should uh ship the new flow bar this week, you know, and then like test it with five users before the the release',
  after: 'I was thinking we should ship the new flow bar this week, then test it with five users before the release.',
};
let polishExampleDraft = null;

function showPolishExample() {
  if (polishExampleDraft === null) polishExampleDraft = polishInputEl.value;
  polishInputEl.value = POLISH_EXAMPLE.before;
  polishOutputEl.textContent = POLISH_EXAMPLE.after;
  polishNoteTitleEl.textContent = polishModeWords('polish').done;
  polishStatusEl.textContent = '';
  polishCopyEl.hidden = true;
  polishChangesEl.hidden = true;
}

function hidePolishExample() {
  if (polishExampleDraft === null) return;
  polishInputEl.value = polishExampleDraft;
  polishExampleDraft = null;
  renderPolishResult();
}

function renderPolish(data) {
  if (!polishStudioEl) return;
  const account = (data && data.account) || null;
  const signedIn = !!(account && account.signedIn);
  const pro = signedIn && account.plan === 'pro';
  // The sidebar's Pro tag is a reason to look, so a Pro account does not see it.
  if (navPolishProEl) navPolishProEl.hidden = pro;
  polishStudioEl.classList.toggle('is-locked', !pro);
  polishLockEl.hidden = pro;
  polishInputEl.disabled = !pro;
  if (pro) hidePolishExample();
  else showPolishExample();
  if (!signedIn) {
    polishLockTitleEl.textContent = 'Sign in to polish';
    polishLockCopyEl.textContent = 'Polish is part of Voxden Pro. Sign in to use it on your dictations and on anything you paste here.';
    polishLockActionEl.textContent = 'Sign in';
    polishLockActionEl.dataset.target = 'account';
  } else if (!pro) {
    polishLockTitleEl.textContent = 'Polish is part of Pro';
    polishLockCopyEl.textContent = 'Turn any rough dictation into clean writing in a second, from the flow bar or right here. Each polish comes out of your cloud credits.';
    polishLockActionEl.innerHTML = 'Upgrade to Pro <span aria-hidden="true">↗</span>';
    polishLockActionEl.dataset.target = 'billing';
  }
  const cloud = account && account.cloud;
  const remaining = cloud && Number(cloud.creditsCap) > 0 ? Math.max(0, Number(cloud.creditsRemaining)) : null;
  polishBalanceEl.hidden = !pro || remaining === null || !Number.isFinite(remaining);
  if (!polishBalanceEl.hidden) {
    const left = Math.floor(remaining * 100) / 100;
    polishBalanceEl.textContent = left.toLocaleString(undefined, { maximumFractionDigits: 2 }) + (left === 1 ? ' credit left' : ' credits left');
  }
  renderPolishRecents((data && data.entries) || []);
  if (view === 'polish') schedulePolishQuote(0);
}

function schedulePolishQuote(delay) {
  clearTimeout(polishQuoteTimer);
  polishQuoteTimer = setTimeout(refreshPolishQuote, delay);
}

async function refreshPolishQuote() {
  if (!polishInputEl || !window.voxden || typeof window.voxden.polishQuote !== 'function') return;
  const text = polishInputEl.value;
  const seq = ++polishQuoteSeq;
  let quote = null;
  try { quote = await window.voxden.polishQuote(text); } catch (_) { quote = null; }
  if (seq !== polishQuoteSeq) return;
  polishQuote = quote;
  const words = quote ? quote.words : 0;
  polishWordsEl.textContent = polishCountLabel(words);
  polishClearEl.hidden = !polishInputEl.value.length;
  polishRunCostEl.textContent = words > 0 && quote ? quote.label : '';
  for (const [mode, button] of Object.entries(polishModeButtons)) {
    if (!button) continue;
    button.disabled = polishBusy || !quote || !quote.ok;
    if (mode !== 'polish') button.title = words > 0 && quote ? quote.label + ', the same as Polish' : '';
  }
  let hint = '';
  if (quote && quote.reason === 'cap') hint = 'Not enough cloud credits left. This polish needs ' + quote.label + '.';
  else if (quote && quote.reason === 'long') hint = 'Polish takes up to ' + Number(quote.maxWords).toLocaleString() + ' words at a time.';
  if (!polishBusy) showPolishError(hint);
}

function onPolishInput() {
  if (polishSource && polishInputEl.value !== polishSource.text) {
    polishSource = null;
    polishRecentsKey = '';
    renderPolishRecents((lastPayload && lastPayload.entries) || []);
  }
  schedulePolishQuote(120);
}

function showPolishError(message) {
  polishErrorEl.textContent = message || '';
  polishErrorEl.hidden = !message;
}

function escapePolishHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Word-level changes from what was said to what came back. A word that only
// changed its capital or punctuation is not a change a reader needs flagged.
function polishDiffHtml(before, after) {
  const a = String(before || '').split(/\s+/).filter(Boolean);
  const b = String(after || '').split(/\s+/).filter(Boolean);
  const key = (w) => w.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
  const dp = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i][j] = key(a[i]) === key(b[j]) ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (key(a[i]) === key(b[j])) { out.push(escapePolishHtml(b[j])); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push('<del>' + escapePolishHtml(a[i]) + '</del>'); i++; }
    else { out.push('<ins>' + escapePolishHtml(b[j]) + '</ins>'); j++; }
  }
  while (i < a.length) out.push('<del>' + escapePolishHtml(a[i++]) + '</del>');
  while (j < b.length) out.push('<ins>' + escapePolishHtml(b[j++]) + '</ins>');
  return out.join(' ');
}

function renderPolishResult() {
  const result = polishResult;
  polishNoteTitleEl.textContent = polishModeWords(result && result.mode).done;
  polishCopyEl.hidden = !result;
  const words = result ? String(result.before).split(/\s+/).filter(Boolean).length : 0;
  polishChangesEl.hidden = !result || words > POLISH_DIFF_MAX_WORDS;
  if (!result) {
    polishOutputEl.textContent = '';
    polishStatusEl.textContent = '';
    return;
  }
  const showChanges = polishChangesEl.getAttribute('aria-pressed') === 'true' && !polishChangesEl.hidden;
  if (showChanges) polishOutputEl.innerHTML = polishDiffHtml(result.before, result.after);
  else polishOutputEl.textContent = result.after;
  polishStatusEl.textContent = 'Used ' + (result.credits === 1 ? '1 credit' : result.credits + ' credits')
    + (result.entryId ? ' · saved to this dictation' : '');
}

async function runPolishPage(mode) {
  const button = polishModeButtons[mode];
  if (polishBusy || !button || button.disabled || !window.voxden) return;
  const text = polishInputEl.value.trim();
  if (!text) return;
  polishBusy = true;
  for (const b of Object.values(polishModeButtons)) if (b) b.disabled = true;
  const labelEl = mode === 'polish' ? polishRunLabelEl : button.querySelector('.polish-mode-label');
  const idleLabel = labelEl.textContent;
  labelEl.textContent = polishModeWords(mode).busy;
  button.classList.add('is-running');
  showPolishError('');
  setPolishState('busy');
  const fromEntry = polishSource && polishSource.text === polishInputEl.value ? polishSource.entryId : '';
  let res = null;
  try {
    res = fromEntry ? await window.voxden.polishEntry(fromEntry, mode) : await window.voxden.polishText(text, mode);
  } catch (_) {
    res = { ok: false, message: 'Polish did not work this time. Nothing was charged.' };
  }
  polishBusy = false;
  labelEl.textContent = idleLabel;
  button.classList.remove('is-running');
  if (res && res.ok) {
    polishResult = { before: text, after: res.text, credits: res.credits, entryId: fromEntry, mode };
    if (fromEntry) polishSource = { entryId: fromEntry, text: polishInputEl.value };
    renderPolishResult();
    setPolishState('');
    void polishStudioEl.offsetWidth;
    setPolishState('done');
  } else {
    setPolishState('idle');
    showPolishError((res && res.message) || 'Polish did not work this time. Nothing was charged.');
  }
  schedulePolishQuote(0);
}

if (polishStudioEl) {
  polishInputEl.addEventListener('input', onPolishInput);
  polishInputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      runPolishPage('polish');
    }
  });
  for (const [mode, button] of Object.entries(polishModeButtons)) {
    if (button) button.addEventListener('click', () => runPolishPage(mode));
  }
  polishClearEl.addEventListener('click', () => {
    polishInputEl.value = '';
    polishSource = null;
    polishRecentsKey = '';
    renderPolishRecents((lastPayload && lastPayload.entries) || []);
    schedulePolishQuote(0);
    polishInputEl.focus();
  });
  polishChangesEl.addEventListener('click', () => {
    const on = polishChangesEl.getAttribute('aria-pressed') !== 'true';
    polishChangesEl.setAttribute('aria-pressed', String(on));
    polishChangesEl.textContent = on ? 'Hide changes' : 'Show changes';
    renderPolishResult();
  });
  polishCopyEl.addEventListener('click', async () => {
    if (!polishResult) return;
    try {
      await navigator.clipboard.writeText(polishResult.after);
      polishCopyEl.textContent = 'Copied';
      polishCopyEl.classList.add('is-done');
      setTimeout(() => {
        polishCopyEl.textContent = 'Copy';
        polishCopyEl.classList.remove('is-done');
      }, 1400);
    } catch (_) {
      polishStatusEl.textContent = 'Could not copy. Select the text and press Ctrl+C.';
    }
  });
  polishLockActionEl.addEventListener('click', () => openSettingsTarget(polishLockActionEl.dataset.target || 'billing'));
}

function render(payload) {
  if (payload) lastPayload = payload;
  // Before the early return below: the wording has to be right even when the
  // first snapshot arrives while the window is closed to the tray.
  applyPlatformCopy(platformOf(lastPayload));
  window.VoxdenThemeSettings?.render(payload);
  // This renderer remains alive after its native window closes to the tray.
  // Keep the newest snapshot, but do not build invisible cards or charts for
  // every completed dictation or download tick. Opening it renders once.
  if (document.hidden) {
    dashboardRenderPending = true;
    return;
  }
  dashboardRenderPending = false;
  const data = lastPayload || {};
  const all = data.entries || [];

  renderGreeting(data);
  renderSidebar(data);
  renderCloudCredits(data);
  renderNotifications(data);
  renderSettings(data);
  renderWritingStyles(data);
  renderPolish(data);
  if (view === 'dictation') renderStats(all, data);
  renderDictionary(data);
  renderInsights(data);
  if (view === 'dictation') renderRecoveries(data);
  if (view === 'dictation') renderFeed(data, all);
}

// Looping CSS animations (the greeting icon, the hero caret) are gated on this
// class, so a hidden or minimised window animates nothing.
function syncPageHidden() {
  document.documentElement.classList.toggle('is-page-hidden', document.hidden);
}
syncPageHidden();

document.addEventListener('visibilitychange', () => {
  syncPageHidden();
  syncVocabFix();
  syncFeedbackMotion();
  if (!document.hidden && (dashboardRenderPending || lastPayload && lastPayload.usageStats)) render(null);
  else scheduleAnalyticsRefresh();
});

for (const btn of navButtons) {
  btn.addEventListener('click', () => {
    if (btn === navSettingsBtn) {
      if (settingsOpen) closeSettings();
      else openSettings();
      return;
    }
    if (btn === navHelpBtn) {
      if (helpMenuOpen) closeHelpMenu();
      else openHelpMenu();
      return;
    }
    setView(btn.dataset.view);
  });
}
const sidebarCreditsBtn = document.getElementById('sidebar-credits');
if (sidebarCreditsBtn) {
  sidebarCreditsBtn.addEventListener('click', () => openSettingsTarget('billing'));
}

document.getElementById('home-shortcut').addEventListener('click', openShortcutsDialog);
for (const button of document.querySelectorAll('[data-preview-cat]')) {
  button.addEventListener('click', () => {
    previewCategory = button.dataset.previewCat;
    renderStylePreview(lastPayload || {});
  });
}
const previewTonesEl = document.querySelector('.preview-tones');
for (const button of document.querySelectorAll('[data-preview-tone]')) {
  button.addEventListener('click', () => {
    patchSettings({ writingStyles: { [previewCategory]: button.dataset.previewTone } });
  });
}
if (previewTonesEl) {
  previewTonesEl.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    const buttons = Array.from(previewTonesEl.querySelectorAll('[data-preview-tone]'));
    const current = buttons.indexOf(document.activeElement);
    if (current < 0) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
      : (current + (event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next].focus();
    buttons[next].click();
  });
}

function openDashboardInsight(cardId, tab) {
  setView('insights');
  setInsightsTab(tab || 'usage');
  requestAnimationFrame(() => {
    const target = document.getElementById(cardId);
    if (!target) return;
    target.classList.remove('is-dashboard-target');
    void target.offsetWidth;
    target.classList.add('is-dashboard-target');
    target.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'center' });
    target.focus({ preventScroll: true });
    setTimeout(() => target.classList.remove('is-dashboard-target'), 950);
  });
}

if (vuCardEl) {
  vuCardEl.addEventListener('click', () => openDashboardInsight('ins-voice-profile-card', 'voice'));
  vuCardEl.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    openDashboardInsight('ins-voice-profile-card', 'voice');
  });
}

if (dmWpmMetricEl) {
  dmWpmMetricEl.addEventListener('click', () => openDashboardInsight('ins-pace-card'));
}

if (dmSavedMetricEl) {
  dmSavedMetricEl.addEventListener('click', () => openDashboardInsight('ins-saved-card'));
}

if (sidebarToggleEl) {
  sidebarToggleEl.addEventListener('click', () => toggleSidebar());
}

settingsOverlay.addEventListener('click', (e) => {
  if (e.target === settingsOverlay) closeSettings();
});

if (settingsCloseBtn) {
  settingsCloseBtn.addEventListener('click', () => closeSettings());
}

shortcutsChangeBtn.addEventListener('click', openShortcutsDialog);
shortcutsCloseBtn.addEventListener('click', () => closeShortcutsDialog());
shortcutsDialog.addEventListener('cancel', event => {
  event.preventDefault();
  closeShortcutsDialog();
});
shortcutsDialog.addEventListener('click', event => {
  if (event.target !== shortcutsDialog) return;
  const rect = shortcutsDialog.getBoundingClientRect();
  if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) {
    closeShortcutsDialog();
  }
});

for (const btn of settingsCatButtons) {
  btn.addEventListener('click', () => setSettingsCat(btn.dataset.cat));
}
settingsDetailEl.addEventListener('scroll', repositionSettingsSelects);
window.addEventListener('resize', repositionSettingsSelects);

// A round search button that opens into a field. At rest it is a 34px circle;
// opened, it is a 240px field with the query, a result count and a close
// button. Esc or close collapses it and clears the filter. Any page can use
// one: pass the wrapper (.round-search) and what clearing the query means.
function setupRoundSearch(root, { onClear } = {}) {
  if (!root) return null;
  const toggle = root.querySelector('.round-search-toggle');
  const field = root.querySelector('.round-search-field');
  const input = root.querySelector('input');
  const count = root.querySelector('.round-search-count');
  const closeBtn = root.querySelector('.round-search-close');
  if (!toggle || !field || !input) return null;
  const api = {
    get isOpen() { return root.classList.contains('is-open'); },
    open() {
      if (!api.isOpen) {
        root.classList.add('is-open');
        field.hidden = false;
        toggle.hidden = true;
        toggle.setAttribute('aria-expanded', 'true');
      }
      input.focus();
      input.select();
    },
    close({ restoreFocus = true } = {}) {
      const hadFocus = root.contains(document.activeElement);
      const hadQuery = input.value !== '';
      input.value = '';
      api.setCount('');
      root.classList.remove('is-open');
      field.hidden = true;
      toggle.hidden = false;
      toggle.setAttribute('aria-expanded', 'false');
      if (hadQuery && onClear) onClear();
      if (restoreFocus && hadFocus) toggle.focus();
    },
    setCount(text) { if (count) count.textContent = text || ''; },
  };
  toggle.addEventListener('click', () => api.open());
  if (closeBtn) closeBtn.addEventListener('click', () => api.close());
  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    api.close();
  });
  return api;
}

const dictationSearch = setupRoundSearch(document.getElementById('dictation-search'), {
  onClear() {
    query = '';
    clearTimeout(searchTimer);
    searchTimer = 0;
    const data = lastPayload || {};
    renderFeed(data, data.entries || []);
  },
});

// Search only filters the feed; nothing else in the window reads the query.
// Debounced, because a rebuild per keystroke of a long history is what made
// typing in this box feel like typing through treacle.
let searchTimer = 0;
searchEl.addEventListener('input', () => {
  query = searchEl.value || '';
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    searchTimer = 0;
    const data = lastPayload || {};
    renderFeed(data, data.entries || []);
  }, 90);
});

const dictionarySearch = setupRoundSearch(document.getElementById('dictionary-search'), {
  onClear() {
    dictQuery = '';
    renderDictionary(lastPayload || {});
  },
});

if (dictSearchEl) {
  dictSearchEl.addEventListener('input', () => {
    dictQuery = dictSearchEl.value || '';
    renderDictionary(lastPayload || {});
  });
}

// Ctrl+F (Cmd+F on a Mac) opens the search of whichever page has one. Not
// while settings or a dialog covers the page, where it would focus a field
// the user cannot see.
document.addEventListener('keydown', (event) => {
  if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
  if (String(event.key).toLowerCase() !== 'f') return;
  const search = view === 'dictation' ? dictationSearch : view === 'dictionary' ? dictionarySearch : null;
  if (!search || settingsOpen || capturingShortcutKind || document.querySelector('dialog[open]')) return;
  if (vocabOverlayEl && !vocabOverlayEl.hidden) return;
  event.preventDefault();
  search.open();
});

if (dictFormEl) {
  dictFormEl.addEventListener('submit', submitDictForm);
}

if (dictFromEl) dictFromEl.addEventListener('input', () => setDictError(''));
if (dictToEl) dictToEl.addEventListener('input', () => setDictError(''));
if (dictToMapEl) dictToMapEl.addEventListener('input', () => setDictError(''));
if (dictAddNewEl) dictAddNewEl.addEventListener('click', () => openVocabModal());
if (vocabCancelEl) vocabCancelEl.addEventListener('click', closeVocabModal);
if (vocabMisspellEl) {
  vocabMisspellEl.addEventListener('change', () => {
    setDictError('');
    syncVocabFields();
    const focusEl = dictMisspellOn() ? dictFromEl : dictToEl;
    if (focusEl) focusEl.focus();
  });
}
if (vocabOverlayEl) {
  vocabOverlayEl.addEventListener('click', (e) => {
    if (e.target === vocabOverlayEl) closeVocabModal();
  });
}
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && vocabOverlayEl && !vocabOverlayEl.hidden) {
    e.preventDefault();
    closeVocabModal();
  }
});
for (const btn of document.querySelectorAll('[data-dict-tab]')) {
  btn.addEventListener('click', () => {
    dictTab = btn.dataset.dictTab || 'all';
    for (const b of document.querySelectorAll('[data-dict-tab]')) {
      const on = b === btn;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    }
    renderDictionary(lastPayload || {});
  });
}


for (const btn of document.querySelectorAll('.ins-range-btn')) {
  btn.addEventListener('click', () => {
    insightsRange = btn.dataset.range || 'all';
    for (const b of document.querySelectorAll('.ins-range-btn')) {
      b.classList.toggle('is-active', b === btn);
    }
    renderInsights(null);
  });
}

for (const btn of document.querySelectorAll('.ins-tab')) {
  btn.addEventListener('click', () => setInsightsTab(btn.dataset.tab || 'usage'));
}

function patchSettings(patch) {
  // A save that fails must put the controls back the way the settings really
  // are, rather than leave a toggle showing a value that never persisted.
  return window.voxden.setSettings(patch).then(payload => {
    render(payload);
    return payload;
  }).catch(() => {
    render(null);
    return null;
  });
}

async function saveFlowStyle() {
  if (savingFlowStyle) return;
  savingFlowStyle = true;
  // Keep only the latest choice while a save is in flight. Serial saves keep
  // quick keyboard navigation from persisting an earlier selection last.
  while (pendingFlowStyle !== null) {
    const style = pendingFlowStyle;
    const result = await patchSettings({ flowBarStyle: style });
    if (pendingFlowStyle !== style) continue;
    pendingFlowStyle = null;
    if (flowStyleStatus) {
      flowStyleStatus.textContent = result ? '' : 'Couldn’t save this style. Please try again.';
      flowStyleStatus.hidden = !!result;
    }
  }
  savingFlowStyle = false;
  renderFlowStyle(lastPayload || {});
}

function pickFlowStyle(style) {
  if (!flowStyleCards.some(card => card.dataset.flowStyle === style)) return;
  if (pendingFlowStyle === style || (!savingFlowStyle && normalizeFlowStyle((lastPayload || {}).flowBarStyle) === style)) return;
  pendingFlowStyle = style;
  if (flowStyleStatus) flowStyleStatus.hidden = true;
  renderFlowStyle(lastPayload || {});
  saveFlowStyle();
}

async function saveFlowMotion() {
  if (savingFlowMotion) return;
  savingFlowMotion = true;
  while (pendingFlowMotion !== null) {
    const choice = pendingFlowMotion;
    const result = await patchSettings({ flowBarMotion: choice });
    if (pendingFlowMotion !== choice) continue;
    pendingFlowMotion = null;
    if (flowMotionStatus) {
      flowMotionStatus.textContent = result ? '' : 'Couldn’t save animations. Please try again.';
      flowMotionStatus.hidden = !!result;
    }
  }
  savingFlowMotion = false;
  renderFlowMotion(lastPayload || {});
}

if (flowMotionSelect && flowMotion) {
  flowMotionSelect.addEventListener('change', () => {
    pendingFlowMotion = flowMotion.normalizePreference(flowMotionSelect.value);
    if (flowMotionStatus) flowMotionStatus.hidden = true;
    renderFlowMotion(lastPayload || {});
    saveFlowMotion();
  });
}

for (const card of flowStyleCards) {
  card.addEventListener('click', () => pickFlowStyle(card.dataset.flowStyle));
}
if (flowStyleOptions) {
  flowStyleOptions.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    const current = flowStyleCards.indexOf(document.activeElement);
    if (current < 0) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? flowStyleCards.length - 1
      : (current + (event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : -1) + flowStyleCards.length) % flowStyleCards.length;
    flowStyleCards[next].focus();
    pickFlowStyle(flowStyleCards[next].dataset.flowStyle);
  });
}

function pickMode(mode) {
  patchSettings({ dictateMode: mode });
}

modeToggleEl.addEventListener('click', () => pickMode('toggle'));
modePttEl.addEventListener('click', () => pickMode('ptt'));

function pickQuality(quality) {
  patchSettings({ dictationQuality: quality });
}
if (qualityAutoEl) qualityAutoEl.addEventListener('click', () => pickQuality('auto'));
if (qualityFastEl) qualityFastEl.addEventListener('click', () => pickQuality('fast'));
if (qualityAccurateEl) qualityAccurateEl.addEventListener('click', () => pickQuality('accurate'));

if (settingInputs.verbatimMode) {
  settingInputs.verbatimMode.addEventListener('change', () => {
    patchSettings({ verbatimMode: settingInputs.verbatimMode.checked });
  });
}

if (settingInputs.verbatimDictionary) {
  settingInputs.verbatimDictionary.addEventListener('change', () => {
    patchSettings({ verbatimDictionary: settingInputs.verbatimDictionary.checked });
  });
}

if (settingInputs.numbersAsDigits) {
  settingInputs.numbersAsDigits.addEventListener('change', () => {
    patchSettings({ numbersAsDigits: settingInputs.numbersAsDigits.checked });
  });
}

if (settingInputs.autoCleanup) {
  settingInputs.autoCleanup.addEventListener('change', () => {
    patchSettings({ autoCleanup: settingInputs.autoCleanup.checked });
  });
}

shortcutChangeBtn.addEventListener('click', () => {
  if (capturingShortcutKind === 'shortcut') {
    stopShortcutCapture();
    return;
  }
  startShortcutCapture('shortcut');
});

if (pasteLastShortcutChangeBtn) {
  pasteLastShortcutChangeBtn.addEventListener('click', () => {
    if (capturingShortcutKind === 'pasteLastShortcut') {
      stopShortcutCapture();
      return;
    }
    startShortcutCapture('pasteLastShortcut');
  });
}

document.addEventListener('mousedown', (e) => {
  if (!e.target.closest('.custom-select')) {
    closeAllCustomSelects(null);
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    const openSelect = customSelectEls.find((sel) => {
      const state = customSelectMap.get(sel);
      return state && state.open;
    });
    if (openSelect) {
      e.preventDefault();
      e.stopPropagation();
      closeCustomSelect(openSelect, true);
      return;
    }
  }
  if (capturingShortcutKind) {
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') {
      stopShortcutCapture();
      return;
    }
    if (CAPTURE_MODIFIER_KEYS.includes(e.key)) {
      // Keep the widest set held at once. Pressing Ctrl then Win gives a Win
      // keydown already carrying ctrlKey, so the last one is the whole chord.
      const mods = modifierPartsOf(e);
      if (mods.length > captureMods.length) captureMods = mods;
      return;
    }
    captureSawKey = true;
    const accel = keyEventToAccelerator(e);
    if (!accel) {
      // Stay open so the next press can work, but say why this one did not.
      const problem = shortcutCaptureProblem(e);
      if (problem) setShortcutHint(problem, 'error');
      return;
    }
    const kind = capturingShortcutKind;
    stopShortcutCapture();
    patchSettings({ [kind]: accel });
    return;
  }
  if (e.key === 'Escape' && dictationLangDialog && dictationLangDialog.open) {
    e.preventDefault();
    closeDictationLangDialog();
    return;
  }
  if (e.key === 'Escape' && shortcutsDialog.open) {
    e.preventDefault();
    closeShortcutsDialog();
    return;
  }
  if (e.key === 'Escape' && settingsOpen) {
    e.preventDefault();
    closeSettings();
  }
}, true);

// A modifier-only chord is finished by letting go, not by pressing something.
document.addEventListener('keyup', (e) => {
  if (!capturingShortcutKind || captureSawKey) return;
  if (!CAPTURE_MODIFIER_KEYS.includes(e.key)) return;
  e.preventDefault();
  e.stopPropagation();
  if (captureMods.length < 2) {
    // One modifier on its own is not a shortcut, it is typing. Reset so the
    // next attempt starts clean instead of accumulating.
    if (captureMods.length) {
      setShortcutHint('Hold at least two keys, such as Ctrl and the Windows key.', 'error');
    }
    captureMods = [];
    return;
  }
  const kind = capturingShortcutKind;
  const accel = captureMods.join('+');
  stopShortcutCapture();
  patchSettings({ [kind]: accel });
}, true);

if (settingInputs.launchAtLogin) {
  settingInputs.launchAtLogin.addEventListener('change', () => {
    patchSettings({ launchAtLogin: settingInputs.launchAtLogin.checked });
  });
}
if (settingInputs.alwaysShowFlowBar) {
  settingInputs.alwaysShowFlowBar.addEventListener('change', () => {
    patchSettings({ alwaysShowFlowBar: settingInputs.alwaysShowFlowBar.checked });
  });
}
if (flowBarResetBtn) {
  flowBarResetBtn.addEventListener('click', () => {
    if (!window.voxden || typeof window.voxden.resetFlowBar !== 'function') return;
    flowBarResetBtn.disabled = true;
    window.voxden.resetFlowBar()
      .then(render)
      .catch(() => {})
      .finally(() => { flowBarResetBtn.disabled = false; });
  });
}
if (settingInputs.showInTaskbar) {
  settingInputs.showInTaskbar.addEventListener('change', () => {
    patchSettings({ showInTaskbar: settingInputs.showInTaskbar.checked });
  });
}
if (settingInputs.soundsEnabled) {
  settingInputs.soundsEnabled.addEventListener('change', () => {
    patchSettings({ soundsEnabled: settingInputs.soundsEnabled.checked });
  });
}
if (settingInputs.muteMusicWhileDictating) {
  settingInputs.muteMusicWhileDictating.addEventListener('change', () => {
    patchSettings({ muteMusicWhileDictating: settingInputs.muteMusicWhileDictating.checked });
  });
}
if (settingInputs.suggestionsEnabled) {
  settingInputs.suggestionsEnabled.addEventListener('change', () => {
    patchSettings({ suggestionsEnabled: settingInputs.suggestionsEnabled.checked });
  });
}
if (settingInputs.autoAddToDictionary) {
  settingInputs.autoAddToDictionary.addEventListener('change', () => {
    patchSettings({ autoAddToDictionary: settingInputs.autoAddToDictionary.checked });
  });
}
if (settingInputs.keepRecordings) {
  settingInputs.keepRecordings.addEventListener('change', () => {
    patchSettings({ keepRecordings: settingInputs.keepRecordings.checked });
  });
}
recordingsClearBtn.addEventListener('click', async () => {
  if (clearingRecordings || recordingsClearBtn.disabled) return;
  if (!(await askConfirm({
    title: 'Delete all saved recordings?',
    body: 'Your transcripts, training clips and exported WAV files will be kept. This cannot be undone.',
    confirmLabel: 'Delete',
  }))) return;
  clearingRecordings = true;
  recordingsClearStatusEl.hidden = true;
  renderRecordingsHint(lastPayload || {});
  stopActivePlayer();
  try {
    const result = await window.voxden.clearRecordings();
    if (result && result.snapshot) render(result.snapshot);
    const ok = !!(result && result.ok);
    recordingsClearStatusEl.textContent = ok ? 'Saved recordings deleted.'
      : (result && result.reason) || 'Recordings could not be deleted. Try again.';
    recordingsClearStatusEl.classList.toggle('is-error', !ok);
  } catch (_) {
    recordingsClearStatusEl.textContent = 'Recordings could not be deleted. Try again.';
    recordingsClearStatusEl.classList.add('is-error');
  } finally {
    clearingRecordings = false;
    recordingsClearStatusEl.hidden = false;
    renderRecordingsHint(lastPayload || {});
  }
});
if (settingInputs.keepTrainingAudio) {
  settingInputs.keepTrainingAudio.addEventListener('change', () => {
    patchSettings({ keepTrainingAudio: settingInputs.keepTrainingAudio.checked });
  });
}
if (settingInputs.useTunedModel) {
  settingInputs.useTunedModel.addEventListener('change', () => {
    patchSettings({ useTunedModel: settingInputs.useTunedModel.checked });
  });
}
if (settingInputs.asrDevice) {
  settingInputs.asrDevice.addEventListener('change', () => speechChangeProcessor(settingInputs.asrDevice.value));
}

// Parakeet runs different weights on an AMD or Intel GPU than on the
// processor. When the other precision is not on disk, ask first, download it
// with the row's own progress and Cancel, and set the processor only once it
// has landed: setting it first would leave dictation broken until then, and a
// cancel would leave it broken for good.
async function speechChangeProcessor(value) {
  const data = lastPayload || {};
  const next = ['cuda', 'directml', 'cpu'].includes(value) ? value : 'auto';
  const prev = speechDevice(data);
  if (next === prev || speechPending.has('processor')) return;
  const engine = asrEngineId(data.asrEngine);
  const nextComponent = speechComponent(engine, next);
  const item = speechPlanItem(data, nextComponent);
  const needsDownload = engine === 'parakeet' && nextComponent !== speechComponent(engine, prev) && item && !item.installed;
  speechPending.add('processor');
  try {
    if (!needsDownload) { await patchSettings({ asrDevice: next }); return; }
    settingInputs.asrDevice.value = prev;
    syncCustomSelect(settingInputs.asrDevice);
    const size = item.bytes ? formatSetupBytes(item.bytes) + ' ' : '';
    const yes = await askConfirm({
      title: next === 'directml' ? 'Switch Parakeet v3 to your AMD or Intel GPU?' : 'Switch Parakeet v3 back to the processor?',
      body: 'This needs a separate ' + size + 'download, and dictation on ' + thisDevice() + ' pauses until it finishes.',
      confirmLabel: 'Download and switch',
    });
    if (!yes) return;
    const snap = await speechInstallModel('parakeet', nextComponent);
    const done = snap && speechPlanItem(snap, nextComponent);
    if (done && done.installed) await patchSettings({ asrDevice: next });
  } finally {
    speechPending.delete('processor');
    render();
  }
}

if (speechAdvancedEl) {
  speechAdvancedEl.addEventListener('toggle', () => { if (!speechAdvancedEl.open) closeAllCustomSelects(); });
}
if (trainingClearBtn) {
  trainingClearBtn.addEventListener('click', async () => {
    trainingClearBtn.disabled = true;
    try {
      const next = await window.voxden.clearTrainingData();
      if (next) render(next);
      if (next && next.trainingError && trainingStatsEl) trainingStatsEl.textContent = next.trainingError;
    } catch (_) {
      if (trainingStatsEl) trainingStatsEl.textContent = 'Could not delete training recordings. Try again.';
    } finally {
      trainingClearBtn.disabled = false;
    }
  });
}
if (dictationLangOpenBtn) dictationLangOpenBtn.addEventListener('click', openDictationLangDialog);
if (dictationLangSearchEl) {
  dictationLangSearchEl.addEventListener('input', () => {
    applyDictationLangSearch();
  });
}
if (dictationLangGridEl) {
  dictationLangGridEl.addEventListener('click', (event) => {
    const tile = event.target.closest('[data-lang]');
    if (!tile || tile.disabled) return;
    toggleDictationLangDraft(tile.dataset.lang);
  });
}
if (dictationLangSelectedEl) {
  dictationLangSelectedEl.addEventListener('click', (event) => {
    const remove = event.target.closest('[data-remove]');
    if (remove) toggleDictationLangDraft(remove.dataset.remove);
  });
}
if (dictationLangSaveBtn) {
  dictationLangSaveBtn.addEventListener('click', () => {
    const draft = dictationLangDraft || [];
    if (!draft.length) {
      if (dictationLangErrorEl) {
        dictationLangErrorEl.hidden = false;
        dictationLangErrorEl.textContent = 'Pick at least one language.';
      }
      return;
    }
    patchSettings({ dictationLanguages: draft });
    closeDictationLangDialog();
  });
}
if (dictationLangCancelBtn) dictationLangCancelBtn.addEventListener('click', () => closeDictationLangDialog());
if (dictationLangDialog) {
  dictationLangDialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    closeDictationLangDialog();
  });
  dictationLangDialog.addEventListener('click', (event) => {
    if (event.target !== dictationLangDialog) return;
    const rect = dictationLangDialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) {
      closeDictationLangDialog();
    }
  });
}
if (settingInputs.microphone) {
  settingInputs.microphone.addEventListener('change', () => {
    patchSettings({ microphone: settingInputs.microphone.value });
  });
}

if (updateCheckBtn) {
  updateCheckBtn.addEventListener('click', () => {
    if (!window.voxden || !window.voxden.checkForUpdates) return;
    updateCheckBtn.disabled = true;
    // The reply is only the updater's status, not a snapshot. Rendered on its
    // own it wiped every setting back to its default on screen (the shortcut,
    // the toggles) until the next broadcast, so it is laid over the last one.
    window.voxden.checkForUpdates().then((status) => {
      render(Object.assign({}, lastPayload || {}, status || {}));
    }).catch(() => {
      if (updateCheckBtn) updateCheckBtn.disabled = false;
    });
  });
}
if (updateRestartBtn) {
  updateRestartBtn.addEventListener('click', () => {
    if (updateRestartBtn.disabled) return;
    updateRestartBtn.disabled = true;
    requestUpdateInstall().then(() => render());
  });
}
if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
  navigator.mediaDevices.addEventListener('devicechange', () => {
    if (settingsOpen && settingsCat === 'general') refreshMicrophones();
  });
}

initCustomSelects();
// Settings > Speech engines > Processor. The trigger is what people operate,
// so it is named by the row label plus its value; aria-labelledby outranks the
// value-only aria-label that syncCustomSelect keeps writing.
if (customSelectMap.has(settingInputs.asrDevice)) {
  const speechProcessorSelect = customSelectMap.get(settingInputs.asrDevice);
  speechProcessorSelect.label.id = 'speech-processor-value';
  speechProcessorSelect.trigger.setAttribute('aria-labelledby', 'speech-processor-label speech-processor-value');
}
setView('dictation');
setSettingsCat('general');
window.voxden.onHistory(render);
// The tray can point at a category or a row in General. Unknown targets are
// ignored so a stale menu entry cannot leave every panel hidden.
if (window.voxden.onOpenSettings) {
  window.voxden.onOpenSettings(openSettingsTarget);
}
window.voxden.loadApp().then((data) => {
  render(data);
  // The device list is for the tray and General; neither needs
  // it in the first frame, and opening the microphone is not free.
  setTimeout(refreshMicrophones, 1200);
}).catch(() => render(null));
window.voxden.appReady();

setInterval(() => {
  if (!document.hidden && view === 'dictation') renderGreeting(lastPayload || {});
}, 60000);

// --- Notifications ---------------------------------------------------------
// The badge counts what has not been read; the list holds everything that has
// not been cleared. Opening the panel is what marks things read, so the count
// answers "is there anything I have not looked at" rather than "how many rows
// are in there".

const NOTIF_ICONS = {
  feature: '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">'
    + '<path fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" d="M12 3.5 13.9 9l5.6 1.9-5.6 2L12 18.5l-1.9-5.6-5.6-2L10.1 9 12 3.5Z"/>'
    + '<path fill="currentColor" d="M18.6 3.4a.5.5 0 0 1 .95 0l.3.9.9.3a.5.5 0 0 1 0 .95l-.9.3-.3.9a.5.5 0 0 1-.95 0l-.3-.9-.9-.3a.5.5 0 0 1 0-.95l.9-.3.3-.9Z"/>'
    + '</svg>',
  model: '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">'
    + '<g fill="currentColor">'
    + '<rect x="3" y="10" width="2.6" height="4" rx="1.3"/>'
    + '<rect x="7.4" y="7.5" width="2.6" height="9" rx="1.3"/>'
    + '<rect x="11.8" y="4.5" width="2.6" height="15" rx="1.3"/>'
    + '<rect x="16.2" y="8.5" width="2.6" height="7" rx="1.3"/>'
    + '<rect x="20" y="10.5" width="2.6" height="3" rx="1.3"/>'
    + '</g></svg>',
  engine: '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">'
    + '<path fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" d="M13.2 2.8 5 13.4h5.2l-.6 7.8L18 10.6h-5.2l.4-7.8Z"/>'
    + '</svg>',
  credits: '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">'
    + '<circle cx="14.6" cy="9.4" r="6" fill="none" stroke="currentColor" stroke-width="1.75"/>'
    + '<path fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" d="M12.6 8.1a2.2 2.2 0 1 1 2 3.2"/>'
    + '<circle class="coin-front" cx="9.4" cy="14.6" r="6" stroke="currentColor" stroke-width="1.75"/>'
    + '<path fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" d="M9.4 11.9v5.4M7.6 13.4h3.2a1.1 1.1 0 0 1 0 2.2H7.9a1.1 1.1 0 0 0 0 2.2h3.3"/>'
    + '</svg>',
  update: '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">'
    + '<path fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" d="M12 4v10m0 0 3.6-3.6M12 14l-3.6-3.6M4.5 16.5v1.8A1.7 1.7 0 0 0 6.2 20h11.6a1.7 1.7 0 0 0 1.7-1.7v-1.8"/>'
    + '</svg>',
};

const NOTIF_DISMISS_ICON = '<svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">'
  + '<path fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" d="M4.4 4.4 11.6 11.6M11.6 4.4 4.4 11.6"/>'
  + '</svg>';

function notifItems(data) {
  return Array.isArray(data.notifications) ? data.notifications : [];
}

// The download in progress, drawn from the update status rather than from
// the store. It changes every second and is over within minutes, so it is a
// row while it lasts and nothing afterwards: it never counts as unread, it
// cannot be dismissed, and clearing the panel leaves it alone.
const LIVE_UPDATE_ID = 'update-download';

function liveUpdateItem(data) {
  if (!data || data.packaged === false || data.status !== 'downloading') return null;
  return {
    id: LIVE_UPDATE_ID,
    kind: 'update',
    live: true,
    title: 'Downloading ' + updateVersionLabel(data) + '…',
    body: 'Voxden keeps working while it downloads.',
    progress: Number.isFinite(data.progress) ? Math.max(0, Math.min(100, data.progress)) : null,
    ts: Date.now(),
    unread: false,
  };
}

// The stored "ready" row for the update that is waiting right now. An older
// row -- a version downloaded, never installed, since superseded -- keeps its
// plain copy; only the one the restart would actually install gets the button.
function isWaitingUpdateRow(item, data) {
  if (!item || typeof item.id !== 'string' || item.id.indexOf('update-ready:') !== 0) return false;
  if (!updateWaiting(data)) return false;
  return !data.availableVersion || item.id === 'update-ready:' + data.availableVersion;
}

function buildNotifItem(item, data) {
  const li = document.createElement('li');
  li.className = 'notif-item';
  li.dataset.id = item.id;
  if (item.live) li.classList.add('is-live');
  if (notifNewIds.has(item.id) || item.unread) li.classList.add('is-new');
  const waiting = isWaitingUpdateRow(item, data);

  const icon = document.createElement('span');
  icon.className = 'notif-icon' + (NOTIF_ICONS[item.kind] ? ' is-' + item.kind : '');
  icon.innerHTML = NOTIF_ICONS[item.kind] || NOTIF_ICONS.feature;
  li.appendChild(icon);

  const copy = document.createElement('div');
  copy.className = 'notif-copy';

  const title = document.createElement('span');
  title.className = 'notif-item-title';
  title.textContent = item.title || '';
  copy.appendChild(title);

  // A refused restart says why, in place of the row's own words, for as long
  // as the notice lasts.
  const bodyText = waiting && updateNotice ? updateNotice : item.body;
  if (bodyText) {
    const body = document.createElement('span');
    body.className = 'notif-item-body';
    body.textContent = bodyText;
    copy.appendChild(body);
  }
  if (item.live) {
    const track = document.createElement('span');
    track.className = 'notif-progress';
    track.setAttribute('role', 'progressbar');
    track.setAttribute('aria-valuemin', '0');
    track.setAttribute('aria-valuemax', '100');
    const bar = document.createElement('span');
    bar.className = 'notif-progress-bar';
    track.appendChild(bar);
    copy.appendChild(track);
  }

  const meta = document.createElement('span');
  meta.className = 'notif-meta';
  if (li.classList.contains('is-new')) {
    const dot = document.createElement('span');
    dot.className = 'notif-dot';
    meta.appendChild(dot);
  }
  const when = document.createElement('span');
  if (item.live) when.className = 'notif-progress-pct';
  else when.textContent = dayLabel(item.ts);
  meta.appendChild(when);
  if (waiting) {
    // The update that is downloaded and waiting: the one action in this
    // panel that is a button rather than a link, because it is the reason
    // the row exists.
    const restart = document.createElement('button');
    restart.type = 'button';
    restart.className = 'notif-open notif-restart';
    const installing = data && data.status === 'installing';
    restart.textContent = installing ? 'Restarting…' : 'Restart now';
    restart.disabled = !!installing;
    restart.addEventListener('click', () => {
      if (restart.disabled) return;
      restart.disabled = true;
      requestUpdateInstall().then(() => render());
    });
    meta.appendChild(restart);
  }
  // A settings pane that the markup does not have would open the dialog onto
  // nothing, so an action is only offered once its target is known to exist.
  const cat = !waiting && item.action && item.action.settings;
  if (cat && resolveSettingsTarget(cat)) {
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'notif-open';
    open.textContent = 'Open settings';
    open.addEventListener('click', () => {
      openSettingsTarget(cat);
    });
    meta.appendChild(open);
  }
  // Likewise a view: only offered when the window actually has that pane.
  const viewName = item.action && item.action.view;
  if (!cat && viewName && panes[viewName]) {
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'notif-open';
    open.textContent = 'Open';
    open.addEventListener('click', () => {
      closeNotifications();
      setView(viewName);
    });
    meta.appendChild(open);
  }
  copy.appendChild(meta);
  li.appendChild(copy);

  // Nothing to dismiss on a live row: it is not in the store, and it goes on
  // its own when the download ends.
  if (item.live) return li;

  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.className = 'notif-dismiss';
  dismiss.title = 'Dismiss';
  dismiss.setAttribute('aria-label', 'Dismiss notification');
  dismiss.innerHTML = NOTIF_DISMISS_ICON;
  dismiss.addEventListener('click', () => {
    if (!window.voxden || !window.voxden.dismissNotification) return;
    notifNewIds.delete(item.id);
    window.voxden.dismissNotification(item.id).then(render).catch(() => {});
  });
  li.appendChild(dismiss);

  return li;
}

// The live row's number moves once a second. The row is updated in place so
// the list is not rebuilt, and its entry animation not replayed, for every
// percent.
function syncLiveUpdateRow(live) {
  if (!live) return;
  const row = notifListEl.querySelector('.notif-item[data-id="' + LIVE_UPDATE_ID + '"]');
  if (!row) return;
  const title = row.querySelector('.notif-item-title');
  if (title && title.textContent !== live.title) title.textContent = live.title;
  const known = live.progress != null;
  const track = row.querySelector('.notif-progress');
  const bar = row.querySelector('.notif-progress-bar');
  const pct = row.querySelector('.notif-progress-pct');
  if (track) {
    track.classList.toggle('is-indeterminate', !known);
    if (known) track.setAttribute('aria-valuenow', String(live.progress));
    else track.removeAttribute('aria-valuenow');
  }
  if (bar) bar.style.width = known ? live.progress + '%' : '';
  if (pct) pct.textContent = known ? live.progress + '%' : 'Starting…';
}

function renderNotifications(data) {
  if (!notifBtnEl) return;
  const stored = notifItems(data);
  const live = liveUpdateItem(data);
  const items = live ? [live].concat(stored) : stored;
  const unread = Number(data.notificationsUnread) || 0;

  notifBtnEl.classList.toggle('has-unread', unread > 0);
  notifBadgeEl.hidden = unread === 0;
  notifBadgeEl.textContent = unread > 99 ? '99+' : String(unread);
  notifBtnEl.setAttribute(
    'aria-label',
    unread > 0 ? 'Notifications, ' + unread + ' unread' : 'Notifications',
  );

  // Clear all works on the store; a live row alone leaves it nothing to do.
  notifClearEl.hidden = stored.length === 0;
  notifEmptyEl.hidden = items.length > 0;

  const signature = items
    .map((item) => item.id + ':' + (notifNewIds.has(item.id) || item.unread ? '1' : '0')
      + (isWaitingUpdateRow(item, data) ? ':' + data.status + (updateNotice ? ':notice' : '') : ''))
    .join('|');
  if (signature !== notifSignature) {
    notifSignature = signature;
    notifListEl.innerHTML = '';
    for (const item of items) notifListEl.appendChild(buildNotifItem(item, data));
  }
  syncLiveUpdateRow(live);
}

function openNotifications() {
  if (notifOpen) return;
  notifOpen = true;
  notifPanelEl.hidden = false;
  notifBtnEl.classList.add('is-open');
  notifBtnEl.setAttribute('aria-expanded', 'true');
  notifNewIds = new Set(notifItems(lastPayload || {}).filter((i) => i.unread).map((i) => i.id));
  notifSignature = '';
  // Only the panel and its badge change here; the feed and the settings do
  // not need rebuilding to open a 300px panel.
  if (window.voxden && window.voxden.readNotifications) {
    window.voxden.readNotifications().then((data) => {
      if (data) lastPayload = data;
      renderNotifications(lastPayload || {});
    }).catch(() => renderNotifications(lastPayload || {}));
  } else {
    renderNotifications(lastPayload || {});
  }
}

function closeNotifications() {
  if (!notifOpen) return;
  notifOpen = false;
  notifPanelEl.hidden = true;
  notifBtnEl.classList.remove('is-open');
  notifBtnEl.setAttribute('aria-expanded', 'false');
  notifNewIds = new Set();
  notifSignature = '';
  renderNotifications(lastPayload || {});
}

if (notifBtnEl) {
  notifBtnEl.addEventListener('click', () => {
    if (notifOpen) closeNotifications();
    else openNotifications();
  });

  notifClearEl.addEventListener('click', () => {
    if (!window.voxden || !window.voxden.clearNotifications) return;
    notifNewIds = new Set();
    window.voxden.clearNotifications().then(render).catch(() => {});
  });

  // Anywhere outside the panel closes it, the bell included -- its own handler
  // has already run by then, so the toggle is not undone here.
  document.addEventListener('mousedown', (event) => {
    if (!notifOpen) return;
    if (notifPanelEl.contains(event.target) || notifBtnEl.contains(event.target)) return;
    closeNotifications();
  });

  // Bubble phase and no stopPropagation: Escape belongs to whatever dialog is
  // in front, and the settings overlay claims it in the capture phase before
  // this ever runs.
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !notifOpen) return;
    closeNotifications();
    notifBtnEl.focus();
  });
}
