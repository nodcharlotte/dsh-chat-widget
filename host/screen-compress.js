/**
 * @local/chat-widget —— 屏幕记忆压缩（设置里那个「压缩摘要」按钮）。
 *
 * 你抽空点一下：把**未压缩的 raw 行**按「天 + 应用」分组，每组喂一次模型产出一条摘要，
 * 写成 `kind='summary'` 的新行，源行标 `compressed=1`（**留着可查，不删**）。
 * 之后检索**摘要优先**，raw 只兜底最近 24 小时——体积与检索耗时都压得住。
 *
 * 失败只 warn、不动标记，可反复点、可中断。
 *
 * @module @local/chat-widget/host/screen-compress
 */

import { listScreenMemories, markScreenCompressed, insertScreenMemory } from '../store.js';
import { isKeywordEmbedding, resolveApiKey } from './settings.js';
import { callUpstreamEmbed, callUpstreamOnce } from './upstream.js';

/** 摘要输出契约。 */
export const SUMMARY_SCHEMA = {
  type: 'object',
  properties: { summary: { type: 'string' } },
  required: ['summary'],
};

/** 提示词（极简、不给例子：小模型会照抄例子）。 */
export const SUMMARY_PROMPT = [
  '下面是同一天、同一个程序里，你陪看屏幕时记下的若干片段。',
  '把它们压成一段话（第一人称、不超过 200 字）：那天在做什么、看了什么、聊到什么。',
  '**保留具体的名字与数字**（项目名、商品名、价格、曲名、剧情里的人物），这些以后要用。',
  '只写上面片段里有的，**不要编、不要推测**；片段里没有的就别提。',
].join('\n');

/** 每组最多几条进模型（多了截断）。 */
const GROUP_LIMIT = 40;

/** non-ollama 端点没有 schema 约束。 */
const JSON_HINT = '只输出 JSON，形如 {"summary":"…"}。';

/**
 * 压缩一批未压缩的屏幕记忆。
 *
 * @param {object} logger - 日志器。
 * @param {object} settings - 当前设置。
 * @param {{limit?: number}} [options] - 一次最多处理多少条 raw。
 * @returns {Promise<{ok: boolean, groups: number, compressed: number, summaries: number, remaining: number, error?: string}>} 结果。
 */
export async function compressScreenMemories(logger, settings, options = {}) {
  const dir = settings.store.dir;
  const limit = Number.isInteger(options.limit) ? options.limit : settings.screen?.compressBatch ?? 200;
  const rows = listScreenMemories(dir, { kind: 'raw', includeCompressed: false, limit });
  if (rows.ok !== true) return { ok: false, groups: 0, compressed: 0, summaries: 0, remaining: 0, error: String(rows.error) };
  if (rows.value.length === 0) return { ok: true, groups: 0, compressed: 0, summaries: 0, remaining: 0 };

  // 分组：天 + 应用
  const groups = new Map();
  for (const row of rows.value) {
    const key = `${row.day}|${row.app}`;
    if (groups.has(key) === false) groups.set(key, []);
    groups.get(key).push(row);
  }

  const model = settings.models.text;
  const isOllama = model.provider === 'ollama';
  const embedRole = settings.models.embed;
  let compressed = 0;
  let summaries = 0;

  for (const [key, items] of groups) {
    const list = items.slice(0, GROUP_LIMIT);
    const body = list.map((row) => row.text).join('\n---\n');
    const clock = new Date(list[list.length - 1].at).toLocaleString('zh-CN', { hour12: false });
    let summary = '';
    try {
      const raw = await callUpstreamOnce(
        model,
        resolveApiKey(model).value,
        [
          { role: 'system', content: isOllama ? SUMMARY_PROMPT : `${SUMMARY_PROMPT}\n${JSON_HINT}` },
          { role: 'user', content: `${clock}（${key.split('|')[1] || '未知程序'}）：\n${body.slice(0, 6000)}` },
        ],
        { format: isOllama ? SUMMARY_SCHEMA : undefined },
      );
      const text = typeof raw === 'string' ? raw.trim() : '';
      const start = text.indexOf('{');
      const end = text.lastIndexOf('}');
      const parsed = start !== -1 && end > start ? JSON.parse(text.slice(start, end + 1)) : JSON.parse(text);
      if (parsed !== null && typeof parsed === 'object' && typeof parsed.summary === 'string') summary = parsed.summary.trim().slice(0, 800);
    } catch (error) {
      logger.warn?.(`chat-widget: 压缩「${key}」失败（跳过这组）: ${String(error)}`);
      continue;
    }
    if (summary === '') continue;

    // 关键词模式没有向量可算：vec 留空照样能写，检索时按摘要文本跑 BM25。
    let vec = [];
    if (isKeywordEmbedding(embedRole) === false) {
      try {
        const vectors = await callUpstreamEmbed(embedRole, resolveApiKey(embedRole).value, [summary]);
        vec = Array.isArray(vectors[0]) ? vectors[0] : [];
      } catch (error) {
        logger.warn?.(`chat-widget: 摘要向量化失败（跳过这组）: ${String(error)}`);
        continue;
      }
      if (vec.length === 0) continue;
    }

    const saved = insertScreenMemory(dir, {
      at: list[list.length - 1].at,
      app: list[list.length - 1].app,
      title: list[list.length - 1].title,
      kind: 'summary',
      text: `摘要（${list.length} 条片段）：${summary}`,
      frame: null,
      vec,
    });
    if (saved.ok !== true) {
      logger.warn?.(`chat-widget: 摘要写库失败: ${String(saved.error)}`);
      continue;
    }
    summaries += 1;
    const marked = markScreenCompressed(dir, list.map((row) => row.id));
    if (marked.ok === true) compressed += Number(marked.value) || 0;
  }

  const left = listScreenMemories(dir, { kind: 'raw', includeCompressed: false, limit: 2000 });
  const remaining = left.ok === true && Array.isArray(left.value) ? left.value.length : 0;
  logger.info?.(`chat-widget: 压缩完成 —— ${groups.size} 组、新增 ${summaries} 条摘要、标记 ${compressed} 条 raw、剩 ${remaining} 条未压缩`);
  return { ok: true, groups: groups.size, compressed, summaries, remaining };
}
