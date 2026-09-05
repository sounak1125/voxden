param([Parameter(Mandatory = $true)][ValidatePattern('^[1-9][0-9]{0,18}$')][string]$Hwnd)

# Launched only around a dictation paste. This helper reads one focused editable
# element, never clipboard contents, window titles, siblings or document trees.
# Its parent also enforces a startup deadline and kills this process after 90s.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

function Write-WatchMessage($Message) {
  [Console]::WriteLine(($Message | ConvertTo-Json -Compress -Depth 3))
  [Console]::Out.Flush()
}

try {
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
  Add-Type -ReferencedAssemblies @('UIAutomationClient', 'UIAutomationTypes', 'WindowsBase') -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Windows.Automation;

public sealed class VoxdenCorrectionSnapshot {
    public string fieldId;
    public string hwnd;
    public string text;
}

public static class VoxdenCorrectionWatch {
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
    private const int MaxCharacters = 12000;

    private static string FieldId(AutomationElement element) {
        int[] id = element.GetRuntimeId();
        if (id == null || id.Length == 0 || id.Length > 128) return null;
        return element.Current.ProcessId.ToString() + ":" + String.Join(".", id);
    }

    // Walking only this element's ancestors proves its native window identity.
    // Do not search descendants or fall back to reading the surrounding document.
    private static bool BelongsToWindow(AutomationElement element, IntPtr target) {
        AutomationElement node = element;
        for (int depth = 0; node != null && depth < 48; depth++) {
            int native = node.Current.NativeWindowHandle;
            if (native != 0) {
                IntPtr handle = new IntPtr((long)unchecked((uint)native));
                return GetAncestor(handle, 2) == target; // GA_ROOT
            }
            node = TreeWalker.RawViewWalker.GetParent(node);
        }
        return false;
    }

    public static VoxdenCorrectionSnapshot Read(string hwnd, string expectedId) {
        IntPtr target = new IntPtr(Int64.Parse(hwnd));
        if (GetForegroundWindow() != target) return null;
        AutomationElement element = AutomationElement.FocusedElement;
        if (element == null || !BelongsToWindow(element, target)) return null;
        string fieldId = FieldId(element);
        if (fieldId == null || (expectedId != null && fieldId != expectedId)) return null;

        object password = element.GetCurrentPropertyValue(AutomationElement.IsPasswordProperty, true);
        var info = element.Current;
        if (!(password is bool) || (bool)password || !info.IsEnabled ||
            !info.IsKeyboardFocusable || !info.HasKeyboardFocus ||
            (info.ControlType != ControlType.Edit && info.ControlType != ControlType.Document)) return null;

        object valueObject;
        ValuePattern value = element.TryGetCurrentPattern(ValuePattern.Pattern, out valueObject)
            ? (ValuePattern)valueObject : null;
        if (value != null && value.Current.IsReadOnly) return null;

        string text;
        object textObject;
        if (element.TryGetCurrentPattern(TextPattern.Pattern, out textObject)) {
            var range = ((TextPattern)textObject).DocumentRange;
            object readOnly = range.GetAttributeValue(TextPattern.IsReadOnlyAttribute);
            // Unknown and mixed read-only states are deliberately unsupported.
            if (!(readOnly is bool) || (bool)readOnly) return null;
            text = range.GetText(MaxCharacters + 1);
        } else if (value != null) {
            text = value.Current.Value;
        } else return null;

        if (text == null || text.Length > MaxCharacters) return null;
        // Recheck after provider calls: focus may move while a slow provider reads.
        if (GetForegroundWindow() != target) return null;
        AutomationElement stillFocused = AutomationElement.FocusedElement;
        if (stillFocused == null || FieldId(stillFocused) != fieldId) return null;
        return new VoxdenCorrectionSnapshot { fieldId = fieldId, hwnd = hwnd, text = text };
    }
}
'@

  $timer = [Diagnostics.Stopwatch]::StartNew()
  $initial = [VoxdenCorrectionWatch]::Read($Hwnd, $null)
  if ($null -eq $initial) {
    Write-WatchMessage @{ type = 'stop'; reason = 'unsupported' }
    exit 0
  }
  Write-WatchMessage @{ type = 'ready'; fieldId = $initial.fieldId; hwnd = $initial.hwnd; text = $initial.text }
  $fieldId = $initial.fieldId
  $previousText = $initial.text
  $initial = $null

  while ($timer.ElapsedMilliseconds -lt 90000) {
    Start-Sleep -Milliseconds 400
    $snapshot = [VoxdenCorrectionWatch]::Read($Hwnd, $fieldId)
    if ($null -eq $snapshot) {
      Write-WatchMessage @{ type = 'stop'; reason = 'focus-changed' }
      exit 0
    }
    if ($snapshot.text -cne $previousText) {
      Write-WatchMessage @{ type = 'snapshot'; fieldId = $snapshot.fieldId; hwnd = $snapshot.hwnd; text = $snapshot.text }
      $previousText = $snapshot.text
    }
    $snapshot = $null
  }
  Write-WatchMessage @{ type = 'stop'; reason = 'expired' }
} catch {
  # UIA provider failures are expected for unsupported apps. Never print exception
  # details: a provider may include document text in its exception message.
  Write-WatchMessage @{ type = 'stop'; reason = 'unavailable' }
}
