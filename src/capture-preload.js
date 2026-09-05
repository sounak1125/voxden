'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// A capture window gets only its own session's API, not the settings/history API.
contextBridge.exposeInMainWorld('capture', {
  load: () => ipcRenderer.invoke('screen-capture-load'),
  select: rect => ipcRenderer.invoke('screen-capture-select', rect),
  action: (action, payload) => ipcRenderer.invoke('screen-capture-action', action, payload),
  onEvent: cb => ipcRenderer.on('screen-capture-event', (_event, payload) => cb(payload)),
});
