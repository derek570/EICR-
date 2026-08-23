// PLAN-B B3 (feedback ids 128 + 131) — the answer-resolver's fourth
// designation matcher: census DECORATION (never row removal) + lane-side
// FILTERING.
//
// The census (`collectAvailableCircuits` in stage6-dispatcher-ask.js) is the
// authority for "all circuits" fan-out, explicit-ref validation,
// multi-description follow-ups, and escalation metadata — so a bare
// "Circuit" row must STAY in the census (broadcast/numeric answers keep
// working) while becoming invisible to the designation-matching lanes
// (raw-exact included: replies "Circuit"/"the circuit" must not
// auto-resolve a pending write to it).

import { jest } from '@jest/globals';
import {
  decorateCircuitCensusRow,
  resolveCircuitAnswer,
} from '../extraction/stage6-answer-resolver.js';
import { createAskDispatcher } from '../extraction/stage6-dispatcher-ask.js';
import { createPendingAsksRegistry } from '../extraction/stage6-pending-asks-registry.js';

const PENDING = {
  tool: 'record_reading',
  field: 'number_of_points',
  value: '4',
  confidence: 0.95,
  source_turn_id: 't1',
};

// The resolver lanes must behave identically whether the census was
// decorated up front (production path) or arrives raw (legacy/test callers
// — the lanes recompute per row).
const CENSUS_SHAPES = [
  ['decorated census rows', (circuits) => circuits.map(decorateCircuitCensusRow)],
  ['undecorated arrays (lanes recompute)', (circuits) => circuits],
];

describe('decorateCircuitCensusRow — census decoration (B3)', () => {
  test('keeps raw fields verbatim and adds canonical value + eligibility', () => {
    expect(
      decorateCircuitCensusRow({ circuit_ref: 1, circuit_designation: 'Upstairs lighting circuit' })
    ).toEqual({
      circuit_ref: 1,
      circuit_designation: 'Upstairs lighting circuit',
      designation_match_value: 'Upstairs lighting',
      designation_match_eligibility: 'full',
    });
  });

  test('empty-canonical rows are ineligible (bare "Circuit"/"Circuits", blank labels)', () => {
    expect(
      decorateCircuitCensusRow({ circuit_ref: 1, circuit_designation: 'Circuit' })
    ).toMatchObject({ designation_match_value: '', designation_match_eligibility: 'ineligible' });
    expect(
      decorateCircuitCensusRow({ circuit_ref: 2, circuit_designation: 'Circuits' })
        .designation_match_eligibility
    ).toBe('ineligible');
    expect(
      decorateCircuitCensusRow({ circuit_ref: 3, circuit_designation: '' })
        .designation_match_eligibility
    ).toBe('ineligible');
  });

  test('short-remainder tiers mirror the twins guard', () => {
    expect(
      decorateCircuitCensusRow({ circuit_ref: 1, circuit_designation: 'Circuit A' })
    ).toMatchObject({
      designation_match_value: 'A',
      designation_match_eligibility: 'bounded_only',
    });
    expect(
      decorateCircuitCensusRow({ circuit_ref: 2, circuit_designation: 'Circuit 7' })
    ).toMatchObject({
      designation_match_value: '7',
      designation_match_eligibility: 'bounded_only',
    });
    expect(
      decorateCircuitCensusRow({ circuit_ref: 3, circuit_designation: 'EV' })
        .designation_match_eligibility
    ).toBe('token_boundary');
    expect(
      decorateCircuitCensusRow({ circuit_ref: 4, circuit_designation: 'EV charger' })
        .designation_match_eligibility
    ).toBe('full');
  });
});

describe.each(CENSUS_SHAPES)('resolveCircuitAnswer over %s', (_shapeName, shape) => {
  const MIXED_CENSUS = shape([
    { circuit_ref: 1, circuit_designation: 'Circuit' },
    { circuit_ref: 2, circuit_designation: 'Smoke alarm' },
    { circuit_ref: 4, circuit_designation: 'Upstairs lighting circuit' },
  ]);

  test('a bare-"Circuit" row cannot match replies BY DESIGNATION ("Circuit" / "the circuit")', () => {
    for (const reply of ['Circuit', 'the circuit']) {
      const verdict = resolveCircuitAnswer({
        userText: reply,
        pendingWrite: PENDING,
        availableCircuits: MIXED_CENSUS,
      });
      expect(verdict.kind).toBe('escalate');
    }
  });

  test('the bare-"Circuit" row still receives "all circuits" broadcast', () => {
    const verdict = resolveCircuitAnswer({
      userText: 'all circuits',
      pendingWrite: PENDING,
      availableCircuits: MIXED_CENSUS,
    });
    expect(verdict.kind).toBe('auto_resolve');
    expect(verdict.writes.map((w) => w.circuit).sort((a, b) => a - b)).toEqual([1, 2, 4]);
  });

  test('the bare-"Circuit" row still resolves via explicit "circuit N"', () => {
    const verdict = resolveCircuitAnswer({
      userText: 'circuit 1',
      pendingWrite: PENDING,
      availableCircuits: MIXED_CENSUS,
    });
    expect(verdict.kind).toBe('auto_resolve');
    expect(verdict.writes).toEqual([expect.objectContaining({ circuit: 1 })]);
  });

  test('the bare-"Circuit" row still receives explicit multi-ref writes (mixed ref + description)', () => {
    const verdict = resolveCircuitAnswer({
      userText: 'circuit 1 and the smoke alarm',
      pendingWrite: PENDING,
      availableCircuits: MIXED_CENSUS,
    });
    expect(verdict.kind).toBe('auto_resolve');
    expect(verdict.writes.map((w) => w.circuit).sort((a, b) => a - b)).toEqual([1, 2]);
  });

  test('scalar answer against a dirty-but-meaningful designation resolves', () => {
    const verdict = resolveCircuitAnswer({
      userText: 'upstairs lighting',
      pendingWrite: PENDING,
      availableCircuits: MIXED_CENSUS,
    });
    expect(verdict.kind).toBe('auto_resolve');
    expect(verdict.writes).toEqual([expect.objectContaining({ circuit: 4 })]);
  });

  test('multi-description answer against dirty designations resolves both spans', () => {
    const verdict = resolveCircuitAnswer({
      userText: 'upstairs lighting and the smoke alarm',
      pendingWrite: PENDING,
      availableCircuits: MIXED_CENSUS,
    });
    expect(verdict.kind).toBe('auto_resolve');
    expect(verdict.writes.map((w) => w.circuit).sort((a, b) => a - b)).toEqual([2, 4]);
  });

  describe('short-remainder rule inside the resolver lanes', () => {
    const SHORT_CENSUS = shape([
      { circuit_ref: 5, circuit_designation: 'Circuit A' },
      { circuit_ref: 2, circuit_designation: 'Smoke alarm' },
    ]);

    test('"the A circuit" (circuit-noun-adjacent, wrapper-stripped) resolves to the lettered way', () => {
      const verdict = resolveCircuitAnswer({
        userText: 'the A circuit',
        pendingWrite: PENDING,
        availableCircuits: SHORT_CENSUS,
      });
      expect(verdict.kind).toBe('auto_resolve');
      expect(verdict.writes).toEqual([expect.objectContaining({ circuit: 5 })]);
    });

    test('a bare "a" embedded in prose fails CLOSED (escalates, never matches "Circuit A")', () => {
      const verdict = resolveCircuitAnswer({
        userText: 'a bedroom radial',
        pendingWrite: PENDING,
        availableCircuits: SHORT_CENSUS,
      });
      expect(verdict.kind).toBe('escalate');
    });

    test('numeric-only remainder vs a dictated value must NOT match', () => {
      // Stored "Circuit 7" canonicalises to "7" — a decimal reading-shaped
      // reply ("0.7") whose cleaned residue contains that digit must fail
      // CLOSED, never designation-match to ref 3.
      const verdict = resolveCircuitAnswer({
        userText: '0.7',
        pendingWrite: PENDING,
        availableCircuits: shape([
          { circuit_ref: 3, circuit_designation: 'Circuit 7' },
          { circuit_ref: 2, circuit_designation: 'Smoke alarm' },
        ]),
      });
      expect(verdict.kind).toBe('escalate');
    });

    test('the numeric-remainder row stays reachable through its FULL raw designation (shipped lane)', () => {
      // PRE-EXISTING behaviour locked, not introduced by B3: the stop-word
      // exact lane reduces raw "Circuit 7" to "7", so the bare reply "7"
      // whole-designation-matches ref 3 ahead of the numeric grammar. B3's
      // numeric exclusion only stops NEW matches minted from the canonical
      // remainder (substring/fuzzy/bounded lanes) — raw-designation
      // ownership is preserved for broadcast/list/writes and this lane.
      const verdict = resolveCircuitAnswer({
        userText: '7',
        pendingWrite: PENDING,
        availableCircuits: shape([
          { circuit_ref: 3, circuit_designation: 'Circuit 7' },
          { circuit_ref: 2, circuit_designation: 'Smoke alarm' },
        ]),
      });
      expect(verdict.kind).toBe('auto_resolve');
      expect(verdict.writes).toEqual([expect.objectContaining({ circuit: 3 })]);
    });
  });

  describe('Codex cycle-1 guards', () => {
    const STRICT_CENSUS = shape([
      { circuit_ref: 5, circuit_designation: 'Circuit A' },
      { circuit_ref: 6, circuit_designation: 'Garage' },
    ]);

    test('#1 — generic "a circuit" / "for a circuit" match NOTHING (escalate)', () => {
      for (const reply of ['a circuit', 'for a circuit']) {
        const verdict = resolveCircuitAnswer({
          userText: reply,
          pendingWrite: PENDING,
          availableCircuits: STRICT_CENSUS,
        });
        expect(verdict.kind).toBe('escalate');
      }
    });

    test('#2 — bounded "A" resolves Circuit A uniquely, never ambiguous with Garage', () => {
      const verdict = resolveCircuitAnswer({
        userText: 'A',
        pendingWrite: PENDING,
        availableCircuits: STRICT_CENSUS,
      });
      expect(verdict.kind).toBe('auto_resolve');
      expect(verdict.writes).toEqual([expect.objectContaining({ circuit: 5 })]);
    });

    test('#2 — "the A circuit" resolves Circuit A uniquely', () => {
      const verdict = resolveCircuitAnswer({
        userText: 'the A circuit',
        pendingWrite: PENDING,
        availableCircuits: STRICT_CENSUS,
      });
      expect(verdict.kind).toBe('auto_resolve');
      expect(verdict.writes).toEqual([expect.objectContaining({ circuit: 5 })]);
    });

    const COLLISION_CENSUS = shape([
      { circuit_ref: 1, circuit_designation: 'Upstairs lighting circuit' },
      { circuit_ref: 2, circuit_designation: 'Upstairs lighting' },
      { circuit_ref: 3, circuit_designation: 'Smoke alarm' },
    ]);

    test('#4 — raw-exact never defeats canonical ambiguity (scalar, dirty AND clean replies)', () => {
      for (const reply of ['upstairs lighting circuit', 'upstairs lighting']) {
        const verdict = resolveCircuitAnswer({
          userText: reply,
          pendingWrite: PENDING,
          availableCircuits: COLLISION_CENSUS,
        });
        expect(verdict.kind).toBe('escalate');
        expect(verdict.parsed_hint).toMatch(/ambiguous_designation_match:1,2/);
      }
    });

    test('#4 — raw-exact never defeats canonical ambiguity (multi-description)', () => {
      const verdict = resolveCircuitAnswer({
        userText: 'upstairs lighting circuit and the smoke alarm',
        pendingWrite: PENDING,
        availableCircuits: COLLISION_CENSUS,
      });
      // The colliding span must become an ask (candidates 1,2), never a
      // silent write to either colliding row; the unambiguous smoke-alarm
      // span still resolves.
      expect(verdict.kind).toBe('partial_resolve');
      expect(verdict.writes).toEqual([expect.objectContaining({ circuit: 3 })]);
      expect(verdict.unresolved).toEqual([
        expect.objectContaining({ disposition: 'ask', candidates: [1, 2] }),
      ]);
    });

    test('M4 — collision guard uses the canonical-lane (stop-word-stripping) equivalence', () => {
      // {"Kitchen", "The Kitchen Circuit"} share the canonical-lane key
      // "kitchen"; the stop-word-RETAINING raw function missed this
      // collision and raw priority silently auto-resolved "Kitchen".
      const census = shape([
        { circuit_ref: 1, circuit_designation: 'Kitchen' },
        { circuit_ref: 2, circuit_designation: 'The Kitchen Circuit' },
      ]);
      for (const reply of ['kitchen', 'the kitchen circuit']) {
        const verdict = resolveCircuitAnswer({
          userText: reply,
          pendingWrite: PENDING,
          availableCircuits: census,
        });
        expect(verdict.kind).toBe('escalate');
        expect(verdict.parsed_hint).toMatch(/ambiguous_designation_match:1,2/);
      }
    });

    test('M4 — single-letter strict reply never resolves a normal row ("A garage radial")', () => {
      const census = shape([
        { circuit_ref: 5, circuit_designation: 'Circuit A' },
        { circuit_ref: 6, circuit_designation: 'A garage radial' },
      ]);
      for (const reply of ['A', 'the A circuit']) {
        const verdict = resolveCircuitAnswer({
          userText: reply,
          pendingWrite: PENDING,
          availableCircuits: census,
        });
        expect(verdict.kind).toBe('auto_resolve');
        expect(verdict.writes).toEqual([expect.objectContaining({ circuit: 5 })]);
      }
    });

    test('collision guard leaves a unique dirty designation resolving (no false ambiguity)', () => {
      const verdict = resolveCircuitAnswer({
        userText: 'upstairs lighting circuit',
        pendingWrite: PENDING,
        availableCircuits: shape([
          { circuit_ref: 1, circuit_designation: 'Upstairs lighting circuit' },
          { circuit_ref: 3, circuit_designation: 'Smoke alarm' },
        ]),
      });
      expect(verdict.kind).toBe('auto_resolve');
      expect(verdict.writes).toEqual([expect.objectContaining({ circuit: 1 })]);
    });
  });
});

// ---------------------------------------------------------------------------
// Integration — the production census (collectAvailableCircuits) really is
// decorated: drive the ask dispatcher end-to-end with a session snapshot.
// Harness mirrors stage6-dispatcher-ask-pending-write.test.js.
// ---------------------------------------------------------------------------

const F7_OPEN_WS = { readyState: 1, OPEN: 1, send() {} };

const validInput = (overrides = {}) => ({
  question: 'Which circuit is the 4 points for?',
  reason: 'missing_context',
  context_field: 'number_of_points',
  context_circuit: null,
  expected_answer_shape: 'circuit_ref',
  ...overrides,
});

const buildSession = (circuits = []) => {
  const circuitMap = {};
  circuits.forEach((c) => {
    circuitMap[c.circuit_ref] = { circuit_designation: c.circuit_designation };
  });
  return { sessionId: 'sess-b3', stateSnapshot: { circuits: circuitMap } };
};

const noopLogger = () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() });

async function driveAsk({ session, reply }) {
  const pendingAsks = createPendingAsksRegistry();
  const autoResolveWrite = jest.fn().mockResolvedValue({ ok: true, body: { ok: true } });
  const dispatcher = createAskDispatcher(session, noopLogger(), 'turn-1', pendingAsks, F7_OPEN_WS, {
    autoResolveWrite,
  });
  const callPromise = dispatcher(
    {
      tool_call_id: 'toolu_b3',
      name: 'ask_user',
      input: validInput({ pending_write: { ...PENDING } }),
    },
    {}
  );
  await new Promise((r) => setImmediate(r));
  pendingAsks.resolve('toolu_b3', { answered: true, user_text: reply });
  const env = await callPromise;
  return { body: JSON.parse(env.content), autoResolveWrite };
}

describe('census decoration wired through createAskDispatcher (collectAvailableCircuits)', () => {
  const CIRCUITS = [
    { circuit_ref: 1, circuit_designation: 'Circuit' },
    { circuit_ref: 2, circuit_designation: 'Smoke alarm' },
  ];

  test('reply "the circuit" escalates instead of auto-resolving to the bare-"Circuit" row', async () => {
    const { body, autoResolveWrite } = await driveAsk({
      session: buildSession(CIRCUITS),
      reply: 'the circuit',
    });
    expect(body.auto_resolved).toBe(false);
    expect(body.match_status).toBe('escalated');
    expect(autoResolveWrite).not.toHaveBeenCalled();
    // The escalation census carries the decoration — proof the production
    // path decorates at construction, not just in unit tests.
    expect(body.available_circuits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          circuit_ref: 1,
          circuit_designation: 'Circuit',
          designation_match_eligibility: 'ineligible',
        }),
        expect.objectContaining({
          circuit_ref: 2,
          circuit_designation: 'Smoke alarm',
          designation_match_eligibility: 'full',
        }),
      ])
    );
  });

  test('reply "all circuits" still fans out to the bare-"Circuit" row', async () => {
    const { body } = await driveAsk({
      session: buildSession(CIRCUITS),
      reply: 'all circuits',
    });
    expect(body.auto_resolved).toBe(true);
    expect(body.resolved_writes.map((w) => w.circuit).sort((a, b) => a - b)).toEqual([1, 2]);
  });
});
