/**
 * `applyDerivations` — unconditional-mirror semantics (2026-05-31).
 *
 * This file used to pin the RCBO BS-number MIRROR: the RCBO schema copied the
 * OCPD standard into `rcd_bs_en` on every write (field repro session
 * E8C6B716, where a gated mirror left the RCD column empty and the engine
 * asked an identical-sounding question twice).
 *
 * PLAN-CS (feedback-2026-09-17, CS-64 / CS-100, under Decision 7) RETIRED
 * that mirror: an RCBO's two standards are not always equal in the field
 * (61008 against 61009), so a mirror wrote a wrong value into a certificate
 * column, and the two identical RCBO BS extractors let an RCD answer
 * overwrite the OCPD standard. Both RCBO BS slots are now ordinary asked
 * slots with distinct questions. The RCBO walk-through coverage lives in
 * `dialogue-engine-rcbo-bs-plan-cs.test.js`.
 *
 * What stays here: `applyDerivations` itself is unchanged, and still honours
 * a `mirrors` derivation when handed one, so its semantics stay pinned with
 * literal slot objects — no shipped schema declares a mirror any more.
 */

import { rcboSchema } from '../extraction/dialogue-engine/index.js';
import { applyDerivations } from '../extraction/dialogue-engine/helpers/derivations.js';

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
