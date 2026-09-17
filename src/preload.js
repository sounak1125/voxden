'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const { applyStyleWithTone } = require('./style');
const { autoCleanup } = require('./auto-cleanup');

contextBridge.exposeInMainWorld('voxden', {
  // Only the main window opts in. Read once per document, before its styles
  // paint; a reload gets the latest saved preference without a dark flash.
  initialAppTheme: process.argv.includes('--voxden-theme-bootstrap')
    ? ipcRenderer.sendSync('app-theme-get') : 'voxden',
  onAppTheme: (cb) => ipcRenderer.on('app-theme-changed', (_e, theme) => cb(theme)),
  ready: () => ipcRenderer.send('hud-ready'),
  captureReady: () => ipcRenderer.send('capture-ready'),
  captureEnded: () => ipcRenderer.send('capture-ended'),
  hudHidden: () => ipcRenderer.send('hud-hidden'),
  setIgnoreMouse: (ignore) => ipcRenderer.send('hud-ignore-mouse', !!ignore),
  appReady: () => ipcRenderer.send('app-ready'),
  toggle: () => ipcRenderer.invoke('toggle'),
  cancel: () => ipcRenderer.send('hud-cancel'),
  confirm: () => ipcRenderer.send('hud-confirm'),
  onState: (cb) => {
    ipcRenderer.on('state', (_e, payload) => cb(payload));
  },
  onCursor: (cb) => {
    ipcRenderer.on('hud-cursor', (_e, payload) => cb(payload));
  },
  onDragEnd: (cb) => {
    ipcRenderer.on('hud-drag-end', () => cb());
  },
  onPing: (cb) => {
    ipcRenderer.on('hud-ping', (_e, seq) => cb(seq));
  },
  pong: (seq) => ipcRenderer.send('hud-pong', seq),
  frame: (seq) => ipcRenderer.send('hud-frame', seq),
  diag: (event, fields) => ipcRenderer.send('hud-diag', String(event || ''), fields || {}),
  transcribeLocal: (wav, options) => {
    const bytes = Buffer.from(wav instanceof ArrayBuffer ? new Uint8Array(wav) : wav);
    return ipcRenderer.invoke('transcribe-local', bytes, options || {});
  },
  parkAudio: (wav) => {
    const bytes = Buffer.from(wav instanceof ArrayBuffer ? new Uint8Array(wav) : wav);
    return ipcRenderer.invoke('park-audio', bytes);
  },
  transcript: (text) => ipcRenderer.send('transcript', text),
  captureFailed: (msg) => ipcRenderer.send('capture-failed', msg),
  cancelled: () => ipcRenderer.send('cancelled'),
  openHistory: () => ipcRenderer.send('open-history'),
  retryLast: () => ipcRenderer.invoke('retry-last'),
  loadApp: () => ipcRenderer.invoke('app-load'),
  historyStats: () => ipcRenderer.invoke('history-stats'),
  historyInsights: (options) => ipcRenderer.invoke('history-insights', options || {}),
  refreshQwenAccelInfo: (kind) => ipcRenderer.invoke('qwen-accel-info', kind),
  previewStyle: (text, tone, clean = false) => {
    const sample = String(text || '').slice(0, 500);
    return applyStyleWithTone(clean === true ? autoCleanup(sample) : sample, tone);
  },
  onHistory: (cb) => {
    ipcRenderer.on('history-updated', (_e, payload) => cb(payload));
  },
  onOpenSettings: (cb) => {
    ipcRenderer.on('open-settings', (_e, cat) => cb(cat));
  },
  reportMicDevices: (payload) => ipcRenderer.send('mic-devices', payload),
  editEntry: (id, text) => ipcRenderer.invoke('history-edit', id, text),
  copyEntry: (id) => ipcRenderer.invoke('history-copy', id),
  deleteEntry: (id) => ipcRenderer.invoke('history-delete', id),
  entryAudio: (id) => ipcRenderer.invoke('history-audio', id),
  saveEntryAudio: (id) => ipcRenderer.invoke('history-audio-save', id),
  retryEntry: (id) => ipcRenderer.invoke('history-retry', id),
  deletePhrase: (from) => ipcRenderer.invoke('dict-delete', from),
  upsertPhrase: (from, to, meta) => ipcRenderer.invoke('dict-upsert', from, to, meta || {}),
  acceptPending: (from) => ipcRenderer.invoke('dict-pending-accept', from),
  dismissPending: (from) => ipcRenderer.invoke('dict-pending-dismiss', from),
  undoAutoLearn: (token) => ipcRenderer.invoke('dict-auto-undo', String(token || '')),
  overlayHold: () => ipcRenderer.send('overlay-hold'),
  overlayRelease: () => ipcRenderer.send('overlay-release'),
  overlayDragStart: () => ipcRenderer.send('overlay-drag-start'),
  overlayDragEnd: () => ipcRenderer.send('overlay-drag-end'),
  overlaySettings: () => ipcRenderer.send('overlay-settings'),
  captureScreen: () => ipcRenderer.send('overlay-capture-screen'),
  resetFlowBar: () => ipcRenderer.invoke('flow-bar-reset'),
  setSettings: (patch) => ipcRenderer.invoke('settings-set', patch),
  installAsrRuntime: () => ipcRenderer.invoke('asr-runtime-install'),
  setupLocalModel: (engine) => ipcRenderer.invoke('local-model-setup', engine),
  cancelAsrRuntime: () => ipcRenderer.invoke('asr-runtime-cancel'),
  removeAsrRuntime: () => ipcRenderer.invoke('asr-runtime-remove'),
  installSpeechModel: (id, options) => ipcRenderer.invoke('speech-model-install', id, options),
  removeSpeechModel: (id) => ipcRenderer.invoke('speech-model-remove', id),
  installCudaPack: () => ipcRenderer.invoke('cuda-pack-install'),
  cancelCudaPack: () => ipcRenderer.invoke('cuda-pack-cancel'),
  removeCudaPack: () => ipcRenderer.invoke('cuda-pack-remove'),
  installQwenAccel: (kind) => ipcRenderer.invoke('qwen-accel-install', kind),
  cancelQwenAccel: (kind) => ipcRenderer.invoke('qwen-accel-cancel', kind),
  removeQwenAccel: (kind) => ipcRenderer.invoke('qwen-accel-remove', kind),
  retryQwenAccel: () => ipcRenderer.invoke('qwen-accel-retry'),
  accountRequestCode: (email) => ipcRenderer.invoke('account-code', email),
  accountVerifyCode: (email, code) => ipcRenderer.invoke('account-verify', email, code),
  accountSignOut: () => ipcRenderer.invoke('account-sign-out'),
  accountAuthOptions: () => ipcRenderer.invoke('account-auth-options'),
  accountUpdateProfile: (profile) => ipcRenderer.invoke('account-update-profile', profile),
  accountDelete: () => ipcRenderer.invoke('account-delete'),
  accountGoogleSignIn: () => ipcRenderer.invoke('account-google'),
  accountGoogleCancel: () => ipcRenderer.invoke('account-google-cancel'),
  accountRefresh: () => ipcRenderer.invoke('account-refresh'),
  accountCancel: () => ipcRenderer.invoke('account-cancel'),
  accountBillingOptions: () => ipcRenderer.invoke('account-billing-options'),
  accountBilling: () => ipcRenderer.invoke('account-billing'),
  accountCheckout: (provider, plan, region) => ipcRenderer.invoke('account-checkout', provider, plan, region),
  accountManageBilling: () => ipcRenderer.invoke('account-manage-billing'),
  accountCancelSubscription: () => ipcRenderer.invoke('account-cancel-subscription'),
  sendFeedback: (report) => ipcRenderer.invoke('feedback-send', report),
  openFeedbackIssue: (report) => ipcRenderer.invoke('feedback-open-issue', report),
  openChangelog: () => ipcRenderer.invoke('changelog-open'),
  checkForUpdates: () => ipcRenderer.invoke('update-check'),
  installUpdate: () => ipcRenderer.invoke('update-install'),
  readNotifications: () => ipcRenderer.invoke('notifications-read'),
  dismissNotification: (id) => ipcRenderer.invoke('notifications-dismiss', id),
  clearNotifications: () => ipcRenderer.invoke('notifications-clear'),
  clearTrainingData: () => ipcRenderer.invoke('training-clear'),
  clearRecordings: () => ipcRenderer.invoke('recordings-clear'),
});
