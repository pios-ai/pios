# Afterward Architecture

> Version: 0.1 | Date: 2026-04-21 | Status: Draft

## 1. Design Principles

1. **User owns keys** — No company, no Pi, ever holds the master password in persistent storage
2. **Files, not database** — All state is files on disk (aligns with PiOS philosophy)
3. **Python core, Electron UI** — Core crypto/daemon in Python (can run without UI); UI is shell
4. **Self-hostable** — Zero cloud dependencies in Free tier
5. **Standardized protocol** — Death-trigger protocol spec is public; anyone can implement executor
6. **Testable** — Every component has time-compression mode for drill testing

---

## 2. Components

```
┌─────────────────────────────────────────────────────────────────┐
│                        Afterward                                 │
│                                                                  │
│  ┌───────────────┐   ┌──────────────┐   ┌──────────────────┐  │
│  │  Electron UI  │──▶│Node Bridge   │──▶│  Python Core     │  │
│  │  (renderer/)  │   │(backend/)    │   │  (core/)         │  │
│  │               │   │              │   │                  │  │
│  │ - Vault view  │   │IPC over stdio│   │- shamir.py       │  │
│  │ - Actions     │   │ or TCP       │   │- vault.py        │  │
│  │ - Missions    │   │              │   │- heartbeat.py    │  │
│  │ - Trustees    │   │              │   │- daemon.py       │  │
│  │ - Heartbeat   │   │              │   │                  │  │
│  │ - Drill       │   │              │   │                  │  │
│  └───────────────┘   └──────────────┘   └────────┬─────────┘  │
│                                                  │             │
│                                                  ▼             │
│                              ┌───────────────────────────────┐│
│                              │       Files on disk           ││
│                              │                               ││
│                              │  vault/       (*.enc)         ││
│                              │  config/      (non-sensitive) ││
│                              │  state/       (heartbeat log) ││
│                              │  audit/       (action log)    ││
│                              │  shares/      (testing only)  ││
│                              └───────────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘
```

---

## 3. Encryption Layer

**Reuses `obsidian-vault-encryptor` plugin format**:
- Cipher: AES-256-GCM
- KDF: PBKDF2-SHA256, 210,000 iterations
- File format: magic bytes (`OCENJ2`) + JSON header (salt + iv + iterations base64) + GCM ciphertext

**Why reuse**:
- User can encrypt/decrypt via Obsidian right-click (familiar UX)
- Afterward Python core can independently decrypt (same format)
- No custom crypto — battle-tested Web Crypto API + Python `cryptography`

**Vault files**:
```
vault/
  instructions.yaml.enc    # Actions + Missions schema (single source of truth)
  letters/
    *.md.enc               # Letters to recipients
  assets/
    *.md.enc               # Asset transfer docs
  briefs/
    *.md.enc               # Mission context briefs
```

---

## 4. Shamir Secret Sharing

- Lib: `pycryptodome.Protocol.SecretSharing` (GF(2^128))
- Threshold: 3-of-5 (抗 2 个 trustee 失联)
- Share format: base64 QR-encoded (easy physical backup)
- Master password **never stored anywhere persistent** — only in 5 trustee hands

**Trust-free verification**:
- Daemon can verify share validity without reconstructing master (commitment scheme)
- Detects bad shares early (trustee sent wrong content or got compromised)

---

## 5. Heartbeat State Machine

```
State: ALIVE
  Triggers:
    - Pass daily challenge in UI
    - Any heartbeat signal (vault write / PiOS activity / etc.)
  Actions: none (just log)

  Transitions:
    → SOFT_INVESTIGATION if 60 days no passive heartbeat

State: SOFT_INVESTIGATION
  Triggers:
    - Daemon sends daily challenge ping (email / SMS / WeChat / PiOS notification)
    - User must sign challenge with vault key
  Actions:
    - Begin trustee outreach (notify them of status, ask to prepare share)
    - Log all challenge attempts + responses

  Transitions:
    → ALIVE if user signs any one challenge
    → DEATH_CONFIRMED if 90 days no signed challenge
                       AND 3+ trustees submit share + death evidence

State: DEATH_CONFIRMED
  Triggers:
    - Threshold met
  Actions:
    - Reconstruct master key in memory
    - Decrypt instructions.yaml.enc
    - Queue all Actions + register all Missions
    - Execute

  Transitions:
    → DONE for Actions (once executed)
    → ETERNAL for Missions (Pi continues forever)
```

**Time compression**: Env var `AFTERWARD_TIME_COMPRESSION=30` (default) makes 1 day = 1 minute for testing. Full 150-day lifecycle = 2.5 hours in test mode.

---

## 6. Daily Challenge Protocol

owner's daily challenge is **not** "click button saying I'm alive" (spoofable).
It's **cryptographic signature** that only someone with vault master password can produce.

```
1. Daemon picks random nonce N
2. Daemon sends to user via UI / email / SMS: "Sign N"
3. User enters vault password in Afterward UI
4. UI derives signing key from password (PBKDF2)
5. UI signs N → signature S
6. UI sends S to daemon
7. Daemon verifies S against public key commitment
8. If valid → heartbeat reset
```

Password never leaves UI process. Signature is proof of possession.

**Anti-coercion**: If someone holds you at gunpoint, you still need to enter the password. They can't produce signature without it. Even if they get password, Shamir trustees still need to confirm death.

---

## 7. Instruction Schema

Single file `vault/instructions.yaml.enc`, parsed after decryption:

```yaml
version: 1

actions:           # one-shot deliveries
  - id: a1
    what: vault/letters/example.md.enc
    to: recipient-id
    via: channel-id
    when: immediate         # or +30days, 2044-06-15, event:xxx

missions:          # ongoing Pi duties
  - id: m1
    what: 描述这件事
    for: beneficiary-id
    how: trigger + action spec
    until: forever           # or event, date
    budget: annual-quota     # from Pi Foundation endowment
    escalate_to: human-id
    reference: vault/briefs/example.md.enc
```

See [schema/actions.example.yaml](schema/actions.example.yaml) and [schema/missions.example.yaml](schema/missions.example.yaml).

---

## 8. Trustee Protocol

**Onboarding** (by owner):
1. Generate 5 Shamir shares
2. Each trustee receives:
   - Share (QR code on paper + encrypted USB backup)
   - Contact info for Afterward daemon endpoint
   - Instruction sheet explaining what to do
   - Pre-shared challenge for identity verification

**Outreach** (by Daemon, in SOFT_INVESTIGATION):
- Multi-channel: email + SMS + WeChat + WhatsApp (防 spam filter)
- Unique URL per trustee (with signed token)
- Trustee lands on static page (GitHub Pages or Cloud service)
- Options: "still alive" / "investigating" / "confirmed dead + submit share"

**Submission** (by Trustee):
- Upload death evidence (certificate scan, obituary URL, etc.)
- Paste/scan Shamir share
- Sign pre-shared challenge (identity verification)
- Daemon validates all → count towards threshold

**Audit log** visible to all trustees (防 daemon 被 compromise)

---

## 9. UI Specification

See `renderer/` and `docs/onboarding.md` for full UX. Key screens:

1. **Home** — status at glance (current state, last heartbeat, next challenge, drill status)
2. **Vault** — file tree of encrypted items, add/edit/preview (memory-only decrypt)
3. **Actions** — YAML editor with validation + dry-run preview
4. **Missions** — YAML editor + budget/escalation viewer
5. **Trustees** — 5-slot manager with contact + last-ping + share-status
6. **Heartbeat** — state + history + today's challenge input
7. **Drill** — trigger test run with time compression
8. **Audit** — chronological log of all daemon actions

---

## 10. Open Questions (v0)

1. **Mobile companion** — required for daily challenge on the go, or rely on desktop?
2. **Trustee web UI** — self-host on GitHub Pages / provided by Cloud tier / custom domain?
3. **Multi-user on shared machine** — separate vault per user, or one per PiOS installation?
4. **Emergency override** — if user loses password, can 4-of-5 trustees reconstruct to let them recover? (tradeoff: convenience vs security)
5. **Mission budget funding** — how does Pi Foundation release money to Missions after death?
6. **Legal binding** — coordination with lawyer for will + Afterward to avoid conflict

---

## 11. Dependencies

- Python 3.11+
- `cryptography` (PBKDF2 + AES-GCM)
- `pycryptodome` (Shamir Secret Sharing)
- `pyyaml` (schema parsing)
- `aiohttp` (daemon HTTP endpoint for trustee submissions)
- Electron (same as PiOS — no new dep)
- `node-pty` or similar (for Node ↔ Python bridge)

---

## 12. Security Considerations

- **Session leaks**: Password entered in Afterward UI must not propagate to any log file / Claude session / system monitoring
- **Memory hygiene**: Master password cleared from memory after use (`ctypes.memset` or equivalent)
- **Trustee compromise**: Even if 2 trustees are compromised, vault is safe (3-of-5 threshold)
- **Daemon compromise**: Daemon alone cannot decrypt (needs trustee shares)
- **Time-compression prod leak**: `AFTERWARD_TIME_COMPRESSION` must be explicitly required in prod; default off
- **Legal tampering**: If authorities demand vault, company cannot comply (we don't have keys)

---

## 13. Next Implementation Steps (v0 order)

1. `core/vault.py` — port obsidian-vault-encryptor format to Python decrypt/encrypt
2. `core/shamir.py` — Shamir split/reconstruct wrapper
3. `schema/*.yaml` — finalize Actions + Missions schema
4. `core/heartbeat.py` — state machine with time compression
5. `core/daemon.py` — orchestrator + trustee outreach
6. `renderer/` — Electron views
7. `backend/` — Node bridge
8. `docs/` — onboarding + trustee guide + daemon protocol
9. Integration with PiOS Electron main process
10. Dogfood: owner installs, uses, drills quarterly
