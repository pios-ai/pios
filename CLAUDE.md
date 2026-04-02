# PiOS - Claude Worker Guide

## What is this project?
PiOS (Personal Intelligence OS) is a local-first, open-source personal AI system. It collects life data from multiple sources (WeChat, Apple Health, photos, AI chat logs), builds a unified knowledge layer, and uses AI agents to proactively assist the user. Think "Jarvis for everyone" with strong privacy guarantees.

## Current Status
- **Phase**: M1 (Milestone 1) - Foundation + Migration
- **Done**: PRD, Architecture Design, M1 Task Breakdown, Project Scaffold (66 files, 4000+ LOC)
- **Next**: M1 Phase 1 - Get the project actually running (backend starts, frontend renders, DB works)

## Key Decisions Already Made
- **Tech Stack**: Python (FastAPI) backend + React (Vite + Tailwind) frontend
- **Database**: SQLite (metadata) + file-based Markdown vault (documents)
- **LLM**: LiteLLM (supports OpenAI, Anthropic, Ollama)
- **Scheduler**: APScheduler
- **Plugin System**: Source plugins (data ingestion) + Agent plugins (AI actions)
- **Deployment**: Docker Compose for distribution, native macOS for development
- **Port**: 9100 (API + UI)

## Project Structure
```
PiOS/
├── backend/pios/          # FastAPI backend
│   ├── main.py            # App entry point
│   ├── core/              # Config, DB, LLM, Scheduler
│   ├── plugin/            # Plugin manager, runtime
│   ├── document/          # Document store (vault + SQLite index)
│   ├── api/               # REST API routes
│   └── sdk/               # Plugin SDK (SourcePlugin, AgentPlugin base classes)
├── frontend/src/          # React frontend
├── plugins/               # 6 built-in plugins (4 source + 2 agent)
├── docker/                # Docker configs
├── cli/                   # CLI tool (Typer)
└── docs/                  # PRD, Architecture, M1 Tasks
```

## Essential Reading (in order)
1. `docs/PRD.md` - Product vision, milestones, requirements
2. `docs/ARCHITECTURE.md` - System design, plugin protocol, API design, data flow
3. `docs/M1_TASKS.md` - Detailed task breakdown with dependencies

## Migration Context
The user (Abe) currently runs 4 automated pipelines via Claude Desktop scheduled tasks:
1. **WeChat digest** - Decrypts local WeChat DB, extracts daily messages → Markdown
2. **Apple Health digest** - Parses Health Auto Export JSON → daily health report
3. **Immich photo diary** - Fetches photos via HTTP API → photo diary with GPS/EXIF
4. **ChatGPT diary** - Browser automation to summarize ChatGPT conversations

These existing scripts live in the user's local pipeline directory.
M1 goal is to migrate all 4 onto the new PiOS plugin architecture.

## Important Notes
- The user is NOT a programmer. Explain decisions simply, don't ask low-level technical questions.
- All coding work should be done by Claude autonomously.
- Test everything before declaring it done.
- The project should be runnable with `make dev` or `docker compose up`.
