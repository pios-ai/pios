# PiOS Milestone 1 - Task Breakdown
**Goal**: Core architecture + migrate existing 4 pipelines
**Estimated effort**: 4-6 weeks with AI-assisted coding

---

## Phase 1: Project Skeleton (Week 1)

### 1.1 Repository Setup
- [ ] Initialize git repo with `.gitignore`, `LICENSE` (MIT), `pyproject.toml`
- [ ] Set up monorepo structure:
  ```
  pios/
  ├── backend/          # Python FastAPI
  ├── frontend/         # React + Vite
  ├── plugins/          # Built-in plugins
  ├── docker/           # Docker configs
  └── docs/             # Documentation
  ```
- [ ] Configure pre-commit hooks (ruff, black, mypy)
- [ ] Set up GitHub Actions CI (lint + test)

### 1.2 Backend Foundation
- [ ] FastAPI app with health check endpoint (`GET /api/status`)
- [ ] Configuration system (`pios/core/config.py`)
  - YAML config loader with env var interpolation
  - Default config generation on first run
  - Config validation with Pydantic
- [ ] Logging framework (structured JSON logs)
- [ ] SQLite database setup with migrations (alembic)
  - `documents` table
  - `plugin_runs` table
  - `plugin_configs` table

### 1.3 Frontend Foundation
- [ ] React + Vite + Tailwind project setup
- [ ] Layout shell: sidebar navigation + main content area
- [ ] Dashboard page (placeholder with system status)
- [ ] API client utility (axios/fetch wrapper)

### 1.4 Dev Environment
- [ ] `Makefile` with targets: `dev`, `test`, `lint`, `build`, `docker`
- [ ] `docker-compose.dev.yml` for development
- [ ] Hot-reload for both backend and frontend

**Phase 1 Deliverable**: `pios start` launches API + UI, dashboard shows "system running"

---

## Phase 2: Plugin Framework (Week 2)

### 2.1 Plugin SDK
- [ ] Base classes: `SourcePlugin`, `AgentPlugin` in `pios/sdk/`
- [ ] `PluginContext` class (provides logger, llm, document_store to plugins)
- [ ] `Document` data model with YAML frontmatter serialization
- [ ] `RawData` container class

### 2.2 Plugin Manager
- [ ] Plugin discovery from directory (`~/.pios/plugins/`)
- [ ] `plugin.yaml` manifest parser and validator
- [ ] Plugin lifecycle: install → configure → enable → run
- [ ] Plugin dependency resolution (install pip requirements)
- [ ] Run history tracking in SQLite

### 2.3 Scheduler Engine
- [ ] APScheduler integration with FastAPI
- [ ] Cron schedule support from `plugin.yaml`
- [ ] Manual trigger via API (`POST /api/plugins/{name}/run`)
- [ ] Concurrent execution limiter
- [ ] Retry logic with exponential backoff

### 2.4 LLM Engine
- [ ] LiteLLM wrapper in `pios/core/llm.py`
- [ ] Config-driven model selection
- [ ] Simple completion + structured output (Pydantic)
- [ ] Fallback chain (try model A → fall back to model B)
- [ ] Token usage tracking

### 2.5 Document Store
- [ ] File-based vault manager (write Markdown with frontmatter)
- [ ] SQLite index: auto-index on document create/update
- [ ] Date-based directory organization (`YYYY/MM/DD/`)
- [ ] Content hash for deduplication
- [ ] Query API: by date, source, type, tags

**Phase 2 Deliverable**: Can create a "hello world" source plugin that produces a document

---

## Phase 3: Migrate Source Plugins (Week 3-4)

### 3.1 source-apple-health
**Migrating from**: Current `daily-health-digest` scheduled task

- [ ] Create `plugins/source-apple-health/plugin.yaml`
- [ ] Implement `fetch()`: locate Health Auto Export JSON, handle iCloud sync (`brctl download`)
- [ ] Implement `normalize()`: parse JSON metrics, apply anomaly thresholds, generate Markdown
- [ ] Port anomaly detection logic (blood oxygen < 93%, steps < 3000, etc.)
- [ ] Port day-over-day comparison logic
- [ ] Config: `export_dir`, `metrics` list, anomaly thresholds
- [ ] Tests with sample health JSON data

### 3.2 source-wechat
**Migrating from**: Current `daily-wechat-digest` scheduled task + Python scripts

- [ ] Create `plugins/source-wechat/plugin.yaml`
- [ ] Port `decrypt_backup.py` → `decrypt.py` (AES-256-CBC SQLCipher decryption)
- [ ] Port `gen_wechat_md.py` → `fetch()` + `normalize()`
- [ ] Port message type mapping (text, image, voice, video, etc.)
- [ ] Port media file linking logic (video by timestamp+size, files by name)
- [ ] Implement summary generation with LLM engine
- [ ] Config: `db_dir`, `media_dir`, `my_wxid`, contacts filter
- [ ] Tests with mock decrypted data

### 3.3 source-immich
**Migrating from**: Current `daily-photo-diary` scheduled task

- [ ] Create `plugins/source-immich/plugin.yaml`
- [ ] Implement `fetch()`: HTTP API to Immich instance
- [ ] Implement `normalize()`: extract EXIF, GPS, generate photo diary with LLM
- [ ] Port EXIF extraction (PIL for standard, binary regex for HEIC/CR2)
- [ ] Port GPS coordinate processing and reverse geocoding
- [ ] Config: `immich_url`, `api_key`
- [ ] Tests with sample Immich API responses

### 3.4 source-chatgpt
**Migrating from**: Current `chatgpt-daily-diary` scheduled task

- [ ] Create `plugins/source-chatgpt/plugin.yaml`
- [ ] Implement `fetch()`: strategy for getting ChatGPT conversation data
  - Option A: Browser automation (current approach, fragile)
  - Option B: ChatGPT export file parsing (more reliable)
  - Option C: API-based if available
- [ ] Implement `normalize()`: generate daily digest from conversations
- [ ] Config: `fetch_method`, relevant parameters per method
- [ ] Tests with sample conversation data

**Phase 3 Deliverable**: All 4 sources produce the same Markdown output as current system

---

## Phase 4: Agent Plugins + Web UI (Week 4-5)

### 4.1 agent-daily-digest
- [ ] Create `plugins/agent-daily-digest/plugin.yaml`
- [ ] Implement `run()`: query today's documents from all sources
- [ ] LLM prompt to fuse health + chat + photo data into unified daily summary
- [ ] Output: one consolidated `daily-digest.md` per day
- [ ] Schedule: runs after all source plugins complete (event-triggered or late-night cron)

### 4.2 agent-health-monitor
- [ ] Create `plugins/agent-health-monitor/plugin.yaml`
- [ ] Implement `run()`: analyze health document, detect anomalies
- [ ] Generate alert document when thresholds exceeded
- [ ] (M2 prep) Hook for future notification system

### 4.3 Web UI - Plugin Manager Page
- [ ] Plugin list with status badges (enabled/disabled/error)
- [ ] Enable/disable toggle per plugin
- [ ] Configuration editor (dynamic form from `plugin.yaml` schema)
- [ ] "Run Now" button for manual trigger
- [ ] Run history table with log viewer

### 4.4 Web UI - Document Browser Page
- [ ] Calendar view (days with documents highlighted)
- [ ] Click date → show all documents for that day
- [ ] Document viewer (Markdown renderer)
- [ ] Filter by source/type
- [ ] Basic text search

### 4.5 Web UI - Dashboard Enhancements
- [ ] Real-time plugin status via WebSocket
- [ ] Today's documents summary cards
- [ ] Recent errors/warnings panel
- [ ] Quick stats (total documents, active plugins, last run times)

**Phase 4 Deliverable**: Full Web UI operational, daily digest fusing all sources

---

## Phase 5: Polish & Ship (Week 5-6)

### 5.1 Docker Packaging
- [ ] Multi-stage Dockerfile (build frontend → bundle with backend)
- [ ] `docker-compose.yml` with Ollama optional service
- [ ] Volume mounts for config, vault, and data sources
- [ ] Health check endpoint for container orchestration
- [ ] Environment variable documentation

### 5.2 CLI Tool
- [ ] `pios start/stop/status` commands
- [ ] `pios plugin list/install/enable/disable/run` commands
- [ ] `pios config init` interactive setup wizard
- [ ] `pios docs list/search` commands
- [ ] Shell completion support (bash/zsh/fish)

### 5.3 Documentation
- [ ] README with quickstart guide
- [ ] Plugin development tutorial (build a source plugin in 15 min)
- [ ] Configuration reference
- [ ] API documentation (auto-generated from FastAPI)
- [ ] Architecture overview for contributors

### 5.4 Testing & Quality
- [ ] Unit tests for core modules (config, document store, scheduler)
- [ ] Integration tests for each migrated plugin (with mocked data sources)
- [ ] End-to-end test: fresh install → configure → run all plugins → verify output
- [ ] Performance test: 1000 documents query < 500ms

### 5.5 Migration Validation
- [ ] Compare output of PiOS plugins vs. current system for same dates
- [ ] Verify Markdown format compatibility with Obsidian vault
- [ ] Run PiOS in parallel with current system for 3 days
- [ ] Switch over: disable old scheduled tasks, enable PiOS

**Phase 5 Deliverable**: v0.1.0 release ready for GitHub

---

## Dependency Graph

```
Phase 1 (Skeleton)
    │
    ▼
Phase 2 (Plugin Framework)
    │
    ├──────────────────┐
    ▼                  ▼
Phase 3 (Sources)  Phase 4.3-4.5 (Web UI)
    │                  │
    ▼                  │
Phase 4.1-4.2 (Agents)│
    │                  │
    ├──────────────────┘
    ▼
Phase 5 (Polish & Ship)
```

Phases 3 and 4.3-4.5 can run in parallel once Phase 2 is complete.
