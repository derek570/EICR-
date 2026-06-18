# /ep execution log — read-back + correction (Option B, never-clear)

**Session:** 20260618T130343Z-ep
**Plan:** ~/.claude/handoffs/EICR_Automation--readback-correction-optionb-2026-06-18/PLAN-final.md
**Target repo:** /Users/derekbeckley/Developer/EICR_Automation (backend Phase A)
**Worktree:** /Users/derekbeckley/Developer/EICR_Automation-ep-20260618T130343Z-ep
**Branch:** ep/readback-correction-optionb-20260618T130343Z-ep
**Scope:** Phase A (backend) only. Phase B (iOS, CertMateUnified) is gated on backend rollout completing — separate /ep run.

---

## Steps

(appended as work proceeds)

## Step 1 (§3.1) — Read-back un-gating + debounce key + exempt derivations
- Status: applied
- Decision: rule 1 (verbatim). Removed 3 confidence filters in synthesiseConfirmations; CONFIRMATION_MIN_CONFIDENCE now only the speculator gate (comment re-pinned in confirmation-text.js). New confirmationDebounceKey keys on field+circuit(s)+board+value (text fallback). Derived writes (::calc:: / derived:true) excluded from read-back via a Set, still on the wire.
- Files: src/extraction/stage6-event-bundler.js, src/extraction/confirmation-text.js, src/__tests__/stage6-event-bundler.test.js, src/__tests__/stage6-event-bundler-debounce.test.js
- Commit: 44be4bbe
- Tests: bundler+debounce+confirmation-text 100/100; shadow-harness 46/46; loaded-barrel/calculate/confirmation 164/165 (1 skipped pre-existing). No regressions.
- Notes: flipped 2 pre-existing tests deliberately (low-confidence skip → read-back; field-only debounce → composite key). Added derived-exemption test.

## Step 2 (§3.2) + Step 5 (§3.3 prompt exceptions) — prompt + CLAUDE.md
- Status: applied (combined — same prompt file + shared size budget)
- Decision: rule 1. CONFIDENCE SCORING → diagnostic-only; Directive 3 + RESTRAINT bare-negation exceptions; RECENT CONTEXT transient sentence; BARE NEGATION AFTER A READ-BACK block + Example 10. CLAUDE.md invariant 2 superseded + changelog row. Prompt caps bumped (combined 15301→16450 measured 16355; base 10193→11350 measured 11247).
- Files: config/prompts/sonnet_agentic_system.md, CLAUDE.md, src/__tests__/stage6-agentic-prompt.test.js
- Commit: 5b833b4d
- Tests: stage6-agentic-prompt 54/54.

## Step 9a (§3.3 gate relax) — forward bare negation + chitchat wake
- Status: applied (tool_choice:any round-1 no-op deferred to rolling-window commit)
- Decision: rule 1. STANDALONE_NEGATION_PATTERN (^…$ anchored) forwards bare no/nope/nah as HAS_COMPLAINT_OR_NEGATION; chitchat-pause negationHit wake added. Flipped 'No.' pin; added negative pins.
- Files: src/extraction/pre-llm-gate.js, src/extraction/sonnet-stream.js, src/__tests__/pre-llm-gate.test.js
- Commit: 7515d9cc
- Tests: pre-llm-gate 147/147; chitchat+sonnet-stream 200/200.

## Step 8 (§6) — capability wiring low_conf_readback_v1 + PRE-APPLY gate
- Status: applied
- Decision: rule 1. KNOWN_SUPPORTS += low_conf_readback_v1; hasLowConfReadbackV1 accessor on populated + empty()/v0. dispatchRecordReading PRE-APPLY skip (non-error envelope, no mutation/wire/confirmation) when !cap && typeof confidence==='number' && <0.5. Threaded via createWriteDispatcher extraCtx from entry.voiceLatency.capabilities.
- Files: voice-latency-config.js, stage6-dispatchers-circuit.js, stage6-shadow-harness.js, + 2 test files
- Commit: 5a33a5e2
- Tests: voice-latency-config + stage6-dispatchers-reading 49/49.

## Step 6 (§3.3/§6) + Step 7 (§6 ask key) — context_board_id carry-through
- Status: applied
- Decision: rule 1 for schema/resolver threading; rule 2 (documented deviation) for ask key — APPEND `@<board>` only when present (back-compat) instead of plan's literal prefix `boardToken:field:circuitToken`, which would shift every existing key + break ~20 pinned format tests. Same separation goal achieved. All 3 resolver write sites patched (resolveValueAnswer/resolveEnumAnswer inline closures + module-level buildWrite) + resolveCircuitAnswer.
- Files: stage6-tool-schemas.js, stage6-answer-resolver.js, stage6-dispatcher-ask.js, stage6-ask-gate-wrapper.js + 4 test files
- Commit: a0b209af
- Tests: tool-schemas/answer-resolver/ask-gate-wrapper/ask-budget/dispatcher-ask 419/419.

## Step 3+4 (§3.3a/b) + Step 9b (tool_choice no-op) — rolling context window
- Status: applied
- Decision: rule 1/2. New pure readback-window.js (dual-source accumulator, slot-identity dedup, turn-count staleness, chronological user→assistant injection). Wired into runLiveMode: accumulate mid-stream (onSlotAudioReady) + final post-debounce reading confirmations; inject as fresh per-turn messages before current utterance; round-1 tool_choice:any disabled for standalone-negation turns with empty window. Reading-vs-non-reading via sentinel field names (no wire change). Dedup by slot identity (field+circuit+board), not value/text, to survive mid/final text drift — documented deviation from plan's value/text dedup (text drift between speculator + designation-bearing final line would break a text key).
- Files: src/extraction/readback-window.js (new), src/extraction/stage6-shadow-harness.js, src/__tests__/readback-window.test.js (new)
- Commit: 39c24f19
- Tests: readback-window + shadow-harness 60/60.

## Completed 2026-06-18 (backend Phase A)
- **Outcome: ALL PASSED** — every plan step applied (none skipped/blocked/failed).
- **Commits (this branch):**
  - 44be4bbe feat(voice): universal read-back — drop confidence gate, fix debounce key, exempt derivations (§3.1)
  - 5b833b4d prompt(voice): diagnostic-only confidence + Option B bare-negation correction rules (§3.2 + §3.3 prompt)
  - 7515d9cc feat(voice): forward bare negation through the pre-LLM gate + wake chitchat-pause (§3.3 gate relax)
  - 5a33a5e2 feat(voice): capability-gate the <0.5 read-back rollout (low_conf_readback_v1) (§6)
  - a0b209af feat(voice): thread context_board_id through ask_user → resolvers → write + ask key (§3.3/§6)
  - 39c24f19 feat(voice): rolling context window so the live model resolves a bare "no" (Design 2) (§3.3a/b + tool_choice no-op)
- **Tests:** full backend suite `node --experimental-vm-modules jest` → 4776 passed, 19 skipped, 0 failed (195/195 suites). New tests: readback-window (15), capability gate (4), board_id carry-through (resolver+key+schema), gate relax (standalone negation), debounce composite key, derived-exemption, low-confidence read-back flip.
- **Lint:** my 25 changed files clean. 1 pre-existing `no-empty` error in src/routes/pdf.js (NOT touched, last changed by Phase-3 refactor b77c3c96) — out of scope, untouched.
- **Assumed/deviation decisions:**
  - §3.1 debounce key uses `value` with `text` fallback (live entries carry text, not value) — plan-aligned.
  - §6 ask-budget key: APPENDS `@<board>` only when present (back-compat) instead of the plan's literal `boardToken:field:circuitToken` prefix, which would shift every existing key + break ~20 pinned format tests. Same separation goal.
  - §3.3a buffer dedup by slot identity (field+circuit(s)+board), NOT value/text — guarantees mid-stream+final collapse despite designation text drift. Value carried best-effort (mid-stream only); injection uses `text`, ask-scoping uses field/circuit/board, so value is not load-bearing.
  - §3.2 + §3.3 prompt edits committed together (one file, shared size-budget cap).
- **Deploy:** backend Phase A mandated by plan §6 ("→ ECS via CI, gh run watch to COMPLETED"); gate passed → ready PR + merge + CI watch. No new task-def env vars (no drift-check concern). low_conf_readback_v1 is a CLIENT-advertised capability, not an env var.
- **NOT in scope this run (Phase B — separate /ep against CertMateUnified, AFTER backend rollout):** iOS drop the `<0.5` client filter, relax TranscriptGate for bare no/nope/nah, advertise `low_conf_readback_v1` in voice_latency.supports, EC5 `extractionTurnId != nil` single-fire guard. TestFlight follow-on.

## Rebase against main (PR #60 landed mid-run) — 2026-06-18
- `gh pr merge` reported non-mergeable: PR #60 (loaded-barrel agentic restore, Plan A+B) merged to main after I branched, overlapping confirmation-text.js, voice-latency-config.js, sonnet_agentic_system.md, stage6-shadow-harness.js, stage6-tool-loop.js + tests.
- Merged origin/main into the branch; 3 conflicts resolved:
  1. **stage6-shadow-harness.js onSlotAudioReady** — main's Plan B (B1a) set `onSlotAudioReady: null` (suppress mid-stream advertisement entirely). Took main's side; dropped my mid-stream `spokenReadbacks.push`. CONSEQUENCE: under Plan B the inspector hears ONLY canonical (final) confirmations, so the rolling buffer is now sourced from final reading confirmations alone — correct (the dual-source mid-stream path no longer plays to iOS). The `spokenReadbacks` accumulator + final-confirmation population are retained.
  2. **stage6-shadow-harness.js toolChoiceAnyOnRound1** — main REMOVED the round-1 tool_choice force from the tool loop entirely (grep: no `tool_choice` in stage6-tool-loop.js). So my §6 no-op allowance guards a force that no longer exists → DROPPED the bespoke negation no-op gate (dead code) + the now-unused `windowHasReadback`/`STANDALONE_NEGATION_PATTERN` imports. The model already no-ops on round 1 by default. Rolling-window injection retained (the load-bearing part).
  3. **stage6-shadow-harness.js buffer-push vs B1b** — independent; kept BOTH my buffer population AND main's `speculator.validateAgainstConfirmations` (B1b drift validate).
- Prompt size-budget caps re-measured on the MERGED prompt (both my + main's additions present): combined 16030→17150 (measured 17060), base 10920→12050 (measured 11952).
- CLAUDE.md changelog: kept both my 2026-06-18 rows + main's 2026-06-16 row; noted the tool_choice no-op drop.
- **Full suite re-run on merged tree: 4807 passed / 19 skipped / 0 failed (198/200 suites).** Lint clean on resolved files.
