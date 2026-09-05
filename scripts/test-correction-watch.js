'use strict';

// Compile the shipped helper, then exercise its unmodified read/gating logic
// against synthetic UIA providers. No foreground window or user text is read.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
if (process.platform !== 'win32') {
  console.log('skipped correction helper C# checks (Windows only)');
  process.exit(0);
}
const script = fs.readFileSync(path.join(__dirname, 'correction-watch.ps1'), 'utf8');
const source = script.match(/-TypeDefinition @'\r?\n([\s\S]*?)\r?\n'@/)[1];
function run(scriptText) {
  const result = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Mta', '-EncodedCommand', Buffer.from(scriptText, 'utf16le').toString('base64'),
  ], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
  assert.strictEqual(result.status, 0, result.stderr || result.error?.message);
  return result.stdout.trim();
}
run(`$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -ReferencedAssemblies @('UIAutomationClient', 'UIAutomationTypes', 'WindowsBase') -TypeDefinition @'
${source}
'@
`);
console.log('ok correction helper C# compiles against the installed Windows UI Automation assemblies');

const isolated = source
  .replace('using System.Windows.Automation;', 'using VoxdenTestAutomation;')
  .replace('[DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();',
    'private static IntPtr GetForegroundWindow() { return new IntPtr(World.Foreground); }')
  .replace('[DllImport("user32.dll")] private static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);',
    'private static IntPtr GetAncestor(IntPtr hwnd, uint flags) { return new IntPtr(World.Root); }');
assert(!isolated.includes('[DllImport'), 'synthetic test must contain no native entry points');
const providers = `
namespace VoxdenTestAutomation {
  public static class World {
    public static int Foreground, Root, Reads;
    public static bool SwitchOnRead;
    public static AutomationElement Focused;
    public static AutomationElement Other;
    public static void Reset() {
      Foreground = Root = 42; Reads = 0; SwitchOnRead = false;
      Focused = new AutomationElement(); Other = new AutomationElement(); Other.Runtime = new int[] { 2 };
    }
  }
  public sealed class ControlType {
    public static readonly ControlType Edit = new ControlType();
    public static readonly ControlType Document = new ControlType();
    public static readonly ControlType Button = new ControlType();
  }
  public sealed class ElementInfo {
    public int NativeWindowHandle = 42, ProcessId = 7;
    public bool IsEnabled = true, IsKeyboardFocusable = true, HasKeyboardFocus = true;
    public ControlType ControlType = ControlType.Edit;
  }
  public sealed class AutomationElement {
    public static readonly object IsPasswordProperty = new object();
    public static AutomationElement FocusedElement { get { return World.SwitchOnRead && World.Reads > 0 ? World.Other : World.Focused; } }
    public ElementInfo Current = new ElementInfo();
    public object Password = false;
    public int[] Runtime = new int[] { 1 };
    public AutomationElement Parent;
    public ValuePattern Value = new ValuePattern();
    public TextPattern Text;
    public int[] GetRuntimeId() { return Runtime; }
    public object GetCurrentPropertyValue(object property, bool ignoreDefault) { return Password; }
    public bool TryGetCurrentPattern(object pattern, out object result) {
      result = pattern == ValuePattern.Pattern ? (object)Value : (object)Text;
      return result != null;
    }
  }
  public sealed class TreeWalker {
    public static readonly TreeWalker RawViewWalker = new TreeWalker();
    public AutomationElement GetParent(AutomationElement element) { return element.Parent; }
  }
  public sealed class ValueInfo {
    public bool IsReadOnly;
    public string Content = "synthetic initial text";
    public string Value { get { World.Reads++; return Content; } }
  }
  public sealed class ValuePattern {
    public static readonly object Pattern = new object();
    public ValueInfo Current = new ValueInfo();
  }
  public sealed class TextRange {
    public object ReadOnly = false;
    public string Content = "synthetic multiline text";
    public object GetAttributeValue(object attribute) { return ReadOnly; }
    public string GetText(int max) { World.Reads++; return Content.Substring(0, Math.Min(max, Content.Length)); }
  }
  public sealed class TextPattern {
    public static readonly object Pattern = new object(), IsReadOnlyAttribute = new object();
    public TextRange DocumentRange = new TextRange();
  }
}
public static class CorrectionWatchChecks {
  private static void Check(bool condition, string description) { if (!condition) throw new Exception(description); }
  private static void RejectBeforeRead(string description) {
    Check(VoxdenCorrectionWatch.Read("42", null) == null, description + " rejected");
    Check(World.Reads == 0, description + " never read text");
  }
  public static void Run() {
    World.Reset();
    var initial = VoxdenCorrectionWatch.Read("42", null);
    Check(initial != null && initial.text == "synthetic initial text", "editable value captured");
    Check(initial.fieldId == "7:1" && initial.hwnd == "42", "identity captured");
    World.Reset(); World.Foreground = 43; RejectBeforeRead("another foreground window");
    World.Reset(); World.Root = 43; RejectBeforeRead("another native window");
    World.Reset(); World.Focused.Password = true; RejectBeforeRead("password field");
    World.Reset(); World.Focused.Password = new object(); RejectBeforeRead("unknown password state");
    World.Reset(); World.Focused.Value.Current.IsReadOnly = true; RejectBeforeRead("read-only value");
    World.Reset(); World.Focused.Current.ControlType = ControlType.Button; RejectBeforeRead("noneditable type");
    World.Reset(); World.Focused.Current.IsEnabled = false; RejectBeforeRead("disabled field");
    World.Reset(); World.Focused.Current.IsKeyboardFocusable = false; RejectBeforeRead("unfocusable field");
    World.Reset(); World.Focused.Current.HasKeyboardFocus = false; RejectBeforeRead("unfocused field");
    World.Reset(); World.Focused.Value = null; RejectBeforeRead("unsupported provider");
    World.Reset(); World.Focused.Current.NativeWindowHandle = 0; RejectBeforeRead("unproven native ancestry");
    World.Reset(); World.Focused.Runtime = new int[0]; RejectBeforeRead("unknown runtime identity");
    World.Reset();
    Check(VoxdenCorrectionWatch.Read("42", "another-field") == null && World.Reads == 0, "new field rejected without reading");
    World.Reset(); World.Focused.Value.Current.Content = new string('x', 12001);
    Check(VoxdenCorrectionWatch.Read("42", null) == null, "oversized value rejected");
    World.Reset(); World.Focused.Text = new TextPattern(); World.Focused.Value = null;
    Check(VoxdenCorrectionWatch.Read("42", null).text == "synthetic multiline text", "writable TextPattern captured");
    World.Reset(); World.Focused.Text = new TextPattern(); World.Focused.Text.DocumentRange.ReadOnly = true;
    RejectBeforeRead("read-only text range");
    World.Reset(); World.Focused.Text = new TextPattern(); World.Focused.Text.DocumentRange.ReadOnly = new object();
    RejectBeforeRead("mixed or unsupported text readonly attribute");
    World.Reset(); World.Focused.Text = new TextPattern(); World.Focused.Text.DocumentRange.Content = new string('x', 20000);
    Check(VoxdenCorrectionWatch.Read("42", null) == null, "oversized TextPattern rejected after bounded read");
    World.Reset(); World.SwitchOnRead = true;
    Check(VoxdenCorrectionWatch.Read("42", null) == null, "focus race during provider read rejected");
  }
}
`;
run(`$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
${isolated}
${providers}
'@
[CorrectionWatchChecks]::Run()
`);
console.log('ok correction helper checks identity, passwords, readonly state, focus races and size limits with synthetic providers');
