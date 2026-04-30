#!/bin/bash
# pios-auto-commit.sh — auto-commit Projects/pios/ working-tree drift after a worker run.
#
# Mirrors Pi/Tools/auto-commit.sh's themed-commit pattern, but for the pios
# repo (which is its own git repo, separate from the vault). Wired into
# pios-adapter.sh's finalize_run_record() so each successful worker exit
# triggers one pass.
#
# Behavior:
#   1. Reset backend/tools/* — that directory is rsynced from vault Pi/Tools/
#      every prebuild, so any drift there is reproducible. Owner-specific
#      paths in those scripts would otherwise trip sanitize-lint.
#   2. Group remaining drift by theme (backend / main / renderer / test /
#      docs / config / ios / mobile / plugin), one commit per theme.
#   3. Each commit goes through .githooks/{pre-commit,commit-msg} —
#      hooks gate sanitize-lint and PII scanning.
#   4. If a theme's commit is blocked by hooks, unstage that theme so the
#      remaining themes still commit; log the failure for owner review.
#   5. Untracked files inside a theme's paths are picked up by `git add`.
#
# Usage (called by adapter):
#   bash scripts/pios-auto-commit.sh <run_id> <agent_name>
#
# Manual run (sanity check / cleanup pass):
#   bash scripts/pios-auto-commit.sh manual local
#
# Exit code is always 0 — never block the adapter on auto-commit failures.

set -uo pipefail

RUN_ID="${1:-manual}"
AGENT="${2:-unknown}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PIOS_REPO="$(dirname "$SCRIPT_DIR")"
cd "$PIOS_REPO" || exit 0

VAULT="${PIOS_VAULT:-$(cd "$PIOS_REPO/../.." && pwd)}"
LOG_DIR="$VAULT/Pi/Log"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/pios-auto-commit-$(date +%F).log"

ts() { date +'%H:%M:%S'; }
log() { echo "[$(ts)] [$RUN_ID/$AGENT] $*" >> "$LOG"; }

# Single-flight lock so concurrent worker exits don't race
LOCK_DIR="$VAULT/Pi/State/locks/pios-auto-commit.lock.d"
mkdir -p "$(dirname "$LOCK_DIR")"
if mkdir "$LOCK_DIR" 2>/dev/null; then
  trap 'rmdir "$LOCK_DIR" 2>/dev/null' EXIT
else
  age=$(( $(date +%s) - $(stat -f %m "$LOCK_DIR" 2>/dev/null || stat -c %Y "$LOCK_DIR" 2>/dev/null || echo 0) ))
  if [ "$age" -gt 300 ]; then
    log "stale lock (age=${age}s), reclaiming"
    rmdir "$LOCK_DIR" 2>/dev/null
    mkdir "$LOCK_DIR" 2>/dev/null
    trap 'rmdir "$LOCK_DIR" 2>/dev/null' EXIT
  else
    log "another auto-commit running (age=${age}s), skip"
    exit 0
  fi
fi

# Quick exit if working tree is clean
if [ -z "$(git status -s 2>/dev/null)" ]; then
  log "clean — nothing to commit"
  exit 0
fi

log "starting (working tree dirty)"

# ── Step 1: reset backend/tools/* prebuild noise ──────────────────────────
# These files are rsynced from vault Pi/Tools/ on every `npm run prebuild`.
# They contain owner-specific paths (yishi / abemac etc.) that would trip
# sanitize-lint. Resetting them is safe — next build regenerates them.

if git status -s -- backend/tools/ 2>/dev/null | grep -q .; then
  count_m=$(git status -s -- backend/tools/ | grep -c '^.M' || true)
  count_u=$(git status -s -- backend/tools/ | grep -c '^??' || true)
  git checkout -- backend/tools/ 2>>"$LOG" || true
  git clean -fd backend/tools/ >>"$LOG" 2>&1 || true
  log "reset backend/tools/ — $count_m modified + $count_u untracked"
fi

# ── Step 2: themed commits ────────────────────────────────────────────────
# Order: more specific themes first so a path doesn't accidentally fall into
# a broader theme. Each entry: "label|space-separated paths".

THEMES=(
  "test|test/"
  "renderer|renderer/"
  "main|main/"
  "backend|backend/"
  "ios|ios/"
  "mobile|mobile-backend/ playwright.config.js tests/mobile-responsive.spec.js"
  "docs|docs/ README.md ARCHITECTURE.md INSTALL.md CLAUDE.md CHANGELOG.md"
  "config|package.json package-lock.json .githooks/ .github/ scripts/"
  "tests-fixture|tests/fixtures/"
)

COMMITTED=0
FAILED_THEMES=()

for entry in "${THEMES[@]}"; do
  label="${entry%%|*}"
  paths="${entry#*|}"

  # Only stage paths that actually exist (otherwise git add yells)
  for p in $paths; do
    [ -e "$p" ] && git add "$p" 2>>"$LOG"
  done

  # Anything actually staged for this theme?
  if ! git diff --cached --quiet 2>/dev/null; then
    n_files=$(git diff --cached --name-only | wc -l | tr -d ' ')
    summary=$(git diff --cached --shortstat 2>/dev/null)

    msg="auto($label): worker drift $n_files files [run=$RUN_ID]

${summary}

Co-Authored-By: PiOS auto-commit <noreply@pios-ai.org>"

    if git commit -m "$msg" >>"$LOG" 2>&1; then
      log "✓ $label: $n_files files committed"
      COMMITTED=$((COMMITTED + 1))
    else
      log "✗ $label: commit FAILED (hooks blocked); unstaging"
      git reset HEAD -- $paths 2>>"$LOG" || true
      FAILED_THEMES+=("$label")
    fi
  fi
done

# ── Step 3: report unmatched leftovers (left for owner to triage) ─────────

leftover=$(git status -s 2>/dev/null | wc -l | tr -d ' ')
if [ "$leftover" -gt 0 ]; then
  log "⚠ $leftover files NOT matched to any theme (left for owner triage):"
  git status -s | head -10 >> "$LOG"
fi

if [ ${#FAILED_THEMES[@]} -gt 0 ]; then
  log "⚠ themes blocked by hooks: ${FAILED_THEMES[*]} — run 'cd $PIOS_REPO && bash scripts/sanitize-lint.sh' to see why"
fi

log "done — committed=$COMMITTED, failed=${#FAILED_THEMES[@]}, leftover=$leftover"
exit 0
