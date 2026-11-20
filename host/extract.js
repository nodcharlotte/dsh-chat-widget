/**
 * @local/chat-widget —— 抽取：把一段话里值得长期记住的**原句**挑出来。
 *
 * 拆分规则（用户定的）：我的话喂一次、它的话喂一次（两次调用），
 * 「谁说的」由**程序**加标签。实测 9B 会把说话人搞错（它自己的猜测被写成"用户尝试…"），
 * 分开喂之后模型每次只看见一个人的话，这种错误从结构上不可能再发生。
 *
 * 提示词里**绝对不能给例子**（实测）：加了正反例的版本开始编造——纯寒暄输入返回了
 * 7 条凭空捏造的"事实"，5 个案例里 3 个输出不是原文子串；极简版每条都是原文子串。
 * 所以真正的兜底是下面的**闸门**，不是提示词。
 *
 * @module @local/chat-widget/host/extract
 */

import { callUpstreamOnce } from './upstream.js';

/** 输出契约：`{"keep": ["原句", ...]}`。ollama 0.40.4 实测按 JSON Schema 约束可用。 */
export const EXTRACT_SCHEMA = {
  type: 'object',
  properties: { keep: { type: 'array', items: { type: 'string' } } },
  required: ['keep'],
};

/**
 * 抽取提示词（极简、无例子，改它就是改行为，别随手加示例）。
 */
export const EXTRACT_PROMPT = [
  '下面是一个人说过的话。',
  '只挑出值得长期记住的句子，原样照抄，一个字都不要改。',
  '不要总结、不要改写、不要补充、不要推测。没有值得记住的就返回空数组。',
].join('\n');

/** 非 ollama 端点没有 schema 约束，只能把形状写进提示词。 */
const JSON_HINT = '只输出 JSON，形如 {"keep":["原样照抄的句子"]}。';

/** 单句长度下限：挡掉「嗯」「好的」这类。 */
const MIN_KEEP_CHARS = 4;

/** 单句长度上限。 */
const MAX_KEEP_CHARS = 200;

/**
 * 把模型输出解析成字符串数组。解析不出来就是空数组（宁可少记，不可乱记）。
 * @param {string} raw - 模型输出。
 * @returns {string[]} 候选句子。
 */
export function parseKeep(raw) {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (text === '') return [];
  const candidates = [];
  const tryPush = (value) => {
    if (value === null || typeof value !== 'object') return;
    const list = Array.isArray(value.keep) ? value.keep : null;
    if (list === null) return;
    for (const item of list) if (typeof item === 'string') candidates.push(item);
  };

  try {
    tryPush(JSON.parse(text));
  } catch {
    // 有些模型会在 JSON 前后加解释文字：抠出最外层大括号再试一次
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start !== -1 && end > start) {
      try {
        tryPush(JSON.parse(text.slice(start, end + 1)));
      } catch {
        return [];
      }
    } else {
      return [];
    }
  }
  return candidates;
}

/** 空白折叠（只为了比对时宽容一点，内容字符一个都不能变）。 */
function collapse(text) {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * 闸门：把模型挑出来的东西过滤成「可以入库的原句」。
 *
 * 五道（都是能明确判定的，不靠模型）：
 *   1) **原文子串**——不是原文的子串一律丢掉。实测这一条能拦住全部编造。
 *   2) 去重——同一句只留一次；一句话包含另一句时只留长的。
 *   3) 长度下限——少于 4 字丢掉。
 *   4) 单句截断到 200 字。
 *   5) （调用方）两侧都挑不出东西 → 这一轮不建记忆。
 *
 * @param {string} sourceText - 送进模型的原文。
 * @param {string[]} candidates - 模型挑出来的句子。
 * @returns {string[]} 通过闸门的原句。
 */
export function gateKeep(sourceText, candidates) {
  const source = typeof sourceText === 'string' ? sourceText : '';
  const flat = collapse(source);
  const seen = new Set();
  const kept = [];

  for (const item of Array.isArray(candidates) ? candidates : []) {
    if (typeof item !== 'string') continue;
    const sentence = item.trim();
    if (sentence.length < MIN_KEEP_CHARS) continue;
    const verbatim = source.includes(sentence);
    if (verbatim === false && flat.includes(collapse(sentence)) === false) continue;
    const clipped = sentence.slice(0, MAX_KEEP_CHARS);
    const key = collapse(clipped);
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(clipped);
  }

  // 一句包含另一句 → 只留长的（避免记忆里出现半句 + 整句两份）
  return kept.filter((sentence, index) => kept.some((other, otherIndex) => (
    otherIndex !== index && other.includes(sentence) && (other.length > sentence.length || otherIndex < index)
  )) === false);
}

/**
 * 抽取一次：只喂**一个人的话**。
 *
 * @param {{provider: string, baseUrl: string, model: string}} role - 对话模型配置（抽取用它）。
 * @param {string} apiKey - 已解析的密钥。
 * @param {string} text - 这一方说过的话。
 * @returns {Promise<string[]>} 通过闸门的原句。
 * @throws 端点不可达/超时/响应结构不符时抛错（调用方据此**不**标记已入库，下轮重试）。
 */
export async function extractKeep(role, apiKey, text) {
  const source = typeof text === 'string' ? text.trim() : '';
  if (source === '') return [];

  const isOllama = role.provider === 'ollama';
  const messages = [
    { role: 'system', content: isOllama ? EXTRACT_PROMPT : `${EXTRACT_PROMPT}\n${JSON_HINT}` },
    { role: 'user', content: source },
  ];
  const raw = await callUpstreamOnce(role, apiKey, messages, {
    format: isOllama ? EXTRACT_SCHEMA : undefined,
  });
  return gateKeep(source, parseKeep(raw));
}
