/**
 * @local/chat-widget —— 成长日记（越用越懂）。
 *
 * 和记忆库的关系：记忆库是**事实**（只挑原句、不许改写，靠原文子串闸门兜底）；
 * 成长日记是唯一允许它**自己写**的地方，所以保险换成另外三条：
 *   ① 只改「现在」这一节，日记条目**只追加、不改写历史**（模型碰不到旧条目）
 *   ② 「现在」和每条日记都有长度上限
 *   ③ 每次更新都基于**真实入库的记忆**（不是凭空让它发挥）
 *
 * 触发：每攒够 `GROW_DIGEST_BATCH` 条新记忆，在入库之后顺手做一次（不需要定时器）；
 * 上次消化到哪条记忆记在 `meta.growth_last_memory_id` 里，所以重启也不会重复消化。
 * 开关：设置的 `growth.enabled`（默认关）。写坏了就把 `GROWTH.md` 整个删掉重新积累——
 * 这也是**不做编辑界面**的原因。
 *
 * @module @local/chat-widget/host/growth
 */

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { readSoul } from '../soul.js';
import { listMemoryVectors, readMeta, writeMeta } from '../store.js';
import { resolveApiKey } from './settings.js';
import { callUpstreamOnce } from './upstream.js';

/** 成长日记的文件名（放在数据目录里，和 SOUL.md 平级）。 */
export const GROWTH_FILE = 'GROWTH.md';

/** 攒够几条新记忆更新一次（内部常量）。 */
export const GROW_DIGEST_BATCH = 5;

/** `meta` 里记「消化到哪条记忆」的键。 */
const LAST_ID_KEY = 'growth_last_memory_id';

/** 「现在」这一节的长度上限。 */
const MAX_NOW_CHARS = 400;

/** 每条日记的长度上限。 */
const MAX_ENTRY_CHARS = 120;

/** 一次最多追加几条日记（模型话多也不能无限写）。 */
const MAX_NEW_ENTRIES = 3;

/** 少于这么多字的日记条目丢掉（挡掉"嗯""note"这类）。 */
const MIN_ENTRY_CHARS = 4;

/** 小模型偶尔把 schema 的键名当内容交回来（实测见过 "note"），这些一律丢掉。 */
const JUNK_ENTRIES = new Set(['note', 'notes', 'diary', 'now', 'entry', 'entries', 'text', '日记', '现在']);

/** 日记保留多少条（超了从最老的开始丢）。 */
const MAX_ENTRIES = 300;

/** 输出契约：`{"now": "…", "diary": ["…"]}`。 */
export const GROWTH_SCHEMA = {
  type: 'object',
  properties: {
    now: { type: 'string' },
    diary: { type: 'array', items: { type: 'string' } },
  },
  required: ['now', 'diary'],
};

/**
 * 成长日记的提示词（极简、**不给例子**：小模型会照抄例子，抽取那边已经吃过这个亏）。
 */
export const GROWTH_PROMPT = [
  '你在读自己写给自己的成长日记，并更新它。全部用中文写。',
  '「现在」：用第一人称写几句话，描述你此刻的样子（脾气、习惯、在这段关系里在意什么）。',
  '只写有依据的变化；没什么变化就基本保持原样。不超过 200 字。',
  '「日记」：这次想给自己留的一句话，写你的体会。可以有主观感受，但不要编造片段里没有的具体事件。',
  '所有内容都要和上面给你的片段对得上；片段里没有的事不要写。',
  '再说一遍：全部用中文。',
].join('\n');

/** 至少有一个汉字才算"用中文写的"。 */
const hasChinese = (text) => /[\u4e00-\u9fff]/.test(String(text));

/** 非 ollama 端点没有 schema 约束，只能把形状写进提示词。 */
const JSON_HINT = '只输出 JSON，形如 {"now":"…","diary":["…"]}。';

/**
 * 宽容地解析成长日记的输出（解析不出来就当空）。
 * @param {string} raw - 模型输出。
 * @returns {{now: string, diary: string[]}} 解析结果。
 */
export function parseGrowth(raw) {
  const text = typeof raw === 'string' ? raw.trim() : '';
  let value = null;
  const accept = (candidate) => {
    if (candidate !== null && typeof candidate === 'object' && value === null) value = candidate;
  };
  try {
    accept(JSON.parse(text));
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start !== -1 && end > start) {
      try {
        accept(JSON.parse(text.slice(start, end + 1)));
      } catch {
        /* 解析不出来就当空 */
      }
    }
  }
  const source = value === null ? {} : value;
  return {
    now: typeof source.now === 'string' ? source.now : '',
    diary: Array.isArray(source.diary) ? source.diary.filter((item) => typeof item === 'string') : [],
  };
}

/**
 * 读成长日记。
 * @param {string} configuredDir - 数据目录。
 * @returns {{path: string, exists: boolean, now: string, entries: string[], updatedAt: number|null}} 内容。
 */
export function readGrowth(configuredDir) {
  const path = join(String(configuredDir), GROWTH_FILE);
  let text = '';
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return { path, exists: false, now: '', entries: [], updatedAt: null };
  }
  const nowMatch = /##\s*现在\s*\n([\s\S]*?)(?=\n##\s|$)/.exec(text);
  const diaryMatch = /##\s*日记\s*\n?([\s\S]*)$/.exec(text);
  const updatedMatch = /<!--\s*updated:\s*(\d+)\s*-->/.exec(text);
  const entries = diaryMatch === null
    ? []
    : diaryMatch[1]
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('- '))
      .map((line) => line.slice(2).trim())
      .filter((line) => line !== '');
  return {
    path,
    exists: true,
    now: nowMatch === null ? '' : nowMatch[1].trim(),
    entries,
    updatedAt: updatedMatch === null ? null : Number(updatedMatch[1]),
  };
}

/**
 * 原子写成长日记（临时文件 + rename，别把文件写坏）。
 * @param {string} configuredDir - 数据目录。
 * @param {string} now - 「现在」这一节。
 * @param {string[]} entries - 日记条目（按时间正序）。
 * @returns {{ok: boolean, path: string, error?: string}} 结果。
 */
export function writeGrowth(configuredDir, now, entries) {
  const dir = String(configuredDir);
  const path = join(dir, GROWTH_FILE);
  const body = [
    '# 成长日记',
    '',
    `<!-- updated: ${Date.now()} -->`,
    '',
    '## 现在',
    now,
    '',
    '## 日记',
    ...entries.map((entry) => `- ${entry}`),
    '',
  ].join('\n');
  const tmp = join(dir, `.GROWTH.${process.pid}.${Date.now()}.tmp`);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(tmp, body, 'utf8');
    renameSync(tmp, path);
    return { ok: true, path };
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      /* 临时文件可能没建起来 */
    }
    return { ok: false, path, error: String(error) };
  }
}

/**
 * 需要的话消化一次：把新入库的记忆变成成长日记的更新。
 *
 * 任何一步失败都只 warn 并**不动**「消化到哪条」的标记，下一轮会重来。
 *
 * @param {object} logger - 日志器。
 * @param {object} settings - 当前设置。
 * @returns {Promise<{skipped?: string, updated?: boolean, entries?: number, fresh?: number}>} 结果。
 */
export async function maybeGrow(logger, settings) {
  if (settings === null || typeof settings !== 'object') return { skipped: 'no-settings' };
  if (settings.growth === undefined || settings.growth.enabled !== true) return { skipped: 'disabled' };

  const dir = settings.store.dir;
  const markerResult = readMeta(dir, LAST_ID_KEY);
  const marker = markerResult.ok === true ? Number(markerResult.value) || 0 : 0;

  const rows = listMemoryVectors(dir, 5000);
  if (rows.ok !== true) {
    logger.warn?.(`chat-widget: 成长日记读记忆失败: ${String(rows.error)}`);
    return { skipped: 'store' };
  }
  const fresh = rows.value.filter((row) => row.id > marker).sort((a, b) => a.id - b.id);
  if (fresh.length < GROW_DIGEST_BATCH) return { skipped: 'not-enough', fresh: fresh.length };

  const current = readGrowth(dir);
  const model = settings.models.text;
  const isOllama = model.provider === 'ollama';
  // 把人格里的角色名带上：不带名字时它更容易飘成通用的「心理咨询腔」（实测飘成英文）
  const soul = readSoul(dir);
  const name = soul !== null && typeof soul === 'object' && soul.fields !== null && typeof soul.fields === 'object' && typeof soul.fields.name === 'string'
    ? soul.fields.name.trim()
    : '';
  const systemText = `${name === '' ? '' : `你是「${name}」本人。`}${GROWTH_PROMPT}`;
  const messages = [
    { role: 'system', content: isOllama ? systemText : `${systemText}\n${JSON_HINT}` },
    {
      role: 'user',
      content: [
        current.now === ''
          ? '（你还没有写过「现在」这一节。请用中文写，开头就用「我是」，不要写英文。）'
          : `你现在写下来的样子：\n${current.now}`,
        `这段时间被记下来的片段：\n${fresh.map((row) => row.text).join('\n——\n')}`,
        '（全部用中文写，不要写英文。）',
      ].join('\n\n'),
    },
  ];

  // 本机那个 abliterated 小模型在"写日记"这种任务上会飘成英文（实测两次都是）。
  // 只多要一次、明确点名；再飘就照写——写坏了用户自己删文件重来（这也是不做编辑界面的原因）。
  const ask = (extra) => callUpstreamOnce(
    model,
    resolveApiKey(model).value,
    extra === '' ? messages : [...messages, { role: 'user', content: extra }],
    { format: isOllama ? GROWTH_SCHEMA : undefined },
  );
  let raw = '';
  try {
    raw = await ask('');
    if (hasChinese(raw) === false) raw = await ask('上次你写成了英文。这次必须全部用中文写，不要出现英文句子。');
  } catch (error) {
    logger.warn?.(`chat-widget: 成长日记调用失败（下次重来）: ${String(error)}`);
    return { skipped: 'endpoint' };
  }

  const parsed = parseGrowth(raw);
  const now = (parsed.now.trim() === '' ? current.now : parsed.now.trim()).slice(0, MAX_NOW_CHARS);
  const added = parsed.diary
    .map((entry) => entry.trim().slice(0, MAX_ENTRY_CHARS))
    // 太短的、以及把 schema 键名当内容交回来的（实测见过 "note"）一律丢掉
    .filter((entry) => entry.length >= MIN_ENTRY_CHARS && JUNK_ENTRIES.has(entry.toLowerCase()) === false)
    .slice(0, MAX_NEW_ENTRIES);
  const entries = [...current.entries, ...added].slice(-MAX_ENTRIES);

  const written = writeGrowth(dir, now, entries);
  if (written.ok !== true) {
    logger.warn?.(`chat-widget: 成长日记写文件失败: ${String(written.error)}`);
    return { skipped: 'write' };
  }
  writeMeta(dir, LAST_ID_KEY, String(fresh[fresh.length - 1].id));
  logger.info?.(`chat-widget: 成长日记更新（消化 ${fresh.length} 条记忆，日记 +${added.length} 条，共 ${entries.length} 条）`);
  return { updated: true, entries: entries.length, fresh: fresh.length };
}
