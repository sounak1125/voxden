$ErrorActionPreference = 'Stop'

# The real PasteKeys, caught on its way into the input stream. A low-level
# keyboard hook sees every injected key with the scan code it carries, and
# swallows it, so no Ctrl+V reaches whatever window the person running the
# tests has in front. Physical keys pass straight through: typing during the
# run neither breaks the test nor is lost.
& (Join-Path $PSScriptRoot 'win32.ps1') -Action get | Out-Null

Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Threading;

public static class PasteKeysProbe {
  [StructLayout(LayoutKind.Sequential)]
  struct KBDLLHOOKSTRUCT { public uint vkCode; public uint scanCode; public uint flags; public uint time; public IntPtr extra; }
  [StructLayout(LayoutKind.Sequential)]
  struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam; public uint time; public int x; public int y; }
  delegate IntPtr HookProc(int code, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] static extern IntPtr SetWindowsHookEx(int id, HookProc fn, IntPtr mod, uint tid);
  [DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(IntPtr hook);
  [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool PeekMessage(out MSG msg, IntPtr hwnd, uint min, uint max, uint remove);
  [DllImport("kernel32.dll")] static extern IntPtr GetModuleHandle(string name);

  static readonly List<uint[]> seen = new List<uint[]>();
  static HookProc keep;
  static IntPtr hook;

  static IntPtr OnKey(int code, IntPtr wParam, IntPtr lParam) {
    if (code >= 0) {
      KBDLLHOOKSTRUCT k = (KBDLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(KBDLLHOOKSTRUCT));
      if ((k.flags & 0x10) != 0) {
        seen.Add(new uint[] { k.vkCode, k.scanCode, (k.flags & 0x80) != 0 ? 1u : 0u });
        return (IntPtr)1;
      }
    }
    return CallNextHookEx(hook, code, wParam, lParam);
  }

  static void Pump(int ms) {
    MSG msg;
    int until = Environment.TickCount + ms;
    while (Environment.TickCount < until) {
      while (PeekMessage(out msg, IntPtr.Zero, 0, 0, 1)) { }
      Thread.Sleep(1);
    }
  }

  // Rows of { vk, scan, up }. Null when no hook could be installed, and then
  // nothing was sent. The keys go out from another thread because the hook
  // only runs while this one reads its messages; a thread that sent and
  // waited at once would time the hook out and let the paste through.
  public static List<uint[]> Capture(Action send) {
    seen.Clear();
    keep = OnKey;
    hook = SetWindowsHookEx(13, keep, GetModuleHandle(null), 0);
    if (hook == IntPtr.Zero) return null;
    try {
      Pump(50);
      Thread sender = new Thread(() => send());
      sender.Start();
      int until = Environment.TickCount + 3000;
      while (sender.IsAlive && Environment.TickCount < until) Pump(10);
      Pump(250);
    } finally {
      UnhookWindowsHookEx(hook);
      hook = IntPtr.Zero;
    }
    return new List<uint[]>(seen);
  }
}
"@

function Test-Equal($Name, $Actual, $Expected) {
  if (($Actual | ConvertTo-Json -Compress) -ne ($Expected | ConvertTo-Json -Compress)) {
    throw "$Name`n  expected $($Expected | ConvertTo-Json -Compress)`n  got      $($Actual | ConvertTo-Json -Compress)"
  }
  Write-Output "ok $Name"
}

$send = [Delegate]::CreateDelegate([Action], [VoxdenWin].GetMethod('PasteKeys'))
$rows = [PasteKeysProbe]::Capture($send)
if ($null -eq $rows) {
  Write-Output 'skip paste keys: no keyboard hook on this desktop, so nothing was sent'
  return
}
if ($rows.Count -eq 0) {
  Write-Output 'skip paste keys: this desktop delivered no injected keys'
  return
}

# Ctrl may be reported by its own VK or as left Ctrl.
$ctrlVks = @(0x11, 0xA2, 0xA3)
$keys = @($rows | Where-Object { $ctrlVks -contains [int]$_[0] -or [int]$_[0] -eq 0x56 })
$names = @($keys | ForEach-Object {
  $name = if ($ctrlVks -contains [int]$_[0]) { 'Ctrl' } else { 'V' }
  $name + $(if ($_[2]) { ' up' } else { ' down' })
})
Test-Equal 'paste is Ctrl down, V down, V up, Ctrl up' $names @('Ctrl down', 'V down', 'V up', 'Ctrl up')
Test-Equal 'every paste key carries a scan code' @($keys | Where-Object { [int]$_[1] -eq 0 }).Count 0
Test-Equal 'each key goes up on the scan code it went down on' @(
  ([int]$keys[0][1] -eq [int]$keys[3][1]), ([int]$keys[1][1] -eq [int]$keys[2][1])
) @($true, $true)

# The scan code has to be the physical V in the layout the target window uses,
# or a game reading scan codes would see some other key.
$ignored = [uint32]0
$hkl = [VoxdenWin]::GetKeyboardLayout([VoxdenWin]::GetWindowThreadProcessId([VoxdenWin]::GetForegroundWindow(), [ref]$ignored))
if ($hkl -eq [IntPtr]::Zero) { $hkl = [VoxdenWin]::GetKeyboardLayout(0) }
Test-Equal 'the V scan code is V in the foreground layout' ([VoxdenWin]::MapVirtualKeyEx([uint32]$keys[1][1], 1, $hkl)) ([uint32]0x56)
Test-Equal 'the Ctrl scan code is Ctrl in the foreground layout' ([VoxdenWin]::MapVirtualKeyEx([uint32]$keys[0][1], 1, $hkl)) ([uint32]0x11)
Write-Output 'paste keys carry scan codes'
