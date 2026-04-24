/**
 * Tests for stage6-shadow-harness — Phase 2 rewire (Plan 02-06).
 *
 * Phase 1 canned-replay tests in this file were REPLACED when the harness
 * itself was rewired to drive runToolLoop (real tool loop, mocked Anthropic
 * client). The original Phase 1 shape lives in git history at the tip of
 * Phase 1 merge commit.
 *
 * Phase 2 contract under test:
 *   - mode='off'    → passthrough, NO tool loop, NO divergence log
 *   - mode='shadow' → legacy runs, tool loop runs with mocked client,
 *                     bundler + comparator fire, one stage6_divergence row
 *                     emitted with phase:2, bundler_phase:2.
 *                     Legacy result is returned (iOS wire unchanged).
 *   - mode='live'   → throws (Phase 7 guard preserved from Phase 1).
 *   - legacy throw  → propagates, no divergence log
 *   - tool-loop throw → caught; legacy returned; warn log emitted
 *
 * Full multi-round + same-turn-correction behaviour is covered by the
 * dedicated E2E files (stage6-tool-loop-e2e.test.js, stage6-same-turn-
 * correction.test.js). This file locks the mode-gating + error-path contract.
 */

import { jest } from '@jest/globals';

import { runShadowHarness } from '../extraction/stage6-shadow-harness.js';
import { mockClient } from './helpers/mockStream.js';

function makeLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
}

/**
 * Single-round end_turn stream: no tool calls, terminates cleanly. This is
 * the minimal valid tool-loop response shape — used when the test only
 * cares that the loop RAN, not what it did.
 */
function endTurnStreamEvents(text = 'done') {
  return [
    { type: 'message_start', message: { id: 'msg_end', role: 'assistant', content: [] } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
    { type: 'message_stop' },
  ];
}

function makeSession(mode, legacyResult = { extracted_readings: [], observations: [], questions: [] }) {
  return {
    sessionId: 'sess-1',
    turnCount: 0,
    toolCallsMode: mode,
    systemPrompt: 'TEST SYSTEM PROMPT',
    client: mockClient([endTurnStreamEvents('ok')]),
    stateSnapshot: { circuits: {}, pending_readings: [], observations: [], validation_alerts: [] },
    extractedObservations: [],
    // Plan 04-11 r5-#1 — stubs now implement buildSystemBlocks() so the
    // harness can call it uniformly. Shape mirrors EICRExtractionSession's
    // real method: 1 block in off-mode (or when snapshot is empty);
    // 2 blocks in non-off mode when `_snapshot` is set on the stub.
    // The `_snapshot` opt-in lets tests drive the two-block path without
    // standing up a real session for the simple mode-gating assertions
    // this suite owns.
    _snapshot: null,
    buildSystemBlocks() {
      const base = {
        type: 'text',
        text: this.systemPrompt,
        cache_control: { type: 'ephemeral', ttl: '5m' },
      };
      if (this.toolCallsMode === 'off') return [base];
      if (!this._snapshot) return [base];
      return [
        base,
        {
          type: 'text',
          text: this._snapshot,
          cache_control: { type: 'ephemeral', ttl: '5m' },
        },
      ];
    },
    extractFromUtterance: jest.fn().mockImplementation(async function () {
      // Simulate legacy's internal turn-count increment.
      this.turnCount = (this.turnCount ?? 0) + 1;
      return legacyResult;
    }),
  };
}

describe('runShadowHarness — Phase 2', () => {
  describe("mode='off'", () => {
    test('passthrough: legacy called once, NO divergence log, NO tool loop', async () => {
      const logger = makeLogger();
      const s = makeSession('off', { foo: 'bar' });
      const result = await runShadowHarness(s, 'transcript', [{ r: 1 }], {
        logger,
        confirmationsEnabled: true,
      });

      expect(s.extractFromUtterance).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ foo: 'bar' });
      expect(logger.info).not.toHaveBeenCalledWith('stage6_divergence', expect.anything());
      // Shadow-off idempotency: no tool-loop API call issued.
      expect(s.client._callCount).toBe(0);
    });

    test('missing toolCallsMode defaults to off (safe default)', async () => {
      const logger = makeLogger();
      const s = {
        sessionId: 'sess-x',
        turnCount: 0,
        extractFromUtterance: jest.fn().mockResolvedValue({ ok: true }),
      };
      const result = await runShadowHarness(s, 'text', [], { logger });
      expect(result).toEqual({ ok: true });
      expect(logger.info).not.toHaveBeenCalledWith('stage6_divergence', expect.anything());
    });
  });

  describe("mode='shadow'", () => {
    test('drives real tool loop, logs stage6_divergence with phase:2 + bundler_phase:2', async () => {
      const logger = makeLogger();
      const s = makeSession('shadow', {
        extracted_readings: [],
        observations: [],
        questions: [],
      });
      const result = await runShadowHarness(s, 'text', [], { logger });

      // Legacy result returned verbatim — iOS byte-identical.
      expect(result).toEqual({ extracted_readings: [], observations: [], questions: [] });

      // Tool loop was invoked exactly once.
      expect(s.client._callCount).toBe(1);

      const call = logger.info.mock.calls.find((c) => c[0] === 'stage6_divergence');
      expect(call).toBeDefined();
      const payload = call[1];
      expect(payload).toEqual(
        expect.objectContaining({
          sessionId: 'sess-1',
          phase: 2,
          bundler_phase: 2,
          divergent: false,
          reason: 'identical',
          rounds: 1,
          aborted: false,
          shadow_cost_usd: null,
        }),
      );
      // Structural: legacy_slots and tool_slots are JSON-safe (plain object /
      // arrays), not raw Map/Set.
      expect(typeof payload.legacy_slots.readings).toBe('object');
      expect(Array.isArray(payload.tool_slots.observations)).toBe(true);
    });

    test('turnId matches session.turnCount AFTER legacy increment', async () => {
      const logger = makeLogger();
      const s = makeSession('shadow');
      s.turnCount = 4; // Legacy will increment to 5 during the call.

      await runShadowHarness(s, 'text', [], { logger });

      expect(s.turnCount).toBe(5);
      const call = logger.info.mock.calls.find((c) => c[0] === 'stage6_divergence');
      expect(call[1].turnId).toBe('sess-1-turn-5');
    });

    test('if legacy throws, rethrows and does NOT emit divergence log or run tool loop', async () => {
      const logger = makeLogger();
      const s = makeSession('shadow');
      s.extractFromUtterance.mockRejectedValueOnce(new Error('legacy fail'));

      await expect(runShadowHarness(s, 'text', [], { logger })).rejects.toThrow('legacy fail');
      expect(logger.info).not.toHaveBeenCalledWith('stage6_divergence', expect.anything());
      expect(s.client._callCount).toBe(0);
    });

    test('tool-loop failure is CAUGHT: warn logged, legacy returned, no stage6_divergence row', async () => {
      const logger = makeLogger();
      // Client.messages.stream throws synchronously when called.
      const s = makeSession('shadow', { legacy: true });
      s.client = {
        messages: {
          stream() {
            throw new Error('anthropic network blew up');
          },
        },
      };

      const result = await runShadowHarness(s, 'text', [], { logger });

      // Legacy still returned — shadow failure never breaks production.
      expect(result).toEqual({ legacy: true });

      // warn row emitted.
      const warnCall = logger.warn.mock.calls.find((c) => c[0] === 'stage6_shadow_error');
      expect(warnCall).toBeDefined();
      expect(warnCall[1]).toEqual(
        expect.objectContaining({
          sessionId: 'sess-1',
          phase: 2,
          error: 'anthropic network blew up',
        }),
      );

      // No divergence log (comparator never ran).
      expect(logger.info).not.toHaveBeenCalledWith('stage6_divergence', expect.anything());
    });

    test('shadow tool loop does NOT mutate live session.stateSnapshot (Codex BLOCK #1)', async () => {
      // Phase-2 Codex review BLOCK #1: if shadow handed the live session to
      // createWriteDispatcher, legacy + shadow would both write to
      // stateSnapshot — next-turn state reflects 2x writes. The fix clones
      // stateSnapshot + extractedObservations into a shadow wrapper before
      // passing to the dispatcher. This test locks the invariant: after a
      // successful shadow tool call, the live session's snapshot and
      // observations array are byte-identical to their pre-shadow state.
      const logger = makeLogger();
      const s = makeSession('shadow', { extracted_readings: [], observations: [], questions: [] });
      // Seed the live session with a known circuit so record_reading can
      // target it without tripping the dispatcher's existence validator.
      s.stateSnapshot.circuits[1] = { circuit_ref: 1, designation: 'Ring 1' };
      const snapshotBefore = JSON.stringify(s.stateSnapshot);
      const observationsBefore = JSON.stringify(s.extractedObservations);

      // Tool-use stream: Sonnet calls record_reading(field=measured_zs_ohm,
      // circuit=1, value=0.32) then end_turns on the next round.
      const toolUseEvents = [
        { type: 'message_start', message: { id: 'msg_tool', role: 'assistant', content: [] } },
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'tu_1', name: 'record_reading', input: {} },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: {
            type: 'input_json_delta',
            partial_json: '{"field":"measured_zs_ohm","circuit":1,"value":0.32}',
          },
        },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
        { type: 'message_stop' },
      ];
      s.client = mockClient([toolUseEvents, endTurnStreamEvents('done')]);

      await runShadowHarness(s, 'Ze on circuit one is 0.32', [], { logger });

      // Live session untouched: snapshot and observations bit-identical.
      expect(JSON.stringify(s.stateSnapshot)).toBe(snapshotBefore);
      expect(JSON.stringify(s.extractedObservations)).toBe(observationsBefore);
    });

    test('logger.info failure during divergence emit does not break extraction', async () => {
      const logger = makeLogger();
      logger.info.mockImplementation((name) => {
        if (name === 'stage6_divergence') throw new Error('log broken');
      });
      const s = makeSession('shadow', { extracted_readings: [], observations: [], questions: [] });
      const result = await runShadowHarness(s, 'text', [], { logger });
      expect(result).toEqual({ extracted_readings: [], observations: [], questions: [] });
    });
  });

  describe("mode='live'", () => {
    test('throws with explicit phase-7 message; legacy NOT called', async () => {
      const logger = makeLogger();
      const s = makeSession('live');
      await expect(runShadowHarness(s, 'text', [], { logger })).rejects.toThrow(
        /not implemented until Phase 7/,
      );
      expect(s.extractFromUtterance).not.toHaveBeenCalled();
      expect(s.client._callCount).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// Group r5-1 — Plan 04-11 r5-#1: harness uses session.buildSystemBlocks().
//
// Codex r5 MAJOR #1: runShadowHarness was hand-rolling a single-block
// system array (`[{type:'text', text: session.systemPrompt, ...}]`)
// instead of calling `session.buildSystemBlocks()`. In non-off modes the
// real session's buildSystemBlocks() returns a TWO-block array (base
// prompt + cached snapshot) per STQ-03 / Plan 04-02. The harness was
// dropping the snapshot, so Phase 7's STR-03 divergence gate would
// measure "shadow-without-snapshot vs live-with-snapshot" — contaminated
// baseline.
//
// Fix: delegate to `session.buildSystemBlocks()`. Shadow now mirrors
// whatever the session would ship on the real path.
//
// These tests capture the Anthropic request via mockClient._calls and
// assert:
//   r5-1a: system IS what buildSystemBlocks returns (one block when
//          stub has no snapshot; two blocks when stub has a snapshot).
//   r5-1b: system[1] carries the stub's snapshot text — pre-fix this
//          block is absent because the harness hard-coded a single block.
//   r5-1c: system[0].text is the stub's base prompt on every call —
//          locks that the base prompt is still block 0 after the refactor.
// ---------------------------------------------------------------------------

describe('Group r5-1 — Plan 04-11 r5-#1: harness uses session.buildSystemBlocks()', () => {
  test('r5-1a — shadow request system length matches buildSystemBlocks() output', async () => {
    const logger = makeLogger();

    // Variant 1: no snapshot → buildSystemBlocks returns 1 block.
    const s1 = makeSession('shadow', {
      extracted_readings: [],
      observations: [],
      questions: [],
    });
    // _snapshot null by default → buildSystemBlocks returns 1 block.
    await runShadowHarness(s1, 'text', [], { logger });
    const req1 = s1.client._calls[0];
    expect(Array.isArray(req1.system)).toBe(true);
    expect(req1.system).toHaveLength(1);

    // Variant 2: snapshot present → buildSystemBlocks returns 2 blocks.
    const s2 = makeSession('shadow', {
      extracted_readings: [],
      observations: [],
      questions: [],
    });
    s2._snapshot = 'CIRCUITS\n- 1 Ring 32A\n';
    await runShadowHarness(s2, 'text', [], { logger });
    const req2 = s2.client._calls[0];
    expect(Array.isArray(req2.system)).toBe(true);
    // Pre-fix: this is 1 (harness hard-codes single block).
    // Post-fix: this is 2 because buildSystemBlocks() returns prompt +
    // snapshot when the stub's _snapshot is non-empty.
    expect(req2.system).toHaveLength(2);
  });

  test('r5-1b — when snapshot is present, system[1] carries snapshot text', async () => {
    const logger = makeLogger();
    const s = makeSession('shadow', {
      extracted_readings: [],
      observations: [],
      questions: [],
    });
    const snapshotText = 'TEST-SNAPSHOT-MARKER-r5-1b\nCIRCUITS\n- 1 Ring 32A\n';
    s._snapshot = snapshotText;

    await runShadowHarness(s, 'text', [], { logger });

    const req = s.client._calls[0];
    // Pre-fix: system[1] is undefined (harness single-block).
    // Post-fix: system[1] is the snapshot block with text + cache_control.
    expect(req.system[1]).toBeDefined();
    expect(req.system[1]).toMatchObject({
      type: 'text',
      cache_control: { type: 'ephemeral', ttl: '5m' },
    });
    expect(req.system[1].text).toBe(snapshotText);
  });

  test('r5-1c — system[0] is the session base prompt with ephemeral cache_control', async () => {
    const logger = makeLogger();
    const s = makeSession('shadow', {
      extracted_readings: [],
      observations: [],
      questions: [],
    });
    s._snapshot = 'some snapshot content';
    s.systemPrompt = 'BASE-PROMPT-MARKER-r5-1c';

    await runShadowHarness(s, 'text', [], { logger });

    const req = s.client._calls[0];
    expect(req.system[0]).toMatchObject({
      type: 'text',
      text: 'BASE-PROMPT-MARKER-r5-1c',
      cache_control: { type: 'ephemeral', ttl: '5m' },
    });
  });
});
