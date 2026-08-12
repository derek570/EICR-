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
    // F7 Item 2 step 3b — a closed/null ws now FAST-FAILS the ask (register +
    // immediate resolve), so use an OPEN ws to keep the entry pending long
    // enough to inspect its captured pendingValue.
    const openWs = { readyState: 1, OPEN: 1, send() {} };
    const dispatcher = createAskDispatcher(
      session,
      noopLogger(),
      'turn-24',
      pendingAsks,
      openWs,
      {}
    );
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
    // F7 Item 2 step 3b — open ws so the ask stays pending for inspection.
    const openWs = { readyState: 1, OPEN: 1, send() {} };
    const dispatcher = createAskDispatcher(
      session,
      noopLogger(),
      'turn-1',
      pendingAsks,
      openWs,
      {}
    );
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
    expect(session.pendingVoicePrompts[0]).toMatchObject({
      promptKind: 'pending_value_terminal',
      pendingField: null,
      pendingValue: '26',
      pendingCircuit: 2,
      pendingBoardId: null,
    });
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

  test('r5-#1 shape (4): ELIGIBLE ask, NULL capture, unrecognisable reply → terminal apology, never the legacy resolver', async () => {
    // Transcript has no numeric (capture correctly declined) and the reply
    // resolves no field name. Before r5-#1 the engagement guard returned
    // null here and the answer fell to the model-dependent legacy body —
    // recreating beep-then-silence for exactly the "neither value nor
    // field" case the plan pins to the mandatory apology.
    const session = buildSession({ activeTurnTranscript: 'something garbled entirely' });
    const pendingAsks = createPendingAsksRegistry();
    const ws = makeWs();
    const autoResolveWrite = jest.fn().mockResolvedValue({ ok: true });
    const dispatcher = createAskDispatcher(session, noopLogger(), 't', pendingAsks, ws, {
      autoResolveWrite,
    });
    const p = dispatcher(
      {
        tool_call_id: 'toolu_s4',
        name: 'ask_user',
        // Numeric-free question — the default fixture question carries
        // "26 milliseconds", which the question-fallback capture would
        // pick up and turn this into shape (1) instead of shape (4).
        input: noneAsk({ question: 'Which reading was that for?' }),
      },
      {}
    );
    await tick();
    pendingAsks.resolve('toolu_s4', { answered: true, user_text: 'erm not sure honestly' });
    const env = await p;
    const body = JSON.parse(env.content);
    expect(body.match_status).toBe('pending_value_failed');
    expect(session.pendingVoicePrompts).toHaveLength(1); // ONE terminal voice prompt
    expect(autoResolveWrite).not.toHaveBeenCalled();
  });

  test('r3-#3: broker with a CLOSED socket → question never emitted → terminal apology, never a silent move-on', async () => {
    const session = buildSession({ activeTurnTranscript: 'blah 26 milliseconds' });
    const pendingAsks = createPendingAsksRegistry();
    // F7 Item 2 step 3b — the INITIAL ask on a closed socket now fast-fails
    // before the pending-value flow can engage. To still exercise the BROKER's
    // closed-socket path, the socket is OPEN for the initial send and CLOSES
    // right after (send flips readyState), so the initial ask emits + is
    // answered, then the broker FIELD ask hits the now-closed socket →
    // broker_emit_failed → terminal apology.
    const closingWs = {
      readyState: 1,
      OPEN: 1,
      sent: [],
      send() {
        this.readyState = 3;
      },
    };
    const autoResolveWrite = jest.fn().mockResolvedValue({ ok: true });
    const dispatcher = createAskDispatcher(session, noopLogger(), 't', pendingAsks, closingWs, {
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
          // The REAL no-CPC ask is prompt-mandated `reason: missing_context`
          // (sonnet_agentic_system.md NO-CPC rule) — NOT the missing_field
          // family — so it is not pending-value ELIGIBLE. Codex r5-#1 made
          // eligible+unrecognisable asks terminal-apologise, so this fixture
          // must carry the accurate wire shape to keep pinning the legacy
          // fall-through.
          reason: 'missing_context',
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

  // DISPOSITION PIN — a plausible-sounding wrong-write, found NOT to be one;
  // this test is what keeps it that way.
  //
  // The claim: "main earth is 0.35 ohms" is detected by detectStructuredReading
  // as field `earthing_conductor_csa` (a SUPPLY-family cross-section field), so
  // consuming it as an ask answer would write an impedance into a CSA field and
  // read it back — silently wrong, on a circuit it was never about.
  //
  // Why it does not reach production: the detector's field label is only ever
  // used as a BOOLEAN "is this a fresh structured reading?" guard — no consumer
  // writes from `structured.fieldKey`. Here that guard makes the chain REFUSE
  // the answer outright, so the deterministic write path is never entered and
  // the utterance goes to the model, where the main-earth §4 precedence ladder
  // routes ohms-on-main-earth to Ze. Reaching the writer requires hand-building
  // a registry entry and calling past this gate — not a real reachable path.
  //
  // Three assertions, deliberately: the refusal itself, that the mis-labelled
  // CSA field never appears in what is dispatched, AND (ep-diff-review cycle-1
  // NIT) that the reply text itself survives into the tool-result body as
  // `untrusted_user_text` — the DISPATCHER-level guarantee that the reply is
  // forwarded rather than silently dropped (whether the surrounding tool loop
  // then relays that tool_result to the model is the Anthropic tool-use
  // protocol's own structural guarantee, not something this unit re-proves).
  // Without this third assertion the test would pass identically even if the
  // reply were silently dropped instead of forwarded, which is exactly the
  // failure mode Audio-First #1 exists to catch. If a future refactor makes
  // the detector's field
  // authoritative, the second assertion is what fails; if a future refactor
  // drops the reply instead of forwarding it, the third assertion is what
  // fails.
  test.each([
    'main earth is 0.35 ohms',
    'main earth 0.35 ohms',
    'the main earth is 0.35',
    'main earthing conductor is 16',
  ])('main-earth reply %j never reaches the deterministic writer', async (reply) => {
    const session = buildSession({ activeTurnTranscript: 'blah 26 milliseconds' });
    const pendingAsks = createPendingAsksRegistry();
    const autoResolveWrite = jest.fn().mockResolvedValue({ ok: true });
    const dispatcher = createAskDispatcher(session, noopLogger(), 't', pendingAsks, makeWs(), {
      autoResolveWrite,
    });
    const p = dispatcher({ tool_call_id: 'toolu_e', name: 'ask_user', input: noneAsk() }, {});
    await tick();
    pendingAsks.resolve('toolu_e', { answered: true, user_text: reply });
    const env = await p;
    const body = JSON.parse(env.content);

    expect(body.match_status).toBeUndefined();
    expect(autoResolveWrite).not.toHaveBeenCalled();
    expect(JSON.stringify(body)).not.toContain('earthing_conductor_csa');
    expect(body.untrusted_user_text).toBe(reply);
  });
});

// ---------------------------------------------------------------------------
// Group 3 (feedback id 114, 2026-08-12) — the pending-value DECLINE branch.
//
// "Don't worry." (twice) was treated as a failed field-name answer → brokered
// re-ask → terminal apology → model re-ask → fresh chain. The chain now
// terminates resolved-declined at the initial ask AND at every brokered
// outcome, SILENTLY (the P4 answered-ask ack net is the sole spoken-ack
// producer), and a generation-scoped declined-pending fingerprint
// short-circuits same-generation model retries pre-registration.
//
// These are the pre-drain unit tests: session.pendingVoicePrompts is asserted
// EMPTY (the chain must never queue decline speech; the apology is the
// pre-fix bug). The exactly-one-spoken-ack observable lives in the
// production-ingress suite (stage6-pending-value-decline-ingress.test.js).
// ---------------------------------------------------------------------------

describe('group 3 — whole-reply decline resolves the chain silently (id 114)', () => {
  const expectSilentDecline = (env, session, autoResolveWrite, ws) => {
    const body = JSON.parse(env.content);
    expect(body).toMatchObject({
      answered: true,
      auto_resolved: false,
      match_status: 'user_declined',
    });
    // Dropped, not dispatched — and never deletes anything either.
    expect(autoResolveWrite).not.toHaveBeenCalled();
    // The chain queued NO speech of its own (no apology, no ack — P4 owns
    // the ack). This is the transient-queue assertion, pre-drain.
    expect(session.pendingVoicePrompts ?? []).toHaveLength(0);
    // No FURTHER broker ask after the decline.
    return ws.sent.filter(
      (f) => f.type === 'ask_user_started' && String(f.tool_call_id).startsWith('pvr-')
    );
  };

  test('decline at the INITIAL pending-value ask ("Don\'t worry.") → user_declined, no broker, no apology, no write', async () => {
    const session = buildSession({ activeTurnTranscript: 'blah 26 milliseconds' });
    const pendingAsks = createPendingAsksRegistry();
    const ws = makeWs();
    const autoResolveWrite = jest.fn().mockResolvedValue({ ok: true });
    const dispatcher = createAskDispatcher(session, noopLogger(), 't', pendingAsks, ws, {
      autoResolveWrite,
    });
    const p = dispatcher({ tool_call_id: 'toolu_d1', name: 'ask_user', input: noneAsk() }, {});
    await tick();
    pendingAsks.resolve('toolu_d1', { answered: true, user_text: "Don't worry." });
    const env = await p;
    const brokered = expectSilentDecline(env, session, autoResolveWrite, ws);
    expect(brokered).toHaveLength(0);
  });

  test('decline at the brokered FIELD ask → chain terminates resolved-declined, never the apology', async () => {
    const session = buildSession({ activeTurnTranscript: 'blah 26 milliseconds' });
    const pendingAsks = createPendingAsksRegistry();
    const ws = makeWs();
    const autoResolveWrite = jest.fn().mockResolvedValue({ ok: true });
    const dispatcher = createAskDispatcher(session, noopLogger(), 't', pendingAsks, ws, {
      autoResolveWrite,
    });
    const p = dispatcher({ tool_call_id: 'toolu_d2', name: 'ask_user', input: noneAsk() }, {});
    await tick();
    pendingAsks.resolve('toolu_d2', { answered: true, user_text: 'erm the auto feature thing' });
    await tick();
    const started = ws.sent.filter(
      (f) => f.type === 'ask_user_started' && String(f.tool_call_id).startsWith('pvr-')
    );
    expect(started).toHaveLength(1);
    pendingAsks.resolve(started[0].tool_call_id, { answered: true, user_text: "Don't worry." });
    const env = await p;
    const brokered = expectSilentDecline(env, session, autoResolveWrite, ws);
    expect(brokered).toHaveLength(1); // only the pre-decline field ask
  });

  test('decline at the brokered VALUE ask ("Doesn\'t matter.") → declined, NOT the cancel/moved-on path', async () => {
    // No capturable value anywhere → shape 2 (value ask) after the field
    // resolves. "Doesn't matter" is ALSO a CANCEL_PHRASE now; the chain's
    // decline check must win so the P4 ack (not silence) covers the turn.
    const session = buildSession({ activeTurnTranscript: null });
    const pendingAsks = createPendingAsksRegistry();
    const ws = makeWs();
    const autoResolveWrite = jest.fn().mockResolvedValue({ ok: true });
    const dispatcher = createAskDispatcher(session, noopLogger(), 't', pendingAsks, ws, {
      autoResolveWrite,
    });
    const p = dispatcher(
      {
        tool_call_id: 'toolu_d3',
        name: 'ask_user',
        input: noneAsk({ question: 'Which reading was that for?' }),
      },
      {}
    );
    await tick();
    pendingAsks.resolve('toolu_d3', { answered: true, user_text: 'RCD trip time.' });
    await tick();
    const started = ws.sent.filter(
      (f) => f.type === 'ask_user_started' && String(f.tool_call_id).startsWith('pvr-')
    );
    expect(started).toHaveLength(1);
    expect(started[0].expected_answer_shape).toBe('number');
    pendingAsks.resolve(started[0].tool_call_id, { answered: true, user_text: "Doesn't matter." });
    const env = await p;
    expectSilentDecline(env, session, autoResolveWrite, ws);
    const body = JSON.parse(env.content);
    expect(body.match_status).toBe('user_declined'); // never pending_value_unresolved
  });

  test('decline at the brokered CIRCUIT ask → declined, captured value dropped', async () => {
    const session = buildSession({ activeTurnTranscript: 'trip time 26 milliseconds somewhere' });
    const pendingAsks = createPendingAsksRegistry();
    const ws = makeWs();
    const autoResolveWrite = jest.fn().mockResolvedValue({ ok: true });
    const dispatcher = createAskDispatcher(session, noopLogger(), 't', pendingAsks, ws, {
      autoResolveWrite,
    });
    const p = dispatcher(
      { tool_call_id: 'toolu_d4', name: 'ask_user', input: noneAsk({ context_circuit: null }) },
      {}
    );
    await tick();
    pendingAsks.resolve('toolu_d4', { answered: true, user_text: 'RCD trip time' });
    await tick();
    const started = ws.sent.filter(
      (f) => f.type === 'ask_user_started' && String(f.tool_call_id).startsWith('pvr-')
    );
    expect(started).toHaveLength(1);
    expect(started[0].expected_answer_shape).toBe('circuit_ref');
    pendingAsks.resolve(started[0].tool_call_id, { answered: true, user_text: "Don't worry." });
    const env = await p;
    expectSilentDecline(env, session, autoResolveWrite, ws);
  });

  test('decline phrase + substantive continuation is NOT a decline (whole-reply anchoring)', async () => {
    const session = buildSession({ activeTurnTranscript: 'blah 26 milliseconds' });
    const pendingAsks = createPendingAsksRegistry();
    const ws = makeWs();
    const autoResolveWrite = jest.fn().mockResolvedValue({ ok: true });
    const dispatcher = createAskDispatcher(session, noopLogger(), 't', pendingAsks, ws, {
      autoResolveWrite,
    });
    const p = dispatcher({ tool_call_id: 'toolu_d5', name: 'ask_user', input: noneAsk() }, {});
    await tick();
    // A continuation-bearing reply is NOT declined — the chain processes it
    // normally (here: the sentence resolves no field name, so shape 1
    // brokers the ordinary FIELD ask instead of terminating declined).
    pendingAsks.resolve('toolu_d5', {
      answered: true,
      user_text: "don't worry about the RCD yet, next is the sockets reading",
    });
    await tick();
    const started = ws.sent.filter(
      (f) => f.type === 'ask_user_started' && String(f.tool_call_id).startsWith('pvr-')
    );
    expect(started).toHaveLength(1); // brokered — NOT short-circuited as a decline
    pendingAsks.resolve(started[0].tool_call_id, { answered: true, user_text: 'RCD trip time' });
    const env = await p;
    const body = JSON.parse(env.content);
    expect(body.match_status).toBe('pending_value_resolved');
    expect(autoResolveWrite).toHaveBeenCalledWith(
      expect.objectContaining({ field: 'rcd_time_ms', circuit: 2, value: '26' }),
      expect.anything()
    );
  });
});

describe('group 3 — declined-pending fingerprint short-circuits same-generation retries (id 114)', () => {
  async function declineInitial(dispatcher, pendingAsks, toolCallId = 'toolu_fp1') {
    const p = dispatcher({ tool_call_id: toolCallId, name: 'ask_user', input: noneAsk() }, {});
    await tick();
    pendingAsks.resolve(toolCallId, { answered: true, user_text: "Don't worry." });
    return p;
  }

  test('model retries the same ask in the SAME generation → suppressed pre-registration: no emit, no registry entry, no onAskAnswered', async () => {
    const session = buildSession({ activeTurnTranscript: 'blah 26 milliseconds' });
    const logger = noopLogger();
    const pendingAsks = createPendingAsksRegistry();
    const ws = makeWs();
    const onAskAnswered = jest.fn();
    const autoResolveWrite = jest.fn().mockResolvedValue({ ok: true });
    const dispatcher = createAskDispatcher(session, logger, 't', pendingAsks, ws, {
      autoResolveWrite,
      onAskAnswered,
    });
    await declineInitial(dispatcher, pendingAsks);
    expect(onAskAnswered).toHaveBeenCalledTimes(1);
    const askFramesBefore = ws.sent.filter((f) => f.type === 'ask_user_started').length;

    // The retry: same inverted shape, same transcript-captured value.
    const env2 = await dispatcher(
      { tool_call_id: 'toolu_fp2', name: 'ask_user', input: noneAsk() },
      {}
    );
    const body2 = JSON.parse(env2.content);
    expect(body2).toMatchObject({
      answered: false,
      reason: 'user_declined',
      match_status: 'user_declined',
    });
    // Structurally cannot double-ack: no new emission, no registration, no
    // resolution-time observer call for the suppressed repeat.
    expect(ws.sent.filter((f) => f.type === 'ask_user_started')).toHaveLength(askFramesBefore);
    expect(Array.from(pendingAsks.entries())).toHaveLength(0);
    expect(onAskAnswered).toHaveBeenCalledTimes(1);
    // The canonical ask row logs user_moved_on with the user_declined diag.
    const suppressed = logger.info.mock.calls.filter(
      ([ev]) => ev === 'stage6.pending_value_reask_suppressed'
    );
    expect(suppressed).toHaveLength(1);
    const askRows = logger.info.mock.calls.filter(
      ([ev, row]) => ev === 'stage6.ask_user' && row.tool_call_id === 'toolu_fp2'
    );
    expect(askRows).toHaveLength(1);
    expect(askRows[0][1]).toMatchObject({
      answer_outcome: 'user_moved_on',
      dispatcher_error: 'user_declined',
    });
  });

  test('pending_write representation of the same operation ALSO matches (numeric normalisation included)', async () => {
    const session = buildSession({ activeTurnTranscript: 'blah 26 milliseconds' });
    const pendingAsks = createPendingAsksRegistry();
    const ws = makeWs();
    const dispatcher = createAskDispatcher(session, noopLogger(), 't', pendingAsks, ws, {
      autoResolveWrite: jest.fn().mockResolvedValue({ ok: true }),
    });
    await declineInitial(dispatcher, pendingAsks);
    // Retry re-shaped as a fully-formed pending_write ask; value '26.0'
    // normalises to the fingerprint's '26'.
    const env2 = await dispatcher(
      {
        tool_call_id: 'toolu_fp3',
        name: 'ask_user',
        input: {
          question: 'Which circuit is that 26 for?',
          reason: 'missing_context',
          context_field: 'rcd_time_ms',
          context_circuit: null,
          expected_answer_shape: 'circuit_ref',
          pending_write: {
            tool: 'record_reading',
            field: 'rcd_time_ms',
            value: '26.0',
            confidence: 0.9,
            source_turn_id: 't-retry',
          },
        },
      },
      {}
    );
    expect(JSON.parse(env2.content).match_status).toBe('user_declined');
  });

  test('a reformatted equivalent ask matches after a FIELD-known decline (same canonical field, different reason/shape)', async () => {
    // Decline at the brokered VALUE ask records fp {field: rcd_time_ms,
    // circuit: 2}. (The wire spelling `rcd_trip_time` is enum-blocked at
    // validateAskUser today, so the canonicaliser's alias fold is
    // defence-in-depth; the representable reformat is reason/shape drift.)
    const session = buildSession({ activeTurnTranscript: null });
    const pendingAsks = createPendingAsksRegistry();
    const ws = makeWs();
    const dispatcher = createAskDispatcher(session, noopLogger(), 't', pendingAsks, ws, {
      autoResolveWrite: jest.fn().mockResolvedValue({ ok: true }),
    });
    const p = dispatcher(
      {
        tool_call_id: 'toolu_fa1',
        name: 'ask_user',
        input: noneAsk({ question: 'Which reading was that for?' }),
      },
      {}
    );
    await tick();
    pendingAsks.resolve('toolu_fa1', { answered: true, user_text: 'RCD trip time.' });
    await tick();
    const started = ws.sent.filter(
      (f) => f.type === 'ask_user_started' && String(f.tool_call_id).startsWith('pvr-')
    );
    pendingAsks.resolve(started[0].tool_call_id, { answered: true, user_text: "Don't worry." });
    await p;
    // Retry: an ordinary field-known VALUE ask about the SAME field.
    const env2 = await dispatcher(
      {
        tool_call_id: 'toolu_fa2',
        name: 'ask_user',
        input: noneAsk({
          context_field: 'rcd_time_ms',
          reason: 'missing_value',
          expected_answer_shape: 'number',
        }),
      },
      {}
    );
    expect(JSON.parse(env2.content).match_status).toBe('user_declined');
  });

  test('conflicting known components do NOT match — a different value registers normally', async () => {
    const session = buildSession({ activeTurnTranscript: 'blah 26 milliseconds' });
    const pendingAsks = createPendingAsksRegistry();
    const ws = makeWs();
    const dispatcher = createAskDispatcher(session, noopLogger(), 't', pendingAsks, ws, {
      autoResolveWrite: jest.fn().mockResolvedValue({ ok: true }),
    });
    await declineInitial(dispatcher, pendingAsks);
    const askFramesBefore = ws.sent.filter((f) => f.type === 'ask_user_started').length;
    // A genuinely different operation: different value, different field.
    const p2 = dispatcher(
      {
        tool_call_id: 'toolu_cf1',
        name: 'ask_user',
        input: {
          question: 'Which circuit is that 0.3 for?',
          reason: 'missing_context',
          context_field: 'measured_zs_ohm',
          context_circuit: null,
          expected_answer_shape: 'circuit_ref',
          pending_write: {
            tool: 'record_reading',
            field: 'measured_zs_ohm',
            value: '0.3',
            confidence: 0.9,
            source_turn_id: 't-diff',
          },
        },
      },
      {}
    );
    await tick();
    // NOT suppressed: it registered and emitted.
    expect(ws.sent.filter((f) => f.type === 'ask_user_started').length).toBe(askFramesBefore + 1);
    pendingAsks.resolve('toolu_cf1', { answered: false, reason: 'timeout' });
    await p2;
  });

  test('disjoint partial fingerprints do NOT match — {value:26} never suppresses a field-only ask', async () => {
    const session = buildSession({ activeTurnTranscript: 'blah 26 milliseconds' });
    const pendingAsks = createPendingAsksRegistry();
    const ws = makeWs();
    const dispatcher = createAskDispatcher(session, noopLogger(), 't', pendingAsks, ws, {
      autoResolveWrite: jest.fn().mockResolvedValue({ ok: true }),
    });
    await declineInitial(dispatcher, pendingAsks);
    const askFramesBefore = ws.sent.filter((f) => f.type === 'ask_user_started').length;
    // Knows only a FIELD (no value, no pending_write) — no overlap with
    // the {value:26, circuit:2} fingerprint.
    const p2 = dispatcher(
      {
        tool_call_id: 'toolu_dj1',
        name: 'ask_user',
        input: noneAsk({ context_field: 'measured_zs_ohm', reason: 'missing_value' }),
      },
      {}
    );
    await tick();
    expect(ws.sent.filter((f) => f.type === 'ask_user_started').length).toBe(askFramesBefore + 1);
    pendingAsks.resolve('toolu_dj1', { answered: false, reason: 'timeout' });
    await p2;
  });

  test('next-turn fresh utterance is unaffected — a NEW dispatcher instance carries no fingerprints', async () => {
    const session = buildSession({ activeTurnTranscript: 'blah 26 milliseconds' });
    const pendingAsks = createPendingAsksRegistry();
    const ws = makeWs();
    const opts = { autoResolveWrite: jest.fn().mockResolvedValue({ ok: true }) };
    const dispatcher1 = createAskDispatcher(session, noopLogger(), 't1', pendingAsks, ws, opts);
    await declineInitial(dispatcher1, pendingAsks);
    // The next turn builds a FRESH dispatcher (per-generation instance).
    const dispatcher2 = createAskDispatcher(session, noopLogger(), 't2', pendingAsks, ws, opts);
    const askFramesBefore = ws.sent.filter((f) => f.type === 'ask_user_started').length;
    const p2 = dispatcher2({ tool_call_id: 'toolu_nt1', name: 'ask_user', input: noneAsk() }, {});
    await tick();
    // Registers + emits normally — the decline died with its generation.
    expect(ws.sent.filter((f) => f.type === 'ask_user_started').length).toBe(askFramesBefore + 1);
    pendingAsks.resolve('toolu_nt1', { answered: false, reason: 'timeout' });
    await p2;
  });
});
