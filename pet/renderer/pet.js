/**
 * 桌宠窗口 —— 渲染进程（页面）。
 *
 * 干的活：把 Live2D 模型渲出来、**逐像素判断鼠标是不是在模型身上**（不在就穿透到桌面）、
 * 拖动窗口、绿幕调整模式、气泡、订阅"它主动开口"、说话时出声。
 *
 * 三条关键设计（都是实测结论，别改回去）：
 *   1. **穿透用 `setIgnoreMouseEvents(true, {forward:true})`**：`forward` 让页面在"穿透"状态下
 *      仍能收到 `mousemove`（实测 20/20 收到、点击 0/0 收到），否则一旦穿透就再也判断不出"回来了"。
 *   2. **拖动不能用 `-webkit-app-region: drag`**：那是按元素矩形注册的系统拖动区，会把透明部分也变成
 *      可拖区，跟逐像素命中直接打架。这里改成手动 `setBounds`。
 *   3. **命中判定用膨胀 5 px 的邻域**：鼠标快速掠过边缘时宁可判宽一点，避免"点空了"。
 */
'use strict';

const shell = window.petShell;
const bubbleEl = document.getElementById('bubble');
const errorEl = document.getElementById('error');

/** 页面里的运行状态。 */
const runtime = {
  editMode: false,
  modelScale: 1.0,
  app: null,
  model: null,
  mask: null,        // { width, height, data }：alpha 蒙版
  ignoring: null,    // 当前是否已让窗口穿透（null = 还没设过）
  /**
   * 模型的**绝对摆放**（窗口坐标、像素）。
   *
   * 为什么不是"相对窗口高度"：用户要求**改窗口大小时模型不跟着变**。
   * 所以模型只在"首次摆放 / 改缩放 / 拖动"时重新定位，窗口 resize 一律不动它。
   * `scale` 是对模型自然尺寸的倍率；`x/y` 是左上角。
   */
  placement: null,
  /** 气泡位置：'top' | 'bottom' */
  bubblePosition: 'top',
  tts: true,
  audio: new Audio(),
  /** 当前用的模型 id（= `assets/live2d/` 下的文件夹名）。 */
  modelId: '',
  /** 当前模型的目录（`assets/live2d/<名字>`），取动作时长要用。 */
  modelBase: '',
  /** 拖拽时把动画冻住了（ticker 停着）。 */
  frozen: false,
  /** 拖拽"该停在半路"的时间点；`bouncePending` = 还在等这个点（由 ticker 每帧检查）。 */
  bounceAt: 0,
  bouncePending: false,
  /** 鼠标这次悬停在"上半身"上，是否还没触发过"缩一下"。 */
  pokeArmed: true,
  /** 「缩一下」正在放（鼠标移开要收掉）。 */
  pokeActive: false,
  /** 现有模型清单（宿主扫出来的）：`[{id, name, src}]`。 */
  models: [],
  /** 正在切换中的模型 id（防止每 2 秒轮询重复发起同一次换模型）。 */
  pendingModel: '',
};

/**
 * 在页面上显示一段错误（透明窗口里没法看控制台）。
 * @param {string} message - 错误信息。
 * @returns {void}
 */
function fail(message) {
  document.body.classList.add('failed');
  errorEl.textContent = `桌宠加载失败\n\n${message}\n\n（窗口里的内容不会影响聊天，修好后刷新页面即可）`;
}

/** 现在是不是绿幕调整模式。 */
function applyMode() {
  document.body.classList.toggle('edit', runtime.editMode);
  document.body.classList.toggle('bubbleTop', runtime.bubblePosition !== 'bottom');
  document.body.classList.toggle('bubbleBottom', runtime.bubblePosition === 'bottom');
  if (runtime.editMode === true) {
    setIgnore(false);
  }
}

/**
 * 让窗口穿透（或恢复可点）。
 * @param {boolean} ignore - true = 点到桌面去。
 * @returns {void}
 */
function setIgnore(ignore) {
  if (runtime.ignoring === ignore) return;
  runtime.ignoring = ignore;
  shell.setIgnore(ignore);
  // 只在**状态变化**时记一行：出问题时能一眼看出"到底判没判到模型身上"
  console.log(`[pet] ${ignore === true ? 'miss → 穿透' : 'hit → 可点'}`);
}

/**
 * 把模型按**已记录的绝对摆放**画出来（不读窗口尺寸）。
 *
 * 只在三个时机调用：首次摆放、改缩放、拖动模型。**窗口 resize 不调用** ——
 * 用户要求改绿幕窗口大小时模型的大小和位置都别动。
 *
 * @returns {void}
 */
function paintModel() {
  if (runtime.model === null || runtime.placement === null) return;
  const p = runtime.placement;
  runtime.model.scale.set(p.scale);
  runtime.model.x = p.x;
  runtime.model.y = p.y;
  // 冻住的时候 ticker 停着、画布不会自己刷新 —— 拖动要手动渲一帧，否则画面跟不上鼠标
  if (runtime.frozen === true && runtime.app !== null) runtime.app.renderer.render(runtime.app.stage);
}

/**
 * 重新摆放模型（首次 / 改缩放时用）：按**当前**窗口高度算大小，底边贴底、水平居中。
 *
 * 摆好之后就把结果记进 `runtime.placement`，之后窗口怎么变都不再重算。
 *
 * @param {boolean} keepCenter - true = **保持模型中心不动**（改缩放时用）。
 *   用户反馈：原来保持左上角不动，缩放时是"从左上角那块空白往外长"，很难对位；
 *   改成以**中心**为锚点缩放，手感就对了。
 * @returns {void}
 */
function placeModel(keepCenter) {
  if (runtime.model === null) return;
  runtime.model.scale.set(1);
  const natural = runtime.model.height;
  if (!(natural > 0)) return;
  const height = window.innerHeight;
  const width = window.innerWidth;
  const scale = (height * 0.9 * runtime.modelScale) / natural;
  runtime.model.scale.set(scale);
  const old = runtime.placement;
  const keep = keepCenter === true && old !== null;
  let x;
  let y;
  if (keep === true) {
    // 用**旧尺寸**算中心（旧 scale 下的宽高），再让新尺寸围绕这个中心摆
    const oldW = (old.w === undefined ? runtime.model.width : old.w);
    const oldH = (old.h === undefined ? runtime.model.height : old.h);
    const centerX = old.x + oldW / 2;
    const centerY = old.y + oldH / 2;
    x = centerX - runtime.model.width / 2;
    y = centerY - runtime.model.height / 2;
  } else {
    x = width / 2 - runtime.model.width / 2;
    y = height - runtime.model.height;
  }
  runtime.placement = { scale, x, y, w: runtime.model.width, h: runtime.model.height };
  paintModel();
}

/**
 * 重新生成 alpha 蒙版。
 *
 * **坑（实测翻车过）**：不能用 `renderer.render(stage, {renderTexture})` —— 渲染到 RenderTexture
 * 时用的是 **RT 自己的投影**（0,0,width,height），而模型是按**窗口坐标**摆的（居中、贴底），
 * 结果整张 RT 全透明，命中判定永远 false（表现为"怎么点都没反应、鼠标永远穿透"）。
 * `extract.pixels({resolution})` 才是"把当前画面按比例缩下来读"，坐标映射才对得上。
 *
 * @returns {void}
 */
function refreshMask() {
  if (runtime.app === null || runtime.model === null) return;
  try {
    const width = Math.max(1, Math.round(window.innerWidth * 0.25));
    const height = Math.max(1, Math.round(window.innerHeight * 0.25));
    const PIXI = window.PIXI;
    const target = PIXI.RenderTexture.create({ width, height });
    // **必须带 transform**：不带的话渲染到 RT 用的是 RT 自己的投影，模型（按窗口坐标摆的）
    // 整个落在 RT 外面 → 蒙版全透明 → 命中永远 false。带上"把窗口缩到 RT 大小"的缩放才对得上。
    const transform = new PIXI.Matrix().scale(width / Math.max(1, window.innerWidth), height / Math.max(1, window.innerHeight));
    runtime.app.renderer.render(runtime.app.stage, { renderTexture: target, transform });
    const pixels = runtime.app.renderer.extract.pixels(target);
    runtime.mask = { width, height, data: pixels };
    target.destroy(true);
  } catch (error) {
    // 蒙版失败不致命：退回"整窗可点"（宁可挡一点桌面，也别让桌宠点不动）
    runtime.mask = null;
    console.warn('[pet] 生成命中蒙版失败', String(error));
  }
}

/**
 * 这个窗口坐标是不是在模型身上。
 * @param {number} x - 窗口内 x（CSS px）。
 * @param {number} y - 窗口内 y（CSS px）。
 * @returns {boolean} 是否命中。
 */
function isOnModel(x, y) {
  // **绿幕下也要按蒙版判**：不然"拖模型"和"拖绿幕"就分不开了（实测踩过这个坑）。
  // 蒙版没建好时返回 true：宁可判成"在模型上"，也别让鼠标点不动。
  const mask = runtime.mask;
  if (mask === null) return true;
  const width = window.innerWidth;
  const height = window.innerHeight;
  const mx = Math.round((x / Math.max(1, width)) * mask.width);
  const my = Math.round((y / Math.max(1, height)) * mask.height);
  // 膨胀 2 格（≈ 5 px）的邻域：边缘更好抓
  for (let dy = -2; dy <= 2; dy += 1) {
    for (let dx = -2; dx <= 2; dx += 1) {
      const px = mx + dx;
      const py = my + dy;
      if (px < 0 || py < 0 || px >= mask.width || py >= mask.height) continue;
      const alpha = mask.data[(py * mask.width + px) * 4 + 3];
      if (alpha > 24) return true;
    }
  }
  return false;
}

// ── 待机小动作：随机表情 + 虚拟视线 ──────────────────────────────────
//
// 用户 2026-11-20 定的规矩：
//   · 视线**不跟鼠标**（模型本来就没开 autoInteract）——待机时自己"偶尔"看屏幕别处；
//   · 每次看 2–5 秒；视点随机，可以是固定的一点，也可以是缓慢移动的一点；
//   · 待机时随机换个表情，过一会儿再收回默认脸。
//
// 两个实现细节（踩过才知道）：
//   1. `model.focus(x, y)` 内部是**取角度**的（`atan2` 之后只留方向），所以"回正前方"不能用
//      `focus(中心点)` —— 那会算成 0 角度 = 看最右边。回正必须直接给 `focusController.focus(0, 0)`。
//   2. 换模型时要先把这些定时器停掉，否则旧模型的回调会追着已销毁的对象跑。
const idle = {
  model: null,
  expressions: [],
  exprTimer: null,
  exprBackTimer: null,
  gazeTimer: null,
  /** 正在进行的一次"看别处"：`{from, to, t0, dur, moving}`；null = 正前方。 */
  episode: null,
  /** 视线的当前位置/目标（归一化方向），由 ticker 每帧缓动。 */
  gaze: { x: 0, y: 0, tx: 0, ty: 0 },
};

/** 视线：隔多久看一次（毫秒）—— 用户 2026-11-20 改成 10~60 秒。 */
const IDLE_GAZE_GAP_MIN = 10000;
const IDLE_GAZE_GAP_MAX = 60000;
/** 一次看多久：用户要的 2–5 秒。 */
const IDLE_GAZE_MIN_MS = 2000;
const IDLE_GAZE_MAX_MS = 5000;
/**
 * 视线**转过去 / 收回来**的缓动时间常数（毫秒，越大越慢）。
 *
 * 用户反馈"头转得太快"。原来用的是库自带的弹簧（约 200ms 就到位），现在自己缓动：
 * 指数逼近，τ=420ms 大约把速度压到原来的一半（95% 到位约 1.25 秒）。
 * 想更慢就加大这个数。
 */
const GAZE_TURN_TAU_MS = 420;
/** 表情：隔多久换一次 / 停留多久。 */
const IDLE_EXPR_GAP_MIN = 7000;
const IDLE_EXPR_GAP_MAX = 18000;
const IDLE_EXPR_HOLD_MIN = 2500;
const IDLE_EXPR_HOLD_MAX = 5000;

/** 取 [min, max] 之间的随机数。 */
function rand(min, max) {
  return min + Math.random() * (max - min);
}

/** 停掉所有待机定时器（换模型 / 收摊时用）。 */
function stopIdle() {
  if (idle.gazeTimer !== null) { clearTimeout(idle.gazeTimer); idle.gazeTimer = null; }
  if (idle.exprTimer !== null) { clearTimeout(idle.exprTimer); idle.exprTimer = null; }
  if (idle.exprBackTimer !== null) { clearTimeout(idle.exprBackTimer); idle.exprBackTimer = null; }
  idle.episode = null;
  idle.gaze.tx = 0;
  idle.gaze.ty = 0;
  idle.model = null;
}

/** 随机挑一个方向：横向为主、纵向收敛，避免翻白眼那种角度。 */
function randomDirection() {
  const x = (Math.random() < 0.5 ? -1 : 1) * rand(0.25, 1);
  const y = rand(-0.7, 0.7);
  const len = Math.hypot(x, y) || 1;
  return { x: x / len, y: y / len };
}

/** 安排"下一次看别处"。 */
function scheduleGaze(model) {
  if (idle.model !== model) return;
  idle.gazeTimer = setTimeout(() => {
    idle.gazeTimer = null;
    if (idle.model !== model) return;
    startGaze(model);
  }, rand(IDLE_GAZE_GAP_MIN, IDLE_GAZE_GAP_MAX));
}

/**
 * 看一次：时长随机 2–5 秒；一半概率是**盯住一个点**，一半是**慢慢移到另一个点**。
 *
 * 这里只登记"这一趟要看哪儿"，真正的缓动在 {@link updateGaze} 里按帧跑
 * —— 这样"转过去"和"收回来"用的是同一条曲线，速度也可控。
 */
function startGaze(model) {
  const dur = rand(IDLE_GAZE_MIN_MS, IDLE_GAZE_MAX_MS);
  const moving = Math.random() < 0.5;
  const from = randomDirection();
  idle.episode = { model, from, to: moving === true ? randomDirection() : from, t0: performance.now(), dur };
  idle.gazeTimer = setTimeout(() => {
    idle.gazeTimer = null;
    if (idle.model !== model) return;
    // 结束：目标回到正前方，由 updateGaze 慢慢收回去
    idle.episode = null;
    idle.gaze.tx = 0;
    idle.gaze.ty = 0;
    scheduleGaze(model);
  }, dur);
}

/**
 * 每帧推进视线（在 ticker 里调）。
 *
 * @param {number} deltaMS - 距上一帧的毫秒数。
 * @returns {void}
 */
function updateGaze(deltaMS) {
  const model = idle.model;
  if (model === null) return;
  const episode = idle.episode;
  if (episode !== null && episode.model === model) {
    const k = Math.min(1, (performance.now() - episode.t0) / episode.dur);
    // 方向之间做插值（再归一化），视线就是"滑"过去的，不是跳过去的
    const x = episode.from.x + (episode.to.x - episode.from.x) * k;
    const y = episode.from.y + (episode.to.y - episode.from.y) * k;
    const len = Math.hypot(x, y) || 1;
    idle.gaze.tx = x / len;
    idle.gaze.ty = y / len;
  }
  // 指数逼近：和帧率无关，慢在这里（TAU 越大越慢）
  const step = 1 - Math.exp(-Math.max(0, deltaMS) / GAZE_TURN_TAU_MS);
  const g = idle.gaze;
  g.x += (g.tx - g.x) * step;
  g.y += (g.ty - g.y) * step;
  if (Math.abs(g.tx - g.x) < 0.002) g.x = g.tx;
  if (Math.abs(g.ty - g.y) < 0.002) g.y = g.ty;
  try {
    // `instant` = 不再让库自己再加一层弹簧（那一层就是"转太快"的来源）
    model.internalModel.focusController.focus(g.x, g.y, true);
  } catch {
    // 模型换了，忽略
  }
}

/** 换一个随机表情，停一会儿再收回去。 */
function applyRandomExpression(model) {
  if (idle.model !== model || idle.expressions.length === 0) return;
  // 正在说话就别换脸了（气泡亮着 = 它这会儿在"讲话"）
  if (bubbleEl.classList.contains('show') === true) return;
  const name = idle.expressions[Math.floor(Math.random() * idle.expressions.length)];
  try {
    model.expression(name);
  } catch {
    return;
  }
  idle.exprBackTimer = setTimeout(() => {
    idle.exprBackTimer = null;
    if (idle.model !== model) return;
    try {
      const manager = model.internalModel.motionManager.expressionManager;
      if (manager !== null && manager !== undefined) manager.resetExpression();
    } catch {
      // 忽略
    }
  }, rand(IDLE_EXPR_HOLD_MIN, IDLE_EXPR_HOLD_MAX));
}

/** 安排"下一次换表情"。 */
function scheduleExpression(model) {
  if (idle.model !== model || idle.expressions.length === 0) return;
  idle.exprTimer = setTimeout(() => {
    idle.exprTimer = null;
    if (idle.model !== model) return;
    applyRandomExpression(model);
    scheduleExpression(model);
  }, rand(IDLE_EXPR_GAP_MIN, IDLE_EXPR_GAP_MAX));
}

/** 给刚加载的模型挂上待机小动作（换模型时会先停旧的）。 */
function startIdle(model) {
  stopIdle();
  idle.model = model;
  // 表情名从模型自带的清单里取：没表情的模型（比如桃濑日和）这块自然就是空的
  let names = [];
  try {
    const manager = model.internalModel.motionManager.expressionManager;
    const definitions = manager !== null && manager !== undefined ? manager.definitions : null;
    if (Array.isArray(definitions) === true) {
      names = definitions.map((item) => (item !== null && typeof item === 'object' ? item.Name ?? item.name : '')).filter((n) => typeof n === 'string' && n !== '');
    }
  } catch {
    names = [];
  }
  // 待机只挑**看得懂是"心情"的**那几个：微笑/闭眼笑/害羞/得意/困惑/困倦/惊讶。
  // 「悲伤」「生气」不放进待机池 —— 没有前因的脸，看上去像在替你摆脸色（用户让挑的时候定的）。
  const preferred = ['微笑', '闭眼笑', '害羞', '得意', '困惑', '困倦', '惊讶'];
  const picked = names.filter((name) => preferred.includes(name));
  idle.expressions = picked.length > 0 ? picked : names;
  // 归位：视线先把目标清零（ticker 会把当前位置慢慢收回去，不会"啪"一下转正）
  idle.gaze.tx = 0;
  idle.gaze.ty = 0;
  idle.episode = null;
  scheduleGaze(model);
  scheduleExpression(model);
}

// ── 口型：说话时嘴巴跟着 TTS 的声音动 ────────────────────────────────
//
// 三个关键点：
//   1. 用 Web Audio 的 AnalyserNode 读**真实音量**（不是瞎编的节奏），嘴型和声音对得上；
//   2. 写参数必须在 `beforeModelUpdate` 那一刻 —— 动作和表情**都已经算完**、`coreModel.update()`
//      还没执行，所以口型**永远压过表情**（用户要求的"始终优先，不受表情干扰"）；
//   3. 每帧末尾框架会 `loadParameters()` 还原，我们写进去的值不会残留到下一帧。
const LIP_SYNC_GAIN = 3.4;
/** 张开快、合上慢一点，看起来才像说话（0–1 的每帧混合系数）。 */
const LIP_ATTACK = 0.55;
const LIP_RELEASE = 0.18;

const lip = { analyser: null, data: null, ctx: null, failed: false, value: 0 };

/** 给 `<audio>` 接上分析节点（只接一次；接不上就退回估算节奏）。 */
function ensureAnalyser() {
  if (lip.analyser !== null || lip.failed === true) return;
  try {
    const Ctx = window.AudioContext ?? window.webkitAudioContext;
    if (Ctx === undefined) throw new Error('没有 Web Audio');
    const ctx = new Ctx();
    const source = ctx.createMediaElementSource(runtime.audio);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);
    analyser.connect(ctx.destination);
    lip.ctx = ctx;
    lip.analyser = analyser;
    lip.data = new Uint8Array(analyser.fftSize);
    // 自动播放策略下 AudioContext 可能挂在 suspended：不 resume 的话分析出来全是 0，嘴不会动
    if (ctx.state === 'suspended') void ctx.resume().catch(() => {});
  } catch (error) {
    lip.failed = true;
    console.warn('[pet] 音频分析接不上，口型改用估算', String(error));
  }
}

/** 现在嘴巴该张多大（0–1）。 */
function lipSyncTarget() {
  const audio = runtime.audio;
  if (audio.paused === true || audio.ended === true || audio.currentTime <= 0) return 0;
  // 只在**真的在跑**的时候用分析数据；挂起 / 接不上就退回估算节奏，至少嘴会动
  if (lip.analyser !== null && lip.data !== null && lip.ctx !== null && lip.ctx.state === 'running') {
    lip.analyser.getByteTimeDomainData(lip.data);
    let sum = 0;
    for (let i = 0; i < lip.data.length; i += 1) {
      const v = (lip.data[i] - 128) / 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / lip.data.length);
    return Math.min(1, rms * LIP_SYNC_GAIN);
  }
  // 兜底：接不上分析节点时按播放时间造个说话节奏（有起伏就行）
  const t = audio.currentTime;
  return Math.min(1, Math.max(0, 0.5 + 0.45 * Math.sin(t * 17.3) * Math.sin(t * 6.1)));
}

/** 每帧更新一次口型值（在 beforeModelUpdate 里调）。 */
function updateLipSync() {
  const target = lipSyncTarget();
  const rate = target > lip.value ? LIP_ATTACK : LIP_RELEASE;
  lip.value += (target - lip.value) * rate;
  if (lip.value < 0.004) lip.value = 0;
}

/** 给模型挂上口型钩子（换模型时重新挂）。 */
function attachLipSync(model) {
  const internal = model.internalModel;
  if (internal === null || internal === undefined || typeof internal.on !== 'function') return;
  let ids = ['ParamMouthOpenY'];
  try {
    const fromSettings = internal.settings !== null && internal.settings !== undefined
      && typeof internal.settings.getLipSyncParameters === 'function'
      ? internal.settings.getLipSyncParameters()
      : null;
    if (Array.isArray(fromSettings) === true && fromSettings.length > 0) ids = fromSettings;
  } catch {
    // 用默认的 ParamMouthOpenY
  }
  internal.on('beforeModelUpdate', () => {
    updateLipSync();
    if (lip.value <= 0.004) return;
    for (const id of ids) {
      try {
        internal.coreModel.setParameterValueById(id, lip.value);
      } catch {
        // 这个模型没这个参数，忽略
      }
    }
  });
}

// ── 小反应：鼠标凑到头部/上半身"缩一下"；拖她的时候"弹一下" ────────────

/**
 * 这个窗口坐标是不是落在**头部或上半身**。
 *
 * 判定用"模型自身的坐标"：先按 `placement` 把屏幕坐标换算回模型自然尺寸，
 * 再取竖向 0–45%、横向中间 ±30%（避开两侧飘着的长发）。
 *
 * @param {number} x - 窗口内 x。
 * @param {number} y - 窗口内 y。
 * @returns {boolean} 是不是上半身。
 */
function isUpperBody(x, y) {
  const p = runtime.placement;
  const model = runtime.model;
  if (p === null || model === null || !(p.scale > 0)) return false;
  // **注意**：`model.width/height` 是**已经缩放过的**尺寸（= 画在屏幕上的大小），
  // 所以这里直接在屏幕坐标里算差值 —— 千万别再除以 `p.scale`。
  // （之前混着用：坐标除成了模型自然尺寸，阈值却是缩放后的，导致判定区偏到左半边、横竖都对不上，
  //   表现就是"鼠标放她头上完全没反应"。）
  const w = model.width;
  const h = model.height;
  const localX = x - p.x;
  const localY = y - p.y;
  if (!(localY >= 0 && localY <= h * 0.45)) return false;
  return Math.abs(localX - w / 2) <= w * 0.3;
}

/** 从候选里挑第一个模型真有这个动作的组（没有就返回空串）。 */
function pickMotionGroup(model, candidates) {
  try {
    const definitions = model.internalModel.motionManager.definitions;
    if (definitions === null || definitions === undefined) return '';
    for (const name of candidates) {
      if (Array.isArray(definitions[name]) === true && definitions[name].length > 0) return name;
    }
  } catch {
    // 忽略
  }
  return '';
}

/**
 * 被鼠标"戳"到：**立刻截断**正在跑的动作，直接缩一下。
 *
 * 用户 2026-11-20 的要求：不要等当前动作放完、也不要排队 —— 直接打断。
 * 所以先 `stopAllMotions()`，再用 **FORCE(3)** 优先级起动作，压过待机/眨眼。
 */
function pokeRecoil() {
  const model = runtime.model;
  if (model === null || runtime.frozen === true) return;
  const group = pickMotionGroup(model, ['Recoil', 'Surprise', 'Shake']);
  if (group === '') return;
  try {
    const manager = model.internalModel.motionManager;
    if (manager !== null && typeof manager.stopAllMotions === 'function') manager.stopAllMotions();
    model.motion(group, 0, 3);
    runtime.pokeActive = true;
  } catch {
    // 动作坏了不影响别的
  }
}

/** 鼠标移开：把"缩一下"收掉，回到待机（用户要求"移开后重置"）。 */
function resetPoke() {
  if (runtime.pokeActive !== true) return;
  runtime.pokeActive = false;
  const model = runtime.model;
  if (model === null) return;
  try {
    const manager = model.internalModel.motionManager;
    if (manager !== null && typeof manager.stopAllMotions === 'function') manager.stopAllMotions();
    model.motion('Idle', 0, 1);
  } catch {
    // 忽略
  }
}

/** 动作时长缓存（`url` → 毫秒）：从 motion3.json 的 `Meta.Duration` 读。 */
const motionDurations = new Map();

/**
 * 读一个动作的总时长（毫秒）。
 *
 * @param {object} model - 模型。
 * @param {string} group - 动作组。
 * @param {number} index - 第几个。
 * @returns {Promise<number>} 毫秒；读不到给 600。
 */
async function motionDurationMs(model, group, index) {
  try {
    const settings = model.internalModel.settings;
    const list = settings !== null && settings !== undefined && settings.motions !== undefined ? settings.motions[group] : null;
    const entry = Array.isArray(list) === true ? list[index] : null;
    const file = entry !== null && entry !== undefined && typeof entry.File === 'string' ? entry.File : '';
    if (file === '') return 600;
    const base = typeof runtime.modelBase === 'string' ? runtime.modelBase : '';
    const url = `${base}/${file}`;
    if (motionDurations.has(url) === true) return motionDurations.get(url);
    const response = await fetch(url);
    if (response.ok !== true) return 600;
    const data = await response.json();
    const seconds = Number(data !== null && typeof data === 'object' && data.Meta !== undefined ? data.Meta.Duration : NaN);
    const ms = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 600;
    motionDurations.set(url, ms);
    return ms;
  } catch {
    return 600;
  }
}

/**
 * 把一个模型**所有**动作的时长先读出来（一次性，总共几十 KB）。
 *
 * 为什么不在拖拽那一刻才读：读文件是异步的，等它回来动作可能都放完了 ——
 * 那样"播到一半停住"就变成了"播完了才停"。预读之后拖拽是**同步**拿到时长的。
 *
 * @param {object} model - 模型。
 * @returns {Promise<void>} 完成。
 */
async function preloadMotionDurations(model) {
  try {
    const settings = model.internalModel.settings;
    const motions = settings !== null && settings !== undefined ? settings.motions : null;
    if (motions === null || typeof motions !== 'object') return;
    const jobs = [];
    for (const group of Object.keys(motions)) {
      const list = motions[group];
      if (Array.isArray(list) !== true) continue;
      for (let index = 0; index < list.length; index += 1) {
        jobs.push(motionDurationMs(model, group, index));
      }
    }
    await Promise.all(jobs);
  } catch {
    // 读不到就用兜底时长，不影响别的
  }
}

/**
 * 拖她的时候"弹一下"：播到**一半**停住，松手落到位置上再放完。
 *
 * 停住的实现是**停掉整个 ticker**（呼吸、眨眼一起定住 —— 被拎在手里本来也该定住），
 * 拖动过程中靠 `paintModel` 手动渲染，画面照样跟着鼠标走。
 *
 * @returns {Promise<void>} 完成。
 */
async function startDragBounce() {
  // 绿幕（调整模式）里不要这套反应 —— 用户要求：那里是编辑，不是玩
  if (runtime.editMode === true) return;
  const model = runtime.model;
  if (model === null || runtime.frozen === true) return;
  const group = pickMotionGroup(model, ['Bounce', 'Surprise', 'Shake']);
  if (group === '') return;
  try {
    model.motion(group, 0);
  } catch {
    return;
  }
  const total = await motionDurationMs(model, group, 0);
  if (runtime.frozen === true) return;
  // **不用 setTimeout**：后台标签 / 掉帧会让定时器晚到，动作都放完了才停（实测晚了 1.7 秒）。
  // 改成记一个时间点，由 ticker 每帧检查 —— 停在哪一帧就是哪一帧。
  runtime.bounceAt = performance.now() + Math.max(120, total * 0.5);
  runtime.bouncePending = true;
}

/** 每帧检查"该不该停在半路"（在 ticker 里调）。 */
function tickBounce() {
  if (runtime.bouncePending !== true) return;
  if (drag === null || drag.onModel !== true) {
    runtime.bouncePending = false;
    return;
  }
  if (performance.now() < runtime.bounceAt) return;
  runtime.bouncePending = false;
  freezeModel();
}

/** 冻住（ticker 停 = 动作停在当前帧）。 */
function freezeModel() {
  if (runtime.app === null || runtime.frozen === true) return;
  runtime.frozen = true;
  runtime.app.ticker.stop();
  runtime.app.renderer.render(runtime.app.stage);
}

/** 解冻（松手后把剩下半个动作放完）。 */
function thawModel() {
  runtime.bouncePending = false;
  if (runtime.app === null || runtime.frozen !== true) return;
  runtime.frozen = false;
  runtime.app.ticker.start();
}


/** 读宿主配置（页面和 API 同源，直接相对路径取）。 */
async function readHostConfig() {
  try {
    const response = await fetch('config', { headers: { accept: 'application/json' } });
    if (response.ok !== true) return null;
    const data = await response.json();
    return data !== null && typeof data === 'object' ? data.config : null;
  } catch {
    return null;
  }
}

/**
 * 从宿主配置里挑出该用的模型。
 *
 * 存的文件夹被删了 → 退回清单里的第一个（宿主已经帮我们 resolve 过一次，这里再兜一层）。
 *
 * @param {object|null} config - `/pet/config` 的 `config` 段。
 * @returns {{id: string, name: string, src: string}|null} 该加载的模型；一个都没有时是 null。
 */
function pickModel(config) {
  const models = config !== null && Array.isArray(config.models) ? config.models : [];
  runtime.models = models.filter((item) => item !== null && typeof item === 'object');
  const id = config !== null && typeof config.model === 'string' ? config.model : '';
  const hit = runtime.models.find((item) => item.id === id);
  return hit ?? runtime.models[0] ?? null;
}

/** 把某个模型加载进来；换模型时先把旧的卸掉。 */
async function loadModel(entry) {
  const PIXI = window.PIXI;
  const url = `assets/${entry.src}`;
  const next = await PIXI.live2d.Live2DModel.from(url, {
    autoInteract: false,
    idleMotionGroup: 'Idle',
  });
  const old = runtime.model;
  if (old !== null) {
    runtime.app.stage.removeChild(old);
    old.destroy();
  }
  // 模型目录（读动作时长用）：`assets/live2d/朝那玲`
  runtime.modelBase = url.slice(0, url.lastIndexOf('/'));
  lip.value = 0;
  attachLipSync(next);
  runtime.model = next;
  runtime.modelId = entry.id;
  runtime.app.stage.addChild(next);
  // 动作切换后蒙版会变（呼吸/眨眼影响很小，但换动作会）
  next.internalModel?.on?.('motionStart', () => { refreshMask(); });
  // 先把动作时长读出来（拖拽"停在一半"要用；异步预热，不等它）
  void preloadMotionDurations(next);
  startIdle(next);
  return next;
}

/** 起 Live2D。 */
async function startModel() {
  const config = await shell.config();
  runtime.editMode = config.state.mode === 'edit';
  runtime.modelScale = Number(config.state.modelScale) > 0 ? Number(config.state.modelScale) : 1.0;
  runtime.tts = config.state.tts !== false;
  runtime.bubblePosition = config.state.bubblePosition === 'bottom' ? 'bottom' : 'top';
  runtime.savedPos = config.state.modelPos;
  const savedOffset = config.state.modelOffset;
  runtime.savedOffset = savedOffset !== null && typeof savedOffset === 'object'
    ? { x: Number(savedOffset.x) || 0, y: Number(savedOffset.y) || 0 }
    : { x: 0, y: 0 };

  const PIXI = window.PIXI;
  if (PIXI === undefined || PIXI.live2d === undefined || PIXI.live2d.Live2DModel === undefined) {
    fail('pixi / pixi-live2d-display / Cubism Core 没加载起来（检查 pet/assets/vendor 里的三个文件）');
    return;
  }
  PIXI.live2d.Live2DModel.registerTicker(PIXI.Ticker);

  const stage = document.getElementById('stage');
  runtime.app = new PIXI.Application({
    backgroundAlpha: 0,
    transparent: true,
    resizeTo: window,
    antialias: true,
    autoDensity: true,
    powerPreference: 'low-power',
  });
  stage.appendChild(runtime.app.view);
  runtime.app.view.style.width = '100%';
  runtime.app.view.style.height = '100%';

  // 每帧推进视线缓动（拖拽时 ticker 会停 —— 那时她也该定住）
  runtime.app.ticker.add(() => {
    updateGaze(runtime.app.ticker.deltaMS);
    tickBounce();
  });

  // 用哪个模型**由宿主说了算**：`/pet/config` 给当前 id + 现有清单，
  // 设置面板点一下就换（页面每 2 秒轮询一次，见 watchConfig）。
  const host = await readHostConfig();
  const picked = pickModel(host);
  if (picked === null) {
    fail('一个模型都没有：把模型文件夹放进 pet/assets/live2d/ 就行（文件夹名 = 界面上的名字）');
    return;
  }
  try {
    await loadModel(picked);
  } catch (error) {
    fail(`模型加载失败（${picked.id}）：${String(error)}`);
    return;
  }
  // 摆放：有存过的绝对位置就用它（**不随窗口变化重算**），否则按当前窗口摆一次
  const savedPos = runtime.savedPos;
  if (savedPos !== null && typeof savedPos === 'object'
    && Number(savedPos.scale) > 0 && Number.isFinite(Number(savedPos.x)) && Number.isFinite(Number(savedPos.y))) {
    runtime.placement = { scale: Number(savedPos.scale), x: Number(savedPos.x), y: Number(savedPos.y) };
    paintModel();
  } else {
    placeModel(false);
    // 老版本只存了"相对居中贴底"的偏移：迁移成绝对位置
    const legacy = runtime.savedOffset;
    if (legacy !== undefined && (legacy.x !== 0 || legacy.y !== 0)) {
      runtime.placement.x += legacy.x;
      runtime.placement.y += legacy.y;
      paintModel();
    }
  }
  refreshMask();

  // **窗口 resize 只刷蒙版，不动模型**（用户要求：改窗口大小时模型大小/位置都不变）
  window.addEventListener('resize', () => {
    refreshMask();
  });

  // 兜底：每 2 秒刷一次蒙版（模型有呼吸动画，形状会微变）
  setInterval(() => { refreshMask(); }, 2000);
}

// ── 鼠标：逐像素命中 → 穿透 / 可点 ────────────────────────────────────
document.addEventListener('mousemove', (event) => {
  if (runtime.editMode === true) {
    setIgnore(false);
    runtime.pokeArmed = true;
    return;
  }
  const hit = isOnModel(event.clientX, event.clientY);
  setIgnore(hit !== true);
  document.body.style.cursor = hit === true ? 'grab' : 'default';
  // 鼠标凑到**头部/上半身**："被戳"缩一下。一次悬停只触发一次 ——
  // 判定到就上锁，等鼠标真的离开模型（或退出上半身）再解锁，否则会一直缩。
  if (hit === true && drag === null && isUpperBody(event.clientX, event.clientY) === true) {
    if (runtime.pokeArmed === true) {
      runtime.pokeArmed = false;
      pokeRecoil();
    }
  } else if (hit !== true || isUpperBody(event.clientX, event.clientY) !== true) {
    runtime.pokeArmed = true;
    resetPoke();
  }
});

// 离开窗口：让出去（不然鼠标走了窗口还占着点击）
document.addEventListener('mouseleave', () => {
  if (runtime.editMode !== true) setIgnore(true);
  runtime.pokeArmed = true;
  resetPoke();
});

// ── 拖动：绿幕里拖模型 / 拖绿幕搬窗口 / 拖手柄改大小 ────────────────────
let drag = null;

/**
 * 开始一次拖拽。
 *
 * @param {PointerEvent} event - 事件。
 * @param {string} kind - `'move'`（搬窗口）/ `'model'`（挪模型）/ 手柄名（n/s/e/w/nw/ne/sw/se）。
 * @param {boolean} [onModel] - 按下时是不是在她身上（决定要不要"弹一下"）。
 * @returns {Promise<void>} 完成。
 */
async function beginDrag(event, kind, onModel) {
  if (kind === 'model') {
    // 挪模型不动窗口：记住起始偏移就够了
    drag = {
      kind,
      onModel: onModel === true,
      startX: event.screenX,
      startY: event.screenY,
      origin: runtime.placement === null ? { x: 0, y: 0 } : { x: runtime.placement.x, y: runtime.placement.y },
    };
    // 被拎起来 → 弹一下，播到一半停住（松手再放完，见 pointerup）
    void startDragBounce();
    event.preventDefault();
    return;
  }
  const bounds = await shell.getBounds();
  if (bounds === null) return;
  drag = {
    kind,
    onModel: onModel === true,
    startX: event.screenX,
    startY: event.screenY,
    bounds,
  };
  // 常态下"抓着她拖窗口"也是同一套反应：拉起来弹一下、到一半定住
  if (onModel === true) void startDragBounce();
  event.preventDefault();
}

document.addEventListener('pointerdown', (event) => {
  const target = event.target;
  const handle = target instanceof HTMLElement ? target.className : '';
  const isHandle = typeof handle === 'string' && handle.startsWith('handle h-');
  const isGrip = target instanceof HTMLElement && target.id === 'grip';
  if (runtime.editMode !== true) {
    // 非绿幕：只有在模型身上按下才拖窗口（透明区必须穿透）
    if (isOnModel(event.clientX, event.clientY) !== true) return;
    document.body.setPointerCapture?.(event.pointerId);
    void beginDrag(event, 'move', true);
    return;
  }
  // 绿幕模式：手柄 → 改大小；模型身上 → 挪模型；其余（绿幕本身）→ 搬窗口
  document.body.setPointerCapture?.(event.pointerId);
  if (isHandle) {
    void beginDrag(event, String(handle).replace('handle h-', '').trim(), false);
    return;
  }
  if (isGrip) {
    void beginDrag(event, 'se', false);
    return;
  }
  if (isOnModel(event.clientX, event.clientY) === true) {
    void beginDrag(event, 'model', true);
    return;
  }
  void beginDrag(event, 'move', false);
});

document.addEventListener('pointermove', (event) => {
  if (drag === null) return;
  const dx = event.screenX - drag.startX;
  const dy = event.screenY - drag.startY;
  if (drag.kind === 'model') {
    // 挪模型：只在本地改位置（不等 IPC），松手时再存
    if (runtime.placement === null) return;
    runtime.placement.x = drag.origin.x + dx;
    runtime.placement.y = drag.origin.y + dy;
    runtime.placement.w = runtime.model.width;
    runtime.placement.h = runtime.model.height;
    paintModel();
    return;
  }
  const b = drag.bounds;
  const next = { x: b.x, y: b.y, width: b.width, height: b.height };
  if (drag.kind === 'move') {
    next.x = b.x + dx;
    next.y = b.y + dy;
  } else {
    if (drag.kind.includes('e')) next.width = b.width + dx;
    if (drag.kind.includes('s')) next.height = b.height + dy;
    if (drag.kind.includes('w')) { next.x = b.x + dx; next.width = b.width - dx; }
    if (drag.kind.includes('n')) { next.y = b.y + dy; next.height = b.height - dy; }
  }
  void shell.setBounds(next);
});

document.addEventListener('pointerup', () => {
  if (drag === null) return;
  const wasModel = drag.kind === 'model';
  drag = null;
  if (wasModel === true && runtime.placement !== null) shell.saveState({ modelPos: runtime.placement });
  // 松手：把冻在"一半"的动作放完（拖窗口 / 拖模型都算）
  thawModel();
  refreshMask();
});

// 兜底：拖到一半窗口失焦（alt-tab 之类），pointerup 收不到 → 别让她一直定在那儿
window.addEventListener('blur', () => {
  drag = null;
  thawModel();
});

// ── 气泡 ──────────────────────────────────────────────────────────────
let bubbleTimer = null;
/** 当前气泡是不是「等 TTS 说完才收」。TTS 开着时用它，关着时用固定时长。 */
let bubbleFollowsTts = false;
/** TTS 兜底：音频卡死 / 事件丢了也不至于让气泡一直挂着。 */
const BUBBLE_TTS_MAX_MS = 20000;
/** 没有 TTS 时，气泡按字数算停留时间：每字这么多毫秒。 */
const BUBBLE_MS_PER_CHAR = 90;
/** 没 TTS 时的下限 / 上限（太短看不清，太长又挡屏幕）。 */
const BUBBLE_MIN_MS = 4000;
const BUBBLE_MAX_MS = 12000;

/** 收起气泡（TTS 播完 / 出错 / 被打断都走这里）。 */
function hideBubble() {
  if (bubbleTimer !== null) {
    clearTimeout(bubbleTimer);
    bubbleTimer = null;
  }
  bubbleFollowsTts = false;
  bubbleEl.classList.remove('show');
}

/**
 * 说一句话（气泡）。
 *
 * `ms` 不给就用固定时长（= TTS 关着时的旧行为）；给了 `BUBBLE_TTS_MAX_MS` 就只当兜底，
 * 真正的收起时机由音频 `ended` 触发。
 *
 * @param {string} text - 内容。
 * @param {number} [ms] - 显示多久；不传 = 按字数算。
 * @returns {void}
 */
function showBubble(text, ms) {
  const line = String(text ?? '').trim();
  if (line === '') return;
  bubbleEl.textContent = line;
  bubbleEl.classList.add('show');
  if (bubbleTimer !== null) clearTimeout(bubbleTimer);
  // 不给 ms 就**按字数算**（短句 4 秒、长句最多 12 秒）。
  // 以前这里写的是 `bubbleTimer = null` —— 不传 ms 就永远不收，于是 TTS 一失败
  // （比如边端连不上）气泡会一直挂在屏幕上，用户实测"停留了好长时间"。
  const hold = Number.isFinite(ms)
    ? ms
    : Math.min(BUBBLE_MAX_MS, Math.max(BUBBLE_MIN_MS, line.length * BUBBLE_MS_PER_CHAR));
  bubbleTimer = setTimeout(() => {
    bubbleTimer = null;
    bubbleEl.classList.remove('show');
  }, hold);
}

// TTS 播完 / 播失败 → 收气泡（只在「这句话的气泡正在跟着音频」时才收）
runtime.audio.addEventListener('ended', () => {
  if (bubbleFollowsTts === true) hideBubble();
});
runtime.audio.addEventListener('error', () => {
  if (bubbleFollowsTts === true) hideBubble();
});

/** 这一句的序号：连说两句时，前一句的慢响应不能把后一句顶掉。 */
let speakSeq = 0;
/** 当前音频的 objectURL（换句时释放，别漏内存）。 */
let audioUrl = null;

/**
 * 让它把这句话念出来（TTS 开关关着就只显示气泡）。
 *
 * TTS 开着时：**气泡跟着音频走** —— 说话期间一直显示，`ended` 才收；
 * 新的一句进来会**打断**上一句（停音频、换气泡、立刻播新的）。
 *
 * @param {string} text - 内容。
 * @returns {Promise<void>} 完成。
 */
async function speak(text) {
  const seq = ++speakSeq;
  if (runtime.tts !== true) {
    // TTS 关着：维持旧行为（按字数算时长）
    showBubble(text);
    return;
  }
  // 打断上一句：先停音频，气泡立刻换成新的一句，等音频说完再收
  try {
    runtime.audio.pause();
  } catch {
    // 没在播就算了
  }
  showBubble(text, BUBBLE_TTS_MAX_MS);
  bubbleFollowsTts = true;
  try {
    const response = await fetch('tts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    // 这期间已经来了新的一句 → 这次结果作废
    if (seq !== speakSeq) return;
    if (response.ok !== true) {
      // 合成失败：没有音频可跟，退回固定时长
      bubbleFollowsTts = false;
      showBubble(text);
      return;
    }
    const blob = await response.blob();
    if (seq !== speakSeq) return;
    if (audioUrl !== null) {
      URL.revokeObjectURL(audioUrl);
      audioUrl = null;
    }
    audioUrl = URL.createObjectURL(blob);
    runtime.audio.src = audioUrl;
    if (Number.isFinite(runtime.volume)) runtime.audio.volume = runtime.volume;
    // 口型要用分析节点读音量：必须在 play() 之前接好；顺手把挂起的 AudioContext 唤醒
    ensureAnalyser();
    if (lip.ctx !== null && lip.ctx.state === 'suspended') void lip.ctx.resume().catch(() => {});
    const played = await runtime.audio.play().then(() => true).catch(() => false);
    // 自动播放被浏览器拦掉：没有 ended 事件，退回固定时长，别让气泡挂 20 秒
    if (seq === speakSeq && played !== true) {
      bubbleFollowsTts = false;
      showBubble(text);
    }
  } catch (error) {
    console.warn('[pet] TTS 失败', String(error));
    if (seq === speakSeq) {
      bubbleFollowsTts = false;
      showBubble(text);
    }
  }
}

// ── 实时配置（「桌宠」标签里的旋钮拨到哪就生效）──────────────────────
//
// 页面启动时只通过 IPC 读一次状态，而「桌宠」标签里的绿幕 / 缩放 / TTS 是**立刻写设置**的。
// 不轮询的话改完得重启桌宠才看得见。本机回环、每 2 秒一次、几十字节，代价可以忽略。
function watchConfig() {
  const apply = (config) => {
    if (config === null || typeof config !== 'object') return;
    // 换模型：设置面板点了另一个方框 → 宿主写设置 → 这里最多 2 秒就换过来。
    // 换的时候**保持画面中心**（新旧模型尺寸不一样，按左上角对会跳到天上去）。
    if (typeof config.model === 'string' && config.model !== runtime.modelId && config.model !== runtime.pendingModel) {
      const picked = pickModel(config);
      if (picked !== null && picked.id !== runtime.modelId) {
        runtime.pendingModel = picked.id;
        void loadModel(picked)
          .then(() => {
            runtime.pendingModel = '';
            placeModel(runtime.placement !== null);
            refreshMask();
          })
          .catch((error) => {
            // 加载失败就留着旧模型，别把画面搞没；下一拍还会再试
            runtime.pendingModel = '';
            console.warn('[pet] 换模型失败', String(error));
          });
      }
    } else if (Array.isArray(config.models) === true) {
      runtime.models = config.models.filter((item) => item !== null && typeof item === 'object');
    }
    let dirty = false;
    if (config.editMode !== runtime.editMode) {
      runtime.editMode = config.editMode === true;
      applyMode();
      dirty = true;
    }
    const scale = Number(config.modelScale);
    let scaleChanged = false;
    if (Number.isFinite(scale) && scale > 0 && Math.abs(scale - runtime.modelScale) > 0.001) {
      runtime.modelScale = scale;
      scaleChanged = true;
      dirty = true;
    }
    const bubble = config.bubblePosition === 'bottom' ? 'bottom' : 'top';
    if (bubble !== runtime.bubblePosition) {
      runtime.bubblePosition = bubble;
      applyMode();
    }
    if (config.tts !== runtime.tts) runtime.tts = config.tts === true;
    if (config.ttsVolume !== undefined) runtime.volume = Math.min(1, Math.max(0, Number(config.ttsVolume)));
    if (dirty === true) {
      // 只有**缩放**变了才重新算大小（左上角保持不动）；绿幕开关不碰模型
      if (scaleChanged === true) placeModel(true);
      refreshMask();
    }
  };
  const tick = async () => {
    try {
      const response = await fetch('config', { headers: { accept: 'application/json' } });
      if (response.ok !== true) return;
      const data = await response.json();
      apply(data !== null && typeof data === 'object' ? data.config : null);
    } catch {
      // 宿主重启中，下一拍再来
    }
  };
  void tick();
  setInterval(() => { void tick(); }, 2000);
}

// ── 订阅"它说的话" ────────────────────────────────────────────────────
//
// 宿主只有**一个**出句事件：`say`。
// 问答回复、专注模式、陪看自主，三条来源在宿主里都走同一个出口（`host/utterance.js`），
// 落库之后广播这一个事件。桌宠只管念，不关心它是哪来的。
//
// 以前这里是两个监听器（`utter` + `say`），而聊天框又会把 `say` 转发成 `utter`，
// 同一句话到达两次 → 念两遍（用户实测"TTS 走两遍、重音"）。
//
// 兜底去重留着：万一同一条广播重复到达，2 秒内只念一次。
let lastSpokenText = '';
let lastSpokenAt = 0;

function subscribe() {
  try {
    const source = new EventSource('events');
    const onUtter = (event) => {
      try {
        const data = JSON.parse(event.data);
        const text = typeof data.content === 'string' ? data.content : '';
        if (text.trim() === '') return;
        // 同一句话 2 秒内重复到达 → 只念一次（防任何一条链路重复转发）
        const now = Date.now();
        if (text === lastSpokenText && now - lastSpokenAt < 2000) return;
        lastSpokenText = text;
        lastSpokenAt = now;
        void speak(text);
      } catch (error) {
        console.warn('[pet] 解析 SSE 失败', String(error));
      }
    };
    source.addEventListener('say', onUtter);
    source.onerror = () => { /* 断了浏览器会自己重连 */ };
  } catch (error) {
    console.warn('[pet] 订阅事件失败', String(error));
  }
}

// ── 启动 ──────────────────────────────────────────────────────────────
void startModel().then(() => { subscribe(); watchConfig(); }).catch((error) => { fail(String(error)); });
