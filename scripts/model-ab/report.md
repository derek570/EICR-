# Model A/B — GPT-5.6 Luna vs Haiku 4.5 on the field-replay corpus (LIVE)

**Run:** 2026-07-31, 9 real captured field utterances, live through the real Stage 6 extraction harness.
**baseline:** `claude-haiku-4-5-20251001` (Anthropic) · **candidate:** `gpt-5.6-luna` (OpenAI, via the new tool-use adapter)

Loaded Barrel disabled (clean single-model probe). Luna ran on `/v1/chat/completions` with `reasoning_effort: 'none'` — the ONLY tool-calling mode Chat Completions allows for Luna (see caveat below).

## Headline

| Metric | Haiku 4.5 | GPT-5.6 Luna | Verdict |
|---|---|---|---|
| Readings agreement | — | **8/9 (88.9%)** | Good, with 1 real miss |
| Corpus cost | $0.0864 | **$0.0173 (0.20×)** | **~5× cheaper — confirmed** |
| Latency, simple turns | ~2.8s | **~2.5s** | Comparable / slightly faster |
| Latency, non-trivial turns | ~4s | **~20s (loops to 8-round cap)** | **Dealbreaker as wired** |
| Latency mean/turn | 3819ms | 15920ms (4.17×) | Dragged up by the looping |

## Per-turn

| transcript | Haiku ms | Luna ms | Luna readings | match |
|---|---|---|---|---|
| "R1 plus R2 for upstairs sockets is 0.32." | 2770 | **2486** | `4\|r1_r2_ohm\|0.32` | ✓ |
| "Downstairs Socket, circuit 3, IR L to L 100." | 3973 | 2581 | **(none)** | ✗ **Luna missed the IR reading** |
| "Main earth is 16 now." | 2837 | 11502 | `0\|earthing_conductor_csa\|16` | ✓ (correct, but 11.5s) |
| "The Zs for circuit three." (value-less) | 4175 | 20235 | (none) | ✓ both no-write, Luna looped |
| "Calculate Zs for circuit 4." | 2598 | 20343 | (none) | ✓ both no-write, Luna looped |
| "Calculate Zs for circuit 4." | 4643 | 20376 | (none) | ✓ both no-write, Luna looped |
| "Zs for circuit 4." | 4539 | 20412 | (none) | ✓ both no-write, Luna looped |
| "Chuck it too is upstairs lights." | 2766 | 20346 | `2\|designation\|Upstairs Lights` | ✓ (correct, but 20s) |
| "Delete Ze." | 6067 | 25003 | (none) | ✓ Luna hit the 25s hard timeout |

## What this means

**1. Cost win is real and permanent (~5×).** Even with Luna's looping re-sending the prompt every round (34k input tokens vs Haiku's 7k), the $0.20/$0.60 per-1M pricing makes the whole corpus 5× cheaper. On clean single-tool turns the win would be larger.

**2. Extraction correctness is promising but not proven.** Luna correctly wrote the R1+R2 reading, the main-earth CSA (the tricky Ze-vs-conductor case), and the garble→designation recovery. It **missed one** — the insulation-resistance reading `ir_live_live_mohm 100` — where Haiku got it. One miss on a safety-relevant field is not shippable; needs a wider corpus.

**3. Latency is a dealbreaker AS WIRED — and the cause is known.** Luna loops to the 8-round tool-loop cap (~20s) on every turn that isn't a trivial single write. That is the signature of running a **reasoning model with reasoning forced OFF**: without reasoning, Luna doesn't decide it's "done" and keeps emitting tool calls instead of `end_turn`. We were *forced* into `reasoning_effort: 'none'` because `/v1/chat/completions` **rejects function tools + any reasoning** for Luna (verified: HTTP 400 "use /v1/responses or set reasoning_effort to 'none'").

## The decisive follow-up: port the adapter to the Responses API

The looping AND the IR miss are both plausibly the same root cause — reasoning-off. OpenAI's own error points the way: **tool calling WITH reasoning for Luna requires `/v1/responses`, not Chat Completions.** Before judging Luna, the adapter should be re-pointed at the Responses API with `reasoning_effort: 'low'`. Expected effects: Luna emits `end_turn` cleanly (kills the ~20s looping), and reasoning likely recovers the IR miss. That is the real test of "can Luna replace Haiku."

## Verdict

- **Cost:** ✅ Luna ~5× cheaper, permanent.
- **Correctness:** 🟡 8/9, one safety-field miss — promising, unproven, corpus too small (9 turns).
- **Latency:** ❌ via Chat Completions + reasoning-off. Blocked on the Responses-API port.

**Recommendation:** do NOT swap yet. Next step is the Responses-API adapter variant + a re-run of this A/B on a larger corpus. If the looping resolves and correctness holds at reasoning `low`, Luna is a genuine 5×-cheaper candidate worth a real live-session probe.

---
*Reproduce:* `ANTHROPIC_API_KEY=… OPENAI_API_KEY=… node scripts/model-ab/compare.mjs` (keys also pullable from Secrets Manager `eicr/api-keys`). Lanes run independently via `scripts/model-ab/run-lane.mjs`; `compare.mjs --from=a.json,b.json` re-diffs without re-spending API calls.
