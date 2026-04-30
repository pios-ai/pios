"""
Heartbeat state machine — core of Afterward deadman switch.

States:
    ALIVE                  normal operation
    SOFT_INVESTIGATION     suspect missing, daily challenges active, trustees notified
    DEATH_CONFIRMED        threshold met → daemon executes Actions + registers Missions

Transitions:
    ALIVE          → SOFT_INVESTIGATION  (passive silence > SOFT_DAYS)
    SOFT_INVESTIGATION → ALIVE           (any signed challenge)
    SOFT_INVESTIGATION → DEATH_CONFIRMED (no challenge for DEATH_DAYS AND trustee_threshold met)

Time compression:
    AFTERWARD_TIME_COMPRESSION env var (float, default 1).
    E.g. 1440 means 1 real minute = 1 virtual day → full 150-day lifecycle = 2.5h real.

State persists to JSON file. Daemon restart-safe.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import List, Optional, Union

STATE_ALIVE = "ALIVE"
STATE_SOFT = "SOFT_INVESTIGATION"
STATE_DEATH = "DEATH_CONFIRMED"


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(dt: Optional[datetime]) -> Optional[str]:
    return dt.isoformat() if dt else None


def _parse(iso_str: Optional[str]) -> Optional[datetime]:
    if not iso_str:
        return None
    return datetime.fromisoformat(iso_str)


def _time_compression() -> float:
    try:
        return float(os.environ.get("AFTERWARD_TIME_COMPRESSION", "1"))
    except ValueError:
        return 1.0


def _virtual_days_since(dt: Optional[datetime]) -> float:
    """How many virtual days have passed since dt (accounting for AFTERWARD_TIME_COMPRESSION)."""
    if dt is None:
        return 0.0
    elapsed_real = (_now() - dt).total_seconds()
    return (elapsed_real * _time_compression()) / 86400.0


# === config ===


@dataclass
class Config:
    soft_investigation_days: float = 60.0   # passive silence → SOFT
    death_challenge_days: float = 90.0       # in SOFT, no challenge → DEATH eligible
    death_threshold_trustees: int = 3        # unique trustees submitting evidence
    num_trustees: int = 5

    @classmethod
    def from_env(cls) -> "Config":
        return cls(
            soft_investigation_days=float(os.environ.get("AFTERWARD_SOFT_DAYS", "60")),
            death_challenge_days=float(os.environ.get("AFTERWARD_DEATH_DAYS", "90")),
            death_threshold_trustees=int(os.environ.get("AFTERWARD_TRUSTEE_THRESHOLD", "3")),
            num_trustees=int(os.environ.get("AFTERWARD_NUM_TRUSTEES", "5")),
        )


# === state ===


@dataclass
class StateData:
    state: str = STATE_ALIVE
    last_passive_heartbeat: Optional[str] = None
    last_challenge_pass: Optional[str] = None
    entered_soft_at: Optional[str] = None
    entered_death_at: Optional[str] = None
    trustee_confirmations: List[dict] = field(default_factory=list)
    transition_log: List[dict] = field(default_factory=list)
    version: int = 1

    def to_dict(self) -> dict:
        return {
            "state": self.state,
            "last_passive_heartbeat": self.last_passive_heartbeat,
            "last_challenge_pass": self.last_challenge_pass,
            "entered_soft_at": self.entered_soft_at,
            "entered_death_at": self.entered_death_at,
            "trustee_confirmations": self.trustee_confirmations,
            "transition_log": self.transition_log,
            "version": self.version,
        }

    @classmethod
    def from_dict(cls, d: dict) -> "StateData":
        return cls(
            state=d.get("state", STATE_ALIVE),
            last_passive_heartbeat=d.get("last_passive_heartbeat"),
            last_challenge_pass=d.get("last_challenge_pass"),
            entered_soft_at=d.get("entered_soft_at"),
            entered_death_at=d.get("entered_death_at"),
            trustee_confirmations=d.get("trustee_confirmations", []),
            transition_log=d.get("transition_log", []),
            version=d.get("version", 1),
        )


# === state machine ===


class HeartbeatMachine:
    def __init__(self, state_file: Union[str, Path], config: Optional[Config] = None):
        self.state_file = Path(state_file)
        self.config = config or Config.from_env()
        self.data = self._load()

    def _load(self) -> StateData:
        if self.state_file.exists():
            try:
                return StateData.from_dict(json.loads(self.state_file.read_text()))
            except (json.JSONDecodeError, KeyError) as e:
                raise RuntimeError(f"Corrupt state file {self.state_file}: {e}")
        # Initialize fresh
        data = StateData()
        data.last_passive_heartbeat = _iso(_now())
        data.last_challenge_pass = _iso(_now())
        self._save(data)
        return data

    def _save(self, data: Optional[StateData] = None):
        to_save = data or self.data
        self.state_file.parent.mkdir(parents=True, exist_ok=True)
        # Atomic write
        tmp = self.state_file.with_suffix(self.state_file.suffix + ".tmp")
        tmp.write_text(json.dumps(to_save.to_dict(), indent=2))
        tmp.replace(self.state_file)

    def _log_transition(self, from_state: str, to_state: str, reason: str):
        self.data.transition_log.append({
            "at": _iso(_now()),
            "from": from_state,
            "to": to_state,
            "reason": reason,
        })

    # === public API ===

    @property
    def state(self) -> str:
        return self.data.state

    def record_passive_heartbeat(self, source: str = "unknown"):
        """Any observable activity (vault write, PiOS usage, etc.)."""
        self.data.last_passive_heartbeat = _iso(_now())
        # Passive alone does NOT reset from SOFT — only signed challenge does
        self._save()

    def record_challenge_pass(self):
        """User entered password in UI and signed challenge successfully."""
        self.data.last_challenge_pass = _iso(_now())
        self.data.last_passive_heartbeat = _iso(_now())
        if self.data.state == STATE_SOFT:
            self._log_transition(STATE_SOFT, STATE_ALIVE, "challenge_passed")
            self.data.state = STATE_ALIVE
            self.data.entered_soft_at = None
            self.data.trustee_confirmations = []
        self._save()

    def record_trustee_confirmation(self, trustee_idx: int, evidence: str):
        """A trustee submitted death evidence + their share. Called by trustee protocol handler."""
        if self.data.state != STATE_SOFT:
            # Trustees shouldn't submit outside SOFT state, but record anyway for audit
            pass
        # Deduplicate by trustee_idx
        for c in self.data.trustee_confirmations:
            if c["trustee_idx"] == trustee_idx:
                return  # already submitted; no-op
        self.data.trustee_confirmations.append({
            "trustee_idx": trustee_idx,
            "submitted_at": _iso(_now()),
            "evidence": evidence,
        })
        self._save()

    def check_state(self) -> str:
        """Evaluate transitions. Call periodically (e.g. every N minutes via daemon)."""
        if self.data.state == STATE_ALIVE:
            last_passive = _parse(self.data.last_passive_heartbeat)
            last_challenge = _parse(self.data.last_challenge_pass)
            # Use max of passive + challenge (either counts as alive signal)
            last_signal = max((d for d in [last_passive, last_challenge] if d), default=None)
            elapsed = _virtual_days_since(last_signal)
            if elapsed >= self.config.soft_investigation_days:
                self._log_transition(
                    STATE_ALIVE, STATE_SOFT,
                    f"{elapsed:.1f}_virtual_days_silent"
                )
                self.data.state = STATE_SOFT
                self.data.entered_soft_at = _iso(_now())
                self._save()

        elif self.data.state == STATE_SOFT:
            last_challenge = _parse(self.data.last_challenge_pass)
            entered_soft = _parse(self.data.entered_soft_at)
            # Measure silence from max(last_challenge, entered_soft)
            ref = max((d for d in [last_challenge, entered_soft] if d), default=None)
            elapsed = _virtual_days_since(ref)
            has_threshold = len(self.data.trustee_confirmations) >= self.config.death_threshold_trustees
            if elapsed >= self.config.death_challenge_days and has_threshold:
                self._log_transition(
                    STATE_SOFT, STATE_DEATH,
                    f"{elapsed:.1f}_virtual_days_no_challenge_plus_{len(self.data.trustee_confirmations)}_trustees"
                )
                self.data.state = STATE_DEATH
                self.data.entered_death_at = _iso(_now())
                self._save()

        # STATE_DEATH is terminal — daemon executes actions; state doesn't revert
        return self.data.state

    def force_reset_to_alive(self, reason: str = "manual_reset"):
        """Emergency override — use with care (e.g. user recovered from coma)."""
        if self.data.state != STATE_ALIVE:
            self._log_transition(self.data.state, STATE_ALIVE, reason)
            self.data.state = STATE_ALIVE
            self.data.entered_soft_at = None
            self.data.entered_death_at = None
            self.data.trustee_confirmations = []
            self.data.last_challenge_pass = _iso(_now())
            self.data.last_passive_heartbeat = _iso(_now())
            self._save()

    def export_status(self) -> dict:
        """For UI display."""
        last_passive = _parse(self.data.last_passive_heartbeat)
        last_challenge = _parse(self.data.last_challenge_pass)
        entered_soft = _parse(self.data.entered_soft_at)

        days_since_passive = _virtual_days_since(last_passive) if last_passive else None
        days_since_challenge = _virtual_days_since(last_challenge) if last_challenge else None
        days_in_soft = _virtual_days_since(entered_soft) if entered_soft else None

        return {
            "state": self.data.state,
            "time_compression": _time_compression(),
            "virtual_days_since_passive_heartbeat": days_since_passive,
            "virtual_days_since_last_challenge": days_since_challenge,
            "virtual_days_in_soft_investigation": days_in_soft,
            "trustee_confirmations_count": len(self.data.trustee_confirmations),
            "trustee_threshold": self.config.death_threshold_trustees,
            "config": {
                "soft_investigation_days": self.config.soft_investigation_days,
                "death_challenge_days": self.config.death_challenge_days,
            },
        }


# === CLI for test / debug ===


def _cli():
    import argparse
    import sys

    parser = argparse.ArgumentParser(description="Afterward heartbeat state inspector")
    parser.add_argument(
        "--state-file",
        "-f",
        default="/tmp/afterward-test-state.json",
        help="State file path",
    )
    sub = parser.add_subparsers(dest="cmd", required=True)

    sub.add_parser("status", help="Show current state")
    sub.add_parser("check", help="Run check_state and print result")
    sub.add_parser("passive", help="Record passive heartbeat")
    sub.add_parser("challenge", help="Record challenge pass")

    tc = sub.add_parser("trustee", help="Record trustee confirmation")
    tc.add_argument("--idx", type=int, required=True)
    tc.add_argument("--evidence", default="test_evidence.pdf")

    sub.add_parser("reset", help="Force state back to ALIVE (emergency)")

    args = parser.parse_args()
    hm = HeartbeatMachine(args.state_file)

    if args.cmd == "status":
        print(json.dumps(hm.export_status(), indent=2))
    elif args.cmd == "check":
        new_state = hm.check_state()
        print(f"Current state: {new_state}")
        print(json.dumps(hm.export_status(), indent=2))
    elif args.cmd == "passive":
        hm.record_passive_heartbeat()
        print(f"Passive heartbeat recorded. State: {hm.state}")
    elif args.cmd == "challenge":
        hm.record_challenge_pass()
        print(f"Challenge recorded. State: {hm.state}")
    elif args.cmd == "trustee":
        hm.record_trustee_confirmation(args.idx, args.evidence)
        print(f"Trustee #{args.idx} confirmation recorded.")
        print(f"Total confirmations: {len(hm.data.trustee_confirmations)}")
    elif args.cmd == "reset":
        hm.force_reset_to_alive("cli_emergency_reset")
        print(f"Forced reset to ALIVE")


if __name__ == "__main__":
    _cli()
