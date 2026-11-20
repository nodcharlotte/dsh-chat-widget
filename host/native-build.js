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
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
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

    // 解压用 PowerShell 的 Expand-Archive（nupkg 就是 zip；Node 没有内置解压）
    mkdirSync(target, { recursive: true });
    const result = spawnSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-Command', `Expand-Archive -LiteralPath '${nupkg}' -DestinationPath '${target}' -Force`,
    ], { windowsHide: true, encoding: 'utf8', timeout: 120000 });
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
  const plainFresh = isFresh(target, plain);

  if (target === 'audio' || target === 'watch') {
    if (plainFresh === true) return { ok: true, exe: plain, ocr: 'off' };
    const built = compileEngine({ target, logger });
    return { ok: built.ok === true, exe: built.exe, ocr: 'off', error: built.error };
  }

  const withOcrExe = join(outDir, 'dshcw-capture-ocr.exe');
  const ocrFresh = isFresh(target, withOcrExe);

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
  };
}
