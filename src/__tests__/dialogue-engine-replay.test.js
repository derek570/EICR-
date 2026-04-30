/**
 * Replay corpus — runs identical scenarios through BOTH the legacy
 * per-domain scripts and the new dialogue engine, asserting byte-
 * identical wire output. The strongest verification that the engine
 * is a faithful drop-in for the legacy code.
 *
 * Scenarios are drawn from real field sessions whose reproductions
 * already drive the existing 190 ring/IR unit tests:
 *   - B107472D — fast-fragmenting ring continuity (the bug that
 *     motivated the script)
 *   - 74201B27 — designation answer to "Which circuit?"
 *   - 361A638D — values dictated before the circuit
 *   - 6754FE6E — IR walk-through with installation→insulation alias
 *   - BBE66264 — 59 Chucklesville Road (today's bucket.designation
 *                bug, ring continuity from existing R1+Rn → asks CPC)
 *
 * Each scenario records the wire emit sequence both implementations
 * produce. The legacy file paths are fed as imports here ALONGSIDE
 * the engine wrappers — the legacy *-script.js files stay in tree
 * specifically so this verification is possible. They will be deleted
 * after PR2 ships and field tests confirm no regressions.
 */

import {
  processRingContinuityTurn as engineRing,
  processInsulationResistanceTurn as engineIR,
} from '../extraction/dialogue-engine/index.js';
import { processRingContinuityTurn as legacyRing } from '../extraction/ring-continuity-script.js';
import { processInsulationResistanceTurn as legacyIR } from '../extraction/insulation-resistance-script.js';

const SESSION_ID = 'sess_replay';

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
  return { sessionId: SESSION_ID, stateSnapshot: { circuits: cloneCircuits(circuits) } };
}

function cloneCircuits(circuits) {
  // Deep clone so the legacy and engine runs don't share mutable state.
  return JSON.parse(JSON.stringify(circuits));
}

/**
 * Tool-call IDs include the `now` argument as a millisecond timestamp.
 * Each scenario uses fixed `now` values per turn so legacy + engine
 * produce identical IDs. Wire emits are otherwise byte-identical.
 */
function runScenario(processor, transcripts, initialCircuits) {
  const ws = new FakeWS();
  const session = buildSession(initialCircuits);
  for (const { text, now } of transcripts) {
    processor({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: text,
      logger: null,
      now,
    });
  }
  return {
    sent: ws.sent,
    snapshot: session.stateSnapshot,
  };
}

/**
 * Compare two wire-emit sequences. The engine and legacy paths each
 * return their own emit array; they must match element-for-element.
 *
 * Snapshots are compared by `circuits` map; small spurious differences
 * in unused fields are tolerated by comparing only the snapshot keys
 * the legacy script writes.
 */
function expectIdentical(engineRun, legacyRun) {
  expect(engineRun.sent).toEqual(legacyRun.sent);
  expect(engineRun.snapshot.circuits).toEqual(legacyRun.snapshot.circuits);
}

// ---------------------------------------------------------------------------
// Ring continuity scenarios
// ---------------------------------------------------------------------------

describe('replay — ring continuity', () => {
  test('B107472D: fast-fragmenting "Lives are 0.43" / "Neutrals are." / "0.43" / "earths 0.78"', () => {
    const transcripts = [
      { text: 'Ring continuity for circuit 13.', now: 1000 },
      { text: 'Lives are 0.43.', now: 2000 },
      { text: 'Neutrals are.', now: 3000 }, // no value — re-asks neutrals
      { text: '0.43.', now: 4000 }, // bare value lands on neutrals
      { text: 'Earths are 0.78.', now: 5000 },
    ];
    const initialCircuits = { 13: {} };
    const engineRun = runScenario(engineRing, transcripts, initialCircuits);
    const legacyRun = runScenario(legacyRing, transcripts, initialCircuits);
    expectIdentical(engineRun, legacyRun);
  });

  test('74201B27: entry without circuit → designation answer drains pending writes', () => {
    const transcripts = [
      { text: 'Ring continuity is lives are 0.75.', now: 1000 },
      { text: 'downstairs sockets', now: 2000 },
      { text: 'Note tools are 0.75.', now: 3000 }, // garbled "neutrals" → bare value fallback
      { text: 'Earths 0.78.', now: 4000 },
    ];
    const initialCircuits = { 1: { circuit_designation: 'downstairs sockets' } };
    const engineRun = runScenario(engineRing, transcripts, initialCircuits);
    const legacyRun = runScenario(legacyRing, transcripts, initialCircuits);
    expectIdentical(engineRun, legacyRun);
  });

  test('361A638D: bare ring entry → value-only turns queue → designation resolves', () => {
    const transcripts = [
      { text: 'ring continuity', now: 1000 },
      { text: 'Uh, the lives are 0.86.', now: 2000 },
      { text: 'downstairs sockets', now: 3000 },
    ];
    const initialCircuits = { 1: { circuit_designation: 'downstairs sockets' } };
    const engineRun = runScenario(engineRing, transcripts, initialCircuits);
    const legacyRun = runScenario(legacyRing, transcripts, initialCircuits);
    expectIdentical(engineRun, legacyRun);
  });

  test('BBE66264 (Chucklesville): existing R1+Rn → asks CPC immediately', () => {
    const transcripts = [{ text: 'Ring continuity for upstairs sockets.', now: 1000 }];
    const initialCircuits = {
      1: { circuit_designation: 'Cooker' },
      2: {
        circuit_designation: 'Upstairs Sockets',
        ring_r1_ohm: '0.83',
        ring_rn_ohm: '0.82',
      },
    };
    const engineRun = runScenario(engineRing, transcripts, initialCircuits);
    const legacyRun = runScenario(legacyRing, transcripts, initialCircuits);
    expectIdentical(engineRun, legacyRun);
  });

  test('topic switch mid-script: clear state + fallthrough on Zs', () => {
    const transcripts = [
      { text: 'Ring continuity for circuit 13.', now: 1000 },
      { text: 'Zs is 0.62.', now: 2000 },
    ];
    const initialCircuits = { 13: {} };
    const engineRun = runScenario(engineRing, transcripts, initialCircuits);
    const legacyRun = runScenario(legacyRing, transcripts, initialCircuits);
    expectIdentical(engineRun, legacyRun);
  });

  test('cancel mid-script preserves writes', () => {
    const transcripts = [
      { text: 'Ring continuity for circuit 13.', now: 1000 },
      { text: 'Lives are 0.43.', now: 2000 },
      { text: 'cancel that', now: 3000 },
    ];
    const initialCircuits = { 13: {} };
    const engineRun = runScenario(engineRing, transcripts, initialCircuits);
    const legacyRun = runScenario(legacyRing, transcripts, initialCircuits);
    expectIdentical(engineRun, legacyRun);
  });

  test('full happy path: lives → neutrals → CPC → completion', () => {
    const transcripts = [
      { text: 'Ring continuity for circuit 7.', now: 1000 },
      { text: '0.43', now: 2000 },
      { text: '0.45', now: 3000 },
      { text: '1.20', now: 4000 },
    ];
    const initialCircuits = { 7: {} };
    const engineRun = runScenario(engineRing, transcripts, initialCircuits);
    const legacyRun = runScenario(legacyRing, transcripts, initialCircuits);
    expectIdentical(engineRun, legacyRun);
  });

  test('different ring entry mid-script switches circuit', () => {
    const transcripts = [
      { text: 'Ring continuity for circuit 7.', now: 1000 },
      { text: 'Lives are 0.43.', now: 2000 },
      { text: 'Ring continuity for circuit 13.', now: 3000 },
    ];
    const initialCircuits = { 7: {}, 13: {} };
    const engineRun = runScenario(engineRing, transcripts, initialCircuits);
    const legacyRun = runScenario(legacyRing, transcripts, initialCircuits);
    expectIdentical(engineRun, legacyRun);
  });
});

// ---------------------------------------------------------------------------
// IR scenarios
// ---------------------------------------------------------------------------

describe('replay — insulation resistance', () => {
  test('6754FE6E: "installation resistance for upstairs sockets" → walk-through', () => {
    const transcripts = [
      { text: 'Installation resistance for upstairs sockets.', now: 1000 },
      { text: 'Live to live 200.', now: 2000 },
      { text: 'Live to earth over 999.', now: 3000 },
      { text: '500', now: 4000 },
    ];
    const initialCircuits = {
      1: { circuit_designation: 'upstairs sockets' },
    };
    const engineRun = runScenario(engineIR, transcripts, initialCircuits);
    const legacyRun = runScenario(legacyIR, transcripts, initialCircuits);
    expectIdentical(engineRun, legacyRun);
  });

  test('IR full happy path: L-L → L-E → voltage', () => {
    const transcripts = [
      { text: 'Insulation resistance for circuit 5.', now: 1000 },
      { text: '200', now: 2000 },
      { text: 'over 999', now: 3000 },
      { text: '500', now: 4000 },
    ];
    const initialCircuits = { 5: {} };
    const engineRun = runScenario(engineIR, transcripts, initialCircuits);
    const legacyRun = runScenario(legacyIR, transcripts, initialCircuits);
    expectIdentical(engineRun, legacyRun);
  });

  test('IR voltage phase silently finishes on unparseable reply', () => {
    const transcripts = [
      { text: 'Insulation resistance for circuit 5.', now: 1000 },
      { text: '200', now: 2000 },
      { text: '200', now: 3000 },
      { text: 'uhh come back later', now: 4000 },
    ];
    const initialCircuits = { 5: {} };
    const engineRun = runScenario(engineIR, transcripts, initialCircuits);
    const legacyRun = runScenario(legacyIR, transcripts, initialCircuits);
    expectIdentical(engineRun, legacyRun);
  });

  test('IR cancel during readings shows N of 2 (voltage excluded)', () => {
    const transcripts = [
      { text: 'Insulation resistance for circuit 5.', now: 1000 },
      { text: '200', now: 2000 },
      { text: 'cancel', now: 3000 },
    ];
    const initialCircuits = { 5: {} };
    const engineRun = runScenario(engineIR, transcripts, initialCircuits);
    const legacyRun = runScenario(legacyIR, transcripts, initialCircuits);
    expectIdentical(engineRun, legacyRun);
  });

  test('IR topic switch on Zs falls through with same transcript', () => {
    const transcripts = [
      { text: 'Insulation resistance for circuit 5.', now: 1000 },
      { text: 'Zs is 0.62.', now: 2000 },
    ];
    const initialCircuits = { 5: {} };
    const engineRun = runScenario(engineIR, transcripts, initialCircuits);
    const legacyRun = runScenario(legacyIR, transcripts, initialCircuits);
    expectIdentical(engineRun, legacyRun);
  });
});
