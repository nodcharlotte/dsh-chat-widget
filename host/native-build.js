/**
 * @local/chat-widget —— 原生引擎的**编译助手**（把截图 / OCR / 音轨从 PowerShell 搬进 .NET）。
 *
 * ## 为什么不再用 PowerShell
 *
 * 原来这三个引擎都是**运行时生成的 .ps1**（`%TEMP%\dshcw-capture.ps1` 等）。部分机器上
 * Defender 的 AMSI 会把它判成恶意脚本（"截图 + 编码 + 存盘"这个组合是它的启发式雷区），
 * 表现是引擎一启动就 exit 1、陪看整条链断掉。脚本内容本身没有任何恶意行为，但我们控制不了它。
 *
 * 换成 C# 编译成 EXE 后：**没有脚本文本**，AMSI 的脚本扫描面消失。
 *
 * ## OCR 为什么要"条件编译"
 *
 * `Windows.Media.Ocr`（WinRT）在 .NET Framework 里需要**契约程序集 `Windows.winmd`**，
 * 而那个文件只随 **Windows SDK** 发布 —— `C:\Windows\System32\WinMetadata` 里只有各命名空间的
 * winmd，缺契约，编译会报 `CS0012 ... 必须添加对程序集 "Windows" 的引用`（实测三种写法都卡在这）。
 *
 * 所以：
 *   - 找到 SDK 的 `Windows.winmd` → 编译**带 OCR** 的截图引擎（14 KB），字幕可用；
 *   - 找不到 → 编译**不带 OCR** 的（11 KB），截图照跑，OCR 状态报 `missing-sdk`，界面提示装 SDK。
 *
 * 编译一次约 0.4 秒，产物按"源码 mtime"缓存，之后直接复用。
 *
 * @module @local/chat-widget/host/native-build
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { get as httpsGet } from 'node:https';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { dshHomePath } from './home.js';

/** 插件根目录（本文件在 host/ 下）。 */
const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** C# 源码目录。 */
export const SOURCE_DIR = join(PLUGIN_ROOT, 'native');

/** 编译产物放数据目录（不污染插件目录，也不进 git）。 */
export function nativeDir() {
  return dshHomePath('chat-widget/native');
}

/** NuGet 上的 WinRT 契约包（含 92 个 winmd，不必装 Windows SDK）。 */
export const CONTRACTS_PACKAGE = 'microsoft.windows.sdk.contracts';

/** 兜底版本（nuget 索引拉不到时用它）。 */
const CONTRACTS_FALLBACK_VERSION = '10.0.26100.1742';

/**
 * 下载解压后的 winmd 目录（放数据目录，不进插件目录）。
 * @returns {string} 绝对路径。
 */
export function winmdDir() {
  return join(nativeDir(), 'winmd');
}

/**
 * 可用于编译的 WinRT 契约引用。
 *
 * 两条路，优先级从高到低：
 *   1. 本机装了 Windows SDK → 用它那个 7.25 MB 的 `Windows.winmd`（一个文件就够）；
 *   2. 没装 SDK → 用 NuGet 包解出来的 92 个 winmd（3.6 MB 下载，不需要 UAC）。
 *
 * @returns {string[]} winmd 路径列表；空数组 = 两条都没有。
 */
export function winmdRefs() {
  const sdk = findSdkWinmd();
  if (sdk !== '') return [sdk];
  const dir = winmdDir();
  if (existsSync(dir) !== true) return [];
  try {
    const files = readdirSync(dir, { withFileTypes: true })
      .filter((item) => item.isFile() === true && item.name.toLowerCase().endsWith('.winmd'))
      .map((item) => join(dir, item.name));
    return files.length > 0 ? files : [];
  } catch {
    return [];
  }
}

/**
 * 下载并解压 NuGet 的 WinRT 契约包（不装 SDK、不提权）。
 *
 * @param {object} [logger] - 日志器。
 * @returns {Promise<{ok: boolean, dir?: string, count?: number, error?: string}>} 结果。
 */
export async function fetchWinmds(logger) {
  let version = CONTRACTS_FALLBACK_VERSION;
  try {
    const response = await fetch(`https://api.nuget.org/v3-flatcontainer/${CONTRACTS_PACKAGE}/index.json`);
    if (response.ok === true) {
      const data = await response.json();
      const stable = Array.isArray(data.versions)
        ? data.versions.filter((one) => typeof one === 'string' && one.includes('-') === false)
        : [];
      if (stable.length > 0) version = stable[stable.length - 1];
    }
  } catch {
    // 拉不到索引就用兜底版本
  }
  const url = `https://api.nuget.org/v3-flatcontainer/${CONTRACTS_PACKAGE}/${version}/${CONTRACTS_PACKAGE}.${version}.nupkg`;
  const target = winmdDir();
  // Expand-Archive 只认 .zip 后缀（.nupkg 会报"不支持的存档文件格式"），所以存成 .zip
  const nupkg = join(nativeDir(), 'contracts.zip');
  try {
    mkdirSync(nativeDir(), { recursive: true });
    logger?.info?.(`chat-widget: 下载 WinRT 契约包 ${version}（约 3.6 MB）…`);
    const response = await fetch(url);
    if (response.ok !== true) return { ok: false, error: `HTTP ${response.status}` };
    const buffer = Buffer.from(await response.arrayBuffer());
    writeFileSync(nupkg, buffer);

    // 解压用 **Windows 自带的 tar.exe**（bsdtar，认 .zip，Win10 1803+ 都有）。
    // 以前用 PowerShell 的 Expand-Archive：那会启动一个脚本解释器，在开着
    // Smart App Control 的机器上直接弹"无法确认谁发布了 PowerShell 7"，
    // 连带把整个编译链拦掉（用户 2026-11-21 在另一台机器上实测）。
    // tar.exe 是系统自带、带微软签名的程序，不碰这条路。
    mkdirSync(target, { recursive: true });
    const tar = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
    const result = spawnSync(tar, ['-xf', nupkg, '-C', target], {
      windowsHide: true, encoding: 'utf8', timeout: 120000,
    });
    if (result.status !== 0) {
      return { ok: false, error: String(result.stderr ?? '').slice(0, 300) };
    }

    // 把 ref/netstandard2.0/*.winmd 全挪到根目录，只留这些（省空间，也避免误引）
    const refDir = join(target, 'ref');
    if (existsSync(refDir) === true) {
      for (const item of readdirSync(refDir, { withFileTypes: true })) {
        if (item.isDirectory() !== true) continue;
        const sub = join(refDir, item.name);
        for (const file of readdirSync(sub, { withFileTypes: true })) {
          if (file.isFile() === true && file.name.toLowerCase().endsWith('.winmd')) {
            try { renameSync(join(sub, file.name), join(target, file.name)); } catch { /* 重名就算了 */ }
          }
        }
      }
    }
    try { rmSync(nupkg, { force: true }); } catch { /* 删不掉不影响 */ }
    const count = winmdRefs().length;
    logger?.info?.(`chat-widget: WinRT 契约包就绪（${String(count)} 个 winmd）`);
    return count > 0 ? { ok: true, dir: target, count } : { ok: false, error: '包里没找到 winmd' };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

/**
 * OCR 引擎是不是已经编好了（编好就不用再点一次等编译）。
 *
 * 只看"产物存在且比源码新"，**不编译** —— 界面在滑块点击时用它决定要不要转圈。
 *
 * @returns {boolean} 可直接用。
 */
export function ocrEngineReady() {
  // 编好的 exe 运行期**不需要** winmd（winmd 只在编译时用），所以这里不查 winmdRefs()。
  // 查了会导致"删了契约包 → 明明有 exe 却判没就绪、点滑块又去重新编译"。
  //
  // Release 拉的那份**不看源码 mtime**：发布产物本来就比源码旧，而且它是 SAC 机器上唯一能跑的那个。
  if (prebuiltEngine('dshcw-capture-ocr.exe') === true) return true;
  try {
    const exe = join(nativeDir(), 'dshcw-capture-ocr.exe');
    if (existsSync(exe) !== true) return false;
    const source = join(SOURCE_DIR, 'CaptureEngine.cs');
    if (existsSync(source) !== true) return false;
    return statSync(exe).mtimeMs >= statSync(source).mtimeMs;
  } catch {
    return false;
  }
}

/** Windows SDK 官方下载页（缺 SDK 时界面上的「下载」按钮指这里）。 */
export const SDK_DOWNLOAD_URL = 'https://developer.microsoft.com/windows/downloads/windows-sdk/';

/** 编译产物文件名。 */
const OUTPUTS = {
  capture: 'dshcw-capture.exe',
  audio: 'dshcw-audio.exe',
  watch: 'dshcw-watch.exe',
};

/** 各产物依赖的源码。 */
const SOURCES = {
  capture: 'CaptureEngine.cs',
  audio: 'AudioEngine.cs',
  watch: 'WindowWatch.cs',
};

/**
 * ## 无签名 EXE 与智能应用控制（SAC）
 *
 * 三个引擎都是**本机当场编译**的 .NET EXE，没有代码签名。Win11 的 Smart App Control
 * 只放行"微软判定安全"或"由受信任根证书签过名"的二进制 —— 它不看文件来源、不看路径、
 * 不看 Mark-of-the-Web，于是这些 EXE 在开了 SAC 的机器上会被直接拦掉
 * （Windows 安全中心报"此应用的一部分已被阻止…因为我们无法确认谁发布了它"）。
 *
 * 所以流程改成**先看 SAC**：
 *   - SAC 没开 → 照旧本机编译（约 0.4 秒，不联网）；
 *   - SAC 开着 → 去 GitHub Release 拉**预编译产物**（CI 编、CI 签，清单里的 sha256 对得上才用）；
 *   - 拉不到 → 退回本机编译，并把 OCR / ASR / 窗口监测 三处小字一起改成
 *     "联网拉取…编译产物失败，本机有SAC无法使用，如果信任本程序，可临时关闭SAC。[SAC设置]"。
 *
 * 检测走 `reg.exe query`（微软签名的系统程序，SAC 不拦它），读
 * `HKLM\SYSTEM\CurrentControlSet\Control\CI\Policy\VerifiedAndReputablePolicyState`：
 * `0` = 关 / `1` = 强制 / `2` = 评估（只记录、不拦）/ 值不存在 = 这台机器从没开过 SAC。
 */
const SAC_KEY = 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\CI\\Policy';

/** SAC 开关在「Windows 安全中心 → 应用和浏览器控制 → 智能应用控制」。 */
export const SAC_SETTINGS_URI = 'windowsdefender://appbrowser';

/** 预编译产物所在的仓库（`releases/latest/download/<文件名>` 是稳定直链）。 */
export const RELEASE_REPO = 'nodcharlotte/dsh-chat-widget';

/** Release 里的清单（每个产物的 sha256）。 */
export const RELEASE_MANIFEST = 'native-manifest.json';

/** 记着"目录里这个 exe 是 Release 拉的、哈希是多少"（本机编译的不在册）。 */
const PREBUILT_MARKER = 'prebuilt.json';

/** Release 可能带的四个产物（清单里没列的就跳过）。 */
const RELEASE_FILES = ['dshcw-capture.exe', 'dshcw-capture-ocr.exe', 'dshcw-audio.exe', 'dshcw-watch.exe'];

/** SAC 状态缓存（一次 `/screen/status` 里会被问好几遍，别每次都起 reg.exe）。 */
let sacCached = { at: 0, value: null };

/**
 * 本机 SAC 状态。
 *
 * @param {boolean} [refresh] - 忽略缓存重新读一次。
 * @returns {{state: 'on'|'eval'|'off'|'unknown', code: number|null, uri: string}} 状态。
 */
export function sacState(refresh = false) {
  if (refresh !== true && sacCached.value !== null && Date.now() - sacCached.at < 10_000) return sacCached.value;
  const done = (value) => {
    sacCached = { at: Date.now(), value };
    return value;
  };
  const off = { state: 'off', code: null, uri: SAC_SETTINGS_URI };
  if (process.platform !== 'win32') return done(off);
  const reg = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'reg.exe');
  if (existsSync(reg) !== true) return done({ ...off, state: 'unknown' });
  let text = '';
  try {
    const out = spawnSync(reg, ['query', SAC_KEY, '/v', 'VerifiedAndReputablePolicyState'], {
      windowsHide: true,
      encoding: 'utf8',
      timeout: 8000,
    });
    if (out.error !== undefined && out.error !== null) return done({ ...off, state: 'unknown' });
    text = `${String(out.stdout ?? '')}\n${String(out.stderr ?? '')}`;
  } catch {
    return done({ ...off, state: 'unknown' });
  }
  const hit = /VerifiedAndReputablePolicyState\s+REG_DWORD\s+0x([0-9a-fA-F]+)/.exec(text);
  // 键或值不存在 = 这台机器从来没过 SAC（开过一次就会留下这个值），当成关
  if (hit === null) return done(off);
  const code = Number.parseInt(hit[1], 16);
  if (code === 1) return done({ state: 'on', code, uri: SAC_SETTINGS_URI });
  if (code === 2) return done({ state: 'eval', code, uri: SAC_SETTINGS_URI });
  return done({ state: 'off', code, uri: SAC_SETTINGS_URI });
}

/** 本机这次会话拉预编译产物的结果（`ok` null = 还没试过）。 */
const prebuiltAttempt = { inFlight: false, done: false, ok: null, error: '', version: '' };

/**
 * 读预编译标记（坏文件当没有）。
 *
 * @returns {{version?: string, files: Record<string, string>}} 标记内容。
 */
function prebuiltMarker() {
  try {
    const parsed = JSON.parse(readFileSync(join(nativeDir(), PREBUILT_MARKER), 'utf8'));
    if (parsed === null || typeof parsed !== 'object') return { files: {} };
    if (parsed.files === null || typeof parsed.files !== 'object') return { files: {} };
    return parsed;
  } catch {
    return { files: {} };
  }
}

/**
 * 这个产物是不是 Release 那份（标记里有它，且文件的 sha256 仍对得上）。
 *
 * @param {string} exeName - 产物文件名。
 * @returns {boolean} 可以直接用。
 */
export function prebuiltEngine(exeName) {
  const files = prebuiltMarker().files;
  const want = files !== null && typeof files === 'object' ? files[exeName] : undefined;
  if (typeof want !== 'string' || want === '') return false;
  try {
    const exe = join(nativeDir(), exeName);
    if (existsSync(exe) !== true) return false;
    return createHash('sha256').update(readFileSync(exe)).digest('hex') === want;
  } catch {
    return false;
  }
}

/**
 * 取一个小文件（GET，最多跟 5 次跳转）。
 *
 * **故意不用全局 `fetch`**：实测在装了杀毒/防火墙的 Windows 上，Node 的 undici 连
 * `github.com` 会一直 `UND_ERR_CONNECT_TIMEOUT`（10 秒超时），同一个地址换成
 * `node:https` + `family: 4` 600 ms 就回 302。下载这条路不能赌 undici 的地址选择，
 * 所以直接走 `https` 并**强制 IPv4**（GitHub 的 IPv4 够用）。
 *
 * @param {string} url - 绝对地址（https）。
 * @param {number} timeoutMs - 单次请求超时。
 * @returns {Promise<{ok: boolean, buffer?: Buffer, status?: number, error?: string}|{redirect: string}>} 结果。
 */
async function httpGet(url, timeoutMs) {
  const MAX_REDIRECTS = 5;
  const MAX_BYTES = 8 * 1024 * 1024;
  let target = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const got = await new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled === true) return;
        settled = true;
        resolve(value);
      };
      let request = null;
      try {
        request = httpsGet(target, {
          family: 4,
          headers: { 'accept-encoding': 'identity', 'user-agent': 'dsh-chat-widget' },
        }, (response) => {
          const status = response.statusCode ?? 0;
          const location = response.headers.location;
          if (status >= 300 && status < 400 && typeof location === 'string') {
            response.resume();
            finish({ redirect: new URL(location, target).toString() });
            return;
          }
          if (status !== 200) {
            response.resume();
            finish({ ok: false, error: `HTTP ${status}` });
            return;
          }
          const chunks = [];
          let bytes = 0;
          response.on('data', (chunk) => {
            bytes += chunk.length;
            if (bytes > MAX_BYTES) {
              request.destroy(new Error(`文件超过 ${Math.round(MAX_BYTES / 1024 / 1024)} MB`));
              return;
            }
            chunks.push(chunk);
          });
          response.on('end', () => finish({ ok: true, buffer: Buffer.concat(chunks), status }));
          response.on('error', (error) => finish({ ok: false, error: String(error?.message ?? error) }));
        });
        request.on('error', (error) => finish({ ok: false, error: String(error?.code ?? error?.message ?? error) }));
        request.setTimeout(timeoutMs, () => request.destroy(new Error('超时')));
      } catch (error) {
        finish({ ok: false, error: String(error) });
      }
    });
    if (got !== null && typeof got === 'object' && typeof got.redirect === 'string') {
      target = got.redirect;
      continue;
    }
    return got;
  }
  return { ok: false, error: `跳转超过 ${MAX_REDIRECTS} 次` };
}

/**
 * 从 GitHub Release 把预编译产物拉下来，写到数据目录（先 `.tmp` 再改名）。
 *
 * 清单里的 sha256 对不上就不落盘 —— 宁可用本机编的，也不装一个来源不明的二进制。
 * 清单里的 `signed` 不是 `true` 时，SAC 开着的机器直接拒收（见下面的注释）。
 *
 * @param {object} [logger] - 日志器。
 * @returns {Promise<{ok: boolean, files?: Record<string, string>, version?: string, error?: string}>} 结果。
 */
export async function fetchPrebuilt(logger) {
  const dir = nativeDir();
  try {
    mkdirSync(dir, { recursive: true });
  } catch (error) {
    return { ok: false, error: `建目录失败：${String(error)}` };
  }
  const url = (name) => `https://github.com/${RELEASE_REPO}/releases/latest/download/${encodeURIComponent(name)}`;

  let manifest = null;
  const manifestGot = await httpGet(url(RELEASE_MANIFEST), 30_000);
  if (manifestGot.ok !== true) return { ok: false, error: `清单拉取失败：${manifestGot.error}（${RELEASE_MANIFEST}）` };
  try {
    manifest = JSON.parse(manifestGot.buffer.toString('utf8'));
  } catch (error) {
    return { ok: false, error: `清单不是 JSON：${String(error)}` };
  }
  const listed = manifest !== null && typeof manifest === 'object' ? manifest.files : null;
  if (listed === null || typeof listed !== 'object') return { ok: false, error: '清单里没有 files' };
  // 清单里 `signed` 是 CI 打的标记：这批产物过没过 SignPath。
  // SAC 开着时**未签名的一律不收** —— 那些文件在用户机器上根本跑不起来，
  // 收下来只会让"能下载到"变成"下载到了但一启动就被拦"，比直接退回本机编译还糟。
  if (sacState().state === 'on' && manifest.signed !== true) {
    return { ok: false, error: 'Release 里是未签名的产物（本机开着 SAC，下载了也跑不起来）' };
  }

  const written = {};
  for (const name of RELEASE_FILES) {
    const want = typeof listed[name] === 'string' ? listed[name].toLowerCase() : '';
    if (want === '') continue;
    if (prebuiltEngine(name) === true) {
      written[name] = want;
      continue;
    }
    try {
      const got = await httpGet(url(name), 60_000);
      if (got.ok !== true) return { ok: false, error: `${name} 下载失败：${got.error}` };
      const buffer = got.buffer;
      const sha = createHash('sha256').update(buffer).digest('hex');
      if (sha !== want) {
        return { ok: false, error: `${name} 哈希对不上（清单 ${want.slice(0, 12)}…，实际 ${sha.slice(0, 12)}…）` };
      }
      const exe = join(dir, name);
      writeFileSync(`${exe}.tmp`, buffer);
      renameSync(`${exe}.tmp`, exe);
      written[name] = sha;
    } catch (error) {
      return { ok: false, error: `${name} 下载失败：${String(error)}` };
    }
  }
  if (Object.keys(written).length === 0) return { ok: false, error: '清单里没有可用的产物' };

  const version = typeof manifest.version === 'string' ? manifest.version : '';
  try {
    writeFileSync(
      join(dir, PREBUILT_MARKER),
      JSON.stringify({ version, at: Date.now(), files: written }, null, 2),
      'utf8',
    );
  } catch (error) {
    return { ok: false, error: `写标记失败：${String(error)}` };
  }
  logger?.info?.(`chat-widget: 预编译引擎就位（${String(Object.keys(written).length)} 个${version === '' ? '' : `，${version}`}）`);
  return { ok: true, files: written, version };
}

/**
 * 拉一次预编译产物 —— **后台跑，不弹窗**（产物只有几十 KB，失败会自动退回本机编译）。
 *
 * 只在 SAC 开着时才试；同一个会话只试一次。结果是异步写的，
 * 界面下次读 `/screen/status` 就能看到 `native.sac.blocked`。
 *
 * @param {object} [logger] - 日志器。
 * @returns {void} 不等待。
 */
export function prefetchPrebuilt(logger) {
  if (prebuiltAttempt.inFlight === true || prebuiltAttempt.done === true) return;
  // SAC 没开就不必拉：本机编译的产物本来就能跑
  if (sacState().state !== 'on') return;
  prebuiltAttempt.inFlight = true;
  fetchPrebuilt(logger)
    .then((got) => {
      prebuiltAttempt.done = true;
      prebuiltAttempt.inFlight = false;
      prebuiltAttempt.ok = got.ok === true;
      prebuiltAttempt.error = got.ok === true ? '' : String(got.error ?? '');
      prebuiltAttempt.version = got.ok === true ? String(got.version ?? '') : '';
      if (got.ok !== true) logger?.warn?.(`chat-widget: 拉取预编译引擎失败（将退回本机编译）：${prebuiltAttempt.error}`);
    })
    .catch((error) => {
      prebuiltAttempt.done = true;
      prebuiltAttempt.inFlight = false;
      prebuiltAttempt.ok = false;
      prebuiltAttempt.error = String(error);
    });
}

/**
 * 找 csc.exe（.NET Framework 自带的 C# 编译器，Win10/11 一定有）。
 *
 * @returns {string} 路径；找不到返回空串。
 */
export function cscPath() {
  const win = process.env.WINDIR ?? process.env.SystemRoot ?? 'C:\\Windows';
  const candidates = [
    join(win, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    join(win, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
  ];
  for (const path of candidates) if (existsSync(path)) return path;
  return '';
}

/**
 * 找 Windows SDK 里的契约程序集 `Windows.winmd`。
 *
 * 只认 `UnionMetadata\<版本>\Windows.winmd`；**不认** `Facade\windows.winmd`
 * （那个 170 KB 的只有类型转发，编译会报"命名空间 Windows.Media 中不存在 Ocr"，实测过）。
 *
 * @returns {string} 路径；找不到返回空串。
 */
export function findSdkWinmd() {
  const override = process.env.DSHCW_WINDOWS_WINMD;
  if (typeof override === 'string' && override !== '' && existsSync(override)) return override;

  const roots = [
    join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Windows Kits', '10', 'UnionMetadata'),
    join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Windows Kits', '10', 'UnionMetadata'),
  ];
  for (const root of roots) {
    if (existsSync(root) !== true) continue;
    let versions = [];
    try {
      versions = readdirSync(root, { withFileTypes: true })
        .filter((item) => item.isDirectory() === true && /^\d+(\.\d+)*$/.test(item.name))
        .map((item) => item.name)
        // 版本号倒序：优先用最新的 SDK
        .sort((a, b) => {
          const pa = a.split('.').map(Number);
          const pb = b.split('.').map(Number);
          for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
            const d = (pb[i] ?? 0) - (pa[i] ?? 0);
            if (d !== 0) return d;
          }
          return 0;
        });
    } catch {
      versions = [];
    }
    for (const version of versions) {
      const file = join(root, version, 'Windows.winmd');
      if (existsSync(file)) return file;
    }
  }
  return '';
}

/**
 * WinRT 投影需要的两个框架程序集（都在系统里，不需要 SDK）。
 *
 * @returns {{runtime: string, facade: string}} 路径（可能为空串）。
 */
function winrtAssemblies() {
  const win = process.env.WINDIR ?? process.env.SystemRoot ?? 'C:\\Windows';
  const gac = join(win, 'Microsoft.NET', 'assembly', 'GAC_MSIL', 'System.Runtime.WindowsRuntime');
  let runtime = '';
  try {
    const versions = readdirSync(gac, { withFileTypes: true }).filter((item) => item.isDirectory() === true);
    for (const item of versions) {
      const file = join(gac, item.name, 'System.Runtime.WindowsRuntime.dll');
      if (existsSync(file)) {
        runtime = file;
        break;
      }
    }
  } catch {
    runtime = '';
  }
  const facade = join(win, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'System.Runtime.dll');
  return { runtime, facade: existsSync(facade) ? facade : '' };
}

/**
 * 编译一个引擎。
 *
 * @param {object} options - 参数。
 * @param {'capture'|'audio'} options.target - 编哪个。
 * @param {boolean} [options.withOcr] - capture 专用：要不要带 OCR。
 * @param {object} [options.logger] - 日志器。
 * @returns {{ok: boolean, exe: string, error?: string, withOcr?: boolean}} 结果。
 */
export function compileEngine({ target, withOcr = false, logger }) {
  const csc = cscPath();
  if (csc === '') return { ok: false, exe: '', error: '找不到 csc.exe（.NET Framework 4.x 缺失？）' };

  const source = join(SOURCE_DIR, SOURCES[target]);
  if (existsSync(source) !== true) return { ok: false, exe: '', error: `缺少源码 ${source}` };

  const outDir = nativeDir();
  try {
    mkdirSync(outDir, { recursive: true });
  } catch (error) {
    return { ok: false, exe: '', error: `建目录失败：${String(error)}` };
  }

  // 带 OCR 的产物单独命名，这样"装了 SDK 之后"不用先删旧的
  const exeName = target === 'capture' && withOcr === true ? 'dshcw-capture-ocr.exe' : OUTPUTS[target];
  const exe = join(outDir, exeName);

  const args = [
    '/nologo', '/target:exe', '/platform:anycpu', '/optimize+',
    `/out:${exe}`,
    '/r:System.dll', '/r:System.Core.dll',
  ];
  if (target === 'capture') {
    args.push('/r:System.Drawing.dll', '/r:System.Windows.Forms.dll');
    if (withOcr === true) {
      const refs = winmdRefs();
      const { runtime, facade } = winrtAssemblies();
      if (refs.length === 0 || runtime === '' || facade === '') {
        return { ok: false, exe: '', error: 'missing-sdk' };
      }
      args.push('/define:WITH_OCR', `/r:${facade}`, `/r:${runtime}`);
      // SDK 的 Windows.winmd 只有 1 个；nuget 包有 92 个，全带上
      for (const ref of refs) args.push(`/r:${ref}`);
    }
  }

  args.push(source);
  const result = spawnSync(csc, args, { windowsHide: true, encoding: 'utf8', timeout: 60000 });
  if (result.error !== undefined && result.error !== null) {
    return { ok: false, exe: '', error: `调用 csc 失败：${String(result.error)}` };
  }
  if (result.status !== 0 || existsSync(exe) !== true) {
    const detail = String(result.stderr ?? '').trim().split(/\r?\n/).slice(0, 3).join(' / ');
    logger?.warn?.(`chat-widget: 编译 ${exeName} 失败（code=${String(result.status)}）：${detail}`);
    return { ok: false, exe: '', error: detail === '' ? `csc 退出码 ${String(result.status)}` : detail };
  }
  logger?.info?.(`chat-widget: 已编译 ${exeName}（${Math.round(statSync(exe).size / 1024)} KB${withOcr === true ? '，含 OCR' : ''}）`);
  return { ok: true, exe, withOcr: withOcr === true };
}

/**
 * 确保某个引擎可用（编译过就直接用）。
 *
 * @param {object} options - 参数。
 * @param {'capture'|'audio'} options.target - 哪个引擎。
 * @param {boolean} [options.wantOcr] - capture 专用：希望带 OCR（没 SDK 会退成不带 OCR 的）。
 * @param {object} [options.logger] - 日志器。
 * @returns {{ok: boolean, exe: string, ocr: string, error?: string}} 结果；`ocr` 是 `ok`/`missing-sdk`/`off`。
 */
export function ensureEngine({ target, wantOcr = false, logger }) {
  const outDir = nativeDir();
  const plain = join(outDir, OUTPUTS[target]);
  const plainFresh = usableEngine(target, OUTPUTS[target], plain);

  if (target === 'audio' || target === 'watch') {
    if (plainFresh === true) return { ok: true, exe: plain, ocr: 'off' };
    const built = compileEngine({ target, logger });
    return { ok: built.ok === true, exe: built.exe, ocr: 'off', error: built.error };
  }

  const withOcrExe = join(outDir, 'dshcw-capture-ocr.exe');
  const ocrFresh = usableEngine(target, 'dshcw-capture-ocr.exe', withOcrExe);

  // 要 OCR：优先用现成的带 OCR 产物；没有就试着编
  if (wantOcr === true) {
    if (ocrFresh === true) return { ok: true, exe: withOcrExe, ocr: 'ok' };
    const built = compileEngine({ target, withOcr: true, logger });
    if (built.ok === true) return { ok: true, exe: built.exe, ocr: 'ok' };
    if (built.error === 'missing-sdk') {
      // 没 SDK：退成不带 OCR 的，截图照跑，状态告诉界面
      if (plainFresh === true) return { ok: true, exe: plain, ocr: 'missing-sdk' };
      const fallback = compileEngine({ target, logger });
      return { ok: fallback.ok === true, exe: fallback.exe, ocr: 'missing-sdk', error: fallback.error };
    }
    return { ok: false, exe: '', ocr: 'error', error: built.error };
  }

  if (plainFresh === true) return { ok: true, exe: plain, ocr: 'off' };
  const built = compileEngine({ target, logger });
  return { ok: built.ok === true, exe: built.exe, ocr: 'off', error: built.error };
}

/**
 * 产物能不能直接用。
 *
 * Release 拉下来的那份（哈希对得上）**优先**：它是签过名的，SAC 开着也跑得起来；
 * 没有才看本机编译的那份（mtime 比源码新）。
 *
 * @param {'capture'|'audio'|'watch'} target - 引擎。
 * @param {string} exeName - 产物文件名。
 * @param {string} exe - 产物路径。
 * @returns {boolean} 可直接用。
 */
function usableEngine(target, exeName, exe) {
  if (prebuiltEngine(exeName) === true) return true;
  return isFresh(target, exe);
}

/**
 * 产物是不是比源码新（不用每次重编）。
 *
 * @param {'capture'|'audio'} target - 引擎。
 * @param {string} exe - 产物路径。
 * @returns {boolean} 可直接用。
 */
function isFresh(target, exe) {
  try {
    if (existsSync(exe) !== true) return false;
    const source = join(SOURCE_DIR, SOURCES[target]);
    if (existsSync(source) !== true) return false;
    return statSync(exe).mtimeMs >= statSync(source).mtimeMs;
  } catch {
    return false;
  }
}

/**
 * 原生引擎的整体状态（给 `/screen/status` 与界面用）。
 *
 * @returns {{csc: boolean, sdk: boolean, sdkDownload: string, dir: string}} 状态。
 */
export function nativeStatus() {
  const refs = winmdRefs();
  const sac = sacState();
  return {
    csc: cscPath() !== '',
    // `sdk` 保留旧名字（界面已经在用）：含义是"能编 OCR 引擎的契约有没有"
    sdk: refs.length > 0,
    // winmd 从哪来：`sdk` = 本机装了 Windows SDK；`nuget` = 下载的契约包；`none` = 都没有
    winmd: refs.length === 0 ? 'none' : (findSdkWinmd() !== '' ? 'sdk' : 'nuget'),
    // OCR 引擎已经编好了（界面据此决定点滑块时"直接开"还是"先编译"）
    engine: ocrEngineReady(),
    sdkDownload: SDK_DOWNLOAD_URL,
    dir: nativeDir(),
    // 智能应用控制：开着的时候界面要把"拉不到预编译产物"的红字提示显示出来
    sac: {
      state: sac.state,
      uri: SAC_SETTINGS_URI,
      // null = 还没试过 / true = 拉到了 / false = 试过、失败
      fetched: prebuiltAttempt.done === true ? prebuiltAttempt.ok === true : null,
      error: prebuiltAttempt.error,
      // true = OCR / ASR / 窗口监测 三处小字一起改成"关掉 SAC"的提示
      blocked: sac.state === 'on' && prebuiltAttempt.done === true && prebuiltAttempt.ok !== true,
    },
  };
}
