# Model A/B — GPT-5.6 Luna vs Haiku 4.5 on the field-replay corpus (LIVE)

**Run 2 (corrected):** 2026-07-31, same 9 real captured field utterances, live through the real Stage 6 extraction harness. This run fixes two things found after Run 1: (1) Luna now goes through a **new Responses-API adapter** with reasoning ON, instead of Chat Completions with reasoning forced off; (2) the **cost model now includes cache-write tokens on both sides**, which Run 1 silently dropped, and uses OpenAI's *official* pricing ($1.20/1M output, not the $0.60 an OpenRouter listing showed).

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

## Verdict

- **Cost:** ✅ ~2.8× cheaper, confirmed with a methodologically-correct cache accounting on both sides. Real, but smaller than first thought.
- **Correctness:** 🟡 8/9, same single safety-field miss as before reasoning was turned on. Needs root-causing on its own, and a bigger corpus regardless (9 turns is not enough to trust either number).
- **Latency:** ❌ Still the blocking issue. The catastrophic looping is fixed, but Luna via the Responses API is genuinely ~3× slower than Haiku on this corpus — worse on anything beyond a single trivial tool call. Given Audio-First #3 (latency is a first-class invariant, not cosmetic), this alone rules out a swap today.

**Recommendation: do not swap.** The looping fix proves Luna CAN drive this tool-call loop correctly and it's genuinely cheaper — but real latency (not a fixable bug, an integration-path property) is ~3× Haiku's, and there's one unexplained correctness miss. Both would need to close before this is a live-session candidate. Next steps, in order: (1) root-cause the IR-reading miss on a schema/prompt level (not a reasoning-effort lever), (2) profile where Luna's latency actually goes (reasoning tokens vs network vs OpenAI-side queueing) to see if any of it is addressable, (3) widen the corpus before drawing a correctness conclusion either way.

---
*Reproduce:* `ANTHROPIC_API_KEY=… OPENAI_API_KEY=… node scripts/model-ab/compare.mjs` (keys pullable from Secrets Manager `eicr/api-keys`). `OPENAI_EXTRACT_API=chat_completions` on the session re-selects the legacy (reasoning-off, looping) adapter for reference. `compare.mjs --from=a.json,b.json` re-diffs two already-produced lane files with no API calls.
