/**
 * @local/chat-widget —— 音轨采集引擎（屏幕陪看的耳朵）。
 *
 * 干什么：常驻一个自己编译的引擎进程（`native/AudioEngine.cs` → `dshcw-audio.exe`），
 * 用 **WASAPI loopback** 抓**扬声器正在放的声音**（不是麦克风），自己混音 + 重采样成
 * **16 kHz 单声道 PCM16**，每 `frameMs`（默认 100 ms = 1600 采样 = 3200 字节）把一帧 PCM
 * 用 base64 塞进**一行 JSON** 发到 stdout。
 *
 * 为什么不用外部程序：用户明确要求**不引入任何第三方包、不调 ffmpeg/python/sox**。
 * 所以采集链路全部由 Windows 自带能力搭：C# 里用 **[ComImport] 声明 WASAPI 的 COM 接口**
 * （`IMMDeviceEnumerator` / `IMMDevice` / `IAudioClient` / `IAudioCaptureClient`）走
 * `AUDCLNT_STREAMFLAGS_LOOPBACK`。注意这里**只允许一个 DllImport**
 * （`Mmdevapi!ActivateAudioInterfaceAsync`：进程级 loopback 没有 COM 入口，只能平调用）；
 * 其余全部是 [ComImport] 纯元数据声明。
 *
 * 两条采集路径（同一个引擎进程，靠请求文件切换，**不重启进程**）：
 *   - `excludePid <= 0`：整机默认设备 loopback（`IMMDeviceEnumerator`，老路径，行为不变）。
 *   - `excludePid > 0`：`ActivateAudioInterfaceAsync(VAD\Process_Loopback, ...)` +
 *     `PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE`，把该 pid 的**整棵进程树**排除
 *     （桌宠 Electron 主进程一传，渲染/GPU 子进程一起排掉），其余声音照收。
 *     激活/初始化失败**自动回退**到默认设备，并在就绪行里带 `exclude:false` +
 *     `excludeFallback:"activate-failed:0x..."`，采集不中断。
 *
 * ⚠ 进程级 loopback 的接口**不能跨套间用**：`ActivateAudioInterfaceAsync` 的完成回调跑在
 * MTA 线程池线程上，若主线程是 STA，之后调 `IAudioClient.Initialize` 会因为跨套间编组失败
 * 报 `E_NOINTERFACE (0x80004002)`（实测：回调里 QI/cast 都成功，回到 STA 主线程再调就失败）。
 * 所以引擎进程**必须用 `-MTA` 启动**（`startAudioCapture` 的 spawn 参数里有），这样主线程
 * 与回调线程同属 MTA，不用编组；默认设备老路径在 MTA 下实测同样正常。
 *
 * 两条硬约束（都是实测踩出来的）：
 *   1. **不落盘音频**：PCM 只在内存里，base64 走 stdout。引擎一行音频都不写磁盘
 *      （要存 WAV 是自检脚本在 Node 侧做）。
 *   2. **绝不给 spawn 加 `detached: true`**：本项目实测 detached 会静默掐死子进程
 *      （拿到 pid、一行不跑、连 error 都不发）。另外 spawn 必须挂 `child.on('error')`——
 *      没有监听者时 spawn 失败能掀掉整个宿主进程。
 *
 * 混音/重采样怎么做的（第 4 条硬性要求，这里写明白）：
 *   - **混音**：多声道直接取算术平均（`sum(ch)/ch`）→ 单声道。人声/影视对白是相关信号，
 *     等权平均就是最省的降混；相位相反的极端情况会互相抵消，实测对白/音乐都不会。
 *   - **重采样**：不做抽取（抽取会把 16 kHz 以上的镜像折回可听带内，ASR 会被滋滋声干扰），
 *     而是**按输出时间轴做盒式平均**：输出第 k 个采样覆盖输入区间 `[k*step, (k+1)*step)`，
 *     取落在区间内的整数输入采样的均值（`step = 设备混音采样率 / 16000`）。
 *     48 kHz → step 恰好是 3，也就是"每 3 个采样的均值"，等价于一个 3 抽头滑动平均，
 *     它在 16 kHz 处正好是零点，对 ASR 关心的 0–8 kHz 通带几乎无衰减；44.1 kHz 这类
 *     非整数比也照样工作（只是区间里采样数在 2/3 之间跳）。没有时钟漂移：区间边界由
 *     全局输入下标算，不用累加器。
 *   - 为什么够用：SenseVoice 这类 ASR 前端只吃 16 kHz 单声道，对幅频响应的要求远低于
 *     听感要求；盒式平均的阻带衰减（约 -13 dB 旁瓣）足以压掉 8 kHz 以上的折叠能量。
 *
 * 运行协议（stderr = 诊断；stdout = 一行一个 JSON）：
 *   - 就绪：`{"ready":true,"device":"...","endpoint":"...","sampleRate":48000,"channels":2,"bits":32,"frameMs":100,
 *     "exclude":false,"excludePid":0,"excludeFallback":""}`
 *     （`exclude` = 真的在排除；`excludeFallback` 非空 = 想排除但失败了、已回退默认设备）
 *   - 每帧：`{"seq":1,"ms":100,"at":<ms>,"pcm":"<base64 16k mono pcm16le>"}`
 *   - 请求文件 `%TEMP%\dshcw-audio.json`：`off` = 释放设备（不采）；`on` = 采；
 *     `mute` = **设备照开着、一帧都不发**（给以后的桌宠 TTS 预留的"略过"）。
 *     `excludePid` > 0 = 走进程级排除路径，0/缺省 = 老路径；该值变了引擎会**关掉旧流、
 *     按新 pid 重新激活**（进程不重启）。`forceExcludeFail:true` 只给自检用（强制走回退分支）。
 *     引擎看 mtime 变了才重读。
 *
 * @module @local/chat-widget/host/audio-capture
 */

import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ensureEngine } from './native-build.js';

/** 请求文件：宿主改"采不采"的**唯一**方式（引擎看 mtime 变了才重读）。 */
export const AUDIO_REQUEST_FILE = 'dshcw-audio.json';

/** 一帧的默认时长（毫秒）。100 ms → 1600 采样 → 3200 字节。 */
export const DEFAULT_FRAME_MS = 100;

/** 目标采样率：ASR 前端只吃 16 kHz 单声道。 */
export const TARGET_RATE = 16000;

/** 每帧的字节数（16 kHz 单声道 PCM16）。 */
export function frameBytes(frameMs) {
  return Math.round((TARGET_RATE * (Number.isFinite(frameMs) ? frameMs : DEFAULT_FRAME_MS)) / 1000) * 2;
}

/** 引擎一行 JSON 的长度上限（3200 字节 base64 ≈ 4.3 KB，留足余量）。 */
const MAX_LINE_CHARS = 65536;

/** 引擎意外退出后多久重拉。 */
const RESTART_DELAY_MS = 3000;

/** 允许的请求模式。 */
const MODES = ['off', 'on', 'mute'];

/**
 * WASAPI loopback 引擎脚本（ASCII-only，见文件头约束 3）。
 *
 * 结构：`param` → `Add-Type` 一段 C#（COM interop + 混音 + 盒式重采样 + 帧切分）→
 * 主循环（读请求文件 → 按模式开/关设备 → `ReadFrame` → 发一行 base64 JSON）。
 */


/**
 * 取音轨引擎的 exe（第一次用时编译，之后复用；约 0.16 秒）。
 *
 * 为什么编译成 exe：以前是运行时往 `%TEMP%` 写 `.ps1`，在部分机器上被 Defender/AMSI
 * 判成恶意脚本。编成 exe 后没有脚本文本。源码见 `native/AudioEngine.cs`。
 *
 * @param {object} [logger] - 日志器。
 * @returns {string} exe 路径；编译失败返回空串。
 */
export function ensureAudioEngine(logger) {
  const built = ensureEngine({ target: 'audio', logger });
  if (built.ok !== true) {
    logger?.warn?.(`chat-widget: 音轨引擎编译失败：${String(built.error ?? '')}`);
    return '';
  }
  return built.exe;
}

export function audioRequestPath() {
  return join(tmpdir(), AUDIO_REQUEST_FILE);
}

/**
 * 把 `excludePid` 归一化成"0 或正整数"：0 = 走默认设备老路径。
 *
 * @param {unknown} value - 外部给的 pid。
 * @returns {number} 0 或正整数。
 */
function normalizeExcludePid(value) {
  const pid = Number(value);
  return Number.isInteger(pid) && pid > 0 ? pid : 0;
}

/**
 * 写请求——宿主改"采不采 / 排不排某进程"的**唯一方式**（引擎看 mtime 变了才重读，进程不重启）。
 *
 * `off` = 释放设备（不采）；`on` = 采；`mute` = 设备照开着、一帧都不发（快速恢复用）。
 * `excludePid > 0` = 进程级排除（桌宠进程树），`0`/缺省 = 默认设备老路径（行为不变）。
 *
 * @param {{mode?: 'off'|'on'|'mute', excludePid?: number, forceExcludeFail?: boolean}} [request]
 *   模式 / 要排除的进程 pid / 自检用的强制回退开关。
 * @returns {string} 写到的路径。
 */
export function writeAudioRequest(request) {
  const path = audioRequestPath();
  const wanted = request !== null && typeof request === 'object' ? request : {};
  const mode = MODES.includes(wanted.mode) ? wanted.mode : 'off';
  const payload = { mode, excludePid: normalizeExcludePid(wanted.excludePid) };
  // 只给自检用：强制进程级排除失败，好把"自动回退默认设备"这条分支真的跑一遍。
  if (wanted.forceExcludeFail === true) payload.forceExcludeFail = true;
  writeFileSync(path, JSON.stringify(payload), 'utf8');
  return path;
}

/**
 * 起一个音轨采集引擎。
 *
 * @param {object} logger - 日志器（cordis logger 或 console）。
 * @param {{onFrame?: (frame: {seq: number, ms: number, at: number, pcm: Uint8Array}) => void,
 *   onReady?: (info: {device: string, endpoint: string, sampleRate: number, channels: number,
 *     frameMs: number, exclude: boolean, excludePid: number, excludeFallback: string}) => void,
 *   onError?: (message: string) => void, frameMs?: number, mode?: 'off'|'on'|'mute',
 *   excludePid?: number}} options
 *   每帧回调 / 就绪回调 / 出错回调、帧长、初始模式、初始排除 pid（0 = 老路径）。
 * @returns {{setMode: (mode: string) => string, setExcludePid: (pid: number) => number,
 *   stop: () => void, status: () => object, enginePid: () => number|null,
 *   requestPath: () => string}} 句柄。
 */
export function startAudioCapture(logger, options = {}) {
  const opts = options !== null && typeof options === 'object' ? options : {};
  const frameMs = Number.isFinite(opts.frameMs) && opts.frameMs >= 20 ? Math.round(opts.frameMs) : DEFAULT_FRAME_MS;
  const onFrame = typeof opts.onFrame === 'function' ? opts.onFrame : () => {};
  const onReady = typeof opts.onReady === 'function' ? opts.onReady : () => {};
  const onError = typeof opts.onError === 'function' ? opts.onError : () => {};
  const supported = process.platform === 'win32';
  /** 编译好的 exe 路径（第一次启动时才编）。 */
  let enginePath = '';
  let mode = MODES.includes(opts.mode) ? opts.mode : 'on';
  let excludePid = normalizeExcludePid(opts.excludePid);

  const stats = {
    ready: false,
    device: '',
    endpoint: '',
    sampleRate: 0,
    channels: 0,
    frames: 0,
    bytes: 0,
    lastFrameAt: null,
    errors: 0,
    restarts: 0,
    lastError: '',
    // 引擎**回报**的排除状态（不是宿主一厢情愿的意图）：ready 行里带什么就是什么。
    excludePid,
    excludeActive: false,
    excludeFallback: '',
  };
  let child = null;
  let stopped = false;
  let restartTimer = null;
  let announced = false;

  /** 报一次错（回调和计数一起）。 */
  function fail(message) {
    const text = String(message).slice(0, 300);
    stats.errors += 1;
    stats.lastError = text;
    logger?.warn?.(`chat-widget: 音频采集：${text}`);
    try {
      onError(text);
    } catch (error) {
      logger?.warn?.(`chat-widget: 音频采集 onError 回调出错: ${String(error)}`);
    }
  }

  /** 收一行 JSON：就绪行 / 帧行。 */
  function handleLine(line) {
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    if (parsed === null || typeof parsed !== 'object') return;

    if (parsed.ready === true) {
      stats.ready = true;
      stats.device = typeof parsed.device === 'string' ? parsed.device : '';
      stats.endpoint = typeof parsed.endpoint === 'string' ? parsed.endpoint : '';
      stats.sampleRate = Number(parsed.sampleRate) || 0;
      stats.channels = Number(parsed.channels) || 0;
      stats.excludeActive = parsed.exclude === true;
      stats.excludeFallback = typeof parsed.excludeFallback === 'string' ? parsed.excludeFallback : '';
      // 引擎回报的 pid 才是"真的在用"的 pid；宿主 setExcludePid 之后要等下一次 ready。
      if (Number.isFinite(Number(parsed.excludePid)) && Number(parsed.excludePid) >= 0) {
        stats.excludePid = Math.trunc(Number(parsed.excludePid));
      }
      if (announced === false) {
        announced = true;
        const where = stats.device === '' ? stats.endpoint : stats.device;
        if (stats.excludeActive === true) {
          logger?.info?.(`chat-widget: 音轨采集就绪（进程级排除 pid ${String(stats.excludePid)}，其余声音照收；${String(stats.sampleRate)} Hz ${String(stats.channels)} 声道 → 16 kHz 单声道，每 ${String(frameMs)} ms 一帧）`);
        } else {
          logger?.info?.(`chat-widget: 音轨采集就绪（${where}，${String(stats.sampleRate)} Hz ${String(stats.channels)} 声道 → 16 kHz 单声道，每 ${String(frameMs)} ms 一帧）`);
        }
      }
      if (stats.excludeFallback !== '') {
        logger?.warn?.(`chat-widget: 进程级音轨排除不可用（${stats.excludeFallback}），已回退到默认设备`);
      }
      try {
        onReady({
          device: stats.device === '' ? stats.endpoint : stats.device,
          endpoint: stats.endpoint,
          sampleRate: stats.sampleRate,
          channels: stats.channels,
          frameMs: Number(parsed.frameMs) || frameMs,
          exclude: stats.excludeActive,
          excludePid: stats.excludePid,
          excludeFallback: stats.excludeFallback,
        });
      } catch (error) {
        logger?.warn?.(`chat-widget: 处理音频就绪出错: ${String(error)}`);
      }
      return;
    }

    if (typeof parsed.pcm === 'string') {
      let pcm;
      try {
        // 复制一份：Buffer.from 走的是池化内存，直接交出去以后可能被后来者覆盖。
        pcm = new Uint8Array(Buffer.from(parsed.pcm, 'base64'));
      } catch (error) {
        fail(`解 base64 失败: ${String(error)}`);
        return;
      }
      const frame = {
        seq: Number(parsed.seq) || 0,
        ms: Number(parsed.ms) || frameMs,
        at: Number(parsed.at) || Date.now(),
        pcm,
      };
      stats.frames += 1;
      stats.bytes += pcm.byteLength;
      stats.lastFrameAt = Date.now();
      try {
        onFrame(frame);
      } catch (error) {
        logger?.warn?.(`chat-widget: 处理音频帧出错: ${String(error)}`);
      }
    }
  }

  /** 起（或重起）引擎进程。 */
  function start() {
    if (supported !== true || stopped === true) return;
    if (enginePath === '') {
      enginePath = ensureAudioEngine(logger);
      if (enginePath === '') {
        stats.lastError = '音轨引擎编译失败';
        restartTimer = setTimeout(start, RESTART_DELAY_MS);
        return;
      }
    }
    // -MTA 由 exe 自己的 [MTAThread] 保证（进程级 loopback 的回调在 MTA 线程池上）
    const args = [
      '-FrameMs', String(frameMs),
      '-Request', audioRequestPath(),
      '-ParentPid', String(process.pid),
      '-ReadTimeoutMs', '1000',
      '-IdleSleepMs', '200',
    ];
    child = spawn(enginePath, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });

    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      if (buffer.length > MAX_LINE_CHARS * 4) buffer = buffer.slice(-MAX_LINE_CHARS);
      let index = buffer.indexOf('\n');
      while (index !== -1) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line !== '') handleLine(line);
        index = buffer.indexOf('\n');
      }
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      const text = String(chunk).trim();
      if (text !== '') fail(text.replace(/\s+/g, ' '));
    });

    // 必须挂 error 监听：没有监听者时 spawn 失败会掀掉整个宿主进程。
    child.on('error', (error) => {
      fail(`引擎起不来: ${String(error)}`);
    });

    child.on('exit', (code) => {
      child = null;
      stats.ready = false;
      stats.excludeActive = false;
      stats.excludeFallback = '';
      if (stopped === true) return;
      stats.restarts += 1;
      fail(`引擎退出（code ${String(code)}）`);
      logger?.warn?.(`chat-widget: 音频引擎退出，${RESTART_DELAY_MS} ms 后重拉`);
      restartTimer = setTimeout(start, RESTART_DELAY_MS);
    });

    logger?.info?.(`chat-widget: 音频引擎已启动（每 ${String(frameMs)} ms 一帧，模式 ${mode}${excludePid > 0 ? `，排除进程 ${String(excludePid)}` : ''}）`);
  }

  // 先把请求文件写成初始模式，再起进程：引擎第一拍就能读到确定的状态。
  if (supported === true) writeAudioRequest({ mode, excludePid });
  if (supported === true) start();
  else logger?.warn?.('chat-widget: 音轨采集不可用（只做了 Windows）');

  return {
    setMode(next) {
      mode = MODES.includes(next) ? next : 'off';
      if (supported === true) writeAudioRequest({ mode, excludePid });
      // 只改请求文件，**不重启进程**（这是给以后桌宠 TTS 预留的"略过"接口）。
      return mode;
    },
    /**
     * 换要排除的 pid（桌宠重启 → pid 变了）。
     *
     * 只改请求文件：引擎按 mtime 重读、自己关旧流、按新 pid 重新激活，**进程不重启**。
     * `0` = 回到默认设备老路径。
     *
     * @param {number} next - 新的 pid（0 = 不排除）。
     * @returns {number} 归一化后的 pid。
     */
    setExcludePid(next) {
      excludePid = normalizeExcludePid(next);
      if (supported === true) writeAudioRequest({ mode, excludePid });
      return excludePid;
    },
    enginePid: () => (child === null ? null : child.pid),
    requestPath: () => audioRequestPath(),
    status: () => ({
      running: child !== null,
      ready: stats.ready,
      device: stats.device,
      endpoint: stats.endpoint,
      sampleRate: stats.sampleRate,
      channels: stats.channels,
      mode,
      frames: stats.frames,
      bytes: stats.bytes,
      lastFrameAt: stats.lastFrameAt,
      errors: stats.errors,
      restarts: stats.restarts,
      lastError: stats.lastError,
      frameMs,
      excludePid: stats.excludePid,
      excludeActive: stats.excludeActive,
      excludeFallback: stats.excludeFallback,
      enginePid: child === null ? null : child.pid,
    }),
    stop() {
      stopped = true;
      clearTimeout(restartTimer);
      if (supported === true) writeAudioRequest({ mode: 'off', excludePid });
      if (child !== null) {
        const dying = child;
        child = null;
        try {
          dying.kill();
        } catch {
          /* 已经退了就算了 */
        }
      }
    },
  };
}
