/**
 * Stage 6 Phase 2 Plan 02-06 Task 2 — Shadow slot comparator tests.
 *
 * Covers stage6-slot-comparator.js: projectSlots + compareSlots pure functions.
 *
 * Test groups:
 *   1. projectSlots — 3 tests covering legacy shape, bundler shape, observation
 *      UUID normalisation.
 *   2. compareSlots reason priority — 5 tests covering identical, value_mismatch,
 *      dispatcher_strict_mode, extra_in_tool, and a same-reading-in-both sanity.
 *
 * All tests are pure input/output assertions — no mocks, no timers.
 */

import { projectSlots, compareSlots } from '../extraction/stage6-slot-comparator.js';

describe('projectSlots', () => {
  test('legacy shape with 2 readings + 1 observation projects cleanly', () => {
    const legacy = {
      extracted_readings: [
        { field: 'volts', circuit: 'C1', value: 230 },
        { field: 'zs', circuit: 'C2', value: 0.42 },
      ],
      observations: [{ id: 'id-a', code: 'C2', text: 'RCD type AC' }],
      questions: [],
    };

    const p = projectSlots(legacy);

    expect(p.readings.size).toBe(2);
    expect(p.readings.get('volts::C1')).toBe(230);
    expect(p.readings.get('zs::C2')).toBe(0.42);
    expect(p.observations.size).toBe(1);
    expect(p.observations.has('C2::RCD type AC')).toBe(true);
    expect(p.cleared.size).toBe(0);
    expect(p.circuit_ops.size).toBe(0);
    expect(p.observation_deletions.size).toBe(0);
  });

  test('bundler shape with reading + cleared + circuit_op projects all three slots', () => {
    const tool = {
      extracted_readings: [
        { field: 'volts', circuit: 'C1', value: 240, confidence: 1.0, source: 'tool_call' },
      ],
      cleared_readings: [{ field: 'volts', circuit: 'C2', reason: 'user_correction' }],
      circuit_updates: [{ op: 'create', circuit_ref: 'C3', meta: { designation: 'Sockets' } }],
      observations: [],
      questions: [],
    };

    const p = projectSlots(tool);

    expect(p.readings.size).toBe(1);
    expect(p.readings.get('volts::C1')).toBe(240);
    expect(p.cleared.size).toBe(1);
    expect(p.cleared.has('volts::C2')).toBe(true);
    expect(p.circuit_ops.size).toBe(1);
    expect(p.circuit_ops.has('create::C3')).toBe(true);
  });

  test('observation id normalisation: two entries with same (code, text) different ids collapse to size 1', () => {
    const result = {
      extracted_readings: [],
      observations: [
        { id: 'uuid-legacy-abc', code: 'C2', text: 'RCD type AC' },
        { id: 'uuid-tool-def', code: 'C2', text: 'RCD type AC' },
      ],
      questions: [],
    };

    const p = projectSlots(result);
    expect(p.observations.size).toBe(1);
    expect(p.observations.has('C2::RCD type AC')).toBe(true);
  });

  test('missing / null / undefined inputs produce empty containers (never throws)', () => {
    expect(projectSlots(null).readings.size).toBe(0);
    expect(projectSlots(undefined).observations.size).toBe(0);
    expect(projectSlots({}).circuit_ops.size).toBe(0);
    expect(projectSlots({ extracted_readings: null }).readings.size).toBe(0);
  });
});

describe('compareSlots reason priority', () => {
  const empty = { extracted_readings: [], observations: [], questions: [] };

  test('both empty results → any:false, reason:identical', () => {
    const r = compareSlots(empty, empty);
    expect(r.any).toBe(false);
    expect(r.reason).toBe('identical');
  });

  test('identical single reading in both → any:false, reason:identical', () => {
    const legacy = { ...empty, extracted_readings: [{ field: 'v', circuit: 'C1', value: 230 }] };
    const tool = {
      ...empty,
      extracted_readings: [
        { field: 'v', circuit: 'C1', value: 230, confidence: 1.0, source: 'tool_call' },
      ],
    };
    const r = compareSlots(legacy, tool);
    expect(r.any).toBe(false);
    expect(r.reason).toBe('identical');
  });

  test('legacy wrote {v:C1:230}, tool wrote nothing (strict-mode reject) → dispatcher_strict_mode', () => {
    const legacy = { ...empty, extracted_readings: [{ field: 'v', circuit: 'C1', value: 230 }] };
    const tool = { ...empty };
    const r = compareSlots(legacy, tool);
    expect(r.any).toBe(true);
    expect(r.reason).toBe('dispatcher_strict_mode');
    expect(r.details.readings_only_legacy).toContain('v::C1');
  });

  test('same slot key, different values → value_mismatch', () => {
    const legacy = { ...empty, extracted_readings: [{ field: 'v', circuit: 'C1', value: 230 }] };
    const tool = {
      ...empty,
      extracted_readings: [{ field: 'v', circuit: 'C1', value: 240, source: 'tool_call' }],
    };
    const r = compareSlots(legacy, tool);
    expect(r.any).toBe(true);
    expect(r.reason).toBe('value_mismatch');
    expect(r.details.readings_value_mismatch).toHaveLength(1);
    expect(r.details.readings_value_mismatch[0]).toMatchObject({
      key: 'v::C1',
      legacy_value: 230,
      tool_value: 240,
    });
  });

  test('legacy empty, tool populated reading → extra_in_tool', () => {
    const legacy = { ...empty };
    const tool = {
      ...empty,
      extracted_readings: [{ field: 'v', circuit: 'C1', value: 230, source: 'tool_call' }],
    };
    const r = compareSlots(legacy, tool);
    expect(r.any).toBe(true);
    expect(r.reason).toBe('extra_in_tool');
    expect(r.details.readings_only_tool).toContain('v::C1');
  });

  test('tool cleared slot that legacy never emits → extra_in_tool', () => {
    const legacy = { ...empty };
    const tool = {
      ...empty,
      cleared_readings: [{ field: 'v', circuit: 'C1', reason: 'user_correction' }],
    };
    const r = compareSlots(legacy, tool);
    expect(r.any).toBe(true);
    expect(r.reason).toBe('extra_in_tool');
  });

  test('observation set diff (tool added one legacy did not) → observation_set_diff', () => {
    const legacy = { ...empty };
    const tool = {
      ...empty,
      observations: [{ id: 'x', code: 'C2', text: 'RCD type AC' }],
    };
    const r = compareSlots(legacy, tool);
    expect(r.any).toBe(true);
    expect(r.reason).toBe('observation_set_diff');
    expect(r.details.observations_diff.added_in_tool).toContain('C2::RCD type AC');
  });
});
