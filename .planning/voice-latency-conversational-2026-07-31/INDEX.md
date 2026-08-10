# Voice latency and conversational-mode plan batch

Status: **ACTIVE — Plan 00 closed out; wave re-scoped 2026-08-10**
Prepared: 2026-07-31; Plan 00 bundle refreshed 2026-08-03; re-scoped 2026-08-10

The tracked files in this directory are planning references, not runtime state. The [Plan 00 entry point](plan-00-gpt56-port-parity.md) contains the committed source-integrity and read-only ECS status command. Never copy a live HOLD/DONE state into this index.

## 2026-08-10 re-scope (Derek)

The wave as authored buried ~4 genuine builds under cohort-measurement machinery. For a
**single-user** system that machinery is cost without a decision attached — the same failure
mode that made Plan 00 feel like wasted effort. Three changes, all approved 2026-08-10:

1. **Plans 01, 04 and 07 are trimmed to decision criteria.** Their measurement designs are
   replaced by "read the telemetry that already shipped, then decide". No new cohort
   apparatus is to be built for any of them.
2. **Execution order is now `Tier A → 08A → 08B → 02 → 06`**, with 03/04/05 reassessed after 02
   lands. Plan 08 is NEW and runs BEFORE plan 02; it was split into 08A/08B on 2026-08-10
   because every 08B lever is selected by data 08A produces.
3. **Plan 06 has an explicit GO** (Derek, 2026-08-10) and gets its own `/rp`. It remains a
   PRODUCT change, judged on usefulness/cost/distraction — not a latency plan, and not
   measured against the shared latency metric below.

### Tier A — execute directly, no `/rp`, no `/ep`

Each is a decision or a config change, not a build. Running these through the full refine
loop costs more than doing them.

| Item | Work | State (2026-08-10) |
|---|---|---|
| iOS TTS watchdog | `AlertManager.swift` had no playback timeout on any path. A ~32 s clip for a 3-word phrase hung the app silently (2026-08-07 field session). Must land before further extended field sessions. | **DONE** — `CertMateUnified` `fix/tts-playback-watchdog-2026-08-10`, builds clean. Duration-derived budget, generation-fenced, cancelled at `completeQueueHead`. |
| Plan 01 §5 | Probe `prompt_cache_retention:"24h"`; if retention holds, close the 25-minute Terra keep-alive proposal permanently. | **DONE — keep-alive NOT built.** `"24h"` is deprecated for GPT-5.6+, so fork 1 is unavailable. Fork 2 probed `RENEWS` (control-proven; base TTL bracketed to **[25, 50) min**) — but it is still refused on three grounds: a session-scoped timer cannot prevent the *only* cold writes that occur (session-open + content-driven key rotation); the largest observed inter-turn gap is **1.6 min** against a ≥25-min TTL, with **zero Terra turns** in 65 rounds; and at matched round index a cold 34,794-token prefill is **89 ms faster** than a warm one, so the prize is cost-only. |
| Plan 03 §3 | ElevenLabs synthesis tuning (`auto_mode`, `style`, normalization, speaker boost). Config-only, ear-tested, one variable at a time. | **MEASURED** — whole-vendor budget is ≈215 ms (66 ms handshake + 147 ms synthesis). Best arm saves 35 ms and is the riskiest; `auto_mode` is *worse* (+18 ms). Recommendation: change nothing. Ear test outstanding. |
| Plan 07 | Read shipped Loaded Barrel telemetry, record keep/narrow/retire. Build nothing. | **DONE — KEEP UNCHANGED.** Within-turn over 23 turns: the barrel removes ≈200–300 ms (non-loop residual p50 **204 ms** on hits vs **502 ms** on misses) and hits **78 %** of turns. The "hits are 35 % slower" between-groups read was confounded — the model loop is **96.2 %** of perceived latency, so raw comparison mostly compares turn difficulty. Phases 2–3 CUT. |

**Tier A is COMPLETE (2026-08-10), and it converged on one answer.** Four independent
measurements all point the same way — the latency is inside the model round, and everything
around it is already cheap:

| Measured | Result |
|---|---|
| Whole vendor budget (Plan 03) | ≈**215 ms** (66 ms handshake + 147 ms synthesis); best tuning arm saves 35 ms |
| Loaded Barrel (Plan 07) | already hides ~298 ms of that on **78 %** of turns |
| Cold 34,794-token prefill (Plan 01) | **free** — 89 ms *faster* than warm at matched round index |
| Model loop share of perceived latency (Plan 07) | **96.2 %** at p50 |

So the dictate→read-back latency is neither the vendor nor prompt ingestion. It is the model
**thinking**: round 0 spends ~3.8 s to emit ~101 output tokens, over a prefix that costs nothing
to load. That is exactly the gap Plan 08 was created to own, and it is now evidenced from three
directions rather than assumed. It is also the reason 03/04/05 stay held — they optimise the
≈215 ms that Plan 07 shows is already largely hidden.

### Tier B — worth the full `/rp` → `/ep` cycle

| Order | Plan | Why it earns a cycle |
|---|---|---|
| 1 | [08A — see inside a model round](plan-08a-stage6-round-instrumentation.md) | **AUTHORED 2026-08-10.** Telemetry settled where the latency is: summed round `stream_ms` ÷ perceived latency is **0.91–0.97** — model rounds are ~90 %+ of the loop, TTS is 3–9 %. But we cannot see *inside* a round. Three additive fields, zero behaviour change. **Small-plan lane** (Codex-only, cap 5). |
| 2 | [08B — round-efficiency levers](plan-08b-stage6-round-levers.md) | **HELD.** Every lever is selected by 08A's data and by Plan 07's verdict. Full dual-reviewer loop when unblocked. |
| 3 | [06 — conversational lane](plan-06-general-conversational-lane.md) | Explicit GO. Own `/rp`; will not converge in 2–4 rounds — history, echo re-ingestion and cost-loop surfaces are all real. |
| — | [02 — iOS incremental TTS](plan-02-ios-incremental-tts-streaming.md) | **DEMOTED to Tier C 2026-08-10** by Plan 07's verdict — see below. |

**Plan 02 is worth ~32 ms and has been demoted.** Incremental playback buys the synthesis tail —
Plan 03 measured that at 147 ms — and buys **exactly zero on a Loaded Barrel hit**, because the audio
is already synthesised and parked ~1.6 s before the loop completes. Plan 07 measured the hit rate at
**78 %**, so the amortised prize is `147 ms × 22 % ≈ 32 ms` against a 6.4 s p50: about **0.5 %**, in
exchange for an iOS build carrying a capability handshake and an exactly-once ACK. That is why it was
scoped for the full dual-reviewer loop, and it no longer earns one.

This was the "re-argue after 08A" caveat, and it resolved **earlier than expected and without 08A** —
Plan 07's within-turn data answered it directly, because Loaded Barrel already demonstrates what
overlapping the vendor is worth. 08A's `pre_tool_use_ms` split can still overturn this, but the
burden has moved: Plan 02 must now argue its way back in. **Do not open Plan 02's `/rp` before
reading it** — that is the substantive reason for the 08-before-02 order, not just sequencing.

### Tier C — held, reassess after 02

- **03 §1–2** (ElevenLabs connection pooling) — only if 02's numbers show vendor setup is still material.
- **04** — Phase 2 (no-text connection preparation) at most. Phase 1's cohort mandate is cut; Phase 3 stays dark and still requires its own explicit go/no-go.
- **05** — deferred. New prefetch cache + wire surface for a modest saving on question turns, which are a minority of turns for a single user.

### Token discipline for this wave

Last wave exhausted a Max plan in three days. Binding for this one:

- **Trim before refining.** Every reviewer re-reads the whole document every round, so
  document size multiplies across rounds × reviewers.
- **Small-plan lane where the rules permit** — Codex-only, round cap 5. Codex bills to a
  separate quota, so a Codex-only round is close to free in Max-plan terms; the Claude-side
  reviewer and the orchestrator are what actually burn it.
- **`--no-ship` on the first plan of the wave** so cost-per-plan is visible before the chain
  runs unattended.
- **Sonnet at high effort** for orchestration and `/ep`. Not Fable — it burns tokens at a
  much higher rate for this work. Codex stays at `gpt-5.6-sol high`; never downgrade the
  review model (a lesser model scored 0/9 on known findings).

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

| Plan | Purpose | Tier / dependency boundary |
|---|---|---|
| [01 — explicit prompt caching](plan-01-gpt56-explicit-prompt-cache.md) | Core cache is live; §5 evaluated retention and the Terra re-warm | **CLOSED** — keep-alive refused; cache is cost-only, not latency |
| [02 — iOS incremental TTS](plan-02-ios-incremental-tts-streaming.md) | Play ElevenLabs PCM while chunks arrive | **Tier B**, after 08 |
| [03 — persistent ElevenLabs session](plan-03-elevenlabs-persistent-session.md) | §3 tuning is Tier A (config-only); §1–2 pooling is held | **Split** — §3 Tier A, §1–2 Tier C after 02 |
| [04 — Deepgram Flux eager EOT](plan-04-deepgram-flux-eager-eot.md) | Phase 2 no-text connection preparation only | **Tier C** — Phase 1 cohort mandate cut; Phase 3 stays dark, still needs its own explicit go/no-go |
| [05 — answer-user pre-synthesis](plan-05-answer-user-presynthesis-full-loop.md) | Overlap answer TTS without early playback | **Tier C** — deferred |
| [06 — conversational lane](plan-06-general-conversational-lane.md) | Preserve natural conversation while isolating certificate mutation | **Tier B**, own `/rp`. **GO given 2026-08-10.** Still a PRODUCT change, not a latency fix |
| [07 — Loaded Barrel audit](plan-07-loaded-barrel-value-audit.md) | Decide keep/narrow/retire from telemetry that already shipped | **Tier A** — decision only, build nothing |
| [08A — see inside a model round](plan-08a-stage6-round-instrumentation.md) | Additive round telemetry: reasoning tokens, first-`tool_use` stamp, `ask_user` wait marking, timing on all seven post-completion paths | **Tier B, runs FIRST** — small-plan lane, zero behaviour change |
| [08B — round-efficiency levers](plan-08b-stage6-round-levers.md) | Cut per-round stream time and the multi-round tail | **HELD** — needs 08A field data + Plan 07 verdict |

## Shared success metric

The target is mouth-stop to first audible confirmation/answer without sacrificing arbitrary natural-language turns. Report p50/p75/p95 and sample count by reading versus question, single versus multi-round, network, cache/TTS warmth and experiment cohort.

No plan may trade away the audio-first invariants: every applied dictated reading is spoken exactly once; cancelled/speculative work is never spoken or written; barge-in remains safe; and the complete conversational model loop stays authoritative until a separately reviewed evidence gate proves an alternative.
