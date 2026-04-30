#!/usr/bin/env bash
# scripts/deploy.sh — PiOS one-shot deploy: local build + install + propagate to peers
#
# Pipeline:
#   npm run build:dir        # Electron bundle
#   npm run install:app      # install to /Applications/PiOS.app + local vault sync
#   <wait for syncthing>     # propagate vault to peer hosts
#   restart peer daemons     # services on peer hosts that depend on vault tools
#   verify                   # checksum vault tool on peer matches local
#
# Usage (run from Projects/pios/):
#   bash scripts/deploy.sh [--skip-build] [--skip-restart] [--skip-verify]
#
# Configuration (~/.pios/config.json):
#   {
#     "vault_root": "/path/to/your/vault",
#     "deploy": {
#       "peer_ssh":     "user@host",          // SSH target for peer (optional)
#       "peer_vault":   "/path/to/peer/vault",// vault path on the peer (optional)
#       "peer_daemons": ["service-a", ...]    // systemctl --user services to restart (optional)
#     }
#   }
#
# If `deploy` is missing or `peer_ssh` is empty, Steps 3 & 4 are skipped automatically —
# the script still does a useful local build + install. Single-host users need no extra config.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# --- CLI args ---
SKIP_BUILD=0
SKIP_RESTART=0
SKIP_VERIFY=0
for arg in "$@"; do
  case "$arg" in
    --skip-build)   SKIP_BUILD=1 ;;
    --skip-restart) SKIP_RESTART=1 ;;
    --skip-verify)  SKIP_VERIFY=1 ;;
    --help|-h)
      echo "Usage: bash scripts/deploy.sh [--skip-build] [--skip-restart] [--skip-verify]"
      exit 0
      ;;
  esac
done

# --- Read config ---
PIOS_CONFIG="$HOME/.pios/config.json"
VAULT_ROOT=""
PEER_SSH=""
PEER_VAULT=""
PEER_DAEMONS=""

if [ -f "$PIOS_CONFIG" ]; then
  read VAULT_ROOT PEER_SSH PEER_VAULT PEER_DAEMONS < <(python3 -c "
import json, sys
d = json.load(open(sys.argv[1]))
deploy = d.get('deploy', {}) or {}
daemons = ' '.join(deploy.get('peer_daemons') or [])
print(
    d.get('vault_root', '') or '-',
    deploy.get('peer_ssh', '') or '-',
    deploy.get('peer_vault', '') or '-',
    daemons or '-',
)
" "$PIOS_CONFIG" 2>/dev/null || echo "- - - -")
fi
[ "$VAULT_ROOT"   = "-" ] && VAULT_ROOT=""
[ "$PEER_SSH"     = "-" ] && PEER_SSH=""
[ "$PEER_VAULT"   = "-" ] && PEER_VAULT=""
[ "$PEER_DAEMONS" = "-" ] && PEER_DAEMONS=""

if [ -z "$VAULT_ROOT" ]; then
  VAULT_ROOT="$HOME/PiOS_Vault"
  echo "[deploy] vault_root not in config.json, fallback: $VAULT_ROOT"
fi

# Peer steps require both peer_ssh and peer_vault. Otherwise auto-skip with notice.
HAS_PEER=0
if [ -n "$PEER_SSH" ] && [ -n "$PEER_VAULT" ]; then
  HAS_PEER=1
fi

echo ""
echo "╔══════════════════════════════════════════════╗"
echo "║         PiOS deploy.sh                       ║"
echo "╚══════════════════════════════════════════════╝"
echo "[deploy] vault_root: $VAULT_ROOT"
if [ "$HAS_PEER" -eq 1 ]; then
  echo "[deploy] peer       : $PEER_SSH  vault: $PEER_VAULT"
  [ -n "$PEER_DAEMONS" ] && echo "[deploy] daemons    : $PEER_DAEMONS"
else
  echo "[deploy] peer       : (none configured — single-host mode)"
fi
echo ""

# ─────────────────────────────────────────────────────────────────
# Step 1: Build
# ─────────────────────────────────────────────────────────────────
if [ "$SKIP_BUILD" -eq 0 ]; then
  echo "[deploy] Step 1/4 — npm run build:dir"
  cd "$ROOT"
  npm run build:dir
  echo "[deploy] build done ✓"
else
  echo "[deploy] Step 1/4 — build skipped (--skip-build)"
fi

# ─────────────────────────────────────────────────────────────────
# Step 2: install:app (includes local vault sync via install-app.sh)
# ─────────────────────────────────────────────────────────────────
echo ""
echo "[deploy] Step 2/4 — npm run install:app (includes vault sync)"
cd "$ROOT"
npm run install:app
if [ "$HAS_PEER" -eq 1 ]; then
  echo "[deploy] install:app done ✓  (syncthing will propagate vault to peer)"
else
  echo "[deploy] install:app done ✓"
fi

# Local reference checksum (used by Step 4 verify)
LOCAL_MD5=$(md5 "$VAULT_ROOT/Pi/Tools/pios-tick.sh" 2>/dev/null | awk '{print $NF}' || \
            md5sum "$VAULT_ROOT/Pi/Tools/pios-tick.sh" 2>/dev/null | awk '{print $1}' || \
            echo "unknown")
echo "[deploy] local pios-tick.sh md5: $LOCAL_MD5"

# ─────────────────────────────────────────────────────────────────
# Step 3: restart configured daemons on peer
# ─────────────────────────────────────────────────────────────────
echo ""
if [ "$HAS_PEER" -eq 0 ]; then
  echo "[deploy] Step 3/4 — no peer configured, skip"
elif [ "$SKIP_RESTART" -eq 1 ]; then
  echo "[deploy] Step 3/4 — daemon restart skipped (--skip-restart)"
elif [ -z "$PEER_DAEMONS" ]; then
  echo "[deploy] Step 3/4 — no peer_daemons configured, skip"
else
  echo "[deploy] Step 3/4 — restarting daemons on $PEER_SSH"
  for daemon in $PEER_DAEMONS; do
    if ssh -o ConnectTimeout=5 "$PEER_SSH" \
         "systemctl --user is-active $daemon >/dev/null 2>&1"; then
      ssh "$PEER_SSH" "systemctl --user restart $daemon"
      echo "[deploy] $daemon restarted on peer ✓"
    else
      echo "[deploy] $daemon not running on peer, skip restart"
    fi
  done
fi

# ─────────────────────────────────────────────────────────────────
# Step 4: wait for syncthing + verify peer vault checksum
# ─────────────────────────────────────────────────────────────────
echo ""
if [ "$HAS_PEER" -eq 0 ]; then
  echo "[deploy] Step 4/4 — no peer configured, skip"
elif [ "$SKIP_VERIFY" -eq 1 ]; then
  echo "[deploy] Step 4/4 — verify skipped (--skip-verify)"
else
  echo "[deploy] Step 4/4 — waiting 30s for syncthing to propagate to peer..."
  sleep 30

  REMOTE_MD5=$(ssh -o ConnectTimeout=5 "$PEER_SSH" \
    "md5sum $PEER_VAULT/Pi/Tools/pios-tick.sh 2>/dev/null | awk '{print \$1}'" 2>/dev/null || echo "ssh-failed")

  echo "[deploy] peer pios-tick.sh md5: $REMOTE_MD5"

  if [ "$LOCAL_MD5" = "$REMOTE_MD5" ]; then
    echo "[deploy] ✓ pios-tick.sh identical on peer"
  else
    echo "[deploy] ⚠ pios-tick.sh mismatch — syncthing may need more time" >&2
    echo "[deploy]   local: $LOCAL_MD5" >&2
    echo "[deploy]   peer : $REMOTE_MD5" >&2
    echo "[deploy]   hint: wait ~60s and re-run with --skip-build --skip-restart" >&2
    exit 1
  fi
fi

echo ""
echo "╔══════════════════════════════════════════════╗"
echo "║  ✓ deploy complete                           ║"
echo "╚══════════════════════════════════════════════╝"
echo ""
echo "  local app : /Applications/PiOS.app  (updated)"
echo "  vault     : $VAULT_ROOT/Pi/Tools/   (synced)"
if [ "$HAS_PEER" -eq 1 ]; then
  echo "  peer vault: $PEER_VAULT/Pi/Tools/   (verified via syncthing)"
fi
echo "  cron workers pick up new pios-tick.sh on next tick (≤5min)"
echo ""
