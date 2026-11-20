/**
 * @local/chat-widget —— edge-tts（微软 Edge 的在线朗读）作为 TTS 提供者。
 *
 * ## 为什么用它
 *
 * 本地那几个模型实测都不合用（用户原话："这些标榜百来个音色的真是滥竽充数"）：
 * MeloTTS 音质最好但只有 1 个中文女声，AISHELL-3 174 个音色只有 8 kHz，Kokoro 一句要等 5 秒，
 * ZipVoice 要 31 秒。edge-tts 有 **14 个中文音色** + **可调音调**，零下载零内存，代价是要联网。
 *
 * ## 协议（照 `edge-tts 7.3.1` 移植，不用 npm 包）
 *
 * 1. 连 `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1`
 *    带 `TrustedClientToken`、`Sec-MS-GEC`（**v2 令牌**，见 `edge-token.js`）、
 *    `Sec-MS-GEC-Version=2-<Chrome 版本>`、`ConnectionId`；
 * 2. 请求头要 `Origin: chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold`、Edge UA、
 *    以及 `Cookie: muid=<32 hex>` —— **缺 Origin/UA 会被直接拒（1006）**；
 * 3. 先发 `speech.config`（要 mp3），再发 SSML（`<voice><prosody pitch rate volume>`）；
 * 4. 收二进制帧（前 2 字节大端 = 头长度，跳过是 mp3），文本帧 `Path:turn.end` 表示结束。
 *
 * **旧算法（v1 令牌 / Chromium 130）现在一律 403** —— 这就是第一版连不上的原因。
 *
 * @module @local/chat-widget/host/tts-edge
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import { generateSecMsGecV2, TRUSTED_CLIENT_TOKEN } from './edge-token.js';

/**
 * 找 `ws` 的实现。
 *
 * Edge 的语音端点要自定义握手头（User-Agent / Origin / Cookie: muid），
 * Node 内置的 `WebSocket` 传不了头（实测连上去直接被拒），所以必须用 `ws`。
 *
 * 三条路，按可靠性排：
 *   1. 插件目录能解析到 `ws`（正常安装时命中不了，留着兼容别人把它装成真依赖）；
 *   2. **从 DSH 安装目录里借**：桌面端本来就在 `resources/app.asar/dsh/node_modules/ws`
 *      带着一份，宿主进程是 Electron 的 Node 模式，asar 里的模块照样 require 得到
 *      （实测 `createRequire(...)( 'ws')` 成功）；
 *   3. 都找不到 → 返回 null，调用方报"找不到 ws 模块"。
 *
 * 为什么要加第 2 条：插件是 `link:` 装进 profile 的，裸 `require('ws')` 只会从插件目录
 * 往上找 node_modules，找不到安装目录里那份 —— 于是 Edge 语音一直是"连不上"。
 *
 * @returns {Function|null} `ws` 的构造函数；没有就 null。
 */
function loadWs() {
  const requireFromHere = createRequire(import.meta.url);
  try {
    return requireFromHere('ws');
  } catch { /* 继续找安装目录那份 */ }

  const bases = [];
  try {
    bases.push(dirname(process.execPath));
  } catch { /* 读不到就跳过 */ }
  try {
    if (typeof process.resourcesPath === 'string' && process.resourcesPath !== '') {
      bases.push(dirname(process.resourcesPath));
    }
  } catch { /* 同上 */ }

  // 每个候选基目录下，`ws` 可能落在这些位置（便携版 / 安装版 / 旧版布局都试一遍）
  const anchors = [
    ['resources', 'app.asar', 'dsh', 'package.json'],
    ['resources', 'app.asar', 'package.json'],
    ['resources', 'app', 'package.json'],
    ['package.json'],
  ];
  for (const base of bases) {
    for (const anchor of anchors) {
      try {
        return createRequire(join(base, ...anchor))('ws');
      } catch { /* 换下一个锚点 */ }
    }
  }
  return null;
}

/** Edge 语音用的 WebSocket 实现（宿主 node_modules 里那份，或从 DSH 安装目录借来的）。 */
const WsImpl = loadWs();

/** 版本号进令牌，写错就是 403 —— 跟 7.3.1 对齐。 */
const CHROMIUM_FULL_VERSION = '143.0.3650.75';
const CHROMIUM_MAJOR = CHROMIUM_FULL_VERSION.split('.')[0];
const SEC_MS_GEC_VERSION = `2-${CHROMIUM_FULL_VERSION}`;

/** 基础地址。 */
const BASE_URL = 'speech.platform.bing.com/consumer/speech/synthesize/readaloud';

/** 要 mp3（24 kHz 48 kbps 单声道）。 */
const OUTPUT_FORMAT = 'audio-24khz-48kbitrate-mono-mp3';

/** 连接超时。 */
const CONNECT_TIMEOUT_MS = 10000;

/** 整句合成的超时。 */
const SYNTH_TIMEOUT_MS = 30000;

/** 一次最多多少字。 */
const EDGE_MAX_CHARS = 500;

/** 公共请求头（照 7.3.1 的 BASE_HEADERS）。 */
const BASE_HEADERS = {
  'User-Agent': `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROMIUM_MAJOR}.0.0.0 Safari/537.36 Edg/${CHROMIUM_MAJOR}.0.0.0`,
  'Accept-Encoding': 'gzip, deflate, br, zstd',
  'Accept-Language': 'en-US,en;q=0.9',
};

/** WS 握手额外头（照 7.3.1 的 WSS_HEADERS）。 */
const WSS_HEADERS = {
  ...BASE_HEADERS,
  Pragma: 'no-cache',
  'Cache-Control': 'no-cache',
  Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
  'Sec-WebSocket-Version': '13',
};

/**
 * 生成一个 MUID（微软拿它当设备标识，写进 Cookie）。
 *
 * @returns {string} 32 位大写十六进制。
 */
function makeMuid() {
  return randomBytes(16).toString('hex').toUpperCase();
}

/**
 * 列出中文音色（`zh-*`）。
 *
 * @returns {Promise<Array<{name:string, gender:string, locale:string, label:string}>>} 音色。
 */
export async function listEdgeVoices() {
  const response = await fetch(`https://${BASE_URL}/voices/list?trustedclienttoken=${TRUSTED_CLIENT_TOKEN}`, {
    headers: {
      ...BASE_HEADERS,
      Authority: 'speech.platform.bing.com',
      'Sec-CH-UA': `" Not;A Brand";v="99", "Microsoft Edge";v="${CHROMIUM_MAJOR}", "Chromium";v="${CHROMIUM_MAJOR}"`,
      'Sec-CH-UA-Mobile': '?0',
      accept: '*/*',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Dest': 'empty',
    },
  });
  if (response.ok !== true) throw new Error(`取音色列表失败：HTTP ${response.status}`);
  const all = await response.json();
  if (Array.isArray(all) !== true) throw new Error('音色列表格式不对');
  return all
    .filter((item) => String(item.Locale || '').startsWith('zh'))
    .map((item) => ({
      name: String(item.ShortName),
      gender: String(item.Gender || ''),
      locale: String(item.Locale || ''),
      label: String(item.FriendlyName || item.ShortName),
    }));
}

/** 音色列表缓存（1 小时；接口基本不变，没必要每次进设置都打一次网络）。 */
let voiceCache = null;
let voiceCacheAt = 0;
const VOICE_CACHE_MS = 3600 * 1000;

/**
 * 取中文音色（带缓存）。取不到就返回上一次的结果（可能是空数组），**绝不抛**。
 *
 * @returns {Promise<Array<{sid:number, name:string, label:string}>>} 音色（`sid` 用序号，方便界面统一渲染）。
 */
export async function getEdgeVoicesCached() {
  const now = Date.now();
  if (voiceCache !== null && now - voiceCacheAt < VOICE_CACHE_MS) return voiceCache;
  try {
    const list = await listEdgeVoices();
    voiceCache = list.map((item, index) => ({
      sid: index,
      name: item.name,
      label: item.label.replace(/^Microsoft\s+/, '').replace(/\s+Online.*$/, ''),
    }));
    voiceCacheAt = now;
    return voiceCache;
  } catch {
    return voiceCache === null ? [] : voiceCache;
  }
}

/**
 * SSML 转义。
 *
 * @param {string} text - 原文。
 * @returns {string} 转义后的文本。
 */
function escapeSsml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * 合成一段语音（返回 mp3）。
 *
 * @param {object} options - 参数。
 * @param {string} options.text - 文本。
 * @param {string} [options.voice] - 音色 ShortName（默认 `zh-CN-XiaoxiaoNeural`）。
 * @param {number} [options.speed] - 语速倍率 0.5–2（映射成 `+N%`）。
 * @param {number} [options.volume] - 音量 0–1（映射成 `+N%`）。
 * @param {number} [options.pitch] - 音调半音 -12 ~ +12（映射成 `+NHz`）。
 * @returns {Promise<{ok:boolean, audio?:Buffer, mime?:string, ms:number, error?:string, voice?:string}>} 结果。
 */
export async function synthesizeEdge(options) {
  const started = Date.now();
  const text = String(options.text ?? '').slice(0, EDGE_MAX_CHARS).trim();
  if (text === '') return { ok: false, ms: 0, error: '空文本' };
  if (WsImpl === null) return { ok: false, ms: 0, error: '找不到 ws 模块（插件目录解析不到）' };

  const voice = typeof options.voice === 'string' && options.voice !== '' ? options.voice : 'zh-CN-XiaoxiaoNeural';
  const speed = Number.isFinite(Number(options.speed)) ? Math.max(0.5, Math.min(2, Number(options.speed))) : 1;
  const volume = Number.isFinite(Number(options.volume)) ? Math.max(0, Math.min(1, Number(options.volume))) : 1;
  const ratePercent = Math.round((speed - 1) * 100);
  const volumePercent = Math.round((volume - 1) * 100);
  const semitones = Number.isFinite(Number(options.pitch)) ? Math.max(-12, Math.min(12, Number(options.pitch))) : 0;
  // 每 12 半音翻一倍；人类基频约 200 Hz，所以 1 半音 ≈ 12 Hz 是够用的近似
  const pitchHz = Math.round(semitones * 12);

  const url = `wss://${BASE_URL}/edge/v1?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}`
    + `&Sec-MS-GEC=${generateSecMsGecV2()}`
    + `&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}`
    + `&ConnectionId=${randomUUID().replace(/-/g, '')}`;

  const chunks = [];
  const result = await new Promise((resolve) => {
    let socket = null;
    let settled = false;
    const finish = (value) => {
      if (settled === true) return;
      settled = true;
      try { socket?.close(); } catch { /* 已关 */ }
      resolve(value);
    };
    const timer = setTimeout(() => finish({ ok: false, error: '合成超时（网络太慢？）' }), SYNTH_TIMEOUT_MS);

    try {
      socket = new WsImpl(url, {
        headers: { ...WSS_HEADERS, Cookie: `muid=${makeMuid()};` },
        handshakeTimeout: CONNECT_TIMEOUT_MS,
      });
    } catch (error) {
      clearTimeout(timer);
      resolve({ ok: false, error: `连不上 edge-tts：${String(error)}` });
      return;
    }

    const send = (payload) => { try { socket.send(payload); } catch { /* 断了 */ } };

    socket.on('open', () => {
      const stamp = new Date().toISOString();
      send(
        `X-Timestamp:${stamp}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n`
        + `{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},"outputFormat":"${OUTPUT_FORMAT}"}}}}`,
      );
      const ssml = `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='zh-CN'>`
        + `<voice name='${voice}'><prosody pitch='${pitchHz >= 0 ? '+' : ''}${pitchHz}Hz'`
        + ` rate='${ratePercent >= 0 ? '+' : ''}${ratePercent}%'`
        + ` volume='${volumePercent >= 0 ? '+' : ''}${volumePercent}%'>`
        + `${escapeSsml(text)}</prosody></voice></speak>`;
      send(
        `X-RequestId:${randomUUID().replace(/-/g, '')}\r\nContent-Type:application/ssml+xml\r\n`
        + `X-Timestamp:${stamp}Z\r\nPath:ssml\r\n\r\n${ssml}`,
      );
    });

    socket.on('message', (data, isBinary) => {
      const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
      if (isBinary === false) {
        if (buffer.toString('utf8').includes('Path:turn.end')) {
          clearTimeout(timer);
          finish({ ok: chunks.length > 0, error: chunks.length > 0 ? undefined : '服务端没给音频' });
        }
        return;
      }
      if (buffer.length < 2) return;
      const headerLength = buffer.readUInt16BE(0);
      const body = buffer.subarray(2 + headerLength);
      if (body.length > 0) chunks.push(Buffer.from(body));
    });

    socket.on('unexpected-response', (_req, response) => {
      clearTimeout(timer);
      finish({ ok: false, error: `被服务端拒绝：HTTP ${response.statusCode}` });
      response.resume();
    });
    socket.on('error', (error) => finish({ ok: false, error: `连接出错：${String(error.message || error)}` }));
    socket.on('close', () => {
      clearTimeout(timer);
      if (settled !== true) finish({ ok: chunks.length > 0, error: chunks.length > 0 ? undefined : '连接提前关闭' });
    });
  });

  if (result.ok !== true) return { ok: false, ms: Date.now() - started, error: result.error };
  return { ok: true, audio: Buffer.concat(chunks), mime: 'audio/mpeg', ms: Date.now() - started, voice };
}
