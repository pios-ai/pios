# PiOS - Personal Intelligence OS
## Product Requirements Document (PRD)
**Version**: 0.1 | **Date**: 2026-03-27 | **Author**: Abe & Claude

---

## 1. Vision

PiOS (Personal Intelligence OS) is a local-first, open-source personal AI operating system. It continuously collects, understands, and acts on a user's life data — chat history, health metrics, photos, calendar, browsing history, and more — to build a persistent "second brain" that proactively assists its owner.

Think of it as **Jarvis for everyone**: an AI that knows your context, remembers your history, and takes initiative — all while keeping your data on your own machine.

## 2. Problem Statement

Today's personal data is scattered across dozens of apps and services. No single system can:

- **Aggregate** life data from heterogeneous sources (WeChat, Apple Health, photos, AI chat logs, etc.)
- **Understand** this data in context (connecting health trends with chat conversations with calendar events)
- **Act proactively** based on fused understanding (not just answer questions, but anticipate needs)
- **Preserve privacy** by keeping everything local

Existing solutions either live in the cloud (Rewind/Limitless, Mem) compromising privacy, or are passive note-taking tools (Obsidian, Notion) that don't understand or act on your data.

## 3. Target Users

**Phase 1 (M1-M3)**: Technical early adopters who are comfortable with terminal/Docker and care deeply about data privacy. They likely already use tools like Obsidian, Home Assistant, or self-hosted services.

**Phase 2 (M4+)**: Broader audience who wants a "personal AI" but won't tolerate cloud data collection. Reached through a polished Web UI and one-click install.

## 4. Core Concepts

### 4.1 Three-Layer Architecture

| Layer | Role | Example |
|-------|------|---------|
| **L0 - Data Layer** | Ingest raw data from sources via plugins | WeChat DB decryption, Apple Health JSON, Immich API |
| **L1 - Knowledge Layer** | Normalize, index, and fuse data into a unified personal knowledge graph | Structured Markdown with embeddings in vector DB |
| **L2 - Agent Layer** | AI agents that query L1 and take actions proactively or on demand | Daily digest agent, health anomaly alert agent, context-aware reminder agent |

### 4.2 Plugin System (Sources & Agents)

PiOS's extensibility comes from two types of plugins:

**Source Plugins** (L0 → L1): Fetch data from external services and normalize it.
```
interface SourcePlugin:
    name: str                      # "apple-health", "wechat", "immich"
    schedule: CronExpression       # When to run
    fetch(context) -> RawData      # Pull data from source
    normalize(RawData) -> Document # Convert to PiOS standard format
```

**Agent Plugins** (L1 → L2): Consume knowledge and take actions.
```
interface AgentPlugin:
    name: str                       # "daily-digest", "health-monitor"
    triggers: list[Trigger]         # Cron schedule, event-based, or manual
    run(knowledge_context) -> Action # Query knowledge, decide, act
```

### 4.3 Document Standard

All data flows through a unified **PiOS Document** format:

```yaml
---
id: "doc_20260327_health_001"
source: "apple-health"
type: "health_daily"
date: "2026-03-27"
tags: ["health", "daily"]
schema_version: "1.0"
---
# Content in Markdown
Structured data and narrative content...
```

This ensures:
- Human-readable (open in any text editor or Obsidian)
- Machine-queryable (frontmatter metadata + vector embeddings)
- Source-agnostic (same format regardless of where data came from)

## 5. Feature Requirements

### 5.1 Milestone 1 (M1): Foundation + Migration

**Goal**: Establish the core architecture and successfully migrate the existing 4 pipelines (ChatGPT digest, WeChat digest, Health digest, Photo diary) onto the new platform.

**Core Platform**:
- [ ] Plugin registry and lifecycle management (install, enable, disable, configure)
- [ ] Scheduler engine (cron-based + event-triggered)
- [ ] Document store (file-based Markdown vault + SQLite metadata index)
- [ ] LLM abstraction layer (support OpenAI, Anthropic, Ollama via LiteLLM)
- [ ] Configuration system (YAML-based, per-plugin config)
- [ ] Web UI: Dashboard showing plugin status, recent documents, scheduler status

**Migrated Source Plugins**:
- [ ] `source-apple-health`: Apple Health JSON → daily health digest
- [ ] `source-wechat`: WeChat DB decryption → daily chat digest
- [ ] `source-immich`: Immich API → daily photo diary
- [ ] `source-chatgpt`: ChatGPT web export → daily AI conversation digest

**Migrated Agent Plugins**:
- [ ] `agent-daily-digest`: Fuse all source outputs into a unified daily summary
- [ ] `agent-health-monitor`: Detect health anomalies and generate alerts

**Infrastructure**:
- [ ] Docker Compose setup (one-command deployment)
- [ ] CLI tool for management (`pios start`, `pios plugin install`, `pios run <plugin>`)
- [ ] Logging and error handling framework

### 5.2 Milestone 2 (M2): Knowledge Fusion & Context Engine

- [ ] Vector embedding pipeline (embed all documents for semantic search)
- [ ] Cross-source context engine (query across all data sources)
- [ ] Temporal knowledge graph (understand relationships over time)
- [ ] Natural language query interface ("What was I doing when my heart rate spiked last Tuesday?")

### 5.3 Milestone 3 (M3): Proactive Agent Framework

- [ ] Event-driven trigger system (not just cron, but reactive to data changes)
- [ ] Multi-agent orchestration (agents can compose and delegate)
- [ ] Action framework (agents can send notifications, create calendar events, draft emails)
- [ ] User preference learning (adapt to user's habits and feedback over time)

### 5.4 Milestone 4+ (M4+): Ecosystem & Polish

- [ ] Plugin marketplace / registry
- [ ] Desktop client (Electron or Tauri)
- [ ] Mobile companion app (notifications + quick input)
- [ ] Community source plugins (Google Fit, Spotify, Twitter/X, Kindle highlights, etc.)
- [ ] End-to-end encryption for document store
- [ ] Multi-device sync (encrypted)

## 6. Non-Functional Requirements

### 6.1 Privacy (P0 - Highest Priority)

- ALL user data stored locally by default. Zero cloud dependency for core function.
- LLM calls: support local models (Ollama) and cloud APIs. When using cloud APIs, only send processed prompts — never raw personal data in bulk.
- No telemetry or analytics without explicit opt-in.
- Plugin sandboxing: plugins cannot access data outside their declared scope.

### 6.2 Performance

- Startup time < 5 seconds
- Plugin execution should not block the main service
- Web UI responsive within 200ms for dashboard operations
- Support 100K+ documents without degradation

### 6.3 Reliability

- Graceful failure: one plugin crash should not affect others
- Automatic retry with exponential backoff for transient failures
- Idempotent plugin execution (re-running should not create duplicates)

### 6.4 Extensibility

- Adding a new source plugin should require only: one Python file + one config YAML
- Adding a new agent plugin should require only: one Python file + one config YAML
- All core APIs documented with OpenAPI spec
- Plugin development tutorial and template provided

## 7. Tech Stack

| Component | Technology | Rationale |
|-----------|-----------|-----------|
| Backend | Python 3.11+ / FastAPI | AI ecosystem, existing code reuse, low contribution barrier |
| Frontend | React + Vite + Tailwind | Modern, fast, large community |
| Database | SQLite (metadata) + File system (documents) | Local-first, no external DB dependency, portable |
| Vector DB | ChromaDB (embedded) | Local, no server needed, Python-native |
| Scheduler | APScheduler | Mature, supports cron + interval + event triggers |
| LLM | LiteLLM | Unified interface for 100+ LLM providers + local models |
| Containerization | Docker Compose | One-command deployment for end users |
| CLI | Typer | Python CLI framework, auto-generates help docs |

## 8. Success Metrics

**M1 Success Criteria**:
- All 4 existing pipelines running on PiOS with same output quality
- `docker compose up` starts full system from scratch in < 2 minutes
- At least 1 external user can install and run PiOS following README only
- Web dashboard shows real-time status of all plugins and recent documents

## 9. Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| WeChat encryption breaks on update | Source plugin fails | Modular decryption layer; community can maintain alternative approaches |
| LLM API costs for daily operation | User adoption barrier | Default to local Ollama; cloud API is opt-in |
| Plugin quality inconsistency | User experience | Plugin review process + automated testing framework |
| Scope creep before M1 | Never ships | Strict M1 scope: migrate existing 4 pipelines only |

## 10. Open Questions

- Should PiOS support Windows? (Adds complexity, especially for WeChat decryption)
- Should the document format be pure Markdown or support structured JSON alongside?
- How to handle real-time data sources (e.g., live location, screen recording)?
- Revenue model for sustainability? (Open core? Hosted version? Plugin marketplace fees?)
