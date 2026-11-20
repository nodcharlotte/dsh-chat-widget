/**
 * @local/chat-widget —— 设置层。
 *
 * 空壳版只剩这几样要存：
 *   - **两个模型**：一个对话（text）、一个向量（embed，记忆检索用）
 *   - **记忆库的两个数值**：倒计时分钟数、每轮带最近几条
 *   - **数据目录**
 *
 * 识图、观测这些内部功能都已删除，设置里也不再保留它们的键。
 * 白名单之外的键一律丢弃；文件里缺的或非法的字段落回默认值，所以老文件不会失效。
 *
 * @module @local/chat-widget/host/settings
 */

import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { dshHomePath } from './home.js';
import { DEFAULT_STORE_DIR } from '../store.js';

/** 对话模型的默认值。 */
export const MODEL_DEFAULT = {
  provider: 'ollama',
  baseUrl: 'http://127.0.0.1:11434',
  model: 'deepseek-r1:8b',
  apiKey: '',
  apiKeyEnv: '',
};

/** 向量模型的默认值（记忆库检索用；实测本机 768 维、热调用 26 ms）。 */
export const EMBED_DEFAULT = {
  provider: 'ollama',
  baseUrl: 'http://127.0.0.1:11434',
  model: 'nomic-embed-text:latest',
  apiKey: '',
  apiKeyEnv: '',
};

/** 记忆库默认值：倒计时 5 分钟、每轮带最近 7 条。 */
export const MEMORY_DEFAULT = {
  delayMinutes: 5,
  recentMessages: 7,
};

/** 成长日记默认值：默认关（在设置里勾了才写）。 */
export const GROWTH_DEFAULT = {
  enabled: false,
};

/** 感知默认值：三个开关**默认都关**（关着连后台助手进程都不起）。 */
export const PERCEIVE_DEFAULT = {
  window: false,
  focus: false,
  companion: false,
};

/** 屏幕陪看默认值（界面全部可调）。灵敏度 6 = pct8 ≥ 0.5%（实测：静止 0%，最安静内容 0.98%）。 */
export const SCREEN_DEFAULT = {
  intervalMs: 2000,
  sensitivity: 6,
  dedupeCosine: 0.87,
  speakCooldownMs: 5000,
  saidContext: 5,
  sawContext: 6,
  chatContext: 5,
  factsPerCall: 3,
  compressBatch: 200,
  /** 字幕层（v3）：默认**开**（只认画面硬字幕，判定全走几何证据）。 */
  subtitle: true,
  /** 探测期识别的区域：屏幕**下部**这么多百分比（默认 1/3）。锁定后只读条带。 */
  subtitleRegionPercent: 33,
  /** 探测期预算：超过它判"这段没字幕"并停 OCR（设置里的小字不写具体秒数）。 */
  subtitleProbeMs: 15_000,
  /** 每批视觉调用最多带几行字幕原文。 */
  subtitleMaxLines: 6,
  /** 每批字幕原文最多多少字。 */
  subtitleMaxChars: 400,
  /** 判没字幕后转**待机低频扫**：每隔多久看一眼（毫秒）。 */
  subtitleIdleScanMs: 8_000,
  /** 待机**总计**多久还没字幕就彻底停（毫秒）；只有窗口变化能再启动。 */
  subtitleIdleMs: 60_000,
  /**
   * OCR 用哪门语言：`auto`（Windows 上装了哪几门就都跑一遍，开销按门数**线性翻倍**）
   * 或指定一门 —— `zh-Hans-CN`（中文简，**默认**）/ `zh-Hant-TW`（中文繁）/ `ja`（日文）/ `en-US`（英文）。
   * 选了本机没装的那门：界面提示"无此语言包"+【安装】，OCR 不跑（不会偷偷退回别的语言）。
   */
  subtitleLangs: 'zh-Hans-CN',
  /**
   * 音轨识别（ASR）：**默认关**。它是陪看的从属开关 —— 陪看一关，它也必须停
   * （界面关陪看时会顺手把它一起发成 false，宿主那边 `sync()` 也会再判一次）。
   *
   * 识别结果**一律不入库**，只当参考塞进视觉调用（`<speech>` 块）：它不够准。
   */
  speech: false,
  /** 灵敏度 1–10：越大越容易把小声也当人声（判据是相对"最近的高水位"，不是绝对音量）。 */
  speechSensitivity: 6,
  /** 帧间隙多久算这一句说完了（毫秒）。WASAPI loopback 静音时不发帧，所以间隙就是静音。 */
  speechSilenceMs: 700,
  /** 一句最长多少毫秒（太长就强制切，服务那边还有自己的上限）。 */
  speechMaxMs: 12_000,
  /** 每批视觉调用最多带几行音轨参考。 */
  speechMaxLines: 6,
  /** 每批音轨参考最多多少字。 */
  speechMaxChars: 400,
  /**
   * 识别语言：SenseVoice 接受 `auto`（自动）/ `zh` / `en` / `yue` / `ja` / `ko`。
   * 默认 `auto` —— 陪看场景里经常是"中文字幕 + 外语原声"，让它自己判比锁死一门强。
   */
  speechLangs: 'auto',
};

/**
 * 音轨识别可选语言（顺序 = 下拉里的顺序）。
 *
 * 取值**必须是 provider 认的那几个**（`dsh-experimental-speech-to-text-sensevoice` 的
 * `languages = ['auto','zh','en','yue','ja','ko']`）。写错了 `resolve()` 会直接抛，
 * 所以归一化时按这个白名单拦（不认识的写回 `auto`）。
 */
export const SPEECH_LANG_CHOICES = [
  { value: 'auto', label: '自动' },
  { value: 'zh', label: '中文' },
  { value: 'en', label: '英文' },
  { value: 'yue', label: '粤语' },
  { value: 'ja', label: '日文' },
  { value: 'ko', label: '韩文' },
];

/**
 * 界面上的 OCR 语言选项（顺序 = 下拉里的顺序）。
 *
 * 两套 tag **写法不一样**，别混：
 *   `windowsTag` = **WinRT 识别器**的语言 tag —— `AvailableRecognizerLanguages` 报的就是这个
 *     （`ja`、`zh-Hans-CN`）。引擎拿它建识别器、也拿它判断"这门的包装没装"。
 *   `capability` = **系统语言包**（`Get-WindowsCapability -Online`）名字中间那一节 —— 写法是
 *     「语言-地区」的短式：`zh-CN` / `zh-TW` / `ja-JP` / `en-US`。
 *   实测（本机 `Get-WindowsCapability -Online | ? Name -like 'Language.OCR*'`）：
 *     `Language.OCR~~~zh-CN~0.0.1.0 | Installed`、`Language.OCR~~~ja-JP~0.0.1.0 | Installed`，
 *   而 `zh-Hans-CN` / `zh-Hant-TW` / `ja` **都不是**合法 capability 名 —— 拿识别器 tag 去装，
 *   `Add-WindowsCapability` 只会回一个 $null（不报错！）然后被当成"装好了"。
 *   只有 `en-US` 这一门是两套写法**碰巧一致**的（所以它最容易骗过测试）。
 *
 * `capability` 为空 = 这门没有对应的系统可选功能（`auto` 是"全跑"，不用装）。
 */
export const OCR_LANG_CHOICES = [
  { value: 'auto', label: '自动', windowsTag: 'auto', capability: '' },
  { value: 'zh-Hans-CN', label: '中文(简)', windowsTag: 'zh-Hans-CN', capability: 'zh-CN' },
  { value: 'zh-Hant-TW', label: '中文(繁)', windowsTag: 'zh-Hant-TW', capability: 'zh-TW' },
  { value: 'ja', label: '日文', windowsTag: 'ja', capability: 'ja-JP' },
  { value: 'en-US', label: '英文', windowsTag: 'en-US', capability: 'en-US' },
];

/**
 * 桌宠的默认值。
 *
 * `enabled` 默认**关**：关着的时候**外壳进程根本不起**（不占内存、不占 GPU）。
 * `shellDir` 留空 = **自动探测** DSH 桌面端的安装目录（我们借它的 Electron 运行时，
 * 见 `host/pet.js` 的 `detectShellDir`）。
 */
export const PET_DEFAULT = {
  enabled: false,
  /** 它说话时出声（从属开关，缩进对齐 OCR / 音轨）。 */
  tts: false,
  /** 模型缩放（0.3–2.0）。 */
  modelScale: 1.0,
  /** 气泡位置：`top` 置顶 / `bottom` 置底（绿幕里能看到对应位置的空框）。 */
  bubblePosition: 'top',
  /** 用哪个模型：**`assets/live2d/` 下的文件夹名**。留空 = 自动用第一个（按名字排）。 */
  model: '',
  /** 外壳安装目录（留空 = 自动探测）。 */
  shellDir: '',
  /** 置顶。 */
  alwaysOnTop: true,
  /** TTS 模型：`kokoro`（103 音色，默认）/ `melo`（单女声，退路）。 */
  ttsModel: 'edge',
  /** TTS 音色（kokoro 才有意义；`zf_078` = 中文女声 43）。 */
  ttsVoice: 'zh-CN-XiaoxiaoNeural',
  /** 音调（半音，-12 ~ +12，0 = 原声）。 */
  ttsPitch: 0,
  /** TTS 语速 / 音量。 */
  ttsSpeed: 1.0,
  ttsVolume: 1.0,
};

/** 视觉模型的默认值：**模型名留空 = 跟随对话模型**（同模型时陪看只走一次调用）。 */
export const VISION_DEFAULT = {
  provider: 'ollama',
  baseUrl: 'http://127.0.0.1:11434',
  model: '',
  apiKey: '',
  apiKeyEnv: '',
};

/** 允许的 provider 取值（对话 / 视觉）。 */
const PROVIDERS = new Set(['ollama', 'openai-compatible', 'deepseek', 'openrouter']);

/**
 * Embedding 的离线兜底：**BM25 关键词模式**。
 *
 * 选它以后不向任何端点发向量请求 —— 入库只存文本，检索按字面重合度打分
 * （实现在 `host/bm25.js`）。只有 `models.embed` 认这个值；对话 / 视觉模型
 * 即使被人手写进配置，归一化时也会被打回默认，免得出现"选了却不生效"。
 */
export const KEYWORD_EMBED_PROVIDER = 'keyword-bm25';

/** Embedding 允许的 provider 取值（比别的角色多一个离线模式）。 */
const EMBED_PROVIDERS = new Set([...PROVIDERS, KEYWORD_EMBED_PROVIDER]);

/**
 * 某个角色是不是"关键词模式"的 embedding。
 * @param {object} [role] - 一般是 `settings.models.embed`。
 * @returns {boolean} 关键词模式为 true。
 */
export function isKeywordEmbedding(role) {
  return role !== null && typeof role === 'object' && role.provider === KEYWORD_EMBED_PROVIDER;
}

/**
 * 设置的完整默认结构。
 * @returns {object} 默认设置。
 */
export function defaultSettings() {
  return {
    models: { text: { ...MODEL_DEFAULT }, embed: { ...EMBED_DEFAULT }, vision: { ...VISION_DEFAULT } },
    memory: { ...MEMORY_DEFAULT },
    growth: { ...GROWTH_DEFAULT },
    perceive: { ...PERCEIVE_DEFAULT },
    screen: { ...SCREEN_DEFAULT },
  pet: { ...PET_DEFAULT },
    store: { dir: DEFAULT_STORE_DIR },
  };
}

/** 设置目录。 */
export function settingsDir() {
  return dshHomePath('chat-widget');
}

/** 设置文件路径。 */
export function settingsFile() {
  return dshHomePath('chat-widget', 'settings.json');
}

/** 归一一个字符串字段：非字符串或纯空白 → 默认值。 */
export function normalizeString(value, fallback, maxLength) {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  if (trimmed === '') return fallback;
  return trimmed.slice(0, maxLength);
}

/**
 * 归一一个密钥字段：只接受可打印 ASCII 且不含空格，不合规就当空。
 * @param {unknown} value - 候选密钥。
 * @returns {string} 合规的密钥，或空串。
 */
export function normalizeSecret(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (trimmed === '' || trimmed.length > 512) return '';
  return /^[\x21-\x7E]+$/.test(trimmed) ? trimmed : '';
}

/**
 * 归一一个整数字段（也接受数字字符串）：非数字 → 默认值，越界 → 夹到边界。
 * @param {unknown} value - 候选值。
 * @param {number} fallback - 默认值。
 * @param {number} min - 下限。
 * @param {number} max - 上限。
 * @returns {number} 归一后的整数。
 */
export function normalizeInt(value, fallback, min, max) {
  const numeric = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  if (Number.isFinite(numeric) === false) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(numeric)));
}

/**
 * 归一模型配置，只保留白名单字段。
 * @param {unknown} raw - 待归一的输入。
 * @param {object} fallback - 该角色的默认值。
 * @param {Set<string>} [allowed] - 该角色允许的 provider 集合。
 * @returns {object} 归一后的角色配置。
 */
function normalizeModel(raw, fallback, allowed = PROVIDERS) {
  const source = raw !== null && typeof raw === 'object' ? raw : {};
  const provider = normalizeString(source.provider, fallback.provider, 64);
  return {
    provider: allowed.has(provider) ? provider : fallback.provider,
    baseUrl: normalizeString(source.baseUrl, fallback.baseUrl, 512),
    // 视觉模型的模型名允许留空 = 跟随对话模型（其它角色留空落回默认值）
    model: fallback.model === '' ? normalizeString(source.model, '', 256) : normalizeString(source.model, fallback.model, 256),
    apiKey: normalizeSecret(source.apiKey),
    apiKeyEnv: normalizeString(source.apiKeyEnv, fallback.apiKeyEnv, 128),
  };
}

/** 模型角色的键（顺序 = 界面上的卡片顺序）。 */
export const MODEL_ROLES = ['text', 'embed', 'vision'];

/**
 * 把任意输入归一成一份完整、合法的设置。
 *
 * 兼容老文件：模型从 `models.text` 读；数据目录从 `store.dir` 读，读不到就退一步读
 * 旧版的 `memory.dir`——这样老配置里的路径不会被悄悄打回默认值。
 *
 * @param {unknown} raw - 待归一的输入。
 * @returns {object} 完整设置。
 */
export function normalizeSettings(raw) {
  const defaults = defaultSettings();
  const source = raw !== null && typeof raw === 'object' ? raw : {};
  const rawModels = source.models !== null && typeof source.models === 'object' ? source.models : {};
  const rawStore = source.store !== null && typeof source.store === 'object' ? source.store : {};
  const rawMemory = source.memory !== null && typeof source.memory === 'object' ? source.memory : {};
  const rawGrowth = source.growth !== null && typeof source.growth === 'object' ? source.growth : {};
  const rawPerceive = source.perceive !== null && typeof source.perceive === 'object' ? source.perceive : {};
  const rawScreen = source.screen !== null && typeof source.screen === 'object' ? source.screen : {};
  const rawPet = source.pet !== null && typeof source.pet === 'object' ? source.pet : {};

  const models = {};
  for (const key of MODEL_ROLES) {
    models[key] = normalizeModel(rawModels[key], defaults.models[key], key === 'embed' ? EMBED_PROVIDERS : PROVIDERS);
  }

  return {
    models,
    memory: {
      delayMinutes: normalizeInt(rawMemory.delayMinutes, defaults.memory.delayMinutes, 0, 1440),
      recentMessages: normalizeInt(rawMemory.recentMessages, defaults.memory.recentMessages, 1, 50),
    },
    growth: {
      enabled: rawGrowth.enabled === true || rawGrowth.enabled === 'true' || rawGrowth.enabled === 1,
    },
    perceive: {
      window: rawPerceive.window === true || rawPerceive.window === 'true' || rawPerceive.window === 1,
      focus: rawPerceive.focus === true || rawPerceive.focus === 'true' || rawPerceive.focus === 1,
      companion: rawPerceive.companion === true || rawPerceive.companion === 'true' || rawPerceive.companion === 1,
    },
    screen: {
      intervalMs: normalizeInt(rawScreen.intervalMs, defaults.screen.intervalMs, 250, 60000),
      sensitivity: normalizeInt(rawScreen.sensitivity, defaults.screen.sensitivity, 1, 10),
      // 老默认值是 0.9，而 0.9 几乎拦不住"换个说法重说一遍"（用户实测的复读就是这么漏过去的）。
      // 磁盘上的 0.9 基本都是"当年默认值没人动过"，按老默认迁到 0.87；用户手动改过的值保持不动。
      dedupeCosine: Math.min(0.999, Math.max(0.5, Number.isFinite(Number(rawScreen.dedupeCosine)) && Number(rawScreen.dedupeCosine) !== 0.9
        ? Number(rawScreen.dedupeCosine)
        : defaults.screen.dedupeCosine)),
      // 用户定的：**下限 1 秒、默认 3 秒**。
      // 他说得很清楚——开不开口应该由它自己判断，看番时 3 秒内连着两个梗都要能吐槽，
      // 拿一个长冷却去压重复是把"判断"换成了"闭嘴"。防重复交给复读闸和提示词，冷却只防手抖。
      speakCooldownMs: normalizeInt(rawScreen.speakCooldownMs, defaults.screen.speakCooldownMs, 0, 600000),
      saidContext: normalizeInt(rawScreen.saidContext, defaults.screen.saidContext, 0, 20),
      sawContext: normalizeInt(rawScreen.sawContext, defaults.screen.sawContext, 0, 20),
      chatContext: normalizeInt(rawScreen.chatContext, defaults.screen.chatContext, 0, 20),
      factsPerCall: normalizeInt(rawScreen.factsPerCall, defaults.screen.factsPerCall, 0, 10),
      compressBatch: normalizeInt(rawScreen.compressBatch, defaults.screen.compressBatch, 1, 2000),
      // 字幕层默认**开**：只有明确写成 false/'false'/0 才关（缺字段时不能把它关掉）
      subtitle: rawScreen.subtitle === undefined || rawScreen.subtitle === null
        ? defaults.screen.subtitle
        : (rawScreen.subtitle === true || rawScreen.subtitle === 'true' || rawScreen.subtitle === 1),
      subtitleRegionPercent: normalizeInt(rawScreen.subtitleRegionPercent, defaults.screen.subtitleRegionPercent, 10, 100),
      subtitleProbeMs: normalizeInt(rawScreen.subtitleProbeMs, defaults.screen.subtitleProbeMs, 3000, 120000),
      subtitleMaxLines: normalizeInt(rawScreen.subtitleMaxLines, defaults.screen.subtitleMaxLines, 1, 20),
      subtitleMaxChars: normalizeInt(rawScreen.subtitleMaxChars, defaults.screen.subtitleMaxChars, 50, 2000),
      subtitleIdleScanMs: normalizeInt(rawScreen.subtitleIdleScanMs, defaults.screen.subtitleIdleScanMs, 1000, 60000),
      subtitleIdleMs: normalizeInt(rawScreen.subtitleIdleMs, defaults.screen.subtitleIdleMs, 5000, 600000),
      // OCR 语言：只认白名单里的五选一（不认识的写回默认 = 中文简）
      subtitleLangs: OCR_LANG_CHOICES.some((item) => item.value === rawScreen.subtitleLangs)
        ? String(rawScreen.subtitleLangs)
        : defaults.screen.subtitleLangs,
      // 音轨识别默认**关**：只有明确写成 true/'true'/1 才开
      speech: rawScreen.speech === true || rawScreen.speech === 'true' || rawScreen.speech === 1,
      speechSensitivity: normalizeInt(rawScreen.speechSensitivity, defaults.screen.speechSensitivity, 1, 10),
      speechSilenceMs: normalizeInt(rawScreen.speechSilenceMs, defaults.screen.speechSilenceMs, 200, 3000),
      speechMaxMs: normalizeInt(rawScreen.speechMaxMs, defaults.screen.speechMaxMs, 2000, 60_000),
      speechMaxLines: normalizeInt(rawScreen.speechMaxLines, defaults.screen.speechMaxLines, 1, 20),
      speechMaxChars: normalizeInt(rawScreen.speechMaxChars, defaults.screen.speechMaxChars, 50, 2000),
      // 识别语言：只认 provider 支持的六选一（不认识的写回 auto）
      speechLangs: SPEECH_LANG_CHOICES.some((item) => item.value === rawScreen.speechLangs)
        ? String(rawScreen.speechLangs)
        : defaults.screen.speechLangs,
    },
    store: {
      dir: normalizeString(rawStore.dir, normalizeString(rawMemory.dir, defaults.store.dir, 512), 512),
    },
    // 桌宠：三个开关 + 模型缩放 + 外壳目录 + TTS 三个旋钮
    pet: {
      enabled: rawPet.enabled === true || rawPet.enabled === 'true' || rawPet.enabled === 1,
      tts: rawPet.tts === true || rawPet.tts === 'true' || rawPet.tts === 1,
      modelScale: Math.min(2.0, Math.max(0.3, Number.isFinite(Number(rawPet.modelScale)) ? Number(rawPet.modelScale) : defaults.pet.modelScale)),
      model: normalizeString(rawPet.model, defaults.pet.model, 120),
      bubblePosition: rawPet.bubblePosition === 'bottom' ? 'bottom' : 'top',
      shellDir: normalizeString(rawPet.shellDir, defaults.pet.shellDir, 512),
      alwaysOnTop: rawPet.alwaysOnTop === undefined || rawPet.alwaysOnTop === null
        ? defaults.pet.alwaysOnTop
        : (rawPet.alwaysOnTop === true || rawPet.alwaysOnTop === 'true' || rawPet.alwaysOnTop === 1),
      // 只认这四个（其它值回默认 aishell3）
      // 只认 edge（在线、14 个中文音色）/ melo（本地、单女声）
      ttsModel: rawPet.ttsModel === 'melo' ? 'melo' : 'edge',
      ttsVoice: normalizeString(rawPet.ttsVoice, defaults.pet.ttsVoice, 40),
      // 音调：半音，夹 -12 ~ +12
      ttsPitch: Math.min(12, Math.max(-12, Number.isFinite(Number(rawPet.ttsPitch)) ? Number(rawPet.ttsPitch) : 0)),
      ttsSpeed: Math.min(2.0, Math.max(0.5, Number.isFinite(Number(rawPet.ttsSpeed)) ? Number(rawPet.ttsSpeed) : defaults.pet.ttsSpeed)),
      // 音量允许到 2.0（宿主端软增益）：<audio> 的音量封顶 1.0，用户实测“开到最大还是小”
      ttsVolume: Math.min(2.0, Math.max(0.0, Number.isFinite(Number(rawPet.ttsVolume)) ? Number(rawPet.ttsVolume) : defaults.pet.ttsVolume)),
    },
  };
}

/**
 * 把一份「只带了一部分」的设置在已存设置上合并。
 *
 * 为什么必须有这个：`PUT /settings` 如果只发 `{"growth":{"enabled":true}}`，
 * 直接归一化会让**没提到的字段全部退回默认值**——模型名会被悄悄改回 deepseek-r1:8b。
 * 界面每次都发完整设置，所以它一直是好的；但手写 curl 或者以后做局部改动时会踩。
 *
 * @param {object} base - 已存设置（完整）。
 * @param {unknown} patch - 请求体。
 * @returns {object} 合并后的设置（还没归一化）。
 */
export function mergeSettings(base, patch) {
  const source = patch !== null && typeof patch === 'object' ? patch : {};
  const out = { ...base };
  if (source.models !== null && typeof source.models === 'object') {
    out.models = { ...base.models };
    for (const key of MODEL_ROLES) {
      if (source.models[key] !== null && typeof source.models[key] === 'object') {
        out.models[key] = { ...base.models[key], ...source.models[key] };
      }
    }
  }
  for (const key of ['memory', 'growth', 'perceive', 'screen', 'store', 'pet']) {
    if (source[key] !== null && typeof source[key] === 'object') out[key] = { ...base[key], ...source[key] };
  }
  return out;
}

/**
 * 读设置文件；不存在或损坏时落回默认值。损坏的文件**不覆盖**。
 * @param {object} logger - cordis logger。
 * @returns {Promise<{settings: object, existed: boolean, corrupted: boolean, path: string}>} 读取结果。
 */
export async function readSettings(logger) {
  const path = settingsFile();
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (error === null || typeof error !== 'object' || error.code !== 'ENOENT') {
      logger.warn(`chat-widget: 读取设置失败（落回默认值）: ${String(error)}`);
    }
    return { settings: defaultSettings(), existed: false, corrupted: false, path };
  }

  try {
    return { settings: normalizeSettings(JSON.parse(text)), existed: true, corrupted: false, path };
  } catch (error) {
    logger.warn(`chat-widget: 设置文件 JSON 解析失败（本次忽略，未覆盖文件）: ${String(error)}`);
    return { settings: defaultSettings(), existed: true, corrupted: true, path };
  }
}

/**
 * 原子写设置：写同目录临时文件后 rename 覆盖。
 * @param {object} settings - 已归一的完整设置。
 * @returns {Promise<string>} 实际写入的路径。
 */
export async function writeSettings(settings) {
  const dir = settingsDir();
  await mkdir(dir, { recursive: true });
  const target = settingsFile();
  const tmp = join(dir, `.settings.${process.pid}.${Date.now()}.tmp`);
  try {
    await writeFile(tmp, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
    await rename(tmp, target);
  } catch (error) {
    try {
      await unlink(tmp);
    } catch {
      /* 临时文件可能本来就没建起来 */
    }
    throw error;
  }
  return target;
}

/**
 * 解析最终使用哪个密钥：直接填写的优先，其次环境变量名。
 * @param {{apiKey?: string, apiKeyEnv?: string}} model - 模型配置。
 * @returns {{value: string, source: 'direct'|'env'|'none'}} 密钥与来源。
 */
export function resolveApiKey(model) {
  const source = model !== null && typeof model === 'object' ? model : {};
  const direct = normalizeSecret(source.apiKey);
  if (direct !== '') return { value: direct, source: 'direct' };
  const envName = normalizeString(source.apiKeyEnv, '', 128);
  if (envName !== '' && typeof process.env[envName] === 'string' && process.env[envName] !== '') {
    return { value: process.env[envName], source: 'env' };
  }
  return { value: '', source: 'none' };
}

/**
 * 脱敏一份设置，供回传浏览器：密钥永不离开宿主。
 * 没有可用密钥时 `apiKey` 写空串；有密钥时**省略**该字段（前端显示"已保存，留空即保留"）。
 * @param {object} settings - 完整设置。
 * @returns {object} 脱敏设置。
 */
export function maskSettings(settings) {
  const models = {};
  for (const key of MODEL_ROLES) {
    const safe = { ...settings.models[key] };
    if (resolveApiKey(settings.models[key]).value === '') safe.apiKey = '';
    else delete safe.apiKey;
    models[key] = safe;
  }
  return {
    models,
    memory: { ...settings.memory },
    growth: { ...settings.growth },
    perceive: { ...settings.perceive },
    screen: { ...settings.screen },
    store: { ...settings.store },
    // 桌宠：界面要读回这些值才能显示当前配置（漏了这一行，桌宠标签会永远显示空值）
    pet: { ...settings.pet },
  };
}

/**
 * 把「字段缺失 = 保留已存密钥」的三态合并进一份新设置。
 * @param {object} next - 已归一的新设置。
 * @param {object} previous - 当前落盘的设置。
 * @param {unknown} rawModels - 请求体里的原始 `models`（用来判断字段在不在）。
 * @returns {object} 合并后的设置。
 */
export function keepOmittedKey(next, previous, rawModels) {
  const raw = rawModels !== null && typeof rawModels === 'object' ? rawModels : {};
  for (const key of MODEL_ROLES) {
    const incoming = raw[key];
    const provided = incoming !== null && typeof incoming === 'object'
      && Object.prototype.hasOwnProperty.call(incoming, 'apiKey');
    if (!provided) next.models[key].apiKey = previous.models[key].apiKey;
  }
  return next;
}
