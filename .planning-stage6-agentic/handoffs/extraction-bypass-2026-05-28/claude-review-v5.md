# Claude review of PLAN_v5 — extraction-bypass sprint

**Date:** 2026-05-28
**Reviewer:** Claude (Opus 4.7, independent pass)
**Plan reviewed:** `PLAN_v5.md` (delta on `PLAN_v4.md`)
**Iteration trajectory:** v1 4B → v2 8B → v3 4B → v4 4B → v5 (this pass)

## Verdict

**SHIPPABLE WITH FIXES** — 1 BLOCKER, 4 IMPORTANT, 5 MINOR.

v5 has converged on the architecture and almost all code symbols. The one surviving BLOCKER is a literal-code mistake in §3.3 that would silently delete half the existing tool registry if implemented verbatim. The IMPORTANTs are real but each is a 1-3 line spot fix at implementation. The plan is close enough that the next iteration can be a focused patch, not a rewrite.

Convergence-honest read: v5 grounds nearly everything against actual source. The remaining BLOCKER is a copy-paste leftover from v4 (the "/* etc — current 8 */" placeholder) that the v4 reviewer didn't flag and v5 didn't fix. Once that's corrected, the IMPORTANTs are mostly about misaligned types between Swift dictionary keys and the JS wire-shape, plus one missed mutation site in the bypass-position narrative. Worth one more focused pass.

---

## BLOCKER 1 — `_BASE_TOOL_SCHEMAS_ARRAY` literal in §3.3 is missing 8 tools

**File:** `PLAN_v5.md` §3.3 (lines 302-308)
**Severity:** BLOCKER — implementing the snippet literally deletes half the tool registry.

v5's snippet:

```js
const _BASE_TOOL_SCHEMAS_ARRAY = Object.freeze([
  recordReading, clearReading, createCircuit, renameCircuit,
  recordBoardReading, askUser, startDialogueScript, addBoard, /* etc — current 8 */
]);
```

The actual `TOOL_SCHEMAS` array in `src/extraction/stage6-tool-schemas.js:1009-1037` has **16 tools**, not 8:

```
recordReading, clearReading, createCircuit, renameCircuit,
recordObservation, deleteObservation, askUser, recordBoardReading,
startDialogueScript, deleteCircuit, calculateZs, calculateR1PlusR2,
setFieldForAllCircuits, addBoard, selectBoard, markDistributionCircuit
```

The v5 snippet drops 8 of them (`recordObservation`, `deleteObservation`, `deleteCircuit`, `calculateZs`, `calculateR1PlusR2`, `setFieldForAllCircuits`, `selectBoard`, `markDistributionCircuit`). Taken verbatim, this:
- Wipes `recordObservation` / `deleteObservation` → Sonnet can no longer emit observations under SoI-flag-on.
- Wipes the multi-board tools (`selectBoard`, `markDistributionCircuit`) → multi-board sprint regressed.
- Wipes the bulk write (`setFieldForAllCircuits`) → 2026-05-06 fix regressed.

The "/* etc — current 8 */" comment is the giveaway: it was inherited from v4 (which also miscounted as "current eight" on §3.3 line 352) and never corrected. The actual fix is to either:

1. Enumerate all 16 tools in `_BASE_TOOL_SCHEMAS_ARRAY` explicitly, or
2. Build the base list FROM the existing `TOOL_SCHEMAS` export:

   ```js
   const _BASE_TOOL_SCHEMAS_ARRAY = Object.freeze([...TOOL_SCHEMAS]);
   ```

   But this re-introduces the v4 BLOCKER 3 TDZ problem v5 was supposed to fix (TOOL_SCHEMAS depends on `_BASE_TOOL_SCHEMAS_ARRAY`).

The cleanest correction: move every individual `makeTool(...)` const above the array (they already are — lines 195-980), then define `_BASE_TOOL_SCHEMAS_ARRAY` listing **all 16** explicitly, then `TOOL_SCHEMAS = _BASE_TOOL_SCHEMAS_ARRAY`, then `buildToolSchemas` references `_BASE_TOOL_SCHEMAS_ARRAY`.

---

## IMPORTANT 1 — Swift type mismatch in `normaliseRegexKey` circuit branch

**File:** `PLAN_v5.md` §2.0a (lines 79-91)
**Severity:** IMPORTANT — Swift compile error as written.

v5's snippet:

```swift
let ref = Int(m.captureGroup(1))!
let field = m.captureGroup(2)
guard let cu = matchResult?.circuitUpdates[ref] else { return nil }
```

But `RegexMatchResult.circuitUpdates` is typed `[String: CircuitUpdates]` (verified at `TranscriptFieldMatcher.swift:21`). Subscripting with `Int` is a compile error. The iOS regex matcher itself uses `String` keys throughout (`circuitUpdates[circuitRef]` at lines 1313, 1366, 1714, etc.). The force-unwrap `Int(...)!` is also fragile for non-numeric refs even though the fast-eligible whitelist is numeric.

Fix: keep `ref` as String for dictionary lookup, parse to Int separately for wire shape:

```swift
let refString = m.captureGroup(1)
guard let cu = matchResult?.circuitUpdates[refString] else { return nil }
guard let refInt = Int(refString) else { return nil }
// ... return .circuit(ref: refInt, field: "measured_zs_ohm", value: v)
```

The wire shape `circuit: <int>` matches `record_reading`'s `circuit: integer` schema, but the dictionary access must use the String key.

---

## IMPORTANT 2 — Bypass insertion is "after the overtake classifier", not "after line ~3500"

**File:** `PLAN_v5.md` §2.0c (lines 134-174)
**Severity:** IMPORTANT — narrative ambiguity that will confuse the implementer.

v5 says the bypass goes "AFTER the regex-result normalisation block (line ~3500), before runShadowHarness". But the overtake classifier sits between lines 3545 and 3764, and `runShadowHarness` is at line 3766. The classifier has multiple early-return branches that mutate `entry.pendingAsks`, push to `entry.pendingTranscripts`, set `entry.lastRegexResults = []`, etc.

The bypass code MUST be placed **after** the entire `if (entry.pendingAsks.size > 0) { ... classifyOvertake ... }` block (i.e., line 3765, just before line 3766). The eligibility rule `!pendingAsk` rule means the bypass only triggers when `pendingAsks.size === 0`, so structurally the classifier never runs on bypass-eligible turns. But the plan text needs to make this explicit — "after line ~3500" is misleading.

Fix: change §2.0c's "(after line ~3500, before runShadowHarness call)" to "(immediately before `runShadowHarness` at line ~3766, after the overtake-classifier block)". Otherwise an implementer who places the bypass at line 3500-3510 will short-circuit the classifier for bypass-eligible utterances and lose the classifier's defensive ledger-clearing on non-bypass paths.

---

## IMPORTANT 3 — `originalTranscriptText` capture site needs an explicit line, and v5 contradicts itself

**File:** `PLAN_v5.md` §2.0c (line 136 vs lines 176-177)
**Severity:** IMPORTANT — the snippet and the explanation disagree.

In the code block:
```js
const originalTranscriptText = msg.text;  // captured EARLIER, before script prepends
```

This is shown INSIDE the bypass block — but the comment says "captured EARLIER". Then the trailing prose says:

> `originalTranscriptText` is captured at line 3258 (`let transcriptText = msg.text`) — add `const originalTranscriptText = msg.text;` immediately below.

These disagree. The capture site must be **before** the script processors (line 3259, right after `let transcriptText = msg.text`), NOT inside the bypass block at line 3500+. By the time the code reaches line 3500, `transcriptText` has already been mutated by the in_response_to prepend (line 3263) and the script processors. The bypass needs the **pre-mutation** value.

Fix: move the `const originalTranscriptText = msg.text;` line out of the §2.0c snippet, and add an explicit edit to `let transcriptText = msg.text;` at line 3258 to also bind `originalTranscriptText`. The bypass block then refers to it without re-capturing.

---

## IMPORTANT 4 — `lookup_inspection_item` is a READ tool but plan registers it as a WRITE

**File:** `PLAN_v5.md` §3.4 (lines 396-404)
**Severity:** IMPORTANT — semantic mismatch, contaminates per-turn write tracking.

v5 registers `dispatchLookupInspectionItem` in `WRITE_DISPATCHERS`:

```js
const WRITE_DISPATCHERS = {
  record_reading: dispatchRecordReading,
  // ... existing ...
  lookup_inspection_item: dispatchLookupInspectionItem,  // NEW
};
```

But `lookup_inspection_item` is a read tool — it returns text, doesn't mutate `perTurnWrites` or `stateSnapshot`. By the existing module design (`stage6-dispatchers.js:160-166`), `WRITE_TOOL_NAMES = new Set(Object.keys(WRITE_DISPATCHERS))` is then used by `createToolDispatcher` to route writes-vs-asks. Registering lookup here means:

- It flows through `createWriteDispatcher`'s closure with a `round += 1` per call → conflated with write rounds.
- `WRITE_TOOL_NAMES.has('lookup_inspection_item')` → composer treats it as a write → `createSortRecordsAsksLast` may reorder it with writes.
- `perTurnWrites.lookup_inspection_item` doesn't exist as a key → any auditor scanning perTurnWrites will be confused.

`createToolDispatcher` returns `unknown_tool` error for anything not in `WRITE_TOOL_NAMES` and not `'ask_user'`. So registering it as a write is the **easiest** path, but cleaner is to extend `createToolDispatcher` to add a third branch for read tools:

```js
const READ_DISPATCHERS = { lookup_inspection_item: dispatchLookupInspectionItem };
// In createToolDispatcher:
if (READ_DISPATCHERS[call.name]) return READ_DISPATCHERS[call.name](call, ctx);
```

Either approach works behaviourally but the plan should make the design choice explicit. Recommend the READ_DISPATCHERS path — it's cheap (4 lines), avoids polluting write metrics, and gives future read tools a home.

Sub-issue: v5's dispatcher uses `ctx?.sessionId` and `ctx?.turnId` directly. Other dispatchers destructure `const { session, logger, turnId, ... } = ctx` then read `session.sessionId`. The v5 access pattern would silently get `undefined` for sessionId. Fix to `ctx?.session?.sessionId`. Same with `ctx?.logger ?? logger` if the file-level import is kept.

---

## MINOR 1 — iOS PR: threading `result` from `applyRegexMatches` into `buildRegexSummary()` isn't spelled out

**File:** `PLAN_v5.md` §2.0a
**Severity:** MINOR — implementation gap, but spirit is clear.

v5 says the iOS PR threads `result: RegexMatchResult?` through to `TranscriptProcessor.buildRegexSummary`. But the actual call-site chain is:

- `DeepgramRecordingViewModel.applyRegexMatches()` produces `result` (line 3775 in the existing code).
- The same function is called at line 1998 of the outer pipeline, then `buildRegexSummary()` (a private VM wrapper) is invoked at line 2002 with no args.
- `buildRegexSummary()` wraps `transcriptProcessor.buildRegexSummary(writtenKeys:job:)`.

The plan needs to also change the VM wrapper at line 2312 and its caller at line 2002 to thread `result`. The cleanest path is to store `result` on the VM (`self.lastRegexResult = result` at the end of `applyRegexMatches`) so `buildRegexSummary()` can read it. Otherwise the wrapper signature has to change too.

Either way, the v5 plan should mention this 3-site change, not just the inner signature.

---

## MINOR 2 — Backwards-compat alias `EICR_AGENTIC_SYSTEM_PROMPT` will break callers if removed

**File:** `PLAN_v5.md` §3.5
**Severity:** MINOR — non-fatal but needs grep-audit.

v5 keeps `EICR_AGENTIC_SYSTEM_PROMPT = EICR_AGENTIC_SYSTEM_PROMPT_FULL_SOI` as a backwards-compat alias, which is fine. But the plan should add an explicit step: "grep `EICR_AGENTIC_SYSTEM_PROMPT` across the codebase and tests; ensure every reader either (a) still uses the alias and we keep it, or (b) migrates to the explicit variant." The existing tests in `eicr-extraction-session-apply-mode-change.test.js` and `eicr-extraction-session.snapshot-refactor.test.js` reference `EICR_AGENTIC_SYSTEM_PROMPT` — they'll silently continue to assert on the FULL_SOI variant via the alias, which is correct for the default `soiToolEnabled: false` test setup but invisible to anyone reading the test.

Fix: add a "Verify no caller pins identity to the alias under a flag-on construction" line to the implementation checklist.

---

## MINOR 3 — `parseSoiByRef` regex matches all 92 list items but doesn't handle sub-content lines

**File:** `PLAN_v5.md` §3.4 (lines 372-391)
**Severity:** MINOR — parser is more lenient than v5 claims.

Verified the regex `^- (\d+(?:\.\d+)+)\s*[—-]\s*(.*)$` against the actual file:
- 82 lines match `^- N.M — text`.
- 10 lines match `^- N.M.L — text` (three-level refs like `1.1.1`, `5.4.1`, `5.12.1-4`, `5.17.1-4`).
- All 7 zero-padded refs (`7.02`, `7.03`, ..., `7.09`) match correctly.
- `[—-]` character class is interpreted by Node's regex engine as two literal chars (em-dash + hyphen), not a range — verified with a smoke test.

The parser correctly preserves refs as strings (`7.02 ≠ 7.2`). ✓

But: the parser walks line-by-line and appends non-matching follow-up lines to `currentBuf`. For Section 4 the file has multi-line NOTE blocks between section headers and bullets:

```
## Section 4 — Consumer unit(s) / distribution board(s)

NOTE: Section 4 covers the CONSUMER UNIT (or distribution board) itself —
its enclosure, its mounting, its labelling, its protective devices. It
does NOT cover socket-outlets, switches, joint boxes, or other accessories
on the final circuits — those go under Section 5 (5.18 / 5.19).

- 4.1 — Adequacy of working space...
```

The NOTE block sits before any `- N.M —` bullet, so it's correctly skipped (currentRef is null). But the NOTE block at lines 39-41 inside Section 4 follows the section header BEFORE the first bullet — also handled correctly because currentRef starts null. Good.

Tip for the implementer: add a regression test for an item like `5.12` followed immediately by `5.12.1`, `5.12.2`, etc. — the parser correctly emits 5 entries (one for `5.12`, four for sub-refs), but the parsed `text` for `5.12` will be just the one-liner (the sub-bullets get their own currentRef). That's the right behaviour but worth pinning.

Also: the dispatcher pattern check `^[0-9]+(?:\.[0-9]+)+$` (in the JSON schema AND in the dispatcher's defensive regex) is correct for `1.1`, `1.1.1`, `7.02`. ✓

---

## MINOR 4 — Cost model still leans on v4's $0.03–$0.10/session — fair but worth re-confirming

**File:** referenced from `PLAN_v4.md` §1 (carried by reference in v5)
**Severity:** MINOR — defensible after all constraints, but Phase A is now mostly mechanism-establishment, not $-saving.

v5 doesn't re-state the cost model. v4's §1 puts Phase A saving at $0.02–$0.06/session with the 5-field whitelist, total Phase A+B at $0.04–$0.08. v4 itself notes (§1, line 39) "**The case for shipping this sprint is no longer pure $-saving; it's the bypass mechanism establishment.**" That's honest.

Worth adding to v5: a one-line acknowledgment that v5's additional constraints (eligibility rule #7 `transcriptText === originalTranscriptText` blocks bypass on EVERY turn the script processors touch — which is most ring/IR/PD turns) likely REDUCE the bypass rate below v4's $0.02–$0.06 estimate, since most circuit-reading utterances during a session go through one of the script processors. A realistic bypass rate may be 5-10% of forwarded utterances, not 30-50%, which lands the actual saving at ~$0.01–$0.03/session, not $0.03–$0.10.

This doesn't change the "ship for mechanism" rationale, but the absolute number is overstated by ~2-3x. The plan should reflect this.

---

## MINOR 5 — `installationDetails` lives at `stateSnapshot.circuits[0]` is verified but worth a comment in `_mergeIncomingJobStateIntoSnapshot`

**File:** `PLAN_v5.md` §2.0d
**Severity:** MINOR — correctness is right but the new branch reads weirdly without context.

v5's new `installationDetails` branch writes to `stateSnapshot.circuits[0]`:

```js
if (jobState.installationDetails && typeof jobState.installationDetails === 'object') {
  const target = this.stateSnapshot.circuits[0] || (this.stateSnapshot.circuits[0] = {});
  this._mergeCircuitOrBoardFields(target, jobState.installationDetails);
}
```

Verified this is the existing convention — `record_board_reading` writes installation/supply/board fields into `circuits[0][field]` (see `stage6-tool-schemas.js:579` and `stage6-dispatchers-board.js`). So `postcode` lives at `circuits[0].postcode`. ✓

But the branch needs an inline comment ("Same supply-bucket convention as record_board_reading — installation_details fields live at circuits[0] alongside supply") or future readers will think it's a bug.

Also: the branch order matters. The CIRCUITS branch writes to `circuits[key]` for numeric refs. If an iOS payload contains BOTH `circuits: [{ref: 0, ...}]` AND `installationDetails: {...}`, the two branches would both touch `circuits[0]`. The plan should specify the precedence (probably "circuits first, installation second to fill empty cells") or assert that iOS never sends both simultaneously.

---

## Convergence assessment

v5 closes 4 BLOCKERs + 6 IMPORTANTs from v4. The remaining issues are at finer granularity than every previous iteration:

- v1 → v2: architecture rewrites
- v2 → v3: structural rewrites
- v3 → v4: code-symbol verification
- v4 → v5: integration depth (mergeIncoming branch, makeTool signature, dispatcher envelope)
- v5 → v6: literal-code accuracy (the BLOCKER) + Swift type alignment (4 IMPORTANTs)

This is the right direction. v6 should be a 2-3 hour patch, not a rewrite. After v6 lands, suggest skipping further reviews and just shipping behind the `REGEX_BYPASS_MODE=shadow` flag — telemetry will catch anything the reviewers missed faster than another review pass.

Verdict gate: zero BLOCKERs needed for ship. v5 has 1, all the others are minor enough to fix during implementation.

## Audit trail
- [x] PLAN.md (v1) — Claude self-review → v2
- [x] PLAN_v2.md — Codex review → v3
- [x] PLAN_v3.md — Claude self-review → v4
- [x] PLAN_v4.md — Codex review → v5
- [x] PLAN_v5.md — Claude review (this file): 1 BLOCKER, 4 IMPORTANT, 5 MINOR → v6
- [ ] PLAN_v6.md — final Codex pass
