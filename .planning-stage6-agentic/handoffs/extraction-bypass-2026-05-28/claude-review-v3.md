# Claude self-review v3 — extraction-bypass PLAN_v3.md

## Verdict
NEEDS REWORK
4 BLOCKERs, 4 IMPORTANT, 3 MINOR

v3 closes the conceptual gaps from v1/v2 (no more synthetic conversationHistory writes, single source of merge truth, bypass inside the existing lifecycle). But several concrete claims about the codebase are still wrong: shared-types is types-only (no `Object.freeze`'d runtime maps); iOS does not consume shared-types at build time (the existing parity pattern reads `config/field_schema.json` and diffs Swift sources); circuit-level regex values are deliberately NOT persisted to iOS `job` state, so the proposed `readValueFromFieldSources` cannot return a value for `circuit.<ref>.zs` keys; the dedupe-ledger stamping snippet uses wrong arguments versus the existing `stampSeenTranscript()` closure; v3 invents `entry.activeScript` / `entry.pendingTimeoutNote` for a check whose real state lives on `session.ringContinuityScript` / `session.insulationResistanceScript` / etc.; `LOOKUP_INSPECTION_ITEM_TOOL` is referenced but never defined; the SoI lives inside `EICR_AGENTIC_SYSTEM_PROMPT` baked at module load, so the Phase B prompt-rebuild story is unspecified.

Iteration note: v3 is converging on the right approach (real merge, shadow-first, iOS+backend coordinated). The remaining BLOCKERs are concrete implementation-detail mismatches, not architectural rewrites. One more iteration that names actual code symbols (not invented ones) should be enough.

## Findings

### BLOCKER 1 — Shared-types path and iOS consumption are misdescribed

v3 §2.0b proposes `packages/shared-types/src/regex-field-normalisation.ts` exporting `Object.freeze`'d runtime objects, with iOS picking the file up via "build-time copy via existing shared-types path."

Two problems with the concrete file:
- `packages/shared-types` is a TypeScript types-only package (`packages/shared-types/src/index.ts` re-exports `type * from ...`, plus a handful of zod schemas). There is no precedent for `Object.freeze`'d runtime maps living there — the existing schemas in `schemas.ts` would be the only runtime export, and they're zod, not frozen literals. `package.json` declares `"main": "src/index.ts"` (TypeScript directly) with no build step — server code consumes via tsc-on-demand or via shared-utils' compiled equivalent. Putting a runtime map here works at runtime in Node but adds an inconsistency the v3 plan should at least call out.
- iOS does not consume `@certmate/shared-types` at all. Grep shows zero Swift references; the only matches are planning docs. The existing cross-platform parity pattern is `scripts/check-ios-field-parity.mjs` which loads `config/field_schema.json` (a checked-in JSON file at repo root, NOT shared-types) and parses `DeepgramRecordingViewModel.swift` to diff the case literals. There is no "build-time copy via shared-types" mechanism.

`packages/shared-types/src/observation-triggers.ts` (§2.0c) inherits the same gap.

**Fix:** Pick one of:
- Land the canonical maps in `config/` as JSON (matches the existing `field_schema.json` precedent), expose via a tiny loader in `src/extraction/`. Add a `scripts/check-ios-regex-normaliser-parity.mjs` modeled on the field-parity script.
- Or commit to changing the parity story: build an actual codegen step that emits a Swift file from shared-types and add it to the iOS build phase. That's significantly more work and is out of scope for a 5–7 day sprint.

Either way, v3's "shared-types parity check exists already for shared-types; this just adds a new file" claim is wrong — there is no parity check for shared-types today; the parity check that exists targets `field_schema.json`. Cite the actual mechanism.

---

### BLOCKER 2 — `readValueFromFieldSources` cannot return circuit values; iOS regex does not persist them

v3 §2.0a shows `buildRegexSummary` calling `readValueFromFieldSources(key, job: job)` and assumes it returns a value for every key in `writtenKeys`. But `applyRegexMatches` in `DeepgramRecordingViewModel.swift:4047-4072` explicitly comments: "Circuit creation and circuit field updates removed from regex path… However, circuit regex hints ARE forwarded to Sonnet as context." For every `circuit.<ref>.<field>` key in `thisTurnRegexWrites` (Zs, R1R2, IR, OCPD rating, OCPD type, OCPD BS-EN, RCD type) the code stamps `fieldSources[key] = .regex` but never writes the value into `job.boards[?].circuits[?]`.

The value exists in-memory inside `result.circuitUpdates[circuitRef]` during the `applyRegexMatches` call, but it is discarded after `jobVM.job = job` runs. There is no `readValueFromFieldSources` helper that can recover it from `job`.

Net consequence: with v3 as written, every circuit-scoped bypass-eligible hit (i.e. the only hits the regex-fast-eligibility whitelist actually covers — `measured_zs_ohm`, `r1_r2_ohm`, `ir_live_earth_mohm`, `ir_live_live_mohm`, `number_of_points`) ships with `value: nil` and falls into v3's backwards-compat path ("missing value → no bypass eligibility"). Bypass rate would be 0 % for the only fields that matter.

Supply / board / installation fields are stored on `job.supplyCharacteristics` and `job.boards[0]` and on `job.installationDetails`, so a hand-written mapper from each `supply.*` / `board.<id>.*` / `install.*` key to the right property path is feasible. But supply/board/install fields are not in the regex-fast-eligibility whitelist (§2.1 rule #1), so they're not bypass candidates either.

**Fix:** Either
- Refactor `applyRegexMatches` to also persist circuit-level regex values into `job` before returning (changes the existing "circuit creation removed from regex path" contract — needs cross-platform sign-off because the existing comment block explicitly chose the opposite).
- Or change `buildRegexSummary` to read directly from the `MatchResult` (`result.circuitUpdates[ref].measuredZs` etc.) which still has the values at the call site. The summary already runs inside the `applyRegexMatches` body and would have access to the result struct if plumbed through — that's a smaller change than persisting to `job`.

Decide which BEFORE the iOS PR lands; the wire shape v3 promises is unbuildable without one of these.

---

### BLOCKER 3 — Dedupe-ledger stamping snippet does not match the existing helper

v3 §2.5 bypass body shows:
```
seenTranscriptUtterances.add(transcriptText);
recentTranscripts.push({...});
```

`entry.seenTranscriptUtterances` is keyed on `msg.utterance_id` (a string), NOT raw `transcriptText`. `entry.recentTranscripts` holds `{normalisedText, expiresAt, utteranceId}` records where `normalisedText = normaliseForAskMatch(msg.text)`, plus FIFO eviction at `RECENT_ASK_ANSWER_CAP`. The existing handler centralises this in the `stampSeenTranscript = () => {...}` closure built at `sonnet-stream.js:3143-3179` and called at `:3870` after `runShadowHarness` succeeds.

If v3's bypass implementation is taken literally, the Set ends up keyed by transcript content (wrong shape; existing dedupe lookups by utterance_id would all miss); `recentTranscripts` entries lose normalisation, TTL, and FIFO eviction; both rationales the existing comment block describes (Plan 03-12 r13 Codex MAJOR, r18 MAJOR#2) get re-broken on the bypass path.

**Fix:** v3's pseudocode should call the existing `stampSeenTranscript()` closure, not inline a wrong-shape variant. If the closure can't be reused as-is from outside its parent scope, hoist it (or hoist its body into a small helper) — but specify that, don't paste pseudocode that does the wrong thing.

---

### BLOCKER 4 — `LOOKUP_INSPECTION_ITEM_TOOL` is referenced but never defined

v3 §3.3 references `LOOKUP_INSPECTION_ITEM_TOOL` as if it's a thing that already exists or whose shape is obvious. Grep across `src/extraction/` returns zero matches — there is no schema draft, no input properties, no dispatcher. The plan also doesn't describe how Sonnet learns to use the tool (no prompt update, no system-block change), so absent a tool description Sonnet would never call it.

Phase B's whole saving argument hinges on Sonnet routing observation traffic through the lookup tool rather than reading the inline SoI. With no schema and no prompt instruction, that doesn't happen.

**Fix:** Either include the schema + properties + dispatcher in PLAN_v3, or move Phase B explicitly to "design tbd" rather than "implementation timeline Day 3–4." A tool schema is not optional plumbing — the model needs the `description` text + property doc to know when to call it.

Related: v3 §3.3 inserts `this.systemPrompt = this._buildSystemPrompt(); // lazy` and calls it as a method. There is no `_buildSystemPrompt` method on `EICRExtractionSession` today. The current code computes the prompt at module-load (`eicr-extraction-session.js:899`: `export const EICR_AGENTIC_SYSTEM_PROMPT = _AGENTIC_BASE_PROMPT.trimEnd() + '\n\n' + _SCHEDULE_OF_INSPECTION_EICR`) and the constructor selects it with a ternary against `toolCallsMode` (`:944-949`). A "lazy" prompt path requires either splitting the constant (base + SoI) and rebuilding per-session in the constructor, or adding a real per-session prompt builder. The current v3 §3.3 pseudocode skips the part that actually makes the rollback work.

---

### IMPORTANT 1 — `entry.activeScript` and `entry.pendingTimeoutNote` are invented names

v3 §2.1 rule #8 references `entry.activeScript` and `entry.pendingTimeoutNote` with a note "or whatever the actual session-state shape is — verify at implementation." The actual state names are:
- `session.ringContinuityScript` (`src/extraction/ring-continuity-script.js:347`)
- `session.insulationResistanceScript` (implied by the parallel structure at sonnet-stream.js:3371-3385)
- `session.protectiveDeviceScript` (implied by the parallel structure at :3387-3408)
- Timeout notes are not held in a session field at all — they're constructed inline as `ringNote` / `irNote` and prepended to `transcriptText` (`sonnet-stream.js:3429-3460`). There is no `pendingTimeoutNote` to read; you'd have to either (a) move the bypass after the note-construction, (b) re-derive whether a note WOULD be prepended by calling `findExpiredPartial(entry.session)` + `findExpiredIrPartial(entry.session)` separately.

The "verify at implementation" hedge is the right honesty marker, but the plan should commit to a strategy. Today's `_serverNoteBuilder.willPrepend` accessor in v3's pseudocode doesn't exist either.

**Fix:** Either name the actual session fields (`session.ringContinuityScript != null || session.insulationResistanceScript != null || session.protectiveDeviceScript != null`) or move the bypass insertion AFTER the timeout-note-prepend step at line ~3467, then check whether the transcript was modified vs original (i.e. `if (transcriptText !== originalTranscriptText) skipBypass`). The second is cleaner and matches v3's intent ("bypass moves AFTER all deterministic script processors"); state it explicitly.

---

### IMPORTANT 2 — Bypass eligibility narrowness is not reconciled with the cost model

v3 §2.1 rule #1: bypass requires the canonical field to be in `regex-fast-eligibility.js`'s whitelist. That whitelist is 5 fields (`REGEX_FAST_ELIGIBLE_FIELDS` at lines 47-55: `measured_zs_ohm`, `r1_r2_ohm`, `ir_live_earth_mohm`, `ir_live_live_mohm`, `number_of_points`). All five are circuit-scoped. None are supply / board / installation.

v3 §1's cost model still claims "3–6 turns saved per 24-turn session." In a typical field session, the inspector dictates these five fields multiple times each, but interleaved with circuit creation, descriptions, ring-continuity / IR scripts, observations, ask answers, and corrections — utterances that name ONLY one of those five and nothing else are a fraction of total turns.

The §1 table shows "Sonnet turns/session: 24 → 18–21." That's 12–25 % bypass rate. For that to land, ~3–6 utterances per session must satisfy ALL 9 eligibility checks AND only carry whitelist fields AND have no observation language. Not impossible, but it's not "30–50 % of turns are regex-clean" anymore either. The honest mid-range is probably $0.02–0.06/session, not $0.06–0.11.

This isn't a BLOCKER because the architecture still works, but the saving claim is overstated unless v3 widens the whitelist explicitly. v3 deliberately did not widen — claudereview-v1 IMPORTANT 4 said "extend the regex-fast-TTS path to cover more field types and ship that first." That work isn't in scope here.

**Fix:** Two options:
- Accept the narrower saving floor ($0.02–0.05). Adjust the table in §1 and the "Phase A: worth doing" prose in §1's payoff assessment. The headline of the sprint becomes "small saving, but proves the bypass mechanism for future expansion."
- Widen the whitelist as part of this sprint (adds days). Decide.

---

### IMPORTANT 3 — TestFlight time-to-availability risk is not in the §2.8 risk table

v3 §5 sequencing says: Day 0 iOS TestFlight upload + internal install on Derek's iPad; Day 2 PM canary on Derek's iPad; Day 2 PM "TestFlight broader distribution starts (review queue). Other devices update over the next 1–3 days."

Apple's TestFlight external review averages 24–48 hours but can be longer (occasionally 4–5 days). If Derek's internal install bypass works but the external rollout stalls, the fleet-flip on Day 3 AM would put the LIVE bypass in front of devices that don't yet ship the enriched `regexResults` shape. Those devices fall through to the backwards-compat "no value → no bypass" path — that part is safe. But:

- Telemetry mixes shadow-on-old-iOS and live-on-new-iOS into a single bucket, and the "fleet flip if green" criterion in §2.7 becomes meaningless because the data is dominated by old-iOS sessions where bypass = 0 % by construction.
- If a subtle bug shows up ONLY on new-iOS-plus-live-bypass (the only path that touches the new merge code), it lives in the field for 1–3 days before enough new-iOS devices exist to surface it in telemetry.
- The Derek-only-iPad canary is, in effect, a single-device test for several days.

§2.8 risks table mentions "Old iOS builds don't get the bypass" but treats it as benign. It doesn't mention the telemetry-aliasing or the long-tail-discovery problem.

**Fix:** Add a row to §2.8 + a guardrail to canary criteria: pin canary readout window to "≥ N sessions on the new iOS build" (not just calendar days). Stamp the iOS build version on every bypass log line so CloudWatch queries can filter to the new-iOS population.

---

### IMPORTANT 4 — `EICR_AGENTIC_SYSTEM_PROMPT` is baked at module init; Phase B rollback story is incomplete

v3 §3.3 puts `this.systemPrompt = this._buildSystemPrompt(); // lazy` in the constructor. There is no `_buildSystemPrompt` method, and the SoI text is currently CONCATENATED into the exported `EICR_AGENTIC_SYSTEM_PROMPT` constant at module load (`eicr-extraction-session.js:895-900`). A constructor-time flip from "full SoI in prompt" → "directory in prompt + lookup tool" requires either:
- Splitting `EICR_AGENTIC_SYSTEM_PROMPT` into `_AGENTIC_BASE_PROMPT` (already exists) plus two SoI variants (full + directory), and selecting in the constructor.
- Or adding a per-session lazy builder, which is the v3 wording but unmapped to actual code.

Without one of these, `SOI_TOOL_ENABLED=true` at deploy time would still ship Sonnet the FULL SoI in the prompt (because the constant is still concatenated) AND the lookup tool (factory adds it) — so Sonnet sees both, has no reason to call the tool, and Phase B's saving is zero. Conversely `SOI_TOOL_ENABLED=false` with code already shipped doesn't fall back cleanly unless the constant has been split.

This was IMPORTANT 5 of v1 — the original review flagged the same thing — and v3 acknowledges the issue at a high level but the §3.3 pseudocode hand-waves the prompt split.

**Fix:** State explicitly:
1. Split `EICR_AGENTIC_SYSTEM_PROMPT` into base + SoI-full + SoI-directory.
2. Constructor picks SoI variant based on `soiToolEnabled`.
3. Document that hot-flipping `SOI_TOOL_ENABLED` requires a process restart (or build the lazy-per-session path explicitly — pick one, name it).

---

### MINOR 1 — `buildJobStateFromRegexHits` reads `h.fieldSourceKey` but iOS sends `h.field`

v3 §2.5 buildJobStateFromRegexHits looks up `REGEX_FIELD_SOURCE_MAP[h.fieldSourceKey]`. v3 §2.0a builds entries as `{field: n.field, value, circuit?, board_id?}` — there is no `fieldSourceKey` on the wire payload after normalisation. The lookup target is the same map, but it's keyed by the iOS field-source key (`circuit.<ref>.zs`), not by the canonical field (`measured_zs_ohm`).

Two ways to reconcile:
- Either iOS sends BOTH `fieldSourceKey` and `field` (and the server only uses `fieldSourceKey` for scope routing), with the latter being the canonical name.
- Or the server uses `h.field` as the input and `REGEX_FIELD_SOURCE_MAP` is keyed by canonical name instead of by iOS-source-key.

**Fix:** Pick one and align §2.0a / §2.0b / §2.5 to it. The current draft has each section using a different shape.

---

### MINOR 2 — `seenTranscriptUtterances` etc. live on `entry`, but `_mergeIncomingJobStateIntoSnapshot` lives on `session`

v3 §2.5 mixes the namespaces freely: `entry.session._mergeIncomingJobStateIntoSnapshot(jobStatePayload)`; `seenTranscriptUtterances.add(transcriptText)` (no qualifier — implicitly `entry.`). The handler in `sonnet-stream.js` already maintains this distinction carefully (`entry.session` for session methods, `entry.*` for routing-layer state). Implementations should match. Not a behaviour bug, but pasting the snippet as-is into a PR would not compile without qualifiers.

**Fix:** Qualify all references in the pseudocode (`entry.seenTranscriptUtterances`, `entry.recentTranscripts`).

---

### MINOR 3 — §2.7 canary "snapshot state diff" criterion needs operational definition

v3 §2.7 introduces `compareSnapshots(baseline_session_end, canary_session_end)` as a canary criterion replacing v2's `reviewForOrphanedValues` count. Useful direction, but no existing helper has that name, paired sessions across iPads + repeat utterances aren't trivially comparable, and there's no Phase A.0a hook that captures `baseline_session_end` for the same transcript replay. The criterion is plausible but unbuildable as stated within Day-2 turnaround.

**Fix:** Either write a concrete capture+diff plan (where do you store the baseline snapshot? are you driving the same transcript through both code paths or relying on iPad-A/iPad-B field replication?) or pick a simpler proxy ("count of fields populated by bypass alone, sanity-check none of them are slots Sonnet would normally fill via tool calls").

---

## Iteration trajectory note

v1 → v2: 4 BLOCKERs → 8 BLOCKERs (review surface expanded as the plan got more specific).
v2 → v3: 8 BLOCKERs → 4 BLOCKERs in this review.

The remaining 4 are concrete implementation-name mismatches (shared-types, readValueFromFieldSources, stamping helper, lookup tool schema), not architectural rewrites. Phase A's structure (iOS wire-shape upgrade + server real-merge + bypass inside try/finally + shadow-first + dedupe-stamping) is the right design. The plan is converging.

One more iteration that grounds every code reference against actual symbols (`session.ringContinuityScript` not `entry.activeScript`; `stampSeenTranscript()` closure not inline pseudocode; `EICR_AGENTIC_SYSTEM_PROMPT` constant split not hand-wave "lazy"; concrete `LOOKUP_INSPECTION_ITEM_TOOL` schema not just a name) should produce a zero-BLOCKER plan. After that the question becomes whether the saving floor ($0.02–0.06/session) actually justifies 5–7 days of cross-platform sprint work, which is a product call, not a plan call.
