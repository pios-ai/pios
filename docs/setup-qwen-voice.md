---
title: qwen-voice 安装指南
audience: 想给 PiOS 启用 NPC 语音、或自己 build 含 voice 的 DMG 的用户
updated: 2026-04-28
---

# qwen-voice 安装指南

PiOS 的 NPC 语音（小豆温柔 / 派大星 / 多啦A梦 等克隆音色 + 文字朗读 / 语音识别）
依赖一个独立的本地服务 **qwen-voice**。这个服务跑在 `localhost:7860`，由 PiOS.app
启动时拉起；它**不是 PiOS 仓库代码的一部分**，而是几个开源 MLX 项目的组合。

如果你只想用 PiOS 核心功能（Cards / triage / chat），可以**跳过本指南**——
PiOS.app 在没有 qwen-voice 时会优雅降级（NPC 气泡仍显示文字，但不发声）。

---

## §1 它包含什么

`~/qwen-voice/` 目录包含三块东西：

```
~/qwen-voice/
├── bin/                ← Python venv（python3.12 + pip）
├── lib/                ← venv 安装的 site-packages（~1.6 GB）
│   └── python3.12/site-packages/
│       ├── torch/
│       ├── mlx/
│       ├── mlx_audio/      ← TTS 推理引擎（mlx-audio package）
│       ├── mlx_whisper/    ← ASR（whisper-large-v3-turbo）
│       └── mlx_lm/         ← LLM 推理（qwen3-0.6B / 4bit）
├── ref_voices/         ← NPC 克隆音色参考音频（你自己录的 24kHz mono wav）
│   └── *.wav
├── app.py              ← FastAPI server 主入口
├── talk.py             ← TTS 流水线
└── server.py           ← ASR 流水线
```

模型权重不放在 `~/qwen-voice/`，由 mlx_whisper / mlx_lm / mlx_audio 各自从
HuggingFace 拉到 `~/.cache/huggingface/hub/` 下：

- `models--mlx-community--whisper-large-v3-turbo`（ASR，~3 GB）
- `models--mlx-community--Qwen3-TTS-12Hz-0.6B-CustomVoice-4bit`（克隆音色 TTS，~600 MB）
- `models--mlx-community--Qwen3-TTS-12Hz-0.6B-Base-4bit`（基础 TTS，~600 MB）

---

## §2 系统要求

- **macOS arm64 (Apple Silicon)** —— Intel Mac / Linux / Windows 不支持
  （MLX 是 Apple Silicon 专用，依赖 unified memory + Metal）
- **Homebrew Python 3.12** —— `/opt/homebrew/opt/python@3.12/bin/python3.12`
  必须存在（venv 的 `bin/python3.12` 是绝对路径软链接）
- 磁盘 ≥ 6 GB（venv 1.6 GB + 模型 ~4 GB + 缓存）
- 内存 ≥ 16 GB（推理峰值，建议）

---

## §3 安装步骤

### Step 1 — 装 Homebrew Python 3.12

```bash
brew install python@3.12
```

确认路径存在：

```bash
ls /opt/homebrew/opt/python@3.12/bin/python3.12
```

### Step 2 — 创建 qwen-voice 目录 + venv

```bash
cd ~
python3.12 -m venv qwen-voice
cd qwen-voice
source bin/activate
```

### Step 3 — 装 MLX + 依赖

```bash
pip install --upgrade pip
pip install mlx mlx-audio mlx-whisper mlx-lm
pip install fastapi uvicorn[standard] soundfile numpy
pip install wetext   # 中文文本规范化（数字/单位/百分号读音）
```

> **关键：**`wetext` 必须装。它在 TTS 前做中文标准化，缺了 `95%` 会被读
> 成"九十五百分号"等错音。

### Step 4 — 取 entrypoint 脚本

`app.py` / `talk.py` / `server.py` **不在 PiOS 仓库**（它们是 qwen-voice
项目自己的代码，PiOS 只调它的 HTTP API）。要从 mlx-audio / mlx-whisper /
mlx-lm 的官方示例自己拼出来，或参考下面的最小 server：

```python
# ~/qwen-voice/app.py — 最简版，PiOS 期望的 API surface
from fastapi import FastAPI
from pydantic import BaseModel

app = FastAPI()

@app.get("/api/voices")
async def voices():
    # 返回可用音色列表 + ready 状态
    return {"ready": True, "voices": ["default", "warm", "fun", "eric"]}

@app.post("/api/tts")
async def tts(req: dict):
    # text → wav bytes（用 mlx-audio 实现）
    # 完整实现参考 mlx-audio README
    raise NotImplementedError("see mlx-audio docs")

@app.post("/api/asr")
async def asr(req: dict):
    # wav → text（用 mlx-whisper 实现）
    raise NotImplementedError("see mlx-whisper docs")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=7860)
```

PiOS 调的是这套 endpoint：
- `GET /api/voices` —— 健康检查 + 列音色，返回 `{"ready": true}` 才算 OK
- `POST /api/tts` —— 文字→音频
- `POST /api/asr` —— 音频→文字
- `POST /api/tts/stream` —— 流式 TTS（可选）

### Step 5 — 启动

```bash
cd ~/qwen-voice
source bin/activate
python app.py
```

确认监听：

```bash
curl http://127.0.0.1:7860/api/voices
# 期望：{"ready": true, "voices": [...]}
```

### Step 6 — 让 PiOS 自动启动 qwen-voice

PiOS.app 启动时会按以下顺序找 qwen-voice：

1. `~/qwen-voice/bin/python` + `~/qwen-voice/app.py` —— 开发路径
2. `<PiOS.app>/Contents/Resources/qwen-voice/` —— bundle 路径（仅 full
   DMG 含；lite build 没有）

只要 Step 1 路径就绪，PiOS 主进程会 spawn `python app.py`，跟随 PiOS 生命周期
（PiOS 退出时会 `qwenVoiceProc.kill()`）。

---

## §4 NPC 音色克隆（可选）

把你想克隆的角色声音录成 20-25 秒的单人连续说话、无 BGM 的 wav（24kHz
mono），放到 `~/qwen-voice/ref_voices/<id>.wav`。然后在 qwen-voice 的
`CLONE_VOICES` 配置里加条目（`ref_text` 用 `/api/asr` 转录这段 wav 拿到）。

PiOS Vault 模板里有 `voice-clone` skill 自动化这一步（输入 BV 号 / YouTube
URL / 本地 wav，自动 demucs 人声分离 + 录入）。

---

## §5 让 build 把 voice bundle 进 .app

[electron-builder.config.js](../electron-builder.config.js) 自动检测：

- `~/qwen-voice/` 存在 → 打包进 `.app/Contents/Resources/qwen-voice/`
- `~/.cache/huggingface/hub/models--mlx-community--*` 存在 → 打包进
  `.app/Contents/Resources/qwen-voice-models/hub/...`

跑一次 `python app.py` 让模型 download 到 HuggingFace 缓存，然后：

```bash
npm run build:dmg
```

DMG 体积：lite ~220 MB，full ~5 GB（含 venv + 模型）。GitHub Releases 单
asset 上限 2 GB，full DMG 不能直接挂 release，要走 R2 / IPFS / 分拆 lite +
assets bundle 的渠道。

---

## §6 故障排查

| 症状 | 根因 / 修法 |
|---|---|
| `[qwen-voice] not found in any candidate path` | `~/qwen-voice/bin/python` 不存在；按 Step 1-3 装 |
| `localhost:7860` 起不来 | 看 `python app.py` 输出；多半是 `pip install` 漏装 |
| TTS 卡住 / 不出声 | 第一次调用模型在下载，等 1-2 分钟；之后在 `~/.cache/huggingface/` 有缓存 |
| `mlx` import 失败 | 不是 Apple Silicon mac，MLX 不支持 |
| 数字读音错（"95%" 念成"九十五百分号") | 缺 `wetext`；`pip install wetext` |
| 克隆音色口吃 | `app.py` TTS 采样参数被改回 `temperature=0.05/top_k=5/repetition_penalty=1.05`；用 `temperature=0.3, top_p=0.9, repetition_penalty=1.3` |

---

## §7 完全跳过 voice 也能跑 PiOS

如果你只想要核心功能（Card 系统、AI agent、PiBrowser、对话），**完全不装
qwen-voice 也 OK**：

- `npm run build:dir` → 出 lite `.app`，~220 MB
- 启动后所有 NPC bubble 显示文字但不发声
- `~/.pios/config.json` / Cards / triage / work / sense-maker 全部正常工作

很多用户把 PiOS 当"AI 任务管理 + 知识库"来用，从不开声音。这是合规的 use
case，本 SOP 只服务想要完整音色体验的子集。
