# /ep execution log — PLAN-C Phase 4, PART 1 (additive wire pieces)

**Plan:** PLAN-C-client-watchdog-final.md (Phase 4 backend wire contract).
**Unit scope (deliberate split):** the two ADDITIVE, self-contained, zero-runtime-risk pieces of Phase 4 — P4a (fallback constant + distinctness pin) and P4b (session_ack speech_epochs capability advert). Both are pure-additive wire (current clients ignore them; no behaviour change), so they ship early to de-risk the wave. The intrinsically-hard P4c (response-epoch ownership contract) + P4d (8-row emit-site threading) are DEFERRED to a dedicated follow-on /ep unit — they thread through the single most complex subsystem (runLiveMode / PendingAsksRegistry / bundleToolCallsIntoResult) with high regression risk and deserve their own focused execution, not a rushed tail-end pass. This honours the plan's own "Phase 4 ships in its own PR first" + Derek's "multiple EP if needed".

## Completed 2026-07-19

### Outcome header: ALL PASSED (unit scope: P4a + P4b)

### Steps
## P4a — export CLIENT_CHIME_WATCHDOG_FALLBACK_TEXT + distinctness pin
- Status: applied
- Files: src/extraction/client-watchdog-fallback.js (new), src/__tests__/client-watchdog-fallback.test.js (new)
- Commit: 251a007b
- Notes: fallback line chosen with a construction ("didn't come back to you") absent from every backend apology/notice family; distinctness proven by driving the REAL dispatchers for the templated F/U-2/3 families (counts 1-6, both friendly names, both rotation variants) after Codex r1.

## P4b — session_ack speech_epochs capability advert
- Status: applied
- Files: src/extraction/client-watchdog-fallback.js (+SPEECH_EPOCHS_CAPABILITY), src/extraction/sonnet-stream.js (4 ack sites), src/__tests__/sonnet-stream-resume.test.js
- Commit: 017b6070 (+ Codex-fix in the r1 commit)
- Notes: stamped on started/reconnected/resumed + rehydrate-spread-ack-only-when-resumed; withheld on new/paused/compact_skipped/stopped; wire-frame not logger row. All 4 establishing sites + negatives + the startup_log-unstamped negative pinned.

## Codex diff review
- Cycle 1: 2 IMPORTANT (both test-completeness — production wiring confirmed correct). Applied both.
- Cycle 2: 0 findings — PASSED.

### Commits
- 251a007b feat(voice): PLAN-C P4a — export CLIENT_CHIME_WATCHDOG_FALLBACK_TEXT + distinctness pin
- 017b6070 feat(voice): PLAN-C P4b — advertise the speech_epochs watchdog capability
- (Codex-fix) fix(ep): PLAN-C P4 — address Codex diff-review r1 (test completeness)

### Tests
- Full backend suite: 5487 passed / 19 skipped / 0 failed (EXIT 0). +8 new tests (P4a 4, P4b 5 minus overlaps).

### NEXT UNIT (deferred, not this run)
- P4c response-epoch ownership contract + P4d 8-row emit-site threading — the hard core of Phase 4. Then Phase 5 (web watchdog), Phase 6 (iOS watchdog + TestFlight). Ship-order gate holds: this Phase-4-part-1 must be live before those.
