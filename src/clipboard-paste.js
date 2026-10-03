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
  // `timing`, for a target that reads the clipboard late: settleMs between the
  // write and the paste keys, restoreMs before the old copy goes back.
  async function perform(text, send, image, timing) {
    restore();
    const data = readRestorable(clipboard);
    // Copied files are left alone, and this dictation is not pasted.
    if (!data) throw new Error('Clipboard contains content that cannot be safely restored');
    if (image) clipboard.writeImage(image);
    else clipboard.writeText(text);
    const saved = { data, fingerprint: JSON.stringify(fingerprint()), timer: null };
    pending = saved;
    const settleMs = timing && timing.settleMs;
    try {
      if (settleMs) {
        await new Promise(resolve => delay(resolve, settleMs));
        // A newer user copy during the VM wait belongs to the user. Do not
        // send Ctrl+V with that unrelated content into the dictation target.
        if (JSON.stringify(fingerprint()) !== saved.fingerprint) {
          throw new Error('Clipboard changed before paste');
        }
      }
      await send();
    } catch (err) {
      // A paste the user has to make themselves (keepClipboard): the words
      // stay where their own Ctrl+V finds them, and the old copy is not put
      // back over them.
      if (err && err.keepClipboard && pending === saved) pending = null;
      throw err;
    } finally {
      // Image consumers often decode asynchronously after the paste key returns.
      // Only while this paste still owns the restore: a timer left behind by a
      // kept paste would fire into the next paste and put its old copy back.
      if (pending === saved) saved.timer = delay(restore, (timing && timing.restoreMs) || (image ? 1800 : 500));
    }
  }
  return { paste(text, send, timing) {
    const operation = queue.then(() => perform(text, send, false, timing));
    queue = operation.catch(() => {});
    return operation;
  }, pasteImage(image, send) {
    const operation = queue.then(() => perform('', send, image));
    queue = operation.catch(() => {});
    return operation;
  }, restore };
}

module.exports = { createClipboardPaste, readRestorable };
