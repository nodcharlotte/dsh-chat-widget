// 截图引擎（编译版）：截图 → 涂桌宠 → 缩图去重 → 过门槛存 JPEG + 指纹 → 可选 OCR → 一行 JSON。
//
// OCR 是**条件编译**：定义了 WITH_OCR 才会编进去。
// 原因：WinRT 的 Windows.Media.Ocr 需要契约程序集 Windows.winmd，那个只在 Windows SDK 里。
// 没有 SDK 的机器编出的是"无 OCR 版"，功能少一块但截图照跑（界面据此显示"缺少 Windows SDK"）。
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
#if WITH_OCR
using System.Runtime.InteropServices.WindowsRuntime;
using System.Threading.Tasks;
using Windows.Graphics.Imaging;
using Windows.Media.Ocr;
#endif

internal static class Program
{
    private const int MapW = 128;
    private const int MapH = 72;
    private const int FpSize = 32;

    /// 遮罩模糊的降采样倍数（越大越糊、越快）。
    private const int MASK_BLUR_FACTOR = 14;

    /// 降采样后再叠几层盒子模糊（3 层≈高斯）。
    private const int MASK_BLUR_RADIUS = 2;

    /// 输出图（768 宽）上的降采样倍数。
    private const int MASK_BLUR_FACTOR_OUT = 5;

    /// 输出图上的盒子模糊半径。
    private const int MASK_BLUR_RADIUS_OUT = 2;

    private static int intervalMs = 2000;
    private static double thresholdPct = 0.5;
    private static string outDir = "";
    private static int maxSide = 768;
    private static int quality = 60;
    private static int parentPid = 0;
    private static int guardEvery = 50;
    private static string ocrRequest = "";
    private static string ocrLangs = "zh-Hans-CN";
    private static bool ocrEnabled;
    private static string maskRequest = "";

    private static Rectangle bounds;
    private static byte[] prevMap;
    private static int tick;
    private static int maskX, maskY, maskW, maskH;
    private static long lastMaskTicks = -1;
    private static long lastOcrTicks = -1;
    private static string ocrMode = "off";
    private static int ocrY, ocrH, ocrEvery = 1;
#if WITH_OCR
    /** 每门语言一个识别器（`auto` = 所有已装语言都建）。 */
    private static readonly List<KeyValuePair<string, OcrEngine>> ocrEngines = new List<KeyValuePair<string, OcrEngine>>();
    private static bool ocrBuilt;
#endif

    /// 拼图模式：读请求 JSON（{paths, out, width}）→ 排成 1/2/4 宫格 → 写 JPEG → 输出一行 JSON。
    /// 和原来的 dshcw-compose.ps1 行为一致（黑底、等比、质量 60）。
    private static int ComposeMain(string requestPath)
    {
        try
        {
            string raw = File.ReadAllText(requestPath);
            string[] paths = StrArray(raw, "paths");
            string outPath = Str(raw, "out");
            double widthD = Num(raw, "width");
            int width = widthD > 0 ? (int)widthD : 768;
            if (paths.Length == 0) { Emit("{\"ok\":false,\"error\":\"no-paths\"}"); return 1; }
            if (outPath.Length == 0) { Emit("{\"ok\":false,\"error\":\"no-out\"}"); return 1; }

            var bitmaps = new List<Bitmap>();
            foreach (string path in paths)
            {
                try { bitmaps.Add(new Bitmap(path)); } catch { }
            }
            if (bitmaps.Count == 0) { Emit("{\"ok\":false,\"error\":\"no-bitmaps\"}"); return 1; }

            int cols = bitmaps.Count <= 1 ? 1 : (bitmaps.Count == 2 ? 2 : 2);
            int rows = bitmaps.Count <= 1 ? 1 : (bitmaps.Count == 2 ? 1 : 2);
            int tileW = Math.Max(1, width / cols);
            double ar = (double)bitmaps[0].Height / bitmaps[0].Width;
            int tileH = (int)Math.Round(tileW * ar);
            int canvasW = tileW * cols;
            int canvasH = tileH * rows;

            using (var canvas = new Bitmap(canvasW, canvasH))
            {
                using (var g = Graphics.FromImage(canvas))
                {
                    g.Clear(Color.Black);
                    g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
                    for (int i = 0; i < bitmaps.Count && i < cols * rows; i++)
                    {
                        int cx = (i % cols) * tileW;
                        int cy = (i / cols) * tileH;
                        g.DrawImage(bitmaps[i], cx, cy, tileW, tileH);
                    }
                }
                SaveJpeg(canvas, outPath, 60);
                long bytes = new FileInfo(outPath).Length;
                Emit("{\"ok\":true,\"out\":\"" + Esc(outPath) + "\",\"bytes\":" + bytes + ",\"width\":" + canvasW + ",\"height\":" + canvasH + ",\"tiles\":" + bitmaps.Count + "}");
            }
            foreach (var b in bitmaps) b.Dispose();
            return 0;
        }
        catch (Exception ex)
        {
            Emit("{\"ok\":false,\"error\":\"" + Esc(ex.GetType().Name + ": " + ex.Message) + "\"}");
            return 1;
        }
    }

    /// 取一个字符串数组字段（只处理 ["a","b"] 这种扁平形状）。
    private static string[] StrArray(string json, string key)
    {
        int i = json.IndexOf("\"" + key + "\"", StringComparison.Ordinal);
        if (i < 0) return new string[0];
        int open = json.IndexOf('[', i);
        if (open < 0) return new string[0];
        int close = json.IndexOf(']', open);
        if (close < 0) return new string[0];
        string body = json.Substring(open + 1, close - open - 1);
        var list = new List<string>();
        int p = 0;
        while (p < body.Length)
        {
            int q1 = body.IndexOf('"', p);
            if (q1 < 0) break;
            int q2 = body.IndexOf('"', q1 + 1);
            if (q2 < 0) break;
            string item = body.Substring(q1 + 1, q2 - q1 - 1);
            list.Add(item.Replace("\\\\", "\\").Replace("\\\"", "\""));
            p = q2 + 1;
        }
        return list.ToArray();
    }

    private static int Main(string[] args)
    {
        // 拼图模式：一次性任务，做完就退（不开采集循环）
        if (args.Length >= 2 && args[0] == "-Compose")
        {
            try { Console.OutputEncoding = new UTF8Encoding(false); } catch { }
            return ComposeMain(args[1]);
        }

        // 探测模式：只报"有没有 OCR / 本机装了哪些语言"，报完就退（宿主查语言包用）
        bool probeOnly = false;
        for (int i = 0; i < args.Length; i++) if (args[i] == "-Probe") probeOnly = true;

        for (int i = 0; i + 1 < args.Length; i += 2)
        {
            switch (args[i])
            {
                case "-IntervalMs": intervalMs = int.Parse(args[i + 1], CultureInfo.InvariantCulture); break;
                case "-ThresholdPct": thresholdPct = double.Parse(args[i + 1], CultureInfo.InvariantCulture); break;
                case "-OutDir": outDir = args[i + 1]; break;
                case "-MaxSide": maxSide = int.Parse(args[i + 1], CultureInfo.InvariantCulture); break;
                case "-Quality": quality = int.Parse(args[i + 1], CultureInfo.InvariantCulture); break;
                case "-ParentPid": parentPid = int.Parse(args[i + 1], CultureInfo.InvariantCulture); break;
                case "-GuardEvery": guardEvery = int.Parse(args[i + 1], CultureInfo.InvariantCulture); break;
                case "-OcrRequest": ocrRequest = args[i + 1]; break;
                case "-OcrLangs": ocrLangs = args[i + 1]; break;
                case "-OcrEnabled": ocrEnabled = args[i + 1] == "1"; break;
                case "-MaskRequest": maskRequest = args[i + 1]; break;
            }
        }

        // 必须显式设成 UTF-8：控制台默认代码页（简体中文系统是 GBK）会把 OCR 出来的中文
        // 写成乱码，Node 端按 UTF-8 读回来就是一堆 U+FFFD。
        try { Console.OutputEncoding = new UTF8Encoding(false); } catch { }
        try { Console.InputEncoding = new UTF8Encoding(false); } catch { }

        if (outDir.Length > 0 && !Directory.Exists(outDir)) Directory.CreateDirectory(outDir);
        bounds = System.Windows.Forms.Screen.PrimaryScreen.Bounds;

#if WITH_OCR
        // 本机装了哪些识别器（"ocrLangs"），以及实际要用哪几门（"ocrUsing"）。
        // `-OcrLangs auto` 或空 = **每门已装语言都建一个引擎、都跑一遍**（旧的 PS 版语义），
        // 每行结果带 `lang` 说明是哪门认出来的。
        string langs = "";
        try
        {
            foreach (var l in OcrEngine.AvailableRecognizerLanguages)
            {
                if (langs.Length > 0) langs += ",";
                langs += l.LanguageTag;
            }
        }
        catch { }
        BuildOcrEngines();
        string usingList = "";
        foreach (var pair in ocrEngines)
        {
            if (usingList.Length > 0) usingList += ",";
            usingList += pair.Key;
        }
        Emit("{\"ready\":true,\"ocr\":" + (ocrEngines.Count > 0 ? "true" : "false")
            + ",\"ocrLangs\":\"" + Esc(langs) + "\",\"ocrUsing\":\"" + Esc(usingList)
            + "\",\"screen\":\"" + bounds.Width + "x" + bounds.Height + "\",\"interval\":" + intervalMs + "}");
#else
        Emit("{\"ready\":true,\"ocr\":false,\"ocrLangs\":\"\",\"ocrUsing\":\"\",\"screen\":\"" + bounds.Width + "x" + bounds.Height + "\",\"interval\":" + intervalMs + "}");
#endif

        if (probeOnly) return 0;

        while (true)
        {
            tick++;
            if (parentPid > 0 && guardEvery > 0 && (tick % guardEvery) == 0)
            {
                try { System.Diagnostics.Process.GetProcessById(parentPid); }
                catch { break; }
            }

            long at = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            Bitmap src = null;
            try
            {
                src = new Bitmap(bounds.Width, bounds.Height, PixelFormat.Format32bppArgb);
                using (var grab = Graphics.FromImage(src))
                {
                    grab.CopyFromScreen(bounds.X, bounds.Y, 0, 0, bounds.Size);
                }
                // 模糊必须在 grab 释放之后：GDI+ 里同一张 Bitmap 上的两个 Graphics 各持一份
                // 表面，后建的那个画完会被先建的那个在 Dispose 时覆盖掉（实测：不挪出来就等于没画）。
                UpdateMask();
                if (maskW > 0 && maskH > 0)
                {
                    // 桌宠那块改成**高斯模糊**而不是涂黑：涂黑会在画面里留下一块
                    // 突兀的方块，模型容易把它当成"画面的一部分"去描述（"有个黑框"）。
                    // 模糊只毁掉细节、保留大色块，模型会把它当成景深/失焦，不会特意去说。
                    BlurRegion(src, new Rectangle(maskX, maskY, maskW, maskH), MASK_BLUR_FACTOR, MASK_BLUR_RADIUS);
                }

                byte[] cur = LumaMap(src);
                double pct = prevMap == null ? 100.0 : Pct8(prevMap, cur);
                prevMap = cur;

                string json = "{\"at\":" + at;

                if (pct >= thresholdPct && outDir.Length > 0)
                {
                    double scale = 1.0;
                    if (src.Width > maxSide || src.Height > maxSide)
                        scale = Math.Min((double)maxSide / src.Width, (double)maxSide / src.Height);
                    int w = (int)Math.Round(src.Width * scale);
                    int h = (int)Math.Round(src.Height * scale);
                    using (var dst = new Bitmap(w, h))
                    {
                        using (var g2 = Graphics.FromImage(dst))
                        {
                            g2.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
                            g2.DrawImage(src, 0, 0, w, h);
                        }
                        // 输出图上再糊一次：全分辨率那张的模糊在 DrawImage 缩图时不一定带得过来
                        // （GDI+ 会缓存源表面，实测存出来的 JPEG 仍是清晰的）。这里按同一比例换算，
                        // 保证"送给模型的那张"一定是糊的。
                        if (maskW > 0 && maskH > 0)
                        {
                            BlurRegion(dst,
                                new Rectangle((int)Math.Round(maskX * scale), (int)Math.Round(maskY * scale),
                                              (int)Math.Round(maskW * scale), (int)Math.Round(maskH * scale)),
                                MASK_BLUR_FACTOR_OUT, MASK_BLUR_RADIUS_OUT);
                        }
                        string path = Path.Combine(outDir, "frame-" + at + ".jpg");
                        SaveJpeg(dst, path, quality);
                        long bytes = new FileInfo(path).Length;
                        json += ",\"path\":\"" + Esc(path) + "\",\"pct8\":" + pct.ToString("0.###", CultureInfo.InvariantCulture)
                             + ",\"bytes\":" + bytes + ",\"width\":" + w + ",\"height\":" + h
                             + ",\"fp\":\"" + Fingerprint(src) + "\"";
                    }
                }

                UpdateOcrRequest();
                if (ocrEnabled && ocrMode != "off" && (ocrEvery <= 1 || (tick % ocrEvery) == 0))
                {
                    string ocr = RunOcr(src);
                    if (ocr.Length > 0) json += ",\"ocr\":" + ocr;
                }

                json += "}";
                if (json.IndexOf("\"path\"", StringComparison.Ordinal) >= 0 || json.IndexOf("\"ocr\"", StringComparison.Ordinal) >= 0)
                    Emit(json);
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine("tick-failed: " + ex.Message);
            }
            finally
            {
                if (src != null) src.Dispose();
            }

            Thread.Sleep(intervalMs);
        }
        return 0;
    }

    /// 把一块区域做成**强高斯模糊**（降采样 + 盒子模糊 + 双三次放大）。
    ///
    /// 为什么不用 System.Drawing 的滤镜：GDI+ 没有内置高斯模糊。降采样到 1/14 再放回去
    /// 本身就是极强的高斯核近似，再叠两层小半径盒子模糊把块边界抹匀，肉眼看就是失焦。
    /// 成本：311×647 的区域 ≈ 1.1 ms（实测），可以每帧都做。
    ///
    /// @param src 原图（就地修改）。
    /// @param rect 要模糊的矩形（屏幕像素，会夹到画面内）。
    /// @param factor 降采样倍数（≥4）。
    /// @param radius 盒子模糊半径（0 = 只靠降采样）。
    private static void BlurRegion(Bitmap src, Rectangle rect, int factor, int radius)
    {
        Rectangle r = Rectangle.Intersect(rect, new Rectangle(0, 0, src.Width, src.Height));
        if (r.Width < 8 || r.Height < 8) return;
        int f = Math.Max(4, factor);
        int sw = Math.Max(2, r.Width / f);
        int sh = Math.Max(2, r.Height / f);
        using (var small = new Bitmap(sw, sh, PixelFormat.Format32bppArgb))
        {
            using (var g = Graphics.FromImage(small))
            {
                g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
                g.PixelOffsetMode = System.Drawing.Drawing2D.PixelOffsetMode.HighQuality;
                g.DrawImage(src, new Rectangle(0, 0, sw, sh), r, GraphicsUnit.Pixel);
            }
            if (radius > 0) BoxBlur(small, radius, 2);
            using (var g = Graphics.FromImage(src))
            {
                g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
                g.PixelOffsetMode = System.Drawing.Drawing2D.PixelOffsetMode.HighQuality;
                g.CompositingMode = System.Drawing.Drawing2D.CompositingMode.SourceCopy;
                g.DrawImage(small, r, new Rectangle(0, 0, sw, sh), GraphicsUnit.Pixel);
            }
        }
    }

    /// 可分离盒子模糊（先横后竖，O(n)）。
    ///
    /// @param bmp 就地模糊的位图（小图，几十像素级别）。
    /// @param radius 半径（像素）。
    /// @param passes 叠几遍（2 遍 ≈ 三角核，接近高斯）。
    private static void BoxBlur(Bitmap bmp, int radius, int passes)
    {
        if (radius <= 0) return;
        int w = bmp.Width;
        int h = bmp.Height;
        var data = bmp.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.ReadWrite, PixelFormat.Format32bppArgb);
        try
        {
            int stride = data.Stride;
            var buf = new byte[stride * h];
            Marshal.Copy(data.Scan0, buf, 0, buf.Length);
            var line = new byte[Math.Max(w, h) * 4];
            int span = radius * 2 + 1;

            for (int pass = 0; pass < passes; pass++)
            {
                // 横向
                for (int y = 0; y < h; y++)
                {
                    int row = y * stride;
                    for (int x = 0; x < w; x++)
                    {
                        int b = 0, g = 0, rr = 0;
                        for (int k = -radius; k <= radius; k++)
                        {
                            int xx = x + k;
                            if (xx < 0) xx = 0;
                            if (xx >= w) xx = w - 1;
                            int i = row + xx * 4;
                            b += buf[i];
                            g += buf[i + 1];
                            rr += buf[i + 2];
                        }
                        line[x * 4] = (byte)(b / span);
                        line[x * 4 + 1] = (byte)(g / span);
                        line[x * 4 + 2] = (byte)(rr / span);
                        line[x * 4 + 3] = 255;
                    }
                    for (int x = 0; x < w; x++)
                    {
                        int i = row + x * 4;
                        buf[i] = line[x * 4];
                        buf[i + 1] = line[x * 4 + 1];
                        buf[i + 2] = line[x * 4 + 2];
                    }
                }
                // 纵向
                for (int x = 0; x < w; x++)
                {
                    for (int y = 0; y < h; y++)
                    {
                        int b = 0, g = 0, rr = 0;
                        for (int k = -radius; k <= radius; k++)
                        {
                            int yy = y + k;
                            if (yy < 0) yy = 0;
                            if (yy >= h) yy = h - 1;
                            int i = yy * stride + x * 4;
                            b += buf[i];
                            g += buf[i + 1];
                            rr += buf[i + 2];
                        }
                        line[y * 4] = (byte)(b / span);
                        line[y * 4 + 1] = (byte)(g / span);
                        line[y * 4 + 2] = (byte)(rr / span);
                        line[y * 4 + 3] = 255;
                    }
                    for (int y = 0; y < h; y++)
                    {
                        int i = y * stride + x * 4;
                        buf[i] = line[y * 4];
                        buf[i + 1] = line[y * 4 + 1];
                        buf[i + 2] = line[y * 4 + 2];
                    }
                }
            }
            Marshal.Copy(buf, 0, data.Scan0, buf.Length);
        }
        finally { bmp.UnlockBits(data); }
    }

    /** 按 `-OcrLangs` 建识别器：`auto`/空 = 所有已装语言各建一个。 */
    private static void BuildOcrEngines()
    {
#if WITH_OCR
        if (ocrBuilt) return;
        ocrBuilt = true;
        try
        {
            var wanted = (ocrLangs ?? "").Trim();
            bool all = wanted.Length == 0 || string.Equals(wanted, "auto", StringComparison.OrdinalIgnoreCase);
            var tags = new List<string>();
            if (all)
            {
                foreach (var l in OcrEngine.AvailableRecognizerLanguages) tags.Add(l.LanguageTag);
            }
            else
            {
                foreach (var raw in wanted.Split(','))
                {
                    var tag = raw.Trim();
                    if (tag.Length == 0) continue;
                    tags.Add(tag);
                }
            }
            foreach (var tag in tags)
            {
                foreach (var l in OcrEngine.AvailableRecognizerLanguages)
                {
                    if (string.Equals(l.LanguageTag, tag, StringComparison.OrdinalIgnoreCase) == false) continue;
                    var made = OcrEngine.TryCreateFromLanguage(l);
                    if (made != null) ocrEngines.Add(new KeyValuePair<string, OcrEngine>(l.LanguageTag, made));
                    break;
                }
            }
        }
        catch { }
#endif
    }

    // ── 桌宠遮罩：宿主写 {x,y,w,h}（屏幕占比），这里乘自己的屏幕尺寸 ──
    private static void UpdateMask()
    {
        maskW = 0;
        if (maskRequest.Length == 0 || !File.Exists(maskRequest)) return;
        try
        {
            long ticks = File.GetLastWriteTimeUtc(maskRequest).Ticks;
            if (ticks == lastMaskTicks) return;
            lastMaskTicks = ticks;
            string raw = File.ReadAllText(maskRequest);
            if (raw.Trim().Length == 0) return;
            double fx = Num(raw, "x"), fy = Num(raw, "y"), fw = Num(raw, "w"), fh = Num(raw, "h");
            if (fw <= 0 || fh <= 0) return;
            maskX = (int)Math.Round(fx * bounds.Width);
            maskY = (int)Math.Round(fy * bounds.Height);
            maskW = (int)Math.Round(fw * bounds.Width);
            maskH = (int)Math.Round(fh * bounds.Height);
        }
        catch { maskW = 0; }
    }

    // ── OCR 请求：宿主写 {mode, y, h, every} ──
    private static void UpdateOcrRequest()
    {
        if (ocrRequest.Length == 0 || !File.Exists(ocrRequest)) { ocrMode = "off"; return; }
        try
        {
            long ticks = File.GetLastWriteTimeUtc(ocrRequest).Ticks;
            if (ticks == lastOcrTicks) return;
            lastOcrTicks = ticks;
            string raw = File.ReadAllText(ocrRequest);
            if (raw.Trim().Length == 0) { ocrMode = "off"; return; }
            string mode = Str(raw, "mode");
            ocrMode = mode.Length == 0 ? "off" : mode;
            ocrY = (int)Num(raw, "y");
            ocrH = (int)Num(raw, "h");
            double every = Num(raw, "every");
            ocrEvery = every > 0 ? (int)every : 1;
        }
        catch { ocrMode = "off"; }
    }

    // ── OCR：只认底部条带，坐标换算回整屏 ──
    private static string RunOcr(Bitmap src)
    {
#if WITH_OCR
        if (ocrH <= 0 || ocrY < 0 || ocrY + ocrH > src.Height) return "";
        long t0 = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        try
        {
            BuildOcrEngines();
            // 没有可用识别器就**什么都不发**（和旧 PS 版一致）：就绪行已经报了 `ocr:false`/`ocrUsing` 空，
            // 这里再发一行 error 只会让"指定了一门没装的语言"看起来像"认出了东西"（自检踩过）。
            if (ocrEngines.Count == 0) return "";

            int w = src.Width, h = ocrH;
            byte[] buf;
            using (var band = new Bitmap(w, h, PixelFormat.Format32bppArgb))
            {
                using (var g = Graphics.FromImage(band)) g.DrawImage(src, new Rectangle(0, 0, w, h), new Rectangle(0, ocrY, w, h), GraphicsUnit.Pixel);
                var data = band.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
                try
                {
                    buf = new byte[data.Stride * h];
                    Marshal.Copy(data.Scan0, buf, 0, buf.Length);
                    var sbmp = SoftwareBitmap.CreateCopyFromBuffer(buf.AsBuffer(), BitmapPixelFormat.Bgra8, w, h, BitmapAlphaMode.Premultiplied);
                    var lines = new StringBuilder();
                    int n = 0;
                    foreach (var pair in ocrEngines)
                    {
                    var op = pair.Value.RecognizeAsync(sbmp);
                    op.AsTask().Wait();
                    var result = op.GetResults();
                    foreach (var line in result.Lines)
                    {
                        double lx = double.MaxValue, ly = double.MaxValue, lr = 0, lb = 0;
                        foreach (var word in line.Words)
                        {
                            var r = word.BoundingRect;
                            if (r.X < lx) lx = r.X;
                            if (r.Y < ly) ly = r.Y;
                            if (r.X + r.Width > lr) lr = r.X + r.Width;
                            if (r.Y + r.Height > lb) lb = r.Y + r.Height;
                        }
                        if (lx == double.MaxValue) { lx = 0; ly = 0; lr = 0; lb = 0; }
                        if (n > 0) lines.Append(",");
                        lines.Append("{\"text\":\"").Append(Esc(line.Text)).Append("\",\"x\":").Append((int)lx)
                             .Append(",\"y\":").Append((int)(ly + ocrY)).Append(",\"width\":").Append((int)(lr - lx))
                             .Append(",\"height\":").Append((int)(lb - ly))
                             .Append(",\"lang\":\"").Append(Esc(pair.Key)).Append("\"}");
                        n++;
                    }
                    }
                    long ms = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - t0;
                    return "{\"ok\":true,\"ms\":" + ms + ",\"y\":" + ocrY + ",\"h\":" + ocrH + ",\"w\":" + w + ",\"lines\":[" + lines + "]}";
                }
                finally { band.UnlockBits(data); }
            }
        }
        catch (Exception ex)
        {
            return "{\"ok\":false,\"error\":\"" + Esc(ex.GetType().Name + ": " + ex.Message) + "\",\"y\":" + ocrY + ",\"h\":" + ocrH + "}";
        }
#else
        return "";
#endif
    }

    private static byte[] LumaMap(Bitmap src)
    {
        using (var small = new Bitmap(MapW, MapH))
        {
            using (var g = Graphics.FromImage(small))
            {
                g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
                g.DrawImage(src, 0, 0, MapW, MapH);
            }
            var data = small.LockBits(new Rectangle(0, 0, MapW, MapH), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
            try
            {
                var buf = new byte[data.Stride * MapH];
                Marshal.Copy(data.Scan0, buf, 0, buf.Length);
                var luma = new byte[MapW * MapH];
                for (int y = 0; y < MapH; y++)
                {
                    int row = y * data.Stride;
                    for (int x = 0; x < MapW; x++)
                    {
                        int i = row + x * 4;
                        luma[y * MapW + x] = (byte)Math.Round(0.299 * buf[i + 2] + 0.587 * buf[i + 1] + 0.114 * buf[i]);
                    }
                }
                return luma;
            }
            finally { small.UnlockBits(data); }
        }
    }

    private static double Pct8(byte[] a, byte[] b)
    {
        int changed = 0;
        for (int i = 0; i < b.Length; i++) if (Math.Abs(a[i] - b[i]) >= 8) changed++;
        return Math.Round(100.0 * changed / b.Length, 3);
    }

    private static string Fingerprint(Bitmap src)
    {
        using (var small = new Bitmap(FpSize, FpSize))
        {
            using (var g = Graphics.FromImage(small))
            {
                g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
                g.DrawImage(src, 0, 0, FpSize, FpSize);
            }
            var data = small.LockBits(new Rectangle(0, 0, FpSize, FpSize), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
            try
            {
                var buf = new byte[data.Stride * FpSize];
                Marshal.Copy(data.Scan0, buf, 0, buf.Length);
                var sb = new StringBuilder(FpSize * FpSize * 2);
                for (int y = 0; y < FpSize; y++)
                {
                    int row = y * data.Stride;
                    for (int x = 0; x < FpSize; x++)
                    {
                        int i = row + x * 4;
                        int l = (int)Math.Round(0.299 * buf[i + 2] + 0.587 * buf[i + 1] + 0.114 * buf[i]);
                        sb.Append(l.ToString("x2"));
                    }
                }
                return sb.ToString();
            }
            finally { small.UnlockBits(data); }
        }
    }

    private static void SaveJpeg(Bitmap bmp, string path, int q)
    {
        ImageCodecInfo codec = null;
        foreach (var c in ImageCodecInfo.GetImageEncoders()) if (c.MimeType == "image/jpeg") { codec = c; break; }
        using (var ep = new EncoderParameters(1))
        {
            ep.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, (long)q);
            bmp.Save(path, codec, ep);
        }
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

    private static double Num(string json, string key)
    {
        string v = Str(json, key);
        double d;
        return double.TryParse(v, NumberStyles.Float, CultureInfo.InvariantCulture, out d) ? d : 0;
    }

    /// 从扁平 JSON 里抠一个字段（结构固定，不引 JSON 库）。
    private static string Str(string json, string key)
    {
        int i = json.IndexOf("\"" + key + "\"", StringComparison.Ordinal);
        if (i < 0) return "";
        int colon = json.IndexOf(':', i);
        if (colon < 0) return "";
        int p = colon + 1;
        while (p < json.Length && char.IsWhiteSpace(json[p])) p++;
        if (p >= json.Length) return "";
        if (json[p] == '"')
        {
            int end = json.IndexOf('"', p + 1);
            return end < 0 ? "" : json.Substring(p + 1, end - p - 1);
        }
        int stop = p;
        while (stop < json.Length && json[stop] != ',' && json[stop] != '}' && !char.IsWhiteSpace(json[stop])) stop++;
        return json.Substring(p, stop - p);
    }
}