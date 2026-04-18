# Web-rebuild phase-by-phase code review

Autonomous review run kicked off **2026-04-17 23:22** while the lead was asleep.

## Layout

```
reviews/
├── phases.tsv                    # phase id → commit → title manifest
├── run-codex.sh                  # sequential codex runner (rate-limit aware)
├── context/phase-{id}.md         # commit msg + stat + handoff doc (original plan)
├── claude/phase-{id}.md          # Claude subagent review per phase
├── codex/phase-{id}.md           # Codex-cli review per phase (openai)
├── codex/phase-{id}.raw.txt      # Codex full transcript (fallback)
├── logs/codex.log                # codex runner step-by-step log
├── logs/codex-state.log          # rate-limit events + last-40-line tails on detection
├── logs/codex.DONE               # marker file: codex loop finished
└── FIX_PLAN.md                   # consolidated plan (written only after BOTH review streams finish)
```

## Phases under review

| Phase | Commit    | Title |
|-------|-----------|-------|
| 0     | 881d437   | Ground-up rebuild foundation |
| 1     | 21a82b9   | Auth + dashboard + visual verification |
| 2     | 83b0863   | Job detail shell + 10 tabs (incl. 27283fd dash & 90bd238 iOS-parity rework) |
| 3a    | 25580d8   | Installation / Supply / Board tabs (iOS parity) |
| 3b    | 983a294   | Circuits tab + iOS action rail |
| 3c    | 88e7c4e   | Extent / Design / Inspection / Staff / PDF / Observations |
| 4a    | b0eb64c   | Recording overlay + transcript bar scaffold |
| 4b    | 72fb7da   | Real mic capture (AudioWorklet + RMS VU) |
| 4c    | 9e93907   | Direct Deepgram Nova-3 WebSocket + live transcripts |
| 4d    | b6c4b65   | Server-side Sonnet multi-turn extraction + field propagation |
| 4e    | 9f1dba6   | VAD sleep/wake + 3s ring buffer replay |
| 5a    | 35b5310   | CCU photo capture + GPT Vision merge |
| 5b    | 766735f   | Document extraction on Circuits tab |
| 5c    | 6a73517   | Observation photos |
| 5d    | cccd548   | LiveFillView (brand-blue flash on populate) |
| 6a    | 2ef8ec6   | Settings hub + inspector profiles |
| 6b    | 6e85e9e   | Company settings + company-admin dashboard |
| 6c    | bc11914   | System-admin user management |
| 7a    | eb72acc   | PWA foundation (Serwist, manifest, offline boundary) |
| 7b    | 4 commits | SW update handoff + IDB read-through + offline indicator + A2HS hint |
| 7c    | e64f756   | Offline mutation outbox + replay worker |

## Review methodology

Each phase is reviewed twice, independently, from the commit diff + working-tree state:

1. **Claude subagent** (Opus 4 via `Agent`): Structural review with 10 fixed sections — Summary / Alignment with plan / Correctness (P0/P1/P2) / Security / Performance / Accessibility / Code quality / Test coverage / Suggested fixes (file:line) / Verdict + top 3.
2. **Codex CLI** (`codex exec` v0.116.0, `gpt-5.4`, read-only sandbox): Same prompt template, same 10-section output. Runs sequentially to minimise rate-limit exposure. On rate-limit detection (last-40-lines regex), sleeps 5h15m then retries.

Both reviewers are given the per-phase context file (`context/phase-{id}.md`) which contains the commit message, `git show --stat`, and any applicable PHASE_*_HANDOFF.md — so both see the original intent, not just the diff.

## Aggregation

The consolidated fix plan (`FIX_PLAN.md`) is **only** produced after both review streams complete. That's a hard constraint from the lead — no pre-judgement before codex's independent verdict is in.

## Status

See `logs/codex.log` for live runner state. Each claude agent writes its review atomically to `claude/phase-{id}.md`; missing files mean that agent hasn't finished yet.
