# Extraction-bypass sprint v5 — corrections from Codex v4 review

**Date:** 2026-05-28
**Iteration:** v5 (folds 4 BLOCKERs + 6 IMPORTANTs + 3 MINORs from `codex-review-v4.md`)
**Sprint scope:** 3 phases, **5–7 days** end-to-end
**Branches:** `regex-bypass-backend`, `regex-bypass-ios`, `soi-tool-lookup`, `observation-tts-bridge`

This file is a delta on PLAN_v4 — only the corrected sections are shown. Read v4 for unchanged sections (cost model §1, Phase C §4, sequencing §5, fork §5.1).

## 0. v4 → v5 changelog

| # | v4 problem | v5 fix |
|---|---|---|
| BLOCKER 1 | iOS type is `RegexMatchResult` not `MatchResult`; `thisTurnRegexWrites` doesn't insert keys for the 5 fast-eligible circuit fields (only ocpd/rcd hints are inserted) — so the summary can't emit them no matter what. | iOS PR now does TWO things: (a) thread `result: RegexMatchResult?` through to `buildRegexSummary`, (b) insert `circuit.<ref>.{zs,r1r2,irLE,irLL,points}` into `thisTurnRegexWrites` whenever the corresponding `RegexMatchResult.CircuitUpdates` property is non-nil. See §2.0a (revised). |
| BLOCKER 2 | `_mergeIncomingJobStateIntoSnapshot` has no `installationDetails` branch. v4 builds one and it'd silently drop. | TWO changes: (a) `_mergeIncomingJobStateIntoSnapshot` gains an `installationDetails` branch that writes into `stateSnapshot.circuits[0]` (the existing supply-bucket convention). (b) `buildJobStateFromRegexHits` keeps `installationDetails` shape; the merge handles it. |
| BLOCKER 3 | `makeTool({input_schema})` is wrong — helper builds the schema from `properties`+`required`. Plus TOOL_SCHEMAS / BASE_TOOL_SCHEMAS export order is TDZ-broken. | Use `makeTool({name, description, properties, required})`. Reorder exports so BASE_TOOL_SCHEMAS is defined first, then `buildToolSchemas`, then `TOOL_SCHEMAS`. See §3.3 (revised). |
| BLOCKER 4 | Dispatcher signature wrong — must be `(call, ctx) → envelope`, registered in `WRITE_DISPATCHERS` map. | Rewritten `dispatchLookupInspectionItem(call, ctx)` returns `{tool_use_id, content: JSON.stringify(body), is_error}`. Registered in `stage6-dispatchers.js` `WRITE_DISPATCHERS`. See §3.4 (revised). |
| IMPORTANT 1 | Bypass should run AFTER the existing regex-result normalisation block, not on raw `msg.regexResults`. | Bypass insertion moves to AFTER line ~3500 (post the `regexResults` resolution at 3488-3500), reads the local `regexResults`, not `msg.regexResults`. |
| IMPORTANT 2 | `hasPendingAsk` should read `entry.pendingAsks`, not `session.askedQuestions`. | Defined as `entry.pendingAsks && entry.pendingAsks.size > 0`. |
| IMPORTANT 3 | `msg.client_version` doesn't exist on transcript frames; build version arrives via `session_start.capabilities`. | iOS PR adds an explicit `clientBuildVersion` field to `session_start` payload (alongside existing `protocol_version`, `capabilities.voice_latency`). Backend stores it on `entry.clientBuildVersion` per `sonnet-stream.js:2521-2534` pattern. Bypass logs read `entry.clientBuildVersion`. |
| IMPORTANT 4 | Canonical field name examples wrong: `ze` should be `earth_loop_impedance_ze`; iOS sends `board.zeAtDb` without `<id>`. | Canonical map values use exact `config/field_schema.json` keys (`earth_loop_impedance_ze`, `prospective_fault_current`, etc). For board regex hits, iOS includes the current `boardId` in the summary entry alongside the key — server normalises both into a single canonical hit. |
| IMPORTANT 5 | JSON config can't have `//` comments; `JSON.parse` will throw. | Strict JSON. Documentation lives in a sibling `.md` file or in the `_documentation` key (string value, no `//` syntax). Also: parity script needs a stable Swift surface — iOS PR adds a `RegexFieldNormaliser.swift` whose switch statements are the parity target. |
| IMPORTANT 6 | Constant split must also update `applyModeChange` at `:1192-1243` + existing tests that assert `EICR_AGENTIC_SYSTEM_PROMPT` identity. | `applyModeChange` rederives `this.systemPrompt` using the same ternary the constructor uses, BUT now passing `this.soiToolEnabled` (latched at construction) into the selection. Tests updated to assert both `EICR_AGENTIC_SYSTEM_PROMPT_FULL_SOI` and `EICR_AGENTIC_SYSTEM_PROMPT_DIRECTORY` identities under their respective flags. |
| MINOR 1 | (informational note) `originalTranscriptText` + `stampSeenTranscript()` reuse are correctly implementable. | Noted. No fix needed. |
| MINOR 2 | SoI anchor isn't "lines starting with 4.5 " — actual file uses `- N.M — text` bullets with three-level refs (`1.1.1`, `5.12.1`) and zero-padded refs (`7.02`). | Parser specification updated: scan markdown bullet lines matching `^- (\d+(?:\.\d+)+) [—-]\s*(.*)` (or the actual delimiter pattern post-verification). Preserve refs as strings to keep `7.02 ≠ 7.2`. |
| MINOR 3 | Tool schema `item_ref` regex `^[0-9]+\.[0-9]+$` is too narrow for three-level refs. | Updated to `^[0-9]+(?:\.[0-9]+)+$`. |

---

## 2. Phase A — revised sections

### 2.0a iOS wire-shape upgrade (v5)

`TranscriptProcessor.buildRegexSummary` signature:

```swift
func buildRegexSummary(
    writtenKeys: Set<String>,
    job: JobDetail?,
    matchResult: RegexMatchResult?    // v5: correct type name
) -> [[String: Any]]? {
    guard !writtenKeys.isEmpty else { return nil }
    return writtenKeys.compactMap { key -> [String: Any]? in
        guard let normalised = normaliseRegexKey(key, job: job, matchResult: matchResult) else { return nil }
        var entry: [String: Any] = [
            "field": normalised.canonicalField,
            "value": normalised.value,
        ]
        switch normalised.scope {
        case .circuit:      entry["circuit"] = normalised.circuit
        case .board:        entry["board_id"] = normalised.boardId
        case .supply, .installation: break
        }
        return entry
    }
}
```

`applyRegexMatches` updates (`DeepgramRecordingViewModel.swift:4047-4072`) — ALSO insert the 5 fast-eligible keys into `thisTurnRegexWrites`:

```swift
// In the circuit regex-hint loop, after the existing ocpd/rcd inserts:
if let cu = result.circuitUpdates[circuitRef] {
    if cu.measuredZsOhm != nil      { thisTurnRegexWrites.insert("circuit.\(circuitRef).zs") }
    if cu.r1R2Ohm != nil            { thisTurnRegexWrites.insert("circuit.\(circuitRef).r1r2") }
    if cu.irLiveEarthMohm != nil    { thisTurnRegexWrites.insert("circuit.\(circuitRef).irLE") }
    if cu.irLiveLiveMohm != nil     { thisTurnRegexWrites.insert("circuit.\(circuitRef).irLL") }
    if cu.numberOfPoints != nil     { thisTurnRegexWrites.insert("circuit.\(circuitRef).points") }
}
```

Without those inserts, `writtenKeys` never contains the bypass-eligible keys and bypass rate stays at 0. **BLOCKER 1 fix is in BOTH halves.**

`normaliseRegexKey` resolves value from the right source:

```swift
func normaliseRegexKey(_ key: String, job: JobDetail?, matchResult: RegexMatchResult?) -> NormalisedHit? {
    // Circuit-scoped: read from matchResult.circuitUpdates
    if let m = circuitKeyPattern.firstMatch(in: key) {
        let ref = Int(m.captureGroup(1))!
        let field = m.captureGroup(2)
        guard let cu = matchResult?.circuitUpdates[ref] else { return nil }
        switch field {
        case "zs":     guard let v = cu.measuredZsOhm     else { return nil }; return .circuit(ref: ref, field: "measured_zs_ohm",   value: v)
        case "r1r2":   guard let v = cu.r1R2Ohm           else { return nil }; return .circuit(ref: ref, field: "r1_r2_ohm",         value: v)
        case "irLE":   guard let v = cu.irLiveEarthMohm   else { return nil }; return .circuit(ref: ref, field: "ir_live_earth_mohm", value: v)
        case "irLL":   guard let v = cu.irLiveLiveMohm    else { return nil }; return .circuit(ref: ref, field: "ir_live_live_mohm",  value: v)
        case "points": guard let v = cu.numberOfPoints    else { return nil }; return .circuit(ref: ref, field: "number_of_points",   value: v)
        default: return nil
        }
    }
    // Supply / board / installation: read from job
    // ... canonical names match config/field_schema.json exactly ...
}
```

### 2.0b Canonical config (v5 — strict JSON, real field names)

`config/regex-field-normalisation.json` — strict JSON, no comments, exact field_schema key names:

```json
{
  "_documentation_url": "See sibling docs/regex-field-normalisation.md for context.",
  "entries": [
    { "fieldSourceKey": "supply.ze",            "canonicalField": "earth_loop_impedance_ze",    "scope": "supply" },
    { "fieldSourceKey": "supply.pfc",           "canonicalField": "prospective_fault_current",  "scope": "supply" },
    { "fieldSourceKey": "supply.polarity",      "canonicalField": "supply_polarity_confirmed",  "scope": "supply" },
    { "fieldSourceKey": "circuit.<ref>.zs",     "canonicalField": "measured_zs_ohm",            "scope": "circuit" },
    { "fieldSourceKey": "circuit.<ref>.r1r2",   "canonicalField": "r1_r2_ohm",                  "scope": "circuit" },
    { "fieldSourceKey": "circuit.<ref>.irLE",   "canonicalField": "ir_live_earth_mohm",         "scope": "circuit" },
    { "fieldSourceKey": "circuit.<ref>.irLL",   "canonicalField": "ir_live_live_mohm",          "scope": "circuit" },
    { "fieldSourceKey": "circuit.<ref>.points", "canonicalField": "number_of_points",           "scope": "circuit" },
    { "fieldSourceKey": "board.zeAtDb",         "canonicalField": "ze_at_db",                   "scope": "board" },
    { "fieldSourceKey": "install.postcode",     "canonicalField": "postcode",                   "scope": "installation" }
  ]
}
```

iOS includes current `boardId` in board-scoped summary entries (resolved from `currentBoardId` on the session). Backend joins.

iOS parity surface: new `CertMateUnified/Sources/Processing/RegexFieldNormaliser.swift` with switch statements that mirror the JSON map 1:1. Parity script parses this file the same way `check-ios-field-parity.mjs` parses `applySonnetReadings`.

### 2.0c Bypass insertion point (v5 — after regex-result normalisation)

In `sonnet-stream.handleTranscript`:

```js
// (existing) lines 3258-3500
//   - msg.text -> transcriptText
//   - in_response_to context prepend
//   - script processors (ring continuity, IR, OCPD)
//   - timeout note prepending
//   - regex-result normalisation block at 3488-3500: `let regexResults = ...`

// NEW — bypass insertion (after line ~3500, before runShadowHarness call)
const bypassMode = entry.session.regexBypassMode;  // 'off' | 'shadow' | 'live'
if (bypassMode !== 'off') {
  const originalTranscriptText = msg.text;  // captured EARLIER, before script prepends
  const pendingAsk = entry.pendingAsks && entry.pendingAsks.size > 0;

  const verdict = shouldBypassSonnet({
    transcriptText,
    originalTranscriptText,
    regexResults,           // local, post-normalisation
    pendingAsk,
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
    // Fall through.
  } else if (verdict.bypass) {
    const jobStatePayload = buildJobStateFromRegexHits(regexResults);
    entry.session._mergeIncomingJobStateIntoSnapshot(jobStatePayload);
    stampSeenTranscript();   // EXISTING closure in scope
    logger.info('voice_latency.bypass.applied', {
      sessionId,
      reason: verdict.reason,
      iosBuildVersion: entry.clientBuildVersion ?? null,
      regexFields: regexResults.map((r) => r.field),
      sonnet_calls_avoided: 1,
    });
    return;  // Treat as committed; finally drains queue.
  }
}

// (existing) runShadowHarness call
```

`originalTranscriptText` is captured at line 3258 (`let transcriptText = msg.text`) — add `const originalTranscriptText = msg.text;` immediately below.

### 2.0d `_mergeIncomingJobStateIntoSnapshot` extension (BLOCKER 2)

`src/extraction/eicr-extraction-session.js:1760-1802` — add an `installationDetails` branch:

```js
_mergeIncomingJobStateIntoSnapshot(jobState) {
  if (!jobState || typeof jobState !== 'object') return;

  // ... existing CIRCUITS branch ...
  // ... existing SUPPLY branch ...
  // ... existing BOARDS branch ...

  // NEW — INSTALLATION DETAILS (lives in stateSnapshot.circuits[0] per
  // the existing supply-bucket convention shared with `record_board_reading`
  // and Stage 6 mutators).
  if (jobState.installationDetails && typeof jobState.installationDetails === 'object') {
    const target = this.stateSnapshot.circuits[0] || (this.stateSnapshot.circuits[0] = {});
    this._mergeCircuitOrBoardFields(target, jobState.installationDetails);
  }
}
```

### 2.0e `buildJobStateFromRegexHits` (v5)

```js
import { getScope } from './regex-field-normalisation.js';

export function buildJobStateFromRegexHits(hits) {
  const jobState = { circuits: [], supply: {}, boards: [], installationDetails: {} };
  const circuitBuckets = new Map();
  const boardBuckets = new Map();

  for (const h of hits || []) {
    if (!h || typeof h.field !== 'string' || h.value == null) continue;
    const scope = getScope(h.field);  // lookup by canonical name
    switch (scope) {
      case 'supply':
        jobState.supply[h.field] = h.value;
        break;
      case 'installation':
        jobState.installationDetails[h.field] = h.value;
        break;
      case 'circuit':
        if (h.circuit == null) break;
        let row = circuitBuckets.get(h.circuit);
        if (!row) {
          row = { ref: h.circuit };
          circuitBuckets.set(h.circuit, row);
          jobState.circuits.push(row);
        }
        row[h.field] = h.value;
        break;
      case 'board':
        if (h.board_id == null) break;
        let b = boardBuckets.get(h.board_id);
        if (!b) {
          b = { id: h.board_id };
          boardBuckets.set(h.board_id, b);
          jobState.boards.push(b);
        }
        b[h.field] = h.value;
        break;
    }
  }
  return jobState;
}
```

### 2.0f Session-handshake build version (IMPORTANT 3)

iOS `ServerWebSocketService.swift:507-558` — `session_start` payload gains:

```swift
let payload: [String: Any] = [
    "type": "session_start",
    "protocol_version": ...,
    "client_build_version": Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "unknown",
    "capabilities": [ ... existing ... ],
    ...
]
```

Backend `sonnet-stream.js:2521-2534` — capture into `entry.clientBuildVersion`:

```js
if (typeof msg.client_build_version === 'string') {
  entry.clientBuildVersion = msg.client_build_version;
}
```

### 2.1 Eligibility rules (v5 final)

1. `regexResults` (post-normalisation) is non-empty AND every entry has `value` populated.
2. At least one entry's `field` is in `REGEX_FAST_ELIGIBLE_FIELDS` (`regex-fast-eligibility.js:47-55`).
3. No observation trigger from `config/observation-triggers.json` in `originalTranscriptText`.
4. No correction lead-in in `originalTranscriptText`.
5. No question lead-in in `originalTranscriptText`.
6. `!pendingAsk && !inResponseTo`.
7. `transcriptText === originalTranscriptText` (no script processor or timeout note modified it — single replacement for the chitchat-pause + dialogue-script + partial-fill-timeout checks).
8. No `start_dialogue_script` pattern keyword in transcript.

---

## 3. Phase B — revised sections

### 3.3 Tool schema (v5 — correct `makeTool` + export order)

`src/extraction/stage6-tool-schemas.js`:

```js
// Define lookup_inspection_item via the existing makeTool helper.
const lookupInspectionItem = makeTool({
  name: 'lookup_inspection_item',
  description: 'Retrieve the verbatim BS 7671 Schedule of Inspection item text for a given item reference. Use this BEFORE emitting an observation\'s `schedule_item` and `regulation` fields when the compact directory text in the system prompt isn\'t enough to confidently attribute the observation. For common observations (cover damage, missing labels, etc.) the directory line is usually sufficient — do NOT call this tool for those. Call only when the directory entry is ambiguous or you need the verbatim regulation text.',
  properties: {
    item_ref: {
      type: 'string',
      description: 'BS 7671 Schedule of Inspection item reference, e.g. "4.5", "1.1.1", "5.12.1", or "7.02". Preserve leading zeros and dot count as given in the directory.',
      pattern: '^[0-9]+(?:\\.[0-9]+)+$',  // v5: widened for 3-level refs
    },
  },
  required: ['item_ref'],
});

// PRIVATE base array — declared BEFORE buildToolSchemas / TOOL_SCHEMAS to avoid TDZ.
const _BASE_TOOL_SCHEMAS_ARRAY = Object.freeze([
  recordReading, clearReading, createCircuit, renameCircuit,
  recordBoardReading, askUser, startDialogueScript, addBoard, /* etc — current 8 */
]);

export const BASE_TOOL_SCHEMAS = _BASE_TOOL_SCHEMAS_ARRAY;

export function buildToolSchemas({ soiToolEnabled }) {
  const tools = [..._BASE_TOOL_SCHEMAS_ARRAY];
  if (soiToolEnabled) tools.push(lookupInspectionItem);
  return tools;
}

// Backwards-compat: legacy callers that don't pass a session can still
// import the default-off bundle.
export const TOOL_SCHEMAS = buildToolSchemas({ soiToolEnabled: false });
```

### 3.4 Dispatcher (v5 — `(call, ctx) → envelope`)

New file `src/extraction/stage6-dispatchers-soi.js`:

```js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import logger from '../logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const FULL_SOI_TEXT = fs.readFileSync(
  path.join(__dirname, '..', '..', 'config', 'prompts', 'schedule-of-inspection-bs7671-eicr.md'),
  'utf8'
);
const SOI_BY_REF = parseSoiByRef(FULL_SOI_TEXT);

/**
 * Dispatcher for the lookup_inspection_item tool.
 * Matches the (call, ctx) -> envelope contract used by every other
 * Stage 6 dispatcher (see stage6-dispatchers-circuit.js:82-89).
 */
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
    sessionId: ctx?.sessionId,
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

function parseSoiByRef(raw) {
  // Real file uses markdown bullets "- N.M — text" with 1–3 level refs
  // (e.g. 1.1.1, 5.12.1, 7.02). Preserve refs as strings.
  const out = {};
  const re = /^- (\d+(?:\.\d+)+)\s*[—-]\s*(.*)$/;
  let currentRef = null;
  let currentBuf = [];
  for (const line of raw.split('\n')) {
    const m = line.match(re);
    if (m) {
      if (currentRef) out[currentRef] = currentBuf.join('\n').trim();
      currentRef = m[1];
      currentBuf = [line];
    } else if (currentRef) {
      currentBuf.push(line);
    }
  }
  if (currentRef) out[currentRef] = currentBuf.join('\n').trim();
  return out;
}
```

Registered in `src/extraction/stage6-dispatchers.js`:

```js
import { dispatchLookupInspectionItem } from './stage6-dispatchers-soi.js';

const WRITE_DISPATCHERS = {
  record_reading: dispatchRecordReading,
  // ... existing ...
  lookup_inspection_item: dispatchLookupInspectionItem,  // NEW
};
```

### 3.5 Module-init constant split + `applyModeChange` (v5 — BLOCKER 4 + IMPORTANT 6)

`src/extraction/eicr-extraction-session.js`:

```js
// Module-init (around line 891-900):
const _AGENTIC_BASE_PROMPT = fssync.readFileSync(/* ... */);
const _SCHEDULE_OF_INSPECTION_EICR = fssync.readFileSync(/* ... */);
const _SCHEDULE_OF_INSPECTION_DIRECTORY = fssync.readFileSync(
  path.join(__dirname, '..', '..', 'config', 'prompts', 'schedule-of-inspection-directory.md'),
  'utf8'
);

export const EICR_AGENTIC_SYSTEM_PROMPT_FULL_SOI =
  _AGENTIC_BASE_PROMPT.trimEnd() + '\n\n' + _SCHEDULE_OF_INSPECTION_EICR;
export const EICR_AGENTIC_SYSTEM_PROMPT_DIRECTORY =
  _AGENTIC_BASE_PROMPT.trimEnd() + '\n\n' + _SCHEDULE_OF_INSPECTION_DIRECTORY;

// Backwards-compatible alias — kept until all callers migrate. Tests
// asserting EICR_AGENTIC_SYSTEM_PROMPT identity continue to work.
export const EICR_AGENTIC_SYSTEM_PROMPT = EICR_AGENTIC_SYSTEM_PROMPT_FULL_SOI;
```

Constructor (around line 944-949):

```js
this.soiToolEnabled = this._resolveSoiToolEnabled(options.soiToolEnabled);
this.systemPrompt = this._selectSystemPrompt(this.toolCallsMode, this.soiToolEnabled, certType);
this.toolSchemas = buildToolSchemas({ soiToolEnabled: this.soiToolEnabled });

// New helper, used by constructor AND applyModeChange — single source of truth.
_selectSystemPrompt(mode, soiToolEnabled, certType) {
  if (mode === 'off') {
    return certType === 'eic' ? EIC_SYSTEM_PROMPT : EICR_SYSTEM_PROMPT;
  }
  return soiToolEnabled ? EICR_AGENTIC_SYSTEM_PROMPT_DIRECTORY : EICR_AGENTIC_SYSTEM_PROMPT_FULL_SOI;
}
```

`applyModeChange` (lines 1192-1243) — rederive using the same helper:

```js
applyModeChange(newMode) {
  // ... existing pre-checks ...
  this.toolCallsMode = newMode;
  // v5: use _selectSystemPrompt to honour the latched soiToolEnabled.
  this.systemPrompt = this._selectSystemPrompt(newMode, this.soiToolEnabled, this.certType);
  // toolSchemas latched at construction — does NOT change with mode flip
  // (Stage 6 vs legacy off-mode use the same tool registry).
}
```

Tests at `eicr-extraction-session-apply-mode-change.test.js:69-144` and `snapshot-refactor.test.js:85-151` need updating to assert the directory/full variant identity based on the test session's `soiToolEnabled`.

---

## 6. Reviewer audit trail (v5)

- [x] PLAN.md (v1) — Claude self-review → v2
- [x] PLAN_v2.md — Codex review → v3
- [x] PLAN_v3.md — Claude self-review → v4
- [x] PLAN_v4.md — Codex review: 4 BLOCKERs, 6 IMPORTANTs, 3 MINORs → v5 (this file)
- [ ] PLAN_v5.md — Claude self-review (next)
- [ ] PLAN_v5.md — Codex review
- [ ] Iterate until both reviewers report zero BLOCKERs.

Convergence trajectory: v1 4B → v2 8B → v3 4B → v4 4B. Each pass the BLOCKERs are at finer granularity. v5 names every code symbol and shape from the actual source. Expect the next review to find primarily MINORs.
