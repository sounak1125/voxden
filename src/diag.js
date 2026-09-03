'use strict';

const fs = require('fs');
const path = require('path');

// A diagnostic log for the things that go wrong quietly: the flow bar's page
// freezing, a microphone that never opens, a resume from sleep that leaves the
// bar deaf to the mouse. None of those show in the sidecar log, and until now
// nothing wrote them down anywhere, so a report of "it froze" could not be
// told apart from "the app froze".
//
// One JSON object per line, timestamped, appended synchronously -- these are
// rare events on a thread that is otherwise idle, and a log that buffers is a
// log that is empty after the crash it was meant to explain. The file is
// rolled once when it passes its cap, so the worst case on disk is two of them.

const DEFAULT_MAX_BYTES = 512 * 1024;

function createDiagLog(options) {
  const opts = options || {};
  const file = opts.file ? String(opts.file) : '';
  const maxBytes = Math.max(4096, Number(opts.maxBytes) || DEFAULT_MAX_BYTES);
  const clock = typeof opts.now === 'function' ? opts.now : () => new Date();
  let written = -1;

  function roll() {
    try {
      fs.renameSync(file, file + '.1');
    } catch (_) {}
    written = 0;
  }

  function size() {
    if (written >= 0) return written;
    try {
      written = fs.statSync(file).size;
    } catch (_) {
      written = 0;
    }
    return written;
  }

  function log(event, fields) {
    if (!file) return;
    const entry = Object.assign({ ts: clock().toISOString(), event: String(event || '') }, fields || {});
    let line;
    try {
      line = JSON.stringify(entry) + '\n';
    } catch (_) {
      line = JSON.stringify({ ts: entry.ts, event: entry.event }) + '\n';
    }
    try {
      if (size() + line.length > maxBytes) roll();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, line);
      written = size() + line.length;
    } catch (_) {
      // A log that cannot be written must never take the app down with it.
    }
  }

  return { log, file };
}

module.exports = { createDiagLog, DEFAULT_MAX_BYTES };
