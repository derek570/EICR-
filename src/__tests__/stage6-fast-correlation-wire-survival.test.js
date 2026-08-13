/**
 * Plan B (feedback ids 118/119) — Codex diff-review cycle 2 (C4, 2026-08-13).
 *
 * Every other test covering `fast_correlation_id` stops at the harness's
 * in-memory `result.confirmations` array — it never proves the field
 * actually crosses the REAL wire-frame construction path
 * (`projectExtractionResultForWire` / `buildResultFrameLedger` in
 * sonnet-stream.js), which is the ONE place a field can be silently
 * stripped before it reaches iOS/web (a destructure-and-drop, an allowlist
 * projection, etc.). This file drives the REAL production functions on
 * BOTH sides of that seam:
 *   - `resolveZeroToolCallDuplicateOutcome` (stage6-shadow-harness.js) to
 *     build a REAL confirmation object carrying `fast_correlation_id`,
 *     exactly as production does at the B3 fallback seam.
 *   - `_test_buildResultFrameLedger` / `projectExtractionResultForWire`
 *     (sonnet-stream.js) — the SAME real frame builder every production
 *     WS send site routes through (see stage6-a2-replaces-cleared.test.js's
 *     "DRIFT LOCK" test) — to serialise that confirmation to the actual
 *     JSON string a `ws.send()` call would carry, then parse it back the
 *     way a client decoder does.
 *
 * `sonnet-stream.js` pulls `../storage.js`, whose module-level
 * `path.resolve(import.meta.dirname, …)` is `undefined` under Jest's ESM
 * VM — same reason stage6-a2-replaces-cleared.test.js mocks it and
 * dynamically imports sonnet-stream.js afterward.
 */

import { jest } from '@jest/globals';

jest.unstable_mockModule('../storage.js', () => ({
  getJobPrefix: jest.fn(() => ''),
  uploadFile: jest.fn(async () => {}),
  uploadBytes: jest.fn(async () => {}),
  uploadText: jest.fn(async () => {}),
  uploadJson: jest.fn(async () => {}),
  downloadFile: jest.fn(async () => {}),
  downloadBytes: jest.fn(async () => null),
  downloadText: jest.fn(async () => null),
  downloadJson: jest.fn(async () => null),
  fileExists: jest.fn(async () => false),
  deleteFile: jest.fn(async () => {}),
  copyObject: jest.fn(async () => {}),
  deletePrefix: jest.fn(async () => {}),
  listFiles: jest.fn(async () => []),
  listDirectories: jest.fn(async () => []),
  listJobFolders: jest.fn(async () => []),
  getFileUrl: jest.fn(async () => ''),
  getJobFiles: jest.fn(async () => []),
  uploadJobFile: jest.fn(async () => {}),
  downloadJobFile: jest.fn(async () => null),
  isUsingS3: jest.fn(() => false),
  getBucketName: jest.fn(() => 'test-bucket'),
}));

const { resolveZeroToolCallDuplicateOutcome } =
  await import('../extraction/stage6-shadow-harness.js');
const fastIdentity = await import('../extraction/fast-path-accepted-identity.js');
const { projectExtractionResultForWire, _test_buildResultFrameLedger } =
  await import('../extraction/sonnet-stream.js');

const SESSION_ID = 'sess-wire-survival';

function makeSession(circuits = {}) {
  return {
    sessionId: SESSION_ID,
    stateSnapshot: { circuits, pending_readings: [], observations: [], validation_alerts: [] },
  };
}

beforeEach(() => {
  fastIdentity._resetForTests();
});
afterEach(() => {
  fastIdentity._resetForTests();
});

describe('Codex diff-review C4 — fast_correlation_id survives the REAL result-frame construction path', () => {
  test('a B3 pending fallback confirmation carrying fast_correlation_id round-trips through projectExtractionResultForWire unchanged', () => {
    fastIdentity.markFastAttemptPending('cid-wire', {
      sessionId: SESSION_ID,
      turnId: 'T1',
      field: 'measured_zs_ohm',
      circuit: 4,
      boardId: null,
      rawValue: '0.62',
    });
    fastIdentity.commitAcceptedIdentity('cid-wire', {
      sessionId: SESSION_ID,
      turnId: 'T1',
      field: 'measured_zs_ohm',
      circuit: 4,
      boardId: null,
      canonicalValue: '0.62',
      comparisonText: 'Circuit 4, Zs 0.62',
    });

    const session = makeSession({});
    const outcome = resolveZeroToolCallDuplicateOutcome({
      session,
      turnId: 'T1',
      correlationIds: new Set(['cid-wire']),
      exactDuplicateTuple: null,
    });
    expect(outcome.confirmations).toHaveLength(1);
    expect(outcome.confirmations[0].fast_correlation_id).toBe('cid-wire');

    // Build a minimal but realistic extraction result envelope, exactly
    // the shape stage6-shadow-harness.js hands to the bundler/wire layer.
    const result = {
      extracted_readings: [],
      confirmations: outcome.confirmations,
      questions_for_user: [],
    };

    // Leg 1: the pure wire-projection function every production egress
    // site routes through (sonnet-stream.js's DRIFT LOCK test pins this).
    const projected = projectExtractionResultForWire(result);
    expect(projected.confirmations[0].fast_correlation_id).toBe('cid-wire');

    // Leg 2: the REAL frame ledger builder — the actual function that
    // constructs the JSON string a `ws.send()` call carries. Parsing the
    // JSON (not just reading the in-memory object) is exactly what an iOS/
    // web client decoder does, and it drops anything that fails
    // JSON.stringify (undefined values, non-enumerable Symbols) — the
    // class of bug a purely in-memory assertion cannot catch.
    const frames = _test_buildResultFrameLedger(session.stateSnapshot, result, session);
    const extractionFrames = frames.filter((f) => f.kind === 'extraction');
    expect(extractionFrames).toHaveLength(1);
    const wireResult = JSON.parse(extractionFrames[0].json);
    expect(wireResult.result.confirmations[0].fast_correlation_id).toBe('cid-wire');
    expect(wireResult.result.confirmations[0].dedupe_token).toBe('duplicate_T1_cid-wire');
    expect(wireResult.result.confirmations[0].text).toBe('Already got that — Circuit 4, Zs 0.62');
  });

  test('a confirmation with NO fast_correlation_id (ordinary exact-duplicate re-speak) never gains one on the wire', () => {
    // B3.2's unstamped path — the negative case, so the positive
    // assertion above isn't just "any key happens to survive".
    const session = makeSession({ 2: { rcd_time_ms: '24' } });
    const outcome = resolveZeroToolCallDuplicateOutcome({
      session,
      turnId: 'T2',
      correlationIds: null,
      exactDuplicateTuple: { field: 'rcd_time_ms', circuit: 2, value: '24', boardId: 'main' },
    });
    expect(outcome.confirmations).toHaveLength(1);
    expect(outcome.confirmations[0].fast_correlation_id).toBeUndefined();

    const result = {
      extracted_readings: [],
      confirmations: outcome.confirmations,
      questions_for_user: [],
    };
    const frames = _test_buildResultFrameLedger(session.stateSnapshot, result, session);
    const wireResult = JSON.parse(frames.find((f) => f.kind === 'extraction').json);
    expect(wireResult.result.confirmations[0]).not.toHaveProperty('fast_correlation_id');
  });
});
