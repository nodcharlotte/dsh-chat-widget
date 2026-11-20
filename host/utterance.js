/**
 * @local/chat-widget —— **唯一的出句出口**（utterance sink）。
 *
 * ## 为什么要有这个文件
 *
 * 以前"它说出一句话"有三条独立的路，每条都自己写库、自己广播、自己决定要不要让桌宠念：
 *
 * | 来源 | 写库 | 广播 | 桌宠 |
 * |---|---|---|---|
 * | 问答回复（`chat.js`） | 自己写 | 交给聊天框转发 `POST /pet/utter` | 念 |
 * | 专注模式（`perceive.js`） | 自己写 | 自己广播 `say` | 念 |
 * | 陪看（`companion.js`） | 自己写 | 自己广播 `say` | 念 |
 *
 * 结果就是用户实测到的两件事：
 *   1. **同一句念两遍** —— 自主发言既走 `say`（宿主广播）又被聊天框转成 `utter`，桌宠两个都听；
 *   2. **三个引擎各有一套"别重复"的状态**，专注和陪看互不知情，可以就同一时刻各说一句。
 *
 * 正确的形状只有一个：**不管哪来的句子，出模型之后走同一条管道** ——
 * 落库（聊天框就靠库和事件显示）→ 广播**一个**事件（桌宠靠它出气泡 + TTS）。
 * 差异只应该留在**模型那一侧**（用什么提示词、看什么上下文、多久允许开口）。
 *
 * ## 这个模块负责什么
 *
 * `emit()` 是唯一入口：写一条 `assistant` 消息进库，然后广播**唯一一个** `say` 事件。
 * 谁调它都行（问答 / 专注 / 陪看），出来的效果完全一样。
 *
 * @module @local/chat-widget/host/utterance
 */

import { appendMessage } from '../store.js';

/** 广播的事件名。**只有一个**，桌宠和聊天框都听它。 */
export const UTTER_EVENT = 'say';

/**
 * 造一个出句出口。
 *
 * @param {object} options - 依赖。
 * @param {object} options.logger - 日志器。
 * @param {{broadcast: Function}} options.hub - 事件中心。
 * @param {() => string} options.getStoreDir - 取当前生效的数据目录（设置里可改、可能回落）。
 * @param {() => number} options.getDelayMinutes - 取"记忆入库倒计时"（分钟）。
 * @returns {{emit: Function}} 出口。
 */
export function createUtterance({ logger, hub, getStoreDir, getDelayMinutes }) {
  const dirOf = () => (typeof getStoreDir === 'function' ? String(getStoreDir()) : '');
  const delayOf = () => {
    const value = typeof getDelayMinutes === 'function' ? Number(getDelayMinutes()) : NaN;
    return Number.isFinite(value) && value >= 0 ? value : 5;
  };

  return {
    /**
     * 它说出一句话：落库 → 广播。**这是唯一的路。**
     *
     * @param {object} input - 一句话及其元信息。
     * @param {string} input.text - 内容（空白会被丢掉）。
     * @param {string} [input.source] - 来源标记（`reply` / `focus` / `companion`），只用于日志与排查。
     * @param {string} [input.role] - 角色，默认 `assistant`。
     * @param {string|null} [input.error] - 这一句的错误标记（问答被中止时用）。
     * @param {boolean} [input.autonomous] - 是不是它自己开口（不和我的上一句配成问答）。
     * @param {string} [input.mode] - 当时的模式（`focus` / `play` …）。
     * @param {object} [input.extra] - 额外随事件广播的字段（如陪看的 `saw`）。
     * @returns {{ok:boolean, id?:number|null, sent?:number, error?:string}} 结果。
     */
    emit(input) {
      const source = input !== null && typeof input === 'object' && typeof input.source === 'string' ? input.source : '';
      const content = input !== null && typeof input === 'object' ? String(input.text ?? '').trim() : '';
      if (content === '') return { ok: false, id: null, sent: 0, error: 'empty-text' };

      const extra = input.extra !== null && typeof input.extra === 'object' ? input.extra : {};
      const saved = appendMessage(dirOf(), {
        role: typeof input.role === 'string' && input.role !== '' ? input.role : 'assistant',
        content,
        error: input.error === undefined ? null : input.error,
        autonomous: input.autonomous === true,
        mode: typeof input.mode === 'string' ? input.mode : '',
        ingestDueAt: Date.now() + delayOf() * 60000,
      });
      if (saved.ok !== true) {
        logger?.warn?.(`chat-widget: 出句落库失败（${source || 'unknown'}）：${String(saved.error)}`);
        return { ok: false, id: null, sent: 0, error: String(saved.error) };
      }

      // **唯一一次广播**。聊天框靠它插进列表，桌宠靠它出气泡 + TTS。
      const sent = hub.broadcast(UTTER_EVENT, {
        id: saved.value,
        content,
        createdAt: Date.now(),
        source,
        ...extra,
      });
      logger?.info?.(`chat-widget: 出句（${source || 'unknown'}，推给 ${sent} 条连接）：${content}`);
      return { ok: true, id: saved.value, sent };
    },
  };
}
