/**
 * @local/chat-widget —— 屏幕记忆的写入口（阶段 4）。
 *
 * 一次识图调用的产出这么分：
 *   `saw`   → 进这条记录的正文（"看到：…"）——瞬时信息，但留着能回看
 *   `facts` → 同一条记录的"记住：…"部分（谁杀了谁、什么价、什么曲名）
 *   `say`   → 走聊天库（`role=assistant` + `autonomous=1`），**不进这个库**
 *
 * 三条规矩：
 *   1. **物理分开**：只写 `screen_memories`，聊天记忆库（`memories`）一个字都不碰。
 *   2. **入库前去重**：与最近若干条比余弦，≥ 阈值（默认 0.9）就不写——"同一页看 5 分钟"只留一条。
 *   3. **永远带 limit 预筛**：实测全表读 20 万行要 421 ms，预筛后 15 ms（§3.5）。
 *
 * @module @local/chat-widget/host/screen-memory
 */

import { textSimilarity } from './bm25.js';
import { cosine } from './memory.js';
import { listScreenMemories, insertScreenMemory, insertWindowEvent } from '../store.js';
import { callUpstreamEmbed } from './upstream.js';
import { isKeywordEmbedding, resolveApiKey } from './settings.js';

/** 去重时回看的条数（只回看最近这些条，不做全表）。 */
const DEDUPE_LOOKBACK = 200;

/** 去重时回看的时间窗。 */
const DEDUPE_WINDOW_MS = 10 * 60 * 1000;

/** 默认去重阈值（设置项 `screen.dedupeCosine`）。 */
export const DEDUPE_DEFAULT = 0.9;

/**
 * 关键词模式的去重阈值（Dice 系数）。
 *
 * 余弦 0.87 与 Dice 0.87 不是一把尺子：Dice 对长度差和用词差异更敏感，
 * 同一帧的两段描述通常能到 0.7 以上，换一帧则掉到 0.3 以下。取 0.7 作等价阈值。
 */
const KEYWORD_DEDUPE_DICE = 0.7;

/**
 * 拼一条屏幕记忆的正文。
 * @param {string} saw - 客观描述。
 * @param {string[]} facts - 要长期记住的点。
 * @returns {string} 正文（"看到：…\n记住：…"）。
 */
export function buildScreenText(saw, facts) {
  const lines = [];
  const seen = typeof saw === 'string' ? saw.trim() : '';
  if (seen !== '') lines.push(`看到：${seen}`);
  const list = Array.isArray(facts) ? facts.filter((f) => typeof f === 'string' && f.trim() !== '') : [];
  if (list.length > 0) lines.push(`记住：${list.map((f) => f.trim()).join('；')}`);
  return lines.join('\n').slice(0, 2000);
}

/**
 * 写一帧的识图结果。
 *
 * @param {object} logger - 日志器。
 * @param {object} settings - 当前设置（要 `models.embed` / `store.dir`）。
 * @param {{frame: object, saw: string, facts: string[], subtitle?: string, at?: number}} input - 这一帧与它的产出。
 * @returns {Promise<{ok: boolean, id?: number, skipped?: string, error?: string}>} 结果。
 */
export async function writeScreenFrame(logger, settings, input) {
  const frame = input.frame ?? {};
  const at = Number.isFinite(input.at) ? Math.round(input.at) : (Number.isFinite(frame.at) ? Math.round(frame.at) : Date.now());
  const text = buildScreenText(input.saw, input.facts);
  if (text === '') return { ok: false, skipped: 'empty' };

  const embedRole = settings.models.embed;
  // 关键词模式：不调端点，vec 留空，去重改用字面 Dice 相似度（见下）。
  const keywordMode = isKeywordEmbedding(embedRole) === true;
  let vec = [];
  if (keywordMode === false) {
    try {
      const vectors = await callUpstreamEmbed(embedRole, resolveApiKey(embedRole).value, [text]);
      vec = Array.isArray(vectors[0]) ? vectors[0] : [];
    } catch (error) {
      return { ok: false, error: `向量化失败：${String(error)}` };
    }
    if (vec.length === 0) return { ok: false, error: '空向量' };
  }

  // 入库前去重：只回看最近 10 分钟（带 limit，绝不全表）。
  const recent = listScreenMemories(settings.store.dir, {
    limit: DEDUPE_LOOKBACK,
    since: at - DEDUPE_WINDOW_MS,
    includeCompressed: true,
  });
  if (recent.ok === true) {
    const threshold = Number.isFinite(settings.screen?.dedupeCosine) ? settings.screen.dedupeCosine : DEDUPE_DEFAULT;
    for (const row of recent.value) {
      if (keywordMode === true) {
        if (row.text !== '' && textSimilarity(text, row.text) >= KEYWORD_DEDUPE_DICE) {
          return { ok: true, id: row.id, skipped: 'duplicate' };
        }
        // 换回向量模式之前写的行没有向量，但文本照样能比，所以继续下一行
        continue;
      }
      if (row.vec.length !== vec.length) continue;
      const score = cosine(Float32Array.from(vec), row.vec);
      if (score >= threshold) return { ok: true, id: row.id, skipped: 'duplicate' };
    }
  }

  const saved = insertScreenMemory(settings.store.dir, {
    at,
    app: typeof frame.process === 'string' ? frame.process : '',
    title: typeof frame.title === 'string' ? frame.title : '',
    kind: 'raw',
    text,
    frame: typeof frame.path === 'string' ? frame.path : null,
    vec,
    // 字幕原文单独一列（不进 text、不进向量：准确的人名/数字已经由模型写进 facts 了）
    subtitle: typeof input.subtitle === 'string' ? input.subtitle : '',
  });
  if (saved.ok !== true) return { ok: false, error: String(saved.error) };
  return { ok: true, id: saved.value };
}

/**
 * 写一条窗口变化记录（全量落库，失败只 warn）。
 * @param {object} logger - 日志器。
 * @param {object} settings - 当前设置。
 * @param {object} change - 窗口变化事件。
 * @returns {void} 完成。
 */
export function writeWindowEvent(logger, settings, change) {
  const saved = insertWindowEvent(settings.store.dir, {
    at: Number.isFinite(change.at) ? change.at : Date.now(),
    hwnd: change.hwnd,
    process: change.process,
    title: change.title,
  });
  if (saved.ok !== true) logger.warn?.(`chat-widget: 写窗口记录失败: ${String(saved.error)}`);
}
