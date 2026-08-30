'use strict';

const navButtons = document.querySelectorAll('.nav-item:not(.sidebar-toggle)');
const panes = {
  dictation: document.getElementById('view-dictation'),
  dictionary: document.getElementById('view-dictionary'),
  'writing-style': document.getElementById('view-writing-style'),
  insights: document.getElementById('view-insights'),
};

const navSettingsBtn = document.getElementById('nav-settings');
const sidebarEl = document.getElementById('sidebar');
const sidebarToggleEl = document.getElementById('sidebar-toggle');
const settingsOverlay = document.getElementById('settings-overlay');
const settingsCloseBtn = document.getElementById('settings-close');

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
const understandingPctEl = document.getElementById('understanding-pct');
const understandingCopyEl = document.getElementById('understanding-copy');
const understandingFillEl = document.getElementById('understanding-fill');
const understandingMetaEl = document.getElementById('understanding-meta');
const understandingBarEl = document.getElementById('understanding-bar');
const understandingProfileEl = document.getElementById('understanding-profile');
const understandingBlockEl = document.getElementById('understanding-block');

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
const DM_RING_LEN = 100;
const DM_WPM_CEILING = 200;
const DM_SAVED_CEILING_MIN = 600;
const DM_COUNT_MS = 1100;

const dmWpmMetricEl = document.getElementById('dm-wpm-metric');
const dmSavedMetricEl = document.getElementById('dm-saved-metric');
const dmRingWpmEl = document.getElementById('dm-ring-wpm');
const dmRingSavedEl = document.getElementById('dm-ring-saved');
const dmClockMinuteEl = document.getElementById('dm-clock-minute');
const dmMetricsEl = document.getElementById('dictation-metrics');
const dmWpmContextEl = document.getElementById('dm-wpm-context');
const dmSavedContextEl = document.getElementById('dm-saved-context');
const dmWpmChartEl = document.getElementById('dm-wpm-chart');
const dmWpmSparklineEl = document.getElementById('dm-wpm-sparkline');
const dmWpmSparklineAreaEl = document.getElementById('dm-wpm-sparkline-area');
const dmWpmSparklineFlowEl = document.getElementById('dm-wpm-sparkline-flow');
const dmWpmGuideEl = document.getElementById('dm-wpm-guide');
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
const sendSelectEls = Array.from(document.querySelectorAll('.ws-send-select'));
const smartRewriteToggleEl = document.getElementById('set-smart-rewrite');
const smartRewriteCheckBtn = document.getElementById('smart-rewrite-check');
const smartRewriteStatusEl = document.getElementById('smart-rewrite-status');
const languagePackRadioEls = Array.from(document.querySelectorAll('input[name="language-pack"]'));
const languagePackInstallBtn = document.getElementById('language-pack-install');
const languagePackCancelBtn = document.getElementById('language-pack-cancel');
const languagePackRemoveBtn = document.getElementById('language-pack-remove');
const languagePackProgressRowEl = document.getElementById('language-pack-progress-row');
const languagePackProgressEl = document.getElementById('language-pack-progress');
const languagePackProgressFillEl = document.getElementById('language-pack-progress-fill');
const languagePackProgressLabelEl = document.getElementById('language-pack-progress-label');
const languagePackStorageEl = document.getElementById('language-pack-storage');

const settingInputs = {
  launchAtLogin: document.getElementById('set-launch-login'),
  alwaysShowFlowBar: document.getElementById('set-always-flow'),
  showInTaskbar: document.getElementById('set-taskbar'),
  soundsEnabled: document.getElementById('set-sounds'),
  muteMusicWhileDictating: document.getElementById('set-mute-music'),
  suggestionsEnabled: document.getElementById('set-suggestions'),
  contextAwareness: document.getElementById('set-context'),
  selectedTextRewrite: document.getElementById('set-selected-rewrite'),
  keepTrainingAudio: document.getElementById('set-training-audio'),
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
  'qwen3-asr': { name: 'Qwen3-ASR 1.7B', size: '~3.4 GB' },
  parakeet: { name: 'Parakeet TDT 0.6B', size: '~0.6 GB' },
};

function asrEngineOptionLabel(id) {
  const opt = ASR_ENGINE_OPTIONS[id] || ASR_ENGINE_OPTIONS.whisper;
  return opt.name + ' \u00b7 ' + opt.size;
}

function syncAsrEngineSelectOptions(select) {
  if (!select) return;
  for (const opt of select.options) {
    if (ASR_ENGINE_OPTIONS[opt.value]) {
      opt.textContent = asrEngineOptionLabel(opt.value);
    }
  }
}

const trainingRowEl = document.getElementById('training-row');
const trainingStatsEl = document.getElementById('training-stats');
const trainingClearBtn = document.getElementById('training-clear');

const appVersionDisplayEl = document.getElementById('app-version-display');
const updateStatusHintEl = document.getElementById('update-status-hint');
const updateCheckBtn = document.getElementById('update-check-btn');

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
}

function openSettings() {
  settingsOpen = true;
  settingsOverlay.hidden = false;
  navSettingsBtn.classList.add('is-active');
  for (const btn of navButtons) {
    if (btn !== navSettingsBtn) {
      btn.classList.remove('is-active');
      btn.removeAttribute('aria-current');
    }
  }
  navSettingsBtn.setAttribute('aria-current', 'page');
}

function closeSettings() {
  if (!settingsOpen && settingsOverlay.hidden) return;
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
  settingsCat = name;
  for (const btn of settingsCatButtons) {
    const on = btn.dataset.cat === name;
    btn.classList.toggle('is-active', on);
  }
  for (const panel of settingsPanels) {
    panel.hidden = panel.dataset.cat !== name;
  }
  if (name === 'microphone') {
    refreshMicrophones();
  } else if (settingInputs.microphone) {
    settingInputs.microphone.disabled = false;
    settingInputs.microphone.classList.remove('is-loading');
  }
}

function cleanMicLabel(label) {
  return String(label || 'Microphone')
    .replace(/^Default\s*-\s*/i, '')
    .replace(/\s*\(default\)\s*$/i, '')
    .trim() || 'Microphone';
}

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
  if (!select || !navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
  micListLoading = true;
  const showLoading = settingsCat === 'microphone';
  select.disabled = showLoading;
  select.classList.toggle('is-loading', showLoading);
  try {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
    } catch (_) {}
    defaultMicId = await detectDefaultMicId();
    const all = await navigator.mediaDevices.enumerateDevices();
    micDevices = all.filter((d) => {
      if (d.kind !== 'audioinput' || !d.deviceId) return false;
      if (d.deviceId === 'default' || d.deviceId === 'communications') return false;
      return true;
    });
  } finally {
    micListLoading = false;
    select.classList.remove('is-loading');
    select.disabled = false;
  }
  renderMicSelect(lastPayload || {});
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
  const loading = micListLoading && settingsCat === 'microphone';
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

setInterval(() => {
  renderGreeting({ displayName: latestGreetingName });
}, 60 * 1000);

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

function countWords(s) {
  const t = String(s || '').trim();
  return t ? t.split(/\s+/).length : 0;
}

function shortcutKbdHtml(label) {
  const parts = String(label || 'Ctrl+Shift+Space').split('+');
  return parts.map((p) => '<kbd>' + p + '</kbd>').join('+');
}

function keyEventToAccelerator(e) {
  if (e.key === 'Escape') return null;
  const parts = [];
  if (e.ctrlKey || e.metaKey) parts.push('CommandOrControl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  const ignore = ['Control', 'Shift', 'Alt', 'Meta'];
  if (ignore.includes(e.key)) return null;
  let key = e.key;
  if (key === ' ') key = 'Space';
  else if (key.length === 1) key = key.toUpperCase();
  else if (/^F\d{1,2}$/.test(key)) key = key.toUpperCase();
  else if (key === 'ArrowUp') key = 'Up';
  else if (key === 'ArrowDown') key = 'Down';
  else if (key === 'ArrowLeft') key = 'Left';
  else if (key === 'ArrowRight') key = 'Right';
  else return null;
  parts.push(key);
  if (parts.length < 2) return null;
  return parts.join('+');
}

function shortcutCaptureButton(kind) {
  return kind === 'pasteLastShortcut' ? pasteLastShortcutChangeBtn : shortcutChangeBtn;
}

function startShortcutCapture(kind) {
  stopShortcutCapture();
  capturingShortcutKind = kind;
  const btn = shortcutCaptureButton(kind);
  if (btn) {
    btn.classList.add('is-capturing');
    btn.textContent = 'Listening…';
  }
  shortcutCaptureHint.hidden = false;
  shortcutCaptureHint.textContent = 'Press a new shortcut. Escape to cancel.';
}

function stopShortcutCapture() {
  capturingShortcutKind = null;
  for (const btn of [shortcutChangeBtn, pasteLastShortcutChangeBtn]) {
    if (!btn) continue;
    btn.classList.remove('is-capturing');
    btn.textContent = 'Change';
  }
  shortcutCaptureHint.hidden = true;
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

function languagePackBusyStatusMessage(packState, packName, progress) {
  const rounded = Math.round(progress);
  if (packState.status === 'downloading') {
    return 'Downloading ' + packName + '… ' + rounded + '%';
  }
  if (packState.status === 'verifying') {
    return 'Verifying ' + packName + '… ' + rounded + '%';
  }
  if (packState.status === 'preparing') {
    return packState.message || 'Checking the GitHub release…';
  }
  return packState.message || '';
}

function renderSmartRewrite(data) {
  if (smartRewriteToggleEl) smartRewriteToggleEl.checked = !!data.smartRewriteEnabled;
  const selected = data.languagePack === 'enhanced' ? 'enhanced' : 'standard';
  const packs = data.languagePacks || {};
  const packState = data.languagePackState || {};
  const busy = packState.status === 'preparing'
    || packState.status === 'downloading'
    || packState.status === 'verifying';
  for (const radio of languagePackRadioEls) {
    const active = radio.value === selected;
    radio.checked = active;
    radio.disabled = busy;
    const card = radio.closest('.language-pack-option');
    if (card) card.classList.toggle('is-selected', active);
    const installedBadge = document.getElementById('language-pack-' + radio.value + '-installed');
    if (installedBadge) installedBadge.hidden = !(packs[radio.value] && packs[radio.value].installed);
  }

  const selectedPack = packs[selected] || {};
  const packName = selected === 'enhanced' ? 'Enhanced' : 'Standard';
  const packSize = selected === 'enhanced' ? '2.5 GB' : '1.4 GB';
  const hasProgress = busy && Number.isFinite(packState.progress);
  const progress = hasProgress
    ? Math.max(0, Math.min(100, Math.round(packState.progress)))
    : 0;
  const remaining = hasProgress ? Math.max(0, 100 - progress) : 0;
  if (languagePackProgressRowEl) languagePackProgressRowEl.hidden = !busy;
  if (languagePackProgressEl) {
    languagePackProgressEl.setAttribute('aria-valuenow', String(progress));
    languagePackProgressEl.setAttribute(
      'aria-valuetext',
      hasProgress ? progress + '% complete, ' + remaining + '% remaining' : 'Preparing download'
    );
  }
  if (languagePackProgressFillEl) {
    languagePackProgressFillEl.style.width = (busy ? progress : 0) + '%';
  }
  if (languagePackProgressLabelEl) {
    if (!busy) {
      languagePackProgressLabelEl.textContent = '';
    } else if (packState.status === 'preparing') {
      languagePackProgressLabelEl.textContent = 'Preparing…';
    } else if (hasProgress) {
      languagePackProgressLabelEl.textContent = remaining + '% left';
    } else {
      languagePackProgressLabelEl.textContent = '';
    }
  }
  if (languagePackInstallBtn) {
    languagePackInstallBtn.hidden = busy;
    languagePackInstallBtn.disabled = !!selectedPack.installed;
    languagePackInstallBtn.textContent = selectedPack.installed
      ? packName + ' installed'
      : 'Download ' + packName + ' (' + packSize + ')';
  }
  if (languagePackCancelBtn) languagePackCancelBtn.hidden = !busy;
  if (languagePackRemoveBtn) languagePackRemoveBtn.hidden = !selectedPack.installed || busy;
  if (smartRewriteCheckBtn) smartRewriteCheckBtn.hidden = !selectedPack.installed || busy;
  if (languagePackStorageEl) {
    languagePackStorageEl.textContent = selectedPack.installed
      ? 'Stored on this PC and reused across Voxden updates. It will not download again.'
      : 'Downloaded once from GitHub, verified, and kept across Voxden updates.';
    languagePackStorageEl.title = data.languagePackStoragePath || '';
  }
  if (!smartRewriteStatusEl) return;
  const state = data.smartRewriteState || { status: 'disabled', message: 'Sentence correction is off.' };
  if (busy) {
    smartRewriteStatusEl.className = 'smart-rewrite-status is-' + (packState.status || 'busy');
    smartRewriteStatusEl.textContent = languagePackBusyStatusMessage(packState, packName, progress);
    return;
  }
  smartRewriteStatusEl.className = 'smart-rewrite-status is-' + (state.status || 'disabled');
  smartRewriteStatusEl.textContent = state.message || 'Sentence correction is off.';
}

function renderUpdateStatus(data) {
  const version = data && data.version ? data.version : '—';
  if (appVersionDisplayEl) appVersionDisplayEl.textContent = 'v' + version;

  let hint = 'Updates run automatically when you install Voxden from a release build.';
  if (data && data.packaged === false) {
    hint = 'Auto-update is disabled in development mode (npm start).';
  } else if (data) {
    switch (data.status) {
      case 'checking':
        hint = 'Checking for updates…';
        break;
      case 'downloading':
        hint = data.progress != null
          ? 'Downloading update… ' + data.progress + '%'
          : 'Downloading update…';
        break;
      case 'ready':
        hint = 'Update ready — quit Voxden to install ' + (data.availableVersion || 'the new version') + '.';
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
  if (updateStatusHintEl) updateStatusHintEl.textContent = hint;
  if (updateCheckBtn) {
    updateCheckBtn.disabled = !data || data.packaged === false || data.status === 'checking';
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

// The engine hint lives in Settings, which a first-run user has no reason to
// open. If dictation cannot work at all, say so on the page they land on -- and
// where a download fixes it, put that download here rather than describing it.
function renderEngineBanner(data) {
  if (!engineBannerEl) return;
  const runtime = data.asrRuntimeState || {};
  const busy = runtime.status === 'downloading'
    || runtime.status === 'installing'
    || runtime.status === 'preparing';
  const broken = data.engineStatus === 'unavailable';
  engineBannerEl.hidden = !broken && !busy;
  if (engineBannerEl.hidden) return;

  const offer = !!data.asrRuntimeWouldHelp;
  // What is left to fetch, not what a full setup costs: someone who already has
  // the engine and is only missing the model should not be quoted the total.
  const needsEngine = !!(data.asrRuntime && !data.asrRuntime.installed);
  const needsModel = !!(data.asrModel && !data.asrModel.installed);
  const pending = (needsEngine ? (data.asrRuntime.downloadBytes || 0) : 0)
    + (needsModel ? (data.asrModel.downloadBytes || 0) : 0);
  // Decimal, because that is how the download is advertised and how a browser
  // would report it. formatBytes is binary and is used for clip sizes.
  const size = pending >= 1e9
    ? (pending / 1e9).toFixed(1) + ' GB'
    : Math.round(pending / 1e6) + ' MB';
  const what = needsEngine && needsModel
    ? ' — the speech engine and its model'
    : (needsModel ? ' for the speech model' : ' for the speech engine');

  let text;
  if (busy) {
    text = runtime.message || 'Setting up dictation…';
  } else if (runtime.status === 'error' || runtime.status === 'cancelled') {
    text = runtime.message;
  } else if (offer) {
    text = 'Dictation needs a one-time ' + size + ' download' + what
      + '. Nothing else to install: no Python, no command line.';
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
  if (busy) {
    engineBannerBtnEl.hidden = false;
    engineBannerBtnEl.textContent = 'Cancel';
    engineBannerBtnEl.dataset.action = 'cancel';
  } else if (offer || runtime.status === 'error' || runtime.status === 'cancelled') {
    engineBannerBtnEl.hidden = false;
    engineBannerBtnEl.textContent = runtime.status === 'error' || runtime.status === 'cancelled'
      ? 'Try again'
      : 'Set up dictation';
    engineBannerBtnEl.dataset.action = 'install';
  } else {
    engineBannerBtnEl.hidden = true;
  }
}

if (engineBannerBtnEl) {
  engineBannerBtnEl.addEventListener('click', () => {
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
      .finally(() => { engineBannerBtnEl.disabled = false; });
  });
}

function renderAsrEngine(data) {
  const selected = asrEngineId(data.asrEngine);
  const device = ['cuda', 'cpu'].includes(data.asrDevice) ? data.asrDevice : 'auto';
  syncAsrEngineSelectOptions(settingInputs.asrEngine);
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
    asrEngineHintEl.textContent = data.asrEngineError
      || 'Voxden could not start its speech engine on this PC. Dictation is unavailable.';
    if (asrEngineProgressRowEl) asrEngineProgressRowEl.hidden = true;
    asrEngineHintEl.classList.add('is-error');
    return;
  }
  asrEngineHintEl.classList.remove('is-error');
  if (data.asrEngineWarning) {
    // Built in one place, in one order: what is wrong, what is running instead,
    // then the command. The command has to be last -- anything appended after it
    // runs straight into the text a user is meant to copy.
    const warnWhere = data.device === 'cuda' ? 'NVIDIA GPU' : 'CPU';
    let hint = data.asrEngineWarning + ' ' + activeName + ' is active on the ' + warnWhere + '.';
    if (data.fastEngine === 'parakeet') {
      const fastWhere = data.fastDevice === 'cuda' ? 'NVIDIA GPU' : 'CPU';
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
          + ' your own Python install.'
        : ' To enable ' + fixName + ', run: ' + data.asrEngineFix;
    }
    asrEngineHintEl.textContent = hint;
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
  const location = data.device === 'cuda' ? 'NVIDIA GPU' : 'CPU';
  let hint = activeName + ' is active on the ' + location + '.';
  if (selected === 'parakeet') {
    hint += ' English-only. Accurate dictation still uses sentence correction.';
  } else if (data.fastEngine === 'parakeet') {
    const fastWhere = data.fastDevice === 'cuda' ? 'NVIDIA GPU' : 'CPU';
    hint += ' Chat and Fast dictation use Parakeet TDT 0.6B on the ' + fastWhere + '.';
  } else {
    hint += ' Chat and Fast dictation still use the selected engine until Parakeet is installed.';
  }
  asrEngineHintEl.textContent = hint;
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
  if (settingInputs.showInTaskbar) settingInputs.showInTaskbar.checked = !!data.showInTaskbar;
  if (settingInputs.soundsEnabled) settingInputs.soundsEnabled.checked = data.soundsEnabled !== false;
  if (settingInputs.muteMusicWhileDictating) {
    settingInputs.muteMusicWhileDictating.checked = data.muteMusicWhileDictating !== false;
  }
  if (settingInputs.suggestionsEnabled) settingInputs.suggestionsEnabled.checked = data.suggestionsEnabled !== false;
  if (settingInputs.contextAwareness) settingInputs.contextAwareness.checked = data.contextAwareness !== false;
  if (settingInputs.selectedTextRewrite) {
    settingInputs.selectedTextRewrite.checked = data.selectedTextRewrite !== false;
  }
  if (settingInputs.keepTrainingAudio) {
    settingInputs.keepTrainingAudio.checked = !!data.keepTrainingAudio;
  }
  renderTraining(data);
  renderEngineBanner(data);
  renderAsrEngine(data);
  renderTunedModel(data);
  if (settingInputs.dictationLanguage) {
    settingInputs.dictationLanguage.value = 'en';
  }
  if (settingInputs.displayName && !displayNameFocused) {
    settingInputs.displayName.value = data.displayName || '';
  }

  renderMicSelect(data);

  renderUpdateStatus(data);

  renderUnderstanding(data);
  renderSmartRewrite(data);

  if (data.shortcutError) {
    shortcutCaptureHint.hidden = false;
    shortcutCaptureHint.textContent = data.shortcutError;
    setTimeout(() => {
      if (!capturingShortcutKind) shortcutCaptureHint.hidden = true;
    }, 2200);
  }
}

function understandingMetaText(data) {
  const words = data.wordCount || 0;
  const goal = data.understandingGoal || 2500;
  if (data.understandingMaxed) {
    return words.toLocaleString() + ' words · ' + (data.understandingProfileName || 'Expert');
  }
  return words.toLocaleString() + ' / ' + goal.toLocaleString() + ' words';
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
  const meta = understandingMetaText(data);
  const profileMeta = voiceProfileMetaText(data, profile);
  const words = Math.max(0, Number(data.wordCount) || 0);

  if (understandingPctEl) understandingPctEl.textContent = pct + '%';
  if (understandingFillEl) understandingFillEl.style.width = pct + '%';
  if (understandingBarEl) understandingBarEl.setAttribute('aria-valuenow', String(pct));
  if (understandingMetaEl) understandingMetaEl.textContent = meta;
  if (understandingCopyEl) {
    understandingCopyEl.hidden = !suggestionsOn(data);
    if (suggestionsOn(data)) understandingCopyEl.textContent = copy;
  }
  if (understandingProfileEl) understandingProfileEl.textContent = profileName;
  if (understandingBlockEl) {
    understandingBlockEl.classList.remove('is-personalized', 'is-attuned', 'is-fluent', 'is-expert');
    if (profile === 'personalized') understandingBlockEl.classList.add('is-personalized');
    if (profile === 'attuned') understandingBlockEl.classList.add('is-attuned');
    if (profile === 'fluent') understandingBlockEl.classList.add('is-fluent');
    if (profile === 'expert') understandingBlockEl.classList.add('is-expert');
  }

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
    return 'Hold ' + keys + ' anywhere to dictate. Release to finish.<br/>Your transcripts will appear here.';
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

function showLearnedToast(pairs) {
  const el = document.getElementById('learn-toast');
  if (!el || !pairs || !pairs.length || !suggestionsOn()) return;
  const first = pairs[0];
  const extra = pairs.length > 1 ? ' and ' + (pairs.length - 1) + ' more' : '';
  el.textContent = 'Learned “' + first.from + '” → “' + first.to + '”' + extra + '. Next dictation will use this spelling.';
  el.hidden = false;
  clearTimeout(showLearnedToast._t);
  showLearnedToast._t = setTimeout(() => {
    el.hidden = true;
  }, 3400);
}

function editingCardId() {
  const el = document.activeElement;
  if (!el || !el.closest) return null;
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

function dmWpmFill(wpm) {
  if (wpm == null || !Number.isFinite(wpm) || wpm <= 0) return 0;
  return Math.min(1, wpm / DM_WPM_CEILING);
}

function dmSavedFill(ms) {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return 0;
  const minutes = ms / 60000;
  return Math.min(1, Math.log1p(minutes) / Math.log1p(DM_SAVED_CEILING_MIN));
}

function dmSmoothPath(points) {
  if (!points.length) return 'M2 24 L98 24';
  if (points.length === 1) return 'M2 ' + points[0].y + ' L98 ' + points[0].y;
  let path = 'M' + points[0].x + ' ' + points[0].y;
  for (let index = 0; index < points.length - 1; index += 1) {
    const before = points[index - 1] || points[index];
    const current = points[index];
    const next = points[index + 1];
    const after = points[index + 2] || next;
    const cp1x = current.x + (next.x - before.x) / 6;
    const cp1y = current.y + (next.y - before.y) / 6;
    const cp2x = next.x - (after.x - current.x) / 6;
    const cp2y = next.y - (after.y - current.y) / 6;
    const clampY = (value) => Math.max(4, Math.min(26, value));
    path += ' C'
      + cp1x.toFixed(2) + ' ' + clampY(cp1y).toFixed(2) + ' '
      + cp2x.toFixed(2) + ' ' + clampY(cp2y).toFixed(2) + ' '
      + next.x.toFixed(2) + ' ' + next.y.toFixed(2);
  }
  return path;
}

function dmRecentPaceChart(entries) {
  const samples = (entries || [])
    .filter((entry) => entry && Number(entry.durationMs) > 0 && countWords(entry.text) > 0)
    .slice(0, 7)
    .reverse()
    .map((entry) => countWords(entry.text) / (Number(entry.durationMs) / 60000));
  if (!samples.length) {
    return { points: [], line: 'M2 24 L98 24', area: 'M2 24 L98 24 L98 30 L2 30 Z' };
  }
  const low = Math.min(...samples);
  const high = Math.max(...samples);
  const span = high - low;
  const points = samples.map((sample, index) => ({
    x: samples.length === 1 ? 50 : 2 + (index / (samples.length - 1)) * 96,
    y: span > 0 ? 24 - ((sample - low) / span) * 18 : 15,
    value: Math.max(0, Math.round(sample)),
  }));
  const line = dmSmoothPath(points);
  return {
    points,
    line,
    area: line + ' L98 30 L2 30 Z',
  };
}

function renderDmPaceChart(entries) {
  const chart = dmRecentPaceChart(entries);
  dmPaceChartPoints = chart.points;
  if (dmWpmSparklineEl) dmWpmSparklineEl.setAttribute('d', chart.line);
  if (dmWpmSparklineFlowEl) dmWpmSparklineFlowEl.setAttribute('d', chart.line);
  if (dmWpmSparklineAreaEl) dmWpmSparklineAreaEl.setAttribute('d', chart.area);
  if (dmWpmChartEl) dmWpmChartEl.classList.toggle('has-data', chart.points.length > 0);
}

function showDmPacePoint(index) {
  if (!dmWpmChartEl || !dmPaceChartPoints.length) return;
  const point = dmPaceChartPoints[Math.max(0, Math.min(dmPaceChartPoints.length - 1, index))];
  const top = (point.y / 30) * 100;
  if (dmWpmGuideEl) {
    dmWpmGuideEl.setAttribute('x1', point.x.toFixed(2));
    dmWpmGuideEl.setAttribute('x2', point.x.toFixed(2));
  }
  if (dmWpmMarkerEl) {
    dmWpmMarkerEl.style.left = point.x + '%';
    dmWpmMarkerEl.style.top = top + '%';
  }
  if (dmWpmTooltipEl) {
    const width = dmWpmChartEl.getBoundingClientRect().width;
    const left = Math.max(28, Math.min(width - 28, (point.x / 100) * width));
    dmWpmTooltipEl.style.left = left + 'px';
    dmWpmTooltipEl.textContent = point.value.toLocaleString() + ' WPM';
  }
  dmWpmChartEl.classList.add('is-active');
}

function hideDmPacePoint() {
  if (dmWpmChartEl) dmWpmChartEl.classList.remove('is-active');
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

function setDmRing(el, fill, idle, metricEl) {
  if (!el) return;
  el.style.strokeDasharray = String(DM_RING_LEN);
  if (idle) {
    el.style.strokeDashoffset = String(DM_RING_LEN);
    return;
  }
  const next = DM_RING_LEN * (1 - fill);
  const fromIdle = metricEl && metricEl.classList.contains('is-idle');
  if (fromIdle && !prefersReducedMotion()) {
    el.style.transition = 'none';
    el.style.strokeDashoffset = String(DM_RING_LEN);
    void el.getBoundingClientRect();
    el.style.removeProperty('transition');
  }
  el.style.strokeDashoffset = String(next);
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
    setDmRing(dmRingWpmEl, dmWpmFill(wpm), wpm == null, dmWpmMetricEl);
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
        : (wpm / typingBaseline).toFixed(1) + '× your typing baseline';
    }
    dmAnim.wpm = wpm;
  }

  if (savedChanged) {
    const fill = dmSavedFill(savedMs);
    setDmRing(dmRingSavedEl, fill, !savedLive, dmSavedMetricEl);
    setDmMetricLive(dmSavedMetricEl, savedLive);
    if (dmClockMinuteEl) {
      if (!savedLive) dmClockMinuteEl.style.removeProperty('transform');
      else dmClockMinuteEl.style.transform = 'rotate(' + (fill * 360) + 'deg)';
    }
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
    const n = countWords(e.text);
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

function buildCard(entry) {
  const card = document.createElement('div');
  card.className = 'card';
  card.dataset.id = entry.id;

  if (entry.mark) {
    const img = document.createElement('img');
    img.className = 'thumb';
    img.alt = '';
    card.appendChild(img);
    window.voxden.markData(entry.mark).then((url) => {
      if (url) img.src = url;
      else img.remove();
    });
  }

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
  meta.appendChild(time);
  meta.appendChild(copiedTag);
  meta.appendChild(learnedTag);

  const text = document.createElement('div');
  text.className = 'text';
  text.contentEditable = 'true';
  text.spellcheck = true;
  text.textContent = entry.text || '';

  body.appendChild(meta);
  body.appendChild(text);
  card.appendChild(body);

  const actions = document.createElement('div');
  actions.className = 'card-actions';
  const copyBtn = makeIconBtn('Copy', COPY_PATH, false);
  const delBtn = makeIconBtn('Delete', TRASH_PATH, true);
  actions.appendChild(copyBtn);
  actions.appendChild(delBtn);
  card.appendChild(actions);

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
      if (res.learned && res.learned.length) {
        flashLearned();
        showLearnedToast(res.learned);
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
    window.voxden.copyEntry(entry.id).then((ok) => { if (ok) flashCopied(); });
  });
  copyBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    window.voxden.copyEntry(entry.id).then((ok) => { if (ok) flashCopied(); });
  });
  delBtn.addEventListener('click', (e) => {
    e.stopPropagation();
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
  if (!dictListEl) return;
  const data = payload || lastPayload || {};
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
      ? 'Nothing learned yet. Edit a transcript to teach a spelling.'
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
const INS_FIX_EXPLAINER = 'Words changed covers filler cleanup, your writing '
  + 'style, and sentence correction when it is on.';
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

function renderInsights(payload) {
  const api = globalThis.voxdenInsights;
  if (!api) return;
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

function render(payload) {
  if (payload) lastPayload = payload;
  const data = lastPayload || {};
  const all = data.entries || [];

  renderGreeting(data);
  renderSidebar(data);
  renderSettings(data);
  renderWritingStyles(data);
  renderStats(all, data);
  renderDictionary(data);
  renderInsights(data);

  const q = query.trim().toLowerCase();
  const entries = q ? all.filter((e) => (e.text || '').toLowerCase().includes(q)) : all;

  renderFeedEmpty(data, all, entries, q);

  if (editingCardId()) {
    return;
  }

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

for (const btn of settingsCatButtons) {
  btn.addEventListener('click', () => setSettingsCat(btn.dataset.cat));
}

searchEl.addEventListener('input', () => {
  query = searchEl.value || '';
  render(null);
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
  window.voxden.setSettings(patch).then(render);
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

if (smartRewriteToggleEl) {
  smartRewriteToggleEl.addEventListener('change', () => {
    patchSettings({ smartRewriteEnabled: smartRewriteToggleEl.checked });
  });
}

for (const radio of languagePackRadioEls) {
  radio.addEventListener('change', () => {
    if (!radio.checked) return;
    patchSettings({ languagePack: radio.value });
  });
}

if (languagePackInstallBtn) {
  languagePackInstallBtn.addEventListener('click', async () => {
    const selected = languagePackRadioEls.find((radio) => radio.checked);
    languagePackInstallBtn.disabled = true;
    try {
      const next = await window.voxden.installLanguagePack(selected ? selected.value : 'standard');
      if (next) render(next);
    } finally {
      languagePackInstallBtn.disabled = false;
    }
  });
}

if (languagePackCancelBtn) {
  languagePackCancelBtn.addEventListener('click', async () => {
    languagePackCancelBtn.disabled = true;
    try {
      const next = await window.voxden.cancelLanguagePack();
      if (next) render(next);
    } finally {
      languagePackCancelBtn.disabled = false;
    }
  });
}

if (languagePackRemoveBtn) {
  languagePackRemoveBtn.addEventListener('click', async () => {
    const selected = languagePackRadioEls.find((radio) => radio.checked);
    const tier = selected ? selected.value : 'standard';
    const label = tier === 'enhanced' ? 'Enhanced' : 'Standard';
    if (!window.confirm('Remove the ' + label + ' language pack from this PC?')) return;
    languagePackRemoveBtn.disabled = true;
    try {
      const next = await window.voxden.removeLanguagePack(tier);
      if (next) render(next);
    } finally {
      languagePackRemoveBtn.disabled = false;
    }
  });
}

if (smartRewriteCheckBtn) {
  smartRewriteCheckBtn.addEventListener('click', async () => {
    smartRewriteCheckBtn.disabled = true;
    smartRewriteCheckBtn.textContent = 'Testing…';
    try {
      const next = await window.voxden.checkSmartRewrite();
      if (next) render(next);
    } finally {
      smartRewriteCheckBtn.disabled = false;
      smartRewriteCheckBtn.textContent = 'Test model';
    }
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
    const accel = keyEventToAccelerator(e);
    if (!accel) return;
    const kind = capturingShortcutKind;
    stopShortcutCapture();
    patchSettings({ [kind]: accel });
    return;
  }
  if (e.key === 'Escape' && settingsOpen) {
    e.preventDefault();
    closeSettings();
  }
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
if (settingInputs.contextAwareness) {
  settingInputs.contextAwareness.addEventListener('change', () => {
    patchSettings({ contextAwareness: settingInputs.contextAwareness.checked });
  });
}
if (settingInputs.selectedTextRewrite) {
  settingInputs.selectedTextRewrite.addEventListener('change', () => {
    patchSettings({ selectedTextRewrite: settingInputs.selectedTextRewrite.checked });
  });
}
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
if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
  navigator.mediaDevices.addEventListener('devicechange', () => {
    if (settingsCat === 'microphone') refreshMicrophones();
  });
}

initCustomSelects();
setView('dictation');
setSettingsCat('general');
window.voxden.onHistory(render);
window.voxden.loadApp().then((data) => {
  render(data);
  refreshMicrophones();
});
window.voxden.appReady();

setInterval(() => {
  if (view === 'dictation') renderGreeting(lastPayload || {});
}, 60000);
