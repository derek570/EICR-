# Voice Latency Sprint — Handoff (2026-05-23)

## Origin

Field session `C082FCAB-2BDB-4106-BD6E-52659A1DF6D4` (job `job_1779474064571`,
2026-05-23 ~10:33–10:38 UTC) showed two compounding latency / accuracy
problems Derek raised:

1. **Flux misrecognition**: `"circuit N"` transcribed as `"socket N"` or
   `"second N"` after a *"which circuit is X for"* ask. Reproduced at
   10:34:35 — Flux emitted both `"circuit 1"` and `"Socket 1."` within 1 ms
   for the same audio; the second was treated as a new utterance and wasted
   a Sonnet turn (~10 s).
2. **Audible-confirmation latency**: ~3–4 s from utterance-final to
   confirmation TTS playback, even when iOS regex already filled the field
   on screen at ~40 ms. Regex shortens what the inspector *sees* but not
   what they *hear*.

Derek wants planning that's comprehensive enough to skip the debug cycle.
This handoff captures locked scope decisions; planning artefacts will land
alongside.

## Locked scope decisions (Derek, 2026-05-23)

| Decision | Value | Notes |
|---|---|---|
| **Scope** | All four items in | (a) iOS regex-fast ElevenLabs TTS, (b) stream Sonnet → stream ElevenLabs, (c) suppress Sonnet's duplicate confirmation when regex announced, (d) telemetry + feature flags |
| **Failure fallback** | Silent — let Sonnet path catch up | If fast-TTS fails, inspector still hears Sonnet's slower confirmation ~3 s later. No double-speak, no on-device AVSpeech fallback. |
| **Voice** | Same ElevenLabs voice/model as today's Sonnet path | Inspector never hears a voice change mid-session. |
| **Codex CLI involvement** | During *planning* AND as final reviewer | Brainstorm angles + review PLAN.md. |

## Out of scope (record explicitly)

- Flux STT replacement / vendor switch.
- On-device AVSpeechSynthesizer fallback.
- The socket/second → circuit coercion in `stage6-answer-resolver.js`
  (separate scoped fix; can land alongside but is not part of this sprint's
  latency target).
- Web frontend (`web/`) — sprint is iOS + backend only.
- Backend extraction-model changes (Sonnet 4.6 → Haiku 4.5 routing). Was
  discussed but Derek chose voice quality consistency over speed; same
  reason here.

## Latency target (initial — to be validated by research)

Today (measured from session `C082FCAB`):
- Sonnet path: utterance-final → audible confirmation ≈ **3–4 s**
- Regex path: utterance-final → field on screen ≈ **40 ms**
- Regex path: utterance-final → audible confirmation ≈ **3–4 s**
  (regex shortcuts visual; audio still comes from Sonnet round)

Goal:
- Regex path audible: ≈ **<700 ms** (iOS → backend fast-TTS → ElevenLabs
  stream → iOS).
- Sonnet path audible: ≈ **1.5–2 s** (Sonnet stream → ElevenLabs stream
  chained).

If the latency budget research shows these are unachievable, plan adjusts.

## Constraints from project CLAUDE.md

- **Backend is shared with iOS and immutable during PWA-only work.** This
  is not PWA-only work, so backend changes are in scope — but every
  backend change must be reviewed against iOS canon and the data
  contract.
- **Infrastructure changes must come from source.** Any task-def env
  var (e.g. feature-flag defaults) lands in `ecs/task-def-backend.json`
  in the same commit as the code that reads it. No out-of-band AWS
  edits. The `scripts/check-task-def-env-drift.sh` guardrail enforces
  this in CI.
- **Auto-commit per logical unit.** Each slice ships its own commit
  with WHAT/WHY/WHY-THIS-APPROACH body.
- **No backwards-compat shims.** Single-user deployment; if a wire
  format changes, both ends ship together.

## Planning artefacts (this directory)

| File | Owner | Status |
|---|---|---|
| `HANDOFF.md` | this file — scope lock | ✅ |
| `RESEARCH_PIPELINE.md` | Claude Explore agent (EICR_Automation + CertMateUnified) | pending |
| `RESEARCH_APIS.md` | Claude general-purpose agent (web research) | pending |
| `CODEX_ANGLES.md` | Codex CLI brainstorm | pending |
| `PLAN.md` | synthesis | pending |
| `claude-review.md` | Plan agent against PLAN.md | pending |
| `codex-review.md` | Codex CLI ask-codex against PLAN.md | pending |
| `PLAN_v2.md` | reconciled, addresses every BLOCKER + IMPORTANT | pending |

## Resume rules

- Always read `HANDOFF.md` first.
- If `PLAN_v2.md` exists, that is the executable plan. `PLAN.md` is the
  pre-review draft.
- Do not start coding until Derek approves `PLAN_v2.md`.
