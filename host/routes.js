/**
 * @local/chat-widget —— HTTP 路由表。
 *
 * 只注册**一个前缀路由** `/chat-widget/api`，在处理器内部按 method 分派：
 * webserver 的路由表只按 path 去重、不区分 method，所以这样既简单又不会与他人冲突。
 *
 * 空壳版的全部端点（只剩界面聊天需要的）：
 *   GET    /health              自检与存储状态
 *   GET    /settings            读设置（密钥脱敏）
 *   PUT    /settings            写设置（缺失的密钥字段 = 保留原值）
 *   GET    /soul                读人格（SOUL.md 的十个字段）
 *   PUT    /soul                写人格（全空表单不覆盖文件）
 *   GET    /messages            分页读消息（`before` + `limit`；带 `indexedAt`）
 *   DELETE /messages/:id        硬删一条消息
 *   GET    /memory              记忆库状态（已建几条、几条在排队等入库）
 *   GET    /window              前台窗口监测状态（当前窗口 + 最近若干次变化）
 *   POST   /store/clear         清空历史数据（消息 + 记忆；人格与成长日记不动）
 *   GET    /events              宿主 → 浏览器的长连接（它主动开口时推一句）
 *   POST   /chat                一轮对话（SSE：start / delta / done / error）
 *   POST   /models              用给定连接信息拉模型列表
 *   GET    /models?role=text    用已保存的设置拉模型列表
 *
 * @module @local/chat-widget/host/routes
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_PAGE_SIZE, clearHistory, deleteMessage, listMessages, memoryStats, screenStats, storeStatus } from '../store.js';
import { compressScreenMemories } from './screen-compress.js';
import { normalizeSoulFields, readSoul, writeSoul } from '../soul.js';
import { handleChat } from './chat.js';
import { readGrowth } from './growth.js';
import { isLoopbackOrigin, readJsonBody, sendJson } from './http.js';
import {
  MODEL_DEFAULT,
  keepOmittedKey,
  maskSettings,
  mergeSettings,
  normalizeSecret,
  normalizeSettings,
  readSettings,
  resolveApiKey,
  settingsFile,
  writeSettings,
} from './settings.js';
import { fetchProviderModels } from './upstream.js';
import { retrieveMemories } from './memory.js';
import { ocrLanguages } from './screen-capture.js';
import { ensureEngine, fetchWinmds, nativeStatus } from './native-build.js';
import { OCR_LANG_CHOICES, KEYWORD_EMBED_PROVIDER, isKeywordEmbedding } from './settings.js';
import { listModels, petRoots, readStatic, resolveModel } from './pet.js';

/** 路由前缀。 */
export const API_PREFIX = '/chat-widget/api';

/**
 * GET /health —— 自检与存储状态。
 * @param {object} ctx - `{res, logger}`。
 * @returns {Promise<void>} 完成。
 */
async function health({ res, logger }) {
  const { settings } = await readSettings(logger);
  sendJson(res, 200, {
    ok: true,
    plugin: 'chat-widget',
    settingsPath: settingsFile(),
    store: storeStatus(settings.store.dir),
  });
}

/**
 * GET /settings —— 读设置，密钥永不回传。
 * @param {object} ctx - `{res, logger}`。
 * @returns {Promise<void>} 完成。
 */
async function getSettings({ res, logger, beforeRead }) {
  // 启动时会把"会自己动起来"的开关写回 false；**第一次读设置必须等它写完**，
  // 否则界面会先显示上次的"开"、1 秒后才闪成"关"（用户实测过这个延迟）。
  if (typeof beforeRead === 'function') {
    try {
      await beforeRead();
    } catch {
      // 等不到就算了，别把设置页拖死
    }
  }
  const result = await readSettings(logger);
  sendJson(res, 200, {
    settings: maskSettings(result.settings),
    source: result.existed ? (result.corrupted ? 'corrupted' : 'file') : 'default',
    path: result.path,
  });
}

/**
 * PUT /settings —— 写设置。
 *
 * 密钥的「保留 / 替换 / 清除」三态靠**字段是否存在**区分：缺失 = 保留、空串 = 清除、
 * 有值 = 替换。因为 GET 不回传密钥，前端无法把旧值带回来。
 *
 * @param {object} ctx - `{req, res, logger}`。
 * @returns {Promise<void>} 完成。
 */
async function putSettings({ req, res, logger }) {
  let parsed;
  try {
    parsed = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { error: 'bad-json', message: '请求体不是合法 JSON' });
    return;
  }

  const previous = await readSettings(logger);
  // 先合并到已存设置上，再归一化：只发一部分时，没提到的部分不会被悄悄退回默认值
  const next = keepOmittedKey(normalizeSettings(mergeSettings(previous.settings, parsed)), previous.settings, parsed.models);
  await writeSettings(next);
  sendJson(res, 200, { settings: maskSettings(next), saved: true, path: settingsFile() });
}

/**
 * GET /soul —— 读人格（文件不存在也回 200 + 空表单：界面显示空框，不是报错）。
 * @param {object} ctx - `{res, logger}`。
 * @returns {Promise<void>} 完成。
 */
async function getSoul({ res, logger }) {
  const { settings } = await readSettings(logger);
  const result = readSoul(settings.store.dir);
  sendJson(res, 200, {
    ok: result.ok,
    exists: result.exists,
    path: result.path,
    dir: settings.store.dir,
    fields: result.fields,
    error: result.error === undefined ? null : result.error,
  });
}

/**
 * PUT /soul —— 写人格。全空表单不会覆盖已有文件（见 soul.js）。
 * @param {object} ctx - `{req, res, logger}`。
 * @returns {Promise<void>} 完成。
 */
async function putSoul({ req, res, logger }) {
  let parsed;
  try {
    parsed = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { error: 'bad-json', message: '请求体不是合法 JSON' });
    return;
  }
  const { settings } = await readSettings(logger);
  const fields = normalizeSoulFields(parsed.fields === undefined ? parsed : parsed.fields);
  const result = writeSoul(settings.store.dir, fields);
  sendJson(res, 200, {
    ok: result.ok,
    written: result.written,
    path: result.path,
    dir: settings.store.dir,
    reason: result.reason,
  });
}

/**
 * GET /messages —— 分页读消息（升序返回，便于直接渲染）。
 * @param {object} ctx - `{res, url, logger}`。
 * @returns {Promise<void>} 完成。
 */
async function getMessages({ res, url, logger }) {
  const { settings } = await readSettings(logger);
  const before = Number.parseInt(url.searchParams.get('before') ?? '', 10);
  const limit = Number.parseInt(url.searchParams.get('limit') ?? '', 10);
  const result = listMessages(settings.store.dir, {
    before: Number.isInteger(before) ? before : null,
    limit: Number.isInteger(limit) ? limit : DEFAULT_PAGE_SIZE,
  });
  if (result.ok !== true) {
    // 存储不可用也回 200 + error 字段：界面显示一行提示，而不是整个炸掉
    sendJson(res, 200, {
      messages: [],
      dir: result.dir,
      storeId: '',
      fallback: result.fallback,
      reason: result.reason,
      error: result.error,
    });
    return;
  }
  sendJson(res, 200, {
    messages: result.value,
    dir: result.dir,
    storeId: result.storeId,
    fallback: result.fallback,
    reason: result.reason,
  });
}

/**
 * DELETE /messages/:id —— 硬删一条消息。
 * @param {object} ctx - `{res, url, logger}`。
 * @returns {Promise<void>} 完成。
 */
async function deleteMessageRoute({ res, url, logger }) {
  const id = Number.parseInt(url.pathname.slice(`${API_PREFIX}/messages/`.length), 10);
  if (!Number.isInteger(id) || id <= 0) {
    sendJson(res, 400, { error: 'bad-id', message: '消息 id 不合法' });
    return;
  }
  const { settings } = await readSettings(logger);
  const result = deleteMessage(settings.store.dir, id);
  if (result.ok !== true) {
    sendJson(res, 200, { ok: false, deleted: 0, error: result.error, reason: result.reason });
    return;
  }
  sendJson(res, 200, { ok: true, deleted: result.value, storeId: result.storeId });
}

/**
 * GET /memory —— 记忆库状态。
 *
 * 只是给人看的两个数：**已建成几条**、**还有几条消息在排队**（倒计时没到 / 抽取失败重试）。
 * 存储不可用也回 200，界面显示一行提示而不是整个炸掉。
 *
 * @param {object} ctx - `{res, logger}`。
 * @returns {Promise<void>} 完成。
 */
async function getMemory({ res, logger }) {
  const { settings } = await readSettings(logger);
  const stats = memoryStats(settings.store.dir);
  const growth = readGrowth(settings.store.dir);
  sendJson(res, 200, {
    ok: typeof stats.error === 'string' ? false : true,
    dir: stats.dir,
    memories: stats.memories,
    pending: stats.pending,
    delayMinutes: settings.memory.delayMinutes,
    recentMessages: settings.memory.recentMessages,
    growth: {
      enabled: settings.growth.enabled,
      exists: growth.exists,
      entries: growth.entries.length,
      updatedAt: growth.updatedAt,
      path: growth.path,
    },
    error: typeof stats.error === 'string' ? stats.error : null,
    reason: typeof stats.reason === 'string' ? stats.reason : '',
  });
}

/**
 * GET /memory/search?q=…&limit=… —— 记忆检索自检（只读，不改任何数据）。
 *
 * 走的**就是聊天时那条检索链路**：`models.embed` 是 `keyword-bm25` 就走 BM25，
 * 否则照常调向量端点。用来确认"换成关键词模式以后还能不能取回旧记忆"，
 * 也方便在没有模型服务时排查。
 *
 * @param {object} ctx - `{res, url, logger}`。
 * @returns {Promise<void>} 完成。
 */
async function getMemorySearch({ res, url, logger }) {
  const query = (url.searchParams.get('q') ?? '').trim();
  if (query === '') {
    sendJson(res, 400, { error: 'bad-query', message: '缺少 q 参数（要检索的那句话）' });
    return;
  }
  const limit = Number.parseInt(url.searchParams.get('limit') ?? '', 10);
  const { settings } = await readSettings(logger);
  const mode = isKeywordEmbedding(settings.models.embed) === true ? 'keyword' : 'vector';
  const hits = await retrieveMemories(logger, settings, query, null, {
    topK: Number.isInteger(limit) ? limit : undefined,
  });
  sendJson(res, 200, { ok: true, mode, query, count: hits.length, hits });
}

/**
 * GET /window —— 前台窗口监测的现场。
 *
 * 现在只做检测：这里把「当前是谁在前台」「最近几次变化（含同一窗口换标题）」
 * 和监测器自身的状态（助手进程在不在、重启过几次、最后一次错误）一起回给调用方。
 * 变化记录只在内存里，不落库。
 *
 * @param {object} ctx - `{res, windowWatch}`。
 * @returns {Promise<void>} 完成。
 */
async function getWindow({ res, windowWatch, focusWatcher }) {
  if (windowWatch === undefined) {
    sendJson(res, 200, { ok: false, supported: false, error: 'window-watch-unavailable', current: null, changes: [] });
    return;
  }
  const status = windowWatch.status();
  sendJson(res, 200, {
    ok: true,
    supported: status.supported,
    intervalMs: status.intervalMs,
    running: status.running,
    helperPid: status.helperPid,
    restarts: status.restarts,
    lastError: status.lastError,
    changes: status.changes, // 累计变化次数
    current: windowWatch.current(),
    history: windowWatch.history(20), // 最近 20 次变化
    // 专注模式的状态：现在算不算摸鱼、上次开口是什么时候（自检脚本靠它等间隔）
    focus: focusWatcher === undefined ? null : focusWatcher.state(),
  });
}

/**
 * GET /events —— 长连接（SSE）。现在只推一种事件：`say`（它主动开口）。
 *
 * 这条连接**不返回 JSON**，所以不走 sendJson；连接一关就把自己注销掉。
 *
 * @param {object} ctx - `{res, events}`。
 * @returns {Promise<void>} 完成（连接期间一直挂着）。
 */
async function getEvents({ res, events }) {
  if (events === undefined) {
    sendJson(res, 200, { ok: false, error: 'events-unavailable' });
    return;
  }
  const remove = events.add(res);
  res.on('close', remove);
}

/**
 * POST /store/clear —— 清空历史数据：消息 + 记忆。
 *
 * 界面上的「清空历史数据」按钮走这里。人格与成长日记在文件里，各有各的删法，这里不碰。
 *
 * @param {object} ctx - `{res, logger}`。
 * @returns {Promise<void>} 完成。
 */
async function clearStore({ res, logger }) {
  const { settings } = await readSettings(logger);
  const result = clearHistory(settings.store.dir);
  if (result.ok !== true) {
    sendJson(res, 200, { ok: false, messages: 0, memories: 0, screenMemories: 0, windowEvents: 0, error: result.error, reason: result.reason });
    return;
  }
  logger.warn?.(`chat-widget: 清空历史数据（消息 ${result.value.messages} 条、记忆 ${result.value.memories} 条、屏幕记忆 ${result.value.screenMemories} 条、窗口记录 ${result.value.windowEvents} 条）`);
  sendJson(res, 200, {
    ok: true,
    messages: result.value.messages,
    memories: result.value.memories,
    screenMemories: result.value.screenMemories,
    windowEvents: result.value.windowEvents,
    dir: result.dir,
    storeId: result.storeId,
  });
}

/**
 * 语音识别服务的现场（**跟陪看开没开无关**：界面要在拨开关之前就知道识别器有没有）。
 *
 * 服务是 DSH 自带的 `speechToText`（SenseVoice）。它没装/被禁用时这里回 `available:false`，
 * 界面据此把「音轨识别」开关置灰；`phase` 是模型的就绪阶段（`unprepared`/`downloading`/`loading`/`ready`/…）。
 *
 * @param {Function} [getSpeechToText] - 惰性取服务的函数。
 * @returns {{available: boolean, reason: string, phase: string, providerId: string, provider: string, languages: string[]}} 现场。
 */
function speechServiceInfo(getSpeechToText) {
  try {
    const service = typeof getSpeechToText === 'function' ? getSpeechToText() : null;
    if (service === null || service === undefined) {
      return { available: false, reason: 'no-service', phase: '', providerId: '', provider: '', languages: [] };
    }
    const snapshot = service.snapshot();
    const providers = Array.isArray(snapshot?.providers) ? snapshot.providers : [];
    const wanted = String(snapshot?.selection?.providerId ?? '');
    const found = providers.find((item) => item.id === wanted) ?? providers[0] ?? null;
    const phase = String(found?.preparation?.phase ?? 'unprepared');
    const languages = Array.isArray(found?.languages) ? found.languages.map((one) => String(one)) : [];
    return {
      // `standby` = 资源校验过、工作进程还没唤醒（第一次用才加载）—— 对调用方来说就是"可用"
      available: phase === 'ready' || phase === 'waking' || phase === 'standby',
      reason: '',
      phase,
      providerId: String(found?.id ?? wanted),
      provider: String(found?.name ?? ''),
      languages,
    };
  } catch (error) {
    return { available: false, reason: String(error), phase: '', providerId: '', provider: '', languages: [] };
  }
}

/**
 * GET /screen/status —— 陪看状态（界面状态行用）。
 * @param {object} ctx - `{res, logger, companion, getSpeechToText}`。
 * @returns {Promise<void>} 完成。
 */
/**
 * POST /screen/ocr-engine —— 点 OCR 滑块时**当场编译**一次，告诉界面能不能开。
 *
 * 用户定的交互（2026-11-05）：
 *   - 点滑块 → 编译；没 SDK → 滑块**不打开**，旁边红字 +【下载】；
 *   - 再点一次 → 再编译一次（装完 SDK 就不用重启）；
 *   - 编译成功 → 滑块正常打开。
 *
 * 编译产物落在数据目录（`~/.dsh/chat-widget/native/`），约 0.5 秒。
 *
 * @param {object} ctx - `{res, logger}`。
 * @returns {Promise<void>} 完成。
 */
async function postOcrEngine({ res, logger }) {
  const built = ensureEngine({ target: 'capture', wantOcr: true, logger });
  // `ensureEngine` 没 SDK 时会**退成无 OCR 版**并返回 `ok:true, ocr:'missing-sdk'`，
  // 所以必须把 `ocr !== 'ok'` 也算失败，否则界面会把"没 OCR 的引擎"当成编译成功。
  sendJson(res, 200, built.ok === true && built.ocr === 'ok'
    ? { ok: true, ocr: 'ok', exe: built.exe }
    : { ok: false, ocr: built.ocr, error: String(built.error ?? '') });
}

/**
 * POST /screen/ocr-winmd —— 点【下载】时拉 WinRT 契约包（不装 Windows SDK）。
 *
 * 用 NuGet 的 `Microsoft.Windows.SDK.Contracts`（3.6 MB、96 个 winmd），
 * 下载约 5 秒、解压到数据目录、**不提权**。装好顺手编一次 OCR 引擎。
 *
 * @param {object} ctx - `{res, logger}`。
 * @returns {Promise<void>} 完成。
 */
async function postOcrWinmd({ res, logger }) {
  const fetched = await fetchWinmds(logger);
  if (fetched.ok !== true) {
    sendJson(res, 200, { ok: false, stage: 'download', error: String(fetched.error ?? '') });
    return;
  }
  const built = ensureEngine({ target: 'capture', wantOcr: true, logger });
  sendJson(res, 200, built.ok === true && built.ocr === 'ok'
    ? { ok: true, count: fetched.count, exe: built.exe }
    : { ok: false, stage: 'compile', ocr: built.ocr, error: String(built.error ?? '') });
}

/**
 * POST /screen/ocr-guide —— 打开 Windows 的「语言和区域」设置页（添加语言那一步）。
 *
 * 缺某门语言的 OCR 语言包时，界面那个【安装】按钮走这里：**插件不再自己装**
 * （原来提权跑 `Add-WindowsCapability`，实测六分钟以上装不完，界面只能干转圈）。
 * 微软没给 OCR 语言包单独的下载页 —— 它属于"语言功能"，
 * 只能在 设置 → 时间和语言 → 语言 → 添加语言 → 该语言 → 选项 → 光学字符识别 里勾。
 *
 * @param {object} ctx - `{res, logger}`。
 * @returns {Promise<void>} 完成。
 */
async function postOcrGuide({ res, logger }) {
  try {
    const { spawn } = await import('node:child_process');
    // `start` 需要一个窗口标题占位（空串），否则会把 URI 当成标题
    spawn('cmd.exe', ['/c', 'start', '', 'ms-settings:regionlanguage'], {
      windowsHide: true,
      detached: true,
      stdio: 'ignore',
    }).unref();
    sendJson(res, 200, { ok: true, opened: 'ms-settings:regionlanguage' });
  } catch (error) {
    logger?.warn?.(`chat-widget: 打开语言设置页失败：${String(error)}`);
    sendJson(res, 200, { ok: false, error: String(error) });
  }
}

/**
 * @param {object} ctx - `{res, logger, companion, getSpeechToText}`。
 * @returns {Promise<void>} 完成。
 */
async function getScreenStatus({ res, logger, companion, getSpeechToText }) {
  const { settings } = await readSettings(logger);
  const stats = screenStats(settings.store.dir);
  // 本机装了哪些 OCR 语言（引擎跑着时是缓存；没跑就扫一次，约 0.6 秒）——界面判断"无此语言包"要用
  const languages = ocrLanguages(logger);
  sendJson(res, 200, {
    ok: true,
    dir: stats.dir,
    raw: stats.raw,
    summaries: stats.summaries,
    uncompressed: stats.uncompressed,
    today: stats.today,
    frames: stats.frames,
    error: stats.error ?? null,
    ocr: { langs: languages.langs, at: languages.at },
    // 原生引擎的编译条件：`sdk=false` 时 OCR 编不出来，界面据此显示红字 +【下载】
    native: nativeStatus(),
    // 音轨识别的识别器现场（开关拨得动拨不动看它）
    speechService: speechServiceInfo(getSpeechToText),
    companion: companion === undefined ? null : companion.status(),
  });
}

/** 装 OCR 语言包的结果文件（提升权限的子进程写、这里读）。 */
const OCR_INSTALL_FILE = 'dshcw-ocr-install.json';

/** 三个临时文件：装包脚本（提升后跑）/ 启动器（非提升，它才继承得到环境变量）/ 启动器日志。 */
const OCR_INSTALL_SCRIPT = 'dshcw-ocr-install.ps1';
const OCR_LAUNCH_SCRIPT = 'dshcw-ocr-launch.ps1';
const OCR_LAUNCH_LOG = 'dshcw-ocr-install.log';

/** 一个值写成 PowerShell 单引号字面量（单引号翻倍转义）。 */
function psLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/** 启动器多久没回话就判定"没起来"（毫秒）。正常提升+查询实测约 6~20 秒，所以给得宽一点，只兜"全死"。 */
const OCR_LAUNCH_WATCHDOG_MS = 30_000;

/**
 * 起启动器的 spawn 选项 —— **单独抽出来是为了能被自检直接拿去用**（这个坑就是这组选项造成的）。
 *
 * **绝不能带 `detached: true`**。实测（本机 Win10/11 + PowerShell 5.1，2026-10-24）四种组合：
 *
 * | 选项 | 结果 |
 * |---|---|
 * | `detached` + `stdio:'ignore'` + `windowsHide` | **死**：拿到了 pid，但脚本**一行都没跑** |
 * | `detached` + `stdio:'ignore'` | **死** |
 * | `detached` + 管道 stdio + `windowsHide` | **死** |
 * | **不带 detached** + `stdio:'ignore'` + `windowsHide` | **活**（日志和状态文件都写了） |
 *
 * 而且**不报错**：`error` 事件不发、退出码看不到、stdout/stderr 都没有（`stdio:'ignore'` 反正也看不到）——
 * 表现就是"点了按钮，什么都没发生"。`detached` 在 Windows 上给的是 `DETACHED_PROCESS`（无控制台），
 * powershell.exe 这种控制台程序在里面**起来就退**。（`explorer.exe` 那种 GUI 程序 detached 没事，
 * `host/routes.js` 里打开文件夹那处照旧用它。）
 *
 * @param {object} env - 子进程环境变量。
 * @returns {object} spawn 选项。
 */
export function ocrLaunchSpawnOptions(env) {
  return { env, stdio: 'ignore', windowsHide: true };
}

/** 把一条状态写进结果文件（界面每 2 秒读它）。`at` 是给"兜底看门狗"对时间的（不给就是现在）。 */
function writeInstallState(tag, state, message, at) {
  try {
    const stamp = Number.isFinite(at) && at >= 0 ? at : Date.now();
    writeFileSync(join(tmpdir(), OCR_INSTALL_FILE), JSON.stringify({ tag, state, message, at: stamp }), 'utf8');
  } catch {
    // 结果文件写不进去也没别的办法了（界面会按"超时没人应"处理）
  }
}

/**
 * 装语言包的脚本 —— **提升权限那一跳真正跑的就是它**（ASCII-only）。
 *
 * 参数是**内嵌成字面量**的，不走环境变量。原因（实测）：UAC 提升出来的进程拿到的是**新造的
 * 环境块**（从用户配置重建），调用方设的 `DSHCW_OCR_*` 在里面**全是空的** ——
 * 装包脚本里 `$env:DSHCW_OCR_RESULT` 为空 → `WriteAllText('')` 当场抛错 → 脚本静默死掉 →
 * 结果文件永远停在 `starting` → 界面永远卡在"等待 UAC 授权"（就是这个 bug）。
 *
 * 另一条（实测，2026-10-24 提升权限探过）：`Get-WindowsCapability`/`Add-WindowsCapability` 对着
 * **不存在的**功能名**既不报错也不返回 $null** —— 它们给你一个 `Name` 为**空串**、`State=NotPresent`
 * 的空壳对象，`Add` 那个甚至 `RestartNeeded=False`，看着跟成功一模一样，实际什么也没干。
 * 所以：`$cap.Name` 为空 = 没这个名字；装完必须**复查** `State -eq 'Installed'` 才算数。
 */
const OCR_INSTALL_PS1 = String.raw`
$ErrorActionPreference = 'Continue'
$Tag = __TAG__
$Result = __RESULT__
function Write-State([string]$state, [string]$message) {
  $payload = [ordered]@{ tag = $Tag; state = $state; message = $message; at = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }
  [System.IO.File]::WriteAllText($Result, ($payload | ConvertTo-Json -Compress), [System.Text.UTF8Encoding]::new($false))
}
try {
  if ([string]::IsNullOrEmpty($Result)) { throw 'no result path' }
  Write-State 'running' 'installing'
  $name = 'Language.OCR~~~' + $Tag + '~0.0.1.0'
  $cap = Get-WindowsCapability -Online -Name $name -ErrorAction Stop
  if ($cap -eq $null -or [string]$cap.Name -eq '') { throw ('no such capability: ' + $name) }
  if ($cap.State -eq 'Installed') {
    Write-State 'done' 'already-installed'
  } else {
    $res = Add-WindowsCapability -Online -Name $name -ErrorAction Stop
    $restart = $false
    if ($res -ne $null) { $restart = ($res.RestartNeeded -eq $true) }
    $after = Get-WindowsCapability -Online -Name $name -ErrorAction Stop
    if ($after -ne $null -and $after.State -eq 'Installed') {
      if ($restart) { Write-State 'done' 'installed-restart-needed' } else { Write-State 'done' 'installed' }
    } elseif ($restart) {
      Write-State 'done' 'installed-restart-needed'
    } else {
      throw ('install did not take effect: ' + $name + ' state=' + [string]$after.State)
    }
  }
} catch {
  try { Write-State 'failed' $_.Exception.Message } catch { }
}
`;

/**
 * 生成装包脚本（把 capability 名和结果文件路径**内嵌**进去）。
 *
 * 纯 ASCII 就不带 BOM（PS 5.1 对 BOM-less 文件按 ANSI 读）；万一内嵌的路径带非 ASCII，
 * **必须带 BOM** 写，否则 5.1 会把路径读烂。
 *
 * @param {string} capability - capability 名中间那节（`zh-TW`、`ja-JP`）。
 * @param {string} resultPath - 结果文件绝对路径。
 * @returns {string} 脚本内容（可能带 BOM）。
 */
export function buildOcrInstallScript(capability, resultPath) {
  const inner = OCR_INSTALL_PS1.replace('__TAG__', psLiteral(capability)).replace('__RESULT__', psLiteral(resultPath));
  return (/^[\x00-\x7f]*$/.test(inner) ? '' : '\uFEFF') + inner;
}

/**
 * 启动器 —— **非提升**那一跳跑它（它才继承得到宿主设的环境变量），由它去 `-Verb RunAs` 拉装包脚本。
 *
 * 它的活是"把失败也说清楚"：用户点了「否」、或者提升出来的脚本压根没跑起来（比如被安全软件拦了），
 * 都必须在结果文件里留一条 `failed` —— 否则界面就又回到"永远等待授权"。
 */
export const OCR_LAUNCH_PS1 = String.raw`
$ErrorActionPreference = 'Continue'
$script = [string]$env:DSHCW_OCR_SCRIPT
$result = [string]$env:DSHCW_OCR_RESULT
$log = [string]$env:DSHCW_OCR_LOG
$tag = [string]$env:DSHCW_OCR_TAG
function Log([string]$message) {
  try { Add-Content -Path $log -Value ((Get-Date).ToString('o') + ' ' + $message) -Encoding UTF8 } catch { }
}
function Current-State() {
  try {
    $raw = [System.IO.File]::ReadAllText($result)
    if ([string]::IsNullOrWhiteSpace($raw)) { return '' }
    return [string](ConvertFrom-Json $raw).state
  } catch { return '' }
}
function Write-State([string]$state, [string]$message) {
  try {
    $payload = [ordered]@{ tag = $tag; state = $state; message = $message; at = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }
    [System.IO.File]::WriteAllText($result, ($payload | ConvertTo-Json -Compress), [System.Text.UTF8Encoding]::new($false))
  } catch { }
}
Log ('launch tag=' + $tag)
try {
  $p = Start-Process -FilePath powershell.exe -Verb RunAs -PassThru -Wait -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File', $script)
  $code = [int]$p.ExitCode
  $state = Current-State
  Log ('elevated exit=' + [string]$code + ' state=' + $state)
  if ($state -ne 'done' -and $state -ne 'failed') {
    if ($state -eq 'starting') { Write-State 'failed' 'elevated-did-not-start' }
    elseif ($state -eq 'running') { Write-State 'failed' 'elevated-did-not-finish' }
    else { Write-State 'failed' ('elevated-exit-' + [string]$code) }
  }
} catch {
  $msg = $_.Exception.Message
  $hr = 0
  try { $hr = [int]$_.Exception.HResult } catch { $hr = 0 }
  Log ('start failed hr=' + [string]$hr + ' msg=' + $msg)
  if ($hr -eq -2147023673) { Write-State 'failed' 'uac-cancelled' } else { Write-State 'failed' $msg }
}
`;

/** 已经处理过的那次安装（同一份结果只触发一次"重扫 + 重启引擎"）。 */
let handledInstall = '';

/**
 * GET /screen/ocr-language —— 语言列表 + 安装进度（界面点完【安装】后轮询它）。
 * @param {object} ctx - `{res, logger, companion}`。
 * @returns {Promise<void>} 完成。
 */
async function getOcrLanguage({ res, logger, companion }) {
  let install = null;
  try {
    const raw = readFileSync(join(tmpdir(), OCR_INSTALL_FILE), 'utf8');
    const parsed = JSON.parse(String(raw).replace(/^\uFEFF/, ''));
    if (parsed !== null && typeof parsed === 'object') install = parsed;
  } catch {
    install = null;
  }
  const key = install === null ? '' : `${String(install.tag)}:${String(install.at)}`;
  let refreshed = false;
  if (install !== null && install.state === 'done' && key !== handledInstall) {
    handledInstall = key;
    ocrLanguages(logger, { refresh: true });
    // 引擎是**启动时**建识别器的：装好语言包必须重启它才会开始用新语言
    if (companion !== undefined && companion !== null && typeof companion.refresh === 'function') companion.refresh();
    refreshed = true;
  }
  const languages = ocrLanguages(logger);
  sendJson(res, 200, { ok: true, install, refreshed, langs: languages.langs, at: languages.at });
}

/**
 * POST /screen/ocr-language —— 装一门 OCR 语言包（提升权限去装，装的过程要联网）。
 *
 * 只接受白名单里的语言；装包用的名字是 `capability`（`zh-TW` 这种），**不是**识别器 tag
 * （`zh-Hant-TW`）—— 详见 `settings.js` 的 `OCR_LANG_CHOICES`。
 *
 * @param {object} ctx - `{req, res, logger}`。
 * @returns {Promise<void>} 完成。
 */
async function postOcrLanguage({ req, res, logger }) {
  const body = await readJsonBody(req);
  const wanted = body !== null && typeof body === 'object' ? String(body.tag === undefined || body.tag === null ? '' : body.tag) : '';
  const choice = OCR_LANG_CHOICES.find((item) => item.value === wanted);
  const allowed = OCR_LANG_CHOICES.filter((item) => item.capability !== '').map((item) => item.value);
  if (choice === undefined || choice.capability === '') {
    sendJson(res, 200, { ok: false, error: 'bad-tag', allowed });
    return;
  }
  const capability = choice.capability;
  const scriptPath = join(tmpdir(), OCR_INSTALL_SCRIPT);
  const launchPath = join(tmpdir(), OCR_LAUNCH_SCRIPT);
  const resultPath = join(tmpdir(), OCR_INSTALL_FILE);
  const logPath = join(tmpdir(), OCR_LAUNCH_LOG);
  const stamp = Date.now();
  try {
    writeInstallState(wanted, 'starting', 'starting', stamp);
    const inner = buildOcrInstallScript(capability, resultPath);
    writeFileSync(scriptPath, inner, 'utf8');
    writeFileSync(launchPath, OCR_LAUNCH_PS1, 'utf8');
    const { spawn } = await import('node:child_process');
    const child = spawn('powershell.exe', ['-NoProfile', '-NoLogo', '-ExecutionPolicy', 'Bypass', '-File', launchPath], ocrLaunchSpawnOptions({
      ...process.env,
      DSHCW_OCR_SCRIPT: scriptPath,
      DSHCW_OCR_TAG: capability,
      DSHCW_OCR_RESULT: resultPath,
      DSHCW_OCR_LOG: logPath,
    }));
    // 没有 error 监听者时子进程起不来会**把宿主整个掀掉**，所以必须接住
    child.on('error', (error) => {
      logger.warn?.(`chat-widget: OCR 语言包启动器起不来: ${String(error)}`);
      writeInstallState(wanted, 'failed', `launcher-spawn-failed: ${String(error)}`);
    });
    child.unref();
    // **兜底**：启动器要是连第一行都没跑到（进程被系统/安全软件吃掉、powershell 不在 PATH……），
    // 结果文件就永远停在 starting、界面永远转圈。定时器到点还是这一份 starting 就判它没起来。
    const watchdog = setTimeout(() => {
      try {
        const raw = readFileSync(resultPath, 'utf8');
        const parsed = JSON.parse(String(raw).replace(/^\uFEFF/, ''));
        if (parsed.state === 'starting' && parsed.at === stamp) {
          writeInstallState(wanted, 'failed', 'launcher-did-not-start');
          logger.warn?.(`chat-widget: OCR 语言包装包启动器没回话，判定没起来（${wanted}）`);
        }
      } catch {
        // 读不到就等界面那边的兜底（它也有"一直停在 starting"的判定）
      }
    }, OCR_LAUNCH_WATCHDOG_MS);
    watchdog.unref?.();
    logger.info?.(`chat-widget: 开始装 OCR 语言包 ${wanted}（capability ${capability}，提升权限）`);
    sendJson(res, 200, { ok: true, started: true, tag: wanted, capability });
  } catch (error) {
    writeInstallState(wanted, 'failed', String(error));
    logger.warn?.(`chat-widget: 启动 OCR 语言包安装失败: ${String(error)}`);
    sendJson(res, 200, { ok: false, error: String(error) });
  }
}

/**
 * GET /pet/status —— 桌宠现场（外壳在不在跑、pid、窗口矩形、运行时错误）。
 *
 * @param {object} ctx - `{res, pet}`。
 * @returns {Promise<void>} 完成。
 */
async function getPetStatus({ res, pet }) {
  // 模型清单跟着现场一起给：设置面板第一行的方框直接用它渲染，
  // 文件夹删了/加了下次读就变，不用另开一个端点。
  const models = listModels();
  sendJson(res, 200, {
    ok: true,
    pet: pet === undefined || pet === null || typeof pet.status !== 'function'
      ? { enabled: false, models }
      : { ...pet.status(), models },
  });
}

/**
 * GET /pet/config —— 桌宠页面**轮询**的实时配置（绿幕 / 缩放 / TTS 三个旋钮）。
 *
 * 为什么要有这个端点：页面只在启动时通过 IPC 读一次状态，而「桌宠」标签里的旋钮是
 * **拨到哪就立刻写设置**的 —— 不轮询的话，改完要重启桌宠才看得见（用户明确要求实时）。
 * 本机回环、每 2 秒一次、返回几十字节，代价可以忽略。
 *
 * @param {object} ctx - `{res, logger}`。
 * @returns {Promise<void>} 完成。
 */
async function getPetConfig({ res, logger, petPreview }) {
  try {
    const result = await readSettings(logger);
    const pet = result.settings.pet;
    const preview = petPreview !== undefined && petPreview !== null ? petPreview : { editMode: false, modelScale: null };
    // 模型：存的文件夹被删了（或换了台电脑）就退回第一个，别让页面去加载一个不存在的路径
    const models = listModels();
    const model = resolveModel(pet.model, models);
    sendJson(res, 200, {
      ok: true,
      config: {
        // 绿幕**只认预览值**：它是"当场调一下"的状态，永远不进设置，重启后自然是关的
        editMode: preview.editMode === true,
        // 缩放优先用预览值（拖滑块时即时生效），没有覆盖才用设置里的
        // 注意：`Number(null) === 0` 且 `isFinite(0)` 为真，所以必须先判 null/undefined，否则清掉预览后会变成 0 倍
        modelScale: preview.modelScale === null || preview.modelScale === undefined || Number.isFinite(Number(preview.modelScale)) !== true
          ? pet.modelScale
          : Number(preview.modelScale),
        /** 当前该用哪个模型（= 文件夹名）；页面靠它判断要不要换模型。 */
        model,
        /** 现有模型清单（换模型时不用再请求一次）。 */
        models,
        tts: pet.tts === true,
        ttsSpeed: pet.ttsSpeed,
        ttsModel: pet.ttsModel,
        ttsVoice: pet.ttsVoice,
        ttsPitch: pet.ttsPitch,
        ttsVolume: pet.ttsVolume,
        bubblePosition: preview.bubblePosition === 'bottom' || preview.bubblePosition === 'top'
          ? preview.bubblePosition
          : pet.bubblePosition,
        alwaysOnTop: pet.alwaysOnTop === true,
      },
    });
  } catch (error) {
    sendJson(res, 200, { ok: false, error: String(error) });
  }
}

/**
 * GET /pet/voices —— TTS 音色清单（kokoro 有 103 个）+ 当前模型装没装。
 *
 * 界面拿它渲染「音色」下拉框；没装模型时 `installed=false`，下拉框置灰。
 *
 * @param {object} ctx - `{res, logger, tts}`。
 * @returns {Promise<void>} 完成。
 */
async function getPetVoices({ res, tts }) {
  if (tts === undefined || tts === null || typeof tts.status !== 'function') {
    sendJson(res, 200, { ok: false, error: 'tts-unavailable', models: {} });
    return;
  }
  try {
    // 每个模型都报：装没装、多大、有哪些音色（界面按当前选的模型取对应那份）
    const models = {};
    // edge 是远程提供者：音色要联网取（带 1 小时缓存；取不到退回上次结果，不报错）
    const { getEdgeVoicesCached } = await import('./tts-edge.js');
    const edgeVoices = await getEdgeVoicesCached();
    for (const key of ['edge', 'melo']) {
      const st = tts.status(key);
      models[key] = {
        installed: st.installed === true,
        bytes: st.bytes,
        voiceKind: st.voiceKind,
        voices: key === 'edge' ? edgeVoices : st.voices,
      };
    }
    // 本地引擎（sherpa-onnx-node）在不在：界面据此在「下载」旁提示需开启语音输入插件
    const engine = typeof tts.localEngine === 'function' ? tts.localEngine() : null;
    sendJson(res, 200, { ok: true, models, localEngine: engine });
  } catch (error) {
    sendJson(res, 200, { ok: false, error: String(error), models: {} });
  }
}
/**
 * POST /pet/preview —— 绿幕 / 缩放的**即时预览**（不写设置、不入库）。
 *
 * 用户定的规矩：「桌宠」标签里的调节要**点保存**才算数，但**试听和绿幕要立刻看到效果**。
 * 所以这两样走内存里的预览覆盖值：`GET /pet/config` 优先读它，保存或关掉弹窗时清掉。
 *
 * body：`{ editMode?: boolean, modelScale?: number|null }`
 *   - `modelScale: null` = 取消覆盖，回到设置里的值。
 *
 * @param {object} ctx - `{req, res, logger, petPreview}`。
 * @returns {Promise<void>} 完成。
 */
async function postPetPreview({ req, res, petPreview }) {
  const body = await readJsonBody(req);
  if (petPreview === undefined || petPreview === null) {
    sendJson(res, 200, { ok: false, error: 'preview-unavailable' });
    return;
  }
  if (body !== null && typeof body === 'object' && body.editMode !== undefined) {
    petPreview.editMode = body.editMode === true;
  }
  if (body !== null && typeof body === 'object' && (body.bubblePosition === 'top' || body.bubblePosition === 'bottom')) {
    petPreview.bubblePosition = body.bubblePosition;
  } else if (body !== null && typeof body === 'object' && body.bubblePosition === null) {
    // null = 取消覆盖，回到设置里的值
    petPreview.bubblePosition = null;
  }
  if (body !== null && typeof body === 'object' && body.modelScale !== undefined) {
    const scale = Number(body.modelScale);
    petPreview.modelScale = body.modelScale === null || Number.isFinite(scale) !== true ? null : scale;
  }
  sendJson(res, 200, { ok: true, preview: { editMode: petPreview.editMode, modelScale: petPreview.modelScale } });
}

/**
 * POST /pet/control —— 桌宠控制（目前只有 `restart`：换外壳目录、运行时坏了之后手动拉一把）。
 *
 * @param {object} ctx - `{req, res, logger, pet}`。
 * @returns {Promise<void>} 完成。
 */
async function postPetControl({ req, res, logger, pet }) {
  const body = await readJsonBody(req);
  const action = body !== null && typeof body === 'object' ? String(body.action ?? '') : '';
  const allowed = ['restart'];
  if (allowed.includes(action) !== true) {
    sendJson(res, 200, { ok: false, error: 'bad-action', allowed });
    return;
  }
  const applied = pet !== undefined && pet !== null && typeof pet.control === 'function' ? pet.control(action) : false;
  logger.info?.(`chat-widget: 桌宠 ${action} → ${applied === true ? '已执行' : '没在执行'}`);
  sendJson(res, 200, { ok: true, action, applied });
}

/**
 * POST /pet/tts/install —— 装本地 TTS 模型（换电脑用时，缺模型的「下载」按钮走这里）。
 *
 * 立刻返回，下载/解压在后台跑；界面轮询 `/pet/voices` 看进度。
 *
 * @param {object} ctx - `{req, res, logger, tts}`。
 * @returns {Promise<void>} 完成。
 */
async function postPetTtsInstall({ req, res, logger, tts }) {
  const body = await readJsonBody(req);
  const model = body !== null && typeof body === 'object' ? String(body.model ?? '') : '';
  if (tts === undefined || tts === null || typeof tts.install !== 'function') {
    sendJson(res, 200, { ok: false, error: 'tts-unavailable' });
    return;
  }
  // 本地模型要靠 DSH「语音输入」插件带进来的 sherpa-onnx-node；没有就先拦住，
  // 别让用户白下 200 MB 再在合成时报错。
  const engine = typeof tts.localEngine === 'function' ? tts.localEngine() : null;
  if (engine !== null && engine.ok !== true) {
    sendJson(res, 200, { ok: false, reason: 'missing-sherpa', error: '本地模型需要 DSH 的「语音输入」插件提供运行时' });
    return;
  }
  const result = tts.install(model);
  logger.info?.(`chat-widget: TTS 模型安装请求（${model || '默认'}）→ ${result.ok === true ? '后台已开始' : String(result.error)}`);
  sendJson(res, 200, result);
}

/**
 * POST /pet/utter —— **已废弃**，只回一句说明。
 *
 * 以前聊天框靠它把"它的发言"转给桌宠，于是同一句话有两条广播（`utter` + `say`），
 * 桌宠两个都听 → 念两遍。现在出句只有一条路：`host/utterance.js` 落库后广播 `say`，
 * 桌宠直接听那个。这个端点留着是为了让老调用方拿到明确答复，而不是静默无效。
 *
 * @param {object} ctx - `{res}`。
 * @returns {Promise<void>} 完成。
 */
async function postPetUtter({ res }) {
  sendJson(res, 200, {
    ok: false,
    error: 'deprecated',
    message: '出句已统一：请让宿主走 host/utterance.js 的 emit()，它会落库并广播 say。',
  });
}

/**
 * POST /pet/tts —— 合成一句话给桌宠播（`{text, speed?}` → `audio/wav`）。
 *
 * TTS 引擎还没接进来时回 503 + 人话，页面据此只显示气泡、不出声。
 *
 * @param {object} ctx - `{req, res, logger, tts}`。
 * @returns {Promise<void>} 完成。
 */
async function postPetTts({ req, res, logger, tts }) {
  const body = await readJsonBody(req);
  const text = body !== null && typeof body === 'object' ? String(body.text ?? '').slice(0, 300) : '';
  if (text.trim() === '') {
    sendJson(res, 200, { ok: false, error: 'empty-text' });
    return;
  }
  if (tts === undefined || tts === null || typeof tts.synthesize !== 'function') {
    sendJson(res, 503, { ok: false, error: 'tts-unavailable', message: 'TTS 引擎还没接上' });
    return;
  }
  try {
    // 两种模式：
    //   1. **试听**（`body.preview === true`）：用界面**草稿**里的模型/音色/音调/语速/音量，
    //      这样用户不用先保存就能挨个听（保存才正式生效）。
    //   2. 正式播报：一律以**设置**为准（桌宠说话和试听走同一套音色）。
    const current = await readSettings(logger);
    const petSettings = current.settings.pet;
    const preview = body !== null && typeof body === 'object' && body.preview === true;
    const pick = (key, fallback) => (preview === true && body[key] !== undefined && body[key] !== null && body[key] !== ''
      ? body[key]
      : fallback);
    const result = await tts.synthesize(text, {
      speed: Number.isFinite(Number(pick('speed', petSettings.ttsSpeed))) ? Number(pick('speed', petSettings.ttsSpeed)) : petSettings.ttsSpeed,
      model: pick('model', petSettings.ttsModel),
      voice: String(pick('voice', petSettings.ttsVoice)),
      // 音调（半音）：MeloTTS 用「慢速合成 + 重采样」实现，见 host/tts.js 的 resampleForPitch
      pitch: Number.isFinite(Number(pick('pitch', petSettings.ttsPitch))) ? Number(pick('pitch', petSettings.ttsPitch)) : petSettings.ttsPitch,
      volume: Number.isFinite(Number(pick('volume', petSettings.ttsVolume))) ? Number(pick('volume', petSettings.ttsVolume)) : petSettings.ttsVolume,
    });
    if (result.ok !== true) {
      sendJson(res, 200, { ok: false, error: result.error ?? 'tts-failed' });
      return;
    }
    // 本地模型出 WAV，edge 出 MP3 —— 用合成结果自己报的 mime
    const mime = typeof result.mime === 'string' && result.mime !== '' ? result.mime : 'audio/wav';
    res.writeHead(200, { 'content-type': mime, 'content-length': String(result.wav.length), 'cache-control': 'no-store' });
    res.end(Buffer.from(result.wav));
  } catch (error) {
    logger.warn?.(`chat-widget: TTS 合成失败: ${String(error)}`);
    sendJson(res, 200, { ok: false, error: String(error) });
  }
}

/**
 * POST /screen/speech —— 音轨识别的**预留接口**：暂停 / 恢复。
 *
 * 给以后的桌宠 TTS 用：它开口说话时 `pause`，说完 `resume`。暂停只是把采集切到 `mute`
 * （设备不重启、一帧不留）+ 掐掉在途转写、清空队列，所以**我们自己的声音一个字都不会进参考**；
 * 恢复是立刻接着采，不用重新协商设备。
 *
 * @param {object} ctx - `{req, res, logger, companion}`。
 * @returns {Promise<void>} 完成。
 */
async function postScreenSpeech({ req, res, logger, companion }) {
  const body = await readJsonBody(req);
  const action = body !== null && typeof body === 'object' ? String(body.action ?? '') : '';
  const reason = body !== null && typeof body === 'object' && typeof body.reason === 'string' ? body.reason : '';
  if (action !== 'pause' && action !== 'resume') {
    sendJson(res, 200, { ok: false, error: 'bad-action', allowed: ['pause', 'resume'] });
    return;
  }
  const applied = companion !== undefined && companion !== null && typeof companion.speechControl === 'function'
    ? companion.speechControl(action, reason)
    : false;
  logger.info?.(`chat-widget: 音轨识别 ${action}（${reason === '' ? '外部请求' : reason}）→ ${applied === true ? '已执行' : '没在执行（陪看/音轨没开）'}`);
  const speech = companion === undefined || companion === null || typeof companion.status !== 'function'
    ? null
    : (companion.status().speech ?? null);
  sendJson(res, 200, { ok: true, action, applied, speech });
}

/**
 * POST /screen/compress —— 压缩按钮：把未压缩 raw 按「天 + 应用」折成摘要。
 * @param {object} ctx - `{req, res, logger}`。
 * @returns {Promise<void>} 完成。
 */
async function postScreenCompress({ res, logger }) {
  const { settings } = await readSettings(logger);
  try {
    const result = await compressScreenMemories(logger, settings);
    sendJson(res, 200, result);
  } catch (error) {
    logger.warn?.(`chat-widget: 压缩失败: ${String(error)}`);
    sendJson(res, 200, { ok: false, error: String(error) });
  }
}

/**
 * 截图文件夹的绝对路径（**一律反斜杠**）。
 *
 * `store.dir` 存进来是正斜杠（默认 `X:/AI_History`），拼出 `X:/AI_History\shots` 这种混合路径后，
 * `explorer.exe` 会把 `/AI_History\shots` 当开关解析，解析不了就**掉到「文档」**。
 * 实测对照（同一台机器、同一个文件夹，只换写法）：
 *   混合路径 `C:/…/dshcw-exp\shots` → 打开 `C:\Users\…\Documents`
 *   全反斜杠 `C:\…\dshcw-exp\shots` → 打开正确目录
 * @param {string} dir - 数据目录（可能带正斜杠、可能带尾斜杠）。
 * @returns {string} 截图目录（`…\shots`，全反斜杠）。
 */
export function revealTarget(dir) {
  return `${String(dir).replace(/[\\/]+$/, '')}\\shots`.replace(/\//g, '\\');
}

/**
 * POST /store/reveal —— 打开截图文件夹（手动清理帧图片用）。
 * @param {object} ctx - `{res, logger}`。
 * @returns {Promise<void>} 完成。
 */
async function postStoreReveal({ res, logger }) {
  const { settings } = await readSettings(logger);
  const target = revealTarget(settings.store.dir);
  try {
    // 目录不存在时 explorer.exe 一样会跑偏，所以先建出来（建了不亏）。
    mkdirSync(target, { recursive: true });
    const { spawn } = await import('node:child_process');
    spawn('explorer.exe', [target], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
    sendJson(res, 200, { ok: true, path: target });
  } catch (error) {
    logger.warn?.(`chat-widget: 打开文件夹失败: ${String(error)}`);
    sendJson(res, 200, { ok: false, path: target, error: String(error) });
  }
}

/**
 * POST /models —— 用请求体里的连接信息拉模型列表。
 *
 * 请求体没带密钥时回退到已保存的密钥：重开设置弹窗后前端拿不到已存密钥，
 * 没有这条回退「拉取」按钮就会永远失效。
 *
 * @param {object} ctx - `{req, res, logger}`。
 * @returns {Promise<void>} 完成。
 */
async function listModelsWithBody({ req, res, logger }) {
  let input;
  try {
    input = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { error: 'bad-json', message: '请求体不是合法 JSON' });
    return;
  }

  // 关键词模式没有端点也没有模型名：界面上相关输入框已经藏起来了，
  // 这里再挡一道，免得手写 curl 时拿到一个看不懂的 502。
  if (input !== null && typeof input === 'object' && input.provider === KEYWORD_EMBED_PROVIDER) {
    sendJson(res, 400, { error: 'keyword-mode', message: 'BM25 关键词模式不需要接口地址与模型列表' });
    return;
  }

  let effectiveKey = normalizeSecret(input.apiKey);
  if (effectiveKey === '') {
    const { settings } = await readSettings(logger);
    effectiveKey = resolveApiKey(settings.models.text).value;
  }

  try {
    sendJson(res, 200, await fetchProviderModels({ ...input, apiKey: effectiveKey }));
  } catch (error) {
    logger.warn(`chat-widget: 拉取模型列表失败: ${String(error)}`);
    sendJson(res, 502, { error: 'fetch-failed', message: String(error) });
  }
}

/**
 * GET /models?role=text —— 用已保存的设置拉模型列表。
 * @param {object} ctx - `{res, url, logger}`。
 * @returns {Promise<void>} 完成。
 */
async function listModelsFromSettings({ res, url, logger }) {
  const roleKey = url.searchParams.get('role') ?? 'text';
  if (roleKey !== 'text') {
    sendJson(res, 400, { error: 'bad-role', message: 'role 只能是 text' });
    return;
  }
  const { settings } = await readSettings(logger);
  const role = settings.models.text;
  try {
    sendJson(res, 200, await fetchProviderModels({
      provider: role.provider,
      baseUrl: role.baseUrl,
      apiKey: resolveApiKey(role).value,
    }));
  } catch (error) {
    sendJson(res, 502, { error: 'fetch-failed', message: String(error) });
  }
}

/** 路由表：`"<METHOD> <path>"` → 处理器。 */
const ROUTES = new Map([
  ['GET /health', health],
  ['GET /settings', getSettings],
  ['PUT /settings', putSettings],
  ['POST /settings', putSettings],
  ['GET /soul', getSoul],
  ['PUT /soul', putSoul],
  ['POST /soul', putSoul],
  ['GET /messages', getMessages],
  ['GET /memory', getMemory],
  ['GET /memory/search', getMemorySearch],
  ['GET /window', getWindow],
  ['GET /screen/status', getScreenStatus],
  ['GET /screen/ocr-language', getOcrLanguage],
  ['POST /screen/ocr-language', postOcrLanguage],
  ['POST /screen/ocr-engine', postOcrEngine],
  ['POST /screen/ocr-winmd', postOcrWinmd],
  ['POST /screen/ocr-guide', postOcrGuide],
  ['POST /screen/compress', postScreenCompress],
  ['POST /screen/speech', postScreenSpeech],
  ['GET /pet/status', getPetStatus],
  ['GET /pet/config', getPetConfig],
  ['GET /pet/voices', getPetVoices],
  ['POST /pet/preview', postPetPreview],
  ['POST /pet/control', postPetControl],
  ['GET /pet/events', getEvents],
  ['POST /pet/tts', postPetTts],
  ['POST /pet/tts/install', postPetTtsInstall],
  ['POST /pet/utter', postPetUtter],
  ['POST /store/reveal', postStoreReveal],
  ['POST /store/clear', clearStore],
  ['GET /events', getEvents],
  ['POST /chat', handleChat],
  ['POST /models', listModelsWithBody],
  ['PUT /models', listModelsWithBody],
  ['GET /models', listModelsFromSettings],
]);

/**
 * 造一个 `webServer.register` 能直接用的处理器。
 * @param {object} logger - 日志器。
 * @param {{windowWatch?: object, events?: object, focusWatcher?: object, companion?: object}} [services] - 后台服务（窗口监测、事件中心、专注模式、屏幕陪看）。
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>} 处理器。
 */
export function createRouter(logger, services = {}) {
  return async function handler(req, res) {
    const url = new URL(req.url ?? '/', 'http://x');
    const route = url.pathname.slice(API_PREFIX.length) || '/';
    const method = req.method ?? 'GET';

    // 浏览器信任栅栏：DSH 自己的 /api 有校验，我们挂在同一台服务器上但绕过了它。
    // 这里补一道最小防护——**带 Origin 且不是本机**的请求直接拒绝。
    // （不带 Origin 的是 curl / node 脚本，放行。）
    const origin = req.headers.origin;
    if (typeof origin === 'string' && origin !== '' && isLoopbackOrigin(origin) === false) {
      sendJson(res, 403, { error: 'forbidden-origin', message: '只接受本机来源的请求' });
      return;
    }

    // **先查路由表**（`/pet/status`、`/pet/tts` 这些是固定路由），查不到才当桌宠的静态文件。
    // 顺序不能反：反了的话 `/pet/status` 会被静态兜底当成"页面目录下叫 status 的文件"→ 404。
    const handler_ = ROUTES.get(`${method} ${route}`)
      ?? (method === 'DELETE' && route.startsWith('/messages/') ? deleteMessageRoute : undefined);
    if (handler_ === undefined) {
      // 桌宠的页面与资源：**前缀匹配**。页面走 `/pet/`、资源走 `/pet/assets/*`，
      // 页面里的相对路径 `assets/...`、`pet.js` 正好落在这两个前缀下。
      const isPetStatic = method === 'GET'
        && (route === '/pet/' || route === '/pet' || route.startsWith('/pet/assets/') || /^\/pet\/[\w.-]+$/.test(route));
      if (isPetStatic === true) {
        const { pageRoot, assetRoot } = petRoots();
        // **模型文件夹名是中文**，浏览器发过来是百分号编码的；不解码就找不到文件（404）。
        let decoded = route;
        try {
          decoded = decodeURIComponent(route);
        } catch {
          decoded = route;
        }
        const isAsset = decoded.startsWith('/pet/assets/');
        const result = isAsset
          ? readStatic(assetRoot, decoded.slice('/pet/assets/'.length))
          : readStatic(pageRoot, decoded === '/pet/' || decoded === '/pet' ? 'index.html' : decoded.slice('/pet/'.length));
        if (result.ok !== true) {
          sendJson(res, result.error === 'forbidden-path' ? 403 : 404, { error: result.error });
          return;
        }
        res.writeHead(200, { 'content-type': result.type, 'cache-control': 'no-store' });
        res.end(result.body);
        return;
      }
      sendJson(res, 404, { error: 'not-found', method, route });
      return;
    }

    try {
      await handler_({
        req, res, url, logger,
        windowWatch: services.windowWatch,
        events: services.events,
        focusWatcher: services.focusWatcher,
        companion: services.companion,
        getSpeechToText: services.getSpeechToText,
        pet: services.pet,
        petPreview: services.petPreview,
        beforeRead: services.beforeRead,
        tts: services.tts,
        // **必须传**：问答回复靠它落库 + 广播（唯一出句出口）。
        // 漏了它 `handleChat` 会走「只存不广播」的兜底 —— 聊天框有字、桌宠既没气泡也不出声。
        utterance: services.utterance,
      });
    } catch (error) {
      logger.warn(`chat-widget: 处理 ${method} ${route} 失败: ${String(error)}`);
      if (res.headersSent !== true) sendJson(res, 500, { error: 'internal', message: String(error) });
      else res.end();
    }
  };
}

/** 保留导出，便于将来核对默认模型。 */
export { MODEL_DEFAULT };
