/**
 * Cluster C1 + B2 friendly-name additions — voice-feedback-cleanup-2026-06-09.
 *
 * Marker 5 ("main earth 16 mil → TTS says only 16") and marker 4 ("when
 * I said tails, the confirmation came back with submain cable size")
 * trace to two missing CONFIRMATION_FRIENDLY_NAMES entries:
 *   - earthing_conductor_csa → "main earth CSA"
 *   - main_switch_conductor_csa → "tails CSA"
 *
 * Without explicit entries the deriveFriendlyName fallback produces
 * "earthing conductor CSA" and "main switch conductor CSA" — the
 * inspector reported these as either inaudible (likely TTS-suppressed
 * upstream because Sonnet judged them too jargon-y) or being heard as
 * "submain cable size" (similar syllable structure). The fix is to
 * pin both entries verbatim so the TTS contract is explicit.
 *
 * This test also forward-guards the CIRCUIT_FIELD_VALUE_ENUMS +
 * BOARD_FIELD_VALUE_ENUMS coverage suggested in the plan: each canonical
 * field key either has an explicit friendly name OR produces a non-empty
 * derived name that doesn't expose snake_case underscores to the model.
 */

import {
  CONFIRMATION_FRIENDLY_NAMES,
  buildConfirmationText,
} from '../extraction/confirmation-text.js';

describe('Cluster C1 — voice-feedback friendly-name additions (2026-06-09)', () => {
  test('earthing_conductor_csa has the explicit "main earth CSA" friendly name', () => {
    expect(CONFIRMATION_FRIENDLY_NAMES.earthing_conductor_csa).toBe('main earth CSA');
  });

  test('main_switch_conductor_csa has the explicit "tails CSA" friendly name (B2 fix)', () => {
    // Marker 4's second complaint: "when I said tails, the confirmation
    // came back with submain cable size". The regex routes tails → this
    // field correctly (TranscriptFieldMatcher.swift:640-643), so the
    // bug is purely the friendly-name layer. Pinning "tails CSA" gives
    // the inspector the inspector-vocabulary form they dictated.
    expect(CONFIRMATION_FRIENDLY_NAMES.main_switch_conductor_csa).toBe('tails CSA');
  });

  test('buildConfirmationText echoes the new earth-CSA friendly name on a supply-side reading', () => {
    // Supply-side reading: circuit=null (or 0), board-level → no prefix.
    const text = buildConfirmationText('earthing_conductor_csa', '16', null);
    expect(text).toBe('main earth CSA 16');
  });

  test('buildConfirmationText echoes "tails CSA" on a supply-side reading', () => {
    const text = buildConfirmationText('main_switch_conductor_csa', '16', null);
    expect(text).toBe('tails CSA 16');
  });

  test('previously-present entries still resolve verbatim (regression lock)', () => {
    // These were verified during /rp round 1 as already present. If a
    // future edit accidentally re-introduces the bug of speaking these
    // via deriveFriendlyName, the C-cluster comes back.
    expect(CONFIRMATION_FRIENDLY_NAMES.client_name).toBe('customer name');
    expect(CONFIRMATION_FRIENDLY_NAMES.client_address).toBe('customer address');
    expect(CONFIRMATION_FRIENDLY_NAMES.spd_bs_en).toBe('main fuse BS EN');
    expect(CONFIRMATION_FRIENDLY_NAMES.spd_rated_current).toBe('main fuse rating');
    expect(CONFIRMATION_FRIENDLY_NAMES.ir_test_voltage_v).toBe('IR test voltage');
    expect(CONFIRMATION_FRIENDLY_NAMES.ir_live_live_mohm).toBe('IR L to L');
    expect(CONFIRMATION_FRIENDLY_NAMES.ir_live_earth_mohm).toBe('IR L to E');
  });

  test('table is Object.freeze\'d — no runtime modification possible', () => {
    // The block comment at the canonical-field-names section warns about
    // this — listing entries OUTSIDE the literal would silently fail
    // under strict ESM. Lock the freeze contract.
    expect(Object.isFrozen(CONFIRMATION_FRIENDLY_NAMES)).toBe(true);
  });
});
