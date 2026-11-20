/**
 * @local/chat-widget —— 字幕层（v3）：管住"要不要 OCR / OCR 哪一条"，并把字幕原文攒成"这一批要带的行"。
 *
 * 它是 `host/subtitle-lock.js`（纯判定）与引擎之间的那层接线：
 *
 * ```
 *   off ──(陪看起、字幕开关开)──→ probing ──锁上──→ locked ──(很久没台词)──→ probing
 *                                   └── 预算到点 ──→ no_subtitle ──(窗口变化)──→ probing
 * ```
 *
 * 三个动作：
 *   - **probe**：让引擎识别**屏幕下部 `subtitleRegionPercent`%**（默认 1/3）；这期间的行**只喂给锁**，不喂模型；
 *   - **band**：锁定后只读**条带**——判定窗口是 ±`bandRowSpan`(2) 行高，OCR 区域必须盖住它（再多半行盖住行自身）；
 *   - **off**：`no_subtitle` 或字幕开关关掉 → 让引擎**别做 OCR**（引擎是常驻进程，只能这样停）。
 *
 * 字幕行的去向（都在 `companion.js` 里接）：
 *   ① `takeForBatch()` → 每批视觉调用的 `<subtitle>` 块（**不额外调用**）；
 *   ② 同一批的字幕原文写进 `screen_memories.subtitle`（单独一列，不进 `text`）。
 *
 * **重新探测的触发是窗口/标题变化**（`onWindowChange()`），不是定时器。
 * 窗口/标题一变，还没被取走的字幕行也一并作废：它们是上一个画面的台词，不能挂到新的前台窗口名下。
 *
 * @module @local/chat-widget/host/subtitles
 */

import { DEFAULT_OPTIONS as LOCK_DEFAULTS, createSubtitleLock } from './subtitle-lock.js';
import { writeOcrRequest } from './screen-capture.js';

/** 待带走的行最多攒这么多（没被取走时的兜底，防内存长草）。 */
const PENDING_CAP = 200;

/** 一个字幕行至少这么长才算数（锁也会滤，这里只挡明显垃圾）。 */
const MIN_LINE_CHARS = 2;

/** 设置里的兜底值（读不到设置时用）。 */
const FALLBACK = Object.freeze({
  enabled: false,
  regionPercent: 33,
  probeMs: 15_000,
  maxLines: 6,
  maxChars: 400,
  /** 待机时每隔多久看一眼（毫秒）。 */
  idleScanMs: 8_000,
  /** 待机**总计**多久还没字幕就彻底停（毫秒）；只有窗口变化能再启动。 */
  idleMs: 60_000,
});

/**
 * 取时间戳：**只有不是有限数**才回退到现在（`0` 是合法的 Unix 毫秒，别当成缺失）。
 *
 * 别用 `Number(x) || Date.now()`——`0` 是 falsy，会把合成时间轴搅乱
 * （自检里就踩到了：第一帧 at=0 被换成当前时间，后面的帧全成了"过去"，锁永远锁不上）。
 *
 * @param {unknown} value - 候选时间戳（毫秒）。
 * @returns {number} 时间戳。
 */
function stampOf(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : Date.now();
}

/** 页面文字的常见词（照抄旧版引擎里的 chrome filter 关键词表；命中就丢）。 */
const CHROME_WORDS = /播放|观看|点赞|投币|收藏|分享|订阅|关注|评论|推荐|热门|搜索|广告|登录|注册|下载|客户端|弹幕|设置|更多|选集|合集|倍速|进度|往期|相关|标签|频道|简介|展开|收起|查看|稍后观看|自动连播|全屏|网页|浏览器/;

/** 标题记号与网址：字幕几乎不会用。 */
/**
 * **会整行丢掉**的标题记号（页面标题 / 番名 / 画质标签）：`【】《》〈〉[]{}#`。
 * 这些通常出现在网页/播放器的标题块里，不是台词。
 */
const TITLE_MARKS = /[【】《》〈〉\[\]{}#]/;

/**
 * 字幕里常见的**引号与圆括号**：`「」『』（）()`。
 *
 * **不再整行丢掉**（用户 2026-10-24 要求）：剥掉符号、里面的字照用。
 * 实测字幕里这些到处都是（「她说『快跑』」「（笑）」「（叹气）」），整行丢会把真台词也丢。
 * 中点 `·` 与省略号 `…`/`...` **不算**标记，原样保留（`艾米·王` 去掉中点就毁人名了）。
 */
const INLINE_MARKS = /[「」『』（）()]/g;
const URL_PATTERN = /http|www\.|\.com|\.cn|\.tv|\.net|:\/\//;

/** 实义字（假名 + 汉字，**不数**标点与全角符号）。 */
const IDEOGRAPH = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g;

/**
 * 从一拍 OCR 行里挑出"可能是字幕"的候选行（**预筛**，判定的活仍然是锁的）。
 *
 * 为什么必须有这一层（2026-10-22 活体自检抓到）：浏览器里放视频时，屏幕下部 1/3 里除了字幕
 * 还有视频标题、订阅按钮、话题标签、推荐列表……行数轻松超过锁的 `maxLines`(4)，
 * 于是**每一帧都被判成"文档式画面"**，字幕永远锁不上。旧版是把这层过滤放在引擎里的。
 *
 * 判据（全过才留）：去空白后 ≥2 字｜实义字 ≥2｜水平中心落在 22%~78%（字幕居中）｜
 * 行宽 ≤ 85% 屏宽｜不贴屏幕最底部 3%（任务栏）｜不含页面关键词/网址。
 * **成对符号（「」『』（）【】…）不再整行丢**：剥掉符号、里面的字照用；`·` 与省略号原样保留。
 *
 * **不是白名单**：不认窗口标题、不认进程名，几何与字符说了算。
 *
 * @param {object[]} lines - 引擎这一拍认出来的行（屏幕像素）。
 * @param {{width: number, height: number}} screen - 屏幕尺寸。
 * @returns {object[]} 候选行（坐标不动；文本可能剥掉了成对符号）。
 */
export function pickSubtitleCandidates(lines, screen) {
  const width = Number(screen?.width) > 0 ? Number(screen.width) : 0;
  const height = Number(screen?.height) > 0 ? Number(screen.height) : 0;
  if (width === 0 || height === 0) return [];
  const keep = [];
  for (const line of Array.isArray(lines) ? lines : []) {
    const raw = String(line?.text === undefined || line?.text === null ? '' : line.text).replace(/\s+/g, '');
    if (raw.length < MIN_LINE_CHARS) continue;
    // 页面标题块（【…】《…》[…]）照旧整行丢；引号/圆括号剥掉、里面的字留着用
    if (TITLE_MARKS.test(raw) === true) continue;
    const text = INLINE_MARKS.test(raw) === true ? raw.replace(INLINE_MARKS, '') : raw;
    if (text.length < MIN_LINE_CHARS) continue;
    const w = Number(line?.width);
    const h = Number(line?.height);
    if (!(w > 0) || !(h > 0)) continue;
    const ideographs = text.match(IDEOGRAPH);
    if (ideographs === null || ideographs.length < 2) continue;
    const cx = (Number(line.x) + w / 2) / width;
    if (cx < 0.22 || cx > 0.78) continue;
    if (w > width * 0.85) continue;
    if (Number(line.y) + h > height * 0.97) continue;
    if (CHROME_WORDS.test(text) || URL_PATTERN.test(text)) continue;
    keep.push(text === raw ? line : { ...line, text });
  }
  return keep;
}

/**
 * 起一个字幕层。
 *
 * @param {{logger?: object, settingsFn?: () => object|null, screenFn?: () => {width: number, height: number}|null}} [deps]
 *   日志器；同步取当前设置（`companion` 里缓存的那份）；同步取屏幕尺寸（引擎就绪行给的）。
 * @returns {{sync: Function, observe: Function, onWindowChange: Function, takeForBatch: Function, off: Function, status: Function}} 句柄。
 */
export function createSubtitles(deps = {}) {
  const logger = deps.logger !== null && typeof deps.logger === 'object' ? deps.logger : {};
  const settingsFn = typeof deps.settingsFn === 'function' ? deps.settingsFn : () => null;
  const screenFn = typeof deps.screenFn === 'function' ? deps.screenFn : () => null;

  let lock = null;
  let mode = 'off';
  let pending = [];
  let lastRequest = '';
  /** 待机（idle）累计了多久：**总计**超过 `subtitleIdleMs`（默认 60 秒）就彻底停，等窗口变化。 */
  let idleTotalMs = 0;
  let idleLastAt = null;
  const stats = { locks: 0, noSubtitle: 0, idles: 0, resets: 0, linesIn: 0, candidates: 0, linesKept: 0, ocrErrors: 0, lastError: '', lastOcrMs: null };

  /** 现在的设置（整块读不到就当关）。 */
  const conf = () => {
    const settings = settingsFn();
    const screen = settings !== null && typeof settings === 'object' && settings.screen !== null && typeof settings.screen === 'object'
      ? settings.screen
      : {};
    const num = (value, fallback) => (Number.isFinite(value) ? value : fallback);
    const intervalMs = Math.max(250, num(screen.intervalMs, 2000));
    const idleScanMs = Math.max(intervalMs, num(screen.subtitleIdleScanMs, FALLBACK.idleScanMs));
    return {
      enabled: screen.subtitle === true,
      regionPercent: num(screen.subtitleRegionPercent, FALLBACK.regionPercent),
      probeMs: num(screen.subtitleProbeMs, FALLBACK.probeMs),
      maxLines: num(screen.subtitleMaxLines, FALLBACK.maxLines),
      maxChars: num(screen.subtitleMaxChars, FALLBACK.maxChars),
      idleMs: num(screen.subtitleIdleMs, FALLBACK.idleMs),
      idleScanMs,
      // 待机时"隔几拍看一次"：引擎按拍数跳，所以要把毫秒换算成拍数
      idleEvery: Math.min(120, Math.max(1, Math.round(idleScanMs / intervalMs))),
    };
  };

  /** 屏幕尺寸（引擎就绪行给的；拿不到就不做 OCR）。 */
  const screenSize = () => {
    const value = screenFn();
    if (value === null || typeof value !== 'object') return null;
    const width = Number(value.width);
    const height = Number(value.height);
    return width > 0 && height > 0 ? { width, height } : null;
  };

  /**
   * 当前状态该让引擎读哪一条（全分辨率像素）。
   * @param {object} config - 归一后的设置。
   * @param {{width: number, height: number}} size - 屏幕尺寸。
   * @returns {{mode: string, y?: number, h?: number, every?: number}} 请求。
   */
  const regionFor = (config, size) => {
    if (mode === 'locked' && lock !== null) {
      const st = lock.status();
      const sig = st.signature !== null && typeof st.signature === 'object' ? st.signature : null;
      const hn = sig !== null && Number.isFinite(sig.hn) && sig.hn > 0 ? sig.hn : 0.04;
      // 判定窗口是 ±bandRowSpan 行高；再多半行把"行自身"盖住
      const half = hn * (LOCK_DEFAULTS.bandRowSpan + 0.5) * size.height;
      const center = Number.isFinite(st.bandCy) ? st.bandCy * size.height : size.height * 0.9;
      const y = Math.max(0, Math.round(center - half));
      const h = Math.min(size.height - y, Math.round(half * 2));
      return { mode: 'band', y, h };
    }
    if (mode === 'probing' || mode === 'idle') {
      const h = Math.max(1, Math.round(size.height * config.regionPercent / 100));
      // 待机时**不每拍都认**：让引擎隔 `idleEvery` 拍看一次（这就是省 CPU 的那一刀）
      return mode === 'idle'
        ? { mode: 'idle', y: size.height - h, h, every: config.idleEvery }
        : { mode: 'probe', y: size.height - h, h };
    }
    return { mode: 'off' };
  };

  /** 把请求写给引擎（**只在变了才写**；引擎按 mtime 重读，切换不用重启进程）。 */
  const pushRequest = () => {
    const config = conf();
    const size = screenSize();
    if (config.enabled !== true || size === null) {
      if (lastRequest !== 'off') {
        writeOcrRequest({ mode: 'off' });
        lastRequest = 'off';
      }
      return;
    }
    const region = regionFor(config, size);
    // key 里必须带 `every`：probe → idle 时区域一样、只有"隔几拍"不同，漏了它就不会重写请求
    const key = `${String(region.mode)}:${String(region.y ?? 0)}:${String(region.h ?? 0)}:${String(region.every ?? 1)}`;
    if (key === lastRequest) return;
    writeOcrRequest(region);
    lastRequest = key;
  };

  /** 与设置对齐：开关、区域、预算的变化都在这里生效（陪看 3 秒监督每轮调一次）。 */
  const sync = () => {
    const config = conf();
    if (config.enabled !== true) {
      if (mode !== 'off' || lock !== null) {
        mode = 'off';
        lock = null;
        pending = [];
        idleTotalMs = 0;
        idleLastAt = null;
      }
      pushRequest();
      return;
    }
    if (lock === null) {
      lock = createSubtitleLock({ probeBudgetMs: config.probeMs });
      mode = 'probing';
      idleTotalMs = 0;
      idleLastAt = null;
    }
    pushRequest();
  };

  /**
   * 窗口/标题变化 → 重新给一次判定机会（**不是定时器**）：待机累计也一起清零。
   * 还没被取走的字幕行也清掉——它们是上一个窗口里的台词，不清的话会在下一批里
   * 被挂到新的前台窗口（比如你切去写代码）名下，既进提示词又写进屏幕记忆。
   */
  const onWindowChange = () => {
    if (conf().enabled !== true) return;
    if (lock === null) {
      sync();
      return;
    }
    lock.reset();
    mode = 'probing';
    pending = [];
    idleTotalMs = 0;
    idleLastAt = null;
    stats.resets += 1;
    pushRequest();
  };

  /**
   * 喂一拍 OCR 结果。
   * @param {object} ocr - 引擎那一行里的 `ocr`（`{ok, ms, y, h, w, lines}`）。
   * @returns {void} 完成。
   */
  const observe = (ocr) => {
    if (conf().enabled !== true) return;
    if (ocr === null || typeof ocr !== 'object') return;
    if (ocr.ok !== true) {
      stats.ocrErrors += 1;
      stats.lastError = typeof ocr.error === 'string' && ocr.error !== '' ? ocr.error : 'ocr-failed';
      return;
    }
    if (lock === null) sync();
    if (lock === null) return;
    const size = screenSize();
    if (size === null) return;
    stats.lastOcrMs = Number(ocr.ms) || 0;
    stats.linesIn += Array.isArray(ocr.lines) ? ocr.lines.length : 0;

    // 预筛：网页里的标题/订阅/话题标签先扔掉，只把"像字幕的候选行"交给锁判定
    const candidates = pickSubtitleCandidates(ocr.lines, size);
    stats.candidates += candidates.length;
    const at = stampOf(ocr.at);
    const config = conf();

    // ── 待机（idle）：低频扫着，等"像字幕的字"冒出来 ─────────────────────
    // 为什么要有这个态（2026-10-22 实测的坑）：预算烧完就彻底停的话，"打开视频先等一会儿 /
    // 开头是打戏没台词"这种情况会让整部片子再也没有字幕——标题不变就没有东西能触发重探。
    if (mode === 'idle') {
      if (idleLastAt !== null) idleTotalMs += Math.max(0, at - idleLastAt);
      idleLastAt = at;
      if (candidates.length > 0) {
        // 冒出字了 → 立刻回探测，重新给一次完整预算（累计时长留着，见下面 no_subtitle 的分支）
        lock.reset();
        mode = 'probing';
        idleLastAt = null;
        stats.resets += 1;
        logger.info?.('chat-widget: 待机时看到像字幕的字，重新开始判定');
      } else if (idleTotalMs >= config.idleMs) {
        mode = 'no_subtitle';
        stats.noSubtitle += 1;
        idleLastAt = null;
        logger.info?.(`chat-widget: 待机累计 ${String(Math.round(idleTotalMs / 1000))} 秒仍没字幕，停掉 OCR（换窗口再试）`);
        pushRequest();
        return;
      }
    }

    const result = lock.observe({ at, screen: size, lines: candidates });
    if (result.reason === 'lock') {
      mode = 'locked';
      stats.locks += 1;
      // 锁上了 = 这段内容确实有字幕：待机的累计时长清零
      idleTotalMs = 0;
      idleLastAt = null;
      // 锁定那一刻：探测期属于这条字幕带的行**整批**留下，跟下一批一起送（只送这一次）
      const backfill = Array.isArray(result.backfill) ? result.backfill : [];
      for (const item of backfill) pending.push({ text: item.text, at: item.at });
      // bandCy 可能不是有限数（regionFor 里就防了这一手）：日志别因此抛错，否则这一拍的请求更新会被吞掉
      const bandCy = lock.status().bandCy;
      const bandText = Number.isFinite(bandCy) ? bandCy.toFixed(3) : '未知';
      logger.info?.(`chat-widget: 字幕锁上了（带中心 ${bandText}，探测期带回 ${backfill.length} 行）`);
    } else if (result.reason === 'no_subtitle') {
      // 预算到点没锁上 → 不彻底停，转**待机低频扫**；累计够 idleMs 才真停
      mode = 'idle';
      stats.idles += 1;
      idleLastAt = at;
      logger.info?.(`chat-widget: ${String(Math.round(config.probeMs / 1000))} 秒没锁上，转待机低频扫（每 ${String(Math.round(config.idleScanMs / 1000))} 秒看一眼，累计 ${String(Math.round(config.idleMs / 1000))} 秒还没就走人）`);
    } else if (result.reason === 'unlock') {
      mode = 'probing';
      stats.resets += 1;
    }
    if (Array.isArray(result.accepted)) {
      for (const item of result.accepted) pending.push({ text: item.text, at: item.at });
    }
    if (pending.length > PENDING_CAP) pending = pending.slice(-PENDING_CAP);
    pushRequest();
  };

  /**
   * 取这一批要带的字幕（取走即清空）。
   *
   * 取**最新的** `subtitleMaxLines` 条（新台词配新画面），总字数按 `subtitleMaxChars` 收口。
   *
   * 注意顺序：**先查重、再数名额**。反过来的话，锁定那一刻 backfill 的最后一句和
   * `accepted` 里的同一句会占掉两个名额（自检里就踩到了：5 条里其实只有 3 句不同的台词，
   * 却只带出 2 句）。
   *
   * @returns {{lines: {text: string, at: number}[], text: string}} 行与拼好的原文（写库用）。
   */
  const takeForBatch = () => {
    const config = conf();
    if (pending.length === 0) return { lines: [], text: '' };
    const source = pending;
    pending = [];
    const picked = [];
    const seen = new Set();
    let chars = 0;
    for (let i = source.length - 1; i >= 0; i -= 1) {
      const item = source[i];
      const text = String(item.text === undefined || item.text === null ? '' : item.text).trim();
      if (text.length < MIN_LINE_CHARS) continue;
      if (seen.has(text)) continue;
      if (picked.length >= config.maxLines) break;
      if (picked.length > 0 && chars + text.length > config.maxChars) break;
      seen.add(text);
      picked.push({ text, at: stampOf(item.at) });
      chars += text.length;
    }
    picked.reverse();
    stats.linesKept += picked.length;
    return { lines: picked, text: picked.map((item) => item.text).join(' / ').slice(0, 1000) };
  };

  /** 停掉字幕层（陪看停了/开关关了）：让引擎别再 OCR。 */
  const off = () => {
    lock = null;
    mode = 'off';
    pending = [];
    idleTotalMs = 0;
    idleLastAt = null;
    writeOcrRequest({ mode: 'off' });
    lastRequest = 'off';
  };

  /** 状态（给 `/screen/status` 与界面用）。 */
  const status = () => {
    const config = conf();
    return {
      mode,
      pending: pending.length,
      regionPercent: config.regionPercent,
      locks: stats.locks,
      noSubtitle: stats.noSubtitle,
      idles: stats.idles,
      resets: stats.resets,
      linesIn: stats.linesIn,
      candidates: stats.candidates,
      linesKept: stats.linesKept,
      ocrErrors: stats.ocrErrors,
      lastOcrMs: stats.lastOcrMs,
      lastError: stats.lastError,
      /** 待机：已经累计多久 / 还剩多久（毫秒）——界面显示"待机中"用得上。 */
      idleTotalMs: Math.round(idleTotalMs),
      idleLeftMs: Math.max(0, Math.round(config.idleMs - idleTotalMs)),
      idleScanMs: config.idleScanMs,
      lock: lock === null ? null : lock.status(),
    };
  };

  return { sync, observe, onWindowChange, takeForBatch, off, status };
}
