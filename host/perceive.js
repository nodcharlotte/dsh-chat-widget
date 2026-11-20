/**
 * @local/chat-widget —— 感知层：把「你在用什么窗口」变成它能用的话。
 *
 * 全部只用**窗口名称**（进程名 + 标题），不截图、不看画面。
 *
 * 三种用法：
 *   情况 1（只开窗口监测）：把这段时间出现过的**不同进程名**去重打包，聊天时作为背景参考塞进提示词。
 *   情况 3（再开专注模式）：窗口一变 → **记 3 秒**这期间的窗口名称 → 判摸鱼/工作
 *     → 名单先拦（`listJudge`），拿不准再问模型；判定摸鱼才开口，
 *     而且**只在「工作→摸鱼」那一刻开口、两次至少隔 2 分钟**。
 *
 * 情况 2（屏幕陪看）在 `host/companion.js` 里单独走一条路（截图 + 视觉调用），不在这里。
 *
 * @module @local/chat-widget/host/perceive
 */

import { resolveApiKey } from './settings.js';
import { callUpstreamOnce } from './upstream.js';

/** 窗口变化后记多久（毫秒）。 */
export const COLLECT_MS = 3000;

/** 两次开口至少隔多久。 */
export const MIN_GAP_MS = 2 * 60 * 1000;

/** 一句话的长度上限。 */
const MAX_LINE_CHARS = 120;

/** 打包给模型的窗口名称上限（条数与字数）。 */
const DIGEST_LIMIT = 8;
const DIGEST_CHARS = 600;

/** 进程名精确匹配的摸鱼名单（浏览器只认标题，所以这里主要是播放器/游戏/客户端）。 */
export const SLACK_PROCESSES = new Set([
  'bilibili', 'steam', 'potplayer', 'vlc', 'mpv', 'mpc-hc', 'kmplayer',
  'epicgameslauncher', 'wegame', 'riotclientservices', 'leagueclient',
  'yuanshen', 'genshinimpact', 'douyu', 'huya', 'cloudmusic', 'qqmusic',
]);

/** 标题里出现就算摸鱼的词。 */
export const SLACK_WORDS = [
  '哔哩哔哩', 'bilibili', 'youtube', '微博', '抖音', 'douyin', 'tiktok', '小红书',
  '知乎', 'zhihu', 'steam', 'netflix', '爱奇艺', 'iqiyi', '腾讯视频', 'v.qq.com',
  '优酷', 'youku', '斗鱼', 'douyu', '虎牙', 'huya', '贴吧', 'tieba', 'reddit',
  'twitter', 'x.com', 'instagram', 'facebook', 'twitch', '淘宝', 'taobao',
  '京东', 'jd.com', '拼多多', 'pinduoduo', '漫画', '番剧', '直播',
];

/** 进程名精确匹配的工作名单（进程名短，只能精确比，不然 'code' 会到处命中）。 */
export const WORK_PROCESSES = new Set([
  'code', 'cursor', 'windsurf', 'zed', 'sublime_text', 'nvim', 'vim', 'emacs',
  'pycharm64', 'idea64', 'webstorm64', 'goland64', 'clion64', 'rider64', 'devenv',
  'windowsterminal', 'powershell', 'pwsh', 'cmd', 'conhost', 'wezterm', 'alacritty',
  'docker desktop', 'postman', 'figma', 'photoshop', 'illustrator', 'blender',
  'excel', 'winword', 'powerpnt', 'wps', 'et', 'wpp', 'outlook', 'notion',
  'obsidian', 'typora', 'jupyter-notebook', 'matlab', 'xshell', 'navicat',
  'dbeaver', 'unity', 'gitkraken', 'sourcetree', 'android studio',
]);

/** 标题里出现就算工作的词。 */
export const WORK_WORDS = [
  'visual studio', 'github', 'gitlab', 'stack overflow', 'stackoverflow',
  'pull request', 'merge request', 'terminal', 'powershell', 'jupyter',
  'localhost', 'devtools', '接口文档', '数据库', '代码', '文档', '调试',
];

/** 判断用的输出契约。 */
export const JUDGE_SCHEMA = {
  type: 'object',
  properties: { slacking: { type: 'boolean' }, line: { type: 'string' } },
  required: ['slacking', 'line'],
};

/** 只写台词时的输出契约。 */
export const LINE_SCHEMA = {
  type: 'object',
  properties: { line: { type: 'string' } },
  required: ['line'],
};

/** 拿不准时：让模型同时判"是不是摸鱼"和"说什么"。 */
export const JUDGE_PROMPT = [
  '你在看对方电脑上正在用的窗口（格式：进程名｜窗口标题）。',
  '判断他是在工作还是在摸鱼：摸鱼 = 娱乐、社交、购物、看视频、打游戏；工作 = 写代码、文档、设计、办公软件。',
  '拿不准就按工作算。',
  '输出 JSON：{"slacking": true/false, "line": "想对他说的话"}。',
  'line：判定摸鱼时用你的人格口吻说他一句（一句话，不超过 30 字）；判定工作时留空字符串。',
].join('\n');

/** 名单已经判定摸鱼时：只让模型写那句话，**摸鱼进程名作为依据一起给它**。 */
export const LINE_PROMPT = [
  '对方正在摸鱼，下面是他现在用的窗口（格式：进程名｜窗口标题）。',
  '用你的人格口吻说他一句：一句话，不超过 30 字，可以点出他正在用的那个程序。',
  '输出 JSON：{"line": "..."}。',
].join('\n');

/** 非 ollama 端点没有 schema 约束，只能把形状写进提示词。 */
const jsonHint = (shape) => `只输出 JSON，形如 ${shape}。`;

/** 进程名归一：小写、去掉 .exe。 */
function normalizeProcess(name) {
  return String(name).toLowerCase().replace(/\.exe$/, '').trim();
}

/**
 * 名单判定：先看摸鱼名单，再看工作名单，都没中就"拿不准"。
 * @param {string} processName - 进程名（助手报的那个）。
 * @param {string} title - 窗口标题。
 * @returns {'slack'|'work'|'unknown'} 判定。
 */
export function listJudge(processName, title) {
  const process = normalizeProcess(processName);
  const text = String(title).toLowerCase();
  if (SLACK_PROCESSES.has(process) || SLACK_WORDS.some((word) => text.includes(word))) return 'slack';
  if (WORK_PROCESSES.has(process) || WORK_WORDS.some((word) => text.includes(word))) return 'work';
  return 'unknown';
}

/**
 * 情况 1 用的打包：**去重，只留不同的进程名**（顺序 = 第一次出现的顺序）。
 * @param {{process?: string}[]} changes - 窗口变化。
 * @returns {string[]} 进程名（最多 20 个）。
 */
export function distinctProcesses(changes) {
  const out = [];
  for (const change of Array.isArray(changes) ? changes : []) {
    const name = typeof change.process === 'string' ? change.process.trim() : '';
    if (name === '' || out.includes(name)) continue;
    out.push(name);
  }
  return out.slice(0, 20);
}

/** 睡眠。 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 把一串窗口变化压成给模型看的一小段文字。
 * @param {{process?: string, title?: string}[]} changes - 窗口变化。
 * @returns {string} `进程名｜标题` 行（最多 8 条 / 600 字）。
 */
export function digest(changes) {
  const list = (Array.isArray(changes) ? changes : []).slice(-DIGEST_LIMIT);
  return list
    .map((change) => `${String(change.process ?? '')}｜${String(change.title ?? '')}`)
    .join('\n')
    .slice(0, DIGEST_CHARS);
}

/** 宽容地抠出 JSON 对象（解析不出来就当空对象）。 */
function parseJson(raw) {
  const text = typeof raw === 'string' ? raw.trim() : '';
  let value = null;
  const accept = (candidate) => {
    if (candidate !== null && typeof candidate === 'object' && value === null) value = candidate;
  };
  try {
    accept(JSON.parse(text));
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start !== -1 && end > start) {
      try {
        accept(JSON.parse(text.slice(start, end + 1)));
      } catch {
        /* 当空 */
      }
    }
  }
  return value === null ? {} : value;
}

/** 一次非流式调用 + 解析。 */
async function askOnce(model, prompt, shape, schema, userText) {
  const isOllama = model.provider === 'ollama';
  const raw = await callUpstreamOnce(
    model,
    resolveApiKey(model).value,
    [
      { role: 'system', content: isOllama ? prompt : `${prompt}\n${jsonHint(shape)}` },
      { role: 'user', content: userText },
    ],
    { format: isOllama ? schema : undefined },
  );
  return parseJson(raw);
}

/**
 * 拿不准时：一次调用同时判"是不是摸鱼"和"要说什么"。
 * @returns {Promise<{slacking: boolean, line: string}>} 判定与台词。
 */
async function judgeWithModel(model, changes) {
  const value = await askOnce(model, JUDGE_PROMPT, '{"slacking":true,"line":"…"}', JUDGE_SCHEMA, digest(changes));
  return {
    slacking: value.slacking === true,
    line: typeof value.line === 'string' ? value.line.trim().slice(0, MAX_LINE_CHARS) : '',
  };
}

/**
 * 名单已判定摸鱼时：只让它写那句话（摸鱼进程名作为依据一起给它）。
 * @returns {Promise<string>} 台词（空串 = 不说）。
 */
async function writeLine(model, changes, processName, title) {
  const userText = `${digest(changes)}\n\n他正在用的（摸鱼）程序：${processName}｜${title}`;
  const value = await askOnce(model, LINE_PROMPT, '{"line":"…"}', LINE_SCHEMA, userText);
  return typeof value.line === 'string' ? value.line.trim().slice(0, MAX_LINE_CHARS) : '';
}

/**
 * 造一个「专注模式」观察者：订阅窗口变化，判定摸鱼就让它主动开口。
 *
 * @param {{logger: object, hub: object, watch: object, readSettings: (logger: object) => Promise<{settings: object}>}} deps
 *   日志器、事件中心、窗口监测器、读设置的函数。
 * @returns {{start: () => void, stop: () => void, state: () => object}} 观察者。
 */
export function createFocusWatcher({ logger, hub, watch, readSettings, utterance }) {
  // slacking：现在是不是已经处在"摸鱼"状态（用来只认「工作→摸鱼」那一刻）
  // lastSpokeAt：上次开口的时间（两次至少隔 MIN_GAP_MS）
  // busy：一次只判一个窗口变化，判定期间来的变化直接跳过
  const state = { slacking: false, lastSpokeAt: 0, busy: false };
  let unsubscribe = null;

  /** 记 3 秒：拿到这次变化以及这 3 秒里后续的变化。 */
  const collect = async (change) => {
    await sleep(COLLECT_MS);
    const after = watch.changesSince(change.seq);
    return after.length > 0 ? after : [change];
  };

  /** 判定完要不要开口、说什么。 */
  const speak = async (settings, changes, line, processName) => {
    const text = typeof line === 'string' ? line.trim().slice(0, MAX_LINE_CHARS) : '';
    const wasSlacking = state.slacking === true;
    state.slacking = true; // 判定成摸鱼就先记住，哪怕这次不开口
    if (text === '' || wasSlacking === true) return;
    if (Date.now() - state.lastSpokeAt < MIN_GAP_MS) return;
    state.lastSpokeAt = Date.now();

    // 出句走**唯一出口**（落库 + 一次广播），和问答回复、陪看完全同一条路。
    // `autonomous` 让入库时不和我的上一句配成问答。
    const spoken = utterance.emit({
      text,
      source: 'focus',
      autonomous: true,
      mode: 'focus',
      extra: { process: processName },
    });
    if (spoken.ok !== true) {
      logger.warn?.(`chat-widget: 主动开口写库失败: ${String(spoken.error)}`);
    }
  };

  /** 处理一次窗口变化。 */
  const handle = async (change) => {
    if (state.busy === true) return;
    let settings;
    try {
      ({ settings } = await readSettings(logger));
    } catch (error) {
      logger.warn?.(`chat-widget: 专注模式读设置失败: ${String(error)}`);
      return;
    }
    if (settings.perceive.window !== true || settings.perceive.focus !== true) return;

    state.busy = true;
    try {
      const changes = await collect(change);
      const settled = changes[changes.length - 1];
      const verdict = listJudge(settled.process, settled.title);

      if (verdict === 'work') {
        state.slacking = false;
        return;
      }
      if (verdict === 'slack') {
        const line = await writeLine(settings.models.text, changes, settled.process, settled.title);
        await speak(settings, changes, line, settled.process);
        return;
      }
      const judged = await judgeWithModel(settings.models.text, changes);
      if (judged.slacking !== true) {
        state.slacking = false;
        return;
      }
      await speak(settings, changes, judged.line, settled.process);
    } catch (error) {
      logger.warn?.(`chat-widget: 专注模式判定失败: ${String(error)}`);
    } finally {
      state.busy = false;
    }
  };

  return {
    start() {
      if (unsubscribe !== null) return;
      unsubscribe = watch.onChange((change) => {
        void handle(change);
      });
      logger.info?.(`chat-widget: 专注模式已订阅窗口变化（记 ${COLLECT_MS} ms，两次开口至少隔 ${MIN_GAP_MS / 60000} 分钟）`);
    },
    stop() {
      if (unsubscribe === null) return;
      unsubscribe();
      unsubscribe = null;
    },
    state: () => ({ ...state }),
  };
}
