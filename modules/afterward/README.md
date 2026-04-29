# Afterward

> PiOS 的死后交接模块 — AI-powered digital continuity

## 是什么

当你不在了，Afterward 替你：

- 把私密信件 / 资产交接 / 指令按时间 + 关系，分别投递到对的人手里
- 继续履行你想让 Pi 长期承担的使命（陪伴 / 监护 / 守护）
- 保证你爱的人不会因为你的离开而失去支持

Afterward **不是遗嘱软件**（LegalZoom 有了），**不是 encrypted notes**（1Password 有了）。

它是 **AI 替你继续活在你在乎的关系里**。

---

## 为什么是 PiOS 的一个模块

PiOS 里的 Pi 是你活着时的 chief of staff。
Afterward 是死后 Pi 的延续。

**同一个 AI，同一份 memory，从活着到不在，continuous。**

这是 Afterward 的核心 moat — password manager / 遗嘱软件 / 其他 "digital legacy" 服务都做不到。

---

## 核心机制

| 组件 | 作用 |
|---|---|
| **Encrypted Vault** | 所有内容 AES-256-GCM 加密（复用 obsidian-vault-encryptor 插件） |
| **Shamir Secret Sharing** | Vault master key 5/3 切片，分给 5 位 trustee |
| **Heartbeat Daemon** | 每日 challenge + 60 天 soft alert + 90 天 death 确认 |
| **Action Executor** | 一次性投递（信件 / 资产交接 / 指令） |
| **Mission Framework** | Pi 长期承担的 ongoing duty（陪伴 / 监护 / 守护） |

---

## User Flow

1. 装 PiOS → 在 Home 打开 Afterward 模块（密码 + biometric auth）
2. **Onboarding**：选 5 trustee → 生成 Shamir shares → 分发给他们
3. 写 vault 内容（加密 `.enc` 文件：信 / 指令 / brief）
4. 配置 **Actions YAML**（什么 → 给谁 → 怎么送 → 什么时候）
5. 配置 **Missions YAML**（Pi 长期替你做什么）
6. 日常：每天在 UI 输密码做 challenge（抗胁迫 + 抗假死）
7. 定期：每月 /季度自动 time-compressed drill 测试

## Lifecycle

```
ALIVE
  ↓ (60 天被动 heartbeat 全无)
SOFT_INVESTIGATION  ← daemon 开始每日 challenge 推送
  ↓ 同时联系 trustee 让他们准备 share
  ↓ 任何一天你签名回应 → 重置 ALIVE
  ↓ (连续 90 天无签名)
DEATH_CONFIRMED     ← daemon 收 3+ trustee share + 死亡证据
  ↓ 重建 master key
  ↓ 内存里解密 vault
  ↓ 按 Actions + Missions 执行
DONE (Actions 闭环) / ETERNAL (Missions 继续)
```

**总窗口：150 天**（半年）— 极强 false-positive 防御。

---

## 隐私模型

- **用户 own their keys** — Company 绝不持有密码
- **Open-source core** — 任何人可审计（MIT）
- **Self-hostable** — 不信任任何 company 可完全自己跑
- **Optional Cloud** — 付费托管 daemon / trustee 协调 / delivery channel

---

## Pricing Tiers

| Tier | 价格 | 内容 |
|---|---|---|
| **Free** | $0 | self-host，完全自理 |
| **Cloud** | $X/月 | 公司托管 daemon + trustee 协调 + delivery |
| **Legacy Trust** | $XX,XXX 一次 | 含 100 年 endowment，公司保证 N 年 continuity |

**商业模式**：不靠软件本身赚钱，靠 execution services + endowment management。

---

## 目录结构

```
modules/afterward/
  README.md                 # 本文件（产品 spec）
  ARCHITECTURE.md           # 技术架构
  core/                     # Python core
    shamir.py               # Shamir 拆分/重建
    vault.py                # Vault 加密/解密（兼容 obsidian-vault-encryptor）
    heartbeat.py            # 每日 challenge + state machine
    daemon.py               # 主 daemon 进程
  backend/                  # Node bridge → PiOS Electron backend
    afterward-client.js
  renderer/                 # Electron views
    afterward.html
    afterward.js
    afterward.css
  schema/                   # 配置 schema
    actions.example.yaml
    missions.example.yaml
  docs/
    onboarding.md           # 新用户引导
    trustee-guide.md        # trustee 操作手册
    daemon-protocol.md      # 死亡触发协议 spec
    testing.md              # 测试/drill 文档
```

---

## Status

**v0** — owner 自己 dogfooding phase。稳定后开放给其他 PiOS 用户。

See [ARCHITECTURE.md](ARCHITECTURE.md) for implementation details.
