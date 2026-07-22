# /ep execution log — PLAN-final.md (ring-script-hardening-2026-07-22)

- Session: `20260722T131327Z-ep`
- Worktree: `/Users/derekbeckley/Developer/EICR_Automation-ep-20260722T131327Z-ep`
- Branch: `ep/PLAN-ring-script-hardening-20260722T131327Z-ep`
- Base: `main` @ `fc9059ea` (origin/main, fetched at claim time)
- Plan: converged clean at /rp round 17 (0 findings both reviewers); no "Skipped (ambiguous fix)" entries.
- Plan-size check: ONE feature group (ring-continuity dialogue script), 5 fixes + gates — under the split heuristic. No `[PLAN-SIZE]` warning needed.

## Step log

## Step 1 — Phase 0: anchors, wire surfaces, replay-capture existence
- Status: applied
- Decision: rule 1 (verbatim). Every plan anchor verified against the worktree:
  - `engine.js:307` RCD-only gate + `:350-356` two-pattern exclusion; `:1147-1194` 4-way confirm branch; `:1017` cancel; `:1057` detectDifferentEntry; `:1082` topic switch; `:903` last_turn_at reset; `:99-144` broadcast pre-filter; `:2067` transitionToConfirmation; NEGATIVE_RE `:362`.
  - `schemas/ring-continuity.js:88` trigger (bring|wing present, no re-?continuity), `:94` bare cancel, `:97-120` topic switch, `:135-139` detectPositive (matches anywhere).
  - `sonnet-stream.js`: `transcriptText = msg.text` then `in_response_to` annotation (~:3665-3713); script-outcome transcriptText adoption on fallthrough (~:3771-3773); ring/IR timeout server notes (~:3849/:3874); `srv-` answer routing → transcript path (~:1397-1454).
  - Wire surfaces for the delete contract: `dispatchClearReading` pushes `perTurnWrites.cleared` + `perTurnWrites.fieldCorrections` → `result.field_corrections` (read at sonnet-stream.js:4440); `result.cleared_readings` stripped at shadow-harness:1481; `field_cleared` dedupe-token kind `clear_<field>_<circuit>_<turnId>_ordN` (ios-dedupe-key.js); confirmations synthesised in `synthesiseObservationAndClearedConfirmations` (bundler).
  - `detectStructuredReading` at `stage6-pending-value.js:361` (`.complete` semantics confirmed); `hasNumericValueWithUnit` engine-local.
  - Distinctness families: `NOOP_AUDIBILITY_PROMPTS` / `CATCHALL_AUDIBILITY_PROMPTS` / `ASK_AUDIBILITY_FALLBACK_TEXT` (shadow-harness:341-374+), F/U-2/3 real-dispatcher notice sweep, `CLIENT_CHIME_WATCHDOG_FALLBACK_TEXT` — all pinned in `client-watchdog-fallback.test.js`.
- **Replay capture of B4C45F25: DOES NOT EXIST** — `tests/fixtures/field-replay-corpus/` holds 5 `frc_*` fixtures, none from B4C45F25; zero repo references to the session id. Per plan: NO new fixture authored; `npm run replay:field-corpus` runs as existing-corpus non-regression gate only; vault follow-up todo to extend the corpus boundary to dialogue ingress.
- Existing-test compatibility check: no test pins the old keep-state confirmation-idle behaviour (`confirmation_idle` appears in no test); amend/positive/topic-switch pins remain valid under the new canonical order.
- Files: none (read-only)
- Commit: none

## Steps 2–6 — Fixes 1–5 implemented
- Status: applied
- Decision: rule 1 (all specs executed as written; one rule-2 note below).
- Commits:
  - `64e02db5` fix(dialogue): engine + schemas + sonnet-stream — entry guard (Fix 1), canonical confirmation order 0–5h (Fix 2+3), raw-reply contract (Fix 4), purge contract.
  - `79648ef2` fix(dialogue): legacy twin mirror (Fix 5) incl. Pattern-1 `bring|wing` + `re-?continuity` widening (deliberate, noted in commit body per plan).
- `[ASSUMED]` (rule 2, minor): the plan's "non-ring adjacency" rejection ("size|csa|mm|conductor|cable adjacent to the anchor") implemented as a ±20-char proximity window between ring anchors and the non-ring nouns (both directions) — the plan named the signal but not the window; a whole-reply check would over-reject valid amendments ("…earths are 1.19, cable is fine").
- `[ASSUMED]` (rule 2, minor): "immediately preceded (within the same clause) by not|no|never" for negation polarity implemented as whitespace-only adjacency (a comma breaks the clause) so a leading "No, circuit 17 …" does NOT negate 17 — required for the correction flow to still route.
- The server note is composed in the engine with the plan's exact FIXED text (ring-specific wording; only fires for schemas supplying confirmationClearIntentPattern, i.e. ring).

## Step 7 — Tests: pinned suite + replay parity + distinctness
- Status: applied
- Commits: `d359d197` (75-test ring-confirmation suite + 6 replay byte-parity scenarios + distinctness extension), `a4a2640e` (legacy off-topic-chatter pin updated to the 5h clear contract — the old pin asserted exactly the R3 immortal-state bug this plan fixes).
- Note: two pinned exemplars use "Zs on circuit 17 is 0.62" instead of the plan's comma phrasing — the comma form "circuit 17, 0.62" is claimed by the PRE-EXISTING broadcast pre-filter comma-list regex (`circuit 17, 0`) before the confirmation branch; net effect identical (cleared, purged, reaches the model, never seeds) and a dedicated test documents that path. Not a deviation from plan substance — the plan's requirement (never seed, never amend, never count, reach the model) holds on both phrasings.

## Step 8 — Two-layer delete integration contract (decision-gate criterion 2)
- Status: applied
- Commit: `3dc96f89` — (a) real sonnet-stream ingress spy: exact server note + annotation replacement + untouched raw suffix; entry-path no-note; (b) real runShadowHarness + canned 3× clear_reading: 3 field_corrections (ring_continuity_* wire names), 3 token-distinct field_cleared confirmations, 3 ok stage6_tool_call rows, snapshot fields absent, no apology.
- Phase-0 wire-name verification (plan requirement): result surface confirmed as `field_corrections` (cleared_readings stripped at harness:1481) + `field: 'field_cleared'` confirmations with `clear_*` dedupe tokens.

## Step 9 — Live-model probes (decision-gate criterion 3): BOTH PASS
- Status: applied
- Probe A (delete-at-entry, no note): real EICRExtractionSession + real agentic prompt via runShadowHarness live mode → model issued EXACTLY 3 clear_reading calls; snapshot ring fields gone; 3 spoken "cleared" confirmations; no questions. PASS.
- Probe B (delete-at-confirm, server note + "No. Please delete them all."): same contract → 3 clears, fields gone, spoken confirmations. PASS.
- No STOP condition triggered; the fallthrough+server-note design is confirmed live.

## Step 10 — Docs + vault follow-ups
- Status: applied
- Commit: `b4499d4e` — architecture.md entry-guard rewritten (per-schema opt-in) + confirmation-machine + purge-contract summary; changelog.md full row; hub CLAUDE.md one-line row.
- Vault todos added to `obsidian-vault/active/todos-certmate.md`: (1) corpus-boundary extension to dialogue ingress (B4C45F25 class not fixture-lockable; no replayable capture exists); (2) iOS queued-alert tool-call IDs + prefix purge riding the P2/P7 TestFlight wave (accepted purge residual).

## Step 11 — Gates
- Status: applied (one environment-blocked sub-gate, evidence below)
- Full backend Jest: **5630 passed / 19 skipped / 0 failed** (exit 0). Includes: RCD entry-guard suite UNCHANGED green; marker-①/② net suites UNCHANGED green (nets not modified); replay byte-parity suite green incl. the 6 new P1 scenarios; the new 75-test ring-confirmation suite; both delete-contract integration suites.
- Field-replay corpus (recorded lane, non-regression): **5/5 fixtures green** (exit 0). No new fixture authored per Phase-0 (no B4C45F25 capture exists; corpus boundary cannot reach dialogue ingress).
- `npm run voice-regression`: **ENVIRONMENT-BLOCKED, PRE-EXISTING** — the harness hangs on this dev box with ZERO network activity: full baseline run in the worktree (60+ min elapsed, 5.7s CPU, 0 TCP conns), AND an identical hang reproduced with a SINGLE scenario on PRISTINE main (7+ min, 0.01s CPU, 0 TCP). A gate that hangs identically on the unmodified base cannot gate this diff. Killed both processes. Surfaced for the morning: investigate the legacy voice-latency harness on this box (possibly needs a local backend or interactive env the direct runner no longer sets up).
- Pre-existing note: the sonnet-stream-extraction-watchdog suite hangs when run STANDALONE on pristine main too (fine inside the full `npm test` run, which is the canonical gate) — not introduced by this branch; my new ingress suite exits cleanly standalone (disconnectTimer + ping-interval teardown included).
- Jest "worker failed to exit gracefully" warning appears in the full run (exit 0) — attributable to the pre-existing watchdog-suite handle leak above, not the new suites.

## Codex diff review (default ON; gpt-5.6-sol, high effort, read-only)

**Verdict: PASSED at cycle 5 (clean — zero findings).** Finding counts: cycle 1 (three parallel lenses, merged) = 4 BLOCKER + 2 IMPORTANT; mini-review 1 = 3 BLOCKER; cycle 2 = 0 BLOCKER + 2 IMPORTANT; mini-review 2 = 4 BLOCKER; cycle 3 = 1 IMPORTANT; cycle 4 = 1 IMPORTANT; cycle 5 = 0. Converging throughout; cap 10 never approached.

### [DEVIATION] entries (both ship; Codex-sanctioned WITHIN_INTENT)
1. **Cross-wrapper entry-guard veto** (`session.dialogueEntryGuardVeto`, raw-reply-keyed, 5s window; armed on entry-guard skips, the position-1 delete exit, the guarded destructive fallthroughs, and destructive topic-switch exits from a confirmation). Plan said: ring-only entry guard, sonnet-stream raw-reply plumbing only. Codex cycle-1 lens C showed a multi-scope destructive request ("delete the ring continuity and insulation resistance readings for circuit 13") was guard-skipped by ring only to be hijacked by the IR wrapper's unguarded trigger — the delete never reached the model. intent_evidence: **"BOTH the delete failure and the repeated-question loop are in scope, not just one."** (conversation-context §2). Engine-only, zero wire change; pinned by three tests.
2. **Polarity-aware 5f correction-cue veto** (`isVetoedPositive`: bounded cue list wrong/incorrect/except/mistake/apart-from/needs-changing + predicate-bound cannot + emptiness-quantifier exemption). Plan pinned only the negated-positive guard; Codex cycle-2 showed "Okay, R1 is wrong" / "All good except R2" false-finish (positive token in an earlier clause). Sanctioned WITHIN_INTENT by cycle-2's verdict (the correction loop is the feedback-91 scope). Six correction pins + three genuine-confirm pins.

### Applied in-scope fixes (commits)
- `39bcfafe` r1: negated-positive clause-bounded widening; ringSafe.rejected hoisted before 5a (trigger-bearing non-ring corruption class); confirmation-only false comma-LIST pre-filter exemption ("Zs on circuit 17, 0.62" now genuinely reaches 5h per the plan's pinned exemplar); hard-timeout purge scoped to confirmation-bearing schemas; twin entry guard + delete-at-entry replay scenario; vacuous recontinuous pin fixed; bare-"No." ingress net-unreachability test; docs corrected (5630 count, zero-NEW-wire-SHAPE wording, AGENTS.md row).
- `c87e8753` mini-r1: smart-apostrophe + ASR-stripped auxiliary negations (enumerated, no bare `nt\b`); veto re-keyed to the RAW reply (stable across wrappers after the note replaces transcriptText) + armed on the active-confirmation destructive exits incl. destructive topic-switch.
- `fbf24e33` r2: 5f correction-cue veto (deviation 2) + twin position-0 broadcast pre-filter mirror + replay pin (non-destructive broadcast never becomes a single-circuit amend on either path).
- `31993b86` mini-r2: polarity-aware cue machinery (cannot predicate-bound; nothing/none/anything exemption); twin pre-filter moved BEFORE its hard-timeout sweep (engine control order).
- `25668d32` r3: non-ring adjacency window 20→30 (extractor span).
- `cc07bf5d` r4: adjacency filler crosses digit-bounded decimals ("CPC is 2.5 mm2").

### Adjudicated as pre-existing / out of diff (with evidence; Codex accepted from cycle 2 onward)
- Board-scope asymmetry of dialogue-engine writes (`applyWrite` flat vs board-aware reads): pre-exists P1 for EVERY ring write incl. the old circuit-switch recursion the 5a seed replaces. **Vault follow-up added.**
- pd-family within-call ordering (OCPD trigger before RCD's guard): pre-existing; the plan preserves RCD's `continue` semantics verbatim.
- Free-text correction phrasings outside the bounded cue list: pre-P1-baseline retained deliberately (broad verbs would false-veto genuine confirms).
- Legacy twin emits no cancel_pending_tts frames: pre-existing engine-only convention; raw frame ordering pinned in dedicated tests.

### Re-gate results per cycle
Every fix cycle re-ran the FULL backend suite green: 5645 → 5646 → 5652 → 5653 → 5655 passed, 0 failed. Corpus 5/5 re-verified after cycle 1.

## Completed 2026-07-22T17:20:00Z (pre-merge; deploy annotations appended below after CI)

**Outcome: ALL PASSED (plan-deviation: 2 applied within original intent)**

### Plan deviations (READ FIRST — the plan was amended overnight)
1. **Cross-wrapper entry-guard veto** — the written plan guarded only ring entry; a multi-scope destructive request would still have been hijacked by the next wrapper's unguarded schema. Codex verdict WITHIN_INTENT, evidence: *"BOTH the delete failure and the repeated-question loop are in scope, not just one."*
2. **5f correction-cue veto** — the written plan's negated-positive guard missed positive-then-correction replies ("Okay, R1 is wrong"); Codex sanctioned the bounded polarity-aware cue veto as WITHIN_INTENT (the feedback-91 correction loop).

### Commits (worktree branch `ep/PLAN-ring-script-hardening-20260722T131327Z-ep`)
- 64e02db5 fix(dialogue): ring-script hardening — entry guard, canonical confirmation order, raw-reply contract
- 79648ef2 fix(dialogue): legacy twin mirror + trigger widening
- d359d197 test(dialogue): 75-case pinned suite + replay parity + distinctness
- 3dc96f89 test(dialogue): two-layer delete integration contract
- a4a2640e test(dialogue): legacy off-topic-chatter pin → position-5h contract
- b4499d4e docs: architecture entry-guard rewrite + changelog rows
- 39bcfafe, c87e8753, fbf24e33, 31993b86, 25668d32, cc07bf5d — Codex review fixes (see the review section)

### Files touched
src/extraction/dialogue-engine/engine.js; schemas/ring-continuity.js; schemas/rcd.js; src/extraction/sonnet-stream.js; src/extraction/ring-continuity-script.js; 5 test files (2 new); docs/reference/architecture.md; docs/reference/changelog.md; CLAUDE.md; AGENTS.md.

### Assumed decisions ([ASSUMED])
- Non-ring adjacency implemented as a proximity window (now 30 chars, decimal-permeable) rather than an unspecified "adjacent" — refined twice under Codex review.
- Negation polarity "immediately preceded" = whitespace-only adjacency (a comma breaks the clause) so "No, circuit 17 …" still routes.
- Two 5h pinned exemplars documented against the broadcast pre-filter reality; the confirmation-only false-comma-list exemption restores the plan's exact exemplar routing.

### Skipped / blocked / failed steps
- None. (One plan GATE — `npm run voice-regression` — is ENVIRONMENT-BLOCKED: the harness hangs identically on unmodified main with zero network I/O; evidence in Step 11. Surfaced for investigation; not a step of the plan's fix spec and not a regression signal for this diff.)

### Stashes left behind
- None.

### Tests run + result
- Full backend Jest: **5655 passed / 19 skipped / 0 failed** (final re-gate; suite grew 5629→5655 over the run).
- Field-replay corpus (recorded): **5/5** (non-regression gate; no B4C45F25 capture exists — Phase-0 finding).
- Live-model probes (decision-gate criterion 3): **A (delete-at-entry) PASS; B (delete-at-confirm) PASS** — 3× clear_reading, snapshot cleared, spoken confirmations, no dead-end.
- RCD entry-guard suite: green UNCHANGED. marker-①/② net suites: green UNCHANGED.
- Replay byte-parity: green incl. 9 new P1 scenarios.

### Follow-ups recorded (vault todos-certmate.md)
- Corpus-boundary extension to dialogue-engine ingress (incident class not fixture-lockable; no capture exists).
- iOS queued-alert tool-call IDs + prefix purge (P2/P7 TestFlight wave; accepted purge residual).
- ALSO surfaced in the morning summary: voice-regression harness hang on the dev box (pre-existing); board-scope asymmetry of dialogue-engine writes (pre-existing).
