# Stage 0 measurement results — tunable constants

Living document, populated as Stage 0 gates run. Each gate updates the
corresponding row; downstream stages cite this file rather than baking
the numbers into commit messages.

## Gate 0.B — Anthropic Sonnet 4.6 TTFT

**Bench:** `scripts/voice-latency-bench/sonnet-ttft-bench.mjs`
**Run date:** 2026-05-23
**Iterations:** 15 (first iteration treated as cold; remaining 14 as cached)
**Model:** `claude-sonnet-4-6`
**Prompt:** ~1.5k-token system header + ~1.5k-token state snapshot, both
with `cache_control.ephemeral.ttl=5m`. One 8-word user message. Forced
tool call to `record_extraction`.

| Metric | Value (ms) | Gate | Pass? |
|---|---|---|---|
| Cold TTFT (iter 1, cache_read=0) | 1119 | — | informational |
| Cold completion | 1679 | — | informational |
| **Cached TTFT P50** | **947** | ≤ 900 | **FAIL by 47ms (~5%)** |
| Cached TTFT P95 | 1344 | — | — |
| Cached TTFT p99 | 1344 | — | — |
| Cached completion P50 | 1611 | — | — |
| Cached completion P95 | 2058 | — | — |
| Cached completion p99 | 2058 | — | — |

**Verdict:** miss the gate by ~5%. Per PLAN_v3 §3.B fail action: "Stage
2 budgets relax; Stage 4 becomes the only sub-1s path." Concretely:

- Stage 2 cold budget (PLAN_v3 §2): 2.95–3.43 s → 3.0–3.5 s (add ~50ms
  on the Sonnet hop).
- Stage 2 warm budget (with Stage 0.F multi-context): 2.0–2.5 s →
  2.05–2.55 s. **Still hits the user's 2–2.5s goal** because the
  800ms BOS amortisation dominates the warm-path savings.
- Stage 4 fast-path: unaffected (skips Sonnet entirely).

**Tunable constants set by this gate:**

- `SONNET_TTFT_P50_MS = 947` — referenced in PLAN_v3 §2 budget table
  comments. Floor on any Sonnet-dependent latency budget.
- `SUGGESTED_SUPPRESSION_TTL_MS = 12000` — derived from
  `max(12000, p99_completion + 2000) = max(12000, 4058) = 12000`. TTL
  stays at the 12s default per PLAN_v2 §6.3. Re-derive in Stage 0
  cleanup if production p99 drifts above 9.5s.

## Gate 0.A — iOS PCM playback feasibility (pending Derek measurement)

| Metric | Value | Gate | Pass? |
|---|---|---|---|
| P50 `first_chunk_received → dataPlayedBack` | TBD | ≤ 100 ms | TBD |
| P95 inter-chunk audible gap | TBD | < 50 ms | TBD |

Bench surface: branch `voice-latency-stage0-bench` on `CertMateUnified`,
Settings → "VL Stage 0 Bench". Backend gate: set `STAGE0_BENCH=1`.

## Gate 0.C — ElevenLabs stream-input TTFB from eu-west-2

Pending.

| Metric | Value (ms) | Gate | Pass? |
|---|---|---|---|
| BOS → first audio P50 | TBD | ≤ 250 | TBD |

## Gate 0.D — Voice fidelity A/B (Turbo vs Flash, PCM vs MP3)

Pending — Derek listens to ~40 samples.

## Gate 0.E — iOS chunked HTTP throughput

Pending — iOS bench.

## Gate 0.F — ElevenLabs multi-stream-input evaluation

Pending. 7 operational pass criteria per PLAN_v3 §3.F.

## Gate 0.G — Transcript-replay harness

Pending. Pass criterion: 15 initial scenarios green in CI in < 5 min.
