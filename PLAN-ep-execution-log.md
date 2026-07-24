# Execution log — P2 read-back exactly-once (/ep autonomous run)

- Session: `20260724T101516Z-ep`
- Plan: `PLAN-final.md`
- Target repo (EICR_Automation): `/Users/derekbeckley/Developer/EICR_Automation`
- Worktree: `/Users/derekbeckley/Developer/EICR_Automation-ep-20260724T101516Z-ep`
- Branch: `ep/PLAN-20260724T101516Z-ep` off `main` @ `55e11062`
- iOS repo (CertMateUnified, SEPARATE git repo, gitignored in EICR_Automation): `/Users/derekbeckley/Developer/EICR_Automation/CertMateUnified`
- Chain: `--chain --chain-hop=3` (wave member, `.ep-queue` marker present)

## Structural notes (pre-execution)

- **Two-repo plan.** EICR_Automation holds the backend mirror (A1-2) + web (A1-3) + docs. All iOS work (A1-1 dedupe key, Bug A' correction-swallow, Bug B double-read-back) lives in the SEPARATE `CertMateUnified` repo — the `/ep` worktree isolates ONLY EICR_Automation, so iOS edits happen in an isolated CertMateUnified worktree branched off iOS `origin/main`.
- **iOS checkout was on a HELD branch** `marker1-numeric-chatter-gate-20260717T211033Z` (memory: numeric-chatter gate HELD, must NOT ship). iOS `origin/main` does NOT contain it — iOS work branches off clean `origin/main`.
- **[PLAN-SIZE]** This plan is one feature (read-back exactly once) but Bug B (id-87 double read-back) is an intricate iOS fast-path concurrency subsystem — 7 /rp rounds to specify (new VM record store, generation-scoped lifecycle, alias join, fail-closed canonicaliser, grouped-confirmation aggregate coordinator, nil-board resolver, per-circuit synthesis). Review effort scales with interaction count; expect a long Codex convergence on the iOS diff. This is a warning, not a gate.
- **No cross-client wire dependency** (plan: NO wire-shape/decoder change). Each platform computes its dedupe key independently; the backend mirror is telemetry-only. So the EICR_Automation PR (backend mirror + web + docs) is self-consistent and shippable independently of the iOS TestFlight.

## Steps

### Step A1-2 — backend telemetry mirror (value-aware buildPerCircuitDedupeKey)
- Status: applied
- Decision: rule 1 (verbatim). Call site drifted `:2523`→`:2896` (context-context warned); threaded `entry.text`. Docstrings reversed to value-aware; symbol-named the correction site instead of a line number.
- Files: `src/extraction/ios-dedupe-key.js`, `src/extraction/stage6-shadow-harness.js`, `src/__tests__/ios-dedupe-key.test.js`, `src/__tests__/stage6-shadow-harness-telemetry.test.js`
- Commit: `b8070644`
- Notes: `[ASSUMED]` the end-to-end telemetry test at `stage6-shadow-harness-telemetry.test.js:235` (single match, `entry.text` bundler-synthesized) → asserted the value-aware SHAPE `/^measured_zs_ohm_1_\d+$/` rather than a brittle hash of the exact synthesized line. 29/29 drift tests green. `stage6-event-bundler.test.js:950` untouched (plan-declared). Worktree had no node_modules → symlinked from main repo (same lockfile/base).

### Step A1-3 — web value-aware single-circuit key
- Status: applied
- Decision: rule 1. Single-circuit branch → `${field}_${circuit}_${djb2(text)}`; token precedence unchanged. Docstrings reversed. Store unchanged (Derek: no TTL).
- Files: `web/src/lib/recording/confirmation-dedupe-key.ts`, `web/tests/confirmation-dedupe-key.test.ts`
- Commit: `f6f6b785`
- Notes: The `same field+circuit + different text → DEDUPED` test FLIPPED to both-speak (the whole point of id-84); added a same-text-repeat-still-dedupes test. Hash vectors regenerated from the backend mirror. `confirmation-dedupe-store.test.ts` uses opaque key strings → no change. 32/32 web dedupe tests green.

### Step Docs — changelog + hub row + reference doc + parity ledger
- Status: applied
- Decision: rule 2. No dedicated confirmation-dedupe section existed in the recording-pipeline reference (`ios-pipeline.md`), so ADDED a concise "Confirmation read-back dedupe key" section (three key shapes + the id-84 value-aware change). Changelog row + hub one-liner. Parity ledger: NEW row `recording/readback-dedup-value-aware` (partial until device smoke) + files-map entry; the existing `recording/readback-dedup-rekey` note annotated SUPERSEDED where it documented the now-retired "measured fields stay value-less for the correction cross-match" contract.
- Files: `docs/reference/changelog.md`, `CLAUDE.md`, `docs/reference/ios-pipeline.md`, `web/docs/parity-ledger.md`, `web/docs/parity-ledger-files.json`
- Commit: `6c3d8973`

### Step A1-1 (iOS) — value-aware single-circuit buildConfirmationDedupeKey
- Status: applied (in the SEPARATE CertMateUnified repo; isolated worktree off iOS `origin/main` @ `ee71c8c`, branch `ep/p2-readback-exactly-once-20260724T101516Z-ep`)
- Decision: rule 1. Single-circuit branch folds djb2 of `conf.text` (`{field}_{circuit}_{djb2(text)}`), matching the multi-circuit branch. Docstrings (function summary, single-circuit rationale, §A1a measured-fields note) rewritten to value-aware; stale "line 6845" cross-refs replaced by symbol name `correctionDedupeKey`.
- Files: `CertMateUnified/Sources/Recording/DeepgramRecordingViewModel.swift`
- Notes: line refs drifted (`buildConfirmationDedupeKey` at :904, not the plan's :931).

### Step A' (iOS) — value-aware client-initiated correctionDedupeKey
- Status: applied (CertMateUnified worktree)
- Decision: rule 1. `correctionDedupeKey` made value-aware by folding djb2 of `ttsText` (`shortKey_circuit_djb2(ttsText)`) — this shape now MATCHES the value-aware `buildConfirmationDedupeKey` single-circuit branch, so the inline-key and the deferred-flush recomputed-key stay consistent. Dedupe check switched from `confirmedFieldKeys.contains` to `isConfirmationKeyLive(..., fieldIsNil:false)`; inline speak branch now RESERVES via `makeConfirmationKeyReservation` + threads `keyReservation` into `speakBriefConfirmation` (mirrors the server-confirmation inline path at :9688) instead of the permanent `confirmedFieldKeys.insert` — a discarded/failed-to-play correction stays re-speakable.
- Files: `CertMateUnified/Sources/Recording/DeepgramRecordingViewModel.swift`
- Notes: correction path drifted to :7938-8014 (plan cited :7945). Deferred correction path unchanged (matches the main deferred path — flush handles the key).

### Step Bug B (iOS) — id-87 double read-back fast-path suppression
- Status: DEFERRED (not implemented)
- Decision: rule 3 (skip rather than guess) + overriding product-safety. Bug B is an all-or-nothing intricate iOS fast-path concurrency SUBSYSTEM — 7 /rp rounds to specify: a new VM-owned fast-attempt record store (exact + base-slot lookups, nil-board resolver, two-terminal lifecycle, generation token), VALUE + effective-board in the suppression identity, a `canonicalFastPathField` alias mapper, a fail-closed field-aware value canonicaliser, generation-scoped supersession across ~6 AlertManager+VM lifecycle mutation sites, a grouped-confirmation aggregate coordinator with per-circuit text synthesis, and an AlertManager↔VM lifecycle-ownership re-architecture (threading correlation-id+generation callbacks out of private AlertManager methods). It touches the LIVE recording audio path field inspectors hear. A PARTIAL implementation is explicitly WORSE than none (the plan states a key-format-only fix INTRODUCES a new Audio-First violation — a fast clip suppressing a different Sonnet-final value). It cannot be implemented to a shippable, VERIFIABLE standard in an autonomous run with no iOS test loop (the batched-turn / grouped / generation races are runtime/on-device; xcodebuild-test is heavy and can't deterministically exercise the concurrency). The Codex diff-review gate reviews against the plan but cannot catch Swift compile/runtime/on-device audio regressions. iOS shares P7's TestFlight (explicitly NOT this-run-urgent). → Deferred to a supervised iOS session with a real build+test loop.
- Files: none
- Notes (Bug B deferral): The iOS surface was fully mapped for the handoff — `AlertManager.swift` fast-path state machine (`FastPathSlotState` :219, `fastPathSlotStates` :227, `slotKey(field:circuit:boardId:)` :457, `markFastPathPending` :1524 / `markFastPathFailed` :1532 / `playFastPathAudio` :1465, suppression block in `speakBriefConfirmation` :1359-1403, `discardQueueItemPrePlay` :1571, `purge(prefix:)` :2007, `ConfirmationKeyReservation` :243) + the VM fast-path dispatch (`DeepgramRecordingViewModel.swift:3053-3114`, 2-part slotKey at :3055; the inline `slotKey:nil` confirmation at :9692; `ValueConfirmation`/`ExtractedReading` in `Sources/Services/ClaudeService.swift`). This map + the plan §"Bug B" is the ready brief for the supervised session.

## Codex diff review (EICR_Automation worktree diff)

- **Cycle 1** (single combined 3-lens review — wire-contract faithfulness + silent-path hunt + edge/test fidelity; the mandated parallel 3-lens hit a rate limit + a schema error, folded into one call for a 458-line focused diff): 1 BLOCKER + 2 IMPORTANT.
  - BLOCKER (Documentation sync) — `AGENTS.md` is a TRACKED hub-changelog mirror of `CLAUDE.md`; the P2 row was added to CLAUDE.md only. → APPLIED (added the P2 row to AGENTS.md), commit `897e245c`.
  - IMPORTANT (Test fidelity) — the `stage6-shadow-harness-telemetry.test.js` reading-row assertion used only a shape regex, which would still pass if `entry.text` regressed to undefined (5381 fallback). → APPLIED (assert wire text non-empty AND `expected_dedupe_key === buildPerCircuitDedupeKey(wire.field, wire.circuit, wire.text, wire.dedupe_token)`), commit `897e245c`. 29/29 dedupe tests still green.
  - IMPORTANT (Silent-path / djb2 collision) — `recommended_fix = OUT_OF_SCOPE`, `intent_verdict = WITHIN_INTENT` but evidence was a GENERIC quote (the feature covers id-84), NOT an affirmative instruction to change the djb2 contract. → NOT APPLIED (correctly). This is a theoretical property of the Derek-decided cross-platform djb2 TEXT-HASH identity contract that the multi-circuit + degenerate branches have used since 2026-06/07 — not new to this diff, worst case one re-dictation. The recommended fix explicitly contradicts the plan's TEXT-HASH decision, so applying it would be an out-of-plan invention. Recorded as decided-not-a-defect; passed to cycle 2 on the "do NOT re-flag" list.
- **Cycle 2** (re-review with the djb2 finding on the already-decided list): **0 findings — CLEAN.** Verdict: **PASSED.** Both fixes verified correct + complete; full diff faithful to the plan, no new correctness findings. Backend 6094 + web 1457 green.



## Completed 2026-07-24 (EICR_Automation scope)

### Outcome header: ALL PASSED (EICR_Automation worktree deliverable) — iOS Bug B (id-87) DEFERRED to a supervised P7-shared TestFlight

This run has TWO deliverables in TWO repos. The `/ep` worktree/gate/Codex-review/deploy machinery operates on the **EICR_Automation worktree** (a gitignored, SEPARATE iOS repo cannot be in it). The worktree deliverable (backend telemetry mirror A1-2 + web A1-3 + docs) is **complete, full-suites-green, and Codex-clean** → it ships. The iOS work is a separate repo on a separate (P7-shared) TestFlight channel that this run's merge does not trigger; iOS A1-1 + Bug A' are done + compile-verified on an iOS branch, and Bug B (id-87) is deferred (see its step). This is plan-sanctioned: the plan's Delivery section separates "web-only PR" + "small backend PR" from the iOS TestFlight.

### Commits (EICR_Automation branch `ep/PLAN-20260724T101516Z-ep`)
- `b8070644` — A1-2 backend telemetry mirror value-aware key
- `f6f6b785` — A1-3 web value-aware single-circuit key
- `6c3d8973` — docs (changelog + hub + ios-pipeline reference + parity ledger)
- `897e245c` — Codex fixes (AGENTS.md hub sync + exact telemetry assertion)

### Commits (iOS branch `ep/p2-readback-exactly-once-20260724T101516Z-ep` in CertMateUnified)
- `f1a0c45` — iOS A1-1 + Bug A' (value-aware keys), compiles clean (xcodebuild)
- `14d446a` — iOS tests (compiles clean, build-for-testing)

### Tests run
- Backend Jest FULL: 6094 passed, 19 skipped, 0 failed.
- Web vitest FULL: 1457 passed, 1 skipped, 0 failed.
- iOS: `xcodebuild build` + `build-for-testing` both exit 0 (compile-verified; suite NOT run — deferred to supervised session).

### Codex diff review: PASSED (clean at cycle 2). See the Codex section above.

### Assumed decisions to sanity-check
- `[ASSUMED]` telemetry test at `stage6-shadow-harness-telemetry.test.js` — the bundler-synthesized text made a hardcoded hash brittle; first used a shape regex, then (per Codex) strengthened to an exact `buildPerCircuitDedupeKey(...)` equality against the wire confirmation. Sound.

### Skipped / deferred
- **iOS Bug B (id-87 double read-back)** — DEFERRED (not implemented). All-or-nothing intricate iOS fast-path concurrency subsystem; unverifiable to a shippable standard autonomously (no iOS test loop; live-audio-path regression risk; a PARTIAL version introduces a NEW Audio-First violation per the plan). Shares P7's TestFlight. Ready brief = the plan §"Bug B" + the iOS surface map in this log. **iOS A1-1 + Bug A' are NOT auto-merged/TestFlighted** — they ride the supervised P7-shared build so the whole iOS wave (incl. Bug B) verifies together with a test loop.
