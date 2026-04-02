# PiOS Architecture Design Document
**Version**: 0.1 | **Date**: 2026-03-27

---

## 1. System Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                         PiOS Web UI (React)                        │
│  Dashboard · Plugin Manager · Document Viewer · Query Interface    │
└──────────────────────────────┬──────────────────────────────────────┘
                               │ REST API
┌──────────────────────────────┴──────────────────────────────────────┐
│                      PiOS Core (FastAPI)                            │
│                                                                     │
│  ┌─────────────┐  ┌──────────────┐  ┌───────────────┐              │
│  │  Plugin      │  │  Scheduler   │  │  LLM Engine   │              │
│  │  Manager     │  │  Engine      │  │  (LiteLLM)    │              │
│  └──────┬──────┘  └──────┬───────┘  └───────┬───────┘              │
│         │                │                   │                      │
│  ┌──────┴──────────────┴───────────────────┴───────────────┐       │
│  │                    Plugin Runtime                        │       │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐   │       │
│  │  │ source-  │ │ source-  │ │ source-  │ │ source-  │   │       │
│  │  │ wechat   │ │ health   │ │ immich   │ │ chatgpt  │   │       │
│  │  └──────────┘ └──────────┘ └──────────┘ └──────────┘   │       │
│  │  ┌──────────┐ ┌──────────┐                              │       │
│  │  │ agent-   │ │ agent-   │  ... more plugins            │       │
│  │  │ digest   │ │ health   │                              │       │
│  │  └──────────┘ └──────────┘                              │       │
│  └─────────────────────────────────────────────────────────┘       │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────┐       │
│  │                   Data Layer                             │       │
│  │  ┌──────────┐  ┌──────────────┐  ┌──────────────────┐  │       │
│  │  │ Document  │  │  SQLite      │  │  ChromaDB        │  │       │
│  │  │ Vault     │  │  (metadata)  │  │  (vector embed)  │  │       │
│  │  │ (Markdown)│  │              │  │                  │  │       │
│  │  └──────────┘  └──────────────┘  └──────────────────┘  │       │
│  └─────────────────────────────────────────────────────────┘       │
└─────────────────────────────────────────────────────────────────────┘
```

## 2. Core Components

### 2.1 Plugin Manager

The Plugin Manager is the heart of PiOS. It handles plugin discovery, lifecycle, configuration, and execution.

**Plugin Discovery**:
```
~/.pios/plugins/
├── source-apple-health/
│   ├── plugin.yaml          # Plugin manifest
│   ├── __init__.py          # Entry point
│   └── requirements.txt     # Dependencies (optional)
├── source-wechat/
│   ├── plugin.yaml
│   ├── __init__.py
│   ├── decrypt.py           # WeChat-specific decryption logic
│   └── requirements.txt
└── agent-daily-digest/
    ├── plugin.yaml
    └── __init__.py
```

**Plugin Manifest** (`plugin.yaml`):
```yaml
name: source-apple-health
version: 1.0.0
type: source                    # "source" or "agent"
description: "Import daily health metrics from Apple Health via Health Auto Export"
author: "PiOS Core Team"

# What this plugin needs
config:
  export_dir:
    type: path
    description: "Path to Health Auto Export data directory"
    required: true
  metrics:
    type: list
    description: "Which metrics to track"
    default: ["heart_rate", "steps", "blood_oxygen", "hrv", "exercise"]

# When this plugin runs
schedule:
  cron: "30 0 * * *"           # Default schedule (user can override)

# What data this plugin produces
outputs:
  - type: health_daily
    format: markdown

# What data this plugin can read (for sandboxing)
permissions:
  read_paths:
    - "${config.export_dir}"
  network: false                # This plugin doesn't need network access
```

**Plugin Lifecycle**:
```
DISCOVERED → INSTALLED → CONFIGURED → ENABLED → RUNNING → COMPLETED
                                         ↓                    ↓
                                      DISABLED              FAILED
                                                              ↓
                                                          RETRY (with backoff)
```

**Plugin Base Classes**:
```python
# pios/sdk/source.py
class SourcePlugin(ABC):
    """Base class for all source plugins."""

    def __init__(self, config: dict, context: PluginContext):
        self.config = config
        self.context = context  # provides: logger, llm, document_store, etc.

    @abstractmethod
    async def fetch(self, date: datetime.date) -> list[RawData]:
        """Fetch raw data from the source for the given date."""
        ...

    @abstractmethod
    async def normalize(self, raw: list[RawData]) -> list[Document]:
        """Convert raw data into PiOS Documents."""
        ...

    async def run(self, date: datetime.date) -> list[Document]:
        """Main execution flow (usually don't override)."""
        raw = await self.fetch(date)
        docs = await self.normalize(raw)
        for doc in docs:
            await self.context.document_store.save(doc)
        return docs


# pios/sdk/agent.py
class AgentPlugin(ABC):
    """Base class for all agent plugins."""

    def __init__(self, config: dict, context: PluginContext):
        self.config = config
        self.context = context

    @abstractmethod
    async def run(self, trigger: TriggerEvent) -> AgentResult:
        """Execute agent logic. Can query documents, call LLM, take actions."""
        ...
```

### 2.2 Scheduler Engine

Built on APScheduler, manages when plugins run.

```python
# Schedule types:
# 1. Cron-based (most source plugins)
schedule:
  cron: "30 0 * * *"        # Every day at 00:30

# 2. Interval-based
schedule:
  interval: "30m"            # Every 30 minutes

# 3. Event-triggered (M2+)
schedule:
  trigger: "document.created" # When any new document is created
  filter:
    source: "source-wechat"  # Only when WeChat produces new docs

# 4. Manual only
schedule:
  manual: true               # Only runs when explicitly triggered
```

**Execution Model**:
- Each plugin runs in its own asyncio task (non-blocking)
- Failed runs are retried with exponential backoff (1min, 5min, 30min)
- Execution results logged to SQLite for observability
- Concurrent execution limit configurable (default: 3 plugins at once)

### 2.3 Document Store

A hybrid storage system combining human-readable files with machine-queryable indexes.

**File Layer** (primary source of truth):
```
~/.pios/vault/
├── 2026/
│   ├── 03/
│   │   ├── 27/
│   │   │   ├── health.md           # From source-apple-health
│   │   │   ├── wechat.md           # From source-wechat
│   │   │   ├── photos.md           # From source-immich
│   │   │   ├── chatgpt.md          # From source-chatgpt
│   │   │   └── daily-digest.md     # From agent-daily-digest
```

**SQLite Index** (metadata for fast queries):
```sql
CREATE TABLE documents (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,           -- "source-apple-health"
    type TEXT NOT NULL,             -- "health_daily"
    date DATE NOT NULL,
    title TEXT,
    tags TEXT,                      -- JSON array
    file_path TEXT NOT NULL,        -- Relative path in vault
    content_hash TEXT,              -- For deduplication
    created_at TIMESTAMP,
    updated_at TIMESTAMP
);

CREATE TABLE document_metadata (
    document_id TEXT REFERENCES documents(id),
    key TEXT NOT NULL,
    value TEXT,
    PRIMARY KEY (document_id, key)
);

-- Execution log for observability
CREATE TABLE plugin_runs (
    id INTEGER PRIMARY KEY,
    plugin_name TEXT NOT NULL,
    started_at TIMESTAMP,
    finished_at TIMESTAMP,
    status TEXT,                     -- "success", "failed", "retry"
    documents_created INTEGER,
    error_message TEXT,
    duration_ms INTEGER
);
```

**Vector Layer** (for semantic search, M2):
```python
# ChromaDB collection for each document type
collection = chroma.get_or_create_collection("pios_documents")
collection.add(
    documents=[doc.content],
    metadatas=[doc.frontmatter],
    ids=[doc.id]
)
```

### 2.4 LLM Engine

Unified interface for all AI operations, built on LiteLLM.

```python
# pios/core/llm.py
class LLMEngine:
    """Provides LLM access to all plugins."""

    def __init__(self, config: LLMConfig):
        # Supports: openai, anthropic, ollama, local models
        self.default_model = config.default_model  # e.g., "ollama/llama3"

    async def complete(self,
                       prompt: str,
                       model: str = None,
                       temperature: float = 0.3,
                       max_tokens: int = 4096) -> str:
        """Simple completion."""
        model = model or self.default_model
        response = await litellm.acompletion(
            model=model,
            messages=[{"role": "user", "content": prompt}],
            temperature=temperature,
            max_tokens=max_tokens
        )
        return response.choices[0].message.content

    async def complete_structured(self,
                                  prompt: str,
                                  schema: type[BaseModel],
                                  model: str = None) -> BaseModel:
        """Structured output with Pydantic validation."""
        ...
```

**Configuration** (`~/.pios/config.yaml`):
```yaml
llm:
  # Option 1: Local model (maximum privacy)
  default_model: "ollama/llama3.1:8b"

  # Option 2: Cloud API
  # default_model: "anthropic/claude-sonnet-4-20250514"
  # api_keys:
  #   anthropic: "sk-ant-..."

  # Option 3: Custom endpoint
  # default_model: "openai/custom-model"
  # api_base: "http://localhost:1234/v1"
```

### 2.5 Web UI

React-based dashboard served by FastAPI.

**Pages**:

1. **Dashboard** (`/`)
   - System status (running plugins, recent errors)
   - Today's document summary cards
   - Quick stats (documents created this week, active plugins)

2. **Plugin Manager** (`/plugins`)
   - Installed plugins with status indicators
   - Enable/disable toggles
   - Configuration editor per plugin
   - Install new plugin (from directory or URL)
   - Run history and logs per plugin

3. **Document Browser** (`/documents`)
   - Calendar view (click date → see all documents)
   - List view with filters (by source, type, date range)
   - Document viewer (rendered Markdown)
   - Full-text search

4. **Timeline** (`/timeline`) (M2)
   - Unified chronological view fusing all data sources
   - "What happened on this day" view

5. **Query** (`/query`) (M2)
   - Natural language search across all documents
   - "Ask your second brain" interface

6. **Settings** (`/settings`)
   - LLM configuration
   - Storage paths
   - Scheduler settings
   - Backup & export

### 2.6 CLI Tool

```bash
# Service management
pios start                          # Start PiOS service (API + scheduler)
pios stop                           # Stop service
pios status                         # Show service status and running plugins

# Plugin management
pios plugin list                    # List installed plugins
pios plugin install <path|url>      # Install a plugin
pios plugin enable <name>           # Enable a plugin
pios plugin disable <name>          # Disable a plugin
pios plugin run <name> [--date]     # Manually trigger a plugin
pios plugin logs <name>             # Show recent run logs

# Document management
pios docs list [--date] [--source]  # List documents
pios docs search <query>            # Search documents
pios docs export <path>             # Export vault to path

# Configuration
pios config show                    # Show current config
pios config set <key> <value>       # Set config value
pios config init                    # Interactive setup wizard
```

## 3. Data Flow

### 3.1 Source Plugin Execution Flow

```
┌──────────┐     ┌──────────────┐     ┌───────────┐     ┌──────────┐
│ Scheduler │────▶│ Plugin       │────▶│ Source     │────▶│ External │
│ triggers  │     │ Manager      │     │ Plugin     │     │ Data     │
│ cron job  │     │ creates task │     │ .fetch()   │     │ Source   │
└──────────┘     └──────────────┘     └─────┬─────┘     └──────────┘
                                            │
                                    Raw data│returned
                                            ▼
                                    ┌───────────────┐
                                    │ Source Plugin  │
                                    │ .normalize()   │
                                    └───────┬───────┘
                                            │
                                    PiOS Documents
                                            │
                      ┌─────────────────────┼─────────────────────┐
                      ▼                     ▼                     ▼
              ┌──────────────┐     ┌──────────────┐     ┌──────────────┐
              │ Markdown     │     │ SQLite       │     │ Event Bus    │
              │ file saved   │     │ index updated│     │ "doc.created"│
              │ to vault     │     │              │     │ emitted      │
              └──────────────┘     └──────────────┘     └──────┬───────┘
                                                               │
                                                               ▼
                                                    ┌──────────────────┐
                                                    │ Agent plugins    │
                                                    │ listening for    │
                                                    │ this event       │
                                                    └──────────────────┘
```

### 3.2 Agent Plugin Execution Flow

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│ Trigger      │────▶│ Agent Plugin │────▶│ Document     │
│ (cron/event) │     │ .run()       │     │ Store query  │
└──────────────┘     └──────┬───────┘     └──────┬───────┘
                            │                     │
                            │ Retrieved docs      │
                            ◀─────────────────────┘
                            │
                            ▼
                    ┌──────────────┐
                    │ LLM Engine   │
                    │ .complete()  │ Fuse + analyze + generate
                    └──────┬───────┘
                            │
                            ▼
                    ┌──────────────┐
                    │ Actions:     │
                    │ - Save doc   │
                    │ - Send notif │
                    │ - API call   │
                    └──────────────┘
```

## 4. Security & Sandboxing

### 4.1 Plugin Permission Model

Each plugin declares its permissions in `plugin.yaml`:

```yaml
permissions:
  read_paths:                 # File system paths it can read
    - "${config.export_dir}"
    - "~/.pios/vault/"        # Can read existing documents
  write_paths:                # Where it can write
    - "~/.pios/vault/"        # Only to the document vault
  network:                    # Network access
    hosts: ["localhost:2283"]  # Only specific hosts, or false for none
  llm: true                   # Whether it can call the LLM engine
  env_vars: ["WECHAT_KEY"]    # Environment variables it can access
```

The Plugin Runtime enforces these permissions before each operation.

### 4.2 Data Privacy Guarantees

1. **No data leaves the machine by default.** Network access is opt-in per plugin.
2. **LLM calls with local models**: zero data exfiltration.
3. **LLM calls with cloud APIs**: only processed/summarized prompts are sent, never raw data dumps. The prompt template is visible and auditable in plugin code.
4. **Vault encryption** (M4): optional AES-256 encryption at rest.

## 5. Deployment Architecture

### 5.1 Development (macOS native)

```bash
# Prerequisites: Python 3.11+, Node.js 18+
git clone https://github.com/pios-ai/pios.git
cd pios
make dev    # Starts backend + frontend in dev mode
```

### 5.2 Production (Docker Compose)

```yaml
# docker-compose.yml
services:
  pios:
    build: .
    ports:
      - "9100:9100"          # Web UI + API
    volumes:
      - ~/.pios:/data        # Persist config + vault
      - /path/to/sources:/sources:ro  # Read-only access to data sources
    environment:
      - PIOS_LLM_MODEL=ollama/llama3.1:8b
      - PIOS_LLM_API_BASE=http://ollama:11434
    restart: unless-stopped

  ollama:                     # Optional: local LLM
    image: ollama/ollama
    ports:
      - "11434:11434"
    volumes:
      - ollama_data:/root/.ollama
    deploy:
      resources:
        reservations:
          devices:
            - capabilities: [gpu]

volumes:
  ollama_data:
```

### 5.3 Port Convention

| Service | Port | Description |
|---------|------|-------------|
| PiOS API + UI | 9100 | Main entry point |
| Ollama (optional) | 11434 | Local LLM |

## 6. API Design

### 6.1 REST API (FastAPI)

```
# Plugin APIs
GET    /api/plugins                    # List all plugins
GET    /api/plugins/{name}             # Get plugin details
POST   /api/plugins/{name}/enable      # Enable plugin
POST   /api/plugins/{name}/disable     # Disable plugin
PUT    /api/plugins/{name}/config      # Update plugin config
POST   /api/plugins/{name}/run         # Manually trigger plugin
GET    /api/plugins/{name}/runs        # Get run history

# Document APIs
GET    /api/documents                  # List documents (with filters)
GET    /api/documents/{id}             # Get document content
GET    /api/documents/dates            # Get dates with documents (for calendar)
DELETE /api/documents/{id}             # Delete document

# Scheduler APIs
GET    /api/scheduler/status           # Scheduler status
GET    /api/scheduler/jobs             # List scheduled jobs
POST   /api/scheduler/jobs/{id}/pause  # Pause a job
POST   /api/scheduler/jobs/{id}/resume # Resume a job

# System APIs
GET    /api/status                     # System health
GET    /api/config                     # Current configuration
PUT    /api/config                     # Update configuration
GET    /api/logs                       # Recent logs

# Query APIs (M2)
POST   /api/query                      # Natural language query
POST   /api/search                     # Full-text search
```

### 6.2 WebSocket (real-time updates)

```
WS /ws/events
  → { "type": "plugin.started", "plugin": "source-wechat", "timestamp": "..." }
  → { "type": "plugin.completed", "plugin": "source-wechat", "documents": 1 }
  → { "type": "document.created", "id": "...", "source": "source-wechat" }
  → { "type": "plugin.failed", "plugin": "source-chatgpt", "error": "..." }
```

## 7. Configuration

### 7.1 Global Config (`~/.pios/config.yaml`)

```yaml
# PiOS Configuration
version: "1.0"

# Core settings
core:
  vault_dir: "~/.pios/vault"          # Where documents are stored
  port: 9100                           # API + UI port
  log_level: "info"                    # debug, info, warning, error
  timezone: "Asia/Shanghai"            # Local timezone

# LLM settings
llm:
  default_model: "ollama/llama3.1:8b"  # Default model for all plugins
  api_base: "http://localhost:11434"   # Ollama endpoint
  # Uncomment for cloud API:
  # default_model: "anthropic/claude-sonnet-4-20250514"
  # api_keys:
  #   anthropic: "${ANTHROPIC_API_KEY}"

# Scheduler settings
scheduler:
  max_concurrent: 3                    # Max plugins running simultaneously
  retry_max: 3                         # Max retries on failure
  retry_backoff: [60, 300, 1800]       # Backoff in seconds

# Notification settings (M3)
notifications:
  enabled: false
  # webhook_url: "https://..."
```

### 7.2 Plugin Config (per-plugin override)

```yaml
# ~/.pios/plugins/source-apple-health/config.yaml
export_dir: "/path/to/health-auto-export/data"
metrics:
  - heart_rate
  - steps
  - blood_oxygen
  - hrv
  - exercise
schedule:
  cron: "30 0 * * *"    # Override default schedule
llm:
  model: "anthropic/claude-sonnet-4-20250514"  # Use better model for this plugin
```
