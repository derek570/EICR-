/**
 * PLAN-A / Decision 17 (feedback-2026-09-17, taken by Derek 2026-09-21) —
 * the completion summary omits what it has already spoken, PER FIELD.
 *
 * Two properties, and the first is what makes the second meaningful:
 *
 *   (1) BYTE-IDENTICAL when nothing is omitted. The segment split must not
 *       silently reword the line. Both pre-change templates are pinned as
 *       LITERALS here, not re-derived from the schema — re-deriving would make
 *       the assertion vacuous.
 *   (2) EXACTLY-ONCE across the turn boundary, driven through the real
 *       `record_reading` → `tryEnterScriptFromWrites` → answer → `finishScript`
 *       sequence, with a FAIL-CLOSED direction asserted beside it so a bug that
 *       omits too MUCH fails the suite rather than passing it quietly.
 */

import {
  processProtectiveDeviceTurn,
  processInsulationResistanceTurn,
  enterScriptByName,
  tryEnterScriptFromWrites,
  ALL_DIALOGUE_SCHEMAS,
  ocpdSchema,
  insulationResistanceSchema,
} from '../extraction/dialogue-engine/index.js';
import { composeFinishSummary } from '../extraction/dialogue-engine/engine.js';

const SESSION_ID = 'sess_d17';

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

function buildSession(circuits = {}) {
  return {
    sessionId: SESSION_ID,
    stateSnapshot: { circuits: JSON.parse(JSON.stringify(circuits)) },
  };
}

const spokenFrames = (ws) =>
  ws.sent.filter((m) => m?.type === 'ask_user_started').map((m) => m.question ?? '');
const allSpoken = (ws) => spokenFrames(ws).join(' || ');
const occurrences = (haystack, needle) => haystack.split(needle).length - 1;

// ── Property (1): byte-identity ──────────────────────────────────────────────
//
// The PRE-CHANGE templates, pinned as literals. If a future edit reworders a
// segment, these fail — which is the entire point.
const OCPD_LEGACY = ({ values }) => {
  const bs = values.ocpd_bs_en ?? '?';
  const type = values.ocpd_type ?? '?';
  const rating = values.ocpd_rating_a ?? '?';
  const ka = values.ocpd_breaking_capacity_ka ?? '?';
  return `Got it. ${bs}, type ${type}, ${rating} amps, ${ka} kA.`;
};

const IR_LEGACY = ({ values }) => {
  const ll = values.ir_live_live_mohm ?? '?';
  const le = values.ir_live_earth_mohm ?? '?';
  const v = values.ir_test_voltage_v;
  const voltageClause = v ? `, voltage ${v}` : '';
  return `Got it. L-L ${ll}, L-E ${le}${voltageClause}.`;
};

/** all filled · each one missing · all missing */
function valueCombinations(fields, filled) {
  const combos = [{ ...filled }];
  for (const f of fields) {
    const c = { ...filled };
    delete c[f];
    combos.push(c);
  }
  combos.push({});
  return combos;
}

describe('Decision 17 — property (1): the segment split is byte-identical when nothing is omitted', () => {
  test('OCPD composes exactly today’s finishMessage over every value combination', () => {
    const fields = [
      'ocpd_bs_en',
      'ocpd_type',
      'ocpd_rating_a',
      'ocpd_breaking_capacity_ka',
    ];
    const filled = {
      ocpd_bs_en: 'BS EN 60898',
      ocpd_type: 'B',
      ocpd_rating_a: '32',
      ocpd_breaking_capacity_ka: '6',
    };
    for (const values of valueCombinations(fields, filled)) {
      const composed = composeFinishSummary(ocpdSchema.finishSummarySegments, values, new Set());
      expect({ values, text: composed.text }).toEqual({
        values,
        text: OCPD_LEGACY({ values }),
      });
    }
  });

  test('insulation resistance composes exactly today’s finishMessage, conditional voltage clause included', () => {
    const fields = ['ir_live_live_mohm', 'ir_live_earth_mohm', 'ir_test_voltage_v'];
    const filled = {
      ir_live_live_mohm: '299',
      ir_live_earth_mohm: '299',
      ir_test_voltage_v: '500',
    };
    for (const values of valueCombinations(fields, filled)) {
      const composed = composeFinishSummary(
        insulationResistanceSchema.finishSummarySegments,
        values,
        new Set()
      );
      expect({ values, text: composed.text }).toEqual({
        values,
        text: IR_LEGACY({ values }),
      });
    }
  });

  test('a value missing entirely still renders `?`, unchanged', () => {
    // Decision 17 changes WHICH segments render, never HOW one renders. The
    // `?` case is a different question and is not reopened here.
    const composed = composeFinishSummary(
      ocpdSchema.finishSummarySegments,
      { ocpd_type: 'B' },
      new Set()
    );
    expect(composed.text).toBe('Got it. ?, type B, ? amps, ? kA.');
  });

  test('omitting EVERY segment yields a null line, not an empty "Got it. ."', () => {
    const composed = composeFinishSummary(
      ocpdSchema.finishSummarySegments,
      { ocpd_bs_en: 'BS EN 60898', ocpd_type: 'B', ocpd_rating_a: '32' },
      new Set(['ocpd_bs_en', 'ocpd_type', 'ocpd_rating_a', 'ocpd_breaking_capacity_ka'])
    );
    expect(composed.text).toBeNull();
    expect(composed.fields).toEqual([]);
  });

  test('omission is PER FIELD and reaches all four OCPD fields, not breaking capacity alone', () => {
    // A-243 — the rule is stated per field, `coveredOps` is built per field and
    // `spoken_owner` is stamped per operation, so each of the four is
    // independently suppressible. A sibling citing this rule for `ocpd_type`,
    // `ocpd_bs_en` or `ocpd_rating_a` is citing it correctly.
    const values = {
      ocpd_bs_en: 'BS EN 60898',
      ocpd_type: 'B',
      ocpd_rating_a: '32',
      ocpd_breaking_capacity_ka: '6',
    };
    expect(
      composeFinishSummary(ocpdSchema.finishSummarySegments, values, new Set(['ocpd_bs_en'])).text
    ).toBe('Got it. type B, 32 amps, 6 kA.');
    expect(
      composeFinishSummary(ocpdSchema.finishSummarySegments, values, new Set(['ocpd_type'])).text
    ).toBe('Got it. BS EN 60898, 32 amps, 6 kA.');
    expect(
      composeFinishSummary(ocpdSchema.finishSummarySegments, values, new Set(['ocpd_rating_a']))
        .text
    ).toBe('Got it. BS EN 60898, type B, 6 kA.');
    expect(
      composeFinishSummary(
        ocpdSchema.finishSummarySegments,
        values,
        new Set(['ocpd_breaking_capacity_ka'])
      ).text
    ).toBe('Got it. BS EN 60898, type B, 32 amps.');
    // A compound entry can omit three at once, leaving the summary to name
    // only what remains.
    expect(
      composeFinishSummary(
        ocpdSchema.finishSummarySegments,
        values,
        new Set(['ocpd_bs_en', 'ocpd_type', 'ocpd_rating_a'])
      ).text
    ).toBe('Got it. 6 kA.');
  });
});

describe('Decision 17 — scope: which schemas declare segments, and which deliberately do not', () => {
  test('OCPD and insulation resistance are IN; ring, RCD and RCBO are not', () => {
    const declaring = ALL_DIALOGUE_SCHEMAS.filter((s) => s.finishSummarySegments).map(
      (s) => s.name
    );
    expect(new Set(declaring)).toEqual(new Set(['ocpd', 'insulation_resistance']));

    // Ring: nothing to do — its finishMessage names no value, so no repeat is
    // possible.
    const ring = ALL_DIALOGUE_SCHEMAS.find((s) => s.name === 'ring_continuity');
    expect(ring.finishMessage({ values: { ring_r1_ohm: '0.5' } })).toBe('Got it.');

    // RCD and RCBO: deliberately untouched. They opt into finishCoveredFields,
    // so a bundler-owned covered field already makes allCoveredScriptOwned
    // false and suppresses the whole line; every script-owned operation then
    // flows on into finishReadback.uncovered and is spoken there. They have no
    // repeat to suppress, and converting them would change the wording of a
    // mixed-ownership line Derek was not asked about.
    for (const name of ['rcd', 'rcbo']) {
      const s = ALL_DIALOGUE_SCHEMAS.find((x) => x.name === name);
      expect(Array.isArray(s.finishCoveredFields)).toBe(true);
      expect(s.finishSummarySegments).toBeUndefined();
    }

    // The two schemas IN scope declare no finishCoveredFields — that is what
    // puts them in the same class in the first place.
    expect(ocpdSchema.finishCoveredFields).toBeUndefined();
    expect(insulationResistanceSchema.finishCoveredFields).toBeUndefined();
  });
});

describe('Decision 17 — property (2): exactly-once across the turn boundary', () => {
  test('OCPD: a bundler-owned entry write is spoken once, and the summary names only the rest', () => {
    const ws = new FakeWS();
    const session = buildSession({ 3: {} });
    const log = { info: () => {}, warn: () => {} };

    // ENTRY ROUTE 1 of 2 — `sonnet_start_dialogue_script`'s pending-write loop.
    // This is the route that reaches the OCPD schema: every OCPD slot is also
    // an RCBO slot, and `tryEnterScriptFromWrites` scores the two schemas
    // equally on an OCPD field and breaks the tie by declaration order, which
    // puts RCBO first. An `ownershipResolver` being present is the ordinary
    // dispatcher case, and it is what stamps the seed `spoken_owner = 'bundler'`
    // — the bundler already reads that value back on this same turn.
    const entry = enterScriptByName({
      session,
      sessionId: SESSION_ID,
      schemas: ALL_DIALOGUE_SCHEMAS,
      schemaName: 'ocpd',
      circuit_ref: 3,
      pending_writes: [{ field: 'ocpd_rating_a', value: '32' }],
      ws,
      logger: log,
      now: 1000,
      ownershipResolver: () => null,
    });
    expect(entry.ok).toBe(true);
    expect(session.dialogueScriptState.schemaName).toBe('ocpd');

    // Turns 2..n — answer the remaining slots by voice, so those ARE
    // script-owned and must still be spoken by the summary.
    for (const text of ['BS EN 60898', 'type B', '6 kA']) {
      processProtectiveDeviceTurn({
        ws,
        session,
        sessionId: SESSION_ID,
        transcriptText: text,
        logger: log,
        now: 2000,
      });
    }

    // The entry value is spoken EXACTLY ONCE across the whole sequence — by the
    // bundler, on its own turn — and NOT again by the completion summary, which
    // is the repeat Decision 17 closes. This is a CROSS-TURN assertion.
    const finishFrames = spokenFrames(ws).filter((q) => q.startsWith('Got it.'));
    expect(finishFrames).toHaveLength(1);
    expect(finishFrames[0]).not.toContain('amps');
    // …and the summary still names the other fields, so the omission is
    // PER FIELD and not a suppressed line.
    expect(finishFrames[0]).toBe('Got it. BS EN 60898, type B, 6 kA.');
  });

  test('FAIL-CLOSED: with the same field SCRIPT-owned the value appears exactly once, IN the summary', () => {
    // A bug that omits too much fails HERE rather than passing quietly.
    const ws = new FakeWS();
    const session = buildSession({ 3: {} });
    const log = { info: () => {}, warn: () => {} };

    processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'MCB on circuit 3',
      logger: log,
      now: 1000,
    });
    for (const text of ['BS EN 60898', 'type B', '32 amps', '6 kA']) {
      processProtectiveDeviceTurn({
        ws,
        session,
        sessionId: SESSION_ID,
        transcriptText: text,
        logger: log,
        now: 2000,
      });
    }

    const finishFrames = spokenFrames(ws).filter((q) => q.startsWith('Got it.'));
    expect(finishFrames).toHaveLength(1);
    expect(finishFrames[0]).toBe('Got it. BS EN 60898, type B, 32 amps, 6 kA.');
    expect(occurrences(allSpoken(ws), '32 amps')).toBe(1);
  });

  test('case (c): a snapshot-seeded value with no covering operation RENDERS — that is its first read-back', () => {
    // findCoveringOp returns undefined for a field nobody dictated this run, so
    // it is not in coveredOps and cannot be in the omit set. This is the case
    // the all-or-nothing gate would have silenced.
    const ws = new FakeWS();
    const session = buildSession({ 3: { ocpd_bs_en: 'BS EN 60898', ocpd_type: 'B' } });
    const log = { info: () => {}, warn: () => {} };

    const entry = enterScriptByName({
      session,
      sessionId: SESSION_ID,
      schemas: ALL_DIALOGUE_SCHEMAS,
      schemaName: 'ocpd',
      circuit_ref: 3,
      pending_writes: [{ field: 'ocpd_rating_a', value: '32' }],
      ws,
      logger: log,
      now: 1000,
      ownershipResolver: () => null,
    });
    expect(entry.ok).toBe(true);

    // One slot still missing, so the script asks and then finishes.
    processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: '6 kA',
      logger: log,
      now: 2000,
    });

    const finishFrames = spokenFrames(ws).filter((q) => q.startsWith('Got it.'));
    expect(finishFrames).toHaveLength(1);
    // The two SEEDED values are spoken — their first read-back — while the
    // bundler-owned entry write is omitted.
    expect(finishFrames[0]).toBe('Got it. BS EN 60898, type B, 6 kA.');
  });

  test('insulation resistance: the same rule, on the other schema in scope', () => {
    const ws = new FakeWS();
    const session = buildSession({ 4: {} });
    const log = { info: () => {}, warn: () => {} };

    session.stateSnapshot.circuits[4].ir_live_live_mohm = '299';
    tryEnterScriptFromWrites({
      session,
      ws,
      schemas: ALL_DIALOGUE_SCHEMAS,
      readings: [{ field: 'ir_live_live_mohm', circuit: 4, value: '299' }],
      logger: log,
      now: 1000,
    });
    expect(session.dialogueScriptState?.schemaName).toBe('insulation_resistance');

    for (const text of ['live earth 299', '500 volts']) {
      processInsulationResistanceTurn({
        ws,
        session,
        sessionId: SESSION_ID,
        transcriptText: text,
        logger: log,
        now: 2000,
      });
    }

    const finishFrames = spokenFrames(ws).filter((q) => q.startsWith('Got it.'));
    expect(finishFrames).toHaveLength(1);
    // L-L was spoken by the bundler at entry and is omitted; L-E and the
    // voltage clause survive.
    expect(finishFrames[0]).not.toContain('L-L');
    expect(finishFrames[0]).toContain('L-E 299');
  });
});

describe('Decision 17 — telemetry (§ A5)', () => {
  test('finish_summary_spoken reports whether baseText was EMITTED, and the omission list names the dropped fields', () => {
    const ws = new FakeWS();
    const session = buildSession({ 3: {} });
    const rows = [];
    const log = { info: (event, payload) => rows.push({ event, payload }), warn: () => {} };

    enterScriptByName({
      session,
      sessionId: SESSION_ID,
      schemas: ALL_DIALOGUE_SCHEMAS,
      schemaName: 'ocpd',
      circuit_ref: 3,
      pending_writes: [{ field: 'ocpd_rating_a', value: '32' }],
      ws,
      logger: log,
      now: 1000,
      ownershipResolver: () => null,
    });
    for (const text of ['BS EN 60898', 'type B', '6 kA']) {
      processProtectiveDeviceTurn({
        ws,
        session,
        sessionId: SESSION_ID,
        transcriptText: text,
        logger: log,
        now: 2000,
      });
    }

    const completed = rows.filter((r) => r.event === 'stage6.ocpd_script_completed');
    expect(completed).toHaveLength(1);
    expect(completed[0].payload.finish_summary_spoken).toBe(true);
    // The field-evidence side of the exactly-once claim: a session where the
    // summary re-speaks a value shows an omission list that does not contain it.
    expect(completed[0].payload.finish_summary_omitted_fields).toEqual(['ocpd_rating_a']);
  });
});
