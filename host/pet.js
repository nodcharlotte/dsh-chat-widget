/**
 * @local/chat-widget —— 桌宠窗口的宿主侧：起停外壳、发页面与资源、报状态。
 *
 * ## 运行时从哪来（**零下载**）
 *
 * 不 `npm i electron`（200 MB + 改 profile 依赖）。而是**借 DSH 桌面端自带的 Electron**：
 * 桌面端本身就是一个 Electron 应用（`DeepSeek Harness.exe` + `resources/app.asar`）。
 * 做法是把它目录里的**可执行文件与依赖硬链接**到一个运行时目录，`resources\` 里**只放
 * `default_app.asar`、不放 `app.asar`** —— 这样 exe 不会去加载 DSH 自己的 app，而是按
 * 命令行给的那个目录跑我们的 `pet/main.js`（实测 `electron 44.7.0 / chrome 152`）。
 *
 * **目录靠自动探测**（`detectShellDir`）：设置里 `pet.shellDir` 填了就以它为准，
 * 留空则按"当前进程 exe 目录 → `process.resourcesPath` 上一级 → 环境变量
 * `DSHCW_PET_SHELL` / `DSH_SHELL_DIR` → 安装器常见落点 → 扫一层 Programs"的顺序找，
 * 只认 exe 名、不认死路径，换台电脑/换个版本都不用改设置。找不到时把试过的目录
 * 一并报给界面，别让人干猜。
 *
 * 硬链接不能跨盘：外壳与插件同盘时零拷贝；跨盘会失败 → 退回复制 → 再失败就
 * 报"运行时不可用"（界面据此置灰开关并给指引）。
 *
 * ## 页面为什么由我们自己发
 *
 * 路由有一道来源栅栏（`host/routes.js`）：**带 Origin 且不是本机就 403**。`file://` 页面的 Origin
 * 是字符串 `"null"`，`isLoopbackOrigin("null")` 会抛错返回 false → 一律 403。让页面走
 * `http://127.0.0.1:<port>/chat-widget/api/pet/` 后 Origin 就是本机，**栅栏一个字都不用放宽**。
 *
 * @module @local/chat-widget/host/pet
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, linkSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, normalize, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 插件根目录（本文件在 host/ 下）。 */
const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** 桌宠目录。 */
export const PET_DIR = join(PLUGIN_ROOT, 'pet');

/**
 * 外壳可执行文件名。
 *
 * 桌面端的产品名就是它；换台电脑、换个安装位置，文件名不变，变的只是目录。
 * 所以**只认名字、不认路径** —— 目录交给 `detectShellDir()` 去猜。
 */
const SHELL_EXE = 'DeepSeek Harness.exe';

/** 借用运行时还需要它（没有它，exe 会去跑 DSH 自己的 app）。 */
const SHELL_REQUIRED = join('resources', 'default_app.asar');

/** 自动探测结果的缓存（配置留空时只探一次；`status()` 每 3 秒要问）。 */
let autoDetected = null;

/**
 * 一个目录里有没有外壳 exe。
 * @param {string} dir - 候选目录。
 * @returns {string} exe 的绝对路径；没有就空串。
 */
function shellExeIn(dir) {
  if (typeof dir !== 'string' || dir === '') return '';
  const exe = join(dir, SHELL_EXE);
  try {
    return existsSync(exe) ? exe : '';
  } catch {
    return '';
  }
}

/**
 * 一个目录能不能当"借运行时"的来源：既要有 exe，也要有 `resources/default_app.asar`。
 * @param {string} dir - 候选目录。
 * @returns {boolean} 可用为 true。
 */
function usableShellDir(dir) {
  return shellExeIn(dir) !== '' && existsSync(join(dir, SHELL_REQUIRED));
}

/**
 * 常见安装位置（按可信度排序）。
 *
 * 前两条最关键：**桌面端就运行在我们自己身上**，`process.execPath` / `process.resourcesPath`
 * 直接指向当前这份安装。后面几条只是"别的机器上一把就中"的兜底：
 * 旧版可能从安装器起在 `%LOCALAPPDATA%\Programs` 或 `%PROGRAMFILES%` 下，
 * 也可能被显式设置了环境变量。
 *
 * @returns {string[]} 候选目录（已去重、已剔空）。
 */
function candidateShellDirs() {
  const out = [];
  const seen = new Set();
  const push = (value) => {
    if (typeof value !== 'string' || value.trim() === '') return;
    const dir = value.trim().replace(/[\\/]+$/, '');
    if (dir === '') return;
    const key = dir.toLowerCase();
    if (seen.has(key) === true) return;
    seen.add(key);
    out.push(dir);
  };

  // ① 当前进程自己（桌面端跑在 Electron 主进程里时最准）
  try {
    push(dirname(process.execPath));
  } catch { /* 读不到就跳过 */ }
  // ② Electron 的 resourcesPath 的上一级 = 安装目录（打包后一定指得准）
  try {
    if (typeof process.resourcesPath === 'string') push(dirname(process.resourcesPath));
  } catch { /* 同上 */ }
  // ③ 插件目录往上几层：便携版/免安装版常把插件放在桌面端自己的安装目录里
  //    （`<安装目录>\dsh-chat-widget`），这样即使宿主不是 Electron 进程也认得出来。
  try {
    let dir = PLUGIN_ROOT;
    for (let depth = 0; depth < 4; depth += 1) {
      const parent = dirname(dir);
      if (parent === dir || parent === dirname(parent)) break;
      push(parent);
      dir = parent;
    }
  } catch { /* 读不到就跳过 */ }
  // ③b 便携版常见布局：**桌面端和插件放在同一个父目录下**
  //     （实测：桌面端在 `D:\AI\DSH`，插件在 `D:\AI\DeepSeek-Harness\dsh-chat-widget`）。
  //     扫一层爷爷目录的子目录，就能把 `D:\AI\DSH` 这类"不在安装器落点里"的位置捞出来，
  //     不用写死路径，换台电脑换个盘符也照样认。
  try {
    const checkoutRoot = dirname(PLUGIN_ROOT);
    const grand = dirname(checkoutRoot);
    for (const entry of readdirSync(grand, { withFileTypes: true })) {
      if (entry.isDirectory() === false) continue;
      push(join(grand, entry.name));
    }
  } catch { /* 读不到就跳过 */ }

  // ④ 显式环境变量（换个非标准安装位置时的手动兜底）
  push(process.env.DSHCW_PET_SHELL);
  push(process.env.DSH_SHELL_DIR);

  // ④ 安装器常见落点
  const env = process.env;
  const bases = [
    env.LOCALAPPDATA,
    env.ProgramW6432,
    env.PROGRAMFILES,
    env['PROGRAMFILES(X86)'],
    env.APPDATA === undefined ? '' : join(env.APPDATA, '..', 'Local'),
  ];
  for (const base of bases) {
    if (typeof base !== 'string' || base.trim() === '') continue;
    push(join(base, 'DeepSeek Harness'));
    push(join(base, 'Programs', 'DeepSeek Harness'));
  }

  // ⑤ 最后一招：扫一层 Programs，看哪个子目录里真有这个 exe（目录名可能带版本号/空格变体）
  for (const base of [env.LOCALAPPDATA, env.ProgramW6432, env.PROGRAMFILES]) {
    if (typeof base !== 'string' || base === '') continue;
    for (const parent of [join(base, 'Programs'), base]) {
      let entries = [];
      try {
        entries = readdirSync(parent, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (entry.isDirectory() === false) continue;
        push(join(parent, entry.name));
      }
    }
  }
  return out;
}

/**
 * 找外壳运行时目录。
 *
 * 优先级：设置里的 `pet.shellDir`（**显式值永远优先，哪怕它不可用** —— 不能偷偷换到别处）
 * → 自动探测 → 空（`dir === ''`，调用方据此报"找不到"）。
 *
 * @param {string} [configured] - 设置里的 `pet.shellDir`。
 * @returns {{dir: string, exe: string, source: 'settings'|'auto'|'none', tried: string[]}} 探测结果。
 */
export function detectShellDir(configured = '') {
  const explicit = typeof configured === 'string' ? configured.trim().replace(/[\\/]+$/, '') : '';
  if (explicit !== '') {
    return { dir: explicit, exe: shellExeIn(explicit), source: 'settings', tried: [explicit] };
  }
  if (autoDetected !== null) return autoDetected;
  const tried = [];
  for (const dir of candidateShellDirs()) {
    tried.push(dir);
    if (usableShellDir(dir) === false) continue;
    autoDetected = { dir, exe: shellExeIn(dir), source: 'auto', tried };
    return autoDetected;
  }
  autoDetected = { dir: '', exe: '', source: 'none', tried };
  return autoDetected;
}

/**
 * "找不到运行时"时给用户看的说明：把试过的目录列出来，别让人干猜。
 * @param {{tried?: string[]}} shell - 探测结果。
 * @returns {string} 说明文本。
 */
function shellMissingMessage(shell) {
  const tried = Array.isArray(shell?.tried) && shell.tried.length > 0
    ? shell.tried.slice(0, 6).join('、')
    : '（没有可探测的候选目录）';
  return `找不到外壳运行时（${SHELL_EXE}）：试过 ${tried}`;
}

/** 上次探测到的外壳目录（还没起过桌宠时，界面据此判断开关能不能拨）。 */
let detectedShell = detectShellDir('');

/** 截图引擎读的"打码矩形"请求文件（%TEMP%，和引擎脚本放一起）。 */
export function maskRequestPath() {
  return join(tmpdir(), 'dshcw-pet-mask.json');
}

/**
 * 把桌宠窗口位置写成**屏幕占比**矩形，交给我们自己的截图引擎涂掉。
 *
 * ## 为什么不用 `win.setContentProtection(true)`
 *
 * 那一个调的是 `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)`，**进程无关**：
 * 一开，PrtSc、QQ 截图、OBS、录屏全都拍不到桌宠。用户要的只是"陪看的截图别拍到自己"
 * （实测反馈：加了之后连 PrtSc 都没它了），所以改成**只污染我们这份拷贝**。
 *
 * ## 为什么存占比而不是像素
 *
 * Electron 的 `getBounds()` 是 DIP，截图引擎在 PowerShell 里拿的是它自己那套坐标，
 * 两边 DPI 感知可能不一致。存 0..1 的占比，引擎用**它自己的**屏幕宽高去乘，就不会错位。
 *
 * @param {object} status - `pet.status()` 的返回值。
 * @returns {string} 请求文件路径。
 */
export function writeMaskRequest(status) {
  const path = maskRequestPath();
  const state = status !== null && typeof status === 'object' ? status.state : null;
  const bounds = state !== null && typeof state === 'object' ? state.bounds : null;
  const display = state !== null && typeof state === 'object' ? state.display : null;
  const on = status !== null && typeof status === 'object' && status.enabled === true;
  const dw = display !== null && typeof display === 'object' ? Number(display.width) : 0;
  const dh = display !== null && typeof display === 'object' ? Number(display.height) : 0;
  let payload = '{}';
  if (on === true && bounds !== null && typeof bounds === 'object' && dw > 0 && dh > 0) {
    const clamp01 = (value) => Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
    const w = clamp01(Number(bounds.width) / dw);
    const h = clamp01(Number(bounds.height) / dh);
    // 太小就当没有（别为了 1px 的碎片去涂一大块）
    if (w > 0.005 && h > 0.005) {
      payload = JSON.stringify({
        x: clamp01(Number(bounds.x) / dw),
        y: clamp01(Number(bounds.y) / dh),
        w,
        h,
      });
    }
  }
  try {
    writeFileSync(path, payload, 'utf8');
  } catch {
    // 写不了就算了：引擎读到空/坏的会当"没有打码"，不影响陪看
  }
  return path;
}

/** 借运行时时要跳过的文件（这些是 DSH 自己的东西，带了反而会加载 DSH 的 app）。 */
const SKIP_FILES = new Set(['app-update.yml', 'Uninstall DeepSeek Harness.exe']);

/** 重启间隔：外壳意外退出后多久重拉。 */
const RESTART_MS = 3000;

/** 页面根（`/pet/` 映射到它）。 */
const PAGE_ROOT = join(PET_DIR, 'renderer');

/** 资源根（`/pet/assets/` 映射到它）。 */
const ASSET_ROOT = join(PET_DIR, 'assets');

/** 模型根：**每个模型一个以自己名字命名的文件夹**（`assets/live2d/<模型名>/…`）。 */
const MODEL_ROOT = join(ASSET_ROOT, 'live2d');

/** 允许发给桌宠页面的 MIME。 */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.moc3': 'application/octet-stream',
  '.model3.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.can3': 'application/octet-stream',
  '.cmo3': 'application/octet-stream',
};

/**
 * 按扩展名取 MIME。
 *
 * @param {string} file - 文件名。
 * @returns {string} MIME。
 */
function mimeOf(file) {
  const lower = file.toLowerCase();
  if (lower.endsWith('.model3.json')) return MIME['.model3.json'];
  const dot = lower.lastIndexOf('.');
  const ext = dot === -1 ? '' : lower.slice(dot);
  return MIME[ext] ?? 'application/octet-stream';
}

/**
 * 把 `urlPath` 安全地映射到 `root` 下的绝对路径（**挡住目录穿越**）。
 *
 * @param {string} root - 允许的根目录。
 * @param {string} urlPath - 请求里的路径（已 decode）。
 * @returns {string|null} 绝对路径；越界返回 null。
 */
export function safeJoin(root, urlPath) {
  const cleaned = String(urlPath ?? '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (cleaned.includes('..')) return null;
  const full = normalize(join(root, cleaned));
  const rel = relative(normalize(root), full);
  if (rel.startsWith('..') || rel.includes(':')) return null;
  return full;
}

/**
 * 读一个静态文件（给路由用）。
 *
 * @param {string} root - 根目录。
 * @param {string} urlPath - 请求路径。
 * @returns {{ok: true, body: Buffer, type: string} | {ok: false, error: string}} 结果。
 */
export function readStatic(root, urlPath) {
  const file = safeJoin(root, urlPath);
  if (file === null) return { ok: false, error: 'forbidden-path' };
  try {
    const stat = statSync(file);
    if (stat.isDirectory() === true) {
      const index = join(file, 'index.html');
      if (existsSync(index) === false) return { ok: false, error: 'not-found' };
      return { ok: true, body: readFileSync(index), type: MIME['.html'] };
    }
    return { ok: true, body: readFileSync(file), type: mimeOf(file) };
  } catch (error) {
    const code = error !== null && typeof error === 'object' ? error.code : '';
    return { ok: false, error: code === 'ENOENT' ? 'not-found' : String(error) };
  }
}

/** 页面根与资源根（给路由用）。 */
export function petRoots() {
  return { pageRoot: PAGE_ROOT, assetRoot: ASSET_ROOT };
}

/**
 * Live2D Cubism Core 的落地位置（页面用 `assets/vendor/live2dcubismcore.min.js` 引它）。
 *
 * **这个文件不进仓库**：它是 Live2D 的专有软件（Proprietary Software License），
 * 只允许作为成品的一部分分发给最终用户，不能在公开仓库里以项目许可证再分发。
 * 所以缺了就由用户在界面点【下载】，从 Live2D 官方取到他自己机器上。
 */
const CORE_PATH = join(ASSET_ROOT, 'vendor', 'live2dcubismcore.min.js');

/**
 * 官方托管的 Cubism Core（Live2D 下载页「Cubism Core for Web / ホスティング用途」给的那个地址）。
 *
 * 注意：只有 "Latest" 这一个地址，带版本号的路径是 404，所以下载后必须**校验内容**。
 */
export const CORE_DOWNLOAD_URL = 'https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js';

/** 许可原文（界面上提醒"点下载表示同意"时挂链接用）。 */
export const CORE_LICENSE_URL = 'https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_en.html';

/**
 * Core 现在在不在（界面据此决定要不要拦下"开启桌宠"）。
 *
 * @returns {{present: boolean, bytes: number, path: string, url: string, license: string}} 状态。
 */
export function coreStatus() {
  let bytes = 0;
  try {
    bytes = statSync(CORE_PATH).size;
  } catch {
    bytes = 0;
  }
  return {
    present: bytes > 0,
    bytes,
    path: CORE_PATH,
    url: CORE_DOWNLOAD_URL,
    license: CORE_LICENSE_URL,
  };
}

/** 下载到的内容是不是真的 Cubism Core（只有 Latest 地址，靠内容兜住版本漂移）。 */
function looksLikeCore(buffer) {
  if (buffer.length < 100_000) return false;
  const head = buffer.toString('utf8', 0, Math.min(buffer.length, 400_000));
  // 官方那份里一定有这些符号；少了任何一个就当没下对
  return head.includes('csmGetVersion') && head.includes('MocVersion_30');
}

/**
 * 从 Live2D 官方把 Core 取下来，写到 vendor/（先写 .tmp 再改名，避免半截文件）。
 *
 * @param {object} [logger] - 日志器。
 * @returns {Promise<{ok: boolean, bytes?: number, sha256?: string, error?: string, path: string}>} 结果。
 */
export async function downloadCore(logger) {
  const timeout = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(45_000)
    : undefined;
  try {
    const response = await fetch(CORE_DOWNLOAD_URL, { redirect: 'follow', signal: timeout });
    if (response.ok !== true) return { ok: false, error: `HTTP ${response.status}`, path: CORE_PATH };
    const buffer = Buffer.from(await response.arrayBuffer());
    if (looksLikeCore(buffer) !== true) {
      return { ok: false, error: `下载到的不是 Cubism Core（${buffer.length} 字节，内容校验没过）`, path: CORE_PATH };
    }
    mkdirSync(dirname(CORE_PATH), { recursive: true });
    const temp = `${CORE_PATH}.tmp`;
    writeFileSync(temp, buffer);
    renameSync(temp, CORE_PATH);
    const sha256 = createHash('sha256').update(buffer).digest('hex');
    logger?.info?.(`chat-widget: Live2D Core 已就位（${buffer.length} 字节，sha256 ${sha256.slice(0, 12)}…）`);
    return { ok: true, bytes: buffer.length, sha256, path: CORE_PATH };
  } catch (error) {
    logger?.warn?.(`chat-widget: 下载 Live2D Core 失败：${String(error)}`);
    return { ok: false, error: String(error), path: CORE_PATH };
  }
}

/**
 * 在一个模型文件夹里找 `*.model3.json`。
 *
 * 允许往下找两层：导出的模型常见两种摆法 ——
 *   `朝那玲/live2d_master.model3.json`（直接放）
 *   `桃濑日和/runtime/hiyori_pro_t11.model3.json`（带 runtime 子目录）
 *
 * @param {string} dir - 模型文件夹。
 * @param {number} depth - 当前深度（0 = 模型文件夹本身）。
 * @returns {string} 相对模型文件夹的路径（分隔符统一成 `/`），找不到是空串。
 */
function findModelJson(dir, depth) {
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return '';
  }
  const files = entries
    .filter((entry) => entry.isFile() === true && /\.model3\.json$/i.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  if (files.length > 0) return files[0];
  if (depth >= 2) return '';
  for (const entry of entries) {
    if (entry.isDirectory() !== true) continue;
    const sub = findModelJson(join(dir, entry.name), depth + 1);
    if (sub !== '') return `${entry.name}/${sub}`;
  }
  return '';
}

/**
 * 列出**现在真的有**的模型。
 *
 * 规则：`assets/live2d/` 下的每个文件夹 = 一个模型，**文件夹名就是模型名**（也是界面上的名字）。
 * 里面找不到 `*.model3.json` 的文件夹直接忽略 —— 所以"把文件夹删了"模型就自己消失了，
 * 不用维护任何清单文件。
 *
 * @returns {Array<{id: string, name: string, src: string}>} 模型列表（`src` 相对 `assets/`）。
 */
export function listModels() {
  let dirs = [];
  try {
    dirs = readdirSync(MODEL_ROOT, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() === true && entry.name.startsWith('.') === false)
      .map((entry) => entry.name);
  } catch {
    return [];
  }
  const models = [];
  for (const name of dirs) {
    const file = findModelJson(join(MODEL_ROOT, name), 0);
    if (file === '') continue;
    models.push({ id: name, name, src: `live2d/${name}/${file}` });
  }
  models.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
  return models;
}

/**
 * 把设置里存的模型 id 变成一个**现在真能用**的 id。
 *
 * 存的那个文件夹被删掉 / 换了台电脑时，退回列表里的第一个，而不是让桌宠白屏。
 *
 * @param {string} configured - 设置里的 `pet.model`（空 = 自动）。
 * @param {Array<{id: string}>} [models] - 模型列表，不传就现扫。
 * @returns {string} 可用的模型 id；一个模型都没有时是空串。
 */
export function resolveModel(configured, models) {
  const list = Array.isArray(models) ? models : listModels();
  const id = typeof configured === 'string' ? configured : '';
  if (list.some((model) => model.id === id)) return id;
  return list.length > 0 ? list[0].id : '';
}

/**
 * 准备（或复用）一个"借来的" Electron 运行时。
 *
 * @param {object} logger - 日志器。
 * @param {string|{dir: string, exe: string, tried?: string[]}} shell - 外壳目录，或 {@link detectShellDir} 的结果。
 * @param {string} runtimeDir - 运行时目录（硬链接落这里）。
 * @returns {{ok: boolean, exe: string, dir: string, error: string}} 结果。
 */
export function prepareRuntime(logger, shell, runtimeDir) {
  const detected = shell !== null && typeof shell === 'object' ? shell : detectShellDir(shell);
  const source = typeof detected.dir === 'string' ? detected.dir : '';
  const exeSrc = typeof detected.exe === 'string' && detected.exe !== '' ? detected.exe : shellExeIn(source);
  if (source === '' || exeSrc === '') {
    return { ok: false, exe: '', dir: runtimeDir, error: shellMissingMessage(detected) };
  }
  if (existsSync(join(source, SHELL_REQUIRED)) === false) {
    return { ok: false, exe: '', dir: runtimeDir, error: `外壳目录缺少 ${SHELL_REQUIRED}：${source}` };
  }
  const exeDst = join(runtimeDir, SHELL_EXE);
  const stamp = join(runtimeDir, '.stamp');
  // 已经借过、且源没变 → 直接用
  try {
    const srcStat = statSync(exeSrc);
    const saved = existsSync(stamp) ? readFileSync(stamp, 'utf8') : '';
    if (existsSync(exeDst) === true && saved === `${srcStat.size}:${srcStat.mtimeMs}`) {
      return { ok: true, exe: exeDst, dir: runtimeDir, error: '' };
    }
  } catch {
    // 读不到就重建
  }
  try {
    rmSync(runtimeDir, { recursive: true, force: true });
    mkdirSync(join(runtimeDir, 'resources'), { recursive: true });
  } catch (error) {
    return { ok: false, exe: '', dir: runtimeDir, error: `建运行时目录失败：${String(error)}` };
  }

  let linked = 0;
  let copied = 0;
  const failed = [];
  const entries = [];
  try {
    entries.push(...readdirSync(source, { withFileTypes: true }));
  } catch (error) {
    return { ok: false, exe: '', dir: runtimeDir, error: `读外壳目录失败：${String(error)}` };
  }
  for (const entry of entries) {
    if (entry.isFile() === false) continue;
    if (SKIP_FILES.has(entry.name) === true) continue;
    const from = join(source, entry.name);
    const to = join(runtimeDir, entry.name);
    try {
      linkSync(from, to); // 硬链接：同盘零拷贝
      linked += 1;
    } catch {
      try {
        copyFileSync(from, to); // 跨盘就复制（慢，但能用）
        copied += 1;
      } catch (error) {
        failed.push(`${entry.name}: ${String(error)}`);
      }
    }
  }
  // **关键**：只放 default_app.asar，不放 app.asar —— 否则 exe 会去跑 DSH 自己
  const defaultApp = join(source, 'resources', 'default_app.asar');
  if (existsSync(defaultApp) === true) {
    const to = join(runtimeDir, 'resources', 'default_app.asar');
    try {
      linkSync(defaultApp, to);
    } catch {
      try {
        copyFileSync(defaultApp, to);
      } catch (error) {
        failed.push(`default_app.asar: ${String(error)}`);
      }
    }
  } else {
    failed.push('default_app.asar 不存在');
  }
  try {
    const srcStat = statSync(exeSrc);
    writeFileSync(stamp, `${srcStat.size}:${srcStat.mtimeMs}`, 'utf8');
  } catch {
    // 记不下就算了，下次重建
  }
  if (existsSync(exeDst) === false) {
    return { ok: false, exe: '', dir: runtimeDir, error: `运行时没建好：${failed.slice(0, 3).join('; ')}` };
  }
  logger?.info?.(`chat-widget: 桌宠运行时就绪（硬链接 ${linked} 个、复制 ${copied} 个${failed.length > 0 ? `、失败 ${failed.length} 个` : ''}）`);
  return { ok: true, exe: exeDst, dir: runtimeDir, error: '' };
}

/**
 * 造一个桌宠管理器。
 *
 * @param {object} options - 依赖。
 * @param {object} options.logger - 日志器。
 * @param {() => Promise<{settings: object}>} options.settingsFn - 读设置。
 * @param {string} options.dataDir - 放 `pet.json` 与运行时目录的地方。
 * @param {() => string} options.pageUrl - 生成页面地址（含实际端口）。
 * @returns {{sync: Function, stop: Function, status: Function, control: Function}} 句柄。
 */
export function createPet({ logger, settingsFn, dataDir, pageUrl }) {
  const stateFile = join(dataDir, 'pet.json');
  // 运行时目录要跟 DSH **同盘**才拿得到硬链接（跨盘会退化成 ~350 MB 复制）。
  // 插件与 DSH 都在 D: 时实测 19 个硬链接、0 次复制；换盘时自动退回复制，功能不变只是慢一次。
  // 放在**插件根目录**下而不是 `pet/` 里面：app 目录里塞一份 350 MB 的 Electron 副本没有意义。
  const runtimeDir = join(PLUGIN_ROOT, '.pet-runtime');
  let child = null;
  let startedAt = 0;
  let restarts = 0;
  /** 连续"秒退"次数：用来在运行时坏掉时停止无限重拉（见 exit 处理）。 */
  let fastFailures = 0;
  let lastError = '';
  let runtime = null;
  /**
   * 上次探测到的外壳：还没起过桌宠时，界面靠它判断"运行时在不在"，
   * 否则开关会被置灰 —— 成了"要开才知道行不行、不开就永远开不了"的死循环。
   */
  let shellSeen = detectedShell;
  let restartTimer = null;
  let stopping = false;

  /** 读一次设置（容忍两种信封）。 */
  const readSettingsOf = async () => {
    const value = await settingsFn();
    if (value === null || typeof value !== 'object') return null;
    return value.settings !== undefined && value.settings !== null ? value.settings : value;
  };

  /** 起外壳进程。 */
  const start = (settings) => {
    if (child !== null) return true;
    // 设置里填了就一定用它（填错就报错，不许偷偷换别的目录）；
    // 留空才走自动探测 —— 换台电脑、换个安装位置都不用改设置。
    shellSeen = detectShellDir(typeof settings.pet?.shellDir === 'string' ? settings.pet.shellDir : '');
    runtime = prepareRuntime(logger, shellSeen, runtimeDir);
    if (runtime.ok !== true) {
      lastError = runtime.error;
      logger?.warn?.(`chat-widget: 桌宠起不来 —— ${runtime.error}`);
      return false;
    }
    const url = pageUrl();
    // **argv 里只放 app 目录，别的参数一律走环境变量。**
    // 实测：给 `default_app` 传 `--url <地址>` 会让它**根本不加载 app**（exit -1，连 main.js 第一行都不执行），
    // 而 `--state <路径>` 单独传却没事 —— 那个开关名撞上了它自己的 argv 解析。环境变量完全避开这类冲突。
    // 另外**绝不给 spawn 加 detached**：Windows 上 detached 会静默掐死 GUI 进程（见 HANDOFF 坑表 19）。
    // `stdio` 一律 `ignore`：GUI 子系统程序在 Windows 上本来就不往管道写东西；日志读 `pet.log`。
    // **必须剔掉 ELECTRON_RUN_AS_NODE**：DSH 桌面端是把 Electron 当 Node 跑宿主的
    // （宿主进程环境里就带着 `ELECTRON_RUN_AS_NODE=1`），`...process.env` 会把它原样传下去 →
    // 借来的 exe 也进 Node 模式 → `require('electron')` 立刻 MODULE_NOT_FOUND → 外壳 exit 1。
    // 症状是"窗口一次都没出现、restarts 一直涨"（实测就是这么挂的）。
    // ELECTRON_NO_ATTACH_CONSOLE 一并剔掉：它会让子进程不接管控制台，窗口相关的怪问题少一个算一个。
    const childEnv = { ...process.env };
    delete childEnv.ELECTRON_RUN_AS_NODE;
    delete childEnv.ELECTRON_NO_ATTACH_CONSOLE;
    child = spawn(runtime.exe, [PET_DIR], {
      cwd: PET_DIR,
      stdio: 'ignore',
      windowsHide: false,
      env: {
        ...childEnv,
        DSHCW_PET_URL: url,
        DSHCW_PET_STATE: stateFile,
        // 把自己的 pid 传下去：DSH 被强杀时，桌宠靠它判断父进程还在不在，然后自己退出。
        // 否则会留下一个没人管的孤儿窗口（界面上没有开关能关它，只能去任务管理器杀）。
        DSHCW_PET_PARENT_PID: String(process.pid),
      },
    });
    startedAt = Date.now();
    child.on('error', (error) => {
      lastError = String(error);
      logger?.warn?.(`chat-widget: 桌宠进程起不来: ${String(error)}`);
      child = null;
    });
    child.on('exit', (code) => {
      child = null;
      if (stopping === true) return;
      // **秒退就退避**：连续快速失败（比如运行时坏了）时别每 3 秒无限重拉，
      // 那会变成刷屏 + 反复弹窗。连挂 3 次就停下来，等用户改设置或手动 restart。
      const lived = Date.now() - startedAt;
      restarts += 1;
      if (lived < 5000) fastFailures += 1;
      else fastFailures = 0;
      lastError = `外壳退出（code ${String(code)}）`;
      if (fastFailures >= 3) {
        logger?.warn?.(`chat-widget: 桌宠连续 ${String(fastFailures)} 次秒退，停止重拉（看 pet.log；改设置或点重启再试）`);
        return;
      }
      logger?.warn?.(`chat-widget: 桌宠外壳退出（code ${String(code)}），${RESTART_MS} ms 后重拉`);
      restartTimer = setTimeout(() => {
        restartTimer = null;
        void readSettingsOf().then((next) => {
          if (next !== null && next.pet?.enabled === true && stopping === false) start(next);
        });
      }, RESTART_MS);
      restartTimer.unref?.();
    });
    // 起来了就把上次的错清掉，否则界面上永远挂着一条过时的"外壳退出（code null）"
    lastError = '';
    logger?.info?.(`chat-widget: 桌宠已启动（pid ${String(child.pid)}，页面 ${url}）`);
    return true;
  };

  /** 停外壳。 */
  const stop = () => {
    stopping = true;
    if (restartTimer !== null) {
      clearTimeout(restartTimer);
      restartTimer = null;
    }
    if (child !== null) {
      const dying = child;
      child = null;
      try {
        dying.kill();
      } catch {
        // 已经退了
      }
    }
  };

  return {
    /**
     * 按设置对齐：`pet.enabled` 开着就起，关了就停。
     *
     * @returns {void} 无（异步执行）。
     */
    sync() {
      void (async () => {
        // 这里是 `void` 调用的异步火苗：**必须自己接住异常**，否则未捕获拒绝会带崩宿主
        try {
          const settings = await readSettingsOf();
          if (settings === null) return;
          const want = settings.pet?.enabled === true;
          if (want !== true) {
            if (child !== null) {
              stop();
              stopping = false;
              logger?.info?.('chat-widget: 桌宠已关闭');
            }
            return;
          }
          if (child !== null) return;
          stopping = false;
          start(settings);
        } catch (error) {
          lastError = String(error);
          logger?.warn?.(`chat-widget: 桌宠 sync 出错（吞掉，别把宿主带崩）: ${String(error)}`);
        }
      })();
    },
    /** 宿主卸载时叫它。 */
    stop() {
      stop();
    },
    /** 预留：以后桌宠 TTS 说话时可以叫它（现在由页面自己 pause 音轨）。 */
    control(action) {
      if (action === 'restart') {
        stop();
        stopping = false;
        void readSettingsOf().then((settings) => {
          if (settings !== null && settings.pet?.enabled === true) start(settings);
        });
        return true;
      }
      return false;
    },
    /** 现场状态。 */
    status() {
      let state = null;
      try {
        state = JSON.parse(readFileSync(stateFile, 'utf8'));
      } catch {
        state = null;
      }
      // 没启动过（runtime === null）也要能回答「运行时在不在」—— 否则界面会把开关置灰，
      // 用户就永远开不了它（要开它才知道行不行的死循环）。退化成一个廉价检查：外壳 exe 在不在。
      const ready = runtime !== null ? runtime.ok === true : shellSeen.exe !== '';
      return {
        enabled: child !== null,
        pid: child === null ? 0 : child.pid,
        uptimeMs: child === null ? 0 : Date.now() - startedAt,
        restarts,
        runtimeReady: ready,
        runtimeError: runtime === null
          ? (shellSeen.exe !== '' ? '' : shellMissingMessage(shellSeen))
          : (runtime.ok === true ? '' : runtime.error),
        // 探测结果如实回给界面：出了问题一眼看得出"它到底找了哪儿"。
        shellDir: shellSeen.dir,
        shellExe: shellSeen.exe,
        shellSource: shellSeen.source,
        lastError,
        state,
        pageRoot: PAGE_ROOT,
        assetRoot: ASSET_ROOT,
      };
    },
  };
}
