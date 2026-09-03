'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('voxden', {
  ready: () => ipcRenderer.send('hud-ready'),
  captureReady: () => ipcRenderer.send('capture-ready'),
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
  overlayHold: () => ipcRenderer.send('overlay-hold'),
  overlayRelease: () => ipcRenderer.send('overlay-release'),
  overlayDragStart: () => ipcRenderer.send('overlay-drag-start'),
  overlayDragEnd: () => ipcRenderer.send('overlay-drag-end'),
  overlaySettings: () => ipcRenderer.send('overlay-settings'),
  resetFlowBar: () => ipcRenderer.invoke('flow-bar-reset'),
  setSettings: (patch) => ipcRenderer.invoke('settings-set', patch),
  installAsrRuntime: () => ipcRenderer.invoke('asr-runtime-install'),
  cancelAsrRuntime: () => ipcRenderer.invoke('asr-runtime-cancel'),
  removeAsrRuntime: () => ipcRenderer.invoke('asr-runtime-remove'),
  installSpeechModel: (id) => ipcRenderer.invoke('speech-model-install', id),
  removeSpeechModel: (id) => ipcRenderer.invoke('speech-model-remove', id),
  installCudaPack: () => ipcRenderer.invoke('cuda-pack-install'),
  cancelCudaPack: () => ipcRenderer.invoke('cuda-pack-cancel'),
  removeCudaPack: () => ipcRenderer.invoke('cuda-pack-remove'),
  installQwenAccel: (kind) => ipcRenderer.invoke('qwen-accel-install', kind),
  cancelQwenAccel: (kind) => ipcRenderer.invoke('qwen-accel-cancel', kind),
  removeQwenAccel: (kind) => ipcRenderer.invoke('qwen-accel-remove', kind),
  retryQwenAccel: () => ipcRenderer.invoke('qwen-accel-retry'),
  checkForUpdates: () => ipcRenderer.invoke('update-check'),
  installUpdate: () => ipcRenderer.invoke('update-install'),
  readNotifications: () => ipcRenderer.invoke('notifications-read'),
  dismissNotification: (id) => ipcRenderer.invoke('notifications-dismiss', id),
  clearNotifications: () => ipcRenderer.invoke('notifications-clear'),
  clearTrainingData: () => ipcRenderer.invoke('training-clear'),
  clearRecordings: () => ipcRenderer.invoke('recordings-clear'),
});
