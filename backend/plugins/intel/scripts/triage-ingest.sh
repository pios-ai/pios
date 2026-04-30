#!/bin/bash
# intel plugin · triage-ingest hook
#
# Reads new intel workspace reports identified by gate payload and emits
# structured events for triage. This script does not run scans; radar/intel
# tasks remain responsible for producing workspace reports.
#
# Output: single-line JSON per the on_ingest contract in
#   docs/components/plugin-system.md

set -uo pipefail

VAULT="${PIOS_VAULT:-$HOME/PiOS}"
WORKSPACE="${VAULT}/Pi/Agents/intel/workspace"

if command -v python3 >/dev/null 2>&1; then
  python3 <<'PY'
import json
import os

payload_raw = os.environ.get("PIOS_PLUGIN_GATE_PAYLOAD", "{}")
workspace = os.path.join(os.environ.get("PIOS_VAULT", os.path.expanduser("~/PiOS")), "Pi", "Agents", "intel", "workspace")

try:
    payload = json.loads(payload_raw or "{}")
except json.JSONDecodeError:
    payload = {}

paths = payload.get("report_paths") or []
if isinstance(paths, str):
    paths = [paths]

if not paths and workspace:
    candidates = []
    for root, dirs, files in os.walk(workspace):
      dirs[:] = [d for d in dirs if d != "scan-state"]
      for name in files:
          if not name.endswith(".md") or name == "README.md" or "sync-conflict" in name:
              continue
          full = os.path.join(root, name)
          try:
              candidates.append((os.path.getmtime(full), full))
          except OSError:
              pass
    candidates.sort(reverse=True)
    paths = [p for _, p in candidates[:1]]

events = []
for path in paths[:10]:
    if not os.path.isfile(path) or not os.access(path, os.R_OK):
        continue
    try:
        with open(path, "r", encoding="utf-8") as fh:
            lines = fh.readlines()
    except OSError:
        continue
    title = ""
    for line in lines:
        stripped = line.strip()
        if stripped.startswith("#"):
            title = stripped.lstrip("#").strip()
            break
    if not title:
        title = os.path.splitext(os.path.basename(path))[0]
    rel = os.path.relpath(path, workspace) if workspace else path
    events.append({
        "kind": "intel-report-available",
        "summary": "intel workspace report updated",
        "report_path": path,
        "relative_path": rel,
        "title": title[:140],
        "total_lines": len(lines),
    })

if events:
    first = events[0]
    summary = f"intel: {len(events)} new report(s). {first['relative_path']} ({first['total_lines']} lines). {first['title']}"
else:
    summary = "intel: no readable report paths from gate payload"

print(json.dumps({"events": events, "summary_for_triage": summary}, ensure_ascii=False))
PY
else
  printf '{"events":[],"summary_for_triage":"intel: python3 unavailable, cannot parse report payload"}\n'
fi
