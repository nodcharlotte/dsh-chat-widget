# dsh-chat-widget

DSH（DeepSeek Harness）侧边栏底部的常驻聊天栏：能聊天、会看屏幕，高兴了还能变成桌面上的 Live2D 小人。

> 非官方第三方插件，按现状发布（as-is）。适配 **DSH 0.2.1+**。
> 插件接口还是预览版，升级 DSH 后可能失效；本仓库不保证跟进更新。

<p align="center">
  <img src="docs/screenshot-app.png" alt="DSH 侧边栏里的聊天栏" width="900">
</p>

## 功能

### 聊天

- 常驻侧边栏底部，随时开口，不用打断正在跑的会话
- 流式回复、Markdown 渲染
- 本地记忆库（SQLite）：定时扫描入库，聊天时按相关度取回旧事
- 没有向量服务也能用：Embedding 选「BM25 关键词模式」即完全离线
- 人格写在 `soul.js` 里，可改

### 感知

- **窗口监测**：谁在前台、标题是什么（浏览器切标签页也算），由原生 C# 助手常驻轮询
- **专注模式**：判定为「摸鱼」才开口，工作状态不出声
- **屏幕陪看**：截图 + OCR 读画面里的硬字幕（人名、台词），ASR 听扬声器在说什么
- **桌宠 Live2D**：独立透明置顶窗口，会冒气泡、会说话，可拖动、可穿透

<p align="center">
  <img src="docs/screenshot-settings.png" alt="聊天设置：感知 / 模型 / 人格 / 桌宠" width="620">
</p>

### 模型

对话、视觉、Embedding 三个角色分别配置，支持：

- Ollama（默认 `http://127.0.0.1:11434`）
- OpenAI 兼容端点
- DeepSeek 官方 API
- OpenRouter

## 安装

```bat
dsh plugin --profile web add "<本目录的绝对路径>"
```

注册后**重启 `dsh web`**。profile 里记的是软链，移动目录后要重新 `add`。

## 前置条件

- **Windows 10/11**：截图、OCR、音频、窗口监测都由 C# 编译成 exe 运行
- .NET Framework 的 `csc.exe`（系统自带）；想要字幕 OCR 还需要 **Windows SDK** 的 `Windows.winmd`，缺了会自动退化成「无 OCR 的截图引擎」
- Node 侧依赖 `sherpa-onnx-node`（ASR 与本地 TTS），需在 DSH 安装目录中可解析

## 桌宠：素材要自备

仓库里**不含任何 Live2D 素材**，原因见 `.gitignore`：

| 需要什么 | 放哪 |
| --- | --- |
| 模型（`.model3.json` 等） | `pet/assets/live2d/<名字>/` |
| 渲染库（pixi.js、pixi-live2d-display、live2dcubismcore） | `pet/assets/vendor/` |
| Electron 运行时 | 首次开启桌宠时从 DSH 桌面端自动准备 |

`live2dcubismcore` 是 Live2D 的专有软件，官方示例模型也有版权，**都不适合随仓库分发**，所以这里留空。

## 隐私

- 屏幕、音频采集**默认全部关闭**，开关都在设置里
- 截图、OCR、ASR、本地 TTS 都在本机完成
- 开启「屏幕陪看」后，截图会发给你配置的**视觉模型端点**；用本地 Ollama 就不出网
- 默认 TTS 引擎是 `edge`，会把要朗读的文字发到微软的在线朗读服务；不想出网就换 `kokoro` / `melo`
- 对话和记忆都存在本机 `~/.dsh/chat-widget/`

## 已知限制

- 仅 Windows
- 没有 Windows SDK 时 OCR 不可用（截图和视觉理解仍可用）
- 桌宠需要自备 Live2D 模型与渲染库
- OCR / ASR 的识别结果只作参考，不保证准确

## 许可

[MIT](LICENSE)。仓库不包含 Live2D Inc. 的任何素材。
