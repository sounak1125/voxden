'use strict';

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const MAX_FIELD_LENGTH = 12000;
const START_TIMEOUT_MS = 3000;
const LIFETIME_MS = 90000;
// JSON can escape each input character into six ASCII characters.
const MAX_MESSAGE_LENGTH = MAX_FIELD_LENGTH * 6 + 4096;

function defaultScriptPath() {
  const packaged = process.resourcesPath && path.join(process.resourcesPath, 'scripts', 'correction-watch.ps1');
  return packaged && fs.existsSync(packaged) ? packaged : path.join(__dirname, '..', 'scripts', 'correction-watch.ps1');
}

/**
 * On-demand, local-only observation of one focused editable field. Call start
 * BEFORE pasting dictation and await its initial snapshot (or null). The initial
 * snapshot is returned only; onSnapshot receives subsequent changed snapshots.
 * Each snapshot is {fieldId, hwnd, text}; no text is logged or persisted here.
 * stop(), another start(), focus loss, unsupported controls and timeouts discard
 * the session. onStop receives a non-sensitive reason, once per started helper.
 * dependencies are injectable so tests never inspect another application's text.
 */
function createCorrectionObserver({ onSnapshot = () => {}, onStop = () => {}, scriptPath = defaultScriptPath() } = {}, dependencies = {}) {
  const spawnProcess = dependencies.spawn || spawn;
  const platform = dependencies.platform || process.platform;
  const delay = dependencies.setTimeout || setTimeout;
  const cancel = dependencies.clearTimeout || clearTimeout;
  let active = null;

  function finish(session, reason) {
    if (session.finished) return;
    session.finished = true;
    if (active === session) active = null;
    cancel(session.startTimer);
    cancel(session.lifeTimer);
    session.buffer = '';
    session.lastText = null;
    session.initial = null;
    if (session.resolve) { session.resolve(null); session.resolve = null; }
    try { session.child.kill(); } catch (_) {}
    try { onStop(reason); } catch (_) {}
  }

  function stop() {
    if (active) finish(active, 'stopped');
  }

  function receive(session, message) {
    if (session.finished || active !== session) return;
    if (message && message.type === 'stop') {
      const reasons = ['focus-changed', 'unsupported', 'expired', 'unavailable'];
      finish(session, reasons.includes(message.reason) ? message.reason : 'unavailable');
      return;
    }
    if (!message || !['ready', 'snapshot'].includes(message.type) ||
        typeof message.fieldId !== 'string' || !message.fieldId || message.fieldId.length > 1024 ||
        String(message.hwnd) !== session.hwnd || typeof message.text !== 'string' ||
        message.text.length > MAX_FIELD_LENGTH) {
      finish(session, 'invalid-message');
      return;
    }
    const snapshot = { fieldId: message.fieldId, hwnd: session.hwnd, text: message.text };
    if (!session.initial) {
      if (message.type !== 'ready') { finish(session, 'invalid-message'); return; }
      session.initial = { fieldId: snapshot.fieldId };
      session.lastText = snapshot.text;
      cancel(session.startTimer);
      const resolve = session.resolve;
      session.resolve = null;
      resolve(snapshot);
      return;
    }
    if (message.type !== 'snapshot' || snapshot.fieldId !== session.initial.fieldId) {
      finish(session, 'focus-changed');
      return;
    }
    if (snapshot.text === session.lastText) return;
    session.lastText = snapshot.text;
    try { onSnapshot(snapshot); } catch (_) { finish(session, 'callback-error'); }
  }

  function start({ hwnd } = {}) {
    stop();
    const target = String(hwnd || '');
    if (platform !== 'win32' || !/^[1-9]\d{0,18}$/.test(target) || BigInt(target) > 9223372036854775807n) {
      return Promise.resolve(null);
    }
    let child;
    try {
      child = spawnProcess('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Mta', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-Hwnd', target,
      ], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch (_) { return Promise.resolve(null); }
    return new Promise(resolve => {
      const session = { child, hwnd: target, resolve, buffer: '', finished: false, initial: null, lastText: null };
      active = session;
      session.startTimer = delay(() => finish(session, 'startup-timeout'), START_TIMEOUT_MS);
      session.lifeTimer = delay(() => finish(session, 'expired'), LIFETIME_MS);
      session.startTimer.unref?.();
      session.lifeTimer.unref?.();
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        if (session.finished) return;
        session.buffer += chunk;
        // Check each line separately: one pipe chunk may contain several snapshots.
        let end;
        while (!session.finished && (end = session.buffer.indexOf('\n')) >= 0) {
          if (end > MAX_MESSAGE_LENGTH) { finish(session, 'invalid-message'); return; }
          const line = session.buffer.slice(0, end).trim();
          session.buffer = session.buffer.slice(end + 1);
          if (!line) continue;
          let message;
          try { message = JSON.parse(line); } catch (_) { finish(session, 'invalid-message'); return; }
          receive(session, message);
        }
        if (session.buffer.length > MAX_MESSAGE_LENGTH) finish(session, 'invalid-message');
      });
      child.on('error', () => finish(session, 'unavailable'));
      child.on('exit', () => finish(session, 'exited'));
    });
  }

  return { start, stop };
}

module.exports = { createCorrectionObserver, MAX_FIELD_LENGTH };
