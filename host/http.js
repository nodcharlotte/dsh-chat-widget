/**
 * @local/chat-widget —— HTTP 小工具。
 *
 * 只放与业务无关的东西：来源栅栏、JSON 响应、请求体读取、SSE 写入。
 *
 * @module @local/chat-widget/host/http
 */

/** 请求体上限，防止异常大的 body 打爆内存。 */
export const MAX_BODY_BYTES = 64 * 1024;

/**
 * 判断一个 Origin 是不是本机（127.0.0.1 / localhost / ::1）。
 * @param {string} origin - Origin 头。
 * @returns {boolean} 是否本机。
 */
export function isLoopbackOrigin(origin) {
  try {
    const host = new URL(origin).hostname.toLowerCase();
    return host === '127.0.0.1' || host === 'localhost' || host === '::1'
      || host === '[::1]' || host.endsWith('.localhost');
  } catch {
    return false;
  }
}

/**
 * 回一个 JSON 响应。
 * @param {import('node:http').ServerResponse} res - 响应对象。
 * @param {number} status - HTTP 状态码。
 * @param {unknown} payload - 响应体。
 */
export function sendJson(res, status, payload) {
  const body = Buffer.from(`${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store',
  });
  res.end(body);
}

/**
 * 读取请求体（带上限）。
 * @param {import('node:http').IncomingMessage} req - 请求对象。
 * @param {number} [limit] - 字节上限，默认 `MAX_BODY_BYTES`。
 * @returns {Promise<string>} 请求体文本。
 * @throws 超过上限时抛错。
 */
export function readBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error(`请求体超过 ${limit} 字节上限`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * 读请求体并解析成对象；空体当作 `{}`，非法 JSON 抛错（由调用方回 400）。
 * @param {import('node:http').IncomingMessage} req - 请求对象。
 * @returns {Promise<object>} 解析后的对象（一定是对象）。
 * @throws 请求体不是合法 JSON 时抛错。
 */
export async function readJsonBody(req) {
  const raw = await readBody(req);
  const parsed = JSON.parse(raw === '' ? '{}' : raw);
  return parsed !== null && typeof parsed === 'object' ? parsed : {};
}

/**
 * 往 SSE 连接写一个事件（连接已结束就静默跳过）。
 * @param {import('node:http').ServerResponse} res - 响应对象。
 * @param {string} event - 事件名。
 * @param {unknown} data - 事件数据。
 */
export function sseSend(res, event, data) {
  if (res.writableEnded === true) return;
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/**
 * 进入 SSE 模式（关掉中间层缓冲，保证逐字可见）。
 * @param {import('node:http').ServerResponse} res - 响应对象。
 */
export function sseStart(res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
}
