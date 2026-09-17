// The macOS counterpart of scripts/win32.ps1: the foreground window, its owner
// and title, a paste into it, and a long-lived foreground watcher. It speaks
// the same command line and the same JSON-over-stdin "serve" protocol, so
// main.js drives it through the one ps() call it already has.
//
// A window is identified by its CGWindowID, printed as a plain decimal, the
// way a Win32 HWND is on Windows. The owner is reported as the bundle
// identifier where the Windows helper reports an exe name.
//
// Reading the focused window and posting the paste keystroke both need the
// Accessibility permission. Without it the helper still answers "get" and
// "info" from the on-screen window list, and "paste" reports a failure
// instead of hanging.

import AppKit
import ApplicationServices
import Foundation

// Private but long-stable: the CGWindowID behind an AXUIElement window.
@_silgen_name("_AXUIElementGetWindow")
func _AXUIElementGetWindow(_ element: AXUIElement, _ out: UnsafeMutablePointer<CGWindowID>) -> AXError

struct WindowInfo {
  var id: CGWindowID
  var pid: pid_t
  var title: String
}

enum HelperError: Error {
  case focus(String)
  case accessibility
}

func emit(_ line: String) {
  print(line)
  fflush(stdout)
}

func frontmostPid() -> pid_t? {
  return NSWorkspace.shared.frontmostApplication?.processIdentifier
}

func axWindows(of pid: pid_t) -> [AXUIElement] {
  let appElement = AXUIElementCreateApplication(pid)
  var value: CFTypeRef?
  guard AXUIElementCopyAttributeValue(appElement, kAXWindowsAttribute as CFString, &value) == .success,
        let list = value as? NSArray else { return [] }
  var out: [AXUIElement] = []
  for item in list {
    out.append(item as! AXUIElement)
  }
  return out
}

func axWindowId(_ element: AXUIElement) -> CGWindowID {
  var id: CGWindowID = 0
  return _AXUIElementGetWindow(element, &id) == .success ? id : 0
}

func axTitle(_ element: AXUIElement) -> String {
  var value: CFTypeRef?
  guard AXUIElementCopyAttributeValue(element, kAXTitleAttribute as CFString, &value) == .success else { return "" }
  return (value as? String) ?? ""
}

// The focused window of an app through Accessibility. Nil when the permission
// is missing or the app has no focused window.
func focusedWindow(of pid: pid_t) -> WindowInfo? {
  let appElement = AXUIElementCreateApplication(pid)
  var value: CFTypeRef?
  guard AXUIElementCopyAttributeValue(appElement, kAXFocusedWindowAttribute as CFString, &value) == .success,
        let raw = value else { return nil }
  let element = raw as! AXUIElement
  let id = axWindowId(element)
  guard id != 0 else { return nil }
  return WindowInfo(id: id, pid: pid, title: axTitle(element))
}

func windowList(_ options: CGWindowListOption) -> [[String: Any]] {
  return (CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]]) ?? []
}

func number(_ entry: [String: Any], _ key: CFString) -> NSNumber? {
  return entry[key as String] as? NSNumber
}

// The frontmost ordinary window of an app from the window server, for when
// Accessibility is not granted. The list is front to back, so the first
// layer-zero window of the app is the one the user sees on top.
func onScreenWindow(of pid: pid_t) -> WindowInfo? {
  for entry in windowList([.optionOnScreenOnly, .excludeDesktopElements]) {
    guard let owner = number(entry, kCGWindowOwnerPID)?.int32Value, owner == pid,
          let layer = number(entry, kCGWindowLayer)?.intValue, layer == 0,
          let id = number(entry, kCGWindowNumber)?.uint32Value, id != 0 else { continue }
    let title = (entry[kCGWindowName as String] as? String) ?? ""
    return WindowInfo(id: id, pid: pid, title: title)
  }
  return nil
}

func ownerPid(ofWindow id: CGWindowID) -> pid_t? {
  guard id != 0 else { return nil }
  for entry in windowList([.optionAll]) {
    guard let wid = number(entry, kCGWindowNumber)?.uint32Value, wid == id else { continue }
    return number(entry, kCGWindowOwnerPID)?.int32Value
  }
  return nil
}

func currentWindow() -> WindowInfo {
  guard let pid = frontmostPid() else { return WindowInfo(id: 0, pid: 0, title: "") }
  if let focused = focusedWindow(of: pid) { return focused }
  if let visible = onScreenWindow(of: pid) { return visible }
  return WindowInfo(id: 0, pid: pid, title: "")
}

func describe(_ id: CGWindowID) -> WindowInfo {
  if id == 0 { return currentWindow() }
  guard let pid = ownerPid(ofWindow: id) else { return WindowInfo(id: id, pid: 0, title: "") }
  for element in axWindows(of: pid) where axWindowId(element) == id {
    return WindowInfo(id: id, pid: pid, title: axTitle(element))
  }
  for entry in windowList([.optionAll]) {
    guard let wid = number(entry, kCGWindowNumber)?.uint32Value, wid == id else { continue }
    return WindowInfo(id: id, pid: pid, title: (entry[kCGWindowName as String] as? String) ?? "")
  }
  return WindowInfo(id: id, pid: pid, title: "")
}

func ownerName(_ pid: pid_t) -> String {
  guard pid > 0, let app = NSRunningApplication(processIdentifier: pid) else { return "" }
  return app.bundleIdentifier ?? app.localizedName ?? ""
}

func infoLine(_ info: WindowInfo) -> String {
  let title = info.title.replacingOccurrences(of: "\t", with: " ")
  return "\(info.id)\t\(ownerName(info.pid))\t\(title)"
}

func modifiersDown() -> Bool {
  let flags = CGEventSource.flagsState(.combinedSessionState)
  return !flags.intersection([.maskCommand, .maskControl, .maskAlternate, .maskShift]).isEmpty
}

// A dictation chord is usually still held when the paste arrives. A paste
// posted under a held Control would reach the app as Control+Command+V.
func waitModifiersUp() {
  let deadline = Date().addingTimeInterval(2)
  while modifiersDown() && Date() < deadline {
    usleep(16_000)
  }
}

func bringToFront(_ id: CGWindowID) throws {
  guard id != 0, let pid = ownerPid(ofWindow: id) else { return }
  if frontmostPid() == pid {
    return
  }
  guard let app = NSRunningApplication(processIdentifier: pid) else {
    throw HelperError.focus("Paste target is gone")
  }
  app.activate(options: [.activateIgnoringOtherApps])
  for element in axWindows(of: pid) where axWindowId(element) == id {
    AXUIElementPerformAction(element, kAXRaiseAction as CFString)
    break
  }
  let deadline = Date().addingTimeInterval(0.4)
  while frontmostPid() != pid && Date() < deadline {
    usleep(10_000)
  }
  if frontmostPid() != pid {
    throw HelperError.focus("Paste target could not be focused")
  }
}

func postKey(_ keyCode: CGKeyCode, flags: CGEventFlags) {
  let source = CGEventSource(stateID: .combinedSessionState)
  guard let down = CGEvent(keyboardEventSource: source, virtualKey: keyCode, keyDown: true),
        let up = CGEvent(keyboardEventSource: source, virtualKey: keyCode, keyDown: false) else { return }
  down.flags = flags
  up.flags = flags
  down.post(tap: .cghidEventTap)
  usleep(8_000)
  up.post(tap: .cghidEventTap)
}

func paste(into id: CGWindowID) throws -> String {
  guard AXIsProcessTrusted() else { throw HelperError.accessibility }
  waitModifiersUp()
  try bringToFront(id)
  // kVK_ANSI_V. Command shortcuts match on the key, so this is Paste on every
  // layout that keeps V in the ANSI position.
  postKey(9, flags: .maskCommand)
  return "VOXDEN_OK"
}

// --- Push-to-talk chord ------------------------------------------------------
// The same contract as WatchChord in win32.ps1, over macOS key codes instead
// of virtual keys: the spec is groups separated by commas, alternatives within
// a group by pipes, and the chord is held while every group has a key down.
// The first line is HELD or FREE for the state the watcher was born into; then
// DOWN when the chord closes and "UP clean", "UP dirty" or "UP stale" when it
// opens. Dirty means another key was pressed while the chord was held, stale
// that the hold predates the watcher. Key state is polled the way
// GetAsyncKeyState is on Windows, so no event tap is installed.

func keyIsDown(_ code: CGKeyCode) -> Bool {
  return CGEventSource.keyState(.combinedSessionState, key: code)
}

func parseGroups(_ spec: String) -> [[CGKeyCode]] {
  var groups: [[CGKeyCode]] = []
  for part in spec.split(separator: ",") {
    let codes = part.split(separator: "|").compactMap { CGKeyCode($0.trimmingCharacters(in: .whitespaces)) }
    if !codes.isEmpty { groups.append(codes) }
  }
  return groups
}

func chordDown(_ groups: [[CGKeyCode]]) -> Bool {
  if groups.isEmpty { return false }
  for group in groups where !group.contains(where: keyIsDown) { return false }
  return true
}

// Each modifier has a left and a right key code. A chord naming one side must
// not treat the other side as somebody pressing a third key.
let modifierSides: [CGKeyCode: CGKeyCode] = [55: 54, 54: 55, 56: 60, 60: 56, 58: 61, 61: 58, 59: 62, 62: 59]

func chordKeys(_ groups: [[CGKeyCode]]) -> Set<CGKeyCode> {
  var keys = Set<CGKeyCode>()
  for code in groups.joined() {
    keys.insert(code)
    if let other = modifierSides[code] { keys.insert(other) }
  }
  return keys
}

func otherKeyDown(_ chord: Set<CGKeyCode>) -> Bool {
  for code in CGKeyCode(0)..<CGKeyCode(128) where !chord.contains(code) {
    if keyIsDown(code) { return true }
  }
  return false
}

func watchChord(_ spec: String, pollMs: UInt32) -> Never {
  let groups = parseGroups(spec)
  if groups.isEmpty { exit(2) }
  let chord = chordKeys(groups)
  var held = chordDown(groups)
  var stale = held
  var dirty = false
  emit(held ? "HELD" : "FREE")
  while true {
    let now = chordDown(groups)
    if now && !held {
      held = true
      dirty = otherKeyDown(chord)
      emit("DOWN")
    } else if !now && held {
      held = false
      if stale {
        stale = false
        emit("UP stale")
      } else {
        emit(dirty ? "UP dirty" : "UP clean")
      }
    } else if held && !stale && !dirty && otherKeyDown(chord) {
      dirty = true
    }
    usleep(pollMs * 1_000)
  }
}

func watchForeground(pollMs: UInt32) -> Never {
  var last: CGWindowID = 0
  var first = true
  while true {
    let now = currentWindow().id
    if first || now != last {
      first = false
      last = now
      emit(String(now))
    }
    usleep(pollMs * 1_000)
  }
}

func run(action: String, hwnd: String, vks: String = "") throws -> String {
  let id = CGWindowID(hwnd) ?? 0
  switch action {
  case "hotkey-watch":
    watchChord(vks, pollMs: 25)
  case "get":
    return String(currentWindow().id)
  case "info":
    return infoLine(describe(id))
  case "set":
    try bringToFront(id)
    return ""
  case "paste":
    return try paste(into: id)
  case "accessibility":
    return AXIsProcessTrusted() ? "granted" : "missing"
  case "foreground-watch":
    watchForeground(pollMs: 150)
  default:
    return ""
  }
}

func serve() {
  while let raw = readLine() {
    let line = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    if line.isEmpty { continue }
    if line == "QUIT" { break }
    guard let data = line.data(using: .utf8),
          let request = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { continue }
    let id = request["id"].map { "\($0)" } ?? ""
    let action = (request["action"] as? String) ?? ""
    let hwnd = request["hwnd"].map { "\($0)" } ?? "0"
    let out = (try? run(action: action, hwnd: hwnd)) ?? ""
    let reply: [String: Any] = ["id": id, "out": out]
    if let encoded = try? JSONSerialization.data(withJSONObject: reply),
       let text = String(data: encoded, encoding: .utf8) {
      emit(text)
    }
  }
}

// Same shape as the PowerShell helper: a positional action, or -Action, and
// -Name value pairs, all case-insensitive.
var action = ""
var options: [String: String] = [:]
var arguments = Array(CommandLine.arguments.dropFirst())
while !arguments.isEmpty {
  let arg = arguments.removeFirst()
  if arg.hasPrefix("-") {
    let name = String(arg.dropFirst()).lowercased()
    let value = arguments.isEmpty ? "" : arguments.removeFirst()
    if name == "action" { action = value } else { options[name] = value }
  } else if action.isEmpty {
    action = arg
  }
}

if action == "serve" {
  serve()
} else {
  do {
    let out = try run(action: action, hwnd: options["hwnd"] ?? "0", vks: options["vks"] ?? "")
    if !out.isEmpty { emit(out) }
  } catch {
    FileHandle.standardError.write("\(error)\n".data(using: .utf8)!)
    exit(1)
  }
}
