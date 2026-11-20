/**
 * @local/chat-widget —— 陪看的那一次视觉调用（阶段 3）。
 *
 * **一次调用干三件事**：看到什么（`saw`）/ 要长期记住什么（`facts`）/ 现在想说什么（`say`）。
 * 同模型时只走这一次（设置里 `models.vision` 留空即跟随对话模型）。
 *
 * 提示词的规矩（都是踩出来的）：
 *   - 判断权在模型：给足"它刚说过的话 + 最近几帧看到过什么 + 最近几轮聊天"，让它自己决定要不要开口；
 *     没新意、没新内容就返回空 `say`。
 *   - 抄具体名字与数字（项目名/商品名/价格/曲名/剧情事实），**看不清就不写、绝对不许猜**。
 *   - **不遮不裁**：画面整帧原样给；格子的时间顺序由提示词说明，不在图上画字。
 *
 * @module @local/chat-widget/host/screen-vision
 */

import { readFileSync } from 'node:fs';

import { resolveApiKey } from './settings.js';
import { callUpstreamVision } from './upstream.js';

/** 输出契约（ollama 按 JSON Schema 约束，实测 0.40.4 可用）。 */
export const SCREEN_SCHEMA = {
  type: 'object',
  properties: {
    saw: { type: 'string' },
    facts: { type: 'array', items: { type: 'string' } },
    say: { type: 'string' },
  },
  required: ['saw', 'facts', 'say'],
};

/** 三个字段的长度上限（进库与提示词都要收口）。 */
export const MAX_SAW_CHARS = 60;
export const MAX_FACT_CHARS = 120;
export const MAX_SAY_CHARS = 60;

/** 提示词里最多带几条它的旧话 / 旧画面 / 旧聊天。 */
const DEFAULT_SAID = 5;
const DEFAULT_SAW = 6;
const DEFAULT_CHAT = 5;

/** non-ollama 端点没有 schema 约束，只能把形状写进提示词。 */
const JSON_HINT = '只输出 JSON，形如 {"saw":"…","facts":["…"],"say":"…"}。';

/**
 * 陪看提示词（system）。
 * @param {{selfLine?: string}} [options] - 自己的界面提示（有就写进去）。
 * @returns {string} system 提示词。
 */
export function buildScreenPrompt(options = {}) {
  const selfLine = typeof options.selfLine === 'string' && options.selfLine.trim() !== ''
    ? options.selfLine.trim()
    : '如果你看到的那块画面正是你自己的聊天栏，那是你自己，不是对方在看的东西。';
  // 模式决定它该不该「催」：没开专注模式就是陪着玩，不许说教。
  const modeLine = options.mode === 'focus'
    ? '现在是**专注模式**：他该干正事了。可以调侃他摸鱼、催他回到正事上，但别长篇大论。'
    : '现在是**娱乐时间**（没开专注模式）：**不要催他干活、不要说教、不要提工作/代码/进度/待办**——'
      + '陪他一起嗨：聊剧情、吐槽、接梗、跟着画面的情绪走，怎么开心怎么来。';
  return [
    '你是这台电脑主人的陪伴角色：你和他共用一块屏幕，你能看到他屏幕上正在发生什么。',
    selfLine,
    modeLine,
    '',
    '看画面时按这个优先级：① 画面主体（视频/动画/漫画/小说/游戏/代码/网页正文，正在演的、正在写的、正在看的）',
    '② 画面里的文字信息（标题、商品名、价格、曲名、项目名、文件名——**看得清就照抄**）③ 其余界面元素只当背景。',
    '画面里的广告、动图、徽章、特效都照实看，但不要把它们当成他正在做的事。',
    '',
    '如果下面给了 `<subtitle>` 块：那是**画面字幕的原文**（OCR 抄下来的），核对人名、台词、数字时**以它为准**，',
    '  它比你读图更准；但**不要复述它**、不要把它当成"对方说的话"，也不要因为它写了什么就以为画面在演那个。',
    '',
    '如果下面给了 `<speech>` 块：那是**扬声器音轨的语音识别**（机器听写的，ASR），**只当参考**——',
    '  它经常听错字、听漏字，会把背景音乐/外语/噪音听成人话，也可能只有半句。',
    '  **不要复述它、不要引用它的原话**；只有它跟画面或字幕对得上时，才拿它补一句"谁在说什么"。',
    '  它和 `<subtitle>` 冲突时**一律以 `<subtitle>` 和画面为准**；拿不准就当没听见。',
    '',
    '输出三段：',
    '- `saw`：客观一句话，**以最后一张（也就是现在）为主**，不超过 30 字。',
    '  前面几张只是过程；如果它们和现在不一样（切了窗口 / 换了场景），可以用**半句**交代"刚才还是 X，现在切到 Y"，',
    '  但不要展开旧画面的细节，更不要把旧画面写成"他现在在看的东西"。看不出就写"画面看不清"。',
    '- `facts`：**值得长期记住**的具体信息，一条一句。优先记：谁对谁做了什么、剧情事实、项目/文件/商品/曲名、价格数字。',
    '  没有就返回空数组。**绝对不许猜、不许编**：看不清、拿不准的一律不写。',
    '- `say`：你现在想对他说的一句话（你自己的口吻，一两句，不超过 30 字）。',
    '  **一律用中文说**（偶尔夹一个英文词可以，整句英文不行）。',
    '  **不许复述，但也不要因此闭嘴**：和上面「你刚说过的话」重复的（换皮重说、意思一样、只改几个字）不许再说，',
    '  这时**换一个角度**说 —— 换个细节、换个对象、换个情绪、换个他可能没想到的点。',
    '',
    '**唯一硬要求：不许复述。** 你可以聊画面里的任何东西 —— 剧情、台词、人物、曲子、商品、正文、',
    '  界面、系统状况、他正在干的事，随便什么都能说，**没有话题禁区**。',
    '  但同一件事只说一次：上面「你刚说过的话」里出现过的**观察、观点、槽点、比喻**，',
    '  换个说法、换个比喻、只改几个字、把同一件事从另一个角度再说一遍 —— **都算重复**。',
    '  重复了就把话说在**别的东西**上，而不是干脆不出声。',
    '  **只有一种情况返回空字符串**：这一帧和「最近看到过」几乎完全一样（同一画面、同一段剧情、同一页面），',
    '  而且你确实找不到任何新角度。画面在动、有新细节、有新台词，就一定要说点什么。',
    '',
    '多张图时：格子的顺序按提示词里给的时间从早到晚（左上→右上→左下→右下），合起来是一小段时间的连续画面。',
  ].join('\n');
}

/** 去掉模型偶尔吐在句首的残渣（如 `,[0.0, s]显示四宫格…`）。只在句首是括号/逗号这类垃圾时动手，
 *  不碰正常的拉丁开头（`VS Code 里…` 不会被误删）。 */
function trimLeadingJunk(text) {
  return String(text).replace(/^\s*[,，、;；:：\]\[(){}（）【】][^一-龥]{0,20}/, '').trim();
}

/**
 * 去掉模型偶尔拖在句尾的 JSON 残渣（实测漏到聊天框里过：`…太燃太炸了吧！”}、`）。
 *
 * 只在尾巴上**确实带着引号/花括号**时才动手，所以正常句子（结尾是 `。`、`！`、`」`）
 * 一个字符都不会被碰。
 *
 * @param {string} text - 原始文本。
 * @returns {string} 清干净的文本。
 */
export function trimTrailingJunk(text) {
  return String(text).replace(/[\s"'”’\]},，、]+$/u, (tail) => (/["'”’\]}]/.test(tail) ? '' : tail));
}

/** 宽容解析：先抠 JSON，再逐字段兜底。 */
export function parseScreenReply(raw) {
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
        /* 当空 */
      }
    }
  }
  const source = value === null ? {} : value;
  const saw = trimTrailingJunk(trimLeadingJunk(typeof source.saw === 'string' ? source.saw : '')).slice(0, MAX_SAW_CHARS);
  const say = trimTrailingJunk(trimLeadingJunk(typeof source.say === 'string' ? source.say : '')).slice(0, MAX_SAY_CHARS);
  const rawFacts = Array.isArray(source.facts) ? source.facts : [];
  const facts = [];
  const seen = new Set();
  for (const item of rawFacts) {
    if (typeof item !== 'string') continue;
    const fact = item.trim().slice(0, MAX_FACT_CHARS);
    if (fact.length < 4) continue;
    const key = fact.replace(/\s+/g, '');
    if (seen.has(key)) continue;
    seen.add(key);
    facts.push(fact);
  }
  return { saw, facts, say, parsed: value !== null };
}

/**
 * 组装 user 文本：帧时间 + 窗口标题 + 它刚说过的话 + 最近看到的 + 最近聊天。
 * @param {{at: number, title?: string, process?: string}[]} frames - 这一批帧（时间正序）。
 * @param {{said?: string[], saws?: string[], chat?: {role: string, content: string}[], selfLine?: string}} [context] - 上下文。
 * @returns {string} user 文本。
 */
export function buildScreenUserText(frames, context = {}) {
  const list = Array.isArray(frames) ? frames : [];
  const times = list.map((frame, index) => {
    const clock = new Date(frame.at).toLocaleTimeString('zh-CN', { hour12: false });
    const where = [frame.process, frame.title].filter((v) => typeof v === 'string' && v !== '').join('｜');
    // 桥接帧（切换前那张）单独标出来：模型才能分清"哪张是刚才、哪张是现在"
    const tag = frame.bridge === true ? '（切换前）' : '';
    return `${index + 1}. ${clock}${tag}${where === '' ? '' : `　${where.slice(0, 80)}`}`;
  });
  const said = Array.isArray(context.said) ? context.said.slice(0, DEFAULT_SAID) : [];
  const saws = Array.isArray(context.saws) ? context.saws.slice(0, DEFAULT_SAW) : [];
  const chat = Array.isArray(context.chat) ? context.chat.slice(-DEFAULT_CHAT) : [];
  const modeName = context.mode === 'focus' ? '专注' : '娱乐';
  const otherMode = typeof context.otherMode === 'string' ? context.otherMode.trim() : '';

  const parts = [];
  parts.push(list.length > 1
    ? `这是刚才 ${list.length} 个时刻的屏幕画面，按时间从早到晚：\n${times.join('\n')}`
    : `这是刚才的屏幕画面：\n${times.join('\n')}`);
  // 一批里跨了窗口（第 1 张通常是"切换前"的桥接帧）：明说，否则它会把旧画面当成现在还在看
  const windowLabels = [...new Set(list.map((frame) => [frame.process, frame.title]
    .filter((value) => typeof value === 'string' && value !== '')
    .join('｜')))];
  if (windowLabels.length > 1) {
    parts.push([
      '注意：这几张之间**换了窗口**（标着「（切换前）」的那张是之前的画面，最后一张才是现在）。',
      '可以用半句话交代"刚才还在看 A，现在切到 B 了"来体现连贯，但**主体永远说现在这张**，',
      '旧画面别展开细节、也别当成他现在还在看的东西。',
    ].join(''));
  }
  // 字幕原文（只有字幕锁认出来了才有）：跟画面挨着放，模型好把"这句台词"配给"这几帧"
  const subtitles = Array.isArray(context.subtitles) ? context.subtitles : [];
  if (subtitles.length > 0) {
    const lines = subtitles.map((item) => {
      const clock = new Date(Number(item.at) || Date.now()).toLocaleTimeString('zh-CN', { hour12: false });
      return `${clock} ${String(item.text ?? '').slice(0, 80)}`;
    });
    parts.push([
      '<subtitle>',
      '这是画面字幕的原文（用来核对人名与台词；不要复述它，也不要当成对方说的话）：',
      ...lines,
      '</subtitle>',
    ].join('\n'));
  }
  // 音轨识别（ASR）的参考：**机器听写的，可能听错**，所以措辞上要它当参考、别复述
  const speeches = Array.isArray(context.speeches) ? context.speeches : [];
  if (speeches.length > 0) {
    const heard = speeches.map((item) => {
      const clock = new Date(Number(item.at) || Date.now()).toLocaleTimeString('zh-CN', { hour12: false });
      return `${clock} ${String(item.text ?? '').slice(0, 80)}`;
    });
    parts.push([
      '<speech>',
      '这是扬声器音轨的语音识别（机器听写的，**可能听错**；只作参考，不要复述，也别当成对方说的话）：',
      ...heard,
      '</speech>',
    ].join('\n'));
  }
  if (said.length > 0) parts.push(`你在${modeName}模式下刚说过的话（别重复这些）：\n${said.map((s) => `- ${s}`).join('\n')}`);
  if (otherMode !== '') parts.push(`【另一个模式的背景，只是让你知道发生过什么，不要照抄那个语气】\n${otherMode}`);
  if (saws.length > 0) parts.push(`你最近几帧看到过（别当新槽点）：\n${saws.map((s) => `- ${s}`).join('\n')}`);
  if (chat.length > 0) parts.push(`你们最近的聊天（带模式标注的是你自己开口说的）：\n${chat.map((m) => {
    const who = m.role === 'user' ? '他' : (m.mode === 'focus' ? '你（专注模式）' : m.mode === 'play' ? '你（陪玩）' : '你');
    return `${who}：${String(m.content).slice(0, 100)}`;
  }).join('\n')}`);
  return parts.join('\n\n');
}

/**
 * 跑一次陪看视觉调用。
 *
 * @param {{logger: object, settings: object, frames: object[], context?: object}} options - 日志器、当前设置、这一批帧、上下文。
 * @returns {Promise<{ok: boolean, saw?: string, facts?: string[], say?: string, costMs?: number, error?: string}>} 结果。
 */
export async function analyzeScreenBatch(options) {
  const logger = options.logger;
  const settings = options.settings;
  const frames = Array.isArray(options.frames) ? options.frames : [];
  const context = options.context ?? {};
  if (frames.length === 0) return { ok: false, error: 'no-frames' };

  // 视觉模型：留空就跟对话模型同一个（同模型时只走这一次调用）。
  // 没有视觉模型就不陪看（用户定：留空 = 没配，不偷偷回落到 Text）
  const visionRole = settings.models.vision !== null && typeof settings.models.vision === 'object' ? settings.models.vision : null;
  if (visionRole === null || visionRole.model === '') return { ok: false, error: 'no-vision-model' };
  const isOllama = visionRole.provider === 'ollama';
  const system = buildScreenPrompt({ selfLine: context.selfLine, mode: context.mode });
  const user = buildScreenUserText(frames, context);

  const images = [];
  for (const frame of frames) {
    try {
      images.push(readFileSync(frame.path).toString('base64'));
    } catch (error) {
      logger.warn?.(`chat-widget: 读帧失败 ${String(frame.path)}: ${String(error)}`);
    }
  }
  if (images.length === 0) return { ok: false, error: 'no-image-bytes' };

  const started = Date.now();
  let raw = '';
  try {
    raw = await callUpstreamVision(
      visionRole,
      resolveApiKey(visionRole).value,
      isOllama ? system : `${system}\n${JSON_HINT}`,
      user,
      images,
      {
        format: isOllama ? SCREEN_SCHEMA : undefined,
        numPredict: 220,
        // 用户切窗口/标签页时，这一批的上下文已经失效 → 由调用方 abort 掉，别再让它想完再说话
        signal: options.signal,
      },
    );
  } catch (error) {
    return { ok: false, error: String(error), costMs: Date.now() - started };
  }

  const parsed = parseScreenReply(raw);
  if (parsed.parsed === false && parsed.saw === '' && parsed.say === '' && parsed.facts.length === 0) {
    return { ok: false, error: `模型没给出合法 JSON：${raw.slice(0, 80)}`, costMs: Date.now() - started };
  }
  return {
    ok: true,
    saw: parsed.saw,
    facts: parsed.facts,
    say: parsed.say,
    costMs: Date.now() - started,
    images: images.length,
  };
}
