"""
Afterward daemon — orchestrator that ties vault + shamir + heartbeat together.

Main loop:
    1. Poll heartbeat.check_state() periodically
    2. On ALIVE → SOFT_INVESTIGATION:
        - Send initial trustee outreach
        - Begin daily challenge sending
    3. On any state, collect trustee submissions from inbox
    4. On SOFT → ALIVE: cancel pending operations
    5. On SOFT → DEATH_CONFIRMED:
        - Reconstruct master key from collected shares
        - Decrypt instructions vault
        - Execute Actions queue
        - Register Missions

For v0:
    - File-based trustee submission inbox (no HTTP server)
    - Channel adapters are stubs (log to file, no real email/SMS)
    - Single user
    - Action execution = log + simulated send (no real delivery)

Usage:
    daemon = AfterwardDaemon.from_config_file("config.yaml")
    daemon.run_once()              # single iteration (for testing)
    daemon.run_forever(60)         # poll every 60 seconds
"""

from __future__ import annotations

import json
import logging
import os
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import List, Optional, Tuple

import yaml

from .heartbeat import (
    Config as HeartbeatConfig,
    HeartbeatMachine,
    STATE_ALIVE,
    STATE_DEATH,
    STATE_SOFT,
    _now,
    _iso,
    _virtual_days_since,
    _parse,
)
from .shamir import combine as shamir_combine
from .vault import decrypt as vault_decrypt

log = logging.getLogger("afterward.daemon")


# === channel adapters (v0 stubs) ===


class ChannelAdapter:
    """Stub: logs to file instead of real send. Real impl plugs in later."""

    def __init__(self, log_path: Path):
        self.log_path = log_path
        self.log_path.parent.mkdir(parents=True, exist_ok=True)

    def _emit(self, channel: str, to: str, subject: str, body: str):
        entry = {
            "at": _iso(_now()),
            "channel": channel,
            "to": to,
            "subject": subject,
            "body_preview": body[:200],
        }
        with self.log_path.open("a") as f:
            f.write(json.dumps(entry) + "\n")
        log.info(f"[{channel}] → {to} | {subject}")

    def send_email(self, to: str, subject: str, body: str):
        self._emit("email", to, subject, body)

    def send_sms(self, to: str, body: str):
        self._emit("sms", to, "(sms)", body)

    def send_pi_notification(self, body: str):
        owner_name = os.environ.get("PIOS_OWNER")
        if not owner_name:
            try:
                import json as _json
                cfg_path = os.path.join(os.path.expanduser('~'), '.pios', 'config.json')
                with open(cfg_path, 'r') as f:
                    owner_name = (_json.load(f) or {}).get('owner_name')
            except Exception:
                pass
        self._emit("pi-notification", owner_name or "owner", "(pi)", body)

    def send_to_recipient(self, recipient: dict, subject: str, body: str):
        """Generic: pick channel based on recipient config."""
        ch = recipient.get("default_channel", "email")
        if ch == "email":
            self.send_email(recipient.get("email", "unknown"), subject, body)
        elif ch == "sms":
            self.send_sms(recipient.get("phone", "unknown"), body)
        elif ch == "pi":
            self.send_pi_notification(body)
        else:
            log.warning(f"Unknown channel {ch} for recipient {recipient}")


# === trustee submission inbox (v0 file-based) ===


@dataclass
class TrusteeSubmission:
    trustee_idx: int
    share: str               # base64 share string
    evidence_ref: str        # path or URL
    submitted_at: str


class TrusteeSubmissionStore:
    """Watches inbox dir for trustee submissions.

    File format (one .json per submission):
        {
            "trustee_idx": 1,
            "share": "base64...",
            "evidence_ref": "death_cert.pdf",
            "submitted_at": "2026-04-21T10:00:00"
        }
    """

    def __init__(self, inbox_dir: Path):
        self.inbox_dir = inbox_dir
        self.inbox_dir.mkdir(parents=True, exist_ok=True)
        self.processed_dir = inbox_dir / "_processed"
        self.processed_dir.mkdir(exist_ok=True)

    def collect_new(self) -> List[TrusteeSubmission]:
        """Read new submission files; move processed ones to _processed/."""
        new = []
        for f in sorted(self.inbox_dir.glob("*.json")):
            try:
                data = json.loads(f.read_text())
                sub = TrusteeSubmission(
                    trustee_idx=int(data["trustee_idx"]),
                    share=data["share"],
                    evidence_ref=data.get("evidence_ref", ""),
                    submitted_at=data.get("submitted_at", _iso(_now())),
                )
                new.append(sub)
                f.rename(self.processed_dir / f.name)
            except (json.JSONDecodeError, KeyError, ValueError) as e:
                log.error(f"Bad submission file {f}: {e}")
        return new

    def collected_shares(self) -> List[Tuple[int, str]]:
        """All processed shares, for reconstruction."""
        shares = []
        seen = set()
        for f in sorted(self.processed_dir.glob("*.json")):
            try:
                data = json.loads(f.read_text())
                idx = int(data["trustee_idx"])
                if idx in seen:
                    continue
                seen.add(idx)
                shares.append((idx, data["share"]))
            except (json.JSONDecodeError, KeyError, ValueError):
                continue
        return shares


# === action / mission executor ===


class ActionExecutor:
    def __init__(
        self,
        vault_dir: Path,
        master_password: bytes,
        contacts: dict,
        channels: ChannelAdapter,
        audit_log: Path,
    ):
        self.vault_dir = vault_dir
        self.master_password = master_password
        self.contacts = contacts
        self.channels = channels
        self.audit_log = audit_log

    def _audit(self, event: str, data: dict):
        entry = {"at": _iso(_now()), "event": event, **data}
        self.audit_log.parent.mkdir(parents=True, exist_ok=True)
        with self.audit_log.open("a") as f:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")

    def execute_action(self, action: dict) -> bool:
        """Returns True on success, False on failure (for retry/escalation)."""
        action_id = action.get("id", "?")
        what_path = self.vault_dir / action["what"]
        to_id = action["to"]
        when = action.get("when", "immediate")

        # Decrypt the content file
        try:
            content = vault_decrypt(what_path.read_bytes(), self.master_password).decode("utf-8")
        except Exception as e:
            self._audit("action_decrypt_failed", {"action_id": action_id, "error": str(e)})
            return False

        # Resolve recipient
        recipient = self.contacts.get(to_id)
        if recipient is None:
            self._audit("action_unknown_recipient", {"action_id": action_id, "to": to_id})
            return False

        # Send
        subject = f"From owner: {action_id}"
        try:
            self.channels.send_to_recipient(recipient, subject, content)
            self._audit("action_sent", {
                "action_id": action_id,
                "to": to_id,
                "when": when,
                "content_length": len(content),
            })
            return True
        except Exception as e:
            self._audit("action_send_failed", {"action_id": action_id, "error": str(e)})
            return False

    def register_mission(self, mission: dict, registry_path: Path):
        """Append mission to Pi's ongoing duty roster (Pi will pick it up)."""
        registry_path.parent.mkdir(parents=True, exist_ok=True)
        existing = []
        if registry_path.exists():
            try:
                existing = yaml.safe_load(registry_path.read_text()) or []
            except yaml.YAMLError:
                existing = []
        existing.append({**mission, "registered_at": _iso(_now())})
        registry_path.write_text(yaml.safe_dump(existing, allow_unicode=True))
        self._audit("mission_registered", {"mission_id": mission.get("id", "?")})


# === main daemon ===


@dataclass
class DaemonConfig:
    base_dir: Path                       # afterward data dir (state, audit, inbox, vault)
    vault_dir: Path                      # location of *.enc files
    instructions_file: str = "vault/instructions.yaml.enc"
    contacts_file: str = "vault/contacts.yaml.enc"
    mission_registry: str = "missions_active.yaml"   # plaintext after decryption
    poll_interval_sec: int = 60
    challenge_interval_virtual_days: float = 1.0    # send challenge every N virtual days in SOFT
    heartbeat_config: HeartbeatConfig = field(default_factory=HeartbeatConfig.from_env)


class AfterwardDaemon:
    def __init__(self, config: DaemonConfig):
        self.config = config
        self.config.base_dir.mkdir(parents=True, exist_ok=True)
        self.heartbeat = HeartbeatMachine(
            self.config.base_dir / "heartbeat-state.json",
            config.heartbeat_config,
        )
        self.channels = ChannelAdapter(self.config.base_dir / "channels.log.jsonl")
        self.trustee_inbox = TrusteeSubmissionStore(self.config.base_dir / "trustee-inbox")
        self.audit_log = self.config.base_dir / "audit.log.jsonl"
        self._last_state = self.heartbeat.state
        self._last_challenge_sent_at: Optional[datetime] = None
        self._executed_death_actions = False  # idempotency guard

    def _audit(self, event: str, data: dict):
        entry = {"at": _iso(_now()), "event": event, **data}
        self.audit_log.parent.mkdir(parents=True, exist_ok=True)
        with self.audit_log.open("a") as f:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")

    # === per-state handlers ===

    def _on_enter_soft(self):
        log.info("Entered SOFT_INVESTIGATION — notifying trustees")
        self._audit("entered_soft", {})
        msg = (
            "Hi — Afterward daemon detected the account owner has been silent for 60+ days. "
            "Please help confirm his status. If you have death evidence, "
            "submit your Shamir share + evidence via your trustee link."
        )
        # In v0 stub: just log to channels. Real impl: per-trustee email/SMS.
        for trustee_idx in range(1, self.config.heartbeat_config.num_trustees + 1):
            self.channels.send_email(
                to=f"trustee-{trustee_idx}@example.com",
                subject="Afterward: status check needed",
                body=msg,
            )

    def _on_soft_tick(self):
        """Every poll while in SOFT: send daily challenge if due, ingest trustee submissions."""
        # Send daily challenge if it's been > 1 virtual day
        send_due = (
            self._last_challenge_sent_at is None
            or _virtual_days_since(self._last_challenge_sent_at)
            >= self.config.challenge_interval_virtual_days
        )
        if send_due:
            self.channels.send_pi_notification(
                "Daily challenge: please open Afterward UI and enter your vault password to confirm you're alive."
            )
            self._last_challenge_sent_at = _now()
            self._audit("daily_challenge_sent", {})

        # Ingest trustee submissions
        new = self.trustee_inbox.collect_new()
        for sub in new:
            self.heartbeat.record_trustee_confirmation(sub.trustee_idx, sub.evidence_ref)
            self._audit("trustee_confirmation_received", {
                "trustee_idx": sub.trustee_idx,
                "evidence_ref": sub.evidence_ref,
            })

    def _on_back_to_alive(self):
        log.info("State returned to ALIVE — cancelling pending operations")
        self._audit("returned_to_alive", {})
        self._last_challenge_sent_at = None
        # Note: trustee_confirmations were already cleared by heartbeat machine

    def _on_enter_death(self):
        if self._executed_death_actions:
            return
        log.warning("DEATH_CONFIRMED — beginning execution sequence")
        self._audit("entered_death", {})

        # Step 1: collect trustee shares
        shares = self.trustee_inbox.collected_shares()
        if len(shares) < self.config.heartbeat_config.death_threshold_trustees:
            self._audit("death_insufficient_shares", {"count": len(shares)})
            log.error(f"Not enough shares ({len(shares)}); cannot reconstruct")
            return

        # Step 2: reconstruct master password
        try:
            master_password = shamir_combine(shares[: self.config.heartbeat_config.death_threshold_trustees])
            self._audit("master_key_reconstructed", {"shares_used": self.config.heartbeat_config.death_threshold_trustees})
        except Exception as e:
            self._audit("shamir_combine_failed", {"error": str(e)})
            log.error(f"Failed to reconstruct master key: {e}")
            return

        try:
            # Step 3: decrypt instructions
            instructions_enc = self.config.base_dir / self.config.instructions_file
            instructions_yaml = vault_decrypt(instructions_enc.read_bytes(), master_password).decode("utf-8")
            instructions = yaml.safe_load(instructions_yaml)
            self._audit("instructions_decrypted", {"actions": len(instructions.get("actions", [])), "missions": len(instructions.get("missions", []))})

            # Step 4: decrypt contacts
            contacts_enc = self.config.base_dir / self.config.contacts_file
            if contacts_enc.exists():
                contacts_yaml = vault_decrypt(contacts_enc.read_bytes(), master_password).decode("utf-8")
                contacts = yaml.safe_load(contacts_yaml) or {}
            else:
                contacts = {}

            # Step 5: execute Actions
            executor = ActionExecutor(
                vault_dir=self.config.base_dir,
                master_password=master_password,
                contacts=contacts,
                channels=self.channels,
                audit_log=self.audit_log,
            )
            for action in instructions.get("actions", []):
                ok = executor.execute_action(action)
                if not ok:
                    log.warning(f"Action {action.get('id')} failed (will need manual followup)")

            # Step 6: register Missions
            mission_registry = self.config.base_dir / self.config.mission_registry
            for mission in instructions.get("missions", []):
                executor.register_mission(mission, mission_registry)

            self._executed_death_actions = True
            self._audit("death_execution_complete", {})

        finally:
            # Step 7: zero out master_password from memory (best effort)
            if isinstance(master_password, (bytes, bytearray)):
                try:
                    if isinstance(master_password, bytes):
                        # Can't actually zero immutable bytes; rely on GC
                        pass
                    else:
                        for i in range(len(master_password)):
                            master_password[i] = 0
                except Exception:
                    pass

    # === main loop ===

    def run_once(self):
        new_state = self.heartbeat.check_state()
        # Detect transitions
        if self._last_state == STATE_ALIVE and new_state == STATE_SOFT:
            self._on_enter_soft()
        elif self._last_state == STATE_SOFT and new_state == STATE_ALIVE:
            self._on_back_to_alive()
        elif self._last_state in (STATE_ALIVE, STATE_SOFT) and new_state == STATE_DEATH:
            self._on_enter_death()

        # Per-state work
        if new_state == STATE_SOFT:
            self._on_soft_tick()

        self._last_state = new_state
        return new_state

    def run_forever(self, poll_interval_sec: Optional[int] = None):
        interval = poll_interval_sec or self.config.poll_interval_sec
        log.info(f"Daemon starting (poll every {interval}s; time_compression={os.environ.get('AFTERWARD_TIME_COMPRESSION', '1')})")
        while True:
            try:
                self.run_once()
            except Exception as e:
                log.exception(f"Daemon iteration failed: {e}")
                self._audit("iteration_error", {"error": str(e)})
            time.sleep(interval)


# === CLI ===


def _cli():
    import argparse

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )

    parser = argparse.ArgumentParser(description="Afterward daemon")
    parser.add_argument("--base-dir", required=True, help="Afterward data directory")
    sub = parser.add_subparsers(dest="cmd", required=True)

    sub.add_parser("once", help="Run a single iteration (for testing)")

    run = sub.add_parser("run", help="Run forever, polling")
    run.add_argument("--interval", type=int, default=60, help="Poll interval seconds")

    sub.add_parser("status", help="Show heartbeat status without modifying")

    args = parser.parse_args()
    config = DaemonConfig(base_dir=Path(args.base_dir), vault_dir=Path(args.base_dir) / "vault")
    daemon = AfterwardDaemon(config)

    if args.cmd == "once":
        new_state = daemon.run_once()
        print(f"State after iteration: {new_state}")
    elif args.cmd == "run":
        daemon.run_forever(args.interval)
    elif args.cmd == "status":
        print(json.dumps(daemon.heartbeat.export_status(), indent=2))


if __name__ == "__main__":
    _cli()
