# Codex review v5 — PLAN_v5.md

## Verdict

SHIP. PLAN_v5 fixes the one v4 BLOCKER and the two v4 IMPORTANT findings without introducing a new executable contradiction.

No PLAN_v6 is warranted. The remaining issues are implementation-time drafting details or harmless wording polish, not blockers.

## Counts (incl. NEW BLOCKERs in v5)

- v4 BLOCKER re-verified: 1 of 1 fixed
- v4 IMPORTANTs re-verified: 2 of 2 fixed
- NEW BLOCKERs in v5: 0
- NEW IMPORTANTs in v5: 0
- NEW NITs in v5: 0

## v4 findings re-verification (NB1, IMPORTANT 1, IMPORTANT 2)

### NB1 — 9.1A warm-target contradiction

FIXED.

PLAN_v5 §A.1' makes 13.1 cold-only: Stage 2 must hit `P50 <= 3.0 s cold`; warm is N/A because 9.1A does not ship the multi-context pool. That now agrees with inherited PLAN_v4 §A.3, which says `VOICE_LATENCY_USE_MULTI_CONTEXT` is never enabled in default 9.1A.

The honest-framing paragraph is intellectually honest. PLAN_v3 §5.2 already said Stage 2 cold improvement is marginal (`~3.0 s -> ~2.95 s`, with possible cold range to `3.4 s`) because Sonnet TTFT dominates; the real cold-path changes are chunked HTTP, `StreamingAudioPlayer`, `stream-input`, telemetry, source typing, and ack plumbing. Calling cold latency "comparable to today (~3.0 s)" is therefore the right framing. Stage 5 remains the visible 9.1A latency win.

The optional §A.1'' 9.1A+multi-context branch does not create a new blocker. It is explicitly marked optional, bigger-scope, not recommended, and default-off. If Derek chooses it, it intentionally overrides the inherited default 9.1A flag exclusion by adding a new Stage 2 commit and a rollout step to flip `VOICE_LATENCY_USE_MULTI_CONTEXT=true`. The default path remains clear: "9.1A ships without multi-context. Cold-only."

### IMPORTANT 1 — Flux scenario bucketing

FIXED.

PLAN_v5 §A.2' moves `flux_misrecognition_socket_one`, `flux_misrecognition_second`, and `flux_duplicate_finals` out of `stage4_fast_path` and into a suite required by both rollouts. The math is now consistent:

- `protocol`: 4
- `stage2_streaming`: 8
- `stage3_suppression`: 3
- `stage4_fast_path`: 9
- `stage5_ask_user`: 3
- total: 27
- 9.1A default subset: 4 + 8 + 3 = 15

A separate `no_regression` suite would be a cleaner taxonomy, but `stage2_streaming` is acceptable because it is mandatory for both 9.1A and 9.1B and the plan explicitly labels those three as Flux duplicate-final no-regression scenarios. It catches the original bug class in the minimum branch, which was the substance of the v4 finding.

### IMPORTANT 2 — `.notification` audioSeq mint point

FIXED.

PLAN_v5 §A.3' adds the missing mint point for `speakCriticalNotification -> TTSSource.notification`: iOS mints before the TTS POST, sends best-effort `audioSeq`/header for telemetry, and excludes notifications from stale-drop suppression. That matches the current code surface: `AlertManager.speakCriticalNotification` is a real path and deliberately bypasses the `isAwaitingResponse` suppression used by `speakBriefConfirmation`.

This is consistent with inherited PLAN_v4 §A.4. The stale-drop rule is scoped to same `{boardId, circuit, field}` audio for logical field confirmations/corrections; notifications have no such slot context. v5's explicit "stale-drop queue rule does NOT apply" line removes ambiguity rather than conflicting with the inherited queue rule.

## NEW findings (if any)

None.

Surfaces checked:

- §A.1'' optional multi-context branch is well-marked as exceptional and not default.
- §A.1' makes 9.1A cold-only in the executable exit criteria.
- §A.3' handles notification telemetry without accidentally applying same-slot stale-drop semantics to notifications.
- §A.4' is specific enough for Stage 1b commit 1b.4: add `.tour` and `.alert`, make both suppression-exempt, and treat `.alert` like `.notification`. It is discoverable because PLAN_v5 is the executable patch and the carryover is called out both in §0 and §A.4'.

Code spot-checks:

- `CertMateUnified/Sources/Recording/AlertManager.swift:198` has `queueAlert`.
- `CertMateUnified/Sources/Recording/AlertManager.swift:653` has `speakTourNarration`.
- `CertMateUnified/Sources/Recording/AlertManager.swift:874` has `speakAlertMessage`.
- `CertMateUnified/Sources/Recording/AlertManager.swift:921` has `speakCriticalNotification`.

## Diminishing-returns honest assessment

This round found 0 new BLOCKERs. The trend 7 -> 2 -> 2 -> 1 -> 0 has reached the stated stopping condition.

There is no value in another broad plan review before Stage 0. The risk now is delaying implementation and re-litigating wording, not missing a known blocker. Stage 0 measurement gates are the right next validation mechanism.

## Recommendation

Approve PLAN_v5 and start Stage 0. No PLAN_v6.
