/**
 * stage6-spare-policy-resolution.test.js
 *
 * PLAN-F item 1 (2026-08-12, feedback id 115) — the orthogonal `spare_policy`
 * filter on `set_field_for_all_circuits`, and its resolution against `scope`.
 * Covers the full truth table from the plan:
 *
 *   | Field family      | Scope input           | Modifier          | Result  |
 *   |--------------------|------------------------|-------------------|---------|
 *   | device-attribute  | omitted                | (none→automatic)  | include |
 *   | reading           | omitted                | (none→automatic)  | exclude |
 *   | any               | EXPLICIT 'all'         | (none)            | include |
 *   | any               | explicit 'non_spare'   | (none)            | exclude |
 *   | reading           | 'rcd_protected_only'   | (none→automatic)  | exclude|
 *   | any               | any                    | "including spares"| include |
 *   | any               | any                    | "excluding spares"| exclude |
 *
 * Also covers the omitted/explicit × BOTH field families (device-attribute
 * AND reading) and rcd_protected_only × automatic/include/exclude, per the
 * plan's test list, and the explicit-override-wins-over-legacy-scope case.
 */

import { jest } from '@jest/globals';
import { createWriteDispatcher } from '../extraction/stage6-dispatchers.js';
import { createPerTurnWrites } from '../extraction/stage6-per-turn-writes.js';

function mockLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

function toolCallRows(logger) {
  return logger.info.mock.calls.filter((c) => c[0] === 'stage6_tool_call').map((c) => c[1]);
}

// 6 circuits: 1-4 real, 5 explicitly "Spare", 6 blank designation (spare by
// convention). Circuits 1-2 have RCD attributes populated; 3-4 do not.
function buildSession() {
  const circuits = {
    0: {},
    1: { circuit_designation: 'Cooker', rcd_bs_en: 'BS EN 61009', rcd_type: 'AC' },
    2: { circuit_designation: 'Sockets', rcd_bs_en: 'BS EN 61009', rcd_type: 'AC' },
    3: { circuit_designation: 'Lights' },
    4: { circuit_designation: 'Immersion' },
    5: { circuit_designation: 'Spare' },
    6: { circuit_designation: '' },
  };
  return { sessionId: 's-spare-policy', stateSnapshot: { circuits }, extractedObservations: [] };
}

function dispatch(session, logger, input) {
  const writes = createPerTurnWrites();
  const d = createWriteDispatcher(session, logger, 'turn-1', writes);
  return d({ tool_call_id: 'tu_bulk', name: 'set_field_for_all_circuits', input }, {}).then(
    (result) => ({ result, writes })
  );
}

const deviceAttributeInput = (overrides = {}) => ({
  field: 'rcd_type',
  value: 'AC',
  confidence: 0.95,
  source_turn_id: 't1',
  ...overrides,
});

const readingInput = (overrides = {}) => ({
  field: 'rcd_time_ms',
  value: '25',
  confidence: 0.95,
  source_turn_id: 't1',
  ...overrides,
});

describe('spare_policy resolution — device-attribute family', () => {
  test('omitted scope + omitted spare_policy → automatic → include (spares written)', async () => {
    const { result } = await dispatch(buildSession(), mockLogger(), deviceAttributeInput());
    const body = JSON.parse(result.content);
    expect(body.applied.map((a) => a.circuit).sort()).toEqual([1, 2, 3, 4, 5, 6]);
    expect(body.skipped).toEqual([]);
  });

  test('explicit spare_policy:"include" → include, regardless of scope', async () => {
    const { result } = await dispatch(
      buildSession(),
      mockLogger(),
      deviceAttributeInput({ spare_policy: 'include' })
    );
    const body = JSON.parse(result.content);
    expect(body.applied.map((a) => a.circuit).sort()).toEqual([1, 2, 3, 4, 5, 6]);
  });

  test('explicit spare_policy:"exclude" → exclude, even on a device-attribute field', async () => {
    const { result } = await dispatch(
      buildSession(),
      mockLogger(),
      deviceAttributeInput({ spare_policy: 'exclude' })
    );
    const body = JSON.parse(result.content);
    expect(body.applied.map((a) => a.circuit).sort()).toEqual([1, 2, 3, 4]);
    expect(body.skipped).toEqual(
      expect.arrayContaining([
        { circuit_ref: 5, reason: 'spare_circuit' },
        { circuit_ref: 6, reason: 'spare_circuit' },
      ])
    );
  });
});

describe('spare_policy resolution — reading family', () => {
  test('omitted scope + omitted spare_policy → automatic → exclude (spares skipped, unchanged legacy behaviour)', async () => {
    const { result } = await dispatch(buildSession(), mockLogger(), readingInput());
    const body = JSON.parse(result.content);
    expect(body.applied.map((a) => a.circuit).sort()).toEqual([1, 2, 3, 4]);
    expect(body.skipped).toEqual(
      expect.arrayContaining([
        { circuit_ref: 5, reason: 'spare_circuit' },
        { circuit_ref: 6, reason: 'spare_circuit' },
      ])
    );
  });

  test('explicit spare_policy:"include" on a reading field → spares get the (readingless) write too', async () => {
    const { result } = await dispatch(
      buildSession(),
      mockLogger(),
      readingInput({ spare_policy: 'include' })
    );
    const body = JSON.parse(result.content);
    expect(body.applied.map((a) => a.circuit).sort()).toEqual([1, 2, 3, 4, 5, 6]);
  });
});

describe('spare_policy resolution — explicit scope:"all" passthrough (documented, tested, must survive)', () => {
  test('explicit scope:"all" + omitted spare_policy → include, even for a reading field (existing contract preserved)', async () => {
    const { result } = await dispatch(buildSession(), mockLogger(), readingInput({ scope: 'all' }));
    const body = JSON.parse(result.content);
    expect(body.applied.map((a) => a.circuit).sort()).toEqual([1, 2, 3, 4, 5, 6]);
    expect(body.skipped).toEqual([]);
  });

  test('explicit scope:"all" + explicit spare_policy:"exclude" → the explicit filter still overrides', async () => {
    const { result } = await dispatch(
      buildSession(),
      mockLogger(),
      readingInput({ scope: 'all', spare_policy: 'exclude' })
    );
    const body = JSON.parse(result.content);
    expect(body.applied.map((a) => a.circuit).sort()).toEqual([1, 2, 3, 4]);
  });
});

describe('spare_policy resolution — legacy scope:"non_spare"', () => {
  test('explicit scope:"non_spare" + omitted spare_policy → exclude, unchanged legacy behaviour', async () => {
    const { result } = await dispatch(
      buildSession(),
      mockLogger(),
      deviceAttributeInput({ scope: 'non_spare' })
    );
    const body = JSON.parse(result.content);
    expect(body.applied.map((a) => a.circuit).sort()).toEqual([1, 2, 3, 4]);
  });
});

describe('spare_policy resolution — rcd_protected_only × automatic/include/exclude', () => {
  test('rcd_protected_only + automatic (reading field) → excludes spares AND closes the fitted-RCD-spare hole', async () => {
    // Circuit 5 is spare but has no RCD fields, so it's already excluded by
    // the selector. Give it RCD fields to prove the SPARE filter (not just
    // the selector) is what excludes it.
    const session = buildSession();
    session.stateSnapshot.circuits[5] = {
      circuit_designation: 'Spare',
      rcd_bs_en: 'BS EN 61009',
      rcd_type: 'AC',
    };
    const { result } = await dispatch(
      session,
      mockLogger(),
      readingInput({ scope: 'rcd_protected_only' })
    );
    const body = JSON.parse(result.content);
    // Only circuits 1-2 have RCD fields AND are non-spare.
    expect(body.applied.map((a) => a.circuit).sort()).toEqual([1, 2]);
    expect(body.skipped).toEqual(
      expect.arrayContaining([{ circuit_ref: 5, reason: 'spare_circuit' }])
    );
  });

  test('rcd_protected_only + spare_policy:"include" (reading field) → the RCD-fitted spare is written', async () => {
    const session = buildSession();
    session.stateSnapshot.circuits[5] = {
      circuit_designation: 'Spare',
      rcd_bs_en: 'BS EN 61009',
      rcd_type: 'AC',
    };
    const { result } = await dispatch(
      session,
      mockLogger(),
      readingInput({ scope: 'rcd_protected_only', spare_policy: 'include' })
    );
    const body = JSON.parse(result.content);
    expect(body.applied.map((a) => a.circuit).sort()).toEqual([1, 2, 5]);
  });

  test('rcd_protected_only + spare_policy:"exclude" (device-attribute field) → spares excluded despite family default', async () => {
    const session = buildSession();
    session.stateSnapshot.circuits[5] = {
      circuit_designation: 'Spare',
      rcd_bs_en: 'BS EN 61009',
      rcd_type: 'AC',
    };
    const { result } = await dispatch(
      session,
      mockLogger(),
      deviceAttributeInput({ scope: 'rcd_protected_only', spare_policy: 'exclude' })
    );
    const body = JSON.parse(result.content);
    expect(body.applied.map((a) => a.circuit).sort()).toEqual([1, 2]);
  });

  test('rcd_protected_only + automatic (device-attribute field) → family default includes the RCD-fitted spare', async () => {
    const session = buildSession();
    session.stateSnapshot.circuits[5] = {
      circuit_designation: 'Spare',
      rcd_bs_en: 'BS EN 61009',
      rcd_type: 'AC',
    };
    const { result } = await dispatch(
      session,
      mockLogger(),
      deviceAttributeInput({ scope: 'rcd_protected_only' })
    );
    const body = JSON.parse(result.content);
    expect(body.applied.map((a) => a.circuit).sort()).toEqual([1, 2, 5]);
  });
});

describe('spare_policy resolution — validation', () => {
  test('unknown spare_policy value is rejected', async () => {
    const { result } = await dispatch(
      buildSession(),
      mockLogger(),
      deviceAttributeInput({ spare_policy: 'sometimes' })
    );
    expect(result.is_error).toBe(true);
    const body = JSON.parse(result.content);
    expect(body.error).toEqual({ code: 'invalid_spare_policy', field: 'spare_policy' });
  });

  test('explicit spare_policy:"automatic" behaves identically to omission', async () => {
    const { result } = await dispatch(
      buildSession(),
      mockLogger(),
      readingInput({ spare_policy: 'automatic' })
    );
    const body = JSON.parse(result.content);
    expect(body.applied.map((a) => a.circuit).sort()).toEqual([1, 2, 3, 4]);
  });
});

describe('spare_policy resolution — telemetry contract', () => {
  test('raw scope + raw spare_policy + resolved_spare_policy are logged as separate fields', async () => {
    const logger = mockLogger();
    await dispatch(buildSession(), logger, deviceAttributeInput({ scope: 'all' }));
    const rows = toolCallRows(logger);
    expect(rows[0].input_summary).toMatchObject({
      scope: 'all',
      spare_policy: null,
      resolved_spare_policy: 'include',
    });
  });
});
