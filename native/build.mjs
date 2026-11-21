#!/usr/bin/env node
/**
 * @local/chat-widget —— 在 CI（GitHub Actions，windows-latest）里把四个原生引擎编出来。
 *
 * 为什么要有这个文件：SignPath Foundation 要求**签名产物必须由项目自己的 CI 从自己的源码编出来**，
 * 所以发布用的 EXE 不能是某人本机编的。GitHub Release 里那份 `native-manifest.json`
 * 就是这里算出来的 sha256，插件在别的机器上下载时逐个核对（见 `host/native-build.js`
 * 的 `fetchPrebuilt`）。
 *
 * **不重复写编译参数**：这里直接用 `host/native-build.js` 里那份 `compileEngine`，
 * 跟插件在本机"当场编译"走的是同一条路（同样找不到 csc / 缺 winmd 会直接失败）。
 * 唯一要做的就是给 `DSH_HOME` 指一个工作目录 —— `nativeDir()` 会把产物落到那下面，
 * 不碰运行时的 `~/.dsh`。
 *
 * 用法：
 *   node native/build.mjs [版本号]
 *
 * 环境变量：
 *   DSH_HOME  产物落到 `<DSH_HOME>/chat-widget/native/`（CI 里设成 `${{ github.workspace }}\.native`）
 *
 * 产物：
 *   dshcw-capture.exe / dshcw-capture-ocr.exe / dshcw-audio.exe / dshcw-watch.exe
 *   native-manifest.json —— `{version, files: {<文件名>: <sha256>}}`
 *
 * @module @local/chat-widget/native/build
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { compileEngine, cscPath, fetchWinmds, nativeDir, winmdRefs } from '../host/native-build.js';

/** 日志器：CI 里直接打在 stdout 上。 */
const logger = {
  info: (message) => console.log(`[build] ${message}`),
  warn: (message) => console.warn(`[build] ${message}`),
};

/** Release 里要有的四个产物（顺序固定，输出好对）。 */
const TARGETS = [
  { target: 'capture', withOcr: false },
  { target: 'capture', withOcr: true },
  { target: 'audio', withOcr: false },
  { target: 'watch', withOcr: false },
];

/**
 * 编不出来就退出码 1 —— 缺一个产物都算失败，宁可没有 Release 也不要残缺的 Release。
 *
 * @param {string} reason - 原因。
 * @returns {never} 结束进程。
 */
function fail(reason) {
  console.error(`[build] 失败：${reason}`);
  process.exit(1);
}

if (cscPath() === '') fail('找不到 csc.exe（C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe）');

// OCR 引擎要 WinRT 契约：本机有 Windows SDK 就用它的 Windows.winmd，
// 没有就从 NuGet 拉（跟插件在用户机器上做的一样，3.6 MB、不用提权）。
if (winmdRefs().length === 0) {
  logger.info('没有可用的 WinRT 契约，从 NuGet 拉 microsoft.windows.sdk.contracts');
  const fetched = await fetchWinmds(logger);
  if (fetched.ok !== true) fail(`拉 WinRT 契约失败：${String(fetched.error ?? '')}`);
}
if (winmdRefs().length === 0) fail('拉完契约包仍然没有 winmd');

const files = {};
for (const item of TARGETS) {
  const label = item.withOcr === true ? `${item.target}(OCR)` : item.target;
  const built = compileEngine({ ...item, logger });
  if (built.ok !== true) fail(`编 ${label} 失败：${String(built.error ?? '')}`);
  const name = basename(built.exe);
  files[name] = createHash('sha256').update(readFileSync(built.exe)).digest('hex');
  logger.info(`${name}  ${files[name]}`);
}

const version = typeof process.argv[2] === 'string' ? process.argv[2] : '';
const manifest = join(nativeDir(), 'native-manifest.json');
writeFileSync(manifest, `${JSON.stringify({ version, files }, null, 2)}\n`, 'utf8');
logger.info(`清单已写好：${manifest}`);