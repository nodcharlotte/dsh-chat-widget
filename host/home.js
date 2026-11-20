/**
 * @local/chat-widget —— DSH 数据根（home）的路径解析，**插件自带实现**。
 *
 * 为什么要自己写一份：`@deepseek-ai/dsh-home-paths` 是随 dsh 一起安装的包。
 * 以 `link:` 方式装进 profile 的插件，只有在 `package.json` 里把这类包声明成
 * peerDependencies 时，新版的解析器才会把裸导入路由到 dsh 安装目录；
 * **旧版 DSH 上这条导入可能直接 `ERR_MODULE_NOT_FOUND`，整个插件都起不来**。
 * 而插件只用到 `dshHomePath()` 一个函数，规则也就三条，照抄一份最省事：
 *
 *   - 优先级：显式传入 > `$DSH_HOME` > `~/.dsh`；
 *   - `$DSH_HOME` 是空白串时**当没设**（别把数据根解析到当前目录）；
 *   - 支持 `~`、`~/…`、`~\…` 三种开头的家目录展开。
 *
 * 跟 `@deepseek-ai/dsh-home-paths` 的 `resolveDshHome` / `dshHomePath` 行为一致
 * （那两行的实现见 dsh 安装目录里的 `lib/index.js`）。代价是这里不再随它升级；
 * 换来的是**插件不 import 任何 DSH 包**，装到哪个版本的 DSH 上都不会卡在模块解析。
 *
 * @module @local/chat-widget/host/home
 */

import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/** 默认数据根目录名（`~/.dsh`）。 */
const DSH_HOME_DIR_NAME = '.dsh';

/** 覆盖数据根的环境变量名。 */
const DSH_HOME_ENV = 'DSH_HOME';

/**
 * 展开开头的 `~`（只认 `~`、`~/`、`~\` 三种；`~alice` 这种一律原样返回）。
 * @param {string} path - 可能带 `~` 的路径。
 * @returns {string} 展开后的路径。
 */
export function expandHomePath(path) {
  if (path === '~') return homedir();
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2));
  return path;
}

/**
 * 解析 DSH 数据根。
 * @param {string} [configured] - 显式指定的路径（最高优先级）。
 * @param {Record<string, string|undefined>} [env] - 环境变量表（默认 `process.env`）。
 * @returns {string} 归一后的绝对路径。
 */
export function resolveDshHome(configured, env = process.env) {
  const fromEnv = env?.[DSH_HOME_ENV];
  const chosen = configured ?? (typeof fromEnv === 'string' && fromEnv.trim() !== '' ? fromEnv : join(homedir(), DSH_HOME_DIR_NAME));
  return resolve(expandHomePath(chosen));
}

/**
 * 拼一个数据根下的路径。
 * @param {...string} segments - 数据根下的子路径。
 * @returns {string} 绝对路径（不创建目录）。
 */
export function dshHomePath(...segments) {
  return join(resolveDshHome(), ...segments);
}
