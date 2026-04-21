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
