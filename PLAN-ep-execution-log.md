# Plan 00B EP execution log

- Session: `20260804T070017Z-ep`
- Executor: Claude (Fable 5) — in-session `/ep` run (user-invoked, `--no-chain`)
- Target: `/Users/derekbeckley/.claude/handoffs/EICR_Automation--00b-trusted-semantic-oracle-2026-08-03/PLAN-final.md`
- Repository: `/Users/derekbeckley/Developer/EICR_Automation`
- Worktree: `/Users/derekbeckley/Developer/EICR_Automation-ep-20260804T070017Z-ep`
- Branch: `ep/plan-20260804T070017Z-ep`
- Base: `origin/main` at `9ea3bbaa` (Plan 00A merged + deployed, task-def 376)
- Startup reaper: `ep-reap: reaped=0 held=0 working=0 pattern=^ep-`
- Pre-claim policy: PASSED — 00A `.ep-success.json` present (merge `9ea3bbaa` is ancestor of origin/main; deploy job success, task-def 375→376; `plan00_tracked_bundle_provenance` sha256 `537a0d51…` verified from origin/main). The success record was written post-hold by the 2026-08-04 independent review rerun that merged PR #153.

[PLAN-SIZE] This plan bundles six feature groups (B1 lifecycle refactor + hooks, B2 mutation atoms + capture, B3 ask/audibility/playback ledgers, B4 expectation projections, B5 model lanes, B6 partition + manifest) all touching the Stage-6 lifecycle subsystem. Review effort scales with those interactions; expect a long Codex convergence.

## Step 0 — revalidate reference facts

- Status: applied
- Decision: rule 1 (verbatim). All four plan reference facts CONFIRMED against the worktree at 9ea3bbaa via a thorough line-anchored survey:
  - `scripts/model-ab` hand-builds a reduced session (`run-lane.mjs:171-188`) and treats cross-provider agreement as correctness (`compare.mjs:131-134,192`). No semantic oracle exists.
  - Corpus has 9 fixtures; `frc_4687948e…` carries the pinned IR utterance ("Downstairs Socket, circuit 3, IR L to L 100.", fixture.yaml:105) with expected op `op_ir_ctw` (clear_then_write, audibility exactly_once).
  - `initSonnetStream` (sonnet-stream.js:1752) already supports real-handler tests: ~14 suites drive the REAL wss + handlers via `wss.emit('connection', fakeWs, req, userId)` (resume/disconnect-cleanup/ask-routing suites named). Nuance: "real handler, stub socket" — `httpServer` arg unused (`noServer: true`).
  - `recordReadingWrite`/`recordBoardReadingWrite` (stage6-per-turn-writes.js:457/473) are journal/staging only — never touch `session.stateSnapshot`. `stage6-snapshot-mutators.js` owns the atoms; the known bypass surface is `stage6-dispatchers-board.js` `add_board` (`snapshot.boards.push` :896, `currentBoardId` flip :897, inline `is_distribution_circuit` :937) and `select_board` (:1039) — exactly B2's refactor target.
- Also mapped for later steps: ASK_STARTED_OBSERVER (wire-emit.js:290, fired by safeSend :296-325), address-mirror direct question sends bypassing ask_user_started (sonnet-stream.js:322-330, :3458, :3542, :4304), fast-TTS route with NO existing owner check (voice-latency-fast-tts.js:134), playback-ack REST route (voice-latency-playback-ack.js:145), address-mirror claim tokens (address-mirror-controller.js:449-471), the ACTIVE_ENTRY_CLASSIFICATION manifest+scan pattern (scripts/field-replay/lib/session-builder.mjs:30-84 + session-builder.test.js), extractionTurnId mint (stage6-shadow-harness.js:4306-4313), cost-tracker scope API (cost-tracker.js:334-386).
- Files: none (read-only)
- Commit: none
- Notes: teardown ordering baseline (handleSessionStop :6501-6632) and the 5-minute disconnect timer (:3117, stale "30s" comments at :3112/:3269) recorded as the B1 substrate.

## Step B1 — real-server lifecycle lane + teardown arbiter + dormant hooks

- Status: applied
- Decision: rule 1 (verbatim), one [ASSUMED]: the plan's "attach evaluation context at creation before start/rehydration" is implemented immediately after `activeSessions.set` — `session.start(jobState)` runs earlier in `handleSessionStart` by pre-existing order (input-state seeding, §B2-classified `input_state_seed`), and there is no entry to attach to before the set; every observable message/outbox/timer invocation happens after the attach point.
- Files: `src/extraction/plan00-lifecycle-hooks.js` (new), `src/extraction/sonnet-stream.js`, `src/__tests__/plan00-lifecycle-hooks.test.js` (new)
- Commit: `feat(extraction): Plan 00B B1 — teardown arbiter + dormant evaluation lifecycle hooks`
- Notes:
  - Dormant hooks module: non-enumerable Symbol observer/ledger, monotonic revisions, immutable sub-records, quiescence-gated exactly-once freeze (`non_quiescent_at_stop` fail-closed), latched candidate + publish promise. Zero-allocation dormant path (ledger-Symbol guard at the frame emitter).
  - Teardown arbiter: first caller of explicit-stop/disconnect-timeout installs ONE promise owning the ordered teardown; duplicate callers await. Both reconnect message types (session_start reconnect, session_resume rehydrate — made async, single call site awaited) observe `isStopping`/`teardownPromise`, await, re-read, and follow the fresh/miss path. This also fixes a REAL pre-existing race: stop frame + timer expiry could run two concurrent teardown bodies.
  - Successful-frame evidence wired at the ONE shared emitter (`sendResultFrameLedger`, 5th `entry` param threaded through all six call sites).
  - Verification: 17 new tests green; all 14 sonnet-stream suites green (294/294); byte-for-byte production-vs-evaluation frame parity pinned.

## Step B2a — mutation-commit capture at snapshot atoms + canonical board-op atoms (committed)

- Status: applied (B2 partially complete — see remaining sub-steps below)
- Decision: rule 1. New `plan00-semantic-capture.js` (MUTATION_OBSERVER Symbol, attach/emit/origin-frame helpers, createMutationObserver with op ids, seq ordering, SEMANTIC_ORIGINS enum, derived-provenance validation, joinJournalOverlay with nonMutatingSources exemption for address-mirror cloning, INVALID/HOLD latch). Every atom in stage6-snapshot-mutators.js emits exactly one receipt per REAL state change. New canonical atoms appendBoardToSnapshot / setCurrentBoardInSnapshot / markDistributionCircuitInSnapshot; stage6-dispatchers-board.js routed through them (add_board :896-897 append+flip, inline auto-mark :937-938, select_board :1039, dispatchMarkDistributionCircuit :1142-1143). 27 board/mutator/dispatch suites green unchanged (682/682) — behaviour-preservation proof.
- Files: `src/extraction/plan00-semantic-capture.js` (new), `src/extraction/stage6-snapshot-mutators.js`, `src/extraction/stage6-dispatchers-board.js`
- Commit: `feat(extraction): Plan 00B B2a — mutation-commit capture at the snapshot atoms + canonical board-op atoms`
- REMAINING for B2 (planned next): (i) origin frames at producer boundaries — central tool-dispatch seam (model_direct; calculate_* → calculator), ask auto-resolve write sites, dialogue engine direct/derived, deterministic mirror derivations; (ii) committed production-source parity manifest + scan test (classes semantic_mutation / input_state_seed / forbidden_direct_mutation, following the ACTIVE_ENTRY_CLASSIFICATION pattern in scripts/field-replay/lib/session-builder.mjs:30-84 + its scan test) incl. an unclassified-direct-write RED fixture; (iii) capture RED matrix tests (expected+extra write, wrong board/circuit, write→clear ordering, journal-overlay unmatched → INVALID/HOLD, address-mirror clone zero commits, forced capture failure per atom class); (iv) provenance RED cases (valid-parent, wrong-trigger, wrong-source, missing-parent).
- Notes: B2 receipts deliberately gate on REAL change (same-value write / no-op clear / idempotent rename / same-board select emit nothing) per "only after a real state change". Board-clear FlagAware emits once per semantic invocation (global + main-target branches emit inline; non-main branch delegates to the instrumented clearBoardReadingMultiBoard).

## Step B2 (complete) — B2b: origin frames + source-scan manifest + RED matrix

- Status: applied
- Decision: rule 1, with one [ASSUMED]: the orphan-net recovered write is framed 'model_direct' with meta via:'orphan_recovery' — the closed six-origin enum has no orphan class, and the recovery completes the model turn's inspector utterance (it pushes into result.extracted_readings). Distinguishable in expectations via the meta marker.
- Files: stage6-dispatchers.js (model_direct/calculator at createWriteDispatcher; ask_auto_resolve at createAutoResolveWriteHook), dialogue-engine (snapshot-write.js direct, derivations.js sets/mirror derived w/ parent_slot, engine.js resume-drained + bulk), stage6-shadow-harness.js (orphan), eicr-extraction-session.js (legacy leg + appendLegacyObservationRecord routing), postcode-snapshot-applier.js (atom-routed silent_deterministic locality writes), stage6-snapshot-mutators.js (appendLegacyObservationRecord), scripts/model-ab/lib/mutation-classification.mjs (new), plan00-mutation-source-scan.test.js (new, 7 tests), plan00-semantic-capture.test.js (new, 22 tests)
- Commit: `feat(extraction): Plan 00B B2b — origin frames at every producer boundary + mutation source-scan manifest`
- Notes: post-refactor covered-write surface is exactly 4 files (atoms=semantic_mutation; multi-board-shape + postcode bucket-ensure + session hydration=input_state_seed; zero forbidden). Parent provenance resolves slot-named triggers to receipts; INVALID/HOLD latch covers commit-without-origin, unresolved/missing derived parents, unmatched journal overlay, thrown capture. 1712-test regression sweep green.

## Step B3 — ask + audibility + playback ledgers

- Status: applied (with one scoping decision logged below)
- Decision: rule 1 for the ledgers + fast-TTS owner check; rule 2 [ASSUMED] for identity persistence: the durable operation identity derives from the live extractionTurnId + EFFECTIVE_CIRCUIT_SLOT markers already present in-process, and CROSS-PROCESS recovery is handled by the plan's own conservative rule (delivery_history_ambiguous:true, never reconstructed) rather than adding new identity columns to the address-mirror outbox DB rows. Same-process retries are fully observed by the ledger (every attempt retained), which is exactly the boundary the plan draws ("Same-process retry remains unambiguous only while the observer retains every attempt").
- Files: `src/extraction/plan00-audibility-ledgers.js` (new), `src/routes/voice-latency-fast-tts.js` (owner check — production hardening), `src/__tests__/plan00-audibility-ledgers.test.js` (new, 22), fast-tts route/clamp tests updated (+ cross-user RED)
- Commit: `feat(extraction): Plan 00B B3 — ask/delivery/playback evidence ledgers + fast-TTS owner check`
- Notes: ASK_STARTED_OBSERVER composition + per-frame delivery evidence are consumed evaluation-side — the harness owns its fake ws (sees every send byte) and B1's successful-frame callback fires from the ONE shared frame emitter, so no further production seams were needed for delivery evidence. srv-* answered-proof (frame id + paired transcript) is encoded in the ledger's full-proof rule.

## Steps B4 + B5 + B6 — projections, judge, lane runner, partition, combined manifest

- Status: applied
- Decision: rule 1, with two [ASSUMED] notes: (1) the deterministic-egress lane is inventoried as NAMED CASES bound by hash to the committed covering test file (plan3-observation-recode-emitter.test.js) — the four §B6 egress behaviours are already deterministically pinned there; no corpus fixture exists for them and fabricating one is prohibited. (2) Two §B6 strata (multi_board_routing, direct_observation_create_delete) have no real-provenance fixture — recorded as dated non-safety named gaps for 00C's Derek decision, per the plan's own rule.
- Files: scripts/model-ab/lib/expectation-projection.mjs (new), scripts/model-ab/lib/semantic-judge.mjs (new), scripts/model-ab/run-semantic-lane.mjs (new), scripts/model-ab/plan00-expectation-manifest.json (PUBLISHED — the .ep-policy success artifact), src/__tests__/plan00-expectation-manifest.test.js (new, 16)
- Commit: `feat(model-ab): Plan 00B B4-B6 — expectation projections, semantic judge, lane runner, partition + combined manifest`
- Notes: combined anchor + semantic_oracle_digest recomputation is the merge-blocking source check; live vendor sampling is structurally refused without 00C's attestation record; mock lane 9/9 proves projection→judge plumbing.

## Codex diff review

- Cycle 1 (wire/contract lens, gpt-5.6-sol high, read-only): 11 BLOCKERs, 0 IMPORTANT, 0 NIT. The planned three-lens parallel cycle was cut short — the first lens already went broad and its structural findings made further discovery lanes moot.
- SIX findings fixed in-scope (commit `fix(ep): address Codex review — …`, full backend suite re-gated green 311 suites / 7708 passed):
  - (4) dormant zero-allocation guards at every atom emit + both freeze call sites;
  - (5) observer callback behaviour isolation (throwing builder ⇒ `candidate_builder_threw` ineligible freeze; post-send callback can never abort the frame ledger);
  - (7) teardown-body failure now reaches a TERMINAL state (log + timer/session cleanup + entry delete — reconnect can never rebind a dying entry);
  - (8) judge consumed-index rewrite (extra mutations anywhere in the stream fail);
  - (9) semantic_oracle_digest expanded to all 19 producer/adapter/route inputs, manifest regenerated;
  - (11) scan patterns extended (nested field writes, deletes) + dated aliased-write limitation.
- FIVE findings are UNRESOLVED-STRUCTURAL — each is a genuine multi-hour remainder of the plan's full executable composition, not a patch:
  - (1) run-semantic-lane.mjs does not yet BOOT the real server and drive fixture frames end-to-end (mock mode proves projection→judge plumbing only; the production-composed per-fixture driver — real initSonnetStream + scripted SDK client + captured evidence → judge — is unbuilt);
  - (2) the evaluation-context factory registers only the lifecycle observer; full composition (mutation observers attached to session+snapshot at entry creation before start/rehydration, plus ask/delivery/playback ledgers) is not wired into handleSessionStart;
  - (3) the B3 ledgers are tested standalone but not composed through the production seams (ASK_STARTED_OBSERVER composition, address-mirror question seams, playback-ack route, per-send delivery rows);
  - (6) the quiescence check derives counts from entry state but lacks the per-entry producer start/completion counters for frames/outbox/confirmations, and pendingRefinements is cleared before the freeze on the stop path;
  - (10) frame parity is pinned for start/stop only, JSON-normalised — the full byte-level parity matrix across extraction/asks/recovery/reconnect/observation frames is unbuilt.
- Verdict: **CODEX-HELD — 5 unresolved (structural remainder of B1/B3/B5 composition)**. Convergence rule applied: these are not patchable within the review loop; continuing cycles would burn the cap without converging. No merge, no deploy, draft PR only. Plan 00C remains policy-locked (its pre-claim requires 00B's genuine shipped record, which is correctly absent).

## Completed 2026-08-04T09:05:00Z

**Outcome: CODEX-HELD — 5 unresolved (structural remainder of B1/B3/B5 composition)**

### Commits made
- `98758c58` feat(extraction): Plan 00B B1 — teardown arbiter + dormant evaluation lifecycle hooks
- `21bea13b` feat(extraction): Plan 00B B2a — mutation-commit capture at the snapshot atoms + canonical board-op atoms
- `aed96937` feat(extraction): Plan 00B B2b — origin frames at every producer boundary + mutation source-scan manifest
- `58117783` feat(extraction): Plan 00B B3 — ask/delivery/playback evidence ledgers + fast-TTS owner check
- `cbd4d222` feat(model-ab): Plan 00B B4-B6 — expectation projections, semantic judge, lane runner, partition + combined manifest
- `1d99c116` docs(extraction): corpus/architecture doc updates + A2 egress pin follows the 5-arg emitter
- `961b241a` fix(ep): address Codex review — six in-scope defect fixes
- (final) chore(ep): execution log mirror

### Plan deviations
None shipped (nothing shipped). Two [ASSUMED] interpretations logged inline (B1 attach-point after activeSessions.set; B2 orphan-recovery origin classed model_direct via:'orphan_recovery'); one B3 scoping decision (no new outbox DB identity columns — cross-process recovery relies on the plan's own delivery_history_ambiguous conservative rule).

### Assumed decisions
See [ASSUMED] entries in steps B1, B2, B4-B6.

### Skipped / blocked / failed steps
- Codex ship gate: CODEX-HELD (findings 1, 2, 3, 6, 10 unresolved — the full executable composition of the real-server lane, complete evaluation-context wiring, B3 seam composition, complete quiescence counters, and the byte-level parity matrix). Draft PR only; no merge, no deploy, no success artifact.
- Plan 00C: NOT RUN — its pre-claim policy requires 00B's genuine shipped/deployed record, which correctly does not exist.

### Stashes left behind
None.

### Tests run + result
- Full backend: 311 suites passed / 1 skipped; 7708 passed / 19 skipped (twice — pre- and post-fix).
- Recorded field corpus: 9/9. Web suite: green (exit 0).
- New plan00 suites: lifecycle-hooks 17, semantic-capture 22, mutation source scan 7, audibility ledgers 22, expectation manifest 16; mock semantic lane 9/9.

### Follow-ups noticed
[FOLLOWUP] Complete the Plan 00B executable composition (Codex findings 1/2/3/6/10) — run-semantic-lane must boot initSonnetStream and drive fixture frames end-to-end with a scripted SDK client; the evaluationContextFactory must compose mutation observers + ask/delivery/playback ledgers at entry creation; quiescence needs producer start/completion counters; frame parity needs the byte-level matrix. Smallest next action: re-plan as a focused 00B-successor (rp) covering ONLY the composition seam, then re-EP.
[FOLLOWUP] AST-based mutation source scan — the line-regex scan cannot see aliased-bucket writes (documented dated limitation in scripts/model-ab/lib/mutation-classification.mjs). Smallest next action: espree/acorn walk over covered files classifying member-assignment targets.
[FOLLOWUP] ccu-cv-pitch.test.js unseeded white-noise flake (carried over from the 00A run's CI; predates this wave). Seed the RNG or use a statistically robust bound.
