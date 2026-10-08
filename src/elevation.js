'use strict';

// Restarting Voxden as administrator, on Windows.
//
// An app run as administrator -- some games are -- sits above an ordinary
// Voxden, and while it is in front Windows keeps the two apart: Voxden hears
// none of its shortcuts, neither through RegisterHotKey nor through the key
// watcher, and every key Voxden sends it is dropped (measured 2026-10-02). The
// one way to dictate into such an app is for Voxden to run as administrator
// too. Windows grants that only to a new process, after its own prompt, so
// Settings starts a second Voxden elevated and the first one quits.
//
// Everything here is pure except processAlive and sleepSync, which main.js
// hands to waitForExit so a test can play them instead.

// Windows paths, whatever this file is loaded on: the tests run on a Mac too.
const path = require('path').win32;

// The flag a restarted Voxden is given: the process it has to wait for.
const AFTER_PID = '--voxden-after-pid=';
// A login launch's way of starting with no window (main.js).
const HIDDEN = '--hidden';

const CANCELLED = 'Not restarted: the Windows prompt was cancelled.';
const FAILED = 'Windows could not restart Voxden as administrator.';

// The process id a restarted Voxden was told to wait for, or 0.
function afterPid(argv) {
  for (const arg of Array.isArray(argv) ? argv : []) {
    const value = String(arg);
    if (!value.startsWith(AFTER_PID)) continue;
    const pid = Number(value.slice(AFTER_PID.length));
    return Number.isInteger(pid) && pid > 0 ? pid : 0;
  }
  return 0;
}

// Waits until isAlive(pid) says no, asking every stepMs, for at most
// timeoutMs. True once the process is gone, false when time ran out first.
function waitForExit(pid, options) {
  const opts = options || {};
  const timeoutMs = Number(opts.timeoutMs) || 15000;
  const stepMs = Number(opts.stepMs) || 100;
  for (let waited = 0; ; waited += stepMs) {
    if (!opts.isAlive(pid)) return true;
    if (waited >= timeoutMs) return false;
    opts.sleep(stepMs);
  }
}

// Signal 0 only asks. Windows answers "no such process" once the process has
// exited, and "access denied" for one this process may not open, which is
// still running: a standard user's elevated copy runs as another account.
function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return !!err && err.code === 'EPERM';
  }
}

// A blocking sleep. The single-instance lock is taken synchronously while
// main.js loads, before Electron is ready and before anything else has
// started, so the wait in front of it has to block as well.
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// What starts this same Voxden again. A packaged build is its own exe, given
// the arguments it was started with; a development checkout is Electron's exe,
// given the app's folder by its absolute path. Windows starts an elevated
// process in System32 and may ignore the folder it is asked for, so `cwd` is
// a courtesy and nothing depends on it: Electron given "." would load System32.
// --hidden is dropped: it is how a login launch starts with no window, and
// whoever pressed the button is looking at the window and expects it back.
// The new copy is told which process to wait for.
function restartCommand({ packaged, execPath, argv, appPath, pid }) {
  const list = (Array.isArray(argv) ? argv : []).map(String);
  const extra = list.slice(packaged ? 1 : 2).filter((arg) => !arg.startsWith(AFTER_PID) && arg !== HIDDEN);
  const args = packaged ? extra : [String(appPath), ...extra];
  args.push(AFTER_PID + pid);
  return { file: String(execPath), args, cwd: packaged ? path.dirname(String(execPath)) : String(appPath) };
}

// One argument as the Windows command line carries it, for the rules that
// Electron's command-line parser (CommandLineToArgvW) reads back: quoted when
// it has a space or a quote, a quote escaped with a backslash, and the
// backslashes in front of a quote -- including the closing one -- doubled.
function quoteArg(arg) {
  const value = String(arg);
  if (value && !/[\s"]/.test(value)) return value;
  let out = '"';
  let slashes = 0;
  for (const ch of value) {
    if (ch === '\\') {
      slashes += 1;
      continue;
    }
    if (ch === '"') {
      out += '\\'.repeat(slashes * 2 + 1) + '"';
    } else {
      out += '\\'.repeat(slashes) + ch;
    }
    slashes = 0;
  }
  return out + '\\'.repeat(slashes * 2) + '"';
}

function commandLine(args) {
  return (Array.isArray(args) ? args : []).map(quoteArg).join(' ');
}

// A PowerShell single-quoted string. Nothing inside one is special but the
// quote itself, doubled to escape it -- and PowerShell counts the typographic
// single quotes as that quote too.
function psLiteral(value) {
  return "'" + String(value).replace(/['\u2018\u2019\u201a\u201b]/g, '$&$&') + "'";
}

// The script that asks Windows to start `cmd` as administrator. It prints one
// line: VOXDEN_OK once Windows has started it, VOXDEN_CANCELLED when the user
// said no at the prompt (error 1223, the same in every language), or
// VOXDEN_FAILED and the reason. ProcessStartInfo with the runas verb is what
// Start-Process -Verb RunAs calls; called directly, its error keeps the
// Windows error code, where Start-Process hands back only the message.
function elevatedStartScript(cmd) {
  return [
    "$ErrorActionPreference = 'Stop'",
    '$psi = New-Object System.Diagnostics.ProcessStartInfo',
    '$psi.FileName = ' + psLiteral(cmd.file),
    '$psi.Arguments = ' + psLiteral(commandLine(cmd.args)),
    '$psi.WorkingDirectory = ' + psLiteral(cmd.cwd),
    '$psi.UseShellExecute = $true',
    "$psi.Verb = 'runas'",
    'try {',
    '  $null = [System.Diagnostics.Process]::Start($psi)',
    "  [Console]::Out.WriteLine('VOXDEN_OK')",
    '} catch {',
    '  $e = $_.Exception',
    '  while ($e -and -not ($e -is [System.ComponentModel.Win32Exception])) { $e = $e.InnerException }',
    "  if ($e -and $e.NativeErrorCode -eq 1223) { [Console]::Out.WriteLine('VOXDEN_CANCELLED') }",
    "  else { [Console]::Out.WriteLine('VOXDEN_FAILED ' + $_.Exception.Message) }",
    '}',
  ].join('\r\n');
}

// For powershell.exe -EncodedCommand: UTF-16LE, then base64. Nothing in the
// script is quoted a second time on the way through the command line.
function encodeCommand(script) {
  return Buffer.from(String(script), 'utf16le').toString('base64');
}

// What the script printed, as the IPC reply. A helper that printed nothing
// -- killed, timed out, never started -- is a failure like any other.
function startResult(stdout) {
  const lines = String(stdout || '').split(/\r?\n/).map((line) => line.trim());
  const line = lines.find((l) => l.startsWith('VOXDEN_')) || '';
  if (line === 'VOXDEN_OK') return { ok: true };
  if (line === 'VOXDEN_CANCELLED') return { ok: false, reason: CANCELLED };
  return { ok: false, reason: FAILED, detail: line.replace(/^VOXDEN_FAILED\s*/, '').slice(0, 200) };
}

// PowerShell by its full path. A bare powershell.exe is looked up in the
// working folder before PATH, and the elevated copy starts in the install
// folder, which a per-user install leaves writable: a powershell.exe dropped
// there would run as administrator.
function powershellPath(env = process.env) {
  return path.join(env.SystemRoot || env.windir || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

module.exports = {
  powershellPath,
  AFTER_PID,
  CANCELLED,
  FAILED,
  afterPid,
  waitForExit,
  processAlive,
  sleepSync,
  restartCommand,
  quoteArg,
  commandLine,
  psLiteral,
  elevatedStartScript,
  encodeCommand,
  startResult,
};
