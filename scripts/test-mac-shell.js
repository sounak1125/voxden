'use strict';

// The macOS behaviour of the app, checked from Windows as well as a Mac:
// src/mac-shell.js on its own, main.js wired to it, the updater's check-only
// mode, and the ad-hoc signing in build/after-pack.js with codesign stubbed.
// Every check that names Windows proves it gets exactly what it got before.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { EventEmitter } = require('events');
const harness = require('./asr-test-harness');
const macShell = require('../src/mac-shell');
const announcements = require('../src/announcements');

const ROOT = path.join(__dirname, '..');
const mainSrc = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
const appSrc = fs.readFileSync(path.join(ROOT, 'src', 'app.js'), 'utf8');
const appCss = fs.readFileSync(path.join(ROOT, 'src', 'app.css'), 'utf8');

let checks = 0;
function ok(name, cond) {
  assert.ok(cond, name);
  checks += 1;
  console.log('ok ' + name);
}
// Values made inside a vm context have that context's prototypes, which
// deepStrictEqual counts as a difference; compare them as plain data.
const plain = (v) => (v && typeof v === 'object' ? JSON.parse(JSON.stringify(v)) : v);
function eq(name, got, expected) {
  assert.deepStrictEqual(plain(got), plain(expected), name);
  checks += 1;
  console.log('ok ' + name);
}

// --- mac-shell.js ------------------------------------------------------------

eq('Windows keeps no application menu', macShell.applicationMenuTemplate('win32'), null);
const menu = macShell.applicationMenuTemplate('darwin');
eq('a Mac gets the app, File, Edit and Window menus', menu.map((m) => m.role), ['appMenu', 'fileMenu', 'editMenu', 'windowMenu']);
eq('device name', [macShell.deviceName('win32'), macShell.deviceName('darwin')], ['this PC', 'this Mac']);
eq('paste keys', [macShell.pasteKeys('win32'), macShell.pasteKeys('darwin')], ['Ctrl+V', 'Cmd+V']);
eq('Windows tray words are unchanged', macShell.trayLabels('win32'), { launchAtLogin: 'Start with Windows', quit: 'Exit Voxden' });
eq('Mac tray words', macShell.trayLabels('darwin'), { launchAtLogin: 'Open at login', quit: 'Quit Voxden' });
eq('Windows keeps the default traffic-light-free title bar', macShell.trafficLightPosition('win32'), undefined);
eq('Mac traffic lights sit in the 48 px bar', macShell.trafficLightPosition('darwin'), { x: 18, y: 17 });

{
  const reps = [];
  const resized = [];
  const source = { resize: (size) => { resized.push(size); return { toPNG: () => Buffer.from('png' + size.width) }; } };
  const fakeImage = { createEmpty: () => ({ addRepresentation: (rep) => reps.push(rep) }) };
  macShell.menuBarImage(source, fakeImage);
  eq('the menu bar icon is 18 pt at 1x and 2x', reps.map((r) => [r.scaleFactor, r.width, r.height, String(r.buffer)]),
    [[1, 18, 18, 'png18'], [2, 36, 36, 'png36']]);
  ok('resized with the best filter', resized.every((s) => s.quality === 'best'));
}

{
  const app = { getLoginItemSettings: () => ({ wasOpenedAtLogin: true }) };
  eq('a Mac login launch is recognised', macShell.openedAtLogin(app, 'darwin'), true);
  eq('Windows still relies on --hidden', macShell.openedAtLogin(app, 'win32'), false);
  eq('an app without the API is not a login launch', macShell.openedAtLogin({}, 'darwin'), false);
  eq('a throwing API is not a login launch', macShell.openedAtLogin({ getLoginItemSettings: () => { throw new Error('x'); } }, 'darwin'), false);
}

{
  const asked = [];
  const prefs = (status) => ({
    getMediaAccessStatus: () => status,
    askForMediaAccess: (kind) => { asked.push(kind); return Promise.resolve(true); },
  });
  eq('an undecided microphone is asked about on a Mac', macShell.askForMicrophone(prefs('not-determined'), 'darwin'), true);
  eq('a decided microphone is left alone', macShell.askForMicrophone(prefs('denied'), 'darwin'), false);
  eq('Windows never asks', macShell.askForMicrophone(prefs('not-determined'), 'win32'), false);
  eq('only the microphone was asked for, once', asked, ['microphone']);
  eq('no systemPreferences is not a crash', macShell.askForMicrophone(undefined, 'darwin'), false);
}

{
  const calls = [];
  const trusted = (value) => ({ isTrustedAccessibilityClient: (prompt) => { calls.push(prompt); return value; } });
  eq('an untrusted Mac paste is an Accessibility problem', macShell.pasteNeedsAccessibility(trusted(false), 'darwin'), true);
  eq('and raises the system prompt after the silent check', calls, [false, true]);
  calls.length = 0;
  eq('a trusted Mac paste failed for another reason', macShell.pasteNeedsAccessibility(trusted(true), 'darwin'), false);
  eq('without prompting', calls, [false]);
  calls.length = 0;
  eq('Windows never asks macOS', macShell.pasteNeedsAccessibility(trusted(false), 'win32'), false);
  eq('and calls nothing', calls, []);
}

{
  const focused = [];
  const app = { focus: (opts) => focused.push(opts) };
  macShell.bringForward(app, 'win32');
  macShell.bringForward(app, 'darwin');
  eq('only a Mac steals focus for the dashboard', focused, [{ steal: true }]);
}

// --- main.js is wired to it --------------------------------------------------

ok('the application menu comes from mac-shell', /const appMenu = macShell\.applicationMenuTemplate\(process\.platform\);\s*\n\s*Menu\.setApplicationMenu\(appMenu \? Menu\.buildFromTemplate\(appMenu\) : null\);/.test(mainSrc));
ok('no unconditional null menu is left', !/Menu\.setApplicationMenu\(null\)/.test(mainSrc));
ok('activate reopens the dashboard', /app\.on\('activate', \(\) => \{\s*\n\s*if \(app\.isReady\(\) && !isQuitting\) openHistory\(\);/.test(mainSrc));
ok('the microphone is asked about at launch', /macShell\.askForMicrophone\(require\('electron'\)\.systemPreferences, process\.platform\)/.test(mainSrc));
ok('a login launch on a Mac keeps the dashboard closed', /!process\.argv\.includes\('--hidden'\) && !macShell\.openedAtLogin\(app, process\.platform\)/.test(mainSrc));
ok('the dashboard brings a Mac app forward before showing', /macShell\.bringForward\(app, process\.platform\);\s*\n\s*historyWin\.show\(\);/.test(mainSrc));
ok('the traffic lights are placed', /trafficLightPosition: macShell\.trafficLightPosition\(process\.platform\)/.test(mainSrc));
ok('the Mac tray icon is built for the menu bar', /if \(process\.platform === 'darwin'\) return macShell\.menuBarImage\(img, nativeImage\);/.test(mainSrc));
ok('the tray words come from mac-shell', /label: words\.launchAtLogin/.test(mainSrc) && /label: words\.quit/.test(mainSrc));
ok('no hard-coded Ctrl+V hint in the flow bar', !/Paste it with Ctrl\+V/.test(mainSrc));
eq('no hard-coded "this PC" in user-facing strings of main.js (console lines aside)',
  mainSrc.split('\n').filter((line) => /'[^']*\bthis PC\b[^']*'/.test(line) && !/console\.\w+\(/.test(line)), []);
ok('an available update is noted on a Mac', /status\.status === 'available'[\s\S]{0,200}updateAvailableEntry\(status\.availableVersion\)/.test(mainSrc));

// --- the renderer --------------------------------------------------------------

ok('the Mac title bar makes room for the traffic lights', /html\[data-platform="darwin"\] \.titlebar \{\s*padding-left: 84px;\s*padding-right: 16px;/.test(appCss));
ok('only a Mac snapshot marks the document', /if \(next !== 'darwin'\) return;\s*\n\s*\/\/[^\n]*\n\s*document\.documentElement\.dataset\.platform = 'darwin';/.test(appSrc));
ok('the update pane explains a Mac release', /case 'available':\s*\n\s*hint = next \+ ' is out\. Download it from voxden\.app\/download\.';/.test(appSrc));
ok('the restart button becomes Download on a Mac', /updateRestartBtn\.textContent = manual \? 'Download'/.test(appSrc));
ok('the polish copy hint names the Mac key', /isMacUi\(\) \? 'Cmd\+C\.' : 'Ctrl\+C\.'/.test(appSrc));
ok('a Mac hides the taskbar switch, which has no Dock to act on',
  /if \(next !== 'darwin'\) return;[\s\S]{0,1600}getElementById\('set-taskbar'\)[\s\S]{0,120}closest\('\.setting-row'\)[\s\S]{0,80}style\.display = 'none'/.test(appSrc));
ok('and no longer relabels it for the Dock', !/Show app in the Dock/.test(appSrc));
ok('a Mac hides the mute switch, which the Mac helper cannot act on',
  /if \(next !== 'darwin'\) return;[\s\S]{0,2000}getElementById\('set-mute-music'\)[\s\S]{0,120}closest\('\.setting-row'\)[\s\S]{0,80}style\.display = 'none'/.test(appSrc));

// --- announcements -------------------------------------------------------------

{
  const entry = announcements.updateAvailableEntry('2.2.0');
  eq('an available release is keyed apart from a downloaded one', entry.id, 'update-available:2.2.0');
  ok('it says where the download is', /voxden\.app\/download/.test(entry.body));
  eq('it opens the System pane', entry.action, { settings: 'system' });
  eq('no version, no notice', announcements.updateAvailableEntry(' '), null);
}

// --- updater: check-only on a Mac, unchanged on Windows ------------------------

function loadUpdater(platform) {
  const autoUpdater = new EventEmitter();
  let checks = 0;
  autoUpdater.checkForUpdates = async () => { checks += 1; return {}; };
  const opened = [];
  const installs = [];
  autoUpdater.quitAndInstall = (...args) => installs.push(args);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'src', 'updater.js'), 'utf8'), {
    module, setInterval: () => 1, clearInterval: () => {},
    require: (name) => (name === 'electron'
      ? { app: { isPackaged: true, getVersion: () => '2.1.6' }, shell: { openExternal: (url) => { opened.push(url); return Promise.resolve(); } } }
      : { autoUpdater }),
  });
  const updater = module.exports;
  const statuses = [];
  updater.startUpdater({ platform, onStatusChange: (s) => statuses.push(s.status) });
  return { updater, autoUpdater, opened, installs, statuses, checkCount: () => checks };
}

{
  const mac = loadUpdater('darwin');
  eq('a Mac never downloads an update it cannot install', mac.autoUpdater.autoDownload, false);
  mac.autoUpdater.emit('update-available', { version: '2.2.0' });
  eq('a newer release reads available', mac.updater.getUpdateStatus().status, 'available');
  eq('with its version', mac.updater.getUpdateStatus().availableVersion, '2.2.0');
  eq('and no progress bar', mac.updater.getUpdateStatus().progress, null);
  eq('the button opens the download page', mac.updater.installNow(), { ok: true, reason: '' });
  eq('in the browser', mac.opened, [mac.updater.MANUAL_DOWNLOAD_URL]);
  eq('which is voxden.app/download', mac.updater.MANUAL_DOWNLOAD_URL, 'https://voxden.app/download');
  eq('nothing is ever installed', mac.installs, []);
  eq('quitting installs nothing', mac.updater.installOnQuit(), false);
  mac.autoUpdater.emit('update-downloaded', { version: '2.2.0' });
  eq('even a stray download event does not install on quit', mac.updater.installOnQuit(), false);
  eq('still nothing installed', mac.installs, []);
  const idle = loadUpdater('darwin');
  eq('with nothing available the button refuses', idle.updater.installNow().ok, false);
  eq('and opens nothing', idle.opened, []);
  idle.autoUpdater.emit('error', new Error('Cannot find latest-mac.yml'));
  eq('a failed check is the ordinary error state, not a loop', idle.updater.getUpdateStatus().status, 'error');
  eq('one check at launch and none retried on error', idle.checkCount(), 1);
}

{
  const win = loadUpdater('win32');
  eq('Windows still downloads by itself', win.autoUpdater.autoDownload, true);
  win.autoUpdater.emit('update-available', { version: '2.2.0' });
  eq('Windows goes straight to downloading', win.updater.getUpdateStatus().status, 'downloading');
  win.autoUpdater.emit('update-downloaded', { version: '2.2.0' });
  eq('and restarts through the installer', win.updater.installNow(), { ok: true, reason: '' });
  eq('silently, relaunching', win.installs, [[true, true]]);
  eq('without opening a browser', win.opened, []);
}

// --- after-pack.js signs ad hoc, in order, and verifies -------------------------

function loadAfterPack(execLog, platformName) {
  const module = { exports: {} };
  const env = {};
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'build', 'after-pack.js'), 'utf8'), {
    module, __dirname: path.join(ROOT, 'build'), console: { log: () => {} },
    process: { env, platform: platformName },
    require: (name) => {
      if (name === 'child_process') return { execFileSync: (file, args) => execLog.push([file].concat(args)) };
      if (name === 'fs') return { existsSync: () => true, chmodSync: () => {} };
      return require(name);
    },
  });
  return { afterPack: module.exports, env };
}

(async () => {
  const log = [];
  const { afterPack } = loadAfterPack(log, 'darwin');
  const context = {
    electronPlatformName: 'darwin',
    appOutDir: '/out/mac-arm64',
    packager: { appInfo: { productFilename: 'Voxden' } },
  };
  await afterPack(context);
  const app = path.join('/out/mac-arm64', 'Voxden.app');
  const res = path.join(app, 'Contents', 'Resources');
  eq('the two Resources binaries are signed before the bundle', log.slice(0, 2).map((c) => c[c.length - 1]),
    [path.join(res, 'pack-tools', '7za'), path.join(res, 'helper', 'voxden-helper')]);
  const bundle = log[2];
  ok('the bundle is signed ad hoc, deep, with the hardened runtime and entitlements',
    bundle[0] === 'codesign' && bundle.includes('--deep') && bundle[bundle.indexOf('--sign') + 1] === '-'
    && bundle[bundle.indexOf('--options') + 1] === 'runtime'
    && bundle[bundle.indexOf('--entitlements') + 1].endsWith('entitlements.mac.plist') && bundle[bundle.length - 1] === app);
  eq('and then verified strictly', log[3], ['codesign', '--verify', '--deep', '--strict', '--verbose=2', app]);
  eq('four codesign calls in all', log.length, 4);

  const winLog = [];
  await loadAfterPack(winLog, 'win32').afterPack({ electronPlatformName: 'win32', appOutDir: 'x', packager: context.packager });
  eq('a Windows pack signs nothing', winLog, []);

  const idLog = [];
  const withIdentity = loadAfterPack(idLog, 'darwin');
  withIdentity.env.CSC_NAME = 'Developer ID Application: Someone';
  await withIdentity.afterPack(context);
  eq('a real identity leaves signing to electron-builder', idLog, []);

  // --- a paste that fails for want of Accessibility says so -----------------

  for (const platform of ['darwin', 'win32']) {
    const h = harness();
    try {
      const prompts = [];
      h.context.process.platform = platform;
      h.context.require('electron').systemPreferences = {
        isTrustedAccessibilityClient: (prompt) => { prompts.push(prompt); return false; },
      };
      const said = [];
      h.context.overlaySaid = said;
      h.run('sendOverlay = (extra) => { if (extra && extra.mode === "error") overlaySaid.push(extra.text); };');
      h.run("pasteDictation = async () => { throw new Error('Paste helper failed: no answer'); }; mode = 'transcribing';");
      await h.run("onTranscript('Words worth keeping')");
      eq(platform + ': the words are kept', h.run('history.entries[0].text'), 'Words worth keeping');
      if (platform === 'darwin') {
        eq('darwin: the bar names Accessibility', said, ['Allow Voxden in Accessibility to paste']);
        eq('darwin: and the system prompt is raised', prompts, [false, true]);
      } else {
        eq('win32: the bar is unchanged', said, ['Paste failed — text saved in history']);
        eq('win32: macOS is never asked', prompts, []);
      }
    } finally {
      await h.close();
    }
  }

  console.log('All ' + checks + ' mac shell checks passed');
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
