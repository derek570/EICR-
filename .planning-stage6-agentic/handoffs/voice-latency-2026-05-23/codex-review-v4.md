# Codex review v4 — PLAN_v4.md

## Verdict

Tight PLAN_v5 patch required. Do not run another broad review pass.

PLAN_v4 fixes the v3 blockers at the product/rollout level: Stage 3 and Stage 4 are now both-or-neither, and the rollout no longer tells an implementation agent to build Stage 4 in the minimum branch.

However, v4 introduces one real executable contradiction: the 9.1A minimum branch explicitly never enables or ships multi-context, while 13.1 still grades the minimum branch on a warm Stage 2 latency target that depends on multi-context. That makes the minimum exit criteria internally inconsistent.

## Counts

- v3 BLOCKERs re-verified: 2 of 2 fixed at plan level
- v3 IMPORTANTs requested here re-verified: 5 reviewed
- NEW BLOCKERs in v4: 1
- NEW IMPORTANTs in v4: 2
- NEW NITs in v4: 0

## v3 findings re-verification (NB1, NB2, NI1, NI3, NI4)

| Finding | v4 status | Verification |
|---|---|---|
| NB1: Stage 3 dead weight if Stage 4 skipped | FIXED | §A.1 row 1.21 says Stage 3 and Stage 4 are jointly conditional after Stage 2, before Stage 3 commits begin. §A.2 says neither Stage 3 nor Stage 4 begins unless Stage 2 field assessment is too slow, and the acceptable/defer outcomes skip both. §A.12 13.1 exits at Stages 0+1+2+5+6. Inherited PLAN_v3 §6 is explicitly scoped by PLAN_v4 §B to 9.1B only. |
| NB2: rollout still builds Stage 4 | FIXED | §A.3 splits rollout into 9.1A and 9.1B. 9.1A lands only Stages 0,1,2, then Stage 5; it explicitly says no `VOICE_LATENCY_REGEX_FAST_TTS`, no `regexFastEnabled`, no multi-context pool flip, and never enables suppression/regex/multi-context. 9.1B is the only branch that lands Stage 3+4 and ships `regexFastEnabled=true`. §9.5 branch assignment is consistent: 9.1A skips 6.1/6.3/6.4; 9.1B runs all. |
| NI1: `audioSeq` ownership | MOSTLY FIXED | Ownership, lifetime, mint timing for confirmations/corrections, fast-path, ask_user, header propagation, ack propagation, server telemetry, suppression storage, same-session reconnect preservation, and new-session reset are specified. This matches current `ServerWebSocketService.sendSessionStart` behavior: reconnect with the same `sessionId` does not reset per-session state; a new `sessionId` does. One source case remains underspecified: `.notification` exists in PLAN_v3 §4.4 and current `AlertManager.speakCriticalNotification`, but §A.4 does not name its mint point. See IMPORTANT 2. |
| NI3: cost-tracker split | FIXED at plan level | §A.10 separates `recordElevenLabsStreamingStarted` from `recordElevenLabsStreamingTerminal`, pins billable semantics to text-sent, and requires duplicate terminal callback tests. It does not prescribe an exact `Set`/map implementation, but the correlationId idempotency contract and invariant are testable. In the current single-process Node backend, synchronous per-session tracker mutation is not a plan blocker. |
| NI4: scenario library bias | PARTIAL | v4 splits suites and gives 9.1A a branch-specific default subset. That fixes the shape. One scenario bucket is still wrong: `flux_misrecognition_socket_one` is a current duplicate-final/no-regression case, not a Stage 4 fast-path-only case. See IMPORTANT 1. |

## NEW findings

### NB1. 9.1A disables multi-context but 13.1 still requires a warm Stage 2 target

**Where:** PLAN_v4 §A.3 lines 92-95, §A.12 lines 314-322; inherited PLAN_v3 §5.2 / PLAN_v2 §7.5.

**Problem:** The minimum branch says:

- close with Stage 3+4 skipped;
- no `VOICE_LATENCY_REGEX_FAST_TTS`;
- no `regexFastEnabled`;
- no multi-context pool flip;
- `VOICE_LATENCY_USE_MULTI_CONTEXT` is never enabled in 9.1A.

But 13.1 still says Stage 2 must hit `P50 <= 3.0 s cold / <= 2.5 s warm (if 0.F passed)`, and its honest framing still claims the 2.5 s warm improvement.

That warm path is not executable in 9.1A. The inherited design says Stage 2 uses one standalone `stream-input` WS per synth unless both Stage 0.F passed and `VOICE_LATENCY_USE_MULTI_CONTEXT=true`. PLAN_v2 places the actual multi-context pool implementation in Stage 4 commit 4.3. So if 9.1A skips Stage 4 and never flips `VOICE_LATENCY_USE_MULTI_CONTEXT`, the 13.1 warm metric is not merely unproven; it is unavailable.

**Tight fix:** Choose one branch contract and make it consistent.

Preferred minimal patch: keep 9.1A truly minimal and edit 13.1 to cold-only Stage 2 criteria, e.g. `P50 <= 3.0 s cold; warm/BOS-amortised target N/A in 9.1A because multi-context pool is not shipped`. Remove or qualify the `3.0 s -> 2.5 s warm` framing in 13.1.

Alternative patch: if Derek wants warm Stage 2 in the minimum branch, move the multi-context pool out of Stage 4 into Stage 2 and allow 9.1A to execute commit 6.3 after Stage 0.F passes. That is a bigger scope change and is not the surgical option.

### IMPORTANT 1. Flux duplicate-final scenarios are mis-bucketed as Stage 4-only

**Where:** PLAN_v4 §A.7 lines 223-245; inherited PLAN_v3 §3.G scenario descriptions.

`flux_misrecognition_socket_one` is described in PLAN_v3 as the original Derek bug: Flux emits both `circuit 1` and `Socket 1.` finals 1 ms apart, and the expected behavior is only one TTS. That is not a regex-fast-path-only behavior. It is a no-regression case for today's transcript/final handling and for Stage 2's streaming/in-flight dedupe.

Putting it only in `stage4_fast_path` means the 9.1A default suite can pass while skipping a known real-world duplicate-final bug class.

**Tight fix:** Move `flux_misrecognition_socket_one`, and probably `flux_misrecognition_second` / `flux_duplicate_finals`, into `stage2_streaming` or a `protocol/no_regression` suite required by both 9.1A and 9.1B. Keep Stage 4 race fixtures R1-R8 and true fast-eligibility tests in `stage4_fast_path`.

### IMPORTANT 2. `audioSeq` omits the `.notification` source mint point

**Where:** PLAN_v4 §A.4 lines 137-146; PLAN_v3 §4.4; current `CertMateUnified/Sources/Recording/AlertManager.swift` has `speakCriticalNotification`.

§A.4 says HTTP requests carry `X-Voice-Latency-Audio-Seq`, but the mint-point list names confirmations/corrections, fast-path, and ask_user only. PLAN_v3 §4.4 has four `TTSSource` cases, including `.notification`, and the current app has a real `speakCriticalNotification` path.

This is not a blocker because notifications are suppression-exempt and can be handled during implementation. But the contract should be one line tighter in the same patch: either mint `audioSeq` at `speakCriticalNotification` intent creation, or explicitly say notification TTS is excluded from stale same-slot suppression and still receives a best-effort seq/header for telemetry.

## Diminishing-returns honest assessment

The plan-iteration approach is still paying for itself, but only barely at this point. v4's main architecture is executable. The new blocker is a branch/exit-criteria contradiction introduced by the v4 patch itself, not a hidden codebase unknown.

This should be a small PLAN_v5 patch, not another full-plan rethink. After the warm-target contradiction is fixed, and the two small important items are folded in, I would ship without another broad review.

## Recommendation

Patch to PLAN_v5, tightly:

1. Make 9.1A and 13.1 agree on multi-context/warm latency. Preferred: 9.1A cold-only, warm N/A because multi-context is not shipped.
2. Move Flux duplicate-final scenarios into a suite required by both rollout branches.
3. Add the missing `.notification` `audioSeq` mint/exclusion line.

Then SHIP. No PLAN_v6 unless the patch moves multi-context into Stage 2 or otherwise materially expands scope.
