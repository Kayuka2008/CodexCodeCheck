param(
    [switch] $Once,
    [ValidateRange(200, 3000)] [int] $PollMs = 1000,
    [int] $ParentProcessId = 0,
    [switch] $WatchCodex,
    [string] $Generation,
    [int] $SkipProcessId = 0
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

namespace CodexReviewDesk
{
    public sealed class Bounds
    {
        public int x, y, width, height;
    }

    public sealed class WindowInfo
    {
        public Bounds bounds;
        public string title;
        public bool foreground, visible;
        public string handle;
        public uint processId, dpi;
    }

    public static class DockProbe
    {
        [StructLayout(LayoutKind.Sequential)]
        private struct Rect
        {
            public int Left, Top, Right, Bottom;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct Message
        {
            public IntPtr Window;
            public uint Id;
            public UIntPtr WParam;
            public IntPtr LParam;
            public uint Time;
            public int X, Y;
            public uint Private;
        }

        private const uint Foreground = 0x0003, MoveSizeEnd = 0x000B;
        private const uint MinimizeStart = 0x0016, MinimizeEnd = 0x0017;
        private const uint Destroy = 0x8001, Show = 0x8002, Hide = 0x8003;
        private const uint LocationChange = 0x800B, NameChange = 0x800C;
        private const uint Cloaked = 0x8017, Uncloaked = 0x8018;
        private const int ProbeInterval = 24, SettleInterval = 80;

        private delegate void WinEventProc(IntPtr hook, uint ev, IntPtr window, int objectId, int childId, uint threadId, uint time);
        private delegate bool EnumWindowsProc(IntPtr window, IntPtr param);

        [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr param);
        [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);
        [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr window);
        [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] private static extern IntPtr GetAncestor(IntPtr window, uint flags);
        [DllImport("user32.dll")] private static extern IntPtr GetWindow(IntPtr window, uint command);
        [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
        [DllImport("user32.dll")] private static extern uint GetDpiForWindow(IntPtr window);
        [DllImport("user32.dll")] private static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
        [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr window, out Rect rect);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr window, StringBuilder text, int capacity);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(IntPtr window, StringBuilder text, int capacity);
        [DllImport("user32.dll")] private static extern IntPtr SetWinEventHook(uint min, uint max, IntPtr module, WinEventProc callback, uint processId, uint threadId, uint flags);
        [DllImport("user32.dll")] private static extern bool UnhookWinEvent(IntPtr hook);
        [DllImport("user32.dll")] private static extern bool PeekMessage(out Message message, IntPtr window, uint min, uint max, uint remove);
        [DllImport("user32.dll")] private static extern IntPtr DispatchMessage(ref Message message);
        [DllImport("user32.dll", SetLastError = true)] private static extern uint MsgWaitForMultipleObjectsEx(uint count, IntPtr[] handles, uint timeout, uint mask, uint flags);
        [DllImport("dwmapi.dll")] private static extern int DwmGetWindowAttribute(IntPtr window, int attribute, out Rect value, int size);
        [DllImport("dwmapi.dll")] private static extern int DwmGetWindowAttribute(IntPtr window, int attribute, out uint value, int size);
        [DllImport("kernel32.dll")] private static extern IntPtr OpenProcess(uint access, bool inherit, uint processId);
        [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] private static extern bool QueryFullProcessImageName(IntPtr process, int flags, StringBuilder name, ref uint size);

        private static readonly Dictionary<uint, bool> hostCache = new Dictionary<uint, bool>();
        private static DateTime nextCacheReset = DateTime.MinValue;
        private static IntPtr selectedWindow, lastForegroundOwner;
        private static WindowInfo selectedInfo;

        private static bool IsCodexHost(uint processId)
        {
            bool match;
            if (hostCache.TryGetValue(processId, out match)) return match;
            IntPtr process = OpenProcess(0x1000, false, processId); // PROCESS_QUERY_LIMITED_INFORMATION
            if (process != IntPtr.Zero)
            {
                try
                {
                    StringBuilder image = new StringBuilder(32768);
                    uint capacity = (uint)image.Capacity;
                    if (QueryFullProcessImageName(process, 0, image, ref capacity))
                    {
                        string executable = image.ToString();
                        string basename = Path.GetFileName(executable);
                        bool packaged = executable.IndexOf(@"\WindowsApps\OpenAI.Codex_", StringComparison.OrdinalIgnoreCase) >= 0;
                        match = basename.Equals("Codex.exe", StringComparison.OrdinalIgnoreCase) ||
                            (packaged && basename.Equals("ChatGPT.exe", StringComparison.OrdinalIgnoreCase));
                    }
                }
                finally { CloseHandle(process); }
            }
            hostCache[processId] = match;
            return match;
        }

        private static bool IsChromiumWindow(IntPtr window)
        {
            StringBuilder name = new StringBuilder(96);
            return GetClassName(window, name, name.Capacity) > 0 &&
                name.ToString().StartsWith("Chrome_WidgetWin_", StringComparison.Ordinal);
        }

        private static bool IsShown(IntPtr window)
        {
            uint cloaked;
            return IsWindowVisible(window) && !IsIconic(window) &&
                (DwmGetWindowAttribute(window, 14, out cloaked, sizeof(uint)) != 0 || cloaked == 0);
        }

        private static uint CodexProcess(IntPtr window)
        {
            if (window == IntPtr.Zero || GetWindow(window, 4) != IntPtr.Zero || !IsChromiumWindow(window)) return 0;
            uint processId;
            GetWindowThreadProcessId(window, out processId);
            return processId != 0 && IsCodexHost(processId) ? processId : 0;
        }

        // DWM returns physical desktop coordinates. The Electron caller converts them to DIP.
        private static WindowInfo Describe(IntPtr window, uint processId, bool foreground)
        {
            if (processId == 0 || !IsShown(window)) return null;
            Rect rect;
            if (DwmGetWindowAttribute(window, 9, out rect, Marshal.SizeOf(typeof(Rect))) != 0 && !GetWindowRect(window, out rect)) return null;
            int width = rect.Right - rect.Left, height = rect.Bottom - rect.Top;
            if (width < 320 || height < 220) return null;
            StringBuilder title = new StringBuilder(512);
            if (GetWindowText(window, title, title.Capacity) == 0) return null;
            return new WindowInfo
            {
                bounds = new Bounds { x = rect.Left, y = rect.Top, width = width, height = height },
                title = title.ToString(),
                foreground = foreground,
                visible = true,
                handle = window.ToInt64().ToString(CultureInfo.InvariantCulture),
                processId = processId,
                dpi = GetDpiForWindow(window)
            };
        }

        private static WindowInfo Select(IntPtr window, WindowInfo info)
        {
            selectedWindow = window;
            selectedInfo = info;
            return info;
        }

        private static WindowInfo Read(bool retainHidden)
        {
            if (DateTime.UtcNow >= nextCacheReset)
            {
                hostCache.Clear();
                nextCacheReset = DateTime.UtcNow.AddSeconds(10);
            }

            IntPtr oldDpiContext = SetThreadDpiAwarenessContext(new IntPtr(-4)); // PER_MONITOR_AWARE_V2
            try
            {
                IntPtr foreground = GetForegroundWindow();
                IntPtr foregroundOwner = GetAncestor(foreground, 3); // GA_ROOTOWNER
                bool foregroundChanged = foregroundOwner != lastForegroundOwner;
                lastForegroundOwner = foregroundOwner;
                uint selectedPid = 0;
                WindowInfo info = null;
                if (selectedInfo != null)
                {
                    selectedPid = CodexProcess(selectedWindow);
                    if (selectedPid != selectedInfo.processId) selectedPid = 0;
                    // Windows may foreground another Codex window during minimize. Keep the
                    // current attachment until its HWND is shown again or destroyed.
                    if (retainHidden && selectedPid != 0 && !IsShown(selectedWindow))
                    {
                        if (!selectedInfo.visible) return selectedInfo;
                        return Select(selectedWindow, new WindowInfo
                        {
                            bounds = selectedInfo.bounds, title = selectedInfo.title,
                            foreground = false, visible = false, handle = selectedInfo.handle,
                            processId = selectedPid, dpi = selectedInfo.dpi
                        });
                    }
                    info = Describe(selectedWindow, selectedPid, selectedWindow == foreground || selectedWindow == foregroundOwner);
                    if (info != null && (!foregroundChanged || !selectedInfo.visible || info.foreground)) return Select(selectedWindow, info);
                }

                // Only enumerate windows when there is no usable foreground or remembered host.
                WindowInfo focused = Describe(foregroundOwner, CodexProcess(foregroundOwner), true);
                if (focused != null) return Select(foregroundOwner, focused);
                if (info != null) return Select(selectedWindow, info);

                IntPtr found = IntPtr.Zero;
                EnumWindows(delegate (IntPtr window, IntPtr param)
                {
                    if (!IsWindowVisible(window)) return true;
                    info = Describe(window, CodexProcess(window), window == foreground || window == foregroundOwner);
                    if (info == null) return true;
                    found = window;
                    return false;
                }, IntPtr.Zero);
                return Select(found, info);
            }
            finally
            {
                if (oldDpiContext != IntPtr.Zero) SetThreadDpiAwarenessContext(oldDpiContext);
            }
        }

        public static WindowInfo Read() { return Read(false); }

        private static bool SameWindow(WindowInfo left, WindowInfo right)
        {
            if (left == right) return true;
            return left != null && right != null && left.handle == right.handle &&
                left.processId == right.processId && left.dpi == right.dpi &&
                left.foreground == right.foreground && left.visible == right.visible &&
                left.title == right.title && left.bounds.x == right.bounds.x &&
                left.bounds.y == right.bounds.y && left.bounds.width == right.bounds.width &&
                left.bounds.height == right.bounds.height;
        }

        public static void Watch(int parentProcessId, int fallbackMs, Action<WindowInfo> update)
        {
            const uint sync = 0x00100000;
            IntPtr parent = parentProcessId > 0 ? OpenProcess(sync, false, (uint)parentProcessId) : IntPtr.Zero;
            if (parentProcessId > 0 && parent == IntPtr.Zero) return;
            IntPtr[] handles = parent == IntPtr.Zero ? new IntPtr[0] : new IntPtr[] { parent };
            Stopwatch clock = Stopwatch.StartNew();
            long dirtyAt = long.MaxValue, settleAt = long.MaxValue;
            WinEventProc callback = delegate (IntPtr hook, uint ev, IntPtr window, int objectId, int childId, uint threadId, uint time)
            {
                if (ev != Foreground)
                {
                    if (window == IntPtr.Zero || objectId != 0 || childId != 0) return; // OBJID_WINDOW, CHILDID_SELF
                    if (window != selectedWindow && !((ev == Show || ev == Uncloaked || ev == MinimizeEnd) &&
                        selectedWindow == IntPtr.Zero && CodexProcess(window) != 0)) return;
                }
                long now = clock.ElapsedMilliseconds;
                // Coalesce move/resize bursts without postponing updates until the drag ends.
                dirtyAt = Math.Min(dirtyAt, now + ProbeInterval);
                settleAt = now + SettleInterval;
            };

            // OUTOFCONTEXT callbacks run on this pumping thread. Never call PowerShell from a hook.
            const uint skipOwnProcess = 2;
            uint[,] ranges = { { Foreground, Foreground }, { MoveSizeEnd, MoveSizeEnd },
                { MinimizeStart, MinimizeEnd }, { Destroy, Hide },
                { LocationChange, NameChange }, { Cloaked, Uncloaked } };
            IntPtr[] hooks = new IntPtr[ranges.GetLength(0)];
            try
            {
                for (int i = 0; i < hooks.Length; i++)
                    hooks[i] = SetWinEventHook(ranges[i, 0], ranges[i, 1], IntPtr.Zero, callback, 0, 0, skipOwnProcess);

                WindowInfo previous = Read(true);
                update(previous);
                long fallbackAt = clock.ElapsedMilliseconds + fallbackMs;
                uint count = (uint)handles.Length;
                while (true)
                {
                    long deadline = Math.Min(fallbackAt, Math.Min(dirtyAt, settleAt));
                    uint timeout = (uint)Math.Max(0, deadline - clock.ElapsedMilliseconds);
                    const uint allInput = 0x04FF, inputAvailable = 4;
                    uint result = MsgWaitForMultipleObjectsEx(count, handles, timeout, allInput, inputAvailable);
                    if (parent != IntPtr.Zero && result == 0) break;
                    if (result == 0xFFFFFFFF) throw new Win32Exception(Marshal.GetLastWin32Error());
                    if (result == count)
                    {
                        Message message;
                        // Bound each batch so a busy queue cannot starve the probes.
                        for (int i = 0; i < 64 && PeekMessage(out message, IntPtr.Zero, 0, 0, 1); i++)
                        {
                            if (message.Id == 0x0012) return; // WM_QUIT
                            DispatchMessage(ref message);
                        }
                    }

                    long now = clock.ElapsedMilliseconds;
                    if (now < Math.Min(fallbackAt, Math.Min(dirtyAt, settleAt))) continue;
                    if (now >= dirtyAt) dirtyAt = long.MaxValue;
                    if (now >= settleAt) settleAt = long.MaxValue;
                    WindowInfo current = Read(true);
                    if (!SameWindow(current, previous))
                    {
                        update(current);
                        previous = current;
                    }
                    fallbackAt = clock.ElapsedMilliseconds + fallbackMs;
                }
            }
            finally
            {
                foreach (IntPtr hook in hooks) if (hook != IntPtr.Zero) UnhookWinEvent(hook);
                GC.KeepAlive(callback);
                if (parent != IntPtr.Zero) CloseHandle(parent);
            }
        }
    }
}
'@

if ($WatchCodex) {
    $startupKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
    $startupName = 'CodexCodeCheck'
    $registration = (Get-ItemProperty -LiteralPath $startupKey -Name $startupName -ErrorAction SilentlyContinue).$startupName
    if (-not $registration) { return }
    $configFile = Join-Path $PSScriptRoot 'startup.json'
    try { $config = Get-Content -LiteralPath $configFile -Raw -Encoding UTF8 | ConvertFrom-Json }
    catch { return }
    if (-not $Generation) { $Generation = $config.generation }
    if (-not $Generation -or $config.generation -ne $Generation) { return }
    $watcher = [System.Threading.Mutex]::new($false, 'Local\CodexCodeCheck.StartupWatcher')
    $ownsWatcher = $false
    try {
        try { $ownsWatcher = $watcher.WaitOne(5000) }
        catch [System.Threading.AbandonedMutexException] { $ownsWatcher = $true }
        if (-not $ownsWatcher) { return }
        $seen = [System.Collections.Generic.HashSet[int]]::new()
        if ($SkipProcessId -gt 0) { $null = $seen.Add($SkipProcessId) }
        while ($registration -eq (Get-ItemProperty -LiteralPath $startupKey -Name $startupName -ErrorAction SilentlyContinue).$startupName) {
            try { $current = Get-Content -LiteralPath $configFile -Raw -Encoding UTF8 | ConvertFrom-Json }
            catch { break }
            if ($current.generation -ne $Generation) { break }
            $hostWindow = [CodexReviewDesk.DockProbe]::Read()
            foreach ($seenId in @($seen)) {
                if (-not (Get-Process -Id $seenId -ErrorAction SilentlyContinue)) { $null = $seen.Remove($seenId) }
            }
            if ($hostWindow -and $seen.Add($hostWindow.processId)) {
                try {
                    $arguments = '--codex-startup'
                    if ($config.sourceDirectory) { $arguments = '"' + $config.sourceDirectory + '" ' + $arguments }
                    $launch = @{ FilePath = $config.executable; WindowStyle = 'Normal'; ArgumentList = $arguments }
                    Start-Process @launch
                }
                catch { $null = $seen.Remove($hostWindow.processId) }
            }
            Start-Sleep -Milliseconds 1700
        }
    }
    finally {
        if ($ownsWatcher) { $watcher.ReleaseMutex() }
        $watcher.Dispose()
    }
    return
}

function Write-DockWindow($window) {
    $json = if ($null -eq $window) { 'null' } else { ConvertTo-Json -InputObject $window -Depth 4 -Compress }
    [Console]::WriteLine($json)
}

if ($Once) {
    if ($ParentProcessId -gt 0 -and -not (Get-Process -Id $ParentProcessId -ErrorAction SilentlyContinue)) { return }
    Write-DockWindow ([CodexReviewDesk.DockProbe]::Read())
} else {
    [CodexReviewDesk.DockProbe]::Watch($ParentProcessId, $PollMs, [Action[CodexReviewDesk.WindowInfo]] {
        param($window)
        Write-DockWindow $window
    })
}
