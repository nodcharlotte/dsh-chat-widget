using System.IO;
using System.Threading;

using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Threading;

// WASAPI loopback capture, self contained: COM interop only (no DllImport anywhere),
// channel mixdown to mono, box-filter resample to 16 kHz, framing to fixed size PCM16 frames.
public class DshCwLoopback
{
  // ---- WASAPI COM declarations -------------------------------------------------
  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
  private class MMDeviceEnumeratorComObject { }

  [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  private interface IMMDeviceEnumerator
  {
    int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr devices);
    int GetDefaultAudioEndpoint(int dataFlow, int role, [MarshalAs(UnmanagedType.Interface)] out IMMDevice device);
    int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, [MarshalAs(UnmanagedType.Interface)] out IMMDevice device);
    int RegisterEndpointNotificationCallback(IntPtr client);
    int UnregisterEndpointNotificationCallback(IntPtr client);
  }

  [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  private interface IMMDevice
  {
    int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
    int OpenPropertyStore(int access, [MarshalAs(UnmanagedType.Interface)] out IPropertyStore store);
    int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
    int GetState(out int state);
  }

  [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  private interface IPropertyStore
  {
    int GetCount(out int count);
    int GetAt(int index, out PROPERTYKEY key);
    int GetValue(ref PROPERTYKEY key, out PROPVARIANT value);
    int SetValue(ref PROPERTYKEY key, ref PROPVARIANT value);
    int Commit();
  }

  [ComImport, Guid("1CB9AD4C-DBFA-4C32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  private interface IAudioClient
  {
    int Initialize(int shareMode, int streamFlags, long bufferDuration, long periodicity, IntPtr format, IntPtr sessionGuid);
    int GetBufferSize(out uint bufferFrames);
    int GetStreamLatency(out long latency);
    int GetCurrentPadding(out uint paddingFrames);
    int IsFormatSupported(int shareMode, IntPtr format, out IntPtr closestMatch);
    int GetMixFormat(out IntPtr deviceFormat);
    int GetDevicePeriod(out long defaultPeriod, out long minimumPeriod);
    int Start();
    int Stop();
    int Reset();
    int SetEventHandle(IntPtr eventHandle);
    int GetService(ref Guid riid, [MarshalAs(UnmanagedType.IUnknown)] out object service);
  }

  [ComImport, Guid("C8ADBD64-E71E-48A0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  private interface IAudioCaptureClient
  {
    int GetBuffer(out IntPtr data, out uint frames, out uint flags, out ulong devicePosition, out ulong qpcPosition);
    int ReleaseBuffer(uint frames);
    int GetNextPacketSize(out uint frames);
  }

  // ---- process loopback activation (Win10 20348+ / Win11) -----------------------
  // VAD\Process_Loopback has no COM entry point: ActivateAudioInterfaceAsync is a flat
  // export of Mmdevapi.dll (the single DllImport of this engine, see the file header).
  // The completion handler MUST expose IAgileObject explicitly: StandardOleMarshalObject
  // alone still fails QI(IAgileObject) and activation dies with E_ILLEGAL_METHOD_CALL
  // (0x8000000E). All new COM methods carry [PreserveSig] so failures come back as
  // HRESULTs instead of thrown/crashing.
  [ComImport, Guid("94EA2B94-E9CC-49E0-C0FF-EE64CA8F5B90"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IAgileObject { }

  [ComImport, Guid("72A22D78-CDE4-431D-B8CC-843A71199B6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IActivateAudioInterfaceAsyncOperation
  {
    [PreserveSig] int GetActivateResult(out int activateResult, out IntPtr activatedInterface);
  }

  [ComImport, Guid("41D949AB-9862-444A-80F6-C261334DA5EB"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IActivateAudioInterfaceCompletionHandler
  {
    [PreserveSig] int ActivateCompleted(IActivateAudioInterfaceAsyncOperation operation);
  }

  [DllImport("Mmdevapi.dll", ExactSpelling = true, PreserveSig = true)]
  private static extern int ActivateAudioInterfaceAsync(
    [MarshalAs(UnmanagedType.LPWStr)] string deviceInterfacePath,
    ref Guid riid,
    IntPtr activationParams,
    IActivateAudioInterfaceCompletionHandler completionHandler,
    out IActivateAudioInterfaceAsyncOperation operation);

  [ComVisible(true)]
  public class ActivationHandler : StandardOleMarshalObject, IActivateAudioInterfaceCompletionHandler, IAgileObject
  {
    public ManualResetEvent Done = new ManualResetEvent(false);
    public int Result = unchecked((int)0x80004005);
    public IntPtr Pointer = IntPtr.Zero;

    public int ActivateCompleted(IActivateAudioInterfaceAsyncOperation operation)
    {
      try
      {
        int result;
        IntPtr pointer;
        int hr = operation.GetActivateResult(out result, out pointer);
        if (hr < 0)
        {
          this.Result = hr;
        }
        else
        {
          this.Result = result;
          this.Pointer = pointer;
        }
      }
      catch (Exception ex)
      {
        this.Result = ex.HResult;
      }
      this.Done.Set();
      return 0;
    }
  }

  [StructLayout(LayoutKind.Sequential, Pack = 2)]
  private struct WAVEFORMATEX
  {
    public ushort wFormatTag;
    public ushort nChannels;
    public uint nSamplesPerSec;
    public uint nAvgBytesPerSec;
    public ushort nBlockAlign;
    public ushort wBitsPerSample;
    public ushort cbSize;
  }

  [StructLayout(LayoutKind.Sequential, Pack = 4)]
  private struct PROPERTYKEY
  {
    public Guid fmtid;
    public int pid;
  }

  // Only the leading fields matter for us: vt + the union's first pointer.
  [StructLayout(LayoutKind.Sequential)]
  private struct PROPVARIANT
  {
    public short vt;
    public short reserved1;
    public short reserved2;
    public short reserved3;
    public IntPtr pointer;
    public int tail;
  }

  private const int E_RENDER = 0;
  private const int E_CONSOLE = 0;
  private const int SHARED = 0;
  private const int STREAMFLAGS_LOOPBACK = 0x00020000;
  private const int BUFFERFLAGS_SILENT = 0x2;
  private const int CLSCTX_ALL = 23;
  private const int STGM_READ = 0;
  private const int VT_LPWSTR = 31;
  private const int FORMAT_PCM = 1;
  private const int FORMAT_FLOAT = 3;
  private const int FORMAT_EXTENSIBLE = 0xFFFE;
  private const int OUT_RATE = 16000;

  private static readonly Guid SUBTYPE_PCM = new Guid("00000001-0000-0010-8000-00aa00389b71");
  private static readonly Guid SUBTYPE_IEEE_FLOAT = new Guid("00000003-0000-0010-8000-00aa00389b71");
  private static readonly Guid FMTID_DEVICE = new Guid("a45c254e-df1c-4efd-8020-67d146a850e0");

  private IMMDeviceEnumerator enumerator;
  private IMMDevice device;
  private IAudioClient audio;
  private IAudioCaptureClient capture;
  private bool excluding;
  private string fallback = "";
  private string failStage = "activate";
  private int targetPid;
  private int rate;
  private int channels;
  private int bits;
  private bool isFloat;
  private string endpointId = "";
  private string deviceName = "";
  private double step;
  private List<float> pending = new List<float>();
  private long pendingBase;
  private long outIndex;
  private List<short> samples = new List<short>();
  private int frameSamples;
  private float[] floatBuf = new float[0];
  private short[] shortBuf = new short[0];
  private int[] intBuf = new int[0];
  private float[] mono = new float[0];

  public int SampleRate { get { return this.rate; } }
  public int Channels { get { return this.channels; } }
  public int BitsPerSample { get { return this.bits; } }
  public string DeviceId { get { return this.endpointId; } }
  public string DeviceName { get { return this.deviceName; } }
  public bool Excluding { get { return this.excluding; } }
  public string Fallback { get { return this.fallback; } }

  private static string Hex(int hr)
  {
    return "0x" + hr.ToString("X8");
  }

  // excludePid > 0 -> try process-tree exclusion first; on ANY failure fall back to the
  // default device and remember why (never throw for the exclude path: capture must live).
  public static DshCwLoopback Open(int frameMs, int excludePid, bool forceExcludeFail)
  {
    DshCwLoopback one = new DshCwLoopback();
    if (excludePid > 0)
    {
      try
      {
        if (forceExcludeFail) { throw new InvalidOperationException("forced exclude failure (self test)"); }
        one.InitProcess(frameMs, excludePid);
        one.excluding = true;
        return one;
      }
      catch (Exception ex)
      {
        one.fallback = one.failStage + "-failed:" + Hex(ex.HResult);
        try { one.Close(); } catch { }
      }
    }
    try { one.InitDefault(frameMs); }
    catch { one.Close(); throw; }
    return one;
  }

  private void InitDefault(int frameMs)
  {
    if (frameMs < 10) { frameMs = 10; }
    this.frameSamples = OUT_RATE * frameMs / 1000;

    this.enumerator = (IMMDeviceEnumerator)(new MMDeviceEnumeratorComObject());
    int hr = this.enumerator.GetDefaultAudioEndpoint(E_RENDER, E_CONSOLE, out this.device);
    if (hr < 0) { throw new COMException("GetDefaultAudioEndpoint", hr); }

    try { this.device.GetId(out this.endpointId); } catch { this.endpointId = ""; }
    if (this.endpointId == null) { this.endpointId = ""; }
    try { this.deviceName = this.ReadFriendlyName(); } catch { this.deviceName = ""; }

    Guid clientIid = typeof(IAudioClient).GUID;
    object boxed;
    hr = this.device.Activate(ref clientIid, CLSCTX_ALL, IntPtr.Zero, out boxed);
    if (hr < 0) { throw new COMException("Activate(IAudioClient)", hr); }
    this.audio = (IAudioClient)boxed;

    IntPtr format = IntPtr.Zero;
    hr = this.audio.GetMixFormat(out format);
    if (hr < 0) { throw new COMException("GetMixFormat", hr); }
    try
    {
      WAVEFORMATEX wf = (WAVEFORMATEX)Marshal.PtrToStructure(format, typeof(WAVEFORMATEX));
      this.rate = (int)wf.nSamplesPerSec;
      this.channels = (int)wf.nChannels;
      this.bits = (int)wf.wBitsPerSample;
      this.isFloat = wf.wFormatTag == FORMAT_FLOAT;
      if (wf.wFormatTag == FORMAT_EXTENSIBLE && wf.cbSize >= 22)
      {
        // WAVEFORMATEXTENSIBLE: SubFormat sits at offset 24 (18 + wValidBits + dwChannelMask).
        Guid sub = (Guid)Marshal.PtrToStructure(new IntPtr(format.ToInt64() + 24), typeof(Guid));
        this.isFloat = sub == SUBTYPE_IEEE_FLOAT;
        if (sub != SUBTYPE_IEEE_FLOAT && sub != SUBTYPE_PCM)
        {
          throw new InvalidOperationException("unsupported mix subformat " + sub.ToString());
        }
      }
      if (this.rate < OUT_RATE) { throw new InvalidOperationException("mix rate " + this.rate + " below " + OUT_RATE); }
      if (this.channels < 1 || this.channels > 8) { throw new InvalidOperationException("unsupported channels " + this.channels); }
      if (this.isFloat && this.bits != 32) { throw new InvalidOperationException("unsupported float bits " + this.bits); }
      if (!this.isFloat && this.bits != 16 && this.bits != 32) { throw new InvalidOperationException("unsupported pcm bits " + this.bits); }
      this.step = (double)this.rate / (double)OUT_RATE;

      // Loopback: shared mode + LOOPBACK flag, format MUST be the device mix format.
      hr = this.audio.Initialize(SHARED, STREAMFLAGS_LOOPBACK, 0, 0, format, IntPtr.Zero);
      if (hr < 0) { throw new COMException("Initialize(loopback)", hr); }
    }
    finally
    {
      Marshal.FreeCoTaskMem(format);
    }

    Guid captureIid = typeof(IAudioCaptureClient).GUID;
    object service;
    hr = this.audio.GetService(ref captureIid, out service);
    if (hr < 0) { throw new COMException("GetService(IAudioCaptureClient)", hr); }
    this.capture = (IAudioCaptureClient)service;

    hr = this.audio.Start();
    if (hr < 0) { throw new COMException("Start", hr); }
  }

  // Process-loopback path: exclude the target process tree, keep everything else.
  // Notes that cost real time (see PLAN-pet.md 3.2):
  //   - AUDIOCLIENT_ACTIVATION_PARAMS is 12 bytes: activationType=1, targetPid, mode(1=exclude).
  //   - the PROPVARIANT must be hand built as 24 bytes (vt=VT_BLOB=65, blob.cbSize=12 @8,
  //     blob.pBlobData @16); letting the marshaller build it does not work here.
  //   - GetMixFormat returns E_NOTIMPL for this virtual device, so declare the format
  //     ourselves (48 kHz / 2 ch / 16 bit PCM, verified working).
  //   - Initialize still needs AUDCLNT_STREAMFLAGS_LOOPBACK.
  //   - the activation callback runs on an MTA thread; the engine runs under -MTA so the
  //     resulting interface can be used from the main loop without COM marshalling.
  private void InitProcess(int frameMs, int targetPid)
  {
    if (frameMs < 10) { frameMs = 10; }
    this.frameSamples = OUT_RATE * frameMs / 1000;
    this.targetPid = targetPid;
    this.failStage = "activate";

    IntPtr blob = Marshal.AllocHGlobal(12);
    IntPtr prop = Marshal.AllocHGlobal(24);
    IntPtr raw = IntPtr.Zero;
    try
    {
      for (int i = 0; i < 24; i++) { Marshal.WriteByte(prop, i, 0); }
      Marshal.WriteInt32(blob, 0, 1);       // AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK
      Marshal.WriteInt32(blob, 4, targetPid);
      Marshal.WriteInt32(blob, 8, 1);       // PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE
      Marshal.WriteInt16(prop, 0, 65);      // VT_BLOB
      Marshal.WriteInt32(prop, 8, 12);      // blob.cbSize
      Marshal.WriteIntPtr(prop, 16, blob);  // blob.pBlobData

      Guid clientIid = typeof(IAudioClient).GUID;
      ActivationHandler handler = new ActivationHandler();
      IActivateAudioInterfaceAsyncOperation operation;
      int hr = ActivateAudioInterfaceAsync("VAD\\Process_Loopback", ref clientIid, prop, handler, out operation);
      if (hr < 0) { throw new COMException("ActivateAudioInterfaceAsync", hr); }
      if (!handler.Done.WaitOne(8000)) { throw new COMException("ActivateAudioInterfaceAsync(timeout)", unchecked((int)0x800705B4)); }
      if (handler.Result < 0) { throw new COMException("GetActivateResult", handler.Result); }
      if (handler.Pointer == IntPtr.Zero) { throw new COMException("GetActivateResult(null)", unchecked((int)0x80004005)); }

      hr = Marshal.QueryInterface(handler.Pointer, ref clientIid, out raw);
      if (hr < 0) { throw new COMException("QueryInterface(IAudioClient)", hr); }
      try { this.audio = (IAudioClient)Marshal.GetObjectForIUnknown(raw); }
      finally { Marshal.Release(raw); raw = IntPtr.Zero; }
      Marshal.Release(handler.Pointer);
      handler.Pointer = IntPtr.Zero;

      this.rate = 48000;
      this.channels = 2;
      this.bits = 16;
      this.isFloat = false;
      this.step = (double)this.rate / (double)OUT_RATE;
      this.endpointId = "process-loopback-exclude:" + targetPid;
      this.deviceName = "Process loopback (exclude pid " + targetPid + ")";

      this.failStage = "init";
      WAVEFORMATEX wf = new WAVEFORMATEX();
      wf.wFormatTag = FORMAT_PCM;
      wf.nChannels = 2;
      wf.nSamplesPerSec = 48000;
      wf.wBitsPerSample = 16;
      wf.nBlockAlign = 4;
      wf.nAvgBytesPerSec = 192000;
      wf.cbSize = 0;
      IntPtr format = Marshal.AllocCoTaskMem(Marshal.SizeOf(typeof(WAVEFORMATEX)));
      try
      {
        Marshal.StructureToPtr(wf, format, false);
        hr = this.audio.Initialize(SHARED, STREAMFLAGS_LOOPBACK, 0, 0, format, IntPtr.Zero);
        if (hr < 0) { throw new COMException("Initialize(process loopback)", hr); }
      }
      finally { Marshal.FreeCoTaskMem(format); }

      this.failStage = "service";
      Guid captureIid = typeof(IAudioCaptureClient).GUID;
      object service;
      hr = this.audio.GetService(ref captureIid, out service);
      if (hr < 0) { throw new COMException("GetService(IAudioCaptureClient)", hr); }
      this.capture = (IAudioCaptureClient)service;

      hr = this.audio.Start();
      if (hr < 0) { throw new COMException("Start", hr); }
    }
    finally
    {
      if (raw != IntPtr.Zero) { Marshal.Release(raw); }
      Marshal.FreeHGlobal(prop);
      Marshal.FreeHGlobal(blob);
    }
  }

  private string ReadFriendlyName()
  {
    IPropertyStore store;
    int hr = this.device.OpenPropertyStore(STGM_READ, out store);
    if (hr < 0) { throw new COMException("OpenPropertyStore", hr); }
    PROPERTYKEY key = new PROPERTYKEY();
    key.fmtid = FMTID_DEVICE;
    key.pid = 14; // PKEY_Device_FriendlyName
    PROPVARIANT value;
    hr = store.GetValue(ref key, out value);
    if (hr < 0) { throw new COMException("GetValue", hr); }
    if (value.vt != VT_LPWSTR || value.pointer == IntPtr.Zero) { return ""; }
    return Marshal.PtrToStringUni(value.pointer);
  }

  // Blocks until one full frame of 16 kHz mono PCM16 is ready; null on timeout.
  public byte[] ReadFrame(int timeoutMs)
  {
    if (this.capture == null) { throw new InvalidOperationException("capture client is not open"); }
    if (timeoutMs < 1) { timeoutMs = 1; }
    System.Diagnostics.Stopwatch clock = System.Diagnostics.Stopwatch.StartNew();
    while (true)
    {
      this.Drain();
      if (this.samples.Count >= this.frameSamples)
      {
        byte[] frame = new byte[this.frameSamples * 2];
        for (int i = 0; i < this.frameSamples; i++)
        {
          short s = this.samples[i];
          frame[i * 2] = (byte)(s & 0xFF);
          frame[i * 2 + 1] = (byte)((s >> 8) & 0xFF);
        }
        this.samples.RemoveRange(0, this.frameSamples);
        return frame;
      }
      if (clock.ElapsedMilliseconds >= timeoutMs) { return null; }
      Thread.Sleep(2);
    }
  }

  // Pull every packet the endpoint currently has.
  private void Drain()
  {
    uint available = 0;
    int hr = this.capture.GetNextPacketSize(out available);
    if (hr < 0) { throw new COMException("GetNextPacketSize", hr); }
    while (available > 0)
    {
      IntPtr data;
      uint frames;
      uint flags;
      ulong devicePosition;
      ulong qpcPosition;
      hr = this.capture.GetBuffer(out data, out frames, out flags, out devicePosition, out qpcPosition);
      if (hr < 0) { throw new COMException("GetBuffer", hr); }
      if (frames > 0)
      {
        bool silent = (flags & BUFFERFLAGS_SILENT) != 0 || data == IntPtr.Zero;
        this.Append(data, (int)frames, silent);
      }
      hr = this.capture.ReleaseBuffer(frames);
      if (hr < 0) { throw new COMException("ReleaseBuffer", hr); }
      hr = this.capture.GetNextPacketSize(out available);
      if (hr < 0) { throw new COMException("GetNextPacketSize", hr); }
    }
  }

  private void Append(IntPtr data, int frames, bool silent)
  {
    int ch = this.channels;
    int total = frames * ch;
    if (this.mono.Length < frames) { this.mono = new float[frames]; }

    if (silent)
    {
      for (int i = 0; i < frames; i++) { this.mono[i] = 0f; }
    }
    else if (this.isFloat)
    {
      if (this.floatBuf.Length < total) { this.floatBuf = new float[total]; }
      Marshal.Copy(data, this.floatBuf, 0, total);
      for (int i = 0; i < frames; i++)
      {
        float sum = 0f;
        int at = i * ch;
        for (int c = 0; c < ch; c++) { sum += this.floatBuf[at + c]; }
        this.mono[i] = sum / ch;
      }
    }
    else if (this.bits == 16)
    {
      if (this.shortBuf.Length < total) { this.shortBuf = new short[total]; }
      Marshal.Copy(data, this.shortBuf, 0, total);
      for (int i = 0; i < frames; i++)
      {
        float sum = 0f;
        int at = i * ch;
        for (int c = 0; c < ch; c++) { sum += this.shortBuf[at + c] / 32768f; }
        this.mono[i] = sum / ch;
      }
    }
    else
    {
      if (this.intBuf.Length < total) { this.intBuf = new int[total]; }
      Marshal.Copy(data, this.intBuf, 0, total);
      for (int i = 0; i < frames; i++)
      {
        float sum = 0f;
        int at = i * ch;
        for (int c = 0; c < ch; c++) { sum += (float)(this.intBuf[at + c] / 2147483648.0); }
        this.mono[i] = sum / ch;
      }
    }
    this.Resample(frames);
  }

  // Box-filter resample: output sample k averages the input samples inside [k*step, (k+1)*step).
  private void Resample(int frames)
  {
    for (int i = 0; i < frames; i++) { this.pending.Add(this.mono[i]); }
    while (true)
    {
      double lo = this.outIndex * this.step;
      double hi = (this.outIndex + 1) * this.step;
      long loIndex = (long)Math.Ceiling(lo - 1e-9);
      long hiIndex = (long)Math.Floor(hi + 1e-9);
      if (hiIndex <= loIndex) { hiIndex = loIndex + 1; }
      if (this.pendingBase + this.pending.Count < hiIndex) { break; }
      long from = loIndex - this.pendingBase;
      if (from < 0) { from = 0; }
      long to = hiIndex - this.pendingBase;
      if (to > this.pending.Count) { to = this.pending.Count; }
      float sum = 0f;
      for (long j = from; j < to; j++) { sum += this.pending[(int)j]; }
      float value = sum / (float)(to - from);
      if (value > 1f) { value = 1f; }
      if (value < -1f) { value = -1f; }
      this.samples.Add((short)Math.Round(value * 32767.0));
      this.outIndex++;
    }
    long dropTo = (long)Math.Floor(this.outIndex * this.step);
    long dropCount = dropTo - this.pendingBase;
    if (dropCount > 0)
    {
      int take = dropCount > this.pending.Count ? this.pending.Count : (int)dropCount;
      this.pending.RemoveRange(0, take);
      this.pendingBase += take;
    }
  }

  public void Close()
  {
    if (this.audio != null)
    {
      try { this.audio.Stop(); } catch { }
      if (this.capture != null)
      {
        try { Marshal.ReleaseComObject(this.capture); } catch { }
        this.capture = null;
      }
      try { Marshal.ReleaseComObject(this.audio); } catch { }
      this.audio = null;
    }
    if (this.device != null)
    {
      try { Marshal.ReleaseComObject(this.device); } catch { }
      this.device = null;
    }
    if (this.enumerator != null)
    {
      try { Marshal.ReleaseComObject(this.enumerator); } catch { }
      this.enumerator = null;
    }
    this.pending.Clear();
    this.samples.Clear();
  }
}

// 编译版入口：把 PS 里的那圈编排搬到 C#，输出协议保持不变（一行一个 JSON）。
internal static class Program
{
    private static volatile bool stopping;

    [MTAThread]
    private static int Main(string[] args)
    {
        int frameMs = 100;
        int readTimeoutMs = 1000;
        int idleSleepMs = 200;
        string requestPath = "";
        int parentPid = 0;

        for (int i = 0; i + 1 < args.Length; i += 2)
        {
            switch (args[i])
            {
                case "-FrameMs": frameMs = int.Parse(args[i + 1]); break;
                case "-ReadTimeoutMs": readTimeoutMs = int.Parse(args[i + 1]); break;
                case "-IdleSleepMs": idleSleepMs = int.Parse(args[i + 1]); break;
                case "-Request": requestPath = args[i + 1]; break;
                case "-ParentPid": parentPid = int.Parse(args[i + 1]); break;
            }
        }
        Console.CancelKeyPress += (s, e) => { e.Cancel = true; stopping = true; };

        string mode = requestPath.Length > 0 ? "off" : "on";
        int excludePid = 0;
        bool forceExcludeFail = false;
        DshCwLoopback client = null;
        long seq = 0;

        while (!stopping)
        {
            if (parentPid > 0 && (seq % 50) == 0)
            {
                try { System.Diagnostics.Process.GetProcessById(parentPid); }
                catch { break; }
            }

            // 读请求文件（模式 / 排除 pid）——和 PS 版一致：只在文件变化时重开流
            if (requestPath.Length > 0)
            {
                try
                {
                    if (File.Exists(requestPath))
                    {
                        string raw = File.ReadAllText(requestPath);
                        string m = Grab(raw, "mode");
                        string pidRaw = Grab(raw, "excludePid");
                        int pid = int.Parse(pidRaw.Length > 0 ? pidRaw : "0");
                        bool force = Grab(raw, "forceExcludeFail").Trim().ToLowerInvariant() == "true";
                        if (m.Length > 0) mode = m.ToLowerInvariant();
                        if (pid != excludePid || force != forceExcludeFail)
                        {
                            if (client != null) { try { client.Close(); } catch { } client = null; }
                            excludePid = pid;
                            forceExcludeFail = force;
                        }
                    }
                    else { mode = "off"; }
                }
                catch { mode = "off"; }
            }

            if (mode == "off")
            {
                if (client != null) { try { client.Close(); } catch { } client = null; }
                Thread.Sleep(idleSleepMs);
                continue;
            }

            if (client == null)
            {
                try { client = DshCwLoopback.Open(frameMs, excludePid, forceExcludeFail); }
                catch (Exception ex)
                {
                    Console.Error.WriteLine("open-failed: " + ex.Message);
                    Thread.Sleep(1000);
                    continue;
                }
                WriteLine("{\"ready\":true,\"device\":\"" + Esc(client.DeviceName) + "\",\"endpoint\":\"" + Esc(client.DeviceId)
                    + "\",\"sampleRate\":" + client.SampleRate + ",\"channels\":" + client.Channels + ",\"bits\":" + client.BitsPerSample
                    + ",\"frameMs\":" + frameMs + ",\"exclude\":" + (client.Excluding ? "true" : "false")
                    + ",\"excludePid\":" + excludePid + ",\"excludeFallback\":\"" + Esc(client.Fallback) + "\"}");
            }

            byte[] frame = null;
            try { frame = client.ReadFrame(readTimeoutMs); }
            catch (Exception ex)
            {
                Console.Error.WriteLine("read-failed: " + ex.Message);
                try { client.Close(); } catch { }
                client = null;
                Thread.Sleep(500);
                continue;
            }
            if (frame == null) continue;
            if (mode == "mute") continue;

            seq++;
            WriteLine("{\"seq\":" + seq + ",\"ms\":" + frameMs + ",\"at\":" + DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()
                + ",\"pcm\":\"" + Convert.ToBase64String(frame) + "\"}");
        }

        if (client != null) { try { client.Close(); } catch { } }
        return 0;
    }

    private static void WriteLine(string s)
    {
        Console.Out.WriteLine(s);
        Console.Out.Flush();
    }

    private static string Esc(string s)
    {
        if (string.IsNullOrEmpty(s)) return "";
        return s.Replace("\\", "\\\\").Replace("\"", "\\\"");
    }

    /// 从扁平 JSON 里抠出一个字段（请求文件结构固定，不值得引 JSON 库）。
    private static string Grab(string json, string key)
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