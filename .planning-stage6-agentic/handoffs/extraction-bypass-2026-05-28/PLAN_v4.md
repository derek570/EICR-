# Extraction-bypass sprint v4 — corrections from Claude review v3

**Date:** 2026-05-28
**Iteration:** v4 (folds 4 BLOCKERs + 4 IMPORTANTs + 3 MINORs from `claude-review-v3.md`)
**Sprint scope:** 3 phases, **5–7 days** end-to-end
**Branches:** `regex-bypass-backend`, `regex-bypass-ios`, `soi-tool-lookup`, `observation-tts-bridge`

## 0. v3 → v4 changelog

v3 had the right architecture but used invented or wrong code symbol names. v4 grounds every reference against the actual source.

| # | v3 problem | v4 fix |
|---|---|---|
| BLOCKER 1 | Shared-types path doesn't exist as v3 described. `packages/shared-types` is types-only; iOS does NOT consume shared-types. Existing parity pattern uses `config/*.json` at repo root + `scripts/check-ios-field-parity.mjs`. | v4 uses the existing pattern: canonical maps live at `config/regex-field-normalisation.json` + `config/observation-triggers.json`. Backend loads via `JSON.parse(fs.readFileSync(...))` at module init. iOS bundles a copy at build time. New parity scripts `scripts/check-ios-regex-normaliser-parity.mjs` + `scripts/check-ios-observation-trigger-parity.mjs` mirror the field-schema audit. |
| BLOCKER 2 | iOS `applyRegexMatches` deliberately does NOT persist circuit-level regex values to `job` — comment block explicitly chose this (DeepgramRecordingViewModel.swift:4047-4072). `readValueFromFieldSources` cannot return values for `circuit.<ref>.<field>` keys. | iOS change reads values directly from `result.circuitUpdates` (the in-memory MatchResult inside `applyRegexMatches`) and threads them through to `buildRegexSummary`. Smaller change than refactoring the regex persistence contract. New signature: `buildRegexSummary(writtenKeys, job, matchResult)`. |
| BLOCKER 3 | v3 dedupe-stamping snippet used wrong field names + wrong shapes. Existing `stampSeenTranscript()` closure at `sonnet-stream.js:3143-3179` is the canonical helper. | v4 bypass calls the existing `stampSeenTranscript()` closure directly — it's in scope at the bypass insertion point. No wrong-shape inlining. |
| BLOCKER 4 | `LOOKUP_INSPECTION_ITEM_TOOL` referenced but undefined; `_buildSystemPrompt` referenced but doesn't exist on `EICRExtractionSession`; SoI is concatenated at module load into `EICR_AGENTIC_SYSTEM_PROMPT` constant (`:899-900`). Phase B unbuildable as written. | v4 includes the full tool schema in §3.3 + adds a `lookup_inspection_item` dispatcher (§3.4). v4 SPLITS the module-init constants: `_AGENTIC_BASE_PROMPT` stays as-is; new `_SCHEDULE_OF_INSPECTION_DIRECTORY` constant alongside `_SCHEDULE_OF_INSPECTION_EICR`. Constructor selects which SoI variant to concatenate based on `soiToolEnabled`. No "lazy" hand-wave. |
| IMPORTANT 1 | v3 invented `entry.activeScript` and `entry.pendingTimeoutNote`. Actual names are `session.ringContinuityScript`, `session.insulationResistanceScript`, `session.protectiveDeviceScript`. Timeout notes constructed inline (not held in a session field). | v4 inserts bypass AFTER the timeout-note-prepend step at ~`sonnet-stream.js:3467`, then compares `transcriptText !== originalTranscriptText` to detect "a script processor modified the transcript" → if true, no bypass. Single check; mirrors v3's intent without inventing fields. |
| IMPORTANT 2 | `regex-fast-eligibility.js` whitelist is only 5 fields (`measured_zs_ohm`, `r1_r2_ohm`, `ir_live_earth_mohm`, `ir_live_live_mohm`, `number_of_points`). All circuit-scoped. v3's "30–50% of turns" estimate was overstated. | v4 lowers Phase A saving estimate to **$0.02–$0.06/session, mid-range $0.03–$0.04**. Combined sprint total drops to $0.03–$0.10/session. Honest reframing in §1: "Phase A is small absolute saving but establishes the bypass mechanism — future whitelist expansion (and the IOS regex optimiser's continued growth) inherits the bypass without re-engineering." |
| IMPORTANT 3 | TestFlight propagation creates a multi-day window where most devices ship old iOS shape; canary readout dominated by old-iOS sessions where bypass=0 by construction. | v4 §2.7 adds: bypass log lines now stamp `iosBuildVersion`. Canary criteria pin readout window to **≥ 3 sessions from devices on the new iOS build**, not just calendar days. Tied to "minimum new-iOS sample size" gate. |
| IMPORTANT 4 | Phase B `_buildSystemPrompt` lazy claim hand-waved. | Fixed alongside BLOCKER 4 — concrete module-init constant split + constructor selection. No runtime lazy needed. Hot-flip requires service redeploy; explicit in §3.5. |
| MINOR 1 | `buildJobStateFromRegexHits` referenced `h.fieldSourceKey` but wire payload only has `h.field`. | v4 routes scope via the field's canonical name (the canonical name maps 1:1 to a known scope). Single key. |
| MINOR 2 | Pseudocode mixed `entry.*` and `session.*` qualifiers loosely. | v4 pseudocode qualifies all references: `entry.session._mergeIncomingJobStateIntoSnapshot(...)`, `entry.seenTranscriptUtterances`, etc. |
| MINOR 3 | `compareSnapshots` is an undefined helper; canary criterion unbuildable Day-2. | v4 replaces with a concrete proxy: "count of fields populated via bypass (counted via the new bypass log) AND verify each is consistent with the same field as written by Sonnet across a paired session." No new helper required; just CloudWatch Insights querying. |

---

## 1. Updated cost model (v4)

| Component | Phase 1 today | After Phase A | After Phase A+B |
|---|---|---|---|
| Sonnet turns/session | 24 | 21–23 (saving 1–3 turns) | 21–23 |
| Avg tokens read/Sonnet turn | 35,000 | 35,000 | ~32,500 |
| Sonnet total $/session | ~$0.44 | ~$0.38–$0.42 | ~$0.36–$0.40 |
| $ saved vs Phase 1 | — | **$0.02–$0.06** | **$0.04–$0.08** |

**Honest combined saving: $0.03–$0.10/session, mid-range ~$0.05.**

This is roughly 1/3 the size of the original v1 claim. **The case for shipping this sprint is no longer pure $-saving; it's the bypass mechanism establishment.**

Why proceed anyway:
1. The iOS regex optimiser actively grows the whitelist over time (per Derek's note 2026-05-28). Each new whitelist field → automatic bypass coverage with zero further engineering once the mechanism exists.
2. Future whitelist expansion sprints become trivial (~half a day) once the wire-shape + merge + bypass-position machinery is shipped.
3. At commercial launch scale (~100 inspectors × 6 sessions/day = 600/day): $0.03–$0.10/session = **£20–£60/day saved**, not negligible.
4. Phase A's wire-shape upgrade is also a precondition for a future "regex value visible to backend for audit/replay" capability that's been wanted independently.

If $0.03–$0.10/session today doesn't justify 5–7 days, defer Phase A entirely — Phase B + C still ship at smaller scope (1–2 days each). Explicit fork in §6.

---

## 2. Phase A — Skip Sonnet on regex-clean turns (v4)

### 2.0a iOS wire-shape upgrade (v4)

`CertMateUnified/Sources/Recording/TranscriptProcessor.swift` — `buildRegexSummary` signature changes to accept the in-flight `MatchResult`:

```swift
func buildRegexSummary(
    writtenKeys: Set<String>,
    job: JobDetail?,
    matchResult: MatchResult?    // NEW — circuit values readable from this
) -> [[String: Any]]? {
    guard !writtenKeys.isEmpty else { return nil }
    return writtenKeys.compactMap { key -> [String: Any]? in
        guard let (canonicalField, scope, scopeId) = normaliseRegexKey(key) else { return nil }
        guard let value = resolveValue(
            key: key,
            canonicalField: canonicalField,
            scope: scope,
            scopeId: scopeId,
            job: job,
            matchResult: matchResult
        ) else { return nil }
        var entry: [String: Any] = ["field": canonicalField, "value": value]
        if let id = scopeId {
            switch scope {
            case .circuit:  entry["circuit"] = id
            case .board:    entry["board_id"] = id
            case .supply, .installation: break
            }
        }
        return entry
    }
}
```

`resolveValue` reads:
- `circuit.<ref>.<field>` → `matchResult.circuitUpdates[ref].<field>` (the actual value the regex extracted this pass, BEFORE it was thrown away)
- `supply.<field>` → `job.supplyCharacteristics.<field>`
- `board.<id>.<field>` → `job.boards.first(where: {$0.id == id})?.<field>`
- `install.<field>` → `job.installationDetails.<field>`

`normaliseRegexKey` loads the canonical map from the bundled copy of `config/regex-field-normalisation.json` at app launch.

Caller site `applyRegexMatches` passes `result` (the MatchResult) into `buildRegexSummary`:

```swift
// In DeepgramRecordingViewModel.applyRegexMatches around line 4047
let summary = transcriptProcessor.buildRegexSummary(
    writtenKeys: thisTurnRegexWrites,
    job: jobVM?.job,
    matchResult: result   // NEW — pass the in-flight match result
)
```

**Backwards compatibility:** if backend receives a `regexResults` entry without `value`, the bypass eligibility check fails → normal Sonnet round. Old iOS builds keep working with zero bypass.

### 2.0b Canonical maps (v4 — `config/` path)

New file `config/regex-field-normalisation.json`:

```json
{
  "_documentation": "Maps iOS regex field-source keys to backend canonical names and scope. <ref> and <id> are placeholders that iOS substitutes at runtime.",
  "entries": [
    { "fieldSourceKey": "supply.ze",           "canonicalField": "ze",                          "scope": "supply" },
    { "fieldSourceKey": "supply.pfc",          "canonicalField": "pfc",                         "scope": "supply" },
    { "fieldSourceKey": "supply.polarity",     "canonicalField": "supply_polarity_confirmed",   "scope": "supply" },
    { "fieldSourceKey": "circuit.<ref>.zs",    "canonicalField": "measured_zs_ohm",             "scope": "circuit" },
    { "fieldSourceKey": "circuit.<ref>.r1r2",  "canonicalField": "r1_r2_ohm",                   "scope": "circuit" },
    { "fieldSourceKey": "circuit.<ref>.irLe",  "canonicalField": "ir_live_earth_mohm",          "scope": "circuit" },
    { "fieldSourceKey": "circuit.<ref>.irLl",  "canonicalField": "ir_live_live_mohm",           "scope": "circuit" },
    { "fieldSourceKey": "circuit.<ref>.points","canonicalField": "number_of_points",            "scope": "circuit" },
    { "fieldSourceKey": "board.<id>.zeAtDb",   "canonicalField": "ze_at_db",                    "scope": "board" },
    { "fieldSourceKey": "install.postcode",    "canonicalField": "postcode",                    "scope": "installation" }
    // Add more as iOS regex matcher expands — backend picks up new bypass-eligible
    // fields automatically once they appear here AND in regex-fast-eligibility.js.
  ]
}
```

New file `config/observation-triggers.json`:

```json
{
  "_documentation": "Closed lexicon. Lowercase. Lockstep edits with iOS bundled copy.",
  "triggers": [
    "observation","observations","noting","note that",
    "code 1","code 2","code 3","code one","code two","code three",
    "c1","c2","c3",
    "concern","danger","dangerous","hazard","unsafe",
    "broken","damage","damaged","missing","exposed",
    "loose","faulty","defective","cracked","burnt",
    "scorched","melted","corroded"
  ]
}
```

Backend loaders:

```js
// New file: src/extraction/regex-field-normalisation.js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const config = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', '..', 'config', 'regex-field-normalisation.json'), 'utf8')
);

export const REGEX_FIELD_NORMALISATION = Object.freeze(
  Object.fromEntries(config.entries.map((e) => [e.fieldSourceKey, e]))
);

export function getScope(canonicalField) {
  // Linear scan; tiny map (~10 entries).
  return config.entries.find((e) => e.canonicalField === canonicalField)?.scope;
}
```

Same shape for observation-triggers loader.

iOS reads the bundled copy at app launch (similar to existing `field_schema.json` consumption pattern).

CI parity scripts mirror `scripts/check-ios-field-parity.mjs`:
- `scripts/check-ios-regex-normaliser-parity.mjs` — diffs `config/regex-field-normalisation.json` against iOS's bundled copy + the Swift `normaliseRegexKey` switch (extracted via regex over the source file, same pattern as existing field-parity check).
- `scripts/check-ios-observation-trigger-parity.mjs` — diffs `config/observation-triggers.json` against iOS's bundled copy + Swift detector.

### 2.0c Bypass position (v4 — concrete)

Place bypass AFTER all deterministic script processors and AFTER timeout-note construction, BEFORE the `runShadowHarness` call. Use `transcriptText !== originalTranscriptText` as the "script touched this turn" check.

In `sonnet-stream.handleTranscript`:

```js
// (existing lines 3311-3467 — script processors + timeout note prepending)
const originalTranscriptText = msg.text;
// ... existing code mutates transcriptText with ringNote / irNote / pdNote ...

// NEW — bypass insertion (~line 3470, before runShadowHarness call at ~3500)
const bypassMode = REGEX_BYPASS_MODE; // 'off' | 'shadow' | 'live'
if (bypassMode !== 'off') {
  const verdict = shouldBypassSonnet({
    transcriptText,
    originalTranscriptText,
    regexResults: msg.regexResults,
    session: entry.session,
    inResponseTo: msg.in_response_to,
    pendingAskExists: hasPendingAsk(entry),
  });

  if (bypassMode === 'shadow') {
    logger.info('voice_latency.bypass.shadow', {
      sessionId,
      verdict: verdict.bypass,
      reason: verdict.reason,
      iosBuildVersion: msg.client_version ?? null,
      ...
    });
    // Fall through to existing Sonnet path.
  } else if (verdict.bypass) {
    // Apply regex hits to snapshot via the REAL merge function (BLOCKER 5 fix from v2)
    const jobStatePayload = buildJobStateFromRegexHits(msg.regexResults);
    entry.session._mergeIncomingJobStateIntoSnapshot(jobStatePayload);

    // Stamp ledgers via the EXISTING closure (BLOCKER 3 fix)
    stampSeenTranscript();

    logger.info('voice_latency.bypass.applied', {
      sessionId,
      reason: 'regex_clean',
      regexFields: msg.regexResults.map((r) => r.field),
      iosBuildVersion: msg.client_version ?? null,
      sonnet_calls_avoided: 1,
    });
    // Treat as committed turn. queue draining happens in existing finally.
    return;
  }
}

// (existing) runShadowHarness call at ~3500
```

`shouldBypassSonnet` eligibility (v4 final):

1. `regexResults` present AND every entry has `value` (filter against backwards-compat).
2. At least one regex hit has `field` in `regex-fast-eligibility.js`'s `REGEX_FAST_ELIGIBLE_FIELDS` whitelist.
3. No observation-trigger word in `originalTranscriptText` (from `config/observation-triggers.json`).
4. No correction lead-in.
5. No question lead-in.
6. No `pendingAskExists` AND `inResponseTo` is null.
7. `transcriptText === originalTranscriptText` (no script processor or timeout note prepended) — single replacement for the chitchat-pause + dialogue-script + partial-fill-timeout checks v3 split out.
8. No `start_dialogue_script` pattern keyword.

`hasPendingAsk` reads from `session.askedQuestions` (the existing iteration shape — same one used elsewhere in `sonnet-stream.js`).

### 2.0d `buildJobStateFromRegexHits` (v4)

```js
import { getScope } from './regex-field-normalisation.js';

export function buildJobStateFromRegexHits(hits) {
  const jobState = { circuits: [], supply: {}, boards: [], installationDetails: {} };
  const circuitBuckets = new Map();
  const boardBuckets = new Map();

  for (const h of hits || []) {
    if (!h || typeof h.field !== 'string') continue;
    if (h.value == null) continue;  // Backwards-compat: old iOS skips here.

    const scope = getScope(h.field);
    if (scope === 'supply') {
      jobState.supply[h.field] = h.value;
    } else if (scope === 'installation') {
      jobState.installationDetails[h.field] = h.value;
    } else if (scope === 'circuit') {
      if (h.circuit == null) continue;
      let row = circuitBuckets.get(h.circuit);
      if (!row) {
        row = { ref: h.circuit };
        circuitBuckets.set(h.circuit, row);
        jobState.circuits.push(row);
      }
      row[h.field] = h.value;
    } else if (scope === 'board') {
      if (h.board_id == null) continue;
      let b = boardBuckets.get(h.board_id);
      if (!b) {
        b = { id: h.board_id };
        boardBuckets.set(h.board_id, b);
        jobState.boards.push(b);
      }
      b[h.field] = h.value;
    }
  }
  return jobState;
}
```

`_mergeIncomingJobStateIntoSnapshot` at `eicr-extraction-session.js:1760` already handles `jobState.circuits[].ref`, `jobState.supply`, `jobState.boards[].id`, plus `installationDetails`-shaped writes via the supply route (verify at implementation). No precedence reinvented.

### 2.7 Updated rollout (v4)

- Day 0: iOS branch — `buildRegexSummary` signature change, `resolveValue`, `normaliseRegexKey`, bundled config copies. Internal TestFlight build install on Derek's iPad. External submission for review.
- Day 1 AM: backend branch — `config/*.json` files, `regex-field-normalisation.js` + `observation-triggers.js` loaders, `shouldBypassSonnet`, `buildJobStateFromRegexHits`, wiring at `sonnet-stream.js:~3470` with `stampSeenTranscript()` reuse. Tests.
- Day 1 PM: deploy `REGEX_BYPASS_MODE=shadow`. Passive telemetry tagged with `iosBuildVersion`.
- Day 2 AM: read out 24h shadow. Filter to new-iOS-build sessions only. Decide ship vs abort. Abort thresholds:
  - Bypass rate < 10 % of new-iOS-build forwarded utterances → abort (low return on the sprint cost).
  - OR ≥ 1 mis-applied field detected via snapshot diff → abort + investigate.
- Day 2 PM: if ship, canary `REGEX_BYPASS_MODE=live`. Derek runs 2 iPad sessions on his iPad (the only device with new iOS yet).
- Day 3 AM: read out canary. Gates:
  - bypass_rate ≥ shadow baseline.
  - sonnet_calls_avoided ≥ 1 on a real session.
  - per-session $ vs Phase 1 baseline (down a few cents — small, real).
  - Snapshot field-population audit: every field populated via bypass log line either matches what Sonnet would have written (no regression) OR is a previously-empty cell (the merge function's empty-fill rule).
  - No spike in `ask_user.missing_context`.
- Day 3 PM: fleet flip. Bypass coverage grows as TestFlight rollout expands over the next 1–3 days. Per-device telemetry confirms growth.

---

## 3. Phase B — SoI as lookup tool (v4)

### 3.1 Carried from v3

SoI footprint ~2.5k tokens; Phase B saving is modest ($0.005–$0.015/session).

### 3.3 Tool schema (v4 — concrete)

`src/extraction/stage6-tool-schemas.js`:

```js
// New tool definition
const LOOKUP_INSPECTION_ITEM_TOOL = makeTool({
  name: 'lookup_inspection_item',
  description: [
    'Retrieve the verbatim BS 7671 Schedule of Inspection item text for a given item reference.',
    'Use this BEFORE emitting an observation\'s `schedule_item` and `regulation` fields when the compact',
    'directory text in the system prompt isn\'t enough to confidently attribute the observation.',
    'For common observations (cover damage, missing labels, etc.) the directory line is usually sufficient',
    'and you should NOT call this tool — it adds a round-trip. Call only when needed.',
    'The tool returns the full text of the requested item including regulation references.',
  ].join(' '),
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      item_ref: {
        type: 'string',
        description: 'BS 7671 Schedule of Inspection item reference, e.g. "4.5" or "12.1".',
        pattern: '^[0-9]+\\.[0-9]+$',
      },
    },
    required: ['item_ref'],
  },
});

// Existing static export, kept for backwards compat
export const TOOL_SCHEMAS = buildToolSchemas({ soiToolEnabled: false });

// NEW exports
export const BASE_TOOL_SCHEMAS = Object.freeze([...TOOL_SCHEMAS]);  // current eight
export function buildToolSchemas({ soiToolEnabled }) {
  const tools = [...BASE_TOOL_SCHEMAS];
  if (soiToolEnabled) tools.push(LOOKUP_INSPECTION_ITEM_TOOL);
  return tools;
}
```

### 3.4 Dispatcher (v4 — concrete)

New file `src/extraction/stage6-dispatchers-soi.js`:

```js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load full SoI once at module init.
const FULL_SOI_TEXT = fs.readFileSync(
  path.join(__dirname, '..', '..', 'config', 'prompts', 'schedule-of-inspection-bs7671-eicr.md'),
  'utf8'
);

// Parse into a map of {item_ref → verbatim section text}. Section
// delimiters are the leading-anchor pattern the SoI file already uses
// (e.g. lines starting with "4.5 ").
const SOI_BY_REF = parseSoiByRef(FULL_SOI_TEXT);

export function dispatchLookupInspectionItem(input) {
  const { item_ref } = input;
  if (typeof item_ref !== 'string' || !/^[0-9]+\.[0-9]+$/.test(item_ref)) {
    return { error: 'invalid_item_ref', message: `item_ref must match ^[0-9]+\\.[0-9]+$ — got ${item_ref}` };
  }
  const text = SOI_BY_REF[item_ref];
  if (!text) {
    return { error: 'item_not_found', message: `No SoI item at ${item_ref}` };
  }
  return { item_ref, text };
}

function parseSoiByRef(raw) {
  // Implementation: split on the SoI file's section anchors (verify the
  // exact delimiter at implementation; the file is single-author and the
  // pattern is stable). Build {ref: text} map.
}
```

Wired into the tool-loop dispatcher table same way other tools are. Tool_result content stays in the Sonnet turn that requested it; no `conversationHistory` persistence concerns (per v3 BLOCKER 3 / IMPORTANT 3 — live mode doesn't replay).

### 3.5 Module-init constant split (BLOCKER 4 fix)

`src/extraction/eicr-extraction-session.js`:

```js
// CURRENT (line 891-900)
const _AGENTIC_BASE_PROMPT = fssync.readFileSync(
  path.join(__dirname, '..', '..', 'config', 'prompts', 'sonnet_agentic_system.md'),
  'utf8'
);
const _SCHEDULE_OF_INSPECTION_EICR = fssync.readFileSync(
  path.join(__dirname, '..', '..', 'config', 'prompts', 'schedule-of-inspection-bs7671-eicr.md'),
  'utf8'
);
export const EICR_AGENTIC_SYSTEM_PROMPT =
  _AGENTIC_BASE_PROMPT.trimEnd() + '\n\n' + _SCHEDULE_OF_INSPECTION_EICR;

// CHANGED — add directory + remove the eager concat
const _SCHEDULE_OF_INSPECTION_DIRECTORY = fssync.readFileSync(
  path.join(__dirname, '..', '..', 'config', 'prompts', 'schedule-of-inspection-directory.md'),
  'utf8'
);

// Two variants of the agentic prompt, both module-init constants for cache stability:
export const EICR_AGENTIC_SYSTEM_PROMPT_FULL_SOI =
  _AGENTIC_BASE_PROMPT.trimEnd() + '\n\n' + _SCHEDULE_OF_INSPECTION_EICR;
export const EICR_AGENTIC_SYSTEM_PROMPT_DIRECTORY =
  _AGENTIC_BASE_PROMPT.trimEnd() + '\n\n' + _SCHEDULE_OF_INSPECTION_DIRECTORY;

// Backwards-compatible alias — DEPRECATED, remove once both export sites are updated.
export const EICR_AGENTIC_SYSTEM_PROMPT = EICR_AGENTIC_SYSTEM_PROMPT_FULL_SOI;
```

Constructor selection:

```js
// In EICRExtractionSession constructor, currently at :944-949
this.soiToolEnabled = this._resolveSoiToolEnabled(options.soiToolEnabled);

this.systemPrompt =
  this.toolCallsMode === 'off'
    ? certType === 'eic' ? EIC_SYSTEM_PROMPT : EICR_SYSTEM_PROMPT
    : this.soiToolEnabled
      ? EICR_AGENTIC_SYSTEM_PROMPT_DIRECTORY
      : EICR_AGENTIC_SYSTEM_PROMPT_FULL_SOI;

this.toolSchemas = buildToolSchemas({ soiToolEnabled: this.soiToolEnabled });
```

`_resolveSoiToolEnabled` mirrors `_resolveSnapshotFormat` / `_resolveToolCallsMode` exactly — env-var resolved once at construction time.

Harness call sites (`stage6-shadow-harness.js:96, 373-379, 1167-1173`) updated to pass `session.toolSchemas` instead of static `TOOL_SCHEMAS`. Three lines of change.

Hot-flip story: changing `SOI_TOOL_ENABLED` requires service redeploy (or fresh session if the constructor is hit again). Documented explicitly.

### 3.6.1 Compact directory generation

```bash
node scripts/generate-soi-directory.mjs \
  --input config/prompts/schedule-of-inspection-bs7671-eicr.md \
  --output config/prompts/schedule-of-inspection-directory.md
```

Generator extracts each item's first-line summary from the canonical SoI file. Output checked into git. CI re-runs generator and fails on diff.

iOS parity: `scripts/check-ios-soi-parity.mjs` diffs the backend full SoI item refs against iOS's `InspectionItem2` enumeration in `EICRHTMLTemplate.swift`.

### 3.6 Risks (v4)

| Risk | Mitigation |
|---|---|
| Observation quality regression | Directory is generated (not hand-drafted). 5-prerecorded-transcript E2E test pre-canary. |
| Sonnet ignores directory and calls lookup tool every turn | Canary metric: `lookup_tool_calls_per_observation` ≤ 1.5. |
| Drift: backend SoI vs iOS `InspectionItem2` | CI parity check. |

---

## 4. Phase C — TTS bridge (v4, unchanged from v3)

Carried.

---

## 5. Sequencing (v4)

| Day | Branch | Activity |
|---|---|---|
| 0 | iOS `regex-bypass-ios` | `buildRegexSummary` signature, `resolveValue`, `normaliseRegexKey`, bundled config copies. Internal TestFlight install on Derek's iPad. External submission. |
| 1 AM | backend `regex-bypass-backend` | `config/*.json`, loaders, `shouldBypassSonnet`, `buildJobStateFromRegexHits`, wiring at `sonnet-stream.js:~3470` with `stampSeenTranscript()` reuse, tests. |
| 1 PM | backend | Deploy `REGEX_BYPASS_MODE=shadow`. Telemetry tagged with `iosBuildVersion`. |
| 2 AM | — | Read out shadow data filtered to new-iOS sessions. Decide ship vs abort. |
| 2 PM | backend | If ship: canary `REGEX_BYPASS_MODE=live`. Derek runs 2 sessions on new-iOS iPad. |
| 3 AM | — | Read out canary. Fleet flip if green. |
| 3 PM | backend `soi-tool-lookup` | Phase B: constant split, directory generator, tool schema + dispatcher, harness call-site updates, tests. |
| 3 PM | iOS `observation-tts-bridge` | Phase C: trigger detector (using config/observation-triggers.json bundled copy), bundled audio, AlertManager wiring. |
| 4 AM | backend | Deploy `SOI_TOOL_ENABLED=false` default. |
| 4 AM | iOS | TestFlight upload of Phase C build. |
| 4 PM | — | Canary `SOI_TOOL_ENABLED=true`. iPad field test. |
| 5 | — | Read out Phase B+C. Fleet flip if green. |

### 5.1 Fork: skip Phase A if cost-saving doesn't justify (v4)

Honest pivot: if Day-0 stakeholder review of v4's $0.03–$0.10/session estimate concludes the saving doesn't justify a 5–7 day cross-platform sprint right now, **abandon Phase A**. Ship Phase B + C only:

| Day | Phase | Activity |
|---|---|---|
| 1 | B | All Phase B implementation (smaller scope without Phase A) |
| 2 | B + C | Phase B canary, Phase C iOS upload |
| 3 | B + C | iPad field test, fleet flip |

Saving in the Phase-B-only path: ~$0.005–$0.015/session. Even smaller, but it's two days of work instead of seven. Phase A can be revisited when the whitelist has grown enough to justify it.

---

## 6. Reviewer audit trail (v4)

- [x] PLAN.md (v1) — Claude self-review: 4 BLOCKERs → v2
- [x] PLAN_v2.md — Codex review: 8 BLOCKERs → v3
- [x] PLAN_v3.md — Claude self-review: 4 BLOCKERs (concrete code-symbol issues) → v4 (this file)
- [ ] PLAN_v4.md — Codex review (next)
- [ ] Iterate until both reviewers report zero BLOCKERs.

Convergence note from v3 reviewer: "v3 is converging on the right approach … remaining BLOCKERs are concrete implementation-detail mismatches, not architectural rewrites." v4 grounds every code reference against actual symbols. Expect this to be the last full rewrite; subsequent iterations should be small fixes only.

Verdict gate before commit / ship: zero BLOCKERs from both reviewers.
