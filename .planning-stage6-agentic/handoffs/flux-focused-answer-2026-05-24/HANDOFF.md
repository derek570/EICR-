# Flux focused-answer turn detection — Handoff (2026-05-24)

## Origin

Field UX bug surfaced in conversation with Derek (2026-05-24): after Sonnet
emits an `ask_user` focused question (e.g. *"Which circuit is the shower
on?"*), the inspector replies with a single word like *"Eight."* — and
Flux STT sits on the interim transcript for "an eternity" before
finalising it. Symptom: grey/italic interim text in `TranscriptBarView`
for up to 5 seconds, then the answer dispatches to Sonnet.

Root cause: current Flux config (`DeepgramService.swift:679-723`) uses
defaults that are conservative for short answers —

```
eot_threshold        = 0.7    # default
eot_timeout_ms       = 5000   # default
eager_eot_threshold  = (unset, disabled)
```

Flux's turn-detection model is acoustic + semantic. *"Eight"* alone is
low-content; the model isn't confident enough to cross 0.7 quickly, so it
falls all the way to the 5000ms timeout backstop. This is the same
symptom Pipecat is tracking as
[issue #3643 (Sure/Yes hangs 5s)](https://github.com/pipecat-ai/pipecat/issues/3643)
— a known cross-stack pattern for semantic-EOT models.

## Locked scope decisions (Derek, 2026-05-24)

| Decision | Value | Notes |
|---|---|---|
| **Sprint scope** | Standalone — not folded into `voice-latency-2026-05-23` | That sprint targets TTS streaming latency (~3s → ~2s). This sprint targets STT turn-to-text in focused-answer mode (~5s → <800ms). Compounds with TTS work; should land alongside, not inside. |
| **Solution family** | Stay on Flux. Tune via Deepgram's native `Configure` mid-stream API. No vendor switch. | Web research confirmed Deepgram's `Configure` message updates `eot_threshold` / `eot_timeout_ms` / `keyterm` without reconnect ([source](https://deepgram.com/learn/flux-on-the-fly-configuration)). |
| **Trigger surface** | Per-ask_user lifecycle: tighten on `ask_user` TTS start, restore on first final OR 10s timeout. | Reuses existing `inFlightQuestion` state in `DeepgramRecordingViewModel.swift:2489-2509`. No new dialogue-state plumbing. |
| **Normal-dictation behaviour** | Unchanged. | Inspector still gets 3-4 minute sentences without chop. Focused-mode config is overlay-only. |
| **Codex CLI involvement** | Yes — already brainstormed 12 angles (CODEX_ANGLES.md). Will run codex-review on PLAN.md before code lands. | Mirrors voice-latency sprint's review-gate norm. |

## Out of scope (record explicitly)

- **Flux STT replacement / vendor switch.** Flux is in production since
  2026-04-27 and the issue is config, not vendor choice.
- **TTS-side latency.** That's the `voice-latency-2026-05-23` sprint.
- **Backend Sonnet streaming.** Same sprint as above.
- **Web frontend (`web/`).** This sprint is iOS + Deepgram URL params only.
- **`eager_eot_threshold` globally on.** Deepgram's launch post says
  it bumps LLM call volume 50-70%; scoping to focused-answer mode
  (~5% of session turns) is fine, global is not.
- **Pipecat-style semantic-completion markers (Pattern D).** Too big a
  refactor; saved for a follow-up if Flux `Configure` doesn't close
  the gap.

## Latency target

Today (measured indirectly via complaint + Flux defaults):
- Focused-answer utterance-final → audible confirmation: **up to ~5–8 s**
  (5s Flux backstop + 3s TTS pipeline)

Goal (this sprint, STT-only):
- Focused-answer utterance-final → Sonnet dispatch: **< 800 ms**
  (Flux `Configure` to `eot_threshold=0.5`, `eot_timeout_ms=1500`,
  `eager_eot_threshold=0.4`, eager event acted on)
- Combined with voice-latency sprint TTS streaming when it ships:
  utterance-end → audible "Got it, eight" ≈ **1.5–2 s**

## Constraints from project CLAUDE.md

- **Backend is shared with iOS and immutable during PWA-only work.** This
  sprint is iOS + Deepgram-config only — zero backend changes required
  in the recommended path. If we add Layer 2 (eager dispatch via
  backend), backend changes must be reviewed against iOS canon and the
  shared data contract.
- **Infrastructure changes must come from source.** No env var changes
  needed in the recommended path.
- **Auto-commit per logical unit.** Each slice ships its own commit
  with WHAT / WHY / WHY-THIS-APPROACH body.
- **No backwards-compat shims.** Single-user deployment.

## Planning artefacts (this directory)

| File | Owner | Status |
|---|---|---|
| `HANDOFF.md` | this file — scope lock | ✅ |
| `RESEARCH_PIPELINE.md` | Explore agent (codebase) | ✅ |
| `RESEARCH_APIS.md` | general-purpose agent (web) | ✅ |
| `CODEX_ANGLES.md` | Codex CLI brainstorm | ✅ |
| `PLAN.md` | synthesis | ✅ (pending Derek review) |
| `claude-review.md` | Plan agent against PLAN.md | pending Derek go-ahead |
| `codex-review.md` | Codex CLI ask-codex against PLAN.md | pending Derek go-ahead |
| `PLAN_v2.md` | reconciled, addresses every BLOCKER + IMPORTANT | pending Derek go-ahead |

## Resume rules

- Always read `HANDOFF.md` first.
- If `PLAN_v2.md` exists, that is the executable plan. `PLAN.md` is the
  pre-review draft.
- Do not start coding until Derek approves `PLAN.md` (or `PLAN_v2.md`
  once it exists).
- This sprint is **iOS + Deepgram URL/Configure params only** in the
  recommended path. Any backend change escalates to Derek before
  drafting.
