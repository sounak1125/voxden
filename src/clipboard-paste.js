'use strict';

// Copied files, as Chromium names CF_HDROP. They cannot be written back, and a
// Cut in Explorer moves nothing until the files are pasted, so a paste never
// takes the clipboard from them.
const FILES = 'text/uri-list';

// What the clipboard holds that one clipboard.write can put back, in the shape
// it takes: text, HTML, RTF, an image, a bookmark. Anything else, such as the extra copy an editor like VS Code adds
// beside the plain text, is left out and is gone after a paste. Null when the
// clipboard holds copied files.
function readRestorable(clipboard) {
  const formats = clipboard.availableFormats();
  if (formats.includes(FILES)) return null;
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
  return data;
}

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
  async function perform(text, send, image) {
    restore();
    const data = readRestorable(clipboard);
    // Copied files are left alone, and this dictation is not pasted.
    if (!data) throw new Error('Clipboard contains content that cannot be safely restored');
    if (image) clipboard.writeImage(image);
    else clipboard.writeText(text);
    const saved = { data, fingerprint: JSON.stringify(fingerprint()), timer: null };
    pending = saved;
    try { await send(); } finally {
      // Image consumers often decode asynchronously after the paste key returns.
      saved.timer = delay(restore, image ? 1800 : 500);
    }
  }
  return { paste(text, send) {
    const operation = queue.then(() => perform(text, send));
    queue = operation.catch(() => {});
    return operation;
  }, pasteImage(image, send) {
    const operation = queue.then(() => perform('', send, image));
    queue = operation.catch(() => {});
    return operation;
  }, restore };
}

module.exports = { createClipboardPaste, readRestorable };
