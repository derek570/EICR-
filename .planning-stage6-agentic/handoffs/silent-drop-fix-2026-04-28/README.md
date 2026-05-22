# Silent-drop fix — design + parked work (2026-04-28)

This directory captures a design conversation and partially-built code for fixing a silent-drop bug class found in session **3B5A0355** (2026-04-28 ~14:08 BST). The work was drafted, reviewed, then deliberately reverted from `src/` so it could be re-scoped and committed cleanly later. **All the artefacts you need to resume are in this directory.** Nothing is on a branch; nothing is in `src/`.

---

## The bug

Session: `3B5A0355-2ED8-4415-8D76-C4DBBA7AA760` ("Job - 28 Apr 2026, 2:03 pm" — `eic` cert, 97s, 5 turns, **0 circuits created**).

Transcript:
```
Second 1 is security loan.        ← Deepgram garble of "Circuit 1 is security alarm"
Circuit 1 is security alarm.      ← clean naming, no reading
Circuit 1 is security alarm.      ← repeat (after no response)
Circuit 2 is water heater.        ← clean naming, no reading
```

Backend log (CloudWatch + S3 debug log):
- Stage 6 ran (`stage6_live_extraction`, certType=eic) on every turn.
- Every turn returned `readings:0, observations:0, rounds:1`.
- Output token counts: 11–36 — Sonnet emitted text replies, **not tool calls**.

## Root cause

`config/prompts/sonnet_agentic_system.md`, **TOPIC RESTRAINT** section (line 51 at the time of investigation):

```
- Topic-only utterance ("Ring continuity for kitchen sockets") → no tool calls; wait. Values follow.
```

This rule tells Sonnet to **not act** on any utterance that lacks a test value. From Sonnet's point of view, "Circuit 1 is security alarm" looks structurally identical to a topic announcement — names a circuit/designation, no numeric reading attached — so it sits on its hands waiting for a value that never arrives.

The legacy EIC prompt (`sonnet_extraction_eic_system.md:37`) had explicit guidance:
> CIRCUIT NAMING: If the user says "circuit N is [description]" return a circuit_updates entry with action "create" (if circuit N is not in the schedule) or "rename" (if it exists).

This instruction was lost in the migration to the agentic prompt (Stage 6 Phase 4).

## Two concerns, intentionally separated

The original draft bundled two distinct fixes. They have different risk profiles and should be tracked / shipped separately.

### Concern 1 — Prompt change (CIRCUIT NAMING)

**Goal:** add a worked example so Sonnet emits `create_circuit` / `rename_circuit` for "Circuit N is X" utterances, and tighten TOPIC RESTRAINT so it no longer subsumes pure naming.

**Why parked:** Derek's standing preference is to avoid prompt engineering — past attempts have not aged well. Two prompt commits already landed on main today (`383767c`, `6542836`). A third change in the same area on the same day risks unintended interaction.

**If you decide to ship:** narrowest possible scope. Just add Example 6:

```markdown
Example 6 — Designation announcement, no reading: "Circuit 1 is the security alarm." → if circuit 1 is absent: `create_circuit({circuit_ref:1, designation:"Security Alarm"})`; if present: `rename_circuit({from_ref:1, circuit_ref:1, designation:"Security Alarm"})`. Garbled forms with the same shape (e.g. "Searched two is upstairs lights" → `create_circuit({circuit_ref:2, designation:"Upstairs Lights"})`) follow the same rule. NO further tool calls.
```

**Do NOT** also rewrite TOPIC RESTRAINT into ORPHANED VALUES + RING CONTINUITY CARRYOVER prose in the same change. That broader Flux-aware redesign (see "Deferred sprint" below) needs deliberate validation against real Flux session fixtures via the shadow harness — it is not a Day 1 ship.

**Branch:** new branch off `main`, e.g. `stage6-circuit-naming-fix`. Single commit, ~1 file changed (the prompt) + 1 content-invariant test added in `src/__tests__/stage6-agentic-prompt.test.js` pinning Example 6's presence.

**Token budget guard:** the prompt content-invariant test caps `Math.ceil(len/4) <= 4000`. Adding Example 6 alone (~430 chars) takes the prompt from ~3997 tokens to ~4105 — over cap. Either trim ~108 chars of fat elsewhere, or bump the cap to 4100 with a comment justifying it. The bigger redesign would have justified bumping to 4400; for just Example 6, trimming is cleaner.

### Concern 2 — Ring continuity timeout (server-side)

**Goal:** ring continuity is the only EICR test family that legitimately spans multiple Flux turns (probes are physically repositioned between r1, rn, r2 readings; pauses of 10–30s are normal). After 60s with a partial fill, the server should fire `ask_user` for the missing value rather than letting it sit forever or attribute a much-later value to the wrong circuit.

**Why this is the right shape:** deterministic server-side state tracking + ask_user emission. No prompt dependency. Sonnet doesn't have to track elapsed time across turns.

**Status:** module + tests are complete and tested in this directory:
- `ring-continuity-timeout.js` — pure module: state tracking (per-circuit timestamp Map), `findExpiredPartial` detector, `recordRingContinuityWrite` stamp, `clearRingContinuityState` cleanup, `buildAskForMissingRingValue` payload builder.
- `ring-continuity-timeout.test.js` — 21 tests covering basic lifecycle, schema variants (Object vs Array circuits), multiple-circuit ordering (oldest fires first), full lifecycle progression. All passing on the last run before park.

**Branch:** new branch off `main`, e.g. `stage6-ring-continuity-timeout`. Two logical commits:
  1. The module + tests (move both files from this directory into `src/extraction/` and `src/__tests__/`).
  2. The wiring — dispatcher hook in `stage6-dispatchers-circuit.js`'s `dispatchRecordReading` + per-turn check in `sonnet-stream.js` before `runShadowHarness`.

## Wiring — what the second commit needs to do

The module is dead code without these two integration points.

### A. Dispatcher hook — `src/extraction/stage6-dispatchers-circuit.js`

Add the import:
```js
import { RING_FIELDS, recordRingContinuityWrite } from './ring-continuity-timeout.js';
```

Add a stamp call in `dispatchRecordReading`, **after** the `perTurnWrites.readings.set(...)` line (around line 124 in the version we drafted against), **before** `logToolCall(...)`:
```js
// Ring continuity tracking — stamp the circuit's last-write timestamp on every
// record_reading hitting one of the three ring fields. The server-side timeout
// detector (ring-continuity-timeout.js) reads these timestamps on each user
// turn to fire ask_user when a partial bucket has gone stale (>60s).
if (RING_FIELDS.includes(input.field)) {
  recordRingContinuityWrite(session, input.circuit);
}
```

### B. Per-turn check — `src/extraction/sonnet-stream.js`

Add the import near the top of the file, alongside the existing `runShadowHarness` import:
```js
import { findExpiredPartial } from './ring-continuity-timeout.js';
```

Add the check **after** the `in_response_to` annotation block and **before** the `logger.info('Extracting from transcript', ...)` call (around line 2598 in the version we drafted against):

```js
// Ring continuity timeout — 2026-04-28. The agentic prompt's RING CONTINUITY
// CARRYOVER section delegates the 60-second timeout to the server (Sonnet
// can't reliably track elapsed time across turns). On every user turn,
// before invoking Sonnet, check whether any circuit has a partial r1/rn/r2
// fill that's older than 60s. If yes, prepend a server-issued directive to
// the transcript so Sonnet emits `ask_user` with the right `context_field`
// + `context_circuit`. The user's reply value-resolves through the existing
// answer-resolver path (resolveValueAnswer in stage6-answer-resolver.js).
const ringExpired = findExpiredPartial(entry.session);
if (ringExpired) {
  const ringNote =
    `[Server note: circuit ${ringExpired.circuit_ref} ring continuity is incomplete; ` +
    `${ringExpired.missing_field} has not been recorded and 60s have elapsed since the last ` +
    `ring write. Please ask the user for this value via ask_user with ` +
    `context_field="${ringExpired.missing_field}", context_circuit=${ringExpired.circuit_ref}, ` +
    `expected_answer_shape="value", reason="missing_value".] `;
  transcriptText = `${ringNote}${transcriptText}`;
  logger.info('stage6.ring_continuity_timeout_detected', {
    sessionId,
    circuit_ref: ringExpired.circuit_ref,
    missing_field: ringExpired.missing_field,
    last_write_ms: ringExpired.last_write_ms,
  });
}
```

### Tested-or-not

- The module is unit-tested in isolation (21/21 passing on the last run).
- The dispatcher hook is **not** independently unit-tested — covered indirectly by integration tests in the existing dispatchers test suite as long as those don't break.
- The per-turn check is **not** unit-tested. The integration would benefit from one shadow-comparator test that fires a ring continuity write, jumps the clock past 60s with a mock `Date.now` injection, and asserts the transcript prepended on the next turn carries the `[Server note: ...]` prefix. Worth adding before ship.

## Design conversation summary

For posterity — this captures the trade-offs we worked through. Useful when someone returns to this work and asks "why didn't we just X?".

### Why server-side over prompt for the naming bug

Considered options for fixing "Circuit N is X":

1. **Prompt edit** — add CIRCUIT NAMING worked example. Simple but dependent on Sonnet following the new rule consistently. History of unreliable prompt edits in this codebase.
2. **Server regex pre-pass** (literal "circuit N is X") + dispatcher hook — deterministic, free, but silently drops Deepgram garbles ("Second 1 is security loan").
3. **Server regex with curated alternation list** of known garbles ("circuit|second|circle|cricket|searched|sirkit") — covers observed cases. Maintenance cost: one PR per new garble.
4. **Server regex + phonetic match** (Levenshtein ≤ 2 OR Double Metaphone) for unseen garbles — catches the long tail without enumeration. ~100 lines of pure JS, no dependency.
5. **Haiku-4.5 lightweight classifier** — narrow single-purpose model call: "did the user just name a circuit? Output JSON or {}." Catches arbitrary garbles via semantic intent rather than phonetic distance. ~$0.001/call, only fires when main Sonnet emitted 0 tool calls AND utterance has the shape `WORD\s+\d+\s+is\s+\S+`.
6. **Prompt + small worked example only** — Derek's eventual lean-in. Narrow rule, testable, falls under "bug fix" not "broad behavioural shift". Risk acknowledged: TOPIC RESTRAINT is a broader earlier rule that may dominate the new one in conflicts.

We landed on #6 as the simplest experiment to run first, with #4 or #5 as fallback if #6 doesn't reliably override TOPIC RESTRAINT.

Then Derek reverted everything to keep options open. Reasonable call — testing day shouldn't ship unproven prompt edits.

### Why a 60s timer for ring continuity, not a per-family timer

The agentic prompt's TOPIC RESTRAINT was originally written when Deepgram fragmented utterances aggressively (pre-Flux). Flux's 5-second EoT detection means most "topic + value" sequences arrive in a single Flux turn. The only test family that genuinely spans multiple turns is ring continuity (probe repositioning physically takes 10–30s).

Other multi-sub-reading tests (IR L-L vs L-E, R1+R2 vs R2) do NOT need carryover — Flux waits long enough for the inspector to dictate them all in one breath.

So the carryover rule is ring-continuity-specific, not a general "test family" pattern.

### Why turn-driven firing, not setTimeout-based

The detector fires on the user's NEXT turn after silence, not via a wall-clock setTimeout. Reasons:
- A setTimeout-based scheduler would require a per-session lifecycle (cleanup on session end, race handling with new ring writes, doze/sleep state interaction).
- Turn-driven is simpler and matches the existing flow shape (everything in `sonnet-stream.js` is event-driven on user turns).
- The user has to interact for anything else to happen anyway.

Trade-off: if the user goes fully silent and never speaks again, the ask never fires. That's acceptable — the doze/sleep system already handles idle session termination.

### Why a `[Server note: ...]` directive instead of a true server-emitted ask_user

Considered building a "server-emitted ask" path that mirrors `dispatchAskUser` minus the tool-loop integration: build the `ask_user_started` ws message, register in `pendingAsks`, send to ws, return early. The user's reply would route through the existing answer-resolver value-resolution path.

Decided against it for Day 1 because:
- Significant new infrastructure (~200 lines + integration tests).
- The `pendingAsks.register` shape is intricate (Promise/resolve/timer/ws-readyState) and easy to get wrong.
- The `[Server note: ...]` injection is a much smaller footprint and reuses Sonnet's existing tool path. Sonnet sees the directive, emits `ask_user` with the exact context_field/context_circuit values we tell it to use, and the rest is automatic.

Risk: relies on Sonnet emitting the ask reliably on seeing the directive. Mitigation: directive is explicit, in the same bracket-injection format as the existing `in_response_to` annotation Sonnet already handles correctly.

If field testing shows the directive is ignored, upgrade to true server-emitted ask later. But ship the simpler shape first.

## When you resume

Suggested order:

1. **Decide the prompt-vs-server scope.** Two independent decisions:
   - Land Example 6 in the prompt (yes / no / wait for more data).
   - Land the ring continuity timeout (yes / no / scope down).
2. **For each yes**, create a separate branch off the current `main` and apply the fix as described above.
3. **Test focused first** before running the full suite. Flaky integration test files unrelated to this work (admin-users, jobs, recording, ccu-route-merger, settings-company-scope) cause noise.
4. **For the ring continuity timeout: add an integration test** before ship — fires a write, advances `Date.now` mock past 60s, asserts the transcript prepend on the next turn.
5. **Verify in the next session.** Look for `stage6.ring_continuity_timeout_detected` log rows in CloudWatch when a partial fill goes stale.

## Pointers

- Field test data: `s3://eicr-files-production/session-analytics/82b54893-220d-49f5-8c55-d677a009787b/3B5A0355-2ED8-4415-8D76-C4DBBA7AA760/`. Pull with `/opt/homebrew/bin/aws s3 cp ... --recursive --region eu-west-2 /tmp/3B5A0355/`.
- Recent Stage 6 prompt commits on main: `383767c` (topic-announcement restraint + verbal-without-write anti-pattern + create-before-rename), `6542836` (topic→circuit carryover + immediate-create on unknown name + cross-ask value accumulation), merged via `ca86ba0`.
- Stage 6 prompt content-invariant tests: `src/__tests__/stage6-agentic-prompt.test.js` — Group 4 pins Examples 1–4 (Examples 5/5b/5c/etc. are not pinned and free to add/remove).
- Ring continuity field names (canonical): `ring_r1_ohm`, `ring_rn_ohm`, `ring_r2_ohm`. From `config/field_schema.json:167-185` and `config/field_schema.json:901`.
- Existing answer-resolver value-resolution path (the one we'd reuse): `src/extraction/stage6-answer-resolver.js`'s `resolveValueAnswer` (line 593) — fires when an `ask_user` carries `context_field` + `context_circuit` and the user replies with a numeric value.
- Existing auto-resolve write hook: `createAutoResolveWriteHook` in `src/extraction/stage6-dispatchers.js:168` — synthesises a `record_reading` write with a `::auto::`-tagged tool_call_id.
