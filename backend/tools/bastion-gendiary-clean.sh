#!/bin/bash
# bastion-gendiary-clean.sh — wrapper that calls bastion-gendiary-run.exp and extracts only the BEGIN..END region
# Usage: ./bastion-gendiary-clean.sh "remote command"

set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
"$SCRIPT_DIR/bastion-gendiary-run.exp" "$@" 2>&1 \
  | awk '/===BEGIN===/{flag=1; next} /===END===/{flag=0} flag' \
  | sed 's/\r$//'
