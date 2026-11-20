/**
 * @local/chat-widget —— `POST /chat`：一轮对话。
 *
 * 流程（顺序有讲究，别改）：
 *   1. 先把用户原文落库——即使随后模型不可用，这句话也不会丢
 *   2. 立刻回 SSE `start`，界面先显示「思考中」（**在检索记忆之前**发，
 *      否则向量冷启动那两秒界面是死的）
 *   3. 取最近 N 条 + 检索记忆库 → 组装提示词 → 逐段 `delta`
 *   4. 收尾补 `done`（带中止标记与失败原因）或 `error`
 *   5. 助手回复落库（**半截也存**，并记下原因），同时写下入库倒计时
 *
 * 记忆检索失败/超时都不影响这一轮：没有记忆照样聊。
 *
 * @module @local/chat-widget/host/chat
 */

import { appendMessage, recentContext } from '../store.js';
import { readJsonBody, sendJson, sseSend, sseStart } from './http.js';
import { MAX_MESSAGE_CHARS, buildUpstreamMessages, createStageDirectionFilter, stripStageDirections } from './prompt.js';
import { retrieveMemories } from './memory.js';
import { buildScreenMemoryBlock, buildWindowLogBlock, recallWindowLog, retrieveScreenMemories } from './screen-recall.js';
import { distinctProcesses } from './perceive.js';
import { readSettings, resolveApiKey } from './settings.js';
import { readGrowth } from './growth.js';
import { callUpstreamChat, readUpstreamStream } from './upstream.js';

/** 上一次结算到第几条窗口变化（进程内存着；热重载丢一次无所谓）。 */
let lastWindowSeq = 0;

/**
 * 处理一轮对话（SSE 流式）。
 * @param {{req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, logger: object}} options - 请求、响应、日志器。
 * @returns {Promise<void>} 完成。
 */
export async function handleChat({ req, res, logger, windowWatch, utterance }) {
  let input;
  try {
    input = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { error: 'bad-json', message: '请求体不是合法 JSON' });
    return;
  }

  const content = typeof input.content === 'string' ? input.content.trim().slice(0, MAX_MESSAGE_CHARS) : '';
  if (content === '') {
    sendJson(res, 400, { error: 'empty-message', message: '消息为空' });
    return;
  }

  const { settings } = await readSettings(logger);
  const dir = settings.store.dir;
  const role = settings.models.text;
  const apiKey = resolveApiKey(role).value;

  // 先把用户原文落库：即使随后模型不可用，这句话也不会丢
  const savedUser = appendMessage(dir, { role: 'user', content });
  if (savedUser.ok !== true) {
    sendJson(res, 200, { error: 'storage', message: `数据目录不可用：${savedUser.reason}` });
    return;
  }

  sseStart(res);
  sseSend(res, 'start', { userMessageId: savedUser.value, storeId: savedUser.storeId, dir: savedUser.dir });

  const controller = new AbortController();
  let aborted = false;
  // 用 res 的 close 判断「客户端跑掉了」：正常结束时 writableEnded 已经是 true
  res.on('close', () => {
    if (res.writableEnded !== true) {
      aborted = true;
      controller.abort();
    }
  });

  // 最近 N 条（条数在设置里；按「它说的一句」为单位取，一问一答算一条）
  const context = recentContext(dir, settings.memory.recentMessages);
  const contextWindow = context.ok === true ? context.value : { messages: [], startId: null };

  // 记忆库检索：与最近窗口重叠的不带（规则 1）
  let memories = [];
  if (aborted === false) {
    try {
      memories = await retrieveMemories(logger, settings, content, contextWindow.startId);
    } catch (error) {
      logger.warn?.(`chat-widget: 记忆检索失败（这轮不带记忆）: ${String(error)}`);
    }
  }
  // 成长日记的「现在」：只有开关打开时才读、才带进提示词（关掉 = 这个功能整体关掉）
  const growthNow = settings.growth.enabled === true ? readGrowth(dir).now : '';
  // 情况 1：**这期间**（上次对话到现在）的窗口变化，去重后只留不同的进程名，作为背景参考。
  // 开关没开的拿到的就是空数组（助手进程根本没起）。
  const windowChanges = windowWatch === undefined ? [] : windowWatch.changesSince(lastWindowSeq);
  if (windowWatch !== undefined) lastWindowSeq = windowWatch.currentSeq();
  const windows = settings.perceive.window === true ? distinctProcesses(windowChanges) : [];
  // 屏幕记忆：摘要优先（不跟聊天记忆共用一个库，检索也分开）
  let screenMemory = '';
  let windowLog = '';
  if (aborted === false) {
    try {
      const recalled = await retrieveScreenMemories(logger, settings, content);
      screenMemory = buildScreenMemoryBlock(recalled.rows, recalled.source);
    } catch (error) {
      logger.warn?.(`chat-widget: 屏幕记忆检索失败: ${String(error)}`);
    }
    try {
      // A 路线：问句里有时间词/关键词才注入窗口记录（不做工具调用）
      const log = recallWindowLog(settings, content);
      windowLog = log.triggered ? buildWindowLogBlock(log.events, log.window) : '';
    } catch (error) {
      logger.warn?.(`chat-widget: 窗口记录查询失败: ${String(error)}`);
    }
  }
  const upstreamMessages = buildUpstreamMessages(dir, contextWindow.messages, content, { memories, growthNow, windows, screenMemory, windowLog });

  // 最多试两次：本地模型偶发"什么都不返回"，用户看到的就是"它不理我"。
  // 只有"没有可显示内容"才重试，而且最多一次；真出错或用户按了停止都不重试。
  let full = '';
  let rawSeen = '';
  let failure = '';
  for (let attempt = 0; attempt < 2 && full === '' && aborted === false; attempt += 1) {
    const stageFilter = createStageDirectionFilter();
    try {
      const response = await callUpstreamChat(role, apiKey, upstreamMessages, controller.signal);
      if (response.ok !== true) {
        const detail = await response.text().catch(() => '');
        throw new Error(`端点返回 HTTP ${response.status}${detail === '' ? '' : `：${detail.slice(0, 200)}`}`);
      }
      rawSeen = await readUpstreamStream(
        response,
        role.provider === 'ollama',
        (text) => {
          const clean = stageFilter.feed(text);
          if (clean !== '') sseSend(res, 'delta', { text: clean });
        },
        () => aborted,
      );
      // 收尾：把还扣在过滤器里的内容放出来，并对全文再清一遍行首动作
      const stageTail = stageFilter.flush();
      if (stageTail !== '') sseSend(res, 'delta', { text: stageTail });
      full = stripStageDirections(rawSeen);
    } catch (error) {
      const name = error !== null && typeof error === 'object' ? error.name : '';
      if (aborted || name === 'AbortError') {
        failure = aborted ? '已中止' : '请求被取消';
      } else {
        const detail = error !== null && typeof error === 'object' && error.message ? String(error.message) : String(error);
        failure = `调用 ${role.provider}（${role.model === '' ? '未填模型' : role.model}）失败：${detail}`;
      }
      break;
    }
  }

  // 落助手回复：半截也存（并记下原因），界面刷新后不会凭空少一段。
  // **走唯一出口**：它负责落库 + 广播那唯一一个事件，桌宠和聊天框都靠它，
  // 所以问答回复和专注/陪看走的是**完全同一条路**（以前是聊天框自己转发，才会念两遍）。
  let assistantId = null;
  if (full !== '') {
    const spoken = utterance !== undefined && utterance !== null && typeof utterance.emit === 'function'
      ? utterance.emit({
        text: full,
        source: 'reply',
        // 被用户中止时 failure 是空的（读取端的异常已在内部消化），
        // 所以这里必须看 aborted 标志，否则半截回复会被记成"正常完成"
        error: aborted === true ? '已中止' : failure === '' ? null : failure,
      })
      : (() => {
        // 兜底：没有出口时至少把话存下来（自检里直接调 handleChat 就是这种情况）
        const savedAssistant = appendMessage(dir, {
          role: 'assistant',
          content: full,
          error: aborted === true ? '已中止' : failure === '' ? null : failure,
          ingestDueAt: Date.now() + settings.memory.delayMinutes * 60000,
        });
        return { ok: savedAssistant.ok === true, id: savedAssistant.ok === true ? savedAssistant.value : null };
      })();
    assistantId = spoken.ok === true ? spoken.id : null;
  }

  if (full === '' && failure !== '') {
    sseSend(res, 'error', { message: failure });
  } else if (full === '') {
    // 模型偶尔真的什么都不返回（实测会碰到）：必须让界面说句话，
    // 否则看起来就像"它无视了你"
    // 分清是"什么都没返回"还是"只写了动作被过滤掉了"：两种情况用户看到的都是空白，
    // 但原因不同，含糊其辞会让人以为它在装死
    sseSend(res, 'error', {
      message: rawSeen.trim() === ''
        ? '模型连续两次都没有返回内容，再发一次通常就好了。'
        : '它这次只写了动作或神态描写，过滤后没有可显示的内容，再发一次通常就好了。',
    });
  } else {
    sseSend(res, 'done', { messageId: assistantId, aborted, note: failure });
  }
  res.end();
}
