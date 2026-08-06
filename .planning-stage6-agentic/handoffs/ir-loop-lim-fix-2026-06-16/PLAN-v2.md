# Plan — Field session F1AC26FB voice-feedback fixes (5 defects)

**Date:** 2026-06-16
**Session:** `F1AC26FB-41D2-47E9-AB5F-850C443C7834` — job_1781607199550, EIC, single board `17D15991`, 78 Meadow Close Thatcham.
**Source:** 5 voice-feedback markers uploaded during the session (S3 `debug-reports/82b54893-…/2026-06-16T11-*`); full transcript from `session-analytics/…/F1AC26FB…/debug_log.jsonl`.
**Investigation:** definitive, file:line-level, verified against current code (4 parallel deep-dives + direct log trace). NOT guesses.
**Status:** Drafted, awaiting `/rp` refine → `/ep` execute.

---

## 0. Scope & cross-platform rule

Per the MANDATORY backend-immutability rule (`CLAUDE.md`): `src/`, `config/prompts/*.md`, `config/field_schema.json`, shared-types are SHARED with iOS. Each fix below is tagged:
- **[BE-safe]** — backend-only, no wire/schema/prompt contract change, no iOS work (e.g. dialogue-engine string handling, validation guards).
- **[shared-prompt]** — edits `config/prompts/*.md` — cross-platform, needs care, but emits no new message type so iOS renders unchanged.
- **[iOS]** — iOS source change (regex / capture logic) — TestFlight cycle.
- **[contract]** — touches the iOS↔server data contract — must be surfaced to Derek before implementing.

## Path key (dialogue-engine files cited unqualified below live here)
- `parsers/megaohms.js` → `src/extraction/dialogue-engine/parsers/megaohms.js` (the dialogue-engine copy; the legacy twin is `src/extraction/insulation-resistance-script.js`).
- `engine.js` → `src/extraction/dialogue-engine/engine.js`; `helpers/circuit-resolution.js` → `src/extraction/dialogue-engine/helpers/circuit-resolution.js`; `schemas/*.js` → `src/extraction/dialogue-engine/schemas/`.
- `value-normalise.js`, `record-reading-coercion.js`, `stage6-answer-resolver.js`, `stage6-dispatch-validation.js`, `stage6-tool-schemas.js`, `stage6-dispatchers-*.js` → `src/extraction/`.

## Locked decisions (2026-06-16)
- **#4 LIM:** store as canonical sentinel string `"LIM"` in `ir_live_*_mohm` (NOT `>999`). Matches `src/extraction/value-normalise.js:107`, `src/extraction/stage6-answer-resolver.js:607`, the Sonnet prompt garble list (`config/prompts/sonnet_full_transcript_system.md:39-40`), and the user's 2026-02-18 request. (`src/extraction/record-reading-coercion.js:245` accepts LIM for board PASS-check fields only — see #4 caveat; Fix #4.2 widens it to IR fields. Re-confirm these citations at execution time; they may drift.)
- **Review/orchestration gotcha:** any Codex MCP review/refine agent invoked for this handoff must be called with `model: "gpt-5.5"` (per project memory).

---

## 1. Session timeline (condensed ground truth)

```
11:43-44  address/postcode/town captured (OK)
11:44:26  "Feedback."  ── feedback marker OPEN ──
11:44:50-11:45:45  earthing attempts dictated INSIDE the marker → swallowed client-side
11:45:51  "end feedback."  ── marker CLOSE ──  (marker #1 uploaded)
11:45:59-11:46:24  "Erthing is t and s / t n s" → NOT extracted
11:46:46  "Other thing system is TNS." → earthing=TN-S finally set
11:48     Ze 0.30 / PFC 0.75 set (OK)
11:48-49  circuits created: 1 Cooker, 2 Sockets, 3 Downstairs Light, 4 Upstairs Light (with rename/delete churn)
11:51:58  "Ring continuity for the sockets…" → loop can't resolve "sockets"→c2 (marker #3)
11:52:19  resolves only when inspector says literal "circuit 2"; ring R1/Rn/R2 then OK
11:53:28-54:02  "tails are 25mm" → wrongly stored as sub_main_cable_csa (marker #2)
11:55:06-56:53  IR loop: "LIM" rejected, re-asks forever, twice (marker #4)
11:57:20-34  "Swap circuits 3 and 4" → junk circuit 999 "(temp)" left behind (marker #5)
```

---

## DEFECT #1 — "Earthing is TN-S" took ~6 attempts  [TWO stacked causes]

**Marker (11:45:51):** "I think it's TNS. Earthing is TNS… Job in 5 minutes." Earthing not being captured.

### Cause 1a — feedback marker swallowed the early attempts (client-side, dominant)
The inspector opened a feedback marker at 11:44:26 and didn't close it until 11:45:51. Every final inside that window is appended to the feedback buffer and **never forwarded to extraction**.
- `CertMateUnified/Sources/Recording/TranscriptProcessor.swift:189` `processDebugCommand`; entry anchor `:245`; in-capture else-branch `:224-227` returns `.debugCaptureContinuing` (append only).
- `DeepgramRecordingViewModel.swift:2528-2566`: only the `.normalText` case (`:2530-2532`) calls `appendToTranscriptAndExtract`; `.debugCaptureContinuing` (`:2562-2563`) is a bare `break` — no regex, no WS send.
- The 11:44:57 `SONNET readings=0` was a *prior* in-flight turn, not an in-window utterance (in-window text never reached the server).
- Exit regex (`:205`) only closes on `end/stop/finish/done feedback` (+ end-anchored `and/an/in feedback`); "Job in 5 minutes." + silence kept it open ~90s.

### Cause 1b — earthing value regex needs adjacent "tn"; backend gate blocks earthing text without a regex hint
- iOS earthing pattern `TranscriptFieldMatcher.swift:628-630`: `tn[-\s]?s` requires **t and n adjacent**. So "TNS"/"tn-s"/"tn s" match; "**t n s**" and "t and s" do NOT. Map at `:1301-1308`, applied `:1681-1683`. (The word "earthing" is NOT required, so the head-word garbles erthing/irthing/birthing are irrelevant — only the value token matters.)
- Backend `pre-llm-gate.js`: neither "earthing" nor "tns/tn-s" is a strong/weak trigger (`:87-125`, `:177-288`); earthing text only forwards to Sonnet via `HAS_REGEX_HINT` (`:453-455`). So with no iOS regex hit, the gate blocks → Sonnet never sees it. That's why cleaner "Erthing is t n s" (11:46:24, no regex hit, gate block) failed but garbled "Other thing system is TNS" (11:46:46, "TNS" adjacent → regex hit → forwarded) succeeded.
- The live agentic prompt is `config/prompts/sonnet_agentic_system.md` (selected for `toolCallsMode !== 'off'` at `eicr-extraction-session.js:1037-1042`) and it also lacks earthing-garble steering. `config/prompts/sonnet_extraction_system.md` is the rollback/`off`-mode prompt (bare earthing enum at `:209`); the "Earth-In→Earthing" line lives only in the legacy `sonnet_text_system.md` (not the live `/api/sonnet-stream` path).

### Fix #1
1. **[iOS]** Dual-route in-capture finals: in `DeepgramRecordingViewModel.swift:2562-2563`, for `case .debugCaptureContinuing` call `appendToTranscriptAndExtract(normalised, utteranceId: utteranceId)` (the only text in scope there is the surrounding `normalised`; `.debugCaptureContinuing` carries no associated value) but do NOT call `appendRollingFinal` — keep the existing rolling-context-window exclusion (`:2516-2526`). **Also cover the close utterance:** when the exit phrase shares a final with field text (e.g. "earthing is TNS end feedback"), `TranscriptProcessor.swift:205-221` appends the `beforeExit` text to the issue and returns `.debugIssueComplete`, but `DeepgramRecordingViewModel.swift:2533-2550` uploads the issue and never extracts `beforeExit`. Carry the pre-exit text out (add an optional `extractableBeforeExit` to `.debugIssueComplete`, or a new result case) and call `appendToTranscriptAndExtract(extractableBeforeExit, utteranceId: utteranceId)` when present (no `appendRollingFinal`). Add regression tests: in-capture FIELD dictation is extracted, a complaint-only continuation creates no write, and "earthing is TNS end feedback" extracts TN-S. (Extraction suppression in the capture branch is an unintended side effect of the `.normalText`-only fork.)
2. **[iOS]** Auto-timeout the feedback capture: add a wall-clock guard (~20s) in the capture branch using the existing `closeDebugCapture()` (`TranscriptProcessor.swift:296`), so a marker can't stay open indefinitely.
3. **[iOS]** Loosen the earthing value regex `TranscriptFieldMatcher.swift:629` to tolerate split/garbled tokens: `tn[-\s]?s`→`t[-\s]?n[-\s]?s`, same for `tn-c-s`/`tn-c`; accept the spoken "N" garble `t[-\s]?(?:n|and|an|in)[-\s]?s`. **Preserve alternation precedence** — the loosened TN-C-S and TN-C branches MUST remain BEFORE the TN-S branch (longest-match-first) and use single optional separators `[-\s]?` (NOT `[-\s]*`, which could span the C token and mis-map TN-C-S as TN-S). Add lowercase spaced keys to `earthingMap` (`:1301-1308`): `"t and s"`,`"t an s"`,`"t in s"`→`"TN-S"` (or normalise whitespace before lookup). Add a `TranscriptFieldMatcherTests` case asserting `"t n c s"`→TN-C-S still wins over TN-S.
4. **[shared-prompt, optional defence]** Add an earthing-garble line to the LIVE agentic prompt `config/prompts/sonnet_agentic_system.md` (near `VALUE NORMALISATION` / `SUPPLY vs MAIN SWITCH DISAMBIGUATION`): earthing→erthing/irthing/birthing/other thing; TN-S→TNS / t n s / t and s. Optionally mirror the same line into `config/prompts/sonnet_extraction_system.md` (~:209) for `SONNET_TOOL_CALLS=off` rollback coverage. Secondary, since the iOS regex hint is the actual gate key.

---

## DEFECT #2 — "tails are 25mm" stored as `sub_main_cable_csa`  [prompt steering]

**Marker (11:54:24):** "tails are 25mm, meaning the main tails to the board, and it said sub main 25mm."

### Root cause
The live agentic path (`SONNET_TOOL_CALLS != 'off'`) reads `sonnet_agentic_system.md` at `eicr-extraction-session.js:965-968`, builds `EICR_AGENTIC_SYSTEM_PROMPT` at `:988-993`, and selects it for `toolCallsMode !== 'off'` at `:1037-1042`. That prompt has **no "tails" mapping** and no main-tails-vs-sub-main steering (it steers `main_switch_*`, bonding, cable normalisation, sub-main *board creation*, but not tails). The `record_board_reading.field` enum is `BOARD_FIELD_ENUM` (`stage6-tool-schemas.js:130`, referenced at `:614`), the union of supply/board/installation field keys from `config/field_schema.json` — so BOTH `main_switch_conductor_csa` (`field_schema.json:708`) and `sub_main_cable_csa` (`field_schema.json:388`) are valid bare keys; the schema's `ai_guidance` ("Listen for 'tails'…", `field_schema.json:713`) is **never forwarded** to Sonnet. With "tails"+"cable" semantics and no steering, Sonnet picked the key whose label contains "cable" (`sub_main_cable_csa`).
- Correct field EXISTS: `main_switch_conductor_csa` — label "Main Conductor CSA (mm²)" with `ai_guidance` "Size of meter tails … Listen for 'tails'" (`field_schema.json:708-713`). **No schema addition needed.**
- The only correct "tails" mapping (`src/extract_chunk.js:31`) is on the legacy non-live path.
- iOS regex was already correct (`TranscriptFieldMatcher.swift:642-643` tails→`mainSwitchConductorCsa`) but Sonnet wrote a *different* (wrong) key, so it populated a separate slot rather than overwriting.

### Fix #2
1. **[shared-prompt]** Add tails steering to `config/prompts/sonnet_agentic_system.md` near the `main_switch_*` block (~:140): *"'tails'/'meter tails'/'main tails'/'tails are X mil' → `main_switch_conductor_csa` (bare number). Do NOT use `sub_main_cable_csa` for supply tails into the main board — that key is ONLY for cable feeding a separate sub-main/sub-distribution board."* Cert-agnostic; one cached-prefix edit; no iOS twin (this isn't the Schedule-of-Inspections prompt that needs `EICRHTMLTemplate.swift` mirroring).
2. **[BE-safe, optional]** Dispatcher guard in `stage6-dispatchers-board.js`: reject/redirect a `sub_main_cable_csa` write when the active board is the single `main` board (no sub-boards exist).

---

## DEFECT #3 — Ring continuity couldn't resolve "the sockets" → circuit 2  [echo + DEEPER data gap]

**Marker (11:54:43):** "ring continuity for the circuits … then went around the houses several times asking what circuit it was for."

### Root cause (two layers)
Live path = dialogue engine (`sonnet-stream.js:82,3463` → `dialogue-engine/index.js:65-67` → `engine.js` + `schemas/ring-continuity.js`). The legacy `ring-continuity-script.js` is NOT live (the "dead code" comment at `schemas/ring-continuity.js:30-39` is STALE — delete it).

1. **The matcher is correct, but the server snapshot had no designation to match.** `findCircuitsByDesignation` (`helpers/circuit-resolution.js:74`, bidirectional substring on normalised lowercase, `:108/:126`) WOULD match "sockets" against designation "Sockets". But CloudWatch shows `entry_designation_matched:false, designation_candidates:[]` at 11:51:58 and again on the retry — the server-side circuit-2 bucket had an **empty `circuit_designation`**. Cause: create/rename churn (`create_circuit(ref:2)` carried no designation; `rename_circuit(2→3)` moved the bucket; `upsertCircuitMeta` only writes designation when non-null, `stage6-snapshot-mutators.js:126`). "Sockets" existed only in iOS client telemetry — it never crossed the wire to the server snapshot. **This is a cross-platform data-contract gap [contract].**
2. **Garbled echo question.** When the which-circuit answer doesn't resolve, `buildCircuitRetryQuestion` (`engine.js:394-401`) interpolates the RAW transcript (`state.last_designation_attempt`, set verbatim `:1136-1137`) → "What's the circuit number for the **For the sockets.**?". No filler strip, no re-resolve. **Shared with IR** (produced "…for the The socket.?" at 11:55:14).

### Fix #3
1. **[BE-safe]** Strip leading articles/filler ("for the"/"the"/"a"/"on the") and trailing period from the USER text ONLY, at `src/extraction/dialogue-engine/helpers/circuit-resolution.js:79` (the single `normalised = text.toLowerCase().replace(/\s+/g,' ').trim()` line, which feeds BOTH the array-shape and dual-shape match loops). Do NOT touch `:104/:122` — those read the stored designation (`circuit_designation || designation`), not user input, and must not be stripped. Result: "For the sockets." → "sockets" resolves *when the designation is present*.
2. **[BE-safe]** Fix the echo: in `src/extraction/dialogue-engine/engine.js:394-401` apply the same strip to `designationAttempt`, or fall back to the bare `schema.whichCircuitQuestion` when the stripped attempt is still non-numeric/unresolvable — never echo raw text. Store the stripped form at `:1137`. Benefits ring + IR + protective-device family.
3. **[BE-safe]** The one-retry re-resolve ALREADY exists (`engine.js:1107-1137`, the `circuit_retry_attempted` flag added 2026-04-30 for the designation-not-yet-written race — re-asks once, next turn re-runs `findCircuitsByDesignation` against the then-current snapshot). No new retry mechanism needed; verify this existing path resolves once the strip fix (#3.1) lands, and only extend it if a single retry proves insufficient.
4. **[contract — surface to Derek]** The upstream cause: iOS holds the circuit designation but `create_circuit`/`rename_circuit` to the server never carried it, so server-side resolution had nothing to match. Investigate why designation doesn't reach `upsertCircuitMeta` server-side. Do NOT bundle into the BE-safe fixes — this changes what iOS pushes. (Fixes 1-3 make resolution land *once the data is present*; fix 4 makes the data present.)

---

## DEFECT #4 — Insulation-resistance loop refires on "LIM"  [decided]

**Marker (11:56:18):** "tried to enter the IR loop … said LIM for live-to-live … did not accept it … continuously asked the same question." **REPEAT of 2026-02-18 request** ("LIM/Lynn/limb not an acceptable reading — could it be added?"). Also 2026-06-08 ("main fuse to LIM" rejected).

### Root cause (three layers)
1. `parsers/megaohms.js` `parseMegaohms()` (`:27-56`) DELIBERATELY returns null for LIM/limit/limitation (comment `:19-22`). Deepgram garbles spoken "LIM"→limitation/limb/limp/Lynn — none parse → L-L slot never fills.
2. `engine.js` `askNextOrFinish()` (`:1551-1616`) re-asks the same slot question with NO attempt cap (the disambiguation path `:816-852` caps at one retry; the slot path doesn't) → infinite loop until a cancel word.
3. The spoken feedback ("…live to live … is limp") re-matched the IR entry trigger and re-armed the loop a second time.

**Decisive:** `src/extraction/dialogue-engine/parsers/megaohms.js` `parseMegaohms` is the ONLY place rejecting LIM in the IR path. Sentinel acceptance elsewhere: `src/extraction/value-normalise.js:107` (+comments 9/130/165), `src/extraction/stage6-answer-resolver.js:607`, `config/prompts/sonnet_full_transcript_system.md:39-40` (lists the exact garbles, "always normalise to LIM"). **Caveat (verify at execution):** `src/extraction/record-reading-coercion.js:245` (`'lim'|'limitation'→'LIM'`) only runs for board PASS-check fields (`:131-138`, `:238-245`), NOT for `ir_live_*_mohm` — so a Sonnet `record_reading`/`start_dialogue_script.pending_writes` value like "limitation" can still bypass IR canonicalisation. The "separate limitation flow" the parser comment defers to does not exist.

### Fix #4
1. **[BE-safe]** In `src/extraction/dialogue-engine/parsers/megaohms.js`, add a LIM branch (after greater-than + OL/saturation, before numeric) returning `"LIM"` for `/\b(?:lim|limb|limp|limit(?:ation|ed)?|lynn|lym)\b/i` (garble set per `sonnet_full_transcript_system.md:39` + "limp" seen here). Add a word-anchored LIM alternation to **both** `MEGAOHMS_VALUE_GROUP` and `MEGAOHMS_BARE_SAFE_VALUE_GROUP` so named extractors ("live to live LIM") catch it. Update the EXCLUDED comment block (`megaohms.js:19-23`) to document the reversal + cite the field reports. NOTE `megaohms.js:24-25` asserts byte-identical-replay parity with legacy `insulation-resistance-script.js` `parseValue` (`:211-254`) — this is a documented HARD invariant, not optional: confirm/update the replay-corpus expectation and sync `parseValue` in the same change so the corpus stays green.
2. **[BE-safe]** Widen IR-field LIM coercion in `coerceRecordReadingValue` (`src/extraction/record-reading-coercion.js`) to cover `ir_live_live_mohm` and `ir_live_earth_mohm`: `lim/limb/limp/limit/limitation/limited/lynn/lym` → `LIM`. This closes the `record_reading`/speculator bypass. Also apply the same coercion to dialogue-engine `pending_writes` before they are stored: in `src/extraction/dialogue-engine/engine.js`, canonicalise IR-slot values (call `coerceRecordReadingValue(w.field, w.value)`) before `validWrites.push` (~`engine.js:1960`, validation block `:1948-1961`) AND before any queued `pending_writes` are drained (`:1071`, `:2230`) — `pending_writes` are written directly via `applyWriteWithDerivations`/`applyWrite` (`:2000-2001`) and do NOT pass through `coerceRecordReadingValue` today, so a `start_dialogue_script.pending_writes` value of "limitation" would otherwise still store non-canonically. Add dispatcher/speculator tests proving `record_reading` stores canonical `LIM`, AND a `start_dialogue_script.pending_writes` test for `ir_live_live_mohm:"limitation"` → `"LIM"`.
3. **[BE-safe]** Add a per-slot no-progress cap in `src/extraction/dialogue-engine/engine.js`: track consecutive unparseable answers per asked slot; on 2nd miss emit a one-line hint ("Say a number, 'greater than X', or 'LIM' — or say skip."); on 3rd miss add to `state.skipped_slots` and fall through to Sonnet. Reset on fill / slot change. Independent of LIM — closes the loop for ANY garble.

---

## DEFECT #5 — "Swap circuits 3 and 4" left junk circuit 999 "(temp)"  [no atomic swap tool]

**Marker (11:58:15):** "added circuit 999 after the IR loop reading … why is it downstairs like temporary?"

### Root cause
There is **NO atomic swap/reorder tool** (verified: zero `swap`/`reorder` in `stage6-tool-schemas.js`/dispatchers/prompt; the stale memory note is wrong). Circuit movers are `create_circuit` (`:288`), `rename_circuit` (rekey, `:338`), `delete_circuit` (`:692`). A direct two-call rekey swap is BLOCKED by `validateRenameCircuit` `target_exists` (`stage6-dispatch-validation.js:283-288`), forcing a swap-via-temp. Sonnet parked a scratch `circuit 999 "Downstairs Light (temp)"`, swapped the names (c3↔c4 designations DID end up correct), but never ran the cleanup leg (no `delete_circuit(999)`). Ref 999 is model-invented (not a code sentinel; the only 999 in code is the IR meter `>999` value). `validateCreateCircuit` (`:241-252`) has no ref plausibility bound, and there's no temp/orphan cleanup — so 999 persisted and later fired `ASK[out_of_range_circuit c999]` at 11:58:39. The pending IR-timeout re-ask (prepended server note, `sonnet-stream.js:3581-3596`) split Sonnet's attention that turn — a stressor, not the root cause. No swap/placeholder guidance exists in `sonnet_agentic_system.md`.

### Fix #5
1. **[shared-prompt] PRIMARY** Add SWAP/REORDER rule to `sonnet_agentic_system.md` (near CIRCUIT NAMING `:52-54`): *"To swap two circuits' designations, issue two `rename_circuit` calls that only change `designation` (from_ref === circuit_ref each), exchanging the names. NEVER create a placeholder/temp circuit or use an improbable ref (e.g. 999) as scratch. `create_circuit` is only for circuits the inspector named."* Emits only plain `rename` ops iOS already applies → no new message type, no parity work.
2. **[BE-safe] SECONDARY** Add a ref-plausibility reject to `validateCreateCircuit` (`stage6-dispatch-validation.js:241`): compute `maxExistingRef` for the active board and reject `input.circuit_ref` when it is `>= 100` OR `> maxExistingRef + 20`, UNLESS the circuit already exists. Return `{code:'implausible_circuit_ref', field:'circuit_ref', max_existing_ref: maxExistingRef, hint:'Do not create scratch/temp circuits for swaps; update existing circuit designations with rename_circuit.'}`. Add tests: ref 999 rejected, next normal ref accepted. (Adjust the `>= 100` cap only if the project has a known higher max circuit count — state it here if so.) Stops any future scratch-ref improvisation; iOS already tolerates rejected ops.
3. **[contract] DEFER** an atomic `swap_circuits`/`reorder_circuits` tool — it emits a new op the iOS applier routes to `default:`/`unknownOps` (`DeepgramRecordingViewModel.swift:6564-6568`), so it would silently no-op until a companion TestFlight ships. Not worth it: fix 1 makes a designation swap fully expressible today. Revisit only for true positional reorder (moving readings, not just names).

---

## 2. Shared dialogue-engine work (covers #3 + #4 + #5-adjacent)
- `helpers/circuit-resolution.js` filler-strip (#3.1) + `engine.js:394-401` echo fix (#3.2) + `engine.js` no-progress cap (#4.3) all live in the same engine and benefit ring/IR/RCD/protective-device schemas. Land together, one test pass.
- Delete the stale "currently dead code" comment in `src/extraction/dialogue-engine/schemas/ring-continuity.js:30-39`. (`schemas/insulation-resistance.js` has no matching stale comment; if an IR twin is found later, name its exact file:line before deleting.)

## 3. Parity / contract matrix
| Fix | Tag | iOS work? |
|---|---|---|
| #1.1/#1.2/#1.3 feedback dual-route + timeout + earthing regex | [iOS] | Yes — TestFlight |
| #1.4 earthing prompt garble line | [shared-prompt] | No (render-only) |
| #2.1 tails prompt steering | [shared-prompt] | No |
| #2.2 sub_main dispatcher guard | [BE-safe] | No |
| #3.1/#3.2/#3.3 engine designation+echo | [BE-safe] | No |
| #3.4 designation not persisted server-side | [contract] | **Surface to Derek first** |
| #4.1/#4.2/#4.3 LIM parser + IR-field coercion + no-progress cap | [BE-safe] | No |
| #5.1 swap prompt rule | [shared-prompt] | No |
| #5.2 ref-plausibility guard | [BE-safe] | No |
| #5.3 atomic swap tool | [contract] | DEFER (needs iOS handler) |

## 4. Test plan
- **#4** `parseMegaohms` LIM/garbles → "LIM"; unrelated words still null; >N/OL/numeric unchanged. Named extractor "live to live LIM"/"L-L is limb"→LIM. `coerceRecordReadingValue` stores canonical "LIM" for `ir_live_*_mohm` given "limitation". Replay corpus stays green (legacy parseValue synced). Engine: 3 consecutive unparseable → hint on 2nd, skip/fallthrough on 3rd, reset on fill.
- **#3** `findCircuitsByDesignation`/strip: "For the sockets."→resolves c2 when designation present; retry question never contains raw "for the". Engine retry re-resolves against updated snapshot.
- **#5** `validateCreateCircuit` rejects implausible ref; prompt-rule covered by a tool-loop fixture asserting two rename-meta calls, no create_circuit, for "swap 3 and 4".
- **#2** prompt fixture: "tails are 25mm" → `main_switch_conductor_csa`, not `sub_main_cable_csa`.
- **#1** iOS: `TranscriptFieldMatcherTests` earthing "t n s"/"t and s"→TN-S; feedback-capture dual-route test; capture auto-timeout test.
- Full backend `npm test` green; iOS `xcodebuild test` green (note known stale `TranscriptFieldMatcherTests` failures — don't blind-fix).

## 5. Sequencing & deploy
1. **Backend wave** (no iOS dep): #4.1+#4.2+#4.3, #3.1+#3.2+#3.3, #5.2, #2.2, plus shared-prompt #2.1+#5.1+#1.4 (one prompt commit, flagged cross-platform). `npm test` → push `main` → **CI / GitHub Actions only** (`gh run watch`); **never** use the local `./deploy.sh` quick-deploy for backend.
2. **iOS wave**: #1.1+#1.2+#1.3, plus any rendering for prompt changes (none expected). `xcodebuild test` → `./deploy-testflight.sh` per the auto-push policy, respecting the known stale `TranscriptFieldMatcherTests` gate (do NOT blind-fix stale expectations).
3. **Surface separately to Derek** before touching: #3.4 (designation not crossing the wire) and #5.3 (atomic swap tool). Both are [contract].

## 6. Out of scope (noted, not in this plan)
- Stale `field_matched ze 0.30` re-emitting on unrelated utterances (iOS regex echo) — benign here, separate triage.
