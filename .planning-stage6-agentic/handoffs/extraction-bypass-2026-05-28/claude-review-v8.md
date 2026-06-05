# Claude review of PLAN_v8 — extraction-bypass sprint

**Date:** 2026-05-28
**Reviewer:** Claude (Opus 4.7, independent pass)
**Plan reviewed:** `PLAN_v8.md` (delta on v7)
**Iteration trajectory:** v1 4B → v2 8B → v3 4B → v4 4B → v5 1B → v6 0B (SHIPPABLE) → v7 2B (rejected) → v8 (this pass)
**Codex v8 verdict:** SHIPPABLE — 0 BLOCKER, 1 IMPORTANT, 1 MINOR.

## Verdict

**SHIPPABLE — 0 BLOCKER, 1 IMPORTANT, 1 MINOR.**

I independently verified every v7→v8 delta against the live source. Phase D is correctly dropped, the §5 "future enhancement" framing accurately describes the existing dialogue-engine architecture, the §7 / §8 clarifications match the production code, and the cost-model corrections are defensible against the measured data shown. The single IMPORTANT (USD/£ labelling) and single MINOR (stale source citations for the legacy script files) match Codex's findings and do not rise to BLOCKER.

Convergence is genuine. v8 is shippable.

---

## Scope honored

I reviewed ONLY the v6→v8 deltas as requested:
- Phase D removal / §0.1 / §5 future-enhancement framing
- §0.2 / §0.3 cost-model corrections (measured data + proxy caveat)
- §7 ElevenLabs TTS server-side clarification
- §8 walkthrough server-side clarification
- Regression check against v6's converged Phases A/B/C

I did NOT re-review the inherited Phases A/B/C content (already 0-BLOCKER converged in v6).

---

## Fix verification (v7 → v8)

### v7 BLOCKER 1 — Phase D misread the live system — VERIFIED FIXED

PLAN_v8 §0.1 + §5 correctly describe the live architecture. I verified every source claim against the running code:

| Claim in PLAN_v8 | Source | Verified |
|---|---|---|
| `processDialogueTurn` exists and is the unified entry detection point | `src/extraction/dialogue-engine/engine.js:69` | YES — function takes `{ws, session, sessionId, transcriptText, schemas, logger, now}`; iterates schemas at line 182 calling internal `detectEntry(text, schema)` at line 199. |
| `enterScriptByName` is already factored out at engine.js:1609 | `src/extraction/dialogue-engine/engine.js:1609` | YES — pure function, validates schema/circuit_ref, idempotent on already-active scripts (returns `status:'already_active'` envelope with `pivoted` provenance), accepts `pending_writes`, seeds snapshot, emits first ask. v7's "lift this into a shared helper" was a no-op. |
| `processRingContinuityTurn`, `processInsulationResistanceTurn`, `processProtectiveDeviceTurn` are called in `sonnet-stream.js:3334-3408` BEFORE Sonnet | `src/extraction/sonnet-stream.js:3334-3408` | YES — three wrappers called in sequence, each with the `handled`/`fallthrough` contract; on `handled && !fallthrough` the handler returns before `runShadowHarness` (line 3766). Sonnet never sees the turn when server-side `detectEntry` matches. |
| `start_dialogue_script` is the FALLBACK for garbled/paraphrased entries | `src/extraction/stage6-tool-schemas.js:774-777` | YES — tool description verbatim says "Trigger a structured slot-filling walk-through for a multi-step test the engine's regex did not catch (Deepgram garbled the trigger phrase, or the inspector paraphrased)." Even includes a "GARBLE TOLERANCE" paragraph explicitly naming "insulation"→"installation"/"International" misrecognition. |

The §5 framing is therefore correct: a future Phase D would be an iOS-side regex BACKSTOP for residual server `detectEntry` misses, not a new server-side walkthrough-entry mechanism. The proposed iOS handler ("~10-line call site invoking the existing `enterScriptByName`") is the right shape — `enterScriptByName` is already pure and idempotent.

### v7 BLOCKER 2 — Cost estimate was undocumented — VERIFIED FIXED

PLAN_v8 §0.2 ships measured data from 3 sessions / 113 turns / $3.57 spend with an explicit honesty caveat: "single-round early-terminated turns" is a PROXY for bypass-eligibility, and rules #6 (`in_response_to`) + #7 (script-processor-modified transcript) will still reject a portion of those turns. The 20-25% real bypass rate range is honestly stated, with shadow-mode telemetry on Day 1 named as the actual measurement step.

The residual `start_dialogue_script` cost (4 calls × 113 turns = ~$0.07 across 3 sessions, ~$0.05/long session) is sized correctly from the table and lines up with the per-call Sonnet cost the table implies (long session $2.66 / 76 turns ≈ $0.035/turn → 3 `start_dialogue_script` calls ≈ $0.10, halved if you remove output costs that wouldn't be saved). $0.05/session is defensible as an upper-bound estimate.

### v7 IMPORTANT 1 — TranscriptFieldMatcher.swift:257 regex matches READINGS not entries — VERIFIED FIXED

PLAN_v8 drops the claim entirely. §5 acknowledges (correctly) that if Phase D is revisited later, the iOS PR would add NEW trigger-phrase regexes, not extend the readings regex.

### v7 IMPORTANT 2 — "tryServerInitScript" lift was a no-op — VERIFIED FIXED

PLAN_v8 §5 calls out explicitly: "the iOS handler in `sonnet-stream.handleTranscript` is a ~10-line call site invoking the existing `enterScriptByName`, NOT a re-implementation." Correct — the function is already pure and reusable.

### v7 MINOR 1+2 — Out of scope until Phase D re-spec'd — VERIFIED FIXED

Correctly deferred.

---

## §7 ElevenLabs TTS server-side — VERIFIED ACCURATE

Confirmed `src/routes/voice-latency-fast-tts.js` exists and matches the §7 description:
- Route is POST `/api/voice-latency/regex-fast-tts` (mounted under `/api` per route file header).
- Composes confirmation text via `buildConfirmationText` from `confirmation-text.js` (canonical shared source — line 65 import).
- Calls ElevenLabs server-side; forces `mp3_22050_32` output format (line 72).
- Whitelisted to the 5 fast-eligible fields via `isRegexFastEligible` (line 66 import).
- Already live in production — header comments name "Mode-A fast-path TTS endpoint" + "Single-round latency sprint Phase 1" as the shipping context.

§7's claim ("when bypass triggers, the fast-TTS path still fires for the audible confirmation. No new TTS path needed.") is consistent with the route's purpose: it's iOS-initiated on regex hits, independent of the Sonnet pipeline, so Phase A's bypass doesn't break it.

## §8 walkthroughs server-side — VERIFIED ACCURATE

Confirmed against the dialogue-engine wiring (see BLOCKER 1 verification above). `detectEntry` for ring continuity fires server-side via `processRingContinuityTurn` at `sonnet-stream.js:3334` BEFORE Sonnet; same for IR and protective devices. `start_dialogue_script` is the documented Sonnet-side fallback for residual misses, exactly as §8 says.

The user's wish ("walkthroughs should be triggered server-side too. If the entry into the walkthroughs is garbled Sonnet should start a walk-through but ideally would be started by regex") is the current architecture as of today.

---

## Regression check against v6

No v6 regression detected. Phases A/B/C inherited verbatim. v8 only:
- Drops the rejected Phase D from v7.
- Replaces v7's §0.1 inflated cost projection with measured data.
- Adds §7 and §8 as user-facing clarifications.

v6's converged Phases A/B/C citations (sonnet-stream.js:~3765 bypass insertion before runShadowHarness:3766, `entry.pendingAsks.size > 0` eligibility, `_mergeIncomingJobStateIntoSnapshot` reuse, 16-tool list, `createToolDispatcher(writes, asks)` factory shape, `stage6-tool-schemas.js:777` SoI tool surface) all still hold against live code.

---

## Findings

### IMPORTANT 1 — §0.3 cost table conflates USD and GBP

Matches Codex's finding. The per-session column is in dollars, but the annual column is labelled pounds without conversion.

At launch scale (100 inspectors × 6 sessions/day × 365 = 219,000 sessions/year):
- Phase A `$0.06–$0.15/session` × 219k = **$13.1k–$32.9k/year** → at ~0.79 USD→GBP ≈ **£10.4k–£26.0k/year**, not £13k–£33k/year.
- Phase A+B `$0.07–$0.17/session` × 219k = **$15.3k–$37.2k/year** → ≈ **£12.1k–£29.4k/year**, not £15k–£37k/year.

This does not block the sprint — even at the lower bound (~£10k/year recurring at launch scale) the 5-7 day sprint is still defensible. But §0.3 should either (a) label the annual figures explicitly as USD or (b) apply a conversion before using the "£15k+/year" headline at line 61. The §5 future-enhancement saving ("~£365/year current scale, £15k/year at launch") has the same defect — those should be USD or converted.

Fix recommendation: change the column header in §0.3 from "At launch scale (100 inspectors × 6/day)" to "At launch scale (100 inspectors × 6/day, USD)" and update the line-61 headline to say "$15k+/year (≈£12k+/year)". Same treatment for §5 line 125-126.

### MINOR 1 — §0.1 cites legacy script files; the active source is `dialogue-engine/schemas/`

Matches Codex's finding. PLAN_v8 §0.1 cites:
- `src/extraction/ring-continuity-script.js:178` for the ring `detectEntry` pattern
- `src/extraction/insulation-resistance-script.js:109-114` for the IR `detectEntry` pattern

Both files still exist on disk but are only imported by tests now (verified: `grep -rn "from.*insulation-resistance-script" src/` returns only `src/__tests__/...`). The live wiring at `sonnet-stream.js:3334-3408` imports `processRingContinuityTurn` / `processInsulationResistanceTurn` from `src/extraction/dialogue-engine/index.js`, which uses the schemas at:
- `src/extraction/dialogue-engine/schemas/ring-continuity.js:70-80` (triggers; broader than legacy — adds `(?:ring|bring|wing)` Deepgram-garble alternation)
- `src/extraction/dialogue-engine/schemas/insulation-resistance.js:69-75` (triggers; **NARROWER than legacy — drops "international"**, only matches `(?:insulation|installation)`)

This matters for the §0.1 IR garble claim: the table says "Catches 'Installation resistance' garbles" and parenthetically lists `(?:insulation|installation|international)`. The active schema only catches `insulation|installation`. "International resistance" — explicitly named in the legacy comment at `insulation-resistance-script.js:100-101` as a Deepgram garble — is NOT caught by the active server regex today. It's precisely the kind of residual that `start_dialogue_script` exists to backstop (the tool description's "GARBLE TOLERANCE" paragraph even names `International` as an example).

This doesn't invalidate §5's "future enhancement" framing — it actually strengthens it (there IS measurable residual). But the §0.1 source table should point at the active schema files and not imply the active server regex catches "international" today.

Fix recommendation: update §0.1 row 2 source to `src/extraction/dialogue-engine/schemas/insulation-resistance.js:69-75` and drop "international" from the listed alternation. Row 1 source becomes `src/extraction/dialogue-engine/schemas/ring-continuity.js:70-80`.

---

## What I did NOT find that could block ship

- No regression against v6 Phases A/B/C.
- No contradiction between v8 §7/§8 claims and live code.
- No mis-statement of the dialogue-engine architecture in §5.
- No inflation of the measured cost data in §0.2.
- No new technical claim in v8 that needs deeper verification.

The two findings above are documentation polish, not implementation blockers.

---

Wrote v8 review: 0 BLOCKERs, 1 IMPORTANT, 1 MINOR. Verdict: SHIPPABLE
