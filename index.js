/**
 * @local/chat-widget —— 宿主半边入口。
 *
 * 做三件事：把 `/chat-widget/api` 挂到 DSH 自己的 webserver 上；起记忆库入库循环；
 * 起前台窗口监测。
 *
 *   index.js           本文件：挂路由 + 起后台循环
 *   host/settings.js   两个模型（对话 / 向量）+ 记忆的两个数值 + 数据目录
 *   host/bm25.js       零依赖 BM25 关键词检索（Embedding 选「关键词模式」时走它）
 *   host/http.js       来源栅栏、JSON 响应、请求体、SSE
 *   host/upstream.js   ollama / OpenAI 兼容两种方言（含向量接口）
 *   host/prompt.js     人格 + 末尾锚定 + 记忆块 + 括号动作过滤器
 *   host/extract.js    抽取：只挑原句，JSON Schema 约束 + 五道闸门
 *   host/memory.js     30 秒扫描入库 + 检索
 *   host/window-watch.js 前台窗口监测（native/WindowWatch.cs 编译出的助手常驻轮询，带开关）
 *   host/perceive.js   感知：窗口名称打包（情况 1）+ 专注模式判定与主动开口
 *   host/events.js     宿主 → 浏览器的 SSE 长连接（只有"它主动开口"一种事件）
 *   host/chat.js       POST /chat 的一轮对话
 *   host/routes.js     路由表（14 条端点）
 *   store.js           SQLite：消息 + 记忆
 *
 * 识图、屏幕理解（perceive）还没接——窗口监测是它的第一块输入，现在只做检测，不改界面。
 *
 * @module @local/chat-widget
 */

import { API_PREFIX, createRouter } from './host/routes.js';
import { createEventHub } from './host/events.js';
import { startMemoryIndexer } from './host/memory.js';
import { createCompanion } from './host/companion.js';
import { createUtterance } from './host/utterance.js';
import { createFocusWatcher } from './host/perceive.js';
import { createPet, maskRequestPath, writeMaskRequest } from './host/pet.js';
import { localEngineStatus, startInstall, synthesize as ttsSynthesize, ttsStatus } from './host/tts.js';
import { defaultSettings, readSettings, settingsFile, writeSettings } from './host/settings.js';
import { dirname } from 'node:path';
import { startWindowWatch } from './host/window-watch.js';

/** 稳定插件名。 */
export const name = 'chat-widget';

/** 需要 webServer 服务；cordis 会等它就绪后再执行 apply。 */
export const inject = ['webServer'];

/**
 * 这几个开关是"开了就会持续跑引擎 / 出声 / 占 GPU"的东西，用户要求**每次开 DSH 都是关的**。
 *
 * 落地方式是**两道保险**（缺一不可）：
 *   1. **关闭时**（`ctx.effect` 的 dispose）把它们写回 false —— 正常退出后磁盘上就是关的，
 *      下次启动第一次读设置就已经是关的，界面**不会先显示"开"再闪一下**（用户实测过这个 1 秒延迟）。
 *   2. **启动时**再兜一次（只对"上次被强杀 / 崩溃，没走到 dispose"的情况）。
 *      但这一次是**异步**的，所以 `GET /settings` 会先 `await` 它（见 `beforeRead`），
 *      保证界面拿到的第一份设置就是关的。
 */
const SELF_STARTING_KEYS = ['window', 'focus', 'companion'];

/**
 * 把"会自己动起来"的开关改成全关。
 *
 * @param {object} settings - 已归一的设置。
 * @returns {object} 新设置（不改原对象）。
 */
function withSelfStartingOff(settings) {
  return {
    ...settings,
    perceive: { ...settings.perceive, window: false, focus: false, companion: false },
    screen: { ...settings.screen, subtitle: false, speech: false },
    pet: { ...settings.pet, enabled: false, tts: false },
  };
}

/**
 * 判断这几个开关是不是已经全关。
 *
 * @param {object} settings - 已归一的设置。
 * @returns {boolean} 全关为 true。
 */
function selfStartingAllOff(settings) {
  return SELF_STARTING_KEYS.every((key) => settings.perceive[key] !== true)
    && settings.screen.subtitle !== true
    && settings.screen.speech !== true
    && settings.pet.enabled !== true
    && settings.pet.tts !== true;
}

export function apply(ctx) {
  const logger = ctx.logger ?? console;

  // 启动兜底：把上次没关干净的开关写回 false。这个 promise 会被 `GET /settings` 等（见下）。
  const startupReset = (async () => {
    try {
      const current = await readSettings(logger);
      if (selfStartingAllOff(current.settings) === true) return;
      await writeSettings(withSelfStartingOff(current.settings));
      logger.info?.('chat-widget: 启动时把 窗口监测 / 专注模式 / 屏幕陪看 / 桌宠 置为关闭（需手动开启）');
    } catch (error) {
      logger.warn?.(`chat-widget: 启动时关闭开关失败（不影响使用）: ${String(error)}`);
    }
  })();

  // 窗口监测：常驻的 PowerShell 助手每 200 ms 看一眼前台窗口，变化（含同一窗口换标题，
  // 也就是浏览器切标签页）立刻报出来。**滑块关着的时候助手进程根本不起**。
  // 事件中心是反方向的一条长连接：它主动开口时把话推给浏览器。
  const events = createEventHub(logger);
  // **唯一的出句出口**：问答 / 专注 / 陪看 三处出句都走它 —— 落库 + 一次广播。
  // 以前三条路各写各的、各广播各的，导致同一句被念两遍、三个引擎各有一套"别重复"状态。
  //
  // 出口是同步 API，而 `readSettings()` 是异步的，所以这里维护一份**同步快照**：
  // 启动时读一次、之后跟着桌宠那个 3 秒定时器刷新。数据目录/记忆延迟改了最多 3 秒后生效，
  // 这对"写一句话进库"完全够用（不是热路径）。
  let settingsSnap = null;
  const refreshSnap = () => {
    readSettings(logger)
      .then((result) => {
        if (result !== null && typeof result === 'object' && result.settings !== undefined) settingsSnap = result.settings;
      })
      .catch(() => { /* 读不到就沿用上一份 */ });
  };
  const snapOf = () => (settingsSnap !== null ? settingsSnap : defaultSettings());
  const utterance = createUtterance({
    logger,
    hub: events,
    getStoreDir: () => snapOf().store.dir,
    getDelayMinutes: () => snapOf().memory.delayMinutes,
  });
  const windowWatch = startWindowWatch(logger, {
    enabled: async () => (await readSettings(logger)).settings.perceive.window === true,
  });
  const focusWatcher = createFocusWatcher({ logger, hub: events, watch: windowWatch, readSettings, utterance });
  focusWatcher.start();
  // 屏幕陪看（开关在「感知」标签；关上就停引擎、清队列）
  // 音轨识别要用 DSH 自带的 `speechToText` 服务（SenseVoice）：
  //   **必须用 `ctx.get('speechToText')` 取，不能用 `ctx.speechToText`。**
  //   Cordis 只把 **`inject` 里声明过**的服务装到插件上下文的属性上；没声明的服务属性是 undefined，
  //   而 `ctx.get(name)` 明确是"绕过 inject 要求去 store 里读"（cordis `reflect.d.ts` 的原话）。
  //   我们**故意不写进 inject**：`inject` 只有"必需"语义，写进去的话这台机器没装 voice-input bundle 时
  //   整个插件都起不来；惰性取 + 取不到就降级成"识别器不可用"才对。
  const getSpeechToText = () => {
    try {
      return ctx.get('speechToText') ?? null;
    } catch {
      return null;
    }
  };
  // 桌宠：`pet.enabled` 开着才起外壳（关着连进程都不起）。
  // **必须等 `startupReset` 写完再 sync**：磁盘上可能还留着上次的 `enabled: true`，
  // 先 sync 就会把窗口拉起来、过一秒又被关掉（用户看到"启动后闪一下"）。
  // 页面由我们自己发（`/pet/`），所以页面里的 Origin 是本机，来源栅栏不用放宽。
  // **先建桌宠再建陪看**：陪看的音轨要拿它的 pid 去排除它自己的声音。
  const pet = createPet({
    logger,
    settingsFn: readSettings,
    dataDir: dirname(settingsFile()),
    pageUrl: () => `${ctx.webServer.getOrigin()}${API_PREFIX}/pet/`,
  });
  void startupReset.then(() => pet.sync());
  const companion = createCompanion({
    logger,
    hub: events,
    watch: windowWatch,
    getSpeechToText,
    // 音轨排除桌宠进程树：它说的话不进 ASR，视频对白照收。桌宠没开 → 0（整机 loopback）。
    getPetPid: () => {
      try {
        return pet.status().pid;
      } catch {
        return 0;
      }
    },
    // 桌宠位置（屏幕占比）交给我们自己的截图引擎去涂掉：
    // **只污染我们这份拷贝**，PrtSc / QQ 截图 / 录屏照样能拍到桌宠（用户要求）。
    maskRequestPath,
    // 出句走唯一出口（落库 + 一次广播）
    utterance,
  });
  companion.start();
  // TTS：桌宠说话时出声。**第一次 synthesize 才加载模型**（kokoro 冷 ~1.8 s 加载 + 合成）
  const tts = {
    synthesize: (text, options) => ttsSynthesize(logger, text, options),
    // 设置页 / 音色下拉框要读「装没装、有哪些音色」
    status: (model) => ttsStatus(model),
    // 缺模型时界面上的「下载」按钮调它
    install: (model) => startInstall(logger, model),
    // 本地引擎（sherpa-onnx-node）在不在 —— 界面据此显示「需开启语音输入插件」的提示
    localEngine: () => localEngineStatus(),
  };
  // 绿幕 / 缩放的**即时预览**覆盖值（只在内存里，不写设置；关弹窗或保存时清掉）
  const petPreview = { editMode: false, modelScale: null };
  // 每 3 秒对齐一次开关（和陪看同一个套路）；`sync()` 自己接住异常，不会带崩宿主
  let petTimer = null;
  void startupReset.finally(() => {
    // 每次都顺手把「桌宠在屏幕上的位置」写给截图引擎：引擎每帧自己读，这里 3 秒刷一次够了。
    // 没开桌宠时写空对象 → 引擎不打码。
    const tickPet = () => {
      pet.sync();
      try {
        writeMaskRequest(pet.status());
      } catch {
        // 打码写失败不影响桌宠本身
      }
    };
    refreshSnap();
    tickPet();
    petTimer = setInterval(() => { refreshSnap(); tickPet(); }, 3000);
    petTimer.unref?.();
  });

  ctx.effect(() => () => {
    clearInterval(petTimer);
    pet.stop();
    companion.stop();
    focusWatcher.stop();
    windowWatch.stop();
    // **关闭时就把这些开关写回 false**（用户要求：别等下次启动再关）。
    // 正常退出后磁盘上就是关的 → 下次打开界面第一眼就是关的，不会"先显示开、1 秒后闪一下关"。
    void (async () => {
      try {
        const current = await readSettings(logger);
        if (selfStartingAllOff(current.settings) === true) return;
        await writeSettings(withSelfStartingOff(current.settings));
      } catch {
        // 关的时候出错就算了，下次启动还有兜底
      }
    })();
  });

  // 只注册一个前缀路由：webserver 只按 path 匹配，method 在处理器内部分派。
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'prefix',
      path: API_PREFIX,
      handler: createRouter(logger, { windowWatch, events, focusWatcher, companion, getSpeechToText, pet, tts, utterance, petPreview, beforeRead: () => startupReset }),
    }),
  );

  // 记忆库：启动先扫一次（补上上次关机时已经到点、还没轮到入库的），之后每 30 秒一次。
  // 倒计时写在库里，所以热重载/重启都不丢；dispose 时把定时器收掉。
  ctx.effect(() => startMemoryIndexer(logger));

  logger.info?.(`chat-widget: 接口已挂载于 ${API_PREFIX}（设置文件 ${settingsFile()}）`);
}
