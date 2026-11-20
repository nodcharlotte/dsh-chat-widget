/**
 * @local/chat-widget —— 提示词组装与输出清洗。
 *
 * system prompt 的顺序：
 *   人格（`SOUL.md`，没有文件就回落一句兜底） → 末尾人格锚定 → 记忆块 → 屏幕记忆块 → 窗口记录块 → 窗口名块
 *   （每一个都是"没有就不占位"）
 *
 * 会话消息的顺序：
 *   system → 最近 N 条原文 → 本轮输入
 *
 * 「最近 N 条」由 `store.recentContext()` 按**它说的一句**为单位取好，这里不再二次截断，
 * 否则设置里调大条数会被悄悄压回默认值。
 *
 * @module @local/chat-widget/host/prompt
 */

import { soulPromptText } from '../soul.js';

/** 单条用户消息的长度上限。 */
export const MAX_MESSAGE_CHARS = 8000;

/** 没有人格文件时的兜底人格：就一句话，不做花活。 */
const FALLBACK_SOUL = '你是NAVI，智能聊天助手。';

/**
 * system prompt 末尾的人格锚定。
 *
 * 实测证据：本地小模型在只有一句话人格时会**随机发明身份**（同一问法三次分别自称
 * 「通义千问」「个人 AI 助理」「Naval Media 的聊天伴侣」），还会编造联网查询和不存在的
 * 日期。把身份与边界放在**最靠近对话的位置**再说一遍能压住它。
 */
const CHARACTER_ANCHOR = [
  '——',
  '提醒：你是上面描述的这个角色本人。不要自称其他任何身份或公司；',
  // 实测：人格文件常用**第三人称**写（如「助手为用户的妹妹」），小模型会把它理解成
  // "在描述另一个人"，于是出现「我说的是欧尼酱的助手啊，不是你」这种把自己当第三方的回答。
  // 这里把第三人称的**自称**钉回"你自己"。
  // 注意：**不要在这里列举具体关系**（妹妹 / 妈妈 / 老婆……）——人格是用户自己写的，
  // 什么关系都可能有，写死一个称呼会直接把别人的人格改坏。
  '上面那段设定里，凡是第三人称提到你的说法（「助手」「她」「他」之类），**指的都是你自己**；',
  '你永远用第一人称说话，不要把自己当成第三个人，也不要像旁观者一样议论自己。',
  '被问到"你是谁 / 你是什么模型"时，就按上面的设定回答（你是谁、和对方是什么关系），',
  '不要讨论背后的模型、厂商或技术实现，也不要把它们当成另一个人来评价。',
  '你没有任何联网、执行命令、写代码或调用工具的能力，被问到就直说做不到；',
  '不知道的事就说不知道，不要编造。',
  // 用户明确要求：这窗口小、字多了烦；动作/神态/外貌描写默认不要写。
  // 实测发现"不要写"这种**否定式**约束 9B 基本无视（它照样写「（开门走进您怀里）」），
  // 所以改成**给出替代做法**：把动作融进台词里用第一人称说出来——有正例可模仿，
  // 比单纯禁止有效得多。
  '默认风格：回复简短，通常一两句。不要用括号写动作或神态——把动作融进台词里说出来，',
  '例如不要写「（开门走进怀里）」，而是说「那我就坐在你怀里了」。外貌与心理描写也不要写，',
  '除非上面的人格设定明确要求。',
].join('\n');

/**
 * 人格文本：优先读数据目录里的 `SOUL.md`，没有就回落那句兜底。
 * @param {string} dir - 数据目录。
 * @returns {string} 人格文本。
 */
function buildSoulText(dir) {
  const soul = soulPromptText(dir);
  return soul === '' ? FALLBACK_SOUL : soul;
}

/**
 * 括号动作过滤器（流式安全）。
 *
 * 实测：这个 9B **会无视提示词里的"不要写动作"**——否定式（"不写动作描写"）和给正例
 * （"把动作融进台词，例如说'那我就坐在你怀里了'"）都试过，三条测试全中
 * 「（快步迎上去接住他的外套）」这种开头动作。所以只能在输出上动手：把回复**开头**
 * 的括号动作扣住不发，等它闭合后整块丢掉——界面上从头到尾都不会闪出动作。
 *
 * @returns {{feed: (delta: string) => string, flush: () => string}} 过滤器。
 */
export function createStageDirectionFilter() {
  let pending = '';
  let decided = false;
  return {
    feed(delta) {
      if (decided === true) return delta;
      pending += typeof delta === 'string' ? delta : '';
      const matched = /^[\s*]*[（(][^）)]{0,80}[）)][\s*]*/.exec(pending);
      if (matched !== null) {
        decided = true;
        const rest = pending.slice(matched[0].length);
        pending = '';
        return rest;
      }
      // 还只看到"空白 + 左括号"就继续扣着，别急着发
      if (/^[\s*]*[（(]/.test(pending) === true) return '';
      decided = true;
      const out = pending;
      pending = '';
      return out;
    },
    flush() {
      if (decided === true) return '';
      decided = true;
      const out = pending;
      pending = '';
      return out;
    },
  };
}

/**
 * 对完整文本再清一遍**行首**的括号动作（应对换行后才出现的动作描写）。
 * @param {string} text - 回复全文。
 * @returns {string} 清理后的文本。
 */
export function stripStageDirections(text) {
  return String(text)
    .split('\n')
    .map((line) => line.replace(/^[\s*]*[（(][^）)]{0,80}[）)][\s*]*/, ''))
    .join('\n')
    .trim();
}

/**
 * 记忆块：没有记忆时返回空串（**不占位**，不留一个空标签给模型看）。
 *
 * 每条记忆自己带 `用户：` / `助手：` 行首标签（入库时由程序加的），块里用一条分隔线
 * 把不同记忆分开，免得两条记忆的行混在一起看不出来。
 *
 * @param {string[]} memories - 记忆文本。
 * @returns {string} `<memory>` 块或空串。
 */
export function buildMemoryBlock(memories) {
  const list = Array.isArray(memories)
    ? memories.filter((item) => typeof item === 'string' && item.trim() !== '')
    : [];
  if (list.length === 0) return '';
  const lines = ['<memory>', '以下是更早聊过、值得记住的片段（每行开头是说话人）：'];
  list.forEach((item, index) => {
    if (index > 0) lines.push('——');
    lines.push(item);
  });
  lines.push('</memory>');
  return lines.join('\n');
}

/**
 * 组装 system prompt：人格 + 末尾锚定 + 记忆块。
 * @param {string} dir - 数据目录（人格文件所在处）。
 * @param {string[]} [memories] - 检索到的记忆。
 * @returns {string} system prompt。
 */
/**
 * 成长块：只放「现在」那一节（日记条目不进提示词）。没有就返回空串。
 * @param {string} now - 成长日记里的「现在」。
 * @returns {string} `<growth>` 块或空串。
 */
export function buildGrowthBlock(now) {
  const text = typeof now === 'string' ? now.trim() : '';
  if (text === '') return '';
  return ['<growth>', '以下是你在成长日记里写下的「现在」，作为你的延续：', text, '</growth>'].join('\n');
}

/**
 * 窗口块（情况 1）：**只列不同的进程名**（去重后的），并写明"仅作背景参考"。
 * 没有变化就返回空串，不占位。
 *
 * @param {string[]} processes - 去重后的进程名。
 * @returns {string} `<windows>` 块或空串。
 */
export function buildWindowsBlock(processes) {
  const list = Array.isArray(processes)
    ? processes.filter((item) => typeof item === 'string' && item.trim() !== '')
    : [];
  if (list.length === 0) return '';
  return [
    '<windows>',
    '这段时间你在用的程序（仅作背景参考，不用主动提起，除非对方问起）：',
    list.join('、'),
    '</windows>',
  ].join('\n');
}

export function buildSystemPrompt(dir, memories = [], growthNow = '', windows = [], screenMemory = '', windowLog = '') {
  return [
    buildSoulText(dir),
    CHARACTER_ANCHOR,
    buildGrowthBlock(growthNow),
    buildMemoryBlock(memories),
    screenMemory,
    windowLog,
    buildWindowsBlock(windows),
  ]
    .filter((part) => part !== '')
    .join('\n\n');
}

/**
 * 组装发给上游的消息数组。
 * @param {string} dir - 数据目录（人格文件所在处）。
 * @param {{role: string, content: string}[]} history - 已保存的消息（升序，已按设置取好窗口）。
 * @param {string} content - 本轮用户输入。
 * @param {{memories?: string[]}} [options] - 检索到的记忆。
 * @returns {{role: string, content: string}[]} 上游消息数组。
 */
export function buildUpstreamMessages(dir, history, content, options = {}) {
  const memories = Array.isArray(options.memories) ? options.memories : [];
  const growthNow = typeof options.growthNow === 'string' ? options.growthNow : '';
  const windows = Array.isArray(options.windows) ? options.windows : [];
  const screenMemory = typeof options.screenMemory === 'string' ? options.screenMemory : '';
  const windowLog = typeof options.windowLog === 'string' ? options.windowLog : '';
  const messages = [{ role: 'system', content: buildSystemPrompt(dir, memories, growthNow, windows, screenMemory, windowLog) }];
  for (const item of Array.isArray(history) ? history : []) {
    messages.push({ role: item.role, content: item.content });
  }
  // 历史里可能因为窗口截断而没有本轮输入，补上（正常情况它已经是最后一条）
  const last = messages[messages.length - 1];
  if (last === undefined || last.role === 'system' || last.content !== content) {
    messages.push({ role: 'user', content });
  }
  return messages;
}
