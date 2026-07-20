# PLAN-D (P4d) — /ep execution log

**Plan:** `PLAN-D-p4d-emit-sites-final.md` — the ask/question/voice-command emit-site response-epoch matrix (rows 1–8), completing PLAN-C Phase 4.
**Session:** `20260720T073303Z-ep`
**Branch:** `ep/PLAN-D-p4d-emit-sites-20260720T073303Z-ep` (off the P4c branch `ep/plan-c-phase4pt2-epoch-contract-20260720T064310Z-ep2` @ `cf52fe23`, per the plan's REQUIRED base).
**Worktree:** `/Users/derekbeckley/Developer/EICR_Automation-ep-20260720T073303Z-ep`

## Completed — ALL PASSED (Codex diff-review converged clean at cycle 3)

Every one of the 8 emit-site rows was implemented, tested, gated, and Codex-reviewed. The Codex diff review (3 parallel lenses → per-fix mini-review → cycle-2 verify → cycle-3 verify) converged 4 → 3 → **0** findings; cycle 3 returned an empty findings array. No sanctioned plan-deviations were applied (the one out-of-repo item — the iOS CertMateUnified/CLAUDE.md row — was a documented deferral, NOT an invented-scope deviation).

### Rows (all applied)
- **Row 1 — dialogue engine.** `buildScriptAsk/Confirm/Info` (`wire-emit.js`) gained a REQUIRED `responseEpoch` (sentinel default → throws on a missed thread; explicit null allowed). Threaded parallel to `now` through every nested engine fn to all 18 builder call sites; NEVER derived in `safeSend`; `ASK_STARTED_OBSERVER` reports the stamped id (backstop). Sources: sonnet-stream active-path turns → `msg.utterance_id`; shadow-harness resume/entry hooks → `responseEpochRef.current`; the `start_dialogue_script` dispatcher → a session-stashed live `responseEpochRef` (set at top of `runLiveMode`, cleared in finally).
- **Rows 2–3 — legacy ring/IR scripts.** Own builders + inline asks stamp the epoch (null-default, NOT the sentinel — dead files, no live importer verified; carried for wire-contract completeness).
- **Row 4 — dispatcher.** Initial + pvr `ask_user_started` QUESTION frames carry `responseEpochRef.current` (optional-chained).
- **Row 8 — batch id (SOURCE).** `_processUtteranceBatch` carries the LAST NON-EMPTY buffered `utteranceId`; `_extractSingle` preserves it as `result.utterance_id` (KEY OMITTED when absent — never `null` — because it spreads into the extraction frame).
- **Row 5 — question frames.** New `stampQuestionsWithUtteranceId` clones each question with the epoch BEFORE enqueue (onBatchResult/sync → `result.utterance_id`; orphan-review → `consumedUtteranceId`).
- **Row 6 — voice_command_response.** sync + onBatchResult carry it.
- **Row 7 — reconnect replay.** Strips `spoken_response`/`action` from the extraction replay + emits a SEPARATE `voice_command_response` carrying the buffered epoch. Hardened: VCR is the LAST fallible send, the flush HALTS-on-failure and RE-QUEUES undelivered entries in FIFO order, and `dispatchObservationUpdates` gained a `failFast` flag for the flush — so the spoken reply is never lost/reordered/double-spoken.

### Assumed / deliberate decisions (sanity-check these)
- **[ASSUMED] Rows 2/3 null-default (not the REQUIRED sentinel).** The legacy ring/IR scripts are dead code — `sonnet-stream` imports the turn wrappers from `dialogue-engine/index.js`, NOT these files (verified: zero live importers). A throw-on-missing there would add production-abort risk with zero watchdog benefit. Implemented the stamping faithfully with a null default. Logged in the rows-2/3 commit body.
- **[ASSUMED] iOS CertMateUnified/CLAUDE.md row DEFERRED.** The plan's Docs section lists an iOS recent-change row, but CertMateUnified is a SEPARATE repo (absent + untracked in this backend worktree) and P4d ships ZERO client change. The deferral to the Phase 6 iOS TestFlight wave is recorded in the backend changelog + the `recording/chime-silence-watchdog` parity-ledger row (owner: Derek / Phase 5–6). Codex rated this NIT (2 of 3 lenses) and accepted the deferral in cycle 3.
- **[ASSUMED] pvr assertion by symmetry.** The dispatcher pvr re-ask uses the byte-identical `responseEpochRef?.current` stamping as the initial ask (asserted directly). A full pending-value-flow pvr integration was judged disproportionate; covered by that symmetry + the initial-ask test. (Codex accepted in cycle 3.)

### Codex diff-review — the ship gate
- **Cycle 1 (3 parallel lenses: wire-contract / silent-path / edge):** 4 findings. (1) handleBulkApplyReply call dropped `responseEpoch` (live RCD path) — BLOCKER; (2) `result.utterance_id=null` leaked onto extraction frames (byte-identity) — BLOCKER/NIT; (3) row-7 reconnect could lose a buffered spoken_response mid-flush — BLOCKER; (4) internal helper `= null` defaults weakened the REQUIRED sentinel — IMPORTANT. Plus a test-completeness IMPORTANT. All fixed (internal helpers now default to the sentinel → a missed thread throws, which is how the bulk-apply miss was caught; the dialogue suite is provably-exhaustive at 721 green).
- **Per-fix mini-review:** found my row-7 re-queue was non-FIFO + could double-speak the VCR, and my row-7 test was tautological. Fixed: VCR-last + halt-on-failure + FIFO re-queue; test now throws on the extraction frame specifically + asserts exactly-once VCR + a FIFO case.
- **Cycle 2:** 3 findings. (1) `dispatchObservationUpdates` swallowed send errors so the flush didn't halt on an obs-update failure — added `failFast`; (2) the real-session A/B integration test was still absent — added `plan-c-p4d-batch-frames.test.js` (real EICRExtractionSession → real batched result carries B on extraction/question/live-VCR/reconnect); (3) doc NITs (counts, "omitted key" wording, iOS-behaviour claim) — fixed.
- **Cycle 3:** **0 findings — PASSES.**

### Gates
- **Full backend Jest:** 5539 passed / 19 skipped / 0 failed (baseline 5503 + ~36 new P4d tests).
- **Field-replay corpus (prepush):** 5/5 pass, strict gate green.
- **Lint:** 0 errors (12 pre-existing warnings, unchanged style).

### Commits (on the branch, in order)
- `c57eadad` row 1 · `4aa386fc` rows 2-3 · `bb2dfa53` row 4 · `1b2aaa92` rows 5-8 · `b53da2cc` tests · `d279f97d` observer-test update · `5c5dde72` docs · `f3ef8ea8` Codex r1 fixes · `0702e164` mini-review fixes · `e3d7d042` Codex r2 fixes.

### Files touched
`src/extraction/dialogue-engine/helpers/wire-emit.js`, `dialogue-engine/engine.js`, `ring-continuity-script.js`, `insulation-resistance-script.js`, `stage6-dispatcher-ask.js`, `stage6-shadow-harness.js`, `stage6-dispatchers-script.js`, `sonnet-stream.js`, `eicr-extraction-session.js`; tests `plan-c-p4d-emit-sites.test.js`, `plan-c-p4d-batch-id.test.js`, `plan-c-p4d-legacy-frames.test.js`, `plan-c-p4d-batch-frames.test.js`, `wire-emit-ask-started-observer.test.js`; docs `CLAUDE.md`, `docs/reference/changelog.md`, `docs/reference/ios-pipeline.md`, `web/docs/parity-ledger.md`.

## Ship (see the `## Ship` block appended below for the outcome)
Per the plan's LOAD-BEARING ship order, P4d STACKS on the P4c branch; the PREFERRED path is to fast-forward the P4c branch to this branch's HEAD (completing draft PR #106 into the full Phase-4 PR to `main`), then mark ready + merge. BOTH P4c + P4d must be on `main` before any client arms (Phase 5 web watchdog / Phase 6 iOS). After merge: wait for the deploy JOB conclusion = success AND the backend task-def to increment past `:331` (NEVER trust `rolloutState` alone — post-#98 rule).
