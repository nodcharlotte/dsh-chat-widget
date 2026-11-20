/**
 * @local/chat-widget —— 前台窗口监测。
 *
 * 干什么：谁在前台、标题是什么；**一变化就报出来**（含浏览器切标签页——窗口没变、标题变了）。
 *
 * 为什么要一个外部助手进程：读前台窗口标题要走 user32 的 P/Invoke，Node 里没有内置通道；
 * 每 200 ms 起一个进程显然不行，所以由编译出来的 `native/WindowWatch.cs`（`dshcw-watch.exe`）
 * 常驻轮询、变化时往 stdout 吐一行 JSON，这里只负责收行、解析、广播。
 *
 * 三条实现上的讲究：
 *   1. **同一个 hwnd 换标题也算变化**（浏览器切标签页就是这种），所以变化键是「hwnd + 标题」。
 *   2. 助手进程死了要能自己拉起来（带退避），并把最近一次错误留在状态里。
 *   3. 助手每 50 圈检查一次父进程还在不在：DSH 被强杀时它不会变成孤儿进程。
 *
 * 现在**只做检测**：谁在用（视觉、感知标签、行为记录）还没接，见 `GET /window`。
 *
 * @module @local/chat-widget/host/window-watch
 */

import { spawn } from 'node:child_process';

import { ensureEngine } from './native-build.js';

/** 轮询间隔（毫秒）：200 ms 意味着切标签页后最迟 0.2 s 就报出来。 */
export const DEFAULT_INTERVAL_MS = 200;

/** 记多少条变化（给 `GET /window` 看现场，不落库）。 */
const HISTORY_LIMIT = 100;

/** 助手进程意外退出后多久重拉。 */
const RESTART_DELAY_MS = 3000;

/** 开关监督间隔：滑块一开一关最多 3 秒生效。 */
const SUPERVISE_MS = 3000;

/** 一行 JSON 的长度上限，防止异常输出把内存吃掉。 */
const MAX_LINE_CHARS = 8192;

/**
 * 起一个窗口监测器。
 *
 * @param {object} logger - 日志器（cordis logger 或 console）。
 * @param {{intervalMs?: number, helperPath?: string}} [options] - 轮询间隔与助手脚本路径。
 * @returns {{
 *   supported: boolean,
 *   intervalMs: number,
 *   current: () => object|null,
 *   history: (limit?: number) => object[],
 *   status: () => object,
 *   onChange: (fn: (event: object) => void) => () => void,
 *   stop: () => void,
 * }} 监测器。
 */
export function startWindowWatch(logger, options = {}) {
  const intervalMs = Number.isFinite(options.intervalMs) && options.intervalMs >= 50
    ? Math.round(options.intervalMs)
    : DEFAULT_INTERVAL_MS;
  // 助手是编译出来的 EXE（native/WindowWatch.cs），不再有 .ps1。
  // 懒编译：第一次真正启动时才编（约 0.1 秒），编完缓存。
  let helperPath = typeof options.helperPath === 'string' && options.helperPath !== '' ? options.helperPath : '';
  const helperCompiled = () => {
    if (helperPath !== '') return helperPath;
    const built = ensureEngine({ target: 'watch', logger });
    helperPath = built.ok === true ? built.exe : '';
    return helperPath;
  };
  const supported = process.platform === 'win32';
  // 开关：给了 enabled() 就按它开停（感知标签那个滑块）；没给就一直开（自检脚本走这条）
  const enabledFn = typeof options.enabled === 'function' ? options.enabled : null;
  let enabled = enabledFn === null;

  const history = [];
  const listeners = new Set();
  let current = null;
  let child = null;
  let stopped = false;
  let restartTimer = null;
  let lastError = '';
  let restarts = 0;
  let changes = 0;
  let announced = false;

  /** 收一行 JSON → 一条变化事件。 */
  function handleLine(line) {
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    if (parsed === null || typeof parsed !== 'object') return;
    changes += 1;
    const event = {
      seq: changes,
      at: Number(parsed.at) || Date.now(),
      receivedAt: Date.now(),
      hwnd: Number(parsed.hwnd) || 0,
      title: typeof parsed.title === 'string' ? parsed.title : '',
      pid: Number(parsed.pid) || 0,
      process: typeof parsed.process === 'string' ? parsed.process : '',
    };
    current = event;
    history.push(event);
    if (history.length > HISTORY_LIMIT) history.shift();

    // 只报第一条：之后每次切窗口都打日志会刷屏。要看实时变化用 `GET /window`
    // 或 `node check-window.mjs --watch`。
    if (announced === false) {
      announced = true;
      logger.info?.(`chat-widget: 窗口监测就绪（当前：${event.title === '' ? '（无标题）' : event.title}）`);
    }
    for (const listener of listeners) {
      try {
        listener(event);
      } catch (error) {
        logger.warn?.(`chat-widget: 窗口监测回调出错: ${String(error)}`);
      }
    }
  }

  /** 杀掉助手进程（不改变 stopped，重拉也停掉）。 */
  function stopHelper() {
    clearTimeout(restartTimer);
    if (child === null) return;
    const dying = child;
    child = null;
    try {
      dying.kill();
    } catch {
      /* 已经退了就算了 */
    }
  }

  /** 起（或重起）助手进程。 */
  function start() {
    if (supported === false || stopped === true || enabled === false) return;
    history.length = 0;
    const exe = helperCompiled();
    if (exe === '') {
      logger.warn?.('chat-widget: 窗口监测引擎编译失败');
      return;
    }
    const args = [
      '-IntervalMs', String(intervalMs),
      '-ParentPid', String(process.pid),
    ];
    child = spawn(exe, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });

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
      if (text !== '') lastError = text.slice(0, 300);
    });

    child.on('error', (error) => {
      lastError = String(error);
      logger.warn?.(`chat-widget: 窗口监测助手起不来: ${String(error)}`);
    });

    child.on('exit', (code) => {
      child = null;
      if (stopped === true || enabled === false) return;
      restarts += 1;
      lastError = `助手进程退出（code ${String(code)}）`;
      logger.warn?.(`chat-widget: 窗口监测助手退出了，${RESTART_DELAY_MS} ms 后重拉`);
      restartTimer = setTimeout(start, RESTART_DELAY_MS);
    });
  }

  // 开关监督：每 3 秒看一次设置，滑块一开一关就起停助手进程
  const supervisor = setInterval(() => {
    if (enabledFn === null || stopped === true) return;
    Promise.resolve()
      .then(() => enabledFn())
      .then((on) => {
        const want = on === true;
        if (want === enabled) return;
        enabled = want;
        if (want === true) start();
        else stopHelper();
      })
      .catch(() => {});
  }, SUPERVISE_MS);
  if (typeof supervisor.unref === 'function') supervisor.unref();

  if (supported === true && enabled === true) start();
  else if (supported !== true) logger.warn?.('chat-widget: 窗口监测不可用（只支持 Windows，且编译不出 native/WindowWatch.cs）');

  return {
    supported,
    intervalMs,
    current: () => current,
    history: (limit) => history.slice(-(Number.isInteger(limit) && limit > 0 ? Math.min(limit, HISTORY_LIMIT) : 20)),
    /** 第 seq 条**之后**（含第 seq 条）的变化，用来「结算这一段的窗口名称」。 */
    changesSince: (seq) => history.filter((event) => event.seq >= (Number.isInteger(seq) ? seq : 0)),
    /** 现在累计到第几条。 */
    currentSeq: () => changes,
    /** 滑块现在是开还是关。 */
    enabled: () => enabled,
    status: () => ({
      supported,
      intervalMs,
      running: child !== null,
      helperPid: child === null ? null : child.pid,
      changes,
      restarts,
      lastError,
    }),
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    stop() {
      stopped = true;
      clearInterval(supervisor);
      stopHelper();
      listeners.clear();
    },
  };
}
