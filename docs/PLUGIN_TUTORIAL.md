# Build a PiOS Plugin in 15 Minutes

This tutorial walks you through writing a complete **source plugin** that fetches data and saves it to the vault.  By the end you will have a working plugin you can install and run.

---

## What is a plugin?

PiOS has two plugin types:

| Type | Base class | Purpose |
|------|-----------|---------|
| **source** | `SourcePlugin` | Fetch raw data from an external source, normalize it to Markdown |
| **agent** | `AgentPlugin` | Read documents from the vault, reason with LLM, write derived documents |

Both types live in a directory with two files:

```
my-plugin/
├── plugin.yaml    # manifest (name, version, config schema, schedule)
└── __init__.py    # Python code
```

---

## Step 1 — Create the directory

```bash
mkdir -p ~/.pios/plugins/source-quotes
cd ~/.pios/plugins/source-quotes
```

---

## Step 2 — Write the manifest (`plugin.yaml`)

```yaml
name: source-quotes
version: 0.1.0
type: source
description: Fetches a random quote and saves it as a daily note

config_schema:
  category:
    type: string
    default: "inspire"
    description: "Quote category (inspire / life / humor)"

schedule: "0 9 * * *"   # 09:00 every day
```

**Fields:**

| Field | Required | Description |
|-------|----------|-------------|
| `name` | ✅ | Unique slug (no spaces) |
| `version` | ✅ | Semver string |
| `type` | ✅ | `source` or `agent` |
| `description` | ✅ | One-line description |
| `config_schema` | | Dict of configurable keys with type / default / description |
| `schedule` | | Cron expression — omit for manual-only plugins |

---

## Step 3 — Write the plugin (`__init__.py`)

```python
"""source-quotes — fetches a random quote daily."""

import urllib.request
import json
from datetime import date, timedelta
from typing import Any, Dict, List

from pios.sdk import SourcePlugin, SourceData


class Plugin(SourcePlugin):
    """Fetch a random inspirational quote and save it as a Markdown note."""

    def fetch(self) -> List[SourceData]:
        category = self.context.get_config("category", "inspire")
        target = (date.today() - timedelta(days=1)).isoformat()

        # Skip if already fetched today
        if self.context.database:
            existing = self.context.database.get_documents(
                source="source-quotes", date_from=target, date_to=target
            )
            if existing:
                self.logger.info(f"Quote already saved for {target}, skipping")
                return []

        try:
            url = f"https://zenquotes.io/api/quotes/category/{category}"
            with urllib.request.urlopen(url, timeout=10) as r:
                quotes = json.loads(r.read())
            quote = quotes[0] if quotes else {"q": "No quote today.", "a": "Unknown"}
        except Exception as e:
            self.logger.warning(f"Could not fetch quote: {e}")
            return []

        return [SourceData(
            source="source-quotes",
            data_type="quote",
            content={"quote": quote["q"], "author": quote["a"]},
            title=f"Quote of the Day — {target}",
            date=target,
            tags=["quote", category],
        )]

    def normalize(self, data: SourceData) -> Dict[str, Any]:
        q = data.content["quote"]
        a = data.content["author"]
        text = f"> {q}\n>\n> — **{a}**"
        return {"text": text}
```

### Key SDK objects

**`SourcePlugin`** — your base class.  Override:
- `fetch() → List[SourceData]` — retrieve raw data items
- `normalize(data: SourceData) → {"text": str}` — convert to Markdown

**`SourceData`** — the raw data container passed from `fetch` to `normalize`.

**`self.context`** — your plugin's execution context:

```python
self.context.get_config("key", default)   # read config value
self.context.llm                          # LLMClient (may be None)
self.context.database                     # Database
self.context.document_store               # DocumentStore
self.context.scheduler                    # PiOSScheduler
self.logger                               # standard Python logger
```

---

## Step 4 — Install and run

```bash
# Install (copies plugin to ~/.pios/plugins/)
pios plugin install ~/.pios/plugins/source-quotes

# Or, if the server is already running, just place the directory
# and use the Reload button in the Web UI.

# Run manually
pios run source-quotes

# Check the vault
pios docs list --source source-quotes
```

---

## Writing an Agent Plugin

Agent plugins read existing vault documents and produce new ones (summaries, alerts, analyses).

```python
from pios.sdk import AgentPlugin

class Plugin(AgentPlugin):
    async def run(self) -> dict:
        # Query documents
        docs = self.query_documents(source="source-quotes", limit=7)
        if not docs:
            return {"status": "success", "message": "no quotes found"}

        # Load full text
        texts = []
        for doc in docs:
            full = self.context.document_store.get(doc["id"])
            if full:
                texts.append(full.content.get("text", ""))

        # Use LLM
        summary = self.use_llm(
            f"Summarize these quotes in one paragraph:\n\n" + "\n\n".join(texts)
        )

        # Save result
        doc_id = self.save_document(
            title=f"Weekly Quote Summary",
            content=summary or "No summary available.",
            doc_type="quote-summary",
            tags=["quote", "summary"],
        )

        return {"status": "success", "doc_id": doc_id}
```

---

## Tips

- **Deduplication**: always check `context.database.get_documents(date_from=..., date_to=...)` before fetching — avoid duplicate vault entries.
- **Graceful warnings**: if config values are missing, log a warning and return `[]` from `fetch()`.  Never crash.
- **LLM is optional**: call `self.context.is_llm_available()` before using the LLM.  Provide a raw-text fallback.
- **Config defaults**: set sensible defaults in `plugin.yaml` `config_schema`.  Users can override via the Web UI config editor or `~/.pios/config.yaml`.
- **requirements.txt**: if your plugin needs third-party packages, add a `requirements.txt` in the plugin directory.  PiOS installs it automatically on first load.
