# 签名（SignPath Foundation）

本项目的原生引擎 EXE 由 [SignPath Foundation](https://signpath.org/) 免费签名。
这份文件只写**要准备什么、要填什么、怎么验**；构建本身见 [NATIVE.md](NATIVE.md)。

为什么必须签名：Windows 11 的 Smart App Control 没有按应用放行的白名单，
只放行"微软判定安全"或"受信任根证书签过名"的程序。自己用 `csc.exe` 编的没有签名，
在那样的机器上会被直接拦掉（详见 [NATIVE.md](NATIVE.md#为什么需要签名)）。

## 申请前，仓库这边要满足的

| 要求 | 本仓库的状态 |
| --- | --- |
| 项目确实在维护、有可下载的发布 | 需要先打一个 `v*` 标签、发一次 Release（未签名也行） |
| OSI 认可的开源许可证 | MIT（[LICENSE](../LICENSE)） |
| 没有商业双许可 | 没有 |
| 要签的产物完全由本仓库源码构建 | `native/*.cs` → `native/build.mjs` → CI，源码全在仓库里 |
| 产物由项目自己的 CI 构建，且 CI 的全部作业跑在 GitHub 托管 runner 上 | `.github/workflows/build-native.yml`，`runs-on: windows-latest` |
| 功能在下载页有说明 | [README](../README.md)、[NATIVE.md](NATIVE.md) |
| 不在产物里夹带专有组件 | 四个 EXE 只由 `native/*.cs`（MIT）编成；角色素材另有许可、**不进 EXE** |

## 申请时要填/说明的

1. 项目名：`dsh-chat-widget`
2. 仓库：`https://github.com/nodcharlotte/dsh-chat-widget`
3. 许可证：MIT
4. **要签什么**：四个 windows-x64 的 .NET Framework 控制台程序
   （`dshcw-capture.exe`、`dshcw-capture-ocr.exe`、`dshcw-audio.exe`、`dshcw-watch.exe`），
   每个 6–20 KB，无第三方二进制依赖。
5. **它们做什么**：截屏 / WinRT OCR / WASAPI loopback 录音 / `SetWinEventHook` 前台窗口监测。
   不联网、不写注册表、不提权。
6. **怎么分发**：作为 DSH 插件的一部分，用户在自己机器上运行；本插件在
   Smart App Control 开启的机器上会从本仓库的 Release 下载这几个**已签名**的文件，
   并按 `native-manifest.json` 里的 sha256 校验。
7. **怎么构建**：`node native/build.mjs`，由 `.github/workflows/build-native.yml` 在
   `windows-latest` 上执行；签名请求是该工作流里的 `SignPath/github-action-submit-signing-request` 步骤。
8. 说明角色素材（`pet/assets/live2d/朝那玲/`）有独立许可、**不参与签名产物**，
   避免审核把"保留所有权利"的美术素材当成"专有代码"。

## 批准之后要做的（一次性）

SignPath 控制台里：

| 项 | 值 | 用在哪 |
| --- | --- | --- |
| Organization ID | 控制台给的 GUID | 仓库 secret `SIGNPATH_ORGANIZATION_ID` |
| Project slug | `dsh-chat-widget` | 工作流 `project-slug` |
| Signing policy slug | `release-signing` | 工作流 `signing-policy-slug` |
| API token | 给提交者权限的 token | 仓库 secret `SIGNPATH_API_TOKEN` |
| Artifact configuration | 根元素 `<zip-file>`，内含上表四个 exe | 不填就用默认配置 |

Artifact configuration 之所以是 zip：`actions/upload-artifact` 默认把上传的文件打成一个 zip
（见 SignPath 文档里那段 "ZIP archives"）。我们上传的就是四个裸 exe，解压后平铺在根目录。

GitHub 仓库设置：

```text
Settings → Secrets and variables → Actions

Variables:
  SIGNPATH_SIGNING_ENABLED = true      # 不加这个变量，工作流照常编、只是不签名不发版

Secrets:
  SIGNPATH_API_TOKEN
  SIGNPATH_ORGANIZATION_ID
```

## 发一版签过名的

```bat
git tag v0.3.0
git push origin v0.3.0
```

工作流会：编四个引擎 → 传成 artifact → 提交 SignPath 签名 → 取回签名产物 →
按**签名后**的文件重算 `native-manifest.json`（`"signed": true`）→ 发 Release。

如果签名策略要求人工批准，那个步骤会一直等到批准（超时 30 分钟）。

## 怎么确认真的签上了

```powershell
Get-AuthenticodeSignature .\dshcw-capture.exe | Format-List Status, SignerCertificate
```

- `Status` 应该是 `Valid`
- `SignerCertificate.Subject` 里出现 `SignPath Foundation`
- `native-manifest.json` 里 `"signed": true`

没签名的那次 Release 里 `"signed": false`，插件在 Smart App Control 开着的机器上**会拒收**
（下载了也跑不起来），转而本机编译并提示关 SAC。

## 还没做

- [ ] 打第一个 `v*` 标签、发一次 Release（申请 SignPath 要有可下载的版本）
- [ ] 提交 SignPath Foundation 申请
- [ ] 批准后填上面的变量与 secrets
- [ ] 发第一个签过名的版本