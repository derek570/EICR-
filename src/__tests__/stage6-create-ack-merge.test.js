/**
 * stage6-create-ack-merge.test.js — PLAN-D 2026-08-23 (feedback id 130), D3.
 *
 * The bundler matrix for the create-ack MERGE: when a `create` op's
 * (effective board, ref) has ≥1 same-turn reading confirmation, exactly ONE
 * deterministically-chosen carrier speaks "Created circuit N, <designation>
 * — <value-only tail>" and the standalone circop_ ack is dropped (preserved
 * as the non-enumerable CREATE_ACK_SUBSTITUTION sidecar for the mid-stream
 * filter). Pins every shape the plan enumerates: turn-9 (create alone),
 * all-fast (no merge, standalone ack, designation-free fast siblings),
 * mixed-carrier, the TRIPLE (designation reading is the carrier), same-ref
 * creates on two boards, grouped-only carriers (never chosen),
 * calc/clamp-corrected tails (sidecar preserves semantics), designationless
 * creates (absent/null/empty), bulk-outcome ordering (disclosure appends to
 * the merged text AND refreshes the substitution sidecar), and the
 * dedupe-token invariants (NO token minted on the carrier; the substitution
 * sidecar reuses the EXISTING circop_ composition — no new token family).
 *
 * Field evidence: session turn-14 (2026-08-23) — "Downstairs light, circuit
 * 3, wiring type A" + "Circuit 3 is now the Downstairs light", both spoken.
 * Recorded-lane twin: tests/fixtures/field-replay-corpus/
 * frc_1e2f5aabe7e7a73f522d98582f6ab734.
 */

import {
  bundleToolCallsIntoResult,
  CREATE_ACK_SUBSTITUTION,
} from '../extraction/stage6-event-bundler.js';
import { IMPEDANCE_CLAMP_CORRECTION } from '../extraction/impedance-clamp.js';
import { BULK_OUTCOME_CALL_ID } from '../extraction/stage6-per-turn-writes.js';

/** Minimal perTurnWrites accumulator. `readings` entries: [key, value]. */
function writes({ readings = [], circuitOps = [], boardOps = [], bulkOutcomes } = {}) {
  const w = {
    readings: new Map(readings),
    boardReadings: new Map(),
    cleared: [],
    observations: [],
    deletedObservations: [],
    circuitOps,
    boardOps,
  };
  if (bulkOutcomes) w.bulkOutcomes = bulkOutcomes;
  return w;
}

function bundle(w, options = {}) {
  return bundleToolCallsIntoResult(
    w,
    {},
    {
      confirmationsEnabled: true,
      turnId: 'turn-1',
      circuitDesignations: options.circuitDesignations ?? new Map(),
      ...options,
    }
  );
}

const createOp = (ref, designation, extra = {}) => ({
  op: 'create',
  circuit_ref: ref,
  meta: designation === undefined ? {} : { designation },
  ...extra,
});

/** Count occurrences of `needle` across all confirmation texts. */
function designationMentions(confirmations, needle) {
  return confirmations.reduce((n, c) => n + (String(c.text ?? '').includes(needle) ? 1 : 0), 0);
}

describe('D3 — create-ack merge (id 130)', () => {
  test('create + same-turn non-fast reading → ONE merged clip; carrier field kept; NO dedupe_token; expects_ios_ack untouched', () => {
    const res = bundle(
      writes({
        readings: [['wiring_type::3', { value: 'A', confidence: 0.9 }]],
        circuitOps: [createOp(3, 'Downstairs light')],
      }),
      { circuitDesignations: new Map([[3, 'Downstairs light']]) }
    );
    expect(res.confirmations).toHaveLength(1);
    const carrier = res.confirmations[0];
    expect(carrier.text).toBe('Created circuit 3, Downstairs light — wiring type A');
    expect(carrier.field).toBe('wiring_type');
    expect(carrier.circuit).toBe(3);
    expect(carrier.dedupe_token).toBeUndefined();
    // expects_ios_ack stays ABSENT (reading entries default ACK-eligible) —
    // the circop entry's `false` must not leak onto the carrier.
    expect('expects_ios_ack' in carrier).toBe(false);
    // Designation + circuit number each named exactly once in the merged clip.
    expect(carrier.text.match(/Downstairs light/g)).toHaveLength(1);
    expect(carrier.text.match(/circuit 3/gi)).toHaveLength(1);
    // The standalone ack is preserved (non-enumerable) for the mid-stream
    // filter, with the EXISTING circop_ token composition — no new family.
    const substitution = carrier[CREATE_ACK_SUBSTITUTION];
    expect(substitution).toBeDefined();
    expect(substitution.text).toBe('Circuit 3 is now the Downstairs light');
    expect(substitution.field).toBe('circuit_op');
    expect(substitution.expects_ios_ack).toBe(false);
    expect(substitution.dedupe_token).toBe('circop_turn-1_0_create_3');
    // Non-enumerable: never crosses the wire.
    expect(Object.keys(carrier)).not.toContain(CREATE_ACK_SUBSTITUTION);
    expect(JSON.stringify(carrier)).not.toContain('Circuit 3 is now');
  });

  test('turn-9 shape — create alone → exactly one standalone ack, byte-identical to today', () => {
    const res = bundle(writes({ circuitOps: [createOp(3, 'Downstairs light')] }), {
      circuitDesignations: new Map([[3, 'Downstairs light']]),
    });
    expect(res.confirmations).toHaveLength(1);
    expect(res.confirmations[0].text).toBe('Circuit 3 is now the Downstairs light');
    expect(res.confirmations[0].field).toBe('circuit_op');
  });

  test('create + designation reading (no measured) → existing skip path: one designation clip only', () => {
    const res = bundle(
      writes({
        readings: [['circuit_designation::3', { value: 'Downstairs light', confidence: 0.9 }]],
        circuitOps: [createOp(3, 'Downstairs light')],
      }),
      { circuitDesignations: new Map([[3, 'Downstairs light']]) }
    );
    expect(res.confirmations).toHaveLength(1);
    expect(res.confirmations[0].field).toBe('circuit_designation');
    expect(res.confirmations[0].text).toBe('Circuit 3 is now the Downstairs light');
  });

  test('ALL same-circuit readings fast-correlated → NO merge; standalone ack preserved; fast canonical rendered designation-free (designation exactly once)', () => {
    const fastMap = new Map([
      [
        'measured_zs_ohm::3::',
        {
          correlationId: 'corr-1',
          field: 'measured_zs_ohm',
          circuit: 3,
          boardId: null,
          canonicalValue: '0.5',
          comparisonText: 'Circuit 3, Zs 0.5',
        },
      ],
    ]);
    const res = bundle(
      writes({
        readings: [['measured_zs_ohm::3', { value: '0.5', confidence: 0.9 }]],
        circuitOps: [createOp(3, 'Downstairs light')],
      }),
      {
        circuitDesignations: new Map([[3, 'Downstairs light']]),
        fastAttemptBySlotKey: fastMap,
      }
    );
    const texts = res.confirmations.map((c) => c.text);
    // Standalone ack retained (creation stays audible even if the fast twin
    // suppresses the reading clip client-side).
    expect(texts).toContain('Circuit 3 is now the Downstairs light');
    // The fast-correlated canonical is designation-free — the fast-FAILED
    // fallback ordering must not re-announce the designation.
    const canonical = res.confirmations.find((c) => c.field === 'measured_zs_ohm');
    expect(canonical.fast_correlation_id).toBe('corr-1');
    expect(canonical.text).toBe('Circuit 3, Zs 0.5');
    expect(designationMentions(res.confirmations, 'Downstairs light')).toBe(1);
    expect(res.confirmations).toHaveLength(2);
  });

  test('mixed-carrier (one fast + one non-fast) → non-fast merged; fast sibling designation-free; designation exactly once', () => {
    const fastMap = new Map([
      [
        'measured_zs_ohm::3::',
        {
          correlationId: 'corr-1',
          field: 'measured_zs_ohm',
          circuit: 3,
          boardId: null,
          canonicalValue: '0.5',
          comparisonText: 'Circuit 3, Zs 0.5',
        },
      ],
    ]);
    const res = bundle(
      writes({
        readings: [
          ['measured_zs_ohm::3', { value: '0.5', confidence: 0.9 }],
          ['wiring_type::3', { value: 'A', confidence: 0.9 }],
        ],
        circuitOps: [createOp(3, 'Downstairs light')],
      }),
      {
        circuitDesignations: new Map([[3, 'Downstairs light']]),
        fastAttemptBySlotKey: fastMap,
      }
    );
    const texts = res.confirmations.map((c) => c.text);
    expect(texts).toContain('Created circuit 3, Downstairs light — wiring type A');
    expect(texts).toContain('Circuit 3, Zs 0.5'); // fast sibling designation-free
    expect(texts).not.toContain('Circuit 3 is now the Downstairs light');
    expect(designationMentions(res.confirmations, 'Downstairs light')).toBe(1);
    expect(res.confirmations).toHaveLength(2);
  });

  test('multiple non-fast same-turn readings → FIRST in original order is the carrier; others untouched', () => {
    const res = bundle(
      writes({
        readings: [
          ['wiring_type::3', { value: 'A', confidence: 0.9 }],
          ['measured_zs_ohm::3', { value: '0.5', confidence: 0.9 }],
        ],
        circuitOps: [createOp(3, 'Downstairs light')],
      }),
      { circuitDesignations: new Map([[3, 'Downstairs light']]) }
    );
    const texts = res.confirmations.map((c) => c.text);
    expect(texts[0]).toBe('Created circuit 3, Downstairs light — wiring type A');
    // Second reading untouched (plan Tests item 3: "others untouched").
    expect(texts[1]).toBe('Downstairs light, circuit 3, Zs 0.5');
    expect(texts).not.toContain('Circuit 3 is now the Downstairs light');
  });

  test('same-ref creates on two boards — each merges only into ITS board scope', () => {
    const res = bundle(
      writes({
        readings: [
          ['wiring_type::3', { value: 'A', confidence: 0.9, boardId: 'board-a' }],
          // Second board's reading rides the wire board_id (cross-board turn
          // enrichment shape) — hand-built here via the raw key + board.
        ],
        circuitOps: [
          createOp(3, 'Kitchen ring', { board_id: 'board-a' }),
          createOp(3, 'Garage lights', { board_id: 'board-b' }),
        ],
      }),
      { circuitDesignations: new Map([[3, 'Kitchen ring']]) }
    );
    // Only board-a has a same-scope reading — board-a's create MERGES into
    // it; board-b's create (no reading in ITS scope) keeps the standalone
    // ack. The shared ref 3 never cross-contaminates.
    const texts = res.confirmations.map((c) => c.text);
    expect(texts).toContain('Created circuit 3, Kitchen ring — wiring type A');
    expect(texts).toContain('Circuit 3 is now the Garage lights');
    expect(texts).not.toContain('Circuit 3 is now the Kitchen ring');
    expect(texts).not.toContain('Created circuit 3, Garage lights — wiring type A');
  });

  test('grouped/bulk-only same-turn confirmations are NEVER carriers — standalone ack retained', () => {
    const res = bundle(
      writes({
        readings: [
          ['ir_live_earth_mohm::3', { value: '>299', confidence: 0.9 }],
          ['ir_live_earth_mohm::4', { value: '>299', confidence: 0.9 }],
        ],
        circuitOps: [createOp(3, 'Downstairs light')],
      }),
      { circuitDesignations: new Map([[3, 'Downstairs light']]) }
    );
    const grouped = res.confirmations.find((c) => Array.isArray(c.circuits));
    expect(grouped).toBeDefined();
    expect(grouped.text).toContain('IR L to E');
    // The grouped entry keeps its multi-circuit scope; the create speaks its
    // own standalone ack.
    const texts = res.confirmations.map((c) => c.text);
    expect(texts).toContain('Circuit 3 is now the Downstairs light');
    expect(grouped.text).not.toContain('Created circuit');
  });

  test('create + calculated reading → merged tail preserves "calculated as" (sidecar semantics)', () => {
    const res = bundle(
      writes({
        readings: [
          [
            'measured_zs_ohm::3',
            { value: '0.61', confidence: 1, source_turn_id: '::calc::calculate_zs' },
          ],
        ],
        circuitOps: [createOp(3, 'Downstairs light')],
      }),
      { circuitDesignations: new Map([[3, 'Downstairs light']]) }
    );
    expect(res.confirmations).toHaveLength(1);
    expect(res.confirmations[0].text).toBe(
      'Created circuit 3, Downstairs light — Zs calculated as 0.61'
    );
  });

  test('create + clamp-corrected reading → merged tail preserves the spoken correction clause', () => {
    const entry = { value: '1.6', confidence: 0.9 };
    Object.defineProperty(entry, IMPEDANCE_CLAMP_CORRECTION, {
      value: { original: '16', corrected: '1.6' },
      enumerable: false,
    });
    const res = bundle(
      writes({
        readings: [['measured_zs_ohm::3', entry]],
        circuitOps: [createOp(3, 'Downstairs light')],
      }),
      { circuitDesignations: new Map([[3, 'Downstairs light']]) }
    );
    expect(res.confirmations).toHaveLength(1);
    expect(res.confirmations[0].text).toBe(
      'Created circuit 3, Downstairs light — Zs recorded as 1.6 — I corrected 16 to 1.6'
    );
  });

  test.each([
    ['absent designation', undefined],
    ['null designation', null],
    ['empty designation', ''],
  ])(
    'designationless create (%s) → "Created circuit N — <tail>", no dangling comma',
    (_label, desig) => {
      const res = bundle(
        writes({
          readings: [['wiring_type::4', { value: 'B', confidence: 0.9 }]],
          circuitOps: [createOp(4, desig)],
        })
      );
      expect(res.confirmations).toHaveLength(1);
      expect(res.confirmations[0].text).toBe('Created circuit 4 — wiring type B');
    }
  );

  describe('TRIPLE shape — create + record_reading(circuit_designation) + measured readings', () => {
    test('designation confirmation IS the carrier (untouched); measured readings designation-free; designation exactly once', () => {
      const res = bundle(
        writes({
          readings: [
            ['circuit_designation::5', { value: 'Cooker', confidence: 0.9 }],
            ['wiring_type::5', { value: 'B', confidence: 0.9 }],
            ['measured_zs_ohm::5', { value: '0.4', confidence: 0.9 }],
          ],
          circuitOps: [createOp(5, 'Cooker')],
        }),
        { circuitDesignations: new Map([[5, 'Cooker']]) }
      );
      const texts = res.confirmations.map((c) => c.text);
      expect(texts).toContain('Circuit 5 is now the Cooker');
      expect(texts).toContain('Circuit 5, wiring type B');
      expect(texts).toContain('Circuit 5, Zs 0.4');
      expect(texts).not.toContain('Created circuit 5, Cooker — wiring type B');
      expect(designationMentions(res.confirmations, 'Cooker')).toBe(1);
      // The designation carrier's token is the existing desig_ family, untouched.
      const desigEntry = res.confirmations.find((c) => c.field === 'circuit_designation');
      expect(desigEntry.dedupe_token).toBe('desig_5_turn-1');
    });

    test('triple with a fast-correlated measured sibling → sibling designation-free too', () => {
      const fastMap = new Map([
        [
          'measured_zs_ohm::5::',
          {
            correlationId: 'corr-9',
            field: 'measured_zs_ohm',
            circuit: 5,
            boardId: null,
            canonicalValue: '0.4',
            comparisonText: 'Circuit 5, Zs 0.4',
          },
        ],
      ]);
      const res = bundle(
        writes({
          readings: [
            ['circuit_designation::5', { value: 'Cooker', confidence: 0.9 }],
            ['measured_zs_ohm::5', { value: '0.4', confidence: 0.9 }],
          ],
          circuitOps: [createOp(5, 'Cooker')],
        }),
        {
          circuitDesignations: new Map([[5, 'Cooker']]),
          fastAttemptBySlotKey: fastMap,
        }
      );
      const canonical = res.confirmations.find((c) => c.field === 'measured_zs_ohm');
      expect(canonical.fast_correlation_id).toBe('corr-9');
      expect(canonical.text).toBe('Circuit 5, Zs 0.4');
      expect(designationMentions(res.confirmations, 'Cooker')).toBe(1);
    });
  });

  test('bulk-outcome ordering — the merged carrier keeps BOTH the creation wording AND the skip disclosure; substitution sidecar refreshed', () => {
    const entry = { value: 'A', confidence: 0.9 };
    Object.defineProperty(entry, BULK_OUTCOME_CALL_ID, {
      value: 'call-77',
      enumerable: false,
    });
    const res = bundle(
      writes({
        readings: [['wiring_type::3', entry]],
        circuitOps: [createOp(3, 'Downstairs light')],
        bulkOutcomes: [
          {
            callId: 'call-77',
            field: 'wiring_type',
            boardId: null,
            effectiveBoardId: null,
            appliedRefs: [3],
            spareSkippedRefs: [7],
          },
        ],
      }),
      { circuitDesignations: new Map([[3, 'Downstairs light']]) }
    );
    expect(res.confirmations).toHaveLength(1);
    const carrier = res.confirmations[0];
    expect(carrier.text).toBe(
      'Created circuit 3, Downstairs light — wiring type A, skipping 1 spare way'
    );
    const substitution = carrier[CREATE_ACK_SUBSTITUTION];
    expect(substitution.text).toBe('Circuit 3 is now the Downstairs light, skipping 1 spare way');
  });
});
