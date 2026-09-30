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

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const APP = path.resolve(ROOT, arg('app', path.join('dist', 'mac-verify', pkg.build.productName + '.app')));
const LOG = path.resolve(ROOT, arg('log', path.join('dist', 'mac-smoke.log')));
const PORT = Number(arg('port', '9339'));
const STARTUP_MS = 90000;
const TOTAL_MS = 180000;
let activePhase = 'initialization';
let ownedChild = null;
let logDescriptor = null;
let lastDiscoveryError = '';
let samplesCaptured = false;

let failures = 0;
function check(label, cond, detail) {
  if (!cond) failures += 1;
  console.log((cond ? 'PASS  ' : 'FAIL  ') + label + (detail ? '  ' + detail : ''));
  return !!cond;
}
function note(label, detail) { console.log('INFO  ' + label + (detail ? '  ' + detail : '')); }
function phase(label) { activePhase = label; note('phase', label); }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function run(file, args, timeoutMs = 5000) {
  const r = spawnSync(file, args, { encoding: 'utf8', timeout: timeoutMs, killSignal: 'SIGKILL', windowsHide: true });
  if (r.error) throw new Error(file + ' ' + args.join(' ') + ': '
    + (r.error.code === 'ETIMEDOUT' ? 'timed out after ' + timeoutMs + ' ms' : r.error.message));
  if (r.status !== 0) throw new Error(file + ' ' + args.join(' ') + ' exited '
    + r.status + ': ' + String(r.stderr || r.stdout || '').trim());
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

async function fetchTargets(port, timeoutMs = 3000) {
  const url = 'http://127.0.0.1:' + port + '/json/list';
  try {
    // The signal also bounds reading the response body, not just its headers.
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const result = await res.json();
    if (!Array.isArray(result)) throw new Error('DevTools returned a non-array target list');
    return result;
  } catch (err) {
    throw new Error('DevTools discovery ' + url + ' failed within ' + timeoutMs + ' ms: ' + err.message);
  }
}

async function targets() {
  try {
    const result = await fetchTargets(PORT);
    lastDiscoveryError = '';
    return result;
  } catch (err) {
    if (lastDiscoveryError !== err.message) note('waiting for DevTools', err.message);
    lastDiscoveryError = err.message;
    return [];
  }
}

// One Runtime.evaluate over the page's DevTools socket.
function evaluate(wsUrl, expression) {
  return new Promise((resolve, reject) => {
    if (typeof WebSocket !== 'function') { reject(new Error('this Node has no WebSocket client')); return; }
    const ws = new WebSocket(wsUrl);
    let settled = false;
    function finish(error, result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch (_) { /* already closed */ }
      if (error) reject(error); else resolve(result);
    }
    const timer = setTimeout(() => finish(new Error('DevTools Runtime.evaluate timed out after 20000 ms')), 20000);
    ws.onerror = () => finish(new Error('DevTools socket error'));
    ws.onclose = () => finish(new Error('DevTools socket closed before Runtime.evaluate completed'));
    ws.onopen = () => {
      try {
        ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate',
          params: { expression, awaitPromise: true, returnByValue: true } }));
      } catch (err) { finish(err); }
    };
    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(String(event.data));
        if (msg.id !== 1) return;
        if (msg.error) finish(new Error(JSON.stringify(msg.error)));
        else if (msg.result && msg.result.exceptionDetails) finish(new Error(JSON.stringify(msg.result.exceptionDetails).slice(0, 400)));
        else finish(null, msg.result && msg.result.result ? msg.result.result.value : undefined);
      } catch (err) { finish(new Error('Invalid DevTools reply: ' + err.message)); }
    };
  });
}

function cleanupOwnedApp() {
  // detached:true creates a separate process group on macOS. Only this test's
  // app and children receive the signal, even if main exited before its helper.
  if (ownedChild && ownedChild.pid) {
    try { process.kill(-ownedChild.pid, 'SIGKILL'); } catch (err) {
      if (err.code !== 'ESRCH') note('owned process-group cleanup', err.message);
    }
    ownedChild = null;
  }
  if (logDescriptor !== null) {
    fs.closeSync(logDescriptor);
    logDescriptor = null;
  }
}

function captureFailureSamples(reason) {
  if (samplesCaptured || !ownedChild || !ownedChild.pid || ownedChild.exitCode !== null || ownedChild.signalCode !== null) return;
  samplesCaptured = true;
  note('failure-only native diagnostics', reason + '; the default startup failure remains a failure');
  const processes = [{ pid: ownedChild.pid, role: 'main' }];
  try {
    const kids = descendants(ownedChild.pid);
    fs.writeFileSync(LOG + '.processes.json', JSON.stringify({ reason, mainPid: ownedChild.pid, children: kids }, null, 2) + '\n');
    // Sample at most one owned GPU child: bounded evidence of the main/GPU
    // wait, without probing unrelated applications or adding an unbounded loop.
    const gpu = kids.find(p => /--type=gpu-process(?:\s|$)/.test(p.command));
    if (gpu) processes.push({ pid: gpu.pid, role: 'gpu' });
  } catch (err) { note('process diagnostics unavailable', err.message); }
  for (const target of processes) {
    const output = LOG + '.' + target.role + '-' + target.pid + '.sample.txt';
    phase('failure-only sample of owned ' + target.role + ' pid ' + target.pid + ' (8 s command bound)');
    try {
      // Native stacks reveal pre-ready AppKit, security/signature, or GPU waits
      // that neither a DevTools page nor renderer logging can expose.
      const result = run('sample', [String(target.pid), '3', '1', '-file', output], 8000);
      note('native sample saved', output + (result.trim() ? ' ; ' + result.trim().slice(0, 300) : ''));
      if (!fs.existsSync(output)) note('native sample missing', 'sample exited without creating ' + output);
    } catch (err) {
      note('native sample unavailable', err.message);
      if (!fs.existsSync(output)) fs.writeFileSync(output, 'Native sample failed: ' + err.message + '\n');
    }
  }
}

async function main() {
  phase('inspect app bundle');
  if (!check('app bundle exists', fs.existsSync(APP), APP)) return;
  const exeName = run('plutil', ['-extract', 'CFBundleExecutable', 'raw', '-o', '-', path.join(APP, 'Contents', 'Info.plist')]).trim();
  const exe = path.join(APP, 'Contents', 'MacOS', exeName || pkg.build.productName);
  check('executable exists', fs.existsSync(exe), path.relative(APP, exe));
  const userData = path.join(os.homedir(), 'Library', 'Application Support', pkg.build.productName);
  note('profile', userData + (fs.existsSync(userData) ? ' (already existed)' : ' (fresh)'));

  fs.mkdirSync(path.dirname(LOG), { recursive: true });
  logDescriptor = fs.openSync(LOG, 'w');
  const started = Date.now();
  phase('launch signed app and discover dashboard/overlay (90 s startup bound)');
  const child = spawn(exe, ['--remote-debugging-port=' + PORT, '--enable-logging'], {
    env: Object.assign({}, process.env, { ELECTRON_ENABLE_LOGGING: '1' }),
    detached: true,
    stdio: ['ignore', logDescriptor, logDescriptor],
  });
  ownedChild = child;
  let exited = null;
  child.on('error', err => { exited = { error: err.message, at: Date.now() - started }; });
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
  if (lastDiscoveryError) note('last DevTools discovery error', lastDiscoveryError);
  check('the app is still running after startup', !exited, exited ? JSON.stringify(exited) : secs + ' s');
  const dashboard = pages.find((t) => t.url.endsWith('/src/app.html'));
  const overlay = pages.find((t) => t.url.endsWith('/src/overlay.html'));
  check('the dashboard page loaded from the bundle', !!dashboard && dashboard.url.includes('/Contents/Resources/app.asar/'), dashboard ? dashboard.url : pages.map((t) => t.url).join(', '));
  check('the flow bar page loaded from the bundle', !!overlay && overlay.url.includes('/Contents/Resources/app.asar/'), overlay ? overlay.url : '');
  if ((!dashboard || !overlay) && !exited) captureFailureSamples('Packaged dashboard or overlay did not become available within the startup bound');

  if (dashboard && !exited) {
    phase('verify packaged dashboard IPC (20 s evaluation bound)');
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
      captureFailureSamples('Packaged dashboard IPC failed: ' + err.message);
    }
  }

  phase('inspect bundled helper and renderer processes (5 s native-call bound)');
  const kids = descendants(child.pid);
  const helper = kids.filter((p) => p.command.includes('/Contents/Resources/helper/voxden-helper'));
  for (const p of kids) note('child', p.pid + ' ' + p.command.replace(APP, '<app>').slice(0, 160));
  check('the Swift helper serves from the bundle', helper.some((p) => /-Action serve/.test(p.command)));
  check('a renderer process runs', kids.some((p) => /Helper \(Renderer\)/.test(p.command)));

  // Whether the app has a Dock icon: Foreground has one, UIElement does not.
  // The dashboard hides its Dock switch and steals focus on that assumption
  // (src/mac-shell.js bringForward), so a change here has to be noticed.
  phase('inspect macOS application type (5 s per lsappinfo call)');
  const asn = run('lsappinfo', ['find', 'bundleid=' + pkg.build.appId]).trim().split(/\s+/)[0] || '';
  const appType = asn ? run('lsappinfo', ['info', '-only', 'ApplicationType', asn]).trim() : 'lsappinfo found no ASN';
  check('it runs as a menu-bar app with no Dock icon', /"UIElement"/.test(appType), appType);

  const data = path.join(userData, 'data');
  note('profile data', fs.existsSync(data) ? fs.readdirSync(data).join(', ') : 'none');

  // A quit the way a Mac asks for one. Electron quits on SIGTERM through its
  // normal path, so will-quit gets to stop the helpers.
  if (!exited) {
    phase('quit owned app and check for orphaned bundle processes (15 s quit bound)');
    child.kill('SIGTERM');
    for (let i = 0; i < 150 && !exited; i += 1) await sleep(100);
    if (!exited) { note('did not exit within 15 s of SIGTERM; killing'); child.kill('SIGKILL'); await sleep(500); }
    note('exit', JSON.stringify(exited));
    await sleep(1000);
    const orphans = processTable().filter((p) => p.command.includes(APP));
    check('nothing from the bundle outlives the app', orphans.length === 0, orphans.map((p) => p.pid + ' ' + p.command.replace(APP, '<app>')).join(' ; '));
  }

  fs.closeSync(logDescriptor);
  logDescriptor = null;
  phase('inspect app log');
  const text = fs.readFileSync(LOG, 'utf8');
  const uncaught = text.split('\n').filter((l) => /Uncaught|FATAL|Check failed/.test(l));
  check('no uncaught renderer errors or fatal checks in the log', uncaught.length === 0, uncaught.slice(0, 5).join(' | '));
  console.log('\n--- last 60 lines of ' + path.relative(ROOT, LOG));
  for (const line of text.trim().split('\n').slice(-60)) console.log('    ' + line);
}

module.exports = { run, fetchTargets };

if (require.main === module) {
  if (process.platform !== 'darwin') {
    console.log('skipped mac app smoke test (not macOS)');
  } else {
    const deadline = setTimeout(() => {
      check('total smoke-test deadline', false, TOTAL_MS + ' ms exceeded during: ' + activePhase + '; app log: ' + LOG);
      cleanupOwnedApp();
      process.exit(1);
    }, TOTAL_MS);
    main().catch((err) => {
      check('smoke test crashed during ' + activePhase, false, err && err.stack || String(err));
      captureFailureSamples('Smoke wrapper failed: ' + err.message);
    }).finally(() => {
      clearTimeout(deadline);
      cleanupOwnedApp();
      console.log('\n' + (failures ? failures + ' check(s) failed' : 'the packaged mac app starts normally'));
      process.exit(failures ? 1 : 0);
    });
  }
}
