'use strict';

// Accelerator plumbing shared by the main process, the settings UI and the
// landing-page preview.
//
// Two jobs that used to be done ad hoc in three places:
//
//   1. Turning an Electron accelerator into something a person can read.
//   2. Turning one into Win32 virtual-key codes, so push-to-talk can watch the
//      key the user actually chose. It used to poll VK_SPACE unconditionally,
//      which meant hold-to-dictate silently never released on any hotkey that
//      did not end in Space -- the recording just ran until the user pressed
//      the hotkey a second time.

// Windows has no "either Windows key" virtual key the way it has one for Ctrl,
// Shift and Alt, so Super expands to both and the caller treats the pair as
// "one of these is enough".
const VK_LWIN = 0x5B;
const VK_RWIN = 0x5C;

const MODIFIER_VKS = {
  commandorcontrol: [0x11],
  cmdorctrl: [0x11],
  control: [0x11],
  ctrl: [0x11],
  // Command/Cmd do nothing on Windows, but a settings file copied from a mac
  // build should still describe a chord we can watch rather than none at all.
  command: [0x11],
  cmd: [0x11],
  alt: [0x12],
  altgr: [0x12],
  option: [0x12],
  shift: [0x10],
  super: [VK_LWIN, VK_RWIN],
  meta: [VK_LWIN, VK_RWIN],
};

const KEY_VKS = {
  space: 0x20,
  tab: 0x09,
  backspace: 0x08,
  delete: 0x2E,
  insert: 0x2D,
  return: 0x0D,
  enter: 0x0D,
  up: 0x26,
  down: 0x28,
  left: 0x25,
  right: 0x27,
  home: 0x24,
  end: 0x23,
  pageup: 0x21,
  pagedown: 0x22,
  escape: 0x1B,
  esc: 0x1B,
  capslock: 0x14,
  numlock: 0x90,
  scrolllock: 0x91,
  plus: 0xBB,
  // OEM keys, spelled both as the character the capture UI records and as the
  // word Electron's own docs use.
  ';': 0xBA, semicolon: 0xBA,
  '=': 0xBB,
  ',': 0xBC, comma: 0xBC,
  '-': 0xBD, minus: 0xBD,
  '.': 0xBE, period: 0xBE,
  '/': 0xBF, slash: 0xBF,
  '`': 0xC0, backquote: 0xC0,
  '[': 0xDB, bracketleft: 0xDB,
  '\\': 0xDC, backslash: 0xDC,
  ']': 0xDD, bracketright: 0xDD,
  '\'': 0xDE, quote: 0xDE,
};

function formatShortcutLabel(accel) {
  return String(accel || 'CommandOrControl+Shift+Space')
    .replace(/CommandOrControl/g, 'Ctrl')
    .replace(/CmdOrCtrl/g, 'Ctrl')
    .replace(/Super/g, 'Win')
    .replace(/Command/g, 'Cmd');
}

// Native Windows menus right-align the text after a tab as the shortcut column.
// Electron's `accelerator` field cannot be used for that: Super/Win is dropped,
// modifier-only chords like Ctrl+Win render blank, and Chromium can show a
// different chord than settings (Alt+Ctrl+Z for Ctrl+Alt+V). The settings
// label is the source of truth.
function trayMenuLabel(name, accel) {
  const raw = String(accel || '').trim();
  if (!raw) return String(name || '');
  return String(name || '') + '\t' + formatShortcutLabel(raw);
}

// Why a registration failed, in words the settings screen can show. Electron
// reports only false (the OS refused the chord) or a throw (it could not parse
// the accelerator at all), so the rest is inference -- but the Windows-key case
// earns its own sentence. Verified against Electron 36: Ctrl+Win+J and
// Ctrl+Win+. register fine, while Ctrl+Win+Space, Ctrl+Win+D and nearly every
// bare Win+letter are held by the OS. Told only "unavailable", a user reads
// that as the app being broken.
function shortcutFailureReason(accel, threw) {
  const label = formatShortcutLabel(accel);
  if (threw) return label + ' is not a combination Voxden can use.';
  if (/(^|\+)Super(\+|$)/i.test(String(accel || ''))) {
    return label + ' is reserved by Windows. Most Windows key combinations are — try another key.';
  }
  return label + ' is already taken by Windows or another app.';
}

function splitAccelerator(accel) {
  return String(accel || '')
    .split('+')
    .map((p) => p.trim())
    .filter(Boolean);
}

// Numpad keys are their own virtual keys; the row-number keys are not the same
// physical key, so num0 must not collapse onto 0.
function numpadVk(name) {
  if (/^num[0-9]$/.test(name)) return 0x60 + Number(name.slice(3));
  if (name === 'numdec') return 0x6E;
  if (name === 'numadd') return 0x6B;
  if (name === 'numsub') return 0x6D;
  if (name === 'nummult') return 0x6A;
  if (name === 'numdiv') return 0x6F;
  return 0;
}

// A single accelerator segment -> the virtual keys that satisfy it. Returns an
// empty array for anything unrecognised (media keys, for instance, which the
// capture UI cannot produce anyway) so callers can just drop it.
function segmentVks(part) {
  const raw = String(part || '').trim();
  if (!raw) return [];
  const name = raw.toLowerCase();
  if (MODIFIER_VKS[name]) return MODIFIER_VKS[name].slice();
  if (Object.prototype.hasOwnProperty.call(KEY_VKS, name)) return [KEY_VKS[name]];
  const num = numpadVk(name);
  if (num) return [num];
  if (/^f([1-9]|1[0-9]|2[0-4])$/.test(name)) return [0x70 + Number(name.slice(1)) - 1];
  if (/^[0-9a-z]$/.test(name)) return [name.toUpperCase().charCodeAt(0)];
  return [];
}

// The whole chord as groups of alternatives: [[0x11], [0x5B, 0x5C], [0x20]] for
// Ctrl+Super+Space. The chord is held while every group has at least one key
// down, which is what makes "release to finish" fire the moment any part of the
// combination is let go -- not just the main key.
function acceleratorVkGroups(accel) {
  const groups = [];
  const seen = new Set();
  for (const part of splitAccelerator(accel)) {
    const vks = segmentVks(part);
    if (!vks.length) continue;
    const id = vks.join('|');
    if (seen.has(id)) continue;
    seen.add(id);
    groups.push(vks);
  }
  return groups;
}

// The same chord as macOS key codes, for the Swift helper. Modifiers are real
// keys there, each with a left and a right code, so a group lists both and the
// chord is held while either is down. CommandOrControl is Command on a Mac,
// and Super is Command too, since that is the key in the same position.
const MAC_MODIFIER_KEYS = {
  commandorcontrol: [55, 54],
  cmdorctrl: [55, 54],
  command: [55, 54],
  cmd: [55, 54],
  super: [55, 54],
  meta: [55, 54],
  control: [59, 62],
  ctrl: [59, 62],
  alt: [58, 61],
  altgr: [58, 61],
  option: [58, 61],
  shift: [56, 60],
};

// ANSI key codes from Carbon's Events.h. Insert and Scroll Lock have no key
// on a Mac keyboard and drop out of the chord, the same as an unknown name.
const MAC_KEY_CODES = {
  space: 49, tab: 48, backspace: 51, delete: 117, return: 36, enter: 36,
  up: 126, down: 125, left: 123, right: 124, home: 115, end: 119,
  pageup: 116, pagedown: 121, escape: 53, esc: 53, capslock: 57, numlock: 71,
  plus: 24, '=': 24,
  ';': 41, semicolon: 41, ',': 43, comma: 43, '-': 27, minus: 27,
  '.': 47, period: 47, '/': 44, slash: 44, '`': 50, backquote: 50,
  '[': 33, bracketleft: 33, '\\': 42, backslash: 42, ']': 30, bracketright: 30,
  '\'': 39, quote: 39,
  a: 0, s: 1, d: 2, f: 3, h: 4, g: 5, z: 6, x: 7, c: 8, v: 9, b: 11, q: 12,
  w: 13, e: 14, r: 15, y: 16, t: 17, o: 31, u: 32, i: 34, p: 35, l: 37, j: 38,
  k: 40, n: 45, m: 46,
  1: 18, 2: 19, 3: 20, 4: 21, 5: 23, 6: 22, 7: 26, 8: 28, 9: 25, 0: 29,
  num0: 82, num1: 83, num2: 84, num3: 85, num4: 86, num5: 87, num6: 88,
  num7: 89, num8: 91, num9: 92, numdec: 65, numadd: 69, numsub: 78,
  nummult: 67, numdiv: 75,
};

const MAC_F_KEYS = [122, 120, 99, 118, 96, 97, 98, 100, 101, 109, 103, 111,
  105, 107, 113, 106, 64, 79, 80, 90];

function segmentMacKeys(part) {
  const name = String(part || '').trim().toLowerCase();
  if (!name) return [];
  if (MAC_MODIFIER_KEYS[name]) return MAC_MODIFIER_KEYS[name].slice();
  if (Object.prototype.hasOwnProperty.call(MAC_KEY_CODES, name)) return [MAC_KEY_CODES[name]];
  const f = /^f([1-9]|1[0-9]|20)$/.exec(name);
  if (f) return [MAC_F_KEYS[Number(f[1]) - 1]];
  return [];
}

function acceleratorMacKeyGroups(accel) {
  const groups = [];
  const seen = new Set();
  for (const part of splitAccelerator(accel)) {
    const keys = segmentMacKeys(part);
    if (!keys.length) continue;
    const id = keys.join('|');
    if (seen.has(id)) continue;
    seen.add(id);
    groups.push(keys);
  }
  return groups;
}

// The chord as the helper on this platform wants it, already on the wire.
function encodeChordFor(platform, accel) {
  const groups = platform === 'darwin' ? acceleratorMacKeyGroups(accel) : acceleratorVkGroups(accel);
  return encodeVkGroups(groups);
}

// True when the chord is modifiers and nothing else -- Ctrl+Win, say.
// RegisterHotKey cannot express one of these: it wants a virtual key to bind to
// and two modifiers give it none, so globalShortcut refuses them and the app
// watches the key state instead. Two is the floor; a single modifier would fire
// on Ctrl, which is not a shortcut, it is typing.
function isModifierOnly(accel) {
  const parts = splitAccelerator(accel);
  if (parts.length < 2) return false;
  return parts.every((p) => Object.prototype.hasOwnProperty.call(MODIFIER_VKS, p.toLowerCase()));
}

// Wire format for scripts/win32.ps1 and helper/mac/main.swift: groups separated
// by commas, alternatives within a group by pipes.
function encodeVkGroups(groups) {
  return (groups || []).map((g) => g.join('|')).join(',');
}

module.exports = {
  formatShortcutLabel,
  trayMenuLabel,
  shortcutFailureReason,
  isModifierOnly,
  splitAccelerator,
  segmentVks,
  acceleratorVkGroups,
  segmentMacKeys,
  acceleratorMacKeyGroups,
  encodeChordFor,
  encodeVkGroups,
};
