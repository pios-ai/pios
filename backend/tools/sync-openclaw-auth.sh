#!/bin/bash
# sync-openclaw-auth.sh — 从 PiOS credentials.json 同步 OpenAI token 到 OpenClaw
# 由 cron 每小时执行

set -euo pipefail

CREDS="/home/$USER/PiOS/Pi/Config/credentials.json"
OPENCLAW_AUTH="/home/$USER/.openclaw/agents/main/agent/auth-profiles.json"

if [ ! -f "$CREDS" ]; then
  echo "$(date -Is) ERROR: credentials.json not found" >&2
  exit 1
fi

# Extract fresh access token from PiOS credentials
FRESH_TOKEN=$(python3 -c "
import json, sys
with open(\"$CREDS\") as f:
    d = json.load(f)
codex = d.get(\"providers\",{}).get(\"codex-cli\",{})
accounts = codex.get(\"accounts\",{})
active = codex.get(\"active_account\",\"\")
if active and active in accounts:
    token = accounts[active].get(\"accessToken\",\"\")
    if token:
        print(token)
        sys.exit(0)
sys.exit(1)
" 2>/dev/null)

if [ -z "$FRESH_TOKEN" ]; then
  echo "$(date -Is) ERROR: no access token in credentials.json" >&2
  exit 1
fi

# Check if OpenClaw auth already has this token (skip if same)
CURRENT_TOKEN=$(python3 -c "
import json
with open(\"$OPENCLAW_AUTH\") as f:
    d = json.load(f)
p = d.get(\"profiles\",{})
for k,v in p.items():
    if v.get(\"provider\") == \"openai-codex\" and v.get(\"type\") == \"oauth\":
        print(v.get(\"access\",\"\")[:50])
        break
" 2>/dev/null)

FRESH_PREFIX="${FRESH_TOKEN:0:50}"
if [ "$CURRENT_TOKEN" = "$FRESH_PREFIX" ]; then
  echo "$(date -Is) OK: token already current"
  exit 0
fi

# Update OpenClaw auth-profiles.json
python3 -c "
import json, time

token = 

with open(\"$OPENCLAW_AUTH\") as f:
    auth = json.load(f)

for k, v in auth[\"profiles\"].items():
    if v.get(\"provider\") == \"openai-codex\" and v.get(\"type\") == \"oauth\":
        v[\"access\"] = token
        v[\"expires\"] = int(time.time() * 1000) + 86400000  # 24h
        break

with open(\"$OPENCLAW_AUTH\", \"w\") as f:
    json.dump(auth, f, indent=2)

print(\"updated\")
"

echo "$(date -Is) OK: token synced to OpenClaw"
