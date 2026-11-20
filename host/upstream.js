/**
 * @local/chat-widget —— 上游模型端点。
 *
 * 只有两种方言（这就是全部）：
 *   - `ollama`            `/api/tags`、`/api/chat`（NDJSON 流）
 *   - OpenAI 兼容（其余）  `/v1/models`、`/v1/chat/completions`（SSE 流）
 *
 * 地址拼接集中在这里，因为**基准地址本身可能已经带 `/v1`**（OpenRouter 的
 * `https://openrouter.ai/api/v1` 就是这样）。旧实现无条件再拼一个 `/v1`，结果
 * 拉模型列表打到 `/api/v1/v1/models` 拿 404。
 *
 * 拉模型列表由**宿主**发起而不是浏览器：不受 CORS 限制（本地推理服务常常根本不发
 * CORS 头），密钥也不必经过浏览器。
 *
 * @module @local/chat-widget/host/upstream
 */

import { normalizeSecret, normalizeString } from './settings.js';

/** 拉模型列表的超时时间。 */
const MODEL_FETCH_TIMEOUT_MS = 8000;

/** 拉回来的模型数量上限，防止某个端点返回超大列表。 */
const MODEL_LIST_LIMIT = 500;

/** 一次抽取调用的超时（实测 0.7–2.2 s，给足余量）。 */
const EXTRACT_TIMEOUT_MS = 60000;

/** 一次向量调用的超时（实测热调用 26 ms、冷启动 2.4 s）。 */
const EMBED_TIMEOUT_MS = 20000;

/**
 * 去掉尾部斜杠。
 * @param {string} baseUrl - 基准地址。
 * @returns {string} 归一后的基准地址。
 */
function trimBase(baseUrl) {
  return baseUrl.replace(/\/+$/, '');
}

/**
 * OpenAI 兼容端点里的「API 根」：基准地址已经以 `/v1`（或 `/v2`…）结尾就不再补。
 * @param {string} baseUrl - 基准地址。
 * @returns {string} 可继续拼 `/models` 的根。
 */
function openAiRoot(baseUrl) {
  const base = trimBase(baseUrl);
  return /\/v\d+$/.test(base) ? base : `${base}/v1`;
}

/**
 * 带超时的 fetch。
 * @param {string} url - 目标地址。
 * @param {object} [options] - fetch 选项。
 * @param {number} [timeoutMs] - 超时毫秒数。
 * @returns {Promise<Response>} 响应。
 */
async function fetchWithTimeout(url, options = {}, timeoutMs = MODEL_FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 从不同 provider 的响应里挖出模型 id。
 * 兼容 ollama（`models[].name`）与 OpenAI 风格（`data[].id`）。
 * @param {unknown} payload - 解析后的响应体。
 * @returns {{id: string, label: string}[]} 去重后的模型列表。
 */
function extractModelIds(payload) {
  if (payload === null || typeof payload !== 'object') return [];
  const source = Array.isArray(payload.data)
    ? payload.data
    : Array.isArray(payload.models)
      ? payload.models
      : Array.isArray(payload)
        ? payload
        : [];

  const seen = new Set();
  const out = [];
  for (const item of source) {
    let id = '';
    if (typeof item === 'string') id = item;
    else if (item !== null && typeof item === 'object') {
      for (const key of ['id', 'name', 'model']) {
        if (typeof item[key] === 'string' && item[key] !== '') {
          id = item[key];
          break;
        }
      }
    }
    if (id === '' || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, label: id });
    if (out.length >= MODEL_LIST_LIMIT) break;
  }
  return out;
}

/**
 * 从 provider 拉取可用模型列表。
 * @param {object} input - provider / baseUrl / 密钥。
 * @returns {Promise<{models: {id: string, label: string}[]}>} 模型列表。
 * @throws 请求失败、超时或响应结构不符时抛错。
 */
export async function fetchProviderModels(input) {
  const provider = normalizeString(input.provider, 'ollama', 64);
  const baseUrl = normalizeString(input.baseUrl, '', 512);
  if (baseUrl === '') throw new Error('接口地址为空');

  const apiKey = normalizeSecret(input.apiKey);
  const authHeaders = apiKey === '' ? {} : { authorization: `Bearer ${apiKey}` };
  const url = provider === 'ollama'
    ? `${trimBase(baseUrl)}/api/tags`
    : `${openAiRoot(baseUrl)}/models`;

  let res;
  try {
    res = await fetchWithTimeout(url, { headers: { accept: 'application/json', ...authHeaders } });
  } catch (error) {
    const reason = error !== null && typeof error === 'object' && error.name === 'AbortError'
      ? `请求超时（${MODEL_FETCH_TIMEOUT_MS} ms）`
      : String(error);
    throw new Error(`连接 ${url} 失败：${reason}`);
  }

  if (!res.ok) throw new Error(`端点返回 HTTP ${res.status}`);

  let payload;
  try {
    payload = await res.json();
  } catch {
    throw new Error('端点返回的不是 JSON（可能地址填错了）');
  }
  return { models: extractModelIds(payload) };
}

/**
 * 从一行流式数据里取出文本增量。
 * @param {boolean} isOllama - 是否为 ollama 上游。
 * @param {string} line - 一行文本（已 trim）。
 * @returns {string} 增量文本，空串表示这行没有内容。
 */
function extractDelta(isOllama, line) {
  if (line === '') return '';
  if (isOllama) {
    try {
      const parsed = JSON.parse(line);
      const piece = parsed !== null && typeof parsed === 'object'
        && parsed.message !== null && typeof parsed.message === 'object'
        ? parsed.message.content
        : undefined;
      return typeof piece === 'string' ? piece : '';
    } catch {
      return '';
    }
  }
  if (!line.startsWith('data:')) return '';
  const payload = line.slice(5).trim();
  if (payload === '' || payload === '[DONE]') return '';
  try {
    const parsed = JSON.parse(payload);
    const choice = parsed !== null && typeof parsed === 'object' && Array.isArray(parsed.choices)
      ? parsed.choices[0]
      : undefined;
    const piece = choice !== null && typeof choice === 'object'
      && choice.delta !== null && typeof choice.delta === 'object'
      ? choice.delta.content
      : undefined;
    return typeof piece === 'string' ? piece : '';
  } catch {
    return '';
  }
}

/**
 * 发起一次上游对话请求（流式）。
 * @param {{provider: string, baseUrl: string, model: string}} role - 对话模型配置。
 * @param {string} apiKey - 已解析的密钥（可为空串）。
 * @param {{role: string, content: string}[]} messages - 上游消息数组。
 * @param {AbortSignal} signal - 中止信号。
 * @returns {Promise<Response>} 上游响应。
 */
export async function callUpstreamChat(role, apiKey, messages, signal) {
  const authHeaders = apiKey === '' ? {} : { authorization: `Bearer ${apiKey}` };
  const isOllama = role.provider === 'ollama';
  const url = isOllama
    ? `${trimBase(role.baseUrl)}/api/chat`
    : `${openAiRoot(role.baseUrl)}/chat/completions`;
  return fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: isOllama ? 'application/x-ndjson' : 'text/event-stream',
      ...authHeaders,
    },
    body: JSON.stringify({ model: role.model, messages, stream: true }),
    signal,
  });
}

/**
 * DeepSeek 官方接口的"关掉思考"字段。
 *
 * 官方接口**默认开思考**（effort=high），先在 `reasoning_content` 里长篇推理，再写 `content`。
 * 而我们这两条非流式路径的预算很小（视觉 200 token、抽取沿用默认），推理就把预算吃光：
 * 返回 `content: ""` + `finish_reason: "length"` —— 表现是"模型没给出合法 JSON"、
 * 陪看永远没有台词。OpenAI 方言里用 `{"thinking":{"type":"disabled"}}` 关掉它
 * （见 https://api-docs.deepseek.com/guides/thinking_mode ），其它 OpenAI 兼容端点
 * 不认这个字段，就不发，免得被 400。
 *
 * @param {{provider: string}} role - 模型配置。
 * @returns {object} 要并进请求体的字段（可能为空对象）。
 */
function thinkingOff(role) {
  return role !== null && typeof role === 'object' && role.provider === 'deepseek'
    ? { thinking: { type: 'disabled' } }
    : {};
}

/**
 * 发起一次**非流式**上游请求，只要最终文本（抽取用）。
 *
 * 抽取必须一次拿全 JSON 再校验，流式没有意义；这里不做重试——调用方每 30 秒会再来一次。
 *
 * @param {{provider: string, baseUrl: string, model: string}} role - 模型配置。
 * @param {string} apiKey - 已解析的密钥（可为空串）。
 * @param {{role: string, content: string}[]} messages - 上游消息数组。
 * @param {{format?: object, timeoutMs?: number, signal?: AbortSignal}} [options] - 约束格式与超时。
 * @returns {Promise<string>} 模型输出的纯文本（可能是空串）。
 * @throws 请求失败、超时或响应结构不符时抛错。
 */
export async function callUpstreamOnce(role, apiKey, messages, options = {}) {
  const isOllama = role.provider === 'ollama';
  const authHeaders = apiKey === '' ? {} : { authorization: `Bearer ${apiKey}` };
  const url = isOllama
    ? `${trimBase(role.baseUrl)}/api/chat`
    : `${openAiRoot(role.baseUrl)}/chat/completions`;

  const body = { model: role.model, messages, stream: false, ...thinkingOff(role) };
  // ollama 支持按 JSON Schema 约束输出（实测 0.40.4 可用；GBNF 字符串会被拒）
  if (isOllama === true && options.format !== undefined) body.format = options.format;
  // OpenAI 方言没有等价物，只能要求它回 JSON 对象
  if (isOllama !== true) body.response_format = { type: 'json_object' };

  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : EXTRACT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  if (options.signal !== undefined) options.signal.addEventListener('abort', onAbort, { once: true });
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', ...authHeaders },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`端点返回 HTTP ${response.status}`);
    const payload = await response.json();
    const content = isOllama
      ? (payload !== null && typeof payload === 'object' && payload.message !== null && typeof payload.message === 'object'
        ? payload.message.content
        : undefined)
      : (payload !== null && typeof payload === 'object' && Array.isArray(payload.choices) && payload.choices.length > 0
        ? payload.choices[0]?.message?.content
        : undefined);
    return typeof content === 'string' ? content : '';
  } finally {
    clearTimeout(timer);
    if (options.signal !== undefined) options.signal.removeEventListener('abort', onAbort);
  }
}

/** 视觉调用的超时（热态 1.3 s；冷启动或大图给到几十秒）。 */
const VISION_TIMEOUT_MS = 120000;

/**
 * 一次**带图**的非流式调用（屏幕陪看用）。
 *
 * - ollama：`messages[].images` 放 base64 数组；默认带 `think:false`（实测同一帧 6506 ms/217 tok → 1021 ms/43 tok），
 *   端点不认这个字段时自动去掉重试一次。
 * - OpenAI 兼容：`content` 数组里混 `text` 与多个 `image_url`。
 *
 * @param {{provider: string, baseUrl: string, model: string}} role - 视觉模型配置。
 * @param {string} apiKey - 密钥（可为空串）。
 * @param {string} systemPrompt - system 提示词。
 * @param {string} userText - user 文本（时间戳/上下文等）。
 * @param {string[]} imagesBase64 - 图片（JPEG base64，不带 data: 前缀）。
 * @param {{format?: object, timeoutMs?: number, numPredict?: number}} [options] - schema 与输出预算。
 * @returns {Promise<string>} 模型输出文本。
 * @throws 请求失败、超时或响应结构不符时抛错。
 */
export async function callUpstreamVision(role, apiKey, systemPrompt, userText, imagesBase64, options = {}) {
  const images = Array.isArray(imagesBase64) ? imagesBase64.filter((item) => typeof item === 'string' && item !== '') : [];
  const isOllama = role.provider === 'ollama';
  const authHeaders = apiKey === '' ? {} : { authorization: `Bearer ${apiKey}` };
  const url = isOllama ? `${trimBase(role.baseUrl)}/api/chat` : `${openAiRoot(role.baseUrl)}/chat/completions`;
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : VISION_TIMEOUT_MS;
  const numPredict = Number.isFinite(options.numPredict) ? options.numPredict : 200;

  /** 发一次（可带可不带 think 字段）。 */
  const send = async (withThink) => {
    const message = isOllama
      ? { role: 'user', content: userText, images }
      : {
        role: 'user',
        content: [
          { type: 'text', text: userText },
          ...images.map((data) => ({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${data}` } })),
        ],
      };
    const body = isOllama
      ? {
        model: role.model,
        messages: [{ role: 'system', content: systemPrompt }, message],
        stream: false,
        options: { num_predict: numPredict },
        ...(withThink ? { think: false } : {}),
        ...(options.format === undefined ? {} : { format: options.format }),
      }
      : {
        model: role.model,
        messages: [{ role: 'system', content: systemPrompt }, message],
        stream: false,
        max_tokens: numPredict,
        ...thinkingOff(role),
      };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    // 外层也能取消（陪看切窗口时要立刻放弃这一批，别让它想完再说上一窗口的话）
    const outerSignal = options.signal === undefined ? null : options.signal;
    const onOuterAbort = () => controller.abort();
    if (outerSignal !== null) {
      if (outerSignal.aborted === true) controller.abort();
      else outerSignal.addEventListener('abort', onOuterAbort, { once: true });
    }
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', ...authHeaders },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        const error = new Error(`端点返回 HTTP ${response.status}${detail === '' ? '' : `：${detail.slice(0, 200)}`}`);
        error.status = response.status;
        throw error;
      }
      const payload = await response.json();
      const content = isOllama
        ? (payload !== null && typeof payload === 'object' && payload.message !== null && typeof payload.message === 'object'
          ? payload.message.content
          : undefined)
        : (payload !== null && typeof payload === 'object' && Array.isArray(payload.choices) && payload.choices.length > 0
          ? payload.choices[0]?.message?.content
          : undefined);
      return typeof content === 'string' ? content : '';
    } finally {
      clearTimeout(timer);
      if (outerSignal !== null) outerSignal.removeEventListener('abort', onOuterAbort);
    }
  };

  if (isOllama !== true) return send(false);
  try {
    return await send(true);
  } catch (error) {
    const text = String(error);
    if (/\bthink\b/i.test(text) === false) throw error;
    return send(false);
  }
}

/**
 * 把一批文本变成向量。
 *
 * 两种方言都接受**数组输入**（ollama `/api/embed`、OpenAI `/v1/embeddings`），
 * 一次调用就能批量；返回值顺序与输入一一对应。
 *
 * @param {{provider: string, baseUrl: string, model: string}} role - 向量模型配置。
 * @param {string} apiKey - 已解析的密钥（可为空串）。
 * @param {string[]} texts - 待向量化的文本。
 * @param {{timeoutMs?: number}} [options] - 超时。
 * @returns {Promise<number[][]>} 向量数组（与输入同序）。
 * @throws 请求失败、超时或响应结构不符时抛错。
 */
export async function callUpstreamEmbed(role, apiKey, texts, options = {}) {
  const list = Array.isArray(texts) ? texts.map((text) => String(text)) : [];
  if (list.length === 0) return [];

  const isOllama = role.provider === 'ollama';
  const authHeaders = apiKey === '' ? {} : { authorization: `Bearer ${apiKey}` };
  const url = isOllama
    ? `${trimBase(role.baseUrl)}/api/embed`
    : `${openAiRoot(role.baseUrl)}/embeddings`;

  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : EMBED_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', ...authHeaders },
      body: JSON.stringify({ model: role.model, input: list }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`向量端点返回 HTTP ${response.status}`);
    const payload = await response.json();

    if (isOllama === true) {
      const rows = payload !== null && typeof payload === 'object' && Array.isArray(payload.embeddings)
        ? payload.embeddings
        : [];
      if (rows.length !== list.length) throw new Error(`向量数量不符（${rows.length} ≠ ${list.length}）`);
      return rows.map((row) => (Array.isArray(row) ? row.map(Number) : []));
    }

    const rows = payload !== null && typeof payload === 'object' && Array.isArray(payload.data) ? payload.data : [];
    if (rows.length !== list.length) throw new Error(`向量数量不符（${rows.length} ≠ ${list.length}）`);
    // OpenAI 方言的 data 带 index，按它归位（大多数端点本来就同序）
    const out = new Array(list.length).fill(null);
    rows.forEach((row, position) => {
      const index = row !== null && typeof row === 'object' && Number.isInteger(row.index) ? row.index : position;
      const vector = row !== null && typeof row === 'object' && Array.isArray(row.embedding) ? row.embedding.map(Number) : [];
      out[Math.min(list.length - 1, Math.max(0, index))] = vector;
    });
    return out.map((row) => (row === null ? [] : row));
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 读上游流，逐段回调文本增量。
 *
 * **不做整体超时**——本地模型冷启动可能要十几秒，长回复也不该被截断；中止只由客户端
 * 断开触发（浏览器那边 abort 掉 fetch 即可）。
 *
 * @param {Response} response - 上游响应。
 * @param {boolean} isOllama - 是否为 ollama 上游。
 * @param {(text: string) => void} onDelta - 收到一段文本。
 * @param {() => boolean} isAborted - 是否已中止。
 * @returns {Promise<string>} 完整文本。
 */
export async function readUpstreamStream(response, isOllama, onDelta, isAborted) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';
  try {
    for (;;) {
      if (isAborted()) break;
      let chunk;
      try {
        chunk = await reader.read();
      } catch {
        // 上游被中止/掐断时 read() 会**抛错**。已经收到的部分必须保住——
        // 否则用户按「停止」之后，界面上已经看到的字刷新就没了。
        break;
      }
      if (chunk.done === true) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let index = buffer.indexOf('\n');
      while (index !== -1) {
        const text = extractDelta(isOllama, buffer.slice(0, index).trim());
        buffer = buffer.slice(index + 1);
        if (text !== '') {
          full += text;
          onDelta(text);
        }
        index = buffer.indexOf('\n');
      }
    }
    const tail = extractDelta(isOllama, buffer.trim());
    if (tail !== '') {
      full += tail;
      onDelta(tail);
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* 流已经结束就无所谓 */
    }
  }
  return full;
}
