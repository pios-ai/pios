# Changelog

All notable changes to PiOS are documented in this file.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
Versioning follows [Semantic Versioning](https://semver.org/).

---

## [0.8.3] — 2026-04-30

**Theme: ship-the-fix gap audit (issue #9 was patched in DMG only, not in OSS source)**

### Fixed
- **issue #9 fix was missing from OSS source**: v0.8.1 claimed to close issue #9 by adding the `command -v openclaw` guard. The fix landed in vault `Pi/Tools/auth-check.sh` (Plan-C SSoT) and the `prebuild` rsync propagated it into `backend/tools/auth-check.sh` at build time, so DMG users got the fix. But routine `git checkout -- backend/tools/` (used to reset the noisy prebuild output before commits) reverted the bundled file to HEAD's state — which never captured the fix. Result: the orphan-squash to OSS shipped the un-patched bundled file. Anyone reading source / rebuilding from `git clone pios-ai/pios` saw the old code.

This release ports the one-line guard directly into `backend/tools/auth-check.sh` so HEAD's tree carries it. Going forward: SSoT-only fixes that need to ship in the bundled copy must be ported manually (no automated way to commit the prebuild output without dragging in owner PII).

---

## [0.8.2] — 2026-04-30

**Theme: hotfix for qwen-voice SIGSEGV on heavy TTS traffic**

### Fixed
- **qwen-voice SIGSEGV under concurrent TTS requests**: `backend/qwen-tts.js`'s `speak()` previously fired N parallel HTTP requests to the qwen-voice service (`Promise.all(textChunks.map(_callTTSAPI))`). mlx-audio's Qwen3-TTS model isn't request-isolated — two concurrent requests sharing the model state would corrupt attention shapes, surfacing first as `ValueError: [broadcast_shapes] (1,1,265,265) and (1,8,265,530) cannot be broadcast` and then crashing the Python process with a `libmlx::core::metal::Device::end_encoding` NULL-pointer deref (SIGSEGV). launchd auto-restarted the service, but the user saw audio gaps and crash dialogs every minute or two during heavy TTS periods. Fix: serialise chunks within `speak()` — `for (const chunk of textChunks) await this._callTTSAPI(...)` — so qwen-voice never sees concurrent requests from a single speak() call. Total wall-time grows from `max(per-chunk)` to `N × per-chunk`, but streaming mode (`onChunk` provided) keeps first-byte latency at `1 × per-chunk`, and audio playback time per chunk is typically ≥ synthesis time, so the user perceives no slowdown. Buffer mode (no callback) now also synthesises serially.
- **`ios/PiOSMobile/Sources/PiOSMobile/PiViewController.swift`** default backend URL: a worker run regenerated the file with a private Tailscale IP as the default. Re-sanitised to `http://localhost:17892`; users override via Info.plist `PiOSBackendURL` (the existing config path).

### Added
- `~/.pios/sanitize-patterns.txt` (owner-side, not committed): pattern for the worker's regenerator IP so it gets caught next time it sneaks back into source.

---

## [0.8.1] — 2026-04-30

**Theme: bug fixes from v0.8.0 install testing (issues #8 + #9)**

### Fixed
- **issue #9 — auth-check.sh false-positive CRITICAL on openclaw-less hosts**: `backend/tools/auth-check.sh` notify section (line 251) was missing the `command -v openclaw >/dev/null 2>&1` guard that the `update_engine_status` section (line 200) already had. Result: any user who didn't install openclaw received a CRITICAL "weixin channel not OK" notification every hour, forever. Fix: add the same guard to the notify line so openclaw is treated as N/A when not installed. Vault `Pi/Tools/auth-check.sh` is the SSoT (per Plan-C); fix lands there and prebuild syncs to `backend/tools/`.
- **issue #8 — TTS long-text first-byte latency**: `backend/qwen-tts.js`'s `speak()` previously did `await Promise.all(chunks)` then merged → returned one buffer to renderer, so a multi-chunk reply (long Pi response) had ~N × per-chunk-time silent wait before audio started. Fix: `speak()` now accepts an `onChunk` callback; when provided, each chunk's filtered WAV is emitted in-order as soon as synthesis completes (synthesis stays parallel for unchanged total wall-time). `main/ipc-handlers/voice.js` wires the callback to `voice:tts:chunk` IPC events; renderer's existing `AudioQueue` enqueues each chunk for sequential playback. First-byte latency drops from `N × per-chunk` to `1 × per-chunk`. Trade-off: voice filter applied per-chunk in streaming mode (echo continuity across chunk boundaries is slightly broken), accepted as worthwhile UX trade. Buffer-mode (when `onChunk` is omitted) is unchanged.

### Changed
- **`preload.js`**: new `onVoiceTTSChunk(callback)` exposes the `voice:tts:chunk` IPC event to the renderer.
- **`renderer/app.js` `playTTS()`**: no longer enqueues the IPC return value; chunks arrive via the new event and self-enqueue into `AudioQueue`.
- **`mobile-backend/server.js`**: hardcoded owner / hostname / Tailscale IP literals replaced with `~/.pios/config.json` lookups + `PIOS_OWNER_NAME` / `PIOS_HOST` env overrides + `os.hostname()` fallback. (Worker output cleanup; not a user-visible change but unblocks OSS push.)

---

## [0.8.0] — 2026-04-29

**Theme: test infrastructure overhaul + OSS-safe-by-default development workflow**

### Added
- **`node --test` framework migration**: replaced the single 13-case custom-harness smoke (`test/p6-smoke-test.js`) with the built-in node:test runner across 22 per-module files. **108 tests** total covering `backend/*` pure modules, `backend/lib/*`, `main/*` (via electron mock), `main/ipc-handlers/*`, and `renderer/lib/*` (via jsdom).
- **GitHub Actions CI** (`.github/workflows/ci.yml`): node 20 + 22 matrix, runs sanitize-lint + unit + integration + a separate `--experimental-test-coverage` job + a full-history sanitize scan. Triggered on push and PR to main.
- **Electron mock layer** (`test/helpers/electron-mock.js`): patches `Module._resolveFilename` so `require('electron')` inside tests resolves to a stub. `useElectronMock()` provides a fresh mkdtemp `userData` per suite. Unlocks unit tests for `main/session-manager`, `main/installer-bridge`, `main/ipc-handlers/*`.
- **`renderer/lib/`** UMD module pattern for new renderer code (`format-helpers.js`, `dom-helpers.js` as canonical examples). Pure helpers test via `node --test`; DOM-using helpers test via jsdom (factory takes `document`). `renderer/app.js` legacy monolith stays dogfood-validated — see Known Gaps #2.
- **`.githooks/commit-msg`**: scans the commit message text for owner-specific PII patterns (mirrors `sanitize-lint --staged-only` for messages). Override via `PIOS_LINT_ALLOW=label1,label2`.
- **`docs/oss-safe-coding.md`**: pattern guide explaining the three layers of enforcement (file content / commit message / author email), helpers to use instead of literals, and how to handle legitimate references.
- **`test/CONVENTIONS.md`**: when to write what kind of test, test-file naming maps to source-file naming, fixture vs temp-vault helpers, jsdom + UMD patterns for renderer.

### Changed
- **`main.js` reduced from 7469 to 497 lines**, code split into 26 single-responsibility modules under `main/` (each ≤800 lines). New IPC handlers follow the 5-step flow in `main/README.md`. `node --check` does not catch missing imports — endpoint smoke tests are now part of every PR.
- **`backend/pi-greet.js` + `backend/vault-context.js`**: renamed `_readAbeProfile` / `getAbeProfileContext` → `_readOwnerProfile` / `getOwnerProfileContext`; resolve owner name via `getOwnerName()` and build paths as `<vault>/<owner>/Profile/<owner>_Profile.md`. Works for any installer-configured owner, not just the dev's own vault.
- **`backend/pi-chitchat.js`** Phase 2 silence-aware energy gate: when Pi knows the owner has been silent ≥4h (silence Phase 1 data in `pi-social.json`), the energy threshold drops on a ladder (`light` → 0.4, `medium` → 0.3, `deep` → 0.0) so Pi can proactively reach out. Still routes via `proposeIntent → triage` and still passes all other gates (presence / quiet_until / last_interaction / frequency).
- **`scripts/send-daily-todos.py`**: `parse_date` now checks `isinstance(val, datetime)` before `isinstance(val, date)` (datetime is a subclass of date — old order returned datetime values verbatim, then `<` against `date.today()` raised TypeError). `collect_todos` mirrors the UI's `_todoScheduleDate` logic so the cron-mailed list matches MyTODOs.
- **Local repo `.git/config`**: committer identity for new commits in this clone is `PiOS Contributors <noreply@pios-ai.org>`. Eliminates the need for orphan-squash to rewrite commit author at push time.
- **`backend/plugins/voice/plugin.yaml`** `success_marker` no longer requires `{pios_home}/voice/activated.json`. Pre-existing qwen-voice installs (set up before AI activation flow existed) now correctly show as 已激活 once `~/qwen-voice/bin/python3.12` + `app.py` exist.
- **`main/installer-bridge.js`** plugin-list IPC adds task-enabled fallback: when `success_marker` file check doesn't pass, the plugin is considered activated if any of its associated tasks (own `tasks:` or `sense.pipelines.requires=[pluginId]`) is `enabled: true` in `pios.yaml`. Fixes wechat / health / photos showing 待激活 despite the data flow running daily.

### Documentation
- README + ARCHITECTURE Known Gaps refreshed: the "thin test coverage / no CI" gap is retired (CI + 108-test suite landed). New gap #2 is the `renderer/app.js` legacy monolith (dogfood-validated, not auto-tested) — Playwright deliberately deferred per the trade-off discussion.
- `ARCHITECTURE.md` / `CLAUDE.md` / `docs/components/app.md` / `docs/components/engine.md` / `docs/pi-npc.md` synced to reflect post-split paths and new module structure.

---

## [0.7.14] — 2026-04-29

**Theme: main.js 7469→497 line refactor + plugin activation polish**

### Changed
- **`main.js` reduced from 7469 to 497 lines**, code split into 26 single-responsibility modules under `main/` (each ≤800 lines). New IPC handlers must follow the 5-step flow documented in `main/README.md`. `node --check` does not catch missing imports — endpoint smoke tests are now part of every PR.
- **`backend/plugins/voice/plugin.yaml`** `success_marker` no longer requires `{pios_home}/voice/activated.json`. Pre-existing qwen-voice installs (set up before AI activation flow existed) now correctly show as 已激活 once `~/qwen-voice/bin/python3.12` + `app.py` exist.
- **`main/installer-bridge.js`** plugin-list IPC adds task-enabled fallback: when `success_marker` file check doesn't pass (or absent), the plugin is considered activated if any of its associated tasks (own `tasks:` or `sense.pipelines.requires=[pluginId]`) is `enabled: true` in `pios.yaml`. Fixes wechat / health / photos showing 待激活 despite the data flow running daily.

### Documentation
- `ARCHITECTURE.md` / `CLAUDE.md` / `docs/components/app.md` / `docs/components/engine.md` / `docs/pi-npc.md` synced to reflect post-split paths and new module structure.

---

## [0.7.13] — 2026-04-29

**Theme: fresh-machine install fixes (live-debugged via SSH on a second mac)**

### Fixed
- **Installer step 6 silently skipped agent SOUL + task copy on fresh install** — the priority list `[__dirname/Pi/Plugins/core, BUNDLED_CORE_DIR]` matched a stale dev path (`~/pios/Pi/Plugins/core/` with only a stray `SOUL.md`), so `fs.existsSync(corePluginSrc/agents/pi/SOUL.md)` returned false and the loop skipped. Result: `Pi/Agents/pi/` empty after install, Tasks tab empty. Fix: BUNDLED_CORE_DIR primary, plus `existsSync` checks the **payload file** (`agents/pi/SOUL.md`), not just the directory.
- **`sense.pipelines.*.enabled` defaults out of sync with `agents.pipeline.tasks.*.enabled`** — issue #4 fix only flipped the latter to `false`. The former still seeded `enabled: true` for ai-diary / diary-engine / user-status / world-feed and `hasPlugin('xxx')` for the others. Result: Tasks tab showed disabled, Team / Pi / Pipeline tab showed enabled — visibly inconsistent. Fix: all 7 `sense.pipelines.*.enabled = false` to match.
- **`pios-tick.sh` used `/usr/bin/python3` (system 3.9) but `deps-install.js` installs PyYAML into brew `python@3.12`** — fresh users got a red "pios.yaml 格式错误" bubble even though the file was fine. Fix: pios-tick.sh now picks the **first python in $PATH that already has yaml installed** (brew 3.12 → brew 3 → system 3); if none, surfaces a clear `pip3 install pyyaml` instruction in the notify bubble instead of "fail: python error".
- **`renderer/app.js` setup wizard didn't include `voice` in default plugins** — Resources tab shipped without the NPC voice activation button on fresh installs (issue #5 partially). Added `voice` to the default plugin list, wechat-style activation flow now applies (Pi guides install via PiBrowser sidebar conversation).

---

## [0.7.12] — 2026-04-29

**Theme: post-v0.7.11 issues fixed**

### Changed
- **Pipeline tasks default to disabled** (issue #4): all 7 seeded pipeline tasks (`daily-ai-diary`, `daily-diary-engine`, `daily-health`, `daily-photo-diary`, `daily-user-status`, `daily-wechat-digest`, `daily-world-feed`) are now `enabled: false` on a fresh install. Users opt in from the Resources / Team panel.
- **`main.js` slimmed**: 7124-line monolithic main.js refactored to 2938 lines; functional code lives in `main/voice-runtime`, `main/installer-bridge`, `main/ipc-handlers/*`, `main/agent-mode`, etc. The submodules were already shipped in v0.7.10 (issue #1 fix); this commit completes the deduplication.

### Fixed
- **WeChat plugin activation** (issue #3): `main/installer-bridge.js` now resolves `mainWindow` at IPC handler call time via `getMainWindow()` getter rather than capturing the value at register time (when the `BrowserWindow` is still `null` because module-level wiring runs before `app.whenReady`). Activating WeChat / voice plugins from the Resources tab no longer fails with "PiOS 主窗口未就绪".
- **`pios.yaml` validation diagnostics** (issue #2): `pios-tick.sh` writes the full python traceback to `~/.pios/logs/config-validation.log` (rolling 500-line buffer), surfaces line/column when YAMLError exposes them, and distinguishes "auto-rolled-back" (warn bubble) from "no backup, scheduler paused" (critical bubble).

---

## [0.7.11] — 2026-04-29

**Theme: third system agent + voice plugin + plugin self-heal**

### Added
- **Radar agent shipped**: `backend/plugins/core/agents/radar/SOUL.md` is now part of the bundle. With `pi` and `pipeline`, all three system agents declared in `pios.yaml` are present after a fresh install (radar ships SOUL only; users add radar tasks themselves).
- **Voice plugin (`backend/plugins/voice/`)**: packages `qwen-voice` (NPC clone-voice TTS + local ASR via MLX) as an optional plugin. Resources tab now surfaces a "NPC 语音引擎" activation button; clicking opens a PiBrowser sidebar conversation where Pi guides the user through installing the local MLX stack on Apple Silicon.
- **Plugin self-heal in `pios-tick.sh`**: when `~/.pios/config.json` lists a plugin ID but `vault/Pi/Plugins/<id>/` is missing, each tick copies the plugin from the bundle into the vault using `cp -rn`. Recovers from dev-built vaults, syncthing drift, and partial installs without overwriting user edits.

### Changed
- **`maintenance` task is now enabled by default** in the seeded `pios.yaml`. Joining `triage` and `work` as the three Kernel tasks running on a fresh install.
- **Installer drops vestigial empty agent dirs**: `Pi/Agents/maintenance/` and `Pi/Agents/sense-maker/` are no longer created by the install wizard. They are tasks under `pi`, not standalone agents — the dirs were carrying nothing but ghost entries in the Agents tab. `Pi/Agents/radar/` is created in their place.
- **Installer's `standardAgents` list expanded** to `['pi', 'pipeline', 'radar']` so radar's SOUL is provisioned to the vault on fresh install.

---

## [0.7.10] — 2026-04-29

**Theme: Phase-3c plugin migration + sanitize hardening + multi-host deploy**

### Added
- **Phase-3c plugin self-registration**: `plugin-registry` routes triage hooks (`on_gate` / `on_ingest`) instead of hardcoded plugin paths. health, ecommerce, browser, content, diary, intel, location, photos plugins ship `triage-gate` + `triage-ingest` hook scripts via `plugin.yaml`. New plugins now extend triage by adding hooks, not by editing the core prompt.
- **`scripts/deploy.sh`**: config-driven multi-host deploy script (build → install → vault sync → peer daemon restart → verify). Driven by `~/.pios/config.json` `deploy` section (peer SSH target, peer vault path, daemon list); auto-skips peer steps for single-host users.
- **`backend/lib/atomic-write.js`**: centralised temp-file + rename helper; 11 call sites migrated.

### Changed
- **`scripts/sanitize-lint.sh`** refactored into a generic pattern engine + extra-patterns; now runs as both pre-commit hook (staged additions) and pre-push hook (full history + tag messages + author/committer emails) when pushing to `pios-ai*` remotes.
- **pios-tick.sh single SSoT (plan c)**: Vault `Pi/Tools/` is the canonical runtime; `Projects/pios/backend/tools/` is build-input-only (auto-synced from Vault via `npm run prebuild:*`); bundle is bootstrap-source-only. `install-app.sh` no longer reverse-syncs bundle → vault.

### Fixed
- **Scheduler**: `powerMonitor.resume` hook closes deep-night scheduler gap.
- **WeChat aggregator**: cross-process lock + redirected/pending dedup.

---

## [0.7.9] — 2026-04-28

**Theme: voice-as-subject Phase 6 + WeChat self-dedup fix**

### Changed
- **voice-as-subject Phase 6**: Relationship stance extracted to a standalone file (`Pi/Config/relationship-stance.md`); pure-execution workers (work / hawkeye / radar / pipeline / maintenance) no longer load it — saves tokens and prevents stance from bleeding into structured output.

### Fixed
- **WeChat aggregator**: `_recentlySpokenTexts` now excludes pending/redirected entries, fixing self-dedup false positives.

---

## [0.7.8] — 2026-04-27

**Theme: voice-as-subject Phase 1–2 + scheduler resume hook + WeChat cron path**

### Added
- **voice-as-subject Phase 1**: `fireReflex` entry-point split — non-time-sensitive sources route into a deferred pool awaiting judge.
- **voice-as-subject Phase 2**: `executeDecision` supports `rewrite / tone / merge / defer` actions; speak-log records tone.

### Fixed
- **Scheduler**: `pios-tick setInterval` now hooks `powerMonitor.resume`, eliminating late-night scheduling gaps when the laptop sleeps.
- **WeChat**: cron path restored through aggregator; cross-process lock + `execSync` 30s timeout prevents false hangs.
- **Profile P4**: pending-items list reads correctly when empty; diff UX legibility improved.

---

## [0.7.7] — 2026-04-26

**Theme: PiOS process chaos firewall — three gates against orphaned-worker buildup**

### Fixed
- **Process management**: three-stage gate prevents orphaned worker accumulation that was destabilising long-running sessions.

---

## [0.7.6] — 2026-04-26

**Theme: NPC bubble pointer-events + Claude OAuth isolation + report→WeChat hard gate**

### Added
- NPC PNG sprites: peppa, shinchan, trump (with bubble.html PNG CSS).

### Fixed
- **NPC bubble**: pointer events now pass through transparent regions correctly.
- **Xiaojiang lightball**: visual artefact fixed.
- **Claude OAuth**: child Claude/Codex CLI processes now spawn with stripped `CLAUDE_CODE_OAUTH_TOKEN` / `ENTRYPOINT` / `CLAUDECODE` env, preventing 401 from token reuse.
- **Notifications**: report→WeChat path now hard-gates by severity (no more accidental flooding).
- **WeChat aggregator**: disk-level instrumentation added for "message not received" debugging.

---

## [0.7.5] — 2026-04-25

### Fixed
- Q&A voice sessions: truly suppress background TTS during active conversations
- Restore Profile / Claude / Notifications cleanup from a prior session rollback
- Setup: eliminate TTS audio bleeding into setup wizard screens

### Changed
- Bento widgets fully restored after kernel refactor
- WeChat plugin activation migrated to PiBrowser-native flow (no external browser needed)

---

## [0.7.4] — 2026-04-25

### Changed
- Plugin activation flow moved entirely into PiBrowser (no external browser window)
- Bento widget layout restored post-kernel-refactor
- Setup wizard: fix TTS audio bleeding across screens

---

## [0.7.3] — 2026-04-25

### Added
- Voice input mode: F5 key and bubble tap toggle Pi into voice-only conversation
- WeChat aggregator: three-channel trigger strategy eliminates late-night silence issue
- Bento widget: Overview upgraded from 5-card list to drag-resize bento grid

### Fixed
- pi-speak: triage gate dropping LLM text — now synthesizes from card brief
- pi-speak: triage snapshot dashboards archived silently (no longer sent to owner)
- pi-speak: dedup recognises `[card-id]` bracket notation
- WeChat: 10-minute idempotency window prevents message flooding
- Codex adapter: `_fa` scoping error and missing turn-end publish block
- Bubble + TTS: literal 2-byte `\n` sequence normalised to real newlines
- Proactive queue: hostname normalisation fixed for macOS

### Changed
- Kernel architecture corrected: 1 agent `pi` + 12 task model (replaces previous multi-agent split)
- WeChat plugin activation now handled via AI-mediated session (no manual wxid entry)
- Setup wizard slimmed down; heavy initialisation deferred to post-setup

---

## [0.7.2] — 2026-04-17

### Added
- NPC skin architecture: pluggable skins (Patrick Star, Doraemon, 3-D starlet via Three.js)
- Direction tab: real-time heat bars showing investment intensity per goal area, SSE live refresh
- NPC consciousness stream: activity ticker anchored below NPC, synced with home dashboard

### Removed
- Home/Cards tab: functionality fully covered by Direction + Operation views

### Fixed
-派大星 (Patrick) NPC: TTS dual-voice, background session `<say>`, mouth animation
- pi-pulse: card file change events now feed into NPC activity stream correctly

---

## [0.7.1] — 2026-04-17

### Added
- **Distributable build**: PiOS can now be installed on any Mac without hardcoded paths
- Host-config-driven architecture: all machine-specific values read from `pios.yaml`
- Atomic YAML write: config updates are crash-safe (write-temp → rename)
- Absorbed pios-oss Python reference articles into repo (`docs/`)
- Hugo documentation site merged into main repo

### Changed
- De-personalised default configuration: installer prompts for owner name, vault path, and host info
- `characters.yaml`: NPC address strings parameterised as `{owner}` (most NPCs)

---

## [0.7.0] — 2026-04-16

### Added
- Initial release: PiOS.app — Electron-based AI-native personal operating system
- Core PiBrowser with tabbed interface (Home, Operation, Direction, Pi tab)
- Pi kernel: background AI agent loop (triage / work / sense-maker / reflect)
- NPC layer: character-driven TTS + bubble overlay
- Cards system: inbox → active → archive lifecycle managed by Pi
- WeChat integration: read and send via openclaw bridge
- Claude Code + Codex CLI adapters
- pios-installer: guided first-run setup wizard

---

*This CHANGELOG covers the Electron-based PiOS app (v0.7.x series, April 2026 onwards).*
*Earlier Python-based prototypes are archived in the pios-oss repository.*
