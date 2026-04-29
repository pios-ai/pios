#!/bin/bash
# sanitize-lint.sh — pre-commit / pre-push secret-and-PII gate.
#
# Two pattern sources:
#   - Generic API-key / token / private-key shapes baked into this file.
#     Public-safe; anyone can ship them.
#   - Owner-specific patterns loaded at runtime from
#     $PIOS_LINT_EXTRA_PATTERNS (default: $HOME/.pios/sanitize-patterns.txt).
#     Each line is "label:regex" (ERE). Comments and blanks allowed.
#     This file is NOT committed to the repo; the regex bodies themselves
#     are the privacy denylist for whoever runs the hook.
#
# Usage:
#   bash scripts/sanitize-lint.sh                # scan working tree
#   bash scripts/sanitize-lint.sh --staged-only  # only staged content (pre-commit)
#   bash scripts/sanitize-lint.sh --history HEAD # all of git history (pre-push)
#
# Exit code:
#   0 — clean
#   1 — at least one pattern hit; output contains hits
#   2 — bad invocation
#
# Override one or more pattern labels (used when a doc legitimately
# references a flagged term):
#   PIOS_LINT_ALLOW='label1,label2' bash scripts/sanitize-lint.sh

set -uo pipefail

MODE="working-tree"
HISTORY_REF=""
case "${1:-}" in
  --staged-only) MODE="staged" ;;
  --history)
    MODE="history"
    HISTORY_REF="${2:-HEAD}"
    ;;
  --help|-h)
    sed -n '2,18p' "$0"
    exit 0
    ;;
  "") ;;
  *) echo "unknown arg: $1" >&2; exit 2 ;;
esac

# ── Pattern sources ─────────────────────────────────────────────────────────
#
# Two sources, by design:
#
#   1. GENERIC patterns (this file, public-safe). Industry-standard secret
#      shapes — anyone can write these out without leaking who is using
#      this lint. They detect anthropic/openai/github/aws/google API keys,
#      JWTs, PEM private key blocks, etc.
#
#   2. OWNER-SPECIFIC patterns (NOT in this file, NOT committed). Loaded
#      at runtime from $PIOS_LINT_EXTRA_PATTERNS, defaulting to
#      $HOME/.pios/sanitize-patterns.txt. Each line is "label:regex" with
#      `#` comments and blank lines allowed.
#
# Why split:
#   The owner-specific list IS the privacy denylist (real names, wxids,
#   private hostnames, private IPs, life events, etc.). If the lint
#   committed those to the public repo, the lint itself would become a
#   public index of "what counts as private to this user" — exactly the
#   thing the lint is supposed to prevent. (2026-04-28 codex review caught
#   this irony in commit `de1b7cc`.)
#
# To set up your owner-specific list (one-time):
#   mkdir -p ~/.pios
#   cat > ~/.pios/sanitize-patterns.txt <<'EOF'
#   # one "label:regex" per line; ERE syntax; lines starting with # ignored
#   real-name:Your Real Name
#   home-path:/Users/yourusername
#   private-hostname:\bmymachine\b
#   EOF
#   chmod 600 ~/.pios/sanitize-patterns.txt
#
# The repo never sees these. Pre-commit / pre-push hooks load them at
# runtime, scan with them, then forget them.

PATTERNS=(
  # — Generic API keys / tokens / PEM blocks (public-safe shapes) —
  # Tightened to avoid false positives like `sk-task-runtime-error`:
  # real keys don't contain dashes and are at least 40 chars after the
  # prefix.
  "anthropic-api-key:sk-ant-[A-Za-z0-9_-]{30,}"
  "openai-api-key-classic:sk-[A-Za-z0-9]{40,}"
  "openai-api-key-project:sk-proj-[A-Za-z0-9_-]{40,}"
  "github-personal-token:ghp_[A-Za-z0-9]{30,}"
  "github-fine-grained:github_pat_[A-Za-z0-9_]{50,}"
  "aws-access-key:AKIA[0-9A-Z]{16}"
  "google-api-key:AIzaSy[A-Za-z0-9_-]{30,}"
  "slack-token:xox[baprs]-[A-Za-z0-9-]{10,}"
  "stripe-live-secret-key:sk_live_[A-Za-z0-9]{24,}"
  "stripe-live-publishable-key:pk_live_[A-Za-z0-9]{24,}"
  "twilio-account-sid:AC[a-fA-F0-9]{32}"
  "azure-storage-account-key:AccountKey=[A-Za-z0-9+/]{50,}={0,2}"
  "npm-token:npm_[A-Za-z0-9]{36}"
  "private-key-pem:-----BEGIN [A-Z ]*PRIVATE KEY-----"
  "ssh-private-rsa:-----BEGIN RSA PRIVATE KEY-----"
)

_owner_patterns_path() {
  echo "${PIOS_LINT_EXTRA_PATTERNS:-$HOME/.pios/sanitize-patterns.txt}"
}

_warn_missing_owner_patterns() {
  local extra
  extra="$(_owner_patterns_path)"
  if [ ! -r "$extra" ]; then
    echo "WARN [sanitize-lint] owner-specific pattern file not found: $extra" >&2
    echo "WARN [sanitize-lint] running generic secret patterns only; create it from ~/.pios/sanitize-patterns.txt.example if needed." >&2
  fi
}

# Append owner-specific patterns from runtime file (not committed).
_load_owner_patterns() {
  local extra
  extra="$(_owner_patterns_path)"
  [ -r "$extra" ] || return 0
  local line
  while IFS= read -r line || [ -n "$line" ]; do
    # skip blanks
    [ -z "${line// }" ] && continue
    # skip comments
    case "$line" in '#'*) continue ;; esac
    # require label:regex shape
    case "$line" in *:*) PATTERNS+=("$line") ;; esac
  done < "$extra"
}
_load_owner_patterns

# Files / paths excluded from scan. These are always safe regardless of content.
# Keep this list tight — adding too much here defeats the purpose.
EXCLUDE_GLOBS=(
  ":(exclude)node_modules/**"
  ":(exclude)dist/**"
  ":(exclude).git/**"
  ":(exclude)**/.backup-pre-*/**"
  ":(exclude)**/*.asar"
  ":(exclude)scripts/sanitize-lint.sh"  # this file itself contains the patterns
  ":(exclude).githooks/pre-commit"      # may reference patterns in comments
  ":(exclude).githooks/pre-push"
  ":(exclude).githooks/commit-msg"      # defines the message-scanning patterns
  ":(exclude)docs/oss-safe-coding.md"   # teaches the patterns by example
)

# Allow-list (env var) lets a developer override one specific pattern when a
# legitimate use case is documented. Comma-separated label list.
ALLOW="${PIOS_LINT_ALLOW:-}"

_is_allowed() {
  local label="$1"
  [ -z "$ALLOW" ] && return 1
  local allowed=()
  IFS=',' read -ra allowed <<< "$ALLOW"
  for a in "${allowed[@]}"; do
    [ "$a" = "$label" ] && return 0
  done
  return 1
}

# ── scan implementations ─────────────────────────────────────────────────────

_scan_working_tree() {
  local label pattern
  local total_hits=0
  for entry in "${PATTERNS[@]}"; do
    label="${entry%%:*}"
    pattern="${entry#*:}"
    _is_allowed "$label" && continue

    # grep -I (skip binary), -E (ERE), -n (line numbers), -r (recursive)
    # Use git ls-files so .gitignore is respected automatically.
    local hits
    hits=$(git ls-files -- . "${EXCLUDE_GLOBS[@]}" 2>/dev/null \
           | xargs -I{} grep -InHE "$pattern" {} 2>/dev/null \
           | head -20)
    if [ -n "$hits" ]; then
      echo "❌ [$label] pattern: $pattern"
      echo "$hits" | sed 's/^/    /'
      total_hits=$((total_hits + $(echo "$hits" | wc -l | tr -d ' ')))
    fi
  done
  return $((total_hits > 0 ? 1 : 0))
}

_scan_staged() {
  # Only scan content that is actually being committed (staged diff).
  # Exclude self-referential files (sanitize-lint.sh, .githooks/*) — those
  # legitimately contain the patterns as source-of-truth definitions.
  local label pattern total_hits=0
  local staged_files
  staged_files=$(git diff --cached --name-only --diff-filter=ACM 2>/dev/null \
                 | grep -vE '^(scripts/sanitize-lint\.sh|\.githooks/(pre-commit|pre-push))$')
  [ -z "$staged_files" ] && return 0

  for entry in "${PATTERNS[@]}"; do
    label="${entry%%:*}"
    pattern="${entry#*:}"
    _is_allowed "$label" && continue

    local hits=""
    while IFS= read -r f; do
      [ -z "$f" ] && continue
      # Per-file diff so we know which file each hit belongs to.
      local file_hits
      file_hits=$(git diff --cached -U0 --diff-filter=ACM -- "$f" 2>/dev/null \
                  | grep -E "^\+" \
                  | grep -vE "^\+\+\+" \
                  | grep -nE "$pattern")
      if [ -n "$file_hits" ]; then
        hits+="${f}:"$'\n'"$file_hits"$'\n'
      fi
    done <<< "$staged_files"

    if [ -n "$hits" ]; then
      echo "❌ [$label] pattern: $pattern"
      echo "$hits" | head -20 | sed 's/^/    /'
      total_hits=$((total_hits + 1))
    fi
  done
  return $((total_hits > 0 ? 1 : 0))
}

_scan_history() {
  # Scan an entire branch's history, including commit metadata (author / msg /
  # tag annotations). Used by pre-push when target is the public repo.
  #
  # Self-exclusion: sanitize-lint.sh + .githooks/pre-commit + .githooks/pre-push
  # legitimately contain pattern definitions. Pass them as path-exclude specs
  # to git log -p so their diff hunks never enter the grep.
  local ref="$1"
  local label pattern total_hits=0
  local exclude_paths=(
    ":(exclude)scripts/sanitize-lint.sh"
    ":(exclude).githooks/pre-commit"
    ":(exclude).githooks/pre-push"
    ":(exclude).githooks/commit-msg"
    ":(exclude)docs/oss-safe-coding.md"
  )
  for entry in "${PATTERNS[@]}"; do
    label="${entry%%:*}"
    pattern="${entry#*:}"
    _is_allowed "$label" && continue

    local hits
    # %H = sha, %an / %ae / %cn / %ce = author/committer name+email, %B = full body
    hits=$(git log "$ref" -p --format="%H%n%an%n%ae%n%cn%n%ce%n%B" \
           -- . "${exclude_paths[@]}" 2>/dev/null \
           | grep -nE "$pattern" \
           | head -10)
    if [ -n "$hits" ]; then
      echo "❌ [$label] pattern: $pattern"
      echo "$hits" | sed 's/^/    /'
      total_hits=$((total_hits + 1))
    fi
  done
  return $((total_hits > 0 ? 1 : 0))
}

# ── dispatch ─────────────────────────────────────────────────────────────────

case "$MODE" in
  working-tree)
    _warn_missing_owner_patterns
    echo "[sanitize-lint] mode=working-tree (scanning all tracked files)"
    if _scan_working_tree; then
      echo "✅ all configured sanitize patterns clean"
      exit 0
    else
      echo ""
      echo "❌ sanitize-lint failed — fix the hits above before continuing."
      echo "   To override one pattern (only when truly legitimate, e.g. SOP doc"
      echo "   referencing the term):"
      echo "       PIOS_LINT_ALLOW='label1,label2' git commit ..."
      exit 1
    fi
    ;;
  staged)
    _warn_missing_owner_patterns
    echo "[sanitize-lint] mode=staged (only scanning staged additions)"
    if _scan_staged; then
      echo "✅ staged additions clean"
      exit 0
    else
      echo ""
      echo "❌ sanitize-lint failed on staged additions."
      echo "   Either fix the lines above, or, if this is a legitimate doc/SOP"
      echo "   reference, override:"
      echo "       PIOS_LINT_ALLOW='label1' git commit ..."
      exit 1
    fi
    ;;
  history)
    _warn_missing_owner_patterns
    echo "[sanitize-lint] mode=history ref=$HISTORY_REF (scanning commits + metadata)"
    if _scan_history "$HISTORY_REF"; then
      echo "✅ history clean across all commits, authors, committers, tags, messages"
      exit 0
    else
      echo ""
      echo "❌ sanitize-lint detected PII in git history."
      echo "   This blocks pushing to public remotes. Either:"
      echo "     1. Squash via orphan branch (see Pi/Config/pios-oss-release-flow.md)"
      echo "     2. Use \`git filter-repo\` to scrub the offending content"
      echo "   DO NOT bypass this check by pushing to a public remote."
      exit 1
    fi
    ;;
esac
