# Extraction-bypass sprint v8 — Phase D dropped, A/B/C from v6 retained

**Date:** 2026-05-28
**Iteration:** v8 (folds claude-review-v7's 2 BLOCKERs + 2 IMPORTANTs + 2 MINORs)
**Sprint scope:** **3 phases** (back to v6 scope), ~5–7 days end-to-end
**Branches:** `regex-bypass-backend`, `regex-bypass-ios`, `soi-tool-lookup`, `observation-tts-bridge`

v8 is the SHIPPABLE plan. PLAN_v6 closed at 0 BLOCKERs from both reviewers; PLAN_v7 introduced a Phase D that misread the live system and was rejected by the v7 reviewer. v8 drops Phase D and folds the measured cost data from §0 directly onto v6's converged Phases A/B/C.

## 0. v7 → v8 changelog

| # | v7 problem | v8 fix |
|---|---|---|
| BLOCKER 1 | §4.1 said walkthrough entries are Sonnet-driven. Wrong — `src/extraction/dialogue-engine/engine.js → processDialogueTurn → detectEntry` already does deterministic server-side walkthrough entry on most entry turns BEFORE Sonnet runs. Verified at `sonnet-stream.js:3334-3408`. | Phase D removed from sprint scope. The "5 walkthrough-entry turns saved per 86-turn session" claim was unverified. Pulled actual `start_dialogue_script` invocations from CloudWatch (see §0.1) — real count is 3 per long session, mostly Deepgram garbles that the server's regex misses. |
| BLOCKER 2 | §4.5's cost estimate ("$0.09 additional per 86-turn session") was undocumented and probably wrong. | Replaced with measured data: 3 actual `start_dialogue_script` calls in the 86-turn session = at most $0.054/session if iOS could catch them all. Phase D's marginal value at current scale is not worth the iOS work. Documented as a future enhancement, not in this sprint. |
| IMPORTANT 1 | "iOS regex already has ring continuity language regex (TranscriptFieldMatcher.swift:257)" — that regex matches ring READINGS (lives/neutrals/earths), not entry triggers. | Phase D dropped. If revisited later, the iOS PR adds NEW trigger-phrase regexes; doesn't extend the readings regex. |
| IMPORTANT 2 | `tryServerInitScript` claim — the function already exists as `enterScriptByName` at `dialogue-engine/engine.js:1609`. v7 proposed "lifting" code that's already separated. | If Phase D is revisited later, the iOS handler in `sonnet-stream.handleTranscript` is a ~10-line call site invoking the existing `enterScriptByName`, NOT a re-implementation. |
| MINOR 1+2 | Wire-shape doc + double-detection ordering. | Out of scope until Phase D is re-spec'd. |
| (NEW) | v7's measured-data table assumed "single-round early-terminated turns" = "bypass-eligible turns" as a clean 1:1 proxy. v7 reviewer flagged this as overstating: some early-terminated turns still fail eligibility rule #6 (`in_response_to`) or rule #7 (script processor modified transcript). | v8 §0.2 adds an explicit caveat about the proxy. Shadow-mode telemetry on Day 1 is the actual measurement step — v8's saving estimates are upper bounds until that data lands. |

## 0.1 Existing server-side infrastructure (what v7 missed)

Verified by reading the actual source. **This is already in production:**

| Capability | Where | What it does |
|---|---|---|
| `detectEntry` for ring continuity | `src/extraction/ring-continuity-script.js:178` | Regex `ring continu(?:ity\|ance\|ancy\|ed\|e)\|final` with circuit-number tolerance. Fires server-side when a transcript matches — no Sonnet call. |
| `detectEntry` for IR | `src/extraction/insulation-resistance-script.js:109-114` | Head-word alternation `(?:insulation\|installation\|international)` + value-shape detection. Catches "Installation resistance" garbles. |
| `detectEntry` for protective devices | `src/extraction/dialogue-engine/index.js:85` + schemas | OCPD / RCD / RCBO entry detection. |
| `enterScriptByName` (shared init helper) | `src/extraction/dialogue-engine/engine.js:1609` | Pure function: validates circuit_ref against snapshot, idempotent on already-active, validates pending_writes, seeds snapshot values, emits first ask via `askNextOrFinish`. **Already factored out of the Sonnet dispatcher path.** |
| Server-side ElevenLabs TTS for regex hits | `src/routes/voice-latency-fast-tts.js` | POST `/api/voice-latency/regex-fast-tts`. Composes confirmation text from regex hit + snapshot, generates audio via ElevenLabs server-side. **Already live in production** for the 5 whitelisted fields. |
| iOS designation→ref resolution | `TranscriptFieldMatcher.swift:1420, :1468` + `designationMap:1184` | Inspector says "cooker" → iOS looks up Cooker's ref from the schedule. Writes to `circuitUpdates[ref]`. |
| Stage 6 live mode does NOT replay conversationHistory | `stage6-shadow-harness.js:373-379` | Each Sonnet call starts from a single-message window. Snapshot is the cumulative state. |

**Sonnet `start_dialogue_script` is the FALLBACK** for when these server-side detectors miss (Deepgram garbled past the regex, inspector paraphrased unrecognisably). Tool description at `stage6-tool-schemas.js:777` says exactly this.

## 0.2 Measured production data (3 sessions, 113 turns)

| Session | Date | Turns | Total $ | Single-round early-terminated turns | Sonnet `start_dialogue_script` calls |
|---|---|---|---|---|---|
| DFE90C4F | 2026-05-28 | 13 | $0.33 | 7 (54%) | 0 |
| C61473FD | 2026-05-27 | 24 | $0.58 | 10 (42%) | 1 |
| 33E6613D | 2026-05-26 | 76 | $2.66 | 15 (20%) | 3 |
| **All 3** | | **113** | **$3.57** | **32 (28%)** | **4** |

**Bypass-eligible proxy: single-round early-terminated.** Honest caveat: some of these turns still fail eligibility rule #6 (`in_response_to`) or rule #7 (script processor modified transcript). The real bypass rate is probably **20-25% in production**, not 28%. Shadow-mode telemetry on Day 1 is the actual measurement.

**Walkthrough-entry savings already captured by the existing `detectEntry`:** the 76-turn session had multiple walkthroughs (ring continuity, IR L-L and L-E for all circuits, OCPD for several circuits) — but only 3 of those reached Sonnet via `start_dialogue_script`. The other ~5–10 walkthrough entries were handled server-side without Sonnet. **This is already happening today.**

## 0.3 Revised cost projection (v8 — replaces v7 §0.1)

| | v8 (honest) | At launch scale (100 inspectors × 6/day) |
|---|---|---|
| Phase A | $0.06–$0.15/session (with proxy haircut) | **£13k–£33k/year** |
| Phase A + B | $0.07–$0.17/session | **£15k–£37k/year** |
| Phase A + B + C | same + UX | UX improvement on observations |

At current 6-session/day usage: ~£0.50–£1.00/day saved.
At launch: meaningful but smaller than v7 claimed (because v7 inflated Phase D's contribution).

**Worth shipping.** £15k+/year recurring at launch scale justifies a 5-7 day sprint.

---

## 1. Phase A — Skip Sonnet on regex-clean turns

**Inherited verbatim from PLAN_v6 §2.** All v6 corrections (1 BLOCKER + 4 IMPORTANT + 5 MINOR review fixes) carry forward. Specifically:

- iOS PR: enriched `regexResults` wire shape — `{field, value, circuit?, board_id?}` with canonical backend field names. Three sites: `TranscriptProcessor.buildRegexSummary`, `DeepgramRecordingViewModel.buildRegexSummary` wrapper (~line 2312), `applyRegexMatches` circuit-hint loop (lines 4047-4072 — adds inserts for 5 fast-eligible keys).
- `RegexFieldNormaliser.swift` parity surface; backend `config/regex-field-normalisation.json`; CI parity check.
- iOS `session_start` sends `client_build_version`; backend captures into `entry.clientBuildVersion`.
- Backend bypass at `sonnet-stream.js:~3765` (just before `runShadowHarness` at 3766, after the overtake-classifier block).
- `originalTranscriptText` captured at line 3258.
- Bypass uses real `_mergeIncomingJobStateIntoSnapshot` (extended in v6 §2.0d with INSTALLATION_DETAILS branch).
- `stampSeenTranscript()` closure reused for dedupe ledgers.
- Eligibility uses `entry.pendingAsks.size > 0` not `session.askedQuestions`.
- `REGEX_BYPASS_MODE` env var: `off | shadow | live`.

## 2. Phase B — SoI as lookup tool

**Inherited verbatim from PLAN_v6 §3.** All v6 corrections carry forward. Specifically:

- 16-tool `_BASE_TOOL_SCHEMAS_ARRAY` explicitly enumerated.
- `READ_DISPATCHERS` map alongside `WRITE_DISPATCHERS`; `createToolDispatcher(writes, asks)` factory updated to route reads first.
- `lookup_inspection_item` schema with `item_ref: ^[0-9]+(?:\.[0-9]+)+$`.
- `dispatchLookupInspectionItem(call, ctx)` returns `{tool_use_id, content, is_error}` envelope; uses `ctx?.session?.sessionId`.
- Module-init constant split: `EICR_AGENTIC_SYSTEM_PROMPT_FULL_SOI` + `EICR_AGENTIC_SYSTEM_PROMPT_DIRECTORY`; constructor picks via `_selectSystemPrompt`.
- `applyModeChange` rederives system prompt using the same helper.
- `SOI_TOOL_ENABLED` env var, latched at construction.

## 3. Phase C — TTS bridge

**Inherited verbatim from PLAN_v6 §4.** iOS-only; bundled audio asset; observation trigger detection via the canonical lexicon at `config/observation-triggers.json`.

## 4. Sequencing

Carried from PLAN_v6 §5:

| Day | Branch | Activity |
|---|---|---|
| 0 | iOS | Phase A wire-shape change. TestFlight internal install. |
| 1 AM | backend | Phase A server. `REGEX_BYPASS_MODE=shadow`. |
| 2 AM | — | Read shadow telemetry. Canary if eligible. |
| 2 PM | — | Phase A canary. iPad session. |
| 3 AM | — | Phase A fleet flip if green. |
| 3 PM | backend + iOS | Phase B + C parallel. |
| 4 | — | Phase B + C canary. |
| 5 | — | Fleet flip B + C if green. Buffer day. |

---

## 5. Future enhancement (out of scope this sprint): Phase D backstop

Documented separately so it isn't lost. **Not in v8 sprint scope.**

Open question: should iOS regex catch a tighter superset of trigger phrases than the server's `detectEntry`, so the `start_dialogue_script` Sonnet call rate drops further?

Today: server `detectEntry` patterns catch ~70-80% of walkthrough entries; Sonnet's `start_dialogue_script` handles the remaining ~20-30% (3 per 76-turn session in the measured data).

Measured residual: 4 `start_dialogue_script` calls across 113 turns = ~$0.07 across the 3 sessions. Per long session: ~$0.05.

**Why not in this sprint:**
- iOS work (regex extension + bundled trigger lexicon) takes 1-2 days.
- TestFlight cycle adds calendar days.
- Saving is ~$0.05/session = £1/day current scale = ~£365/year. £15k/year at launch.
- Compared to Phase A's £15k+/year for similar effort, the marginal return is small.

**When to revisit:**
- After Phase A ships and the shadow-telemetry data gives a real bypass-rate measurement.
- If the `start_dialogue_script` rate stays high (>5% of Sonnet calls) — strong signal that iOS-side backstop is worth the work.
- If the iOS regex optimiser independently grows trigger-phrase coverage, the backstop becomes a free byproduct.

**If pursued later:**
- iOS regex pattern additions for ring/IR/OCPD trigger phrases that the server's existing patterns miss.
- iOS sends `dialogue_script_intent: {type, circuit, pending_writes}` on the WS message alongside `regexResults`.
- Backend handler in `sonnet-stream.handleTranscript` calls existing `enterScriptByName({...})` directly. ~10 lines of glue. No new dispatcher, no new shared helper — the function is already factored.
- Eligibility: defer to Sonnet when iOS confidence is low, when another script is active, or when the trigger phrase is also a valid one-shot reading ("Circuit 4 BS-EN 60898").
- Rollout: same shadow → canary → fleet pattern as Phase A.

---

## 6. Reviewer audit trail (v8)

- [x] v1 → v6: 5 review iterations, ended at 0 BLOCKERs from both Claude self-review and Codex CLI.
- [x] v7 attempted Phase D addition; rejected by Claude review (2 BLOCKERs — Phase D misread the live system).
- [x] v8 drops Phase D, retains v6's converged Phases A/B/C, and folds in the measured production data.

v8 is the shippable plan. No further review pass needed for Phases A/B/C (already 0-BLOCKER converged in v6). If Phase D is revisited later, that's a separate sprint with its own review cycle.

---

## 7. ElevenLabs TTS server-side — clarification

The user asked: "is there a plan to fire ElevenLabs TTS from the server?"

**Answer: yes, it already exists.** `src/routes/voice-latency-fast-tts.js` is the route. It fires for the 5 whitelisted fields whenever iOS POSTs a regex hit. v8's Phase A integrates with this — when bypass triggers, the fast-TTS path still fires for the audible confirmation. No new TTS path needed.

## 8. Walkthroughs server-side — clarification

The user asked: "the walk-throughs should be triggered server-side too. If the entry into the walk-throughs is garbled Sonnet should start a walk-through but ideally would be started by regex."

**Answer: this is already how the system works.** `detectEntry` in the dialogue engine fires server-side on most trigger phrases. Sonnet's `start_dialogue_script` is the documented fallback for garbled / paraphrased entries that the server's regex misses. The mechanism the user is describing is in production.

The OPEN question is whether iOS should backstop the server's `detectEntry` for garbled entries (e.g. Deepgram drops "Ring" from "Ring continuity for sockets" → "continuity for the socket"). v7 tried to make this Phase D and got the architecture wrong. v8 documents it as a future enhancement (§5) — small marginal saving, not worth the sprint cost now.
