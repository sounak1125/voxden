param(
  [Parameter(Mandatory = $true)][string]$Action,
  [string]$Hwnd = "0",
  [string]$Ids = "",
  [string]$Keys = "",
  [string]$Vks = ""
)

# Media uses WinRT directly; avoid compiling the unrelated keyboard helper on
# every dictation, and never synthesize a global play/pause key.
if ($Action -notlike "media-*") {
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
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
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
  public const byte VK_RETURN = 0x0D;
  public const byte VK_C = 0x43;
  public const byte VK_V = 0x56;

  [StructLayout(LayoutKind.Sequential)]
  public struct RECT {
    public int Left;
    public int Top;
    public int Right;
    public int Bottom;
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

  public static void CopyKeys() {
    keybd_event(VK_CONTROL, 0, 0, 0);
    keybd_event(VK_C, 0, 0, 0);
    System.Threading.Thread.Sleep(30);
    keybd_event(VK_C, 0, KEYEVENTF_KEYUP, 0);
    keybd_event(VK_CONTROL, 0, KEYEVENTF_KEYUP, 0);
  }

  public static void SendEnter() {
    keybd_event(VK_RETURN, 0, 0, 0);
    System.Threading.Thread.Sleep(30);
    keybd_event(VK_RETURN, 0, KEYEVENTF_KEYUP, 0);
  }

  public static void SendCtrlEnter() {
    keybd_event(VK_CONTROL, 0, 0, 0);
    keybd_event(VK_RETURN, 0, 0, 0);
    System.Threading.Thread.Sleep(30);
    keybd_event(VK_RETURN, 0, KEYEVENTF_KEYUP, 0);
    keybd_event(VK_CONTROL, 0, KEYEVENTF_KEYUP, 0);
  }

  public static bool AnyModifierDown() {
    return (GetAsyncKeyState(VK_SHIFT) & 0x8000) != 0
      || (GetAsyncKeyState(VK_CONTROL) & 0x8000) != 0
      || (GetAsyncKeyState(VK_MENU) & 0x8000) != 0
      || (GetAsyncKeyState(VK_SPACE) & 0x8000) != 0;
  }

  static int[][] ParseGroups(string spec) {
    System.Collections.Generic.List<int[]> outp = new System.Collections.Generic.List<int[]>();
    foreach (string part in (spec == null ? "" : spec).Split(',')) {
      string t = part.Trim();
      if (t.Length == 0) continue;
      System.Collections.Generic.List<int> alts = new System.Collections.Generic.List<int>();
      foreach (string a in t.Split('|')) {
        int v;
        if (int.TryParse(a.Trim(), out v)) alts.Add(v);
      }
      if (alts.Count > 0) outp.Add(alts.ToArray());
    }
    return outp.ToArray();
  }

  static bool Down(int vk) {
    return (GetAsyncKeyState(vk) & 0x8000) != 0;
  }

  static bool ChordDown(int[][] groups) {
    if (groups.Length == 0) return false;
    foreach (int[] group in groups) {
      bool any = false;
      foreach (int vk in group) { if (Down(vk)) { any = true; break; } }
      if (!any) return false;
    }
    return true;
  }

  // Ctrl, Shift and Alt each report through a combined virtual key as well as a
  // left and a right one. A chord naming the combined key must not treat its own
  // sided variants as somebody pressing a third key.
  static System.Collections.Generic.HashSet<int> ChordKeys(int[][] groups) {
    System.Collections.Generic.HashSet<int> set = new System.Collections.Generic.HashSet<int>();
    foreach (int[] group in groups) {
      foreach (int vk in group) {
        set.Add(vk);
        if (vk == VK_SHIFT) { set.Add(0xA0); set.Add(0xA1); }
        if (vk == VK_CONTROL) { set.Add(0xA2); set.Add(0xA3); }
        if (vk == VK_MENU) { set.Add(0xA4); set.Add(0xA5); }
      }
    }
    return set;
  }

  static bool OtherKeyDown(System.Collections.Generic.HashSet<int> chord) {
    for (int vk = 0x01; vk <= 0xFE; vk++) {
      if (chord.Contains(vk)) continue;
      if (Down(vk)) return true;
    }
    return false;
  }

  // A modifier-only chord cannot go through RegisterHotKey: that needs a virtual
  // key to bind to, and two modifiers give it none. Polling is the alternative,
  // and the loop lives in here rather than in PowerShell so it runs compiled --
  // one blocking call instead of a script waking twenty-five times a second.
  //
  // Reports DOWN when the chord closes, and on release either "UP clean" or
  // "UP dirty". Dirty means another key was pressed while the chord was held,
  // which is how Ctrl+Win+Left stays a virtual-desktop switch instead of also
  // starting a dictation.
  //
  // The first line is the state the watcher was born into: HELD when the chord
  // is already down, FREE otherwise. A chord that was held before the watch
  // began is not a press this watcher saw -- it is the user's fingers still on
  // the keys they just typed into the shortcut picker -- so it gets no DOWN,
  // and its release reports "UP stale" rather than a clean edge.
  public static void WatchChord(string spec, int pollMs) {
    int[][] groups = ParseGroups(spec);
    if (groups.Length == 0) return;
    System.Collections.Generic.HashSet<int> chord = ChordKeys(groups);
    bool held = ChordDown(groups);
    bool stale = held;
    bool dirty = false;
    Console.Out.WriteLine(held ? "HELD" : "FREE");
    Console.Out.Flush();
    while (true) {
      bool now = ChordDown(groups);
      if (now && !held) {
        held = true;
        dirty = OtherKeyDown(chord);
        Console.Out.WriteLine("DOWN");
        Console.Out.Flush();
      } else if (!now && held) {
        held = false;
        if (stale) {
          stale = false;
          Console.Out.WriteLine("UP stale");
        } else {
          Console.Out.WriteLine(dirty ? "UP dirty" : "UP clean");
        }
        Console.Out.Flush();
      } else if (held && !stale && !dirty && OtherKeyDown(chord)) {
        dirty = true;
      }
      System.Threading.Thread.Sleep(pollMs);
    }
  }

  // The paste target used to be read by starting a fresh powershell.exe twice
  // a second, and each of those compiled this very class before answering:
  // about a quarter of a CPU second per poll, for the life of the app. One
  // compiled loop that only speaks when the foreground window changes costs
  // nothing measurable while the user is not switching windows.
  public static void WatchForeground(int pollMs) {
    IntPtr last = IntPtr.Zero;
    bool first = true;
    while (true) {
      IntPtr now = GetForegroundWindow();
      if (first || now != last) {
        first = false;
        last = now;
        Console.Out.WriteLine(((long)now).ToString());
        Console.Out.Flush();
      }
      System.Threading.Thread.Sleep(pollMs);
    }
  }

  public static void WaitModifiersUp() {
    ReleaseModifiers();
    int until = Environment.TickCount + 2000;
    while (AnyModifierDown() && Environment.TickCount < until) {
      System.Threading.Thread.Sleep(16);
    }
    ReleaseModifiers();
  }
}
"@
}

# Discord, meeting apps, games and ordinary browser audio do not expose Windows
# media transport sessions. Endpoint mute is the one Windows control shared by
# all of them. Compile it in the warm server (and in the rare one-shot media
# fallback), while keeping it out of unrelated one-shot paste/window requests.
if ($Action -like "media-*" -or $Action -eq "serve") {
Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

[Flags]
internal enum VoxdenDeviceState : uint {
  Active = 0x1,
  All = 0xF
}

internal enum VoxdenDataFlow {
  Render = 0,
  Capture = 1,
  All = 2
}

[ComImport]
[Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
internal class VoxdenMMDeviceEnumeratorComObject {
}

[ComImport]
[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IVoxdenMMDeviceEnumerator {
  [PreserveSig]
  int EnumAudioEndpoints(VoxdenDataFlow dataFlow, VoxdenDeviceState stateMask,
    out IVoxdenMMDeviceCollection devices);
  [PreserveSig]
  int GetDefaultAudioEndpoint(VoxdenDataFlow dataFlow, int role, out IVoxdenMMDevice device);
  [PreserveSig]
  int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IVoxdenMMDevice device);
  [PreserveSig]
  int RegisterEndpointNotificationCallback(IntPtr client);
  [PreserveSig]
  int UnregisterEndpointNotificationCallback(IntPtr client);
}

[ComImport]
[Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IVoxdenMMDeviceCollection {
  [PreserveSig]
  int GetCount(out uint count);
  [PreserveSig]
  int Item(uint index, out IVoxdenMMDevice device);
}

[ComImport]
[Guid("D666063F-1587-4E43-81F1-B948E807363F")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IVoxdenMMDevice {
  [PreserveSig]
  int Activate(ref Guid iid, uint clsCtx, IntPtr activationParams,
    [MarshalAs(UnmanagedType.IUnknown)] out object instance);
  [PreserveSig]
  int OpenPropertyStore(int access, out IntPtr properties);
  [PreserveSig]
  int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
  [PreserveSig]
  int GetState(out VoxdenDeviceState state);
}

[ComImport]
[Guid("5CDF2C82-841E-4546-9722-0CF74078229A")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IVoxdenAudioEndpointVolume {
  [PreserveSig] int RegisterControlChangeNotify(IntPtr notify);
  [PreserveSig] int UnregisterControlChangeNotify(IntPtr notify);
  [PreserveSig] int GetChannelCount(out uint count);
  [PreserveSig] int SetMasterVolumeLevel(float levelDb, ref Guid context);
  [PreserveSig] int SetMasterVolumeLevelScalar(float level, ref Guid context);
  [PreserveSig] int GetMasterVolumeLevel(out float levelDb);
  [PreserveSig] int GetMasterVolumeLevelScalar(out float level);
  [PreserveSig] int SetChannelVolumeLevel(uint channel, float levelDb, ref Guid context);
  [PreserveSig] int SetChannelVolumeLevelScalar(uint channel, float level, ref Guid context);
  [PreserveSig] int GetChannelVolumeLevel(uint channel, out float levelDb);
  [PreserveSig] int GetChannelVolumeLevelScalar(uint channel, out float level);
  [PreserveSig] int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, ref Guid context);
  [PreserveSig] int GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
  [PreserveSig] int GetVolumeStepInfo(out uint step, out uint stepCount);
  [PreserveSig] int VolumeStepUp(ref Guid context);
  [PreserveSig] int VolumeStepDown(ref Guid context);
  [PreserveSig] int QueryHardwareSupport(out uint mask);
  [PreserveSig] int GetVolumeRange(out float minDb, out float maxDb, out float incrementDb);
}

public static class VoxdenEndpointAudio {
  const uint CLSCTX_ALL = 23;
  static readonly Guid EndpointVolumeIid =
    new Guid("5CDF2C82-841E-4546-9722-0CF74078229A");
  // Do not present Voxden's changes to mixer callbacks as user-generated
  // changes, which conventionally carry a null event context.
  static Guid EventContext = new Guid("F8BDAB2B-37F2-49D9-A708-D4B8689B3062");

  static void Release(object value) {
    if (value == null || !Marshal.IsComObject(value)) return;
    try { Marshal.ReleaseComObject(value); } catch { }
  }

  static IVoxdenAudioEndpointVolume Volume(IVoxdenMMDevice device) {
    if (device == null) return null;
    object value = null;
    Guid iid = EndpointVolumeIid;
    if (device.Activate(ref iid, CLSCTX_ALL, IntPtr.Zero, out value) < 0) return null;
    return value as IVoxdenAudioEndpointVolume;
  }

  // Return only endpoint ids whose state this call changed. They are ownership
  // receipts: a device the user had already muted must never be unmuted later.
  public static string[] MuteActiveRenderEndpoints() {
    List<string> changed = new List<string>();
    IVoxdenMMDeviceEnumerator enumerator = null;
    IVoxdenMMDeviceCollection devices = null;
    try {
      enumerator = (IVoxdenMMDeviceEnumerator)new VoxdenMMDeviceEnumeratorComObject();
      if (enumerator.EnumAudioEndpoints(VoxdenDataFlow.Render, VoxdenDeviceState.Active, out devices) < 0
          || devices == null) return changed.ToArray();
      uint count = 0;
      if (devices.GetCount(out count) < 0) return changed.ToArray();
      for (uint index = 0; index < count; index++) {
        IVoxdenMMDevice device = null;
        IVoxdenAudioEndpointVolume volume = null;
        try {
          if (devices.Item(index, out device) < 0 || device == null) continue;
          string id;
          if (device.GetId(out id) < 0 || String.IsNullOrEmpty(id)) continue;
          volume = Volume(device);
          if (volume == null) continue;
          bool muted;
          if (volume.GetMute(out muted) < 0 || muted) continue;
          Guid context = EventContext;
          if (volume.SetMute(true, ref context) < 0) continue;
          bool confirmed;
          if (volume.GetMute(out confirmed) >= 0 && confirmed) changed.Add(id);
        } catch { }
        finally {
          Release(volume);
          Release(device);
        }
      }
    } catch { }
    finally {
      Release(devices);
      Release(enumerator);
    }
    return changed.ToArray();
  }

  public static void RestoreMutedRenderEndpoints(string[] ids) {
    if (ids == null || ids.Length == 0) return;
    HashSet<string> wanted = new HashSet<string>(ids, StringComparer.OrdinalIgnoreCase);
    IVoxdenMMDeviceEnumerator enumerator = null;
    try {
      enumerator = (IVoxdenMMDeviceEnumerator)new VoxdenMMDeviceEnumeratorComObject();
      foreach (string id in wanted) {
        if (String.IsNullOrEmpty(id)) continue;
        IVoxdenMMDevice device = null;
        IVoxdenAudioEndpointVolume volume = null;
        try {
          if (enumerator.GetDevice(id, out device) < 0 || device == null) continue;
          volume = Volume(device);
          if (volume == null) continue;
          bool muted;
          if (volume.GetMute(out muted) < 0 || !muted) continue;
          Guid context = EventContext;
          volume.SetMute(false, ref context);
        } catch { }
        finally {
          Release(volume);
          Release(device);
        }
      }
    } catch { }
    finally {
      Release(enumerator);
    }
  }
}
"@
}

$script:VoxdenEndpointReceiptPrefix = "__endpoint__:"

function New-VoxdenEndpointReceipt {
  param([string]$Id)
  if (-not $Id) { return "" }
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($Id)
  return $script:VoxdenEndpointReceiptPrefix + [Convert]::ToBase64String($bytes)
}

function Get-VoxdenEndpointId {
  param([string]$Receipt)
  if (-not $Receipt -or -not $Receipt.StartsWith($script:VoxdenEndpointReceiptPrefix)) { return "" }
  try {
    $encoded = $Receipt.Substring($script:VoxdenEndpointReceiptPrefix.Length)
    return [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encoded))
  } catch {
    return ""
  }
}

function Invoke-VoxdenEndpointMute {
  try {
    foreach ($endpointId in @([VoxdenEndpointAudio]::MuteActiveRenderEndpoints())) {
      $receipt = New-VoxdenEndpointReceipt -Id ([string]$endpointId)
      if ($receipt) { Write-Output $receipt }
    }
  } catch {}
}

function Invoke-VoxdenEndpointRestore {
  param([string[]]$Receipts)
  $endpointIds = New-Object System.Collections.Generic.List[string]
  foreach ($receipt in @($Receipts)) {
    $endpointId = Get-VoxdenEndpointId -Receipt ([string]$receipt)
    if ($endpointId) { $endpointIds.Add($endpointId) }
  }
  if ($endpointIds.Count -eq 0) { return }
  try { [VoxdenEndpointAudio]::RestoreMutedRenderEndpoints($endpointIds.ToArray()) } catch {}
}

function Ensure-WinRT {
  if ($script:VoxdenWinRTReady) { return }
  Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null
  $null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
  $script:VoxdenAsTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq "AsTask" -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq "IAsyncOperation``1"
  } | Select-Object -First 1)
  $script:VoxdenWinRTReady = $true
}

function Wait-WinRTOp {
  param($Op, [Type]$ResultType)
  Ensure-WinRT
  if ($null -eq $Op -or $null -eq $script:VoxdenAsTask) { return $null }
  $m = $script:VoxdenAsTask.MakeGenericMethod($ResultType)
  $task = $m.Invoke($null, @($Op))
  if (-not $task.Wait(8000)) { return $null }
  if ($task.IsFaulted) { return $null }
  return $task.Result
}

function Get-VoxdenMediaManager {
  try {
    Ensure-WinRT
    $mgrType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]
    return Wait-WinRTOp -Op ($mgrType::RequestAsync()) -ResultType $mgrType
  } catch {
    return $null
  }
}

function Invoke-VoxdenMediaPause {
  $mgr = Get-VoxdenMediaManager
  if ($null -ne $mgr) {
    $sessions = @($mgr.GetSessions())
    foreach ($s in $sessions) {
      try {
        $status = [string]$s.GetPlaybackInfo().PlaybackStatus
        if ($status -ne "Playing") { continue }
        $id = [string]$s.SourceAppUserModelId
        if (-not $id) { continue }
        # App IDs are not session IDs. Several browser tabs can share one; skip
        # ambiguous IDs rather than later starting an unrelated paused tab.
        if (@($sessions | Where-Object { $_.SourceAppUserModelId -eq $id }).Count -ne 1) { continue }
        $ok = Wait-WinRTOp -Op ($s.TryPauseAsync()) -ResultType ([bool])
        if ($ok -eq $true) { Write-Output $id }
      } catch {}
    }
  }
  # Transport controls do not see Discord calls or ordinary app audio. Endpoint
  # receipts join media receipts in the same serialized ownership controller.
  Invoke-VoxdenEndpointMute
}

function Invoke-VoxdenMediaResume {
  param([string[]]$Ids)
  $want = @()
  foreach ($raw in $Ids) {
    foreach ($part in ([string]$raw).Split(@(",", "`n", "`r"), [System.StringSplitOptions]::RemoveEmptyEntries)) {
      $t = $part.Trim()
      if ($t -and $t -ne "0" -and $t -ne "__toggle__") { $want += $t }
    }
  }
  if ($want.Count -eq 0) { return }
  $endpointReceipts = @($want | Where-Object { $_.StartsWith($script:VoxdenEndpointReceiptPrefix) })
  if ($endpointReceipts.Count -gt 0) {
    Invoke-VoxdenEndpointRestore -Receipts $endpointReceipts
  }
  $want = @($want | Where-Object { -not $_.StartsWith($script:VoxdenEndpointReceiptPrefix) })
  if ($want.Count -eq 0) { return }
  $mgr = Get-VoxdenMediaManager
  if ($null -eq $mgr) { return }
  $sessions = @($mgr.GetSessions())
  foreach ($s in $sessions) {
    try {
      $id = [string]$s.SourceAppUserModelId
      if ($want -notcontains $id) { continue }
      if (@($sessions | Where-Object { $_.SourceAppUserModelId -eq $id }).Count -ne 1) { continue }
      if ([string]$s.GetPlaybackInfo().PlaybackStatus -ne "Paused") { continue }
      $null = Wait-WinRTOp -Op ($s.TryPlayAsync()) -ResultType ([bool])
    } catch {}
  }
}

function Get-ClipboardText {
  try {
    Add-Type -AssemblyName System.Windows.Forms | Out-Null
    return [string][System.Windows.Forms.Clipboard]::GetText()
  } catch {
    return ""
  }
}

function Set-ClipboardText {
  param([string]$Text)
  try {
    Add-Type -AssemblyName System.Windows.Forms | Out-Null
    if ([string]::IsNullOrEmpty($Text)) {
      [System.Windows.Forms.Clipboard]::Clear()
    } else {
      [System.Windows.Forms.Clipboard]::SetText($Text)
    }
  } catch {}
}

function Invoke-VoxdenSelection {
  param([string]$Hwnd)
  $h = [IntPtr][int64]$Hwnd
  $prev = Get-ClipboardText
  try {
    [VoxdenWin]::ReleaseModifiers()
    if ($h -ne [IntPtr]::Zero) {
      [VoxdenWin]::ForceForeground($h)
      Start-Sleep -Milliseconds 80
    }
    [VoxdenWin]::CopyKeys()
    Start-Sleep -Milliseconds 80
    $text = Get-ClipboardText
    return $text
  } catch {
    return ""
  } finally {
    Set-ClipboardText -Text $prev
  }
}

function Invoke-VoxdenOcr {
  param([string]$Hwnd)
  $tmp = $null
  try {
    Add-Type -AssemblyName System.Drawing | Out-Null
    $h = [IntPtr][int64]$Hwnd
    if ($h -eq [IntPtr]::Zero) { $h = [VoxdenWin]::GetForegroundWindow() }
    $rect = New-Object VoxdenWin+RECT
    [void][VoxdenWin]::GetWindowRect($h, [ref]$rect)
    $w = [Math]::Max(1, $rect.Right - $rect.Left)
    $ht = [Math]::Max(1, $rect.Bottom - $rect.Top)
    if ($w -gt 1600) {
      $ht = [int]([Math]::Max(1, $ht * 1600 / $w))
      $w = 1600
    }
    if ($ht -gt 1200) {
      $w = [int]([Math]::Max(1, $w * 1200 / $ht))
      $ht = 1200
    }
    $bmp = New-Object System.Drawing.Bitmap $w, $ht
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($rect.Left, $rect.Top, 0, 0, (New-Object System.Drawing.Size $w, $ht))
    $g.Dispose()
    $tmp = [System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), "voxden-ocr-" + [guid]::NewGuid().ToString("N") + ".png")
    $bmp.Save($tmp, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()

    Ensure-WinRT
    [Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime] | Out-Null
    [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
    [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
    [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime] | Out-Null
    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
    if ($null -eq $engine) { return "" }
    $file = Wait-WinRTOp -Op ([Windows.Storage.StorageFile]::GetFileFromPathAsync($tmp)) -ResultType ([Windows.Storage.StorageFile])
    if ($null -eq $file) { return "" }
    $stream = Wait-WinRTOp -Op ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) -ResultType ([Windows.Storage.Streams.IRandomAccessStream])
    if ($null -eq $stream) { return "" }
    $decoder = Wait-WinRTOp -Op ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) -ResultType ([Windows.Graphics.Imaging.BitmapDecoder])
    if ($null -eq $decoder) { return "" }
    $bitmap = Wait-WinRTOp -Op ($decoder.GetSoftwareBitmapAsync()) -ResultType ([Windows.Graphics.Imaging.SoftwareBitmap])
    if ($null -eq $bitmap) { return "" }
    $result = Wait-WinRTOp -Op ($engine.RecognizeAsync($bitmap)) -ResultType ([Windows.Media.Ocr.OcrResult])
    try { $stream.Dispose() } catch {}
    if ($null -eq $result) { return "" }
    return ([string]$result.Text)
  } catch {
    return ""
  } finally {
    if ($tmp -and (Test-Path $tmp)) {
      Remove-Item $tmp -Force -ErrorAction SilentlyContinue
    }
  }
}

function Invoke-VoxdenAction {
  param(
    [string]$Action,
    [string]$Hwnd = "0",
    [string]$Ids = "",
    [string]$Keys = "",
    [string]$Vks = ""
  )
  if (-not $Hwnd) { $Hwnd = "0" }
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
    [VoxdenWin]::WaitModifiersUp()
    if ($h -ne [IntPtr]::Zero) {
      [VoxdenWin]::ForceForeground($h)
      Start-Sleep -Milliseconds 80
      if ([VoxdenWin]::GetForegroundWindow() -ne $h) { throw "Paste target could not be focused" }
    }
    [VoxdenWin]::PasteKeys()
    Write-Output "VOXDEN_OK"
  }
  "foreground-watch" {
    # Long-lived: streams the foreground window handle whenever it changes,
    # and once at start so the reader has a value straight away.
    [VoxdenWin]::WatchForeground(150)
  }
  "hotkey-watch" {
    # Long-lived: blocks in WatchChord and streams DOWN/UP lines until killed.
    # Only spawned for a chord that is modifiers alone; anything with a real key
    # still goes through globalShortcut, which costs nothing while idle.
    # WatchChord flushes after every line itself; Console.Out here has no
    # AutoFlush to set, and assigning one throws.
    [VoxdenWin]::WatchChord([string]$Vks, 25)
  }
  "keys-down" {
    # -Vks is the push-to-talk chord: groups separated by commas, alternatives
    # within a group by pipes ("17,91|92,32" = Ctrl and a Windows key and
    # Space). The chord counts as held while every group has at least one key
    # down, so releasing any part of it ends the recording. Windows is the only
    # modifier needing alternatives -- it has no combined left/right virtual key
    # the way Ctrl, Shift and Alt do.
    $held = $true
    foreach ($group in ([string]$Vks).Split(",")) {
      $g = $group.Trim()
      if (-not $g) { continue }
      $any = $false
      foreach ($code in $g.Split("|")) {
        $c = $code.Trim()
        if (-not $c) { continue }
        $vk = 0
        if (-not [int]::TryParse($c, [ref]$vk)) { continue }
        if (([VoxdenWin]::GetAsyncKeyState($vk) -band 0x8000) -ne 0) { $any = $true; break }
      }
      if (-not $any) { $held = $false; break }
    }
    if ($held) { Write-Output "1" } else { Write-Output "0" }
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
    Invoke-VoxdenMediaPause
  }
  "media-resume" {
    Invoke-VoxdenMediaResume -Ids @($Ids)
  }
  "selection" {
    Write-Output (Invoke-VoxdenSelection -Hwnd $Hwnd)
  }
  "ocr" {
    Write-Output (Invoke-VoxdenOcr -Hwnd $Hwnd)
  }
  "send" {
    $h = [IntPtr][int64]$Hwnd
    [VoxdenWin]::WaitModifiersUp()
    if ($h -ne [IntPtr]::Zero) {
      [VoxdenWin]::ForceForeground($h)
      Start-Sleep -Milliseconds 40
      if ([VoxdenWin]::GetForegroundWindow() -ne $h) { throw "Send target could not be focused" }
    }
    $kind = ([string]$Keys).Trim().ToLower()
    if ($kind -eq "ctrl-enter") {
      [VoxdenWin]::SendCtrlEnter()
    } elseif ($kind -eq "enter") {
      [VoxdenWin]::SendEnter()
    }
    Write-Output "VOXDEN_OK"
  }
}
}

if ($Action -eq "serve") {
  # Long-lived command server. One-shot invocations pay for a process start
  # and a compile of the class above on every call -- about a quarter of a
  # CPU second and most of a wall second -- and a dictation made four or five
  # of them: the paste alone sat a second behind the transcript. This loop
  # answers JSON requests on stdin with JSON replies on stdout, compiled once.
  [Console]::InputEncoding = [System.Text.Encoding]::UTF8
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  $reader = [Console]::In
  while ($true) {
    $line = $reader.ReadLine()
    if ($null -eq $line) { break }
    $line = $line.Trim()
    if (-not $line) { continue }
    if ($line -eq "QUIT") { break }
    $req = $null
    try { $req = $line | ConvertFrom-Json } catch { continue }
    if ($null -eq $req) { continue }
    $out = ""
    try {
      $result = @(Invoke-VoxdenAction -Action ([string]$req.action) -Hwnd ([string]$req.hwnd) -Ids ([string]$req.ids) -Keys ([string]$req.keys) -Vks ([string]$req.vks) | ForEach-Object {
        if ([string]$req.action -eq "media-pause") {
          $receipt = @{ id = [string]$req.id; partial = $true; out = [string]$_ } | ConvertTo-Json -Compress
          [Console]::Out.WriteLine($receipt)
          [Console]::Out.Flush()
        } else { $_ }
      })
      $out = (($result | ForEach-Object { [string]$_ }) -join "`n")
    } catch {
      $out = ""
    }
    $reply = @{ id = [string]$req.id; out = [string]$out } | ConvertTo-Json -Compress
    [Console]::Out.WriteLine($reply)
    [Console]::Out.Flush()
  }
} else {
  Invoke-VoxdenAction -Action $Action -Hwnd $Hwnd -Ids $Ids -Keys $Keys -Vks $Vks
}
