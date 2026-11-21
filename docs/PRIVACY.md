# Privacy Policy / 隐私政策

`dsh-chat-widget` is a local-first plugin for DeepSeek Harness (DSH). It has no accounts,
no analytics, no telemetry, and no server of its own.

本插件没有账号、没有统计埋点、没有遥测，也没有自己的服务器。

## What is stored, and where

- **Chat history, memories, settings** live in a SQLite file under `~/.dsh/chat-widget/`
  (or `%USERPROFILE%\.dsh\chat-widget\`) on your own machine.
- **Screenshots, OCR results, window titles, audio transcripts** are written to the same
  local directory when the corresponding features are enabled. They are never uploaded by
  the plugin itself.

## When data leaves the machine

Everything that leaves the machine goes to an endpoint **you configure**, or to a service
**you switch on**:

| Feature | Default | Where the data goes |
| --- | --- | --- |
| Chat / vision | off until you set a model | The model endpoint you configure (a local Ollama endpoint keeps it on-device) |
| Screen companion | off | The screenshots it captures are sent to your vision endpoint |
| ASR (speaker audio) | off | Local only (`sherpa-onnx`) |
| TTS, `edge` engine | on when TTS is enabled | Microsoft's online speech service (the text being spoken) |
| TTS, `kokoro` / `melo` engines | off | Local only |

Turning a feature off stops the data flow immediately; turning TTS to `kokoro` or `melo`
keeps speech synthesis on-device.

## Network calls the plugin makes on its own

- Downloading Live2D Cubism Core from `cubism.live2d.com` (proprietary component, once,
  only when you enable the desktop pet).
- Downloading the signed native engine binaries and their `native-manifest.json` from this
  repository's GitHub Releases, only on machines where Smart App Control is enabled.
- Downloading the WinRT contracts package from NuGet, only if OCR is requested and no
  Windows SDK is installed.

Each of these can be refused; the plugin degrades gracefully (it compiles the engines
locally instead, or reports that OCR is unavailable).

## Data we receive

None. The maintainers operate no backend and collect no usage data. GitHub itself records
repository traffic and release download counts, subject to
[GitHub's privacy statement](https://docs.github.com/en/site-policy/privacy-policies/github-privacy-statement).

## Children

The software is a developer tool and is not directed at children.

## Changes

Changes to this policy are made in this file and are visible in the repository history.

## Contact

Open an issue at <https://github.com/nodcharlotte/dsh-chat-widget/issues>.