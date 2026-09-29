'use strict';

// Launches a built Voxden.app the way Finder would run it -- its own signed
// executable, not `electron .` -- and proves it came up: both windows loaded
// their pages, the main process answers the dashboard over IPC as a packaged
// macOS app, and the Swift helper is running from the bundle. The macOS
// counterpart of test-packaged-startup.js, for the real bundle. macOS only;
// anywhere else it says so and exits 0.
//
//   node scripts/smoke-mac-app.js --app dist/mac-verify/Voxden.app [--log temp/mac-smoke.log]
//
// Nothing is typed, recorded or pasted. The app runs against the runner
// account's own profile, which on a CI runner is empty.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

if (process.platform !== 'darwin') {
  console.log('skipped mac app smoke test (not macOS)');
  process.exit(0);
}

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const APP = path.resolve(ROOT, arg('app', path.join('dist', 'mac-verify', pkg.build.productName + '.app')));
const LOG = path.resolve(ROOT, arg('log', path.join('dist', 'mac-smoke.log')));
const PORT = Number(arg('port', '9339'));
const STARTUP_MS = 90000;

let failures = 0;
function check(label, cond, detail) {
  if (!cond) failures += 1;
  console.log((cond ? 'PASS  ' : 'FAIL  ') + label + (detail ? '  ' + detail : ''));
  return !!cond;
}
function note(label, detail) { console.log('INFO  ' + label + (detail ? '  ' + detail : '')); }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function run(file, args) {
  const r = spawnSync(file, args, { encoding: 'utf8' });
  return String(r.stdout || '') + String(r.stderr || '');
}

function processTable() {
  return run('ps', ['-axo', 'pid=,ppid=,command=']).split('\n').map((line) => {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    return m ? { pid: Number(m[1]), ppid: Number(m[2]), command: m[3] } : null;
  }).filter(Boolean);
}

function descendants(rootPid) {
  const table = processTable();
  const out = [];
  const queue = [rootPid];
  while (queue.length) {
    const parent = queue.shift();
    for (const p of table) {
      if (p.ppid === parent) { out.push(p); queue.push(p.pid); }
    }
  }
  return out;
}

async function targets() {
  try {
    const res = await fetch('http://127.0.0.1:' + PORT + '/json/list');
    return res.ok ? await res.json() : [];
  } catch (_) {
    return [];
  }
}

// One Runtime.evaluate over the page's DevTools socket.
function evaluate(wsUrl, expression) {
  return new Promise((resolve, reject) => {
    if (typeof WebSocket !== 'function') { reject(new Error('this Node has no WebSocket client')); return; }
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => { try { ws.close(); } catch (_) {} reject(new Error('evaluate timed out')); }, 20000);
    ws.onerror = () => { clearTimeout(timer); reject(new Error('DevTools socket error')); };
    ws.onopen = () => ws.send(JSON.stringify({
      id: 1, method: 'Runtime.evaluate',
      params: { expression, awaitPromise: true, returnByValue: true },
    }));
    ws.onmessage = (event) => {
      const msg = JSON.parse(String(event.data));
      if (msg.id !== 1) return;
      clearTimeout(timer);
      ws.close();
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else if (msg.result && msg.result.exceptionDetails) reject(new Error(JSON.stringify(msg.result.exceptionDetails).slice(0, 400)));
      else resolve(msg.result && msg.result.result ? msg.result.result.value : undefined);
    };
  });
}

async function main() {
  if (!check('app bundle exists', fs.existsSync(APP), APP)) return;
  const exeName = run('plutil', ['-extract', 'CFBundleExecutable', 'raw', '-o', '-', path.join(APP, 'Contents', 'Info.plist')]).trim();
  const exe = path.join(APP, 'Contents', 'MacOS', exeName || pkg.build.productName);
  check('executable exists', fs.existsSync(exe), path.relative(APP, exe));
  const userData = path.join(os.homedir(), 'Library', 'Application Support', pkg.build.productName);
  note('profile', userData + (fs.existsSync(userData) ? ' (already existed)' : ' (fresh)'));

  fs.mkdirSync(path.dirname(LOG), { recursive: true });
  const log = fs.openSync(LOG, 'w');
  const started = Date.now();
  const child = spawn(exe, ['--remote-debugging-port=' + PORT, '--enable-logging'], {
    env: Object.assign({}, process.env, { ELECTRON_ENABLE_LOGGING: '1' }),
    stdio: ['ignore', log, log],
  });
  let exited = null;
  child.on('exit', (code, signal) => { exited = { code, signal, at: Date.now() - started }; });
  note('launched', exe + ' pid ' + child.pid);

  let pages = [];
  while (Date.now() - started < STARTUP_MS && !exited) {
    pages = (await targets()).filter((t) => t.type === 'page');
    const urls = pages.map((t) => t.url);
    if (urls.some((u) => u.endsWith('/src/app.html')) && urls.some((u) => u.endsWith('/src/overlay.html'))) break;
    await sleep(1000);
  }
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  check('the app is still running after startup', !exited, exited ? JSON.stringify(exited) : secs + ' s');
  const dashboard = pages.find((t) => t.url.endsWith('/src/app.html'));
  const overlay = pages.find((t) => t.url.endsWith('/src/overlay.html'));
  check('the dashboard page loaded from the bundle', !!dashboard && dashboard.url.includes('/Contents/Resources/app.asar/'), dashboard ? dashboard.url : pages.map((t) => t.url).join(', '));
  check('the flow bar page loaded from the bundle', !!overlay && overlay.url.includes('/Contents/Resources/app.asar/'), overlay ? overlay.url : '');

  if (dashboard && !exited) {
    // The first snapshot sets the platform attribute; give the page a moment.
    await sleep(3000);
    try {
      const state = await evaluate(dashboard.webSocketDebuggerUrl, `window.voxden.loadApp().then((s) => ({
        version: s.version, platform: s.platform, packaged: s.packaged, updateStatus: s.status,
        availableEngines: s.availableEngines, engineStatus: s.engineStatus, shortcut: s.shortcut,
        shortcutLabel: s.shortcutLabel, runtimeBundled: !!(s.asrRuntime && s.asrRuntime.bundled),
        runtimeInstalled: !!(s.asrRuntime && s.asrRuntime.installed),
        htmlPlatform: document.documentElement.dataset.platform || '',
        titlebarPadding: getComputedStyle(document.querySelector('.titlebar')).paddingLeft,
        taskbarRowShown: getComputedStyle(document.getElementById('set-taskbar').closest('.setting-row')).display !== 'none',
      }))`);
      console.log('      ' + JSON.stringify(state));
      check('main answers the dashboard over IPC', !!state);
      check('it reports version ' + pkg.version, state && state.version === pkg.version, state && state.version);
      check('it runs as a packaged app', state && state.packaged === true);
      check('it knows it is on macOS', state && state.platform === 'darwin', state && state.platform);
      check('the default shortcut is Cmd+Shift+Space', state && state.shortcutLabel === 'Cmd+Shift+Space', state && state.shortcutLabel);
      check('no Windows-only engine is offered', state && Array.isArray(state.availableEngines) && !state.availableEngines.includes('qwen3-asr'),
        state && JSON.stringify(state.availableEngines));
      check('the speech engine ships inside the app', state && state.runtimeBundled === true);
      check('the Mac title bar makes room for the traffic lights', state && state.htmlPlatform === 'darwin' && state.titlebarPadding === '84px',
        state && state.htmlPlatform + ' ' + state.titlebarPadding);
      check('the Dock switch is hidden', state && state.taskbarRowShown === false);
      note('update check on launch', state && state.updateStatus);
    } catch (err) {
      check('main answers the dashboard over IPC', false, err.message);
    }
  }

  const kids = descendants(child.pid);
  const helper = kids.filter((p) => p.command.includes('/Contents/Resources/helper/voxden-helper'));
  for (const p of kids) note('child', p.pid + ' ' + p.command.replace(APP, '<app>').slice(0, 160));
  check('the Swift helper serves from the bundle', helper.some((p) => /-Action serve/.test(p.command)));
  check('a renderer process runs', kids.some((p) => /Helper \(Renderer\)/.test(p.command)));

  // Whether the app has a Dock icon: Foreground has one, UIElement does not.
  // The dashboard hides its Dock switch and steals focus on that assumption
  // (src/mac-shell.js bringForward), so a change here has to be noticed.
  const asn = run('lsappinfo', ['find', 'bundleid=' + pkg.build.appId]).trim().split(/\s+/)[0] || '';
  const appType = asn ? run('lsappinfo', ['info', '-only', 'ApplicationType', asn]).trim() : 'lsappinfo found no ASN';
  check('it runs as a menu-bar app with no Dock icon', /"UIElement"/.test(appType), appType);

  const data = path.join(userData, 'data');
  note('profile data', fs.existsSync(data) ? fs.readdirSync(data).join(', ') : 'none');

  // A quit the way a Mac asks for one. Electron quits on SIGTERM through its
  // normal path, so will-quit gets to stop the helpers.
  if (!exited) {
    child.kill('SIGTERM');
    for (let i = 0; i < 150 && !exited; i += 1) await sleep(100);
    if (!exited) { note('did not exit within 15 s of SIGTERM; killing'); child.kill('SIGKILL'); await sleep(500); }
    note('exit', JSON.stringify(exited));
    await sleep(1000);
    const orphans = processTable().filter((p) => p.command.includes(APP));
    check('nothing from the bundle outlives the app', orphans.length === 0, orphans.map((p) => p.pid + ' ' + p.command.replace(APP, '<app>')).join(' ; '));
  }

  fs.closeSync(log);
  const text = fs.readFileSync(LOG, 'utf8');
  const uncaught = text.split('\n').filter((l) => /Uncaught|FATAL|Check failed/.test(l));
  check('no uncaught renderer errors or fatal checks in the log', uncaught.length === 0, uncaught.slice(0, 5).join(' | '));
  console.log('\n--- last 60 lines of ' + path.relative(ROOT, LOG));
  for (const line of text.trim().split('\n').slice(-60)) console.log('    ' + line);
}

main().catch((err) => check('smoke test crashed', false, err && err.stack || String(err))).finally(() => {
  console.log('\n' + (failures ? failures + ' check(s) failed' : 'the packaged mac app starts normally'));
  process.exit(failures ? 1 : 0);
});
