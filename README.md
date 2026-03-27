# PiOS - Personal Intelligence OS

A modular personal data and intelligence platform that aggregates data from multiple sources and applies AI-driven analysis.

## Features

- **Modular Plugin Architecture**: Extensible source and agent plugins
- **Document Vault**: Centralized storage for all personal documents with YAML frontmatter
- **SQLite Indexing**: Fast searching and querying of documents
- **Scheduled Execution**: APScheduler-based plugin scheduling with cron support
- **LLM Integration**: LiteLLM wrapper for unified LLM access
- **REST API**: FastAPI-based API for all operations
- **Web Dashboard**: React-based frontend for visualization and management
- **CLI Tool**: Typer-based command-line interface

## Project Structure

```
PiOS/
├── backend/              # Python FastAPI backend
│   ├── pios/
│   │   ├── core/        # Configuration, database, LLM, scheduler
│   │   ├── plugin/      # Plugin system and management
│   │   ├── document/    # Document vault and storage
│   │   ├── api/         # FastAPI routes
│   │   ├── sdk/         # Plugin SDK base classes
│   │   └── main.py      # FastAPI app
│   ├── tests/           # Test suite
│   └── requirements.txt
├── frontend/            # React + Vite + Tailwind CSS
│   ├── src/
│   │   ├── components/
│   │   ├── pages/
│   │   └── lib/
│   └── package.json
├── plugins/             # Plugin implementations
│   ├── source-*/        # Data source plugins
│   └── agent-*/         # Analysis agent plugins
├── docker/              # Docker configuration
├── cli/                 # CLI tool
└── docs/                # Documentation
```

## Installation

### Prerequisites
- Python 3.10+
- Node.js 18+
- Docker & Docker Compose (optional)

### Local Setup

1. **Initialize configuration:**
   ```bash
   make init
   ```

2. **Install dependencies:**
   ```bash
   make install
   ```

3. **Run the backend:**
   ```bash
   make dev
   ```

4. **In another terminal, start the frontend:**
   ```bash
   cd frontend && npm run dev
   ```

### Docker Setup

```bash
make docker-up
```

This starts both backend (port 8000) and frontend (port 5173).

## Quick Start

### Start API Server
```bash
python -m uvicorn pios.main:app --reload
```

The API will be available at `http://localhost:8000`

### Access Web Dashboard
Open `http://localhost:5173` in your browser

### Run a Plugin
```bash
python -m pios.plugin.manager run source-apple-health
```

Or use the CLI:
```bash
python cli/pios_cli.py run source-apple-health
```

## Plugin Development

### Source Plugin Example

```python
from pios.sdk import SourcePlugin, SourceData

class Plugin(SourcePlugin):
    def fetch(self):
        # Fetch data from external source
        data = [
            SourceData(
                source="my-source",
                data_type="event",
                content={"event": "something happened"},
                title="Event Title",
                date="2024-01-01",
            )
        ]
        return data

    def normalize(self, data):
        # Normalize to standard format
        return {"event": data.content["event"]}
```

### Agent Plugin Example

```python
from pios.sdk import AgentPlugin

class Plugin(AgentPlugin):
    async def run(self):
        # Query documents
        docs = self.query_documents(source="apple-health")

        # Process with LLM if available
        if self.context.is_llm_available():
            analysis = self.context.llm.summarize(str(docs))

        # Save results
        self.save_document(
            title="Analysis",
            content=analysis,
            doc_type="analysis"
        )

        return {"status": "success"}
```

## API Endpoints

### System
- `GET /api/system/status` - System status
- `GET /api/system/health` - Health check
- `GET /api/system/version` - Version info

### Plugins
- `GET /api/plugins` - List all plugins
- `GET /api/plugins/{name}` - Get plugin info
- `POST /api/plugins/{name}/run` - Run plugin
- `GET /api/plugins/{name}/runs` - Plugin run history

### Documents
- `GET /api/documents` - List documents
- `GET /api/documents/{id}` - Get document
- `GET /api/documents/search/query?q=...` - Search documents
- `GET /api/documents/stats` - Document statistics

### Scheduler
- `GET /api/scheduler/status` - Scheduler status
- `POST /api/scheduler/start` - Start scheduler
- `POST /api/scheduler/stop` - Stop scheduler
- `GET /api/scheduler/jobs` - List scheduled jobs

## Configuration

Configuration can be provided via `~/.pios/config.yaml`:

```yaml
app_name: PiOS
debug: false
log_level: INFO

llm:
  provider: openai
  model: gpt-4
  api_key: ${OPENAI_API_KEY}  # Env var interpolation

database:
  type: sqlite
  path: ~/.pios/pios.db

scheduler:
  enabled: true
  timezone: UTC
  max_workers: 4

storage:
  vault_path: ~/.pios/vault
  index_type: sqlite

plugin_dirs:
  - ~/.pios/plugins
  - ./plugins
```

## Database Schema

### documents
- `id` (TEXT PRIMARY KEY)
- `source` (TEXT)
- `type` (TEXT)
- `date` (TEXT)
- `title` (TEXT)
- `tags` (TEXT)
- `file_path` (TEXT UNIQUE)
- `content_hash` (TEXT)
- `created_at` (TEXT)
- `updated_at` (TEXT)

### plugin_runs
- `id` (TEXT PRIMARY KEY)
- `plugin_name` (TEXT)
- `started_at` (TEXT)
- `finished_at` (TEXT)
- `status` (TEXT)
- `documents_created` (INTEGER)
- `error_message` (TEXT)
- `duration_ms` (INTEGER)

## Development

### Run Tests
```bash
make test
```

### Lint Code
```bash
make lint
```

### Format Code
```bash
make format
```

## Available Make Commands

```bash
make help              # Show help
make init              # Initialize configuration
make install           # Install dependencies
make dev               # Run backend in dev mode
make serve             # Run API server
make test              # Run tests
make clean             # Clean temporary files
make lint              # Run linters
make format            # Format code
make docker-build      # Build Docker image
make docker-up         # Start Docker containers
make docker-down       # Stop Docker containers
```

## Document Storage

Documents are stored in the vault with the following structure:

```
vault/
├── source-name/
│   ├── document-type/
│   │   ├── 2024/
│   │   │   ├── 01/
│   │   │   │   └── {doc-id}.md
```

Each document is stored as Markdown with YAML frontmatter:

```markdown
---
id: doc-id-123
source: apple-health
type: health-summary
title: Daily Health Summary
date: 2024-01-15
tags:
  - health
  - daily
created_at: 2024-01-15T10:30:00Z
updated_at: 2024-01-15T10:30:00Z
---

# Daily Health Summary

Document content here...
```

## Architecture

See `/docs/ARCHITECTURE.md` for detailed architecture documentation.

## Roadmap

See `/docs/M1_TASKS.md` for the Milestone 1 task list.

## License

MIT - See LICENSE file for details

## Contributing

Contributions welcome! Please feel free to submit a Pull Request.
