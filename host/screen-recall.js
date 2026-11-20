/**
 * @local/chat-widget —— 屏幕记忆与窗口记录的检索（阶段 6）。
 *
 * 三件事：
 *   1. `retrieveScreenMemories` —— 屏幕记忆库检索：**摘要优先**（`kind='summary'`），
 *      摘要没命中才回落到"最近 24 小时的 raw"；一律带 limit（实测全表读 20 万行 421 ms，预筛后 15 ms）。
 *   2. `detectTimeWindow` —— 从问句里解析时间词（刚才/今天/昨天/上周/上个月/三个月前…）。
 *   3. `recallWindowLog` —— 窗口记录 A 路线：按时间窗 + 消息里的关键词查 `window_events`，
 *      拼成一小块给提示词。**不做工具调用**（B 路线以后再说），查询函数复用同一套。
 *
 * @module @local/chat-widget/host/screen-recall
 */

import { listScreenMemories, queryWindowEvents } from '../store.js';
import { rankBm25 } from './bm25.js';
import { cosine } from './memory.js';
import { isKeywordEmbedding, resolveApiKey } from './settings.js';
import { callUpstreamEmbed } from './upstream.js';

/** 相似度门槛：低于它不算命中。 */
const MIN_SCORE = 0.35;

/** 摘要一次最多扫多少条（摘要一天几组，一年也就几千条）。 */
const SUMMARY_SCAN = 2000;

/** raw 兜底最多扫多少条（只扫最近这些）。 */
const RAW_SCAN = 800;

/** raw 兜底的时间窗：24 小时。 */
const RAW_WINDOW_MS = 24 * 60 * 60 * 1000;

/** 窗口记录一次最多取多少条。 */
const WINDOW_LIMIT = 40;

/** 提示词里窗口记录最多列几行。 */
const WINDOW_LINES = 10;

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** 时间词 → 时间窗（相对现在）。 */
const TIME_RULES = [
  { re: /刚才|刚刚|刚刚才|这会儿/, from: (now) => now - 30 * 60 * 1000, label: '刚才' },
  { re: /刚才那会|上一会|上一个小时/, from: (now) => now - HOUR, label: '这一小时' },
  { re: /今天|今日/, from: (now) => startOfDay(now), label: '今天' },
  { re: /昨天|昨晚|昨日/, from: (now) => startOfDay(now) - DAY, to: (now) => startOfDay(now), label: '昨天' },
  { re: /前天/, from: (now) => startOfDay(now) - 2 * DAY, to: (now) => startOfDay(now) - DAY, label: '前天' },
  { re: /这周|本周|这一周/, from: (now) => now - 7 * DAY, label: '这一周' },
  { re: /上周|上星期|上个星期/, from: (now) => now - 14 * DAY, to: (now) => now - 7 * DAY, label: '上周' },
  { re: /这个月|本月/, from: (now) => now - 30 * DAY, label: '这个月' },
  { re: /上个月|上月/, from: (now) => now - 60 * DAY, to: (now) => now - 30 * DAY, label: '上个月' },
  { re: /半年|六个月/, from: (now) => now - 365 * DAY, to: (now) => now - 120 * DAY, label: '半年前' },
  { re: /去年|一年前/, from: (now) => now - 730 * DAY, to: (now) => now - 365 * DAY, label: '去年' },
];

/** 本地 0 点。 */
function startOfDay(at) {
  const date = new Date(at);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/**
 * 从问句里解析时间窗。
 * @param {string} text - 用户这句话。
 * @param {number} [now] - 现在。
 * @returns {{from: number, to: number, label: string}|null} 时间窗；没时间词返回 null。
 */
export function detectTimeWindow(text, now = Date.now()) {
  const source = typeof text === 'string' ? text : '';
  // 具体"N 天/周/月前"
  const ago = /(\d+|[一二三四五六七八九十两])\s*(天|日|周|星期|个月|月)\s*(前|之前)/.exec(source);
  if (ago !== null) {
    const map = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
    const amount = map[ago[1]] ?? Number.parseInt(ago[1], 10);
    const unit = ago[2];
    const span = unit === '天' || unit === '日' ? DAY : unit === '周' || unit === '星期' ? 7 * DAY : 30 * DAY;
    if (Number.isFinite(amount) && amount > 0) {
      const center = now - amount * span;
      return { from: center - span / 2, to: center + span / 2, label: `${amount}${unit}前` };
    }
  }
  for (const rule of TIME_RULES) {
    if (rule.re.test(source)) {
      return {
        from: rule.from(now),
        to: typeof rule.to === 'function' ? rule.to(now) : now,
        label: rule.label,
      };
    }
  }
  return null;
}

/** 问句里要拿去匹配窗口标题的关键词（去掉问句套话）。 */
const STOP = new Set([
  '我在', '我昨天', '刚才', '今天', '昨天', '前天', '上周', '上个月', '这个月', '半年前', '去年',
  '在干什么', '干什么', '干嘛', '在干嘛', '看了什么', '看什么', '什么', '那个', '这个', '那件', '多少', '多少钱',
  '我在看', '我在干', '帮我', '还记得', '记得', '之前', '以前', '时候', '一下', '我的', '什么价', '什么价格',
]);

/**
 * 抽关键词（用于匹配窗口标题）。先把问句套话整段剔掉，再把中文切成**两字词**——
 * 否则「刚才我在看什么」会被整段当成一个关键词，拿去 `title like` 必然匹配不到。
 * @param {string} text - 用户这句话。
 * @returns {string[]} 关键词（最多 4 个）。
 */
export function extractKeywords(text) {
  let source = typeof text === 'string' ? text : '';
  // 1) 剔掉套话（长的先剔，避免"我在看"剔剩"在"这种）
  const stops = [...STOP].sort((a, b) => b.length - a.length);
  for (const word of stops) source = source.split(word).join(' ');
  source = source.replace(/[，。！？、；：,.!?;:'"「」『』（）()\-—…~]/g, ' ');

  const words = [];
  const push = (word) => {
    if (word.length < 2 || STOP.has(word) || words.includes(word)) return;
    words.push(word);
  };
  // 2) 英文/数字词原样，中文切两字词
  for (const match of source.matchAll(/[A-Za-z][A-Za-z0-9_.-]{1,20}|[\u4e00-\u9fff]{2,}/g)) {
    const run = match[0];
    if (/^[A-Za-z]/.test(run)) {
      push(run.toLowerCase());
      continue;
    }
    for (let i = 0; i + 2 <= run.length; i += 1) {
      push(run.slice(i, i + 2));
      if (words.length >= 4) break;
    }
    if (words.length >= 4) break;
  }
  return words.slice(0, 4);
}

/**
 * 检索屏幕记忆。
 * @param {object} logger - 日志器。
 * @param {object} settings - 当前设置。
 * @param {string} query - 用户这句话。
 * @param {{topK?: number}} [options] - 取几条。
 * @returns {Promise<{rows: object[], source: string}>} 命中与来源（summary/raw/none）。
 */
export async function retrieveScreenMemories(logger, settings, query, options = {}) {
  const text = typeof query === 'string' ? query.trim() : '';
  if (text === '') return { rows: [], source: 'none' };
  const topK = Number.isInteger(options.topK) ? options.topK : settings.screen?.retrieveTopK ?? 6;

  const embedRole = settings.models.embed;

  // 关键词模式：不调端点，直接在屏幕记忆原文上跑 BM25（摘要优先、raw 兜底的结构不变）。
  if (isKeywordEmbedding(embedRole) === true) {
    const scoreByKeyword = (rows) => rankBm25(text, rows, { topK })
      .map((hit) => ({ ...hit.doc, score: hit.score }));
    const summaries = listScreenMemories(settings.store.dir, { kind: 'summary', limit: SUMMARY_SCAN, includeCompressed: true });
    if (summaries.ok === true && summaries.value.length > 0) {
      const hits = scoreByKeyword(summaries.value);
      if (hits.length > 0) return { rows: hits, source: 'summary' };
    }
    const raw = listScreenMemories(settings.store.dir, { kind: 'raw', limit: RAW_SCAN, since: Date.now() - RAW_WINDOW_MS, includeCompressed: true });
    if (raw.ok !== true || raw.value.length === 0) return { rows: [], source: 'none' };
    return { rows: scoreByKeyword(raw.value), source: 'raw' };
  }

  let queryVec = [];
  try {
    const vectors = await callUpstreamEmbed(embedRole, resolveApiKey(embedRole).value, [text]);
    queryVec = Array.isArray(vectors[0]) ? Float32Array.from(vectors[0]) : new Float32Array(0);
  } catch (error) {
    logger.warn?.(`chat-widget: 屏幕记忆检索向量失败: ${String(error)}`);
    return { rows: [], source: 'none' };
  }
  if (queryVec.length === 0) return { rows: [], source: 'none' };

  const score = (rows) => {
    const scored = [];
    for (const row of rows) {
      if (row.vec.length !== queryVec.length) continue;
      const value = cosine(queryVec, row.vec);
      if (value < MIN_SCORE) continue;
      scored.push({ ...row, score: value });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  };

  // ① 摘要优先
  const summaries = listScreenMemories(settings.store.dir, { kind: 'summary', limit: SUMMARY_SCAN, includeCompressed: true });
  if (summaries.ok === true && summaries.value.length > 0) {
    const hits = score(summaries.value);
    if (hits.length > 0) return { rows: hits, source: 'summary' };
  }
  // ② 摘要没命中 → 最近 24 小时的 raw 兜底
  const raw = listScreenMemories(settings.store.dir, { kind: 'raw', limit: RAW_SCAN, since: Date.now() - RAW_WINDOW_MS, includeCompressed: true });
  if (raw.ok !== true || raw.value.length === 0) return { rows: [], source: 'none' };
  return { rows: score(raw.value), source: 'raw' };
}

/**
 * A 路线：按时间窗 + 关键词查窗口记录。
 * @param {object} settings - 当前设置。
 * @param {string} query - 用户这句话。
 * @param {number} [now] - 现在。
 * @returns {{events: object[], window: object|null, keywords: string[], triggered: boolean}} 查询结果。
 */
export function recallWindowLog(settings, query, now = Date.now()) {
  const text = typeof query === 'string' ? query : '';
  const window_ = detectTimeWindow(text, now);
  const keywords = extractKeywords(text);
  const asksAboutActivity = /(看|干|玩|听|写|逛|刷|打开|用|在忙|忙什么)/.test(text);
  if (window_ === null && keywords.length === 0) return { events: [], window: null, keywords, triggered: false };
  if (window_ === null && asksAboutActivity === false) return { events: [], window: null, keywords, triggered: false };

  const range = window_ ?? { from: now - 30 * 60 * 1000, to: now, label: '刚才' };
  const seen = new Set();
  const events = [];
  const push = (rows) => {
    for (const row of rows) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      events.push(row);
    }
  };

  // 有时间窗就先按时间取一段（最多 40 条），关键词只用来优先挑
  const byTime = queryWindowEvents(settings.store.dir, { from: range.from, to: range.to, limit: WINDOW_LIMIT });
  if (byTime.ok === true) push(byTime.value);
  if (keywords.length > 0 && events.length === 0) {
    for (const keyword of keywords.slice(0, 3)) {
      const byKeyword = queryWindowEvents(settings.store.dir, { q: keyword, from: range.from, to: range.to, limit: WINDOW_LIMIT });
      if (byKeyword.ok === true) push(byKeyword.value);
    }
  }
  events.sort((a, b) => a.at - b.at);
  return { events, window: range, keywords, triggered: events.length > 0 };
}

/**
 * 拼屏幕记忆块（`<screen_memory>`）。
 * @param {object[]} rows - 检索结果。
 * @param {string} source - summary / raw。
 * @returns {string} 提示词块（没有就空串）。
 */
export function buildScreenMemoryBlock(rows, source) {
  const list = Array.isArray(rows) ? rows.filter((row) => typeof row.text === 'string' && row.text.trim() !== '') : [];
  if (list.length === 0) return '';
  const lines = ['<screen_memory>', '以下是你陪看屏幕时记下的片段（不是他打字说的，是你亲眼看到的）：'];
  list.forEach((row, index) => {
    if (index > 0) lines.push('——');
    const clock = new Date(row.at).toLocaleString('zh-CN', { hour12: false });
    const where = [row.app, row.title].filter((v) => typeof v === 'string' && v !== '').join('｜');
    lines.push(`（${clock}${where === '' ? '' : ` ${where.slice(0, 60)}`}${row.kind === 'summary' ? ' 摘要' : ''}）`);
    lines.push(row.text.slice(0, 300));
  });
  if (source === 'raw') lines.push('（以上是最近 24 小时的原样记录；更早的还没压缩成摘要）');
  lines.push('</screen_memory>');
  return lines.join('\n');
}

/**
 * 拼窗口记录块（`<window_log>`）：连续相同的窗口合并，最多列 WINDOW_LINES 行。
 * @param {object[]} events - 窗口事件（时间升序）。
 * @param {{from: number, to: number, label: string}|null} window_ - 时间窗。
 * @returns {string} 提示词块（没有就空串）。
 */
export function buildWindowLogBlock(events, window_) {
  const list = Array.isArray(events) ? events : [];
  if (list.length === 0) return '';
  const lines = ['<window_log>'];
  const label = window_ === null ? '这段时间' : window_.label;
  lines.push(`${label}你的前台窗口变过这些（${list.length} 条，同类只列一次）：`);
  const seen = new Set();
  let shown = 0;
  for (const event of list) {
    const key = `${event.process}|${event.title}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const clock = new Date(event.at).toLocaleTimeString('zh-CN', { hour12: false });
    lines.push(`${clock} ${event.process}${event.title === '' ? '' : `｜${event.title.slice(0, 60)}`}`);
    shown += 1;
    if (shown >= WINDOW_LINES) break;
  }
  if (seen.size < list.length) lines.push(`（还有 ${list.length - seen.size} 条同类记录没列）`);
  lines.push('</window_log>');
  return lines.join('\n');
}
