# 原生引擎：编译、发布、签名

这个插件有四个 C# 小引擎，负责 PowerShell 做不到或做不稳的事（脚本会被 Defender 的 AMSI 判成恶意）。
它们在运行时以 **EXE** 形式被调用，源码在 [`native/`](../native/)。

| 产物 | 源码 | 干什么 | 用它的功能 |
| --- | --- | --- | --- |
| `dshcw-capture.exe` | `CaptureEngine.cs` | 截屏、拼 2×2 宫格、写 JPEG | 屏幕陪看 |
| `dshcw-capture-ocr.exe` | 同上 + `OcrProbe.cs` | 同上，另带 WinRT OCR（读画面里的硬字幕） | 字幕 OCR |
| `dshcw-audio.exe` | `AudioEngine.cs` | WASAPI loopback 抓扬声器音轨 | ASR |
| `dshcw-watch.exe` | `WindowWatch.cs` | `SetWinEventHook` 盯前台窗口 | 窗口监测、专注模式 |

四个都不联网、不写注册表、不提权，只做上表里的事。源码全文都在仓库里，可逐行核对；
也能自己编一份和 Release 里的对比（见下文「自己编译」）。

## 为什么需要签名

Windows 11 的 **智能应用控制（Smart App Control，SAC）** 只放行两类程序：

- 微软的 App Intelligence 判定为安全的；
- 由 **受信任根证书计划**里的 CA 签发证书签过名的。

它**不看**文件来源、不看路径、不看 Mark-of-the-Web，也**没有按应用放行的白名单**。
所以本机 `csc.exe` 当场编出来的 EXE 在开了 SAC 的机器上会被直接拦掉，
Windows 安全中心报「此应用的一部分已被阻止…因为我们无法确认谁发布了它」。

插件对此的处理（`host/native-build.js`）：

1. 先读注册表判断 SAC 是否开着（`VerifiedAndReputablePolicyState`，0 关 / 1 强制 / 2 评估）；
2. **没开** → 照旧本机 `csc.exe` 编译，约 0.4 秒，不联网；
3. **开着** → 从本仓库的 GitHub Release 下载**已签名**的预编译产物，逐个核对清单里的 sha256；
4. **下载失败** → 退回本机编译，同时在 OCR / ASR / 窗口监测 三处小字里说明原因，
   并给一个跳到「Windows 安全中心 → 应用和浏览器控制」的入口。

## Release 里有什么

一次发版（推 `v*` 标签）产出的资产：

```
dshcw-capture.exe
dshcw-capture-ocr.exe
dshcw-audio.exe
dshcw-watch.exe
native-manifest.json
```

`native-manifest.json` 是插件下载时用来校验的清单：

```json
{
  "version": "v0.3.0",
  "files": {
    "dshcw-capture.exe": "<sha256>",
    "...": "..."
  }
}
```

插件只认清单里列了、且哈希对得上的文件；对不上就不落盘，退回本机编译。

## 怎么编出来的

`.github/workflows/build-native.yml`，`windows-latest`：

1. `actions/checkout` → `actions/setup-node`（Node 20）
2. `node native/build.mjs "$GITHUB_REF_NAME"`
3. 缺 WinRT 契约时，脚本从 NuGet 拉 `microsoft.windows.sdk.contracts` 并用 `tar.exe` 解压
   （不装 Windows SDK、不提权）
4. 用系统自带的 `C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe` 逐个编译
5. 产物打包成 GitHub Actions artifact（未签名）
6. **SignPath** 提交签名请求，等它签完，把签好的产物取回来
7. 对**最终**（签名后）的文件重算 sha256，写 `native-manifest.json`
8. `gh release create/upload` 发版

第 2 步和插件在本机编译用的是**同一份代码**（`host/native-build.js` 的 `compileEngine`），
只把 `DSH_HOME` 指到工作目录，产物落到 `<DSH_HOME>/chat-widget/native/`。
没有第二套编译参数，也就不会两边编出不一样的东西。

签名由 [SignPath Foundation](https://signpath.org/) 提供（开源项目免费），
发布者显示为 `SignPath Foundation`。

## 自己编译（验证用）

```bat
set DSH_HOME=%CD%\.native
node native\build.mjs v0.0.0-local
dir .native\chat-widget\native
```

四个 EXE 加一份清单会出现在 `%CD%\.native\chat-widget\native\`。
`csc.exe` 不保证可复现，所以**哈希和你下载到的那份不会一样**——这是正常的；
要判断"是不是同一份代码编的"，看的是源码，不是哈希。

## 相关文件

- `host/native-build.js` —— 检测 SAC、下载校验、本机编译、`nativeStatus()` 上报给界面
- `native/build.mjs` —— CI 入口
- `.github/workflows/build-native.yml` —— 构建 + 签名 + 发版
- `client.js` —— 三处小字里那段「联网拉取…失败」的提示与【SAC设置】链接