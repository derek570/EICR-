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

**Bench:** `scripts/voice-latency-bench/elevenlabs-ttfb-bench.mjs`
**Run date:** 2026-05-23 (from developer Mac in London; production
backend is also in eu-west-2, so numbers are representative within ~10ms)
**Iterations:** 15 single-shot WSes (no pool — matches Stage 2 default)
**Model:** `eleven_flash_v2_5`
**Output format:** `pcm_22050`
**Text:** `Circuit one. Number of points five.`

| Metric | Value (ms) | Gate | Pass? |
|---|---|---|---|
| **BOS → first audio P50** | **206** | ≤ 250 | **PASS** |
| BOS → first audio P95 | 1336 (iter 1 cold outlier) | — | informational |
| BOS → first audio min / max | 191 / 1336 | — | informational |
| WS open P50 | 133 | — | — |
| Total wall (WS open → isFinal) P50 | 435 | — | — |

Per-iter (ms): iter 1 = 1336 (cold), iters 2–15 = 191, 206, 207, 204, 206,
191, 193, 302, 201, 204, 219, 206, 195, 198. Cold is the WS handshake
populating; subsequent iters within the bench window stay sub-300ms.

**Verdict:** PASS. ~20% headroom on the gate. Confirms the
`BOS handshake = 800ms` line item in PLAN_v3 §2 — this bench shows
the steady-state value is 206ms, but the budget kept 800ms because it
was budgeting against the first-call cold path. The honest cold-only
budget number is ~340ms (133ms WS open + 206ms BOS→audio); update §2
accordingly when documenting Stage 0 results in Stage 1a startup-log.

**Tunable constants set by this gate:**

- `EL_BOS_TO_FIRST_AUDIO_P50_MS = 206`
- `EL_BOS_TO_FIRST_AUDIO_COLD_MS = 1336` (first-iter; informs decision
  on whether to keep one warm WS open per session even without multi-context
  — that's a Stage 0.F call)
- `EL_WS_OPEN_P50_MS = 133` — pure handshake floor on any cold-WS path

## Gate 0.D — Voice fidelity A/B (Turbo vs Flash, PCM vs MP3)

Pending — Derek listens to ~40 samples.

## Gate 0.E — iOS chunked HTTP throughput

Pending — iOS bench.

## Gate 0.F — ElevenLabs multi-stream-input evaluation

**PASS — 6/7 operational tests green; Test 6 is a bench-logic issue, not
an API limitation.** Full results in `STAGE0_RESULTS_MULTI_CONTEXT.md`.

Headline: per-context routing via `contextId` works, concurrent contexts
multiplex cleanly on one WS, closing one context doesn't affect the
others, account-level cap is ≥4 concurrent. **Warm Stage 2 reforecast
at ~2.09s P50 — HITS the user's 2–2.5s goal.**

Tunables:
- `EL_MULTI_CONTEXT_USABLE = true`
- `EL_MULTI_CONTEXT_INIT_TO_FIRST_AUDIO_MS = 214` (warm WS)
- `EL_MULTI_CONTEXT_CONCURRENT_PROVEN_CAP = 4`
- `EL_MULTI_CONTEXT_AUDIO_FRAME_KEY = "contextId"` (server uses camelCase!)

## Gate 0.G — Transcript-replay harness

Pending. Pass criterion: 15 initial scenarios green in CI in < 5 min.
