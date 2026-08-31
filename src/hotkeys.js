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

// Wire format for scripts/win32.ps1: groups separated by commas, alternatives
// within a group by pipes.
function encodeVkGroups(groups) {
  return (groups || []).map((g) => g.join('|')).join(',');
}

module.exports = {
  formatShortcutLabel,
  shortcutFailureReason,
  isModifierOnly,
  splitAccelerator,
  segmentVks,
  acceleratorVkGroups,
  encodeVkGroups,
};
