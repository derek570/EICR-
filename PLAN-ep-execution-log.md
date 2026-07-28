# /ep execution log — Plan F (leading-circuit-scope + cross-utterance delete)

- **Plan:** `~/.claude/handoffs/EICR_Automation--leading-circuit-scope-2026-07-25/PLAN-final.md`
- **Session:** `20260728T003617Z-ep` · chain hop 2 · branch `ep/leading-circuit-scope-2026-07-25-20260728T003617Z-ep`
- **Base:** `origin/main` @ `1a30d937` (includes PR #123 from chain hop 1 — basing on the fetched remote rather than the stale local `main` was load-bearing)
- **Repo:** `/Users/derekbeckley/Developer/EICR_Automation` (backend-only wave; zero wire change)

## Steps

### Step 1 — Verify source anchors by symbol (post-#123 main)
- Status: applied
- Decision: rule 1 — all plan anchors located by symbol; line refs had drifted ~160 lines post-#123 but every symbol resolved (wrappers `:4160/:4213/:4243`, classifyOvertake `:4441`, requeue spread `:4679`, runShadowHarness `:4711`).
- Notes: confirmed "delete"/"remove" are pre-LLM-gate strong words (bare "delete" forwards); wrappers spread `ctx` so the suppress flag threads with zero wrapper edits; the queue drain re-enters `handleTranscript` FIFO from the `finally`.

### Step 2 — id 98: leading-circuit patterns + collect-all readers (commit `37e21492`)
- Status: applied
- Files: both live schemas, engine.js, both legacy twins, 3 test files
- Notes: per-file trigger vocabularies preserved (schema `insurance` vs twin `international`; twin ring-only terse). 20 pre-existing twin test expectations updated for the `{scope_conflict}` shape; one positional `triggers[0]` pin re-targeted by shape.

### Step 3 — Conflict resolver + conflict branches + span masking (same commit)
- Status: applied
- Notes: initial-entry, active-episode, and awaiting_confirmation conflict branches; purge-before-ask in confirmation mode; NEW `maskCircuitSpans` in the IR twin.
- [ASSUMED] the plan's IR-twin masking anchor ":936/:1152" was read as "the different-entry conflict path" — the `:1152` reading-phase site was later masked anyway by the cycle-1 review fixes, so the ambiguity is moot.
- [ASSUMED] IR contaminated exemplar: the IR gap regex breaks on "for", so "…live to live for circuit 3 is 200" extracts nothing raw OR masked — the §6 test-3 IR analogue pins digit-protection with that exemplar and queue+drain with a cleanly-phrased sibling ("… for circuit 3. Live to live is 200.").

### Step 4 — id 93: destructive-intent memory (commit `12716ba1`-family, "fix(voice): cross-utterance…")
- Status: applied
- Notes: `DESTRUCTIVE_INTENT_RE` + `CROSS_UTTERANCE_DESTRUCTIVE_WINDOW_MS` in the new helpers module (the plan's files table put the window constant in engine.js; it lives beside the RE in the helper as the single source — engine imports nothing, it only honours the flag). Arm at model-commit seam; consume at every terminal disposition; ordered arrival delta. IR schema gains the ring-shape `entryExclusionPattern`.

### Step 5 — §6 test matrix (commit "test(dialogue): §6 matrix…")
- Status: applied
- Notes: 39-test engine/twin matrix + 5 replay-parity scenarios + 12-test real-ingress suite (grew to 52 + 15 + 27-scenario replay through the review cycles). The plan's "ask answered with a bare 'delete' via classifyOvertake" case is structurally unreachable through the transcript channel (no classifier branch returns 'answers' for a bare destructive with no regex hit) — pinned instead via the content-anchor path AND a live-registered-ask pre-queue consume test; the no-arm property holds by construction (arm site sits after every ask-resolution return).

### Step 6 — Docs (commit `95f72951`)
- Status: applied
- Files: hub CLAUDE.md + AGENTS.md changelog rows, docs/reference/changelog.md full entry, docs/reference/ios-pipeline.md dated section, web/docs/parity-ledger.md dated note row `recording/leading-circuit-scope-cross-utterance-delete` (owner Derek).

### Step 7 — Gate + Codex diff review + ship
- Status: applied
- Full backend suite green at every stage; field-replay corpus 9/9 throughout (general gate only — `dialogue_answer_ingress` is the documented corpus capability exclusion).

## Codex diff review

Cycle 1 (parallel 3-lens: wire-contract / silent-path / edge-interactions): **11 merged findings** (5+5+6 raw, 3 triple-reported). ALL applied in-scope (commit `6b290460`), notably: matchAll collect-across-occurrences; CONFLICT_OVERWRITE drain semantics; unresolved-episode pending_writes carry-forward; conflict-origin follow-up re-ask; awaiting_disambiguation conflict preflight; RAW-reply entry detection/extraction (the in_response_to annotation defeated the leading anchor and exposed quoted-question words to extraction); masking on the ORDINARY extraction paths; `(?![ \t]+is\b)` topic-switch claim preservation; requeue-surviving verdict Symbol; performance.now stamps; Symbol un-exported.

Per-fix mini-review: **7 findings — 6 applied, 1 declined** (commit `6e582460`). Applied: disambiguation preflight widened; conflict follow-up UPSERT+mark; resume-drain marker honoured; terse-anchor widening (later REVERSED — see cycle 2); voltage escape-hatch raw-reply; unconditional RegExp clone. Declined with reasoning: removing the `is`-lookahead (it preserves shipped main behaviour in both contexts; removal would re-open cycle-1's C5).

Cycle 2: **4 findings — 3 applied, 1 declined** (commit `f2f342fa`). Applied: terse patterns RESTORED to origin ^ anchors with clause-segment ref-only scanning (the mini-review's own widening had let "Zs is 0.62. Ring on circuit 13." swallow the Zs reading — review churn caught by the next cycle, as designed); disambiguation supersede widened to same-circuit/unscoped fresh entries + router parses raw reply; combined circuit-answer+correction upsert-before-drain. Declined with reasoning: consuming a newly-armed token on a requeued transcript's RETRY pass — the retry is the SAME transcript re-playing, not "the next utterance"; a second consume violates exactly-once-per-transcript and discards the suppression owed to the newer delete→trigger pair; the feared "unrelated utterance suppressed" cannot occur (suppression only skips guarded-schema entry).

Cycle 3: **1 finding — applied** (commit for "different-entry readers gate on matched"): refs-only later-sentence terse collections no longer register as a circuit switch during an active episode.

Cycle 4: **0 findings — PASSED.** Convergence: 11 → 7 → 4 → 1 → 0.

**Plan-deviation note (1, applied within original intent):** the requeue-surviving `DESTRUCTIVE_SUPPRESS_VERDICT` Symbol. The written plan specified persistence only for the arrival STAMP; the wire-contract lens marked the verdict persistence `OUT_OF_SCOPE` with `intent_verdict: WITHIN_INTENT`, quoting the conversation context: *"Cross-utterance memory (the id-93 fix) must be CONSUMED/EXPIRED — a stale destructive utterance must not poison an unrelated later entry"* plus the id-93 fold-in directive. The other two lenses recommended the identical fix as in-scope. Without it, id 93 recurs whenever the suppressed trigger is requeued by the post-wrapper user_moved_on path.

## Completed 2026-07-28T02:0xZ

- **Outcome: ALL PASSED (plan-deviation: 1 applied within original intent)**
- **Commits:** `37e21492` (id 98), cross-utterance id-93 commit, §6 matrix tests, `95f72951` (docs), `6b290460` (cycle 1), `6e582460` (mini-review), `f2f342fa` (cycle 2), cycle-3 fix, exec-log mirror.
- **Files touched:** `src/extraction/dialogue-engine/schemas/{ring-continuity,insulation-resistance}.js`, `src/extraction/dialogue-engine/engine.js`, `src/extraction/dialogue-engine/helpers/destructive-intent.js` (new), `src/extraction/sonnet-stream.js`, `src/extraction/{ring-continuity,insulation-resistance}-script.js`, tests (`dialogue-engine-leading-circuit-scope`, `sonnet-stream-cross-utterance-delete-ingress` new; replay/twin/engine suites extended), docs (hub CLAUDE.md, AGENTS.md, changelog.md, ios-pipeline.md, parity-ledger.md).
- **Assumed decisions:** see Steps 3–5 `[ASSUMED]` entries (window-constant placement; IR masking anchor; IR exemplar restructure; unreachable classifier case pinned via its real production paths).
- **Skipped / blocked / failed steps:** none.
- **Stashes left behind:** none.
- **Tests:** final state 6385 backend passed / 0 failed (19 skipped pre-existing); field-replay corpus 9/9; replay parity green; new-file lint clean (repo-level `packages/` lint glob failure pre-exists on main).
- **Deploy:** ready PR → merge to main → CI (ECS backend). No iOS half (backend-only; both clients benefit identically over the existing wire).

## Follow-ups noticed

[FOLLOWUP] IR named-extractor gap breaks on "for" — `insulation-resistance-script.js` `extractNamedFieldValues` + the live schema's connector allowlist reject "live to live for circuit 3 is 200" (captures NOTHING, raw or masked; engine re-asks); observed while building §6 test 3; a legitimate phrasing class silently costs a re-ask turn; smallest next action: evaluate adding a bounded "for <ref>" skip to the connector bridge with the same adversarial review the 2026-06-02 allowlist got.
[FOLLOWUP] Conflict-origin which_circuit RE-ASK reuses byte-identical question text — `engine.js`/twins conflict follow-up branch; within the client 30 s text-keyed TTS dedupe the re-ask may be swallowed (accepted D-2 residual this wave); smallest next action: add a full-string-distinct alternate wording (the P1 `emitPendingSlotAlternate` pattern) for the conflict re-ask.
[FOLLOWUP] Token-consume semantics on requeued-transcript retry passes were DECLINED-by-reasoning against a Codex cycle-2 recommendation — `sonnet-stream.js` DESTRUCTIVE_SUPPRESS_VERDICT block documents why; if a field session ever shows a stale suppression after a user_moved_on requeue interleaved with a fresh delete, revisit with that comment as the starting point.
[FOLLOWUP] No end-to-end conflict→pause→resume integration test — `tryResumePausedScript`'s drain honours CONFLICT_OVERWRITE (one-line condition, mirrored from the tested position-4 drain) but the full IR conflict → two unresolvable answers → pause → create_circuit resume path is untested; smallest next action: add one integration test driving `tryResumePausedScript` with a conflict-origin paused episode and a pre-filled destination.
