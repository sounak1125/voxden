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
  editEntry: (id, text) => ipcRenderer.invoke('history-edit', id, text),
  copyEntry: (id) => ipcRenderer.invoke('history-copy', id),
  deleteEntry: (id) => ipcRenderer.invoke('history-delete', id),
  deletePhrase: (from) => ipcRenderer.invoke('dict-delete', from),
  upsertPhrase: (from, to, meta) => ipcRenderer.invoke('dict-upsert', from, to, meta || {}),
  overlayHold: () => ipcRenderer.send('overlay-hold'),
  overlayRelease: () => ipcRenderer.send('overlay-release'),
  setSettings: (patch) => ipcRenderer.invoke('settings-set', patch),
  checkSmartRewrite: () => ipcRenderer.invoke('smart-rewrite-check'),
  installAsrRuntime: () => ipcRenderer.invoke('asr-runtime-install'),
  cancelAsrRuntime: () => ipcRenderer.invoke('asr-runtime-cancel'),
  removeAsrRuntime: () => ipcRenderer.invoke('asr-runtime-remove'),
  installLanguagePack: (tier) => ipcRenderer.invoke('language-pack-install', tier),
  cancelLanguagePack: () => ipcRenderer.invoke('language-pack-cancel'),
  removeLanguagePack: (tier) => ipcRenderer.invoke('language-pack-remove', tier),
  checkForUpdates: () => ipcRenderer.invoke('update-check'),
  markData: (rel) => ipcRenderer.invoke('mark-data', rel),
  clearTrainingData: () => ipcRenderer.invoke('training-clear'),
});
