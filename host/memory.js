/**
 * @local/chat-widget —— 记忆库：入库与检索。
 *
 * 入库（后台，30 秒扫一次）：
 *   到点的助手消息 → 我那句喂一次抽取、它那句喂一次抽取（两次调用，标签由程序加）
 *   → 两侧都挑不出东西就**不建记忆**（但消息照样标 `indexed_at`）
 *   → 有东西就向量化，写一条 `memories`，再标记参与的消息
 *
 * 倒计时**不放内存**：`messages.ingest_due_at = 落库时刻 + delayMinutes`。
 * 所以 5 分钟没到就关机也不丢——启动时先扫一次，到点的一开机就补上，没到点的继续等。
 *
 * 检索（聊天时）：
 *   用本轮我的话去查 -> 余弦 > 阈值 -> 取 top-K -> **排除与最近 N 条窗口重叠的记忆**
 *   （记忆按一问一答入，天然会和最近几条重合，从检索侧剔重即可，历史窗口保持完整）
 *
 * Embedding 选「BM25 关键词模式」（`keyword-bm25`）时，上面两步都不调端点：
 *   入库只存文本（vec 留空），检索改成在原文上跑 BM25（`host/bm25.js`）。
 *
 * @module @local/chat-widget/host/memory
 */

import { dueIngestPairs, insertMemory, listMemoryVectors, markMessagesIndexed } from '../store.js';
import { rankBm25 } from './bm25.js';
import { extractKeep } from './extract.js';
import { maybeGrow } from './growth.js';
import { isKeywordEmbedding, readSettings, resolveApiKey } from './settings.js';
import { callUpstreamEmbed } from './upstream.js';

/** 扫描间隔（内部常量）。 */
export const SCAN_INTERVAL_MS = 30000;

/** 一次扫描最多处理几轮。 */
const DUE_BATCH = 4;

/** 检索带回几条。 */
export const TOP_K = 4;

/** 余弦相似度阈值：低于它的记忆不带进提示词。 */
export const MIN_SCORE = 0.35;

/** 一整条记忆的长度上限。 */
const MAX_MEMORY_CHARS = 1200;

/** 注入提示词时每条记忆截多少字。 */
const MAX_INJECT_CHARS = 200;

/** 聊天时那次向量调用的超时：宁可这次没有记忆，也不能卡住回复。 */
const QUERY_EMBED_TIMEOUT_MS = 5000;

/** 余弦相似度。 */
export function cosine(a, b) {
  const length = Math.min(a.length, b.length);
  if (length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * 拼一条记忆的文本：**每行都带说话人标签**（标签由程序加，不经过模型）。
 * @param {string[]} userKeeps - 从我说的话里挑出来的原句。
 * @param {string[]} botKeeps - 从它说的话里挑出来的原句。
 * @returns {string} 记忆文本（空串表示两侧都没挑出东西）。
 */
export function buildMemoryText(userKeeps, botKeeps) {
  const lines = [];
  for (const sentence of userKeeps) lines.push(`用户：${sentence}`);
  for (const sentence of botKeeps) lines.push(`助手：${sentence}`);
  if (lines.length === 0) return '';

  const kept = [];
  let total = 0;
  for (const line of lines) {
    if (total + line.length + 1 > MAX_MEMORY_CHARS) break;
    kept.push(line);
    total += line.length + 1;
  }
  // 第一行单独就超长（少见）：硬切一条，总比什么都不记强
  if (kept.length === 0) kept.push(lines[0].slice(0, MAX_MEMORY_CHARS));
  return kept.join('\n');
}

/**
 * 处理一轮：抽取 → 向量化 → 入库 → 标记。
 *
 * 抽取失败（端点不可达/超时）时**不标记** `indexed_at`，下一轮扫描会重试；
 * 抽取成功但没挑出东西时照样标记，因为再试也不会有新结果。
 *
 * `pair.users` 是**这一答前面连续的我方消息**（可能只有一条，也可能连着问了几句）。
 * 连问几句时它们会被拼成一段一起抽取、并且**一起被标记已处理** —— 否则第一句会永远停在 ✕。
 *
 * @param {object} logger - 日志器。
 * @param {object} settings - 当前设置。
 * @param {{assistantId: number, assistantText: string, user: {msgId: number, text: string}|null,
 *   users?: {msgId: number, text: string}[]}} pair - 一轮。
 * @returns {Promise<void>} 完成。
 */
async function ingestOnce(logger, settings, pair) {
  const textRole = settings.models.text;
  const textKey = resolveApiKey(textRole).value;
  const embedRole = settings.models.embed;
  const dir = settings.store.dir;
  // 兼容旧形状（只有 user 没有 users）：一律整理成数组
  const users = Array.isArray(pair.users) && pair.users.length > 0
    ? pair.users
    : (pair.user === null || pair.user === undefined ? [] : [pair.user]);

  const [userResult, botResult] = await Promise.allSettled([
    users.length === 0 ? Promise.resolve([]) : extractKeep(textRole, textKey, users.map((item) => item.text).join('\n')),
    extractKeep(textRole, textKey, pair.assistantText),
  ]);

  if (userResult.status === 'rejected' || botResult.status === 'rejected') {
    const reason = userResult.status === 'rejected' ? userResult.reason : botResult.reason;
    logger.warn?.(`chat-widget: 抽取失败（下一轮重试，消息 ${pair.assistantId}）: ${String(reason)}`);
    return;
  }

  const text = buildMemoryText(userResult.value, botResult.value);
  const ids = [...users.map((item) => item.msgId), pair.assistantId];

  if (text === '') {
    markMessagesIndexed(dir, ids, Date.now());
    return;
  }

  // 关键词模式（`keyword-bm25`）：没有向量可算，也不该为了"重试"把消息压在队里 ——
  // 直接把文本存下来（vec 留空），检索时按字面重合度打分。
  let vec = [];
  if (isKeywordEmbedding(embedRole) === false) {
    try {
      const vectors = await callUpstreamEmbed(embedRole, resolveApiKey(embedRole).value, [text]);
      vec = Array.isArray(vectors[0]) ? vectors[0] : [];
    } catch (error) {
      logger.warn?.(`chat-widget: 向量化失败（下一轮重试，消息 ${pair.assistantId}）: ${String(error)}`);
      return;
    }
    if (vec.length === 0) {
      logger.warn?.(`chat-widget: 向量端点返回空向量（下一轮重试，消息 ${pair.assistantId}）`);
      return;
    }
  }

  const saved = insertMemory(dir, { fromMsg: users.length === 0 ? null : users[0].msgId, toMsg: pair.assistantId, text, vec });
  if (saved.ok !== true) {
    logger.warn?.(`chat-widget: 写记忆失败: ${String(saved.error)}`);
    return;
  }
  markMessagesIndexed(dir, ids, Date.now());
  logger.info?.(`chat-widget: 记忆 +1（#${saved.value}，${text.length} 字，消息 ${ids.join('+')}）`);

  // 成长日记：攒够条数就顺手更新一次（开关在设置里；关着的话这里直接返回）
  await maybeGrow(logger, settings);
}

/**
 * 扫一遍：把某个数据目录里到点还没入库的助手消息处理掉。
 *
 * 设置由调用方传入（而不是自己读文件），这样它既能被后台循环用，也能被离线的
 * 检查脚本直接驱动。
 *
 * @param {object} logger - 日志器。
 * @param {object} settings - 当前设置。
 * @param {() => boolean} isStopped - 是否已经卸载。
 * @returns {Promise<{processed: number}>} 本轮处理了几轮（成功与否都算处理过）。
 */
export async function ingestDue(logger, settings, isStopped = () => false) {
  const due = dueIngestPairs(settings.store.dir, Date.now(), DUE_BATCH);
  if (due.ok !== true) {
    logger.warn?.(`chat-widget: 读取待入库消息失败: ${String(due.error)}`);
    return { processed: 0 };
  }
  let processed = 0;
  for (const pair of due.value) {
    if (isStopped() === true) break;
    await ingestOnce(logger, settings, pair);
    processed += 1;
  }
  return { processed };
}

/**
 * 启动入库循环：立刻扫一次（补上关机期间到点的），之后每 30 秒一次。
 * @param {object} logger - 日志器。
 * @returns {() => void} 停止函数（插件卸载/热重载时调用）。
 */
export function startMemoryIndexer(logger) {
  let stopped = false;
  let running = false;

  const tick = () => {
    if (stopped === true || running === true) return;
    running = true;
    readSettings(logger)
      .then(({ settings }) => ingestDue(logger, settings, () => stopped))
      .catch((error) => logger.warn?.(`chat-widget: 入库扫描出错: ${String(error)}`))
      .finally(() => {
        running = false;
      });
  };

  const startup = setTimeout(tick, 1000);
  if (typeof startup.unref === 'function') startup.unref();
  const timer = setInterval(tick, SCAN_INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();

  return () => {
    stopped = true;
    clearTimeout(startup);
    clearInterval(timer);
  };
}

/**
 * 关键词模式的检索：不调任何端点，直接在记忆原文上跑 BM25。
 *
 * 与余弦检索共用同一套「排除最近窗口」规则（`toMsg >= startId` 的不要），
 * 所以两种模式在提示词里的位置完全一样，只是命中判据换了。
 *
 * @param {object} logger - 日志器。
 * @param {unknown} dir - 数据目录。
 * @param {string} query - 本轮用户输入。
 * @param {number|null} startId - 最近 N 条窗口的起始消息 id。
 * @param {number} topK - 取几条。
 * @returns {string[]} 命中的记忆文本（已截断）。
 */
function retrieveByKeywords(logger, dir, query, startId, topK) {
  const rows = listMemoryVectors(dir);
  if (rows.ok !== true) {
    logger.warn?.(`chat-widget: 读记忆失败（这轮不带记忆）: ${String(rows.error)}`);
    return [];
  }
  const docs = [];
  for (const row of rows.value) {
    if (Number.isInteger(startId) && row.toMsg >= startId) continue;
    if (typeof row.text !== 'string' || row.text === '') continue;
    docs.push({ text: row.text });
  }
  return rankBm25(query, docs, { topK }).map((hit) => hit.doc.text.slice(0, MAX_INJECT_CHARS));
}

/**
 * 检索：给本轮的话找几条旧记忆。
 *
 * 两条路：向量相似度（默认）或 BM25 关键词（`keyword-bm25` 兜底模式）。
 * 任何一步失败都只返回空数组（并 warn）——记忆是锦上添花，不许打断聊天。
 *
 * @param {object} logger - 日志器。
 * @param {object} settings - 当前设置。
 * @param {string} query - 本轮用户输入。
 * @param {number|null} startId - 最近 N 条窗口的起始消息 id（`toMsg >= startId` 的记忆会被排除）。
 * @param {{topK?: number}} [options] - 取几条（默认 `TOP_K`；`/memory/search` 自检时用来多要几条）。
 * @returns {Promise<string[]>} 记忆文本数组（已截断，未命中的为空数组）。
 */
export async function retrieveMemories(logger, settings, query, startId, options = {}) {
  const text = typeof query === 'string' ? query.trim() : '';
  if (text === '') return [];

  const topK = Number.isInteger(options.topK) && options.topK > 0 ? Math.min(50, options.topK) : TOP_K;
  const embedRole = settings.models.embed;
  const dir = settings.store.dir;

  if (isKeywordEmbedding(embedRole) === true) return retrieveByKeywords(logger, dir, text, startId, topK);

  let queryVec = [];
  try {
    const vectors = await callUpstreamEmbed(embedRole, resolveApiKey(embedRole).value, [text], {
      timeoutMs: QUERY_EMBED_TIMEOUT_MS,
    });
    queryVec = Array.isArray(vectors[0]) ? vectors[0] : [];
  } catch (error) {
    logger.warn?.(`chat-widget: 检索向量失败（这轮不带记忆）: ${String(error)}`);
    return [];
  }
  if (queryVec.length === 0) return [];

  const rows = listMemoryVectors(dir);
  if (rows.ok !== true) {
    logger.warn?.(`chat-widget: 读记忆失败（这轮不带记忆）: ${String(rows.error)}`);
    return [];
  }

  const scored = [];
  for (const row of rows.value) {
    // 与最近窗口重叠的记忆不带（规则 1：历史窗口保持完整，重复从检索侧剔掉）
    if (Number.isInteger(startId) && row.toMsg >= startId) continue;
    const score = cosine(queryVec, row.vec);
    if (score < MIN_SCORE) continue;
    scored.push({ score, text: row.text });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK).map((item) => item.text.slice(0, MAX_INJECT_CHARS));
}
