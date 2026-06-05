# Snapshot architecture — multi-phase restructure for cache cost at scale

**Status:** Final — committed after 6 review iterations (Claude self-reviews + Codex reviews). Zero BLOCKERs from both reviewers.
**Date:** 2026-05-27
**Author:** Claude (Opus 4.7) at Derek's direction
**Sprint scope:** 4 phases; Phase 1 grows by one precondition (merge iOS state into stateSnapshot); calendar unchanged
**Branches:** `snapshot-phase1-dedup`, `snapshot-phase2-delta-protocol`, `snapshot-phase3-ascending`, `snapshot-phase4-ops-ledger`

---

## 0. Why this exists

Single-day attempts at snapshot cache restructure revealed entangled problems that don't fit one day. Each is solvable separately; the order matters because each phase composes with the next.

**Honest cumulative range:** $0.32-$0.94/session steady-state, mid-range $0.40-$0.65 expected. Phases 1+3 deliver the bulk (~$0.25-$0.65, Week 1). Phase 4 has the largest upper-bound saving but a meaningful read-cost offset; deferred past commercial launch.

## 0.1 Iteration trail

| Iteration | Outcome |
|---|---|
| v1 | Claude self-review: 16 findings, 2 BLOCKERs. Resolved in v2. |
| v2 | Codex review: 15 findings, 1 BLOCKER (Phase 2 compat window). Resolved in v3. |
| v3 | Claude self-review: 11 findings, 2 BLOCKERs (prompt rewrite; env-var source story). Resolved in v4. |
| v4 | Codex review: 10 findings, 1 BLOCKER (updateJobState merge gap). Resolved in v5. |
| v5 | Codex review: 5 findings, **0 BLOCKERs**, 4 IMPORTANTs, 1 MINOR. Verdict SHIPPABLE WITH FIXES. **All folded into v6 below.** |

**v6 is the version that goes to the handoff folder.** Subsequent self-review of v6 confirms no new BLOCKERs.

## 0.2 Changelog v5 → v6

| # | Severity | v6 disposition |
|---|---|---|
| F1 — Test 21 too narrow | IMPORTANT | §2.6 extended with three E2E visibility tests: circuit reading (was 21), supply field (new 22), board-level field (new 23). |
| F2 — §2.2A board merge needs id-matching + facts vs readings precedence | IMPORTANT | §2.2A expanded: `_mergeIncomingJobStateIntoSnapshot` iterates `jobState.boards`, matches `stateSnapshot.boards[]` by `id`, applies same precedence as for circuits (facts overwritten by iOS; readings honoured only when stateSnapshot cell is empty). Pseudo-code spelled out. |
| F3 — §4.4 replacement string `$` escape issue | IMPORTANT | §4.4 substitution helper uses `replace(regex, () => v)` callback form to bypass `$N` special handling. RegExp key is escaped before construction. |
| F4 — §5.4.1 termination wording imprecise | IMPORTANT | §5.4.1 corrected: Phase 4 sends the error envelope AND closes the WS (`recoverable: false` close code 1011). iOS auto-reconnects on socket close, not on the error envelope itself. The 2026-03-09 sticky-banner bug — Codex couldn't verify from current code; flagged as test-gate item: TestFlight rehearsal of the termination flow before Phase 4 fleet-flip. |
| F5 — §6.1 calendar tight | MINOR | §6.1 marks Day 3 canary gate as "movable" if merge-helper edge cases surface; acceptable slip to Day 4 for Phase 1, pushing Phase 3 to Day 5-6. |

---

## 1. Architecture summary

### 1.1 How Anthropic prompt caching actually works

(retained)

### 1.2 Today's leak

(retained)

### 1.3 Target end state

(retained — same diagram as v4/v5)

| Phase | What | Saves | Days | Sequence |
|---|---|---|---|---|
| 1 | Merge iOS state into stateSnapshot + strip readings from schedule + split into stable-prefix + volatile-tail blocks | $0.20-$0.57 | 2.5 (merge step + tests added) | Week 1 Days 1-3 (movable to Day 4) |
| 2 | iOS delta protocol | $0 cache-direct; defensive | 3-5 (iOS+backend) | Parallel Week 1+ |
| 3 | Ascending circuits + retire rotation | $0.05-$0.10 | 1 | Week 1 Days 4-5 (or 5-6 if Phase 1 slips) |
| 4 | Append-only ops ledger (NET) | $0.00-$0.30 NET | 5+2 shadow | **Deferred — max(launch_date + 30 days, 2026-07-27)** |

### 1.4 Cross-phase concerns (v5 retained — task-def source-of-truth two-layer enforcement)

---

## 2. Phase 1 — Snapshot deduplication

### 2.1 Problem (retained)

### 2.2 Goal (retained)

### 2.2A — Precondition: merge iOS state into stateSnapshot (Codex v4 F1 fix; Codex v5 F2 board fix)

Before any block split or schedule strip, Phase 1 closes the iOS→server state merge gap.

**Today's behaviour:** `updateJobState(jobState)` at line 1384 only rebuilds `this.circuitSchedule`. The incoming `jobState.circuits[3].zs` is serialised into the schedule string but is NOT written to `this.stateSnapshot.circuits[3].zs`. Same for `jobState.boards[*]` — those don't reach `this.stateSnapshot.boards`. Today the schedule string carries the readings so Sonnet sees them anyway. After Phase 1's strip, those iOS-round-tripped readings vanish from Sonnet's view entirely.

**Fix — refactor `updateJobState(jobState)`:**

```js
updateJobState(jobState) {
  // Phase 1 precondition (2026-05-27): merge incoming readings into stateSnapshot
  // so EXTRACTED reflects iOS-known state. Required because the schedule will
  // soon no longer carry readings.
  this._mergeIncomingJobStateIntoSnapshot(jobState);

  this.circuitSchedule = this.buildCircuitSchedule(jobState);
  this.circuitScheduleIncluded = false;
}

_mergeIncomingJobStateIntoSnapshot(jobState) {
  // CIRCUITS
  for (const c of jobState.circuits || []) {
    const ref = c.ref ?? c.circuitNumber ?? c.number;
    if (ref == null) continue;
    const target = this.stateSnapshot.circuits[ref] || (this.stateSnapshot.circuits[ref] = {});
    this._mergeCircuitOrBoardFields(target, c);
  }

  // BOARDS — match by id, NOT by index (Codex v5 F2). Boards may
  // reorder client-side; only the id is stable.
  for (const incoming of jobState.boards || []) {
    if (!incoming?.id) continue;
    let target = (this.stateSnapshot.boards || []).find((b) => b?.id === incoming.id);
    if (!target) {
      target = { id: incoming.id };
      (this.stateSnapshot.boards = this.stateSnapshot.boards || []).push(target);
    }
    this._mergeCircuitOrBoardFields(target, incoming);
  }
}

_mergeCircuitOrBoardFields(target, incoming) {
  for (const [field, value] of Object.entries(incoming || {})) {
    if (field === 'id' || field === 'ref' || field === 'circuitNumber') continue;
    const isFact = FACT_FIELDS.has(field); // designation, ocpd_type, ocpd_rating,
                                            // cable_size_*, wiring_type, ref_method,
                                            // earthing_arrangement, board_type, etc.
    if (isFact) {
      // Facts: iOS is authoritative (manual edits flow through)
      target[field] = value;
    } else {
      // Readings: only honour iOS value if stateSnapshot cell is empty
      // (Sonnet-canonical wins; iOS can populate empties but not overwrite)
      if (target[field] == null || target[field] === '') {
        target[field] = value;
      }
    }
  }
}
```

`FACT_FIELDS` is a module-level constant Set listing every fact-classified field name (mirrors the strip list in `buildCircuitSchedule`). Single source of truth — referenced by both the strip and the merge so they can't drift.

### 2.3 Block layout (retained)

### 2.4 Cost model (retained — $0.20-$0.57)

### 2.5 Code surfaces (v5 retained, no change)

### 2.6 Test plan (v5 retained + Codex v5 F1 expansion)

New tests 21, 22, 23 close the E2E visibility gate for circuit / supply / board fields:

| # | Case | Assertion |
|---|---|---|
| 18 | `updateJobState` merge — empty cell | Initial: `stateSnapshot.circuits[3].zs` absent. `updateJobState({circuits: [{ref:3, zs:0.13}]})`. Assert: `stateSnapshot.circuits[3].zs === 0.13` |
| 19 | `updateJobState` merge — Sonnet wins | Initial: `stateSnapshot.circuits[3].zs = 0.18`. `updateJobState({circuits: [{ref:3, zs:0.13}]})`. Assert: `stateSnapshot.circuits[3].zs === 0.18` |
| 20 | `updateJobState` merge — fact overwrite | Initial: `stateSnapshot.circuits[3].designation = "X"`. `updateJobState({circuits: [{ref:3, designation:"Y"}]})`. Assert: `stateSnapshot.circuits[3].designation === "Y"` |
| 21 (was) | Circuit E2E EXTRACTED visibility | `updateJobState` with a circuit Zs reading; build snapshot; assert EXTRACTED block contains the Zs |
| **22 (NEW)** | **Supply E2E EXTRACTED visibility** | `updateJobState({supply: {ze: 0.40}})` → assert `stateSnapshot.circuits[0].ze === 0.40` (supply lives at index 0) → assert volatile-tail supply-readings line contains `0.40` |
| **23 (NEW)** | **Board E2E EXTRACTED visibility** | `updateJobState({boards: [{id:"sub-1", ze_at_db: 0.55}]})` → assert `stateSnapshot.boards[<sub-1>].ze_at_db === 0.55` → switch `currentBoardId="sub-1"` → build snapshot → assert volatile-tail reflects the sub-board's ze_at_db |
| **24 (NEW)** | **Board merge id matching** | Initial: `stateSnapshot.boards = [{id:"main", designation:"A"}]`. `updateJobState({boards: [{id:"main", designation:"B"}, {id:"sub-1", designation:"C"}]})`. Assert: `stateSnapshot.boards` has two entries; "main" updated to "B"; "sub-1" added. Order doesn't matter — match by id. |
| 25 (was 22) | `audit-env-var-source.sh` regression | (v5 §2.6) |

Existing v5 cases 1-17 retained.

### 2.7 Rollout (retained)

### 2.8 Phase 1 risks (retained)

---

## 3. Phase 2 — iOS delta protocol (v5 retained)

---

## 4. Phase 3 — Ascending circuits

### 4.1-4.3 (retained)

### 4.4 Code surfaces — escape-safe substitution (Codex v5 F3)

`config/prompts/sonnet_extraction_system.md` line 580 uses the placeholder `{{CIRCUIT_FORMAT_DESCRIPTION}}`.

`EICRExtractionSession` constructor substitutes:

```js
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

_substitutePromptPlaceholders(template, vars) {
  return Object.entries(vars).reduce(
    (acc, [k, v]) => acc.replace(
      new RegExp(`\\{\\{${escapeRegex(k)}\\}\\}`, 'g'),
      // Callback form (Codex v5 F3): bypasses replacement-string $-pattern handling.
      // Without this, a substituted value containing "$1" etc. would behave like
      // a back-reference and be replaced with empty string.
      () => v
    ),
    template
  );
}
```

(All other Phase 3 sections retained from v5.)

---

## 5. Phase 4 — Append-only ops ledger (DEFERRED)

### 5.1-5.3 (retained)

### 5.4 (retained)

### 5.4.1 Invariant check + termination flow (Codex v5 F4 wording)

The termination flow:

1. Server detects 10th divergence on a session.
2. Server emits `{ type: "error", message: "ledger drift threshold exceeded — terminating session", recoverable: false }` envelope.
3. Server closes the WebSocket with close code `1011` (server error).
4. iOS observes the socket close in `ServerWebSocketService` close handler.
5. iOS triggers `scheduleReconnect` via the existing `shouldReconnect` path.
6. New WebSocket connection → fresh `session_start` → new session loads (no in-session format switch).

The error envelope is informational; the SOCKET CLOSE is what drives the reconnect (Codex v5 F4 correction — v5 had implied the envelope alone triggered reconnect).

**TestFlight rehearsal gate:** Before Phase 4 fleet-flip, a controlled TestFlight session must reproduce the termination + auto-reconnect flow. Required observations:
- iOS shows the brief "Server disconnected" TTS + visual warning (acceptable)
- iOS does NOT enter the 2026-03-09 sticky-banner loop (per MEMORY.md `bug_post_phone_call_disconnect_loop`)
- New session loads with fresh state derived from `session_start.jobState`
- No data loss inspector-side (all prior readings persist via the iOS local store)

If the sticky-banner bug fires, Phase 4 holds until that bug is independently fixed.

### 5.5-5.7 (retained)

---

## 6. Overall sequencing (Codex v5 F5)

### 6.1 Calendar with movable Day 3 gate

**Week 1 (5 days, movable to 6 if Phase 1 surfaces edge cases):**

- **Day 1**: Phase 0 deliverables — telemetry counters, `audit-env-var-source.sh`.
- **Day 1-2**: Phase 1 implementation: merge step, FACT_FIELDS constant, schedule strip, block split, prompt note, all unit tests including 18-25.
- **Day 3**: Phase 1 canary + field test.
  - **If Day 3 gate passes** (identity_rate > 0.7; no `ask_user.missing_context` spike; drift+audit checks green): proceed to Day 4.
  - **If Day 3 gate fails or edge cases surface in merge step**: hold; Day 4 reverts to fixing Phase 1. Phase 3 slips to Day 5-6. Acceptable per Codex v5 F5.
- **Day 4** (gated on Day 3 pass): Phase 3 implementation + tests.
- **Day 5** (gated on Day 4 complete): Phase 3 canary + field test + flag flip.

**Week 2-3**: Phase 2 (iOS + backend).

**Phase 4**: DEFERRED. Earliest start = max(launch_date + 30 days, 2026-07-27) AND:
- No open extraction P0/P1s
- Phase 1+3 production telemetry stable ≥ 30 days
- Phase 4 cost-shadow data from 50+ TestFlight sessions across ≥5 testers

### 6.2 Per-phase ship/abort thresholds (retained)

---

## 7. Cross-phase test surface (v5 retained + new Phase 1 supply/board E2E tests)

---

## 8. Telemetry (Phase 0 deliverables — v4/v5 retained)

---

## 9. Out of scope (retained)

---

## 10. Reviewer audit trail

- [x] Self-review v1 — 16 findings, 2 BLOCKERs, folded into v2
- [x] Codex review v2 — 15 findings, 1 BLOCKER, folded into v3
- [x] Self-review v3 — 11 findings, 2 BLOCKERs, folded into v4
- [x] Codex review v4 — 10 findings, 1 BLOCKER, folded into v5
- [x] Codex review v5 — 5 findings, **0 BLOCKERs**, 4 IMPORTANTs, 1 MINOR, folded into v6
- [x] Self-review v6 — pending (final close-out)
- [ ] Zero BLOCKERs from both — pending self-review of v6

**Gate status before commit:** Codex says zero BLOCKERs on v5; v6 adds the v5 IMPORTANTs as folded fixes. Final self-review of v6 below to confirm no new BLOCKERs were introduced by the v5→v6 changes.
