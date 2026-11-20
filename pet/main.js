/**
 * 桌宠窗口 —— 外壳主进程。
 *
 * **只做四件事**：开一个透明置顶窗、按渲染进程的要求开关"鼠标穿透"、按它的要求改窗口矩形、
 * 把几何/缩放存进 `pet.json`（下次启动还原）。气泡、Live2D、TTS、SSE 全在页面里，
 * 所以这个文件薄到可以整体重写。
 *
 * 启动参数（都由 `host/pet.js` 传）：
 *   --url <页面地址>      页面由插件自己的 loopback HTTP 发（这样 Origin 是 127.0.0.1，来源栅栏不用放宽）
 *   --state <pet.json>   几何/缩放持久化文件
 *
 * 为什么页面不能是 `file://`：我们的路由有来源栅栏，`file://` 页面的 Origin 是字符串 `"null"`，
 * `isLoopbackOrigin("null")` 返回 false → 一律 403。走 loopback 就完全绕开这件事。
 */
'use strict';

const { app, BrowserWindow, ipcMain, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

/**
 * 读一个环境变量。
 *
 * **为什么用环境变量而不是命令行开关**：我们借的是 Electron 的 `default_app`，它会先扫一遍 argv
 * 再决定"要跑哪个 app 目录"。实测传 `--url <地址>` 会让它**根本不加载 app**（进程 exit -1，
 * 连 main.js 第一行都不执行），而单独传 `--state <路径>` 却没事 —— 那个开关名和它的取值撞上了它的解析。
 * 参数走环境变量就完全避开这件事，argv 里只留一个 app 目录。
 *
 * @param {string} name - 变量名。
 * @param {string} fallback - 没有时的默认值。
 * @returns {string} 值。
 */
function env(name, fallback) {
  const value = process.env[name];
  return typeof value === 'string' && value !== '' ? value : fallback;
}

const STATE_FILE = env('DSHCW_PET_STATE', path.join(__dirname, 'pet-state.json'));
const PAGE_URL = env('DSHCW_PET_URL', '');
const MIN_W = 120;
const MIN_H = 160;
const LOG_FILE = path.join(path.dirname(STATE_FILE), 'pet.log');

/**
 * 写一行日志到文件。
 *
 * 为什么要文件：**Electron 是 GUI 子系统程序，主进程的 `console.log` 在 Windows 上不进管道**，
 * 宿主那边 `spawn` 拿不到任何输出（实测：一片空白）。窗口出不来时没日志就只能瞎猜。
 *
 * @param {string} message - 内容。
 * @returns {void}
 */
function log(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, line, 'utf8');
  } catch {
    // 日志写不进去也不影响窗口
  }
  try {
    console.log(message);
  } catch {
    // 没有控制台就算了
  }
}

// 把进程级的异常也记下来（窗口白屏时最需要的就是它）
process.on('uncaughtException', (error) => { log('uncaughtException: ' + String(error && error.stack ? error.stack : error)); });
process.on('unhandledRejection', (reason) => { log('unhandledRejection: ' + String(reason)); });

/** 默认状态（第一次启动用）。 */
const DEFAULT_STATE = {
  bounds: null,
  mode: 'display',
  modelScale: 1.0,
  /**
   * 模型的**绝对摆放**（窗口坐标）：`{scale, x, y}`。`null` = 还没摆过，页面按当前窗口算一次。
   * 存绝对值而不是"相对窗口的偏移"，是为了让**改窗口大小时模型原地不动**（用户要求）。
   */
  modelPos: null,
};

let state = { ...DEFAULT_STATE };
let win = null;
let saveTimer = null;

/** 读状态文件（坏了就当没有）。 */
function loadState() {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed !== null && typeof parsed === 'object') {
      state = { ...DEFAULT_STATE, ...parsed };
    }
  } catch {
    state = { ...DEFAULT_STATE };
  }
}

/** 合并写盘（400 ms 合并，避免拖动时每帧写文件）。 */
function saveState(patch) {
  if (patch !== null && typeof patch === 'object') state = { ...state, ...patch };
  if (saveTimer !== null) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      // 顺手记下主屏的 DIP 尺寸：宿主拿它和 bounds 算"屏幕占比"，让截图引擎把桌宠那块涂掉
      // （引擎在 PowerShell 里用自己的屏幕尺寸去乘，所以 DPI 不一致也不会错位）。
      try {
        const size = screen.getPrimaryDisplay().size;
        state.display = { width: size.width, height: size.height };
      } catch {
        // 拿不到就沿用上次的
      }
      fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
      fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
    } catch (error) {
      log('写状态失败 ' + String(error));
    }
  }, 400);
}

/** 首次启动的位置：屏幕右下角，竖长条（和修复包给的默认形状一致）。 */
function defaultBounds() {
  const { workArea } = screen.getPrimaryDisplay();
  const width = 260;
  const height = Math.min(720, Math.round(workArea.height * 0.8));
  return {
    x: workArea.x + workArea.width - width - 24,
    y: workArea.y + workArea.height - height - 24,
    width,
    height,
  };
}

/** 把一份矩形夹进屏幕 + 最小尺寸。 */
function clampBounds(rect) {
  const area = screen.getDisplayNearestPoint({ x: Math.round(rect.x), y: Math.round(rect.y) }).workArea;
  const width = Math.max(MIN_W, Math.round(rect.width));
  const height = Math.max(MIN_H, Math.round(rect.height));
  const x = Math.min(Math.max(Math.round(rect.x), area.x - width + 80), area.x + area.width - 80);
  const y = Math.min(Math.max(Math.round(rect.y), area.y - height + 80), area.y + area.height - 80);
  return { x, y, width, height };
}

log('module loaded, argv=' + JSON.stringify(process.argv));
loadState();
log('state loaded: ' + JSON.stringify(state));

// 透明窗口 + 硬件加速在 Windows 上偶尔出黑底，这个开关是 Electron 官方的透明视觉开关。
app.commandLine.appendSwitch('enable-transparent-visuals');

app.whenReady().then(() => {
  const bounds = state.bounds === null ? defaultBounds() : clampBounds(state.bounds);
  win = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    transparent: true,
    frame: false,
    resizable: false,       // 地基：窗口尺寸全由页面说了算（拖边缘 → setBounds）
    hasShadow: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: false,       // 不抢焦点（WS_EX_NOACTIVATE）：鼠标照样点得到，但不激活
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  // **不要用 `setContentProtection(true)`**：它调的是 SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)，
  // 这是**进程无关的全局开关** —— 一开，QQ 截图、PrtSc、录屏、OBS 全都拍不到桌宠，
  // 而用户只是不想让"陪看的截图"拍到自己（实测反馈：加了之后连 PrtSc 都没它了）。
  // 正确做法是**只在我们自己的截图里打码**：见 `host/pet.js` 的 `writeMaskRequest()`
  // 与截图引擎里紧挨 CopyFromScreen 之后的那段 FillRectangle。
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadURL(PAGE_URL === '' ? 'about:blank' : PAGE_URL);
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => { win = null; });

  // 几何变化（用户拖动/页面改尺寸）→ 存盘
  win.on('move', () => { if (win !== null) saveState({ bounds: win.getBounds() }); });
  win.on('resize', () => { if (win !== null) saveState({ bounds: win.getBounds() }); });

  log('window ready url=' + PAGE_URL + ' bounds=' + JSON.stringify(bounds));
  win.webContents.on('did-finish-load', () => log('page loaded'));
  win.webContents.on('did-fail-load', (_e, code, desc, url) => log('page FAILED code=' + code + ' desc=' + desc + ' url=' + url));
  win.webContents.on('console-message', (_e, level, message) => log('[page] ' + message));

  // **父进程没了就自己退出**：DSH 被强杀/直接关窗时不会走到我们的 dispose，
  // 不盯着的话桌宠会变成一个没人管的孤儿窗口（看不见开关能关它，只能去任务管理器杀）。
  // 每 3 秒看一次父进程还在不在（`process.kill(pid, 0)` 只探测、不发信号）。
  const parentPid = Number(process.env.DSHCW_PET_PARENT_PID) || process.ppid;
  const orphanTimer = setInterval(() => {
    let alive = true;
    try {
      process.kill(parentPid, 0);
    } catch {
      alive = false;
    }
    if (alive === false) {
      log('父进程 ' + parentPid + ' 没了，自己退出');
      clearInterval(orphanTimer);
      app.quit();
    }
  }, 3000);
  orphanTimer.unref?.();
});

// ── IPC：渲染进程要的四件事 ────────────────────────────────────────────
ipcMain.handle('pet:config', () => ({
  state,
  bounds: win === null ? null : win.getBounds(),
  pageUrl: PAGE_URL,
}));

ipcMain.on('pet:set-ignore', (_event, ignore) => {
  if (win === null) return;
  // forward:true 是逐像素命中的前提：穿透状态下仍能收到 mousemove（实测有效）。
  win.setIgnoreMouseEvents(ignore === true, { forward: true });
});

ipcMain.handle('pet:set-bounds', (_event, rect) => {
  if (win === null || rect === null || typeof rect !== 'object') return null;
  const next = clampBounds(rect);
  win.setBounds(next);
  saveState({ bounds: next });
  return next;
});

ipcMain.handle('pet:get-bounds', () => (win === null ? null : win.getBounds()));

ipcMain.on('pet:save-state', (_event, patch) => { saveState(patch); });

ipcMain.on('pet:quit', () => { app.quit(); });
