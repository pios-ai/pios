# NPC 音质 SOP —— 固化 4 层栈

把"让所有 NPC 听起来像小豆温柔一样稳定"的方案写死。新 NPC 跑完 `/npc-create` + `/voice-clone` + owner 听测 OK 后自动享受全栈优化。

## 禁止回退铁律（2026-04-21）

**历史耻辱**：2026-04-15 `pibrowser-tts-repetition-penalty` 把 clone 分支采样参数改成 `temperature=0.3, top_p=0.9, repetition_penalty=1.3`，owner 实听 500 字通过。**后来被回退成 `temperature=0.05, top_k=5, top_p=1.0, repetition_penalty=1.05`（低温贪心组合必定口吃）**，全量 NPC 克隆声都开始口吃，owner 2026-04-21 夜才发现已经坏了好多天。

**防御机制**（不是"承诺"，是**代码闸门**）：

1. **`npc-voice-health.sh` 是闸门**
   - 入口：`Projects/pios/scripts/npc-voice-health.sh`
   - 检查 6 项：sanitize / wetext / app.py 参数 / filter 档位 / 服务就绪 / 参考快照
   - `npc-create` / `voice-clone` / `voice-clip-picker` 三个 skill **Phase 0 必跑**，失败即 halt
2. **禁止出现的模式**（health 脚本会硬性检测）
   - `repetition_penalty=1.05`（低温贪心必口吃）
   - `temperature=0.05` + `top_k=5` 组合
   - app.py 缺 `from wetext import Normalizer` 或 `_normalize_text` 前置
   - `voice-filter.js` 缺 `MAGNETIC_ECHO` 四档
3. **参考快照**（可选）：用户自己存一份 `app.py` 快照，`export PIOS_QWEN_REF_APP=/path/to/snapshot.py` 启用，`npc-voice-health.sh` 会对比关键段检测上游配置漂移
4. **回退责任**：任何一轮改 `app.py` 或 `voice-filter.js` 的 skill / worker，收工前**必须跑一次** health 脚本。没跑 = 闭环失败

> 任何发现口吃回来的迹象（小豆温柔/多啦A梦等稳定声也开始口吃）→ 第一件事跑 `bash Projects/pios/scripts/npc-voice-health.sh`，定位是哪一层被偷偷改了，按本文档对应层恢复；**不要靠猜**。

## 4 层栈（从外到内）

### 第 1 层：Node sanitize (PiOS 语义)

**文件**：`Projects/pios/backend/tts-sanitize.js`
**职责**：把 PiOS 特有的"非人话"转成 TTS 能读的文字

- **Markdown**: `**bold**` → `bold`；`[link](url)` → `link`；`` `code` `` → `code`
- **URL**: `https://example.com/path` → `example.com`
- **路径**: `$PIOS_VAULT/Pi/Log/run.log` → `run.log`
- **扩展名**（`stripTechTokens` + EXT_MAP）: `run.log` → `run 日志`；覆盖 `.log/.md/.json/.yaml/.sh/.py/.js/.wav/.mp3/.mp4/.html/.css/.txt/.csv/.pdf/.png/.jpg/...`
- **单位**（`stripTechTokens` + UNIT_MAP）: `3.2GB` → `3.2 千兆字节`；覆盖 `TB/GB/MB/KB`、`ms/us/ns`、`kHz/MHz/GHz`、`mm/cm/km`、`kg/mg/ml`
- **emoji** + 装饰字符: 去除
- **空白整理**: 合并散落空格、行首孤立标点、连续标点去重

### 第 2 层：服务端 WeText (通用 TN)

**服务**：`qwen-voice` 的 `$QWEN_HOME/app.py`
**库**：[`wetext`](https://github.com/pengzhendong/wetext)（WeTextProcessing 纯 Python 运行时，不依赖 pynini）
**安装**：`$QWEN_HOME/bin/pip install wetext`
**触发点**：`do_tts` 和 `do_tts_stream` 第一行 `text = _normalize_text(text)`

覆盖：
- `95%` → `百分之九十五`
- `25°C` → `二十五摄氏度`
- `3.2%` → `百分之三点二`
- `2026 年` → `两千零二十六 年`
- `3:30` → `三点三十分`
- `5.8 亿` → `五点八亿`

⚠️ 注意：GB/MB 等硬件单位由第 1 层处理，不依赖 WeText。

### 第 3 层：app.py 采样参数（去口吃/毛刺）

**文件**：`$QWEN_HOME/app.py`

**Clone 分支**（所有 NPC 克隆音色走这条）：
```python
temperature=0.3, top_p=0.9, repetition_penalty=1.3, max_tokens=1200
```

**Custom 分支**（builtin voice: Uncle_Fu / Dylan / Eric / Ono_Anna 等）：
```python
temperature=0.3, top_p=0.9, repetition_penalty=1.3, max_tokens=600
```

⚠️ **禁止改回** `repetition_penalty=1.05 + top_k=5 + temperature=0.05` 的低温贪心采样——**必定口吃**。

### 第 4 层：客户端分段 + filter 磁性

**分段**（`qwen-tts.js splitTextIntoChunks`）：
- 非 NPC preset: `MAX_CHUNK_LEN=200`
- NPC preset: `chunkLimit=60`（更短，强制每段重新锚到 ref，防长生成 attention 离开 ref 导致音色漂移）

**Filter**（`voice-filter.js`）：
- **BASE_FILTER**（用于 default/warm/fun/eric/cloned preset）= `chorus + 三段 EQ + aecho mid 档 + highpass/lowpass + loudnorm -14 LUFS`
- **NPC preset filter** = BASE 同构，但 aecho 档位由 `characters.yaml` 的 `voice_magnetic` 字段决定

三档 aecho 参数：

| 档位 | aecho 参数 | 说明 |
|---|---|---|
| `soft` | `0.7:0.5:30\|60\|120:0.3\|0.2\|0.15` | 柔，尾巴 120ms / decay 0.3 |
| `mid` | `0.8:0.6:30\|60\|150:0.4\|0.25\|0.2` | 中（默认），尾巴 150ms / decay 0.4 |
| `strong` | `0.8:0.7:30\|80\|200:0.5\|0.3\|0.3` | 强，尾巴 200ms / decay 0.5 |

## per-NPC 磁性档配置

**字段**：`characters.yaml` 每个 character 下可选字段 `voice_magnetic: <soft|mid|strong>`
**默认**：缺失 → `mid`（`qwen-tts.js` 兜底，不强制写字段）
**Owner 入口**：Home → Team → Config → 角色页（尚未实装，计划项）

示例：
```yaml
characters:
  trump:
    display_name: 特朗普
    voice: 特朗普
    voice_verified: false
    voice_magnetic: strong   # 短促男声适合强档磁性
```

## 新 NPC 流程（自动继承全栈）

1. `/npc-create <id>` → 生成 SVG + 14 pose + `characters.yaml` 条目
2. `/voice-clone <display_name> <id> <BV 号|URL|wav>` 或 `/voice-clip-picker`（带 demucs 人声分离）→ 克隆真声到 qwen-voice
3. 跑 round-trip（TTS → ASR 识别）+ owner 主观听测
4. 通过 → `characters.yaml` 标 `voice_verified: true`
5. **自动继承** 4 层栈优化
6. （可选）owner 在 Home 角色页调 `voice_magnetic` 档位，默认 mid

## 依赖与备份

**qwen-voice 不是 git repo**，app.py 改动没版本保护：

| 备份文件 | 对应状态 |
|---|---|
| `$QWEN_HOME/app.py.bak-before-rep13` | 修口吃前老参数（`rep=1.05, top_k=5, temp=0.05`） |
| `$QWEN_HOME/app.py.new` | 当前版本（`rep=1.3, top_p=0.9, temp=0.3` + WeText 前置） |

**如果将来重装 qwen-voice**：
1. `$QWEN_HOME/bin/pip install wetext`
2. 把 `app.py.new` 复制回 `app.py`
3. `launchctl kickstart -k gui/$(id -u)/com.<owner>.qwen-voice` 重启服务

## 故障排查

| 症状 | 最可能根因 | 检查位置 |
|---|---|---|
| 英文 token 被吞 / 段尾丢字 | ref 是纯英文演讲 | ref 质量（重挑中文片段） |
| 卡在某段 / 不讲完整 | 未映射的技术 token（新扩展名/单位） | 补 EXT_MAP / UNIT_MAP |
| 口吃 / 重复循环 | app.py clone 分支采样参数被回退 | `repetition_penalty=1.3` 是否还在 |
| 数字 / 百分号读不出 | WeText 未启用 | `pip list \| grep wetext` / `_normalize_text` 调用 |
| 磁性太强 / 太弱 | `voice_magnetic` 档位不匹配 | Home 角色页切档，或直接改 characters.yaml |
| 机械声 / 底噪 | ref 音频本身带噪 | 重跑 `/voice-clip-picker`，挑干净段 |
| 末尾静音很长 | `max_tokens=1200` 输出固定长度 | 是 TTS 本身特性，EOS 后是静音填充 |

## 历史背景

- **2026-04-14 ~ 04-15**：修小豆温柔长文本口吃（归档卡 `pibrowser-tts-repetition-penalty`）—— 改 `repetition_penalty=1.3, top_p=0.9, temperature=0.3`。owner 实听 500 字通过。
- **2026-04-16 ~ 04-21**：建 `tts-sanitize.js` 前处理层（归档卡 `pios-tts-sanitize-symbols-paths`）。
- **2026-04-21 夜**：本次固化 —— 上面 4 层全部落位，加装 WeText，补扩展名/单位 map，重构 npc preset 加三档磁性，BASE_FILTER aecho 从"爆炸档"回到 mid。
