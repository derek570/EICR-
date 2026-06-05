# Claude review v4 — PLAN_v4.md

## Verdict

PLAN_v4's four surgical patches close both Codex v3 BLOCKERs cleanly and the four IMPORTANTs they bundled; two minor surfaces (audioSeq drop-rule when `boardId` is null, and TTSSource enum still missing tour/alert paths) are pre-existing carryovers worth flagging at execution time but do not warrant a v5 round.

## Counts

- v3 BLOCKERs verified fixed in v4: **2 of 2** (Codex NB1 decision-gate move; Codex NB2 rollout split)
- v3 IMPORTANTs verified fixed in v4: **8 of 8** (Codex NI1–6 plus Claude NI1+NI2; NI1 honest-residual on Stage 4 absent now that Stage 3 is jointly conditional)
- NEW BLOCKERs in v4: **0**
- NEW IMPORTANTs in v4: **0**
- NEW NITs in v4: **3**

## v3 findings re-verification

| v3 finding | v4 location | Status | Notes |
|---|---|---|---|
| Codex NB1: 13.1 not coherent (Stage 3 idle without Stage 4) | §A.1 (1.21) + §A.2 (§7 intro) | FIXED | Gate moves to end-of-Stage-2; Stage 3+4 are JOINTLY conditional. Explicitly stated in §A.1, §A.2 last paragraph, §A.5 capture sheet trigger, §13.1 exit. |
| Codex NB2: rollout still says "Land Stages 1–4" | §A.3 (9.1A/9.1B) | FIXED | Two explicit branches. 9.1A flag list excludes `SUPPRESSION/REGEX_FAST_TTS/USE_MULTI_CONTEXT`. §9.5 commit assignment is unambiguous. |
| Codex NI1: audioSeq ownership underspecified | §A.4 | FIXED | iOS-owned, session-lifetime, mint points listed, wire shape pinned, reconnect rule explicit. |
| Codex NI2: §16 row 4 overstates ask_user mitigation | §A.8 | FIXED | Row rewritten with the five honest points Codex requested. |
| Codex NI3: cost-tracker conflates charge vs terminal | §A.10 | FIXED | Two-call split with idempotency and invariant `started = completed + cancelled + failed`. |
| Codex NI4: scenario library Stage-4-heavy | §A.7 | FIXED | 5 suites; 9.1A default subset = 12 scenarios. |
| Codex NI5: Stage 2 capture method | §A.5 | FIXED | One-page sheet with auto + subjective fields. |
| Codex NI6: Stage 5 dependency note | §A.6 | FIXED | Explicit "depends on 1b/2; NOT 3/4." |
| Claude NI1: Stage 3 dormant at 13.1 | §A.1 + §A.2 | FIXED (different mechanism) | Trade-off removed entirely by bundling 3+4. Better than annotating it. |
| Claude NI2: missing 13.1 scenarios | §A.7 | FIXED | `stage2_streaming` + `stage5_ask_user` + `protocol` suites cover the 9.1A path. |
| Claude NN1: 1b.4 vs 1b.6 ordering | §A.11 | ADDRESSED | Sequential-gate wording. Plan doesn't explicitly call out that both methods carry `source` during transition, but executor will resolve trivially. |
| Claude NN2: decision-gate rubric | §A.5 | FIXED | "Felt late" / "wondered if it heard me" / "clipped" / "after inspector moved on" counts + verdict. |

## NEW findings (v4)

### NITs

**NN-v4-1.** §A.4 AlertManager drop rule is `if incoming.audioSeq < lastScheduledSeq AND same {boardId, circuit, field}` — installation-level fields (`earth_loop_impedance_ze`, `prospective_fault_current` at `field_schema.json:560/566`) have no `circuit` and no `boardId`. The tuple becomes `{null, null, "earth_loop_impedance_ze"}` which still works because both sides normalise to nil, but the plan should say "the comparison treats null components as a wildcard equal." 30-second clarification at implementation time.

**NN-v4-2.** §A.4 mentions `playerNode.stop()` / `playerNode.reset()` are NOT cancellation primitives because Apple's docs allow stopping the node entirely but not removing a specific scheduled buffer. The residual-risk paragraph could note this for completeness — but it's correctly captured at the contract level ("audio WILL play to completion"). NIT only.

**NN-v4-3.** §A.7 places `flux_misrecognition_socket_one` under `stage4_fast_path`, but the bug it represents (Flux double-final 1ms apart) exists in TODAY's pre-Stage-4 code path and is the canonical motivating example for Stage 3 suppression. A copy under `stage3_suppression` (with different assertions targeting suppression-fire rather than fast-path-rejection) would catch a 9.1A regression. Not blocker — `protocol` suite tests basic capability and `stage2_streaming` will catch the symptom indirectly.

### Pre-existing carryovers (worth flagging, not v4-introduced)

- TTSSource enum still has 4 cases but `speakTourNarration` (line 653) and `speakAlertMessage`/`queueAlert` (lines 874/198) route to ElevenLabs without source mapping. v3 review flagged this; v4 doesn't address it. Default-to-confirmation means tour and validation alerts would be subject to suppression — wrong semantics. Should be fixed before Stage 1a ships, but plan editing is not blocking.
- §A.11 drops `(TBD)` line numbers in favour of function-name anchors — clean.

## Diminishing-returns conclusion

**Ship as-is.** The pattern across rounds (7 → 2 → 2 → 0 BLOCKERs) demonstrates the plan has stabilised on substance. v4's three NITs are 5-minute polish items that land naturally during Stage 0.G implementation or first-commit drafting. The two TTSSource carryovers are real, but cosmetic at the plan level — they're implementation details of the Stage 1b iOS commits, and the implementer will see them immediately when threading `source` through `AlertManager`.

If a v5 review were to run, projection: 0 BLOCKERs, 0–1 IMPORTANTs (likely about tour/alert source mapping, which is a 30-line iOS change), 2–4 NITs. Marginal value below the cost of another reviewer-day.

## Recommendation

**Ship.** Approve PLAN_v4. Stage 0 begins.

Optional 5-minute fix before kickoff if desired: extend `enum TTSSource` to add `.tour` and `.alert` cases in §4.4 / Stage 1b commit 1b.4, with both exempt from suppression like `.notification`. Not required to start Stage 0.
