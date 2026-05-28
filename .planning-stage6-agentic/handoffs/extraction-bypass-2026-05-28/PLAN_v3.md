# Extraction-bypass sprint v3 — corrections from Codex review v2

**Date:** 2026-05-28
**Iteration:** v3 (folds 8 BLOCKERs + 5 IMPORTANTs + 2 MINORs from `codex-review-v2.md`)
**Sprint scope:** 3 phases, **5–7 days** end-to-end (up from v2's 4–5; iOS TestFlight gate added)
**Branches:** `regex-bypass-backend` (backend) + `regex-bypass-ios` (iOS) + `soi-tool-lookup` + `observation-tts-bridge`

## 0. v2 → v3 changelog

The v2 plan tried to ship Phase A without iOS changes. Codex's review showed this isn't viable: iOS sends only field-source keys (no values), Stage 6 live mode doesn't replay conversation history at all, and the bypass position v2 chose would race the existing `handleTranscript` lifecycle. **Phase A becomes a coordinated backend+iOS sprint in v3.**

| # | v2 problem | v3 fix |
|---|---|---|
| BLOCKER 1 | iOS `regexResults` carries only `[{field: "circuit.3.zs"}]` — no value, no circuit ref. v2's server-side applier had nothing to apply. | iOS wire-shape upgrade: `buildRegexSummary` returns `[{field: <canonical>, value, circuit?, board_id?}]`. Canonical names are the same enum strings used by `record_reading` (`measured_zs_ohm`, `r1_r2_ohm`, etc). One small Swift change + a TestFlight build. Server treats absent shape as legacy → no bypass for old iOS builds (safe degradation). |
| BLOCKER 2 | Synthetic `record_reading` tool_use shape violated `stage6-tool-schemas.js` (missing `confidence`, `source_turn_id`; wrong tool for board/supply fields). | Synthetic history dropped entirely — see BLOCKER 3 fix. |
| BLOCKER 3 | **Stage 6 live mode does NOT replay `conversationHistory`** (verified `stage6-shadow-harness.js:373-379, 1167-1173`). Each Sonnet turn starts from a fresh single-message window. v2's coherence-preservation was solving a problem that doesn't exist in live mode — but its implementation introduced new bugs. | Drop synthetic `conversationHistory` writes. Live mode reads state ONLY from `stateSnapshot` (cached system blocks). Bypass updates the snapshot; the next Sonnet turn sees the new readings via the snapshot, not via message replay. `reviewForOrphanedValues` is legacy-mode-only (verified `:4073-4083`) — REMOVED as a Phase A safety net. New Phase A safety net: shadow-mode telemetry catches drift before live flip. |
| BLOCKER 4 | Regex-fast eligibility uses backend canonical names (`measured_zs_ohm`); iOS sends field-source keys (`circuit.3.zs`). No intersection. | iOS wire-shape upgrade (BLOCKER 1 fix) sends canonical names. Server normalises via the same path Sonnet's `record_reading` dispatcher uses. Intersection becomes meaningful. |
| BLOCKER 5 | v2's merge had FACT/READING precedence backwards vs `_mergeIncomingJobStateIntoSnapshot` and ignored board/supply routing. | Don't reinvent the merge. Server converts regex hits into a `jobState`-shaped payload and calls the **real** `_mergeIncomingJobStateIntoSnapshot`. Single source of merge truth. |
| BLOCKER 6 | Bypass position skipped active dialogue scripts (ring continuity, IR, OCPD) and partial-fill timeout notes. | Bypass moves AFTER all deterministic script processors (`sonnet-stream.js:3311-3467`). New eligibility check #8 — abort bypass if any script is mid-walkthrough OR any partial-fill timeout note is being prepended. |
| BLOCKER 7 | Bypass position broke `handleTranscript`'s `isExtracting` queue serialisation and `try/finally` lifecycle. | Bypass runs INSIDE the existing `try/finally` block, with `entry.isExtracting=true` held, and `entry.queuedTranscripts` draining on bypass exactly like a normal handled turn. Treats bypass as a "committed turn that emits zero tool calls". |
| BLOCKER 8 | Per-session `buildToolSchemas()` doesn't reach static `TOOL_SCHEMAS` import at `stage6-shadow-harness.js:96`. | Export `BASE_TOOL_SCHEMAS` from `stage6-tool-schemas.js`; add `buildToolSchemas({soiToolEnabled})` factory. Harness call sites updated to call the factory with the session's flags. ~3 call sites; surgical. |
| IMPORTANT 1 | Bypassed turns must update dedupe ledgers (`seenTranscriptUtterances`, `recentTranscripts`). | Bypass path stamps the same ledgers a normal handled turn does. Treat bypass as a committed transcript. |
| IMPORTANT 2 | Shadow telemetry needs the same normalised payload and insertion point as live. | Phase A.0a (NEW, Day 1 AM) — ship the normaliser + insertion-point integration in shadow mode FIRST. Phase A.0b runs telemetry against it. Same code paths for shadow and live. |
| IMPORTANT 3 | Tool-result elision in Phase B is premature — Stage 6 live mode doesn't persist `conversationHistory` for elision to operate on. | Phase B's elision DEFERRED. When live history persistence is added (out of scope this sprint), elision can be revisited. Phase B saving estimate adjusted: drops to **$0.005–$0.015/session** without elision (Sonnet pays for the tool_result on the same turn but it's GONE next turn because live mode doesn't replay history — so elision is moot anyway). |
| IMPORTANT 4 | "No regression in `reviewForOrphanedValues` finds" canary criterion is meaningless in Stage 6 live mode. | Removed from §2.7 canary criteria. Replaced with: snapshot-state-diff audit (count circuit fields populated by bypass vs Sonnet across paired sessions). |
| IMPORTANT 5 | Backend SoI directory + iOS `InspectionItem2` schedule risk drift. | New §3.6.1 — Phase B compact directory generated programmatically from the backend SoI file at build time. CI parity check covering: backend full SoI, backend directory, iOS schedule items. Mirrors existing `field_schema.json` parity check. |
| MINOR 1 | Plan referenced strict tools that no longer exist. | Wording updated; schemas guide model, dispatchers enforce (not a behaviour change). |
| MINOR 2 | Cost model conflated bypassed utterances with billable turns avoided. | §5 updated — separate metrics for `bypass_candidate_utterances`, `bypass_live_applied`, `sonnet_calls_avoided`, `batch_flushes_avoided`. Saving math uses `sonnet_calls_avoided` only. |

---

## 1. Updated cost model (replaces v2 §5)

After honest accounting for:
- Bypass population is per-utterance, but batch-buffer (`BATCH_SIZE=2`) means 2 utterances → 1 Sonnet call. `sonnet_calls_avoided` is roughly `floor(bypass_candidate_utterances * 0.7)` based on the batch hit rate.
- iOS wire-shape change means only sessions running the new iOS build get the bypass. Backwards-compatible degradation; rollout proportional to iOS build adoption.
- SoI was 2.5k tokens not 10–15k (Phase B saving smaller than original v1 claim).

| Component | Phase 1 today | After Phase A | After Phase A+B |
|---|---|---|---|
| Sonnet turns/session | 24 | 18–21 (saving 3–6 turns) | 18–21 |
| Avg tokens read/Sonnet turn | 35,000 | 35,000 | ~32,500 |
| Cache read $/turn | $0.0105 | $0.0105 | $0.0098 |
| Sonnet total $/session | ~$0.44 | ~$0.33–0.38 | ~$0.32–0.36 |
| $ saved vs Phase 1 | — | **$0.06–$0.11** | **$0.08–$0.12** |

**Combined saving: $0.05–$0.15/session, mid-range $0.08–$0.10.** Smaller than v1's $0.12–$0.30 claim but more honest. Phase A still does the bulk; Phase B's contribution is modest.

At ~6 sessions/day current usage: ~£0.40/day extra savings. At commercial launch scale: scales linearly.

**Honest assessment of payoff vs effort:**
- Phase A: 3–5 days work (iOS + backend + TestFlight cycle), $0.06–$0.11/session saving. Worth doing.
- Phase B: 1–2 days work, $0.01–$0.02/session saving (with elision deferred). Borderline. Ship only if Phase A goes smoothly and there's bandwidth.
- Phase C: 1 day iOS work, UX-only. Worth shipping alongside B.

---

## 2. Phase A — Skip Sonnet on regex-clean turns (v3)

### 2.0a iOS wire-shape upgrade (NEW prerequisite)

`CertMateUnified/Sources/Recording/TranscriptProcessor.swift:199-208` — `buildRegexSummary` returns the enriched shape:

```swift
func buildRegexSummary(writtenKeys: Set<String>, job: JobDetail?) -> [[String: Any]]? {
    guard !writtenKeys.isEmpty else { return nil }
    return writtenKeys.compactMap { key -> [String: Any]? in
        let normalised = normaliseRegexKey(key)  // "circuit.3.zs" -> (field: "measured_zs_ohm", circuit: 3, board: nil)
        guard let n = normalised else { return nil }
        guard let value = readValueFromFieldSources(key, job: job) else { return nil }
        var entry: [String: Any] = ["field": n.field, "value": value]
        if let circuit = n.circuit { entry["circuit"] = circuit }
        if let board = n.board { entry["board_id"] = board }
        return entry
    }
}
```

`normaliseRegexKey` is the new canonical-name resolver — maps iOS field-source keys to backend `record_reading` enum strings. Lives in a new `Sources/Processing/RegexFieldNormaliser.swift` so backend (BLOCKER 4 fix) and iOS share one definition (via shared-types — see §2.0b).

**Backwards compatibility:** if `regexResults` entries are missing `value` (old iOS build), server treats them as legacy hits — no bypass eligibility, normal Sonnet round runs. Old iOS builds keep working unchanged.

### 2.0b Shared canonical mapping

New file `packages/shared-types/src/regex-field-normalisation.ts`:

```ts
export interface NormalisedRegexHit {
  field: string;      // Canonical backend enum name
  value: string | number;
  circuit?: number;   // Required for record_reading-bucket fields
  board_id?: string;  // Required for board-scoped fields
}

export const REGEX_FIELD_SOURCE_MAP: Readonly<Record<string, { field: string; scope: 'circuit' | 'supply' | 'board' }>> = Object.freeze({
  // Supply (circuit 0)
  'supply.ze':            { field: 'ze',                          scope: 'supply' },
  'supply.pfc':           { field: 'pfc',                         scope: 'supply' },
  'supply.polarity':      { field: 'supply_polarity_confirmed',   scope: 'supply' },
  // ... etc
  // Circuit (scoped to ref)
  'circuit.<ref>.zs':     { field: 'measured_zs_ohm',             scope: 'circuit' },
  'circuit.<ref>.r1r2':   { field: 'r1_r2_ohm',                   scope: 'circuit' },
  // ... etc
  // Board
  'board.<id>.zeAtDb':    { field: 'ze_at_db',                    scope: 'board' },
});
```

Both iOS (build-time copy via existing shared-types path) and backend import this. CI parity check exists already for shared-types; this just adds a new file.

### 2.0c Observation-trigger lexicon (carried from v2)

`packages/shared-types/src/observation-triggers.ts` — closed list, frozen array. Same canonical-home + CI parity story as v2.

### 2.1 Updated eligibility rules (v3)

Skip Sonnet for an utterance iff ALL hold:

1. iOS sent the enriched regex shape (i.e. `value` is present on each hit) AND at least one regex hit AND the canonical field is in `regex-fast-eligibility.js`'s whitelist (intersection now meaningful).
2. No observation trigger from canonical lexicon (§2.0c).
3. No correction lead-in.
4. No question lead-in.
5. No pending `ask_user` in flight.
6. iOS did NOT tag as `in_response_to`.
7. No `start_dialogue_script` pattern in transcript.
8. **No active dialogue script on the session** (ring continuity, IR, OCPD walkthroughs) AND no partial-fill timeout note pending (BLOCKER 6 fix). Check `entry.activeScript` / `entry.pendingTimeoutNote` (or whatever the actual session-state shape is — verify at implementation).
9. Chitchat-wake side-effect has fired if applicable (carried from v2 IMPORTANT 6).

Any check failing → forward to Sonnet as today.

### 2.5 Updated implementation — bypass path (v3, addresses BLOCKERs 6, 7)

`sonnet-stream.handleTranscript`:

```
// (existing) chitchat-wake check         — line ~973
// (existing) shouldForwardToSonnet       — pre-LLM gate
// (existing) entry.isExtracting queue admission
// (existing) deterministic script processors  — lines 3311-3467
//   (ring continuity, IR, OCPD, partial-fill timeout note)
// (existing) regex-fast-TTS route check

// NEW — bypass point (after all of the above)
if (REGEX_BYPASS_MODE === 'live' || REGEX_BYPASS_MODE === 'shadow') {
  const { bypass, reason } = shouldBypassSonnet({
    transcriptText,
    regexResults: msg.regexResults,
    session: entry.session,
    hasActiveScript: entry.activeScript != null,
    hasPartialFillTimeoutNote: serverNoteBuilder.willPrepend,
    inFlightAskUser: entry.session.askedQuestions.some(q => !q.answered),
    inResponseTo: msg.in_response_to,
  });
  
  if (REGEX_BYPASS_MODE === 'shadow') {
    logger.info('voice_latency.bypass.shadow', { sessionId, bypass, reason, ... });
    // fall through to normal Sonnet path
  } else if (bypass) {
    // Apply regex hits to snapshot via the REAL merge function
    const jobStatePayload = buildJobStateFromRegexHits(msg.regexResults);
    entry.session._mergeIncomingJobStateIntoSnapshot(jobStatePayload);
    
    // Stamp dedupe ledgers — treat bypass as committed transcript (IMPORTANT 1)
    seenTranscriptUtterances.add(transcriptText);
    recentTranscripts.push({...});
    
    logger.info('voice_latency.bypass.applied', { sessionId, reason: 'regex_clean', regexFields, sonnet_calls_avoided: 1 });
    // Treat as committed. queue draining happens in the existing finally block.
    return;
  }
}

// (existing) extractFromUtterance / Sonnet path
```

`buildJobStateFromRegexHits(regexResults)` constructs a `jobState`-shaped object:

```js
function buildJobStateFromRegexHits(hits) {
  const jobState = { circuits: [], supply: {}, boards: [] };
  const boardBuckets = new Map();
  for (const h of hits) {
    const scope = REGEX_FIELD_SOURCE_MAP[h.fieldSourceKey]?.scope ?? inferScope(h);
    if (scope === 'supply') {
      jobState.supply[h.field] = h.value;
    } else if (scope === 'circuit') {
      let row = jobState.circuits.find(c => c.ref === h.circuit);
      if (!row) { row = { ref: h.circuit }; jobState.circuits.push(row); }
      row[h.field] = h.value;
    } else if (scope === 'board') {
      let b = boardBuckets.get(h.board_id);
      if (!b) { b = { id: h.board_id }; boardBuckets.set(h.board_id, b); jobState.boards.push(b); }
      b[h.field] = h.value;
    }
  }
  return jobState;
}
```

`_mergeIncomingJobStateIntoSnapshot` handles all the FACT/READING precedence, the supply-at-circuits[0] convention, and the boards-by-id matching — single source of merge truth (BLOCKER 5 fix).

### 2.7 Updated rollout (v3)

- Day 0: iOS branch — wire-shape change, regex normaliser, build, internal TestFlight install on Derek's iPad.
- Day 1 AM: backend branch — `REGEX_BYPASS_MODE` env var (`off`|`shadow`|`live`, default `off`), `shouldBypassSonnet`, `buildJobStateFromRegexHits`, bypass-position wiring inside `handleTranscript`'s try/finally. Tests.
- Day 1 PM: deploy `REGEX_BYPASS_MODE=shadow`. iOS new build running on Derek's iPad means shadow telemetry sees the enriched regex shape. Other devices still send legacy shape → shadow logs "no enriched regex" reason. Passive telemetry only.
- Day 2 AM: read out 24h shadow data. Decide ship vs abort. Abort threshold: bypass rate < 10% of enriched-shape candidate utterances.
- Day 2 PM: if ship, canary `REGEX_BYPASS_MODE=live`. Two iPad sessions same scaffold as Phase 1 canary.
- Day 3: fleet flip if green.

Canary criteria (replaces v2 §2.7):
- bypass_rate ≥ shadow baseline
- sonnet_calls_avoided > 0 (sanity)
- Total Sonnet $/session vs paired Phase 1 baseline session (down ≥ 10% expected)
- Snapshot state diff (`compareSnapshots(baseline_session_end, canary_session_end)` for matching transcript count): no fields populated by Sonnet in baseline that are missing in canary
- No spike in `ask_user.missing_context`

### 2.8 Risks (v3)

| Risk | Mitigation |
|---|---|
| iOS regex value misextraction → wrong value lands in snapshot | Server applies via real `_mergeIncomingJobStateIntoSnapshot` which only fills empty cells — Sonnet-canonical values are preserved. If iOS regex misreads, only previously-empty cells get the bad value. Same risk as today's regex pre-apply on iOS UI. |
| Old iOS builds don't get the bypass | Backwards-compatible: missing `value` → no bypass eligibility → normal Sonnet round runs. Bypass rate grows with iOS adoption curve. |
| Bypass-shape iOS sends differs from server's normaliser expectations | Shared-types parity check fails CI before either ships. |
| Bypass interaction with chitchat-pause wake | Check #9; bypass runs AFTER the wake side-effect at `sonnet-stream.js:973-1029`. |

---

## 3. Phase B — SoI as lookup tool (v3 corrections)

### 3.1 Carried from v2

SoI footprint ~2.5k tokens (BLOCKER 4 of v1 already corrected this).

### 3.3 Updated implementation (BLOCKER 8 fix)

`src/extraction/stage6-tool-schemas.js`:

```js
// New export
export const BASE_TOOL_SCHEMAS = [...]; // (current TOOL_SCHEMAS minus lookup_inspection_item)

// New factory
export function buildToolSchemas({ soiToolEnabled }) {
  const tools = [...BASE_TOOL_SCHEMAS];
  if (soiToolEnabled) tools.push(LOOKUP_INSPECTION_ITEM_TOOL);
  return tools;
}

// Keep TOOL_SCHEMAS export for backwards compat (= buildToolSchemas({soiToolEnabled: false}))
export const TOOL_SCHEMAS = buildToolSchemas({ soiToolEnabled: false });
```

`src/extraction/stage6-shadow-harness.js` — replace static `TOOL_SCHEMAS` imports at lines 96, 373-379, 1167-1173 with `session.toolSchemas` (or equivalent — passed in via runShadowHarness's options).

`EICRExtractionSession.constructor`:

```js
this.soiToolEnabled = this._resolveSoiToolEnabled(options.soiToolEnabled);
this.systemPrompt = this._buildSystemPrompt();  // lazy
this.toolSchemas = buildToolSchemas({ soiToolEnabled: this.soiToolEnabled });
```

### 3.4 Tool-result elision DEFERRED (IMPORTANT 3 fix)

Stage 6 live mode doesn't persist tool_result content beyond the single Sonnet turn that called the tool. The "accumulation" problem v2 worried about doesn't exist as a per-session burden — only as an in-turn cost. Tool-result elision is a no-op until/unless `conversationHistory` is replayed for live mode. Out of scope this sprint.

### 3.5 Phase B rollback (v3)

`SOI_TOOL_ENABLED=false`: tool schema factory excludes `lookup_inspection_item`; `_buildSystemPrompt` returns full SoI in prompt. Both gated on the same constructor-resolved flag. Task-def env-var → service redeploy. NOT a runtime flip.

P0 abort: Sonnet emits `lookup_inspection_item` tool call while `SOI_TOOL_ENABLED=false`. Would indicate stale prompt or stale tool array; investigate before any further deploy.

### 3.6.1 (NEW) Compact directory generation

Phase B's "compact directory" is generated programmatically at build time from the backend full SoI file:

```bash
node scripts/generate-soi-directory.mjs \
  --input config/prompts/schedule-of-inspection-bs7671-eicr.md \
  --output config/prompts/schedule-of-inspection-directory.md
```

Output is checked into git for cache stability and review. CI re-runs the generator and fails if the output differs (drift guard). iOS's `EICRHTMLTemplate.swift` `InspectionItem2` enumeration gets a parity check in the same CI step (mirror of existing `field_schema.json` audit).

Directory shape: one line per item, `<ref> <one-line summary>`. Generator extracts the summary from the SoI's existing structure; no hand-drafting required.

### 3.6 Risks (carried + tool-call rate metric)

| Risk | Mitigation |
|---|---|
| Observation quality regression | Directory is generated, not hand-drafted; verbatim summary from canonical SoI. E2E test on 5 prerecorded observation-heavy transcripts. |
| Sonnet ignores directory and asks for lookup every turn | Canary metric: `lookup_tool_calls_per_observation` ≤ 1.5. |
| Drift between backend directory and iOS canonical schedule | CI parity check. |

---

## 4. Phase C — TTS bridge (v3, unchanged from v2)

Carried from v2 — reconciled criteria, no abort threshold, false positives acceptable.

---

## 5. Sequencing (replaces v2 §6)

| Day | Branch | Activity |
|---|---|---|
| 0 | iOS `regex-bypass-ios` | Wire-shape change, regex normaliser, build + TestFlight upload, internal install on Derek's iPad |
| 1 AM | backend `regex-bypass-backend` | Server side: shared-types files, `_resolveRegexBypassMode`, `shouldBypassSonnet`, `buildJobStateFromRegexHits`, wiring in `handleTranscript` after scripts + inside try/finally, dedupe-ledger stamping. Tests. |
| 1 PM | backend | Deploy `REGEX_BYPASS_MODE=shadow`. Passive telemetry. |
| 2 AM | — | Read out shadow telemetry. Decide ship vs abort. |
| 2 PM | backend | If ship: canary `REGEX_BYPASS_MODE=live`. Two iPad sessions on Derek's iPad (which has the new iOS build). |
| 2 PM | iOS | TestFlight broader distribution starts (review queue). Other devices update over the next 1–3 days. |
| 3 AM | — | Read out canary. Fleet flip if green. |
| 3 PM | backend `soi-tool-lookup` | Phase B implementation: directory generator, lazy prompt build, tool schema factory + call-site updates. Tests. |
| 3 PM | iOS `observation-tts-bridge` | Phase C: trigger detector port (using shared-types observation-triggers), bundled audio asset, AlertManager wiring. |
| 4 AM | backend | Deploy `SOI_TOOL_ENABLED=false` default. Code lands inert. |
| 4 AM | iOS | TestFlight upload of Phase C build. |
| 4 PM | — | Canary `SOI_TOOL_ENABLED=true`. iPad field test. |
| 5 | — | Read out Phase B+C. Fleet flip if green. |

Calendar slip-tolerance: Phase A iOS work in Day 0 is the critical path — if TestFlight processing is slow, Day 1 backend work can still proceed (the wire-shape acceptance is server-side); just can't field-test until iOS lands.

---

## 6. Reviewer audit trail (v3)

- [x] PLAN.md (v1) — Claude self-review: 4 BLOCKERs, 6 IMPORTANT, 3 MINOR → v2
- [x] PLAN_v2.md — Codex review: 8 BLOCKERs, 5 IMPORTANT, 2 MINOR → v3 (this file)
- [ ] PLAN_v3.md — Claude self-review (next)
- [ ] PLAN_v3.md — Codex review (after self-review folded)
- [ ] Iterate until both reviewers report zero BLOCKERs.

Verdict gate before commit / ship: zero BLOCKERs from both reviewers.
