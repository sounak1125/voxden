'use strict';

function createClipboardPaste(clipboard, { delay = setTimeout, cancel = clearTimeout } = {}) {
  let pending = null;
  let queue = Promise.resolve();
  function fingerprint() {
    return clipboard.availableFormats().sort().map(format =>
      [format, clipboard.readBuffer(format).toString('base64')]);
  }
  function restore() {
    if (!pending) return;
    const saved = pending;
    pending = null;
    cancel(saved.timer);
    try {
      if (JSON.stringify(fingerprint()) === saved.fingerprint) clipboard.write(saved.data);
    } catch (_) {}
  }
  async function perform(text, send) {
    restore();
    const formats = clipboard.availableFormats();
    // Electron can restore these formats together in a single clipboard write.
    // Preserve unsupported content (for example copied files) by leaving it alone.
    if (formats.some(format => !['text/plain', 'text/html', 'text/rtf', 'image/png', 'text/bookmark'].includes(format))) {
      throw new Error('Clipboard contains content that cannot be safely restored');
    }
    const data = {};
    if (formats.includes('text/plain')) data.text = clipboard.readText();
    if (formats.includes('text/html')) data.html = clipboard.readHTML();
    if (formats.includes('text/rtf')) data.rtf = clipboard.readRTF();
    if (formats.includes('image/png')) data.image = clipboard.readImage();
    if (formats.includes('text/bookmark')) {
      const bookmark = clipboard.readBookmark();
      data.bookmark = bookmark.title;
      data.text = bookmark.url;
    }
    clipboard.writeText(text);
    const saved = { data, fingerprint: JSON.stringify(fingerprint()), timer: null };
    pending = saved;
    try { await send(); } finally {
      saved.timer = delay(restore, 500);
    }
  }
  return { paste(text, send) {
    const operation = queue.then(() => perform(text, send));
    queue = operation.catch(() => {});
    return operation;
  }, restore };
}

module.exports = { createClipboardPaste };
