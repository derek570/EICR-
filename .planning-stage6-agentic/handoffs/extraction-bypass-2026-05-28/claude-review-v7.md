# Claude review of PLAN_v7 — extraction-bypass sprint

**Date:** 2026-05-28
**Reviewer:** Claude (Opus 4.7, independent pass)
**Plan reviewed:** `PLAN_v7.md` (delta on v6 — adds Phase D + measured cost data)
**Iteration trajectory:** v1 4B → v2 8B → v3 4B → v4 4B → v5 1B → v6 0B (both reviewers) → v7 (this pass, Phase D only)
**Scope of this review:** Phase D (Server-side walkthrough entry) only. Phases A/B/C carry forward from v6's converged 0-BLOCKER state.

## Verdict

**NOT SHIPPABLE AS WRITTEN — 2 BLOCKER, 2 IMPORTANT, 2 MINOR.**

Phase D's premise is wrong against the live codebase. The plan repeatedly states that "today the entry is Sonnet-driven via the `start_dialogue_script` tool" (PLAN_v7 line 11, §4.1 lines 73-83, §0 line 26). That is not how the system works in production today. The server **already** does deterministic server-side walkthrough entry on the entry turn via `src/extraction/dialogue-engine/index.js → processDialogueTurn → detectEntry`, called from `sonnet-stream.js:3334-3408` **before Sonnet runs at all**. Sonnet's `start_dialogue_script` tool is the documented FALLBACK for when that regex misses — the tool description (`stage6-tool-schemas.js:777`) literally says "the engine's regex did not catch (Deepgram garbled the trigger phrase, or the inspector paraphrased)".

The five "walkthrough-entry turns saved per 86-turn session" Phase D claims to save are therefore **mostly already saved today**. The residual savings come only from the narrow band of utterances that:

  (a) the iOS regex would correctly classify as a walkthrough trigger, AND
  (b) the existing server-side `detectEntry` would NOT classify (i.e., Deepgram garbled the trigger past the server's existing `(?:insulation|installation|international)` / `ring continu(?:ity|ance|ancy|ed|e)|final` tolerance).

That overlap is much narrower than v7's cost model assumes, and v7 hasn't quantified it. The Phase D economic case as written is not defensible without a different measurement.

There is a real fix shape here — an iOS-supplied `dialogue_script_intent` that backstops the server's existing `detectEntry` for the residual garble cases — but the plan as written would re-implement the entry path the engine already has, possibly producing double-entry telemetry and definitely producing duplicated regex maintenance burden between iOS and the server.

---

## Phase D specific findings

### BLOCKER 1 — §4.1's premise misrepresents the live system

**File:** `PLAN_v7.md` §4.1 lines 72-83
**Severity:** BLOCKER

§4.1 step 2-3 says "Transcript goes to Sonnet via the normal path. Sonnet's `start_dialogue_script` tool description... tells it to recognise the intent and call the tool." This is the documented fallback, not the primary path.

The actual production flow on a fresh "ring continuity for the sockets" utterance is:

1. `sonnet-stream.handleTranscript` line 3334 calls `processRingContinuityTurn(...)` (now backed by `processDialogueTurn` in `src/extraction/dialogue-engine/engine.js`).
2. That function calls `detectEntry(text)` against `RING_ENTRY_PATTERNS` at `ring-continuity-script.js:113-121`, which matches `ring continu(?:ity|ance|ancy|ed|e)|final` with optional circuit number anywhere within 50 chars.
3. On match: `initScript` is called, `buildExtractionPayload` writes any volunteered values, `buildScriptAsk` emits the first TTS prompt, and `processRingContinuityTurn` returns `{handled: true, fallthrough: false}` → `sonnet-stream.js:3349` does `return;` — **Sonnet is never invoked on this turn.**

Same flow exists for IR (`insulation-resistance-script.js:109-114`, head-word alternation `(?:insulation|installation|international)` plus garble tolerance for `res(?:istance|istence|istense)`) and protective devices (`src/extraction/dialogue-engine/index.js:85 → processProtectiveDeviceTurn`, schemas at `dialogue-engine/schemas/{ocpd,rcd,rcbo}.js`).

This means the "~5 walkthrough-entry turns saved per 86-turn session" in §4.5 are mostly already saved. The Sonnet round only fires on the entry turn when the server's own `detectEntry` misses — i.e., when Deepgram garbles past the existing alternations or the inspector paraphrases beyond what the patterns cover.

Phase D needs to be re-framed: it is not "server-side walkthrough entry" (the server already has that), it is "backstop server-side entry from iOS when the server's own regex missed AND iOS caught it". That's a much narrower scope.

**Fix:** rewrite §4.1 to acknowledge the existing server-side path, and rewrite §4.5's cost model to count only the subset of turns where (a) Sonnet currently fires `start_dialogue_script` AND (b) an iOS-side regex addition would have caught the trigger that the server's own `detectEntry` missed. Without this re-framing, the saving estimate is overstated by an unknown but probably-large factor.

### BLOCKER 2 — Cost model assumption "5 walkthrough-entry turns saved per 86-turn session" is undocumented and probably wrong

**File:** `PLAN_v7.md` §4.5 lines 166-172
**Severity:** BLOCKER

The §4.5 estimate is presented as ground truth: "Saved ~5 walkthrough-entry turns (an estimate; the session had 1 ring + 2 IR walkthroughs + 2 OCPD entries roughly)." But:

1. Most of those entries are caught by the server-side `detectEntry` today and never reach Sonnet.
2. The plan does not enumerate which of the 5 turns the existing `detectEntry` actually misses.
3. The session-33E6613D transcript is not attached or quoted; no way to verify the count.
4. If Sonnet `start_dialogue_script` calls fired in that session, they would appear in CloudWatch's `stage6.dialogue_script_*` log family — that's the right data source, not a manual count.

Without a documented audit ("turn X said Y, the server regex missed because Z, an iOS pattern of shape W would have caught it"), the cost model is unfalsifiable. The "$0.36 per 86-turn session" claim in §0.1 inherits this defect.

**Fix:** pull the session log for 33E6613D from CloudWatch (search `sessionId:33E6613D stage6.dialogue_script_entered OR stage6.start_dialogue_script`). For each `start_dialogue_script` tool call, list:
- the transcript that triggered it
- which `*_ENTRY_PATTERNS` regex(es) would NOT match it (the server already-fired ones don't count — they were caught and bypassed Sonnet)
- what new iOS pattern would catch it

If the count comes back as 0-1 turns per long session rather than 5, Phase D's saving is rounding error and the sprint scope should drop it.

### IMPORTANT 1 — "iOS already has ring continuity language regex" mis-describes line 257

**File:** `PLAN_v7.md` §4.1 line 81, §4.4 line 158
**Severity:** IMPORTANT

The reference to `TranscriptFieldMatcher.swift:257` in §4.1 and §4.4 implies iOS already has the entry-trigger regex. Verified at `CertMateUnified/Sources/Recording/TranscriptFieldMatcher.swift:257-262`:

```swift
/// Pre-compiled regex for detecting ring continuity language in transcripts.
/// Matches conductor types (earths, lives, neutrals, "nuts" = ASR mis-transcription
/// of "neutrals") followed by optional filler words and a numeric ohm value.
private static let ringContentPattern = try! NSRegularExpression(
    pattern: #"\b(?:earths?|lives?|neutrals?|nuts)\s+(?:(?:is|are)\s+)?(?:(?:naught|nought|zero|oh)\s+)?(\d+\.?\d*)"#
)
```

This regex matches **ring readings content** ("lives are 0.43", "earths 0.18") — i.e., the VALUES dictated DURING a ring walkthrough — NOT the entry trigger phrase "ring continuity for sockets". The closest iOS regex to a ring-trigger is the `ringKeywords` heuristic at line 1125 (designation-level) which is used by `isRingCircuit`, not by any "enter walkthrough" hook.

iOS today does NOT detect "ring continuity for circuit 5" / "ring main on the cooker" as a walkthrough-entry trigger that would be sent on the wire with `dialogue_script_intent.type = 'ring_continuity'`. Phase D therefore has to ADD this iOS regex, not extend one. §4.4 acknowledges this but §4.1 implies the iOS pattern recognition already exists.

**Fix:** in §4.1, replace "iOS regex already has the pattern recognition for ring continuity (`TranscriptFieldMatcher.swift:257`)" with the accurate statement "iOS regex today only recognises ring continuity READINGS (`TranscriptFieldMatcher.swift:257`); the trigger phrase has no iOS-side detector. Phase D adds it." This also affects §4.6 risk #4's "iOS regex already tolerates IR garbles (per `:257` comment block)" — line 257 is about ring readings, not IR garbles; iOS has separate IR patterns (`irLiveEarthPattern` at line 727, etc.) that tolerate "ir|insulation\s+resistance|inssy|megger|megging" but NOT the "installation/international/instellation" head-word garbles the server already covers.

### IMPORTANT 2 — `tryServerInitScript` is already implemented as `enterScriptByName`; plan should reuse, not "lift"

**File:** `PLAN_v7.md` §4.2 lines 116-144
**Severity:** IMPORTANT

The plan describes `tryServerInitScript` as logic to be "lifted out of Sonnet's tool-call path so both surfaces share the same script-init code". This already exists. `src/extraction/dialogue-engine/engine.js:1609` exports `enterScriptByName({session, sessionId, schemas, schemaName, circuit_ref, pending_writes, ws, logger, now})` — a pure function that:

- Validates `circuit_ref` against the snapshot (including multi-board scope)
- Idempotently returns `{ok: true, status: 'already_active'}` if a script is already running
- Validates `pending_writes` against the schema's slot fields
- Seeds existing snapshot values
- Emits the first ask via `askNextOrFinish`

The dispatcher at `stage6-dispatchers-script.js:59 → dispatchStartDialogueScript` is a thin envelope around `enterScriptByName` (validation logging, `tool_use_id` envelope wrapping, perTurnWrites backfill). The "lift" is unnecessary because the function is already separated.

Phase D's `tryServerInitScript` should be a 5-line wrapper that calls `enterScriptByName` directly. The cost-engineering implication: this is much smaller in scope than §4 implies and shouldn't need a dedicated branch (`walkthrough-server-entry`) or a 2-day implementation.

**Fix:** rewrite §4.2 to clarify that `enterScriptByName` is the existing function, the iOS handler in `sonnet-stream.handleTranscript` is a 10-line call site, and the rollout is correspondingly cheaper. The branch and the day-4/5/6 sequencing in §4.7 can collapse to a single day.

### MINOR 1 — `dialogue_script_intent` wire field is clean but should be documented in `sonnet-stream.handleTranscript`'s wire-shape comment

**File:** `PLAN_v7.md` §4.2 lines 87-114
**Severity:** MINOR

The new `dialogue_script_intent` field on the transcript message is a clean addition — no conflicts with existing `msg.type`, `msg.text`, `msg.regexResults`, `msg.in_response_to`, etc. (verified by `grep -n "msg\." sonnet-stream.js | head -50`). However, `sonnet-stream.handleTranscript` has no canonical wire-shape comment block documenting all the iOS-supplied fields it accepts. Phase D should add one alongside `dialogue_script_intent` so the next person extending the wire shape sees the contract.

### MINOR 2 — Phase D introduces a double-detection seam without explaining the ordering

**File:** `PLAN_v7.md` §4.2 line 119 ("BEFORE script processors")
**Severity:** MINOR

The new server handler runs BEFORE the existing script processors at sonnet-stream.js:3311-3408. That's fine as long as:

- If iOS sends `dialogue_script_intent` and `tryServerInitScript` succeeds → processors are skipped (return at line 137).
- If iOS sends `dialogue_script_intent` and `tryServerInitScript` fails → fall through to processors, which run their own `detectEntry` against the same transcript.
- If iOS doesn't send `dialogue_script_intent` → flows through processors as today.

§4.2 says the first case but doesn't explain what happens when the second case's `tryServerInitScript` fails AND the processor's `detectEntry` succeeds on the same turn. The plan needs an explicit assertion that the existing processor path is the safety net for any iOS-side false negative, so an iOS regex bug can't silently regress the existing entry detection.

This is documentation, not a code defect — but it's the kind of thing that would otherwise become a "double-entry mystery" log finding three months from now.

---

## Cost model — independent assessment

§0.0 measured data is plausible at face value. The bypass rates (28% average across 113 turns) align with what eligibility rules #6 (`!pendingAsk && !inResponseTo`) and #7 (`transcriptText === originalTranscriptText`) would allow. The 20% rate on the 76-turn session matches the intuition that long sessions have more walkthroughs (which get intercepted by script processors and fail rule #7).

The Phase A correction from "$0.01-$0.03/session" (v6) to "$0.13-$0.27/session" (v7) is a 5-15× upward revision. Two checks:

- v6's estimate was 1-2 turns saved per 24-turn session at $0.015/turn ≈ $0.02. v7's measured "7 of 13 bypass-eligible at $0.018/turn" ≈ $0.13. The difference is the bypass-eligibility surface — v6 assumed eligibility rule #7 would block most turns; v7's measured data shows it doesn't, because Phase A's "single-round early-terminated turns" proxy doesn't filter for rule #7's transcript-mutation gate.
- The proxy v7 uses ("single-round early-terminated turns") may overestimate. A turn that early-terminates can still have had `in_response_to` set (rule #6 blocks) or a script processor mutate the transcript (rule #7 blocks). If even half of the proxy turns fail those, the real bypass rate is ~14%, not 28%.

**This isn't a BLOCKER but it deserves a sentence in §0** acknowledging the proxy's limitations and the need to validate against shadow-mode telemetry before declaring the cost claim defensible.

The Phase D portion of the cost claim ($0.09 additional per long session) inherits BLOCKER 2's defect — see above.

---

## Anything else (Phase A/B/C re-verification)

Per task scope I did not re-verify Phase A/B/C; v6 closed with 0 BLOCKERs from both reviewers and PLAN_v7 explicitly says A/B/C carry forward unchanged. Confirmed by diffing PLAN_v6 §2/§3/§5 against PLAN_v7 — Phases A/B/C are referenced but not rewritten in v7 (PLAN_v7 §2 and §3 are one-liners pointing at v6, §5 is one-liner pointing at v6).

The §6 sequencing changes are consistent with v6's 7-day plan plus Phase D at days 4-6.

---

## Trajectory summary

| Iteration | BLOCKERs | Status |
|---|---|---|
| v1 | 4 | rewrite needed |
| v2 | 8 | rewrite needed |
| v3 | 4 | rework |
| v4 | 4 | rework |
| v5 | 1 | one focused patch |
| v6 (both reviewers) | 0 + 1 IMP + 2 MIN | SHIPPABLE |
| v7 (this pass) | **2** + 2 IMP + 2 MIN | **NOT SHIPPABLE — Phase D needs re-framing** |

v6's converged state was clean. v7 introduced a Phase D that misreads the live system. The fixes are tractable — re-frame Phase D as "iOS-side backstop for server `detectEntry` misses", quantify the residual savings against CloudWatch's actual `start_dialogue_script` call rate, and rewrite §4.2 to call `enterScriptByName` directly instead of "lifting" a function that's already separated.

**Recommendation:** Phases A/B/C are still shippable as v6 — they are not blocked by Phase D's defects. Either:

  (a) Ship Phases A/B/C from v6 as-is and re-spec Phase D in a v8 (or a separate handoff) after pulling the 33E6613D log to size the actual residual savings. This unblocks the £25k-£60k/year Phase A case immediately.

  (b) Hold the whole sprint pending a v8 that re-grounds Phase D against the live `detectEntry` path and the actual CloudWatch `start_dialogue_script` call rate.

I'd lean (a) — Phase A is independently valuable and Phase D's residual saving is probably small enough that delaying or even skipping it doesn't materially hurt the sprint's economic case.

---

Wrote v7 review: 2 BLOCKERs, 2 IMPORTANT, 2 MINOR. Verdict: NOT SHIPPABLE AS WRITTEN — Phase D misreads the live system (existing server-side `detectEntry` already bypasses Sonnet on most walkthrough entry turns); re-frame Phase D as iOS-backstop scope and re-quantify against CloudWatch `start_dialogue_script` rate, OR ship Phases A/B/C from v6 standalone and re-spec Phase D in v8.
