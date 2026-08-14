/**
 * P3 (2026-07-23, feedback id 86) — set_field_for_all_circuits LIM policy.
 *
 * The bulk applier previously skipped BOTH coercion and the numeric-range /
 * validate policy: it stored "limitation" verbatim across every circuit,
 * accepted alternate sentinels (n/a / ∞), and accepted out-of-range numerics.
 * Fix 4 coerces the value (four-form LIM → "LIM") then runs the SAME
 * validateNumericReadingValue policy as the direct record_reading path before
 * applying any circuit. This file pins that contract across the ranged fields.
 */

import { jest } from '@jest/globals';
import { dispatchSetFieldForAllCircuits } from '../extraction/stage6-dispatchers-circuit.js';
import { createPerTurnWrites } from '../extraction/stage6-per-turn-writes.js';

function mockLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

function buildSnapshot() {
  return {
    circuits: {
      1: { circuit_designation: 'kitchen sockets' },
      2: { circuit_designation: 'lights' },
      3: { circuit_designation: 'cooker' },
    },
    boards: [{ id: 'main', is_current: true }],
  };
}

function makeCall(input) {
  return { tool_call_id: 'tu_bulk_lim', name: 'set_field_for_all_circuits', input };
}

function parseEnvelope(env) {
  return JSON.parse(env.content);
}

async function runBulk(field, value, { hasLimRangedWriteV1 = true } = {}) {
  // P3 Fix 8 — LIM acceptance is capability-gated; the LIM-policy tests below
  // exercise the coercion/validation path, so they run WITH the capability. The
  // gate itself (deny without it) is covered by its own describe block.
  const session = { sessionId: 's_bulk_lim', stateSnapshot: buildSnapshot() };
  const writes = createPerTurnWrites();
  const env = await dispatchSetFieldForAllCircuits(
    makeCall({ field, value, confidence: 0.95, source_turn_id: 't1' }),
    {
      session,
      logger: mockLogger(),
      turnId: 't1',
      perTurnWrites: writes,
      round: 1,
      hasLimRangedWriteV1,
    }
  );
  return parseEnvelope(env);
}

const RANGED = [
  'measured_zs_ohm',
  'rcd_time_ms',
  'rcd_operating_current_ma',
  'ocpd_rating_a',
  'ocpd_breaking_capacity_ka',
  'ir_test_voltage_v',
];

describe('bulk set_field_for_all_circuits — P3 LIM policy', () => {
  test.each(RANGED)(
    '%s: all four LIM forms accepted and stored as canonical "LIM"',
    async (field) => {
      for (const form of ['LIM', 'lim', 'limb', 'limp', 'limitation']) {
        const body = await runBulk(field, form);
        expect(body.ok).toBe(true);
        expect(body.applied.length).toBe(3);
        for (const a of body.applied) expect(a.value).toBe('LIM');
      }
    }
  );

  test.each(RANGED)('%s: near-matches rejected (never persisted)', async (field) => {
    for (const nm of ['limit', 'limited', 'lynn', 'lym']) {
      const body = await runBulk(field, nm);
      expect(body.ok).toBe(false);
      expect(body.error.field).toBe('value');
    }
  });

  test.each(RANGED)('%s: alternate sentinels rejected', async (field) => {
    for (const s of ['n/a', 'na', '∞', 'inf', 'infinity']) {
      const body = await runBulk(field, s);
      expect(body.ok).toBe(false);
    }
  });

  test('per-field numeric bounds still enforced on the bulk path', async () => {
    expect((await runBulk('measured_zs_ohm', '500')).ok).toBe(false);
    expect((await runBulk('measured_zs_ohm', '50')).ok).toBe(true);
    expect((await runBulk('rcd_time_ms', '500')).ok).toBe(true); // 500 valid here
    expect((await runBulk('rcd_time_ms', '5000')).ok).toBe(false);
    expect((await runBulk('ocpd_rating_a', '631')).ok).toBe(false);
  });

  test('valid numeric bulk write still applies to all circuits', async () => {
    const body = await runBulk('rcd_time_ms', '25');
    expect(body.ok).toBe(true);
    expect(body.applied.length).toBe(3);
    for (const a of body.applied) expect(a.value).toBe('25');
  });

  describe('Fix 8 gate — LIM denied without lim_ranged_write_v1', () => {
    test('LIM on a ranged field is skipped (no apply) without the capability', async () => {
      const body = await runBulk('measured_zs_ohm', 'limitation', { hasLimRangedWriteV1: false });
      expect(body).toMatchObject({
        ok: true,
        skipped: true,
        reason: 'lim_ranged_write_capability_missing',
      });
    });

    test('a numeric bulk write is unaffected by the gate', async () => {
      const body = await runBulk('rcd_time_ms', '25', { hasLimRangedWriteV1: false });
      expect(body.ok).toBe(true);
      expect(body.applied.length).toBe(3);
    });
  });

  describe('PLAN-F2 finding 3 (2026-08-14) — the gate does not fire when the real candidate set is already empty', () => {
    function allSpareSnapshot() {
      return {
        circuits: {
          1: { circuit_designation: 'Spare' },
          2: { circuit_designation: '' },
        },
        boards: [{ id: 'main', is_current: true }],
      };
    }

    async function runBulkOnSnapshot(snapshot, field, value, { hasLimRangedWriteV1 = false } = {}) {
      const session = { sessionId: 's_bulk_lim_allspare', stateSnapshot: snapshot };
      const writes = createPerTurnWrites();
      const env = await dispatchSetFieldForAllCircuits(
        makeCall({ field, value, confidence: 0.95, source_turn_id: 't1' }),
        {
          session,
          logger: mockLogger(),
          turnId: 't1',
          perTurnWrites: writes,
          round: 1,
          hasLimRangedWriteV1,
        }
      );
      return { body: parseEnvelope(env), writes };
    }

    test('an all-spares board with a LIM value and NO capability does NOT refuse with capability_missing — falls through to the normal zero-applied flow', async () => {
      const { body, writes } = await runBulkOnSnapshot(
        allSpareSnapshot(),
        'measured_zs_ohm',
        'limitation',
        { hasLimRangedWriteV1: false }
      );
      // The gate's refusal shape is { ok:true, skipped:true, reason:'lim_ranged_write_capability_missing' }.
      // The normal success shape's `skipped` is an ARRAY — asserting its type
      // (not just truthiness) distinguishes the two shapes unambiguously.
      expect(body.ok).toBe(true);
      expect(Array.isArray(body.skipped)).toBe(true);
      expect(body.reason).toBeUndefined();
      expect(body.applied).toEqual([]);
      // The ledger carries a zero-applied bulk outcome with the spare-skipped
      // refs — the bundler consumes this to speak "No non-spare circuits
      // were updated" (Decision 4), never "capability missing".
      expect(writes.bulkOutcomes).toHaveLength(1);
      expect(writes.bulkOutcomes[0].appliedRefs).toEqual([]);
      expect(writes.bulkOutcomes[0].spareSkippedRefs.length).toBeGreaterThan(0);
    });

    test('a board with at least ONE non-spare circuit still gets refused with capability_missing (regression: the gate still fires when it should)', async () => {
      const mixedSnapshot = {
        circuits: {
          1: { circuit_designation: 'Spare' },
          2: { circuit_designation: 'Cooker' },
        },
        boards: [{ id: 'main', is_current: true }],
      };
      const { body } = await runBulkOnSnapshot(mixedSnapshot, 'measured_zs_ohm', 'limitation', {
        hasLimRangedWriteV1: false,
      });
      expect(body).toMatchObject({
        ok: true,
        skipped: true,
        reason: 'lim_ranged_write_capability_missing',
      });
    });

    test('rcd_protected_only selector with NO RCD-fitted circuits: same "empty candidate set" relief applies', async () => {
      const noRcdSnapshot = {
        circuits: {
          1: { circuit_designation: 'Cooker' },
          2: { circuit_designation: 'Sockets' },
        },
        boards: [{ id: 'main', is_current: true }],
      };
      const session = { sessionId: 's_bulk_lim_norcd', stateSnapshot: noRcdSnapshot };
      const writes = createPerTurnWrites();
      const env = await dispatchSetFieldForAllCircuits(
        makeCall({
          field: 'measured_zs_ohm',
          value: 'limitation',
          confidence: 0.95,
          source_turn_id: 't1',
          scope: 'rcd_protected_only',
        }),
        {
          session,
          logger: mockLogger(),
          turnId: 't1',
          perTurnWrites: writes,
          round: 1,
          hasLimRangedWriteV1: false,
        }
      );
      const body = parseEnvelope(env);
      expect(body.ok).toBe(true);
      expect(Array.isArray(body.skipped)).toBe(true);
      expect(body.applied).toEqual([]);
    });

    test('an all-spares board WITH the capability still writes nothing — unaffected by finding 3 (spares are still spares)', async () => {
      const { body } = await runBulkOnSnapshot(
        allSpareSnapshot(),
        'measured_zs_ohm',
        'limitation',
        {
          hasLimRangedWriteV1: true,
        }
      );
      expect(body.ok).toBe(true);
      expect(body.applied).toEqual([]);
    });
  });
});
