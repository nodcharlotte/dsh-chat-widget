# Live2D 素材（模型与渲染库）不进仓库

## 为什么

| 素材 | 许可 | 处理 |
| --- | --- | --- |
| **桃濑日和**（Live2D 官方示例模型） | Live2D 免费素材许可，**禁止再发布**、禁止改动角色设计 | ❌ 不提交 |
| `live2dcubismcore.min.js` | Live2D Proprietary Software License（专有） | ❌ 不提交，运行时从官方地址下载 |
| `pixi.min.js` / `pixi-live2d-display` | MIT | ✅ 可提交（在 `vendor/`） |

Cubism Core 的协议里，§6.2 / §6.8 明确禁止把它「对外分发或公开」，也禁止按非 Live2D 的许可证发布；
放在公开仓库里跟着本项目的许可证一起发，正好撞这条。所以 `vendor/README.md` 里写了两种取得方式，
插件第一次开启桌宠时也会提示一键从 Live2D 官方托管地址拉取。

## 自己用的时候

```
pet/assets/live2d/<模型名>/        # 模型（.model3.json / .moc3 / 贴图 / 动作）
pet/assets/vendor/                 # 渲染库（pixi + pixi-live2d-display + cubism core）
```

放进去后重启 `dsh web`，设置里的「桌宠」会自动发现模型。

## 关于本仓库里的朝那玲

`pet/assets/live2d/朝那玲/` 和 `docs/character.png` 是作者自有的角色素材，
授权见 [ASSETS.md](../../ASSETS.md)，**不是** Live2D 的示例角色。
