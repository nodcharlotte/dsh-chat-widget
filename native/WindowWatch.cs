// 前台窗口监测（编译版）：每 IntervalMs 看一次前台窗口，hwnd 或标题变了就报一行 JSON。
//
// 原来是 tools/foreground-watch.ps1（Add-Type 内联 C# + P/Invoke）。改成独立 EXE 的理由
// 和截图/音轨一样：.ps1 在部分机器上被 Defender/AMSI 判成恶意脚本。这里没有脚本了。
//
// 协议（一行一个 JSON，stdout 只有这些）：
//   {"at":<ms>,"hwnd":<int>,"title":"...","pid":<int>,"process":"..."}
//
// 判定"变了"：**hwnd 或标题任一变化**。只看 hwnd 会把"同一窗口切标签页"漏掉（标题变了、句柄没变）。
using System;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

internal static class WindowWatch
{
    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int maxCount);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    private static int Main(string[] args)
    {
        int intervalMs = 200;
        int parentPid = 0;
        int guardEvery = 50;

        for (int i = 0; i + 1 < args.Length; i += 2)
        {
            switch (args[i])
            {
                case "-IntervalMs": intervalMs = int.Parse(args[i + 1], CultureInfo.InvariantCulture); break;
                case "-ParentPid": parentPid = int.Parse(args[i + 1], CultureInfo.InvariantCulture); break;
                case "-GuardEvery": guardEvery = int.Parse(args[i + 1], CultureInfo.InvariantCulture); break;
            }
        }

        try { Console.OutputEncoding = new UTF8Encoding(false); } catch { }

        IntPtr lastHwnd = IntPtr.Zero;
        string lastTitle = null;
        var titleBuffer = new StringBuilder(1024);
        int tick = 0;

        while (true)
        {
            tick++;
            if (parentPid > 0 && guardEvery > 0 && (tick % guardEvery) == 0)
            {
                try { Process.GetProcessById(parentPid); }
                catch { break; }
            }

            try
            {
                IntPtr hwnd = GetForegroundWindow();
                titleBuffer.Clear();
                int len = hwnd == IntPtr.Zero ? 0 : GetWindowTextW(hwnd, titleBuffer, titleBuffer.Capacity);
                string title = len > 0 ? titleBuffer.ToString(0, len) : "";

                bool changed = hwnd != lastHwnd || title != lastTitle;
                if (changed)
                {
                    lastHwnd = hwnd;
                    lastTitle = title;
                    uint pid = 0;
                    if (hwnd != IntPtr.Zero) GetWindowThreadProcessId(hwnd, out pid);
                    string process = "";
                    if (pid > 0)
                    {
                        try { process = Process.GetProcessById((int)pid).ProcessName; }
                        catch { process = ""; }
                    }
                    Emit("{\"at\":" + DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()
                        + ",\"hwnd\":" + hwnd.ToInt64()
                        + ",\"title\":\"" + Esc(title) + "\""
                        + ",\"pid\":" + pid
                        + ",\"process\":\"" + Esc(process) + "\"}");
                }
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine("tick-failed: " + ex.Message);
            }

            Thread.Sleep(intervalMs);
        }
        return 0;
    }

    private static void Emit(string s)
    {
        Console.Out.WriteLine(s);
        Console.Out.Flush();
    }

    private static string Esc(string s)
    {
        if (string.IsNullOrEmpty(s)) return "";
        return s.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\r", " ").Replace("\n", " ");
    }
}