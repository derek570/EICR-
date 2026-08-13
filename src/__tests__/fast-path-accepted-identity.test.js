/**
 * Tests for src/extraction/fast-path-accepted-identity.js
 *
 * Plan B (feedback ids 118/119) B1.2 accepted-identity record + B3.1
 * fast-attempt ledger — one combined TTL-scoped module. Pins:
 *   - markFastAttemptPending / commitAcceptedIdentity / markFastAttemptFailed /
 *     markFastAttemptPlaybackStarted state transitions
 *   - resolveAcceptedIdentity only returns a COMMITTED record (never a bare
 *     'pending' mark)
 *   - getFastAttemptState reflects the ledger, including TTL expiry
 *   - resolveFastAttemptSlotIdentities builds the bundler-facing slotKey map
 *   - resolveFastLedgerOutcomeForTurn's precedence: playback_started wins
 *     over pending; failed is skipped; a pending state with NO committed
 *     identity yet (the pre-commit race) yields `pending_uncommitted` with
 *     the raw record — the plan's "pending, not absence" default (Codex
 *     diff-review F2, 2026-08-13) — never null/absent, and never a
 *     fabricated placeholder; a genuinely unattempted correlation id (no
 *     ledger record at all) still yields null
 */

import { jest } from '@jest/globals';

const identity = await import('../extraction/fast-path-accepted-identity.js');

beforeEach(() => {
  identity._resetForTests();
});

const SESS = 'SESS-1';
const TURN = 'T1';
const CID = 'cid-1';

describe('markFastAttemptPending', () => {
  test('creates a pending record with raw candidate fields', () => {
    identity.markFastAttemptPending(CID, {
      sessionId: SESS,
      turnId: TURN,
      field: 'measured_zs_ohm',
      circuit: 4,
      boardId: null,
      rawValue: '0.62',
    });
    expect(identity.getFastAttemptState(CID)).toBe('pending');
    const record = identity.getFastAttemptRecord(CID);
    expect(record).toMatchObject({
      sessionId: SESS,
      turnId: TURN,
      field: 'measured_zs_ohm',
      circuit: 4,
      boardId: null,
      rawValue: '0.62',
      canonicalValue: null,
      comparisonText: null,
      committed: false,
      state: 'pending',
    });
    // Not yet committed — resolveAcceptedIdentity must NOT return it.
    expect(identity.resolveAcceptedIdentity(CID)).toBeNull();
  });

  test('non-string correlationId is a silent no-op', () => {
    identity.markFastAttemptPending(null, { sessionId: SESS, turnId: TURN, field: 'x' });
    expect(identity._peekStateForTests().size).toBe(0);
  });

  // Codex diff-review F5 (2026-08-13) — mirrors markFastAttemptFailed's
  // existing downgrade guard. A stray/duplicate/delayed
  // markFastAttemptPending call for a correlationId that has already
  // progressed must never regress it.
  test('a stray call for a correlationId already at playback_started is a no-op — state stays playback_started', () => {
    identity.markFastAttemptPending(CID, {
      sessionId: SESS,
      turnId: TURN,
      field: 'measured_zs_ohm',
      circuit: 4,
      boardId: null,
      rawValue: '0.62',
    });
    identity.commitAcceptedIdentity(CID, {
      sessionId: SESS,
      turnId: TURN,
      field: 'measured_zs_ohm',
      circuit: 4,
      boardId: null,
      canonicalValue: '0.62',
      comparisonText: 'Circuit 4, Zs 0.62',
    });
    identity.markFastAttemptPlaybackStarted(SESS, CID);
    expect(identity.getFastAttemptState(CID)).toBe('playback_started');

    // A stray re-mark — e.g. a client retry reusing the same correlationId —
    // must not regress the record back to a bare 'pending' state.
    identity.markFastAttemptPending(CID, {
      sessionId: SESS,
      turnId: TURN,
      field: 'measured_zs_ohm',
      circuit: 4,
      boardId: null,
      rawValue: '0.99', // a DIFFERENT raw value — must never overwrite
    });
    expect(identity.getFastAttemptState(CID)).toBe('playback_started');
    // The committed identity survives untouched too.
    expect(identity.resolveAcceptedIdentity(CID)).toMatchObject({
      canonicalValue: '0.62',
      comparisonText: 'Circuit 4, Zs 0.62',
    });
  });

  test('a stray call for an ALREADY-COMMITTED (but not yet playback_started) record is also a no-op', () => {
    identity.markFastAttemptPending(CID, {
      sessionId: SESS,
      turnId: TURN,
      field: 'measured_zs_ohm',
      circuit: 4,
      boardId: null,
      rawValue: '0.62',
    });
    identity.commitAcceptedIdentity(CID, {
      sessionId: SESS,
      turnId: TURN,
      field: 'measured_zs_ohm',
      circuit: 4,
      boardId: null,
      canonicalValue: '0.62',
      comparisonText: 'Circuit 4, Zs 0.62',
    });
    identity.markFastAttemptPending(CID, {
      sessionId: SESS,
      turnId: TURN,
      field: 'measured_zs_ohm',
      circuit: 4,
      boardId: null,
      rawValue: '0.99',
    });
    // Still committed, still the clamped value — never regressed.
    expect(identity.resolveAcceptedIdentity(CID)).toMatchObject({
      canonicalValue: '0.62',
      committed: true,
    });
  });

  test('a fresh pending mark for an EXPIRED committed record is allowed (not a downgrade — it is a stale replay)', () => {
    jest.useFakeTimers();
    try {
      identity.markFastAttemptPending(CID, {
        sessionId: SESS,
        turnId: TURN,
        field: 'x',
        circuit: null,
        boardId: null,
        rawValue: '1',
      });
      identity.commitAcceptedIdentity(CID, {
        sessionId: SESS,
        turnId: TURN,
        field: 'x',
        circuit: null,
        boardId: null,
        canonicalValue: '1',
        comparisonText: 'x 1',
      });
      jest.advanceTimersByTime(301_000); // F9: RECORD_TTL_MS is now 300_000, not 60_000
      identity.markFastAttemptPending(CID, {
        sessionId: SESS,
        turnId: TURN,
        field: 'y',
        circuit: null,
        boardId: null,
        rawValue: '2',
      });
      expect(identity.getFastAttemptState(CID)).toBe('pending');
      expect(identity.getFastAttemptRecord(CID)).toMatchObject({ field: 'y', rawValue: '2' });
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('commitAcceptedIdentity', () => {
  test('upgrades an existing pending record and resolveAcceptedIdentity now returns it', () => {
    identity.markFastAttemptPending(CID, {
      sessionId: SESS,
      turnId: TURN,
      field: 'measured_zs_ohm',
      circuit: 4,
      boardId: null,
      rawValue: '0.62',
    });
    identity.commitAcceptedIdentity(CID, {
      sessionId: SESS,
      turnId: TURN,
      field: 'measured_zs_ohm',
      circuit: 4,
      boardId: null,
      canonicalValue: '0.62',
      comparisonText: 'Circuit 4, Zs 0.62',
    });
    const resolved = identity.resolveAcceptedIdentity(CID);
    expect(resolved).toMatchObject({
      canonicalValue: '0.62',
      comparisonText: 'Circuit 4, Zs 0.62',
      committed: true,
      state: 'pending',
    });
  });

  test('creates a minimal committed record when called without a prior pending mark', () => {
    identity.commitAcceptedIdentity(CID, {
      sessionId: SESS,
      turnId: TURN,
      field: 'r1_r2_ohm',
      circuit: 2,
      boardId: null,
      canonicalValue: '1.6',
      comparisonText: 'Circuit 2, R1 plus R2 1.6',
    });
    expect(identity.resolveAcceptedIdentity(CID)).toMatchObject({
      field: 'r1_r2_ohm',
      canonicalValue: '1.6',
      committed: true,
    });
  });
});

describe('markFastAttemptFailed', () => {
  test('transitions a pending record to failed', () => {
    identity.markFastAttemptPending(CID, { sessionId: SESS, turnId: TURN, field: 'x' });
    identity.markFastAttemptFailed(SESS, CID);
    expect(identity.getFastAttemptState(CID)).toBe('failed');
  });

  test('creates a minimal failed record when no prior pending mark exists (validateBody-failure path)', () => {
    identity.markFastAttemptFailed(SESS, CID);
    expect(identity.getFastAttemptState(CID)).toBe('failed');
  });

  test('never downgrades a playback_started record', () => {
    identity.markFastAttemptPending(CID, { sessionId: SESS, turnId: TURN, field: 'x' });
    identity.markFastAttemptPlaybackStarted(SESS, CID);
    identity.markFastAttemptFailed(SESS, CID);
    expect(identity.getFastAttemptState(CID)).toBe('playback_started');
  });
});

describe('markFastAttemptPlaybackStarted', () => {
  test('transitions a pending record to playback_started', () => {
    identity.markFastAttemptPending(CID, { sessionId: SESS, turnId: TURN, field: 'x' });
    identity.markFastAttemptPlaybackStarted(SESS, CID);
    expect(identity.getFastAttemptState(CID)).toBe('playback_started');
  });

  test('no-op when no record exists (ask-path TTS ack carrying an unrelated correlation_id)', () => {
    identity.markFastAttemptPlaybackStarted(SESS, 'unknown-cid');
    expect(identity.getFastAttemptState('unknown-cid')).toBeNull();
  });

  test('defensive: a cross-session correlation-id collision does not mutate the record', () => {
    identity.markFastAttemptPending(CID, { sessionId: SESS, turnId: TURN, field: 'x' });
    identity.markFastAttemptPlaybackStarted('OTHER-SESSION', CID);
    expect(identity.getFastAttemptState(CID)).toBe('pending');
  });
});

// Codex diff-review M3 (2026-08-13, per-fix mini-review) — F5 session-scoped
// every READER but left every WRITER (other than the pre-existing
// markFastAttemptPlaybackStarted guard) open to a cross-session
// correlationId collision. These pin the symmetric writer-side guard: an
// unexpired record belonging to a DIFFERENT non-null session is never
// mutated by markFastAttemptPending, commitAcceptedIdentity, or
// markFastAttemptFailed.
describe('session-scoped writers (M3)', () => {
  test('markFastAttemptPending: a correlationId whose existing record belongs to a DIFFERENT session is a no-op — the existing record is untouched', () => {
    identity.markFastAttemptPending(CID, {
      sessionId: SESS,
      turnId: TURN,
      field: 'measured_zs_ohm',
      circuit: 4,
      boardId: null,
      rawValue: '0.62',
    });
    identity.markFastAttemptPending(CID, {
      sessionId: 'OTHER-SESSION',
      turnId: 'other-turn',
      field: 'r1_r2_ohm',
      circuit: 9,
      boardId: null,
      rawValue: '99',
    });
    // The original SESS-owned record survives byte-identical — never
    // overwritten by the foreign-session call.
    expect(identity.getFastAttemptRecord(CID, SESS)).toMatchObject({
      sessionId: SESS,
      turnId: TURN,
      field: 'measured_zs_ohm',
      circuit: 4,
      rawValue: '0.62',
    });
  });

  test('commitAcceptedIdentity: a correlationId whose existing pending record belongs to a DIFFERENT session does not adopt/merge — the pending record stays uncommitted and unchanged', () => {
    identity.markFastAttemptPending(CID, {
      sessionId: SESS,
      turnId: TURN,
      field: 'measured_zs_ohm',
      circuit: 4,
      boardId: null,
      rawValue: '0.62',
    });
    identity.commitAcceptedIdentity(CID, {
      sessionId: 'OTHER-SESSION',
      turnId: 'other-turn',
      field: 'measured_zs_ohm',
      circuit: 4,
      boardId: null,
      canonicalValue: '0.62',
      comparisonText: 'Circuit 4, Zs 0.62',
    });
    // Never committed under the foreign session's call — the original
    // session's pending record is untouched, and no hybrid
    // (SESS-sessionId + OTHER-SESSION-committed-data) record was created.
    expect(identity.resolveAcceptedIdentity(CID, SESS)).toBeNull();
    expect(identity.getFastAttemptRecord(CID, SESS)).toMatchObject({
      sessionId: SESS,
      committed: false,
      state: 'pending',
      rawValue: '0.62',
    });
  });

  test('markFastAttemptFailed: a correlationId whose existing record belongs to a DIFFERENT session is a no-op', () => {
    identity.markFastAttemptPending(CID, {
      sessionId: SESS,
      turnId: TURN,
      field: 'measured_zs_ohm',
      circuit: 4,
      boardId: null,
      rawValue: '0.62',
    });
    identity.markFastAttemptFailed('OTHER-SESSION', CID);
    expect(identity.getFastAttemptState(CID, SESS)).toBe('pending');
  });
});

describe('TTL expiry', () => {
  test('getFastAttemptState/resolveAcceptedIdentity return null after the record expires', () => {
    jest.useFakeTimers();
    try {
      identity.markFastAttemptPending(CID, { sessionId: SESS, turnId: TURN, field: 'x' });
      identity.commitAcceptedIdentity(CID, {
        sessionId: SESS,
        turnId: TURN,
        field: 'x',
        circuit: null,
        boardId: null,
        canonicalValue: '1',
        comparisonText: 'x 1',
      });
      expect(identity.getFastAttemptState(CID)).toBe('pending');
      expect(identity.resolveAcceptedIdentity(CID)).not.toBeNull();
      jest.advanceTimersByTime(301_000); // F9: RECORD_TTL_MS is now 300_000, not 60_000
      expect(identity.getFastAttemptState(CID)).toBeNull();
      expect(identity.resolveAcceptedIdentity(CID)).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('resolveFastAttemptSlotIdentities', () => {
  test('builds a slotKey map from committed identities only', () => {
    identity.markFastAttemptPending('cid-a', {
      sessionId: SESS,
      turnId: TURN,
      field: 'measured_zs_ohm',
      circuit: 4,
      boardId: null,
      rawValue: '0.62',
    });
    identity.commitAcceptedIdentity('cid-a', {
      sessionId: SESS,
      turnId: TURN,
      field: 'measured_zs_ohm',
      circuit: 4,
      boardId: null,
      canonicalValue: '0.62',
      comparisonText: 'Circuit 4, Zs 0.62',
    });
    // 'cid-b' is pending but never committed — must not appear in the map.
    identity.markFastAttemptPending('cid-b', {
      sessionId: SESS,
      turnId: TURN,
      field: 'r1_r2_ohm',
      circuit: 5,
      boardId: null,
      rawValue: '0.35',
    });
    const map = identity.resolveFastAttemptSlotIdentities(new Set(['cid-a', 'cid-b']));
    expect(map.size).toBe(1);
    expect(map.get('measured_zs_ohm::4::')).toMatchObject({
      correlationId: 'cid-a',
      canonicalValue: '0.62',
      comparisonText: 'Circuit 4, Zs 0.62',
    });
  });

  test('empty/absent correlationIds yields an empty map', () => {
    expect(identity.resolveFastAttemptSlotIdentities(null).size).toBe(0);
    expect(identity.resolveFastAttemptSlotIdentities(new Set()).size).toBe(0);
  });
});

// [DEVIATION] F8 (Codex diff-review, 2026-08-13, sanctioned) —
// `resolveFastLedgerOutcomeForTurn` now returns an ARRAY of per-correlation
// outcomes instead of collapsing an entire turn's attempted correlations to
// ONE winner. Audio-First invariant #1 ("every dictated reading read back
// EXACTLY once") requires each attempted correlation be accounted for
// independently — a `playback_started` sibling must not silently drop a
// DIFFERENT correlation's pending fallback, and vice versa.
describe('resolveFastLedgerOutcomeForTurn', () => {
  test('null correlationIds → null', () => {
    expect(identity.resolveFastLedgerOutcomeForTurn(null)).toBeNull();
    expect(identity.resolveFastLedgerOutcomeForTurn(new Set())).toBeNull();
  });

  test('playback_started and a pending sibling are BOTH accounted for independently — neither drops the other', () => {
    identity.markFastAttemptPending('cid-a', { sessionId: SESS, turnId: TURN, field: 'x' });
    identity.markFastAttemptPlaybackStarted(SESS, 'cid-a');
    identity.markFastAttemptPending('cid-b', {
      sessionId: SESS,
      turnId: TURN,
      field: 'measured_zs_ohm',
      circuit: 4,
      boardId: null,
      rawValue: '0.62',
    });
    const outcomes = identity.resolveFastLedgerOutcomeForTurn(new Set(['cid-a', 'cid-b']));
    expect(outcomes).toHaveLength(2);
    const a = outcomes.find((o) => o.correlationId === 'cid-a');
    const b = outcomes.find((o) => o.correlationId === 'cid-b');
    expect(a).toEqual({ correlationId: 'cid-a', kind: 'suppress' });
    expect(b.kind).toBe('pending_uncommitted');
  });

  test('failed correlation is skipped (no entry at all); pending WITH a committed identity gets its own entry', () => {
    identity.markFastAttemptFailed(SESS, 'cid-failed');
    identity.markFastAttemptPending('cid-pending', {
      sessionId: SESS,
      turnId: TURN,
      field: 'measured_zs_ohm',
      circuit: 4,
      boardId: null,
      rawValue: '0.62',
    });
    identity.commitAcceptedIdentity('cid-pending', {
      sessionId: SESS,
      turnId: TURN,
      field: 'measured_zs_ohm',
      circuit: 4,
      boardId: null,
      canonicalValue: '0.62',
      comparisonText: 'Circuit 4, Zs 0.62',
    });
    const outcomes = identity.resolveFastLedgerOutcomeForTurn(
      new Set(['cid-failed', 'cid-pending'])
    );
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].kind).toBe('pending');
    expect(outcomes[0].correlationId).toBe('cid-pending');
    expect(outcomes[0].identity.canonicalValue).toBe('0.62');
  });

  test('all failed → null (falls through to existing behaviour)', () => {
    identity.markFastAttemptFailed(SESS, 'cid-a');
    identity.markFastAttemptFailed(SESS, 'cid-b');
    expect(identity.resolveFastLedgerOutcomeForTurn(new Set(['cid-a', 'cid-b']))).toBeNull();
  });

  test('pending with NO committed identity yet (race) → pending_uncommitted with the raw pre-commit record, never null/absent', () => {
    // Codex diff-review F2 (2026-08-13): the plan's explicit "pending, not
    // absence" default means this race must NOT resolve to null — the
    // orphan-net decision fired before commitAcceptedIdentity (the fast
    // route's first onAudio byte), but the ledger still knows a fast
    // attempt is in flight for this field/circuit.
    identity.markFastAttemptPending('cid-a', {
      sessionId: SESS,
      turnId: TURN,
      field: 'measured_zs_ohm',
      circuit: 4,
      boardId: null,
      rawValue: '0.62',
    });
    // Never committed (onAudio hasn't fired yet).
    const outcomes = identity.resolveFastLedgerOutcomeForTurn(new Set(['cid-a']));
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].kind).toBe('pending_uncommitted');
    expect(outcomes[0].correlationId).toBe('cid-a');
    expect(outcomes[0].rawRecord).toMatchObject({
      field: 'measured_zs_ohm',
      circuit: 4,
      boardId: null,
      rawValue: '0.62',
      committed: false,
    });
  });

  test('a committed identity and an uncommitted one in the SAME set both get their own distinct entries', () => {
    identity.markFastAttemptPending('cid-uncommitted', {
      sessionId: SESS,
      turnId: TURN,
      field: 'measured_zs_ohm',
      circuit: 4,
      boardId: null,
      rawValue: '0.62',
    });
    identity.markFastAttemptPending('cid-committed', {
      sessionId: SESS,
      turnId: TURN,
      field: 'r1_r2_ohm',
      circuit: 5,
      boardId: null,
      rawValue: '0.35',
    });
    identity.commitAcceptedIdentity('cid-committed', {
      sessionId: SESS,
      turnId: TURN,
      field: 'r1_r2_ohm',
      circuit: 5,
      boardId: null,
      canonicalValue: '0.35',
      comparisonText: 'Circuit 5, R1 plus R2 0.35',
    });
    const outcomes = identity.resolveFastLedgerOutcomeForTurn(
      new Set(['cid-uncommitted', 'cid-committed'])
    );
    expect(outcomes).toHaveLength(2);
    const uncommitted = outcomes.find((o) => o.correlationId === 'cid-uncommitted');
    const committed = outcomes.find((o) => o.correlationId === 'cid-committed');
    expect(uncommitted.kind).toBe('pending_uncommitted');
    expect(committed.kind).toBe('pending');
    expect(committed.identity.canonicalValue).toBe('0.35');
  });

  test('unresolved race (no ledger entry at all for an attempted correlation id) defaults to pending, not absence', () => {
    // 'cid-ghost' was never marked pending/failed/committed at all — the plan's
    // explicit default is "pending, not absence" whenever a correlation id was
    // attempted (per fastPathCorrelationIdByTurn) but the ledger hasn't heard
    // from it yet. Since we have no identity to attach, the net effect is null
    // (never fabricate a placeholder) — but it must NOT be treated the same as
    // an explicit 'failed' mark in a mixed set (an explicit failure elsewhere
    // must not mask the ghost's "still pending" status if it later resolves).
    expect(identity.getFastAttemptState('cid-ghost')).toBeNull();
    expect(identity.resolveFastLedgerOutcomeForTurn(new Set(['cid-ghost']))).toBeNull();
  });
});

// Codex diff-review F5 (2026-08-13) — every READER must session-scope its
// lookup, not just the two writers (markFastAttemptPlaybackStarted,
// markFastAttemptFailed) that already had the guard. A stale/foreign
// correlationId (client replay, or a UUID collision with a record from a
// DIFFERENT session) must resolve as not-found, never as the other
// session's identity/state.
describe('session-scoped reads (F5)', () => {
  const OTHER_SESS = 'SESS-OTHER';

  function seedCommitted(cid) {
    identity.markFastAttemptPending(cid, {
      sessionId: SESS,
      turnId: TURN,
      field: 'measured_zs_ohm',
      circuit: 4,
      boardId: null,
      rawValue: '0.62',
    });
    identity.commitAcceptedIdentity(cid, {
      sessionId: SESS,
      turnId: TURN,
      field: 'measured_zs_ohm',
      circuit: 4,
      boardId: null,
      canonicalValue: '0.62',
      comparisonText: 'Circuit 4, Zs 0.62',
    });
  }

  test("resolveAcceptedIdentity: a different sessionId sees not-found, not the other session's data", () => {
    seedCommitted(CID);
    expect(identity.resolveAcceptedIdentity(CID, SESS)).not.toBeNull();
    expect(identity.resolveAcceptedIdentity(CID, OTHER_SESS)).toBeNull();
    // No sessionId passed at all remains permissive (unscoped call site).
    expect(identity.resolveAcceptedIdentity(CID)).not.toBeNull();
  });

  test('getFastAttemptState: a different sessionId sees null, not the real state', () => {
    seedCommitted(CID);
    expect(identity.getFastAttemptState(CID, SESS)).toBe('pending');
    expect(identity.getFastAttemptState(CID, OTHER_SESS)).toBeNull();
  });

  test("getFastAttemptRecord: a different sessionId sees null, not the other session's record", () => {
    seedCommitted(CID);
    expect(identity.getFastAttemptRecord(CID, SESS)).not.toBeNull();
    expect(identity.getFastAttemptRecord(CID, OTHER_SESS)).toBeNull();
  });

  test('resolveFastAttemptSlotIdentities: a foreign correlationId contributes NOTHING to the map', () => {
    seedCommitted(CID);
    const own = identity.resolveFastAttemptSlotIdentities(new Set([CID]), SESS);
    expect(own.size).toBe(1);
    const foreign = identity.resolveFastAttemptSlotIdentities(new Set([CID]), OTHER_SESS);
    expect(foreign.size).toBe(0);
  });

  test("resolveFastLedgerOutcomeForTurn: a playback_started record from a DIFFERENT session never suppresses this session's turn", () => {
    identity.markFastAttemptPending(CID, { sessionId: SESS, turnId: TURN, field: 'x' });
    identity.markFastAttemptPlaybackStarted(SESS, CID);
    // Called with the OTHER session's id — the record belongs to SESS, so it
    // must be invisible, not a false 'suppress'.
    expect(identity.resolveFastLedgerOutcomeForTurn(new Set([CID]), OTHER_SESS)).toBeNull();
    // Called with the correct session id still suppresses (F8: array shape).
    expect(identity.resolveFastLedgerOutcomeForTurn(new Set([CID]), SESS)).toEqual([
      { correlationId: CID, kind: 'suppress' },
    ]);
  });

  test("resolveFastLedgerOutcomeForTurn: a foreign pending_uncommitted record never leaks as this session's fallback", () => {
    identity.markFastAttemptPending(CID, {
      sessionId: SESS,
      turnId: TURN,
      field: 'measured_zs_ohm',
      circuit: 4,
      boardId: null,
      rawValue: '0.62',
    });
    // Never committed — stays 'pending'.
    expect(identity.resolveFastLedgerOutcomeForTurn(new Set([CID]), OTHER_SESS)).toBeNull();
    const own = identity.resolveFastLedgerOutcomeForTurn(new Set([CID]), SESS);
    expect(own).toHaveLength(1);
    expect(own[0].kind).toBe('pending_uncommitted');
  });
});

describe('buildFastAttemptSlotKey', () => {
  test("matches the fast route's own buildSlotKey normalisation", () => {
    expect(
      identity.buildFastAttemptSlotKey({ field: 'measured_zs_ohm', circuit: 4, boardId: null })
    ).toBe('measured_zs_ohm::4::');
    expect(
      identity.buildFastAttemptSlotKey({ field: 'measured_zs_ohm', circuit: null, boardId: 'B2' })
    ).toBe('measured_zs_ohm::null::B2');
  });
});
