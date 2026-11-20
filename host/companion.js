/**
 * @local/chat-widget —— 屏幕陪看编排器（阶段 5）：把已经做好的几块接成一条闭环。
 *
 *   capture 引擎 → 帧队列 → 拼图 → 一次视觉调用 → ① say：落聊天库（autonomous=1）→ SSE 推进聊天框
 *                                               ② saw/facts：落屏幕记忆库（独立，不碰聊天记忆）
 *   窗口监测 → 每次前台变化全量落 window_events
 *   音轨识别 → 最近听到的几行**只当参考**塞进同一次视觉调用（识别结果不入库）
 *
 * 开关：`perceive.companion`（关上就停引擎、清队列；开着最多 3 秒生效）。
 * 冷却：`screen.speakCooldownMs`（默认 3 秒）—— 宿主唯一的硬闸；"要不要说、说什么"由模型判断。
 *
 * @module @local/chat-widget/host/companion
 */

import { listMessages } from '../store.js';
import { cosine } from './memory.js';
import { createFrameBatcher } from './screen-batch.js';
import { writeScreenFrame, writeWindowEvent } from './screen-memory.js';
import { analyzeScreenBatch } from './screen-vision.js';
import { readSettings, isKeywordEmbedding, resolveApiKey } from './settings.js';
import { resolveStoreDir } from '../store.js';
import { callUpstreamEmbed } from './upstream.js';
import { startScreenCapture } from './screen-capture.js';
import { createSubtitles } from './subtitles.js';
import { createSpeech } from './speech.js';
import { startAudioCapture } from './audio-capture.js';

/** 开关监督间隔：滑块一开一关最多 3 秒生效。 */
const SUPERVISE_MS = 3000;

/** 提示词里"最近聊天"至少取多少条消息（设置里的 chatContext 更大时以设置为准）。 */
const CHAT_FETCH = 20;

/** 开口向量比的门槛：与最近 3 句的余弦 ≥ 它就当"换皮重说"，不发出。 */
const SIMILAR_SAY = 0.82;

/**
 * 两句话之间的**最小**间隔（毫秒）。
 *
 * 节奏由批处理时间窗控制（= 设置里的「开口冷却」），这里只做最后一道防连喷：
 * 窗口设成 0 且模型快得离谱时，别让一句话一秒钟喷好几次。
 */
const MIN_SPEAK_GAP_MS = 1000;

/**
 * 「刚说过的话 / 最近聊天」只认这么久以内的（毫秒）。
 *
 * 实测（2026-11-09）：在浏览器里聊完、切到 EVE，隔了近 18 小时，它开口还是
 * "删插件、关标签、吃内存"——因为这两个上下文取的是库里**最后 N 条**，
 * 不看它们是多久以前说的。旧话题一旦进提示词，模型就顺着旧话题往下接，
 * 眼前的游戏画面只被当成背景。跨场景串味的源头就在这里。
 */
const CONTEXT_FRESH_MS = 30 * 60 * 1000;

/** 引擎起不来（抛异常）之后，隔多久才再试一次，免得每 3 秒刷一遍日志、重复起进程。 */
const RETRY_START_MS = 15000;

/**
 * 起一个陪看编排器。
 *
 * @param {{logger: object, hub: object, watch: object, readSettingsFn?: Function,
 *   getSpeechToText?: Function}} deps - 日志器、事件中心、窗口监测、读设置（可注入，自检用）、
 *   取 `speechToText` 服务的函数（可注入：服务没装时返回 null）。
 * @returns {{start: () => void, stop: () => void, refresh: () => void, status: () => object}} 句柄。
 */
export function createCompanion(deps) {
  const logger = deps.logger;
  const hub = deps.hub;
  const watch = deps.watch;
  const readSettingsFn = typeof deps.readSettingsFn === 'function' ? deps.readSettingsFn : readSettings;
  // 语音识别服务（DSH 自带 SenseVoice）—— **惰性取**：它可能还没挂上，也可能这个 profile 根本没装
  const getSpeechToText = typeof deps.getSpeechToText === 'function' ? deps.getSpeechToText : () => null;

  const state = {
    enabled: false,
    running: false,
    blocked: null,
    lastSpokeAt: 0,
    lastSay: '',
    said: [],
    saidVecs: [],
    saws: [],
    calls: 0,
    failures: 0,
    /** 最近一次视觉调用耗时（毫秒）。之前只算不记，导致"一次调用到底多慢"全靠猜。 */
    lastCostMs: 0,
    /** 累计耗时与次数（`status()` 里算平均）。 */
    costTotalMs: 0,
    costCount: 0,
    /** 因为窗口切换而作废的批次数（在途那批想完了也不说）。 */
    staleDropped: 0,
    repeatBlocked: 0,
    langBlocked: 0,
    lastError: '',
    lastSaw: '',
    lastFacts: 0,
    speakBlocked: 0,
  };
  // 最近的窗口变化：截图帧要靠它补上 app/title（引擎只报帧，不掺和窗口）
  const recentWindows = [];

  /** 取某个时刻前台是谁（不晚于它的最近一条窗口变化）。 */
  const windowAt = (at) => {
    let found = null;
    for (const item of recentWindows) {
      if (item.at <= at) found = item;
      else break;
    }
    return found;
  };
  let capture = null;
  let batcher = null;
  let subtitles = null;
  let speech = null;
  /** 最近一次读到的设置（字幕层要**同步**拿到它，所以在这里缓存一份）。 */
  let lastSettings = null;
  /** 需要重启引擎才能生效的那几个设置的指纹（间隔/灵敏度/字幕开关/目录）。 */
  let runningSignature = '';
  let superviseTimer = null;
  let stopped = false;
  let busy = false;
  let unsubscribe = null;
  /** 运行代号：每次起/停都 +1。在途的那一批靠它判断"我这一轮已经被停掉/重启了"，作废自己。 */
  let session = 0;
  /**
   * 窗口代号：**前台窗口/标签页一变就 +1**。
   *
   * 用户要求：「切窗口后别再说上一个窗口积压、正在思考的内容，直接开始新的」。
   * 在途的那一批拿到的是旧窗口的截图和字幕，想完再念出来就是"过时的话"。
   * 所以窗口一变就：abort 掉视觉请求 + 丢掉排队帧 + 让在途那批自己作废。
   */
  let windowEpoch = 0;
  /** 当前在途视觉请求的取消器（切窗口时 abort）。 */
  let visionAbort = null;
  /**
   * 最近一次窗口/标题变化的时间戳。
   *
   * 光靠 `windowEpoch` 隔离不住：批处理器是**先把帧从队列里取走、再去拼图**，
   * 拼图那几百毫秒里窗口变了，`reset()` 已经清不到这批帧了；等拼完再回调，
   * `handleBatch` 取的又是**新的** epoch → 判定"没变"，于是照样把旧画面念出来
   * （用户实测：切窗口后还在说上一个视频）。
   *
   * 所以改成比**帧的时间**：一批里最新的帧如果早于这次窗口变化，整批丢掉。
   */
  let lastWindowChangeAt = 0;
  /**
   * 换窗口后的静默期：这段时间内的帧先不收。
   *
   * **只对浏览器生效**（用户要求）：白屏 + 转圈是浏览器渲染出来的东西；
   * 任务管理器、资源管理器这种"瞅一眼就切走"的窗口等 2.5 秒就什么都看不到了 —— 它得能看见。
   */
  const SETTLE_BROWSER_MS = 2500;
  const SETTLE_OTHER_MS = 0;
  /** 会被加静默期的进程（小写比较）。要加别的浏览器往这里塞。 */
  const BROWSER_PROCESSES = new Set(['firefox', 'chrome', 'msedge', 'brave', 'opera', 'vivaldi', 'chromium']);
  let settleUntil = 0;
  /** 引擎起失败后，最早什么时候才允许再起。 */
  let nextStartAt = 0;

  /** 读一次设置（失败返回 null）。 */
  const load = async () => {
    try {
      const { settings } = await readSettingsFn(logger);
      lastSettings = settings;
      return settings;
    } catch (error) {
      state.lastError = String(error);
      return null;
    }
  };

  /**
   * 需要重启引擎才生效的设置指纹。
   *
   * @param {object} settings - 当前设置。
   * @returns {string} 指纹。
   */
  const engineSignature = (settings) => [
    settings.store.dir,
    String(settings.screen.intervalMs),
    String(settings.screen.sensitivity),
    settings.screen.subtitle === true ? 'sub' : 'nosub',
    // OCR 语言也是**命令行参数**（引擎启动时建识别器）→ 换语言得重启引擎
    String(settings.screen.subtitleLangs ?? 'zh-Hans-CN'),
  ].join('|');

  /** 处理一批帧：一次视觉调用 → 两个库 + 可能开口。 */
  const handleBatch = async (frames, composedPath) => {
    const mySession = session;
    const myBatcher = batcher;
    // 这一批属于哪个窗口：视觉调用期间窗口一变，结果就作废（别把旧窗口的想法念给新窗口听）
    const myEpoch = windowEpoch;
    // 同步先占位：下面 load() 要等一会儿，这段时间不能让队列再放一批进来
    busy = true;
    if (myBatcher !== null) myBatcher.markBusy();
    try {
      const settings = await load();
      if (settings === null) return;
      if (settings.perceive.companion !== true) return;
      if (mySession !== session) return;
      if (Array.isArray(frames) === false || frames.length === 0) return;

      const messages = listMessages(settings.store.dir, {
        limit: Math.max(CHAT_FETCH, Number(settings.screen.chatContext) || 0),
      });
      const history = messages.ok === true ? messages.value : [];
      // 只把「还不算旧」的话当上下文（见 CONTEXT_FRESH_MS）：隔了很久的话题一律不进提示词，
      // 宁可让它只看眼前这一屏。没有时间戳的行无法判断，当新鲜处理（不误删）。
      const freshSince = Date.now() - CONTEXT_FRESH_MS;
      const fresh = history.filter((m) => {
        const at = Number(m.createdAt);
        return Number.isFinite(at) === false || at === 0 || at >= freshSince;
      });
      // 语气隔离：只说「当前模式下」自己说过的话；另一个模式的话单独作为背景给（他知道，但不照抄语气）。
      const currentMode = settings.perceive.focus === true ? 'focus' : 'play';
      const mine = fresh.filter((m) => m.role === 'assistant' && m.autonomous === true);
      const said = mine.filter((m) => m.mode === currentMode).slice(-settings.screen.saidContext).map((m) => m.content);
      // 库里没有新鲜的（停了半小时以上）时，退回本进程内存里最近说的几句：
      // 下面那道"复读闸"用的就是内存名单，提示词里必须给同一批，否则模型不知道
      // 自己刚说过什么、一直撞闸，表现成"越说越少"。
      const saidLines = said.length > 0 ? said : state.said.slice(-settings.screen.saidContext);
      const otherLines = mine
        .filter((m) => typeof m.mode === 'string' && m.mode !== currentMode)
        .slice(-2)
        .map((m) => m.content);
      const otherModeText = otherLines.length === 0 ? '' : (otherLines
        .map((line) => `「${line}」`)
        .join('') + `——那是更早在${currentMode === 'focus' ? '娱乐' : '专注'}模式里你说的，现在不是那个模式，别沿用那个语气。`);
      const chat = fresh.slice(-settings.screen.chatContext).map((m) => ({ role: m.role, content: m.content, mode: m.mode }));

      // 给这批帧补上"当时前台是谁"：屏幕记忆的 app/title 与提示词都靠它。
      // **必须每帧各查各的**：一格里可能跨窗口（第 1 张是切换前的桥接帧），
      // 全用最后一帧的标题会让模型以为"刚才也在新窗口里"（实测它就说过
      // "这视频我一直在看"，其实是刚切过来的）。
      const lastFrame = frames[frames.length - 1];
      const fallbackWhere = windowAt(Number(lastFrame.at) || Date.now()) ?? { process: '', title: '' };
      const framesWithWhere = frames.map((frame) => {
        const at = Number(frame.at);
        const found = Number.isFinite(at) ? windowAt(at) : null;
        const w = found ?? fallbackWhere;
        return { ...frame, process: w.process, title: w.title };
      });
      // 屏幕记忆与日志用最后一帧的窗口（这一批"结果"落在哪）
      const where = framesWithWhere[framesWithWhere.length - 1] ?? fallbackWhere;

      // 字幕层：这一批要带的字幕原文（取走即清空；锁定那批会带上探测期攒下的行）
      const subtitle = subtitles === null ? { lines: [], text: '' } : subtitles.takeForBatch();
      // 音轨层：最近听到的几句（**只做参考、不清空**；识别结果不入库）
      const heard = speech === null ? { lines: [] } : speech.takeForBatch(settings);

      // 「你最近几帧看到过」要**宽松去重**再给：同一屏反复截，模型写的 saw 几乎是同一个意思
      // （实测 20 条里 16 条都在说"DeepSeek 配置窗口挡住操作"）。原样塞 6 条同义句回去，
      // 等于替它把话题钉死在那个槽点上——它不是没看见新画面，是被自己的旧账拉住了。
      const sawKeys = [];
      const sawLines = [];
      for (let i = state.saws.length - 1; i >= 0 && sawLines.length < settings.screen.sawContext; i -= 1) {
        const line = String(state.saws[i] ?? '').trim();
        const key = line.replace(/[\s，。！？、；：,.!?;:'"「」『』（）()\-—…~]/g, '');
        if (key === '') continue;
        const dup = sawKeys.some((prev) => prev === key
          || (key.length > 4 && prev.includes(key))
          || (prev.length > 6 && key.includes(prev)));
        if (dup) continue;
        sawKeys.push(key);
        sawLines.unshift(line);
      }

      // 这一批的取消器：窗口一变就 abort，省掉白花的 token，也不用等它想完
      const controller = new AbortController();
      visionAbort = controller;
      const result = await analyzeScreenBatch({
        logger,
        settings,
        frames: framesWithWhere,
        signal: controller.signal,
        context: {
          said: saidLines,
          saws: sawLines,
          chat,
          // 没开专注模式 → 陪玩（不许说教、不许催干活）
          mode: currentMode,
          otherMode: otherModeText,
          subtitles: subtitle.lines,
          speeches: heard.lines,
        },
      });
      state.calls += 1;
      // 记耗时：调用的快慢直接决定"5 秒窗"实际能跑多密，之前没有实测数据只能瞎猜
      const cost = Number(result !== null && typeof result === 'object' ? result.costMs : NaN);
      if (Number.isFinite(cost) && cost > 0) {
        state.lastCostMs = Math.round(cost);
        state.costTotalMs += state.lastCostMs;
        state.costCount += 1;
      }
      if (visionAbort === controller) visionAbort = null;
      // 视觉调用期间开关被关/引擎被重启/**窗口切了**：这一批作废，什么都不写、不开口。
      // 最后一条是用户明确要求的：切窗口后不要继续念上一个窗口积压的想法。
      if (mySession !== session || state.running !== true) return;
      if (myEpoch !== windowEpoch) {
        state.staleDropped += 1;
        logger.info?.('chat-widget: 窗口已切换，丢弃这一批（旧窗口的想法不再说）');
        return;
      }
      if (result.ok !== true) {
        state.failures += 1;
        state.lastError = String(result.error ?? 'unknown');
        logger.warn?.(`chat-widget: 陪看调用失败: ${state.lastError}`);
        return;
      }
      const saw = typeof result.saw === 'string' ? result.saw : '';
      const facts = Array.isArray(result.facts) ? result.facts : [];
      state.lastSaw = saw;
      state.lastFacts = facts.length;
      if (saw !== '') {
        state.saws.push(saw);
        if (state.saws.length > 20) state.saws.shift();
      }

      // ② 屏幕记忆库（独立库；facts 也照写，聊天记忆库一个字不碰）
      const written = await writeScreenFrame(logger, settings, {
        frame: { at: lastFrame.at, path: composedPath ?? lastFrame.path, process: where.process, title: where.title },
        saw,
        facts: facts.slice(0, settings.screen.factsPerCall),
        subtitle: subtitle.text,
      });
      if (written.ok !== true) logger.warn?.(`chat-widget: 屏幕记忆没写进: ${String(written.error ?? written.skipped)}`);

      // ③ 开口：三道闸（空话 / 整句英文 / 复读）→ 冷却 → 向量复读闸 → 落库（autonomous）→ SSE 推聊天框
      const say = typeof result.say === 'string' ? result.say.trim() : '';
      if (say === '') return;
      const normalize = (text) => String(text).replace(/[\s，。！？、；：,.!?;:'"「」『』（）()\-—…~]/g, '');
      const normalized = normalize(say);
      if (normalized === '') return;
      if (/[\u4e00-\u9fff]/.test(say) === false) {
        state.langBlocked += 1;
        return;
      }
      // 窗口给 8 句：实测第 4 句之前说过的会原样复读，只看最近 3 句拦不住（用户反馈过绕一圈又回来）。
      const recentSaid = state.said.slice(-8).map(normalize).filter((item) => item !== '');
      const repeated = recentSaid.some((prev) => prev === normalized
        || (normalized.length > 4 && prev.includes(normalized))
        || (prev.length > 4 && normalized.includes(prev)));
      if (repeated) {
        state.repeatBlocked += 1;
        return;
      }
      // 说话间隔的**最小保险**（1 秒）：节奏已经由批处理的时间窗控制（= 设置里的开口冷却），
      // 这里只防"窗口设成 0 且模型快到毫秒级"时一句话连喷。不是业务闸，别拿它调节奏。
      if (Date.now() - state.lastSpokeAt < MIN_SPEAK_GAP_MS) {
        state.speakBlocked += 1;
        return;
      }
      // 换皮复读也要拦：字符串比不准，用向量比最近 3 句（实测模型很爱"只改半句"）。
      // 关键词模式下没有向量可用 —— 上面那道字符串闸就是全部防线，别为此发请求、也别刷警告。
      let vec = null;
      try {
        const embedRole = settings.models.embed;
        if (isKeywordEmbedding(embedRole) === false) {
          const vectors = await callUpstreamEmbed(embedRole, resolveApiKey(embedRole).value, [say]);
          const candidate = Array.isArray(vectors[0]) ? Float32Array.from(vectors[0]) : new Float32Array(0);
          if (candidate.length > 0) {
            const tooClose = state.saidVecs.some((prev) => prev.length === candidate.length && cosine(candidate, prev) >= SIMILAR_SAY);
            if (tooClose) {
              state.repeatBlocked += 1;
              return;
            }
            vec = candidate;
          }
        }
      } catch (error) {
        logger.warn?.(`chat-widget: 复读比对失败（退回字符串闸）: ${String(error)}`);
      }
      // 向量调用也要时间，这期间开关可能被关了
      if (mySession !== session || state.running !== true) return;

      // 出句走**唯一出口**（落库 + 一次广播），和问答回复、专注模式完全同一条路。
      const spoken = deps.utterance.emit({
        text: say,
        source: 'companion',
        autonomous: true,
        // 记当前模式（不是写死 play），否则专注模式下说的话永远进不了"当前模式说过的话"
        mode: currentMode,
        extra: { saw },
      });
      if (spoken.ok !== true) {
        state.lastError = String(spoken.error);
        logger.warn?.(`chat-widget: 开口落库失败: ${state.lastError}`);
        return;
      }
      // 真的说出去了才占冷却、才进"已说过"名单
      state.lastSpokeAt = Date.now();
      // **开口冷却的计时锚点**：吐字这一刻起算一个新窗口，攒下一批帧（用户 2026-11-06 定）
      if (myBatcher !== null && typeof myBatcher.markSpoken === 'function') myBatcher.markSpoken();
      state.lastSay = say;
      state.said.push(say);
      if (state.said.length > 20) state.said.shift();
      if (vec !== null) {
        state.saidVecs.push(vec);
        if (state.saidVecs.length > 8) state.saidVecs.shift();
      }
    } catch (error) {
      // 我们自己 abort 的（切窗口）不是故障：不记失败、不刷 warn
      const aborted = error !== null && typeof error === 'object' && (error.name === 'AbortError' || error.code === 'ABORT_ERR');
      if (aborted === true || myEpoch !== windowEpoch) {
        state.staleDropped += 1;
        logger.info?.('chat-widget: 切窗口，已取消这一批的视觉调用');
      } else {
        state.failures += 1;
        state.lastError = String(error);
        logger.warn?.(`chat-widget: 陪看处理出错: ${String(error)}`);
      }
    } finally {
      // 这一轮已经被停掉/重启的话，旧队列早被 reset 了，别去动新的
      if (mySession === session) {
        busy = false;
        if (myBatcher !== null) myBatcher.markIdle();
      }
    }
  };

  /** 停引擎与队列（开关关掉时）。 */
  const stopRun = () => {
    session += 1;
    if (speech !== null) {
      speech.off();
      speech = null;
    }
    if (subtitles !== null) {
      subtitles.off();
      subtitles = null;
    }
    if (capture !== null) {
      capture.stop();
      capture = null;
    }
    if (batcher !== null) {
      batcher.reset();
      batcher = null;
    }
    runningSignature = '';
    state.running = false;
    busy = false;
  };

  /** 起引擎与队列。 */
  const startRun = async (settings) => {
    if (settings === null || settings.perceive.companion !== true) return;
    const vision = settings.models?.vision;
    if (vision === undefined || vision === null || typeof vision.model !== 'string' || vision.model === '') {
      // 监督每 3 秒会走到这里：只在状态刚变成"没配"时提示一次
      if (state.blocked !== 'no-vision-model') {
        logger.warn?.('chat-widget: 没配视觉模型（设置 → 模型 → Vision 模型），屏幕陪看开不起来');
      }
      state.blocked = 'no-vision-model';
      return;
    }
    state.blocked = null;
    session += 1;
    try {
      // 字幕层先起：它要拿引擎的屏幕尺寸算 OCR 区域，引擎就绪（onReady）时会再 sync 一次
      subtitles = createSubtitles({
        logger,
        settingsFn: () => lastSettings,
        screenFn: () => (capture === null ? null : capture.stats().screen),
      });
      subtitles.sync();
      // 音轨识别（ASR）：**自己写的** WASAPI loopback 采集 + DSH 自带的 SenseVoice 服务。
      // 识别结果一律不入库，只当参考塞进视觉调用的 `<speech>` 块（它不够准）。
      speech = createSpeech({
        logger,
        settingsFn: () => lastSettings,
        getService: getSpeechToText,
        startCapture: startAudioCapture,
        // 音轨要**排除桌宠自己的声音**：它开口时说的话不进 ASR，同一时刻视频里的对白照收。
        // `getPetPid` 由 index.js 注入；桌宠没开就是 0 → 老行为（整机 loopback）。
        getExcludePid: () => (typeof deps.getPetPid === 'function' ? deps.getPetPid() : 0),
      });
      speech.sync();
      // 截图往哪写要用**真正生效的**数据目录：`store.dir` 不可用时 `store.js` 会回落到 DSH home，
      // 那会儿库写在回落目录、截图却还往不存在的盘写（Claude 评审提的第 39 条）。
      capture = startScreenCapture(logger, {
        dir: resolveStoreDir(settings.store.dir).dir ?? settings.store.dir,
        intervalMs: settings.screen.intervalMs,
        sensitivity: settings.screen.sensitivity,
        // 字幕开关关掉时，引擎连 Add-Type/WinRT 都不加载（省 0.6 s）
        ocrEnabled: settings.screen.subtitle === true,
        // 认哪门语言：`auto` = 本机装了的都跑；指定一门而本机没装 → 引擎建不出识别器，
        // 就绪行会报 ocr:false，界面据此提示"无此语言包"+【安装】（**不会偷偷换语言**）
        ocrLangs: String(settings.screen.subtitleLangs ?? 'zh-Hans-CN'),
        // 桌宠位置（屏幕占比）：引擎把这块涂掉，视觉模型与 OCR 都看不到自己
        // （**只影响我们自己这份拷贝**，PrtSc/QQ 截图照样能拍到桌宠）
        maskRequest: typeof deps.maskRequestPath === 'function' ? deps.maskRequestPath() : '',
        onFrame: (frame) => {
          // 换窗口后的静默期：油管那种「1 秒白屏 + 1 秒转圈」的过渡帧不要收，
          // 否则第一批就是白屏/加载图，它会连着说好几句"怎么卡了"（用户实测 3–5 句）。
          if (Date.now() < settleUntil) return;
          if (batcher !== null) batcher.push(frame);
        },
        onOcr: (ocr) => {
          // 字幕层抛错**不能**顺着引擎的 stdout 解析循环冒上去（那会把采集循环带崩），包一层
          try {
            if (subtitles !== null) subtitles.observe(ocr);
          } catch (error) {
            logger.warn?.(`chat-widget: 字幕层处理 OCR 出错（吞掉）: ${String(error)}`);
          }
        },
        onReady: () => {
          if (subtitles !== null) subtitles.sync();
        },
      });
      batcher = createFrameBatcher({
        logger,
        shotsDir: `${resolveStoreDir(settings.store.dir).dir ?? settings.store.dir}/shots`,
        // 批处理的时间窗 = 设置里的「开口冷却」：这 5 秒内的帧攒成一批再喂
        windowMs: Number(settings.screen.speakCooldownMs) || 0,
        onBatch: (frames, composedPath) => {
          // 一批里可能带桥接帧（切换前那张，比切窗口时间早）；只要**最新的那张**属于新窗口就放行。
          const newest = frames.reduce((max, f) => Math.max(max, Number(f.at) || 0), 0);
          const hasNew = lastWindowChangeAt === 0 || newest >= lastWindowChangeAt;
          const onlyBridge = frames.every((f) => f.bridge === true);
          if (onlyBridge || hasNew !== true) {
            state.staleDropped += 1;
            logger.info?.('chat-widget: 这批帧全是切窗口之前的，丢掉（不说上个窗口的内容）');
            return;
          }
          void handleBatch(frames, composedPath);
        },
      });
      runningSignature = engineSignature(settings);
      state.running = true;
      logger.info?.(`chat-widget: 屏幕陪看已开始（每 ${settings.screen.intervalMs} ms 一帧，灵敏度 ${settings.screen.sensitivity}，冷却 ${settings.screen.speakCooldownMs} ms，字幕 ${settings.screen.subtitle === true ? `开（${String(settings.screen.subtitleLangs ?? 'zh-Hans-CN')}）` : '关'}，音轨 ${settings.screen.speech === true ? '开' : '关'}）`);
    } catch (error) {
      // 起到一半抛了：把已经起来的那几块全收掉，不然下一轮监督会再起一套，进程越攒越多
      stopRun();
      state.blocked = 'start-failed';
      state.lastError = String(error);
      nextStartAt = Date.now() + RETRY_START_MS;
      logger.warn?.(`chat-widget: 屏幕陪看启动失败（${RETRY_START_MS / 1000} 秒后重试）: ${state.lastError}`);
    }
  };

  /** 开关监督（顺手把需要在设置变化时重启引擎的那几项对齐）。 */
  const supervise = async () => {
    if (stopped === true) return;
    try {
      const settings = await load();
      if (settings === null) return;
      const want = settings.perceive.companion === true;
      if (want !== true) {
        state.blocked = null;
        nextStartAt = 0;
        if (state.enabled === true || state.running === true) {
          state.enabled = false;
          stopRun();
          logger.info?.('chat-widget: 屏幕陪看已停止（开关关掉了）');
        }
        return;
      }
      state.enabled = true;
      if (state.running !== true) {
        if (Date.now() < nextStartAt) return;
        await startRun(settings);
        return;
      }
      if (engineSignature(settings) !== runningSignature) {
        // 间隔/灵敏度/字幕开关/OCR 语言/数据目录变了：引擎参数是启动时定死的，只能重启
        logger.info?.('chat-widget: 陪看设置变了（间隔/灵敏度/字幕/OCR 语言/目录），重启截图引擎');
        stopRun();
        await startRun(settings);
        return;
      }
      if (subtitles !== null) subtitles.sync();
      if (speech !== null) speech.sync();
      // 开口冷却改了 → 批处理时间窗跟着变（不用重启截图引擎）
      if (batcher !== null && typeof batcher.setWindowMs === 'function') {
        batcher.setWindowMs(Number(settings.screen.speakCooldownMs) || 0);
      }
    } catch (error) {
      state.lastError = String(error);
      logger.warn?.(`chat-widget: 陪看监督出错: ${state.lastError}`);
    }
  };

  return {
    /** 起监督循环 + 订阅窗口变化。 */
    start() {
      // 窗口变化全量落库（不是判断，是记录；专注模式那边照旧自己订阅）
      if (watch !== undefined && watch !== null && unsubscribe === null) {
        unsubscribe = watch.onChange((change) => {
          // 开关关着也照记（只是不落库）：截图帧要靠它补 app/title
          recentWindows.push({ at: Number(change.at) || Date.now(), process: change.process ?? '', title: change.title ?? '' });
          if (recentWindows.length > 200) recentWindows.shift();
          // 窗口/标题变了 → 字幕层重新给一次判定机会（**不是定时器**）
          if (subtitles !== null) subtitles.onWindowChange();
          // **窗口换了就从新的开始**（用户要求）：在途那批作废、排队帧丢掉、请求取消。
          // 不做的话：上一窗口的截图还在"思考"，想完照样念出来 —— 对着新画面说旧窗口的话。
          windowEpoch += 1;
          // 换了场景，「之前几帧看到过什么」只留最后一条当桥接（"刚才还在看 A"），
          // 别的全丢：跨场景的旧观察喂回去，它就会拿旧画面当现在（2026-11-09 用户实测）。
          if (state.saws.length > 1) state.saws = state.saws.slice(-1);
          // 记下"从这一刻起是新窗口"：接下来拼图/回调里靠它判断旧帧
          lastWindowChangeAt = Date.now();
          // 过渡期（白屏/转圈）先不收帧 —— **只对浏览器**，别的窗口立刻收
          const changedProcess = String(change.process ?? '').toLowerCase();
          settleUntil = lastWindowChangeAt + (BROWSER_PROCESSES.has(changedProcess) ? SETTLE_BROWSER_MS : SETTLE_OTHER_MS);
          if (visionAbort !== null) {
            try {
              visionAbort.abort();
            } catch {
              // 已经结束了，忽略
            }
            visionAbort = null;
          }
          // 不清空：留下切换前最后一张当桥接帧，让它能说出"刚在看 X，现在切到 Y"
          if (batcher !== null && typeof batcher.keepBridge === 'function') batcher.keepBridge();
          else if (batcher !== null) batcher.reset();
          if (state.enabled !== true) return;
          void load()
            .then((settings) => {
              if (settings !== null) return writeWindowEvent(logger, settings, change);
              return undefined;
            })
            .catch((error) => {
              logger.warn?.(`chat-widget: 窗口事件没写进: ${String(error)}`);
            });
        });
      }
      superviseTimer = setInterval(() => {
        void supervise();
      }, SUPERVISE_MS);
      if (typeof superviseTimer.unref === 'function') superviseTimer.unref();
      void supervise();
    },
    /** 停（宿主卸载时）。 */
    stop() {
      stopped = true;
      clearInterval(superviseTimer);
      if (unsubscribe !== null) {
        unsubscribe();
        unsubscribe = null;
      }
      stopRun();
    },
    /**
     * 重启一次引擎（装好 OCR 语言包之类：引擎是启动时建识别器的，必须重启才认）。
     * 陪看没开就什么都不做。
     *
     * @returns {void} 完成。
     */
    refresh() {
      if (stopped === true) return;
      void load().then((settings) => {
        if (settings === null || settings.perceive.companion !== true) return undefined;
        stopRun();
        nextStartAt = 0;
        return startRun(settings);
      });
    },
    /**
     * 音轨识别的预留接口（给以后的桌宠 TTS 用）。
     *
     * @param {'pause'|'resume'} action - 暂停/恢复。
     * @param {string} [reason] - 原因（日志与状态用）。
     * @returns {boolean} 有没有真的做到（陪看没开就是 false）。
     */
    speechControl(action, reason) {
      if (speech === null) return false;
      if (action === 'pause') speech.pause(reason);
      else speech.resume();
      return true;
    },
    status: () => {
      // 向量别塞进状态（Float32Array 序列化出来是一大坨对象），只报个数
      const { saidVecs, ...rest } = state;
      return {
        ...rest,
        saidVecCount: saidVecs.length,
        // 视觉调用的平均耗时（毫秒）：批处理窗口该设多大，看它才有依据
        costAvgMs: state.costCount === 0 ? 0 : Math.round(state.costTotalMs / state.costCount),
        busy,
        queued: batcher === null ? 0 : batcher.queueLength(),
        batcher: batcher === null ? null : batcher.stats(),
        capture: capture === null ? null : capture.stats(),
        subtitle: subtitles === null ? { mode: 'off' } : subtitles.status(),
        speech: speech === null ? { mode: 'off' } : speech.status(),
      };
    },
  };
}
