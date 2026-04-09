---
title: Frontmatter Schema Reference
description: YAML frontmatter fields for PiOS documents
---

# Frontmatter Schema

Every document in a PiOS vault uses YAML frontmatter for metadata. This enables structured queries, filtering, and indexing.

## Common fields (all document types)

```yaml
---
title: "Document title"              # Required
type: report | task | journal | note # Required
date: 2026-04-07                     # Required — the date this document is about
created: 2026-04-07T06:30:00         # Auto-set — when the file was created
tags: [health, daily]                # Optional — for filtering and search
source: source-apple-health          # Optional — which pipeline created this
---
```

## Task cards

```yaml
---
type: task
status: active | inbox | done | blocked
priority: 1 | 2 | 3                  # 1 = highest
parent: project-name                  # Parent project (filename without .md)
created: 2026-04-07
blocked_on: waiting-for-api-key       # What's blocking this task
---
```

## Project cards

```yaml
---
type: project
status: active | inbox | done
priority: 1 | 2 | 3
created: 2026-04-07
---
```

## Journal entries

```yaml
---
type: journal
date: 2026-04-07
mood: focused | scattered | energized | tired  # Optional
---
```

## Pipeline output

```yaml
---
type: report
source: source-apple-health
date: 2026-04-07
created: 2026-04-07T06:30:00
tags: [health, daily, auto-generated]
---
```

## Design principles

1. **Keep it flat.** No nested objects in frontmatter — SQLite indexing works best with flat fields.
2. **Dates are ISO 8601.** Always `YYYY-MM-DD` or `YYYY-MM-DDTHH:MM:SS`.
3. **Status is a closed set.** Don't invent new statuses — use the defined ones and add context in the document body.
4. **Tags are for discovery.** Use them loosely. The structured fields (type, source, status) are for queries.
