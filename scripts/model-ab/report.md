# Model A/B — GPT-5.6 Luna vs Haiku 4.5 on the field-replay corpus (LIVE)

**Run 2 (corrected):** 2026-07-31, same 9 real captured field utterances, live through the real Stage 6 extraction harness. This run fixes two things found after Run 1: (1) Luna now goes through a **new Responses-API adapter** with reasoning ON, instead of Chat Completions with reasoning forced off; (2) the **cost model now includes cache-write tokens on both sides**, which Run 1 silently dropped, and uses OpenAI's *official* pricing ($1.20/1M output, not the $0.60 an OpenRouter listing showed).

**Run 3 (latency root-cause, same day):** dug into WHY Luna measured ~3× slower in Run 2. Finding, in order of discovery: (1) isolated single-turn re-runs of the exact same slow fixture completed in ~4s, not 17.7s; (2) 10 back-to-back/concurrent identical calls showed zero degradation, ruling out simple queueing; (3) repeating the same fixture through the real harness produced a WIDE, high distribution (3.4–18.4s, median ~10s) — not a clean "usually fast" pattern; (4) further probing hit a real **HTTP 429** — confirmed directly via response headers: this org's TPM (tokens-per-minute) limit for `gpt-5.6-luna` is 200,000, and this system's real prompt is ~33k tokens/call; (5) directly tested whether prompt caching lowers what counts against that ceiling — **it does not**: a call with a ~100%-cache-hit still reported the full ~33k `input_tokens` against the quota, unchanged from a cold-cache call (caching only discounts the bill, not the rate-limit charge); (6) but the ceiling refills continuously (~3,333 tokens/sec), and reading the rate-limit headers across calls spaced several seconds apart showed no depletion at all — meaning the ceiling likely only binds during BURSTS of rapid multi-round turns, not at normal conversational pace. See § Latency root-cause below for the full breakdown and what's still unproven.

## Headline

| Metric | Haiku 4.5 | GPT-5.6 Luna | Verdict |
|---|---|---|---|
| Readings agreement | — | **8/9 (88.9%)** | Same single miss as Run 1 — reasoning-on did NOT fix it |
| Corpus cost | $0.1349 | **$0.0486 (0.36×, ~2.8× cheaper)** | ✅ real, but smaller than Run 1's (buggy) 5× |
| Latency, mean/turn | 3263ms | **9707ms (2.97× slower)** | ❌ looping is fixed, but Luna is genuinely ~3× slower |
| Latency, worst turns | ~4s | up to **17.7s** | No more cap-hits/timeouts, but still materially slow |

## What changed since Run 1, and why

**1. The reasoning-off looping is FIXED.** `gpt-5.6-luna` on `/v1/chat/completions` rejects function tools with any `reasoning_effort` other than `'none'` — forcing reasoning off caused Luna to loop to the 8-round tool-loop cap (~20s) on every non-trivial turn, because a reasoning model without reasoning never decides it's done. Ported the adapter to `/v1/responses` (which allows reasoning WITH tools) at `reasoning_effort: 'low'`, and — critically — round-trips the model's own `reasoning` item (its opaque encrypted chain-of-thought) back into the next round's request, exactly as OpenAI's continuity contract requires. Verified live: a 2-round turn that previously looped to 8 rounds now cleanly resolves in 2, with `end_turn`.

**2. But real (non-looping) latency is still ~3× Haiku's, not comparable.** Once the pathological looping is removed, what's left is genuine cross-provider network + reasoning latency: simple turns are close to parity (`"Main earth is 16"` — 3254ms Luna vs 3331ms Haiku), but anything needing more than a one-shot tool call (`"The Zs for circuit three"`, a value-less ask; `"Delete Ze"`, a clear) takes Luna 8–18s where Haiku takes 2.3–4s. This is not a bug to fix — it's the honest latency profile of this integration path today.

**3. The cost win is real but was overstated in Run 1 — corrected to ~2.8×, not ~5×.** Two errors in Run 1's methodology, both fixed:
   - **Wrong output price.** I'd used $0.60/1M (from an OpenRouter listing) instead of OpenAI's own official $1.20/1M (`developers.openai.com/api/docs/models/gpt-5.6-luna`, verified live).
   - **Missing cache-write cost, on BOTH sides.** Run 1's cost formula only priced cache *reads*, silently treating cache *writes* (Anthropic's 1.25× premium, confirmed OpenAI uses the identical 1.25× convention) as free. Fixing this raised Haiku's true corpus cost from $0.086 → $0.135 (write cost was ~40% of the total) — and it hit Luna even harder: **cache-write tokens (169,648) are the single largest line item in Luna's bill**, nearly as large as cache-reads (269,744). Luna's write:read ratio is markedly worse than Haiku's (42,331 write vs 677,469 read) — plausibly because round-tripping the reasoning item each round inflates the "fresh, uncached" portion of every subsequent request more than Anthropic's snapshot-based prompting does. Net effect: still meaningfully cheaper, but 2.8× is the number to plan around, not 5×.

**4. Correctness is unchanged: still 8/9, same miss.** Luna still misses the insulation-resistance reading (`ir_live_live_mohm 100`) that Haiku gets. Turning reasoning ON did not fix it, which is informative: this was never a "the model wasn't thinking hard enough" problem. It needs root-causing on its own (prompt/schema mismatch, most likely) — not more reasoning effort.

## Per-turn

| transcript | Haiku ms | Luna ms | match |
|---|---|---|---|
| "R1 plus R2 for upstairs sockets is 0.32." | 3688 | 6239 | ✓ |
| "Downstairs Socket, circuit 3, IR L to L 100." | 3490 | 7090 | ✗ **Luna still misses this IR reading** |
| "Main earth is 16 now." | 3331 | 3254 | ✓ (near parity) |
| "The Zs for circuit three." (value-less ask) | 3502 | 17714 | ✓ both no-write, Luna much slower |
| "Calculate Zs for circuit 4." | 3472 | 9855 | ✓ |
| "Calculate Zs for circuit 4." | 2965 | 11451 | ✓ |
| "Zs for circuit 4." | 3956 | 8782 | ✓ |
| "Chuck it too is upstairs lights." (garble recovery) | 2657 | 12012 | ✓ |
| "Delete Ze." | 2309 | 10970 | ✓ |

## Latency root-cause investigation

Four checks, in the order run, each ruling out the previous hypothesis:

1. **Isolated single-turn re-run of the exact same "slow" fixture** (`"The Zs for circuit three."`, which measured 17,714ms in the Run 2 corpus pass) — completed in **3,969ms** through the real harness (same code path: `EICRExtractionSession` → `runShadowHarness`, same 2-round ask/no-write shape, same tool schemas, same ~33k-token system prompt). Not remotely close to the corpus-run number. → the 17.7s wasn't a stable property of that one turn.
2. **10 identical calls, back-to-back and concurrent** (5 sequential no-delay + 5 fired simultaneously) — all landed **1.6–3.0s**, zero degradation under load. → rules out simple contention/queueing on OpenAI's side.
3. **The same fixture repeated 8× through the real harness** — a genuinely wide distribution: `3391, 4660, 7660, 9144, 9948, 10758, 10895, 18444` ms (median 9,948ms, only 2/8 runs under 5s). → NOT a clean "usually fast, rare spike" pattern as an earlier 4-sample batch suggested; latency here is high and variable most of the time, not occasionally.
4. **Isolating round 1 (initial reasoning + ask decision) from round 2 (reaction to the unanswered ask)** via raw API calls — round 1 alone: 2147, 1711, 4227, 3289, 10704ms; round 2 alone: 1201, 1237, 1133, 8101ms, then a **hard HTTP 429** on the 5th call. **Confirmed directly from the response body and, separately, from live rate-limit headers on a fresh request: this OpenAI org's TPM (tokens-per-minute) limit for `gpt-5.6-luna` is 200,000** (`x-ratelimit-limit-tokens: 200000`). This system's real system prompt is ~33k input tokens per call — **roughly 6 calls/minute before hitting the ceiling.** The OpenAI SDK retries a 429 automatically with backoff; it never surfaces as an error, it just makes the call take longer. Both the original 9-fixture corpus run (~18 real calls in a short window) and the repeat-probing in checks 3–4 (dozens of calls in this session) plausibly cross that ceiling routinely.

5. **Does prompt caching reduce what counts against the 200k TPM ceiling?** Directly tested: sent the identical ~33k-token prompt twice back to back. Second call showed `cached_tokens: 32921` of `input_tokens: 32924` — essentially a 100% cache hit, ~90% cheaper to bill. But `input_tokens` (the size the API reports, and what the rate limiter keys off) was **identical, 32,924, on both calls.** Caching reduces the bill; it does not reduce what's charged against the TPM quota. A fully-cached call still costs its full raw size against the ceiling.
6. **But the ceiling is a continuous refill, not a per-minute hard reset.** Reading `x-ratelimit-remaining-tokens` across three calls spaced several seconds apart (real network+reasoning latency) showed it staying at the full 200,000 throughout — the ~3,333 tokens/second natural refill rate (200k/60s) outpaced consumption at that pace. Combined with check 4's 429 (which occurred during calls spaced under ~2s apart), the coherent picture is: **the ceiling only binds when calls arrive faster than roughly one ~33k-token call per ~10 seconds.** A normal conversational pace (dictate → wait for the spoken confirmation → dictate again) is almost certainly slower than that and likely never hits it. The risk is concentrated specifically in **multi-round turns** — an ask that gets re-asked, a correction cycle — that fire 2–4 calls within a second or two of each other, which is exactly the call pattern that produced the observed 429.

**Revised conclusion — softer than first stated.** My earlier framing ("this org's tier is very likely too low for real usage") was overstated. The more precise read: single-round turns at realistic conversational pace are probably fine; **bursts of rapid multi-round turns are the actual risk**, and those are plausible in real usage (a run of corrections, a repeated clarifying question) but not the *dominant* shape of a session. This whole chain (checks 1–6) is strong, directly-evidenced, internally consistent — but still short of the one fully clean confirming experiment: a longer soak test at a realistic, controlled pace (e.g. one call every 3s for several minutes) to nail the exact sustainable throughput rather than infer it from a handful of data points. That's the natural next step if this needs settling definitively.

## Verdict

- **Cost:** ✅ ~2.8× cheaper, confirmed with a methodologically-correct cache accounting on both sides. Real, but smaller than first thought.
- **Correctness:** 🟡 8/9, same single safety-field miss as before reasoning was turned on. Needs root-causing on its own, and a bigger corpus regardless (9 turns is not enough to trust either number).
- **Latency:** 🟡 **Reclassified, not resolved.** The Run 2 headline ("Luna is ~3× slower") is likely dominated by rate-limit throttling during bursts of API calls (this session's own dense probing, and the original corpus run's ~18 calls in a short window), not an inherent property of the model — un-throttled calls are close to Haiku parity. Caching does NOT lower the effective ceiling (a 100%-cached call still counts its full raw size against TPM), but the ceiling refills continuously fast enough that normal conversational pacing likely avoids it — the real risk is concentrated in rapid multi-round turns specifically, not baseline usage.

**Recommendation: still do not swap, but the reason is more precise now.** Cost is genuinely favorable and the looping bug is fixed. What Run 2 measured as "3× slower" is very likely rate-limit throttling during bursts, not the model's genuine per-call speed — but that means the ORIGINAL corpus latency numbers can't be trusted as the model's true profile either, in either direction. Next steps, in order: (1) a properly-paced soak test (single calls, several seconds apart, no artificial burst) to measure Luna's true un-throttled latency cleanly; (2) separately, characterize how often real usage would produce rapid multi-round turns (the actual burst-risk shape) and whether that alone risks hitting the ceiling; (3) root-cause the IR-reading miss independently of reasoning effort; (4) widen the corpus before trusting either correctness number.

---
*Reproduce:* `ANTHROPIC_API_KEY=… OPENAI_API_KEY=… node scripts/model-ab/compare.mjs` (keys pullable from Secrets Manager `eicr/api-keys`). `OPENAI_EXTRACT_API=chat_completions` on the session re-selects the legacy (reasoning-off, looping) adapter for reference. `compare.mjs --from=a.json,b.json` re-diffs two already-produced lane files with no API calls. `scripts/model-ab/latency-tail-probe.mjs --fixture=<corpus_id> --repeats=N` repeats one fixture through the real harness to characterize its latency distribution — use a LARGE repeat count with deliberate spacing (not yet built in) to isolate rate-limit contention from genuine model latency.
