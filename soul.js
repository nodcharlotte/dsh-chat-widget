/**
 * @local/chat-widget —— 人格（`SOUL.md`）读写。
 *
 * 一个纯文本文件，**扁平放在数据目录里**，与 `chat.db` 同级：所以
 * 「把 AI_History 打包发给别人」就等于把人格 + 记忆 + 历史一起交出去。
 *
 * 文件结构（也就是「人格」Tab 里那些框的一一映射）：
 *
 *   # {角色名}
 *
 *   ## 身份          称呼用户 / 称呼自身 / 身份描述
 *   ## 外貌特征
 *   ## 性格核心
 *   ## 说话规则
 *   ## 场景反应与例句
 *   ## 内容边界
 *   ## 自由补充
 *
 * 解析必须**宽容**：NAVI 自己装的那份 SOUL.md 就没按它的模板写（连 `##` 都没有），
 * 结果被它自己的校验器判成非法。我们这里是"读不出来就留空"，**绝不吃掉文件内容**；
 * 只有明确点「保存」才会按表单重写整个文件。
 *
 * @module @local/chat-widget/soul
 */

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** 人格文件名。 */
export const SOUL_FILE = 'SOUL.md';

/** 每个框的长度上限（防止一次粘贴把提示词撑爆）。 */
const MAX_FIELD_CHARS = 4000;

/** 段落定义：顺序即写入顺序，也是注入提示词时的顺序。 */
export const SOUL_SECTIONS = [
  { key: 'identity', title: '身份' },
  { key: 'appearance', title: '外貌特征' },
  { key: 'personality', title: '性格核心' },
  { key: 'speechRules', title: '说话规则' },
  { key: 'scenarios', title: '场景反应与例句' },
  { key: 'boundaries', title: '内容边界' },
  { key: 'extra', title: '自由补充' },
];

/** 空表单。 */
export function emptySoulFields() {
  return {
    name: '',
    userCall: '',
    selfCall: '',
    identity: '',
    appearance: '',
    personality: '',
    speechRules: '',
    scenarios: '',
    boundaries: '',
    extra: '',
  };
}

/**
 * 归一一个框的值。
 * @param {unknown} value - 原始值。
 * @returns {string} 去首尾空白、截断后的字符串。
 */
function normalizeField(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/\r\n?/g, '\n').trim().slice(0, MAX_FIELD_CHARS);
}

/**
 * 把任意输入归一成一份完整表单。
 * @param {unknown} raw - 原始字段对象。
 * @returns {object} 完整表单。
 */
export function normalizeSoulFields(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {};
  const fields = emptySoulFields();
  for (const key of Object.keys(fields)) fields[key] = normalizeField(source[key]);
  return fields;
}

/** 人格文件路径。 */
export function soulPath(dir) {
  return join(dir, SOUL_FILE);
}

/**
 * 从 Markdown 里解析出表单字段（宽容：缺什么就留空）。
 * @param {string} raw - 文件内容。
 * @returns {object} 表单字段。
 */
export function parseSoul(raw) {
  const fields = emptySoulFields();
  if (typeof raw !== 'string' || raw.trim() === '') return fields;
  const lines = raw.replace(/\r\n?/g, '\n').split('\n');

  // 角色名：优先 `# xxx`；没有标题时退一步认「角色名」下一行的写法（NAVI 那份就是这样）
  const titleIndex = lines.findIndex((line) => /^#\s+\S/.test(line));
  if (titleIndex !== -1) {
    fields.name = lines[titleIndex].replace(/^#\s+/, '').trim();
  } else {
    const labelIndex = lines.findIndex((line) => line.trim() === '角色名');
    if (labelIndex !== -1) {
      const next = lines.slice(labelIndex + 1).find((line) => line.trim() !== '');
      if (next !== undefined) fields.name = next.trim();
    } else {
      const first = lines.find((line) => line.trim() !== '');
      if (first !== undefined && first.trim().length <= 40) fields.name = first.trim();
    }
  }

  // 段落：`## 标题` 到下一个 `##` 之间
  const bodies = {};
  let current = null;
  for (const line of lines) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading !== null) {
      current = heading[1].trim();
      bodies[current] = [];
      continue;
    }
    if (current !== null) bodies[current].push(line);
  }

  for (const section of SOUL_SECTIONS) {
    const body = bodies[section.title];
    if (body === undefined) continue;
    if (section.key === 'identity') {
      // 身份里额外拆出「称呼用户」「称呼自身」两行
      const kept = [];
      for (const line of body) {
        const userCall = /^称呼用户\s*[:：]\s*(.*)$/.exec(line);
        const selfCall = /^称呼自身\s*[:：]\s*(.*)$/.exec(line);
        if (userCall !== null) fields.userCall = userCall[1].trim();
        else if (selfCall !== null) fields.selfCall = selfCall[1].trim();
        else kept.push(line);
      }
      fields.identity = kept.join('\n').trim();
    } else {
      fields[section.key] = body.join('\n').trim();
    }
  }
  return fields;
}

/**
 * 把表单渲染成 Markdown。空框对应的段整段省略（不注入空标题）。
 * @param {object} fields - 表单字段。
 * @returns {string} Markdown 文本。
 */
export function renderSoul(fields) {
  const value = normalizeSoulFields(fields);
  const out = [];
  if (value.name !== '') out.push(`# ${value.name}`, '');

  for (const section of SOUL_SECTIONS) {
    const lines = [];
    if (section.key === 'identity') {
      if (value.userCall !== '') lines.push(`称呼用户：${value.userCall}`);
      if (value.selfCall !== '') lines.push(`称呼自身：${value.selfCall}`);
      if (value.identity !== '') {
        if (lines.length > 0) lines.push('');
        lines.push(value.identity);
      }
    } else if (value[section.key] !== '') {
      lines.push(value[section.key]);
    }
    if (lines.length === 0) continue;
    out.push(`## ${section.title}`, ...lines, '');
  }
  return out.join('\n').trim() + '\n';
}

/**
 * 表单是否完全为空（全空 = 没有可写的内容）。
 * @param {object} fields - 表单字段。
 * @returns {boolean} 是否全空。
 */
export function isSoulEmpty(fields) {
  const value = normalizeSoulFields(fields);
  return Object.values(value).every((item) => item === '');
}

/**
 * 读人格文件。
 * @param {string} dir - 数据目录。
 * @returns {{ok: boolean, exists: boolean, path: string, raw: string, fields: object, error?: string}} 读取结果。
 */
export function readSoul(dir) {
  const path = soulPath(dir);
  let raw = '';
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    if (error !== null && typeof error === 'object' && error.code === 'ENOENT') {
      return { ok: true, exists: false, path, raw: '', fields: emptySoulFields() };
    }
    return { ok: false, exists: false, path, raw: '', fields: emptySoulFields(), error: String(error) };
  }
  return { ok: true, exists: true, path, raw, fields: parseSoul(raw) };
}

/**
 * 写人格文件（同目录临时文件 + rename，避免写到一半断电留半个文件）。
 *
 * 全空表单**不覆盖**已有文件：宁可"什么都没发生"，也不要因为误清空就把人格删掉。
 *
 * @param {string} dir - 数据目录。
 * @param {object} fields - 表单字段。
 * @returns {{ok: boolean, written: boolean, path: string, reason: string}} 写入结果。
 */
export function writeSoul(dir, fields) {
  const path = soulPath(dir);
  if (isSoulEmpty(fields)) {
    return { ok: true, written: false, path, reason: '表单为空，未写入（也不会覆盖已有文件）' };
  }
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(tmp, renderSoul(fields), 'utf8');
    renameSync(tmp, path);
    return { ok: true, written: true, path, reason: '' };
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      /* 临时文件可能根本没建起来 */
    }
    return { ok: false, written: false, path, reason: String(error) };
  }
}

/**
 * 取要注入提示词的人格文本：文件存在就**原样**用它，否则返回空串
 * （由调用方回落到那句兜底）。
 * @param {string} dir - 数据目录。
 * @returns {string} 人格文本（可能为空）。
 */
export function soulPromptText(dir) {
  const result = readSoul(dir);
  if (result.ok !== true || result.exists !== true) return '';
  return result.raw.trim();
}
