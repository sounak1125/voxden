'use strict';

// The identifier the platform helper reports for a window, read for one of
// our own BrowserWindows so the app can tell its own windows from a paste
// target. On Windows that is the HWND behind getNativeWindowHandle. On macOS
// that handle is an NSView pointer the window server never sees; the helper
// speaks CGWindowIDs, which Electron exposes through the media source id
// ("window:<id>:0").

function nativeHwnd(buf) {
  try {
    if (buf.length >= 8) return buf.readBigUInt64LE(0).toString();
    if (buf.length >= 4) return buf.readUInt32LE(0).toString();
  } catch (_) {}
  return '0';
}

function ownWindowId(win, platform = process.platform) {
  if (!win || (typeof win.isDestroyed === 'function' && win.isDestroyed())) return '0';
  if (platform === 'darwin') {
    try {
      const match = /^window:(\d+):/.exec(String(win.getMediaSourceId()));
      if (match) return match[1];
    } catch (_) {}
    return '0';
  }
  try {
    return nativeHwnd(win.getNativeWindowHandle());
  } catch (_) {
    return '0';
  }
}

module.exports = { nativeHwnd, ownWindowId };
