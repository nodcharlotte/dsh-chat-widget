/**
 * @local/chat-widget —— 浏览器半边。
 *
 * 第一期：侧边栏底部聊天栏（标题栏 + 消息区 + 输入框，可折叠）。
 * 第二期：⚙ 打开设置弹窗，样式照 DSH 原生设置（ui-settings-general 的弹窗外壳
 *         + ui-settings-models 的表单）复刻。
 *
 * 挂载点：sidebar.footer.action（list 槽，additive，不抢任何人的位置）。
 * 它渲染在 .footArea 内、.settingsArea 之前，所以天然落在「设置」按钮正上方。
 *
 * 布局要点（已核对 ui-sidebar 的真实 CSS）：
 *   .root         { display:flex; flex-direction:column; height:100% }
 *   .regionArea   { flex:1; min-height:0; overflow:hidden }   ← 已自带 min-height:0
 *   .footArea     { flex:none; display:flex; flex-direction:column }
 *   .footerActions{ flex:none; width:100% }                    ← 本组件进这里
 * 因此：dock 给出高度，会话列表会自动让位；dock 宽度 100%，自动跟随侧边栏拖拽。
 *
 * 约束（官方插件文档硬性要求，勿违反）：
 *   - 纯 JS，不引入 TypeScript / 打包器
 *   - 禁止 require('@deepseek-ai/dsh-client-ui-primitives') 或任何 DSH 客户端包
 *   - 不操作 document.body 的内容 / 不渲染第二个应用
 *     （只做两件最小且可回滚的事：弹窗期间锁 body 滚动、焦点转移）
 *   - 样式只用 --dsw-* 主题 token，不用字面颜色（深浅色才自动跟随）
 *   - 组件外层必须有 error boundary：组件抛错会让整个槽位空白
 *
 * 宽度陷阱：flex 项默认 min-width:auto，内容宽了就会顶破父容器。
 * 所以每个横向容器都显式 min-width:0，文字容器再加 overflow-wrap:break-word。
 */

window.__ModuleLoader__.load({
  id: '@local/chat-widget',

  factory(require) {
    const React = require('react');
    const ReactDOM = require('react-dom');
    const h = React.createElement;

    /** 展开时的默认高度（px）。 */
    const DEFAULT_HEIGHT = 360;
    /** 折叠态高度：只有一行标题栏。 */
    const COLLAPSED_HEIGHT = 30;
    /** 宿主设置接口前缀。 */
    const API = '/chat-widget/api';

    /** Live2D Core 正在下载（防连点）。纯流程控制，不需要触发重绘，所以不用 React state。 */
    let coreDownloading = false;

    /**
     * 内置默认设置。
     *
     * 结构与宿主 `host/settings.js` 的 `defaultSettings()` 对齐：
     * `models.text` + `models.embed` + `memory` + `store.dir`。
     * 客户端内置一份，是为了**宿主接口还没就绪时弹窗也能正常工作**
     * （例如插件刚装好还没重启）。取到宿主数据后以宿主为准。
     */
    const DEFAULT_SETTINGS = {
      version: 1,
      models: {
        text: {
          provider: 'ollama',
          baseUrl: 'http://127.0.0.1:11434',
          model: 'deepseek-r1:8b',
          apiKey: '',
          apiKeyEnv: '',
        },
        embed: {
          provider: 'ollama',
          baseUrl: 'http://127.0.0.1:11434',
          model: 'nomic-embed-text:latest',
          apiKey: '',
          apiKeyEnv: '',
        },
        vision: {
          provider: 'ollama',
          baseUrl: 'http://127.0.0.1:11434',
          model: '',
          apiKey: '',
          apiKeyEnv: '',
        },
      },
      memory: { delayMinutes: 5, recentMessages: 7 },
      growth: { enabled: false },
      screen: { intervalMs: 2000, sensitivity: 6, speakCooldownMs: 5000, dedupeCosine: 0.87, factsPerCall: 3, compressBatch: 200 },
      perceive: { window: false, focus: false },
      store: { dir: 'X:/AI_History' },
    };

    /** provider 预设：标签 + 默认接口地址。 */
    const PROVIDER_PRESETS = [
      { value: 'ollama', label: '本地 Ollama', baseUrl: 'http://127.0.0.1:11434' },
      { value: 'openai-compatible', label: 'OpenAI 兼容（自定义）', baseUrl: '' },
      { value: 'deepseek', label: 'DeepSeek 官方', baseUrl: 'https://api.deepseek.com' },
      { value: 'openrouter', label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1' },
    ];

    /**
     * Embedding 专属的离线兜底：BM25 关键词模式。**取值必须跟宿主
     * `host/settings.js` 的 `KEYWORD_EMBED_PROVIDER` 一致**（宿主按它归一化、
     * 换掉检索实现；写错了会被静默打回 Ollama）。
     *
     * 选它以后没有任何端点可填：入库只存文本，检索按字面重合度打分。
     */
    const KEYWORD_EMBED_PROVIDER = 'keyword-bm25';
    const KEYWORD_EMBED_PRESET = {
      value: KEYWORD_EMBED_PROVIDER,
      label: 'BM25 关键词模式（完全离线的轻量模式-零依赖备选）',
      baseUrl: '',
    };

    /**
     * 某个角色可选的 provider 列表：只有 Embedding 多一个离线关键词模式
     * （对话 / 视觉模型选中它没有任何意义，宿主也会拒掉）。
     * @param {string} roleKey - text / vision / embed。
     * @returns {object[]} 预设列表。
     */
    function presetsFor(roleKey) {
      return roleKey === 'embed' ? PROVIDER_PRESETS.concat([KEYWORD_EMBED_PRESET]) : PROVIDER_PRESETS;
    }

    /** 模型角色的展示信息（顺序 = 界面上卡片的顺序）。 */
    const MODEL_ROLES = [
      {
        key: 'text',
        title: 'Text 模型',
        tag: '对话',
        intro: '日常聊天使用。',
      },
      {
        key: 'vision',
        title: 'Vision 模型',
        tag: '陪看',
        intro: '看图用（屏幕陪看需要它）。',
      },
      {
        key: 'embed',
        title: 'Embedding 模型',
        tag: '记忆',
        intro: '把记忆片段转成向量，聊天时按相似度取回旧事。没有向量服务就选下面的 BM25 关键词模式（完全离线）。',
      },
    ];

    /**
     * OCR 语言选项（顺序 = 下拉里的顺序）。**必须跟宿主 `host/settings.js` 的
     * `OCR_LANG_CHOICES` 白名单一致**（那边负责归一化与校验，这边只管显示）。
     * `auto` = 本机装了哪几门就都跑一遍（开销按门数线性翻倍）。
     */
    const OCR_LANGS = [      { value: 'auto', label: '自动' },
      { value: 'zh-Hans-CN', label: '中文(简)' },
      { value: 'zh-Hant-TW', label: '中文(繁)' },
      { value: 'ja', label: '日文' },
      { value: 'en-US', label: '英文' },
    ];

    /**
     * 音轨识别的语言选项：**必须是 provider 认的那几个**
     * （`dsh-experimental-speech-to-text-sensevoice` 的 `auto/zh/en/yue/ja/ko`）。
     * 跟宿主 `host/settings.js` 的 `SPEECH_LANG_CHOICES` 一一对应。
     */
    const SPEECH_LANGS = [
      { value: 'auto', label: '自动' },
      { value: 'zh', label: '中文' },
      { value: 'en', label: '英文' },
      { value: 'yue', label: '粤语' },
      { value: 'ja', label: '日文' },
      { value: 'ko', label: '韩文' },
    ];

    /**
     * 人格表单的十个框：顺序 = 表单顺序（也是 `SOUL.md` 里的段落顺序）。
     * `input` 是单行框，`area` 是多行框。
     */
    const SOUL_FIELDS = [
      { key: 'name', label: '角色名', kind: 'input', placeholder: '如 小助' },
      { key: 'userCall', label: '称呼用户', kind: 'input', placeholder: '如 你' },
      { key: 'selfCall', label: '称呼自身', kind: 'input', placeholder: '如 我' },
      { key: 'identity', label: '身份描述', kind: 'area', placeholder: '她是谁、和用户是什么关系、经历过什么……' },
      { key: 'appearance', label: '外貌特征', kind: 'area', placeholder: '身形、发色、衣着、气质……' },
      { key: 'personality', label: '性格核心', kind: 'area', placeholder: '性格底色、在意什么、怕什么、会为什么高兴……' },
      { key: 'speechRules', label: '说话规则', kind: 'area', placeholder: '语气、句长、口头禅、标点习惯……' },
      { key: 'scenarios', label: '场景反应与例句', kind: 'area', placeholder: '遇到特定情境时的反应，以及可以直接照着说的例句……' },
      { key: 'boundaries', label: '内容边界', kind: 'area', placeholder: '不写、不做、不越过的线……' },
      { key: 'extra', label: '自由补充', kind: 'area', placeholder: '其它任何要它记住的设定……' },
    ];

    /** 设置弹窗左侧的分区。 */
    const TABS = [
      { key: 'sense', label: '感知' },
      { key: 'models', label: '模型' },
      { key: 'soul', label: '人格' },
      { key: 'pet', label: '桌宠' },
      { key: 'general', label: '设置' },
    ];

    /**
     * 静态样式表。
     * 类名统一加 `dshcw-` 前缀；数值照 DSH 原生设置复刻（见 PLAN-settings.md 第 3 节）。
     */
    const CSS = [
      // ── 侧边栏 dock ──
      '.dshcw-root{box-sizing:border-box;width:100%;min-width:0;display:flex;',
      'flex-direction:column;overflow:hidden;',
      'font-family:var(--dsw-font-family);color:var(--dsw-alias-label-primary);',
      'background:var(--dsw-specific-sidebar-fill);',
      'border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md)}',
      '.dshcw-header{display:flex;align-items:center;flex:none;min-width:0;',
      'flex-basis:30px;height:30px;padding:0 4px 0 6px;user-select:none}',
      '.dshcw-header:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.dshcw-header:focus-within{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color);',
      'outline-offset:-2px}',
      '.dshcw-toggleArea{flex:1;min-width:0;display:flex;align-items:center;gap:6px;',
      'height:100%;cursor:pointer}',
      '.dshcw-toggleArea:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color);',
      'outline-offset:-2px}',
      '.dshcw-chevron{flex:none;width:11px;font-size:9px;line-height:1;',
      'color:var(--dsw-alias-label-tertiary)}',
      '.dshcw-title{flex:none;min-width:0;font-size:13px;font-weight:600;line-height:1;',
      'overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dshcw-spacer{flex:1;min-width:0}',
      // 「它自己开口了」徽标：紧跟标题，绿点 + 灰字
      '.dshcw-selfTalk{flex:none;display:inline-flex;align-items:center;gap:4px;margin-left:6px;',
      'font-size:11px;line-height:1;color:var(--dsw-alias-label-secondary);white-space:nowrap}',
      '.dshcw-selfDot{width:6px;height:6px;border-radius:50%;background:#3fb950;box-shadow:0 0 5px #3fb95088}',
      '.dshcw-iconbtn{flex:none;display:inline-flex;align-items:center;justify-content:center;',
      'width:20px;height:20px;padding:0;border:none;border-radius:var(--dsw-radius-sm);',
      'background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;',
      'font-size:12px;line-height:1;font-family:inherit}',
      '.dshcw-iconbtn:hover{background:var(--dsw-alias-interactive-bg-hover);',
      'color:var(--dsw-alias-label-primary)}',
      '.dshcw-iconbtn:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color);',
      'outline-offset:-1px}',
      '.dshcw-body{flex:1;min-height:0;min-width:0;display:flex;flex-direction:column}',
      '.dshcw-messages{flex:1;min-height:0;min-width:0;overflow-y:auto;overflow-x:hidden;',
      'overflow-anchor:auto;display:flex;flex-direction:column;gap:8px;padding:8px;',
      'border-top:1px solid var(--dsw-alias-border-l1)}',
      '.dshcw-empty{margin:auto;max-width:100%;padding:8px 4px;text-align:center;',
      'font-size:12px;line-height:1.7;color:var(--dsw-alias-label-tertiary);',
      'overflow-wrap:break-word;word-break:break-word}',
      '.dshcw-composer{flex:none;min-width:0;display:flex;align-items:flex-end;gap:6px;',
      'padding:6px;margin-top:auto;border-top:1px solid var(--dsw-alias-border-l1)}',
      '.dshcw-textarea{flex:1;min-width:0;box-sizing:border-box;resize:none;',
      'min-height:28px;max-height:110px;padding:5px 8px;',
      'font-family:inherit;font-size:13px;line-height:18px;',
      'color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);',
      'border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md)}',
      '.dshcw-textarea::placeholder{color:var(--dsw-alias-label-tertiary)}',
      '.dshcw-textarea:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}',
      '.dshcw-send{flex:none;display:inline-flex;align-items:center;justify-content:center;',
      'width:28px;height:28px;padding:0;border:none;border-radius:50%;',
      'background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-inverted);',
      'cursor:pointer;font-size:11px;line-height:1;font-family:inherit}',
      '.dshcw-send:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}',
      '.dshcw-send:disabled{opacity:.4;cursor:default}',
      '.dshcw-send:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color);',
      'outline-offset:2px}',

      // ── 消息列表 ──
      '.dshcw-msg{display:flex;align-items:flex-end;gap:4px;min-width:0}',
      '.dshcw-msgUser{flex-direction:row-reverse}',
      '.dshcw-msgCol{display:flex;flex-direction:column;gap:3px;min-width:0;max-width:86%}',
      '.dshcw-bubble{min-width:0;box-sizing:border-box;padding:6px 9px;border-radius:10px;',
      'font-size:13px;line-height:19px;white-space:pre-wrap;overflow-wrap:break-word;',
      'word-break:break-word}',
      '.dshcw-msgUser .dshcw-bubble{background:var(--dsw-alias-button-primary-fill);',
      'color:var(--dsw-alias-label-primary-inverted);border-bottom-right-radius:3px}',
      '.dshcw-msgAssistant .dshcw-bubble{background:var(--dsw-alias-bg-layer-2);',
      'border:1px solid var(--dsw-alias-border-l1);border-bottom-left-radius:3px}',
      '.dshcw-msgNote{font-size:11px;line-height:15px;color:var(--dsw-alias-label-error);',
      'overflow-wrap:break-word}',
      // 「已记住」：这条消息已经参与过一条记忆。它和删除键**抢同一个位置**，
      // 平时都藏着，鼠标悬停这条消息时才露出其中一个。
      '.dshcw-msgKept{flex:none;padding:0 2px;font-size:11px;line-height:15px;',
      'color:var(--dsw-alias-label-tertiary);white-space:nowrap;opacity:0;transition:opacity .12s}',
      // 「已记住」和删除键占**同一个位置**、都只在悬停这条消息时出现，二选一
      '.dshcw-msg:hover .dshcw-msgKept,.dshcw-msg:focus-within .dshcw-msgKept{opacity:1}',
      // 固定宽度的一格：删除键与「已记住」共用，宽度不随状态变（否则气泡会抖）
      '.dshcw-msgSlot{flex:none;width:36px;min-height:18px;display:flex;',
      'align-items:center;justify-content:center}',
      // 删除键平时藏着，悬停这条消息才出现（避免界面噪音）
      '.dshcw-msgDelete{flex:none;width:18px;height:18px;padding:0;border:none;',
      'border-radius:var(--dsw-radius-sm);background:transparent;cursor:pointer;',
      'color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:1;font-family:inherit;',
      'opacity:0;transition:opacity .12s}',
      '.dshcw-msg:hover .dshcw-msgDelete{opacity:1}',
      '.dshcw-msgDelete:hover{background:var(--dsw-alias-interactive-bg-hover);',
      'color:var(--dsw-alias-label-primary)}',
      '.dshcw-msgDelete:focus-visible{opacity:1;outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color)}',
      // 「思考中」呼吸效果：本地模型冷启动可能几十秒，没有动静用户会以为卡死
      '.dshcw-typing{color:var(--dsw-alias-label-tertiary);animation:dshcwPulse 1.4s ease-in-out infinite}',
      '@keyframes dshcwPulse{0%,100%{opacity:.45}50%{opacity:1}}',
      '.dshcw-notice{flex:none;margin:8px 8px 0;padding:5px 8px;border-radius:var(--dsw-radius-sm);',
      'font-size:12px;line-height:17px;color:var(--dsw-alias-label-secondary);',
      'background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);',
      'overflow-wrap:break-word}',
      '.dshcw-noticeError{color:var(--dsw-alias-label-error)}',

      // ══ 设置弹窗：外壳（照 ui-settings-general 复刻）══
      '.dshcw-overlay{z-index:1000;position:fixed;inset:0;display:flex;',
      'justify-content:center;align-items:center;font-family:var(--dsw-font-family)}',
      '.dshcw-mask{position:absolute;inset:var(--dsh-frame-chrome-top,0px) 0 0;',
      'background:var(--dsw-alias-bg-mask-1);backdrop-filter:var(--dsw-mask-blur)}',
      '.dshcw-panel{z-index:1;display:flex;position:relative;overflow:hidden;',
      'width:800px;max-width:calc(100vw - 48px);',
      'height:min(800px, calc(100vh - 2 * max(24px, var(--dsh-frame-overlay-top,24px))));',
      'border-radius:var(--dsw-radius-panel);background:var(--dsw-alias-bg-layer-2);',
      'box-shadow:var(--dsw-elevation-prominent);',
      'color:var(--dsw-alias-label-primary);',
      '--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);',
      '--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2)}',
      '.dshcw-panel:focus{outline:none}',
      // 确认小窗口（清空历史数据用）：跟设置面板同款底色/圆角/阴影，只是小一号
      '.dshcw-confirm{z-index:1200;position:fixed;inset:0;display:flex;justify-content:center;',
      'align-items:center;font-family:var(--dsw-font-family)}',
      '.dshcw-confirmCard{z-index:1;position:relative;box-sizing:border-box;width:420px;',
      'max-width:calc(100vw - 48px);padding:20px;border-radius:var(--dsw-radius-panel);',
      'background:var(--dsw-alias-bg-layer-2);box-shadow:var(--dsw-elevation-prominent);',
      'color:var(--dsw-alias-label-primary);display:flex;flex-direction:column;gap:12px}',
      '.dshcw-confirmTitle{font-size:15px;font-weight:600;color:#fff}',
      '.dshcw-confirmText{font-size:13px;line-height:1.7;color:var(--dsw-alias-label-secondary)}',
      '.dshcw-confirmActions{display:flex;justify-content:flex-end;gap:8px;margin-top:2px}',

      // 左导航
      '.dshcw-nav{box-sizing:border-box;width:188px;flex:none;display:flex;',
      'flex-direction:column;gap:18px;padding:22px 12px 0}',
      '.dshcw-navTitle{padding:0 12px;font-size:16px;font-weight:500;line-height:24px;',
      'color:var(--dsw-alias-label-primary)}',
      '.dshcw-navList{display:flex;flex-direction:column;gap:4px;overflow-y:auto}',
      '.dshcw-navCell{box-sizing:border-box;height:40px;display:flex;align-items:center;',
      'gap:8px;padding:9px 16px 9px 12px;border:none;background:transparent;',
      'border-radius:var(--dsw-radius-md);cursor:pointer;font-family:inherit;',
      'font-size:14px;font-weight:400;line-height:22px;text-align:left;',
      'color:var(--dsw-alias-label-primary)}',
      '.dshcw-navCell:hover{background:var(--dsw-specific-sidebar-nav-item-hover)}',
      '.dshcw-navCell.dshcw-navActive{background:var(--dsw-specific-sidebar-nav-item-active)}',
      '.dshcw-navLabel{flex:1;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}',

      // 右内容
      '.dshcw-content{flex:1;min-width:0;display:flex;flex-direction:column}',
      '.dshcw-contentHeader{box-sizing:border-box;flex:none;height:54px;display:flex;',
      'justify-content:space-between;align-items:flex-start;gap:8px;',
      'padding:20px 14px 8px 10px}',
      '.dshcw-options{flex:1;min-height:0;padding:0 24px 24px;overflow-y:auto}',
      '.dshcw-close{width:28px;height:28px;display:inline-flex;justify-content:center;',
      'align-items:center;padding:0;border:none;background:transparent;cursor:pointer;',
      'border-radius:var(--dsw-radius-sm);color:var(--dsw-alias-label-primary);',
      'font-size:14px;line-height:1;font-family:inherit}',
      '.dshcw-close:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.dshcw-close:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color);',
      'outline-offset:-1px}',

      // ══ 设置弹窗：表单（照 ui-settings-models 复刻）══
      '.dshcw-section{max-width:720px;display:flex;flex-direction:column;gap:12px}',
      '.dshcw-sectionTitle{margin:0;font-size:16px;font-weight:500;line-height:24px}',
      // 「大项」标题：比分区标题小一号。一个标签页内部靠它把设置归类，
      // 每个大项下面是各自的细项（用户明确要求的结构）。
      '.dshcw-card{display:flex;flex-direction:column;gap:12px;padding:12px 14px;',
      'border:.5px solid var(--dsw-alias-settings-card-stroke);',
      'background:var(--dsw-alias-settings-card-fill);border-radius:var(--dsw-radius-xl)}',
      '.dshcw-cardHead{display:flex;align-items:center;gap:10px}',
      '.dshcw-cardName{font-size:14px;font-weight:500;line-height:22px}',
      '.dshcw-cardTag{flex:none;padding:1px 6px;font-size:11px;line-height:16px;',
      'border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-xs);',
      'color:var(--dsw-alias-label-secondary)}',
      '.dshcw-cardIntro{margin:0;max-width:520px;font-size:12px;line-height:18px;',
      'color:var(--dsw-alias-label-tertiary)}',
      '.dshcw-field{display:flex;flex-direction:column;gap:6px;min-width:0}',
      '.dshcw-inputRow{display:flex;align-items:center;gap:6px;min-width:0}',
      '.dshcw-fetchBtn{flex:none;height:36px;padding:0 12px;font-size:13px}',
      // 密钥框故意**不用** type=password：Firefox 的内置密码管理器只认这个类型，
      // 会对它弹「生成安全密码 / Firefox 将保存该网站的密码」，还会把同一区域里的
      // 模型名框也当成登录字段（那里因此冒出「管理密码」）。改成 text + 遮罩：
      // -webkit-text-security 在 Chrome/Edge/Safari 全支持、Firefox 114+ 支持。
      '.dshcw-inputSecret{-webkit-text-security:disc}',
      '.dshcw-fieldLabel{display:inline-flex;align-items:center;gap:10px;',
      'font-size:12px;font-weight:500;line-height:18px;',
      'color:var(--dsw-alias-label-secondary)}',
      '.dshcw-hint{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}',
      // 小标题：比下面那行小字大一号、白色（用户要求「对话」「OCR」「音轨」这几个分组标题）
      '.dshcw-subHead{font-size:12px;font-weight:600;line-height:18px;color:#fff}',
      // 分组标题上方加一条分隔线（用户要求：左右都不要顶到卡片边框 —— 卡片本身有 14px 横向内边距，
      // 这条线画在内容宽度上，自然就内缩了）
      '.dshcw-subHeadRow{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;margin:6px 0 2px;padding-top:10px;border-top:1px solid rgba(255,255,255,0.10)}',
      // 从属于上一行开关的子开关（OCR；以后加语音识别也一样）：整行往右缩两个字符
      '.dshcw-switchSub{padding-left:2em}',
      // OCR 语言那一行 + 缺语言包时的提示行（提示行里那个【安装】按用户要求做成白色）
      '.dshcw-langRow{display:flex;align-items:center;gap:10px;min-width:0}',
      '.dshcw-langRow>.dshcw-select{flex:1;min-width:0}',
      // 模型方框（「桌宠」第一行）：一行最多排 5 个，多了自动换行。
      // 宽度用 calc 算：5 个 + 4 个间隔 = 100%，所以一行正好 5 个。
      '.dshcw-modelRow{display:flex;flex-wrap:wrap;gap:8px;min-width:0}',
      '.dshcw-modelChip{flex:0 0 calc((100% - 32px) / 5);box-sizing:border-box;min-width:0;height:34px;padding:0 8px;',
      'border:.5px solid var(--dsw-alias-border-l3);border-radius:8px;',
      'background:transparent;color:var(--dsw-alias-label-primary,#fff);font-family:inherit;font-size:13px;',
      'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer}',
      '.dshcw-modelChip:hover{background:rgba(255,255,255,0.06)}',
      '.dshcw-modelChip:disabled{opacity:.5;cursor:default}',
      '.dshcw-modelChipOn{border-color:#fff;background:rgba(255,255,255,0.12);font-weight:600}',
      '.dshcw-langWarn{display:flex;align-items:center;gap:10px;margin:4px 0 0;font-size:11px;line-height:16px;color:var(--dsw-alias-label-warning,#e8b339)}',
      '.dshcw-langWarnText{min-width:0}',
      // SAC 拦住本机编译的引擎时，OCR / ASR / 窗口监测 三处小字下面那行红字 +【SAC设置】
      '.dshcw-sacWarn{margin:2px 0 0;font-size:11px;line-height:16px;color:var(--dsw-alias-label-danger,#e05c5c)}',
      '.dshcw-sacLink{padding:0 0 0 4px;border:none;background:transparent;color:var(--dsw-alias-label-danger,#e05c5c);font-family:inherit;font-size:11px;line-height:16px;text-decoration:underline;text-underline-offset:2px;cursor:pointer}',
      '.dshcw-langInstall{flex:none;border:none;height:22px;padding:0 10px;border-radius:6px;background:#fff;color:#111;font-family:inherit;font-size:11px;line-height:22px;cursor:pointer}',
      '.dshcw-langInstall:disabled{opacity:.5;cursor:default}',
      '.dshcw-input,.dshcw-select{box-sizing:border-box;width:100%;height:36px;',
      'padding:0 10px;font-family:inherit;font-size:14px;line-height:22px;',
      'color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);',
      'border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md)}',
      '.dshcw-input::placeholder{color:var(--dsw-alias-label-tertiary)}',
      '.dshcw-input:focus,.dshcw-select:focus{outline:none;',
      'border-color:var(--dsw-alias-brand-primary)}',
      // 自研模型下拉（原生 datalist 被 autoComplete=off 压制，见 ModelCard 注释）。
      // 包裹层拿掉内边框、把原来挂在 input 上的边框/底色搬到 wrapper，
      // 让「箭头钮 + 输入框」合成一个整体，focus-within 统一高亮。
      '.dshcw-modelWrap{position:relative;flex:1;min-width:0;display:flex;',
      'align-items:stretch;box-sizing:border-box;height:36px;',
      'background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);',
      'border-radius:var(--dsw-radius-md)}',
      '.dshcw-modelWrap:focus-within{border-color:var(--dsw-alias-brand-primary)}',
      '.dshcw-modelInput{flex:1;min-width:0;box-sizing:border-box;height:100%;padding:0 0 0 10px;',
      'border:none;outline:none;background:transparent;font-family:inherit;',
      'font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary)}',
      '.dshcw-modelInput::placeholder{color:var(--dsw-alias-label-tertiary)}',
      '.dshcw-modelToggle{flex:none;width:26px;padding:0;border:none;background:transparent;',
      'color:var(--dsw-alias-label-tertiary);cursor:pointer;font-size:9px;line-height:34px;',
      'font-family:inherit}',
      '.dshcw-modelToggle:hover{color:var(--dsw-alias-label-primary)}',
      '.dshcw-modelList{position:absolute;top:calc(100% + 4px);left:0;right:0;z-index:30;',
      'box-sizing:border-box;margin:0;padding:4px;list-style:none;max-height:240px;',
      'overflow-y:auto;background:var(--dsw-alias-bg-layer-3);',
      'border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md);',
      '--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);',
      'box-shadow:var(--dsw-elevation-prominent)}',
      '.dshcw-modelItem{width:100%;box-sizing:border-box;text-align:left;border:none;',
      'background:transparent;margin:0;padding:6px 8px;border-radius:var(--dsw-radius-sm);',
      'font-family:inherit;font-size:13px;line-height:18px;cursor:pointer;',
      'color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;',
      'white-space:nowrap}',
      '.dshcw-modelItem:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.dshcw-modelItem.dshcw-modelActive{',
      'background:var(--dsw-alias-interactive-bg-hover-solid)}',
      '.dshcw-footer{display:flex;align-items:center;gap:10px;padding-top:4px}',
      // 折叠区（绿幕关着时高度 0）：用 max-height 过渡，比 display 切换能有展开动画
      '.dshcw-fold{overflow:hidden;transition:max-height 220ms ease,opacity 180ms ease}',
      // 滑块行：标签在上、滑块占满一行
      '.dshcw-sliderRow{display:flex;flex-direction:column;gap:6px;margin:10px 0 2px}',
      '.dshcw-slider{width:100%;height:18px;margin:0;accent-color:var(--dsw-alias-button-primary-fill);cursor:pointer}',
      '.dshcw-slider:disabled{opacity:.4;cursor:default}',
      '.dshcw-btnPrimary,.dshcw-btnSecondary{box-sizing:border-box;height:36px;',
      'padding:0 14px;display:inline-flex;justify-content:center;align-items:center;gap:4px;',
      'border-radius:var(--dsw-radius-md);font-family:inherit;font-size:14px;',
      'line-height:22px;cursor:pointer}',
      '.dshcw-btnPrimary{border:none;background:var(--dsw-alias-button-primary-fill);',
      'color:var(--dsw-alias-label-primary-foreground)}',
      '.dshcw-btnPrimary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}',
      '.dshcw-btnSecondary{background:transparent;color:var(--dsw-alias-label-primary);',
      'border:.5px solid var(--dsw-alias-border-l3)}',
      '.dshcw-btnSecondary:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-solid)}',
      '.dshcw-btnPrimary:disabled,.dshcw-btnSecondary:disabled{opacity:.4;cursor:default}',
      '.dshcw-btnPrimary:focus-visible,.dshcw-btnSecondary:focus-visible{outline:none;',
      'box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary))}',
      '.dshcw-status{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}',
      '.dshcw-statusError{color:var(--dsw-alias-label-error)}',
      // ── 人格 / 设置 两个分区 ──
      '.dshcw-switchRow{display:flex;align-items:center;justify-content:space-between;gap:12px;min-width:0}',
      '.dshcw-switchText{min-width:0;display:flex;flex-direction:column;gap:2px}',
      '.dshcw-switch{position:relative;flex:none;width:38px;height:20px;padding:0;border:none;',
      'border-radius:10px;background:var(--dsw-alias-border-l3);cursor:pointer;transition:background .15s}',
      '.dshcw-switch:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color);',
      'outline-offset:2px}',
      '.dshcw-switch.dshcw-switchOn{background:var(--dsw-alias-brand-primary)}',
      '.dshcw-switchKnob{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;',
      'background:var(--dsw-alias-label-primary-inverted);transition:left .15s}',
      '.dshcw-switch.dshcw-switchOn .dshcw-switchKnob{left:20px}',
      '.dshcw-checkRow{display:inline-flex;align-items:center;gap:8px;',
      'font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary);cursor:pointer}',
      '.dshcw-checkbox{flex:none;width:15px;height:15px;margin:0;',
      'accent-color:var(--dsw-alias-brand-primary)}',
      '.dshcw-soulGrid{display:flex;flex-direction:column;gap:12px;min-width:0}',
      '.dshcw-soulRow{display:flex;gap:10px;min-width:0}',
      '.dshcw-soulRow>.dshcw-field{flex:1;min-width:0}',
      '.dshcw-soulArea{box-sizing:border-box;width:100%;min-height:64px;padding:6px 9px;',
      'resize:vertical;font-family:inherit;font-size:13px;line-height:19px;',
      'color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);',
      'border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md)}',
      // 多行提示要保住换行，否则那几行"该写什么"会挤成一坨
      '.dshcw-soulArea::placeholder{color:var(--dsw-alias-label-tertiary);white-space:pre-line}',
      '.dshcw-soulArea:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}',
      '.dshcw-soulFooter{display:flex;align-items:center;gap:10px;padding-top:4px;min-width:0}',
      '.dshcw-soulPath{flex:1;min-width:0;font-size:12px;line-height:18px;',
      'color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;',
      'white-space:nowrap;direction:rtl;text-align:left}',
      // 滑块开关（「感知」标签用）：视觉上是开关，不是勾选框
    ].join('');

    /** 把静态样式插进文档；随组件一起卸载。 */
    function StyleTag() {
      return h('style', { 'data-dshcw-style': 'true' }, CSS);
    }

    /** 错误边界：槽位里的组件抛错会让整个槽位空白，这里兜住。 */
    class ErrorBoundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { error: null };
      }

      static getDerivedStateFromError(error) {
        return { error };
      }

      componentDidCatch(error) {
        console.error('[chat-widget] dock 渲染失败:', error);
      }

      render() {
        if (this.state.error) {
          return h(
            'div',
            {
              className: 'dshcw-root',
              style: { padding: '6px 8px', fontSize: 12, color: 'var(--dsw-alias-label-error)' },
            },
            '聊天栏出错了（详见 console）',
          );
        }
        return this.props.children;
      }
    }

    /** 深拷贝一份默认设置（避免共享引用被就地改动）。 */
    function cloneDefaults() {
      return JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
    }

    /** 每个角色的「密钥框被用户动过」标记，初始全 false。 */
    function emptyTouched() {
      const touched = {};
      for (const role of MODEL_ROLES) touched[role.key] = false;
      return touched;
    }

    /**
     * 把宿主回传的设置补齐成完整结构（缺的角色/字段落回内置默认值）。
     *
     * **关键**：某个角色在宿主上已存密钥时，`apiKey` 字段是**被省略**的
     * （见 fetchSettings 注释）。补默认值时不能再把它填回来，否则
     * ModelCard 的 `hasStoredKey`（靠「字段是否存在」判断）会失效，
     * 「留空即保留」就会变成「留空即清空」。
     *
     * @param {unknown} raw - 宿主回传的 settings。
     * @returns {object} 补齐后的设置。
     */
    function normalizeSettings(raw) {
      const base = cloneDefaults();
      const source = raw !== null && typeof raw === 'object' ? raw : {};
      const rawModels = source.models !== null && typeof source.models === 'object' ? source.models : {};
      const models = {};
      for (const role of MODEL_ROLES) {
        const fallback = base.models[role.key];
        const value = rawModels[role.key];
        if (value === null || typeof value !== 'object') {
          models[role.key] = fallback;
          continue;
        }
        const merged = { ...fallback, ...value };
        if (Object.prototype.hasOwnProperty.call(value, 'apiKey') === false) delete merged.apiKey;
        models[role.key] = merged;
      }
      const rawStore = source.store !== null && typeof source.store === 'object' ? source.store : {};
      const rawMemory = source.memory !== null && typeof source.memory === 'object' ? source.memory : {};
      const rawGrowth = source.growth !== null && typeof source.growth === 'object' ? source.growth : {};
      const rawPerceive = source.perceive !== null && typeof source.perceive === 'object' ? source.perceive : {};
      return {
        ...base,
        ...source,
        models,
        // 逐字段合并：宿主只回了其中一项时，另一项不能凭空消失
        memory: { ...base.memory, ...rawMemory },
        growth: { ...base.growth, ...rawGrowth },
        perceive: { ...base.perceive, ...rawPerceive },
        store: { ...base.store, ...rawStore },
      };
    }

    /** 空人格表单（十个键，顺序固定）。 */
    function emptySoulForm() {
      const fields = {};
      for (const field of SOUL_FIELDS) fields[field.key] = '';
      return fields;
    }

    /**
     * 归纳一份人格表单：只认十个已知键，非字符串一律留空。
     * @param {unknown} raw - 宿主回传的 fields。
     * @returns {object} 完整表单。
     */
    function normalizeSoulFields(raw) {
      const source = raw !== null && typeof raw === 'object' ? raw : {};
      const fields = {};
      for (const field of SOUL_FIELDS) {
        fields[field.key] = typeof source[field.key] === 'string' ? source[field.key] : '';
      }
      return fields;
    }

    /**
     * 人格表单的「脏检查」指纹：按固定顺序序列化十个值。
     * 用数组而不是对象，免得键顺序影响比较结果。
     * @param {object} fields - 人格表单。
     * @returns {string} 指纹。
     */
    function soulBaseline(fields) {
      const source = fields !== null && typeof fields === 'object' ? fields : {};
      return JSON.stringify(SOUL_FIELDS.map((field) => (typeof source[field.key] === 'string' ? source[field.key] : '')));
    }

    // ── 设置读写 ─────────────────────────────────────────────────────────

    /**
     * 从宿主读取设置。失败时返回内置默认值（并带上失败原因，供 UI 提示）。
     *
     * 宿主不会回传密钥明文：已有密钥时 `settings.models.text.apiKey` 会被**省略**，
     * 前端据此把空的密码框显示成「已保存，留空即保留」，并在保存时**省略该字段**以免覆盖。
     *
     * @returns {Promise<{settings: object, source: string, error?: string}>} 读取结果。
     */
    async function fetchSettings() {
      try {
        const response = await fetch(`${API}/settings`, { headers: { accept: 'application/json' } });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        if (!data || typeof data !== 'object' || typeof data.settings !== 'object') {
          throw new Error('响应结构不对');
        }
        return {
          settings: normalizeSettings(data.settings),
          source: String(data.source ?? 'file'),
        };
      } catch (error) {
        return { settings: cloneDefaults(), source: 'builtin', error: String(error) };
      }
    }

    /**
     * 根据「用户是否动过密钥框」决定 apiKey 字段的去留：
     *   - 没动过、宿主又省略了 apiKey（= 已存密钥） → 继续省略（宿主按「缺失即保留」）
     *   - 动过且清成空串 → 明确发空串（= 清除已存密钥）
     *   - 动过且填了新值 → 发新值（= 替换）
     * 必须靠明确的 touched 标记（见 SettingsDialog），因为
     * 「留空没动」与「动完又删回空」在最终值上无法区分，只有触碰记录能区分「保留」与「清除」。
     *
     * @param {object} draft - 当前编辑中的设置。
     * @param {object|null} touched - 每个角色是否被用户动过（逐角色判断）。
     * @returns {object} 保存载荷。
     */
    function buildPayload(draft, touched) {
      const models = {};
      for (const role of MODEL_ROLES) {
        const value = draft.models[role.key];
        const next = { ...value };
        const wasTouched = touched !== null && typeof touched === 'object' && touched[role.key] === true;
        if (!wasTouched && Object.prototype.hasOwnProperty.call(value, 'apiKey') === false) {
          delete next.apiKey;
        }
        models[role.key] = next;
      }
      return { ...draft, models };
    }

    /**
     * 把设置写回宿主。成功时返回宿主归一后的设置（数值会被夹进合法区间，
     * 密钥被脱敏），界面据此刷新草稿，免得框里显示的值和真正存下的值不一样。
     * @param {object} settings - 完整设置。
     * @returns {Promise<object|null>} 宿主回传的设置，拿不到就是 null。
     * @throws 写入失败时抛错。
     */
    async function saveSettings(settings) {
      const response = await fetch(`${API}/settings`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(settings),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      try {
        const data = await response.json();
        return data !== null && typeof data === 'object' && typeof data.settings === 'object' ? data.settings : null;
      } catch {
        return null;
      }
    }

    /**
     * 读记忆库状态（已建成几条、还有几条在排队等入库）。
     * @returns {Promise<{memories: number, pending: number, error: string}>} 状态。
     */
    async function fetchMemoryStats() {
      try {
        const response = await fetch(`${API}/memory`, { headers: { accept: 'application/json' } });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        return {
          memories: Number.isFinite(data.memories) ? data.memories : 0,
          pending: Number.isFinite(data.pending) ? data.pending : 0,
          error: typeof data.error === 'string' ? data.error : '',
          growth: data.growth !== null && typeof data.growth === 'object' ? data.growth : null,
        };
      } catch (error) {
        return { memories: 0, pending: 0, error: String(error), growth: null };
      }
    }

    /**
     * 读陪看状态（设置分区/感知分区显示"未压缩 N 条"）。
     * @returns {Promise<object|null>} 状态。
     */
    async function fetchScreenStats() {
      try {
        const response = await fetch(`${API}/screen/status`, { headers: { accept: 'application/json' } });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        return data !== null && typeof data === 'object' ? data : null;
      } catch {
        return null;
      }
    }

    /**
     * 读 TTS 音色清单（`/pet/voices`：kokoro 103 个音色 + 装没装）。
     *
     * @returns {Promise<object|null>} `{kokoro, melo}`；读不到返回 null。
     */
    async function fetchPetVoices() {
      try {
        const response = await fetch(`${API}/pet/voices`, { headers: { accept: 'application/json' } });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        return data !== null && typeof data === 'object' ? data : null;
      } catch {
        return null;
      }
    }

    /**
     * 读桌宠现场（`/pet/status`：外壳在不在跑、运行时借到没借到）。
     *
     * @returns {Promise<object|null>} `pet` 段；读不到返回 null。
     */
    async function fetchPetStatus() {
      try {
        const response = await fetch(`${API}/pet/status`, { headers: { accept: 'application/json' } });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        return data !== null && typeof data === 'object' && data.pet !== null && typeof data.pet === 'object'
          ? data.pet
          : null;
      } catch {
        return null;
      }
    }

    /**
     * 读窗口监测现场（「感知」分区显示"当前窗口"）。
     * @returns {Promise<object|null>} 状态，拿不到就是 null。
     */
    async function fetchWindowStatus() {
      try {
        const response = await fetch(`${API}/window`, { headers: { accept: 'application/json' } });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        return data !== null && typeof data === 'object' ? data : null;
      } catch {
        return null;
      }
    }

    // ── 人格（SOUL.md）读写 ──────────────────────────────────────────────

    /**
     * 读人格表单。失败时回一份空白表单（照样能编辑、能保存）。
     * @returns {Promise<{fields: object, dir: string, path: string, error?: string}>} 读取结果。
     */
    async function fetchSoul() {
      try {
        const response = await fetch(`${API}/soul`, { headers: { accept: 'application/json' } });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        if (data === null || typeof data !== 'object') throw new Error('响应结构不对');
        return {
          fields: normalizeSoulFields(data.fields),
          dir: typeof data.dir === 'string' ? data.dir : '',
          path: typeof data.path === 'string' ? data.path : '',
        };
      } catch (error) {
        return { fields: emptySoulForm(), dir: '', path: '', error: String(error) };
      }
    }

    /**
     * 写人格表单。
     * @param {object} fields - 十个框的值。
     * @returns {Promise<{ok?: boolean, written?: boolean, reason?: string}>} 宿主回执。
     * @throws 写入请求本身失败时抛错。
     */
    async function saveSoul(fields) {
      const response = await fetch(`${API}/soul`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fields }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json().catch(() => null);
      return data !== null && typeof data === 'object' ? data : {};
    }

    // ── 设置弹窗 ─────────────────────────────────────────────────────────

    /**
     * 一个 provider + 模型 的配置卡片。
     *
     * 模型名称框是「自绘下拉 + 自由输入」二合一：点输入框或 ▼ 展开从端点
     * 拉回的候选列表，也可直接手打任意模型名。
     * 不沿用 `<input list>` 原生 datalist——Chrome 在 autoComplete=off 时
     * 会抑制 datalist 弹层，用户根本看不到候选（此前的 bug）。
     *
     * @param {object} props - 角色定义、当前值、改动回调、密钥触碰回调。
     */
    function ModelCard(props) {
      const { role, value, onChange, onApiKeyTouch } = props;
      /** 本角色可选的 provider（embed 多一个离线关键词模式）。 */
      const presets = presetsFor(role.key);
      /**
       * 关键词模式：接口地址 / 模型名 / 密钥三块**整块不渲染** ——
       * 它们对关键词检索没有任何意义，留着只会诱导人乱填。
       */
      const keywordMode = value.provider === KEYWORD_EMBED_PROVIDER;
      const [models, setModels] = React.useState([]);
      const [fetching, setFetching] = React.useState(false);
      const [fetchError, setFetchError] = React.useState('');
      // 「清除已存密钥」必须是个显式动作：空框本身表达不了「我要删掉」——
      // 留空不动是「保留」，所以给一个专门的按钮，而不是让用户去猜
      // （「先随便打几个字再删掉」这种操作没人猜得到）。
      const [markedClear, setMarkedClear] = React.useState(false);
      const [modelsOpen, setModelsOpen] = React.useState(false);
      // 候选默认按输入过滤，但输入框里预填着「当前模型名」——换了服务商之后
      // 这个名字往往和新端点返回的 id 完全不匹配，一过滤就把候选全滤空，
      // 看起来像「下拉坏了 / 拉取没反应」。所以只有**用户正在打字**时才过滤，
      // 点输入框、点箭头、刚拉取完都展示完整候选。
      const [filterActive, setFilterActive] = React.useState(false);
      const modelWrapRef = React.useRef(null);

      // 宿主省略了 apiKey 字段 = 已存有一把密钥（但拿不到值）。
      const hasStoredKey = Object.prototype.hasOwnProperty.call(value, 'apiKey') === false;

      // 按当前输入过滤候选（大小写不敏感），最多给 200 条，避免弹窗过胖。
      const filterText = String(value.model ?? '').trim().toLowerCase();
      const matches =
        filterText === ''
          ? []
          : models.filter((m) => String(m.id).toLowerCase().includes(filterText));
      // 过滤结果为空时回落到「全部候选」：宁可多给，也不要给一个看不见的空白框。
      const filteredModels =
        !filterActive || filterText === '' || matches.length === 0
          ? models.slice(0, 200)
          : matches.slice(0, 200);

      // 候选区键盘：开着时 Esc 只收起候选（不关整个弹窗），关着时 ArrowDown 展开。
      const onModelWrapKeyDown = (event) => {
        if (event.key === 'Escape' && modelsOpen) {
          event.stopPropagation();
          setModelsOpen(false);
        } else if (event.key === 'ArrowDown' && !modelsOpen && models.length > 0) {
          event.preventDefault();
          setModelsOpen(true);
        }
      };

      // 点击候选区外面时收起下拉（捕获阶段，抢在别处处理前）。
      React.useEffect(() => {
        if (!modelsOpen) return undefined;
        const onPointerDown = (event) => {
          if (modelWrapRef.current !== null && !modelWrapRef.current.contains(event.target)) {
            setModelsOpen(false);
          }
        };
        document.addEventListener('mousedown', onPointerDown, true);
        return () => document.removeEventListener('mousedown', onPointerDown, true);
      }, [modelsOpen]);

      const setField = (field) => (event) => {
        onChange({ ...value, [field]: event.target.value });
      };

      const onProviderChange = (event) => {
        const provider = event.target.value;
        const preset = presets.find((p) => p.value === provider);
        // 切 provider 时，只在接口地址为空或仍是上一个预设默认值时才覆盖，
        // 避免把用户手填的地址冲掉。
        const previousPreset = presets.find((p) => p.value === value.provider);
        const shouldAdoptPreset =
          preset !== undefined &&
          (value.baseUrl === '' || (previousPreset !== undefined && value.baseUrl === previousPreset.baseUrl));
        setModels([]);
        setFetchError('');
        setModelsOpen(false);
        onChange({
          ...value,
          provider,
          baseUrl: shouldAdoptPreset ? preset.baseUrl : value.baseUrl,
        });
      };

      /** 从端点拉取可用模型列表（由宿主代发请求，不受 CORS 限制）。 */
      const loadModels = () => {
        setFetching(true);
        setFetchError('');
        setModelsOpen(false);
        fetch(`${API}/models`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          // 空串 / 未定义就不发 apiKey：
          // 宿主收到 body.role 且无密钥时，自动回退到已保存的那把（此前 POST 会把
          // undefined 字段丢成「没带密钥 + 没 role」→ 401/502）。
          body: JSON.stringify({
            role: role.key,
            provider: value.provider,
            baseUrl: value.baseUrl,
            apiKey: typeof value.apiKey === 'string' && value.apiKey !== '' ? value.apiKey : undefined,
            apiKeyEnv: value.apiKeyEnv,
          }),
        })
          .then(async (response) => {
            const data = await response.json().catch(() => null);
            if (!response.ok) {
              throw new Error(data !== null && data.message ? String(data.message) : `HTTP ${response.status}`);
            }
            const list = Array.isArray(data.models) ? data.models : [];
            setModels(list);
            // 拉取完要展示**完整**候选：先清掉输入过滤，否则会被框里预填的
            // 旧模型名滤空（这就是「拉取后看不到可选项」的根因）。
            setFilterActive(false);
            setModelsOpen(list.length > 0);
            setFetching(false);
            if (list.length === 0) setFetchError('端点没有返回任何模型');
          })
          .catch((error) => {
            setFetching(false);
            setFetchError(String(error));
          });
      };

      return h(
        'div',
        { className: 'dshcw-card' },
        h(
          'div',
          { className: 'dshcw-cardHead' },
          h('span', { className: 'dshcw-cardName' }, role.title),
          h('span', { className: 'dshcw-cardTag' }, role.tag),
        ),
        h('p', { className: 'dshcw-cardIntro' }, role.intro),

        h(
          'div',
          { className: 'dshcw-field' },
          h('label', { className: 'dshcw-fieldLabel', htmlFor: `dshcw-${role.key}-provider` }, '服务类型'),
          h(
            'select',
            {
              id: `dshcw-${role.key}-provider`,
              className: 'dshcw-select',
              value: value.provider,
              onChange: onProviderChange,
            },
            presets.map((p) => h('option', { key: p.value, value: p.value, title: p.label }, p.label)),
          ),
        ),

        // 关键词模式：只留上面那个下拉，下面换成一段"它到底怎么工作"的说明。
        keywordMode &&
          h(
            'p',
            { className: 'dshcw-cardIntro' },
            '完全离线：不连任何接口，也不需要模型名和密钥 —— 这些输入框已经收起来了。'
            + '入库只存原文，聊天时按字面重合度（BM25）取回旧记忆：同一个词能命中，'
            + '换个说法就命中不了。条件允许时，还是建议换回向量模型。',
          ),
        keywordMode &&
          h(
            'p',
            { className: 'dshcw-hint' },
            '屏幕陪看的去重与召回同步退化为字面比较（不调用接口）；'
            + '此前用向量模式建的旧记忆仍可被关键词命中。',
          ),

        !keywordMode &&
        h(
          'div',
          { className: 'dshcw-field' },
          h('label', { className: 'dshcw-fieldLabel', htmlFor: `dshcw-${role.key}-baseUrl` }, '接口地址'),
          h('input', {
            id: `dshcw-${role.key}-baseUrl`,
            className: 'dshcw-input',
            type: 'text',
            spellCheck: false,
            autoComplete: 'off',
            placeholder: 'https://…',
            value: value.baseUrl,
            onChange: setField('baseUrl'),
          }),
        ),

        !keywordMode &&
        h(
          'div',
          { className: 'dshcw-field' },
          h('label', { className: 'dshcw-fieldLabel', htmlFor: `dshcw-${role.key}-model` }, '模型名称'),
          h(
            'div',
            { className: 'dshcw-inputRow' },
            h(
              'div',
              { className: 'dshcw-modelWrap', ref: modelWrapRef, onKeyDown: onModelWrapKeyDown },
              h('input', {
                id: `dshcw-${role.key}-model`,
                className: 'dshcw-modelInput',
                type: 'text',
                spellCheck: false,
                autoComplete: 'off',
                placeholder: '如 qwen3.5:9b',
                value: value.model,
                onChange: (event) => {
                  setField('model')(event);
                  setFilterActive(true);
                  setModelsOpen(true);
                },
                onFocus: () => {
                  if (models.length > 0) {
                    // 点进输入框先给完整候选；之后打字才按输入过滤。
                    setFilterActive(false);
                    setModelsOpen(true);
                  }
                },
              }),
              models.length > 0 &&
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dshcw-modelToggle',
                    tabIndex: -1,
                    'aria-label': '选择模型',
                    title: '选择模型',
                    onMouseDown: (event) => event.preventDefault(),
                    onClick: () => {
                      setFilterActive(false);
                      setModelsOpen((v) => !v);
                    },
                  },
                  '\u25BE',
                ),
              modelsOpen &&
                models.length > 0 &&
                h(
                  'ul',
                  { className: 'dshcw-modelList', role: 'listbox' },
                  filteredModels.map((m) =>
                    h(
                      'li',
                      { key: m.id, role: 'option' },
                      h(
                        'button',
                        {
                          type: 'button',
                          className:
                            m.id === value.model ? 'dshcw-modelItem dshcw-modelActive' : 'dshcw-modelItem',
                          onMouseDown: (event) => event.preventDefault(),
                          onClick: () => {
                            onChange({ ...value, model: m.id });
                            setModelsOpen(false);
                          },
                        },
                        m.id,
                      ),
                    ),
                  ),
                ),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'dshcw-btnSecondary dshcw-fetchBtn',
                onClick: loadModels,
                disabled: fetching,
                title: '从上面填的端点拉取可用模型',
              },
              fetching ? '拉取中…' : '拉取',
            ),
          ),
          fetchError !== ''
            ? h('span', { className: 'dshcw-hint dshcw-statusError' }, `拉取失败：${fetchError}`)
            : models.length > 0
              ? h(
                  'span',
                  { className: 'dshcw-hint' },
                  filterActive && filterText !== '' && matches.length === 0
                    ? `没有匹配「${filterText}」的模型，下面已列出全部 ${models.length} 个`
                    : `已拉到 ${models.length} 个模型，可下拉选择，也可直接手填`,
                )
              : h('span', { className: 'dshcw-hint' }, '点「拉取」可列出端点上的模型；也可以直接手填模型名'),
        ),

        !keywordMode &&
        h(
          'div',
          { className: 'dshcw-field' },
          h('label', { className: 'dshcw-fieldLabel', htmlFor: `dshcw-${role.key}-apiKey` }, 'API Key'),
          h(
            'div',
            { className: 'dshcw-inputRow' },
            h('input', {
              id: `dshcw-${role.key}-apiKey`,
              className: 'dshcw-input dshcw-inputSecret',
              // 见 .dshcw-inputSecret 的注释：用 text 类型绕开浏览器的密码管理器，
              // 遮罩交给 CSS（Firefox 114+ / Chromium / Safari 都支持）。
              type: 'text',
              spellCheck: false,
              autoComplete: 'off',
              // 第三方密码管理器的忽略标记（Firefox 内置的不吃这套，
              // 它靠上面「压根不是 password 类型」来规避）。
              'data-1p-ignore': true,
              'data-lpignore': 'true',
              'data-bwignore': true,
              'data-protonpass-ignore': 'true',
              'data-form-type': 'other',
              placeholder: markedClear
                ? '保存后即清除'
                : hasStoredKey
                  ? '已保存（留空即保留）'
                  : '本地服务可留空',
              // 宿主省略字段时 value 是 undefined，受控组件会警告；
              // 用 ?? '' 兜底，且不破坏「留空=保留」的字段缺失语义。
              value: value.apiKey ?? '',
              onChange: (event) => {
                // 手动输入即视为「改主意」：撤销掉之前点的「清除」标记。
                setMarkedClear(false);
                setField('apiKey')(event);
                onApiKeyTouch();
              },
            }),
            // 只有确实存着密钥时才给「清除」；点过之后按钮就消失（已经没什么可清的了），
            // 「保存后生效 / 关掉弹窗即取消」由下面的提示说明。
            hasStoredKey &&
              h(
                'button',
                {
                  type: 'button',
                  className: 'dshcw-btnSecondary dshcw-fetchBtn',
                  onClick: () => {
                    setMarkedClear(true);
                    onApiKeyTouch();
                    onChange({ ...value, apiKey: '' });
                  },
                  title: '保存后删除已存密钥',
                },
                '清除',
              ),
          ),
          h(
            'span',
            { className: 'dshcw-hint' },
            markedClear
              ? '已标记为清除：点「保存」后删除；不保存直接关掉弹窗则取消。'
              : hasStoredKey
                ? '已保存一把密钥（为安全不回显）。留空即保留；要删掉就点右侧「清除」。'
                : '要接远程服务就填在这里（本地服务留空）。',
          ),
        ),

        !keywordMode &&
        h(
          'div',
          { className: 'dshcw-field' },
          h(
            'label',
            { className: 'dshcw-fieldLabel', htmlFor: `dshcw-${role.key}-apiKeyEnv` },
            '或使用环境变量（可选）',
          ),
          h('input', {
            id: `dshcw-${role.key}-apiKeyEnv`,
            className: 'dshcw-input',
            type: 'text',
            spellCheck: false,
            autoComplete: 'off',
            placeholder: '如 OPENROUTER_CUSTOM_API_KEY',
            value: value.apiKeyEnv,
            onChange: setField('apiKeyEnv'),
          }),
          h(
            'span',
            { className: 'dshcw-hint' },
            '填变量名（不是密钥值），启动 DSH 前先设好该变量。两者都填时以上面的 API Key 为准。',
          ),
        ),
      );
    }

    /**
     * 模型分区：每个角色一张卡片。
     * 保存键不在分区里 —— 它在外壳的页脚，一次保存全部设置（见 SettingsDialog）。
     */
    function ModelsSection(props) {
      const { draft, setDraft, onTouchRole } = props;

      /**
       * 改某一个角色的字段。
       * @param {string} roleKey - text。
       * @param {object} next - 该角色的新值。
       */
      const updateRole = (roleKey, next) => {
        setDraft({ ...draft, models: { ...draft.models, [roleKey]: next } });
      };

      return h(
        'div',
        { className: 'dshcw-section' },
        h('h2', { className: 'dshcw-sectionTitle' }, '模型'),
        ...MODEL_ROLES.map((role) =>
          h(ModelCard, {
            key: role.key,
            role,
            value: draft.models[role.key],
            onChange: (next) => updateRole(role.key, next),
            onApiKeyTouch: () => onTouchRole(role.key),
          }),
        ),
      );
    }

    /**
     * 人格分区：十个框，一一对应 `SOUL.md` 里的段落。
     *
     * 内容为空的段落宿主写文件时整段省略；这里只管把表单交出去。
     *
     * @param {{ fields: object, onChange: (key: string, value: string) => void, dir: string }} props
     *   表单值、改一个框的回调、数据目录（用于显示落盘位置）。
     */
    function SoulSection({ fields, onChange, dir }) {
      const value = fields !== null && typeof fields === 'object' ? fields : {};
      const singles = SOUL_FIELDS.filter((field) => field.kind !== 'area');
      const areas = SOUL_FIELDS.filter((field) => field.kind === 'area');

      // 落盘位置：dir 可能拿不到（宿主接口未就绪），那就明说不知道，不要显示半截路径。
      const trimmed = String(dir ?? '').replace(/[\\/]+$/, '');
      const pathText =
        trimmed === '' ? '数据目录未知' : `保存于 ${trimmed.replace(/\//g, '\\')}\\SOUL.md`;

      /** 一个单行框。 */
      const renderInput = (field) =>
        h(
          'div',
          { className: 'dshcw-field', key: field.key },
          h('label', { className: 'dshcw-fieldLabel', htmlFor: `dshcw-soul-${field.key}` }, field.label),
          h('input', {
            id: `dshcw-soul-${field.key}`,
            className: 'dshcw-input',
            type: 'text',
            spellCheck: false,
            autoComplete: 'off',
            placeholder: field.placeholder,
            value: typeof value[field.key] === 'string' ? value[field.key] : '',
            onChange: (event) => onChange(field.key, event.target.value),
          }),
        );

      /** 一个多行框。 */
      const renderArea = (field) =>
        h(
          'div',
          { className: 'dshcw-field', key: field.key },
          h('label', { className: 'dshcw-fieldLabel', htmlFor: `dshcw-soul-${field.key}` }, field.label),
          h('textarea', {
            id: `dshcw-soul-${field.key}`,
            className: 'dshcw-soulArea',
            rows: 3,
            spellCheck: false,
            placeholder: field.placeholder,
            value: typeof value[field.key] === 'string' ? value[field.key] : '',
            onChange: (event) => onChange(field.key, event.target.value),
          }),
        );

      return h(
        'div',
        { className: 'dshcw-section' },
        h('h2', { className: 'dshcw-sectionTitle' }, '人格'),
        h(
          'p',
          { className: 'dshcw-cardIntro' },
          '这些设定会写进数据目录里的 SOUL.md，并作为系统提示词的一部分发给模型。留空的段落不会写入。',
        ),
        h(
          'div',
          { className: 'dshcw-soulGrid' },
          h('div', { className: 'dshcw-soulRow' }, ...singles.map(renderInput)),
          ...areas.map(renderArea),
        ),
        h(
          'div',
          { className: 'dshcw-soulFooter' },
          h('span', { className: 'dshcw-soulPath', title: pathText }, pathText),
        ),
      );
    }

    /**
     * 「感知」分区：两个滑块（窗口监测 / 专注模式）。
     *
     * 都默认关；**关着的时候后台连助手进程都不起**（打开最多 3 秒生效）。
     * 专注模式依赖窗口监测：窗口监测关着它就没有输入。
     *
     * @param {{draft: object, setDraft: (next: object) => void, status: object|null}} props - 草稿、改草稿、窗口现场。
     */
    function SenseSection({ draft, setDraft, onSwitch, onSubtitle, onSpeech, onPet, onDownloadCore, onSacGuide, petStatus, screenStats }) {
      const perceive = draft.perceive !== null && typeof draft.perceive === 'object' ? draft.perceive : {};
      const screen = draft.screen !== null && typeof draft.screen === 'object' ? draft.screen : {};
      // 智能应用控制拦住了本机编译的引擎（宿主拉签过名的预编译产物又没拉到）：
      // OCR / ASR / 窗口监测 三处小字**一起**改成"关掉 SAC"的提示（用户 2026-11-21 定的）
      const sacBlocked = screenStats !== null && typeof screenStats === 'object'
        && screenStats.native !== null && typeof screenStats.native === 'object'
        && screenStats.native.sac !== null && typeof screenStats.native.sac === 'object'
        && screenStats.native.sac.blocked === true;
      /**
       * 三处小字后面那段红字 +【SAC设置】。
       *
       * @param {string} label - 这一处叫什么（OCR / ASR / 窗口监测）。
       * @returns {Array|null} 要追加的节点；SAC 没拦住就是 null。
       */
      const sacNote = (label) => {
        if (sacBlocked !== true) return null;
        return h(
          'div',
          { className: 'dshcw-sacWarn', key: `sac-warn-${label}` },
          `联网拉取${label}编译产物失败，本机有SAC无法使用，如果信任本程序，可临时关闭SAC。`,
          h(
            'button',
            {
              type: 'button',
              className: 'dshcw-sacLink',
              onClick: () => { if (typeof onSacGuide === 'function') onSacGuide(); },
            },
            '[SAC设置]',
          ),
        );
      };
      // 滑块**拨到哪就立刻生效**（这个分区没有保存键）：有 onSwitch 就交给弹窗去存，
      // 没有（自检/孤立渲染）就只改草稿。
      const setSwitch = (key, value) => {
        if (typeof onSwitch === 'function') {
          onSwitch(key, value);
          return;
        }
        setDraft({ ...draft, perceive: { ...perceive, [key]: value } });
      };
      const visionReady = draft.models !== null && typeof draft.models === 'object'
        && draft.models.vision !== null && typeof draft.models.vision === 'object'
        && typeof draft.models.vision.model === 'string' && draft.models.vision.model !== '';
      // 语音识别器（DSH 自带 SenseVoice）现不现成：`/screen/status` 的 `speechService`（跟陪看开没开无关）
      const speechService = screenStats !== null && typeof screenStats === 'object'
        && screenStats.speechService !== null && typeof screenStats.speechService === 'object'
        ? screenStats.speechService
        : null;
      const speechReady = speechService !== null && speechService.available === true;

      // ── OCR 滑块的"点一下先编译"状态（用户 2026-11-05 定）─────────────────
      // null = 没试过；'checking' = 正在编；'missing-sdk' = 缺 Windows SDK；其它字符串 = 编译报错
      const [ocrCheck, setOcrCheck] = React.useState(null);
      // 音轨滑块被点、但识别器没就绪 → 标题右边亮红字（用户定的交互）
      const [speechHint, setSpeechHint] = React.useState(false);
      // 编译 OCR 引擎要 Windows SDK 里的 Windows.winmd（System32\WinMetadata 缺契约程序集，编不过）
      // OCR 引擎是不是已经编好（编好就点了直接开，不再每次转圈重编）
      //
      // `ocrEngineReady` 来自 `/screen/status`（打开设置时读的那一份快照）。**它不会自己刷新**：
      // 刚点完【下载】编好了，但快照还是旧值 → 在同一张打开的设置页里来回点滑块，每次都会
      // 再走一遍编译（用户实测就是这个现象）。所以本地加一份标记，编译成功后立刻置真。
      const ocrEngineReady = screenStats !== null && typeof screenStats === 'object'
        && screenStats.native !== null && typeof screenStats.native === 'object'
        && screenStats.native.engine === true;
      const [engineReadyLocal, setEngineReadyLocal] = React.useState(false);
      const engineReady = ocrEngineReady === true || engineReadyLocal === true;
      const sdkDownload = screenStats !== null && typeof screenStats === 'object'
        && screenStats.native !== null && typeof screenStats.native === 'object'
        && typeof screenStats.native.sdkDownload === 'string' && screenStats.native.sdkDownload !== ''
        ? screenStats.native.sdkDownload
        : 'https://developer.microsoft.com/windows/downloads/windows-sdk/';
      /** 点滑块要开 OCR：先让宿主当场编一次，编不出来就不开。 */
      const tryEnableOcr = () => {
        if (ocrCheck === 'checking') return;
        setOcrCheck('checking');
        fetch(`${API}/screen/ocr-engine`, { method: 'POST', headers: { accept: 'application/json' } })
          .then((response) => response.json())
          .then((data) => {
            // 先判 missing-sdk：宿主在没 SDK 时可能回 ok:true（退成无 OCR 版），不能当成成功
            if (data !== null && typeof data === 'object' && data.ocr === 'missing-sdk') {
              setOcrCheck('missing-sdk');
              return;
            }
            if (data !== null && typeof data === 'object' && data.ok === true) {
              setOcrCheck(null);
              setEngineReadyLocal(true);
              if (typeof onSubtitle === 'function') onSubtitle(true);
              return;
            }
            setOcrCheck(`编译失败：${String((data !== null && typeof data === 'object' && data.error) || '未知错误')}`);
          })
          .catch((error) => setOcrCheck(`编译失败：${String(error)}`));
      };

      /**
       * 点【下载】：拉 WinRT 契约包（3.6 MB，不提权、不装 SDK），装好自动再编一次。
       *
       * 这一步替代了原来"跳到微软 SDK 下载页"——用户要求别走网页。
       */
      const downloadWinmd = () => {
        if (ocrCheck === 'checking') return;
        setOcrCheck('downloading');
        fetch(`${API}/screen/ocr-winmd`, { method: 'POST', headers: { accept: 'application/json' } })
          .then((response) => response.json())
          .then((data) => {
            if (data !== null && typeof data === 'object' && data.ok === true) {
              setOcrCheck(null);
              setEngineReadyLocal(true);
              if (typeof onSubtitle === 'function') onSubtitle(true);
              return;
            }
            setOcrCheck(`下载失败：${String((data !== null && typeof data === 'object' && data.error) || '未知错误')}`);
          })
          .catch((error) => setOcrCheck(`下载失败：${String(error)}`));
      };

      /**
       * 一行"名字 + 提示 + 开关"。
       *
       * `state` / `handler` 只在**不属于 `perceive` 的开关**（桌宠在 `pet` 段）时才传；
       * 不传就走老路（读写 `perceive[key]` + `setSwitch`）。
       */
      const switchRow = (key, label, hint, disabled, state, handler) =>
        h(
          'div',
          { className: 'dshcw-switchRow', key },
          h(
            'div',
            { className: 'dshcw-switchText' },
            h('div', { className: 'dshcw-cardName' }, label),
            h('div', { className: 'dshcw-hint' }, hint),
          ),
          h(
            'button',
            {
              type: 'button',
              role: 'switch',
              'aria-checked': (state === undefined ? perceive[key] === true : state === true) ? 'true' : 'false',
              'aria-label': label,
              className: (state === undefined ? perceive[key] === true : state === true) ? 'dshcw-switch dshcw-switchOn' : 'dshcw-switch',
              disabled: disabled === true,
              onClick: () => {
                if (disabled === true) return;
                if (typeof handler === 'function') {
                  handler((state === undefined ? perceive[key] === true : state === true) !== true);
                  return;
                }
                setSwitch(key, perceive[key] !== true);
              },
            },
            h('span', { className: 'dshcw-switchKnob' }),
          ),
        );

      /**
       * 陪看的**子开关**：OCR（画面硬字幕识别）。
       *
       * 规矩（用户定）：陪看开着它才拨得动；陪看一关它一并关（弹窗那边会把
       * `screen.subtitle` 一起置 false）。**不开 OCR 也能正常陪看**——截屏识别照旧，
       * 看新闻/打游戏这种没有硬字幕的场景本来就不需要它。
       */
      const ocrRow = () => {
        const enabled = perceive.companion === true && visionReady === true;
        const on = enabled === true && screen.subtitle === true;
        return h(
          'div',
          { className: 'dshcw-switchRow dshcw-switchSub', key: 'subtitle' },
          h(
            'div',
            { className: 'dshcw-switchText' },
            // 标题行：`OCR` 右边直接跟红字 +【下载】（用户 2026-11-05 定的位置）
            h(
              'div',
              { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
              h('span', { className: 'dshcw-cardName' }, 'OCR'),
              ocrCheck === null
                ? null
                : h(
                  'span',
                  { style: ocrCheck === 'checking' || ocrCheck === 'downloading' ? { fontSize: 11, lineHeight: '16px' } : { fontSize: 11, lineHeight: '16px', color: 'var(--dsw-alias-label-danger, #e05c5c)' } },
                  ocrCheck === 'downloading'
                    ? '正在下载契约包（约 3.6 MB）…'
                    : (ocrCheck === 'checking'
                      ? '正在编译 OCR 引擎…'
                      : (ocrCheck === 'missing-sdk'
                        ? '缺少 Windows SDK，OCR 引擎编译不出来（点【下载】自动装契约包）'
                        : ocrCheck)),
                ),
              ocrCheck === 'missing-sdk'
                ? h(
                  'button',
                  {
                    type: 'button',
                    className: 'dshcw-langInstall',
                    onClick: () => downloadWinmd(),
                  },
                  '下载',
                )
                : null,
            ),
            h('div', { className: 'dshcw-hint' }, '读画面底部的硬字幕，用来抄准人名与台词；不开也能截图识别。', sacNote('OCR')),
          ),
          h(
            'button',
            {
              type: 'button',
              role: 'switch',
              'aria-checked': on === true ? 'true' : 'false',
              'aria-label': 'OCR',
              className: on === true ? 'dshcw-switch dshcw-switchOn' : 'dshcw-switch',
              disabled: enabled !== true,
              onClick: () => {
                if (enabled !== true) return;
                // 关：直接关。开：**先编译**，编不出来就不开（再点一次就是重试）。
                if (screen.subtitle === true) {
                  setOcrCheck(null);
                  if (typeof onSubtitle === 'function') onSubtitle(false);
                  return;
                }
                // 引擎已经编好 → 直接开，**不转圈、不重复编译**（用户反馈：每次点都"正在编译"很烦）
                if (engineReady === true) {
                  setOcrCheck(null);
                  if (typeof onSubtitle === 'function') onSubtitle(true);
                  return;
                }
                tryEnableOcr();
              },
            },
            h('span', { className: 'dshcw-switchKnob' }),
          ),
        );
      };

      /**
       * 陪看的第二个子开关：**音轨识别**（听扬声器在放什么，用 SenseVoice 转写成参考）。
       *
       * 规矩跟 OCR 一样：陪看开着才拨得动、陪看一关它一并关；识别器不现成时也拨不动
       * （服务没装 / 模型还没加载好）。**不开它也能正常陪看**。
       */
      const speechRow = () => {
        // 识别器不现成时**滑块照样能点**：点了在旁边红字告诉用户去哪儿开
        // （用户 2026-11-05 定：别只是拨不动，要说明白）。
        const baseReady = perceive.companion === true && visionReady === true;
        const enabled = baseReady === true && speechReady === true;
        const on = enabled === true && screen.speech === true;
        const hint = speechReady === true
          ? '听扬声器在说什么；识别不保证准确，只当参考。'
          : '听扬声器在说什么；这台机器没有可用的语音识别器。';
        return h(
          'div',
          { className: 'dshcw-switchRow dshcw-switchSub', key: 'speech' },
          h(
            'div',
            { className: 'dshcw-switchText' },
            h(
              'div',
              { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
              h('span', { className: 'dshcw-cardName' }, 'ASR'),
              speechReady !== true && speechHint === true
                ? h(
                  'span',
                  { style: { fontSize: 11, lineHeight: '16px', color: 'var(--dsw-alias-label-danger, #e05c5c)' } },
                  '需点击 DSH 左上角「插件」开启「语音输入(SenseVoice)」插件作为识别器',
                )
                : null,
            ),
            h('div', { className: 'dshcw-hint' }, hint, sacNote('ASR')),
          ),
          h(
            'button',
            {
              type: 'button',
              role: 'switch',
              'aria-checked': on === true ? 'true' : 'false',
              'aria-label': 'ASR',
              className: on === true ? 'dshcw-switch dshcw-switchOn' : 'dshcw-switch',
              disabled: baseReady !== true,
              onClick: () => {
                if (baseReady !== true) return;
                // 识别器没就绪：不切开关，只在标题右边亮红字说明去哪儿开
                if (speechReady !== true) {
                  setSpeechHint(true);
                  return;
                }
                if (typeof onSpeech !== 'function') return;
                onSpeech(screen.speech !== true);
              },
            },
            h('span', { className: 'dshcw-switchKnob' }),
          ),
        );
      };

    /**
     * 「感知」里的桌宠卡片：主开关 + **缩进的 TTS 子开关**。
     *
     * TTS 是主开关的从属（缩进 2em，和 OCR / 音轨同一个样式）：桌宠没开时它一并置灰。
     * 引擎不现成（借不到 DSH 的 Electron）时主开关也拨不动，并在提示行里说清原因。
     *
     * **Live2D Core 缺了也拨不动**（用户 2026-11-21 定）：那一下不打开开关，
     * 而是在下面亮一行红字 + 白色【下载】，点了从 Live2D 官方取（约 200 KB）。
     * Core 是 Live2D 的专有软件，不能随仓库发，所以这一层是必要的。
     */
    const petCard = () => {
      const pet = draft.pet !== null && typeof draft.pet === 'object' ? draft.pet : {};
      const on = pet.enabled === true;
      const runtimeOk = petStatus === null || petStatus.runtimeReady !== false;
      const core = petStatus !== null && petStatus.core !== null && typeof petStatus.core === 'object' ? petStatus.core : null;
      const coreMissing = core !== null && core.present !== true;
      const hint = petStatus !== null && petStatus.runtimeReady === false
        ? '找不到可用的窗口运行时。'
        : (coreMissing === true
          ? '还差 Live2D Core（约 200 KB），点下面的【下载】从官方取一份。'
          : '一个站在桌面上的 Live2D 小人，只显示气泡。');
      return h(
        'div',
        { className: 'dshcw-card', key: 'pet-card' },
        h(
          'div',
          { className: 'dshcw-cardHead' },
          h('span', { className: 'dshcw-cardName' }, '桌宠 Live2D'),
          h('span', { className: 'dshcw-cardTag' }, '桌面小人'),
        ),
        switchRow('pet', '开启桌宠', hint, runtimeOk !== true, on, (value) => {
          if (typeof onPet !== 'function') return;
          // 缺 Core 时**不打开开关**：红字和【下载】已经在那儿了，这里只要拒绝
          if (value === true && coreMissing === true) return;
          onPet('enabled', value);
        }),
        // 缺 Core：红字 + 白色【下载】。文案里点明"点下载表示同意许可"（EULA 是下载即视为同意）
        coreMissing === true
          ? h(
            'div',
            { className: 'dshcw-langWarn', key: 'pet-core-warn' },
            h(
              'span',
              { className: 'dshcw-langWarnText' },
              '缺 Live2D Cubism Core（约 200 KB）。点下载表示同意 Live2D 使用许可；下完自动放好，不用手动搬文件。',
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'dshcw-langInstall',
                title: core !== null && typeof core.license === 'string' ? core.license : '',
                onClick: () => { if (typeof onDownloadCore === 'function') onDownloadCore(); },
              },
              '下载',
            ),
          )
          : null,
        h(
          'div',
          { className: 'dshcw-switchRow dshcw-switchSub', key: 'pet-tts' },
          h(
            'div',
            { className: 'dshcw-switchText' },
            h('div', { className: 'dshcw-cardName' }, 'TTS'),
            h('div', { className: 'dshcw-hint' }, '它说话时出声。'),
          ),
          h(
            'button',
            {
              type: 'button',
              role: 'switch',
              'aria-checked': on === true && pet.tts === true ? 'true' : 'false',
              'aria-label': '桌宠 TTS',
              className: on === true && pet.tts === true ? 'dshcw-switch dshcw-switchOn' : 'dshcw-switch',
              disabled: on !== true,
              onClick: () => {
                if (on !== true || typeof onPet !== 'function') return;
                onPet('tts', pet.tts !== true);
              },
            },
            h('span', { className: 'dshcw-switchKnob' }),
          ),
        ),
      );
    };

      return h(
        'div',
        { className: 'dshcw-section' },
        h('h2', { className: 'dshcw-sectionTitle' }, '感知'),
        h(
          'div',
          { className: 'dshcw-card' },
          h(
            'div',
            { className: 'dshcw-cardHead' },
            h('span', { className: 'dshcw-cardName' }, '窗口监测'),
            h('span', { className: 'dshcw-cardTag' }, '前台窗口'),
          ),
          switchRow('window', '开启窗口监测', ['看前台窗口（含浏览器切标签页）。', sacNote('窗口监测')]),
        ),
        h(
          'div',
          { className: 'dshcw-card' },
          h(
            'div',
            { className: 'dshcw-cardHead' },
            h('span', { className: 'dshcw-cardName' }, '专注模式'),
            h('span', { className: 'dshcw-cardTag' }, '摸鱼才开口'),
          ),
          switchRow('focus', '开启专注模式', '判成摸鱼才开口，工作不出声。'),
        ),
        h(
          'div',
          { className: 'dshcw-card' },
          h(
            'div',
            { className: 'dshcw-cardHead' },
            h('span', { className: 'dshcw-cardName' }, '屏幕陪看'),
            h('span', { className: 'dshcw-cardTag' }, '看屏幕'),
          ),
          switchRow('companion', '开启屏幕陪看', visionReady ? '看屏幕，它自己判断要不要开口。' : '先去「模型」填 Vision 模型。', visionReady !== true),
          ocrRow(),
          speechRow(),
        ),
        // 桌宠是**并列的一张卡**（不是陪看的附属），就排在陪看下面
        petCard(),
      );
    }

    /**
     * 「桌宠」分区：绿幕调整模式、模型缩放、TTS 设置（含试听）。
     *
     * **主开关关着时整块置灰**（用户要求"标签里在桌宠开关开启时可更改"），
     * 但仍然显示当前值，方便先看清配置再决定开不开。
     *
     * 所有旋钮**拨到哪就立刻写回**（和「感知」一样没有保存键）。
     *
     * @param {object} props - `{draft, setDraft, onPet, petStatus}`。
     */
    function PetSection({ draft, setDraft, onPet, petStatus, previewText, previewBusy, previewHint, setPreviewText, playPreview, editOn, onToggleEdit, onScale, onBubble, petVoices, onInstall }) {
      const pet = draft.pet !== null && typeof draft.pet === 'object' ? draft.pet : {};
      const locked = pet.enabled !== true;
      // 现有模型：宿主扫 `pet/assets/live2d/` 下的文件夹（`/pet/status` 一并带回来）。
      // 存的文件夹被删了就退回第一个 —— 和宿主 `resolveModel` 的判断保持一致。
      const modelList = petStatus !== null && typeof petStatus === 'object' && Array.isArray(petStatus.models)
        ? petStatus.models
          .map((item) => (item !== null && typeof item === 'object' ? item.id : ''))
          .filter((id) => typeof id === 'string' && id !== '')
        : [];
      const configuredModel = typeof pet.model === 'string' ? pet.model : '';
      const currentModelName = modelList.includes(configuredModel) ? configuredModel : (modelList.length > 0 ? modelList[0] : '');
      // 音色清单：按**当前选的模型**取（aishell3 174 个序号 / kokoro 103 个名字 / 其余单音色）
      const modelKey = pet.ttsModel === 'melo' ? 'melo' : 'edge';
      const modelsInfo = petVoices !== null && typeof petVoices === 'object' && petVoices.models !== undefined ? petVoices.models : null;
      const currentModel = modelsInfo !== null && modelsInfo[modelKey] !== undefined ? modelsInfo[modelKey] : null;
      const modelReady = currentModel !== null && currentModel.installed === true;
      const voiceOptions = modelReady === true && Array.isArray(currentModel.voices) ? currentModel.voices : [];
      // 本地引擎（sherpa-onnx-node）可用性：false 时说明别人的 DSH 没开「语音输入」插件
      const localEngineOk = petVoices !== null && typeof petVoices === 'object' && petVoices.localEngine !== undefined
        ? petVoices.localEngine?.ok === true
        : true;
      const voiceHint = currentModel === null
        ? '读不到音色清单（宿主没接上 TTS）'
        : modelReady !== true
          ? '这个模型还没装'
          : '这个模型只有一个音色';
      /** 改草稿里的一个桌宠字段。**不写设置** —— 用户要求「点保存才算数」。 */
      const setPet = (key, value) => {
        setDraft({ ...draft, pet: { ...pet, [key]: value } });
      };
      const statusText = petStatus === null || petStatus === undefined
        ? '桌宠状态读取中…'
        : petStatus.enabled === true
          ? `桌宠在跑（pid ${String(petStatus.pid ?? 0)}）`
          : petStatus.runtimeReady === false
            ? `桌宠没起来：${String(petStatus.runtimeError ?? '')}`
            : '桌宠没在跑';
      return h(
        'div',
        { className: 'dshcw-section' },
        h('h2', { className: 'dshcw-sectionTitle' }, '桌宠'),
        h(
          'p',
          { className: 'dshcw-cardIntro' },
          '开关在「感知」标签的桌宠卡片里。这里调它长什么样、说话什么声；改完要点保存。',
        ),
        // ── 模型（第一行：一个模型一个方框）────────────────────────────
        // 用户 2026-11-20 定的：方框里写模型名，点一下切过去；文件夹删了方框就没了，
        // 只显示**现在真的有**的模型。放进去一个新文件夹（名字随便起）就自动多一个方框。
        h(
          'div',
          { className: 'dshcw-card', key: 'pet-model-card' },
          h(
            'div',
            { className: 'dshcw-cardHead' },
            h('span', { className: 'dshcw-cardName' }, '模型'),
            modelList.length > 0
              ? h('span', { className: 'dshcw-cardTag' }, `${modelList.length} 个`)
              : null,
          ),
          modelList.length === 0
            ? h('div', { className: 'dshcw-hint' }, '一个模型都没有：把模型文件夹放进 pet/assets/live2d/ 就行（文件夹名 = 这里的名字）。')
            : h(
              'div',
              { className: 'dshcw-modelRow' },
              modelList.map((item) => {
                const on = item === currentModelName;
                return h(
                  'button',
                  {
                    key: `pet-model-${item}`,
                    type: 'button',
                    className: on === true ? 'dshcw-modelChip dshcw-modelChipOn' : 'dshcw-modelChip',
                    title: item,
                    'aria-pressed': on === true ? 'true' : 'false',
                    disabled: locked,
                    onClick: () => {
                      if (on === true) return;
                      if (typeof onPet === 'function') onPet('model', item);
                    },
                  },
                  item,
                );
              }),
            ),
          // 只在**有模型**时才提示放法：没有模型的时候上面那句已经把"放哪里"说清了，
          // 两句同时出现就是同一件事说两遍（用户 2026-11-21 指出的重复）。
          modelList.length > 0
            ? h('div', { className: 'dshcw-hint' }, '每个模型放在 pet/assets/live2d/ 下、以它自己命名的文件夹里；点方框就切过去。')
            : null,
        ),
        // ── 调整模式（绿幕）──────────────────────────────────────────────
        // 绿幕是**当场调一下**的状态：拨了立刻生效、但**不写设置**，关弹窗/切标签/重启都回到关。
        h(
          'div',
          { className: 'dshcw-card' },
          h(
            'div',
            { className: 'dshcw-cardHead' },
            h('span', { className: 'dshcw-cardName' }, '调整模式'),
            h('span', { className: 'dshcw-cardTag' }, '绿幕'),
          ),
          h(
            'div',
            { className: 'dshcw-switchRow', key: 'pet-editMode' },
            h(
              'div',
              { className: 'dshcw-switchText' },
              h('div', { className: 'dshcw-cardName' }, '开启绿幕调整'),
              h('div', { className: 'dshcw-hint' }, '窗口变绿：拖边缘改大小、拖模型挪位置、拖绿幕搬窗口。'),
            ),
            h(
              'button',
              {
                type: 'button',
                role: 'switch',
                'aria-checked': editOn === true ? 'true' : 'false',
                'aria-label': '开启绿幕调整',
                className: editOn === true ? 'dshcw-switch dshcw-switchOn' : 'dshcw-switch',
                disabled: locked,
                onClick: () => { if (locked !== true && typeof onToggleEdit === 'function') onToggleEdit(editOn !== true); },
              },
              h('span', { className: 'dshcw-switchKnob' }),
            ),
          ),
          // 折叠区：绿幕关着时高度 0（不可见、点不到），开着时向下展开
          h(
            'div',
            {
              className: 'dshcw-fold',
              key: 'pet-scale-fold',
              style: { maxHeight: editOn === true ? '200px' : '0px', opacity: editOn === true ? '1' : '0' },
              'aria-hidden': editOn === true ? 'false' : 'true',
            },
            h(
              'div',
              { className: 'dshcw-sliderRow' },
              h('label', { className: 'dshcw-fieldLabel', htmlFor: 'dshcw-pet-modelScale' }, `模型缩放 ${Number(pet.modelScale ?? 1).toFixed(2)}×`),
              h('input', {
                id: 'dshcw-pet-modelScale',
                className: 'dshcw-slider',
                type: 'range',
                min: 0.3,
                max: 2,
                step: 0.01,
                value: pet.modelScale === undefined || pet.modelScale === null ? 1 : pet.modelScale,
                disabled: locked || editOn !== true,
                onInput: (event) => { if (typeof onScale === 'function') onScale(Number(event.target.value)); },
              }),
            ),
            // 气泡位置：绿幕里会画出对应位置的框，能直接看到气泡占多大、贴哪儿
            h(
              'div',
              { className: 'dshcw-langRow', key: 'pet-bubblePosition' },
              h('label', { className: 'dshcw-fieldLabel', htmlFor: 'dshcw-pet-bubblePosition' }, '气泡位置'),
              h(
                'select',
                {
                  id: 'dshcw-pet-bubblePosition',
                  className: 'dshcw-select',
                  value: pet.bubblePosition === 'bottom' ? 'bottom' : 'top',
                  disabled: locked || editOn !== true,
                  onChange: (event) => { if (typeof onBubble === 'function') onBubble(event.target.value); },
                },
                h('option', { value: 'top' }, '置顶'),
                h('option', { value: 'bottom' }, '置底'),
              ),
            ),
          ),
        ),
        // ── TTS 设置（用框框起来）────────────────────────────────────────
        h(
          'div',
          { className: 'dshcw-card', key: 'pet-tts-card' },
          h(
            'div',
            { className: 'dshcw-cardHead' },
            h('span', { className: 'dshcw-cardName' }, 'TTS 设置'),
            h('span', { className: 'dshcw-cardTag' }, '语音合成'),
          ),
          // 模型：Kokoro 音色多但慢（RTF≈1.6、约 4 核），melo 快（RTF≈0.31）但只有一个女声。
          // 给个开关是因为两者差 8 倍速度，用户可能要来回试。
          h(
            'div',
            { className: 'dshcw-langRow', key: 'pet-ttsModel' },
            h('label', { className: 'dshcw-fieldLabel', htmlFor: 'dshcw-pet-ttsModel' }, '模型'),
            h(
              'select',
              {
                id: 'dshcw-pet-ttsModel',
                className: 'dshcw-select',
                value: pet.ttsModel === 'melo' ? 'melo' : 'edge',
                disabled: locked,
                onChange: (event) => setPet('ttsModel', event.target.value),
              },
              // 只剩两个：edge（在线，14 个中文音色 + 可调音调）和 melo（本地，单女声，断网时用）
              h('option', { value: 'edge' }, 'Edge 在线（14 音色，要联网，免费）'),
              h('option', { value: 'melo' }, 'MeloTTS 本地（单女声，离线）'),
            ),
          ),
          // 音色（kokoro 103 个；melo 只有一个，显示为不可选）
          h(
            'div',
            { className: 'dshcw-langRow', key: 'pet-ttsVoice' },
            h('label', { className: 'dshcw-fieldLabel', htmlFor: 'dshcw-pet-ttsVoice' }, '音色'),
            voiceOptions.length === 0
              ? h('span', { className: 'dshcw-hint' }, voiceHint)
              : h(
                'select',
                {
                  id: 'dshcw-pet-ttsVoice',
                  className: 'dshcw-select',
                  value: pet.ttsVoice === undefined || pet.ttsVoice === null ? '' : pet.ttsVoice,
                  disabled: locked,
                  onChange: (event) => setPet('ttsVoice', event.target.value),
                },
                ...voiceOptions.map((item) => h('option', { key: item.name, value: item.name }, item.label)),
              ),
          ),
          h(
            'div',
            { className: 'dshcw-sliderRow' },
            h('label', { className: 'dshcw-fieldLabel', htmlFor: 'dshcw-pet-ttsSpeed' }, `语速 ${Number(pet.ttsSpeed ?? 1).toFixed(2)}×`),
            h('input', {
              id: 'dshcw-pet-ttsSpeed',
              className: 'dshcw-slider',
              type: 'range',
              min: 0.5,
              max: 2,
              step: 0.05,
              value: pet.ttsSpeed === undefined || pet.ttsSpeed === null ? 1 : pet.ttsSpeed,
              disabled: locked,
              onInput: (event) => setPet('ttsSpeed', Number(event.target.value)),
            }),
          ),
          // 音调：MeloTTS 只有 1 个音色，改音调是最直接的"换声音"手段
          h(
            'div',
            { className: 'dshcw-sliderRow' },
            h('label', { className: 'dshcw-fieldLabel', htmlFor: 'dshcw-pet-ttsPitch' }, `音调 ${Number(pet.ttsPitch ?? 0) > 0 ? '+' : ''}${Number(pet.ttsPitch ?? 0).toFixed(1)} 半音`),
            h('input', {
              id: 'dshcw-pet-ttsPitch',
              className: 'dshcw-slider',
              type: 'range',
              min: -12,
              max: 12,
              step: 1,
              value: pet.ttsPitch === undefined || pet.ttsPitch === null ? 0 : pet.ttsPitch,
              disabled: locked,
              onInput: (event) => setPet('ttsPitch', Number(event.target.value)),
            }),
          ),
          h(
            'div',
            { className: 'dshcw-sliderRow' },
            h('label', { className: 'dshcw-fieldLabel', htmlFor: 'dshcw-pet-ttsVolume' }, `音量 ${Math.round(Number(pet.ttsVolume ?? 0.8) * 100)}%`),
            h('input', {
              id: 'dshcw-pet-ttsVolume',
              className: 'dshcw-slider',
              type: 'range',
              min: 0,
              // 上限 2.0：宿主端软增益，<audio> 的音量封顶 1.0 不够响
              max: 2,
              step: 0.05,
              value: pet.ttsVolume === undefined || pet.ttsVolume === null ? 1 : pet.ttsVolume,
              disabled: locked,
              onInput: (event) => setPet('ttsVolume', Number(event.target.value)),
            }),
          ),
          // 试听：输入框内容**不进设置**，纯粹用来听音色/语速
          h(
            'div',
            { className: 'dshcw-field' },
            h('label', { className: 'dshcw-fieldLabel', htmlFor: 'dshcw-pet-preview' }, '试听'),
            h('textarea', {
              id: 'dshcw-pet-preview',
              className: 'dshcw-input dshcw-textarea',
              rows: 2,
              placeholder: '打一句话试试它的声音……',
              value: previewText,
              onInput: (event) => setPreviewText(event.target.value),
            }),
          ),
          h(
            'div',
            { className: 'dshcw-inputRow' },
            h(
              'button',
              {
                type: 'button',
                className: 'dshcw-btnSecondary dshcw-fetchBtn',
                // 缺模型时这个按钮变成「下载」——要能点，所以不能因为 not ready 就禁用它
                disabled: locked || (modelReady === true && previewBusy === true) || currentModel?.installing === true,
                onClick: () => {
                  if (modelReady !== true && currentModel !== null) {
                    if (typeof onInstall === 'function') onInstall(modelKey);
                    return;
                  }
                  void playPreview();
                },
              },
              modelReady !== true && currentModel !== null
                ? (currentModel.installing === true
                  ? `下载中 ${Number(currentModel.installPercent ?? 0)}%`
                  : `下载模型（${modelKey === 'melo' ? '约 0.2 GB' : '首次使用'}）`)
                : (previewBusy === true ? '合成中…' : '试听'),
            ),
          ),
          // 选了本地模型但还没装：「下载」旁边必须说清楚它依赖什么 ——
          // 本地 TTS 的运行时（sherpa-onnx-node）不是本插件的依赖，是 DSH「语音输入」插件带进来的。
          // 不提示的话，别人会下载完 200 MB 才发现合成时报错。
          modelKey === 'melo' && modelReady !== true
            ? h(
              'p',
              { className: 'dshcw-hint' },
              localEngineOk === false
                ? '本地语音引擎没加载：请先在 DSH 插件里开启「语音输入」插件，再回来下载模型。'
                : '本地模型依赖 DSH 的「语音输入」插件提供语音引擎（它随该插件一起安装）。',
            )
            : null,
          h('p', { className: 'dshcw-hint' }, previewHint),
        ),
        h('p', { className: 'dshcw-status' }, statusText),
      );
    }

    /**
     * 「设置」分区：数据目录、记忆库的两个数值、成长日记开关。
     *
     * 数值框里存的是**字符串**（用户正在输入，别替他改），归一与夹边界由宿主负责；
     * 保存成功后这里会用宿主回传的设置刷新草稿，所以框里最终显示的是真正存下的值。
     *
     * @param {{draft: object, setDraft: (next: object) => void, stats: object|null}} props - 草稿、改草稿、记忆库状态。
     */
    function GeneralSection({ draft, setDraft, stats, screenStats, onCompress, onReveal, compressing, onRefreshScreen, onPurged }) {
      const memory = draft.memory !== null && typeof draft.memory === 'object' ? draft.memory : {};
      const setNumber = (key, value) => setDraft({ ...draft, memory: { ...memory, [key]: value } });
      const growth = draft.growth !== null && typeof draft.growth === 'object' ? draft.growth : {};
      const screenOptions = draft.screen !== null && typeof draft.screen === 'object' ? draft.screen : {};
      /** 改 `draft.screen` 里的一个字段（名字里带 Number 是历史原因，布尔开关也走它）。 */
      const setScreenNumber = (key, value) => setDraft({ ...draft, screen: { ...screenOptions, [key]: value } });
      const companionState = screenStats !== null && screenStats.companion !== null && typeof screenStats.companion === 'object'
        ? screenStats.companion
        : null;
      const subtitleState = companionState !== null && companionState.subtitle !== null && typeof companionState.subtitle === 'object'
        ? String(companionState.subtitle.mode)
        : 'off';
      const subtitleText = subtitleState === 'locked'
        ? '字幕 已锁定'
        : subtitleState === 'probing'
          ? '字幕 认字中'
          : subtitleState === 'idle'
            ? '字幕 待机中'
            : subtitleState === 'no_subtitle'
              ? '字幕 这段没有'
              : '字幕 没在跑';
      // 音轨识别现场：采样在跑没跑、听没听到、转写耗时（识别结果不入库，这里只报计数）
      const speechState = companionState !== null && companionState.speech !== null && typeof companionState.speech === 'object'
        ? companionState.speech
        : null;
      const speechText = speechState === null || speechState.mode === 'off'
        ? 'ASR 没在采'
        : speechState.paused === true
          ? 'ASR 暂停中'
          : speechState.ready === true
            ? `ASR 在听（已听 ${String(speechState.heard ?? 0)} 句${Number(speechState.inferenceMs) > 0 ? `，上次转写 ${String(speechState.inferenceMs)} ms` : ''}）`
            : 'ASR 识别器还没就绪';
      const screenStatusText = screenStats === null
        ? '陪看状态读取中…'
        : `未压缩 ${screenStats.uncompressed} 条 · 摘要 ${screenStats.summaries} 条 · 今日入库 ${screenStats.today} 条 · 窗口记录 ${screenStats.frames} 条 · ${subtitleText} · ${speechText}`;

      // ── OCR 语言：本机装了哪几门 / 选的那门在不在 ──────────────────────
      // 装在哪儿：优先 `/screen/status` 的 `ocr.langs`（宿主扫的），引擎跑着时也可以用它报的 `ocrLangs`
      const installedLangs = (() => {
        if (screenStats !== null && screenStats.ocr !== null && typeof screenStats.ocr === 'object' && Array.isArray(screenStats.ocr.langs)) {
          return screenStats.ocr.langs.map((one) => String(one));
        }
        const fromEngine = companionState !== null && companionState.capture !== null && typeof companionState.capture === 'object'
          ? String(companionState.capture.ocrLangs === undefined || companionState.capture.ocrLangs === null ? '' : companionState.capture.ocrLangs)
          : '';
        return fromEngine.split(',').map((one) => one.trim()).filter((one) => one !== '');
      })();
      const langValue = typeof screenOptions.subtitleLangs === 'string' && screenOptions.subtitleLangs !== '' ? screenOptions.subtitleLangs : 'zh-Hans-CN';
      // 缺 SDK 的红字只在**上面那个 OCR 滑块**里显示（写在它的标题文字里），
      // 这里不再重复一份。
      const langLabel = (value) => {
        const found = OCR_LANGS.find((item) => item.value === value);
        return found === undefined ? value : found.label;
      };
      /**
       * 本机装的那门是不是就是它。
       * 完全相等算；`en` ↔ `en-US`、`ja` ↔ `ja-JP` 这种只差地区码的也算；
       * 但 **zh 要连"简/繁"那一节都比**（`zh-Hans-CN` 与 `zh-Hant-TW` 是两门不同的识别器）。
       */
      const langInstalled = (wanted) => installedLangs.some((one) => {
        if (one === wanted) return true;
        const a = one.split('-');
        const b = String(wanted).split('-');
        if (a[0] !== b[0]) return false;
        if (a[0] === 'zh') return a.length >= 2 && b.length >= 2 && a[1] === b[1];
        return true;
      });
      const langMissing = langValue !== 'auto' && installedLangs.length > 0 && langInstalled(langValue) !== true;

      // 缺语言包时那一行的状态：null = 还没点安装；{kind:'progress'|'failed'|'stuck'|'done', text} = 进度/结果
      const [installNote, setInstallNote] = React.useState(null);
      const [installBusy, setInstallBusy] = React.useState(false);
      /**
       * 装包失败的原因翻成人话。宿主那边给的是**短标签**（`uac-cancelled` 这种）或系统原文，
       * 认得的翻中文，认不得的照原样贴出来（那是 Windows 自己说的话，比瞎猜有用）。
       */
      const failText = (message) => {
        const said = String(message === undefined || message === null ? '' : message);
        if (said === 'uac-cancelled') return '授权被取消了，再点【重试】';
        if (said === 'elevated-did-not-start') return '提升权限后脚本没能跑起来（可能是被安全软件拦了）';
        if (said === 'elevated-did-not-finish') return '提升权限的脚本中途退出了，再点【重试】';
        if (said === 'launcher-did-not-start') return '装包程序没起来（连第一行都没跑到），再点【重试】';
        if (said.indexOf('launcher-spawn-failed') === 0) return '安装程序没能启动，再点【重试】';
        if (said.indexOf('elevated-exit-') === 0) return `提升权限的脚本退出码 ${said.slice('elevated-exit-'.length)}`;
        return `安装失败：${said}`;
      };
      /** 点【安装】/【重试】：走宿主的 `/screen/ocr-language`（提升权限去装），然后每 2 秒问一次进度。 */
      const startInstall = (tag) => {
        setInstallBusy(true);
        setInstallNote({ kind: 'progress', text: '正在申请管理员权限（弹出 UAC 就点「是」）…' });
        fetch(`${API}/screen/ocr-language`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ tag }),
        })
          .then((response) => response.json())
          .then((data) => {
            if (data === null || data.ok !== true) throw new Error(String(data === null ? 'unknown' : data.error));
            pollInstall(0, false);
          })
          .catch((error) => {
            setInstallBusy(false);
            setInstallNote({ kind: 'failed', text: `安装没能启动：${String(error)}` });
          });
      };
      /**
       * 轮询安装进度。宿主那边正常时**一定会给结局**（装好或失败），所以只有两种"没结局"要自己兜：
       *   · 一直停在 `starting` = 升权限那一跳没起来（点了「否」、或被挡住没看见）→ 40 秒就判
       *   · `running` 太久 = 大概真卡了 → 给足两小时（**实测英文包装了 26 分钟**，早先按 10 分钟判死过）
       */
      const INSTALL_START_MAX_ROUNDS = 20;
      const INSTALL_RUNNING_MAX_ROUNDS = 720;
      const pollInstall = (round, sawRunning, runRounds) => {
        const runCount = Number.isFinite(runRounds) ? runRounds : 0;
        if (sawRunning === true && runCount > INSTALL_RUNNING_MAX_ROUNDS) {
          setInstallBusy(false);
          setInstallNote({ kind: 'stuck', text: '装了很久还没结束，可以再点【重试】看看，或去「设置 → 时间和语言」手动装' });
          return;
        }
        if (sawRunning !== true && round > INSTALL_START_MAX_ROUNDS) {
          setInstallBusy(false);
          setInstallNote({ kind: 'stuck', text: '没等到授权（UAC 可能被别的窗口挡住了）。再点【重试】，或去「设置 → 时间和语言」手动装' });
          window.setTimeout(() => pollInstall(round + 1, sawRunning, runCount), 4000);
          return;
        }
        fetch(`${API}/screen/ocr-language`, { headers: { accept: 'application/json' } })
          .then((response) => response.json())
          .then((data) => {
            const install = data !== null && typeof data.install === 'object' && data.install !== null ? data.install : null;
            const state = install === null ? '' : String(install.state);
            if (state === 'done') {
              setInstallBusy(false);
              setInstallNote({ kind: 'done', text: `「${langLabel(langValue)}」语言包装好了${String(install.message) === 'installed-restart-needed' ? '（系统说重启后才完全生效）' : ''}` });
              if (typeof onRefreshScreen === 'function') onRefreshScreen();
              return;
            }
            if (state === 'failed') {
              setInstallBusy(false);
              setInstallNote({ kind: 'failed', text: failText(install.message) });
              return;
            }
            if (state === 'running') {
              setInstallBusy(true);
              setInstallNote({ kind: 'progress', text: '正在下载安装（要联网，大的语言包会很久；这期间可以走开，结局会记下来）…' });
              window.setTimeout(() => pollInstall(round + 1, true, runCount + 1), 10000);
              return;
            }
            setInstallBusy(true);
            setInstallNote({ kind: 'progress', text: '等待授权（弹出 UAC 就点「是」）…' });
            window.setTimeout(() => pollInstall(round + 1, sawRunning, runCount), 2000);
          })
          .catch(() => {
            window.setTimeout(() => pollInstall(round + 1, sawRunning, runCount), 5000);
          });
      };
      /**
       * 刷新页面时接上一次**还在跑**的安装：提升权限的进程不随页面走，所以刷新后照样能看它的进度。
       * （不然刷新一次就退回「本机没装…」+【安装】，而它其实正在装。）
       */
      React.useEffect(() => {
        let alive = true;
        fetch(`${API}/screen/ocr-language`, { headers: { accept: 'application/json' } })
          .then((response) => response.json())
          .then((data) => {
            if (alive !== true) return;
            const install = data !== null && typeof data.install === 'object' && data.install !== null ? data.install : null;
            if (install === null || String(install.tag) !== langValue) return;
            const state = String(install.state);
            if (state === 'running') {
              setInstallBusy(true);
              setInstallNote({ kind: 'progress', text: '正在下载安装（要联网，大的语言包会很久；这期间可以走开，结局会记下来）…' });
              pollInstall(0, true, 0);
              return;
            }
            if (state === 'starting') {
              setInstallBusy(true);
              setInstallNote({ kind: 'progress', text: '等待授权（弹出 UAC 就点「是」）…' });
              pollInstall(0, false, 0);
              return;
            }
            if (state === 'failed') setInstallNote({ kind: 'failed', text: failText(install.message) });
          })
          .catch(() => {
            // 问不到就当没在装（用户再点一下也照样能起来）
          });
        return () => {
          alive = false;
        };
      }, [langValue]);
      const setGrowth = (enabled) => setDraft({ ...draft, growth: { ...growth, enabled } });
      const store = draft.store !== null && typeof draft.store === 'object' ? draft.store : {};
      const setDir = (dir) => setDraft({ ...draft, store: { ...store, dir } });
      // 清空历史数据的结果（点一下才出现）；purgeAsk = 确认小窗口开着
      const [purgeStatus, setPurgeStatus] = React.useState('');
      const [purgeAsk, setPurgeAsk] = React.useState(false);

      /** 一个数字框（只有标签 + 框，没有说明行）。 */
      const numberField = (key, label, min, max) =>
        h(
          'div',
          { className: 'dshcw-field', key },
          h('label', { className: 'dshcw-fieldLabel', htmlFor: `dshcw-memory-${key}` }, label),
          h('input', {
            id: `dshcw-memory-${key}`,
            className: 'dshcw-input',
            type: 'number',
            min,
            max,
            step: 1,
            value: memory[key] === undefined || memory[key] === null ? '' : String(memory[key]),
            onChange: (event) => setNumber(key, event.target.value),
          }),
        );

      /** 一个屏幕陪看的数字框（同 numberField，但写进 `draft.screen`，可给小数步长）。 */
      const screenNum = (key, label, min, max, step) =>
        h(
          'div',
          { className: 'dshcw-field', key },
          h('label', { className: 'dshcw-fieldLabel', htmlFor: `dshcw-screen-${key}` }, label),
          h('input', {
            id: `dshcw-screen-${key}`,
            className: 'dshcw-input',
            type: 'number',
            min,
            max,
            step: step === undefined ? 1 : step,
            value: screenOptions[key] === undefined || screenOptions[key] === null ? '' : String(screenOptions[key]),
            onChange: (event) => setScreenNumber(key, event.target.value),
          }),
        );

      const statsError = stats !== null && typeof stats.error === 'string' && stats.error !== '';
      const growthInfo = stats !== null && stats.growth !== null && typeof stats.growth === 'object' ? stats.growth : null;
      const growthText = growthInfo === null
        ? '状态未知'
        : growthInfo.entries > 0
          ? `已记 ${growthInfo.entries} 条`
          : '还没写过';
      const statsText = stats === null
        ? '读取中…'
        : `记忆 ${stats.memories} 条 · 待入库 ${stats.pending} 条`;

      /**
       * 清空历史数据：**消息 + 记忆 + 屏幕记忆（含字幕原文）+ 窗口记录**。
       * 人格与成长日记不动（那是设定）；截图文件也不删（那是文件不是库）。
       *
       * 确认用的是**插件自己样式的小弹窗**（用户要求：不要浏览器自带的 confirm）。
       */
      const runPurge = () => {
        setPurgeAsk(false);
        setPurgeStatus('清理中…');
        fetch(`${API}/store/clear`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        })
          .then((response) => response.json())
          .then((data) => {
            // 库清干净了，聊天窗口也要跟着清（那边是 React state，不通知就一直留着）
            if (data.ok === true && typeof onPurged === 'function') onPurged();
            setPurgeStatus(data.ok === true
              ? `已清空 ${data.messages} 条消息、${data.memories} 条记忆、${data.screenMemories ?? 0} 条屏幕记忆、${data.windowEvents ?? 0} 条窗口记录`
              : `清空失败：${String(data.error)}`);
          })
          .catch((error) => setPurgeStatus(`清空失败：${String(error)}`));
      };

      return h(
        'div',
        { className: 'dshcw-section' },
        h('h2', { className: 'dshcw-sectionTitle' }, '设置'),
        // 数据放哪 + 清空历史数据（用户要求放在设置标签最上方）
        h(
          'div',
          { className: 'dshcw-card' },
          h(
            'div',
            { className: 'dshcw-cardHead' },
            h('span', { className: 'dshcw-cardName' }, '数据'),
            h('span', { className: 'dshcw-cardTag' }, '落盘位置'),
          ),
          h(
            'div',
            { className: 'dshcw-field' },
            h('label', { className: 'dshcw-fieldLabel', htmlFor: 'dshcw-store-dir' }, '数据目录'),
            h(
              'div',
              { className: 'dshcw-inputRow' },
              h('input', {
                id: 'dshcw-store-dir',
                className: 'dshcw-input',
                type: 'text',
                spellCheck: false,
                autoComplete: 'off',
                placeholder: '如 X:/AI_History',
                value: typeof store.dir === 'string' ? store.dir : '',
                onChange: (event) => setDir(event.target.value),
              }),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dshcw-btnSecondary dshcw-fetchBtn',
                  onClick: () => setPurgeAsk(true),
                  title: '清空消息、记忆、屏幕记忆与窗口记录（人格与成长日记不动；截图文件不删）',
                },
                '清空历史数据',
              ),
            ),
          ),
          h(
            'p',
            { className: statsError ? 'dshcw-status dshcw-statusError' : 'dshcw-status' },
            `${statsError ? `不可用：${stats.error}` : statsText}${purgeStatus === '' ? '' : ` · ${purgeStatus}`}`,
          ),
        ),
        h(
          'div',
          { className: 'dshcw-card' },
          h(
            'div',
            { className: 'dshcw-cardHead' },
            h('span', { className: 'dshcw-cardName' }, '记忆库'),
            h('span', { className: 'dshcw-cardTag' }, '入库'),
          ),
          h('p', { className: 'dshcw-cardIntro' }, '倒计时内可删消息，删掉的不进记忆库。'),
          h(
            'div',
            { className: 'dshcw-soulRow' },
            numberField('delayMinutes', '入库倒计时（分钟）', 0, 1440),
            numberField('recentMessages', '每轮带最近几条', 1, 50),
          ),
        ),
        h(
          'div',
          { className: 'dshcw-card' },
          h(
            'div',
            { className: 'dshcw-cardHead' },
            h('span', { className: 'dshcw-cardName' }, '成长日记'),
            h('span', { className: 'dshcw-cardTag' }, '越用越懂'),
          ),
          h(
            'label',
            { className: 'dshcw-checkRow', htmlFor: 'dshcw-growth-enabled' },
            h('input', {
              id: 'dshcw-growth-enabled',
              type: 'checkbox',
              className: 'dshcw-checkbox',
              checked: growth.enabled === true,
              onChange: (event) => setGrowth(event.target.checked),
            }),
            h('span', null, '开启成长日记'),
          ),
          h('p', { className: 'dshcw-cardIntro' }, '每 5 条新记忆更新一次；写坏了删 GROWTH.md 重来。'),
          h('p', { className: 'dshcw-status' }, growthText),
        ),
        h(
          'div',
          { className: 'dshcw-card' },
          h(
            'div',
            { className: 'dshcw-cardHead' },
            h('span', { className: 'dshcw-cardName' }, '屏幕陪看'),
            h('span', { className: 'dshcw-cardTag' }, '截图'),
          ),
          h(
            'div',
            { className: 'dshcw-soulRow' },
            screenNum('intervalMs', '截屏间隔（ms）', 250, 60000, 100),
            screenNum('sensitivity', '去重灵敏度（1–10）', 1, 10, 1),
          ),
          h(
            'div',
            { className: 'dshcw-subHeadRow' },
            h('span', { className: 'dshcw-subHead' }, '对话'),
            h('span', { className: 'dshcw-hint' }, '冷却 = 说完一句后攒多久再发；去重阈值越高越容易判成重复。'),
          ),
          h(
            'div',
            { className: 'dshcw-soulRow' },
            screenNum('speakCooldownMs', '开口冷却 = 每批最小间隔（ms，0 = 不等）', 0, 600000, 100),
            screenNum('dedupeCosine', '入库去重阈值（0.5–0.999）', 0.5, 0.999, 0.001),
          ),
          h(
            'div',
            { className: 'dshcw-soulRow' },
            screenNum('factsPerCall', '每次最多记住几条', 0, 10, 1),
            screenNum('compressBatch', '一次压缩条数', 1, 2000, 10),
          ),
          h(
            'div',
            { className: 'dshcw-soulRow' },
            screenNum('saidContext', '带入它说过的话（条）', 0, 20, 1),
            screenNum('sawContext', '带入它看过的画面（条）', 0, 20, 1),
          ),
          h(
            'div',
            { className: 'dshcw-subHeadRow' },
            h('span', { className: 'dshcw-subHead' }, 'OCR'),
            h('span', { className: 'dshcw-hint' }, '字幕认不出就自己停，换窗口再试一次。'),
          ),
          // 注意：缺 SDK 的红字**不放在这里** —— 它归上面的 OCR 滑块（写在标题那块文字里），
          // 两个地方都写就重复了（用户实测反馈）。
          h(
            'div',
            { className: 'dshcw-langRow' },
            h('label', { className: 'dshcw-fieldLabel', htmlFor: 'dshcw-screen-subtitleLangs' }, '字幕语言'),
            h(
              'select',
              {
                id: 'dshcw-screen-subtitleLangs',
                className: 'dshcw-select',
                value: langValue,
                onChange: (event) => setScreenNumber('subtitleLangs', event.target.value),
              },
              ...OCR_LANGS.map((item) => h('option', { key: item.value, value: item.value }, item.label)),
            ),
          ),
          // 这一行**按需变形**：缺语言包时变成提示 + 白色【安装】；选回一门已装的，立刻变回灰字说明
          langMissing
            ? h(
              'div',
              { className: 'dshcw-langWarn' },
              h(
                'span',
                { className: 'dshcw-langWarnText' },
                installNote === null
                  ? `本机没装「${langLabel(langValue)}」的 OCR 语言包（本机已装：${installedLangs.join('、')}）`
                  : installNote.text,
              ),
              // 缺语言包 → **打开系统的"添加语言"页**，插件不再自己装
              // （原来提权跑 DISM，实测六分钟以上装不完）。用户 2026-11-05 定。
              h(
                'button',
                {
                  type: 'button',
                  className: 'dshcw-langInstall',
                  disabled: installBusy,
                  onClick: () => {
                    setInstallNote({ kind: 'progress', text: '正在打开系统设置…' });
                    fetch(`${API}/screen/ocr-guide`, { method: 'POST', headers: { accept: 'application/json' } })
                      .then((response) => response.json())
                      .then((data) => {
                        setInstallNote(data !== null && typeof data === 'object' && data.ok === true
                          ? { kind: 'done', text: '已在系统设置里打开「语言和区域」：添加该语言后，进它的「选项」勾上「光学字符识别」即可。' }
                          : { kind: 'failed', text: `打不开设置页：${String((data !== null && typeof data === 'object' && data.error) || '未知')}` });
                      })
                      .catch((error) => setInstallNote({ kind: 'failed', text: `打不开设置页：${String(error)}` }));
                  },
                },
                installBusy ? '打开中…' : '去添加语言',
              ),
            )
            : h('p', { className: 'dshcw-hint' }, `用 Windows 10/11 自带的 WinRT OCR，不用装额外软件；本机已装：${installedLangs.length === 0 ? '（还没扫到）' : installedLangs.join('、')}。选「自动」会把它们都跑一遍，开销按语言数翻倍。`),
          h(
            'div',
            { className: 'dshcw-soulRow' },
            screenNum('subtitleRegionPercent', '字幕识别区域（屏高 %）', 10, 100, 5),
            screenNum('subtitleProbeMs', '字幕判定预算（ms）', 3000, 120000, 1000),
          ),
          h(
            'div',
            { className: 'dshcw-soulRow' },
            screenNum('subtitleMaxLines', '每批最多带几行字幕', 1, 20, 1),
            screenNum('subtitleMaxChars', '每批字幕最多多少字', 50, 2000, 50),
          ),
          h(
            'div',
            { className: 'dshcw-soulRow' },
            screenNum('subtitleIdleScanMs', '待机扫描间隔（ms）', 1000, 60000, 1000),
            screenNum('subtitleIdleMs', '待机总时长（ms）', 5000, 600000, 5000),
          ),
          // ── 音轨识别（ASR）：开关在「感知」标签的陪看下面；这里是它的旋钮 ──────────
          h(
            'div',
            { className: 'dshcw-subHeadRow' },
            h('span', { className: 'dshcw-subHead' }, 'ASR'),
            h('span', { className: 'dshcw-hint' }, '听扬声器在说什么，只当参考：识别不保证准确。'),
          ),
          h(
            'div',
            { className: 'dshcw-langRow' },
            h('label', { className: 'dshcw-fieldLabel', htmlFor: 'dshcw-screen-speechLangs' }, '识别语言'),
            h(
              'select',
              {
                id: 'dshcw-screen-speechLangs',
                className: 'dshcw-select',
                value: typeof screenOptions.speechLangs === 'string' && screenOptions.speechLangs !== '' ? screenOptions.speechLangs : 'auto',
                onChange: (event) => setScreenNumber('speechLangs', event.target.value),
              },
              ...SPEECH_LANGS.map((item) => h('option', { key: item.value, value: item.value }, item.label)),
            ),
          ),
          h(
            'div',
            { className: 'dshcw-soulRow' },
            screenNum('speechSensitivity', '识别灵敏度（1–10）', 1, 10, 1),
            screenNum('speechSilenceMs', '静音多久算一句（ms）', 200, 3000, 100),
          ),
          h(
            'div',
            { className: 'dshcw-soulRow' },
            screenNum('speechMaxMs', '一句最长（ms）', 2000, 60000, 1000),
            screenNum('speechMaxLines', '每批最多带几行', 1, 20, 1),
          ),
          h(
            'div',
            { className: 'dshcw-soulRow' },
            screenNum('speechMaxChars', '每批最多多少字', 50, 2000, 50),
          ),
          h('p', { className: 'dshcw-status' }, screenStatusText),
          // 截图引擎被 Windows Defender 的 AMSI 拦了（误报）：不解释的话，用户只会看到
          // "陪看开着、却一张画面都没有"，还以为插件坏了。
          companionState !== null
            && companionState.capture !== null
            && typeof companionState.capture === 'object'
            && companionState.capture.blockedByAv === true
            ? h(
                'p',
                { className: 'dshcw-status dshcw-statusError' },
                '截图引擎被 Windows 安全中心（Defender）拦截了，陪看和字幕拿不到画面。'
                + '处理办法：在“Windows 安全中心 → 病毒和威胁防护 → 排除项”里把文件夹 '
                + '~\\.dsh\\chat-widget\\native 加进排除；加完最多一分钟会自动恢复（不用重启 DSH）。',
              )
            : null,
          h(
            'div',
            { className: 'dshcw-inputRow' },
            h('button', {
              type: 'button',
              className: 'dshcw-btnSecondary dshcw-fetchBtn',
              onClick: onCompress,
              disabled: compressing,
            }, compressing ? '压缩中…' : '压缩摘要'),
            h('button', {
              type: 'button',
              className: 'dshcw-btnSecondary dshcw-fetchBtn',
              onClick: onReveal,
              title: '在资源管理器里打开截图文件夹',
            }, '打开文件夹'),
          ),
          h('p', { className: 'dshcw-hint' }, '屏幕陪看截图文件需手动清理（点右边按钮进文件夹自己删）。'),
        ),
        // 清空历史数据前的确认：**插件自己样式的小窗口**（用户要求换成跟设置同款，不要浏览器 confirm）
        purgeAsk === true
          ? h(
            'div',
            { className: 'dshcw-confirm', role: 'alertdialog', 'aria-modal': 'true', key: 'purge-confirm' },
            h('div', { className: 'dshcw-mask', 'aria-hidden': 'true', onClick: () => setPurgeAsk(false) }),
            h(
              'div',
              { className: 'dshcw-confirmCard' },
              h('div', { className: 'dshcw-confirmTitle' }, '清空历史数据？'),
              h('div', { className: 'dshcw-confirmText' },
                '消息、记忆、屏幕记忆（含字幕原文）、窗口记录都会删掉。',
                h('br'),
                '人格（SOUL.md）与成长日记（GROWTH.md）不动；截图文件不删。',
                h('br'),
                '清空后无法撤销。'),
              h(
                'div',
                { className: 'dshcw-confirmActions' },
                h('button', { type: 'button', className: 'dshcw-btnSecondary', onClick: () => setPurgeAsk(false) }, '取消'),
                h('button', { type: 'button', className: 'dshcw-btnPrimary', onClick: runPurge }, '确定清空'),
              ),
            ),
          )
          : null,
      );
    }

    /**
     * 设置弹窗。
     * @param {{ open: boolean, onClose: () => void }} props - 开关与关闭回调。
     */
    function SettingsDialog({ open, onClose, onPurged }) {
      const [draft, setDraft] = React.useState(cloneDefaults);
      // 每个角色的密钥框是否被用户动过；
      // 没动过 = 尊重宿主「字段缺失即保留」，动过 = 以框内值为准（含清空删除）。
      const [touched, setTouched] = React.useState(emptyTouched);
      // 人格：十个框 + 数据目录（用于显示落盘位置）。soulBaseRef 记「读进来时的样子」，
      // 保存时据此判断要不要写文件（没改过就别去覆盖 SOUL.md）。
      const [soulFields, setSoulFields] = React.useState(emptySoulForm);
      const [soulDir, setSoulDir] = React.useState('');
      // 记忆库状态（设置分区显示「记忆 N 条 · 待入库 M 条」）；null = 还没读到
      const [memoryStats, setMemoryStats] = React.useState(null);
      // 窗口现场（「感知」分区显示"当前窗口"）；null = 还没读到
      const [windowStatus, setWindowStatus] = React.useState(null);
      const [screenStats, setScreenStats] = React.useState(null);
      const [compressing, setCompressing] = React.useState(false);
      // 桌宠现场（外壳在不在跑、运行时是否可用）；null = 还没读到
      const [petRuntime, setPetRuntime] = React.useState(null);
      // 试听：输入框内容、合成中、结果提示。**都不进设置**，纯试音。
      const [previewText, setPreviewText] = React.useState('今天天气不错，我们去看电影吧。');
      const [previewBusy, setPreviewBusy] = React.useState(false);
      const [previewHint, setPreviewHint] = React.useState('本地模型第一次合成要等模型加载，之后快很多。');
      // 绿幕是**当场调一下**的状态：不写设置，关弹窗/切标签就收回（用户要求）
      const [editOn, setEditOn] = React.useState(false);
      // TTS 音色清单（kokoro 103 个）；null = 还没读到
      const [petVoices, setPetVoices] = React.useState(null);
      const scaleTimerRef = React.useRef(null);
      const soulBaseRef = React.useRef(soulBaseline(emptySoulForm()));
      const [saving, setSaving] = React.useState(false);
      const [status, setStatus] = React.useState('');
      const [statusError, setStatusError] = React.useState(false);
      const [loading, setLoading] = React.useState(false);
      // 是否成功读到过一次真实设置。没读到之前 `draft` 还是内置默认值，
      // 直接渲染会让「陪看」显示「先去模型填 Vision 模型」这种假状态（用户实测反馈）。
      const [everLoaded, setEverLoaded] = React.useState(false);
      const [tab, setTab] = React.useState(TABS[0].key);
      const panelRef = React.useRef(null);

      // 打开时读设置 + 人格（两个都到齐才算读完）
      React.useEffect(() => {
        if (!open) return undefined;
        let cancelled = false;
        setStatus('');
        setStatusError(false);
        setLoading(true);
        setTouched(emptyTouched());
        setTab(TABS[0].key);
        // **音色清单单独拉、不参与 Promise.all**：`/pet/voices` 第一次要联网取 edge 音色
        // （之后有 1 小时缓存）。之前它在 Promise.all 里，导致整个弹窗要等它 ——
        // 启动后第一次打开会卡几秒，期间界面用的还是内置默认值（Vision 模型是空的），
        // 所以「陪看」会先显示"先去模型填 Vision 模型"、几秒后才变正常。
        fetchPetVoices().then((voiceResult) => {
          if (cancelled !== true) setPetVoices(voiceResult);
        });
        Promise.all([fetchSettings(), fetchSoul(), fetchMemoryStats(), fetchWindowStatus(), fetchScreenStats(), fetchPetStatus()]).then(([settingsResult, soulResult, statsResult, windowResult, screenResult, petResult]) => {
          if (cancelled) return;
          setDraft(settingsResult.settings);
          setSoulFields(soulResult.fields);
          setSoulDir(soulResult.dir);
          setMemoryStats(statsResult);
          setWindowStatus(windowResult);
          setScreenStats(screenResult);
          setPetRuntime(petResult);
          soulBaseRef.current = soulBaseline(soulResult.fields);
          setLoading(false);
          setEverLoaded(true);
          if (settingsResult.error !== undefined) {
            setStatusError(true);
            setStatus(`读取宿主设置失败（${settingsResult.error}），当前显示内置默认值`);
          } else if (soulResult.error !== undefined) {
            setStatusError(true);
            setStatus(`读取人格文件失败（${soulResult.error}），当前是空白表单`);
          } else if (settingsResult.source === 'default') {
            setStatus('尚未保存过，当前是默认值');
          } else if (settingsResult.source === 'corrupted') {
            setStatusError(true);
            setStatus('宿主上的设置文件损坏，已回退默认值（原文件未被覆盖）');
          }
        });
        return () => {
          cancelled = true;
        };
      }, [open]);

      // 智能应用控制开着时，"预编译产物拉到没拉到"要等宿主那边联网拉完才知道（后台拉，不弹窗）。
      // 打开设置后隔 1.5 秒再问一次，最多问 4 次；拉到了/失败了就停。
      // SAC 没开时 `sacPending` 一直是 false —— 一次多余请求都不会发。
      const sacPending = screenStats !== null && typeof screenStats === 'object'
        && screenStats.native !== null && typeof screenStats.native === 'object'
        && screenStats.native.sac !== null && typeof screenStats.native.sac === 'object'
        && screenStats.native.sac.state === 'on'
        && screenStats.native.sac.fetched === null;
      React.useEffect(() => {
        if (!open || sacPending !== true) return undefined;
        let tries = 0;
        let cancelled = false;
        let timer = null;
        const tick = () => {
          if (cancelled === true || tries >= 4) return;
          tries += 1;
          fetchScreenStats().then((fresh) => {
            if (cancelled === true || fresh === null || fresh === undefined) return;
            setScreenStats((current) => (current === null ? fresh : { ...current, native: fresh.native }));
            const next = fresh.native !== null && typeof fresh.native === 'object' && fresh.native.sac !== null && typeof fresh.native.sac === 'object'
              ? fresh.native.sac
              : null;
            if (next !== null && next.fetched !== null) return;
            timer = setTimeout(tick, 1500);
          });
        };
        timer = setTimeout(tick, 1500);
        return () => {
          cancelled = true;
          if (timer !== null) clearTimeout(timer);
        };
      }, [open, sacPending]);

      // 弹窗期间锁 body 滚动；卸载/关闭时恢复
      React.useEffect(() => {
        if (!open) return undefined;
        const previous = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        return () => {
          document.body.style.overflow = previous;
        };
      }, [open]);

      // onClose 每次父组件重渲染都是新函数：直接写进下面那个 effect 的依赖，
      // 会让「打开时把焦点移进面板」**反复重跑**，于是你正在输入的框会被抢走焦点
      // （写着写着断了、光标消失）。用 ref 把它固定住，effect 就只在"打开"这一刻跑。
      /** 关弹窗：先把绿幕/缩放预览收掉，再真的关（用户要求：关设置时绿幕要关）。 */
      const closeAndClean = () => {
        clearPreview();
        onClose();
      };
      const onCloseRef = React.useRef(onClose);
      onCloseRef.current = onClose;

      // Esc 关闭 + 打开时焦点进入面板
      React.useEffect(() => {
        if (!open) return undefined;
        const onKeyDown = (event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            clearPreview();
            onCloseRef.current();
          }
        };
        document.addEventListener('keydown', onKeyDown, true);
        const focusTimer = window.setTimeout(() => {
          const panel = panelRef.current;
          // 只有焦点还不在面板里时才抢：用户在哪个框里打字就留在哪个框
          if (panel !== null && panel.contains(document.activeElement) === false) panel.focus();
        }, 0);
        return () => {
          document.removeEventListener('keydown', onKeyDown, true);
          window.clearTimeout(focusTimer);
        };
      }, [open]);

      if (!open) return null;

      /**
       * 保存：设置 + 人格**一次写完**。
       * 人格只在「和读进来时不一样」时才写，避免无意义地重写 SOUL.md。
       */
      const onSave = () => {
        setSaving(true);
        setStatus('');
        setStatusError(false);
        const soulDirty = soulBaseline(soulFields) !== soulBaseRef.current;
        saveSettings(buildPayload(draft, touched))
          .then((saved) => {
            // 宿主会把数值夹进合法区间、把密钥脱敏：用它回传的设置刷新草稿，
            // 免得框里显示的值和真正存下的值不一样。
            if (saved !== null) setDraft(normalizeSettings(saved));
            // 存下来了就不再需要预览覆盖（缩放已进设置，绿幕本来就不存）
            clearPreview();
            setTouched(emptyTouched());
            return soulDirty ? saveSoul(soulFields) : null;
          })
          .then((soulResult) => {
            setSaving(false);
            if (soulResult !== null && soulResult.written === true) {
              // 写完把基线推到新值：再点一次「保存」不会重复写文件
              soulBaseRef.current = soulBaseline(soulFields);
            }
            const reason =
              soulResult !== null && soulResult.written !== true && typeof soulResult.reason === 'string'
                ? soulResult.reason
                : '';
            if (reason !== '') {
              setStatusError(true);
              setStatus(`设置已保存；人格未写入：${reason}`);
            } else {
              setStatusError(false);
              setStatus('已保存');
            }
          })
          .catch((error) => {
            setSaving(false);
            setStatusError(true);
            setStatus(`保存失败：${String(error)}（宿主接口需要重启 DSH 后才可用）`);
          });
      };

      /** 改人格里的一个框。 */
      const onSoulChange = (key, value) => {
        setSoulFields((fields) => ({ ...fields, [key]: value }));
      };

      /**
       * 感知分区的滑块：**拨到哪就立刻生效**（那个分区没有保存键）。
       *
       * 只发这一项、不发整份草稿：别的分区可能正编辑到一半，不能顺手把它们也存了。
       * 陪看一关，**OCR 一并关**（用户定的规矩：陪看开着 OCR 才能开）。
       */
      const applySense = (key, value) => {
        const perceive = draft.perceive !== null && typeof draft.perceive === 'object' ? draft.perceive : {};
        const screen = draft.screen !== null && typeof draft.screen === 'object' ? draft.screen : {};
        const perceiveNext = { ...perceive, [key]: value };
        const closeOcr = key === 'companion' && value !== true;
        setDraft({ ...draft, perceive: perceiveNext, screen: closeOcr ? { ...screen, subtitle: false, speech: false } : screen });
        setStatus('');
        setStatusError(false);
        const label = key === 'companion'
          ? (value === true ? '屏幕陪看已开' : '屏幕陪看已关（OCR / ASR 一并关）')
          : (value === true ? '已开启' : '已关闭');
        saveSettings(closeOcr ? { perceive: perceiveNext, screen: { subtitle: false, speech: false } } : { perceive: perceiveNext })
          .then(() => {
            setStatusError(false);
            setStatus(`${label} · 已保存`);
          })
          .catch((error) => {
            setStatusError(true);
            setStatus(`${label}失败：${String(error)}`);
          });
      };

      /** 陪看的 OCR 子开关（就是 `screen.subtitle`）：跟滑块一样立刻生效。 */
      const applySubtitle = (value) => {
        const screen = draft.screen !== null && typeof draft.screen === 'object' ? draft.screen : {};
        setDraft({ ...draft, screen: { ...screen, subtitle: value } });
        setStatus('');
        setStatusError(false);
        const label = value === true ? 'OCR 已开' : 'OCR 已关';
        saveSettings({ screen: { subtitle: value } })
          .then(() => {
            setStatusError(false);
            setStatus(`${label} · 已保存`);
          })
          .catch((error) => {
            setStatusError(true);
            setStatus(`切换 OCR 失败：${String(error)}`);
          });
      };

      /** 陪看的音轨识别子开关（就是 `screen.speech`）：跟 OCR 一样，一拨就存。 */
      const applySpeech = (value) => {
        const screen = draft.screen !== null && typeof draft.screen === 'object' ? draft.screen : {};
        setDraft({ ...draft, screen: { ...screen, speech: value } });
        setStatus('');
        setStatusError(false);
        const label = value === true ? 'ASR 已开' : 'ASR 已关';
        saveSettings({ screen: { speech: value } })
          .then(() => {
            setStatusError(false);
            setStatus(`${label} · 已保存`);
          })
          .catch((error) => {
            setStatusError(true);
            setStatus(`切换 ASR 失败：${String(error)}`);
          });
      };

      /**
       * 立刻写回一个**桌宠**字段（「感知」的开关和「桌宠」标签的旋钮都走它）。
       *
       * 规矩同「感知」：拨到哪就存哪，没有保存键；只发改动的那个字段。
       * 关掉主开关时顺手把 TTS 一并关（从属开关不该比主子还活着）。
       */
      const applyPet = (key, value) => {
        const pet = draft.pet !== null && typeof draft.pet === 'object' ? draft.pet : {};
        const next = { ...pet, [key]: value };
        if (key === 'enabled' && value !== true) next.tts = false;
        setDraft({ ...draft, pet: next });
        setStatus('');
        setStatusError(false);
        const label = key === 'enabled'
          ? (value === true ? '桌宠已开' : '桌宠已关')
          : key === 'tts'
            ? (value === true ? 'TTS 已开' : 'TTS 已关')
            : '桌宠设置已保存';
        const patch = key === 'enabled' && value !== true ? { pet: { enabled: false, tts: false } } : { pet: { [key]: value } };
        saveSettings(patch)
          .then(() => {
            setStatusError(false);
            setStatus(`${label} · 已保存`);
            // 起停有 1–2 秒延迟（宿主每 3 秒对齐一次），稍后再刷一次现场
            setTimeout(() => { fetchPetStatus().then((fresh) => { if (fresh !== null) setPetRuntime(fresh); }); }, 2500);
          })
          .catch((error) => {
            setStatusError(true);
            setStatus(`保存桌宠设置失败：${String(error)}`);
          });
      };

      /**
       * 打开「智能应用控制」设置页（SAC 那行红字里的【SAC设置】调它）。
       *
       * 浏览器打不开 `windowsdefender:` 这类协议，得由宿主起 `cmd start`。
       *
       * @returns {void} 无。
       */
      const openSacGuide = () => {
        fetch(`${API}/screen/sac-guide`, { method: 'POST', headers: { accept: 'application/json' } })
          .then((response) => response.json())
          .then((data) => {
            if (data !== null && typeof data === 'object' && data.ok === true) return;
            setStatusError(true);
            setStatus(`打开智能应用控制设置页失败：${String((data !== null && typeof data === 'object' && data.error) || '未知错误')}`);
          })
          .catch((error) => {
            setStatusError(true);
            setStatus(`打开智能应用控制设置页失败：${String(error)}`);
          });
      };

      /**
       * 下载 Live2D Cubism Core（缺文件时那行红字旁边的【下载】调它）。
       *
       * 从 Live2D **官方托管地址**取（约 200 KB），宿主校验内容后直接落到
       * `pet/assets/vendor/live2dcubismcore.min.js` —— 用户不用自己搬文件。
       * 用模块级的 `coreDownloading` 防连点：这个不需要重绘，所以不占 useState。
       *
       * @returns {void} 无。
       */
      const downloadCore = () => {
        if (coreDownloading === true) return;
        coreDownloading = true;
        setStatusError(false);
        setStatus('正在从 Live2D 官方下载 Core（约 200 KB）…');
        fetch(`${API}/pet/core`, { method: 'POST', headers: { accept: 'application/json' } })
          .then((response) => response.json())
          .then((data) => {
            coreDownloading = false;
            if (data !== null && typeof data === 'object' && data.ok === true) {
              const kb = Math.max(1, Math.round(Number(data.bytes) / 1024));
              setStatusError(false);
              setStatus(`Live2D Core 已就位（${kb} KB），现在可以开桌宠了。`);
              // 现场刷一次：那行红字要自己消失，开关才拨得动
              fetchPetStatus().then((fresh) => { if (fresh !== null) setPetRuntime(fresh); });
              return;
            }
            setStatusError(true);
            setStatus(`下载失败：${String((data !== null && typeof data === 'object' && data.error) || '未知错误')}。也可以手动把 live2dcubismcore.min.js 放进 pet/assets/vendor/。`);
          })
          .catch((error) => {
            coreDownloading = false;
            setStatusError(true);
            setStatus(`下载失败：${String(error)}`);
          });
      };

      /**
       * 给桌宠窗口发**即时预览**（绿幕 / 缩放），不写设置。
       *
       * @param {object} patch - `{editMode?, modelScale?}`。
       * @returns {void} 无。
       */
      const postPreview = (patch) => {
        fetch(`${API}/pet/preview`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(patch),
        }).catch(() => { /* 桌宠没开就算了 */ });
      };

      /** 拨绿幕：立刻生效（不写设置）。 */
      const toggleEdit = (next) => {
        setEditOn(next === true);
        postPreview({ editMode: next === true });
      };

      /**
       * 拖缩放滑块：草稿立刻变（保存时才入库），同时**节流**推给桌宠做即时预览。
       * 节流 80 ms —— 之前是"改完等 1 秒多"，因为每次 onChange 都走一次完整的保存往返。
       */
      const changeScale = (value) => {
        const pet = draft.pet !== null && typeof draft.pet === 'object' ? draft.pet : {};
        setDraft({ ...draft, pet: { ...pet, modelScale: value } });
        if (scaleTimerRef.current !== null) clearTimeout(scaleTimerRef.current);
        scaleTimerRef.current = setTimeout(() => {
          scaleTimerRef.current = null;
          postPreview({ modelScale: value });
        }, 80);
      };

      /** 改气泡位置：草稿立刻变（保存时入库），同时推预览让绿幕里的框立刻动。 */
      const changeBubble = (value) => {
        const pet = draft.pet !== null && typeof draft.pet === 'object' ? draft.pet : {};
        setDraft({ ...draft, pet: { ...pet, bubblePosition: value } });
        postPreview({ bubblePosition: value });
      };

      /**
       * 装本地 TTS 模型（缺模型时「下载模型」按钮）。
       *
       * 立刻返回，下载在宿主后台跑；这里只起个头 + 拉一次状态，进度靠轮询 `/pet/voices`。
       */
      const installModel = (model) => {
        setPreviewHint('开始下载模型…');
        fetch(`${API}/pet/tts/install`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model }),
        })
          .then((response) => response.json())
          .then((data) => {
            setPreviewHint(data.ok === true ? '下载中，装好后按钮会变回「试听」' : `下载失败：${String(data.error)}`);
            // 2 秒后刷一次音色/安装状态
            setTimeout(() => { fetchPetVoices().then((fresh) => { if (fresh !== null) setPetVoices(fresh); }); }, 2000);
          })
          .catch((error) => setPreviewHint(`下载失败：${String(error)}`));
      };

      /** 收掉绿幕与缩放预览（关弹窗 / 切标签 / 保存后都调）。 */
      const clearPreview = () => {
        if (scaleTimerRef.current !== null) {
          clearTimeout(scaleTimerRef.current);
          scaleTimerRef.current = null;
        }
        setEditOn(false);
        postPreview({ editMode: false, modelScale: null });
      };

      /** 试听：把输入框里那句话合成出来当场播（**不写进设置**）。 */
      const playPreview = async () => {
        const text = String(previewText ?? '').trim();
        if (text === '') {
          setPreviewHint('先打一句话。');
          return;
        }
        setPreviewBusy(true);
        setPreviewHint('合成中…');
        const started = Date.now();
        try {
          const pet = draft.pet !== null && typeof draft.pet === 'object' ? draft.pet : {};
          const response = await fetch(`${API}/pet/tts`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            // preview: true → 宿主用**草稿值**合成（模型/音色/音调/语速/音量），不读设置。
            // 所以不点保存也能挨个试听，点保存才正式生效。
            body: JSON.stringify({
              text,
              preview: true,
              model: pet.ttsModel,
              voice: pet.ttsVoice,
              pitch: Number.isFinite(Number(pet.ttsPitch)) ? Number(pet.ttsPitch) : 0,
              speed: Number(pet.ttsSpeed) > 0 ? Number(pet.ttsSpeed) : 1,
              volume: Number.isFinite(Number(pet.ttsVolume)) ? Number(pet.ttsVolume) : 1,
            }),
          });
          if (response.status === 503) {
            setPreviewHint('TTS 引擎还没接上。');
            return;
          }
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const blob = await response.blob();
          const url = URL.createObjectURL(blob);
          const audio = new Audio(url);
          // 音量在**宿主端**做（元素音量封顶 1.0，挡不住"还想再大"），这里保持 1
          await audio.play();
          setPreviewHint(`合成 ${Date.now() - started} ms · ${Math.round(audio.duration * 10) / 10} 秒音频`);
        } catch (error) {
          setPreviewHint(`试听失败：${String(error)}`);
        } finally {
          setPreviewBusy(false);
        }
      };

      // 用户第一次碰某个角色的密钥框时打标记（幂等，避免无谓重渲染）。
      const onTouchRole = (roleKey) => {
        setTouched((t) => (t[roleKey] === true ? t : { ...t, [roleKey]: true }));
      };

      const activeTab = TABS.find((item) => item.key === tab);
      /** 切分区：离开「桌宠」就把绿幕收掉（用户要求：切到别的标签绿幕要关）。 */
      const switchTab = (key) => {
        if (key !== 'pet' && editOn === true) clearPreview();
        setTab(key);
      };

      const dialog = h(
        'div',
        { className: 'dshcw-overlay', role: 'presentation' },
        // 点遮罩关闭。**事件必须挂在遮罩本身**：命中的元素就是它，
        // 挂在 overlay 上再判断 target===currentTarget 永远不成立（target 是遮罩）。
        // 这与 DSH 原生设置弹窗的做法一致。
        h('div', { className: 'dshcw-mask', 'aria-hidden': 'true', onClick: closeAndClean }),
        h(
          'div',
          {
            className: 'dshcw-panel',
            role: 'dialog',
            'aria-modal': 'true',
            'aria-labelledby': 'dshcw-settings-title',
            tabIndex: -1,
            ref: panelRef,
          },
          h(
            'nav',
            { className: 'dshcw-nav' },
            h('div', { className: 'dshcw-navTitle', id: 'dshcw-settings-title' }, '聊天设置'),
            h(
              'div',
              { className: 'dshcw-navList' },
              ...TABS.map((item) =>
                h(
                  'button',
                  {
                    key: item.key,
                    type: 'button',
                    className: item.key === tab ? 'dshcw-navCell dshcw-navActive' : 'dshcw-navCell',
                    'aria-current': item.key === tab ? 'true' : undefined,
                    onClick: () => switchTab(item.key),
                  },
                  h('span', { className: 'dshcw-navLabel' }, item.label),
                ),
              ),
            ),
          ),
          h(
            'div',
            { className: 'dshcw-content' },
            h(
              'div',
              { className: 'dshcw-contentHeader' },
              h(
                'span',
                { className: 'dshcw-status' },
                loading ? '读取中…' : '',
              ),
              h(
                'button',
                { type: 'button', className: 'dshcw-close', onClick: closeAndClean, 'aria-label': '关闭', title: '关闭' },
                '\u2715',
              ),
            ),
            h(
              'div',
              { className: 'dshcw-options' },
              // 还没读到过真实设置时，别拿内置默认值冒充：默认值里 Vision 模型是空的，
              // 渲染出来就是"先去模型填 Vision 模型"这种假状态，几秒后才自己变正常（用户实测反馈）。
              everLoaded !== true && loading === true
                ? h('div', { className: 'dshcw-empty' }, '读取中…')
                : tab === 'models'
                ? h(ModelsSection, { draft, setDraft, onTouchRole })
                : tab === 'soul'
                  ? h(SoulSection, { fields: soulFields, onChange: onSoulChange, dir: soulDir })
                  : tab === 'pet'
                    ? h(PetSection, { draft, setDraft, onPet: applyPet, petStatus: petRuntime, previewText, previewBusy, previewHint, setPreviewText, playPreview, editOn, onToggleEdit: toggleEdit, onScale: changeScale, onBubble: changeBubble, petVoices, onInstall: installModel })
                    : tab === 'sense'
                      ? h(SenseSection, { draft, setDraft, onSwitch: applySense, onSubtitle: applySubtitle, onSpeech: applySpeech, onPet: applyPet, onDownloadCore: downloadCore, onSacGuide: openSacGuide, petStatus: petRuntime, status: windowStatus, screenStats, compressing,
                      onCompress: () => {
                        setCompressing(true);
                        fetch(`${API}/screen/compress`, { method: 'POST' })
                          .then((response) => response.json())
                          .then((data) => {
                            setStatus(data.ok === true ? `压缩完成：${data.groups} 组、新增 ${data.summaries} 条摘要、剩 ${data.remaining} 条未压缩` : `压缩失败：${String(data.error)}`);
                            setStatusError(data.ok !== true);
                            return fetchScreenStats();
                          })
                          .then((fresh) => { if (fresh !== undefined) setScreenStats(fresh); })
                          .catch((error) => { setStatusError(true); setStatus(`压缩失败：${String(error)}`); })
                          .finally(() => setCompressing(false));
                      },
                      onReveal: () => { fetch(`${API}/store/reveal`, { method: 'POST' }).catch(() => {}); },
                    })
                    : h(GeneralSection, {
                      draft,
                      setDraft,
                      stats: memoryStats,
                      screenStats,
                      compressing,
                      // 清空历史成功后，通知聊天窗口也清干净
                      onPurged,
                      onCompress: () => {
                        setCompressing(true);
                        fetch(`${API}/screen/compress`, { method: 'POST' })
                          .then((response) => response.json())
                          .then((data) => {
                            setStatus(data.ok === true ? `压缩完成：${data.groups} 组、新增 ${data.summaries} 条摘要、剩 ${data.remaining} 条未压缩` : `压缩失败：${String(data.error)}`);
                            setStatusError(data.ok !== true);
                            return fetchScreenStats();
                          })
                          .then((fresh) => { if (fresh !== undefined) setScreenStats(fresh); })
                          .catch((error) => { setStatusError(true); setStatus(`压缩失败：${String(error)}`); })
                          .finally(() => setCompressing(false));
                      },
                      onReveal: () => { fetch(`${API}/store/reveal`, { method: 'POST' }).catch(() => {}); },
                      // 装完 OCR 语言包：重取一次状态（本机已装列表要跟着变）
                      onRefreshScreen: () => {
                        fetchScreenStats().then((fresh) => { if (fresh !== undefined) setScreenStats(fresh); });
                      },
                    }),
            ),
            // 页脚：一次保存「设置 + 人格」。保存键从模型分区提到外壳这里，
            // 否则人格/设置分区里根本没有保存键可用（外壳结构与类名不变）。
            // **感知分区没有保存键**：那边滑块拨到哪就立刻写回（用户要求）。
            h(
              'div',
              { className: 'dshcw-footer', style: { flex: 'none', padding: '4px 24px 20px' } },
              tab === 'sense'
                ? h('span', { className: 'dshcw-status' }, '滑块拨到哪就立刻生效，这个分区不用按保存。')
                : h(
                  'button',
                  { type: 'button', className: 'dshcw-btnPrimary', onClick: onSave, disabled: saving },
                  saving ? '保存中…' : '保存',
                ),
              status !== '' &&
                h('span', { className: statusError ? 'dshcw-status dshcw-statusError' : 'dshcw-status' }, status),
            ),
          ),
        ),
      );

      // 用 portal 渲染到 body：与 DSH 原生设置弹窗一致，
      // 避免被侧边栏的 overflow/transform 裁切或困在局部层叠上下文里。
      // 拿不到 createPortal 时退回就地渲染——功能不受影响，只是少一层保障。
      if (ReactDOM !== undefined && typeof ReactDOM.createPortal === 'function') {
        return ReactDOM.createPortal(dialog, document.body);
      }
      return dialog;
    }

    // ── 聊天栏本体 ───────────────────────────────────────────────────────

    /**
     * 标题栏内容。
     *
     * 结构要点：**折叠开关与齿轮键是两个并列的兄弟节点**，
     * 齿轮不在折叠开关内部——否则点齿轮会连带触发折叠。
     * 折叠态**不渲染设置键**。
     *
     * @param {{ collapsed: boolean, onOpenSettings: () => void, onToggle: () => void }} props
     */
    function Header({ collapsed, onOpenSettings, onToggle, autonomous }) {
      return h(
        React.Fragment,
        null,
        h(
          'span',
          {
            className: 'dshcw-toggleArea',
            role: 'button',
            tabIndex: 0,
            'aria-expanded': !collapsed,
            title: collapsed ? '展开聊天' : '收起聊天',
            onClick: onToggle,
            onKeyDown: (event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onToggle();
              }
            },
          },
          h('span', { className: 'dshcw-chevron' }, collapsed ? '\u25B8' : '\u25BE'),
          h('span', { className: 'dshcw-title' }, '聊天'),
          // 它自己开口时在标题后面亮几秒（绿点 + 文字），到时间自己灭
          autonomous === true
            ? h(
              'span',
              { className: 'dshcw-selfTalk' },
              h('span', { className: 'dshcw-selfDot' }),
              '它自己开口了',
            )
            : null,
          // 标题不再 flex:1，用它把右边的齿轮顶过去
          h('span', { className: 'dshcw-spacer' }),
        ),
        !collapsed &&
          h(
            'button',
            {
              type: 'button',
              className: 'dshcw-iconbtn',
              title: '聊天设置',
              'aria-label': '聊天设置',
              onClick: onOpenSettings,
            },
            '\u2699',
          ),
      );
    }

    /**
     * 一条消息。
     * @param {{message: object, onDelete: (id: number) => void, pending?: boolean}} props - 消息、删除回调、是否正在生成。
     */
    function MessageRow({ message, onDelete, pending }) {
      const isUser = message.role === 'user';
      const note = typeof message.error === 'string' && message.error !== '' ? message.error : null;
      // 已参与过一条记忆（宿主 GET /messages 回传的 indexedAt）
      const kept = typeof message.indexedAt === 'number' && message.indexedAt > 0;
      return h(
        'div',
        { className: isUser ? 'dshcw-msg dshcw-msgUser' : 'dshcw-msg dshcw-msgAssistant' },
        h(
          'div',
          { className: 'dshcw-msgCol' },
          h(
            'div',
            { className: 'dshcw-bubble' },
            message.content === '' && pending === true
              ? h('span', { className: 'dshcw-typing' }, '思考中…')
              : message.content,
          ),
          note !== null ? h('div', { className: 'dshcw-msgNote' }, note) : null,
        ),
        // 右侧那一格**宽度固定**（36px）：不管里面是删除键还是「已记住」，气泡宽度都不变。
        // 否则到点入库那一刻右侧从 × 换成三个汉字，气泡会突然变窄、文字重排——
        // 正在敲代码的人会看到聊天栏抖一下（用户反馈的正是这个）。
        typeof message.id === 'number'
          ? h(
              'div',
              { className: 'dshcw-msgSlot' },
              kept === false
                ? h(
                    'button',
                    {
                      type: 'button',
                      className: 'dshcw-msgDelete',
                      title: '删除这条消息（删掉就不会进记忆库）',
                      'aria-label': '删除这条消息',
                      onClick: () => onDelete(message.id),
                    },
                    '\u2715',
                  )
                : h('span', { className: 'dshcw-msgKept', title: '已经进记忆库了' }, '已记住'),
            )
          : null,
      );
    }

    /**
     * 输入区。Enter 发送、Shift+Enter 换行；生成中按钮变成「停止」。
     * @param {{value: string, onChange: (v: string) => void, onSend: () => void, onStop: () => void, streaming: boolean}} props - 输入状态与回调。
     */
    function Composer({ value, onChange, onSend, onStop, streaming }) {
      return h(
        'div',
        { className: 'dshcw-composer' },
        h('textarea', {
          className: 'dshcw-textarea',
          rows: 1,
          placeholder: '说点什么…',
          'aria-label': '聊天输入框',
          value,
          onChange: (event) => onChange(event.target.value),
          onKeyDown: (event) => {
            if (event.key === 'Enter' && event.shiftKey !== true) {
              event.preventDefault();
              onSend();
            }
          },
        }),
        h(
          'button',
          {
            type: 'button',
            className: 'dshcw-send',
            title: streaming ? '停止生成' : '发送',
            'aria-label': streaming ? '停止生成' : '发送',
            onClick: streaming ? onStop : onSend,
            disabled: streaming !== true && value.trim() === '',
          },
          streaming ? '\u25A0' : '\u25B7',
        ),
      );
    }

    /**
     * 聊天栏根组件。
     * @param {{ wide?: boolean }} props - wide 来自 sidebar.footer.action 的 owner props。
     */
    function ChatDock({ wide }) {
      // 默认折叠：每次启动 DSH 都从收缩态开始。
      const [collapsed, setCollapsed] = React.useState(true);
      const [settingsOpen, setSettingsOpen] = React.useState(false);
      const [messages, setMessages] = React.useState([]);
      const [input, setInput] = React.useState('');
      const [streaming, setStreaming] = React.useState(false);
      const [streamText, setStreamText] = React.useState('');
      const [notice, setNotice] = React.useState('');
      const [noticeError, setNoticeError] = React.useState(false);
      const [loaded, setLoaded] = React.useState(false);
      const [hasMore, setHasMore] = React.useState(true);
      // 它自己开口时顶栏亮一下：记时间戳，6 秒后自动灭（比一直亮着更不打扰）
      const [selfTalkAt, setSelfTalkAt] = React.useState(0);
      const messagesRef = React.useRef([]);
      messagesRef.current = messages;
      const loadingOlderRef = React.useRef(false);
      const storeIdRef = React.useRef('');
      const abortRef = React.useRef(null);
      const listRef = React.useRef(null);
      const atBottomRef = React.useRef(true);

      /**
       * 取服务端最新一页，与界面上已有的消息**合并**（而不是覆盖）。
       *
       * 为什么必须合并：往上翻过历史之后，如果每次发完消息都重置成"最近 30 条"，
       * 用户已经翻出来的旧消息会凭空消失。合并只做两件事：补上新出现的，
       * 丢掉还没落库的临时行（字符串 id）。
       *
       * `replace === true` 时不合并、直接以服务端为准 —— 只在**清空历史**之后用。
       * 合并是"只增不减"的，库里删干净了界面也照样留着，这就是清空后窗口内容还在的原因。
       *
       * @param {boolean} [replace] - 是否整页覆盖（清空后重载用）。
       */
      const mergeLatest = React.useCallback((replace) => {
        fetch(`${API}/messages?limit=30`)
          .then((response) => response.json())
          .then((data) => {
            if (typeof data.error === 'string' && data.error !== '') {
              setNotice(data.reason === '' ? '数据目录不可用' : String(data.reason));
              setNoticeError(true);
              setMessages([]);
              setLoaded(true);
              return;
            }
            const incoming = Array.isArray(data.messages) ? data.messages : [];
            const storeId = typeof data.storeId === 'string' ? data.storeId : '';
            // 存储被重建（用户把数据文件夹删了）→ 界面上的旧消息作废
            if (storeId !== '' && storeIdRef.current !== '' && storeId !== storeIdRef.current) {
              storeIdRef.current = storeId;
              setMessages(incoming);
              setNotice('存储已重置，对话从零开始。');
              setNoticeError(false);
              setLoaded(true);
              return;
            }
            if (storeId !== '') storeIdRef.current = storeId;
            // 清空历史之后重载：服务端是空的就以它为准，别再跟界面上的旧消息合并
            if (replace === true) {
              setMessages(incoming);
              setHasMore(incoming.length >= 30);
              setNotice(data.fallback === true ? `数据目录不可用，已临时改用 ${data.dir}（${data.reason}）` : '');
              setNoticeError(false);
              setLoaded(true);
              return;
            }
            setMessages((list) => {
              // 就是"取并集"：界面上已有的全留着（含往上翻出来的旧页），
              // 再把服务端多出来的补上。之前这里写成了互补过滤，
              // 结果**两边都有的消息会被同时排除掉**——表现就是"发一句，旧的少一批"。
              // 已知消息换成服务端的新副本（`indexedAt` 变了，「已记住」才刷得出来），
              // 服务端这一页里没有的（更早的页）原样留着。
              const known = new Set(list.filter((item) => typeof item.id === 'number').map((item) => item.id));
              const fresh = new Map(incoming.map((item) => [item.id, item]));
              const merged = [
                ...list.filter((item) => typeof item.id === 'number').map((item) => fresh.get(item.id) ?? item),
                ...incoming.filter((item) => known.has(item.id) === false),
              ];
              merged.sort((a, b) => a.id - b.id);
              return merged;
            });
            setNotice(data.fallback === true ? `数据目录不可用，已临时改用 ${data.dir}（${data.reason}）` : '');
            setNoticeError(false);
            setLoaded(true);
          })
          .catch((error) => {
            setLoaded(true);
            setNoticeError(true);
            setNotice(`读取失败：${String(error)}`);
          });
      }, []);

      /** 往上翻时补一页更早的（历史再多也不会一次性读进来）。 */
      const loadOlder = React.useCallback(() => {
        if (loadingOlderRef.current === true || hasMore !== true) return;
        const el = listRef.current;
        const first = messagesRef.current.find((item) => typeof item.id === 'number');
        if (el === null || first === undefined) return;
        loadingOlderRef.current = true;
        const beforeHeight = el.scrollHeight;
        fetch(`${API}/messages?before=${first.id}&limit=30`)
          .then((response) => response.json())
          .then((data) => {
            const older = Array.isArray(data.messages) ? data.messages : [];
            if (older.length === 0) {
              setHasMore(false);
              return;
            }
            setMessages((list) => {
              const known = new Set(list.map((item) => item.id));
              const merged = [...older.filter((item) => known.has(item.id) === false), ...list];
              merged.sort((a, b) => a.id - b.id);
              return merged;
            });
            // 内容追加在上方会把视口顶下去，把滚动位置补回来，视觉上不跳
            window.requestAnimationFrame(() => {
              const node = listRef.current;
              if (node !== null) node.scrollTop += node.scrollHeight - beforeHeight;
            });
          })
          .catch(() => {
            /* 拉更早的失败不打扰用户 */
          })
          .finally(() => {
            loadingOlderRef.current = false;
          });
      }, [hasMore]);

      // 展开后（首次）读一次历史
      React.useEffect(() => {
        if (collapsed || loaded) return;
        mergeLatest();
      }, [collapsed, loaded, mergeLatest]);

      // 「它自己开口了」徽标亮 6 秒后自己灭
      React.useEffect(() => {
        if (selfTalkAt === 0) return undefined;
        const timer = setTimeout(() => setSelfTalkAt(0), 6000);
        return () => clearTimeout(timer);
      }, [selfTalkAt]);

      // 展开着的时候轻量轮询一下历史（4 秒一次，很小）：这样在另一个标签页/窗口里
      // 发过的消息也会出现在这里。mergeLatest 取并集，不会打扰已经翻上去的旧页。
      React.useEffect(() => {
        if (collapsed) return undefined;
        const timer = setInterval(() => mergeLatest(), 4000);
        return () => clearInterval(timer);
      }, [collapsed, mergeLatest]);

      // 有新内容就贴着底部；用户自己往上翻了就不打扰他
      React.useEffect(() => {
        const el = listRef.current;
        if (el === null || atBottomRef.current !== true) return;
        el.scrollTop = el.scrollHeight;
      }, [messages, streamText]);

      /**
       * 清空历史数据之后：把聊天窗口也一并清干净。
       *
       * 只清数据库是不够的 —— 界面上的消息在 React state 里，而 `mergeLatest()` 是
       * **只增不减**的合并，所以库空了窗口照样留着（用户实测反馈）。
       * 这里改成"整页覆盖"重载，并复位分页状态。
       */
      const handlePurged = React.useCallback(() => {
        setStreaming(false);
        setStreamText('');
        setMessages([]);
        setHasMore(true);
        setLoaded(false);
        // 传 true → 以服务端为准，不和界面上的旧消息合并
        mergeLatest(true);
      }, [mergeLatest]);

      /** 停止生成：abort 掉 fetch，宿主那边会因为连接断开而中止上游。 */
      const stop = () => {
        const controller = abortRef.current;
        if (controller !== null) controller.abort();
        abortRef.current = null;
        setStreaming(false);
        setStreamText('');
      };

      /** 发送一条消息，并把 SSE 增量逐字贴上屏。 */
      const send = () => {
        const content = input.trim();
        if (content === '' || streaming) return;
        setInput('');
        setNotice('');
        setNoticeError(false);
        setMessages((list) => [...list, { id: `pending-${Date.now()}`, role: 'user', content, error: null }]);
        setStreaming(true);
        setStreamText('');
        atBottomRef.current = true;

        const controller = new AbortController();
        abortRef.current = controller;
        fetch(`${API}/chat`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ content }),
          signal: controller.signal,
        })
          .then(async (response) => {
            if (response.ok !== true || response.body === null) throw new Error(`HTTP ${response.status}`);
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            let text = '';
            for (;;) {
              const { value, done } = await reader.read();
              if (done === true) break;
              buffer += decoder.decode(value, { stream: true });
              let index = buffer.indexOf('\n\n');
              while (index !== -1) {
                const block = buffer.slice(0, index);
                buffer = buffer.slice(index + 2);
                const lines = block.split('\n');
                const eventLine = lines.find((line) => line.startsWith('event:'));
                const dataLine = lines.find((line) => line.startsWith('data:'));
                const event = eventLine === undefined ? '' : eventLine.slice(6).trim();
                let payload = null;
                try {
                  payload = dataLine === undefined ? null : JSON.parse(dataLine.slice(5).trim());
                } catch {
                  payload = null;
                }
                if (event === 'start') {
                  const storeId = payload !== null && typeof payload.storeId === 'string' ? payload.storeId : '';
                  // 存储被重建（比如用户把数据文件夹删了）→ 界面上的旧消息作废
                  if (storeId !== '' && storeIdRef.current !== '' && storeId !== storeIdRef.current) {
                    setMessages([]);
                    setNotice('存储已重置，对话从零开始。');
                    setNoticeError(false);
                  }
                  if (storeId !== '') storeIdRef.current = storeId;
                } else if (event === 'delta') {
                  text += payload !== null && typeof payload.text === 'string' ? payload.text : '';
                  setStreamText(text);
                } else if (event === 'error') {
                  setNoticeError(true);
                  setNotice(payload !== null && typeof payload.message === 'string' ? payload.message : '生成失败');
                } else if (event === 'done') {
                  // **不再由聊天框转发给桌宠**。
                  // 宿主落库时会走唯一出口广播 `say`，桌宠直接从那条广播出气泡 + TTS；
                  // 聊天框在这里再转一次 = 同一句念两遍（用户实测"TTS 走两遍"）。
                  // 聊天框自己只负责把这一轮显示完，然后 `finally` 里 mergeLatest() 从库里对齐。
                }
                index = buffer.indexOf('\n\n');
              }
            }
          })
          .catch((error) => {
            // 用户自己按的「停止」不算错误
            if (error !== null && typeof error === 'object' && error.name === 'AbortError') return;
            setNoticeError(true);
            setNotice(`发送失败：${String(error)}`);
          })
          .finally(() => {
            abortRef.current = null;
            setStreaming(false);
            setStreamText('');
            mergeLatest();
          });
      };

      /** 硬删一条消息（用户要求：按条硬删，不做软删）。 */
      const remove = (id) => {
        fetch(`${API}/messages/${id}`, { method: 'DELETE' })
          .then((response) => response.json())
          .then((data) => {
            if (data.ok !== true) {
              setNoticeError(true);
              setNotice(`删除失败：${data.error === undefined || data.error === null ? '未知原因' : String(data.error)}`);
              return;
            }
            setMessages((list) => list.filter((message) => message.id !== id));
          })
          .catch((error) => {
            setNoticeError(true);
            setNotice(`删除失败：${String(error)}`);
          });
      };

      // 它主动开口：宿主通过 GET /events 把这句话推过来，直接插进消息列表。
      // 不轮询——主动开口是稀疏事件（可能几十分钟一次）。EventSource 自己会重连。
      React.useEffect(() => {
        if (typeof EventSource !== 'function') return undefined;
        const source = new EventSource(`${API}/events`);
        source.addEventListener('say', (event) => {
          let payload;
          try {
            payload = JSON.parse(event.data);
          } catch {
            return;
          }
          if (payload === null || typeof payload.content !== 'string' || payload.content === '') return;
          setMessages((list) => (list.some((item) => item.id === payload.id)
            ? list
            : [...list, {
              id: payload.id,
              role: 'assistant',
              content: payload.content,
              createdAt: payload.createdAt,
              error: null,
              indexedAt: null,
            }]));
          // 不在下面的提示行里写「它自己开口了」了 —— 改为顶栏标题「聊天」后面的绿点徽标
          // （用户要求：放到顶栏，几秒后自己灭）。
          setSelfTalkAt(Date.now());
          // **不要**在这里再转发给 `/pet/utter`。
          // 宿主（perceive / companion）已经把这句话用 `say` 广播出去了，桌宠直接就能收到；
          // 这里再转发一次 = 同一个事件名变成了两个（`say` + `utter`），桌宠两个都监听 →
          // **同一句话被念两遍**（用户实测"TTS 走两遍、重音"）。
          // 聊天框自己把这条塞进列表就够了，桌宠的事让宿主广播负责。
          setNoticeError(false);
        });
        return () => source.close();
      }, []);

      // 稳定引用：设置弹窗的 onClose 每次都是新函数的话，会害它内部的
      // 焦点 effect 反复重跑（就是"写着写着焦点被抢走"的那个 bug）。
      const closeSettings = React.useCallback(() => setSettingsOpen(false), []);

      if (wide === false) return null;

      const toggle = () => setCollapsed((v) => !v);

      const header = h(
        'div',
        { className: 'dshcw-header' },
        h(Header, {
          collapsed,
          onOpenSettings: () => setSettingsOpen(true),
          onToggle: toggle,
          autonomous: selfTalkAt > 0,
        }),
      );

      const rows = messages.map((message) => h(MessageRow, { key: String(message.id), message, onDelete: remove }));
      if (streaming) {
        rows.push(
          h(MessageRow, {
            key: '__streaming__',
            message: { id: null, role: 'assistant', content: streamText, error: null },
            onDelete: () => {},
            pending: true,
          }),
        );
      }

      const body = collapsed
        ? null
        : h(
            'div',
            { className: 'dshcw-body' },
            notice === ''
              ? null
              : h('div', { className: noticeError ? 'dshcw-notice dshcw-noticeError' : 'dshcw-notice' }, notice),
            h(
              'div',
              {
                className: 'dshcw-messages',
                ref: listRef,
                onScroll: () => {
                  const el = listRef.current;
                  if (el === null) return;
                  atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
                  // 快翻到顶了就补一页更早的
                  if (el.scrollTop < 40) loadOlder();
                },
              },
              rows.length === 0
                ? h('div', { className: 'dshcw-empty' }, loaded ? '还没有消息。说点什么吧。' : '读取中…')
                : rows,
            ),
            h(Composer, { value: input, onChange: setInput, onSend: send, onStop: stop, streaming }),
          );

      return h(
        React.Fragment,
        null,
        h(StyleTag),
        h(
          'div',
          {
            className: 'dshcw-root',
            style: { flex: 'none', height: collapsed ? COLLAPSED_HEIGHT : DEFAULT_HEIGHT },
          },
          header,
          body,
        ),
        h(SettingsDialog, { open: settingsOpen, onClose: closeSettings, onPurged: handlePurged }),
      );
    }

    return {
      inject: ['slots'],

      /**
       * @param {import('@deepseek-ai/cordis').Context} ctx - 客户端根上下文。
       */
      apply(ctx) {
        ctx.slots.inject('sidebar.footer.action', () =>
          ctx.slots.register(
            {
              name: 'sidebar.footer.action',
              id: 'chat-widget',
              order: 0, // 渲染在 footerActions 内、settingsArea 之前
            },
            (props) => h(ErrorBoundary, null, h(ChatDock, props)),
          ),
        );
      },
    };
  },
});
