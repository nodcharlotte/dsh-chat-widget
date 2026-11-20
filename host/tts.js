/**
 * @local/chat-widget —— 进程内 TTS（sherpa-onnx 的 `OfflineTts` + `vits-melo-tts-zh_en`）。
 *
 * 为什么是这条路（PLAN-pet.md 第 5 节已拍板）：
 *   · `vits-melo-tts-zh_en` 是 k2-fsa 把 MeloTTS 转成 VITS 架构的模型，**能用本机已装的
 *     `sherpa-onnx-node` 直接跑** —— 纯 JS、进程内、零外部程序、不装 torch；
 *   · 模型 167 MB，首次用时下载 + 解压到 `~/.dsh/chat-widget/tts/vits-melo-tts-zh_en/`。
 *
 * 三条实现上的硬约束（都是实测/读源码定下来的，改之前先看注释）：
 *
 *   1. **`dictDir` 在 JS 绑定里不存在**（`sherpa-onnx-node` 的 vits 配置只映射
 *      `model / lexicon / tokens / dataDir / noiseScale / noiseScaleW / lengthScale`）。
 *      melo 模型自带 jieba 分词（模型 metadata 里 `jieba=1`），DLL 里也写着
 *      "you don't need to provide dict_dir for this model"，所以 `dict/` 目录不用喂给它。
 *   2. **速度**走 `lengthScale` 机制：sherpa 的 `offline-tts-vits-model.cc` 里
 *      `if (speed != 1 && speed > 0) length_scale = 1./speed`，也就是说
 *      `generate({ generationConfig: { speed } })` 等价于把 config 的 `lengthScale` 设成 `1/speed`。
 *      好处是**换语速不用重建模型**（模型 ~160 MB，重建一次要 1–2 秒），所以 config 里固定
 *      `lengthScale = 1.0`，每次合成都把 `speed` 带过去。
 *   3. **模型加载懒加载 + 缓存**：第一次 `synthesize()` 才建 `OfflineTts`；建失败会清掉错误、
 *      下次重试（`disposeTts()` 之后也能重建）。
 *
 * 边界：文本空 → 直接 `ok:false` 不合成；超过 `TTS_MAX_CHARS` 字 → 截到句子边界再合成
 * （模型对超长输入会跑几十秒，桌宠场景没必要）。
 *
 * @module @local/chat-widget/host/tts
 */

import { spawn } from 'node:child_process';
import {
  closeSync, createWriteStream, existsSync, mkdirSync, openSync, readdirSync, readFileSync, statSync,
} from 'node:fs';
import { mkdtemp, readdir, rename, rm, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { dshHomePath } from './home.js';

/**
 * 支持的 TTS 模型。
 *
 * - `aishell3`：**默认**。VITS + AISHELL-3（**174 个中文音色**，8000 Hz —— 电话音质但很快：
 *   实测 RTF 0.07–0.10、加载 685 ms、269 MB）。用户听完 Kokoro 觉得最差，换它试。
 * - `kokoro`：Kokoro v1.1-zh（103 音色，中英混排，24000 Hz int8 140 MB）。**很慢**（RTF≈1.5、约 4 核）。
 * - `melo`：老的 `vits-melo-tts-zh_en`（单女声，44100 Hz）。
 * - `zipvoice`：ZipVoice zh-en-emilia（零样本音色克隆，24000 Hz，605 MB）。**最慢但最像人**。
 */
export const TTS_MODELS = {
  edge: {
    id: 'edge-tts',
    modelFile: '',
    required: [],
    ruleFsts: [],
    multiSpeaker: true,
    voiceKind: 'edge',
    engine: 'edge',
    // 没有本地文件，永远算"已安装"（只要联网就能用）
    remote: true,
  },
  aishell3: {
    id: 'vits-zh-aishell3',
    modelFile: 'model.onnx',
    required: ['model.onnx', 'tokens.txt', 'lexicon.txt'],
    ruleFsts: ['date.fst', 'number.fst', 'phone.fst', 'new_heteronym.fst'],
    multiSpeaker: true,
    /** 音色名就是 sid 的数字串（174 个，没有官方名字）。 */
    voiceKind: 'index',
    voiceCount: 174,
    engine: 'vits',
  },
  kokoro: {
    id: 'kokoro-int8-multi-lang-v1_1',
    /** 主模型文件名（kokoro 是 int8 量化版）。 */
    modelFile: 'model.int8.onnx',
    required: ['model.int8.onnx', 'voices.bin', 'tokens.txt'],
    /** 正规化规则：kokoro 的中文 fst 只有三个。 */
    ruleFsts: ['date-zh.fst', 'number-zh.fst', 'phone-zh.fst'],
    multiSpeaker: true,
    voiceKind: 'kokoro',
    engine: 'kokoro',
  },
  melo: {
    id: 'vits-melo-tts-zh_en',
    modelFile: 'model.onnx',
    required: ['model.onnx', 'tokens.txt', 'lexicon.txt'],
    ruleFsts: ['date.fst', 'number.fst', 'phone.fst', 'new_heteronym.fst'],
    multiSpeaker: false,
    voiceKind: 'single',
    engine: 'vits',
  },
  zipvoice: {
    id: 'sherpa-onnx-zipvoice-zh-en-emilia',
    modelFile: 'fm_decoder_int8.onnx',
    required: ['text_encoder_int8.onnx', 'fm_decoder_int8.onnx', 'vocos_24khz.onnx', 'tokens.txt', 'prompt.wav'],
    ruleFsts: [],
    multiSpeaker: false,
    voiceKind: 'single',
    engine: 'zipvoice',
  },
};

/** 默认模型（用户听完 Kokoro 说"最差"，换 aishell3 试）。 */
export const DEFAULT_TTS_MODEL = 'edge';

/**
 * 某个模型的下载地址。
 *
 * @param {string} model - 模型类型（kokoro / melo）。
 * @returns {string} 下载 URL。
 */
export function modelUrl(model) {
  const kind = TTS_MODELS[model] === undefined ? DEFAULT_TTS_MODEL : model;
  return `https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/${TTS_MODELS[kind].id}.tar.bz2`;
}

/** 一次合成最多吃多少字（超了截断；200 字中文 ≈ 40 秒音频，够桌宠说一段了）。 */
export const TTS_MAX_CHARS = 200;

/** 下载最多试几次（实测 GitHub 传到 140 MB 会偶发 ECONNRESET，必须能续传重试）。 */
const DOWNLOAD_ATTEMPTS = 5;

/**
 * ONNX 线程数。
 *
 * 实测（Ryzen 5 5600X / 12 逻辑核，同一句 2.5 秒音频，melo）：1 线程 1730 ms、2 线程 1230 ms、
 * 4 线程 800 ms、6 线程 660 ms。取 4：RTF 0.32，够快，又给宿主/Electron/视频留一半核。
 */
const TTS_NUM_THREADS = 4;

/**
 * Kokoro 的线程数**单独给 2**。
 *
 * 实测（同一句 3.7 秒音频）：1 线程 7195 ms / **1.0 核**；2 线程 6579 ms / **4.1 核**；
 * 4 线程 5981 ms / **9.8 核**。耗时只降 17%，CPU 却翻 10 倍 —— 这台机器上
 * 桌宠要跟视频抢核，所以取 2（比 1 线程快一点，又不至于把整机吃满）。
 */
const TTS_NUM_THREADS_KOKORO = 2;

/** 模型本体至少这么大才算完整（kokoro int8 约 109 MB、melo 约 160 MB，留足余量）。 */
const MIN_MODEL_BYTES = 1024 * 1024;

/** 解压超时（bz2 解 167 MB，实测 30 秒级；给 10 分钟余量）。 */
const EXTRACT_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * 运行期状态（模块级单例）。
 *
 * - `tts`：`OfflineTts` 实例；`null` = 还没加载（懒加载）。
 * - `loading`：正在加载的 Promise（并发调用共用，避免重复建模型）。
 * - `ensure`：正在安装的 Promise（并发调用共用，避免重复下载）。
 * - `bytesMemo`：目录字节数的缓存（`/pet/status` 会频繁问，别每次都走盘）。
 */
const state = {
  tts: null,
  /** 当前实例是哪个模型（换模型要重建）。 */
  model: '',
  /** 音色数（kokoro 103 / melo 1）。 */
  numSpeakers: 1,
  /** 正在安装的模型与进度（0–100），给界面画进度用。 */
  install: null,
  loading: null,
  ensure: null,
  loadError: '',
  loadMs: 0,
  sampleRate: 0,
  downloading: false,
  downloadError: '',
  bytesMemo: -1,
};

/** 空 WAV（失败时返回它，调用方不用判空）。 */
const EMPTY_WAV = new Uint8Array(0);

/**
 * TTS 数据根目录（`~/.dsh/chat-widget/tts`）。
 *
 * @returns {string} 绝对路径。
 */
function ttsRootDir() {
  return dshHomePath('chat-widget', 'tts');
}

/**
 * 模型目录的绝对路径（契约接口）。
 *
 * @returns {string} 绝对路径。
 */
export function ttsModelDir(model) {
  const kind = TTS_MODELS[model] === undefined ? DEFAULT_TTS_MODEL : model;
  return join(ttsRootDir(), TTS_MODELS[kind].id);
}

/**
 * 下载缓存里的压缩包路径（装好之后会删掉）。
 *
 * @returns {string} 绝对路径。
 */
export function ttsArchivePath(model) {
  const kind = TTS_MODELS[model] === undefined ? DEFAULT_TTS_MODEL : model;
  return join(ttsRootDir(), `${TTS_MODELS[kind].id}.tar.bz2`);
}

/**
 * 静默/带日志的日志器兜底。
 *
 * @param {unknown} logger - 宿主给的 logger（可能没有）。
 * @returns {{info:Function, warn:Function, error:Function}} 可用的日志器。
 */
function useLogger(logger) {
  const noop = () => {};
  if (logger === null || typeof logger !== 'object') return { info: noop, warn: noop, error: noop };
  return {
    info: typeof logger.info === 'function' ? logger.info.bind(logger) : noop,
    warn: typeof logger.warn === 'function' ? logger.warn.bind(logger) : noop,
    error: typeof logger.error === 'function' ? logger.error.bind(logger) : noop,
  };
}

/**
 * 把异常收成一句话（日志和返回值都用它）。
 *
 * @param {unknown} error - 异常。
 * @returns {string} 文案。
 */
function messageOf(error) {
  if (error !== null && typeof error === 'object' && typeof error.message === 'string') return error.message;
  return String(error);
}

/** 睡一会儿（重试退避用）。 */
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * 安全地报进度：回调抛异常不影响主流程。
 *
 * @param {unknown} onProgress - 调用方给的回调。
 * @param {object} payload - 进度内容。
 * @returns {void}
 */
function report(onProgress, payload) {
  if (typeof onProgress !== 'function') return;
  try {
    onProgress(payload);
  } catch {
    /* 进度回调出错不该毁掉下载 */
  }
}

/**
 * 文件字节数；不存在/不是文件 → 0。
 *
 * @param {string} file - 路径。
 * @returns {number} 字节数。
 */
function fileSizeSync(file) {
  try {
    const st = statSync(file);
    return st.isFile() ? st.size : 0;
  } catch {
    return 0;
  }
}

/**
 * 文件字节数（异步版）。
 *
 * @param {string} file - 路径。
 * @returns {Promise<number>} 字节数。
 */
async function fileSize(file) {
  try {
    const st = await stat(file);
    return st.isFile() ? st.size : 0;
  } catch {
    return 0;
  }
}

/**
 * 递归统计目录字节数（同步；只用于 `ttsStatus()`）。
 *
 * @param {string} dir - 目录。
 * @returns {number} 字节数。
 */
function dirBytesSync(dir) {
  let total = 0;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) total += dirBytesSync(full);
    else if (entry.isFile()) total += fileSizeSync(full);
  }
  return total;
}

/**
 * 模型目录是否完整。
/**
 * Kokoro v1.1-zh 的音色表（`sid -> 名字`）。
 *
 * 来自 sherpa-onnx 官方文档的 v1.1-zh 映射表：
 * 0–1 美式女声、2 英式女声、**3–57 中文女声（55 个）**、**58–102 中文男声（45 个）**。
 * 桌宠默认用 `zf_078`（中文女声里比较自然的一个），用户可在界面上换。
 */
export const KOKORO_VOICES = [
  { sid: 0, name: 'af_maple', label: '英文女声 · maple' },
  { sid: 1, name: 'af_sol', label: '英文女声 · sol' },
  { sid: 2, name: 'bf_vale', label: '英文女声 · vale（英式）' },
  { sid: 3, name: 'zf_001', label: '中文女声 01' },
  { sid: 4, name: 'zf_002', label: '中文女声 02' },
  { sid: 5, name: 'zf_003', label: '中文女声 03' },
  { sid: 6, name: 'zf_004', label: '中文女声 04' },
  { sid: 7, name: 'zf_005', label: '中文女声 05' },
  { sid: 8, name: 'zf_006', label: '中文女声 06' },
  { sid: 9, name: 'zf_007', label: '中文女声 07' },
  { sid: 10, name: 'zf_008', label: '中文女声 08' },
  { sid: 11, name: 'zf_017', label: '中文女声 09' },
  { sid: 12, name: 'zf_018', label: '中文女声 10' },
  { sid: 13, name: 'zf_019', label: '中文女声 11' },
  { sid: 14, name: 'zf_021', label: '中文女声 12' },
  { sid: 15, name: 'zf_022', label: '中文女声 13' },
  { sid: 16, name: 'zf_023', label: '中文女声 14' },
  { sid: 17, name: 'zf_024', label: '中文女声 15' },
  { sid: 18, name: 'zf_026', label: '中文女声 16' },
  { sid: 19, name: 'zf_027', label: '中文女声 17' },
  { sid: 20, name: 'zf_028', label: '中文女声 18' },
  { sid: 21, name: 'zf_032', label: '中文女声 19' },
  { sid: 22, name: 'zf_036', label: '中文女声 20' },
  { sid: 23, name: 'zf_038', label: '中文女声 21' },
  { sid: 24, name: 'zf_039', label: '中文女声 22' },
  { sid: 25, name: 'zf_040', label: '中文女声 23' },
  { sid: 26, name: 'zf_042', label: '中文女声 24' },
  { sid: 27, name: 'zf_043', label: '中文女声 25' },
  { sid: 28, name: 'zf_044', label: '中文女声 26' },
  { sid: 29, name: 'zf_046', label: '中文女声 27' },
  { sid: 30, name: 'zf_047', label: '中文女声 28' },
  { sid: 31, name: 'zf_048', label: '中文女声 29' },
  { sid: 32, name: 'zf_049', label: '中文女声 30' },
  { sid: 33, name: 'zf_051', label: '中文女声 31' },
  { sid: 34, name: 'zf_059', label: '中文女声 32' },
  { sid: 35, name: 'zf_060', label: '中文女声 33' },
  { sid: 36, name: 'zf_067', label: '中文女声 34' },
  { sid: 37, name: 'zf_070', label: '中文女声 35' },
  { sid: 38, name: 'zf_071', label: '中文女声 36' },
  { sid: 39, name: 'zf_072', label: '中文女声 37' },
  { sid: 40, name: 'zf_073', label: '中文女声 38' },
  { sid: 41, name: 'zf_074', label: '中文女声 39' },
  { sid: 42, name: 'zf_075', label: '中文女声 40' },
  { sid: 43, name: 'zf_076', label: '中文女声 41' },
  { sid: 44, name: 'zf_077', label: '中文女声 42' },
  { sid: 45, name: 'zf_078', label: '中文女声 43' },
  { sid: 46, name: 'zf_079', label: '中文女声 44' },
  { sid: 47, name: 'zf_083', label: '中文女声 45' },
  { sid: 48, name: 'zf_084', label: '中文女声 46' },
  { sid: 49, name: 'zf_085', label: '中文女声 47' },
  { sid: 50, name: 'zf_086', label: '中文女声 48' },
  { sid: 51, name: 'zf_087', label: '中文女声 49' },
  { sid: 52, name: 'zf_088', label: '中文女声 50' },
  { sid: 53, name: 'zf_090', label: '中文女声 51' },
  { sid: 54, name: 'zf_092', label: '中文女声 52' },
  { sid: 55, name: 'zf_093', label: '中文女声 53' },
  { sid: 56, name: 'zf_094', label: '中文女声 54' },
  { sid: 57, name: 'zf_099', label: '中文女声 55' },
  { sid: 58, name: 'zm_009', label: '中文男声 01' },
  { sid: 59, name: 'zm_010', label: '中文男声 02' },
  { sid: 60, name: 'zm_011', label: '中文男声 03' },
  { sid: 61, name: 'zm_012', label: '中文男声 04' },
  { sid: 62, name: 'zm_013', label: '中文男声 05' },
  { sid: 63, name: 'zm_014', label: '中文男声 06' },
  { sid: 64, name: 'zm_015', label: '中文男声 07' },
  { sid: 65, name: 'zm_016', label: '中文男声 08' },
  { sid: 66, name: 'zm_020', label: '中文男声 09' },
  { sid: 67, name: 'zm_025', label: '中文男声 10' },
  { sid: 68, name: 'zm_029', label: '中文男声 11' },
  { sid: 69, name: 'zm_030', label: '中文男声 12' },
  { sid: 70, name: 'zm_031', label: '中文男声 13' },
  { sid: 71, name: 'zm_033', label: '中文男声 14' },
  { sid: 72, name: 'zm_034', label: '中文男声 15' },
  { sid: 73, name: 'zm_035', label: '中文男声 16' },
  { sid: 74, name: 'zm_037', label: '中文男声 17' },
  { sid: 75, name: 'zm_041', label: '中文男声 18' },
  { sid: 76, name: 'zm_045', label: '中文男声 19' },
  { sid: 77, name: 'zm_050', label: '中文男声 20' },
  { sid: 78, name: 'zm_052', label: '中文男声 21' },
  { sid: 79, name: 'zm_053', label: '中文男声 22' },
  { sid: 80, name: 'zm_054', label: '中文男声 23' },
  { sid: 81, name: 'zm_055', label: '中文男声 24' },
  { sid: 82, name: 'zm_056', label: '中文男声 25' },
  { sid: 83, name: 'zm_057', label: '中文男声 26' },
  { sid: 84, name: 'zm_058', label: '中文男声 27' },
  { sid: 85, name: 'zm_061', label: '中文男声 28' },
  { sid: 86, name: 'zm_062', label: '中文男声 29' },
  { sid: 87, name: 'zm_063', label: '中文男声 30' },
  { sid: 88, name: 'zm_064', label: '中文男声 31' },
  { sid: 89, name: 'zm_065', label: '中文男声 32' },
  { sid: 90, name: 'zm_066', label: '中文男声 33' },
  { sid: 91, name: 'zm_068', label: '中文男声 34' },
  { sid: 92, name: 'zm_069', label: '中文男声 35' },
  { sid: 93, name: 'zm_080', label: '中文男声 36' },
  { sid: 94, name: 'zm_081', label: '中文男声 37' },
  { sid: 95, name: 'zm_082', label: '中文男声 38' },
  { sid: 96, name: 'zm_089', label: '中文男声 39' },
  { sid: 97, name: 'zm_091', label: '中文男声 40' },
  { sid: 98, name: 'zm_095', label: '中文男声 41' },
  { sid: 99, name: 'zm_096', label: '中文男声 42' },
  { sid: 100, name: 'zm_097', label: '中文男声 43' },
  { sid: 101, name: 'zm_098', label: '中文男声 44' },
  { sid: 102, name: 'zm_100', label: '中文男声 45' },
];

/**
 * 默认音色（中文女声 43）。
 *
 * 挑它的理由：`zf_078` 在官方样例里被用来读中英文混排和数字/日期，
 * 是这批中文女声里被验证得最多的一个。
 */
export const DEFAULT_KOKORO_VOICE = 'zf_078';

/**
 * 音色名字 → sid。
 *
 * @param {string} name - 音色名（如 `zf_078`）。
 * @returns {number} sid；不认识就回默认音色的 sid。
 */
export function voiceToSid(name) {
  const found = KOKORO_VOICES.find((item) => item.name === name);
  if (found !== undefined) return found.sid;
  const fallback = KOKORO_VOICES.find((item) => item.name === DEFAULT_KOKORO_VOICE);
  return fallback === undefined ? 0 : fallback.sid;
}

/**
 * 模型目录是不是完整的。
 *
 * @param {string} dir - 模型目录。
 * @param {string} [model] - 模型类型（kokoro / melo）。
 * @returns {boolean} 完整 → true。
 */
function isInstalled(dir, model) {
  const kind = TTS_MODELS[model] === undefined ? DEFAULT_TTS_MODEL : model;
  const spec = TTS_MODELS[kind];
  // 远程提供者（edge）没有本地文件，永远算「已安装」
  if (spec.remote === true) return true;
  for (const name of spec.required) {
    const full = join(dir, name);
    if (fileSizeSync(full) === 0) return false;
  }
  return fileSizeSync(join(dir, spec.modelFile)) >= MIN_MODEL_BYTES;
}

/**
 * 模型是否已装（同步、便宜；给设置页/状态接口用）。
 *
 * @param {string} [model] - 模型类型（kokoro / melo），默认按默认模型。
 * @returns {object} `{ installed, dir, bytes, downloading, error, model, voices, voice }`。
 */
/**
 * 列出某个模型的音色。
 *
 * - `kokoro`：官方 103 个有名字的音色；
 * - `aishell3`：174 个说话人，官方没给名字，就按序号标注；
 * - `melo` / `zipvoice`：单音色，返回空数组。
 *
 * @param {string} kind - 模型类型。
 * @returns {Array<{sid:number, name:string, label:string}>} 音色清单。
 */
/**
 * 按模型把音色名解析成 sid。
 *
 * - kokoro：名字表查（`zf_078` → 45）；
 * - aishell3：名字就是序号（`"5"` → 5），越界夹回合法范围；
 * - 单音色模型：恒 0。
 *
 * @param {string} kind - 模型类型。
 * @param {string|number} voice - 音色名/序号。
 * @returns {number} sid。
 */
export function voiceSidFor(kind, voice) {
  const spec = TTS_MODELS[kind] === undefined ? TTS_MODELS[DEFAULT_TTS_MODEL] : TTS_MODELS[kind];
  if (spec.voiceKind === 'kokoro') return voiceToSid(String(voice));
  if (spec.voiceKind === 'index') {
    const count = Number(spec.voiceCount) > 0 ? Number(spec.voiceCount) : 0;
    const n = Number.parseInt(String(voice), 10);
    if (Number.isFinite(n) !== true) return 0;
    if (count <= 0) return Math.max(0, n);
    return Math.min(count - 1, Math.max(0, n));
  }
  return 0;
}

export function listVoices(kind) {
  const spec = TTS_MODELS[kind] === undefined ? TTS_MODELS[DEFAULT_TTS_MODEL] : TTS_MODELS[kind];
  if (spec.voiceKind === 'kokoro') return KOKORO_VOICES;
  if (spec.voiceKind === 'index') {
    const count = Number(spec.voiceCount) > 0 ? Number(spec.voiceCount) : 0;
    const list = [];
    for (let i = 0; i < count; i += 1) {
      list.push({ sid: i, name: String(i), label: `音色 ${String(i).padStart(3, '0')}` });
    }
    return list;
  }
  return [];
}

/**
 * 后台装模型（缺模型时界面上的「下载」按钮调它）。
 *
 * 立刻返回，不等下载完；进度写进 `state.install`，`ttsStatus()` 会带出去给界面轮询。
 *
 * @param {unknown} logger - 日志器。
 * @param {string} model - 模型类型。
 * @returns {{ok:boolean, model:string, error?:string}} 是否已开始。
 */
/**
 * 本地 TTS 能不能跑：`sherpa-onnx-node` 是不是加载得起来。
 *
 * 这个包**不是本插件的依赖**，是 DSH 的「语音输入（SenseVoice）」插件带进来的。
 * 别人机器上没开那个插件就借不到 —— 所以要能探测，好给界面一句准确的提示，
 * 而不是下载完 200 MB 才在合成时炸。
 *
 * @returns {{ok:boolean, version?:string, error?:string}} 可用性。
 */
export function localEngineStatus() {
  try {
    const require = createRequire(import.meta.url);
    const meta = require('sherpa-onnx-node/package.json');
    return { ok: true, version: String(meta.version || '') };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
}

export function startInstall(logger, model) {
  const kind = TTS_MODELS[model] === undefined ? DEFAULT_TTS_MODEL : model;
  const spec = TTS_MODELS[kind];
  if (spec.remote === true) return { ok: false, model: kind, error: '这是在线模型，不需要下载' };
  if (state.install !== null && state.install.model === kind) return { ok: true, model: kind };
  state.install = { model: kind, percent: 0, phase: 'download' };
  void ensureModel(logger, (progress) => {
    if (state.install === null || state.install.model !== kind) return;
    state.install.percent = Number.isFinite(Number(progress?.percent)) ? Number(progress.percent) : state.install.percent;
    state.install.phase = String(progress?.phase || state.install.phase);
  }, kind)
    .then((result) => {
      if (state.install !== null && state.install.model === kind) {
        state.install = result.ok === true ? null : { model: kind, percent: 0, phase: 'failed' };
      }
      if (result.ok === true) state.bytesMemo = -1;
    })
    .catch(() => {
      if (state.install !== null && state.install.model === kind) state.install = { model: kind, percent: 0, phase: 'failed' };
    });
  return { ok: true, model: kind };
}

export function ttsStatus(model) {
  const kind = TTS_MODELS[model] === undefined ? DEFAULT_TTS_MODEL : model;
  const spec = TTS_MODELS[kind];
  const dir = ttsModelDir(kind);
  const installed = isInstalled(dir, kind);
  if (installed && state.bytesMemo < 0) state.bytesMemo = dirBytesSync(dir);
  return {
    installed,
    dir,
    model: kind,
    bytes: installed ? state.bytesMemo : 0,
    downloading: state.downloading,
    error: state.loadError || state.downloadError || '',
    // 音色：kokoro 有名字表、aishell3 只有序号、melo 一个
    installing: state.install !== null && state.install.model === kind,
    installPercent: state.install !== null && state.install.model === kind ? state.install.percent : 0,
    installPhase: state.install !== null && state.install.model === kind ? state.install.phase : '',
    multiSpeaker: spec.multiSpeaker === true,
    voiceKind: spec.voiceKind === undefined ? 'single' : spec.voiceKind,
    voices: listVoices(kind),
  };
}

/**
 * 懒加载 `sherpa-onnx-node`（插件目录在 `D:\AI\DeepSeek-Harness\` 下，能往上解析到
 * 宿主装的 `node_modules/sherpa-onnx-node`；解析不到就把原因抛出去，不去改 node_modules）。
 *
 * @returns {object} sherpa 模块。
 */
function loadSherpa() {
  const require = createRequire(import.meta.url);
  let mod;
  try {
    mod = require('sherpa-onnx-node');
  } catch (error) {
    throw new Error(`找不到 sherpa-onnx-node（${messageOf(error)}）`);
  }
  if (mod === null || typeof mod !== 'object' || typeof mod.OfflineTts !== 'function') {
    throw new Error('sherpa-onnx-node 里没有 OfflineTts（版本太老？）');
  }
  return mod;
}

/**
 * 组装 `OfflineTtsConfig`。
 *
 * 注意 `numThreads` / `provider` / `debug` 要放在 `model` 里面 ——
 * 原生绑定是 `GetOfflineTtsModelConfig(config.model)` 里读的（`types.js` 写成顶层是错的）。
 *
 * `ruleFsts` 是模型自带的正规化规则（数字/日期/电话/多音字）。实测带上之后
 * "13800138000 / 2026年10月26日" 会被念成中文，不带就被当 OOV 丢掉（11.03 s vs 14.52 s 的差别）。
 *
 * @param {string} dir - 模型目录。
 * @returns {object} 配置对象。
 */
function buildConfig(dir, model) {
  const kind = TTS_MODELS[model] === undefined ? DEFAULT_TTS_MODEL : model;
  const spec = TTS_MODELS[kind];
  const engine = spec.engine === undefined ? 'vits' : spec.engine;
  let modelBlock;
  let threads = TTS_NUM_THREADS;
  if (engine === 'kokoro') {
    modelBlock = {
      kokoro: {
        model: join(dir, 'model.int8.onnx'),
        voices: join(dir, 'voices.bin'),
        tokens: join(dir, 'tokens.txt'),
        dataDir: join(dir, 'espeak-ng-data'),
        // 中英词典都带上：这个模型中英混排，只给中文词典会把英文单词念错
        lexicon: [join(dir, 'lexicon-us-en.txt'), join(dir, 'lexicon-zh.txt')].join(','),
      },
    };
    threads = TTS_NUM_THREADS_KOKORO;
  } else if (engine === 'zipvoice') {
    modelBlock = {
      zipvoice: {
        tokens: join(dir, 'tokens.txt'),
        // int8 版比 fp32 快（实测 16.8 s vs 22.8 s），文件也小 4 倍
        encoder: join(dir, 'text_encoder_int8.onnx'),
        decoder: join(dir, 'fm_decoder_int8.onnx'),
        vocoder: join(dir, 'vocos_24khz.onnx'),
        dataDir: join(dir, 'espeak-ng-data'),
        lexicon: join(dir, 'pinyin.raw'),
        // 官方推荐值（sherpa-onnx 文档）
        featScale: 0.1,
        tShift: 0.5,
        targetRms: 0.1,
        guidanceScale: 1.0,
      },
    };
  } else {
    modelBlock = {
      vits: {
        model: join(dir, spec.modelFile),
        lexicon: join(dir, 'lexicon.txt'),
        tokens: join(dir, 'tokens.txt'),
        // vits 模型（melo / aishell3）不吃 data_dir，也不支持 dictDir（JS 绑定没这个字段）。
        dataDir: '',
        // 语速走 generate 时的 generationConfig.speed（内部 = lengthScale = 1/speed），这里保持 1.0。
        lengthScale: 1.0,
      },
    };
  }
  const config = {
    model: { ...modelBlock, numThreads: threads, debug: 0, provider: 'cpu' },
    maxNumSentences: 1,
    silenceScale: 0.2,
  };
  const ruleFsts = spec.ruleFsts
    .map((name) => join(dir, name))
    .filter((file) => existsSync(file));
  if (ruleFsts.length > 0) config.ruleFsts = ruleFsts.join(',');
  return config;
}

/**
 * 取（必要时建）`OfflineTts` 实例。并发调用共用同一次加载。
 *
 * **按模型缓存**：换模型会重建实例（两个模型的目录/配置完全不同）。
 *
 * @param {unknown} logger - 日志器。
 * @param {string} [model] - 模型类型（kokoro / melo）。
 * @returns {Promise<object>} `OfflineTts` 实例。
 */
async function getEngine(logger, model) {
  const kind = TTS_MODELS[model] === undefined ? DEFAULT_TTS_MODEL : model;
  if (state.tts !== null && state.model === kind) return state.tts;
  if (state.tts !== null && state.model !== kind) disposeTts();
  if (state.loading !== null) return state.loading;

  const log = useLogger(logger);
  const dir = ttsModelDir(kind);
  if (!isInstalled(dir, kind)) throw new Error(`TTS 模型还没装：${dir}（先 ensureModel()）`);

  state.loading = (async () => {
    const started = Date.now();
    const sherpa = loadSherpa();
    const config = buildConfig(dir, kind);
    // createAsync 在 worker 线程建模型，不堵事件循环（1.13.x 有；老版本退回同步构造）。
    const tts = typeof sherpa.OfflineTts.createAsync === 'function'
      ? await sherpa.OfflineTts.createAsync(config)
      : new sherpa.OfflineTts(config);
    state.tts = tts;
    state.model = kind;
    state.sampleRate = Number(tts.sampleRate) || 0;
    state.numSpeakers = Number(tts.numSpeakers) || 1;
    state.loadMs = Date.now() - started;
    state.loadError = '';
    log.info(`TTS 模型已加载（${kind}，${state.loadMs} ms，采样率 ${state.sampleRate} Hz，音色数 ${state.numSpeakers}）`);
    return tts;
  })();

  try {
    return await state.loading;
  } catch (error) {
    state.tts = null;
    state.loadError = messageOf(error);
    log.error(`TTS 模型加载失败：${state.loadError}`);
    throw error;
  } finally {
    state.loading = null;
  }
}

/**
 * 清掉（释放）`OfflineTts` 实例；下次 `synthesize()` 会重建。
 *
 * 说明：JS 绑定没有 `free()`，原生句柄挂在 Napi External 的 finalizer 上，
 * 所以这里做的是"丢引用 + 有 `--expose-gc` 时顺手催一下 GC"，剩下的交给 V8。
 *
 * @returns {boolean} 恒为 true。
 */
export function disposeTts() {
  const tts = state.tts;
  state.tts = null;
  state.model = '';
  state.sampleRate = 0;
  state.loadMs = 0;
  if (tts !== null && typeof tts.free === 'function') {
    try {
      tts.free();
    } catch {
      /* 老版本没有 free，忽略 */
    }
  }
  if (typeof globalThis.gc === 'function') {
    try {
      globalThis.gc();
    } catch {
      /* 没开 --expose-gc 就算了 */
    }
  }
  return true;
}

/**
 * 文本归一化：去控制字符/emoji、压空白、超长截到句子边界。
 *
 * @param {unknown} text - 原始文本。
 * @returns {{text:string, truncated:boolean, empty:boolean}} 归一化结果。
 */
function normalizeText(text) {
  let s = typeof text === 'string' ? text : (text === null || text === undefined ? '' : String(text));
  // 控制字符、零宽字符、emoji（模型词表里没有，喂进去只会变成 OOV）
  s = s.replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028\u2029\ufeff]/g, ' ');
  s = s.replace(/[\u{1f000}-\u{1faff}\u{2600}-\u{27bf}\u{fe0f}\u{1f1e6}-\u{1f1ff}]/gu, '');
  s = s.replace(/\s+/g, ' ').trim();

  if (s.length > TTS_MAX_CHARS) {
    const head = s.slice(0, TTS_MAX_CHARS);
    // 往回收一句，别把词/句子砍半
    const cut = Math.max(
      head.lastIndexOf('。'), head.lastIndexOf('！'), head.lastIndexOf('？'),
      head.lastIndexOf('；'), head.lastIndexOf('，'),
      head.lastIndexOf('.'), head.lastIndexOf('!'), head.lastIndexOf('?'),
      head.lastIndexOf(';'), head.lastIndexOf(','),
    );
    return { text: cut >= 40 ? head.slice(0, cut + 1) : head, truncated: true, empty: false };
  }
  // 没有任何可念的字符（纯标点/纯空白）→ 当空文本处理
  if (!/[\u4e00-\u9fff\u3400-\u4dbfA-Za-z0-9]/.test(s)) {
    return { text: '', truncated: false, empty: true };
  }
  return { text: s, truncated: false, empty: s === '' };
}

/**
 * 语速夹到 `[0.5, 2.0]`，默认 1.0。
 *
 * @param {unknown} speed - 调用方给的值。
 * @returns {number} 可用语速。
 */
function clampSpeed(speed) {
  const n = Number(speed);
  if (!Number.isFinite(n) || n <= 0) return 1.0;
  return Math.min(2.0, Math.max(0.5, n));
}

/**
 * Float32 采样 → 16 位 PCM 的完整 WAV（单声道；采样率以模型为准）。
 *
 * **归一化**：`vits-melo-tts-zh_en` 出来的波形峰值只有满幅的 **12% 左右**（实测 4001/32768），
 * 比正常语音低约 **18 dB** —— 直接播会"听不见"（用户实测反馈）。所以这里按**峰值归一**到 0.89，
 * 留一点余量不削顶；增益上限 12 倍，避免把纯底噪也放大成噪声。
 *
 * @param {Float32Array} samples - [-1, 1] 的采样。
 * @param {number} sampleRate - 采样率。
 * @returns {Buffer} WAV 字节（Buffer 是 Uint8Array 的子类）。
 */
function encodeWav(samples, sampleRate, userVolume) {
  const n = samples.length;
  const dataBytes = n * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16); // fmt chunk 大小
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // 单声道
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); // byteRate
  buf.writeUInt16LE(2, 32); // blockAlign
  buf.writeUInt16LE(16, 34); // 位深
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataBytes, 40);
  // 先量峰值，再决定增益
  let peak = 0;
  for (let i = 0; i < n; i += 1) {
    const abs = samples[i] > 0 ? samples[i] : -samples[i];
    if (abs > peak) peak = abs;
  }
  // 峰值归一到 0.89，再乘用户音量：音量允许到 2.0，就是超出满幅的软增益（靠下面 clamp 削顶）。
  const volume = Number.isFinite(Number(userVolume)) ? Math.max(0, Math.min(2, Number(userVolume))) : 1;
  const gain = (peak > 0.001 ? Math.min(12, 0.89 / peak) : 1) * volume;
  for (let i = 0; i < n; i += 1) {
    const v = samples[i] * gain;
    const clamped = v > 1 ? 1 : (v < -1 ? -1 : v);
    buf.writeInt16LE(Math.round(clamped * 32767), 44 + i * 2);
  }
  return buf;
}

/**
 * zipvoice 的参考音频（零样本克隆用）。
 *
 * 模型包里自带 `prompt.wav`（16 kHz 单声道 7.2 秒），但**必须配一段参考文本**，
 * 否则 `generate` 直接失败（实测 `TTS generation failed`）。包里的文本没给，
 * 我用本机 SenseVoice 把它转了出来（见 `ZIPVOICE_REF_TEXT`）。
 *
 * 读一次缓存住：7.2 秒 × 16 kHz 的 Float32Array 也就 460 KB。
 */
let zipvoiceRef = null;

/** `prompt.wav` 的转写文本（SenseVoice 识别结果）。 */
const ZIPVOICE_REF_TEXT = '周日被我射熄火了，所以今天是周一。';

/**
 * 读一个 16 位 PCM WAV → `{samples, rate}`（只给 zipvoice 的参考音频用）。
 *
 * @param {string} file - WAV 路径。
 * @returns {{samples: Float32Array, rate: number}|null} 结果；读不了返回 null。
 */
function readRefWav(file) {
  try {
    const buf = readFileSync(file);
    const rate = buf.readUInt32LE(24);
    let offset = 12;
    while (offset < buf.length - 8) {
      const id = buf.toString('ascii', offset, offset + 4);
      const size = buf.readUInt32LE(offset + 4);
      if (id === 'data') { offset += 8; break; }
      offset += 8 + size;
    }
    const count = Math.floor((buf.length - offset) / 2);
    const samples = new Float32Array(count);
    for (let i = 0; i < count; i += 1) samples[i] = buf.readInt16LE(offset + i * 2) / 32768;
    return { samples, rate };
  } catch {
    return null;
  }
}

/**
 * 变调：把采样**重采样**若干半音。
 *
 * 原理：重采样 k 倍会让音高 ×k、时长 ÷k。为了只变音高不变时长，
 * 先用 VITS 的 `speed` 把音频拉长到 k 倍（VITS 的 speed 只改时长、不改音高），
 * 再重采样 k 倍 —— 时长回到原样，音高变成 k 倍。
 *
 * @param {Float32Array} samples - 原始采样。
 * @param {number} factor - 音高倍数（1 = 不变）。
 * @returns {Float32Array} 变调后的采样。
 */
function resampleForPitch(samples, factor) {
  if (!(factor > 0) || Math.abs(factor - 1) < 1e-3) return samples;
  const outLength = Math.max(1, Math.floor(samples.length / factor));
  const out = new Float32Array(outLength);
  for (let i = 0; i < outLength; i += 1) {
    const src = i * factor;
    const left = Math.floor(src);
    const right = Math.min(left + 1, samples.length - 1);
    const frac = src - left;
    // 线性插值：±3 半音以内听不出明显失真，够桌宠用
    out[i] = samples[left] * (1 - frac) + samples[right] * frac;
  }
  return out;
}

/**
 * 半音 → 频率倍数。
 *
 * @param {unknown} semitones - 半音数（-12 ~ +12）。
 * @returns {number} 倍数（0.5 ~ 2）。
 */
function pitchFactor(semitones) {
  const n = Number(semitones);
  const safe = Number.isFinite(n) ? Math.max(-12, Math.min(12, n)) : 0;
  return Math.pow(2, safe / 12);
}

/**
 * 合成一句话（契约接口）。
 *
 * @param {unknown} logger - 日志器（可为 null）。
 * @param {unknown} text - 要说的话（中英混合）。
 * @param {{speed?:number, model?:string, voice?:string}} [options] - 语速（0.5–2.0）、
 *   模型类型（kokoro / melo）、音色名（kokoro 才有意义，如 `zf_078`）。
 * @returns {Promise<{ok:boolean, wav:Uint8Array, ms:number, error?:string,
 *   sampleRate?:number, durationMs?:number, bytes?:number, text?:string, truncated?:boolean,
 *   model?:string, voice?:string}>} 结果。
 */
export async function synthesize(logger, text, options) {
  const started = Date.now();
  const log = useLogger(logger);
  const opts = options !== null && typeof options === 'object' ? options : {};
  const earlyKind = TTS_MODELS[opts.model] === undefined ? DEFAULT_TTS_MODEL : opts.model;
  // 远程提供者（edge）直接委派：它自己出 mp3，不走本地 WAV 那条路
  if (TTS_MODELS[earlyKind].engine === 'edge') {
    const { synthesizeEdge } = await import('./tts-edge.js');
    const remote = await synthesizeEdge({
      text,
      voice: typeof opts.voice === 'string' ? opts.voice : '',
      speed: opts.speed,
      volume: opts.volume,
      pitch: opts.pitch,
    });
    if (remote.ok !== true) {
      return { ok: false, wav: EMPTY_WAV, ms: Date.now() - started, error: remote.error };
    }
    return {
      ok: true,
      // 字段名仍叫 wav（调用方只要"一段可播的字节"），mime 说明真实格式是 mp3
      wav: remote.audio,
      mime: remote.mime,
      ms: remote.ms,
      bytes: remote.audio.length,
      text: String(text).slice(0, TTS_MAX_CHARS),
      model: 'edge',
      voice: remote.voice,
    };
  }
  const speed = clampSpeed(opts.speed);
  // 变调：先按 1/k 放慢合成（VITS 只改时长），再重采样 k 倍把时长还原、音高抬高 k 倍
  const kFactor = pitchFactor(opts.pitch);
  const synthSpeed = clampSpeed(speed / kFactor);
  const model = TTS_MODELS[opts.model] === undefined ? DEFAULT_TTS_MODEL : opts.model;
  const voxel = typeof opts.voice === 'string' && opts.voice !== '' ? opts.voice : DEFAULT_KOKORO_VOICE;
  const sid = TTS_MODELS[model].multiSpeaker === true ? voiceSidFor(model, voxel) : 0;
  const norm = normalizeText(text);

  if (norm.empty || norm.text === '') {
    return { ok: false, wav: EMPTY_WAV, ms: Date.now() - started, error: '空文本，不合成' };
  }
  if (norm.truncated) {
    log.warn(`TTS 文本超过 ${TTS_MAX_CHARS} 字，已截断到 ${norm.text.length} 字再合成`);
  }

  let engine;
  try {
    engine = await getEngine(logger, model);
  } catch (error) {
    // 借不到 sherpa-onnx-node 时给一句人话：这不是模型没下载，是宿主缺「语音输入」插件
    const raw = messageOf(error);
    const friendly = /MODULE_NOT_FOUND|Cannot find module/i.test(raw)
      ? '本地语音引擎不可用：请在 DSH 插件里开启「语音输入」插件（它提供 sherpa-onnx 运行时）'
      : raw;
    return { ok: false, wav: EMPTY_WAV, ms: Date.now() - started, error: friendly };
  }

  try {
    // zipvoice 是零样本克隆：**必须**带参考音频 + 参考文本，否则 generate 直接失败（实测）。
    // 其它模型（vits / kokoro）不带。
    const genCfg = { speed: synthSpeed, sid };
    if (TTS_MODELS[model].engine === 'zipvoice') {
      if (zipvoiceRef === null) zipvoiceRef = readRefWav(join(ttsModelDir(model), 'prompt.wav'));
      if (zipvoiceRef !== null) {
        genCfg.referenceAudio = zipvoiceRef.samples;
        genCfg.referenceSampleRate = zipvoiceRef.rate;
        genCfg.referenceText = ZIPVOICE_REF_TEXT;
      }
    }
    // 老版本绑定没有 generateAsync 就退回同步 generate（阻塞事件循环，但至少能出声）。
    const audio = typeof engine.generateAsync === 'function'
      ? await engine.generateAsync({
        text: norm.text,
        generationConfig: genCfg,
        enableExternalBuffer: false,
      })
      : engine.generate({
        text: norm.text,
        sid,
        speed: synthSpeed,
        enableExternalBuffer: false,
      });
    const rawSamples = audio !== null && typeof audio === 'object' ? audio.samples : null;
    if (!rawSamples || rawSamples.length === 0) throw new Error('合成结果为空（模型没吐采样）');
    const samples = resampleForPitch(rawSamples, kFactor);
    const sampleRate = Number(audio.sampleRate) || state.sampleRate || 0;
    const wav = encodeWav(samples, sampleRate, opts.volume);
    const durationMs = Math.round((samples.length / sampleRate) * 1000);
    return {
      ok: true,
      wav,
      ms: Date.now() - started,
      sampleRate,
      durationMs,
      bytes: wav.length,
      text: norm.text,
      truncated: norm.truncated,
      model,
      voice: TTS_MODELS[model].multiSpeaker === true ? voxel : 'melo-default',
      sid,
    };
  } catch (error) {
    const message = messageOf(error);
    log.error(`TTS 合成失败：${message}`);
    return { ok: false, wav: EMPTY_WAV, ms: Date.now() - started, error: message };
  }
}

/**
 * 找 `tar.exe`：Win11 自带 bsdtar（支持 bz2），优先用 System32 里那个绝对路径。
 *
 * @returns {string} 可执行的 tar 路径。
 */
function tarPath() {
  const systemRoot = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  const native = join(systemRoot, 'System32', 'tar.exe');
  if (existsSync(native)) return native;
  return 'tar.exe';
}

/**
 * 跑一个子进程（stdout/stderr 落文件，避免管道在受限环境下的坑）。
 *
 * @param {string} command - 可执行文件。
 * @param {string[]} args - 参数。
 * @param {number} timeoutMs - 超时。
 * @returns {Promise<void>} 失败抛异常（带 stderr 尾巴）。
 */
async function runProcess(command, args, timeoutMs) {
  const logFile = join(process.env.TEMP || process.env.TMP || homedir(), `dshcw-tts-${Date.now()}.log`);
  const fd = openSync(logFile, 'w');
  try {
    await new Promise((resolve, reject) => {
      let settled = false;
      const child = spawn(command, args, { stdio: ['ignore', fd, fd], windowsHide: true });
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          child.kill();
        } catch {
          /* 已经退了 */
        }
        reject(new Error(`${command} 超时（${timeoutMs} ms）`));
      }, timeoutMs);
      child.on('error', (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error(`启动 ${command} 失败：${messageOf(error)}`));
      });
      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code === 0) {
          resolve();
          return;
        }
        let tail = '';
        try {
          tail = readFileSync(logFile, 'utf8').trim().slice(-600);
        } catch {
          /* 日志读不到就算了 */
        }
        reject(new Error(`${command} 退出码 ${code}${tail === '' ? '' : `：${tail}`}`));
      });
    });
  } finally {
    closeSync(fd);
    try {
      rm(logFile, { force: true });
    } catch {
      /* 删不掉无所谓 */
    }
  }
}

/**
 * 从指定偏移下载（`start > 0` 时带 Range）。返回 true = 文件已完整。
 *
 * 实测脾气：这台机器上 GitHub release 的 Range 请求**经常直接 ECONNRESET**
 * （curl 也一样，code=000），所以续传只当"顺手试试"，失败就从头下。
 *
 * @param {string} part - `.part` 临时文件。
 * @param {number} start - 从第几个字节开始（0 = 从头）。
 * @param {unknown} logger - 日志器。
 * @param {unknown} onProgress - 进度回调。
 * @returns {Promise<boolean>} 是否完整。
 */
async function downloadFrom(part, start, logger, onProgress, model) {
  const log = useLogger(logger);
  const headers = { 'accept-encoding': 'identity' };
  if (start > 0) headers.range = `bytes=${start}-`;

  const res = await fetch(modelUrl(model), { headers, redirect: 'follow' });

  let begin = 0;
  let total = 0;
  if (res.status === 206) {
    const contentRange = res.headers.get('content-range') || '';
    const match = /\/(\d+)\s*$/.exec(contentRange);
    total = match === null ? 0 : Number(match[1]);
    begin = start;
    log.info(`TTS 模型续传：从 ${(begin / 1048576).toFixed(1)} MB 开始`);
  } else if (res.status === 200) {
    total = Number(res.headers.get('content-length') || 0);
    begin = 0;
  } else if (res.status === 416) {
    throw new Error('续传位置越界（HTTP 416）');
  } else {
    throw new Error(`下载失败：HTTP ${res.status} ${res.statusText}`);
  }

  if (res.body === null) throw new Error('下载失败：响应没有 body');

  const out = createWriteStream(part, { flags: begin > 0 ? 'a' : 'w' });
  let received = begin;
  let lastReport = 0;
  const reader = res.body.getReader();

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      received += value.length;
      if (!out.write(Buffer.from(value))) {
        await new Promise((resolve) => { out.once('drain', resolve); });
      }
      const now = Date.now();
      if (now - lastReport >= 500) {
        lastReport = now;
        report(onProgress, {
          phase: 'download',
          received,
          total,
          percent: total > 0 ? Math.min(100, Math.round((received / total) * 100)) : 0,
        });
      }
    }
  } finally {
    await new Promise((resolve) => { out.end(resolve); });
  }

  report(onProgress, { phase: 'download', received, total, percent: 100 });
  return total === 0 || received >= total;
}

/**
 * 下载一次：先试续传，不行就把 `.part` 删掉从头下。返回 true = 文件已完整。
 *
 * @param {string} part - `.part` 临时文件。
 * @param {unknown} logger - 日志器。
 * @param {unknown} onProgress - 进度回调。
 * @returns {Promise<boolean>} 是否完整。
 */
async function downloadOnce(part, logger, onProgress) {
  const log = useLogger(logger);
  const have = await fileSize(part);
  if (have > 0) {
    try {
      const done = await downloadFrom(part, have, logger, onProgress, model);
      if (done) return true;
    } catch (error) {
      log.warn(`续传失败（${messageOf(error)}），改从头下载`);
    }
    await rm(part, { force: true }).catch(() => {});
    report(onProgress, { phase: 'download', received: 0, total: 0, percent: 0, restart: true });
  }
    return downloadFrom(part, 0, logger, onProgress, model);
}

/**
 * 下载模型压缩包（带续传 + 重试；`dest` 已存在就直接复用）。
 *
 * @param {unknown} logger - 日志器。
 * @param {unknown} onProgress - 进度回调。
 * @returns {Promise<string>} 压缩包路径。
 */
async function downloadArchive(logger, onProgress, model) {
  const log = useLogger(logger);
  const dest = ttsArchivePath(model);
  if ((await fileSize(dest)) > MIN_MODEL_BYTES) {
    log.info('TTS 模型压缩包已在缓存里，跳过下载');
    return dest;
  }
  const part = `${dest}.part`;
  let lastError = '';
  for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt += 1) {
    try {
      const complete = await downloadOnce(part, logger, onProgress);
      if (!complete) throw new Error('下载不完整（长度对不上）');
      await rename(part, dest);
      log.info(`TTS 模型下载完成：${(await fileSize(dest) / 1048576).toFixed(1)} MB`);
      return dest;
    } catch (error) {
      lastError = messageOf(error);
      log.warn(`TTS 模型下载第 ${attempt}/${DOWNLOAD_ATTEMPTS} 次失败：${lastError}`);
      if (attempt < DOWNLOAD_ATTEMPTS) await sleep(1000 * attempt);
    }
  }
  throw new Error(`下载失败（已试 ${DOWNLOAD_ATTEMPTS} 次）：${lastError}`);
}

/**
 * 目录里有没有"完整模型"（找 model.onnx 用）。
 *
 * @param {string} dir - 目录。
 * @returns {boolean} 是模型目录 → true。
 */
function looksLikeModel(dir) {
  return fileSizeSync(join(dir, 'model.onnx')) >= MIN_MODEL_BYTES
    && fileSizeSync(join(dir, 'tokens.txt')) > 0;
}

/**
 * 在解压目录里找模型根（压缩包可能带一层 `vits-melo-tts-zh_en/`，也可能直接铺平）。
 *
 * @param {string} staging - 解压暂存目录。
 * @returns {Promise<string>} 模型根目录；找不到 → 空串。
 */
async function findModelRoot(staging, model) {
  const preferred = join(staging, TTS_MODELS[model === undefined || TTS_MODELS[model] === undefined ? DEFAULT_TTS_MODEL : model].id);
  if (looksLikeModel(preferred)) return preferred;

  let level1 = [];
  try {
    level1 = await readdir(staging, { withFileTypes: true });
  } catch {
    return '';
  }
  for (const entry of level1) {
    if (!entry.isDirectory()) continue;
    const dir = join(staging, entry.name);
    if (looksLikeModel(dir)) return dir;
  }
  for (const entry of level1) {
    if (!entry.isDirectory()) continue;
    const dir = join(staging, entry.name);
    let level2 = [];
    try {
      level2 = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const sub of level2) {
      if (!sub.isDirectory()) continue;
      const dir2 = join(dir, sub.name);
      if (looksLikeModel(dir2)) return dir2;
    }
  }
  return '';
}

/**
 * 把解压出来的模型目录挪到目标位置（同盘 rename；跨盘退回复制）。
 *
 * @param {string} from - 源目录。
 * @param {string} to - 目标目录。
 * @returns {Promise<void>} 失败抛异常。
 */
async function moveDir(from, to) {
  try {
    await rename(from, to);
    return;
  } catch (error) {
    if (error !== null && typeof error === 'object' && error.code === 'EXDEV') {
      const { cp } = await import('node:fs/promises');
      await cp(from, to, { recursive: true });
      await rm(from, { recursive: true, force: true });
      return;
    }
    throw error;
  }
}

/**
 * 确保模型在本地：缺就下载 + 解压 + 校验（契约接口）。
 *
 * 并发调用共用同一次安装；已经装好直接返回（不重复下载）。
 *
 * @param {unknown} logger - 日志器。
 * @param {(p:{phase:string, received?:number, total?:number, percent?:number}) => void} [onProgress] - 进度回调。
 * @returns {Promise<{ok:boolean, dir:string, error?:string}>} 结果。
 */
export async function ensureModel(logger, onProgress, model) {
  if (state.ensure !== null) return state.ensure;

  const kind = TTS_MODELS[model] === undefined ? DEFAULT_TTS_MODEL : model;
  const log = useLogger(logger);
  const dir = ttsModelDir(kind);

  state.ensure = (async () => {
    if (isInstalled(dir, kind)) {
      state.downloadError = '';
      return { ok: true, dir };
    }
    state.downloading = true;
    let stage = 'download';
    try {
      mkdirSync(ttsRootDir(), { recursive: true });
      const archive = await downloadArchive(logger, onProgress, kind);

      stage = 'extract';
      report(onProgress, { phase: 'extract', percent: 0 });
      const staging = await mkdtemp(join(ttsRootDir(), 'extract-'));
      try {
        log.info(`解压 TTS 模型（${tarPath()} -xjf）…`);
        await runProcess(tarPath(), ['-xjf', archive, '-C', staging], EXTRACT_TIMEOUT_MS);
        const found = await findModelRoot(staging, kind);
        if (found === '') throw new Error('压缩包里没找到 model.onnx（解压后结构不对）');
        await rm(dir, { recursive: true, force: true });
        await moveDir(found, dir);
      } finally {
        await rm(staging, { recursive: true, force: true }).catch(() => {});
      }

      if (!isInstalled(dir, kind)) throw new Error(`解压完成但缺文件（需要 ${TTS_MODELS[kind].required.join(' / ')}）`);
      state.bytesMemo = -1;
      state.downloadError = '';
      await rm(archive, { force: true }).catch(() => {});
      report(onProgress, { phase: 'done', percent: 100 });
      log.info(`TTS 模型已就绪：${dir}（${(dirBytesSync(dir) / 1048576).toFixed(1)} MB）`);
      return { ok: true, dir };
    } catch (error) {
      state.downloadError = messageOf(error);
      log.error(`TTS 模型安装失败：${state.downloadError}`);
      // 解压/校验失败时把压缩包扔掉，下次重下（否则会一直复用坏包，永远装不上）
      if (stage === 'extract') await rm(ttsArchivePath(kind), { force: true }).catch(() => {});
      return { ok: false, dir, error: state.downloadError };
    } finally {
      state.downloading = false;
    }
  })();

  try {
    return await state.ensure;
  } finally {
    state.ensure = null;
  }
}
