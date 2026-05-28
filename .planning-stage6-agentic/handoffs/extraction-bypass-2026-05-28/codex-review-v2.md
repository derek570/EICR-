# Codex review v2 — extraction-bypass PLAN_v2.md

## Verdict
NEEDS REWORK
8 BLOCKERs, 5 IMPORTANT, 2 MINOR

v2 fixes several v1 review items in intent, but the proposed implementation still does not match the production paths. The biggest remaining problem is that the new server-side regex applier assumes a wire shape iOS does not send: `regexResults` contains only `field` keys except postcode (`TranscriptProcessor.swift:198-207`), while v2 needs `{field,value,circuit}` (`PLAN_v2.md:60-64`). The synthetic history shape is also not valid for the current extraction mode, and Stage 6 live tool turns do not currently replay `conversationHistory` at all (`stage6-shadow-harness.js:373-379`, `stage6-shadow-harness.js:1167-1173`). New blockers: the bypass insertion point is underspecified relative to `isExtracting`, ask dedupe, active dialogue scripts, and the server-side timeout notes in `handleTranscript`.

## Findings

### BLOCKER 1 — `regexResults` still lacks the value/circuit payload the server applier needs

v2 makes server-side regex application mandatory, but the proposed `applyRegexHitsToSnapshot(regexResults)` consumes `r.value` and `r.circuit` (`PLAN_v2.md:60-78`). iOS does not send those. `TranscriptProcessor.buildRegexSummary()` returns `["field": key]` for each written key and only adds `value` for `install.postcode` (`CertMateUnified/Sources/Recording/TranscriptProcessor.swift:198-207`). `DeepgramRecordingViewModel` sends that summary as the transcript `regexResults` (`CertMateUnified/Sources/Recording/DeepgramRecordingViewModel.swift:2228-2234`, `CertMateUnified/Sources/Recording/DeepgramRecordingViewModel.swift:2288-2294`).

This means the v2 server applier writes `undefined` for nearly every field, and cannot know which circuit a circuit-scoped write belongs to. It also cannot recover the value from `stateSnapshot`, because the whole reason for A.0 is that regex pre-apply does not push `job_state_update` (`DeepgramRecordingViewModel.swift:4074-4080`, `DeepgramRecordingViewModel.swift:6996-7003`).

**Fix:** Change the iOS wire shape before live bypass, or do not server-apply from `regexResults`. The transcript payload needs canonical backend field, value, circuit/board_id where applicable, and a source key for diagnostics. Postcode-only value support is not enough.

### BLOCKER 2 — The synthetic `record_reading` exchange is invalid for the real schemas and the real history model

v2 appends Anthropic-native blocks:

```
assistant tool_use record_reading {field,value,circuit}
user tool_result "recorded"
```

(`PLAN_v2.md:135-143`). That violates `record_reading`: required fields are `field`, `circuit`, `value`, `confidence`, and `source_turn_id` (`src/extraction/stage6-tool-schemas.js:195-245`). Board/supply/installation regex fields are not `record_reading` fields at all; board-level fields require `record_board_reading` (`src/extraction/stage6-tool-schemas.js:560-607`) and installation/supply merge through the snapshot convention, not the circuit-reading tool.

It also conflicts with the non-tool extraction history format. `_extractSingle()` deliberately stores assistant output as JSON text so the sliding window does not replay tool_use/tool_result pairs (`src/extraction/eicr-extraction-session.js:2065-2077`). In that path, a synthetic assistant `tool_use` without a matching real Anthropic response is the wrong abstraction.

**Fix:** Define one history representation per mode. For legacy/prose extraction, append a user text plus assistant JSON text matching `EXTRACTION_TOOL` output. For Stage 6 live tool mode, fix real multi-turn history first (see BLOCKER 3) and only append Anthropic-native `tool_use/tool_result` blocks if they satisfy every required field and immediately adjacent pairing rule.

### BLOCKER 3 — Stage 6 live mode does not replay prior conversation history, so bypass history and SoI tool elision do nothing there

The plan says synthetic bypass turns preserve coherence and that SoI tool results can later be truncated in `conversationHistory` (`PLAN_v2.md:128-143`, `PLAN_v2.md:177-187`). But Stage 6 live mode calls `runToolLoop()` with only the current transcript:

- live path: `messages: [{ role: 'user', content: transcriptText }]` (`src/extraction/stage6-shadow-harness.js:373-379`)
- shadow/tool path: same one-message shape (`src/extraction/stage6-shadow-harness.js:1167-1173`)

`runToolLoop()` mutates that local `messages` array and returns `messages_final` (`src/extraction/stage6-tool-loop.js:220-239`, `src/extraction/stage6-tool-loop.js:942-948`), but the harness does not append `messages_final` back to `session.conversationHistory`. The only existing `conversationHistory.push()` is in legacy `_extractSingle()` (`src/extraction/eicr-extraction-session.js:2073-2077`). Non-off `buildMessageWindow()` would replay `conversationHistory` if it existed (`src/extraction/eicr-extraction-session.js:2526-2538`), but live Stage 6 is not using that window.

**Fix:** Before Phase A or B depends on history, decide how Stage 6 live stores and replays prior turns. The tool loop should start from `session.buildMessageWindow()` plus the new user turn, then persist a safe post-turn slice back to the session. Only after that can bypass history and `lookup_inspection_item` result elision be meaningful.

### BLOCKER 4 — Regex-fast intersection is empty without field-source normalisation

v2 gates bypass on intersection with the regex-fast whitelist (`PLAN_v2.md:104-107`). The whitelist contains canonical backend circuit field names such as `measured_zs_ohm`, `r1_r2_ohm`, and `ir_live_earth_mohm` (`src/extraction/regex-fast-eligibility.js:44-60`). iOS `buildRegexSummary()` sends field-source keys such as `circuit.3.zs`, `circuit.3.r1r2`, `supply.ze`, and `board.zeAtDb`, because it maps directly from `thisTurnRegexWrites` (`TranscriptProcessor.swift:198-207`, `DeepgramRecordingViewModel.swift:4051-4072`).

Those namespaces do not intersect. Without a parser/normaliser from iOS field-source keys to backend field names plus circuit/board context, `shouldBypassSonnet` will either reject everything or accidentally compare the wrong strings.

**Fix:** Add a shared normalisation function and tests: `circuit.<ref>.zs -> {tool:'record_reading', field:'measured_zs_ohm', circuit:<ref>}`, `circuit.<ref>.r1r2 -> r1_r2_ohm`, and so on. Use the same normalised shape for fast-TTS eligibility, server apply, telemetry, and synthetic history.

### BLOCKER 5 — The proposed regex merge does not mirror the real snapshot merge

v2 says it mirrors `_mergeIncomingJobStateIntoSnapshot`, but it does not. Real merge overwrites `FACT_FIELDS` unconditionally and fills readings only when empty (`src/extraction/eicr-extraction-session.js:1820-1834`). v2 does the opposite for facts: it refuses to overwrite an existing fact (`PLAN_v2.md:70-77`). Real merge also handles three surfaces: `jobState.circuits[]`, `jobState.supply`, and `jobState.boards[]` (`src/extraction/eicr-extraction-session.js:1763-1801`). v2 writes every field into `stateSnapshot.circuits[circuit ?? 0]` (`PLAN_v2.md:67-69`), which cannot correctly apply board fields, installation fields, supply fields, or multi-board composite circuit keys.

**Fix:** Do not implement an independent merge loop. Convert normalised regex hits into the same jobState-shaped payload `_mergeIncomingJobStateIntoSnapshot()` already accepts, or factor the real field merge helper so the bypass path uses exactly the same precedence and bucket resolution.

### BLOCKER 6 — The bypass insertion point can skip active dialogue scripts and timeout prompts

v2 places `shouldBypassSonnet` after the pre-LLM gate and before the existing extraction path (`PLAN_v2.md:121-132`). In current code, several server-side deterministic state machines run after the gate but before the Sonnet/tool-loop call:

- ring continuity script (`src/extraction/sonnet-stream.js:3311-3359`)
- insulation resistance script (`src/extraction/sonnet-stream.js:3361-3385`)
- protective-device script (`src/extraction/sonnet-stream.js:3387-3408`)
- ring/IR partial-fill timeout notes that prepend server instructions before Sonnet (`src/extraction/sonnet-stream.js:3410-3467`)

Eligibility check #7 only says "No `start_dialogue_script` pattern" (`PLAN_v2.md:112`). That is insufficient. The dangerous case is an already-active script or a partial-fill timeout where the next utterance also has a regex hit. Returning before these processors can consume the turn loses script state, suppresses the follow-up ask, or bypasses a server note whose whole job is to force Sonnet to ask for a missing companion value.

**Fix:** Place bypass after the deterministic script processors and timeout-note construction, and add explicit eligibility checks for active script state / partial-fill timeouts. If any script handles the turn or any server note is prepended, bypass must not fire.

### BLOCKER 7 — The plan does not preserve `handleTranscript` serialisation

`handleTranscript` currently queues new transcripts while a turn is in flight (`src/extraction/sonnet-stream.js:3223-3241`), sets `entry.isExtracting = true`, and drains queued transcripts from the `finally` block (`src/extraction/sonnet-stream.js:3244-3250`, `src/extraction/sonnet-stream.js:4128-4169`). v2's pipeline shows bypass immediately after the pre-LLM gate and before the normal extraction path (`PLAN_v2.md:121-132`), but does not say it runs after the `entry.isExtracting` queue gate or inside the same `try/finally` lifecycle.

If bypass mutates `stateSnapshot` while a tool loop is still running, it races with dispatcher writes and pending ask resolution. If it returns outside the existing lifecycle, queued transcripts may not drain and the watchdog/`isExtracting` semantics diverge from normal handled turns.

**Fix:** Specify the exact code location. A live bypass must occur only after the existing queue gate has admitted the turn, inside the same `try/finally` as normal extraction, with `entry.isExtracting` held and drained exactly like any other handled transcript.

### BLOCKER 8 — Phase B's conditional schema plan does not match the static `TOOL_SCHEMAS` call sites

v2 proposes `buildToolSchemas()` per session (`PLAN_v2.md:207-215`). The live and shadow Stage 6 paths currently import the static `TOOL_SCHEMAS` array and pass it straight into `runToolLoop()` (`src/extraction/stage6-shadow-harness.js:96`, `src/extraction/stage6-shadow-harness.js:373-379`, `src/extraction/stage6-shadow-harness.js:1167-1173`). `stage6-tool-schemas.js` exports one static array (`src/extraction/stage6-tool-schemas.js:1009-1037`).

So adding `lookup_inspection_item` to the static array makes it available even when `SOI_TOOL_ENABLED=false`, directly contradicting the rollback contract and P0 abort criterion (`PLAN_v2.md:217-221`). Conversely, adding an instance method on `EICRExtractionSession` will have no effect unless every `TOOL_SCHEMAS` call site is changed.

**Fix:** Replace static tool-array use at the harness boundary with a per-session resolver, or export `BASE_TOOL_SCHEMAS` plus `buildToolSchemas({soiToolEnabled})` and thread the session flag into both live and shadow paths.

### IMPORTANT 1 — Bypassed turns must still update transcript dedupe ledgers

The current handler records committed transcripts in `seenTranscriptUtterances` and `recentTranscripts` so later `ask_user_answered` frames do not re-expose the same speech (`src/extraction/sonnet-stream.js:3143-3179`). The normal tool path stamps after `runShadowHarness()` succeeds (`src/extraction/sonnet-stream.js:3766-3767` and subsequent stamp call). A bypass early-return would skip that unless the plan explicitly calls it.

This can reopen the exact duplicate-answer races the existing comments are guarding against: later explicit answer frames can miss the Set/content-anchor evidence that this transcript was already handled.

**Fix:** Treat bypass as a committed transcript. Stamp the same ledgers and clear `entry.lastRegexResults` on the bypass path before returning.

### IMPORTANT 2 — Shadow telemetry must run on the same normalised payload and insertion point as live

v2's Day-1 shadow mode computes `shouldBypassSonnet` without skipping Sonnet (`PLAN_v2.md:147-153`). If that check runs where the v2 pipeline shows it, it sees raw `msg.regexResults` before the current ingress normalisation/fallback (`src/extraction/sonnet-stream.js:3473-3500`) and before script processors/timeout notes (`src/extraction/sonnet-stream.js:3311-3467`). The shadow bypass rate will not predict live behaviour after the fixes above.

**Fix:** Implement the normalised candidate builder once, call it at the final intended live insertion point, and log both raw and normalised rejection reasons. Shadow telemetry should be a dry run of the exact live branch.

### IMPORTANT 3 — Tool-result elision has no safe target until live history persistence exists

v2 says the dispatcher rewrites `lookup_inspection_item` tool results in `conversationHistory` to `<truncated>` (`PLAN_v2.md:177-187`). Today `runToolLoop()` appends tool results to its local `messages` array (`src/extraction/stage6-tool-loop.js:656-772`, `src/extraction/stage6-tool-loop.js:847-848`) and returns `messages_final` (`src/extraction/stage6-tool-loop.js:942-948`), but those messages are not persisted to `session.conversationHistory` in the Stage 6 harness. So the proposed elision either changes nothing, or, after BLOCKER 3 is fixed, risks breaking Anthropic's required tool_use/tool_result adjacency if it rewrites the wrong message.

**Fix:** Defer elision design until the live history storage format is specified. Then truncate only old, already-paired tool_result content in persisted history, never the immediately-following tool_result required by the next API call.

### IMPORTANT 4 — Phase A rollout criteria depend on `reviewForOrphanedValues`, but live mode skips that review

v2 canary criteria include "No regression in `reviewForOrphanedValues` finds" (`PLAN_v2.md:155-160`). In current `handleTranscript`, orphan review is explicitly gated to legacy/off mode via `consumeLegacyQuestionsForUser(entry)` and skipped for tool-call branches (`src/extraction/sonnet-stream.js:4073-4083`). `reviewForOrphanedValues()` itself uses legacy `EXTRACTION_TOOL`, not the Stage 6 `ask_user` path (`src/extraction/eicr-extraction-session.js:3494-3529`).

That metric cannot validate Stage 6 live bypass safety as written.

**Fix:** Replace this acceptance criterion for live mode with a Stage 6-compatible audit, or explicitly state Phase A is only being evaluated in the legacy path. Do not use a skipped review as a safety signal.

### IMPORTANT 5 — SoI directory generation risks drifting from the iOS schedule copy

The production prompt code documents that the backend SoI and the iOS canonical schedule copy must be edited together (`src/extraction/eicr-extraction-session.js:880-890`). v2 adds a hand-drafted compact directory and lookup source (`PLAN_v2.md:191-204`, `PLAN_v2.md:223-230`) but does not include a parity check against the iOS `InspectionItem2` source. That creates a new drift surface: Sonnet may emit `schedule_item` values from the backend directory that the iOS auto-linker/template does not recognise.

**Fix:** Generate the compact directory and lookup table from one canonical SoI source, or add a CI parity check covering backend full SoI, backend directory, and the iOS schedule item list.

### MINOR 1 — The Phase B plan still assumes a custom "strict" tool shape that the code no longer uses

The file header still says strict tools, but `makeTool()` no longer sets `strict: true` because strict mode was removed after overload failures (`src/extraction/stage6-tool-schemas.js:154-184`). v2 discusses schema inclusion correctly at a high level, but any acceptance test or rollout expectation based on Anthropic rejecting invalid enum values before dispatch would be stale.

**Fix:** Keep the plan language aligned with current behaviour: schemas guide the model, dispatchers enforce.

### MINOR 2 — The cost model should separate "utterances bypassed" from "billable turns avoided"

v2 corrects the batch-buffer issue by moving bypass before `extractFromUtterance()` (`PLAN_v2.md:121-132`), but the savings table still reads like Sonnet turns saved are directly proportional to bypassed forwarded utterances (`PLAN_v2.md:31-39`, `PLAN_v2.md:155-157`). Because current extraction batches two utterances or waits 2s (`src/extraction/eicr-extraction-session.js:1845-1904`), shadow telemetry should report both candidate utterances and avoided batch flushes / avoided live tool-loop calls.

**Fix:** Add rollout metrics for `bypass_candidate_utterances`, `bypass_live_applied`, `sonnet_calls_avoided`, and `batch_flushes_avoided` so the saving readout does not over-attribute.

---

## Summary of required changes before ship

1. Change the iOS/server regex payload to include canonical field, value, circuit, and board context, or remove server-side application from Phase A.
2. Replace the synthetic history design with a mode-correct representation and first fix Stage 6 live multi-turn history replay.
3. Put bypass at a precise, safe location in `handleTranscript`: after queue admission, after deterministic scripts/timeout checks, inside the normal `try/finally`, and with dedupe ledger updates.
4. Reuse the real snapshot merge semantics and bucket routing instead of the simplified `circuits[circuit ?? 0]` loop.
5. Make Phase B's prompt/tool-schema gating real at the static `TOOL_SCHEMAS` call sites, and defer tool-result elision until persisted live history exists.
