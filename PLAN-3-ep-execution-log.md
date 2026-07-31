# PLAN-3 execution log

## Session

- Session: `20260731T094738Z-ep`
- Source plan: `PLAN-3-final.md`
- Backend delivery base: current `origin/main` at `36ab17f8cd0a583e4f8d557654426ea5ac685aa4` after integrating merged PRs #139 and #140.
- Backend worktree: `/Users/derekbeckley/Developer/EICR_Automation-ep-20260731T094738Z-ep`
- Backend branch: `codex/plan3-observation-regulation-integrity-20260731`
- Delivery: one backend PR to `main`; web and iOS source held for PLAN-4 with no independent deployment.
- Review gate: immutable backend/web/iOS patch identities and a clean fresh-context Codex r7 review. All earlier Codex and Claude BLOCKER/IMPORTANT findings were fixed. Claude Opus r7 was quota-blocked and Derek explicitly waived only that final pass on 2026-07-31; no Claude r7 verdict is claimed.

## Execution

1. **Source and dependency audit** — complete
   - Confirmed current `origin/main` is post-PR #138 and based the isolated worktree on that exact commit.
   - Read `PLAN-3-final.md`, its conversation context, and the complete seven-round refine log.
   - Reconfirmed the bounded scope: AFDD/SPD contradiction pair only, exact `421.1.7`, no broad regulation-table audit, and no `bpg4_basis` or refinement-cost work.
   - Verified PLAN-4 is the wave-end client delivery vehicle and based each PLAN-3 client branch on its required held predecessor.

2. **Backend implementation** — complete
   - Added the bounded AFDD/SPD topic cross-check: AFDD text rejects `443.x`/`534.x`, SPD text rejects exact `421.1.7`, dual-topic observations reject before append, and non-AFDD `421.1.201` remains a passthrough.
   - Added optional internal-only `code_basis` handling and a non-enumerable AFDD premises marker. Only the explicit `afdd_premises_requirement` signal pins the premises-required C3 / `421.1.7`; installed-but-defective AFDD observations remain refinement-eligible.
   - Made refinement preserve a table-consistent original regulation and canonical wording whenever a proposed refinement is absent, weak, or topic-inconsistent.
   - Added the durable ordered two-frame observation-recode emitter and threaded stable `turn_id` values through legacy sync/batch, reconnect, and Rule-6 paths without exposing internal `previous_code` state.
   - Added the AFDD decision table to the Stage-6 prompt: establish the single-phase socket-final-circuit ≤32 A predicate first, then apply the four premises categories; non-applicable/outside-category cases do not write, and unknown facts are asked sequentially one at a time. HRRB is keyed to its classification under applicable legislation rather than a hard-coded height/storey shortcut.
   - Added EICR schedule item 5.22 to the backend prompt and both Python schedule maps/generators, and corrected the regulation table's `421.1.7` amendment metadata.
   - Updated architecture, changelog, and hub documentation.

3. **Web ride-along implementation** — complete
   - Branch: `codex/plan3-observation-regulation-web-ridealong-20260731`, based on held PLAN-2CD web commit `abd96810438e90b27141ee924e90abad0c004bad`.
   - Preserved `turn_id` during Sonnet-frame normalisation and added a session-scoped turn ledger so only the first extraction frame for a turn decrements `processingCount`; delayed recode frames cannot close a later outstanding turn.
   - Added EICR schedule item 5.22 to the web schedule model and PDF renderer, plus parity-ledger coverage and runtime/rendering tests.

4. **iOS ride-along implementation** — complete
   - Branch: `codex/plan3-observation-regulation-ios-ridealong-20260731`, based on held PLAN-2D iOS commit `795b76227b53a909fef8909cadb6089ed023822c`.
   - Added EICR schedule item 5.22 to Constants and the HTML template, with exact-order and rendered-output tests.
   - Pinned the existing iOS per-frame processing behavior and added the required reconnect exception: only a field-null `obsrecode_` operation bypasses stale-replay suppression, then uses permanent operation dedupe so the owed suffix speaks exactly once; ordinary replay-burst confirmations remain suppressed.

5. **Verification gates** — complete
   - Backend initial focused PLAN-3 suites: 261 passed, one cross-repo environment skip. Review-fix focused suites: 179 passed, one environment skip.
   - Backend final full Jest after rebasing onto merged PRs #139/#140 and closing the neutral-text correlation bypass: 298 suites passed / one skipped; 7,448 tests passed / 19 skipped; zero failures. The assertions completed green; known keepalive timers held Jest open afterward, so the idle process was stopped manually.
   - Web final full Vitest: 148 files passed / one skipped; 1,609 tests passed / one skipped; zero failures.
   - iOS final full suite: 1,591 tests passed; zero failures.
   - Field-replay strict pre-push gate: 9/9 scenarios passed.
   - `git diff --check`: clean in backend, web, and iOS worktrees.
   - Web typecheck/lint were also inspected and retain only predecessor-branch failures (PLAN-2 route/job-row typing and longstanding hook lint); no PLAN-3 failure was introduced, and the required full Vitest gate is green.

6. **Immutable dual review** — Codex complete; Claude Opus quota-blocked
   - Bundle r1 SHA-256: `0f4945fd04de40a1450d94f154a52181f6b50acf518689a43b9da5a1df108fcd` over backend `af15b320`, web `01712251`, and iOS `1718765` patches.
   - Fresh-context Codex found three material issues. Applied all verified fixes: (a) the prompt had omitted `421.1.7`'s ≤32 A socket-final-circuit applicability predicate and hard-coded an unsafe HRRB dimension shortcut; (b) iOS's reconnect grace suppressed the server's owed second recode frame; (c) a legacy timeout result received a new id rather than reusing its immediate placeholder's id.
   - Claude Opus cycle-1 wire/audibility/edge lanes independently found the held 5.22 iOS source would trip the existing dual-repo local schedule-sync test even though backend-only CI skips it. Added an exact, dated `5.22` allowance plus a PLAN-4 removal todo; another missing ref still fails.
   - Claude's only other findings were NITs. Applied the useful dead-helper comment; recorded the deliberate held schedule window. The optional first-time absent-code speech NIT is unreachable for validated coded observations, and the shared dual-topic refusal wording remains truthful enough for this bounded family.
   - The Claude CLI emitted prose-wrapped/wrong-enum JSON on two cycle-1 lanes despite format retries; their substantive findings were retained, and the post-fix comprehensive cycle will be required to produce the definitive schema-valid verdict.
   - Focused Claude cycle 2 found one IMPORTANT ask-budget interaction: topic repair followed by unknown AFDD applicability and premises could exhaust one two-ask chain. Fixed by making topic repair its own chain, then sharing a fresh bounded chain between applicability and premises; the real ask-gate test proves both deciding facts reach the wire and a generic severity ask cannot become a third question.
   - Bundle r3 SHA-256: `955c989cb789092e3847e4db9608680b4fd12b5a3edd5d1edfeb145a75e32e7a` over backend `ea82311a`, web `203ec333`, and iOS `90d6a5c5` patches.
   - Claude Opus comprehensively re-verified r3 and returned zero BLOCKER/IMPORTANT/NIT findings. Its first clean verdict was prose-wrapped; the strict formatting retry produced schema-valid JSON at `PLAN-3-claude-r3-full.json` without changing the substantive verdict.
   - Fresh-context Codex's r3 review then found a D2 lifecycle BLOCKER: splitting the topic and applicability/premises asks left intentional AFDD no-write outcomes unable to qualify the answered chain, so the post-answer net could emit a false dropped-observation apology; model-authored chain ids also left a severity-ask bypass.
   - Fixed the r3 blocker with a closed AFDD question-kind enum, exact server-rendered questions, one active server-owned progression, and a silent exact-chain terminal for the two deliberate no-write outcomes. Same-chain writes and valid no-write terminals now qualify D2; omitted/invented ids and generic severity asks fail closed. Real harness tests cover qualifying writes, both no-write rows, and absence of false apology.
   - Bundle r4 SHA-256: `61ad12f643a24e76b2fd6e2663a956272c0992096fb277a1a6ca3ee7c09f93c7` over backend `2f9c5b78`, unchanged web `203ec333`, and unchanged iOS `90d6a5c5` patches.
   - Fresh-context Codex's r4 review found a BLOCKER and IMPORTANT: AFDD records were appended before exact-chain validation, allowing omitted/invented or unrelated records to qualify the D2 net; and exact canonical question text could reverse-infer a privileged AFDD kind without the declared enum.
   - Fixed both r4 findings before rebuilding the bundle. Active AFDD flows now validate topic and exact chain correlation before append; declared AFDD chains qualify D2 only through an exact matched mutation, while legacy non-AFDD null/unknown leniency remains. Reserved canonical wording with an omitted/null kind fails validation, and only a declared enum can start or advance the server-owned flow.
   - Bundle r5 SHA-256: `fd40b5b66c4db81d3654928fb2e0bb4ac4382c89a2934325560bdfc1499f1aed` over backend `2d5428f3`, unchanged web `203ec333`, and unchanged iOS `90d6a5c5` patches. Fresh-context Codex is reviewing this exact immutable bundle.
   - Fresh-context Codex's r5 review found one BLOCKER: the active-flow classifier relied only on AFDD/SPD prose, so neutral text carrying exact `421.1.7`, a `443.x`/`534.x` ref, or the explicit AFDD basis could bypass or falsely fail exact correlation.
   - Rebasing onto current `main` integrated merged PR #139's overlapping Luna Fast Stage-6/session/docs work. The r5 blocker was then fixed with a still-bounded classifier using topic prose, the three PLAN-3 regulation families, or the explicit internal basis. Production-dispatch tests cover absent/null/invented/different-known ids, exact-chain success, and the unrelated id-less `416.2.1` lane.
   - Bundle r6 SHA-256: `b9a68a25efccd6cf377baecde95ed83f04789403d4156c669cc1ad578613c45f` over backend `3443be73`, unchanged web `203ec333`, and unchanged iOS `90d6a5c5` patches. Fresh-context Codex returned zero findings after independently verifying production paths plus 290 backend and 102 web tests.
   - Merged PR #140 then advanced `main` with a pending-value apology repair in the shared harness. All eight PLAN-3 commits rebased without conflicts; the 18-suite integration gate passed 543 tests, the full backend suite passed 7,448, and corpus remained 9/9.
   - Bundle r7 SHA-256: `01dc9c4dc58c155aad29dd50c12a17736d3c2c9b43291f1e99b7421b3784cc80` over backend `24809406`, unchanged web `203ec333`, and unchanged iOS `90d6a5c5` patches. Fresh-context Codex returned zero findings after verifying hashes, bases/heads, r6→r7 continuity, PR #140 coexistence, lifecycle/replay semantics, schedule parity, and focused backend/web tests.
   - Claude Opus r7 remained blocked by the Max-plan weekly limit (`resets Aug 3 at 1pm Europe/London`). After reviewing the clean independent Codex r7 result, Derek explicitly waived only this final Claude pass on 2026-07-31 and authorized commit, PR, merge, and backend deployment. No Claude r7 verdict is claimed.

7. **PR, merge, and backend rollout** — in progress under Derek's explicit final-Claude-review waiver

## Follow-ups / live lane

- No recorded field-replay fixture is expected for the model-decision AFDD table by design.
- Post-deploy ear checks remain: typical domestic no-write informational note; SPD still routes to `443.x`; qualifying premises produces C3 / `421.1.7`; unknown premises asks once.
- PLAN-4 must include the held web/iOS source in its single wave-end web deployment and TestFlight build.
- PLAN-4 held-branch pickup set after this plan: backend-repo web `codex/plan2cd-client-contract-web-ridealong-20260731`; iOS `codex/plan2c-postcode-dedupe-20260731`; iOS `codex/plan2d-known-fields-20260731`; PLAN-3 web `codex/plan3-observation-regulation-web-ridealong-20260731`; PLAN-3 iOS `codex/plan3-observation-regulation-ios-ridealong-20260731`.
