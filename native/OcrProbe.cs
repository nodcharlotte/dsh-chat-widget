// OCR 验证：从 .NET Framework 调 WinRT 的 Windows.Media.Ocr。
// 这是整条「编译路线」里唯一不确定的一环（.NET Framework 调 WinRT 需要 winmd + WindowsRuntime 桥）。
using System;
using System.Drawing;
using System.IO;
using System.Threading.Tasks;
using Windows.Graphics.Imaging;
using Windows.Media.Ocr;
using Windows.Storage.Streams;

internal static class OcrProbe
{
    private static int Main(string[] args)
    {
        string img = args.Length > 0 ? args[0] : "";
        string lang = args.Length > 1 ? args[1] : "zh-Hans-CN";
        if (img.Length == 0 || !File.Exists(img)) { Console.WriteLine("{\"ok\":false,\"error\":\"no-file\"}"); return 1; }

        try
        {
            var task = Run(img, lang);
            task.Wait();
            return task.Result ? 0 : 1;
        }
        catch (Exception e)
        {
            Console.WriteLine("{\"ok\":false,\"error\":\"" + Escape(e.GetType().Name + ": " + e.Message) + "\"}");
            return 1;
        }
    }

    private static async Task<bool> Run(string img, string langTag)
    {
        long t0 = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

        // 1) 本机装了哪些 OCR 语言
        var langs = OcrEngine.AvailableRecognizerLanguages;
        var sb = new System.Text.StringBuilder();
        foreach (var l in langs) { if (sb.Length > 0) sb.Append(","); sb.Append(l.LanguageTag); }
        Console.WriteLine("{\"langs\":\"" + sb + "\"}");

        // 2) 选语言（找不到就退回第一个可用的）
        OcrEngine engine = null;
        foreach (var l in langs) if (string.Equals(l.LanguageTag, langTag, StringComparison.OrdinalIgnoreCase)) { engine = OcrEngine.TryCreateFromLanguage(l); break; }
        if (engine == null && langs.Count > 0) engine = OcrEngine.TryCreateFromUserProfileLanguages();
        if (engine == null) { Console.WriteLine("{\"ok\":false,\"error\":\"no-engine\"}"); return false; }

        // 3) 读图 → SoftwareBitmap
        SoftwareBitmap bitmap;
        using (var stream = new InMemoryRandomAccessStream())
        {
            using (var fs = File.OpenRead(img))
            {
                await fs.CopyToAsync(stream.AsStreamForWrite());
            }
            stream.Seek(0);
            var decoder = await BitmapDecoder.CreateAsync(stream);
            bitmap = await decoder.GetSoftwareBitmapAsync();
        }

        // 4) 识别
        var result = await engine.RecognizeAsync(bitmap);
        var lines = new System.Text.StringBuilder();
        int count = 0;
        foreach (var line in result.Lines)
        {
            if (count > 0) lines.Append(" | ");
            lines.Append(line.Text);
            count++;
        }
        long ms = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - t0;
        Console.WriteLine("{\"ok\":true,\"ms\":" + ms + ",\"lines\":" + count + ",\"text\":\"" + Escape(lines.ToString()) + "\"}");
        return true;
    }

    private static string Escape(string s)
    {
        if (s == null) return "";
        return s.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\r", " ").Replace("\n", " ");
    }
}