# /ep execution log — PLAN-2 (silent partial failure)

- Session: `20260730T085845Z-ep`
- Repo: `/Users/derekbeckley/Developer/EICR_Automation` · Base: `main` @ `18561555` (PLAN-1 merged, PR #132)
- Branch: `ep/PLAN-2-feedback-2026-07-27-20260730T085845Z-ep`
- Worktree: `/Users/derekbeckley/Developer/EICR_Automation-ep-20260730T085845Z-ep`
- Plan: `PLAN-2-final.md` (converged round 13)

[PLAN-SIZE] This plan bundles ~6 feature groups (§3.1 notice machinery, §3.2 steer, §3.3 resolution, §3.4 ref_method, §3.5 token, §3.6 drift manifests) across one high-interaction subsystem (stage6 dispatch/audibility). Review effort scales with interaction count — expect a long Codex convergence.

## Phase 0 — CloudWatch diagnostics (2026-07-30, run FIRST, zero code)

Log group `/ecs/eicr/eicr-backend`, eu-west-2, 30-day retention (2026-07-27 present). Queries paginated with `--max-items`; cross-checked dispatch counts against `voice_latency.turn_core_summary` rows.

### id 112 — VERDICT: MODEL-SIDE (4 calls)
Session `BE1C53C0-311B-4600-A6E4-D4140302DA07`, the "circuits 5 to 10" turn = **turn-5 @ 2026-07-27 10:23:37**:
- Exactly **4** `record_reading` dispatches: `rcd_time_ms` circuits **5, 6, 9, 10** — ALL `is_error:false`, `outcome:ok`. `turn_core_summary tool_call_count_total:4`, `tool_error_count_per_round:[0,0]`.
- **Zero** `circuit_not_found` rejections. The model never emitted calls for 7/8 — the gap is in the MIDDLE (burst-truncation, which drops a tail, is ruled out).
- turn-6 @ 10:24:51 is the follow-up that added circuits 7 and 8 (2 more `record_reading`, both ok) — i.e. the inspector had to re-dictate the missing ones.
- **Matrix row:** id 112 = 4 calls (model-side) ⇒ execute §3.2 prompt steer; harden channel-1 notice machinery with a **SYNTHETIC test only**; do **NOT** author a recorded fixture for 112. §3.2 steer ships regardless.

### id 102 — VERDICT: CANDIDATE 1 (client dedupe swallow)
Session `2C297353-7326-4555-A98D-A2C5A7FD3E0E`, postcode amend turns 08:46–08:47:
- **Backend SENT every time** — `ios_send_attempt` for `field:"postcode"` present on all three amend turns:
  - turn-3 @ 08:46:43, key `postcode_15086727561861004891` → client `confirmation_tts_decision{decision:"spoke_inline"}` (SPOKEN)
  - turn-4 @ 08:46:58, SAME key → client `confirmation_tts_decision{decision:"deduped"}` (SILENT)
  - turn-5 @ 08:47:39, SAME key → client `confirmation_tts_decision{decision:"deduped"}` (SILENT)
- **Candidate-2 signal ABSENT:** zero `voice_latency.confirmation_debounced` rows for the session in the window.
- The client made a dedupe *decision* (frame reached it) → the swallow is CLIENT-side, on the session-permanent field+text key `postcode_<hash>`. The 40s gap between the two `deduped` decisions (08:46:58 → 08:47:39) confirms field-bearing keys are SESSION-permanent, not 30s-expiring.
- **Matrix row:** id 102 = candidate 1 (client dedupe) ⇒ execute §3.5 token mechanism (UNCONDITIONAL — bundler producer + WIRE_CLIENT_DEDUPE_TOKEN_FIELDS + three manifests). Do **NOT** execute the candidate-2 backend debounce classification. Evidence pin: `confirmation_debounced` absent on the postcode amend turns.

**Net Phase-0 effect:** no recorded fixtures for 112/102; no backend debounce classification; the §3.2 steer, channel-1 machinery (synthetic test), and §3.5 token mechanism (unconditional) all proceed.

---

## Scope reality (stated upfront)

PLAN-2 converged over 13 refine rounds and, per its own conversation-context, is part of a wave the author estimated at "2–3 days per wave" of engineering. It bundles ~6 feature groups spanning **backend + web + iOS Swift**, several of them deeply interdependent through the stage6 audibility state machine — the plan's own §7 names the §3.1 drain arbitration as the "highest-interaction seam." A single autonomous `/ep` pass cannot complete + Codex-converge + ship all of it (plus PLAN-3/PLAN-4 in the chain) without either exhausting budget mid-change (a broken tree) or under-testing the highest-risk seam.

This run therefore completed the **self-contained, non-client-stranding backend/prompt units** correctly and with full tests, and hands off the interdependent remainder with precise pointers. This is the honest outcome for a plan whose scope exceeds one pass — better than forcing a half-implemented merge of the audibility state machine.

## Steps

### Step 1 — Phase 0 diagnostics — Status: applied
- Decision: rule 1 (executed verbatim). Both branches decided from CloudWatch (see Phase 0 above): id 112 = MODEL-SIDE, id 102 = CANDIDATE 1. No recorded fixtures for 112/102; no backend debounce classification.
- Files: none (diagnostic).

### Step 2 — §3.4 ref_method dead-end (id 103) — Status: applied (legs 1/2/3/4 complete)
- Decision: rule 1. coerceRefMethodValue + resolveEnumAnswer ref_method branch (context-gated) + batched prompt port + inherent severity-collision gate.
- Files: `src/extraction/record-reading-coercion.js`, `src/extraction/stage6-answer-resolver.js`, `config/prompts/sonnet_agentic_system.md`, `src/__tests__/stage6-ref-method-resolution.test.js`.
- Commit: `c89c03ef` (code+tests) + `5085614f` (prompt leg 3).
- Notes: 17 new tests; validator uppercase-fold [ASSUMED] satisfied by coercion producing canonical uppercase (see [ASSUMED] below).

### Step 3 — §3.2 range-expansion steer + §3.3/§3.4 prompt halves — Status: applied
- Decision: rule 1. ONE batched prompt edit; caps re-measured base 17753→18087 (measured 17987), combined 22991→23325 (measured 23225), P8 precedent; Group 21 pins both flag renders.
- Files: `config/prompts/sonnet_agentic_system.md`, `src/__tests__/stage6-agentic-prompt.test.js`.
- Commit: `5085614f`. 81 prompt tests green.

### Step 4 — §3.1 partial-rejection notice machinery — Status: DEFERRED (multi-day, highest-interaction seam)
- Decision: rule 3-adjacent (deliberate deferral). Requires: a new `partial_failure` notice class in `refusal-notices.js` (staged WITHOUT `coveredToolCallIds` — which auto-excludes it from plan-B's `coveredUnion`/`stampCoveredNoticesNonDraining`, verified at `stage6-shadow-harness.js:2434-2463`); a dedicated drain block placed AFTER the plan-B mandatory-notice drain (`stage6-shadow-harness.js:2957-3070`) and BEFORE marker-② (`:3173`) so residual notices push to `session.pendingVoicePrompts` and are counted by marker-②'s `survivingPromptCount` (`:3216`) — giving marker-② suppression for free; drain arbitration = drop-on-allRejected / subtract reading targets with surviving same-slot writes (`projectReadingWinners` + `EFFECTIVE_CIRCUIT_SLOT`, canonical field identity) / speak residual. `allRejected` is block-scoped at `:2398` and must be hoisted (near the marker-② helper hoist at `:866-880`) to be visible at the drain. Producers: channel 1 (circuit_not_found reject, `stage6-dispatchers-circuit.js:253-269`), channel 6 (three capability skips at `:226-251` / `:324-346` / bulk `:1842+`), channel 3 (`stagePartialFailureNotice` callback into `createAskDispatcher` — no `perTurnWrites` arg exists today), `!bucket` at `:1957` (after the excludes check at `:1963`). Full both-direction test matrix per plan §5.
- Notes: NON-client-stranding (rides the existing field-nil channel). This is the plan's headline "silent partial failure" fix and the dependency for §3.3-code and §3.6. Deferred because a half-built change to the audibility state machine risks double-speak/silence regressions the plan's §7 explicitly flags.

### Step 5 — §3.3 multi-description resolution CODE half (id 104) — Status: DEFERRED (depends on §3.1)
- Decision: rule 4 (depends on blocked predecessor §3.1). The prompt half shipped (Step 3). The resolver code (`resolveCircuitAnswer` segmentation + `{writes, unresolved[]}` verdict, `stage6-answer-resolver.js:422-538`) and its dispatcher wiring (notice staging + ask emission) require §3.1's `stagePartialFailureNotice`. The pure resolver is testable standalone but its `no_match`→notice / `disposition:'ask'` outputs are inert without §3.1's channel, so wiring it half-way would be dead code.

### Step 6 — §3.5 postcode token mechanism (id 102) — Status: DEFERRED (cross-repo: backend + web + iOS Swift)
- Decision: rule 3 (deferred). CANDIDATE 1 confirmed (client dedupe swallow), so: bundler `secfield_` token producer for enrolled fields (`stage6-event-bundler.js`), NEW `WIRE_CLIENT_DEDUPE_TOKEN_FIELDS` export = existing five + `postcode` in `ios-dedupe-key.js` + web `confirmation-dedupe-key.ts` + the iOS Swift mirror, `DEDUPE_TOKEN_FIELDS` stays the backend-debounce manifest (postcode NOT added — candidate 1), postcode-snapshot-applier designed-silent comment. Cross-repo client delivery (web deploy + TestFlight installed-build) is the ride-along dependency in PLAN-4. Deferred because it strands a client half if not completed end-to-end this pass.

### Step 7 — §3.6 KNOWN_FIELDS drift + manifests + structural/unroutable rejects — Status: DEFERRED (largest, cross-repo)
- Decision: rule 3 (deferred). Requires committed `CLIENT_ROUTABLE_READING_FIELDS` + `UNROUTABLE_READING_FIELDS` manifests, the 4-way disjoint partition + `CORRECTION_BYPASS_EXEMPTIONS` (three live overlaps to adjudicate: `cpc_csa_mm2`, `max_zs`, `ocpd_max_zs`), structural dispatch rejects (recoverable `mark_distribution_circuit` vs terminal), per-field client-route + board-attribution verification, web router deep-compare, iOS digest pin. Multi-day on its own.

## Deviations / assumptions

- [ASSUMED] §3.4 validator uppercase-fold: the plan's leg 1 says "uppercase-fold before the Set.has". I satisfied this via `coerceRefMethodValue` producing canonical uppercase letters (which runs before `validateRecordReading`, confirmed `stage6-dispatchers-circuit.js:193` precedes `:255`), rather than modifying the general `CIRCUIT_FIELD_VALUE_ENUMS.has` path (which is load-bearing for other case-sensitive enums). Single obvious interpretation.

## Follow-ups noticed

[FOLLOWUP] §3.1 partial-failure notice machinery (plan headline) — build in `refusal-notices.js` (new `partial_failure` class, no `coveredToolCallIds`) + `stage6-shadow-harness.js` (dedicated drain block after `:3070`, before marker-② `:3173`; hoist `allRejected` from `:2398`) + producers in `stage6-dispatchers-circuit.js` (`:253-269`, `:226-251`, `:324-346`, `:1957`) and a `stagePartialFailureNotice` callback into `createAskDispatcher`; makes acceptance criterion #1 audible (circuit_not_found + capability skips). Non-client-stranding.
[FOLLOWUP] §3.3 resolver code (id 104) — `resolveCircuitAnswer` segmentation pipeline + `{writes, unresolved[]}` verdict + dispatcher wiring; depends on §3.1's `stagePartialFailureNotice`. Prompt half already shipped.
[FOLLOWUP] §3.5 postcode token (id 102, Phase-0 CANDIDATE 1) — cross-repo `secfield_` producer + `WIRE_CLIENT_DEDUPE_TOKEN_FIELDS` (five + postcode) across backend/web/iOS mirrors; rides PLAN-4 wave-end client delivery. Client-stranding if partial.
[FOLLOWUP] §3.6 KNOWN_FIELDS drift + manifests — committed `CLIENT_ROUTABLE_READING_FIELDS`/`UNROUTABLE_READING_FIELDS`, 4-way partition, `CORRECTION_BYPASS_EXEMPTIONS` (adjudicate `cpc_csa_mm2`/`max_zs`/`ocpd_max_zs`), structural dispatch rejects, web router deep-compare + iOS digest. Largest section; cross-repo.
[FOLLOWUP] Live probes (recorded PENDING) — §3.4/§3.2 shipped halves need Derek's post-deploy ear-verify: ref_method answer "C" ⇒ written first try + read back; "method 100" ⇒ 100; "circuits 5 to 10" with 7/8 missing ⇒ writes read back (notice half pending §3.1).
