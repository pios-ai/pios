---
title: Recommended Vault Structure
description: Directory layout for a PiOS-compatible Markdown vault
---

# Vault Structure Template

```
vault/
├── Daily/              # Auto-generated daily digests and briefings
├── Data/
│   ├── Health/         # Health pipeline output
│   ├── Social/         # Communication summaries
│   ├── Photos/         # Photo diary entries
│   └── Calendar/       # Schedule data
├── Projects/
│   ├── inbox/          # New tasks awaiting triage
│   ├── active/         # Currently active projects and tasks
│   └── archive/        # Completed items
├── Journal/            # Personal reflections (manual or AI-assisted)
├── Knowledge/          # Research, notes, bookmarks
└── Scripts/            # Pipeline and agent scripts
```

## Directory purposes

**Daily/** — The AI writes here. One file per day with a morning briefing, synthesized from all data sources. This is what you read first each morning.

**Data/** — Raw-ish data from pipelines. Each subdirectory corresponds to a source plugin. Files are auto-generated and should not be manually edited.

**Projects/** — Task and project cards with YAML frontmatter. The inbox/ directory receives new items; triage moves them to active/ with priority and context.

**Journal/** — Your writing. Can be templated (see `frontmatter-schema.md`) but the content is yours. This is the primary human input to the system.

**Knowledge/** — Long-lived reference material. Research notes, bookmarks, learning logs.

**Scripts/** — Your pipelines and agents live here. Keep them in the vault so they're versioned alongside the data they produce.
