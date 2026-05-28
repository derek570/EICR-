# Extraction-bypass sprint v6 — corrections from Claude v5 review

**Date:** 2026-05-28
**Iteration:** v6 (folds 1 BLOCKER + 4 IMPORTANTs + 5 MINORs from `claude-review-v5.md`)
**Sprint scope:** 3 phases, **5–7 days** end-to-end
**Branches:** `regex-bypass-backend`, `regex-bypass-ios`, `soi-tool-lookup`, `observation-tts-bridge`

Like v5, this is a delta on prior versions. Read PLAN_v5 (corrections) + PLAN_v4 (full plan) for unchanged sections.

## 0. v5 → v6 changelog

| # | v5 problem | v6 fix |
|---|---|---|
| BLOCKER 1 | `_BASE_TOOL_SCHEMAS_ARRAY` literal listed only 8 tools, not the actual 16. Implementing v5 verbatim would silently drop 8 production tools (recordObservation, deleteObservation, deleteCircuit, calculateZs, calculateR1PlusR2, setFieldForAllCircuits, selectBoard, markDistributionCircuit). | All 16 tools explicitly enumerated in §3.3. List order matches the existing `TOOL_SCHEMAS` array at `stage6-tool-schemas.js:1009-1037`. |
| IMPORTANT 1 | `RegexMatchResult.circuitUpdates` is `[String: CircuitUpdates]`; v5's Swift snippet subscripted with `Int`. Compile error. | §2.0a Swift snippet uses `String` key for the dictionary lookup; parses `Int(refString)` only to populate the wire-shape `circuit:` field. |
| IMPORTANT 2 | Bypass position "after line ~3500" is misleading — the overtake classifier lives between 3545 and 3764 and mutates `entry.pendingAsks`. Insert point must be after the classifier, not before. | §2.0c clarified: bypass goes **immediately before `runShadowHarness` at line ~3766**, after the overtake-classifier block. Eligibility rule #6 (`!pendingAsk && !inResponseTo`) means structurally the classifier never runs on bypass-eligible turns, but the line guidance was wrong. |
| IMPORTANT 3 | `originalTranscriptText` capture site contradicted between snippet (inside bypass block) and prose (at line 3258). The correct capture site is BEFORE `transcriptText` is mutated. | §2.0c updated: explicit edit to line 3258 binds BOTH `transcriptText` AND `originalTranscriptText` from `msg.text`. Bypass block reads `originalTranscriptText` (already captured), does NOT re-capture. |
| IMPORTANT 4 | `lookup_inspection_item` is a READ tool, not a WRITE — registering in `WRITE_DISPATCHERS` pollutes write metrics and round counting. Plus dispatcher used `ctx?.sessionId` directly instead of `ctx?.session?.sessionId`. | §3.4 introduces `READ_DISPATCHERS` map alongside `WRITE_DISPATCHERS`. `createToolDispatcher` checks READ map first, then WRITE, then falls through to `ask_user` and `unknown_tool`. Dispatcher ctx access fixed to `ctx?.session?.sessionId` / `ctx?.turnId`. |
| MINOR 1 | Plan didn't spell out the 3-site iOS PR (transcript processor + VM wrapper + caller). | §2.0a appendix lists the three sites: `TranscriptProcessor.buildRegexSummary`, `DeepgramRecordingViewModel.buildRegexSummary` wrapper at line ~2312, caller at line ~2002. |
| MINOR 2 | Backwards-compat alias `EICR_AGENTIC_SYSTEM_PROMPT` may pin test identity to wrong variant under flag-on. | §3.5 adds an implementation checklist line: grep all callers; tests that ASSERT `EICR_AGENTIC_SYSTEM_PROMPT` identity must explicitly construct sessions with `soiToolEnabled: false`. Tests under flag-on assert against `EICR_AGENTIC_SYSTEM_PROMPT_DIRECTORY`. |
| MINOR 3 | Parser regex compatibility confirmed in v5; just a regression test note carried into v6's test plan. | Noted. Regression test: feed `5.12`, `5.12.1`, `5.12.2`, `5.12.3`, `5.12.4` to `parseSoiByRef`; assert 5 entries with the parent's text being just its own one-liner. |
| MINOR 4 | Cost model not re-stated in v5; reality (with rule #7 `transcriptText === originalTranscriptText` blocking bypass on script-touched turns) is ~$0.01–$0.03/session, not v4's $0.03–$0.10. | §1 updated below. Honest revised range: **Phase A: $0.01–$0.03/session. Combined A+B: $0.015–$0.035/session.** Sprint case is mechanism-establishment + future whitelist growth, not present-day $-saving. |
| MINOR 5 | `installationDetails` branch in `_mergeIncomingJobStateIntoSnapshot` writes to `circuits[0]` — convention is right but needs inline comment + precedence rule for concurrent jobState. | §2.0d branch order specified: CIRCUITS first, SUPPLY next, BOARDS, then INSTALLATION_DETAILS last — and INSTALLATION_DETAILS uses `_mergeCircuitOrBoardFields`'s existing "fill empty cells only" semantics so a circuits[0] write that already landed via the CIRCUITS branch (numeric ref=0) is preserved. Inline comment added. |

---

## 1. Cost model (v6 honest restatement)

| Component | Phase 1 today | After Phase A | After Phase A+B |
|---|---|---|---|
| Sonnet turns/session | 24 | 22–23 (saving 1–2 turns — many turns pass through script processors and fail eligibility rule #7) | 22–23 |
| $ saved vs Phase 1 | — | **$0.01–$0.03** | **$0.015–$0.035** |

This is roughly 1/6 of v1's original headline. Two reasons for the shrinkage:

1. The `regex-fast-eligibility.js` whitelist is only 5 fields (all circuit-scoped). Most field types aren't bypass-eligible.
2. Eligibility rule #7 (`transcriptText === originalTranscriptText`) means any turn the script processors touch (ring continuity, IR walkthroughs, OCPD dialogues, partial-fill timeout notes) — i.e. most field-data turns — gets forwarded to Sonnet anyway.

**The sprint case is now explicitly:** establish the bypass mechanism so that:
- Future whitelist expansions (as the iOS regex optimiser grows coverage) automatically inherit the bypass without re-engineering.
- A future dialogue-script overhaul that decouples scripted turns from full Sonnet rounds (out of scope this sprint) immediately benefits.
- A future shift to a more aggressive bypass (e.g. "bypass even when scripts modify the transcript, if the regex hit is on a different field") has a working scaffold to extend.

At current usage (~6 sessions/day): **£0.05–£0.15/day saved**, negligible in absolute terms.
At commercial launch (~100 inspectors × 6 sessions/day): **£6–£15/day**, still small.

**Honest recommendation for the user:** Phase A is a non-trivial 5-7 day cross-platform sprint for ~£100/year of immediate savings. Phase B is 1-2 days for a few extra pence per session. **Defer the whole sprint** unless one of three things is true:
- (a) You want the bypass scaffolding in place for future whitelist growth.
- (b) Phase A's wire-shape upgrade (iOS sends regex values) is wanted independently for audit/replay.
- (c) You have time you'd otherwise spend on lower-value work.

If none of (a)/(b)/(c) apply, the right call is to merge the v6 plan as committed documentation of the design and revisit later.

If proceeding, the sprint is ready — see §6.

---

## 2. Phase A — revised sections (v6)

### 2.0a iOS wire-shape upgrade (v6)

**Three iOS sites to change:**

1. `CertMateUnified/Sources/Recording/TranscriptProcessor.swift` — `buildRegexSummary` signature gains `matchResult: RegexMatchResult?`. Dictionary keys are `String`, not `Int`.

```swift
func buildRegexSummary(
    writtenKeys: Set<String>,
    job: JobDetail?,
    matchResult: RegexMatchResult?
) -> [[String: Any]]? {
    guard !writtenKeys.isEmpty else { return nil }
    return writtenKeys.compactMap { key -> [String: Any]? in
        guard let normalised = normaliseRegexKey(key, job: job, matchResult: matchResult) else { return nil }
        var entry: [String: Any] = [
            "field": normalised.canonicalField,
            "value": normalised.value,
        ]
        switch normalised.scope {
        case .circuit:        entry["circuit"] = normalised.circuit   // Int
        case .board:          entry["board_id"] = normalised.boardId  // String
        case .supply, .installation: break
        }
        return entry
    }
}

// In normaliseRegexKey — circuit branch:
if let m = circuitKeyPattern.firstMatch(in: key) {
    let refString = m.captureGroup(1)
    guard let cu = matchResult?.circuitUpdates[refString] else { return nil }  // String key
    guard let refInt = Int(refString) else { return nil }  // for wire shape
    switch m.captureGroup(2) {
    case "zs":     guard let v = cu.measuredZsOhm     else { return nil }; return .circuit(ref: refInt, field: "measured_zs_ohm",   value: v)
    case "r1r2":   guard let v = cu.r1R2Ohm           else { return nil }; return .circuit(ref: refInt, field: "r1_r2_ohm",         value: v)
    case "irLE":   guard let v = cu.irLiveEarthMohm   else { return nil }; return .circuit(ref: refInt, field: "ir_live_earth_mohm", value: v)
    case "irLL":   guard let v = cu.irLiveLiveMohm    else { return nil }; return .circuit(ref: refInt, field: "ir_live_live_mohm",  value: v)
    case "points": guard let v = cu.numberOfPoints    else { return nil }; return .circuit(ref: refInt, field: "number_of_points",   value: v)
    default: return nil
    }
}
```

2. `CertMateUnified/Sources/Recording/DeepgramRecordingViewModel.swift:~2312` — `buildRegexSummary` wrapper. Either:
   - **Option A** (smaller change): cache `result` on the VM (`self.lastRegexResult = result` at end of `applyRegexMatches`), then `buildRegexSummary()` wrapper passes `self.lastRegexResult` through.
   - **Option B** (cleaner long-term): change wrapper signature to accept the result; update caller at line ~2002 to pass it.

Plan goes with **Option A** to minimise touch surface. The cached `result` is overwritten on every `applyRegexMatches` call, which matches the per-turn lifecycle.

3. `CertMateUnified/Sources/Recording/DeepgramRecordingViewModel.swift:4047-4072` — `applyRegexMatches` circuit-hint loop. **ALSO inserts the 5 fast-eligible keys** into `thisTurnRegexWrites`:

```swift
if let cu = result.circuitUpdates[String(circuitRef)] {
    if cu.measuredZsOhm != nil      { thisTurnRegexWrites.insert("circuit.\(circuitRef).zs") }
    if cu.r1R2Ohm != nil            { thisTurnRegexWrites.insert("circuit.\(circuitRef).r1r2") }
    if cu.irLiveEarthMohm != nil    { thisTurnRegexWrites.insert("circuit.\(circuitRef).irLE") }
    if cu.irLiveLiveMohm != nil     { thisTurnRegexWrites.insert("circuit.\(circuitRef).irLL") }
    if cu.numberOfPoints != nil     { thisTurnRegexWrites.insert("circuit.\(circuitRef).points") }
}
// Existing ocpd/rcd inserts continue below.
```

Without these inserts the bypass-eligible keys never appear in `writtenKeys` → bypass rate stays 0.

### 2.0c Bypass insertion point (v6 — definitive)

**`originalTranscriptText` capture site:** at line 3258 of `sonnet-stream.js`, where `let transcriptText = msg.text;` lives, bind BOTH:

```js
let transcriptText = msg.text;
const originalTranscriptText = msg.text;
```

**Bypass insertion site:** immediately before `runShadowHarness` at line ~3766, **after** the overtake-classifier block (3545-3764). Eligibility rule #6 (`!pendingAsk && !inResponseTo`) means the classifier doesn't run on bypass-eligible turns; v6 simply places the bypass after the classifier block for safety + narrative clarity.

```js
// (existing) lines 3258-3500: transcriptText mutation, regex normalisation
//   - originalTranscriptText captured at 3258 (v6 edit)
//   - in_response_to context prepend (3263)
//   - script processors (3334-3408)
//   - timeout note prepending (3427-3467)
//   - regex-result normalisation at 3488-3500 yields local `regexResults`
//
// (existing) lines 3545-3764: overtake-classifier block (early-returns and
//   mutates entry.pendingAsks, entry.lastRegexResults, etc — runs only when
//   entry.pendingAsks.size > 0, which bypass eligibility rule #6 excludes)

// NEW — bypass insertion, line ~3765
const bypassMode = entry.session.regexBypassMode;  // 'off' | 'shadow' | 'live'
if (bypassMode !== 'off') {
  const verdict = shouldBypassSonnet({
    transcriptText,
    originalTranscriptText,
    regexResults,
    pendingAsk: entry.pendingAsks && entry.pendingAsks.size > 0,
    inResponseTo: msg.in_response_to,
  });

  if (bypassMode === 'shadow') {
    logger.info('voice_latency.bypass.shadow', {
      sessionId,
      verdict: verdict.bypass,
      reason: verdict.reason,
      iosBuildVersion: entry.clientBuildVersion ?? null,
      regexFields: regexResults.map((r) => r.field),
    });
    // Fall through to runShadowHarness.
  } else if (verdict.bypass) {
    const jobStatePayload = buildJobStateFromRegexHits(regexResults);
    entry.session._mergeIncomingJobStateIntoSnapshot(jobStatePayload);
    stampSeenTranscript();  // existing closure in scope
    logger.info('voice_latency.bypass.applied', {
      sessionId,
      reason: verdict.reason,
      iosBuildVersion: entry.clientBuildVersion ?? null,
      regexFields: regexResults.map((r) => r.field),
      sonnet_calls_avoided: 1,
    });
    return;  // committed; finally drains queue
  }
}

// (existing) line 3766: runShadowHarness
```

### 2.0d `_mergeIncomingJobStateIntoSnapshot` extension (v6)

`src/extraction/eicr-extraction-session.js:1760-1802` — add INSTALLATION_DETAILS branch LAST so CIRCUITS branch wins precedence for any `ref:0` collision:

```js
_mergeIncomingJobStateIntoSnapshot(jobState) {
  if (!jobState || typeof jobState !== 'object') return;

  // --- CIRCUITS --- (existing)
  // --- SUPPLY --- (existing, writes to circuits[0])
  // --- BOARDS --- (existing)

  // --- INSTALLATION_DETAILS (NEW v6) ---
  // Same supply-bucket convention as `record_board_reading`: installation
  // fields (postcode, building name, client name, etc.) live alongside
  // supply fields in stateSnapshot.circuits[0]. _mergeCircuitOrBoardFields
  // applies FACT/READING precedence + empty-cell-fill-only semantics —
  // any value already written by the SUPPLY branch above is preserved.
  if (jobState.installationDetails && typeof jobState.installationDetails === 'object') {
    const target = this.stateSnapshot.circuits[0] || (this.stateSnapshot.circuits[0] = {});
    this._mergeCircuitOrBoardFields(target, jobState.installationDetails);
  }
}
```

---

## 3. Phase B — revised sections (v6)

### 3.3 Tool schema (v6 — all 16 tools enumerated)

`src/extraction/stage6-tool-schemas.js`:

```js
// (existing) makeTool helper + all 16 individual tool consts:
// recordReading, clearReading, createCircuit, renameCircuit,
// recordObservation, deleteObservation, askUser, recordBoardReading,
// startDialogueScript, deleteCircuit, calculateZs, calculateR1PlusR2,
// setFieldForAllCircuits, addBoard, selectBoard, markDistributionCircuit
//
// (existing) const lookupInspectionItem = makeTool({ ... });  // v5 def

// v6: explicit 16-entry base array — list mirrors the existing TOOL_SCHEMAS
// at lines 1009-1037 exactly (NO drops). Order is the same; new addition
// (lookupInspectionItem) appended conditionally by buildToolSchemas.
const _BASE_TOOL_SCHEMAS_ARRAY = Object.freeze([
  recordReading,
  clearReading,
  createCircuit,
  renameCircuit,
  recordObservation,
  deleteObservation,
  askUser,
  recordBoardReading,
  startDialogueScript,
  deleteCircuit,
  calculateZs,
  calculateR1PlusR2,
  setFieldForAllCircuits,
  addBoard,
  selectBoard,
  markDistributionCircuit,
]);

export const BASE_TOOL_SCHEMAS = _BASE_TOOL_SCHEMAS_ARRAY;

export function buildToolSchemas({ soiToolEnabled }) {
  const tools = [..._BASE_TOOL_SCHEMAS_ARRAY];
  if (soiToolEnabled) tools.push(lookupInspectionItem);
  return tools;
}

// Backwards-compat: default-off bundle. Match the current static export.
export const TOOL_SCHEMAS = buildToolSchemas({ soiToolEnabled: false });
```

### 3.4 Dispatcher registration (v6 — READ_DISPATCHERS map)

`src/extraction/stage6-dispatchers.js` (around lines 63-110):

```js
import { dispatchLookupInspectionItem } from './stage6-dispatchers-soi.js';

// (existing) const WRITE_DISPATCHERS = { ... }  — UNCHANGED

// v6: new READ_DISPATCHERS map for tools that return content without
// mutating perTurnWrites / stateSnapshot. Routed by createToolDispatcher
// before WRITE_DISPATCHERS so the lookup tool doesn't pollute write metrics.
const READ_DISPATCHERS = {
  lookup_inspection_item: dispatchLookupInspectionItem,
};

const WRITE_TOOL_NAMES = new Set(Object.keys(WRITE_DISPATCHERS));
const READ_TOOL_NAMES = new Set(Object.keys(READ_DISPATCHERS));
```

`createToolDispatcher` (`src/extraction/stage6-dispatchers.js:126-145`) gains an early branch for reads:

```js
async function createToolDispatcher(call, ctx) {
  // v6: read tools first — bypass round/write tracking.
  if (READ_DISPATCHERS[call.name]) {
    return READ_DISPATCHERS[call.name](call, ctx);
  }
  if (WRITE_DISPATCHERS[call.name]) {
    return createWriteDispatcher(call, ctx);  // existing path
  }
  if (call.name === 'ask_user') {
    return dispatchAskUser(call, ctx);  // existing path
  }
  return { /* unknown_tool envelope */ };
}
```

Dispatcher itself (`src/extraction/stage6-dispatchers-soi.js`) — corrected ctx access:

```js
export function dispatchLookupInspectionItem(call, ctx) {
  const itemRef = call.input?.item_ref;
  let body, isError = false;

  if (typeof itemRef !== 'string' || !/^[0-9]+(?:\.[0-9]+)+$/.test(itemRef)) {
    body = { error: 'invalid_item_ref', message: `item_ref must match ^[0-9]+(?:\\.[0-9]+)+$ — got ${JSON.stringify(itemRef)}` };
    isError = true;
  } else if (!SOI_BY_REF[itemRef]) {
    body = { error: 'item_not_found', message: `No SoI item at ${itemRef}` };
    isError = true;
  } else {
    body = { item_ref: itemRef, text: SOI_BY_REF[itemRef] };
  }

  logger.info('stage6.lookup_inspection_item', {
    sessionId: ctx?.session?.sessionId,  // v6: corrected
    turnId: ctx?.turnId,
    item_ref: itemRef,
    is_error: isError,
  });

  return {
    tool_use_id: call.tool_call_id,
    content: JSON.stringify(body),
    is_error: isError,
  };
}
```

### 3.5 Module-init constant split + tests (v6)

Constructor + `applyModeChange` (carried from v5 §3.5 — no changes; the helper `_selectSystemPrompt` correctly receives both `toolCallsMode` and `soiToolEnabled`).

**Implementation checklist additions:**

- `grep -rn EICR_AGENTIC_SYSTEM_PROMPT src/` to enumerate every caller of the alias.
- For each test that asserts identity against the alias: verify the test's session is constructed with `soiToolEnabled: false` (default) OR update the test to use the explicit `EICR_AGENTIC_SYSTEM_PROMPT_FULL_SOI` / `_DIRECTORY` variant.
- New tests under `eicr-extraction-session-apply-mode-change.test.js`:
  - `applyModeChange` from `'live'` → `'off'` with `soiToolEnabled: true` → asserts `systemPrompt === EICR_SYSTEM_PROMPT` (off-mode wins).
  - `applyModeChange` from `'off'` → `'live'` with `soiToolEnabled: true` → asserts `systemPrompt === EICR_AGENTIC_SYSTEM_PROMPT_DIRECTORY`.
  - `applyModeChange` from `'off'` → `'live'` with `soiToolEnabled: false` → asserts `systemPrompt === EICR_AGENTIC_SYSTEM_PROMPT_FULL_SOI`.

---

## 6. Reviewer audit trail (v6)

- [x] PLAN.md (v1) — Claude self-review → v2 (4 BLOCKERs resolved)
- [x] PLAN_v2.md — Codex review → v3 (8 BLOCKERs resolved)
- [x] PLAN_v3.md — Claude self-review → v4 (4 BLOCKERs resolved)
- [x] PLAN_v4.md — Codex review → v5 (4 BLOCKERs resolved)
- [x] PLAN_v5.md — Claude review → v6 (this file): 1 BLOCKER, 4 IMPORTANT, 5 MINOR resolved
- [ ] PLAN_v6.md — final Codex pass (next)

Convergence: v5 → v6 closed the last BLOCKER + 4 IMPORTANTs + 5 MINORs. Expectation for the v6 Codex review: 0 BLOCKERs, possibly a few MINORs. If achieved, the plan ships.
