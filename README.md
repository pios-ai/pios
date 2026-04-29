# PiOS

> AI-native personal operating system. 文件系统 + 定时 AI agent + Card 决策接口。
>
> 当前版本：v0.8.0 · macOS arm64

---

## 一句话

你把任务丢进 Cards，PiOS 的 AI agent 按 cron 跑，帮你分类、排期、执行，把需要你决策的节点推回 UI 让你回。所有状态都是 md 文件，多机用 Syncthing 同步。

---

## 它长什么样

**三张图说清楚**：

### 1. Card 生命周期

```
你创建 Card              Plugin 任务自动建 Card
(扔进 inbox/)           (如 scout 发现机会)
      │                         │
      └───────┬─────────────────┘
              ▼
      Cards/inbox/
              │
      triage (每 15 min)
      · 分优先级
      · 匹配 parent
      · 去重
              │
              ▼
      Cards/active/
              │
      work (每 5 min)
      · 选一张卡执行
      · 更新状态
              │
         ┌────┴────┐
         ▼         ▼
      status:    needs_owner:
      done       推到 Home
         │         ↓
         │      你在 UI 点按钮回
         │         │
         │      triage 清 needs_owner
         │         │
         ▼         ▼
      Cards/archive/
```

### 2. 五层架构

| 层 | 谁拥有 | 内容 |
|---|---|---|
| **1. Engine** | PiOS dev | `pios-tick.sh` / adapter / App / Installer / Notifier |
| **2. Core Agents** | PiOS dev | triage / work / sense-maker / reflect |
| **3. Plugins** | Plugin dev | health / wechat / photos / diary / ecommerce / content / intel / browser |
| **4. User Config** | 你 | `pios.yaml` / `BOOT.md` / `alignment.md` / plugin configs |
| **5. Runtime Data** | Pi（AI） | Cards / Log / Output / Memory / State |

详见 [ARCHITECTURE.md](ARCHITECTURE.md)。

### 3. 机器拓扑

```
┌─────────────┐   Syncthing   ┌─────────────┐
│  laptop-host     │ ◀═══════════▶ │ worker-host   │
│  (主机)     │   (Vault)     │  (副机)     │
│             │                │             │
│  PiOS.app   │                │  cron+tick  │
│  cron+tick  │                │  批处理     │
│  全部插件   │                │             │
└──────┬──────┘                └──────┬──────┘
       │      Syncthing               │
       └─────▶ storage-host ◀──────────────┘
              (存储/Immich)
```

单机也能跑，多机是进阶。

---

## 三分钟试：用 welcome card

装完 PiOS 后，你的 Vault 里有一张 `Cards/inbox/welcome-to-pios.md`。最多 15 分钟后：

1. `triage` 会扫到它，搬到 `Cards/active/` 并分优先级
2. `work` 会读它、执行指令
3. 如果 welcome card 让 Pi 问你点什么 → 弹到 Home 的 **Things Need You** 区
4. 你点按钮回 → 卡归档

这就是 PiOS 的最小循环。[→ getting-started.md](docs/user-guide/getting-started.md) 走完整个装机。

---

## 适合谁 · 不适合谁

**适合**：
- 自由职业者 / 一人公司 / Indie Hacker
- 深度 AI 用户（Claude / Codex 每天用）
- 不怕改 yaml / 看 log 的技术用户
- 想要"有记忆的 AI assistant"，不满足 ChatGPT 单会话的人

**不适合**：
- 要完整 SaaS 体验的人（PiOS 是 desktop app，无云端）
- 不装 CLI 的人（需先装 Claude Code CLI）
- Windows / Linux 用户（当前只 macOS arm64）
- 多人协作团队（当前 single-owner）

详见 [positioning.md](docs/product/positioning.md) 和 [user-personas.md](docs/product/user-personas.md) 的 5 种典型用户。

---

## 诚实的能力边界（Known Gaps）

**当前 v0.8.0 已知差距**（详见 [ARCHITECTURE.md §9](ARCHITECTURE.md#9-known-gaps-current--target)）：

| # | 差距 | 影响 |
|---|---|---|
| 1 | 命名不一致:pios / pi-browser / PiOS / PiBrowser 四套写法并存 | 体验不统一 |
| 2 | `renderer/app.js` 7500 行 legacy monolith 无自动化 UI 测试 | 该层 UI 回归靠 owner dogfood + 手动 verify;新 renderer 代码走 `renderer/lib/` UMD + sibling test |
| 3 | DMG 未代码签名 / 未 notarization | macOS Gatekeeper 首启会拦,用户需手动放行 |
| 4 | Setup wizard 需要 Claude Code CLI 预装 | 不是一键安装,用户至少装一次 brew + claude |

### 已解决（v0.7.0 → v0.8.0 期间）

- ✅ **PiOS.app 已内嵌 scheduler**:`main.js` 内置 `setInterval` 每 60s spawn `pios-tick.sh`,含 `powerMonitor.resume` hook 抗笔记本睡眠(不再依赖外部 cron)
- ✅ **Core agent prompts 已参数化**:SOUL.md / characters.yaml / task prompts 全部 `{owner}` 占位符,运行时从 `~/.pios/config.json` 注入
- ✅ **Plugin prompts 已 sanitize**:v0.7.9 把所有 owner-specific 配置从 prompt 移到 plugin config 文件,prompt 里不再硬编码任何具体值
- ✅ **Hostname normalization 已抽 lib**:`backend/lib/host-resolve.js` 单一来源,6 处复制粘贴收敛到一处
- ✅ **Plugin self-registration (Phase 3c, v0.7.10)**:plugin-registry 路由 `triage_hooks` (on_gate / on_ingest),triage 不再硬编码 plugin 逻辑;health / ecommerce / browser / content / diary / intel / location / photos 八个插件已通过 `plugin.yaml` 注册 hook 脚本
- ✅ **Sanitize-lint 体系 (v0.7.10)**:`scripts/sanitize-lint.sh` 重构为 generic pattern engine,pre-commit + pre-push 双 hook 全 history + author/committer email 扫描
- ✅ **Multi-host deploy (v0.7.10)**:`scripts/deploy.sh` config-driven (build → install → vault sync → peer daemon restart → verify),单机用户自动跳过 peer 步骤
- ✅ **Atomic-write helper (v0.7.10)**:`backend/lib/atomic-write.js` 集中 temp+rename 模式,11 处调用迁移
- ✅ **`pios-tick.sh` single SSoT (v0.7.10 plan c)**:Vault `Pi/Tools/` 是唯一 canonical runtime,`backend/tools/` 退化为 build-input-only(经 `npm run prebuild:*` 从 Vault 自动同步),bundle 退化为 bootstrap-source-only;消除"3 份拷贝发散"
- ✅ **Radar agent ship + installer 修干净 (v0.7.11)**:bundle 三个 system agent (pi/pipeline/radar) 全 ship;不再建空目录 `Pi/Agents/maintenance` `Pi/Agents/sense-maker`(它们是 pi 下面的 task);maintenance task 默认 enabled
- ✅ **Voice plugin (v0.7.11)**:`backend/plugins/voice/` 把 qwen-voice 包成 plugin 形式,Resources tab 出现激活按钮,AI 引导用户在自己机器上装 mlx-audio + mlx-whisper + mlx-lm
- ✅ **`pios-tick.sh` 插件自愈 (v0.7.11)**:开发期手工搭的 vault / syncthing 漏同步导致 `vault/Pi/Plugins/<id>/` 缺失时,每次 tick 自动从 bundle 现拷过去(`cp -rn` 不覆盖用户改动)。Resources tab 不再因状态错位看不到激活按钮
- ✅ **Pipeline tasks 默认 disabled (v0.7.12)**:首装阶段 7 个 pipeline task 全部默认 disabled,用户在 Resources/Team 面板按需打开,避免 cron 自动跑消耗 token + 写 vault + 发通知 (issue #4)
- ✅ **mainWindow getter 模式 (v0.7.12)**:installer-bridge IPC handler 不再在注册时刻闭包捕获 mainWindow 值 (那时 BrowserWindow 还没实例化,值是 null);改成 main.js 传 `getMainWindow: () => mainWindow` getter,handler 调用时现取最新引用,修"激活 WeChat 永远报主窗口未就绪" (issue #3)
- ✅ **pios.yaml 错误日志增强 (v0.7.12)**:python yaml 解析失败时把完整 traceback 落到 `~/.pios/logs/config-validation.log`,通知里给出文件路径 + 行号; 区分"已自动回退"(warn) vs "无可回退备份调度暂停"(critical) 两种状态 (issue #2)
- ✅ **Installer fresh-install 修复 (v0.7.13)**:installer step 6 不再因为 dev 路径残留的孤零零 SOUL.md 误判而静默跳过 SOUL/task 复制;`sense.pipelines.*.enabled` 全部默认 false 跟 `agents.pipeline.tasks` 同步;`pios-tick.sh` 自动找带 yaml 的 python，缺失时通知含明确 pip3 install 指令;setup wizard 默认装 voice plugin —— Resources tab 出现 NPC 语音激活按钮
- ✅ **`main.js` 7469 → 497 (-93.3%) + 26 模块 ≤800 (v0.8.0)**:单 entry 退化为 thin shell，逻辑全部下放到 `main/` 26 个职责单一模块;HTTP API 拆成 shell + 5 个 sub-handler;新加 IPC handler 5 步流程见 `main/README.md`
- ✅ **测试基建 (v0.8.0)**:从自制 13-用例 smoke 升级到 `node --test` 框架 + 108 用例 / 22 文件按模块拆,coverage backend pure / lib / main (electron mock) / renderer/lib (UMD + jsdom);GitHub Actions CI matrix node 20+22 跑 sanitize-lint + unit + integration + coverage,pre-commit 跑 unit 子集 ~3s;新模块默认带 sibling `*.test.js`,约定见 `test/CONVENTIONS.md`

**现在能用**:owner 自己每天在用,15+ agent + 9 plugin + 多机拓扑 + 7 pipeline 数据流都在跑。**现在还不能**:一键分发给非技术用户(见上表 #3/#4)。


---

## 四层目标（战略定位）

1. **个人工具**：owner 自用 ← 已实现
2. **一人公司**：一个人 + 一个 PiOS 跑起一家公司 ← 建设中
3. **可分发**：别人能装 ← 建设中（setup wizard 已有；签名未完）
4. **方法论**：文件系统 + agent + 持久 context 的范式

**当前焦点**：3 + 4。详见 [positioning.md](docs/product/positioning.md)。

---

## 目录结构

```
Projects/pios/
├── README.md                     ← 本文
├── ARCHITECTURE.md               ← 五层架构权威
├── INSTALL.md                    ← 安装指南
├── CLAUDE.md                     ← 给开发者的入口
├── main.js + backend/ + renderer/ ← PiOS.app 源码
├── docs/
│   ├── product/                  ← 给潜在用户（你现在读的）
│   │   ├── overview.md
│   │   ├── positioning.md
│   │   └── user-personas.md
│   ├── user-guide/               ← 给装好 PiOS 的人
│   │   ├── getting-started.md
│   │   ├── concepts.md
│   │   ├── daily-flow.md
│   │   ├── configure.md
│   │   └── troubleshoot.md
│   ├── components/               ← 给开发者（架构细节）
│   │   ├── engine.md
│   │   ├── app.md
│   │   ├── core-agents.md
│   │   ├── plugin-system.md
│   │   ├── card-system.md
│   │   └── things-need-you.md
│   └── development.md            ← 变更影响矩阵
```

Pi 的操作细节（给 AI agent 自己看的）：[`Pi/Config/pi-ops-handbook.md`](../../Pi/Config/pi-ops-handbook.md)。

---

## 下一步

- **想了解详情** → [overview.md](docs/product/overview.md)
- **想看定位** → [positioning.md](docs/product/positioning.md)
- **想直接装 .app** → 下载最新 [Releases](https://github.com/pios-ai/pios/releases) 的 DMG（lite 版，无 NPC 语音）+ 读 [INSTALL.md](INSTALL.md)
- **想从源码 build**（含可选 NPC 语音）→ 见下面"从源码 build"段
- **开发者** → [ARCHITECTURE.md](ARCHITECTURE.md) → [CLAUDE.md](CLAUDE.md) → [docs/development.md](docs/development.md)

---

## 从源码 build

```bash
git clone https://github.com/pios-ai/pios.git
cd pios
npm install

# Lite build（无 NPC 语音；外部用户默认走这条）
npm run build:dir          # 出 .app 不打 DMG
# 或
npm run build:dmg          # 出 DMG（~220 MB）

# Full build（含 NPC 语音）：先按 docs/setup-qwen-voice.md 装 qwen-voice
# 装完后再跑 build:dmg；electron-builder.config.js 会自动检测 ~/qwen-voice
# 存在并 bundle 进 .app（~5 GB）
```

build 出的 `.app` 拖到 `/Applications` 打开即可。首次启动 setup wizard 会
装 brew/node/python/claude CLI 并创建你的 Vault（默认 `~/PiOS`）。配置写
在 `~/.pios/config.json`，跨机器多 host 在那里写 `host_map` / `vault_root`
即可，无需 export 环境变量。

---

*v0.8.0 · 2026-04-29 更新 · macOS arm64 · 不保证向后兼容。版本演进见 CHANGELOG.md。*
