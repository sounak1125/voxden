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
  isModifierOnly,
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

// The capture runs in the browser, but it is a pure function of the key event,
// so lift it out of app.js and put real events through it. Source scanning was
// enough to prove the Windows key reached the accelerator; it was not enough to
// notice that eight ordinary keys were being dropped on the floor.
const appSrcForLift = fs.readFileSync(path.join(__dirname, '..', 'src', 'app.js'), 'utf8');

// Lifts a top-level `const NAME = <literal>;` or `function NAME(...) {...}` by
// balancing whichever bracket opens the body -- objects, arrays and function
// bodies all appear here.
const PAIRS = { '{': '}', '[': ']' };
function liftFromApp(decl) {
  const start = appSrcForLift.indexOf(decl);
  if (start < 0) throw new Error('app.js no longer declares: ' + decl);
  let from;
  if (decl.startsWith('function ')) {
    from = appSrcForLift.indexOf('{', appSrcForLift.indexOf(')', start));
  } else {
    for (let k = start + decl.length; k < appSrcForLift.length; k++) {
      if (PAIRS[appSrcForLift[k]]) { from = k; break; }
    }
    if (from === undefined) throw new Error('no literal after: ' + decl);
  }
  const open = appSrcForLift[from];
  const close = PAIRS[open];
  let depth = 0;
  for (let k = from; k < appSrcForLift.length; k++) {
    if (appSrcForLift[k] === open) depth += 1;
    else if (appSrcForLift[k] === close) {
      depth -= 1;
      if (!depth) return appSrcForLift.slice(start, k + 1) + ';\n';
    }
  }
  throw new Error('unbalanced ' + open + ' in: ' + decl);
}
const capture = new Function(
  liftFromApp('const CAPTURE_KEY_NAMES =')
  + liftFromApp('const CAPTURE_MODIFIER_KEYS =')
  + liftFromApp('function modifierPartsOf(')
  + liftFromApp('function keyEventToAccelerator(')
  + liftFromApp('function shortcutCaptureProblem(')
  + 'return { keyEventToAccelerator, shortcutCaptureProblem };'
)();

function press(over) {
  return Object.assign({ key: '', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false }, over);
}
const accelOf = (over) => capture.keyEventToAccelerator(press(over));

check('ctrl letter', accelOf({ key: 'j', ctrlKey: true }), 'CommandOrControl+J');
check('ctrl win letter', accelOf({ key: 'j', ctrlKey: true, metaKey: true }), 'CommandOrControl+Super+J');
check('ctrl win space', accelOf({ key: ' ', ctrlKey: true, metaKey: true }), 'CommandOrControl+Super+Space');
check('win alt letter', accelOf({ key: 'k', metaKey: true, altKey: true }), 'Super+Alt+K');
check('ctrl punctuation', accelOf({ key: ';', ctrlKey: true }), 'CommandOrControl+;');
check('ctrl digit', accelOf({ key: '1', ctrlKey: true }), 'CommandOrControl+1');
check('ctrl arrow', accelOf({ key: 'ArrowRight', ctrlKey: true }), 'CommandOrControl+Right');

// These eight all returned null before: the mapper only knew single characters,
// function keys and arrows, so the capture sat on "Listening…" and the user had
// no way to tell the difference between an unsupported key and a broken setting.
for (const [key, want] of [
  ['Home', 'Home'], ['End', 'End'], ['PageUp', 'PageUp'], ['PageDown', 'PageDown'],
  ['Delete', 'Delete'], ['Backspace', 'Backspace'], ['Insert', 'Insert'],
  ['Tab', 'Tab'], ['Enter', 'Return'],
]) {
  check('ctrl ' + key, accelOf({ key, ctrlKey: true }), 'CommandOrControl+' + want);
}

// Verified against Electron 36: every name above registers under Ctrl+Shift.
check('F-keys stop at F24', accelOf({ key: 'F24', ctrlKey: true }), 'CommandOrControl+F24');
check('F25 is not a key', accelOf({ key: 'F25', ctrlKey: true }), null);

// A modifier on its own is the user mid-chord, not a mistake, so it must stay
// silent -- an error on every Ctrl press would make the capture unusable.
for (const key of ['Control', 'Shift', 'Alt', 'Meta', 'OS', 'AltGraph']) {
  check('holding ' + key + ' yields nothing', accelOf({ key, ctrlKey: true }), null);
  check('holding ' + key + ' says nothing', capture.shortcutCaptureProblem(press({ key, ctrlKey: true })), null);
}
check('escape stays silent', capture.shortcutCaptureProblem(press({ key: 'Escape' })), null);

check('a bare key is rejected', accelOf({ key: 'j' }), null);
check('a bare key says what is missing', capture.shortcutCaptureProblem(press({ key: 'j' })),
  'Hold Ctrl, Alt, Shift or the Windows key as well.');
check('an unusable key names itself', capture.shortcutCaptureProblem(press({ key: 'F13x', ctrlKey: true })),
  'F13x can’t be part of a shortcut. Try another key.');
check('the handler reports the problem instead of ignoring it',
  /if \(!accel\) \{[\s\S]{0,200}setShortcutHint\(problem, 'error'\)/.test(appSrcForLift), true);

// The renderer is loaded in a browser, not by Node, so pin its capture rules by
// source text too.
const appSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'app.js'), 'utf8');
check('capture emits Super', appSrc.includes("if (e.metaKey) parts.push('Super')"), true);
// The bug was specifically pushing CommandOrControl for a Windows-key press.
// A bare "e.ctrlKey || e.metaKey" is fine elsewhere -- shortcutCaptureProblem
// uses it to ask whether any modifier at all is held.
check('capture no longer folds meta into ctrl',
  /e\.ctrlKey \|\| e\.metaKey\) parts\.push\('CommandOrControl'\)/.test(appSrc), false);

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

// A chord of modifiers alone cannot go through RegisterHotKey, so main.js has to
// recognise it and watch the key state instead. Two modifiers is the floor: one
// would fire on every Ctrl press, which is typing, not a shortcut.
check('ctrl+win is modifier only', isModifierOnly('CommandOrControl+Super'), true);
check('win+alt is modifier only', isModifierOnly('Super+Alt'), true);
check('three modifiers still count', isModifierOnly('CommandOrControl+Alt+Shift'), true);
check('a real key disqualifies it', isModifierOnly('CommandOrControl+Super+J'), false);
check('the default is not modifier only', isModifierOnly('CommandOrControl+Shift+Space'), false);
check('one modifier is not a chord', isModifierOnly('CommandOrControl'), false);
check('a lone win key is not a chord', isModifierOnly('Super'), false);
check('nothing is not a chord', isModifierOnly(''), false);
check('ctrl+win maps to the watchable keys', encodeVkGroups(acceleratorVkGroups('CommandOrControl+Super')), '17,91|92');

// The capture has no key press to end a modifier-only chord, so it commits on
// release -- and must not do that once a real key has been seen.
check('capture commits modifiers on keyup', /captureMods\.join\('\+'\)/.test(appSrcForLift), true);
check('capture ignores keyup after a real key', /if \(!capturingShortcutKind \|\| captureSawKey\) return;/.test(appSrcForLift), true);
check('capture demands two modifiers', /captureMods\.length < 2/.test(appSrcForLift), true);

// main.js must route a modifier-only chord away from globalShortcut, and the
// watcher must not outlive the app.
check('main detects a modifier-only chord', mainSrc.includes('hotkeys.isModifierOnly(candidate)'), true);
check('main watches instead of registering', /isModifierOnly\(candidate\)\)[\s\S]{0,160}startChordWatch\(candidate\)/.test(mainSrc), true);
check('a dirty chord does not toggle', /msg === 'UP clean'/.test(mainSrc), true);
check('a dirty chord discards a ptt recording', /msg === 'UP dirty'[\s\S]{0,40}cancelListen\(\)/.test(mainSrc), true);
check('quitting stops the watcher', /will-quit[\s\S]{0,400}stopChordWatch\(\)/.test(mainSrc), true);
check('ptt polling defers to the watcher', /function startPttWatch\(\)[\s\S]{0,200}if \(chordWatch\) return;/.test(mainSrc), true);
check('ps1 has the watch action', /"hotkey-watch"\s*\{/.test(psSrc), true);
check('ps1 reports clean and dirty releases', psSrc.includes('"UP dirty" : "UP clean"'), true);
check('ps1 excludes sided modifier variants', psSrc.includes('static System.Collections.Generic.HashSet<int> ChordKeys'), true);

if (failed) {
  process.exitCode = 1;
  console.error(failed + ' test(s) failed');
} else {
  console.log('All hotkey tests passed.');
}
