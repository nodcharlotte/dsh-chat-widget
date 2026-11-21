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

表单是英文的（[signpath.org/apply](https://signpath.org/apply)），下面是逐栏可直接粘贴的英文答案。

| 字段 | 填什么 |
| --- | --- |
| Project Name* | `dsh-chat-widget` |
| Repository URL* | `https://github.com/nodcharlotte/dsh-chat-widget` |
| Homepage URL* | `https://github.com/nodcharlotte/dsh-chat-widget` |
| Download URL | `https://github.com/nodcharlotte/dsh-chat-widget/releases/latest` |
| Privacy Policy URL | `https://github.com/nodcharlotte/dsh-chat-widget/blob/main/docs/PRIVACY.md` |
| Wikipedia URL | 留空 |
| Tagline* | `Side-panel chat companion for DeepSeek Harness that can watch your screen and live on your desktop as a Live2D pet.` |
| Category* | 下拉框里最贴近的是 **Developer Tools**（没有就选 Desktop / Other） |
| Build System* | `GitHub Actions` |
| Maintainer Type | **Individual**（除非用公司名义） |
| Company Name | 留空 |

Description*：

```text
dsh-chat-widget is a plugin for DeepSeek Harness (DSH), a desktop AI harness. It adds a
persistent chat panel to the DSH sidebar, keeps a local SQLite memory of past conversations,
and can optionally observe the foreground window, read burned-in subtitles from screen
captures through the Windows OCR API, transcribe speaker audio, and render an animated Live2D
character in a transparent always-on-top window. Four small C# engines perform capture, OCR,
audio loopback and window tracking; they are compiled locally from source, or downloaded as
signed binaries where Windows Smart App Control would otherwise block unsigned code.
Everything runs on the user's machine; network access is limited to the model endpoints the
user configures.
```

Reputation*（这个字段最弱 —— 仓库是新的，零 star、零下载，只能说实话）：

```text
dsh-chat-widget is a young project: the repository was created in November 2026 and the first
release (v0.3.0) was published immediately before this application, so there is no media
coverage or download history yet. What can be verified today: all source code, build
instructions and the signing setup are public in the repository (docs/NATIVE.md,
docs/SIGNING.md); the binaries are produced only by the repository's own GitHub Actions
workflow on GitHub-hosted runners, never on a developer machine; the plugin targets DeepSeek
Harness and follows that project's published plugin interface. We are applying before the
first public release so that what users download is signed from the start rather than
retrofitted later.
```

Primary Discovery Channel*（如实选）：下拉里若有 AI assistant / ChatGPT 之类就选它，exact source 填：

```text
Suggested by an AI coding assistant while researching how to distribute unsigned Windows
binaries on machines with Smart App Control enabled.
```

两个勾选框（Code of Conduct、个人数据处理）自己读一遍再勾。
证书是发给 **SignPath Foundation** 的，个人姓名不会出现在签名里，只会显示
`SignPath Foundation` 这个发布者。

### 还有自由文本框（或回邮件）的话，附上这段

```text
What would be signed: four Windows x64 .NET Framework console executables
(dshcw-capture.exe, dshcw-capture-ocr.exe, dshcw-audio.exe, dshcw-watch.exe), 6-20 KB each,
with no third-party binary dependencies. They capture the screen and compose contact sheets,
run Windows.Media.Ocr, record the speaker through WASAPI loopback, and track the foreground
window through SetWinEventHook. They do not access the network, do not write to the registry
and never request elevation.

Build: `node native/build.mjs` executed by .github/workflows/build-native.yml on a
GitHub-hosted windows-latest runner; the signing request is a
`signpath/github-action-submit-signing-request` step inside that same workflow. The compile
args are shared with the plugin's own local build path, so CI and local builds cannot drift.

Licensing: all code, including the C# sources of the signed binaries, is MIT. The bundled
Live2D character model and artwork have their own license (see ASSETS.md) and are NOT part of
the signed executables.
```

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