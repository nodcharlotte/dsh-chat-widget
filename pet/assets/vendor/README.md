# pet/assets/vendor —— 第三方运行时

| 文件 | 许可 | 进仓库？ |
|---|---|---|
| `pixi.min.js` | MIT | ✅ 可以 |
| `pixi-live2d-display-cubism4.min.js` | MIT | ✅ 可以 |
| `live2dcubismcore.min.js` | **Live2D Proprietary Software License**（专有） | ❌ **不进**（已 gitignore） |

## 为什么 Cubism Core 不在仓库里

`live2dcubismcore.min.js` 是 Live2D Inc. 的专有软件，适用
[Live2D Proprietary Software License Agreement](https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_en.html)。

协议里相关的两条：

- **§5**：Core 属于 "Redistributable Code"，**只能作为你作品的组成部分分发给最终用户**（as-is、不修改）；
- **§6.2 / §6.8**：不得把本软件的全部或一部分对外分发/公开，也不得**按非 Live2D 的许可证**发布它。
  —— 放在公开仓库里、跟着项目的 MIT 许可一起发，正好撞这条。

发布**成品**（桌宠能跑起来的那份）是允许的：个人 / 年营收低于 1000 万日元的，§2.2 免签出版许可。

## 那这个文件从哪来

**方式一（推荐，插件自己会做）**：第一次点「感知 → 桌宠」开关时，界面发现缺文件会在卡片里
亮一行红字 +【下载】，点了由宿主从 Live2D **官方托管地址**取，自动落到这个目录：

```
https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js
```

（这是 Live2D 下载页「Cubism Core for Web / ホスティング用途」那一栏给的地址，约 200 KB 单文件。）

**方式二（手动）**：从 [Cubism SDK for Web](https://www.live2d.com/sdk/download/web/) 下载 SDK 包，
把里面的 `Core/live2dcubismcore.min.js` 拷到本目录，文件名保持 `live2dcubismcore.min.js`。

## 两点注意

1. 官方只提供 **"Latest"** 这一个地址（带版本号的路径是 404）。所以宿主下载后会**校验内容**
   （必须含 `csmGetVersion` / `MocVersion_30`），不通过就当失败。
2. 下载即视为同意上面那份使用许可 —— 界面上的文案已经写明。
