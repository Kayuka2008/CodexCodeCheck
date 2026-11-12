param(
    [switch] $Once,
    [ValidateRange(200, 3000)] [int] $PollMs = 550,
    [int] $ParentProcessId = 0
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
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
        public bool foreground;
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
        [DllImport("dwmapi.dll")] private static extern int DwmGetWindowAttribute(IntPtr window, int attribute, out Rect value, int size);
        [DllImport("dwmapi.dll")] private static extern int DwmGetWindowAttribute(IntPtr window, int attribute, out uint value, int size);
        [DllImport("kernel32.dll")] private static extern IntPtr OpenProcess(uint access, bool inherit, uint processId);
        [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] private static extern bool QueryFullProcessImageName(IntPtr process, int flags, StringBuilder name, ref uint size);

        private static readonly Dictionary<uint, bool> hostCache = new Dictionary<uint, bool>();
        private static DateTime nextCacheReset = DateTime.MinValue;
        private static string lastSelectedHandle = null;

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

        // Returns physical desktop coordinates. The Electron caller converts them to DIP.
        public static WindowInfo Read()
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
                WindowInfo first = null, previous = null, focused = null;
                EnumWindows(delegate (IntPtr window, IntPtr param)
                {
                    if (!IsWindowVisible(window) || IsIconic(window) || GetWindow(window, 4) != IntPtr.Zero || !IsChromiumWindow(window)) return true;
                    uint processId;
                    GetWindowThreadProcessId(window, out processId);
                    if (processId == 0 || !IsCodexHost(processId)) return true;
                    uint cloaked;
                    if (DwmGetWindowAttribute(window, 14, out cloaked, sizeof(uint)) == 0 && cloaked != 0) return true;

                    Rect rect;
                    if (DwmGetWindowAttribute(window, 9, out rect, Marshal.SizeOf(typeof(Rect))) != 0 && !GetWindowRect(window, out rect)) return true;
                    int width = rect.Right - rect.Left, height = rect.Bottom - rect.Top;
                    if (width < 320 || height < 220) return true;
                    StringBuilder title = new StringBuilder(512);
                    if (GetWindowText(window, title, title.Capacity) == 0) return true;

                    WindowInfo candidate = new WindowInfo
                    {
                        bounds = new Bounds { x = rect.Left, y = rect.Top, width = width, height = height },
                        title = title.ToString(),
                        foreground = window == foreground || window == foregroundOwner,
                        handle = window.ToInt64().ToString(CultureInfo.InvariantCulture),
                        processId = processId,
                        dpi = GetDpiForWindow(window)
                    };
                    if (candidate.foreground) { focused = candidate; return false; }
                    if (candidate.handle == lastSelectedHandle) previous = candidate;
                    if (first == null) first = candidate;
                    return true;
                }, IntPtr.Zero);
                WindowInfo selected = focused ?? previous ?? first;
                lastSelectedHandle = selected == null ? null : selected.handle;
                return selected;
            }
            finally
            {
                if (oldDpiContext != IntPtr.Zero) SetThreadDpiAwarenessContext(oldDpiContext);
            }
        }
    }
}
'@

$parentProcess = $null
if ($ParentProcessId -gt 0) {
    try { $parentProcess = [System.Diagnostics.Process]::GetProcessById($ParentProcessId) }
    catch [System.ArgumentException] { return }
}

try {
    $previous = ''
    do {
        if ($parentProcess -and $parentProcess.HasExited) { break }
        $window = [CodexReviewDesk.DockProbe]::Read()
        $json = if ($null -eq $window) { 'null' } else { ConvertTo-Json -InputObject $window -Depth 4 -Compress }
        if ($json -ne $previous) {
            [Console]::WriteLine($json)
            $previous = $json
        }
        if (-not $Once) { Start-Sleep -Milliseconds $PollMs }
    } while (-not $Once)
}
finally {
    if ($parentProcess) { $parentProcess.Dispose() }
}
