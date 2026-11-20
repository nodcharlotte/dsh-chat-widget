/**
 * @local/chat-widget —— 帧队列与拼图（阶段 2）。
 *
 * 规则（用户定的）：
 *   每 2 秒截一张，去重后**直接喂**；
 *   模型不忙 && 队里有货 → 立刻发：
 *     1 张 → 单图
 *     2 张 → 两张一拼
 *     3 张 → 按帧指纹**丢掉最冗余的那张** → 剩两张一拼
 *     4 张 → 2×2 四宫格
 *   队里最多 4 张（第 5 张来了丢最老的），永远不超过四宫格。
 *
 * 拼图交给**截图引擎的 `-Compose` 模式**（`dshcw-capture.exe`）：
 * 只读 JPEG、合成、写一张 JPEG，**不截屏、不 base64**——跟截图分开，互不牵连。
 * 时间顺序不上图（画面里不画字），顺序由提示词里的时间戳给。
 *
 * @module @local/chat-widget/host/screen-batch
 */

import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ensureEngine } from './native-build.js';

/**
 * 队列上限。
 *
 * 宫格最多 4 张，但**队列**要大一些：批处理按时间窗走（默认 5 秒），
 * 模型跑得比窗口慢时帧会积压在里面，等下一批再宽松去重压到 4 张。
 */
export const MAX_QUEUE = 12;

/** 拼图请求文件落在 %TEMP%。 */
const COMPOSE_REQUEST = 'dshcw-compose-req.json';

/** 拼图输出宽度（单帧也是 768，保持一致）。 */
const COMPOSE_WIDTH = 768;

/** 单次拼图的超时。 */
const COMPOSE_TIMEOUT_MS = 20000;

/** 拼图脚本全文（ASCII-only、无 P/Invoke、不截屏）。 */


/** 两帧指纹的平均绝对差（0–255；越小越像）。 */
function fingerprintDistance(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length || a.length === 0) return Number.POSITIVE_INFINITY;
  let sum = 0;
  let count = 0;
  for (let i = 0; i + 4 <= a.length; i += 4) {
    const va = Number.parseInt(a.slice(i, i + 2), 16) + Number.parseInt(a.slice(i + 2, i + 4), 16);
    const vb = Number.parseInt(b.slice(i, i + 2), 16) + Number.parseInt(b.slice(i + 2, i + 4), 16);
    sum += Math.abs(va / 2 - vb / 2);
    count += 1;
  }
  return count === 0 ? Number.POSITIVE_INFINITY : sum / count;
}

/**
 * 从队列里挑这一批要发哪几帧（**纯函数**，好测）。
 *
 * - 1–2 张 → 原样；
 * - 3 张 → 比较两两指纹，丢掉"与另一张最像"的那张 → 剩 2；
 * - 4 张 → 原样（四宫格）；
 * - **超过 4 张** → 反复丢掉"与最近邻最像"的那一张，直到剩 4 张
 *   （用户说的"宽松一点去重"：保留时间上分布最散的 4 张，而不是硬砍最老的）。
 *
 * 桥接帧（`bridge: true`）**永不被丢**：它是切换前那张，丢了就对比不了前后窗口。
 *
 * @param {{at: number, fp?: string, bridge?: boolean}[]} frames - 队列（时间正序）。
 * @returns {object[]} 这一批（时间正序）。
 */
export function selectBatch(frames) {
  const queue = Array.isArray(frames) ? frames.slice(0, MAX_QUEUE) : [];
  if (queue.length < 3) return queue;

  if (queue.length > 4) {
    // 宽松去重：每次砍掉"跟别人最像"的那张，直到 4 张
    const list = queue.slice();
    while (list.length > 4) {
      let dropIndex = -1;
      let smallest = Infinity;
      for (let i = 0; i < list.length; i += 1) {
        if (list[i].bridge === true) continue;
        let nearest = Infinity;
        for (let j = 0; j < list.length; j += 1) {
          if (i === j) continue;
          const dist = fingerprintDistance(list[i].fp, list[j].fp);
          if (Number.isFinite(dist) && dist < nearest) nearest = dist;
        }
        if (Number.isFinite(nearest) === false) continue;
        if (nearest < smallest) {
          smallest = nearest;
          dropIndex = i;
        }
      }
      if (dropIndex < 0) {
        // 全都没指纹 / 只剩桥接帧：从中间砍，尽量保住首尾
        dropIndex = list.findIndex((item) => item.bridge !== true);
        if (dropIndex < 0) dropIndex = Math.floor(list.length / 2);
      }
      list.splice(dropIndex, 1);
    }
    return list;
  }

  if (queue.length === 4) return queue;

  const [a, b, c] = queue;
  const ab = fingerprintDistance(a.fp, b.fp);
  const bc = fingerprintDistance(b.fp, c.fp);
  const ac = fingerprintDistance(a.fp, c.fp);
  // 每张的"最像的那张"距离：谁最小谁最冗余
  const worst = [Math.min(ab, ac), Math.min(ab, bc), Math.min(ac, bc)];
  // **桥接帧免死**：它是"切换前那张"，丢了就没法对比前后两个窗口了
  const candidates = [0, 1, 2].filter((index) => queue[index].bridge !== true);
  if (candidates.length === 0) return queue;
  // 默认丢**中间**那张（旧行为）：距离打平时中间那张最容易被前后夹住
  let drop = candidates.includes(1) ? 1 : candidates[0];
  for (const index of candidates) {
    if (Number.isFinite(worst[index]) === false) {
      drop = index;
      break;
    }
    if (worst[index] < worst[drop]) drop = index;
  }
  if (Number.isFinite(worst[drop]) === false) drop = candidates.find((index) => index !== 0) ?? candidates[0];
  return queue.filter((_, index) => index !== drop);
}

/**
 * 把 2/4 张帧拼成一张（调截图引擎的 `-Compose` 模式，不再有 PowerShell 脚本）。
 *
 * @param {object} logger - 日志器。
 * @param {string[]} paths - 帧文件（时间正序）。
 * @param {string} outPath - 输出 JPEG。
 * @returns {Promise<{ok: boolean, out?: string, bytes?: number, error?: string}>} 结果。
 */
export function composeFrames(logger, paths, outPath) {
  const requestPath = join(tmpdir(), COMPOSE_REQUEST);
  try {
    writeFileSync(requestPath, JSON.stringify({ paths, out: outPath, width: COMPOSE_WIDTH }), 'utf8');
  } catch (error) {
    return Promise.resolve({ ok: false, error: `写拼图请求失败：${String(error)}` });
  }

  return new Promise((resolve) => {
    const engine = ensureEngine({ target: 'capture', logger });
    if (engine.ok !== true) {
      resolve({ ok: false, error: String(engine.error ?? '拼图引擎不可用') });
      return;
    }
    const child = spawn(engine.exe, ['-Compose', requestPath], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* 已经退了 */
      }
    }, COMPOSE_TIMEOUT_MS);

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      out += chunk;
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      err += chunk;
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ ok: false, error: String(error) });
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        resolve({ ok: false, error: `拼图脚本退出 code=${String(code)} ${err.trim().slice(0, 200)}` });
        return;
      }
      const lastLine = out.trim().split('\n').pop() ?? '';
      try {
        const parsed = JSON.parse(lastLine);
        if (parsed !== null && typeof parsed === 'object' && parsed.ok === true) {
          resolve({ ok: true, out: String(parsed.out), bytes: Number(parsed.bytes) || 0, width: Number(parsed.width) || 0, height: Number(parsed.height) || 0 });
          return;
        }
        resolve({ ok: false, error: '拼图脚本没有回 ok' });
      } catch {
        resolve({ ok: false, error: `拼图脚本输出无法解析：${out.trim().slice(0, 200)}` });
      }
    });
  });
}

/**
 * 造一个帧队列：按**时间窗**攒，攒够再发一批。
 *
 * 之前是"空闲就立刻发"，一帧也发 —— 于是两帧之间只隔 2 秒，它就前后脚说两句
 * （用户实测"感觉是两条线并行"）。现在改成：
 *
 *   - 队首帧年龄 ≥ `windowMs`（= 设置里的开口冷却，默认 5000）才发；
 *   - 模型还在跑（`busy`）时不发，帧继续攒；
 *   - 发的时候最多 4 张（宽松去重压到 4 张，见 `selectBatch`）；
 *   - `windowMs = 0` → 立刻发（等于交给模型/节奏自己决定）。
 *
 * @param {{logger: object, shotsDir: string, windowMs?: number,
 *   onBatch: (frames: object[], composedPath: string|null) => void}} options
 *   日志器、截图目录、时间窗、每批的回调。
 * @returns {{push: Function, markBusy: Function, markIdle: Function, queueLength: Function,
 *   stats: Function, keepBridge: Function, setWindowMs: Function, reset: Function}} 队列。
 */
export function createFrameBatcher(options) {
  const logger = options.logger;
  const shotsDir = String(options.shotsDir);
  const onBatch = typeof options.onBatch === 'function' ? options.onBatch : () => {};

  const queue = [];
  const stats = { batches: 0, singles: 0, pairs: 0, quads: 0, droppedRedundant: 0, droppedOldest: 0, composeFailures: 0, lastBatchSize: 0, bridges: 0 };
  let busy = false;
  let flushing = false;
  /** 时间窗（毫秒）：队首帧要在这个窗口里攒够才发。 */
  let windowMs = Number.isFinite(options.windowMs) ? Math.max(0, Math.round(options.windowMs)) : 0;
  /** 下一次“该发”的时刻（毫秒时间戳）；null = 还没吐过字。 */
  let deadline = null;
  /** 等 deadline 的定时器（只挂一个）。 */
  let windowTimer = null;
  /** 最近推进来的那张帧：队列被清空时靠它还能留下"切换前最后一帧"。 */
  let lastPushed = null;

  try {
    mkdirSync(shotsDir, { recursive: true });
  } catch {
    /* 建不出来时截图引擎那边会再试一次 */
  }

  /** 队列满时丢最老的。 */
  function push(frame) {
    if (frame === null || typeof frame !== 'object' || typeof frame.path !== 'string') return;
    lastPushed = frame;
    if (queue.length >= MAX_QUEUE) {
      // 满的时候优先丢非桥接帧：桥接帧是"切换前那张"，丢了就没法对比了
      const dropIndex = queue.findIndex((item) => item.bridge !== true);
      if (dropIndex >= 0) queue.splice(dropIndex, 1);
      else queue.shift();
      stats.droppedOldest += 1;
    }
    queue.push(frame);
    maybeFlush();
  }

  /**
   * 该不该发、什么时候发。
   *
   * **计时从“模型吐字”开始**（用户 2026-11-06 定）：
   *   - 吐字那一刻 deadline = now + windowMs（= 设置里的开口冷却）；
   *   - 这段时间里进来的帧、以及吐字前还没送出去的帧，全攒着；
   *   - deadline 到点 → 攒成什么样就发什么样（1 张单图 / 2 张两宫格 /
   *     4 张四宫格 / 5 张以上宽松去重压到 4 张再四宫格，见 selectBatch）；
   *   - 模型跑完又吐字 → markSpoken() 再开一个新的 windowMs，循环。
   *
   * 第一句之前没有“吐字”事件（deadline === null）：有帧就发，别干等。
   */
  function maybeFlush() {
    if (busy === true || flushing === true || queue.length === 0) return;
    if (queue.every((item) => item.bridge === true)) return;
    if (deadline === null) {
      void flush();
      return;
    }
    const wait = deadline - Date.now();
    if (wait <= 0) {
      // 已经到点：立刻发（把还没到点的定时器撤掉，避免发两次）
      if (windowTimer !== null) {
        clearTimeout(windowTimer);
        windowTimer = null;
      }
      void flush();
      return;
    }
    if (windowTimer !== null) return;
    windowTimer = setTimeout(() => {
      windowTimer = null;
      maybeFlush();
    }, wait);
    windowTimer.unref?.();
  }

  /** 发一批。 */
  async function flush() {
    if (busy === true || flushing === true || queue.length === 0) return;
    flushing = true;
    try {
      const before = queue.length;
      const batch = selectBatch(queue);
      if (batch.length < before) stats.droppedRedundant += before - batch.length;
      queue.splice(0, before);

      stats.batches += 1;
      stats.lastBatchSize = batch.length;
      if (batch.length === 1) stats.singles += 1;
      else if (batch.length === 2) stats.pairs += 1;
      else stats.quads += 1;

      if (batch.length === 1) {
        onBatch(batch, null);
      } else {
        const outPath = join(shotsDir, `batch-${batch[0].at}-${batch.length}.jpg`);
        const result = await composeFrames(logger, batch.map((f) => f.path), outPath);
        if (result.ok === true) {
          onBatch(batch, result.out);
        } else {
          stats.composeFailures += 1;
          logger.warn?.(`chat-widget: 拼图失败（只重发最后一张，不逐张补发）: ${String(result.error)}`);
          // 绝不滚雪球：拼图失败只把**最新那一张**重发，其余丢掉。
          onBatch([batch[batch.length - 1]], null);
        }
      }
    } finally {
      flushing = false;
      // 发完先垫一个窗口：模型没吐字时也不会立刻又发一批（吐字会覆盖它）
      deadline = Date.now() + windowMs;
      maybeFlush();
    }
  }

  return {
    push,
    markBusy() {
      busy = true;
    },
    markIdle() {
      busy = false;
      maybeFlush();
    },
    /**
     * 宿主**吐字时**调它：从这一刻起算一个新的开口冷却窗口。
     *
     * 这是整套节奏的锚点：吐字 → 攒 windowMs 的帧 → 发 → 模型再吐字 → 再攒…
     *
     * @returns {void}
     */
    markSpoken() {
      deadline = Date.now() + windowMs;
      maybeFlush();
    },
    queueLength: () => queue.length,
    stats: () => ({ ...stats, queued: queue.length, busy, windowMs, nextInMs: deadline === null ? null : Math.max(0, deadline - Date.now()) }),
    /**
     * 改时间窗（设置里的「开口冷却」改了要即时生效，不用重启引擎）。
     *
     * @param {number} ms - 新的窗口毫秒数；0 = 立刻发。
     * @returns {void}
     */
    setWindowMs(ms) {
      const next = Number.isFinite(ms) ? Math.max(0, Math.round(ms)) : 0;
      if (next === windowMs) return;
      windowMs = next;
      if (windowTimer !== null) {
        clearTimeout(windowTimer);
        windowTimer = null;
      }
      // 正在攒的那一轮也按新值重算（不然改了冷却要等下一句才生效）
      if (deadline !== null && queue.length > 0) deadline = Date.now() + windowMs;
      maybeFlush();
    },
    /**
     * 切窗口时用：清空队列，但**留下切换前最后一张**当"桥接帧"。
     *
     * 为什么要留：只给新窗口的图，它只能描述"现在是什么"；带上上一张，
     * 它才能说出"刚还在看 X，这就切到 Y 了"。用户明确要这个对比。
     *
     * 桥接帧带 `bridge: true`：`selectBatch` 不会把它当冗余丢掉。
     * 快速连续切窗口时**覆盖**（永远只留最新那一张），不会越堆越多。
     *
     * @param {number} [maxAgeMs] - 超过这个年龄的旧帧就不当桥接了（默认 8000）。
     * @returns {boolean} 有没有留下桥接帧。
     */
    keepBridge(maxAgeMs) {
      const limit = Number.isFinite(maxAgeMs) ? Number(maxAgeMs) : 8000;
      // 队列里有就用队列最后一张（最接近切换时刻），否则用最后一次推进来的那张
      const candidate = queue.length > 0 ? queue[queue.length - 1] : lastPushed;
      queue.length = 0;
      if (windowTimer !== null) {
        clearTimeout(windowTimer);
        windowTimer = null;
      }
      try {
        rmSync(join(tmpdir(), COMPOSE_REQUEST), { force: true });
      } catch {
        /* 没建起来就算了 */
      }
      if (candidate === null || typeof candidate !== 'object') return false;
      const age = Date.now() - (Number(candidate.at) || 0);
      if (Number.isFinite(age) && age > limit) return false;
      queue.push({ ...candidate, bridge: true });
      stats.bridges += 1;
      return true;
    },
    /** 只给自检用：清掉队列并删掉临时请求文件。 */
    reset() {
      queue.length = 0;
      try {
        rmSync(join(tmpdir(), COMPOSE_REQUEST), { force: true });
      } catch {
        /* 没建起来就算了 */
      }
    },
  };
}
