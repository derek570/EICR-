# Claude review of PLAN_v6 — extraction-bypass sprint

**Date:** 2026-05-28
**Reviewer:** Claude (Opus 4.7, independent pass)
**Plan reviewed:** `PLAN_v6.md` (delta on v5/v4/v3/v2/v1)
**Iteration trajectory:** v1 4B → v2 8B → v3 4B → v4 4B → v5 1B → v6 (this pass)
**Codex v6 verdict:** SHIPPABLE — 0 BLOCKER, 1 IMPORTANT, 2 MINOR.

## Verdict

**SHIPPABLE — 0 BLOCKER, 1 IMPORTANT, 2 MINOR.**

I independently re-verified every v6 correction against the live source. All five v5→v6 fixes (the BLOCKER + four IMPORTANTs) land cleanly, the citations are accurate down to the line number, and no earlier-iteration fix has regressed. The single IMPORTANT Codex flagged on the dispatcher snippet shape is real but does not rise to BLOCKER — the intent is unambiguous from the surrounding prose and the right-shaped fix is a 1-2 line adaptation against the existing `createToolDispatcher(writes, asks)` factory.

Convergence is genuine. v6 is the first version of this plan that can be implemented end-to-end from the document alone, with the dispatcher snippet shape as the only "read the real file before pasting" caveat.

---

## Fix verification (v5 → v6)

### v5 BLOCKER 1 — 16-tool list in §3.3 — VERIFIED FIXED

Read `src/extraction/stage6-tool-schemas.js:1009-1037`. The existing `TOOL_SCHEMAS` array contains exactly these 16 tools, in this order:

```
recordReading, clearReading, createCircuit, renameCircuit,
recordObservation, deleteObservation, askUser, recordBoardReading,
startDialogueScript, deleteCircuit, calculateZs, calculateR1PlusR2,
setFieldForAllCircuits, addBoard, selectBoard, markDistributionCircuit
```

PLAN_v6 §3.3 lines 231-248 list exactly the same 16 in the same order, then appends `lookupInspectionItem` conditionally via `buildToolSchemas`. The `TOOL_SCHEMAS = buildToolSchemas({ soiToolEnabled: false })` re-export preserves the existing default-off bundle. No tools dropped.

### v5 IMPORTANT 1 — Swift property names — VERIFIED FIXED

Read `CertMateUnified/Sources/Recording/TranscriptFieldMatcher.swift:19-99`.

- `RegexMatchResult.circuitUpdates` is `[String: CircuitUpdates]` (line 21). v6 uses String lookup throughout (`matchResult?.circuitUpdates[refString]`). Correct.
- `CircuitUpdates` struct properties verified for all five fast-eligible fields:
  - `measuredZsOhm` at line 70
  - `r1R2Ohm` at line 71
  - `irLiveEarthMohm` at line 75
  - `irLiveLiveMohm` at line 76
  - `numberOfPoints` at line 86

All five names match v6's snippet exactly. The `Int(refString)` parse for the wire-shape `circuit:` field is correctly separated from the dictionary lookup.

### v5 IMPORTANT 2 — bypass insertion point — VERIFIED FIXED

Read `src/extraction/sonnet-stream.js`:

- Line 3258: `let transcriptText = msg.text;` — exists, single statement, no other mutations on the line.
- Lines 3302, 3357, 3383, 3406, 3435, 3460: subsequent `transcriptText =` mutations (in_response_to prepend, ring/IR/PD script outcomes, ring/IR notes). Confirms the capture site must be at 3258 BEFORE any of these can run.
- Line 3546: `classifyOvertake(msg.text, regexResults, entry.pendingAsks)` — overtake classifier entry point.
- Line 3760: classifier's final `return;` inside `entry.pendingAsks.size > 0` block.
- Line 3764: closing brace of the `if (entry.pendingAsks.size > 0)` block.
- Line 3766: `const result = await runShadowHarness(entry.session, transcriptText, regexResults, {` — runShadowHarness call.

v6's "immediately before `runShadowHarness` at line ~3766, after the overtake-classifier block (3545-3764)" is exactly right. The bypass insertion location at line ~3765 places the new block after the classifier closes and before `runShadowHarness` opens — the structurally correct seam.

### v5 IMPORTANT 3 — originalTranscriptText capture — VERIFIED FIXED

Confirmed via `grep -n "originalTranscriptText" sonnet-stream.js` returning empty — the symbol does not exist in the codebase today. v6's instruction to bind both `transcriptText` AND `originalTranscriptText` at line 3258 is the only correct site. The capture happens before any prepend/replacement, so the bypass's `originalTranscriptText === transcriptText` eligibility check correctly detects "script processor or in_response_to mutated the transcript".

### v5 IMPORTANT 4 — READ_DISPATCHERS map — DESIGN VERIFIED, SNIPPET SHAPE WRONG

Read `src/extraction/stage6-dispatchers.js:196-206`. The actual `createToolDispatcher` is:

```js
export function createToolDispatcher(writes, asks) {
  return async function dispatchTool(call, ctx) {
    if (call.name === 'ask_user') return asks(call, ctx);
    if (WRITE_TOOL_NAMES.has(call.name)) return writes(call, ctx);
    return {
      tool_use_id: call.tool_call_id ?? call.id,
      content: JSON.stringify({ error: 'unknown_tool', name: call.name }),
      is_error: true,
    };
  };
}
```

This is a higher-order factory taking pre-constructed `writes` and `asks` closures. v6 §3.4 line 285-298 shows `async function createToolDispatcher(call, ctx)` as if it were the per-call dispatch function itself, and references `createWriteDispatcher(call, ctx)` as if it could be called per-call. That's wrong shape — see IMPORTANT 1 below.

However the **design** (READ_DISPATCHERS routed first, then WRITE, then ask_user) is sound. Callers of `createToolDispatcher` in `stage6-shadow-harness.js:327` and `stage6-shadow-harness.js:1135` already pass pre-constructed `writes` + `asks`; READ_DISPATCHERS can be looked up directly inside the returned `dispatchTool` closure with no new arguments needed.

The `ctx?.session?.sessionId` / `ctx?.turnId` correction in the dispatcher implementation (PLAN_v6 §3.4 line 318) IS correct — that matches how existing dispatchers like the ones in `stage6-dispatcher-circuit.js` read context.

### v5 MINOR 1 — three iOS sites — VERIFIED FIXED

Confirmed all three sites:

- `CertMateUnified/Sources/Recording/TranscriptProcessor.swift:199` — `buildRegexSummary(writtenKeys:job:)` exists, currently has a 2-line postcode-only body. v6's matchResult expansion plan is well-targeted.
- `CertMateUnified/Sources/Recording/DeepgramRecordingViewModel.swift:2312` — wrapper `private func buildRegexSummary() -> [[String: Any]]?` exists. v6's Option A (cache `lastRegexResult` on VM) is the lower-risk path.
- `CertMateUnified/Sources/Recording/DeepgramRecordingViewModel.swift:4047-4072` — `applyRegexMatches` circuit-hint loop iterates `result.circuitUpdates` with String keys (`for (circuitRef, circuitUpdate) in result.circuitUpdates`). Today the loop only inserts `ocpdRating`/`ocpdType`/`ocpdBsEn`/`rcdType` keys into `thisTurnRegexWrites`. The five new bypass-eligible inserts in v6 §2.0a are necessary — without them, the bypass cannot fire because the keys never appear in `writtenKeys`.

### v5 MINOR 2 — EICR_AGENTIC_SYSTEM_PROMPT alias — VERIFIED FIXED

The implementation checklist in §3.5 explicitly calls out the grep + test-by-test verification. This is a checklist instruction, not a code change; the instruction is adequate. (No code claim to verify.)

### v5 MINOR 3 — parser regression test — VERIFIED FIXED

Test plan note added in §0 line 21. (No code claim to verify.)

### v5 MINOR 4 — cost model — VERIFIED FIXED

v6 §1 (lines 27-54) restates the cost model honestly: $0.01–$0.03/session for Phase A, $0.015–$0.035 combined A+B. The reasoning is sound — eligibility rule #7 (`transcriptText === originalTranscriptText`) excludes turns where script processors mutate the transcript, which covers most field-data turns. The "defer unless (a)/(b)/(c)" recommendation is appropriately conservative.

### v5 MINOR 5 — `_mergeIncomingJobStateIntoSnapshot` branch order — VERIFIED FIXED

Read `src/extraction/eicr-extraction-session.js:1760-1802`. Current order is CIRCUITS (1763-1779), SUPPLY (1781-1785), BOARDS (1787-1801). v6's insertion of INSTALLATION_DETAILS LAST is correct: any `ref:0` collision with the CIRCUITS branch is already overwritten by `_mergeCircuitOrBoardFields`'s FACT_FIELDS/reading-fill semantics, and INSTALLATION_DETAILS arrives after both CIRCUITS and SUPPLY have populated `circuits[0]` — so the installation merge uses empty-fill-only semantics for non-fact fields and leaves anything already present alone.

The inline comment at PLAN_v6 line 200-204 is accurate; nothing to refight.

---

## Findings

### IMPORTANT 1 — §3.4 dispatcher snippet shape mismatches the live factory

**File:** `PLAN_v6.md` §3.4 lines 285-298
**Severity:** IMPORTANT (NOT BLOCKER — intent is clear, implementer should not get stuck)

v6 shows the dispatcher as if `createToolDispatcher` were a direct dispatch function:

```js
async function createToolDispatcher(call, ctx) {
  if (READ_DISPATCHERS[call.name]) return READ_DISPATCHERS[call.name](call, ctx);
  if (WRITE_DISPATCHERS[call.name]) return createWriteDispatcher(call, ctx);
  if (call.name === 'ask_user') return dispatchAskUser(call, ctx);
}
```

Two shape errors:

1. The real `createToolDispatcher` is `(writes, asks) => dispatchTool` — a factory returning a closure (`src/extraction/stage6-dispatchers.js:196`). Both callers in `stage6-shadow-harness.js:327` and `:1135` already pass pre-constructed `writes` and `asks`.

2. `createWriteDispatcher(call, ctx)` is not a per-call dispatch — `createWriteDispatcher` is itself a factory (`stage6-dispatchers.js:127`-ish) that returns the actual `writes(call, ctx)` closure. Calling it per-call would construct a new dispatcher every turn.

The correct edit — preserving the existing factory shape — is:

```js
const READ_DISPATCHERS = { lookup_inspection_item: dispatchLookupInspectionItem };
const READ_TOOL_NAMES = new Set(Object.keys(READ_DISPATCHERS));

export function createToolDispatcher(writes, asks) {
  return async function dispatchTool(call, ctx) {
    if (READ_TOOL_NAMES.has(call.name)) return READ_DISPATCHERS[call.name](call, ctx);
    if (WRITE_TOOL_NAMES.has(call.name)) return writes(call, ctx);
    if (call.name === 'ask_user') return asks(call, ctx);
    return {
      tool_use_id: call.tool_call_id ?? call.id,
      content: JSON.stringify({ error: 'unknown_tool', name: call.name }),
      is_error: true,
    };
  };
}
```

**Why this is IMPORTANT, not BLOCKER:** the v6 prose around the snippet (lines 264-281, 300-330) describes the design clearly enough that an implementer reading the actual file will see the mismatch within seconds. The verdict shape `{ tool_use_id, content, is_error }` is correct. The READ-first-then-WRITE-then-ASK ordering is correct. The ctx access correction (`ctx?.session?.sessionId`) is correct. The only risk is an implementer copy-pasting the snippet verbatim — which v6 itself implicitly forbids by including the line "(`src/extraction/stage6-dispatchers.js:126-145`) gains an early branch" — i.e., it's marked as a patch on the existing function, not a replacement.

This is identical in substance to what Codex v6 flagged. Keeping it at IMPORTANT.

### MINOR 1 — INSTALLATION_DETAILS write semantics worth one extra clarifying line

**File:** `PLAN_v6.md` §2.0d lines 188-209
**Severity:** MINOR

The comment block correctly states that `_mergeCircuitOrBoardFields` applies FACT/READING precedence + empty-fill-only semantics. One nuance to flag for the implementer: `FACT_FIELDS` (`eicr-extraction-session.js:621`) determines per-field whether the merge overwrites or fills-empty. Installation fields like `postcode` and `client_name` aren't in FACT_FIELDS today, so they'll fill-empty-only — which is the right behaviour for the bypass path. But if a future commit adds an installation field to FACT_FIELDS, the v6 INSTALLATION_DETAILS branch will start overwriting CIRCUITS-branch ref:0 writes for that field.

This isn't a v6 defect — it's the same edge that already exists for SUPPLY → CIRCUITS collisions and the existing code accepts. Just worth one extra implementation-checklist line: "If adding an installation field to `FACT_FIELDS` in future, audit the v6 INSTALLATION_DETAILS branch order for collisions."

### MINOR 2 — Option A `lastRegexResult` cache lifecycle

**File:** `PLAN_v6.md` §2.0a lines 104-108
**Severity:** MINOR

v6 chooses Option A (cache `result` on the VM as `lastRegexResult` at end of `applyRegexMatches`). The cache is overwritten on every pass — which is correct in the happy path — but `applyRegexMatches` has at least one early return that doesn't reach the cache-write line. If a turn returns early before the cache is written, the wrapper will read a stale `lastRegexResult` from a previous turn.

This is mostly masked today because `thisTurnRegexWrites` is also cleared per-turn and `buildRegexSummary` returns nil on empty writes — but it's a fragile coupling. One additional implementation-checklist line: "clear `lastRegexResult = nil` at the top of `applyRegexMatches()`, before any early return paths."

Codex v6 flagged the same edge as MINOR 2. Logging it here for consistency.

---

## Anything material missing from the plan?

No. Cross-checked the surface area:

- **Phase A (regex bypass):** wire-shape upgrade, capture site, insertion site, merge-into-snapshot extension — all specified, all grounded against verified file:line refs.
- **Phase B (SoI lookup tool):** schema build, dispatcher wiring (with the dispatcher-shape caveat above), READ_DISPATCHERS map, module-init constant split, test plan — all specified.
- **Observation TTS bridge branch:** mentioned in §0 header, scoped out for this plan.
- **Tests:** explicit list of three new `applyModeChange` tests in §3.5 + SoI parser regression test in §0.
- **Rollout:** `regexBypassMode` flag has the right three modes (`off` / `shadow` / `live`) with shadow → live progression; SoI flag default-off until tests pass.
- **Cost model:** honestly restated, decision criteria for proceeding/deferring spelled out.
- **Sprint scope:** 5-7 days end-to-end, two iOS branches + two backend branches — realistic for the scope.

The plan is "complete enough to ship." The v5→v6 convergence is real: every v5 finding either landed as a verified code-grounded fix or was acknowledged with a checklist line.

---

## Trajectory summary

| Iteration | BLOCKERs | Status |
|---|---|---|
| v1 | 4 | rewrite needed |
| v2 | 8 | rewrite needed |
| v3 | 4 | rework |
| v4 | 4 | rework |
| v5 | 1 | one focused patch |
| v6 (Codex) | 0 + 1 IMP + 2 MIN | SHIPPABLE |
| v6 (Claude, this pass) | 0 + 1 IMP + 2 MIN | SHIPPABLE |

The two reviewers (Codex and Claude) independently landed on the same finding set. The remaining IMPORTANT is a snippet-shape defect that an implementer reading the actual `createToolDispatcher` source will catch immediately; the two MINORs are documentation-quality lifts, not correctness gaps.

**Recommendation:** ship the plan. Add one line to §3.4 noting the dispatcher must preserve the existing `(writes, asks) => dispatchTool` factory shape; add the two minor checklist lines from MINOR 1 + MINOR 2 above. No further iteration required.
