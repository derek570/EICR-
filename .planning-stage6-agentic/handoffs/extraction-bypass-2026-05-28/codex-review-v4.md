# Codex review v4 — extraction-bypass PLAN_v4.md

## Verdict
NEEDS REWORK
4 BLOCKERs, 6 IMPORTANT, 3 MINOR

v4 is materially closer than v2/v3. The broad Phase A placement is now in the right lifecycle: `stampSeenTranscript()` is in scope at the proposed insertion area, and `originalTranscriptText` can be captured before the deterministic script / timeout prepends in `sonnet-stream.js`. However, the plan still has concrete source-symbol problems. The largest Phase A gap is iOS: the in-flight regex result is accessible, but the current `thisTurnRegexWrites` set never records the five fast-eligible circuit keys, so the proposed summary still would not emit bypassable hits. Phase B is also not buildable as written because the proposed `makeTool()` call, schema factory ordering, and dispatcher shape do not match the current code.

Convergence is real: v2 had 8 BLOCKERs across architecture and implementation; v4 is down to implementation-level blockers. But this is not yet shippable.

## Findings

### BLOCKER 1 — The iOS thread-through still would not emit the fast-eligible circuit fields

v4 correctly identifies that the regex values exist in the in-flight matcher result, but the plan names the type as `MatchResult` (`PLAN_v4.md:72`) while the actual type returned by `TranscriptProcessor.matchFields` is `RegexMatchResult` (`CertMateUnified/Sources/Recording/TranscriptProcessor.swift:181`, `CertMateUnified/Sources/Recording/TranscriptFieldMatcher.swift:19-24`). There is a separate `WorkOnBoardIntent.MatchResult`, so the v4 signature would be ambiguous/wrong if copied literally.

More importantly, `buildRegexSummary()` is driven by `thisTurnRegexWrites` (`DeepgramRecordingViewModel.swift:2312-2314`). Today `applyRegexMatches()` only inserts circuit keys for `ocpdRating`, `ocpdType`, `ocpdBsEn`, and `rcdType` in the circuit regex-hint block (`DeepgramRecordingViewModel.swift:4047-4072`). It does not insert keys for the five `REGEX_FAST_ELIGIBLE_FIELDS`: `measured_zs_ohm`, `r1_r2_ohm`, `ir_live_earth_mohm`, `ir_live_live_mohm`, `number_of_points` (`src/extraction/regex-fast-eligibility.js:47-55`). Those values do exist on `RegexMatchResult.CircuitUpdates` as `measuredZsOhm`, `r1R2Ohm`, `irLiveEarthMohm`, `irLiveLiveMohm`, and `numberOfPoints` (`TranscriptFieldMatcher.swift:69-87`, `1716-1721`, `1732-1737`, `1814-1839`, `1942-1945`), but v4 does not add them to the per-turn written-key set.

Net: even with `matchResult` plumbed into `buildRegexSummary`, the summary still cannot resolve or send the only fields that make a turn bypass-eligible. Bypass rate remains effectively 0 for Phase A's intended whitelist.

**Fix:** Change the iOS plan to use `RegexMatchResult?`, and in the circuit-hint loop add `thisTurnRegexWrites.insert("circuit.\(circuitRef).zs")`, `r1r2`, `irLE`, `irLL`, and `points` when the corresponding `RegexMatchResult.CircuitUpdates` property is non-nil. Then `resolveValue` can use `matchResult?.circuitUpdates[ref]?.measuredZsOhm` etc.

### BLOCKER 2 — `_mergeIncomingJobStateIntoSnapshot` does not accept `installationDetails`

v4 §2.0d builds `jobState.installationDetails` and says `_mergeIncomingJobStateIntoSnapshot` handles it "via the supply route" (`PLAN_v4.md:283-285`). It does not. The real merge handles only `jobState.circuits[]`, `jobState.supply`, and `jobState.boards[]` (`src/extraction/eicr-extraction-session.js:1760-1802`). There is no `installationDetails` branch.

The current Stage 6 convention is that supply / board / installation fields share the flat `stateSnapshot.circuits[0]` surface (`stage6-tool-schemas.js:562-590`, `stage6-snapshot-mutators.js:50-74`), not a separate `installationDetails` object. A bypassed utterance containing an installation regex hit would silently drop that field from the backend snapshot if v4 is implemented literally.

**Fix:** Either extend `_mergeIncomingJobStateIntoSnapshot()` with an explicit `installationDetails` branch that writes into `stateSnapshot.circuits[0]`, or have `buildJobStateFromRegexHits()` route installation-scoped canonical fields into `jobState.supply` / a renamed flat bucket that the existing supply branch already merges. Use canonical field-schema names such as `postcode`, not iOS source keys.

### BLOCKER 3 — The proposed `lookup_inspection_item` schema factory is unbuildable

The current schema helper is `makeTool({ name, description, properties, required })`, and it constructs `input_schema` internally (`src/extraction/stage6-tool-schemas.js:175-185`). v4 calls it with an `input_schema` property (`PLAN_v4.md:326-346`). That argument is ignored by the current helper, so the resulting tool would have `input_schema.properties === undefined` and no `item_ref` requirement.

v4's export ordering is also broken. It shows:

```js
export const TOOL_SCHEMAS = buildToolSchemas({ soiToolEnabled: false });
export const BASE_TOOL_SCHEMAS = Object.freeze([...TOOL_SCHEMAS]);
export function buildToolSchemas(...) { const tools = [...BASE_TOOL_SCHEMAS]; ... }
```

(`PLAN_v4.md:349-354`). Function declarations are hoisted, but `BASE_TOOL_SCHEMAS` is still in the temporal dead zone when `TOOL_SCHEMAS = buildToolSchemas(...)` runs, so module import throws before tests start.

**Fix:** Define `lookupInspectionItem = makeTool({ name, description, properties: { item_ref: ... }, required: ['item_ref'] })`. Then define a private frozen base array first, export `BASE_TOOL_SCHEMAS`, export `buildToolSchemas`, and finally export `TOOL_SCHEMAS = buildToolSchemas({ soiToolEnabled: false })`.

### BLOCKER 4 — The proposed SoI dispatcher does not match the dispatcher table contract

v4's `dispatchLookupInspectionItem(input)` returns a bare object (`PLAN_v4.md:368-376`). Existing dispatchers are registered in `WRITE_DISPATCHERS` (`src/extraction/stage6-dispatchers.js:63-110`), are invoked as `(call, ctx)` (`src/extraction/stage6-dispatchers.js:126-145`), and return a tool-result envelope with `{ tool_use_id, content: JSON.stringify(body), is_error }` (`stage6-dispatchers-circuit.js:82-89`, `stage6-dispatchers-observation.js:77-99`).

"Wired into the tool-loop dispatcher table same way other tools are" is therefore not concrete enough and the shown function shape is wrong. If the model calls `lookup_inspection_item`, the current `createWriteDispatcher` table will otherwise return `unknown_tool`.

**Fix:** Add `dispatchLookupInspectionItem(call, ctx)` that reads `call.input.item_ref`, logs through the same dispatcher logger convention, and returns the standard envelope keyed to `call.tool_call_id`. Import it into `stage6-dispatchers.js` and add `lookup_inspection_item: dispatchLookupInspectionItem` to `WRITE_DISPATCHERS`.

### IMPORTANT 1 — Bypass should use the resolved `regexResults`, not raw `msg.regexResults`

v4 places bypass around line 3470, before the existing regex ingress normalisation block (`sonnet-stream.js:3473-3500`) and calls `shouldBypassSonnet({ regexResults: msg.regexResults, ... })` (`PLAN_v4.md:213-221`). That bypasses the existing malformed-payload guard and the `entry.lastRegexResults` fallback used on drained retries (`sonnet-stream.js:3484-3499`, `3724-3755`).

Shadow/live bypass telemetry should run on the same sanitised payload the overtake classifier and `runShadowHarness` see. Otherwise shadow rate and live behaviour can diverge on malformed, absent, or drained-retry regex payloads.

**Fix:** Move the bypass check after `let regexResults` is resolved at `sonnet-stream.js:3488-3500`, and pass that local `regexResults` into `shouldBypassSonnet` and `buildJobStateFromRegexHits`.

### IMPORTANT 2 — `hasPendingAsk` must read `entry.pendingAsks`, not `session.askedQuestions`

v4 says "`hasPendingAsk` reads from `session.askedQuestions`" (`PLAN_v4.md:241`). That is not the live blocking-ask state. `session.askedQuestions` is legacy conversation memory (`eicr-extraction-session.js:953`, `2086-2089`, `2385-2386`). The live Stage 6 pending ask registry is `entry.pendingAsks` (`sonnet-stream.js:2481-2487`) and the current transcript path already checks `entry.pendingAsks.size` for gating and overtake classification (`sonnet-stream.js:3195-3197`, `3545-3547`).

Using `session.askedQuestions` can be both over-conservative after old questions and unsafe if a live `ask_user` is pending but not represented there.

**Fix:** Define `hasPendingAsk(entry)` as `entry.pendingAsks && entry.pendingAsks.size > 0`, or pass that boolean directly.

### IMPORTANT 3 — The iOS build-version telemetry gate has no current wire source

v4's rollout depends on filtering bypass logs to "new iOS build" sessions and logs `iosBuildVersion: msg.client_version ?? null` (`PLAN_v4.md:222-229`, `288-307`). Current transcript frames do not include `client_version`; `ServerWebSocketService.sendTranscript()` sends `type`, `text`, `timestamp`, optional `regexResults`, `confirmations_enabled`, `in_response_to`, and `utterance_id` only (`ServerWebSocketService.swift:563-599`).

`session_start` sends `protocol_version` and a `capabilities.voice_latency` block (`ServerWebSocketService.swift:507-558`), and the backend stores parsed capabilities on the active entry (`sonnet-stream.js:2521-2534`), but no build number is available for the proposed log field.

**Fix:** Add an explicit iOS build/version field to `session_start` and store it on the active session entry, or add a dedicated regex-bypass capability version. Log that stored value from bypass rows; do not read `msg.client_version` from transcript frames unless the iOS wire method is changed.

### IMPORTANT 4 — The canonical config examples do not match current field names and key shapes

The proposed `regex-field-normalisation.json` maps `supply.ze` to canonical `ze` and `supply.pfc` to `pfc` (`PLAN_v4.md:132-134`). The backend schema uses `earth_loop_impedance_ze` and `prospective_fault_current` (`config/field_schema.json:560-572`). The plan also maps `board.<id>.zeAtDb`, but iOS currently writes `board.zeAtDb` with no board id in the source key (`DeepgramRecordingViewModel.swift:3903-3910`).

These are not fast-whitelist fields, so they do not break the first live bypass path by themselves. But they would break the "canonical maps" claim and any tests that assert scope routing or backend field-schema compatibility.

**Fix:** Make every `canonicalField` a real backend field-schema key. For board regex writes, either change iOS to include a board id in the summary payload, or have `resolveValue` add the current board id separately while normalising the existing `board.zeAtDb` source key.

### IMPORTANT 5 — The parity-script pattern is compatible only after the new Swift targets exist

The existing parity script is a concrete JSON-to-Swift-source audit: it loads `config/field_schema.json`, parses case literals inside `applySonnetReadings`, and reports missing/orphan fields (`scripts/check-ios-field-parity.mjs:1-37`, `49-111`). That pattern can be reused, but not as vaguely as v4 states.

There is no existing Swift `normaliseRegexKey` switch or bundled `regex-field-normalisation.json` to parse today (`TranscriptProcessor.swift:188-207`). Also, the JSON snippet in v4 includes `//` comments inside a `.json` file (`PLAN_v4.md:144-145`), while the proposed backend loader uses `JSON.parse(fs.readFileSync(...))` (`PLAN_v4.md:157-161`), which will fail on comments.

**Fix:** Keep the config files strict JSON, add a stable Swift source surface for the script to parse, and make the parity script compare three explicit things: root JSON entries, bundled iOS JSON entries, and Swift literals / generated map entries.

### IMPORTANT 6 — Constant split must also update existing mode-change tests and restamp path

v4 updates the constructor selection (`PLAN_v4.md:397-408`), which matches the current constructor area (`eicr-extraction-session.js:944-949`). But this class also has `applyModeChange()` as the sole mid-session restamp path for `toolCallsMode` and `systemPrompt` (`eicr-extraction-session.js:1192-1243`), and there are many tests asserting `EICR_AGENTIC_SYSTEM_PROMPT` identity (`src/__tests__/eicr-extraction-session-apply-mode-change.test.js:69-144`, `src/__tests__/eicr-extraction-session.snapshot-refactor.test.js:85-151`).

If Phase B introduces `this.soiToolEnabled` and `this.toolSchemas`, the constructor-only snippet is incomplete for sessions that are rebound or mode-flipped by `sonnet-stream.js` (`sonnet-stream.js:2115`, `2913`). The plan's "hot flip requires redeploy/fresh session" is acceptable for `SOI_TOOL_ENABLED`, but tests and the restamp method still need to be updated so mode changes preserve the correct full-vs-directory prompt variant and schema set for the session's latched `soiToolEnabled`.

**Fix:** Add `_resolveSoiToolEnabled`, latch it in the constructor, update `applyModeChange()` to rederive prompt using the latched flag, and update prompt identity tests for full-vs-directory variants.

### MINOR 1 — `originalTranscriptText` and `stampSeenTranscript()` checks pass

The proposed `transcriptText !== originalTranscriptText` guard is implementable. `transcriptText` is initialised from `msg.text` at `sonnet-stream.js:3258`, then may be prepended with `in_response_to` context (`3302`), script outcomes (`3334-3408`), and timeout notes (`3427-3467`). Adding `const originalTranscriptText = msg.text` before those mutations gives the comparison v4 wants.

`stampSeenTranscript()` is also in scope at the proposed bypass insertion point: it is declared in the same `handleTranscript` closure at `sonnet-stream.js:3143-3179` and used after successful harness completion at `3870`.

### MINOR 2 — The SoI parser delimiter described in v4 is not the file's actual anchor

v4 says SoI section delimiters are "lines starting with `4.5 `" (`PLAN_v4.md:364-367`). The real file uses markdown bullets like `- 4.5 — ...` (`config/prompts/schedule-of-inspection-bs7671-eicr.md:43-64`) and includes multi-part refs such as `1.1.1`, `5.12.1`, and section-7 refs with leading zeroes (`7.02`) (`schedule-of-inspection-bs7671-eicr.md:16-18`, `86-90`, `118-123`).

v4 does say to verify the delimiter at implementation, so this is not a blocker, but the parser/test plan should name the real anchor now.

### MINOR 3 — The `item_ref` regex is too narrow for existing SoI refs

The proposed tool schema uses `^[0-9]+\\.[0-9]+$` (`PLAN_v4.md:338-340`). Existing refs include three-level values such as `1.1.1` and `5.12.1` (`schedule-of-inspection-bs7671-eicr.md:16-18`, `86-90`). If those can be valid `schedule_item` values, the lookup tool will reject real items.

**Fix:** Use a pattern like `^[0-9]+(?:\\.[0-9]+)+$` and preserve refs as strings so values such as `7.02` are not normalised to `7.2`.

## Summary of required changes before ship

1. Fix the iOS regex summary source: use `RegexMatchResult`, add written keys for the five fast-eligible circuit fields, and read values from `result.circuitUpdates`.
2. Route installation/supply/board fields into the actual backend snapshot surfaces and canonical field-schema names.
3. Move bypass after existing regex-result normalisation and use `entry.pendingAsks` for pending-ask eligibility.
4. Make the SoI schema factory and dispatcher match the existing `makeTool()` and `(call, ctx) → envelope` contracts.
5. Add a real iOS build/capability version source for rollout filtering.

