# Claude review v5 — PLAN_v5.md

## Verdict

PLAN_v5's three surgical patches cleanly close Codex v4's BLOCKER and both IMPORTANTs; no NEW BLOCKERs introduced; ship.

## Counts

- v4 BLOCKER verified fixed: **1 of 1** (Codex v4 NB1 — 9.1A vs warm-target contradiction)
- v4 IMPORTANTs verified fixed: **2 of 2** (Codex v4 IMPORTANT 1 — Flux scenarios; IMPORTANT 2 — `.notification` mint point)
- NEW BLOCKERs in v5: **0**
- NEW IMPORTANTs in v5: **0**
- NEW NITs in v5: **2**

## v4 findings re-verification

| v4 finding | v5 location | Status | Verification |
|---|---|---|---|
| Codex v4 NB1: 9.1A explicitly disables `VOICE_LATENCY_USE_MULTI_CONTEXT` but 13.1 still required warm target | §A.1' (replaces v4 §A.12 13.1) | **FIXED** | New 13.1 says "Telemetry P50 ≤ 3.0 s cold target. Warm target N/A in 9.1A — multi-context pool is not shipped in this branch (per §A.3 flag exclusions)." Honest framing rewritten: no more "3.0 s → 2.5 s warm" claim; explicitly says cold-path "comparable to today (~3.0 s) because Sonnet TTFT is the dominant term." Stage 2 reframed as "primarily infrastructure value." Consistent with §A.3 (carried unchanged: "Flags NEVER ENABLED in 9.1A: ... VOICE_LATENCY_USE_MULTI_CONTEXT"). |
| Codex v4 IMPORTANT 1: Flux duplicate-final scenarios bucketed Stage-4-only, 9.1A default suite skips them | §A.2' (replaces v4 §A.7) | **FIXED** | Three scenarios (`flux_misrecognition_socket_one`, `flux_misrecognition_second`, `flux_duplicate_finals`) explicitly moved into `stage2_streaming` (now 8 scenarios, was 5). `stage4_fast_path` drops from 12 to 9. Arithmetic checks: protocol 4 + stage2_streaming 8 + stage5_ask_user 3 = 15 (matches §A.1' "15 scenarios"). Total 4+8+3+9+3 = 27 (matches "Total: 27"). Stage 2's `ElevenLabsStreamClient` in-flight dedup is the right home — these scenarios test today's Flux behaviour that Stage 2's streaming layer must not regress on. |
| Codex v4 IMPORTANT 2: `.notification` source mint point missing from §A.4 bullet list | §A.3' (replaces v4 §A.4 bullet list) | **FIXED** | Fourth bullet added explicitly: "iOS mints when the AlertManager call originates, BEFORE the TTS POST." Best-effort framing correct (notifications are suppression-exempt per PLAN_v3 §4.4). Stale-drop rule explicitly exempted: "The AlertManager stale-drop queue rule does NOT apply to `.notification` source — notifications always play to completion." Consistent with the wider AlertManager queue rules in v4 §A.4 (unchanged) — those rules condition the stale-drop on `lastScheduledSeq` + same `{boardId, circuit, field}`; notification has no slot tuple so the rule naturally wouldn't fire, but explicit exemption is the right belt-and-braces. |

## Internal consistency check on §A.1''

The optional sub-branch §A.1'' lets 9.1A add multi-context via a new Stage 2 commit 2.5b. This appears to contradict §A.3 (PLAN_v4 inherited) which lists `VOICE_LATENCY_USE_MULTI_CONTEXT` as "NEVER ENABLED in 9.1A." Acceptable because:

1. §A.1'' is explicitly labelled "**optional sub-branch**" and "**Not the recommended path**" and "**Default: 9.1A ships without multi-context. Cold-only.**"
2. §A.1' (the headline 13.1 patch) refers to §A.1'' as the escape hatch ("see §A.1''"), so the executor reading 13.1 sees the conditional pointer.
3. If Derek takes the 2.5b branch, the executor would also flip §A.3 to remove `VOICE_LATENCY_USE_MULTI_CONTEXT` from the "NEVER ENABLED" list — implicit but obvious from context.

A 30-second tightening would be to add one parenthetical to §A.3 ("unless §A.1'' sub-branch is taken at Stage 2 ramp time"). NIT-level; not blocking.

## NEW findings

### NITs

**NN-v5-1.** §A.1'' sub-branch contradicts §A.3 (PLAN_v4 inherited) at face value — `VOICE_LATENCY_USE_MULTI_CONTEXT=true` in step 4.5 vs §A.3's "NEVER ENABLED in 9.1A." Resolvable from context (sub-branch is opt-in, §A.3 describes the default path), but a one-line cross-reference in §A.3 would remove ambiguity for an implementation agent. Not blocking — the default path is the clear path, and §A.1'' is correctly flagged as optional.

**NN-v5-2.** §A.4' notes Stage 1b commit 1b.4 needs `.tour` and `.alert` enum cases but doesn't bake the 6-case enum into the plan. Acceptable per "non-plan note" framing — the implementer reading commit 1b.4's plan-level description (PLAN_v3 §4.4) will see this drafting note and act accordingly. Optional minor improvement: bake the 6-case enum directly into §4.4 as a quick edit. Not blocking — the note is sufficiently directive ("Add two more enum cases", "Both are suppression-exempt").

### Pre-existing carryovers (not v5-introduced)

- NIT NN-v4-1 from claude-review-v4 (null-component wildcard rule for `audioSeq` same-slot comparison on installation-level fields) — still untouched in v5. Was non-blocking in v4; remains non-blocking. Implementer resolves in 30 seconds at AlertManager queue test write time.

## Diminishing-returns honest call

**Ship as-is.** Five reviews in, the BLOCKER pattern is 7 → 2 → 2 → 1 → **0**. v5 was a small, focused patch (184 lines vs v4's 393) addressing exactly the three issues Codex v4 named and did not introduce new architecture surface. The two NITs above are 30-second clarifications that land naturally at Stage 0.G implementation. No basis to manufacture a BLOCKER.

A PLAN_v6 round would project to 0 BLOCKERs, 0–1 NITs, no IMPORTANTs. Marginal value clearly below another reviewer-day. Both v4 reviewers explicitly stated "no PLAN_v6 unless v5 expands scope" — v5 did not expand scope, it contracted it (one fewer contradictory exit target, one extra mint point bullet, three scenarios re-bucketed).

## Recommendation

**Ship.** Approve PLAN_v5. Stage 0 begins next session. First gate: 0.A (iOS Strategy C playback feasibility, PCM-first).

Optional 60-second tightening before Stage 0 kickoff (NOT required):

1. Add a one-line parenthetical to §A.3 noting that the "NEVER ENABLED in 9.1A" rule for `VOICE_LATENCY_USE_MULTI_CONTEXT` does not apply if the §A.1'' sub-branch is taken.
2. Bake the 6-case TTSSource enum (`.confirmation, .correction, .question, .notification, .tour, .alert`) directly into PLAN_v3 §4.4 instead of relying on §A.4''s drafting note.

Both improvements are cosmetic. Plan is executable as written.
