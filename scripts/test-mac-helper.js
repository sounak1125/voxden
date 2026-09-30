'use strict';

// The macOS helper is the counterpart of win32.ps1 and is checked the same
// way: the source must keep the protocol main.js relies on, and on macOS the
// compiled helper must answer a serve round trip. Accessibility is not
// granted on a CI runner, so the paste itself is not exercised here; the
// helper must report that cleanly instead of hanging.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync, execFileSync } = require('child_process');

function spawnSyncStatus(file, args) {
  return spawnSync(file, args, { encoding: 'utf8', timeout: 5000 }).status;
}

const src = fs.readFileSync(path.join(__dirname, '..', 'helper', 'mac', 'main.swift'), 'utf8');

let failed = 0;
function check(name, cond) {
  if (cond) console.log('ok', name);
  else { failed += 1; console.error('FAIL', name); }
}

check('serve reads QUIT', /if line == "QUIT" \{ break \}/.test(src));
check('serve answers with the request id', /\["id": id, "out": out\]/.test(src));
check('get returns a window id', /case "get":\s*\n\s*return String\(currentWindow\(\)\.id\)/.test(src));
check('info is tab separated', /"\\\(info\.id\)\\t\\\(ownerName\(info\.pid\)\)\\t\\\(title\)"/.test(src));
check('paste reports VOXDEN_OK', /return "VOXDEN_OK"/.test(src));
check('paste refuses without Accessibility', /guard AXIsProcessTrusted\(\) else \{ throw HelperError\.accessibility \}/.test(src));
check('paste waits for the chord to be released', /waitModifiersUp\(\)\s*\n\s*let pid = try bringToFront/.test(src));
check('paste posts Command+V', /postKey\(9, flags: \.maskCommand\)/.test(src));
check('foreground watch only speaks on change', /if first \|\| now != last/.test(src));
check('windows are described by CGWindowID', /_AXUIElementGetWindow/.test(src));
check('output is flushed per line', /fflush\(stdout\)/.test(src));
check('chord state is polled, not tapped', /CGEventSource\.keyState\(\.combinedSessionState, key: code\)/.test(src));
check('chord watch opens with HELD or FREE', /emit\(held \? "HELD" : "FREE"\)/.test(src));
// win32.ps1 answers a failed paste with its reason; main.js logs it and tells
// "could not be focused" apart from a helper that never answered.
check('serve answers a failed paste with its reason', /if action == "paste" \{ out = "\\\(error\)" \}/.test(src));
check('the reasons read as words', /case \.focus\(let reason\): return reason/.test(src)
  && /case \.accessibility: return "Accessibility permission is missing"/.test(src));

if (failed) {
  console.error(failed + ' failed');
  process.exit(1);
}
console.log('all mac helper source checks passed');

if (process.platform !== 'darwin') {
  console.log('skipped mac helper round trip (not macOS)');
  process.exit(0);
}

const { buildMacHelper } = require('./build-mac-helper');
const helper = buildMacHelper({ quiet: true });

// Compile the production focus/paste functions against deterministic OS
// fixtures. This exercises the actual Swift control flow without granting
// Accessibility or posting real input into a developer's current app. The
// full helper above is compiled separately against the real AppKit APIs.
function swiftFunction(name) {
  const start = src.indexOf('func ' + name + '(');
  if (start < 0) throw new Error('Missing Swift function: ' + name);
  let depth = 0;
  for (let at = src.indexOf('{', start); at < src.length; at += 1) {
    if (src[at] === '{') depth += 1;
    if (src[at] === '}' && --depth === 0) return src.slice(start, at + 1);
  }
  throw new Error('Unclosed Swift function: ' + name);
}

const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voxden-mac-paste-'));
try {
  const fixture = path.join(fixtureDir, 'main.swift');
  const binary = path.join(fixtureDir, 'paste-tests');
  fs.writeFileSync(fixture, `
import Foundation
typealias CGWindowID = UInt32
struct WindowInfo { var id: CGWindowID }
enum HelperError: Error { case focus(String), accessibility }
struct KeyFlags: Equatable { static let maskCommand = KeyFlags() }
var owner: pid_t? = 7
var front: pid_t? = 7
var focused: CGWindowID? = 100
var onScreen: CGWindowID? = nil
var available = true
var allowActivation = true
var applyActivation = true
var applyRaise = true
var trusted = true
var activations = 0
var raises = 0
var posts = 0
var focusReads = 0
var loseFocusOnRead = 0
var closeOnRead = 0
func ownerPid(ofWindow id: CGWindowID) -> pid_t? { return id == 100 ? owner : nil }
func frontmostPid() -> pid_t? { return front }
func focusedWindow(of pid: pid_t) -> WindowInfo? {
  focusReads += 1
  if focusReads == loseFocusOnRead { focused = 200 }
  if focusReads == closeOnRead { owner = nil }
  return focused.map { WindowInfo(id: $0) }
}
func onScreenWindow(of pid: pid_t) -> WindowInfo? { return onScreen.map { WindowInfo(id: $0) } }
func activateApp(_ pid: pid_t) -> Bool {
  activations += 1
  if allowActivation && applyActivation { front = pid }
  return allowActivation
}
func raiseWindow(_ id: CGWindowID, of pid: pid_t) -> Bool {
  raises += 1
  if !available { return false }
  if applyRaise { focused = id }
  return true
}
func AXIsProcessTrusted() -> Bool { return trusted }
func waitModifiersUp() {}
func postKey(_ code: UInt16, flags: KeyFlags) {
  precondition(code == 9 && flags == .maskCommand)
  posts += 1
}
${swiftFunction('pasteTargetIsFocused')}
${swiftFunction('bringToFront')}
${swiftFunction('paste')}
func reset() {
  owner = 7; front = 7; focused = 100; onScreen = nil; available = true
  allowActivation = true; applyActivation = true; applyRaise = true
  trusted = true; activations = 0; raises = 0; posts = 0
  focusReads = 0; loseFocusOnRead = 0; closeOnRead = 0
}
func refused(_ name: String, id: CGWindowID = 100, reason: String) {
  do {
    _ = try paste(into: id)
    fatalError(name + ": unexpected paste success")
  } catch {
    precondition(String(describing: error).contains(reason), name + ": wrong error: " + String(describing: error))
    precondition(posts == 0, name + ": input was posted")
    print("ok " + name)
  }
}
func pasted(_ name: String) {
  do {
    let reply = try paste(into: 100)
    precondition(reply == "VOXDEN_OK", name + ": wrong reply")
    precondition(posts == 1, name + ": expected one paste")
    print("ok " + name)
  } catch { fatalError(name + ": " + String(describing: error)) }
}
reset(); refused("zero target never posts input", id: 0, reason: "target is gone")
reset(); refused("unknown target never posts input", id: 101, reason: "target is gone")
reset(); owner = nil; refused("closed target never posts input", reason: "target is gone")
reset(); owner = 0; refused("invalid owner never posts input", reason: "target is gone")
reset(); trusted = false; refused("missing permission never posts input", reason: "accessibility")
reset(); front = 8; allowActivation = false
refused("rejected activation never posts input", reason: "could not be focused")
precondition(raises == 0)
reset(); front = 8; applyActivation = false
refused("unapplied activation never posts input", reason: "could not be focused")
reset(); focused = 200; available = false
refused("missing AX window never posts input", reason: "window is unavailable")
reset(); focused = 200; applyRaise = false
refused("wrong same-app window never receives input", reason: "could not be focused")
reset(); focused = nil; applyRaise = false
refused("unverifiable window never receives input", reason: "could not be focused")
reset(); loseFocusOnRead = 2
refused("focus stolen before posting never receives input", reason: "lost focus before paste")
reset(); closeOnRead = 1
refused("target closed before posting never receives input", reason: "lost focus before paste")
reset(); pasted("already focused target pastes once")
precondition(activations == 0 && raises == 0)
reset(); focused = 200; pasted("same-app target is raised before pasting")
precondition(activations == 0 && raises == 1 && focused == 100)
reset(); front = 8; focused = 200; pasted("other app target is activated and raised")
precondition(activations == 1 && raises == 1 && front == 7 && focused == 100)
// An app that exposes no focused window through Accessibility is judged by the
// window server's frontmost ordinary window, the source the target came from.
reset(); focused = nil; available = false; onScreen = 100
pasted("app without an AX focused window pastes into its frontmost window")
precondition(activations == 0 && raises == 0)
reset(); front = 8; focused = nil; available = false; onScreen = 100
pasted("app without AX windows is activated and judged by the window server")
precondition(activations == 1 && raises == 1 && front == 7)
reset(); focused = nil; onScreen = 200; applyRaise = false
refused("app without AX focus still refuses a different frontmost window", reason: "could not be focused")
reset(); focused = 200; onScreen = 100; applyRaise = false
refused("a differing AX focus is never overridden by the window server", reason: "could not be focused")
print("19 Swift paste-target regression cases passed (OS calls simulated)")
`);
  execFileSync('swiftc', ['-o', binary, fixture], { encoding: 'utf8', stdio: 'pipe', timeout: 60000 });
  process.stdout.write(execFileSync(binary, [], { encoding: 'utf8', timeout: 20000 }));
} finally {
  fs.rmSync(fixtureDir, { recursive: true, force: true });
}

// The real compiled helper must reject invalid focus requests. This action
// cannot post keyboard input, including on a Mac with Accessibility granted.
const invalidTarget = spawnSync(helper, ['set', '-Hwnd', '0'], { encoding: 'utf8', timeout: 5000 });
check('compiled helper refuses an invalid focus target', invalidTarget.status === 1
  && String(invalidTarget.stderr).includes('Paste target is gone'));

const oneShot = execFileSync(helper, ['get'], { encoding: 'utf8' }).trim();
check('one-shot get prints a window id', /^\d+$/.test(oneShot));
const access = execFileSync(helper, ['accessibility'], { encoding: 'utf8' }).trim();
check('accessibility reports granted or missing', access === 'granted' || access === 'missing');

// A chord watcher on a runner where nobody is touching the keyboard: FREE,
// then nothing, and it goes away when killed.
const watch = spawnSync(helper, ['-Action', 'hotkey-watch', '-Vks', '59|62,55|54'], { encoding: 'utf8', timeout: 600 });
check('hotkey watch opens with FREE', String(watch.stdout || '').trim() === 'FREE');
check('hotkey watch runs until killed', watch.signal === 'SIGTERM');
const empty = spawnSyncStatus(helper, ['-Action', 'hotkey-watch', '-Vks', '']);
check('hotkey watch refuses an empty chord', empty === 2);

// Only asked to paste where it cannot: with Accessibility granted the helper
// would really press Command+V into whatever is in front on the runner.
const requests = [
  { id: 'a', action: 'get' },
  { id: 'b', action: 'info' },
  { id: 'c', action: 'media-pause' },
].concat(access === 'missing' ? [{ id: 'd', action: 'paste', hwnd: '0' }] : []);
if (access !== 'missing') console.log('skipped the refused-paste reply (Accessibility is granted here)');

const proc = spawn(helper, ['-Action', 'serve']);
let buf = '';
const replies = [];
const deadline = setTimeout(() => {
  console.error('FAIL serve mode did not answer within 20s');
  proc.kill();
  process.exit(1);
}, 20000);
proc.stdout.setEncoding('utf8');
proc.stdout.on('data', (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    replies.push(JSON.parse(line));
    const next = requests[replies.length];
    proc.stdin.write(next ? JSON.stringify(next) + '\n' : 'QUIT\n');
  }
});
proc.stdin.write(JSON.stringify(requests[0]) + '\n');
proc.on('exit', (code) => {
  clearTimeout(deadline);
  check('serve exits cleanly on QUIT', code === 0);
  check('serve answered every request', replies.length === requests.length);
  check('serve echoes the request id', replies.every((r, i) => r.id === requests[i].id));
  check('serve returns a window id for get', replies[0] && /^\d+$/.test(String(replies[0].out)));
  check('serve returns tab-separated info', replies[1] && String(replies[1].out).split('\t').length >= 2);
  check('serve answers an unsupported action with nothing', replies[2] && replies[2].out === '');
  if (requests[3]) {
    check('serve answers a refused paste with the reason', replies[3] && replies[3].out === 'Accessibility permission is missing');
  }
  if (failed) process.exit(1);
  console.log('mac helper serve mode round trip passed');
});
