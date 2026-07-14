/**
 * §A4 (field-feedback-2026-07-14, F8) — dispatcher-level tests for the
 * pending-value write-or-reask guarantee:
 *
 *   - F8 replay: "ICD trip time … 26 ms" garbles the field → ask with
 *     context_field:"none" captures pendingValue at registration → the
 *     inspector answers "RCD trip time." → the server synthesizes
 *     record_reading{rcd_time_ms, circuit 2, 26} through the NORMAL
 *     dispatch hook (read-back included) — never a direct snapshot write.
 *   - question-only capture (ask question carries the numeric, transcript
 *     doesn't).
 *   - shape (1): field unresolvable → ONE brokered pvr-* FIELD ask
 *     (registered BEFORE ask_user_started is sent), answer re-enters
 *     field resolution.
 *   - shape (3): no circuit → brokered circuit_ref ask RETAINING field+value.
 *   - retry cap: second field-resolution failure → audible apology queued on
 *     session.pendingVoicePrompts (never silent), match_status
 *     pending_value_failed.
 *   - user_moved_on on a brokered ask → chain ends WITHOUT dispatching the
 *     captured value.
 *   - no-CPC preservation: a 'none' ask with NO captured value and a
 *     non-field reply falls through to the legacy body untouched.
 */

import { jest } from '@jest/globals';
import { createAskDispatcher } from '../extraction/stage6-dispatcher-ask.js';
import { createPendingAsksRegistry } from '../extraction/stage6-pending-asks-registry.js';

const noopLogger = () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() });

const buildSession = (overrides = {}) => ({
  sessionId: 'sess-pv',
  stateSnapshot: { circuits: { 2: { circuit_designation: 'Upstairs sockets' } } },
  activeTurnTranscript: null,
  ...overrides,
});

const noneAsk = (overrides = {}) => ({
  question: 'I heard 26 milliseconds for circuit 2 — which reading was that for?',
  // The inverted-ask shape is prompt-mandated to use the missing_field
  // family (FIELD-AMBIGUITY rule) — the Codex r2-#1 eligibility predicate
  // requires it, so a generic missing_context 'none' ask never captures.
  reason: 'missing_field',
  context_field: 'none',
  context_circuit: 2,
  expected_answer_shape: 'free_text',
  ...overrides,
});

/** Fake ws that records sent frames and lets tests answer pvr-* asks. */
function makeWs() {
  const sent = [];
  return {
    readyState: 1,
    OPEN: 1,
    sent,
    send(payload) {
      sent.push(JSON.parse(payload));
    },
  };
}

async function tick(n = 3) {
  for (let i = 0; i < n; i += 1) await new Promise((r) => setImmediate(r));
}

describe('§A4 — pendingValue capture at ask registration', () => {
  test('context_field:"none" ask captures the value from session.activeTurnTranscript FIRST', async () => {
    const session = buildSession({
      activeTurnTranscript: 'ICD trip time for circuit 2 is 26 milliseconds.',
    });
    const pendingAsks = createPendingAsksRegistry();
    const dispatcher = createAskDispatcher(session, noopLogger(), 'turn-24', pendingAsks, null, {});
    const p = dispatcher({ tool_call_id: 'toolu_f8', name: 'ask_user', input: noneAsk() }, {});
    await tick();
    // The registry entry carries the captured pendingValue.
    let entry = null;
    for (const [id, e] of pendingAsks.entries()) if (id === 'toolu_f8') entry = e;
    expect(entry.pendingValue).toMatchObject({ value: '26', unit: 'ms', source: 'transcript' });
    pendingAsks.resolve('toolu_f8', { answered: false, reason: 'timeout' });
    await p;
  });

  test('concrete-context asks capture NOTHING (pendingWrite territory)', async () => {
    const session = buildSession({ activeTurnTranscript: 'Zs is 0.3 ohms' });
    const pendingAsks = createPendingAsksRegistry();
    const dispatcher = createAskDispatcher(session, noopLogger(), 'turn-1', pendingAsks, null, {});
    const p = dispatcher(
      {
        tool_call_id: 'toolu_c',
        name: 'ask_user',
        input: noneAsk({ context_field: 'measured_zs_ohm', expected_answer_shape: 'number' }),
      },
      {}
    );
    await tick();
    let entry = null;
    for (const [id, e] of pendingAsks.entries()) if (id === 'toolu_c') entry = e;
    expect(entry.pendingValue).toBeNull();
    pendingAsks.resolve('toolu_c', { answered: false, reason: 'timeout' });
    await p;
  });
});

describe('§A4 — F8 end-to-end replay through the dispatcher', () => {
  test('"ICD trip time… 26 ms" → ask → "RCD trip time." → record_reading{rcd_time_ms, 2, 26} dispatched + read-back path', async () => {
    const session = buildSession({
      activeTurnTranscript: 'ICD trip time for circuit 2 is 26 milliseconds.',
    });
    const logger = noopLogger();
    const pendingAsks = createPendingAsksRegistry();
    const autoResolveWrite = jest.fn().mockResolvedValue({ ok: true });
    const dispatcher = createAskDispatcher(session, logger, 'turn-24', pendingAsks, makeWs(), {
      autoResolveWrite,
    });

    const p = dispatcher({ tool_call_id: 'toolu_f8', name: 'ask_user', input: noneAsk() }, {});
    await tick();
    pendingAsks.resolve('toolu_f8', { answered: true, user_text: 'RCD trip time.' });
    const env = await p;

    const body = JSON.parse(env.content);
    expect(body).toMatchObject({
      answered: true,
      auto_resolved: true,
      match_status: 'pending_value_resolved',
    });
    // The write goes through the NORMAL dispatch hook with the CANONICAL
    // snapshot key (rcd_time_ms — wire canonicalisation to rcd_trip_time
    // happens downstream in sonnet-stream/bundler, not here).
    expect(autoResolveWrite).toHaveBeenCalledWith(
      expect.objectContaining({
        tool: 'record_reading',
        field: 'rcd_time_ms',
        circuit: 2,
        value: '26',
      }),
      expect.objectContaining({ toolCallId: 'toolu_f8' })
    );
    // Escalation telemetry fires for this shape too.
    const escalated = logger.info.mock.calls.filter(
      (c) => c[0] === 'stage6.ask_user_value_resolution_escalated'
    );
    expect(escalated.length).toBeGreaterThan(0);
  });

  test('ask question OMITS the numeric → value captured from transcript; question-only capture also works', async () => {
    const session = buildSession({ activeTurnTranscript: null });
    const pendingAsks = createPendingAsksRegistry();
    const autoResolveWrite = jest.fn().mockResolvedValue({ ok: true });
    const dispatcher = createAskDispatcher(session, noopLogger(), 't', pendingAsks, makeWs(), {
      autoResolveWrite,
    });
    // Question carries the value (transcript was consumed by a previous turn).
    const p = dispatcher({ tool_call_id: 'toolu_q', name: 'ask_user', input: noneAsk() }, {});
    await tick();
    pendingAsks.resolve('toolu_q', { answered: true, user_text: 'trip time' });
    const env = await p;
    const body = JSON.parse(env.content);
    expect(body.match_status).toBe('pending_value_resolved');
    expect(autoResolveWrite).toHaveBeenCalledWith(
      expect.objectContaining({ field: 'rcd_time_ms', circuit: 2, value: '26' }),
      expect.anything()
    );
  });
});

describe('§A4 — brokered pvr-* asks (the deterministic-ask BROKER)', () => {
  test('shape (1): field unresolvable → brokered FIELD ask registered BEFORE ask_user_started; answer resolves the chain', async () => {
    const session = buildSession({
      activeTurnTranscript: 'something something 26 milliseconds.',
    });
    const pendingAsks = createPendingAsksRegistry();
    const ws = makeWs();
    const autoResolveWrite = jest.fn().mockResolvedValue({ ok: true });
    const dispatcher = createAskDispatcher(session, noopLogger(), 't', pendingAsks, ws, {
      autoResolveWrite,
    });

    const p = dispatcher({ tool_call_id: 'toolu_g', name: 'ask_user', input: noneAsk() }, {});
    await tick();
    // Reply does NOT name a field → the chain brokers a pvr-* FIELD ask.
    pendingAsks.resolve('toolu_g', { answered: true, user_text: 'erm the auto feature thing' });
    await tick();

    const started = ws.sent.filter(
      (f) => f.type === 'ask_user_started' && String(f.tool_call_id).startsWith('pvr-')
    );
    expect(started).toHaveLength(1);
    const pvrId = started[0].tool_call_id;
    expect(pvrId.startsWith('pvr-')).toBe(true); // NOT srv- (that bypasses the registry)
    expect(started[0].expected_answer_shape).toBe('free_text');
    // REGISTERED BEFORE SEND: it must be resolvable right now.
    // The brokered entry carries the pendingValue so the transcript-overtake
    // continuation branch can accept a field-name reply.
    let brokeredEntry = null;
    for (const [id, e] of pendingAsks.entries()) if (id === pvrId) brokeredEntry = e;
    expect(brokeredEntry).not.toBeNull();
    expect(brokeredEntry.pendingValue).toMatchObject({ value: '26' });

    pendingAsks.resolve(pvrId, { answered: true, user_text: 'RCD trip time' });
    const env = await p;
    const body = JSON.parse(env.content);
    expect(body.match_status).toBe('pending_value_resolved');
    expect(autoResolveWrite).toHaveBeenCalledWith(
      expect.objectContaining({ field: 'rcd_time_ms', circuit: 2, value: '26' }),
      expect.anything()
    );
  });

  test('shape (3): field+value but NO circuit → brokered circuit_ref ask RETAINS both; dispatch after resolution', async () => {
    const session = buildSession({
      activeTurnTranscript: 'trip time 26 milliseconds somewhere',
    });
    const pendingAsks = createPendingAsksRegistry();
    const ws = makeWs();
    const autoResolveWrite = jest.fn().mockResolvedValue({ ok: true });
    const dispatcher = createAskDispatcher(session, noopLogger(), 't', pendingAsks, ws, {
      autoResolveWrite,
    });
    const p = dispatcher(
      { tool_call_id: 'toolu_nc', name: 'ask_user', input: noneAsk({ context_circuit: null }) },
      {}
    );
    await tick();
    pendingAsks.resolve('toolu_nc', { answered: true, user_text: 'RCD trip time' });
    await tick();
    const started = ws.sent.filter(
      (f) => f.type === 'ask_user_started' && String(f.tool_call_id).startsWith('pvr-')
    );
    expect(started).toHaveLength(1);
    expect(started[0].expected_answer_shape).toBe('circuit_ref');
    expect(started[0].context_field).toBe('rcd_time_ms'); // field retained
    pendingAsks.resolve(started[0].tool_call_id, { answered: true, user_text: 'circuit 5' });
    const env = await p;
    const body = JSON.parse(env.content);
    expect(body.match_status).toBe('pending_value_resolved');
    expect(autoResolveWrite).toHaveBeenCalledWith(
      expect.objectContaining({ field: 'rcd_time_ms', circuit: 5, value: '26' }),
      expect.anything()
    );
  });

  test('retry cap 1: brokered field ask ALSO fails → audible apology queued, match_status pending_value_failed, NO write', async () => {
    const session = buildSession({ activeTurnTranscript: 'blah 26 milliseconds' });
    const pendingAsks = createPendingAsksRegistry();
    const ws = makeWs();
    const autoResolveWrite = jest.fn().mockResolvedValue({ ok: true });
    const dispatcher = createAskDispatcher(session, noopLogger(), 't', pendingAsks, ws, {
      autoResolveWrite,
    });
    const p = dispatcher({ tool_call_id: 'toolu_x', name: 'ask_user', input: noneAsk() }, {});
    await tick();
    pendingAsks.resolve('toolu_x', { answered: true, user_text: 'no idea what you mean' });
    await tick();
    const started = ws.sent.filter(
      (f) => f.type === 'ask_user_started' && String(f.tool_call_id).startsWith('pvr-')
    );
    expect(started).toHaveLength(1);
    // Second failure — the brokered answer ALSO fails field resolution.
    pendingAsks.resolve(started[0].tool_call_id, { answered: true, user_text: 'still no idea' });
    const env = await p;
    const body = JSON.parse(env.content);
    expect(body.match_status).toBe('pending_value_failed');
    expect(autoResolveWrite).not.toHaveBeenCalled();
    // Never silent: the deterministic apology is queued for the harness to
    // speak via result.confirmations (field-nil → A1(b) 30s TTL class).
    expect(session.pendingVoicePrompts).toHaveLength(1);
    expect(session.pendingVoicePrompts[0].text).toMatch(/couldn't place/i);
    // Exactly ONE brokered ask — cap respected, no loop.
    expect(
      ws.sent.filter(
        (f) => f.type === 'ask_user_started' && String(f.tool_call_id).startsWith('pvr-')
      )
    ).toHaveLength(1);
  });

  test('cancellation: brokered ask resolved user_moved_on → chain ends WITHOUT dispatching the captured value', async () => {
    const session = buildSession({ activeTurnTranscript: 'blah 26 milliseconds' });
    const pendingAsks = createPendingAsksRegistry();
    const ws = makeWs();
    const autoResolveWrite = jest.fn().mockResolvedValue({ ok: true });
    const dispatcher = createAskDispatcher(session, noopLogger(), 't', pendingAsks, ws, {
      autoResolveWrite,
    });
    const p = dispatcher({ tool_call_id: 'toolu_m', name: 'ask_user', input: noneAsk() }, {});
    await tick();
    pendingAsks.resolve('toolu_m', { answered: true, user_text: 'hmm what' });
    await tick();
    const started = ws.sent.filter(
      (f) => f.type === 'ask_user_started' && String(f.tool_call_id).startsWith('pvr-')
    );
    expect(started).toHaveLength(1);
    // Fresh recordable reading arrived → overtake path rejects the registry.
    pendingAsks.resolve(started[0].tool_call_id, { answered: false, reason: 'user_moved_on' });
    const env = await p;
    const body = JSON.parse(env.content);
    expect(body.match_status).toBe('pending_value_unresolved');
    expect(autoResolveWrite).not.toHaveBeenCalled();
    // No apology — the inspector deliberately moved on; their fresh
    // utterance gets its own response through the normal path.
    expect(session.pendingVoicePrompts ?? []).toHaveLength(0);
  });

  test('timeout on the brokered ask → pending_value_unresolved, no write, no apology (the question was audible)', async () => {
    const session = buildSession({ activeTurnTranscript: 'blah 26 milliseconds' });
    const pendingAsks = createPendingAsksRegistry();
    const ws = makeWs();
    const autoResolveWrite = jest.fn().mockResolvedValue({ ok: true });
    const dispatcher = createAskDispatcher(session, noopLogger(), 't', pendingAsks, ws, {
      autoResolveWrite,
    });
    const p = dispatcher({ tool_call_id: 'toolu_t', name: 'ask_user', input: noneAsk() }, {});
    await tick();
    pendingAsks.resolve('toolu_t', { answered: true, user_text: 'hmm what' });
    await tick();
    const started = ws.sent.filter(
      (f) => f.type === 'ask_user_started' && String(f.tool_call_id).startsWith('pvr-')
    );
    pendingAsks.resolve(started[0].tool_call_id, { answered: false, reason: 'timeout' });
    const env = await p;
    const body = JSON.parse(env.content);
    expect(body.match_status).toBe('pending_value_unresolved');
    expect(autoResolveWrite).not.toHaveBeenCalled();
  });
});

describe('§A4 Codex r3-#1/#3 — shape-2 reachability + pre-emit broker failures', () => {
  test('r3-#1 shape (2): eligible ask with NO captured value + field-name reply → brokered VALUE ask, resolveValueAnswer path, write dispatched', async () => {
    // Transcript carries NO number → capture returns null; eligibility alone
    // must route the field-name reply into the chain.
    const session = buildSession({ activeTurnTranscript: 'something garbled entirely' });
    const pendingAsks = createPendingAsksRegistry();
    const ws = makeWs();
    const autoResolveWrite = jest.fn().mockResolvedValue({ ok: true });
    const dispatcher = createAskDispatcher(session, noopLogger(), 't', pendingAsks, ws, {
      autoResolveWrite,
    });
    const p = dispatcher(
      {
        tool_call_id: 'toolu_s2',
        name: 'ask_user',
        input: noneAsk({ question: 'For circuit 2, what was that reading for?' }),
      },
      {}
    );
    await tick();
    pendingAsks.resolve('toolu_s2', { answered: true, user_text: 'RCD trip time' });
    await tick();
    const started = ws.sent.filter(
      (f) => f.type === 'ask_user_started' && String(f.tool_call_id).startsWith('pvr-')
    );
    expect(started).toHaveLength(1);
    expect(started[0].context_field).toBe('rcd_time_ms');
    expect(started[0].expected_answer_shape).toBe('number');
    pendingAsks.resolve(started[0].tool_call_id, { answered: true, user_text: '26' });
    const env = await p;
    const body = JSON.parse(env.content);
    expect(body.match_status).toBe('pending_value_resolved');
    expect(autoResolveWrite).toHaveBeenCalledWith(
      expect.objectContaining({ field: 'rcd_time_ms', circuit: 2, value: '26' }),
      expect.anything()
    );
  });

  test('r3-#3: broker with a CLOSED socket → question never emitted → terminal apology, never a silent move-on', async () => {
    const session = buildSession({ activeTurnTranscript: 'blah 26 milliseconds' });
    const pendingAsks = createPendingAsksRegistry();
    const closedWs = { readyState: 3, OPEN: 1, sent: [], send() {} };
    const autoResolveWrite = jest.fn().mockResolvedValue({ ok: true });
    const dispatcher = createAskDispatcher(session, noopLogger(), 't', pendingAsks, closedWs, {
      autoResolveWrite,
    });
    const p = dispatcher({ tool_call_id: 'toolu_c3', name: 'ask_user', input: noneAsk() }, {});
    await tick();
    // Reply doesn't resolve a field → the chain brokers a FIELD ask, but the
    // socket is closed → pre-emit failure → audible apology queued.
    pendingAsks.resolve('toolu_c3', { answered: true, user_text: 'no idea' });
    const env = await p;
    const body = JSON.parse(env.content);
    expect(body.match_status).toBe('pending_value_failed');
    expect(session.pendingVoicePrompts).toHaveLength(1);
    expect(autoResolveWrite).not.toHaveBeenCalled();
  });
});

describe('§A4 — regressions: flows that must NOT engage', () => {
  test('no-CPC-class preservation: a "none" ask with NO captured value and a yes/no reply falls through to the LEGACY body', async () => {
    const session = buildSession({ activeTurnTranscript: 'is there a CPC on this circuit' });
    const pendingAsks = createPendingAsksRegistry();
    const ws = makeWs();
    const autoResolveWrite = jest.fn().mockResolvedValue({ ok: true });
    const dispatcher = createAskDispatcher(session, noopLogger(), 't', pendingAsks, ws, {
      autoResolveWrite,
    });
    const p = dispatcher(
      {
        tool_call_id: 'toolu_cpc',
        name: 'ask_user',
        input: noneAsk({
          question: 'Is there no CPC at this final circuit, or is it a Class II installation?',
        }),
      },
      {}
    );
    await tick();
    pendingAsks.resolve('toolu_cpc', { answered: true, user_text: 'no CPC present' });
    const env = await p;
    const body = JSON.parse(env.content);
    // Legacy body — the pending-value flow did NOT consume it, no broker ask.
    expect(body).toMatchObject({ answered: true, untrusted_user_text: 'no CPC present' });
    expect(body.match_status).toBeUndefined();
    expect(
      ws.sent.filter(
        (f) => f.type === 'ask_user_started' && String(f.tool_call_id).startsWith('pvr-')
      )
    ).toHaveLength(0);
    expect(autoResolveWrite).not.toHaveBeenCalled();
  });

  test('a structurally complete FRESH reading as the direct answer does NOT engage the flow (belt-and-braces refusal)', async () => {
    const session = buildSession({ activeTurnTranscript: 'blah 26 milliseconds' });
    const pendingAsks = createPendingAsksRegistry();
    const autoResolveWrite = jest.fn().mockResolvedValue({ ok: true });
    const dispatcher = createAskDispatcher(session, noopLogger(), 't', pendingAsks, makeWs(), {
      autoResolveWrite,
    });
    const p = dispatcher({ tool_call_id: 'toolu_s', name: 'ask_user', input: noneAsk() }, {});
    await tick();
    pendingAsks.resolve('toolu_s', { answered: true, user_text: 'Zs circuit 4 is 0.30' });
    const env = await p;
    const body = JSON.parse(env.content);
    // Falls to the legacy body — Sonnet sees the quoted speech; the captured
    // 26ms is NOT joined to measured_zs_ohm.
    expect(body.match_status).toBeUndefined();
    expect(autoResolveWrite).not.toHaveBeenCalled();
  });
});
