# Changelog

All notable changes to PiOS are documented in this file.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
Versioning follows [Semantic Versioning](https://semver.org/).

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
