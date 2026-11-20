/**
 * @local/chat-widget —— 音轨识别（ASR）：把「扬声器现在在放什么」变成给模型看的一行行参考。
 *
 * 三段，各管各的：
 *   1. **采集**在 `host/audio-capture.js`（自写的 WASAPI loopback，只吐 16 kHz 单声道 PCM16 帧）。
 *      由外面（`host/companion.js`）以工厂函数注入 —— 本文件不直接 import 它，
 *      这样自检能塞一个假采集源，插件也不会因为采集文件缺失就整个挂掉。
 *   2. **分段在这里**（`createSegmenter`，纯函数）。
 *   3. **转写**交给 DSH 自带的 `speechToText` 服务（SenseVoice，本机 CPU；
 *      输入 16 kHz 单声道 PCM16 WAV，输出 `{text, audioSeconds, inferenceSeconds}`）。
 *
 * ## 分段为什么这么写（2026-10-24 本机实测）
 *
 * - **静音时根本不发帧**：WASAPI loopback 只在有声音真的在渲染时才出数据。实测静音 3 秒 = **0 帧**。
 *   所以"没有帧"本身就是"静音"，**不需要**靠音量阈值去判"说完了"——按**帧间隙**收尾最准。
 *   （代价：帧间隙要靠 `tick()` 补——视频暂停时不会再有帧进来，得有只手替它收尾。）
 * - **音量可能很低**：满幅正弦（振幅 0.9）采回来 RMS 只有 **0.0208**（低约 28 倍，这台机器音量小），
 *   同一台机器上 SAPI 说话 RMS 只有 0.0012。所以：
 *     · 判"有没有人声"用**相对**判据（相对最近的高水位 `peak`），绝对阈值只当兜底；
 *     · 送识别**之前**做一次峰值归一化（纯增益，不改频谱），不然太轻的音频识别质量会掉。
 *
 * ## 三条铁律（用户定的）
 *
 *   · **识别结果一律不入库、不写盘**：它不够准，只当参考塞进视觉调用的 `<speech>` 块。
 *     本文件**一个字都不往 SQLite 写**，音频段转写完就丢（`check-speech.mjs` 断言这点）。
 *   · **开关是陪看的从属**：陪看关掉时必须停（`sync()` 按设置判定）。
 *   · **预留"略过"接口**：`pause()` / `resume()` 给以后的桌宠 TTS 用 ——
 *     说话时切 `mute`（设备照开着但一帧不留），在途转写掐掉、队列清空、分段器归零，
 *     保证我们自己的声音**一个字都不会进参考**。
 *
 * @module @local/chat-widget/host/speech
 */

/** 转写用的采样率（服务只收这个）。 */
export const SPEECH_RATE = 16_000;

/** 一句参考在环形缓冲里最多留多久（毫秒）。 */
const KEEP_MS = 60_000;

/** 同时在途的转写上限（多出来的丢最老的：ASR 慢的时候宁可丢，也别攒一堆过期话）。 */
const MAX_QUEUE = 2;

/** 归一化目标峰值（0–1）与最大增益倍数。 */
const TARGET_PEAK = 0.5;
const MAX_GAIN = 80;

/** 「高水位」衰减：每秒掉这么多（相对当前值），让自适应判据能跟着音量变化走。 */
const PEAK_DECAY_PER_SECOND = 0.4;

/**
 * 一段 PCM16（小端）的均方根，归一化到 0–1。
 *
 * @param {Uint8Array} pcm - PCM16LE 字节。
 * @returns {number} RMS（0 = 静音，1 = 满幅）。
 */
export function rmsOfPcm16(pcm) {
  const count = Math.floor(pcm.length / 2);
  if (count === 0) return 0;
  let sum = 0;
  for (let i = 0; i < count; i += 1) {
    const value = ((pcm[i * 2] | (pcm[i * 2 + 1] << 8)) << 16) >> 16;
    sum += value * value;
  }
  return Math.sqrt(sum / count) / 32768;
}

/**
 * 峰值归一化：把整段的峰值拉到 `TARGET_PEAK`（纯增益，不改频谱）。
 *
 * 为什么要它：实测这台机器音量很低（满幅正弦采回来 RMS 只有 0.0208），
 * SenseVoice 拿到太轻的音频会掉准确率。增益有上限，免得把底噪放大成噪音墙。
 *
 * @param {Uint8Array} pcm - PCM16LE 字节。
 * @returns {{pcm: Uint8Array, gain: number}} 归一化后的 PCM 与实际增益。
 */
export function normalizePcm(pcm) {
  const count = Math.floor(pcm.length / 2);
  let peak = 0;
  for (let i = 0; i < count; i += 1) {
    const value = Math.abs(((pcm[i * 2] | (pcm[i * 2 + 1] << 8)) << 16) >> 16);
    if (value > peak) peak = value;
  }
  if (peak === 0) return { pcm, gain: 1 };
  const gain = Math.min(MAX_GAIN, (TARGET_PEAK * 32768) / peak);
  const out = new Uint8Array(pcm.length);
  for (let i = 0; i < count; i += 1) {
    const value = ((pcm[i * 2] | (pcm[i * 2 + 1] << 8)) << 16) >> 16;
    let scaled = Math.round(value * gain);
    if (scaled > 32767) scaled = 32767;
    if (scaled < -32768) scaled = -32768;
    out[i * 2] = scaled & 0xff;
    out[i * 2 + 1] = (scaled >> 8) & 0xff;
  }
  return { pcm: out, gain };
}

/**
 * 拼一个规范的 16 kHz 单声道 PCM16 WAV（服务那边 `validateWave` 会校头）。
 *
 * @param {Uint8Array} pcm - PCM16LE 字节。
 * @param {number} [rate] - 采样率。
 * @returns {Uint8Array} WAV 字节（44 字节头 + PCM）。
 */
export function buildWav(pcm, rate = SPEECH_RATE) {
  const rateValue = Number.isFinite(rate) && rate > 0 ? Math.round(rate) : SPEECH_RATE;
  const out = new Uint8Array(44 + pcm.length);
  const view = new DataView(out.buffer);
  const ascii = (offset, text) => {
    for (let i = 0; i < text.length; i += 1) out[offset + i] = text.charCodeAt(i);
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + pcm.length, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true); // fmt 块长度
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // 单声道
  view.setUint32(24, rateValue, true);
  view.setUint32(28, rateValue * 2, true); // 字节率 = 采样率 × 声道 × 2
  view.setUint16(32, 2, true); // 块对齐
  view.setUint16(34, 16, true); // 位深
  ascii(36, 'data');
  view.setUint32(40, pcm.length, true);
  out.set(pcm, 44);
  return out;
}

/**
 * 清一遍 SenseVoice 的富文本标签与空白。
 *
 * 它会在句子里塞 `<|zh|><|NEUTRAL|><|Speech|><|withitn|>` 这类标记；服务那层可能已经剥过，
 * 这里再兜一道（标签里带 `|`，直接删掉）。
 *
 * @param {string} text - 原始文本。
 * @returns {string} 干净的一行。
 */
export function cleanLine(text) {
  return String(text ?? '')
    .replace(/<\|[^|]*\|>/g, '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s，。、,.!?！？~～-]+/, '')
    .trim();
}

/**
 * 灵敏度（1–10，界面滑块）→ 相对高水位的判据比例。
 *
 * 数字越大越灵敏（越容易把小声也当人声）。1 → 要过半强度才认，10 → 只要两成。
 *
 * @param {number} value - 灵敏度 1–10。
 * @returns {number} 相对比例（0.1–0.5）。
 */
export function ratioOfSensitivity(value) {
  const level = Math.min(10, Math.max(1, Number.isFinite(value) ? value : 6));
  return 0.5 - ((level - 1) * 0.4) / 9;
}

/**
 * 造一个分段器：吃固定长度的 PCM16 帧，吐「一句」完整的音频。
 *
 * 判据（见文件头实测）：
 *   · **帧间隙** ≥ `silenceMs` → 这一句说完了（静音时引擎根本不发帧，所以间隙就是静音）；
 *   · 一直在响就到 `maxMs` 强制收尾（服务那边还有自己的上限）；
 *   · 只有跨过**相对高水位**的帧才算"有人在说"；整段平均响度太低就丢掉（免得送一堆纯静音/底噪）。
 *
 * @param {object} [options] - 参数。
 * @param {number} [options.sensitivity] - 灵敏度 1–10。
 * @param {number} [options.minRms] - 绝对兜底阈值（低于它一律不算人声）。
 * @param {number} [options.silenceMs] - 帧间隙多久算说完了。
 * @param {number} [options.maxMs] - 一句最长多少毫秒。
 * @returns {{push: (frame: object) => object[], tick: (now?: number) => object[], reset: () => void,
 *   state: () => object}} 分段器。
 */
export function createSegmenter(options = {}) {
  const ratio = ratioOfSensitivity(options.sensitivity);
  const minRms = Number.isFinite(options.minRms) && options.minRms > 0 ? options.minRms : 0.0004;
  const silenceMs = Number.isFinite(options.silenceMs) && options.silenceMs > 0 ? options.silenceMs : 700;
  const maxMs = Number.isFinite(options.maxMs) && options.maxMs > 0 ? options.maxMs : 12_000;

  let peak = 0; // 最近的高水位（响度参考）
  let lastPeakAt = 0;
  let parts = [];
  let totalMs = 0;
  let lastAt = 0;
  let droppedQuiet = 0;
  let droppedShort = 0;
  let segments = 0;

  /** 高水位随时衰减（音量变小以后判据要跟着降）。 */
  const decayPeak = (now) => {
    if (peak === 0 || lastPeakAt === 0) return;
    const seconds = Math.max(0, (now - lastPeakAt) / 1000);
    if (seconds <= 0) return;
    peak *= Math.pow(1 - PEAK_DECAY_PER_SECOND, Math.min(seconds, 30));
  };

  /** 收尾：够响才留，太短/太轻丢。 */
  const close = (at) => {
    if (parts.length === 0) return [];
    const ms = parts.reduce((sum, item) => sum + item.ms, 0);
    const pcm = concat(parts);
    parts = [];
    totalMs = 0;
    segments += 1;
    if (ms < 200) {
      droppedShort += 1;
      return [];
    }
    const loudness = rmsOfPcm16(pcm);
    if (loudness < minRms) {
      droppedQuiet += 1;
      return [];
    }
    return [{ pcm, ms, at, rms: loudness }];
  };

  return {
    /**
     * 喂一帧。
     *
     * @param {{pcm: Uint8Array, ms?: number, at?: number}} frame - 一帧。
     * @returns {{pcm: Uint8Array, ms: number, at: number, rms: number}[]} 收尾的句子（0 或 1 条）。
     */
    push(frame) {
      const pcm = frame.pcm instanceof Uint8Array ? frame.pcm : new Uint8Array(frame.pcm ?? []);
      const ms = Number.isFinite(frame.ms) && frame.ms > 0
        ? frame.ms
        : Math.round((pcm.length / 2 / SPEECH_RATE) * 1000);
      const at = Number.isFinite(frame.at) && frame.at >= 0 ? frame.at : Date.now();
      const loudness = rmsOfPcm16(pcm);

      decayPeak(at);
      const closed = [];
      // 间隙够大 = 中间真的静过（引擎静音时不发帧）→ 先把上一句收尾
      if (lastAt > 0 && totalMs > 0 && at - lastAt >= silenceMs) closed.push(...close(lastAt));
      lastAt = at;

      if (loudness > peak) {
        peak = loudness;
        lastPeakAt = at;
      }
      const gate = Math.max(minRms, peak * ratio);
      if (parts.length === 0 && loudness < gate) return closed; // 还没开口，也不够响：不留
      parts.push({ pcm, ms });
      totalMs += ms;
      if (totalMs >= maxMs) closed.push(...close(at));
      return closed;
    },
    /**
     * 没有新帧时也替它收尾（视频暂停时不会再有帧进来）。
     *
     * @param {number} [now] - 现在（毫秒），默认取系统时间。
     * @returns {object[]} 收尾的句子（0 或 1 条）。
     */
    tick(now) {
      const at = Number.isFinite(now) && now >= 0 ? now : Date.now();
      if (parts.length === 0 || lastAt === 0) return [];
      if (at - lastAt < silenceMs) return [];
      return close(lastAt);
    },
    reset() {
      parts = [];
      totalMs = 0;
      lastAt = 0;
      peak = 0;
      lastPeakAt = 0;
    },
    state: () => ({ parts: parts.length, totalMs, lastAt, peak, segments, droppedQuiet, droppedShort }),
  };
}

/**
 * 把若干帧的 PCM 拼起来。
 *
 * @param {{pcm: Uint8Array}[]} parts - 帧。
 * @returns {Uint8Array} 拼接后的 PCM。
 */
function concat(parts) {
  const size = parts.reduce((sum, item) => sum + item.pcm.length, 0);
  const out = new Uint8Array(size);
  let offset = 0;
  for (const item of parts) {
    out.set(item.pcm, offset);
    offset += item.pcm.length;
  }
  return out;
}

/**
 * 造一个音轨识别器。
 *
 * @param {object} options - 依赖。
 * @param {object} options.logger - 日志器。
 * @param {() => Promise<{settings: object}>} options.settingsFn - 读设置。
 * @param {() => object|null} options.getService - 取 `speechToText` 服务（惰性取，没有就 null）。
 * @param {(logger: object, opts: object) => object} options.startCapture - 采集工厂（注入，方便自检）。
 * @returns {{sync: Function, off: Function, pause: Function, resume: Function, takeForBatch: Function,
 *   status: Function}} 识别器。
 */
export function createSpeech({ logger, settingsFn, getService, startCapture, getExcludePid }) {
  /**
   * 读设置：`settingsFn` 既可能回 `{settings}`（`readSettings` 的信封），
   * 也可能直接回设置对象（陪看那边缓存的是对象）——两种都接住。
   *
   * @returns {Promise<object|null>} 设置对象。
   */
  const readSettingsOf = async () => {
    const value = await settingsFn();
    if (value === null || typeof value !== 'object') return null;
    return value.settings !== undefined && value.settings !== null ? value.settings : value;
  };

  let capture = null;
  let segmenter = null;
  /** 当前分段器是按哪组旋钮建的（指纹）；`sync()` 只在指纹变了时才重建，免得把没说完那句的缓冲扔掉。 */
  let segmenterSig = '';
  let enabled = false;
  let paused = false;
  let pauseReason = '';
  let lines = [];
  let queue = [];
  let pumping = false;
  let current = null;
  let preparing = '';
  let ticker = null;
  const stats = {
    heard: 0, droppedQuiet: 0, droppedNotReady: 0, droppedNoService: 0, droppedRepeat: 0,
    droppedPaused: 0, droppedService: 0, failures: 0, lastError: '', lastLine: '', lastAt: 0,
    inferenceMs: 0, gain: 1,
  };

  /** 按设置重建分段器（旋钮即时生效）。 */
  const segmenterFor = (settings) => createSegmenter({
    sensitivity: Number(settings.screen.speechSensitivity),
    silenceMs: Number(settings.screen.speechSilenceMs),
    maxMs: Number(settings.screen.speechMaxMs),
  });

  /**
   * 分段器参数的指纹 —— **只有旋钮真的变了才重建分段器**。
   *
   * 为什么要指纹：`sync()` 每 3 秒被监督循环调一次（`host/companion.js` 的 `supervise`），
   * 要是每次都无脑重建，**"这一句还没说完"的缓冲就会被扔掉**——嘴一直说的人永远等不到
   * 静音收尾，10 分钟只出 1 条（2026-10-24 实测踩过：`heard=1` 之后再不动）。
   *
   * @param {object} settings - 当前设置。
   * @returns {string} 指纹。
   */
  const segmenterSigOf = (settings) => [
    String(settings.screen.speechSensitivity),
    String(settings.screen.speechSilenceMs),
    String(settings.screen.speechMaxMs),
  ].join('|');

  /**
   * 服务就绪状态。
   *
   * @returns {{ok: boolean, reason: string, phase: string, providerId: string, service?: object}} 状态。
   */
  const serviceState = () => {
    const service = getService();
    if (service === null || service === undefined) return { ok: false, reason: 'no-service', phase: '', providerId: '' };
    let snapshot = null;
    try {
      snapshot = service.snapshot();
    } catch (error) {
      return { ok: false, reason: `no-snapshot: ${String(error)}`, phase: '', providerId: '' };
    }
    const providers = Array.isArray(snapshot?.providers) ? snapshot.providers : [];
    const selection = snapshot?.selection ?? {};
    const wanted = String(selection.providerId ?? '');
    const found = providers.find((item) => item.id === wanted) ?? providers[0] ?? null;
    const phase = String(found?.preparation?.phase ?? 'unprepared');
    // `standby` = 资源校验过、工作进程还没唤醒（第一次用才加载）—— 对调用方来说就是"可用"
    const ok = phase === 'ready' || phase === 'waking' || phase === 'standby';
    return { ok, reason: ok ? '' : `not-ready:${phase}`, phase, providerId: String(found?.id ?? wanted), service };
  };

  /** 没加载就催一把（准备是幂等的：已经在准备就 join）。 */
  const ensurePrepared = (state) => {
    if (state.ok === true || state.providerId === '' || preparing === state.providerId) return;
    preparing = state.providerId;
    try {
      state.service.prepare(state.providerId);
      logger.info?.(`chat-widget: 音轨识别开始准备模型（${state.providerId}）`);
    } catch (error) {
      logger.warn?.(`chat-widget: 音轨识别准备失败: ${String(error)}`);
    }
  };

  /** 收到一整句：排队去转写。 */
  const onSegment = (segment) => {
    stats.heard += 1;
    if (paused === true) {
      stats.droppedPaused += 1;
      return;
    }
    const state = serviceState();
    if (state.service === undefined) {
      stats.droppedNoService += 1;
      return;
    }
    ensurePrepared(state);
    if (state.ok !== true) {
      stats.droppedNotReady += 1;
      stats.lastError = state.reason;
      return;
    }
    queue.push(segment);
    while (queue.length > MAX_QUEUE) queue.shift();
    void pump();
  };

  /** 转写一句，结果进环形缓冲（**不落库**）。 */
  const runOne = async (segment) => {
    const state = serviceState();
    if (state.ok !== true || state.service === undefined) {
      stats.droppedNotReady += 1;
      return;
    }
    const settings = (await readSettingsOf()) ?? { screen: {} };
    const language = String(settings.screen.speechLangs ?? 'auto');
    const normalized = normalizePcm(segment.pcm);
    stats.gain = Math.round(normalized.gain * 10) / 10;
    const wav = buildWav(normalized.pcm, SPEECH_RATE);
    let spec;
    try {
      spec = state.service.resolve({ audio: wav, language });
    } catch (error) {
      stats.droppedService += 1;
      stats.lastError = `resolve: ${String(error)}`;
      logger.warn?.(`chat-widget: 音轨识别选了不可用的语言/识别器（${language}）：${String(error)}`);
      return;
    }
    const controller = new AbortController();
    current = controller;
    try {
      const transcript = await state.service.transcribe(spec, controller.signal);
      const text = cleanLine(transcript?.text ?? '');
      const ms = Math.round(Number(transcript?.inferenceSeconds ?? 0) * 1000);
      if (Number.isFinite(ms) && ms > 0) stats.inferenceMs = ms;
      if (text.length < 2) {
        stats.droppedShortBoilerplate = (stats.droppedShortBoilerplate ?? 0) + 1;
        return;
      }
      const previous = lines.length === 0 ? '' : lines[lines.length - 1].text;
      if (previous !== '' && (previous === text || previous.includes(text) || text.includes(previous))) {
        stats.droppedRepeat += 1;
        return;
      }
      const at = Number.isFinite(segment.at) && segment.at >= 0 ? segment.at : Date.now();
      lines.push({ at, text, ms: segment.ms });
      const maxLines = Math.max(1, Math.round(Number(settings.screen.speechMaxLines) || 6));
      while (lines.length > maxLines) lines.shift();
      stats.lastLine = text;
      stats.lastAt = at;
      logger.info?.(`chat-widget: 音轨识别（${String(segment.ms)} ms，增益 ×${String(stats.gain)}）：${text}`);
    } catch (error) {
      if (controller.signal.aborted === true) return; // pause()/off() 掐掉的，不算失败
      stats.failures += 1;
      stats.lastError = String(error);
      logger.warn?.(`chat-widget: 音轨识别转写失败: ${String(error)}`);
    } finally {
      if (current === controller) current = null;
    }
  };

  /** 串行泵（服务那边也是一个工作进程串行跑）。 */
  const pump = async () => {
    if (pumping === true) return;
    pumping = true;
    try {
      while (queue.length > 0) {
        const segment = queue.shift();
        // eslint-disable-next-line no-await-in-loop
        await runOne(segment);
      }
    } finally {
      pumping = false;
    }
  };

  /** 起采集 + 收尾定时器。 */
  const start = (settings) => {
    if (capture !== null) return;
    segmenter = segmenterFor(settings);
    segmenterSig = segmenterSigOf(settings);
    // 进程级排除：把桌宠的进程树从"听到的声音"里剔掉 —— 它自己说的话不进 ASR，
    // 但同一时刻视频里的对白照收。`getExcludePid()` 返回 0 就是整机 loopback（老行为）。
    const excludePid = typeof getExcludePid === 'function' ? Number(getExcludePid()) || 0 : 0;
    capture = startCapture(logger, {
      excludePid,
      onFrame: (frame) => {
        if (segmenter === null) return;
        for (const segment of segmenter.push(frame)) onSegment(segment);
      },
      onReady: (info) => {
        const excludeNote = info?.exclude === true ? `，已排除进程 ${String(info?.excludePid ?? 0)}` : '';
        const fallbackNote = typeof info?.excludeFallback === 'string' && info.excludeFallback !== ''
          ? `，排除失败已回退（${info.excludeFallback}）`
          : '';
        logger.info?.(`chat-widget: 音轨采集就绪（${String(info?.device ?? '?')} ${String(info?.sampleRate ?? '?')}Hz ×${String(info?.channels ?? '?')}${excludeNote}${fallbackNote}）`);
      },
      onError: (message) => {
        stats.failures += 1;
        stats.lastError = String(message);
      },
    });
    capture.setMode(paused === true ? 'mute' : 'on');
    // 静音时引擎不发帧（实测），所以"说完了一句"得靠这只手替它收尾
    if (ticker === null) {
      ticker = setInterval(() => {
        if (segmenter === null || paused === true) return;
        for (const segment of segmenter.tick(Date.now())) onSegment(segment);
      }, 250);
      ticker.unref?.();
    }
  };

  /** 停采集（设备也放掉）、掐在途转写。 */
  const stop = () => {
    queue = [];
    if (current !== null) {
      try {
        current.abort();
      } catch {
        /* 已经结束了 */
      }
      current = null;
    }
    if (ticker !== null) {
      clearInterval(ticker);
      ticker = null;
    }
    if (capture !== null) {
      capture.stop();
      capture = null;
    }
    segmenter = null;
  };

  return {
    /**
     * 按设置对齐：陪看 + 音轨识别都开着才采；任一关掉就停。
     *
     * @returns {void} 无。
     */
    sync() {
      void (async () => {
        // 这里**必须自己接住异常**：它是 `supervise()` 每 3 秒 `void` 调用一次的异步火苗，
        // 抛出去就是未捕获的 Promise 拒绝 —— Node 默认直接带崩整个宿主。
        // （2026-10-24 实测真崩过一次：`segmenterSig` 少了个声明，`dsh web` 当场 fatal load failure。）
        try {
          const settings = (await readSettingsOf()) ?? { perceive: {}, screen: {} };
          const want = settings.perceive.companion === true && settings.screen.speech === true;
          enabled = want;
          if (want === false) {
            stop();
            return;
          }
          if (capture === null) start(settings);
          else if (segmenter !== null) {
            // 旋钮即时生效，但**别每次 sync 都重建**（会把没说完那句的缓冲扔掉）
            const sig = segmenterSigOf(settings);
            if (sig !== segmenterSig) {
              segmenter = segmenterFor(settings);
              segmenterSig = sig;
            }
          }
          ensurePrepared(serviceState());
        } catch (error) {
          logger.warn?.(`chat-widget: 音轨识别 sync 出错（吞掉，别把宿主带崩）: ${String(error)}`);
        }
      })();
    },
    /** 彻底关掉（陪看停止时叫它）。 */
    off() {
      enabled = false;
      paused = false;
      pauseReason = '';
      stop();
      lines = [];
    },
    /**
     * **预留接口**（以后桌宠 TTS 用）：暂停识别。
     *
     * 切 `mute` 而不是 `off`：设备保持开着（省一次打开/协商），但一帧都不留；
     * 在途转写掐掉、队列清空、分段器归零 —— 保证我们自己的声音**一个字都不会进参考**。
     *
     * @param {string} [reason] - 为什么暂停（日志用）。
     * @returns {void} 无。
     */
    pause(reason) {
      if (paused === true) return;
      paused = true;
      pauseReason = String(reason ?? '');
      queue = [];
      if (current !== null) {
        try {
          current.abort();
        } catch {
          /* 已经结束了 */
        }
        current = null;
      }
      if (segmenter !== null) segmenter.reset();
      if (capture !== null) capture.setMode('mute');
      logger.info?.(`chat-widget: 音轨识别暂停（${pauseReason === '' ? '未说明' : pauseReason}）`);
    },
    /**
     * **预留接口**：恢复识别。
     *
     * @returns {void} 无。
     */
    resume() {
      if (paused !== true) return;
      paused = false;
      pauseReason = '';
      if (segmenter !== null) segmenter.reset();
      if (capture !== null) capture.setMode('on');
      logger.info?.('chat-widget: 音轨识别恢复');
    },
    /**
     * 这一批视觉调用要带的音轨参考（最近几句；**取走不清空**，它是滚动参考）。
     *
     * @param {object} [settings] - 当前设置（拿 maxLines/maxChars）。
     * @returns {{lines: object[], text: string}} 参考行与拼好的文本。
     */
    takeForBatch(settings) {
      const options = settings !== null && typeof settings === 'object' ? settings : {};
      const screen = options.screen !== null && typeof options.screen === 'object' ? options.screen : {};
      const maxLines = Math.max(1, Math.round(Number(screen.speechMaxLines) || 6));
      const maxChars = Math.max(20, Math.round(Number(screen.speechMaxChars) || 400));
      const now = Date.now();
      lines = lines.filter((item) => now - item.at <= KEEP_MS);
      const picked = [];
      let used = 0;
      for (let i = lines.length - 1; i >= 0 && picked.length < maxLines; i -= 1) {
        const item = lines[i];
        if (used + item.text.length > maxChars) break;
        used += item.text.length;
        picked.unshift(item);
      }
      return { lines: picked, text: picked.map((item) => item.text).join(' / ') };
    },
    /**
     * 现场状态（给 `/screen/status` 与界面看）。
     *
     * @returns {object} 状态。
     */
    status() {
      const state = serviceState();
      return {
        enabled,
        paused,
        pauseReason,
        mode: capture === null ? 'off' : (paused === true ? 'mute' : 'on'),
        ready: state.ok === true,
        phase: state.phase,
        reason: state.reason,
        providerId: state.providerId,
        lines: lines.map((item) => ({ at: item.at, text: item.text, ms: item.ms })),
        lastLine: stats.lastLine,
        lastAt: stats.lastAt,
        heard: stats.heard,
        inferenceMs: stats.inferenceMs,
        gain: stats.gain,
        busy: pumping,
        queued: queue.length,
        dropped: {
          short: stats.droppedShortBoilerplate ?? 0,
          quiet: stats.droppedQuiet,
          notReady: stats.droppedNotReady,
          noService: stats.droppedNoService,
          repeat: stats.droppedRepeat,
          paused: stats.droppedPaused,
          service: stats.droppedService,
        },
        failures: stats.failures,
        lastError: stats.lastError,
        capture: capture === null ? null : capture.status(),
        segmenter: segmenter === null ? null : segmenter.state(),
      };
    },
  };
}
