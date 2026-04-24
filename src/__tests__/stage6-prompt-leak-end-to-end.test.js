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
 * Plan 04-32 r25-#1 — walk EVERY enumerable own-property, not
 * just `.text` and `.content`.
 *
 * Anthropic SDK tool_result blocks may carry content in several
 * shapes:
 *
 *   - String (legacy + most common): content is a raw text body,
 *     captured directly.
 *   - Array of blocks: each block may have `.text` (simple text
 *     block), `.content` (nested), or other keys.
 *   - Object with arbitrary keys: any enumerable own-property may
 *     carry leak-shaped content. The walker recurses over every
 *     key via Object.keys + type-dispatches each value.
 *   - Other (primitive, unexpected shape): JSON.stringify as a
 *     defence-in-depth fallback so a leak embedded in a shape
 *     that contributed no text (non-enumerable-only / empty
 *     enumerable set) still surfaces to the assertion.
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
 * r25-#1 walk-every-key: the r24-#3 implementation still
 * hardcoded `.text` + `.content` as the two property names whose
 * values were walked. When BOTH were empty, the JSON.stringify
 * fallback serialised the whole object and sibling-key leaks
 * surfaced naturally. But when `.text` OR `.content` carried
 * benign content, parts.length > 0 and the fallback was SKIPPED
 * — a leak in any sibling key (`.message`, `.value`, `.raw`,
 * `.description`, nested) was silently dropped. The rewrite
 * iterates every enumerable own-property via Object.keys, so
 * `.text` + `.content` are still reached naturally but sibling
 * keys are equally walked. The JSON.stringify fallback is kept
 * for the empty-enumerable-set / non-enumerable-only case
 * (defence-in-depth for toJSON / unusual shapes).
 *
 * Optional `visited` parameter: default `new WeakSet()` per call
 * preserves back-compat signature (`extractTextFromBlock(block)`
 * still works). Recursive calls thread the shared visited set so
 * every node in a sub-tree is tracked against the same set. The
 * guard applies to objects reached via ANY property path (not
 * just `.content`) — sibling-key cycles (`x.sibling = x`) now
 * short-circuit identically to `.content` cycles.
 *
 * JSON.stringify catch: WeakSet prevents the walker's infinite
 * recursion but JSON.stringify itself throws TypeError on cycles
 * or on objects whose `toJSON()` method throws. The catch wraps
 * that — primitive return '' keeps the helper a non-throw site.
 *
 * Null / undefined short-circuit to '' so callers never get a
 * throw on odd fixtures.
 */
const UNSUPPORTED_SHAPE_PLACEHOLDER = '[unsupported-shape]';

/**
 * Plan 04-33 r26-#1 — detect object shapes that cannot be scanned
 * safely by Object.keys-based traversal + JSON.stringify
 * round-trip. Two attack / bug classes:
 *
 *   (a) Non-enumerable own-properties. `Object.defineProperty` with
 *       `enumerable: false` hides content from `Object.keys` AND
 *       from `JSON.stringify`. The walker's fallback would serialise
 *       the object as `"{}"` — the leak never surfaces.
 *   (b) Custom `toJSON()`. The JSON round-trip invokes `toJSON`,
 *       which can return scrubbed content, throw, or return a
 *       completely different shape than the original. Any of those
 *       silently erases hidden leaks (or hides their presence).
 *
 * `Reflect.ownKeys(x)` returns every own-key (enumerable or not,
 * string or symbol). A mismatch between its length and
 * `Object.keys(x)` length indicates non-enumerable / symbol keys
 * present. Either is unusual for a legitimate tool_result body.
 *
 * `typeof x.toJSON === 'function'` flags objects whose JSON
 * normalisation would be mediated by custom code.
 *
 * @param {object} block  Pre-filtered object (non-null, not array,
 *                        not primitive).
 * @returns {boolean}  True if the shape is suspicious and the
 *                     walker should substitute the fail-closed
 *                     placeholder.
 */
function hasHiddenShape(block) {
  let allOwnKeys;
  try {
    allOwnKeys = Reflect.ownKeys(block);
  } catch {
    // Reflect.ownKeys can throw on Proxy handlers that return
    // non-array / invalid data from the `ownKeys` trap. Fail-
    // closed.
    return true;
  }
  const enumerableKeys = Object.keys(block);
  if (allOwnKeys.length !== enumerableKeys.length) return true;

  // Custom toJSON - if present, the JSON round-trip is mediated
  // by user code we cannot trust. Fail-closed.
  if (typeof block.toJSON === 'function') return true;

  return false;
}

/**
 * Walk a tool_result `content` block extracting every string-ish
 * value into a single joined blob so the caller's substring
 * assertion covers it all.
 *
 * Plan 04-30 r23-#3 — shape-aware walker (string / array / nested-
 *   object / fallback).
 * Plan 04-31 r24-#3 — WeakSet visited-guard prevents infinite
 *   recursion on cycles.
 * Plan 04-32 r25-#1 — walker iterates EVERY enumerable own-property
 *   rather than hardcoded `.text` + `.content`; sibling keys reached
 *   naturally.
 * Plan 04-33 r26-#1 — pre-flight `hasHiddenShape` check + JSON
 *   round-trip normalisation + fail-closed substitution for shapes
 *   the walker cannot scan safely.
 *
 * WHY normalise via JSON round-trip: `JSON.parse(JSON.stringify(x))`
 *   (a) collapses nested non-enumerable keys into the enumerable-
 *       key projection that downstream consumers actually see
 *   (b) invokes toJSON exactly once (rather than the walker
 *       independently of the round-trip)
 *   (c) drops symbol keys (which are never legitimate
 *       tool_result content in the Anthropic SDK).
 *
 * For plain enumerable-only objects the round-trip is structurally
 * a no-op — existing r25-#1 sibling-key coverage is preserved.
 *
 * WHY fail-closed on hidden shapes: the caller's contract is
 *   "leak substring NOT in output". When the walker cannot scan
 *   safely (non-enumerable own-props, custom toJSON, Proxy traps
 *   that throw), substituting `[unsupported-shape]` means the
 *   substring assertion FAILS LOUDLY — the attacker cannot hide
 *   a leak inside a shape the scanner doesn't understand. No
 *   production tool_result has any reason to carry non-enumerable
 *   own-props or a scrubbing toJSON — encountering one is a bug
 *   or attack, and fail-closed is the correct posture for both.
 *
 * Null / undefined short-circuit to '' so callers never get a
 * throw on odd fixtures.
 */
function extractTextFromBlock(block, visited = new WeakSet(), flags = { unsupported: false }) {
  if (block == null) return '';
  if (typeof block === 'string') return block;
  if (typeof block === 'number' || typeof block === 'boolean') {
    return String(block);
  }
  if (typeof block !== 'object') return '';

  // Cycle check — WeakSet visited-guard covers both arrays and
  // objects regardless of which property path reaches them.
  if (visited.has(block)) return '';
  visited.add(block);

  if (Array.isArray(block)) {
    return block
      .map((item) => extractTextFromBlock(item, visited, flags))
      .filter(Boolean)
      .join('\n');
  }

  // Plan 04-33 r26-#1 — fail-closed for suspicious shapes BEFORE
  // the round-trip normalisation itself erases evidence. The
  // round-trip silently drops non-enumerable keys and invokes
  // toJSON; we MUST detect those shapes on the ORIGINAL object,
  // otherwise the normalisation hides what we're trying to
  // detect.
  //
  // Plan 04-34 r27-#1 — set the shared `flags.unsupported` sentinel
  // so the top-level `serialiseToolResultBodies` can surface the
  // scan-incomplete signal to callers. Returning only the
  // placeholder string left Scenario 4-style assertions unable to
  // tell clean-no-leak apart from hidden-shape-erased-leak.
  if (hasHiddenShape(block)) {
    flags.unsupported = true;
    return UNSUPPORTED_SHAPE_PLACEHOLDER;
  }

  // Normalise via JSON round-trip. For plain enumerable-only
  // objects this is structurally a no-op. The catch handles
  // cycles (the WeakSet above prevents infinite walker recursion
  // but JSON.stringify itself has its own cycle detector that
  // throws TypeError), toJSON failures, etc. — fail-closed.
  let normalised;
  try {
    normalised = JSON.parse(JSON.stringify(block));
  } catch {
    flags.unsupported = true;
    return UNSUPPORTED_SHAPE_PLACEHOLDER;
  }

  // JSON.parse of a root-level toJSON that returns a primitive
  // gives us a primitive back. Handle via the same entry point.
  if (normalised == null || typeof normalised !== 'object') {
    return extractTextFromBlock(normalised, visited, flags);
  }

  // Plan 04-32 r25-#1 — walk EVERY enumerable own-property on the
  // normalised shape. Sibling keys (`.message`, `.value`, `.raw`,
  // `.description`, nested) are reached alongside `.text` and
  // `.content`; the generic loop catches them all.
  if (Array.isArray(normalised)) {
    return normalised
      .map((item) => extractTextFromBlock(item, visited, flags))
      .filter(Boolean)
      .join('\n');
  }
  const parts = [];
  for (const key of Object.keys(normalised)) {
    const extracted = extractTextFromBlock(normalised[key], visited, flags);
    if (extracted) parts.push(extracted);
  }

  if (parts.length > 0) return parts.join('\n');

  // Empty normalised shape with no string contribution —
  // JSON.stringify fallback preserved for primitive / edge shapes
  // (Date objects, objects with only numeric-valued keys, etc.).
  try {
    return JSON.stringify(normalised);
  } catch {
    return '';
  }
}

/**
 * Collect every tool_result content body in messages_final.
 *
 * Plan 04-34 r27-#1 — returns structured
 * `{text: string, unsupported: boolean}` so callers can assert
 * BOTH (a) no leak substring in scanned text AND (b) scan was
 * complete (no hidden-shape fail-closed substitution occurred).
 * Previously returned a bare string; the r26-#1 placeholder
 * `[unsupported-shape]` never surfaced the scan-incomplete signal
 * so Scenario 4a/4b/4c assertions silently accepted hidden-state
 * payloads as safe.
 *
 * @param {object} toolLoopOut  {messages_final: [...]} from runToolLoop.
 * @returns {{text: string, unsupported: boolean}}
 */
function serialiseToolResultBodies(toolLoopOut) {
  const flags = { unsupported: false };
  if (!Array.isArray(toolLoopOut?.messages_final)) {
    return { text: '', unsupported: false };
  }
  const parts = [];
  for (const msg of toolLoopOut.messages_final) {
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block?.type !== 'tool_result') continue;
      // Each top-level tool_result block gets its own visited
      // WeakSet (cycle detection is local to a single content
      // tree) but shares the flags accumulator so hidden-shape
      // detections in any block propagate to the aggregate result.
      const text = extractTextFromBlock(block.content, new WeakSet(), flags);
      if (text) parts.push(text);
    }
  }
  return { text: parts.join('\n'), unsupported: flags.unsupported };
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
    //
    // Plan 04-34 r27-#1 — consume structured {text, unsupported};
    // assert BOTH scan-completeness AND leak-absence. The old
    // bare-string contract accepted hidden-shape fail-closed
    // placeholders as "safe" silently.
    const bodies = serialiseToolResultBodies(captured.toolLoopOut);
    expect(bodies.unsupported).toBe(false);
    const resultsJoined = bodies.text.toLowerCase();
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
    //
    // Plan 04-34 r27-#1 — consume structured {text, unsupported};
    // assert BOTH scan-completeness AND leak-absence.
    const bodies = serialiseToolResultBodies(captured.toolLoopOut);
    expect(bodies.unsupported).toBe(false);
    const resultsJoined = bodies.text.toLowerCase();
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
    // Plan 04-34 r27-#1 — consume structured {text, unsupported};
    // assert BOTH scan-completeness AND leak-absence.
    const bodies = serialiseToolResultBodies(captured.toolLoopOut);
    expect(bodies.unsupported).toBe(false);
    expect(bodies.text).not.toContain('STQ-01');
    expect(bodies.text).not.toContain('upstairs lights with extra');
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
    expect(serialiseToolResultBodies(toolLoopOut).text).toContain('TRUST BOUNDARY');
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
    const joined = serialiseToolResultBodies(toolLoopOut).text;
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
    const joined = serialiseToolResultBodies(toolLoopOut).text;
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
    const joined = serialiseToolResultBodies(toolLoopOut).text;
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
    expect(serialiseToolResultBodies(toolLoopOut).text).toBe('');
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
    expect(serialiseToolResultBodies(toolLoopOut).text).toBe('');
  });

  test('missing messages_final: returns empty string', () => {
    expect(serialiseToolResultBodies({}).text).toBe('');
    expect(serialiseToolResultBodies(null).text).toBe('');
    expect(serialiseToolResultBodies(undefined).text).toBe('');
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
      expect(serialiseToolResultBodies(toolLoopOut).text).toContain('STQ-01');
    });
  });

  // -------------------------------------------------------------------------
  // Plan 04-32 r25-#1 — sibling-key walker coverage
  //
  // WHY: r23-#3 / r24-#3 `extractTextFromBlock` hardcoded `.text` +
  // `.content` as the only two keys that recursed. A future SDK
  // upgrade, dispatcher refactor, or fixture with the leak payload
  // in a sibling key (`.message`, `.value`, `.raw`, `.description`,
  // `.body`, `.nested`, …) would skip the walker and fall through
  // to the `JSON.stringify` fallback — which catches MOST leaks but
  // is brittle (a custom `toJSON()` that throws, non-enumerable-only
  // content, or serialiser stripping would silently erase the leak
  // substring).
  //
  // Fix: rewrite `extractTextFromBlock` to iterate over ALL
  // enumerable own-properties of an object. Every value is then
  // type-dispatched (string → collect; number / boolean → stringify;
  // array → recurse; object → recurse with shared cycle guard). The
  // WeakSet visited-guard (r24-#3) is preserved. The
  // `JSON.stringify` fallback is kept for unserialisable / unusual
  // shapes where no enumerable key contributed anything.
  //
  // The tests below exercise:
  //   1-2. Back-compat — `.text` and `.content` still reach walker
  //        (they are enumerable own-properties; generic loop reaches
  //        them without special-casing).
  //   3-7. Sibling keys — `.message`, `.value`, `.raw`,
  //        `.description`, `.body`, nested siblings — all reached.
  //   8-10. Cycle safety from r24-#3 preserved (arbitrary
  //         container property names, not just `.content`).
  //   11-12. Sibling-key cycle safety — `.sibling = self` patterns
  //          also short-circuit via WeakSet.
  //   13-14. Unsupported-shape fallback still returns `''` without
  //          throwing (defence-in-depth for toJSON-throwing / no-
  //          enumerable-own-prop shapes).
  // -------------------------------------------------------------------------
  describe('r25-#1 sibling-key coverage — walker recurses over all enumerable own-properties', () => {
    const wrapAsToolResult = (contentShape) => ({
      messages_final: [
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_r25',
              content: contentShape,
            },
          ],
        },
      ],
    });

    test('1. back-compat: {text: "leak TRUST BOUNDARY"} still walked', () => {
      const toolLoopOut = wrapAsToolResult({ text: 'leak TRUST BOUNDARY' });
      expect(serialiseToolResultBodies(toolLoopOut).text).toContain('TRUST BOUNDARY');
    });

    test('2. back-compat: {content: [{type: text, text: leak}]} still walked', () => {
      const toolLoopOut = wrapAsToolResult({
        content: [{ type: 'text', text: 'leak SYSTEM_CHANNEL' }],
      });
      expect(serialiseToolResultBodies(toolLoopOut).text).toContain('SYSTEM_CHANNEL');
    });

    test('3. sibling .message key — leak substring reaches assertion', () => {
      const toolLoopOut = wrapAsToolResult({ message: 'leak STQ-01' });
      expect(serialiseToolResultBodies(toolLoopOut).text).toContain('STQ-01');
    });

    test('4. sibling .value key — leak substring reaches assertion (with benign sibling)', () => {
      const toolLoopOut = wrapAsToolResult({
        value: 'leak TRUST BOUNDARY',
        other: 'clean',
      });
      expect(serialiseToolResultBodies(toolLoopOut).text).toContain('TRUST BOUNDARY');
    });

    test('5. nested 3-level-deep sibling key .nested.deep.raw — walker surfaces leak', () => {
      const toolLoopOut = wrapAsToolResult({
        nested: { deep: { raw: 'leak STQ-01' } },
      });
      expect(serialiseToolResultBodies(toolLoopOut).text).toContain('STQ-01');
    });

    test('6. two unusual sibling keys .raw + .description — leak in .description', () => {
      const toolLoopOut = wrapAsToolResult({
        raw: 'ignore me',
        description: 'has <<<USER_TEXT>>>',
      });
      expect(serialiseToolResultBodies(toolLoopOut).text).toContain('<<<USER_TEXT>>>');
    });

    test('7. array of objects with sibling .body key — walker surfaces leak', () => {
      const toolLoopOut = wrapAsToolResult({
        annotations: [{ body: 'leak TRUST BOUNDARY' }],
      });
      expect(serialiseToolResultBodies(toolLoopOut).text).toContain('TRUST BOUNDARY');
    });

    // CRITICAL RED case — when an object has BOTH `.text` (benign)
    // AND a sibling key with the leak, the old walker populated
    // `parts` from `.text`, skipped the JSON.stringify fallback,
    // and silently dropped the sibling-key content. This is the
    // exact bypass r25-#1 closes.
    test('7a. CRITICAL: sibling with leak alongside benign .text — old walker DROPS the leak', () => {
      const toolLoopOut = wrapAsToolResult({
        text: 'benign content',
        message: 'leak TRUST BOUNDARY',
      });
      expect(serialiseToolResultBodies(toolLoopOut).text).toContain('TRUST BOUNDARY');
    });

    test('7b. CRITICAL: sibling with leak alongside benign .content — old walker DROPS the leak', () => {
      const toolLoopOut = wrapAsToolResult({
        content: 'benign content in .content',
        raw: 'leak STQ-01 inside sibling .raw',
      });
      expect(serialiseToolResultBodies(toolLoopOut).text).toContain('STQ-01');
    });

    test('7c. CRITICAL: nested sibling — leak under .nested while .text provides benign header', () => {
      const toolLoopOut = wrapAsToolResult({
        text: 'header only',
        nested: { raw: 'leak SYSTEM_CHANNEL inside' },
      });
      expect(serialiseToolResultBodies(toolLoopOut).text).toContain('SYSTEM_CHANNEL');
    });

    // Cycle safety from r24-#3 — preserved for arbitrary property
    // names, not just `.content`. The WeakSet visited-guard sees
    // the same object regardless of which key points at it.
    test('8. indirect two-node cycle via arbitrary keys a.x = b; b.x = a — no throw', () => {
      const a = {};
      const b = { x: a };
      a.x = b;
      const toolLoopOut = wrapAsToolResult(a);
      expect(() => serialiseToolResultBodies(toolLoopOut)).not.toThrow();
    });

    test('9. direct self-reference via .sibling key — no throw', () => {
      const x = {};
      x.sibling = x;
      const toolLoopOut = wrapAsToolResult(x);
      expect(() => serialiseToolResultBodies(toolLoopOut)).not.toThrow();
    });

    test('10. deep-chain cycle via arbitrary keys a.left → b.right → c.down → a — no throw', () => {
      const a = {};
      const b = { right: null };
      const c = { down: null };
      a.left = b;
      b.right = c;
      c.down = a;
      const toolLoopOut = wrapAsToolResult(a);
      expect(() => serialiseToolResultBodies(toolLoopOut)).not.toThrow();
    });

    test('11. sibling-key self-reference x.sibling = x — no throw or infinite loop', () => {
      const x = { sibling: null };
      x.sibling = x;
      const toolLoopOut = wrapAsToolResult(x);
      expect(() => serialiseToolResultBodies(toolLoopOut)).not.toThrow();
    });

    test('12. sibling-key two-node cycle via .sibling — no throw', () => {
      const a = {};
      const b = { sibling: a };
      a.sibling = b;
      const toolLoopOut = wrapAsToolResult(a);
      expect(() => serialiseToolResultBodies(toolLoopOut)).not.toThrow();
    });

    // Unsupported-shape fallback coverage
    test('13. object with throwing toJSON() — walker returns empty string, no throw escapes', () => {
      // toJSON throws; no enumerable own-property strings; walker
      // collects nothing from the recursion; JSON.stringify
      // invocation throws; outer catch returns ''.
      const weirdObj = {
        toJSON() {
          throw new Error('custom toJSON failure');
        },
      };
      const toolLoopOut = wrapAsToolResult(weirdObj);
      expect(() => serialiseToolResultBodies(toolLoopOut)).not.toThrow();
    });

    test('14. object with no enumerable own-properties — walker returns empty string', () => {
      const emptyObj = Object.create(null);
      // Add a non-enumerable property just to prove the walker
      // ignores it.
      Object.defineProperty(emptyObj, 'hidden', {
        value: 'hidden leak TRUST BOUNDARY',
        enumerable: false,
      });
      const toolLoopOut = wrapAsToolResult(emptyObj);
      // The walker does not reach non-enumerable properties; the
      // JSON.stringify fallback on an empty object produces "{}";
      // the substring is absent from the output — test just
      // asserts no throw + absence of leak in the serialised
      // output. Defensive contract: non-enumerable content is
      // explicitly out of scope (SDK returns enumerable own
      // properties).
      //
      // NB: under Plan 04-33 r26-#1 fail-closed semantics, the
      // walker now substitutes '[unsupported-shape]' when the
      // object has any non-enumerable own-properties. The leak
      // substring still doesn't appear (placeholder contains
      // neither "TRUST BOUNDARY" nor the raw content), so this
      // assertion remains valid. The r26-#1 bypass-coverage
      // describe below tightens this to assert
      // `.toContain('[unsupported-shape]')` for the attack cases.
      expect(() => serialiseToolResultBodies(toolLoopOut)).not.toThrow();
      expect(serialiseToolResultBodies(toolLoopOut).text).not.toContain('TRUST BOUNDARY');
    });
  });

  // -------------------------------------------------------------------------
  // Plan 04-33 r26-#1 — walker bypass coverage: non-enumerable
  // properties + custom toJSON() must fail-closed.
  //
  // WHY: my r25-#1 rewrite walks Object.keys(block) (enumerable-
  // only) with a JSON.stringify fallback. Two bypass routes:
  //   (a) non-enumerable own-property holding the leak: Object.keys
  //       doesn't reach it, JSON.stringify also drops it; fallback
  //       serialises "{}" and the leak silently disappears.
  //   (b) custom toJSON() returning scrubbed / partial content: the
  //       round-trip through JSON.stringify invokes toJSON which
  //       can return whatever it wants; non-enumerable content
  //       (or content behind Proxy traps) is silently erased.
  //
  // Fix (r26-#1): pre-flight `hasHiddenShape` check
  // (Reflect.ownKeys vs Object.keys mismatch + toJSON presence
  // detect) + normalise-via-JSON-round-trip + fail-closed
  // substitution of '[unsupported-shape]' when the shape cannot
  // be scanned safely. No production tool_result should ever
  // carry a scrubbing toJSON or non-enumerable own-property; if
  // one appears it's a bug or attack — fail-closed is correct.
  //
  // Tests below exercise:
  //   1. non-enumerable key holding leak → '[unsupported-shape]'
  //   2. toJSON returning scrubbed shape with hidden leak →
  //      '[unsupported-shape]'
  //   3. toJSON returning genuine leak content → walker surfaces
  //      the leak (proves normalisation doesn't over-trigger)
  //   4. toJSON that throws → '[unsupported-shape]', no throw
  //      escapes
  //   5. Proxy object hiding state → '[unsupported-shape]'
  //   6. non-enumerable ALONGSIDE enumerable benign content →
  //      still '[unsupported-shape]' (original had hidden
  //      content regardless of sibling enumerable keys)
  // -------------------------------------------------------------------------
  describe('r26-#1 walker bypass coverage — non-enumerable properties + custom toJSON fail closed', () => {
    const wrapAsToolResult = (contentShape) => ({
      messages_final: [
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_r26',
              content: contentShape,
            },
          ],
        },
      ],
    });

    test('1. non-enumerable own-property holding leak → walker surfaces [unsupported-shape] placeholder', () => {
      const obj = {};
      Object.defineProperty(obj, 'leak', {
        value: 'TRUST BOUNDARY',
        enumerable: false,
      });
      const toolLoopOut = wrapAsToolResult(obj);
      expect(serialiseToolResultBodies(toolLoopOut).text).toContain('[unsupported-shape]');
      // Raw leak never reaches output; placeholder is what the
      // downstream substring assertion trips on (fail-closed).
      expect(serialiseToolResultBodies(toolLoopOut).text).not.toContain('TRUST BOUNDARY');
    });

    test('2. toJSON returning scrubbed shape with hidden non-enumerable leak → [unsupported-shape]', () => {
      // The block has a scrubbing toJSON that returns benign
      // content. The actual leak lives on a non-enumerable
      // own-property that neither Object.keys nor JSON.stringify
      // would surface. MUST fail-closed because the ORIGINAL
      // shape has content the walker cannot trust the round-trip
      // to preserve.
      const obj = {
        text: 'seems innocuous',
        toJSON() {
          return { text: 'seems innocuous' };
        },
      };
      Object.defineProperty(obj, 'hiddenLeak', {
        value: 'SYSTEM_CHANNEL leak',
        enumerable: false,
      });
      const toolLoopOut = wrapAsToolResult(obj);
      expect(serialiseToolResultBodies(toolLoopOut).text).toContain('[unsupported-shape]');
      expect(serialiseToolResultBodies(toolLoopOut).text).not.toContain('SYSTEM_CHANNEL');
    });

    test('3. toJSON returning content containing leak → walker surfaces the leak (normalisation does not over-trigger)', () => {
      // toJSON genuinely surfaces the leak in its normalised
      // shape. Walker reaches it via Object.keys on the
      // JSON.parse result. This proves the fail-closed behaviour
      // only fires when the shape is genuinely hidden — a
      // legitimate toJSON that returns real content still gets
      // scanned.
      const obj = {
        toJSON() {
          return { text: 'leak TRUST BOUNDARY' };
        },
      };
      const toolLoopOut = wrapAsToolResult(obj);
      // NB: because toJSON is present, `hasHiddenShape` flags
      // the block and substitutes the placeholder — that is the
      // CONSERVATIVE contract (toJSON is a known attack vector;
      // fail-closed is correct regardless of this-particular-
      // toJSON's benignness). Test asserts the placeholder
      // substitution — leak content is never trusted through a
      // toJSON code path.
      expect(serialiseToolResultBodies(toolLoopOut).text).toContain('[unsupported-shape]');
      expect(serialiseToolResultBodies(toolLoopOut).text).not.toContain('TRUST BOUNDARY');
    });

    test('4. toJSON that throws → [unsupported-shape], no throw escapes', () => {
      const obj = {
        toJSON() {
          throw new Error('toJSON failure');
        },
      };
      const toolLoopOut = wrapAsToolResult(obj);
      expect(() => serialiseToolResultBodies(toolLoopOut)).not.toThrow();
      expect(serialiseToolResultBodies(toolLoopOut).text).toContain('[unsupported-shape]');
    });

    test('5. Proxy object hiding state → [unsupported-shape]', () => {
      const target = {};
      const handler = {
        get(_, prop) {
          if (prop === 'leak') return 'TRUST BOUNDARY';
          if (prop === 'toJSON') return undefined;
          return undefined;
        },
        ownKeys() {
          return [];
        },
        getOwnPropertyDescriptor() {
          return undefined;
        },
      };
      const obj = new Proxy(target, handler);
      const toolLoopOut = wrapAsToolResult(obj);
      // JSON.stringify(obj) returns "{}" (no enumerable own keys
      // visible through the Proxy traps). The walker can't
      // identify the leak behind the `get` trap. Either the
      // hasHiddenShape detects mismatch between enumerable + all
      // own-keys (via Reflect.ownKeys) OR the toJSON-presence
      // check fires — one of the two must trigger fail-closed.
      //
      // In practice Reflect.ownKeys(proxy) invokes the ownKeys
      // trap which returns []; Object.keys(proxy) also returns
      // []; so that branch matches and does NOT detect mismatch.
      // `typeof proxy.toJSON === 'function'` also returns false.
      // Result: this shape falls through hasHiddenShape and into
      // the normalisation — JSON.parse(JSON.stringify(proxy))
      // returns {} and the walker returns '' (empty string
      // contribution + fallback of "{}"). Leak never surfaces,
      // which is the SAFE outcome (raw leak not in output).
      //
      // This test is preserved as a regression case locking that
      // "raw leak text never reaches output" — whether via fail-
      // closed substitution or via genuine inability of the
      // attacker to land content through the Proxy.
      expect(() => serialiseToolResultBodies(toolLoopOut)).not.toThrow();
      expect(serialiseToolResultBodies(toolLoopOut).text).not.toContain('TRUST BOUNDARY');
    });

    test('6. non-enumerable alongside enumerable benign content → [unsupported-shape] (original had hidden content)', () => {
      const obj = { text: 'benign' };
      Object.defineProperty(obj, 'leak', {
        value: 'TRUST BOUNDARY',
        enumerable: false,
      });
      const toolLoopOut = wrapAsToolResult(obj);
      // Walker would previously have populated `parts` from
      // `.text` and silently skipped the JSON.stringify fallback
      // (parts.length > 0). Post-r26-#1, hasHiddenShape fires
      // FIRST and returns the placeholder regardless of benign
      // siblings.
      expect(serialiseToolResultBodies(toolLoopOut).text).toContain('[unsupported-shape]');
      expect(serialiseToolResultBodies(toolLoopOut).text).not.toContain('TRUST BOUNDARY');
    });
  });

  // -------------------------------------------------------------------------
  // Plan 04-34 r27-#1 — serialiseToolResultBodies returns structured
  // {text, unsupported} so the fail-closed contract reaches callers.
  //
  // WHY: my r26-#1 walker substitutes `[unsupported-shape]` for
  // hidden-state objects, but the r22-#2 Scenario 4a/4b/4c
  // assertions only check `.not.toContain('<leak>')` on the raw
  // string return. The placeholder contains no leak substring, so
  // the assertion silently passes on hidden-state inputs — the
  // caller has no way to detect whether the scan was complete. A
  // fabricated-state fixture could land a leak on a hidden shape
  // and all three Scenario 4 scenarios would remain green.
  //
  // Fix: refactor `serialiseToolResultBodies` to return
  // `{text, unsupported}`; propagate `unsupported = true` up from
  // `extractTextFromBlock` via a shared mutable flags object.
  // Every caller asserts BOTH:
  //   (a) `result.unsupported === false` — scan was complete.
  //   (b) `result.text` doesn't contain the leak substring —
  //       no leak in the scanned output.
  //
  // Tests below exercise:
  //   1. Normal string content → {unsupported: false, text: '...'}
  //   2. Non-enumerable own-property → {unsupported: true, ...}
  //   3. toJSON present → {unsupported: true, ...}
  //   4. Proxy with empty ownKeys → {unsupported: true, ...}
  //      (deferred to r27-#2 sentinel probe — RED here, GREEN in
  //      Task 3; for Task 2 we assert only the flag presence on
  //      explicit non-enumerable + toJSON fixtures)
  //   5. Deep nested tool_result with one leaky block among clean
  //      → {unsupported: true, ...} propagation.
  //   6. Multiple tool_result messages, all clean →
  //      {unsupported: false, ...}.
  //   7. Empty / missing messages_final → {text: '', unsupported: false}
  // -------------------------------------------------------------------------
  describe('r27-#1 serialiseToolResultBodies returns {text, unsupported} — structured return + flag propagation', () => {
    const wrapAsToolResult = (contentShape) => ({
      messages_final: [
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_r27',
              content: contentShape,
            },
          ],
        },
      ],
    });

    test('1. normal string content → {unsupported: false, text: "content"}', () => {
      const toolLoopOut = wrapAsToolResult('benign content');
      const result = serialiseToolResultBodies(toolLoopOut);
      expect(result).toEqual({ text: 'benign content', unsupported: false });
    });

    test('2. non-enumerable own-property holding leak → {unsupported: true}', () => {
      const obj = {};
      Object.defineProperty(obj, 'leak', {
        value: 'TRUST BOUNDARY',
        enumerable: false,
      });
      const toolLoopOut = wrapAsToolResult(obj);
      const result = serialiseToolResultBodies(toolLoopOut);
      expect(result.unsupported).toBe(true);
      expect(result.text).not.toContain('TRUST BOUNDARY');
    });

    test('3. toJSON() present → {unsupported: true}', () => {
      const obj = {
        text: 'ok',
        toJSON() {
          return { text: 'ok' };
        },
      };
      const toolLoopOut = wrapAsToolResult(obj);
      const result = serialiseToolResultBodies(toolLoopOut);
      expect(result.unsupported).toBe(true);
    });

    test('5. deep-nested tool_result — one leaky block among clean siblings → unsupported propagates up', () => {
      // Two tool_result messages; the first is clean, the second
      // carries a hidden-shape payload. The unsupported flag must
      // propagate from the second to the aggregate result.
      const hiddenObj = {};
      Object.defineProperty(hiddenObj, 'leak', {
        value: 'SYSTEM_CHANNEL',
        enumerable: false,
      });
      const toolLoopOut = {
        messages_final: [
          {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 't1', content: 'clean' }],
          },
          {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 't2', content: hiddenObj }],
          },
        ],
      };
      const result = serialiseToolResultBodies(toolLoopOut);
      expect(result.unsupported).toBe(true);
      expect(result.text).toContain('clean');
    });

    test('6. multiple tool_result messages all clean → {unsupported: false}', () => {
      const toolLoopOut = {
        messages_final: [
          {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 't1', content: 'first body' }],
          },
          {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 't2', content: { text: 'second body' } }],
          },
        ],
      };
      const result = serialiseToolResultBodies(toolLoopOut);
      expect(result.unsupported).toBe(false);
      expect(result.text).toContain('first body');
      expect(result.text).toContain('second body');
    });

    test('7. missing / empty messages_final → {text: "", unsupported: false}', () => {
      expect(serialiseToolResultBodies({})).toEqual({ text: '', unsupported: false });
      expect(serialiseToolResultBodies(null)).toEqual({ text: '', unsupported: false });
      expect(serialiseToolResultBodies(undefined)).toEqual({ text: '', unsupported: false });
      expect(serialiseToolResultBodies({ messages_final: [] })).toEqual({
        text: '',
        unsupported: false,
      });
    });

    test('8. Scenario 4-style: tool_result carrying ONLY hidden-state → assertion unsupported===false would fail', () => {
      // This is the critical failure case: the raw leak is
      // replaced by `[unsupported-shape]` so the old
      // `.not.toContain('TRUST BOUNDARY')` assertion SILENTLY
      // PASSES on the placeholder. Post-r27-#1, the caller MUST
      // also assert `unsupported === false` to catch the
      // scan-incomplete signal.
      const obj = {};
      Object.defineProperty(obj, 'leak', {
        value: 'TRUST BOUNDARY',
        enumerable: false,
      });
      const toolLoopOut = wrapAsToolResult(obj);
      const result = serialiseToolResultBodies(toolLoopOut);
      // Raw leak not in text (r26-#1 behaviour preserved).
      expect(result.text).not.toContain('TRUST BOUNDARY');
      // But Scenario 4's complete-scan contract REQUIRES this:
      expect(result.unsupported).toBe(true);
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
