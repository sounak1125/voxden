param(
  [Parameter(Mandatory = $true)][string]$Action,
  [string]$Hwnd = "0",
  [string]$Ids = ""
)

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class VoxdenWin {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, int dwFlags, int dwExtraInfo);
  [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vKey);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
  [DllImport("user32.dll")] public static extern bool SetFocus(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
  public const int KEYEVENTF_KEYUP = 2;
  public const byte VK_SHIFT = 0x10;
  public const byte VK_CONTROL = 0x11;
  public const byte VK_MENU = 0x12;
  public const byte VK_SPACE = 0x20;
  public const byte VK_V = 0x56;
  public const byte VK_MEDIA_PLAY_PAUSE = 0xB3;

  public static void MediaPlayPause() {
    keybd_event(VK_MEDIA_PLAY_PAUSE, 0, 0, 0);
    keybd_event(VK_MEDIA_PLAY_PAUSE, 0, KEYEVENTF_KEYUP, 0);
  }

  public static void ForceForeground(IntPtr h) {
    if (h == IntPtr.Zero) return;
    if (IsIconic(h)) ShowWindow(h, 9);
    IntPtr fg = GetForegroundWindow();
    uint ignored;
    uint fgTid = GetWindowThreadProcessId(fg, out ignored);
    uint tgtTid = GetWindowThreadProcessId(h, out ignored);
    uint ourTid = GetCurrentThreadId();
    if (fgTid != 0 && fgTid != ourTid) AttachThreadInput(ourTid, fgTid, true);
    if (tgtTid != 0 && tgtTid != ourTid) AttachThreadInput(ourTid, tgtTid, true);
    BringWindowToTop(h);
    SetForegroundWindow(h);
    if (tgtTid != 0 && tgtTid != ourTid) AttachThreadInput(ourTid, tgtTid, false);
    if (fgTid != 0 && fgTid != ourTid) AttachThreadInput(ourTid, fgTid, false);
  }

  public static void ReleaseModifiers() {
    keybd_event(VK_CONTROL, 0, KEYEVENTF_KEYUP, 0);
    keybd_event(VK_SHIFT, 0, KEYEVENTF_KEYUP, 0);
    keybd_event(VK_MENU, 0, KEYEVENTF_KEYUP, 0);
    keybd_event(VK_SPACE, 0, KEYEVENTF_KEYUP, 0);
  }

  public static void PasteKeys() {
    keybd_event(VK_CONTROL, 0, 0, 0);
    keybd_event(VK_V, 0, 0, 0);
    System.Threading.Thread.Sleep(30);
    keybd_event(VK_V, 0, KEYEVENTF_KEYUP, 0);
    keybd_event(VK_CONTROL, 0, KEYEVENTF_KEYUP, 0);
  }
}
"@

Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null
$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
$script:VoxdenAsTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq "AsTask" -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq "IAsyncOperation``1"
} | Select-Object -First 1)

function Wait-WinRTOp {
  param($Op, [Type]$ResultType)
  if ($null -eq $Op -or $null -eq $script:VoxdenAsTask) { return $null }
  $m = $script:VoxdenAsTask.MakeGenericMethod($ResultType)
  $task = $m.Invoke($null, @($Op))
  $null = $task.Wait(8000)
  if ($task.IsFaulted) { return $null }
  return $task.Result
}

function Get-VoxdenMediaManager {
  try {
    $mgrType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]
    return Wait-WinRTOp -Op ($mgrType::RequestAsync()) -ResultType $mgrType
  } catch {
    return $null
  }
}

function Invoke-VoxdenMediaPause {
  $paused = New-Object System.Collections.Generic.List[string]
  $mgr = Get-VoxdenMediaManager
  if ($null -eq $mgr) { return @() }
  foreach ($s in $mgr.GetSessions()) {
    try {
      $status = [string]$s.GetPlaybackInfo().PlaybackStatus
      if ($status -ne "Playing") { continue }
      $id = [string]$s.SourceAppUserModelId
      $ok = Wait-WinRTOp -Op ($s.TryPauseAsync()) -ResultType ([bool])
      if ($ok -eq $true -and $id) { $paused.Add($id) }
    } catch {}
  }
  return @($paused)
}

function Invoke-VoxdenMediaResume {
  param([string[]]$Ids)
  $want = @()
  foreach ($raw in $Ids) {
    foreach ($part in ([string]$raw).Split(@(",", "`n", "`r"), [System.StringSplitOptions]::RemoveEmptyEntries)) {
      $t = $part.Trim()
      if ($t -and $t -ne "0") { $want += $t }
    }
  }
  if ($want -contains "__toggle__") {
    [VoxdenWin]::MediaPlayPause()
    return
  }
  if ($want.Count -eq 0) { return }
  $mgr = Get-VoxdenMediaManager
  if ($null -eq $mgr) { return }
  foreach ($s in $mgr.GetSessions()) {
    try {
      $id = [string]$s.SourceAppUserModelId
      if ($want -notcontains $id) { continue }
      $null = Wait-WinRTOp -Op ($s.TryPlayAsync()) -ResultType ([bool])
    } catch {}
  }
}

switch ($Action) {
  "get" {
    $h = [VoxdenWin]::GetForegroundWindow()
    Write-Output ([int64]$h)
  }
  "info" {
    $h = [IntPtr][int64]$Hwnd
    if ($h -eq [IntPtr]::Zero) {
      $h = [VoxdenWin]::GetForegroundWindow()
    }
    # Not $pid: that is a read-only automatic variable holding this script's own
    # process id, so writing to it fails and every window resolves to the helper.
    $targetPid = 0
    [void][VoxdenWin]::GetWindowThreadProcessId($h, [ref]$targetPid)
    $exe = ""
    if ($targetPid -gt 0) {
      try {
        $proc = Get-Process -Id $targetPid -ErrorAction Stop
        $exe = ($proc.ProcessName + ".exe")
      } catch {}
    }
    $title = ""
    try {
      $len = [VoxdenWin]::GetWindowTextLength($h)
      if ($len -gt 0) {
        $sb = New-Object System.Text.StringBuilder ($len + 2)
        [void][VoxdenWin]::GetWindowText($h, $sb, $sb.Capacity)
        $title = [string]$sb
      }
    } catch {}
    $title = $title -replace "`t", " "
    Write-Output (([int64]$h).ToString() + "`t" + $exe + "`t" + $title)
  }
  "set" {
    $h = [IntPtr][int64]$Hwnd
    if ($h -eq [IntPtr]::Zero) { return }
    [VoxdenWin]::ForceForeground($h)
  }
  "paste" {
    $h = [IntPtr][int64]$Hwnd
    [VoxdenWin]::ReleaseModifiers()
    if ($h -ne [IntPtr]::Zero) {
      [VoxdenWin]::ForceForeground($h)
      Start-Sleep -Milliseconds 120
    }
    [VoxdenWin]::PasteKeys()
  }
  "space-down" {
    $s = [VoxdenWin]::GetAsyncKeyState(0x20)
    if (($s -band 0x8000) -ne 0) { Write-Output "1" } else { Write-Output "0" }
  }
  "media-list" {
    $mgr = Get-VoxdenMediaManager
    if ($null -eq $mgr) { Write-Output "none"; return }
    foreach ($s in $mgr.GetSessions()) {
      try {
        $status = [string]$s.GetPlaybackInfo().PlaybackStatus
        $id = [string]$s.SourceAppUserModelId
        Write-Output ($id + "`t" + $status)
      } catch {}
    }
  }
  "media-pause" {
    $paused = Invoke-VoxdenMediaPause
    if ($paused.Count -gt 0) {
      Write-Output ($paused -join "`n")
    } else {
      [VoxdenWin]::MediaPlayPause()
      Write-Output "__toggle__"
    }
  }
  "media-resume" {
    Invoke-VoxdenMediaResume -Ids @($Ids)
  }
}
