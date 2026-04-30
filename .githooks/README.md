# Git Hooks

Repo-managed git hooks（入 git 跟踪，新 clone 带）。

## 启用

一次性在本 repo 根目录跑：

```bash
git config core.hooksPath .githooks
```

之后 git 会从 `.githooks/` 而不是默认的 `.git/hooks/` 读 hook。

## 现有 hooks

### `pre-commit` · P6 smoke test

触发条件：staged files 里有 `backend/pi-chitchat.js` / `backend/pi-greet.js` / `backend/pi-route.js` / `backend/presence.js` / `backend/pi-pulse.js` / `main.js` / `test/p6-smoke-test.js` 任一改动。

行为：运行 `node test/p6-smoke-test.js`，11 项 assertion 必须全绿。任何一项 FAIL → 阻止 commit。

绕过：`git commit --no-verify`（紧急时用；事后必须补测，commit message 里注明原因）。

起因：2026-04-19 Phase 6A，`pi-route.sendLocalBubble` 用了 `pios:talk` 通道的坑差点上线 evening-brief（owner 逼我跑 smoke test 才抓到）。今后所有相关模块改动必须过测试再 commit。

## 新 hook 怎么加

1. 在 `.githooks/` 下新建文件（例如 `pre-push`）
2. `chmod +x .githooks/your-hook`
3. `git add .githooks/your-hook` 入仓
4. 提交；队友 pull 后 `git config core.hooksPath .githooks` 一次性生效

## 规则

- 慢的 hook（> 3s）不要放 `pre-commit`——放 `pre-push` 或 CI
- hook 里避免依赖 node_modules 之外的命令（不是每个人环境一样）
- `set -e` 保证任何命令失败立刻 exit 非 0
