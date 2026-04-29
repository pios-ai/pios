#!/bin/bash
# browser plugin · triage-ingest hook
#
# Reads PiBrowser sessions metadata and emits one compact event. It does not
# read message JSONL bodies; triage can decide separately whether to inspect
# a specific session.

set -uo pipefail

python3 <<'PY'
import json
import os

payload_raw = os.environ.get("PIOS_PLUGIN_GATE_PAYLOAD", "{}")
try:
    payload = json.loads(payload_raw or "{}")
except json.JSONDecodeError:
    payload = {}

sessions_json = (
    payload.get("sessions_json")
    or os.environ.get("PIOS_BROWSER_SESSIONS_JSON")
    or os.path.join(os.path.expanduser("~"), "Library", "Application Support", "PiOS", "sessions.json")
)

try:
    with open(sessions_json, "r", encoding="utf-8") as fh:
        data = json.load(fh) or {}
except Exception:
    print(json.dumps({
        "events": [],
        "summary_for_triage": f"browser: sessions.json not readable: {sessions_json}",
    }, ensure_ascii=False))
    raise SystemExit(0)

sessions = data.get("sessions") or []
active = [s for s in sessions if not s.get("archived")]
main = next((s for s in active if s.get("id") == "pi-main"), None)

def sort_key(session):
    return session.get("updatedAt") or session.get("createdAt") or ""

latest = sorted(active, key=sort_key, reverse=True)[0] if active else None

event = {
    "kind": "browser-session-state",
    "summary": "PiBrowser sessions metadata updated",
    "sessions_json": sessions_json,
    "active_sessions": len(active),
    "total_sessions": len(sessions),
    "active_id": data.get("activeId"),
    "has_pi_main": bool(main),
}
if latest:
    event.update({
        "latest_session_id": latest.get("id"),
        "latest_title": (latest.get("title") or "")[:120],
        "latest_engine": latest.get("engine") or "",
        "latest_updated_at": latest.get("updatedAt") or latest.get("createdAt") or "",
    })

summary = f"browser: {len(active)} active session(s), latest={event.get('latest_title') or event.get('latest_session_id') or 'none'}"
print(json.dumps({"events": [event], "summary_for_triage": summary}, ensure_ascii=False))
PY
