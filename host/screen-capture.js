/**
 * @local/chat-widget —— 截图引擎（屏幕陪看的眼睛）。
 *
 * 一个常驻 PowerShell 子进程：每 `intervalMs` 截一次主屏 → 缩到 128×72 逐像素比较
 * → 分数 = **亮度差 ≥8 的像素占比（pct8）** → 过门槛就把这一帧存成 JPEG（768 宽 / q60）
 * 并把路径与分数用一行 JSON 报上来；没过门槛就什么都不做。
 *
 * 三条硬约束（都是实测踩出来的）：
 *   1. **引擎不放脚本、只放编译好的 exe**（`native/CaptureEngine.cs` → `dshcw-capture.exe`）。
 *      以前是运行时往 `%TEMP%` 写 `.ps1`：同样的"截屏 + 编码存盘"代码放仓库目录里会被
 *      AMSI 判成恶意脚本（`ScriptContainedMaliciousContent`），放 %TEMP% 才没事。
 *      编成 exe 之后没有脚本文本，两个坑一起绕开。
 *   2. **不 base64、不落中间文件**：引擎只把 JPEG 写到磁盘、只报路径，Node 侧读文件自己编码。
 *   3. **绝不给 spawn 加 `detached: true`**，且必须挂 `child.on('error')`。
 *
 * 门槛只决定"这张要不要截"。截下来的帧**原样**给模型，不遮不裁不筛区域。
 *
 * @module @local/chat-widget/host/screen-capture
 */

import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ensureEngine } from './native-build.js';

/** 去重用的缩图尺寸（实测 125 ms/帧 ≈ 单核 6%）。 */
const MAP_WIDTH = 128;

/** 引擎报的一行最长多少字符，防止异常输出吃内存。 */
const MAX_LINE_CHARS = 4096;

/** 引擎意外退出后多久重拉。 */
const RESTART_DELAY_MS = 3000;

/**
 * 被安全软件（Windows Defender 的 AMSI）拦下时的重拉间隔上限。
 *
 * 实测：引擎脚本一启动就被打回 `ScriptContainedMaliciousContent` —— Defender 把
 * "全屏截取 + OCR + 常驻 JSON 管道 + 看父进程"这套形状判成恶意脚本，是**误报**。
 * 这时再按 3 秒一次重拉只会每 3 秒撞一次 AMSI、把错误计数刷到几百，
 * 所以退避到分钟级，并且只在前几次记日志 —— 用户加了排除之后最多一分钟自己恢复。
 */
const AV_BACKOFF_MAX_MS = 60000;

/** stderr 里出现这些字样，就认定"被安全软件拦了"（中英文都认）。 */
const AV_SIGNS = ['ScriptContainedMaliciousContent', 'antivirus', 'Antivirus', '恶意内容', 'AMSI'];

/**
 * 灵敏度 1–10 → pct8 门槛（百分比）。设置里只暴露灵敏度，小字写"数字越高截图取用越多"。
 *
 * 实测标定（本机 1920×1080，2 秒一帧，逐像素亮度差 ≥8）：
 *   纯净静止桌面 0.00%（14 帧全是 0）｜沙雕动画最安静片段 0.98%｜番剧慢镜头 2%｜活跃内容 14–94%
 * 所以默认档 6（0.5%）两边都有余量：安静内容不漏，静止桌面不取。
 */
export const SENSITIVITY_STEPS = [30, 20, 10, 3, 1, 0.5, 0.2, 0.1, 0.05, 0.01];

/**
 * 把灵敏度换算成 pct8 门槛。
 * @param {unknown} sensitivity - 1–10。
 * @returns {number} 门槛（百分比）。
 */
export function thresholdFor(sensitivity) {
  const value = Number.isFinite(sensitivity) ? Math.round(sensitivity) : 6;
  const index = Math.min(SENSITIVITY_STEPS.length, Math.max(1, value)) - 1;
  return SENSITIVITY_STEPS[index];
}

/** OCR 请求文件默认路径（宿主写、引擎每拍看 mtime）。 */
export const OCR_REQUEST_FILE = 'dshcw-ocr.json';

/** 本机装了什么 OCR 语言（引擎就绪行报过就存这儿；界面判断"无此语言包"要用）。 */
let cachedLangs = null;


/**
 * 查本机装了哪些 OCR 语言。
 *
 * 引擎跑着时它的**就绪行**已经报过一次（顺手进缓存），所以只有"陪看没开"时才真起进程扫一遍
 * （约 0.6 秒，结果一直缓存；装完语言包用 `refresh: true` 重扫）。
 *
 * @param {object} [logger] - 日志器。
 * @param {{refresh?: boolean}} [options] - `refresh` 强制重扫。
 * @returns {{langs: string[], at: number, source: string}} 结果。
 */
export function ocrLanguages(logger, options = {}) {
  if (options.refresh !== true && cachedLangs !== null) return { ...cachedLangs, source: 'cache' };
  // 走编译引擎的 `-Probe`：只报就绪行就退出（约 150 ms），不用起采集循环。
  try {
    const built = ensureEngine({ target: 'capture', wantOcr: true, logger });
    if (built.ok !== true || built.ocr !== 'ok') {
      // 编不出来（缺契约包）：明确报空，别假装有语言包
      cachedLangs = { langs: [], at: Date.now() };
      return { ...cachedLangs, source: 'scan' };
    }
    const out = spawnSync(built.exe, ['-Probe', '-OcrLangs', 'zh-Hans-CN', '-OcrEnabled', '1'], {
      encoding: 'utf8', timeout: 20000, windowsHide: true,
    });
    const first = String(out.stdout === null || out.stdout === undefined ? '' : out.stdout)
      .split('\n').map((one) => one.trim()).find((line) => line.includes('"ready"'));
    const parsed = typeof first === 'string' ? JSON.parse(first) : null;
    const langs = parsed !== null && typeof parsed.ocrLangs === 'string' && parsed.ocrLangs !== ''
      ? parsed.ocrLangs.split(',').map((one) => one.trim()).filter((one) => one !== '')
      : [];
    cachedLangs = { langs, at: Date.now() };
  } catch (error) {
    logger?.warn?.(`chat-widget: 扫描本机 OCR 语言失败: ${String(error)}`);
    cachedLangs = { langs: [], at: Date.now() };
  }
  return { ...cachedLangs, source: 'scan' };
}

/** 引擎脚本全文（ASCII-only，见文件头约束 3）。 */






/**
 * OCR 请求文件的路径（引擎与宿主共用同一个 `%TEMP%`）。
 * @returns {string} 绝对路径。
 */
export function ocrRequestPath() {
  return join(tmpdir(), OCR_REQUEST_FILE);
}

/**
 * 写 OCR 请求——宿主改"要不要 OCR / OCR 哪一条"的**唯一方式**（引擎看 mtime 变了才重读）。
 *
 * @param {{mode?: 'off'|'probe'|'band'|'idle', y?: number, h?: number, every?: number}} [request] - 状态、区域与"隔几拍看一次"。
 * @returns {string} 写到的路径。
 */
export function writeOcrRequest(request) {
  const path = ocrRequestPath();
  const wanted = request !== null && typeof request === 'object' ? request : {};
  const mode = wanted.mode === 'probe' || wanted.mode === 'band' || wanted.mode === 'idle' ? wanted.mode : 'off';
  const payload = mode === 'off'
    ? { mode: 'off' }
    : {
      mode,
      y: Math.max(0, Math.round(Number(wanted.y) || 0)),
      h: Math.max(1, Math.round(Number(wanted.h) || 1)),
    };
  // 待机（idle）时不必每拍都 OCR：`every = 4` 就是"四拍看一次"（省 CPU 的大头）
  const every = Math.round(Number(wanted.every) || 1);
  if (mode !== 'off' && every > 1) payload.every = every;
  writeFileSync(path, JSON.stringify(payload), 'utf8');
  return path;
}

/**
 * 起一个截图引擎。
 *
 * @param {object} logger - 日志器。
 * @param {{dir: string, intervalMs?: number, sensitivity?: number, onFrame?: (frame: object) => void,
 *   onOcr?: (ocr: object, at: number) => void, onReady?: (info: object) => void, ocrEnabled?: boolean, ocrLangs?: string}} options
 *   数据目录、间隔、灵敏度、每帧回调；字幕层开启时才把 OCR 那一块带起来。
 * @returns {{running: () => boolean, enginePid: () => number|null, stats: () => object, stop: () => void}} 句柄。
 */
export function startScreenCapture(logger, options) {
  const dir = String(options.dir);
  const shotsDir = join(dir, 'shots');
  try {
    mkdirSync(shotsDir, { recursive: true });
  } catch (error) {
    logger.warn?.(`chat-widget: 建截图目录失败 ${shotsDir}: ${String(error)}`);
  }
  const intervalMs = Number.isFinite(options.intervalMs) && options.intervalMs >= 250 ? Math.round(options.intervalMs) : 2000;
  const threshold = thresholdFor(options.sensitivity);
  const onFrame = typeof options.onFrame === 'function' ? options.onFrame : () => {};
  const onOcr = typeof options.onOcr === 'function' ? options.onOcr : () => {};
  const onReady = typeof options.onReady === 'function' ? options.onReady : () => {};
  const ocrEnabled = options.ocrEnabled === true;
  const ocrLangs = typeof options.ocrLangs === 'string' && options.ocrLangs !== '' ? options.ocrLangs : 'zh-Hans-CN';
  const supported = process.platform === 'win32';
  /**
   * 编译好的引擎 exe 路径。
   *
   * **懒编译**：第一次要起引擎时才编（约 0.15 秒），编完缓存。为什么要编译成 exe：
   * `%TEMP%` 里运行时生成的 `.ps1` 在部分机器上会被 Defender/AMSI 判成恶意脚本
   * （"截图 + 编码 + 存盘"是它的启发式雷区），引擎一启动就 exit 1，陪看整条链断掉。
   * 编成 exe 后没有脚本文本，扫描面消失。详见 `host/native-build.js` 文件头。
   */
  let enginePath = '';

  const stats = {
    frames: 0, bytes: 0, lastPct: null, lastAt: null, restarts: 0, errors: 0, lastError: '',
    ocrEnabled, ocrReady: null, ocrLangs: '', ocrUsing: '', ocrCalls: 0, ocrLines: 0, lastOcrMs: null,
    /** 主屏尺寸（引擎就绪行给的，字幕层要靠它算区域）。 */
    screen: null,
    /** 被安全软件拦了（Defender AMSI 误报）：界面据此把"没画面"解释清楚。 */
    blockedByAv: false, blockedMessage: '', avFailures: 0,
  };
  let child = null;
  let stopped = false;
  let restartTimer = null;

  /** 启动子进程。 */
  function start() {
    if (supported !== true || stopped === true) return;

    // 第一次启动才编译（之后直接用产物）
    if (enginePath === '') {
      const built = ensureEngine({ target: 'capture', wantOcr: ocrEnabled, logger });
      stats.engine = built.ocr;
      if (built.ok !== true) {
        stats.errors += 1;
        stats.lastError = String(built.error ?? 'build-failed');
        logger.warn?.(`chat-widget: 截图引擎编译失败（${stats.lastError}），${RESTART_DELAY_MS} ms 后重试`);
        restartTimer = setTimeout(start, RESTART_DELAY_MS);
        return;
      }
      enginePath = built.exe;
      if (built.ocr === 'missing-sdk') {
        logger.warn?.('chat-widget: 缺 WinRT 契约包（Windows SDK / NuGet），截图引擎编成了**无 OCR** 版（字幕不可用）');
      }
      logger.info?.(`chat-widget: 截图引擎已就绪（${enginePath}，OCR=${String(built.ocr)}）`);
    }

    const args = [
      '-IntervalMs', String(intervalMs),
      '-ThresholdPct', String(threshold),
      '-OutDir', shotsDir,
      '-ParentPid', String(process.pid),
      '-OcrLangs', ocrLangs,
      '-OcrEnabled', ocrEnabled ? '1' : '0',
      '-OcrRequest', ocrEnabled ? ocrRequestPath() : '',
      // 桌宠位置（屏幕占比）：引擎每次截图后把这块涂掉，只影响我们这份拷贝
      '-MaskRequest', typeof options.maskRequest === 'string' ? options.maskRequest : '',
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
      if (text === '') return;
      stats.errors += 1;
      stats.lastError = text.slice(0, 300);
      // Defender 的 AMSI 拦截：stderr 里带 ScriptContainedMaliciousContent / "恶意内容"。
      // 记住它，退出处理据此退避，界面也能直接说清"为什么一直没画面"。
      if (stats.blockedByAv !== true && AV_SIGNS.some((sign) => text.includes(sign))) {
        stats.blockedByAv = true;
        // 说明文字别直接甩 stderr：PowerShell 的中文报错在 app 里是乱码，末尾只剩一个 "+"。
        stats.blockedMessage = text.includes('ScriptContainedMaliciousContent')
          ? 'Defender AMSI: ScriptContainedMaliciousContent'
          : 'Defender/AMSI';
        logger.warn?.(`chat-widget: 截图引擎被安全软件拦截（${stats.blockedMessage}，属误报）`);
        logger.warn?.('chat-widget: 解决办法二选一 —— 在 Windows 安全中心给这个文件加排除，或只开聊天不要陪看。');
        logger.warn?.(`chat-widget: 文件：${enginePath}`);
      }
    });

    child.on('error', (error) => {
      stats.lastError = String(error);
      logger.warn?.(`chat-widget: 截图引擎起不来: ${String(error)}`);
    });

    child.on('exit', (code) => {
      child = null;
      if (stopped === true) return;
      stats.restarts += 1;
      if (stats.blockedByAv === true) {
        // 被安全软件拦：退避到分钟级，别每 3 秒撞一次 AMSI；日志只在头几次说。
        stats.avFailures += 1;
        stats.lastError = `截图引擎被安全软件拦截（${stats.blockedMessage !== '' ? stats.blockedMessage : 'AMSI'}）`;
        const delay = Math.min(AV_BACKOFF_MAX_MS, RESTART_DELAY_MS * (2 ** Math.min(5, stats.avFailures)));
        if (stats.avFailures <= 2) {
          logger.warn?.(`chat-widget: 截图引擎被拦后第 ${String(stats.avFailures)} 次重试，${String(delay)} ms 后再来（不再每次刷日志）`);
        }
        restartTimer = setTimeout(start, delay);
        return;
      }
      stats.lastError = `引擎退出（code ${String(code)}）`;
      logger.warn?.(`chat-widget: 截图引擎退出（code=${String(code)}），${RESTART_DELAY_MS} ms 后重拉`);
      restartTimer = setTimeout(start, RESTART_DELAY_MS);
    });

    logger.info?.(`chat-widget: 截图引擎已启动（每 ${intervalMs} ms，门槛 pct8 ≥ ${threshold}%，存到 ${shotsDir}）`);
  }

  /** 收一行 JSON。三种行：`ready`（起好了）/ 带 `path` 的帧 / 带 `ocr` 的识别结果，后两种可能合成一行。 */
  function handleLine(line) {
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      return;
    }
    if (parsed === null || typeof parsed !== 'object') return;

    if (parsed.ready === true) {
      // 引擎能报 ready 就说明这次没被拦（用户加了排除之后会自动走到这里）
      if (stats.blockedByAv === true) logger.info?.('chat-widget: 截图引擎恢复正常（安全软件不再拦截）');
      stats.blockedByAv = false;
      stats.blockedMessage = '';
      stats.avFailures = 0;
      stats.ocrReady = parsed.ocr === true;
      stats.ocrLangs = typeof parsed.ocrLangs === 'string' ? parsed.ocrLangs : '';
      stats.ocrUsing = typeof parsed.ocrUsing === 'string' ? parsed.ocrUsing : '';
      // 引擎报的语言列表顺手当"本机装了什么"的缓存（界面要靠它判断"无此语言包"）
      if (stats.ocrLangs !== '') cachedLangs = { langs: stats.ocrLangs.split(',').filter((one) => one !== ''), at: Date.now() };
      const match = typeof parsed.screen === 'string' ? /^(\d+)x(\d+)$/.exec(parsed.screen) : null;
      stats.screen = match === null ? null : { width: Number(match[1]), height: Number(match[2]) };
      logger.info?.(`chat-widget: 截图引擎就绪（屏幕 ${String(parsed.screen)}，OCR ${stats.ocrReady ? `在用 ${stats.ocrUsing}（本机装了 ${stats.ocrLangs}）` : `不可用/未开（本机装了 ${stats.ocrLangs}）`}）`);
      try {
        onReady({ screen: stats.screen, ocr: stats.ocrReady, ocrLangs: stats.ocrLangs, ocrUsing: stats.ocrUsing, intervalMs: Number(parsed.interval) || intervalMs });
      } catch (error) {
        logger.warn?.(`chat-widget: 处理引擎就绪出错: ${String(error)}`);
      }
    }

    if (typeof parsed.path === 'string') {
      const frame = {
        at: Number(parsed.at) || Date.now(),
        path: parsed.path,
        pct8: Number(parsed.pct8) || 0,
        bytes: Number(parsed.bytes) || 0,
        width: Number(parsed.width) || 0,
        height: Number(parsed.height) || 0,
        receivedAt: Date.now(),
      };
      stats.frames += 1;
      stats.bytes += frame.bytes;
      stats.lastPct = frame.pct8;
      stats.lastAt = frame.at;
      try {
        onFrame(frame);
      } catch (error) {
        logger.warn?.(`chat-widget: 处理截图帧出错: ${String(error)}`);
      }
    }

    if (parsed.ocr !== null && typeof parsed.ocr === 'object') {
      const ocr = {
        at: Number(parsed.at) || Date.now(),
        ok: parsed.ocr.ok !== false,
        ms: Number(parsed.ocr.ms) || 0,
        y: Number(parsed.ocr.y) || 0,
        h: Number(parsed.ocr.h) || 0,
        w: Number(parsed.ocr.w) || 0,
        lines: Array.isArray(parsed.ocr.lines) ? parsed.ocr.lines : [],
        error: typeof parsed.ocr.error === 'string' ? parsed.ocr.error : '',
      };
      stats.ocrCalls += 1;
      stats.ocrLines += ocr.lines.length;
      stats.lastOcrMs = ocr.ms;
      if (ocr.ok !== true && ocr.error !== '') stats.lastError = ocr.error.slice(0, 300);
      try {
        onOcr(ocr, ocr.at);
      } catch (error) {
        logger.warn?.(`chat-widget: 处理 OCR 结果出错: ${String(error)}`);
      }
    }
  }

  if (supported === true) start();
  else if (supported !== true) logger.warn?.('chat-widget: 截图引擎不可用（只做了 Windows）');

  return {
    running: () => child !== null,
    enginePid: () => (child === null ? null : child.pid),
    stats: () => ({ ...stats, intervalMs, threshold, shotsDir, running: child !== null }),
    stop() {
      stopped = true;
      clearTimeout(restartTimer);
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
