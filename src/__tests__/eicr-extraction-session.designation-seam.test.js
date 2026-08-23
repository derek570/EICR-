/**
 * PLAN-B B1 ingress 6 (feedback ids 128 + 131) — legacy JSON-prose
 * designation-hygiene seam, session-level proof.
 *
 * The legacy path (`SONNET_TOOL_CALLS=off`, and shadow mode — whose
 * authoritative result is the SAME `extractFromUtterance` output; see
 * stage6-shadow-harness.js `runShadowHarnessDispatch` Step 1) bypasses
 * every Stage-6 dispatcher that ingresses 1–4 canonicalise. This suite
 * drives the REAL session with a mocked model response and proves, for
 * BOTH legacy shapes (extracted_readings designation entries AND
 * `circuit_updates[] {circuit, designation, action}` create/rename):
 *
 *   - cleaned snapshot, cleaned wire reading, EXACT confirmation text
 *     exactly-once — including multiple same-turn designation readings,
 *     same-circuit mixed valid+banned, two-valid-operations, and the
 *     banned-token-only case;
 *   - next-turn snapshot serialization pinned for both shapes;
 *   - evaluation-enabled runs produce an attributed circuit_upsert
 *     receipt (origin model_direct, leg legacy) and no invalid latch;
 *   - sanitizer survival for BOTH halves (clarifications AND rebuilt
 *     designation confirmations) when the same result carries an
 *     unrelated off-schema rejected reading;
 *   - assistant-history consistency (mirror-candidate exclusion, the
 *     designation-only rebuild trigger, clarification bookkeeping,
 *     removed banned-only readings/confirmations absent).
 *
 * Mode note: shadow mode's authoritative leg IS this legacy call
 * (`runShadowHarnessDispatch` runs `session.extractFromUtterance` first
 * and returns it; the shadow tool loop mutates only a clone), so both
 * modes are exercised by setting `session.toolCallsMode` and driving the
 * same seam — mirroring exactly what the harness dispatch does.
 */

import { jest } from '@jest/globals';

const mockCreate = jest.fn();
const mockLookupPostcode = jest.fn();

jest.unstable_mockModule('@anthropic-ai/sdk', () => ({
  default: jest.fn(() => ({
    messages: {
      create: mockCreate,
    },
  })),
}));
jest.unstable_mockModule('../postcode_lookup.js', () => ({
  lookupPostcode: mockLookupPostcode,
}));

const { EICRExtractionSession } = await import('../extraction/eicr-extraction-session.js');
const {
  DESIGNATION_HYGIENE_QUESTION_TYPE,
  DESIGNATION_HYGIENE_QUESTION_PURPOSE,
  isDesignationHygieneQuestion,
} = await import('../extraction/legacy-designation-seam.js');
const { attachMutationObserver, createMutationObserver } =
  await import('../extraction/plan00-semantic-capture.js');

// Full legacy result shape (mirrors _validateParsedResult's slots).
const legacyResult = (overrides = {}) => ({
  extracted_readings: [],
  field_clears: [],
  circuit_updates: [],
  observations: [],
  validation_alerts: [],
  questions_for_user: [],
  confirmations: [],
  spoken_response: null,
  action: null,
  ...overrides,
});

const toolUseResponse = (input) => ({
  content: [{ type: 'tool_use', name: 'record_extraction', input }],
  usage: { input_tokens: 100, output_tokens: 40 },
  stop_reason: 'tool_use',
});

let session;

function makeSession(mode = 'off') {
  const s = new EICRExtractionSession('test-api-key', `desig-seam-${Math.random()}`, 'eicr');
  s.start(null);
  s.toolCallsMode = mode;
  return s;
}

/**
 * Drive one full legacy turn: buffer the utterance, then flush the batch
 * (BATCH_SIZE is 2, so a single utterance needs the explicit flush).
 */
async function runTurn(s, payload, { confirmationsEnabled = true, transcript } = {}) {
  mockCreate.mockResolvedValue(toolUseResponse(payload));
  await s.extractFromUtterance(transcript ?? 'circuit naming utterance', [], {
    confirmationsEnabled,
  });
  return s.flushUtteranceBuffer();
}

function lastAssistantHistory(s) {
  const last = s.conversationHistory[s.conversationHistory.length - 1];
  expect(last.role).toBe('assistant');
  return JSON.parse(last.content[0].text);
}

afterEach(() => {
  if (session) {
    if (session.batchTimeoutHandle) {
      clearTimeout(session.batchTimeoutHandle);
      session.batchTimeoutHandle = null;
    }
    if (session.cacheKeepaliveHandle) {
      clearTimeout(session.cacheKeepaliveHandle);
      session.cacheKeepaliveHandle = null;
    }
    session.utteranceBuffer = [];
    session = null;
  }
  mockCreate.mockReset();
  mockLookupPostcode.mockReset();
});

describe.each(['off', 'shadow'])('legacy designation seam (mode=%s)', (mode) => {
  // ── Shape 1: extracted_readings designation entry ─────────────────────
  test('reading shape: cleaned snapshot, cleaned wire reading, EXACT confirmation exactly-once', async () => {
    session = makeSession(mode);
    const result = await runTurn(
      session,
      legacyResult({
        extracted_readings: [
          { circuit: 2, field: 'circuit_designation', value: 'Upstairs Lighting Circuit' },
        ],
        confirmations: [
          {
            text: 'Circuit 2 designation: Upstairs Lighting Circuit',
            field: 'circuit_designation',
            circuit: 2,
          },
        ],
      })
    );

    // Wire reading carries the cleaned value (field corrected to the
    // legacy client key by the sanitizer's correction pass).
    expect(result.extracted_readings).toHaveLength(1);
    expect(result.extracted_readings[0].value).toBe('Upstairs Lighting');
    expect(result.extracted_readings[0].field).toBe('designation');

    // Snapshot carries the cleaned value.
    expect(session.stateSnapshot.circuits[2].designation).toBe('Upstairs Lighting');

    // EXACT confirmation text, exactly once, via the existing builder.
    const desigConfs = result.confirmations.filter((c) => c.field === 'designation');
    expect(desigConfs).toHaveLength(1);
    expect(desigConfs[0].text).toBe('Circuit 2 is now the Upstairs Lighting');
    expect(desigConfs[0].value).toBe('Upstairs Lighting');
    expect(result.confirmations).toHaveLength(1);
  });

  // ── Shape 2: real prompt-shaped circuit_updates create + rename ──────
  test('circuit_updates create: cleaned wire op, cleaned snapshot, EXACT confirmation, pinned next-turn serialization', async () => {
    session = makeSession(mode);
    const result = await runTurn(
      session,
      legacyResult({
        circuit_updates: [{ circuit: 3, designation: 'Ring Final Circuit', action: 'create' }],
      })
    );

    // Wire op cleaned in place (iOS decodes {circuit, designation, action}).
    expect(result.circuit_updates).toHaveLength(1);
    expect(result.circuit_updates[0]).toMatchObject({
      circuit: 3,
      designation: 'Ring Final',
      action: 'create',
    });

    // Named snapshot step: upsert atom wrote the canonical key.
    expect(session.stateSnapshot.circuits[3].circuit_designation).toBe('Ring Final');
    // recentCircuitOrder maintained like the reading branch.
    expect(session.recentCircuitOrder).toContain(3);

    // Exactly one confirmation, exact builder text.
    expect(result.confirmations).toHaveLength(1);
    expect(result.confirmations[0].text).toBe('Circuit 3 is now the Ring Final');
    expect(result.confirmations[0].field).toBe('circuit_designation');
    // WIRE SHAPE (Codex cycle-1 #1): EXACTLY the legacy {text, field,
    // circuit} enumerable keys — value/board metadata rides non-enumerably
    // for the in-process dedup only and must never serialize.
    expect(Object.keys(result.confirmations[0])).toEqual(['text', 'field', 'circuit']);
    const serialized = JSON.parse(JSON.stringify(result.confirmations[0]));
    expect(serialized).toEqual({
      text: 'Circuit 3 is now the Ring Final',
      field: 'circuit_designation',
      circuit: 3,
    });
    // The non-enumerable dedupe metadata is still readable in-process.
    expect(result.confirmations[0].value).toBe('Ring Final');

    // Next-turn snapshot serialization pinned: cleaned value present,
    // banned suffix absent.
    const snapshotMessage = session.buildStateSnapshotMessage();
    expect(snapshotMessage).toContain('Ring Final');
    expect(snapshotMessage).not.toContain('Ring Final Circuit');
  });

  test('circuit_updates rename: cleaned value replaces the stored designation; next-turn serialization pinned', async () => {
    session = makeSession(mode);
    session.stateSnapshot.circuits[2] = { circuit_designation: 'Kitchen sockets' };
    const result = await runTurn(
      session,
      legacyResult({
        circuit_updates: [{ circuit: 2, designation: 'Circuit Cooker', action: 'rename' }],
      })
    );

    expect(result.circuit_updates[0].designation).toBe('Cooker');
    expect(session.stateSnapshot.circuits[2].circuit_designation).toBe('Cooker');
    expect(result.confirmations).toHaveLength(1);
    expect(result.confirmations[0].text).toBe('Circuit 2 is now the Cooker');
    const snapshotMessage = session.buildStateSnapshotMessage();
    expect(snapshotMessage).toContain('Cooker');
    expect(snapshotMessage).not.toContain('Circuit Cooker');
  });

  // ── Multi-op contracts ────────────────────────────────────────────────
  test('two valid same-circuit circuit_updates operations: one confirmation per op, in operation order', async () => {
    session = makeSession(mode);
    const result = await runTurn(
      session,
      legacyResult({
        circuit_updates: [
          { circuit: 4, designation: 'Lighting Circuit', action: 'create' },
          { circuit: 4, designation: 'Upstairs Lighting Circuit', action: 'rename' },
        ],
      })
    );

    expect(result.confirmations.map((c) => c.text)).toEqual([
      'Circuit 4 is now the Lighting',
      'Circuit 4 is now the Upstairs Lighting',
    ]);
    // Snapshot final state is the LAST operation's value.
    expect(session.stateSnapshot.circuits[4].circuit_designation).toBe('Upstairs Lighting');
  });

  test('M1: genuine same-board same-value twins (create+rename) confirm exactly ONCE', async () => {
    session = makeSession(mode);
    const result = await runTurn(
      session,
      legacyResult({
        circuit_updates: [
          { circuit: 4, designation: 'Cooker Circuit', action: 'create' },
          { circuit: 4, designation: 'Circuit Cooker', action: 'rename' },
        ],
      })
    );

    // Both ops canonicalise to 'Cooker' on the SAME effective board — one
    // audible outcome. Two byte-identical confirmations would be double
    // speech (Audio-First §1 "not twice"): the snapshot dedupe cannot
    // suppress the second because no mutation has landed yet.
    expect(result.confirmations.map((c) => c.text)).toEqual(['Circuit 4 is now the Cooker']);
    expect(session.stateSnapshot.circuits[4].circuit_designation).toBe('Cooker');
  });

  test('M1: identical (circuit, value) ops on main AND a sub-board → two writes + two DISTINCT confirmations', async () => {
    session = makeSession(mode);
    session.stateSnapshot.boards = [
      { id: 'main', board_type: 'main' },
      { id: 'db2', board_type: 'sub', designation: 'DB-2' },
    ];
    const result = await runTurn(
      session,
      legacyResult({
        circuit_updates: [
          { circuit: 2, designation: 'Cooker Circuit', action: 'create' },
          { circuit: 2, designation: 'Cooker Circuit', action: 'create', board_id: 'db2' },
        ],
      })
    );

    // Two distinct board-scoped writes...
    expect(session.stateSnapshot.circuits[2].circuit_designation).toBe('Cooker');
    expect(session.stateSnapshot.circuits['db2::2'].circuit_designation).toBe('Cooker');
    // ...and two confirmations whose SERIALIZED text differs — identical
    // wire text would be swallowed by the client's text-keyed dedupe
    // (silent loss of the sub-board read-back). Board/value metadata is
    // non-enumerable, so the text is the only wire-visible distinguisher.
    const serializedTexts = JSON.parse(JSON.stringify(result.confirmations)).map((c) => c.text);
    expect(serializedTexts).toEqual([
      'Circuit 2 is now the Cooker',
      'Circuit 2 on DB-2 is now the Cooker',
    ]);
    expect(serializedTexts[0]).not.toBe(serializedTexts[1]);
  });

  test('Codex cycle-1 #4: sub-board rename dedupes against ITS board bucket, not the same-numbered main circuit', async () => {
    session = makeSession(mode);
    session.stateSnapshot.boards = [
      { id: 'main', board_type: 'main' },
      { id: 'db2', board_type: 'sub', designation: 'DB-2' },
    ];
    // Main and the sub-board SHARE ref 2; main already holds the exact
    // designation the sub-board rename resolves to. A main-bucket compare
    // would suppress the confirmation of a real sub-board write.
    session.stateSnapshot.circuits[2] = { circuit_designation: 'Cooker' };
    session.stateSnapshot.circuits['db2::2'] = {
      circuit: 2,
      board_id: 'db2',
      circuit_designation: 'Old Name',
    };
    const result = await runTurn(
      session,
      legacyResult({
        circuit_updates: [
          { circuit: 2, designation: 'Cooker Circuit', action: 'rename', board_id: 'db2' },
        ],
      })
    );

    // The mutation applies to the SUB-board bucket; main is untouched.
    expect(session.stateSnapshot.circuits['db2::2'].circuit_designation).toBe('Cooker');
    expect(session.stateSnapshot.circuits[2].circuit_designation).toBe('Cooker');
    // Exactly one confirmation — audible, not silently deduped by main —
    // and board-qualified (M1) since the effective board is not main.
    expect(result.confirmations).toHaveLength(1);
    expect(result.confirmations[0].text).toBe('Circuit 2 on DB-2 is now the Cooker');
  });

  test('two valid operations across BOTH shapes (reading + circuit_updates) each confirm once', async () => {
    session = makeSession(mode);
    const result = await runTurn(
      session,
      legacyResult({
        extracted_readings: [{ circuit: 2, field: 'designation', value: 'Cooker Circuit' }],
        circuit_updates: [{ circuit: 5, designation: 'Circuit Garage Sockets', action: 'create' }],
      })
    );

    expect(result.confirmations.map((c) => c.text)).toEqual([
      'Circuit 2 is now the Cooker',
      'Circuit 5 is now the Garage Sockets',
    ]);
    expect(session.stateSnapshot.circuits[2].designation).toBe('Cooker');
    expect(session.stateSnapshot.circuits[5].circuit_designation).toBe('Garage Sockets');
  });

  test('same-circuit mixed valid+banned: banned op removed without deleting the valid sibling confirmation', async () => {
    session = makeSession(mode);
    const result = await runTurn(
      session,
      legacyResult({
        circuit_updates: [
          { circuit: 4, designation: 'Circuit', action: 'create' },
          { circuit: 4, designation: 'Cooker Circuit', action: 'rename' },
        ],
        confirmations: [
          { text: 'Created circuit 4', field: 'circuit_designation', circuit: 4 },
          { text: 'Circuit 4 renamed', field: 'circuit_designation', circuit: 4 },
        ],
      })
    );

    // Banned-only op removed from the wire; valid sibling survives cleaned.
    expect(result.circuit_updates).toHaveLength(1);
    expect(result.circuit_updates[0].designation).toBe('Cooker');
    // Exactly ONE confirmation — the surviving op's, never the banned one's.
    expect(result.confirmations).toHaveLength(1);
    expect(result.confirmations[0].text).toBe('Circuit 4 is now the Cooker');
    // Exactly ONE clarification for the removed banned-only op.
    const clarifications = result.questions_for_user.filter(isDesignationHygieneQuestion);
    expect(clarifications).toHaveLength(1);
    expect(session.stateSnapshot.circuits[4].circuit_designation).toBe('Cooker');
  });

  // ── Banned-token-only ─────────────────────────────────────────────────
  test('banned-token-only reading: removed, no write, paired confirmation removed, exactly ONE tagged clarification', async () => {
    session = makeSession(mode);
    const result = await runTurn(
      session,
      legacyResult({
        extracted_readings: [{ circuit: 2, field: 'circuit_designation', value: 'Circuit' }],
        confirmations: [
          { text: 'Circuit 2 designation: Circuit', field: 'circuit_designation', circuit: 2 },
        ],
      })
    );

    expect(result.extracted_readings).toHaveLength(0);
    expect(session.stateSnapshot.circuits[2]).toBeUndefined();
    expect(result.confirmations).toHaveLength(0);
    const clarifications = result.questions_for_user.filter(isDesignationHygieneQuestion);
    expect(clarifications).toHaveLength(1);
    expect(clarifications[0].type).toBe(DESIGNATION_HYGIENE_QUESTION_TYPE);
    expect(clarifications[0].purpose).toBe(DESIGNATION_HYGIENE_QUESTION_PURPOSE);
    expect(clarifications[0].field).toBe('circuit_designation');
    expect(clarifications[0].circuit).toBe(2);
    // History: clarification recorded; removed reading + confirmation absent.
    const history = lastAssistantHistory(session);
    expect(history.extracted_readings).toHaveLength(0);
    expect(history.confirmations).toHaveLength(0);
    expect(history.questions_for_user.filter(isDesignationHygieneQuestion)).toHaveLength(1);
    // askedQuestions bookkeeping recorded the deliverable clarification.
    expect(session.askedQuestions).toContain('circuit_designation:2');
  });

  test('banned-only rename onto a populated slot: no mutation, ONE clarification', async () => {
    session = makeSession(mode);
    session.stateSnapshot.circuits[2] = { circuit_designation: 'Kitchen sockets' };
    const result = await runTurn(
      session,
      legacyResult({
        circuit_updates: [{ circuit: 2, designation: 'Circuits', action: 'rename' }],
      })
    );

    expect(result.circuit_updates).toHaveLength(0);
    // Populated slot untouched — the banned-only op never mutates.
    expect(session.stateSnapshot.circuits[2].circuit_designation).toBe('Kitchen sockets');
    expect(result.questions_for_user.filter(isDesignationHygieneQuestion)).toHaveLength(1);
    expect(result.confirmations).toHaveLength(0);
  });

  test('multiple banned-only operations still yield exactly ONE clarification', async () => {
    session = makeSession(mode);
    const result = await runTurn(
      session,
      legacyResult({
        extracted_readings: [{ circuit: 1, field: 'designation', value: 'Circuit' }],
        circuit_updates: [{ circuit: 2, designation: 'Circuit circuits', action: 'create' }],
      })
    );
    expect(result.questions_for_user.filter(isDesignationHygieneQuestion)).toHaveLength(1);
  });

  // ── Sanitizer survival (cap-round + round-21 findings) ───────────────
  test('valid circuit_updates designation + unrelated off-schema rejected reading → cleaned confirmation survives exactly once', async () => {
    session = makeSession(mode);
    const result = await runTurn(
      session,
      legacyResult({
        extracted_readings: [{ circuit: 3, field: 'flux_capacitance', value: '1.21' }],
        circuit_updates: [{ circuit: 5, designation: 'Garage Sockets Circuit', action: 'create' }],
      })
    );

    // The off-schema reading was rejected (sanitizer wiped + rebuilt the
    // audible surfaces) — the designation confirmation must still arrive,
    // exactly once, with the cleaned value.
    expect(result.extracted_readings).toHaveLength(0);
    const desigConfs = result.confirmations.filter((c) => c.field === 'circuit_designation');
    expect(desigConfs).toHaveLength(1);
    expect(desigConfs[0].text).toBe('Circuit 5 is now the Garage Sockets');
    expect(session.stateSnapshot.circuits[5].circuit_designation).toBe('Garage Sockets');
  });

  test('multiple same-slot extracted designation confirmations do not collapse to one winner under an unrelated rejection', async () => {
    session = makeSession(mode);
    const result = await runTurn(
      session,
      legacyResult({
        extracted_readings: [
          { circuit: 2, field: 'designation', value: 'Lighting Circuit' },
          { circuit: 2, field: 'designation', value: 'Upstairs Lighting Circuit' },
          { circuit: 3, field: 'flux_capacitance', value: '1.21' },
        ],
      })
    );

    // The sanitizer's server-owned rebuild collapses same-slot readings to
    // one winner; the seam's ledger merge restores one confirmation PER
    // OPERATION, in operation order.
    const desigConfs = result.confirmations.filter((c) => c.field === 'designation');
    expect(desigConfs.map((c) => c.text)).toEqual([
      'Circuit 2 is now the Lighting',
      'Circuit 2 is now the Upstairs Lighting',
    ]);
  });

  test('seam clarification survives an unrelated sanitizer rejection (questions_for_user wiped after the seam ran)', async () => {
    session = makeSession(mode);
    const result = await runTurn(
      session,
      legacyResult({
        extracted_readings: [
          { circuit: 2, field: 'circuit_designation', value: 'Circuit' },
          { circuit: 3, field: 'flux_capacitance', value: '1.21' },
        ],
        questions_for_user: [{ type: 'unclear', field: null, circuit: null, question: 'Hmm?' }],
      })
    );

    // Sanitizer wiped the model question; the server-owned clarification
    // was appended AFTER the sanitizer and survives, exactly once.
    const clarifications = result.questions_for_user.filter(isDesignationHygieneQuestion);
    expect(clarifications).toHaveLength(1);
    expect(result.questions_for_user).toHaveLength(1);
  });

  // ── Evaluation provenance ─────────────────────────────────────────────
  test('evaluation-enabled run: attributed circuit_upsert receipt (model_direct / leg legacy), no invalid latch', async () => {
    session = makeSession(mode);
    const observer = createMutationObserver({ sessionId: session.sessionId });
    attachMutationObserver(session.stateSnapshot, observer);
    // Mirror the harness's evaluation-turn bracket around dispatch.
    observer.enterTurnScope('eval-turn-1');
    try {
      await runTurn(
        session,
        legacyResult({
          circuit_updates: [{ circuit: 6, designation: 'Shower Circuit', action: 'create' }],
        })
      );
    } finally {
      observer.exitTurnScope();
    }

    const upserts = observer.receipts.filter((r) => r.kind === 'circuit_upsert');
    expect(upserts).toHaveLength(1);
    expect(upserts[0].origin).toBe('model_direct');
    expect(upserts[0].origin_meta).toEqual({ leg: 'legacy', field: 'circuit_designation' });
    expect(upserts[0].circuit).toBe(6);
    expect(upserts[0].extraction_turn_id).toBe('eval-turn-1');
    expect(observer.invalid).toBeNull();
  });

  // ── Assistant-history consistency ─────────────────────────────────────
  test('designation change + address-mirror candidate: history excludes the mirror candidate AND contains the cleaned designation', async () => {
    session = makeSession(mode);
    await runTurn(
      session,
      legacyResult({
        extracted_readings: [
          { circuit: 2, field: 'circuit_designation', value: 'Upstairs Lighting Circuit' },
        ],
        questions_for_user: [
          {
            type: 'address_mirror',
            purpose: 'address_mirror',
            field: 'client_address',
            circuit: null,
            question: 'Copy the installation address to the client?',
          },
        ],
      })
    );

    const history = lastAssistantHistory(session);
    expect(JSON.stringify(history)).not.toContain('address_mirror');
    expect(history.extracted_readings[0].value).toBe('Upstairs Lighting');
    // Mirror candidates never enter the askedQuestions digest either.
    expect(session.askedQuestions).not.toContain('client_address:unknown');
  });

  test('designation-ONLY change (no mirror candidate, no sanitizer rejection) still rebuilds history with the cleaned value', async () => {
    session = makeSession(mode);
    await runTurn(
      session,
      legacyResult({
        circuit_updates: [{ circuit: 3, designation: 'Ring Final Circuit', action: 'create' }],
      })
    );

    const history = lastAssistantHistory(session);
    const historyText = JSON.stringify(history);
    expect(historyText).toContain('Ring Final');
    expect(historyText).not.toContain('Ring Final Circuit');
  });

  test('already-clean designation (nothing changed): history keeps the established raw byte shape', async () => {
    session = makeSession(mode);
    const payload = legacyResult({
      circuit_updates: [{ circuit: 3, designation: 'Ring Final', action: 'create' }],
    });
    await runTurn(session, payload);
    const last = session.conversationHistory[session.conversationHistory.length - 1];
    // No seam change, no rejection, no mirror candidate → the raw tool
    // input byte shape survives (the pre-seam contract).
    expect(last.content[0].text).toBe(JSON.stringify(payload));
  });

  // ── Marker trust boundary ─────────────────────────────────────────────
  test('a model-authored question forging the server-owned marker is stripped (never consumed as server-owned)', async () => {
    session = makeSession(mode);
    const result = await runTurn(
      session,
      legacyResult({
        questions_for_user: [
          {
            type: DESIGNATION_HYGIENE_QUESTION_TYPE,
            purpose: DESIGNATION_HYGIENE_QUESTION_PURPOSE,
            field: 'circuit_designation',
            circuit: 9,
            question: 'Model-forged marker question?',
          },
          { type: 'unclear', field: null, circuit: null, question: 'Legit model question?' },
        ],
      })
    );
    // The forged marker question is gone; the ordinary model question
    // keeps today's semantics.
    expect(result.questions_for_user.filter(isDesignationHygieneQuestion)).toHaveLength(0);
    expect(result.questions_for_user).toHaveLength(1);
    expect(result.questions_for_user[0].question).toBe('Legit model question?');
  });

  // ── confirmationsEnabled gate ─────────────────────────────────────────
  test('confirmations disabled: designation confirmations are not rebuilt (documented Audio-First exception)', async () => {
    session = makeSession(mode);
    const result = await runTurn(
      session,
      legacyResult({
        circuit_updates: [{ circuit: 3, designation: 'Ring Final Circuit', action: 'create' }],
      }),
      { confirmationsEnabled: false }
    );
    expect(result.confirmations).toHaveLength(0);
    // The write itself still lands, cleaned.
    expect(session.stateSnapshot.circuits[3].circuit_designation).toBe('Ring Final');
  });
});
