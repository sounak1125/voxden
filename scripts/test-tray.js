'use strict';

// The tray menu is built in main.js, which cannot be required outside Electron.
// But buildTrayTemplate returns a plain array -- every Electron call sits inside
// a click closure -- so the structure can be checked by lifting the function out
// of the source and running it against stub state.
//
// What this guards: the menu showing settings it does not actually reflect. It
// was a static three-item list built once at startup, so any checkbox added to
// it would have been wrong the moment a setting changed elsewhere.

const fs = require('fs');
const path = require('path');
const style = require('../src/style');

const ROOT = path.join(__dirname, '..');
const mainSrc = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
const appHtml = fs.readFileSync(path.join(ROOT, 'src', 'app.html'), 'utf8');
const appSrc = fs.readFileSync(path.join(ROOT, 'src', 'app.js'), 'utf8');
const preloadSrc = fs.readFileSync(path.join(ROOT, 'src', 'preload.js'), 'utf8');

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

function lift(name) {
  const i = mainSrc.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('main.js no longer defines ' + name);
  let depth = 0;
  for (let k = mainSrc.indexOf('{', i); k < mainSrc.length; k++) {
    if (mainSrc[k] === '{') depth += 1;
    else if (mainSrc[k] === '}') {
      depth -= 1;
      if (!depth) return mainSrc.slice(i, k + 1);
    }
  }
  throw new Error('unbalanced braces in ' + name);
}

const SANDBOX_KEYS = [
  'style', 'mode', 'settings', 'isPtt', 'lastDictationText', 'openHistory',
  'dictationHotkeyHandler', 'pasteLastDictation', 'setDictateMode',
  'setDictationQuality', 'setTrayFlag', 'updater', 'broadcast', 'app',
  'micDevices', 'micDefaultId', 'setMicrophone',
];

// activeMicId and microphoneSubmenu are lifted rather than stubbed: the
// unplugged-device fallback is the part worth testing, so it has to be the real
// implementation running.
const LIFTED = ['activeMicId', 'microphoneSubmenu', 'buildTrayTemplate'];

function build(state) {
  const settings = Object.assign({
    shortcut: 'CommandOrControl+Shift+Space',
    pasteLastShortcut: 'CommandOrControl+Alt+V',
    dictateMode: 'toggle',
    dictationQuality: 'auto',
    verbatimMode: false,
    muteMusicWhileDictating: true,
    launchAtLogin: false,
  }, state.settings || {});
  const noop = () => {};
  const sandbox = {
    style,
    mode: state.mode || 'idle',
    settings,
    isPtt: () => settings.dictateMode === 'ptt',
    lastDictationText: () => (state.lastText || ''),
    openHistory: noop,
    dictationHotkeyHandler: noop,
    pasteLastDictation: () => Promise.resolve(),
    setDictateMode: noop,
    setDictationQuality: noop,
    setTrayFlag: noop,
    updater: { checkNow: () => Promise.resolve() },
    broadcast: noop,
    app: { quit: noop },
    micDevices: state.micDevices || [],
    micDefaultId: state.micDefaultId || '',
    setMicrophone: noop,
  };
  const body = LIFTED.map(lift).join('\n') + '\nreturn buildTrayTemplate;';
  const make = new Function(...SANDBOX_KEYS, body);
  return make(...SANDBOX_KEYS.map((k) => sandbox[k]))();
}

function labels(tpl) {
  return tpl.filter((it) => it.type !== 'separator').map((it) => it.label);
}
function find(tpl, label) {
  return tpl.find((it) => it.label === label);
}

const base = build({});

check('menu opens with the window and ends with exit', [labels(base)[0], labels(base).pop()], ['Open Voxden', 'Exit Voxden']);
check('menu is grouped, not a flat list', base.filter((it) => it.type === 'separator').length, 4);

// The dictation item is the only label that changes, and it has to reflect the
// real state -- the tray is the one place with no other sign of it.
check('idle reads start', find(build({ mode: 'idle' }), 'Start dictation') !== undefined, true);
check('recording reads finish', find(build({ mode: 'recording' }), 'Finish dictation') !== undefined, true);
check('arming reads finish', find(build({ mode: 'arming' }), 'Finish dictation') !== undefined, true);

// Accelerators come from settings, not from a hardcoded default, and must not
// register a second handler for chords globalShortcut already owns.
const dictate = find(base, 'Start dictation');
check('dictate shows the bound chord', dictate.accelerator, 'CommandOrControl+Shift+Space');
check('dictate does not re-register', dictate.registerAccelerator, false);
const custom = build({ settings: { shortcut: 'CommandOrControl+Super+J' } });
check('accelerator follows a changed shortcut', find(custom, 'Start dictation').accelerator, 'CommandOrControl+Super+J');

check('paste is dead with no history', find(base, 'Paste last dictation').enabled, false);
check('paste is live with history', find(build({ lastText: 'hi' }), 'Paste last dictation').enabled, true);

// Every toggle has to read from settings; a checkbox that is always false is
// worse than no checkbox.
const checkedOf = (tpl, label) => find(tpl, label).checked;
check('verbatim off', checkedOf(base, 'Verbatim mode'), false);
check('verbatim on', checkedOf(build({ settings: { verbatimMode: true } }), 'Verbatim mode'), true);
check('mute defaults on', checkedOf(base, 'Mute music while dictating'), true);
check('mute off', checkedOf(build({ settings: { muteMusicWhileDictating: false } }), 'Mute music while dictating'), false);
check('launch off', checkedOf(base, 'Start with Windows'), false);
check('launch on', checkedOf(build({ settings: { launchAtLogin: true } }), 'Start with Windows'), true);

const radios = (tpl, label) => find(tpl, label).submenu.map((s) => s.label + (s.checked ? '*' : ''));
check('mode radios follow toggle', radios(base, 'Dictation mode'), ['Toggle*', 'Push to talk']);
check('mode radios follow ptt', radios(build({ settings: { dictateMode: 'ptt' } }), 'Dictation mode'), ['Toggle', 'Push to talk*']);
check('speed radios follow auto', radios(base, 'Dictation speed'), ['Auto*', 'Fast', 'Accurate']);
check('speed radios follow accurate', radios(build({ settings: { dictationQuality: 'accurate' } }), 'Dictation speed'), ['Auto', 'Fast', 'Accurate*']);

// The microphone picker. Only a renderer can enumerate devices, so main holds a
// reported copy; these cover what that copy can do to the menu.
const MICS = [{ id: 'aaa', label: 'Realtek Microphone Array' }, { id: 'bbb', label: 'USB Headset' }];
const micMenu = (state) => find(build(state), 'Microphone').submenu;
const micLabels = (state) => micMenu(state).map((it) => (
  it.type === 'separator' ? '----' : it.label + (it.checked ? '*' : '')
));

check('no devices reported yet still offers the default and the pane', micLabels({}), [
  'System default*', '----', 'Microphone settings…',
]);
check('devices are listed with the default named', micLabels({ micDevices: MICS, micDefaultId: 'aaa' }), [
  'System default (Realtek Microphone Array)*', '----',
  'Realtek Microphone Array', 'USB Headset', '----', 'Microphone settings…',
]);
check('the chosen device is the checked one', micLabels({
  micDevices: MICS, micDefaultId: 'aaa', settings: { microphone: 'bbb' },
}), [
  'System default (Realtek Microphone Array)', '----',
  'Realtek Microphone Array', 'USB Headset*', '----', 'Microphone settings…',
]);
// An unplugged device must not leave every radio blank -- capture falls back to
// the default, so the menu has to say so.
check('an unplugged device falls back to default', micLabels({
  micDevices: MICS, micDefaultId: 'aaa', settings: { microphone: 'gone-usb' },
}), [
  'System default (Realtek Microphone Array)*', '----',
  'Realtek Microphone Array', 'USB Headset', '----', 'Microphone settings…',
]);
check('exactly one radio is ever checked', micMenu({
  micDevices: MICS, micDefaultId: 'aaa', settings: { microphone: 'bbb' },
}).filter((it) => it.checked).length, 1);
check('the mic pane link is still reachable', /openHistory\('microphone'\)/.test(
  String(micMenu({}).find((it) => it.label === 'Microphone settings…').click)
), true);
// It had a link under Settings before it had a picker; two routes to one pane
// in one menu is clutter.
check('microphone is not duplicated under Settings', labels(find(base, 'Settings').submenu).includes('Microphone'), false);

// The renderer has to actually send the list, or the picker is permanently empty.
check('renderer reports devices', appSrc.includes('window.voxden.reportMicDevices('), true);
check('report happens on every enumeration', /renderMicSelect\(lastPayload \|\| \{\}\);\s*\n\s*reportMicDevices\(\);/.test(appSrc), true);
check('preload exposes the report channel', preloadSrc.includes('reportMicDevices'), true);
check('main only trusts its own window', /mic-devices'[\s\S]{0,200}e\.sender !== historyWin\.webContents/.test(mainSrc), true);
check('a new list rebuilds the menu', /mic-devices'[\s\S]{0,420}refreshTray\(\)/.test(mainSrc), true);

// A settings deep link naming a pane the markup does not have would open the
// window onto nothing.
const panes = new Set((appHtml.match(/data-cat="([a-z-]+)"/g) || []).map((s) => s.slice(10, -1)));
for (const item of find(base, 'Settings').submenu) {
  const cat = /openHistory\('([a-z-]+)'\)/.exec(String(item.click));
  check('settings link "' + item.label + '" targets a real pane', !!(cat && panes.has(cat[1])), true);
}

// The signature drives when the menu is rebuilt. A field the menu shows but the
// signature ignores is a checkbox that silently stops matching reality.
const sig = lift('trayMenuSignature');
for (const field of [
  'settings.shortcut', 'settings.pasteLastShortcut', 'settings.dictateMode',
  'settings.dictationQuality', 'settings.verbatimMode',
  'settings.muteMusicWhileDictating', 'settings.launchAtLogin', 'lastDictationText()',
  'activeMicId()', 'micDefaultId', 'micDevices',
]) {
  check('signature tracks ' + field, sig.includes(field), true);
}
check('signature tracks the dictation mode label', /mode === 'arming'/.test(sig), true);

// The rebuild has to be wired to the events that change what the menu shows.
check('broadcast refreshes the tray', /function broadcast\(\)[\s\S]{0,320}refreshTray\(\)/.test(mainSrc), true);
check('overlay updates refresh the tray', /function sendOverlay\(extra\)[\s\S]{0,240}refreshTray\(\)/.test(mainSrc), true);
check('tray is no longer a static menu', mainSrc.includes("{ label: 'Dictate', click: () => toggleListen() }"), false);

// The deep link survives a window that has not finished loading.
check('main defers a link sent while loading', mainSrc.includes('pendingSettingsCat'), true);
check('app-ready flushes the deferred link', /app-ready[\s\S]{0,320}pendingSettingsCat/.test(mainSrc), true);
check('preload exposes the channel', preloadSrc.includes('onOpenSettings'), true);
check('renderer listens for it', appSrc.includes('window.voxden.onOpenSettings('), true);
check('renderer rejects an unknown pane', /onOpenSettings\(\(cat\)[\s\S]{0,240}dataset\.cat === name\)\) return;/.test(appSrc), true);

if (failed) {
  process.exitCode = 1;
  console.error(failed + ' test(s) failed');
} else {
  console.log('All tray tests passed.');
}
