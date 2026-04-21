/**
 * Regression test pinning Plan 02-01 Task 4 refactor in place.
 *
 * updateStateSnapshot was refactored to call the shared atoms
 * applyReadingToSnapshot and clearReadingInSnapshot from
 * stage6-snapshot-mutators.js. This test exercises the result-shape legacy
 * envelope end-to-end and asserts post-call snapshot state — if a future
 * edit inlines the mutations back into updateStateSnapshot (breaking the
 * single-source-of-truth invariant) the test still passes by contract, but
 * paired with the grep in the plan-verification block it ensures the
 * refactor stays wired.
 */

import { jest } from '@jest/globals';
import { EICRExtractionSession } from '../extraction/eicr-extraction-session.js';

describe('eicr-extraction-session.updateStateSnapshot — Plan 02-01 Task 4 refactor', () => {
  test('extracted_readings + field_clears round-trip through shared mutator atoms', () => {
    // Construct a session WITHOUT triggering network / API paths — the
    // constructor accepts an options object; we stay fully synchronous by
    // only calling updateStateSnapshot directly.
    // Constructor: (apiKey, sessionId, certType, options). We never trigger
    // a network call — updateStateSnapshot is a pure method on this class.
    const session = new EICRExtractionSession('test-key-unused', 'test-session-01');

    // Sanity: snapshot starts empty.
    expect(session.stateSnapshot.circuits).toEqual({});

    // Apply a reading — should create the bucket via applyReadingToSnapshot.
    session.updateStateSnapshot({
      extracted_readings: [
        { circuit: 3, field: 'Ze_ohms', value: '0.35' },
      ],
    });
    expect(session.stateSnapshot.circuits[3]).toEqual({ Ze_ohms: '0.35' });

    // Clear the same reading — clearReadingInSnapshot should remove the key.
    session.updateStateSnapshot({
      field_clears: [{ circuit: 3, field: 'Ze_ohms' }],
    });
    expect(session.stateSnapshot.circuits[3]).toEqual({});
  });

  test('null result is a noop (legacy guard preserved)', () => {
    const session = new EICRExtractionSession('test-key-unused', 'test-session-02');
    session.updateStateSnapshot(null);
    expect(session.stateSnapshot).toEqual({
      circuits: {},
      pending_readings: [],
      observations: [],
      validation_alerts: [],
    });
  });
});
