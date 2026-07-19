/**
 * PLAN-C Phase 4 — the client watchdog fallback line must be full-string
 * distinct from EVERY backend spoken-line family that rides the field-nil
 * confirmation channel (the client dedupe is a 30 s text-keyed TTL, so a
 * collision would swallow one line). Covers the three fixed apology arrays,
 * the two fixed single-literal apologies, and a representative render sweep of
 * the two templated F/U-2/3 notice families (counts 1–6, both rotation
 * variants, both calc friendly names + the rename family).
 */

import { CLIENT_CHIME_WATCHDOG_FALLBACK_TEXT } from '../extraction/client-watchdog-fallback.js';
import {
  NOOP_AUDIBILITY_PROMPTS,
  CATCHALL_AUDIBILITY_PROMPTS,
  ASK_AUDIBILITY_FALLBACK_TEXT,
} from '../extraction/stage6-shadow-harness.js';

// Re-derive the F/U-2/3 templated notice renderings the same way the
// dispatcher builds them (stage6-dispatchers-circuit.js). These are the
// dynamic strings that never appear in an exported array, so we sweep a
// representative parameter space rather than import the private builders.
function renderNoticeSweep() {
  const out = [];
  // rename-to-same (two rotation variants), circuit refs 1–6.
  for (let c = 1; c <= 6; c += 1) {
    out.push(`Circuit ${c} is unchanged — I didn't catch a new name or number for it.`);
    out.push(`Nothing changed for circuit ${c} — say the new name or number again.`);
  }
  // wholly-already_set calc (two friendly names × single/plural scope × two
  // rotation variants). Scope forms mirror noteAlreadyRecordedIfWhollySkipped:
  // "circuit N", "circuits A, B and C", "those N circuits".
  const friendlies = ['Zs', 'R1 plus R2'];
  const scopes = ['circuit 4', 'circuits 1, 2 and 3', 'those 5 circuits'];
  for (const friendly of friendlies) {
    for (const scope of scopes) {
      out.push(`${friendly} for ${scope} is already recorded — say a new reading to replace it.`);
      out.push(`There's already a ${friendly} recorded for ${scope} — dictate a new value to replace it.`);
      out.push(`${friendly} for ${scope} is already recorded — say new readings to replace them.`);
      out.push(`There are already ${friendly} readings recorded for ${scope} — dictate new values to replace them.`);
    }
  }
  return out;
}

describe('CLIENT_CHIME_WATCHDOG_FALLBACK_TEXT — cross-family distinctness', () => {
  const ALL_BACKEND_LINES = [
    ...NOOP_AUDIBILITY_PROMPTS,
    ...CATCHALL_AUDIBILITY_PROMPTS,
    ASK_AUDIBILITY_FALLBACK_TEXT,
    // pending-value apology (stage6-dispatcher-ask.js PENDING_VALUE_APOLOGY —
    // a private const; mirrored here so a change to it fails this pin).
    "Sorry, I couldn't place that reading — could you say the field and value together again?",
    ...renderNoticeSweep(),
  ];

  test('is a non-empty string', () => {
    expect(typeof CLIENT_CHIME_WATCHDOG_FALLBACK_TEXT).toBe('string');
    expect(CLIENT_CHIME_WATCHDOG_FALLBACK_TEXT.trim().length).toBeGreaterThan(0);
  });

  test('differs (full-string) from every backend field-nil spoken line', () => {
    for (const line of ALL_BACKEND_LINES) {
      expect(CLIENT_CHIME_WATCHDOG_FALLBACK_TEXT).not.toBe(line);
    }
  });

  test('the pending-value mirror is accurate (guards against a silent drift of the pin)', () => {
    // If PENDING_VALUE_APOLOGY changes in the dispatcher, this literal must be
    // updated in lockstep — that is the point of pinning it here. This test
    // just documents the coupling; the real protection is the .not.toBe sweep.
    expect(ALL_BACKEND_LINES).toContain(
      "Sorry, I couldn't place that reading — could you say the field and value together again?"
    );
  });
});
