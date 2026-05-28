# Codex review v6 — extraction-bypass PLAN_v6.md

## Verdict
SHIPPABLE
0 BLOCKERs, 1 IMPORTANT, 2 MINOR

v6 closes the v5 BLOCKER and all four v5 IMPORTANTs in substance. The remaining issue is not architectural: §3.4's dispatcher idea is correct, but the shown `createToolDispatcher` code does not match the current higher-order factory shape and would need to be implemented against the real `createToolDispatcher(writes, asks)` signature.

Convergence is real. The plan is now implementation-ready as long as the dispatcher patch follows the current barrel contract instead of copying the pseudo-snippet literally.

## Fix Verification

### 1. BLOCKER fix — 16-tool schema list is correct

Verified against `src/extraction/stage6-tool-schemas.js:1009-1037`. v6 §3.3 lists the same 16 tools in the same order:

```
recordReading
clearReading
createCircuit
renameCircuit
recordObservation
deleteObservation
askUser
recordBoardReading
startDialogueScript
deleteCircuit
calculateZs
calculateR1PlusR2
setFieldForAllCircuits
addBoard
selectBoard
markDistributionCircuit
```

This fixes the v5 literal-list BLOCKER. `lookupInspectionItem` appended conditionally after this base array is the right shape.

### 2. IMPORTANT 1 — Swift circuitUpdates key + property names are correct

Verified `RegexMatchResult.circuitUpdates` is `[String: CircuitUpdates]` at `CertMateUnified/Sources/Recording/TranscriptFieldMatcher.swift:21`. v6's String lookup is correct.

The five property names in v6 are also correct:

- `measuredZsOhm` at `TranscriptFieldMatcher.swift:70`
- `r1R2Ohm` at `TranscriptFieldMatcher.swift:71`
- `irLiveEarthMohm` at `TranscriptFieldMatcher.swift:75`
- `irLiveLiveMohm` at `TranscriptFieldMatcher.swift:76`
- `numberOfPoints` at `TranscriptFieldMatcher.swift:86`

### 3. IMPORTANT 2 — bypass insertion point is correct

Verified `sonnet-stream.js`:

- Regex result normalisation ends at `src/extraction/sonnet-stream.js:3488-3500`.
- Overtake classifier block starts at `3545` and ends at `3764`.
- `runShadowHarness` starts at `3766`.

v6's instruction to insert bypass immediately before `runShadowHarness`, after the classifier block, is correct.

### 4. IMPORTANT 3 — originalTranscriptText capture site is correct

Verified `src/extraction/sonnet-stream.js:3258` is:

```js
let transcriptText = msg.text;
```

Adding `const originalTranscriptText = msg.text;` immediately below this line captures pre-mutation text before `in_response_to`, script processors, and timeout notes can alter `transcriptText`.

### 5. IMPORTANT 4 — READ_DISPATCHERS concept is correct, but snippet shape needs correction

The proposed read-tool separation is the right design. `lookup_inspection_item` should not be registered in `WRITE_DISPATCHERS`, because the current write dispatcher increments a write-round counter and all write names feed `WRITE_TOOL_NAMES` / write ordering.

The envelope shape v6 shows is correct and matches existing dispatchers:

```js
{ tool_use_id, content: JSON.stringify(body), is_error }
```

Existing circuit/board/observation/script/ask dispatchers all return that shape.

The branch order is also behaviorally fine: READ first, then WRITE, then `ask_user`, then unknown. `ask_user` is not in `WRITE_DISPATCHERS`, so WRITE-before-ASK does not change current behavior.

## Findings

### IMPORTANT 1 — §3.4's `createToolDispatcher` snippet does not match the real factory signature

**File:** `PLAN_v6.md` §3.4  
**Severity:** IMPORTANT — copy-pasting the snippet would not build, but the intended fix is small.

The actual function is:

```js
export function createToolDispatcher(writes, asks) {
  return async function dispatchTool(call, ctx) {
    if (call.name === 'ask_user') return asks(call, ctx);
    if (WRITE_TOOL_NAMES.has(call.name)) return writes(call, ctx);
    return { ...unknown_tool... };
  };
}
```

v6 shows:

```js
async function createToolDispatcher(call, ctx) {
  if (READ_DISPATCHERS[call.name]) return READ_DISPATCHERS[call.name](call, ctx);
  if (WRITE_DISPATCHERS[call.name]) return createWriteDispatcher(call, ctx);
  if (call.name === 'ask_user') return dispatchAskUser(call, ctx);
}
```

That snippet confuses the composer with the per-call dispatch closure. It also calls `createWriteDispatcher(call, ctx)`, but the real write path is the already-created `writes` closure passed into `createToolDispatcher`.

Correct implementation should keep the higher-order shape:

```js
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

This preserves the current `stage6-shadow-harness.js` callers, which construct `writes` and `asks` separately and then call `createToolDispatcher(writes, asks)`.

### MINOR 1 — `_mergeIncomingJobStateIntoSnapshot` extension is correctly ordered; comment should name fact-vs-reading precedence

Verified current branch order in `src/extraction/eicr-extraction-session.js:1763-1801` is CIRCUITS, SUPPLY, BOARDS. Adding INSTALLATION_DETAILS last matches v6.

`_mergeCircuitOrBoardFields` does enforce empty-fill-only semantics for readings (`1827-1833`) and unconditional overwrite for fields in `FACT_FIELDS` (`1824-1826`). So the v6 precedence claim is accurate, with one nuance: installation fields that are classified as FACTS overwrite, while unknown/non-fact installation fields only fill empties. That is consistent with the existing merge contract; the implementation comment should avoid implying every installation field is empty-fill-only.

### MINOR 2 — iOS Option A cache needs stale-result hygiene

The three iOS sites are correctly identified:

- `TranscriptProcessor.buildRegexSummary` is at `TranscriptProcessor.swift:199`.
- `DeepgramRecordingViewModel.buildRegexSummary` wrapper is at `DeepgramRecordingViewModel.swift:2312-2314`.
- The `applyRegexMatches` circuit-hint loop is at `DeepgramRecordingViewModel.swift:4047-4072`.

v6's added inserts for the five fast-eligible keys are necessary and in the right loop.

If the implementation chooses Option A (`lastRegexResult` cached on the VM), clear or replace that cache at the top of each `applyRegexMatches()` pass before early returns. Today `applyRegexMatches()` can return false at `3764` or `3803`; stale cache is mostly masked by `thisTurnRegexWrites` being empty, but clearing the cache makes the per-turn lifecycle explicit and prevents future wrapper changes from reading an old result.

## Cost Model

v6's revised `$0.01-$0.03/session` Phase A saving is realistic, and possibly still a little generous, given the constraints:

- The whitelist is only five circuit fields.
- IR/ring/protective-device scripted turns often already avoid or alter the normal Sonnet path.
- Eligibility rule #7 rejects any turn whose transcript was modified by server notes or script processors.
- `!pendingAsk && !inResponseTo` removes the most ambiguity-prone follow-up turns.

The plan is honest now: this is primarily mechanism-establishment and future-whitelist scaffolding, not meaningful near-term cost reduction.

## New Issues / Edge Cases

No new BLOCKERs found.

The only implementation-risk edge case is the dispatcher snippet shape above. Everything else is a straightforward patch against verified source locations.

One-line summary: v6 is shippable; implement the READ dispatcher inside the existing `createToolDispatcher(writes, asks)` closure shape, not as the pseudo-signature shown in §3.4.
