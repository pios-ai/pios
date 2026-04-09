# Contributing to PiOS

Thanks for your interest in contributing to PiOS. This project is a methodology-first repository — docs and design patterns are the primary deliverables, with code as supporting material.

## What we're looking for

### High value

- **Methodology articles**: Real-world experience building personal AI systems. Not theory — show what you built, what worked, what didn't.
- **Architecture patterns**: Reusable design patterns for data pipelines, agent orchestration, knowledge management.
- **Reference implementations**: Minimal, runnable code examples that demonstrate a specific pattern.
- **Templates**: Starter files, vault structures, configuration schemas.
- **Translations**: Making the methodology accessible in more languages.

### Also welcome

- Bug fixes in reference code
- Broken link fixes in docs
- Typo corrections
- Issue reports describing gaps in the methodology

### Not what we're building

- A product or framework to install
- A SaaS platform
- Vendor-specific integrations (keep examples generic or clearly labeled)

## How to contribute

### For docs and articles

1. Fork the repo
2. Create a branch: `git checkout -b docs/your-article-name`
3. Add your article to `docs/` with a clear filename
4. Include YAML frontmatter with title, date, and author
5. Submit a PR with a brief description of what the article covers

### For reference code

1. Fork the repo
2. Create a branch: `git checkout -b reference/your-example-name`
3. Add your code to `reference/` in its own directory
4. Include a README.md explaining what it demonstrates and how to run it
5. Keep dependencies minimal
6. Submit a PR

### For templates

1. Fork the repo
2. Add templates to `templates/` with clear naming
3. Include comments explaining each section
4. Submit a PR

## Style guidelines

### Documentation

- Write for developers who are building, not browsing
- Show real code, not pseudocode
- Include what went wrong, not just what worked
- Avoid marketing language
- Use concrete numbers and timelines when possible

### Code

- Minimal dependencies
- Clear comments
- Working examples (they should actually run)
- Python 3.11+ for Python examples

## Code of conduct

Be respectful, be constructive, be specific. We're here to help each other build better personal AI systems.

## Questions?

Open an issue or start a discussion. We prefer async communication.
