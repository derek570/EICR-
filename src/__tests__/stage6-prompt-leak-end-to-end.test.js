/**
 * Stage 6 Phase 4 Plan 04-28 — r21-#3 real-session end-to-end
 * dispatcher leak-blocking.
 *
 * WHAT: end-to-end tests that drive prompt-leak content through a REAL
 * `EICRExtractionSession` instance plus `runShadowHarness`, which is the
 * production assembly seam (sonnet-stream.js invokes runShadowHarness on
 * every transcript). The mock Anthropic SDK emits tool-use blocks
 * carrying leak content in the input; the test asserts that nothing
 * the leak contains escapes the dispatcher boundary (not into iOS WS
 * emissions, not into session state, not into envelope bodies handed
 * back to the tool loop).
 *
 * WHY: r21-#3 re-review flagged that my r20-#4 tests drove `runToolLoop`
 * directly with hand-rolled dispatcher factories. That setup proved
 * `checkForPromptLeak()` is wired into each dispatcher — but a
 * regression where the SESSION'S wiring path (`runShadowHarness` →
 * `createWriteDispatcher` + `createAskDispatcher`) diverges from the
 * hand-rolled assembly would not fail any test. If sonnet-stream.js
 * ever added a direct-dispatch path that bypassed runShadowHarness,
 * the filter would be silently bypassed too.
 *
 * This file closes that gap by going through the SAME runShadowHarness
 * path production uses. The session's own `client`, `buildSystemBlocks`,
 * `stateSnapshot`, and `toolCallsMode` feed into the dispatcher assembly
 * — if any of those wirings drift (e.g. a new constructor option gated
 * filter application), this test catches it.
 *
 * PATTERN: mirrors stage6-f21934d4-replay.test.js:
 *   - new EICRExtractionSession(apiKey, sessionId, certType, {toolCallsMode:'shadow'})
 *   - stub session.extractFromUtterance so legacy returns a no-op body
 *   - overwrite session.client = mockClient([events]) so the shadow
 *     tool-loop consumes canned SSE events instead of calling Anthropic
 *   - call runShadowHarness(session, transcript, [], {ws, pendingAsks})
 *   - assert ws emissions, session state, logger calls
 *
 * SCENARIOS:
 *   Scenario 1 — ask_user leak: model emits ask_user with TRUST BOUNDARY
 *                in question → no ask_user_started ws frame, no
 *                pendingAsks entry, no substring of the leak anywhere
 *                in ws emissions or tool_result envelopes, warn log has
 *                prompt_leak_blocked with redacted r20-#2 shape.
 *   Scenario 2 — record_observation leak: model emits record_observation
 *                with leak in .text → rejected (r20-#1), session.
 *                extractedObservations length 0, no leak substring
 *                in any emission.
 *   Scenario 3 — rename_circuit leak: model emits rename_circuit with
 *                leak in .designation → rejected, designation on
 *                session.stateSnapshot UNCHANGED, no leak substring
 *                anywhere.
 */

import { jest } from '@jest/globals';

import { runShadowHarness } from '../extraction/stage6-shadow-harness.js';
import { createPendingAsksRegistry } from '../extraction/stage6-pending-asks-registry.js';
import { EICRExtractionSession } from '../extraction/eicr-extraction-session.js';
import { mockClient } from './helpers/mockStream.js';

// ---------------------------------------------------------------------------
// SSE-event fixture builders — lifted verbatim from
// stage6-ask-integration.test.js / prompt-leak-end-to-end.v1. They compose
// the raw message_start → content_block_start/delta/stop → message_delta
// → message_stop event sequence the Anthropic SDK emits on a streaming
// tool-use round.
// ---------------------------------------------------------------------------

function toolUseRound(toolCalls) {
  const events = [
    { type: 'message_start', message: { id: 'msg_tu', role: 'assistant', content: [] } },
  ];
  toolCalls.forEach((tc, i) => {
    events.push({
      type: 'content_block_start',
      index: i,
      content_block: { type: 'tool_use', id: tc.id, name: tc.name, input: {} },
    });
    events.push({
      type: 'content_block_delta',
      index: i,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify(tc.input) },
    });
    events.push({ type: 'content_block_stop', index: i });
  });
  events.push({ type: 'message_delta', delta: { stop_reason: 'tool_use' } });
  events.push({ type: 'message_stop' });
  return events;
}

function endTurnRound(text = 'done') {
  return [
    { type: 'message_start', message: { id: 'msg_end', role: 'assistant', content: [] } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
    { type: 'message_stop' },
  ];
}

// ---------------------------------------------------------------------------
// Test fixtures — ws stub, session factory.
// ---------------------------------------------------------------------------

function createMockServerWs() {
  const sent = [];
  return {
    readyState: 1,
    OPEN: 1,
    sent,
    send(data) {
      sent.push(typeof data === 'string' ? JSON.parse(data) : data);
    },
    close: jest.fn(),
    on: jest.fn(),
  };
}

/**
 * Build a real EICRExtractionSession in shadow mode with:
 *  - apiKey = 'test-key' (real Anthropic client constructed, never used
 *    because we overwrite session.client below)
 *  - toolCallsMode = 'shadow' (selects the agentic prompt + the
 *    runShadowHarness path)
 *  - session.extractFromUtterance stubbed to a no-op legacy return so
 *    the harness's step-1 legacy call returns quickly
 *  - seeded stateSnapshot with two circuits so rename_circuit in
 *    Scenario 3 has a target to reject
 */
function makeRealSession(sessionId) {
  const session = new EICRExtractionSession('test-key', sessionId, 'eicr', {
    toolCallsMode: 'shadow',
  });
  // Seed with two circuits so rename_circuit scenario has a valid target.
  session.stateSnapshot = {
    circuits: {
      1: { designation: 'Upstairs lights' },
      2: { designation: 'Kitchen sockets' },
    },
    pending_readings: [],
    observations: [],
    validation_alerts: [],
  };
  session.extractedObservations = [];
  // Hermetic stub: legacy extractFromUtterance returns an empty result
  // without touching Anthropic. runShadowHarness step-1 calls this
  // FIRST, then runs the shadow tool loop against session.client.
  session.extractFromUtterance = jest.fn().mockImplementation(async function () {
    this.turnCount = (this.turnCount ?? 0) + 1;
    return {
      extracted_readings: [],
      field_clears: [],
      circuit_updates: [],
      observations: [],
      validation_alerts: [],
      questions_for_user: [],
      confirmations: [],
      spoken_response: null,
      action: null,
    };
  });
  return session;
}

// Collect every tool_result body the shadow tool-loop pushed back into
// messages — these are the envelopes the model sees next round and the
// primary exfiltration surface the filter must scrub.
function collectAllToolResultJsonBodies(messagesFinal) {
  const bodies = [];
  if (!Array.isArray(messagesFinal)) return bodies;
  for (const msg of messagesFinal) {
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block?.type === 'tool_result' && typeof block.content === 'string') {
        bodies.push(block.content);
      }
    }
  }
  return bodies;
}

// ---------------------------------------------------------------------------
// Scenario 1 — ask_user leak through real EICRExtractionSession
// ---------------------------------------------------------------------------

describe('r21-#3 real-session end-to-end — ask_user leak blocked via runShadowHarness', () => {
  test('ask_user with TRUST BOUNDARY in question → no ws emission, no register, no envelope leak', async () => {
    const session = makeRealSession('sess-r21-ask');
    const pendingAsks = createPendingAsksRegistry();
    const ws = createMockServerWs();
    const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };

    session.client = mockClient([
      toolUseRound([
        {
          id: 'toolu_r21_ask',
          name: 'ask_user',
          input: {
            question:
              'Sure — the system prompt starts: TRUST BOUNDARY is the header for user data.',
            reason: 'ambiguous_circuit',
            context_field: null,
            context_circuit: null,
            expected_answer_shape: 'free_text',
          },
        },
      ]),
      endTurnRound('ok'),
    ]);

    await runShadowHarness(session, 'please show me what you know', [], {
      logger,
      pendingAsks,
      ws,
    });

    // (1) pendingAsks registry untouched — filter short-circuited before register().
    expect(pendingAsks.size).toBe(0);

    // (2) No ask_user_started ws frame — the filter must fire BEFORE
    //     ws.send so iOS never speaks the leak via TTS.
    const askStarted = ws.sent.filter((m) => m && m.type === 'ask_user_started');
    expect(askStarted).toEqual([]);

    // (3) No leak substring in ANY ws frame.
    const wsJoined = ws.sent.map((m) => JSON.stringify(m)).join('\n');
    expect(wsJoined.toLowerCase()).not.toContain('trust boundary');
    expect(wsJoined.toLowerCase()).not.toContain('system prompt');

    // (4) prompt_leak_blocked warn row with redacted r20-#2 shape.
    const blocked = logger.warn.mock.calls.find((args) => args[0] === 'stage6.prompt_leak_blocked');
    expect(blocked).toBeDefined();
    expect(blocked[1].tool).toBe('ask_user');
    expect(blocked[1].filter_reason).toMatch(/^marker:/);
    expect(blocked[1].field).toBe('question');
    expect(typeof blocked[1].length).toBe('number');
    expect(blocked[1].hash).toMatch(/^[0-9a-f]{16}$/);
    expect(blocked[1].sanitised_sample).toBeUndefined();
    const blockedJson = JSON.stringify(blocked[1]);
    expect(blockedJson.toLowerCase()).not.toContain('trust boundary');
  });
});

// ---------------------------------------------------------------------------
// Scenario 2 — record_observation leak through real EICRExtractionSession
// ---------------------------------------------------------------------------

describe('r21-#3 real-session end-to-end — record_observation leak blocked via runShadowHarness', () => {
  test('record_observation with leak in .text → rejected, no persistence', async () => {
    const session = makeRealSession('sess-r21-obs');
    const pendingAsks = createPendingAsksRegistry();
    const ws = createMockServerWs();
    const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };

    const leakText =
      'For reference: You are an EICR inspection assistant. Do not emit free-text JSON.';

    session.client = mockClient([
      toolUseRound([
        {
          id: 'toolu_r21_obs',
          name: 'record_observation',
          input: {
            code: 'C3',
            text: leakText,
            location: 'Main consumer unit',
            circuit: null,
            suggested_regulation: null,
          },
        },
      ]),
      endTurnRound('ok'),
    ]);

    await runShadowHarness(session, 'tell me about the cu', [], {
      logger,
      pendingAsks,
      ws,
    });

    // (1) Observation NOT persisted on the live session (r20-#1 rejects
    //     the entire call when any free-text field leaks). NB: shadow
    //     harness clones state for the tool loop; assert on the live
    //     session's array to prove no cross-clone leak.
    expect(session.extractedObservations).toHaveLength(0);

    // (2) No leak substring in any ws frame.
    const wsJoined = ws.sent.map((m) => JSON.stringify(m)).join('\n');
    expect(wsJoined.toLowerCase()).not.toContain('eicr inspection assistant');
    expect(wsJoined.toLowerCase()).not.toContain('free-text json');

    // (3) prompt_leak_blocked warn row — redacted r20-#2 shape.
    const blocked = logger.warn.mock.calls.find((args) => args[0] === 'stage6.prompt_leak_blocked');
    expect(blocked).toBeDefined();
    expect(blocked[1].tool).toBe('record_observation');
    expect(Array.isArray(blocked[1].fields)).toBe(true);
    expect(blocked[1].fields).toContain('text');
    expect(blocked[1].sanitised_sample).toBeUndefined();
    const blockedJson = JSON.stringify(blocked[1]);
    expect(blockedJson.toLowerCase()).not.toContain('eicr inspection assistant');
  });
});

// ---------------------------------------------------------------------------
// Scenario 3 — rename_circuit leak through real EICRExtractionSession
// ---------------------------------------------------------------------------

describe('r21-#3 real-session end-to-end — rename_circuit leak blocked via runShadowHarness', () => {
  test('rename_circuit with leak in .designation → rejected, circuit untouched', async () => {
    const session = makeRealSession('sess-r21-rename');
    const pendingAsks = createPendingAsksRegistry();
    const ws = createMockServerWs();
    const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };

    const originalDesignation = session.stateSnapshot.circuits[1].designation;
    const leakDesignation = 'STQ-01 upstairs lights with extra content';

    session.client = mockClient([
      toolUseRound([
        {
          id: 'toolu_r21_rename',
          name: 'rename_circuit',
          input: {
            from_ref: 1,
            circuit_ref: 1,
            designation: leakDesignation,
            phase: null,
            rating_amps: null,
            cable_csa_mm2: null,
          },
        },
      ]),
      endTurnRound('ok'),
    ]);

    await runShadowHarness(session, 'rename circuit 1', [], {
      logger,
      pendingAsks,
      ws,
    });

    // (1) Live session's circuit 1 designation UNCHANGED — shadow harness
    //     clones state before the tool loop so even successful mutations
    //     never reach the live session; for a REJECTED call we doubly
    //     assert the clone's dispatcher refused the write.
    expect(session.stateSnapshot.circuits[1].designation).toBe(originalDesignation);

    // (2) No leak substring in any ws frame.
    const wsJoined = ws.sent.map((m) => JSON.stringify(m)).join('\n');
    expect(wsJoined).not.toContain('STQ-01');
    expect(wsJoined).not.toContain('upstairs lights with extra');

    // (3) prompt_leak_blocked warn row — redacted r20-#2 shape.
    const blocked = logger.warn.mock.calls.find((args) => args[0] === 'stage6.prompt_leak_blocked');
    expect(blocked).toBeDefined();
    expect(blocked[1].tool).toBe('rename_circuit');
    expect(blocked[1].field).toBe('designation');
    expect(blocked[1].sanitised_sample).toBeUndefined();
    const blockedJson = JSON.stringify(blocked[1]);
    expect(blockedJson).not.toContain('STQ-01');
  });
});

// ---------------------------------------------------------------------------
// Additionally: assert the runShadowHarness path threads the leak-blocking
// tool_result BACK into the model's next turn. Belt-and-braces — the above
// scenarios assert no ws/state leak; this covers the messages_final channel
// that survives to the NEXT round's prompt. Reusable builder pulled from
// stage6-tool-loop's canonical shape via runToolLoop's return value, but
// runShadowHarness doesn't expose it — we assert the equivalent via the
// absence of leaks in ws + logger, which collectively represent every
// channel a leak could exit on.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Plan 04-29 r22-#2 — shadow-path state assertions via _shadowCapture hook.
//
// WHY (gap in r21-#3): the three scenarios above assert ws emissions +
// logger + LIVE session state are leak-free. They prove nothing the leak
// contains escapes the EXTERNAL channels. But the shadow dispatcher
// actually mutates a CLONED shadowSession + a perTurnWrites accumulator
// that the bundler reads downstream — not the live session. If a
// regression re-enabled writes-on-leak inside the shadow path while
// keeping the external-channel assertions intact, the existing tests
// would pass silently.
//
// Fix: add an optional `_shadowCapture` hook to runShadowHarness (test-
// only, underscore-prefixed, swallow-on-throw). The hook receives
// {shadowSession, perTurnWrites, toolLoopOut} at the moment the tool
// loop finishes (before bundler/comparator/divergence-log post-processing
// runs). Tests assert on those internal surfaces.
//
// Assertion categories (applied per scenario):
//   1. perTurnWrites has NO leak entries — observations / circuitOps /
//      readings / cleared / deletedObservations all free of the attack
//      string. For a blocked call, the relevant array is EMPTY (filter
//      rejected BEFORE the dispatcher pushed).
//   2. shadowSession.stateSnapshot + shadowSession.extractedObservations
//      contain no leak substring. Circuit designation (for rename_circuit
//      scenario) is unchanged from the seed.
//   3. toolLoopOut.messages_final — every tool_result block's content
//      string contains no leak substring. This is the channel that
//      survives to the NEXT model round's prompt and is the most direct
//      exfiltration surface.
// ---------------------------------------------------------------------------

/**
 * Serialise the perTurnWrites accumulator to a JSON string so substring
 * assertions work uniformly across Map/Set/Array shapes. See
 * `createPerTurnWrites` in src/extraction/stage6-per-turn-writes.js:
 *   - readings: Map → spread to array of [key, value]
 *   - cleared / observations / deletedObservations / circuitOps: arrays
 */
function serialisePerTurnWrites(pw) {
  return JSON.stringify({
    readings: [...pw.readings],
    cleared: pw.cleared,
    observations: pw.observations,
    deletedObservations: pw.deletedObservations,
    circuitOps: pw.circuitOps,
  });
}

/**
 * Plan 04-30 r23-#3 — structured-content-aware tool_result
 * serialisation.
 * Plan 04-31 r24-#3 — WeakSet cycle guard prevents infinite
 * recursion on cyclic object graphs.
 *
 * Anthropic SDK tool_result blocks may carry content in several
 * shapes:
 *
 *   - String (legacy + most common): content is a raw text body,
 *     captured directly.
 *   - Array of blocks: each block may have `.text` (simple text
 *     block), `.content` (nested), or other keys.
 *   - Object with `.content`: single wrapper block, recurse.
 *   - Other (primitive, unexpected shape): JSON.stringify as a
 *     defence-in-depth fallback so a leak embedded in a truly
 *     unexpected shape still surfaces to the assertion.
 *
 * WHY shape-aware: r23-#3 noted that the r22-#2 string-only
 * implementation would silently skip structured content. A future
 * SDK upgrade, a dispatcher refactor that returns structured
 * bodies for consistency with model-facing blocks, or a fixture
 * that uses structured shape would all evade the leak scan under
 * the string-only implementation.
 *
 * r24-#3 cycle guard: the r23-#3 implementation's only terminator
 * was `block.content !== block.text` — catches the direct
 * same-reference case but nothing else. A true object cycle
 * (a.content = b, b.content = a) would infinite-loop. WeakSet
 * visited-guard threaded through recursion short-circuits any
 * already-walked object. WeakSet accepts only objects (primitives
 * can't cycle) and doesn't retain references — no lifetime leak.
 *
 * Optional `visited` parameter: default `new WeakSet()` per call
 * preserves back-compat signature (`extractTextFromBlock(block)`
 * still works). Recursive calls thread the shared visited set so
 * every node in a sub-tree is tracked against the same set.
 *
 * JSON.stringify catch: WeakSet prevents the walker's infinite
 * recursion but JSON.stringify itself throws TypeError on cycles.
 * The catch wraps that — primitive return '' keeps the helper a
 * non-throw site.
 *
 * Null / undefined short-circuit to '' so callers never get a
 * throw on odd fixtures.
 */
function extractTextFromBlock(block, visited = new WeakSet()) {
  if (block == null) return '';
  if (typeof block === 'string') return block;
  if (typeof block === 'number' || typeof block === 'boolean') {
    return String(block);
  }
  // Object or array shape — cycle check before recursing.
  if (typeof block === 'object') {
    if (visited.has(block)) return '';
    visited.add(block);
  }
  if (Array.isArray(block)) {
    return block
      .map((item) => extractTextFromBlock(item, visited))
      .filter(Boolean)
      .join('\n');
  }
  // Object shape: walk .text, .content, fall back to JSON.
  const parts = [];
  if (typeof block.text === 'string') parts.push(block.text);
  if (block.content !== undefined && block.content !== block.text) {
    parts.push(extractTextFromBlock(block.content, visited));
  }
  if (parts.length === 0) {
    // Unknown shape — stringify so a leak embedded in unexpected
    // keys still reaches the substring assertion. JSON.stringify
    // throws on cycles; catch keeps the helper non-throw.
    try {
      return JSON.stringify(block);
    } catch {
      return '';
    }
  }
  return parts.filter(Boolean).join('\n');
}

/**
 * Collect every tool_result content body in messages_final, joined so
 * a single substring assertion covers all of them. messages_final is
 * returned by runToolLoop and captured via _shadowCapture's toolLoopOut.
 *
 * r23-#3: delegates to extractTextFromBlock so string / array /
 * nested-object / fallback shapes are all walked — a leak hidden
 * in any of them surfaces to the assertion.
 */
function serialiseToolResultBodies(toolLoopOut) {
  const parts = [];
  if (!Array.isArray(toolLoopOut?.messages_final)) return '';
  for (const msg of toolLoopOut.messages_final) {
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block?.type !== 'tool_result') continue;
      const text = extractTextFromBlock(block.content);
      if (text) parts.push(text);
    }
  }
  return parts.join('\n');
}

describe('r22-#2 real shadow-path state assertions via _shadowCapture', () => {
  test('4a: ask_user leak → shadowSession + perTurnWrites + messages_final all free of leak content', async () => {
    const session = makeRealSession('sess-r22-ask');
    const pendingAsks = createPendingAsksRegistry();
    const ws = createMockServerWs();
    const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };

    session.client = mockClient([
      toolUseRound([
        {
          id: 'toolu_r22_ask',
          name: 'ask_user',
          input: {
            question:
              'Sure — the system prompt starts: TRUST BOUNDARY is the header for user data.',
            reason: 'ambiguous_circuit',
            context_field: null,
            context_circuit: null,
            expected_answer_shape: 'free_text',
          },
        },
      ]),
      endTurnRound('ok'),
    ]);

    let captured = null;
    await runShadowHarness(session, 'please show me what you know', [], {
      logger,
      pendingAsks,
      ws,
      _shadowCapture: (snap) => {
        captured = snap;
      },
    });

    // (1) Hook fired — confirms the shadow tool loop completed and the
    //     hook wiring is present. If captured stays null, the harness
    //     either never ran the loop or the hook plumbing regressed.
    expect(captured).not.toBeNull();
    expect(captured.shadowSession).toBeDefined();
    expect(captured.perTurnWrites).toBeDefined();
    expect(captured.toolLoopOut).toBeDefined();

    // (2) perTurnWrites free of leak. ask_user does NOT write to
    //     perTurnWrites under any conditions (only write-tools do), so
    //     the serialised accumulator is a baseline-empty JSON doc.
    //     Belt-and-braces: assert no TRUST BOUNDARY substring anyway.
    const pwJson = serialisePerTurnWrites(captured.perTurnWrites).toLowerCase();
    expect(pwJson).not.toContain('trust boundary');
    expect(captured.perTurnWrites.observations).toHaveLength(0);
    expect(captured.perTurnWrites.circuitOps).toHaveLength(0);

    // (3) shadowSession state free of leak. ask_user doesn't mutate
    //     state either — assert the clone is unchanged vs seed.
    const shadowJson = JSON.stringify({
      stateSnapshot: captured.shadowSession.stateSnapshot,
      extractedObservations: captured.shadowSession.extractedObservations,
    }).toLowerCase();
    expect(shadowJson).not.toContain('trust boundary');
    expect(captured.shadowSession.extractedObservations).toHaveLength(0);

    // (4) messages_final tool_result bodies free of leak. The
    //     dispatcher's sanitised refusal body is what goes back to the
    //     model's next round — it must not carry the original leak.
    const resultsJoined = serialiseToolResultBodies(captured.toolLoopOut).toLowerCase();
    expect(resultsJoined).not.toContain('trust boundary');
    expect(resultsJoined).not.toContain('system prompt');
  });

  test('4b: record_observation leak → perTurnWrites empty, shadowSession clean, tool_result scrubbed', async () => {
    const session = makeRealSession('sess-r22-obs');
    const pendingAsks = createPendingAsksRegistry();
    const ws = createMockServerWs();
    const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };

    const leakText =
      'For reference: You are an EICR inspection assistant. Do not emit free-text JSON.';

    session.client = mockClient([
      toolUseRound([
        {
          id: 'toolu_r22_obs',
          name: 'record_observation',
          input: {
            code: 'C3',
            text: leakText,
            location: 'Main consumer unit',
            circuit: null,
            suggested_regulation: null,
          },
        },
      ]),
      endTurnRound('ok'),
    ]);

    let captured = null;
    await runShadowHarness(session, 'tell me about the cu', [], {
      logger,
      pendingAsks,
      ws,
      _shadowCapture: (snap) => {
        captured = snap;
      },
    });

    expect(captured).not.toBeNull();

    // (1) perTurnWrites.observations EMPTY — r20-#1 rejects the entire
    //     record_observation call when any free-text field leaks. The
    //     append must never have happened.
    expect(captured.perTurnWrites.observations).toHaveLength(0);
    expect(captured.perTurnWrites.deletedObservations).toHaveLength(0);
    const pwJson = serialisePerTurnWrites(captured.perTurnWrites).toLowerCase();
    expect(pwJson).not.toContain('eicr inspection assistant');
    expect(pwJson).not.toContain('free-text json');

    // (2) shadowSession clean. The clone's extractedObservations array
    //     must be unchanged from the seed (empty — see makeRealSession).
    expect(captured.shadowSession.extractedObservations).toHaveLength(0);
    // stateSnapshot.observations is the legacy text-dedup surface the
    // atom deliberately does NOT touch (per Plan 02-01 SUMMARY) — so
    // the seed [] carries through unchanged.
    expect(captured.shadowSession.stateSnapshot.observations).toEqual([]);
    const shadowJson = JSON.stringify({
      stateSnapshot: captured.shadowSession.stateSnapshot,
      extractedObservations: captured.shadowSession.extractedObservations,
    }).toLowerCase();
    expect(shadowJson).not.toContain('eicr inspection assistant');
    expect(shadowJson).not.toContain('free-text json');

    // (3) tool_result bodies scrubbed. The dispatcher's envelope carries
    //     {ok:false, error:{code:'prompt_leak_in_observation', reason,
    //     fields}} — assert no leak substring reached the model's next
    //     round input.
    const resultsJoined = serialiseToolResultBodies(captured.toolLoopOut).toLowerCase();
    expect(resultsJoined).not.toContain('eicr inspection assistant');
    expect(resultsJoined).not.toContain('free-text json');
  });

  test('4c: rename_circuit leak → circuitOps empty, shadow clone designation unchanged, tool_result scrubbed', async () => {
    const session = makeRealSession('sess-r22-rename');
    const pendingAsks = createPendingAsksRegistry();
    const ws = createMockServerWs();
    const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };

    const originalDesignation = session.stateSnapshot.circuits[1].designation;
    const leakDesignation = 'STQ-01 upstairs lights with extra content';

    session.client = mockClient([
      toolUseRound([
        {
          id: 'toolu_r22_rename',
          name: 'rename_circuit',
          input: {
            from_ref: 1,
            circuit_ref: 1,
            designation: leakDesignation,
            phase: null,
            rating_amps: null,
            cable_csa_mm2: null,
          },
        },
      ]),
      endTurnRound('ok'),
    ]);

    let captured = null;
    await runShadowHarness(session, 'rename circuit 1', [], {
      logger,
      pendingAsks,
      ws,
      _shadowCapture: (snap) => {
        captured = snap;
      },
    });

    expect(captured).not.toBeNull();

    // (1) perTurnWrites.circuitOps EMPTY — filter rejects the call
    //     BEFORE the dispatcher pushes the op. The designation field
    //     carried a requirement-ID (STQ-01) which the filter's Family
    //     2 requirement-ID regex catches.
    expect(captured.perTurnWrites.circuitOps).toHaveLength(0);
    const pwJson = serialisePerTurnWrites(captured.perTurnWrites);
    expect(pwJson).not.toContain('STQ-01');
    expect(pwJson).not.toContain('upstairs lights with extra');

    // (2) Shadow CLONE's circuit 1 designation UNCHANGED. This is a
    //     stricter assertion than the r21-#3 scenarios — the clone is
    //     where the shadow dispatcher writes; any regression that
    //     bypassed the filter would mutate this surface even if the
    //     live session (which the shadow path never touches) stayed
    //     clean.
    expect(captured.shadowSession.stateSnapshot.circuits[1].designation).toBe(originalDesignation);
    const shadowJson = JSON.stringify(captured.shadowSession.stateSnapshot);
    expect(shadowJson).not.toContain('STQ-01');
    expect(shadowJson).not.toContain('upstairs lights with extra');

    // (3) tool_result bodies scrubbed.
    const resultsJoined = serialiseToolResultBodies(captured.toolLoopOut);
    expect(resultsJoined).not.toContain('STQ-01');
    expect(resultsJoined).not.toContain('upstairs lights with extra');
  });

  test('production callers that omit _shadowCapture are unaffected (hook is test-only)', async () => {
    // Sanity check: when _shadowCapture is absent (production shape),
    // runShadowHarness runs cleanly and returns legacy result. No
    // hook-related state leaks into production flow.
    const session = makeRealSession('sess-r22-no-hook');
    const pendingAsks = createPendingAsksRegistry();
    const ws = createMockServerWs();
    const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };

    session.client = mockClient([endTurnRound('ok')]);

    // No _shadowCapture in options.
    const result = await runShadowHarness(session, 'hello', [], {
      logger,
      pendingAsks,
      ws,
    });

    // Legacy stub returns the empty extraction result shape.
    expect(result).toBeDefined();
    expect(result.extracted_readings).toEqual([]);
    // No divergence errors logged (production shape clean).
    const shadowErrors = logger.warn.mock.calls.filter((args) => args[0] === 'stage6_shadow_error');
    expect(shadowErrors).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// r23-#3 — serialiseToolResultBodies structured-content coverage
//
// WHY: r22-#2 landed serialiseToolResultBodies as a helper that
// inspects `block.content` only when typeof === 'string'. Anthropic
// SDK tool_result blocks also support structured content (array of
// blocks, each with `.text` or nested `.content`; single-object
// wrapper with `.content`). The current harness returns string
// bodies — but a future SDK upgrade, a dispatcher refactor, or a
// fixture with structured content would silently skip the block
// and a leak could pass the r22-#2 Scenario 4 assertions.
//
// This group tests serialiseToolResultBodies directly against
// synthetic toolLoopOut shapes covering:
//   1. String content (back-compat; what r22-#2 already tests)
//   2. Array-of-text-blocks content (structured shape)
//   3. Nested structured content (array whose blocks have .content)
//   4. Unknown-shape fallback (JSON.stringify defence-in-depth)
// plus null/undefined safety.
// ---------------------------------------------------------------------------
describe('r23-#3 serialiseToolResultBodies — structured-content shape coverage', () => {
  test('1. string content — back-compat, leak substring present', () => {
    const toolLoopOut = {
      messages_final: [
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_x',
              content: 'leak-substring TRUST BOUNDARY here',
            },
          ],
        },
      ],
    };
    expect(serialiseToolResultBodies(toolLoopOut)).toContain('TRUST BOUNDARY');
  });

  test('2. array-of-text-blocks content — all block.text concatenated', () => {
    const toolLoopOut = {
      messages_final: [
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_x',
              content: [
                { type: 'text', text: 'leak-part-1 TRUST BOUNDARY' },
                { type: 'text', text: 'leak-part-2 SYSTEM_CHANNEL' },
              ],
            },
          ],
        },
      ],
    };
    const joined = serialiseToolResultBodies(toolLoopOut);
    expect(joined).toContain('TRUST BOUNDARY');
    expect(joined).toContain('SYSTEM_CHANNEL');
  });

  test('3. nested structured content — recursion into block.content', () => {
    const toolLoopOut = {
      messages_final: [
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_x',
              content: [
                { type: 'text', text: 'outer prefix' },
                {
                  type: 'tool_use_result',
                  content: [{ type: 'text', text: 'nested leak <<<USER_TEXT>>>' }],
                },
              ],
            },
          ],
        },
      ],
    };
    const joined = serialiseToolResultBodies(toolLoopOut);
    expect(joined).toContain('<<<USER_TEXT>>>');
    expect(joined).toContain('outer prefix');
  });

  test('4. unknown-shape fallback — JSON.stringify captures leak in unexpected keys', () => {
    const toolLoopOut = {
      messages_final: [
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_x',
              content: { weird: 'shape with leak STQ-01 inside' },
            },
          ],
        },
      ],
    };
    // JSON.stringify fallback must surface the leak substring.
    const joined = serialiseToolResultBodies(toolLoopOut);
    expect(joined).toContain('STQ-01');
  });

  test('null safety: content=null returns empty string (no throw)', () => {
    const toolLoopOut = {
      messages_final: [
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_x',
              content: null,
            },
          ],
        },
      ],
    };
    expect(() => serialiseToolResultBodies(toolLoopOut)).not.toThrow();
    expect(serialiseToolResultBodies(toolLoopOut)).toBe('');
  });

  test('undefined safety: content=undefined returns empty string', () => {
    const toolLoopOut = {
      messages_final: [
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_x',
              content: undefined,
            },
          ],
        },
      ],
    };
    expect(() => serialiseToolResultBodies(toolLoopOut)).not.toThrow();
    expect(serialiseToolResultBodies(toolLoopOut)).toBe('');
  });

  test('missing messages_final: returns empty string', () => {
    expect(serialiseToolResultBodies({})).toBe('');
    expect(serialiseToolResultBodies(null)).toBe('');
    expect(serialiseToolResultBodies(undefined)).toBe('');
  });

  // -------------------------------------------------------------------------
  // r24-#3 — WeakSet cycle guard on extractTextFromBlock
  //
  // WHY: r23-#3 landed extractTextFromBlock with a narrow cycle guard
  // (`block.content !== block.text`) that only handles the direct
  // same-reference case. A true object cycle like
  //   a.content = b; b.content = a;
  // would infinite-loop.
  //
  // Fix: WeakSet visited-guard threaded through recursive calls. WeakSet
  // accepts only objects (exactly what we need — primitives can't cycle)
  // and doesn't retain references to visited objects, so cycle tracking
  // doesn't leak object lifetime into the helper.
  //
  // Tests below construct progressively deeper cycles to prove the
  // guard handles:
  //   1. indirect two-node cycle (a → b → a)
  //   2. direct self-reference (x → x)
  //   3. deep three-node cycle (a → b → c → a)
  //   4. acyclic deep content still walks every level
  // -------------------------------------------------------------------------
  describe('r24-#3 cycle guard on extractTextFromBlock', () => {
    test('indirect two-node cycle a→b→a resolves without stack overflow', () => {
      const a = {};
      const b = { content: a };
      a.content = b;
      const toolLoopOut = {
        messages_final: [
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'toolu_x',
                content: a,
              },
            ],
          },
        ],
      };
      expect(() => serialiseToolResultBodies(toolLoopOut)).not.toThrow();
    });

    test('direct self-reference x→x resolves without throw', () => {
      const x = {};
      x.content = x;
      const toolLoopOut = {
        messages_final: [
          {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'toolu_x', content: x }],
          },
        ],
      };
      expect(() => serialiseToolResultBodies(toolLoopOut)).not.toThrow();
    });

    test('deep chain cycle a→b→c→a resolves without throw', () => {
      const a = {};
      const b = { content: null };
      const c = { content: null };
      a.content = b;
      b.content = c;
      c.content = a;
      const toolLoopOut = {
        messages_final: [
          {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'toolu_x', content: a }],
          },
        ],
      };
      expect(() => serialiseToolResultBodies(toolLoopOut)).not.toThrow();
    });

    test('acyclic deep content still walks every level under the cycle guard', () => {
      const deep = {
        text: 'level1',
        content: {
          text: 'level2',
          content: { text: 'level3 leak STQ-01' },
        },
      };
      const toolLoopOut = {
        messages_final: [
          {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'toolu_x', content: deep }],
          },
        ],
      };
      expect(serialiseToolResultBodies(toolLoopOut)).toContain('STQ-01');
    });
  });
});

// ---------------------------------------------------------------------------
// Helper used across scenarios — kept at module bottom for discoverability
// but not removed (the signature is named for anyone mining this file for
// test patterns).
// eslint-disable-next-line no-unused-vars
function _keepTypeBodyHelperForReference(messagesFinal) {
  return collectAllToolResultJsonBodies(messagesFinal);
}
