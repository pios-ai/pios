#!/bin/bash
# location plugin · triage-ingest hook
#
# Reads the location digest identified by triage-gate and emits a compact
# event for triage. It does not call any location provider.

set -uo pipefail

python3 <<'PY'
import json
import os

payload_raw = os.environ.get("PIOS_PLUGIN_GATE_PAYLOAD", "{}")
try:
    payload = json.loads(payload_raw or "{}")
except json.JSONDecodeError:
    payload = {}

path = payload.get("location_path") or ""
if not path or not os.path.isfile(path) or not os.access(path, os.R_OK):
    print(json.dumps({
        "events": [],
        "summary_for_triage": f"location: digest not readable: {path}",
    }, ensure_ascii=False))
    raise SystemExit(0)

try:
    with open(path, "r", encoding="utf-8") as fh:
        lines = fh.readlines()
except OSError:
    lines = []

title = ""
for line in lines:
    stripped = line.strip()
    if stripped.startswith("#"):
        title = stripped.lstrip("#").strip()
        break
if not title:
    title = os.path.splitext(os.path.basename(path))[0]

excerpt = ""
for line in lines:
    stripped = line.strip()
    if not stripped or stripped.startswith("#") or stripped == "---":
        continue
    if ":" in stripped and len(stripped.split(":", 1)[0]) < 32:
        continue
    excerpt = stripped[:220]
    break

event = {
    "kind": "location-update-available",
    "summary": "location digest updated",
    "location_path": path,
    "title": title[:140],
    "total_lines": len(lines),
    "excerpt": excerpt,
}
summary = f"location: new digest {os.path.basename(path)} ({len(lines)} lines). {title[:120]}"
print(json.dumps({"events": [event], "summary_for_triage": summary}, ensure_ascii=False))
PY
