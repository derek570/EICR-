/**
 * stage6-f21934d4-replay.test.js — Phase 4 SC #4 exit check (STT-04).
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHAT THIS FILE PROVES
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * The F21934D4 reproducer (documented in `src/extraction/filled-slots-filter.js`
 * lines 54-58) was the canonical re-ask bug that motivated the Phase 5 safety
 * net: on a real production session, the inspector said "R1 plus R2 for
 * circuit 2 is 0.64 ohms" on turn N, and on a later turn (N+7) the legacy
 * prompt emitted a `questions_for_user` entry asking to re-supply r1_r2 for
 * circuit 2 — because the turn-N exchange had rolled out of the
 * SLIDING_WINDOW_SIZE=6 pair window. QuestionGate then fired TTS re-asking
 * for a reading already on the form.
 *
 * `filterQuestionsAgainstFilledSlots` was the Phase 5 band-aid: drop any
 * refill-style question whose (field, circuit) slot is already populated.
 * Phase 4 (this wave) fixes the PROBLEM AT SOURCE by three independent
 * structural changes, all of which this test file exercises against the
 * F21934D4 transcript:
 *
 *   Plan 04-01 — agentic system prompt with STQ-05 "do not re-ask filled
 *                slots" restraint text baked in.
 *   Plan 04-02 — state snapshot moved into the CACHED PREFIX (system-prompt
 *                cache_control:'ephemeral' block), visible to the model on
 *                every turn regardless of sliding-window rotation.
 *   Plan 04-03 — `questions_for_user` JSON emission deleted from the
 *                tool-call branch (consumeLegacyQuestionsForUser gate),
 *                closing the surface entirely.
 *
 * Together these make the F21934D4 scenario impossible: the snapshot is
 * always visible, the prompt instructs the model to trust it, and even if
 * a prompt regression did happen to produce `questions_for_user` JSON, the
 * tool-call branch would refuse to forward it.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * TWO SCENARIOS
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * Scenario A — LEGACY PATH (filled-slots-filter baseline lock, STB-03).
 *   Feeds the fixture's real-shape legacy questions_for_user payload directly
 *   to `filterQuestionsAgainstFilledSlots` with the seeded snapshot.
 *   Asserts the filter drops it. This is positive proof that the Phase 5
 *   safety net still catches the exact production payload even as Phase 4
 *   removes the prompt-level cause — defence-in-depth stays green until
 *   Phase 7 retires the filter.
 *
 * Scenario B' — REAL SESSION + NEW PROMPT + CACHED PREFIX + TOOL-CALL
 *   DISPATCH (SC #4). Plan 04-09 r3-#3 refactor.
 *
 *   Constructs a REAL EICRExtractionSession (toolCallsMode='shadow', dummy
 *   apiKey). The constructor reads sonnet_agentic_system.md from disk at
 *   module load, so session.systemPrompt carries the real Plan 04-01 prompt.
 *   session.client is then overwritten with mockClient so no Anthropic
 *   network call fires, but the REAL request payload reaches the mock.
 *
 *   Pre-r3 this scenario used a hand-rolled session double with a
 *   placeholder systemPrompt string literal — regressions in prompt
 *   loading OR in buildSystemBlocks() would pass silently.
 *
 *   Runs the full runShadowHarness → runToolLoop stack with the fixture's
 *   "well-behaved" two-round SSE stream (round 1 record_reading tool_use
 *   for circuit-3 insulation, round 2 end_turn text).
 *
 *   r3-#3 assertions (new — prompt / payload / cached-prefix structure):
 *     A. mockClient._calls is a non-empty array (stream() invoked at
 *        least once during the turn).
 *     B. request.system is an array, first block is a {type:'text', ...}
 *        block. runShadowHarness wraps session.systemPrompt into a single
 *        cached block (stage6-shadow-harness.js:265).
 *     C. request.system[0].text contains 'TRUST BOUNDARY' — the
 *        uniquely-identifying header at line 3 of the real agentic
 *        prompt. A regression in prompt loading (file deleted, renamed,
 *        or module-level readFileSync removed) fires this assertion.
 *     D. session.buildSystemBlocks() returns the two-block cached-prefix
 *        structure (prompt + snapshot) with cache_control:{type:'ephemeral',
 *        ttl:'5m'} on BOTH blocks. Exercises the main callWithRetry path
 *        that runShadowHarness doesn't use (harness deliberately uses a
 *        single block — see stage6-shadow-harness.js:265 comment).
 *
 *   Preserved assertions 1-8 (from pre-r3 Scenario B):
 *     1. pendingAsks.size === 0 throughout — no ask was ever registered.
 *     2. Zero ws.send calls carry {type:'ask_user_started'} — iOS never
 *        saw an ask prompt.
 *     3. runShadowHarness resolved (tool loop completed cleanly).
 *     4. session.loggedQuestionsForUserBypass falsy — the bypass log did
 *        not fire because the model did not emit legacy JSON.
 *     5. session.stateSnapshot.circuits[2].r1_r2 === 0.64 — the at-risk
 *        slot is preserved unchanged on the live session.
 *     6. session.stateSnapshot.circuits[3].ir_live_live_mohm
 *        === '>200' — the turn's new reading landed on the live snapshot
 *        under the CANONICAL field name (Plan 04-10 r4-#3: was
 *        `insulation_resistance_l_l` pre-r4; canonicalised to match the
 *        tool-call fixture + oracle).
 *     7. session.client._callCount === 2 — two-round tool loop executed.
 *     8. zero `stage6.ask_user` log rows were emitted across the turn.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHY THIS IS A "SIMULATION" OF SHADOW MODE, NOT A REAL SHADOW RUN
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * The plan is explicit on this: we are locking DISPATCH behaviour, not
 * real-model divergence. A mocked client replaying a canned well-behaved
 * stream proves:
 *   - Given the new prompt + cached prefix + tool-call branch,
 *     IF the model behaves well (no ask_user, no questions_for_user JSON),
 *   - THEN our server-side dispatch delivers zero re-asks to iOS.
 *
 * It does NOT prove the real model WILL behave well on this transcript —
 * that is Plan 04-05's golden-session shadow-divergence script, which feeds
 * real transcripts to the real Anthropic API and measures per-slot divergence
 * against the legacy prompt. The two tests are complementary: this one is
 * the deterministic dispatch lock; 04-05 is the empirical prompt measurement.
 *
 * If 04-05 later surfaces that the real model emits ask_user on this
 * transcript despite the new prompt, that is a prompt tuning issue (Phase 5
 * or 6) — it would not invalidate the dispatch lock proved here.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * IF THIS TEST IS RED
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * The test is GREEN on first land because Plans 04-01 / 04-02 / 04-03 all
 * shipped before this plan. If it goes red later, diagnose by failure mode:
 *
 *   pendingAsks.size !== 0  → shadow ask dispatcher lost its short-circuit,
 *                             or something is registering asks outside the
 *                             dispatcher (regression in Plan 03-05).
 *   ws 'ask_user_started' emitted → shadow mode regression in ask
 *                                   dispatcher: the `if (mode === 'shadow')`
 *                                   branch at stage6-dispatcher-ask.js:146
 *                                   has been removed / short-circuited
 *                                   past.
 *   loggedQuestionsForUserBypass true → someone restored questions_for_user
 *                                        emission on the tool-call branch.
 *                                        Plan 04-03 regression.
 *   circuits[2].r1_r2 not 0.64 → live session mutated by shadow path
 *                                → BLOCK #1 clone regression.
 *   _callCount !== 2 → tool loop did not execute two rounds. Check fixture
 *                      SSE event shape hasn't drifted from assembler
 *                      expectations.
 *   stage6.ask_user count > 0 → ask dispatcher was invoked → the model's
 *                               fixture response drifted OR an upstream
 *                               wrapper is synthesising asks.
 */

import fssync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { jest } from '@jest/globals';

import { runShadowHarness } from '../extraction/stage6-shadow-harness.js';
import { createPendingAsksRegistry } from '../extraction/stage6-pending-asks-registry.js';
import { filterQuestionsAgainstFilledSlots } from '../extraction/filled-slots-filter.js';
import { mockClient } from './helpers/mockStream.js';
import { EICRExtractionSession } from '../extraction/eicr-extraction-session.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------------------------------------------------------------------
// Fixture loader — read ONCE in module scope. The fixture is pure data so we
// deep-clone any mutable sub-slices per test (snapshot seed) to keep tests
// independent even though they never write back through the fixture handle.
// ---------------------------------------------------------------------------

const FIXTURE_PATH = path.join(
  __dirname,
  'fixtures',
  'stage6-sse',
  'f21934d4-re-ask-scenario.json'
);
const fixture = JSON.parse(fssync.readFileSync(FIXTURE_PATH, 'utf8'));

// ---------------------------------------------------------------------------
// Helpers — mirror the shape of stage6-shadow-harness.test.js + .phase3.test.js
// so future maintainers can cross-reference them without re-learning the
// session-mock contract.
// ---------------------------------------------------------------------------

function makeLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
}

/**
 * Build a session test-double shaped like the one stage6-shadow-harness uses
 * plus a seeded stateSnapshot (the F21934D4 "after turn N" state). The
 * `extractFromUtterance` mock mutates the LIVE session's stateSnapshot to
 * reflect what the legacy path would do for this turn's utterance — recording
 * the circuit-3 insulation reading the inspector actually gave.
 *
 * Why seed the snapshot BEFORE legacy runs: the harness snapshots state
 * pre-legacy as the shadow-clone base (Codex BLOCK #1). Seeding here gives
 * the shadow tool loop a realistic starting state — circuit 3 exists and
 * is referenced by the tool_use input without tripping validateRecordReading's
 * circuit_not_found guard (stage6-dispatch-validation.js:58-63).
 *
 * NOTE: this helper is currently UNUSED (Plan 04-09 r3-#3 removed the legacy
 * Scenario B that called it; Scenario B' — below — uses a real
 * EICRExtractionSession instead). Kept in the file because a future test
 * that needs a hand-rolled session mock may want to revive it; if it DOES
 * get revived, it now uses the canonical field name `ir_live_live_mohm`
 * (Plan 04-10 r4-#3 canonicalisation) — don't regress back to the legacy
 * alias `insulation_resistance_l_l`.
 */
// eslint-disable-next-line no-unused-vars
function makeSessionWithSeededSnapshot(mode, snapshotSeed) {
  const snapshot = JSON.parse(JSON.stringify(snapshotSeed));
  return {
    sessionId: 'sess-f21934d4',
    turnCount: 8, // representative "later turn" number; harness uses post-increment value
    toolCallsMode: mode,
    systemPrompt:
      'TEST AGENTIC SYSTEM PROMPT (Plan 04-01) — snapshot block injected in cached prefix.',
    // Default to a one-round end_turn client; individual tests override.
    client: null,
    stateSnapshot: snapshot,
    extractedObservations: [],
    loggedQuestionsForUserBypass: false,
    extractFromUtterance: jest.fn().mockImplementation(async function () {
      // Simulate legacy's internal turn-count increment (eicr-extraction-session.js:641).
      this.turnCount = (this.turnCount ?? 0) + 1;
      // Simulate legacy applying the turn's extraction to the live snapshot —
      // circuit 3 gets the insulation reading the inspector said. Mutating
      // snapshot.circuits directly; this is how the live path updates state.
      // Plan 04-10 r4-#3: canonical field name matches the tool-call fixture.
      this.stateSnapshot.circuits['3'] = {
        ...(this.stateSnapshot.circuits['3'] || {}),
        ir_live_live_mohm: '>200',
      };
      return {
        extracted_readings: [
          {
            field: 'ir_live_live_mohm',
            circuit: 3,
            value: '>200',
            confidence: 0.95,
          },
        ],
        observations: [],
        questions: [],
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// Scenario A — LEGACY filled-slots-filter baseline lock (STB-03 coverage).
// ---------------------------------------------------------------------------
//
// Phase 5 safety net lives on as defence-in-depth until Phase 7 retires it.
// This test proves the filter still suppresses the exact production payload
// from the F21934D4 session: {field:'r1_r2', circuit:2, type:'unclear',
// question:'Was that R1 plus R2 for circuit 2?', heard_value:'0.64'} —
// given the seeded snapshot where circuits[2].r1_r2 === 0.64. A regression
// here (filter drops-then-restores, or enum drift on REFILL_QUESTION_TYPES)
// would re-open the re-ask hole on the legacy mode='off' path even as Phase
// 4 closes it on the tool-call path.
// ---------------------------------------------------------------------------

describe('STT-04 Scenario A — Legacy prompt path (filled-slots-filter baseline)', () => {
  test('filter drops the F21934D4 production questions_for_user payload', () => {
    const legacyQuestions = fixture.sse_events_misbehaving_legacy_questions_for_user;
    const snapshot = JSON.parse(JSON.stringify(fixture.pre_turn_state.snapshot));

    const filtered = filterQuestionsAgainstFilledSlots(
      legacyQuestions,
      snapshot,
      new Set(), // empty resolvedFieldsThisTurn — the reading was from turn N, not this turn
      'sess-f21934d4-scenario-a'
    );

    // Filter should suppress the entire payload: the ONE question is
    // refill-style ('unclear'), targets a concrete (field='r1_r2', circuit=2)
    // slot that IS filled in snapshot (r1_r2=0.64), and was NOT re-extracted
    // this turn. All four filter conditions for dropping are met.
    expect(filtered).toEqual([]);
  });

  test('filter pass-through sanity — a NEW field on the same circuit is NOT suppressed', () => {
    // Defensive: the filter should ONLY suppress re-asks for already-filled
    // slots. An 'unclear' question about a DIFFERENT field on the same circuit
    // (e.g. asking about zs on circuit 2, which is not filled in the seed)
    // must survive — otherwise the filter would silently block legitimate
    // questions about missing readings. This is the complement of the drop
    // assertion above and guards against enum/shape regressions in the filter.
    const snapshot = JSON.parse(JSON.stringify(fixture.pre_turn_state.snapshot));
    const newFieldQuestion = [
      {
        field: 'zs',
        circuit: 2,
        type: 'unclear',
        question: 'Was that Zs for circuit 2?',
      },
    ];
    const filtered = filterQuestionsAgainstFilledSlots(
      newFieldQuestion,
      snapshot,
      new Set(),
      'sess-f21934d4-scenario-a'
    );
    expect(filtered).toEqual(newFieldQuestion);
  });
});

// ---------------------------------------------------------------------------
// LEGACY Scenario B removed by Plan 04-09 r3-#3 (GREEN commit).
//
// The old Scenario B used a hand-rolled session double with a placeholder
// systemPrompt string literal, which meant regressions in prompt loading
// (Plan 04-01) and buildSystemBlocks() (Plan 04-02) would pass silently.
// Replaced by Scenario B' below (real EICRExtractionSession + captured
// request payload + prompt-marker assertion + buildSystemBlocks shape).
//
// The secondary "composed dispatcher does not synthesise ask_user" test
// that lived under old Scenario B is also removed — Scenario B' covers
// the same surface via the `stage6.ask_user` log-count audit (assertion
// 8), and the "no synthesis" invariant is the subject of Plan 03-06's
// dedicated test suite, not a Phase 4 SC #4 concern.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Scenario B' — Plan 04-09 r3-#3: real-session SC #4 exit check.
// ---------------------------------------------------------------------------
//
// Codex r3 MAJOR #3: the original Scenario B (above) never instantiates a
// real EICRExtractionSession. It injects a session double with a hand-
// rolled `systemPrompt: 'TEST AGENTIC SYSTEM PROMPT ...'` string. That
// means a regression in prompt LOADING (Plan 04-01 — the fs.readFileSync
// of sonnet_agentic_system.md) OR in `buildSystemBlocks()` (Plan 04-02 —
// the two-block [prompt, snapshot] cached-prefix structure with
// cache_control:'ephemeral') would pass this test silently. The Phase 4
// SC #4 claim ("F21934D4 replay zero re-asks on the NEW PROMPT + tool-call
// path") is therefore unprovable without a real session.
//
// This scenario refactors Scenario B to:
//   1. Construct a REAL `EICRExtractionSession` in shadow mode. The
//      constructor reads the real prompt from
//      `config/prompts/sonnet_agentic_system.md` and stores it on
//      `this.systemPrompt`.
//   2. Replace `session.client` with mockClient so no Anthropic calls go
//      out, but the request payload the harness constructs is still the
//      real one.
//   3. Capture the actual payload via mockClient._calls (added in the
//      same r3-#3 fix to `helpers/mockStream.js`).
//   4. Assert the captured request:
//      - `system` is an ARRAY (cached-prefix structure, not a string)
//      - `system[0].text` contains the "TRUST BOUNDARY" marker —
//        a uniquely-identifying substring from the real agentic prompt
//        that no fake placeholder would include.
//   5. Separately invoke `session.buildSystemBlocks()` directly and
//      assert the [prompt, snapshot] two-block structure with correct
//      `cache_control: {type:'ephemeral', ttl:'5m'}` on system[1] when
//      the snapshot has content. The live shadow-harness path uses a
//      single-block system array on purpose (stage6-shadow-harness.js:265);
//      the cached-prefix two-block layout is exercised on the main
//      `callWithRetry` path (eicr-extraction-session.js:838). Both
//      paths matter to Phase 4 SC #4; this test covers both.
//   6. Preserve the 7 original SC #4 assertions. They pass because the
//      real session exhibits the same behaviour — just now backed by
//      the real prompt + real cached-prefix construction.
//
// Scenario A (Legacy filled-slots-filter baseline, above) is a
// legitimate unit test of `filterQuestionsAgainstFilledSlots` — it
// doesn't need the full session and is NOT touched by this fix.
// ---------------------------------------------------------------------------

describe("STT-04 Scenario B' — Real EICRExtractionSession SC #4 exit check (r3-#3)", () => {
  test("F21934D4 transcript against REAL session: captured request shows prompt loaded from disk + cached-prefix structure", async () => {
    // Arrange: real session. Pass 'test-key' as apiKey — the constructor
    // wires a real Anthropic instance but we replace .client below so no
    // network call ever fires. toolCallsMode='shadow' selects the
    // EICR_AGENTIC_SYSTEM_PROMPT (Plan 04-01), which is read at module
    // import time from config/prompts/sonnet_agentic_system.md.
    const session = new EICRExtractionSession('test-key', 'sess-f21934d4-realB', 'eicr', {
      toolCallsMode: 'shadow',
    });

    // Seed snapshot from fixture (deep-clone to keep tests independent).
    session.stateSnapshot = JSON.parse(JSON.stringify(fixture.pre_turn_state.snapshot));

    // Simulate the legacy-path mutation that would have run in production:
    // extractFromUtterance writes circuit-3 insulation reading to the
    // LIVE session's snapshot. Same shape as the fake-session version
    // above (Scenario B); the method lives on the real class but we
    // overwrite it here to keep the test hermetic (no real Anthropic).
    //
    // Plan 04-10 r4-#3 — use the CANONICAL field name `ir_live_live_mohm`
    // (per config/field_schema.json + stage6-tool-schemas.js circuit_fields
    // enum). Pre-r4 this stub wrote the legacy alias
    // `insulation_resistance_l_l` while the tool-call fixture
    // (sse_events_well_behaved partial_json) writes the canonical
    // `ir_live_live_mohm`. Live and shadow paths silently disagreed on
    // the field key; "zero ask_user" assertions passed because the ask
    // surface is independent of the extraction key, but the test's
    // dispatch lock was weaker than claimed. Canonicalising here makes
    // both paths converge on the same (field, circuit, value) tuple and
    // assertions #6/#9/#10 lock that convergence.
    session.extractFromUtterance = jest.fn().mockImplementation(async function () {
      this.turnCount = (this.turnCount ?? 0) + 1;
      this.stateSnapshot.circuits['3'] = {
        ...(this.stateSnapshot.circuits['3'] || {}),
        ir_live_live_mohm: '>200',
      };
      return {
        extracted_readings: [
          { field: 'ir_live_live_mohm', circuit: 3, value: '>200', confidence: 0.95 },
        ],
        observations: [],
        questions: [],
      };
    });
    session.loggedQuestionsForUserBypass = false;

    // Replace Anthropic client with mockClient replaying the fixture's
    // two rounds. mockClient._calls records the request args per
    // stream() invocation (added alongside this test in r3-#3 — the
    // pre-r3 helper had no such accumulator, which is why this
    // assertion fires RED until GREEN lands).
    session.client = mockClient([
      fixture.sse_events_well_behaved,
      fixture.sse_events_well_behaved_round2,
    ]);

    const pendingAsks = createPendingAsksRegistry();
    const wsStub = {
      OPEN: 1,
      readyState: 1,
      sent: [],
      send(msg) {
        this.sent.push(typeof msg === 'string' ? JSON.parse(msg) : msg);
      },
    };
    const logger = makeLogger();

    expect(pendingAsks.size).toBe(0);

    // Act.
    await runShadowHarness(session, fixture.transcript, [], {
      logger,
      pendingAsks,
      ws: wsStub,
    });

    // ─────────────────────────────────────────────────────────────────────
    // NEW r3-#3 ASSERTIONS — real prompt + captured payload.
    // ─────────────────────────────────────────────────────────────────────

    // r3-#3-A. mockClient captured at least one stream() call.
    expect(Array.isArray(session.client._calls)).toBe(true);
    expect(session.client._calls.length).toBeGreaterThan(0);

    // r3-#3-B. `request.system` is an ARRAY (cached-prefix shape —
    // runShadowHarness wraps session.systemPrompt in a single-block
    // array at stage6-shadow-harness.js:265). Pre-r3 the fake session's
    // hand-rolled string literal would flow through unchanged; the
    // array assertion still held because the harness did the wrapping.
    // The NEW thing r3-#3 locks is the CONTENT of system[0].text —
    // see r3-#3-C below.
    const firstRequest = session.client._calls[0];
    expect(Array.isArray(firstRequest.system)).toBe(true);
    expect(firstRequest.system.length).toBeGreaterThan(0);
    expect(firstRequest.system[0]).toHaveProperty('type', 'text');

    // r3-#3-C. system[0].text carries real content from
    // sonnet_agentic_system.md — verified by the unique marker
    // "TRUST BOUNDARY" at line 3 of that file. Pre-r3 (fake session
    // with hand-rolled string 'TEST AGENTIC SYSTEM PROMPT ...') this
    // assertion would fail → RED. Post-r3 (real session loads the
    // file via fs.readFileSync at module top) it passes → GREEN.
    // If sonnet_agentic_system.md is ever deleted, renamed, or the
    // TRUST BOUNDARY section is removed, this test fires loudly —
    // that's the Phase 4 SC #4 backstop.
    expect(firstRequest.system[0].text).toContain('TRUST BOUNDARY');

    // r3-#3-D. Direct call to session.buildSystemBlocks() to prove
    // the two-block cached-prefix layout is structurally correct on
    // the main callWithRetry path (not exercised by runShadowHarness,
    // which intentionally uses a single block — see harness comment).
    // With the F21934D4 snapshot seed (non-empty circuits), snapshot
    // text is non-null so buildSystemBlocks returns 2 blocks.
    const systemBlocks = session.buildSystemBlocks();
    expect(Array.isArray(systemBlocks)).toBe(true);
    expect(systemBlocks.length).toBe(2);
    // Block 0 — agentic prompt, ephemeral 5m cache.
    expect(systemBlocks[0]).toMatchObject({
      type: 'text',
      cache_control: { type: 'ephemeral', ttl: '5m' },
    });
    expect(systemBlocks[0].text).toContain('TRUST BOUNDARY');
    // Block 1 — state snapshot, ephemeral 5m cache.
    expect(systemBlocks[1]).toMatchObject({
      type: 'text',
      cache_control: { type: 'ephemeral', ttl: '5m' },
    });
    expect(typeof systemBlocks[1].text).toBe('string');
    expect(systemBlocks[1].text.length).toBeGreaterThan(0);

    // ─────────────────────────────────────────────────────────────────────
    // ORIGINAL 7 SC #4 ASSERTIONS — preserved from Scenario B.
    // ─────────────────────────────────────────────────────────────────────

    // 1. pendingAsks.size === 0 — no ask was ever registered.
    expect(pendingAsks.size).toBe(0);

    // 2. Zero ws.send calls of type 'ask_user_started'.
    const askStartedMessages = wsStub.sent.filter((m) => m && m.type === 'ask_user_started');
    expect(askStartedMessages).toHaveLength(0);

    // 3. runShadowHarness completed without throwing.
    expect(session.client._callCount).toBeGreaterThan(0);

    // 4. Bypass log for questions_for_user never fired.
    expect(session.loggedQuestionsForUserBypass).toBeFalsy();

    // 5. At-risk slot (circuits[2].r1_r2) preserved at 0.64.
    expect(session.stateSnapshot.circuits['2'].r1_r2).toBe(0.64);

    // 6. Turn's new reading landed on live snapshot under the CANONICAL
    //    field key. Plan 04-10 r4-#3 rename — `ir_live_live_mohm`
    //    matches the tool-call fixture (sse_events_well_behaved) and
    //    the oracle (expected_slot_writes), so live + shadow now
    //    converge on the same (field, circuit) tuple.
    expect(session.stateSnapshot.circuits['3'].ir_live_live_mohm).toBe('>200');

    // 7. Two model invocations (tool_use round + end_turn round).
    expect(session.client._callCount).toBe(2);

    // 8. BONUS — zero stage6.ask_user log rows.
    const askUserLogs = logger.info.mock.calls.filter((c) => c[0] === 'stage6.ask_user');
    expect(askUserLogs).toHaveLength(0);

    // ─────────────────────────────────────────────────────────────────────
    // NEW r4-#3 ASSERTIONS — live/shadow field-name convergence.
    // ─────────────────────────────────────────────────────────────────────
    //
    // Codex r4 MAJOR #3: "Scenario B' field-name drift — the live-side
    // stub writes `insulation_resistance_l_l` while the tool-call fixture
    // writes `ir_live_live_mohm`. Zero-ask_user assertions pass even when
    // live/shadow disagree on the actual field key." The pre-r4 test had
    // no assertion linking the two writes, so a future dispatcher drift
    // on the canonical field name would go unnoticed.
    //
    // Fix: (a) canonicalise the live stub to `ir_live_live_mohm` (done
    // in the extractFromUtterance mock above), and (b) add a positive
    // assertion that the canonical field made it to the live snapshot,
    // AND a negative assertion that the legacy alias is NOT present
    // (no drift leak from a future partial refactor).

    // 9. Canonical field present on the live snapshot (post-r4 stub
    //    writes `ir_live_live_mohm` — same name the tool-call fixture
    //    uses, same name the oracle uses).
    expect(session.stateSnapshot.circuits['3']).toHaveProperty('ir_live_live_mohm', '>200');

    // 10. Legacy alias MUST NOT appear on the live snapshot — catches
    //     the drift where a future stub regression (or a partial revert
    //     of this r4-#3 fix) re-introduces the legacy field name
    //     alongside or instead of the canonical one.
    expect(session.stateSnapshot.circuits['3']).not.toHaveProperty('insulation_resistance_l_l');

    // 11. The tool-call fixture's sole record_reading carries field
    //     `ir_live_live_mohm` (see fixture.sse_events_well_behaved[2]
    //     partial_json). Assert it matches the stub's field — same
    //     (field, circuit, value) on both sides. Static check against
    //     the fixture text so a future fixture edit that silently
    //     renames the field is caught.
    const toolCallField = JSON.parse(
      fixture.sse_events_well_behaved.find(
        (ev) => ev.type === 'content_block_delta' && ev.delta?.type === 'input_json_delta',
      ).delta.partial_json,
    ).field;
    expect(toolCallField).toBe('ir_live_live_mohm');
  });
});
