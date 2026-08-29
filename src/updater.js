'use strict';

const { app } = require('electron');
const { autoUpdater } = require('electron-updater');

let state = {
  status: 'idle',
  availableVersion: null,
  progress: null,
};
let getMode = () => 'idle';
let onStatusChange = null;
let recheckTimer = null;
let updateReady = false;

function getUpdateStatus() {
  return {
    status: state.status,
    version: app.getVersion(),
    availableVersion: state.availableVersion,
    progress: state.progress,
    packaged: app.isPackaged,
  };
}

function setStatus(status, extra) {
  state.status = status;
  if (extra && typeof extra === 'object') {
    if (extra.availableVersion) state.availableVersion = extra.availableVersion;
    if (extra.progress !== undefined) state.progress = extra.progress;
  }
  if (onStatusChange) onStatusChange(getUpdateStatus());
}

function startUpdater(options) {
  if (!app.isPackaged) {
    setStatus('idle');
    return;
  }

  getMode = (options && options.getMode) || getMode;
  onStatusChange = (options && options.onStatusChange) || null;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.autoRunAppAfterInstall = true;

  autoUpdater.on('checking-for-update', () => setStatus('checking'));
  autoUpdater.on('update-available', (info) => {
    setStatus('downloading', { availableVersion: info && info.version });
  });
  autoUpdater.on('update-not-available', () => {
    state.availableVersion = null;
    state.progress = null;
    setStatus('idle');
  });
  autoUpdater.on('download-progress', (progress) => {
    setStatus('downloading', {
      progress: progress && typeof progress.percent === 'number' ? Math.round(progress.percent) : null,
    });
  });
  autoUpdater.on('update-downloaded', () => {
    updateReady = true;
    setStatus('ready');
  });
  autoUpdater.on('error', () => {
    state.progress = null;
    setStatus('error');
  });

  checkNow();
  if (recheckTimer) clearInterval(recheckTimer);
  recheckTimer = setInterval(() => checkNow(), 6 * 60 * 60 * 1000);
}

function checkNow() {
  if (!app.isPackaged) return Promise.resolve(getUpdateStatus());
  setStatus('checking');
  return autoUpdater.checkForUpdates()
    .catch(() => {
      setStatus('error');
      return getUpdateStatus();
    });
}

function tryInstallOnQuit() {
  if (!app.isPackaged || !updateReady) return false;
  const m = getMode();
  if (m === 'recording' || m === 'transcribing') return false;
  autoUpdater.quitAndInstall(false, true);
  return true;
}

function stopUpdater() {
  if (recheckTimer) {
    clearInterval(recheckTimer);
    recheckTimer = null;
  }
}

module.exports = {
  startUpdater,
  checkNow,
  getUpdateStatus,
  tryInstallOnQuit,
  stopUpdater,
};
