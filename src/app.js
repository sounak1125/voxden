'use strict';

const navButtons = document.querySelectorAll('.nav-item');
const panes = {
  dictation: document.getElementById('view-dictation'),
  dictionary: document.getElementById('view-dictionary'),
  'writing-style': document.getElementById('view-writing-style'),
};

const navSettingsBtn = document.getElementById('nav-settings');
const settingsOverlay = document.getElementById('settings-overlay');
const settingsCloseBtn = document.getElementById('settings-close');

const emptyEl = document.getElementById('empty');
const groupsEl = document.getElementById('groups');
const searchEl = document.getElementById('search');
const dictFormEl = document.getElementById('dict-form');
const dictFromEl = document.getElementById('dict-from');
const dictToEl = document.getElementById('dict-to');
const dictSubmitEl = document.getElementById('dict-submit');
const dictErrorEl = document.getElementById('dict-error');
const dictSearchEl = document.getElementById('dict-search');
const dictEmptyEl = document.getElementById('dict-empty');
const dictNoMatchEl = document.getElementById('dict-no-match');
const dictListEl = document.getElementById('dict-list');
const greetingSaluteEl = document.getElementById('greeting-salute');
const greetingNameEl = document.getElementById('greeting-name');
const statWordsEl = document.getElementById('statWords');
const statNotesEl = document.getElementById('statNotes');
const statWeekEl = document.getElementById('statWeek');
const statWpmEl = document.getElementById('statWpm');
const statTimeSavedEl = document.getElementById('statTimeSaved');
const modeToggleEl = document.getElementById('mode-toggle');
const modePttEl = document.getElementById('mode-ptt');

const settingsCatButtons = document.querySelectorAll('.settings-cat');
const settingsPanels = document.querySelectorAll('.settings-panel');
const shortcutDisplayEl = document.getElementById('shortcut-display');
const shortcutChangeBtn = document.getElementById('shortcut-change');
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

const VU_RING_LEN = 188.5;

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

const settingInputs = {
  launchAtLogin: document.getElementById('set-launch-login'),
  alwaysShowFlowBar: document.getElementById('set-always-flow'),
  showInTaskbar: document.getElementById('set-taskbar'),
  soundsEnabled: document.getElementById('set-sounds'),
  muteMusicWhileDictating: document.getElementById('set-mute-music'),
  suggestionsEnabled: document.getElementById('set-suggestions'),
  contextAwareness: document.getElementById('set-context'),
  dictationLanguage: document.getElementById('dictation-lang-select'),
  displayName: document.getElementById('set-display-name'),
  microphone: document.getElementById('mic-select'),
};

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
let query = '';
let dictQuery = '';
let dictEditingFrom = null;
let capturingShortcut = false;

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

function salute() {
  const h = new Date().getHours();
  if (h >= 5 && h < 12) return 'Good morning';
  if (h >= 12 && h < 17) return 'Good afternoon';
  if (h >= 17 && h < 21) return 'Good evening';
  return 'Working late';
}

function renderGreeting(data) {
  const timeSalute = salute();
  const name = String((data && data.displayName) || '').trim();
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

function startShortcutCapture() {
  capturingShortcut = true;
  shortcutChangeBtn.classList.add('is-capturing');
  shortcutChangeBtn.textContent = 'Listening…';
  shortcutCaptureHint.hidden = false;
}

function stopShortcutCapture() {
  capturingShortcut = false;
  shortcutChangeBtn.classList.remove('is-capturing');
  shortcutChangeBtn.textContent = 'Change';
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

function renderSettings(payload) {
  const data = payload || lastPayload || {};
  const mode = data.dictateMode === 'ptt' ? 'ptt' : 'toggle';
  const label = data.shortcutLabel || 'Ctrl+Shift+Space';

  modeToggleEl.classList.toggle('active', mode === 'toggle');
  modePttEl.classList.toggle('active', mode === 'ptt');
  modeToggleEl.setAttribute('aria-checked', mode === 'toggle' ? 'true' : 'false');
  modePttEl.setAttribute('aria-checked', mode === 'ptt' ? 'true' : 'false');

  shortcutDisplayEl.innerHTML = shortcutKbdHtml(label);

  if (settingInputs.launchAtLogin) settingInputs.launchAtLogin.checked = !!data.launchAtLogin;
  if (settingInputs.alwaysShowFlowBar) settingInputs.alwaysShowFlowBar.checked = !!data.alwaysShowFlowBar;
  if (settingInputs.showInTaskbar) settingInputs.showInTaskbar.checked = !!data.showInTaskbar;
  if (settingInputs.soundsEnabled) settingInputs.soundsEnabled.checked = data.soundsEnabled !== false;
  if (settingInputs.muteMusicWhileDictating) {
    settingInputs.muteMusicWhileDictating.checked = data.muteMusicWhileDictating !== false;
  }
  if (settingInputs.suggestionsEnabled) settingInputs.suggestionsEnabled.checked = data.suggestionsEnabled !== false;
  if (settingInputs.contextAwareness) settingInputs.contextAwareness.checked = data.contextAwareness !== false;
  if (settingInputs.dictationLanguage) {
    settingInputs.dictationLanguage.value = 'en';
  }
  if (settingInputs.displayName && !displayNameFocused) {
    settingInputs.displayName.value = data.displayName || '';
  }

  renderMicSelect(data);

  renderUpdateStatus(data);

  renderUnderstanding(data);

  if (data.shortcutError) {
    shortcutCaptureHint.hidden = false;
    shortcutCaptureHint.textContent = data.shortcutError;
    setTimeout(() => {
      if (!capturingShortcut) shortcutCaptureHint.hidden = true;
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

function renderUnderstanding(data) {
  const pct = data.understandingPercent || 0;
  const profile = data.understandingProfile || 'learning';
  const profileName = data.understandingProfileName || 'Learning';
  const copy = data.understandingCopy || 'Fix a misspelled word in a transcript. Voxden saves that spelling for next time.';
  const meta = understandingMetaText(data);

  if (understandingPctEl) understandingPctEl.textContent = pct + '%';
  if (understandingFillEl) understandingFillEl.style.width = pct + '%';
  if (understandingBarEl) understandingBarEl.setAttribute('aria-valuenow', String(pct));
  if (understandingMetaEl) understandingMetaEl.textContent = meta;
  if (understandingCopyEl) understandingCopyEl.textContent = copy;
  if (understandingProfileEl) understandingProfileEl.textContent = profileName;
  if (understandingBlockEl) {
    understandingBlockEl.classList.remove('is-personalized', 'is-expert');
    if (profile === 'personalized') understandingBlockEl.classList.add('is-personalized');
    if (profile === 'expert') understandingBlockEl.classList.add('is-expert');
  }

  if (vuCardEl) {
    vuCardEl.classList.remove('is-unlocked', 'is-personalized', 'is-expert');
    if (profile === 'personalized') vuCardEl.classList.add('is-personalized');
    if (profile === 'expert') vuCardEl.classList.add('is-expert');
  }
  if (vuPctEl) vuPctEl.textContent = pct + '%';
  if (vuProfileEl) vuProfileEl.textContent = profileName;
  if (vuCopyEl) vuCopyEl.textContent = copy;
  if (vuBarFillEl) vuBarFillEl.style.width = pct + '%';
  if (vuBarEl) vuBarEl.setAttribute('aria-valuenow', String(pct));
  if (vuMetaEl) vuMetaEl.textContent = meta;
  if (vuRingProgressEl) {
    vuRingProgressEl.style.strokeDashoffset = String(VU_RING_LEN * (1 - pct / 100));
  }
}

function emptyCopy(mode, label) {
  const keys = shortcutKbdHtml(label || 'Ctrl+Shift+Space');
  if (mode === 'ptt') {
    return 'Hold ' + keys + ' anywhere to dictate. Release to finish.<br/>Your transcripts will appear here.';
  }
  return 'Press ' + keys + ' anywhere to start. Press it again to finish.<br/>Your transcripts will appear here.';
}

function showLearnedToast(pairs) {
  const el = document.getElementById('learn-toast');
  if (!el || !pairs || !pairs.length) return;
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
  if (statWpmEl) {
    statWpmEl.textContent = globalThis.voxdenMetrics
      ? globalThis.voxdenMetrics.formatWpm(m.avgWpm)
      : (m.avgWpm != null ? String(m.avgWpm) : '—');
  }
  if (statTimeSavedEl) {
    statTimeSavedEl.textContent = globalThis.voxdenMetrics
      ? globalThis.voxdenMetrics.formatTimeSaved(m.timeSavedMs)
      : '—';
  }
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

function resetDictForm() {
  dictEditingFrom = null;
  if (dictFromEl) dictFromEl.value = '';
  if (dictToEl) dictToEl.value = '';
  if (dictSubmitEl) dictSubmitEl.textContent = 'Add';
  setDictError('');
}

function startDictEdit(phrase) {
  if (!phrase) return;
  dictEditingFrom = phrase.from;
  if (dictFromEl) dictFromEl.value = phrase.from;
  if (dictToEl) dictToEl.value = phrase.to;
  if (dictSubmitEl) dictSubmitEl.textContent = 'Save';
  setDictError('');
  if (dictFromEl) dictFromEl.focus();
}

function buildDictRow(phrase) {
  const row = document.createElement('div');
  row.className = 'dict-row';
  if (dictEditingFrom && phrase.from.toLowerCase() === dictEditingFrom.toLowerCase()) {
    row.classList.add('is-editing');
  }

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

  const actions = document.createElement('div');
  actions.className = 'dict-row-actions';
  const editBtn = makeIconBtn('Edit', EDIT_PATH, false);
  const delBtn = makeIconBtn('Delete', TRASH_PATH, true);
  actions.appendChild(editBtn);
  actions.appendChild(delBtn);

  editBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    startDictEdit(phrase);
    renderDictionary(lastPayload || {});
  });
  delBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    window.voxden.deletePhrase(phrase.from).then(() => {
      if (dictEditingFrom && phrase.from.toLowerCase() === dictEditingFrom.toLowerCase()) {
        resetDictForm();
      }
    });
  });

  row.appendChild(from);
  row.appendChild(arrow);
  row.appendChild(to);
  row.appendChild(actions);
  return row;
}

function renderDictionary(payload) {
  if (!dictListEl) return;
  const data = payload || lastPayload || {};
  const phrases = data.phrases || [];
  const q = dictQuery.trim().toLowerCase();
  const filtered = q
    ? phrases.filter((p) =>
      (p.from || '').toLowerCase().includes(q) || (p.to || '').toLowerCase().includes(q))
    : phrases;

  dictEmptyEl.hidden = phrases.length > 0;
  dictNoMatchEl.hidden = !(q && phrases.length > 0 && !filtered.length);

  dictListEl.innerHTML = '';
  for (const phrase of filtered) {
    dictListEl.appendChild(buildDictRow(phrase));
  }
}

async function submitDictForm(e) {
  e.preventDefault();
  const from = dictFromEl ? dictFromEl.value.trim() : '';
  const to = dictToEl ? dictToEl.value.trim() : '';
  if (!from || !to) {
    setDictError('Both sides are required.');
    return;
  }

  if (dictEditingFrom && from.toLowerCase() !== dictEditingFrom.toLowerCase()) {
    await window.voxden.deletePhrase(dictEditingFrom);
  }

  const result = await window.voxden.upsertPhrase(from, to);
  if (!result || !result.ok) {
    setDictError((result && result.error) || 'Could not save that entry.');
    return;
  }

  resetDictForm();
}

function render(payload) {
  if (payload) lastPayload = payload;
  const data = lastPayload || {};
  const all = data.entries || [];

  renderGreeting(data);
  renderSettings(data);
  renderWritingStyles(data);
  renderStats(all, data);
  renderDictionary(data);

  const q = query.trim().toLowerCase();
  const entries = q ? all.filter((e) => (e.text || '').toLowerCase().includes(q)) : all;
  const mode = data.dictateMode === 'ptt' ? 'ptt' : 'toggle';
  const label = data.shortcutLabel || 'Ctrl+Shift+Space';

  emptyEl.hidden = all.length > 0;
  if (q && !entries.length) {
    emptyEl.hidden = false;
    emptyEl.innerHTML = 'No dictations match your search.';
  } else if (!all.length) {
    emptyEl.innerHTML = emptyCopy(mode, label);
  }

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

if (dictFromEl) {
  dictFromEl.addEventListener('input', () => setDictError(''));
}
if (dictToEl) {
  dictToEl.addEventListener('input', () => setDictError(''));
}

function patchSettings(patch) {
  window.voxden.setSettings(patch).then(render);
}

function pickMode(mode) {
  patchSettings({ dictateMode: mode });
}

modeToggleEl.addEventListener('click', () => pickMode('toggle'));
modePttEl.addEventListener('click', () => pickMode('ptt'));

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

shortcutChangeBtn.addEventListener('click', () => {
  if (capturingShortcut) {
    stopShortcutCapture();
    return;
  }
  startShortcutCapture();
});

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
  if (capturingShortcut) {
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') {
      stopShortcutCapture();
      return;
    }
    const accel = keyEventToAccelerator(e);
    if (!accel) return;
    stopShortcutCapture();
    patchSettings({ shortcut: accel });
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
