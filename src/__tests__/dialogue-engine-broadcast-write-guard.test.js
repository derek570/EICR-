/**
 * Multi-circuit broadcast guard for tryEnterScriptFromWrites (2026-06-01).
 *
 * Field repro — session D68ACD24-1D3A-4896-A59B-A9D9A888386E
 * (2026-05-31 23:53 BST): inspector dictated "RCD, trip time for
 * circuits 2, 3, and 4 to 25 ms.". The `processDialogueTurn`
 * pre-filter correctly recognised the broadcast and bailed
 * (`dialogue_broadcast_bypassed_entry` ×3); Sonnet then wrote
 * rcd_time_ms to circuits 2, 3, 4. Pre-fix the post-dispatch
 * `tryEnterScriptFromWrites` hook saw circuit 2's write first,
 * entered the RCD walk-through, and asked "What's the BS number?"
 * milliseconds after the batch utterance — ambushing the inspector
 * mid-batch.
 *
 * Fix: detect when the same field appears across ≥2 distinct
 * circuits in this turn's readings and skip the hook entirely.
 * Multi-field-same-circuit ("trip time 25 ms, type AC for circuit
 * 5") is unaffected — each field appears with one circuit only.
 */

import {
  tryEnterScriptFromWrites,
  rcdSchema,
  ringContinuitySchema,
  ALL_DIALOGUE_SCHEMAS,
} from '../extraction/dialogue-engine/index.js';

const SESSION_ID = 'sess_broadcast_write_guard';

class FakeWS {
  constructor() {
    this.OPEN = 1;
    this.readyState = this.OPEN;
    this.sent = [];
  }
  send(data) {
    this.sent.push(JSON.parse(data));
  }
}

class RecordingLogger {
  constructor() {
    this.events = [];
  }
  info(name, payload) {
    this.events.push({ name, payload });
  }
}

function buildSession(circuits = {}) {
  return {
    sessionId: SESSION_ID,
    stateSnapshot: { circuits: JSON.parse(JSON.stringify(circuits)) },
  };
}

describe('tryEnterScriptFromWrites — multi-circuit broadcast guard', () => {
  test("today's repro — rcd_time_ms × 3 circuits skips entry with broadcast log event", () => {
    const ws = new FakeWS();
    const logger = new RecordingLogger();
    const session = buildSession({ 2: {}, 3: {}, 4: {} });

    const out = tryEnterScriptFromWrites({
      session,
      ws,
      schemas: ALL_DIALOGUE_SCHEMAS,
      readings: [
        { field: 'rcd_time_ms', circuit: 2, value: '25' },
        { field: 'rcd_time_ms', circuit: 3, value: '25' },
        { field: 'rcd_time_ms', circuit: 4, value: '25' },
      ],
      fieldAliases: { rcd_time_ms: 'rcd_trip_time' },
      logger,
      now: 1000,
    });

    expect(out).toEqual({ entered: false, reason: 'multi_circuit_broadcast' });
    expect(session.dialogueScriptState).toBeFalsy();
    expect(ws.sent).toHaveLength(0);

    const skipLog = logger.events.find(
      (e) => e.name === 'dialogue_entry_from_write_skipped_broadcast'
    );
    expect(skipLog).toBeTruthy();
    expect(skipLog.payload).toMatchObject({
      sessionId: SESSION_ID,
      broadcast_field: 'rcd_time_ms',
      circuit_count: 3,
      circuits: [2, 3, 4],
    });
  });

  test('single-circuit single-field write still enters walk-through', () => {
    const ws = new FakeWS();
    const logger = new RecordingLogger();
    const session = buildSession({ 5: {} });

    const out = tryEnterScriptFromWrites({
      session,
      ws,
      schemas: ALL_DIALOGUE_SCHEMAS,
      readings: [{ field: 'rcd_time_ms', circuit: 5, value: '25' }],
      fieldAliases: { rcd_time_ms: 'rcd_trip_time' },
      logger,
      now: 1000,
    });

    expect(out.entered).toBe(true);
    expect(out.schemaName).toBe('rcd');
    expect(out.circuit_ref).toBe(5);
    expect(session.dialogueScriptState).toBeTruthy();
    expect(session.dialogueScriptState.active).toBe(true);
    expect(
      logger.events.find((e) => e.name === 'dialogue_entry_from_write_skipped_broadcast')
    ).toBeUndefined();
  });

  test('multi-field same-circuit writes still enter (not broadcast intent)', () => {
    const ws = new FakeWS();
    const logger = new RecordingLogger();
    const session = buildSession({ 5: {} });

    // Inspector dictated "circuit 5 trip time 25 ms, type AC" — two
    // different fields land on the same circuit. Each field appears
    // for exactly one circuit, so the guard MUST NOT fire.
    const out = tryEnterScriptFromWrites({
      session,
      ws,
      schemas: ALL_DIALOGUE_SCHEMAS,
      readings: [
        { field: 'rcd_time_ms', circuit: 5, value: '25' },
        { field: 'rcd_type', circuit: 5, value: 'AC' },
      ],
      fieldAliases: { rcd_time_ms: 'rcd_trip_time' },
      logger,
      now: 1000,
    });

    expect(out.entered).toBe(true);
    expect(out.schemaName).toBe('rcd');
    expect(out.circuit_ref).toBe(5);
    expect(
      logger.events.find((e) => e.name === 'dialogue_entry_from_write_skipped_broadcast')
    ).toBeUndefined();
  });

  test('one schema-relevant field broadcast across circuits + one unrelated field still skips', () => {
    // Inspector dictated something that wrote rcd_time_ms × 3 AND
    // an unrelated field × 1. The broadcast on rcd_time_ms still
    // signals batch intent; skip the hook for the whole turn.
    const ws = new FakeWS();
    const logger = new RecordingLogger();
    const session = buildSession({ 2: {}, 3: {}, 4: {}, 7: {} });

    const out = tryEnterScriptFromWrites({
      session,
      ws,
      schemas: ALL_DIALOGUE_SCHEMAS,
      readings: [
        { field: 'rcd_time_ms', circuit: 2, value: '25' },
        { field: 'rcd_time_ms', circuit: 3, value: '25' },
        { field: 'rcd_time_ms', circuit: 4, value: '25' },
        { field: 'measured_zs_ohm', circuit: 7, value: '0.45' },
      ],
      fieldAliases: { rcd_time_ms: 'rcd_trip_time' },
      logger,
      now: 1000,
    });

    expect(out).toEqual({ entered: false, reason: 'multi_circuit_broadcast' });
    const skipLog = logger.events.find(
      (e) => e.name === 'dialogue_entry_from_write_skipped_broadcast'
    );
    expect(skipLog).toBeTruthy();
    expect(skipLog.payload.broadcast_field).toBe('rcd_time_ms');
  });

  test('different schema-relevant fields each on a single circuit still enters', () => {
    // rcd_time_ms × circuit 5 + ring_r1_ohm × circuit 7. No field
    // crosses 2 circuits, so the guard does NOT fire. The FIRST
    // matching schema wins per the function's existing semantics
    // (registry order: ring_continuity, insulation_resistance,
    // rcbo, ocpd, rcd).
    const ws = new FakeWS();
    const logger = new RecordingLogger();
    const session = buildSession({ 5: {}, 7: {} });

    const out = tryEnterScriptFromWrites({
      session,
      ws,
      schemas: ALL_DIALOGUE_SCHEMAS,
      readings: [
        { field: 'rcd_time_ms', circuit: 5, value: '25' },
        { field: 'ring_r1_ohm', circuit: 7, value: '0.32' },
      ],
      fieldAliases: { rcd_time_ms: 'rcd_trip_time' },
      logger,
      now: 1000,
    });

    expect(out.entered).toBe(true);
    expect(
      logger.events.find((e) => e.name === 'dialogue_entry_from_write_skipped_broadcast')
    ).toBeUndefined();
  });
});
