// PLAN-B B3 (feedback id 131, field session 17821FFA) — edge-token
// designation tolerance for the two hand-duplicated PASS-1-ONLY script
// matchers (insulation-resistance-script.js + ring-continuity-script.js).
//
// Every vector runs against BOTH twins via describe.each: their
// findCircuitByDesignation implementations are deliberate byte-identical
// mirrors and must stay behaviourally identical. The pass-2 fold-table
// (morphology) vectors deliberately do NOT appear here — the twins are
// pass-1-only by design (see the B3 helper block in each script).

import { __testing__ as irTesting } from '../extraction/insulation-resistance-script.js';
import { __testing__ as ringTesting } from '../extraction/ring-continuity-script.js';

const TWINS = [
  ['insulation-resistance', irTesting.findCircuitByDesignation],
  ['ring-continuity', ringTesting.findCircuitByDesignation],
];

function sessionWith(circuitsByRef) {
  const circuits = {};
  Object.entries(circuitsByRef).forEach(([ref, circuit_designation]) => {
    circuits[ref] = { circuit_designation };
  });
  return { stateSnapshot: { circuits } };
}

describe.each(TWINS)(
  '%s findCircuitByDesignation — PLAN-B B3 edge-token tolerance',
  (_twinName, find) => {
    test('evidence sentence matches a stored designation with a trailing "circuit" token (id 131)', () => {
      const session = sessionWith({ 1: 'Upstairs lighting circuit', 2: 'Kitchen sockets' });
      expect(find(session, 'insulation resistance for upstairs lighting live to live is lim')).toBe(
        1
      );
    });

    test('leading edge token is also tolerated ("Circuit upstairs lighting")', () => {
      const session = sessionWith({ 1: 'Circuit upstairs lighting' });
      expect(find(session, 'upstairs lighting reading')).toBe(1);
    });

    test('stored bare "Circuit" yields ZERO candidates for text containing the word "circuit"', () => {
      const session = sessionWith({ 1: 'Circuit' });
      expect(find(session, 'the circuit reading is 200')).toBeNull();
      expect(find(session, 'circuit')).toBeNull();
    });

    test('stored bare "Circuits" yields ZERO candidates too', () => {
      const session = sessionWith({ 1: 'Circuits' });
      expect(find(session, 'all the circuits look fine')).toBeNull();
    });

    test('empty-canonical exclusion does not disturb a sibling meaningful row', () => {
      const session = sessionWith({ 1: 'Circuit', 2: 'Downstairs sockets' });
      expect(find(session, 'downstairs sockets')).toBe(2);
    });

    test('stored "Ring circuit sockets" (interior token kept) vs generic replies → zero candidates', () => {
      const session = sessionWith({ 1: 'Ring circuit sockets' });
      expect(find(session, 'circuit')).toBeNull();
      expect(find(session, 'the circuit')).toBeNull();
    });

    describe('short-remainder guard — stored "Circuit A" (canonical "A")', () => {
      const session = () => sessionWith({ 3: 'Circuit A' });

      test('the article "a" embedded in prose must NOT match', () => {
        expect(find(session(), 'insulation resistance for a bedroom radial is lim')).toBeNull();
      });

      test('"circuit A is LIM" DOES match (circuit-noun adjacency)', () => {
        expect(find(session(), 'circuit a is lim')).toBe(3);
      });

      test('bounded whole-designation reply "A" (and "A.") DOES match', () => {
        expect(find(session(), 'a')).toBe(3);
        expect(find(session(), 'a.')).toBe(3);
      });

      test('"the A circuit" and "A way" adjacency forms match', () => {
        expect(find(session(), 'the a circuit')).toBe(3);
        expect(find(session(), 'a way')).toBe(3);
      });
    });

    test('numeric remainder vs a dictated value must NOT match (stored "Circuit 7")', () => {
      const session = sessionWith({ 2: 'Circuit 7' });
      expect(find(session, 'live to live is 7')).toBeNull();
      expect(find(session, '0.7')).toBeNull();
    });

    test('pre-existing behaviour preserved: exact + bidirectional substring on clean designations', () => {
      const session = sessionWith({ 1: 'Downstairs sockets' });
      expect(find(session, 'downstairs sockets')).toBe(1);
      expect(find(session, 'downstairs')).toBe(1);
      expect(find(session, "it's the downstairs sockets one")).toBe(1);
    });

    test('ambiguity still returns null (two rows share the canonical remainder)', () => {
      const session = sessionWith({
        1: 'Upstairs lighting circuit',
        2: 'Upstairs lighting',
      });
      expect(find(session, 'upstairs lighting')).toBeNull();
    });

    describe('Codex cycle-1 #1 — closed sanctioned grammar only', () => {
      test('generic "a circuit" / "for a circuit" never match stored "Circuit A"', () => {
        const session = sessionWith({ 3: 'Circuit A' });
        expect(find(session, 'a circuit')).toBeNull();
        expect(find(session, 'for a circuit')).toBeNull();
      });
    });

    describe('Codex cycle-1 #2 — query-side short-token classification', () => {
      const session = () => sessionWith({ 3: 'Circuit A', 4: 'Garage' });

      test('"the A circuit" resolves Circuit A uniquely — never ambiguous with Garage', () => {
        expect(find(session(), 'the a circuit')).toBe(3);
      });

      test('bounded "A" resolves uniquely — the strict query never substring-hits "Garage"', () => {
        expect(find(session(), 'a')).toBe(3);
      });

      test('"a circuit" matches NOTHING', () => {
        expect(find(session(), 'a circuit')).toBeNull();
      });

      test('short query "EV" whole-token-matches "EV charger" but never "Seven bells"', () => {
        const s = sessionWith({ 1: 'EV charger', 2: 'Seven bells' });
        expect(find(s, 'ev')).toBe(1);
      });
    });

    describe('Codex cycle-1 #3 — board-scoped circuit walk', () => {
      const multiBoardSession = () => ({
        stateSnapshot: {
          boards: [
            { id: 'main', board_type: 'main' },
            { id: 'db2', board_type: 'sub' },
          ],
          currentBoardId: 'db2',
          circuits: {
            // Main-board legacy bare-numeric key and a sub-board composite
            // key SHARING ref 2, with different dirty designations.
            2: { circuit_designation: 'Upstairs lighting circuit' },
            'db2::2': {
              board_id: 'db2',
              circuit: 2,
              circuit_designation: 'Garage sockets circuit',
            },
          },
        },
      });

      test('on a sub-board the twin matches the SUB designation and never main’s', () => {
        const session = multiBoardSession();
        expect(find(session, 'garage sockets')).toBe(2);
        expect(find(session, 'upstairs lighting is lim')).toBeNull();
      });

      test('on the main board the main designation matches and the sub row is invisible', () => {
        const session = multiBoardSession();
        session.stateSnapshot.currentBoardId = 'main';
        expect(find(session, 'upstairs lighting is lim')).toBe(2);
        expect(find(session, 'garage sockets')).toBeNull();
      });
    });
  }
);
