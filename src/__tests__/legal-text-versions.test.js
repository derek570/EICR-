/**
 * Pin the legal-text-versions contract.
 *
 * Three load-bearing properties:
 *   1. CURRENT_VERSIONS is internally coherent — every active version
 *      actually exists in KIND_HISTORY. The most likely editor error
 *      is bumping CURRENT_VERSIONS without adding the new version to
 *      the history map (or vice versa); this catches both.
 *   2. The verbatim wording for any current version matches the
 *      .planning/compliance/ spec docs. If the spec changes without a
 *      version bump, this test forces the editor to either (a) bump,
 *      or (b) consciously update the test to reflect a non-meaning
 *      cosmetic change.
 *   3. getCopy / isCurrentVersion behave correctly for the obvious
 *      success and failure cases.
 *
 * These are spec-pin tests, not behaviour tests, so they're fast and
 * deterministic. No DB, no network.
 */

import { describe, expect, test } from '@jest/globals';
import {
  CURRENT_VERSIONS,
  VALID_KINDS,
  VALID_ATTESTATION_KINDS,
  getCopy,
  isCurrentVersion,
  currentVersionsBundle,
  isCoherent,
} from '../lib/legal-text-versions.js';

describe('legal-text-versions: coherence', () => {
  test('CURRENT_VERSIONS has a history entry for every kind', () => {
    expect(isCoherent()).toBe(true);
  });

  test('VALID_KINDS matches CURRENT_VERSIONS keys', () => {
    expect(VALID_KINDS.sort()).toEqual(Object.keys(CURRENT_VERSIONS).sort());
  });

  test('VALID_ATTESTATION_KINDS is the readings + observations pair', () => {
    expect(VALID_ATTESTATION_KINDS.sort()).toEqual(['observations', 'readings']);
  });
});

describe('legal-text-versions: getCopy', () => {
  test('returns the verbatim wording for a known kind+version', () => {
    const readings = getCopy(
      'cert_attestation_readings',
      CURRENT_VERSIONS.cert_attestation_readings
    );
    expect(readings).not.toBeNull();
    expect(readings.heading).toMatch(/personally reviewed every reading/i);
    expect(readings.body).toMatch(/dictation/i);
    expect(readings.body).toMatch(/responsible/i);
  });

  test('observations body names the C-codes explicitly', () => {
    const observations = getCopy(
      'cert_attestation_observations',
      CURRENT_VERSIONS.cert_attestation_observations
    );
    expect(observations).not.toBeNull();
    expect(observations.body).toMatch(/C1.*C2.*C3.*FI/);
    expect(observations.body).toMatch(/professional judgement/i);
  });

  test('BTA bullets reference the per-PDF attestations', () => {
    const bta = getCopy('beta_tester_agreement', CURRENT_VERSIONS.beta_tester_agreement);
    expect(bta).not.toBeNull();
    expect(bta.bullets.length).toBeGreaterThanOrEqual(6);
    const joinedBullets = bta.bullets.join(' ');
    expect(joinedBullets).toMatch(/two confirmations/i);
  });

  test('returns null for unknown kinds', () => {
    expect(getCopy('not_a_real_kind', '2026-05-12')).toBeNull();
  });

  test('returns null for unknown versions of a known kind', () => {
    expect(getCopy('beta_tester_agreement', '1999-01-01')).toBeNull();
  });
});

describe('legal-text-versions: isCurrentVersion', () => {
  test('accepts the live current version', () => {
    expect(isCurrentVersion('beta_tester_agreement', CURRENT_VERSIONS.beta_tester_agreement)).toBe(
      true
    );
  });

  test('rejects stale-or-fake versions', () => {
    expect(isCurrentVersion('beta_tester_agreement', '2024-01-01')).toBe(false);
    expect(isCurrentVersion('beta_tester_agreement', 'definitely-fake')).toBe(false);
  });

  test('rejects unknown kinds', () => {
    expect(isCurrentVersion('not_a_real_kind', '2026-05-12')).toBe(false);
  });
});

describe('legal-text-versions: currentVersionsBundle', () => {
  test('bundle exposes every kind with copy', () => {
    const bundle = currentVersionsBundle();
    for (const kind of VALID_KINDS) {
      expect(bundle[kind]).toBeDefined();
      expect(bundle[kind].version).toBe(CURRENT_VERSIONS[kind]);
      expect(bundle[kind].copy).not.toBeNull();
    }
  });
});
