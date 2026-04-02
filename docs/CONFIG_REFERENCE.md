# PiOS Configuration Reference

Configuration is loaded from `~/.pios/config.yaml` (or the path passed to `--config`).
Environment variables of the form `${VAR_NAME}` are interpolated at load time.

---

## Full example

```yaml
app_name: PiOS
debug: false
log_level: INFO   # DEBUG | INFO | WARNING | ERROR

llm:
  provider: anthropic          # anthropic | openai | ollama
  model: claude-opus-4-6
  api_key: "${ANTHROPIC_API_KEY}"
  temperature: 0.3
  max_tokens: 4000
  # base_url: http://localhost:11434  # for Ollama

database:
  type: sqlite
  path: ~/.pios/pios.db

scheduler:
  enabled: true
  timezone: Asia/Shanghai      # any tz database string
  max_workers: 4

storage:
  vault_path: ~/.pios/vault

# Directories scanned for plugins (in order)
plugin_dirs:
  - ~/.pios/plugins
  - ./plugins

# Per-plugin config overrides (applied on top of plugin.yaml defaults)
plugin_configs:
  source-apple-health:
    export_dir: ~/Downloads
    my_name: Abe
    days_back: 1

  source-wechat:
    decrypted_db_dir: ~/wechat/decrypted
    my_wxid: wxid_example

  source-immich:
    immich_url: http://myserver:2283
    immich_api_key: "${IMMICH_API_KEY}"
    days_back: 1

  source-chatgpt:
    export_file: ~/Downloads/conversations.json
    days_back: 1
```

---

## Sections

### `llm`

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `provider` | string | `openai` | LLM backend: `anthropic`, `openai`, `ollama`, or any LiteLLM-supported provider |
| `model` | string | `gpt-4` | Model identifier |
| `api_key` | string | `""` | API key; use `${ENV_VAR}` to avoid hardcoding |
| `base_url` | string | `null` | Custom endpoint (required for Ollama: `http://localhost:11434`) |
| `temperature` | float 0-2 | `0.7` | Sampling temperature |
| `max_tokens` | int | `2000` | Maximum tokens per LLM response |

### `database`

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `type` | string | `sqlite` | Database type (only `sqlite` is supported in v0.1) |
| `path` | string | `~/.pios/pios.db` | SQLite file path |

### `scheduler`

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `enabled` | bool | `true` | Whether the cron scheduler runs on startup |
| `timezone` | string | `UTC` | Timezone for cron expressions (tz database name) |
| `max_workers` | int | `4` | Thread pool size for background jobs |

### `storage`

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `vault_path` | string | `~/.pios/vault` | Root directory of the Markdown vault |

### `plugin_dirs`

List of directories scanned for plugins on startup.  Each directory is searched for sub-directories containing `plugin.yaml`.

Default: `["~/.pios/plugins", "./plugins"]`

### `plugin_configs`

Dict of per-plugin config overrides, keyed by plugin name.  These values are applied on top of the defaults defined in each plugin's `plugin.yaml` `config_schema`, and can themselves be overridden via the Web UI or API (`POST /api/plugins/{name}/configure`).

Priority (lowest → highest): `plugin.yaml defaults` → `config.yaml plugin_configs` → Web UI / API DB overrides.

---

## Environment variable interpolation

Any string value in `config.yaml` can reference an environment variable:

```yaml
api_key: "${ANTHROPIC_API_KEY}"
# With fallback:
api_key: "${ANTHROPIC_API_KEY:my-default-value}"
```

Variables are resolved at startup from the process environment (`.env` file is NOT automatically loaded — use `export` or Docker `env_file`).

---

## Docker environment variables

When running in Docker, set these in your `.env` file (see `.env.example`):

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | Anthropic API key |
| `OPENAI_API_KEY` | OpenAI API key |
| `PIOS_PORT` | Host port to bind (default `9100`) |

Mount a volume at `/data/.pios` to persist the database, vault, and plugins across container restarts.
