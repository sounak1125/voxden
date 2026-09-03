'use strict';

const navButtons = document.querySelectorAll('.nav-item:not(.sidebar-toggle)');
const panes = {
  dictation: document.getElementById('view-dictation'),
  dictionary: document.getElementById('view-dictionary'),
  'writing-style': document.getElementById('view-writing-style'),
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
const vuCopyEl = document.getElementById('vu-copy');
const vuBarFillEl = document.getElementById('vu-bar-fill');
const vuBarEl = document.getElementById('vu-bar');
const vuMetaEl = document.getElementById('vu-meta');
const vuRingProgressEl = document.getElementById('vu-ring-progress');
const vuProfileEl = document.getElementById('vu-profile');
const vuGainEl = document.getElementById('vu-gain');

const VU_RING_LEN = 188.5;
const DM_SAVED_CEILING_MIN = 600;
const DM_COUNT_MS = 1100;

const dmWpmMetricEl = document.getElementById('dm-wpm-metric');
const dmSavedMetricEl = document.getElementById('dm-saved-metric');

const dmMetricsEl = document.getElementById('dictation-metrics');
const dmWpmContextEl = document.getElementById('dm-wpm-context');
const dmSavedContextEl = document.getElementById('dm-saved-context');
const dmWpmChartEl = document.getElementById('dm-wpm-chart');
const dmWpmLineEl = document.getElementById('dm-wpm-line');
const dmWpmAreaEl = document.getElementById('dm-wpm-area');
const dmWpmAvgEl = document.getElementById('dm-wpm-avg');
const dmWpmGuideEl = document.getElementById('dm-wpm-guide');
const dmWpmDotsEl = document.getElementById('dm-wpm-dots');
const dmWpmRangeEl = document.getElementById('dm-wpm-range');
const dmWpmBoundsEl = document.getElementById('dm-wpm-bounds');
const dmWpmMarkerEl = document.getElementById('dm-wpm-marker');
const dmWpmTooltipEl = document.getElementById('dm-wpm-tooltip');
const dmSavedFillEl = document.getElementById('dm-saved-fill');
const dmAnim = { wpm: null, savedMs: 0, wpmRaf: 0, savedRaf: 0 };
let dmPaceChartPoints = [];
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

const styleSegEls = Array.from(document.querySelectorAll('.style-seg'));
const wsRowsEl = document.querySelector('.ws-rows');
const verbatimDictRowEl = document.getElementById('verbatim-dict-row');
const sendSelectEls = Array.from(document.querySelectorAll('.ws-send-select'));
const speechSetupInstallBtn = document.getElementById('speech-setup-install');
const speechSetupCancelBtn = document.getElementById('speech-setup-cancel');
const speechSetupRemoveBtn = document.getElementById('speech-setup-remove');
const speechSetupStatusEl = document.getElementById('speech-setup-status');
const speechSetupHintEl = document.getElementById('speech-setup-hint');
const speechSetupProgressRowEl = document.getElementById('speech-setup-progress-row');
const speechSetupProgressEl = document.getElementById('speech-setup-progress');
const speechSetupProgressFillEl = document.getElementById('speech-setup-progress-fill');
const speechSetupProgressLabelEl = document.getElementById('speech-setup-progress-label');

const speechExtrasEl = document.getElementById('speech-extras');

const flowBarPositionRow = document.getElementById('flow-bar-position-row');
const flowBarResetBtn = document.getElementById('flow-bar-reset');

const settingInputs = {
  launchAtLogin: document.getElementById('set-launch-login'),
  alwaysShowFlowBar: document.getElementById('set-always-flow'),
  showInTaskbar: document.getElementById('set-taskbar'),
  soundsEnabled: document.getElementById('set-sounds'),
  muteMusicWhileDictating: document.getElementById('set-mute-music'),
  suggestionsEnabled: document.getElementById('set-suggestions'),
  verbatimMode: document.getElementById('set-verbatim'),
  verbatimDictionary: document.getElementById('set-verbatim-dictionary'),
  numbersAsDigits: document.getElementById('set-numbers-digits'),
  keepTrainingAudio: document.getElementById('set-training-audio'),
  keepRecordings: document.getElementById('set-keep-recordings'),
  useTunedModel: document.getElementById('set-tuned-model'),
  asrEngine: document.getElementById('asr-engine-select'),
  asrDevice: document.getElementById('asr-device-select'),
  dictationLanguage: document.getElementById('dictation-lang-select'),
  displayName: document.getElementById('set-display-name'),
  microphone: document.getElementById('mic-select'),
};

const tunedRowEl = document.getElementById('tuned-row');
const tunedHintEl = document.getElementById('tuned-hint');
const asrEngineHintEl = document.getElementById('asr-engine-hint');
const engineBannerEl = document.getElementById('engine-banner');
const engineBannerTextEl = document.getElementById('engine-banner-text');
const engineBannerBtnEl = document.getElementById('engine-banner-btn');
const engineBannerProgressEl = document.getElementById('engine-banner-progress');
const engineBannerFillEl = document.getElementById('engine-banner-fill');
const engineBannerPctEl = document.getElementById('engine-banner-pct');
const asrEngineProgressRowEl = document.getElementById('asr-engine-progress-row');
const asrEngineProgressEl = document.getElementById('asr-engine-progress');
const asrEngineProgressFillEl = document.getElementById('asr-engine-progress-fill');
const asrEngineProgressLabelEl = document.getElementById('asr-engine-progress-label');

const ASR_ENGINE_OPTIONS = {
  whisper: { name: 'Whisper large-v3', size: '~3 GB' },
  'qwen3-asr': { name: 'Qwen3-ASR 1.7B', size: '~4.7 GB' },
  parakeet: { name: 'Parakeet TDT 0.6B', size: '~0.6 GB' },
};

function asrEngineOptionLabel(id) {
  const opt = ASR_ENGINE_OPTIONS[id] || ASR_ENGINE_OPTIONS.whisper;
  return opt.name + ' \u00b7 ' + opt.size;
}

const ASR_ENGINE_ORDER = ['whisper', 'qwen3-asr', 'parakeet'];

// Mirrors DEVICE_LABELS in asr.js; a renderer cannot require it. One DirectX 12
// backend serves AMD and Intel, so the label names the badge on the machine
// rather than the API behind it.
const DEVICE_LABELS = { cuda: 'NVIDIA GPU', directml: 'AMD or Intel GPU', rocm: 'supported AMD GPU', cpu: 'CPU' };

// 'auto' arrives here too, from the --check that runs before a model is loaded.
// CPU is the honest guess: it is where every engine starts, and where all of
// them stay if no GPU answers.
function deviceLabel(value) {
  return DEVICE_LABELS[String(value || '').trim().toLowerCase()] || 'CPU';
}

function qwenLocation(selected, data) {
  if (selected !== 'qwen3-asr') return deviceLabel(data.device);
  const plan = data.qwenAccel || {};
  if (plan.verified && plan.backend && plan.backend !== 'cpu') {
    return plan.uiLabel || deviceLabel(data.device);
  }
  return 'CPU';
}

// Whether this PC can actually run an engine, per the sidecar's probe.
//
// Setup supplies all supported engines, so the selected model remains visible.
function asrEngineIsOffered(id, available) {
  // All three backends ship in the managed runtime. Missing files are setup
  // state, not a reason to silently remove the user's model from the picker.
  return ASR_ENGINE_ORDER.includes(id);
}

function syncAsrEngineSelectOptions(select, available) {
  if (!select) return;
  const wanted = ASR_ENGINE_ORDER.filter((id) => asrEngineIsOffered(id, available));
  const current = Array.prototype.map.call(select.options, (opt) => opt.value);
  const same = current.length === wanted.length
    && wanted.every((id, i) => current[i] === id);
  if (same) {
    // Rebuilding on every render would fight the MutationObserver that keeps
    // the custom dropdown in sync, so only the labels are refreshed.
    for (const opt of select.options) {
      if (ASR_ENGINE_OPTIONS[opt.value]) opt.textContent = asrEngineOptionLabel(opt.value);
    }
    return;
  }
  select.innerHTML = '';
  for (const id of wanted) {
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = asrEngineOptionLabel(id);
    select.appendChild(opt);
  }
}

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

let displayNameFocused = false;
let micDevices = [];
let defaultMicId = null;
let micListLoading = false;

let view = 'dictation';
let settingsOpen = false;
let settingsCat = 'general';
let lastPayload = null;
let sidebarCollapsed = false;

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
let insightsTab = 'usage';

function setView(name) {
  if (!panes[name]) return;
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
  if (name === 'insights' && insightsDirty) renderInsights(null);
}

function openSettings() {
  const wasOpen = settingsOpen;
  settingsOpen = true;
  // The settings overlay dims the whole window and paints over the panel, so
  // a panel left open behind it is only reachable by dismissing settings.
  closeNotifications();
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
    if (device.deviceId === defaultMicId) continue;
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

let latestGreetingName = '';

function renderGreeting(data) {
  const timeSalute = salute();
  const name = String((data && data.displayName) || '').trim();
  latestGreetingName = name;
  if (name) {
    greetingSaluteEl.textContent = timeSalute;
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

function shortcutKbdHtml(label) {
  const parts = String(label || 'Ctrl+Shift+Space').split('+');
  return parts.map((p) => '<kbd>' + p + '</kbd>').join('+');
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

function setShortcutHint(text, kind) {
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
  const styles = data.writingStyles || STYLE_DEFAULTS;
  for (const seg of styleSegEls) {
    const cat = seg.dataset.styleCat;
    const val = styles[cat] || STYLE_DEFAULTS[cat] || 'casual';
    for (const btn of seg.querySelectorAll('.segmented-btn')) {
      const on = btn.dataset.style === val;
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-checked', on ? 'true' : 'false');
    }
  }
  const autoSend = data.autoSend || {};
  for (const select of sendSelectEls) {
    const cat = select.dataset.sendCat;
    const val = autoSend[cat] || 'off';
    select.value = val === 'enter' || val === 'ctrl-enter' ? val : 'off';
  }

  // Verbatim overrides every tone below it, so grey the rows out rather than
  // leaving a live-looking control that no longer decides anything.
  const verbatim = !!data.verbatimMode;
  if (settingInputs.verbatimMode) settingInputs.verbatimMode.checked = verbatim;
  if (settingInputs.verbatimDictionary) {
    settingInputs.verbatimDictionary.checked = !!data.verbatimDictionary;
  }
  if (verbatimDictRowEl) verbatimDictRowEl.hidden = !verbatim;
  if (settingInputs.numbersAsDigits) settingInputs.numbersAsDigits.checked = data.numbersAsDigits !== false;
  if (wsRowsEl) wsRowsEl.classList.toggle('is-verbatim', verbatim);
}

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

if (speechSetupInstallBtn) {
  speechSetupInstallBtn.addEventListener('click', async () => {
    if (speechSetupInstallBtn.disabled) return;
    // installAsrRuntime rejects a second concurrent call, and the first
    // progress event that repaints this button is a moment away.
    speechSetupInstallBtn.disabled = true;
    try {
      const next = await window.voxden.installAsrRuntime();
      if (next) render(next);
    } catch (err) {
      if (speechSetupStatusEl) speechSetupStatusEl.textContent = err.message || 'Setup failed. Try again.';
    } finally {
      speechSetupInstallBtn.disabled = false;
    }
  });
}

if (speechSetupCancelBtn) {
  speechSetupCancelBtn.addEventListener('click', async () => {
    speechSetupCancelBtn.disabled = true;
    try {
      const next = await window.voxden.cancelAsrRuntime();
      if (next) render(next);
    } finally {
      speechSetupCancelBtn.disabled = false;
    }
  });
}

if (speechSetupRemoveBtn) {
  speechSetupRemoveBtn.addEventListener('click', async () => {
    // Guard before the prompt, not after. window.confirm blocks this handler
    // but not the button, so every click while the dialog is up queued another
    // one -- confirming the first then dismissed a stack of identical dialogs,
    // which reads as the prompt refusing to go away.
    if (speechSetupRemoveBtn.disabled) return;
    speechSetupRemoveBtn.disabled = true;
    try {
      // 3.2 GB to fetch again, and dictation stops working until it is back.
      if (!window.confirm(
        'Remove the speech engine and model from this PC? Dictation will stop'
        + ' working until you set them up again. Your history and settings will be kept.'
      )) return;
      const next = await window.voxden.removeAsrRuntime();
      if (next) render(next);
    } catch (err) {
      // try/finally with no catch is what made a failed removal invisible: the
      // handler rejected, render never ran, and the card kept saying the engine
      // was installed with no hint that anything had gone wrong.
      if (speechSetupStatusEl) {
        speechSetupStatusEl.textContent = 'Could not remove the speech engine. '
          + ((err && err.message) ? err.message : 'Try again.');
        speechSetupStatusEl.classList.add('is-error');
      }
    } finally {
      speechSetupRemoveBtn.disabled = false;
    }
  });
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
  return ASR_ENGINE_OPTIONS[id] ? id : 'whisper';
}

function asrActiveName(active, names) {
  const id = String(active || '').trim().toLowerCase();
  if (id === 'qwen3-asr') return names['qwen3-asr'];
  if (id === 'parakeet') return names.parakeet;
  return names.whisper;
}

// Decimal, to match how both downloads are advertised.
function formatSetupBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n >= 1e9) return (n / 1e9).toFixed(1) + ' GB';
  return Math.round(n / 1e6) + ' MB';
}

// The same two downloads the first-run banner offers, reachable on purpose
// rather than only when something is broken. Repairing an interrupted setup
// used to require the app to be unable to start -- which it no longer is once
// the 99 MB half has landed, so there was no way back in.
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

// The engines and precisions this machine is being offered but does not need.
function renderSpeechExtras(data) {
  if (!speechExtrasEl) return;
  const plan = data.modelPlan;
  const { busy } = speechSetupInfo(data);
  const offered = plan ? plan.items.filter((item) => item.role === 'optional') : [];
  speechExtrasEl.hidden = !offered.length;
  if (!offered.length) {
    speechExtrasEl.replaceChildren();
    return;
  }
  const rows = offered.map((item) => {
    const row = document.createElement('li');
    row.className = 'speech-extra';
    const copy = document.createElement('div');
    copy.className = 'speech-extra-copy';
    const name = document.createElement('span');
    name.className = 'speech-extra-name';
    name.textContent = item.name;
    const hint = document.createElement('span');
    hint.className = 'speech-extra-hint';
    hint.textContent = item.summary;
    copy.append(name, hint);
    row.append(copy);
    if (item.installed) {
      const state = document.createElement('span');
      state.className = 'speech-extra-state';
      state.textContent = 'Installed';
      // Installed but not needed by the chosen engine, so it can go on its
      // own. The model the engine needs is not in this list; that one leaves
      // with "Remove engine and model".
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'speech-setup-remove';
      remove.disabled = busy;
      remove.textContent = 'Remove';
      remove.addEventListener('click', async () => {
        // Guard before the prompt: window.confirm blocks this handler but not
        // the button, so clicks while the dialog is up would queue more.
        if (remove.disabled) return;
        remove.disabled = true;
        try {
          const frees = item.bytes ? ' It frees ' + formatSetupBytes(item.bytes) + '.' : '';
          if (!window.confirm('Remove ' + item.name + ' from this PC?' + frees
            + ' You can download it again from here at any time.')) return;
          if (window.voxden && window.voxden.removeSpeechModel) {
            const next = await window.voxden.removeSpeechModel(item.id);
            if (next) render(next);
          }
        } catch (err) {
          if (speechSetupStatusEl) {
            speechSetupStatusEl.textContent = 'Could not remove ' + item.name + '. '
              + ((err && err.message) ? err.message : 'Try again.');
            speechSetupStatusEl.classList.add('is-error');
          }
        } finally {
          remove.disabled = false;
        }
      });
      row.append(state, remove);
    } else {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn-secondary';
      button.disabled = busy;
      button.textContent = 'Download ' + formatSetupBytes(item.bytes);
      button.addEventListener('click', () => {
        button.disabled = true;
        if (window.voxden && window.voxden.installSpeechModel) {
          window.voxden.installSpeechModel(item.id);
        }
      });
      row.append(button);
    }
    return row;
  });
  speechExtrasEl.replaceChildren(...rows);
}

function renderSpeechSetup(data) {
  if (!speechSetupInstallBtn) return;
  const state = data.asrRuntimeState || {};
  const { needsEngine, needsModel, pending, busy } = speechSetupInfo(data);
  const hasProgress = busy && Number.isFinite(state.progress);
  const progress = hasProgress ? Math.max(0, Math.min(100, Math.round(state.progress))) : 0;
  if (speechSetupProgressRowEl) speechSetupProgressRowEl.hidden = !busy;
  if (speechSetupProgressEl) {
    speechSetupProgressEl.setAttribute('aria-valuenow', String(progress));
    speechSetupProgressEl.setAttribute('aria-valuetext', hasProgress ? progress + '% complete' : state.message || 'Preparing setup');
  }
  if (speechSetupProgressFillEl) speechSetupProgressFillEl.style.width = progress + '%';
  if (speechSetupProgressLabelEl) speechSetupProgressLabelEl.textContent = hasProgress ? progress + '%' : '';
  if (speechSetupHintEl) {
    const plan = data.modelPlan;
    const required = plan
      ? plan.items.filter((item) => item.role === 'required').map((item) => item.name)
      : [];
    speechSetupHintEl.textContent = required.length
      ? 'Downloads ' + required.join(' and ')
        + ' for the engine you chose. Python and dependencies are included with Voxden.'
      : 'Python and dependencies are included with Voxden.';
  }
  if (speechSetupStatusEl) {
    speechSetupStatusEl.classList.toggle('is-error', state.status === 'error');
    speechSetupStatusEl.textContent = busy || ['error', 'cancelled', 'removed'].includes(state.status)
      ? state.message || 'Setup did not finish. Download again to resume.'
      : needsEngine || needsModel ? 'Finish setup to use every model. No downloads happen during dictation.'
        : 'The engine you chose is set up. No downloads happen during dictation.';
  }
  speechSetupInstallBtn.hidden = busy || (!needsEngine && !needsModel && !data.asrRuntimeWouldHelp);
  speechSetupInstallBtn.disabled = busy;
  speechSetupInstallBtn.textContent = pending ? 'Set up all models (up to ' + formatSetupBytes(pending) + ')'
    : 'Set up speech engines';
  if (speechSetupCancelBtn) {
    speechSetupCancelBtn.hidden = !busy || state.status === 'removing';
    speechSetupCancelBtn.disabled = state.status === 'cancelling';
  }
  if (speechSetupRemoveBtn) {
    speechSetupRemoveBtn.hidden = busy || (needsEngine && !data.asrRuntime?.installed && !data.asrModel?.installed
      && !(data.speechModels?.packs || []).some(p => p.installed));
  }
  for (const select of [settingInputs.asrEngine, settingInputs.asrDevice]) {
    if (select && select.disabled !== busy) select.disabled = busy;
  }
}

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
      || 'Voxden could not start its speech engine on this PC. Dictation is unavailable.';
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

const gpuCardEl = document.getElementById('gpu-card');
const gpuCardHintEl = document.getElementById('gpu-card-hint');
const gpuCardTitleEl = document.getElementById('gpu-card-title');
const gpuInstallBtn = document.getElementById('gpu-install');
const gpuCancelBtn = document.getElementById('gpu-cancel');
const gpuRemoveBtn = document.getElementById('gpu-remove');
const gpuProgressRowEl = document.getElementById('gpu-progress-row');
const gpuProgressEl = document.getElementById('gpu-progress');
const gpuProgressFillEl = document.getElementById('gpu-progress-fill');
const gpuProgressLabelEl = document.getElementById('gpu-progress-label');

// One card, three answers, because the three vendors genuinely differ and
// flattening them would mean lying to two of them.
//
// NVIDIA is the only one with something to download: CTranslate2 wants cuBLAS
// and no speech engine has ever carried it, which is why a GeForce has been
// sitting idle while Whisper ran on the CPU. AMD and Intel reach their GPU
// through DirectML, which is already installed -- so their card offers a
// setting to change, not a download to wait for. A PC with no usable GPU is
// shown nothing at all rather than an explanation of what it cannot have.
function renderGpuCard(data) {
  if (!gpuCardEl) return;
  const plan = data.gpu || {};
  const pack = data.cudaPack || {};
  const state = data.cudaPackState || {};
  const busy = state.status === 'downloading' || state.status === 'preparing'
    || state.status === 'installing';
  // This card is Whisper's: cuBLAS speeds up CTranslate2 and nothing else.
  // Shown under any other engine it read as an offer for that engine, and
  // the sentence explaining that it was not one did not stop people asking.
  //
  // The one exception is Parakeet on an AMD or Intel card, where the same
  // slot says there is nothing to download because DirectML is already in.
  const parakeetNote = data.asrEngine === 'parakeet'
    && plan.vendor && plan.vendor !== 'nvidia' && !plan.needsPack;
  if (!plan.vendor || (data.asrEngine !== 'whisper' && !parakeetNote)) {
    gpuCardEl.hidden = true;
    return;
  }
  gpuCardEl.hidden = false;
  if (gpuCardTitleEl) {
    gpuCardTitleEl.textContent = parakeetNote ? 'Parakeet acceleration' : 'Whisper acceleration';
  }
  if (parakeetNote) {
    gpuCardHintEl.textContent = plan.label + ' detected. Nothing to download:'
      + ' DirectML is already installed and it is what runs Parakeet on this card.'
      + (data.asrDevice === 'directml'
        ? ' It is selected.'
        : ' Set the transcription processor to AMD or Intel GPU to use it.');
    if (gpuProgressRowEl) gpuProgressRowEl.hidden = true;
    if (gpuInstallBtn) gpuInstallBtn.hidden = true;
    if (gpuCancelBtn) gpuCancelBtn.hidden = true;
    if (gpuRemoveBtn) gpuRemoveBtn.hidden = true;
    return;
  }

  const percent = Number.isFinite(state.progress)
    ? Math.max(0, Math.min(100, Math.round(state.progress)))
    : 0;
  if (gpuProgressRowEl) gpuProgressRowEl.hidden = !busy;
  if (gpuProgressEl) gpuProgressEl.setAttribute('aria-valuenow', String(percent));
  if (gpuProgressFillEl) gpuProgressFillEl.style.width = percent + '%';
  if (gpuProgressLabelEl) gpuProgressLabelEl.textContent = busy ? percent + '%' : '';
  if (gpuCancelBtn) gpuCancelBtn.hidden = !busy;

  const usingGpu = data.device === 'cuda' || data.device === 'directml';

  // Whether the one engine this card can actually speed up is even installed.
  //
  // The pack is cuBLAS, and cuBLAS is CTranslate2's, which is Whisper's. It
  // does nothing for Qwen -- the bundled torch is 2.11.0+cpu -- and nothing
  // for Parakeet, whose ONNX Runtime ships as the DirectML build with no CUDA
  // execution provider. Somebody running Qwen and Parakeet on a GeForce was
  // being offered 553 MB that could not have helped them, and then told the
  // download made both engines faster.
  const whisperItem = ((data.modelPlan && data.modelPlan.items) || [])
    .find((item) => item.id === 'whisper');
  const whisperReady = whisperItem ? whisperItem.installed : true;

  if (plan.needsPack) {
    // The number is the whole argument, so it is in the sentence rather than
    // in a tooltip nobody opens.
    gpuCardHintEl.textContent = whisperReady
      ? plan.label + ' detected. Whisper needs NVIDIA cuBLAS to use it, which is'
        + ' a separate ' + (pack.downloadSize || '553 MB') + ' download. Without it'
        + ' dictation runs on the CPU, where the same clip takes about twenty'
        + ' times longer.'
      : plan.label + ' detected, but Whisper is not downloaded yet.'
        + ' This ' + (pack.downloadSize || '553 MB') + ' download accelerates'
        + ' Whisper only. Qwen CUDA acceleration is a separate optional download.';
    if (gpuInstallBtn) {
      gpuInstallBtn.hidden = busy;
      gpuInstallBtn.textContent = 'Download ' + (pack.downloadSize || '553 MB');
      gpuInstallBtn.disabled = busy;
    }
    if (gpuRemoveBtn) gpuRemoveBtn.hidden = true;
  } else if (plan.vendor === 'nvidia') {
    gpuCardHintEl.textContent = plan.label + ' support is installed.'
      + (whisperReady
        ? (usingGpu
          ? ' Whisper runs on it. This download does not accelerate Qwen.'
          : ' Set the transcription processor to NVIDIA GPU or Auto to use it for Whisper. This download does not accelerate Qwen.')
        : ' It accelerates Whisper only, which is not downloaded yet.');
    if (gpuInstallBtn) gpuInstallBtn.hidden = true;
    if (gpuRemoveBtn) gpuRemoveBtn.hidden = busy;
  } else {
    // Nothing to download, so the card is telling them a setting exists --
    // and being honest that it moves one engine, not both.
    gpuCardHintEl.textContent = plan.label + ' detected. Nothing to download:'
      + ' DirectML is already installed. It accelerates ' + (plan.accelerates || 'Parakeet')
      + ' only. Whisper has no AMD or Intel backend. Qwen ROCm acceleration is a'
      + ' separate download, and only for GPUs on AMD’s Windows PyTorch list. Not every AMD GPU is supported.'
      + (data.asrDevice === 'directml'
        ? ' It is selected.'
        : ' Set the transcription processor to AMD or Intel GPU to use it.');
    if (gpuInstallBtn) gpuInstallBtn.hidden = true;
    if (gpuRemoveBtn) gpuRemoveBtn.hidden = true;
  }

  if (state.status === 'error' || state.status === 'cancelled') {
    gpuCardHintEl.textContent = state.message || gpuCardHintEl.textContent;
  }
}

if (gpuInstallBtn) {
  gpuInstallBtn.addEventListener('click', () => {
    gpuInstallBtn.disabled = true;
    window.voxden.installCudaPack()
      .then((next) => { if (next) render(next); })
      .finally(() => { gpuInstallBtn.disabled = false; });
  });
}
if (gpuCancelBtn) {
  gpuCancelBtn.addEventListener('click', () => {
    window.voxden.cancelCudaPack().then((next) => { if (next) render(next); });
  });
}
if (gpuRemoveBtn) {
  gpuRemoveBtn.addEventListener('click', () => {
    window.voxden.removeCudaPack().then((next) => { if (next) render(next); });
  });
}

const qwenAccelCardEl = document.getElementById('qwen-accel-card');
const qwenAccelHintEl = document.getElementById('qwen-accel-hint');
const qwenAccelInstallBtn = document.getElementById('qwen-accel-install');
const qwenAccelCancelBtn = document.getElementById('qwen-accel-cancel');
const qwenAccelRemoveBtn = document.getElementById('qwen-accel-remove');
const qwenAccelRetryBtn = document.getElementById('qwen-accel-retry');
const qwenAccelProgressRowEl = document.getElementById('qwen-accel-progress-row');
const qwenAccelProgressEl = document.getElementById('qwen-accel-progress');
const qwenAccelProgressFillEl = document.getElementById('qwen-accel-progress-fill');
const qwenAccelProgressLabelEl = document.getElementById('qwen-accel-progress-label');

function qwenAccelKind(plan) {
  return plan && plan.recommendedPack === 'rocm' ? 'rocm' : 'cuda';
}

function renderQwenAccelCard(data) {
  if (!qwenAccelCardEl) return;
  const plan = data.qwenAccel || {};
  // Same rule as the Whisper card: an acceleration offer belongs under the
  // engine it accelerates, and only while that engine is the one selected.
  if (!plan.vendor || plan.uiStatus === 'hidden' || data.asrEngine !== 'qwen3-asr') {
    qwenAccelCardEl.hidden = true;
    return;
  }
  qwenAccelCardEl.hidden = false;
  const kind = qwenAccelKind(plan);
  const pack = kind === 'rocm' ? (data.qwenRocmPack || {}) : (data.qwenCudaPack || {});
  const state = kind === 'rocm' ? (data.qwenRocmPackState || {}) : (data.qwenCudaPackState || {});
  const busy = state.status === 'downloading' || state.status === 'preparing'
    || state.status === 'installing';
  const percent = Number.isFinite(state.progress)
    ? Math.max(0, Math.min(100, Math.round(state.progress)))
    : 0;
  if (qwenAccelProgressRowEl) qwenAccelProgressRowEl.hidden = !busy;
  if (qwenAccelProgressEl) qwenAccelProgressEl.setAttribute('aria-valuenow', String(percent));
  if (qwenAccelProgressFillEl) qwenAccelProgressFillEl.style.width = percent + '%';
  if (qwenAccelProgressLabelEl) qwenAccelProgressLabelEl.textContent = busy ? percent + '%' : '';
  if (qwenAccelCancelBtn) qwenAccelCancelBtn.hidden = !busy;
  if (qwenAccelRetryBtn) {
    qwenAccelRetryBtn.hidden = !(plan.sessionBlocked || plan.uiStatus === 'fallback');
  }

  const packName = kind === 'rocm' ? 'Qwen ROCm acceleration' : 'Qwen CUDA acceleration';
  const gpuName = plan.gpuName || plan.label || (kind === 'rocm' ? 'AMD GPU' : 'NVIDIA GPU');
  let hint = '';
  if (plan.uiStatus === 'verified' && plan.backend !== 'cpu') {
    hint = gpuName + ' · ' + packName + ' is active after sidecar verification'
      + (plan.computeType ? ' (' + plan.computeType + ').' : '.');
  } else if (plan.uiStatus === 'installed') {
    hint = packName + ' is installed for ' + gpuName
      + '. The sidecar has not verified GPU execution yet, so dictation stays on CPU Qwen.';
  } else if (plan.uiStatus === 'offer') {
    hint = (plan.reason || (gpuName + ' can use ' + packName + '.'))
      + ' Download size ' + (pack.downloadSize || plan.pack && plan.pack.downloadSize || '') + '.';
  } else if (plan.uiStatus === 'fallback') {
    hint = 'CPU Qwen is active. '
      + (plan.fallbackReason || plan.reason || 'The GPU accelerator is unavailable.');
  } else if (plan.uiStatus === 'unsupported') {
    hint = plan.reason || (gpuName + ' cannot use Qwen GPU acceleration. Dictation stays on CPU Qwen.');
  } else {
    hint = plan.reason || 'CPU Qwen.';
  }
  if (state.status === 'error' || state.status === 'cancelled') {
    hint = state.message || hint;
  }
  if (qwenAccelHintEl) qwenAccelHintEl.textContent = hint;

  if (qwenAccelInstallBtn) {
    const offer = plan.uiStatus === 'offer' || (plan.supported && !pack.installed);
    qwenAccelInstallBtn.hidden = busy || !offer;
    qwenAccelInstallBtn.textContent = 'Download ' + packName + ' (' + (pack.downloadSize || '') + ')';
    qwenAccelInstallBtn.disabled = busy;
    qwenAccelInstallBtn.dataset.kind = kind;
  }
  if (qwenAccelRemoveBtn) {
    qwenAccelRemoveBtn.hidden = busy || !pack.installed;
    qwenAccelRemoveBtn.dataset.kind = kind;
  }
}

if (qwenAccelInstallBtn) {
  qwenAccelInstallBtn.addEventListener('click', () => {
    qwenAccelInstallBtn.disabled = true;
    window.voxden.installQwenAccel(qwenAccelInstallBtn.dataset.kind || 'cuda')
      .then((next) => { if (next) render(next); })
      .finally(() => { qwenAccelInstallBtn.disabled = false; });
  });
}
if (qwenAccelCancelBtn) {
  qwenAccelCancelBtn.addEventListener('click', () => {
    window.voxden.cancelQwenAccel(qwenAccelInstallBtn && qwenAccelInstallBtn.dataset.kind || 'cuda')
      .then((next) => { if (next) render(next); });
  });
}
if (qwenAccelRemoveBtn) {
  qwenAccelRemoveBtn.addEventListener('click', () => {
    window.voxden.removeQwenAccel(qwenAccelRemoveBtn.dataset.kind || 'cuda')
      .then((next) => { if (next) render(next); });
  });
}
if (qwenAccelRetryBtn) {
  qwenAccelRetryBtn.addEventListener('click', () => {
    window.voxden.retryQwenAccel().then((next) => { if (next) render(next); });
  });
}

function renderAsrEngine(data) {
  const stored = asrEngineId(data.asrEngine);
  // Keep the chosen engine visible through setup, removal, and restart.
  const selected = stored;
  const device = ['cuda', 'directml', 'cpu'].includes(data.asrDevice) ? data.asrDevice : 'auto';
  syncAsrEngineSelectOptions(settingInputs.asrEngine, data.asrEngineAvailable);
  if (settingInputs.asrEngine) settingInputs.asrEngine.value = selected;
  if (settingInputs.asrDevice) settingInputs.asrDevice.value = device;
  if (settingInputs.asrEngine) syncCustomSelect(settingInputs.asrEngine);
  if (settingInputs.asrDevice) syncCustomSelect(settingInputs.asrDevice);
  if (!asrEngineHintEl) return;

  const names = {
    whisper: ASR_ENGINE_OPTIONS.whisper.name,
    'qwen3-asr': ASR_ENGINE_OPTIONS['qwen3-asr'].name,
    parakeet: ASR_ENGINE_OPTIONS.parakeet.name,
  };
  const sizes = {
    whisper: ASR_ENGINE_OPTIONS.whisper.size,
    'qwen3-asr': ASR_ENGINE_OPTIONS['qwen3-asr'].size,
    parakeet: ASR_ENGINE_OPTIONS.parakeet.size,
  };
  const active = String(data.asrEngineActive || 'faster-whisper');
  const activeName = asrActiveName(active, names);
  const progressState = data.asrEngineProgress || {};
  const isLoading = data.engineStatus === 'loading' || data.engineStatus === 'starting';
  const hasProgress = isLoading && Number.isFinite(progressState.percent);
  const progress = hasProgress
    ? Math.max(0, Math.min(100, Math.round(progressState.percent)))
    : 0;
  const remaining = hasProgress ? Math.max(0, 100 - progress) : 0;
  if (asrEngineProgressRowEl) asrEngineProgressRowEl.hidden = !isLoading;
  if (asrEngineProgressEl) {
    asrEngineProgressEl.setAttribute('aria-valuenow', String(progress));
    asrEngineProgressEl.setAttribute(
      'aria-valuetext',
      hasProgress ? progress + '% complete, ' + remaining + '% remaining' : 'Preparing download'
    );
  }
  if (asrEngineProgressFillEl) {
    asrEngineProgressFillEl.style.width = (hasProgress ? progress : 0) + '%';
  }
  if (asrEngineProgressLabelEl) {
    if (!isLoading) {
      asrEngineProgressLabelEl.textContent = '';
    } else if (hasProgress && progress > 0) {
      asrEngineProgressLabelEl.textContent = remaining + '% left';
    } else {
      // Nothing has moved yet. "100% left" beside an empty bar reads as a
      // stuck download rather than one that has not reported a byte.
      asrEngineProgressLabelEl.textContent = 'Starting…';
    }
  }
  // Nothing can transcribe. This has to be said before every other branch:
  // falling through to "… is active on the CPU" told the user the engine was
  // running while every dictation was coming back as "No speech".
  if (data.engineStatus === 'unavailable') {
    // The sidecar's error names pip packages, which is the right answer for
    // someone running their own Python and useless advice for everyone else.
    // After removing the engine there is no Python left to install into, so
    // "Run: pip install faster-whisper" is a dead end handed to the user at
    // the exact moment the app knows precisely what is missing and can fetch
    // it. asrRuntimeWouldHelp is the same signal the banner offers on.
    asrEngineHintEl.textContent = data.asrRuntimeWouldHelp
      ? 'The speech engine is not installed. Download it from Speech engine and'
        + ' model below — no Python and no command line.'
      : (data.asrEngineError
        || 'Voxden could not start its speech engine on this PC. Dictation is unavailable.');
    if (asrEngineProgressRowEl) asrEngineProgressRowEl.hidden = true;
    asrEngineHintEl.classList.add('is-error');
    return;
  }
  asrEngineHintEl.classList.remove('is-error');
  if (data.asrEngineWarning) {
    // Built in one place, in one order: what is wrong, what is running instead,
    // then the command. The command has to be last -- anything appended after it
    // runs straight into the text a user is meant to copy.
    const warnWhere = deviceLabel(data.device);
    let hint = data.asrEngineWarning + ' ' + activeName + ' is active on the ' + warnWhere + '.';
    if (data.fastEngine === 'parakeet') {
      const fastWhere = deviceLabel(data.fastDevice);
      hint += ' Chat and Fast dictation use Parakeet TDT 0.6B on the ' + fastWhere + '.';
    } else {
      hint += ' Fast dictation uses it too.';
    }
    if (data.asrEngineFix) {
      const fixName = ASR_ENGINE_OPTIONS[data.asrEngineFixEngine]
        ? ASR_ENGINE_OPTIONS[data.asrEngineFixEngine].name
        : 'that engine';
      // Voxden's own runtime has no pip, so a pip command there is advice
      // nobody can follow. Name the engine rather than what the runtime
      // contains -- it carries Parakeet too, so "Whisper only" contradicted
      // the Fast-dictation sentence directly above it.
      hint += data.usingManagedRuntime
        ? ' ' + fixName + ' is not part of the engine Voxden set up and needs'
          + ' a repair through Speech setup below.'
        : ' To enable ' + fixName + ', run: ' + data.asrEngineFix;
    }
    asrEngineHintEl.textContent = hint;
    return;
  }
  if (data.engineStatus === 'standby') {
    if (asrEngineProgressRowEl) asrEngineProgressRowEl.hidden = true;
    asrEngineHintEl.textContent = names[selected]
      + ' is ready and will load when you start dictating.';
    return;
  }
  if (isLoading) {
    if (hasProgress) {
      const verb = progressState.phase === 'loading' ? 'Loading' : 'Downloading';
      if (progress === 0 && progressState.phase !== 'loading') {
        asrEngineHintEl.textContent = verb + ' ' + names[selected]
          + ' (' + sizes[selected] + ')… the first shard can take a minute before progress moves.';
        return;
      }
      asrEngineHintEl.textContent = verb + ' ' + names[selected]
        + ' (' + sizes[selected] + ')… ' + progress + '% complete, ' + remaining + '% left.';
      return;
    }
    asrEngineHintEl.textContent = 'Loading ' + names[selected]
      + ' (' + sizes[selected] + ')… first use downloads model files to this PC.';
    return;
  }
  const location = qwenLocation(selected, data);
  let hint = activeName + ' is active on the ' + location + '.';
  if (selected === 'parakeet') {
    hint += ' English-only.';
  } else if (data.asrFastOnCpu) {
    hint = activeName + ' is loaded on the CPU. Explicit Fast English dictation uses'
      + ' Parakeet TDT 0.6B. Auto and Accurate keep the selected engine when your'
      + ' dictionary has terms so they can be sent to the model.';
  } else if (data.fastEngine === 'parakeet') {
    const fastWhere = deviceLabel(data.fastDevice);
    hint += ' Explicit Fast English dictation uses Parakeet TDT 0.6B on the ' + fastWhere + '.';
  } else {
    hint += ' Explicit Fast English dictation still uses the selected engine until Parakeet is installed.';
  }
  asrEngineHintEl.textContent = hint;
}

// The privacy row's hint carries the live count, so "kept for 14 days" is
// followed by what that currently amounts to on this PC.
const RECORDINGS_HINT = 'Keeps the audio behind each dictation for 14 days, up to 500 MB, so you'
  + ' can play it back, save it as a WAV, or retry the transcript from the Dictation page.'
  + ' Stays on this PC.';

function renderRecordingsHint(data) {
  if (!recordingsHintEl) return;
  const r = data.recordings || {};
  const count = Number(r.count) || 0;
  recordingsClearBtn.disabled = clearingRecordings || (count < 1 && !data.canRetry);
  recordingsClearBtn.textContent = clearingRecordings ? 'Deleting…' : 'Delete';
  if (data.keepRecordings === false) {
    recordingsHintEl.textContent = RECORDINGS_HINT + ' Off: nothing is kept.';
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
  trainingRowEl.hidden = !on && pairs < 1;
  if (trainingClearBtn) trainingClearBtn.disabled = pairs < 1 && !(Number(t.pending) || 0);
  if (!trainingStatsEl) return;
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
    sidebarCollapsed = data.sidebarCollapsed;
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

function toggleSidebar() {
  sidebarCollapsed = !sidebarCollapsed;
  lastPayload = Object.assign({}, lastPayload || {}, { sidebarCollapsed });
  renderSidebar({ sidebarCollapsed });
  if (window.voxden && window.voxden.setSettings) {
    window.voxden.setSettings({ sidebarCollapsed }).then(render).catch(() => {});
  }
}

function renderSettings(payload) {
  const data = payload || lastPayload || {};
  const mode = data.dictateMode === 'ptt' ? 'ptt' : 'toggle';
  const label = data.shortcutLabel || 'Ctrl+Shift+Space';

  modeToggleEl.classList.toggle('active', mode === 'toggle');
  modePttEl.classList.toggle('active', mode === 'ptt');
  modeToggleEl.setAttribute('aria-checked', mode === 'toggle' ? 'true' : 'false');
  modePttEl.setAttribute('aria-checked', mode === 'ptt' ? 'true' : 'false');
  renderDictationQuality(data);

  shortcutDisplayEl.innerHTML = shortcutKbdHtml(label);
  if (pasteLastShortcutDisplayEl) {
    pasteLastShortcutDisplayEl.innerHTML = shortcutKbdHtml(
      data.pasteLastShortcutLabel || 'Ctrl+Alt+V'
    );
  }

  if (settingInputs.launchAtLogin) settingInputs.launchAtLogin.checked = !!data.launchAtLogin;
  if (settingInputs.alwaysShowFlowBar) settingInputs.alwaysShowFlowBar.checked = !!data.alwaysShowFlowBar;
  // Only worth offering once there is something to undo -- a bar still at its
  // default has nothing to reset to.
  if (flowBarPositionRow) flowBarPositionRow.hidden = !data.flowBarMoved;
  if (settingInputs.showInTaskbar) settingInputs.showInTaskbar.checked = !!data.showInTaskbar;
  if (settingInputs.soundsEnabled) settingInputs.soundsEnabled.checked = data.soundsEnabled !== false;
  if (settingInputs.muteMusicWhileDictating) {
    settingInputs.muteMusicWhileDictating.checked = data.muteMusicWhileDictating !== false;
  }
  if (settingInputs.suggestionsEnabled) settingInputs.suggestionsEnabled.checked = data.suggestionsEnabled !== false;
  if (settingInputs.keepRecordings) {
    settingInputs.keepRecordings.checked = data.keepRecordings !== false;
  }
  renderRecordingsHint(data);
  if (settingInputs.keepTrainingAudio) {
    settingInputs.keepTrainingAudio.checked = !!data.keepTrainingAudio;
  }
  renderTraining(data);
  renderEngineBanner(data);
  renderAsrEngine(data);
  renderGpuCard(data);
  renderQwenAccelCard(data);
  renderSpeechSetup(data);
  renderSpeechExtras(data);
  renderTunedModel(data);
  if (settingInputs.dictationLanguage) {
    settingInputs.dictationLanguage.value = data.dictationLanguage || 'en';
    syncCustomSelect(settingInputs.dictationLanguage);
  }
  if (settingInputs.displayName && !displayNameFocused) {
    settingInputs.displayName.value = data.displayName || '';
  }

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
  const copy = data.understandingCopy || 'Fix a misspelled word in a transcript. Voxden saves that spelling for next time.';
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
  if (vuCopyEl) {
    vuCopyEl.hidden = !suggestionsOn(data);
    if (suggestionsOn(data)) vuCopyEl.textContent = copy;
  }
  if (vuBarFillEl) vuBarFillEl.style.width = pct + '%';
  if (vuBarEl) vuBarEl.setAttribute('aria-valuenow', String(pct));
  if (vuMetaEl) vuMetaEl.textContent = profileMeta;
  if (vuRingProgressEl) {
    vuRingProgressEl.style.strokeDashoffset = String(VU_RING_LEN * (1 - pct / 100));
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
  const keys = shortcutKbdHtml(label || 'Ctrl+Shift+Space');
  if (mode === 'ptt') {
    return 'Hold ' + keys + ' anywhere to dictate. Release to finish, or tap to keep listening until the next press.<br/>Your transcripts will appear here.';
  }
  return 'Press ' + keys + ' anywhere to start dictation. Press it again to finish.<br/>Your transcripts will appear here.';
}

function renderFeedEmpty(data, all, entries, q) {
  if (!emptyEl) return;
  const mode = data.dictateMode === 'ptt' ? 'ptt' : 'toggle';
  const label = data.shortcutLabel || 'Ctrl+Shift+Space';
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

function easeOutExpo(t) {
  return t >= 1 ? 1 : 1 - Math.pow(2, -10 * t);
}

function formatDmWpm(wpm) {
  if (globalThis.voxdenMetrics) return globalThis.voxdenMetrics.formatWpm(wpm);
  if (wpm == null || !Number.isFinite(wpm) || wpm <= 0) return '—';
  return Math.round(wpm).toLocaleString();
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

function dmSavedFill(ms) {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return 0;
  const minutes = ms / 60000;
  return Math.min(1, Math.log1p(minutes) / Math.log1p(DM_SAVED_CEILING_MIN));
}

// The plot's own coordinate space. The SVG is stretched with
// preserveAspectRatio="none", so these are the only units the path maths uses
// and every pixel-sized thing on top of it -- dots, marker, tooltip -- is a
// positioned HTML element instead, which a non-uniform stretch cannot distort.
const DM_PLOT = Object.freeze({ w: 100, h: 46, left: 3, right: 97, top: 8, bottom: 36 });

function dmSmoothPath(points) {
  const flat = 'M' + DM_PLOT.left + ' ' + DM_PLOT.bottom + ' L' + DM_PLOT.right + ' ' + DM_PLOT.bottom;
  if (!points.length) return flat;
  if (points.length === 1) {
    return 'M' + DM_PLOT.left + ' ' + points[0].y + ' L' + DM_PLOT.right + ' ' + points[0].y;
  }
  let path = 'M' + points[0].x.toFixed(2) + ' ' + points[0].y.toFixed(2);
  for (let index = 0; index < points.length - 1; index += 1) {
    const before = points[index - 1] || points[index];
    const current = points[index];
    const next = points[index + 1];
    const after = points[index + 2] || next;
    const cp1x = current.x + (next.x - before.x) / 6;
    const cp1y = current.y + (next.y - before.y) / 6;
    const cp2x = next.x - (after.x - current.x) / 6;
    const cp2y = next.y - (after.y - current.y) / 6;
    const clampY = (value) => Math.max(DM_PLOT.top - 2, Math.min(DM_PLOT.bottom + 2, value));
    path += ' C'
      + cp1x.toFixed(2) + ' ' + clampY(cp1y).toFixed(2) + ' '
      + cp2x.toFixed(2) + ' ' + clampY(cp2y).toFixed(2) + ' '
      + next.x.toFixed(2) + ' ' + next.y.toFixed(2);
  }
  return path;
}

function dmRecentPaceChart(entries) {
  const samples = (entries || [])
    .filter((entry) => globalThis.voxdenMetrics.isPaceSample(entry))
    .slice(0, 8)
    .reverse()
    .map((entry) => ({
      wpm: globalThis.voxdenMetrics.countWords(entry.text) / (Number(entry.durationMs) / 60000),
      ts: Number(entry.ts) || 0,
    }));
  if (!samples.length) {
    return { points: [], line: dmSmoothPath([]), area: '', low: 0, high: 0, avgY: null };
  }
  const values = samples.map((sample) => sample.wpm);
  const low = Math.min(...values);
  const high = Math.max(...values);
  const span = high - low;
  const usable = DM_PLOT.bottom - DM_PLOT.top;
  // A flat run has no span to scale against, so it sits on the mid-line rather
  // than collapsing onto the floor and reading as "zero".
  const yFor = (value) => (span > 0
    ? DM_PLOT.bottom - ((value - low) / span) * usable
    : DM_PLOT.top + usable / 2);
  const points = samples.map((sample, index) => ({
    x: samples.length === 1
      ? DM_PLOT.w / 2
      : DM_PLOT.left + (index / (samples.length - 1)) * (DM_PLOT.right - DM_PLOT.left),
    y: yFor(sample.wpm),
    value: Math.max(0, Math.round(sample.wpm)),
    ts: sample.ts,
  }));
  const line = dmSmoothPath(points);
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return {
    points,
    line,
    area: line + ' L' + DM_PLOT.right + ' ' + DM_PLOT.h + ' L' + DM_PLOT.left + ' ' + DM_PLOT.h + ' Z',
    low: Math.round(low),
    high: Math.round(high),
    avgY: span > 0 ? yFor(mean) : null,
  };
}

let dmPaceSignature = '';

function renderDmPaceChart(entries) {
  // The chart only moves when a dictation is added or removed. It used to be
  // rebuilt -- dots and all -- on every render, ahead of the early-out that
  // protects the rest of the metrics.
  let sig = entries.length + '';
  for (let i = 0; i < Math.min(entries.length, 40); i++) sig += '|' + entries[i].id + ':' + (entries[i].wpm || '');
  if (sig === dmPaceSignature) return;
  dmPaceSignature = sig;
  const chart = dmRecentPaceChart(entries);
  dmPaceChartPoints = chart.points;
  const hasData = chart.points.length > 0;
  if (dmWpmLineEl) dmWpmLineEl.setAttribute('d', chart.line);
  if (dmWpmAreaEl) dmWpmAreaEl.setAttribute('d', chart.area || chart.line);
  if (dmWpmAvgEl) {
    const show = chart.avgY != null;
    dmWpmAvgEl.style.opacity = show ? '' : '0';
    if (show) {
      dmWpmAvgEl.setAttribute('y1', chart.avgY.toFixed(2));
      dmWpmAvgEl.setAttribute('y2', chart.avgY.toFixed(2));
    }
  }
  // One dot per dictation, as HTML so the SVG's non-uniform stretch cannot turn
  // them into ellipses.
  if (dmWpmDotsEl) {
    dmWpmDotsEl.replaceChildren();
    if (hasData && chart.points.length > 1) {
      for (const point of chart.points) {
        const dot = document.createElement('i');
        dot.className = 'dm-plot-dot';
        dot.style.left = point.x + '%';
        dot.style.top = (point.y / DM_PLOT.h) * 100 + '%';
        dmWpmDotsEl.appendChild(dot);
      }
    }
  }
  if (dmWpmRangeEl) {
    dmWpmRangeEl.textContent = hasData
      ? 'Last ' + chart.points.length + (chart.points.length === 1 ? ' dictation' : ' dictations')
      : 'No dictations yet';
  }
  if (dmWpmBoundsEl) {
    dmWpmBoundsEl.textContent = hasData && chart.high > chart.low
      ? chart.low.toLocaleString() + '\u2013' + chart.high.toLocaleString() + ' wpm'
      : '';
  }
  if (dmWpmChartEl) dmWpmChartEl.classList.toggle('has-data', hasData);
}

function dmPointDate(ts) {
  if (!ts) return '';
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return '';
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  if (sameDay) return 'Today';
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function showDmPacePoint(index) {
  if (!dmWpmChartEl || !dmPaceChartPoints.length) return;
  const clamped = Math.max(0, Math.min(dmPaceChartPoints.length - 1, index));
  const point = dmPaceChartPoints[clamped];
  const top = (point.y / DM_PLOT.h) * 100;
  if (dmWpmGuideEl) {
    dmWpmGuideEl.setAttribute('x1', point.x.toFixed(2));
    dmWpmGuideEl.setAttribute('x2', point.x.toFixed(2));
  }
  if (dmWpmMarkerEl) {
    dmWpmMarkerEl.style.left = point.x + '%';
    dmWpmMarkerEl.style.top = top + '%';
  }
  if (dmWpmDotsEl) {
    const dots = dmWpmDotsEl.children;
    for (let i = 0; i < dots.length; i += 1) dots[i].classList.toggle('is-active', i === clamped);
  }
  if (dmWpmTooltipEl) {
    const when = dmPointDate(point.ts);
    dmWpmTooltipEl.replaceChildren();
    const value = document.createElement('b');
    value.textContent = point.value.toLocaleString() + ' wpm';
    dmWpmTooltipEl.appendChild(value);
    if (when) {
      const meta = document.createElement('span');
      meta.textContent = when;
      dmWpmTooltipEl.appendChild(meta);
    }
    // Clamp against the tooltip's real width. A fixed guess let the widest
    // label hang off the card at the last point.
    const width = dmWpmChartEl.getBoundingClientRect().width;
    const half = dmWpmTooltipEl.offsetWidth / 2 + 6;
    const left = Math.max(half, Math.min(Math.max(half, width - half), (point.x / 100) * width));
    dmWpmTooltipEl.style.left = left + 'px';
    dmWpmTooltipEl.style.top = top + '%';
    // Near the ceiling there is no room above the point, so the tooltip flips
    // under it rather than escaping the card.
    dmWpmTooltipEl.classList.toggle('is-below', top < 38);
  }
  dmWpmChartEl.classList.add('is-active');
}

function hideDmPacePoint() {
  if (dmWpmChartEl) dmWpmChartEl.classList.remove('is-active');
  if (dmWpmDotsEl) {
    for (const dot of dmWpmDotsEl.children) dot.classList.remove('is-active');
  }
}

function trackDmPacePointer(event) {
  if (!dmWpmChartEl || !dmPaceChartPoints.length) return;
  const rect = dmWpmChartEl.getBoundingClientRect();
  const x = Math.max(0, Math.min(100, ((event.clientX - rect.left) / rect.width) * 100));
  let nearest = 0;
  for (let index = 1; index < dmPaceChartPoints.length; index += 1) {
    if (Math.abs(dmPaceChartPoints[index].x - x) < Math.abs(dmPaceChartPoints[nearest].x - x)) {
      nearest = index;
    }
  }
  showDmPacePoint(nearest);
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

function renderDictationMetrics(avgWpm, timeSavedMs, entries) {
  const wpm = (avgWpm != null && Number.isFinite(avgWpm) && avgWpm > 0) ? avgWpm : null;
  const savedMs = (timeSavedMs != null && Number.isFinite(timeSavedMs) && timeSavedMs > 0)
    ? timeSavedMs
    : 0;
  const savedLive = savedMs > 0;
  const wpmChanged = wpm !== dmAnim.wpm;
  const savedChanged = savedMs !== dmAnim.savedMs;
  renderDmPaceChart(entries);
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
    const fill = dmSavedFill(savedMs);
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
    if (dmSavedFillEl) dmSavedFillEl.style.width = (fill * 100) + '%';
    dmAnim.savedMs = savedMs;
  }
}

function renderStats(entries, payload) {
  let words = 0;
  let week = 0;
  const weekAgo = Date.now() - 7 * 24 * 3600 * 1000;
  for (const e of entries) {
    const n = globalThis.voxdenMetrics.countWords(e.text);
    words += n;
    if (e.ts >= weekAgo) week += n;
  }
  statWordsEl.textContent = words.toLocaleString();
  statNotesEl.textContent = entries.length.toLocaleString();
  statWeekEl.textContent = week.toLocaleString();

  const m = globalThis.voxdenMetrics
    ? globalThis.voxdenMetrics.computeMetrics(entries)
    : { avgWpm: payload && payload.avgWpm, timeSavedMs: payload && payload.timeSavedMs };
  renderDictationMetrics(m.avgWpm, m.timeSavedMs, entries);
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
  const card = groupsEl && groupsEl.querySelector('.card[data-id="' + id + '"]');
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

  body.appendChild(meta);
  body.appendChild(text);
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
    let res = null;
    try {
      res = await window.voxden.entryAudio(entry.id);
    } catch (_) {
      res = null;
    }
    if (!res || !res.ok || !res.bytes) {
      cardStatus(entry.id, (res && res.reason) || 'No recording kept for this dictation.', 'error');
      return;
    }
    // Deleting recordings can finish while the audio request is in flight.
    if (clearingRecordings || !card.isConnected || !(lastPayload.entries || []).some(e => e.id === entry.id && e.audio)) return;
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
    audio.addEventListener('ended', () => stopActivePlayer());
    activePlayer = {
      id: entry.id,
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
    audio.play().catch(() => cardStatus(entry.id, 'Playback failed.', 'error'));
  }

  playToggle.addEventListener('click', (e) => {
    e.stopPropagation();
    playRecording();
  });
  track.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!activePlayer || activePlayer.id !== entry.id) return;
    const rect = track.getBoundingClientRect();
    const dur = activePlayer.audio.duration;
    if (!rect.width || !Number.isFinite(dur) || dur <= 0) return;
    activePlayer.audio.currentTime = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)) * dur;
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

function renderDictionary(payload) {
  const data = payload || lastPayload || {};
  renderPending(data);
  if (!dictListEl) return;
  const phrases = data.phrases || [];
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

  if (dictEditingFrom && from.toLowerCase() !== dictEditingFrom.toLowerCase()) {
    await window.voxden.deletePhrase(dictEditingFrom);
  }

  const result = await window.voxden.upsertPhrase(from, to, {
    kind: mapping ? 'mapping' : 'word',
    source: 'manual',
  });
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

const INS_BAR_ICONS = {
  ai: '<svg ' + INS_ICON_ATTRS + '><path d="M12 3.5 13.6 9 19 10.6 13.6 12.2 12 17.7 10.4 12.2 5 10.6 10.4 9z"/>'
    + '<path d="M18 16.5l.7 2.3 2.3.7-2.3.7-.7 2.3-.7-2.3-2.3-.7 2.3-.7z"/></svg>',
  work: '<svg ' + INS_ICON_ATTRS + '><path d="M4 6.5h11a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H9l-3.5 3v-3H4a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2z"/>'
    + '<path d="M17 9.5h3a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-1v3l-3-3"/></svg>',
  email: '<svg ' + INS_ICON_ATTRS + '><rect x="2.75" y="5.5" width="18.5" height="13" rx="2.5"/><path d="m3.5 7.5 8.5 6 8.5-6"/></svg>',
  personal: '<svg ' + INS_ICON_ATTRS + '><path d="M20.5 12a8 8 0 1 1-3.4-6.5"/><path d="M12 20.5c-1.6 0-3.1-.4-4.4-1.2L3.5 20.5l1.2-4.1"/></svg>',
  other: '<svg ' + INS_ICON_ATTRS + '><path d="M6.5 8.5a3.5 3.5 0 1 0 0 7c2.4 0 3.5-3.5 5.5-3.5s3.1 3.5 5.5 3.5a3.5 3.5 0 1 0 0-7c-2.4 0-3.5 3.5-5.5 3.5S8.9 8.5 6.5 8.5z"/></svg>',
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

function renderInsPace(pace, tips) {
  const showTips = tips !== false;
  const fill = document.getElementById('ins-gauge-fill');
  const foot = document.getElementById('ins-pace-foot');
  const has = pace.hasTimed && pace.avgWpm != null;
  insSetText('ins-pace-num', has ? pace.avgWpm.toLocaleString() : '—');
  insSetText('ins-pace-mult', has && pace.multiplier ? pace.multiplier + '×' : '—');
  if (fill) {
    const pct = has && pace.percent != null ? pace.percent : 0;
    fill.style.strokeDashoffset = String(INS_GAUGE_LEN * (1 - pct / 100));
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

function renderInsFixes(fixes, tips) {
  const showTips = tips !== false;
  const foot = document.getElementById('ins-fix-foot');
  const segStyle = document.getElementById('ins-fix-seg-style');
  const segDict = document.getElementById('ins-fix-seg-dict');
  insSetText('ins-fix-total', fixes.total.toLocaleString());
  insSetText('ins-fix-style', fixes.style.toLocaleString());
  insSetText('ins-fix-dict', fixes.dictionary.toLocaleString());
  if (segStyle && segDict) {
    const share = fixes.total > 0 ? Math.round((fixes.style / fixes.total) * 100) : 50;
    segStyle.style.width = share + '%';
    segDict.style.width = (100 - share) + '%';
  }
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

function renderInsVolume(volume, pace, length, tips) {
  const showTips = tips !== false;
  const deltaEl = document.getElementById('ins-vol-delta');
  const fillEl = document.getElementById('ins-vol-fill');
  const m = volume.milestone;

  insSetText('ins-vol-words', volume.words.toLocaleString());
  insSetText('ins-vol-count', volume.dictations.toLocaleString());
  insSetText('ins-vol-avg', length.average.toLocaleString());
  insSetText('ins-vol-saved', globalThis.voxdenMetrics
    ? globalThis.voxdenMetrics.formatTimeSaved(pace.timeSavedMs)
    : '—');

  if (deltaEl) {
    if (volume.delta) {
      deltaEl.hidden = false;
      deltaEl.textContent = volume.delta.label;
      deltaEl.classList.toggle('is-down', volume.delta.direction === 'down');
    } else {
      deltaEl.hidden = true;
    }
  }

  const milestoneText = m.text || (showTips ? 'Keep going to unlock your first milestone.' : '');
  insSetText('ins-vol-milestone', milestoneText);
  insSetText('ins-vol-next', m.next
    ? m.nextWords.toLocaleString() + ' words to ' + m.next
    : 'Every milestone cleared');
  if (fillEl) fillEl.style.width = m.percent + '%';
}

function renderInsWhere(where, tips) {
  const showTips = tips !== false;
  const barsEl = document.getElementById('ins-where-bars');
  const chipsEl = document.getElementById('ins-where-chips');
  const emptyEl = document.getElementById('ins-where-empty');
  if (!barsEl || !chipsEl || !emptyEl) return;

  insSetText('ins-where-apps-total', where.totalApps.toLocaleString());
  const has = where.tracked > 0;
  emptyEl.hidden = has || !showTips;
  barsEl.hidden = !has;
  chipsEl.hidden = !has;
  barsEl.textContent = '';
  chipsEl.textContent = '';
  if (!has) return;

  for (const row of where.rows) {
    const item = document.createElement('div');
    item.className = 'ins-bar-row' + (row.count > 0 ? '' : ' is-zero');

    const icon = document.createElement('span');
    icon.className = 'ins-bar-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.innerHTML = INS_BAR_ICONS[row.id] || INS_BAR_ICONS.other;
    item.appendChild(icon);

    const track = document.createElement('div');
    track.className = 'ins-bar-track';
    const fill = document.createElement('div');
    fill.className = 'ins-bar-fill';
    fill.style.width = Math.max(row.percent, 0) + '%';
    const pct = document.createElement('span');
    pct.className = 'ins-bar-pct';
    pct.textContent = row.percent + '%';
    fill.appendChild(pct);
    track.appendChild(fill);

    const label = document.createElement('span');
    label.className = 'ins-bar-label';
    const strong = document.createElement('b');
    strong.textContent = row.count.toLocaleString();
    label.appendChild(strong);
    label.appendChild(document.createTextNode(' ' + row.label));

    item.appendChild(track);
    item.appendChild(label);
    barsEl.appendChild(item);
  }

  for (const app of where.apps) {
    const chip = document.createElement('span');
    chip.className = 'ins-chip';
    chip.appendChild(document.createTextNode(app.label));
    const count = document.createElement('b');
    count.textContent = app.words.toLocaleString() + ' words';
    chip.appendChild(count);
    chipsEl.appendChild(chip);
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
  for (const col of heat.columns) {
    for (const cell of col) {
      const span = document.createElement('span');
      span.className = 'ins-heat-cell';
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
  }
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
    const has = ins.words.length > 0;
    wordsEmptyEl.hidden = has || !showTips;
    cloudEl.hidden = !has;
    cloudEl.textContent = '';
    ins.words.forEach((word, i) => {
      const chip = document.createElement('span');
      chip.className = 'ins-word-chip';
      chip.dataset.rank = String(Math.min(3, Math.floor(i / 3)));
      chip.textContent = word;
      cloudEl.appendChild(chip);
    });
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

// The insights pane recomputes several passes over the whole history and
// rebuilds a hundred-cell heatmap. While it is not on screen that is pure
// waste, so it waits until the pane is opened.
let insightsDirty = true;

function renderInsights(payload) {
  const api = globalThis.voxdenInsights;
  if (!api) return;
  if (view !== 'insights') {
    insightsDirty = true;
    return;
  }
  insightsDirty = false;
  const data = payload || lastPayload || {};
  const tips = suggestionsOn(data);
  const ins = api.computeInsights(data.entries || [], data.phrases || [], insightsRange);

  insSetText('ins-subtitle', ins.subtitle);
  renderInsPace(ins.pace, tips);
  renderInsFixes(ins.fixes, tips);
  renderInsVolume(ins.volume, ins.pace, ins.length, tips);
  renderInsWhere(ins.where, tips);
  renderInsRhythm(ins.rhythm);
  renderInsVoiceProfile(data);
  renderInsVoice(ins, tips);
}

function setInsightsTab(name) {
  insightsTab = name;
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
  for (const e of entries) sig += '|' + e.id + ':' + (e.audio ? 'a' : '') + ':' + (e.text || '');
  return sig;
}

function renderFeed(data, all) {
  const q = query.trim().toLowerCase();
  const entries = q ? all.filter((e) => (e.text || '').toLowerCase().includes(q)) : all;

  renderFeedEmpty(data, all, entries, q);

  if (editingCardId()) {
    // The edit in progress owns the DOM. Remember that a rebuild is owed so
    // the next render after the edit ends does not skip it as unchanged.
    feedDeferred = true;
    return;
  }

  const sig = feedSignatureFor(entries, q);
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
}

function render(payload) {
  if (payload) lastPayload = payload;
  const data = lastPayload || {};
  const all = data.entries || [];

  renderGreeting(data);
  renderSidebar(data);
  renderNotifications(data);
  renderSettings(data);
  renderWritingStyles(data);
  renderStats(all, data);
  renderDictionary(data);
  renderInsights(data);
  renderFeed(data, all);
}

for (const btn of navButtons) {
  btn.addEventListener('click', () => {
    if (btn === navSettingsBtn) {
      if (settingsOpen) closeSettings();
      else openSettings();
      return;
    }
    setView(btn.dataset.view);
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
  dmWpmMetricEl.addEventListener('focus', () => {
    if (dmPaceChartPoints.length) showDmPacePoint(dmPaceChartPoints.length - 1);
  });
  dmWpmMetricEl.addEventListener('blur', hideDmPacePoint);
}

if (dmWpmChartEl) {
  dmWpmChartEl.addEventListener('pointerenter', trackDmPacePointer);
  dmWpmChartEl.addEventListener('pointermove', trackDmPacePointer);
  dmWpmChartEl.addEventListener('pointerleave', () => {
    if (document.activeElement !== dmWpmMetricEl) hideDmPacePoint();
  });
}

if (dmSavedMetricEl) {
  dmSavedMetricEl.addEventListener('click', () => openDashboardInsight('ins-volume-card'));
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

if (dictSearchEl) {
  dictSearchEl.addEventListener('input', () => {
    dictQuery = dictSearchEl.value || '';
    renderDictionary(lastPayload || {});
  });
}

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
  window.voxden.setSettings(patch).then(render).catch(() => render(null));
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

for (const select of sendSelectEls) {
  select.addEventListener('change', () => {
    const cat = select.dataset.sendCat;
    if (!cat) return;
    patchSettings({ autoSend: { [cat]: select.value } });
  });
}

for (const seg of styleSegEls) {
  for (const btn of seg.querySelectorAll('.segmented-btn')) {
    btn.addEventListener('click', () => {
      const cat = seg.dataset.styleCat;
      const tone = btn.dataset.style;
      if (!cat || !tone) return;
      patchSettings({ writingStyles: { [cat]: tone } });
    });
  }
}

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
if (settingInputs.keepRecordings) {
  settingInputs.keepRecordings.addEventListener('change', () => {
    patchSettings({ keepRecordings: settingInputs.keepRecordings.checked });
  });
}
recordingsClearBtn.addEventListener('click', async () => {
  if (clearingRecordings || recordingsClearBtn.disabled) return;
  if (!window.confirm('Delete all saved dictation recordings?\n\nYour transcripts, training clips and exported WAV files will be kept. This cannot be undone.')) return;
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
if (settingInputs.asrEngine) {
  settingInputs.asrEngine.addEventListener('change', () => {
    patchSettings({ asrEngine: settingInputs.asrEngine.value });
  });
}
if (settingInputs.asrDevice) {
  settingInputs.asrDevice.addEventListener('change', () => {
    patchSettings({ asrDevice: settingInputs.asrDevice.value });
  });
}
if (trainingClearBtn) {
  trainingClearBtn.addEventListener('click', async () => {
    trainingClearBtn.disabled = true;
    try {
      const next = await window.voxden.clearTrainingData();
      if (next) render(next);
    } finally {
      trainingClearBtn.disabled = false;
    }
  });
}
if (settingInputs.dictationLanguage) {
  settingInputs.dictationLanguage.addEventListener('change', () => {
    patchSettings({ dictationLanguage: settingInputs.dictationLanguage.value });
  });
}
if (settingInputs.displayName) {
  settingInputs.displayName.addEventListener('focus', () => {
    displayNameFocused = true;
  });
  settingInputs.displayName.addEventListener('blur', () => {
    displayNameFocused = false;
    patchSettings({ displayName: settingInputs.displayName.value.trim() });
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
    window.voxden.checkForUpdates().then(render).catch(() => {
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
  if (view === 'dictation') renderGreeting(lastPayload || {});
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
  icon.className = 'notif-icon';
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
