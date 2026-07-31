# Model A/B — GPT-5.6 Luna vs Haiku 4.5 on the field-replay corpus (LIVE)

**Run 2 (corrected):** 2026-07-31, same 9 real captured field utterances, live through the real Stage 6 extraction harness. This run fixes two things found after Run 1: (1) Luna now goes through a **new Responses-API adapter** with reasoning ON, instead of Chat Completions with reasoning forced off; (2) the **cost model now includes cache-write tokens on both sides**, which Run 1 silently dropped, and uses OpenAI's *official* pricing ($1.20/1M output, not the $0.60 an OpenRouter listing showed).

**Run 3 (latency root-cause, same day):** dug into WHY Luna measured ~3× slower in Run 2. Finding, in order of discovery: (1) isolated single-turn re-runs of the exact same slow fixture completed in ~4s, not 17.7s; (2) 10 back-to-back/concurrent identical calls showed zero degradation, ruling out simple queueing; (3) repeating the same fixture through the real harness produced a WIDE, high distribution (3.4–18.4s, median ~10s) — not a clean "usually fast" pattern; (4) further probing hit a real **HTTP 429** — confirmed directly via response headers: **this org's TPM (tokens-per-minute) limit for `gpt-5.6-luna` is 200,000**. This system's real prompt is ~33k tokens/call, so the ceiling is ~6 calls/minute before throttling. The OpenAI SDK auto-retries 429s with silent backoff — it doesn't error, it just makes the call take longer, which is a strong explanation for the variable 8–18s latencies observed in both the original corpus run and later repeat-probing (both made enough calls in a short window to plausibly hit this ceiling). See § Latency root-cause below for the full breakdown and what's still unproven.

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

**This is a strong, evidenced, but not fully isolated conclusion.** It reconciles every observation (fast isolated calls, fast burst-test calls run early in a fresh window, high/variable latency once enough cumulative calls stack up, and a directly-observed 429 at exactly this token volume) — but I did not run the one fully clean confirming experiment (space every call >15s apart across a long series, guaranteeing zero rate-limit contention, and check whether the distribution tightens to the ~2-4s range) before stopping, partly to avoid burning further TPM budget mid-investigation. That experiment is the natural next step if this needs to be settled definitively rather than treated as the leading explanation.

**Practical implication either way:** even if Luna's *un-throttled* per-call latency turns out to be genuinely comparable to Haiku's, this org's current 200k TPM tier for `gpt-5.6-luna` is very likely too low to run this workload (33k tokens/turn, potentially several turns/minute in a real inspection session) without hitting this ceiling routinely. That's a standalone blocker independent of the model's own speed — the fix is a support ticket/tier increase with OpenAI, not code.

## Verdict

- **Cost:** ✅ ~2.8× cheaper, confirmed with a methodologically-correct cache accounting on both sides. Real, but smaller than first thought.
- **Correctness:** 🟡 8/9, same single safety-field miss as before reasoning was turned on. Needs root-causing on its own, and a bigger corpus regardless (9 turns is not enough to trust either number).
- **Latency:** 🟡 **Reclassified, not resolved.** The Run 2 headline ("Luna is ~3× slower") is likely dominated by this org's 200k-TPM rate-limit ceiling for `gpt-5.6-luna`, not an inherent property of the model — un-throttled calls (early in a fresh rate-limit window) are close to Haiku parity. But the rate-limit ceiling itself is real, directly confirmed, and would need raising before Luna could be evaluated — let alone run — at real usage pace.

**Recommendation: still do not swap, but for a different reason than before.** Cost is genuinely favorable and the looping bug is fixed. What blocks a verdict now is NOT proven-slow-model latency — it's that this org's OpenAI tier can't sustain the call volume this workload needs without hitting a 200k-TPM ceiling, which silently inflates latency via SDK-level retries. Next steps, in order: (1) request a TPM tier increase for `gpt-5.6-luna` from OpenAI (or confirm the org's usage tier and whether a higher one is available), (2) re-run this same latency investigation with headroom to isolate the model's true un-throttled latency, (3) root-cause the IR-reading miss independently of reasoning effort, (4) widen the corpus before trusting either correctness number.

---
*Reproduce:* `ANTHROPIC_API_KEY=… OPENAI_API_KEY=… node scripts/model-ab/compare.mjs` (keys pullable from Secrets Manager `eicr/api-keys`). `OPENAI_EXTRACT_API=chat_completions` on the session re-selects the legacy (reasoning-off, looping) adapter for reference. `compare.mjs --from=a.json,b.json` re-diffs two already-produced lane files with no API calls. `scripts/model-ab/latency-tail-probe.mjs --fixture=<corpus_id> --repeats=N` repeats one fixture through the real harness to characterize its latency distribution — use a LARGE repeat count with deliberate spacing (not yet built in) to isolate rate-limit contention from genuine model latency.
