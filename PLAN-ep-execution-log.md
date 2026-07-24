# /ep execution log — P4 ask-decline-ack-net

- **Plan:** `PLAN-final.md` (feedback id 85 / session 2ACE7677)
- **Session:** `20260723T233944Z-ep`
- **Repo:** `/Users/derekbeckley/Developer/EICR_Automation`
- **Branch:** `ep/PLAN-20260723T233944Z-ep`
- **Worktree:** `/Users/derekbeckley/Developer/EICR_Automation-ep-20260723T233944Z-ep`
- **Base:** `main` @ `da8d1fb2` (P3 #111 + P5 #110 already landed — the batch predecessors)

Node note: local runs on v25.6.1 (dev box); CI authoritative on Node 20. Worktree
`node_modules` symlinked from the main checkout for local test runs.

## Step 1 — onAskAnswered resolution-time observer (dispatcher)
- Status: applied
- Decision: rule 1 (verbatim). Added the `onAskAnswered({toolCallId, answered, declineClass, source})` option to `createAskDispatcher`; fired AFTER the initial ask await (with `classifyDeclineReply(outcome.user_text)`) and after each `pvr-*` `brokerDeterministicAsk` await; threaded through `buildResolvedBody` → `resolvePendingValueFlow` → `runPendingValueChain` → `brokerDeterministicAsk` exactly as `onAskUserStarted` is. Both fire sites guard-swallow observer errors.
- Files: `src/extraction/stage6-dispatcher-ask.js`
- Commit: `839fbf56`

## Step 2 — per-turn ask-lifecycle ledger + the net (harness)
- Status: applied
- Decision: rule 1. Ledger (`askLifecycleLedger` Map + monotonic `askEventSeq`) created alongside `emittedAskToolCallIds`; `onAskUserStarted` stamps emission, the new `onAskAnswered` stamps resolution+answered+declineClass; `_seedAskLifecycle` test seam replays events through the REAL observers. New net after the marker-② catch block, before the §A4 drain: fires on `confirmationsEnabled` ∧ not-cancelled ∧ LAST-emitted-ask `answered===true` ∧ zero post-answer speech (debounced EXCLUDED; `!isAudibleText(spoken_response)` A1 term). Two families `ASK_DECLINE_ACK_PROMPTS` / `ASK_ANSWERED_ACK_PROMPTS` rotate `turnNum % len`. Telemetry `stage6.answered_ask_ack_emitted` (+ error guard).
- Files: `src/extraction/stage6-shadow-harness.js`
- Commit: `839fbf56`

## Step 3 — fixture-schema Option-B relaxation
- Status: applied
- Decision: rule 1. `field_null_fallback` matcher now validates with a NON-EMPTY trimmed `text_exact` alone (token no longer required; empty/whitespace still rejected). Chosen over Option A (net-new `audibility.answered_ask` oracle) per the plan's stated preference — far smaller change.
- Files: `scripts/field-replay/lib/fixture-schema.mjs` + 5 validation tests in `src/__tests__/field-replay/fixture-schema.test.js`
- Commit: `10af0eed`

## Step 4 — unit + audibility-sweep tests
- Status: applied
- Decision: rule 1, with one realism correction (see [ASSUMED]). New `stage6-ask-decline-ack-net.test.js` (15 cases) + a real-composition integration case + timeout negative in `stage6-audibility-invariants.test.js`. `ASK_USER_ANSWER_OUTCOMES` enum untouched → its disjoint/union invariants stay green automatically.
- Files: `src/__tests__/stage6-ask-decline-ack-net.test.js` (new), `src/__tests__/stage6-audibility-invariants.test.js`
- Commit: `839fbf56`
- **[ASSUMED] step 4** — the mocked-lane "fires" tests needed the `ask_user` tool call PRESENT in `toolLoopOut.tool_calls` (a `silentAnsweredLoop()` helper), because a real answered-ask turn always carries the ask_user in the loop, which is exactly what EXCLUDES the A3/marker-① orphan net (it keys on empty `tool_calls`). An empty-tool-call mock let marker-① fire and mask the P4 net — a mock artifact, not a real path. Chose the realistic mock (single obvious interpretation; verified against the A3 predicate at `stage6-shadow-harness.js:~1975`).

## Step 5 — recorded-lane fixture (Option B, RED→GREEN proven)
- Status: applied
- Decision: rule 1. `frc_85ace7677d0e1c4a7b2f3609e5d1a8c4/fixture.yaml` — single turn: `ask_user` (concrete `context_field: measured_zs_ohm`, circuit 3) answered "No. Don't worry." (escalates with no write, no pending-value apology), model no-op round 2. `expected_audible_outputs` declares BOTH the ask frame AND the ack (`kind:field_null_fallback`, `text_exact: "No problem, moving on."`).
- **RED-proof:** with the harness reverted to pre-net (`da8d1fb2`), the fixture (flipped to `expected_red`) failed EXACTLY `audibility.output.out_decline_ack` ("expected 1 audible output(s), found 0"), gate verdict "expected RED confirmed". Harness + fixture then restored; `required_green` passes. Full corpus 7/7.
- Files: `tests/fixtures/field-replay-corpus/frc_85ace7677d0e1c4a7b2f3609e5d1a8c4/fixture.yaml` (new)
- Commit: `fa957016`

## Step 6 — docs + gates
- Status: applied
- Decision: rule 1. architecture.md (Stage 6 audibility-net section), changelog.md (detailed), CLAUDE.md (hub one-liner), field-replay-corpus.md (`field_null_fallback` oracle subsection). Full backend suite **5989 passed / 0 failed / 19 skipped**; corpus **7/7**; my changed files lint clean (0 errors). Pre-existing repo lint artifacts (the `packages/` glob ESLint-9 ignore → `npm run lint` exit 2; `postcode_lookup.js:207` no-empty error) reproduce on `main` and are NOT introduced by this change.
- Files: `docs/reference/architecture.md`, `docs/reference/changelog.md`, `docs/reference/field-replay-corpus.md`, `CLAUDE.md`
- Commit: `f47d8c6f`

## Gate summary (pre-Codex)
- Every plan step: **applied**.
- Backend Jest: 5989 passed, 0 failed.
- Field-replay corpus: 7/7.
- Lint (my files): clean.
- **Gate: ALL PASSED** → proceed to the Codex diff review before merge.

## Codex diff review (gpt-5.6-sol, reasoningEffort high)

Codex was rate-limited (quota exhausted by the earlier P5/P3 batch's review
cycles) for ~4h; per the /ep policy I held the merge and retried rather than
ship unreviewed or downgrade the model. Once the quota cleared, the review ran
to convergence. The full diff+plan+context exceeded the freshly-reset
token-per-window budget, so the review ran on the behavioral CORE diff
(src/extraction + scripts — where all runtime risk lives); the tests/fixture/docs
are non-runtime and already green + RED-proven.

### [DEVIATION] — cancelled-turn coverage (Codex-sanctioned WITHIN_INTENT)
The plan's predicate 1 says the net fires only on NON-cancelled turns ("the F7
Item-3 cancellation branch owns cancelled turns"). Cycle 1 found this assumption
WRONG: F7's cancellation branch fires ONLY when `emittedAskToolCallIds.size===0`,
so an ANSWERED ask (size>0) on a cancelled turn is covered by NO net → silent,
the exact feedback-85 class. The net now fires on cancelled turns too. Codex
cycle 2 evaluated this against the conversation-context and returned
**WITHIN_INTENT**, quoting: *"P4 covers ONLY feedback id 85 (the answered-ask
decline → silence). It is the sibling to the 'chime is a promise' invariant …
a chimed/answered turn MUST produce audible output."* Applied + shipped as a
sanctioned deviation (commit `65d0c4d1` + ordering completions in `1e95f8cd`,
`ea9cc9e0`).

### Cycles
- **Cycle 1** (4 findings: 1 BLOCKER + 3 IMPORTANT) — cancelled silent-path
  (→ the WITHIN_INTENT deviation above); ledger resolutionSeq>emissionSeq guard;
  over-broad classifyDeclineReply (whole-reply anchor + digit guard); padded
  text_exact fixture-schema reject. All applied (`65d0c4d1`).
  - Per-fix mini-review: 2 NITs (declineClass re-emission reset; classifier
    politeness/curly-apostrophe false-negatives) applied (`7b1261ce`).
- **Cycle 2** (2 findings: 1 BLOCKER + 1 IMPORTANT) — onAskAnswered ordered
  before the cancel guard (real-dispatcher regression); 3→5-phrase burst-margin
  families (append-only, fixture pin unchanged). Applied (`1e95f8cd`).
  - Per-fix mini-review: 1 BLOCKER — advanceResponseEpoch must ALSO precede the
    cancel guard (else the cancelled-turn ack carries a stale utterance_id and a
    client watchdog false-fires a second fallback). Applied (`ea9cc9e0`).
- **Cycle 3** (1 IMPORTANT) — max-emissionSeq selection ≠ the plan's exact
  "latest-answered / later-emitted" rule (an interleaved unanswered srv-* ask
  could wrongly suppress). Reimplemented to the plan's two-step rule + regression
  (`83da44e4`).
- **Cycle 4** — CLEAN (0 BLOCKER, 0 IMPORTANT). Converged.

Trajectory (BLOCKER/IMPORTANT counts): 4 → 2 → 1 → 0.

## Final gate (post-Codex)
- **Outcome: ALL PASSED (plan-deviation: 1 applied within original intent).**
- Backend Jest: 6031 passed, 0 failed (+42 over the pre-review baseline).
- Field-replay corpus: 7/7 (fixture `frc_85ace7677…` RED-proven → required_green).
- Lint: my files clean.
- Codex diff review: PASSED at cycle 4.
- → Ship: ready PR + merge + CI/ECS deploy watch (backend-only; no iOS/TestFlight
  component). Then make-live + chain to the next queued batch plan.
