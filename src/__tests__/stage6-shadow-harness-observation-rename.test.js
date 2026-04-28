/**
 * stage6-shadow-harness-observation-rename.test.js
 *
 * Direct unit tests for `renameObservationsForLegacyWire` — the Bug-H rename
 * pass that runs in `runShadowHarness` after `bundleToolCallsIntoResult` and
 * before the wire send. Pre-fix the bundler emitted observations with the
 * canonical Stage 6 shape `{id, code, text, location, circuit,
 * suggested_regulation}`; iOS Build 282's `SonnetObservation` decoder
 * declares `observation_text` REQUIRED and uses wire keys `observation_id /
 * observation_text / item_location / regulation`. The Swift Codable decode
 * of the entire `RollingExtractionResult` threw, dropping readings AND
 * observations on the floor. The rename closes that gap.
 *
 * The same shape is also consumed server-side by `refineObservationsAsync`
 * (sonnet-stream.js:306,323,365,418,785) and `needsRefinement`
 * (observation-code-lookup.js:31,61), both of which read `obs.observation_text`
 * — so renaming once at the bundle boundary fixes the BPG4 refinement path
 * as well as the iOS decode path.
 */

import { renameObservationsForLegacyWire } from '../extraction/stage6-shadow-harness.js';

describe('renameObservationsForLegacyWire', () => {
  test('maps every Stage 6 key to its iOS-canonical wire counterpart', () => {
    const stage6 = [
      {
        id: 'obs-uuid-1',
        code: 'C2',
        text: 'Bonding clamp missing on copper gas pipe at meter',
        location: 'Gas meter cupboard',
        circuit: 4,
        suggested_regulation: 'Reg 411.3.1.2',
      },
    ];

    const renamed = renameObservationsForLegacyWire(stage6);

    expect(renamed).toEqual([
      {
        observation_id: 'obs-uuid-1',
        code: 'C2',
        observation_text: 'Bonding clamp missing on copper gas pipe at meter',
        item_location: 'Gas meter cupboard',
        regulation: 'Reg 411.3.1.2',
        // circuit preserved — refineObservationsAsync uses it; iOS ignores.
        circuit: 4,
      },
    ]);
  });

  test('observation_text is ALWAYS present (empty string fallback) so iOS REQUIRED-key decode does not throw', () => {
    // The iOS Codable contract makes `observation_text` non-optional. If we
    // ever emit a Stage 6 observation without text (model bug, dispatcher
    // edge case), the rename must still produce a string — never undefined,
    // never missing the key — or the whole RollingExtractionResult decode
    // tanks and the user sees zero observations.
    const renamed = renameObservationsForLegacyWire([
      { id: 'x', code: 'C3' /* no text/location/regulation */ },
    ]);
    expect(renamed[0]).toHaveProperty('observation_text', '');
    expect(renamed[0]).toHaveProperty('observation_id', 'x');
    expect(renamed[0]).toHaveProperty('item_location', null);
    expect(renamed[0]).toHaveProperty('regulation', null);
  });

  test('passthrough: already-renamed observations survive idempotently', () => {
    // Defensive — if a future caller (e.g. a re-bundle path) hands an already-
    // renamed object back through, the rename must not blow away the iOS
    // shape. This guards against a regression where someone makes the
    // mapping `observation_id ?? null` lose data when it was already set.
    const ios = [
      {
        observation_id: 'obs-uuid-2',
        code: 'C2',
        observation_text: 'Already-renamed',
        item_location: 'Already-renamed',
        regulation: 'Reg 522',
      },
    ];
    const renamed = renameObservationsForLegacyWire(ios);
    expect(renamed[0]).toMatchObject(ios[0]);
  });

  test('refinement consumers see observation_text after the rename', () => {
    // Pin the contract by mirroring the read sites: `needsRefinement`
    // (observation-code-lookup.js:31) and `refineObservationsAsync`
    // (sonnet-stream.js:306,323) both read `obs.observation_text` directly.
    // Pre-fix they saw `undefined` (Stage 6 emitted `obs.text`), fell back to
    // empty string, and the BPG4 web-search re-coding had nothing to feed on.
    const stage6 = [
      {
        id: 'a',
        code: 'C3',
        text: 'Long enough text to trigger refinement gating logic.',
      },
    ];
    const renamed = renameObservationsForLegacyWire(stage6);
    expect(renamed[0].observation_text).toBe(
      'Long enough text to trigger refinement gating logic.'
    );
  });

  test('non-array / null / undefined input is returned untouched', () => {
    expect(renameObservationsForLegacyWire(null)).toBeNull();
    expect(renameObservationsForLegacyWire(undefined)).toBeUndefined();
    expect(renameObservationsForLegacyWire('not an array')).toBe('not an array');
  });

  test('skips non-object array entries (defensive — pre-fix would crash on null)', () => {
    const renamed = renameObservationsForLegacyWire([
      null,
      { id: 'real', code: 'C2', text: 'real text' },
    ]);
    expect(renamed[0]).toBeNull();
    expect(renamed[1]).toMatchObject({
      observation_id: 'real',
      observation_text: 'real text',
    });
  });
});
