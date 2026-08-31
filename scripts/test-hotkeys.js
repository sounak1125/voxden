'use strict';

// Guards two bugs that were invisible from the UI:
//
//   1. The settings capture folded the Windows key into CommandOrControl, so no
//      Win-key accelerator could ever be produced or displayed.
//   2. Push-to-talk polled VK_SPACE no matter what the hotkey was, so
//      hold-to-dictate never released on a chord that did not end in Space.

const fs = require('fs');
const path = require('path');
const {
  formatShortcutLabel,
  shortcutFailureReason,
  segmentVks,
  acceleratorVkGroups,
  encodeVkGroups,
} = require('../src/hotkeys');

let failed = 0;
function check(name, got, expected) {
  const g = JSON.stringify(got);
  const e = JSON.stringify(expected);
  if (g !== e) {
    failed += 1;
    console.error('FAIL', name, '\n  expected', e, '\n  got     ', g);
  } else {
    console.log('ok', name);
  }
}

check('label default', formatShortcutLabel('CommandOrControl+Shift+Space'), 'Ctrl+Shift+Space');
check('label super', formatShortcutLabel('CommandOrControl+Super+Space'), 'Ctrl+Win+Space');
check('label super only', formatShortcutLabel('Super+Alt+D'), 'Win+Alt+D');
check('label falls back', formatShortcutLabel(''), 'Ctrl+Shift+Space');

// A rejected chord has to name itself and say why; "Shortcut unavailable" made
// an OS-reserved combination look like an app bug.
check(
  'reason names the win chord',
  shortcutFailureReason('CommandOrControl+Super+Space', false),
  'Ctrl+Win+Space is reserved by Windows. Most Windows key combinations are — try another key.'
);
check(
  'reason for a taken chord',
  shortcutFailureReason('CommandOrControl+Alt+V', false),
  'Ctrl+Alt+V is already taken by Windows or another app.'
);
check(
  'reason for an unparseable chord',
  shortcutFailureReason('CommandOrControl+Shift+Period', true),
  'Ctrl+Shift+Period is not a combination Voxden can use.'
);
// Super has to be a whole segment, not a substring of some other key name.
check('reason ignores super substring', /reserved by Windows/.test(shortcutFailureReason('CommandOrControl+Superb', false)), false);

check('vk letter', segmentVks('V'), [0x56]);
check('vk letter lowercase', segmentVks('v'), [0x56]);
check('vk digit', segmentVks('7'), [0x37]);
check('vk space', segmentVks('Space'), [0x20]);
check('vk f-key', segmentVks('F9'), [0x78]);
check('vk f24', segmentVks('F24'), [0x87]);
check('vk arrow', segmentVks('Up'), [0x26]);
check('vk period word', segmentVks('Period'), [0xBE]);
check('vk period char', segmentVks('.'), [0xBE]);
check('vk numpad', segmentVks('num3'), [0x63]);
// The row 3 and the numpad 3 are different physical keys.
check('vk numpad differs from digit', segmentVks('num3')[0] === segmentVks('3')[0], false);
check('vk ctrl', segmentVks('CommandOrControl'), [0x11]);
check('vk shift', segmentVks('Shift'), [0x10]);
check('vk alt', segmentVks('Alt'), [0x12]);
// Windows has no combined left/right virtual key, so Super needs both.
check('vk super both winkeys', segmentVks('Super'), [0x5B, 0x5C]);
check('vk meta same as super', segmentVks('Meta'), [0x5B, 0x5C]);
check('vk unknown', segmentVks('MediaPlayPause'), []);

check('groups default hotkey', acceleratorVkGroups('CommandOrControl+Shift+Space'), [[0x11], [0x10], [0x20]]);
// The old poller would have watched Space here and never fired.
check('groups paste hotkey', acceleratorVkGroups('CommandOrControl+Alt+V'), [[0x11], [0x12], [0x56]]);
check('groups with super', acceleratorVkGroups('CommandOrControl+Super+Space'), [[0x11], [0x5B, 0x5C], [0x20]]);
check('groups drop unknown segment', acceleratorVkGroups('CommandOrControl+MediaStop+D'), [[0x11], [0x44]]);
check('groups dedupe', acceleratorVkGroups('Ctrl+Control+D'), [[0x11], [0x44]]);
check('groups empty', acceleratorVkGroups(''), []);

check('encode', encodeVkGroups(acceleratorVkGroups('CommandOrControl+Super+Space')), '17,91|92,32');
check('encode empty', encodeVkGroups([]), '');

// The wire format above is parsed by scripts/win32.ps1; the JS suite never runs
// PowerShell, so pin the contract by source text the way test-win32.js does.
const psSrc = fs.readFileSync(path.join(__dirname, 'win32.ps1'), 'utf8');
check('ps1 has keys-down action', /"keys-down"\s*\{/.test(psSrc), true);
check('ps1 declares Vks param', /\[string\]\$Vks\s*=/.test(psSrc), true);
check('ps1 splits groups on comma', psSrc.includes('$Vks).Split(",")'), true);
check('ps1 splits alternatives on pipe', psSrc.includes('$g.Split("|")'), true);
// The hardcoded Space poll is what this change removes.
check('ps1 no space-down action', psSrc.includes('"space-down"'), false);
check('ps1 no hardcoded space poll', /GetAsyncKeyState\(0x20\)/.test(psSrc), false);

// Verified against Electron 36: "Period" and "Comma" throw on conversion, the
// literal characters register. The fallback hotkey used the word, so a failed
// paste-shortcut registration left the app with no paste hotkey at all.
const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
check('no word-spelled Period accelerator', /\+Period'/.test(mainSrc), false);
check('no word-spelled Comma accelerator', /\+Comma'/.test(mainSrc), false);

// The renderer is loaded in a browser, not by Node, so pin its capture rules by
// source text too.
const appSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'app.js'), 'utf8');
check('capture emits Super', appSrc.includes("if (e.metaKey) parts.push('Super')"), true);
check('capture no longer folds meta into ctrl', appSrc.includes('e.ctrlKey || e.metaKey'), false);

// A launch-time fallback used to swap the user's hotkey out with nothing shown.
check('main sends a hotkey notice', /hotkeyNotice,/.test(mainSrc), true);
check('registerHotkeys records the reason', mainSrc.includes('hotkeyNotice = notices.join'), true);
check('a working change clears the notice', mainSrc.includes("hotkeyNotice = '';"), true);
check('renderer reads the notice', appSrc.includes('data.hotkeyNotice'), true);
check('renderer styles failures as errors', appSrc.includes("setShortcutHint(data.shortcutError, 'error')"), true);
// The hint must fall back to the standing notice, not to blank, or a launch
// failure disappears the first time a capture is opened and cancelled.
check('hint restores rather than blanks', appSrc.includes('restoreShortcutHint()'), true);
check('no bare hide left in capture teardown', /shortcutCaptureHint\.hidden = true/.test(appSrc), false);

const cssSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'app.css'), 'utf8');
check('error hint has its own style', cssSrc.includes('.shortcut-capture-hint.is-error'), true);

if (failed) {
  process.exitCode = 1;
  console.error(failed + ' test(s) failed');
} else {
  console.log('All hotkey tests passed.');
}
