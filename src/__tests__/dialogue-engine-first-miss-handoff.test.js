/**
 * PLAN-A §A1-A5 (feedback-2026-09-17, ids 140/141/143) — the first-miss
 * handoff, its note, and the tombstone that makes it stick.
 *
 * Acceptance items 1, 2, 5, 6, 7 and 8 of the plan. The device-absence fence
 * and the terminal-read-back carrier have their own suites.
 */

import {
  processProtectiveDeviceTurn,
  processInsulationResistanceTurn,
  processRingContinuityTurn,
  enterScriptByName,
  tryEnterScriptFromWrites,
  ALL_DIALOGUE_SCHEMAS,
} from '../extraction/dialogue-engine/index.js';
import {
  isHandedOff,
  migrateHandoffsForRename,
  clearHandoffsForCircuit,
} from '../extraction/dialogue-handoff-tombstone.js';
import { describeSlotValidation } from '../extraction/circuit-value-descriptors.js';

const SESSION_ID = 'sess_handoff';

class FakeWS {
  constructor() {
    this.OPEN = 1;
    this.readyState = this.OPEN;
    this.sent = [];
  }
  send(data) {
    this.sent.push(JSON.parse(data));
  }
}

function buildSession(circuits = {}, extra = {}) {
  return {
    sessionId: SESSION_ID,
    stateSnapshot: {
      circuits: JSON.parse(JSON.stringify(circuits)),
      boards: [{ id: 'main', board_type: 'main' }],
      currentBoardId: 'main',
      ...extra,
    },
  };
}

const silentLog = { info: () => {}, warn: () => {} };
function capturingLog(rows) {
  return { info: (event, payload) => rows.push({ event, payload }), warn: () => {} };
}

// ── Acceptance 1 — the headline case ────────────────────────────────────────

describe('acceptance 1 — session CC9E0915: “There is no RCBI” ends the walk', () => {
  function enterRcboAndMiss(rows) {
    const ws = new FakeWS();
    const session = buildSession({ 3: {} });
    const log = capturingLog(rows);
    processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'RCBO on circuit 3.',
      logger: log,
      now: 1000,
    });
    const askedField = ws.sent.at(-1).context_field;
    const out = processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'There is no RCBI',
      logger: log,
      now: 2000,
    });
    return { ws, session, out, askedField, log };
  }

  test('zero repeated asks, one script_handoff, state null, tombstone set', () => {
    const rows = [];
    const { ws, session, out, askedField } = enterRcboAndMiss(rows);

    // ZERO repeated asks for the slot that was missed — the re-ask into silence
    // is the whole of the reported defect.
    expect(ws.sent.filter((m) => m.context_field === askedField)).toHaveLength(1);

    const handoffs = rows.filter((r) => r.event === 'stage6.script_handoff');
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0].payload).toMatchObject({
      kind: 'slot_miss',
      field: askedField,
      schema: 'rcbo',
      circuit_ref: 3,
      board_id: 'main',
    });

    // The script is ENDED — no paused, no active.
    expect(session.dialogueScriptState).toBeNull();
    expect(out).toMatchObject({ handled: true, fallthrough: true });

    // The tombstone is stamped for (board, schema, circuit).
    expect(isHandedOff(session, 'main', 'rcbo', 3)).toBe(true);
  });

  test('the note carries remaining in schema order, asked field FIRST, each with its validation', () => {
    const rows = [];
    const { out, askedField } = enterRcboAndMiss(rows);
    const note = out.serverNote;

    expect(note.asked_field).toBe(askedField);
    expect(note.remaining[0].field).toBe(askedField);
    expect(note.remaining.length).toBeGreaterThan(1);

    // Schema order is preserved for the rest.
    const rcbo = ALL_DIALOGUE_SCHEMAS.find((s) => s.name === 'rcbo');
    const schemaOrder = rcbo.slots.map((s) => s.field);
    const tail = note.remaining.slice(1).map((r) => r.field);
    expect(tail).toEqual([...tail].sort((a, b) => schemaOrder.indexOf(a) - schemaOrder.indexOf(b)));

    // Every entry carries its field, its question text and the DERIVED
    // validation metadata — deep-equal to the one exported function, so a
    // descriptor missing a flag fails here as well as in the oracle.
    for (const entry of note.remaining) {
      expect(typeof entry.field).toBe('string');
      expect(typeof entry.question).toBe('string');
      expect(entry.validation).toEqual(describeSlotValidation(entry.field));
    }

    // The directive is present and forbids re-entry by name as well as by tool.
    expect(note.directive).toContain('walk-through for this circuit has ended');
    expect(note.directive).toContain('Do not call `start_dialogue_script` for this circuit');
  });

  test('the next turn is an ordinary model turn: write-only, write+ask and a later answer are all fenced', () => {
    const rows = [];
    const { ws, session } = enterRcboAndMiss(rows);
    const log = capturingLog(rows);

    // A write-only model turn on that circuit.
    session.stateSnapshot.circuits[3].rcd_type = 'A';
    const writeOnly = tryEnterScriptFromWrites({
      session,
      ws,
      schemas: ALL_DIALOGUE_SCHEMAS,
      readings: [{ field: 'rcd_type', circuit: 3, value: 'A' }],
      logger: log,
      now: 3000,
    });
    expect(writeOnly).toEqual({ entered: false, reason: 'handed_off' });
    // No initScriptState, no ask.
    expect(session.dialogueScriptState).toBeNull();

    // A write + ask turn: `handed_off` is returned BEFORE modelHoldsFloor is
    // even consulted, so the reason is the tombstone rather than the floor.
    const writeAndAsk = tryEnterScriptFromWrites({
      session,
      ws,
      schemas: ALL_DIALOGUE_SCHEMAS,
      readings: [{ field: 'rcd_type', circuit: 3, value: 'A' }],
      logger: log,
      now: 4000,
    });
    expect(writeAndAsk).toEqual({ entered: false, reason: 'handed_off' });

    // Every blocked attempt is counted.
    const blocked = rows.filter((r) => r.event === 'stage6.script_reentered_after_handoff');
    expect(blocked.length).toBeGreaterThanOrEqual(2);
    expect(blocked[0].payload.path).toBe('entry_hook');
  });
});

// ── Acceptance 5 — the tombstone matrix ─────────────────────────────────────

describe('acceptance 5 — tombstone matrix', () => {
  function handoffOn(session, ws, circuit, rows) {
    const log = capturingLog(rows ?? []);
    processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: `RCBO on circuit ${circuit}.`,
      logger: log,
      now: 1000,
    });
    processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'nothing that parses',
      logger: log,
      now: 2000,
    });
  }

  test('start_dialogue_script for a handed-off circuit returns handed_off with remaining, no seeding, no ask', () => {
    const ws = new FakeWS();
    const session = buildSession({ 3: {} });
    const rows = [];
    handoffOn(session, ws, 3, rows);
    const framesBefore = ws.sent.length;

    const result = enterScriptByName({
      session,
      sessionId: SESSION_ID,
      schemas: ALL_DIALOGUE_SCHEMAS,
      schemaName: 'rcbo',
      circuit_ref: 3,
      pending_writes: [{ field: 'rcd_type', value: 'A' }],
      ws,
      logger: capturingLog(rows),
      now: 3000,
    });

    expect(result.ok).toBe(true);
    expect(result.status).toBe('handed_off');
    expect(Array.isArray(result.remaining)).toBe(true);
    expect(result.remaining.length).toBeGreaterThan(0);
    // No seeding: the pending write was NOT applied.
    expect(session.stateSnapshot.circuits[3].rcd_type).toBeUndefined();
    // No ask.
    expect(ws.sent.length).toBe(framesBefore);
    expect(session.dialogueScriptState).toBeFalsy();

    const blocked = rows.filter((r) => r.event === 'stage6.script_reentered_after_handoff');
    expect(blocked.some((r) => r.payload.path === 'start_dialogue_script')).toBe(true);
  });

  test('the SAME schema on the same circuit_ref of ANOTHER board enters normally', () => {
    const session = buildSession({ 3: {}, 'board-b::3': {} });
    session.stateSnapshot.boards = [
      { id: 'main', board_type: 'main' },
      { id: 'board-b', board_type: 'sub' },
    ];
    const ws = new FakeWS();
    handoffOn(session, ws, 3);
    expect(isHandedOff(session, 'main', 'rcbo', 3)).toBe(true);
    // The key differs by board, so board-b's circuit 3 is untouched.
    expect(isHandedOff(session, 'board-b', 'rcbo', 3)).toBe(false);
  });

  test('a FRESH named trigger clears the key and starts a new episode', () => {
    const ws = new FakeWS();
    const session = buildSession({ 3: {} });
    const rows = [];
    handoffOn(session, ws, 3, rows);
    expect(isHandedOff(session, 'main', 'rcbo', 3)).toBe(true);

    processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'RCBO on circuit 3 again',
      logger: capturingLog(rows),
      now: 5000,
    });

    expect(isHandedOff(session, 'main', 'rcbo', 3)).toBe(false);
    expect(session.dialogueScriptState?.active).toBe(true);
    const cleared = rows.filter((r) => r.event === 'stage6.script_handoff_cleared');
    expect(cleared).toHaveLength(1);
    expect(cleared[0].payload.by).toBe('fresh_trigger');
  });

  test('RENAME migrates the key; DELETE drops it', () => {
    const session = buildSession({ 3: {} });
    const ws = new FakeWS();
    handoffOn(session, ws, 3);
    expect(isHandedOff(session, 'main', 'rcbo', 3)).toBe(true);

    // A rename is NOT a fresh trigger — the model still owns the circuit.
    migrateHandoffsForRename(session, 'main', 3, 7);
    expect(isHandedOff(session, 'main', 'rcbo', 3)).toBe(false);
    expect(isHandedOff(session, 'main', 'rcbo', 7)).toBe(true);

    // A deletion drops it, so a NEW circuit later created on that ref is not
    // fenced by the old one's handoff.
    clearHandoffsForCircuit(session, 'main', 7);
    expect(isHandedOff(session, 'main', 'rcbo', 7)).toBe(false);
  });

  test('ENTRY-HOOK BOARD: the episode is stamped with the board the LOOKUP used, not currentBoardId', () => {
    // The full round trip, because the stamp alone is not the defect — the
    // MISMATCH is. A `record_reading` can carry an explicit `board_id` that
    // differs from the current board, so the entry hook resolves the write's
    // board (`board-b`) for its tombstone lookup. If `initScriptState` then
    // re-resolved from `currentBoardId` (`main`), a later handoff would write
    // the tombstone under `main` while every subsequent write on that circuit
    // looks it up under `board-b`: the lookup MISSES, a fresh script asks the
    // next missing slot on a circuit the model already owns, and the first-miss
    // handoff fails SILENTLY — this plan's headline guarantee.
    const session = {
      sessionId: SESSION_ID,
      stateSnapshot: {
        circuits: { 'board-b::3': { rcd_type: 'A' } },
        boards: [
          { id: 'main', board_type: 'main' },
          { id: 'board-b', board_type: 'sub' },
        ],
        currentBoardId: 'main',
      },
    };
    const ws = new FakeWS();
    const onBoardB = () => 'board-b';

    const entry = tryEnterScriptFromWrites({
      session,
      ws,
      schemas: ALL_DIALOGUE_SCHEMAS,
      readings: [{ field: 'rcd_type', circuit: 3, value: 'A' }],
      logger: silentLog,
      now: 1000,
      effectiveBoardIdForReading: onBoardB,
    });
    expect(entry.entered).toBe(true);
    // The episode carries the board its own entry resolved.
    expect(session.dialogueScriptState.effectiveBoardId).toBe('board-b');
    // Derived, not hardcoded: an `rcd_type` write enters whichever schema the
    // hook's own scoring picks, and the board property is what is under test.
    const schemaName = session.dialogueScriptState.schemaName;

    // Miss the question the walk asked, so the episode terminates and stamps.
    processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'nothing that parses',
      logger: silentLog,
      now: 2000,
    });
    expect(session.dialogueScriptState).toBeNull();
    expect(isHandedOff(session, 'board-b', schemaName, 3)).toBe(true);
    // …and NOT under the current board, which is the mismatch itself.
    expect(isHandedOff(session, 'main', schemaName, 3)).toBe(false);

    // The round trip: a later write on the SAME board+circuit is fenced. On the
    // pre-fix code this returns `{entered: true}` and restarts the walk.
    const reentry = tryEnterScriptFromWrites({
      session,
      ws,
      schemas: ALL_DIALOGUE_SCHEMAS,
      readings: [{ field: 'rcd_type', circuit: 3, value: 'A' }],
      logger: silentLog,
      now: 3000,
      effectiveBoardIdForReading: onBoardB,
    });
    expect(reentry).toEqual({ entered: false, reason: 'handed_off' });
  });

  test('BOARD NORMALISATION — it fails on the raw-currentBoardId asymmetry', () => {
    // A snapshot that has NOT been through ensureMultiBoardShape, so
    // `currentBoardId` is undefined, with a single board whose id is NOT
    // 'main'. Both sides must resolve 'board-7' through
    // `resolveEffectiveBoardId(session, null)` → currentBoardId ?? getMainBoardId.
    //
    // This case FAILS on an implementation whose reader falls back to a raw
    // `session.stateSnapshot?.currentBoardId` read: that yields undefined, the
    // lookup misses, and a fresh script asks the next missing slot on a circuit
    // the model already owns — the first-miss handoff failing SILENTLY.
    const session = {
      sessionId: SESSION_ID,
      stateSnapshot: {
        circuits: { 3: {} },
        boards: [{ id: 'board-7', board_type: 'main' }],
        // deliberately no currentBoardId
      },
    };
    const ws = new FakeWS();
    handoffOn(session, ws, 3);
    expect(isHandedOff(session, 'board-7', 'rcbo', 3)).toBe(true);

    // Drive the entry hook with a write whose EFFECTIVE_CIRCUIT_SLOT marker is
    // ABSENT, so the fallback path is the one under test.
    session.stateSnapshot.circuits[3].rcd_type = 'A';
    const entry = tryEnterScriptFromWrites({
      session,
      ws,
      schemas: ALL_DIALOGUE_SCHEMAS,
      readings: [{ field: 'rcd_type', circuit: 3, value: 'A' }],
      logger: silentLog,
      now: 6000,
    });
    expect(entry).toEqual({ entered: false, reason: 'handed_off' });
  });
});

// ── Acceptance 6 / A3 ───────────────────────────────────────────────────────

describe('acceptance 6 — cross-family entry after a handoff, and A3', () => {
  test('a DIFFERENT family enters through the ordinary entry loop; the earlier handoff left no state', () => {
    const ws = new FakeWS();
    const session = buildSession({ 2: {}, 3: {} });
    processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'RCBO on circuit 3.',
      logger: silentLog,
      now: 1000,
    });
    processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'nothing that parses',
      logger: silentLog,
      now: 2000,
    });
    expect(session.dialogueScriptState).toBeNull();

    processRingContinuityTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'ring continuity on circuit 2',
      logger: silentLog,
      now: 3000,
    });
    expect(session.dialogueScriptState?.schemaName).toBe('ring_continuity');
    expect(session.dialogueScriptState?.circuit_ref).toBe(2);
  });

  test('A3 — a model write in a turn where the model ALSO asked never starts a script', () => {
    const ws = new FakeWS();
    const session = buildSession({ 4: {} });
    session.stateSnapshot.circuits[4].rcd_type = 'A';
    const out = tryEnterScriptFromWrites({
      session,
      ws,
      schemas: ALL_DIALOGUE_SCHEMAS,
      readings: [{ field: 'rcd_type', circuit: 4, value: 'A' }],
      logger: silentLog,
      now: 1000,
      modelHoldsFloor: true,
    });
    expect(out).toEqual({ entered: false, reason: 'model_holds_floor' });
    expect(session.dialogueScriptState).toBeFalsy();

    // …and without the floor held, the same write DOES enter — so the guard is
    // the discriminator and not a blanket block.
    const entered = tryEnterScriptFromWrites({
      session,
      ws,
      schemas: ALL_DIALOGUE_SCHEMAS,
      readings: [{ field: 'rcd_type', circuit: 4, value: 'A' }],
      logger: silentLog,
      now: 2000,
      modelHoldsFloor: false,
    });
    expect(entered.entered).toBe(true);
  });
});

// ── Acceptance 8 / A4 ───────────────────────────────────────────────────────

describe('acceptance 8 — session 5FDFACC6: IR all-filled entry is a handoff, not “Got it”', () => {
  test('no Got it, recorded EMPTY, the three values in existing_values, state null', () => {
    const ws = new FakeWS();
    const session = buildSession({
      7: {
        ir_live_live_mohm: '299',
        ir_live_earth_mohm: '299',
        ir_test_voltage_v: '500',
      },
    });
    const rows = [];
    const out = processInsulationResistanceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'Insulation resistance for circuit 7.',
      logger: capturingLog(rows),
      now: 1000,
    });

    // The stale-value ceremony is gone.
    expect(ws.sent.some((m) => /Got it/.test(m.question ?? ''))).toBe(false);

    const handoffs = rows.filter((r) => r.event === 'stage6.script_handoff');
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0].payload.kind).toBe('all_filled_entry');

    const note = out.serverNote;
    expect(note.kind).toBe('all_filled_entry');
    // NOTHING was captured this run — seeding creates no operation.
    expect(note.recorded).toEqual([]);
    expect(note.remaining).toEqual([]);
    // The three seeded values are the only thing this note has to say.
    expect(note.existing_values).toEqual({
      ir_live_live_mohm: '299',
      ir_live_earth_mohm: '299',
      ir_test_voltage_v: '500',
    });
    // …and they are marked non-clearable by the directive.
    expect(note.directive).toContain('never clear them');

    expect(session.dialogueScriptState).toBeNull();
  });

  test('a circuit with a MISSING IR slot still walks normally — the flag is not a blanket handoff', () => {
    const ws = new FakeWS();
    const session = buildSession({ 8: { ir_live_live_mohm: '299' } });
    processInsulationResistanceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'Insulation resistance for circuit 8.',
      logger: silentLog,
      now: 1000,
    });
    expect(session.dialogueScriptState?.active).toBe(true);
    expect(ws.sent.at(-1).context_field).toBe('ir_live_earth_mohm');
  });
});

// ── Acceptance 2 — recorded provenance and derived targets ──────────────────

describe('acceptance 2 — recorded, existing_values and derived provenance', () => {
  test('recorded holds this episode’s applied operations; a seeded value stays in existing_values', () => {
    const ws = new FakeWS();
    const session = buildSession({ 3: { rcd_bs_en: 'BS EN 61008' } });
    processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'RCD on circuit 3.',
      logger: silentLog,
      now: 1000,
    });
    // Capture rcd_type, then miss the NEXT question.
    processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'type A',
      logger: silentLog,
      now: 2000,
    });
    const out = processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'there is no RCD',
      logger: silentLog,
      now: 3000,
    });

    expect(out.serverNote.recorded).toEqual([
      { field: 'rcd_type', value: 'A', circuit: 3, derived: [] },
    ]);
    // The PRE-EXISTING seeded BS is in existing_values, NOT in recorded — it is
    // certificate data the walk did not record, and clearing it is the worst
    // failure class in this wave.
    expect(out.serverNote.existing_values.rcd_bs_en).toBe('BS EN 61008');
    expect(out.serverNote.recorded.some((r) => r.field === 'rcd_bs_en')).toBe(false);
  });

  test('a `sets` derivation is recorded ON the write that produced it', () => {
    const ws = new FakeWS();
    const session = buildSession({ 5: {} });
    processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'MCB on circuit 5.',
      logger: silentLog,
      now: 1000,
    });
    // BS 3036 uniquely determines ocpd_type = 'Rew' via a `sets` derivation.
    processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'BS 3036',
      logger: silentLog,
      now: 2000,
    });
    const out = processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'nothing that parses',
      logger: silentLog,
      now: 3000,
    });

    const bsEntry = out.serverNote.recorded.find((r) => r.field === 'ocpd_bs_en');
    expect(bsEntry).toBeDefined();
    expect(bsEntry.derived).toContain('ocpd_type');
  });

  test('a PIVOT derives nothing — an `ocpd_bs_en = BS EN 61009` write has an EMPTY derived', () => {
    // 61009 pivots OCPD → RCBO. A pivot is not a `sets` target, so crediting one
    // would fabricate provenance and let a device-absence directive clear a
    // value this write never derived.
    const ws = new FakeWS();
    const session = buildSession({ 6: {} });
    processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'MCB on circuit 6.',
      logger: silentLog,
      now: 1000,
    });
    processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'BS EN 61009',
      logger: silentLog,
      now: 2000,
    });
    const out = processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'nothing that parses',
      logger: silentLog,
      now: 3000,
    });

    const bsEntry = out.serverNote.recorded.find((r) => r.field === 'ocpd_bs_en');
    expect(bsEntry).toBeDefined();

    // The assertion is DERIVED from the schema rather than hardcoded, so it is
    // correct in both states and needs no edit when the siblings land. The 61009
    // derivation is `{ value: '61009', mirrors: ['rcd_bs_en'], pivot: 'rcbo' }`:
    // the PIVOT contributes nothing today and never will, and the mirror
    // contributes `rcd_bs_en` until PLAN-CS deletes all four `bs_code` mirrors —
    // after which this entry is empty, which is the state PLAN-A's own
    // acceptance text describes. PLAN-A merges FIRST, so today the mirror is
    // still live.
    const ocpd = ALL_DIALOGUE_SCHEMAS.find((sc) => sc.name === 'ocpd');
    const derivation61009 = ocpd.slots
      .find((sl) => sl.field === 'ocpd_bs_en')
      .derivations.find((d) => d.value === '61009');
    const expectedDerived = [
      ...(derivation61009.mirrors ?? []),
      ...Object.keys(derivation61009.sets ?? {}),
    ];
    expect(bsEntry.derived).toEqual(expectedDerived);
    // Whatever the mirrors do, a PIVOT is never a derived target.
    expect(bsEntry.derived).not.toContain('rcbo');
  });

  test('SEEDED-derivation provenance — a derivation from another seeded field is NOT recorded provenance', () => {
    // The guard that stops the worst failure class. An OCPD entry triggered by
    // `ocpd_rating_a` with a PRE-EXISTING `ocpd_bs_en = BS 3036`: the seed loop
    // derives `ocpd_type = 'Rew'` from the SEEDED value. That target must NOT
    // land in the rating write's `derived`, or it would be both `recorded`
    // provenance and non-clearable `existing_values`, and a device-absence
    // directive could clear a value derived from pre-existing certificate data.
    const ws = new FakeWS();
    const session = buildSession({ 9: { ocpd_bs_en: 'BS 3036' } });
    session.stateSnapshot.circuits[9].ocpd_rating_a = '32';

    const entry = tryEnterScriptFromWrites({
      session,
      ws,
      schemas: [ALL_DIALOGUE_SCHEMAS.find((s) => s.name === 'ocpd')],
      readings: [{ field: 'ocpd_rating_a', circuit: 9, value: '32' }],
      logger: silentLog,
      now: 1000,
    });
    expect(entry.entered).toBe(true);

    // (a) the seeded BS derives ocpd_type into state.values, as today.
    expect(session.dialogueScriptState.values.ocpd_type).toBe('Rew');

    const triggerOp = session.dialogueScriptState.operations.find(
      (op) => op.field === 'ocpd_rating_a'
    );
    expect(triggerOp).toBeDefined();
    // (b) ocpd_type is ABSENT from the rating operation's derived targets.
    expect(triggerOp.derived ?? []).not.toContain('ocpd_type');
  });
});

// ── Acceptance 7 — an annotated answer on an ended script ───────────────────

describe('acceptance 7 — an annotated TTS answer on a circuit whose script ended', () => {
  test('no script entry; the reply reaches the model', () => {
    const ws = new FakeWS();
    const session = buildSession({ 3: {} });
    processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'RCBO on circuit 3.',
      logger: silentLog,
      now: 1000,
    });
    processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'nothing that parses',
      logger: silentLog,
      now: 2000,
    });
    expect(session.dialogueScriptState).toBeNull();

    const out = processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText:
        '[In response to TTS question type=stage6_ask_user: "Is that the RCBO on circuit 3?"] yes',
      // Production ALWAYS passes the un-annotated reply here
      // (`sonnet-stream.js` threads `canonicalTranscriptText`), and entry
      // detection runs on it. That is what stops the engine reading a trigger
      // out of the QUOTED question text and re-entering a script the model owns
      // — the same property the ring confirmation branch already relies on.
      rawReplyText: 'yes',
      logger: silentLog,
      now: 3000,
    });
    // Not handled by the engine — it reaches the model.
    expect(out?.handled ?? false).toBe(false);
    expect(session.dialogueScriptState).toBeFalsy();
    // …and the quoted question did NOT count as a fresh named trigger, so the
    // tombstone survives and the next model write is still fenced.
    expect(isHandedOff(session, 'main', 'rcbo', 3)).toBe(true);
  });
});
