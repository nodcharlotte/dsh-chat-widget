/**
 * @local/chat-widget —— 宿主 → 浏览器的事件通道（SSE）。
 *
 * 唯一用途：**它主动开口**时把这句话推进聊天框。聊天本身仍然是浏览器发起的那条 SSE
 * （`POST /chat`），这里是反方向的一条长连接。
 *
 * 为什么不轮询：主动开口是稀疏事件（可能几十分钟一次），轮询要么太慢要么太费。
 *
 * @module @local/chat-widget/host/events
 */

/** 心跳间隔：EventSource 对长时间没数据的连接容易断，定期发一行注释行保活。 */
const HEARTBEAT_MS = 20000;

/**
 * 造一个事件中心。
 * @param {object} logger - 日志器。
 * @returns {{add: (res: object) => () => void, broadcast: (type: string, data: object) => number, size: () => number}} 事件中心。
 */
export function createEventHub(logger) {
  /** 当前连着的浏览器。 */
  const clients = new Set();

  const heartbeat = setInterval(() => {
    for (const res of clients) {
      try {
        res.write(': ping\n\n');
      } catch {
        clients.delete(res);
      }
    }
  }, HEARTBEAT_MS);
  if (typeof heartbeat.unref === 'function') heartbeat.unref();

  return {
    /**
     * 收下一条连接（调用方保证 res 还没发过任何东西）。
     * @param {import('node:http').ServerResponse} res - 响应对象。
     * @returns {() => void} 注销函数。
     */
    add(res) {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      res.write(': connected\n\n');
      clients.add(res);
      logger.info?.(`chat-widget: 事件通道 +1（现在 ${clients.size} 条）`);
      return () => {
        clients.delete(res);
        logger.info?.(`chat-widget: 事件通道 -1（现在 ${clients.size} 条）`);
      };
    },

    /**
     * 广播一个事件。
     * @param {string} type - 事件名（浏览器那边 `addEventListener(type, ...)`）。
     * @param {object} data - 负载（会被 JSON 序列化）。
     * @returns {number} 发给了几条连接。
     */
    broadcast(type, data) {
      const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
      let sent = 0;
      for (const res of clients) {
        try {
          res.write(payload);
          sent += 1;
        } catch {
          clients.delete(res);
        }
      }
      return sent;
    },

    /** 现在有几条连接。 */
    size() {
      return clients.size;
    },
  };
}
