/**
 * @local/chat-widget —— 字幕锁定（字幕带的一次性判定）。
 *
 * 从 `_backup\dsh-chat-widget-before-shell-20261014-213701\dsh-chat-widget\perceive\subtitle-lock.js`
 * （415 行版，当时 9 个合成用例全过）原样复活，**只加了你点头的那一条**：
 *   **条带平移跟踪**——字幕带整体上下挪（鼠标碰进度条把它顶上去、黑边变化）时，
 *   锁定后的窗口跟着走：以**最近几条的中位 cy** 为中心、上下各 `bandRowSpan`（默认 2）**行高**。
 *   原来是"以初始簇的 cyMin/cyMax 外扩 1.6 行高"的**死窗口**，挪 2 行高就被判成"不像字幕"了。
 *
 * ## 它解决什么
 *
 * 单看一行 OCR 文字，字幕和「场景招牌 / 游戏 HUD / 代码注释 / 网页正文」分不开。
 * 所以不看"这行字像不像字幕"，而看**一小段时间内的行为**：
 *   - 字幕：位置与字高固定、整行突然出现又整行消失、每句内容都不同、同屏 1~3 行、水平居中；
 *   - HUD / 水印：长时间一字不变；
 *   - 计数器 / 进度：在原地只改几个字（相似度很高）；
 *   - 场景文字：位置与大小随镜头变；
 *   - 文档式画面（网页/代码/片尾）：同屏一大片文字。
 *
 * ## 一次定生死，15 秒
 *
 *   probing（最多 probeBudgetMs=15s，设置项 `screen.subtitleProbeMs`）
 *     ├─ 攒够证据 → locked：记下字幕带签名，**只读这条带**；并把 probing 期间
 *     │                      属于这条带的行**整批打包**交给模型（判定是字幕就不丢）
 *     └─ 到点没攒够 → no_subtitle：**停 OCR**
 *
 * **重新检测的触发是"窗口监测检测到窗口变化"**（调用方在窗口/标题变化时 `reset()`），
 * **不是定时器**、也没有"每 N 分钟自动重试"。
 *
 * 删掉的东西（旧版有、这里**不要**）：
 *   120 秒证据窗口、`noneAfterMs` 90 秒、ASR 人声耦合（voice*）、镜头耦合比率
 *   （startCut/endCut/maxCutCoupledRatio）、复杂解锁（unlockAfterMs/unlockMinCuts）、
 *   busyFrames/frames/intervalMs 统计、以及引擎侧的选带打分与逐行变化比对。
 *
 * 保留的东西（都是零成本算术，且是"字幕 vs 场景文字"的关键区分）：
 *   编辑距离相似度（识别"原地改字"）、静态判定、居中判定、字高/位置稳定性判定。
 *
 * ## 用法
 *
 *   const lock = createSubtitleLock();
 *   const r = lock.observe({
 *     at: Date.now(),
 *     screen: { width: 1920, height: 1080 },
 *     lines: [{ text: '我要修炼', x: 810, y: 950, width: 300, height: 44 }], // 屏幕像素，y 为行框上沿
 *   });
 *   r.state     // 'probing' | 'locked' | 'no_subtitle'
 *   r.accepted  // 本帧新出现、且符合字幕带签名的行（locked 才有）
 *   r.backfill  // 刚锁定的这一帧才有：probing 期间属于这条字幕带的**全部**行（按时间序，已合并重复）
 *   r.reason    // '' | 'lock' | 'no_subtitle' | 'unlock'
 *
 * 纯函数式、零依赖、可离线喂合成数据测试（见 `check-subtitle.mjs`）。
 *
 * @module @local/chat-widget/host/subtitle-lock
 */

/** 默认参数。阈值可按真实片源回放微调；区间由自检核对。 */
export const DEFAULT_OPTIONS = Object.freeze({
  /**
   * probing 的总预算（设置项 `screen.subtitleProbeMs`，默认 15 秒）：
   * 超过它就判定"这段内容没有字幕"，停 OCR。
   * 重新检测不由定时器触发，而是**由窗口监测检测到窗口变化时**调用 `reset()` 重新开始。
   */
  probeBudgetMs: 15_000,
  /** 同屏超过这么多行，判为"文档式画面"，本帧不参与。 */
  maxLines: 4,
  /** 一行连续存在超过这么久，视为静态（HUD / 水印），不当证据。 */
  maxLifeMs: 15_000,
  /** 连续漏识别几帧还算同一行（OCR 偶发抖动）。 */
  graceFrames: 2,
  /** 同一位置、文字相似度 >= 它算同一行；低于它算"原地换了一句"。 */
  sameTextSim: 0.6,
  /** 判定"同一位置"的容差（屏幕宽高的比例）。 */
  trackCyTol: 0.035,
  trackCxTol: 0.08,
  /** 聚类：纵向位置容差、字高相对容差。 */
  clusterCyTol: 0.035,
  clusterHnRel: 0.25,
  /** 锁定条件：证据条数、互不相同的句子数、证据时间跨度。 */
  minEvents: 3,
  minDistinct: 3,
  minSpanMs: 4_000,
  /** 字幕应当水平居中：证据行水平中心的中位数与 0.5 的偏差上限。 */
  centerTol: 0.22,
  /** 相邻证据的平均相似度上限：高于它说明是"原地改几个字"（计数器/进度）。 */
  maxSuccessiveSim: 0.6,
  /** 锁定后的签名匹配：字高相对容差、水平中心容差。 */
  sigHnRel: 0.3,
  sigCxTol: 0.2,
  /**
   * **条带整体平移的容忍度（行高倍数）**：判定窗口 = 最近几条的中位 cy ± 这个值 × 行高。
   * 2 = 上下各两行高的活动范围：进度条把字幕顶上去、黑边变化让条带整体挪一两行都跟得住。
   */
  bandRowSpan: 2,
  /** 中位 cy 取最近几条（丢老样本，条带才能跟着慢慢挪）。 */
  bandSamples: 5,
  /** 锁定后多久没有新台词就退回 probing（重新给一次 15 秒预算）。 */
  unlockIdleMs: 30_000,
  /** 打包交给模型的行数上限。 */
  maxPackLines: 20,
});

/** 归一化文字：去空白。 */
function normalizeText(value) {
  return String(value === undefined || value === null ? '' : value).replace(/\s+/g, '');
}

/**
 * 文字相似度（0~1）：1 − 编辑距离 / 较长一方长度。
 *
 * 为什么不用二元组 Jaccard：计数器 `连击数量11次` → `连击数量12次` 只改一个字，
 * 二元组 Jaccard 只有 0.5（短文本二元组太少）→ 会被误当成"新台词"；
 * 编辑距离是 0.86，能正确认出"原地改了几个字"。两句不同台词的相似度通常低于 0.3。
 *
 * @param {string} a - 归一化文字 a。
 * @param {string} b - 归一化文字 b。
 * @returns {number} 相似度。
 */
export function textSimilarity(a, b) {
  if (a === b) return 1;
  if (a === '' || b === '') return 0;
  const x = a.length > 80 ? a.slice(0, 80) : a;
  const y = b.length > 80 ? b.slice(0, 80) : b;
  let prev = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i += 1) {
    const cur = [i];
    for (let j = 1; j <= y.length; j += 1) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return 1 - prev[y.length] / Math.max(x.length, y.length);
}

/** 中位数（空数组为 0）。 */
function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((x, y) => x - y);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * 是不是"同一行在原地逐字长出来"（打字机 / 思考链跳动 / 终端进度）。
 *
 * 实时聊天界面、AI 的思考链、终端进度输出，都是**在原地一个字一个字地长**：
 * 这类变化若被当成"换了一句台词"，就会源源不断造出证据。
 * 判据很便宜也很确定：一方的文字是另一方的前缀（`你` → `你好` → `你好啊`）。
 *
 * @param {string} a - 上一帧文字（已归一化）。
 * @param {string} b - 这一帧文字（已归一化）。
 * @returns {boolean} 是否属于"逐字长出来"。
 */
export function isProgressive(a, b) {
  if (a === '' || b === '' || a === b) return false;
  return b.startsWith(a) || a.startsWith(b);
}

/** 全新的内部状态。 */
function freshState() {
  return {
    mode: 'probing',
    since: null,
    tracks: [],
    events: [],
    seen: [],
    signature: null,
    /** 锁定后条带中心（最近几条的中位 cy），随条带整体平移。 */
    bandCy: 0.5,
    bandSamples: [],
    lockedAt: 0,
    lastAcceptedAt: 0,
    lastAcceptedText: '',
    frames: 0,
    busyFrames: 0,
  };
}

/**
 * 创建一个字幕锁定器。
 * @param {Partial<typeof DEFAULT_OPTIONS>} [userOptions] - 覆盖默认参数。
 * @returns {{observe: Function, reset: Function, status: Function}} 锁定器。
 */
export function createSubtitleLock(userOptions = {}) {
  const o = { ...DEFAULT_OPTIONS, ...userOptions };
  let st = freshState();

  /** 一条结束的轨道 → 证据（静态轨道不算证据）。 */
  function finishTrack(track) {
    if (track.static === true) return;
    st.events.push({
      at: track.firstAt,
      text: track.text,
      cy: track.cy,
      cx: track.cx,
      hn: track.hn,
      lifeMs: track.lastAt - track.firstAt,
    });
  }

  /**
   * 把一条**落在字幕带里**的行的 cy 记进跟踪样本（丢最老的），重算条带中心。
   * @param {number} cy - 该行纵向中心（屏高比例）。
   */
  function pushBand(cy) {
    st.bandSamples.push(cy);
    if (st.bandSamples.length > o.bandSamples) st.bandSamples.shift();
    st.bandCy = median(st.bandSamples);
  }

  /** 一簇证据是否满足锁定条件。 */
  function clusterQualifies(cluster) {
    // 同一句话（OCR 错一字的变体）只算一条
    const sentences = [];
    for (const e of cluster) {
      if (sentences.every((t) => textSimilarity(t, e.text) < o.sameTextSim)) sentences.push(e.text);
    }
    if (cluster.length < o.minEvents) return false;
    if (sentences.length < o.minDistinct) return false;
    const sorted = [...cluster].sort((x, y) => x.at - y.at);
    if (sorted[sorted.length - 1].at - sorted[0].at < o.minSpanMs) return false;
    if (Math.abs(median(cluster.map((e) => e.cx)) - 0.5) > o.centerTol) return false;
    let simSum = 0;
    for (let i = 0; i < sorted.length - 1; i += 1) simSum += textSimilarity(sorted[i].text, sorted[i + 1].text);
    if (simSum / (sorted.length - 1) > o.maxSuccessiveSim) return false;
    return true;
  }

  /** 在证据里找一簇合格的；找到就锁定。 */
  function tryLock(at) {
    let best = null;
    for (const seed of st.events) {
      const cluster = st.events.filter(
        (e) => Math.abs(e.cy - seed.cy) <= o.clusterCyTol && Math.abs(e.hn - seed.hn) <= seed.hn * o.clusterHnRel,
      );
      if ((best === null || cluster.length > best.length) && clusterQualifies(cluster)) best = cluster;
    }
    if (best === null) return null;
    const hn = median(best.map((e) => e.hn));
    st.signature = {
      cyMin: Math.min(...best.map((e) => e.cy)),
      cyMax: Math.max(...best.map((e) => e.cy)),
      cxMin: Math.min(...best.map((e) => e.cx)),
      cxMax: Math.max(...best.map((e) => e.cx)),
      hn,
    };
    // 条带中心从这一簇起步，之后靠 pushBand 跟着条带挪
    st.bandSamples = best.map((e) => e.cy);
    st.bandCy = median(st.bandSamples);
    st.mode = 'locked';
    st.lockedAt = at;
    st.lastAcceptedAt = at;
    return [...best].sort((x, y) => x.at - y.at);
  }

  /**
   * 一行是否符合锁定的字幕带签名。
   *
   * 判定窗口 = `bandCy ± bandRowSpan × 行高`（**活窗口**，跟着条带挪）；
   * 字高用两边的平均，字高本身有 30% 相对容差（黑边变化会让同一行字幕的字高略变）。
   */
  function matchesSignature(item) {
    const sig = st.signature;
    if (sig === null) return false;
    if (Math.abs(item.hn - sig.hn) > sig.hn * o.sigHnRel) return false;
    const limit = ((item.hn + sig.hn) / 2) * o.bandRowSpan;
    if (Math.abs(item.cy - st.bandCy) > limit) return false;
    return Math.abs(item.cx - (sig.cxMin + sig.cxMax) / 2) <= o.sigCxTol;
  }

  /**
   * 喂一帧 OCR 结果。
   * @param {{at: number, screen: {width: number, height: number}, lines: object[]}} frame - 一帧。
   * @returns {{state: string, accepted: object[], backfill: object[], reason: string}} 判定结果。
   */
  function observe(frame) {
    const at = Number(frame.at);
    const width = Number(frame.screen?.width);
    const height = Number(frame.screen?.height);
    const result = { state: st.mode, accepted: [], backfill: [], reason: '' };
    if (!Number.isFinite(at) || !(width > 0) || !(height > 0)) return result;

    st.frames += 1;
    if (st.since === null) st.since = at;

    // ── 归一化本帧文字行（坐标变比例，与分辨率 / DPI 无关）──────────────────
    let items = [];
    for (const line of Array.isArray(frame.lines) ? frame.lines : []) {
      const text = normalizeText(line?.text);
      const w = Number(line?.width);
      const h = Number(line?.height);
      if (text.length < 2 || !(w > 0) || !(h > 0)) continue;
      items.push({
        text,
        cy: (Number(line.y) + h / 2) / height,
        cx: (Number(line.x) + w / 2) / width,
        hn: h / height,
      });
    }
    // 同屏行数太多 = 文档式画面：本帧不产生证据、也不放行任何文字
    if (items.length > o.maxLines) {
      st.busyFrames += 1;
      items = [];
    }

    // ── 接到已有轨道上；接不上的开新轨道 ────────────────────────────────────
    //
    // 关键提速：**位置相同但文字换了** = 上一句已经说完，此刻立刻把它记成证据。
    // 旧版要等轨道"漏识别 graceFrames 帧后自然结束"才登记证据，凭空晚 2~3 秒——
    // 3 条证据就要 10 秒，正好卡死在预算上。字幕被下一句顶掉的那一刻本来就是它的终点。
    const matched = new Set();
    const created = [];
    for (const item of items) {
      const positioned = st.tracks.filter(
        (track) => matched.has(track) !== true
          && Math.abs(track.cy - item.cy) <= o.trackCyTol
          && Math.abs(track.cx - item.cx) <= o.trackCxTol,
      );
      let same = null;
      let bestSim = -1;
      for (const track of positioned) {
        const sim = textSimilarity(track.text, item.text);
        // 同一行 = 文字够像，**或者**这一行正在原地逐字长出来（打字机 / 思考链跳动 / 终端进度）。
        // 后者必须算同一行：否则每一帧增长都会被当成"换了一句台词"，凭空造出证据。
        const ok = sim >= o.sameTextSim || isProgressive(track.text, item.text) === true;
        if (ok === true && sim > bestSim) {
          same = track;
          bestSim = sim;
        }
      }
      if (same !== null) {
        matched.add(same);
        same.lastAt = at;
        same.missed = 0;
        same.text = item.text;
        // 位置跟着这一帧走：条带整体平移时，同一句还在原地继续显示的情况也要跟得住
        same.cy = item.cy;
        same.cx = item.cx;
        same.hn = item.hn;
        if (at - same.firstAt > o.maxLifeMs) same.static = true;
        continue;
      }
      if (positioned.length > 0 && st.mode !== 'locked') {
        const ended = positioned[0];
        finishTrack(ended);
        st.tracks = st.tracks.filter((track) => track !== ended);
      }
      const track = { firstAt: at, lastAt: at, text: item.text, cy: item.cy, cx: item.cx, hn: item.hn, missed: 0, static: false };
      st.tracks.push(track);
      matched.add(track);
      created.push({ item });
      // probing 期间见到的每一行都留着：锁定后按签名筛出属于这条字幕带的，整批交给模型
      // （**这 15 秒的内容判定是字幕就不丢**）
      if (st.mode === 'probing') st.seen.push({ text: item.text, at, cy: item.cy, cx: item.cx, hn: item.hn });
    }

    // ── 本帧没接上的轨道：容忍漏识别几帧，否则结束并变成证据 ────────────────
    const alive = [];
    for (const track of st.tracks) {
      if (matched.has(track) === true) {
        alive.push(track);
        continue;
      }
      track.missed += 1;
      if (track.missed > o.graceFrames) {
        if (st.mode !== 'locked') finishTrack(track);
      } else {
        alive.push(track);
      }
    }
    st.tracks = alive;

    // ── 状态转换 ────────────────────────────────────────────────────────────
    if (st.mode === 'probing') {
      const cluster = tryLock(at);
      if (cluster !== null) {
        result.reason = 'lock';
        // 打包：probing 期间**所有**属于这条字幕带的行（含此刻屏幕上的那一句），
        // 按时间排序、相邻重复合并、限长——整批交给模型，不丢内容
        const band = st.seen
          .filter((e) => matchesSignature(e) === true)
          .sort((x, y) => x.at - y.at);
        const packed = [];
        for (const e of band) {
          if (packed.length === 0 || textSimilarity(packed[packed.length - 1].text, e.text) < o.sameTextSim) {
            packed.push({ text: e.text, at: e.at });
          }
        }
        result.backfill = packed.slice(-o.maxPackLines);
        st.events = [];
        st.seen = [];
      } else if (at - st.since >= o.probeBudgetMs) {
        // 15 秒到点没锁上：这段内容就是没字幕，停 OCR；
        // 下一次检测由**窗口监测检测到窗口变化**时 reset() 触发（不是定时器）
        st.mode = 'no_subtitle';
        st.tracks = [];
        st.events = [];
        st.seen = [];
        result.reason = 'no_subtitle';
      }
    }

    if (st.mode === 'locked') {
      for (const { item } of created) {
        if (matchesSignature(item) !== true) continue;
        // 落在带里 → 更新条带中心（这一句可能比上一句高/低一点，条带就是这么"挪"起来的）
        pushBand(item.cy);
        // 与上一句太像 = 原地改字 / 复读，不算新台词
        if (textSimilarity(st.lastAcceptedText, item.text) >= o.sameTextSim) continue;
        result.accepted.push({ text: item.text, at, cy: item.cy, hn: item.hn });
      }
      if (result.accepted.length > 0) {
        st.lastAcceptedAt = at;
        st.lastAcceptedText = result.accepted[result.accepted.length - 1].text;
      } else if (at - st.lastAcceptedAt >= o.unlockIdleMs) {
        // 很久没有新台词 → 重新给一次 15 秒预算
        st = { ...freshState(), since: at };
        result.reason = 'unlock';
      }
    }

    result.state = st.mode;
    return result;
  }

  /** 重置（**由窗口监测检测到窗口/标题变化时调用**，开始新一轮 15 秒判定）。 */
  function reset() {
    st = freshState();
  }

  /** 当前状态（给状态接口/界面用）。 */
  function status() {
    return {
      mode: st.mode,
      since: st.since,
      frames: st.frames,
      busyFrames: st.busyFrames,
      pendingEvents: st.events.length,
      activeTracks: st.tracks.length,
      lockedAt: st.lockedAt,
      lastAcceptedAt: st.lastAcceptedAt,
      signature: st.signature,
      /** 当前条带中心（屏高比例）与跟踪样本数：调参/排查时看它有没有跟着挪。 */
      bandCy: st.bandCy,
      bandSamples: st.bandSamples.length,
    };
  }

  return { observe, reset, status };
}
