param(
  [Parameter(Mandatory = $true)][string]$Action,
  [string]$Hwnd = "0",
  [string]$Ids = "",
  [string]$Keys = "",
  [string]$Vks = "",
  [string]$Mode = ""
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
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern uint GetClipboardSequenceNumber();
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, int dwFlags, int dwExtraInfo);
  [DllImport("user32.dll", SetLastError = true)] public static extern uint SendInput(uint count, INPUT[] inputs, int size);
  // INPUT contains a union whose largest member is MOUSEINPUT, even for a
  // keyboard-only batch. UIntPtr gives the native 28-byte x86 / 40-byte x64
  // layout, including the padding before the union and extra-info pointer.
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public INPUTUNION data; }
  [StructLayout(LayoutKind.Explicit)] public struct INPUTUNION {
    [FieldOffset(0)] public KEYBDINPUT keyboard;
    [FieldOffset(0)] public MOUSEINPUT mouse;
    [FieldOffset(0)] public HARDWAREINPUT hardware;
  }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT {
    public ushort vk, scan; public uint flags, time; public UIntPtr extra;
  }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT {
    public int x, y; public uint mouseData, flags, time; public UIntPtr extra;
  }
  [StructLayout(LayoutKind.Sequential)] public struct HARDWAREINPUT {
    public uint message; public ushort low, high;
  }
  [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vKey);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetKeyboardLayout(uint idThread);
  [DllImport("user32.dll")] public static extern uint MapVirtualKeyEx(uint uCode, uint uMapType, IntPtr dwhkl);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr hWnd, uint flags);
  [DllImport("user32.dll")] public static extern bool GetMonitorInfo(IntPtr monitor, ref MONITORINFO info);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, System.Text.StringBuilder name, int max);
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("kernel32.dll")] public static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll")] public static extern IntPtr GetCurrentProcess();
  [DllImport("advapi32.dll")] public static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
  [DllImport("advapi32.dll")] public static extern bool GetTokenInformation(IntPtr token, int infoClass, IntPtr info, int length, out int returned);
  [DllImport("advapi32.dll")] public static extern IntPtr GetSidSubAuthority(IntPtr sid, uint index);
  [DllImport("advapi32.dll")] public static extern IntPtr GetSidSubAuthorityCount(IntPtr sid);
  public const int KEYEVENTF_KEYUP = 2;
  public const byte VK_SHIFT = 0x10;
  public const byte VK_CONTROL = 0x11;
  public const byte VK_MENU = 0x12;
  public const byte VK_SPACE = 0x20;
  public const byte VK_V = 0x56;

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

  // The physical key a virtual key sits on, in the foreground window's layout
  // (this thread's when that one cannot be read). Windows does not fill the
  // scan code in for us: a key sent with 0 reaches raw input -- what games
  // and DirectInput read -- as make code 0, a key that does not exist.
  static byte ScanCode(byte vk) {
    uint ignored;
    IntPtr hkl = GetKeyboardLayout(GetWindowThreadProcessId(GetForegroundWindow(), out ignored));
    if (hkl == IntPtr.Zero) hkl = GetKeyboardLayout(0);
    return (byte)MapVirtualKeyEx(vk, 0, hkl);
  }

  static INPUT KeyboardInput(byte vk, byte scan, uint flags) {
    INPUT input = new INPUT();
    input.type = 1;
    input.data.keyboard = new KEYBDINPUT { vk = vk, scan = scan, flags = flags };
    return input;
  }

  public static void PasteKeys() {
    byte ctrl = ScanCode(VK_CONTROL);
    byte v = ScanCode(VK_V);
    INPUT[] inputs = {
      KeyboardInput(VK_CONTROL, ctrl, 0), KeyboardInput(VK_V, v, 0),
      KeyboardInput(VK_V, v, KEYEVENTF_KEYUP), KeyboardInput(VK_CONTROL, ctrl, KEYEVENTF_KEYUP)
    };
    int size = Marshal.SizeOf(typeof(INPUT));
    uint sent = SendInput((uint)inputs.Length, inputs, size);
    if (sent == inputs.Length) return;
    int error = Marshal.GetLastWin32Error();
    // Do not replay a partial paste: that could paste twice. Release only
    // the keys whose down events were accepted without their matching up.
    if (sent > 0) {
      INPUT[] release = sent == 2
        ? new INPUT[] { inputs[2], inputs[3] }
        : new INPUT[] { inputs[3] };
      SendInput((uint)release.Length, release, size);
    }
    throw new InvalidOperationException("Paste input was not accepted (" + sent + "/" + inputs.Length + ", error " + error + ")");
  }

  // Ctrl+Insert: the copy every text field knows that is never an interrupt.
  // Ctrl+C in a terminal with nothing selected stops what is running, or
  // clears the prompt being written. Insert is an extended key.
  public static void CopyInsertKeys() {
    keybd_event(VK_CONTROL, 0, 0, 0);
    keybd_event(0x2D, 0, 1, 0);
    System.Threading.Thread.Sleep(30);
    keybd_event(0x2D, 0, 1 | KEYEVENTF_KEYUP, 0);
    keybd_event(VK_CONTROL, 0, KEYEVENTF_KEYUP, 0);
  }

  // Shift+Left, `count` times: the caret steps back over what was just
  // pasted. Arrow keys are extended keys.
  public static void SelectLeft(int count) {
    keybd_event(VK_SHIFT, 0, 0, 0);
    for (int i = 0; i < count; i++) {
      keybd_event(0x25, 0, 1, 0);
      keybd_event(0x25, 0, 1 | KEYEVENTF_KEYUP, 0);
      if (i % 50 == 49) System.Threading.Thread.Sleep(1);
    }
    keybd_event(VK_SHIFT, 0, KEYEVENTF_KEYUP, 0);
  }

  // Right with a selection collapses it to its end: the caret goes back to
  // where it was before SelectLeft.
  public static void CollapseRight() {
    keybd_event(0x27, 0, 1, 0);
    keybd_event(0x27, 0, 1 | KEYEVENTF_KEYUP, 0);
  }

  // The -Vks chord: groups separated by commas, alternatives within a group by
  // pipes ("17,91|92,32" = Ctrl and a Windows key and Space). The chord counts
  // as held while every group has at least one key down. Windows is the only
  // modifier needing alternatives -- it has no combined left/right virtual key
  // the way Ctrl, Shift and Alt do.
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
  //
  // A line is the handle, with " fullscreen" after it while that window fills
  // its screen -- the flow bar stands aside then (main.js). A game or a film
  // can go fullscreen without the foreground changing, so that is a change too.
  //
  // Then " admin" while the window's process runs above this one, as an app
  // run as administrator does. Windows keeps Voxden's shortcuts and keys away
  // from it while it is in front, and main.js tells the user why. A window's
  // level never changes, so it is asked when the foreground changes, not on
  // every poll.
  public static void WatchForeground(int pollMs) {
    IntPtr last = IntPtr.Zero;
    bool lastFull = false;
    bool admin = false;
    bool first = true;
    while (true) {
      IntPtr now = GetForegroundWindow();
      // A handful of window queries a poll. Over 40 s of watching, this loop
      // used no measurable CPU with or without them (2026-10-02; Windows
      // counts process time in 15.6 ms steps).
      bool full = IsFullscreen(now);
      if (first || now != last || full != lastFull) {
        if (first || now != last) admin = RunsAboveUs(now);
        first = false;
        last = now;
        lastFull = full;
        Console.Out.WriteLine(((long)now).ToString() + (full ? " fullscreen" : "") + (admin ? " admin" : ""));
        Console.Out.Flush();
      }
      System.Threading.Thread.Sleep(pollMs);
    }
  }

  public static void WaitModifiersUp() {
    if (!WaitPasteKeysUp("", true)) throw new InvalidOperationException("Paste keys are still held");
  }

  // The wait before a paste into a game (-Mode game, from the game shortcut).
  // A game reads a fake key-up as the player letting go, and drops the crouch
  // or sprint they are still holding, so nothing is released here: the user's
  // own modifiers are waited out for up to two seconds. If still held, refuse
  // the paste rather than turn Ctrl+V into another shortcut or release Ctrl.
  // Space stays out of it -- a held jump does not turn Ctrl+V into another
  // shortcut.
  static bool PasteModifierDown() {
    return Down(VK_SHIFT) || Down(VK_CONTROL) || Down(VK_MENU)
      || Down(0x5B) || Down(0x5C);
  }

  public static bool WaitKeysUp() {
    return WaitPasteKeysUp("", false);
  }

  // The paste-last shortcut can contain a nonmodifier such as Z. Wait for
  // every key in that chord, not merely for the chord to become incomplete.
  // Never synthesize key-up events for keys still physically held by a user.
  public static bool WaitPasteKeysUp(string spec, bool waitSpace) {
    int[][] groups = ParseGroups(spec);
    var waited = System.Diagnostics.Stopwatch.StartNew();
    while (true) {
      bool held = PasteModifierDown() || (waitSpace && Down(VK_SPACE));
      foreach (int[] group in groups) {
        foreach (int vk in group) { if (Down(vk)) held = true; }
      }
      if (!held) return true;
      if (waited.ElapsedMilliseconds >= 2000) return false;
      System.Threading.Thread.Sleep(16);
    }
  }

  // A process's integrity level -- 0x2000 for an ordinary app, 0x3000 for one
  // run as administrator -- or -1 when it cannot be read.
  static int IntegrityOf(IntPtr process) {
    IntPtr token;
    if (!OpenProcessToken(process, 0x0008, out token)) return -1;
    try {
      int length;
      GetTokenInformation(token, 25, IntPtr.Zero, 0, out length);
      if (length <= 0) return -1;
      IntPtr info = Marshal.AllocHGlobal(length);
      try {
        if (!GetTokenInformation(token, 25, info, length, out length)) return -1;
        IntPtr sid = Marshal.ReadIntPtr(info);
        int count = Marshal.ReadByte(GetSidSubAuthorityCount(sid));
        return Marshal.ReadInt32(GetSidSubAuthority(sid, (uint)(count - 1)));
      } finally {
        Marshal.FreeHGlobal(info);
      }
    } finally {
      CloseHandle(token);
    }
  }

  // True only when the window's process is known to run above this one, as a
  // game run as administrator does. Windows drops simulated keys sent up that
  // gap without a word: no error, and nothing arrives (measured 2026-10-02 with
  // Notepad run as administrator in front). A process whose level cannot be
  // read -- a protected one, as some anti-cheat is -- is not known to be above
  // and still gets the paste.
  public static bool RunsAboveUs(IntPtr h) {
    if (h == IntPtr.Zero) return false;
    uint pid;
    GetWindowThreadProcessId(h, out pid);
    if (pid == 0) return false;
    IntPtr process = OpenProcess(0x1000, false, pid);
    if (process == IntPtr.Zero) return false;
    int theirs;
    try { theirs = IntegrityOf(process); } finally { CloseHandle(process); }
    int ours = IntegrityOf(GetCurrentProcess());
    return theirs >= 0 && ours >= 0 && theirs > ours;
  }

  // Whether this process runs as administrator: high integrity or above. The
  // helper is started by Voxden and carries Voxden's token, so this is
  // Voxden's own answer too.
  public static bool Elevated() {
    return IntegrityOf(GetCurrentProcess()) >= 0x3000;
  }

  // Fills its whole monitor without being maximized: a game in fullscreen or
  // borderless mode, or a video or slideshow played full screen. A maximized
  // window covers the screen too when the taskbar hides itself, and the
  // desktop always does; neither is a game. Measured per monitor in physical
  // pixels, so a window on a scaled second screen is compared with that
  // screen and not with the scale of the first.
  public static bool IsFullscreen(IntPtr h) {
    if (h == IntPtr.Zero || IsZoomed(h) || IsIconic(h)) return false;
    System.Text.StringBuilder cls = new System.Text.StringBuilder(64);
    GetClassName(h, cls, cls.Capacity);
    string name = cls.ToString();
    if (name == "Progman" || name == "WorkerW") return false;
    IntPtr previous = IntPtr.Zero;
    try { previous = SetThreadDpiAwarenessContext((IntPtr)(-4)); } catch (EntryPointNotFoundException) {}
    try {
      RECT r;
      if (!GetWindowRect(h, out r)) return false;
      MONITORINFO mi = new MONITORINFO();
      mi.cbSize = Marshal.SizeOf(typeof(MONITORINFO));
      if (!GetMonitorInfo(MonitorFromWindow(h, 2), ref mi)) return false;
      return r.Left <= mi.rcMonitor.Left && r.Top <= mi.rcMonitor.Top
        && r.Right >= mi.rcMonitor.Right && r.Bottom >= mi.rcMonitor.Bottom;
    } finally {
      if (previous != IntPtr.Zero) SetThreadDpiAwarenessContext(previous);
    }
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
  param([switch]$KeepSound)
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
  # In a game that mute would take the game and the team on Discord with it:
  # players still pause, the speakers stay on.
  if (-not $KeepSound) { Invoke-VoxdenEndpointMute }
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

# Polish replaces a dictation where it was pasted. With the caret still right
# after those words, this selects the last -Count characters and copies them
# with Ctrl+Insert. main.js empties the clipboard first, reads what the field
# copied, and keeps the selection only when it is exactly the dictation;
# otherwise it asks for collapse-right, which puts the caret back.
# UI Automation cannot do this in Chromium fields (Claude, ChatGPT, Chrome,
# Discord, Cursor), which report the whole window as focused, so the check is
# the field's own copy of the text. The helper never touches the clipboard
# here: one it set stays its property while it waits for the next request,
# and taking it back from a thread that is not reading its messages blocks
# the taker -- Voxden's main process -- for five seconds.
function Invoke-VoxdenSelectBack {
  param([string]$Hwnd = "0", [string]$Count = "0")
  $h = [IntPtr][int64]$Hwnd
  $n = 0
  if ($h -eq [IntPtr]::Zero -or -not [int]::TryParse($Count, [ref]$n) -or $n -lt 1 -or $n -gt 4000) {
    return "VOXDEN_UNSUPPORTED"
  }
  [VoxdenWin]::WaitModifiersUp()
  if ([VoxdenWin]::GetForegroundWindow() -ne $h) {
    [VoxdenWin]::ForceForeground($h)
    $deadline = [DateTime]::UtcNow.AddMilliseconds(300)
    while ([VoxdenWin]::GetForegroundWindow() -ne $h -and [DateTime]::UtcNow -lt $deadline) {
      Start-Sleep -Milliseconds 10
    }
    if ([VoxdenWin]::GetForegroundWindow() -ne $h) { return "VOXDEN_UNSUPPORTED" }
    Start-Sleep -Milliseconds 60
  }
  [VoxdenWin]::SelectLeft($n)
  [VoxdenWin]::CopyInsertKeys()
  return "VOXDEN_SENT"
}

# Another copy of what the field has selected. A rich editor (Claude's)
# copies its own idea of the selection, which trails the arrow keys, so the
# first copy can come back short; main.js asks again until it has caught up.
# Only into the window that has the selection.
function Invoke-VoxdenCopyKeys {
  param([string]$Hwnd = "0")
  $h = [IntPtr][int64]$Hwnd
  if ($h -eq [IntPtr]::Zero -or [VoxdenWin]::GetForegroundWindow() -ne $h) { return "VOXDEN_UNSUPPORTED" }
  [VoxdenWin]::CopyInsertKeys()
  return "VOXDEN_SENT"
}

# After a select-back whose copy was not the dictation: Right collapses the
# selection to its end, where the caret was. Only into that same window.
function Invoke-VoxdenCollapseRight {
  param([string]$Hwnd = "0")
  $h = [IntPtr][int64]$Hwnd
  if ($h -eq [IntPtr]::Zero -or [VoxdenWin]::GetForegroundWindow() -ne $h) { return "VOXDEN_UNSUPPORTED" }
  [VoxdenWin]::CollapseRight()
  return "VOXDEN_OK"
}

function Invoke-VoxdenAction {
  param(
    [string]$Action,
    [string]$Hwnd = "0",
    [string]$Ids = "",
    [string]$Keys = "",
    [string]$Vks = "",
    [string]$Mode = ""
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
  "paste" {
    $h = [IntPtr][int64]$Hwnd
    $pasteClipboardSequence = [VoxdenWin]::GetClipboardSequenceNumber()
    # An app run as administrator would swallow the keys without a trace. Say
    # so instead, before anything is pressed or brought forward; main.js
    # leaves the words on the clipboard for the user's own Ctrl+V.
    $into = $h
    if ($into -eq [IntPtr]::Zero) { $into = [VoxdenWin]::GetForegroundWindow() }
    if ([VoxdenWin]::RunsAboveUs($into)) { throw "Target runs as administrator" }
    if ($Mode -eq "game") {
      # A dictation made with the game shortcut: no fake key-ups, and no
      # pulling the game back to the front.
      # A fullscreen game forced forward can flicker or change display mode,
      # and one the player has left is not where they want these words. A
      # paste refused here still leaves the dictation in History.
      if (-not [VoxdenWin]::WaitKeysUp()) { throw "Game paste modifiers are still held" }
      if ($h -ne [IntPtr]::Zero -and [VoxdenWin]::GetForegroundWindow() -ne $h) { throw "Game is no longer in front" }
      [VoxdenWin]::PasteKeys()
      Write-Output "VOXDEN_OK"
      return
    }
    if (-not [VoxdenWin]::WaitPasteKeysUp([string]$Vks, $true)) { throw "Paste keys are still held" }
    if ($h -ne [IntPtr]::Zero) {
      # An already focused target stays instant. A transient focus refusal
      # gets up to three attempts at the SAME window (about 450 ms total).
      # Retry only focus, never PasteKeys: replaying input can paste twice.
      for ($focusAttempt = 0; $focusAttempt -lt 3; $focusAttempt++) {
        if (-not [VoxdenWin]::IsWindow($h)) { throw "Paste target is no longer available" }
        if ([VoxdenWin]::GetForegroundWindow() -eq $h) { break }
        [VoxdenWin]::ForceForeground($h)
        $focusWait = [System.Diagnostics.Stopwatch]::StartNew()
        while ([VoxdenWin]::GetForegroundWindow() -ne $h -and $focusWait.ElapsedMilliseconds -lt 150 -and [VoxdenWin]::IsWindow($h)) {
          Start-Sleep -Milliseconds 10
        }
      }
      if ($focusAttempt -gt 0 -and -not [VoxdenWin]::WaitPasteKeysUp([string]$Vks, $true)) { throw "Paste keys are still held" }
      if (-not [VoxdenWin]::IsWindow($h)) { throw "Paste target is no longer available" }
      if ([VoxdenWin]::GetForegroundWindow() -ne $h) { throw "Paste target could not be focused" }
    }
    if ([VoxdenWin]::GetClipboardSequenceNumber() -ne $pasteClipboardSequence) { throw "Clipboard changed before paste" }
    [VoxdenWin]::PasteKeys()
    Write-Output "VOXDEN_OK"
  }
  "foreground-watch" {
    # Long-lived: streams the foreground window handle whenever it changes,
    # and once at start so the reader has a value straight away.
    [VoxdenWin]::WatchForeground(150)
  }
  "elevated" {
    # "1" when Voxden runs as administrator, "0" when it does not.
    if ([VoxdenWin]::Elevated()) { Write-Output "1" } else { Write-Output "0" }
  }
  "hotkey-watch" {
    # Long-lived: blocks in WatchChord and streams DOWN/UP lines until killed.
    # Only spawned for a chord that is modifiers alone; anything with a real key
    # still goes through globalShortcut, which costs nothing while idle.
    # WatchChord flushes after every line itself; Console.Out here has no
    # AutoFlush to set, and assigning one throws.
    [VoxdenWin]::WatchChord([string]$Vks, 25)
  }
  "media-pause" {
    Invoke-VoxdenMediaPause -KeepSound:($Mode -eq "game")
  }
  "media-resume" {
    Invoke-VoxdenMediaResume -Ids @($Ids)
  }
  "select-back" {
    Write-Output (Invoke-VoxdenSelectBack -Hwnd $Hwnd -Count $Keys)
  }
  "copy-keys" {
    Write-Output (Invoke-VoxdenCopyKeys -Hwnd $Hwnd)
  }
  "collapse-right" {
    Write-Output (Invoke-VoxdenCollapseRight -Hwnd $Hwnd)
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
      $result = @(Invoke-VoxdenAction -Action ([string]$req.action) -Hwnd ([string]$req.hwnd) -Ids ([string]$req.ids) -Keys ([string]$req.keys) -Vks ([string]$req.vks) -Mode ([string]$req.mode) | ForEach-Object {
        if ([string]$req.action -eq "media-pause") {
          $receipt = @{ id = [string]$req.id; partial = $true; out = [string]$_ } | ConvertTo-Json -Compress
          [Console]::Out.WriteLine($receipt)
          [Console]::Out.Flush()
        } else { $_ }
      })
      $out = (($result | ForEach-Object { [string]$_ }) -join "`n")
    } catch {
      $out = ""
      # A failed paste answers with its reason. Nothing at all is what main.js
      # also gets from a helper that timed out, and its log tells them apart.
      if ([string]$req.action -eq "paste") { $out = [string]$_.Exception.Message }
    }
    $reply = @{ id = [string]$req.id; out = [string]$out } | ConvertTo-Json -Compress
    [Console]::Out.WriteLine($reply)
    [Console]::Out.Flush()
  }
} else {
  Invoke-VoxdenAction -Action $Action -Hwnd $Hwnd -Ids $Ids -Keys $Keys -Vks $Vks -Mode $Mode
}
