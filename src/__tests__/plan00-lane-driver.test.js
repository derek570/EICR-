/**
 * Plan 00B-2 C4 — the real-server lane driver + frozen-evidence judge
 * adapter + offline playback-ack route.
 *
 * The headline acceptance is COMMITTED here: all nine vendor-lane fixtures
 * judge PASS end-to-end through the REAL initSonnetStream ingress in mock
 * mode (any INVALID_HOLD is a composition bug to fix, not to waive).
 *
 * The judge-adapter negatives prove each failure class FAILS the sample:
 * missing ask, wrong field/circuit confirmation, missing playback proof,
 * extra audible output, unfinished producer, non-text matcher mismatch —
 * plus the field_cleared narrow rule (real fixture) and the
 * start-latch-cannot-satisfy pin.
 */

import { jest, describe, test, expect } from '@jest/globals';
import path from 'node:path';
import express from 'express';
import request from 'supertest';

const repoRoot = path.resolve(new URL('../..', import.meta.url).pathname);

const { judgeFrozenEvidence, composeCaptureInvalid } =
  await import('../../scripts/model-ab/lib/semantic-judge.mjs');
const { createPlaybackAckRouter } = await import('../routes/voice-latency-playback-ack.js');
const { normaliseEvaluationContext, attachEvaluationContext, EVALUATION_CONTEXT } =
  await import('../extraction/plan00-lifecycle-hooks.js');
const { createDeliveryLedger, operationIdentityKey } =
  await import('../extraction/plan00-audibility-ledgers.js');
const { recordFrameDeliveryEvidence } = await import('../extraction/sonnet-stream.js');

function baseEvidence(overrides = {}) {
  return {
    receipts: [],
    mutation_invalid: null,
    ask_entries: [],
    ask_invalid: null,
    deliveries: [],
    playbacks: [],
    provisionals: [],
    delivery_invalid: null,
    ambiguous_op_keys: [],
    non_mutating_audible: [],
    delivery_prepared_outstanding: 0,
    producer_counts: {},
    producer_invalid: null,
    sub_records: [],
    ...overrides,
  };
}

function frozenWith(evidence, overrides = {}) {
  return {
    latch_key: 'completion',
    eligible: true,
    reason: null,
    boundary: 'session_stopped',
    sessionId: 's',
    counts: {},
    revisions: {},
    candidate: null,
    publishPromise: null,
    evidence,
    ...overrides,
  };
}

function expectationWith(turn) {
  return { schema_version: 1, corpus_id: 'frc_test', turns: [turn] };
}

const OP_KEY = operationIdentityKey({
  extractionTurnId: 't1',
  field: 'measured_zs_ohm',
  circuit: 4,
  boardId: null,
});

function deliveredRow({ text = 'Circuit 4, Zs 0.63', opKey = OP_KEY } = {}) {
  return {
    op_key: opKey,
    op_keys: [opKey],
    kind: 'confirmation',
    transport: 'ws_extraction',
    text,
    at_seq: 1,
  };
}

describe('judge adapter negatives — each class FAILS the sample', () => {
  const readingReceipt = {
    kind: 'reading',
    field: 'measured_zs_ohm',
    circuit: 4,
    board_id: null,
    value: '0.63',
    parent_operation_id: null,
  };
  const readingOp = {
    ordinal: 1,
    kind: 'reading',
    field: 'measured_zs_ohm',
    circuit: 4,
    board_id: null,
    value: '0.63',
    state_transition: null,
    audibility: 'exactly_once',
  };
  const confirmationAudible = {
    kind: 'reading_confirmation',
    count: 1,
    match: { field: 'measured_zs_ohm', circuit: 4 },
  };

  test('fully-satisfied sample PASSES (op + delivery + exactly one playback)', () => {
    const v = judgeFrozenEvidence(
      expectationWith({ operations: [readingOp], audible_outputs: [confirmationAudible] }),
      frozenWith(
        baseEvidence({
          receipts: [readingReceipt],
          deliveries: [deliveredRow()],
          playbacks: [{ op_key: OP_KEY, ack_body_hash: 'h1' }],
        })
      )
    );
    expect(v.verdict).toBe('PASS');
  });

  test('a missing ask FAILS', () => {
    const v = judgeFrozenEvidence(
      expectationWith({
        operations: [],
        audible_outputs: [{ kind: 'ask_user', count: 1, match: null }],
      }),
      frozenWith(baseEvidence())
    );
    expect(v.verdict).toBe('FAIL');
    expect(v.reason).toBe('ask_missing');
  });

  test('a wrong field/circuit confirmation FAILS (non-text matcher mismatch)', () => {
    const wrongKey = operationIdentityKey({
      extractionTurnId: 't1',
      field: 'r1_r2_ohm',
      circuit: 7,
      boardId: null,
    });
    const v = judgeFrozenEvidence(
      expectationWith({ operations: [], audible_outputs: [confirmationAudible] }),
      frozenWith(
        baseEvidence({
          deliveries: [deliveredRow({ opKey: wrongKey })],
          playbacks: [{ op_key: wrongKey, ack_body_hash: 'h1' }],
        })
      )
    );
    expect(v.verdict).toBe('FAIL');
    expect(v.reason).toBe('audibility_count_mismatch');
  });

  test('missing playback proof FAILS the audibility-mandatory expectation', () => {
    const v = judgeFrozenEvidence(
      expectationWith({ operations: [readingOp], audible_outputs: [confirmationAudible] }),
      frozenWith(
        baseEvidence({
          receipts: [readingReceipt],
          deliveries: [deliveredRow()],
          playbacks: [], // delivered but never played
        })
      )
    );
    expect(v.verdict).toBe('FAIL');
    expect(v.mismatches.some((m) => m.class === 'playback_proof_missing')).toBe(true);
  });

  test('an extra audible output (undeclared dispatcher ask) FAILS', () => {
    const v = judgeFrozenEvidence(
      expectationWith({ operations: [], audible_outputs: [] }),
      frozenWith(
        baseEvidence({
          ask_entries: [
            {
              key: '{}',
              state: 'answered',
              runtime_id: 'toolu_x',
              meta: { family: 'dispatcher' },
              // A REAL emitted ask: the judge counts only entries whose
              // history proves emission (produced-only rows never crossed
              // the wire — Codex r2 finding 3).
              history: ['produced', 'emitted', 'answered'],
            },
          ],
        })
      )
    );
    expect(v.verdict).toBe('FAIL');
    expect(v.reason).toBe('undeclared_ask');
  });

  test('a Tier-2 dialogue-script ask never counts against the corpus gate', () => {
    const v = judgeFrozenEvidence(
      expectationWith({ operations: [], audible_outputs: [] }),
      frozenWith(
        baseEvidence({
          ask_entries: [
            {
              key: '{}',
              state: 'emitted',
              runtime_id: 'srv-irs-x',
              meta: { family: 'dialogue_script' },
              history: [],
            },
          ],
        })
      )
    );
    expect(v.verdict).toBe('PASS');
  });

  test('an unfinished producer is INVALID_HOLD, never pass/fail', () => {
    const v = judgeFrozenEvidence(
      expectationWith({ operations: [], audible_outputs: [] }),
      frozenWith(baseEvidence({ producer_counts: { fast_tts: 1 } }))
    );
    expect(v.verdict).toBe('INVALID_HOLD');
    expect(v.reason).toBe('unfinished_producer:fast_tts');
  });

  test('an undeclared extra mutation FAILS', () => {
    const v = judgeFrozenEvidence(
      expectationWith({ operations: [], audible_outputs: [] }),
      frozenWith(baseEvidence({ receipts: [readingReceipt] }))
    );
    expect(v.verdict).toBe('FAIL');
    expect(v.reason).toBe('extra_mutation');
  });

  test('an ineligible freeze is INVALID_HOLD; the START latch can never satisfy the verdict', () => {
    expect(
      judgeFrozenEvidence(expectationWith({ operations: [], audible_outputs: [] }), null).verdict
    ).toBe('INVALID_HOLD');
    const ineligible = frozenWith(baseEvidence(), {
      eligible: false,
      reason: 'non_quiescent_at_stop',
    });
    expect(
      judgeFrozenEvidence(expectationWith({ operations: [], audible_outputs: [] }), ineligible)
        .verdict
    ).toBe('INVALID_HOLD');
    // A start-shaped latch carries NO judged evidence by design.
    const startLatch = frozenWith(null, { latch_key: 'start', evidence: null });
    const v = judgeFrozenEvidence(
      expectationWith({ operations: [], audible_outputs: [] }),
      startLatch
    );
    expect(v.verdict).toBe('INVALID_HOLD');
    expect(v.reason).toBe('no_frozen_evidence');
  });

  test('unconsumed fast-TTS provisionals are INVALID_HOLD', () => {
    expect(
      composeCaptureInvalid(
        frozenWith(
          baseEvidence({ provisionals: [{ correlation_id: 'c1', resolved_op_key: null }] })
        )
      ).reason
    ).toBe('fast_provisional_unconsumed');
  });
});

describe('field_cleared narrow rule (the clear-Ze fixture is judgeable)', () => {
  const clearKey = operationIdentityKey({
    extractionTurnId: 't1',
    field: 'field_cleared',
    circuit: null,
    boardId: null,
  });
  const clearedAudible = {
    kind: 'reading_confirmation',
    count: 1,
    match: { field: 'field_cleared', circuit: null, text_exact: 'Ze cleared' },
  };
  const clearReceipt = {
    kind: 'board_clear',
    field: 'ze',
    circuit: null,
    board_id: null,
    value: null,
    parent_operation_id: null,
  };
  const evidence = (receipts) =>
    baseEvidence({
      receipts,
      deliveries: [deliveredRow({ text: 'Ze cleared', opKey: clearKey })],
      playbacks: [{ op_key: clearKey, ack_body_hash: 'h1' }],
    });

  test('exactly ONE authoritative clear receipt is consumed — PASS', () => {
    const v = judgeFrozenEvidence(
      expectationWith({ operations: [], audible_outputs: [clearedAudible] }),
      frozenWith(evidence([clearReceipt]))
    );
    expect(v.verdict).toBe('PASS');
  });

  test('zero clear receipts FAIL (spoken but not cleared)', () => {
    const v = judgeFrozenEvidence(
      expectationWith({ operations: [], audible_outputs: [clearedAudible] }),
      frozenWith(evidence([]))
    );
    expect(v.verdict).toBe('FAIL');
    expect(v.reason).toBe('field_cleared_receipt_mismatch');
  });

  test('a SECOND hidden clear receipt FAILS (one consumed, one extra)', () => {
    const v = judgeFrozenEvidence(
      expectationWith({ operations: [], audible_outputs: [clearedAudible] }),
      frozenWith(evidence([clearReceipt, { ...clearReceipt, field: 'pfc' }]))
    );
    expect(v.verdict).toBe('FAIL');
    expect(v.reason).toBe('field_cleared_receipt_mismatch');
  });
});

describe('offline playback-ack route (exported factory, zero database)', () => {
  const DRIVER_TOKEN = 'test-offline-token';
  function makeApp({ entry }) {
    const app = express();
    app.use(express.json());
    const recordPlaybackAck = jest.fn();
    const recordOutcome = jest.fn();
    app.use(
      '/api',
      createPlaybackAckRouter({
        requireAuth: (req, res, next) => {
          if (req.headers.authorization !== `Bearer ${DRIVER_TOKEN}`) {
            return res.status(401).json({ error: 'unauthorized' });
          }
          req.user = { id: 'owner-user' };
          return next();
        },
        getActiveSessionEntry: () => entry,
        recordPlaybackAck,
        recordOutcome,
      })
    );
    return { app, recordPlaybackAck };
  }

  function makeEvalEntry() {
    const entry = { userId: 'owner-user', session: {} };
    const ctx = normaliseEvaluationContext(
      { deliveryLedger: createDeliveryLedger() },
      { sessionId: 's-route' }
    );
    attachEvaluationContext(entry, ctx);
    return { entry, ctx };
  }

  const body = (slot) => ({
    sessionId: 's-route',
    turnId: 't-route',
    source: 'bundler',
    at_ms: Date.now(),
    ...(slot ? { slot } : {}),
  });

  test('same-owner success reaches the evaluation delivery ledger with zero DB access', async () => {
    const { entry, ctx } = makeEvalEntry();
    ctx.recordDelivery(
      [{ extractionTurnId: 't1', field: 'measured_zs_ohm', circuit: 4, boardId: null }],
      { producerId: 'result_frame_confirmation', kind: 'confirmation', text: 'Circuit 4, Zs 0.63' }
    );
    const { app } = makeApp({ entry });
    const res = await request(app)
      .post('/api/voice-latency/playback-ack')
      .set('Authorization', `Bearer ${DRIVER_TOKEN}`)
      .send(body({ field: 'measured_zs_ohm', circuit: 4, boardId: null }));
    expect(res.status).toBe(204);
    expect(ctx.deliveryLedger.playbacks).toHaveLength(1);
  });

  test('wrong-owner is the indistinguishable 404; entry-absent keeps telemetry-only 204', async () => {
    const { entry } = makeEvalEntry();
    entry.userId = 'someone-else';
    const { app } = makeApp({ entry });
    const res = await request(app)
      .post('/api/voice-latency/playback-ack')
      .set('Authorization', `Bearer ${DRIVER_TOKEN}`)
      .send(body());
    expect(res.status).toBe(404);
    expect(res.text).toBe('');
    const absent = makeApp({ entry: undefined });
    const res2 = await request(absent.app)
      .post('/api/voice-latency/playback-ack')
      .set('Authorization', `Bearer ${DRIVER_TOKEN}`)
      .send(body());
    expect(res2.status).toBe(204);
    expect(absent.recordPlaybackAck).toHaveBeenCalledTimes(1);
  });

  test('malformed token is 401', async () => {
    const { entry } = makeEvalEntry();
    const { app } = makeApp({ entry });
    const res = await request(app)
      .post('/api/voice-latency/playback-ack')
      .set('Authorization', 'Bearer wrong')
      .send(body());
    expect(res.status).toBe(401);
  });

  test('wrong-slot / duplicate / omitted-slot-ambiguous acks never invent playback rows', async () => {
    const { entry, ctx } = makeEvalEntry();
    ctx.recordDelivery(
      [{ extractionTurnId: 't1', field: 'measured_zs_ohm', circuit: 4, boardId: null }],
      { producerId: 'result_frame_confirmation', kind: 'confirmation', text: 'A' }
    );
    ctx.recordDelivery(
      [{ extractionTurnId: 't1', field: 'r1_r2_ohm', circuit: 7, boardId: null }],
      { producerId: 'result_frame_confirmation', kind: 'confirmation', text: 'B' }
    );
    const { app } = makeApp({ entry });
    const post = (b) =>
      request(app)
        .post('/api/voice-latency/playback-ack')
        .set('Authorization', `Bearer ${DRIVER_TOKEN}`)
        .send(b);
    // Wrong slot: no matching delivery — telemetry only.
    await post(body({ field: 'ze', circuit: 9, boardId: null }));
    expect(ctx.deliveryLedger.playbacks).toHaveLength(0);
    // Omitted slot with TWO delivered units: ambiguous — telemetry only.
    await post(body());
    expect(ctx.deliveryLedger.playbacks).toHaveLength(0);
    // Matching slot: one start; a byte-identical duplicate stays ONE.
    const good = body({ field: 'measured_zs_ohm', circuit: 4, boardId: null });
    await post(good);
    await post(good);
    expect(ctx.deliveryLedger.playbacks).toHaveLength(1);
    // No playback row can arise from a ws.send alone — the ledger gained
    // rows only through the route above.
    expect(ctx.deliveryLedger.playbacks[0].op_key).toContain('measured_zs_ohm');
  });
});

describe('trusted-input coverage — the lane driver cannot silently depend on an untracked input', () => {
  test('every production/capture import of lane-driver.mjs is enumerated in SEMANTIC_ORACLE_INPUTS', async () => {
    const fs = await import('node:fs');
    const { SEMANTIC_ORACLE_INPUTS } =
      await import('../../scripts/model-ab/lib/expectation-projection.mjs');
    const src = fs.readFileSync(
      path.join(repoRoot, 'scripts/model-ab/lib/lane-driver.mjs'),
      'utf8'
    );
    const imported = new Set();
    for (const m of src.matchAll(/srcMod\('([^']+)'\)/g)) imported.add(`src/${m[1]}`);
    for (const m of src.matchAll(/flLib\('([^']+)'\)/g)) {
      imported.add(`scripts/field-replay/lib/${m[1]}`);
    }
    for (const m of src.matchAll(/'scripts\/model-ab\/lib\/([^']+)'/g)) {
      imported.add(`scripts/model-ab/lib/${m[1]}`);
    }
    imported.add('scripts/model-ab/lib/lane-driver.mjs'); // the driver itself
    expect(imported.size).toBeGreaterThanOrEqual(8);
    const tracked = new Set(SEMANTIC_ORACLE_INPUTS);
    const missing = [...imported].filter((p) => !tracked.has(p));
    expect(missing).toEqual([]);
  });
});

describe('mock-mode acceptance — 9/9 through the REAL server', () => {
  test('runVendorLaneMock judges every vendor-lane fixture PASS', async () => {
    const { runVendorLaneMock } = await import('../../scripts/model-ab/lib/lane-driver.mjs');
    const { results, allPass } = await runVendorLaneMock({ repoRoot });
    const summary = results.map((r) => `${r.corpus_id}:${r.verdict}`).join(' ');
    expect(results).toHaveLength(9);
    expect(allPass).toBe(true);
    expect(summary).not.toContain('INVALID_HOLD');
  }, 120000);
});

describe('Codex r2 judge hardening — consumption, sweeps, turn membership', () => {
  const opFor = (turn, field = 'measured_zs_ohm', circuit = 4, ordinal = 1) =>
    operationIdentityKey({ extractionTurnId: turn, field, circuit, boardId: null, ordinal });

  const emittedAskEntry = (id) => ({
    key: '{}',
    state: 'answered',
    runtime_id: id,
    meta: { family: 'dispatcher' },
    history: ['produced', 'emitted', 'answered'],
  });

  test('one emitted ask can NEVER satisfy two ask expectations (consumption)', () => {
    const v = judgeFrozenEvidence(
      {
        schema_version: 1,
        corpus_id: 'frc_test',
        turns: [
          { operations: [], audible_outputs: [{ kind: 'ask_user', count: 1, match: null }] },
          { operations: [], audible_outputs: [{ kind: 'ask_user', count: 1, match: null }] },
        ],
      },
      frozenWith(baseEvidence({ ask_entries: [emittedAskEntry('toolu_1')] }))
    );
    expect(v.verdict).toBe('FAIL');
    expect(v.mismatches.some((m) => m.class === 'ask_missing')).toBe(true);
  });

  test('a produced-only (never-emitted) ask entry is NOT emission evidence', () => {
    const v = judgeFrozenEvidence(
      {
        schema_version: 1,
        corpus_id: 'frc_test',
        turns: [{ operations: [], audible_outputs: [{ kind: 'ask_user', count: 1, match: null }] }],
      },
      frozenWith(
        baseEvidence({
          ask_entries: [
            {
              key: '{}',
              state: 'produced',
              runtime_id: null,
              meta: { family: 'dispatcher' },
              history: ['produced'],
            },
          ],
        })
      )
    );
    expect(v.verdict).toBe('FAIL');
    expect(v.reason).toBe('ask_missing');
  });

  test('an UNDECLARED delivery (no matching expectation, undeclared op) FAILS the sweep', () => {
    const strayKey = opFor('t9', 'r1_r2_ohm', 9);
    const v = judgeFrozenEvidence(
      {
        schema_version: 1,
        corpus_id: 'frc_test',
        turns: [{ operations: [], audible_outputs: [] }],
      },
      frozenWith(
        baseEvidence({
          deliveries: [
            {
              op_key: strayKey,
              op_keys: [strayKey],
              kind: 'confirmation',
              text: 'stray',
              at_seq: 1,
            },
          ],
        })
      )
    );
    expect(v.verdict).toBe('FAIL');
    expect(v.reason).toBe('undeclared_delivery');
  });

  test('a delivery backing a DECLARED consumed operation is implied-declared (Audio-First read-back)', () => {
    const receipt = {
      kind: 'reading',
      field: 'measured_zs_ohm',
      circuit: 4,
      board_id: null,
      value: '0.63',
      extraction_turn_id: 't1',
      turn_ordinal: 1,
      parent_operation_id: null,
    };
    const key = opFor('t1', 'measured_zs_ohm', 4, 1);
    const v = judgeFrozenEvidence(
      {
        schema_version: 1,
        corpus_id: 'frc_test',
        turns: [
          {
            operations: [
              { ordinal: 1, kind: 'reading', field: 'measured_zs_ohm', circuit: 4, value: '0.63' },
            ],
            audible_outputs: [],
          },
        ],
      },
      frozenWith(
        baseEvidence({
          receipts: [receipt],
          deliveries: [
            { op_key: key, op_keys: [key], kind: 'confirmation', text: 'Zs 0.63', at_seq: 1 },
          ],
        })
      )
    );
    expect(v.verdict).toBe('PASS');
  });

  test('an UNDECLARED non-mutating audible row (apology on a silent expectation) FAILS', () => {
    const v = judgeFrozenEvidence(
      {
        schema_version: 1,
        corpus_id: 'frc_test',
        turns: [{ operations: [], audible_outputs: [] }],
      },
      frozenWith(
        baseEvidence({
          non_mutating_audible: [
            {
              channel: 'ws_extraction',
              kind: 'field_null_confirmation',
              text: 'Sorry, say again?',
            },
          ],
        })
      )
    );
    expect(v.verdict).toBe('FAIL');
    expect(v.reason).toBe('undeclared_audible');
  });

  // PLAN-G2 (2026-08-14, Codex diff-review cycle 1) — field_null_fallback's
  // optional match.dedupe_token comparison. Most field_null_fallback targets
  // (marker-①/②/F7 apologies) never declare a token and are unaffected
  // (proven by the undeclared-audible test above using an unrelated shape);
  // these two pin the NEW comparison itself for a fixture that DOES declare
  // one (the two P4 ack families, PLAN-G2).
  test('field_null_fallback with a declared dedupe_token PASSES when the captured row carries the SAME token', () => {
    const v = judgeFrozenEvidence(
      {
        schema_version: 1,
        corpus_id: 'frc_test',
        turns: [
          {
            operations: [],
            audible_outputs: [
              {
                kind: 'field_null_fallback',
                count: 1,
                match: {
                  text_exact: 'No problem, moving on.',
                  dedupe_token: 'p4ack_sess-x-turn-1',
                },
              },
            ],
          },
        ],
      },
      frozenWith(
        baseEvidence({
          non_mutating_audible: [
            {
              channel: 'ws_extraction',
              kind: 'field_null_confirmation',
              text: 'No problem, moving on.',
              dedupe_token: 'p4ack_sess-x-turn-1',
            },
          ],
        })
      )
    );
    expect(v.verdict).toBe('PASS');
  });

  test('RED: field_null_fallback with a declared dedupe_token FAILS when the captured row carries a DIFFERENT token', () => {
    // Proves the comparison is load-bearing, not vacuous — a captured row
    // with the right TEXT but the wrong TOKEN (e.g. a stale/replayed turn's
    // ack landing where a fresh one was expected) must not silently PASS.
    const v = judgeFrozenEvidence(
      {
        schema_version: 1,
        corpus_id: 'frc_test',
        turns: [
          {
            operations: [],
            audible_outputs: [
              {
                kind: 'field_null_fallback',
                count: 1,
                match: {
                  text_exact: 'No problem, moving on.',
                  dedupe_token: 'p4ack_sess-x-turn-1',
                },
              },
            ],
          },
        ],
      },
      frozenWith(
        baseEvidence({
          non_mutating_audible: [
            {
              channel: 'ws_extraction',
              kind: 'field_null_confirmation',
              text: 'No problem, moving on.',
              dedupe_token: 'p4ack_sess-x-turn-99',
            },
          ],
        })
      )
    );
    expect(v.verdict).toBe('FAIL');
  });

  test('RED: field_null_fallback with a declared dedupe_token FAILS when the captured row carries NO token at all', () => {
    const v = judgeFrozenEvidence(
      {
        schema_version: 1,
        corpus_id: 'frc_test',
        turns: [
          {
            operations: [],
            audible_outputs: [
              {
                kind: 'field_null_fallback',
                count: 1,
                match: {
                  text_exact: 'No problem, moving on.',
                  dedupe_token: 'p4ack_sess-x-turn-1',
                },
              },
            ],
          },
        ],
      },
      frozenWith(
        baseEvidence({
          non_mutating_audible: [
            {
              channel: 'ws_extraction',
              kind: 'field_null_confirmation',
              text: 'No problem, moving on.',
            },
          ],
        })
      )
    );
    expect(v.verdict).toBe('FAIL');
  });

  test('Codex diff-review cycle 2 — the REAL producer path (recordFrameDeliveryEvidence) threads a p4ack_ dedupe_token into non_mutating_audible, not just synthetic evidence', () => {
    // The three tests above prove the JUDGE comparison works against
    // hand-built evidence rows. This drives sonnet-stream.js's actual
    // frame-evaluation function — deleting the dedupeToken threading edit
    // inside it (sonnet-stream.js's frameKind==='extraction' field-null
    // branch, or plan00-lifecycle-hooks.js's recordNonMutatingAudible) would
    // leave every other new test in this cycle green but this one RED.
    const ctx = normaliseEvaluationContext(
      { deliveryLedger: createDeliveryLedger() },
      { sessionId: 's-p4ack' }
    );
    recordFrameDeliveryEvidence(
      ctx,
      'extraction',
      {
        confirmations: [
          {
            text: 'No problem, moving on.',
            field: null,
            circuit: null,
            dedupe_token: 'p4ack_s-p4ack-turn-1',
          },
        ],
        turn_id: 't-p4ack',
      },
      null
    );
    expect(ctx.nonMutatingAudible).toHaveLength(1);
    expect(ctx.nonMutatingAudible[0]).toMatchObject({
      kind: 'field_null_confirmation',
      text: 'No problem, moving on.',
      dedupe_token: 'p4ack_s-p4ack-turn-1',
    });
  });

  test('Codex diff-review cycle 2 — an ORDINARY field-null confirmation (no dedupe_token) reaching the real producer path gains NO dedupe_token key at all', () => {
    const ctx = normaliseEvaluationContext(
      { deliveryLedger: createDeliveryLedger() },
      { sessionId: 's-plain' }
    );
    recordFrameDeliveryEvidence(
      ctx,
      'extraction',
      {
        confirmations: [{ text: 'Sorry, say again?', field: null, circuit: null }],
        turn_id: 't-plain',
      },
      null
    );
    expect(ctx.nonMutatingAudible).toHaveLength(1);
    expect('dedupe_token' in ctx.nonMutatingAudible[0]).toBe(false);
  });

  test('field_cleared: a clear receipt from ANOTHER turn can never satisfy the confirmation', () => {
    const clearReceipt = {
      kind: 'clear',
      field: 'earth_loop_impedance_ze',
      circuit: null,
      board_id: null,
      value: null,
      extraction_turn_id: 'tOTHER',
      parent_operation_id: null,
    };
    const clearedKey = operationIdentityKey({
      extractionTurnId: 'tA',
      field: 'field_cleared',
      circuit: null,
      boardId: null,
      ordinal: 0,
    });
    const v = judgeFrozenEvidence(
      {
        schema_version: 1,
        corpus_id: 'frc_test',
        turns: [
          {
            operations: [],
            audible_outputs: [
              {
                kind: 'reading_confirmation',
                count: 1,
                match: { field: 'field_cleared', circuit: null, text_exact: 'Ze cleared' },
              },
            ],
          },
        ],
      },
      frozenWith(
        baseEvidence({
          receipts: [clearReceipt],
          deliveries: [
            {
              op_key: clearedKey,
              op_keys: [clearedKey],
              kind: 'confirmation',
              text: 'Ze cleared',
              at_seq: 1,
            },
          ],
          playbacks: [{ op_key: clearedKey, ack_body_hash: 'h1' }],
        })
      ),
      { turnIds: ['tA'] }
    );
    expect(v.verdict).toBe('FAIL');
    expect(v.mismatches.some((m) => m.class === 'field_cleared_receipt_mismatch')).toBe(true);
  });

  test('turn membership: an operation committed in the WRONG turn FAILS its expectation', () => {
    const receipt = {
      kind: 'reading',
      field: 'measured_zs_ohm',
      circuit: 4,
      board_id: null,
      value: '0.63',
      extraction_turn_id: 'tB',
      parent_operation_id: null,
    };
    const expectation = {
      schema_version: 1,
      corpus_id: 'frc_test',
      turns: [
        {
          operations: [
            { ordinal: 1, kind: 'reading', field: 'measured_zs_ohm', circuit: 4, value: '0.63' },
          ],
          audible_outputs: [],
        },
        { operations: [], audible_outputs: [] },
      ],
    };
    const v = judgeFrozenEvidence(expectation, frozenWith(baseEvidence({ receipts: [receipt] })), {
      turnIds: ['tA', 'tB'],
    });
    expect(v.verdict).toBe('FAIL');
    expect(v.mismatches.some((m) => m.class === 'operation_missing')).toBe(true);
    // And the same receipts judged WITHOUT the turn map (legacy callers)
    // still match whole-capture.
    const legacy = judgeFrozenEvidence(
      expectation,
      frozenWith(baseEvidence({ receipts: [receipt] }))
    );
    expect(legacy.verdict).toBe('PASS');
  });

  test('turn membership: receipts out of INDEX order still PASS when turn identity agrees', () => {
    const rB = {
      kind: 'reading',
      field: 'r1_r2_ohm',
      circuit: 2,
      board_id: null,
      value: '0.22',
      extraction_turn_id: 'tB',
      parent_operation_id: null,
    };
    const rA = {
      kind: 'reading',
      field: 'measured_zs_ohm',
      circuit: 4,
      board_id: null,
      value: '0.63',
      extraction_turn_id: 'tA',
      parent_operation_id: null,
    };
    const v = judgeFrozenEvidence(
      {
        schema_version: 1,
        corpus_id: 'frc_test',
        turns: [
          {
            operations: [
              { ordinal: 1, kind: 'reading', field: 'measured_zs_ohm', circuit: 4, value: '0.63' },
            ],
            audible_outputs: [],
          },
          {
            operations: [
              { ordinal: 1, kind: 'reading', field: 'r1_r2_ohm', circuit: 2, value: '0.22' },
            ],
            audible_outputs: [],
          },
        ],
      },
      frozenWith(baseEvidence({ receipts: [rB, rA] })),
      { turnIds: ['tA', 'tB'] }
    );
    expect(v.verdict).toBe('PASS');
  });
});

describe('Codex r2 route hardening — turn-exact playback ACK binding', () => {
  function makeTurnBoundApp() {
    const entry = { userId: 'route-user', session: {} };
    const ctx = normaliseEvaluationContext(
      { deliveryLedger: createDeliveryLedger() },
      { sessionId: 's-turnbound' }
    );
    attachEvaluationContext(entry, ctx);
    const router = createPlaybackAckRouter({
      requireAuth: (req, _res, next) => {
        req.user = { id: 'route-user' };
        next();
      },
      getActiveSessionEntry: () => entry,
    });
    const app = express();
    app.use(express.json());
    app.use('/api', router);
    return { app, ctx };
  }

  test("an ACK naming its turn binds ONLY that turn's delivery; a wrong-turn ACK stays telemetry", async () => {
    const { app, ctx } = makeTurnBoundApp();
    const slotId = (turn, ordinal) => ({
      extractionTurnId: turn,
      field: 'measured_zs_ohm',
      circuit: 4,
      boardId: null,
      ordinal,
    });
    ctx.recordDelivery([slotId('utt-1', 1)], {
      producerId: 'result_frame_confirmation',
      kind: 'confirmation',
      text: 'Zs 0.63',
      wireTurnId: 's-turn-1',
    });
    ctx.recordDelivery([slotId('utt-2', 1)], {
      producerId: 'result_frame_confirmation',
      kind: 'confirmation',
      text: 'Zs 0.71',
      wireTurnId: 's-turn-2',
    });
    const body = (turnId) => ({
      sessionId: 's-turnbound',
      turnId,
      slot: { field: 'measured_zs_ohm', circuit: 4, boardId: null },
      source: 'bundler',
      at_ms: 1754300000000,
    });
    // Same slot on two turns — WITHOUT turn binding this would be ambiguous
    // and neither ACK could ever bind (pre-fix behaviour).
    const r2 = await request(app).post('/api/voice-latency/playback-ack').send(body('s-turn-2'));
    expect(r2.status).toBe(204);
    expect(ctx.deliveryLedger.playbacks).toHaveLength(1);
    const boundKey = ctx.deliveryLedger.playbacks[0].op_key;
    expect(JSON.parse(boundKey).turn).toBe('utt-2');
    // A stale ACK naming a turn with no delivery row: telemetry only.
    const r3 = await request(app).post('/api/voice-latency/playback-ack').send(body('s-turn-9'));
    expect(r3.status).toBe(204);
    expect(ctx.deliveryLedger.playbacks).toHaveLength(1);
  });
});

describe('Codex r2 driver hardening — two-turn pump + exact ingress', () => {
  test("a two-turn fixture never reprocesses turn 1's ask on turn 2 (session-lifetime frame set)", async () => {
    const { bootLaneDriver, driveFixture } =
      await import('../../scripts/model-ab/lib/lane-driver.mjs');
    const { projectFixtureExpectation } =
      await import('../../scripts/model-ab/lib/expectation-projection.mjs');
    const boot = await bootLaneDriver({ repoRoot });
    try {
      const fixture = {
        corpus_id: 'frc_twoturn_synthetic',
        job_state: {
          certificateType: 'eicr',
          boards: [],
          circuits: [{ circuit_ref: 4, circuit_designation: 'Sockets' }],
        },
        client_capabilities: { value: ['low_conf_readback_v1'] },
        fallback_to_legacy: { value: false },
        turns: [
          {
            turn_index: 1,
            transcript: 'The Zs was recorded earlier.',
            confirmations_enabled: { value: true },
            regex_results: [],
            model_rounds: [
              {
                stop_reason: 'tool_use',
                tool_calls: [
                  {
                    id: 'toolu_tt_ask',
                    name: 'ask_user',
                    input: {
                      question: 'Which circuit was that for?',
                      reason: 'missing_context',
                      context_field: 'measured_zs_ohm',
                      context_circuit: null,
                      expected_answer_shape: 'circuit_ref',
                    },
                  },
                ],
              },
              { stop_reason: 'end_turn', text: '' },
            ],
            ask_answers: [
              {
                match: { context_field: 'measured_zs_ohm' },
                answer: { user_text: 'Circuit 4.', answered: true },
                answer_channel: 'direct',
                at_ms_after_ask: 100,
              },
            ],
            expected_operations: [],
            expected_audible_outputs: [
              { output_id: 'out_ask', kind: 'ask_user', count: 1, match: {} },
              // The P4 answered-ask decline/ack net speaks one field-null
              // acknowledgment for an answered turn that produced no write —
              // real behaviour the strict undeclared-audible sweep demands
              // be declared.
              { output_id: 'out_ack', kind: 'field_null_fallback', count: 1, match: {} },
            ],
          },
          {
            turn_index: 2,
            transcript: 'Zs for circuit 4 is 0.63.',
            confirmations_enabled: { value: true },
            regex_results: [],
            model_rounds: [
              {
                stop_reason: 'tool_use',
                tool_calls: [
                  {
                    id: 'toolu_tt_write',
                    name: 'record_reading',
                    input: {
                      field: 'measured_zs_ohm',
                      circuit: 4,
                      value: '0.63',
                      confidence: 0.9,
                      source_turn_id: 't2',
                    },
                  },
                ],
              },
              { stop_reason: 'end_turn', text: '' },
            ],
            ask_answers: [],
            expected_operations: [
              { kind: 'reading', field: 'measured_zs_ohm', circuit: 4, value: '0.63' },
            ],
            expected_audible_outputs: [],
          },
        ],
      };
      const expectation = projectFixtureExpectation(fixture);
      const result = await driveFixture({
        boot,
        fixture,
        expectation,
        // Single-board synthetic job — same wildcard rule as
        // runVendorLaneMock (§B5 pinned IR contract).
        judge: (e, f2, o) => judgeFrozenEvidence(e, f2, { boardWildcard: true, ...(o ?? {}) }),
      });
      // Pre-fix, turn 2's pump rediscovered turn 1's ask frame in the
      // session-lifetime `sent` array and failed `unexpected_ask:...`.
      expect(result.reason ?? '').not.toMatch(/^unexpected_ask/);
      expect(result.verdict).toBe('PASS');
    } finally {
      boot.clockCtl.uninstall();
    }
  }, 60000);
});

describe('Codex r3 judge hardening — implied playback mandate + board strictness', () => {
  const r3Key = operationIdentityKey({
    extractionTurnId: 't1',
    field: 'ir_live_live_mohm',
    circuit: 3,
    boardId: null,
    ordinal: 1,
  });
  const r3Receipt = {
    kind: 'reading',
    field: 'ir_live_live_mohm',
    circuit: 3,
    board_id: null,
    value: '100',
    extraction_turn_id: 't1',
    turn_ordinal: 1,
    parent_operation_id: null,
  };
  const r3Op = {
    ordinal: 1,
    kind: 'reading',
    field: 'ir_live_live_mohm',
    circuit: 3,
    value: '100',
    audibility: 'exactly_once',
  };
  const r3Delivery = {
    op_key: r3Key,
    op_keys: [r3Key],
    kind: 'confirmation',
    transport: 'ws_extraction',
    text: 'IR 100',
    at_seq: 1,
  };

  test('an IMPLIED delivery for an exactly_once op still requires its playback proof', () => {
    const v = judgeFrozenEvidence(
      expectationWith({ operations: [r3Op], audible_outputs: [] }),
      frozenWith(baseEvidence({ receipts: [r3Receipt], deliveries: [r3Delivery], playbacks: [] }))
    );
    expect(v.verdict).toBe('FAIL');
    expect(v.mismatches.some((m) => m.class === 'playback_proof_missing')).toBe(true);
    // With the playback present, the same shape PASSES.
    const ok = judgeFrozenEvidence(
      expectationWith({ operations: [r3Op], audible_outputs: [] }),
      frozenWith(
        baseEvidence({
          receipts: [r3Receipt],
          deliveries: [r3Delivery],
          playbacks: [{ op_key: r3Key, ack_body_hash: 'h1' }],
        })
      )
    );
    expect(ok.verdict).toBe('PASS');
  });

  test('a board-NULL receipt never satisfies an explicitly board-scoped expectation (no wildcard)', () => {
    const boardOp = {
      ordinal: 1,
      kind: 'reading',
      field: 'measured_zs_ohm',
      circuit: 4,
      board_id: 'main',
      value: '0.63',
    };
    const nullBoardReceipt = {
      kind: 'reading',
      field: 'measured_zs_ohm',
      circuit: 4,
      board_id: null,
      value: '0.63',
      parent_operation_id: null,
    };
    const v = judgeFrozenEvidence(
      expectationWith({ operations: [boardOp], audible_outputs: [] }),
      frozenWith(baseEvidence({ receipts: [nullBoardReceipt] })),
      { boardWildcard: false }
    );
    expect(v.verdict).toBe('FAIL');
    expect(v.mismatches.some((m) => m.class === 'operation_missing')).toBe(true);
    // The single-board wildcard keeps its leniency.
    const lenient = judgeFrozenEvidence(
      expectationWith({ operations: [boardOp], audible_outputs: [] }),
      frozenWith(baseEvidence({ receipts: [nullBoardReceipt] })),
      { boardWildcard: true }
    );
    expect(lenient.verdict).toBe('PASS');
  });
});

describe('Codex r4 hardening — answered terminals, bounded pump', () => {
  test('a timed-out ask never satisfies a DECLARED-answer expectation', () => {
    const timedOut = {
      key: '{}',
      state: 'timeout',
      runtime_id: 'toolu_t',
      meta: { family: 'dispatcher' },
      history: ['produced', 'emitted', 'timeout'],
    };
    const v = judgeFrozenEvidence(
      {
        schema_version: 1,
        corpus_id: 'frc_test',
        turns: [
          {
            operations: [],
            audible_outputs: [{ kind: 'ask_user', count: 1, match: null }],
            ask_answers: [{ answer_text: 'Circuit 4.', answered: true, channel: 'direct' }],
          },
        ],
      },
      frozenWith(baseEvidence({ ask_entries: [timedOut] }))
    );
    expect(v.verdict).toBe('FAIL');
    expect(v.mismatches.some((m) => m.class === 'ask_not_answered')).toBe(true);
    // Without a declared answer the emitted-then-timed-out ask is legitimate.
    const noAnswerDeclared = judgeFrozenEvidence(
      {
        schema_version: 1,
        corpus_id: 'frc_test',
        turns: [
          {
            operations: [],
            audible_outputs: [{ kind: 'ask_user', count: 1, match: null }],
            ask_answers: [],
          },
        ],
      },
      frozenWith(baseEvidence({ ask_entries: [timedOut] }))
    );
    expect(noAnswerDeclared.verdict).toBe('PASS');
  });

  test('an UNDECLARED dispatcher ask terminates the lane bounded (INVALID_HOLD, no deadlock)', async () => {
    const { bootLaneDriver, driveFixture } =
      await import('../../scripts/model-ab/lib/lane-driver.mjs');
    const { projectFixtureExpectation } =
      await import('../../scripts/model-ab/lib/expectation-projection.mjs');
    const boot = await bootLaneDriver({ repoRoot });
    try {
      const fixture = {
        corpus_id: 'frc_deadlock_synthetic',
        job_state: { certificateType: 'eicr', boards: [], circuits: [] },
        client_capabilities: { value: ['low_conf_readback_v1'] },
        fallback_to_legacy: { value: false },
        turns: [
          {
            turn_index: 1,
            transcript: 'Zs for circuit 9.',
            confirmations_enabled: { value: true },
            regex_results: [],
            model_rounds: [
              {
                stop_reason: 'tool_use',
                tool_calls: [
                  {
                    id: 'toolu_dead_ask',
                    name: 'ask_user',
                    input: {
                      question: 'What was the value?',
                      reason: 'missing_value',
                      context_field: 'measured_zs_ohm',
                      context_circuit: 9,
                      expected_answer_shape: 'number',
                    },
                  },
                ],
              },
              { stop_reason: 'end_turn', text: '' },
            ],
            // NO declared answers — the emitted ask is undeclared for the
            // pump, which pre-fix deadlocked awaiting the blocked turn.
            ask_answers: [],
            expected_operations: [],
            expected_audible_outputs: [],
          },
        ],
      };
      const result = await driveFixture({
        boot,
        fixture,
        expectation: projectFixtureExpectation(fixture),
        judge: (e, f2, o) => judgeFrozenEvidence(e, f2, { boardWildcard: true, ...(o ?? {}) }),
      });
      expect(result.verdict).toBe('INVALID_HOLD');
      expect(String(result.reason)).toMatch(/^unexpected_ask/);
    } finally {
      boot.clockCtl.uninstall();
    }
  }, 60000);
});

describe('Codex r4b — monotonic ask assignment across turns', () => {
  test('a [timeout, answered] entry order cannot swap across a declared-answer and answerless turn', () => {
    const entries = [
      {
        key: '{}',
        state: 'timeout',
        runtime_id: 'toolu_1',
        meta: { family: 'dispatcher' },
        history: ['produced', 'emitted', 'timeout'],
      },
      {
        key: '{}',
        state: 'answered',
        runtime_id: 'toolu_2',
        meta: { family: 'dispatcher' },
        history: ['produced', 'emitted', 'answered'],
      },
    ];
    const v = judgeFrozenEvidence(
      {
        schema_version: 1,
        corpus_id: 'frc_test',
        turns: [
          {
            operations: [],
            audible_outputs: [{ kind: 'ask_user', count: 1, match: null }],
            ask_answers: [{ answer_text: 'Circuit 4.', answered: true, channel: 'direct' }],
          },
          {
            operations: [],
            audible_outputs: [{ kind: 'ask_user', count: 1, match: null }],
            ask_answers: [],
          },
        ],
      },
      frozenWith(baseEvidence({ ask_entries: entries }))
    );
    // Turn 1's assigned entry is the TIMEOUT — the answered entry belongs
    // to turn 2 and can never be swapped backwards.
    expect(v.verdict).toBe('FAIL');
    expect(v.mismatches.some((m) => m.class === 'ask_not_answered')).toBe(true);
  });
});
