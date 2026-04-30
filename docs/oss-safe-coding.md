# OSS-safe coding patterns

> Why this exists: the PiOS source ships to `github.com/pios-ai/pios`. Anything written into commits eventually surfaces there. This doc lists the patterns that keep commits OSS-safe by default so the orphan-squash flow doesn't have to fix them at push time.

## Three layers of enforcement

| Layer | Mechanism | Scope |
|---|---|---|
| File content (staged additions) | `.githooks/pre-commit` runs `scripts/sanitize-lint.sh --staged-only` | Blocks commit if a tracked file gains an owner-specific literal |
| Commit message text | `.githooks/commit-msg` (this repo) | Blocks commit if message mentions owner / host / wxid |
| Author + committer email | `git config user.email noreply@pios-ai.org` (local repo) | Every new commit gets the project identity, not your Mac default |

These run on every commit if `git config core.hooksPath .githooks` is set. New clones must run that line once before the hooks fire.

## What "owner-specific" means

Anything that ties code to a specific person, machine, or account:

- Names (`Abe`, `yishi`)
- Mac model strings (`AbedeMacBook-Pro`)
- Hostnames (`abemac`, `abeworker`, `abehost`, `abeclaw`)
- File paths (`/Users/yishi/...`, `/home/abe/...`)
- WeChat IDs (`q7914079*`, `o9cq801*`)
- Tailscale IPs (`100.81.185.85` etc.)
- Any literal that a stranger reading the code wouldn't recognise as a config value

The full list lives in `scripts/sanitize-lint.sh` `PATTERNS` array — that's the source of truth. Don't duplicate it; read it.

## Helpers to use instead

| Need | Use this | Avoid |
|---|---|---|
| Owner display name | `vaultCtx.getOwnerName()` | string `'Abe'` |
| Vault root path | `vaultCtx.VAULT_PATH` or `~/.pios/config.json` `vault_root` | `/Users/<name>/PiOS` literal |
| Profile / health file path | `path.join(VAULT, ownerName, 'Profile', `${ownerName}_Profile.md`)` | `Abe/Profile/Abe_Profile.md` literal |
| User home dir | `process.env.HOME` (or `os.homedir()`) | `/Users/<name>` literal |
| Hostname → canonical id | `hostResolve.resolveHost()` (reads config aliases) | hard-coded `if hostname === 'abemac'` |
| WeChat / external IDs | Read from `~/.pios/config.json` (e.g. `wechat.owner_wxid`) | Inline literal in code |

## Code patterns

### ✅ DO: parameterise via config

```javascript
const ownerName = vaultCtx.getOwnerName();
const profilePath = path.join(VAULT, ownerName, 'Profile', `${ownerName}_Profile.md`);
const profile = fs.readFileSync(profilePath, 'utf-8');
const block = `## ${ownerName} 是谁\n${profile}`;
```

### ❌ DON'T: hard-code

```javascript
const profile = fs.readFileSync('/Users/yishi/L1_MyVault/Abe/Profile/Abe_Profile.md', 'utf-8');
const block = `## Abe 是谁\n${profile}`;
```

Both lines fail sanitize-lint (`yishi`, `Abe`, `/Users/yishi`).

### ✅ DO: write commit messages in generic terms

```
feat(pi-greet): inject owner profile into greeting prompt

Pi now reads the owner's TL;DR / health line / current status from
<vault>/<owner>/Profile/ before greeting, so it knows who it's talking to.
```

### ❌ DON'T: name owner / host

```
feat(pi-greet): inject Abe profile into greeting prompt

Pi now reads Abe's TL;DR + health from Abe/Profile/ on abemac before greeting.
```

Both `Abe` and `abemac` are blocked by the commit-msg hook.

## When you legitimately need to reference an owner-specific term

Sometimes you do — e.g. SOP doc references like "the abemac box" in an internal note that's not OSS-bound, or a debug comment. Use the override:

```bash
PIOS_LINT_ALLOW='abe-word,host-abemac' git commit ...
```

Each label maps to one pattern in `sanitize-lint.sh`. Allow only the ones you actually need, not blanket override. The label list is in the hook output when it blocks you.

**Hard bypass** (`git commit --no-verify`) is for genuine emergencies. It logs nothing, leaves no audit trail, and the commit still has to pass `--history` scan at push time anyway — so it's only buying you time, not actually skipping the gate.

## When introducing a new owner-specific concept

If you're writing code that needs to know about a per-owner value (their email, their primary chat ID, their preferred LLM, etc.):

1. Add the field to `~/.pios/config.json` schema (see `pios-installer.js` defaults)
2. Read it via a helper in `backend/vault-context.js` or a new lib module
3. The literal value lives in `~/.pios/config.json` (which is `.gitignore`'d at the vault level), never in code

Don't introduce a new owner-specific literal in code "for now, will refactor later" — sanitize-lint will block the commit and someone will have to do the refactor before any push works.

## Old history

The 100+ private-main commits before 2026-04-29 contain owner-specific content (paths, names, hostnames). The `orphan-squash` release flow strips them at push time — public users never see them. This doc only governs **new** commits going forward.

Eliminating the orphan-squash dance entirely would require `git filter-repo` to rewrite the old history. That's a several-hour one-time operation and breaks any external references to old commit hashes — not on the roadmap.
