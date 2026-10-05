'use strict';

// Apps run as administrator, and Voxden restarting as one. While such an app is
// in front, Windows keeps an ordinary Voxden's shortcuts and keys away from it
// (measured 2026-10-02); the foreground watcher marks it " admin", the bell
// says why once per app, and Settings > System can restart Voxden elevated.
//
// main.js runs in the harness, with the helper, PowerShell and app.quit played
// by stubs: nothing is elevated, launched or quit for real. src/elevation.js
// is tested directly, and on Windows its quoting and its PowerShell script are
// run for real -- with the runas verb taken out, so no prompt ever appears.
// win32.ps1's own side is in test-win32.js and test-paste-keys-win32.ps1.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const mainHarness = require('./asr-test-harness');
const elevation = require('../src/elevation');

const tick = () => new Promise(resolve => setImmediate(resolve));
// The watcher's mark for a window filling a 1920x1080 screen (win32.ps1).
const FULL = ' fullscreen 0,0,1920,1080';
// Replies built inside the harness belong to its own realm.
const plain = value => JSON.parse(JSON.stringify(value));
const say = (proc, ...lines) => proc.stdout.emit('data', lines.join('\n') + '\n');

let checks = 0;
async function test(name, fn) {
  await fn();
  checks++;
  console.log('ok', name);
}

async function inMain(fn) {
  const h = mainHarness();
  try {
    await fn(h);
  } finally {
    await h.close();
  }
}

// The foreground watcher main started, and every app looked up behind it.
function watchForeground(h, exes) {
  h.context.exes = exes || {};
  h.run(`
    var lookups = [];
    winInfo = async (hwnd) => { lookups.push(hwnd); return { hwnd, exe: exes[hwnd] || '', title: 'Some title' }; };
    sendOverlay = () => {}; showOverlay = () => {};
    launchForegroundWatch();
  `);
  return h.launches.filter(l => Array.isArray(l.args[1]) && l.args[1].includes('foreground-watch')).at(-1).proc;
}

const adminNotes = h => JSON.parse(h.run(`JSON.stringify(Object.keys(notifications.items)
  .filter(id => id.startsWith('admin-app:')).map(id => Object.assign({ id }, notifications.items[id].inline)))`));

// The PowerShell launch main made for a restart, and the script it carries.
function restartLaunch(h) {
  const launch = h.launches.filter(l => l.args[0] === 'powershell.exe' && Array.isArray(l.args[1])
    && l.args[1].includes('-EncodedCommand')).at(-1);
  assert.ok(launch, 'a PowerShell was asked to start Voxden elevated');
  const args = launch.args[1];
  const script = Buffer.from(args[args.indexOf('-EncodedCommand') + 1], 'base64').toString('utf16le');
  return { launch, script };
}

// The fields the script hands Windows, read back out of its literals.
function scriptFields(script) {
  const field = name => {
    const m = new RegExp('^\\$psi\\.' + name + " = '((?:[^']|'')*)'$", 'm').exec(script);
    return m ? m[1].replace(/''/g, "'") : null;
  };
  return { file: field('FileName'), args: field('Arguments'), cwd: field('WorkingDirectory'), verb: field('Verb') };
}

function prepareRestart(h, { packaged, execPath, argv, appPath }) {
  h.context.restart = { packaged, execPath, argv, appPath };
  h.run(`
    var quits = 0;
    app.quit = () => { quits++; };
    app.isPackaged = restart.packaged;
    app.getAppPath = () => restart.appPath;
    process.execPath = restart.execPath;
    process.argv = restart.argv;
    process.pid = 4321;
  `);
}
const quitTimers = h => Array.from(h.timers.values()).filter(t => /app\.quit\(\)/.test(String(t.fn)));

async function mainTests() {
  await test('an app run as administrator filling its screen: one note per app, each window looked up once', () => inMain(async (h) => {
    h.run('runningAsAdmin = false');
    const watch = watchForeground(h, { 501: 'Game.exe', 503: 'Game.exe', 504: 'Tool.exe', 505: 'Terminal.exe' });
    say(watch, '500', '501' + FULL + ' admin', '502', '501' + FULL + ' admin', '503' + FULL + ' admin');
    assert.strictEqual(h.run('foregroundFullscreen'), true, 'a fullscreen admin window is fullscreen too');
    say(watch, '504' + FULL + ' admin', '505 admin');
    await tick(); await tick();
    assert.deepStrictEqual(JSON.parse(h.run('JSON.stringify(lookups)')), ['501', '503', '504'],
      'a window is looked up the first time it is marked, and only one that fills its screen: any other '
      + 'admin app (a terminal, an installer) gets a note only when a paste into it is refused');
    assert.deepStrictEqual(adminNotes(h), [
      { id: 'admin-app:game.exe', kind: 'paste', title: 'Game.exe runs as administrator',
        body: 'Windows does not let Voxden hear its shortcuts or type into it while it is in front, '
          + 'so a dictation into it waits on the clipboard for your Ctrl+V. '
          + 'To dictate into it as usual, open Settings, System, and choose Restart as administrator.',
        action: { settings: 'system' } },
      { id: 'admin-app:tool.exe', kind: 'paste', title: 'Tool.exe runs as administrator',
        body: 'Windows does not let Voxden hear its shortcuts or type into it while it is in front, '
          + 'so a dictation into it waits on the clipboard for your Ctrl+V. '
          + 'To dictate into it as usual, open Settings, System, and choose Restart as administrator.',
        action: { settings: 'system' } },
    ]);
    // The note is the one a refused paste raises: that app gets no second one.
    h.run("noteAdminApp('game.exe')");
    assert.strictEqual(adminNotes(h).length, 2);
    // A cleared note stays cleared.
    h.run("notifications = announcements.clearOne(notifications, 'admin-app:tool.exe').state; adminWindowsNoted.clear()");
    say(watch, '504' + FULL + ' admin');
    await tick(); await tick();
    assert.strictEqual(adminNotes(h).filter(n => n.id === 'admin-app:tool.exe').length, 1);
    assert.strictEqual(h.run("notifications.items['admin-app:tool.exe'].cleared"), true, 'and is not brought back');
  }));

  await test('the notes 2.1.7 left are dropped once, so the new rules can bring a real one back', () => inMain(async (h) => {
    h.run(`
      notifications = announcements.note(notifications, { id: 'admin-app:taskmgr.exe', kind: 'paste',
        title: 'Taskmgr.exe runs as administrator', body: 'Windows does not let Voxden hear its shortcuts.' }).state;
      notifications = announcements.note(notifications, { id: 'kept-note', kind: 'paste',
        title: 'Something else', body: 'Unrelated.' }).state;
      settings.adminAppNotesReset = undefined;
      dropOldAdminAppNotes();
    `);
    assert.deepStrictEqual(adminNotes(h), []);
    assert.strictEqual(h.run("!!notifications.items['kept-note']"), true, 'other notes stay');
    assert.strictEqual(h.run('settings.adminAppNotesReset'), true);
    h.run("noteAdminApp('Taskmgr.exe')");
    assert.strictEqual(adminNotes(h).length, 1, 'removed, not cleared: a refused paste can still raise it');
    h.run("notifications = announcements.clearOne(notifications, 'admin-app:taskmgr.exe').state; dropOldAdminAppNotes()");
    assert.strictEqual(h.run("notifications.items['admin-app:taskmgr.exe'].cleared"), true,
      'only once: a note the user cleared afterwards stays cleared');
  }));

  await test('Voxden running as administrator adds no admin note and looks nothing up', () => inMain(async (h) => {
    h.run('runningAsAdmin = true');
    const watch = watchForeground(h, { 501: 'Game.exe' });
    say(watch, '501' + FULL + ' admin');
    await tick(); await tick();
    h.run("noteAdminApp('winword.exe')");
    assert.deepStrictEqual(JSON.parse(h.run('JSON.stringify(lookups)')), []);
    assert.deepStrictEqual(adminNotes(h), []);
  }));

  for (const [answer, notes] of [['1', 0], ['0', 1]]) {
    await test('a mark before the helper says whether Voxden is elevated waits for it: ' + answer + ' gives ' + notes + ' note', () => inMain(async (h) => {
      h.run(`
        var helperCalls = []; var answerElevated;
        ps = (args) => { helperCalls.push(args.slice()); return new Promise(resolve => { answerElevated = resolve; }); };
        broadcast = () => {};
        checkElevation();
      `);
      assert.deepStrictEqual(JSON.parse(h.run('JSON.stringify(helperCalls)')), [['elevated']]);
      const watch = watchForeground(h, { 501: 'Game.exe' });
      say(watch, '501' + FULL + ' admin');
      await tick();
      assert.deepStrictEqual(JSON.parse(h.run('JSON.stringify(lookups)')), [], 'nothing before the answer');
      h.run(`answerElevated(${JSON.stringify(answer)})`);
      for (let i = 0; i < 5; i++) await tick();
      assert.strictEqual(h.run('runningAsAdmin'), answer === '1');
      assert.strictEqual(adminNotes(h).length, notes);
    }));
  }

  await test('the settings snapshot says whether Voxden runs as administrator', () => inMain(async (h) => {
    h.run(`ps = async (args) => args[0] === 'elevated' ? '1' : ''; broadcast = () => {};`);
    assert.strictEqual(h.run('snapshot().runningAsAdmin'), false, 'false before the helper has answered');
    await h.run('checkElevation()');
    assert.strictEqual(h.run('snapshot().runningAsAdmin'), true);
    h.run(`ps = async () => '';`);
    h.run('runningAsAdmin = null');
    await h.run('checkElevation()');
    assert.strictEqual(h.run('runningAsAdmin'), null, 'a helper that cannot tell leaves it unknown');
    assert.strictEqual(h.run('snapshot().runningAsAdmin'), false);
  }));

  await test('restart as administrator, packaged: the same exe and arguments, elevated, then this copy quits', () => inMain(async (h) => {
    prepareRestart(h, {
      packaged: true,
      execPath: "C:\\Users\\O'Brien Smith\\AppData\\Local\\Programs\\Voxden\\Voxden.exe",
      argv: ["C:\\Users\\O'Brien Smith\\AppData\\Local\\Programs\\Voxden\\Voxden.exe", '--hidden', '--voxden-after-pid=77', '--trace=a b'],
      appPath: "C:\\Users\\O'Brien Smith\\AppData\\Local\\Programs\\Voxden\\resources\\app.asar",
    });
    const reply = h.handlers.get('restart-as-admin')();
    await tick();
    const { launch, script } = restartLaunch(h);
    assert.deepStrictEqual(scriptFields(script), {
      file: "C:\\Users\\O'Brien Smith\\AppData\\Local\\Programs\\Voxden\\Voxden.exe",
      args: '"--trace=a b" --voxden-after-pid=4321',
      cwd: "C:\\Users\\O'Brien Smith\\AppData\\Local\\Programs\\Voxden",
      verb: 'runas',
    });
    assert.strictEqual(launch.args[2].windowsHide, true);
    assert.strictEqual(quitTimers(h).length, 0, 'nothing quits while Windows is asking');
    launch.callback(null, 'VOXDEN_OK\r\n', '');
    assert.deepStrictEqual(plain(await reply), { ok: true });
    assert.strictEqual(h.run('quits'), 0, 'the reply goes back before the quit');
    quitTimers(h).forEach(t => t.fn());
    assert.strictEqual(h.run('quits'), 1, 'then this copy quits the normal way');
    assert.strictEqual(h.run('restartingAsAdmin'), true, 'and the update installer stays out of it');
    assert.match((await h.handlers.get('restart-as-admin')()).reason, /already restarting/);
  }));

  await test('restart as administrator, in development: Electron with the app folder, run from that folder', () => inMain(async (h) => {
    prepareRestart(h, {
      packaged: false,
      execPath: 'C:\\dev\\speakbar\\node_modules\\electron\\dist\\electron.exe',
      argv: ['C:\\dev\\speakbar\\node_modules\\electron\\dist\\electron.exe', '.'],
      appPath: 'C:\\dev\\my projects\\speakbar',
    });
    const reply = h.handlers.get('restart-as-admin')();
    await tick();
    const { launch, script } = restartLaunch(h);
    assert.deepStrictEqual(scriptFields(script), {
      file: 'C:\\dev\\speakbar\\node_modules\\electron\\dist\\electron.exe',
      args: '"C:\\dev\\my projects\\speakbar" --voxden-after-pid=4321',
      cwd: 'C:\\dev\\my projects\\speakbar',
      verb: 'runas',
    });
    launch.callback(null, 'VOXDEN_OK\n', '');
    assert.deepStrictEqual(plain(await reply), { ok: true });
  }));

  for (const [name, stdout, error, reason, warned] of [
    ['a no at the Windows prompt', 'VOXDEN_CANCELLED\r\n', null, elevation.CANCELLED, []],
    ['Windows refusing', 'VOXDEN_FAILED The system cannot find the file specified\r\n', null, elevation.FAILED,
      ['Restart as administrator failed: The system cannot find the file specified']],
    ['a PowerShell that never answered', '', Object.assign(new Error('killed'), { killed: true }), elevation.FAILED, []],
  ]) {
    await test('restart as administrator after ' + name + ': this copy stays and says why, and can try again', () => inMain(async (h) => {
      prepareRestart(h, { packaged: true, execPath: 'C:\\Voxden\\Voxden.exe', argv: ['C:\\Voxden\\Voxden.exe'], appPath: 'C:\\Voxden\\resources\\app.asar' });
      h.run('var warned = []; console = Object.assign({}, console, { warn: (...a) => warned.push(a.join(" ")) });');
      const reply = h.handlers.get('restart-as-admin')();
      await tick();
      restartLaunch(h).launch.callback(error, stdout, '');
      assert.deepStrictEqual(plain(await reply), { ok: false, reason });
      assert.deepStrictEqual(JSON.parse(h.run('JSON.stringify(warned)')), warned, 'Windows\u2019 own reason goes to the log');
      assert.strictEqual(quitTimers(h).length, 0);
      assert.strictEqual(h.run('quits'), 0);
      assert.strictEqual(h.run('restartingAsAdmin'), false);
      const again = h.handlers.get('restart-as-admin')();
      await tick();
      assert.strictEqual(h.launches.filter(l => l.args[0] === 'powershell.exe').length, 2, 'a second try asks Windows again');
      restartLaunch(h).launch.callback(null, 'VOXDEN_OK\n', '');
      assert.deepStrictEqual(plain(await again), { ok: true });
    }));
  }

  await test('restart as administrator is not offered twice, or anywhere but Windows', () => inMain(async (h) => {
    prepareRestart(h, { packaged: true, execPath: 'C:\\Voxden\\Voxden.exe', argv: ['C:\\Voxden\\Voxden.exe'], appPath: 'C:\\Voxden\\resources\\app.asar' });
    h.run('runningAsAdmin = true');
    assert.match((await h.handlers.get('restart-as-admin')()).reason, /already running as administrator/);
    h.run("runningAsAdmin = false; process.platform = 'darwin'");
    assert.deepStrictEqual(plain(await h.handlers.get('restart-as-admin')()), { ok: false, reason: 'Only Windows runs apps as administrator.' });
    assert.strictEqual(h.launches.filter(l => l.args[0] === 'powershell.exe').length, 0, 'nothing was started');
  }));

  await test('the restarted copy waits for the old one before it takes the single-instance lock', async () => {
    const src = fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8');
    const wait = src.indexOf('elevation.waitForExit(afterPid');
    const lock = src.indexOf('app.requestSingleInstanceLock()');
    assert.ok(wait > 0 && lock > wait, 'waitForExit runs before requestSingleInstanceLock');
    assert.ok(/const afterPid = elevation\.afterPid\(process\.argv\);/.test(src));
  });
}

// --- src/elevation.js -------------------------------------------------------

function run(file, args, options) {
  const result = spawnSync(file, args, Object.assign({ encoding: 'utf8', windowsHide: true, timeout: 30000 }, options));
  assert.strictEqual(result.status, 0, String(result.stderr || result.error));
  return result.stdout;
}
const powershell = script => run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', elevation.encodeCommand(script)]);

// What a program that reads its Windows command line the standard way makes of
// `line`. Verbatim, so Node adds no quoting of its own; argv0 is plain so the
// exe's own path, spaces and all, is not part of what is being tested.
function parsedBack(line) {
  return JSON.parse(run(process.execPath, ['-e', '"process.stdout.write(JSON.stringify(process.argv.slice(1)))"', line], {
    argv0: 'node', windowsVerbatimArguments: true,
  }));
}

async function unitTests() {
  await test('the flag a restarted copy gets is read back, and nothing else counts', async () => {
    assert.strictEqual(elevation.afterPid(['Voxden.exe', '--voxden-after-pid=1234']), 1234);
    assert.strictEqual(elevation.afterPid(['Voxden.exe', '--hidden']), 0);
    assert.strictEqual(elevation.afterPid(['Voxden.exe', '--voxden-after-pid=']), 0);
    assert.strictEqual(elevation.afterPid(['Voxden.exe', '--voxden-after-pid=12x']), 0);
    assert.strictEqual(elevation.afterPid(['Voxden.exe', '--voxden-after-pid=-5']), 0);
    assert.strictEqual(elevation.afterPid(undefined), 0);
  });

  await test('the wait for the old copy ends when it exits, or after the timeout', async () => {
    const play = (aliveFor) => {
      const seen = { asks: 0, slept: 0 };
      const done = elevation.waitForExit(99, {
        isAlive: (pid) => { assert.strictEqual(pid, 99); seen.asks++; return seen.asks <= aliveFor; },
        sleep: (ms) => { seen.slept += ms; },
        timeoutMs: 1000, stepMs: 100,
      });
      return Object.assign(seen, { done });
    };
    assert.deepStrictEqual(play(0), { asks: 1, slept: 0, done: true }, 'already gone: no wait at all');
    assert.deepStrictEqual(play(3), { asks: 4, slept: 300, done: true });
    assert.deepStrictEqual(play(Infinity), { asks: 11, slept: 1000, done: false }, 'still there after 1000 ms: give up');
  });

  await test('a process is alive until it exits; the blocking sleep blocks', async () => {
    assert.strictEqual(elevation.processAlive(process.pid), true);
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { windowsHide: true });
    await new Promise(resolve => child.once('spawn', resolve));
    assert.strictEqual(elevation.processAlive(child.pid), true);
    child.kill();
    await new Promise(resolve => child.once('exit', resolve));
    let gone = false;
    for (let i = 0; i < 50 && !gone; i++) {
      gone = !elevation.processAlive(child.pid);
      if (!gone) await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.ok(gone, 'an exited process is not alive');
    const started = Date.now();
    elevation.sleepSync(60);
    assert.ok(Date.now() - started >= 50, 'sleepSync waited');
  });

  await test('the restart command keeps the arguments, minus --hidden and an old wait', async () => {
    assert.deepStrictEqual(elevation.restartCommand({
      packaged: true, execPath: 'C:\\Voxden\\Voxden.exe', appPath: 'C:\\Voxden\\resources\\app.asar', pid: 7,
      argv: ['C:\\Voxden\\Voxden.exe', '--hidden', '--voxden-after-pid=3', '--x'],
    }), { file: 'C:\\Voxden\\Voxden.exe', args: ['--x', '--voxden-after-pid=7'], cwd: 'C:\\Voxden' });
    assert.deepStrictEqual(elevation.restartCommand({
      packaged: false, execPath: 'C:\\e\\electron.exe', appPath: 'C:\\dev\\speakbar', pid: 8,
      argv: ['C:\\e\\electron.exe', '.', '--y'],
    }), { file: 'C:\\e\\electron.exe', args: ['C:\\dev\\speakbar', '--y', '--voxden-after-pid=8'], cwd: 'C:\\dev\\speakbar' });
  });

  await test('what the script printed becomes the reply', async () => {
    assert.deepStrictEqual(elevation.startResult('VOXDEN_OK\r\n'), { ok: true });
    assert.deepStrictEqual(elevation.startResult('noise\nVOXDEN_CANCELLED\n'), { ok: false, reason: elevation.CANCELLED });
    assert.deepStrictEqual(elevation.startResult('VOXDEN_FAILED Access is denied'), { ok: false, reason: elevation.FAILED, detail: 'Access is denied' });
    assert.deepStrictEqual(elevation.startResult(''), { ok: false, reason: elevation.FAILED, detail: '' });
    assert.deepStrictEqual(elevation.startResult(undefined), { ok: false, reason: elevation.FAILED, detail: '' });
  });

  if (process.platform !== 'win32') {
    console.log('skipped live quoting and PowerShell checks (Windows only)');
    return;
  }

  // Arguments a path or a switch can really carry: spaces, quotes, trailing
  // backslashes, backslashes before a quote, an apostrophe and a typographic one.
  const tricky = ['C:\\Program Files\\Voxden', 'plain', 'with "quotes"', 'C:\\ends with\\', 'a\\\\"b',
    "O'Brien", 'Sou\u2019s folder', '', '--flag=a b', 'tab\there'];

  await test('the command line reads back as the same arguments', async () => {
    assert.deepStrictEqual(parsedBack(elevation.commandLine(tricky)), tricky);
    // The two the restart actually sends.
    assert.deepStrictEqual(parsedBack(elevation.commandLine(['C:\\dev\\my projects\\speakbar', '--voxden-after-pid=4321'])),
      ['C:\\dev\\my projects\\speakbar', '--voxden-after-pid=4321']);
  });

  await test('PowerShell reads every literal back exactly', async () => {
    const lines = tricky.map(value => '[Console]::Out.WriteLine([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes('
      + elevation.psLiteral(value) + ')))');
    const out = powershell(lines.join('\r\n')).trim().split(/\r?\n/);
    assert.deepStrictEqual(out.map(b => Buffer.from(b, 'base64').toString('utf8')), tricky);
  });

  const cmd = { file: "C:\\Users\\O'Brien\\Voxden\\Voxden.exe", args: tricky, cwd: 'C:\\Users\\Sou\u2019s folder' };
  const script = elevation.elevatedStartScript(cmd);
  const START = '$null = [System.Diagnostics.Process]::Start($psi)';
  const VERB = "$psi.Verb = 'runas'";
  assert.ok(script.includes(START) && script.includes(VERB), 'the script has the lines these checks replace');
  // Never elevated here: every live run takes the verb out first.
  const inert = text => text.replace(VERB, "$psi.Verb = ''");

  await test('the script hands Windows the right exe, arguments, folder and verb', async () => {
    const dump = script.replace(START, '$null = 0').replace("[Console]::Out.WriteLine('VOXDEN_OK')",
      "[Console]::Out.WriteLine([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes((@{ file = $psi.FileName; args = $psi.Arguments; cwd = $psi.WorkingDirectory; verb = $psi.Verb; shell = $psi.UseShellExecute } | ConvertTo-Json -Compress))))");
    const fields = JSON.parse(Buffer.from(powershell(dump).trim(), 'base64').toString('utf8'));
    assert.deepStrictEqual(fields, { file: cmd.file, args: elevation.commandLine(tricky), cwd: cmd.cwd, verb: 'runas', shell: true });
  });

  await test('the script says FAILED with the reason when Windows cannot start it', async () => {
    const missing = inert(elevation.elevatedStartScript({ file: 'C:\\voxden-test-missing\\nothing.exe', args: ['--x'], cwd: 'C:\\' }));
    const out = powershell(missing).trim();
    assert.match(out, /^VOXDEN_FAILED .+/);
    assert.strictEqual(elevation.startResult(out).reason, elevation.FAILED);
  });

  await test('the script says CANCELLED for a no at the prompt (error 1223), in any language', async () => {
    const no = inert(script).replace(START,
      "throw (New-Object System.Management.Automation.MethodInvocationException 'Exception calling Start', (New-Object System.ComponentModel.Win32Exception 1223))");
    assert.strictEqual(powershell(no).trim(), 'VOXDEN_CANCELLED');
  });
}

async function main() {
  await mainTests();
  await unitTests();
  await tick();
  console.log('all ' + checks + ' admin app tests passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
