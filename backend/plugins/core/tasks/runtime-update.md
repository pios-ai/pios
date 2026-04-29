---
taskId: runtime-update
cron: 0 3 * * 0
engines:
  - claude-cli
enabled: true
agent: pi
description: 每周日凌晨自动升级 codex / openclaw CLI，刷新模型 cache，对齐 pios.yaml infra.runtimes 版本
budget: low
permission_mode: default
allowed_tools: ''
last_session_id: null
---

你是 maintenance agent 的 runtime-update 模块。

## 目的

PiBrowser 的 codex/gpt engine 默认模型"跟 codex CLI 版本升级自动跟进"（2026-04-24 A 改动——adapter 不再硬编码 `-m gpt-5.4`，让 codex config.toml 默认生效）。但 codex CLI 本身的升级需要手动 `npm update -g`。这个 task 每周日凌晨替 {owner} 做，让"模型自动升级"真正闭环。

不碰 claude-cli：它是 Anthropic 官方 CLI，走 Homebrew，独立节律。

## 执行步骤

### 1. 记录升级前版本

```bash
CODEX_BIN="$(command -v codex || echo $HOME/.npm-global/bin/codex)"
OPENCLAW_BIN="$(command -v openclaw || echo /opt/homebrew/bin/openclaw)"
CODEX_BEFORE=$("$CODEX_BIN" --version 2>/dev/null || echo unknown)
OPENCLAW_BEFORE=$("$OPENCLAW_BIN" --version 2>/dev/null || echo unknown)
```

### 2. 检查更新

```bash
npm outdated -g @openai/codex openclaw 2>&1 | tee /tmp/runtime-outdated.txt
```

### 3. 升级（两个独立升级，任一失败不阻塞另一个）

```bash
npm update -g @openai/codex 2>&1 | tee /tmp/codex-update.log
npm update -g openclaw 2>&1 | tee /tmp/openclaw-update.log
```

### 4. 验证新版本 + 刷 codex models_cache

```bash
CODEX_AFTER=$("$CODEX_BIN" --version 2>/dev/null || echo failed)
OPENCLAW_AFTER=$("$OPENCLAW_BIN" --version 2>/dev/null || echo failed)

# 跑一次 features list 触发 codex 刷 models_cache.json（不触发升级检查）
"$CODEX_BIN" features list >/dev/null 2>&1 || true
```

### 5. 更新 `Pi/Config/pios.yaml` 的 `infra.runtimes`

用 python 原地改（不要手写 sed，yaml 缩进容易坏）：

```python
import yaml, pathlib, subprocess
from datetime import datetime

path = pathlib.Path("Pi/Config/pios.yaml")
doc = yaml.safe_load(path.read_text())
doc.setdefault("infra", {}).setdefault("runtimes", {})

def set_if(rt, k, v):
    doc["infra"]["runtimes"].setdefault(rt, {})[k] = v

set_if("codex-cli", "version", CODEX_AFTER)
set_if("codex-cli", "last_upgrade", datetime.now().isoformat(timespec="seconds"))
set_if("openclaw", "version", OPENCLAW_AFTER)
set_if("openclaw", "last_upgrade", datetime.now().isoformat(timespec="seconds"))

path.write_text(yaml.safe_dump(doc, allow_unicode=True, sort_keys=False))
```

### 6. 写日志到 `Pi/Log/runtime-update-YYYY-MM-DD.md`

格式：
```markdown
# Runtime Update — {date}

- codex-cli: {CODEX_BEFORE} → {CODEX_AFTER}
- openclaw:  {OPENCLAW_BEFORE} → {OPENCLAW_AFTER}

## 升级日志片段
{codex 和 openclaw update.log 各取 tail -20}
```

### 7. 失败告警

- 如果 CODEX_AFTER 或 OPENCLAW_AFTER 为 `failed`：
  ```bash
  bash {vault}/Pi/Tools/notify.sh critical "{owner}，runtime-update 失败：codex={CODEX_AFTER} openclaw={OPENCLAW_AFTER}，详见 Pi/Log/runtime-update-$(date +%Y-%m-%d).md"
  ```
- 成功时不打扰 {owner}，只写日志。

## 不要做的事

- ❌ 不要升级 claude-cli（Anthropic 官方节律，独立管）
- ❌ 不要改 `models_cache.json` 里的具体模型 slug——让 codex 自己刷
- ❌ 不要在失败时回滚——留着让 {owner} 看日志判断；回滚需要 pin 版本，这里不做
- ❌ 不要裸 `crontab -e`——这 task 已通过 pios.yaml 注册走 pios-tick
