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
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;

public static class PasteKeysProbe {
  public static string Output = "";

  // win32.ps1 in a process of its own, the way main.js runs it when no
  // long-lived helper is free. What it printed lands in Output.
  public static Action Helper(string args) {
    return () => {
      ProcessStartInfo info = new ProcessStartInfo("powershell.exe", args);
      info.UseShellExecute = false;
      info.RedirectStandardOutput = true;
      info.RedirectStandardError = true;
      info.CreateNoWindow = true;
      using (Process p = Process.Start(info)) {
        System.Threading.Tasks.Task<string> output = p.StandardOutput.ReadToEndAsync();
        System.Threading.Tasks.Task<string> error = p.StandardError.ReadToEndAsync();
        p.WaitForExit();
        Output = output.Result + error.Result;
      }
    };
  }

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
      // A helper started fresh compiles its class first: allow for that.
      int until = Environment.TickCount + 30000;
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

# A paste from the game shortcut (-Mode game), through the paste action
# itself. Every injected key, by name.
function Get-KeyNames($Rows) {
  @($Rows | ForEach-Object {
    $vk = [int]$_[0]
    $name = if (@(0x11, 0xA2, 0xA3) -contains $vk) { 'Ctrl' }
      elseif (@(0x10, 0xA0, 0xA1) -contains $vk) { 'Shift' }
      elseif (@(0x12, 0xA4, 0xA5) -contains $vk) { 'Alt' }
      elseif ($vk -eq 0x20) { 'Space' }
      elseif ($vk -eq 0x56) { 'V' }
      else { 'vk' + $vk }
    $name + $(if ($_[2]) { ' up' } else { ' down' })
  })
}
$helper = Join-Path $PSScriptRoot 'win32.ps1'
function Invoke-PasteAction($Arguments) {
  [PasteKeysProbe]::Output = ''
  $caught = [PasteKeysProbe]::Capture([PasteKeysProbe]::Helper("-NoProfile -ExecutionPolicy Bypass -File `"$helper`" -Action paste $Arguments"))
  return ,@(Get-KeyNames $caught)
}

# Hwnd 0 pastes into whatever is in front without bringing anything forward,
# and the hook keeps the keys from reaching it.
$ordinary = Invoke-PasteAction '-Hwnd 0'
Test-Equal 'an ordinary paste releases the modifiers first' ($ordinary[0] -like '* up') $true
$game = Invoke-PasteAction '-Hwnd 0 -Mode game'
Test-Equal 'a game paste is Ctrl+V and no fake key-ups' $game @('Ctrl down', 'V down', 'V up', 'Ctrl up')

# A window that is not in front -- this one is never shown -- is not pulled
# forward by a game paste: the paste fails and sends nothing at all.
Add-Type -AssemblyName System.Windows.Forms
$form = New-Object System.Windows.Forms.Form
$away = Invoke-PasteAction ('-Hwnd ' + [int64]$form.Handle + ' -Mode game')
Test-Equal 'a game not in front gets no keys' $away.Count 0
Test-Equal 'and the paste says why' ([PasteKeysProbe]::Output -match 'Game is no longer in front') $true

# What counts as fullscreen: a borderless window the size of the screen, as a
# borderless game is. One pixel short is not, and neither is the desktop.
$form.FormBorderStyle = 'None'
$form.StartPosition = 'Manual'
$screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$form.Bounds = $screen
Test-Equal 'a borderless window filling the screen is fullscreen' ([VoxdenWin]::IsFullscreen($form.Handle)) $true
$form.Bounds = New-Object System.Drawing.Rectangle($screen.X, $screen.Y, $screen.Width, ($screen.Height - 1))
Test-Equal 'one pixel short is not' ([VoxdenWin]::IsFullscreen($form.Handle)) $false
$form.Dispose()
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class DesktopWindow {
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindow(string cls, string title);
}
"@
Test-Equal 'the desktop is not fullscreen' ([VoxdenWin]::IsFullscreen([DesktopWindow]::FindWindow('Progman', $null))) $false
Write-Output 'game pastes leave the game alone'

# Run as administrator: only a window known to run above the helper is
# refused. One of the helper's own level, the desktop and no window at all are
# not. (A window that is above needs an approved UAC prompt to exist, so that
# side was measured by hand against Notepad run as administrator.)
$mine = New-Object System.Windows.Forms.Form
Test-Equal 'a window at our own level is not above us' ([VoxdenWin]::RunsAboveUs($mine.Handle)) $false
$mine.Dispose()
Test-Equal 'the desktop is not above us' ([VoxdenWin]::RunsAboveUs([DesktopWindow]::FindWindow('Progman', $null))) $false
Test-Equal 'no window is not above us' ([VoxdenWin]::RunsAboveUs([IntPtr]::Zero)) $false
Write-Output 'only apps run above Voxden are refused'

# The elevated action, in a helper process of its own as main.js starts it.
# Windows' own answer for this process is the reference: the helper inherits
# its token, and a CI runner that runs everything elevated must expect "1".
$principal = New-Object Security.Principal.WindowsPrincipal ([Security.Principal.WindowsIdentity]::GetCurrent())
$expected = if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { '1' } else { '0' }
[PasteKeysProbe]::Output = ''
[PasteKeysProbe]::Helper("-NoProfile -ExecutionPolicy Bypass -File `"$helper`" -Action elevated").Invoke()
Test-Equal "the elevated action answers $expected in a test run that is $(if ($expected -eq '1') { '' } else { 'not ' })elevated" ([PasteKeysProbe]::Output.Trim()) $expected
Write-Output 'the helper knows whether Voxden runs as administrator'
