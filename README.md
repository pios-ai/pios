# PiOS — Personal Intelligence OS

A local-first, open-source personal AI system. PiOS collects life data from multiple sources (WeChat, Apple Health, photos, AI chat logs), builds a unified knowledge vault, and uses AI agents to generate daily digests and health alerts — all running on your own machine.

## Features

- **Plugin Architecture**: Source plugins (data ingestion) + Agent plugins (AI analysis), hot-reloadable
- **Document Vault**: Markdown files with YAML frontmatter, full-text search via SQLite
- **Scheduled Execution**: APScheduler cron jobs, configurable per plugin
- **LLM Integration**: LiteLLM wrapper — supports Anthropic, OpenAI, Ollama
- **REST API**: FastAPI on port 9100
- **Web Dashboard**: React + Tailwind — calendar view, document viewer, plugin management
- **CLI**: `pios` command with sub-commands for plugins, docs, and server management
- **Docker**: Single-container image with bundled frontend

## Quick Start

### Native (macOS / Linux)

```bash
# 1. Clone and install
git clone https://github.com/yourname/pios
cd pios
make install       # installs Python + Node deps

# 2. Configure
cp .env.example .env
# Edit .env — set ANTHROPIC_API_KEY or OPENAI_API_KEY

# 3. Start
make dev           # backend on :9100 + frontend dev server on :5173
```

Open `http://localhost:5173` in your browser.

### Docker

```bash
cp .env.example .env
# Edit .env

docker compose -f docker/docker-compose.yml up -d
```

Open `http://localhost:9100` — frontend is bundled in the container.

To use Ollama (local LLM, no API key needed):

```bash
docker compose -f docker/docker-compose.yml --profile ollama up -d
```

## CLI

Install the CLI:

```bash
pip install -e cli/
```

Key commands:

```bash
pios status                          # check running server
pios serve                           # start server on port 9100

pios plugin list                     # list all plugins
pios plugin run source-apple-health  # run a plugin now
pios plugin enable agent-daily-digest
pios plugin disable agent-health-monitor
pios plugin install ~/my-plugin/     # install from directory
pios plugin runs source-apple-health # show run history

pios docs list                       # list recent documents
pios docs list --source source-apple-health --date 2026-03-28
pios docs search "步数"              # full-text search
pios docs show <doc-id>              # print document to terminal
```

## Configuration

Copy `~/.pios/config.yaml` (created by `make init`) and edit:

```yaml
app_name: PiOS
log_level: INFO

llm:
  provider: anthropic          # anthropic | openai | ollama
  model: claude-opus-4-6
  api_key: "${ANTHROPIC_API_KEY}"

database:
  path: ~/.pios/pios.db

scheduler:
  enabled: true
  timezone: Asia/Shanghai

storage:
  vault_path: ~/.pios/vault

plugin_dirs:
  - ~/.pios/plugins
  - ./plugins
```

See `docs/CONFIG_REFERENCE.md` for all options.

## Built-in Plugins

| Plugin | Type | Schedule | Description |
|--------|------|----------|-------------|
| `source-apple-health` | source | daily 06:00 | Apple Health Export JSON → daily health report |
| `source-wechat` | source | daily 07:00 | WeChat local DB → daily message digest |
| `source-immich` | source | daily 07:30 | Immich photo server → photo diary |
| `source-chatgpt` | source | daily 08:00 | ChatGPT export JSON → conversation summary |
| `agent-daily-digest` | agent | daily 22:00 | Summarizes all sources into one daily digest |
| `agent-health-monitor` | agent | daily 07:10 | 7-day health trend + anomaly alerts |

## Plugin Development

See `docs/PLUGIN_TUTORIAL.md` for a step-by-step guide.

**Minimal source plugin:**

```python
from pios.sdk import SourcePlugin, SourceData

class Plugin(SourcePlugin):
    def fetch(self):
        return [SourceData(
            source="my-source", data_type="note",
            content={"text": "# Hello"}, title="My Note",
            date="2026-01-01",
        )]

    def normalize(self, data):
        return {"text": data.content["text"]}
```

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/system/health` | Health check |
| GET | `/api/system/status` | System status (DB, LLM, scheduler, plugins) |
| GET | `/api/plugins/` | List plugins |
| GET | `/api/plugins/{name}` | Plugin detail + schedule + last run |
| POST | `/api/plugins/{name}/run` | Run plugin now |
| GET | `/api/plugins/{name}/runs` | Run history |
| GET | `/api/plugins/{name}/config` | Plugin config (schema + current values) |
| POST | `/api/plugins/{name}/configure` | Update plugin config |
| GET | `/api/documents/` | List documents (date_from / date_to / source filters) |
| GET | `/api/documents/{id}` | Get document |
| GET | `/api/documents/search/query?q=` | Full-text search |
| GET | `/api/documents/stats` | Document statistics |
| GET | `/api/documents/calendar?year=&month=` | Calendar heatmap data |
| GET | `/api/scheduler/status` | Scheduler status |
| POST | `/api/scheduler/start` | Start scheduler |
| POST | `/api/scheduler/stop` | Stop scheduler |

## Project Structure

```
PiOS/
├── backend/pios/          # FastAPI backend
│   ├── main.py            # App entry, static file serving
│   ├── core/              # Config, DB, LLM, Scheduler
│   ├── plugin/            # Plugin manager + runtime
│   ├── document/          # Vault + SQLite index
│   ├── api/               # REST routes
│   └── sdk/               # SourcePlugin, AgentPlugin base classes
├── frontend/src/          # React + Vite + Tailwind
├── plugins/               # 6 built-in plugins
├── docker/                # Dockerfile + docker-compose.yml
├── cli/                   # pios CLI (Typer)
└── docs/                  # PRD, Architecture, Config Reference, Plugin Tutorial
```

## Development

```bash
make test          # run backend tests
make lint          # ruff + eslint
make format        # ruff format + prettier
make docker-build  # build Docker image
make docker-up     # start Docker (production mode)
make docker-down   # stop Docker
```

## Documentation

- `docs/PRD.md` — Product vision and requirements
- `docs/ARCHITECTURE.md` — System design and data flow
- `docs/CONFIG_REFERENCE.md` — Full configuration reference
- `docs/PLUGIN_TUTORIAL.md` — Build a plugin in 15 minutes

## License

MIT
