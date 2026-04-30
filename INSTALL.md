# PiOS Install Guide

This guide covers the current PiOS v0.8.3 macOS install flow for new users.

## Current Scope

- Platform: macOS arm64 (Apple Silicon)
- Preferred public artifact: `PiOS-0.8.3-arm64.dmg` after a verified successful build
- Stable maintainer fallback on this host: `npm run build:dir` for a fresh `.app` without DMG creation
- App bundle: `PiOS.app`
- First-run setup: built into the app

## Before You Start

Just drag `PiOS.app` into `/Applications` and open it. **The first-run Setup Wizard detects missing dependencies and installs them for you** (Xcode Command Line Tools → Homebrew → Node.js → Python 3.12 → Claude CLI). You only need to:

- Approve the macOS dialog when Xcode Command Line Tools asks to install (5-15 min download)
- Enter your macOS login password when Homebrew requests administrator privileges (one native password prompt)
- Run `claude auth login` in Terminal once the Claude CLI step shows "installed" (browser OAuth; one-time)

Optional (the Setup Wizard doesn't gate on these):

- Codex CLI if you want to enable it in setup
- Browser / WeChat / Health / Photos plugins if your local environment already supports them

If you prefer to install deps yourself before opening PiOS, the manual commands are:

```bash
xcode-select --install                              # Xcode CLT (system dialog)
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"   # Homebrew
brew install node python@3.12
npm install -g @anthropic-ai/claude-code && claude auth login
```

## Voice Engine (qwen-voice) — optional

NPC voice is provided by a local service called **qwen-voice** (Qwen3-TTS +
whisper-large-v3-turbo + qwen3 LLM, all on MLX). It is **not part of the
PiOS repository** — it's a separate stack assembled from open-source MLX
projects.

There are two builds:

| Build | How | What you get |
|---|---|---|
| **Lite** (default for `npm run build:dir` / `build:dmg`) | No setup needed | ~220 MB DMG; PiOS core works; NPC bubbles show text but **no audio** |
| **Full** (maintainer-style) | Install qwen-voice locally first (see [docs/setup-qwen-voice.md](docs/setup-qwen-voice.md)), then re-run the same build commands | ~5 GB DMG; full NPC voice cloning, TTS, ASR |

[`electron-builder.config.js`](electron-builder.config.js) detects whether
`~/qwen-voice/` and the relevant HuggingFace MLX caches are present. If yes,
they get bundled into `.app/Contents/Resources/`; if not, the build silently
goes lite. Either path produces a working app.

**Lite build runtime behaviour**: `PiOS.app` logs `[qwen-voice] not found in
any candidate path — NPC voice disabled` and the rest of the app runs
normally. Cards, triage, work, chat, PiBrowser are all unaffected.

**Full build voice setup**: see [docs/setup-qwen-voice.md](docs/setup-qwen-voice.md)
for installing qwen-voice locally before building.

Cleaning up: `launchctl remove` is not used. Killing `PiOS.app` triggers
`will-quit` which calls `qwenVoiceProc.kill()`.

## Known Limitations

- The bundled installer now includes the core pipeline task prompts needed by the default `sense` manifest.
- The app is not code-signed yet.
- The app is not notarized yet.
- macOS Gatekeeper may block the first launch of the DMG-installed app.
- Claude Code CLI is not auto-installed by PiOS; you must install it yourself first.
- Homebrew Python 3.12 is not auto-installed by PiOS; without it NPC voice is silent (other features unaffected). A future release will ship a standalone Python runtime to remove this dependency.
- Fresh local `npm run build` is currently not stable for DMG output on this host: `electron-builder` can finish `dist/mac-arm64/PiOS.app` but may fail at `hdiutil create` while an older `dist/PiOS-0.8.3-arm64.dmg` still remains in `dist/`.
- On this host, the failure is broader than PiOS packaging: minimal `hdiutil create -size 20m` commands fail for both APFS and HFS+ images with `设备未配置`.
- Use `npm run build:dir` when you need a fresh `.app` for installer or bundle-content validation without depending on `hdiutil`.
- Maintainer local verification on 2026-04-22: calling `pios-installer.install(...)` under a temporary HOME created `~/.pios/config.json`, `~/.pios/tools/`, `Cards/inbox/welcome-to-pios.md`, and `Pi/Config/pios.yaml`; the built `PiOS.app` process also stayed alive past a 3-second smoke check.

## Install Steps

1. Obtain a verified PiOS build for your platform.
2. If you have a verified DMG, open `PiOS-0.8.3-arm64.dmg` and drag `PiOS.app` into `/Applications`.
3. If you are validating a local build from this host, run `npm run build:dir` and copy `dist/mac-arm64/PiOS.app` into `/Applications` directly instead of trusting a leftover `dist/PiOS-0.8.3-arm64.dmg`.
4. Install Claude Code CLI:

```bash
npm install -g @anthropic-ai/claude-code
```

5. Launch `PiOS.app`.
6. On first launch, complete the setup wizard:
   - `Your name`
   - `Vault location` or leave it empty to use `~/PiOS`
   - `AI Runtime`: `Claude Code CLI` is enabled by default, `Codex CLI` is optional
   - `Plugins`: `Vault`, `Shell`, and `Web Search` are core; `Browser`, `WeChat`, `Apple Health`, and `Photos` are optional
7. Click `Install PiOS`.
8. Wait for the success screen that shows the created vault path.
9. Click `Start Using PiOS`.

## What PiOS Creates

During setup, PiOS creates:

- `~/.pios/config.json`
- `~/.pios/tools/`
- A new Vault folder, defaulting to `~/PiOS`
- Core folders such as `Cards/`, `Pi/`, `Projects/`
- `Pi/Radars/`
- `{owner}/Scratch/` and `{owner}/Scratch/attachments/`
- A starter card at `Cards/inbox/welcome-to-pios.md`

## First-Run Verification

After setup, verify these signals:

- The setup overlay disappears after you click `Start Using PiOS`
- The selected vault path now exists
- `~/.pios/config.json` exists and contains your `owner_name` and `vault_root`
- `Cards/inbox/welcome-to-pios.md` exists inside the new vault
- `~/.pios/tools/pios-tick.sh` exists

## Troubleshooting

### PiOS does not open after drag-install

- Move the app into `/Applications` if you launched it directly from the DMG or from `dist/mac-arm64/`.
- If macOS blocks the app, remove the quarantine flag manually or open it from System Settings after the first block prompt.

### Setup succeeds but no agent work appears

- Check whether `~/.pios/config.json` was created.
- Check whether the selected vault path contains `Cards/inbox/welcome-to-pios.md`.
- Confirm Claude Code CLI is installed and available in `PATH`.

### I want to use a custom vault location

Enter the full path in the setup wizard. If left blank, PiOS uses `~/PiOS`.

## Maintainer Notes

- Build command:

```bash
npm run build:dir
```

- DMG-only command when you specifically need a publishable installer:

```bash
npm run build:dmg
```

- Current build output:
  - `dist/mac-arm64/PiOS.app` is the reliable output from the current host build.
  - `dist/PiOS-0.8.3-arm64.dmg` may already exist from an earlier successful build; do not treat its presence alone as proof that the latest build completed.
  - Re-verify the latest `npm run build` or `npm run build:dmg` log before publishing a DMG. A successful run must get past the `hdiutil create ... 0.dmg` step without the `unable to execute hdiutil` error.
  - For a maintainer smoke test that bypasses DMG, validate both the installer and app process separately: run `pios-installer.install(...)` under a temporary HOME, then launch `dist/mac-arm64/PiOS.app/Contents/MacOS/PiOS` and confirm it stays alive for a few seconds.

- Public distribution is not ready until signing and notarization are in place.
- On this host, DMG generation is still blocked by a host-wide `hdiutil create` failure (`设备未配置` even for minimal APFS and HFS+ test images); use `npm run build:dir` and the built `.app` for bundle-level verification until that is resolved.
