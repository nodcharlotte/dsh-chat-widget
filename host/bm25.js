/**
 * @local/chat-widget —— 零依赖的 BM25 关键词检索（Embedding 的离线兜底）。
 *
 * 为什么自己写：用户可能**没有**任何向量服务（不装 Ollama、也不想调云端接口），
 * 而记忆库和屏幕记忆都得能取回旧事。这里只用字符串，不碰网络、不引入依赖。
 *
 * 中文没有空格，标准 BM25 的"按词切"在这里用不了。所以切词规则是：
 *   - **汉字段 → 二元组**（`他们去哪` → `他们/们去/去哪`），单字段保留单字；
 *   - **英文/数字 → 小写整词**（长度 ≥ 2）。
 * 二元组是同义词之外的"近似词"折中：同一个词就能命中，换个说法就命中不了 ——
 * 这正是关键词模式的能力边界，界面上也照实说了。
 *
 * 打分是教科书 BM25（k1=1.2、b=0.75），只对**查询里出现过的词**累加，
 * 最后按最高分做一次相对截断（默认留最高分的 35% 以上），避免把只有
 * 一个"的/了"级别二元组重合的记忆也带进提示词。
 *
 * @module @local/chat-widget/host/bm25
 */

/** BM25 词频饱和参数。 */
export const BM25_K1 = 1.2;

/** BM25 文档长度归一参数。 */
export const BM25_B = 0.75;

/** 相对截断：低于"最高分 × 这个比例"的命中直接丢掉。 */
export const BM25_MIN_RATIO = 0.35;

/** 汉字段（含扩展 A 区）。 */
const HAN_RUN = /[\u3400-\u4dbf\u4e00-\u9fff]+/g;

/** 参与切词的汉字（用于把汉字段从英文/数字里剔掉）。 */
const HAN_CHAR = /[\u3400-\u4dbf\u4e00-\u9fff]/g;

/** 英文/数字词。 */
const WORD_RUN = /[a-z0-9_]+/g;

/** 切出来的 token 缓存上限（条）。 */
const TOKEN_CACHE_LIMIT = 20000;

/** 缓存：原文 → token 数组（原文相同就必然同一组 token）。 */
const tokenCache = new Map();

/**
 * 把一段文本切成检索用的 token。
 * @param {unknown} input - 原文。
 * @returns {string[]} token 数组（可能为空）。
 */
export function tokenize(input) {
  const text = typeof input === 'string' ? input.normalize('NFKC').toLowerCase() : '';
  if (text === '') return [];
  const tokens = [];
  const hanRuns = text.match(HAN_RUN) ?? [];
  for (const run of hanRuns) {
    if (run.length === 1) {
      tokens.push(run);
      continue;
    }
    for (let i = 0; i + 2 <= run.length; i += 1) tokens.push(run.slice(i, i + 2));
  }
  // 汉字段先剔掉，剩下的是英文 / 数字 / 下划线的词
  const rest = text.replace(HAN_CHAR, ' ');
  for (const word of rest.match(WORD_RUN) ?? []) {
    if (word.length >= 2) tokens.push(word);
  }
  return tokens;
}

/**
 * 带缓存的切词（同一句被反复检索时不重算）。
 * @param {unknown} text - 原文。
 * @returns {string[]} token 数组。
 */
export function cachedTokens(text) {
  const key = typeof text === 'string' ? text : '';
  const hit = tokenCache.get(key);
  if (hit !== undefined) return hit;
  const tokens = tokenize(key);
  if (tokenCache.size >= TOKEN_CACHE_LIMIT) tokenCache.clear();
  tokenCache.set(key, tokens);
  return tokens;
}

/**
 * 一组 token 的词频表。
 * @param {string[]} tokens - token 数组。
 * @returns {Map<string, number>} token → 出现次数。
 */
function frequencies(tokens) {
  const table = new Map();
  for (const token of tokens) table.set(token, (table.get(token) ?? 0) + 1);
  return table;
}

/**
 * 按 BM25 给一组文档打分。
 *
 * `docs` 里每一项至少要有 `text`；已经切过词的可以额外带 `tokens`（省一次切词）。
 * 返回的每一项是 `{ doc, score }`，已按分数降序并做过相对截断。
 *
 * @param {string} query - 查询文本（用户这句话）。
 * @param {{text: string, tokens?: string[], [key: string]: unknown}[]} docs - 候选文档。
 * @param {{topK?: number, minRatio?: number}} [options] - 取几条、相对截断比例。
 * @returns {{doc: object, score: number}[]} 命中列表（可能为空）。
 */
export function rankBm25(query, docs, options = {}) {
  const queryTokens = [...new Set(tokenize(query))];
  const list = Array.isArray(docs) ? docs : [];
  if (queryTokens.length === 0 || list.length === 0) return [];
  const topK = Number.isInteger(options.topK) && options.topK > 0 ? options.topK : 4;
  const minRatio = Number.isFinite(options.minRatio) ? Math.min(0.95, Math.max(0, options.minRatio)) : BM25_MIN_RATIO;

  // 一次遍历：条目化（词频 + 长度），顺手累计平均长度
  let totalLength = 0;
  const prepared = [];
  for (const doc of list) {
    const tokens = Array.isArray(doc.tokens) ? doc.tokens : cachedTokens(doc.text);
    if (tokens.length === 0) continue;
    prepared.push({ doc, tf: frequencies(tokens), length: tokens.length });
    totalLength += tokens.length;
  }
  if (prepared.length === 0) return [];
  const averageLength = totalLength / prepared.length || 1;

  // 文档频率只统计查询里出现的词
  const documentFrequency = new Map();
  for (const token of queryTokens) {
    let count = 0;
    for (const item of prepared) if (item.tf.has(token)) count += 1;
    documentFrequency.set(token, count);
  }

  const total = prepared.length;
  const scored = [];
  for (const item of prepared) {
    let score = 0;
    for (const token of queryTokens) {
      const frequency = item.tf.get(token) ?? 0;
      if (frequency === 0) continue;
      const df = documentFrequency.get(token) ?? 0;
      // 出现得越多越不值钱；df=0 时不会走到这里
      const idf = Math.log(1 + (total - df + 0.5) / (df + 0.5));
      const saturation = frequency * (BM25_K1 + 1)
        / (frequency + BM25_K1 * (1 - BM25_B + BM25_B * (item.length / averageLength)));
      score += idf * saturation;
    }
    if (score > 0) scored.push({ doc: item.doc, score });
  }
  if (scored.length === 0) return [];
  scored.sort((a, b) => b.score - a.score);
  const floor = scored[0].score * minRatio;
  return scored.filter((item) => item.score >= floor).slice(0, topK);
}

/**
 * 两组 token 的 Dice 系数（0–1）。
 * @param {string[]} left - 第一组。
 * @param {string[]} right - 第二组。
 * @returns {number} 相似度。
 */
export function diceTokens(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length === 0 || right.length === 0) return 0;
  const a = new Set(left);
  const b = new Set(right);
  let overlap = 0;
  for (const token of a) if (b.has(token)) overlap += 1;
  return (2 * overlap) / (a.size + b.size);
}

/**
 * 两段文本的 Dice 相似度（屏幕记忆去重用，代替余弦）。
 * @param {unknown} left - 第一段。
 * @param {unknown} right - 第二段。
 * @returns {number} 相似度。
 */
export function textSimilarity(left, right) {
  return diceTokens(cachedTokens(left), cachedTokens(right));
}
