# PiOS — Personal Intelligence Operating System

**A methodology for building AI systems that understand your life.**

PiOS is not a product you install. It's a set of design patterns, architecture guides, and reference implementations for building your own personal AI system — one that ingests your life data, maintains persistent memory, and acts as an intelligent partner rather than a stateless tool.

## What's here

```
docs/           Methodology articles (the main event)
reference/      Code examples and reference implementations
templates/      Starter templates for your own system
```

### `/docs/` — Methodology (start here)

| Article | What you'll learn |
|---------|-------------------|
| [Architecture Guide](docs/architecture-guide.md) | The 4-layer architecture for personal AI systems |
| [Getting Started](docs/getting-started-with-claude-code.md) | Build your first personal AI system from scratch |

### `/reference/` — Code examples

Minimal, runnable code that demonstrates the patterns described in the docs. These are starting points, not a framework.

### `/templates/` — Starter files

Vault structure templates, frontmatter schemas, and pipeline skeletons you can copy into your own project.

## Who is this for?

Developers who want to build a personal AI system — something that knows your health data, social context, projects, and daily patterns. Not a chatbot. Not a wrapper around an API. A system that runs continuously and compounds value over time.

## Background

PiOS grew out of 10 months of real daily use. The system manages health tracking, social data, project management, daily journaling, and content creation for its author — running on a Mac Mini with Claude Code, Obsidian, and a handful of Python scripts.

The methodology is being extracted and open-sourced because the patterns are more valuable than any specific implementation. Your data sources, your tools, and your workflows will differ. The architecture — how to layer data ingestion, knowledge storage, AI agents, and human feedback — transfers.

Read the full story: [Why open-source a methodology, not a product](docs/architecture-guide.md#why-most-personal-ai-projects-fail)

## Quick orientation

**If you want to understand the system design:** Start with [Architecture Guide](docs/architecture-guide.md).

**If you want to start building today:** Go to [Getting Started](docs/getting-started-with-claude-code.md).

**If you want to see code:** Check [reference/](reference/).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for how to contribute articles, code examples, translations, or feedback.

## License

MIT — see [LICENSE](LICENSE).

---

*PiOS is maintained by [Abe](https://github.com/CuriousAbe), a former CV startup founder turned personal AI practitioner.*
