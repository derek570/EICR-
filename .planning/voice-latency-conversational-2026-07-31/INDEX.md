# Voice latency and conversational-mode plan batch

Status: **RUNTIME STATUS EXTERNAL — run the committed Plan 00 status command**
Prepared: 2026-07-31; Plan 00 bundle refreshed 2026-08-03

The tracked files in this directory are planning references, not runtime state. The [Plan 00 entry point](plan-00-gpt56-port-parity.md) contains the committed source-integrity and read-only ECS status command. Never copy a live HOLD/DONE state into this index.

## Current shipped baseline

- The GPT-5.6 provider resolver, session-owned clients and whole-loop provider fence shipped in `a45996a6`.
- Ordinary Stage-6 turns run GPT-5.6 Luna Fast. Observation-shaped turns run GPT-5.6 Terra Standard with low reasoning through the live router shipped in PR #147 (`60fd0f9d`).
- Plan 01's core explicit prompt cache shipped in PR #150 (`94f56eea`). Its retention evaluation and any 25-minute Terra re-warm remain draft supplement work after Plan 00.
- The conversational two-round loop remains authoritative. Loaded Barrel, eager endpointing, Deepgram/ElevenLabs tuning and cache keep-warm policy remain outside Plan 00.

## Reviewed Plan 00 bundle and dependency order

Plan 00 was RP-converged as three explicit, dependency-locked executions. Repository copies are reference-only and carry adjacent `executable:false` EP policies:

| Order | Reviewed reference | Purpose | Machine dependency |
|---|---|---|---|
| 00A | [Provider/tool/cost parity](plan-00-gpt56-port-parity/PLAN-00A-final.md) | Audit shipped provider/cache routing; close Responses tool-result and truthful per-round accounting gaps | None; explicit `--no-chain` only |
| 00B | [Trusted semantic oracle](plan-00-gpt56-port-parity/PLAN-00B-final.md) | Install the production-composed semantic oracle and dormant lifecycle/audibility hooks | Genuine merged/deployed 00A success + provenance artifact |
| 00C | [Three-day evidence gate](plan-00-gpt56-port-parity/PLAN-00C-final.md) | Ship Stage-A durable evidence machinery; Derek then performs the three field days | Genuine merged/deployed 00B success + expectation artifact |

The [umbrella reference](plan-00-gpt56-port-parity/PLAN-00-final.md) is permanently non-executable. The only valid sequence is `00A → 00B → 00C`; no child chains automatically.

## Remaining latency plans

**2026-08-07 — the Plan 00C formal evidence-gate dependency was stripped from every plan below (Derek: sole user, doesn't need a machine-checked gate for a personal go/no-go).** Luna is already live in production. Each plan's dependency line now reads "no formal Plan 00 gate required — proceed once the informal Luna field test feels solid." Genuine engineering order between plans (02 → 03 → 05, and 05 → 06) is unchanged — that's real cross-plan sequencing, not gate ceremony, and stays.

| Plan | Purpose | Dependency boundary |
|---|---|---|
| [01 — explicit prompt caching](plan-01-gpt56-explicit-prompt-cache.md) | Core cache is live; evaluate retention before any 25-minute Terra re-warm | None — small leftover supplement, mostly done |
| [02 — iOS incremental TTS](plan-02-ios-incremental-tts-streaming.md) | Play ElevenLabs PCM while chunks arrive | None — the one real build in this wave |
| [03 — persistent ElevenLabs session](plan-03-elevenlabs-persistent-session.md) | Reuse the TTS transport and test synthesis tuning | After Plan 02 (real order) |
| [04 — Deepgram Flux eager EOT](plan-04-deepgram-flux-eager-eot.md) | Measure turn-final speculation without sending half utterances | None, but its own internal safety gates (Phase 3 explicit go/no-go) stay — this plan carries real churn risk, see its safety classification |
| [05 — answer-user pre-synthesis](plan-05-answer-user-presynthesis-full-loop.md) | Overlap answer TTS without early playback | After Plan 02 (real order); Plan 03 recommended |
| [06 — conversational lane](plan-06-general-conversational-lane.md) | Preserve natural conversation while isolating certificate mutation | Plan 05 recommended; **this is a PRODUCT decision, not a latency fix — get Derek's explicit go/no-go before implementing** |
| [07 — Loaded Barrel audit](plan-07-loaded-barrel-value-audit.md) | Measure parked speculative audio before any reactivation decision | None — telemetry already shipped, this is nearly a pure decision now |

## Shared success metric

The target is mouth-stop to first audible confirmation/answer without sacrificing arbitrary natural-language turns. Report p50/p75/p95 and sample count by reading versus question, single versus multi-round, network, cache/TTS warmth and experiment cohort.

No plan may trade away the audio-first invariants: every applied dictated reading is spoken exactly once; cancelled/speculative work is never spoken or written; barge-in remains safe; and the complete conversational model loop stays authoritative until a separately reviewed evidence gate proves an alternative.
