/**
 * #5a apply-complete guard — field report 2026-06-24 #4/#5 (session B0F28CFB).
 *
 * The 2026-06-23 orphan net (#10) orphaned a STRUCTURALLY-COMPLETE RCD reading
 * because the Deepgram garble "RCD tryptoid" (= "trip time") made the live
 * extractor produce 0 readings. The orphaned reading then (a) fell to the iOS
 * local-apply fallback → contentless TTS (#4) and (b) lingered in rolling
 * context → re-emitted next turn → bundled together (#5).
 *
 * The deterministic re-parse recovers a single complete (field, circuit, value)
 * tuple from transcriptText (result is EMPTY when the net fires) and applies it
 * as the Stage 6 canonical field `rcd_time_ms` with a content-bearing read-back
 * — instead of a contentless clarifying prompt. Resolved decision #4.
 */

import {
  reparseSingleCompleteReading,
  applyOrphanRecoveredReading,
} from '../extraction/stage6-shadow-harness.js';
import { ALL_DIALOGUE_SCHEMAS } from '../extraction/dialogue-engine/index.js';

describe('reparseSingleCompleteReading', () => {
  test('recovers the "tryptoid" garble as a single complete RCD tuple', () => {
    const t = reparseSingleCompleteReading(
      'RCD tryptoid of circuit 2 is 28 ms',
      ALL_DIALOGUE_SCHEMAS
    );
    expect(t).toEqual({ slotField: 'rcd_trip_time', circuit: 2, value: '28' });
  });

  test('recovers the clean "trip time" phrasing too', () => {
    const t = reparseSingleCompleteReading(
      'RCD trip time for circuit 5 is 24 ms',
      ALL_DIALOGUE_SCHEMAS
    );
    expect(t).toEqual({ slotField: 'rcd_trip_time', circuit: 5, value: '24' });
  });

  test('no explicit circuit digit → null (no fuzzy designation in the net)', () => {
    expect(reparseSingleCompleteReading('RCD tryptoid is 28 ms', ALL_DIALOGUE_SCHEMAS)).toBeNull();
  });

  test('numeric chitchat with no field anchor → null (orphan prompt still fires)', () => {
    expect(
      reparseSingleCompleteReading('the weather is 28 degrees', ALL_DIALOGUE_SCHEMAS)
    ).toBeNull();
  });

  test('empty / non-string transcript → null', () => {
    expect(reparseSingleCompleteReading('', ALL_DIALOGUE_SCHEMAS)).toBeNull();
    expect(reparseSingleCompleteReading(null, ALL_DIALOGUE_SCHEMAS)).toBeNull();
  });
});

describe('applyOrphanRecoveredReading', () => {
  const makeSession = (circuits = { 2: { circuit_designation: 'Cooker' } }) => ({
    sessionId: 'sess_test',
    stateSnapshot: { circuits },
  });

  test('writes rcd_time_ms to the snapshot, pushes a wire reading + content read-back', () => {
    const session = makeSession();
    const result = {};
    const tuple = { slotField: 'rcd_trip_time', circuit: 2, value: '28' };

    const reading = applyOrphanRecoveredReading({ session, result, tuple, turnId: 'turn-11' });

    // Snapshot persisted under the Stage 6 canonical field name.
    expect(session.stateSnapshot.circuits[2].rcd_time_ms).toBe('28');
    // Wire reading carries the canonical name (validateAndCorrectFields rewrites
    // it to the iOS wire form downstream, exactly as for a Haiku reading).
    expect(reading).toMatchObject({ field: 'rcd_time_ms', circuit: 2, value: '28' });
    expect(result.extracted_readings).toHaveLength(1);
    expect(result.extracted_readings[0].field).toBe('rcd_time_ms');
    // Content-bearing spoken read-back (NOT contentless) — uses the designation.
    expect(result.confirmations).toHaveLength(1);
    expect(result.confirmations[0].text).toBe('Cooker, circuit 2, RCD time 28');
    expect(result.confirmations[0].field).toBe('rcd_time_ms');
    expect(result.confirmations[0].circuit).toBe(2);
    expect(result.confirmations[0].expects_ios_ack).toBe(false);
    expect(typeof result.confirmations[0].expanded_text).toBe('string');
  });

  test('read-back falls back to "Circuit N" when no designation is known', () => {
    const session = makeSession({ 2: {} });
    const result = {};
    applyOrphanRecoveredReading({
      session,
      result,
      tuple: { slotField: 'rcd_trip_time', circuit: 2, value: '28' },
      turnId: 'turn-11',
    });
    expect(result.confirmations[0].text).toBe('Circuit 2, RCD time 28');
  });
});
