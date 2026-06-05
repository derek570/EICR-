# Codex review v8 — extraction-bypass PLAN_v8.md

## Verdict

SHIPPABLE
0 BLOCKERs, 1 IMPORTANT, 1 MINOR

Scope honored: I reviewed only the v6 → v8 deltas: Phase D removal / §5 framing, measured cost corrections in §0.2-§0.3, §7 TTS clarification, §8 walkthrough-server clarification, and whether v8 regresses or contradicts v6. I did not re-review inherited Phases A/B/C.

v8 fixes the v7 architectural mistake. The live system already performs deterministic server-side walkthrough entry before Sonnet via `sonnet-stream.js:3334-3408` calling the dialogue-engine wrappers, which call `processDialogueTurn` and `detectEntry` before `runShadowHarness`. Sonnet's `start_dialogue_script` remains the fallback path for trigger phrases the engine missed, exactly as the tool description says.

## Fix Verification

### 1. Phase D dropped / §5 future-enhancement framing

Correct. `sonnet-stream.js:3334-3408` calls `processRingContinuityTurn`, `processInsulationResistanceTurn`, and `processProtectiveDeviceTurn`; each returns before Sonnet when it handles the turn. The current wrappers are imported from `src/extraction/dialogue-engine/index.js`, and `processDialogueTurn` runs entry detection at `src/extraction/dialogue-engine/engine.js:181-185`.

The §5 framing is therefore right: a future Phase D would be an iOS-side backstop for residual server `detectEntry` misses, not a new server-side walkthrough-entry mechanism.

`enterScriptByName` also already exists at `src/extraction/dialogue-engine/engine.js:1609`, validates schema/circuit state, is idempotent on active scripts, accepts `pending_writes`, seeds state, and emits the first ask. v8 correctly avoids re-lifting this logic.

### 2. Cost-model corrections

Mostly defensible against the data shown. The measured table gives 32 single-round early-terminated turns across 113 turns, with an explicit caveat that this proxy overstates true bypass eligibility because rules #6 and #7 can still reject some turns. The revised Phase A range of `$0.06-$0.15/session` is plausible and conservative if the real bypass rate lands below the 28% proxy. The plan also correctly says Day 1 shadow telemetry is the real measurement.

The `start_dialogue_script` residual is sized correctly from the table: 4 calls across 113 turns, 3 in the long session. Treating Phase D as a low-value future enhancement is defensible.

### 3. §7 TTS server-side

Accurate. `src/routes/voice-latency-fast-tts.js` defines `POST /voice-latency/regex-fast-tts`, mounted under `/api` in `src/api.js`, and the handler composes confirmation text and calls `ElevenLabsStreamClient.synth` server-side. It is gated and whitelisted, but v8 already says it is for the 5 whitelisted fields.

### 4. §8 walkthroughs server-side

Accurate. The mechanism the user asked for is already live: server-side `detectEntry` handles most walkthrough trigger phrases before Sonnet; `start_dialogue_script` is fallback for garbled / paraphrased entries.

## Findings

### IMPORTANT 1 — §0.3 annual GBP projection treats USD savings as GBP

The per-session savings are stated in dollars, but the launch-scale annual column is labelled pounds without conversion.

Using the plan's own launch scale of `100 inspectors * 6 sessions/day * 365 = 219,000 sessions/year`:

- `$0.06-$0.15/session` = `$13.1k-$32.9k/year`, not automatically `£13k-£33k/year`.
- `$0.07-$0.17/session` = `$15.3k-$37.2k/year`, not automatically `£15k-£37k/year`.

At a rough USD→GBP conversion, the lower bound for Phase A+B is closer to ~`£11k-£12k/year` than `£15k/year`. This does not block the sprint because the measured per-session logic is still defensible, but §0.3 should either label the annual figures as USD or apply an exchange-rate conversion before using the `£15k+/year` headline.

### MINOR 1 — §0.1 source references should point to the active dialogue-engine schemas

v8's architecture claim is correct, but two references in §0.1 point at legacy per-domain script files. `sonnet-stream.js` now imports the wrappers from `src/extraction/dialogue-engine/index.js`, so the active trigger source is:

- `src/extraction/dialogue-engine/schemas/ring-continuity.js:70-80`
- `src/extraction/dialogue-engine/schemas/insulation-resistance.js:69-75`
- `src/extraction/dialogue-engine/schemas/{rcbo,ocpd,rcd}.js`

This also matters for the exact IR garble claim: the legacy `insulation-resistance-script.js` includes `international`, but the active dialogue-engine schema currently has `insulation|installation` only. That does not invalidate §5 because `start_dialogue_script` is precisely the fallback for this residual, but the source table should not imply the active server regex catches `international` today.

## Regression Check

No v8 regression against v6 Phases A/B/C found within the requested scope. v8 retains the v6 sprint shape and sequencing, removes the rejected Phase D, and replaces v6's earlier cost model with measured data plus a shadow-telemetry caveat. The remaining v6 review note about implementing Phase B's dispatcher inside the real `createToolDispatcher(writes, asks)` shape is not worsened; v8's summary names that factory shape explicitly.

Wrote v8 review: 0 BLOCKERs, 1 IMPORTANT, 1 MINOR. Verdict: SHIPPABLE
