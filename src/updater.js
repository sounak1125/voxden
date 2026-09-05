'use strict';

const { app } = require('electron');
const { autoUpdater } = require('electron-updater');

let state = {
  status: 'idle',
  availableVersion: null,
  progress: null,
  installError: '',
};
let getMode = () => 'idle';
let onStatusChange = null;
let recheckTimer = null;
let updateReady = false;
// Set once the installer has been spawned, by either path below. From then on
// the app is on its way out and nothing may start a second installer.
let installStarted = false;

function getUpdateStatus() {
  return {
    status: state.status,
    version: app.getVersion(),
    availableVersion: state.availableVersion,
    progress: state.progress,
    installError: state.installError,
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
    setStatus('downloading', { availableVersion: info && info.version, progress: 0 });
  });
  autoUpdater.on('update-not-available', () => {
    // A finished download stays ready even if a later check finds nothing
    // newer: the file is on disk and the restart button still has a job.
    if (updateReady) {
      setStatus('ready');
      return;
    }
    state.availableVersion = null;
    state.progress = null;
    setStatus('idle');
  });
  autoUpdater.on('download-progress', (progress) => {
    const percent = progress && typeof progress.percent === 'number'
      ? Math.round(progress.percent)
      : null;
    // Every status change is a full snapshot to the window and a tray
    // rebuild. The download reports once a second whether or not the number
    // moved, and a number that has not moved is not worth either.
    if (state.status === 'downloading' && percent === state.progress) return;
    setStatus('downloading', { progress: percent });
  });
  autoUpdater.on('update-downloaded', (info) => {
    updateReady = true;
    setStatus('ready', { availableVersion: info && info.version, progress: 100 });
  });
  autoUpdater.on('error', () => {
    if (installStarted) {
      installStarted = false;
      state.installError = 'The installer could not be started. Try restarting again.';
      setStatus('ready');
      return;
    }
    if (updateReady) {
      setStatus('ready');
      return;
    }
    state.progress = null;
    setStatus('error');
  });

  checkNow();
  if (recheckTimer) clearInterval(recheckTimer);
  recheckTimer = setInterval(() => checkNow(), 6 * 60 * 60 * 1000);
}

function checkNow() {
  if (!app.isPackaged) return Promise.resolve(getUpdateStatus());
  if (installStarted) return Promise.resolve(getUpdateStatus());
  setStatus('checking');
  return autoUpdater.checkForUpdates()
    .catch(() => {
      if (updateReady) setStatus('ready');
      else setStatus('error');
      return getUpdateStatus();
    });
}

function busyDictating() {
  const m = getMode();
  return m === 'arming' || m === 'recording' || m === 'transcribing';
}

// Why not: the reason a restart cannot happen right now, or '' when it can.
function installBlocker() {
  if (!app.isPackaged) return 'Updates only install from a release build.';
  if (!updateReady) return 'No update is downloaded yet.';
  if (installStarted) return 'Voxden is already restarting.';
  if (busyDictating()) return 'Finish the dictation first, then restart.';
  return '';
}

// The restart button. The installer runs silently and relaunches Voxden when
// it is done; electron-updater quits the app itself once the installer has
// been spawned, and will-quit sees installStarted and lets the quit through.
function installNow() {
  const blocker = installBlocker();
  if (blocker) return { ok: false, reason: blocker };
  installStarted = true;
  state.installError = '';
  setStatus('installing');
  try {
    autoUpdater.quitAndInstall(true, true);
    if (!installStarted) return { ok: false, reason: 'The installer could not be started. Try again later.' };
  } catch (_) {
    installStarted = false;
    state.installError = 'The installer could not be started. Try restarting again.';
    setStatus('ready');
    return { ok: false, reason: 'The installer could not be started. Try again later.' };
  }
  return { ok: true, reason: '' };
}

// Exit Voxden with an update waiting: install it on the way out, silently and
// without relaunching -- the user asked to leave. Called from will-quit, so it
// has to be synchronous and must never hold the quit up: the installer is a
// detached process by the time this returns, and the quit carries on to the
// normal cleanup.
function installOnQuit() {
  if (!app.isPackaged || !updateReady || installStarted) return false;
  if (busyDictating()) return false;
  installStarted = true;
  try {
    autoUpdater.quitAndInstall(true, false);
    if (!installStarted) return false;
  } catch (_) {
    installStarted = false;
    return false;
  }
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
  installNow,
  installOnQuit,
  stopUpdater,
};
