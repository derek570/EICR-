/**
 * stage6-dispatcher-ask-enum.test.js
 *
 * Integration tests for the dispatcher's enum-resolve wiring (Bug B from
 * session DC946608, 8 Branagh Court, 2026-05-06).
 *
 * The unit tests for resolveEnumAnswer live in stage6-answer-resolver-enum.test.js;
 * this file asserts that:
 *
 *   1. the dispatcher calls resolveEnumAnswer BEFORE resolveValueAnswer for
 *      select-typed fields, so digit-only replies that match the option list
 *      auto-resolve cleanly,
 *   2. did_you_mean / invalid_value verdicts surface in the tool_result body
 *      with the expected match_status / valid_options / suggestions shape,
 *   3. text-typed fields and word-anchored enums still fall through to the
 *      legacy / value-resolver paths (back-compat).
 *
 * Mirrors the structure of stage6-dispatcher-ask-pending-write.test.js.
 */

import { jest } from '@jest/globals';
import { createAskDispatcher } from '../extraction/stage6-dispatcher-ask.js';
import { createPendingAsksRegistry } from '../extraction/stage6-pending-asks-registry.js';

const validInput = (overrides = {}) => ({
  question: "What's the BS number?",
  // missing_context is the canonical wire-schema reason for "I have a
  // value but I'm missing some piece of context to apply it" — used here
  // even though the user-visible reason in the iOS UI may be displayed as
  // "missing_value". The closed enum (ASK_USER_REASONS) is shared with
  // the validator at stage6-dispatch-validation.js:253.
  reason: 'missing_context',
  context_field: 'rcd_bs_en',
  context_circuit: 1,
  expected_answer_shape: 'free_text',
  ...overrides,
});

const buildSession = () => ({
  sessionId: 'sess-test-enum',
  stateSnapshot: {
    circuits: {
      1: { designation: 'Cooker' },
      2: { designation: 'Sockets bedroom' },
    },
  },
});

const noopLogger = () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
});

// Run a full dispatcher cycle: build call, simulate the user reply via
// pendingAsks.resolve, return the parsed body.
async function runDispatcher({ userText, input = validInput(), session = buildSession() }) {
  const logger = noopLogger();
  const pendingAsks = createPendingAsksRegistry();
  const autoResolveWrite = jest.fn().mockResolvedValue({ ok: true, body: { ok: true } });
  const dispatcher = createAskDispatcher(session, logger, 'turn-1', pendingAsks, null, {
    autoResolveWrite,
  });

  const callPromise = dispatcher(
    {
      tool_call_id: 'toolu_enum',
      name: 'ask_user',
      input,
    },
    {}
  );

  await new Promise((r) => setImmediate(r));
  pendingAsks.resolve('toolu_enum', { answered: true, user_text: userText });
  const env = await callPromise;
  return { env, body: JSON.parse(env.content), logger, autoResolveWrite };
}

describe('dispatcher enum-resolve — auto-resolve path', () => {
  test('"61008" against rcd_bs_en → enum_resolved body, write dispatched once', async () => {
    const { env, body, autoResolveWrite } = await runDispatcher({ userText: '61008' });
    expect(env.is_error).toBe(false);
    expect(body).toMatchObject({
      answered: true,
      auto_resolved: true,
      match_status: 'enum_resolved',
      untrusted_user_text: '61008',
    });
    expect(body.resolved_writes).toEqual([
      expect.objectContaining({
        tool: 'record_reading',
        field: 'rcd_bs_en',
        circuit: 1,
        value: '61008',
        ok: true,
      }),
    ]);
    expect(autoResolveWrite).toHaveBeenCalledTimes(1);
  });

  test('"BS EN 62423" — wrapping words ignored, write fires with canonical "62423"', async () => {
    const { body } = await runDispatcher({ userText: 'BS EN 62423' });
    expect(body.match_status).toBe('enum_resolved');
    expect(body.resolved_writes[0].value).toBe('62423');
  });
});

describe('dispatcher enum-resolve — did_you_mean rejection (1-digit typo)', () => {
  test('"61018" → did_you_mean body with suggestions=["61008"], NO write dispatched', async () => {
    const { body, autoResolveWrite } = await runDispatcher({ userText: '61018' });
    expect(body).toMatchObject({
      answered: true,
      auto_resolved: false,
      match_status: 'did_you_mean',
      field: 'rcd_bs_en',
      circuit: 1,
      received: '61018',
      suggestions: ['61008'],
      valid_options: ['', '61008', '61009', '62423', 'N/A'],
    });
    expect(autoResolveWrite).not.toHaveBeenCalled();
  });
});

describe('dispatcher enum-resolve — invalid_value rejection (no close match)', () => {
  test('"68001" (the actual prod input from session DC946608) → invalid_value body, NO write', async () => {
    // 68001 vs 61008 = TWO digits different (positions 1 and 4), so it falls
    // out of the did_you_mean band and into invalid_value. Documents the
    // exact symptom from the field session.
    const { body, autoResolveWrite } = await runDispatcher({ userText: '68001' });
    expect(body).toMatchObject({
      answered: true,
      auto_resolved: false,
      match_status: 'invalid_value',
      field: 'rcd_bs_en',
      circuit: 1,
      received: '68001',
      valid_options: ['', '61008', '61009', '62423', 'N/A'],
    });
    expect(body.suggestions).toBeUndefined();
    expect(autoResolveWrite).not.toHaveBeenCalled();
  });

  test('"banana" → invalid_value with received="banana"', async () => {
    const { body } = await runDispatcher({ userText: 'banana' });
    expect(body.match_status).toBe('invalid_value');
    expect(body.received).toBe('banana');
  });
});

describe('dispatcher enum-resolve — fall-through (legacy / value-resolver still works)', () => {
  test('text-typed field (measured_zs_ohm + numeric reply) — value-resolver still fires (no enum interception)', async () => {
    const input = validInput({
      question: 'What is the Zs reading?',
      context_field: 'measured_zs_ohm',
    });
    const { body, autoResolveWrite } = await runDispatcher({
      userText: '0.47',
      input,
    });
    expect(body.match_status).toBe('value_resolved');
    expect(body.resolved_writes[0]).toMatchObject({
      field: 'measured_zs_ohm',
      circuit: 1,
      value: '0.47',
    });
    expect(autoResolveWrite).toHaveBeenCalledTimes(1);
  });

  test('word-anchored enum (rcd_type AC|A|F|B + "AC" reply) — falls through to legacy body', async () => {
    // rcd_type's options aren't all 5-digit, so enum-resolver returns
    // no_value_context. Value-resolver also returns escalate (no numeric).
    // Result: legacy untrusted_user_text body — Sonnet decides.
    const input = validInput({
      question: 'What RCD type? AC, A, F, or B?',
      context_field: 'rcd_type',
    });
    const { body, autoResolveWrite } = await runDispatcher({ userText: 'AC', input });
    expect(body.match_status).toBeUndefined();
    expect(body).toMatchObject({
      answered: true,
      untrusted_user_text: 'AC',
    });
    expect(autoResolveWrite).not.toHaveBeenCalled();
  });

  test('rcd_bs_en + "N/A" reply → enum-resolver auto-resolves to canonical "N/A"', async () => {
    const { body } = await runDispatcher({ userText: 'N/A' });
    expect(body.match_status).toBe('enum_resolved');
    expect(body.resolved_writes[0].value).toBe('N/A');
  });
});
