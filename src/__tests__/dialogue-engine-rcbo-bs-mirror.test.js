/**
 * RCBO BS-number duplicate-prompt fix (2026-05-31).
 *
 * Field repro — session E8C6B716-547A-454C-A507-5D3079F7E24D:
 *   1. Inspector dictated "Our type is a c for circuits 4 to 7."
 *   2. Sonnet recorded ocpd_type and auto-pivoted into the RCBO
 *      script.
 *   3. RCBO walk-through asked "What's the BS number?" → inspector
 *      replied "61008" (the BS code for an RCD, not an RCBO).
 *   4. Engine wrote ocpd_bs_en = "BS EN 61008" but the existing
 *      mirror was gated on "61009" only, so rcd_bs_en stayed empty.
 *   5. nextMissingSlot then picked rcd_bs_en and the engine emitted
 *      the IDENTICAL TTS prompt "What's the BS number?" — inspector
 *      reasonably concluded the system had lost their answer.
 *      Session ended at "Oh, fuck off." then "I give up. Stop."
 *
 * Fix:
 *   - applyDerivations gains "unconditional" semantics — a derivation
 *     with `value` omitted matches every write to that slot.
 *   - rcbo.js's ocpd_bs_en mirrors to rcd_bs_en unconditionally
 *     (was gated on "61009").
 *   - rcd_bs_en in the RCBO schema becomes `volunteeredOnly: true`
 *     so it's never auto-asked, only filled via the mirror or the
 *     inspector's volunteered value. Its question text is also
 *     reworded ("What's the RCD's BS number?") as defence-in-depth.
 */

import { processProtectiveDeviceTurn, rcboSchema } from '../extraction/dialogue-engine/index.js';
import { applyDerivations } from '../extraction/dialogue-engine/helpers/derivations.js';

const SESSION_ID = 'sess_rcbo_mirror';

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

// ---------------------------------------------------------------------------
// applyDerivations — unconditional mirror semantics
// ---------------------------------------------------------------------------

describe('applyDerivations — unconditional mirror', () => {
  test('derivation without `value` mirrors on every write', () => {
    const session = {
      stateSnapshot: { circuits: { 5: {} } },
      dialogueScriptState: { circuit_ref: 5, values: {} },
    };
    const slot = {
      field: 'ocpd_bs_en',
      kind: 'bs_code',
      derivations: [{ mirrors: ['rcd_bs_en'] }],
    };
    applyDerivations({ session, schema: rcboSchema, slot, value: 'BS EN 61008' });
    expect(session.stateSnapshot.circuits[5].rcd_bs_en).toBe('BS EN 61008');
    expect(session.dialogueScriptState.values.rcd_bs_en).toBe('BS EN 61008');
  });

  test('derivation WITH `value` still gates on the literal (back-compat)', () => {
    const session = {
      stateSnapshot: { circuits: { 5: {} } },
      dialogueScriptState: { circuit_ref: 5, values: {} },
    };
    const slot = {
      field: 'ocpd_bs_en',
      kind: 'bs_code',
      derivations: [{ value: '61009', mirrors: ['rcd_bs_en'] }],
    };
    applyDerivations({ session, schema: rcboSchema, slot, value: 'BS EN 60898' });
    // Not 61009 → no mirror, no write.
    expect(session.stateSnapshot.circuits[5].rcd_bs_en).toBeUndefined();
    expect(session.dialogueScriptState.values.rcd_bs_en).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// rcbo.js — schema declarations match the design
// ---------------------------------------------------------------------------

describe('rcbo schema — BS-code slot configuration', () => {
  function findSlot(field) {
    return rcboSchema.slots.find((s) => s.field === field);
  }

  test('ocpd_bs_en mirror is unconditional (no value gate)', () => {
    const slot = findSlot('ocpd_bs_en');
    expect(slot.derivations).toEqual([{ mirrors: ['rcd_bs_en'] }]);
  });

  test('rcd_bs_en is volunteeredOnly so nextMissingSlot never picks it', () => {
    const slot = findSlot('rcd_bs_en');
    expect(slot.volunteeredOnly).toBe(true);
  });

  test('rcd_bs_en still mirrors back to ocpd_bs_en when volunteered', () => {
    const slot = findSlot('rcd_bs_en');
    expect(slot.derivations).toEqual([{ mirrors: ['ocpd_bs_en'] }]);
  });

  test('rcd_bs_en question is distinct from ocpd_bs_en (defence-in-depth)', () => {
    expect(findSlot('rcd_bs_en').question).toBe("What's the RCD's BS number?");
    expect(findSlot('ocpd_bs_en').question).toBe("What's the BS number?");
  });
});

// ---------------------------------------------------------------------------
// Integration — direct RCBO entry + any BS code = single prompt
// ---------------------------------------------------------------------------

describe('RCBO walk-through — single BS-number prompt', () => {
  test('"61008" fills both bs_en fields and engine advances to ocpd_type', () => {
    const ws = new FakeWS();
    const session = buildSession({ 5: {} });
    processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'RCBO on circuit 5.',
      now: 1000,
    });
    // Entry → asks ocpd_bs_en first.
    expect(ws.sent.at(-1).context_field).toBe('ocpd_bs_en');

    processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'BS EN 61008',
      now: 2000,
    });
    // Both bs_en fields populated by the unconditional mirror.
    expect(session.stateSnapshot.circuits[5].ocpd_bs_en).toBe('BS EN 61008');
    expect(session.stateSnapshot.circuits[5].rcd_bs_en).toBe('BS EN 61008');
    // Next ask skips rcd_bs_en (volunteeredOnly) and lands on curve.
    expect(ws.sent.at(-1).context_field).toBe('ocpd_type');
  });

  test('"61009" still fills both fields and advances (no regression on 61009)', () => {
    const ws = new FakeWS();
    const session = buildSession({ 5: {} });
    processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'RCBO on circuit 5.',
      now: 1000,
    });
    processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'BS EN 61009',
      now: 2000,
    });
    expect(session.stateSnapshot.circuits[5].ocpd_bs_en).toBe('BS EN 61009');
    expect(session.stateSnapshot.circuits[5].rcd_bs_en).toBe('BS EN 61009');
    expect(ws.sent.at(-1).context_field).toBe('ocpd_type');
  });

  test('volunteered RCD BS code (uncommon path) mirrors back to ocpd_bs_en', () => {
    const ws = new FakeWS();
    const session = buildSession({ 5: {} });
    processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'RCBO on circuit 5.',
      now: 1000,
    });
    // Inspector volunteers the RCD-named form directly. The
    // namedExtractor on rcd_bs_en captures it; volunteeredOnly stops
    // it being asked, but the mirror derivation still runs on writes
    // and propagates back to ocpd_bs_en.
    processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'The RCD BS code is 61009',
      now: 2000,
    });
    expect(session.stateSnapshot.circuits[5].ocpd_bs_en).toBe('BS EN 61009');
    expect(session.stateSnapshot.circuits[5].rcd_bs_en).toBe('BS EN 61009');
  });
});
